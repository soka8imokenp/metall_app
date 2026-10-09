import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { currentContext } from '../common/request-context.js';
import { availableActions, type DocumentStatus } from './workflow.js';
import { MSG } from '../common/messages.js';

/**
 * Реестр документов (ТЗ 7.1, 7.5).
 *
 * Чтение реестра и карточки. Создание, маршрут согласования и файлы живут в
 * соседних службах модуля. Экран встал на живые данные первым — до этого он
 * показывал 149 выдуманных счетов, и по ним нельзя было ни найти нужный, ни
 * понять, чего в реестре не хватает.
 *
 * Два правила, которые видны уже в чтении:
 *
 * - **Источник не пересчитывается.** Документ держит ссылку на то, из чего он
 *   сделан (`source_doc_type` + `source_doc_id`), и по ней показывает номер —
 *   но сумма и контрагент берутся из самого документа. Счёт, выставленный в
 *   марте, печатается мартовскими числами, даже если в заказе потом всё
 *   поменяли. Ссылка нужна для перехода, а не для расчёта.
 * - **Счётчики по статусам считаются по тем же фильтрам, что и список, но без
 *   выбранного статуса.** Иначе «на согласовании 83» пропадало бы, как только
 *   на этот статус нажали.
 */
@Injectable()
export class DocumentsService {
  constructor(private readonly prisma: PrismaService) {}

  async types(showHidden = false) {
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.$queryRawUnsafe<Record<string, any>[]>(
        `SELECT t.uid, t.code, t.name_ru, t.name_uz, t.numbering_mask,
                t.counter_scope::text AS counter_scope, t.is_active,
                co.uid AS company_uid, co.code AS company_code,
                (SELECT count(*) FROM document d WHERE d.document_type_id = t.id) AS documents
           FROM document_type t
           JOIN company co ON co.id = t.company_id
          WHERE ($1::boolean OR t.is_active)
          ORDER BY co.code, t.code`,
        showHidden,
      );
      return {
        rows: rows.map((r) => ({
          uid: r.uid,
          code: r.code,
          nameRu: r.name_ru,
          nameUz: r.name_uz,
          numberingMask: r.numbering_mask,
          counterScope: r.counter_scope,
          isActive: r.is_active,
          company: { uid: r.company_uid, code: r.company_code },
          usage: { documents: Number(r.documents) },
        })),
      };
    });
  }

  async list(params: {
    search?: string;
    typeUid?: string;
    typeCode?: string;
    status?: string;
    partnerUid?: string;
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  }) {
    const search = params.search?.trim() ?? '';
    const limit = params.limit ?? 50;
    const offset = params.offset ?? 0;

    return this.prisma.withTenant(async (tx) => {
      // Фильтры без статуса — по ним же считаются счётчики.
      // Тип принадлежит компании: у торгового дома и у завода свой «Счёт» со
      // своей нумерацией. Экран в режиме холдинга фильтрует по коду — иначе в
      // списке два одинаковых «Счёта», и любой выбор прячет половину. Фильтр по
      // uid оставлен для точечного запроса по типу одной компании.
      const common = `($1::text = '' OR d.number ILIKE '%' || $1::text || '%')
                        AND ($2::uuid IS NULL OR t.uid = $2::uuid)
                        AND ($3::uuid IS NULL OR p.uid = $3::uuid)
                        AND ($4::date IS NULL OR d.document_date >= $4::date)
                        AND ($5::date IS NULL OR d.document_date <= $5::date)
                        AND ($6::text = '' OR t.code = $6::text)`;
      const args = [
        search,
        params.typeUid ?? null,
        params.partnerUid ?? null,
        params.from ?? null,
        params.to ?? null,
        params.typeCode ?? '',
      ];

      const rows = await tx.$queryRawUnsafe<Record<string, any>[]>(
        `${DOC_SELECT}
          WHERE ${common} AND ($7::text = '' OR d.status::text = $7::text)
          ORDER BY d.document_date DESC, d.id DESC
          LIMIT $8 OFFSET $9`,
        ...args,
        params.status ?? '',
        limit,
        offset,
      );

      const totals = await tx.$queryRawUnsafe<{ status: string; n: bigint }[]>(
        `SELECT d.status::text AS status, count(*) AS n
           FROM document d
           JOIN document_type t ON t.id = d.document_type_id
           LEFT JOIN partner p ON p.id = d.partner_id
          WHERE ${common}
          GROUP BY d.status`,
        ...args,
      );

      const byStatus: Record<string, number> = {};
      let total = 0;
      for (const r of totals) {
        byStatus[r.status] = Number(r.n);
        total += Number(r.n);
      }

      return {
        rows: rows.map(documentView),
        total: params.status ? (byStatus[params.status] ?? 0) : total,
        byStatus,
        limit,
        offset,
      };
    });
  }

  async one(uid: string) {
    const ctx = currentContext();
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.$queryRawUnsafe<Record<string, any>[]>(
        `${DOC_SELECT} WHERE d.uid = $1::uuid`,
        uid,
      );
      const row = rows[0];
      if (!row) throw new NotFoundException(MSG.documentNotFound());

      // Строки и реквизиты — только в карточке. В списке их нет намеренно:
      // на 240 документов это 240 запросов ради данных, которых на экране
      // списка не видно.
      const lines = await tx.$queryRawUnsafe<Record<string, any>[]>(
        `SELECT seq, uid, item_code, name, qty::text AS qty, unit_code, unit_name,
                price::text AS price, discount_percent::text AS discount_percent,
                vat_rate::text AS vat_rate, amount_net::text AS amount_net,
                amount_vat::text AS amount_vat, amount_total::text AS amount_total
           FROM document_line WHERE document_id = $1 ORDER BY seq`,
        row.id,
      );

      return {
        ...documentView(row),
        // Кнопки на карточке рисуются по этому списку, а не по своему
        // перечню на фронте: второй список правил однажды разошёлся бы с
        // сервером, и экран предлагал бы действие, на которое придёт отказ.
        actions: availableActions(row.status as DocumentStatus, ctx?.permissions ?? []),
        requisites: row.requisites ?? null,
        lines: lines.map((l) => ({
          uid: l.uid,
          seq: Number(l.seq),
          itemCode: l.item_code,
          name: l.name,
          qty: l.qty,
          unitCode: l.unit_code,
          unitName: l.unit_name,
          price: l.price,
          discountPercent: l.discount_percent,
          vatRate: l.vat_rate,
          amountNet: l.amount_net,
          amountVat: l.amount_vat,
          amountTotal: l.amount_total,
        })),
      };
    });
  }
}

/**
 * Источник документа — не полиморфная загадка, а четыре явных соединения.
 *
 * `source_doc_type` хранит имя таблицы, и соблазн собрать запрос строкой велик,
 * но подстановка имени таблицы из данных — это дыра. Четыре `LEFT JOIN`
 * с условием по типу читаются и планировщиком, и человеком.
 */
const DOC_SELECT = `
  SELECT d.id, d.uid, d.number, d.document_date, d.amount_total::text AS amount_total,
         d.amount_net::text AS amount_net, d.amount_vat::text AS amount_vat, d.requisites,
         d.locale::text AS locale, d.status::text AS status, d.version,
         d.source_doc_type, d.created_at,
         d.status_comment, d.status_at, su.full_name AS status_user,
         (SELECT count(*) FROM document_version v WHERE v.document_id = d.id) AS versions,
         co.uid AS company_uid, co.code AS company_code,
         co.name_ru AS company_name_ru, co.name_uz AS company_name_uz,
         t.uid AS type_uid, t.code AS type_code, t.name_ru AS type_name_ru,
         t.name_uz AS type_name_uz,
         p.uid AS partner_uid, app_loc(p.name_ru, p.name_uz) AS partner_name, p.inn AS partner_inn,
         cur.code AS currency,
         au.uid AS author_uid, au.full_name AS author_name,
         so.uid AS so_uid, so.number AS so_number,
         dl.uid AS deal_uid, dl.number AS deal_number,
         fo.uid AS fo_uid, fo.number AS fo_number,
         po.uid AS po_uid, po.number AS po_number,
         (SELECT count(*) FROM attachment a WHERE a.document_id = d.id) AS files
    FROM document d
    JOIN company co ON co.id = d.company_id
    JOIN document_type t ON t.id = d.document_type_id
    LEFT JOIN partner p ON p.id = d.partner_id
    LEFT JOIN currency cur ON cur.id = d.currency_id
    LEFT JOIN user_account au ON au.id = d.created_by
    LEFT JOIN user_account su ON su.id = d.status_by
    LEFT JOIN sales_order so ON so.id = d.source_doc_id AND d.source_doc_type = 'sales_order'
    LEFT JOIN deal dl ON dl.id = d.source_doc_id AND d.source_doc_type = 'deal'
    LEFT JOIN finance_operation fo ON fo.id = d.source_doc_id AND d.source_doc_type = 'finance_operation'
    LEFT JOIN production_order po ON po.id = d.source_doc_id AND d.source_doc_type = 'production_order'`;

const source = (r: Record<string, any>) => {
  const kind = r.source_doc_type as string | null;
  if (!kind) return null;
  const pair: Record<string, [string | null, string | null]> = {
    sales_order: [r.so_uid, r.so_number],
    deal: [r.deal_uid, r.deal_number],
    finance_operation: [r.fo_uid, r.fo_number],
    production_order: [r.po_uid, r.po_number],
  };
  const [uid, number] = pair[kind] ?? [null, null];
  // Источник неизвестного вида показываем как есть, а не прячем: строка в базе
  // о нём говорит, и молчать об этом на экране — врать.
  return { kind, uid, number };
};

export const documentView = (r: Record<string, any>) => ({
  uid: r.uid,
  number: r.number,
  documentDate: r.document_date,
  type: {
    uid: r.type_uid,
    code: r.type_code,
    nameRu: r.type_name_ru,
    nameUz: r.type_name_uz,
  },
  // Код компании человеку ничего не говорит: на карточке стояло
  // «Компания plant». Имя приходит из базы, а не собирается на фронте по
  // словарю кодов — компании в системе добавляет заказчик.
  company: {
    uid: r.company_uid,
    code: r.company_code,
    nameRu: r.company_name_ru,
    nameUz: r.company_name_uz,
  },
  partner: r.partner_uid
    ? { uid: r.partner_uid, name: r.partner_name, inn: r.partner_inn }
    : null,
  source: source(r),
  amountNet: r.amount_net,
  amountVat: r.amount_vat,
  amountTotal: r.amount_total,
  currency: r.currency,
  locale: r.locale as 'ru' | 'uz',
  status: r.status as string,
  version: Number(r.version),
  /**
   * Почему документ в этом статусе. Читают это в карточке рядом со статусом,
   * а не в истории: «вернули — что переделывать» должно быть на виду.
   */
  statusComment: (r.status_comment ?? null) as string | null,
  statusAt: r.status_at ?? null,
  statusUser: (r.status_user ?? null) as string | null,
  /** Сколько прежних редакций лежит в архиве. */
  versions: Number(r.versions ?? 0),
  author: r.author_uid ? { uid: r.author_uid, name: r.author_name } : null,
  files: Number(r.files),
  createdAt: r.created_at,
});
