/**
 * Инвентаризация: приложение целиком, живая база (ТЗ 5.8).
 *
 * Проверяем цикл целиком — лист, подсчёт, расхождения, утверждение — и то, ради
 * чего он затеян: после утверждения остаток на полке равен посчитанному, а
 * разница объяснена движением, у которого есть документ.
 *
 * Прибираемся за собой: лист отменяем, лишнее сторнируем. Инвентаризация трогает
 * настоящий остаток, и мусор после прогона врёт следующему.
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

/** Листы, заведённые прогоном: в конце закрываем, чтобы склад не стоял. */
const sheets: string[] = [];

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
let seller: Awaited<ReturnType<typeof login>>;
let director: Awaited<ReturnType<typeof login>>;

/** Склад и зона, по которым считаем: берём те, где есть остаток. */
let place: {
  companyUid: string;
  warehouseCode: string;
  warehouseUid: string;
  zoneCode: string;
};

async function createSheet(token: string, body: Record<string, unknown> = {}) {
  const res = await api('/api/v1/warehouse/inventory', {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify({
      companyUid: place.companyUid,
      warehouseCode: place.warehouseCode,
      zoneCode: place.zoneCode,
      ...body,
    }),
  });
  if (res.status === 201 && res.body?.data?.uid) sheets.push(res.body.data.uid);
  return res;
}

const sheet = async (uid: string, token: string) =>
  (await api(`/api/v1/warehouse/inventory/${uid}`, { headers: auth(token) })).body.data;

const count = (token: string, lineUid: string, qty: string, comment?: string) =>
  api(`/api/v1/warehouse/inventory/lines/${lineUid}/count`, {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify(comment ? { qty, comment } : { qty }),
  });

const finish = (token: string, uid: string) =>
  api(`/api/v1/warehouse/inventory/${uid}/finish`, { method: 'POST', headers: json(token) });

const approve = (token: string, uid: string) =>
  api(`/api/v1/warehouse/inventory/${uid}/approve`, { method: 'POST', headers: json(token) });

const cancel = (token: string, uid: string) =>
  api(`/api/v1/warehouse/inventory/${uid}`, { method: 'DELETE', headers: auth(token) });

/** Посчитать все строки листа ровно так, как в снимке: расхождений нет. */
async function countAll(token: string, uid: string, override?: Record<number, string>) {
  const data = await sheet(uid, token);
  for (const row of data.rows as any[]) {
    await count(token, row.uid, override?.[row.seq] ?? row.qtyExpected);
  }
  return data.rows as any[];
}

/** Наличие по ключу строки листа. */
async function onHand(warehouseCode: string, itemCode: string, batch: string | null, loc: string) {
  const r = await db.query<{ qty: string }>(
    `SELECT coalesce(sum(sb.qty_on_hand), 0)::text AS qty
       FROM stock_balance sb
       JOIN warehouse w ON w.id = sb.warehouse_id
       JOIN item i ON i.id = sb.item_id
       LEFT JOIN batch b ON b.id = sb.batch_id
       LEFT JOIN storage_location l ON l.id = sb.location_id
       LEFT JOIN warehouse_zone z ON z.id = l.zone_id
      WHERE w.code = $1 AND i.code = $2 AND b.number IS NOT DISTINCT FROM $3
        AND z.code || '/' || l.code = $4 AND sb.serial_id IS NULL`,
    [warehouseCode, itemCode, batch, loc],
  );
  return Number(r.rows[0]?.qty ?? 0);
}

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
  seller = await login('d.karimov');
  director = await login('s.radjabov');

  // Считаем ту зону, где меньше строк: прогон вносит подсчёт по каждой, и
  // лист на сотню полок превращает проверку в долгую прогулку.
  const pick = await db.query<{
    company_uid: string;
    warehouse_code: string;
    warehouse_uid: string;
    zone_code: string;
  }>(
    `SELECT c.uid AS company_uid, w.code AS warehouse_code, w.uid AS warehouse_uid,
            z.code AS zone_code, count(*) AS lines
       FROM stock_balance sb
       JOIN company c ON c.id = sb.company_id
       JOIN warehouse w ON w.id = sb.warehouse_id
       JOIN storage_location l ON l.id = sb.location_id
       JOIN warehouse_zone z ON z.id = l.zone_id
      WHERE sb.qty_on_hand > 0 AND sb.serial_id IS NULL
        -- Склад, по которому уже идёт пересчёт из сида, не берём: свой лист там
        -- не создать, и проверка упала бы не на дефекте, а на данных.
        AND NOT EXISTS (
          SELECT 1 FROM inventory_sheet s
           WHERE s.company_id = sb.company_id AND s.warehouse_id = sb.warehouse_id
             AND s.status IN ('draft', 'counting', 'review')
        )
      GROUP BY c.uid, w.code, w.uid, z.code
     HAVING count(*) BETWEEN 2 AND 12
      ORDER BY count(*)
      LIMIT 1`,
  );
  const p = pick.rows[0];
  if (!p) throw new Error('в базе нет зоны с остатком: считать нечего');
  place = {
    companyUid: p.company_uid,
    warehouseCode: p.warehouse_code,
    warehouseUid: p.warehouse_uid,
    zoneCode: p.zone_code,
  };
}, 60_000);

afterAll(async () => {
  for (const uid of sheets) {
    const row = await db.query<{ status: string }>(
      `SELECT status::text AS status FROM inventory_sheet WHERE uid = $1`,
      [uid],
    );
    if (row.rows[0] && ['draft', 'counting', 'review'].includes(row.rows[0].status)) {
      await cancel(keeper.token, uid);
    }
  }
  await app?.close();
  await db?.end();
});

describe('лист инвентаризации', () => {
  it('собирается снимком остатка по зоне: строки с наличием, учётное записано', async () => {
    const res = await createSheet(keeper.token);
    expect(res.status).toBe(201);
    expect(res.body.data.number).toMatch(/^ИНВ-\d{5}$/);
    expect(res.body.data.status).toBe('draft');
    expect(res.body.data.lines).toBeGreaterThan(0);

    const data = await sheet(res.body.data.uid, keeper.token);
    for (const row of data.rows as any[]) {
      expect(Number(row.qtyExpected)).toBeGreaterThan(0);
      expect(row.qtyCounted).toBeNull();
      expect(row.location).toMatch(new RegExp(`^${place.zoneCode}/`));
    }

    // Снимок сходится с остатком на момент создания.
    const first = (data.rows as any[])[0];
    expect(await onHand(place.warehouseCode, first.item.code, first.batch, first.location)).toBeCloseTo(
      Number(first.qtyExpected),
      6,
    );

    expect((await cancel(keeper.token, res.body.data.uid)).status).toBe(200);
  });

  it('второй открытый лист по тому же складу не заводится', async () => {
    const one = await createSheet(keeper.token);
    expect(one.status).toBe(201);

    const two = await createSheet(keeper.token);
    expect(two.status).toBe(422);
    expect(String(two.body.error.message)).toContain('уже идёт пересчёт');

    expect((await cancel(keeper.token, one.body.data.uid)).status).toBe(200);
  });

  it('продавцу лист не создать: нет права warehouse.inventory', async () => {
    const res = await createSheet(seller.token);
    expect(res.status).toBe(403);
    expect(String(res.body.error.message)).toContain('warehouse.inventory');
  });

  it('без токена список не отдаётся', async () => {
    expect((await api('/api/v1/warehouse/inventory')).status).toBe(401);
  });
});

describe('подсчёт', () => {
  it('первая посчитанная строка переводит лист в «считают», расхождение считает база', async () => {
    const made = await createSheet(keeper.token);
    const uid = made.body.data.uid;
    const rows = await sheet(uid, keeper.token);
    const line = (rows.rows as any[])[0];

    const plus = (Number(line.qtyExpected) + 2).toFixed(6);
    const res = await count(keeper.token, line.uid, plus, 'нашли лишнее');
    expect(res.status).toBe(201);
    expect(Number(res.body.data.qtyDiff)).toBeCloseTo(2, 6);
    expect(res.body.data.countedBy).toBeTruthy();

    const after = await sheet(uid, keeper.token);
    expect(after.status).toBe('counting');
    expect(after.counted).toBe(1);
    expect(after.diffLines).toBe(1);

    expect((await cancel(keeper.token, uid)).status).toBe(200);
  });

  it('непосчитанные строки не пускают лист на утверждение', async () => {
    const made = await createSheet(keeper.token);
    const uid = made.body.data.uid;
    const rows = await sheet(uid, keeper.token);
    await count(keeper.token, (rows.rows as any[])[0].uid, (rows.rows as any[])[0].qtyExpected);

    const res = await finish(keeper.token, uid);
    expect(res.status).toBe(422);
    expect(String(res.body.error.message)).toContain('Не посчитано строк');

    expect((await cancel(keeper.token, uid)).status).toBe(200);
  });

  it('минус не принимает, ноль принимает', async () => {
    const made = await createSheet(keeper.token);
    const uid = made.body.data.uid;
    const line = (await sheet(uid, keeper.token)).rows[0];

    expect((await count(keeper.token, line.uid, '-1')).status).toBe(400);

    const zero = await count(keeper.token, line.uid, '0');
    expect(zero.status).toBe(201);
    expect(Number(zero.body.data.qtyDiff)).toBeCloseTo(-Number(line.qtyExpected), 6);

    expect((await cancel(keeper.token, uid)).status).toBe(200);
  });
});

describe('утверждение', () => {
  it('расхождения становятся движениями, остаток сходится с посчитанным', async () => {
    const made = await createSheet(keeper.token);
    const uid = made.body.data.uid;
    const rows = await sheet(uid, keeper.token);
    const surplusLine = (rows.rows as any[])[0];
    const shortLine = (rows.rows as any[])[1];

    // Одну строку считаем с излишком, другую — с недостачей: утверждение
    // должно написать по движению в каждую сторону.
    await countAll(keeper.token, uid, {
      [surplusLine.seq]: (Number(surplusLine.qtyExpected) + 3).toFixed(6),
      [shortLine.seq]: (Number(shortLine.qtyExpected) - 1).toFixed(6),
    });
    expect((await finish(keeper.token, uid)).status).toBe(201);

    const res = await approve(director.token, uid);
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('approved');
    expect(res.body.data.approvedBy).toBeTruthy();

    expect(
      await onHand(place.warehouseCode, surplusLine.item.code, surplusLine.batch, surplusLine.location),
    ).toBeCloseTo(Number(surplusLine.qtyExpected) + 3, 6);
    expect(
      await onHand(place.warehouseCode, shortLine.item.code, shortLine.batch, shortLine.location),
    ).toBeCloseTo(Number(shortLine.qtyExpected) - 1, 6);

    const moves = await db.query<{ operation_type: string; qty: string; source_doc_type: string }>(
      `SELECT m.operation_type::text, m.qty::text, m.source_doc_type
         FROM stock_move m
         JOIN inventory_sheet s ON s.id = m.source_doc_id AND m.source_doc_type = 'inventory_sheet'
        WHERE s.uid = $1
        ORDER BY m.id`,
      [uid],
    );
    expect(moves.rows.map((m) => m.operation_type).sort()).toEqual(['surplus', 'write_off']);

    // Журнал действий (ТЗ 3.4): весь путь листа — заведён, посчитан, закрыт,
    // утверждён. Пересчёт двигает остаток и деньги, и «кто это утвердил»
    // должно оставаться в журнале, который нельзя ни исправить, ни удалить.
    const log = await db.query<{ action: string; changes: any }>(
      `SELECT action, changes FROM audit_log
        WHERE entity_type = 'inventory_sheet' AND entity_id = $1 ORDER BY id`,
      [uid],
    );
    const actions = log.rows.map((r) => r.action);
    for (const need of ['create', 'count', 'finish', 'approve']) {
      expect(actions, `журнал листа: ${need}`).toContain(need);
    }
    const approved = log.rows.find((r) => r.action === 'approve')!;
    expect(approved.changes.status).toEqual({ from: 'review', to: 'approved' });
    expect(Number(approved.changes.diffLines.to)).toBe(2);

    // Прибираемся тем же способом, каким склад живёт: движениями, а не правкой
    // остатка. Ручной UPDATE вернул бы числа, но рассорил бы остаток с журналом —
    // ровно то, от чего в этом проекте уходили.
    const reason = await db.query<{ id: string }>(
      `SELECT r.id::text FROM stock_reason r JOIN company c ON c.id = r.company_id
        WHERE c.uid = $1 AND r.kind::text = 'write_off' ORDER BY r.id LIMIT 1`,
      [place.companyUid],
    );
    const writeOffReason = reason.rows[0]!.id;

    const tidy = async (body: Record<string, unknown>) => {
      const res = await api('/api/v1/warehouse/moves', {
        method: 'POST',
        headers: json(keeper.token),
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(201);
    };
    await tidy({
      companyUid: place.companyUid,
      operationType: 'write_off',
      itemCode: surplusLine.item.code,
      batchNumber: surplusLine.batch ?? undefined,
      qty: '3',
      fromWarehouseCode: place.warehouseCode,
      fromLocationCode: surplusLine.location,
      reasonId: writeOffReason,
      comment: 'уборка после проверки инвентаризации',
    });
    await tidy({
      companyUid: place.companyUid,
      operationType: 'receipt',
      itemCode: shortLine.item.code,
      batchNumber: shortLine.batch ?? undefined,
      qty: '1',
      toWarehouseCode: place.warehouseCode,
      toLocationCode: shortLine.location,
      unitCost: shortLine.unitCost,
      comment: 'уборка после проверки инвентаризации',
    });
  });

  it('кладовщику утверждать нельзя: нужно отдельное право', async () => {
    const made = await createSheet(keeper.token);
    const uid = made.body.data.uid;
    await countAll(keeper.token, uid);
    expect((await finish(keeper.token, uid)).status).toBe(201);

    const res = await approve(keeper.token, uid);
    expect(res.status).toBe(403);
    expect(String(res.body.error.message)).toContain('warehouse.inventory.approve');

    expect((await cancel(keeper.token, uid)).status).toBe(200);
  });

  it('утверждённый лист второй раз не утверждается и не пересчитывается', async () => {
    const made = await createSheet(keeper.token);
    const uid = made.body.data.uid;
    const rows = await countAll(keeper.token, uid);
    expect((await finish(keeper.token, uid)).status).toBe(201);
    expect((await approve(director.token, uid)).status).toBe(201);

    const again = await approve(director.token, uid);
    expect(again.status).toBe(422);
    expect(String(again.body.error.message)).toContain('уже утверждён');

    const back = await count(keeper.token, rows[0]!.uid, '1');
    expect(back.status).toBe(422);
    expect(String(back.body.error.message)).toContain('утверждён');
  });

  it('лист без расхождений движений не пишет', async () => {
    const made = await createSheet(keeper.token);
    const uid = made.body.data.uid;
    await countAll(keeper.token, uid);
    expect((await finish(keeper.token, uid)).status).toBe(201);
    expect((await approve(director.token, uid)).status).toBe(201);

    const moves = await db.query(
      `SELECT 1 FROM stock_move m JOIN inventory_sheet s ON s.id = m.source_doc_id
        WHERE m.source_doc_type = 'inventory_sheet' AND s.uid = $1`,
      [uid],
    );
    expect(moves.rows).toEqual([]);
  });
});

describe('операции во время пересчёта', () => {
  const receipt = (extra: Record<string, unknown> = {}) => ({
    companyUid: place.companyUid,
    operationType: 'receipt',
    qty: '1',
    toWarehouseCode: place.warehouseCode,
    unitCost: '1000',
    ...extra,
  });

  const move = (token: string, body: Record<string, unknown>) =>
    api('/api/v1/warehouse/moves', { method: 'POST', headers: json(token), body: JSON.stringify(body) });

  it('режим «запрещать» закрывает операции по зоне и называет лист', async () => {
    const made = await createSheet(keeper.token, { blockMode: 'block' });
    const uid = made.body.data.uid;
    const line = (await sheet(uid, keeper.token)).rows[0];

    const res = await move(
      keeper.token,
      receipt({
        itemCode: line.item.code,
        batchNumber: line.batch ?? undefined,
        toLocationCode: line.location,
      }),
    );
    expect(res.status).toBe(422);
    expect(String(res.body.error.message)).toContain(made.body.data.number);

    expect((await cancel(keeper.token, uid)).status).toBe(200);
  });

  it('режим «помечать» операции пропускает и ставит пометку в журнале', async () => {
    const made = await createSheet(keeper.token, { blockMode: 'mark' });
    const uid = made.body.data.uid;
    const line = (await sheet(uid, keeper.token)).rows[0];

    const res = await move(
      keeper.token,
      receipt({
        itemCode: line.item.code,
        batchNumber: line.batch ?? undefined,
        toLocationCode: line.location,
      }),
    );
    expect(res.status).toBe(201);

    const mark = await db.query<{ during: boolean }>(
      `SELECT during_inventory AS during FROM stock_move WHERE uid = $1`,
      [res.body.data.uid],
    );
    expect(mark.rows[0]!.during).toBe(true);

    // Прибираемся: приход отменяем, лист закрываем.
    const back = await api(`/api/v1/warehouse/moves/${res.body.data.uid}/reverse`, {
      method: 'POST',
      headers: json(keeper.token),
      body: JSON.stringify({ comment: 'уборка после проверки пересчёта' }),
    });
    expect(back.status).toBe(201);
    expect((await cancel(keeper.token, uid)).status).toBe(200);
  });

  it('соседняя зона того же склада работает как обычно', async () => {
    const other = await db.query<{ item: string; batch: string | null; loc: string }>(
      `SELECT i.code AS item, b.number AS batch, z.code || '/' || l.code AS loc
         FROM stock_balance sb
         JOIN warehouse w ON w.id = sb.warehouse_id
         JOIN item i ON i.id = sb.item_id
         LEFT JOIN batch b ON b.id = sb.batch_id
         JOIN storage_location l ON l.id = sb.location_id
         JOIN warehouse_zone z ON z.id = l.zone_id
        WHERE w.code = $1 AND z.code <> $2 AND sb.qty_on_hand > 0
        ORDER BY sb.qty_on_hand DESC LIMIT 1`,
      [place.warehouseCode, place.zoneCode],
    );
    const o = other.rows[0];
    if (!o) throw new Error('на складе одна зона: проверять соседнюю нечем');

    const made = await createSheet(keeper.token, { blockMode: 'block' });
    const res = await move(
      keeper.token,
      receipt({ itemCode: o.item, batchNumber: o.batch ?? undefined, toLocationCode: o.loc }),
    );
    expect(res.status).toBe(201);

    const back = await api(`/api/v1/warehouse/moves/${res.body.data.uid}/reverse`, {
      method: 'POST',
      headers: json(keeper.token),
      body: JSON.stringify({ comment: 'уборка после проверки соседней зоны' }),
    });
    expect(back.status).toBe(201);
    expect((await cancel(keeper.token, made.body.data.uid)).status).toBe(200);
  });
});
