/**
 * Себестоимость производственного заказа. Живая база, приложение целиком.
 *
 * Главное, что здесь проверяется: цифра собрана из фактов, а не из плана.
 * Материал берётся по записанному расходу и по той цене, по которой он ушёл
 * со склада; брак базу не уменьшает; переделка добавляется отдельной строкой;
 * расчёт — снимок, и прежний остаётся в истории.
 *
 * Прибираемся за собой тем же способом, что прогон выпуска: выпущенное
 * списываем, материал возвращаем, заказы удаляем.
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
import { ProductionCostService } from '../src/production/cost.service.js';
import { ContextMiddleware } from '../src/common/context.middleware.js';
import { EnvelopeInterceptor } from '../src/common/envelope.interceptor.js';
import { ErrorFilter } from '../src/common/error.filter.js';
import { runWithContext } from '../src/common/request-context.js';

let app: INestApplication;
let base: string;
let db: Client;
let costs: ProductionCostService;

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
    throw new Error(`Логин ${loginName} не прошёл: ${res.status}`);
  }
  return res.body.data as {
    token: string;
    permissions: string[];
    companies: { uid: string; code: string }[];
  };
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const json = (token: string) => ({ ...auth(token), 'Content-Type': 'application/json' });
const post = (token: string, path: string, body?: unknown) =>
  api(path, {
    method: 'POST',
    headers: json(token),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const get = (token: string, path: string) => api(path, { headers: auth(token) });

let master: Awaited<ReturnType<typeof login>>;
let keeper: Awaited<ReturnType<typeof login>>;
let admin: Awaited<ReturnType<typeof login>>;

let plantId: bigint;
let plantUid: string;
let masterId: bigint;
let madeItem: string;
let warehouseCode: string;
let locationCode: string | null;
let defectReason: string;

const trash: string[] = [];
const day = (shift: number) => new Date(Date.now() + shift * 86_400_000).toISOString().slice(0, 10);

const setStatus = (uid: string, status: string) =>
  post(master.token, `/api/v1/production/orders/${uid}/status`, { status });

async function makeOrder(qty = '10') {
  const res = await post(master.token, '/api/v1/production/orders', {
    itemCode: madeItem,
    qtyPlanned: qty,
    dueDate: day(7),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  trash.push(res.body.data.uid);
  return res.body.data.uid as string;
}

/** Заказ в работе с планом материалов из карты. */
async function running(qty = '10') {
  const uid = await makeOrder(qty);
  await post(master.token, `/api/v1/production/orders/${uid}/materials/from-card`);
  await post(master.token, `/api/v1/production/orders/${uid}/stages/from-card`);
  await setStatus(uid, 'planned');
  expect((await setStatus(uid, 'in_progress')).status).toBe(201);
  return uid;
}

const where = () => ({ warehouseCode, ...(locationCode ? { locationCode } : {}) });

/** Выдать материал оттуда, где он лежит, и записать его расход. */
async function spend(uid: string, itemCode: string, qty: string) {
  const stock = await get(
    admin.token,
    `/api/v1/production/orders/${uid}/materials/stock?itemCode=${encodeURIComponent(itemCode)}`,
  );
  const place = stock.body.data.rows[0];
  expect(place, `материала ${itemCode} нет на складах`).toBeDefined();
  const issued = await post(admin.token, `/api/v1/production/orders/${uid}/materials/issue`, {
    itemCode,
    qty,
    warehouseCode: place.warehouseCode,
    ...(place.locationCode ? { locationCode: place.locationCode } : {}),
    ...(place.batchNumber ? { batchNumber: place.batchNumber } : {}),
  });
  expect(issued.status, JSON.stringify(issued.body)).toBe(201);
  const used = await post(master.token, `/api/v1/production/orders/${uid}/materials/use`, {
    itemCode,
    qty,
  });
  expect(used.status, JSON.stringify(used.body)).toBe(201);
  // Цена списания — та, что записал склад в движение выдачи.
  const row = await db.query<{ unit_cost: string }>(
    `SELECT (m.cost_total / m.qty)::text AS unit_cost FROM stock_move m
       JOIN production_material pm ON pm.id = m.source_doc_id
       JOIN production_order o ON o.id = pm.production_order_id
       JOIN item i ON i.id = pm.item_id
      WHERE m.source_doc_type = 'production_material' AND o.uid = $1::uuid AND i.code = $2
      ORDER BY m.id DESC LIMIT 1`,
    [uid, itemCode],
  );
  const price = Number(row.rows[0].unit_cost);
  expect(price, `${itemCode}: цена выдачи нулевая — проверять «по цене» нечем`).toBeGreaterThan(0);
  return price;
}

/** Закрыть этапы и сдать годное: без этого заказ не выпустить. */
async function finish(uid: string, good: string, workedMinutes = 0) {
  const stages = await db.query<{ seq: number }>(
    `SELECT s.seq FROM production_stage s JOIN production_order o ON o.id = s.production_order_id
      WHERE o.uid = $1::uuid ORDER BY s.seq`,
    [uid],
  );
  for (const s of stages.rows) {
    await post(master.token, `/api/v1/production/orders/${uid}/stages/${s.seq}/mark`, { kind: 'start' });
    if (workedMinutes > 0) {
      // Час работы отматываем назад в самом журнале отметок: нажать «начал» и
      // ждать час прогон не может, а время считается по событиям, и портить
      // их колонкой `actual_duration_min` нельзя — сверка журнала и колонки
      // живёт отдельной проверкой.
      await db.query(
        `UPDATE production_stage_event e SET occurred_at = now() - ($3 || ' minutes')::interval
           FROM production_stage st JOIN production_order o ON o.id = st.production_order_id
          WHERE e.stage_id = st.id AND o.uid = $1::uuid AND st.seq = $2 AND e.event = 'start'`,
        [uid, s.seq, String(workedMinutes)],
      );
    }
    await post(master.token, `/api/v1/production/orders/${uid}/stages/${s.seq}/mark`, { kind: 'finish' });
  }
  const res = await post(master.token, `/api/v1/production/orders/${uid}/output`, {
    kind: 'good',
    qty: good,
    ...where(),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

const costOf = async (uid: string) => (await get(master.token, `/api/v1/production/orders/${uid}/cost`)).body.data;

/**
 * Материал заказа, которого на складе точно хватит.
 *
 * Первый по алфавиту не годится: в демо-данных у него может лежать две тонны,
 * и прогон упрётся в отказ склада вместо того, что проверяет.
 */
const richMaterial = async (uid: string, need: number) => {
  const rows = await db.query<{ code: string }>(
    `SELECT i.code
       FROM production_material pm
       JOIN item i ON i.id = pm.item_id
       JOIN production_order o ON o.id = pm.production_order_id
       JOIN LATERAL (
         SELECT SUM(b.qty_on_hand - b.qty_reserved) AS free FROM stock_balance b
          WHERE b.company_id = o.company_id AND b.item_id = pm.item_id AND b.unit_cost > 0
       ) st ON true
      WHERE o.uid = $1::uuid AND st.free > $2
      ORDER BY st.free DESC LIMIT 1`,
    [uid, need],
  );
  expect(rows.rows[0], `в заказе нет материала с ценой и запасом больше ${need}`).toBeDefined();
  return rows.rows[0].code;
};

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
  costs = app.get(ProductionCostService);

  db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  master = await login('j.tashpulatov');
  keeper = await login('a.saidov');
  admin = await login('admin');

  const plant = (
    await db.query<{ id: string; uid: string }>(
      `SELECT id::text, uid::text FROM company WHERE code = 'plant'`,
    )
  ).rows[0];
  plantId = BigInt(plant.id);
  plantUid = plant.uid;
  masterId = BigInt(
    (
      await db.query<{ id: string }>(
        `SELECT id::text FROM user_account WHERE login = 'j.tashpulatov'`,
      )
    ).rows[0].id,
  );

  madeItem = (
    await db.query<{ code: string }>(
      `SELECT i.code FROM item i
         JOIN tech_card tc ON tc.item_id = i.id AND tc.status = 'active'
        WHERE i.company_id = ${plantId} AND i.track_batches AND NOT i.track_serials
          AND EXISTS (SELECT 1 FROM tech_card_material m WHERE m.tech_card_id = tc.id)
        ORDER BY i.code LIMIT 1`,
    )
  ).rows[0].code;

  {
    const row = (
      await db.query<{ warehouse: string; location: string | null }>(
        `SELECT w.code AS warehouse, l.code AS location
           FROM warehouse w
           LEFT JOIN LATERAL (
             SELECT sl.code FROM storage_location sl
              JOIN warehouse_zone z ON z.id = sl.zone_id
              WHERE z.warehouse_id = w.id AND sl.is_active ORDER BY sl.code LIMIT 1
           ) l ON true
          WHERE w.company_id = ${plantId} AND w.is_active ORDER BY w.code LIMIT 1`,
      )
    ).rows[0];
    warehouseCode = row.warehouse;
    locationCode = row.location;
  }

  defectReason = (
    await db.query<{ uid: string }>(
      `SELECT uid::text FROM stock_reason
        WHERE company_id = ${plantId} AND kind = 'defect' AND is_active LIMIT 1`,
    )
  ).rows[0].uid;
}, 120_000);

afterAll(async () => {
  if (db) {
    const uids = trash.length ? trash : ['00000000-0000-0000-0000-000000000000'];
    // Выпущенное снимаем со склада списанием: приход был настоящий.
    const left = await db.query<{ code: string; qty: string; batch: string | null }>(
      `SELECT i.code, sum(m.qty)::text AS qty, b.number AS batch
         FROM stock_move m
         JOIN production_output po ON po.id = m.source_doc_id
         JOIN production_order o ON o.id = po.production_order_id
         JOIN item i ON i.id = m.item_id
         LEFT JOIN batch b ON b.id = m.batch_id
        WHERE m.source_doc_type = 'production_output' AND o.uid = ANY($1::uuid[])
        GROUP BY i.code, b.number`,
      [uids],
    );
    const writeOff = (
      await db.query<{ uid: string }>(
        `SELECT uid::text FROM stock_reason
          WHERE company_id = ${plantId} AND kind = 'write_off' AND is_active LIMIT 1`,
      )
    ).rows[0]?.uid;
    for (const row of left.rows) {
      await post(admin.token, '/api/v1/warehouse/moves', {
        operationType: 'write_off',
        itemCode: row.code,
        qty: row.qty,
        fromWarehouseCode: warehouseCode,
        ...(locationCode ? { fromLocationCode: locationCode } : {}),
        ...(row.batch ? { batchNumber: row.batch } : {}),
        ...(writeOff ? { reasonId: writeOff } : {}),
        comment: 'уборка прогона себестоимости',
      });
    }

    /**
     * Остаток восстанавливаем приходом на тот же склад, ячейку и партию, по
     * той же цене. Возвратом по заказу нельзя: выпущенный заказ материал со
     * складом больше не двигает — и правильно делает.
     */
    for (const uid of trash) {
      const spent = await db.query<{
        code: string;
        qty: string;
        cost: string;
        warehouse: string;
        location: string | null;
        batch: string | null;
      }>(
        `SELECT i.code, (pm.qty_issued - pm.qty_returned)::text AS qty,
                round(mv.cost_total / mv.qty, 4)::text AS cost,
                w.code AS warehouse, l.code AS location, b.number AS batch
           FROM production_material pm
           JOIN item i ON i.id = pm.item_id
           JOIN production_order o ON o.id = pm.production_order_id
           JOIN LATERAL (
             SELECT m.cost_total, m.qty, m.from_warehouse_id, m.from_location_id, m.batch_id
               FROM stock_move m
              WHERE m.source_doc_type = 'production_material' AND m.source_doc_id = pm.id
                AND m.operation_type = 'issue_to_production' ORDER BY m.id DESC LIMIT 1
           ) mv ON true
           JOIN warehouse w ON w.id = mv.from_warehouse_id
           LEFT JOIN storage_location l ON l.id = mv.from_location_id
           LEFT JOIN batch b ON b.id = mv.batch_id
          WHERE o.uid = $1::uuid AND pm.qty_issued - pm.qty_returned > 0`,
        [uid],
      );
      for (const row of spent.rows) {
        const res = await api('/api/v1/warehouse/moves', {
          method: 'POST',
          headers: {
            ...json(admin.token),
            // админ заведён в несколько компаний, склад просит выбрать явно
            'X-Company-Id': plantUid,
          },
          body: JSON.stringify({
            operationType: 'receipt',
            itemCode: row.code,
            qty: row.qty,
            toWarehouseCode: row.warehouse,
            ...(row.location ? { toLocationCode: row.location } : {}),
            ...(row.batch ? { batchNumber: row.batch } : {}),
            unitCost: row.cost,
            comment: 'уборка прогона себестоимости',
          }),
        });
        if (res.status >= 300) {
          console.error(`материал ${row.code} не вернулся: ${JSON.stringify(res.body)}`);
        }
      }
    }

    if (trash.length > 0) {
      /**
       * Партию держит журнал движений, удалить её нельзя, а номер заказа
       * после удаления достанется следующему прогону. Уводим номер в сторону
       * — и у переделок тоже: их заказы мы тоже удаляем.
       */
      await db.query(
        `UPDATE batch SET production_order_id = NULL, number = number || '-прогон' || id
          WHERE production_order_id IN
           (SELECT id FROM production_order
             WHERE uid = ANY($1::uuid[])
                OR parent_order_id IN (SELECT id FROM production_order WHERE uid = ANY($1::uuid[])))`,
        [trash],
      );
      for (const table of [
        'production_order_cost',
        'production_output',
        'deviation_log',
        'production_material',
      ]) {
        await db.query(
          `DELETE FROM ${table} WHERE production_order_id IN
             (SELECT id FROM production_order WHERE uid = ANY($1::uuid[]))`,
          [trash],
        );
      }
      await db.query(
        `DELETE FROM production_stage_event WHERE stage_id IN
           (SELECT s.id FROM production_stage s JOIN production_order o ON o.id = s.production_order_id
             WHERE o.uid = ANY($1::uuid[]))`,
        [trash],
      );
      await db.query(
        `DELETE FROM production_stage WHERE production_order_id IN
           (SELECT id FROM production_order WHERE uid = ANY($1::uuid[]))`,
        [trash],
      );
      await db.query(
        `DELETE FROM production_order_cost WHERE production_order_id IN
           (SELECT id FROM production_order WHERE parent_order_id IN
             (SELECT id FROM production_order WHERE uid = ANY($1::uuid[])))`,
        [trash],
      );
      await db.query(
        `DELETE FROM production_order WHERE parent_order_id IN
           (SELECT id FROM production_order WHERE uid = ANY($1::uuid[]))`,
        [trash],
      );
      await db.query(`DELETE FROM production_order WHERE uid = ANY($1::uuid[])`, [trash]);
    }
  }
  await db?.end();
  await app?.close();
});

describe('расчёт себестоимости', () => {
  it('материал входит по факту расхода и по цене, по которой ушёл со склада', async () => {
    const uid = await running('10');
    const item = await richMaterial(uid, 3);
    const unitCost = await spend(uid, item, '3');
    await finish(uid, '10');
    expect((await setStatus(uid, 'produced')).status).toBe(201);

    const res = await post(master.token, `/api/v1/production/orders/${uid}/cost`);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const cost = res.body.data;

    expect(Number(cost.materialCost), 'расход 3 по цене выдачи').toBeCloseTo(3 * unitCost, 2);
    expect(Number(cost.totalCost)).toBeCloseTo(3 * unitCost, 2);
    const line = cost.lines.find((l: any) => l.itemCode === item);
    expect(line, 'строка материала в расчёте').toBeDefined();
    expect(Number(line.qty)).toBeCloseTo(3, 5);
    expect(Number(line.unitCost)).toBeCloseTo(unitCost, 2);
  });

  it('план не участвует: не израсходованный материал в себестоимость не идёт', async () => {
    const uid = await running('10');
    const item = await richMaterial(uid, 0);
    const planned = await db.query<{ qty: string }>(
      `SELECT pm.qty_planned::text AS qty FROM production_material pm
         JOIN item i ON i.id = pm.item_id
         JOIN production_order o ON o.id = pm.production_order_id
        WHERE o.uid = $1::uuid AND i.code = $2`,
      [uid, item],
    );
    expect(Number(planned.rows[0].qty), 'в карте этот материал запланирован').toBeGreaterThan(0);

    await finish(uid, '10');
    await setStatus(uid, 'produced');
    const cost = (await post(master.token, `/api/v1/production/orders/${uid}/cost`)).body.data;
    expect(Number(cost.materialCost), 'ничего не расходовали — и платить не за что').toBeCloseTo(0, 4);
    expect(cost.lines.length).toBe(0);
  });

  it('себестоимость единицы делится на годное: брак её удорожает', async () => {
    const uid = await running('10');
    const item = await richMaterial(uid, 4);
    const unitCost = await spend(uid, item, '4');
    await post(master.token, `/api/v1/production/orders/${uid}/output`, {
      kind: 'defect',
      qty: '2',
      reasonUid: defectReason,
    });
    await finish(uid, '8');
    await setStatus(uid, 'produced');

    const cost = (await post(master.token, `/api/v1/production/orders/${uid}/cost`)).body.data;
    expect(Number(cost.qtyGood)).toBeCloseTo(8, 5);
    expect(Number(cost.unitCost), 'итог делится на годное, а не на весь выпуск').toBeCloseTo(
      (4 * unitCost) / 8,
      2,
    );
  });

  it('переделка добавляется к заказу отдельной строкой', async () => {
    const parent = await running('10');
    const item = await richMaterial(parent, 3);
    const unitCost = await spend(parent, item, '2');
    await post(master.token, `/api/v1/production/orders/${parent}/output`, {
      kind: 'defect',
      qty: '3',
      reasonUid: defectReason,
    });
    await finish(parent, '7');
    await setStatus(parent, 'produced');

    const child = (
      await post(master.token, `/api/v1/production/orders/${parent}/rework`, {
        qty: '3',
        dueDate: day(10),
      })
    ).body.data;
    await post(master.token, `/api/v1/production/orders/${child.uid}/materials/from-card`);
    await post(master.token, `/api/v1/production/orders/${child.uid}/stages/from-card`);
    await setStatus(child.uid, 'planned');
    await setStatus(child.uid, 'in_progress');
    const childCost = await spend(child.uid, item, '1');
    await finish(child.uid, '3');
    await setStatus(child.uid, 'produced');

    const cost = (await post(master.token, `/api/v1/production/orders/${parent}/cost`)).body.data;
    expect(Number(cost.materialCost), 'свой расход родителя').toBeCloseTo(2 * unitCost, 2);
    expect(Number(cost.reworkCost), 'затраты переделки отдельной строкой').toBeCloseTo(
      1 * childCost,
      2,
    );
    expect(Number(cost.totalCost)).toBeCloseTo(2 * unitCost + 1 * childCost, 2);

    // Переделку могли посчитать и сами — тогда родитель берёт её готовый
    // снимок, а не считает заново: иначе итог зависел бы от того, нажал ли
    // кто-то кнопку на дочернем заказе.
    const own = (await post(master.token, `/api/v1/production/orders/${child.uid}/cost`)).body.data;
    const again = (await post(master.token, `/api/v1/production/orders/${parent}/cost`)).body.data;
    expect(Number(again.reworkCost), 'готовый расчёт переделки берут как есть').toBeCloseTo(
      Number(own.totalCost),
      2,
    );
  });

  it('прямые затраты цеха считаются по ставке участка', async () => {
    const uid = await running('10');

    // Ставку заводим прогоном: у заказчика их ещё не спрашивали, и в посеве
    // стоит ноль. Без ставки проверять нечего — расчёт честно даст ноль.
    const center = await db.query<{ id: string }>(
      `SELECT w.id::text FROM work_center w
         JOIN production_stage s ON s.work_center_id = w.id
         JOIN production_order o ON o.id = s.production_order_id
        WHERE o.uid = $1::uuid LIMIT 1`,
      [uid],
    );
    expect(center.rows[0], 'у этапов есть участок').toBeDefined();
    await db.query(`UPDATE work_center SET cost_per_hour = 120000 WHERE id = $1`, [
      center.rows[0].id,
    ]);
    await finish(uid, '10', 60);
    await setStatus(uid, 'produced');

    try {
      const cost = (await post(master.token, `/api/v1/production/orders/${uid}/cost`)).body.data;
      const stages = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM production_stage
          WHERE production_order_id = (SELECT id FROM production_order WHERE uid = $1::uuid)
            AND work_center_id = $2`,
        [uid, center.rows[0].id],
      );
      expect(Number(cost.directCost), 'час работы участка по его ставке').toBeCloseTo(
        120000 * Number(stages.rows[0].n),
        2,
      );
    } finally {
      await db.query(`UPDATE work_center SET cost_per_hour = 0 WHERE id = $1`, [center.rows[0].id]);
    }
  });
});

describe('снимок и история', () => {
  it('пересчёт пишет новую строку, прежняя остаётся в истории', async () => {
    const uid = await running('10');
    const item = await richMaterial(uid, 3);
    const unitCost = await spend(uid, item, '2');
    await finish(uid, '10');
    await setStatus(uid, 'produced');

    const first = (await post(master.token, `/api/v1/production/orders/${uid}/cost`)).body.data;
    expect(Number(first.totalCost)).toBeCloseTo(2 * unitCost, 2);

    // Расход уточнили задним числом. Через маршрут это уже нельзя — заказ
    // выпущен, — но проверяем мы не маршрут, а то, что новый расчёт видит
    // новые числа и не затирает прошлый.
    await db.query(
      `UPDATE production_material pm SET qty_used = qty_used + 1
         FROM production_order o, item i
        WHERE o.id = pm.production_order_id AND i.id = pm.item_id
          AND o.uid = $1::uuid AND i.code = $2`,
      [uid, item],
    );
    const second = (await post(master.token, `/api/v1/production/orders/${uid}/cost`)).body.data;
    expect(Number(second.totalCost), 'новый расход виден в новом расчёте').toBeCloseTo(
      3 * unitCost,
      2,
    );

    const list = await costOf(uid);
    expect(list.history.length, 'прошлый расчёт никуда не делся').toBe(2);
    expect(list.history[0].isCurrent).toBe(true);
    expect(list.history[1].isCurrent).toBe(false);
    expect(Number(list.history[1].totalCost)).toBeCloseTo(2 * unitCost, 2);
    expect(Number(list.current.totalCost)).toBeCloseTo(3 * unitCost, 2);
  });

  it('закрытие заказа считает себестоимость само', async () => {
    const uid = await running('10');
    const item = await richMaterial(uid, 2);
    const unitCost = await spend(uid, item, '2');
    await finish(uid, '10');
    await setStatus(uid, 'produced');

    expect((await costOf(uid)).current, 'до закрытия расчёта ещё нет').toBeNull();
    expect((await setStatus(uid, 'closed')).status).toBe(201);

    const list = await costOf(uid);
    expect(list.current, 'закрытие посчитало').not.toBeNull();
    expect(Number(list.current.totalCost)).toBeCloseTo(2 * unitCost, 2);
  });

  it('заказ в работе не считают: расход ещё не записан', async () => {
    const uid = await running('10');
    const res = await post(master.token, `/api/v1/production/orders/${uid}/cost`);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/ещё в работе/i);
  });
});

describe('что расчёт говорит вслух', () => {
  it('материал на руках у цеха — предупреждение, а не молчание', async () => {
    const uid = await running('10');
    const item = await richMaterial(uid, 5);
    const stock = await get(
      admin.token,
      `/api/v1/production/orders/${uid}/materials/stock?itemCode=${encodeURIComponent(item)}`,
    );
    const place = stock.body.data.rows[0];
    await post(admin.token, `/api/v1/production/orders/${uid}/materials/issue`, {
      itemCode: item,
      qty: '5',
      warehouseCode: place.warehouseCode,
      ...(place.locationCode ? { locationCode: place.locationCode } : {}),
      ...(place.batchNumber ? { batchNumber: place.batchNumber } : {}),
    });
    await post(master.token, `/api/v1/production/orders/${uid}/materials/use`, {
      itemCode: item,
      qty: '2',
    });
    await finish(uid, '10');
    await setStatus(uid, 'produced');

    const cost = (await post(master.token, `/api/v1/production/orders/${uid}/cost`)).body.data;
    expect(cost.warnings.join(' ')).toMatch(/на руках у цеха/i);
  });

  it('без годного выпуска расчёт говорит, что единицу считать не из чего', async () => {
    const uid = await running('10');
    const stages = await db.query<{ seq: number }>(
      `SELECT s.seq FROM production_stage s JOIN production_order o ON o.id = s.production_order_id
        WHERE o.uid = $1::uuid ORDER BY s.seq`,
      [uid],
    );
    for (const s of stages.rows) {
      await post(master.token, `/api/v1/production/orders/${uid}/stages/${s.seq}/mark`, { kind: 'start' });
      await post(master.token, `/api/v1/production/orders/${uid}/stages/${s.seq}/mark`, { kind: 'finish' });
    }
    // Работа сделана, а сдавать нечего. Через маршрут такой заказ не
    // выпустить — и правильно; здесь проверяется, что скажет расчёт.
    await db.query(`UPDATE production_order SET status = 'produced' WHERE uid = $1::uuid`, [uid]);

    const cost = (await post(master.token, `/api/v1/production/orders/${uid}/cost`)).body.data;
    expect(Number(cost.unitCost)).toBeCloseTo(0, 4);
    expect(cost.warnings.join(' ')).toMatch(/годного выпуска/i);
  });
});

describe('себестоимость на складе', () => {
  it('партия выпуска получает цену, и на складе она перестаёт стоить ноль', async () => {
    const uid = await running('10');
    const item = await richMaterial(uid, 5);
    const unitCost = await spend(uid, item, '5');
    await finish(uid, '10');
    await setStatus(uid, 'produced');

    const before = await db.query<{ unit_cost: string }>(
      `SELECT sb.unit_cost::text FROM stock_balance sb
         JOIN batch b ON b.id = sb.batch_id
         JOIN production_order o ON o.id = b.production_order_id
        WHERE o.uid = $1::uuid`,
      [uid],
    );
    expect(Number(before.rows[0].unit_cost), 'до расчёта цены у выпуска нет').toBeCloseTo(0, 4);

    const cost = (await post(master.token, `/api/v1/production/orders/${uid}/cost`)).body.data;
    expect(Number(cost.unitCost)).toBeCloseTo((5 * unitCost) / 10, 2);

    const after = await db.query<{ unit_cost: string; batch_cost: string }>(
      `SELECT sb.unit_cost::text, b.unit_cost::text AS batch_cost FROM stock_balance sb
         JOIN batch b ON b.id = sb.batch_id
         JOIN production_order o ON o.id = b.production_order_id
        WHERE o.uid = $1::uuid`,
      [uid],
    );
    expect(Number(after.rows[0].unit_cost), 'остаток переоценён').toBeCloseTo(
      Number(cost.unitCost),
      2,
    );
    expect(Number(after.rows[0].batch_cost), 'и сама партия тоже').toBeCloseTo(
      Number(cost.unitCost),
      2,
    );
  });
});

describe('права и журнал', () => {
  it('кладовщик расчёт видит, но не запускает', async () => {
    const uid = await running('10');
    await finish(uid, '10');
    await setStatus(uid, 'produced');

    expect((await get(keeper.token, `/api/v1/production/orders/${uid}/cost`)).status).toBe(200);
    expect((await post(keeper.token, `/api/v1/production/orders/${uid}/cost`)).status).toBe(403);
  });

  it('без production.manage служба не считает, даже если маршрут обошли', async () => {
    const uid = await running('10');
    await finish(uid, '10');
    await setStatus(uid, 'produced');

    await expect(
      runWithContext(
        {
          userId: masterId,
          companyIds: [plantId],
          permissions: new Set(['production.view']),
          requestId: 'test',
        } as any,
        () => costs.calculate(uid),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('расчёт попадает в журнал с итогом и себестоимостью единицы', async () => {
    const uid = await running('10');
    const item = await richMaterial(uid, 2);
    await spend(uid, item, '2');
    await finish(uid, '10');
    await setStatus(uid, 'produced');
    await post(master.token, `/api/v1/production/orders/${uid}/cost`);

    const rows = await db.query<{ action: string; changes: any }>(
      `SELECT action, changes FROM audit_log
        WHERE entity_type = 'production_order' AND entity_id = $1 AND action = 'cost.calculate'`,
      [uid],
    );
    expect(rows.rows.length).toBe(1);
    expect(Number(rows.rows[0].changes.totalCost.to)).toBeGreaterThan(0);
    expect(Number(rows.rows[0].changes.unitCost.to)).toBeGreaterThan(0);
  });
});
