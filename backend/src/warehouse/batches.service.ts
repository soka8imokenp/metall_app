import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { buildCode } from './codes.js';
import { say } from '../common/say.js';

const qty = (v: unknown) => Number(v ?? 0).toFixed(6);
const money = (v: unknown) => Number(v ?? 0).toFixed(2);

/**
 * Прослеживаемость партии — ответ на два вопроса разом: откуда этот металл
 * взялся и куда он разошёлся. Оба конца берутся из журнала движений, а не из
 * отдельной таблицы связей: журнал — единственное место, где движение
 * зафиксировано целиком, и расходиться с ним второму источнику нечем.
 */
@Injectable()
export class BatchesService {
  constructor(private readonly prisma: PrismaService) {}

  async trace(uid: string) {
    return this.prisma.withTenant(async (tx) => {
      const head = await this.head(tx, uid);
      const moves = await this.moves(tx, head.id);
      const balances = await this.balances(tx, head.id);
      const upstream = await this.upstream(tx, head);
      const downstream = await this.downstream(tx, head.id);

      const { id, productionOrderId, ...batch } = head;
      return { batch, balances, moves, upstream, downstream };
    });
  }

  private async head(tx: Tx, uid: string) {
    const rows = await tx.$queryRaw<
      {
        id: bigint;
        uid: string;
        number: string;
        produced_at: Date | null;
        received_at: Date;
        unit_cost: string;
        certificate_number: string | null;
        item_code: string;
        item_name: string;
        unit_code: string;
        supplier_name: string | null;
        production_order_id: bigint | null;
        production_order_number: string | null;
      }[]
    >`
      SELECT b.id, b.uid, b.number, b.produced_at, b.received_at, b.unit_cost,
             b.certificate_number,
             i.code AS item_code, app_loc(i.name_ru, i.name_uz) AS item_name, u.code AS unit_code,
             app_loc(p.name_ru, p.name_uz) AS supplier_name,
             b.production_order_id,
             po.number    AS production_order_number
        FROM batch b
        JOIN item i ON i.id = b.item_id
        JOIN unit u ON u.id = i.base_unit_id
        LEFT JOIN partner p           ON p.id = b.supplier_id
        LEFT JOIN production_order po ON po.id = b.production_order_id
       WHERE b.uid = ${uid}::uuid
    `;

    const r = rows[0];
    if (!r) throw new NotFoundException(say('партия не найдена', 'partiya topilmadi'));

    return {
      id: r.id,
      uid: r.uid,
      number: r.number,
      labelCode: buildCode('batch', r.id),
      producedAt: r.produced_at,
      receivedAt: r.received_at,
      unitCost: money(r.unit_cost),
      certificateNumber: r.certificate_number,
      item: { code: r.item_code, name: r.item_name, unit: r.unit_code },
      // Одно из двух и никогда оба: партия либо куплена, либо выпущена цехом.
      supplier: r.supplier_name,
      productionOrderId: r.production_order_id,
      productionOrder: r.production_order_number,
    };
  }

  private async balances(tx: Tx, batchId: bigint) {
    // Строка на ячейку, а не на склад: остаток по ячейкам, и сложить их в одну
    // строку значит спрятать от кладовщика, где партия физически лежит.
    const rows = await tx.$queryRaw<
      {
        warehouse_name: string;
        location: string | null;
        qty_on_hand: string;
        qty_reserved: string;
      }[]
    >`
      SELECT app_loc(w.name_ru, w.name_uz) AS warehouse_name,
             CASE WHEN l.id IS NULL THEN NULL ELSE z.code || '/' || l.code END AS location,
             b.qty_on_hand, b.qty_reserved
        FROM stock_balance b
        JOIN warehouse w ON w.id = b.warehouse_id
        LEFT JOIN storage_location l ON l.id = b.location_id
        LEFT JOIN warehouse_zone z   ON z.id = l.zone_id
       WHERE b.batch_id = ${batchId} AND b.qty_on_hand > 0
       ORDER BY w.code, z.code NULLS FIRST, l.code NULLS FIRST
    `;
    return rows.map((r) => ({
      warehouse: r.warehouse_name,
      location: r.location,
      qtyOnHand: qty(r.qty_on_hand),
      qtyReserved: qty(r.qty_reserved),
    }));
  }

  /**
   * «Откуда это пришло» (ТЗ 5.6).
   *
   * У купленной партии конец один — приход от поставщика. У выпущенной цехом
   * цепочка на шаг длиннее: сначала выпуск, а за ним материалы, которые в этот
   * заказ выдали. Материал показываем партией, а не только позицией: вопрос
   * приёмки звучит «из какого металла сделана вот эта труба», и ответ «из
   * арматуры вообще» на него не отвечает.
   */
  private async upstream(tx: Tx, head: { id: bigint; productionOrderId: bigint | null }) {
    const origin = await tx.$queryRaw<
      {
        uid: string;
        kind: string;
        at: Date;
        qty: string;
        partner: string | null;
        doc_number: string | null;
      }[]
    >`
      SELECT m.uid::text AS uid,
             m.operation_type::text AS kind, m.moved_at AS at, m.qty_base AS qty,
             app_loc(p.name_ru, p.name_uz) AS partner,
             CASE m.source_doc_type
               WHEN 'batch' THEN (SELECT number FROM batch WHERE id = m.source_doc_id)
               WHEN 'production_output' THEN (
                 SELECT po.number FROM production_output o
                   JOIN production_order po ON po.id = o.production_order_id
                  WHERE o.id = m.source_doc_id)
               ELSE NULL
             END AS doc_number
        FROM stock_move m
        LEFT JOIN partner p ON p.id = m.partner_id
       WHERE m.batch_id = ${head.id}
         AND m.operation_type IN ('receipt', 'output')
         AND m.reversal_of_id IS NULL
         -- И сама отмена, и отменённое ею движение: партия столько не приходила.
         AND NOT EXISTS (SELECT 1 FROM stock_move r WHERE r.reversal_of_id = m.id)
       ORDER BY m.moved_at, m.id`;

    const links = origin.map((r) => ({
      uid: r.uid as string | null,
      kind: r.kind,
      at: r.at,
      qty: qty(r.qty),
      partner: r.partner,
      docNumber: r.doc_number,
      item: null as { code: string; name: string } | null,
      batch: null as { uid: string; number: string } | null,
      productionOrder: r.kind === 'output' ? r.doc_number : null,
    }));

    if (head.productionOrderId === null) return links;

    // Материалы того самого заказа, из которого вышла эта партия. Берём журнал,
    // а не план материалов (`production_material.qty_planned`): в цепочке
    // прослеживаемости место только тому, что физически ушло со склада.
    const materials = await tx.$queryRaw<
      {
        uid: string;
        at: Date;
        qty: string;
        item_code: string;
        item_name: string;
        batch_uid: string | null;
        batch_number: string | null;
        order_number: string;
      }[]
    >`
      SELECT m.uid::text AS uid, m.moved_at AS at, m.qty_base AS qty,
             i.code AS item_code, app_loc(i.name_ru, i.name_uz) AS item_name,
             b.uid::text AS batch_uid, b.number AS batch_number,
             po.number AS order_number
        FROM stock_move m
        JOIN production_material pm ON pm.id = m.source_doc_id
        JOIN production_order po    ON po.id = pm.production_order_id
        JOIN item i                 ON i.id = m.item_id
        LEFT JOIN batch b           ON b.id = m.batch_id
       WHERE m.source_doc_type = 'production_material'
         AND m.operation_type = 'issue_to_production'
         AND pm.production_order_id = ${head.productionOrderId}
         AND m.reversal_of_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM stock_move r WHERE r.reversal_of_id = m.id)
       ORDER BY m.moved_at, m.id`;

    for (const r of materials) {
      links.push({
        uid: r.uid as string | null,
        kind: 'material',
        at: r.at,
        qty: qty(r.qty),
        partner: null,
        docNumber: r.order_number,
        item: { code: r.item_code, name: r.item_name },
        batch: r.batch_uid && r.batch_number ? { uid: r.batch_uid, number: r.batch_number } : null,
        productionOrder: r.order_number,
      });
    }

    return links;
  }

  /**
   * «Куда это ушло» (ТЗ 5.6): выдача в цех, что из неё вышло, отгрузка и
   * оплачен ли тот заказ.
   *
   * Оплату спрашиваем у заказа продажи, а не у проводок: заказ и так держит
   * `payment_status` и `paid_amount`, и считать второй раз то же самое значит
   * завести второй ответ на один вопрос.
   */
  private async downstream(tx: Tx, batchId: bigint) {
    const rows = await tx.$queryRaw<
      {
        uid: string;
        kind: string;
        at: Date;
        qty: string;
        partner: string | null;
        doc_number: string | null;
        order_number: string | null;
        payment_status: string | null;
        paid_amount: string | null;
        amount_total: string | null;
        production_order_id: bigint | null;
      }[]
    >`
      SELECT m.uid::text AS uid,
             m.operation_type::text AS kind, m.moved_at AS at, m.qty_base AS qty,
             COALESCE(app_loc(p.name_ru, p.name_uz), app_loc(sp.name_ru, sp.name_uz)) AS partner,
             CASE m.source_doc_type
               WHEN 'shipment' THEN (SELECT number FROM shipment WHERE id = m.source_doc_id)
               WHEN 'production_material' THEN po.number
               WHEN 'inventory_sheet' THEN (
                 SELECT number FROM inventory_sheet WHERE id = m.source_doc_id)
               ELSE NULL
             END AS doc_number,
             so.number AS order_number,
             so.payment_status::text AS payment_status,
             so.paid_amount::text AS paid_amount,
             so.amount_total::text AS amount_total,
             pm.production_order_id
        FROM stock_move m
        LEFT JOIN partner p                ON p.id = m.partner_id
        LEFT JOIN shipment sh              ON sh.id = m.source_doc_id
                                          AND m.source_doc_type = 'shipment'
        LEFT JOIN sales_order so           ON so.id = sh.sales_order_id
        LEFT JOIN partner sp               ON sp.id = so.partner_id
        LEFT JOIN production_material pm   ON pm.id = m.source_doc_id
                                          AND m.source_doc_type = 'production_material'
        LEFT JOIN production_order po      ON po.id = pm.production_order_id
       WHERE m.batch_id = ${batchId}
         AND m.operation_type IN ('issue_to_production', 'shipment', 'write_off')
         AND m.reversal_of_id IS NULL
         -- Отменённое движение — не судьба товара, а исправленная запись.
         AND NOT EXISTS (SELECT 1 FROM stock_move r WHERE r.reversal_of_id = m.id)
       ORDER BY m.moved_at, m.id`;

    const links = rows.map((r) => ({
      uid: r.uid as string | null,
      kind: r.kind,
      at: r.at,
      qty: qty(r.qty),
      partner: r.partner,
      docNumber: r.doc_number,
      productionOrder: r.production_order_id === null ? null : r.doc_number,
      item: null as { code: string; name: string } | null,
      batch: null as { uid: string; number: string } | null,
      salesOrder: r.order_number,
      // Оплата приходит только с отгрузкой: у выдачи в цех покупателя нет.
      payment:
        r.order_number === null
          ? null
          : {
              status: r.payment_status ?? 'unpaid',
              paid: money(r.paid_amount),
              total: money(r.amount_total),
            },
    }));

    // Что цех выпустил из заказов, куда ушёл этот металл. Заказ мог выпустить
    // несколько партий продукции — показываем все, иначе цепочка обрывается
    // ровно там, где начинается ответ на вопрос «в чём этот металл теперь».
    const orderIds = [...new Set(rows.map((r) => r.production_order_id).filter((v) => v !== null))];
    if (orderIds.length > 0) {
      const outputs = await tx.$queryRaw<
        {
          at: Date;
          qty: string;
          item_code: string;
          item_name: string;
          batch_uid: string | null;
          batch_number: string | null;
          order_number: string;
        }[]
      >`
        SELECT o.occurred_at AS at, o.qty,
               i.code AS item_code, app_loc(i.name_ru, i.name_uz) AS item_name,
               b.uid AS batch_uid, b.number AS batch_number,
               po.number AS order_number
          FROM production_output o
          JOIN production_order po ON po.id = o.production_order_id
          JOIN item i              ON i.id = o.item_id
          -- Партию выпуска ищем двумя путями: сама запись выпуска её называет
          -- не всегда, но партия продукции помнит свой заказ. Без запасного
          -- пути цепочка обрывается на «труба вообще», а приёмке нужен номер.
          LEFT JOIN LATERAL (
            SELECT bb.uid::text AS uid, bb.number
              FROM batch bb
             WHERE bb.id = o.batch_id
                OR (o.batch_id IS NULL
                    AND bb.production_order_id = o.production_order_id
                    AND bb.item_id = o.item_id)
             ORDER BY bb.produced_at NULLS LAST, bb.id
             LIMIT 1
          ) b ON TRUE
         WHERE o.production_order_id = ANY(${orderIds})
           AND o.kind = 'good'
         ORDER BY o.occurred_at, o.id`;

      for (const r of outputs) {
        links.push({
          // Выпуск — запись цеха, а не движение склада: своего номера в журнале
          // у него нет.
          uid: null,
          kind: 'output',
          at: r.at,
          qty: qty(r.qty),
          partner: null,
          docNumber: r.order_number,
          productionOrder: r.order_number,
          item: { code: r.item_code, name: r.item_name },
          batch: r.batch_uid && r.batch_number ? { uid: r.batch_uid, number: r.batch_number } : null,
          salesOrder: null,
          payment: null,
        });
      }
    }

    return links;
  }

  /**
   * Подбор номеров для формы (ТЗ 5.6).
   *
   * Расходу нужны те номера, которые сейчас лежат на складе: предлагать
   * отгруженную или списанную трубу значит звать человека на отказ сервера.
   * Поэтому по умолчанию отдаём только лежащее, а склад сужает список до той
   * площадки, с которой человек списывает.
   */
  async serials(params: { itemCode: string; warehouseCode?: string; limit: number }) {
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.$queryRaw<
        {
          id: bigint;
          number: string;
          state: string;
          warehouse_code: string;
          location: string | null;
        }[]
      >`
        SELECT sn.id, sn.number, sn.current_state::text AS state,
               w.code AS warehouse_code,
               CASE WHEN l.id IS NULL THEN NULL ELSE z.code || '/' || l.code END AS location
          FROM stock_balance sb
          JOIN serial_number sn ON sn.id = sb.serial_id
          JOIN item i           ON i.id = sb.item_id
          JOIN warehouse w      ON w.id = sb.warehouse_id
          LEFT JOIN storage_location l ON l.id = sb.location_id
          LEFT JOIN warehouse_zone z   ON z.id = l.zone_id
         WHERE i.code = ${params.itemCode}
           AND sb.qty_on_hand > 0
           AND (${params.warehouseCode ?? null}::text IS NULL
                OR w.code = ${params.warehouseCode ?? null}::text)
         ORDER BY sn.number
         LIMIT ${params.limit}::int`;

      return {
        rows: rows.map((r) => ({
          number: r.number,
          state: r.state,
          warehouseCode: r.warehouse_code,
          location: r.location,
          labelCode: buildCode('serial', r.id),
        })),
      };
    });
  }

  /**
   * Путь серийного номера (ТЗ 5.6).
   *
   * У штучной позиции вопрос звучит не «где партия», а «где вот эта труба»:
   * в каком она состоянии, на какой полке лежит сейчас и что с ней было.
   * Отдельный метод, а не фильтр карточки партии: у серийной позиции партии
   * нет вовсе, и искать её было бы не по чему.
   */
  async serialTrace(number: string) {
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.$queryRaw<
        {
          id: bigint;
          number: string;
          state: string;
          item_code: string;
          item_name: string;
          unit_code: string;
          batch_uid: string | null;
          batch_number: string | null;
        }[]
      >`
        SELECT sn.id, sn.number, sn.current_state::text AS state,
               i.code AS item_code, app_loc(i.name_ru, i.name_uz) AS item_name, u.code AS unit_code,
               b.uid::text AS batch_uid, b.number AS batch_number
          FROM serial_number sn
          JOIN item i ON i.id = sn.item_id
          JOIN unit u ON u.id = i.base_unit_id
          LEFT JOIN batch b ON b.id = sn.batch_id
         WHERE sn.number = ${number}`;

      const head = rows[0];
      if (!head) throw new NotFoundException(say('серийный номер не найден', 'seriya raqami topilmadi'));

      const place = await tx.$queryRaw<
        { warehouse: string; location: string | null; qty: string }[]
      >`
        SELECT app_loc(w.name_ru, w.name_uz) AS warehouse,
               CASE WHEN l.id IS NULL THEN NULL ELSE z.code || '/' || l.code END AS location,
               sb.qty_on_hand::text AS qty
          FROM stock_balance sb
          JOIN warehouse w ON w.id = sb.warehouse_id
          LEFT JOIN storage_location l ON l.id = sb.location_id
          LEFT JOIN warehouse_zone z   ON z.id = l.zone_id
         WHERE sb.serial_id = ${head.id} AND sb.qty_on_hand > 0`;

      return {
        serial: {
          number: head.number,
          state: head.state,
          labelCode: buildCode('serial', head.id),
          item: { code: head.item_code, name: head.item_name, unit: head.unit_code },
          batch:
            head.batch_uid && head.batch_number
              ? { uid: head.batch_uid, number: head.batch_number }
              : null,
        },
        // Строка остатка у номера всегда одна: штука либо лежит, либо её нет.
        place: place[0]
          ? { warehouse: place[0].warehouse, location: place[0].location, qty: qty(place[0].qty) }
          : null,
        moves: await this.moves(tx, null, head.id),
      };
    });
  }

  /**
   * Движения партии по времени. Документ подписан человеческим номером, а не
   * идентификатором: «ТТН-ТД-00042» кладовщик найдёт, `source_doc_id` — нет.
   */
  private async moves(tx: Tx, batchId: bigint | null, serialId: bigint | null = null) {
    const rows = await tx.$queryRaw<
      {
        uid: string;
        moved_at: Date;
        operation_type: string;
        qty_base: string;
        cost_total: string;
        from_warehouse: string | null;
        to_warehouse: string | null;
        partner_name: string | null;
        doc_type: string | null;
        doc_number: string | null;
        reason: string | null;
        reversal_of: string | null;
        reversed: boolean;
      }[]
    >`
      SELECT m.uid, m.moved_at, m.operation_type, m.qty_base, m.cost_total,
             app_loc(wf.name_ru, wf.name_uz) AS from_warehouse,
             app_loc(wt.name_ru, wt.name_uz) AS to_warehouse,
             app_loc(p.name_ru, p.name_uz) AS partner_name,
             m.source_doc_type AS doc_type,
             CASE m.source_doc_type
               WHEN 'shipment'  THEN (SELECT number FROM shipment    WHERE id = m.source_doc_id)
               WHEN 'batch'     THEN (SELECT number FROM batch       WHERE id = m.source_doc_id)
               WHEN 'production_material' THEN (
                 SELECT po.number FROM production_material pm
                   JOIN production_order po ON po.id = pm.production_order_id
                  WHERE pm.id = m.source_doc_id)
               WHEN 'production_output' THEN (
                 SELECT po.number FROM production_output o
                   JOIN production_order po ON po.id = o.production_order_id
                  WHERE o.id = m.source_doc_id)
               ELSE NULL
             END AS doc_number,
             app_loc(sr.name_ru, sr.name_uz) AS reason,
             -- Две пометки для экрана: сторно ли это движение и не отменили ли
             -- его уже. Без них кнопка «Сторно» предлагается там, где сервер
             -- ответит отказом, и человек узнаёт об этом нажатием.
             ro.uid AS reversal_of,
             EXISTS (SELECT 1 FROM stock_move r WHERE r.reversal_of_id = m.id) AS reversed
        FROM stock_move m
        LEFT JOIN stock_move ro  ON ro.id = m.reversal_of_id
        LEFT JOIN warehouse wf   ON wf.id = m.from_warehouse_id
        LEFT JOIN warehouse wt   ON wt.id = m.to_warehouse_id
        LEFT JOIN partner p      ON p.id = m.partner_id
        LEFT JOIN stock_reason sr ON sr.id = m.reason_id
       WHERE (${batchId}::bigint IS NULL OR m.batch_id = ${batchId})
         AND (${serialId}::bigint IS NULL OR m.serial_id = ${serialId})
       ORDER BY m.moved_at, m.id
    `;

    return rows.map((r) => ({
      uid: r.uid,
      movedAt: r.moved_at,
      operationType: r.operation_type,
      qty: qty(r.qty_base),
      cost: money(r.cost_total),
      fromWarehouse: r.from_warehouse,
      toWarehouse: r.to_warehouse,
      partner: r.partner_name,
      docType: r.doc_type,
      docNumber: r.doc_number,
      reason: r.reason,
      reversalOf: r.reversal_of,
      reversed: r.reversed,
    }));
  }
}
