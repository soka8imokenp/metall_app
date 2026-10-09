import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { ACTIONS } from '../admin/journal.service.js';

/**
 * Журнал обменов (ТЗ 12): что, когда, в какую сторону, с каким результатом,
 * сколько попыток и с какой последней ошибкой.
 *
 * Отдельной таблицы под журнал нет — журнал и очередь это одно и то же
 * (`exchange_message`). Разведи их на две, и вторая разойдётся с первой на
 * первом же повторе: в очереди строка уже доставлена, в журнале ещё нет, и
 * разбор «почему не пришла выписка» превращается в сверку двух таблиц.
 *
 * Тела показываются усечёнными, потому что усечены они **при записи**, а не при
 * показе. Полное тело каждого обмена за месяц занимает больше, чем весь учёт, и
 * первым, что перестанет работать, окажется сам журнал.
 */
@Injectable()
export class ExchangeJournalService {
  constructor(private readonly prisma: PrismaService) {}

  async messages(params: {
    systemUid?: string;
    direction?: string;
    status?: string;
    event?: string;
    search?: string;
    limit: number;
    offset: number;
  }) {
    return this.prisma.withTenant(async (tx) => {
      // Разрез по компаниям здесь написан в запросе, а не отдан RLS: у
      // `exchange_message` и `external_system` его нет намеренно — их читают
      // служба и входящий вебхук, у которых компании в контексте не бывает
      // (см. миграцию 20261006190000_exchange_rls_fix). Правило при этом то же
      // самое: та же функция `app.current_company_ids()`, которой пользуется RLS
      // на остальных таблицах.
      const where = `
          WHERE m.company_id = ANY (app.current_company_ids())
            AND ($1::text IS NULL OR s.uid = $1::uuid)
            AND ($2::text IS NULL OR m.direction = $2::text)
            AND ($3::text IS NULL OR m.status = $3::text)
            AND ($4::text IS NULL OR m.event = $4::text)
            AND ($5::text = '' OR m.event ILIKE '%' || $5::text || '%'
                 OR coalesce(m.external_id, '') ILIKE '%' || $5::text || '%'
                 OR coalesce(m.last_error, '') ILIKE '%' || $5::text || '%')`;
      const args = [
        params.systemUid ?? null,
        params.direction ?? null,
        params.status ?? null,
        params.event ?? null,
        params.search?.trim() ?? '',
      ];

      const total = await tx.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM exchange_message m
           JOIN external_system s ON s.id = m.system_id ${where}`,
        ...args,
      );

      const rows = await tx.$queryRawUnsafe<Record<string, any>[]>(
        `SELECT m.uid, m.direction, m.event, m.external_id, m.status, m.attempts,
                m.next_attempt_at, m.last_error, m.url, m.http_status,
                m.request_body, m.response_body, m.created_at, m.processed_at,
                s.uid AS system_uid, s.code AS system_code, s.name AS system_name,
                co.uid AS company_uid, co.code AS company_code
           FROM exchange_message m
           JOIN external_system s ON s.id = m.system_id
           JOIN company co ON co.id = m.company_id
           ${where}
          ORDER BY m.created_at DESC, m.id DESC
          LIMIT $6 OFFSET $7`,
        ...args,
        params.limit,
        params.offset,
      );

      return {
        total: Number(total[0]?.n ?? 0),
        limit: params.limit,
        offset: params.offset,
        rows: rows.map(messageView),
      };
    });
  }

  /** Срезы для фильтров: системы, направления, состояния и встреченные события. */
  async facets() {
    return this.prisma.withTenant(async (tx) => {
      const systems = await tx.$queryRawUnsafe<Record<string, any>[]>(
        `SELECT s.uid, s.code, s.name, count(m.id) AS n
           FROM external_system s
           LEFT JOIN exchange_message m ON m.system_id = s.id
          WHERE s.company_id = ANY (app.current_company_ids())
          GROUP BY s.uid, s.code, s.name ORDER BY s.name`,
      );
      // Счётчики тоже по своим компаниям: иначе в фильтре было бы видно, сколько
      // обменов у соседней компании, — цифра чужая, пусть и без подробностей.
      const statusRows = await tx.$queryRawUnsafe<{ status: string; n: bigint }[]>(
        `SELECT status, count(*) AS n FROM exchange_message
          WHERE company_id = ANY (app.current_company_ids())
          GROUP BY status`,
      );
      const events = await tx.$queryRawUnsafe<{ event: string; n: bigint }[]>(
        `SELECT event, count(*) AS n FROM exchange_message
          WHERE company_id = ANY (app.current_company_ids())
          GROUP BY event ORDER BY n DESC LIMIT 60`,
      );
      return {
        systems: systems.map((s) => ({
          uid: s.uid,
          code: s.code,
          name: s.name,
          count: Number(s.n),
        })),
        // Все четыре состояния всегда, даже с нулём. Иначе фильтр «Не вышло»
        // появлялся бы в интерфейсе только тогда, когда что-то уже не вышло, —
        // то есть именно тогда, когда искать поздно.
        statuses: Object.keys(STATUS).map((value) => ({
          value,
          nameRu: STATUS[value]!.ru,
          nameUz: STATUS[value]!.uz,
          count: Number(statusRows.find((s) => s.status === value)?.n ?? 0),
        })),
        events: events.map((e) => ({ value: e.event, ...eventName(e.event), count: Number(e.n) })),
      };
    });
  }

  /**
   * Каталог событий для подписки: что система действительно умеет сообщать.
   *
   * Берётся из журнала действий, а не из списка в коде. Список в коде
   * разошёлся бы с тем, что происходит на самом деле, и администратор подписался
   * бы на событие, которого не бывает. Здесь он видит только то, что уже
   * случалось хотя бы раз, с числом случаев.
   */
  async events() {
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.$queryRawUnsafe<{ code: string; n: bigint }[]>(
        `SELECT entity_type || '.' || action AS code, count(*) AS n
           FROM audit_log GROUP BY 1 ORDER BY n DESC LIMIT 200`,
      );
      return {
        rows: rows.map((r) => ({ value: r.code, ...eventName(r.code), count: Number(r.n) })),
      };
    });
  }
}

/** Состояние обмена словами: код в журнале человеку ничего не говорит. */
export const STATUS: Record<string, { ru: string; uz: string }> = {
  pending: { ru: 'В очереди', uz: 'Navbatda' },
  done: { ru: 'Доставлено', uz: 'Yetkazildi' },
  failed: { ru: 'Не вышло', uz: 'Chiqmadi' },
  dead: { ru: 'Попытки кончились', uz: 'Urinishlar tugadi' },
};

/** Сущности обмена словами. Тот же список, что в журнале действий на экране. */
export const ENTITIES: Record<string, { ru: string; uz: string }> = {
  user: { ru: 'Учётная запись', uz: 'Hisob' },
  role: { ru: 'Роль', uz: 'Rol' },
  partner: { ru: 'Клиент', uz: 'Mijoz' },
  lead: { ru: 'Обращение', uz: 'Murojaat' },
  deal: { ru: 'Сделка', uz: 'Bitim' },
  item: { ru: 'Номенклатура', uz: 'Nomenklatura' },
  warehouse: { ru: 'Склад', uz: 'Ombor' },
  document: { ru: 'Документ', uz: 'Hujjat' },
  finance_operation: { ru: 'Денежная операция', uz: 'Pul operatsiyasi' },
  sales_order: { ru: 'Заказ', uz: 'Buyurtma' },
  stock_move: { ru: 'Движение склада', uz: 'Ombor harakati' },
  production_order: { ru: 'Заказ производства', uz: 'Ishlab chiqarish buyurtmasi' },
  external_system: { ru: 'Подключение', uz: 'Ulanish' },
  inbound: { ru: 'Входящее сообщение', uz: 'Kiruvchi xabar' },
  import: { ru: 'Загрузка файла', uz: 'Fayl yuklash' },
};

/**
 * Название события из его кода. Код — `<сущность>.<действие>`, и оба куска уже
 * переведены: сущности здесь, действия в журнале действий (`ACTIONS`). Чего в
 * списках нет — показывается кодом как есть, и это видно сразу.
 */
export function eventName(code: string): { nameRu: string; nameUz: string } {
  const dot = code.indexOf('.');
  if (dot < 0) {
    const whole = ENTITIES[code];
    return { nameRu: whole?.ru ?? code, nameUz: whole?.uz ?? code };
  }
  const entity = code.slice(0, dot);
  const action = code.slice(dot + 1);
  const e = ENTITIES[entity];
  const a = ACTIONS[action];
  return {
    nameRu: `${e?.ru ?? entity} — ${a?.ru ?? action}`,
    nameUz: `${e?.uz ?? entity} — ${a?.uz ?? action}`,
  };
}

const messageView = (r: Record<string, any>) => ({
  uid: r.uid,
  direction: r.direction as 'in' | 'out',
  event: r.event,
  ...eventName(r.event),
  externalId: r.external_id,
  status: r.status,
  statusRu: STATUS[r.status]?.ru ?? r.status,
  statusUz: STATUS[r.status]?.uz ?? r.status,
  attempts: Number(r.attempts ?? 0),
  nextAttemptAt: r.next_attempt_at,
  lastError: r.last_error,
  url: r.url,
  httpStatus: r.http_status === null ? null : Number(r.http_status),
  requestBody: r.request_body,
  responseBody: r.response_body,
  createdAt: r.created_at,
  processedAt: r.processed_at,
  system: { uid: r.system_uid, code: r.system_code, name: r.system_name },
  company: { uid: r.company_uid, code: r.company_code },
});
