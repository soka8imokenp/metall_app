import type { Tx } from '../prisma/prisma.service.js';

/**
 * Откуда берётся цена в заказе (ТЗ 9.2).
 *
 * Порядок один и тот же везде — и в подсказке на экране, и при записи заказа:
 * **индивидуальная цена клиента перекрывает прайс**, прайс берётся по типу цен
 * этого клиента, и только если нет ни того, ни другого, цену называет человек.
 * Два места с разным порядком разошлись бы в первый же день: экран показывал
 * бы одно, сервер записывал другое.
 *
 * Себестоимость здесь — средняя по остатку на складах компании. Это не
 * себестоимость отгрузки (та считается по партиям в момент списания и пишется
 * в строку отгрузки), а ориентир на момент выписки заказа: продавать ли дешевле
 * того, что лежит на складе, решают сейчас, а не после отгрузки.
 */
export type PriceLookup = {
  /** Что система подставит, если менеджер не назвал цену сам. */
  price: number | null;
  source: 'partner' | 'list' | 'none';
  priceTypeCode: string | null;
  priceTypeName: string | null;
  listPrice: number | null;
  partnerPrice: number | null;
  /** Средняя себестоимость остатка. `null` — остатка нет, сравнивать не с чем. */
  cost: number | null;
  belowCostMode: 'block' | 'approve';
};

export async function lookupPrice(
  tx: Tx,
  args: { companyId: bigint; partnerId: bigint; itemId: bigint; onDate: Date },
): Promise<PriceLookup> {
  const { companyId, partnerId, itemId, onDate } = args;

  const company = await tx.$queryRaw<{ mode: string }[]>`
    SELECT below_cost_mode::text AS mode FROM company WHERE id = ${companyId}`;
  const belowCostMode = (company[0]?.mode === 'approve' ? 'approve' : 'block') as
    | 'block'
    | 'approve';

  const partner = await tx.$queryRaw<{ price_type_id: bigint | null }[]>`
    SELECT price_type_id FROM partner WHERE id = ${partnerId}`;

  const typeRows = partner[0]?.price_type_id
    ? await tx.$queryRaw<{ id: bigint; code: string; name: string }[]>`
        SELECT id, code, app_loc(name_ru, name_uz) AS name FROM price_type
         WHERE id = ${partner[0].price_type_id}`
    : await tx.$queryRaw<{ id: bigint; code: string; name: string }[]>`
        SELECT id, code, app_loc(name_ru, name_uz) AS name FROM price_type
         WHERE company_id = ${companyId} ORDER BY id LIMIT 1`;
  const type = typeRows[0] ?? null;

  const listRows = type
    ? await tx.$queryRaw<{ price: unknown }[]>`
        SELECT price FROM price_list
         WHERE company_id = ${companyId} AND item_id = ${itemId} AND price_type_id = ${type.id}
           AND valid_from <= ${onDate} AND (valid_to IS NULL OR valid_to >= ${onDate})
         ORDER BY valid_from DESC LIMIT 1`
    : [];
  const listPrice = listRows[0] ? Number(listRows[0].price) : null;

  const partnerRows = await tx.$queryRaw<{ price: unknown }[]>`
    SELECT price FROM partner_price
     WHERE company_id = ${companyId} AND partner_id = ${partnerId} AND item_id = ${itemId}
       AND valid_from <= ${onDate} AND (valid_to IS NULL OR valid_to >= ${onDate})
     ORDER BY valid_from DESC LIMIT 1`;
  const partnerPrice = partnerRows[0] ? Number(partnerRows[0].price) : null;

  const costRows = await tx.$queryRaw<{ cost: unknown }[]>`
    SELECT CASE WHEN sum(qty_on_hand) > 0
                THEN sum(qty_on_hand * unit_cost) / sum(qty_on_hand)
                ELSE NULL END AS cost
      FROM stock_balance
     WHERE company_id = ${companyId} AND item_id = ${itemId} AND qty_on_hand > 0`;
  const rawCost = costRows[0]?.cost;
  const cost = rawCost === null || rawCost === undefined ? null : Number(rawCost);

  const price = partnerPrice ?? listPrice;
  return {
    price,
    source: partnerPrice !== null ? 'partner' : listPrice !== null ? 'list' : 'none',
    priceTypeCode: type?.code ?? null,
    priceTypeName: type?.name ?? null,
    listPrice,
    partnerPrice,
    cost: cost !== null && Number.isFinite(cost) ? Math.round(cost * 1e4) / 1e4 : null,
    belowCostMode,
  };
}
