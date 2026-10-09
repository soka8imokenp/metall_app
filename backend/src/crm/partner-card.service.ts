import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import {
  DEBT_EXPR,
  MAX_OVERDUE_DAYS_EXPR,
  OLDEST_DUE_EXPR,
  OVERDUE_EXPR,
  UNPAID_ORDERS_WHERE,
} from '../finance/receivables.js';
import { MSG } from '../common/messages.js';

/** Деньги наружу — тем же видом, что и в финансах: иначе два экрана показывают
 *  одно число по-разному, и сравнить их глазами нельзя. */
const money = (v: unknown) => Number(v ?? 0).toFixed(2);
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

/**
 * Вкладки карточки клиента (ТЗ 8.2): сделки, заказы, документы, финансы,
 * история изменений. Задачи, активности и файлы у карточки свои готовые
 * источники — `/crm/tasks`, `/crm/activities` и `/attachments` с владельцем
 * «клиент», — и второй раз здесь не переписываются.
 *
 * Главное правило этого файла: **карточка ничего не считает сама**. Заказы
 * берутся из продаж, долг и платежи — из финансов, причём выражениями из
 * `finance/receivables.ts`. Свой счёт тех же денег в CRM разошёлся бы с
 * финансовым, и на вопрос «сколько должен клиент» система начала бы отвечать
 * двумя разными числами — а спрашивают его как раз перед отгрузкой.
 *
 * Документы показываются как есть, на чтение: таблица заведена и засеяна, а
 * модуля документов ещё нет. Прятать существующие строки до его появления
 * значило бы врать, что документов у клиента нет.
 */
@Injectable()
export class PartnerCardService {
  constructor(private readonly prisma: PrismaService) {}

  private async partnerId(tx: Tx, uid: string): Promise<bigint> {
    const rows = await tx.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM partner WHERE uid = ${uid}::uuid`;
    if (!rows[0]) throw new NotFoundException(MSG.partnerNotFound());
    return rows[0].id;
  }

  async deals(uid: string) {
    return this.prisma.withTenant(async (tx) => {
      const id = await this.partnerId(tx, uid);
      const rows = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT d.uid, d.number, d.title, d.amount::text AS amount, d.probability,
                d.status::text AS status, d.expected_close_date, d.created_at, d.closed_at,
                app_loc(s.name_ru, s.name_uz) AS stage_name, s.code AS stage_code,
                m.full_name AS manager_name,
                app_loc(r.name_ru, r.name_uz) AS lost_reason
           FROM deal d
           JOIN deal_stage s ON s.id = d.stage_id
           LEFT JOIN user_account m ON m.id = d.manager_id
           LEFT JOIN deal_lost_reason r ON r.id = d.lost_reason_id
          WHERE d.partner_id = $1
          ORDER BY d.created_at DESC`,
        id,
      );
      return {
        rows: rows.map((r: any) => ({
          uid: r.uid,
          number: r.number,
          title: r.title,
          amount: r.amount,
          probability: r.probability,
          status: r.status as 'open' | 'won' | 'lost',
          stage: { name: r.stage_name, code: r.stage_code },
          manager: r.manager_name,
          lostReason: r.lost_reason,
          expectedCloseDate: r.expected_close_date,
          createdAt: r.created_at,
          closedAt: r.closed_at,
        })),
        total: rows.length,
      };
    });
  }

  async orders(uid: string) {
    return this.prisma.withTenant(async (tx) => {
      const id = await this.partnerId(tx, uid);
      const rows = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT o.uid, o.number, o.order_date, o.delivery_date, o.payment_due_date,
                o.amount_total::text AS amount_total, o.paid_amount::text AS paid_amount,
                o.status::text AS status, o.payment_status::text AS payment_status,
                o.shipment_status::text AS shipment_status,
                c.code AS currency, m.full_name AS manager_name
           FROM sales_order o
           JOIN currency c ON c.id = o.currency_id
           LEFT JOIN user_account m ON m.id = o.manager_id
          WHERE o.partner_id = $1
          ORDER BY o.order_date DESC, o.id DESC`,
        id,
      );
      return {
        rows: rows.map((r: any) => ({
          uid: r.uid,
          number: r.number,
          orderDate: r.order_date,
          deliveryDate: r.delivery_date,
          paymentDueDate: r.payment_due_date,
          amountTotal: r.amount_total,
          paidAmount: r.paid_amount,
          status: r.status,
          paymentStatus: r.payment_status,
          shipmentStatus: r.shipment_status,
          currency: r.currency,
          manager: r.manager_name,
        })),
        total: rows.length,
      };
    });
  }

  async documents(uid: string) {
    return this.prisma.withTenant(async (tx) => {
      const id = await this.partnerId(tx, uid);
      const rows = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT d.uid, d.number, d.document_date, d.status::text AS status,
                d.amount_total::text AS amount_total,
                app_loc(t.name_ru, t.name_uz) AS type_name, t.code AS type_code,
                c.code AS currency
           FROM document d
           JOIN document_type t ON t.id = d.document_type_id
           LEFT JOIN currency c ON c.id = d.currency_id
          WHERE d.partner_id = $1
          ORDER BY d.document_date DESC, d.id DESC`,
        id,
      );
      return {
        rows: rows.map((r: any) => ({
          uid: r.uid,
          number: r.number,
          date: r.document_date,
          status: r.status,
          amountTotal: r.amount_total,
          type: { name: r.type_name, code: r.type_code },
          currency: r.currency,
        })),
        total: rows.length,
        /** Документ выписывают в своём разделе: здесь его видно, но не создают. */
        readOnly: true,
      };
    });
  }

  /**
   * Финансы клиента: долг, просрочка, лимит и платежи.
   *
   * Долг и просрочка считаются выражениями из `finance/receivables.ts` — теми
   * же, что и список дебиторов в финансах. Равенство этих двух чисел
   * проверяется тестом, а не обещанием.
   */
  async finance(uid: string) {
    return this.prisma.withTenant(async (tx) => {
      const id = await this.partnerId(tx, uid);

      const totals = await tx.$queryRawUnsafe<
        {
          debt: string | null;
          overdue: string | null;
          oldest_due: Date | null;
          max_overdue_days: number | null;
          orders: bigint;
          debt_limit: string;
          payment_delay_days: number;
        }[]
      >(
        `SELECT coalesce(${DEBT_EXPR}, 0)::text AS debt,
                coalesce(${OVERDUE_EXPR}, 0)::text AS overdue,
                ${OLDEST_DUE_EXPR} AS oldest_due,
                ${MAX_OVERDUE_DAYS_EXPR} AS max_overdue_days,
                count(o.id)::bigint AS orders,
                max(p.debt_limit)::text AS debt_limit,
                max(p.payment_delay_days)::int AS payment_delay_days
           FROM partner p
           LEFT JOIN sales_order o ON o.partner_id = p.id AND ${UNPAID_ORDERS_WHERE}
          WHERE p.id = $1`,
        id,
      );
      const t = totals[0]!;

      const payments = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT f.uid, f.number, f.operation_type::text AS operation_type, f.occurred_at,
                f.amount::text AS amount, f.status::text AS status, f.comment,
                c.code AS currency, app_loc(a.name_ru, a.name_uz) AS account_name
           FROM finance_operation f
           JOIN currency c ON c.id = f.currency_id
           JOIN account a ON a.id = f.account_id
          WHERE f.partner_id = $1
          ORDER BY f.occurred_at DESC, f.id DESC
          LIMIT 100`,
        id,
      );

      const debt = Number(t.debt ?? 0);
      const limit = Number(t.debt_limit ?? 0);
      return {
        debt: money(t.debt),
        overdue: money(t.overdue),
        debtLimit: money(t.debt_limit),
        // Лимит превышен — отдельный признак, а не «долг больше нуля»:
        // отгружать дальше нельзя именно по нему.
        overLimit: limit > 0 && debt > limit,
        paymentDelayDays: t.payment_delay_days,
        unpaidOrders: Number(t.orders),
        oldestDueDate: day(t.oldest_due),
        maxOverdueDays: t.max_overdue_days ?? 0,
        payments: payments.map((r: any) => ({
          uid: r.uid,
          number: r.number,
          type: r.operation_type,
          at: r.occurred_at,
          amount: money(r.amount),
          currency: r.currency,
          status: r.status,
          account: r.account_name,
          comment: r.comment,
        })),
      };
    });
  }

  /**
   * История изменений карточки.
   *
   * Правки контактных лиц пишутся сюда же, к клиенту: в карточке ищут «когда
   * сменили телефон», а не «что было с контактом номер такой-то».
   */
  async history(uid: string) {
    return this.prisma.withTenant(async (tx) => {
      await this.partnerId(tx, uid);
      const rows = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT a.occurred_at, a.action, a.changes, u.full_name AS user_name
           FROM audit_log a
           LEFT JOIN user_account u ON u.id = a.user_id
          WHERE a.entity_type = 'partner' AND a.entity_id = $1
          ORDER BY a.occurred_at DESC, a.id DESC
          LIMIT 200`,
        uid,
      );
      return {
        rows: rows.map((r: any) => ({
          at: r.occurred_at,
          action: r.action as string,
          user: r.user_name,
          changes: (r.changes ?? {}) as Record<string, { from: unknown; to: unknown }>,
        })),
        total: rows.length,
      };
    });
  }
}
