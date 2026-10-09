import type { Tx } from '../prisma/prisma.service.js';
import { currentContext } from './request-context.js';
import { publishEvent } from '../exchange/events.js';

/**
 * Журнал изменений: кто, когда и что поменял.
 *
 * Таблица `audit_log` заведена с самого начала и закрыта триггером
 * `audit_log_append_only` — строку нельзя ни исправить, ни удалить. До сих пор
 * в неё никто не писал: журнал был, а записей в нём не было.
 *
 * Пишется той же транзакцией, что и само изменение. Отдельной транзакцией
 * журнал расходился бы с данными: упало после правки, но до записи — и в
 * истории клиента пропадает смена ИНН, которую видно в самой карточке.
 *
 * `changes` хранит только то, что действительно изменилось, парой «было —
 * стало». Снимок всей записи занимал бы место и всё равно не отвечал на
 * вопрос, ради которого журнал читают: что именно поменяли.
 */
export type AuditChanges = Record<string, { from: unknown; to: unknown }>;

export async function writeAudit(
  tx: Tx,
  entry: {
    companyId: bigint;
    entityType: string;
    entityId: string;
    action: string;
    changes?: AuditChanges | Record<string, unknown> | null;
    /**
     * Откуда пришло изменение. Обычно не указывается: источник берётся из
     * контекста запроса, и каждой службе о нём знать незачем. Бот заводит
     * контекст с `source: 'bot'`, и его правки ложатся в журнал как Telegram,
     * хотя зовут они тот же код, что экран в браузере.
     */
    source?: 'web' | 'mobile' | 'bot' | 'integration' | 'system';
    /** Кто сделал, если контекста запроса нет: у бота нет сессии человека. */
    userId?: bigint | null;
  },
): Promise<void> {
  const ctx = currentContext();
  await tx.$queryRawUnsafe(
    `INSERT INTO audit_log (company_id, user_id, source, entity_type, entity_id, action,
                            changes, request_id)
     VALUES ($1, $2, $8::"AuditSource", $3, $4, $5, $6::jsonb, $7)`,
    entry.companyId,
    entry.userId ?? ctx?.userId ?? null,
    entry.entityType,
    entry.entityId,
    entry.action,
    entry.changes ? JSON.stringify(entry.changes) : null,
    ctx?.requestId ?? null,
    entry.source ?? ctx?.source ?? 'web',
  );

  /**
   * Та же запись — событие для исходящих вебхуков (ТЗ 12).
   *
   * Здесь, а не вызовами из доменного кода: журнал значимых действий уже стоит
   * во всех нужных местах, и второй список точек публикации разошёлся бы с ним
   * на первой правке. Той же транзакцией — откатилось, значит вебхука не было.
   *
   * Подписок нет — не делается ничего, кроме одного поиска по индексу.
   * Подробности и цена решения — в `exchange/events.ts`.
   */
  await publishEvent(tx, {
    companyId: entry.companyId,
    event: `${entry.entityType}.${entry.action}`,
    payload: {
      entityType: entry.entityType,
      entityId: entry.entityId,
      action: entry.action,
      changes: entry.changes ?? null,
      occurredAt: new Date().toISOString(),
      requestId: ctx?.requestId ?? null,
    },
  });
}

/**
 * Что изменилось между «было» и «стало».
 *
 * Поля, которых в правке нет (`undefined`), не считаются изменёнными: PATCH
 * приходит частичным, и молчание о поле означает «не трогай», а не «очисти».
 * Значения сравниваются строками: из базы число приходит `Decimal`, а из тела
 * запроса — `number`, и без приведения журнал писал бы «100 → 100».
 */
export function diff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): AuditChanges {
  const out: AuditChanges = {};
  for (const [key, to] of Object.entries(after)) {
    if (to === undefined) continue;
    const from = before[key];
    if (norm(from) === norm(to)) continue;
    out[key] = { from: plain(from), to: plain(to) };
  }
  return out;
}

const norm = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const plain = (v: unknown) => (v === undefined ? null : typeof v === 'bigint' ? String(v) : v);
