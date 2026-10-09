import type { Tx } from '../prisma/prisma.service.js';

/**
 * Публикация события системы в очередь исходящих вебхуков (ТЗ 12).
 *
 * Событие — это запись журнала действий: `<сущность>.<действие>`, например
 * `sales_order.ship` или `item.create`. Второго списка событий в системе нет
 * сознательно:
 *
 *   - журнал значимых действий (ТЗ 13.3) уже стоит везде, где меняется что-то
 *     важное, и уже отобран по смыслу. Второй список точек публикации разошёлся
 *     бы с ним на первой же правке доменного кода, и объяснять, почему вебхук
 *     про отгрузку не ушёл, а в журнале отгрузка есть, пришлось бы заказчику;
 *   - у каждого действия уже есть название на двух языках (`ACTIONS` в
 *     `admin/journal.service.ts`), и экран подписки ничего не выдумывает;
 *   - доменный код при этом не тронут вовсе — значит и ломать в нём нечего.
 *
 * Запись идёт **той же транзакцией**, что и само изменение, потому что
 * вызывается из `writeAudit`. Транзакция откатилась — вебхука не будет. Это и
 * есть то свойство, ради которого в `02-ARCHITECTURE` §8.1 заведён outbox.
 *
 * Веер по подписчикам делается здесь же: трое подписаны на `item.create` —
 * три строки очереди, у каждой свой URL, свой счёт попыток и своя последняя
 * ошибка. Промежуточной таблицы «событие» нет: она дала бы второй счёт попыток
 * на том же пути, и на вопрос «почему не дошло» стало бы два ответа.
 */

/** Сколько знаков тела храним. Полное тело журнал обменов не выдержит. */
export const BODY_LIMIT = 4000;

export const cut = (text: string): string =>
  text.length <= BODY_LIMIT ? text : `${text.slice(0, BODY_LIMIT)}…[обрезано]`;

export async function publishEvent(
  tx: Tx,
  event: {
    companyId: bigint;
    /** `<сущность>.<действие>` — ровно то, что лежит в журнале действий. */
    event: string;
    payload: Record<string, unknown>;
  },
): Promise<number> {
  /**
   * Подписки спрашиваются на каждую запись журнала, и это сознательная цена.
   *
   * Кеша нет: греть его пришлось бы запросом вне разреза по компании, а
   * `webhook_subscription` закрыт политикой RLS — из транзакции одной компании
   * чужие подписки не видны, и «общий» кеш оказался бы кешем первой компании,
   * которая что-то изменила. Вместо кеша — частичный индекс
   * `webhook_subscription_lookup (company_id, event) WHERE is_active`: это один
   * поиск по индексу на мутацию, на фоне самой мутации его не видно.
   */
  const subs = await tx.$queryRawUnsafe<{ id: bigint; system_id: bigint; url: string }[]>(
    `SELECT w.id, w.system_id, w.url
       FROM webhook_subscription w
       JOIN external_system s ON s.id = w.system_id
      WHERE w.company_id = $1 AND w.event = $2 AND w.is_active AND s.is_active`,
    event.companyId,
    event.event,
  );
  if (subs.length === 0) return 0;

  const body = cut(JSON.stringify({ event: event.event, ...event.payload }));
  for (const sub of subs) {
    await tx.$queryRawUnsafe(
      `INSERT INTO exchange_message
         (company_id, system_id, direction, event, status, url, request_body)
       VALUES ($1, $2, 'out', $3, 'pending', $4, $5)`,
      event.companyId,
      sub.system_id,
      event.event,
      sub.url,
      body,
    );
  }
  return subs.length;
}
