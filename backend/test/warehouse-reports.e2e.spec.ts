/**
 * Отчёты склада и выгрузка на живой базе (ТЗ 5.1).
 *
 * Форматы сами по себе проверяет `export-formats.spec.ts`. Здесь проверяется
 * то, чего без базы не проверить:
 *
 *   - отчёт отдаёт те же строки, что лежат в таблицах, а не «сколько-то»;
 *   - период действительно сужает движения и расхождения;
 *   - оборачиваемость сходится сама с собой: начало + приход − расход = конец,
 *     а конец периода «по сейчас» равен нынешнему остатку;
 *   - выгруженный файл — тот же отчёт, а не другой запрос к базе.
 *
 * Прогон ничего не пишет: отчёты только читают.
 */
import 'dotenv/config';
import { Client } from 'pg';
import { HUB_ITEM_CODE } from '../prisma/catalog-metallasia.js';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { AuthGuard } from '../src/auth/auth.guard.js';
import { WarehouseModule } from '../src/warehouse/warehouse.module.js';
import { ContextMiddleware } from '../src/common/context.middleware.js';
import { EnvelopeInterceptor } from '../src/common/envelope.interceptor.js';
import { ErrorFilter } from '../src/common/error.filter.js';

let app: INestApplication;
let base: string;
let db: Client;

const PASSWORD = process.env.SEED_PASSWORD ?? 'metall-dev-2026';

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${base}${path}`, init);
  return { status: res.status, body: (await res.json()) as any };
}

async function login(loginName: string) {
  const res = await api('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: loginName, password: PASSWORD }),
  });
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`Логин ${loginName} не прошёл: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.data as { token: string };
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

let keeper: Awaited<ReturnType<typeof login>>;
let accountant: Awaited<ReturnType<typeof login>>;
let sergeli: { uid: string };

interface ReportBody {
  kind: string;
  title: string;
  subtitle: string;
  columns: { title: string; numeric?: boolean }[];
  rows: (string | number | null)[][];
  total: number;
  truncated: boolean;
}

async function report(kind: string, query = ''): Promise<ReportBody> {
  const res = await api(`/api/v1/warehouse/reports/${kind}${query}`, {
    headers: auth(keeper.token),
  });
  if (res.status !== 200) {
    throw new Error(`Отчёт ${kind} не прочитался: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.data as ReportBody;
}

async function file(kind: string, format: 'csv' | 'xlsx', query = '') {
  const res = await fetch(
    `${base}/api/v1/warehouse/reports/${kind}/file?format=${format}${query}`,
    { headers: auth(keeper.token) },
  );
  return {
    status: res.status,
    type: res.headers.get('content-type') ?? '',
    disposition: res.headers.get('content-disposition') ?? '',
    buffer: Buffer.from(await res.arrayBuffer()),
  };
}

const KINDS = ['stock', 'moves', 'availability', 'turnover', 'inventory-diff'];

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [PrismaModule, AuthModule, WarehouseModule],
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

  keeper = await login('a.saidov');
  accountant = await login('m.rahimova');

  const wh = await db.query<{ uid: string }>(`SELECT uid FROM warehouse WHERE code = 'SERGELI'`);
  sergeli = wh.rows[0]!;
});

afterAll(async () => {
  await db.end();
  await app.close();
});

describe('отчёты склада', () => {
  it('отдаются по праву просмотра склада и не отдаются без него', async () => {
    const ok = await api('/api/v1/warehouse/reports/stock', { headers: auth(keeper.token) });
    expect(ok.status).toBe(200);

    const denied = await api('/api/v1/warehouse/reports/stock', {
      headers: auth(accountant.token),
    });
    expect(denied.status).toBe(403);
  });

  it('выдуманный отчёт не строится', async () => {
    const res = await api('/api/v1/warehouse/reports/pridumannyy', {
      headers: auth(keeper.token),
    });
    expect(res.status).toBe(400);
  });

  it('все пять отчётов из ТЗ 5.1 строятся и заполнены', async () => {
    for (const kind of KINDS) {
      const data = await report(kind, '?limit=5000');
      expect(data.kind, kind).toBe(kind);
      expect(data.title.length, kind).toBeGreaterThan(0);
      expect(data.columns.length, kind).toBeGreaterThan(3);
      expect(data.rows.length, `в отчёте ${kind} нет строк`).toBeGreaterThan(0);
      // Строка обязана совпадать с шапкой по ширине: иначе в Excel значения
      // встанут не под своими заголовками.
      for (const row of data.rows) expect(row.length, kind).toBe(data.columns.length);
      // Числовая колонка должна приходить числом, а не подписанной строкой.
      const numericAt = data.columns.findIndex((c) => c.numeric);
      expect(numericAt, kind).toBeGreaterThan(-1);
      const values = data.rows.map((r) => r[numericAt]).filter((v) => v !== null);
      expect(values.every((v) => typeof v === 'number'), kind).toBe(true);
    }
  });

  it('остатки: строк столько же, сколько в остатке', async () => {
    const data = await report('stock', '?limit=5000');
    const count = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM stock_balance WHERE qty_on_hand > 0`,
    );
    expect(data.total).toBe(Number(count.rows[0]!.n));
    expect(data.truncated).toBe(false);
  });

  it('остатки: фильтр склада сужает отчёт', async () => {
    const all = await report('stock', '?limit=5000');
    const one = await report('stock', `?limit=5000&warehouse=${sergeli.uid}`);
    expect(one.total).toBeGreaterThan(0);
    expect(one.total).toBeLessThan(all.total);
    expect(one.subtitle).toContain('Сергели');
    const warehouses = new Set(one.rows.map((r) => r[0]));
    expect(warehouses.size).toBe(1);
  });

  it('несуществующий склад — отказ, а не пустой отчёт', async () => {
    const res = await api(
      '/api/v1/warehouse/reports/stock?warehouse=00000000-0000-7000-8000-000000000000',
      { headers: auth(keeper.token) },
    );
    expect(res.status).toBe(422);
  });

  it('движение: период сужает выборку', async () => {
    const wide = await report('moves', '?from=2026-01-01&to=2026-12-31&limit=5000');
    const narrow = await report('moves', '?from=2026-09-20&to=2026-09-24&limit=5000');
    expect(wide.total).toBeGreaterThan(narrow.total);

    // Границы — календарные дни Ташкента, а не UTC: сеанс базы живёт в UTC, и
    // сверять надо тем же выражением, каким считает отчёт.
    const count = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM stock_move
        WHERE moved_at >= ('2026-09-20'::date::timestamp AT TIME ZONE 'Asia/Tashkent')
          AND moved_at <  ('2026-09-25'::date::timestamp AT TIME ZONE 'Asia/Tashkent')`,
    );
    expect(narrow.total).toBe(Number(count.rows[0]!.n));
    expect(narrow.subtitle).toContain('2026-09-20');
  });

  it('период задом наперёд — отказ', async () => {
    const res = await api('/api/v1/warehouse/reports/moves?from=2026-09-24&to=2026-09-01', {
      headers: auth(keeper.token),
    });
    expect(res.status).toBe(422);
  });

  it('доступное и зарезервированное: цифры сходятся с базой', async () => {
    const data = await report('availability', '?limit=5000');
    const row = data.rows.find((r) => r[1] === HUB_ITEM_CODE && String(r[0]).includes('Сергели'))!;
    expect(row, 'в отчёте нет опорной позиции на Сергели').toBeDefined();

    const inDb = await db.query<{ on_hand: string; promised: string }>(
      `SELECT (SELECT coalesce(sum(qty_on_hand), 0) FROM stock_balance sb
                JOIN item i ON i.id = sb.item_id JOIN warehouse w ON w.id = sb.warehouse_id
               WHERE i.code = $1 AND w.code = 'SERGELI')::text AS on_hand,
              (SELECT coalesce(sum(qty), 0) FROM stock_reservation r
                JOIN item i ON i.id = r.item_id JOIN warehouse w ON w.id = r.warehouse_id
               WHERE i.code = $1 AND w.code = 'SERGELI' AND r.status = 'active'
                 AND (r.expires_at IS NULL OR r.expires_at > now()))::text AS promised`,
      [HUB_ITEM_CODE],
    );
    expect(Number(row[4])).toBeCloseTo(Number(inDb.rows[0]!.on_hand), 6);
    expect(Number(row[5])).toBeCloseTo(Number(inDb.rows[0]!.promised), 6);
    // Доступно — разность, а не отдельно посчитанное число.
    expect(Number(row[6])).toBeCloseTo(Number(row[4]) - Number(row[5]), 6);
  });

  it('оборачиваемость: начало плюс приход минус расход равно концу', async () => {
    const data = await report('turnover', '?limit=5000');
    expect(data.rows.length).toBeGreaterThan(0);
    for (const row of data.rows) {
      const [, , , atStart, came, went, atEnd] = row as (string | number)[];
      expect(Number(atStart) + Number(came) - Number(went)).toBeCloseTo(Number(atEnd), 5);
    }
  });

  it('оборачиваемость: конец периода «по сейчас» — это нынешний остаток', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const data = await report('turnover', `?to=${today}&limit=5000`);
    const row = data.rows.find((r) => r[0] === HUB_ITEM_CODE)!;
    expect(row).toBeDefined();

    const inDb = await db.query<{ on_hand: string }>(
      `SELECT coalesce(sum(sb.qty_on_hand), 0)::text AS on_hand
         FROM stock_balance sb JOIN item i ON i.id = sb.item_id
        WHERE i.code = $1`,
      [HUB_ITEM_CODE],
    );
    expect(Number(row[6])).toBeCloseTo(Number(inDb.rows[0]!.on_hand), 6);
  });

  it('расхождения инвентаризации: только те строки, где разошлось', async () => {
    const data = await report('inventory-diff', '?from=2026-01-01&to=2026-12-31&limit=5000');
    expect(data.rows.length).toBeGreaterThan(0);
    for (const row of data.rows) {
      expect(Number(row[13])).not.toBe(0);
      // Расхождение — это разность посчитанного и учтённого, а не третье число.
      expect(Number(row[13])).toBeCloseTo(Number(row[12]) - Number(row[11]), 6);
    }

    const count = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM inventory_sheet_line ln
         JOIN inventory_sheet s ON s.id = ln.sheet_id
        WHERE ln.qty_diff IS NOT NULL AND ln.qty_diff <> 0 AND s.status <> 'cancelled'`,
    );
    expect(data.total).toBe(Number(count.rows[0]!.n));
  });

  it('предел строк не скрывается: отчёт говорит, что обрезан', async () => {
    const data = await report('stock', '?limit=3');
    expect(data.rows.length).toBe(3);
    expect(data.truncated).toBe(true);
    expect(data.total).toBeGreaterThan(3);
  });
});

describe('выгрузка отчёта файлом', () => {
  it('CSV отдаётся файлом, с BOM и точкой с запятой', async () => {
    const res = await file('stock', 'csv', '&limit=50');
    expect(res.status).toBe(200);
    expect(res.type).toContain('text/csv');
    expect(res.disposition).toContain('attachment');
    expect(res.disposition).toContain('sklad-stock-');

    const text = res.buffer.toString('utf8');
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const head = text.slice(1).split('\r\n')[0]!;
    expect(head.split(';')[0]).toBe('Склад');
    // В конверт файл не заворачивается: JSON с полем data здесь был бы ошибкой.
    expect(text).not.toContain('"data"');
  });

  it('Excel открывается и содержит те же строки, что и отчёт', async () => {
    const data = await report('stock', '?limit=50');
    const res = await file('stock', 'xlsx', '&limit=50');
    expect(res.status).toBe(200);
    expect(res.type).toContain('spreadsheetml');
    // Признак zip: без него это не xlsx, чем бы файл ни назывался.
    expect(res.buffer.subarray(0, 2).toString('latin1')).toBe('PK');

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.buffer as unknown as ArrayBuffer);
    const sheet = wb.worksheets[0]!;
    expect(sheet.name).toBe(data.title);
    expect(sheet.getRow(1).getCell(1).value).toBe(data.columns[0]!.title);
    expect(sheet.getRow(2).getCell(1).value).toBe(data.rows[0]![0]);
    // Наличие — девятая колонка отчёта остатков, и в Excel это число.
    expect(typeof sheet.getRow(2).getCell(9).value).toBe('number');
  });

  it('формат выгрузки обязателен и проверяется', async () => {
    const res = await fetch(`${base}/api/v1/warehouse/reports/stock/file`, {
      headers: auth(keeper.token),
    });
    expect(res.status).toBe(400);

    // `pdf` с Э5 поддерживается, поэтому пример неподдержанного формата
    // теперь другой: иначе проверка молча перестала бы проверять.
    const bad = await fetch(`${base}/api/v1/warehouse/reports/stock/file?format=docx`, {
      headers: auth(keeper.token),
    });
    expect(bad.status).toBe(400);
  });

  it('отчёт выгружается в PDF — не заголовком, а настоящими байтами', async () => {
    const res = await fetch(`${base}/api/v1/warehouse/reports/stock/file?format=pdf`, {
      headers: auth(keeper.token),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(0, 4).toString()).toBe('%PDF');
    expect(bytes.length).toBeGreaterThan(1000);
  }, 120_000);

  it('файл не отдаётся без права просмотра склада', async () => {
    const res = await fetch(`${base}/api/v1/warehouse/reports/stock/file?format=csv`, {
      headers: auth(accountant.token),
    });
    expect(res.status).toBe(403);
  });
});
