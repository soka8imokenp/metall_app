/**
 * Создание, правка и сторно финансовой операции: приложение целиком, живая база.
 *
 * Согласование уже проверено в `finance-approval.e2e.spec.ts`. Здесь другое:
 * откуда операция берётся и как её отменяют, когда она уже проведена.
 *
 * Главное, ради чего тест написан, — сторно. Проведённую операцию нельзя ни
 * удалить, ни переписать: проводки уже ушли в отчётность. Отменяют её только
 * зеркальной операцией, и после неё сальдо счёта обязано вернуться ровно к
 * тому значению, которое было до проведения. Это и проверяется числом, а не
 * статусом.
 *
 * Всё созданное тестом удаляется в `afterAll`, задетые операции возвращаются
 * в исходный статус. Иначе второй прогон пошёл бы по уже сторнированным.
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

/** uid операций, созданных тестом: их надо снести вместе с проводками. */
const created: string[] = [];
/**
 * Операции, которых тест коснулся: вернуть как было.
 *
 * Сумму снимаем вместе со статусом не для красоты. Проверка «проведённую
 * править нельзя» ожидает отказ, но если сторож однажды сломают, запрос
 * пройдёт и перепишет сумму проведённой операции — её проводки останутся
 * от прежней. Тест, который портит базу ровно в тот момент, когда находит
 * дефект, хуже отсутствующего.
 */
const touched: {
  uid: string;
  status: string;
  version: number;
  amount: string;
  rate: string;
  amountBase: string;
}[] = [];

async function snapshot(uid: string) {
  const r = await db.query<{
    uid: string;
    status: string;
    version: number;
    amount: string;
    rate: string;
    amountBase: string;
  }>(
    `SELECT uid, status::text AS status, version,
            amount::text, rate::text, amount_base::text AS "amountBase"
       FROM finance_operation WHERE uid = $1`,
    [uid],
  );
  touched.push(r.rows[0]);
  return r.rows[0];
}

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

/** Сальдо счёта по его коду: сумма проводок, а не хранимое поле. */
const saldoByCode = async (companyCode: string, code: string) =>
  Number(
    (
      await db.query<{ saldo: string }>(
        `SELECT coalesce(sum(e.debit - e.credit), 0)::text AS saldo
           FROM finance_entry e
           JOIN account a ON a.id = e.account_id
           JOIN company c ON c.id = a.company_id
          WHERE a.code = $2 AND c.code = $1`,
        [companyCode, code],
      )
    ).rows[0].saldo,
  );

const readOp = async (uid: string) =>
  (
    await db.query<{
      status: string;
      version: number;
      number: string;
      amount_base: string;
      created_by: string | null;
      reversal_of: string | null;
      entries: string;
    }>(
      `SELECT o.status::text AS status, o.version, o.number, o.amount_base::text,
              o.created_by::text, r.uid AS reversal_of,
              (SELECT count(*) FROM finance_entry e WHERE e.operation_id = o.id)::text AS entries
         FROM finance_operation o
         LEFT JOIN finance_operation r ON r.id = o.reversal_of_id
        WHERE o.uid = $1`,
      [uid],
    )
  ).rows[0];

/** Компания торгового дома и живой расчётный счёт в ней. */
let company: { uid: string; code: string };
let accountCode: string;
let counterCode: string;

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

  const c = await db.query<{ uid: string; code: string }>(
    `SELECT uid, code FROM company ORDER BY id LIMIT 1`,
  );
  company = c.rows[0];

  // Берём счета той же компании: операция и её корреспондент обязаны жить
  // в одной книге, иначе проводки уйдут в разные компании.
  const accs = await db.query<{ code: string }>(
    `SELECT a.code FROM account a JOIN company c ON c.id = a.company_id
      WHERE c.uid = $1 AND a.is_active AND a.kind IN ('bank', 'cash')
      ORDER BY a.code`,
    [company.uid],
  );
  accountCode = accs.rows[0].code;
  const other = await db.query<{ code: string }>(
    `SELECT a.code FROM account a JOIN company c ON c.id = a.company_id
      WHERE c.uid = $1 AND a.is_active AND a.kind NOT IN ('bank', 'cash')
      ORDER BY a.code LIMIT 1`,
    [company.uid],
  );
  counterCode = other.rows[0].code;
}, 60_000);

afterAll(async () => {
  for (const uid of created) {
    await db.query(
      `DELETE FROM finance_entry
        WHERE operation_id = (SELECT id FROM finance_operation WHERE uid = $1)`,
      [uid],
    );
  }
  // Сначала сторно, потом оригиналы: у сторно есть ссылка на оригинал.
  for (const uid of [...created].reverse()) {
    await db.query(`DELETE FROM finance_operation WHERE uid = $1`, [uid]);
  }
  for (const t of touched) {
    await db.query(
      `UPDATE finance_operation
          SET status = $2::"FinanceStatus", version = $3,
              amount = $4::numeric, rate = $5::numeric, amount_base = $6::numeric
        WHERE uid = $1`,
      [t.uid, t.status, t.version, t.amount, t.rate, t.amountBase],
    );
  }
  await app?.close();
  await db?.end();
});

/** Тело нового черновика: расход со счёта на корреспондент. */
const draftBody = (extra: Record<string, unknown> = {}) => ({
  companyUid: company.uid,
  operationType: 'expense',
  accountCode,
  counterAccountCode: counterCode,
  amount: '1250000.00',
  currencyCode: 'UZS',
  comment: 'Проверка записи',
  ...extra,
});

async function createDraft(token: string, extra: Record<string, unknown> = {}, key?: string) {
  const res = await api('/api/v1/finance/operations', {
    method: 'POST',
    headers: { ...json(token), ...(key ? { 'Idempotency-Key': key } : {}) },
    body: JSON.stringify(draftBody(extra)),
  });
  if (res.status === 201 && res.body?.data?.uid && !created.includes(res.body.data.uid)) {
    created.push(res.body.data.uid);
  }
  return res;
}

describe('GET /finance/refs', () => {
  it('отдаёт справочники для формы: счета, статьи, валюты', async () => {
    const me = await login('m.rahimova');
    const res = await api('/api/v1/finance/refs', { headers: auth(me.token) });

    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.accounts.length).toBeGreaterThan(0);
    expect(d.cashflowItems.length).toBeGreaterThan(0);
    expect(d.currencies).toContain('UZS');
    // Без этого форма не сможет предложить корреспондента с его типом.
    expect(d.accounts[0]).toHaveProperty('kind');
  });

  /**
   * Статья ДДС, контрагент и счёт живут внутри компании, а справочник отдаёт
   * их одним списком. У пользователя с двумя компаниями строки перемешаны и
   * снаружи неразличимы: названия совпадают дословно, «Заработная плата» в
   * списке дважды. Форма подставит строку чужой компании, сервер ответит 422
   * «Статья ДДС не найдена», и человек получит отказ на ровном месте — он
   * выбрал из того списка, который ему сами и дали.
   */
  it('каждая строка справочника помечена своей компанией', async () => {
    const me = await login('s.radjabov');
    const res = await api('/api/v1/finance/refs', { headers: auth(me.token) });
    expect(res.status).toBe(200);

    const mine = new Set((me.companies as { uid: string }[]).map((c) => c.uid));
    expect(mine.size, 'проверка имеет смысл только на двух компаниях').toBeGreaterThan(1);

    for (const key of ['accounts', 'cashflowItems', 'partners'] as const) {
      const rows = res.body.data[key] as { companyUid?: string }[];
      expect(rows.length, `${key} пуст`).toBeGreaterThan(0);
      expect(rows.filter((r) => !r.companyUid).length, `строк ${key} без компании`).toBe(0);
      expect(
        rows.filter((r) => !mine.has(r.companyUid!)).length,
        `строк ${key} из чужой компании`,
      ).toBe(0);
    }
  });

  /**
   * Пометка обязана быть рабочей, а не просто присутствовать в ответе. Берём
   * две расходные статьи — свою и чужую — и сверяем, что сервер различает их
   * ровно так, как пометка обещает.
   */
  it('статья своей компании принимается, статья чужой — нет', async () => {
    const me = await login('s.radjabov');
    const refs = await api('/api/v1/finance/refs', { headers: auth(me.token) });
    const items = refs.body.data.cashflowItems as {
      uid: string;
      companyUid?: string;
      direction: string;
    }[];

    const ours = items.find((i) => i.companyUid === company.uid && i.direction === 'outflow');
    const alien = items.find((i) => i.companyUid !== company.uid && i.direction === 'outflow');
    expect(ours, 'расходная статья своей компании').toBeTruthy();
    expect(alien, 'расходная статья чужой компании').toBeTruthy();

    const ok = await createDraft(me.token, { cashflowItemUid: ours!.uid });
    expect(ok.status, 'своя статья должна приниматься').toBe(201);

    const bad = await createDraft(me.token, { cashflowItemUid: alien!.uid });
    expect(bad.status, 'чужая статья не должна приниматься').toBe(422);
  });

  it('кладовщику справочники финансов не отдаются', async () => {
    const me = await login('a.saidov');
    const res = await api('/api/v1/finance/refs', { headers: auth(me.token) });
    expect(res.status).toBe(403);
  });
});

describe('POST /finance/operations', () => {
  it('создаёт черновик: без проводок, с автором и пересчитанной базовой суммой', async () => {
    const me = await login('m.rahimova');
    const saldoBefore = await saldoByCode(company.code, accountCode);

    const res = await createDraft(me.token);

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('draft');
    expect(res.body.data.version).toBe(1);

    const after = await readOp(res.body.data.uid);
    expect(after.status).toBe('draft');
    // Черновик денег не двигает: ни проводок, ни сдвига сальдо.
    expect(after.entries).toBe('0');
    expect(await saldoByCode(company.code, accountCode)).toBe(saldoBefore);
    expect(after.created_by).not.toBeNull();
    expect(Number(after.amount_base)).toBeCloseTo(1250000, 2);
    expect(after.number).toMatch(/^[А-Я]{2,3}-\d{6}$/);
  });

  it('курс пересчитывает сумму в сумы, а не копирует её', async () => {
    const me = await login('m.rahimova');
    const res = await createDraft(me.token, {
      currencyCode: 'USD',
      amount: '1000.00',
      rate: '12600.00',
    });

    expect(res.status).toBe(201);
    const after = await readOp(res.body.data.uid);
    expect(Number(after.amount_base)).toBeCloseTo(12_600_000, 2);
  });

  it('повтор с тем же ключом идемпотентности не заводит вторую операцию', async () => {
    const me = await login('m.rahimova');
    const key = `test-${Date.now()}`;

    const first = await createDraft(me.token, {}, key);
    const second = await createDraft(me.token, {}, key);

    expect(first.status).toBe(201);
    // Второй запрос — это повтор, а не новая заявка: та же операция, не копия.
    expect(second.body.data.uid).toBe(first.body.data.uid);
    const count = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM finance_operation WHERE idempotency_key = $1`,
      [key],
    );
    expect(count.rows[0].n).toBe('1');
  });

  it('несуществующий счёт не принимается', async () => {
    const me = await login('m.rahimova');
    const res = await createDraft(me.token, { accountCode: '9999' });
    expect(res.status).toBe(422);
  });

  it('нулевая сумма не принимается', async () => {
    const me = await login('m.rahimova');
    const res = await createDraft(me.token, { amount: '0' });
    expect(res.status).toBe(400);
  });

  it('счёт сам себе корреспондентом не принимается', async () => {
    // Дебет и кредит по одному счёту сходятся, поэтому база такую операцию
    // примет молча: триггер двойной записи здесь ничего не нарушено не видит.
    // Смысла в ней нет — деньги не двигались, а в журнале появилась строка.
    const me = await login('m.rahimova');
    const res = await createDraft(me.token, { counterAccountCode: accountCode });
    expect(res.status).toBe(422);
    if (res.status === 201) created.push(res.body.data.uid);
  });

  it('кладовщик операцию завести не может', async () => {
    const me = await login('a.saidov');
    const res = await createDraft(me.token);
    expect(res.status).toBe(403);
  });
});

describe('PATCH /finance/operations/:uid', () => {
  it('черновик правится, версия растёт', async () => {
    const me = await login('m.rahimova');
    const draft = await createDraft(me.token);

    const res = await api(`/api/v1/finance/operations/${draft.body.data.uid}`, {
      method: 'PATCH',
      headers: json(me.token),
      body: JSON.stringify({ version: 1, amount: '2000000.00', comment: 'Исправлено' }),
    });

    expect(res.status).toBe(200);
    const after = await readOp(draft.body.data.uid);
    expect(after.version).toBe(2);
    expect(Number(after.amount_base)).toBeCloseTo(2_000_000, 2);
  });

  it('правка не сводит корреспондент к счёту самой операции', async () => {
    // Присылают один код из двух, и сравнивать только присланное нельзя:
    // совпадение видно лишь по итоговой паре «что останется после правки».
    const me = await login('m.rahimova');
    const draft = await createDraft(me.token);

    const res = await api(`/api/v1/finance/operations/${draft.body.data.uid}`, {
      method: 'PATCH',
      headers: json(me.token),
      body: JSON.stringify({ version: 1, counterAccountCode: accountCode }),
    });

    expect(res.status).toBe(422);
    const after = await readOp(draft.body.data.uid);
    expect(after.version, 'версия после отказа').toBe(1);
  });

  it('проведённую операцию править нельзя', async () => {
    const me = await login('s.radjabov');
    const row = await db.query<{ uid: string }>(
      `SELECT uid FROM finance_operation WHERE status = 'posted' ORDER BY id LIMIT 1`,
    );
    const before = await snapshot(row.rows[0].uid);

    const res = await api(`/api/v1/finance/operations/${before.uid}`, {
      method: 'PATCH',
      headers: json(me.token),
      body: JSON.stringify({ version: before.version, amount: '1.00' }),
    });
    expect(res.status).toBe(409);
  });
});

describe('POST /finance/operations/:uid/reverse', () => {
  it('сторно возвращает сальдо счёта ровно к тому, что было до проведения', async () => {
    const me = await login('s.radjabov');

    // Свой круг от начала до конца: черновик → согласование → проведение.
    const draft = await createDraft(me.token);
    const uid = draft.body.data.uid;
    const saldoBefore = await saldoByCode(company.code, accountCode);

    const step = async (action: string, version: number) =>
      api(`/api/v1/finance/operations/${uid}/${action}`, {
        method: 'POST',
        headers: json(me.token),
        body: JSON.stringify({ version }),
      });

    expect((await step('submit', 1)).status).toBe(201);
    expect((await step('approve', 2)).status).toBe(201);
    expect((await step('post', 3)).status).toBe(201);

    const saldoPosted = await saldoByCode(company.code, accountCode);
    expect(saldoPosted).toBeCloseTo(saldoBefore - 1_250_000, 2);

    const rev = await api(`/api/v1/finance/operations/${uid}/reverse`, {
      method: 'POST',
      headers: json(me.token),
      body: JSON.stringify({ version: 4, comment: 'Ошибка в сумме' }),
    });

    expect(rev.status).toBe(201);
    created.push(rev.body.data.uid);

    // Оригинал помечен сторнированным, но проводки у него остались: они уже
    // были в отчётности, и стирать их задним числом нельзя.
    const original = await readOp(uid);
    expect(original.status).toBe('reversed');
    expect(original.entries).toBe('2');

    const mirror = await readOp(rev.body.data.uid);
    expect(mirror.status).toBe('posted');
    expect(mirror.reversal_of).toBe(uid);
    expect(mirror.entries).toBe('2');

    // Ради этой строки тест и написан: деньги вернулись на место.
    expect(await saldoByCode(company.code, accountCode)).toBeCloseTo(saldoBefore, 2);
  });

  it('сторно с устаревшей версией не проходит', async () => {
    const me = await login('s.radjabov');
    // Корреспондент обязателен в условии: без него сторно отказывает раньше,
    // чем дойдёт до версии, и проверка прошла бы вхолостую — так и было,
    // пока в неё не добавили это условие.
    const row = await db.query<{ uid: string }>(
      `SELECT uid FROM finance_operation
        WHERE status = 'posted' AND reversal_of_id IS NULL AND counter_account_id IS NOT NULL
        ORDER BY id LIMIT 1`,
    );
    const target = await snapshot(row.rows[0].uid);

    // Статус подходящий, а версия — нет: карточку открыли давно, за это время
    // операцию тронули. Отдельный сторож от того, что ловит двойное сторно
    // по статусу: тот бы здесь промолчал, статус всё ещё «проведена».
    const res = await api(`/api/v1/finance/operations/${target.uid}/reverse`, {
      method: 'POST',
      headers: json(me.token),
      body: JSON.stringify({ version: target.version + 5 }),
    });

    expect(res.status).toBe(409);
    const after = await readOp(target.uid);
    expect(after.status).toBe('posted');
    // Зеркала быть не должно: отказ обязан случиться до создания второй операции.
    const mirrors = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM finance_operation
        WHERE reversal_of_id = (SELECT id FROM finance_operation WHERE uid = $1)`,
      [target.uid],
    );
    expect(mirrors.rows[0].n).toBe('0');
  });

  it('непроведённую операцию сторнировать нечем', async () => {
    const me = await login('s.radjabov');
    const draft = await createDraft(me.token);

    const res = await api(`/api/v1/finance/operations/${draft.body.data.uid}/reverse`, {
      method: 'POST',
      headers: json(me.token),
      body: JSON.stringify({ version: 1 }),
    });
    expect(res.status).toBe(409);
  });

  it('второе сторно той же операции не проходит', async () => {
    const me = await login('s.radjabov');
    const row = await db.query<{ uid: string }>(
      `SELECT uid FROM finance_operation
        WHERE status = 'posted' AND reversal_of_id IS NULL
        ORDER BY id DESC LIMIT 1`,
    );
    const target = await snapshot(row.rows[0].uid);

    const first = await api(`/api/v1/finance/operations/${target.uid}/reverse`, {
      method: 'POST',
      headers: json(me.token),
      body: JSON.stringify({ version: target.version }),
    });
    expect(first.status).toBe(201);
    created.push(first.body.data.uid);

    const second = await api(`/api/v1/finance/operations/${target.uid}/reverse`, {
      method: 'POST',
      headers: json(me.token),
      body: JSON.stringify({ version: target.version + 1 }),
    });
    expect(second.status).toBe(409);
  });
});
