import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { MSG } from '../common/messages.js';

export type OperationStatus =
  'draft' | 'pending_approval' | 'approved' | 'posted' | 'rejected' | 'reversed';
export type OperationType = 'income' | 'expense' | 'transfer' | 'conversion';

const money = (v: unknown) => Number(v ?? 0).toFixed(2);
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

/**
 * Журнал операций и карточка одной из них.
 *
 * Карточка отдаёт проводки целиком, а не итог: бухгалтеру нужно видеть, какие
 * счета задеты и в какую сторону, — по свёрнутой сумме ошибку в корреспонденции
 * не найти. Сходимость дебета с кредитом считается здесь же и отдаётся полем:
 * база держит её отложенным ограничением, но экран должен показывать, что
 * держит, а не верить на слово.
 */
@Injectable()
export class OperationsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(params: {
    status?: OperationStatus;
    type?: OperationType;
    account?: string;
    search?: string;
    limit: number;
  }) {
    return this.prisma.withTenant(async (tx) => {
      const search = params.search?.trim() ? `%${params.search.trim()}%` : null;

      const rows = await tx.$queryRaw<
        {
          uid: string;
          number: string;
          operation_type: string;
          status: string;
          occurred_at: Date;
          planned_date: Date | null;
          posted_at: Date | null;
          amount: string;
          currency: string;
          rate: string;
          amount_base: string;
          account_code: string;
          account_name_ru: string;
          account_name_uz: string;
          counter_code: string | null;
          counter_name_ru: string | null;
          counter_name_uz: string | null;
          item_name_ru: string | null;
          item_name_uz: string | null;
          item_direction: string | null;
          partner_uid: string | null;
          partner_name_ru: string | null;
          partner_name_uz: string | null;
          company_uid: string;
          company_code: string;
          comment: string | null;
          version: number;
          entries: bigint;
        }[]
      >`
        SELECT o.uid, o.number, o.operation_type::text AS operation_type, o.status::text AS status,
               o.occurred_at, o.planned_date, o.posted_at,
               o.amount, cur.code AS currency, o.rate, o.amount_base,
               a.code AS account_code, a.name_ru AS account_name_ru, a.name_uz AS account_name_uz,
               ca.code AS counter_code, ca.name_ru AS counter_name_ru, ca.name_uz AS counter_name_uz,
               ci.name_ru AS item_name_ru, ci.name_uz AS item_name_uz,
               ci.direction::text AS item_direction,
               p.uid AS partner_uid, p.name_ru AS partner_name_ru, p.name_uz AS partner_name_uz,
               co.uid AS company_uid, co.code AS company_code,
               o.comment, o.version,
               (SELECT count(*) FROM finance_entry e WHERE e.operation_id = o.id)::bigint AS entries
          FROM finance_operation o
          JOIN account a        ON a.id = o.account_id
          JOIN currency cur     ON cur.id = o.currency_id
          JOIN company co       ON co.id = o.company_id
          LEFT JOIN account ca  ON ca.id = o.counter_account_id
          LEFT JOIN cashflow_item ci ON ci.id = o.cashflow_item_id
          LEFT JOIN partner p   ON p.id = o.partner_id
         WHERE (${params.status ?? null}::text IS NULL OR o.status::text = ${params.status ?? null})
           AND (${params.type ?? null}::text IS NULL OR o.operation_type::text = ${params.type ?? null})
           AND (${params.account ?? null}::text IS NULL
                OR a.code = ${params.account ?? null} OR ca.code = ${params.account ?? null})
           AND (${search}::text IS NULL
                OR o.number ILIKE ${search}
                OR p.name_ru ILIKE ${search}
                OR ci.name_ru ILIKE ${search}
                OR o.comment ILIKE ${search})
         ORDER BY o.occurred_at DESC, o.number DESC
         LIMIT ${params.limit}::int
      `;

      return { rows: rows.map((r) => this.row(r)) };
    });
  }

  async card(uid: string) {
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.$queryRaw<any[]>`
        SELECT o.id, o.uid, o.number, o.operation_type::text AS operation_type, o.status::text AS status,
               o.occurred_at, o.planned_date, o.posted_at, o.created_at,
               o.amount, cur.code AS currency, o.rate, o.amount_base,
               a.code AS account_code, a.name_ru AS account_name_ru, a.name_uz AS account_name_uz,
               ca.code AS counter_code, ca.name_ru AS counter_name_ru, ca.name_uz AS counter_name_uz,
               ci.name_ru AS item_name_ru, ci.name_uz AS item_name_uz,
               ci.direction::text AS item_direction,
               p.uid AS partner_uid, p.name_ru AS partner_name_ru, p.name_uz AS partner_name_uz,
               co.uid AS company_uid, co.code AS company_code,
               o.comment, o.version, o.source_doc_type,
               so.uid AS source_order_uid, so.number AS source_order_number,
               cu.full_name AS created_by_name, au.full_name AS approved_by_name,
               (SELECT count(*) FROM finance_entry e WHERE e.operation_id = o.id)::bigint AS entries
          FROM finance_operation o
          JOIN account a        ON a.id = o.account_id
          JOIN currency cur     ON cur.id = o.currency_id
          JOIN company co       ON co.id = o.company_id
          LEFT JOIN account ca  ON ca.id = o.counter_account_id
          LEFT JOIN cashflow_item ci ON ci.id = o.cashflow_item_id
          LEFT JOIN partner p   ON p.id = o.partner_id
          LEFT JOIN sales_order so
                 ON o.source_doc_type = 'sales_order' AND so.id = o.source_doc_id
          LEFT JOIN user_account cu ON cu.id = o.created_by
          LEFT JOIN user_account au ON au.id = o.approved_by
         WHERE o.uid = ${uid}::uuid
      `;
      const op = rows[0];
      // Чужая компания политикой не отдаётся вовсе, и здесь это тот же ответ,
      // что и на несуществующий uid: знать о существовании чужой операции
      // пользователю незачем.
      if (!op) throw new NotFoundException(MSG.operationNotFound());

      const entries = await tx.$queryRaw<
        {
          code: string;
          name_ru: string;
          name_uz: string;
          kind: string;
          debit: string;
          credit: string;
          occurred_at: Date;
        }[]
      >`
        SELECT a.code, a.name_ru, a.name_uz, a.kind::text AS kind,
               e.debit, e.credit, e.occurred_at
          FROM finance_entry e
          JOIN account a ON a.id = e.account_id
         WHERE e.operation_id = ${op.id}
         ORDER BY e.debit DESC, a.code
      `;

      const debit = entries.reduce((s, e) => s + Number(e.debit), 0);
      const credit = entries.reduce((s, e) => s + Number(e.credit), 0);

      return {
        operation: {
          ...this.row(op),
          createdAt: op.created_at.toISOString(),
          createdBy: op.created_by_name,
          approvedBy: op.approved_by_name,
          sourceDocType: op.source_doc_type,
          // Заказ, который этим платежом оплачивают. Нужен и карточке в
          // браузере, и боту: из карточки платежа должен быть путь к заказу,
          // иначе «за что это заплатили» выясняют по номеру в примечании.
          sourceOrder: op.source_order_uid
            ? { uid: op.source_order_uid, number: op.source_order_number }
            : null,
        },
        entries: entries.map((e) => ({
          account: { code: e.code, nameRu: e.name_ru, nameUz: e.name_uz, kind: e.kind },
          debit: money(e.debit),
          credit: money(e.credit),
          occurredAt: e.occurred_at.toISOString(),
        })),
        totals: { debit: money(debit), credit: money(credit) },
        // Ноль равен нулю: у непроведённой операции проводок нет, и это
        // сходящееся состояние, а не поломка.
        balanced: Math.abs(debit - credit) < 0.005,
      };
    });
  }

  private row(r: any) {
    return {
      uid: r.uid,
      number: r.number,
      type: r.operation_type,
      status: r.status,
      occurredAt: r.occurred_at.toISOString(),
      plannedDate: day(r.planned_date),
      postedAt: r.posted_at ? r.posted_at.toISOString() : null,
      amount: money(r.amount),
      currency: r.currency,
      rate: Number(r.rate).toFixed(4),
      amountBase: money(r.amount_base),
      account: { code: r.account_code, nameRu: r.account_name_ru, nameUz: r.account_name_uz },
      counterAccount: r.counter_code
        ? { code: r.counter_code, nameRu: r.counter_name_ru, nameUz: r.counter_name_uz }
        : null,
      cashflowItem: r.item_name_ru
        ? { nameRu: r.item_name_ru, nameUz: r.item_name_uz, direction: r.item_direction }
        : null,
      partner: r.partner_uid
        ? { uid: r.partner_uid, nameRu: r.partner_name_ru, nameUz: r.partner_name_uz }
        : null,
      company: { uid: r.company_uid, code: r.company_code },
      comment: r.comment,
      // Версию экран возвращает в теле действия: без неё нельзя отличить
      // согласование того, что человек видел, от записи поверх чужой правки.
      version: Number(r.version),
      entries: Number(r.entries),
    };
  }
}
