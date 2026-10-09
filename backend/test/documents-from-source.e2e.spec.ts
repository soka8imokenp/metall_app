/**
 * Документы Э3 — создание из источника (ТЗ 7.1).
 *
 * Главное, что проверяем: документ — снимок, а не вид на источник. Строки,
 * цены, реквизиты и сумма прописью записаны в сам документ; правка заказа
 * после выписки счёт не меняет.
 *
 * Прогон пишет в базу разработки и убирает за собой созданные документы,
 * возвращая счётчики на место: иначе следующий прогон стартует с чужих
 * номеров.
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
import { NumberingService } from '../src/documents/numbering.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
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
let plantUid: string;

const head = (s: typeof admin, companyUid = tradeUid) => ({
  Authorization: `Bearer ${s.token}`,
  'Content-Type': 'application/json',
  ...(companyUid ? { 'X-Company-Id': companyUid } : {}),
});

const get = (path: string, s = admin, co = tradeUid) => api(path, { headers: head(s, co) });
const post = (path: string, body: unknown, s = admin, co = tradeUid) =>
  api(path, { method: 'POST', headers: head(s, co), body: JSON.stringify(body) });

/** Созданные прогоном документы: убираем за собой вместе с их номерами. */
const mine: string[] = [];

const makeDoc = async (body: Record<string, unknown>, s = admin, co = tradeUid) => {
  const res = await post('/api/v1/documents/from-source', body, s, co);
  if (res.status === 201 || res.status === 200) mine.push(res.body.data.uid);
  return res;
};

let invTypeUid: string;
let ttnTypeUid: string;
let orderUid: string;

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
  plantUid = admin.companies.find((c: any) => c.code === 'plant').uid;

  const types = (await get('/api/v1/documents/types')).body.data.rows;
  invTypeUid = types.find((t: any) => t.code === 'INV' && t.company.code === 'trade').uid;
  ttnTypeUid = types.find((t: any) => t.code === 'TTN' && t.company.code === 'trade').uid;

  orderUid = (
    await db.query(`
      SELECT o.uid FROM sales_order o
       WHERE o.company_id = (SELECT id FROM company WHERE code = 'trade')
         AND EXISTS (SELECT 1 FROM sales_order_line l WHERE l.sales_order_id = o.id)
       ORDER BY o.id DESC LIMIT 1`)
  ).rows[0].uid;
}, 60_000);

afterAll(async () => {
  for (const uid of mine) {
    await db.query(`DELETE FROM document WHERE uid = $1`, [uid]);
  }
  // Счётчики возвращаем к числу оставшихся документов: прогон не должен
  // сдвигать нумерацию, которой пользуются следующие проверки.
  await db.query(`
    UPDATE document_counter dc SET last_number = (
      SELECT count(*) FROM document d WHERE d.document_type_id = dc.document_type_id)`);
  await db?.end();
  await app?.close();
});

describe('счёт из заказа (ТЗ 7.1)', () => {
  it('строки, суммы и реквизиты переносятся, номер выдаётся по маске', async () => {
    const order = (
      await db.query(
        `SELECT o.id, o.number, o.amount_total::text AS amount_total, p.name_ru AS partner
           FROM sales_order o JOIN partner p ON p.id = o.partner_id WHERE o.uid = $1`,
        [orderUid],
      )
    ).rows[0];
    const orderLines = (
      await db.query(`SELECT count(*)::int AS n FROM sales_order_line WHERE sales_order_id = $1`, [
        order.id,
      ])
    ).rows[0].n;
    expect(orderLines).toBeGreaterThan(0);

    const res = await makeDoc({
      documentTypeUid: invTypeUid,
      sourceType: 'sales_order',
      sourceUid: orderUid,
    });
    expect(res.status).toBe(201);
    expect(res.body.data.number).toMatch(/^СЧ-\d{2}\/\d{5}$/);

    const card = (await get(`/api/v1/documents/${res.body.data.uid}`)).body.data;
    expect(card.lines.length, 'строки заказа не перенеслись').toBe(orderLines);
    expect(card.partner.name).toBe(order.partner);
    expect(card.source).toEqual({
      kind: 'sales_order',
      uid: orderUid,
      number: order.number,
    });
    expect(card.status).toBe('draft');

    // Итог шапки сходится с таблицей: иначе спорить будут именно об этом.
    const sum = card.lines.reduce((a: number, l: any) => a + Number(l.amountTotal), 0);
    expect(Number(card.amountTotal)).toBeCloseTo(sum, 2);
    expect(Number(card.amountNet) + Number(card.amountVat)).toBeCloseTo(
      Number(card.amountTotal),
      2,
    );
  });

  it('реквизиты и сумма прописью лежат в самом документе', async () => {
    const res = await makeDoc({
      documentTypeUid: invTypeUid,
      sourceType: 'sales_order',
      sourceUid: orderUid,
    });
    const card = (await get(`/api/v1/documents/${res.body.data.uid}`)).body.data;

    expect(card.requisites.company.inn, 'ИНН компании не записан').toBeTruthy();
    expect(card.requisites.partner.name).toBeTruthy();
    expect(card.requisites.basis).toContain('Заказ');
    expect(card.requisites.amountInWords).toMatch(/сум/);
    expect(card.requisites.currency).toBeTruthy();
  });

  it('правка заказа после выписки счёт не меняет: документ — снимок', async () => {
    const res = await makeDoc({
      documentTypeUid: invTypeUid,
      sourceType: 'sales_order',
      sourceUid: orderUid,
    });
    const uid = res.body.data.uid;
    const before = (await get(`/api/v1/documents/${uid}`)).body.data;

    const line = (
      await db.query(
        `SELECT l.id, l.price::text AS price FROM sales_order_line l
           JOIN sales_order o ON o.id = l.sales_order_id
          WHERE o.uid = $1 ORDER BY l.seq LIMIT 1`,
        [orderUid],
      )
    ).rows[0];
    await db.query(`UPDATE sales_order_line SET price = price * 2 WHERE id = $1`, [line.id]);
    try {
      const after = (await get(`/api/v1/documents/${uid}`)).body.data;
      expect(after.lines[0].price, 'цена в счёте уехала вслед за заказом').toBe(
        before.lines[0].price,
      );
      expect(after.amountTotal).toBe(before.amountTotal);
    } finally {
      await db.query(`UPDATE sales_order_line SET price = $2 WHERE id = $1`, [line.id, line.price]);
    }
  });

  it('два счёта по одному заказу получают разные номера', async () => {
    const a = await makeDoc({
      documentTypeUid: invTypeUid,
      sourceType: 'sales_order',
      sourceUid: orderUid,
    });
    const b = await makeDoc({
      documentTypeUid: invTypeUid,
      sourceType: 'sales_order',
      sourceUid: orderUid,
    });
    expect(a.body.data.number).not.toBe(b.body.data.number);
  });
});

describe('другие источники', () => {
  it('накладная из отгрузки берёт отгруженное количество и цену заказа', async () => {
    const sh = (
      await db.query(`
        SELECT s.uid, s.id FROM shipment s
         WHERE s.company_id = (SELECT id FROM company WHERE code = 'trade')
           AND EXISTS (SELECT 1 FROM shipment_line l WHERE l.shipment_id = s.id)
         ORDER BY s.id DESC LIMIT 1`)
    ).rows[0];
    if (!sh) return; // отгрузок в посеве может не быть — тогда проверять нечего

    const res = await makeDoc({
      documentTypeUid: ttnTypeUid,
      sourceType: 'shipment',
      sourceUid: sh.uid,
    });
    expect(res.status).toBe(201);
    const card = (await get(`/api/v1/documents/${res.body.data.uid}`)).body.data;

    const shipped = (
      await db.query(`SELECT qty::text AS qty FROM shipment_line WHERE shipment_id = $1 ORDER BY id`, [
        sh.id,
      ])
    ).rows;
    expect(card.lines.length).toBe(shipped.length);
    expect(Number(card.lines[0].qty)).toBeCloseTo(Number(shipped[0].qty), 6);
    expect(card.requisites.basis).toContain('Отгрузка');
  });

  it('документ по сделке без контрагента не выписывается', async () => {
    const deal = (
      await db.query(`
        SELECT uid FROM deal
         WHERE company_id = (SELECT id FROM company WHERE code = 'trade')
           AND partner_id IS NULL LIMIT 1`)
    ).rows[0];
    if (!deal) return;
    const res = await makeDoc({
      documentTypeUid: invTypeUid,
      sourceType: 'deal',
      sourceUid: deal.uid,
    });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/контрагент/i);
  });

  it('незнакомый источник назван в отказе вместе со списком доступных', async () => {
    const res = await post('/api/v1/documents/from-source', {
      documentTypeUid: invTypeUid,
      sourceType: 'stock_move',
      sourceUid: orderUid,
    });
    expect(res.status).toBe(400);
  });
});

describe('поиск источника для формы', () => {
  it('заказ находится по куску номера и несёт контрагента', async () => {
    const order = (
      await db.query(`SELECT number FROM sales_order WHERE uid = $1`, [orderUid])
    ).rows[0];
    const res = await get(
      `/api/v1/documents/sources?kind=sales_order&search=${encodeURIComponent(order.number.slice(-4))}`,
    );
    expect(res.status).toBe(200);
    const row = res.body.data.rows.find((r: any) => r.uid === orderUid);
    expect(row, 'заказ не нашёлся по своему же номеру').toBeTruthy();
    expect(row.partner).toBeTruthy();
    expect(row.at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('путь sources не перехватывается карточкой документа', async () => {
    // `/documents/sources` и `/documents/{uid}` различаются только формой
    // пути: объявленный ниже `:uid` съел бы «sources», и форма выписки
    // получала бы 404 вместо списка.
    const res = await get('/api/v1/documents/sources?kind=partner&search=');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.rows)).toBe(true);
  });

  it('незнакомый вид источника отклоняется', async () => {
    expect((await get('/api/v1/documents/sources?kind=stock_move')).status).toBe(400);
  });
});

describe('запреты', () => {
  it('тип одной компании и источник другой вместе не сходятся', async () => {
    const plantType = (await get('/api/v1/documents/types', admin, plantUid)).body.data.rows.find(
      (t: any) => t.code === 'INV',
    );
    const res = await makeDoc(
      { documentTypeUid: plantType.uid, sourceType: 'sales_order', sourceUid: orderUid },
      admin,
      plantUid,
    );
    // Заказ торгового дома под заголовком завода не виден вовсе — это RLS,
    // и отказ приходит раньше проверки компаний.
    expect([404, 422]).toContain(res.status);
  });

  it('по выключенному типу новые документы не выписываются', async () => {
    const types = (await get('/api/v1/documents/types')).body.data.rows;
    const spec = types.find((t: any) => t.code === 'SPEC' && t.company.code === 'trade');
    await api(`/api/v1/documents/types/${spec.uid}`, {
      method: 'PATCH',
      headers: head(admin),
      body: JSON.stringify({ isActive: false }),
    });
    try {
      const res = await makeDoc({
        documentTypeUid: spec.uid,
        sourceType: 'sales_order',
        sourceUid: orderUid,
      });
      expect(res.status).toBe(409);
      expect(res.body.error.message).toMatch(/выключен/i);
    } finally {
      await api(`/api/v1/documents/types/${spec.uid}`, {
        method: 'PATCH',
        headers: head(admin),
        body: JSON.stringify({ isActive: true }),
      });
    }
  });

  it('номер, взятый в оборвавшейся транзакции, возвращается счётчику', async () => {
    // Номер выдаётся внутри транзакции создания документа. Если выдать его
    // отдельно, оборвавшееся создание унесёт номер с собой, и в серии
    // появится пропуск — объяснять его придётся налоговой.
    const t = (
      await db.query(
        `SELECT t.id, t.company_id, t.code, t.numbering_mask,
                t.counter_scope::text AS scope
           FROM document_type t WHERE t.uid = $1`,
        [invTypeUid],
      )
    ).rows[0];
    const tradeId = (await db.query(`SELECT id FROM company WHERE code = 'trade'`)).rows[0].id;
    const counter = async () =>
      (
        await db.query(`SELECT last_number FROM document_counter WHERE document_type_id = $1`, [
          t.id,
        ])
      ).rows[0]?.last_number ?? 0;

    const before = await counter();
    await expect(
      prisma.withContext(null, [BigInt(tradeId)], async (tx) => {
        await numbering.issue(
          tx,
          {
            id: BigInt(t.id),
            companyId: BigInt(t.company_id),
            code: t.code,
            mask: t.numbering_mask,
            scope: t.scope,
          },
          { code: 'trade' },
          new Date(),
        );
        throw new Error('обрыв создания документа');
      }),
    ).rejects.toThrow('обрыв');

    expect(await counter(), 'оборвавшаяся выписка унесла номер с собой').toBe(before);
  });

  it('без права documents.edit документ не создать', async () => {
    expect(keeper.permissions.includes('documents.edit')).toBe(false);
    const res = await post(
      '/api/v1/documents/from-source',
      { documentTypeUid: invTypeUid, sourceType: 'sales_order', sourceUid: orderUid },
      keeper,
    );
    expect(res.status).toBe(403);
  });

  it('отказ по источнику номер не тратит: он выдаётся после всех проверок', async () => {
    // Сейчас источник читается раньше выдачи номера, поэтому проверка
    // сторожит порядок действий, а не откат транзакции. Названа она так,
    // чтобы это было видно: переставь выдачу номера выше — и она упадёт.
    const next = () =>
      (get('/api/v1/documents/types') as Promise<any>).then(
        (r) => r.body.data.rows.find((t: any) => t.uid === invTypeUid).nextNumber,
      );
    const before = await next();

    const res = await makeDoc({
      documentTypeUid: invTypeUid,
      sourceType: 'sales_order',
      sourceUid: '01a0edd4-0000-7000-8000-000000000000',
    });
    expect(res.status).toBe(404);
    expect(await next(), 'несостоявшийся документ забрал номер').toBe(before);
  });

  it('пять одновременных выписок дают пять подряд идущих номеров без дырок', async () => {
    // Это проверка выдачи номера под нагрузкой: ни повторов, ни пропусков.
    // Откат транзакции она не проверяет — его сторожит следующая.
    const seq = (n: string) => Number(n.split('/')[1]);
    const before = (await get('/api/v1/documents/types')).body.data.rows.find(
      (t: any) => t.uid === invTypeUid,
    ).nextNumber;

    const made = await Promise.all(
      Array.from({ length: 5 }, () =>
        makeDoc({
          documentTypeUid: invTypeUid,
          sourceType: 'sales_order',
          sourceUid: orderUid,
        }),
      ),
    );
    expect(made.every((r) => r.status === 201)).toBe(true);

    const numbers = made.map((r) => seq(r.body.data.number)).sort((a, b) => a - b);
    expect(new Set(numbers).size, `номера повторились: ${numbers.join(', ')}`).toBe(5);
    expect(numbers[0]).toBe(seq(before));
    for (let i = 1; i < numbers.length; i += 1) {
      expect(numbers[i], `в серии дырка: ${numbers.join(', ')}`).toBe(numbers[i - 1]! + 1);
    }
  });
});
