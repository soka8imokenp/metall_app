/**
 * Документы Э2 — типы и нумерация на запись (ТЗ 7.3).
 *
 * Проверяем три вещи, каждую отдельно:
 *
 * 1. **Маска.** Без `{SEQ}` номер у всех документов один; незнакомая
 *    подстановка не должна уехать на бумагу текстом; счётчик, который
 *    сбрасывается по периоду, обязан этот период показывать.
 * 2. **Что заморожено.** Код типа и область счётчика — с первого выданного
 *    номера. Маска — нет: она действует вперёд, уже выданные номера не
 *    переписываются.
 * 3. **Выдача номера.** Пять одновременных выдач дают пять разных номеров,
 *    и счётчик в базе не расходится с тем, что уже напечатано.
 *
 * Прогон пишет в базу разработки: заводит свой тип с кодом `TESTQ` и убирает
 * его за собой. Чужих типов не трогает.
 */
import 'dotenv/config';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { AuthGuard } from '../src/auth/auth.guard.js';
import { DocumentsModule } from '../src/documents/documents.module.js';
import { NumberingService } from '../src/documents/numbering.service.js';
import { ContextMiddleware } from '../src/common/context.middleware.js';
import { EnvelopeInterceptor } from '../src/common/envelope.interceptor.js';
import { ErrorFilter } from '../src/common/error.filter.js';

let app: INestApplication;
let base: string;
let db: Client;
let prisma: PrismaService;
let numbering: NumberingService;

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
let tradeId: bigint;

const head = (s: typeof admin) => ({
  Authorization: `Bearer ${s.token}`,
  'Content-Type': 'application/json',
  'X-Company-Id': tradeUid,
});

const get = (path: string, s = admin) => api(path, { headers: head(s) });
const post = (path: string, body: unknown, s = admin) =>
  api(path, { method: 'POST', headers: head(s), body: JSON.stringify(body) });
const patch = (path: string, body: unknown, s = admin) =>
  api(path, { method: 'PATCH', headers: head(s), body: JSON.stringify(body) });
const del = (path: string, s = admin) => api(path, { method: 'DELETE', headers: head(s) });

/** Типы, заведённые прогоном: убираем за собой, чем бы он ни кончился. */
const mine: string[] = [];

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

  prisma = moduleRef.get(PrismaService);
  numbering = moduleRef.get(NumberingService);

  db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  admin = await login('admin');
  keeper = await login('a.saidov');
  tradeUid = admin.companies.find((c: any) => c.code === 'trade').uid;
  tradeId = (await db.query(`SELECT id FROM company WHERE code = 'trade'`)).rows[0].id;
}, 60_000);

afterAll(async () => {
  for (const uid of mine) {
    await db.query(
      `DELETE FROM document_counter WHERE document_type_id = (SELECT id FROM document_type WHERE uid = $1)`,
      [uid],
    );
    await db.query(`DELETE FROM document_type WHERE uid = $1`, [uid]);
  }
  await db?.end();
  await app?.close();
});

const makeType = async (over: Record<string, unknown> = {}) => {
  const res = await post('/api/v1/documents/types', {
    code: 'TESTQ',
    nameRu: 'Проверочный тип',
    nameUz: 'Tekshiruv turi',
    numberingMask: 'ПР-{YY}/{SEQ}',
    ...over,
  });
  if (res.status === 201 || res.status === 200) mine.push(res.body.data.uid);
  return res;
};

describe('маска номера (ТЗ 7.3)', () => {
  it('маска без {SEQ} не принимается: иначе у всех документов один номер', async () => {
    const res = await makeType({ numberingMask: 'ПР-{YY}' });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('{SEQ}');
  });

  it('незнакомая подстановка названа в ответе, а не уезжает в номер текстом', async () => {
    const res = await makeType({ numberingMask: 'ПР-{YYY}/{SEQ}' });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('{YYY}');
    expect(res.body.error.message).toContain('{YYYY}');
  });

  it('два счётчика в одной маске не принимаются', async () => {
    const res = await makeType({ numberingMask: 'ПР-{SEQ}-{SEQ}' });
    expect(res.status).toBe(422);
  });

  it('периодический счётчик без года в маске отклоняется с объяснением', async () => {
    // Счётчик обнулится в январе, а в номере этого не видно — повторится
    // номер прошлого года.
    const res = await makeType({ numberingMask: 'ПР-{SEQ}', counterScope: 'company_period' });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/год/i);
  });

  it('сквозной счётчик без года в маске — можно: он не обнуляется', async () => {
    const res = await makeType({ numberingMask: 'ПР-{SEQ}', counterScope: 'company' });
    expect(res.status).toBe(201);
  });

  it('пример номера показывает, что напечатается, и счётчика не двигает', async () => {
    const before = (await get('/api/v1/documents/types')).body.data.rows;
    const res = await get('/api/v1/documents/types/sample?mask=' + encodeURIComponent('СЧ-{YY}/{SEQ:3}'));
    expect(res.status).toBe(200);
    expect(res.body.data.sample).toMatch(/^СЧ-\d{2}\/001$/);
    const after = (await get('/api/v1/documents/types')).body.data.rows;
    expect(after.map((r: any) => r.nextNumber)).toEqual(before.map((r: any) => r.nextNumber));
  });

  it('пример для существующего типа считает от его счётчика, а не от единицы', async () => {
    // Иначе форма правки обещает «СЧ-26/00001», а напечатается «СЧ-26/00072»:
    // человек меняет маску, глядя на число, которого не будет.
    const inv = (await get('/api/v1/documents/types')).body.data.rows.find(
      (r: any) => r.code === 'INV' && r.company.code === 'trade',
    );
    expect(inv.usage.issued).toBeGreaterThan(1);

    const res = await get(
      `/api/v1/documents/types/sample?typeUid=${inv.uid}&mask=${encodeURIComponent('СЧ-{YY}/{SEQ}')}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.data.sample).toBe(inv.nextNumber);

    // Смена маски счётчик не обнуляет: номер тот же, префикс новый.
    const other = await get(
      `/api/v1/documents/types/sample?typeUid=${inv.uid}&mask=${encodeURIComponent('НОВ-{YY}/{SEQ}')}`,
    );
    expect(other.body.data.sample).toBe(inv.nextNumber.replace('СЧ', 'НОВ'));
  });
});

describe('что заморожено у типа (ТЗ 7.3)', () => {
  it('код типа с выданными номерами не меняется, а отказ называет числа', async () => {
    const inv = (await get('/api/v1/documents/types')).body.data.rows.find(
      (r: any) => r.code === 'INV' && r.company.code === 'trade',
    );
    expect(inv, 'счёта нет в справочнике — проверять нечего').toBeTruthy();
    expect(inv.usage.documents).toBeGreaterThan(0);

    const res = await patch(`/api/v1/documents/types/${inv.uid}`, { code: 'INVOICE' });
    expect(res.status).toBe(409);
    expect(res.body.error.details.documents).toBe(inv.usage.documents);
  });

  it('область счётчика с выданными номерами не меняется', async () => {
    const inv = (await get('/api/v1/documents/types')).body.data.rows.find(
      (r: any) => r.code === 'INV' && r.company.code === 'trade',
    );
    expect(inv.usage.issued, 'счётчик пуст — проверка бессмысленна').toBeGreaterThan(0);
    const res = await patch(`/api/v1/documents/types/${inv.uid}`, { counterScope: 'company' });
    expect(res.status).toBe(409);
    expect(res.body.error.details.issued).toBe(inv.usage.issued);
  });

  it('тип с документами не удаляется, но выключается', async () => {
    const rows = (await get('/api/v1/documents/types')).body.data.rows;
    const inv = rows.find((r: any) => r.code === 'INV' && r.company.code === 'trade');

    const res = await del(`/api/v1/documents/types/${inv.uid}`);
    expect(res.status).toBe(409);
    expect(res.body.error.details.documents).toBeGreaterThan(0);

    expect((await patch(`/api/v1/documents/types/${inv.uid}`, { isActive: false })).status).toBe(200);
    const hidden = (await get('/api/v1/documents/types')).body.data.rows;
    expect(hidden.some((r: any) => r.uid === inv.uid)).toBe(false);
    const all = (await get('/api/v1/documents/types?all=true')).body.data.rows;
    expect(all.find((r: any) => r.uid === inv.uid).isActive).toBe(false);

    expect((await patch(`/api/v1/documents/types/${inv.uid}`, { isActive: true })).status).toBe(200);
  });

  it('маску менять можно: она действует вперёд, выданные номера не трогает', async () => {
    const created = await makeType({ code: 'TESTQ2', numberingMask: 'ПР2-{YY}/{SEQ}' });
    expect(created.status).toBe(201);
    const uid = created.body.data.uid;

    const before = (await db.query(`SELECT count(*)::int AS n FROM document`)).rows[0].n;
    expect((await patch(`/api/v1/documents/types/${uid}`, { numberingMask: 'НОВ-{YY}/{SEQ}' })).status).toBe(200);
    const after = (await db.query(`SELECT count(*)::int AS n FROM document`)).rows[0].n;
    expect(after, 'правка маски переписала документы').toBe(before);

    const row = (await get('/api/v1/documents/types')).body.data.rows.find((r: any) => r.uid === uid);
    expect(row.nextNumber).toMatch(/^НОВ-\d{2}\/00001$/);
  });

  it('повторный код в одной компании не принимается', async () => {
    const first = await makeType({ code: 'TESTQ3' });
    expect(first.status).toBe(201);
    const again = await makeType({ code: 'TESTQ3' });
    expect(again.status).toBe(409);
  });

  it('без права refs.edit справочник только на чтение', async () => {
    expect(keeper.permissions.includes('refs.edit')).toBe(false);
    expect(keeper.permissions.includes('documents.view')).toBe(false);
    const res = await post('/api/v1/documents/types', {
      code: 'NOPE', nameRu: 'а', nameUz: 'a', numberingMask: 'X-{SEQ}',
    }, keeper);
    expect(res.status).toBe(403);
  });
});

describe('выдача номера (ТЗ 7.3)', () => {
  it('пять одновременных выдач дают пять разных номеров', async () => {
    const created = await makeType({ code: 'TESTQ4', numberingMask: 'ОД-{YY}/{SEQ}' });
    expect(created.status).toBe(201);
    const t = (await db.query(
      `SELECT id, company_id, code, numbering_mask, counter_scope::text AS scope
         FROM document_type WHERE uid = $1`,
      [created.body.data.uid],
    )).rows[0];

    const type = {
      id: BigInt(t.id),
      companyId: BigInt(t.company_id),
      code: t.code,
      mask: t.numbering_mask,
      scope: t.scope as 'company' | 'company_period',
    };

    // Каждая выдача — своя транзакция, как при пяти одновременных созданиях
    // документа. Читать счётчик и писать обратно тремя действиями здесь
    // означало бы один номер на двоих.
    const numbers = await Promise.all(
      Array.from({ length: 5 }, () =>
        prisma.withContext(null, [BigInt(tradeId)], (tx) =>
          numbering.issue(tx, type, { code: 'trade' }, new Date()),
        ),
      ),
    );

    expect(new Set(numbers).size, `номера повторились: ${numbers.join(', ')}`).toBe(5);
    expect(numbers.every((n) => /^ОД-\d{2}\/\d{5}$/.test(n))).toBe(true);
  });

  it('счётчик в базе не расходится с уже выданными номерами', async () => {
    // Посев записал 240 документов с номерами, а счётчики оставил пустыми.
    // Тогда первый же созданный документ получил бы номер, который в базе
    // уже есть, — и упёрся бы в уникальность.
    const rows = (await get('/api/v1/documents/types?all=true')).body.data.rows;
    for (const t of rows) {
      if (t.usage.documents === 0) continue;
      const taken = await db.query(
        `SELECT 1 FROM document d
           JOIN document_type t ON t.id = d.document_type_id
          WHERE t.uid = $1 AND d.number = $2`,
        [t.uid, t.nextNumber],
      );
      expect(
        taken.rowCount,
        `следующий номер типа ${t.code} (${t.company.code}) — ${t.nextNumber} — уже занят`,
      ).toBe(0);
    }
  });
});
