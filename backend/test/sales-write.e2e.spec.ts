/**
 * Заказ, смена статуса и ТТН: приложение целиком, живая база.
 *
 * Главное здесь — что ТТН не «отмечает» заказ отгруженным, а действительно
 * снимает товар со склада: остаток уменьшается ровно на отгруженное, в журнале
 * появляется движение со ссылкой на накладную, и складской экран это движение
 * сторнировать не даёт. Второе главное — что заказ нельзя отгрузить из
 * черновика, отгрузить больше обещанного и отгрузить дважды одной отправкой
 * формы.
 *
 * Прибираемся возвратным приходом, а не удалением. На `stock_move` стоит
 * триггер `stock_move_append_only`: UPDATE и DELETE по журналу запрещены на
 * уровне базы для всех, включая владельца, — значит отгрузку нельзя «отменить»
 * стиранием следа. Поэтому прогон возвращает товар обычным приходом, а сами
 * документы (заказ и ТТН) в базе остаются с пометкой в комментарии: это
 * настоящие документы, и делать вид, что их не было, учёт не позволяет.
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
import { SalesModule } from '../src/sales/sales.module.js';
import { WarehouseModule } from '../src/warehouse/warehouse.module.js';
import { ContextMiddleware } from '../src/common/context.middleware.js';
import { EnvelopeInterceptor } from '../src/common/envelope.interceptor.js';
import { ErrorFilter } from '../src/common/error.filter.js';

let app: INestApplication;
let base: string;
let db: Client;

const PASSWORD = process.env.SEED_PASSWORD ?? 'metall-dev-2026';
const RUN = Date.now().toString(36).toUpperCase();

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
  return res.body.data as { token: string; permissions: string[]; companies: { uid: string }[] };
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const json = (token: string) => ({ ...auth(token), 'Content-Type': 'application/json' });

/** Менеджер: заказ и ТТН. Директор: ещё и отмена. Кладовщик: продажи только смотрит. */
let seller: Awaited<ReturnType<typeof login>>;
let director: Awaited<ReturnType<typeof login>>;
let keeper: Awaited<ReturnType<typeof login>>;

/** Компания, покупатель и позиция с живым остатком: её и продаём. */
let company: { uid: string };
let partnerUid: string;
let goods: {
  code: string;
  batch: string | null;
  unitCost: string;
  warehouse: string;
  onHand: number;
};

/** Что вернуть на склад после прогона: отгруженное возвращаем приходом. */
const restore: {
  warehouse: string;
  item: string;
  batch: string | null;
  qty: string;
  cost: string;
}[] = [];

/** Остаток по строке «склад + номенклатура + партия». */
async function balance(warehouseCode: string, itemCode: string, batchNumber: string | null) {
  const r = await db.query<{ qty: string }>(
    // Склад целиком, по всем ячейкам: ТТН выбирает ячейку сама, и проверка
    // «сколько уехало со склада» не должна зависеть от того, какую она выбрала.
    `SELECT coalesce(sum(sb.qty_on_hand), 0)::text AS qty
       FROM warehouse w
       JOIN company c ON c.id = w.company_id
       JOIN item i ON i.company_id = c.id AND i.code = $3
       LEFT JOIN batch b ON b.company_id = c.id AND b.item_id = i.id AND b.number = $4
       LEFT JOIN stock_balance sb
         ON sb.company_id = c.id AND sb.warehouse_id = w.id AND sb.item_id = i.id
        AND sb.batch_id IS NOT DISTINCT FROM b.id
        AND sb.serial_id IS NULL
      WHERE c.uid = $1 AND w.code = $2`,
    [company.uid, warehouseCode, itemCode, batchNumber],
  );
  return Number(r.rows[0]?.qty ?? 0);
}

/** Заказ в базе: то, что на самом деле записано, а не то, что ответил ход. */
const orderRow = async (uid: string) =>
  (
    await db.query<{
      number: string;
      status: string;
      payment_status: string;
      shipment_status: string;
      amount_net: string;
      amount_vat: string;
      amount_total: string;
      cost_total: string;
      margin_total: string;
      manager: string | null;
      version: string;
      lines: string;
    }>(
      `SELECT o.number, o.status::text, o.payment_status::text, o.shipment_status::text,
              o.amount_net::text, o.amount_vat::text, o.amount_total::text,
              o.cost_total::text, o.margin_total::text, u.login AS manager,
              o.version::text, (SELECT count(*) FROM sales_order_line l
                                 WHERE l.sales_order_id = o.id)::text AS lines
         FROM sales_order o
         LEFT JOIN user_account u ON u.id = o.manager_id
        WHERE o.uid = $1`,
      [uid],
    )
  ).rows[0];

/** Тело заказа, от которого пляшут остальные проверки. */
const orderBody = (extra: Record<string, unknown> = {}) => ({
  companyUid: company.uid,
  partnerUid,
  warehouseCode: goods.warehouse,
  comment: `проверка ${RUN}`,
  // Цену не называем: с ТЗ 9.2 её ставит прайс, а своя цифра здесь была бы
  // «ручной ценой» — для неё нужно право `sales.price` и основание. Там, где
  // проверяется именно арифметика, цена задаётся явно и осознанно.
  lines: [{ itemCode: goods.code, qty: '2' }],
  ...extra,
});

async function createOrder(token = seller.token, body: Record<string, unknown> = orderBody()) {
  return api('/api/v1/sales/orders', {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify(body),
  });
}

async function setStatus(token: string, uid: string, status: string, comment?: string) {
  return api(`/api/v1/sales/orders/${uid}/status`, {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify({ status, ...(comment ? { comment } : {}) }),
  });
}

async function ship(token: string, uid: string, body: Record<string, unknown>, key?: string) {
  const res = await api(`/api/v1/sales/orders/${uid}/shipments`, {
    method: 'POST',
    headers: { ...json(token), ...(key ? { 'Idempotency-Key': key } : {}) },
    body: JSON.stringify(body),
  });
  if (res.status === 201) {
    for (const line of (body.lines as { qty: string }[]) ?? []) {
      restore.push({
        warehouse: goods.warehouse,
        item: goods.code,
        batch: goods.batch,
        qty: line.qty,
        cost: goods.unitCost,
      });
    }
  }
  return res;
}

/** Строка спецификации: её uid нужен ТТН. */
const lineUid = async (orderUid: string) =>
  (
    await db.query<{ uid: string }>(
      `SELECT l.uid FROM sales_order_line l
         JOIN sales_order o ON o.id = l.sales_order_id
        WHERE o.uid = $1 ORDER BY l.seq LIMIT 1`,
      [orderUid],
    )
  ).rows[0].uid;

/** Подтверждённый заказ: почти каждой проверке ТТН нужен именно такой. */
async function confirmedOrder(body?: Record<string, unknown>) {
  const made = await createOrder(seller.token, body ?? orderBody());
  expect(made.status).toBe(201);
  const uid = made.body.data.uid as string;
  expect((await setStatus(seller.token, uid, 'confirmed')).status).toBe(201);
  return { uid, lineUid: await lineUid(uid) };
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

  seller = await login('d.karimov');
  director = await login('s.radjabov');
  keeper = await login('a.saidov');

  // Позицию берём не наугад: нужна продаваемая номенклатура с живым остатком,
  // иначе ТТН упрётся в «недостаточно товара» и проверит не то, что нужно.
  const row = await db.query<{
    company_uid: string;
    item_code: string;
    batch_number: string | null;
    unit_cost: string;
    warehouse_code: string;
    qty: string;
  }>(
    `SELECT c.uid AS company_uid, i.code AS item_code, b.number AS batch_number,
            sb.unit_cost::text AS unit_cost, w.code AS warehouse_code,
            sb.qty_available::text AS qty
       FROM stock_balance sb
       JOIN company c ON c.id = sb.company_id
       JOIN warehouse w ON w.id = sb.warehouse_id
       JOIN item i ON i.id = sb.item_id
       LEFT JOIN batch b ON b.id = sb.batch_id
      WHERE sb.serial_id IS NULL
        AND sb.qty_available > 20 AND i.is_active AND w.is_active
        AND i.item_type::text IN ('goods', 'finished')
        AND (i.track_batches = false OR b.id IS NOT NULL)
        AND c.uid = ANY($1::uuid[])
      ORDER BY sb.qty_available DESC
      LIMIT 1`,
    [seller.companies.map((c) => c.uid)],
  );
  const r = row.rows[0];
  if (!r) throw new Error('в базе нет продаваемой позиции с остатком: проверять нечего');

  company = { uid: r.company_uid };
  goods = {
    code: r.item_code,
    batch: r.batch_number,
    unitCost: r.unit_cost,
    warehouse: r.warehouse_code,
    onHand: Number(r.qty),
  };

  const partner = await db.query<{ uid: string }>(
    `SELECT p.uid FROM partner p JOIN company c ON c.id = p.company_id
      WHERE c.uid = $1 AND p.is_active AND p.is_client ORDER BY p.id LIMIT 1`,
    [company.uid],
  );
  if (!partner.rows[0]) throw new Error('в компании нет покупателя: заказ не на кого выписать');
  partnerUid = partner.rows[0].uid;
}, 60_000);

afterAll(async () => {
  // Возвращаем товар приходом: журнал не стирается, поэтому остаток должен
  // сойтись не удалением следа, а обратной операцией.
  for (const back of restore) {
    await api('/api/v1/warehouse/moves', {
      method: 'POST',
      headers: json(keeper.token),
      body: JSON.stringify({
        companyUid: company.uid,
        operationType: 'receipt',
        itemCode: back.item,
        ...(back.batch ? { batchNumber: back.batch } : {}),
        qty: back.qty,
        toWarehouseCode: back.warehouse,
        unitCost: back.cost,
        comment: `возврат после проверки ${RUN}`,
      }),
    });
  }
  await app?.close();
  await db?.end();
});

describe('GET /sales/refs', () => {
  it('отдаёт справочники формы заказа: компании, покупатели, номенклатура, склады', async () => {
    const res = await api('/api/v1/sales/refs', { headers: auth(seller.token) });

    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.companies.length).toBeGreaterThan(0);
    expect(d.partners.length).toBeGreaterThan(0);
    expect(d.items.length).toBeGreaterThan(0);
    expect(d.warehouses.length).toBeGreaterThan(0);
    // Единица подписывает поле количества, признак партий решает, спрашивать ли
    // партию в ТТН, ставка НДС и последняя цена подставляются в строку заказа.
    expect(d.items[0]).toHaveProperty('unit');
    expect(d.items[0]).toHaveProperty('trackBatches');
    expect(d.items[0]).toHaveProperty('vatRate');
    expect(d.items[0]).toHaveProperty('lastPrice');
  });

  it('в номенклатуре продаж нет сырья и полуфабрикатов', async () => {
    const res = await api('/api/v1/sales/refs', { headers: auth(seller.token) });
    const codes = (res.body.data.items as { code: string }[]).map((i) => i.code);

    const wrong = await db.query<{ code: string }>(
      `SELECT i.code FROM item i JOIN company c ON c.id = i.company_id
        WHERE c.uid = $1 AND i.item_type::text IN ('raw', 'semi', 'component')
        LIMIT 20`,
      [company.uid],
    );
    for (const w of wrong.rows) expect(codes).not.toContain(w.code);
  });
});

describe('POST /sales/orders', () => {
  it('заводит заказ с номером компании и считает суммы сам', async () => {
    // Цена задана явно — здесь проверяется арифметика, и она должна быть
    // предсказуемой. Поэтому идём директором (у него есть право на ручную
    // цену), пишем основание и берём цену заведомо выше себестоимости: иначе
    // сработает запрет продавать в убыток (ТЗ 9.2), и проверка упрётся в него.
    const price = Math.round(Number(goods.unitCost) * 3);
    const res = await createOrder(
      director.token,
      orderBody({
        lines: [
          {
            itemCode: goods.code,
            qty: '3',
            price: String(price),
            discountPercent: '10',
            vatRate: '12',
            priceComment: `проверка арифметики ${RUN}`,
          },
        ],
      }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const row = await orderRow(res.body.data.uid);
    expect(row.number).toMatch(/^[А-Я]{2,3}-\d{5}$/);
    expect(row.status).toBe('draft');
    expect(row.shipment_status).toBe('none');
    expect(row.lines).toBe('1');
    const net = 3 * price * 0.9;
    expect(Number(row.amount_net)).toBeCloseTo(net, 2);
    expect(Number(row.amount_vat)).toBeCloseTo(net * 0.12, 2);
    expect(Number(row.amount_total)).toBeCloseTo(net * 1.12, 2);
    // Менеджер заказа — тот, кто его выписал: иначе спрашивать за заказ некого.
    expect(row.manager).toBe('s.radjabov');
  });

  it('суммы считает сервер, а не форма: присланные поля не принимаются', async () => {
    const res = await createOrder(
      seller.token,
      orderBody({ amountTotal: '1', amountNet: '1' }) as Record<string, unknown>,
    );

    expect(res.status).toBe(400);
  });

  it('без ставки НДС берёт ставку номенклатуры', async () => {
    const res = await createOrder(
      seller.token,
      orderBody({ lines: [{ itemCode: goods.code, qty: '1' }] }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const vat = await db.query<{ item_rate: string; line_rate: string }>(
      `SELECT i.vat_rate::text AS item_rate, l.vat_rate::text AS line_rate
         FROM sales_order_line l
         JOIN sales_order o ON o.id = l.sales_order_id
         JOIN item i ON i.id = l.item_id
        WHERE o.uid = $1`,
      [res.body.data.uid],
    );
    expect(Number(vat.rows[0].line_rate)).toBeCloseTo(Number(vat.rows[0].item_rate), 4);
  });

  it('заказ без строк не принимает', async () => {
    const res = await createOrder(seller.token, orderBody({ lines: [] }));
    expect(res.status).toBe(400);
  });

  it('не продаёт сырьё', async () => {
    const raw = await db.query<{ code: string }>(
      `SELECT i.code FROM item i JOIN company c ON c.id = i.company_id
        WHERE c.uid = $1 AND i.item_type::text = 'raw' AND i.is_active LIMIT 1`,
      [company.uid],
    );
    if (raw.rowCount === 0) return;

    const res = await createOrder(
      seller.token,
      orderBody({ lines: [{ itemCode: raw.rows[0].code, qty: '1' }] }),
    );
    expect(res.status).toBe(422);
    expect(String(res.body.error.message)).toContain('не продаётся');
  });

  it('дата поставки раньше даты заказа не принимается', async () => {
    const res = await createOrder(
      seller.token,
      orderBody({ orderDate: '2026-09-20', deliveryDate: '2026-09-19' }),
    );
    expect(res.status).toBe(422);
    expect(String(res.body.error.message)).toContain('раньше даты заказа');
  });

  it('кладовщику заказ выписать нельзя: нет права sales.edit', async () => {
    const res = await createOrder(keeper.token, orderBody());
    expect(res.status).toBe(403);
    expect(String(res.body.error.message)).toContain('sales.edit');
  });

  it('без токена не принимает ничего', async () => {
    const res = await api('/api/v1/sales/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(orderBody()),
    });
    expect(res.status).toBe(401);
  });
});

describe('POST /sales/orders/{uid}/status', () => {
  it('черновик подтверждается, и версия заказа растёт', async () => {
    const made = await createOrder();
    const uid = made.body.data.uid as string;
    const before = await orderRow(uid);

    const res = await setStatus(seller.token, uid, 'confirmed', 'подтверждено проверкой');

    expect(res.status).toBe(201);
    const after = await orderRow(uid);
    expect(after.status).toBe('confirmed');
    expect(Number(after.version)).toBe(Number(before.version) + 1);
  });

  /**
   * Журнал действий (ТЗ 3.4). Переход статуса не писался никуда: на вопрос
   * «кто подтвердил заказ» и «кто его отменил» ответа в системе не было, хотя
   * подтверждение — это обещание клиенту.
   */
  it('подтверждение остаётся в журнале: кто, когда и из какого статуса', async () => {
    const made = await createOrder();
    const uid = made.body.data.uid as string;
    expect((await setStatus(seller.token, uid, 'confirmed')).status).toBe(201);

    const log = await db.query<{ action: string; user_id: string; changes: any }>(
      `SELECT action, user_id::text, changes FROM audit_log
        WHERE entity_type = 'sales_order' AND entity_id = $1 AND action = 'status'`,
      [uid],
    );
    expect(log.rowCount, 'смена статуса не попала в журнал').toBe(1);
    const row = log.rows[0]!;
    expect(row.changes.status, 'в журнале не видно, откуда и куда').toEqual({
      from: 'draft',
      to: 'confirmed',
    });
    expect(row.user_id, 'в журнале не записан человек').not.toBeNull();
  });

  it('повторное подтверждение — 409, а не молчаливое согласие', async () => {
    const { uid } = await confirmedOrder();
    const res = await setStatus(seller.token, uid, 'confirmed');
    expect(res.status).toBe(409);
    expect(String(res.body.error.message)).toContain('уже в статусе');
  });

  it('в «отгружен» кнопкой не переводит: это дело ТТН', async () => {
    const { uid } = await confirmedOrder();
    const res = await setStatus(seller.token, uid, 'shipped');
    expect(res.status).toBe(409);
    expect(String(res.body.error.message)).toContain('ТТН');
    expect((await orderRow(uid)).status).toBe('confirmed');
  });

  it('из черновика в производство не прыгает: сначала подтверждение', async () => {
    const made = await createOrder();
    const res = await setStatus(seller.token, made.body.data.uid, 'in_production');
    expect(res.status).toBe(409);
  });

  it('менеджеру отменять нельзя, директору можно', async () => {
    const made = await createOrder();
    const uid = made.body.data.uid as string;

    const denied = await setStatus(seller.token, uid, 'cancelled');
    expect(denied.status).toBe(403);
    expect(String(denied.body.error.message)).toContain('sales.delete');
    expect((await orderRow(uid)).status).toBe('draft');

    const allowed = await setStatus(director.token, uid, 'cancelled', 'отмена проверкой');
    expect(allowed.status).toBe(201);
    expect((await orderRow(uid)).status).toBe('cancelled');
  });

  it('отменённый заказ никуда больше не переводится', async () => {
    const made = await createOrder();
    const uid = made.body.data.uid as string;
    expect((await setStatus(director.token, uid, 'cancelled')).status).toBe(201);

    const res = await setStatus(seller.token, uid, 'confirmed');
    expect(res.status).toBe(409);
  });

  it('несуществующий заказ — 404', async () => {
    const res = await setStatus(seller.token, '01a0d83b-0000-7000-8000-000000000000', 'confirmed');
    expect(res.status).toBe(404);
  });
});

describe('GET /sales/orders/{uid}/availability', () => {
  it('показывает обещанное, отгруженное и то, что есть на складе', async () => {
    const { uid } = await confirmedOrder();
    const res = await api(`/api/v1/sales/orders/${uid}/availability`, {
      headers: auth(seller.token),
    });

    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.canShip).toBe(true);
    expect(d.lines).toHaveLength(1);
    const line = d.lines[0];
    expect(Number(line.qty)).toBeCloseTo(2, 6);
    expect(Number(line.shippedQty)).toBeCloseTo(0, 6);
    expect(Number(line.remainingQty)).toBeCloseTo(2, 6);
    expect(Number(line.availableQty)).toBeGreaterThan(0);
    expect(line.warehouseCode).toBe(goods.warehouse);
    // Партии отдаём списком: по партионной номенклатуре кладовщик выбирает из
    // того, что лежит, а не вспоминает номер.
    if (line.trackBatches) expect(line.batches.length).toBeGreaterThan(0);
  });
});

describe('POST /sales/orders/{uid}/shipments', () => {
  it('из черновика не отгружает', async () => {
    const made = await createOrder();
    const uid = made.body.data.uid as string;

    const res = await ship(seller.token, uid, {
      lines: [
        {
          lineUid: await lineUid(uid),
          qty: '1',
          ...(goods.batch ? { batchNumber: goods.batch } : {}),
        },
      ],
    });

    expect(res.status).toBe(409);
    expect(String(res.body.error.message)).toContain('подтвердите заказ');
  });

  it('отгружает полностью: остаток уменьшается, заказ становится отгруженным', async () => {
    const { uid, lineUid: line } = await confirmedOrder();
    const before = await balance(goods.warehouse, goods.code, goods.batch);

    const res = await ship(seller.token, uid, {
      vehicle: 'Isuzu 01 A 777 AA',
      driver: 'Проверка Прогонов',
      netWeightT: '2',
      grossWeightT: '2.5',
      lines: [{ lineUid: line, qty: '2', ...(goods.batch ? { batchNumber: goods.batch } : {}) }],
    });

    expect(res.status).toBe(201);
    expect(res.body.data.number).toMatch(/^ТТН-[А-Я]{2,3}-\d{5}$/);
    expect(res.body.data.shipmentStatus).toBe('full');
    expect(res.body.data.orderStatus).toBe('shipped');

    // Остаток — главное: ТТН не отметка в карточке, а расход со склада.
    expect(await balance(goods.warehouse, goods.code, goods.batch)).toBeCloseTo(before - 2, 6);

    const row = await orderRow(uid);
    expect(row.status).toBe('shipped');
    expect(row.shipment_status).toBe('full');
    // Себестоимость известна только после отгрузки — по тем партиям, что уехали.
    expect(Number(row.cost_total)).toBeCloseTo(2 * Number(goods.unitCost), 2);
    expect(Number(row.margin_total)).toBeCloseTo(
      Number(row.amount_net) - Number(row.cost_total),
      2,
    );

    // Журнал действий: отгрузки в нём не было вовсе — ТТН лежала в своей
    // таблице, а по заказу не оставалось строки о том, кто его отгрузил.
    const shipLog = await db.query<{ changes: any; user_id: string }>(
      `SELECT changes, user_id::text FROM audit_log
        WHERE entity_type = 'sales_order' AND entity_id = $1 AND action = 'ship'`,
      [uid],
    );
    expect(shipLog.rowCount, 'отгрузка не попала в журнал действий').toBe(1);
    expect(shipLog.rows[0]!.changes.shipment_status).toEqual({ from: 'none', to: 'full' });
    expect(shipLog.rows[0]!.user_id, 'в журнале не записан тот, кто отгрузил').not.toBeNull();

    // След в журнале: движение отгрузки со ссылкой на накладную.
    const move = await db.query<{
      operation_type: string;
      qty: string;
      source_doc_type: string;
      from_code: string;
      partner_uid: string;
      move_uid: string;
    }>(
      `SELECT m.operation_type::text, m.qty::text, m.source_doc_type,
              w.code AS from_code, p.uid AS partner_uid, m.uid AS move_uid
         FROM stock_move m
         JOIN shipment s ON s.id = m.source_doc_id AND m.source_doc_type = 'shipment'
         JOIN warehouse w ON w.id = m.from_warehouse_id
         JOIN partner p ON p.id = m.partner_id
        WHERE s.uid = $1`,
      [res.body.data.uid],
    );
    expect(move.rowCount).toBe(1);
    expect(move.rows[0].operation_type).toBe('shipment');
    expect(Number(move.rows[0].qty)).toBeCloseTo(2, 6);
    expect(move.rows[0].from_code).toBe(goods.warehouse);
    expect(move.rows[0].partner_uid).toBe(partnerUid);

    // И это движение складской экран сторнировать не даёт: отменяют документ.
    const undo = await api(`/api/v1/warehouse/moves/${move.rows[0].move_uid}/reverse`, {
      method: 'POST',
      headers: json(keeper.token),
      body: JSON.stringify({ comment: 'проверка запрета' }),
    });
    expect(undo.status).toBe(409);
    expect(String(undo.body.error.message)).toContain('документу');
  });

  it('отгрузка съедает резерв под строку заказа: частичная — уменьшает, полная — снимает', async () => {
    const { uid, lineUid: line } = await confirmedOrder();
    const number = (await orderRow(uid)).number;

    /** Обещанное по этой партии: свёртка активных резервов. */
    const promised = async () =>
      Number(
        (
          await db.query<{ qty: string }>(
            `SELECT coalesce(sum(r.qty), 0)::text AS qty
               FROM stock_reservation r
               JOIN company c ON c.id = r.company_id
               JOIN item i ON i.id = r.item_id
               LEFT JOIN batch b ON b.id = r.batch_id
              WHERE c.uid = $1 AND i.code = $2 AND b.number IS NOT DISTINCT FROM $3
                AND r.status = 'active'`,
            [company.uid, goods.code, goods.batch],
          )
        ).rows[0].qty,
      );

    const before = await promised();
    const put = await api('/api/v1/warehouse/reservations', {
      method: 'POST',
      headers: json(keeper.token),
      body: JSON.stringify({
        companyUid: company.uid,
        itemCode: goods.code,
        ...(goods.batch ? { batchNumber: goods.batch } : {}),
        warehouseCode: goods.warehouse,
        qty: '2',
        salesOrderNumber: number,
      }),
    });
    expect(put.status).toBe(201);
    expect(await promised()).toBeCloseTo(before + 2, 6);

    // Отгрузили половину — держать под заказом надо только остаток.
    expect(
      (
        await ship(seller.token, uid, {
          lines: [
            { lineUid: line, qty: '1', ...(goods.batch ? { batchNumber: goods.batch } : {}) },
          ],
        })
      ).status,
    ).toBe(201);
    expect(await promised()).toBeCloseTo(before + 1, 6);

    // Отгрузили остальное — обещать нечего, резерв снят целиком. Иначе
    // отгруженный заказ продолжал бы держать чужой товар: наличие уехало, а
    // обещанное осталось, и доступное просело бы навсегда.
    expect(
      (
        await ship(seller.token, uid, {
          lines: [
            { lineUid: line, qty: '1', ...(goods.batch ? { batchNumber: goods.batch } : {}) },
          ],
        })
      ).status,
    ).toBe(201);
    expect(await promised()).toBeCloseTo(before, 6);
    const left = await db.query<{ status: string }>(
      `SELECT status::text AS status FROM stock_reservation WHERE uid = $1`,
      [put.body.data.uid],
    );
    expect(left.rows[0].status).toBe('released');
  });

  it('частичная отгрузка оставляет заказ в сборке', async () => {
    const { uid, lineUid: line } = await confirmedOrder();

    const res = await ship(seller.token, uid, {
      lines: [{ lineUid: line, qty: '1', ...(goods.batch ? { batchNumber: goods.batch } : {}) }],
    });

    expect(res.status).toBe(201);
    expect(res.body.data.shipmentStatus).toBe('partial');
    const row = await orderRow(uid);
    expect(row.status).toBe('picking');
    expect(row.shipment_status).toBe('partial');

    // Остаток по заказу виден снаружи: вторую ТТН выписывают по нему.
    const left = await api(`/api/v1/sales/orders/${uid}/availability`, {
      headers: auth(seller.token),
    });
    expect(Number(left.body.data.lines[0].shippedQty)).toBeCloseTo(1, 6);
    expect(Number(left.body.data.lines[0].remainingQty)).toBeCloseTo(1, 6);
  });

  it('больше обещанного не отгружает и называет остаток', async () => {
    const { uid, lineUid: line } = await confirmedOrder();
    const before = await balance(goods.warehouse, goods.code, goods.batch);

    const res = await ship(seller.token, uid, {
      lines: [{ lineUid: line, qty: '5', ...(goods.batch ? { batchNumber: goods.batch } : {}) }],
    });

    expect(res.status).toBe(422);
    expect(String(res.body.error.message)).toContain('осталось отгрузить');
    expect(String(res.body.error.message)).toContain('2.000000');
    // Отказ до записи: остаток не тронут.
    expect(await balance(goods.warehouse, goods.code, goods.batch)).toBeCloseTo(before, 6);
  });

  it('больше, чем лежит на складе, не отгружает', async () => {
    const huge = (goods.onHand + 1000).toFixed(0);
    const { uid, lineUid: line } = await confirmedOrder(
      orderBody({ lines: [{ itemCode: goods.code, qty: huge }] }),
    );

    const res = await ship(seller.token, uid, {
      lines: [{ lineUid: line, qty: huge, ...(goods.batch ? { batchNumber: goods.batch } : {}) }],
    });

    expect(res.status).toBe(422);
    expect(String(res.body.error.message)).toContain('Недостаточно товара');
    expect(String(res.body.error.message)).toContain(goods.code);
  });

  it('повтор с тем же ключом идемпотентности не отгружает второй раз', async () => {
    const { uid, lineUid: line } = await confirmedOrder();
    const key = `sales-write-${RUN}`;
    const body = {
      lines: [{ lineUid: line, qty: '1', ...(goods.batch ? { batchNumber: goods.batch } : {}) }],
    };

    const first = await ship(seller.token, uid, body, key);
    expect(first.status).toBe(201);
    const after = await balance(goods.warehouse, goods.code, goods.batch);

    const again = await api(`/api/v1/sales/orders/${uid}/shipments`, {
      method: 'POST',
      headers: { ...json(seller.token), 'Idempotency-Key': key },
      body: JSON.stringify(body),
    });

    expect(again.status).toBe(201);
    expect(again.body.data.uid).toBe(first.body.data.uid);
    expect(await balance(goods.warehouse, goods.code, goods.batch)).toBeCloseTo(after, 6);
  });

  it('чужую строку в накладную не берёт', async () => {
    const mine = await confirmedOrder();
    const other = await confirmedOrder();

    const res = await ship(seller.token, mine.uid, {
      lines: [
        { lineUid: other.lineUid, qty: '1', ...(goods.batch ? { batchNumber: goods.batch } : {}) },
      ],
    });

    expect(res.status).toBe(422);
    expect(String(res.body.error.message)).toContain('не из заказа');
  });

  it('по партионной номенклатуре требует партию', async () => {
    if (!goods.batch) return;
    const { uid, lineUid: line } = await confirmedOrder();

    const res = await ship(seller.token, uid, { lines: [{ lineUid: line, qty: '1' }] });

    expect(res.status).toBe(422);
    expect(String(res.body.error.message)).toContain('нужен номер партии');
  });

  it('кладовщику ТТН не выписать: нет права sales.edit', async () => {
    const { uid, lineUid: line } = await confirmedOrder();

    const res = await ship(keeper.token, uid, {
      lines: [{ lineUid: line, qty: '1', ...(goods.batch ? { batchNumber: goods.batch } : {}) }],
    });

    expect(res.status).toBe(403);
  });

  it('отгруженный заказ не отменяется', async () => {
    const { uid, lineUid: line } = await confirmedOrder();
    expect(
      (
        await ship(seller.token, uid, {
          lines: [
            { lineUid: line, qty: '1', ...(goods.batch ? { batchNumber: goods.batch } : {}) },
          ],
        })
      ).status,
    ).toBe(201);

    const res = await setStatus(director.token, uid, 'cancelled');
    expect(res.status).toBe(409);
    expect(String(res.body.error.message)).toContain('уже есть отгрузка');
  });
});
