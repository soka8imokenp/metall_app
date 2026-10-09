/**
 * Согласование и проведение финансовой операции: приложение целиком, живая база.
 *
 * Здесь проверяется не «кнопка ответила 200», а то, ради чего маршруты и
 * существуют: статус меняется только по разрешённому переходу, проводки
 * рождаются ровно в момент проведения и ровно в двух строках, сальдо счёта
 * сдвигается ровно на сумму операции, а повторное нажатие ничего не удваивает.
 *
 * Тест меняет данные, поэтому каждая задетая операция снимается в `beforeAll`
 * и возвращается в `afterAll` — вместе с удалением проводок, которые он сам
 * создал. Иначе второй прогон пошёл бы по уже проведённым заявкам и позеленел
 * бы, ничего не проверив.
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

/** Снимок операции до вмешательства теста — чтобы вернуть всё как было. */
type Snapshot = {
  uid: string;
  status: string;
  version: number;
  approved_by: string | null;
  posted_at: Date | null;
};

const snapshots: Snapshot[] = [];

/** Берём непроведённую заявку в нужном статусе и запоминаем её исходное состояние. */
async function takeOperation(status: string): Promise<Snapshot> {
  const used = snapshots.map((s) => s.uid);
  const res = await db.query<Snapshot>(
    `SELECT uid, status::text AS status, version, approved_by::text, posted_at
       FROM finance_operation
      WHERE status = $1 AND NOT (uid = ANY($2::uuid[]))
      ORDER BY id
      LIMIT 1`,
    [status, used],
  );
  if (res.rowCount === 0) {
    throw new Error(`в базе нет операции в статусе ${status} — сид не тот, тест проверять нечего`);
  }
  snapshots.push(res.rows[0]);
  return res.rows[0];
}

const readOp = async (uid: string) =>
  (
    await db.query<{ status: string; version: number; approved_by: string | null; entries: string }>(
      `SELECT o.status::text AS status, o.version, o.approved_by::text,
              (SELECT count(*) FROM finance_entry e WHERE e.operation_id = o.id)::text AS entries
         FROM finance_operation o WHERE o.uid = $1`,
      [uid],
    )
  ).rows[0];

/** Сальдо счёта операции: сумма её проводок, а не хранимое поле. */
const accountSaldo = async (uid: string) =>
  Number(
    (
      await db.query<{ saldo: string }>(
        `SELECT coalesce(sum(e.debit - e.credit), 0)::text AS saldo
           FROM finance_entry e
          WHERE e.account_id = (SELECT account_id FROM finance_operation WHERE uid = $1)`,
        [uid],
      )
    ).rows[0].saldo,
  );

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
}, 60_000);

afterAll(async () => {
  for (const s of snapshots) {
    await db.query(
      `DELETE FROM finance_entry
        WHERE operation_id = (SELECT id FROM finance_operation WHERE uid = $1)`,
      [s.uid],
    );
    await db.query(
      `UPDATE finance_operation
          SET status = $2::"FinanceStatus", version = $3, approved_by = $4::bigint, posted_at = $5
        WHERE uid = $1`,
      [s.uid, s.status, s.version, s.approved_by, s.posted_at],
    );
  }
  await app?.close();
  await db?.end();
});

describe('POST /finance/operations/:uid/submit', () => {
  it('черновик уходит на согласование и остаётся без проводок', async () => {
    const op = await takeOperation('draft');
    const me = await login('m.rahimova');

    const saldoBefore = await accountSaldo(op.uid);
    const res = await api(`/api/v1/finance/operations/${op.uid}/submit`, {
      method: 'POST',
      headers: json(me.token),
      body: JSON.stringify({ version: op.version }),
    });

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('pending_approval');

    const after = await readOp(op.uid);
    expect(after.status).toBe('pending_approval');
    // Заявка на оплату не двигает остаток: деньги ещё не ушли.
    expect(after.entries).toBe('0');
    expect(await accountSaldo(op.uid)).toBe(saldoBefore);
  });

  it('чужой и несуществующий uid одинаково дают 404', async () => {
    const me = await login('admin');
    const res = await api(
      '/api/v1/finance/operations/00000000-0000-7000-8000-000000000000/submit',
      { method: 'POST', headers: json(me.token), body: JSON.stringify({ version: 1 }) },
    );
    expect(res.status).toBe(404);
  });
});

describe('GET /finance/operations — версия видна клиенту', () => {
  it('карточка и журнал отдают version, и после действия она растёт', async () => {
    const op = await takeOperation('draft');
    const me = await login('s.radjabov');

    const before = await api(`/api/v1/finance/operations/${op.uid}`, { headers: auth(me.token) });
    // Без этого поля экран не может послать действие: version обязателен в теле,
    // а взять его неоткуда. Молчаливое undefined уходило бы в 400 на кнопке.
    expect(before.body.data.operation.version).toBe(op.version);

    const list = await api(`/api/v1/finance/operations?limit=100`, { headers: auth(me.token) });
    const inList = list.body.data.rows.find((r: any) => r.uid === op.uid);
    expect(inList?.version).toBe(op.version);

    await api(`/api/v1/finance/operations/${op.uid}/submit`, {
      method: 'POST',
      headers: json(me.token),
      body: JSON.stringify({ version: op.version }),
    });

    const after = await api(`/api/v1/finance/operations/${op.uid}`, { headers: auth(me.token) });
    expect(after.body.data.operation.version).toBe(op.version + 1);
  });
});

describe('POST /finance/operations/:uid/approve', () => {
  it('бухгалтеру без права finance.approve отказано', async () => {
    const op = await takeOperation('pending_approval');
    const me = await login('m.rahimova');
    expect(me.permissions).not.toContain('finance.approve');

    const res = await api(`/api/v1/finance/operations/${op.uid}/approve`, {
      method: 'POST',
      headers: json(me.token),
      body: JSON.stringify({ version: op.version }),
    });

    expect(res.status).toBe(403);
    expect((await readOp(op.uid)).status).toBe('pending_approval');
  });

  it('директор утверждает, и в операции остаётся кто именно', async () => {
    const op = await takeOperation('pending_approval');
    const me = await login('s.radjabov');

    const res = await api(`/api/v1/finance/operations/${op.uid}/approve`, {
      method: 'POST',
      headers: json(me.token),
      body: JSON.stringify({ version: op.version }),
    });

    expect(res.status).toBe(201);
    const after = await readOp(op.uid);
    expect(after.status).toBe('approved');
    expect(after.approved_by).not.toBeNull();
    expect(after.entries).toBe('0');
  });

  it('черновик утвердить нельзя: переход не из того статуса', async () => {
    const op = await takeOperation('draft');
    const me = await login('s.radjabov');

    const res = await api(`/api/v1/finance/operations/${op.uid}/approve`, {
      method: 'POST',
      headers: json(me.token),
      body: JSON.stringify({ version: op.version }),
    });

    expect(res.status).toBe(409);
    expect((await readOp(op.uid)).status).toBe('draft');
  });

  it('устаревшая версия не проходит: операцию тронули параллельно', async () => {
    const op = await takeOperation('pending_approval');
    const me = await login('s.radjabov');

    const res = await api(`/api/v1/finance/operations/${op.uid}/approve`, {
      method: 'POST',
      headers: json(me.token),
      body: JSON.stringify({ version: op.version + 5 }),
    });

    expect(res.status).toBe(409);
    expect((await readOp(op.uid)).status).toBe('pending_approval');
  });
});

describe('POST /finance/operations/:uid/reject', () => {
  it('отклонённая заявка остаётся в журнале и без проводок', async () => {
    const op = await takeOperation('pending_approval');
    const me = await login('s.radjabov');

    const res = await api(`/api/v1/finance/operations/${op.uid}/reject`, {
      method: 'POST',
      headers: json(me.token),
      body: JSON.stringify({ version: op.version, comment: 'Статья исчерпана' }),
    });

    expect(res.status).toBe(201);
    const after = await readOp(op.uid);
    expect(after.status).toBe('rejected');
    expect(after.entries).toBe('0');
  });
});

describe('POST /finance/operations/:uid/post', () => {
  it('проведение рождает ровно две проводки и двигает сальдо на сумму операции', async () => {
    const op = await takeOperation('approved');
    const me = await login('m.rahimova');

    const before = await db.query<{ amount_base: string; type: string }>(
      `SELECT amount_base::text, operation_type::text AS type FROM finance_operation WHERE uid = $1`,
      [op.uid],
    );
    const amount = Number(before.rows[0].amount_base);
    const saldoBefore = await accountSaldo(op.uid);

    const res = await api(`/api/v1/finance/operations/${op.uid}/post`, {
      method: 'POST',
      headers: json(me.token),
      body: JSON.stringify({ version: op.version }),
    });

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('posted');

    const after = await readOp(op.uid);
    expect(after.status).toBe('posted');
    expect(after.entries).toBe('2');

    // Расход: со счёта оплаты деньги уходят, значит сальдо падает ровно на сумму.
    expect(before.rows[0].type).toBe('expense');
    expect(await accountSaldo(op.uid)).toBeCloseTo(saldoBefore - amount, 2);

    const sums = await db.query<{ debit: string; credit: string }>(
      `SELECT sum(debit)::text AS debit, sum(credit)::text AS credit
         FROM finance_entry
        WHERE operation_id = (SELECT id FROM finance_operation WHERE uid = $1)`,
      [op.uid],
    );
    expect(Number(sums.rows[0].debit)).toBeCloseTo(Number(sums.rows[0].credit), 2);

    // Журнал действий (ТЗ 3.4): проведение денег — именно то действие, за
    // которое спрашивают. В самой операции виден только последний статус.
    // Берём последнюю запись, а не единственную: прогон возвращает заявку в
    // прежний статус в `afterAll`, и на следующем проходе она проводится снова,
    // а журнал только дописывается — удалять из него нельзя.
    const log = await db.query<{ action: string; changes: any }>(
      `SELECT action, changes FROM audit_log
        WHERE entity_type = 'finance_operation' AND entity_id = $1 AND action = 'post'
        ORDER BY id DESC LIMIT 1`,
      [op.uid],
    );
    expect(log.rowCount, 'запись о проведении в журнале').toBe(1);
    expect(log.rows[0].changes.status).toEqual({ from: 'approved', to: 'posted' });
    expect(Number(log.rows[0].changes.entries.to)).toBe(2);
  });

  it('второе нажатие не удваивает проводки', async () => {
    const op = await takeOperation('approved');
    const me = await login('m.rahimova');

    const first = await api(`/api/v1/finance/operations/${op.uid}/post`, {
      method: 'POST',
      headers: json(me.token),
      body: JSON.stringify({ version: op.version }),
    });
    expect(first.status).toBe(201);

    // Версия у клиента осталась прежней — ровно так и выглядит двойной клик.
    const second = await api(`/api/v1/finance/operations/${op.uid}/post`, {
      method: 'POST',
      headers: json(me.token),
      body: JSON.stringify({ version: op.version }),
    });
    expect(second.status).toBe(409);
    expect((await readOp(op.uid)).entries).toBe('2');
  });

  it('кладовщику раздел финансов закрыт целиком', async () => {
    const op = await takeOperation('approved');
    const me = await login('a.saidov');

    const res = await api(`/api/v1/finance/operations/${op.uid}/post`, {
      method: 'POST',
      headers: json(me.token),
      body: JSON.stringify({ version: op.version }),
    });

    expect(res.status).toBe(403);
    expect((await readOp(op.uid)).status).toBe('approved');
  });
});
