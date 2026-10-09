/**
 * Штучный учёт по серийным номерам (ТЗ 5.6).
 *
 * Сценарий приёмки: труба большого диаметра принимается, лежит и выдаётся по
 * своему номеру, а не тоннами. Здесь проверяется, что номер действительно
 * ведёт себя как отдельная единица: строка остатка своя, движение своё,
 * состояние переписывается вместе с остатком, и второй раз ту же трубу
 * принять нельзя.
 *
 * Прогон пишет в базу: заводит свои номера с префиксом `QA-SER-`, двигает их
 * и отменяет движения. Чужого не трогает — сидовые номера только читает.
 * За собой не убирает: журнал движений append-only, DELETE из него запрещён
 * триггером, а стереть остаток и номер, оставив движения, значит порвать
 * ссылку. Свои следы уносит пересев.
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
import { SalesModule } from '../src/sales/sales.module.js';
import { ContextMiddleware } from '../src/common/context.middleware.js';
import { EnvelopeInterceptor } from '../src/common/envelope.interceptor.js';
import { ErrorFilter } from '../src/common/error.filter.js';

let app: INestApplication;
let base: string;
let db: Client;

const PASSWORD = process.env.SEED_PASSWORD ?? 'metall-dev-2026';
/** Штучная позиция сида: труба, которую принимают по номеру. */
const ITEM = 'PPU-530-710';
/** Склад готовой продукции завода — там эти трубы и лежат. */
const WAREHOUSE = 'ZAVOD-GP';

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
  return res.body.data as { token: string; companies: { uid: string; code: string }[] };
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

let admin: Awaited<ReturnType<typeof login>>;
let plantUid: string;
let cell: string;

const post = (body: unknown) =>
  api('/api/v1/warehouse/moves', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth(admin.token) },
    body: JSON.stringify(body),
  });

/** Номер под каждый тест свой: прогон не должен зависеть от порядка. */
const NEW = (tag: string) => `QA-SER-${tag}-${Date.now()}`;

beforeAll(async () => {
  db = new Client({ connectionString: process.env.DATABASE_URL! });
  await db.connect();

  const moduleRef = await Test.createTestingModule({
    // Продажи здесь ради одной проверки: штучную позицию в заказ не пускают.
    // Отказ живёт в продажах, а проверять его отдельно от склада значит
    // проверять на словах.
    imports: [PrismaModule, AuthModule, WarehouseModule, SalesModule],
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

  admin = await login('admin');
  plantUid = admin.companies.find((c) => c.code === 'plant')!.uid;

  const { rows } = await db.query(`
    SELECT z.code || '/' || l.code AS cell
      FROM storage_location l
      JOIN warehouse_zone z ON z.id = l.zone_id
      JOIN warehouse w ON w.id = z.warehouse_id
     WHERE w.code = $1
     ORDER BY z.code, l.code LIMIT 1`, [WAREHOUSE]);
  cell = rows[0].cell;
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.end();
});

describe('серийный учёт: остаток', () => {
  it('строка остатка заведена на номер и равна единице', async () => {
    const { rows } = await db.query(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE sb.qty_on_hand <> 1)::int AS ne_odna
         FROM stock_balance sb
         JOIN item i ON i.id = sb.item_id
        WHERE i.code = $1 AND sb.serial_id IS NOT NULL AND sb.qty_on_hand > 0`,
      [ITEM],
    );
    expect(rows[0].n, 'строк остатка по номерам').toBeGreaterThan(0);
    expect(rows[0].ne_odna, 'строк остатка, где количество не единица').toBe(0);
  });

  it('список остатков называет номер, и по нему же работает поиск', async () => {
    const list = await api(`/api/v1/warehouse/stock?limit=500`, { headers: auth(admin.token) });
    const row = list.body.data.rows.find((r: any) => r.item.code === ITEM);
    expect(row, `в остатке нет ${ITEM}`).toBeTruthy();
    expect(row.serial, 'строка штучной позиции без номера').toBeTruthy();

    const found = await api(
      `/api/v1/warehouse/stock?search=${encodeURIComponent(row.serial)}&limit=50`,
      { headers: auth(admin.token) },
    );
    expect(found.body.data.rows.length, `поиск по номеру ${row.serial}`).toBeGreaterThan(0);
    expect(found.body.data.rows.every((r: any) => r.serial === row.serial)).toBe(true);
  });
});

describe('серийный учёт: движения', () => {
  it('приход заводит номер, вторая такая же труба отбивается', async () => {
    const number = NEW('dubl');
    const first = await post({
      companyUid: plantUid,
      operationType: 'receipt',
      itemCode: ITEM,
      serialNumber: number,
      qty: '1',
      toWarehouseCode: WAREHOUSE,
      toLocationCode: cell,
      unitCost: '33900000',
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.data.serialNumber).toBe(number);

    const again = await post({
      companyUid: plantUid,
      operationType: 'receipt',
      itemCode: ITEM,
      serialNumber: number,
      qty: '1',
      toWarehouseCode: WAREHOUSE,
      toLocationCode: cell,
      unitCost: '33900000',
    });
    expect(again.status).toBe(422);
    expect(String(again.body.error.message)).toContain('уже на складе');
  });

  it('без номера штучную позицию не принять, а количество больше штуки не пройдёт', async () => {
    const nameless = await post({
      companyUid: plantUid,
      operationType: 'receipt',
      itemCode: ITEM,
      qty: '1',
      toWarehouseCode: WAREHOUSE,
      toLocationCode: cell,
      unitCost: '33900000',
    });
    expect(nameless.status).toBe(422);
    expect(String(nameless.body.error.message)).toContain('нужен серийный номер');

    const many = await post({
      companyUid: plantUid,
      operationType: 'receipt',
      itemCode: ITEM,
      serialNumber: NEW('mnogo'),
      qty: '3',
      toWarehouseCode: WAREHOUSE,
      toLocationCode: cell,
      unitCost: '33900000',
    });
    expect(many.status).toBe(422);
    expect(String(many.body.error.message)).toContain('одна штука');
  });

  it('списание уводит номер со склада и меняет его состояние', async () => {
    const number = NEW('spisat');
    await post({
      companyUid: plantUid,
      operationType: 'receipt',
      itemCode: ITEM,
      serialNumber: number,
      qty: '1',
      toWarehouseCode: WAREHOUSE,
      toLocationCode: cell,
      unitCost: '33900000',
    });

    const reason = await db.query(
      `SELECT r.id::text AS id FROM stock_reason r
         JOIN company c ON c.id = r.company_id
        WHERE c.code = 'plant' AND r.kind::text = 'write_off' ORDER BY r.id LIMIT 1`,
    );
    const off = await post({
      companyUid: plantUid,
      operationType: 'write_off',
      itemCode: ITEM,
      serialNumber: number,
      qty: '1',
      fromWarehouseCode: WAREHOUSE,
      fromLocationCode: cell,
      reasonId: reason.rows[0].id,
    });
    expect(off.status, JSON.stringify(off.body)).toBe(201);

    const { rows } = await db.query(
      `SELECT sn.current_state::text AS state,
              coalesce((SELECT sum(qty_on_hand) FROM stock_balance WHERE serial_id = sn.id), 0)::text AS qty
         FROM serial_number sn WHERE sn.number = $1`,
      [number],
    );
    expect(rows[0].state, 'состояние номера после списания').toBe('written_off');
    expect(Number(rows[0].qty), 'остаток по списанному номеру').toBe(0);
  });

  it('несуществующий номер на расходе не выдумывается', async () => {
    const res = await post({
      companyUid: plantUid,
      operationType: 'write_off',
      itemCode: ITEM,
      serialNumber: NEW('net-takogo'),
      qty: '1',
      fromWarehouseCode: WAREHOUSE,
      fromLocationCode: cell,
    });
    expect(res.status).toBe(422);
    expect(String(res.body.error.message)).toContain('не найден');
  });

  it('сторно выдачи в цех возвращает номер на склад', async () => {
    const number = NEW('storno');
    await post({
      companyUid: plantUid,
      operationType: 'receipt',
      itemCode: ITEM,
      serialNumber: number,
      qty: '1',
      toWarehouseCode: WAREHOUSE,
      toLocationCode: cell,
      unitCost: '33900000',
    });
    const issue = await post({
      companyUid: plantUid,
      operationType: 'issue_to_production',
      itemCode: ITEM,
      serialNumber: number,
      qty: '1',
      fromWarehouseCode: WAREHOUSE,
      fromLocationCode: cell,
    });
    expect(issue.status, JSON.stringify(issue.body)).toBe(201);

    const inWork = await db.query(
      `SELECT current_state::text AS state FROM serial_number WHERE number = $1`,
      [number],
    );
    expect(inWork.rows[0].state, 'состояние после выдачи в цех').toBe('in_production');

    const back = await api(`/api/v1/warehouse/moves/${issue.body.data.uid}/reverse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth(admin.token) },
      body: JSON.stringify({ comment: 'проверка' }),
    });
    expect(back.status, JSON.stringify(back.body)).toBe(201);

    const { rows } = await db.query(
      `SELECT sn.current_state::text AS state,
              coalesce((SELECT sum(qty_on_hand) FROM stock_balance WHERE serial_id = sn.id), 0)::text AS qty
         FROM serial_number sn WHERE sn.number = $1`,
      [number],
    );
    expect(rows[0].state, 'состояние после отмены выдачи').toBe('in_stock');
    expect(Number(rows[0].qty), 'остаток после отмены выдачи').toBe(1);
  });
});

describe('серийный учёт: подбор и путь номера', () => {
  it('подбор предлагает только то, что лежит на складе', async () => {
    const res = await api(
      `/api/v1/warehouse/serials?itemCode=${ITEM}&warehouseCode=${WAREHOUSE}`,
      { headers: auth(admin.token) },
    );
    expect(res.status).toBe(200);
    const rows = res.body.data.rows as any[];
    expect(rows.length, 'подбор номеров пуст').toBeGreaterThan(0);

    // Предложить в форме номер, которого на складе нет, хуже пустого списка:
    // кладовщик выберет его и получит отказ на сохранении.
    const offered = rows.map((r) => r.number);
    const { rows: bad } = await db.query(
      `SELECT sn.number, sn.current_state::text AS state,
              coalesce((SELECT sum(qty_on_hand) FROM stock_balance WHERE serial_id = sn.id), 0)::text AS qty
         FROM serial_number sn
        WHERE sn.number = ANY($1::text[])
          AND (sn.current_state::text <> 'in_stock'
               OR coalesce((SELECT sum(qty_on_hand) FROM stock_balance WHERE serial_id = sn.id), 0) <= 0)`,
      [offered],
    );
    expect(
      bad.map((b: any) => `${b.number} (${b.state}, остаток ${b.qty})`),
      'подбор предложил номера, которых на складе нет',
    ).toEqual([]);
    for (const r of rows) expect(r.warehouseCode).toBe(WAREHOUSE);
  });

  it('путь номера называет позицию, место и движения', async () => {
    const { rows } = await db.query(
      `SELECT sn.number FROM serial_number sn
         JOIN item i ON i.id = sn.item_id
        WHERE i.code = $1 AND sn.current_state::text = 'in_stock'
        ORDER BY sn.number LIMIT 1`,
      [ITEM],
    );
    const res = await api(`/api/v1/warehouse/serials/${rows[0].number}`, {
      headers: auth(admin.token),
    });
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.serial.number).toBe(rows[0].number);
    expect(d.serial.item.code).toBe(ITEM);
    expect(d.serial.state).toBe('in_stock');
    expect(d.place, 'лежащая труба не назвала склад').toBeTruthy();
    expect(d.place.warehouse).toBeTruthy();
    expect(d.moves.length, 'в пути номера нет ни одного движения').toBeGreaterThan(0);
    expect(d.moves.some((m: any) => m.operationType === 'receipt')).toBe(true);
  });

  it('чужого номера нет', async () => {
    const res = await api('/api/v1/warehouse/serials/QA-SER-NETU', {
      headers: auth(admin.token),
    });
    expect(res.status).toBe(404);
  });
});

describe('серийный учёт: продажи', () => {
  /** Заказ на штучную позицию: номера называют в накладной, не в заказе. */
  const orderFor = async (qty: string) => {
    const { rows } = await db.query(
      `SELECT p.uid::text AS uid FROM partner p
         JOIN company c ON c.id = p.company_id
        WHERE c.code = 'plant' AND p.is_client ORDER BY p.id LIMIT 1`,
    );
    return api('/api/v1/sales/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth(admin.token) },
      body: JSON.stringify({
        companyUid: plantUid,
        partnerUid: rows[0].uid,
        warehouseCode: WAREHOUSE,
        // Цену ставит прайс (ТЗ 9.2), проверяются номера.
        lines: [{ itemCode: ITEM, qty }],
      }),
    });
  };

  it('штучная позиция заказывается: номера называют при отгрузке', async () => {
    const res = await orderFor('1');
    expect(res.status).toBe(201);
  });

  it('дробное количество штучной позиции в заказ не пускают', async () => {
    const res = await orderFor('0.5');
    expect(res.status).toBe(422);
    expect(String(res.body.error.message)).toContain('серийным номерам');
  });
});
