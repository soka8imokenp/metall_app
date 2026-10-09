/**
 * Оплата по заказу: платёж, который закрывает долг покупателя (ТЗ 6.1, 9.3).
 *
 * Почему это отдельная проверка, а не часть `finance-write`. Вся дебиторка
 * системы считается одним выражением из `receivables.ts` — «отгружено минус
 * `sales_order.paid_amount`». Значит поле `paid_amount` не украшение карточки:
 * пока его никто не записывает, долг не уменьшается ни на экране продаж, ни в
 * списке должников, ни в сводке руководителя, сколько бы денег ни пришло.
 *
 * Отсюда и правила, которые проверяются ниже:
 * - платёж привязывается к заказу и попадает в оплаченное только проведённым:
 *   обещание заплатить — ещё не платёж;
 * - заплатить больше остатка нельзя, и занятым считается не только
 *   проведённое, но и то, что ждёт согласования: иначе два человека заведут
 *   по полному остатку каждый и заказ окажется оплачен дважды;
 * - сторно платежа возвращает оплаченное ровно к прежнему значению;
 * - корреспондент такого платежа — счёт расчётов с покупателями: деньги
 *   закрывают долг, а не создают доход второй раз.
 *
 * Всё, что тест завёл, он удаляет, а тронутые заказы возвращает как было:
 * заказы живые, их читают другие проверки.
 */
import 'dotenv/config';
import { Client } from 'pg';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { AuthGuard } from '../src/auth/auth.guard.js';
import { FinanceModule } from '../src/finance/finance.module.js';
import { ContextMiddleware } from '../src/common/context.middleware.js';
import { EnvelopeInterceptor } from '../src/common/envelope.interceptor.js';
import { ErrorFilter } from '../src/common/error.filter.js';

let app: INestApplication;
let base: string;
let db: Client;

const PASSWORD = process.env.SEED_PASSWORD ?? 'metall-dev-2026';

const created: string[] = [];

type Order = {
  uid: string;
  number: string;
  company_uid: string;
  company_code: string;
  total: string;
  paid: string;
  payment_status: string;
  version: number;
  partner_uid: string;
};

let orderA: Order;
let orderB: Order;

let bank: string;
let receivable: string;
let income: string;

/** Заказы, у которых тест двигал оплату: вернуть в исходное состояние. */
const touched: Order[] = [];

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
  return res.body.data as { token: string; permissions: string[]; companies: any[] };
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const json = (token: string) => ({ ...auth(token), 'Content-Type': 'application/json' });

const readOrder = async (uid: string) =>
  (
    await db.query<{ paid: string; payment_status: string; total: string }>(
      `SELECT paid_amount::text AS paid, payment_status::text, amount_total::text AS total
         FROM sales_order WHERE uid = $1`,
      [uid],
    )
  ).rows[0];

/**
 * Свободный остаток по данным базы: сумма заказа минус проведённое и минус то,
 * что уже заведено и ждёт решения. Именно его и проверяет служба, поэтому тест
 * считает его так же, а не «сумма минус оплачено».
 */
const remainingOf = async (uid: string) => {
  const r = await db.query<{ free: string }>(
    `SELECT (o.amount_total
            - coalesce(sum(f.amount) FILTER (WHERE f.status = 'posted'), 0)
            - coalesce(sum(f.amount) FILTER (
                WHERE f.status IN ('draft', 'pending_approval', 'approved')), 0))::text AS free
       FROM sales_order o
       LEFT JOIN finance_operation f
              ON f.source_doc_type = 'sales_order' AND f.source_doc_id = o.id
             AND f.operation_type = 'income'
      WHERE o.uid = $1
      GROUP BY o.amount_total`,
    [uid],
  );
  return Number(r.rows[0].free);
};

const money = (value: number) => value.toFixed(2);

async function pay(
  token: string,
  order: Order,
  amount: string,
  extra: Record<string, unknown> = {},
) {
  const res = await api('/api/v1/finance/operations', {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify({
      companyUid: order.company_uid,
      operationType: 'income',
      accountCode: bank,
      counterAccountCode: receivable,
      amount,
      currencyCode: 'UZS',
      salesOrderUid: order.uid,
      comment: `Оплата по заказу ${order.number}`,
      ...extra,
    }),
  });
  if (res.status === 201 && res.body?.data?.uid && !created.includes(res.body.data.uid)) {
    created.push(res.body.data.uid);
  }
  return res;
}

/** Черновик → согласование → проведение. Возвращает версию после проведения. */
async function post(token: string, uid: string) {
  const step = (action: string, version: number) =>
    api(`/api/v1/finance/operations/${uid}/${action}`, {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ version }),
    });
  expect((await step('submit', 1)).status).toBe(201);
  expect((await step('approve', 2)).status).toBe(201);
  expect((await step('post', 3)).status).toBe(201);
  return 4;
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [PrismaModule, AuthModule, FinanceModule],
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

  const orders = await db.query<Order>(
    `SELECT o.uid, o.number, c.uid AS company_uid, c.code AS company_code,
            o.amount_total::text AS total, o.paid_amount::text AS paid,
            o.payment_status::text, o.version, p.uid AS partner_uid
       FROM sales_order o
       JOIN company c ON c.id = o.company_id
       JOIN currency cur ON cur.id = o.currency_id
       JOIN partner p ON p.id = o.partner_id
      WHERE o.status <> 'cancelled' AND cur.code = 'UZS'
        AND o.amount_total > 0 AND o.paid_amount < o.amount_total
      ORDER BY o.amount_total DESC
      LIMIT 2`,
  );
  expect(orders.rows.length, 'в базе нужны два неоплаченных заказа').toBe(2);
  orderA = orders.rows[0];
  orderB = orders.rows[1];
  touched.push(orderA, orderB);

  const accs = await db.query<{ code: string; kind: string }>(
    `SELECT a.code, a.kind::text AS kind
       FROM account a JOIN company c ON c.id = a.company_id
      WHERE c.uid = $1 AND a.is_active
      ORDER BY a.code`,
    [orderA.company_uid],
  );
  bank = accs.rows.find((a) => a.kind === 'bank')!.code;
  receivable = accs.rows.find((a) => a.kind === 'receivable')!.code;
  income = accs.rows.find((a) => a.kind === 'income')!.code;
}, 60_000);

afterAll(async () => {
  for (const uid of created) {
    await db.query(
      `DELETE FROM finance_entry
        WHERE operation_id = (SELECT id FROM finance_operation WHERE uid = $1)`,
      [uid],
    );
  }
  for (const uid of [...created].reverse()) {
    await db.query(`DELETE FROM finance_operation WHERE uid = $1`, [uid]);
  }
  for (const o of touched) {
    await db.query(
      `UPDATE sales_order
          SET paid_amount = $2::numeric, payment_status = $3::"PaymentStatus", version = $4
        WHERE uid = $1`,
      [o.uid, o.paid, o.payment_status, o.version],
    );
  }
  await app?.close();
  await db?.end();
});

describe('платёж по заказу', () => {
  it('до проведения оплаченное не меняется, но остаток уже занят', async () => {
    const me = await login('s.radjabov');
    const before = await readOrder(orderA.uid);
    const freeBefore = await remainingOf(orderA.uid);
    const part = Math.round(Number(before.total) / 10);

    const res = await pay(me.token, orderA, money(part));
    expect(res.status).toBe(201);

    // Заявка на деньги — ещё не деньги. Пока её не провели, долг прежний.
    const after = await readOrder(orderA.uid);
    expect(Number(after.paid)).toBeCloseTo(Number(before.paid), 2);
    expect(after.payment_status).toBe(before.payment_status);
    // А место под неё уже занято: вторую такую же заводить нельзя.
    expect(await remainingOf(orderA.uid)).toBeCloseTo(freeBefore - part, 2);

    // Отклонённая заявка остаток отпускает: деньги по ней не придут.
    const uid = res.body.data.uid;
    const step = (action: string, version: number) =>
      api(`/api/v1/finance/operations/${uid}/${action}`, {
        method: 'POST',
        headers: json(me.token),
        body: JSON.stringify({ version, comment: 'Платёж не подтвердился' }),
      });
    expect((await step('submit', 1)).status).toBe(201);
    expect((await step('reject', 2)).status).toBe(201);
    expect(await remainingOf(orderA.uid)).toBeCloseTo(freeBefore, 2);
  });

  it('проведение увеличивает оплаченное и уменьшает долг клиента', async () => {
    const me = await login('s.radjabov');
    const before = await readOrder(orderA.uid);
    const debtBefore = await api(`/api/v1/finance/receivables?limit=200`, {
      headers: auth(me.token),
    });
    const mine = (rows: any[]) => rows.find((r) => r.partner.uid === orderA.partner_uid);
    const was = Number(mine(debtBefore.body.data.rows)?.debt ?? 0);

    const part = Math.round(Number(before.total) / 10);
    const op = await pay(me.token, orderA, money(part));
    expect(op.status).toBe(201);
    await post(me.token, op.body.data.uid);

    const after = await readOrder(orderA.uid);
    expect(Number(after.paid)).toBeCloseTo(Number(before.paid) + part, 2);
    expect(after.payment_status).toBe('partial');

    // Тот же платёж обязан быть виден и в долге: дебиторка считается из этого
    // поля, и расхождение здесь означало бы два ответа на вопрос «сколько должен».
    const debtAfter = await api(`/api/v1/finance/receivables?limit=200`, {
      headers: auth(me.token),
    });
    const now = Number(mine(debtAfter.body.data.rows)?.debt ?? 0);
    expect(now).toBeCloseTo(was - part, 2);
  });

  it('оплата остатка закрывает заказ по деньгам', async () => {
    const me = await login('s.radjabov');
    const rest = await remainingOf(orderA.uid);
    expect(rest).toBeGreaterThan(0);

    const op = await pay(me.token, orderA, money(rest));
    expect(op.status).toBe(201);
    await post(me.token, op.body.data.uid);

    const after = await readOrder(orderA.uid);
    expect(Number(after.paid)).toBeCloseTo(Number(after.total), 2);
    expect(after.payment_status).toBe('paid');
  });

  it('сторно платежа возвращает оплаченное к прежнему значению', async () => {
    const me = await login('s.radjabov');
    const before = await readOrder(orderA.uid);

    const op = await db.query<{ uid: string; version: number; amount: string }>(
      `SELECT uid, version, amount::text FROM finance_operation
        WHERE uid = ANY($1::uuid[]) AND status = 'posted'
        ORDER BY id DESC LIMIT 1`,
      [created],
    );
    const target = op.rows[0];

    const rev = await api(`/api/v1/finance/operations/${target.uid}/reverse`, {
      method: 'POST',
      headers: json(me.token),
      body: JSON.stringify({ version: target.version, comment: 'Деньги не пришли' }),
    });
    expect(rev.status).toBe(201);
    created.push(rev.body.data.uid);

    const after = await readOrder(orderA.uid);
    expect(Number(after.paid)).toBeCloseTo(Number(before.paid) - Number(target.amount), 2);
    expect(after.payment_status).toBe('partial');
  });

  it('заплатить больше остатка нельзя', async () => {
    const me = await login('s.radjabov');
    const before = await readOrder(orderB.uid);
    const rest = Number(before.total) - Number(before.paid);

    const res = await pay(me.token, orderB, money(rest + 1000));

    expect(res.status).toBe(422);
    // Отказ человеку должен называть остаток: иначе он не знает, что написать.
    expect(JSON.stringify(res.body)).toMatch(/остат/i);
    const after = await readOrder(orderB.uid);
    expect(Number(after.paid)).toBeCloseTo(Number(before.paid), 2);
  });

  it('несогласованный платёж тоже занимает остаток', async () => {
    const me = await login('s.radjabov');
    const rest = await remainingOf(orderB.uid);

    const first = await pay(me.token, orderB, money(rest));
    expect(first.status).toBe(201);

    // Второй на весь остаток: по проведённому место свободно, но первый
    // платёж уже ждёт согласования, и вместе они дали бы двойную оплату.
    const second = await pay(me.token, orderB, money(rest));
    expect(second.status).toBe(422);
  });

  it('расход к заказу не привязывают', async () => {
    const me = await login('s.radjabov');
    const res = await pay(me.token, orderB, '1000.00', { operationType: 'expense' });
    expect(res.status).toBe(400);
  });

  it('платёж по заказу заводят в валюте заказа', async () => {
    const me = await login('s.radjabov');
    const res = await pay(me.token, orderB, '100.00', {
      currencyCode: 'USD',
      rate: '12600.00',
      accountCode: bank,
    });
    expect(res.status).toBe(422);
    // Отказ именно про валюту: без этой строки проверка проходила и тогда,
    // когда сверки с валютой заказа не было вовсе — отказывало что-то другое.
    expect(JSON.stringify(res.body)).toMatch(/валюте заказа/);
  });

  it('корреспондент платежа — счёт расчётов с покупателями', async () => {
    const me = await login('s.radjabov');
    const res = await pay(me.token, orderB, '1000.00', { counterAccountCode: income });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toMatch(/покупател/i);
  });

  it('к отменённому заказу платёж не привязывают', async () => {
    const me = await login('s.radjabov');
    // Заказ ищем здесь, а не в `beforeAll`: решение «выполнять или пропустить»
    // принимается на сборе проверок, когда база ещё не читалась, и такая
    // проверка молча не выполняется вовсе.
    /**
     * Отменённый заказ берём той же компании, в которой найдены счёта: счёт
     * живёт в своей компании, и платёж по чужому заказу служба отбила бы
     * раньше — отказом «счёт не найден», а не тем, что проверяется здесь.
     * Без условия по компании проверка зависела от того, чей отменённый заказ
     * окажется первым по номеру.
     */
    const dead = await db.query<{ uid: string; company_uid: string }>(
      `SELECT o.uid, c.uid AS company_uid
         FROM sales_order o JOIN company c ON c.id = o.company_id
        WHERE o.status = 'cancelled' AND c.uid = $1 ORDER BY o.id LIMIT 1`,
      [orderA.company_uid],
    );
    expect(dead.rows[0], 'в компании нужен отменённый заказ').toBeTruthy();

    const res = await api('/api/v1/finance/operations', {
      method: 'POST',
      headers: json(me.token),
      body: JSON.stringify({
        companyUid: dead.rows[0].company_uid,
        operationType: 'income',
        accountCode: bank,
        counterAccountCode: receivable,
        amount: '1000.00',
        currencyCode: 'UZS',
        salesOrderUid: dead.rows[0].uid,
      }),
    });
    expect(res.status).toBe(409);
    if (res.status === 201) created.push(res.body.data.uid);
  });
});
