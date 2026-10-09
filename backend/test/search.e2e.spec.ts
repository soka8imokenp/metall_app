/**
 * Поиск по данным: одно окно на всю систему.
 *
 * Окно поиска во фронте умело находить только названия разделов — заказчик
 * справедливо спросил, зачем такой поиск нужен. Здесь проверяется то, ради
 * чего он делается: по куску номера или названия человек находит саму запись —
 * номенклатуру, контрагента, заказ, партию, документ, сделку, сотрудника.
 *
 * Два правила важнее полноты выдачи и проверяются отдельно:
 *   1. Поиск не обходит права. Рабочий цеха не видит ни контрагентов, ни
 *      номенклатуры — иначе поиск становится дырой в обход ролей.
 *   2. Поиск не обходит компанию. Заказ завода не находится, когда человек
 *      стоит в торговом доме, — за это отвечает RLS, и проверять это надо
 *      именно на поиске: он ходит в таблицы напрямую.
 *
 * Прогон только читает.
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
import { SearchModule } from '../src/search/search.module.js';
import { ContextMiddleware } from '../src/common/context.middleware.js';
import { EnvelopeInterceptor } from '../src/common/envelope.interceptor.js';
import { ErrorFilter } from '../src/common/error.filter.js';

let app: INestApplication;
let base: string;
let db: Client;

const PASSWORD = process.env.SEED_PASSWORD ?? 'metall-dev-2026';
const CYR = /[А-Яа-яЁё]/;

interface Row {
  uid: string;
  title: string;
  subtitle: string | null;
}
interface Group {
  kind: string;
  module: string;
  view: string;
  title: string;
  rows: Row[];
}

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
  return res.body.data as { token: string; companies: { uid: string; code: string }[] };
}

let admin: Awaited<ReturnType<typeof login>>;
let worker: Awaited<ReturnType<typeof login>>;
let tradeUid: string;
let plantUid: string;

/** Образцы берём из базы: привязываться к конкретным строкам посева нельзя. */
let itemSample: { code: string; name: string };
let partnerSample: { name: string };
/**
 * Образец из компании завода. Рабочий цеха работает только там, и проверять
 * права на образце торгового дома нельзя: такой запрос отсечёт RLS, и тест
 * останется зелёным, даже если проверку прав выкинуть целиком.
 */
let plantItem: { code: string };
let plantPartner: { name: string };
let tradeOrder: { number: string };
let plantOrder: { number: string };

const search = (q: string, s: typeof admin, companyUid = tradeUid, locale = 'ru') =>
  api(`/api/v1/search?q=${encodeURIComponent(q)}`, {
    headers: {
      Authorization: `Bearer ${s.token}`,
      'X-Company-Id': companyUid,
      'Accept-Language': locale,
    },
  });

const groups = (body: any): Group[] => (body?.data?.groups ?? []) as Group[];
const kinds = (body: any) => groups(body).map((g) => g.kind);
const rowsOf = (body: any, kind: string) => groups(body).find((g) => g.kind === kind)?.rows ?? [];

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [PrismaModule, AuthModule, SearchModule],
    providers: [
      { provide: APP_GUARD, useClass: AuthGuard },
      { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
      { provide: APP_FILTER, useClass: ErrorFilter },
    ],
  }).compile();

  app = moduleRef.createNestApplication();
  app.use(new ContextMiddleware().use.bind(new ContextMiddleware()));
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();

  admin = await login('admin');
  worker = await login('r.tursunov');
  tradeUid = admin.companies.find((c) => c.code === 'trade')!.uid;
  plantUid = admin.companies.find((c) => c.code === 'plant')!.uid;

  db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  const one = async (sql: string) => (await db.query(sql)).rows[0];
  itemSample = await one(
    `SELECT i.code, i.name_ru AS name FROM item i
       JOIN company c ON c.id = i.company_id
      WHERE c.code = 'trade' AND i.is_active ORDER BY i.id LIMIT 1`,
  );
  partnerSample = await one(
    `SELECT p.name_ru AS name FROM partner p
       JOIN company c ON c.id = p.company_id
      WHERE c.code = 'trade' AND p.is_active ORDER BY p.id LIMIT 1`,
  );
  tradeOrder = await one(
    `SELECT o.number FROM sales_order o
       JOIN company c ON c.id = o.company_id
      WHERE c.code = 'trade' ORDER BY o.id LIMIT 1`,
  );
  plantOrder = await one(
    `SELECT o.number FROM production_order o
       JOIN company c ON c.id = o.company_id
      WHERE c.code = 'plant' ORDER BY o.id LIMIT 1`,
  );
  plantItem = await one(
    `SELECT i.code FROM item i
       JOIN company c ON c.id = i.company_id
      WHERE c.code = 'plant' AND i.is_active ORDER BY i.id LIMIT 1`,
  );
  plantPartner = await one(
    `SELECT p.name_ru AS name FROM partner p
       JOIN company c ON c.id = p.company_id
      WHERE c.code = 'plant' AND p.is_active ORDER BY p.id LIMIT 1`,
  );
});

afterAll(async () => {
  await db?.end().catch(() => null);
  await app?.close();
});

describe('поиск по всей системе', () => {
  it('находит номенклатуру по коду', async () => {
    const res = await search(itemSample.code, admin);
    expect(res.status).toBe(200);
    const rows = rowsOf(res.body, 'item');
    expect(rows.length, `по коду ${itemSample.code} ничего`).toBeGreaterThan(0);
    expect(rows.some((r) => r.subtitle?.includes(itemSample.code) || r.title.includes(itemSample.code))).toBe(true);
  });

  it('находит номенклатуру по куску названия', async () => {
    const part = itemSample.name.split(' ').find((w) => w.length >= 4) ?? itemSample.name;
    const rows = rowsOf((await search(part, admin)).body, 'item');
    expect(rows.length, `по слову «${part}» ничего`).toBeGreaterThan(0);
  });

  it('находит контрагента по куску названия', async () => {
    const part = partnerSample.name.split(' ').find((w) => w.length >= 4) ?? partnerSample.name;
    const rows = rowsOf((await search(part, admin)).body, 'partner');
    expect(rows.length, `по слову «${part}» контрагентов нет`).toBeGreaterThan(0);
  });

  it('находит заказ продаж по номеру', async () => {
    const rows = rowsOf((await search(tradeOrder.number, admin)).body, 'salesOrder');
    expect(rows.map((r) => r.title)).toContain(tradeOrder.number);
  });

  it('находит сотрудника по фамилии — но только тому, кто ведёт людей', async () => {
    const res = await search('Турсунов', admin);
    expect(rowsOf(res.body, 'user').length).toBeGreaterThan(0);
  });

  it('каждая группа говорит, в какой раздел и на какую вкладку вести', async () => {
    const res = await search(itemSample.code, admin);
    for (const g of groups(res.body)) {
      expect(g.module, `группа ${g.kind} без раздела`).toBeTruthy();
      expect(g.view, `группа ${g.kind} без вкладки`).toBeTruthy();
      expect(g.title, `группа ${g.kind} без заголовка`).toBeTruthy();
    }
  });

  it('клиент ведёт на вкладку клиентов, а не на первую попавшуюся', async () => {
    const part = partnerSample.name.split(' ').find((w) => w.length >= 4) ?? partnerSample.name;
    const g = groups((await search(part, admin)).body).find((x) => x.kind === 'partner');
    expect(g?.module).toBe('crm');
    expect(g?.view).toBe('partners');
  });
});

describe('поиск не обходит права', () => {
  it('рабочему цеха не выдаёт номенклатуру своего же завода', async () => {
    // Сначала убеждаемся, что запись вообще находится, — иначе «не выдаёт»
    // окажется правдой по той причине, что искать было нечего.
    expect(rowsOf((await search(plantItem.code, admin, plantUid)).body, 'item').length)
      .toBeGreaterThan(0);
    const res = await search(plantItem.code, worker, plantUid);
    expect(res.status).toBe(200);
    expect(kinds(res.body)).not.toContain('item');
  });

  it('рабочему цеха не выдаёт контрагентов своего же завода', async () => {
    const part = plantPartner.name.split(' ').find((w) => w.length >= 4) ?? plantPartner.name;
    expect(rowsOf((await search(part, admin, plantUid)).body, 'partner').length)
      .toBeGreaterThan(0);
    expect(kinds((await search(part, worker, plantUid)).body)).not.toContain('partner');
  });

  it('рабочему цеха не выдаёт сотрудников', async () => {
    const res = await search('Турсунов', worker, plantUid);
    expect(kinds(res.body)).not.toContain('user');
  });

  it('директору сотрудников тоже не выдаёт: людей ведёт администратор', async () => {
    const director = await login('s.radjabov');
    const res = await search('Турсунов', director);
    expect(kinds(res.body)).not.toContain('user');
  });
});

describe('поиск не обходит компанию', () => {
  it('заказ завода не находится из торгового дома', async () => {
    const here = rowsOf((await search(plantOrder.number, admin, tradeUid)).body, 'productionOrder');
    expect(here.map((r) => r.title)).not.toContain(plantOrder.number);
    const there = rowsOf((await search(plantOrder.number, admin, plantUid)).body, 'productionOrder');
    expect(there.map((r) => r.title), 'на заводе заказ тоже не нашёлся').toContain(plantOrder.number);
  });
});

describe('поиск под узбекским', () => {
  it('заголовки групп не остаются русскими', async () => {
    const res = await search(itemSample.code, admin, tradeUid, 'uz');
    const titles = groups(res.body).map((g) => g.title);
    expect(titles.length).toBeGreaterThan(0);
    const cyr = titles.filter((t) => CYR.test(t));
    expect(cyr, `заголовки по-русски: ${cyr.join(', ')}`).toHaveLength(0);
  });
});

describe('запрос короче двух знаков', () => {
  it('отклоняется, а не поднимает всю базу', async () => {
    const res = await search('а', admin);
    expect(res.status).toBe(400);
  });
});
