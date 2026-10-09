/**
 * Потребность в закупке на живой базе (ТЗ 5.10).
 *
 * Арифметику расчёта проверяет `warehouse-needs.spec.ts` числами. Здесь
 * проверяется другое, и без базы это не проверить:
 *
 *   - в расчёт приходят те числа, которые в базе лежат (остаток, активные
 *     резервы, план запущенных производственных заказов);
 *   - складской уровень действительно **перекрывает** компанийский, а не
 *     дополняет его — иначе одна нехватка попадёт в отчёт дважды;
 *   - плановый расход не размазывается по складам, когда разложить его нечем;
 *   - фильтр по складу сужает отчёт до компании этого склада.
 *
 * Прогон пишет ровно две вещи и убирает обе за собой: резерв (снимается) и
 * приход на второй склад (сторнируется). Строку уровня, заведённую под
 * проверку, удаляет прямым запросом — путей записи уровней пока нет, они в Э8.
 */
import 'dotenv/config';
import { Client } from 'pg';
import { HUB_ITEM_CODE } from '../prisma/catalog-metallasia.js';
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
  return res.body.data as { token: string; companies: { uid: string; code: string }[] };
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const json = (token: string) => ({ ...auth(token), 'Content-Type': 'application/json' });

let keeper: Awaited<ReturnType<typeof login>>;
let accountant: Awaited<ReturnType<typeof login>>;

interface NeedRow {
  key: string;
  scope: 'company' | 'warehouse';
  item: { code: string };
  warehouse: { uid: string; code: string } | null;
  minQty: string;
  criticalQty: string;
  onHand: string;
  promised: string;
  available: string;
  plannedOut: string;
  plannedCompany: string;
  plannedApplied: boolean;
  projected: string;
  needQty: string;
  state: 'critical' | 'below_min' | 'ok';
  needed: boolean;
}

async function needs(query = '') {
  const res = await api(`/api/v1/warehouse/purchase-needs${query}`, {
    headers: auth(keeper.token),
  });
  if (res.status !== 200) {
    throw new Error(`Потребность не прочиталась: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.data as {
    rows: NeedRow[];
    total: number;
    totals: { rows: number; critical: number; belowMin: number; plannedHidden: number };
  };
}

const num = (v: string) => Number(v);

/** Склад, на котором заведён уровень: с него и считаем ожидаемые числа. */
let sergeli: { uid: string; code: string };
let plantUid: string;
let tradeUid: string;

/** Резерв, поставленный прогоном. */
let heldReservation: string | null = null;
/** Приход, заведённый прогоном на втором складе. */
let extraReceipt: string | null = null;
/** Строка уровня, заведённая прогоном. */
let tempLevel: string | null = null;

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

  const wh = await db.query<{ uid: string; code: string }>(
    `SELECT uid, code FROM warehouse WHERE code = 'SERGELI'`,
  );
  sergeli = wh.rows[0]!;

  const companies = await db.query<{ uid: string; code: string }>(
    `SELECT uid, code FROM company WHERE code IN ('trade', 'plant')`,
  );
  tradeUid = companies.rows.find((c) => c.code === 'trade')!.uid;
  plantUid = companies.rows.find((c) => c.code === 'plant')!.uid;
});

afterAll(async () => {
  if (heldReservation) {
    await api(`/api/v1/warehouse/reservations/${heldReservation}`, {
      method: 'DELETE',
      headers: auth(keeper.token),
    });
  }
  if (extraReceipt) {
    await api(`/api/v1/warehouse/moves/${extraReceipt}/reverse`, {
      method: 'POST',
      headers: json(keeper.token),
      body: JSON.stringify({ comment: 'Уборка после проверки потребности' }),
    });
  }
  if (tempLevel) {
    await db.query(`DELETE FROM item_stock_level WHERE uid = $1`, [tempLevel]);
  }
  await db.end();
  await app.close();
});

describe('потребность в закупке: отчёт', () => {
  it('отдаётся по праву просмотра склада и не отдаётся без него', async () => {
    const ok = await api('/api/v1/warehouse/purchase-needs', { headers: auth(keeper.token) });
    expect(ok.status).toBe(200);

    const denied = await api('/api/v1/warehouse/purchase-needs', {
      headers: auth(accountant.token),
    });
    expect(denied.status).toBe(403);
  });

  it('по умолчанию в отчёте только то, что требует закупки', async () => {
    const data = await needs();
    expect(data.rows.length).toBeGreaterThan(0);
    for (const row of data.rows) expect(row.needed).toBe(true);
    expect(data.totals.rows).toBe(data.total);
    expect(data.totals.critical + data.totals.belowMin).toBeLessThanOrEqual(data.totals.rows);

    // Критические — сверху: закупка читает отчёт с первой строки.
    const firstOk = data.rows.findIndex((r) => r.state !== 'critical');
    if (firstOk > 0) {
      expect(data.rows.slice(firstOk).every((r) => r.state !== 'critical')).toBe(true);
    }
  });

  it('`all=true` показывает и позиции без нехватки', async () => {
    const tight = await needs();
    const wide = await needs('?all=true');
    expect(wide.total).toBeGreaterThan(tight.total);
    expect(wide.rows.some((r) => !r.needed)).toBe(true);
    // Счётчики считают тревогу, а не показанные строки: показ шире, а тревога
    // та же.
    expect(wide.totals.rows).toBe(tight.totals.rows);
  });

  it('складской уровень перекрывает компанийский, а не дополняет его', async () => {
    const data = await needs('?all=true');
    const arm = data.rows.filter((r) => r.item.code === HUB_ITEM_CODE);

    // В сиде у опорной позиции каталога заведены уровни на ERKIN и SERGELI.
    expect(arm.map((r) => r.scope).sort()).toEqual(['warehouse', 'warehouse']);
    expect(arm.every((r) => r.warehouse !== null)).toBe(true);
    expect(arm.some((r) => r.warehouse!.code === 'SERGELI')).toBe(true);

    // Уровни в строках — складские, а не из карточки позиции.
    const levels = await db.query<{ code: string; min_qty: string }>(
      `SELECT w.code, l.min_qty::text AS min_qty
         FROM item_stock_level l
         JOIN item i ON i.id = l.item_id
         JOIN warehouse w ON w.id = l.warehouse_id
        WHERE i.code = $1`,
      [HUB_ITEM_CODE],
    );
    for (const row of arm) {
      const inDb = levels.rows.find((l) => l.code === row.warehouse!.code)!;
      expect(num(row.minQty)).toBe(num(inDb.min_qty));
    }
  });

  it('числа складской строки сходятся с базой', async () => {
    const data = await needs('?all=true');
    const row = data.rows.find(
      (r) => r.item.code === HUB_ITEM_CODE && r.warehouse!.code === 'SERGELI',
    )!;
    expect(row).toBeDefined();

    const stock = await db.query<{ on_hand: string }>(
      `SELECT coalesce(sum(sb.qty_on_hand), 0)::text AS on_hand
         FROM stock_balance sb
         JOIN item i ON i.id = sb.item_id
         JOIN warehouse w ON w.id = sb.warehouse_id
        WHERE i.code = $1 AND w.code = 'SERGELI'`,
      [HUB_ITEM_CODE],
    );
    const held = await db.query<{ qty: string }>(
      `SELECT coalesce(sum(r.qty), 0)::text AS qty
         FROM stock_reservation r
         JOIN item i ON i.id = r.item_id
         JOIN warehouse w ON w.id = r.warehouse_id
        WHERE i.code = $1 AND w.code = 'SERGELI'
          AND r.status = 'active' AND (r.expires_at IS NULL OR r.expires_at > now())`,
      [HUB_ITEM_CODE],
    );

    expect(num(row.onHand)).toBeCloseTo(num(stock.rows[0]!.on_hand), 6);
    expect(num(row.promised)).toBeCloseTo(num(held.rows[0]!.qty), 6);
    expect(num(row.available)).toBeCloseTo(num(row.onHand) - num(row.promised), 6);
    expect(num(row.projected)).toBeCloseTo(num(row.available) - num(row.plannedOut), 6);
  });

  it('новый резерв увеличивает дозаказ ровно на обещанное', async () => {
    const before = (await needs('?all=true')).rows.find(
      (r) => r.item.code === HUB_ITEM_CODE && r.warehouse!.code === 'SERGELI',
    )!;

    // Обещаем то, что точно лежит: берём партию со склада.
    const batch = await db.query<{ number: string; qty: string }>(
      `SELECT b.number, sb.qty_available::text AS qty
         FROM stock_balance sb
         JOIN item i ON i.id = sb.item_id
         JOIN warehouse w ON w.id = sb.warehouse_id
         JOIN batch b ON b.id = sb.batch_id
        WHERE i.code = $1 AND w.code = 'SERGELI' AND sb.qty_available > 1
        ORDER BY sb.qty_available DESC LIMIT 1`,
      [HUB_ITEM_CODE],
    );
    expect(batch.rows[0], 'в сиде нет свободного товара на Сергели').toBeDefined();

    const made = await api('/api/v1/warehouse/reservations', {
      method: 'POST',
      headers: json(keeper.token),
      body: JSON.stringify({
        companyUid: tradeUid,
        itemCode: HUB_ITEM_CODE,
        batchNumber: batch.rows[0]!.number,
        warehouseCode: 'SERGELI',
        qty: '1.000000',
      }),
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    heldReservation = made.body.data.uid as string;

    const after = (await needs('?all=true')).rows.find(
      (r) => r.item.code === HUB_ITEM_CODE && r.warehouse!.code === 'SERGELI',
    )!;

    expect(num(after.promised)).toBeCloseTo(num(before.promised) + 1, 6);
    expect(num(after.available)).toBeCloseTo(num(before.available) - 1, 6);
    expect(num(after.projected)).toBeCloseTo(num(before.projected) - 1, 6);

    // Дозаказ считается от уровня, а не от «стало на одну тонну меньше»: если
    // до резерва запас был выше минимума, первая обещанная тонна дозаказа ещё
    // не создаёт. Проверяем то, что обещано контрактом, — дозаказ до уровня.
    const target = num(after.minQty) > 0 ? num(after.minQty) : num(after.criticalQty);
    expect(num(after.needQty)).toBeCloseTo(Math.max(0, target - num(after.projected)), 6);
    expect(num(after.needQty)).toBeGreaterThanOrEqual(num(before.needQty));
  });

  it('плановый расход запущенных заказов входит в компанийскую строку', async () => {
    const planned = await db.query<{ code: string; planned: string }>(
      `SELECT i.code, sum(GREATEST(pm.qty_planned - pm.qty_issued, 0))::text AS planned
         FROM production_material pm
         JOIN production_order po ON po.id = pm.production_order_id
         JOIN item i ON i.id = pm.item_id
        WHERE po.status IN ('planned', 'in_progress', 'paused')
          AND NOT EXISTS (SELECT 1 FROM item_stock_level l WHERE l.item_id = i.id)
        GROUP BY i.code
       HAVING sum(GREATEST(pm.qty_planned - pm.qty_issued, 0)) > 0
        ORDER BY 2 DESC LIMIT 1`,
    );
    expect(planned.rows[0], 'в сиде нет запущенных заказов с неполной выдачей').toBeDefined();
    const { code, planned: expected } = planned.rows[0]!;

    const row = (await needs('?all=true')).rows.find(
      (r) => r.item.code === code && r.scope === 'company',
    )!;
    expect(row).toBeDefined();
    expect(row.plannedApplied).toBe(true);
    expect(num(row.plannedCompany)).toBeCloseTo(num(expected), 6);
    expect(num(row.projected)).toBeCloseTo(num(row.available) - num(expected), 6);
  });

  it('план не размазывается по складам: разложить нечем — в расчёт не идёт', async () => {
    // Берём сырьё с живым планом и кладём его на второй склад приходом. Теперь
    // цех может выбрать план и там, и там, а склада производственный заказ не
    // называет — значит складская строка план брать не должна.
    const raw = await db.query<{ code: string; wh: string; planned: string }>(
      `SELECT i.code,
              (SELECT w.code FROM stock_balance sb JOIN warehouse w ON w.id = sb.warehouse_id
                WHERE sb.item_id = i.id AND sb.qty_on_hand > 0 LIMIT 1) AS wh,
              sum(GREATEST(pm.qty_planned - pm.qty_issued, 0))::text AS planned
         FROM production_material pm
         JOIN production_order po ON po.id = pm.production_order_id
         JOIN item i ON i.id = pm.item_id
        WHERE po.status IN ('planned', 'in_progress', 'paused') AND i.track_batches
        GROUP BY i.id, i.code
       HAVING sum(GREATEST(pm.qty_planned - pm.qty_issued, 0)) > 0
        ORDER BY 3 DESC LIMIT 1`,
    );
    expect(raw.rows[0], 'в сиде нет партионного сырья с планом').toBeDefined();
    const { code, wh, planned: plan } = raw.rows[0]!;

    // Второй склад той же компании, где этой позиции нет.
    const other = wh === 'ZAVOD-SYR' ? 'ZAVOD-GP' : 'ZAVOD-SYR';
    const receipt = await api('/api/v1/warehouse/moves', {
      method: 'POST',
      headers: { ...json(keeper.token), 'Idempotency-Key': `needs-e2e-${Date.now()}` },
      body: JSON.stringify({
        companyUid: plantUid,
        operationType: 'receipt',
        itemCode: code,
        batchNumber: `E6-NEEDS-${Date.now()}`,
        qty: '1.000000',
        toWarehouseCode: other,
        toLocationCode: 'A-01',
        unitCost: '1000.0000',
      }),
    });
    expect(receipt.status, JSON.stringify(receipt.body)).toBe(201);
    extraReceipt = receipt.body.data.uid as string;

    // Уровень на складе, где позиция лежала изначально.
    const level = await db.query<{ uid: string }>(
      `INSERT INTO item_stock_level (company_id, item_id, warehouse_id, min_qty, critical_qty, comment)
       SELECT i.company_id, i.id, w.id, 1000, 500, 'проверка Э6'
         FROM item i JOIN warehouse w ON w.code = $2
        WHERE i.code = $1
       RETURNING uid`,
      [code, wh],
    );
    tempLevel = level.rows[0]!.uid;

    const rows = (await needs('?all=true')).rows.filter((r) => r.item.code === code);
    // Компанийской строки по этой позиции больше нет — уровень перекрыл её.
    expect(rows.every((r) => r.scope === 'warehouse')).toBe(true);

    const row = rows.find((r) => r.warehouse!.code === wh)!;
    expect(row).toBeDefined();
    expect(num(row.plannedCompany)).toBeCloseTo(num(plan), 6);
    expect(row.plannedApplied).toBe(false);
    expect(num(row.plannedOut)).toBe(0);
    // Значит и дозаказ считается без плана — но план назван, и его видно.
    expect(num(row.projected)).toBeCloseTo(num(row.available), 6);
  });

  it('фильтр по складу сужает отчёт до этого склада и его компании', async () => {
    const data = await needs(`?all=true&warehouse=${sergeli.uid}`);
    expect(data.rows.length).toBeGreaterThan(0);

    for (const row of data.rows) {
      if (row.scope === 'warehouse') expect(row.warehouse!.code).toBe('SERGELI');
    }

    const companyRows = data.rows.filter((r) => r.scope === 'company');
    expect(companyRows.length).toBeGreaterThan(0);
    const codes = companyRows.map((r) => r.item.code);
    const foreign = await db.query<{ code: string }>(
      `SELECT i.code FROM item i JOIN company c ON c.id = i.company_id
        WHERE i.code = ANY ($1) AND c.uid <> $2`,
      [codes, tradeUid],
    );
    expect(foreign.rows).toEqual([]);
  });

  it('счётчики сводки и отчёт считают одно и то же', async () => {
    // На экране склада карточка «Ниже критического» стоит над вкладкой
    // потребности. Два разных числа про одно и то же человек читает как
    // поломку — и будет прав: правило должно быть одно.
    const res = await api('/api/v1/warehouse/summary?period=30d', {
      headers: auth(keeper.token),
    });
    expect(res.status).toBe(200);
    const levels = res.body.data.levels as { belowCritical: number; belowMin: number };

    const data = await needs();
    expect(levels.belowCritical).toBe(data.totals.critical);
    expect(levels.belowMin).toBe(data.totals.belowMin);
  });

  it('строка остатка сравнивается со складским уровнем и доступным', async () => {
    const res = await api('/api/v1/warehouse/stock?limit=500', { headers: auth(keeper.token) });
    expect(res.status).toBe(200);
    const rows = res.body.data.rows as {
      item: { code: string };
      warehouse: { code: string };
      levelScope: 'company' | 'warehouse';
      levelAvailable: string;
      minQty: string;
      criticalQty: string;
      isBelowMin: boolean;
      isBelowCritical: boolean;
    }[];

    const row = rows.find(
      (r) => r.item.code === HUB_ITEM_CODE && r.warehouse.code === 'SERGELI',
    )!;
    expect(row, 'в остатках нет опорной позиции на Сергели').toBeDefined();

    // Уровень у этой позиции складской: компанийский по ней выключен.
    expect(row.levelScope).toBe('warehouse');
    const level = await db.query<{ min_qty: string; critical_qty: string }>(
      `SELECT l.min_qty::text, l.critical_qty::text
         FROM item_stock_level l
         JOIN item i ON i.id = l.item_id
         JOIN warehouse w ON w.id = l.warehouse_id
        WHERE i.code = $1 AND w.code = 'SERGELI'`,
      [HUB_ITEM_CODE],
    );
    expect(num(row.minQty)).toBe(num(level.rows[0]!.min_qty));
    expect(num(row.criticalQty)).toBe(num(level.rows[0]!.critical_qty));

    // Сравнивается доступное, а не наличие: то же число, что в отчёте.
    const fromReport = (await needs('?all=true')).rows.find(
      (r) => r.item.code === HUB_ITEM_CODE && r.warehouse?.code === 'SERGELI',
    )!;
    expect(num(row.levelAvailable)).toBeCloseTo(num(fromReport.available), 6);
    expect(row.isBelowCritical).toBe(fromReport.state === 'critical');
    expect(row.isBelowMin).toBe(fromReport.state !== 'ok');
  });

  it('фильтр по состоянию оставляет только своё', async () => {
    const critical = await needs('?state=critical');
    expect(critical.rows.every((r) => r.state === 'critical')).toBe(true);
    expect(critical.total).toBe(critical.totals.critical);
  });
});
