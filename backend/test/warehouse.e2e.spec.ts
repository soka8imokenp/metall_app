import 'dotenv/config';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
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
import { HUB_ITEM_CODE } from '../prisma/catalog-metallasia.js';

/**
 * Сквозная проверка склада: приложение целиком, живая база, те же политики
 * RLS. Главное, что здесь проверяется, — остаток на экране и журнал под ним
 * это одно и то же число, и что кладовщик завода не видит склад торгового
 * дома, даже если попросит его прямо.
 */
let app: INestApplication;
let base: string;

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
  return res.body.data as {
    token: string;
    companies: { uid: string; code: string }[];
    permissions: string[];
  };
}

const auth = (token: string, companyUids?: string[]) => ({
  Authorization: `Bearer ${token}`,
  ...(companyUids?.length ? { 'X-Company-Id': companyUids.join(',') } : {}),
});

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
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
}, 60_000);

afterAll(async () => {
  await app?.close();
});

describe('GET /warehouse/summary', () => {
  it('отдаёт запас, уровни, склады и обороты периода', async () => {
    const me = await login('admin');
    const res = await api('/api/v1/warehouse/summary?period=30d', { headers: auth(me.token) });

    expect(res.status).toBe(200);
    const d = res.body.data;

    expect(d.stock.rows).toBeGreaterThan(0);
    expect(d.stock.items).toBeGreaterThan(0);
    expect(d.stock.batches).toBeGreaterThan(0);
    // Стоимость запаса — строка: деньги через число не гоняем.
    expect(typeof d.stock.value).toBe('string');
    expect(Number(d.stock.value)).toBeGreaterThan(0);

    expect(typeof d.levels.belowCritical).toBe('number');
    expect(d.warehouses.length).toBeGreaterThan(0);
    for (const w of d.warehouses) expect(typeof w.value).toBe('string');

    // Цех и склад связаны, и это видно в оборотах: одних продаж мало.
    const kinds = d.moves.map((m: any) => m.operationType);
    expect(kinds).toContain('shipment');
  });

  it('сумма по складам сходится со стоимостью запаса', async () => {
    const me = await login('admin');
    const res = await api('/api/v1/warehouse/summary', { headers: auth(me.token) });
    const d = res.body.data;

    const byWarehouse = d.warehouses.reduce((s: number, w: any) => s + Number(w.value), 0);
    expect(Math.abs(byWarehouse - Number(d.stock.value))).toBeLessThan(1);
  });
});

describe('GET /warehouse/stock', () => {
  it('строка остатка приходит с партией, складом и уровнями', async () => {
    const me = await login('a.saidov');
    const res = await api('/api/v1/warehouse/stock?limit=20', { headers: auth(me.token) });

    expect(res.status).toBe(200);
    const rows = res.body.data.rows;
    expect(rows.length).toBeGreaterThan(0);

    for (const r of rows) {
      expect(Number(r.qtyOnHand)).toBeGreaterThan(0);
      expect(r.item.code).toBeTruthy();
      expect(r.item.unit).toBeTruthy();
      expect(r.warehouse.nameRu).toBeTruthy();
      // Доступно — это остаток за вычетом резерва, а не отдельное число.
      expect(Math.abs(Number(r.qtyAvailable) - (Number(r.qtyOnHand) - Number(r.qtyReserved))))
        .toBeLessThan(0.000001);
      expect(Number(r.qtyReserved)).toBeLessThanOrEqual(Number(r.qtyOnHand));
    }
  });

  it('поиск ищет по коду, названию и номеру партии', async () => {
    const me = await login('a.saidov');
    const all = await api('/api/v1/warehouse/stock?limit=200', { headers: auth(me.token) });
    const sample = all.body.data.rows[0];

    const byCode = await api(
      `/api/v1/warehouse/stock?search=${encodeURIComponent(sample.item.code)}`,
      { headers: auth(me.token) },
    );
    expect(byCode.body.data.rows.length).toBeGreaterThan(0);
    for (const r of byCode.body.data.rows) expect(r.item.code).toBe(sample.item.code);

    const byBatch = await api(
      `/api/v1/warehouse/stock?search=${encodeURIComponent(sample.batch.number)}`,
      { headers: auth(me.token) },
    );
    expect(byBatch.body.data.rows.length).toBeGreaterThan(0);
  });

  it('фильтр «только критические» показывает то же, что подсвечено в строке', async () => {
    const me = await login('a.saidov');
    const res = await api('/api/v1/warehouse/stock?critical=true&limit=200', {
      headers: auth(me.token),
    });

    expect(res.status).toBe(200);
    for (const r of res.body.data.rows) expect(r.isBelowCritical).toBe(true);
  });

  it('фильтр по складу не пускает чужие строки', async () => {
    const me = await login('admin');
    const summary = await api('/api/v1/warehouse/summary', { headers: auth(me.token) });
    const wh = summary.body.data.warehouses.find((w: any) => w.rows > 0);

    const res = await api(`/api/v1/warehouse/stock?warehouse=${wh.uid}&limit=200`, {
      headers: auth(me.token),
    });
    expect(res.body.data.rows.length).toBeGreaterThan(0);
    for (const r of res.body.data.rows) expect(r.warehouse.uid).toBe(wh.uid);
  });

  it('чужую компанию заголовком не выпросить', async () => {
    // Видимость задаётся сессией, а не тем, что прислал клиент. Запрос чужой
    // компании не «молча отдаёт своё», а отказывает: подменённый заголовок —
    // это ошибка вызова, и знать о ней лучше сразу.
    const trade = await login('d.karimov');
    const admin = await login('admin');
    const plant = admin.companies.find((c) => c.code === 'plant')!;
    expect(trade.companies.some((c) => c.uid === plant.uid)).toBe(false);

    const res = await api('/api/v1/warehouse/stock?limit=200', {
      headers: auth(trade.token, [plant.uid]),
    });
    expect(res.status).toBe(403);
    expect(res.body.data).toBeUndefined();

    // А своё он видит, и это только торговый дом.
    const own = await api('/api/v1/warehouse/stock?limit=200', { headers: auth(trade.token) });
    expect(own.status).toBe(200);
    expect(own.body.data.rows.length).toBeGreaterThan(0);
    for (const r of own.body.data.rows) expect(r.warehouse.code.startsWith('ZAVOD')).toBe(false);
  });

  it('без права warehouse.view не пускает', async () => {
    // Бухгалтер — единственная роль без доступа к складу: он смотрит деньги,
    // а не ячейки.
    const accountant = await login('m.rahimova');
    expect(accountant.permissions).not.toContain('warehouse.view');

    const res = await api('/api/v1/warehouse/stock', { headers: auth(accountant.token) });
    expect(res.status).toBe(403);
  });
});

describe('GET /warehouse/batches/:uid', () => {
  it('показывает происхождение партии и весь её путь', async () => {
    const me = await login('admin');
    // Партию ищем по опорной позиции каталога, а не берём первую попавшуюся в
    // остатках. База у прогонов одна, и приспособления соседних файлов в ней
    // живут одновременно: уборка выпуска сознательно отвязывает партию от
    // заказа (удалить её нельзя - держит журнал), и «первая партия в остатках»
    // иногда оказывается именно такой. Партии опорной позиции заводит только
    // сев, у них происхождение есть всегда.
    const stock = await api(`/api/v1/warehouse/stock?limit=50&search=${HUB_ITEM_CODE}`, {
      headers: auth(me.token),
    });
    const row = stock.body.data.rows.find((r: any) => r.batch);
    expect(row, `в остатках нет партии ${HUB_ITEM_CODE}`).toBeTruthy();

    const res = await api(`/api/v1/warehouse/batches/${row.batch.uid}`, { headers: auth(me.token) });
    expect(res.status).toBe(200);
    const d = res.body.data;

    expect(d.batch.number).toBe(row.batch.number);
    expect(d.batch.item.code).toBe(row.item.code);
    // Партия либо куплена, либо выпущена цехом. Ни то ни другое — значит
    // происхождение потеряно, и сертификат не к чему привязать.
    expect(Boolean(d.batch.supplier) || Boolean(d.batch.productionOrder)).toBe(true);

    expect(d.moves.length).toBeGreaterThan(0);
    const first = d.moves[0];
    expect(['receipt', 'output']).toContain(first.operationType);
    expect(first.toWarehouse).toBeTruthy();

    // Журнал партии сходится с её остатком: сумма движений — это то,
    // что лежит на складе, и разойтись им негде.
    //
    // Двусторонние движения считаем обеими сторонами, а не одной: у перекладки
    // между ячейками одного склада есть и «откуда», и «куда», и в сумме она даёт
    // ноль. Формула «есть приёмник — значит плюс» записала бы её приходом и
    // насчитала партии товар, которого не появилось.
    const net = d.moves.reduce(
      (s: number, m: any) =>
        s + (m.toWarehouse ? Number(m.qty) : 0) - (m.fromWarehouse ? Number(m.qty) : 0),
      0,
    );
    const onHand = d.balances.reduce((s: number, b: any) => s + Number(b.qtyOnHand), 0);
    expect(Math.abs(net - onHand)).toBeLessThan(0.000001);
  });

  it('партия цеха подписана производственным заказом', async () => {
    const me = await login('admin');
    const stock = await api('/api/v1/warehouse/stock?limit=500', { headers: auth(me.token) });

    let found: any = null;
    for (const row of stock.body.data.rows) {
      if (!row.batch) continue;
      const res = await api(`/api/v1/warehouse/batches/${row.batch.uid}`, {
        headers: auth(me.token),
      });
      if (res.body.data.batch.productionOrder) {
        found = res.body.data;
        break;
      }
    }

    expect(found, 'на складе должна лежать хотя бы одна партия собственного выпуска').toBeTruthy();
    expect(found.batch.supplier).toBeNull();
    expect(found.moves[0].operationType).toBe('output');
    expect(found.moves[0].docNumber).toBe(found.batch.productionOrder);
  });

  it('несуществующая партия — 404, а не пустой ответ', async () => {
    const me = await login('admin');
    const res = await api('/api/v1/warehouse/batches/00000000-0000-7000-8000-000000000000', {
      headers: auth(me.token),
    });
    expect(res.status).toBe(404);
  });
});
