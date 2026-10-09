import { UnprocessableEntityException } from '@nestjs/common';
import type { Tx } from '../prisma/prisma.service.js';
import { say } from '../common/say.js';

/**
 * Работа с остатком `stock_balance`.
 *
 * Вынесено из складского сервиса в отдельный файл, потому что склад — не
 * единственный, кто двигает остаток: отгрузка по заказу снимает товар теми же
 * правилами, и вторая копия этих правил разошлась бы с первой на первой же
 * правке. Правило одно: остаток меняется только здесь, в той же транзакции, что
 * и строка журнала `stock_move`.
 *
 * Измерение строки остатка: компания, склад, ячейка, позиция, партия и
 * серийный номер. Номер стоит последним параметром со значением по умолчанию:
 * у количественного учёта его нет, и заставлять каждого вызывающего писать
 * `null` значит ничего не сказать. Сравнение везде `IS NOT DISTINCT FROM`:
 * для Postgres `NULL = NULL` ложно, и обычное равенство молча не нашло бы
 * строку без партии или без номера.
 */

/**
 * Хватает ли товара.
 *
 * База не даст остатку уйти в минус — на `stock_balance` стоит CHECK. Но
 * упасть на нём значит ответить 500 на обычную ошибку человека, поэтому
 * считаем заранее и называем числа: сколько просят и сколько есть.
 */
export async function requireAvailable(
  tx: Tx,
  companyId: bigint,
  warehouseId: bigint,
  locationId: bigint | null,
  itemId: bigint,
  batchId: bigint | null,
  qty: number,
  what?: string,
  serialId: bigint | null = null,
) {
  const rows = await tx.$queryRaw<{ available: string; on_hand: string; reserved: string }[]>`
    SELECT qty_available::text AS available,
           qty_on_hand::text  AS on_hand,
           qty_reserved::text AS reserved
      FROM stock_balance
     WHERE company_id = ${companyId} AND warehouse_id = ${warehouseId}
       AND location_id IS NOT DISTINCT FROM ${locationId} AND item_id = ${itemId}
       AND batch_id IS NOT DISTINCT FROM ${batchId}
       AND serial_id IS NOT DISTINCT FROM ${serialId}
     FOR UPDATE`;
  const available = Number(rows[0]?.available ?? 0);
  if (available < qty) {
    // Про резерв говорим прямо. Списывается доступное, а не то, что лежит:
    // на полностью зарезервированной строке на складе пять тонн, а доступно
    // ноль — и отказ без упоминания резерва читается как поломка.
    const reserved = Number(rows[0]?.reserved ?? 0);
    const onHand = Number(rows[0]?.on_hand ?? 0);
    const why = reserved > 0 ? ` (на складе ${onHand}, из них в резерве ${reserved})` : '';
    // Название позиции нужно там, где строк в документе несколько: в ТТН
    // отказ без него не говорит, какую именно строку править.
    const which = what ? ` по ${what}` : '';
    throw new UnprocessableEntityException(say(`Недостаточно товара${which}: просят ${qty}, доступно ${available}${why}`, `Tovar yetarli emas${which}: so‘ralgani ${qty}, mavjudi ${available}${why}`));
  }
}

/**
 * Сдвиг остатка на дельту.
 *
 * Отдельный SELECT с блокировкой вместо `ON CONFLICT`: в уникальном ключе
 * остатка есть обнуляемые столбцы (партия, ячейка, серийный номер), а
 * Postgres считает NULL различными — `ON CONFLICT` по такому ключу молча
 * заведёт вторую строку вместо обновления первой.
 *
 * `qty_available` не пишем никогда: его считает триггер
 * `stock_balance_available`, и записанное значение он всё равно перебьёт.
 */
export async function shiftBalance(
  tx: Tx,
  companyId: bigint,
  warehouseId: bigint,
  locationId: bigint | null,
  itemId: bigint,
  batchId: bigint | null,
  delta: number,
  unitCost: number | null,
  serialId: bigint | null = null,
) {
  const rows = await tx.$queryRaw<{ id: bigint }[]>`
    SELECT id FROM stock_balance
     WHERE company_id = ${companyId} AND warehouse_id = ${warehouseId}
       AND location_id IS NOT DISTINCT FROM ${locationId} AND item_id = ${itemId}
       AND batch_id IS NOT DISTINCT FROM ${batchId}
       AND serial_id IS NOT DISTINCT FROM ${serialId}
     FOR UPDATE`;

  if (rows[0]) {
    await tx.$executeRaw`
      UPDATE stock_balance
         SET qty_on_hand = qty_on_hand + ${delta}::numeric,
             unit_cost = COALESCE(${unitCost}::numeric, unit_cost),
             updated_at = now()
       WHERE id = ${rows[0].id}`;
    return;
  }

  if (delta < 0) {
    // Сюда попасть можно только мимо requireAvailable — значит в коде ошибка,
    // а не у человека: молча создавать отрицательный остаток нельзя.
    throw new UnprocessableEntityException(say('Списывать нечего: остатка по этой строке нет', 'Chiqim qilishga narsa yo‘q: bu qator bo‘yicha qoldiq yo‘q'));
  }

  await tx.$executeRaw`
    INSERT INTO stock_balance (
      company_id, warehouse_id, location_id, item_id, batch_id, serial_id,
      qty_on_hand, qty_reserved, unit_cost, updated_at
    ) VALUES (
      ${companyId}, ${warehouseId}, ${locationId}, ${itemId}, ${batchId}, ${serialId},
      ${delta}::numeric, 0, ${(unitCost ?? 0).toFixed(4)}::numeric, now()
    )`;
}

/** Себестоимость единицы там, откуда товар уходит. */
export async function sourceUnitCost(
  tx: Tx,
  companyId: bigint,
  warehouseId: bigint,
  locationId: bigint | null,
  itemId: bigint,
  batchId: bigint | null,
  serialId: bigint | null = null,
): Promise<number> {
  const rows = await tx.$queryRaw<{ unit_cost: string }[]>`
    SELECT unit_cost::text FROM stock_balance
     WHERE company_id = ${companyId} AND warehouse_id = ${warehouseId}
       AND location_id IS NOT DISTINCT FROM ${locationId} AND item_id = ${itemId}
       AND batch_id IS NOT DISTINCT FROM ${batchId}
       AND serial_id IS NOT DISTINCT FROM ${serialId}`;
  return Number(rows[0]?.unit_cost ?? 0);
}

/**
 * Ячейка, из которой берём товар, когда ячейку никто не выбирал.
 *
 * Так работают отгрузка по ТТН и выдача в цех: документ говорит про склад и
 * партию, про полку в нём — нет. Берём ту ячейку, где доступного хватает
 * целиком, в порядке кода зоны и ячейки — чтобы два одинаковых документа
 * выбрали одну и ту же полку, а не разные.
 *
 * Разложенную по нескольким ячейкам партию не собираем: одна строка журнала
 * несёт ровно одну ячейку отправления, и «списать из двух полок одной строкой»
 * значит соврать в журнале. Такой случай называем вслух — пусть кладовщик
 * сведёт ячейки перемещением или разобьёт строку документа.
 */
export async function pickSourceLocation(
  tx: Tx,
  companyId: bigint,
  warehouseId: bigint,
  itemId: bigint,
  batchId: bigint | null,
  qty: number,
  what?: string,
  serialId: bigint | null = null,
): Promise<bigint | null> {
  const rows = await tx.$queryRaw<{ location_id: bigint | null; code: string | null; available: string }[]>`
    SELECT b.location_id,
           CASE WHEN l.id IS NULL THEN NULL ELSE z.code || '/' || l.code END AS code,
           b.qty_available::text AS available
      FROM stock_balance b
      LEFT JOIN storage_location l ON l.id = b.location_id
      LEFT JOIN warehouse_zone z   ON z.id = l.zone_id
     WHERE b.company_id = ${companyId} AND b.warehouse_id = ${warehouseId}
       AND b.item_id = ${itemId} AND b.batch_id IS NOT DISTINCT FROM ${batchId}
       AND b.serial_id IS NOT DISTINCT FROM ${serialId} AND b.qty_available > 0
     ORDER BY z.code NULLS FIRST, l.code NULLS FIRST`;

  const enough = rows.find((r) => Number(r.available) >= qty - 1e-9);
  if (enough) return enough.location_id;

  const total = rows.reduce((s, r) => s + Number(r.available), 0);
  if (rows.length > 1 && total >= qty - 1e-9) {
    const spread = rows.map((r) => `${r.code ?? 'без ячейки'} ${r.available}`).join(', ');
    const which = what ? ` по ${what}` : '';
    throw new UnprocessableEntityException(say(`Товар${which} разложен по ячейкам (${spread}): просят ${qty} из одной. ` +
        `Сведите ячейки перемещением или разбейте строку.`, `Tovar${which} yacheykalarga taqsimlangan (${spread}): bittasidan ${qty} so‘ralmoqda. ` + `Yacheykalarni ko‘chirish bilan birlashtiring yoki qatorni bo‘ling.`));
  }

  // Совсем нет остатка — пусть об этом скажет requireAvailable: он назовёт
  // и резерв, и то, что лежит на складе. Двух разных текстов про одну
  // нехватку быть не должно.
  return rows[0]?.location_id ?? null;
}

/**
 * Блокировка на пару «компания + номенклатура».
 *
 * Без неё два одновременных расхода прочитают один и тот же доступный остаток
 * и оба решат, что товара хватает. Парная блокировка принимает только int4,
 * поэтому ключи режем по модулю: совпадение ключей у разных пар всего лишь
 * заставит их подождать друг друга, а переполнение уронило бы весь запрос.
 */
export async function lockItem(tx: Tx, companyId: bigint, itemId: bigint) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock((${companyId} % 2147483647)::int, (${itemId} % 2147483647)::int)`;
}
