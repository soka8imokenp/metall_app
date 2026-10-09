/**
 * Админ — пользователи, роли, матрица прав, журналы (ТЗ 3.3, 3.4).
 *
 * Проверяем правила, ради которых этап делался: завести человека можно из
 * системы, а не пересевом; пароль задаёт администратор и в ответе его нет;
 * себя не выключают и последнего администратора тоже; матрица прав пишется, но
 * роль `admin` не может отобрать управление сама у себя; назначенная роль не
 * удаляется; правка пользователя попадает в журнал действий со старым и новым
 * значением; неудачный вход попадает в журнал входов с причиной; всё закрыто
 * правами `admin.users` и `admin.roles`.
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
import { AdminModule } from '../src/admin/admin.module.js';
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

async function login(loginName: string, password = PASSWORD) {
  const res = await api('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: loginName, password }),
  });
  return res;
}

async function session(loginName: string, password = PASSWORD) {
  const res = await login(loginName, password);
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`Логин ${loginName} не прошёл: ${res.status}`);
  }
  return res.body.data as { token: string; permissions: string[]; companies: any[] };
}

let admin: Awaited<ReturnType<typeof session>>;
let keeper: Awaited<ReturnType<typeof session>>;
let tradeUid: string;
let plantUid: string;

const head = (s: Awaited<ReturnType<typeof session>>, companyUid?: string) => ({
  Authorization: `Bearer ${s.token}`,
  'Content-Type': 'application/json',
  ...(companyUid ? { 'X-Company-Id': companyUid } : {}),
});

const get = (path: string, s = admin, companyUid = tradeUid) =>
  api(path, { headers: head(s, companyUid) });
const post = (path: string, body: unknown, s = admin, companyUid = tradeUid) =>
  api(path, { method: 'POST', headers: head(s, companyUid), body: JSON.stringify(body) });
const patch = (path: string, body: unknown, s = admin, companyUid = tradeUid) =>
  api(path, { method: 'PATCH', headers: head(s, companyUid), body: JSON.stringify(body) });
const put = (path: string, body: unknown, s = admin, companyUid = tradeUid) =>
  api(path, { method: 'PUT', headers: head(s, companyUid), body: JSON.stringify(body) });
const del = (path: string, s = admin, companyUid = tradeUid) =>
  api(path, { method: 'DELETE', headers: head(s, companyUid) });

const stamp = Date.now().toString().slice(-6);
const madeLogins: string[] = [];
const madeRoles: string[] = [];

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

  db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  admin = await session('admin');
  keeper = await session('a.saidov');
  tradeUid = admin.companies.find((c: any) => c.code === 'trade').uid;
  plantUid = admin.companies.find((c: any) => c.code === 'plant').uid;
}, 60_000);

afterAll(async () => {
  if (db) {
    if (madeLogins.length) {
      await db.query(
        `DELETE FROM user_role_assignment WHERE user_id IN
           (SELECT id FROM user_account WHERE login = ANY($1::text[]))`,
        [madeLogins],
      );
      await db.query(
        `DELETE FROM login_log WHERE user_id IN
           (SELECT id FROM user_account WHERE login = ANY($1::text[]))`,
        [madeLogins],
      );
      // Журнал действий за собой не убираем: `audit_log` только для
      // добавления, DELETE по нему запрещён триггером. Строки прогона и
      // должны остаться — журнал, из которого можно вычистить следы, не журнал.
      await db.query(`DELETE FROM user_account WHERE login = ANY($1::text[])`, [madeLogins]);
    }
    if (madeRoles.length) {
      await db.query(
        `DELETE FROM role_permission WHERE role_id IN
           (SELECT id FROM role WHERE code = ANY($1::text[]) AND NOT is_system)`,
        [madeRoles],
      );
      await db.query(`DELETE FROM role WHERE code = ANY($1::text[]) AND NOT is_system`, [
        madeRoles,
      ]);
    }
    await db.end();
  }
  await app?.close();
});

describe('GET /admin/users', () => {
  it('отдаёт людей с их ролями, компаниями и состоянием', async () => {
    const res = await get('/api/v1/admin/users?limit=200');
    expect(res.status).toBe(200);
    const rows = res.body.data.rows as any[];
    expect(res.body.data.total).toBeGreaterThan(0);

    const self = rows.find((r) => r.login === 'admin');
    expect(self, 'в списке нет самого администратора').toBeTruthy();
    expect(self.isActive).toBe(true);
    // Роль и компания — то, ради чего список и смотрят: «кто он здесь».
    expect(self.assignments.length).toBeGreaterThan(0);
    expect(self.assignments[0].role.code).toBe('admin');
    expect(self.assignments.map((a: any) => a.company.code)).toContain('trade');
    // Пароля в ответе нет ни в каком виде.
    expect(JSON.stringify(self)).not.toMatch(/passwordHash|\$2[aby]\$/);
  });

  // Список людей обрезался пределом молча: `total` сервер считал, но отдать
  // вторую страницу было нечем — у запроса не было смещения. На сотне учёток
  // администратор не увидел бы остальных и не узнал бы, что они есть.
  it('отдаёт вторую страницу без повторов и пропусков', async () => {
    const all = await get('/api/v1/admin/users?limit=200');
    const logins = (all.body.data.rows as any[]).map((r) => r.login);
    expect(logins.length, 'для проверки страниц нужно хотя бы 4 учётки').toBeGreaterThan(3);

    const first = await get('/api/v1/admin/users?limit=2&offset=0');
    const second = await get('/api/v1/admin/users?limit=2&offset=2');
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const a = (first.body.data.rows as any[]).map((r) => r.login);
    const b = (second.body.data.rows as any[]).map((r) => r.login);
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(2);
    expect(a.some((l) => b.includes(l)), `страницы повторяются: ${a} и ${b}`).toBe(false);
    // Порядок тот же, что у полного списка: две страницы по две дают его начало.
    expect([...a, ...b]).toEqual(logins.slice(0, 4));
    // Общее число от смещения не зависит.
    expect(second.body.data.total).toBe(all.body.data.total);
  });

  // Уведомления уходят «в никуда», если человек закрыл бота: Telegram такое
  // сообщение отбивает. Администратор должен видеть это в списке людей, иначе
  // он будет уверен, что кладовщик получает предупреждения о остатках.
  it('показывает, кому бот написать не может', async () => {
    await db.query(
      `UPDATE user_account
          SET telegram_user_id = 980000301, telegram_linked_at = now(),
              telegram_blocked = true, telegram_blocked_at = now()
        WHERE login = 'a.saidov'`,
    );
    try {
      const res = await get('/api/v1/admin/users?limit=200');
      const row = (res.body.data.rows as any[]).find((r) => r.login === 'a.saidov');
      expect(row.telegram.linked).toBe(true);
      expect(row.telegram.blocked, 'закрытая дверь не видна администратору').toBe(true);
      expect(row.telegram.blockedAt).toBeTruthy();
    } finally {
      await db.query(
        `UPDATE user_account
            SET telegram_user_id = NULL, telegram_linked_at = NULL,
                telegram_blocked = false, telegram_blocked_at = NULL
          WHERE login = 'a.saidov'`,
      );
    }
  });

  it('без права admin.users не отдаётся', async () => {
    const res = await get('/api/v1/admin/users', keeper);
    expect(res.status).toBe(403);
  });
});

describe('POST /admin/users', () => {
  it('заводит человека, и он входит заданным паролем', async () => {
    const login0 = `qa.user.${stamp}`;
    madeLogins.push(login0);
    const res = await post('/api/v1/admin/users', {
      login: login0,
      fullName: 'QA Заведённый',
      password: 'qa-pass-123',
      locale: 'ru',
      assignments: [{ roleCode: 'warehouse_keeper', companyUid: tradeUid }],
    });
    expect(res.status).toBe(201);
    expect(JSON.stringify(res.body.data)).not.toMatch(/qa-pass-123|\$2[aby]\$/);

    const ok = await login(login0, 'qa-pass-123');
    expect(ok.status, 'заведённый человек не вошёл своим паролем').toBe(201);
    expect(ok.body.data.permissions).toContain('warehouse.move');
    expect(ok.body.data.permissions).not.toContain('admin.users');
  });

  it('повтор логина отклоняется', async () => {
    const res = await post('/api/v1/admin/users', {
      login: 'admin',
      fullName: 'Второй админ',
      password: 'qa-pass-123',
      assignments: [],
    });
    expect(res.status).toBe(409);
  });
});

describe('PATCH /admin/users/:uid', () => {
  it('правит человека и пишет в журнал старое и новое значение', async () => {
    const login0 = `qa.edit.${stamp}`;
    madeLogins.push(login0);
    const made = await post('/api/v1/admin/users', {
      login: login0,
      fullName: 'QA До правки',
      password: 'qa-pass-123',
      assignments: [{ roleCode: 'accountant', companyUid: tradeUid }],
    });
    const uid = made.body.data.uid as string;

    const res = await patch(`/api/v1/admin/users/${uid}`, {
      fullName: 'QA После правки',
      isActive: false,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.fullName).toBe('QA После правки');
    expect(res.body.data.isActive).toBe(false);

    const closed = await login(login0, 'qa-pass-123');
    expect(closed.status, 'выключенная учётка всё равно вошла').toBe(401);

    const audit = await get(`/api/v1/admin/audit?entityType=user&limit=50`);
    const mine = (audit.body.data.rows as any[]).find((r) => r.entityId === uid);
    expect(mine, 'правки пользователя нет в журнале действий').toBeTruthy();
    expect(mine.changes.fullName).toEqual({ from: 'QA До правки', to: 'QA После правки' });
    expect(mine.user.login).toBe('admin');
    // Журнал читают глазами: «Учётная запись 01a0fbb1-358c…» не отвечает,
    // чья это запись.
    expect(mine.entityTitle, 'строка журнала не называет предмет').toBe('QA После правки');
  });

  it('журнал называет предмет действия, а не его идентификатор', async () => {
    const rows = (await get('/api/v1/admin/audit?limit=200')).body.data.rows as any[];
    // Названия нет у того, чего уже нет: удалённому документу имени не
    // выдумать, и такие строки в журнале остаются с идентификатором. Поэтому
    // требуем, чтобы названия вообще были и чтобы ни одно не оказалось тем же
    // идентификатором — то есть названием не притворялся сам `uid`.
    const named = rows.filter((r) => r.entityTitle);
    expect(named.length, 'журнал не назвал ни одного предмета').toBeGreaterThan(5);
    const sameAsId = rows.filter((r) => r.entityTitle && r.entityTitle === r.entityId);
    expect(sameAsId, 'название предмета совпало с идентификатором').toEqual([]);
  });

  it('себя выключить нельзя', async () => {
    const list = await get('/api/v1/admin/users?limit=200');
    const self = (list.body.data.rows as any[]).find((r) => r.login === 'admin');
    const res = await patch(`/api/v1/admin/users/${self.uid}`, { isActive: false });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toMatch(/себя/i);
  });
});

describe('POST /admin/users/:uid/password', () => {
  it('меняет пароль: новый работает, прежний больше нет', async () => {
    const login0 = `qa.pass.${stamp}`;
    madeLogins.push(login0);
    const made = await post('/api/v1/admin/users', {
      login: login0,
      fullName: 'QA Пароль',
      password: 'qa-pass-123',
      assignments: [{ roleCode: 'accountant', companyUid: tradeUid }],
    });
    const uid = made.body.data.uid as string;

    const res = await post(`/api/v1/admin/users/${uid}/password`, { password: 'qa-pass-456' });
    expect(res.status).toBe(201);
    expect(JSON.stringify(res.body)).not.toMatch(/qa-pass-456/);

    expect((await login(login0, 'qa-pass-456')).status).toBe(201);
    expect((await login(login0, 'qa-pass-123')).status).toBe(401);
  });
});

describe('PUT /admin/users/:uid/roles', () => {
  it('переназначает роли по компаниям', async () => {
    const login0 = `qa.roles.${stamp}`;
    madeLogins.push(login0);
    const made = await post('/api/v1/admin/users', {
      login: login0,
      fullName: 'QA Роли',
      password: 'qa-pass-123',
      assignments: [{ roleCode: 'accountant', companyUid: tradeUid }],
    });
    const uid = made.body.data.uid as string;

    const res = await put(`/api/v1/admin/users/${uid}/roles`, {
      assignments: [
        { roleCode: 'sales_manager', companyUid: tradeUid },
        { roleCode: 'production_master', companyUid: plantUid },
      ],
    });
    expect(res.status).toBe(200);

    const after = await session(login0, 'qa-pass-123');
    expect(after.permissions).toContain('production.manage');
    expect(after.permissions).toContain('sales.edit');
    expect(after.permissions).not.toContain('finance.post');
    expect(after.companies.length).toBe(2);
  });
});

describe('Роли и матрица прав', () => {
  it('отдаёт каталог прав по модулям и роли с их правами', async () => {
    const perms = await get('/api/v1/admin/permissions');
    expect(perms.status).toBe(200);
    const modules = perms.body.data.modules as any[];
    expect(modules.length).toBeGreaterThan(5);
    const admin0 = modules.find((m) => m.module === 'admin');
    expect(admin0.permissions.map((p: any) => p.code)).toContain('admin.users');
    expect(admin0.permissions[0].descriptionRu).toBeTruthy();

    const roles = await get('/api/v1/admin/roles');
    const row = (roles.body.data.rows as any[]).find((r) => r.code === 'warehouse_keeper');
    expect(row.isSystem).toBe(true);
    expect(row.permissions).toContain('warehouse.move');
    expect(row.permissions).not.toContain('finance.post');
    expect(row.users).toBeGreaterThan(0);
  });

  it('матрица пишется, и права возвращаются в списке', async () => {
    const before = await get('/api/v1/admin/roles');
    const row = (before.body.data.rows as any[]).find((r) => r.code === 'production_master');
    const next = [...row.permissions, 'documents.view'];

    const res = await put('/api/v1/admin/roles/production_master/permissions', {
      permissions: next,
    });
    expect(res.status).toBe(200);

    const after = await get('/api/v1/admin/roles');
    const now = (after.body.data.rows as any[]).find((r) => r.code === 'production_master');
    expect(now.permissions).toContain('documents.view');

    // Возвращаем как было: роль системная, её набор — часть демо-данных.
    await put('/api/v1/admin/roles/production_master/permissions', {
      permissions: row.permissions,
    });
  });

  it('роль администратора не может снять себе управление', async () => {
    const res = await put('/api/v1/admin/roles/admin/permissions', {
      permissions: ['dashboard.view'],
    });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toMatch(/admin/i);
  });

  it('заводит свою роль, а назначенную не удаляет', async () => {
    const code = `qa_role_${stamp}`;
    madeRoles.push(code);
    const made = await post('/api/v1/admin/roles', {
      code,
      nameRu: 'QA Роль',
      nameUz: 'QA Rol',
      permissions: ['dashboard.view', 'warehouse.view'],
    });
    expect(made.status).toBe(201);

    const login0 = `qa.role.user.${stamp}`;
    madeLogins.push(login0);
    await post('/api/v1/admin/users', {
      login: login0,
      fullName: 'QA Носитель роли',
      password: 'qa-pass-123',
      assignments: [{ roleCode: code, companyUid: tradeUid }],
    });

    const busy = await del(`/api/v1/admin/roles/${code}`);
    expect(busy.status, 'назначенную роль удалили').toBe(409);

    const s = await session(login0, 'qa-pass-123');
    expect(s.permissions).toEqual(expect.arrayContaining(['dashboard.view', 'warehouse.view']));
  });

  it('без права admin.roles матрица не пишется', async () => {
    const res = await put(
      '/api/v1/admin/roles/warehouse_keeper/permissions',
      { permissions: ['warehouse.view'] },
      keeper,
    );
    expect(res.status).toBe(403);
  });
});

describe('GET /admin/logins', () => {
  it('показывает неудачный вход с причиной', async () => {
    const login0 = `qa.fail.${stamp}`;
    madeLogins.push(login0);
    await post('/api/v1/admin/users', {
      login: login0,
      fullName: 'QA Неудачный вход',
      password: 'qa-pass-123',
      assignments: [{ roleCode: 'accountant', companyUid: tradeUid }],
    });
    await login(login0, 'не-тот-пароль');

    const res = await get('/api/v1/admin/logins?limit=100');
    expect(res.status).toBe(200);
    const mine = (res.body.data.rows as any[]).filter((r) => r.login === login0);
    expect(mine.length, 'неудачной попытки нет в журнале входов').toBeGreaterThan(0);
    expect(mine[0].success).toBe(false);
    expect(mine[0].failureReason).toBe('bad_password');
  });

  it('без права admin.users журналы закрыты', async () => {
    expect((await get('/api/v1/admin/logins', keeper)).status).toBe(403);
    expect((await get('/api/v1/admin/audit', keeper)).status).toBe(403);
  });
});
