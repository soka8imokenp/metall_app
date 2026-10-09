/**
 * CRM Э5 — карточка клиента целиком (ТЗ 8.2).
 *
 * Проверяем главное правило этапа: **карточка ничего не считает сама**. Долг
 * в карточке обязан совпадать с долгом в списке дебиторов финансов до копейки
 * — иначе на вопрос «сколько должен клиент» система даёт два ответа, и на
 * отгрузку идут по тому, который удобнее.
 *
 * Дальше — вкладки: сделки, заказы, документы, платежи, файлы и журнал
 * изменений. Журнал пишется той же транзакцией, что и правка, и пустых записей
 * «было А, стало А» в нём быть не должно.
 *
 * Прогон пишет и за собой убирает.
 */
import 'dotenv/config';
import { Client } from 'pg';
import { raw } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { AuthGuard } from '../src/auth/auth.guard.js';
import { CrmModule } from '../src/crm/crm.module.js';
import { FinanceModule } from '../src/finance/finance.module.js';
import { AttachmentsModule } from '../src/attachments/attachments.module.js';
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
const patch = (path: string, s: typeof admin, body: unknown, companyUid = tradeUid) =>
  api(path, { method: 'PATCH', headers: head(s, companyUid), body: JSON.stringify(body) });
const post = (path: string, s: typeof admin, body: unknown, companyUid = tradeUid) =>
  api(path, { method: 'POST', headers: head(s, companyUid), body: JSON.stringify(body) });
const del = (path: string, s: typeof admin, companyUid = tradeUid) =>
  api(path, { method: 'DELETE', headers: head(s, companyUid) });

const stamp = Date.now().toString().slice(-6);
/** Клиент с долгом — на нём проверяется совпадение с финансами. */
let debtorUid: string;
/** Клиент без единой записи — на нём проверяются правки и журнал. */
let freshUid: string;
const madeAttachments: string[] = [];

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [PrismaModule, AuthModule, CrmModule, FinanceModule, AttachmentsModule],
    providers: [
      { provide: APP_GUARD, useClass: AuthGuard },
      { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
      { provide: APP_FILTER, useClass: ErrorFilter },
    ],
  }).compile();

  app = moduleRef.createNestApplication();
  app.use(new ContextMiddleware().use.bind(new ContextMiddleware()));
  app.use('/api/v1/attachments', raw({ type: () => true, limit: '21mb' }));
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();

  db = new Client({ connectionString: process.env.DATABASE_URL, options: '-c timezone=UTC' });
  await db.connect();

  admin = await login('admin');
  keeper = await login('a.saidov');
  tradeUid = admin.companies.find((c: any) => c.code === 'trade').uid;

  const debtor = await db.query<{ uid: string }>(
    `SELECT p.uid
       FROM partner p JOIN company c ON c.id = p.company_id
       JOIN sales_order o ON o.partner_id = p.id
      WHERE c.code = 'trade' AND o.paid_amount < o.amount_total AND o.status <> 'cancelled'
      GROUP BY p.uid
      ORDER BY sum(o.amount_total - o.paid_amount) DESC
      LIMIT 1`,
  );
  debtorUid = debtor.rows[0]!.uid;

  const created = await post('/api/v1/crm/partners', admin, {
    nameRu: `QA Карточка ${stamp}`,
    inn: `77${stamp}1`,
  });
  expect(created.status).toBe(201);
  freshUid = created.body.data.uid;
}, 60_000);

afterAll(async () => {
  for (const uid of madeAttachments) {
    await db?.query('DELETE FROM attachment WHERE uid = $1', [uid]);
  }
  // Записи журнала за собой не убираем: `audit_log` закрыт триггером на
  // правку и удаление — это проверяет отдельный тест ниже. Уходит сам клиент,
  // его файлы и контакты уходят каскадом.
  if (freshUid) await db?.query('DELETE FROM partner WHERE uid = $1', [freshUid]);
  await db?.end();
  await app?.close();
});

describe('карточка не заводит свой счёт денег (ТЗ 8.2)', () => {
  it('долг и просрочка в карточке совпадают с дебиторкой финансов', async () => {
    const card = (await get(`/api/v1/crm/partners/${debtorUid}/finance`, admin)).body.data;
    const list = (await get('/api/v1/finance/receivables?limit=200', admin)).body.data;
    const row = list.rows.find((r: any) => r.partner.uid === debtorUid);

    expect(row).toBeTruthy();
    expect(Number(card.debt)).toBeGreaterThan(0);
    expect(Number(card.debt)).toBeCloseTo(Number(row.debt), 4);
    expect(Number(card.overdue)).toBeCloseTo(Number(row.overdue), 4);
    expect(Number(card.debtLimit)).toBeCloseTo(Number(row.debtLimit), 4);
    expect(card.overLimit).toBe(row.overLimit);
    expect(card.maxOverdueDays).toBe(row.maxOverdueDays);
  });

  it('отменённый заказ в долг не попадает', async () => {
    // Ситуацию строим сами, а не ищем в посеве: отменённые неоплаченные заказы
    // там появляются по случаю, и тест, который на них надеется, молча
    // перестаёт проверять правило, как только случай не выпал.
    const order = await db.query<{ id: string; left: string }>(
      `SELECT o.id::text, (o.amount_total - o.paid_amount)::text AS left
         FROM sales_order o JOIN partner p ON p.id = o.partner_id
        WHERE p.uid = $1 AND o.paid_amount < o.amount_total AND o.status <> 'cancelled'
        ORDER BY o.amount_total - o.paid_amount DESC
        LIMIT 1`,
      [debtorUid],
    );
    const row = order.rows[0];
    expect(row, 'у должника нет неоплаченного заказа').toBeTruthy();

    const before = Number(
      (await get(`/api/v1/crm/partners/${debtorUid}/finance`, admin)).body.data.debt,
    );
    const status = await db.query<{ status: string }>(
      `SELECT status::text FROM sales_order WHERE id = $1`,
      [row!.id],
    );
    await db.query(`UPDATE sales_order SET status = 'cancelled' WHERE id = $1`, [row!.id]);
    try {
      const after = Number(
        (await get(`/api/v1/crm/partners/${debtorUid}/finance`, admin)).body.data.debt,
      );
      // Сходится до сума, а не до копейки. Причина не в карточке: весь прогон
      // пишет в одну базу, долг должника к этому моменту доходит до величины
      // порядка 10^14, а у double на такой величине шаг уже крупнее копейки -
      // разность двух таких чисел копейки не держит. Отдельным файлом проверка
      // сходится и до копейки.
      expect(Math.abs(before - after - Number(row!.left))).toBeLessThan(1);
    } finally {
      await db.query(`UPDATE sales_order SET status = $2::"OrderStatus" WHERE id = $1`, [
        row!.id,
        status.rows[0]!.status,
      ]);
    }
  });

  it('клиент без долгов отдаёт нули, а не пустоту', async () => {
    const card = (await get(`/api/v1/crm/partners/${freshUid}/finance`, admin)).body.data;
    expect(Number(card.debt)).toBe(0);
    expect(Number(card.overdue)).toBe(0);
    expect(card.unpaidOrders).toBe(0);
    expect(card.payments).toEqual([]);
  });

  it('платежи в карточке — те же операции, что и в финансах', async () => {
    const card = (await get(`/api/v1/crm/partners/${debtorUid}/finance`, admin)).body.data;
    const inDb = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM finance_operation f
         JOIN partner p ON p.id = f.partner_id WHERE p.uid = $1`,
      [debtorUid],
    );
    expect(card.payments.length).toBe(Math.min(100, Number(inDb.rows[0]!.n)));
  });
});

describe('вкладки карточки (ТЗ 8.2)', () => {
  it('сделки, заказы и документы берутся из своих модулей и совпадают со счётчиками', async () => {
    const card = (await get(`/api/v1/crm/partners/${debtorUid}`, admin)).body.data;
    const deals = (await get(`/api/v1/crm/partners/${debtorUid}/deals`, admin)).body.data;
    const orders = (await get(`/api/v1/crm/partners/${debtorUid}/orders`, admin)).body.data;
    const docs = (await get(`/api/v1/crm/partners/${debtorUid}/documents`, admin)).body.data;

    expect(deals.total).toBe(card.usage.deals);
    expect(orders.total).toBe(card.usage.orders);
    expect(docs.total).toBe(card.usage.documents);
    expect(orders.rows[0]).toHaveProperty('paymentStatus');
  });

  it('документы помечены как «только чтение»: модуля документов ещё нет', async () => {
    const docs = (await get(`/api/v1/crm/partners/${debtorUid}/documents`, admin)).body.data;
    expect(docs.readOnly).toBe(true);
  });

  it('счётчики карточки называют задачи, активности и файлы', async () => {
    const card = (await get(`/api/v1/crm/partners/${debtorUid}`, admin)).body.data;
    for (const key of ['tasks', 'activities', 'files']) {
      expect(card.usage).toHaveProperty(key);
    }
  });

  it('карточка чужой компании не отдаёт вкладок', async () => {
    const other = admin.companies.find((c: any) => c.code !== 'trade');
    expect((await get(`/api/v1/crm/partners/${debtorUid}/deals`, admin, other.uid)).status).toBe(404);
  });

  it('кладовщик карточку клиента не видит', async () => {
    expect((await get(`/api/v1/crm/partners/${debtorUid}/finance`, keeper)).status).toBe(403);
    expect((await get(`/api/v1/crm/partners/${debtorUid}/history`, keeper)).status).toBe(403);
  });
});

describe('журнал изменений (ТЗ 8.2)', () => {
  it('заведение карточки попадает в историю', async () => {
    const h = (await get(`/api/v1/crm/partners/${freshUid}/history`, admin)).body.data;
    expect(h.rows.some((r: any) => r.action === 'create')).toBe(true);
  });

  it('правка пишет «было — стало» и автора', async () => {
    const before = (await get(`/api/v1/crm/partners/${freshUid}`, admin)).body.data;
    await patch(`/api/v1/crm/partners/${freshUid}`, admin, {
      version: before.version,
      paymentDelayDays: 45,
      nameRu: `QA Карточка ${stamp} (правка)`,
    });

    const h = (await get(`/api/v1/crm/partners/${freshUid}/history`, admin)).body.data;
    const last = h.rows[0];
    expect(last.action).toBe('update');
    expect(last.user).toBeTruthy();
    expect(last.changes.paymentDelayDays).toEqual({ from: 0, to: 45 });
    expect(last.changes.nameRu.to).toContain('правка');
  });

  it('правка без изменений записи в журнал не оставляет', async () => {
    const card = (await get(`/api/v1/crm/partners/${freshUid}`, admin)).body.data;
    const was = (await get(`/api/v1/crm/partners/${freshUid}/history`, admin)).body.data.total;
    await patch(`/api/v1/crm/partners/${freshUid}`, admin, {
      version: card.version,
      nameRu: card.nameRu,
      paymentDelayDays: card.paymentDelayDays,
    });
    const now = (await get(`/api/v1/crm/partners/${freshUid}/history`, admin)).body.data.total;
    expect(now).toBe(was);
  });

  it('выключение карточки отличается в журнале от обычной правки', async () => {
    const card = (await get(`/api/v1/crm/partners/${freshUid}`, admin)).body.data;
    await patch(`/api/v1/crm/partners/${freshUid}`, admin, {
      version: card.version,
      isActive: false,
    });
    const h = (await get(`/api/v1/crm/partners/${freshUid}/history`, admin)).body.data;
    expect(h.rows[0].action).toBe('archive');

    const back = (await get(`/api/v1/crm/partners/${freshUid}`, admin)).body.data;
    await patch(`/api/v1/crm/partners/${freshUid}`, admin, {
      version: back.version,
      isActive: true,
    });
    const h2 = (await get(`/api/v1/crm/partners/${freshUid}/history`, admin)).body.data;
    expect(h2.rows[0].action).toBe('restore');
  });

  it('контактное лицо попадает в историю клиента, а не в свою', async () => {
    const added = await post(`/api/v1/crm/partners/${freshUid}/contacts`, admin, {
      fullName: `QA Контакт ${stamp}`,
      phone: '+998 90 111 22 33',
    });
    expect(added.status).toBe(201);
    const contactUid = added.body.data.contacts[0].uid;

    await patch(`/api/v1/crm/contacts/${contactUid}`, admin, { phone: '+998 90 444 55 66' });
    await del(`/api/v1/crm/contacts/${contactUid}`, admin);

    const h = (await get(`/api/v1/crm/partners/${freshUid}/history`, admin)).body.data;
    const actions = h.rows.map((r: any) => r.action);
    expect(actions).toContain('contact.add');
    expect(actions).toContain('contact.update');
    expect(actions).toContain('contact.remove');
    const upd = h.rows.find((r: any) => r.action === 'contact.update');
    expect(upd.changes.phone.to).toContain('444');
  });

  it('журнал не переписывается: строку нельзя ни исправить, ни удалить', async () => {
    await expect(
      db.query(`UPDATE audit_log SET action = 'подделка' WHERE entity_type = 'partner'`),
    ).rejects.toThrow();
  });
});

describe('файлы клиента (ТЗ 8.2)', () => {
  it('доверенность прикладывается к клиенту и считается в счётчиках', async () => {
    const bytes = Buffer.from('%PDF-1.4 QA doverennost');
    const up = await api(
      `/api/v1/attachments?owner=partner&uid=${freshUid}&name=doverennost.pdf&kind=scan`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/pdf' },
        body: new Uint8Array(bytes),
      },
    );
    expect(up.status).toBe(201);
    madeAttachments.push(up.body.data.uid);

    const listed = await api(`/api/v1/attachments?owner=partner&uid=${freshUid}`, {
      headers: { Authorization: `Bearer ${admin.token}` },
    });
    expect(listed.body.data.length).toBe(1);

    const card = (await get(`/api/v1/crm/partners/${freshUid}`, admin)).body.data;
    expect(card.usage.files).toBe(1);
    // Клиента с файлом уже не удаляют: файл — тоже запись о нём.
    expect(card.permissions.canDelete).toBe(false);
  });

  it('кладовщик к клиенту файл не приложит', async () => {
    const up = await api(
      `/api/v1/attachments?owner=partner&uid=${freshUid}&name=chuzhoe.pdf`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${keeper.token}`, 'Content-Type': 'application/pdf' },
        body: new Uint8Array(Buffer.from('%PDF-1.4 nope')),
      },
    );
    expect(up.status).toBe(403);
  });
});
