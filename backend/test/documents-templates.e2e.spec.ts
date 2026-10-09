/**
 * Документы Э4 — шаблоны и сборка DOCX (ТЗ 7.2).
 *
 * Главное правило этапа: **загруженный файл не печатается, пока не проверен.**
 * Шаблон с опечаткой в теге даёт не ошибку, а пустую строку — в счёте, который
 * уже ушёл клиенту. Поэтому публикация отдельным действием, и до неё шаблон
 * обязан собраться на настоящем документе этого типа.
 *
 * Второе правило: **документ печатается тем шаблоном, которым напечатан
 * впервые.** Заказчик обновил бумагу — новые документы идут по новой, а
 * «перепечатай мартовский счёт» обязано дать мартовскую форму.
 *
 * Прогон пишет в базу разработки: заводит свои шаблоны и документы и убирает
 * их за собой, возвращая публикацию посева на место.
 */
import 'dotenv/config';
import JSZip from 'jszip';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { raw } from 'express';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { AuthGuard } from '../src/auth/auth.guard.js';
import { DocumentsModule } from '../src/documents/documents.module.js';
import { ContextMiddleware } from '../src/common/context.middleware.js';
import { EnvelopeInterceptor } from '../src/common/envelope.interceptor.js';
import { ErrorFilter } from '../src/common/error.filter.js';
import { buildDocx, type DocxBlock } from '../src/documents/docx-build.js';

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

const head = (s: typeof admin) => ({
  Authorization: `Bearer ${s.token}`,
  'Content-Type': 'application/json',
  'X-Company-Id': tradeUid,
});

const get = (path: string, s = admin) => api(path, { headers: head(s) });
const post = (path: string, body?: unknown, s = admin) =>
  api(path, {
    method: 'POST',
    headers: head(s),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const patch = (path: string, body: unknown, s = admin) =>
  api(path, { method: 'PATCH', headers: head(s), body: JSON.stringify(body) });
const del = (path: string, s = admin) => api(path, { method: 'DELETE', headers: head(s) });

/** Файл приходит телом запроса, как вложение: JSON тут ни при чём. */
async function upload(
  typeUid: string,
  locale: 'ru' | 'uz',
  name: string,
  file: Buffer,
  s = admin,
) {
  const qs = new URLSearchParams({ documentTypeUid: typeUid, locale, name });
  const res = await fetch(`${base}/api/v1/documents/templates/upload?${qs}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${s.token}`,
      'X-Company-Id': tradeUid,
      'Content-Type': 'application/octet-stream',
    },
    body: new Uint8Array(file),
  });
  const text = await res.text();
  if (res.status === 201 || res.status === 200) {
    const uid = JSON.parse(text).data.uid as string;
    mineTemplates.push(uid);
    return { status: res.status, body: JSON.parse(text) as any };
  }
  return { status: res.status, body: text ? (JSON.parse(text) as any) : null };
}

async function download(path: string, s = admin) {
  const res = await fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${s.token}`, 'X-Company-Id': tradeUid },
  });
  if (res.status !== 200) {
    const text = await res.text();
    return { status: res.status, buffer: null, body: text ? JSON.parse(text) : null, name: '' };
  }
  return {
    status: res.status,
    buffer: Buffer.from(await res.arrayBuffer()),
    body: null,
    name: res.headers.get('content-disposition') ?? '',
  };
}

/** Текст готового DOCX — чтобы смотреть, что подставилось, а не что осталось. */
async function docxText(buffer: Buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file('word/document.xml')!.async('string');
  return xml
    .replace(/<w:br\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
}

const mineTemplates: string[] = [];
const mineDocs: string[] = [];

const makeDoc = async (typeUid: string) => {
  const res = await post('/api/v1/documents/from-source', {
    documentTypeUid: typeUid,
    sourceType: 'sales_order',
    sourceUid: orderUid,
  });
  if (res.status === 201 || res.status === 200) mineDocs.push(res.body.data.uid);
  return res;
};

let invTypeUid: string;
let contractTypeUid: string;
let orderUid: string;

/** Шаблон с чужим тегом — ровно тот случай, ради которого есть сопоставление. */
const alienBlocks = (marker: string): DocxBlock[] => [
  { kind: 'p', text: `${marker} {НомерСчета} от {doc.date}`, bold: true },
  { kind: 'p', text: '{company.name} / {partner.name}' },
  {
    kind: 'table',
    head: true,
    rows: [
      ['№', 'Наименование', 'Сумма'],
      ['{#lines}{seq}', '{name}', '{total}{/lines}'],
    ],
  },
  { kind: 'p', text: 'Всего: {amount.total} {currency}' },
  { kind: 'p', text: 'Сумма прописью: {amount.words}' },
  { kind: 'p', text: '{#hasVat}в том числе НДС {amount.vat}{/hasVat}{#noVat}Без НДС{/noVat}' },
];

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
  // Тот же сырой разбор, что в main.ts: без него файл приехал бы разобранным
  // как JSON, и прогон проверял бы не то, что работает у пользователя.
  app.use('/api/v1/documents/templates/upload', raw({ type: () => true, limit: '6mb' }));
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

  const types = (await get('/api/v1/documents/types')).body.data.rows;
  invTypeUid = types.find((t: any) => t.code === 'INV' && t.company.code === 'trade').uid;
  contractTypeUid = types.find(
    (t: any) => t.code === 'CONTRACT' && t.company.code === 'trade',
  ).uid;

  orderUid = (
    await db.query(`
      SELECT o.uid FROM sales_order o
       WHERE o.company_id = (SELECT id FROM company WHERE code = 'trade')
         AND EXISTS (SELECT 1 FROM sales_order_line l WHERE l.sales_order_id = o.id)
       ORDER BY o.id DESC LIMIT 1`)
  ).rows[0].uid;
}, 60_000);

afterAll(async () => {
  for (const uid of mineDocs) {
    await db.query(`DELETE FROM document WHERE uid = $1`, [uid]);
  }
  for (const uid of mineTemplates) {
    await db.query(`DELETE FROM document_template WHERE uid = $1`, [uid]);
  }
  // Публикацию посева возвращаем: прогон мог её снять, опубликовав свою
  // версию, и следующая проверка печати осталась бы без шаблона.
  await db.query(`
    UPDATE document_template SET is_published = true, published_at = now()
     WHERE version = 1 AND NOT is_published`);
  await db.query(`
    UPDATE document_counter dc SET last_number = (
      SELECT count(*) FROM document d WHERE d.document_type_id = dc.document_type_id)`);
  await db?.end();
  await app?.close();
});

describe('каталог полей и список шаблонов', () => {
  it('поля отдаются с циклом строк и условиями — сопоставлять есть с чем', async () => {
    const res = await get('/api/v1/documents/templates/fields');
    expect(res.status).toBe(200);
    const names = res.body.data.document.map((f: any) => f.name);
    expect(names).toContain('doc.number');
    expect(names).toContain('amount.words');
    expect(res.body.data.document.find((f: any) => f.name === 'lines').kind).toBe('loop');
    expect(res.body.data.line.map((f: any) => f.name)).toContain('qty');
  });

  it('посев положил черновые формы на счёт, накладную, акт и спецификацию', async () => {
    const rows = (await get('/api/v1/documents/templates')).body.data.rows;
    const published = rows.filter((r: any) => r.isPublished && r.company.code === 'trade');
    const codes = [...new Set(published.map((r: any) => r.type.code))].sort();
    expect(codes).toEqual(['ACT', 'INV', 'SPEC', 'TTN']);
    // На каждый тип — русская и узбекская: ТЗ 7.2 требует два файла.
    const inv = published.filter((r: any) => r.type.code === 'INV').map((r: any) => r.locale);
    expect(inv.sort()).toEqual(['ru', 'uz']);
  });

  it('шаблоны — настройка: кладовщику их не видно', async () => {
    const res = await get('/api/v1/documents/templates', keeper);
    expect(res.status).toBe(403);
  });
});

describe('загрузка', () => {
  it('не DOCX отбивается с объяснением, а не «ошибка сервера»', async () => {
    const res = await upload(
      invTypeUid,
      'ru',
      'счёт.doc',
      Buffer.from('это не word, это текст'),
    );
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('DOCX');
  });

  it('теги читаются из файла, чужой назван по имени', async () => {
    const res = await upload(invTypeUid, 'ru', 'счёт-клиента.docx', await buildDocx(alienBlocks('СЧЁТ')));
    expect(res.status).toBe(201);
    const tags: any[] = res.body.data.tags;
    const byName = new Map(tags.map((t) => [t.name, t]));
    expect(byName.get('doc.date').known).toBe(true);
    expect(byName.get('НомерСчета').known).toBe(false);
    // Цикл — одна запись, а не две: открывающий и закрывающий тег парные,
    // и вдвое длиннее список сбил бы того, кто его читает.
    expect(tags.filter((t) => t.name === 'lines')).toHaveLength(1);
    expect(byName.get('lines').kind).toBe('block');
  });

  it('версия растёт, новая загрузка не публикуется сама', async () => {
    const a = await upload(invTypeUid, 'ru', 'в1.docx', await buildDocx(alienBlocks('A')));
    const b = await upload(invTypeUid, 'ru', 'в2.docx', await buildDocx(alienBlocks('B')));
    expect(b.body.data.version).toBe(a.body.data.version + 1);
    const rows = (await get(`/api/v1/documents/templates?typeUid=${invTypeUid}`)).body.data.rows;
    expect(rows.find((r: any) => r.uid === b.body.data.uid).isPublished).toBe(false);
  });
});

describe('проверка до публикации (ТЗ 7.2)', () => {
  it('шаблон с несопоставленным тегом не публикуется, тег назван', async () => {
    const up = await upload(invTypeUid, 'ru', 'чужой.docx', await buildDocx(alienBlocks('X')));
    const uid = up.body.data.uid;

    const check = await post(`/api/v1/documents/templates/${uid}/check`);
    expect(check.status).toBe(201);
    expect(check.body.data.ok).toBe(false);
    expect(check.body.data.unknown).toEqual(['НомерСчета']);
    // Проверка идёт на настоящем документе — его номер в ответе.
    expect(check.body.data.sampleNumber).toBeTruthy();

    const pub = await post(`/api/v1/documents/templates/${uid}/publish`);
    expect(pub.status).toBe(422);
    expect(pub.body.error.message).toContain('НомерСчета');
  });

  it('сопоставление с несуществующим полем отбивается', async () => {
    const up = await upload(invTypeUid, 'ru', 'мимо.docx', await buildDocx(alienBlocks('Y')));
    const res = await patch(`/api/v1/documents/templates/${up.body.data.uid}/field-map`, {
      fieldMap: { 'НомерСчета': 'doc.nomer' },
    });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('doc.nomer');
  });

  it('сопоставленный тег становится знакомым, и тогда шаблон публикуется', async () => {
    const up = await upload(invTypeUid, 'ru', 'свой.docx', await buildDocx(alienBlocks('Z')));
    const uid = up.body.data.uid;

    const map = await patch(`/api/v1/documents/templates/${uid}/field-map`, {
      fieldMap: { 'НомерСчета': 'doc.number' },
    });
    expect(map.status).toBe(200);
    expect(map.body.data.tags.find((t: any) => t.name === 'НомерСчета')).toMatchObject({
      known: true,
      mappedTo: 'doc.number',
    });

    const check = await post(`/api/v1/documents/templates/${uid}/check`);
    expect(check.body.data.ok).toBe(true);
    expect(check.body.data.unknown).toEqual([]);

    const pub = await post(`/api/v1/documents/templates/${uid}/publish`);
    expect(pub.status).toBe(201);

    // Опубликованный на тип и язык ровно один: иначе «какой печатается» —
    // вопрос без ответа.
    const live = await db.query(
      `SELECT count(*)::int AS n FROM document_template tpl
         JOIN document_type t ON t.id = tpl.document_type_id
        WHERE t.uid = $1::uuid AND tpl.locale = 'ru' AND tpl.is_published`,
      [invTypeUid],
    );
    expect(live.rows[0].n).toBe(1);
  });

  it('у опубликованного сопоставление не меняют — по нему уже печатают', async () => {
    const up = await upload(invTypeUid, 'uz', 'uz.docx', await buildDocx(alienBlocks('U')));
    const uid = up.body.data.uid;
    await patch(`/api/v1/documents/templates/${uid}/field-map`, {
      fieldMap: { 'НомерСчета': 'doc.number' },
    });
    expect((await post(`/api/v1/documents/templates/${uid}/publish`)).status).toBe(201);

    const again = await patch(`/api/v1/documents/templates/${uid}/field-map`, {
      fieldMap: { 'НомерСчета': 'doc.date' },
    });
    expect(again.status).toBe(409);
  });
});

describe('сборка DOCX (ТЗ 7.2)', () => {
  it('подставляются значения самого документа, включая строки и сумму прописью', async () => {
    const created = await makeDoc(invTypeUid);
    expect(created.status).toBe(201);
    // Создание отдаёт краткий ответ, реквизиты и строки — в карточке: сверяем
    // печать с тем, что показано пользователю, а не с внутренним объектом.
    const d = (await get(`/api/v1/documents/${created.body.data.uid}`)).body.data;

    const file = await download(`/api/v1/documents/${d.uid}/file?format=docx`);
    expect(file.status).toBe(200);
    // DOCX — zip: первые байты PK. Иначе это JSON, обёрнутый конвертом.
    expect(file.buffer!.subarray(0, 2).toString()).toBe('PK');
    expect(file.name).toContain('filename*=UTF-8');

    const text = await docxText(file.buffer!);
    expect(text).toContain(d.number);
    expect(text).toContain(d.requisites.company.name);
    expect(text).toContain(d.requisites.amountInWords);
    // Табличная часть повторилась по числу строк, а не осталась одной.
    for (const line of d.lines) expect(text).toContain(line.name);
    // Незаполненных тегов в готовой бумаге не остаётся.
    expect(text).not.toContain('{');
  });

  it('документ печатается тем шаблоном, которым напечатан впервые', async () => {
    const doc = await makeDoc(invTypeUid);
    const uid = doc.body.data.uid;

    const first = await docxText((await download(`/api/v1/documents/${uid}/file`)).buffer!);
    expect(first).not.toContain('НОВАЯ ФОРМА');

    const up = await upload(
      invTypeUid,
      'ru',
      'новая.docx',
      await buildDocx(alienBlocks('НОВАЯ ФОРМА')),
    );
    await patch(`/api/v1/documents/templates/${up.body.data.uid}/field-map`, {
      fieldMap: { 'НомерСчета': 'doc.number' },
    });
    expect((await post(`/api/v1/documents/templates/${up.body.data.uid}/publish`)).status).toBe(201);

    // Новый документ — по новой форме.
    const fresh = await makeDoc(invTypeUid);
    const freshText = await docxText(
      (await download(`/api/v1/documents/${fresh.body.data.uid}/file`)).buffer!,
    );
    expect(freshText).toContain('НОВАЯ ФОРМА');

    // А напечатанный раньше — по прежней, той, что ушла клиенту.
    const again = await docxText((await download(`/api/v1/documents/${uid}/file`)).buffer!);
    expect(again).not.toContain('НОВАЯ ФОРМА');
    expect(again).toBe(first);
  });

  it('без опубликованного шаблона печать отказывает словами, а не пустым файлом', async () => {
    const doc = await makeDoc(contractTypeUid);
    expect(doc.status).toBe(201);
    const res = await download(`/api/v1/documents/${doc.body.data.uid}/file`);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('шаблон');
    // Ссылку на шаблон упавшая печать не проставляет.
    const pinned = await db.query(
      `SELECT template_id FROM document WHERE uid = $1::uuid`,
      [doc.body.data.uid],
    );
    expect(pinned.rows[0].template_id).toBeNull();
  });

  it('печать — право documents.edit, а не просмотр карточки', async () => {
    const doc = await makeDoc(invTypeUid);
    const res = await download(`/api/v1/documents/${doc.body.data.uid}/file`, keeper);
    expect(res.status).toBe(403);
  });
});

describe('удаление', () => {
  it('шаблон, которым напечатали, не удаляют — иначе не перепечатать', async () => {
    const doc = await makeDoc(invTypeUid);
    expect((await download(`/api/v1/documents/${doc.body.data.uid}/file`)).status).toBe(200);

    const pinned = await db.query(
      `SELECT tpl.uid FROM document d JOIN document_template tpl ON tpl.id = d.template_id
        WHERE d.uid = $1::uuid`,
      [doc.body.data.uid],
    );
    const res = await del(`/api/v1/documents/templates/${pinned.rows[0].uid}`);
    expect(res.status).toBe(409);
    expect(res.body.error.details.printed).toBeGreaterThan(0);
  });

  it('неопубликованный и ненапечатанный удаляется', async () => {
    const up = await upload(invTypeUid, 'ru', 'лишний.docx', await buildDocx(alienBlocks('W')));
    const res = await del(`/api/v1/documents/templates/${up.body.data.uid}`);
    expect(res.status).toBe(200);
    expect((await get(`/api/v1/documents/templates?typeUid=${invTypeUid}`)).body.data.rows
      .find((r: any) => r.uid === up.body.data.uid)).toBeUndefined();
  });
});
