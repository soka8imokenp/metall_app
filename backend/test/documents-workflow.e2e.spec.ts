/**
 * Документы Э6 — согласование, версии и журнал (ТЗ 7.4).
 *
 * Три вещи, каждую отдельно:
 *
 * 1. **Маршрут.** Из статуса в статус только по разрешённой паре, возврат и
 *    отмена — со словами, и каждое движение остаётся в журнале.
 * 2. **Права.** Счёт выписывает менеджер, утверждает не он: `documents.edit`
 *    двигает документ к согласованию, `documents.approve` решает его судьбу.
 * 3. **Версии.** Правка утверждённого не переписывает его: прежняя редакция
 *    уходит в архив целиком и печатается тем же шаблоном, а документ
 *    возвращается в черновик.
 *
 * Прогон убирает за собой созданные документы и возвращает счётчики.
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

/** Менеджер выписывает, бухгалтер согласовывает — у них разные права. */
let manager: Awaited<ReturnType<typeof login>>;
let accountant: Awaited<ReturnType<typeof login>>;
let tradeUid: string;

const head = (s: typeof manager) => ({
  Authorization: `Bearer ${s.token}`,
  'Content-Type': 'application/json',
  'X-Company-Id': tradeUid,
});

const get = (path: string, s = manager) => api(path, { headers: head(s) });
const post = (path: string, body: unknown, s = manager) =>
  api(path, { method: 'POST', headers: head(s), body: JSON.stringify(body) });
const patch = (path: string, body: unknown, s = manager) =>
  api(path, { method: 'PATCH', headers: head(s), body: JSON.stringify(body) });

const act = (uid: string, action: string, comment?: string, s = manager) =>
  post(`/api/v1/documents/${uid}/actions`, { action, ...(comment ? { comment } : {}) }, s);

async function download(path: string, s = manager) {
  const res = await fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${s.token}`, 'X-Company-Id': tradeUid },
  });
  if (res.status !== 200) {
    const text = await res.text();
    return { status: res.status, buffer: null, body: text ? JSON.parse(text) : null };
  }
  return { status: res.status, buffer: Buffer.from(await res.arrayBuffer()), body: null };
}

const mine: string[] = [];

const makeDoc = async () => {
  const res = await post('/api/v1/documents/from-source', {
    documentTypeUid: invTypeUid,
    sourceType: 'sales_order',
    sourceUid: orderUid,
  });
  if (res.status === 201 || res.status === 200) mine.push(res.body.data.uid);
  return res.body.data.uid as string;
};

const card = async (uid: string, s = manager) => (await get(`/api/v1/documents/${uid}`, s)).body.data;

let invTypeUid: string;
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

  db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  manager = await login('d.karimov');
  accountant = await login('m.rahimova');
  tradeUid = manager.companies.find((c: any) => c.code === 'trade').uid;

  const types = (await get('/api/v1/documents/types')).body.data.rows;
  invTypeUid = types.find((t: any) => t.code === 'INV' && t.company.code === 'trade').uid;

  orderUid = (
    await db.query(`
      SELECT o.uid FROM sales_order o
       WHERE o.company_id = (SELECT id FROM company WHERE code = 'trade')
         AND (SELECT count(*) FROM sales_order_line l WHERE l.sales_order_id = o.id) >= 2
       ORDER BY o.id DESC LIMIT 1`)
  ).rows[0].uid;
}, 120_000);

afterAll(async () => {
  for (const uid of mine) {
    await db.query(`DELETE FROM document WHERE uid = $1`, [uid]);
  }
  await db.query(`
    UPDATE document_counter dc SET last_number = (
      SELECT count(*) FROM document d WHERE d.document_type_id = dc.document_type_id)`);
  await db?.end();
  await app?.close();
});

describe('права: выписывает один, утверждает другой', () => {
  it('у менеджера нет права согласования, у бухгалтера есть', () => {
    expect(manager.permissions).toContain('documents.edit');
    expect(manager.permissions).not.toContain('documents.approve');
    expect(accountant.permissions).toContain('documents.approve');
  });

  it('менеджер не может утвердить документ, который сам отправил', async () => {
    const uid = await makeDoc();
    expect((await act(uid, 'submit')).status).toBe(201);

    const res = await act(uid, 'approve');
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('documents.approve');
    expect((await card(uid)).status).toBe('pending_approval');
  });

  it('карточка показывает только те действия, что человеку доступны', async () => {
    const uid = await makeDoc();
    expect((await card(uid)).actions).toEqual(['submit', 'cancel']);

    await act(uid, 'submit');
    // Менеджер отправил — решение уже не его: осталась только отмена.
    expect((await card(uid)).actions).toEqual(['cancel']);
    // У бухгалтера есть оба права, поэтому к решению добавляется отмена.
    expect((await card(uid, accountant)).actions).toEqual(['approve', 'return', 'cancel']);
  });
});

describe('маршрут (ТЗ 7.4)', () => {
  it('черновик → согласование → утверждён → подписан', async () => {
    const uid = await makeDoc();
    expect((await card(uid)).status).toBe('draft');

    expect((await act(uid, 'submit')).status).toBe(201);
    expect((await card(uid)).status).toBe('pending_approval');

    expect((await act(uid, 'approve', undefined, accountant)).status).toBe(201);
    expect((await card(uid)).status).toBe('approved');

    expect((await act(uid, 'sign', undefined, accountant)).status).toBe(201);
    expect((await card(uid)).status).toBe('signed');
  });

  it('через голову ступени не перепрыгнуть, и отказ называет, откуда можно', async () => {
    const uid = await makeDoc();
    const res = await act(uid, 'approve', undefined, accountant);
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('Черновик');
    expect(res.body.error.message).toContain('На согласовании');
    expect((await card(uid)).status).toBe('draft');
  });

  it('возврат без слов не проходит, а со словами виден в карточке', async () => {
    const uid = await makeDoc();
    await act(uid, 'submit');

    const empty = await act(uid, 'return', '   ', accountant);
    expect(empty.status).toBe(422);
    expect((await card(uid)).status).toBe('pending_approval');

    const ok = await act(uid, 'return', 'Не тот расчётный счёт', accountant);
    expect(ok.status).toBe(201);
    const c = await card(uid);
    expect(c.status).toBe('returned');
    // Почему вернули — рядом со статусом, а не в истории: переделывает это
    // тот, кто открыл карточку.
    expect(c.statusComment).toBe('Не тот расчётный счёт');
    expect(c.statusUser).toBeTruthy();
  });

  it('возвращённый отправляется снова', async () => {
    const uid = await makeDoc();
    await act(uid, 'submit');
    await act(uid, 'return', 'переделать', accountant);
    expect((await act(uid, 'submit')).status).toBe(201);
    expect((await card(uid)).status).toBe('pending_approval');
  });

  it('отмена требует причины и закрывает документ навсегда', async () => {
    const uid = await makeDoc();
    expect((await act(uid, 'cancel')).status).toBe(422);

    expect((await act(uid, 'cancel', 'Выписан по ошибке')).status).toBe(201);
    expect((await card(uid)).status).toBe('cancelled');

    // Из отменённого никуда: он больше не документ в работе.
    expect((await act(uid, 'submit')).status).toBe(422);
    expect((await act(uid, 'cancel', 'ещё раз')).status).toBe(422);
    expect((await card(uid)).actions).toEqual([]);
  });
});

describe('журнал', () => {
  it('каждое движение записано с тем, кто его сделал', async () => {
    const uid = await makeDoc();
    await act(uid, 'submit');
    await act(uid, 'return', 'нет печати', accountant);
    await act(uid, 'submit');
    await act(uid, 'approve', undefined, accountant);

    const h = (await get(`/api/v1/documents/${uid}/history`)).body.data;
    const actions = h.rows.map((r: any) => r.action);
    expect(actions).toEqual(['approve', 'submit', 'return', 'submit']);

    const ret = h.rows.find((r: any) => r.action === 'return');
    expect(ret.changes.status).toEqual({ from: 'pending_approval', to: 'returned' });
    expect(ret.changes.comment.to).toBe('нет печати');
    expect(ret.user).toBeTruthy();
    // Возврат сделал не тот, кто отправлял.
    const sub = h.rows.find((r: any) => r.action === 'submit');
    expect(sub.user).not.toBe(ret.user);
  });

  it('журнал нельзя переписать: строка только добавляется', async () => {
    const uid = await makeDoc();
    await act(uid, 'submit');
    await expect(
      db.query(`UPDATE audit_log SET action = 'подделка' WHERE entity_id = $1`, [uid]),
    ).rejects.toThrow();
  });
});

describe('правка и версии', () => {
  it('черновик правится на месте, версия не растёт', async () => {
    const uid = await makeDoc();
    const c = await card(uid);

    const res = await patch(`/api/v1/documents/${uid}`, {
      version: c.version,
      documentDate: '2026-09-15',
    });
    expect(res.status).toBe(200);

    const after = await card(uid);
    expect(after.version).toBe(c.version);
    expect(String(after.documentDate).slice(0, 10)).toBe('2026-09-15');
    expect((await get(`/api/v1/documents/${uid}/versions`)).body.data.rows).toHaveLength(0);
  });

  it('чужая версия в теле — отказ с текущей, а не молчаливая перезапись', async () => {
    const uid = await makeDoc();
    const res = await patch(`/api/v1/documents/${uid}`, { version: 99, documentDate: '2026-09-15' });
    expect(res.status).toBe(409);
    expect(res.body.error.details.version).toBe(1);
  });

  it('документ на согласовании не правят', async () => {
    const uid = await makeDoc();
    await act(uid, 'submit');
    const res = await patch(`/api/v1/documents/${uid}`, { version: 1, documentDate: '2026-09-15' });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('согласовании');
  });

  it('правка строк пересчитывает суммы и сумму прописью', async () => {
    const uid = await makeDoc();
    const c = await card(uid);

    const res = await patch(`/api/v1/documents/${uid}`, {
      version: c.version,
      lines: [
        { name: 'Швеллер 16П', qty: '2', price: '1000000', vatRate: '12', unitCode: 't' },
        { name: 'Уголок 63х63', qty: '3', price: '500000', vatRate: '12', unitCode: 't' },
      ],
    });
    expect(res.status).toBe(200);

    const after = await card(uid);
    expect(after.lines).toHaveLength(2);
    expect(Number(after.amountNet)).toBeCloseTo(3_500_000, 2);
    expect(Number(after.amountVat)).toBeCloseTo(420_000, 2);
    expect(Number(after.amountTotal)).toBeCloseTo(3_920_000, 2);
    // Слова обязаны сойтись с цифрами: иначе счёт спорит сам с собой.
    expect(after.requisites.amountInWords).toBe(
      'Три миллиона девятьсот двадцать тысяч сумов 00 тийинов',
    );
  });

  it('суммы держатся в тийинах: доли тийина не доживают до документа', async () => {
    const uid = await makeDoc();
    const c = await card(uid);

    // Цена с четырьмя знаками — обычное дело для тонны: 3 × 0,3333 = 0,9999.
    // В документе это обязано стать ровной суммой: печатной формы на четверть
    // тийина не бывает, а расхождение цифр и слов — повод не принять счёт.
    const res = await patch(`/api/v1/documents/${uid}`, {
      version: c.version,
      lines: [{ name: 'Обрезь', qty: '3', price: '0.3333', vatRate: '0', unitCode: 't' }],
    });
    expect(res.status).toBe(200);

    const after = await card(uid);
    for (const [what, v] of [
      ['итог документа', after.amountTotal],
      ['строку', after.lines[0].amountTotal],
    ] as [string, string][]) {
      const frac = String(v).split('.')[1] ?? '';
      expect(frac.slice(2).replace(/0+$/, ''), `${what} ${v} считают дробями тийина`).toBe('');
    }
    // Слова считаются от той же суммы, что видно в цифрах.
    const kop = String(Number(after.amountTotal).toFixed(2)).split('.')[1];
    expect(after.requisites.amountInWords).toContain(`${kop} тийин`);
  });

  it('пустое количество и пустое название отбиваются с номером строки', async () => {
    const uid = await makeDoc();
    const bad = await patch(`/api/v1/documents/${uid}`, {
      version: 1,
      lines: [{ name: 'Труба', qty: '0', price: '10' }],
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error.message).toContain('Строка 1');

    const noName = await patch(`/api/v1/documents/${uid}`, {
      version: 1,
      lines: [{ name: '  ', qty: '1', price: '10' }],
    });
    expect(noName.status).toBe(422);
  });

  it('правка утверждённого заводит редакцию и возвращает документ в черновик', async () => {
    const uid = await makeDoc();
    await act(uid, 'submit');
    await act(uid, 'approve', undefined, accountant);
    const before = await card(uid);
    expect(before.status).toBe('approved');
    expect(before.version).toBe(1);
    const wasTotal = before.amountTotal;

    const res = await patch(`/api/v1/documents/${uid}`, {
      version: before.version,
      lines: [{ name: 'Труба ППУ 530', qty: '1', price: '7000000', vatRate: '12', unitCode: 'sht' }],
    });
    expect(res.status).toBe(200);

    const after = await card(uid);
    expect(after.version).toBe(2);
    // Утверждали не это — документ обязан пройти согласование заново.
    expect(after.status).toBe('draft');
    expect(Number(after.amountTotal)).toBeCloseTo(7_840_000, 2);
    expect(after.versions).toBe(1);

    const v = (await get(`/api/v1/documents/${uid}/versions`)).body.data;
    expect(v.current).toBe(2);
    expect(v.rows).toHaveLength(1);
    // Прежняя редакция сохранила и свой статус, и свои цифры.
    expect(v.rows[0]).toMatchObject({ version: 1, status: 'approved' });
    expect(v.rows[0].amountTotal).toBe(wasTotal);
    expect(v.rows[0].linesCount).toBe(before.lines.length);
  });

  it('прежняя редакция печатается своим шаблоном и своими цифрами', async () => {
    const uid = await makeDoc();
    // Печатаем до правки — так у редакции появляется её форма.
    expect((await download(`/api/v1/documents/${uid}/file`)).status).toBe(200);
    const before = await card(uid);

    await act(uid, 'submit');
    await act(uid, 'approve', undefined, accountant);
    await patch(`/api/v1/documents/${uid}`, {
      version: 1,
      lines: [{ name: 'Другая позиция', qty: '1', price: '1000', vatRate: '0' }],
    });

    const old = await download(`/api/v1/documents/${uid}/versions/1/file?format=docx`);
    expect(old.status).toBe(200);
    expect(old.buffer!.subarray(0, 2).toString()).toBe('PK');

    const JSZip = (await import('jszip')).default;
    const xml = await (await JSZip.loadAsync(old.buffer!))
      .file('word/document.xml')!
      .async('string');
    const text = xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, '');
    // В старой форме — старые строки, и ни следа новых.
    for (const l of before.lines) expect(text).toContain(l.name.replace(/\s+/g, ''));
    expect(text).not.toContain('Другаяпозиция');
  });

  it('отменённый документ не правят', async () => {
    const uid = await makeDoc();
    await act(uid, 'cancel', 'ошибка');
    const res = await patch(`/api/v1/documents/${uid}`, { version: 1, documentDate: '2026-09-15' });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('отменён');
  });

  it('правка обнуляет готовый PDF: он собран из прежних цифр', async () => {
    const uid = await makeDoc();
    expect((await download(`/api/v1/documents/${uid}/file?format=pdf`)).status).toBe(200);
    const was = await db.query(`SELECT pdf_key FROM document WHERE uid = $1::uuid`, [uid]);
    expect(was.rows[0].pdf_key).toBeTruthy();

    await patch(`/api/v1/documents/${uid}`, {
      version: 1,
      lines: [{ name: 'Иное', qty: '1', price: '100', vatRate: '0' }],
    });
    const now = await db.query(`SELECT pdf_key FROM document WHERE uid = $1::uuid`, [uid]);
    expect(now.rows[0].pdf_key).toBeNull();
  }, 120_000);

  it('редакция, которую не печатали, честно говорит, что формы у неё нет', async () => {
    const uid = await makeDoc();
    await act(uid, 'submit');
    await act(uid, 'approve', undefined, accountant);
    await patch(`/api/v1/documents/${uid}`, { version: 1, documentDate: '2026-09-14' });

    // Список редакций обязан сказать это до нажатия: кнопка, которая заведомо
    // вернёт отказ, — обещание, которого экран не выполнит.
    const list = await get(`/api/v1/documents/${uid}/versions`);
    expect(list.body.data.rows[0].hasTemplate).toBe(false);
    expect(list.body.data.rows[0].hasPdf).toBe(false);

    const res = await download(`/api/v1/documents/${uid}/versions/1/file?format=docx`);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('не печаталась');

    const pdf = await download(`/api/v1/documents/${uid}/versions/1/file?format=pdf`);
    expect(pdf.status).toBe(409);
  });
});
