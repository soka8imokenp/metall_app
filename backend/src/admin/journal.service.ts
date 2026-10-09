import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

/** Что показываем словами вместо кода действия. */
export const ACTIONS: Record<string, { ru: string; uz: string }> = {
  create: { ru: 'Заведено', uz: 'Yaratildi' },
  update: { ru: 'Изменено', uz: 'O‘zgartirildi' },
  delete: { ru: 'Удалено', uz: 'O‘chirildi' },
  roles_set: { ru: 'Изменены роли', uz: 'Rollar o‘zgardi' },
  permissions_set: { ru: 'Изменены права', uz: 'Huquqlar o‘zgardi' },
  password_set: { ru: 'Задан пароль', uz: 'Parol berildi' },
  unlock: { ru: 'Снята блокировка', uz: 'Blok olindi' },
  reverse: { ru: 'Отменено сторно', uz: 'Storno qilindi' },
  release: { ru: 'Снято', uz: 'Olib tashlandi' },
  count: { ru: 'Пересчитано', uz: 'Qayta hisoblandi' },
  finish: { ru: 'Подсчёт закончен', uz: 'Hisob tugadi' },
  approve: { ru: 'Утверждено', uz: 'Tasdiqlandi' },
  cancel: { ru: 'Отменено', uz: 'Bekor qilindi' },
  submit: { ru: 'На согласование', uz: 'Tasdiqlashga' },
  reject: { ru: 'Отклонено', uz: 'Rad etildi' },
  post: { ru: 'Проведено', uz: 'O‘tkazildi' },
  set: { ru: 'Задано', uz: 'Belgilandi' },
  // Обмен с внешними системами (ТЗ 12).
  import: { ru: 'Загружено из файла', uz: 'Fayldan yuklandi' },
  key_issued: { ru: 'Выдан ключ доступа', uz: 'Kirish kaliti berildi' },
  price_override: { ru: 'Цена поставлена руками', uz: 'Narx qo‘lda qo‘yildi' },
  // Продажи: переход заказа по статусам и сама отгрузка. Без этих двух строк
  // журнал не отвечал, кто подтвердил обещание клиенту и кто отгрузил товар.
  status: { ru: 'Статус изменён', uz: 'Holat o‘zgardi' },
  ship: { ru: 'Отгружено', uz: 'Jo‘natildi' },
  code_issued: { ru: 'Выдан код Telegram', uz: 'Telegram kodi berildi' },
  link: { ru: 'Telegram подключён', uz: 'Telegram ulandi' },
  unlink: { ru: 'Telegram отключён', uz: 'Telegram uzildi' },
  // Документы: правка утверждённого уходит новой редакцией, и в журнале это
  // разные действия — иначе «изменено» не отвечает, пропала ли прежняя версия.
  edit: { ru: 'Правка', uz: 'Tahrir' },
  edit_new_version: { ru: 'Правка новой редакцией', uz: 'Yangi tahrir bilan' },
  return: { ru: 'Возвращено на доработку', uz: 'Qaytarildi' },
  sign: { ru: 'Подписано', uz: 'Imzolandi' },
  // CRM: выключение клиента и возврат его в работу.
  archive: { ru: 'Убрано из работы', uz: 'Ishdan olindi' },
  restore: { ru: 'Возвращено в работу', uz: 'Ishga qaytarildi' },
  'contact.add': { ru: 'Добавлен контакт', uz: 'Kontakt qo‘shildi' },
  'contact.update': { ru: 'Изменён контакт', uz: 'Kontakt o‘zgardi' },
  'contact.remove': { ru: 'Удалён контакт', uz: 'Kontakt o‘chirildi' },
  'lead.link': { ru: 'Привязано обращение', uz: 'Murojaat bog‘landi' },
  price: { ru: 'Цена задана', uz: 'Narx belgilandi' },
  // Техкарты производства: норма живёт версиями, и в журнале видно, кто поднял
  // версию и кто ввёл её в работу — цифры заказа считаются по ней.
  version: { ru: 'Новая версия', uz: 'Yangi versiya' },
  activate: { ru: 'Введена в работу', uz: 'Ishga kiritildi' },
  // Этапы заказа: план работ и отметки цеха. Отдельными действиями, а не одним
  // «изменено»: по журналу читают, кто и когда стоял у станка.
  'stage.plan': { ru: 'Этапы заданы', uz: 'Bosqichlar belgilandi' },
  'stage.start': { ru: 'Этап начат', uz: 'Bosqich boshlandi' },
  'stage.pause': { ru: 'Этап остановлен', uz: 'Bosqich to‘xtatildi' },
  'stage.resume': { ru: 'Этап продолжен', uz: 'Bosqich davom etdi' },
  'stage.finish': { ru: 'Этап закончен', uz: 'Bosqich tugadi' },
  // Материалы заказа: план расхода, выдача в цех, возврат и факт.
  'material.plan': { ru: 'План расхода задан', uz: 'Sarf rejasi belgilandi' },
  'material.issue': { ru: 'Материал выдан в цех', uz: 'Material sexga berildi' },
  'material.return': { ru: 'Материал возвращён на склад', uz: 'Material omborga qaytdi' },
  'material.use': { ru: 'Расход отмечен', uz: 'Sarf belgilandi' },
  // Выпуск заказа: что цех сдал и что из этого не получилось.
  'output.good': { ru: 'Годное принято', uz: 'Yaroqli mahsulot qabul qilindi' },
  'output.defect': { ru: 'Брак записан', uz: 'Brak qayd etildi' },
  'output.waste': { ru: 'Отход записан', uz: 'Chiqindi qayd etildi' },
  'output.semi': { ru: 'Полуфабрикат принят', uz: 'Yarim tayyor mahsulot qabul qilindi' },
  'order.rework': { ru: 'Заведена переделка', uz: 'Qayta ishlash buyurtmasi ochildi' },
  'cost.calculate': { ru: 'Себестоимость рассчитана', uz: 'Tannarx hisoblandi' },
  // Производственный календарь и контроль (Э7): по этим строкам видно, кто
  // сдвинул рабочую неделю и кто записал простой участка.
  'calendar.week': { ru: 'Рабочая неделя задана', uz: 'Ish haftasi belgilandi' },
  'calendar.day': { ru: 'День календаря задан', uz: 'Kalendar kuni belgilandi' },
  'calendar.day.clear': { ru: 'День календаря возвращён к неделе', uz: 'Kalendar kuni haftaga qaytarildi' },
  'shift.create': { ru: 'Смена заведена', uz: 'Smena kiritildi' },
  'shift.update': { ru: 'Смена изменена', uz: 'Smena o‘zgartirildi' },
  'stages.schedule': { ru: 'Этапы разложены по сменам', uz: 'Bosqichlar smenalarga taqsimlandi' },
  'downtime.register': { ru: 'Простой записан', uz: 'To‘xtab turish qayd etildi' },
  'work_center.create': { ru: 'Участок заведён', uz: 'Uchastka kiritildi' },
  'work_center.update': { ru: 'Участок изменён', uz: 'Uchastka o‘zgartirildi' },
  // Валюты и курсы (ТЗ 6.2): курс задаёт суммы в учётной валюте, и кто его
  // поставил — вопрос к журналу, а не к памяти.
  rate: { ru: 'Курс задан', uz: 'Kurs belgilandi' },
};

/**
 * Чем назвать предмет действия вместо его идентификатора.
 *
 * В журнале лежит `uid` — строка, которую человек не читает: «Клиент
 * 01a0fbb1-358c-7263…» не отвечает на вопрос, какой клиент. Поэтому на каждую
 * сущность берём то, чем её зовут в работе: номер документа, код номенклатуры,
 * имя клиента. Запрос один на тип сущности и только по показанной странице.
 *
 * Чего тут нет намеренно: записи об удалённом предмете названия не получат —
 * строка останется с идентификатором. Выдумывать название удалённому нельзя,
 * а прятать запись нельзя тем более.
 */
const TITLE_SQL: Record<string, string> = {
  user: `SELECT uid::text AS key, coalesce(full_name, login) AS title FROM user_account WHERE uid::text = ANY($1)`,
  user_telegram: `SELECT uid::text AS key, coalesce(full_name, login) AS title FROM user_account WHERE uid::text = ANY($1)`,
  // У роли идентификатора нет: в журнале стоит её код.
  role: `SELECT code AS key, app_loc(name_ru, name_uz) AS title FROM role WHERE code = ANY($1)`,
  partner: `SELECT uid::text AS key, app_loc(name_ru, name_uz) AS title FROM partner WHERE uid::text = ANY($1)`,
  lead: `SELECT uid::text AS key, name AS title FROM lead WHERE uid::text = ANY($1)`,
  deal: `SELECT uid::text AS key, number || ' · ' || title AS title FROM deal WHERE uid::text = ANY($1)`,
  item: `SELECT uid::text AS key, code || ' · ' || app_loc(name_ru, name_uz) AS title FROM item WHERE uid::text = ANY($1)`,
  warehouse: `SELECT uid::text AS key, app_loc(name_ru, name_uz) AS title FROM warehouse WHERE uid::text = ANY($1)`,
  warehouse_zone: `SELECT uid::text AS key, app_loc(name_ru, name_uz) AS title FROM warehouse_zone WHERE uid::text = ANY($1)`,
  storage_location: `SELECT uid::text AS key, code AS title FROM storage_location WHERE uid::text = ANY($1)`,
  stock_reason: `SELECT uid::text AS key, app_loc(name_ru, name_uz) AS title FROM stock_reason WHERE uid::text = ANY($1)`,
  document: `SELECT uid::text AS key, number AS title FROM document WHERE uid::text = ANY($1)`,
  document_type: `SELECT uid::text AS key, app_loc(name_ru, name_uz) AS title FROM document_type WHERE uid::text = ANY($1)`,
  finance_operation: `SELECT uid::text AS key, number AS title FROM finance_operation WHERE uid::text = ANY($1)`,
  sales_order: `SELECT uid::text AS key, number AS title FROM sales_order WHERE uid::text = ANY($1)`,
  production_order: `SELECT uid::text AS key, number AS title FROM production_order WHERE uid::text = ANY($1)`,
  tech_card: `SELECT tc.uid::text AS key, i.code || ' · v' || tc.version AS title
                FROM tech_card tc JOIN item i ON i.id = tc.item_id
               WHERE tc.uid::text = ANY($1)`,
  inventory_sheet: `SELECT uid::text AS key, number AS title FROM inventory_sheet WHERE uid::text = ANY($1)`,
  company_settings: `SELECT uid::text AS key, app_loc(name_ru, name_uz) AS title FROM company WHERE uid::text = ANY($1)`,
  stock_move: `SELECT m.uid::text AS key, i.code || ' · ' || app_loc(i.name_ru, i.name_uz) AS title
                 FROM stock_move m JOIN item i ON i.id = m.item_id
                WHERE m.uid::text = ANY($1)`,
  stock_reservation: `SELECT r.uid::text AS key, i.code || ' · ' || app_loc(i.name_ru, i.name_uz) AS title
                        FROM stock_reservation r JOIN item i ON i.id = r.item_id
                       WHERE r.uid::text = ANY($1)`,
  item_stock_level: `SELECT l.uid::text AS key, i.code || ' · ' || app_loc(i.name_ru, i.name_uz) AS title
                       FROM item_stock_level l JOIN item i ON i.id = l.item_id
                      WHERE l.uid::text = ANY($1)`,
  price_list: `SELECT p.uid::text AS key, i.code || ' · ' || app_loc(i.name_ru, i.name_uz) AS title
                 FROM price_list p JOIN item i ON i.id = p.item_id
                WHERE p.uid::text = ANY($1)`,
  budget: `SELECT b.uid::text AS key,
                  ci.name_ru || ' · ' || to_char(b.period_start, 'DD.MM.YYYY') AS title
             FROM budget b JOIN cashflow_item ci ON ci.id = b.cashflow_item_id
            WHERE b.uid::text = ANY($1)`,
};

/** Причины неудачного входа — из `auth.service`, слово в слово. */
const FAILURES: Record<string, { ru: string; uz: string }> = {
  unknown_or_inactive: {
    ru: 'Нет такой учётной записи или она выключена',
    uz: 'Bunday hisob yo‘q yoki o‘chirilgan',
  },
  locked: { ru: 'Учётная запись заблокирована', uz: 'Hisob bloklangan' },
  bad_password: { ru: 'Неверный пароль', uz: 'Parol xato' },
};

/**
 * Журнал действий и журнал входов (ТЗ 3.4).
 *
 * Оба уже пишутся: аудит — из каждого модуля через `writeAudit`, входы — из
 * `auth.service` на каждой попытке, включая неудачную. Этот сервис их только
 * читает, поэтому писать сюда ничего нельзя и нечем.
 *
 * Разница в области видимости, и она не случайна: журнал действий закрыт
 * политикой по компании (действие всегда происходит в чьей-то компании), а
 * журнал входов общий — неудачная попытка входа ни о какой компании ещё не
 * знает, у неё и пользователя может не быть.
 */
@Injectable()
export class AdminJournalService {
  constructor(private readonly prisma: PrismaService) {}

  async audit(params: {
    entityType?: string;
    action?: string;
    userUid?: string;
    from?: string;
    to?: string;
    search?: string;
    limit: number;
    offset: number;
  }) {
    return this.prisma.withTenant(async (tx) => {
      const search = params.search?.trim() ? `%${params.search.trim()}%` : null;
      const entity = params.entityType ?? null;
      const action = params.action ?? null;
      const userUid = params.userUid ?? null;
      const from = params.from ?? null;
      const to = params.to ?? null;

      const total = await tx.$queryRaw<{ n: bigint }[]>`
        SELECT count(*)::bigint AS n
          FROM audit_log a
          LEFT JOIN user_account u ON u.id = a.user_id
         WHERE (${entity}::text IS NULL OR a.entity_type = ${entity}::text)
           AND (${action}::text IS NULL OR a.action = ${action}::text)
           AND (${userUid}::text IS NULL OR u.uid = ${userUid}::uuid)
           AND (${from}::date IS NULL
                OR a.occurred_at >= (${from}::date::timestamp AT TIME ZONE 'Asia/Tashkent'))
           AND (${to}::date IS NULL
                OR a.occurred_at < ((${to}::date + 1)::timestamp AT TIME ZONE 'Asia/Tashkent'))
           AND (${search}::text IS NULL
                OR a.entity_id ILIKE ${search} OR a.changes::text ILIKE ${search}
                OR coalesce(u.full_name, '') ILIKE ${search})`;

      const rows = await tx.$queryRaw<
        {
          occurred_at: Date;
          entity_type: string;
          entity_id: string;
          action: string;
          changes: unknown;
          source: string;
          ip: string | null;
          login: string | null;
          full_name: string | null;
          user_uid: string | null;
          company_code: string;
        }[]
      >`
        SELECT a.occurred_at, a.entity_type, a.entity_id, a.action, a.changes,
               a.source::text AS source, a.ip,
               u.login, u.full_name, u.uid AS user_uid, c.code AS company_code
          FROM audit_log a
          LEFT JOIN user_account u ON u.id = a.user_id
          JOIN company c ON c.id = a.company_id
         WHERE (${entity}::text IS NULL OR a.entity_type = ${entity}::text)
           AND (${action}::text IS NULL OR a.action = ${action}::text)
           AND (${userUid}::text IS NULL OR u.uid = ${userUid}::uuid)
           AND (${from}::date IS NULL
                OR a.occurred_at >= (${from}::date::timestamp AT TIME ZONE 'Asia/Tashkent'))
           AND (${to}::date IS NULL
                OR a.occurred_at < ((${to}::date + 1)::timestamp AT TIME ZONE 'Asia/Tashkent'))
           AND (${search}::text IS NULL
                OR a.entity_id ILIKE ${search} OR a.changes::text ILIKE ${search}
                OR coalesce(u.full_name, '') ILIKE ${search})
         ORDER BY a.occurred_at DESC, a.id DESC
         LIMIT ${params.limit}::int OFFSET ${params.offset}::int`;

      // Названия берём одним запросом на тип сущности и только по этой
      // странице: журнал читают страницами, а не целиком.
      const titles = new Map<string, string>();
      const byType = new Map<string, Set<string>>();
      for (const r of rows) {
        if (!TITLE_SQL[r.entity_type]) continue;
        const set = byType.get(r.entity_type) ?? new Set<string>();
        set.add(r.entity_id);
        byType.set(r.entity_type, set);
      }
      for (const [type, keys] of byType) {
        const found = await tx.$queryRawUnsafe<{ key: string; title: string | null }[]>(
          TITLE_SQL[type]!,
          [...keys],
        );
        for (const f of found) {
          if (f.title) titles.set(`${type}:${f.key}`, f.title);
        }
      }

      return {
        total: Number(total[0]?.n ?? 0),
        limit: params.limit,
        offset: params.offset,
        rows: rows.map((r) => ({
          occurredAt: r.occurred_at,
          entityType: r.entity_type,
          entityId: r.entity_id,
          // Удалённый предмет названия не получит — останется идентификатор.
          entityTitle: titles.get(`${r.entity_type}:${r.entity_id}`) ?? null,
          action: r.action,
          actionRu: ACTIONS[r.action]?.ru ?? r.action,
          actionUz: ACTIONS[r.action]?.uz ?? r.action,
          changes: r.changes,
          source: r.source,
          ip: r.ip,
          company: r.company_code,
          // Автор мог быть удалён вместе с учёткой: показываем, что действие
          // было, а не прячем строку.
          user: r.login ? { uid: r.user_uid, login: r.login, fullName: r.full_name } : null,
        })),
      };
    });
  }

  /** Какие сущности и действия вообще встречаются — для выпадающих списков фильтра. */
  async auditFacets() {
    return this.prisma.withTenant(async (tx) => {
      const entities = await tx.$queryRaw<{ entity_type: string; n: bigint }[]>`
        SELECT entity_type, count(*)::bigint AS n FROM audit_log
         GROUP BY entity_type ORDER BY n DESC`;
      const actions = await tx.$queryRaw<{ action: string; n: bigint }[]>`
        SELECT action, count(*)::bigint AS n FROM audit_log
         GROUP BY action ORDER BY n DESC`;
      return {
        entities: entities.map((e) => ({ value: e.entity_type, count: Number(e.n) })),
        actions: actions.map((a) => ({
          value: a.action,
          nameRu: ACTIONS[a.action]?.ru ?? a.action,
          nameUz: ACTIONS[a.action]?.uz ?? a.action,
          count: Number(a.n),
        })),
      };
    });
  }

  async logins(params: { onlyFailed: boolean; userUid?: string; limit: number; offset: number }) {
    return this.prisma.withTenant(async (tx) => {
      const userUid = params.userUid ?? null;
      const total = await tx.$queryRaw<{ n: bigint }[]>`
        SELECT count(*)::bigint AS n
          FROM login_log l
          LEFT JOIN user_account u ON u.id = l.user_id
         WHERE (NOT ${params.onlyFailed}::boolean OR NOT l.success)
           AND (${userUid}::text IS NULL OR u.uid = ${userUid}::uuid)`;

      const rows = await tx.$queryRaw<
        {
          occurred_at: Date;
          success: boolean;
          ip: string | null;
          user_agent: string | null;
          failure_reason: string | null;
          login: string | null;
          full_name: string | null;
        }[]
      >`
        SELECT l.occurred_at, l.success, l.ip, l.user_agent, l.failure_reason,
               u.login, u.full_name
          FROM login_log l
          LEFT JOIN user_account u ON u.id = l.user_id
         WHERE (NOT ${params.onlyFailed}::boolean OR NOT l.success)
           AND (${userUid}::text IS NULL OR u.uid = ${userUid}::uuid)
         ORDER BY l.occurred_at DESC, l.id DESC
         LIMIT ${params.limit}::int OFFSET ${params.offset}::int`;

      return {
        total: Number(total[0]?.n ?? 0),
        limit: params.limit,
        offset: params.offset,
        rows: rows.map((r) => ({
          occurredAt: r.occurred_at,
          success: r.success,
          ip: r.ip,
          userAgent: r.user_agent,
          failureReason: r.failure_reason,
          // Попытка под несуществующим логином пользователя не имеет вовсе —
          // и это сама по себе важная строка: так выглядит перебор логинов.
          login: r.login,
          fullName: r.full_name,
          reasonRu: r.failure_reason ? (FAILURES[r.failure_reason]?.ru ?? r.failure_reason) : null,
          reasonUz: r.failure_reason ? (FAILURES[r.failure_reason]?.uz ?? r.failure_reason) : null,
        })),
      };
    });
  }
}
