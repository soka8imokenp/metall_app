/**
 * Мобильное приложение со стороны сервера (ТЗ 10, 02-ARCHITECTURE 7.1,
 * контракт §1.6 и §2, 06-BACKEND §7).
 *
 * Проверяется поведение целиком, на живой базе:
 *   - вход браузера и телефона: у телефона короткий токен и refresh-токен;
 *   - обновление одноразовое: старый refresh-токен после обновления не годится;
 *   - выход и отзыв сессии действуют сразу, а не когда истечёт токен;
 *   - отзыв телефона администратором закрывает его сессии и не пускает вход;
 *   - действия с телефона пишутся в журнал с источником `mobile`;
 *   - запись с телефона без ключа повтора отклоняется, повтор с ключом
 *     возвращает тот же ответ и не выполняется второй раз;
 *   - push берёт строки той же очереди, что Telegram, и шлёт только на живые
 *     телефоны, а мёртвый адрес стирает.
 *
 * Прогон заводит свои учётки с меткой времени и выключает их за собой.
 */
import 'dotenv/config';
import { Client } from 'pg';
import * as bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { PushModule } from '../src/push/push.module.js';
import { PUSH_SEND, PushService, type PushMessage, type PushTicket } from '../src/push/push.service.js';
import { AuthGuard } from '../src/auth/auth.guard.js';
import { ContextMiddleware } from '../src/common/context.middleware.js';
import { EnvelopeInterceptor } from '../src/common/envelope.interceptor.js';
import { IdempotencyInterceptor } from '../src/common/idempotency.interceptor.js';
import { ErrorFilter } from '../src/common/error.filter.js';

let app: INestApplication;
let base: string;
let db: Client;
let push: PushService;

const stamp = Date.now().toString().slice(-7);
const WORKER = `tmp_mob_${stamp}`;
const ADMIN = `tmp_mobadm_${stamp}`;
const PASSWORD = 'Temir-Quvur-2026';
const INSTALL = `inst-${randomUUID()}`;

/** Подменённая служба доставки: что ушло и что ответить. */
const sent: PushMessage[] = [];
let answer: (m: PushMessage) => PushTicket = () => ({ ok: true });

async function api(path: string, init: RequestInit & { mobile?: boolean; token?: string; key?: string } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(init.headers as Record<string, string>) };
  if (init.mobile) headers['X-Client'] = 'mobile';
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  if (init.key) headers['Idempotency-Key'] = init.key;
  const res = await fetch(`${base}${path}`, { ...init, headers });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as any) : null };
}

const mobileLogin = (login: string, installationId = INSTALL) =>
  api('/api/v1/auth/login', {
    method: 'POST',
    mobile: true,
    body: JSON.stringify({ login, password: PASSWORD, device: { installationId, platform: 'android', model: 'Test Phone', appVersion: '0.6.0' } }),
  });

async function makeUser(login: string, role: string) {
  const hash = await bcrypt.hash(PASSWORD, 4);
  const u = await db.query(
    `INSERT INTO user_account (uid, login, full_name, password_hash) VALUES (gen_random_uuid(), $1, $2, $3) RETURNING id, uid`,
    [login, `Проверка ${login}`, hash],
  );
  await db.query(
    `INSERT INTO user_role_assignment (user_id, role_id, company_id)
     SELECT $1, r.id, c.id FROM role r, company c WHERE r.code = $2 AND c.code = 'trade'`,
    [u.rows[0].id, role],
  );
  return { id: u.rows[0].id as string, uid: u.rows[0].uid as string };
}

let worker: { id: string; uid: string };
/** Настройки приложения до прогона: база общая, прогон обязан их вернуть. */
let savedConfig: unknown = null;
let admin: { id: string; uid: string };
let adminToken: string;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [PrismaModule, AuthModule, PushModule],
    providers: [
      { provide: APP_GUARD, useClass: AuthGuard },
      { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
      { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
      { provide: APP_FILTER, useClass: ErrorFilter },
    ],
  })
    .overrideProvider(PUSH_SEND)
    .useValue(async (messages: PushMessage[]) => {
      sent.push(...messages);
      return messages.map((m) => answer(m));
    })
    .compile();

  app = moduleRef.createNestApplication();
  app.use(new ContextMiddleware().use.bind(new ContextMiddleware()));
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
  push = app.get(PushService);

  db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  savedConfig = (await db.query(`SELECT value FROM app_setting WHERE key = 'mobile'`)).rows[0]?.value ?? null;
  worker = await makeUser(WORKER, 'warehouse_keeper');
  admin = await makeUser(ADMIN, 'admin');
  const r = await mobileLogin(ADMIN, `inst-adm-${stamp}-xxxxxxxx`);
  adminToken = r.body.data.token;
}, 60_000);

afterAll(async () => {
  if (savedConfig === null) await db.query(`DELETE FROM app_setting WHERE key = 'mobile'`);
  else await db.query(`UPDATE app_setting SET value = $1 WHERE key = 'mobile'`, [savedConfig]);
  await db.query('UPDATE user_account SET is_active = false WHERE login = ANY($1)', [[WORKER, ADMIN]]);
  await db.end();
  await app?.close();
});

describe('вход и сессии', () => {
  it('браузер получает токен без refresh-токена, сессия записана', async () => {
    const r = await api('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ login: WORKER, password: PASSWORD }) });
    expect(r.status).toBe(201);
    expect(r.body.data.token).toBeTruthy();
    expect(r.body.data.refreshToken).toBeUndefined();
    expect(r.body.data.expiresIn).toBe(12 * 3600);
    const row = await db.query(`SELECT client FROM auth_session WHERE uid = $1`, [r.body.data.sessionUid]);
    expect(row.rows[0].client).toBe('web');
  });

  it('телефон получает короткий токен, refresh-токен и устройство', async () => {
    const r = await mobileLogin(WORKER);
    expect(r.status).toBe(201);
    expect(r.body.data.expiresIn).toBe(15 * 60);
    expect(r.body.data.refreshToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(r.body.data.device.uid).toBeTruthy();
    // в базе — только хеш, не сам токен
    const row = await db.query(`SELECT refresh_hash FROM auth_session WHERE uid = $1`, [r.body.data.sessionUid]);
    expect(row.rows[0].refresh_hash).not.toBe(r.body.data.refreshToken);
    expect(row.rows[0].refresh_hash).toHaveLength(64);

    const list = await api('/api/v1/auth/sessions', { token: r.body.data.token });
    expect(list.status).toBe(200);
    const mine = list.body.data.find((s: any) => s.uid === r.body.data.sessionUid);
    expect(mine.current).toBe(true);
    expect(mine.device.platform).toBe('android');
  });

  it('обновление одноразовое: новый refresh-токен работает, старый — нет', async () => {
    const r = await mobileLogin(WORKER);
    const first = r.body.data.refreshToken;
    const a = await api('/api/v1/auth/refresh', { method: 'POST', body: JSON.stringify({ refreshToken: first }) });
    expect(a.status).toBe(200);
    expect(a.body.data.refreshToken).not.toBe(first);
    const me = await api('/api/v1/auth/me', { token: a.body.data.accessToken });
    expect(me.status).toBe(200);

    const again = await api('/api/v1/auth/refresh', { method: 'POST', body: JSON.stringify({ refreshToken: first }) });
    expect(again.status).toBe(401);
    expect(again.body.error.code).toBe('SESSION_EXPIRED');
  });

  it('выход закрывает сессию сразу: тот же токен больше не принимается', async () => {
    const r = await mobileLogin(WORKER);
    const token = r.body.data.token;
    expect((await api('/api/v1/auth/me', { token })).status).toBe(200);
    expect((await api('/api/v1/auth/logout', { method: 'POST', token, mobile: true })).status).toBe(200);
    const after = await api('/api/v1/auth/me', { token });
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe('SESSION_EXPIRED');
  });

  it('свою сессию можно закрыть, чужую — нельзя (неотличимо от «не найдено»)', async () => {
    const mine = await mobileLogin(WORKER);
    const other = await mobileLogin(ADMIN, `inst-adm2-${stamp}-xxxxxxxx`);
    const foreign = await api(`/api/v1/auth/sessions/${other.body.data.sessionUid}`, { method: 'DELETE', token: mine.body.data.token, mobile: true, key: randomUUID() });
    expect(foreign.status).toBe(404);
    const own = await api(`/api/v1/auth/sessions/${mine.body.data.sessionUid}`, { method: 'DELETE', token: mine.body.data.token, mobile: true });
    expect(own.status).toBe(200);
  });
});

describe('устройства', () => {
  it('отзыв телефона закрывает его сессии и не пускает вход, возврат — пускает', async () => {
    const install = `inst-rev-${randomUUID()}`;
    const r = await mobileLogin(WORKER, install);
    const token = r.body.data.token;
    const deviceUid = r.body.data.device.uid;

    const revoke = await api(`/api/v1/admin/devices/${deviceUid}/revoke`, {
      method: 'POST', token: adminToken, mobile: true, key: randomUUID(), body: JSON.stringify({ reason: 'телефон потерян' }),
    });
    expect(revoke.status).toBe(200);
    expect((await api('/api/v1/auth/me', { token })).status).toBe(401);

    const denied = await mobileLogin(WORKER, install);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('DEVICE_REVOKED');

    const restore = await api(`/api/v1/admin/devices/${deviceUid}/restore`, { method: 'POST', token: adminToken, mobile: true, key: randomUUID() });
    expect(restore.status).toBe(200);
    expect((await mobileLogin(WORKER, install)).status).toBe(201);
  });

  it('список устройств виден только с правом admin.users', async () => {
    const w = await mobileLogin(WORKER);
    expect((await api('/api/v1/admin/devices', { token: w.body.data.token })).status).toBe(403);
    const list = await api(`/api/v1/admin/devices?userUid=${worker.uid}`, { token: adminToken });
    expect(list.status).toBe(200);
    expect(list.body.data.length).toBeGreaterThan(0);
    expect(list.body.data[0].user.login).toBe(WORKER);
  });

  it('действия администратора с телефона ложатся в журнал с источником mobile', async () => {
    const d = await db.query(`SELECT d.uid FROM device d JOIN user_account u ON u.id = d.user_id WHERE u.login = $1 LIMIT 1`, [WORKER]);
    const uid = d.rows[0].uid;
    await api(`/api/v1/admin/devices/${uid}/restore`, { method: 'POST', token: adminToken, mobile: true, key: randomUUID() });
    const log = await db.query(
      `SELECT source::text FROM audit_log WHERE entity_type = 'device' AND entity_id = $1 ORDER BY id DESC LIMIT 1`,
      [uid],
    );
    expect(log.rows[0].source).toBe('mobile');
  });
});

describe('ключ повтора для записей с телефона', () => {
  const body = (min: string) => JSON.stringify({ minVersion: min, latestVersion: '9.9.9' });

  it('без ключа запись с телефона отклоняется кодом', async () => {
    const r = await api('/api/v1/admin/mobile-config', { method: 'PUT', token: adminToken, mobile: true, body: body('0.1.0') });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('повтор с тем же ключом отдаёт тот же ответ и не выполняется второй раз', async () => {
    const key = randomUUID();
    const before = await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE entity_type = 'app_setting'`);
    const a = await api('/api/v1/admin/mobile-config', { method: 'PUT', token: adminToken, mobile: true, key, body: body('0.2.0') });
    const b = await api('/api/v1/admin/mobile-config', { method: 'PUT', token: adminToken, mobile: true, key, body: body('0.2.0') });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body.data).toEqual(a.body.data);
    const after = await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE entity_type = 'app_setting'`);
    expect(after.rows[0].n - before.rows[0].n).toBe(1);
  });

  it('тот же ключ с другим телом — 409, а не тихая подмена', async () => {
    const key = randomUUID();
    await api('/api/v1/admin/mobile-config', { method: 'PUT', token: adminToken, mobile: true, key, body: body('0.3.0') });
    const r = await api('/api/v1/admin/mobile-config', { method: 'PUT', token: adminToken, mobile: true, key, body: body('0.4.0') });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('браузер правилом не затронут', async () => {
    const web = await api('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ login: ADMIN, password: PASSWORD }) });
    const r = await api('/api/v1/admin/mobile-config', { method: 'PUT', token: web.body.data.token, body: body('0.5.0') });
    expect(r.status).toBe(200);
  });

  it('настройки приложения читаются без входа', async () => {
    const r = await api('/api/v1/mobile/config');
    expect(r.status).toBe(200);
    expect(r.body.data.latestVersion).toBe('9.9.9');
  });
});

describe('push', () => {
  it('шлёт строки очереди на живой телефон и отмечает доставку', async () => {
    const install = `inst-push-${randomUUID()}`;
    const r = await mobileLogin(WORKER, install);
    const reg = await api('/api/v1/devices/register', {
      method: 'POST', token: r.body.data.token, mobile: true,
      body: JSON.stringify({ installationId: install, platform: 'android', pushToken: `ExponentPushToken[${stamp}]` }),
    });
    expect(reg.status).toBe(201);

    const row = await db.query(
      `INSERT INTO notification_outbox (user_id, kind, dedupe_key, text_ru, text_uz)
       VALUES ($1, 'stock_critical', $2, 'Остаток ниже критического', 'Qoldiq kritikdan past') RETURNING id`,
      [worker.id, `test-${stamp}`],
    );
    sent.length = 0;
    answer = () => ({ ok: true });
    await push.deliver();
    const mine = sent.filter((m) => m.to === `ExponentPushToken[${stamp}]`);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.body).toBe('Остаток ниже критического');
    const after = await db.query(`SELECT push_sent_at FROM notification_outbox WHERE id = $1`, [row.rows[0].id]);
    expect(after.rows[0].push_sent_at).not.toBeNull();
  });

  it('мёртвый push-адрес (приложение удалили) стирается', async () => {
    await db.query(
      `INSERT INTO notification_outbox (user_id, kind, dedupe_key, text_ru, text_uz)
       VALUES ($1, 'stock_critical', $2, 'Ещё одно', 'Yana bittasi')`,
      [worker.id, `test2-${stamp}`],
    );
    answer = () => ({ ok: false, error: 'DeviceNotRegistered', deadToken: true });
    await push.deliver();
    await new Promise((res) => setTimeout(res, 200));
    const d = await db.query(`SELECT count(*)::int AS n FROM device WHERE push_token = $1`, [`ExponentPushToken[${stamp}]`]);
    expect(d.rows[0].n).toBe(0);
  });
});
