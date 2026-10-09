/**
 * Метод списания — настройка компании (ТЗ 5.7).
 *
 * До этого FIFO по партиям был зашит в код. Здесь проверяется, что метод
 * выбирается и что выбор действительно меняет число: та же операция при
 * FIFO берёт себестоимость своей партии, при средневзвешенной — среднюю по
 * складу.
 *
 * Прогон заводит свою позицию `QA-COST-…`, принимает на неё две партии по
 * разной цене и списывает. Метод в конце возвращается тем, каким был.
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
import { WarehouseModule } from '../src/warehouse/warehouse.module.js';
import { RefsModule } from '../src/refs/refs.module.js';
import { ContextMiddleware } from '../src/common/context.middleware.js';
import { EnvelopeInterceptor } from '../src/common/envelope.interceptor.js';
import { ErrorFilter } from '../src/common/error.filter.js';

let app: INestApplication;
let base: string;
let db: Client;

const PASSWORD = process.env.SEED_PASSWORD ?? 'metall-dev-2026';
const RUN = Date.now().toString(36).toUpperCase();
const ITEM = `QA-COST-${RUN}`;

let admin: Awaited<ReturnType<typeof login>>;
let director: Awaited<ReturnType<typeof login>>;
let keeper: Awaited<ReturnType<typeof login>>;
let companyUid: string;
let warehouse: string;
let location: string;
let was: string;

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
  return res.body.data as { token: string; companies: { uid: string; code: string }[] };
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const json = (token: string) => ({ ...auth(token), 'Content-Type': 'application/json' });

const setMethod = (token: string, method: string) =>
  api('/api/v1/refs/settings', {
    method: 'PATCH',
    headers: json(token),
    body: JSON.stringify({ companyUid, costingMethod: method }),
  });

/** Приход партии по своей цене. */
const receipt = (batch: string, qty: string, unitCost: string) =>
  api('/api/v1/warehouse/moves', {
    method: 'POST',
    headers: json(keeper.token),
    body: JSON.stringify({
      companyUid,
      operationType: 'receipt',
      itemCode: ITEM,
      batchNumber: batch,
      qty,
      toWarehouseCode: warehouse,
      toLocationCode: location,
      unitCost,
      comment: `приход ${RUN}`,
    }),
  });

/** Списание из названной партии: его себестоимость и проверяем. */
async function writeOff(batch: string, qty: string) {
  const reason = await db.query<{ id: string }>(
    `SELECT r.id::text AS id FROM stock_reason r JOIN company c ON c.id = r.company_id
      WHERE c.uid = $1 AND r.kind = 'write_off' AND r.is_active ORDER BY r.id LIMIT 1`,
    [companyUid],
  );
  const res = await api('/api/v1/warehouse/moves', {
    method: 'POST',
    headers: json(keeper.token),
    body: JSON.stringify({
      companyUid,
      operationType: 'write_off',
      itemCode: ITEM,
      batchNumber: batch,
      qty,
      fromWarehouseCode: warehouse,
      fromLocationCode: location,
      reasonId: reason.rows[0].id,
      comment: `списание ${RUN}`,
    }),
  });
  expect(res.status).toBe(201);
  const row = await db.query<{ cost: string }>(
    `SELECT cost_total::text AS cost FROM stock_move WHERE uid = $1`,
    [res.body.data.uid],
  );
  return Number(row.rows[0].cost);
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [PrismaModule, AuthModule, WarehouseModule, RefsModule],
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

  admin = await login('admin');
  director = await login('s.radjabov');
  keeper = await login('a.saidov');
  companyUid = admin.companies[0].uid;

  const w = await db.query<{ code: string }>(
    `SELECT w.code FROM warehouse w JOIN company c ON c.id = w.company_id
      WHERE c.uid = $1 AND w.is_active ORDER BY w.id LIMIT 1`,
    [companyUid],
  );
  warehouse = w.rows[0].code;

  const loc = await db.query<{ code: string }>(
    `SELECT l.code FROM storage_location l
       JOIN warehouse_zone z ON z.id = l.zone_id
       JOIN warehouse w ON w.id = z.warehouse_id
      WHERE w.code = $1 AND l.is_active ORDER BY l.id LIMIT 1`,
    [warehouse],
  );
  location = loc.rows[0].code;

  const made = await api('/api/v1/refs/items', {
    method: 'POST',
    headers: json(admin.token),
    body: JSON.stringify({
      companyUid,
      code: ITEM,
      nameRu: `Проверка метода списания ${RUN}`,
      itemType: 'goods',
      baseUnit: 't',
      trackBatches: true,
    }),
  });
  expect(made.status).toBe(201);

  const now = await db.query<{ m: string }>(
    `SELECT costing_method::text AS m FROM company WHERE uid = $1`,
    [companyUid],
  );
  was = now.rows[0].m;
}, 60_000);

afterAll(async () => {
  if (was) await setMethod(admin.token, was);
  await app?.close();
  await db?.end();
});

describe('настройка метода списания', () => {
  it('читается вместе со справочниками', async () => {
    const res = await api('/api/v1/refs/settings', { headers: auth(keeper.token) });
    expect(res.status).toBe(200);
    const mine = (res.body.data.rows as any[]).find((r) => r.companyUid === companyUid);
    expect(['fifo', 'weighted_average']).toContain(mine.costingMethod);
    // У человека с двумя компаниями настройка видна по каждой, а не падает.
    expect((res.body.data.rows as any[]).length).toBeGreaterThanOrEqual(1);
  });

  it('кладовщик метод не меняет', async () => {
    const res = await setMethod(keeper.token, 'weighted_average');
    expect(res.status).toBe(403);
  });

  it('директор меняет, и выбор записан', async () => {
    const res = await setMethod(director.token, 'weighted_average');
    expect(res.status).toBe(200);
    const row = await db.query<{ m: string }>(
      `SELECT costing_method::text AS m FROM company WHERE uid = $1`,
      [companyUid],
    );
    expect(row.rows[0].m).toBe('weighted_average');

    // Учётная политика меняет то, как считаются деньги по всей компании.
    // Такое обязано оставлять след в журнале действий (ТЗ 3.4) — раньше
    // настройки менялись бесследно.
    const log = await db.query<{ changes: any }>(
      `SELECT changes FROM audit_log
        WHERE entity_type = 'company_settings' AND entity_id = $1 AND action = 'update'
        ORDER BY id DESC LIMIT 1`,
      [companyUid],
    );
    expect(log.rowCount, 'запись о смене метода в журнале').toBe(1);
    expect(log.rows[0].changes.costingMethod.to).toBe('weighted_average');
  });

  it('придуманный метод не принимается', async () => {
    const res = await setMethod(director.token, 'lifo');
    expect(res.status).toBe(400);
  });
});

describe('метод меняет себестоимость списания', () => {
  it('FIFO берёт цену своей партии, средневзвешенная — среднюю по складу', async () => {
    expect((await receipt(`${RUN}-A`, '10', '1000')).status).toBe(201);
    expect((await receipt(`${RUN}-B`, '10', '2000')).status).toBe(201);

    expect((await setMethod(admin.token, 'fifo')).status).toBe(200);
    // Партия A стоила 1000 за тонну: две тонны из неё — это 2000.
    expect(await writeOff(`${RUN}-A`, '2')).toBeCloseTo(2000, 4);

    expect((await setMethod(admin.token, 'weighted_average')).status).toBe(200);
    // На складе осталось 8 т по 1000 и 10 т по 2000 — средняя 1555.5556.
    const avg = (8 * 1000 + 10 * 2000) / 18;
    expect(await writeOff(`${RUN}-A`, '2')).toBeCloseTo(2 * avg, 2);
  });
});
