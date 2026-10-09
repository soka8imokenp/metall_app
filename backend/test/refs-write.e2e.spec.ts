/**
 * Справочники на запись: приложение целиком, живая база (ТЗ 5.2, 5.3, 5.7, 5.10).
 *
 * Проверяем не «маршрут ответил», а правила, ради которых этот этап и делался:
 * заведённая позиция появляется в подборе формы операции; коэффициент
 * пересчёта хранится при позиции; справочник, по которому есть история, не
 * удаляется, а выключается; правки, меняющие смысл уже записанного, сервер
 * отклоняет; правка справочника требует своего права, а не права кладовщика.
 *
 * Прогон пишет и за собой убирает: всё заведённое он же и удаляет.
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
  return res.body.data as { token: string; permissions: string[]; companies: any[] };
}

let admin: Awaited<ReturnType<typeof login>>;
let keeper: Awaited<ReturnType<typeof login>>;
let tradeUid: string;

const head = (s: Awaited<ReturnType<typeof login>>, companyUid?: string) => ({
  Authorization: `Bearer ${s.token}`,
  'Content-Type': 'application/json',
  ...(companyUid ? { 'X-Company-Id': companyUid } : {}),
});

const post = (path: string, s: typeof admin, body: unknown, companyUid = tradeUid) =>
  api(path, { method: 'POST', headers: head(s, companyUid), body: JSON.stringify(body) });

const patch = (path: string, s: typeof admin, body: unknown, companyUid = tradeUid) =>
  api(path, { method: 'PATCH', headers: head(s, companyUid), body: JSON.stringify(body) });

const del = (path: string, s: typeof admin, companyUid = tradeUid) =>
  api(path, { method: 'DELETE', headers: head(s, companyUid) });

const get = (path: string, s: typeof admin, companyUid = tradeUid) =>
  api(path, { headers: head(s, companyUid) });

const stamp = Date.now().toString().slice(-6);

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
  keeper = await login('a.saidov');
  tradeUid = admin.companies.find((c: any) => c.code === 'trade').uid;
}, 60_000);

afterAll(async () => {
  await db?.end();
  await app?.close();
});

describe('право на правку справочников', () => {
  it('у кладовщика его нет, у администратора есть', () => {
    expect(keeper.permissions).not.toContain('refs.edit');
    expect(admin.permissions).toContain('refs.edit');
  });

  it('кладовщик читает справочник, но не пишет', async () => {
    const read = await get('/api/v1/refs/items?limit=5', keeper);
    expect(read.status).toBe(200);

    const write = await post(
      '/api/v1/refs/items',
      keeper,
      { code: `QA-${stamp}-X`, nameRu: 'Проба', itemType: 'goods', baseUnit: 't' },
    );
    expect(write.status).toBe(403);
  });
});

describe('номенклатура с характеристиками металлопроката (ТЗ 5.2)', () => {
  let uid: string;
  const code = `QA-${stamp}`;

  it('заводится с размерами, ГОСТом и коэффициентами пересчёта', async () => {
    const res = await post('/api/v1/refs/items', admin, {
      code,
      nameRu: 'Труба QA 57×3,5 ГОСТ 10704-91',
      itemType: 'goods',
      baseUnit: 't',
      trackBatches: true,
      minQty: 10,
      criticalQty: 4,
      pipeType: 'Прямошовная',
      steelGrade: 'Ст3сп',
      diameterMm: 57,
      wallThicknessMm: 3.5,
      lengthMm: 6000,
      weightKgPerUnit: 28.5,
      gost: 'ГОСТ 10704-91',
      units: [
        { unit: 'm', factor: 0.0285 },
        { unit: 'pcs', factor: 0.171 },
      ],
    });
    expect(res.status).toBe(201);
    uid = res.body.data.uid;

    const list = await get(`/api/v1/refs/items?search=${encodeURIComponent(code)}`, admin);
    const row = list.body.data.rows.find((r: any) => r.code === code);
    expect(row).toBeDefined();
    expect(row.attributes).toMatchObject({ steelGrade: 'Ст3сп', gost: 'ГОСТ 10704-91' });
    expect(Number(row.attributes.diameterMm)).toBe(57);
    expect(Number(row.attributes.weightKgPerUnit)).toBe(28.5);
    expect(row.units.map((u: any) => u.unit).sort()).toEqual(['m', 'pcs']);
    expect(Number(row.units.find((u: any) => u.unit === 'm').factor)).toBeCloseTo(0.0285, 6);
    expect(row.moves).toBe(0);
  });

  it('появляется в подборе формы операции, а не только в справочнике', async () => {
    const refs = await get('/api/v1/warehouse/refs', admin);
    const found = refs.body.data.items.find((i: any) => i.code === code);
    expect(found, 'заведённая позиция в справочнике формы').toBeDefined();
    expect(found.trackBatches).toBe(true);
  });

  it('второй раз тот же код не заводится', async () => {
    const res = await post('/api/v1/refs/items', admin, {
      code,
      nameRu: 'Двойник',
      itemType: 'goods',
      baseUnit: 't',
    });
    expect(res.status).toBe(409);
  });

  it('коэффициент базовой единицы не задать: он равен единице', async () => {
    const res = await patch(`/api/v1/refs/items/${uid}`, admin, {
      units: [{ unit: 't', factor: 0.98 }],
    });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('базовой единицы');
  });

  it('нулевой и отрицательный коэффициент не проходят', async () => {
    for (const factor of [0, -1]) {
      const res = await patch(`/api/v1/refs/items/${uid}`, admin, {
        units: [{ unit: 'm', factor }],
      });
      expect(res.status).toBe(400);
    }
  });

  it('критический уровень выше минимального отклоняется с объяснением', async () => {
    const res = await patch(`/api/v1/refs/items/${uid}`, admin, { minQty: 5, criticalQty: 9 });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('ниже минимума');
  });

  it('правится: имя, уровни и характеристики', async () => {
    const res = await patch(`/api/v1/refs/items/${uid}`, admin, {
      nameRu: 'Труба QA 57×3,5 (правленая)',
      minQty: 12,
      criticalQty: 6,
      steelGrade: '20',
    });
    expect(res.status).toBe(200);

    const list = await get(`/api/v1/refs/items?search=${encodeURIComponent(code)}`, admin);
    const row = list.body.data.rows[0];
    expect(row.nameRu).toContain('правленая');
    expect(Number(row.minQty)).toBe(12);
    expect(row.attributes.steelGrade).toBe('20');
  });

  it('удаляется, пока ни в чём не участвовала', async () => {
    const res = await del(`/api/v1/refs/items/${uid}`, admin);
    expect(res.status).toBe(200);
    const left = await db.query('SELECT 1 FROM item WHERE uid = $1', [uid]);
    expect(left.rowCount).toBe(0);
  });

  it('заведение, правка и удаление лежат в журнале действий (ТЗ 3.4)', async () => {
    // Справочники в журнал не писали вовсе. А это решения, по которым потом
    // разбирают, почему склад считает не то, что ждали: смена единицы, уровня,
    // партионного учёта. Запись остаётся и после удаления самой позиции —
    // `audit_log` только на добавление.
    const log = await db.query<{ action: string; changes: any }>(
      `SELECT action, changes FROM audit_log
        WHERE entity_type = 'item' AND entity_id = $1 ORDER BY id`,
      [uid],
    );
    const actions = log.rows.map((r) => r.action);
    for (const need of ['create', 'update', 'delete']) {
      expect(actions, `журнал по позиции: ${need}`).toContain(need);
    }
    expect(log.rows.find((r) => r.action === 'create')!.changes.code.to).toBe(code);
    const edit = log.rows.find((r) => r.action === 'update' && r.changes.minQty)!;
    expect(Number(edit.changes.minQty.from)).toBe(10);
    expect(Number(edit.changes.minQty.to)).toBe(12);
    expect(log.rows.find((r) => r.action === 'delete')!.changes.code).toEqual({
      from: code,
      to: null,
    });
  });
});

describe('что запрещено менять у позиции с историей', () => {
  let used: any;

  beforeAll(async () => {
    const list = await get('/api/v1/refs/items?limit=200', admin);
    used = list.body.data.rows.find((r: any) => r.moves > 0);
    expect(used, 'позиция с движениями в сиде').toBeDefined();
  });

  it('код не меняется: он напечатан на этикетках и стоит в истории', async () => {
    const res = await patch(`/api/v1/refs/items/${used.uid}`, admin, { code: `${used.code}-NEW` });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('этикетках');
  });

  it('базовая единица не меняется: история пересчиталась бы задним числом', async () => {
    const other = used.baseUnit === 't' ? 'pcs' : 't';
    const res = await patch(`/api/v1/refs/items/${used.uid}`, admin, { baseUnit: other });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('Базовую единицу');
  });

  it('позиция с движениями не удаляется, только выключается', async () => {
    const res = await del(`/api/v1/refs/items/${used.uid}`, admin);
    expect(res.status).toBe(409);

    const off = await patch(`/api/v1/refs/items/${used.uid}`, admin, { isActive: false });
    expect(off.status).toBe(200);
    const back = await patch(`/api/v1/refs/items/${used.uid}`, admin, { isActive: true });
    expect(back.status).toBe(200);
  });

  it('партионный учёт не выключить, пока есть партии', async () => {
    const list = await get('/api/v1/refs/items?limit=200', admin);
    const withBatches = await db.query(
      `SELECT i.uid FROM item i
         JOIN company c ON c.id = i.company_id AND c.code = 'trade'
        WHERE EXISTS (SELECT 1 FROM batch b WHERE b.item_id = i.id) LIMIT 1`,
    );
    const uid = withBatches.rows[0].uid;
    expect(list.body.data.rows.length).toBeGreaterThan(0);

    const res = await patch(`/api/v1/refs/items/${uid}`, admin, { trackBatches: false });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('партий');
  });
});

describe('склады, зоны и ячейки (ТЗ 5.3)', () => {
  let warehouseUid: string;
  let zoneUid: string;
  let locationUid: string;

  it('склад, зона и ячейка заводятся и видны деревом', async () => {
    const w = await post('/api/v1/refs/warehouses', admin, {
      code: `QAW${stamp}`,
      nameRu: 'Склад QA',
      address: 'Проверочный адрес',
    });
    expect(w.status).toBe(201);
    warehouseUid = w.body.data.uid;

    const z = await post('/api/v1/refs/zones', admin, {
      warehouseUid,
      code: 'QA-Z',
      nameRu: 'Зона QA',
    });
    expect(z.status).toBe(201);
    zoneUid = z.body.data.uid;

    const l = await post('/api/v1/refs/locations', admin, {
      zoneUid,
      code: 'QA-01',
      barcode: `QALOC${stamp}`,
    });
    expect(l.status).toBe(201);
    locationUid = l.body.data.uid;

    const tree = await get('/api/v1/refs/places', admin);
    const wh = tree.body.data.rows.find((r: any) => r.uid === warehouseUid);
    expect(wh.zones[0].locations[0].code).toBe('QA-01');
    expect(wh.zones[0].locations[0].hasStock).toBe(false);
  });

  it('ячейка приезжает в подбор формы операции', async () => {
    const refs = await get('/api/v1/warehouse/refs', admin);
    const loc = refs.body.data.locations.find((l: any) => l.code === 'QA-01');
    expect(loc).toBeDefined();
  });

  it('код ячейки в зоне не повторяется', async () => {
    const again = await post('/api/v1/refs/locations', admin, { zoneUid, code: 'QA-01' });
    expect(again.status).toBe(409);
  });

  it('склад с остатком не выключить', async () => {
    const busy = await db.query(
      `SELECT w.uid FROM warehouse w
         JOIN company c ON c.id = w.company_id AND c.code = 'trade'
        WHERE EXISTS (SELECT 1 FROM stock_balance b WHERE b.warehouse_id = w.id AND b.qty_on_hand <> 0)
        LIMIT 1`,
    );
    const res = await patch(`/api/v1/refs/warehouses/${busy.rows[0].uid}`, admin, {
      isActive: false,
    });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('остатка');
  });

  it('ячейка с товаром не выключается', async () => {
    const busy = await db.query(
      `SELECT l.uid FROM storage_location l
         JOIN warehouse_zone z ON z.id = l.zone_id
         JOIN warehouse w ON w.id = z.warehouse_id
         JOIN company c ON c.id = w.company_id AND c.code = 'trade'
        WHERE EXISTS (SELECT 1 FROM stock_balance b WHERE b.location_id = l.id AND b.qty_on_hand <> 0)
        LIMIT 1`,
    );
    const res = await patch(`/api/v1/refs/locations/${busy.rows[0].uid}`, admin, {
      isActive: false,
    });
    expect(res.status).toBe(422);
  });

  it('пустая ячейка удаляется, использованная — нет', async () => {
    const used = await db.query(
      `SELECT l.uid FROM storage_location l
         JOIN warehouse_zone z ON z.id = l.zone_id
         JOIN warehouse w ON w.id = z.warehouse_id
         JOIN company c ON c.id = w.company_id AND c.code = 'trade'
        WHERE EXISTS (SELECT 1 FROM stock_move m
                       WHERE m.from_location_id = l.id OR m.to_location_id = l.id)
        LIMIT 1`,
    );
    const denied = await del(`/api/v1/refs/locations/${used.rows[0].uid}`, admin);
    expect(denied.status).toBe(409);

    const ok = await del(`/api/v1/refs/locations/${locationUid}`, admin);
    expect(ok.status).toBe(200);
  });

  it('заведённый склад убирается за собой', async () => {
    await db.query('DELETE FROM warehouse_zone WHERE uid = $1', [zoneUid]);
    await db.query('DELETE FROM warehouse WHERE uid = $1', [warehouseUid]);
    const left = await db.query('SELECT 1 FROM warehouse WHERE uid = $1', [warehouseUid]);
    expect(left.rowCount).toBe(0);
  });
});

describe('причины списания (ТЗ 5.7)', () => {
  let uid: string;

  it('заводится и правится', async () => {
    const res = await post('/api/v1/refs/reasons', admin, {
      kind: 'write_off',
      nameRu: `Причина QA ${stamp}`,
    });
    expect(res.status).toBe(201);
    uid = res.body.data.uid;

    const upd = await patch(`/api/v1/refs/reasons/${uid}`, admin, {
      nameRu: `Причина QA ${stamp} (правлена)`,
    });
    expect(upd.status).toBe(200);

    const list = await get('/api/v1/refs/reasons', admin);
    const row = list.body.data.rows.find((r: any) => r.uid === uid);
    expect(row.nameRu).toContain('правлена');
    expect(row.moves).toBe(0);
  });

  it('использованная причина не удаляется, а выключается', async () => {
    const used = await db.query(
      `SELECT r.uid FROM stock_reason r
         JOIN company c ON c.id = r.company_id AND c.code = 'trade'
        WHERE EXISTS (SELECT 1 FROM stock_move m WHERE m.reason_id = r.id) LIMIT 1`,
    );
    const denied = await del(`/api/v1/refs/reasons/${used.rows[0].uid}`, admin);
    expect(denied.status).toBe(409);
    expect(denied.body.error.message).toContain('списано');

    const off = await patch(`/api/v1/refs/reasons/${used.rows[0].uid}`, admin, { isActive: false });
    expect(off.status).toBe(200);
    const on = await patch(`/api/v1/refs/reasons/${used.rows[0].uid}`, admin, { isActive: true });
    expect(on.status).toBe(200);
  });

  it('неиспользованная удаляется', async () => {
    const res = await del(`/api/v1/refs/reasons/${uid}`, admin);
    expect(res.status).toBe(200);
  });
});

describe('уровни запаса на склад (ТЗ 5.10)', () => {
  let itemUid: string;
  let warehouseUid: string;
  let levelUid: string;

  beforeAll(async () => {
    // Пара из той же компании, что и заголовок запроса: позиция чужой
    // компании под RLS просто не видна, и проверялась бы изоляция, а не уровни.
    const row = await db.query(
      `SELECT i.uid AS item_uid, w.uid AS warehouse_uid
         FROM item i
         JOIN warehouse w ON w.company_id = i.company_id
         JOIN company c ON c.id = i.company_id AND c.code = 'trade'
        WHERE NOT EXISTS (SELECT 1 FROM item_stock_level s
                           WHERE s.item_id = i.id AND s.warehouse_id = w.id)
        LIMIT 1`,
    );
    itemUid = row.rows[0].item_uid;
    warehouseUid = row.rows[0].warehouse_uid;
  });

  it('уровень ставится и переписывается, а не задваивается', async () => {
    const first = await post('/api/v1/refs/stock-levels', admin, {
      itemUid,
      warehouseUid,
      minQty: 30,
      criticalQty: 10,
      comment: 'проверка',
    });
    expect(first.status).toBe(201);
    levelUid = first.body.data.uid;

    const second = await post('/api/v1/refs/stock-levels', admin, {
      itemUid,
      warehouseUid,
      minQty: 40,
      criticalQty: 15,
    });
    expect(second.status).toBe(201);
    expect(second.body.data.uid).toBe(levelUid);

    const list = await get('/api/v1/refs/stock-levels', admin);
    const mine = list.body.data.rows.filter((r: any) => r.uid === levelUid);
    expect(mine).toHaveLength(1);
    expect(Number(mine[0].minQty)).toBe(40);
  });

  it('уровень виден в потребности в закупке, а не только в справочнике', async () => {
    const needs = await get('/api/v1/warehouse/purchase-needs?all=true&limit=500', admin);
    expect(needs.status).toBe(200);
    const rows = needs.body.data.rows as any[];
    expect(rows.some((r: any) => r.warehouse)).toBe(true);
  });

  it('критический выше минимального не принимается', async () => {
    const res = await post('/api/v1/refs/stock-levels', admin, {
      itemUid,
      warehouseUid,
      minQty: 10,
      criticalQty: 20,
    });
    expect(res.status).toBe(422);
  });

  it('оба нуля не принимаются: строка бы молча выключила уровень компании', async () => {
    const res = await post('/api/v1/refs/stock-levels', admin, {
      itemUid,
      warehouseUid,
      minQty: 0,
      criticalQty: 0,
    });
    expect(res.status).toBe(422);
  });

  it('удаляется', async () => {
    const res = await del(`/api/v1/refs/stock-levels/${levelUid}`, admin);
    expect(res.status).toBe(200);
  });
});
