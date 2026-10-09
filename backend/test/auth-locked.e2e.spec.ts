/**
 * Блокировка учётной записи: клиент узнаёт её по коду, а не по словам.
 *
 * Форма входа отличала блокировку от неверного пароля проверкой
 * `/заблокирован/i` по тексту ответа (`LoginScreen.tsx`, `bot.service.ts`).
 * После перевода ответов сервера (ТЗ 13.4) под узбекским запросом приходит
 * «Hisob vaqtincha bloklangan», и такая проверка молча перестаёт работать:
 * человек с заблокированной учёткой видит «неверный логин или пароль» и идёт
 * перебирать пароли вместо того, чтобы ждать или звонить администратору.
 *
 * Прогон блокирует отдельную учётку на минуту и снимает блокировку за собой.
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
const CYR = /[А-Яа-яЁё]/;
/** Учётка из посева, не используемая другими прогонами как рабочая. */
const LOCKED = 'd.karimov';

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as any) : null };
}

const tryLogin = (locale: 'ru' | 'uz', password = PASSWORD) =>
  api('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept-Language': locale },
    body: JSON.stringify({ login: LOCKED, password }),
  });

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
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();

  db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  await db.query(
    `UPDATE user_account SET locked_until = now() + interval '1 minute' WHERE login = $1`,
    [LOCKED],
  );
});

afterAll(async () => {
  // Учётка живёт на стенде: оставить её запертой на четверть часа нельзя.
  if (db) {
    await db
      .query(
        `UPDATE user_account SET locked_until = NULL, failed_login_count = 0 WHERE login = $1`,
        [LOCKED],
      )
      .catch(() => null);
    await db.end().catch(() => null);
  }
  await app?.close();
});

describe('заблокированная учётная запись', () => {
  it('отличается от неверного пароля кодом, а не текстом', async () => {
    const res = await tryLogin('ru');
    expect(res.status).toBe(401);
    expect(res.body?.error?.code).toBe('ACCOUNT_LOCKED');
  });

  it('под узбекским запросом код тот же, а текст узбекский', async () => {
    const res = await tryLogin('uz');
    expect(res.status).toBe(401);
    expect(res.body?.error?.code).toBe('ACCOUNT_LOCKED');
    const message = String(res.body?.error?.message ?? '');
    expect(message, `ответ по-русски: ${message}`).not.toMatch(CYR);
  });

  it('неверный пароль остаётся обычным отказом входа', async () => {
    await db.query(`UPDATE user_account SET locked_until = NULL WHERE login = $1`, [LOCKED]);
    const res = await tryLogin('ru', 'ne-tot-parol-vovse');
    expect(res.status).toBe(401);
    expect(res.body?.error?.code).toBe('UNAUTHORIZED');
    // Счётчик ошибок трогали — убираем след, чтобы учётка не заперлась сама.
    await db.query(
      `UPDATE user_account SET failed_login_count = 0, locked_until = now() + interval '1 minute' WHERE login = $1`,
      [LOCKED],
    );
  });
});
