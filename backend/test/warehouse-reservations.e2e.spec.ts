/**
 * Резерв: приложение целиком, живая база.
 *
 * Резерв — не движение. Товар не поехал, он обещан, и в журнале его нет. Правда
 * о нём одна — строки `stock_reservation`; `qty_reserved` в остатке только
 * свёртка активных строк, как сам остаток — свёртка журнала. Отсюда главное,
 * что здесь проверяется: после любой правки резерва свёртка сходится, а
 * `qty_available` остаётся `qty_on_hand - qty_reserved` (на это в базе стоит
 * CHECK, так что расхождение упало бы транзакцией, а не тихо).
 *
 * Прибираемся снятием, а не удалением: снятый резерв — история обещания, и
 * список активных его не показывает.
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
import { ContextMiddleware } from '../src/common/context.middleware.js';
import { EnvelopeInterceptor } from '../src/common/envelope.interceptor.js';
import { ErrorFilter } from '../src/common/error.filter.js';

let app: INestApplication;
let base: string;
let db: Client;

const PASSWORD = process.env.SEED_PASSWORD ?? 'metall-dev-2026';

/** Резервы, заведённые прогоном: снимаем в конце. */
const made: string[] = [];
const releasedByTest = new Set<string>();

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

let keeper: Awaited<ReturnType<typeof login>>;
let seller: Awaited<ReturnType<typeof login>>;
let director: Awaited<ReturnType<typeof login>>;

/** Позиция с живым остатком: на ней и обещаем. */
let company: { uid: string };
let item: { code: string; batch: string };
let warehouse: string;
let warehouseUid: string;
let otherItem: string;

/** Обещанное по складу: свёртка активных резервов. */
async function reservations(itemCode: string, batch: string | null) {
  const r = await db.query<{ qty: string }>(
    `SELECT coalesce(sum(r.qty), 0)::text AS qty
       FROM stock_reservation r
       JOIN company c ON c.id = r.company_id
       JOIN warehouse w ON w.id = r.warehouse_id
       JOIN item i ON i.id = r.item_id
       LEFT JOIN batch b ON b.id = r.batch_id
      WHERE c.uid = $1 AND w.code = $2 AND i.code = $3
        AND b.number IS NOT DISTINCT FROM $4
        AND r.status = 'active' AND (r.expires_at IS NULL OR r.expires_at > now())`,
    [company.uid, warehouse, itemCode, batch],
  );
  return Number(r.rows[0]?.qty ?? 0);
}

/** То же по остатку: `qty_reserved`, сложенный по ячейкам. */
async function reservedInBalance(itemCode: string, batch: string | null) {
  const r = await db.query<{ reserved: string; on_hand: string; available: string }>(
    `SELECT coalesce(sum(sb.qty_reserved), 0)::text AS reserved,
            coalesce(sum(sb.qty_on_hand), 0)::text AS on_hand,
            coalesce(sum(sb.qty_available), 0)::text AS available
       FROM stock_balance sb
       JOIN company c ON c.id = sb.company_id
       JOIN warehouse w ON w.id = sb.warehouse_id
       JOIN item i ON i.id = sb.item_id
       LEFT JOIN batch b ON b.id = sb.batch_id
      WHERE c.uid = $1 AND w.code = $2 AND i.code = $3
        AND b.number IS NOT DISTINCT FROM $4 AND sb.serial_id IS NULL`,
    [company.uid, warehouse, itemCode, batch],
  );
  const row = r.rows[0];
  return {
    reserved: Number(row?.reserved ?? 0),
    onHand: Number(row?.on_hand ?? 0),
    available: Number(row?.available ?? 0),
  };
}

const status = async (uid: string) =>
  (
    await db.query<{ status: string }>(
      `SELECT status::text AS status FROM stock_reservation WHERE uid = $1`,
      [uid],
    )
  ).rows[0]?.status;

async function reserve(token: string, body: Record<string, unknown>) {
  const res = await api('/api/v1/warehouse/reservations', {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify(body),
  });
  const uid = res.body?.data?.uid;
  if (res.status === 201 && uid) made.push(uid);
  return res;
}

async function release(token: string, uid: string) {
  const res = await api(`/api/v1/warehouse/reservations/${uid}`, {
    method: 'DELETE',
    headers: auth(token),
  });
  if (res.status === 200 || res.status === 201) releasedByTest.add(uid);
  return res;
}

const body = (extra: Record<string, unknown> = {}) => ({
  companyUid: company.uid,
  itemCode: item.code,
  batchNumber: item.batch,
  warehouseCode: warehouse,
  qty: '3',
  ...extra,
});

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [PrismaModule, AuthModule, WarehouseModule],
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

  keeper = await login('a.saidov');
  seller = await login('d.karimov');
  director = await login('s.radjabov');

  // Нужна строка с запасом: резерв упрётся в свободное, и тогда проверки
  // превышения проверят не право, а нехватку товара.
  const row = await db.query<{
    company_uid: string;
    warehouse_code: string;
    warehouse_uid: string;
    item_code: string;
    batch_number: string;
  }>(
    `SELECT c.uid AS company_uid, w.code AS warehouse_code, w.uid AS warehouse_uid,
            i.code AS item_code, b.number AS batch_number
       FROM stock_balance sb
       JOIN company c ON c.id = sb.company_id
       JOIN warehouse w ON w.id = sb.warehouse_id
       JOIN item i ON i.id = sb.item_id
       JOIN batch b ON b.id = sb.batch_id
      WHERE sb.serial_id IS NULL AND sb.qty_on_hand > 20
      ORDER BY sb.qty_on_hand DESC
      LIMIT 1`,
  );
  const r = row.rows[0];
  if (!r) throw new Error('в базе нет позиции с остатком: обещать нечего');
  company = { uid: r.company_uid };
  warehouse = r.warehouse_code;
  warehouseUid = r.warehouse_uid;
  item = { code: r.item_code, batch: r.batch_number };

  const another = await db.query<{ code: string }>(
    `SELECT i.code FROM item i JOIN company c ON c.id = i.company_id
      WHERE c.uid = $1 AND i.is_active AND i.code <> $2 ORDER BY i.code LIMIT 1`,
    [company.uid, item.code],
  );
  otherItem = another.rows[0]!.code;
}, 60_000);

afterAll(async () => {
  for (const uid of made) {
    if (releasedByTest.has(uid)) continue;
    if ((await status(uid)) === 'active') await release(keeper.token, uid);
  }
  await app?.close();
  await db?.end();
});

describe('резерв в сиде', () => {
  it('стоит строками, а не только числом в остатке', async () => {
    const r = await db.query<{ n: string; with_order: string }>(
      `SELECT count(*)::text AS n,
              count(sales_order_line_id)::text AS with_order
         FROM stock_reservation WHERE status = 'active'`,
    );
    expect(Number(r.rows[0].n)).toBeGreaterThan(0);
    // Резерв в жизни стоит под заказом: без ссылки на строку заказа никто не
    // объяснит, кому обещан товар, и снимать его будет нечем.
    expect(Number(r.rows[0].with_order)).toBeGreaterThan(0);
  });

  it('`qty_reserved` в остатке — свёртка активных резервов по складу и партии', async () => {
    // Сравниваем два независимых итога по каждому ключу «склад + позиция +
    // партия»: обещанное строками и обещанное в остатке. Остаток обрезан
    // наличием — резерв сверх наличия законен, держать его остатку нечем.
    const bad = await db.query<{
      warehouse: string;
      item: string;
      batch: string | null;
      in_balance: string;
      expected: string;
    }>(
      `WITH bal AS (
         SELECT sb.company_id, sb.warehouse_id, sb.item_id, sb.batch_id,
                sum(sb.qty_on_hand) AS on_hand, sum(sb.qty_reserved) AS reserved
           FROM stock_balance sb WHERE sb.serial_id IS NULL
          GROUP BY 1, 2, 3, 4
       ), res AS (
         SELECT r.company_id, r.warehouse_id, r.item_id, r.batch_id, sum(r.qty) AS qty
           FROM stock_reservation r
          WHERE r.status = 'active' AND (r.expires_at IS NULL OR r.expires_at > now())
          GROUP BY 1, 2, 3, 4
       )
       SELECT w.code AS warehouse, i.code AS item, b.number AS batch,
              coalesce(bal.reserved, 0)::text AS in_balance,
              least(coalesce(res.qty, 0), coalesce(bal.on_hand, 0))::text AS expected
         FROM bal
         FULL JOIN res ON res.company_id = bal.company_id
              AND res.warehouse_id = bal.warehouse_id
              AND res.item_id = bal.item_id
              AND res.batch_id IS NOT DISTINCT FROM bal.batch_id
         JOIN warehouse w ON w.id = coalesce(bal.warehouse_id, res.warehouse_id)
         JOIN item i ON i.id = coalesce(bal.item_id, res.item_id)
         LEFT JOIN batch b ON b.id = coalesce(bal.batch_id, res.batch_id)
        WHERE abs(coalesce(bal.reserved, 0)
                  - least(coalesce(res.qty, 0), coalesce(bal.on_hand, 0))) > 0.000001
        ORDER BY 1, 2, 3
        LIMIT 20`,
    );
    expect(bad.rows).toEqual([]);
  });
});

describe('GET /warehouse/reservations', () => {
  it('отдаёт активные резервы с позицией, складом, количеством и заказом', async () => {
    const res = await api('/api/v1/warehouse/reservations?limit=50', {
      headers: auth(keeper.token),
    });

    expect(res.status).toBe(200);
    expect(res.body.data.total).toBeGreaterThan(0);
    const rows = res.body.data.rows as any[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.uid).toMatch(/^[0-9a-f-]{36}$/);
      expect(row.item.code).toBeTruthy();
      expect(row.item.unit).toBeTruthy();
      expect(row.warehouse.code).toBeTruthy();
      expect(Number(row.qty)).toBeGreaterThan(0);
    }
    // Хотя бы один резерв назван заказом и покупателем: иначе список
    // показывает, что товар обещан, но не кому.
    expect(rows.some((r) => r.orderNumber && r.partner)).toBe(true);
  });

  it('фильтрует по складу и по номенклатуре', async () => {
    const byWarehouse = await api(
      `/api/v1/warehouse/reservations?warehouse=${warehouseUid}&limit=200`,
      { headers: auth(keeper.token) },
    );
    expect(byWarehouse.status).toBe(200);
    const codes = new Set((byWarehouse.body.data.rows as any[]).map((r) => r.warehouse.code));
    expect([...codes]).toEqual(codes.size ? [warehouse] : []);

    const byItem = await api(
      `/api/v1/warehouse/reservations?itemCode=${encodeURIComponent(item.code)}&limit=200`,
      { headers: auth(keeper.token) },
    );
    expect(byItem.status).toBe(200);
    for (const row of byItem.body.data.rows as any[]) {
      expect(row.item.code).toBe(item.code);
    }
  });

  it('без токена не отдаёт ничего', async () => {
    expect((await api('/api/v1/warehouse/reservations')).status).toBe(401);
  });
});

describe('POST и DELETE /warehouse/reservations', () => {
  it('ставит резерв: обещанное растёт, доступное уменьшается, наличие не трогается', async () => {
    const before = await reservedInBalance(item.code, item.batch);
    const heldBefore = await reservations(item.code, item.batch);

    const res = await reserve(keeper.token, body({ qty: '3' }));
    expect(res.status).toBe(201);

    expect(await reservations(item.code, item.batch)).toBeCloseTo(heldBefore + 3, 6);
    const after = await reservedInBalance(item.code, item.batch);
    expect(after.onHand).toBeCloseTo(before.onHand, 6);
    expect(after.reserved).toBeCloseTo(before.reserved + 3, 6);
    expect(after.available).toBeCloseTo(before.available - 3, 6);

    // И он виден в списке — той же строкой, тем же количеством.
    const list = await api(
      `/api/v1/warehouse/reservations?itemCode=${encodeURIComponent(item.code)}&limit=200`,
      { headers: auth(keeper.token) },
    );
    const row = (list.body.data.rows as any[]).find((r) => r.uid === res.body.data.uid);
    expect(row).toBeTruthy();
    expect(Number(row.qty)).toBeCloseTo(3, 6);
    expect(row.overSold).toBe(false);

    // Снятие возвращает обещанное ровно к прежнему: резерв ничего не съел.
    expect((await release(keeper.token, res.body.data.uid)).status).toBe(200);
    expect(await status(res.body.data.uid)).toBe('released');
    const back = await reservedInBalance(item.code, item.batch);
    expect(back.reserved).toBeCloseTo(before.reserved, 6);
    expect(back.available).toBeCloseTo(before.available, 6);

    // Резерв делает товар недоступным другим заказам — это решение, и оно
    // обязано быть в журнале действий (ТЗ 3.4), а не только в своей таблице.
    const log = await db.query<{ action: string; changes: any }>(
      `SELECT action, changes FROM audit_log
        WHERE entity_type = 'stock_reservation' AND entity_id = $1 ORDER BY id`,
      [res.body.data.uid],
    );
    const actions = log.rows.map((r) => r.action);
    expect(actions).toEqual(['create', 'release']);
    expect(Number(log.rows[0].changes.qty.to)).toBeCloseTo(3, 6);
    expect(log.rows[1].changes.status).toEqual({ from: 'active', to: 'released' });
  });

  it('снятый резерв второй раз не снимается', async () => {
    const res = await reserve(keeper.token, body({ qty: '1' }));
    expect(res.status).toBe(201);
    expect((await release(keeper.token, res.body.data.uid)).status).toBe(200);

    const again = await release(keeper.token, res.body.data.uid);
    expect(again.status).toBe(422);
    expect(String(again.body.error.message)).toContain('уже снят');
  });

  it('по партионной номенклатуре без партии не обещает', async () => {
    // Резерв «любой партией» лёг бы в ключ с пустой партией, где остатка нет:
    // обещание в таблице есть, а доступное на складе прежнее.
    const res = await reserve(keeper.token, {
      companyUid: company.uid,
      itemCode: item.code,
      warehouseCode: warehouse,
      qty: '1',
    });
    expect(res.status).toBe(422);
    expect(String(res.body.error.message)).toContain('партиям');
  });

  it('продавцу резерв не поставить: нет права warehouse.move', async () => {
    expect(seller.permissions).not.toContain('warehouse.move');
    const res = await reserve(seller.token, body());
    expect(res.status).toBe(403);
    expect(String(res.body.error.message)).toContain('warehouse.move');
  });

  it('больше свободного кладовщик не обещает и слышит, какого права не хватает', async () => {
    const free = (await reservedInBalance(item.code, item.batch)).available;
    const res = await reserve(keeper.token, body({ qty: String(free + 10) }));

    expect(res.status).toBe(422);
    expect(String(res.body.error.message)).toContain('sales.order.oversell');
    expect(String(res.body.error.message)).toContain('обещано');
  });

  it('директору можно сверх свободного: остаток обрезан наличием, резерв — нет', async () => {
    expect(director.permissions).toContain('sales.order.oversell');
    const before = await reservedInBalance(item.code, item.batch);
    const qty = before.onHand + 5;

    const res = await reserve(director.token, body({ qty: String(qty) }));
    expect(res.status).toBe(201);

    const after = await reservedInBalance(item.code, item.batch);
    // CHECK `qty_reserved <= qty_on_hand` держит остаток: обещать сверх наличия
    // можно, а зарезервировать в остатке больше, чем лежит, — нельзя.
    expect(after.reserved).toBeCloseTo(after.onHand, 6);
    expect(after.available).toBeCloseTo(0, 6);
    expect(await reservations(item.code, item.batch)).toBeCloseTo(before.reserved + qty, 6);

    const list = await api(
      `/api/v1/warehouse/reservations?itemCode=${encodeURIComponent(item.code)}&limit=200`,
      { headers: auth(director.token) },
    );
    const row = (list.body.data.rows as any[]).find((r) => r.uid === res.body.data.uid);
    expect(row.overSold).toBe(true);

    expect((await release(director.token, res.body.data.uid)).status).toBe(200);
    const back = await reservedInBalance(item.code, item.batch);
    expect(back.reserved).toBeCloseTo(before.reserved, 6);
  });

  it('просроченный резерв снимается сам при следующем пересчёте', async () => {
    const before = await reservedInBalance(item.code, item.batch);
    const res = await reserve(keeper.token, body({ qty: '2', expiresAt: '2026-12-31' }));
    expect(res.status).toBe(201);
    expect((await reservedInBalance(item.code, item.batch)).reserved).toBeCloseTo(
      before.reserved + 2,
      6,
    );

    // Ждать декабря незачем: срок сдвигаем в прошлое прямо в базе — в жизни
    // этот же час наступает сам.
    await db.query(`UPDATE stock_reservation SET expires_at = now() - interval '1 day' WHERE uid = $1`, [
      res.body.data.uid,
    ]);

    // Пересчёт делает любая правка резерва по этому же ключу.
    const other = await reserve(keeper.token, body({ qty: '1' }));
    expect(other.status).toBe(201);

    expect(await status(res.body.data.uid)).toBe('released');
    const after = await reservedInBalance(item.code, item.batch);
    expect(after.reserved).toBeCloseTo(before.reserved + 1, 6);
    expect((await release(keeper.token, other.body.data.uid)).status).toBe(200);
  });

  it('срок в прошлом не принимает', async () => {
    const res = await reserve(keeper.token, body({ expiresAt: '2020-01-01' }));
    expect(res.status).toBe(422);
    expect(String(res.body.error.message)).toContain('Срок резерва');
  });

  it('партию, которой нет, не обещает', async () => {
    const res = await reserve(keeper.token, body({ batchNumber: 'НЕТ-ТАКОЙ-ПАРТИИ' }));
    expect(res.status).toBe(422);
    expect(String(res.body.error.message)).toContain('Партия');
  });

  it('количество не больше нуля не принимает', async () => {
    const res = await reserve(keeper.token, body({ qty: '0' }));
    expect(res.status).toBe(422);
  });

  it('заказ, в котором нет этой номенклатуры, не принимает', async () => {
    const order = await db.query<{ number: string }>(
      `SELECT so.number FROM sales_order so
         JOIN company c ON c.id = so.company_id
         JOIN sales_order_line sol ON sol.sales_order_id = so.id
         JOIN item i ON i.id = sol.item_id
        WHERE c.uid = $1
        GROUP BY so.number
       HAVING count(*) FILTER (WHERE i.code = $2) = 0
        LIMIT 1`,
      [company.uid, item.code],
    );
    const number = order.rows[0]?.number;
    if (!number) throw new Error('нет заказа без этой номенклатуры: проверять нечего');

    const res = await reserve(keeper.token, body({ salesOrderNumber: number }));
    expect(res.status).toBe(422);
    expect(String(res.body.error.message)).toContain(number);
  });

  it('резерв под строку заказа несёт в списке номер заказа и покупателя', async () => {
    // Заказ и остаток должны сойтись на одной номенклатуре: обещать надо то,
    // что лежит, иначе проверка упрётся в нехватку свободного, а не в список.
    const line = await db.query<{
      company_uid: string;
      number: string;
      item_code: string;
      warehouse: string;
      batch: string;
    }>(
      `SELECT c.uid AS company_uid, so.number, i.code AS item_code,
              w.code AS warehouse, b.number AS batch
         FROM sales_order_line sol
         JOIN sales_order so ON so.id = sol.sales_order_id
         JOIN company c ON c.id = so.company_id
         JOIN item i ON i.id = sol.item_id
         JOIN stock_balance sb ON sb.company_id = so.company_id AND sb.item_id = i.id
          AND sb.serial_id IS NULL AND sb.qty_available > 1
         JOIN warehouse w ON w.id = sb.warehouse_id
         JOIN batch b ON b.id = sb.batch_id
        ORDER BY sb.qty_available DESC
        LIMIT 1`,
    );
    const l = line.rows[0];
    if (!l) throw new Error('нет заказа с номенклатурой, лежащей на складе: проверять нечего');

    const res = await reserve(keeper.token, {
      companyUid: l.company_uid,
      itemCode: l.item_code,
      batchNumber: l.batch,
      warehouseCode: l.warehouse,
      qty: '1',
      salesOrderNumber: l.number,
    });
    expect(res.status).toBe(201);

    const list = await api(
      `/api/v1/warehouse/reservations?itemCode=${encodeURIComponent(l.item_code)}&limit=200`,
      { headers: auth(keeper.token) },
    );
    const row = (list.body.data.rows as any[]).find((r) => r.uid === res.body.data.uid);
    expect(row.orderNumber).toBe(l.number);
    expect(row.partner).toBeTruthy();

    expect((await release(keeper.token, res.body.data.uid)).status).toBe(200);
  });

  it('чужую номенклатуру другой компании в резерв не берёт', async () => {
    const res = await reserve(keeper.token, {
      companyUid: company.uid,
      itemCode: `${otherItem}-НЕТ`,
      warehouseCode: warehouse,
      qty: '1',
    });
    expect(res.status).toBe(422);
    expect(String(res.body.error.message)).toContain('не найдена');
  });
});

/**
 * Резерв стоит на складе и партии, а по ячейкам он только разложен. Разложить
 * его можно по-разному, и разница не косметическая: если пересчёт раскладывает
 * обещанное заново по порядку кодов, оно переезжает на ту полку, куда только что
 * положили приход. Полка оказывается занята обещанием, которое к этому приходу
 * отношения не имеет, и отмена прихода упирается в «недостаточно товара» — при
 * том, что на складе свободного вдоволь.
 *
 * Поэтому проверяем не «сторно работает», а само свойство: резерв остаётся там,
 * где стоял. Сторно — следствие, и оно тут же рядом.
 */
describe('резерв по полкам сам не скачет', () => {
  /** Раскладка обещанного по ячейкам одного ключа: полка → `qty_reserved`. */
  async function spread(
    companyUid: string,
    warehouseCode: string,
    itemCode: string,
    batchNumber: string,
  ) {
    const r = await db.query<{ loc: string; reserved: string }>(
      `SELECT z.code || '/' || l.code AS loc, sb.qty_reserved::text AS reserved
         FROM stock_balance sb
         JOIN company c ON c.id = sb.company_id
         JOIN warehouse w ON w.id = sb.warehouse_id
         JOIN item i ON i.id = sb.item_id
         JOIN batch b ON b.id = sb.batch_id
         JOIN storage_location l ON l.id = sb.location_id
         JOIN warehouse_zone z ON z.id = l.zone_id
        WHERE c.uid = $1 AND w.code = $2 AND i.code = $3 AND b.number = $4
          AND sb.serial_id IS NULL
        ORDER BY z.code, l.code`,
      [companyUid, warehouseCode, itemCode, batchNumber],
    );
    return new Map(r.rows.map((x) => [x.loc, Number(x.reserved)]));
  }

  it('приход в другую ячейку не перетаскивает обещанное на себя, и его отмена проходит', async () => {
    // Нужна партия, лежащая на одной полке, и при этом не на первой по коду:
    // приход пойдёт на первую, и только тогда «раскладка заново» себя покажет.
    const pick = await db.query<{
      company_uid: string;
      warehouse_code: string;
      item_code: string;
      batch_number: string;
      held_loc: string;
      free_loc: string;
    }>(
      `WITH one AS (
         SELECT sb.company_id, sb.warehouse_id, sb.item_id, sb.batch_id,
                min(z.code) AS zcode, min(l.code) AS lcode,
                count(*) AS cells, min(sb.qty_available) AS available
           FROM stock_balance sb
           JOIN storage_location l ON l.id = sb.location_id
           JOIN warehouse_zone z ON z.id = l.zone_id
          WHERE sb.serial_id IS NULL AND sb.batch_id IS NOT NULL
          GROUP BY sb.company_id, sb.warehouse_id, sb.item_id, sb.batch_id
         HAVING count(*) = 1 AND min(sb.qty_available) > 5
       ), first_cell AS (
         SELECT DISTINCT ON (z.warehouse_id)
                z.warehouse_id, z.code AS zcode, l.code AS lcode
           FROM storage_location l
           JOIN warehouse_zone z ON z.id = l.zone_id
          WHERE l.is_active
          ORDER BY z.warehouse_id, z.code, l.code
       )
       SELECT c.uid AS company_uid, w.code AS warehouse_code, i.code AS item_code,
              b.number AS batch_number,
              o.zcode || '/' || o.lcode AS held_loc,
              f.zcode || '/' || f.lcode AS free_loc
         FROM one o
         JOIN first_cell f ON f.warehouse_id = o.warehouse_id
          AND (f.zcode, f.lcode) < (o.zcode, o.lcode)
         JOIN company c ON c.id = o.company_id
         JOIN warehouse w ON w.id = o.warehouse_id
         JOIN item i ON i.id = o.item_id
         JOIN batch b ON b.id = o.batch_id
        ORDER BY o.available DESC
        LIMIT 1`,
    );
    const p = pick.rows[0];
    if (!p) throw new Error('в базе нет партии на одной не первой полке: проверять нечего');

    const held = await reserve(keeper.token, {
      companyUid: p.company_uid,
      itemCode: p.item_code,
      batchNumber: p.batch_number,
      warehouseCode: p.warehouse_code,
      qty: '4',
    });
    expect(held.status).toBe(201);

    const before = await spread(p.company_uid, p.warehouse_code, p.item_code, p.batch_number);
    expect(before.get(p.held_loc)).toBeGreaterThanOrEqual(4);

    const income = await api('/api/v1/warehouse/moves', {
      method: 'POST',
      headers: json(keeper.token),
      body: JSON.stringify({
        companyUid: p.company_uid,
        operationType: 'receipt',
        itemCode: p.item_code,
        batchNumber: p.batch_number,
        qty: '3',
        toWarehouseCode: p.warehouse_code,
        toLocationCode: p.free_loc,
        unitCost: '1000',
      }),
    });
    expect(income.status).toBe(201);

    const after = await spread(p.company_uid, p.warehouse_code, p.item_code, p.batch_number);
    // Полка прихода получила товар, но не обещание.
    expect(after.get(p.free_loc)).toBe(0);
    // На прежней полке обещанное осталось прежним.
    expect(after.get(p.held_loc)).toBeCloseTo(before.get(p.held_loc)!, 6);

    // Раз обещание не переехало, приход свободен и отменяется.
    const back = await api(`/api/v1/warehouse/moves/${income.body.data.uid}/reverse`, {
      method: 'POST',
      headers: json(keeper.token),
      body: JSON.stringify({ comment: 'уборка после проверки резерва' }),
    });
    expect(back.status).toBe(201);

    expect((await release(keeper.token, held.body.data.uid)).status).toBe(200);
  });
});
