/**
 * Вложения к производственному заданию и к документу (ТЗ 4.1, 7.1).
 *
 * Круг тот же, что у складских вложений: приложили — видно в карточке,
 * скачивается тем же байтом, чужой компании не отдаётся, и право спрашивается
 * по владельцу. Фото брака в цеху и скан подписанного акта — разные документы
 * и разные люди, поэтому и права разные.
 */
import 'dotenv/config';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { raw } from 'express';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { AuthGuard } from '../src/auth/auth.guard.js';
import { AttachmentsModule } from '../src/attachments/attachments.module.js';
import { ContextMiddleware } from '../src/common/context.middleware.js';
import { EnvelopeInterceptor } from '../src/common/envelope.interceptor.js';
import { ErrorFilter } from '../src/common/error.filter.js';

let app: INestApplication;
let base: string;
let db: Client;
let storageRoot: string;

const PASSWORD = process.env.SEED_PASSWORD ?? 'metall-dev-2026';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as any) : null, headers: res.headers };
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
  return res.body.data as { token: string; permissions: string[] };
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

const upload = (token: string, q: Record<string, string>, bytes: Buffer, mime = 'image/png') =>
  api(`/api/v1/attachments?${new URLSearchParams(q).toString()}`, {
    method: 'POST',
    headers: { ...auth(token), 'Content-Type': mime },
    body: new Uint8Array(bytes),
  });

const list = (token: string, owner: string, uid: string) =>
  api(`/api/v1/attachments?owner=${owner}&uid=${uid}`, { headers: auth(token) });

/**
 * Этап задания завода. Берётся запросом внутри проверки, а не в `beforeAll`:
 * пока у этапа нет своего uid, падать должны проверки этапа, а не весь файл
 * вместе с вложениями заказа и документа.
 */
async function firstStageUid(): Promise<string> {
  const r = await db.query<{ uid: string }>(
    `SELECT s.uid FROM production_stage s
       JOIN production_order o ON o.id = s.production_order_id
       JOIN company c ON c.id = o.company_id
      WHERE c.code = 'plant' ORDER BY s.id LIMIT 1`,
  );
  if (!r.rows[0]) throw new Error('в сиде нет ни одного этапа задания завода');
  return r.rows[0].uid;
}

let admin: Awaited<ReturnType<typeof login>>;
let master: Awaited<ReturnType<typeof login>>;
let keeper: Awaited<ReturnType<typeof login>>;
let accountant: Awaited<ReturnType<typeof login>>;

let orderUid: string;
let documentUid: string;
/** Задание завода и документ торговой: изоляция проверяется на них. */
let tradeDocOfOtherCompany: string;
const made: string[] = [];

beforeAll(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), 'metall-attach-owners-'));
  process.env.ATTACHMENTS_DIR = storageRoot;

  const moduleRef = await Test.createTestingModule({
    imports: [PrismaModule, AuthModule, AttachmentsModule],
    providers: [
      { provide: APP_GUARD, useClass: AuthGuard },
      { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
      { provide: APP_FILTER, useClass: ErrorFilter },
    ],
  }).compile();

  app = moduleRef.createNestApplication();
  app.use(new ContextMiddleware().use.bind(new ContextMiddleware()));
  app.use('/api/v1/attachments', raw({ type: () => true, limit: '21mb' }));
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();

  db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  admin = await login('admin');
  master = await login('j.tashpulatov');
  keeper = await login('a.saidov');
  accountant = await login('m.rahimova');

  const order = await db.query<{ uid: string }>(
    `SELECT o.uid FROM production_order o JOIN company c ON c.id = o.company_id
      WHERE c.code = 'plant' ORDER BY o.id LIMIT 1`,
  );
  orderUid = order.rows[0].uid;

  const doc = await db.query<{ uid: string }>(
    `SELECT d.uid FROM document d JOIN company c ON c.id = d.company_id
      WHERE c.code = 'trade' ORDER BY d.id LIMIT 1`,
  );
  documentUid = doc.rows[0].uid;
  tradeDocOfOtherCompany = documentUid;
}, 60_000);

afterAll(async () => {
  for (const uid of made) {
    await api(`/api/v1/attachments/${uid}`, { method: 'DELETE', headers: auth(admin.token) });
  }
  await app?.close();
  await db?.end();
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
});

describe('вложения к производственному заданию', () => {
  it('мастер прикладывает фото, и оно видно в карточке задания', async () => {
    const res = await upload(
      master.token,
      { owner: 'production_order', uid: orderUid, name: 'brak.png', kind: 'photo' },
      PNG,
    );
    expect(res.status).toBe(201);
    made.push(res.body.data.uid);

    const seen = await list(master.token, 'production_order', orderUid);
    expect(seen.status).toBe(200);
    expect((seen.body.data as any[]).some((r) => r.uid === res.body.data.uid)).toBe(true);
  });

  it('файл отдаётся тем же байтом', async () => {
    const res = await upload(
      master.token,
      { owner: 'production_order', uid: orderUid, name: 'etap.png' },
      PNG,
    );
    expect(res.status).toBe(201);
    made.push(res.body.data.uid);

    const file = await fetch(`${base}/api/v1/attachments/${res.body.data.uid}/file`, {
      headers: auth(master.token),
    });
    expect(file.status).toBe(200);
    expect(Buffer.from(await file.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it('бухгалтер без права на производство вложений задания не видит', async () => {
    // Кладовщик производство видит — ему выдавать материалы в цех. Право
    // спрашивается по владельцу вложения, поэтому берём роль, у которой
    // производства нет вовсе.
    const res = await list(accountant.token, 'production_order', orderUid);
    expect(res.status).toBe(403);
  });

  it('документа чужой компании не существует для того, кто её не видит', async () => {
    // У менеджера завода право на документы есть, а торговой компании он не
    // видит: ответ должен быть «нет такого», а не «не твоё».
    const plantOnly = await login('b.ergashev');
    const res = await list(plantOnly.token, 'document', tradeDocOfOtherCompany);
    expect(res.status).toBe(404);
  });
});

/**
 * Фото к этапу, а не к заданию целиком (ТЗ 4.1).
 *
 * У задания из пяти этапов снимок «вот эта раковина» без этапа отвечает на
 * вопрос «в каком задании», но не на вопрос «на какой операции». Разрез по
 * этапу и есть то, зачем мастер снимает: на следующем заказе по той же карте
 * смотрят, что было на этой же операции.
 */
describe('вложения к этапу задания', () => {
  it('мастер прикладывает фото к этапу, и оно видно у этапа', async () => {
    const stageUid = await firstStageUid();
    const res = await upload(
      master.token,
      { owner: 'production_stage', uid: stageUid, name: 'zamer.png', kind: 'photo' },
      PNG,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    made.push(res.body.data.uid);

    const seen = await list(master.token, 'production_stage', stageUid);
    expect(seen.status).toBe(200);
    expect((seen.body.data as any[]).some((r) => r.uid === res.body.data.uid)).toBe(true);
  });

  it('фото этапа не подмешивается в файлы задания: это разные карточки', async () => {
    const stageUid = await firstStageUid();
    const res = await upload(
      master.token,
      { owner: 'production_stage', uid: stageUid, name: 'tolko-etap.png' },
      PNG,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    made.push(res.body.data.uid);

    // Этап, который взят, принадлежит первому заданию завода — тому же, по
    // которому идут проверки выше. Если бы список заказа собирал и файлы
    // этапов, снимок операции всплыл бы в карточке задания.
    const atOrder = await list(master.token, 'production_order', orderUid);
    expect(atOrder.status).toBe(200);
    expect((atOrder.body.data as any[]).some((r) => r.uid === res.body.data.uid)).toBe(false);
  });

  it('бухгалтер без права на производство фото этапа не видит', async () => {
    const stageUid = await firstStageUid();
    expect((await list(accountant.token, 'production_stage', stageUid)).status).toBe(403);
  });

  it('несуществующий этап — 404, а не пустой список', async () => {
    const res = await list(admin.token, 'production_stage', '00000000-0000-4000-8000-000000000000');
    expect(res.status).toBe(404);
    expect(String(res.body.error.message)).toContain('тап');
  });
});

describe('вложения к документу', () => {
  it('бухгалтер прикладывает скан, и его видно', async () => {
    const res = await upload(
      accountant.token,
      { owner: 'document', uid: documentUid, name: 'akt.pdf', kind: 'scan' },
      PDF,
      'application/pdf',
    );
    expect(res.status).toBe(201);
    made.push(res.body.data.uid);

    const seen = await list(accountant.token, 'document', documentUid);
    expect(seen.status).toBe(200);
    expect((seen.body.data as any[]).some((r) => r.fileName === 'akt.pdf')).toBe(true);
  });

  it('кладовщик документов не видит', async () => {
    const res = await list(keeper.token, 'document', documentUid);
    expect(res.status).toBe(403);
  });

  it('несуществующий документ — 404, а не пустой список', async () => {
    const res = await list(admin.token, 'document', '00000000-0000-4000-8000-000000000000');
    expect(res.status).toBe(404);
    expect(String(res.body.error.message)).toContain('окумент');
  });

  it('придуманный вид владельца не принимается', async () => {
    const res = await list(admin.token, 'invoice', documentUid);
    expect(res.status).toBe(400);
  });
});
