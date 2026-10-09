/**
 * Выпуск заказа: годное, брак, отход, полуфабрикат и переделка. Живая база,
 * приложение целиком.
 *
 * Главное, что здесь проверяется: годное попадает на склад тем же действием и
 * той же службой, что любой приход, партия выпуска принадлежит заказу, а брак
 * и отход на склад не попадают вовсе — у них другая судьба. Плюс переделка:
 * она дочерний заказ, и переделать можно только то, что записано браком.
 *
 * Прибираемся за собой: выпущенное списываем со склада обратно, заказы прогона
 * удаляем. Журнал движений при этом дополняется — он append-only, и это
 * правильно: приход был.
 */
import 'dotenv/config';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ForbiddenException, UnprocessableEntityException, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { AuthGuard } from '../src/auth/auth.guard.js';
import { ProductionModule } from '../src/production/production.module.js';
import { WarehouseModule } from '../src/warehouse/warehouse.module.js';
import { ProductionOutputsService } from '../src/production/outputs.service.js';
import { WriteService as WarehouseWriteService } from '../src/warehouse/write.service.js';
import { ContextMiddleware } from '../src/common/context.middleware.js';
import { EnvelopeInterceptor } from '../src/common/envelope.interceptor.js';
import { ErrorFilter } from '../src/common/error.filter.js';
import { runWithContext } from '../src/common/request-context.js';

let app: INestApplication;
let base: string;
let db: Client;
let outputs: ProductionOutputsService;
let warehouse: WarehouseWriteService;

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
const get = (token: string, path: string) => api(path, { headers: auth(token) });

let master: Awaited<ReturnType<typeof login>>;
let keeper: Awaited<ReturnType<typeof login>>;
let admin: Awaited<ReturnType<typeof login>>;

let plantId: bigint;
let masterId: bigint;
/** Продукция завода с действующей картой: по ней идут заказы прогона. */
let madeItem: string;
/** Куда принимают выпуск: склад и ячейка, если склад с ячейками. */
let warehouseCode: string;
let locationCode: string | null;
/** Полуфабрикат: своя номенклатура, не та, что в заказе. */
let semiItem: string;
let defectReason: string;
let wasteReason: string;
/** Причина простоя: она не годится ни браку, ни отходу. */
let downtimeReason: string;
/** Причина брака торгового дома: своей компании у заказа завода она не своя. */
let foreignDefectReason: string;

const trash: string[] = [];

const day = (shift: number) => new Date(Date.now() + shift * 86_400_000).toISOString().slice(0, 10);

const setStatus = (uid: string, status: string, comment?: string) =>
  post(master.token, `/api/v1/production/orders/${uid}/status`, {
    status,
    ...(comment ? { comment } : {}),
  });

async function makeOrder(qty = '10', itemCode = madeItem) {
  const res = await post(master.token, '/api/v1/production/orders', {
    itemCode,
    qtyPlanned: qty,
    dueDate: day(7),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  trash.push(res.body.data.uid);
  return res.body.data.uid as string;
}

/** Заказ, доведённый до работы: по нему уже можно сдавать выпуск. */
async function running(qty = '10') {
  const uid = await makeOrder(qty);
  await post(master.token, `/api/v1/production/orders/${uid}/stages/from-card`);
  await setStatus(uid, 'planned');
  expect((await setStatus(uid, 'in_progress')).status).toBe(201);
  return uid;
}

const output = (token: string, uid: string, body: Record<string, unknown>) =>
  post(token, `/api/v1/production/orders/${uid}/output`, body);

const where = () => ({ warehouseCode, ...(locationCode ? { locationCode } : {}) });

const good = (uid: string, qty: string, extra: Record<string, unknown> = {}) =>
  output(master.token, uid, { kind: 'good', qty, ...where(), ...extra });

const card = async (uid: string) => (await get(master.token, `/api/v1/production/orders/${uid}`)).body.data;

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
    await db.query<{ operation_type: string; qty: string; batch: string | null }>(
      `SELECT m.operation_type::text, m.qty::text, b.number AS batch
         FROM stock_move m
         JOIN production_output po ON po.id = m.source_doc_id
         JOIN production_order o ON o.id = po.production_order_id
         LEFT JOIN batch b ON b.id = m.batch_id
        WHERE m.source_doc_type = 'production_output' AND o.uid = $1::uuid
        ORDER BY m.id`,
      [uid],
    )
  ).rows;

const deviations = async (uid: string, kind: string) =>
  (
    await db.query<{ amount: string; comment: string | null; reason: string | null }>(
      `SELECT d.amount::text, d.comment, r.name_ru AS reason FROM deviation_log d
         LEFT JOIN stock_reason r ON r.id = d.reason_id
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
    imports: [PrismaModule, AuthModule, ProductionModule, WarehouseModule],
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
  outputs = app.get(ProductionOutputsService);
  warehouse = app.get(WarehouseWriteService);

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

  // Продукция с действующей картой и партийным учётом: партия выпуска —
  // половина проверки, и без `track_batches` её не будет.
  madeItem = (
    await db.query<{ code: string }>(
      `SELECT i.code FROM item i
         JOIN tech_card tc ON tc.item_id = i.id AND tc.status = 'active'
        WHERE i.company_id = ${plantId} AND i.track_batches AND NOT i.track_serials
        ORDER BY i.code LIMIT 1`,
    )
  ).rows[0].code;

  semiItem = (
    await db.query<{ code: string }>(
      `SELECT i.code FROM item i
        WHERE i.company_id = ${plantId} AND i.is_active AND NOT i.track_serials
          AND i.code <> $1
        ORDER BY i.track_batches, i.code LIMIT 1`,
      [madeItem],
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

  const reason = async (kind: string) =>
    (
      await db.query<{ uid: string }>(
        `SELECT uid::text FROM stock_reason
          WHERE company_id = ${plantId} AND kind = $1::"ReasonKind" AND is_active
          ORDER BY name_ru LIMIT 1`,
        [kind],
      )
    ).rows[0].uid;
  defectReason = await reason('defect');
  foreignDefectReason = (
    await db.query<{ uid: string }>(
      `SELECT r.uid::text FROM stock_reason r JOIN company c ON c.id = r.company_id
        WHERE c.code = 'trade' AND r.kind = 'defect' AND r.is_active ORDER BY r.name_ru LIMIT 1`,
    )
  ).rows[0].uid;
  wasteReason = await reason('waste');
  downtimeReason = await reason('downtime');
}, 90_000);

afterAll(async () => {
  if (db) {
    /**
     * Выпущенное снимаем со склада списанием: приход был настоящий, и стереть
     * его нельзя — журнал движений дополняется, а не правится. Списание
     * возвращает остаток демо-данных к прежнему.
     */
    const left = await db.query<{ code: string; qty: string; batch: string | null }>(
      `SELECT i.code, sum(m.qty)::text AS qty, b.number AS batch
         FROM stock_move m
         JOIN production_output po ON po.id = m.source_doc_id
         JOIN production_order o ON o.id = po.production_order_id
         JOIN item i ON i.id = m.item_id
         LEFT JOIN batch b ON b.id = m.batch_id
        WHERE m.source_doc_type = 'production_output' AND o.uid = ANY($1::uuid[])
        GROUP BY i.code, b.number`,
      [trash.length ? trash : ['00000000-0000-0000-0000-000000000000']],
    );
    const writeOff = (
      await db.query<{ uid: string }>(
        `SELECT uid::text FROM stock_reason
          WHERE company_id = ${plantId} AND kind = 'write_off' AND is_active LIMIT 1`,
      )
    ).rows[0]?.uid;
    for (const row of left.rows) {
      const res = await post(admin.token, '/api/v1/warehouse/moves', {
        operationType: 'write_off',
        itemCode: row.code,
        qty: row.qty,
        fromWarehouseCode: warehouseCode,
        ...(locationCode ? { fromLocationCode: locationCode } : {}),
        ...(row.batch ? { batchNumber: row.batch } : {}),
        ...(writeOff ? { reasonId: writeOff } : {}),
        comment: 'уборка прогона выпуска',
      });
      if (res.status >= 300) {
        console.error(`выпуск ${row.code} не списался: ${JSON.stringify(res.body)}`);
      }
    }

    if (trash.length > 0) {
      /**
       * Партию держит журнал движений, удалить её нельзя. Но номер заказа
       * после удаления освободится и достанется следующему прогону, а чужую
       * партию выпуск не пополняет — поэтому номер уводим в сторону вместе со
       * ссылкой на заказ.
       */
      await db.query(
        `UPDATE batch SET production_order_id = NULL, number = number || '-прогон' || id
          WHERE production_order_id IN
           (SELECT id FROM production_order
             WHERE uid = ANY($1::uuid[])
                OR parent_order_id IN (SELECT id FROM production_order WHERE uid = ANY($1::uuid[])))`,
        [trash],
      );
      await db.query(
        `DELETE FROM production_output WHERE production_order_id IN
           (SELECT id FROM production_order WHERE uid = ANY($1::uuid[]))`,
        [trash],
      );
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
      // Сначала переделки: они ссылаются на родителя.
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

describe('выпуск годного', () => {
  it('годное попадает на склад тем же действием и ложится в партию заказа', async () => {
    const uid = await running('10');
    const before = await stockOf(madeItem);

    const res = await good(uid, '4');
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    expect(await stockOf(madeItem), 'остаток вырос ровно на выпущенное').toBeCloseTo(before + 4, 5);

    const moves = await movesOf(uid);
    expect(moves.length).toBe(1);
    expect(moves[0].operation_type, 'приход цеха — это движение типа output').toBe('output');
    expect(Number(moves[0].qty)).toBeCloseTo(4, 5);

    const number = (await card(uid)).number;
    expect(moves[0].batch, 'партия выпуска названа номером заказа').toBe(number);

    const owner = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM batch b
         JOIN production_order o ON o.id = b.production_order_id
        WHERE o.uid = $1::uuid AND b.number = $2`,
      [uid, number],
    );
    expect(Number(owner.rows[0].n), 'партия принадлежит своему заказу').toBe(1);
  });

  it('второй выпуск ложится в ту же партию, а счётчик заказа складывается', async () => {
    const uid = await running('10');
    await good(uid, '3');
    await good(uid, '2');

    const moves = await movesOf(uid);
    expect(moves.length).toBe(2);
    expect(new Set(moves.map((m) => m.batch)).size, 'партия у заказа одна').toBe(1);

    const one = await card(uid);
    expect(Number(one.qtyProduced)).toBeCloseTo(5, 5);
    expect(one.outputs.length).toBe(2);
    expect(one.outputs[0].kind).toBe('good');
  });

  it('в чужую партию выпуск не дописывают', async () => {
    const first = await running('10');
    await good(first, '1');
    const number = (await card(first)).number;

    const second = await running('10');
    const res = await good(second, '1', { batchNumber: number });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/не принадлежит/i);
  });

  it('по заказу, который ещё не в работе, выпуск не записывают', async () => {
    const uid = await makeOrder('5');
    const res = await good(uid, '1');
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/не в работе/i);
  });

  it('выпуск, который больше двух планов, отбивается с числами', async () => {
    const uid = await running('10');
    const res = await good(uid, '21');
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/двух планов/i);
    expect(res.body.error.message).toMatch(/10/);
  });

  it('склад для годного обязателен: продукция без склада нигде не лежит', async () => {
    const uid = await running('10');
    const res = await output(master.token, uid, { kind: 'good', qty: '1' });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/Склад/i);
  });
});

describe('брак и отход', () => {
  it('брак без причины не записывают', async () => {
    const uid = await running('10');
    const res = await output(master.token, uid, { kind: 'defect', qty: '1' });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/причин/i);
  });

  it('брак с причиной: счётчик, строка журнала отклонений и ничего на складе', async () => {
    const uid = await running('10');
    const before = await stockOf(madeItem);

    const res = await output(master.token, uid, {
      kind: 'defect',
      qty: '2',
      reasonUid: defectReason,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    expect(await stockOf(madeItem), 'брак на склад не приходуется').toBeCloseTo(before, 5);
    expect((await movesOf(uid)).length, 'движения по браку нет').toBe(0);

    const one = await card(uid);
    expect(Number(one.qtyDefect)).toBeCloseTo(2, 5);

    const rows = await deviations(uid, 'defect');
    expect(rows.length, 'брак сам стал строкой журнала отклонений').toBe(1);
    expect(Number(rows[0].amount)).toBeCloseTo(2, 4);
    expect(rows[0].reason, 'причина брака в отклонении — та же').toBeTruthy();
  });

  it('причина брака чужой компании не годится', async () => {
    // Справочник причин — на компанию: причина торгового дома в заказе завода
    // это чужая строка, даже если называется так же.
    const uid = await running('10');
    const res = await output(master.token, uid, {
      kind: 'defect',
      qty: '1',
      reasonUid: foreignDefectReason,
    });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/вашей компании/i);
  });

  it('причина простоя браку не годится: это разные справочники', async () => {
    const uid = await running('10');
    const res = await output(master.token, uid, {
      kind: 'defect',
      qty: '1',
      reasonUid: downtimeReason,
    });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/причин/i);
  });

  it('отход требует свою причину, а причина брака ему не подходит', async () => {
    const uid = await running('10');
    const wrong = await output(master.token, uid, {
      kind: 'waste',
      qty: '1',
      reasonUid: defectReason,
    });
    expect(wrong.status, 'обрезь — не брак').toBe(422);

    const before = await stockOf(madeItem);
    const res = await output(master.token, uid, {
      kind: 'waste',
      qty: '1.5',
      reasonUid: wasteReason,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await stockOf(madeItem), 'отход на склад не кладут').toBeCloseTo(before, 5);
    expect(Number((await card(uid)).qtyWaste)).toBeCloseTo(1.5, 5);
    expect((await deviations(uid, 'defect')).length, 'отход — не брак и в отклонения не идёт').toBe(0);
  });

  it('у годного причины не спрашивают, и лишнюю не принимают', async () => {
    const uid = await running('10');
    const res = await good(uid, '1', { reasonUid: defectReason });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/причин/i);
  });
});

describe('полуфабрикат', () => {
  it('ложится на склад своей номенклатурой и в выпуск заказа не идёт', async () => {
    const uid = await running('10');
    const before = await stockOf(semiItem);

    const res = await output(master.token, uid, {
      kind: 'semi',
      qty: '2',
      itemCode: semiItem,
      ...where(),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    expect(await stockOf(semiItem)).toBeCloseTo(before + 2, 5);
    const one = await card(uid);
    expect(Number(one.qtyProduced), 'полуфабрикат — не выпуск заказа').toBeCloseTo(0, 5);
    expect(one.outputs.some((v: any) => v.kind === 'semi' && v.itemCode === semiItem)).toBe(true);
  });
});

describe('переделка', () => {
  it('без записанного брака переделывать нечего', async () => {
    const uid = await running('10');
    const res = await post(master.token, `/api/v1/production/orders/${uid}/rework`, {
      qty: '1',
      dueDate: day(10),
    });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/брака не записано/i);
  });

  it('переделка — дочерний заказ с той же нормой и своим номером', async () => {
    const uid = await running('10');
    await output(master.token, uid, { kind: 'defect', qty: '3', reasonUid: defectReason });

    const res = await post(master.token, `/api/v1/production/orders/${uid}/rework`, {
      qty: '3',
      dueDate: day(10),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const child = res.body.data;
    expect(child.number).not.toBe((await card(uid)).number);

    const row = await db.query<{
      status: string;
      qty: string;
      parent: string;
      version: number | null;
    }>(
      `SELECT c.status::text, c.qty_planned::text AS qty, p.uid::text AS parent,
              c.tech_card_version AS version
         FROM production_order c JOIN production_order p ON p.id = c.parent_order_id
        WHERE c.uid = $1::uuid`,
      [child.uid],
    );
    expect(row.rows[0].parent, 'переделка помнит родителя').toBe(uid);
    expect(row.rows[0].status, 'переделка рождается черновиком').toBe('draft');
    expect(Number(row.rows[0].qty)).toBeCloseTo(3, 5);
    expect(row.rows[0].version, 'переделку считают по норме родителя').toBe(
      (await card(uid)).techCardVersion,
    );

    const parent = await card(uid);
    expect(parent.reworks.length, 'переделка видна из родителя').toBe(1);
    expect(parent.reworks[0].number).toBe(child.number);
  });

  it('переделать больше, чем записано браком, нельзя', async () => {
    const uid = await running('10');
    await output(master.token, uid, { kind: 'defect', qty: '2', reasonUid: defectReason });
    expect(
      (await post(master.token, `/api/v1/production/orders/${uid}/rework`, {
        qty: '1.5',
        dueDate: day(10),
      })).status,
    ).toBe(201);

    const res = await post(master.token, `/api/v1/production/orders/${uid}/rework`, {
      qty: '1',
      dueDate: day(10),
    });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/осталось 0\.5/i);
  });
});

describe('выпуск и статус заказа', () => {
  it('заказ без единой штуки годного не выпускают', async () => {
    // Работа при этом сделана: этапы закрыты, и спрашивать про них нечего.
    // Остаётся единственный вопрос — что цех сдал.
    const uid = await running('10');
    await output(master.token, uid, { kind: 'defect', qty: '1', reasonUid: defectReason });
    await db.query(
      `UPDATE production_stage SET status = 'done'
        WHERE production_order_id = (SELECT id FROM production_order WHERE uid = $1::uuid)`,
      [uid],
    );

    const res = await setStatus(uid, 'produced');
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/годного/i);
  });

  it('с годным и закрытыми этапами заказ выпускается', async () => {
    const uid = await running('10');
    await good(uid, '10');

    const stages = await db.query<{ seq: number }>(
      `SELECT s.seq FROM production_stage s JOIN production_order o ON o.id = s.production_order_id
        WHERE o.uid = $1::uuid ORDER BY s.seq`,
      [uid],
    );
    for (const s of stages.rows) {
      await post(master.token, `/api/v1/production/orders/${uid}/stages/${s.seq}/mark`, {
        kind: 'start',
      });
      await post(master.token, `/api/v1/production/orders/${uid}/stages/${s.seq}/mark`, {
        kind: 'finish',
      });
    }

    const res = await setStatus(uid, 'produced');
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });
});

/**
 * Комментарий к записи выпуска (ТЗ 4.6).
 *
 * Комментарий система принимала и раньше, но складывала его в чужие записи:
 * у годного — в комментарий складского прихода, у брака — в журнал отклонений,
 * у отхода — никуда, кроме аудита. В журнале выпуска, то есть там, где цех на
 * него и смотрит, его не было ни у одного вида. «Почему 0,5 т ушло в отход»
 * спрашивают, глядя на строку отхода, а не листая аудит.
 */
describe('комментарий к выпуску', () => {
  it('комментарий к браку виден в строке журнала выпуска', async () => {
    const uid = await running('10');
    const res = await output(master.token, uid, {
      kind: 'defect',
      qty: '1',
      reasonUid: defectReason,
      comment: 'раковина по кромке, вторая за смену',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const rows = (await get(master.token, `/api/v1/production/orders/${uid}/outputs`)).body
      .data as any[];
    const defect = rows.find((r) => r.kind === 'defect');
    expect(defect, 'строки брака в журнале нет').toBeTruthy();
    expect(defect.comment).toBe('раковина по кромке, вторая за смену');
  });

  it('комментарий к отходу не теряется: у него нет ни прихода, ни отклонения', async () => {
    const uid = await running('10');
    expect(
      (
        await output(master.token, uid, {
          kind: 'waste',
          qty: '0.5',
          reasonUid: wasteReason,
          comment: 'обрезь при настройке стана',
        })
      ).status,
    ).toBe(201);

    const rows = (await get(master.token, `/api/v1/production/orders/${uid}/outputs`)).body
      .data as any[];
    const waste = rows.find((r) => r.kind === 'waste');
    expect(waste, 'строки отхода в журнале нет').toBeTruthy();
    expect(waste.comment).toBe('обрезь при настройке стана');
  });

  it('без комментария в строке стоит null, а не выдуманный текст', async () => {
    const uid = await running('10');
    await good(uid, '1');

    const rows = (await get(master.token, `/api/v1/production/orders/${uid}/outputs`)).body
      .data as any[];
    const ok = rows.find((r) => r.kind === 'good');
    expect(ok, 'строки годного в журнале нет').toBeTruthy();
    expect(ok.comment).toBeNull();
  });
});

describe('права и журнал', () => {
  it('кладовщик выпуск видит, но не записывает: это отметка цеха', async () => {
    const uid = await running('10');
    await good(uid, '1');

    expect((await get(keeper.token, `/api/v1/production/orders/${uid}/outputs`)).status).toBe(200);
    const res = await output(keeper.token, uid, { kind: 'good', qty: '1', ...where() });
    expect(res.status).toBe(403);
  });

  it('без production.manage служба выпуск не пишет, даже если маршрут обошли', async () => {
    const uid = await running('10');
    await expect(
      runWithContext(
        {
          userId: masterId,
          companyIds: [plantId],
          permissions: new Set(['production.view']),
          requestId: 'test',
        } as any,
        () => outputs.register(uid, { kind: 'good', qty: '1', ...where() }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('выпуск цеха со складского экрана не заводят', async () => {
    await expect(
      runWithContext(
        {
          userId: masterId,
          companyIds: [plantId],
          permissions: new Set(['warehouse.move', 'warehouse.writeoff']),
          requestId: 'test',
        } as any,
        () =>
          warehouse.create({
            operationType: 'output' as any,
            itemCode: madeItem,
            qty: '1',
            toWarehouseCode: warehouseCode,
          }),
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('журнал называет каждый выпуск своим действием и количеством', async () => {
    const uid = await running('10');
    await good(uid, '2');
    await output(master.token, uid, { kind: 'defect', qty: '1', reasonUid: defectReason });
    await output(master.token, uid, { kind: 'waste', qty: '0.5', reasonUid: wasteReason });
    await post(master.token, `/api/v1/production/orders/${uid}/rework`, {
      qty: '1',
      dueDate: day(10),
    });

    const rows = await audit(uid);
    const actions = rows.map((r) => r.action);
    for (const want of ['output.good', 'output.defect', 'output.waste', 'order.rework']) {
      expect(actions, `в журнале нет ${want}`).toContain(want);
    }
    const goodRow = rows.find((r) => r.action === 'output.good')!;
    expect(goodRow.changes.qty.to).toBe('2.000000');
    expect(goodRow.changes.batch.to).toBeTruthy();
  });
});
