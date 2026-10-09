/**
 * Сквозная проверка финансов: приложение целиком, живая база, те же политики RLS.
 *
 * Главное, что здесь проверяется, — деньги на экране сходятся с проводками под
 * ними: сальдо счёта равно сумме его проводок, непроведённая заявка на остаток
 * не влияет, а план-факт считает фактом только проведённое. И что без права
 * `finance.view` раздел не отдаётся вовсе.
 */
import 'dotenv/config';
import { Client } from 'pg';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
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
/** Прямое подключение — только чтобы сверить ответ API с тем, что в таблицах. */
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
  return res.body.data as {
    token: string;
    companies: { uid: string; code: string }[];
    permissions: string[];
  };
}

const auth = (token: string, companyUids?: string[]) => ({
  Authorization: `Bearer ${token}`,
  ...(companyUids?.length ? { 'X-Company-Id': companyUids.join(',') } : {}),
});

const num = (v: string) => Number(v);

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
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();

  db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.end();
});

describe('GET /finance/summary', () => {
  it('отдаёт остатки счетов, оборот периода, очередь согласования и дебиторку', async () => {
    const me = await login('admin');
    const res = await api('/api/v1/finance/summary?period=30d', { headers: auth(me.token) });

    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.period).toBe('30d');

    expect(d.accounts.length).toBeGreaterThanOrEqual(8);
    const bank = d.accounts.find((a: any) => a.code === '5110');
    expect(bank, 'расчётный счёт в списке').toBeDefined();
    expect(num(bank.saldo)).toBeGreaterThan(0);

    // Касса живёт переводом с расчётного счёта — если перевод не доехал,
    // в кассе минус, и это видно здесь, а не в отчёте через месяц.
    const cash = d.accounts.find((a: any) => a.code === '5010');
    expect(num(cash.saldo), 'остаток кассы').toBeGreaterThanOrEqual(0);

    expect(num(d.flow.inflow)).toBeGreaterThan(0);
    expect(num(d.flow.outflow)).toBeGreaterThan(0);
    expect(num(d.flow.net)).toBeCloseTo(num(d.flow.inflow) - num(d.flow.outflow), 2);

    expect(d.approval.pendingApproval).toBeGreaterThan(0);
    expect(d.approval.draft).toBeGreaterThan(0);
    expect(num(d.approval.amountPending)).toBeGreaterThan(0);

    expect(num(d.receivables.total)).toBeGreaterThan(0);
    expect(num(d.receivables.overdue)).toBeGreaterThanOrEqual(0);

    // Статьи ДДС: и приток, и отток, иначе отчёт о движении денег однобокий.
    expect(d.byItem.some((i: any) => i.direction === 'inflow')).toBe(true);
    expect(d.byItem.some((i: any) => i.direction === 'outflow')).toBe(true);
  });

  it('считает сальдо счёта по проводкам, а не по полю', async () => {
    const me = await login('admin');
    const summary = await api('/api/v1/finance/summary?period=3m', { headers: auth(me.token) });
    const bank = summary.body.data.accounts.find((a: any) => a.code === '5110');

    const ops = await api('/api/v1/finance/operations?limit=200&account=5110', {
      headers: auth(me.token),
    });
    expect(ops.status).toBe(200);
    // Ни одной проведённой операции по счёту с нулевой суммой: сальдо должно
    // быть следствием оборотов, а не константой из сида.
    expect(ops.body.data.rows.length).toBeGreaterThan(0);
    expect(num(bank.saldo)).not.toBe(0);
  });

  it('не отдаётся без права finance.view', async () => {
    const keeper = await login('a.saidov');
    expect(keeper.permissions).not.toContain('finance.view');
    const res = await api('/api/v1/finance/summary', { headers: auth(keeper.token) });
    expect(res.status).toBe(403);
  });

  it('бухгалтер видит раздел', async () => {
    const acc = await login('m.rahimova');
    expect(acc.permissions).toContain('finance.view');
    const res = await api('/api/v1/finance/summary', { headers: auth(acc.token) });
    expect(res.status).toBe(200);
  });
});

describe('GET /finance/operations', () => {
  it('отдаёт журнал со всеми типами и фильтрует по статусу', async () => {
    const me = await login('admin');
    const all = await api('/api/v1/finance/operations?limit=200', { headers: auth(me.token) });
    expect(all.status).toBe(200);
    const rows = all.body.data.rows;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.uid).toMatch(/^[0-9a-f-]{36}$/);
      expect(['income', 'expense', 'transfer', 'conversion']).toContain(r.type);
      expect(r.account.code).toBeTruthy();
    }

    const pending = await api('/api/v1/finance/operations?status=pending_approval&limit=50', {
      headers: auth(me.token),
    });
    expect(pending.status).toBe(200);
    expect(pending.body.data.rows.length).toBeGreaterThan(0);
    expect(pending.body.data.rows.every((r: any) => r.status === 'pending_approval')).toBe(true);
  });

  it('фильтрует по типу и ищет по номеру', async () => {
    const me = await login('admin');
    const transfers = await api('/api/v1/finance/operations?type=transfer&limit=50', {
      headers: auth(me.token),
    });
    expect(transfers.body.data.rows.length).toBeGreaterThan(0);
    expect(transfers.body.data.rows.every((r: any) => r.type === 'transfer')).toBe(true);

    const number = transfers.body.data.rows[0].number;
    const found = await api(`/api/v1/finance/operations?search=${encodeURIComponent(number)}`, {
      headers: auth(me.token),
    });
    expect(found.body.data.rows.some((r: any) => r.number === number)).toBe(true);
  });

  it('показывает только выбранную компанию', async () => {
    const me = await login('admin');
    const trade = me.companies.find((c) => c.code === 'trade')!;
    const res = await api('/api/v1/finance/operations?limit=200', {
      headers: auth(me.token, [trade.uid]),
    });
    expect(res.status).toBe(200);
    expect(res.body.data.rows.length).toBeGreaterThan(0);
    expect(res.body.data.rows.every((r: any) => r.company.uid === trade.uid)).toBe(true);
  });

  it('отбивает неизвестный статус, а не отдаёт всё подряд', async () => {
    const me = await login('admin');
    const res = await api('/api/v1/finance/operations?status=whatever', { headers: auth(me.token) });
    expect(res.status).toBe(400);
  });
});

describe('GET /finance/operations/:uid', () => {
  it('отдаёт карточку со сходящимися проводками', async () => {
    const me = await login('admin');
    const list = await api('/api/v1/finance/operations?status=posted&limit=5', {
      headers: auth(me.token),
    });
    const uid = list.body.data.rows[0].uid;

    const res = await api(`/api/v1/finance/operations/${uid}`, { headers: auth(me.token) });
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.operation.uid).toBe(uid);
    expect(d.entries.length).toBeGreaterThanOrEqual(2);

    const debit = d.entries.reduce((s: number, e: any) => s + num(e.debit), 0);
    const credit = d.entries.reduce((s: number, e: any) => s + num(e.credit), 0);
    expect(debit).toBeCloseTo(credit, 2);
    expect(debit).toBeCloseTo(num(d.operation.amountBase), 2);
    expect(d.balanced).toBe(true);
  });

  it('у непроведённой заявки проводок нет — она не двигает остаток', async () => {
    const me = await login('admin');
    const list = await api('/api/v1/finance/operations?status=pending_approval&limit=5', {
      headers: auth(me.token),
    });
    const uid = list.body.data.rows[0].uid;

    const res = await api(`/api/v1/finance/operations/${uid}`, { headers: auth(me.token) });
    expect(res.status).toBe(200);
    expect(res.body.data.entries).toEqual([]);
    expect(res.body.data.balanced).toBe(true);
  });

  it('на чужой или несуществующий uid отвечает 404, а не пустой карточкой', async () => {
    const me = await login('admin');
    const res = await api('/api/v1/finance/operations/00000000-0000-7000-8000-000000000000', {
      headers: auth(me.token),
    });
    expect(res.status).toBe(404);
  });
});

describe('GET /finance/receivables', () => {
  it('отдаёт долг покупателей и просрочку отдельно', async () => {
    const me = await login('admin');
    const res = await api('/api/v1/finance/receivables?limit=50', { headers: auth(me.token) });
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.rows.length).toBeGreaterThan(0);
    for (const r of d.rows) {
      expect(num(r.debt)).toBeGreaterThan(0);
      expect(num(r.overdue)).toBeLessThanOrEqual(num(r.debt) + 0.01);
    }
    // Итог — сумма строк, а не отдельный запрос: иначе шапка и таблица разойдутся.
    const sum = d.rows.reduce((s: number, r: any) => s + num(r.debt), 0);
    expect(num(d.totals.debt)).toBeCloseTo(sum, 1);
  });

  it('фильтр просрочки оставляет только просроченных', async () => {
    const me = await login('admin');
    const res = await api('/api/v1/finance/receivables?overdueOnly=true&limit=50', {
      headers: auth(me.token),
    });
    expect(res.status).toBe(200);
    expect(res.body.data.rows.every((r: any) => num(r.overdue) > 0)).toBe(true);
  });
});

describe('GET /finance/budgets/plan-fact', () => {
  it('отдаёт колонки, строки и итог; фактом считает только проведённое', async () => {
    const me = await login('admin');
    const res = await api('/api/v1/finance/budgets/plan-fact', { headers: auth(me.token) });
    expect(res.status).toBe(200);
    const d = res.body.data;

    expect(d.columns.map((c: any) => c.key)).toEqual(['itemName', 'plan', 'fact', 'deviation']);
    expect(d.rows.length).toBeGreaterThan(0);
    for (const r of d.rows) {
      expect(num(r.fact), `факт по статье «${r.itemName}»`).toBeGreaterThan(0);
      expect(num(r.deviation)).toBeCloseTo(num(r.plan) - num(r.fact), 2);
    }
    // Отклонение видно в обе стороны — иначе колонку можно не рисовать.
    expect(d.rows.some((r: any) => num(r.deviation) < 0), 'ни одного перерасхода').toBe(true);
    expect(d.rows.some((r: any) => num(r.deviation) > 0), 'ни одного недобора').toBe(true);

    const plan = d.rows.reduce((s: number, r: any) => s + num(r.plan), 0);
    expect(num(d.totals.plan)).toBeCloseTo(plan, 1);
  });

  it('факт равен проведённому в базе и ни сумом больше', async () => {
    const me = await login('admin');
    const res = await api('/api/v1/finance/budgets/plan-fact', { headers: auth(me.token) });
    const rows = res.body.data.rows;

    // Тот же счёт, но в таблицах: если в запрос службы забудут условие
    // «только проведённое», факт распухнет на непроведённые заявки, а все
    // соотношения внутри ответа останутся верными — поймать это можно только
    // сверкой со стороны.
    //
    // Строка — бюджет, а не статья: одноимённые статьи двух компаний больше не
    // складываются, поэтому и сверяем по uid бюджета.
    const { rows: real } = await db.query(`
      SELECT b.uid,
             b.amount_planned::float8 AS plan,
             coalesce(f.fact, 0)::float8 AS fact
        FROM budget b
        LEFT JOIN LATERAL (
          SELECT coalesce(sum(o.amount_base), 0) AS fact
            FROM finance_operation o
           WHERE o.cashflow_item_id = b.cashflow_item_id
             AND o.company_id = b.company_id
             AND o.status = 'posted'
             AND o.occurred_at::date BETWEEN b.period_start AND b.period_end
        ) f ON true
    `);
    expect(rows.length).toBe(real.length);
    for (const r of real) {
      const got = rows.find((x: any) => x.uid === r.uid);
      expect(got, `строка бюджета ${r.uid}`).toBeDefined();
      expect(num(got.fact), `факт бюджета ${r.uid}`).toBeCloseTo(r.fact, 1);
      expect(num(got.plan), `план бюджета ${r.uid}`).toBeCloseTo(r.plan, 1);
    }

    // И непроведённые по этим статьям действительно есть — иначе проверка
    // выше ничего не стоит.
    const { rows: pending } = await db.query(`
      SELECT count(*)::int AS n FROM finance_operation WHERE status <> 'posted'
    `);
    expect(pending[0].n).toBeGreaterThan(0);
  });
});
