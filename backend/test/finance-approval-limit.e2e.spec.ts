/**
 * Порог подтверждения платёжки и предел за период на получателя.
 *
 * Требование заказчика со встречи 07.10 (§5 разбора): «при формировании
 * платёжки на крупную сумму система должна прислать Хуршиду уведомление для
 * подтверждения», причина названа открыто — «у знакомого бухгалтер украл до
 * миллиарда мелкими транзакциями».
 *
 * Отсюда два сторожа, а не один. Порог по одной операции от того случая не
 * спасает: именно так и крали — десятью платежами вместо одного. Поэтому вторая
 * мера — предел на одного получателя за окно, и в него обязаны попадать те
 * платежи, которые ещё только висят на согласовании. Иначе разбивка снова
 * проходит: каждая заявка по отдельности ниже порога, а вместе они и есть тот
 * миллиард.
 *
 * Проверяется это приложением целиком и живой базой: операции тест заводит сам,
 * действия делает по адресу, а не вызовом сервиса, и в `afterAll` убирает за
 * собой всё — операции, журнал, роль и учётку финансиста, настройки компании.
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
import { FinanceModule } from '../src/finance/finance.module.js';
import { RefsModule } from '../src/refs/refs.module.js';
import { ContextMiddleware } from '../src/common/context.middleware.js';
import { EnvelopeInterceptor } from '../src/common/envelope.interceptor.js';
import { ErrorFilter } from '../src/common/error.filter.js';

let app: INestApplication;
let base: string;
let db: Client;

const PASSWORD = process.env.SEED_PASSWORD ?? 'metall-dev-2026';

/** Право на подтверждение крупного платежа. Не `.view`: это решение, а не просмотр. */
const LARGE = 'finance.approve.large';

/** Учётка и роль, которых в сиде нет: финансист утверждает, но не крупное. */
const FIN_LOGIN = 't.financier.limit';
const FIN_ROLE = 'test_financier_limit';

/** Префикс номеров операций теста: по нему же идёт уборка. */
const PREFIX = `TST-LIM-${process.pid}`;

let companyId: string;
let companyUid: string;
let accountId: string;
let counterAccountId: string;
let currencyId: string;
let cashflowItemId: string;
let partnerA: string;
let partnerB: string;
let madeOps: string[] = [];
let saved: { single: string | null; period: string | null; days: number } | null = null;

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

const json = (token: string) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

/** Настройки порога прямо в базе: экран настроек проверяется отдельным тестом. */
async function setLimits(single: number | null, period: number | null, days = 30) {
  await db.query(
    `UPDATE company
        SET approval_limit_single = $2::numeric,
            approval_limit_period = $3::numeric,
            approval_period_days = $4
      WHERE id = $1::bigint`,
    [companyId, single, period, days],
  );
}

/**
 * Сколько уже ушло получателю за окно — без учёта операций, которые заведёт сам
 * тест. Порог считаем от этого числа: в сиде у контрагента есть своя история, и
 * тест, написанный на круглые цифры, зеленел бы или падал от чужих данных.
 */
async function baseline(partnerId: string, days = 30): Promise<number> {
  const res = await db.query<{ s: string }>(
    `SELECT coalesce(sum(amount_base), 0)::text AS s
       FROM finance_operation
      WHERE company_id = $1::bigint AND partner_id = $2::bigint
        AND operation_type = 'expense'
        AND status IN ('pending_approval', 'approved', 'posted')
        AND occurred_at > now() - ($3 || ' days')::interval
        AND occurred_at <= now()`,
    [companyId, partnerId, days],
  );
  return Number(res.rows[0].s);
}

/** Заявка на оплату с нужной суммой, получателем и статусом. */
async function makeOp(
  amount: number,
  opts: { partnerId?: string | null; status?: string } = {},
): Promise<{ uid: string; version: number }> {
  const number = `${PREFIX}-${madeOps.length + 1}`;
  const res = await db.query<{ uid: string; version: number }>(
    `INSERT INTO finance_operation
       (uid, company_id, number, operation_type, occurred_at, account_id, counter_account_id,
        amount, currency_id, rate, amount_base, cashflow_item_id, partner_id, status, version,
        created_by)
     VALUES (gen_random_uuid(), $1::bigint, $2, 'expense', now(), $3::bigint, $4::bigint,
             $5::numeric, $6::bigint, 1, $5::numeric, $7::bigint, $8::bigint,
             $9::"FinanceStatus", 1,
             (SELECT id FROM user_account WHERE login = 'm.rahimova'))
     RETURNING uid, version`,
    [
      companyId,
      number,
      accountId,
      counterAccountId,
      amount,
      currencyId,
      cashflowItemId,
      opts.partnerId === undefined ? partnerA : opts.partnerId,
      opts.status ?? 'pending_approval',
    ],
  );
  madeOps.push(res.rows[0].uid);
  return res.rows[0];
}

const approve = (uid: string, version: number, token: string) =>
  api(`/api/v1/finance/operations/${uid}/approve`, {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify({ version }),
  });

const statusOf = async (uid: string) =>
  (
    await db.query<{ status: string }>(
      `SELECT status::text AS status FROM finance_operation WHERE uid = $1`,
      [uid],
    )
  ).rows[0].status;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [PrismaModule, AuthModule, FinanceModule, RefsModule],
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

  // Компанию и обстановку берём ту, в которой работает бухгалтер из сида:
  // так заявка выглядит как настоящая, а не собранная из чужих справочников.
  const env = await db.query<{
    company_id: string;
    company_uid: string;
    account_id: string;
    counter_id: string;
    currency_id: string;
    item_id: string;
  }>(
    `SELECT c.id AS company_id, c.uid AS company_uid,
            (SELECT id FROM account WHERE company_id = c.id ORDER BY id LIMIT 1) AS account_id,
            (SELECT id FROM account WHERE company_id = c.id ORDER BY id DESC LIMIT 1) AS counter_id,
            (SELECT id FROM currency WHERE code = c.base_currency) AS currency_id,
            (SELECT id FROM cashflow_item WHERE company_id = c.id AND direction = 'outflow'
              ORDER BY id LIMIT 1) AS item_id
       FROM company c
      WHERE c.id = (SELECT company_id FROM user_role_assignment
                     WHERE user_id = (SELECT id FROM user_account WHERE login = 'm.rahimova')
                     ORDER BY id LIMIT 1)`,
  );
  const row = env.rows[0];
  if (!row?.item_id) throw new Error('в сиде нет статьи расхода — тест проверять нечего');
  companyId = row.company_id;
  companyUid = row.company_uid;
  accountId = row.account_id;
  counterAccountId = row.counter_id;
  currencyId = row.currency_id;
  cashflowItemId = row.item_id;

  const partners = await db.query<{ id: string }>(
    `SELECT id FROM partner WHERE company_id = $1::bigint ORDER BY id LIMIT 2`,
    [companyId],
  );
  if (partners.rowCount! < 2) throw new Error('в сиде меньше двух контрагентов');
  partnerA = partners.rows[0].id;
  partnerB = partners.rows[1].id;

  saved = (
    await db.query<{ single: string | null; period: string | null; days: number }>(
      `SELECT approval_limit_single::text AS single, approval_limit_period::text AS period,
              approval_period_days AS days
         FROM company WHERE id = $1::bigint`,
      [companyId],
    )
  ).rows[0];

  // Финансист: утверждает платежи, но крупные подтверждать не может. В сиде
  // такой роли нет — `finance.approve` там у директора, а у него есть всё.
  await db.query(
    `INSERT INTO role (company_id, code, name_ru, name_uz, is_system)
     VALUES ($1::bigint, $2, 'Финансист (тест)', 'Moliyachi (test)', false)
     ON CONFLICT (company_id, code) DO NOTHING`,
    [companyId, FIN_ROLE],
  );
  await db.query(
    `INSERT INTO role_permission (role_id, permission_id)
     SELECT r.id, p.id FROM role r JOIN permission p ON p.code = ANY($3::text[])
      WHERE r.company_id = $1::bigint AND r.code = $2
     ON CONFLICT DO NOTHING`,
    [companyId, FIN_ROLE, ['dashboard.view', 'finance.view', 'finance.approve']],
  );
  await db.query(
    // `uid` подставляем сами: умолчание у него прописано в схеме Prisma, а не
    // в базе, и прямая вставка мимо клиента его не получает.
    `INSERT INTO user_account (uid, login, password_hash, full_name)
     SELECT gen_random_uuid(), $1, password_hash, 'Финансист (тест)'
       FROM user_account WHERE login = 'm.rahimova'
     ON CONFLICT (login) DO NOTHING`,
    [FIN_LOGIN],
  );
  await db.query(
    `INSERT INTO user_role_assignment (user_id, role_id, company_id)
     SELECT u.id, r.id, $1::bigint
       FROM user_account u, role r
      WHERE u.login = $2 AND r.company_id = $1::bigint AND r.code = $3
     ON CONFLICT DO NOTHING`,
    [companyId, FIN_LOGIN, FIN_ROLE],
  );
  // Учётка от прошлого прогона остаётся выключенной (см. `afterAll`): включаем
  // её обратно и снимаем счётчик неудачных входов, иначе второй прогон не
  // войдёт и упадёт на логине.
  await db.query(
    `UPDATE user_account
        SET is_active = true, locked_until = NULL, failed_login_count = 0
      WHERE login = $1`,
    [FIN_LOGIN],
  );
}, 60_000);

afterAll(async () => {
  if (db) {
    if (madeOps.length > 0) {
      await db.query(
        `DELETE FROM finance_entry
          WHERE operation_id IN (SELECT id FROM finance_operation WHERE uid = ANY($1::uuid[]))`,
        [madeOps],
      );
      await db.query(`DELETE FROM finance_operation WHERE uid = ANY($1::uuid[])`, [madeOps]);
      // Записи журнала остаются: `audit_log` только для добавления, DELETE в нём
      // запрещён триггером. Это правильно - журнал действий не чистят даже
      // тесты, а номера операций у каждого прогона свои.
    }
    if (saved) await setLimits(saved.single ? Number(saved.single) : null, saved.period ? Number(saved.period) : null, saved.days);
    await db.query(
      `DELETE FROM user_role_assignment
        WHERE user_id = (SELECT id FROM user_account WHERE login = $1)`,
      [FIN_LOGIN],
    );
    // Учётку не удаляем, а выключаем. Удалить её база не даёт, и правильно:
    // финансист оставил записи в журнале действий, а `audit_log` только для
    // добавления - снятие ссылки на автора там запрещено триггером. Журнал
    // обязан помнить, кто утверждал платёж, даже если человека больше нет.
    await db.query(`UPDATE user_account SET is_active = false WHERE login = $1`, [FIN_LOGIN]);
    await db.query(
      `DELETE FROM role_permission
        WHERE role_id = (SELECT id FROM role WHERE company_id = $1::bigint AND code = $2)`,
      [companyId, FIN_ROLE],
    );
    await db.query(`DELETE FROM role WHERE company_id = $1::bigint AND code = $2`, [
      companyId,
      FIN_ROLE,
    ]);
  }
  await app?.close();
  await db?.end();
});

describe('право на подтверждение крупного платежа', () => {
  it('у финансиста его нет, а у администратора есть', async () => {
    const fin = await login(FIN_LOGIN);
    expect(fin.permissions).toContain('finance.approve');
    expect(fin.permissions, 'финансисту досталось право на крупные платежи').not.toContain(LARGE);

    const boss = await login('admin');
    expect(boss.permissions, 'право на крупные платежи некому выдать').toContain(LARGE);
  });
});

describe('порог по одной операции', () => {
  it('платёж выше порога финансист не утверждает', async () => {
    await setLimits(10_000_000, null);
    const op = await makeOp(12_000_000);
    const fin = await login(FIN_LOGIN);

    const res = await approve(op.uid, op.version, fin.token);

    expect(res.status).toBe(403);
    expect(res.body.error.message, 'в отказе не сказано, что платёж крупный').toMatch(/крупн/i);
    expect(await statusOf(op.uid), 'заявка всё-таки утверждена').toBe('pending_approval');
  });

  it('платёж ниже порога утверждается как раньше', async () => {
    await setLimits(10_000_000, null);
    const op = await makeOp(4_000_000);
    const fin = await login(FIN_LOGIN);

    const res = await approve(op.uid, op.version, fin.token);

    expect(res.status).toBe(201);
    expect(await statusOf(op.uid)).toBe('approved');
  });

  it('тот, у кого есть право на крупные, утверждает платёж выше порога', async () => {
    await setLimits(10_000_000, null);
    const op = await makeOp(12_000_000);
    const boss = await login('admin');

    const res = await approve(op.uid, op.version, boss.token);

    expect(res.status).toBe(201);
    expect(await statusOf(op.uid)).toBe('approved');
  });

  it('порог не задан — работает как до правки', async () => {
    await setLimits(null, null);
    const op = await makeOp(900_000_000);
    const fin = await login(FIN_LOGIN);

    const res = await approve(op.uid, op.version, fin.token);

    expect(res.status).toBe(201);
    expect(await statusOf(op.uid)).toBe('approved');
  });

  it('платёж без получателя порог по операции всё равно проходит', async () => {
    await setLimits(10_000_000, 25_000_000);
    const op = await makeOp(12_000_000, { partnerId: null });
    const fin = await login(FIN_LOGIN);

    const res = await approve(op.uid, op.version, fin.token);

    expect(res.status).toBe(403);
    expect(await statusOf(op.uid)).toBe('pending_approval');
  });
});

describe('предел за период на получателя', () => {
  it('десять мелких платежей одному получателю не проходят мимо порога', async () => {
    const had = await baseline(partnerA);
    await setLimits(10_000_000, had + 25_000_000);

    const fin = await login(FIN_LOGIN);
    // Два платежа уже утверждены, каждый вдвое ниже порога по операции.
    for (const _ of [1, 2]) {
      const op = await makeOp(9_000_000);
      expect((await approve(op.uid, op.version, fin.token)).status).toBe(201);
    }

    // Третий такой же: сам по себе проходной, вместе с теми двумя — 27 млн.
    const third = await makeOp(9_000_000);
    const res = await approve(third.uid, third.version, fin.token);

    expect(res.status).toBe(403);
    expect(res.body.error.message, 'в отказе не названа причина «за период»').toMatch(
      /за период/i,
    );
    expect(await statusOf(third.uid)).toBe('pending_approval');
  });

  it('в предел идут и те платежи, что ещё висят на согласовании', async () => {
    const had = await baseline(partnerB);
    await setLimits(10_000_000, had + 25_000_000);

    // Ничего не утверждаем: три заявки просто поданы. Если считать только
    // утверждённые, разбивка на мелкие пройдёт — именно так и крали.
    await makeOp(9_000_000, { partnerId: partnerB });
    await makeOp(9_000_000, { partnerId: partnerB });
    const third = await makeOp(9_000_000, { partnerId: partnerB });

    const fin = await login(FIN_LOGIN);
    const res = await approve(third.uid, third.version, fin.token);

    expect(res.status, 'висящие на согласовании в предел не попали').toBe(403);
    expect(await statusOf(third.uid)).toBe('pending_approval');
  });

  it('отклонённые и черновики в предел не идут', async () => {
    const had = await baseline(partnerB);
    await setLimits(10_000_000, had + 25_000_000);

    await makeOp(9_000_000, { partnerId: partnerB, status: 'draft' });
    await makeOp(9_000_000, { partnerId: partnerB, status: 'rejected' });
    const op = await makeOp(9_000_000, { partnerId: partnerB });

    const fin = await login(FIN_LOGIN);
    const res = await approve(op.uid, op.version, fin.token);

    expect(res.status, 'черновик или отказ посчитали платежом').toBe(201);
    expect(await statusOf(op.uid)).toBe('approved');
  });

  it('платежи другому получателю предел не трогают', async () => {
    const hadA = await baseline(partnerA);
    await setLimits(10_000_000, hadA + 25_000_000);

    const fin = await login(FIN_LOGIN);
    for (const _ of [1, 2]) {
      const op = await makeOp(9_000_000, { partnerId: partnerA });
      expect((await approve(op.uid, op.version, fin.token)).status).toBe(201);
    }

    // Предел считается на получателя: у второго своя история.
    const hadB = await baseline(partnerB);
    await setLimits(10_000_000, hadB + 25_000_000);
    const other = await makeOp(9_000_000, { partnerId: partnerB });
    const res = await approve(other.uid, other.version, fin.token);

    expect(res.status).toBe(201);
    expect(await statusOf(other.uid)).toBe('approved');
  });

  it('тот, у кого право на крупные, утверждает и поверх предела', async () => {
    const had = await baseline(partnerA);
    await setLimits(10_000_000, had);

    const op = await makeOp(9_000_000, { partnerId: partnerA });
    const boss = await login('admin');
    const res = await approve(op.uid, op.version, boss.token);

    expect(res.status).toBe(201);
    expect(await statusOf(op.uid)).toBe('approved');
  });
});

describe('настройки компании', () => {
  it('порог и предел читаются и правятся на экране настроек', async () => {
    const boss = await login('admin');
    const patch = await api('/api/v1/refs/settings', {
      method: 'PATCH',
      headers: json(boss.token),
      body: JSON.stringify({
        companyUid,
        approvalLimitSingle: 15_000_000,
        approvalLimitPeriod: 40_000_000,
        approvalPeriodDays: 7,
      }),
    });
    expect(patch.status).toBe(200);
    expect(Number(patch.body.data.approvalLimitSingle)).toBe(15_000_000);

    const read = await api(`/api/v1/refs/settings?companyUid=${companyUid}`, {
      headers: json(boss.token),
    });
    const mine = read.body.data.rows.find((r: any) => r.companyUid === companyUid);
    expect(Number(mine.approvalLimitSingle)).toBe(15_000_000);
    expect(Number(mine.approvalLimitPeriod)).toBe(40_000_000);
    expect(mine.approvalPeriodDays).toBe(7);

    // Порог — это правило про деньги, его смена обязана оставлять след.
    const log = await db.query<{ changes: any }>(
      `SELECT changes FROM audit_log
        WHERE entity_type = 'company_settings' AND action = 'update'
        ORDER BY id DESC LIMIT 1`,
    );
    expect(log.rows[0].changes.approvalLimitSingle, 'смена порога не попала в журнал').toBeDefined();
  });

  it('порог снимается значением null', async () => {
    const boss = await login('admin');
    const res = await api('/api/v1/refs/settings', {
      method: 'PATCH',
      headers: json(boss.token),
      body: JSON.stringify({ companyUid, approvalLimitSingle: null }),
    });
    expect(res.status).toBe(200);
    expect(res.body.data.approvalLimitSingle).toBeNull();
  });

  it('без права settings.edit порог не поменять', async () => {
    const fin = await login(FIN_LOGIN);
    const res = await api('/api/v1/refs/settings', {
      method: 'PATCH',
      headers: json(fin.token),
      body: JSON.stringify({ companyUid, approvalLimitSingle: 1_000_000 }),
    });
    expect(res.status).toBe(403);
  });
});
