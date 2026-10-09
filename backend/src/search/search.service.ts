import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { requireContext } from '../common/request-context.js';
import { say } from '../common/say.js';

/**
 * Один поиск на всю систему.
 *
 * Окно поиска во фронте искало только названия разделов — то есть повторяло
 * меню, которое и так на экране. Человеку нужно другое: ввести кусок номера
 * заказа, фамилию клиента или код трубы и попасть на запись.
 *
 * Два правила, из-за которых поиск нельзя написать одним запросом на всё:
 *
 *   1. **Права.** Группа выдаётся, только если у человека есть право на её
 *      раздел. Иначе поиск становится обходом ролей: рабочий цеха не видит
 *      контрагентов в CRM, но увидел бы их здесь.
 *   2. **Компания.** Запросы идут в таблицы напрямую, поэтому ходят через
 *      `withTenant` — он ставит `app.company_ids`, по которым работает RLS.
 *      Своей фильтрации по компании здесь нет намеренно: два разных способа
 *      ограничить выдачу однажды разойдутся, и разойдутся молча.
 *
 * Про скорость: отбор идёт по `ILIKE '%…%'`, и обычным индексом он не
 * покрывается. Поэтому запросы спрашивают `app_search(...)` — ровно то
 * выражение, по которому построен триграммный индекс (миграция
 * `20261005140000_search_trgm`). Перечислять поля по отдельности нельзя: план
 * тогда вернётся к чтению таблицы целиком, и заметно это станет не здесь, а у
 * заказчика. За совпадение выражения отвечает `test/search-index.spec.ts` —
 * он смотрит план того же самого запроса.
 *
 * Про `UNION` у заказов: заказ ищется и по своему номеру, и по имени
 * контрагента (номенклатуры) — это два условия в двух разных таблицах. Через
 * `OR` база не может взять ни один индекс: условие становится проверкой уже
 * после соединения, и обе таблицы читаются целиком. Поэтому каждое условие
 * отбирает свои строки само, по своему индексу, а `UNION` их складывает.
 */

/** Описание одной группы выдачи. */
interface GroupDef {
  kind: string;
  /** Раздел, который открывается по находке. */
  module: string;
  /**
   * Вкладка внутри раздела. Без неё переход попадает на ту вкладку, которая у
   * раздела первая: CRM открывается на обращениях, и клиент, найденный
   * поиском, оказывался не на том экране.
   */
  view: string;
  titleRu: string;
  titleUz: string;
  /** Достаточно любого права из списка. */
  permissions: string[];
  /**
   * Запрос группы. Параметры: $1 — строка поиска, $2 — предел.
   * Колонки: uid, title, subtitle.
   */
  sql: string;
}

const GROUPS: GroupDef[] = [
  {
    kind: 'item',
    module: 'warehouse',
    view: 'stock',
    titleRu: 'Номенклатура',
    titleUz: 'Nomenklatura',
    permissions: ['warehouse.view'],
    sql: `SELECT i.uid,
                 app_loc(i.name_ru, i.name_uz) AS title,
                 i.code AS subtitle
            FROM item i
           WHERE i.is_active
             AND app_search(i.code, i.name_ru, i.name_uz, i.barcode) ILIKE $1
           ORDER BY i.code
           LIMIT $2`,
  },
  {
    kind: 'partner',
    module: 'crm',
    view: 'partners',
    titleRu: 'Контрагенты',
    titleUz: 'Kontragentlar',
    // Контрагента ищет и продавец, и CRM: карточка одна на оба раздела.
    permissions: ['crm.view', 'sales.view'],
    sql: `SELECT p.uid,
                 app_loc(p.name_ru, p.name_uz) AS title,
                 p.inn AS subtitle
            FROM partner p
           WHERE p.is_active
             AND app_search(p.name_ru, p.name_uz, p.inn) ILIKE $1
           ORDER BY p.name_ru
           LIMIT $2`,
  },
  {
    kind: 'salesOrder',
    module: 'sales',
    view: 'orders',
    titleRu: 'Заказы продаж',
    titleUz: 'Sotuv buyurtmalari',
    permissions: ['sales.view'],
    sql: `WITH found AS (
             SELECT id FROM sales_order WHERE app_search(number) ILIKE $1
             UNION
             SELECT o.id FROM sales_order o
               JOIN partner p ON p.id = o.partner_id
              WHERE app_search(p.name_ru, p.name_uz) ILIKE $1
           )
           SELECT o.uid,
                  o.number AS title,
                  app_loc(p.name_ru, p.name_uz) AS subtitle
             FROM found f
             JOIN sales_order o ON o.id = f.id
             JOIN partner p ON p.id = o.partner_id
            ORDER BY o.order_date DESC
            LIMIT $2`,
  },
  {
    kind: 'productionOrder',
    module: 'production',
    view: 'orders',
    titleRu: 'Заказы цеха',
    titleUz: 'Sex buyurtmalari',
    permissions: ['production.view'],
    sql: `WITH found AS (
             SELECT id FROM production_order WHERE app_search(number) ILIKE $1
             UNION
             SELECT o.id FROM production_order o
               JOIN item i ON i.id = o.item_id
              WHERE app_search(i.name_ru, i.name_uz) ILIKE $1
           )
           SELECT o.uid,
                  o.number AS title,
                  app_loc(i.name_ru, i.name_uz) AS subtitle
             FROM found f
             JOIN production_order o ON o.id = f.id
             JOIN item i ON i.id = o.item_id
            ORDER BY o.due_date DESC
            LIMIT $2`,
  },
  {
    kind: 'batch',
    module: 'warehouse',
    view: 'stock',
    titleRu: 'Партии',
    titleUz: 'Partiyalar',
    permissions: ['warehouse.view'],
    sql: `SELECT b.uid,
                 b.number AS title,
                 app_loc(i.name_ru, i.name_uz) AS subtitle
            FROM batch b
            JOIN item i ON i.id = b.item_id
           WHERE app_search(b.number, b.certificate_number) ILIKE $1
           ORDER BY b.received_at DESC
           LIMIT $2`,
  },
  {
    kind: 'document',
    module: 'documents',
    view: 'registry',
    titleRu: 'Документы',
    titleUz: 'Hujjatlar',
    permissions: ['documents.view'],
    sql: `SELECT d.uid,
                 d.number AS title,
                 app_loc(t.name_ru, t.name_uz) AS subtitle
            FROM document d
            JOIN document_type t ON t.id = d.document_type_id
           WHERE app_search(d.number) ILIKE $1
           ORDER BY d.document_date DESC
           LIMIT $2`,
  },
  {
    kind: 'deal',
    module: 'crm',
    view: 'deals',
    titleRu: 'Сделки',
    titleUz: 'Bitimlar',
    permissions: ['crm.view'],
    sql: `SELECT d.uid,
                 d.title,
                 d.number AS subtitle
            FROM deal d
           WHERE app_search(d.number, d.title) ILIKE $1
           ORDER BY d.created_at DESC
           LIMIT $2`,
  },
  {
    kind: 'warehouse',
    module: 'warehouse',
    view: 'refs',
    titleRu: 'Склады',
    titleUz: 'Omborlar',
    permissions: ['warehouse.view'],
    sql: `SELECT w.uid,
                 app_loc(w.name_ru, w.name_uz) AS title,
                 w.code AS subtitle
            FROM warehouse w
           WHERE w.is_active
             AND app_search(w.code, w.name_ru, w.name_uz) ILIKE $1
           ORDER BY w.code
           LIMIT $2`,
  },
  {
    kind: 'user',
    module: 'admin',
    view: 'users',
    titleRu: 'Сотрудники',
    titleUz: 'Xodimlar',
    // Людей ведёт администратор. Телефон и почта коллеги — не то, что стоит
    // отдавать любому, у кого открыт поиск.
    permissions: ['admin.users'],
    sql: `SELECT u.uid,
                 u.full_name AS title,
                 u.login AS subtitle
            FROM user_account u
           WHERE u.is_active
             AND app_search(u.full_name, u.login, u.email, u.phone) ILIKE $1
           ORDER BY u.full_name
           LIMIT $2`,
  },
];

/**
 * Запрос группы — наружу для проверки планов.
 *
 * Прогон `test/search-index.spec.ts` спрашивает у базы план ровно того
 * запроса, который уходит в работу. Копия SQL в прогоне означала бы, что
 * проверяется не то, что выполняется.
 */
export const groupSql = (kind: string): string => {
  const def = GROUPS.find((g) => g.kind === kind);
  if (!def) throw new Error(`Группы «${kind}» в поиске нет`);
  return def.sql;
};

/** Все группы поиска — для прогонов, которые обходят их списком. */
export const searchKinds = (): string[] => GROUPS.map((g) => g.kind);

export interface SearchRow {
  uid: string;
  title: string;
  subtitle: string | null;
}

export interface SearchGroup {
  kind: string;
  module: string;
  view: string;
  title: string;
  rows: SearchRow[];
}

@Injectable()
export class SearchService {
  constructor(private readonly prisma: PrismaService) {}

  async search(query: string, limit: number): Promise<{ query: string; groups: SearchGroup[] }> {
    const q = query.trim();
    const { permissions } = requireContext();
    const allowed = GROUPS.filter((g) => g.permissions.some((p) => permissions.has(p)));
    // Подчёркивание и процент в ILIKE — подстановочные знаки. В номерах
    // документов они встречаются, и без экранирования «СЧ_1» нашёл бы «СЧ-1».
    const needle = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

    const groups: SearchGroup[] = [];
    await this.prisma.withTenant(async (tx) => {
      for (const def of allowed) {
        const rows = await tx.$queryRawUnsafe<SearchRow[]>(def.sql, needle, limit);
        if (rows.length === 0) continue;
        groups.push({
          kind: def.kind,
          module: def.module,
          view: def.view,
          title: say(def.titleRu, def.titleUz),
          rows: rows.map((r) => ({
            uid: r.uid,
            title: r.title ?? '',
            subtitle: r.subtitle ?? null,
          })),
        });
      }
    });

    return { query: q, groups };
  }
}
