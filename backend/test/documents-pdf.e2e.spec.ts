/**
 * Документы Э5 — PDF печатной формы (ТЗ 7.2).
 *
 * Проверяем не «файл скачался», а что в нём. PDF собирает внешняя программа,
 * и сломаться он умеет тихо: кириллица превращается в квадраты, таблица
 * теряет колонки, разряды в суммах слипаются. Всё это даёт правильный
 * заголовок ответа и правильный размер — и неправильную бумагу у клиента.
 * Поэтому каждый собранный PDF здесь разбирается обратно в текст.
 *
 * Прогон убирает за собой созданные документы и их файлы.
 */
import 'dotenv/config';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
let tradeUid: string;

const head = () => ({
  Authorization: `Bearer ${admin.token}`,
  'Content-Type': 'application/json',
  'X-Company-Id': tradeUid,
});

const get = (path: string) => api(path, { headers: head() });
const post = (path: string, body: unknown) =>
  api(path, { method: 'POST', headers: head(), body: JSON.stringify(body) });

async function download(path: string) {
  const res = await fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${admin.token}`, 'X-Company-Id': tradeUid },
  });
  if (res.status !== 200) {
    const text = await res.text();
    return { status: res.status, buffer: null, body: text ? JSON.parse(text) : null, headers: res.headers };
  }
  return {
    status: res.status,
    buffer: Buffer.from(await res.arrayBuffer()),
    body: null,
    headers: res.headers,
  };
}

/**
 * Текст PDF — `pdftotext -layout`.
 *
 * Именно `-layout`: без него колонки таблицы склеиваются в столбик и
 * «потеряна колонка» неотличимо от «колонка есть». Проверка ради этого и
 * существует.
 */
/**
 * Текст без пробелов и переносов.
 *
 * В бумаге всё переносится: сумма прописью не влезает в строку, «ГОСТ
 * 8509-93» разрывается после дефиса. Сравнивать посимвольно с исходной
 * строкой значит проверять ширину страницы, а не то, что напечатано.
 */
const squeeze = (s: string) => s.replace(/\s+/g, '');

async function pdfText(bytes: Buffer) {
  const dir = await mkdtemp(join(tmpdir(), 'metall-pdftest-'));
  try {
    const file = join(dir, 'x.pdf');
    await writeFile(file, bytes);
    return await new Promise<string>((resolve, reject) => {
      execFile('pdftotext', ['-layout', file, '-'], { maxBuffer: 8 * 1024 * 1024 }, (err, out) =>
        err ? reject(err) : resolve(out),
      );
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const mineDocs: string[] = [];

const makeDoc = async (typeUid: string, locale?: 'ru' | 'uz') => {
  const res = await post('/api/v1/documents/from-source', {
    documentTypeUid: typeUid,
    sourceType: 'sales_order',
    sourceUid: orderUid,
    ...(locale ? { locale } : {}),
  });
  if (res.status === 201 || res.status === 200) mineDocs.push(res.body.data.uid);
  return res;
};

let invTypeUid: string;
let contractTypeUid: string;
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

  admin = await login('admin');
  tradeUid = admin.companies.find((c: any) => c.code === 'trade').uid;

  const types = (await get('/api/v1/documents/types')).body.data.rows;
  invTypeUid = types.find((t: any) => t.code === 'INV' && t.company.code === 'trade').uid;
  contractTypeUid = types.find(
    (t: any) => t.code === 'CONTRACT' && t.company.code === 'trade',
  ).uid;

  // Заказ обязательно на несколько строк.
  //
  // У документа с одной строкой итог по строке совпадает с итогом документа,
  // а он печатается и под таблицей — проверка «последняя колонка на месте»
  // прошла бы на пустой таблице. Проверено: с одной строкой она и проходила.
  orderUid = (
    await db.query(`
      SELECT o.uid FROM sales_order o
       WHERE o.company_id = (SELECT id FROM company WHERE code = 'trade')
         AND (SELECT count(*) FROM sales_order_line l WHERE l.sales_order_id = o.id) >= 2
       ORDER BY o.id DESC LIMIT 1`)
  ).rows[0].uid;
}, 120_000);

afterAll(async () => {
  for (const uid of mineDocs) {
    await db.query(`DELETE FROM document WHERE uid = $1`, [uid]);
  }
  await db.query(`
    UPDATE document_counter dc SET last_number = (
      SELECT count(*) FROM document d WHERE d.document_type_id = dc.document_type_id)`);
  await db?.end();
  await app?.close();
});

describe('содержимое PDF (ТЗ 7.2)', () => {
  it(
    'номер, стороны, табличная часть и сумма прописью доходят до бумаги',
    async () => {
      const created = await makeDoc(invTypeUid);
      expect(created.status).toBe(201);
      const d = (await get(`/api/v1/documents/${created.body.data.uid}`)).body.data;

      const file = await download(`/api/v1/documents/${d.uid}/file?format=pdf`);
      expect(file.status).toBe(200);
      expect(file.headers.get('content-type')).toBe('application/pdf');
      expect(file.buffer!.subarray(0, 4).toString()).toBe('%PDF');

      const text = await pdfText(file.buffer!);

      expect(text).toContain(d.number);
      expect(text).toContain(d.requisites.company.name);
      expect(text).toContain(d.requisites.partner.name);
      // Кириллица не должна осыпаться в квадраты: слово из шаблона на месте.
      expect(text).toContain('Поставщик');
      expect(squeeze(text)).toContain(squeeze(d.requisites.amountInWords));

      // Табличная часть целиком: и первая колонка, и последняя. Без сетки
      // колонок LibreOffice оставлял от таблицы только номера строк.
      const flat = squeeze(text);

      // Шапка таблицы — самое надёжное свидетельство, что колонки на месте:
      // эти слова встречаются только в ней. Без сетки колонок LibreOffice
      // оставлял от таблицы «№» и «Наименование», а остальные шесть терял.
      expect(d.lines.length).toBeGreaterThan(1);
      for (const title of ['Кол-во', 'Ед.', 'Цена', 'Сумма без НДС', 'НДС', 'Всего']) {
        expect(flat).toContain(squeeze(title));
      }

      // Название в ячейке переносится, и `pdftotext -layout` читает страницу
      // построчно: продолжение названия оказывается после чисел соседних
      // колонок. Поэтому сверяем по словам, а не целой строкой — иначе
      // проверялась бы ширина колонки.
      for (const line of d.lines) {
        for (const word of line.name.split(/\s+/).filter((w: string) => w.length > 2)) {
          expect(flat).toContain(squeeze(word));
        }
        // Итог по строке: у документа на несколько строк он не совпадает с
        // итогом документа, и взяться ему больше неоткуда, кроме таблицы.
        expect(flat).toContain(
          squeeze(
            Number(line.amountTotal).toLocaleString('ru-RU', {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            }),
          ),
        );
      }
      // Разряды в суммах остаются неразрывными пробелами, а не слипаются.
      const total = Number(d.amountTotal).toLocaleString('ru-RU', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
      expect(text.replace(/ /g, ' ')).toContain(total.replace(/ /g, ' '));
    },
    120_000,
  );

  it(
    'узбекская форма печатается латиницей со своими буквами',
    async () => {
      const created = await makeDoc(invTypeUid, 'uz');
      expect(created.status).toBe(201);
      const d = (await get(`/api/v1/documents/${created.body.data.uid}`)).body.data;

      const file = await download(`/api/v1/documents/${d.uid}/file?format=pdf`);
      expect(file.status).toBe(200);
      const text = await pdfText(file.buffer!);

      expect(text).toContain('Yetkazib beruvchi');
      // Знак в «to‘lov» обязан дожить до бумаги: шрифт без него подставляет
      // замену, и на счёте выходит «to?lov». Знак здесь U+2018 — такой по всей
      // системе; узбекский стандарт требует U+02BB, и это расхождение названо
      // в отчёте, а не чинится молча в одном файле из тридцати.
      expect(text).toMatch(/[oO]‘/);
      expect(text).not.toMatch(/\ufffd|\u25a1/);
      expect(squeeze(text)).toContain(squeeze(d.requisites.amountInWords));
    },
    120_000,
  );
});

describe('готовый PDF не пересобирается', () => {
  it(
    'второе скачивание отдаёт тот же файл и не запускает LibreOffice заново',
    async () => {
      const created = await makeDoc(invTypeUid);
      const uid = created.body.data.uid;

      const first = await download(`/api/v1/documents/${uid}/file?format=pdf`);
      expect(first.status).toBe(200);
      const built = await db.query(
        `SELECT pdf_key, pdf_size, pdf_built_at, pdf_version, version
           FROM document WHERE uid = $1::uuid`,
        [uid],
      );
      expect(built.rows[0].pdf_key).toBeTruthy();
      expect(Number(built.rows[0].pdf_size)).toBe(first.buffer!.length);
      expect(built.rows[0].pdf_version).toBe(built.rows[0].version);

      const second = await download(`/api/v1/documents/${uid}/file?format=pdf`);
      expect(second.buffer!.equals(first.buffer!)).toBe(true);
      // Время сборки не изменилось — значит, не пересобирали.
      const again = await db.query(
        `SELECT pdf_built_at FROM document WHERE uid = $1::uuid`,
        [uid],
      );
      expect(again.rows[0].pdf_built_at.getTime()).toBe(
        built.rows[0].pdf_built_at.getTime(),
      );
    },
    180_000,
  );

  it(
    'изменилась версия документа — PDF собирается заново, старый файл убирается',
    async () => {
      const created = await makeDoc(invTypeUid);
      const uid = created.body.data.uid;

      const first = await download(`/api/v1/documents/${uid}/file?format=pdf`);
      expect(first.status).toBe(200);
      const before = await db.query(
        `SELECT pdf_key, pdf_built_at FROM document WHERE uid = $1::uuid`,
        [uid],
      );

      // Версию двигает правка документа — она придёт в Э6. Здесь двигаем её
      // прямо, потому что проверяем не правку, а то, что кеш на неё смотрит.
      await db.query(`UPDATE document SET version = version + 1 WHERE uid = $1::uuid`, [uid]);

      const second = await download(`/api/v1/documents/${uid}/file?format=pdf`);
      expect(second.status).toBe(200);
      const after = await db.query(
        `SELECT pdf_key, pdf_built_at, pdf_version, version FROM document WHERE uid = $1::uuid`,
        [uid],
      );
      expect(after.rows[0].pdf_key).not.toBe(before.rows[0].pdf_key);
      expect(after.rows[0].pdf_version).toBe(after.rows[0].version);
      expect(after.rows[0].pdf_built_at.getTime()).toBeGreaterThan(
        before.rows[0].pdf_built_at.getTime(),
      );

      // Прежний файл не остался лежать: два PDF одного счёта — это шанс
      // отправить клиенту устаревший.
      const { LocalDiskStorage, defaultStorageRoot } = await import(
        '../src/attachments/storage.js'
      );
      const storage = new LocalDiskStorage(defaultStorageRoot());
      await expect(storage.get(before.rows[0].pdf_key)).rejects.toThrow();
    },
    180_000,
  );
});

describe('отказы', () => {
  it(
    'без опубликованного шаблона PDF отказывает так же, как DOCX',
    async () => {
      const created = await makeDoc(contractTypeUid);
      expect(created.status).toBe(201);
      const res = await download(`/api/v1/documents/${created.body.data.uid}/file?format=pdf`);
      expect(res.status).toBe(409);
      expect(res.body.error.message).toContain('шаблон');
      const row = await db.query(
        `SELECT pdf_key FROM document WHERE uid = $1::uuid`,
        [created.body.data.uid],
      );
      expect(row.rows[0].pdf_key).toBeNull();
    },
    120_000,
  );

  it('формат, которого нет, отбивается, а не подсовывает DOCX', async () => {
    const created = await makeDoc(invTypeUid);
    const res = await download(`/api/v1/documents/${created.body.data.uid}/file?format=xlsx`);
    // 400 — разбор запроса не прошёл. Это не 422: 422 означает «поняли, но
    // сделать нельзя», а здесь мы не поняли самого запроса.
    expect(res.status).toBe(400);
  });

  it(
    'без format отдаётся DOCX — прежние ссылки продолжают работать',
    async () => {
      const created = await makeDoc(invTypeUid);
      const res = await download(`/api/v1/documents/${created.body.data.uid}/file`);
      expect(res.status).toBe(200);
      expect(res.buffer!.subarray(0, 2).toString()).toBe('PK');
      expect(res.headers.get('content-type')).toContain('wordprocessingml');
    },
    120_000,
  );
});
