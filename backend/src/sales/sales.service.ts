import { Injectable } from '@nestjs/common';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';

export type Period = '7d' | '30d' | '3m';

const PERIOD_DAYS: Record<Period, number> = { '7d': 7, '30d': 30, '3m': 90 };

const MONTHS_RU = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const MONTHS_UZ = ['yan', 'fev', 'mar', 'apr', 'may', 'iyn', 'iyl', 'avg', 'sen', 'okt', 'noy', 'dek'];

const num = (v: unknown) => Number(v ?? 0);
const money = (n: number) => n.toFixed(4);
const tons = (n: number) => n.toFixed(3);
const f1 = (n: number) => n.toFixed(1);

/** То же число, но для готовой фразы: в подписи дробная часть с запятой. */
const d1 = (n: number) => n.toFixed(1).replace('.', ',');

/**
 * Доля в процентах. Нулевая база — доли нет, а не ноль процентов: «0%
 * выбрано» и «лимит не задан» на экране выглядят одинаково, но означают
 * противоположное. Возвращается null, и подпись на фронте не рисуется.
 */
export const share = (part: number, whole: number): string | null =>
  whole === 0 ? null : f1((part / whole) * 100);

export interface LoadingPoint {
  date: string;
  displayDateRu: string;
  displayDateUz: string;
  netTons: string;
  baselineTons: string;
}

/**
 * Шапка страницы продаж.
 *
 * Здесь нет ни «нормы пропускной способности», ни «синхронизации с 1С»: ни
 * того, ни другого в модели данных нет. Опорная линия на графике — среднее за
 * период, и подписана она именно так.
 */
@Injectable()
export class SalesService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(period: Period) {
    const days = PERIOD_DAYS[period];

    return this.prisma.withTenant(async (tx) => {
      // Последовательно, а не Promise.all: запросы идут в одной транзакции,
      // то есть по одному соединению (pg убирает конвейер в 9.0).
      const portfolio = await this.portfolio(tx);
      const fulfillment = await this.fulfillment(tx, days);
      const loading = await this.loading(tx, days);

      return { period, portfolio, fulfillment, loading };
    });
  }

  /**
   * Портфель — то, что уже продано и ещё живёт: отменённые заказы сюда не
   * входят, закрытые входят, потому что деньги по ним могут быть ещё не все.
   */
  private async portfolio(tx: Tx) {
    const rows = await tx.$queryRaw<
      { orders: bigint; total: string; paid: string; overdue: string }[]
    >`
      SELECT count(*)::bigint                            AS orders,
             COALESCE(sum(amount_total), 0)::text        AS total,
             COALESCE(sum(paid_amount), 0)::text         AS paid,
             COALESCE(sum(amount_total - paid_amount)
                      FILTER (WHERE payment_due_date IS NOT NULL
                                AND payment_due_date < current_date
                                AND paid_amount < amount_total), 0)::text AS overdue
        FROM sales_order
       WHERE status <> 'cancelled'
    `;

    const total = num(rows[0].total);
    const paid = num(rows[0].paid);
    const overdue = num(rows[0].overdue);
    const paidPercent = share(paid, total);
    const overduePercent = share(overdue, total);

    return {
      activeOrders: Number(rows[0].orders),
      totalAmount: money(total),
      paidAmount: money(paid),
      paidPercent,
      overdueAmount: money(overdue),
      overduePercent,
      sub1Ru:
        paidPercent === null
          ? 'Портфель пуст — сравнивать не с чем'
          : `Оплачено заказчиками ${d1(num(paidPercent))}% портфеля`,
      sub1Uz:
        paidPercent === null
          ? 'Portfel bo‘sh — taqqoslashga narsa yo‘q'
          : `Xaridorlar portfelning ${d1(num(paidPercent))}% to‘lagan`,
      sub2Ru:
        overduePercent === null
          ? 'Просроченной задолженности нет'
          : `Просрочка ${d1(num(overduePercent))}% портфеля`,
      sub2Uz:
        overduePercent === null
          ? 'Muddati o‘tgan qarz yo‘q'
          : `Muddati o‘tgani portfelning ${d1(num(overduePercent))}%`,
    };
  }

  /** Исполнение поставок за период: сколько заказов доведено до отгрузки. */
  private async fulfillment(tx: Tx, days: number) {
    const rows = await tx.$queryRaw<{ total: bigint; closed: bigint }[]>`
      SELECT count(*)::bigint AS total,
             count(*) FILTER (WHERE status IN ('shipped', 'closed'))::bigint AS closed
        FROM sales_order
       WHERE status <> 'cancelled'
         AND order_date > current_date - ${days}::int
    `;

    const total = Number(rows[0].total);
    const closed = Number(rows[0].closed);
    return { totalOrders: total, closedOrders: closed, closedPercent: share(closed, total) ?? '0.0' };
  }

  /**
   * Суточная погрузка в тоннах. Считается по весу нетто из ТТН: это то, что
   * реально взвесили на выезде, а не то, что записано в строке заказа.
   * Дни без рейсов остаются нулями, иначе выходной склеится с рабочим днём.
   */
  private async loading(tx: Tx, days: number) {
    const rows = await tx.$queryRaw<{ d: Date; net: string }[]>`
      SELECT g.d::date AS d, COALESCE(sum(s.net_weight_t), 0)::text AS net
        FROM generate_series(current_date - ${days - 1}::int, current_date, '1 day') g(d)
        LEFT JOIN shipment s ON s.shipped_at::date = g.d::date
       GROUP BY g.d
       ORDER BY g.d
    `;

    const values = rows.map((r) => num(r.net));
    const average = values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length;

    const series: LoadingPoint[] = rows.map((r) => {
      const d = new Date(r.d);
      return {
        date: d.toISOString().slice(0, 10),
        displayDateRu: `${d.getUTCDate()} ${MONTHS_RU[d.getUTCMonth()]}`,
        displayDateUz: `${d.getUTCDate()} ${MONTHS_UZ[d.getUTCMonth()]}`,
        netTons: tons(num(r.net)),
        baselineTons: tons(average),
      };
    });

    return { unitRu: 'т', unitUz: 't', averagePerDay: tons(average), series };
  }

  /**
   * Покупатели и выбранный лимит задолженности.
   *
   * Это не договоры: договора как сущности в модели данных нет, есть тип
   * документа CONTRACT без единой записи. Показываем то, что есть на самом
   * деле — лимит из карточки покупателя и сколько из него уже выбрано.
   */
  async partners(limit: number) {
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.$queryRaw<
        {
          uid: string;
          name_ru: string;
          name_uz: string;
          inn: string | null;
          debt_limit: string;
          payment_delay_days: number;
          code: string;
          receivable: string;
          active_orders: bigint;
        }[]
      >`
        SELECT p.uid, p.name_ru, p.name_uz, p.inn,
               p.debt_limit::text, p.payment_delay_days,
               c.code,
               COALESCE(sum(o.amount_total - o.paid_amount)
                        FILTER (WHERE o.status NOT IN ('cancelled', 'closed')), 0)::text AS receivable,
               count(o.id) FILTER (WHERE o.status NOT IN ('cancelled', 'closed'))::bigint AS active_orders
          FROM partner p
          JOIN company c ON c.id = p.company_id
          LEFT JOIN sales_order o ON o.partner_id = p.id
         WHERE p.is_client AND p.is_active
         GROUP BY p.id, p.uid, p.name_ru, p.name_uz, p.inn, p.debt_limit, p.payment_delay_days, c.code
         HAVING count(o.id) > 0
         ORDER BY sum(o.amount_total - o.paid_amount) DESC NULLS LAST
         LIMIT ${limit}::int
      `;

      return rows.map((r) => {
        const limitUzs = num(r.debt_limit);
        const receivable = num(r.receivable);
        return {
          uid: r.uid,
          nameRu: r.name_ru,
          nameUz: r.name_uz,
          inn: r.inn,
          enterprise: r.code,
          debtLimit: money(limitUzs),
          receivable: money(receivable),
          // null — лимит не задан, доля не считается. Ноль процентов здесь
          // читался бы как «лимит есть и он свободен», а это другое.
          usedPercent: share(receivable, limitUzs),
          paymentDelayDays: r.payment_delay_days,
          activeOrders: Number(r.active_orders),
        };
      });
    });
  }
}
