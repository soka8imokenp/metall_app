import { Injectable } from '@nestjs/common';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import {
  DEBT_EXPR,
  MAX_OVERDUE_DAYS_EXPR,
  OLDEST_DUE_EXPR,
  OVERDUE_EXPR,
  UNPAID_ORDERS_WHERE,
} from './receivables.js';
import { BudgetsService } from './budgets.service.js';

export type Period = '7d' | '30d' | '3m';

const PERIOD_DAYS: Record<Period, number> = { '7d': 7, '30d': 30, '3m': 90 };

const money = (v: unknown) => Number(v ?? 0).toFixed(2);
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

/**
 * Шапка раздела «Финансы».
 *
 * Остаток счёта здесь считается по проводкам, а не хранится полем: поле
 * пришлось бы держать в согласии с журналом вручную, и однажды оно бы с ним
 * разошлось. Сумма дебета минус кредита — то же число, что видно в карточке
 * операции, только свёрнутое.
 *
 * Непроведённая операция на остаток не влияет: проводок у неё нет. Поэтому
 * заявка на оплату, ждущая согласования, показана отдельным блоком, а не
 * внутри оборота — иначе на экране были бы деньги, которых на счёте нет.
 */
@Injectable()
export class FinanceService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(period: Period) {
    const days = PERIOD_DAYS[period];

    return this.prisma.withTenant(async (tx) => {
      // Последовательно, а не Promise.all: одно соединение — один запрос.
      const accounts = await this.accounts(tx);
      const flow = await this.flow(tx, days);
      const byItem = await this.byItem(tx, days);
      const approval = await this.approval(tx);
      const receivablesTotals = await this.receivableTotals(tx);

      return { period, accounts, flow, byItem, approval, receivables: receivablesTotals };
    });
  }

  /** Остатки по счетам: сальдо = сумма проводок, а не отдельное поле. */
  private async accounts(tx: Tx) {
    const rows = await tx.$queryRaw<
      {
        code: string;
        name_ru: string;
        name_uz: string;
        kind: string;
        currency: string;
        company_uid: string;
        company_code: string;
        saldo: string;
        entries: bigint;
      }[]
    >`
      SELECT a.code, a.name_ru, a.name_uz, a.kind::text AS kind,
             cur.code                          AS currency,
             co.uid                            AS company_uid,
             co.code                           AS company_code,
             coalesce(sum(e.debit - e.credit), 0) AS saldo,
             count(e.id)::bigint               AS entries
        FROM account a
        JOIN currency cur ON cur.id = a.currency_id
        JOIN company co   ON co.id = a.company_id
        LEFT JOIN finance_entry e ON e.account_id = a.id
       WHERE a.is_active
       GROUP BY a.code, a.name_ru, a.name_uz, a.kind, cur.code, co.uid, co.code
       ORDER BY co.code, a.code
    `;
    return rows.map((r) => ({
      // Своего uid у счёта в модели нет: ключ строки — компания и код счёта,
      // тот самый, что напечатан в журнале и в карточке операции.
      key: `${r.company_code}:${r.code}`,
      code: r.code,
      nameRu: r.name_ru,
      nameUz: r.name_uz,
      kind: r.kind,
      // Сальдо всегда в базовой валюте: проводка пишется в ней, иначе
      // валютный счёт нельзя было бы сложить с расчётным.
      currency: r.currency,
      company: { uid: r.company_uid, code: r.company_code },
      saldo: money(r.saldo),
      entries: Number(r.entries),
    }));
  }

  /**
   * Оборот периода. Переводы между своими счетами и покупка валюты сюда не
   * входят: деньги не пришли и не ушли, они переложены, и в притоке они
   * посчитались бы дважды.
   */
  private async flow(tx: Tx, days: number) {
    const rows = await tx.$queryRaw<{ operation_type: string; amount: string; ops: bigint }[]>`
      SELECT operation_type::text AS operation_type,
             coalesce(sum(amount_base), 0) AS amount,
             count(*)::bigint              AS ops
        FROM finance_operation
       WHERE status = 'posted'
         AND occurred_at >= now() - make_interval(days => ${days}::int)
       GROUP BY operation_type
    `;
    const of = (t: string) => Number(rows.find((r) => r.operation_type === t)?.amount ?? 0);
    const countOf = (t: string) => Number(rows.find((r) => r.operation_type === t)?.ops ?? 0);
    const inflow = of('income');
    const outflow = of('expense');
    return {
      inflow: money(inflow),
      outflow: money(outflow),
      net: money(inflow - outflow),
      incomeOps: countOf('income'),
      expenseOps: countOf('expense'),
      transferOps: countOf('transfer') + countOf('conversion'),
    };
  }

  /** Движение денег по статьям ДДС за период — из него строится отчёт о ДДС. */
  private async byItem(tx: Tx, days: number) {
    const rows = await tx.$queryRaw<
      {
        name_ru: string;
        name_uz: string;
        direction: string;
        activity: string;
        amount: string;
        ops: bigint;
      }[]
    >`
      SELECT c.name_ru, c.name_uz, c.direction::text AS direction, c.activity::text AS activity,
             coalesce(sum(o.amount_base), 0) AS amount,
             count(o.id)::bigint             AS ops
        FROM cashflow_item c
        LEFT JOIN finance_operation o
               ON o.cashflow_item_id = c.id
              AND o.status = 'posted'
              AND o.occurred_at >= now() - make_interval(days => ${days}::int)
       GROUP BY c.name_ru, c.name_uz, c.direction, c.activity
       ORDER BY c.direction, sum(o.amount_base) DESC NULLS LAST
    `;
    return rows.map((r) => ({
      nameRu: r.name_ru,
      nameUz: r.name_uz,
      direction: r.direction,
      activity: r.activity,
      amount: money(r.amount),
      ops: Number(r.ops),
    }));
  }

  /**
   * Очередь согласования. Считается по всем непроведённым, без окна периода:
   * заявка, поданная два месяца назад и забытая, — как раз то, что этот блок
   * и должен показывать.
   */
  private async approval(tx: Tx) {
    const rows = await tx.$queryRaw<{ status: string; ops: bigint; amount: string }[]>`
      SELECT status::text AS status, count(*)::bigint AS ops, coalesce(sum(amount_base), 0) AS amount
        FROM finance_operation
       WHERE status <> 'posted'
       GROUP BY status
    `;
    const ops = (s: string) => Number(rows.find((r) => r.status === s)?.ops ?? 0);
    const amount = (s: string) => Number(rows.find((r) => r.status === s)?.amount ?? 0);
    return {
      draft: ops('draft'),
      pendingApproval: ops('pending_approval'),
      approved: ops('approved'),
      rejected: ops('rejected'),
      reversed: ops('reversed'),
      // Деньги, обещанные наружу, но ещё не ушедшие: поданные и согласованные.
      // Черновик сюда не входит — его ещё никто не подавал.
      amountPending: money(amount('pending_approval') + amount('approved')),
    };
  }

  private async receivableTotals(tx: Tx) {
    const rows = await tx.$queryRaw<{ total: string; overdue: string; partners: bigint }[]>`
      SELECT coalesce(sum(amount_total - paid_amount), 0) AS total,
             coalesce(sum(amount_total - paid_amount)
                      FILTER (WHERE payment_due_date IS NOT NULL
                                AND payment_due_date < current_date), 0) AS overdue,
             count(DISTINCT partner_id)::bigint AS partners
        FROM sales_order
       WHERE paid_amount < amount_total
         AND status <> 'cancelled'
    `;
    const r = rows[0]!;
    return { total: money(r.total), overdue: money(r.overdue), partners: Number(r.partners) };
  }

  /**
   * Дебиторка по покупателям.
   *
   * Долг берётся из заказов, а не из сальдо счёта 4010: на экране нужно
   * видеть, кто должен и с какого срока, а сальдо счёта этого не знает —
   * оно одно на всех.
   */
  async receivables(params: { overdueOnly: boolean; limit: number }) {
    return this.prisma.withTenant(async (tx) => {
      // Выражения долга и просрочки — общие с карточкой клиента
      // (`finance/receivables.ts`): второй счёт тех же денег разошёлся бы.
      const rows = await tx.$queryRawUnsafe<
        {
          uid: string;
          name_ru: string;
          name_uz: string;
          debt_limit: string;
          payment_delay_days: number;
          orders: bigint;
          debt: string;
          overdue: string;
          oldest_due: Date | null;
          max_overdue_days: number | null;
        }[]
      >(
        `SELECT p.uid, p.name_ru, p.name_uz, p.debt_limit, p.payment_delay_days,
                count(o.id)::bigint       AS orders,
                ${DEBT_EXPR}              AS debt,
                ${OVERDUE_EXPR}           AS overdue,
                ${OLDEST_DUE_EXPR}        AS oldest_due,
                ${MAX_OVERDUE_DAYS_EXPR}  AS max_overdue_days
           FROM sales_order o
           JOIN partner p ON p.id = o.partner_id
          WHERE ${UNPAID_ORDERS_WHERE}
          GROUP BY p.uid, p.name_ru, p.name_uz, p.debt_limit, p.payment_delay_days
         HAVING ${DEBT_EXPR} > 0
            AND (NOT $1::boolean OR ${OVERDUE_EXPR} > 0)
          ORDER BY debt DESC
          LIMIT $2::int`,
        params.overdueOnly,
        params.limit,
      );

      const rowsOut = rows.map((r) => ({
        partner: { uid: r.uid, nameRu: r.name_ru, nameUz: r.name_uz },
        orders: Number(r.orders),
        debt: money(r.debt),
        overdue: money(r.overdue),
        debtLimit: money(r.debt_limit),
        // Лимит превышен — отдельный признак, а не «долг больше нуля»:
        // отгружать дальше нельзя именно по нему.
        overLimit: Number(r.debt_limit) > 0 && Number(r.debt) > Number(r.debt_limit),
        paymentDelayDays: r.payment_delay_days,
        oldestDueDate: day(r.oldest_due),
        maxOverdueDays: r.max_overdue_days ?? 0,
      }));

      const sum = (get: (r: (typeof rowsOut)[number]) => string) =>
        money(rowsOut.reduce((s, r) => s + Number(get(r)), 0));

      return {
        rows: rowsOut,
        // Итог считается по тем же строкам, что показаны: отдельный запрос
        // дал бы другую сумму, как только появится лимит выдачи.
        totals: { debt: sum((r) => r.debt), overdue: sum((r) => r.overdue) },
      };
    });
  }

  /**
   * План-факт по бюджетам.
   *
   * Фактом считается только проведённое: заявка на оплату — это намерение, и
   * показывать её расходом значит завысить факт на то, что могут отклонить.
   * Окно `from`/`to` отбирает бюджеты, чьи периоды его задевают; факт по
   * каждому считается внутри его собственного периода, иначе строка сравнивала
   * бы план квартала с фактом недели.
   */
  async planFact(params: { from?: string; to?: string }) {
    return this.prisma.withTenant(async (tx) => {
      // Строка на бюджет, а не на статью. Прежде запрос группировал по
      // названию статьи, а названия в компаниях совпадают — план «Торгового
      // дома» и «Завода» складывались в одну строку, и чей это план, экран
      // сказать не мог. Заодно без строки на бюджет его нечем адресовать:
      // править и удалять было бы нечего.
      const rows = await tx.$queryRaw<
        {
          uid: string;
          company_uid: string;
          company_code: string;
          name_ru: string;
          name_uz: string;
          activity: string;
          department_uid: string | null;
          department_ru: string | null;
          department_uz: string | null;
          responsible_uid: string | null;
          responsible_name: string | null;
          threshold: string;
          period_start: Date;
          period_end: Date;
          plan: string;
          fact: string;
          ops: bigint;
        }[]
      >`
        SELECT b.uid, co.uid AS company_uid, co.code AS company_code,
               c.name_ru, c.name_uz, c.activity::text AS activity,
               d.uid AS department_uid, d.name_ru AS department_ru, d.name_uz AS department_uz,
               u.uid AS responsible_uid, u.full_name AS responsible_name,
               b.threshold_warn_percent::text AS threshold,
               b.period_start, b.period_end,
               b.amount_planned                        AS plan,
               coalesce(f.fact, 0)                     AS fact,
               coalesce(f.ops, 0)::bigint              AS ops
          FROM budget b
          JOIN cashflow_item c ON c.id = b.cashflow_item_id
          JOIN company co ON co.id = b.company_id
          LEFT JOIN department d ON d.id = b.department_id
          LEFT JOIN user_account u ON u.id = b.responsible_id
          LEFT JOIN LATERAL (
            SELECT coalesce(sum(o.amount_base), 0) AS fact, count(*)::bigint AS ops
              FROM finance_operation o
             WHERE o.cashflow_item_id = b.cashflow_item_id
               AND o.company_id = b.company_id
               AND o.status = 'posted'
               AND o.occurred_at::date BETWEEN b.period_start AND b.period_end
          ) f ON true
         WHERE (${params.from ?? null}::date IS NULL OR b.period_end   >= ${params.from ?? null}::date)
           AND (${params.to ?? null}::date   IS NULL OR b.period_start <= ${params.to ?? null}::date)
         ORDER BY b.amount_planned DESC
      `;

      const out = rows.map((r) => {
        const plan = Number(r.plan);
        const fact = Number(r.fact);
        const threshold = Number(r.threshold);
        return {
          uid: r.uid,
          company: { uid: r.company_uid, code: r.company_code },
          itemName: r.name_ru,
          itemNameUz: r.name_uz,
          activity: r.activity,
          department: r.department_uid
            ? { uid: r.department_uid, nameRu: r.department_ru!, nameUz: r.department_uz! }
            : null,
          responsible: r.responsible_uid
            ? { uid: r.responsible_uid, fullName: r.responsible_name! }
            : null,
          periodStart: day(r.period_start),
          periodEnd: day(r.period_end),
          period: BudgetsService.periodLabel(r.period_start, r.period_end),
          plan: money(plan),
          fact: money(fact),
          // Минус — перерасход. Знак важнее модуля: по нему красится строка.
          deviation: money(plan - fact),
          usedPercent: plan === 0 ? null : ((fact / plan) * 100).toFixed(1),
          thresholdWarnPercent: threshold.toFixed(0),
          // ТЗ 6.6: порог срабатывания настраивается. Сам план — это 100 %,
          // порог — предупреждение до него. Состояние считает сервер: иначе
          // каждый экран решал бы по-своему, с какого процента краснеть.
          status:
            plan === 0
              ? 'ok'
              : fact > plan
                ? 'over'
                : fact >= (plan * threshold) / 100
                  ? 'warn'
                  : 'ok',
          ops: Number(r.ops),
        };
      });

      const total = (get: (r: (typeof out)[number]) => string) =>
        out.reduce((s, r) => s + Number(get(r)), 0);
      const plan = total((r) => r.plan);
      const fact = total((r) => r.fact);

      return {
        // Состав колонок отдаёт сервер: фронт рисует таблицу, не зашивая его
        // в код, — так отчёт можно расширить, не пересобирая экран.
        columns: [
          { key: 'itemName', titleRu: 'Статья', titleUz: 'Modda', type: 'string' },
          { key: 'plan', titleRu: 'План', titleUz: 'Reja', type: 'money', align: 'right' },
          { key: 'fact', titleRu: 'Факт', titleUz: 'Fakt', type: 'money', align: 'right' },
          {
            key: 'deviation',
            titleRu: 'Отклонение',
            titleUz: 'Chetlanish',
            type: 'money',
            align: 'right',
            colorBySign: true,
          },
        ],
        rows: out,
        totals: {
          plan: money(plan),
          fact: money(fact),
          deviation: money(plan - fact),
          // Сколько бюджетов уже за порогом и сколько перерасходовано: подвал
          // экрана должен называть это числом, а не предлагать считать глазами.
          warn: out.filter((r) => r.status === 'warn').length,
          over: out.filter((r) => r.status === 'over').length,
        },
      };
    });
  }
}
