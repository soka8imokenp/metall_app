/**
 * Материалы заказа: план, выдача в цех, возврат и факт. Живая база, приложение
 * целиком.
 *
 * Главное, что здесь проверяется, — что производство не завело себе второй
 * склад: выдача делает настоящее складское движение, остаток уменьшается, а
 * счётчик «выдано» в заказе и движение пишутся одной транзакцией. Плюс то,
 * ради чего план вообще нужен: расход сверх него становится строкой журнала
 * отклонений, а не растворяется в себестоимости.
 *
 * Прибираемся за собой: заказы со своими материалами удаляются, складские
 * движения сторнируются обратно — журнал движений дополняется, но остаток
 * демо-данных остаётся прежним.
 */
import 'dotenv/config';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ForbiddenException, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { AuthGuard } from '../src/auth/auth.guard.js';
import { ProductionModule } from '../src/production/production.module.js';
import { ProductionMaterialsService } from '../src/production/materials.service.js';
import { ContextMiddleware } from '../src/common/context.middleware.js';
import { EnvelopeInterceptor } from '../src/common/envelope.interceptor.js';
import { ErrorFilter } from '../src/common/error.filter.js';
import { runWithContext } from '../src/common/request-context.js';

let app: INestApplication;
let base: string;
let db: Client;
let service: ProductionMaterialsService;

const PASSWORD = process.env.SEED_PASSWORD ?? 'metall-dev-2026';

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
    throw new Error(`Логин ${loginName} не прошёл: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.data as { token: string; permissions: string[] };
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const json = (token: string) => ({ ...auth(token), 'Content-Type': 'application/json' });

const post = (token: string, path: string, body?: unknown) =>
  api(path, {
    method: 'POST',
    headers: json(token),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const put = (token: string, path: string, body: unknown) =>
  api(path, { method: 'PUT', headers: json(token), body: JSON.stringify(body) });
const get = (token: string, path: string) => api(path, { headers: auth(token) });

/** Мастер ведёт заказ, кладовщик двигает склад, админ умеет и то и другое. */
let master: Awaited<ReturnType<typeof login>>;
let keeper: Awaited<ReturnType<typeof login>>;
let admin: Awaited<ReturnType<typeof login>>;

let plantId: bigint;
let masterId: bigint;
let keeperId: bigint;
let cardedItem: string;
let rawItem: string;
let warehouseCode: string;
let rawBatch: string | null;
let rawLocation: string | null;
/** Материал, которого в карте точно нет: проверка выдачи «сверх плана». */
let offPlanItem: string;
/** Своя продукция и своя карта: на ней проверяется счёт плана с отходом. */
let wasteItem: string;
let wasteCardUid: string | null = null;

const trash: string[] = [];
/** Движения прогона: сторнируем, чтобы остаток демо-данных не поехал. */
const moves: string[] = [];

const day = (shift: number) => new Date(Date.now() + shift * 86_400_000).toISOString().slice(0, 10);

async function makeOrder(itemCode: string, qty = '2') {
  const res = await post(master.token, '/api/v1/production/orders', {
    itemCode,
    qtyPlanned: qty,
    dueDate: day(7),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  trash.push(res.body.data.uid);
  return res.body.data.uid as string;
}

const setStatus = (uid: string, status: string, comment?: string) =>
  post(master.token, `/api/v1/production/orders/${uid}/status`, {
    status,
    ...(comment ? { comment } : {}),
  });

/** Заказ с планом материалов, доведённый до работы. */
async function running(qty = '2') {
  const uid = await makeOrder(cardedItem, qty);
  expect((await post(master.token, `/api/v1/production/orders/${uid}/materials/from-card`)).status)
    .toBe(201);
  await post(master.token, `/api/v1/production/orders/${uid}/stages/from-card`);
  await setStatus(uid, 'planned');
  expect((await setStatus(uid, 'in_progress')).status).toBe(201);
  return uid;
}

const issue = (token: string, uid: string, body: Record<string, unknown>) =>
  post(token, `/api/v1/production/orders/${uid}/materials/issue`, {
    warehouseCode,
    ...(rawLocation ? { locationCode: rawLocation } : {}),
    ...(rawBatch ? { batchNumber: rawBatch } : {}),
    ...body,
  });

/**
 * Выдать материал, спросив у системы, откуда его брать.
 *
 * Номер партии и ячейку прогон не выдумывает: на заводе почти всё сырьё
 * партийное, и подставлять чужой номер значит проверять не выдачу, а отказ
 * склада. Заодно это проверка самого ответа «где взять».
 */
const give = async (uid: string, itemCode: string, qty: string) => {
  const where = await get(admin.token, `/api/v1/production/orders/${uid}/materials/stock?itemCode=${encodeURIComponent(itemCode)}`);
  expect(where.status, JSON.stringify(where.body)).toBe(200);
  const place = where.body.data.rows[0];
  expect(place, `материала ${itemCode} нет ни на одном складе`).toBeDefined();

  const res = await post(admin.token, `/api/v1/production/orders/${uid}/materials/issue`, {
    itemCode,
    qty,
    warehouseCode: place.warehouseCode,
    ...(place.locationCode ? { locationCode: place.locationCode } : {}),
    ...(place.batchNumber ? { batchNumber: place.batchNumber } : {}),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res;
};

const materials = async (uid: string) =>
  (
    await db.query<{
      code: string;
      qty_planned: string;
      qty_issued: string;
      qty_used: string;
      qty_returned: string;
    }>(
      `SELECT i.code, pm.qty_planned::text, pm.qty_issued::text, pm.qty_used::text,
              pm.qty_returned::text
         FROM production_material pm
         JOIN item i ON i.id = pm.item_id
         JOIN production_order o ON o.id = pm.production_order_id
        WHERE o.uid = $1::uuid ORDER BY i.code`,
      [uid],
    )
  ).rows;

const stockOf = async (code: string) =>
  Number(
    (
      await db.query<{ n: string }>(
        `SELECT coalesce(sum(b.qty_on_hand), 0)::text AS n
           FROM stock_balance b JOIN item i ON i.id = b.item_id
           JOIN warehouse w ON w.id = b.warehouse_id
          WHERE i.code = $1 AND w.code = $2`,
        [code, warehouseCode],
      )
    ).rows[0].n,
  );

const movesOf = async (uid: string) =>
  (
    await db.query<{ uid: string; operation_type: string; qty: string }>(
      `SELECT m.uid::text, m.operation_type::text, m.qty::text
         FROM stock_move m
         JOIN production_material pm ON pm.id = m.source_doc_id
         JOIN production_order o ON o.id = pm.production_order_id
        WHERE m.source_doc_type = 'production_material' AND o.uid = $1::uuid
        ORDER BY m.id`,
      [uid],
    )
  ).rows;

const deviations = async (uid: string, kind: string) =>
  (
    await db.query<{ amount: string; comment: string | null }>(
      `SELECT d.amount::text, d.comment FROM deviation_log d
         JOIN production_order o ON o.id = d.production_order_id
        WHERE o.uid = $1::uuid AND d.kind = $2::"DeviationKind" ORDER BY d.id`,
      [uid, kind],
    )
  ).rows;

const audit = async (uid: string) =>
  (
    await db.query<{ action: string; changes: any }>(
      `SELECT action, changes FROM audit_log
        WHERE entity_type = 'production_order' AND entity_id = $1 ORDER BY occurred_at, id`,
      [uid],
    )
  ).rows;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [PrismaModule, AuthModule, ProductionModule],
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
  service = app.get(ProductionMaterialsService);

  db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  master = await login('j.tashpulatov');
  keeper = await login('a.saidov');
  admin = await login('admin');

  plantId = BigInt(
    (await db.query<{ id: string }>(`SELECT id::text FROM company WHERE code = 'plant'`)).rows[0].id,
  );

  masterId = BigInt(
    (
      await db.query<{ id: string }>(
        `SELECT id::text FROM user_account WHERE login = 'j.tashpulatov'`,
      )
    ).rows[0].id,
  );
  keeperId = BigInt(
    (await db.query<{ id: string }>(`SELECT id::text FROM user_account WHERE login = 'a.saidov'`))
      .rows[0].id,
  );

  cardedItem = (
    await db.query<{ code: string }>(
      `SELECT i.code FROM item i
         JOIN tech_card tc ON tc.item_id = i.id AND tc.status = 'active'
        WHERE i.company_id = ${plantId}
          AND EXISTS (SELECT 1 FROM tech_card_material m WHERE m.tech_card_id = tc.id)
        ORDER BY i.code LIMIT 1`,
    )
  ).rows[0].code;

  // Материал, которого на складе завода правда много: проверка выдаёт его и
  // возвращает, а не ищет, чем бы занять остаток. На заводе почти всё сырьё
  // учитывается партиями, поэтому берём вместе с номером партии — склад без
  // него откажет, и это его правило, а не наше.
  const raw = await db.query<{
    code: string;
    warehouse: string;
    batch: string | null;
    location: string | null;
  }>(
    `SELECT i.code, w.code AS warehouse, bt.number AS batch, l.code AS location
       FROM stock_balance b JOIN item i ON i.id = b.item_id
       JOIN warehouse w ON w.id = b.warehouse_id
       LEFT JOIN batch bt ON bt.id = b.batch_id
       LEFT JOIN storage_location l ON l.id = b.location_id
      WHERE b.company_id = ${plantId} AND NOT i.track_serials
        AND b.qty_on_hand - b.qty_reserved > 200
        AND (NOT i.track_batches OR bt.id IS NOT NULL)
      ORDER BY b.qty_on_hand DESC LIMIT 1`,
  );
  rawItem = raw.rows[0].code;
  warehouseCode = raw.rows[0].warehouse;
  rawBatch = raw.rows[0].batch;
  rawLocation = raw.rows[0].location;

  // Карта прогона: один этап с отходом 5% и один материал на нём. Считать
  // план на карте посева нельзя — там отход может оказаться нулевым, и
  // проверка «план с отходом» ничего не проверит.
  wasteItem = (
    await db.query<{ code: string }>(
      `SELECT i.code FROM item i
        WHERE i.company_id = ${plantId} AND i.item_type IN ('finished', 'semi') AND i.is_active
          AND NOT EXISTS (SELECT 1 FROM tech_card tc WHERE tc.item_id = i.id)
        ORDER BY i.code LIMIT 1`,
    )
  ).rows[0].code;
  {
    const made = await post(master.token, '/api/v1/production/tech-cards', {
      itemCode: wasteItem,
      nameRu: 'Карта прогона материалов',
      nameUz: 'Material tekshiruvi kartasi',
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    wasteCardUid = made.body.data.uid;
    const filled = await api(`/api/v1/production/tech-cards/${wasteCardUid}`, {
      method: 'PATCH',
      headers: json(master.token),
      body: JSON.stringify({
        stages: [
          { seq: 1, nameRu: 'Единственный этап', nameUz: 'Yagona bosqich', normDurationMin: 10, wastePercent: '5' },
        ],
        materials: [{ itemCode: rawItem, qtyPerUnit: '2', stageSeq: 1 }],
      }),
    });
    expect(filled.status, JSON.stringify(filled.body)).toBe(200);
    expect((await post(master.token, `/api/v1/production/tech-cards/${wasteCardUid}/activate`)).status)
      .toBe(201);
  }

  offPlanItem = (
    await db.query<{ code: string }>(
      `SELECT i.code
         FROM stock_balance b JOIN item i ON i.id = b.item_id
        WHERE b.company_id = ${plantId} AND NOT i.track_serials
          AND b.qty_on_hand - b.qty_reserved > 10
          AND i.id NOT IN (
            SELECT m.item_id FROM tech_card_material m
             JOIN tech_card tc ON tc.id = m.tech_card_id
             JOIN item p ON p.id = tc.item_id
            WHERE p.code = $1 AND tc.status = 'active')
        ORDER BY b.qty_on_hand DESC LIMIT 1`,
      [cardedItem],
    )
  ).rows[0].code;
}, 90_000);

afterAll(async () => {
  if (db) {
    /**
     * Материал возвращаем на склад тем же путём, каким он уходил, — возвратом
     * из цеха по заказу. Сторнировать движение напрямую склад не даёт и
     * правильно делает: у движения есть основание, и отменяют основание.
     *
     * Отметку «израсходовано» перед этим снимаем прямо в базе: это наши же
     * строки прогона, и в них не было ни грамма настоящего расхода — цех
     * ничего не делал. Без этого вернуть было бы нельзя, и демо-данные
     * худели бы с каждым прогоном.
     */
    for (const uid of trash) {
      await db.query(
        `UPDATE production_material pm SET qty_used = 0
           FROM production_order o
          WHERE o.id = pm.production_order_id AND o.uid = $1::uuid`,
        [uid],
      );
      const left = await db.query<{
        code: string;
        qty: string;
        warehouse: string;
        location: string | null;
        batch: string | null;
      }>(
        `SELECT i.code, (pm.qty_issued - pm.qty_returned)::text AS qty,
                w.code AS warehouse, l.code AS location, b.number AS batch
           FROM production_material pm
           JOIN item i ON i.id = pm.item_id
           JOIN production_order o ON o.id = pm.production_order_id
           JOIN LATERAL (
             SELECT m.from_warehouse_id, m.from_location_id, m.batch_id
               FROM stock_move m
              WHERE m.source_doc_type = 'production_material' AND m.source_doc_id = pm.id
                AND m.operation_type = 'issue_to_production'
              ORDER BY m.id DESC LIMIT 1
           ) mv ON true
           JOIN warehouse w ON w.id = mv.from_warehouse_id
           LEFT JOIN storage_location l ON l.id = mv.from_location_id
           LEFT JOIN batch b ON b.id = mv.batch_id
          WHERE o.uid = $1::uuid AND pm.qty_issued - pm.qty_returned > 0`,
        [uid],
      );
      for (const row of left.rows) {
        const res = await post(admin.token, `/api/v1/production/orders/${uid}/materials/return`, {
          itemCode: row.code,
          qty: row.qty,
          warehouseCode: row.warehouse,
          ...(row.location ? { locationCode: row.location } : {}),
          ...(row.batch ? { batchNumber: row.batch } : {}),
        });
        if (res.status >= 300) {
          console.error(`материал ${row.code} не вернулся: ${JSON.stringify(res.body)}`);
        }
      }
    }
    if (wasteCardUid) {
      await db.query(
        `DELETE FROM tech_card_material WHERE tech_card_id =
           (SELECT id FROM tech_card WHERE uid = $1::uuid)`,
        [wasteCardUid],
      );
      await db.query(
        `DELETE FROM tech_card_stage WHERE tech_card_id =
           (SELECT id FROM tech_card WHERE uid = $1::uuid)`,
        [wasteCardUid],
      );
      await db.query(`DELETE FROM tech_card WHERE uid = $1::uuid`, [wasteCardUid]);
    }
    if (trash.length > 0) {
      await db.query(
        `DELETE FROM deviation_log WHERE production_order_id IN
           (SELECT id FROM production_order WHERE uid = ANY($1::uuid[]))`,
        [trash],
      );
      await db.query(
        `DELETE FROM production_material WHERE production_order_id IN
           (SELECT id FROM production_order WHERE uid = ANY($1::uuid[]))`,
        [trash],
      );
      await db.query(
        `DELETE FROM production_stage WHERE production_order_id IN
           (SELECT id FROM production_order WHERE uid = ANY($1::uuid[]))`,
        [trash],
      );
      await db.query(`DELETE FROM production_order WHERE uid = ANY($1::uuid[])`, [trash]);
    }
  }
  await db?.end();
  await app?.close();
});

describe('план расхода', () => {
  it('разворачивается из карты на количество заказа и с отходом этапа', async () => {
    const uid = await makeOrder(cardedItem, '2');
    const res = await post(master.token, `/api/v1/production/orders/${uid}/materials/from-card`);
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const card = await db.query<{ code: string; per_unit: string; waste: string | null }>(
      `SELECT i.code, m.qty_per_unit::text AS per_unit, s.waste_percent::text AS waste
         FROM tech_card_material m
         JOIN item i ON i.id = m.item_id
         LEFT JOIN tech_card_stage s ON s.id = m.stage_id
         JOIN production_order o ON o.tech_card_id = m.tech_card_id
        WHERE o.uid = $1::uuid ORDER BY i.code`,
      [uid],
    );
    const rows = await materials(uid);
    expect(rows.length).toBe(card.rows.length);
    for (const [i, r] of rows.entries()) {
      const waste = card.rows[i].waste === null ? 0 : Number(card.rows[i].waste);
      const want = Number(card.rows[i].per_unit) * 2 * (1 + waste / 100);
      expect(Number(r.qty_planned), `${r.code}: норма на 2 единицы с отходом`).toBeCloseTo(want, 5);
    }
    expect((await audit(uid)).map((l) => l.action)).toContain('material.plan');
  });

  it('в план входит отход этапа: 2 на единицу, 3 единицы, 5% отхода — 6,3', async () => {
    const uid = await makeOrder(wasteItem, '3');
    const res = await post(master.token, `/api/v1/production/orders/${uid}/materials/from-card`);
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const rows = await materials(uid);
    expect(rows.length).toBe(1);
    expect(rows[0].code).toBe(rawItem);
    expect(Number(rows[0].qty_planned), 'норма на количество и плюс отход этапа').toBeCloseTo(
      6.3,
      5,
    );
  });

  it('руками задаётся списком целиком, дважды один материал не принимается', async () => {
    const uid = await makeOrder(cardedItem);

    const twice = await put(master.token, `/api/v1/production/orders/${uid}/materials`, {
      materials: [
        { itemCode: rawItem, qtyPlanned: '5' },
        { itemCode: rawItem, qtyPlanned: '3' },
      ],
    });
    expect(twice.status, JSON.stringify(twice.body)).toBe(422);

    const empty = await put(master.token, `/api/v1/production/orders/${uid}/materials`, {
      materials: [],
    });
    expect(empty.status).toBe(422);

    const ok = await put(master.token, `/api/v1/production/orders/${uid}/materials`, {
      materials: [{ itemCode: rawItem, qtyPlanned: '5.5' }],
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const rows = await materials(uid);
    expect(rows.length).toBe(1);
    expect(Number(rows[0].qty_planned)).toBeCloseTo(5.5, 6);
  });

  it('после первой выдачи план не переписывают', async () => {
    const uid = await running();
    await give(uid, rawItem, '1');

    const res = await post(master.token, `/api/v1/production/orders/${uid}/materials/from-card`);
    expect(res.status).toBe(409);
    expect(String(res.body.error.message)).toMatch(/подо что материал ушёл/i);
  });

  it('кладовщик план не задаёт', async () => {
    const uid = await makeOrder(cardedItem);
    const res = await post(keeper.token, `/api/v1/production/orders/${uid}/materials/from-card`);
    expect(res.status).toBe(403);
  });
});

describe('выдача в цех и возврат', () => {
  it('выдача уменьшает остаток склада и помечена заказом', async () => {
    const uid = await running();
    const before = await stockOf(rawItem);

    const res = await give(uid, rawItem, '3');
    expect(res.body.data.qtyIssued).toBe('3.000000');

    expect(await stockOf(rawItem), 'со склада ушло ровно три').toBeCloseTo(before - 3, 5);
    const made = await movesOf(uid);
    expect(made.length, 'движение одно').toBe(1);
    expect(made[0].operation_type, 'это выдача в цех').toBe('issue_to_production');
    expect(Number(made[0].qty)).toBeCloseTo(3, 6);
    expect((await audit(uid)).map((l) => l.action)).toContain('material.issue');
  });

  it('возврат кладёт материал обратно и больше, чем на руках, не принимает', async () => {
    const uid = await running();
    await give(uid, rawItem, '4');
    const before = await stockOf(rawItem);

    const tooMuch = await post(admin.token, `/api/v1/production/orders/${uid}/materials/return`, {
      itemCode: rawItem,
      qty: '9',
      warehouseCode,
      ...(rawLocation ? { locationCode: rawLocation } : {}),
      ...(rawBatch ? { batchNumber: rawBatch } : {}),
    });
    expect(tooMuch.status, JSON.stringify(tooMuch.body)).toBe(422);
    expect(String(tooMuch.body.error.message)).toMatch(/на руках/i);

    const ok = await post(admin.token, `/api/v1/production/orders/${uid}/materials/return`, {
      itemCode: rawItem,
      qty: '1.5',
      warehouseCode,
      ...(rawLocation ? { locationCode: rawLocation } : {}),
      ...(rawBatch ? { batchNumber: rawBatch } : {}),
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(await stockOf(rawItem), 'полтора вернулись на склад').toBeCloseTo(before + 1.5, 5);
    const rows = (await materials(uid)).find((r) => r.code === rawItem)!;
    expect(Number(rows.qty_returned)).toBeCloseTo(1.5, 6);
  });

  it('по черновику материал не выдают', async () => {
    const uid = await makeOrder(cardedItem);
    const res = await issue(admin.token, uid, { itemCode: rawItem, qty: '1' });
    expect(res.status).toBe(409);
    expect(String(res.body.error.message)).toMatch(/запланируйте/i);
    expect((await movesOf(uid)).length).toBe(0);
  });

  it('мастер производства склад руками не двигает', async () => {
    const uid = await running();
    const res = await issue(master.token, uid, { itemCode: rawItem, qty: '1' });
    expect(res.status, 'выдача со склада — право кладовщика').toBe(403);
    expect((await movesOf(uid)).length).toBe(0);
  });

  it('кладовщик выдаёт: заказ он видит, в план не лезет', async () => {
    const uid = await running();
    expect(keeper.permissions).toContain('production.view');
    expect(keeper.permissions).not.toContain('production.manage');

    const card = await get(keeper.token, `/api/v1/production/orders/${uid}`);
    expect(card.status, 'кладовщик открывает карточку заказа').toBe(200);

    const res = await issue(keeper.token, uid, { itemCode: rawItem, qty: '2' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((await movesOf(uid)).length).toBe(1);
  });

  it('материала, которого нет в плане, выдача заводит строкой с нулевым планом', async () => {
    const uid = await running();
    await give(uid, offPlanItem, '1');

    const row = (await materials(uid)).find((r) => r.code === offPlanItem)!;
    expect(Number(row.qty_planned), 'плана по нему не было').toBeCloseTo(0, 6);
    expect(Number(row.qty_issued)).toBeCloseTo(1, 6);
  });

  it('склада на свете столько нет — выдача отбивается складом, а не заказом', async () => {
    const uid = await running();
    const res = await issue(admin.token, uid, { itemCode: rawItem, qty: '999999' });
    expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(400);
    expect((await movesOf(uid)).length, 'счётчик заказа не вырос').toBe(0);
    const row = (await materials(uid)).find((r) => r.code === rawItem);
    expect(row === undefined || Number(row.qty_issued) === 0).toBe(true);
  });
});

describe('расход и перерасход', () => {
  it('расход не больше, чем на руках', async () => {
    const uid = await running();
    await give(uid, rawItem, '2');

    const tooMuch = await post(master.token, `/api/v1/production/orders/${uid}/materials/use`, {
      itemCode: rawItem,
      qty: '5',
    });
    expect(tooMuch.status).toBe(422);
    expect(String(tooMuch.body.error.message)).toMatch(/выдайте материал/i);

    const ok = await post(master.token, `/api/v1/production/orders/${uid}/materials/use`, {
      itemCode: rawItem,
      qty: '2',
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.data.qtyOnHand).toBe('0.000000');
  });

  it('расход сверх плана пишет строку в журнал отклонений — на разницу', async () => {
    const uid = await running();
    const planned = Number((await materials(uid))[0].qty_planned);
    const code = (await materials(uid))[0].code;
    await give(uid, code, String(planned + 3));

    // В плане — израсходовали ровно по норме: отклонения нет.
    await post(master.token, `/api/v1/production/orders/${uid}/materials/use`, {
      itemCode: code,
      qty: String(planned),
    });
    expect((await deviations(uid, 'overuse')).length, 'по норме — не отклонение').toBe(0);

    // Сверх нормы — отклонение ровно на превышение.
    await post(master.token, `/api/v1/production/orders/${uid}/materials/use`, {
      itemCode: code,
      qty: '2',
    });
    const over = await deviations(uid, 'overuse');
    expect(over.length).toBe(1);
    expect(Number(over[0].amount), 'записана разница, а не весь расход').toBeCloseTo(2, 5);

    // Ещё раз сверх нормы — вторая строка, снова только на новую разницу.
    await post(master.token, `/api/v1/production/orders/${uid}/materials/use`, {
      itemCode: code,
      qty: '1',
    });
    const again = await deviations(uid, 'overuse');
    expect(again.length).toBe(2);
    expect(Number(again[1].amount)).toBeCloseTo(1, 5);

    const row = (await materials(uid)).find((r) => r.code === code)!;
    expect(Number(row.qty_used)).toBeCloseTo(planned + 3, 5);
  });

  it('по незапущенному заказу расход не отмечают', async () => {
    const uid = await makeOrder(cardedItem);
    await post(master.token, `/api/v1/production/orders/${uid}/materials/from-card`);
    await setStatus(uid, 'planned');

    const res = await post(master.token, `/api/v1/production/orders/${uid}/materials/use`, {
      itemCode: rawItem,
      qty: '1',
    });
    expect(res.status).toBe(409);
    expect(String(res.body.error.message)).toMatch(/в работе/i);
  });

  it('кладовщик расход не отмечает: это факт цеха, а не склада', async () => {
    const uid = await running();
    await give(uid, rawItem, '1');
    const res = await post(keeper.token, `/api/v1/production/orders/${uid}/materials/use`, {
      itemCode: rawItem,
      qty: '1',
    });
    expect(res.status).toBe(403);
  });

  it('израсходованное обратно на склад не возвращают', async () => {
    const uid = await running();
    await give(uid, rawItem, '2');
    await post(master.token, `/api/v1/production/orders/${uid}/materials/use`, {
      itemCode: rawItem,
      qty: '2',
    });

    const res = await post(admin.token, `/api/v1/production/orders/${uid}/materials/return`, {
      itemCode: rawItem,
      qty: '1',
      warehouseCode,
      ...(rawLocation ? { locationCode: rawLocation } : {}),
      ...(rawBatch ? { batchNumber: rawBatch } : {}),
    });
    expect(res.status).toBe(422);
    expect(String(res.body.error.message)).toMatch(/переделк/i);
  });
});

/**
 * Правило живёт в службе, а не только в маршруте.
 *
 * Через HTTP оба отказа даёт охранник маршрута, и проверка «служба тоже
 * отказывает» через него ничего не проверяет: сними правило из службы —
 * маршрут всё равно отобьёт. Поэтому зовём службу напрямую с собранным
 * набором прав: так ломается ровно то место, которое проверяется.
 */
describe('права проверяет и сама служба', () => {
  const as = <T>(userId: bigint, perms: string[], fn: () => Promise<T>) =>
    runWithContext(
      {
        userId,
        companyIds: [plantId],
        permissions: new Set(perms),
        requestId: 'test-perm',
        source: 'web',
      } as any,
      fn,
    );

  it('без складского права материал не выдают', async () => {
    const uid = await running();
    await expect(
      as(masterId, ['production.view', 'production.manage'], () =>
        service.issue(uid, { itemCode: rawItem, qty: '1', warehouseCode }),
      ),
      'выдача со склада — складское право',
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('без права вести производство расход не отмечают', async () => {
    const uid = await running();
    await give(uid, rawItem, '1');
    await expect(
      as(keeperId, ['production.view', 'warehouse.move'], () =>
        service.use(uid, { itemCode: rawItem, qty: '1' }),
      ),
      'расход — факт цеха',
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('карточка заказа', () => {
  it('показывает план, выдачу, расход и отклонение со знаком', async () => {
    const uid = await running();
    const code = (await materials(uid))[0].code;
    const planned = Number((await materials(uid))[0].qty_planned);
    await give(uid, code, String(planned + 1));
    await post(master.token, `/api/v1/production/orders/${uid}/materials/use`, {
      itemCode: code,
      qty: String(planned + 1),
    });

    const card = await get(master.token, `/api/v1/production/orders/${uid}`);
    const row = card.body.data.materials.find((m: any) => m.itemCode === code);
    expect(Number(row.qtyIssued)).toBeCloseTo(planned + 1, 5);
    expect(Number(row.qtyUsed)).toBeCloseTo(planned + 1, 5);
    expect(Number(row.deviationQty), 'перерасход виден со знаком плюс').toBeCloseTo(1, 5);
  });

  it('заказ с материалом на руках не отменяют', async () => {
    const uid = await running();
    await give(uid, rawItem, '1');

    const res = await setStatus(uid, 'cancelled', 'Заказчик снял заявку');
    expect(res.status).toBe(409);
    expect(String(res.body.error.message)).toMatch(/верните его на склад/i);
  });
});
