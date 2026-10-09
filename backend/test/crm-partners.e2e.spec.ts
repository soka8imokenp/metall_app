/**
 * CRM Э1 — клиенты: приложение целиком, живая база (ТЗ 8.2).
 *
 * Проверяем не «маршрут ответил», а правила, ради которых этап делался:
 * один контрагент на обе роли (и покупает, и возит), ИНН уникален в компании,
 * реквизиты не переписываются задним числом, карточка знает, где клиент уже
 * участвует, версия карточки не даёт затереть чужое сохранение, главный
 * контакт ровно один, а клиент с историей выключается, а не удаляется.
 *
 * Прогон пишет и за собой убирает.
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
import { CrmModule } from '../src/crm/crm.module.js';
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

const head = (s: Awaited<ReturnType<typeof login>>, companyUid?: string) => ({
  Authorization: `Bearer ${s.token}`,
  'Content-Type': 'application/json',
  ...(companyUid ? { 'X-Company-Id': companyUid } : {}),
});

const get = (path: string, s: typeof admin, companyUid = tradeUid) =>
  api(path, { headers: head(s, companyUid) });
const post = (path: string, s: typeof admin, body: unknown, companyUid = tradeUid) =>
  api(path, { method: 'POST', headers: head(s, companyUid), body: JSON.stringify(body) });
const patch = (path: string, s: typeof admin, body: unknown, companyUid = tradeUid) =>
  api(path, { method: 'PATCH', headers: head(s, companyUid), body: JSON.stringify(body) });
const del = (path: string, s: typeof admin, companyUid = tradeUid) =>
  api(path, { method: 'DELETE', headers: head(s, companyUid) });

const stamp = Date.now().toString().slice(-6);
const INN = `77${stamp}0`;
const created: string[] = [];

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [PrismaModule, AuthModule, CrmModule],
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
}, 60_000);

afterAll(async () => {
  for (const uid of created) {
    await db?.query('DELETE FROM partner WHERE uid = $1', [uid]);
  }
  await db?.end();
  await app?.close();
});

describe('право на CRM', () => {
  it('у кладовщика нет ни чтения, ни записи, у администратора есть оба', async () => {
    expect(keeper.permissions).not.toContain('crm.view');
    expect(admin.permissions).toContain('crm.view');
    expect(admin.permissions).toContain('crm.edit');

    const read = await get('/api/v1/crm/partners?limit=1', keeper);
    expect(read.status).toBe(403);
  });
});

describe('карточка клиента (ТЗ 8.2)', () => {
  let uid: string;

  it('заводится с реквизитами, условиями работы и тегами', async () => {
    const res = await post('/api/v1/crm/partners', admin, {
      nameRu: `QA Клиент ${stamp}`,
      inn: INN,
      legalAddress: 'г. Ташкент, ул. Проверочная, 1',
      isClient: true,
      isSupplier: true,
      paymentDelayDays: 14,
      debtLimit: 500000000,
      tags: ['Предоплата', 'предоплата', '  ', 'Ключевой'],
    });
    expect(res.status).toBe(201);
    uid = res.body.data.uid;
    created.push(uid);

    expect(res.body.data.inn).toBe(INN);
    expect(res.body.data.paymentDelayDays).toBe(14);
    // Один контрагент на обе роли: завод и покупает, и возит трубу.
    expect(res.body.data.isClient).toBe(true);
    expect(res.body.data.isSupplier).toBe(true);
    // Теги чистятся: без пустых, без дублей, в одном регистре.
    expect([...res.body.data.tags].sort()).toEqual(['ключевой', 'предоплата']);
  });

  it('ИНН в компании уникален: второй такой же не заводится', async () => {
    const res = await post('/api/v1/crm/partners', admin, {
      nameRu: `QA Двойник ${stamp}`,
      inn: INN,
    });
    expect(res.status).toBe(409);
    expect(String(res.body.error.message)).toContain(INN);
  });

  it('находится поиском по ИНН и по названию', async () => {
    const byInn = await get(`/api/v1/crm/partners?search=${INN}`, admin);
    expect(byInn.status).toBe(200);
    expect(byInn.body.data.rows.map((r: any) => r.uid)).toContain(uid);

    const byName = await get(`/api/v1/crm/partners?search=QA Клиент ${stamp}`, admin);
    expect(byName.body.data.rows.map((r: any) => r.uid)).toContain(uid);
  });

  it('правка без версии не принимается, с чужой версией — конфликт', async () => {
    const card = (await get(`/api/v1/crm/partners/${uid}`, admin)).body.data;

    const noVersion = await patch(`/api/v1/crm/partners/${uid}`, admin, { legalAddress: 'иначе' });
    expect(noVersion.status).toBe(422);

    const stale = await patch(`/api/v1/crm/partners/${uid}`, admin, {
      version: card.version + 5,
      legalAddress: 'иначе',
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.details.version).toBe(card.version);

    const ok = await patch(`/api/v1/crm/partners/${uid}`, admin, {
      version: card.version,
      paymentDelayDays: 30,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.data.paymentDelayDays).toBe(30);
    // Версия выросла — следующая правка прежней уже не пройдёт.
    expect(ok.body.data.version).toBe(card.version + 1);
  });

  it('главный контакт ровно один: назначенный вторым снимает первого', async () => {
    let card = (
      await post(`/api/v1/crm/partners/${uid}/contacts`, admin, {
        fullName: 'Азиз Каримов',
        position: 'Снабжение',
        phone: '+998 90 000 00 01',
        isPrimary: true,
      })
    ).body.data;
    expect(card.contacts).toHaveLength(1);

    card = (
      await post(`/api/v1/crm/partners/${uid}/contacts`, admin, {
        fullName: 'Дилноза Юсупова',
        phone: '+998 90 000 00 02',
        isPrimary: true,
      })
    ).body.data;

    const primary = card.contacts.filter((c: any) => c.isPrimary);
    expect(primary).toHaveLength(1);
    expect(primary[0].fullName).toBe('Дилноза Юсупова');

    // Телефон главного контакта виден в списке: звонят из списка, а не из карточки.
    const row = (await get(`/api/v1/crm/partners?search=${INN}`, admin)).body.data.rows[0];
    expect(row.phone).toBe('+998 90 000 00 02');
    expect(row.contactsCount).toBe(2);

    const gone = await del(`/api/v1/crm/contacts/${card.contacts[0].uid}`, admin);
    expect(gone.status).toBe(200);
    expect(gone.body.data.contacts).toHaveLength(1);
  });

  it('клиент без истории удаляется', async () => {
    const res = await post('/api/v1/crm/partners', admin, { nameRu: `QA Пустой ${stamp}` });
    const emptyUid = res.body.data.uid;
    expect(res.body.data.permissions.canDelete).toBe(true);

    const gone = await del(`/api/v1/crm/partners/${emptyUid}`, admin);
    expect(gone.status).toBe(200);
    expect((await get(`/api/v1/crm/partners/${emptyUid}`, admin)).status).toBe(404);
  });
});

describe('клиент с историей', () => {
  let uid: string;
  let usedUid: string;

  it('карточка показывает, где он уже участвует', async () => {
    /**
     * Берём того, у кого история точно есть: контрагент из демо-заказов —
     * и обязательно из той компании, которой смотрит этот прогон. Без
     * условия по компании запрос однажды выдал клиента соседней компании, и
     * карточка честно ответила «нет такого»: проверка краснела не по делу,
     * а от того, у кого в этом посеве заказов оказалось больше.
     */
    const rows = await db.query<{ uid: string; n: string }>(
      `SELECT p.uid, count(o.id) AS n
         FROM partner p
         JOIN sales_order o ON o.partner_id = p.id
         JOIN company c ON c.id = p.company_id
        WHERE c.uid = $1
        GROUP BY p.uid ORDER BY count(o.id) DESC LIMIT 1`,
      [tradeUid],
    );
    if (!rows.rows[0])
      throw new Error('в компании нет клиента с заказами: истории не на кого смотреть');
    usedUid = rows.rows[0]!.uid;

    const card = (await get(`/api/v1/crm/partners/${usedUid}`, admin, undefined)).body.data;
    expect(card.usage.orders).toBeGreaterThan(0);
    expect(card.usage.total).toBeGreaterThan(0);
    expect(card.permissions.canDelete).toBe(false);
  });

  it('не удаляется, а выключается', async () => {
    const card = (await get(`/api/v1/crm/partners/${usedUid}`, admin, undefined)).body.data;

    const forbidden = await del(`/api/v1/crm/partners/${usedUid}`, admin, undefined);
    expect(forbidden.status).toBe(409);
    expect(String(forbidden.body.error.message)).toContain('выключают, а не удаляют');

    const off = await patch(
      `/api/v1/crm/partners/${usedUid}`,
      admin,
      { version: card.version, isActive: false },
      undefined,
    );
    expect(off.status).toBe(200);
    expect(off.body.data.isActive).toBe(false);
    // Выключенного нет в обычном списке и видно с `all=true`.
    const plain = await get('/api/v1/crm/partners?limit=200', admin, undefined);
    expect(plain.body.data.rows.map((r: any) => r.uid)).not.toContain(usedUid);
    const all = await get('/api/v1/crm/partners?limit=200&all=true', admin, undefined);
    expect(all.body.data.rows.map((r: any) => r.uid)).toContain(usedUid);

    await patch(
      `/api/v1/crm/partners/${usedUid}`,
      admin,
      { version: off.body.data.version, isActive: true },
      undefined,
    );
  });

  it('ИНН у клиента с отгрузками и платежами не переписывается', async () => {
    const card = (await get(`/api/v1/crm/partners/${usedUid}`, admin, undefined)).body.data;
    const res = await patch(
      `/api/v1/crm/partners/${usedUid}`,
      admin,
      { version: card.version, inn: `99${stamp}9` },
      undefined,
    );
    if (card.usage.moves + card.usage.payments + card.usage.documents > 0) {
      expect(res.status).toBe(422);
      expect(String(res.body.error.message)).toContain('ИНН не сменить');
    } else {
      expect(res.status).toBe(200);
    }
  });

  it('подбор для формы карточки отдаёт менеджеров, источники и типы цен', async () => {
    const res = await get('/api/v1/crm/partners/options', admin);
    expect(res.status).toBe(200);
    expect(res.body.data.managers.length).toBeGreaterThan(0);
    expect(res.body.data.sources.length).toBeGreaterThan(0);
    expect(res.body.data.priceTypes.length).toBeGreaterThan(0);
    // Наружу уходит uid, а не внутренний номер строки.
    expect(String(res.body.data.sources[0].uid)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('название компании отдаёт сервер: и в подборе, и в карточке', async () => {
    // Раньше «Завод» и «Торговый дом» были вписаны в экран: узбекская версия
    // получала русские слова, а переименование компании их не меняло.
    const opts = await get('/api/v1/crm/partners/options', admin);
    expect(opts.body.data.companies.length).toBeGreaterThan(0);
    const trade = opts.body.data.companies.find((c: any) => c.uid === tradeUid);
    expect(trade.nameRu.length).toBeGreaterThan(2);
    expect(trade.nameUz.length).toBeGreaterThan(2);

    const list = await get('/api/v1/crm/partners?limit=1', admin);
    const card = await get(`/api/v1/crm/partners/${list.body.data.rows[0].uid}`, admin);
    expect(list.body.data.rows[0].company.nameRu).toBe(trade.nameRu);
    expect(card.body.data.company.nameRu).toBe(trade.nameRu);
    expect(card.body.data.company.nameUz).toBe(trade.nameUz);
  });

  it('чужая компания не видна: клиент завода не открывается под заголовком торгового дома', async () => {
    const plantOnly = await db.query<{ uid: string }>(
      `SELECT p.uid FROM partner p JOIN company c ON c.id = p.company_id
        WHERE c.code = 'plant' LIMIT 1`,
    );
    if (plantOnly.rows.length === 0) return;
    const res = await get(`/api/v1/crm/partners/${plantOnly.rows[0]!.uid}`, admin, tradeUid);
    expect(res.status).toBe(404);
  });
});
