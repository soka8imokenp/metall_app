/**
 * Сканер и этикетки: приложение целиком, живая база (ТЗ 5.9).
 *
 * Проверяем не «маршрут ответил 200», а круг целиком: код, который экран взял
 * из остатка, находит тот же самый объект через сканер и печатается на
 * этикетке. Разойдись эти три места — этикетка наклеится на одну трубу,
 * а сканер найдёт другую.
 *
 * Прогон ничего не пишет: и скан, и печать только читают.
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
  return res.body.data as { token: string; permissions: string[] };
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const json = (token: string) => ({ ...auth(token), 'Content-Type': 'application/json' });

let keeper: Awaited<ReturnType<typeof login>>;
/** Человек только завода: видит одну компанию — на нём проверяем изоляцию. */
let plantOnly: Awaited<ReturnType<typeof login>>;

const scan = (token: string, code: string) =>
  api(`/api/v1/warehouse/scan?code=${encodeURIComponent(code)}`, { headers: auth(token) });

const labels = (token: string, body: Record<string, unknown>) =>
  api('/api/v1/warehouse/labels', {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify(body),
  });

const TRADE_WAREHOUSES = new Set(['ERKIN', 'SERGELI']);

/** Строка остатка с партией, серийным номером и ячейкой — все четыре кода разом. */
let stockRow: any;
let serialRow: any;
let templates: any[];

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
  plantOnly = await login('b.ergashev');

  const stock = await api('/api/v1/warehouse/stock?limit=500', { headers: auth(keeper.token) });
  expect(stock.status).toBe(200);
  const rows = stock.body.data.rows as any[];
  // Строка именно торговой конторы: на ней проверяется, что человеку завода
  // её не видно. Склады торговой — ERKIN и SERGELI.
  stockRow = rows.find((r) => r.batch && r.location && TRADE_WAREHOUSES.has(r.warehouse.code));
  serialRow = rows.find((r) => r.serial && r.location);
  if (!stockRow) throw new Error('в остатке торговой конторы нет строки с партией и ячейкой');
  if (!serialRow) throw new Error('в остатке нет строки с серийным номером');

  const t = await api('/api/v1/warehouse/labels/templates', { headers: auth(keeper.token) });
  expect(t.status).toBe(200);
  templates = t.body.data.rows;
}, 60_000);

afterAll(async () => {
  await db?.end();
  await app?.close();
});

describe('коды приезжают вместе с данными', () => {
  it('в строке остатка есть код на каждое измерение', () => {
    expect(stockRow.labelCodes.item).toMatch(/^MAI\d{10}$/);
    expect(stockRow.labelCodes.batch).toMatch(/^MAB\d{10}$/);
    expect(stockRow.labelCodes.location).toMatch(/^MAL\d{10}$/);
    expect(stockRow.labelCodes.serial).toBeNull();
    expect(serialRow.labelCodes.serial).toMatch(/^MAS\d{10}$/);
  });

  it('справочники формы несут те же коды', async () => {
    const refs = await api('/api/v1/warehouse/refs', { headers: auth(keeper.token) });
    const item = refs.body.data.items.find((i: any) => i.code === stockRow.item.code);
    expect(item.labelCode).toBe(stockRow.labelCodes.item);

    const loc = refs.body.data.locations.find(
      (l: any) =>
        l.warehouseCode === stockRow.warehouse.code &&
        l.zoneCode === stockRow.zone &&
        l.code === stockRow.location,
    );
    expect(loc.labelCode).toBe(stockRow.labelCodes.location);
  });

  it('карточка партии и путь номера называют свой код', async () => {
    const trace = await api(`/api/v1/warehouse/batches/${stockRow.batch.uid}`, {
      headers: auth(keeper.token),
    });
    expect(trace.body.data.batch.labelCode).toBe(stockRow.labelCodes.batch);

    const serial = await api(`/api/v1/warehouse/serials/${serialRow.serial}`, {
      headers: auth(keeper.token),
    });
    expect(serial.body.data.serial.labelCode).toBe(serialRow.labelCodes.serial);
  });
});

describe('сканер', () => {
  it('находит по нашему коду все четыре вида', async () => {
    const item = await scan(keeper.token, stockRow.labelCodes.item);
    expect(item.status).toBe(200);
    expect(item.body.data).toMatchObject({
      kind: 'item',
      matchedBy: 'labelCode',
      code: stockRow.item.code,
      labelCode: stockRow.labelCodes.item,
    });

    const batch = await scan(keeper.token, stockRow.labelCodes.batch);
    expect(batch.body.data).toMatchObject({
      kind: 'batch',
      uid: stockRow.batch.uid,
      number: stockRow.batch.number,
    });

    const loc = await scan(keeper.token, stockRow.labelCodes.location);
    expect(loc.body.data).toMatchObject({
      kind: 'location',
      warehouseCode: stockRow.warehouse.code,
      zoneCode: stockRow.zone,
      code: stockRow.location,
    });

    const serial = await scan(keeper.token, serialRow.labelCodes.serial);
    expect(serial.body.data).toMatchObject({ kind: 'serial', number: serialRow.serial });
  });

  it('берёт человеческие номера и чужие штрихкоды', async () => {
    // Сканер приносит и то, что напечатано не нами: номер трубы с бирки
    // завода, код номенклатуры из накладной, штрихкод ячейки от прошлой
    // системы. Отвечать «не распознан» на них значит заставить человека
    // печатать руками.
    const bySerial = await scan(keeper.token, serialRow.serial);
    expect(bySerial.body.data).toMatchObject({
      kind: 'serial',
      matchedBy: 'serialNumber',
      labelCode: serialRow.labelCodes.serial,
    });

    const byItemCode = await scan(keeper.token, stockRow.item.code.toLowerCase());
    expect(byItemCode.body.data).toMatchObject({
      kind: 'item',
      matchedBy: 'itemCode',
      labelCode: stockRow.labelCodes.item,
    });

    const loc = await db.query<{ barcode: string }>(
      `SELECT l.barcode FROM storage_location l
        JOIN warehouse_zone z ON z.id = l.zone_id
        JOIN warehouse w ON w.id = z.warehouse_id
       WHERE w.code = $1 AND z.code = $2 AND l.code = $3`,
      [stockRow.warehouse.code, stockRow.zone, stockRow.location],
    );
    const byLocBarcode = await scan(keeper.token, loc.rows[0]!.barcode);
    expect(byLocBarcode.body.data).toMatchObject({
      kind: 'location',
      matchedBy: 'locationBarcode',
      labelCode: stockRow.labelCodes.location,
    });
  });

  it('испорченный код отвергает, а не находит соседа', async () => {
    const good = stockRow.labelCodes.item;
    const broken = `${good.slice(0, -1)}${(Number(good.slice(-1)) + 1) % 10}`;
    const res = await scan(keeper.token, broken);
    expect(res.status).toBe(404);
    expect(res.body.error.message).toContain('не распознан');
  });

  it('чужую компанию не показывает', async () => {
    // Человек завода видит только свою компанию: позиция торговой конторы
    // для него не существует. Прячет её RLS, а не проверка в сервисе —
    // поэтому отказ приходит на том же маршруте и тем же кодом.
    expect((await scan(keeper.token, stockRow.labelCodes.item)).status).toBe(200);
    expect((await scan(plantOnly.token, stockRow.labelCodes.item)).status).toBe(404);
  });

  it('пустой код отбивает валидатором', async () => {
    const res = await api('/api/v1/warehouse/scan', { headers: auth(keeper.token) });
    expect(res.status).toBe(400);
  });
});

describe('этикетки', () => {
  it('шаблоны у каждой компании свои и один из них по умолчанию', () => {
    expect(templates.length).toBeGreaterThanOrEqual(2);
    const byCompany = new Map<string, any[]>();
    for (const t of templates) {
      byCompany.set(t.companyUid, [...(byCompany.get(t.companyUid) ?? []), t]);
    }
    for (const [, list] of byCompany) {
      expect(list.filter((t) => t.isDefault)).toHaveLength(1);
    }
  });

  it('сетка шаблона помещается на лист', () => {
    for (const t of templates) {
      const w = t.marginLeftMm + t.columns * t.labelWidthMm + (t.columns - 1) * t.gapXMm;
      const h = t.marginTopMm + t.rows * t.labelHeightMm + (t.rows - 1) * t.gapYMm;
      expect(w, `${t.code}: ширина`).toBeLessThanOrEqual(t.pageWidthMm);
      expect(h, `${t.code}: высота`).toBeLessThanOrEqual(t.pageHeightMm);
      expect(t.perPage).toBe(t.columns * t.rows);
    }
  });

  it('база не даёт завести шаблон, который не помещается', async () => {
    // Проверка стоит в базе, а не в форме: форма не единственный путь в неё.
    const company = await db.query<{ id: string }>(`SELECT id FROM company LIMIT 1`);
    await expect(
      db.query(
        `INSERT INTO label_template
           (company_id, code, name_ru, name_uz, page_width_mm, page_height_mm,
            label_width_mm, label_height_mm, columns, rows)
         VALUES ($1, 'BROKEN', 'не влезет', 'sigmaydi', 210, 297, 70, 37, 4, 8)`,
        [company.rows[0]!.id],
      ),
    ).rejects.toThrow(/label_template_grid_fits_page/);
  });

  it('печатает Code 128 с полосами и QR с матрицей', async () => {
    const line = templates.find((t) => t.symbology === 'code128')!;
    const square = templates.find((t) => t.symbology === 'qr')!;

    const bars = await labels(keeper.token, {
      templateUid: line.uid,
      codes: [stockRow.labelCodes.item, stockRow.labelCodes.batch],
    });
    expect(bars.status).toBe(201);
    expect(bars.body.data.labels).toHaveLength(2);
    const first = bars.body.data.labels[0];
    expect(first.symbol.symbology).toBe('code128');
    expect(first.symbol.widths.reduce((a: number, b: number) => a + b, 0)).toBe(
      first.symbol.modules,
    );
    expect(first.title).toBe(stockRow.item.code);
    expect(bars.body.data.labels[1].title).toBe(stockRow.batch.number);

    const qr = await labels(keeper.token, {
      templateUid: square.uid,
      codes: [serialRow.labelCodes.serial],
    });
    expect(qr.body.data.labels[0].symbol.symbology).toBe('qr');
    expect(qr.body.data.labels[0].symbol.rows).toHaveLength(
      qr.body.data.labels[0].symbol.size,
    );
  });

  it('копии умножают этикетки, а не объекты', async () => {
    const t = templates.find((x) => x.symbology === 'code128')!;
    const res = await labels(keeper.token, {
      templateUid: t.uid,
      codes: [stockRow.labelCodes.item],
      copies: 4,
    });
    expect(res.body.data.labels).toHaveLength(4);
    expect(new Set(res.body.data.labels.map((l: any) => l.labelCode)).size).toBe(1);
  });

  it('за раз печатает не больше пятисот', async () => {
    const t = templates.find((x) => x.symbology === 'code128')!;
    const res = await labels(keeper.token, {
      templateUid: t.uid,
      codes: Array.from({ length: 11 }, () => stockRow.labelCodes.item),
      copies: 50,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('550');
  });

  it('негодный код называет вслух, а не печатает пустую этикетку', async () => {
    const t = templates.find((x) => x.symbology === 'code128')!;
    const res = await labels(keeper.token, {
      templateUid: t.uid,
      codes: [stockRow.labelCodes.item, 'PPU-530-710'],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('PPU-530-710');
  });

  it('чужой шаблон не отдаёт', async () => {
    // `A4-65` заведён торговой конторе. Человеку завода его не видно — ни
    // в списке, ни по прямому uid.
    const trade65 = templates.find((t) => t.code === 'A4-65')!;
    const own = await api('/api/v1/warehouse/labels/templates', { headers: auth(plantOnly.token) });
    expect(own.body.data.rows.map((t: any) => t.code)).not.toContain('A4-65');

    const res = await labels(plantOnly.token, {
      templateUid: trade65.uid,
      codes: [serialRow.labelCodes.serial],
    });
    expect(res.status).toBe(404);
    expect(res.body.error.message).toContain('шаблон');
  });
});
