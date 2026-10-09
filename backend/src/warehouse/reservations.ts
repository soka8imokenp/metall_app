import type { Tx } from '../prisma/prisma.service.js';

/**
 * Резерв товара под заказ.
 *
 * Резерв — не движение: товар никуда не поехал, он просто обещан покупателю.
 * Поэтому в `stock_move` его нет и быть не должно, а живёт он строками
 * `stock_reservation`. В остатке от него остаётся `qty_reserved`, и это не
 * второе место хранения правды, а свёртка активных резервов — ровно как сам
 * остаток есть свёртка журнала.
 *
 * Из свёртки следует главное: `qty_reserved` никогда не пишут руками. Любая
 * правка резерва заканчивается пересчётом `applyReservations`, иначе доступное
 * разойдётся с тем, что обещано, и разойдётся молча.
 */

/**
 * Резерв стоит на складе и партии, а остаток разложен по ячейкам. Значит
 * обещанное надо разложить по тем же полкам — с вычитанием, а не копированием:
 * скопировать резерв на каждую строку значит зарезервировать одно и то же
 * несколько раз.
 *
 * Раскладка держится за то, что уже сложилось: сначала каждая полка оставляет
 * свой прежний резерв, и только остаток разливается по свободному месту в
 * порядке кода зоны и ячейки. Это не косметика. Раскладка «с нуля по порядку
 * кодов» перетаскивает обещанное на ту полку, куда только что положили приход, —
 * и отмена этого прихода упирается в «недостаточно товара», хотя на складе
 * свободного вдоволь. Резерв полку не выбирает, и сам по полкам не скачет.
 *
 * Больше, чем лежит на полке, в резерв не уходит: на `stock_balance` стоит
 * CHECK `qty_reserved <= qty_on_hand`. Резерв сверх наличия — законный случай
 * (его разрешает право `sales.order.oversell`), и он остаётся в
 * `stock_reservation` целиком, просто остатку держать его нечем.
 */
export async function applyReservations(
  tx: Tx,
  companyId: bigint,
  itemId: bigint,
  batchId: bigint | null,
  warehouseId: bigint,
): Promise<void> {
  // Срок резерва — не украшение: просроченный резерв держит чужой товар, пока
  // о нём кто-нибудь не вспомнит. Снимаем его здесь, в пересчёте, чтобы
  // «снять по сроку» не требовало отдельного расписания.
  await tx.$executeRaw`
    UPDATE stock_reservation
       SET status = 'released'
     WHERE company_id = ${companyId} AND item_id = ${itemId}
       AND batch_id IS NOT DISTINCT FROM ${batchId}
       AND warehouse_id = ${warehouseId}
       AND status = 'active' AND expires_at IS NOT NULL AND expires_at <= now()`;

  const total = await tx.$queryRaw<{ qty: string }[]>`
    SELECT COALESCE(SUM(qty), 0)::text AS qty
      FROM stock_reservation
     WHERE company_id = ${companyId} AND item_id = ${itemId}
       AND batch_id IS NOT DISTINCT FROM ${batchId}
       AND warehouse_id = ${warehouseId} AND status = 'active'`;

  const rows = await tx.$queryRaw<{ id: bigint; on_hand: string; reserved: string }[]>`
    SELECT sb.id, sb.qty_on_hand::text AS on_hand, sb.qty_reserved::text AS reserved
      FROM stock_balance sb
      LEFT JOIN storage_location l ON l.id = sb.location_id
      LEFT JOIN warehouse_zone z ON z.id = l.zone_id
     WHERE sb.company_id = ${companyId} AND sb.item_id = ${itemId}
       AND sb.batch_id IS NOT DISTINCT FROM ${batchId}
       AND sb.warehouse_id = ${warehouseId} AND sb.serial_id IS NULL
     ORDER BY z.code NULLS FIRST, l.code NULLS FIRST, sb.id
     FOR UPDATE OF sb`;

  const promised = Number(total[0]?.qty ?? 0);
  const give = rows.map((r) => Math.min(Number(r.reserved), Number(r.on_hand)));

  // Обещанного стало меньше — снимаем с последних полок: у первых резерв стоит
  // дольше, и двигать его незачем.
  let over = give.reduce((s, g) => s + g, 0) - promised;
  for (let i = give.length - 1; i >= 0 && over > 1e-9; i--) {
    const off = Math.min(give[i]!, over);
    give[i]! -= off;
    over -= off;
  }

  // Обещанного больше, чем разложено — доливаем в свободное место по порядку.
  let left = promised - give.reduce((s, g) => s + g, 0);
  for (let i = 0; i < rows.length && left > 1e-9; i++) {
    const room = Number(rows[i]!.on_hand) - give[i]!;
    const add = Math.min(room, left);
    if (add <= 0) continue;
    give[i]! += add;
    left -= add;
  }

  for (let i = 0; i < rows.length; i++) {
    if (Math.abs(give[i]! - Number(rows[i]!.reserved)) < 1e-9) continue;
    await tx.$executeRaw`
      UPDATE stock_balance
         SET qty_reserved = ${give[i]!.toFixed(6)}::numeric, updated_at = now()
       WHERE id = ${rows[i]!.id}`;
  }
}

/**
 * Сколько ещё можно пообещать по складу: наличие минус уже обещанное.
 *
 * Считается по складу целиком, а не по полке: резерв не выбирает ячейку, и
 * товар к отгрузке успеют переложить. Партия в ключе есть — резерв на партию
 * ставят осознанно, «любая партия» и «вот эта» дают разное доступное.
 */
export async function reservableQty(
  tx: Tx,
  companyId: bigint,
  itemId: bigint,
  batchId: bigint | null,
  warehouseId: bigint,
): Promise<{ onHand: number; reserved: number; free: number }> {
  const stock = await tx.$queryRaw<{ on_hand: string }[]>`
    SELECT COALESCE(SUM(qty_on_hand), 0)::text AS on_hand
      FROM stock_balance
     WHERE company_id = ${companyId} AND item_id = ${itemId}
       AND batch_id IS NOT DISTINCT FROM ${batchId}
       AND warehouse_id = ${warehouseId} AND serial_id IS NULL`;

  // Обещанное берём из резервов, а не из `qty_reserved`: остаток обрезан
  // наличием, и по нему резерв сверх наличия выглядел бы как его отсутствие.
  const held = await tx.$queryRaw<{ qty: string }[]>`
    SELECT COALESCE(SUM(qty), 0)::text AS qty
      FROM stock_reservation
     WHERE company_id = ${companyId} AND item_id = ${itemId}
       AND batch_id IS NOT DISTINCT FROM ${batchId}
       AND warehouse_id = ${warehouseId} AND status = 'active'
       AND (expires_at IS NULL OR expires_at > now())`;

  const onHand = Number(stock[0]?.on_hand ?? 0);
  const reserved = Number(held[0]?.qty ?? 0);
  return { onHand, reserved, free: onHand - reserved };
}

/**
 * Отгрузили — обещать это количество больше незачем.
 *
 * Резерв под строку заказа уменьшается на отгруженное, и досуха снимается
 * целиком. Без этого после полной отгрузки заказа его резерв продолжал бы
 * держать чужой товар: ТТН уменьшает наличие, а обещанное осталось бы прежним,
 * и доступное на складе просело бы навсегда.
 *
 * Уменьшаем строку, а не пишем вторую: резерв — не журнал, он и есть текущее
 * состояние обещания. История же остаётся строкой со статусом `released`.
 */
export async function consumeReservations(
  tx: Tx,
  companyId: bigint,
  salesOrderLineId: bigint,
  warehouseId: bigint,
  qty: number,
): Promise<void> {
  const rows = await tx.$queryRaw<{ id: bigint; qty: string; item_id: bigint; batch_id: bigint | null }[]>`
    SELECT id, qty::text, item_id, batch_id
      FROM stock_reservation
     WHERE company_id = ${companyId} AND sales_order_line_id = ${salesOrderLineId}
       AND warehouse_id = ${warehouseId} AND status = 'active'
     ORDER BY expires_at NULLS LAST, id
     FOR UPDATE`;

  let left = qty;
  const touched = new Map<string, { itemId: bigint; batchId: bigint | null }>();
  for (const row of rows) {
    if (left <= 0) break;
    touched.set(`${row.item_id}:${row.batch_id}`, { itemId: row.item_id, batchId: row.batch_id });
    const have = Number(row.qty);
    if (have <= left) {
      left -= have;
      await tx.$executeRaw`UPDATE stock_reservation SET status = 'released' WHERE id = ${row.id}`;
    } else {
      await tx.$executeRaw`
        UPDATE stock_reservation SET qty = ${(have - left).toFixed(6)}::numeric WHERE id = ${row.id}`;
      left = 0;
    }
  }

  for (const { itemId, batchId } of touched.values()) {
    await applyReservations(tx, companyId, itemId, batchId, warehouseId);
  }
}
