import type { Tx } from '../prisma/prisma.service.js';
import { sourceUnitCost } from './stock.js';

/**
 * Себестоимость расхода (ТЗ 5.7).
 *
 * Метод — настройка компании, а не решение места вызова: склад, отгрузка по
 * ТТН и инвентаризация обязаны считать одинаково, иначе одна и та же тонна
 * уходит со склада по одной цене, а из отчёта по продажам — по другой.
 *
 * **FIFO по партиям.** Цену берём с той строки остатка, откуда товар уходит.
 * Партию выбирает документ, а строка остатка помнит, почём эта партия
 * пришла, — «первым пришёл» здесь обеспечивает партионный учёт, а не порядок
 * перебора: у металлопроката с сертификатами партия названа в документе.
 *
 * **Средневзвешенная.** Цена — среднее по всему, что лежит на этом складе по
 * этой позиции, взвешенное по количеству. Считается на момент расхода и не
 * переписывает остатки: следующий приход изменит среднюю сам собой.
 * Партия в движении остаётся — прослеживаемость от метода оценки не зависит.
 */
export type CostingMethod = 'fifo' | 'weighted_average';

/** Метод компании. Отдельным запросом: за транзакцию он не меняется. */
export async function costingMethod(tx: Tx, companyId: bigint): Promise<CostingMethod> {
  const rows = await tx.$queryRaw<{ m: CostingMethod }[]>`
    SELECT costing_method::text AS m FROM company WHERE id = ${companyId}`;
  return rows[0]?.m ?? 'fifo';
}

/**
 * Цена единицы, по которой товар уходит.
 *
 * Серийный номер обходит метод стороной: у штучной позиции средняя по складу
 * не имеет смысла — уезжает конкретная труба со своей ценой, и усреднять её
 * не с чем.
 */
export async function issueUnitCost(
  tx: Tx,
  companyId: bigint,
  warehouseId: bigint,
  locationId: bigint | null,
  itemId: bigint,
  batchId: bigint | null,
  serialId: bigint | null = null,
): Promise<number> {
  const own = await sourceUnitCost(tx, companyId, warehouseId, locationId, itemId, batchId, serialId);
  if (serialId !== null) return own;

  const method = await costingMethod(tx, companyId);
  if (method === 'fifo') return own;

  const rows = await tx.$queryRaw<{ qty: string; amount: string }[]>`
    SELECT COALESCE(SUM(qty_on_hand), 0)::text AS qty,
           COALESCE(SUM(qty_on_hand * unit_cost), 0)::text AS amount
      FROM stock_balance
     WHERE company_id = ${companyId} AND warehouse_id = ${warehouseId}
       AND item_id = ${itemId} AND serial_id IS NULL AND qty_on_hand > 0`;

  const qty = Number(rows[0]?.qty ?? 0);
  // Склад пуст — усреднять нечего. Это не ошибка: расход упрётся в проверку
  // доступного раньше, а излишек считается по своей цене.
  if (qty <= 0) return own;
  return Number(rows[0].amount) / qty;
}
