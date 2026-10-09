/**
 * Приход, списание, перемещение и отмена движения: приложение целиком, живая база.
 *
 * Главное здесь — остаток. Журнал движений и `stock_balance` обязаны сходиться
 * после каждой операции, и именно это ловит `warehouse-stock.spec.ts` свёрткой
 * снаружи. Здесь проверяется другое: что движение вообще происходит, что оно
 * происходит ровно на ту величину, и что запреты — нехватка товара, списание
 * без причины, чужая компания, отсутствие права — срабатывают до записи, а не
 * после.
 *
 * Прибираемся сторнированием, а не удалением, и это не выбор стиля. На
 * `stock_move` стоит триггер `stock_move_append_only`: UPDATE и DELETE по
 * журналу запрещены на уровне базы для всех, включая владельца. Поэтому каждый
 * прогон оставляет в журнале пары «движение + его отмена», которые в сумме дают
 * ноль, и один раз заводит партию под номером прогона. Остатки при этом
 * возвращаются к исходным до шестого знака — это тест и проверяет в конце.
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

/** Движения, заведённые тестом: каждое отменяем в конце. */
const created: string[] = [];
/** Те, что тест отменил сам по ходу проверки: второй раз отменять нечем. */
const reversed = new Set<string>();

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
  return res.body.data as { token: string; permissions: string[]; companies: { uid: string }[] };
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const json = (token: string) => ({ ...auth(token), 'Content-Type': 'application/json' });

/** Кладовщик: приход, списание, перемещение. Продавец: только просмотр склада. */
let keeper: Awaited<ReturnType<typeof login>>;
let seller: Awaited<ReturnType<typeof login>>;

/** Компания и позиция с живым остатком: с неё и списываем, её и перемещаем. */
let company: { uid: string; code: string };
let item: { code: string; batch: string };
let fromWarehouse: string;
let toWarehouse: string;
/** Ячейки: та, где товар лежит, соседняя на том же складе и одна на втором. */
let fromCell: string;
let nextCell: string;
let toCell: string;
let startQty: number;

/** Номер партии, которой нет: приход обязан завести её сам. */
const freshBatch = `ПРОВЕРКА-${Date.now().toString(36).toUpperCase()}`;

/**
 * Остаток по строке «склад + номенклатура + партия», сложенный по всем ячейкам.
 *
 * Склад целиком, а не одна полка: перекладка между ячейками его не меняет, и
 * проверки прихода, списания и перемещения между складами читаются так же, как
 * до ячеек. Где именно лежит товар, проверяет `cellBalance`.
 */
async function balance(warehouseCode: string, itemCode: string, batchNumber: string | null) {
  const r = await db.query<{ qty: string }>(
    `SELECT coalesce(sum(sb.qty_on_hand), 0)::text AS qty
       FROM warehouse w
       JOIN company c ON c.id = w.company_id
       JOIN item i ON i.company_id = c.id AND i.code = $3
       LEFT JOIN batch b ON b.company_id = c.id AND b.item_id = i.id AND b.number = $4
       LEFT JOIN stock_balance sb
         ON sb.company_id = c.id AND sb.warehouse_id = w.id AND sb.item_id = i.id
        AND sb.batch_id IS NOT DISTINCT FROM b.id
        AND sb.serial_id IS NULL
      WHERE c.uid = $1 AND w.code = $2`,
    [company.uid, warehouseCode, itemCode, batchNumber],
  );
  return Number(r.rows[0]?.qty ?? 0);
}

/** Остаток одной ячейки: `ЗОНА/ЯЧЕЙКА` на указанном складе. */
async function cellBalance(warehouseCode: string, cell: string, itemCode: string, batch: string) {
  const r = await db.query<{ qty: string }>(
    `SELECT coalesce(sum(sb.qty_on_hand), 0)::text AS qty
       FROM stock_balance sb
       JOIN company c ON c.id = sb.company_id
       JOIN warehouse w ON w.id = sb.warehouse_id
       JOIN item i ON i.id = sb.item_id
       JOIN batch b ON b.id = sb.batch_id
       JOIN storage_location l ON l.id = sb.location_id
       JOIN warehouse_zone z ON z.id = l.zone_id
      WHERE c.uid = $1 AND w.code = $2 AND z.code || '/' || l.code = $3
        AND i.code = $4 AND b.number = $5`,
    [company.uid, warehouseCode, cell, itemCode, batch],
  );
  return Number(r.rows[0]?.qty ?? 0);
}

/** Ячейки склада по порядку, как их видит форма. */
async function cellsOf(warehouseCode: string): Promise<string[]> {
  const r = await db.query<{ cell: string }>(
    `SELECT z.code || '/' || l.code AS cell
       FROM storage_location l
       JOIN warehouse_zone z ON z.id = l.zone_id
       JOIN warehouse w ON w.id = z.warehouse_id
       JOIN company c ON c.id = w.company_id
      WHERE c.uid = $1 AND w.code = $2 AND l.is_active
      ORDER BY z.code, l.code`,
    [company.uid, warehouseCode],
  );
  return r.rows.map((x) => x.cell);
}

/** Движение по uid: то, что легло в журнал. */
const move = async (uid: string) =>
  (
    await db.query<{
      operation_type: string;
      qty: string;
      cost_total: string;
      from_code: string | null;
      to_code: string | null;
      reason_id: string | null;
      reversal_of: string | null;
      created_by: string | null;
      comment: string | null;
    }>(
      `SELECT m.operation_type::text, m.qty::text, m.cost_total::text,
              fw.code AS from_code, tw.code AS to_code, m.reason_id::text,
              r.uid AS reversal_of, m.created_by::text, m.comment
         FROM stock_move m
         LEFT JOIN warehouse fw ON fw.id = m.from_warehouse_id
         LEFT JOIN warehouse tw ON tw.id = m.to_warehouse_id
         LEFT JOIN stock_move r ON r.id = m.reversal_of_id
        WHERE m.uid = $1`,
      [uid],
    )
  ).rows[0];

async function post(token: string, body: Record<string, unknown>, key?: string) {
  const res = await api('/api/v1/warehouse/moves', {
    method: 'POST',
    headers: { ...json(token), ...(key ? { 'Idempotency-Key': key } : {}) },
    body: JSON.stringify(body),
  });
  const uid = res.body?.data?.uid;
  if (res.status === 201 && uid && !created.includes(uid)) created.push(uid);
  return res;
}

async function reverse(token: string, uid: string, comment?: string) {
  const res = await api(`/api/v1/warehouse/moves/${uid}/reverse`, {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify(comment ? { comment } : {}),
  });
  if (res.status === 201) {
    reversed.add(uid);
    const made = res.body?.data?.uid;
    if (made && !created.includes(made)) created.push(made);
  }
  return res;
}

/** Приход на склад получения: тело, от которого пляшут остальные проверки. */
const receipt = (extra: Record<string, unknown> = {}) => ({
  companyUid: company.uid,
  operationType: 'receipt',
  itemCode: item.code,
  batchNumber: item.batch,
  qty: '5',
  toWarehouseCode: fromWarehouse,
  toLocationCode: fromCell,
  unitCost: '1200.50',
  ...extra,
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
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();

  db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  keeper = await login('a.saidov');
  seller = await login('d.karimov');

  // Позицию берём не наугад: нужна строка с живым остатком, иначе списание и
  // перемещение упрутся в «недостаточно товара» и проверят не то, что нужно.
  const row = await db.query<{
    company_uid: string;
    company_code: string;
    warehouse_code: string;
    item_code: string;
    batch_number: string;
    qty: string;
    cell: string;
  }>(
    `SELECT c.uid AS company_uid, c.code AS company_code, w.code AS warehouse_code,
            i.code AS item_code, b.number AS batch_number, sb.qty_on_hand::text AS qty,
            z.code || '/' || l.code AS cell
       FROM stock_balance sb
       JOIN company c ON c.id = sb.company_id
       JOIN warehouse w ON w.id = sb.warehouse_id
       JOIN item i ON i.id = sb.item_id
       JOIN batch b ON b.id = sb.batch_id
       JOIN storage_location l ON l.id = sb.location_id
       JOIN warehouse_zone z ON z.id = l.zone_id
      WHERE sb.serial_id IS NULL AND sb.qty_on_hand > 20
      ORDER BY sb.qty_on_hand DESC
      LIMIT 1`,
  );
  const r = row.rows[0];
  if (!r) throw new Error('в базе нет позиции с остатком в ячейке: проверять нечего');

  company = { uid: r.company_uid, code: r.company_code };
  item = { code: r.item_code, batch: r.batch_number };
  fromWarehouse = r.warehouse_code;
  fromCell = r.cell;

  const cells = await cellsOf(fromWarehouse);
  const next = cells.find((c) => c !== fromCell);
  if (!next) throw new Error('на складе одна ячейка: перекладку проверить нечем');
  nextCell = next;

  const other = await db.query<{ code: string }>(
    `SELECT w.code FROM warehouse w JOIN company c ON c.id = w.company_id
      WHERE c.uid = $1 AND w.is_active AND w.code <> $2 ORDER BY w.code LIMIT 1`,
    [company.uid, fromWarehouse],
  );
  if (!other.rows[0]) throw new Error('в компании один склад: перемещение проверить нечем');
  toWarehouse = other.rows[0].code;
  toCell = (await cellsOf(toWarehouse))[0]!;

  startQty = await balance(fromWarehouse, item.code, item.batch);
}, 60_000);

afterAll(async () => {
  // Отменяем в обратном порядке: перемещение, заведённое последним, могло
  // увезти товар, который нужен предыдущей отмене.
  for (const uid of [...created].reverse()) {
    if (reversed.has(uid)) continue;
    const m = await move(uid);
    if (!m || m.reversal_of !== null) continue;
    await reverse(keeper.token, uid, 'уборка после прогона');
  }
  await app?.close();
  await db?.end();
});

describe('GET /warehouse/refs', () => {
  it('отдаёт справочники формы: склады, номенклатуру, причины, поставщиков', async () => {
    const res = await api('/api/v1/warehouse/refs', { headers: auth(keeper.token) });

    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.warehouses.length).toBeGreaterThan(0);
    expect(d.items.length).toBeGreaterThan(0);
    expect(d.reasons.length).toBeGreaterThan(0);
    // Единица нужна форме, чтобы подписать поле количества, а признак партий —
    // чтобы спросить номер партии только там, где он обязателен.
    expect(d.items[0]).toHaveProperty('unit');
    expect(d.items[0]).toHaveProperty('trackBatches');
  });

  /**
   * Тот же разрыв, что нашли на финансах: у кладовщика две компании, склады и
   * номенклатура в них называются одинаково, а отказ за выбор чужой строки
   * прилетает только на сохранении. Признак компании у каждой строки — то, чем
   * форма сужает список до своей книги.
   */
  it('каждая строка помечена своей компанией', async () => {
    const res = await api('/api/v1/warehouse/refs', { headers: auth(keeper.token) });
    const mine = new Set(keeper.companies.map((c) => c.uid));
    expect(mine.size, 'проверка имеет смысл только на двух компаниях').toBeGreaterThan(1);

    for (const key of ['warehouses', 'items', 'reasons', 'partners'] as const) {
      const rows = res.body.data[key] as { companyUid: string }[];
      expect(rows.length, key).toBeGreaterThan(0);
      for (const row of rows) expect(mine.has(row.companyUid), `${key}: ${row.companyUid}`).toBe(true);
    }
  });

  /**
   * Возврат от клиента спрашивает клиента, приход — поставщика. Пока справочник
   * отдавал только поставщиков, форма возврата предлагала выбрать из тех, кому
   * ничего не продавали: любой выбор был неверным, а отказа не было — движение
   * записывалось на чужого контрагента.
   */
  it('в контрагентах есть и поставщики, и клиенты, и каждый помечен', async () => {
    const res = await api('/api/v1/warehouse/refs', { headers: auth(keeper.token) });
    const partners = res.body.data.partners as {
      uid: string;
      isSupplier: boolean;
      isClient: boolean;
    }[];
    expect(partners.length).toBeGreaterThan(0);
    expect(partners.some((p) => p.isSupplier)).toBe(true);
    expect(partners.some((p) => p.isClient)).toBe(true);
    for (const p of partners) expect(p.isSupplier || p.isClient).toBe(true);
  });

  /** Простой линии — причина остановки станка, а не списания товара. */
  it('в причинах нет простоя: им списывать нечего', async () => {
    const res = await api('/api/v1/warehouse/refs', { headers: auth(keeper.token) });
    const kinds = new Set((res.body.data.reasons as { kind: string }[]).map((r) => r.kind));
    expect(kinds.has('downtime')).toBe(false);
    expect(kinds.has('write_off')).toBe(true);
  });
});

describe('приход', () => {
  it('увеличивает остаток ровно на количество и пишет строку в журнал', async () => {
    const before = await balance(fromWarehouse, item.code, item.batch);

    const res = await post(keeper.token, receipt({ qty: '7', comment: 'проверка прихода' }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.operationType).toBe('receipt');

    const after = await balance(fromWarehouse, item.code, item.batch);
    expect(after - before).toBeCloseTo(7, 6);

    const m = await move(res.body.data.uid);
    expect(m.to_code).toBe(fromWarehouse);
    expect(m.from_code).toBeNull();
    // Автор движения — не украшение: без него в журнале некого спросить.
    expect(m.created_by).not.toBeNull();
    expect(m.comment).toBe('проверка прихода');
    // Себестоимость строки — цена за единицу на количество, а не цена.
    expect(Number(m.cost_total)).toBeCloseTo(7 * 1200.5, 4);
  });

  it('повтор с тем же ключом идемпотентности не заводит второе движение', async () => {
    const key = `wh-test-${Date.now()}`;
    const before = await balance(fromWarehouse, item.code, item.batch);

    const first = await post(keeper.token, receipt({ qty: '3' }), key);
    const second = await post(keeper.token, receipt({ qty: '3' }), key);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.data.uid).toBe(first.body.data.uid);

    const after = await balance(fromWarehouse, item.code, item.batch);
    expect(after - before, 'остаток вырос дважды: ключ не сработал').toBeCloseTo(3, 6);
  });

  it('заводит неизвестную партию, и она встаёт на склад получения', async () => {
    const res = await post(keeper.token, receipt({ qty: '4', batchNumber: freshBatch }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const rows = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM batch b
         JOIN company c ON c.id = b.company_id
        WHERE c.uid = $1 AND b.number = $2`,
      [company.uid, freshBatch],
    );
    expect(rows.rows[0].n).toBe(1);
    expect(await balance(fromWarehouse, item.code, freshBatch)).toBeCloseTo(4, 6);
  });

  it('не принимает склад отправления: у прихода его нет', async () => {
    const res = await post(keeper.token, receipt({ fromWarehouseCode: toWarehouse }));
    expect(res.status).toBe(422);
    expect(String(res.body.error.message)).toContain('склад отправления не указывается');
  });

  it('не принимает причину: она бывает только у списания', async () => {
    const res = await post(keeper.token, receipt({ reasonId: '1' }));
    expect(res.status).toBe(422);
  });
});

describe('списание', () => {
  it('уменьшает остаток и требует причину', async () => {
    const before = await balance(fromWarehouse, item.code, item.batch);

    const noReason = await post(keeper.token, {
      companyUid: company.uid,
      operationType: 'write_off',
      itemCode: item.code,
      batchNumber: item.batch,
      qty: '2',
      fromWarehouseCode: fromWarehouse,
      fromLocationCode: fromCell,
    });
    expect(noReason.status).toBe(422);
    expect(await balance(fromWarehouse, item.code, item.batch)).toBeCloseTo(before, 6);

    const reason = await db.query<{ id: string }>(
      `SELECT r.id::text FROM stock_reason r JOIN company c ON c.id = r.company_id
        WHERE c.uid = $1 AND r.kind::text = 'write_off' ORDER BY r.id LIMIT 1`,
      [company.uid],
    );

    const ok = await post(keeper.token, {
      companyUid: company.uid,
      operationType: 'write_off',
      itemCode: item.code,
      batchNumber: item.batch,
      qty: '2',
      fromWarehouseCode: fromWarehouse,
      fromLocationCode: fromCell,
      reasonId: reason.rows[0].id,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);

    const after = await balance(fromWarehouse, item.code, item.batch);
    expect(before - after).toBeCloseTo(2, 6);

    const m = await move(ok.body.data.uid);
    expect(m.from_code).toBe(fromWarehouse);
    expect(m.to_code).toBeNull();
    expect(m.reason_id).toBe(reason.rows[0].id);
  });

  /**
   * Нехватку ловим до записи и называем числа. На `stock_balance` стоит CHECK,
   * то есть в минус база не пустит и сама, — но там это будет 500 на обычную
   * ошибку человека, без подсказки, сколько же товара есть.
   */
  it('не списывает больше, чем есть, и не трогает остаток', async () => {
    const before = await balance(fromWarehouse, item.code, item.batch);
    const reason = await db.query<{ id: string }>(
      `SELECT r.id::text FROM stock_reason r JOIN company c ON c.id = r.company_id
        WHERE c.uid = $1 AND r.kind::text = 'write_off' ORDER BY r.id LIMIT 1`,
      [company.uid],
    );

    const res = await post(keeper.token, {
      companyUid: company.uid,
      operationType: 'write_off',
      itemCode: item.code,
      batchNumber: item.batch,
      qty: String(before + 1000),
      fromWarehouseCode: fromWarehouse,
      fromLocationCode: fromCell,
      reasonId: reason.rows[0].id,
    });

    expect(res.status).toBe(422);
    expect(String(res.body.error.message)).toContain('Недостаточно');
    expect(await balance(fromWarehouse, item.code, item.batch)).toBeCloseTo(before, 6);
  });

  /**
   * Резерв — самая обидная причина отказа: товар на складе лежит, а списать его
   * нельзя, он обещан заказу. Молчащий об этом отказ читается как поломка, и
   * человек идёт искать несуществующую ошибку.
   */
  it('называет резерв, когда лежит больше, чем доступно', async () => {
    const held = await db.query<{
      warehouse_code: string;
      item_code: string;
      batch_number: string;
      on_hand: string;
      reserved: string;
      reason_id: string;
      cell: string;
    }>(
      `SELECT w.code AS warehouse_code, i.code AS item_code, b.number AS batch_number,
              sb.qty_on_hand::text AS on_hand, sb.qty_reserved::text AS reserved,
              z.code || '/' || l.code AS cell,
              (SELECT r.id::text FROM stock_reason r
                WHERE r.company_id = sb.company_id AND r.kind::text = 'write_off'
                ORDER BY r.id LIMIT 1) AS reason_id
         FROM stock_balance sb
         JOIN company c ON c.id = sb.company_id
         JOIN warehouse w ON w.id = sb.warehouse_id
         JOIN item i ON i.id = sb.item_id
         JOIN batch b ON b.id = sb.batch_id
         JOIN storage_location l ON l.id = sb.location_id
         JOIN warehouse_zone z ON z.id = l.zone_id
        WHERE c.uid = $1 AND sb.serial_id IS NULL
          AND sb.qty_reserved > 0 AND sb.qty_available < sb.qty_on_hand
        ORDER BY sb.qty_reserved DESC
        LIMIT 1`,
      [company.uid],
    );
    // Резерв в сиде есть, но он не обязан лежать именно у этой компании. Нет
    // строки — проверять нечего, и молчаливый зелёный честнее выдуманной.
    if (held.rowCount === 0) return;
    const row = held.rows[0];

    const res = await post(keeper.token, {
      companyUid: company.uid,
      operationType: 'write_off',
      itemCode: row.item_code,
      batchNumber: row.batch_number,
      qty: row.on_hand,
      fromWarehouseCode: row.warehouse_code,
      fromLocationCode: row.cell,
      reasonId: row.reason_id,
    });

    expect(res.status).toBe(422);
    const message = String(res.body.error.message);
    expect(message).toContain('Недостаточно');
    expect(message).toContain('в резерве');
    expect(message).toContain(String(Number(row.reserved)));
  });

  it('не списывает из партии, которой не было', async () => {
    const reason = await db.query<{ id: string }>(
      `SELECT r.id::text FROM stock_reason r JOIN company c ON c.id = r.company_id
        WHERE c.uid = $1 AND r.kind::text = 'write_off' ORDER BY r.id LIMIT 1`,
      [company.uid],
    );
    const res = await post(keeper.token, {
      companyUid: company.uid,
      operationType: 'write_off',
      itemCode: item.code,
      batchNumber: 'ПАРТИЯ-КОТОРОЙ-НЕТ',
      qty: '1',
      fromWarehouseCode: fromWarehouse,
      fromLocationCode: fromCell,
      reasonId: reason.rows[0].id,
    });
    expect(res.status).toBe(422);
    expect(String(res.body.error.message)).toContain('не найдена');
  });
});

describe('перемещение', () => {
  it('переносит товар между складами, не меняя общий остаток компании', async () => {
    const fromBefore = await balance(fromWarehouse, item.code, item.batch);
    const toBefore = await balance(toWarehouse, item.code, item.batch);

    const res = await post(keeper.token, {
      companyUid: company.uid,
      operationType: 'transfer',
      itemCode: item.code,
      batchNumber: item.batch,
      qty: '6',
      fromWarehouseCode: fromWarehouse,
      fromLocationCode: fromCell,
      toWarehouseCode: toWarehouse,
      toLocationCode: toCell,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const fromAfter = await balance(fromWarehouse, item.code, item.batch);
    const toAfter = await balance(toWarehouse, item.code, item.batch);

    expect(fromBefore - fromAfter).toBeCloseTo(6, 6);
    expect(toAfter - toBefore).toBeCloseTo(6, 6);
    // Ради этой строки перемещение и отделено от пары «списание + приход»:
    // товар компании не прибавилось и не убавилось.
    expect(fromAfter + toAfter).toBeCloseTo(fromBefore + toBefore, 6);
  });

  it('не переносит из ячейки в неё же', async () => {
    const res = await post(keeper.token, {
      companyUid: company.uid,
      operationType: 'transfer',
      itemCode: item.code,
      batchNumber: item.batch,
      qty: '1',
      fromWarehouseCode: fromWarehouse,
      fromLocationCode: fromCell,
      toWarehouseCode: fromWarehouse,
      toLocationCode: fromCell,
    });
    expect(res.status).toBe(422);
    expect(String(res.body.error.message)).toContain('различаться');
  });

  /**
   * Перекладка внутри склада — обычная работа кладовщика: товар переставили с
   * открытой площадки под навес. Склад при этом один и тот же, и до ячеек такое
   * движение сервер отбивал как «склады должны различаться».
   */
  it('перекладывает между ячейками одного склада, не меняя остаток склада', async () => {
    const before = await balance(fromWarehouse, item.code, item.batch);
    const fromCellBefore = await cellBalance(fromWarehouse, fromCell, item.code, item.batch);
    const nextCellBefore = await cellBalance(fromWarehouse, nextCell, item.code, item.batch);

    const res = await post(keeper.token, {
      companyUid: company.uid,
      operationType: 'transfer',
      itemCode: item.code,
      batchNumber: item.batch,
      qty: '3',
      fromWarehouseCode: fromWarehouse,
      fromLocationCode: fromCell,
      toWarehouseCode: fromWarehouse,
      toLocationCode: nextCell,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    expect(await balance(fromWarehouse, item.code, item.batch)).toBeCloseTo(before, 6);
    expect(fromCellBefore - (await cellBalance(fromWarehouse, fromCell, item.code, item.batch)))
      .toBeCloseTo(3, 6);
    expect((await cellBalance(fromWarehouse, nextCell, item.code, item.batch)) - nextCellBefore)
      .toBeCloseTo(3, 6);

    const m = await move(res.body.data.uid);
    expect(m.from_code).toBe(fromWarehouse);
    expect(m.to_code).toBe(fromWarehouse);
  });

  it('не принимает движение без ячейки, когда у склада ячейки есть', async () => {
    const res = await post(keeper.token, {
      companyUid: company.uid,
      operationType: 'receipt',
      itemCode: item.code,
      batchNumber: item.batch,
      qty: '1',
      toWarehouseCode: fromWarehouse,
      unitCost: '100',
    });
    expect(res.status).toBe(422);
    expect(String(res.body.error.message)).toContain('Укажите ячейку');
  });

  it('не принимает ячейку чужого склада', async () => {
    const res = await post(keeper.token, receipt({ toLocationCode: 'НЕТ-ТАКОЙ' }));
    expect(res.status).toBe(422);
    expect(String(res.body.error.message)).toContain('не найдена');
  });
});

/**
 * Операции, которые делает кладовщик, но не приход и не списание: выдача
 * в цех, возврат из цеха, возврат от клиента, оприходование излишков.
 *
 * Отгрузки здесь нет сознательно. Она списывает по продаже, и её делает ТТН
 * из заказа: движение, заведённое со склада мимо заказа, увезло бы товар,
 * о котором продажи не знают, и заказ остался бы «не отгружен» при пустом
 * складе.
 */
describe('операции производства и корректировки', () => {
  it('выдаёт в производство со склада и уменьшает остаток ячейки', async () => {
    const before = await cellBalance(fromWarehouse, fromCell, item.code, item.batch);

    const res = await post(keeper.token, {
      companyUid: company.uid,
      operationType: 'issue_to_production',
      itemCode: item.code,
      batchNumber: item.batch,
      qty: '2',
      fromWarehouseCode: fromWarehouse,
      fromLocationCode: fromCell,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    expect(before - (await cellBalance(fromWarehouse, fromCell, item.code, item.batch)))
      .toBeCloseTo(2, 6);
    const m = await move(res.body.data.uid);
    expect(m.operation_type).toBe('issue_to_production');
    expect(m.from_code).toBe(fromWarehouse);
    expect(m.to_code).toBeNull();
  });

  it('выдача в производство не принимает склад получения', async () => {
    const res = await post(keeper.token, {
      companyUid: company.uid,
      operationType: 'issue_to_production',
      itemCode: item.code,
      batchNumber: item.batch,
      qty: '1',
      fromWarehouseCode: fromWarehouse,
      fromLocationCode: fromCell,
      toWarehouseCode: toWarehouse,
      toLocationCode: toCell,
    });
    expect(res.status).toBe(422);
  });

  it('не выдаёт в производство больше доступного', async () => {
    const before = await balance(fromWarehouse, item.code, item.batch);
    const res = await post(keeper.token, {
      companyUid: company.uid,
      operationType: 'issue_to_production',
      itemCode: item.code,
      batchNumber: item.batch,
      qty: '999999',
      fromWarehouseCode: fromWarehouse,
      fromLocationCode: fromCell,
    });
    expect(res.status).toBe(422);
    expect(await balance(fromWarehouse, item.code, item.batch)).toBeCloseTo(before, 6);
  });

  it('возвращает из производства на склад', async () => {
    const before = await cellBalance(fromWarehouse, fromCell, item.code, item.batch);

    const res = await post(keeper.token, {
      companyUid: company.uid,
      operationType: 'return_from_production',
      itemCode: item.code,
      batchNumber: item.batch,
      qty: '2',
      toWarehouseCode: fromWarehouse,
      toLocationCode: fromCell,
      unitCost: '1000',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    expect((await cellBalance(fromWarehouse, fromCell, item.code, item.batch)) - before)
      .toBeCloseTo(2, 6);
  });

  it('возврат от клиента без контрагента не принимает', async () => {
    const res = await post(keeper.token, {
      companyUid: company.uid,
      operationType: 'return_from_client',
      itemCode: item.code,
      batchNumber: item.batch,
      qty: '1',
      toWarehouseCode: fromWarehouse,
      toLocationCode: fromCell,
      unitCost: '1000',
    });
    expect(res.status).toBe(422);
    expect(String(res.body.error.message)).toContain('контрагент');
  });

  it('приходует возврат от клиента с контрагентом', async () => {
    const buyer = (
      await db.query<{ uid: string }>(
        `SELECT p.uid FROM partner p JOIN company c ON c.id = p.company_id
          WHERE c.uid = $1 AND p.is_active AND p.is_client ORDER BY p.id LIMIT 1`,
        [company.uid],
      )
    ).rows[0];
    const before = await cellBalance(fromWarehouse, fromCell, item.code, item.batch);

    const res = await post(keeper.token, {
      companyUid: company.uid,
      operationType: 'return_from_client',
      itemCode: item.code,
      batchNumber: item.batch,
      qty: '1',
      toWarehouseCode: fromWarehouse,
      toLocationCode: fromCell,
      partnerUid: buyer.uid,
      unitCost: '1000',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((await cellBalance(fromWarehouse, fromCell, item.code, item.batch)) - before)
      .toBeCloseTo(1, 6);
  });

  /** Причина по виду: у списания — брак и порча, у излишка — инвентаризация. */
  const reasonOfKind = async (kind: string) =>
    (
      await db.query<{ id: string }>(
        `SELECT r.id::text AS id FROM stock_reason r JOIN company c ON c.id = r.company_id
          WHERE c.uid = $1 AND r.kind::text = $2 ORDER BY r.id LIMIT 1`,
        [company.uid, kind],
      )
    ).rows[0]!.id;

  /**
   * Роль контрагента проверяется по строке справочника, а не по типу движения
   * на глаз: приход от клиента и возврат от поставщика — одинаково складные
   * записи, по которым потом не сойдётся ни долг, ни история отгрузок.
   */
  it('возврат от клиента на поставщика не принимает', async () => {
    const supplier = (
      await db.query<{ uid: string }>(
        `SELECT p.uid FROM partner p JOIN company c ON c.id = p.company_id
          WHERE c.uid = $1 AND p.is_active AND p.is_supplier AND NOT p.is_client
          ORDER BY p.id LIMIT 1`,
        [company.uid],
      )
    ).rows[0]!;

    const res = await post(keeper.token, {
      companyUid: company.uid,
      operationType: 'return_from_client',
      itemCode: item.code,
      batchNumber: item.batch,
      qty: '1',
      toWarehouseCode: fromWarehouse,
      toLocationCode: fromCell,
      partnerUid: supplier.uid,
      unitCost: '1000',
    });
    expect(res.status).toBe(422);
    expect(String(res.body.error.message)).toContain('клиент');
  });

  it('приход от клиента, который не поставщик, не принимает', async () => {
    const buyer = (
      await db.query<{ uid: string }>(
        `SELECT p.uid FROM partner p JOIN company c ON c.id = p.company_id
          WHERE c.uid = $1 AND p.is_active AND p.is_client AND NOT p.is_supplier
          ORDER BY p.id LIMIT 1`,
        [company.uid],
      )
    ).rows[0]!;

    const res = await post(keeper.token, {
      companyUid: company.uid,
      operationType: 'receipt',
      itemCode: item.code,
      batchNumber: item.batch,
      qty: '1',
      toWarehouseCode: fromWarehouse,
      toLocationCode: fromCell,
      partnerUid: buyer.uid,
      unitCost: '1000',
    });
    expect(res.status).toBe(422);
    expect(String(res.body.error.message)).toContain('поставщик');
  });

  it('оприходует излишек на склад по причине инвентаризации', async () => {
    const before = await cellBalance(fromWarehouse, fromCell, item.code, item.batch);

    const res = await post(keeper.token, {
      companyUid: company.uid,
      operationType: 'surplus',
      itemCode: item.code,
      batchNumber: item.batch,
      qty: '1',
      toWarehouseCode: fromWarehouse,
      toLocationCode: fromCell,
      unitCost: '1000',
      reasonId: await reasonOfKind('inventory'),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((await cellBalance(fromWarehouse, fromCell, item.code, item.batch)) - before)
      .toBeCloseTo(1, 6);
  });

  /**
   * Излишек без причины — та же дыра, что списание без причины, только в плюс:
   * остаток вырос, а откуда взялся товар, не знает никто. Инвентаризация —
   * единственное основание, поэтому причина списания здесь тоже не годится.
   */
  it('излишек без причины не принимает', async () => {
    const res = await post(keeper.token, {
      companyUid: company.uid,
      operationType: 'surplus',
      itemCode: item.code,
      batchNumber: item.batch,
      qty: '1',
      toWarehouseCode: fromWarehouse,
      toLocationCode: fromCell,
      unitCost: '1000',
    });
    expect(res.status).toBe(422);
    expect(String(res.body.error.message)).toContain('причин');
  });

  it('излишек по причине списания не принимает: основание только инвентаризация', async () => {
    const res = await post(keeper.token, {
      companyUid: company.uid,
      operationType: 'surplus',
      itemCode: item.code,
      batchNumber: item.batch,
      qty: '1',
      toWarehouseCode: fromWarehouse,
      toLocationCode: fromCell,
      unitCost: '1000',
      reasonId: await reasonOfKind('write_off'),
    });
    expect(res.status).toBe(422);
  });

  it('списание по причине инвентаризации не принимает', async () => {
    const res = await post(keeper.token, {
      companyUid: company.uid,
      operationType: 'write_off',
      itemCode: item.code,
      batchNumber: item.batch,
      qty: '1',
      fromWarehouseCode: fromWarehouse,
      fromLocationCode: fromCell,
      reasonId: await reasonOfKind('inventory'),
    });
    expect(res.status).toBe(422);
  });

  it('излишек без права списания не проходит: остаток растёт из ниоткуда', async () => {
    const res = await post(seller.token, {
      companyUid: company.uid,
      operationType: 'surplus',
      itemCode: item.code,
      batchNumber: item.batch,
      qty: '1',
      toWarehouseCode: fromWarehouse,
      toLocationCode: fromCell,
      unitCost: '1000',
      reasonId: await reasonOfKind('inventory'),
    });
    expect(res.status).toBe(403);
  });

  it('новую партию заводит только приход', async () => {
    const res = await post(keeper.token, {
      companyUid: company.uid,
      operationType: 'surplus',
      itemCode: item.code,
      batchNumber: `ИЗЛИШЕК-${Date.now().toString(36).toUpperCase()}`,
      qty: '1',
      toWarehouseCode: fromWarehouse,
      toLocationCode: fromCell,
      unitCost: '1000',
      reasonId: await reasonOfKind('inventory'),
    });
    expect(res.status).toBe(422);
    expect(String(res.body.error.message)).toContain('не найдена');
  });

  it('отгрузку с экрана склада не принимает: её делает ТТН из заказа', async () => {
    const res = await post(keeper.token, {
      companyUid: company.uid,
      operationType: 'shipment',
      itemCode: item.code,
      batchNumber: item.batch,
      qty: '1',
      fromWarehouseCode: fromWarehouse,
      fromLocationCode: fromCell,
    });
    expect(res.status).toBe(400);
  });
});

describe('отмена движения', () => {
  it('зеркалит движение и возвращает остаток к прежнему', async () => {
    const before = await balance(fromWarehouse, item.code, item.batch);

    const made = await post(keeper.token, receipt({ qty: '9' }));
    expect(made.status).toBe(201);
    expect(await balance(fromWarehouse, item.code, item.batch)).toBeCloseTo(before + 9, 6);

    const back = await reverse(keeper.token, made.body.data.uid, 'ошиблись складом');
    expect(back.status, JSON.stringify(back.body)).toBe(201);

    const m = await move(back.body.data.uid);
    expect(m.reversal_of).toBe(made.body.data.uid);
    // Стороны поменялись местами: пришло на склад — с него же и снимаем.
    expect(m.from_code).toBe(fromWarehouse);
    expect(m.to_code).toBeNull();
    expect(await balance(fromWarehouse, item.code, item.batch)).toBeCloseTo(before, 6);

    // Журнал действий (ТЗ 3.4). Склад в него не писал вовсе: само движение
    // видно в журнале склада, но это те же данные, которые человек и правит.
    // Запись в `audit_log` нельзя ни исправить, ни удалить — триггер не даст.
    const log = await db.query<{ action: string; changes: any }>(
      `SELECT action, changes FROM audit_log
        WHERE entity_type = 'stock_move' AND entity_id = ANY($1::text[]) ORDER BY id`,
      [[made.body.data.uid, back.body.data.uid]],
    );
    const actions = log.rows.map((r) => r.action);
    expect(actions).toContain('create');
    expect(actions).toContain('reverse');
    const madeLog = log.rows.find((r) => r.action === 'create')!;
    expect(madeLog.changes.item.to).toBe(item.code);
    expect(Number(madeLog.changes.qty.to)).toBeCloseTo(9, 6);
    expect(log.rows.find((r) => r.action === 'reverse')!.changes.reversalOf.to).toBe(
      made.body.data.uid,
    );
  });

  it('второй раз то же движение не отменяет', async () => {
    const made = await post(keeper.token, receipt({ qty: '2' }));
    const first = await reverse(keeper.token, made.body.data.uid);
    expect(first.status).toBe(201);

    const second = await reverse(keeper.token, made.body.data.uid);
    expect(second.status).toBe(409);
    expect(String(second.body.error.message)).toContain('уже отменено');
  });

  /**
   * Движение отгрузки — след документа. Вернуть по нему товар на склад, не
   * тронув саму отгрузку, — самый тихий способ развести склад и продажи: остаток
   * вырастет, а отгрузка так и останется отгруженной.
   */
  it('не отменяет движение, заведённое документом', async () => {
    const doc = await db.query<{ uid: string }>(
      `SELECT m.uid FROM stock_move m
         JOIN company c ON c.id = m.company_id
        WHERE c.uid = $1 AND m.source_doc_type IS NOT NULL AND m.reversal_of_id IS NULL
        ORDER BY m.id DESC LIMIT 1`,
      [company.uid],
    );
    expect(doc.rows[0], 'в базе нет движений по документам: проверять нечего').toBeTruthy();

    const res = await api(`/api/v1/warehouse/moves/${doc.rows[0].uid}/reverse`, {
      method: 'POST',
      headers: json(keeper.token),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
    expect(String(res.body.error.message)).toContain('документ');
  });

  it('отмену не отменяет', async () => {
    const made = await post(keeper.token, receipt({ qty: '2' }));
    const back = await reverse(keeper.token, made.body.data.uid);
    expect(back.status).toBe(201);

    const again = await reverse(keeper.token, back.body.data.uid);
    expect(again.status).toBe(409);
  });
});

describe('путь партии после записи', () => {
  /**
   * Экран рисует кнопку «Сторно» по этим двум пометкам. Не будет их — кнопка
   * появится и у сторно, и у уже отменённого движения, а об отказе человек
   * узнает нажатием.
   */
  it('помечает отменённое движение и то, что отменяет сторно', async () => {
    const made = await post(keeper.token, receipt({ qty: '5' }));
    expect(made.status).toBe(201);
    const back = await reverse(keeper.token, made.body.data.uid);
    expect(back.status).toBe(201);

    const batchUid = await db.query<{ uid: string }>(
      `SELECT b.uid FROM batch b
         JOIN company c ON c.id = b.company_id
         JOIN item i ON i.id = b.item_id
        WHERE c.uid = $1 AND i.code = $2 AND b.number = $3`,
      [company.uid, item.code, item.batch],
    );

    const res = await api(`/api/v1/warehouse/batches/${batchUid.rows[0].uid}`, {
      headers: auth(keeper.token),
    });
    expect(res.status).toBe(200);

    const moves = res.body.data.moves as {
      uid: string;
      reversalOf: string | null;
      reversed: boolean;
    }[];
    const original = moves.find((m) => m.uid === made.body.data.uid);
    const storno = moves.find((m) => m.uid === back.body.data.uid);

    expect(original, 'движение не попало в путь партии').toBeTruthy();
    expect(original!.reversed).toBe(true);
    expect(original!.reversalOf).toBeNull();
    expect(storno!.reversalOf).toBe(made.body.data.uid);
    expect(storno!.reversed).toBe(false);
  });
});

describe('права', () => {
  it('без права складских операций приход не проходит', async () => {
    expect(seller.permissions).toContain('warehouse.view');
    expect(seller.permissions).not.toContain('warehouse.move');

    const res = await api('/api/v1/warehouse/moves', {
      method: 'POST',
      headers: json(seller.token),
      body: JSON.stringify(receipt()),
    });
    expect(res.status).toBe(403);
  });

  it('без права списания списание не проходит', async () => {
    expect(seller.permissions).not.toContain('warehouse.writeoff');

    const res = await api('/api/v1/warehouse/moves', {
      method: 'POST',
      headers: json(seller.token),
      body: JSON.stringify({
        companyUid: company.uid,
        operationType: 'write_off',
        itemCode: item.code,
        batchNumber: item.batch,
        qty: '1',
        fromWarehouseCode: fromWarehouse,
        reasonId: '1',
      }),
    });
    expect(res.status).toBe(403);
  });

  it('без токена не пускает вовсе', async () => {
    const res = await api('/api/v1/warehouse/moves', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(receipt()),
    });
    expect(res.status).toBe(401);
  });
});

describe('итог прогона', () => {
  /**
   * Последняя проверка в файле: всё, что тест наменял, он же и вернул. Если
   * однажды отмена перестанет зеркалить точно, разойдётся здесь, а не через
   * неделю в чужом отчёте.
   */
  it('остаток исходной позиции возвращается к тому, с чего начали', async () => {
    for (const uid of [...created].reverse()) {
      if (reversed.has(uid)) continue;
      const m = await move(uid);
      if (!m || m.reversal_of !== null) continue;
      const back = await reverse(keeper.token, uid, 'уборка после прогона');
      expect(back.status, `отмена ${uid}: ${JSON.stringify(back.body)}`).toBe(201);
    }
    expect(await balance(fromWarehouse, item.code, item.batch)).toBeCloseTo(startQty, 6);
  });
});
