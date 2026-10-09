/**
 * «Забыли пароль» — заявка, а не сброс.
 *
 * Проверяется ровно то, чем этот маршрут опасен, если сделать его наивно:
 *
 * 1. **Пароль не меняется.** Заявка кладётся в очередь; учётка продолжает
 *    жить со старым паролем, пока администратор не выдаст новый руками.
 * 2. **Логины не перечисляются.** Ответ на выдуманный логин неотличим от
 *    ответа на настоящий — иначе форма становится справочником учёток.
 * 3. **Очередь не топится.** Десять нажатий дают одну открытую заявку.
 * 4. **Очередь закрыта.** Список видит только `admin.users`; директор — нет.
 *
 * Прогон убирает за собой свои заявки.
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
import { ContextMiddleware } from '../src/common/context.middleware.js';
import { EnvelopeInterceptor } from '../src/common/envelope.interceptor.js';
import { ErrorFilter } from '../src/common/error.filter.js';

let app: INestApplication;
let base: string;
let db: Client;

const PASSWORD = process.env.SEED_PASSWORD ?? 'metall-dev-2026';
const stamp = String(Date.now()).slice(-6);
/** Логин, которого нет ни у кого: на нём проверяется неразличимость ответа. */
const GHOST = `qa-ghost-${stamp}`;
const REAL = 'd.karimov';

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
  return res.body.data as { token: string; permissions: string[] };
}

let admin: Awaited<ReturnType<typeof login>>;
let director: Awaited<ReturnType<typeof login>>;

const head = (s: typeof admin) => ({
  Authorization: `Bearer ${s.token}`,
  'Content-Type': 'application/json',
});

const ask = (body: unknown) =>
  api('/api/v1/auth/password-reset-request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const queue = (s = admin, status = 'new') =>
  api(`/api/v1/auth/password-reset-requests?status=${status}`, { headers: head(s) });

const mine = (rows: any[]) => rows.filter((r: any) => r.login === GHOST || r.login === REAL);

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [PrismaModule, AuthModule],
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
  await db.query(`DELETE FROM password_reset_request WHERE login IN ($1, $2)`, [GHOST, REAL]);

  admin = await login('admin');
  director = await login('s.radjabov');
}, 120_000);

afterAll(async () => {
  await db?.query(`DELETE FROM password_reset_request WHERE login IN ($1, $2)`, [GHOST, REAL]);
  await db?.end();
  await app?.close();
});

describe('заявка на сброс пароля', () => {
  it('принимается без входа в систему', async () => {
    const res = await ask({ login: REAL, contact: '+998 90 123-45-67', note: 'забыл пароль' });
    expect(res.status).toBe(201);
    expect(res.body.data.accepted).toBe(true);
  });

  it('пароль от заявки не меняется: учётка живёт со старым', async () => {
    const before = await login(REAL);
    expect(before.token).toBeTruthy();
    await ask({ login: REAL, contact: '+998 90 123-45-67' });
    const after = await login(REAL);
    expect(after.token).toBeTruthy();
  });

  it('выдуманный логин отвечает тем же, чем настоящий', async () => {
    const ghost = await ask({ login: GHOST, contact: 'ghost@example.com' });
    const real = await ask({ login: REAL, contact: '+998 90 123-45-67' });
    expect(ghost.status).toBe(real.status);
    expect(ghost.body.data).toEqual(real.body.data);
  });

  it('повторное нажатие не плодит заявок — одна открытая на логин', async () => {
    for (const contact of ['раз@example.com', 'два@example.com', 'три@example.com']) {
      expect((await ask({ login: GHOST, contact })).status).toBe(201);
    }
    const rows = (await queue()).body.data.rows.filter((r: any) => r.login === GHOST);
    expect(rows).toHaveLength(1);
    // Обновилась именно та же заявка: в ней последний контакт, а не первый.
    expect(rows[0].contact).toBe('три@example.com');
  });

  it('пустой контакт не принимается: заявку некуда возвращать', async () => {
    expect((await ask({ login: GHOST, contact: '' })).status).toBe(400);
  });

  it('очередь закрыта: без admin.users — 403', async () => {
    expect(director.permissions).not.toContain('admin.users');
    expect((await queue(director)).status).toBe(403);
    expect((await queue(admin)).status).toBe(200);
  });

  it('в очереди видно, есть ли такая учётка на самом деле', async () => {
    const rows = mine((await queue()).body.data.rows);
    expect(rows.find((r: any) => r.login === REAL).known).toBe(true);
    expect(rows.find((r: any) => r.login === GHOST).known).toBe(false);
    expect(rows.find((r: any) => r.login === REAL).fullName).toBeTruthy();
  });

  it('закрытая заявка уходит из очереди и помнит, кто её закрыл', async () => {
    const row = (await queue()).body.data.rows.find((r: any) => r.login === GHOST);
    const done = await api(`/api/v1/auth/password-reset-requests/${row.uid}`, {
      method: 'POST',
      headers: head(admin),
      body: JSON.stringify({ action: 'done', note: 'выдал новый пароль лично' }),
    });
    expect(done.status).toBe(201);

    const open = (await queue()).body.data.rows.filter((r: any) => r.login === GHOST);
    expect(open).toHaveLength(0);

    const all = (await queue(admin, 'all')).body.data.rows.find((r: any) => r.login === GHOST);
    expect(all.status).toBe('done');
    expect(all.handledBy).toBeTruthy();
    expect(all.handledAt).toBeTruthy();
    expect(all.handledNote).toBe('выдал новый пароль лично');
  });

  it('закрыть дважды нельзя', async () => {
    const row = (await queue(admin, 'all')).body.data.rows.find((r: any) => r.login === GHOST);
    const again = await api(`/api/v1/auth/password-reset-requests/${row.uid}`, {
      method: 'POST',
      headers: head(admin),
      body: JSON.stringify({ action: 'done' }),
    });
    expect(again.status).toBe(409);
  });

  it('закрытие чужими руками не проходит', async () => {
    const row = (await queue(admin, 'all')).body.data.rows.find((r: any) => r.login === REAL);
    const res = await api(`/api/v1/auth/password-reset-requests/${row.uid}`, {
      method: 'POST',
      headers: head(director),
      body: JSON.stringify({ action: 'rejected' }),
    });
    expect(res.status).toBe(403);
  });
});
