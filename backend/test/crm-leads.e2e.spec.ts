/**
 * CRM Э2 — лиды и превращение обращения в клиента (ТЗ 8.1, 8.3).
 *
 * Проверяем правила, ради которых этап делался: источник у обращения
 * обязателен, отказ требует причины, превращение заводит клиента с его
 * телефоном и одноразово (второе нажатие возвращает того же), обращение от
 * уже заведённого клиента второй карточки не создаёт, сделка при превращении
 * получает свой номер и первую стадию воронки.
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
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as any) : null };
}

async function login(loginName: string) {
  const res = await api('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: loginName, password: PASSWORD }),
  });
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`Логин ${loginName} не прошёл: ${res.status}`);
  }
  return res.body.data as { token: string; permissions: string[]; companies: any[] };
}

let admin: Awaited<ReturnType<typeof login>>;
let keeper: Awaited<ReturnType<typeof login>>;
let tradeUid: string;

const head = (s: Awaited<ReturnType<typeof login>>, companyUid?: string) => ({
  Authorization: `Bearer ${s.token}`,
  'Content-Type': 'application/json',
  ...(companyUid ? { 'X-Company-Id': companyUid } : {}),
});

const get = (path: string, s: typeof admin, companyUid = tradeUid) =>
  api(path, { headers: head(s, companyUid) });
const post = (path: string, s: typeof admin, body: unknown, companyUid = tradeUid) =>
  api(path, { method: 'POST', headers: head(s, companyUid), body: JSON.stringify(body) });
const patch = (path: string, s: typeof admin, body: unknown, companyUid = tradeUid) =>
  api(path, { method: 'PATCH', headers: head(s, companyUid), body: JSON.stringify(body) });
const del = (path: string, s: typeof admin, companyUid = tradeUid) =>
  api(path, { method: 'DELETE', headers: head(s, companyUid) });

const stamp = Date.now().toString().slice(-6);
const INN = `78${stamp}0`;
const createdPartners: string[] = [];
const createdLeads: string[] = [];
const createdDeals: string[] = [];
let sourceUid: string;

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

  db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  admin = await login('admin');
  keeper = await login('a.saidov');
  tradeUid = admin.companies.find((c: any) => c.code === 'trade').uid;

  const options = await get('/api/v1/crm/partners/options', admin);
  const sources = await db.query<{ uid: string }>(
    `SELECT s.uid FROM lead_source s JOIN company c ON c.id = s.company_id
      WHERE c.code = 'trade' LIMIT 1`,
  );
  sourceUid = sources.rows[0]!.uid;
  if (options.status !== 200) throw new Error('подбор не отвечает');
}, 60_000);

afterAll(async () => {
  for (const uid of createdDeals) {
    await db?.query('DELETE FROM deal WHERE uid = $1', [uid]);
  }
  for (const uid of createdLeads) {
    await db?.query('DELETE FROM lead WHERE uid = $1', [uid]);
  }
  for (const uid of createdPartners) {
    await db?.query('DELETE FROM partner_contact WHERE partner_id = (SELECT id FROM partner WHERE uid = $1)', [uid]);
    await db?.query('DELETE FROM partner WHERE uid = $1', [uid]);
  }
  await db?.end();
  await app?.close();
});

describe('приём обращения (ТЗ 8.1)', () => {
  let uid: string;

  it('без источника не принимается: иначе отчёт по источникам пуст', async () => {
    const res = await post('/api/v1/crm/leads', admin, {
      name: `QA Обращение ${stamp}`,
      phone: '+998 90 111 22 33',
    });
    expect(res.status).toBe(400);
  });

  it('принимается с источником, телефоном и комментарием', async () => {
    const res = await post('/api/v1/crm/leads', admin, {
      sourceUid,
      name: `QA Обращение ${stamp}`,
      phone: '+998 90 111 22 33',
      email: `lead${stamp}@demo.invalid`,
      comment: 'Спрашивал трубу 57×3,5',
    });
    expect(res.status).toBe(201);
    uid = res.body.data.uid;
    createdLeads.push(uid);
    expect(res.body.data.status).toBe('new');
    expect(res.body.data.source.uid).toBe(sourceUid);
    expect(res.body.data.partner).toBeNull();
  });

  it('виден в списке и в разбивке по статусам', async () => {
    const res = await get(`/api/v1/crm/leads?search=QA Обращение ${stamp}`, admin);
    expect(res.status).toBe(200);
    expect(res.body.data.rows.map((r: any) => r.uid)).toContain(uid);
    expect(res.body.data.byStatus.new).toBeGreaterThan(0);
  });

  it('отказ без причины не проходит: комментарий заявки причиной не считается', async () => {
    const bare = await patch(`/api/v1/crm/leads/${uid}`, admin, { status: 'rejected' });
    expect(bare.status).toBe(422);
    expect(String(bare.body.error.message)).toContain('причину отказа');

    const withReason = await patch(`/api/v1/crm/leads/${uid}`, admin, {
      status: 'rejected',
      rejectReason: 'Дороже конкурента',
    });
    expect(withReason.status).toBe(200);
    expect(withReason.body.data.status).toBe('rejected');
    expect(withReason.body.data.rejectReason).toBe('Дороже конкурента');
  });

  it('отклонённое обращение в клиента не превращается, пока не вернут в работу', async () => {
    const res = await post(`/api/v1/crm/leads/${uid}/convert`, admin, {});
    expect(res.status).toBe(422);
    expect(String(res.body.error.message)).toContain('отклонено');

    const back = await patch(`/api/v1/crm/leads/${uid}`, admin, { status: 'qualified' });
    expect(back.status).toBe(200);
  });

  it('статус «клиент» руками не ставится: его ставит только превращение', async () => {
    const res = await patch(`/api/v1/crm/leads/${uid}`, admin, { status: 'converted' });
    expect(res.status).toBe(400);
  });
});

describe('превращение обращения в клиента (ТЗ 8.3)', () => {
  let uid: string;
  let partnerUid: string;

  beforeAll(async () => {
    const res = await post('/api/v1/crm/leads', admin, {
      sourceUid,
      name: `QA Превращение ${stamp}`,
      phone: '+998 90 555 44 33',
      email: `conv${stamp}@demo.invalid`,
    });
    uid = res.body.data.uid;
    createdLeads.push(uid);
  });

  it('заводит клиента, переносит телефон в контактное лицо и сразу сделку', async () => {
    const res = await post(`/api/v1/crm/leads/${uid}/convert`, admin, {
      inn: INN,
      withDeal: true,
      dealAmount: 120000000,
    });
    expect(res.status).toBe(201);
    partnerUid = res.body.data.partnerUid;
    createdPartners.push(partnerUid);
    createdDeals.push(res.body.data.dealUid);

    expect(res.body.data.alreadyConverted).toBe(false);
    expect(res.body.data.lead.status).toBe('converted');
    expect(res.body.data.lead.partner.uid).toBe(partnerUid);

    const card = (await get(`/api/v1/crm/partners/${partnerUid}`, admin)).body.data;
    expect(card.inn).toBe(INN);
    // Телефон обращения — единственный способ связаться, он не теряется.
    expect(card.contacts).toHaveLength(1);
    expect(card.contacts[0].phone).toBe('+998 90 555 44 33');
    expect(card.contacts[0].isPrimary).toBe(true);
    // Источник и менеджер обращения переходят в карточку.
    expect(card.source.uid).toBe(sourceUid);

    const deal = await db.query<{ number: string; status: string; seq: number }>(
      `SELECT d.number, d.status::text AS status, s.seq
         FROM deal d JOIN deal_stage s ON s.id = d.stage_id WHERE d.uid = $1`,
      [res.body.data.dealUid],
    );
    expect(deal.rows[0]!.number).toMatch(/^СД-\d{4}$/);
    expect(deal.rows[0]!.status).toBe('open');
    // Сделка встаёт в первую стадию воронки, а не в случайную.
    const first = await db.query<{ seq: number }>(
      `SELECT min(seq) AS seq FROM deal_stage s JOIN company c ON c.id = s.company_id
        WHERE c.code = 'trade' AND NOT s.is_final`,
    );
    expect(deal.rows[0]!.seq).toBe(first.rows[0]!.seq);
  });

  it('повторное нажатие возвращает того же клиента, а не заводит второго', async () => {
    const again = await post(`/api/v1/crm/leads/${uid}/convert`, admin, { inn: INN });
    expect(again.status).toBe(201);
    expect(again.body.data.alreadyConverted).toBe(true);
    expect(again.body.data.partnerUid).toBe(partnerUid);

    const count = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM partner WHERE inn = $1`,
      [INN],
    );
    expect(Number(count.rows[0]!.n)).toBe(1);
  });

  it('превращённое обращение больше не правится', async () => {
    const res = await patch(`/api/v1/crm/leads/${uid}`, admin, { phone: '+998 90 000 00 00' });
    expect(res.status).toBe(422);
    expect(String(res.body.error.message)).toContain('уже стало клиентом');
  });

  it('обращение от уже заведённого клиента второй карточки не создаёт', async () => {
    const fresh = await post('/api/v1/crm/leads', admin, {
      sourceUid,
      name: `QA Повтор ${stamp}`,
      phone: '+998 90 555 44 33',
    });
    const freshUid = fresh.body.data.uid;
    createdLeads.push(freshUid);

    const res = await post(`/api/v1/crm/leads/${freshUid}/convert`, admin, { partnerUid });
    expect(res.status).toBe(201);
    expect(res.body.data.partnerUid).toBe(partnerUid);

    const count = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM partner WHERE inn = $1`,
      [INN],
    );
    expect(Number(count.rows[0]!.n)).toBe(1);
  });

  it('тем же ИНН второго клиента не завести и через превращение', async () => {
    const fresh = await post('/api/v1/crm/leads', admin, {
      sourceUid,
      name: `QA Двойник ИНН ${stamp}`,
    });
    createdLeads.push(fresh.body.data.uid);

    const res = await post(`/api/v1/crm/leads/${fresh.body.data.uid}/convert`, admin, { inn: INN });
    expect(res.status).toBe(422);
    expect(String(res.body.error.message)).toContain(INN);
  });

  it('клиент из обращения получает начало истории', async () => {
    const fresh = await post('/api/v1/crm/leads', admin, {
      sourceUid,
      name: `QA История ${stamp}`,
      phone: '+998 90 111 22 33',
    });
    createdLeads.push(fresh.body.data.uid);

    const conv = await post(`/api/v1/crm/leads/${fresh.body.data.uid}/convert`, admin, {});
    expect(conv.status).toBe(201);
    const uid = conv.body.data.partnerUid as string;

    // История карточки читается как доказательство: без записи о заведении
    // клиент появляется в базе из ниоткуда.
    const hist = await get(`/api/v1/crm/partners/${uid}/history`, admin);
    expect(hist.status).toBe(200);
    const rows = hist.body.data.rows as { action: string }[];
    expect(rows.some((r) => r.action === 'create')).toBe(true);
  });

  it('обращение, привязанное к заведённому клиенту, пишется в его историю', async () => {
    const fresh = await post('/api/v1/crm/leads', admin, {
      sourceUid,
      name: `QA Привязка ${stamp}`,
    });
    createdLeads.push(fresh.body.data.uid);

    const before = await get(`/api/v1/crm/partners/${partnerUid}/history`, admin);
    const was = (before.body.data.rows as unknown[]).length;

    const res = await post(`/api/v1/crm/leads/${fresh.body.data.uid}/convert`, admin, { partnerUid });
    expect(res.status).toBe(201);

    const after = await get(`/api/v1/crm/partners/${partnerUid}/history`, admin);
    const rows = after.body.data.rows as { action: string }[];
    expect(rows.length).toBe(was + 1);
    expect(rows.some((r) => r.action === 'lead.link')).toBe(true);
  });

  it('кладовщик обращения не видит и не принимает', async () => {
    expect((await get('/api/v1/crm/leads?limit=1', keeper)).status).toBe(403);
    expect(
      (await post('/api/v1/crm/leads', keeper, { sourceUid, name: 'Проба' })).status,
    ).toBe(403);
  });
});
