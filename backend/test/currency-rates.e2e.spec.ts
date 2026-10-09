/**
 * Валюты и курсы (ТЗ 6.1–6.3): справочник на запись и официальный источник.
 *
 * До 03.10.2026 курсы жили только в посеве: таблица `currency_rate` была, а
 * ввести курс в системе было нельзя — ни руками, ни загрузкой. Значит
 * валютная операция считалась по курсу той даты, когда базу посеяли, и
 * требование 6.2 («ручной ввод обязателен, автозагрузка — по доступности
 * источника ЦБ РУз») не выполнялось вовсе.
 *
 * Проверяем то, ради чего этап делался: курс можно ввести руками и загрузить
 * из ЦБ РУз; загрузка не затирает ручной ввод; номинал банка приводится к
 * одной единице; банк не опрашивается, когда курс на сегодня уже есть; запись
 * закрыта правом `refs.edit`, а каждый курс виден в журнале действий.
 *
 * В сеть прогон не ходит: ответ банка подменяется провайдером `CBU_FETCH`.
 * Живой источник проверяется отдельным прогоном `qa/rates.mjs`.
 */
import 'dotenv/config';
// Прогоны в целом ходить в банк не должны (см. `vitest.config.ts`), но этот
// файл проверяет саму загрузку — и включает её себе. В сеть он всё равно не
// идёт: ответ банка подменён провайдером `CBU_FETCH`.
process.env.RATES_AUTOLOAD = 'on';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { AuthGuard } from '../src/auth/auth.guard.js';
import { RefsModule } from '../src/refs/refs.module.js';
import { CBU_FETCH, parseCbu } from '../src/refs/rates.service.js';
import { ContextMiddleware } from '../src/common/context.middleware.js';
import { EnvelopeInterceptor } from '../src/common/envelope.interceptor.js';
import { ErrorFilter } from '../src/common/error.filter.js';

let app: INestApplication;
let base: string;
let db: Client;

const PASSWORD = process.env.SEED_PASSWORD ?? 'metall-dev-2026';

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as any) : null };
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
  return res.body.data as { token: string; permissions: string[]; companies: any[] };
}

let admin: Awaited<ReturnType<typeof login>>;
let keeper: Awaited<ReturnType<typeof login>>;
let accountant: Awaited<ReturnType<typeof login>>;
let tradeUid: string;

const head = (s: typeof admin) => ({
  Authorization: `Bearer ${s.token}`,
  'Content-Type': 'application/json',
  'X-Company-Id': tradeUid,
});
const get = (path: string, s: typeof admin) => api(path, { headers: head(s) });
const post = (path: string, s: typeof admin, body: unknown = {}) =>
  api(path, { method: 'POST', headers: head(s), body: JSON.stringify(body) });
const patch = (path: string, s: typeof admin, body: unknown) =>
  api(path, { method: 'PATCH', headers: head(s), body: JSON.stringify(body) });

/** Сегодня по Ташкенту: сессия базы живёт в UTC, и после 19:00 даты разойдутся. */
const today = () =>
  new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10);
const dayBefore = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

/** Ответ банка в его формате: номинал строкой, дата днём-месяцем-годом. */
const cbuDate = (iso: string) => iso.slice(8, 10) + '.' + iso.slice(5, 7) + '.' + iso.slice(0, 4);
const cbuRow = (ccy: string, rate: string, iso: string, nominal = '1') => ({
  Ccy: ccy,
  Nominal: nominal,
  Rate: rate,
  Date: cbuDate(iso),
  CcyNm_RU: ccy === 'USD' ? 'Доллар США' : ccy === 'RUB' ? 'Российский рубль' : 'Евро',
  CcyNm_UZ: ccy === 'USD' ? 'AQSH dollari' : ccy === 'RUB' ? 'Rossiya rubli' : 'EVRO',
});

/** Чем отвечает подменённый банк и сколько раз его спросили. */
const bank = {
  calls: 0,
  payload: [] as unknown,
  fail: null as string | null,
};
const fetcher = async () => {
  bank.calls += 1;
  if (bank.fail) throw new Error(bank.fail);
  return bank.payload;
};

/** Курсы, которые были в базе до прогона: вернём их в afterAll. */
let before: { currency_id: string; rate_date: string; rate: string; source: string | null }[] = [];

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [PrismaModule, AuthModule, RefsModule],
    providers: [
      { provide: APP_GUARD, useClass: AuthGuard },
      { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
      { provide: APP_FILTER, useClass: ErrorFilter },
    ],
  })
    .overrideProvider(CBU_FETCH)
    .useValue(fetcher)
    .compile();

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

  admin = await login('admin');
  keeper = await login('a.saidov');
  accountant = await login('m.rahimova');
  tradeUid = admin.companies.find((c: any) => c.code === 'trade').uid;

  const rows = await db.query(
    `SELECT currency_id::text, rate_date::text, rate::text, source
       FROM currency_rate WHERE rate_date >= $1::date - 3`,
    [today()],
  );
  before = rows.rows as typeof before;
}, 60_000);

afterAll(async () => {
  if (db) {
    await db.query(`DELETE FROM currency_rate WHERE rate_date >= $1::date - 3`, [today()]);
    for (const r of before) {
      await db.query(
        `INSERT INTO currency_rate (currency_id, rate_date, rate, source)
         VALUES ($1, $2::date, $3, $4)`,
        [r.currency_id, r.rate_date, r.rate, r.source],
      );
    }
    await db.query(
      `DELETE FROM currency_rate WHERE currency_id IN (SELECT id FROM currency WHERE code = 'EUR')`,
    );
    await db.query(`DELETE FROM currency WHERE code = 'EUR'`);
    await db.end();
  }
  await app?.close();
});

const list = async (s = admin) => (await get('/api/v1/refs/currencies', s)).body.data;
const find = (data: any, code: string) => data.rows.find((r: any) => r.code === code);

describe('валюты и курсы', () => {
  it('справочник открыт тому, кто смотрит финансы, и знает базовую валюту', async () => {
    const data = await list();
    expect(data.rows.map((r: any) => r.code).sort()).toEqual(['RUB', 'USD', 'UZS']);
    const uzs = find(data, 'UZS');
    // Учётная валюта сама себе курс: ни курса, ни загрузки у неё быть не должно.
    expect(uzs.isBase).toBe(true);
    expect(uzs.autoload).toBe(false);
    expect(uzs.rate).toBeNull();
    expect(find(data, 'USD').nameRu).toMatch(/[А-Яа-я]/);
  });

  it('курс вводится руками, становится последним и ложится в журнал', async () => {
    const day = today();
    const res = await post('/api/v1/refs/currencies/USD/rates', admin, {
      rateDate: day,
      rate: 12345.67,
    });
    expect(res.status).toBe(201);

    const usd = find(await list(), 'USD');
    expect(Number(usd.rate)).toBeCloseTo(12345.67, 2);
    expect(usd.rateDate).toBe(day);
    expect(usd.source).toBe('manual');

    const log = await db.query(
      `SELECT action, changes, user_id FROM audit_log
        WHERE entity_type = 'currency_rate' AND occurred_at > now() - interval '2 minutes'
        ORDER BY id DESC LIMIT 1`,
    );
    expect(log.rowCount).toBe(1);
    expect(log.rows[0].action).toBe('rate');
    expect(log.rows[0].user_id).not.toBeNull();
    expect(String(log.rows[0].changes.rate.to)).toContain('12345.67');
  });

  it('курс не больше нуля не принимается, и отказ объясняет почему', async () => {
    const bad = await post('/api/v1/refs/currencies/USD/rates', admin, {
      rateDate: today(),
      rate: 0,
    });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(bad.body)).toMatch(/курс/i);
  });

  it('без права правки справочников курс не записать и загрузку не запустить', async () => {
    expect(keeper.permissions).not.toContain('refs.edit');
    const manual = await post('/api/v1/refs/currencies/USD/rates', keeper, {
      rateDate: today(),
      rate: 1,
    });
    expect(manual.status).toBe(403);
    const sync = await post('/api/v1/refs/currencies/sync', keeper);
    expect(sync.status).toBe(403);

    // Бухгалтер — тот случай, ради которого права здесь разные: курсы он
    // видит (без них не посчитать валютную операцию), а справочник менять
    // не может — это решение того, кто отвечает за то, по чему считают.
    expect(accountant.permissions).toContain('finance.view');
    expect(accountant.permissions).not.toContain('refs.edit');
    expect((await get('/api/v1/refs/currencies', accountant)).status).toBe(200);
    const byAccountant = await post('/api/v1/refs/currencies/USD/rates', accountant, {
      rateDate: today(),
      rate: 1,
    });
    expect(byAccountant.status).toBe(403);
    // Смотреть курсы кладовщику никто не запрещал: у него есть продажи и склад,
    // но не финансы — значит и справочник курсов ему закрыт.
    expect((await get('/api/v1/refs/currencies', keeper)).status).toBe(403);
  });

  it('ответ банка разбирается: номинал приводится к одной единице, мусор отбрасывается', () => {
    const day = today();
    const rows = parseCbu([
      cbuRow('USD', '11772.95', day),
      cbuRow('KZT', '2185.00', day, '100'),
      { Ccy: 'XXX', Nominal: '1', Rate: 'нет данных', Date: cbuDate(day) },
      { Ccy: '', Nominal: '1', Rate: '10', Date: cbuDate(day) },
    ]);
    expect(rows.find((r) => r.code === 'USD')!.rate).toBeCloseTo(11772.95, 2);
    expect(rows.find((r) => r.code === 'KZT')!.rate).toBeCloseTo(21.85, 4);
    expect(rows.map((r) => r.code)).toEqual(['USD', 'KZT']);
    expect(rows[0].rateDate).toBe(day);
  });

  it('пустой или неразборчивый ответ банка — отказ словами, а не пустая загрузка', () => {
    expect(() => parseCbu([])).toThrow(/ЦБ|курс/i);
    expect(() => parseCbu({ error: 'oops' })).toThrow(/ЦБ|курс/i);
  });

  it('загрузка пишет курсы банка, но не затирает введённый руками', async () => {
    const day = today();
    // Чистый день: курс доллара на сегодня поставила прошлая проверка руками,
    // а здесь проверяется именно загрузка.
    await db.query(`DELETE FROM currency_rate WHERE rate_date = $1::date`, [day]);
    // Руками поставили курс рубля на сегодня — это решение человека.
    await post('/api/v1/refs/currencies/RUB/rates', admin, { rateDate: day, rate: 200 });
    bank.payload = [cbuRow('USD', '11772.95', day), cbuRow('RUB', '141.14', day)];
    bank.calls = 0;

    const res = await post('/api/v1/refs/currencies/sync', admin, { force: true });
    expect(res.status).toBe(201);
    expect(res.body.data.saved).toBe(1);
    expect(res.body.data.kept).toBe(1);

    const data = await list();
    expect(Number(find(data, 'USD').rate)).toBeCloseTo(11772.95, 2);
    expect(find(data, 'USD').source).toBe('cbu.uz');
    expect(Number(find(data, 'RUB').rate)).toBeCloseTo(200, 2);
    expect(find(data, 'RUB').source).toBe('manual');
  });

  it('банк не опрашивается, когда курс на сегодня уже есть', async () => {
    bank.calls = 0;
    await list();
    await list();
    expect(bank.calls).toBe(0);

    // А когда курса на сегодня нет — спросит сам, без кнопки.
    await db.query(`DELETE FROM currency_rate WHERE rate_date = $1::date`, [today()]);
    bank.payload = [cbuRow('USD', '11700.00', today()), cbuRow('RUB', '140.00', today())];
    const data = await list();
    expect(bank.calls).toBe(1);
    expect(Number(find(data, 'USD').rate)).toBeCloseTo(11700, 2);
  });

  it('банк молчит — экран живёт на последнем известном курсе', async () => {
    // Обе даты занимаем сами: что лежало в них до прогона — не наше дело,
    // а проверка «живём на последнем известном» имеет смысл только тогда,
    // когда последний известный курс задали мы.
    await db.query(`DELETE FROM currency_rate WHERE rate_date >= $1::date - 1`, [today()]);
    await db.query(
      `INSERT INTO currency_rate (currency_id, rate_date, rate, source)
       SELECT id, $1::date, 11500, 'cbu.uz' FROM currency WHERE code = 'USD'`,
      [dayBefore(today(), 1)],
    );
    bank.fail = 'сеть недоступна';
    const data = await list();
    bank.fail = null;
    expect(data.rows.length).toBe(3);
    expect(Number(find(data, 'USD').rate)).toBeCloseTo(11500, 2);
    expect(find(data, 'USD').rateDate).toBe(dayBefore(today(), 1));
    expect(data.sourceError).toMatch(/сеть|ЦБ/i);
  });

  it('история курсов — по дням, новые сверху, и видно чем отличается от прошлого дня', async () => {
    const day = today();
    // Три дня истории задаёт прогон: изменение считается к предыдущей известной
    // дате, и чужая строка за вчера сделала бы ожидание неверным.
    await db.query(`DELETE FROM currency_rate WHERE rate_date >= $1::date - 2`, [day]);
    await post('/api/v1/refs/currencies/USD/rates', admin, {
      rateDate: dayBefore(day, 2),
      rate: 11000,
    });
    await post('/api/v1/refs/currencies/USD/rates', admin, { rateDate: day, rate: 11100 });

    const hist = (await get('/api/v1/refs/currencies/USD/rates?limit=3', admin)).body.data;
    expect(hist.rows[0].rateDate).toBe(day);
    expect(Number(hist.rows[0].rate)).toBeCloseTo(11100, 2);
    expect(hist.rows.map((r: any) => r.rateDate)).toEqual(
      [...hist.rows.map((r: any) => r.rateDate)].sort().reverse(),
    );

    const usd = find(await list(), 'USD');
    // Изменение считается к предыдущей известной дате, а не к «вчера» вслепую:
    // вчерашней строки нет, поэтому сравнение идёт с позавчерашней.
    expect(Number(usd.diff)).toBeCloseTo(11100 - 11000, 2);
  });

  it('валюту заводят по коду из списка банка, с названием и номиналом оттуда', async () => {
    bank.payload = [cbuRow('EUR', '13224.55', today())];
    const res = await post('/api/v1/refs/currencies', admin, { code: 'EUR' });
    expect(res.status).toBe(201);
    const eur = find(await list(), 'EUR');
    expect(eur.nameRu).toMatch(/Евро/i);
    expect(eur.autoload).toBe(true);
    expect(Number(eur.rate)).toBeCloseTo(13224.55, 2);

    const off = await patch('/api/v1/refs/currencies/EUR', admin, { autoload: false });
    expect(off.status).toBe(200);
    expect(find(await list(), 'EUR').autoload).toBe(false);
  });
});
