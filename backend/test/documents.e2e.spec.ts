/**
 * Документы Э1 — реестр на живом API (ТЗ 7.1, 7.5).
 *
 * Проверяем то, ради чего экран снимали с фикстур: список фильтруется по типу,
 * статусу, контрагенту, периоду и номеру; счётчики по статусам не зависят от
 * выбранного статуса; карточка называет источник, из которого документ сделан,
 * и число приложенных файлов; чужая компания не видна; без права
 * `documents.view` реестр закрыт.
 *
 * Прогон ничего не пишет.
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
import { DocumentsModule } from '../src/documents/documents.module.js';
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
let tradeUid: string;
let plantUid: string;

const head = (s: Awaited<ReturnType<typeof login>>, companyUid?: string) => ({
  Authorization: `Bearer ${s.token}`,
  'Content-Type': 'application/json',
  ...(companyUid ? { 'X-Company-Id': companyUid } : {}),
});

const get = (path: string, s: typeof admin, companyUid = tradeUid) =>
  api(path, { headers: head(s, companyUid) });

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [PrismaModule, AuthModule, DocumentsModule],
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

  admin = await login('admin');
  keeper = await login('a.saidov');
  tradeUid = admin.companies.find((c: any) => c.code === 'trade').uid;
  plantUid = admin.companies.find((c: any) => c.code === 'plant').uid;
}, 60_000);

afterAll(async () => {
  await db?.end();
  await app?.close();
});

describe('реестр документов (ТЗ 7.5)', () => {
  it('список отдаёт документы своей компании со счётчиками по статусам', async () => {
    const res = await get('/api/v1/documents?limit=10', admin);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.rows.length).toBeGreaterThan(0);
    expect(d.total).toBeGreaterThan(d.rows.length);

    // Счётчики сходятся с итогом: иначе на экране два разных числа.
    const sum = Object.values(d.byStatus as Record<string, number>).reduce(
      (a, b) => a + b,
      0,
    );
    expect(sum).toBe(d.total);

    for (const r of d.rows) {
      expect(r.company.code).toBe('trade');
      expect(r.number).toBeTruthy();
      expect(r.type.nameRu).toBeTruthy();
    }
  });

  it('счётчик по статусу не пропадает, когда этот статус выбран фильтром', async () => {
    const all = (await get('/api/v1/documents?limit=1', admin)).body.data;
    const status = Object.keys(all.byStatus)[0]!;
    const only = (await get(`/api/v1/documents?status=${status}&limit=200`, admin)).body.data;

    // Фильтр сузил список, но счётчики остались прежними — иначе, нажав
    // «на согласовании», человек перестал бы видеть, сколько документов в
    // остальных статусах.
    expect(only.byStatus).toEqual(all.byStatus);
    expect(only.total).toBe(all.byStatus[status]);
    expect(only.rows.every((r: any) => r.status === status)).toBe(true);
  });

  it('фильтр по типу и по номеру сужают список, а не подменяют его', async () => {
    const types = (await get('/api/v1/documents/types', admin)).body.data.rows;
    const type = types.find((t: any) => t.company.uid === tradeUid && t.usage.documents > 0);
    expect(type, 'ни по одному типу нет документов').toBeTruthy();

    const byType = (await get(`/api/v1/documents?typeUid=${type.uid}&limit=200`, admin)).body.data;
    expect(byType.rows.every((r: any) => r.type.uid === type.uid)).toBe(true);
    expect(byType.total).toBe(type.usage.documents);

    const one = byType.rows[0];
    const bySearch = (await get(`/api/v1/documents?search=${encodeURIComponent(one.number)}`, admin))
      .body.data;
    expect(bySearch.rows.some((r: any) => r.uid === one.uid)).toBe(true);
  });

  it('фильтр по периоду отсекает по дате документа', async () => {
    const all = (await get('/api/v1/documents?limit=200', admin)).body.data;
    const dates = all.rows.map((r: any) => String(r.documentDate).slice(0, 10)).sort();
    const from = dates[Math.floor(dates.length / 2)]!;

    const cut = (await get(`/api/v1/documents?from=${from}&limit=200`, admin)).body.data;
    expect(cut.rows.every((r: any) => String(r.documentDate).slice(0, 10) >= from)).toBe(true);
    expect(cut.total).toBeLessThanOrEqual(all.total);
  });

  it('карточка называет источник документа и ведёт к нему по uid', async () => {
    const row = (await get('/api/v1/documents?limit=50', admin)).body.data.rows.find(
      (r: any) => r.source !== null,
    );
    expect(row, 'ни один документ не сделан из источника').toBeTruthy();

    const card = (await get(`/api/v1/documents/${row.uid}`, admin)).body.data;
    expect(card.uid).toBe(row.uid);
    expect(card.source.kind).toBe('sales_order');
    expect(card.source.number).toBeTruthy();

    // Источник существует, и это тот самый заказ, а не просто непустое поле.
    const q = await db.query<{ number: string }>(
      `SELECT so.number FROM sales_order so WHERE so.uid = $1`,
      [card.source.uid],
    );
    expect(q.rows[0]?.number).toBe(card.source.number);
  });

  it('сумма и контрагент берутся из документа, а не из живого заказа', async () => {
    const row = (await get('/api/v1/documents?limit=50', admin)).body.data.rows.find(
      (r: any) => r.source?.kind === 'sales_order' && r.amountTotal !== null,
    );
    expect(row, 'нет документа по заказу с суммой').toBeTruthy();

    const q = await db.query<{ amount_total: string; partner_uid: string }>(
      `SELECT d.amount_total::text, p.uid::text AS partner_uid
         FROM document d LEFT JOIN partner p ON p.id = d.partner_id
        WHERE d.uid = $1`,
      [row.uid],
    );
    expect(row.amountTotal).toBe(q.rows[0]!.amount_total);
    expect(row.partner?.uid ?? null).toBe(q.rows[0]!.partner_uid);
  });

  it('число приложенных файлов в карточке равно тому, что лежит в базе', async () => {
    const row = (await get('/api/v1/documents?limit=50', admin)).body.data.rows[0];
    const q = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM attachment a
        JOIN document d ON d.id = a.document_id WHERE d.uid = $1`,
      [row.uid],
    );
    expect(row.files).toBe(Number(q.rows[0]!.n));
  });

  it('документы другой компании в чужой выборке не появляются', async () => {
    const trade = (await get('/api/v1/documents?limit=200', admin, tradeUid)).body.data;
    const plant = (await get('/api/v1/documents?limit=200', admin, plantUid)).body.data;
    const tradeUids = new Set(trade.rows.map((r: any) => r.uid));
    expect(plant.rows.every((r: any) => !tradeUids.has(r.uid))).toBe(true);
    expect(plant.rows.every((r: any) => r.company.code === 'plant')).toBe(true);
  });

  it('несуществующий документ — 404, а не пустая карточка', async () => {
    const res = await get('/api/v1/documents/00000000-0000-4000-8000-000000000000', admin);
    expect(res.status).toBe(404);
  });

  it('компания названа именем, а не кодом: на карточке «plant» человеку ничего не говорит', async () => {
    const d = (await get('/api/v1/documents?limit=1', admin)).body.data.rows[0];
    expect(d.company.nameRu, 'название компании не пришло').toBeTruthy();
    expect(d.company.nameRu).not.toBe(d.company.code);
    expect(d.company.nameUz).toBeTruthy();
  });

  it('без права documents.view реестр закрыт', async () => {
    expect(keeper.permissions.includes('documents.view')).toBe(false);
    expect((await get('/api/v1/documents', keeper)).status).toBe(403);
    expect((await get('/api/v1/documents/types', keeper)).status).toBe(403);
  });
});

describe('типы документов (ТЗ 7.3)', () => {
  it('тип несёт маску нумерации и число документов по нему', async () => {
    const rows = (await get('/api/v1/documents/types', admin)).body.data.rows;
    expect(rows.length).toBeGreaterThan(0);
    for (const t of rows) {
      expect(t.numberingMask).toContain('{SEQ}');
      expect(typeof t.usage.documents).toBe('number');
    }
    const inv = rows.find((t: any) => t.code === 'INV' && t.company.uid === tradeUid);
    expect(inv).toBeTruthy();
    expect(inv.usage.documents).toBeGreaterThan(0);
  });

  it('фильтр по коду типа берёт документы обеих компаний, а uid — только своей', async () => {
    // Тип документа принадлежит компании: у торгового дома и у завода свой
    // «Счёт» со своей нумерацией. В режиме холдинга выпадающий список
    // фильтра показывал бы «Счёт» дважды, и выбор одного из них прятал бы
    // половину счетов. Поэтому экран фильтрует по коду.
    // Без заголовка X-Company-Id — режим холдинга: видны обе компании.
    const all = (p: string) => api(p, { headers: head(admin) });
    const types = (await all('/api/v1/documents/types')).body.data.rows;
    const invs = types.filter((t: any) => t.code === 'INV');
    expect(invs.length, 'счёт заведён не в двух компаниях — проверка бессмысленна').toBe(2);

    const byCode = (await all('/api/v1/documents?typeCode=INV&limit=200')).body.data;
    expect(byCode.rows.length).toBeGreaterThan(0);
    for (const d of byCode.rows) expect(d.type.code).toBe('INV');

    const companies = new Set(byCode.rows.map((d: any) => d.company.uid));
    expect(companies.size, 'по коду пришли счета только одной компании').toBe(2);

    const trade = invs.find((t: any) => t.company.uid === tradeUid);
    const byUid = (await all(`/api/v1/documents?typeUid=${trade.uid}&limit=200`)).body.data;
    expect(byUid.rows.length).toBeGreaterThan(0);
    for (const d of byUid.rows) expect(d.company.uid).toBe(tradeUid);
    expect(byUid.total).toBeLessThan(byCode.total);
  });
});
