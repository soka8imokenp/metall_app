import { Injectable } from '@nestjs/common';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { currentContext } from '../common/request-context.js';

const qty = (v: unknown) => Number(v ?? 0).toFixed(6);
const money = (v: unknown) => Number(v ?? 0).toFixed(2);

/** Все девять типов журнала. Фильтр принимает любой, а не только те три, что заводят с экрана. */
export const OPERATION_TYPES = [
  'receipt',
  'transfer',
  'issue_to_production',
  'return_from_production',
  'shipment',
  'return_from_client',
  'write_off',
  'surplus',
  'output',
] as const;

export type OperationTypeName = (typeof OPERATION_TYPES)[number];

/**
 * Рабочая таймзона компаний: обе в Узбекистане, и «с 19 сентября» человек
 * называет по местному календарю. Границы периода считаются от неё явно, а не
 * от таймзоны сессии базы: у дев-базы она UTC, а клиент Prisma подставляет
 * таймзону процесса — с одним и тем же фильтром счёт расходился на 19 движений
 * вечера предыдущего дня.
 */
const TZ = 'Asia/Tashkent';

/** Право, без которого движение этого типа не отменить. Совпадает с `write.service`. */
const REVERSE_PERMISSION: Record<string, string> = {
  receipt: 'warehouse.move',
  transfer: 'warehouse.move',
  write_off: 'warehouse.writeoff',
};

export type MovesQuery = {
  /**
   * Одна строка по её идентификатору.
   *
   * Нужно боту: он открывает движение кнопкой из списка, и отдельного экрана
   * у строки нет. Искать её «в первых пятидесяти» значит потерять ту, которую
   * уже вытеснили новые движения, — а отменяют обычно только что записанное.
   */
  uid?: string;
  warehouseUid?: string;
  operationType?: OperationTypeName;
  itemCode?: string;
  batchNumber?: string;
  partnerUid?: string;
  from?: string;
  to?: string;
  search?: string;
  limit: number;
  offset: number;
};

/**
 * Журнал движений отдельным списком.
 *
 * До этого маршрута движение можно было увидеть только через карточку партии,
 * то есть зная партию заранее. Кладовщику нужно обратное: «что вообще
 * происходило на этом складе за неделю» и «кто списал эту тонну».
 *
 * Фильтры и счётчик считаются одним набором условий (`where`), а не двумя
 * похожими запросами: разъехавшись, они дали бы страницу на 25 строк при
 * счётчике «1 240», и понять, какое из чисел врёт, было бы нечем.
 *
 * `to` включает свой день целиком: человек, выбравший «по 25 сентября», ждёт
 * увидеть и движение, записанное в этот день в 17:40.
 */
@Injectable()
export class MovesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(params: MovesQuery) {
    const ctx = currentContext();
    const search = params.search?.trim() ? `%${params.search.trim()}%` : null;

    return this.prisma.withTenant(async (tx) => {
      const total = await this.count(tx, params, search);
      const rows = await this.rows(tx, params, search);

      return {
        total,
        limit: params.limit,
        offset: params.offset,
        rows: rows.map((r) => {
          const canReverse =
            r.doc_type === null &&
            r.reversal_of === null &&
            !r.reversed &&
            (ctx?.permissions.has(REVERSE_PERMISSION[r.operation_type] ?? 'warehouse.move') ??
              false);

          return {
            uid: r.uid,
            movedAt: r.moved_at,
            operationType: r.operation_type,
            item: {
              code: r.item_code,
              nameRu: r.item_name_ru,
              nameUz: r.item_name_uz,
              unit: r.unit_code,
            },
            batch: r.batch_uid ? { uid: r.batch_uid, number: r.batch_number } : null,
            serial: r.serial_number,
            qty: qty(r.qty_base),
            cost: money(r.cost_total),
            fromWarehouse: r.from_warehouse_uid
              ? {
                  uid: r.from_warehouse_uid,
                  code: r.from_warehouse_code,
                  nameRu: r.from_warehouse_name_ru,
                  nameUz: r.from_warehouse_name_uz,
                }
              : null,
            toWarehouse: r.to_warehouse_uid
              ? {
                  uid: r.to_warehouse_uid,
                  code: r.to_warehouse_code,
                  nameRu: r.to_warehouse_name_ru,
                  nameUz: r.to_warehouse_name_uz,
                }
              : null,
            fromLocation: r.from_location,
            toLocation: r.to_location,
            partner: r.partner_name,
            reason: r.reason_name,
            docType: r.doc_type,
            docNumber: r.doc_number,
            comment: r.comment,
            author: r.author_name,
            reversalOf: r.reversal_of,
            reversed: r.reversed,
            canReverse,
          };
        }),
      };
    });
  }

  private async count(tx: Tx, p: MovesQuery, search: string | null) {
    const rows = await tx.$queryRaw<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n
        FROM stock_move m
        JOIN item i               ON i.id = m.item_id
        LEFT JOIN batch bt        ON bt.id = m.batch_id
        LEFT JOIN serial_number sn ON sn.id = m.serial_id
        LEFT JOIN warehouse wf    ON wf.id = m.from_warehouse_id
        LEFT JOIN warehouse wt    ON wt.id = m.to_warehouse_id
        LEFT JOIN partner p       ON p.id = m.partner_id
       WHERE (${p.uid ?? null}::uuid IS NULL OR m.uid = ${p.uid ?? null}::uuid)
         AND (${p.warehouseUid ?? null}::uuid IS NULL
              OR wf.uid = ${p.warehouseUid ?? null}::uuid
              OR wt.uid = ${p.warehouseUid ?? null}::uuid)
         AND (${p.operationType ?? null}::text IS NULL
              OR m.operation_type::text = ${p.operationType ?? null}::text)
         AND (${p.itemCode ?? null}::text IS NULL OR i.code = ${p.itemCode ?? null}::text)
         AND (${p.batchNumber ?? null}::text IS NULL OR bt.number = ${p.batchNumber ?? null}::text)
         AND (${p.partnerUid ?? null}::uuid IS NULL OR p.uid = ${p.partnerUid ?? null}::uuid)
         AND (${p.from ?? null}::date IS NULL
              OR m.moved_at >= (${p.from ?? null}::date::timestamp AT TIME ZONE ${TZ}))
         AND (${p.to ?? null}::date IS NULL
              OR m.moved_at < ((${p.to ?? null}::date + 1)::timestamp AT TIME ZONE ${TZ}))
         AND (${search}::text IS NULL
              OR i.code ILIKE ${search} OR i.name_ru ILIKE ${search}
              OR bt.number ILIKE ${search} OR sn.number ILIKE ${search}
              OR m.comment ILIKE ${search}
              OR p.name_ru ILIKE ${search})
    `;
    return Number(rows[0]!.n);
  }

  private rows(tx: Tx, p: MovesQuery, search: string | null) {
    return tx.$queryRaw<
      {
        uid: string;
        moved_at: Date;
        operation_type: string;
        item_code: string;
        item_name_ru: string;
        item_name_uz: string;
        unit_code: string;
        batch_uid: string | null;
        batch_number: string | null;
        serial_number: string | null;
        qty_base: string;
        cost_total: string;
        from_warehouse_uid: string | null;
        from_warehouse_code: string | null;
        from_warehouse_name_ru: string | null;
        from_warehouse_name_uz: string | null;
        to_warehouse_uid: string | null;
        to_warehouse_code: string | null;
        to_warehouse_name_ru: string | null;
        to_warehouse_name_uz: string | null;
        from_location: string | null;
        to_location: string | null;
        partner_name: string | null;
        reason_name: string | null;
        doc_type: string | null;
        doc_number: string | null;
        comment: string | null;
        author_name: string | null;
        reversal_of: string | null;
        reversed: boolean;
      }[]
    >`
      SELECT m.uid, m.moved_at, m.operation_type::text AS operation_type,
             i.code AS item_code, i.name_ru AS item_name_ru, i.name_uz AS item_name_uz,
             u.code AS unit_code,
             bt.uid AS batch_uid, bt.number AS batch_number, sn.number AS serial_number,
             m.qty_base, m.cost_total,
             wf.uid AS from_warehouse_uid, wf.code AS from_warehouse_code,
             wf.name_ru AS from_warehouse_name_ru, wf.name_uz AS from_warehouse_name_uz,
             wt.uid AS to_warehouse_uid, wt.code AS to_warehouse_code,
             wt.name_ru AS to_warehouse_name_ru, wt.name_uz AS to_warehouse_name_uz,
             -- Место хранения человек читает как «зона/ячейка», отдельными
             -- полями оно ему ни о чём не говорит.
             CASE WHEN lf.id IS NULL THEN NULL ELSE zf.code || '/' || lf.code END AS from_location,
             CASE WHEN lt.id IS NULL THEN NULL ELSE zt.code || '/' || lt.code END AS to_location,
             app_loc(p.name_ru, p.name_uz) AS partner_name,
             app_loc(sr.name_ru, sr.name_uz) AS reason_name,
             m.source_doc_type AS doc_type,
             CASE m.source_doc_type
               WHEN 'shipment' THEN (SELECT number FROM shipment WHERE id = m.source_doc_id)
               WHEN 'batch'    THEN (SELECT number FROM batch    WHERE id = m.source_doc_id)
               WHEN 'production_material' THEN (
                 SELECT po.number FROM production_material pm
                   JOIN production_order po ON po.id = pm.production_order_id
                  WHERE pm.id = m.source_doc_id)
               WHEN 'production_output' THEN (
                 SELECT po.number FROM production_output o
                   JOIN production_order po ON po.id = o.production_order_id
                  WHERE o.id = m.source_doc_id)
               -- Недостача и излишек по пересчёту причины из справочника не
               -- несут: объяснение - сам лист, и в журнале он виден документом.
               WHEN 'inventory_sheet' THEN (
                 SELECT number FROM inventory_sheet WHERE id = m.source_doc_id)
               ELSE NULL
             END AS doc_number,
             m.comment,
             ua.full_name AS author_name,
             ro.uid AS reversal_of,
             EXISTS (SELECT 1 FROM stock_move r WHERE r.reversal_of_id = m.id) AS reversed
        FROM stock_move m
        JOIN item i                    ON i.id = m.item_id
        JOIN unit u                    ON u.id = m.unit_id
        LEFT JOIN batch bt             ON bt.id = m.batch_id
        LEFT JOIN serial_number sn     ON sn.id = m.serial_id
        LEFT JOIN warehouse wf         ON wf.id = m.from_warehouse_id
        LEFT JOIN warehouse wt         ON wt.id = m.to_warehouse_id
        LEFT JOIN storage_location lf   ON lf.id = m.from_location_id
        LEFT JOIN warehouse_zone zf     ON zf.id = lf.zone_id
        LEFT JOIN storage_location lt   ON lt.id = m.to_location_id
        LEFT JOIN warehouse_zone zt     ON zt.id = lt.zone_id
        LEFT JOIN partner p            ON p.id = m.partner_id
        LEFT JOIN stock_reason sr      ON sr.id = m.reason_id
        LEFT JOIN user_account ua      ON ua.id = m.created_by
        LEFT JOIN stock_move ro        ON ro.id = m.reversal_of_id
       WHERE (${p.uid ?? null}::uuid IS NULL OR m.uid = ${p.uid ?? null}::uuid)
         AND (${p.warehouseUid ?? null}::uuid IS NULL
              OR wf.uid = ${p.warehouseUid ?? null}::uuid
              OR wt.uid = ${p.warehouseUid ?? null}::uuid)
         AND (${p.operationType ?? null}::text IS NULL
              OR m.operation_type::text = ${p.operationType ?? null}::text)
         AND (${p.itemCode ?? null}::text IS NULL OR i.code = ${p.itemCode ?? null}::text)
         AND (${p.batchNumber ?? null}::text IS NULL OR bt.number = ${p.batchNumber ?? null}::text)
         AND (${p.partnerUid ?? null}::uuid IS NULL OR p.uid = ${p.partnerUid ?? null}::uuid)
         AND (${p.from ?? null}::date IS NULL
              OR m.moved_at >= (${p.from ?? null}::date::timestamp AT TIME ZONE ${TZ}))
         AND (${p.to ?? null}::date IS NULL
              OR m.moved_at < ((${p.to ?? null}::date + 1)::timestamp AT TIME ZONE ${TZ}))
         AND (${search}::text IS NULL
              OR i.code ILIKE ${search} OR i.name_ru ILIKE ${search}
              OR bt.number ILIKE ${search} OR sn.number ILIKE ${search}
              OR m.comment ILIKE ${search}
              OR p.name_ru ILIKE ${search})
       ORDER BY m.moved_at DESC, m.id DESC
       LIMIT ${p.limit}::int OFFSET ${p.offset}::int
    `;
  }
}
