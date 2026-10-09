import { UnprocessableEntityException } from '@nestjs/common';
import type { Tx } from '../prisma/prisma.service.js';
import { say } from '../common/say.js';

/**
 * Правила инвентаризации, общие для склада и продаж (ТЗ 5.8).
 *
 * Пока по зоне идёт пересчёт, обычные операции по ней либо запрещены, либо
 * помечаются — режим выбирают при создании листа. Проверка живёт здесь, а не в
 * складском сервисе, потому что товар с полки уводит не только склад: отгрузка
 * по ТТН делает это сама, и вторая копия правила разошлась бы с первой.
 */

/** Открытый лист, накрывающий эту полку. */
type OpenSheet = { number: string; block: boolean };

/**
 * Идёт ли пересчёт по этому месту.
 *
 * Лист без зоны накрывает склад целиком: пересчитывают всё, и полка «не из этой
 * зоны» тут не спасает. Лист с зоной накрывает только свои ячейки — соседняя
 * зона работает как обычно, иначе инвентаризация одной полки останавливала бы
 * весь склад.
 */
async function openSheet(
  tx: Tx,
  companyId: bigint,
  warehouseId: bigint,
  locationId: bigint | null,
): Promise<OpenSheet | null> {
  const rows = await tx.$queryRaw<{ number: string; block_mode: string }[]>`
    SELECT s.number, s.block_mode::text AS block_mode
      FROM inventory_sheet s
     WHERE s.company_id = ${companyId}
       AND s.warehouse_id = ${warehouseId}
       AND s.status IN ('draft', 'counting', 'review')
       AND (
         s.zone_id IS NULL
         OR EXISTS (
           SELECT 1 FROM storage_location l
            WHERE l.id = ${locationId} AND l.zone_id = s.zone_id
         )
       )
     ORDER BY s.id
     LIMIT 1`;
  const row = rows[0];
  return row ? { number: row.number, block: row.block_mode === 'block' } : null;
}

/**
 * Можно ли двигать товар по этой полке прямо сейчас.
 *
 * Возвращает пометку для строки журнала: `true` значит движение прошло рядом с
 * пересчётом. Пометка нужна тому, кто потом разбирает расхождения: посчитанное
 * относится к моменту подсчёта, а это движение случилось рядом с ним — и, может
 * быть, именно оно объясняет недостачу.
 */
export async function guardInventory(
  tx: Tx,
  companyId: bigint,
  warehouseId: bigint,
  locationId: bigint | null,
): Promise<boolean> {
  const sheet = await openSheet(tx, companyId, warehouseId, locationId);
  if (!sheet) return false;
  if (sheet.block) {
    throw new UnprocessableEntityException(say(`Идёт пересчёт по листу ${sheet.number}: операции по этому месту закрыты до его утверждения`, `${sheet.number} varaqi bo‘yicha qayta hisob ketmoqda: bu joy bo‘yicha operatsiyalar tasdiqlanmaguncha yopiq`));
  }
  return true;
}

/**
 * То же для нескольких мест сразу: перемещение трогает две полки, и пересчёт
 * любой из них одинаково важен.
 */
export async function guardInventorySides(
  tx: Tx,
  companyId: bigint,
  sides: { warehouseId: bigint | null; locationId: bigint | null }[],
): Promise<boolean> {
  let marked = false;
  for (const side of sides) {
    if (side.warehouseId === null) continue;
    if (await guardInventory(tx, companyId, side.warehouseId, side.locationId)) marked = true;
  }
  return marked;
}
