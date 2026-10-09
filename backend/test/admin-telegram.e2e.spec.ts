/**
 * Привязка Telegram к учётке (ТЗ 11.2, общие правила 6.7).
 *
 * Код выдаёт администратор, вводит его человек в боте. Проверяется то, из-за
 * чего эту привязку нельзя делать «на доверии»: код живёт минуты, виден один
 * раз, в базе лежит хешем, второй выданный код гасит первый, один аккаунт
 * Telegram не может работать за двоих, а отключение доступно администратору
 * всегда — телефоны теряют.
 *
 * `claim` зовётся как служба, а не маршрутом: его позовёт процесс бота, который
 * узнаёт `telegram_user_id` от самого Telegram. Открытый маршрут означал бы,
 * что подключиться может любой, кто угадал короткий код.
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { Client } from 'pg';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { AuthGuard } from '../src/auth/auth.guard.js';
import { AdminModule } from '../src/admin/admin.module.js';
import { TelegramLinkService } from '../src/admin/telegram-link.service.js';
import { ContextMiddleware } from '../src/common/context.middleware.js';
import { EnvelopeInterceptor } from '../src/common/envelope.interceptor.js';
import { ErrorFilter } from '../src/common/error.filter.js';
import { runWithContext } from '../src/common/request-context.js';

let app: INestApplication;
let base: string;
let db: Client;
let link: TelegramLinkService;

const PASSWORD = process.env.SEED_PASSWORD ?? 'metall-dev-2026';
/** Номера аккаунтов Telegram для проверок: заведомо не чьи-то настоящие. */
const TG_ONE = 990000001n;
const TG_TWO = 990000002n;

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
    throw new Error(`Логин ${loginName} не прошёл: ${res.status}`);
  }
  return res.body.data as { token: string; companies: { uid: string }[]; permissions: string[] };
}

const auth = (token: string, companyUids?: string[]) => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${token}`,
  ...(companyUids?.length ? { 'X-Company-Id': companyUids.join(',') } : {}),
});

let admin: Awaited<ReturnType<typeof login>>;
let keeper: Awaited<ReturnType<typeof login>>;
let company: string;
/** Два человека, на которых проверяем: оба возвращаются в исходное состояние. */
let alice: { uid: string; login: string };
let bob: { uid: string; login: string };

/** Выдача кода администратором: один вызов, он же возвращает код. */
async function issue(uid: string, token = admin.token) {
  return api(`/api/v1/admin/users/${uid}/telegram/code`, {
    method: 'POST',
    headers: auth(token, [company]),
  });
}

/** Привязка от имени бота: контекст запроса ему не нужен, компания — для журнала. */
async function claim(code: string, tg: bigint) {
  const companyId = await db
    .query('SELECT id FROM company WHERE uid = $1', [company])
    .then((r) => BigInt(r.rows[0].id));
  return link.claim(code, tg, companyId);
}

async function userRow(uid: string) {
  const r = await db.query(
    `SELECT telegram_user_id::text AS tg, telegram_linked_at FROM user_account WHERE uid = $1`,
    [uid],
  );
  return r.rows[0] as { tg: string | null; telegram_linked_at: Date | null };
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [PrismaModule, AuthModule, AdminModule],
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
  link = app.get(TelegramLinkService);

  db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  admin = await login('admin');
  keeper = await login('a.saidov');
  company = admin.companies[0]!.uid;

  const people = await db.query(
    `SELECT uid, login FROM user_account WHERE is_active AND telegram_user_id IS NULL
      ORDER BY login LIMIT 2`,
  );
  alice = people.rows[0];
  bob = people.rows[1];
}, 60_000);

afterAll(async () => {
  for (const u of [alice, bob]) {
    if (!u) continue;
    await db
      ?.query(
        `UPDATE user_account SET telegram_user_id = NULL, telegram_linked_at = NULL WHERE uid = $1`,
        [u.uid],
      )
      .catch(() => {});
    await db
      ?.query(
        `DELETE FROM telegram_link_code WHERE user_id = (SELECT id FROM user_account WHERE uid = $1)`,
        [u.uid],
      )
      .catch(() => {});
  }
  await app?.close();
  await db?.end();
});

describe('выдача кода', () => {
  it('отдаёт код один раз, в базе — только хеш', async () => {
    const res = await issue(alice.uid);
    expect(res.status).toBe(201);
    const code = res.body.data.code as string;
    expect(code, 'код из восьми знаков парами').toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(res.body.data.ttlMinutes).toBe(15);
    const left = new Date(res.body.data.expiresAt).getTime() - Date.now();
    expect(left).toBeGreaterThan(13 * 60_000);
    expect(left).toBeLessThanOrEqual(15 * 60_000);

    const rows = await db.query(
      `SELECT c.code_hash FROM telegram_link_code c
        JOIN user_account u ON u.id = c.user_id
       WHERE u.uid = $1 AND c.used_at IS NULL AND c.revoked_at IS NULL`,
      [alice.uid],
    );
    expect(rows.rowCount).toBe(1);
    const bare = code.replace('-', '');
    expect(rows.rows[0].code_hash).toBe(createHash('sha256').update(bare).digest('hex'));
    // Открытого кода в таблице нет ни в каком виде.
    expect(rows.rows[0].code_hash).not.toContain(bare);

    const log = await db.query(
      `SELECT action, changes FROM audit_log WHERE entity_type = 'user_telegram' AND entity_id = $1`,
      [alice.uid],
    );
    expect(log.rows.map((r) => r.action)).toContain('code_issued');
    // Код в журнал не попал: это секрет, а не след действия.
    expect(JSON.stringify(log.rows)).not.toContain(bare);
  });

  it('новый код гасит прежний', async () => {
    const first = await issue(alice.uid);
    const second = await issue(alice.uid);
    expect(second.status).toBe(201);
    expect(second.body.data.code).not.toBe(first.body.data.code);

    await expect(claim(first.body.data.code, TG_ONE)).rejects.toThrow(/не действует/i);
    const row = await userRow(alice.uid);
    expect(row.tg).toBeNull();
  });

  it('в списке людей видно, что код выдан и до какого времени', async () => {
    await issue(alice.uid);
    const list = await api('/api/v1/admin/users?limit=200', {
      headers: auth(admin.token, [company]),
    });
    expect(list.status).toBe(200);
    const row = list.body.data.rows.find((r: any) => r.uid === alice.uid);
    expect(row.telegram.linked).toBe(false);
    expect(row.telegram.userId).toBeNull();
    expect(row.telegram.codeExpiresAt, 'срок живого кода в списке').not.toBeNull();
  });

  it('кладовщику выдавать код нельзя', async () => {
    expect(keeper.permissions).not.toContain('admin.users');
    const res = await issue(alice.uid, keeper.token);
    expect(res.status).toBe(403);
  });

  it('отключённой учётке код не выдаётся', async () => {
    await db.query(`UPDATE user_account SET is_active = false WHERE uid = $1`, [bob.uid]);
    try {
      const res = await issue(bob.uid);
      expect(res.status).toBe(422);
      expect(res.body.error.message).toMatch(/отключена/i);
    } finally {
      await db.query(`UPDATE user_account SET is_active = true WHERE uid = $1`, [bob.uid]);
    }
  });
});

describe('привязка и отключение', () => {
  it('код подключает аккаунт, набор без дефиса и в нижнем регистре тоже', async () => {
    const res = await issue(alice.uid);
    const code = res.body.data.code as string;
    const typed = code.replace('-', ' ').toLowerCase();
    const got = await claim(typed, TG_ONE);
    expect(got.linked).toBe(true);
    expect(got.uid).toBe(alice.uid);

    const row = await userRow(alice.uid);
    expect(row.tg).toBe(String(TG_ONE));
    expect(row.telegram_linked_at).not.toBeNull();

    const used = await db.query(
      `SELECT c.used_at FROM telegram_link_code c JOIN user_account u ON u.id = c.user_id
        WHERE u.uid = $1 ORDER BY c.id DESC LIMIT 1`,
      [alice.uid],
    );
    expect(used.rows[0].used_at).not.toBeNull();

    // Запись о привязке в журнале — с пометкой, что пришло из бота.
    const log = await db.query(
      `SELECT action, source::text AS source FROM audit_log
        WHERE entity_type = 'user_telegram' AND entity_id = $1 AND action = 'link'`,
      [alice.uid],
    );
    expect(log.rowCount).toBeGreaterThan(0);
    expect(log.rows[0].source).toBe('bot');
  });

  it('тот же код второй раз не работает', async () => {
    const res = await issue(bob.uid);
    const code = res.body.data.code as string;
    await claim(code, TG_TWO);
    await expect(claim(code, TG_TWO)).rejects.toThrow(/не действует/i);
  });

  it('один аккаунт Telegram не работает за двоих', async () => {
    // alice уже на TG_ONE. Освобождаем bob и пробуем привязать его к тому же.
    await db.query(
      `UPDATE user_account SET telegram_user_id = NULL, telegram_linked_at = NULL WHERE uid = $1`,
      [bob.uid],
    );
    const res = await issue(bob.uid);
    await expect(claim(res.body.data.code, TG_ONE)).rejects.toThrow(/уже привязан/i);
    expect((await userRow(bob.uid)).tg).toBeNull();
  });

  it('подключённому второй код не выдаётся', async () => {
    const res = await issue(alice.uid);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/уже подключ/i);
  });

  it('просроченный код не подключает', async () => {
    await db.query(
      `UPDATE user_account SET telegram_user_id = NULL, telegram_linked_at = NULL WHERE uid = $1`,
      [bob.uid],
    );
    const res = await issue(bob.uid);
    const code = res.body.data.code as string;
    await db.query(
      `UPDATE telegram_link_code SET expires_at = now() - interval '1 minute'
        WHERE user_id = (SELECT id FROM user_account WHERE uid = $1) AND used_at IS NULL`,
      [bob.uid],
    );
    await expect(claim(code, TG_TWO)).rejects.toThrow(/не действует/i);
    expect((await userRow(bob.uid)).tg).toBeNull();
  });

  it('отключение снимает привязку, пишет в журнал и освобождает аккаунт', async () => {
    const off = await api(`/api/v1/admin/users/${alice.uid}/telegram`, {
      method: 'DELETE',
      headers: auth(admin.token, [company]),
    });
    expect(off.status).toBe(200);
    const row = await userRow(alice.uid);
    expect(row.tg).toBeNull();
    expect(row.telegram_linked_at).toBeNull();

    const log = await db.query(
      `SELECT action FROM audit_log WHERE entity_type = 'user_telegram' AND entity_id = $1`,
      [alice.uid],
    );
    expect(log.rows.map((r) => r.action)).toContain('unlink');

    // Отключать нечего — отказ, а не молчание.
    const again = await api(`/api/v1/admin/users/${alice.uid}/telegram`, {
      method: 'DELETE',
      headers: auth(admin.token, [company]),
    });
    expect(again.status).toBe(422);

    // Освободившийся аккаунт теперь можно привязать другому человеку.
    const res = await issue(bob.uid);
    const got = await claim(res.body.data.code, TG_ONE);
    expect(got.uid).toBe(bob.uid);
    expect((await userRow(bob.uid)).tg).toBe(String(TG_ONE));
  });

  it('кладовщику отключать нельзя', async () => {
    const res = await api(`/api/v1/admin/users/${bob.uid}/telegram`, {
      method: 'DELETE',
      headers: auth(keeper.token, [company]),
    });
    expect(res.status).toBe(403);
  });

  it('выдуманный код не подключает ничего', async () => {
    await expect(claim('AAAA-AAAA', 990000009n)).rejects.toThrow(/не найден|не действует/i);
    await expect(claim('КОРОТКО', 990000009n)).rejects.toThrow(/восьми знаков/i);
  });
});
