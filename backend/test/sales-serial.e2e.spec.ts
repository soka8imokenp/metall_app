/**
 * Продажа и отгрузка штучной позиции по серийным номерам (ТЗ 5.6).
 *
 * До этого заказ на серийную позицию отклонялся на входе, а ТТН — на отгрузке:
 * накладная умела только партию и количество. Здесь проверяется обратное —
 * номера называются в накладной, каждая труба уезжает своей строкой, и по
 * номеру видно, кому она ушла.
 *
 * Прогон пишет в базу: отгружает сидовые номера и возвращает их приходом в
 * `afterAll`. Журнал движений append-only, поэтому след остаётся — его уносит
 * пересев.
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
const RUN = `SER-${Date.now().toString(36)}`;
/** Штучная позиция сида: труба ППУ, которая живёт по номеру. */
const ITEM = 'PPU-530-710';
const WAREHOUSE = 'ZAVOD-GP';

let seller: Awaited<ReturnType<typeof login>>;
let keeper: Awaited<ReturnType<typeof login>>;
let companyUid: string;
let partnerUid: string;
/** Номера, взятые под прогон: по одному на сценарий, чтобы не мешать друг другу. */
let free: string[] = [];
/** Позиция того же склада без штучного учёта — для проверки «номер не к месту». */
let plainItem: string;
/** Ячейка приёма на складе: без неё приход на ZAVOD-GP служба не принимает. */
let location: string;
/** Что вернуть приходом: отгруженные номера. */
const restore: string[] = [];

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
const json = (token: string) => ({ ...auth(token), 'Content-Type': 'application/json' });

const orderBody = (qty: string, itemCode = ITEM) => ({
  companyUid,
  partnerUid,
  warehouseCode: WAREHOUSE,
  comment: `проверка ${RUN}`,
  // Цену ставит прайс (ТЗ 9.2): своя цифра стала бы ручной ценой с правом
  // и основанием, а проверяется здесь не цена, а номера труб.
  lines: [{ itemCode, qty }],
});

async function confirmedOrder(qty: string, itemCode = ITEM) {
  const made = await api('/api/v1/sales/orders', {
    method: 'POST',
    headers: json(seller.token),
    body: JSON.stringify(orderBody(qty, itemCode)),
  });
  expect(made.status).toBe(201);
  const uid = made.body.data.uid as string;
  const status = await api(`/api/v1/sales/orders/${uid}/status`, {
    method: 'POST',
    headers: json(seller.token),
    body: JSON.stringify({ status: 'confirmed' }),
  });
  expect(status.status).toBe(201);
  const line = await db.query<{ uid: string }>(
    `SELECT l.uid FROM sales_order_line l JOIN sales_order o ON o.id = l.sales_order_id
      WHERE o.uid = $1 ORDER BY l.seq LIMIT 1`,
    [uid],
  );
  return { uid, lineUid: line.rows[0].uid };
}

async function ship(uid: string, lines: unknown[], key?: string) {
  const res = await api(`/api/v1/sales/orders/${uid}/shipments`, {
    method: 'POST',
    headers: { ...json(seller.token), ...(key ? { 'Idempotency-Key': key } : {}) },
    body: JSON.stringify({ lines }),
  });
  if (res.status === 201) {
    for (const l of lines as { serialNumbers?: string[] }[]) {
      for (const n of l.serialNumbers ?? []) restore.push(n);
    }
  }
  return res;
}

/** Состояние номера и его остаток — то, что записано, а не то, что ответил ход. */
async function serialRow(number: string) {
  const r = await db.query<{ state: string; on_hand: string; shipped: string }>(
    `SELECT sn.current_state::text AS state,
            coalesce((SELECT sum(sb.qty_on_hand) FROM stock_balance sb
                       WHERE sb.serial_id = sn.id), 0)::text AS on_hand,
            coalesce((SELECT count(*) FROM shipment_line sl
                       WHERE sl.serial_id = sn.id), 0)::text AS shipped
       FROM serial_number sn WHERE sn.number = $1`,
    [number],
  );
  return r.rows[0];
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [PrismaModule, AuthModule, SalesModule, WarehouseModule],
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

  seller = await login('b.ergashev');
  keeper = await login('a.saidov');
  companyUid = seller.companies[0].uid;

  const partner = await db.query<{ uid: string }>(
    `SELECT p.uid FROM partner p JOIN company c ON c.id = p.company_id
      WHERE c.uid = $1 AND p.is_active AND p.is_client ORDER BY p.id LIMIT 1`,
    [companyUid],
  );
  if (!partner.rows[0]) throw new Error('в компании нет покупателя: заказ не на кого выписать');
  partnerUid = partner.rows[0].uid;

  const cell = await db.query<{ code: string }>(
    `SELECT l.code FROM storage_location l
       JOIN warehouse_zone z ON z.id = l.zone_id
       JOIN warehouse w ON w.id = z.warehouse_id
       JOIN company c ON c.id = w.company_id
      WHERE c.uid = $1 AND w.code = $2 AND l.is_active
      ORDER BY l.id LIMIT 1`,
    [companyUid, WAREHOUSE],
  );
  if (!cell.rows[0]) throw new Error(`на складе ${WAREHOUSE} нет ячеек: приход не принять`);
  location = cell.rows[0].code;

  /**
   * Номера под прогон заводятся приходом, а не берутся из посева.
   *
   * Так было не всегда, и обе причины стоит помнить. Первая: сидовые номера
   * расходуют соседние проверки — склад в боте тоже отгружает штучную трубу, —
   * и файл падал «на подготовке» в зависимости от того, что успело пройти до
   * него. Вторая: у номера, который уже уезжал и вернулся, в истории есть
   * строка отгрузки, а здесь проверяется «уехал ровно один раз». Свежий номер
   * без истории делает обе проверки честными и ни у кого ничего не отнимает.
   */
  for (let i = 1; i <= 4; i += 1) {
    const number = `${RUN}-${i}`;
    const made = await api('/api/v1/warehouse/moves', {
      method: 'POST',
      headers: json(keeper.token),
      body: JSON.stringify({
        companyUid,
        operationType: 'receipt',
        itemCode: ITEM,
        serialNumber: number,
        qty: '1',
        toWarehouseCode: WAREHOUSE,
        toLocationCode: location,
        unitCost: '33900000',
        comment: `номер под проверку ${RUN}`,
      }),
    });
    if (made.status !== 201 && made.status !== 200) {
      throw new Error(`не удалось завести номер: ${made.status} ${JSON.stringify(made.body)}`);
    }
    free.push(number);
  }

  const plain = await db.query<{ code: string }>(
    `SELECT i.code FROM item i JOIN company c ON c.id = i.company_id
      WHERE c.uid = $1 AND i.is_active AND NOT i.track_serials
        AND i.item_type::text IN ('goods', 'finished')
      ORDER BY i.id LIMIT 1`,
    [companyUid],
  );
  plainItem = plain.rows[0].code;
}, 60_000);

/**
 * Возврат отгруженных номеров приходом.
 *
 * Отказ здесь раньше не проверялся, и это било не по этому файлу: приход на
 * ZAVOD-GP без ячейки служба отбивает (422), возврат молча не проходил, и
 * каждый прогон уносил из сида по четыре номера. Через несколько дней их
 * осталось три, и проверка начала падать «на подготовке» — причём не своя.
 */
afterAll(async () => {
  const failed: string[] = [];
  for (const number of restore) {
    const back = await api('/api/v1/warehouse/moves', {
      method: 'POST',
      headers: json(keeper.token),
      body: JSON.stringify({
        companyUid,
        operationType: 'receipt',
        itemCode: ITEM,
        serialNumber: number,
        qty: '1',
        toWarehouseCode: WAREHOUSE,
        toLocationCode: location,
        unitCost: '33900000',
        comment: `возврат после проверки ${RUN}`,
      }),
    });
    if (back.status !== 201 && back.status !== 200) {
      failed.push(`${number}: ${back.status} ${JSON.stringify(back.body)}`);
    }
  }
  await app?.close();
  await db?.end();
  if (failed.length > 0) {
    throw new Error(`номера не вернулись на склад: ${failed.join('; ')}`);
  }
});

describe('заказ на штучную позицию', () => {
  it('заводится и подтверждается: номера называют при отгрузке, не при заказе', async () => {
    const { uid } = await confirmedOrder('2');
    const row = await db.query<{ status: string }>(
      `SELECT status::text FROM sales_order WHERE uid = $1`,
      [uid],
    );
    expect(row.rows[0].status).toBe('confirmed');
  });

  it('дробное количество штучной позиции не принимается', async () => {
    const res = await api('/api/v1/sales/orders', {
      method: 'POST',
      headers: json(seller.token),
      body: JSON.stringify(orderBody('1.5')),
    });
    expect(res.status).toBe(422);
    expect(String(res.body.error.message)).toMatch(/штук/i);
  });

  it('доступность показывает свободные номера строки', async () => {
    const { uid } = await confirmedOrder('1');
    const res = await api(`/api/v1/sales/orders/${uid}/availability`, {
      headers: auth(seller.token),
    });
    expect(res.status).toBe(200);
    const line = res.body.data.lines[0];
    expect(line.trackSerials).toBe(true);
    expect(Array.isArray(line.serials)).toBe(true);
    expect(line.serials.length).toBeGreaterThan(0);
    // Список обрезан по пятидесяти — больше в одну накладную не грузят.
    expect(line.serials.length, 'список номеров не обрезан').toBeLessThanOrEqual(50);

    /**
     * Проверяется то, за что список отвечает: каждый названный номер правда
     * свободен на складе этой строки. На «своём» номере проверка держаться не
     * может — он попадает в полсотни или не попадает в зависимости от того,
     * сколько номеров лежит на складе вообще, и однажды перестала.
     */
    const real = await db.query<{ number: string }>(
      `SELECT sn.number
         FROM stock_balance sb
         JOIN serial_number sn ON sn.id = sb.serial_id
         JOIN warehouse w ON w.id = sb.warehouse_id
        WHERE sn.number = ANY($1::text[]) AND sb.qty_available > 0 AND w.code = $2`,
      [line.serials, WAREHOUSE],
    );
    expect(
      real.rows.map((r) => r.number).sort(),
      'в списке номер, которого на складе нет или который уже занят',
    ).toEqual([...(line.serials as string[])].sort());
  });
});

describe('отгрузка по номерам', () => {
  it('без номеров отказывает и называет позицию', async () => {
    const { uid, lineUid } = await confirmedOrder('1');
    const res = await ship(uid, [{ lineUid, qty: '1' }]);
    expect(res.status).toBe(422);
    expect(String(res.body.error.message)).toContain(ITEM);
  });

  it('номеров меньше, чем количества — отказ', async () => {
    const { uid, lineUid } = await confirmedOrder('2');
    const res = await ship(uid, [{ lineUid, qty: '2', serialNumbers: [free[0]] }]);
    expect(res.status).toBe(422);
  });

  it('один номер дважды в одной накладной — отказ', async () => {
    const { uid, lineUid } = await confirmedOrder('2');
    const res = await ship(uid, [{ lineUid, qty: '2', serialNumbers: [free[0], free[0]] }]);
    expect(res.status).toBe(422);
  });

  it('несуществующий номер — отказ', async () => {
    const { uid, lineUid } = await confirmedOrder('1');
    const res = await ship(uid, [{ lineUid, qty: '1', serialNumbers: [`${RUN}-нет`] }]);
    expect(res.status).toBe(422);
  });

  it('номер у позиции без штучного учёта — отказ', async () => {
    const { uid, lineUid } = await confirmedOrder('1', plainItem);
    const res = await ship(uid, [{ lineUid, qty: '1', serialNumbers: [free[0]] }]);
    expect(res.status).toBe(422);
  });

  it('две трубы уезжают двумя строками, каждая со своим номером', async () => {
    const numbers = [free[0], free[1]];
    const { uid, lineUid } = await confirmedOrder('2');
    const res = await ship(uid, [{ lineUid, qty: '2', serialNumbers: numbers }]);

    expect(res.status).toBe(201);
    const shipmentUid = res.body.data.uid as string;

    const lines = await db.query<{ n: string; qty: string; serials: string }>(
      `SELECT count(*)::text AS n, sum(sl.qty)::text AS qty,
              count(DISTINCT sl.serial_id)::text AS serials
         FROM shipment_line sl JOIN shipment s ON s.id = sl.shipment_id
        WHERE s.uid = $1`,
      [shipmentUid],
    );
    expect(lines.rows[0].n).toBe('2');
    expect(Number(lines.rows[0].qty)).toBeCloseTo(2, 6);
    expect(lines.rows[0].serials).toBe('2');

    for (const number of numbers) {
      const row = await serialRow(number);
      expect(row.state).toBe('shipped');
      expect(Number(row.on_hand)).toBeCloseTo(0, 6);
      expect(Number(row.shipped)).toBe(1);
    }

    // Каждое движение несёт ровно одну трубу: «две штуки одним номером» —
    // неправда про одну из них.
    const moves = await db.query<{ n: string; qty: string }>(
      `SELECT count(*)::text AS n, max(m.qty)::text AS qty
         FROM stock_move m JOIN shipment s ON s.id = m.source_doc_id
        WHERE m.source_doc_type = 'shipment' AND s.uid = $1 AND m.serial_id IS NOT NULL`,
      [shipmentUid],
    );
    expect(moves.rows[0].n).toBe('2');
    expect(Number(moves.rows[0].qty)).toBeCloseTo(1, 6);
  });

  it('уехавший номер второй раз не отгружается', async () => {
    const { uid, lineUid } = await confirmedOrder('1');
    const res = await ship(uid, [{ lineUid, qty: '1', serialNumbers: [free[0]] }]);
    expect(res.status).toBe(422);
    expect(String(res.body.error.message)).toContain(free[0]);
  });

  it('по номеру видно, кому труба ушла', async () => {
    const res = await api(`/api/v1/warehouse/serials/${encodeURIComponent(free[1])}`, {
      headers: auth(keeper.token),
    });
    expect(res.status).toBe(200);
    const kinds = (res.body.data.moves as { operationType: string }[]).map((m) => m.operationType);
    expect(kinds).toContain('shipment');
  });

  it('повтор с тем же ключом идемпотентности не отгружает второй раз', async () => {
    const { uid, lineUid } = await confirmedOrder('1');
    const key = `${RUN}-idem`;
    const first = await ship(uid, [{ lineUid, qty: '1', serialNumbers: [free[2]] }], key);
    expect(first.status).toBe(201);
    const again = await api(`/api/v1/sales/orders/${uid}/shipments`, {
      method: 'POST',
      headers: { ...json(seller.token), 'Idempotency-Key': key },
      body: JSON.stringify({ lines: [{ lineUid, qty: '1', serialNumbers: [free[2]] }] }),
    });
    expect(again.status).toBe(201);
    expect(again.body.data.uid).toBe(first.body.data.uid);
    expect(Number((await serialRow(free[2])).shipped)).toBe(1);
  });
});
