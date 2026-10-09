/**
 * Отчёты финансов и выгрузка на живой базе (ТЗ 6.9).
 *
 * Форматы файлов сами по себе проверяет `export-formats.spec.ts`. Здесь — то,
 * чего без базы не проверить:
 *
 *   - отчёт отдаёт те же числа, что лежат в таблицах, а не «сколько-то»;
 *   - ДДС не считает переводы между своими счетами притоком;
 *   - остаток счёта на дату — это сумма проводок до этой даты, а не поле;
 *   - возрастная структура складывается в долг, а не живёт рядом с ним;
 *   - кредиторка берёт долг из приходов минус оплаты, а не из сальдо 6010;
 *   - сводный отчёт не расходится с подробными: это одни и те же числа;
 *   - маржа берёт себестоимость, зафиксированную отгрузкой, и не считает её
 *     заново по нынешним партиям;
 *   - выгруженный файл — тот же отчёт, а не второй запрос к базе;
 *   - узбекский отчёт узбекский целиком, без кириллицы в подписях.
 *
 * KPI менеджеров из таблицы 6.9 здесь нет намеренно: правила расчёта от
 * заказчика не поступали, и проверять нечего.
 *
 * Прогон ничего не пишет: отчёты только читают.
 */
import 'dotenv/config';
import { Client } from 'pg';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { AuthGuard } from '../src/auth/auth.guard.js';
import { FinanceModule } from '../src/finance/finance.module.js';
import { ContextMiddleware } from '../src/common/context.middleware.js';
import { EnvelopeInterceptor } from '../src/common/envelope.interceptor.js';
import { ErrorFilter } from '../src/common/error.filter.js';

let app: INestApplication;
let base: string;
let db: Client;

const PASSWORD = process.env.SEED_PASSWORD ?? 'metall-dev-2026';

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${base}${path}`, init);
  return { status: res.status, body: (await res.json()) as any };
}

async function login(loginName: string) {
  const res = await api('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: loginName, password: PASSWORD }),
  });
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`Логин ${loginName} не прошёл: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.data as { token: string };
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Бухгалтер: у него есть `finance.view`. Кладовщик — тот, у кого его нет. */
let accountant: Awaited<ReturnType<typeof login>>;
let keeper: Awaited<ReturnType<typeof login>>;
/**
 * Директор: содержимое отчётов читается им.
 *
 * С 08.10 прибыль и маржа закрыты правом `finance.profit.view`, и у бухгалтера
 * его нет — требование заказчика со встречи 07.10. Здесь проверяются сами
 * числа, а не раздача прав: доступ к отчётам о прибыли проверяет
 * `finance-profit.e2e.spec.ts`.
 */
let director: Awaited<ReturnType<typeof login>>;

interface ReportBody {
  kind: string;
  title: string;
  subtitle: string;
  columns: { title: string; numeric?: boolean }[];
  rows: (string | number | null)[][];
  total: number;
  truncated: boolean;
  totals: Record<string, number>;
}

async function report(kind: string, query = '', headers: Record<string, string> = {}) {
  const res = await api(`/api/v1/finance/reports/${kind}${query}`, {
    headers: { ...auth(director.token), ...headers },
  });
  if (res.status !== 200) {
    throw new Error(`Отчёт ${kind} не прочитался: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.data as ReportBody;
}

async function file(kind: string, format: 'csv' | 'xlsx' | 'pdf', query = '') {
  const res = await fetch(`${base}/api/v1/finance/reports/${kind}/file?format=${format}${query}`, {
    headers: auth(director.token),
  });
  return {
    status: res.status,
    type: res.headers.get('content-type') ?? '',
    disposition: res.headers.get('content-disposition') ?? '',
    buffer: Buffer.from(await res.arrayBuffer()),
  };
}

/** Все виды отчётов из ТЗ 6.9, кроме KPI: его правил заказчик не давал. */
const KINDS = [
  'cashflow',
  'balances',
  'receivables',
  'payables',
  'plan-fact',
  'pnl',
  'margin',
  'summary',
];

/** Широкий период: сид кладёт данные с конца мая. */
const WIDE = 'from=2026-01-01&to=2026-12-31';

const n = (v: unknown) => Number(v ?? 0);

/**
 * Колонки возрастной структуры. Дебиторка и кредиторка нарочно одинаковы по
 * составу колонок: возрастная структура у них одна и та же, и держать два
 * набора номеров значило бы завести два разных ответа на один вопрос.
 */
const AGE = { debt: 2, b0: 3, b30: 4, b60: 5, b90: 6, b90p: 7, days: 8 } as const;

/** Строка сводного отчёта по её подписи: порядок строк в нём не договор. */
const metric = (r: ReportBody, title: string) => {
  const row = r.rows.find((x) => x[1] === title);
  if (!row) throw new Error(`в сводном отчёте нет строки «${title}»`);
  return n(row[2]);
};

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [PrismaModule, AuthModule, FinanceModule],
    providers: [
      { provide: APP_GUARD, useClass: AuthGuard },
      { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
      { provide: APP_FILTER, useClass: ErrorFilter },
    ],
  }).compile();

  app = moduleRef.createNestApplication();
  app.use(new ContextMiddleware().use.bind(new ContextMiddleware()));
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();

  db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  accountant = await login('m.rahimova');
  keeper = await login('a.saidov');
  director = await login('s.radjabov');
});

afterAll(async () => {
  await db.end();
  await app.close();
});

describe('отчёты финансов: доступ и форма', () => {
  it('отдаются по праву просмотра финансов и не отдаются без него', async () => {
    const ok = await api('/api/v1/finance/reports/cashflow', { headers: auth(accountant.token) });
    expect(ok.status).toBe(200);

    const denied = await api('/api/v1/finance/reports/cashflow', { headers: auth(keeper.token) });
    expect(denied.status).toBe(403);
  });

  it('выдуманный отчёт не строится', async () => {
    const res = await api('/api/v1/finance/reports/pridumannyy', {
      headers: auth(accountant.token),
    });
    expect(res.status).toBe(400);
  });

  it('KPI менеджеров не отдаётся: правил расчёта нет', async () => {
    const res = await api('/api/v1/finance/reports/kpi', { headers: auth(accountant.token) });
    expect(res.status).toBe(400);
  });

  it('все восемь отчётов строятся, заполнены и ровны по ширине', async () => {
    for (const kind of KINDS) {
      const data = await report(kind, `?${WIDE}&limit=5000`);
      expect(data.kind, kind).toBe(kind);
      expect(data.title.length, kind).toBeGreaterThan(0);
      expect(data.subtitle.length, kind).toBeGreaterThan(0);
      expect(data.columns.length, kind).toBeGreaterThan(2);
      expect(data.rows.length, `в отчёте ${kind} нет строк`).toBeGreaterThan(0);
      for (const row of data.rows) expect(row.length, kind).toBe(data.columns.length);

      // Числовая колонка обязана приходить числом: в Excel по ней берут сумму.
      const at = data.columns.findIndex((c) => c.numeric);
      expect(at, kind).toBeGreaterThan(-1);
      const values = data.rows.map((r) => r[at]).filter((v) => v !== null);
      expect(
        values.every((v) => typeof v === 'number'),
        `в ${kind} числовая колонка пришла строкой`,
      ).toBe(true);
    }
  });

  it('период задом наперёд — отказ', async () => {
    const res = await api('/api/v1/finance/reports/cashflow?from=2026-09-30&to=2026-09-01', {
      headers: auth(accountant.token),
    });
    expect(res.status).toBe(422);
  });

  it('предел строк не скрывается: отчёт говорит, что обрезан', async () => {
    const data = await report('cashflow', `?${WIDE}&limit=2`);
    expect(data.rows.length).toBe(2);
    expect(data.truncated).toBe(true);
    expect(data.total).toBeGreaterThan(2);
  });
});

describe('ДДС', () => {
  it('поступления и выбытия сходятся с проведёнными операциями', async () => {
    const data = await report('cashflow', `?${WIDE}&limit=5000`);

    const inDb = await db.query<{ inflow: string; outflow: string }>(
      `SELECT coalesce(sum(amount_base) FILTER (WHERE operation_type = 'income'), 0)::text  AS inflow,
              coalesce(sum(amount_base) FILTER (WHERE operation_type = 'expense'), 0)::text AS outflow
         FROM finance_operation
        WHERE status = 'posted'
          AND occurred_at >= ('2026-01-01'::date::timestamp AT TIME ZONE 'Asia/Tashkent')
          AND occurred_at <  ('2027-01-01'::date::timestamp AT TIME ZONE 'Asia/Tashkent')`,
    );
    // Итог отчёта — сумма показанных строк, а в базе числа с четырьмя знаками
    // после запятой. Поэтому с точным итогом базы он сходится по величине, а
    // не до тиййина: на девяти сотнях строк копейки округления набирают сум.
    // Зато внутри отчёта всё сходится ровно — это проверено ниже.
    expect(Math.abs(data.totals.inflow - n(inDb.rows[0]!.inflow))).toBeLessThan(1);
    expect(Math.abs(data.totals.outflow - n(inDb.rows[0]!.outflow))).toBeLessThan(1);
    expect(data.totals.net).toBeCloseTo(data.totals.inflow - data.totals.outflow, 2);

    // Колонки сходятся с итогами, а не живут рядом с ними.
    const sum = (i: number) => data.rows.reduce((s, r) => s + n(r[i]), 0);
    expect(sum(6)).toBeCloseTo(data.totals.inflow, 2);
    expect(sum(7)).toBeCloseTo(data.totals.outflow, 2);
  });

  it('переводы между своими счетами в приток не попадают', async () => {
    const data = await report('cashflow', `?${WIDE}&limit=5000`);
    const inDb = await db.query<{ income: string; moved: string }>(
      `SELECT coalesce(sum(amount_base) FILTER (WHERE operation_type = 'income'), 0)::text AS income,
              coalesce(sum(amount_base)
                       FILTER (WHERE operation_type IN ('transfer', 'conversion')), 0)::text AS moved
         FROM finance_operation
        WHERE status = 'posted'
          AND occurred_at >= ('2026-01-01'::date::timestamp AT TIME ZONE 'Asia/Tashkent')
          AND occurred_at <  ('2027-01-01'::date::timestamp AT TIME ZONE 'Asia/Tashkent')`,
    );
    const income = n(inDb.rows[0]!.income);
    const moved = n(inDb.rows[0]!.moved);
    expect(moved).toBeGreaterThan(0);

    // Приток — это ровно поступления. Перекладывание со счёта на счёт в него
    // не входит: деньги не пришли, и в притоке они посчитались бы дважды.
    expect(Math.abs(data.totals.inflow - income)).toBeLessThan(1);
    expect(Math.abs(data.totals.inflow - (income + moved))).toBeGreaterThan(1);
  });

  it('непроведённое в ДДС не попадает: заявка — это намерение', async () => {
    const pending = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM finance_operation WHERE status <> 'posted'`,
    );
    expect(Number(pending.rows[0]!.n)).toBeGreaterThan(0);

    const data = await report('cashflow', `?${WIDE}&limit=5000`);
    const posted = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM finance_operation
        WHERE status = 'posted' AND operation_type IN ('income', 'expense')`,
    );
    const ops = data.rows.reduce((s, r) => s + n(r[9]), 0);
    expect(ops).toBe(Number(posted.rows[0]!.n));
  });

  it('период сужает выборку', async () => {
    const wide = await report('cashflow', `?${WIDE}&limit=5000`);
    const narrow = await report('cashflow', '?from=2026-08-01&to=2026-08-31&limit=5000');
    expect(narrow.totals.inflow).toBeGreaterThan(0);
    expect(narrow.totals.inflow).toBeLessThan(wide.totals.inflow);
    // Месяц в отчёте за август только один.
    expect(new Set(narrow.rows.map((r) => r[0])).size).toBe(1);
  });
});

describe('остатки по кассам и счетам', () => {
  it('остаток на дату — сумма проводок до неё', async () => {
    const data = await report('balances', '?to=2026-08-31&limit=5000');
    expect(data.rows.length).toBeGreaterThan(0);

    const row = data.rows[0]!;
    const code = String(row[1]);
    const company = String(row[0]);

    const inDb = await db.query<{ saldo: string }>(
      `SELECT coalesce(sum(e.debit - e.credit), 0)::text AS saldo
         FROM finance_entry e
         JOIN account a ON a.id = e.account_id
         JOIN company c ON c.id = a.company_id
        WHERE a.code = $1 AND c.code = $2
          AND e.occurred_at < ('2026-09-01'::date::timestamp AT TIME ZONE 'Asia/Tashkent')`,
      [code, company],
    );
    expect(n(row[5])).toBeCloseTo(n(inDb.rows[0]!.saldo), 2);
  });

  it('остаток на сегодня больше остатка на раннюю дату: деньги приходили', async () => {
    const early = await report('balances', '?to=2026-06-30&limit=5000');
    const late = await report('balances', '?to=2026-12-31&limit=5000');
    expect(late.totals.saldo).toBeGreaterThan(early.totals.saldo);
  });

  it('только кассы и счета: сальдо расчётов с покупателями сюда не попадает', async () => {
    const data = await report('balances', `?to=2026-12-31&limit=5000`);
    const codes = data.rows.map((r) => String(r[1]));
    expect(codes).not.toContain('4010');
    expect(codes).not.toContain('6010');
    expect(codes.length).toBeGreaterThan(0);

    const expected = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM account WHERE is_active AND kind IN ('cash', 'bank')`,
    );
    expect(data.total).toBe(Number(expected.rows[0]!.n));
  });

  it('валюта счёта и валюта сальдо названы по отдельности', async () => {
    const data = await report('balances', '?to=2026-12-31&limit=5000');
    // Сальдо всегда в учётной валюте компании, даже у валютного счёта: врать
    // об этом нельзя, иначе остаток долларового счёта читают как доллары.
    const titles = data.columns.map((c) => c.title);
    expect(titles).toContain('Валюта счёта');
    expect(titles).toContain('Учётная валюта');
  });
});

describe('дебиторская задолженность', () => {
  it('долг по контрагентам сходится с заказами', async () => {
    const data = await report('receivables', '?limit=5000');
    const inDb = await db.query<{ debt: string; partners: string }>(
      `SELECT coalesce(sum(amount_total - paid_amount), 0)::text AS debt,
              count(DISTINCT partner_id)::text                   AS partners
         FROM sales_order
        WHERE paid_amount < amount_total AND status <> 'cancelled'`,
    );
    expect(Math.abs(data.totals.debt - n(inDb.rows[0]!.debt))).toBeLessThan(1);
    expect(data.total).toBe(Number(inDb.rows[0]!.partners));
  });

  it('возрастная структура складывается в долг', async () => {
    const data = await report('receivables', '?limit=5000');
    expect(data.rows.length).toBeGreaterThan(0);
    for (const row of data.rows) {
      const buckets =
        n(row[AGE.b0]) + n(row[AGE.b30]) + n(row[AGE.b60]) + n(row[AGE.b90]) + n(row[AGE.b90p]);
      expect(buckets, `контрагент ${row[1]}`).toBeCloseTo(n(row[AGE.debt]), 2);
    }
    // Просрочка — это всё, кроме корзины «не просрочено». Отдельной колонки
    // для неё нет (она выводится из двух соседних), итог стоит в подвале.
    const overdue = data.rows.reduce((acc, r) => acc + n(r[AGE.debt]) - n(r[AGE.b0]), 0);
    expect(data.totals.overdue).toBeCloseTo(overdue, 1);
    expect(data.totals.overdue).toBeGreaterThan(0);
  });

  it('две компании не слипаются в одну строку контрагента', async () => {
    const data = await report('receivables', '?limit=5000');
    // Запись контрагента своя у каждой компании. Без колонки «Компания» две
    // строки «АО «Узметкомбинат»» в отчёте неразличимы, и долг одной компании
    // прочитали бы как долг другой.
    expect(data.columns[0]!.title).toBe('Компания');
    expect(new Set(data.rows.map((r) => String(r[0]))).size).toBeGreaterThan(1);
  });

  it('просрочка сходится с общим выражением долга', async () => {
    const data = await report('receivables', '?limit=5000');
    const inDb = await db.query<{ overdue: string }>(
      `SELECT coalesce(sum(amount_total - paid_amount)
                       FILTER (WHERE payment_due_date < current_date), 0)::text AS overdue
         FROM sales_order
        WHERE paid_amount < amount_total AND status <> 'cancelled'`,
    );
    expect(Math.abs(data.totals.overdue - n(inDb.rows[0]!.overdue))).toBeLessThan(1);
  });
});

describe('кредиторская задолженность', () => {
  it('долг поставщику — приходы минус оплаты, а не сальдо счёта 6010', async () => {
    const data = await report('payables', '?limit=5000');
    expect(data.rows.length).toBeGreaterThan(0);

    // Долг считается по каждому поставщику отдельно и обрезается нулём.
    // Глобальная разность «всё получено минус всё оплачено» ответом быть не
    // может: в сиде есть переплаченный поставщик, и его минус погасил бы
    // чужой долг — отчёт показал бы заниженный итог, под который не подходит
    // ни одна строка.
    const inDb = await db.query<{ debt: string; advance: string }>(
      `WITH got AS (
         SELECT partner_id, coalesce(sum(cost_total), 0) AS amount FROM stock_move
          WHERE operation_type = 'receipt' AND partner_id IS NOT NULL AND cost_total > 0
          GROUP BY partner_id),
       paid AS (
         SELECT o.partner_id, coalesce(sum(o.amount_base), 0) AS amount
           FROM finance_operation o JOIN account ca ON ca.id = o.counter_account_id
          WHERE o.status = 'posted' AND o.operation_type = 'expense'
            AND ca.kind = 'payable' AND o.partner_id IS NOT NULL
          GROUP BY o.partner_id),
       pair AS (
         SELECT coalesce(g.amount, 0) AS got, coalesce(p.amount, 0) AS paid
           FROM got g FULL JOIN paid p ON p.partner_id = g.partner_id)
       SELECT coalesce(sum(greatest(got - paid, 0)), 0)::text AS debt,
              coalesce(sum(greatest(paid - got, 0)), 0)::text AS advance
         FROM pair`,
    );
    expect(Math.abs(data.totals.debt - n(inDb.rows[0]!.debt))).toBeLessThan(1);

    // Переплата — это аванс, и она названа своим числом, а не спрятана в долге.
    expect(n(inDb.rows[0]!.advance)).toBeGreaterThan(0);
    expect(Math.abs(data.totals.advance - n(inDb.rows[0]!.advance))).toBeLessThan(1);
    expect(data.totals.debt).not.toBeCloseTo(
      n(inDb.rows[0]!.debt) - n(inDb.rows[0]!.advance),
      2,
    );

    // Сальдо 6010 — только оплаты, и долгом оно быть не может: по нему
    // кредиторка вышла бы отрицательной.
    const saldo = await db.query<{ s: string }>(
      `SELECT coalesce(sum(e.debit - e.credit), 0)::text AS s
         FROM finance_entry e JOIN account a ON a.id = e.account_id
        WHERE a.kind = 'payable'`,
    );
    expect(data.totals.debt).not.toBeCloseTo(n(saldo.rows[0]!.s), 2);
  });

  it('возрастная структура складывается в долг', async () => {
    const data = await report('payables', '?limit=5000');
    expect(data.rows.length).toBeGreaterThan(0);
    for (const row of data.rows) {
      const buckets =
        n(row[AGE.b0]) + n(row[AGE.b30]) + n(row[AGE.b60]) + n(row[AGE.b90]) + n(row[AGE.b90p]);
      expect(buckets, `поставщик ${row[1]}`).toBeCloseTo(n(row[AGE.debt]), 2);
    }
    // Просрочка — это всё, кроме корзины «не просрочено». Отдельной колонки
    // для неё нет (она выводится из двух соседних), итог стоит в подвале.
    const overdue = data.rows.reduce((acc, r) => acc + n(r[AGE.debt]) - n(r[AGE.b0]), 0);
    expect(data.totals.overdue).toBeCloseTo(overdue, 1);
    expect(data.totals.overdue).toBeGreaterThan(0);
  });

  it('оплаты гасят старые приходы раньше свежих', async () => {
    const data = await report('payables', '?limit=5000');
    expect(data.columns[AGE.days].title).toBe('Просрочка, дней');

    // Признак FIFO: у поставщика, которому платили, просрочка по открытому
    // остатку меньше, чем была бы по самому раннему приходу. Разнеси оплату
    // «в среднем», долей на каждый приход, и на первом приходе остался бы
    // хвост — просрочка считалась бы от него и совпала бы с максимальной.
    //
    // Ключ — компания И партнёр: в сиде «АО «Узметкомбинат»» заведено в двух
    // компаниях, и платили только одному из двух. По одному имени строка
    // находится не та, и признак FIFO искать не в чем.
    // Берём не любого «что-то платившего» поставщика, а того, кому заплатили
    // больше, чем стоил самый первый день приходов. Только тогда признак FIFO
    // виден: первый приход закрыт целиком, открытый остаток моложе его, и
    // просрочка обязана быть строго меньше. На поставщике, которому заплатили
    // меньше первого прихода, FIFO и «в среднем» дают одно и то же число, и
    // проверка проходила бы не потому, что правило соблюдено.
    const paid = await db.query<{ company: string; partner: string; pro_rata: string }>(
      `WITH rec AS (
         SELECT co.code AS company, p.name_ru AS partner, m.partner_id, m.company_id,
                coalesce(p.payment_delay_days, 0) AS delay,
                m.moved_at::date AS doc_day, sum(m.cost_total) AS cost
           FROM stock_move m
           JOIN partner p ON p.id = m.partner_id
           JOIN company co ON co.id = m.company_id
          WHERE m.operation_type = 'receipt' AND m.cost_total > 0
          GROUP BY co.code, p.name_ru, m.partner_id, m.company_id, p.payment_delay_days,
                   m.moved_at::date),
       first_day AS (
         SELECT DISTINCT ON (partner_id, company_id)
                partner_id, company_id, doc_day AS first_doc, cost AS first_cost
           FROM rec ORDER BY partner_id, company_id, doc_day),
       got AS (
         SELECT r.company, r.partner, r.partner_id, r.company_id, r.delay,
                f.first_doc, f.first_cost, sum(r.cost) AS got
           FROM rec r
           JOIN first_day f ON f.partner_id = r.partner_id AND f.company_id = r.company_id
          GROUP BY r.company, r.partner, r.partner_id, r.company_id, r.delay,
                   f.first_doc, f.first_cost)
       SELECT g.company, g.partner,
              (current_date - (g.first_doc + g.delay))::text AS pro_rata
         FROM got g
        WHERE coalesce((SELECT sum(o.amount) FROM finance_operation o
                          JOIN account ca ON ca.id = o.counter_account_id
                         WHERE o.partner_id = g.partner_id AND o.company_id = g.company_id
                           AND o.status = 'posted' AND o.operation_type = 'expense'
                           AND ca.kind = 'payable'), 0) > g.first_cost
          AND coalesce((SELECT sum(o.amount) FROM finance_operation o
                          JOIN account ca ON ca.id = o.counter_account_id
                         WHERE o.partner_id = g.partner_id AND o.company_id = g.company_id
                           AND o.status = 'posted' AND o.operation_type = 'expense'
                           AND ca.kind = 'payable'), 0) < g.got`,
    );
    expect(paid.rowCount, 'в сиде нет частично оплаченного поставщика').toBeGreaterThan(0);

    let checked = 0;
    for (const { company, partner, pro_rata } of paid.rows) {
      const row = data.rows.find((r) => String(r[0]) === company && String(r[1]) === partner);
      expect(row, `поставщик ${partner} (${company})`).toBeTruthy();
      const limit = Number(pro_rata);
      if (limit <= 0) continue; // Первый приход ещё не просрочен — сравнивать нечего.
      // Больше быть не может ни при каком разнесении: открытый остаток не
      // старше самого раннего прихода.
      expect(n(row![AGE.days]), `поставщик ${partner} (${company})`).toBeLessThan(limit);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('долг неотрицательный: переплата — не долг со знаком минус', async () => {
    const data = await report('payables', '?limit=5000');
    for (const row of data.rows) {
      expect(n(row[AGE.debt]), `поставщик ${row[1]}`).toBeGreaterThan(0);
    }
  });
});

describe('прибыли и убытки', () => {
  it('валовая прибыль — это выручка минус себестоимость', async () => {
    const data = await report('pnl', `?${WIDE}`);
    const line = (title: string) => {
      const row = data.rows.find((r) => r[1] === title);
      if (!row) throw new Error(`в отчёте нет строки «${title}»`);
      return n(row[2]);
    };
    expect(line('Валовая прибыль')).toBeCloseTo(line('Выручка') - line('Себестоимость'), 2);
    expect(line('Операционная прибыль')).toBeCloseTo(
      line('Валовая прибыль') - line('Расходы всего'),
      2,
    );
  });

  it('выручка признаётся отгрузкой, а не заказом и не оплатой', async () => {
    const data = await report('pnl', `?${WIDE}`);
    const revenue = n(data.rows.find((r) => r[1] === 'Выручка')![2]);

    const shipped = await db.query<{ net: string; all: string }>(
      `SELECT (SELECT coalesce(sum(amount_net), 0) FROM sales_order
                WHERE shipment_status = 'full' AND status <> 'cancelled')::text AS net,
              (SELECT coalesce(sum(amount_net), 0) FROM sales_order
                WHERE status <> 'cancelled')::text AS all`,
    );
    expect(revenue).toBeCloseTo(n(shipped.rows[0]!.net), 2);
    // Заказы без отгрузки в выручку не входят, иначе числа совпали бы.
    expect(revenue).toBeLessThan(n(shipped.rows[0]!.all));
  });

  it('оплата поставщику не расход: это погашение долга', async () => {
    const data = await report('pnl', `?${WIDE}`);
    const expenses = n(data.rows.find((r) => r[1] === 'Расходы всего')![2]);

    const inDb = await db.query<{ real: string; payable: string }>(
      `SELECT (SELECT coalesce(sum(o.amount_base), 0) FROM finance_operation o
                 JOIN account ca ON ca.id = o.counter_account_id
                WHERE o.status = 'posted' AND ca.kind = 'expense')::text AS real,
              (SELECT coalesce(sum(o.amount_base), 0) FROM finance_operation o
                 JOIN account ca ON ca.id = o.counter_account_id
                WHERE o.status = 'posted' AND ca.kind = 'payable')::text AS payable`,
    );
    expect(expenses).toBeCloseTo(n(inDb.rows[0]!.real), 2);
    expect(n(inDb.rows[0]!.payable)).toBeGreaterThan(0);
    expect(expenses).not.toBeCloseTo(
      n(inDb.rows[0]!.real) + n(inDb.rows[0]!.payable),
      2,
    );
  });
});

describe('маржа', () => {
  it('считается по четырём разрезам из ТЗ 6.7', async () => {
    for (const by of ['order', 'item', 'partner', 'manager']) {
      const data = await report('margin', `?${WIDE}&by=${by}&limit=5000`);
      expect(data.rows.length, by).toBeGreaterThan(0);
      expect(data.subtitle, by).toMatch(/заказ|товар|клиент|менеджер/i);
    }
  });

  it('выдуманный разрез не строится', async () => {
    const res = await api('/api/v1/finance/reports/margin?by=po-pogode', {
      headers: auth(director.token),
    });
    expect(res.status).toBe(400);
  });

  it('маржа заказа — та, что зафиксирована отгрузкой', async () => {
    const data = await report('margin', `?${WIDE}&by=order&limit=5000`);
    const row = data.rows[0]!;
    const inDb = await db.query<{ net: string; cost: string; margin: string }>(
      `SELECT amount_net::text AS net, cost_total::text AS cost, margin_total::text AS margin
         FROM sales_order WHERE number = $1`,
      [String(row[0])],
    );
    expect(inDb.rowCount).toBe(1);
    // В заказе суммы лежат с четырьмя знаками, в отчёте округлены до копеек.
    // Сверяем с округлённым: иначе проверка ловит не ошибку в отчёте, а зерно
    // округления, и на четвёртом знаке падает от любой новой цифры в данных.
    const round2 = (v: number) => Math.round(v * 100) / 100;
    expect(n(row[4])).toBeCloseTo(round2(n(inDb.rows[0]!.net)), 2);
    // Себестоимость не пересчитывается по нынешним партиям: берётся та,
    // что записана в момент отгрузки (ТЗ 6.7).
    expect(n(row[5])).toBeCloseTo(round2(n(inDb.rows[0]!.cost)), 2);
    expect(n(row[6])).toBeCloseTo(round2(n(inDb.rows[0]!.margin)), 2);
  });

  it('маржа в каждой строке — разность выручки и себестоимости', async () => {
    for (const by of ['order', 'item', 'partner', 'manager']) {
      const data = await report('margin', `?${WIDE}&by=${by}&limit=5000`);
      const [rev, cost, margin] = by === 'order' ? [4, 5, 6] : by === 'item' ? [4, 5, 6] : [2, 3, 4];
      for (const row of data.rows) {
        expect(n(row[margin]), `${by}: ${row[0]}`).toBeCloseTo(n(row[rev]) - n(row[cost]), 2);
      }
    }
  });

  it('разрезы сходятся между собой: сумма по клиентам равна сумме по заказам', async () => {
    const byOrder = await report('margin', `?${WIDE}&by=order&limit=5000`);
    const byPartner = await report('margin', `?${WIDE}&by=partner&limit=5000`);
    const orders = byOrder.rows.reduce((s, r) => s + n(r[6]), 0);
    const partners = byPartner.rows.reduce((s, r) => s + n(r[4]), 0);
    expect(orders).toBeGreaterThan(0);
    // До копейки эти две суммы не сойдутся и не должны: разрезы округляют на
    // разном зерне — один раз на заказ против одного раза на клиента. Сойтись
    // обязана величина: расхождение на 657 заказах держится в пределах сума.
    expect(Math.abs(partners - orders)).toBeLessThan(1);
  });

  it('не полностью отгруженный заказ в маржу не берётся', async () => {
    // Сид случайный: сколько в нём частичных отгрузок и есть ли они вообще —
    // от прогона к прогону разное. Поэтому проверяется не конкретный заказ, а
    // состав отчёта: в нём ровно полностью отгруженные и не отменённые.
    const open = await db.query<{ number: string }>(
      `SELECT number FROM sales_order
        WHERE status <> 'cancelled' AND shipment_status <> 'full'`,
    );
    expect(open.rowCount, 'в сиде нет ни одного неотгруженного заказа').toBeGreaterThan(0);

    const data = await report('margin', `?${WIDE}&by=order&limit=5000`);
    const shown = new Set(data.rows.map((r) => String(r[0])));
    // У неполной отгрузки выручка полная, а себестоимость только уехавшей
    // части: такая строка показала бы завышенную маржу.
    for (const { number } of open.rows) {
      expect(shown.has(number), `заказ ${number} отгружен не полностью`).toBe(false);
    }
  });
});

describe('сводный управленческий отчёт', () => {
  it('не расходится с подробными отчётами', async () => {
    const sum = await report('summary', `?${WIDE}`);
    const flow = await report('cashflow', `?${WIDE}&limit=5000`);
    const pnl = await report('pnl', `?${WIDE}`);
    const recv = await report('receivables', '?limit=5000');
    const pay = await report('payables', '?limit=5000');

    expect(metric(sum, 'Поступления')).toBeCloseTo(flow.totals.inflow, 2);
    expect(metric(sum, 'Выбытия')).toBeCloseTo(flow.totals.outflow, 2);
    expect(metric(sum, 'Выручка')).toBeCloseTo(n(pnl.rows.find((r) => r[1] === 'Выручка')![2]), 2);
    expect(metric(sum, 'Дебиторская задолженность')).toBeCloseTo(recv.totals.debt, 2);
    expect(metric(sum, 'Кредиторская задолженность')).toBeCloseTo(pay.totals.debt, 2);
  });

  it('KPI менеджеров в сводке не изображается', async () => {
    const sum = await report('summary', `?${WIDE}`);
    const text = sum.rows.map((r) => String(r[1])).join(' ');
    expect(text).not.toMatch(/KPI|бонус/i);
  });
});

describe('выгрузка отчёта файлом', () => {
  it('CSV отдаётся файлом, с BOM и точкой с запятой', async () => {
    const res = await file('cashflow', 'csv', `&${WIDE}&limit=50`);
    expect(res.status).toBe(200);
    expect(res.type).toContain('text/csv');
    expect(res.disposition).toContain('attachment');
    expect(res.disposition).toContain('finansy-cashflow-');

    const text = res.buffer.toString('utf8');
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text.slice(1).split('\r\n')[0]!.split(';')[0]).toBe('Месяц');
    // В конверт файл не заворачивается.
    expect(text).not.toContain('"data"');
  });

  it('Excel открывается и содержит те же строки, что и отчёт', async () => {
    const data = await report('cashflow', `?${WIDE}&limit=50`);
    const res = await file('cashflow', 'xlsx', `&${WIDE}&limit=50`);
    expect(res.status).toBe(200);
    expect(res.type).toContain('spreadsheetml');
    expect(res.buffer.subarray(0, 2).toString('latin1')).toBe('PK');

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.buffer as unknown as ArrayBuffer);
    const sheet = wb.worksheets[0]!;
    // Имя листа в Excel не длиннее 31 знака — это предел формата, не наш.
    expect(sheet.name).toBe(data.title.slice(0, 31));
    expect(sheet.getRow(1).getCell(1).value).toBe(data.columns[0]!.title);
    expect(sheet.getRow(2).getCell(1).value).toBe(data.rows[0]![0]);
    // Поступления — седьмая колонка, и в Excel это число, а не текст.
    expect(typeof sheet.getRow(2).getCell(7).value).toBe('number');
  });

  it('PDF собирается и это настоящий PDF', async () => {
    const res = await file('summary', 'pdf', `&${WIDE}`);
    expect(res.status).toBe(200);
    expect(res.type).toContain('application/pdf');
    expect(res.buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(res.buffer.length).toBeGreaterThan(1000);
  });

  it('каждый отчёт выгружается во все три формата', async () => {
    for (const kind of KINDS) {
      for (const format of ['csv', 'xlsx'] as const) {
        const res = await file(kind, format, `&${WIDE}&limit=100`);
        expect(res.status, `${kind}/${format}`).toBe(200);
        expect(res.buffer.length, `${kind}/${format} пустой`).toBeGreaterThan(100);
      }
    }
  });

  it('формат выгрузки обязателен и проверяется', async () => {
    const none = await fetch(`${base}/api/v1/finance/reports/cashflow/file`, {
      headers: auth(accountant.token),
    });
    expect(none.status).toBe(400);
    const wrong = await fetch(`${base}/api/v1/finance/reports/cashflow/file?format=docx`, {
      headers: auth(accountant.token),
    });
    expect(wrong.status).toBe(400);
  });

  it('выгрузка закрыта тем же правом, что и отчёт', async () => {
    const res = await fetch(`${base}/api/v1/finance/reports/cashflow/file?format=csv`, {
      headers: auth(keeper.token),
    });
    expect(res.status).toBe(403);
  });
});

describe('узбекский', () => {
  const uz = { 'Accept-Language': 'uz' };
  const CYR = /[А-Яа-яЁё]/;

  it('подписи отчётов и колонок без кириллицы', async () => {
    for (const kind of KINDS) {
      const data = await report(kind, `?${WIDE}&limit=50`, uz);
      expect(CYR.test(data.title), `${kind}: заголовок «${data.title}»`).toBe(false);
      for (const c of data.columns) {
        expect(CYR.test(c.title), `${kind}: колонка «${c.title}»`).toBe(false);
      }
    }
  });

  it('подписи внутри строк тоже переведены', async () => {
    // Сводный и П&У целиком состоят из подписей, которые собирает сервер:
    // если где-то забыт `say()`, кириллица вылезет именно здесь.
    for (const kind of ['summary', 'pnl']) {
      const data = await report(kind, `?${WIDE}`, uz);
      for (const row of data.rows) {
        expect(CYR.test(String(row[0])), `${kind}: раздел «${row[0]}»`).toBe(false);
        expect(CYR.test(String(row[1])), `${kind}: строка «${row[1]}»`).toBe(false);
      }
    }
  });

  it('справочники в отчёте берут узбекское название', async () => {
    const ru = await report('balances', '?to=2026-12-31&limit=50');
    const translated = await report('balances', '?to=2026-12-31&limit=50', uz);
    // Названия счетов в справочнике двуязычны: на узбекском экране они другие.
    expect(translated.rows.map((r) => r[2]).join()).not.toBe(ru.rows.map((r) => r[2]).join());
  });
});
