/**
 * Вложения к операциям: приложение целиком, живая база (ТЗ 5.4, 5.6, 6.3).
 *
 * Проверяем круг, а не коды ответов: приложили фото к движению — оно видно в
 * карточке, скачивается тем же байтом, считается тем же хешем, чужой компании
 * не видно, кладовщик без права финансов к платежу его не приложит, а удаление
 * убирает и описание, и файл с диска.
 *
 * Прогон пишет: после него в базе остаются только те вложения, которые он сам
 * же и удалил. Каталог хранилища на время прогона свой, в системном временном.
 */
import 'dotenv/config';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
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
import { WarehouseModule } from '../src/warehouse/warehouse.module.js';
import { FinanceModule } from '../src/finance/finance.module.js';
import { AttachmentsModule } from '../src/attachments/attachments.module.js';
import { ContextMiddleware } from '../src/common/context.middleware.js';
import { EnvelopeInterceptor } from '../src/common/envelope.interceptor.js';
import { ErrorFilter } from '../src/common/error.filter.js';

let app: INestApplication;
let base: string;
let db: Client;
let storageRoot: string;

const PASSWORD = process.env.SEED_PASSWORD ?? 'metall-dev-2026';

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  return {
    status: res.status,
    body: text ? (JSON.parse(text) as any) : null,
    headers: res.headers,
  };
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
  return res.body.data as { token: string; permissions: string[] };
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Наименьший настоящий PNG: 1×1, прозрачный. Бинарь, а не текст с расширением. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');

const upload = (
  token: string,
  q: Record<string, string>,
  bytes: Buffer,
  mime = 'image/png',
) =>
  api(`/api/v1/attachments?${new URLSearchParams(q).toString()}`, {
    method: 'POST',
    headers: { ...auth(token), 'Content-Type': mime },
    body: new Uint8Array(bytes),
  });

const list = (token: string, owner: string, uid: string) =>
  api(`/api/v1/attachments?owner=${owner}&uid=${uid}`, { headers: auth(token) });

let admin: Awaited<ReturnType<typeof login>>;
let keeper: Awaited<ReturnType<typeof login>>;
/** Человек только завода — на нём проверяется изоляция по компании. */
let plantOnly: Awaited<ReturnType<typeof login>>;
let accountant: Awaited<ReturnType<typeof login>>;

let tradeMoveUid: string;
let tradeBatchUid: string;
let financeUid: string;

beforeAll(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), 'metall-attachments-'));
  process.env.ATTACHMENTS_DIR = storageRoot;

  const moduleRef = await Test.createTestingModule({
    imports: [PrismaModule, AuthModule, WarehouseModule, FinanceModule, AttachmentsModule],
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
  keeper = await login('a.saidov');
  plantOnly = await login('b.ergashev');
  accountant = await login('m.rahimova');

  const moves = await api('/api/v1/warehouse/moves?limit=200', { headers: auth(keeper.token) });
  expect(moves.status).toBe(200);
  const TRADE = new Set(['ERKIN', 'SERGELI']);
  const tradeMove = (moves.body.data.rows as any[]).find(
    (m) =>
      m.batch &&
      (TRADE.has(m.fromWarehouse?.code) || TRADE.has(m.toWarehouse?.code)),
  );
  if (!tradeMove) throw new Error('в движениях торговой конторы нет строки с партией');
  tradeMoveUid = tradeMove.uid;

  const stock = await api('/api/v1/warehouse/stock?limit=200', { headers: auth(keeper.token) });
  const withBatch = (stock.body.data.rows as any[]).find(
    (r) => r.batch && ['ERKIN', 'SERGELI'].includes(r.warehouse.code),
  );
  tradeBatchUid = withBatch.batch.uid;

  const ops = await api('/api/v1/finance/operations?limit=50', { headers: auth(accountant.token) });
  expect(ops.status).toBe(200);
  financeUid = (ops.body.data.rows as any[])[0].uid;
}, 60_000);

afterAll(async () => {
  await db?.end();
  await app?.close();
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
});

describe('вложение к складской операции', () => {
  let uid: string;

  it('прикладывается и попадает в карточку движения', async () => {
    const res = await upload(keeper.token, {
      owner: 'stock_move',
      uid: tradeMoveUid,
      name: 'фото приёмки.png',
      kind: 'photo',
      comment: 'штабель у ворот',
    }, PNG);
    expect(res.status).toBe(201);
    uid = res.body.data.uid;
    expect(res.body.data).toMatchObject({
      kind: 'photo',
      fileName: 'фото приёмки.png',
      mimeType: 'image/png',
      sizeBytes: PNG.length,
      comment: 'штабель у ворот',
      disposition: 'inline',
    });
    expect(res.body.data.sha256).toBe(createHash('sha256').update(PNG).digest('hex'));
    expect(res.body.data.author).toBeTruthy();

    const after = await list(keeper.token, 'stock_move', tradeMoveUid);
    expect(after.body.data.map((a: any) => a.uid)).toContain(uid);
  });

  it('скачивается тем же байтом и с именем файла в заголовке', async () => {
    const res = await fetch(`${base}/api/v1/attachments/${uid}/file`, {
      headers: auth(keeper.token),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const disposition = res.headers.get('content-disposition') ?? '';
    expect(disposition.startsWith('inline;')).toBe(true);
    expect(disposition).toContain("filename*=UTF-8''");
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.equals(PNG)).toBe(true);
  });

  it('файл лёг в хранилище под ключом компании и года, без имени файла', async () => {
    const rows = await db.query('SELECT storage_key FROM attachment WHERE uid = $1', [uid]);
    const key: string = rows.rows[0].storage_key;
    expect(key).toMatch(/^\d+\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.png$/);
    expect(key).not.toContain('фото');
    const st = await stat(join(storageRoot, key));
    expect(st.size).toBe(PNG.length);
  });

  it('чужой компании вложение не видно вовсе', async () => {
    const res = await list(plantOnly.token, 'stock_move', tradeMoveUid);
    // Само движение торговой конторы человеку завода не видно — значит и
    // спрашивать его вложения нечего: 404, а не пустой список.
    expect(res.status).toBe(404);
  });

  it('удаление убирает и описание, и файл с диска', async () => {
    const rows = await db.query('SELECT storage_key FROM attachment WHERE uid = $1', [uid]);
    const key: string = rows.rows[0].storage_key;

    const res = await api(`/api/v1/attachments/${uid}`, {
      method: 'DELETE',
      headers: auth(keeper.token),
    });
    expect(res.status).toBe(200);

    const left = await db.query('SELECT 1 FROM attachment WHERE uid = $1', [uid]);
    expect(left.rowCount).toBe(0);
    await expect(stat(join(storageRoot, key))).rejects.toThrow();
  });
});

describe('сертификат качества партии (ТЗ 5.6)', () => {
  it('pdf прикладывается к партии и отдаётся файлом, а не в странице', async () => {
    const res = await upload(
      keeper.token,
      { owner: 'batch', uid: tradeBatchUid, name: 'сертификат.pdf', kind: 'certificate' },
      PDF,
      'application/pdf',
    );
    expect(res.status).toBe(201);
    expect(res.body.data.disposition).toBe('attachment');

    const file = await fetch(`${base}/api/v1/attachments/${res.body.data.uid}/file`, {
      headers: auth(keeper.token),
    });
    expect(file.headers.get('content-disposition')?.startsWith('attachment;')).toBe(true);

    await api(`/api/v1/attachments/${res.body.data.uid}`, {
      method: 'DELETE',
      headers: auth(keeper.token),
    });
  });
});

describe('право спрашивается по владельцу', () => {
  it('кладовщик не приложит скан к финансовой операции', async () => {
    const res = await upload(
      keeper.token,
      { owner: 'finance_operation', uid: financeUid, name: 'накладная.pdf' },
      PDF,
      'application/pdf',
    );
    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain('finance.post');
  });

  it('бухгалтер приложит и увидит', async () => {
    const res = await upload(
      accountant.token,
      { owner: 'finance_operation', uid: financeUid, name: 'чек.png' },
      PNG,
    );
    expect(res.status).toBe(201);
    expect(res.body.data.kind).toBe('photo');

    const seen = await list(accountant.token, 'finance_operation', financeUid);
    expect(seen.body.data.map((a: any) => a.uid)).toContain(res.body.data.uid);

    await api(`/api/v1/attachments/${res.body.data.uid}`, {
      method: 'DELETE',
      headers: auth(accountant.token),
    });
  });
});

describe('что не принимаем', () => {
  it('html не пройдёт: он исполняется в нашем источнике', async () => {
    const res = await upload(
      admin.token,
      { owner: 'stock_move', uid: tradeMoveUid, name: 'x.html' },
      Buffer.from('<script>alert(1)</script>'),
      'text/html',
    );
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('не принимаем');
  });

  it('пустое тело — отказ, а не вложение нулевого размера', async () => {
    const res = await upload(
      admin.token,
      { owner: 'stock_move', uid: tradeMoveUid, name: 'pusto.png' },
      Buffer.alloc(0),
    );
    expect(res.status).toBe(422);
  });

  it('файл тяжелее предела не проходит', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(20 * 1024 * 1024)]);
    const res = await upload(
      admin.token,
      { owner: 'stock_move', uid: tradeMoveUid, name: 'tyazhelo.png' },
      big,
    );
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('предел 20 МБ');
  }, 30_000);

  it('вложение к чужому владельцу не заводится', async () => {
    const res = await upload(
      admin.token,
      { owner: 'stock_move', uid: '00000000-0000-4000-8000-000000000000', name: 'x.png' },
      PNG,
    );
    expect(res.status).toBe(404);
  });

  it('после отказов в хранилище не осталось мусора', async () => {
    const stray = await readdir(storageRoot, { recursive: true });
    const files = stray.filter((n) => typeof n === 'string' && /\.(png|pdf)$/.test(n));
    expect(files).toEqual([]);
  });
});
