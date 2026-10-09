/**
 * Собственник и его компании: доступ разделён назначением, а не правами.
 *
 * Поправка заказчика от 06.10: `owner1` и `owner2` — живые люди на одной роли
 * «Собственник», и отличаются они только списком компаний в учётке. `owner1`
 * открыт оба бизнеса, `owner2` — один завод. Права у них при этом одинаковые
 * до последнего кода, поэтому единственное, что держит разрез, — пересечение
 * назначений с заголовком `X-Company-Id` в `auth.guard.ts`.
 *
 * Проверка нужна именно такая, запросом. Сторож `stand-logins.spec.ts` смотрит
 * на список в сиде: он поймает опечатку в назначении, но ничего не скажет про
 * то, что будет, если `owner2` сам подставит в заголовок uid торгового дома.
 * А это и есть вопрос заказчика: получит он отказ или чужие цифры.
 *
 * Прогон заводит две учётки с меткой времени и выключает их за собой. Учётки
 * стенда (`owner1`, `owner2`) он не трогает: их пароли меняет окно обязательной
 * смены, и завязанный на них тест краснел бы после первого входа человека.
 */
import 'dotenv/config';
import { Client } from 'pg';
import * as bcrypt from 'bcryptjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { FinanceModule } from '../src/finance/finance.module.js';
import { ProductionModule } from '../src/production/production.module.js';
import { SalesModule } from '../src/sales/sales.module.js';
import { AuthGuard } from '../src/auth/auth.guard.js';
import { ContextMiddleware } from '../src/common/context.middleware.js';
import { EnvelopeInterceptor } from '../src/common/envelope.interceptor.js';
import { ErrorFilter } from '../src/common/error.filter.js';

let app: INestApplication;
let base: string;
let db: Client;

const stamp = Date.now().toString().slice(-7);
const PASSWORD = 'Sobstvennik-Tekshiruv-2026';

/** `both` — это `owner1` со стенда, `plantOnly` — `owner2`. */
const WHO = {
  both: { login: `own_both_${stamp}`, companies: ['trade', 'plant'] },
  plantOnly: { login: `own_plant_${stamp}`, companies: ['plant'] },
} as const;
type Who = keyof typeof WHO;

const token: Record<string, string> = {};
/** uid компаний: именно их человек подставляет в заголовок. */
const uid: Record<string, string> = {};

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as any) : null };
}

/** Запрос от лица собственника. `company` — код компании в `X-Company-Id`. */
const as = (who: Who, path: string, company?: 'trade' | 'plant') =>
  api(path, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token[who]}`,
      ...(company ? { 'X-Company-Id': uid[company] } : {}),
    },
  });

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [PrismaModule, AuthModule, FinanceModule, ProductionModule, SalesModule],
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

  const companies = await db.query<{ code: string; uid: string }>(
    `SELECT code, uid::text FROM company WHERE code IN ('trade', 'plant')`,
  );
  for (const row of companies.rows) uid[row.code] = row.uid;
  expect(Object.keys(uid).sort(), 'обе компании есть в базе').toEqual(['plant', 'trade']);

  const hash = await bcrypt.hash(PASSWORD, 4);
  for (const [key, def] of Object.entries(WHO)) {
    // Признак «пароль временный» не поднимаем: он отбивал бы все маршруты по
    // своей причине, и тест был бы зелёным, ничего не проверяя.
    const made = await db.query<{ id: string }>(
      `INSERT INTO user_account (uid, login, full_name, password_hash)
       VALUES (gen_random_uuid(), $1, $2, $3) RETURNING id`,
      [def.login, `Проверка собственника (${key})`, hash],
    );
    for (const code of def.companies) {
      await db.query(
        `INSERT INTO user_role_assignment (user_id, role_id, company_id)
         SELECT $1, r.id, c.id FROM role r, company c
          WHERE r.code = 'owner' AND r.company_id IS NULL AND c.code = $2`,
        [made.rows[0].id, code],
      );
    }

    const res = await api('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: def.login, password: PASSWORD }),
    });
    expect(res.status, `вход «${def.login}»`).toBe(201);
    token[key] = res.body.data.token;
  }
}, 120_000);

afterAll(async () => {
  await db.query(`UPDATE user_account SET is_active = false WHERE login LIKE $1`, [`own_%_${stamp}`]);
  await db.end();
  await app?.close();
});

/** Разделы, по которым собственник смотрит цифры компании. */
const READS = [
  '/api/v1/sales/orders',
  '/api/v1/production/orders',
  '/api/v1/finance/operations',
  '/api/v1/finance/reports/summary',
];

describe('права у обоих собственников одни и те же', () => {
  it('и тот и другой читает свои разделы без заголовка компании', async () => {
    for (const who of ['both', 'plantOnly'] as Who[]) {
      for (const path of READS) {
        const res = await as(who, path);
        expect(res.status, `${who} → ${path}: ${JSON.stringify(res.body?.error ?? {})}`).toBe(200);
      }
    }
  });

  it('набор прав в сессии совпадает до последнего кода', async () => {
    const a = await as('both', '/api/v1/auth/me');
    const b = await as('plantOnly', '/api/v1/auth/me');
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.data.permissions).toEqual(b.body.data.permissions);
  });
});

describe('«более крутой аккаунт» — это список компаний, а не права', () => {
  it('owner1 видит в сессии обе компании', async () => {
    const res = await as('both', '/api/v1/auth/me');
    expect(res.body.data.companies.map((c: any) => c.code).sort()).toEqual(['plant', 'trade']);
  });

  it('owner2 видит в сессии только завод', async () => {
    const res = await as('plantOnly', '/api/v1/auth/me');
    expect(res.body.data.companies.map((c: any) => c.code)).toEqual(['plant']);
  });

  it('owner1 открывает каждую компанию по отдельности', async () => {
    for (const company of ['trade', 'plant'] as const) {
      const res = await as('both', '/api/v1/auth/me', company);
      expect(res.status).toBe(200);
      expect(res.body.data.companies.map((c: any) => c.code)).toEqual([company]);
    }
  });

  it('owner2 открывает завод', async () => {
    const res = await as('plantOnly', '/api/v1/auth/me', 'plant');
    expect(res.status).toBe(200);
    expect(res.body.data.companies.map((c: any) => c.code)).toEqual(['plant']);
  });
});

describe('owner2 просит Торговый дом — получает отказ, а не чужие цифры', () => {
  // Главный вопрос заказчика. Проверяется на всех читающих разделах: отказ,
  // выписанный на одном маршруте, ничего не говорит про остальные.
  for (const path of READS) {
    it(`отказ на ${path}`, async () => {
      const res = await as('plantOnly', path, 'trade');
      expect(res.status, JSON.stringify(res.body?.data ?? {})).toBe(403);
    });
  }

  it('в отказе нет данных — ни строк, ни итогов', async () => {
    const res = await as('plantOnly', '/api/v1/finance/reports/summary', 'trade');
    expect(res.status).toBe(403);
    expect(res.body?.data ?? null).toBeNull();
  });

  it('тот же маршрут с заводом открыт: отказ именно про компанию', async () => {
    const res = await as('plantOnly', '/api/v1/finance/reports/summary', 'plant');
    expect(res.status).toBe(200);
  });
});
