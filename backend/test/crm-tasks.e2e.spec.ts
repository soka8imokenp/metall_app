/**
 * CRM Э4 — задачи и активности (ТЗ 8.4).
 *
 * Проверяем правила, ради которых этап делался: задача без клиента и сделки не
 * заводится; закрытие требует результата и само рождает активность в ленте
 * клиента; закрытую задачу не правят и не закрывают второй раз; версия не даёт
 * двоим затереть правки друг друга; активность не бывает в будущем, а
 * длительность и направление есть только у звонка; просроченное считается и
 * видно отдельно от сегодняшнего.
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

const stamp = Date.now().toString().slice(-6);
const tasks: string[] = [];
const acts: string[] = [];
let partnerUid: string;
let otherPartnerUid: string;
let dealUid: string;
let managerUid: string;

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

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

  const d = await db.query<{ uid: string; partner_id: string }>(
    `SELECT d.uid, d.partner_id FROM deal d JOIN company c ON c.id = d.company_id
      WHERE c.code = 'trade' AND d.status = 'open' ORDER BY d.id LIMIT 1`,
  );
  dealUid = d.rows[0]!.uid;

  // Клиента сделки и клиента «из другой карточки» выбираем по самой сделке, а
  // не по порядку id: совпадут они или нет — дело посева, а проверка про то,
  // что система не склеивает чужую сделку с чужим клиентом.
  const p = await db.query<{ uid: string }>(
    `SELECT p.uid FROM partner p JOIN company c ON c.id = p.company_id
      WHERE c.code = 'trade' AND p.is_client AND p.id <> $1 ORDER BY p.id LIMIT 1`,
    [d.rows[0]!.partner_id],
  );
  const own = await db.query<{ uid: string }>(
    `SELECT p.uid FROM partner p WHERE p.id = $1`,
    [d.rows[0]!.partner_id],
  );
  partnerUid = own.rows[0]!.uid;
  otherPartnerUid = p.rows[0]!.uid;

  const u = await db.query<{ uid: string }>(`SELECT uid FROM user_account WHERE login = 'admin'`);
  managerUid = u.rows[0]!.uid;

  const types = await db.query<{ code: string; uid: string }>(
    `SELECT t.code, t.uid FROM crm_task_type t JOIN company c ON c.id = t.company_id
      WHERE c.code = 'trade'`,
  );
  for (const r of types.rows) typeUid[r.code] = r.uid;
}, 60_000);

afterAll(async () => {
  for (const uid of acts) await db?.query('DELETE FROM crm_activity WHERE uid = $1', [uid]);
  await db?.query('DELETE FROM crm_activity WHERE task_id IN (SELECT id FROM crm_task WHERE uid = ANY($1::uuid[]))', [tasks]);
  for (const uid of tasks) await db?.query('DELETE FROM crm_task WHERE uid = $1', [uid]);
  await db?.end();
  await app?.close();
});

const typeUid: Record<string, string> = {};

async function newTask(over: Record<string, unknown> = {}) {
  const res = await post('/api/v1/crm/tasks', admin, {
    typeUid: typeUid.call,
    title: `QA Задача ${stamp}`,
    dueAt: inDays(1),
    partnerUid,
    ...over,
  });
  expect(res.status).toBe(201);
  tasks.push(res.body.data.uid);
  return res.body.data;
}

describe('задача заводится только при связи с клиентом или сделкой (ТЗ 8.4)', () => {
  it('без клиента и без сделки — 422, а не безхозная строка', async () => {
    const res = await post('/api/v1/crm/tasks', admin, {
      typeUid: typeUid.call,
      title: `QA Ничья ${stamp}`,
      dueAt: inDays(1),
    });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('клиента или сделку');
  });

  it('задача по сделке подставляет клиента сделки — иначе её не видно в карточке клиента', async () => {
    const t = await newTask({ partnerUid: undefined, dealUid, title: `QA По сделке ${stamp}` });
    expect(t.deal.uid).toBe(dealUid);
    expect(t.partner).not.toBeNull();
  });

  it('клиент и сделка из разных карточек не сходятся', async () => {
    const res = await post('/api/v1/crm/tasks', admin, {
      typeUid: typeUid.call,
      title: `QA Разные ${stamp}`,
      dueAt: inDays(1),
      partnerUid: otherPartnerUid,
      dealUid,
    });
    expect(res.status).toBe(422);
  });

  it('ответственный по умолчанию — тот, кто завёл', async () => {
    const t = await newTask({ title: `QA Ответственный ${stamp}` });
    expect(t.assignee.uid).toBe(managerUid);
  });
});

describe('закрытие задачи (ТЗ 8.4)', () => {
  it('без результата не закрывается', async () => {
    const t = await newTask({ title: `QA Без результата ${stamp}` });
    const res = await post(`/api/v1/crm/tasks/${t.uid}/complete`, admin, { version: t.version });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('результат');
  });

  it('закрытая задача сама ложится звонком в ленту клиента', async () => {
    const t = await newTask({ title: `QA Дозвон ${stamp}` });
    const done = await post(`/api/v1/crm/tasks/${t.uid}/complete`, admin, {
      version: t.version,
      result: 'Дозвонились, просят счёт на 12 тонн',
    });
    expect(done.status).toBe(201);
    expect(done.body.data.status).toBe('done');
    expect(done.body.data.result).toContain('12 тонн');

    const feed = (await get(`/api/v1/crm/activities?partnerUid=${partnerUid}`, admin)).body.data;
    const mine = feed.rows.find((a: any) => a.task?.uid === t.uid);
    expect(mine).toBeTruthy();
    expect(mine.type).toBe('call');
    expect(mine.note).toContain('12 тонн');
  });

  it('«подготовить документ» ложится заметкой, а не звонком', async () => {
    const t = await newTask({ typeUid: typeUid.document, title: `QA Счёт ${stamp}` });
    await post(`/api/v1/crm/tasks/${t.uid}/complete`, admin, {
      version: t.version,
      result: 'Счёт выставлен',
    });
    const feed = (await get(`/api/v1/crm/activities?partnerUid=${partnerUid}`, admin)).body.data;
    expect(feed.rows.find((a: any) => a.task?.uid === t.uid).type).toBe('note');
  });

  it('второй раз не закрывается и не правится — закрытая задача история', async () => {
    const t = await newTask({ title: `QA Дважды ${stamp}` });
    const done = await post(`/api/v1/crm/tasks/${t.uid}/complete`, admin, {
      version: t.version,
      result: 'Договорились',
    });
    const v = done.body.data.version;
    expect((await post(`/api/v1/crm/tasks/${t.uid}/complete`, admin, { version: v, result: 'Ещё раз' })).status).toBe(422);
    expect((await patch(`/api/v1/crm/tasks/${t.uid}`, admin, { version: v, title: 'Правка' })).status).toBe(422);
  });

  it('отмена требует причины и активности не рождает', async () => {
    const t = await newTask({ title: `QA Отмена ${stamp}` });
    expect((await post(`/api/v1/crm/tasks/${t.uid}/cancel`, admin, { version: t.version })).status).toBe(422);
    const res = await post(`/api/v1/crm/tasks/${t.uid}/cancel`, admin, {
      version: t.version,
      result: 'Клиент перенёс закупку на год',
    });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('cancelled');
    const feed = (await get(`/api/v1/crm/activities?partnerUid=${partnerUid}`, admin)).body.data;
    expect(feed.rows.find((a: any) => a.task?.uid === t.uid)).toBeUndefined();
  });

  it('версия не даёт двоим затереть правку друг друга', async () => {
    const t = await newTask({ title: `QA Версия ${stamp}` });
    await patch(`/api/v1/crm/tasks/${t.uid}`, admin, { version: t.version, title: `QA Версия-2 ${stamp}` });
    const late = await patch(`/api/v1/crm/tasks/${t.uid}`, admin, { version: t.version, title: 'Затирание' });
    expect(late.status).toBe(409);
    expect(late.body.error.details.version).toBe(t.version + 1);
  });
});

describe('просроченное видно отдельно (ТЗ 8.4)', () => {
  it('срок в прошлом — задача просрочена и попадает в свою вкладку, а не в «сегодня»', async () => {
    const t = await newTask({ title: `QA Просрочка ${stamp}`, dueAt: inDays(-3) });
    expect(t.isOverdue).toBe(true);

    const over = (await get(`/api/v1/crm/tasks?scope=overdue&partnerUid=${partnerUid}`, admin)).body.data;
    expect(over.rows.some((x: any) => x.uid === t.uid)).toBe(true);
    expect(over.counts.overdue).toBeGreaterThanOrEqual(1);

    const today = (await get(`/api/v1/crm/tasks?scope=today&partnerUid=${partnerUid}`, admin)).body.data;
    expect(today.rows.some((x: any) => x.uid === t.uid)).toBe(false);
  });

  it('счётчик просроченного не пропадает на вкладке закрытых', async () => {
    const closed = (await get(`/api/v1/crm/tasks?scope=closed&partnerUid=${partnerUid}`, admin)).body.data;
    expect(closed.counts.overdue).toBeGreaterThanOrEqual(1);
    expect(closed.rows.every((x: any) => x.status !== 'open')).toBe(true);
  });
});

describe('активности — то, что уже было (ТЗ 8.4)', () => {
  it('заметка задним числом принимается', async () => {
    const res = await post('/api/v1/crm/activities', admin, {
      type: 'note',
      subject: `QA Заметка ${stamp}`,
      note: 'Просил перезвонить после обеда',
      at: inDays(-1),
      partnerUid,
    });
    expect(res.status).toBe(201);
    acts.push(res.body.data.uid);
  });

  it('активность в будущем не заводится — это задача', async () => {
    const res = await post('/api/v1/crm/activities', admin, {
      type: 'call',
      subject: `QA Будущее ${stamp}`,
      at: inDays(2),
      partnerUid,
    });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('задачу');
  });

  it('длительность и направление есть только у звонка', async () => {
    const bad = await post('/api/v1/crm/activities', admin, {
      type: 'letter',
      subject: `QA Письмо ${stamp}`,
      durationSec: 120,
      partnerUid,
    });
    expect(bad.status).toBe(422);

    const good = await post('/api/v1/crm/activities', admin, {
      type: 'call',
      subject: `QA Входящий ${stamp}`,
      direction: 'incoming',
      durationSec: 120,
      partnerUid,
    });
    expect(good.status).toBe(201);
    expect(good.body.data.direction).toBe('incoming');
    expect(good.body.data.durationSec).toBe(120);
    acts.push(good.body.data.uid);
  });
});

describe('доступ', () => {
  it('кладовщик задач не видит и не заводит', async () => {
    expect((await get('/api/v1/crm/tasks', keeper)).status).toBe(403);
    expect(
      (await post('/api/v1/crm/tasks', keeper, { typeUid: typeUid.call, title: 'x', dueAt: inDays(1), partnerUid })).status,
    ).toBe(403);
  });

  it('задачу чужой компании не видно', async () => {
    const other = admin.companies.find((c: any) => c.code !== 'trade');
    const t = await newTask({ title: `QA Чужая ${stamp}` });
    expect((await get(`/api/v1/crm/tasks/${t.uid}`, admin, other.uid)).status).toBe(404);
  });
});
