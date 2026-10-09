import { Injectable } from '@nestjs/common';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { requireContext } from '../common/request-context.js';

export type Period = '7d' | '30d' | '3m';

const PERIOD_DAYS: Record<Period, number> = { '7d': 7, '30d': 30, '3m': 90 };

/**
 * Все величины уходят строками — как и остальные деньги и количества в
 * контракте. График получает уже свёрнутые за день суммы: гонять 600 заказов
 * на фронт, чтобы он сложил их сам, значит отдать точность округления на
 * усмотрение браузера.
 */
export interface Kpi {
  key: string;
  titleRu: string;
  titleUz: string;
  value: string;
  unit: string;
  /**
   * Прирост к прошлому периоду. `null` — сравнивать не с чем: остаток на складе
   * это срез на сегодня, у него нет «прошлого периода», и рисовать ему стрелку
   * с нулём значит врать про динамику.
   */
  deltaPercent: string | null;
  isPositive: boolean;
  sub1Ru: string;
  sub1Uz: string;
  sub2Ru: string;
  sub2Uz: string;
  targetModule: string;
}

export interface ChartPoint {
  date: string;
  displayDateRu: string;
  displayDateUz: string;
  plantTons: string;
  plantRevenue: string;
  tradeTons: string;
  tradeRevenue: string;
  totalTons: string;
  totalRevenue: string;
  baselineTons: string;
}

const MONTHS_RU = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const MONTHS_UZ = ['yan', 'fev', 'mar', 'apr', 'may', 'iyn', 'iyl', 'avg', 'sen', 'okt', 'noy', 'dek'];

const num = (v: unknown) => Number(v ?? 0);
const f1 = (n: number) => n.toFixed(1);
const f2 = (n: number) => n.toFixed(2);

/**
 * То же число, но для готовой фразы, а не для разбора на фронте.
 * `value` и `deltaPercent` остаются машинными строками с точкой — их парсит
 * фронт. А подписи вроде «закрыто 77,9% заказов» уходят уже текстом, и в
 * русском и в узбекском дробная часть отделяется запятой.
 */
const d1 = (n: number) => n.toFixed(1).replace('.', ',');

/** Прирост к прошлому периоду. Нулевая база — прироста нет, а не бесконечность. */
function delta(now: number, before: number): { deltaPercent: string; isPositive: boolean } {
  if (before === 0) {
    return { deltaPercent: now > 0 ? '100.0' : '0.0', isPositive: now >= 0 };
  }
  const d = ((now - before) / before) * 100;
  return { deltaPercent: d.toFixed(1), isPositive: d >= 0 };
}

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(period: Period) {
    const ctx = requireContext();
    const days = PERIOD_DAYS[period];

    return this.prisma.withTenant(async (tx) => {
      const companies = await tx.company.findMany({
        select: { id: true, code: true, nameRu: true, nameUz: true },
        orderBy: { code: 'asc' },
      });
      const hasTrade = companies.some((c) => c.code === 'trade');
      const hasPlant = companies.some((c) => c.code === 'plant');
      const scope = hasTrade && hasPlant ? 'holding' : hasTrade ? 'trade' : 'plant';

      // Последовательно, а не Promise.all: все четыре запроса идут в одной
      // транзакции, то есть по одному соединению. Параллельный вызов кладёт их
      // в конвейер на общий client — pg объявил это устаревшим и убирает в 9.0.
      const current = await this.window(tx, days, 0);
      const previous = await this.window(tx, days, days);
      const stock = await this.stock(tx);
      const chart = await this.series(tx, days);

      return {
        scope,
        period,
        companies: companies.map((c) => ({ code: c.code, nameRu: c.nameRu, nameUz: c.nameUz })),
        kpis: this.buildKpis(scope, current, previous, stock),
        chart,
        permissions: {
          canViewFinance: ctx.permissions.has('finance.view'),
          canViewProduction: ctx.permissions.has('production.view'),
          canViewWarehouse: ctx.permissions.has('warehouse.view'),
          canViewCrm: ctx.permissions.has('crm.view'),
        },
      };
    });
  }

  /** Сводка за окно длиной days, сдвинутое на offset дней назад. */
  private async window(tx: Tx, days: number, offset: number) {
    const rows = await tx.$queryRaw<
      {
        revenue: string;
        orders: bigint;
        clients: bigint;
        closed: bigint;
      }[]
    >`
      SELECT COALESCE(sum(amount_total), 0)::text AS revenue,
             count(*)::bigint                     AS orders,
             count(DISTINCT partner_id)::bigint   AS clients,
             count(*) FILTER (WHERE status IN ('closed', 'shipped'))::bigint AS closed
        FROM sales_order
       WHERE order_date >  current_date - ${days + offset}::int
         AND order_date <= current_date - ${offset}::int
    `;

    const tons = await tx.$queryRaw<{ shipped: string; produced: string }[]>`
      SELECT
        COALESCE((
          SELECT sum(m.qty_base)
            FROM stock_move m
            JOIN item i ON i.id = m.item_id
            JOIN unit u ON u.id = i.base_unit_id
           WHERE m.operation_type = 'shipment'
             AND u.kind = 'weight'
             AND m.moved_at >  now() - make_interval(days => ${days + offset}::int)
             AND m.moved_at <= now() - make_interval(days => ${offset}::int)
        ), 0)::text AS shipped,
        COALESCE((
          SELECT sum(o.qty_produced)
            FROM production_order o
            JOIN unit u ON u.id = o.unit_id
           WHERE u.kind = 'weight'
             AND o.created_at >  now() - make_interval(days => ${days + offset}::int)
             AND o.created_at <= now() - make_interval(days => ${offset}::int)
        ), 0)::text AS produced
    `;

    return {
      revenue: num(rows[0].revenue),
      orders: Number(rows[0].orders),
      clients: Number(rows[0].clients),
      closed: Number(rows[0].closed),
      shippedTons: num(tons[0].shipped),
      producedTons: num(tons[0].produced),
    };
  }

  private async stock(tx: Tx) {
    const rows = await tx.$queryRaw<{ goods: string; raw: string; value: string }[]>`
      SELECT
        COALESCE(sum(b.qty_on_hand) FILTER (WHERE i.item_type <> 'raw'), 0)::text AS goods,
        COALESCE(sum(b.qty_on_hand) FILTER (WHERE i.item_type =  'raw'), 0)::text AS raw,
        COALESCE(sum(b.qty_on_hand * b.unit_cost), 0)::text                       AS value
        FROM stock_balance b
        JOIN item i ON i.id = b.item_id
        JOIN unit u ON u.id = i.base_unit_id
       WHERE u.kind = 'weight'
    `;
    return {
      goodsTons: num(rows[0].goods),
      rawTons: num(rows[0].raw),
      valueUzs: num(rows[0].value),
    };
  }

  /**
   * Дневной ряд за период. Дни без отгрузок остаются в ряду нулями:
   * иначе на графике выходной склеивается с рабочим днём и линия врёт.
   */
  private async series(tx: Tx, days: number): Promise<ChartPoint[]> {
    const revenue = await tx.$queryRaw<{ d: Date; code: string; amount: string }[]>`
      SELECT g.d::date AS d, c.code, COALESCE(sum(o.amount_total), 0)::text AS amount
        FROM generate_series(current_date - ${days - 1}::int, current_date, '1 day') g(d)
        CROSS JOIN company c
        LEFT JOIN sales_order o ON o.order_date = g.d::date AND o.company_id = c.id
       GROUP BY g.d, c.code
       ORDER BY g.d
    `;

    const tons = await tx.$queryRaw<{ d: Date; code: string; amount: string }[]>`
      SELECT g.d::date AS d, c.code, COALESCE(sum(m.qty_base), 0)::text AS amount
        FROM generate_series(current_date - ${days - 1}::int, current_date, '1 day') g(d)
        CROSS JOIN company c
        LEFT JOIN stock_move m
               ON m.company_id = c.id
              AND m.operation_type = 'shipment'
              AND m.moved_at::date = g.d::date
        LEFT JOIN item i ON i.id = m.item_id
        LEFT JOIN unit u ON u.id = i.base_unit_id AND u.kind = 'weight'
       WHERE m.id IS NULL OR u.id IS NOT NULL
       GROUP BY g.d, c.code
       ORDER BY g.d
    `;

    const byDay = new Map<string, ChartPoint & { __tons: number }>();
    const key = (d: Date) => d.toISOString().slice(0, 10);

    const ensure = (d: Date) => {
      const k = key(d);
      if (!byDay.has(k)) {
        byDay.set(k, {
          date: k,
          displayDateRu: `${d.getUTCDate()} ${MONTHS_RU[d.getUTCMonth()]}`,
          displayDateUz: `${d.getUTCDate()} ${MONTHS_UZ[d.getUTCMonth()]}`,
          plantTons: '0.0',
          plantRevenue: '0.00',
          tradeTons: '0.0',
          tradeRevenue: '0.00',
          totalTons: '0.0',
          totalRevenue: '0.00',
          baselineTons: '0.0',
          __tons: 0,
        });
      }
      return byDay.get(k)!;
    };

    // Выручка на графике — в миллиардах сумов: на оси иначе не читается.
    const MLRD = 1e9;
    for (const r of revenue) {
      const p = ensure(r.d);
      const v = num(r.amount) / MLRD;
      if (r.code === 'plant') p.plantRevenue = f2(v);
      if (r.code === 'trade') p.tradeRevenue = f2(v);
      p.totalRevenue = f2(num(p.totalRevenue) + v);
    }
    for (const r of tons) {
      const p = ensure(r.d);
      const v = num(r.amount);
      if (r.code === 'plant') p.plantTons = f1(v);
      if (r.code === 'trade') p.tradeTons = f1(v);
      p.__tons += v;
      p.totalTons = f1(p.__tons);
    }

    const points = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));

    // Опорная линия — средний дневной факт периода. Плана продаж в модели
    // данных нет, выдумывать цифру плана нельзя: см. 04-API-CONTRACT.md §11.
    const avg = points.reduce((s, p) => s + p.__tons, 0) / (points.length || 1);
    return points.map(({ __tons, ...p }) => ({ ...p, baselineTons: f1(avg) }));
  }

  private buildKpis(
    scope: string,
    now: Awaited<ReturnType<DashboardService['window']>>,
    before: Awaited<ReturnType<DashboardService['window']>>,
    stock: Awaited<ReturnType<DashboardService['stock']>>,
  ): Kpi[] {
    const MLRD = 1e9;
    const fulfilled = now.orders ? (now.closed / now.orders) * 100 : 0;
    const fulfilledBefore = before.orders ? (before.closed / before.orders) * 100 : 0;

    const revenue: Kpi = {
      key: 'revenue',
      // Названия юрлиц со встречи 07.10: опт - «Металл Азия», завод - ТИЗ.
      // «Trade» и «Plant» были внутренними кодами, вылезшими на экран.
      titleRu:
        scope === 'holding'
          ? 'Выручка по обеим компаниям'
          : scope === 'trade'
            ? 'Выручка «Металл Азии»'
            : 'Выручка ТИЗ',
      titleUz:
        scope === 'holding'
          ? 'Ikkala kompaniya tushumi'
          : scope === 'trade'
            ? '«Metall Asia» tushumi'
            : 'TIZ tushumi',
      value: f2(now.revenue / MLRD),
      unit: 'млрд UZS',
      ...delta(now.revenue, before.revenue),
      sub1Ru: `${now.orders} заказов за период`,
      sub1Uz: `Davr uchun ${now.orders} ta buyurtma`,
      sub2Ru: `Закрыто или отгружено ${d1(fulfilled)}% заказов`,
      sub2Uz: `Buyurtmalarning ${d1(fulfilled)}% yopilgan yoki jo‘natilgan`,
      targetModule: 'finance',
    };

    const shipped: Kpi = {
      key: 'shipped_tons',
      titleRu: scope === 'plant' ? 'Отгружено заводом' : 'Объём отгрузок',
      titleUz: scope === 'plant' ? 'Zavod jo‘natmasi' : 'Jo‘natmalar hajmi',
      value: f1(now.shippedTons),
      unit: 'т',
      ...delta(now.shippedTons, before.shippedTons),
      sub1Ru: 'Списано со складов по накладным',
      sub1Uz: 'Yuk xatlari bo‘yicha omborlardan chiqarilgan',
      sub2Ru: `${now.clients} активных заказчиков`,
      sub2Uz: `${now.clients} ta faol xaridor`,
      targetModule: 'sales',
    };

    const stockKpi: Kpi = {
      key: scope === 'plant' ? 'raw_stock' : 'goods_stock',
      titleRu: scope === 'plant' ? 'Сырьё и штрипс в наличии' : 'Складской запас в наличии',
      titleUz: scope === 'plant' ? 'Xomashyo va shtrips zaxirasi' : 'Ombor zaxirasi',
      value: f1(scope === 'plant' ? stock.rawTons : stock.goodsTons),
      unit: 'т',
      deltaPercent: null,
      isPositive: true,
      sub1Ru: `${d1(stock.valueUzs / MLRD)} млрд UZS в наличии`,
      sub1Uz: `${d1(stock.valueUzs / MLRD)} mlrd UZS zaxirada`,
      sub2Ru: 'Весовая номенклатура на всех складах',
      sub2Uz: 'Barcha omborlardagi vaznli nomenklatura',
      targetModule: 'warehouse',
    };

    const fourth: Kpi =
      scope === 'plant'
        ? {
            key: 'produced_tons',
            titleRu: 'Выпуск продукции',
            titleUz: 'Mahsulot ishlab chiqarish',
            value: f1(now.producedTons),
            unit: 'т',
            ...delta(now.producedTons, before.producedTons),
            sub1Ru: 'ТЭСА сварка и ППУ заливка',
            sub1Uz: 'TESA payvandlash va PPU quyish',
            sub2Ru: `Заказов закрыто ${d1(fulfilled)}%`,
            sub2Uz: `Buyurtmalar ${d1(fulfilled)}% yopilgan`,
            targetModule: 'production',
          }
        : {
            key: 'fulfillment',
            titleRu: 'Исполнение заказов',
            titleUz: 'Buyurtmalar ijrosi',
            value: f1(fulfilled),
            unit: '%',
            ...delta(fulfilled, fulfilledBefore),
            sub1Ru: `${now.closed} из ${now.orders} закрыто или отгружено`,
            sub1Uz: `${now.orders} tadan ${now.closed} tasi yopilgan yoki jo‘natilgan`,
            sub2Ru: `${now.clients} активных заказчиков`,
            sub2Uz: `${now.clients} ta faol xaridor`,
            targetModule: 'crm',
          };

    return [revenue, shipped, stockKpi, fourth];
  }
}
