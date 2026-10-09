/**
 * Временный пароль и обязательная смена (требование Отабека от 06.10).
 *
 * Правило: пароль, который человек не придумывал сам, — временный. Такой
 * выдают при заведении учётки и при сбросе руководителем. С временным паролем
 * вход **проходит** (иначе человек не смог бы его сменить), но дальше смены
 * пароля и чтения своего профиля система не пускает.
 *
 * Проверяется поведение целиком, включая отказы: короткий пароль, пароль,
 * равный дефолтному `<логин>123`, пароль, равный текущему, и неверный текущий.
 * Отдельно — что отказ приходит кодом и на двух языках (ТЗ 13.4): форма
 * отличает «смените пароль» от «нет прав» по коду, а не по тексту.
 *
 * Прогон заводит свою учётку с меткой времени и выключает её за собой: чужие
 * учётки стенда он не трогает, иначе параллельный прогон упрётся в пароль,
 * который этот тест только что сменил.
 */
import 'dotenv/config';
import { defaultPasswordFor } from '../src/common/default-password.js';
import { Client } from 'pg';
import * as bcrypt from 'bcryptjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { DashboardModule } from '../src/dashboard/dashboard.module.js';
import { AuthGuard } from '../src/auth/auth.guard.js';
import { ContextMiddleware } from '../src/common/context.middleware.js';
import { EnvelopeInterceptor } from '../src/common/envelope.interceptor.js';
import { ErrorFilter } from '../src/common/error.filter.js';

let app: INestApplication;
let base: string;
let db: Client;

const stamp = Date.now().toString().slice(-7);
const LOGIN = `tmp_pwd_${stamp}`;
const TEMP = defaultPasswordFor(LOGIN);
const FRESH = 'Sovuq-Temir-2026';
const CYR = /[А-Яа-яЁё]/;

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as any) : null };
}

const login = (password: string, locale: 'ru' | 'uz' = 'ru') =>
  api('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept-Language': locale },
    body: JSON.stringify({ login: LOGIN, password }),
  });

const authed = (token: string, path: string, init: RequestInit = {}, locale: 'ru' | 'uz' = 'ru') =>
  api(path, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      'Content-Type': 'application/json',
      'Accept-Language': locale,
      Authorization: `Bearer ${token}`,
    },
  });

const changePassword = (
  token: string,
  currentPassword: string,
  newPassword: string,
  locale: 'ru' | 'uz' = 'ru',
) =>
  authed(
    token,
    '/api/v1/auth/me/password',
    { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) },
    locale,
  );

/** Признак прямо из базы: ответ сервера про себя мог бы и соврать. */
async function flag(): Promise<boolean> {
  const r = await db.query('SELECT must_change_password FROM user_account WHERE login = $1', [LOGIN]);
  return r.rows[0]?.must_change_password === true;
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [PrismaModule, AuthModule, DashboardModule],
    providers: [
      { provide: APP_GUARD, useClass: AuthGuard },
      { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
      { provide: APP_FILTER, useClass: ErrorFilter },
    ],
  }).compile();

  app = moduleRef.createNestApplication();
  app.use(new ContextMiddleware().use.bind(new ContextMiddleware()));
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();

  db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  // Учётка с временным паролем и правом смотреть сводку: нужен маршрут, на
  // который право есть, иначе 403 пришёл бы из-за нехватки прав, а не из-за
  // временного пароля, и тест ничего бы не доказал.
  const hash = await bcrypt.hash(TEMP, 4);
  const user = await db.query(
    // `uid` в схеме проставляет Prisma, а не база: вставка в обход клиента
    // обязана дать его сама.
    `INSERT INTO user_account (uid, login, full_name, password_hash, must_change_password)
     VALUES (gen_random_uuid(), $1, $2, $3, true) RETURNING id`,
    [LOGIN, `Временная учётка ${stamp}`, hash],
  );
  const userId = user.rows[0].id as string;
  await db.query(
    `INSERT INTO user_role_assignment (user_id, role_id, company_id)
     SELECT $1, r.id, c.id FROM role r, company c
      WHERE r.code = 'director' AND c.code = 'trade'`,
    [userId],
  );
}, 60_000);

afterAll(async () => {
  await db.query('UPDATE user_account SET is_active = false WHERE login = $1', [LOGIN]);
  await db.end();
  await app?.close();
});

describe('вход с временным паролем', () => {
  it('пускает внутрь и честно говорит, что пароль временный', async () => {
    const res = await login(TEMP);
    expect(res.status).toBe(201);
    expect(res.body.data.token).toBeTruthy();
    expect(res.body.data.mustChangePassword).toBe(true);
  });

  it('свой профиль читается: без него окно смены пароля нечем нарисовать', async () => {
    const { body } = await login(TEMP);
    const me = await authed(body.data.token, '/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.data.mustChangePassword).toBe(true);
    expect(me.body.data.user.login).toBe(LOGIN);
  });

  it('любой другой маршрут отказывает кодом, а не текстом', async () => {
    const { body } = await login(TEMP);
    const res = await authed(body.data.token, '/api/v1/dashboard/summary');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
  });

  it('причина отказа написана словами на языке запроса', async () => {
    const { body } = await login(TEMP);
    const ru = await authed(body.data.token, '/api/v1/dashboard/summary', {}, 'ru');
    const uz = await authed(body.data.token, '/api/v1/dashboard/summary', {}, 'uz');
    expect(ru.body.error.message).toMatch(CYR);
    expect(uz.body.error.message).not.toMatch(CYR);
    expect(uz.body.error.message.length).toBeGreaterThan(10);
  });
});

describe('смена своего пароля', () => {
  it('не верит на слово: неверный текущий пароль — отказ', async () => {
    const { body } = await login(TEMP);
    const res = await changePassword(body.data.token, 'не-тот-пароль', FRESH);
    expect(res.status).toBe(401);
    expect(await flag()).toBe(true);
  });

  it('отбивает слишком короткий новый пароль', async () => {
    const { body } = await login(TEMP);
    const res = await changePassword(body.data.token, TEMP, 'Ab3');
    expect(res.status).toBe(400);
    expect(await flag()).toBe(true);
  });

  it('отбивает пароль по дефолтному образцу «логин+123»', async () => {
    const { body } = await login(TEMP);
    const res = await changePassword(body.data.token, TEMP, defaultPasswordFor(LOGIN));
    // Это и есть текущий пароль, и он же дефолтный: отказ обязателен —
    // иначе «смена» ничего не меняет и признак снимается зря.
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(CYR);
    expect(await flag()).toBe(true);
  });

  it('отбивает дефолтный образец и в верхнем регистре', async () => {
    const { body } = await login(TEMP);
    const res = await changePassword(body.data.token, TEMP, defaultPasswordFor(LOGIN).toUpperCase());
    expect(res.status).toBe(422);
    expect(await flag()).toBe(true);
  });

  it('меняет пароль, снимает признак и открывает систему', async () => {
    const { body } = await login(TEMP);
    const changed = await changePassword(body.data.token, TEMP, FRESH);
    expect(changed.status).toBe(201);
    expect(await flag()).toBe(false);

    // Тот же токен обязан заработать сразу: выбрасывать человека на форму
    // входа сразу после смены пароля значит заставить его войти дважды.
    const summary = await authed(body.data.token, '/api/v1/dashboard/summary');
    expect(summary.status).toBe(200);

    const again = await login(FRESH);
    expect(again.status).toBe(201);
    expect(again.body.data.mustChangePassword).toBe(false);
  });

  it('старый пароль больше не работает', async () => {
    const res = await login(TEMP);
    expect(res.status).toBe(401);
  });

  it('не даёт поставить тот же пароль снова', async () => {
    const { body } = await login(FRESH);
    const res = await changePassword(body.data.token, FRESH, FRESH);
    expect(res.status).toBe(422);
  });
});

describe('сброс пароля руководителем', () => {
  /** Токен администратора: сброс требует права `admin.users`. */
  async function adminToken() {
    const res = await api('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        login: 'admin',
        password: process.env.SEED_PASSWORD ?? 'metall-dev-2026',
      }),
    });
    expect(res.status, 'вход администратора').toBe(201);
    return res.body.data.token as string;
  }

  it('выдаёт временный пароль, показывает его один раз и снова ставит признак', async () => {
    // Заявку человек подаёт сам, до входа.
    const asked = await api('/api/v1/auth/password-reset-request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: LOGIN, contact: '+998001234567' }),
    });
    expect(asked.status).toBe(201);

    const token = await adminToken();
    const list = await authed(token, '/api/v1/auth/password-reset-requests?status=new');
    const row = list.body.data.rows.find((r: any) => r.login === LOGIN);
    expect(row, 'заявка в очереди').toBeTruthy();

    const done = await authed(token, `/api/v1/auth/password-reset-requests/${row.uid}`, {
      method: 'POST',
      body: JSON.stringify({ action: 'done' }),
    });
    expect(done.status).toBe(201);

    const issued = done.body.data.password as string;
    expect(issued, 'временный пароль в ответе').toBeTruthy();
    expect(issued.length).toBeGreaterThanOrEqual(10);
    expect(await flag()).toBe(true);

    // Выданным паролем человек входит — и снова упирается в смену.
    const back = await login(issued);
    expect(back.status).toBe(201);
    expect(back.body.data.mustChangePassword).toBe(true);
    const blocked = await authed(back.body.data.token, '/api/v1/dashboard/summary');
    expect(blocked.status).toBe(403);
  });

  it('повторно пароль не показывает: заявка уже закрыта', async () => {
    const token = await adminToken();
    const all = await authed(token, '/api/v1/auth/password-reset-requests?status=all');
    const row = all.body.data.rows.find((r: any) => r.login === LOGIN);
    expect(row.status).toBe('done');
    expect(row.password, 'пароль в списке заявок').toBeUndefined();

    const again = await authed(token, `/api/v1/auth/password-reset-requests/${row.uid}`, {
      method: 'POST',
      body: JSON.stringify({ action: 'done' }),
    });
    expect(again.status).toBe(409);
  });

  it('отказ сбрасывает заявку без выдачи пароля', async () => {
    await api('/api/v1/auth/password-reset-request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: LOGIN, contact: '+998001234567' }),
    });
    const token = await adminToken();
    const list = await authed(token, '/api/v1/auth/password-reset-requests?status=new');
    const row = list.body.data.rows.find((r: any) => r.login === LOGIN);

    const rejected = await authed(token, `/api/v1/auth/password-reset-requests/${row.uid}`, {
      method: 'POST',
      body: JSON.stringify({ action: 'rejected', note: 'человека не узнали' }),
    });
    expect(rejected.status).toBe(201);
    expect(rejected.body.data.password ?? null).toBeNull();
  });
});
