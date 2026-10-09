/**
 * Бюджеты на запись и план-факт по ним (ТЗ 6.6).
 *
 * Проверяется ровно то, чего раньше не было: бюджет можно завести из системы,
 * период у него — месяц или квартал, а не произвольные дни, второй план на ту
 * же статью в том же периоде не заводится, и состояние строки (норма,
 * предупреждение, перерасход) считает сервер по настроенному порогу.
 *
 * План-факт при этом обязан давать строку на бюджет: названия статей в двух
 * компаниях совпадают, и сложенные вместе они превращаются в план, которого
 * никто не утверждал.
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
let db: Client;

const PASSWORD = process.env.SEED_PASSWORD ?? 'metall-dev-2026';

/** Бюджеты, заведённые проверками: убираем за собой, база общая для всего прогона. */
const created: string[] = [];
/** Что меняли у посеянных бюджетов — возвращаем как было. */
const restore: { uid: string; amount: string; threshold: string }[] = [];

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
  'Content-Type': 'application/json',
  Authorization: `Bearer ${token}`,
  ...(companyUids?.length ? { 'X-Company-Id': companyUids.join(',') } : {}),
});

let director: Awaited<ReturnType<typeof login>>;
let accountant: Awaited<ReturnType<typeof login>>;
/** Одна компания в контексте: без неё запись бюджета справедливо не знает, чей план. */
let trade: string;

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

  director = await login('s.radjabov');
  accountant = await login('m.rahimova');
  trade = director.companies.find((c) => c.code === 'TRADE')?.uid ?? director.companies[0]!.uid;
}, 60_000);

afterAll(async () => {
  // Каждое удаление отдельно: споткнувшееся на одном бюджете не должно
  // оставлять в базе остальные — иначе следующий прогон упрётся в дубль.
  for (const uid of created) {
    // Только бюджет: журнал действий — таблица на одно добавление, из неё не
    // удаляют, и проверки на это не рассчитывают.
    try {
      await db?.query('DELETE FROM budget WHERE uid = $1', [uid]);
    } catch {
      /* чистим дальше */
    }
  }
  for (const r of restore) {
    await db?.query(
      'UPDATE budget SET amount_planned = $2, threshold_warn_percent = $3 WHERE uid = $1',
      [r.uid, r.amount, r.threshold],
    );
  }
  await app?.close();
  await db?.end();
});

/**
 * Будущий период освобождаем перед проверкой: прогон не первый, база общая, а
 * бюджет на тот же период — законный отказ, который сорвёт проверку не по делу.
 */
async function freePeriod(period: string) {
  await db.query(
    `DELETE FROM budget b
       USING cashflow_item c, company co
      WHERE b.cashflow_item_id = c.id AND co.id = b.company_id
        AND to_char(b.period_start, 'YYYY-MM') = $1`,
    [period.slice(0, 7)],
  );
}

/** Статья расхода «Торгового дома», по которой бюджета ещё нет ни на один период. */
async function outflowItem() {
  const refs = await api('/api/v1/finance/budgets/refs', { headers: auth(director.token, [trade]) });
  expect(refs.status).toBe(200);
  const item = refs.body.data.items.find(
    (i: any) => i.companyUid === trade && i.direction === 'outflow',
  );
  expect(item, 'статья расхода в справочнике формы').toBeDefined();
  return item as { uid: string; nameRu: string };
}

async function planFact(companyUids?: string[]) {
  const res = await api('/api/v1/finance/budgets/plan-fact', {
    headers: auth(director.token, companyUids),
  });
  expect(res.status).toBe(200);
  return res.body.data as { rows: any[]; totals: any };
}

describe('GET /finance/budgets/plan-fact', () => {
  it('даёт строку на бюджет, а не склеивает одноимённые статьи двух компаний', async () => {
    const d = await planFact();
    expect(d.rows.length).toBeGreaterThan(5);
    // Адресуемость: без uid бюджет нечем править и удалять.
    expect(d.rows.every((r) => typeof r.uid === 'string' && r.uid.length === 36)).toBe(true);
    const uids = new Set(d.rows.map((r) => r.uid));
    expect(uids.size).toBe(d.rows.length);

    const byName = new Map<string, Set<string>>();
    for (const r of d.rows) {
      if (!byName.has(r.itemName)) byName.set(r.itemName, new Set());
      byName.get(r.itemName)!.add(r.company.code);
    }
    const shared = [...byName.entries()].find(([, codes]) => codes.size > 1);
    expect(shared, 'одна и та же статья есть у обеих компаний').toBeDefined();
  });

  it('период называется месяцем или кварталом', async () => {
    const d = await planFact();
    for (const r of d.rows) {
      expect(r.period, `период бюджета ${r.uid}`).toMatch(/^\d{4}-(0[1-9]|1[0-2]|Q[1-4])$/);
    }
    expect(d.rows.some((r) => /-Q[1-4]$/.test(r.period)), 'квартальный бюджет в данных').toBe(true);
    expect(d.rows.some((r) => r.department === null), 'бюджет без подразделения').toBe(true);
  });

  it('факт — только проведённые операции этой статьи внутри периода', async () => {
    const d = await planFact();
    const row = d.rows.find((r) => Number(r.fact) > 0)!;
    expect(row, 'бюджет с фактом').toBeDefined();
    const sql = await db.query(
      `SELECT coalesce(sum(o.amount_base), 0)::text AS fact
         FROM finance_operation o
         JOIN budget b ON b.uid = $1
        WHERE o.cashflow_item_id = b.cashflow_item_id
          AND o.company_id = b.company_id
          AND o.status = 'posted'
          AND o.occurred_at::date BETWEEN b.period_start AND b.period_end`,
      [row.uid],
    );
    expect(Number(row.fact)).toBeCloseTo(Number(sql.rows[0].fact), 2);
    expect(Number(row.deviation)).toBeCloseTo(Number(row.plan) - Number(row.fact), 2);
  });

  it('итоги сходятся с суммой строк', async () => {
    const d = await planFact();
    const plan = d.rows.reduce((s, r) => s + Number(r.plan), 0);
    const fact = d.rows.reduce((s, r) => s + Number(r.fact), 0);
    expect(Number(d.totals.plan)).toBeCloseTo(plan, 2);
    expect(Number(d.totals.fact)).toBeCloseTo(fact, 2);
    expect(d.totals.over).toBe(d.rows.filter((r) => r.status === 'over').length);
    expect(d.totals.warn).toBe(d.rows.filter((r) => r.status === 'warn').length);
  });

  it('состояние строки считает сервер по порогу этого бюджета', async () => {
    const before = await planFact([trade]);
    const row = before.rows.find((r) => Number(r.fact) > 0 && r.status !== 'over')!;
    expect(row, 'бюджет без перерасхода, но с фактом').toBeDefined();
    restore.push({ uid: row.uid, amount: String(row.plan), threshold: String(row.thresholdWarnPercent) });

    // План ниже факта — перерасход и отрицательное отклонение.
    const over = await api(`/api/v1/finance/budgets/${row.uid}`, {
      method: 'PATCH',
      headers: auth(director.token, [trade]),
      body: JSON.stringify({ amountPlanned: Math.round(Number(row.fact) * 0.5) }),
    });
    expect(over.status).toBe(200);
    let now = (await planFact([trade])).rows.find((r) => r.uid === row.uid)!;
    expect(now.status).toBe('over');
    expect(Number(now.deviation)).toBeLessThan(0);

    // План вдвое выше факта: при пороге 80 % это норма, при пороге 1 % —
    // предупреждение. Значит состояние зависит от порога, а не от вкуса экрана.
    await api(`/api/v1/finance/budgets/${row.uid}`, {
      method: 'PATCH',
      headers: auth(director.token, [trade]),
      body: JSON.stringify({ amountPlanned: Math.round(Number(row.fact) * 2), thresholdWarnPercent: 80 }),
    });
    now = (await planFact([trade])).rows.find((r) => r.uid === row.uid)!;
    expect(now.status).toBe('ok');

    await api(`/api/v1/finance/budgets/${row.uid}`, {
      method: 'PATCH',
      headers: auth(director.token, [trade]),
      body: JSON.stringify({ thresholdWarnPercent: 1 }),
    });
    now = (await planFact([trade])).rows.find((r) => r.uid === row.uid)!;
    expect(now.status).toBe('warn');
  });
});

describe('POST /finance/budgets', () => {
  it('заводит бюджет на месяц, и он сразу виден в план-факте', async () => {
    const item = await outflowItem();
    await freePeriod('2027-02');
    const res = await api('/api/v1/finance/budgets', {
      method: 'POST',
      headers: auth(director.token, [trade]),
      body: JSON.stringify({
        itemUid: item.uid,
        period: '2027-02',
        amountPlanned: 1_200_000_000,
        thresholdWarnPercent: 70,
      }),
    });
    expect(res.status).toBe(201);
    created.push(res.body.data.uid);
    expect(res.body.data.period).toBe('2027-02');

    const d = await planFact([trade]);
    const row = d.rows.find((r) => r.uid === res.body.data.uid)!;
    expect(row, 'заведённый бюджет в план-факте').toBeDefined();
    expect(row.period).toBe('2027-02');
    expect(row.periodStart).toBe('2027-02-01');
    expect(row.periodEnd).toBe('2027-02-28');
    expect(Number(row.plan)).toBe(1_200_000_000);
    // Факта в будущем периоде нет, и это норма, а не предупреждение.
    expect(Number(row.fact)).toBe(0);
    expect(row.status).toBe('ok');
    expect(row.thresholdWarnPercent).toBe('70');

    const log = await db.query(
      `SELECT action FROM audit_log WHERE entity_type = 'budget' AND entity_id = $1`,
      [res.body.data.uid],
    );
    expect(log.rows.map((r) => r.action)).toContain('create');
  });

  it('принимает квартал', async () => {
    const item = await outflowItem();
    // Квартал — это три месяца, освобождаем каждый.
    await freePeriod('2027-07');
    await freePeriod('2027-08');
    await freePeriod('2027-09');
    const res = await api('/api/v1/finance/budgets', {
      method: 'POST',
      headers: auth(director.token, [trade]),
      body: JSON.stringify({ itemUid: item.uid, period: '2027-Q3', amountPlanned: 5_000_000_000 }),
    });
    expect(res.status).toBe(201);
    created.push(res.body.data.uid);
    const row = (await planFact([trade])).rows.find((r) => r.uid === res.body.data.uid)!;
    expect(row.period).toBe('2027-Q3');
    expect(row.periodStart).toBe('2027-07-01');
    expect(row.periodEnd).toBe('2027-09-30');
    // Порог по умолчанию — 80 %, а не «что-нибудь».
    expect(row.thresholdWarnPercent).toBe('80');
  });

  it('второй бюджет на ту же статью и период не заводится', async () => {
    const item = await outflowItem();
    await freePeriod('2027-05');
    const first = await api('/api/v1/finance/budgets', {
      method: 'POST',
      headers: auth(director.token, [trade]),
      body: JSON.stringify({ itemUid: item.uid, period: '2027-05', amountPlanned: 700_000_000 }),
    });
    expect(first.status).toBe(201);
    created.push(first.body.data.uid);

    const second = await api('/api/v1/finance/budgets', {
      method: 'POST',
      headers: auth(director.token, [trade]),
      body: JSON.stringify({ itemUid: item.uid, period: '2027-05', amountPlanned: 900_000_000 }),
    });
    expect(second.status).toBe(422);
    expect(second.body.error.message).toMatch(/уже задан/i);

    // И в план-факте по-прежнему одна строка на этот период.
    const rows = (await planFact([trade])).rows.filter((r) => r.period === '2027-05');
    expect(rows.length).toBe(1);
  });

  it('произвольные даты периодом не принимает', async () => {
    const item = await outflowItem();
    for (const period of ['2027-05-07', '2027-13', '2027-Q5', 'май', '2027']) {
      const res = await api('/api/v1/finance/budgets', {
        method: 'POST',
        headers: auth(director.token, [trade]),
        body: JSON.stringify({ itemUid: item.uid, period, amountPlanned: 100_000_000 }),
      });
      expect([400, 422], `период «${period}»`).toContain(res.status);
    }
  });

  it('порог вне 1..100 и неположительный план отклоняет', async () => {
    const item = await outflowItem();
    await freePeriod('2027-06');
    const bad = async (body: Record<string, unknown>) =>
      (
        await api('/api/v1/finance/budgets', {
          method: 'POST',
          headers: auth(director.token, [trade]),
          body: JSON.stringify({ itemUid: item.uid, period: '2027-06', ...body }),
        })
      ).status;
    expect(await bad({ amountPlanned: 100, thresholdWarnPercent: 0 })).toBe(400);
    expect(await bad({ amountPlanned: 100, thresholdWarnPercent: 140 })).toBe(400);
    expect(await bad({ amountPlanned: 0 })).toBe(400);
    expect(await bad({ amountPlanned: -5 })).toBe(400);
  });

  it('с двумя компаниями в контексте требует назвать компанию', async () => {
    const item = await outflowItem();
    await freePeriod('2027-07');
    const both = director.companies.map((c) => c.uid);
    expect(both.length).toBe(2);
    const res = await api('/api/v1/finance/budgets', {
      method: 'POST',
      headers: auth(director.token, both),
      body: JSON.stringify({ itemUid: item.uid, period: '2027-07', amountPlanned: 100_000_000 }),
    });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/компан/i);

    const ok = await api('/api/v1/finance/budgets', {
      method: 'POST',
      headers: auth(director.token, both),
      body: JSON.stringify({
        companyUid: trade,
        itemUid: item.uid,
        period: '2027-07',
        amountPlanned: 100_000_000,
      }),
    });
    expect(ok.status).toBe(201);
    created.push(ok.body.data.uid);
  });

  it('статья другой компании бюджетом этой не становится', async () => {
    const refs = await api('/api/v1/finance/budgets/refs', {
      headers: auth(director.token, director.companies.map((c) => c.uid)),
    });
    const alien = refs.body.data.items.find(
      (i: any) => i.companyUid !== trade && i.direction === 'outflow',
    );
    expect(alien, 'статья второй компании').toBeDefined();
    const res = await api('/api/v1/finance/budgets', {
      method: 'POST',
      headers: auth(director.token, [trade]),
      body: JSON.stringify({ itemUid: alien.uid, period: '2027-08', amountPlanned: 100_000_000 }),
    });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/стать/i);
  });
});

describe('PATCH и DELETE /finance/budgets/:uid', () => {
  it('правит сумму и ответственного, пишет в журнал, период не трогает', async () => {
    const item = await outflowItem();
    await freePeriod('2027-09');
    const refs = await api('/api/v1/finance/budgets/refs', {
      headers: auth(director.token, [trade]),
    });
    const person = refs.body.data.people.find((p: any) => p.companyUid === trade);
    const dept = refs.body.data.departments.find((d: any) => d.companyUid === trade);

    const res = await api('/api/v1/finance/budgets', {
      method: 'POST',
      headers: auth(director.token, [trade]),
      body: JSON.stringify({ itemUid: item.uid, period: '2027-09', amountPlanned: 300_000_000 }),
    });
    expect(res.status).toBe(201);
    const uid = res.body.data.uid as string;
    created.push(uid);

    const patch = await api(`/api/v1/finance/budgets/${uid}`, {
      method: 'PATCH',
      headers: auth(director.token, [trade]),
      body: JSON.stringify({
        amountPlanned: 450_000_000,
        responsibleUid: person.uid,
        departmentUid: dept.uid,
      }),
    });
    expect(patch.status).toBe(200);

    let row = (await planFact([trade])).rows.find((r) => r.uid === uid)!;
    expect(Number(row.plan)).toBe(450_000_000);
    expect(row.responsible.uid).toBe(person.uid);
    expect(row.department.uid).toBe(dept.uid);
    expect(row.period).toBe('2027-09');

    // Пустая строка снимает: форма присылает именно её.
    const clear = await api(`/api/v1/finance/budgets/${uid}`, {
      method: 'PATCH',
      headers: auth(director.token, [trade]),
      body: JSON.stringify({ responsibleUid: '', departmentUid: '' }),
    });
    expect(clear.status).toBe(200);
    row = (await planFact([trade])).rows.find((r) => r.uid === uid)!;
    expect(row.responsible).toBeNull();
    expect(row.department).toBeNull();

    const log = await db.query(
      `SELECT action, changes FROM audit_log WHERE entity_type = 'budget' AND entity_id = $1 ORDER BY id`,
      [uid],
    );
    expect(log.rows.map((r) => r.action)).toContain('update');
    // Именно правка, а не запись о создании: у той тоже есть сумма плана.
    const amountChange = log.rows.find((r) => r.action === 'update' && r.changes?.amountPlanned);
    expect(Number(amountChange.changes.amountPlanned.to)).toBe(450_000_000);
  });

  it('удаляет бюджет, запись об удалении остаётся', async () => {
    const item = await outflowItem();
    await freePeriod('2027-10');
    const res = await api('/api/v1/finance/budgets', {
      method: 'POST',
      headers: auth(director.token, [trade]),
      body: JSON.stringify({ itemUid: item.uid, period: '2027-10', amountPlanned: 200_000_000 }),
    });
    const uid = res.body.data.uid as string;
    created.push(uid);

    const del = await api(`/api/v1/finance/budgets/${uid}`, {
      method: 'DELETE',
      headers: auth(director.token, [trade]),
    });
    expect(del.status).toBe(200);
    expect((await planFact([trade])).rows.some((r) => r.uid === uid)).toBe(false);

    const log = await db.query(
      `SELECT action FROM audit_log WHERE entity_type = 'budget' AND entity_id = $1`,
      [uid],
    );
    expect(log.rows.map((r) => r.action)).toContain('delete');

    const again = await api(`/api/v1/finance/budgets/${uid}`, {
      method: 'DELETE',
      headers: auth(director.token, [trade]),
    });
    expect(again.status).toBe(404);
  });
});

describe('права на бюджет', () => {
  it('бухгалтер план-факт читает, но план не правит', async () => {
    expect(accountant.permissions).toContain('finance.view');
    expect(accountant.permissions).not.toContain('finance.approve');

    const read = await api('/api/v1/finance/budgets/plan-fact', {
      headers: auth(accountant.token, [trade]),
    });
    expect(read.status).toBe(200);

    await freePeriod('2027-11');
    const item = await outflowItem();
    const write = await api('/api/v1/finance/budgets', {
      method: 'POST',
      headers: auth(accountant.token, [trade]),
      body: JSON.stringify({ itemUid: item.uid, period: '2027-11', amountPlanned: 100_000_000 }),
    });
    expect(write.status).toBe(403);

    const any = (await planFact([trade])).rows[0]!;
    const patch = await api(`/api/v1/finance/budgets/${any.uid}`, {
      method: 'PATCH',
      headers: auth(accountant.token, [trade]),
      body: JSON.stringify({ amountPlanned: 1 }),
    });
    expect(patch.status).toBe(403);
    const del = await api(`/api/v1/finance/budgets/${any.uid}`, {
      method: 'DELETE',
      headers: auth(accountant.token, [trade]),
    });
    expect(del.status).toBe(403);
  });

  it('без finance.view раздел не отдаётся вовсе', async () => {
    const keeper = await login('a.saidov');
    expect(keeper.permissions).not.toContain('finance.view');
    const res = await api('/api/v1/finance/budgets/refs', { headers: auth(keeper.token) });
    expect(res.status).toBe(403);
  });
});
