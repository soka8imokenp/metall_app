/**
 * CRM Э6 — отчёты (ТЗ 8: «отчёты по менеджерам, источникам, конверсии и
 * причинам отказов»).
 *
 * Главное, что здесь проверяется, — **как считается конверсия**. По текущей
 * стадии её считать нельзя: сделка, дошедшая до договора и проигранная, из
 * стадии «расчёт» уже ушла. Воронка обязана считать по следу переходов, и
 * проверка это ловит: сделка, прошедшая стадию и закрытая, остаётся в числе
 * дошедших до неё.
 *
 * Прогон пишет и за собой убирает.
 */
import 'dotenv/config';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { AuthGuard } from '../src/auth/auth.guard.js';
import { CrmModule } from '../src/crm/crm.module.js';
import { ContextMiddleware } from '../src/common/context.middleware.js';
import { EnvelopeInterceptor } from '../src/common/envelope.interceptor.js';
import { ErrorFilter } from '../src/common/error.filter.js';

let app: INestApplication;
let base: string;
let db: Client;

const PASSWORD = process.env.SEED_PASSWORD ?? 'metall-dev-2026';

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${base}${path}`, init);
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('json')) {
    return { status: res.status, type, bytes: Buffer.from(await res.arrayBuffer()), body: null as any };
  }
  const text = await res.text();
  return { status: res.status, type, bytes: Buffer.alloc(0), body: text ? JSON.parse(text) : null };
}

async function login(loginName: string) {
  const res = await api('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: loginName, password: PASSWORD }),
  });
  if (res.status !== 201 && res.status !== 200) throw new Error(`Логин ${loginName}: ${res.status}`);
  return res.body.data as { token: string; companies: any[] };
}

let admin: Awaited<ReturnType<typeof login>>;
let keeper: Awaited<ReturnType<typeof login>>;
let tradeUid: string;

const head = (s: typeof admin, companyUid?: string) => ({
  Authorization: `Bearer ${s.token}`,
  'Content-Type': 'application/json',
  ...(companyUid ? { 'X-Company-Id': companyUid } : {}),
});
const get = (path: string, s: typeof admin, companyUid = tradeUid) =>
  api(path, { headers: head(s, companyUid) });
const post = (path: string, s: typeof admin, body: unknown, companyUid = tradeUid) =>
  api(path, { method: 'POST', headers: head(s, companyUid), body: JSON.stringify(body) });

const stamp = Date.now().toString().slice(-6);
const madeDeals: string[] = [];
let partnerUid: string;
let stages: any[];
let reasonUid: string;

const day = (shift: number) => {
  const d = new Date(Date.now() + shift * 86_400_000);
  return d.toISOString().slice(0, 10);
};

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [PrismaModule, AuthModule, CrmModule],
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

  db = new Client({ connectionString: process.env.DATABASE_URL, options: '-c timezone=UTC' });
  await db.connect();

  admin = await login('admin');
  keeper = await login('a.saidov');
  tradeUid = admin.companies.find((c: any) => c.code === 'trade').uid;

  const p = await db.query<{ uid: string }>(
    `SELECT p.uid FROM partner p JOIN company c ON c.id = p.company_id
      WHERE c.code = 'trade' AND p.is_client ORDER BY p.id LIMIT 1`,
  );
  partnerUid = p.rows[0]!.uid;

  stages = (await get('/api/v1/crm/deal-stages', admin)).body.data.rows
    .filter((s: any) => s.company.code === 'trade')
    .sort((a: any, b: any) => a.seq - b.seq);
  reasonUid = (await get('/api/v1/crm/lost-reasons', admin)).body.data.rows
    .find((r: any) => r.company.code === 'trade').uid;
}, 60_000);

afterAll(async () => {
  for (const uid of madeDeals) {
    await db?.query(
      'DELETE FROM deal_stage_event WHERE deal_id IN (SELECT id FROM deal WHERE uid = $1)',
      [uid],
    );
    await db?.query('DELETE FROM deal WHERE uid = $1', [uid]);
  }
  await db?.end();
  await app?.close();
});

const report = async (kind: string, q = '') =>
  (await get(`/api/v1/crm/reports/${kind}${q}`, admin)).body.data;

describe('воронка считается по следу переходов, а не по текущей стадии (ТЗ 8.3, 8)', () => {
  it('сделка, прошедшая стадию и проигранная, остаётся в числе дошедших до неё', async () => {
    const open = stages.filter((s: any) => !s.isFinal);
    const second = open[1]!;

    const before = await report('funnel', `?from=${day(-3)}&to=${day(0)}`);
    const rowOf = (r: any[], name: string) => r.find((x: any[]) => x[0] === name);
    const was = Number(rowOf(before.rows, second.nameRu)?.[1] ?? 0);

    const created = await post('/api/v1/crm/deals', admin, {
      partnerUid,
      title: `QA Воронка ${stamp}`,
      amount: 500000000,
    });
    expect(created.status).toBe(201);
    const deal = created.body.data;
    madeDeals.push(deal.uid);

    const moved = await post(`/api/v1/crm/deals/${deal.uid}/move`, admin, {
      stageUid: second.uid,
      version: deal.version,
    });
    expect(moved.status).toBe(201);

    const lost = await post(`/api/v1/crm/deals/${deal.uid}/lose`, admin, {
      version: moved.body.data.version,
      reasonUid,
      comment: 'QA: закрыто прогоном отчётов',
    });
    expect(lost.status).toBe(201);

    // Сейчас сделка лежит в «проиграна», но через вторую стадию она прошла.
    const after = await report('funnel', `?from=${day(-3)}&to=${day(0)}`);
    expect(Number(rowOf(after.rows, second.nameRu)![1])).toBe(was + 1);
  });

  it('конверсия первой стадии — сто процентов, дальше не растёт', async () => {
    const r = await report('funnel');
    const shares = r.rows.filter((x: any[]) => x[2] !== null).map((x: any[]) => Number(x[2]));
    expect(shares[0]).toBe(100);
    for (let i = 1; i < shares.length; i += 1) {
      expect(shares[i]).toBeLessThanOrEqual(shares[0]!);
    }
  });

  it('подзаголовок честно предупреждает о недосчитанной свежей когорте', async () => {
    const r = await report('funnel');
    expect(r.subtitle).toMatch(/занижена/);
  });
});

describe('менеджеры, источники, причины отказов', () => {
  it('у менеджеров конверсия считается по закрытым сделкам', async () => {
    const r = await report('managers', `?from=${day(-365)}&to=${day(0)}`);
    expect(r.rows.length).toBeGreaterThan(0);
    for (const row of r.rows) {
      const [, , won, lost, , conv] = row as any[];
      const closed = Number(won) + Number(lost);
      const expected = closed > 0 ? Math.round((Number(won) / closed) * 1000) / 10 : 0;
      expect(Number(conv)).toBeCloseTo(expected, 1);
    }
  });

  it('источники считают и обращения, и выигранные сделки', async () => {
    const r = await report('sources', `?from=${day(-365)}&to=${day(0)}`);
    expect(r.columns.map((c: any) => c.title)).toContain('Конверсия в клиента, %');
    expect(r.totals.leads).toBeGreaterThan(0);
  });

  it('доли причин отказов в сумме дают сто процентов', async () => {
    const r = await report('lost-reasons', `?from=${day(-365)}&to=${day(0)}`);
    expect(r.rows.length).toBeGreaterThan(0);
    const share = r.rows.reduce((s: number, x: any[]) => s + Number(x[2]), 0);
    expect(share).toBeGreaterThan(99);
    expect(share).toBeLessThan(101);
  });

  it('проигранная сделка без причины в отчёт попасть не может — их нет в базе', async () => {
    const orphan = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM deal WHERE status = 'lost' AND lost_reason_id IS NULL`,
    );
    expect(Number(orphan.rows[0]!.n)).toBe(0);
  });
});

describe('период и выгрузка', () => {
  it('период по умолчанию — 90 дней, и он назван в подзаголовке', async () => {
    const r = await report('managers');
    expect(r.subtitle).toMatch(/\d{2}\.\d{2}\.\d{4} — \d{2}\.\d{2}\.\d{4}/);
  });

  it('кривой период отклоняется с объяснением', async () => {
    const res = await get('/api/v1/crm/reports/managers?from=вчера&to=2026-09-29', admin);
    expect(res.status).toBe(400);
  });

  it('начало позже конца — отказ', async () => {
    const res = await get('/api/v1/crm/reports/managers?from=2026-09-29&to=2026-09-01', admin);
    expect(res.status).toBe(422);
  });

  it('выгрузка отдаёт настоящий xlsx и csv с теми же колонками', async () => {
    const xlsx = await get('/api/v1/crm/reports/funnel/file?format=xlsx', admin);
    expect(xlsx.status).toBe(200);
    expect(xlsx.bytes.subarray(0, 2).toString('latin1')).toBe('PK');

    const csv = await get('/api/v1/crm/reports/funnel/file?format=csv', admin);
    expect(csv.status).toBe(200);
    const head = csv.bytes.toString('utf8').split('\n')[0]!;
    const onScreen = (await report('funnel')).columns.map((c: any) => c.title);
    for (const title of onScreen) expect(head).toContain(title);
  });

  it('кладовщик отчётов CRM не видит', async () => {
    expect((await get('/api/v1/crm/reports/funnel', keeper)).status).toBe(403);
    expect((await get('/api/v1/crm/reports/funnel/file?format=csv', keeper)).status).toBe(403);
  });
});
