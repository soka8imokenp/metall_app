import { Injectable } from '@nestjs/common';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { calcNeed, isNeeded, type NeedState } from './needs.js';

const qty = (v: unknown) => Number(v ?? 0).toFixed(6);

interface LevelRow {
  scope: 'company' | 'warehouse';
  item_id: bigint;
  item_code: string;
  item_name_ru: string;
  item_name_uz: string;
  item_type: string;
  unit_code: string;
  pipe_type: string | null;
  steel_grade: string | null;
  diameter_mm: string | null;
  wall_mm: string | null;
  warehouse_id: bigint | null;
  warehouse_uid: string | null;
  warehouse_code: string | null;
  warehouse_name_ru: string | null;
  warehouse_name_uz: string | null;
  min_qty: string;
  critical_qty: string;
  on_hand: string;
  promised: string;
  planned_out: string;
  stock_warehouses: bigint;
}

/**
 * Потребность в закупке (ТЗ 5.10).
 *
 * Уровень задают на компанию (`item.min_qty`) или на склад
 * (`item_stock_level`) — это перекрытие, а не сумма: заведён складской уровень
 * хотя бы по одному складу, и компанийский по этой позиции в отчёте не
 * участвует. Иначе одна нехватка попадала бы в отчёт дважды, и закупка
 * заказала бы вдвое.
 *
 * **Плановый расход — величина компании.** Производственный заказ не называет
 * склад, с которого материалы выдадут: ни у заказа, ни у строки материалов
 * склада нет. Поэтому план применяется там, где он однозначен: в компанийской
 * строке — всегда, в складской — только когда весь остаток позиции по компании
 * лежит на этом складе, то есть выдать его больше неоткуда. Во всех остальных
 * складских строках план назван отдельным числом (`plannedCompany`) и в расчёт
 * не берётся: разложить его по складам нечем, а разложить «как-нибудь» значит
 * подставить закупке выдуманную цифру.
 */
@Injectable()
export class NeedsService {
  constructor(private readonly prisma: PrismaService) {}

  async purchaseNeeds(params: {
    warehouseUid?: string;
    state?: 'critical' | 'below_min';
    /** Показать и те позиции, где всё в порядке: отчёт целиком, а не тревога. */
    all: boolean;
    limit: number;
  }) {
    return this.prisma.withTenant((tx) => this.report(tx, params));
  }

  /**
   * Счётчики тревоги для сводки склада.
   *
   * Сводка считает их не сама: «ниже критического» на карточке и «критических»
   * во вкладке потребности — одно и то же число, и разойтись они не должны.
   * Разошлись бы обязательно: уровень бывает складским, а доступное — не то же,
   * что наличие.
   */
  async counts(tx: Tx) {
    const { totals } = await this.report(tx, { all: true, limit: 0 });
    return { belowCritical: totals.critical, belowMin: totals.belowMin };
  }

  /**
   * Критические позиции для уведомлений бота — тем же расчётом, что в отчёте
   * закупки. Отдельный запрос завёл бы второе определение нехватки.
   */
  async criticalRows(tx: Tx, limit: number) {
    const { rows, totals } = await this.report(tx, { state: 'critical', all: false, limit });
    return { rows, critical: totals.critical };
  }

  private async report(
    tx: Tx,
    params: {
      warehouseUid?: string;
      state?: 'critical' | 'below_min';
      all?: boolean;
      limit: number;
    },
  ) {
    const rows = await this.levels(tx, params.warehouseUid);

    const mapped = rows.map((r) => {
      const spread = Number(r.stock_warehouses);
      const plannedCompany = Number(r.planned_out);
      // Складская строка берёт план только когда склад у позиции один: тогда
      // цех выберет материалы именно здесь. Позиция, которой на складах нет
      // вовсе (spread = 0), — тот же случай: приход её ждут сюда.
      const plannedApplied = r.scope === 'company' || spread <= 1;
      const numbers = calcNeed(
        { minQty: Number(r.min_qty), criticalQty: Number(r.critical_qty) },
        {
          onHand: Number(r.on_hand),
          promised: Number(r.promised),
          plannedOut: plannedApplied ? plannedCompany : 0,
        },
      );

      return {
        // Своего идентификатора у строки отчёта нет: это срез по позиции и
        // складу. Разрез в ключе обязателен — по одной позиции бывают и
        // складская строка, и компанийская.
        key: `${r.scope}:${r.item_code}:${r.warehouse_code ?? '-'}`,
        scope: r.scope,
        item: {
          code: r.item_code,
          nameRu: r.item_name_ru,
          nameUz: r.item_name_uz,
          itemType: r.item_type,
          unit: r.unit_code,
          pipeType: r.pipe_type,
          steelGrade: r.steel_grade,
          diameterMm: r.diameter_mm ? Number(r.diameter_mm) : null,
          wallThicknessMm: r.wall_mm ? Number(r.wall_mm) : null,
        },
        warehouse: r.warehouse_uid
          ? {
              uid: r.warehouse_uid,
              code: r.warehouse_code!,
              nameRu: r.warehouse_name_ru!,
              nameUz: r.warehouse_name_uz!,
            }
          : null,
        minQty: qty(r.min_qty),
        criticalQty: qty(r.critical_qty),
        onHand: qty(r.on_hand),
        promised: qty(r.promised),
        available: qty(numbers.available),
        /** Плановый расход, вошедший в расчёт этой строки. */
        plannedOut: qty(plannedApplied ? plannedCompany : 0),
        /** Весь плановый расход по позиции в компании — чтобы было видно, что скрыто. */
        plannedCompany: qty(plannedCompany),
        plannedApplied,
        projected: qty(numbers.projected),
        needQty: qty(numbers.needQty),
        state: numbers.state,
        needed: isNeeded(numbers),
      };
    });

    const needed = mapped.filter((r) => r.needed);
    const byState = (s: NeedState) => needed.filter((r) => r.state === s).length;
    // Сумма по отчёту не считается: труба в тоннах, скорлупа в погонных
    // метрах — складывать их нечем. Считаются строки.
    const totals = {
      rows: needed.length,
      critical: byState('critical'),
      belowMin: byState('below_min'),
      /** Строки, где план по компании есть, а разложить его по складам нечем. */
      plannedHidden: needed.filter((r) => !r.plannedApplied && Number(r.plannedCompany) > 0)
        .length,
    };

    const shown = (params.all ? mapped : needed)
      .filter((r) => !params.state || r.state === params.state)
      // Критические сверху, дальше по величине нехватки: закупка читает
      // отчёт сверху вниз и первым должна увидеть то, что уже встало.
      .sort(
        (a, b) =>
          rank(b.state) - rank(a.state) ||
          Number(b.needQty) - Number(a.needQty) ||
          a.item.code.localeCompare(b.item.code),
      );

    return { rows: shown.slice(0, params.limit), total: shown.length, totals };
  }

  /**
   * Уровни с остатком, обещанным и планом — одним запросом на оба разреза.
   *
   * Компанийская половина отбирает позиции, по которым складских уровней нет
   * вовсе: `NOT EXISTS`, а не `LEFT JOIN ... IS NULL` — перекрытие действует по
   * позиции целиком, и позиция с уровнем на одном складе не должна вылезать
   * компанийской строкой из-за второго склада без уровня.
   *
   * Выбранный склад сужает и компанийскую половину — до его компании. Иначе
   * фильтр «склад Сергели» оставлял бы в отчёте компанийские строки завода,
   * к этому складу не относящиеся вовсе. Сузить их до самого склада нечем:
   * компанийская цифра по определению про все склады компании.
   */
  private levels(tx: Tx, warehouseUid?: string) {
    const wh = warehouseUid ?? null;
    return tx.$queryRaw<LevelRow[]>`
      WITH stock_wh AS (
        SELECT item_id, warehouse_id, sum(qty_on_hand) AS on_hand
          FROM stock_balance
         GROUP BY item_id, warehouse_id),
      spread AS (
        SELECT item_id, count(*) FILTER (WHERE on_hand > 0) AS warehouses
          FROM stock_wh GROUP BY item_id),
      res_wh AS (
        SELECT item_id, warehouse_id, sum(qty) AS promised
          FROM stock_reservation
         WHERE status = 'active' AND (expires_at IS NULL OR expires_at > now())
         GROUP BY item_id, warehouse_id),
      planned AS (
        SELECT pm.item_id, sum(GREATEST(pm.qty_planned - pm.qty_issued, 0)) AS planned_out
          FROM production_material pm
          JOIN production_order po ON po.id = pm.production_order_id
         WHERE po.status IN ('planned', 'in_progress', 'paused')
         GROUP BY pm.item_id)

      SELECT 'warehouse'        AS scope,
             i.id               AS item_id,
             i.code             AS item_code,
             i.name_ru          AS item_name_ru,
             i.name_uz          AS item_name_uz,
             i.item_type::text  AS item_type,
             u.code             AS unit_code,
             a.pipe_type, a.steel_grade, a.diameter_mm,
             a.wall_thickness_mm AS wall_mm,
             w.id               AS warehouse_id,
             w.uid              AS warehouse_uid,
             w.code             AS warehouse_code,
             w.name_ru          AS warehouse_name_ru,
             w.name_uz          AS warehouse_name_uz,
             l.min_qty, l.critical_qty,
             coalesce(s.on_hand, 0)   AS on_hand,
             coalesce(r.promised, 0)  AS promised,
             coalesce(p.planned_out, 0) AS planned_out,
             coalesce(sp.warehouses, 0) AS stock_warehouses
        FROM item_stock_level l
        JOIN item i      ON i.id = l.item_id
        JOIN unit u      ON u.id = i.base_unit_id
        JOIN warehouse w ON w.id = l.warehouse_id
        LEFT JOIN item_attribute a ON a.item_id = i.id
        LEFT JOIN stock_wh s  ON s.item_id = l.item_id AND s.warehouse_id = l.warehouse_id
        LEFT JOIN res_wh r    ON r.item_id = l.item_id AND r.warehouse_id = l.warehouse_id
        LEFT JOIN planned p   ON p.item_id = l.item_id
        LEFT JOIN spread sp   ON sp.item_id = l.item_id
       WHERE i.is_active AND i.archived_at IS NULL AND w.is_active
         AND (${wh}::uuid IS NULL OR w.uid = ${wh}::uuid)

      UNION ALL

      SELECT 'company'          AS scope,
             i.id, i.code, i.name_ru, i.name_uz, i.item_type::text, u.code,
             a.pipe_type, a.steel_grade, a.diameter_mm, a.wall_thickness_mm,
             NULL::bigint, NULL::uuid, NULL::text, NULL::text, NULL::text,
             i.min_qty, i.critical_qty,
             coalesce(s.on_hand, 0), coalesce(r.promised, 0),
             coalesce(p.planned_out, 0), coalesce(sp.warehouses, 0)
        FROM item i
        JOIN unit u ON u.id = i.base_unit_id
        LEFT JOIN item_attribute a ON a.item_id = i.id
        LEFT JOIN (SELECT item_id, sum(on_hand) AS on_hand FROM stock_wh GROUP BY item_id) s
               ON s.item_id = i.id
        LEFT JOIN (SELECT item_id, sum(promised) AS promised FROM res_wh GROUP BY item_id) r
               ON r.item_id = i.id
        LEFT JOIN planned p ON p.item_id = i.id
        LEFT JOIN spread sp ON sp.item_id = i.id
       WHERE i.is_active AND i.archived_at IS NULL
         AND (i.min_qty > 0 OR i.critical_qty > 0
              -- Позиция без уровня, которой уже нечем закрыть обещанное и план,
              -- в отчёте нужна не меньше: уровень тут ни при чём, а отгрузка
              -- встанет. Без этого условия она молча не попадала бы в выборку,
              -- и отмечать её как нужную было бы нечему.
              OR coalesce(r.promised, 0) + coalesce(p.planned_out, 0) > coalesce(s.on_hand, 0))
         AND NOT EXISTS (SELECT 1 FROM item_stock_level l WHERE l.item_id = i.id)
         AND (${wh}::uuid IS NULL
              OR i.company_id = (SELECT w2.company_id FROM warehouse w2 WHERE w2.uid = ${wh}::uuid))
    `;
  }
}

const rank = (s: NeedState) => (s === 'critical' ? 2 : s === 'below_min' ? 1 : 0);
