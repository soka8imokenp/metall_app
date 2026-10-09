/**
 * Разделение прав по ролям проверяется маршрутом, а не меню (ТЗ 3.3).
 *
 * Спрятанный пункт меню — не ограничение доступа: адрес набирается руками, а
 * `fetch` из консоли о меню ничего не знает. Поэтому здесь каждая роль входит
 * по-настоящему и стучится в чужой раздел — ответом обязан быть 403.
 *
 * Прогон заводит по учётке на роль с меткой времени и выключает их за собой.
 * Учётки стенда он не трогает: их пароли меняет окно обязательной смены, и
 * прогон, завязанный на них, краснел бы после первого же входа человека.
 *
 * Собственник (`owner`) проверяется подробнее остальных: роль новая, и её
 * смысл — «видит всё, не делает ничего». Ошибка здесь выдала бы учредителю
 * право проводить платежи.
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
import { AdminModule } from '../src/admin/admin.module.js';
import { FinanceModule } from '../src/finance/finance.module.js';
import { WarehouseModule } from '../src/warehouse/warehouse.module.js';
import { CrmModule } from '../src/crm/crm.module.js';
import { ProductionModule } from '../src/production/production.module.js';
import { SalesModule } from '../src/sales/sales.module.js';
import { AuthGuard } from '../src/auth/auth.guard.js';
import { ContextMiddleware } from '../src/common/context.middleware.js';
import { EnvelopeInterceptor } from '../src/common/envelope.interceptor.js';
import { ErrorFilter } from '../src/common/error.filter.js';
import { roleDefs } from '../prisma/rbac.js';

let app: INestApplication;
let base: string;
let db: Client;

const stamp = Date.now().toString().slice(-7);
const PASSWORD = 'Rol-Tekshiruv-2026';
/** Роли, на которые прогон заводит учётку. Все системные, включая новую. */
const ROLES = roleDefs.map((r) => r.code);
const loginOf = (role: string) => `rbac_${role}_${stamp}`;
const token: Record<string, string> = {};

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as any) : null };
}

const as = (role: string, path: string, init: RequestInit = {}) =>
  api(path, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token[role]}`,
    },
  });

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [
      PrismaModule,
      AuthModule,
      AdminModule,
      FinanceModule,
      WarehouseModule,
      CrmModule,
      ProductionModule,
      SalesModule,
    ],
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

  const hash = await bcrypt.hash(PASSWORD, 4);
  for (const role of ROLES) {
    const login = loginOf(role);
    // Признак «пароль временный» не поднимаем: здесь проверяются права, а не
    // смена пароля, и с поднятым признаком все маршруты отвечали бы 403 по
    // другой причине — тест был бы зелёным и бессмысленным.
    const made = await db.query(
      `INSERT INTO user_account (uid, login, full_name, password_hash)
       VALUES (gen_random_uuid(), $1, $2, $3) RETURNING id`,
      [login, `Проверка роли ${role}`, hash],
    );
    await db.query(
      `INSERT INTO user_role_assignment (user_id, role_id, company_id)
       SELECT $1, r.id, c.id FROM role r, company c
        WHERE r.code = $2 AND c.code = 'trade'`,
      [made.rows[0].id, role],
    );

    const res = await api('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login, password: PASSWORD }),
    });
    expect(res.status, `вход ролью «${role}»`).toBe(201);
    token[role] = res.body.data.token;
  }
}, 120_000);

afterAll(async () => {
  await db.query(`UPDATE user_account SET is_active = false WHERE login LIKE $1`, [
    `rbac_%_${stamp}`,
  ]);
  await db.end();
  await app?.close();
});

/**
 * Чужой маршрут для каждой роли: читающий `GET`, на который права нет.
 *
 * Берётся именно чтение: если закрыто чтение, записи тем более нет, а
 * проверка записи на живой базе оставила бы за собой мусор.
 */
const FORBIDDEN: Record<string, { path: string; why: string }[]> = {
  sales_manager: [
    { path: '/api/v1/finance/operations', why: 'финансы: менеджер не видит касс и счетов' },
    { path: '/api/v1/admin/users', why: 'администрирование' },
    { path: '/api/v1/production/orders', why: 'производство' },
  ],
  warehouse_keeper: [
    { path: '/api/v1/finance/operations', why: 'финансы' },
    { path: '/api/v1/crm/partners', why: 'CRM: контрагенты не его дело' },
    { path: '/api/v1/admin/users', why: 'администрирование' },
  ],
  production_master: [
    { path: '/api/v1/finance/operations', why: 'финансы' },
    { path: '/api/v1/crm/partners', why: 'CRM' },
    { path: '/api/v1/admin/users', why: 'администрирование' },
  ],
  production_worker: [
    { path: '/api/v1/finance/operations', why: 'финансы' },
    { path: '/api/v1/crm/partners', why: 'CRM' },
    { path: '/api/v1/warehouse/stock', why: 'склад: рабочий цеха туда не ходит' },
    { path: '/api/v1/sales/orders', why: 'продажи' },
    { path: '/api/v1/admin/users', why: 'администрирование' },
  ],
  accountant: [
    { path: '/api/v1/production/orders', why: 'производство' },
    { path: '/api/v1/crm/partners', why: 'CRM' },
    { path: '/api/v1/admin/users', why: 'администрирование' },
  ],
  owner: [{ path: '/api/v1/admin/users', why: 'администрирование: собственник не раздаёт доступы' }],
  director: [{ path: '/api/v1/admin/users', why: 'администрирование' }],
};

describe('роль не видит чужого: маршрут отвечает 403', () => {
  for (const [role, cases] of Object.entries(FORBIDDEN)) {
    for (const c of cases) {
      it(`${role} → ${c.path} (${c.why})`, async () => {
        const res = await as(role, c.path);
        expect(res.status).toBe(403);
      });
    }
  }
});

describe('роль видит своё', () => {
  const ALLOWED: Record<string, string[]> = {
    sales_manager: ['/api/v1/sales/orders', '/api/v1/crm/partners'],
    warehouse_keeper: ['/api/v1/warehouse/stock'],
    production_master: ['/api/v1/production/orders'],
    production_worker: ['/api/v1/production/orders'],
    accountant: ['/api/v1/finance/operations'],
    director: ['/api/v1/finance/operations', '/api/v1/production/orders'],
    admin: ['/api/v1/admin/users', '/api/v1/finance/operations'],
  };

  for (const [role, paths] of Object.entries(ALLOWED)) {
    for (const path of paths) {
      it(`${role} → ${path}`, async () => {
        const res = await as(role, path);
        expect(res.status, JSON.stringify(res.body?.error ?? {})).toBe(200);
      });
    }
  }
});

describe('собственник: видит всё по своей компании, не делает ничего', () => {
  const READS = [
    '/api/v1/sales/orders',
    '/api/v1/warehouse/stock',
    '/api/v1/production/orders',
    '/api/v1/finance/operations',
    '/api/v1/crm/partners',
  ];

  for (const path of READS) {
    it(`читает ${path}`, async () => {
      const res = await as('owner', path);
      expect(res.status, JSON.stringify(res.body?.error ?? {})).toBe(200);
    });
  }

  it('финансовый отчёт ему открыт: ради него роль и заводилась', async () => {
    const res = await as('owner', '/api/v1/finance/reports/summary');
    expect(res.status, JSON.stringify(res.body?.error ?? {})).toBe(200);
  });

  it('не проводит финансовую операцию', async () => {
    const res = await as('owner', '/api/v1/finance/operations', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
  });

  it('не администрирует: ни люди, ни роли', async () => {
    expect((await as('owner', '/api/v1/admin/users')).status).toBe(403);
    expect((await as('owner', '/api/v1/admin/roles')).status).toBe(403);
  });
});
