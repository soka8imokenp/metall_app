import { Injectable } from '@nestjs/common';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { buildCode } from './codes.js';
import { NeedsService } from './needs.service.js';
import { calcNeed } from './needs.js';

export type Period = '7d' | '30d' | '3m';

const PERIOD_DAYS: Record<Period, number> = { '7d': 7, '30d': 30, '3m': 90 };

const qty = (v: unknown) => Number(v ?? 0).toFixed(6);
const money = (v: unknown) => Number(v ?? 0).toFixed(2);

/**
 * Склад читается по партиям, а не по позициям: партия — то, на что выписан
 * сертификат и по чему считается себестоимость. Поэтому строка остатка здесь
 * всегда с номером партии, а «сколько всего по позиции» — производная сумма.
 *
 * Количества по складу не складываются в одну цифру: труба считается в тоннах,
 * скорлупа в погонных метрах. Складывается только стоимость запаса — она в
 * деньгах и физический смысл у неё есть.
 */
@Injectable()
export class WarehouseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly needs: NeedsService,
  ) {}

  async summary(period: Period) {
    const days = PERIOD_DAYS[period];

    return this.prisma.withTenant(async (tx) => {
      // Последовательно, а не Promise.all: одно соединение — один запрос.
      const stock = await this.stockTotals(tx);
      const levels = await this.needs.counts(tx);
      const warehouses = await this.byWarehouse(tx);
      const moves = await this.moveTotals(tx, days);

      return { period, stock, levels, warehouses, moves };
    });
  }

  /** Сколько строк, позиций и партий лежит на складах и на какую сумму. */
  private async stockTotals(tx: Tx) {
    const rows = await tx.$queryRaw<
      { rows: bigint; items: bigint; batches: bigint; warehouses: bigint; value: string }[]
    >`
      SELECT count(*)::bigint                            AS rows,
             count(DISTINCT item_id)::bigint             AS items,
             count(DISTINCT batch_id)::bigint            AS batches,
             count(DISTINCT warehouse_id)::bigint        AS warehouses,
             coalesce(sum(qty_on_hand * unit_cost), 0)   AS value
        FROM stock_balance
       WHERE qty_on_hand > 0
    `;
    const r = rows[0]!;
    return {
      rows: Number(r.rows),
      items: Number(r.items),
      batches: Number(r.batches),
      warehouses: Number(r.warehouses),
      value: money(r.value),
    };
  }

  private async byWarehouse(tx: Tx) {
    const rows = await tx.$queryRaw<
      { uid: string; code: string; name_ru: string; name_uz: string; rows: bigint; value: string }[]
    >`
      SELECT w.uid, w.code, w.name_ru, w.name_uz,
             count(b.id)::bigint                           AS rows,
             coalesce(sum(b.qty_on_hand * b.unit_cost), 0) AS value
        FROM warehouse w
        LEFT JOIN stock_balance b ON b.warehouse_id = w.id AND b.qty_on_hand > 0
       WHERE w.is_active
       GROUP BY w.uid, w.code, w.name_ru, w.name_uz
       ORDER BY value DESC, w.code
    `;
    return rows.map((r) => ({
      uid: r.uid,
      code: r.code,
      nameRu: r.name_ru,
      nameUz: r.name_uz,
      rows: Number(r.rows),
      value: money(r.value),
    }));
  }

  /** Обороты периода по типам операций: сколько движений и на какую сумму. */
  private async moveTotals(tx: Tx, days: number) {
    const rows = await tx.$queryRaw<
      { operation_type: string; moves: bigint; cost: string }[]
    >`
      SELECT operation_type, count(*)::bigint AS moves, coalesce(sum(cost_total), 0) AS cost
        FROM stock_move
       WHERE moved_at >= now() - make_interval(days => ${days}::int)
       GROUP BY operation_type
       ORDER BY moves DESC
    `;
    return rows.map((r) => ({
      operationType: r.operation_type,
      moves: Number(r.moves),
      cost: money(r.cost),
    }));
  }

  /**
   * Строки остатка.
   *
   * Уровень у строки — не всегда тот, что записан в карточке позиции: если по
   * позиции заведены складские уровни (ТЗ 5.10), берётся уровень её склада, а
   * компанийский по такой позиции не действует вовсе. Сравнивается с ним
   * **доступное** — наличие минус активные резервы: обещанный товар лежит на
   * складе, но закрыть им следующую отгрузку нельзя.
   *
   * То же правило считает счётчики сводки и вкладку потребности. Второе
   * правило «ниже критического» на том же экране означало бы две разные цифры
   * в карточке и в отчёте, и человеку пришлось бы гадать, какой верить.
   *
   * `critical` оставляет только строки ниже критического уровня — тот же
   * признак, что подсвечен в строке, а не отдельная выборка: разойдись они,
   * кнопка фильтра показывала бы не то, что красит подсветка.
   */
  async stock(params: {
    warehouseUid?: string;
    search?: string;
    criticalOnly: boolean;
    limit: number;
  }) {
    return this.prisma.withTenant(async (tx) => {
      const search = params.search?.trim() ? `%${params.search.trim()}%` : null;
      const rows = await tx.$queryRaw<
        {
          item_id: bigint;
          location_id: bigint | null;
          batch_id: bigint | null;
          serial_id: bigint | null;
          warehouse_code: string;
          item_code: string;
          item_name_ru: string;
          item_name_uz: string;
          unit_code: string;
          pipe_type: string | null;
          steel_grade: string | null;
          diameter_mm: string | null;
          wall_mm: string | null;
          warehouse_uid: string;
          warehouse_name_ru: string;
          warehouse_name_uz: string;
          location_code: string | null;
          zone_code: string | null;
          batch_uid: string | null;
          batch_number: string | null;
          serial_number: string | null;
          qty_on_hand: string;
          qty_reserved: string;
          qty_available: string;
          unit_cost: string;
          item_on_hand: string;
          critical_qty: string;
          min_qty: string;
          level_scope: 'company' | 'warehouse';
          level_available: string;
        }[]
      >`
        WITH item_total AS (
          SELECT item_id, sum(qty_on_hand) AS on_hand
            FROM stock_balance GROUP BY item_id),
        wh_total AS (
          SELECT item_id, warehouse_id, sum(qty_on_hand) AS on_hand
            FROM stock_balance GROUP BY item_id, warehouse_id),
        -- Обещанное берём из резервов, а не из qty_reserved: остаток обрезан
        -- наличием, и резерв сверх наличия в нём выглядел бы как его отсутствие.
        held AS (
          SELECT item_id, warehouse_id, sum(qty) AS promised
            FROM stock_reservation
           WHERE status = 'active' AND (expires_at IS NULL OR expires_at > now())
           GROUP BY item_id, warehouse_id),
        held_total AS (
          SELECT item_id, sum(promised) AS promised FROM held GROUP BY item_id),
        -- Позиция со складским уровнем хотя бы на одном складе живёт только по
        -- складским уровням: компанийский по ней выключен целиком.
        has_level AS (SELECT DISTINCT item_id FROM item_stock_level)

        SELECT * FROM (
          SELECT b.item_id, b.location_id, b.batch_id, b.serial_id,
                 i.code               AS item_code,
                 i.name_ru            AS item_name_ru,
                 i.name_uz            AS item_name_uz,
                 u.code               AS unit_code,
                 a.pipe_type,
                 a.steel_grade,
                 a.diameter_mm,
                 a.wall_thickness_mm  AS wall_mm,
                 w.uid                AS warehouse_uid,
                 w.code               AS warehouse_code,
                 w.name_ru            AS warehouse_name_ru,
                 w.name_uz            AS warehouse_name_uz,
                 loc.code             AS location_code,
                 z.code               AS zone_code,
                 bt.uid               AS batch_uid,
                 bt.number            AS batch_number,
                 sn.number            AS serial_number,
                 b.qty_on_hand, b.qty_reserved, b.qty_available, b.unit_cost,
                 coalesce(t.on_hand, 0) AS item_on_hand,
                 CASE WHEN hl.item_id IS NULL THEN 'company' ELSE 'warehouse' END AS level_scope,
                 CASE WHEN hl.item_id IS NULL THEN i.critical_qty
                      ELSE coalesce(lv.critical_qty, 0) END AS critical_qty,
                 CASE WHEN hl.item_id IS NULL THEN i.min_qty
                      ELSE coalesce(lv.min_qty, 0) END AS min_qty,
                 CASE WHEN hl.item_id IS NULL
                      THEN coalesce(t.on_hand, 0) - coalesce(ht.promised, 0)
                      ELSE coalesce(wt.on_hand, 0) - coalesce(h.promised, 0)
                 END AS level_available
            FROM stock_balance b
            JOIN item i            ON i.id = b.item_id
            JOIN unit u            ON u.id = i.base_unit_id
            LEFT JOIN item_attribute a ON a.item_id = i.id
            JOIN warehouse w       ON w.id = b.warehouse_id
            LEFT JOIN storage_location loc ON loc.id = b.location_id
            LEFT JOIN warehouse_zone z   ON z.id = loc.zone_id
            LEFT JOIN batch bt     ON bt.id = b.batch_id
            LEFT JOIN serial_number sn ON sn.id = b.serial_id
            LEFT JOIN item_total t ON t.item_id = b.item_id
            LEFT JOIN held_total ht ON ht.item_id = b.item_id
            LEFT JOIN wh_total wt  ON wt.item_id = b.item_id AND wt.warehouse_id = b.warehouse_id
            LEFT JOIN held h       ON h.item_id = b.item_id AND h.warehouse_id = b.warehouse_id
            LEFT JOIN has_level hl ON hl.item_id = b.item_id
            LEFT JOIN item_stock_level lv
                   ON lv.item_id = b.item_id AND lv.warehouse_id = b.warehouse_id
           WHERE b.qty_on_hand > 0
             AND (${params.warehouseUid ?? null}::uuid IS NULL OR w.uid = ${params.warehouseUid ?? null}::uuid)
             AND (${search}::text IS NULL
                  OR i.code ILIKE ${search} OR i.name_ru ILIKE ${search}
                  OR bt.number ILIKE ${search} OR sn.number ILIKE ${search})
        ) r
         WHERE (NOT ${params.criticalOnly}::boolean
                OR (r.critical_qty > 0 AND r.level_available < r.critical_qty))
         ORDER BY r.item_code, r.batch_number NULLS FIRST, r.serial_number NULLS FIRST,
                  r.zone_code NULLS FIRST, r.location_code NULLS FIRST
         LIMIT ${params.limit}::int
      `;

      return {
        rows: rows.map((r) => {
          // Признак «ниже уровня» считает та же функция, что и отчёт
          // потребности: одно правило — один ответ. Плановый расход цеха в
          // подсветку остатка не входит, он про закупку, а не про полку.
          const level = calcNeed(
            { minQty: Number(r.min_qty), criticalQty: Number(r.critical_qty) },
            { onHand: Number(r.level_available), promised: 0, plannedOut: 0 },
          );

          return {
            // Своего идентификатора у строки остатка нет: это срез по складу,
            // ячейке, позиции, партии и серийном номере. Ключ собираем из них
            // же — стабильный и без внутренних id наружу. Ячейка в ключе
            // обязательна: одна партия лежит в двух ячейках, и без неё у React
            // два ряда с одним key. Номер — по той же причине: восемь труб
            // лежат в одной ячейке.
            key: `${r.warehouse_uid}:${r.zone_code ?? '-'}/${r.location_code ?? '-'}:${r.item_code}:${r.batch_number ?? '-'}:${r.serial_number ?? '-'}`,
            // Коды для этикеток (ТЗ 5.9). Считает сервер: идентификаторы строк
            // наружу не ходят, а без них код не собрать. Экрану остаётся
            // отдать выбранные коды обратно в `POST warehouse/labels`.
            labelCodes: {
              item: buildCode('item', r.item_id),
              batch: r.batch_id ? buildCode('batch', r.batch_id) : null,
              serial: r.serial_id ? buildCode('serial', r.serial_id) : null,
              location: r.location_id ? buildCode('location', r.location_id) : null,
            },
            item: {
              code: r.item_code,
              nameRu: r.item_name_ru,
              nameUz: r.item_name_uz,
              unit: r.unit_code,
              pipeType: r.pipe_type,
              steelGrade: r.steel_grade,
              diameterMm: r.diameter_mm ? Number(r.diameter_mm) : null,
              wallThicknessMm: r.wall_mm ? Number(r.wall_mm) : null,
            },
            warehouse: {
              uid: r.warehouse_uid,
              code: r.warehouse_code,
              nameRu: r.warehouse_name_ru,
              nameUz: r.warehouse_name_uz,
            },
            zone: r.zone_code,
            location: r.location_code,
            batch: r.batch_uid ? { uid: r.batch_uid, number: r.batch_number } : null,
            // Штучный учёт: строка остатка заведена на один номер, и без него
            // восемь одинаковых строк по одной штуке не различить.
            serial: r.serial_number,
            qtyOnHand: qty(r.qty_on_hand),
            qtyReserved: qty(r.qty_reserved),
            qtyAvailable: qty(r.qty_available),
            unitCost: money(r.unit_cost),
            // Остаток по позиции целиком — то, что лежит; в строке партии он
            // только показывается.
            itemOnHand: qty(r.item_on_hand),
            /** С чем сравнивали: со складским уровнем или с компанийским. */
            levelScope: r.level_scope,
            /** Доступное в том же разрезе, что и уровень. Бывает отрицательным. */
            levelAvailable: qty(r.level_available),
            criticalQty: qty(r.critical_qty),
            minQty: qty(r.min_qty),
            isBelowCritical: level.state === 'critical',
            isBelowMin: level.state !== 'ok',
          };
        }),
      };
    });
  }
}
