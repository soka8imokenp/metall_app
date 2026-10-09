/**
 * Прослеживаемость партии в обе стороны (ТЗ 5.6).
 *
 * Сценарий приёмки звучит так: по номеру партии система показывает цепочку
 * приход → перемещения → выдача в производство → в каком заказе израсходовано →
 * в какой продукции вышло → кому отгружено → по какому документу → оплачено ли.
 * Здесь проверяется, что оба конца цепочки действительно смыкаются с данными,
 * а не выводятся из одного только журнала движений этой партии.
 *
 * Прогон ничего не пишет: трассировка — чтение, и портить ей остаток нечем.
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
  return res.body.data as { token: string; companies: { uid: string; code: string }[] };
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

let admin: Awaited<ReturnType<typeof login>>;

/** Партия, купленная у поставщика. */
let bought: { uid: string; number: string };
/** Партия, выпущенная цехом из материалов. */
let made: { uid: string; number: string; orderNumber: string };
/** Партия, ушедшая покупателю по ТТН. */
let sold: { uid: string; number: string };
/** Партия, выданная в цех. */
let issued: { uid: string; number: string };

const trace = async (uid: string) =>
  (await api(`/api/v1/warehouse/batches/${uid}`, { headers: auth(admin.token) })).body.data;

beforeAll(async () => {
  db = new Client({ connectionString: process.env.DATABASE_URL! });
  await db.connect();

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

  admin = await login('admin');

  // Партии подбираем запросом, а не именем из сида: сид пересевается, номера
  // в нём плавают, а свойство «куплена», «выпущена», «отгружена» остаётся.
  const pick = async (sql: string) => {
    const { rows } = await db.query(sql);
    if (rows.length === 0) throw new Error(`в базе нет партии под проверку: ${sql}`);
    return rows[0];
  };

  bought = await pick(`
    SELECT b.uid::text AS uid, b.number
      FROM batch b
      JOIN stock_move m ON m.batch_id = b.id AND m.operation_type = 'receipt'
     WHERE b.supplier_id IS NOT NULL
     ORDER BY b.id LIMIT 1`);

  const m = await pick(`
    SELECT b.uid::text AS uid, b.number, po.number AS order_number
      FROM batch b
      JOIN production_order po ON po.id = b.production_order_id
     WHERE EXISTS (SELECT 1 FROM stock_move mm
                    WHERE mm.source_doc_type = 'production_material'
                      AND mm.operation_type = 'issue_to_production'
                      AND mm.source_doc_id IN (SELECT id FROM production_material
                                                WHERE production_order_id = po.id))
     ORDER BY b.id LIMIT 1`);
  made = { uid: m.uid, number: m.number, orderNumber: m.order_number };

  sold = await pick(`
    SELECT b.uid::text AS uid, b.number
      FROM batch b
      JOIN stock_move m ON m.batch_id = b.id AND m.operation_type = 'shipment'
     WHERE m.source_doc_type = 'shipment'
     ORDER BY b.id LIMIT 1`);

  issued = await pick(`
    SELECT b.uid::text AS uid, b.number
      FROM batch b
      JOIN stock_move m ON m.batch_id = b.id AND m.operation_type = 'issue_to_production'
     WHERE m.source_doc_type = 'production_material'
     ORDER BY b.id LIMIT 1`);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.end();
});

describe('откуда пришло', () => {
  it('у купленной партии — приход с поставщиком и количеством', async () => {
    const d = await trace(bought.uid);
    const receipt = d.upstream.find((l: any) => l.kind === 'receipt');

    expect(receipt, `в цепочке партии ${bought.number} нет прихода`).toBeTruthy();
    expect(receipt.partner).toBeTruthy();
    expect(Number(receipt.qty)).toBeGreaterThan(0);
    // Куплена — значит цеха в происхождении быть не должно.
    expect(d.upstream.some((l: any) => l.kind === 'output')).toBe(false);
  });

  it('у выпущенной цехом — выпуск и материалы того самого заказа', async () => {
    const d = await trace(made.uid);
    const materials = d.upstream.filter((l: any) => l.kind === 'material');

    expect(materials.length, `у партии ${made.number} не показаны материалы`).toBeGreaterThan(0);
    for (const line of materials) {
      expect(line.productionOrder).toBe(made.orderNumber);
      expect(line.item?.code).toBeTruthy();
      expect(Number(line.qty)).toBeGreaterThan(0);
    }
  });

  it('материал назван партией, а не одной номенклатурой', async () => {
    const d = await trace(made.uid);
    const materials = d.upstream.filter((l: any) => l.kind === 'material');
    const named = materials.filter((l: any) => l.batch !== null);

    // «Из арматуры вообще» — не ответ на вопрос приёмки: партия материала
    // обязана быть названа и обязана существовать.
    expect(named.length).toBe(materials.length);
    for (const line of named) {
      const { rows } = await db.query('SELECT number FROM batch WHERE uid = $1::uuid', [
        line.batch.uid,
      ]);
      expect(rows[0]?.number).toBe(line.batch.number);
    }
  });
});

describe('куда ушло', () => {
  it('отгрузка названа ТТН, покупателем, заказом и состоянием оплаты', async () => {
    const d = await trace(sold.uid);
    const shipment = d.downstream.find((l: any) => l.kind === 'shipment');

    expect(shipment, `в цепочке партии ${sold.number} нет отгрузки`).toBeTruthy();
    expect(shipment.docNumber).toBeTruthy();
    expect(shipment.partner).toBeTruthy();
    expect(shipment.salesOrder).toBeTruthy();
    expect(['unpaid', 'partial', 'paid']).toContain(shipment.payment.status);

    // Оплата берётся у заказа, а не пересчитывается второй раз.
    const { rows } = await db.query(
      'SELECT payment_status, paid_amount::text, amount_total::text FROM sales_order WHERE number = $1',
      [shipment.salesOrder],
    );
    expect(shipment.payment.status).toBe(rows[0].payment_status);
    expect(Number(shipment.payment.paid)).toBeCloseTo(Number(rows[0].paid_amount), 2);
    expect(Number(shipment.payment.total)).toBeCloseTo(Number(rows[0].amount_total), 2);
  });

  it('выдача в цех показывает заказ и что из него вышло', async () => {
    const d = await trace(issued.uid);
    const issue = d.downstream.find((l: any) => l.kind === 'issue_to_production');
    const outputs = d.downstream.filter((l: any) => l.kind === 'output');

    expect(issue, `в цепочке партии ${issued.number} нет выдачи в цех`).toBeTruthy();
    expect(issue.productionOrder).toBeTruthy();
    // Ради этого шага цепочка и строится: «в какой продукции вышло».
    expect(outputs.length).toBeGreaterThan(0);
    for (const out of outputs) {
      expect(out.item?.code).toBeTruthy();
      expect(Number(out.qty)).toBeGreaterThan(0);
    }
  });

  it('цепочка смыкается: продукция заказа знает про свой материал', async () => {
    const d = await trace(issued.uid);
    // Выпуск обязан назвать партию продукции: без номера цепочка обрывается на
    // «труба вообще». Пропустить проверку тут значит не проверить ничего.
    const out = d.downstream.find((l: any) => l.kind === 'output' && l.batch !== null);
    expect(out, `выпуски заказа не назвали ни одной партии продукции`).toBeTruthy();

    const back = await trace(out.batch.uid);
    const asMaterial = back.upstream.filter(
      (l: any) => l.kind === 'material' && l.batch?.number === issued.number,
    );
    expect(
      asMaterial.length,
      `партия ${issued.number} ушла в ${out.batch.number}, но обратно эта связь не видна`,
    ).toBeGreaterThan(0);
  });

  it('отменённое движение судьбой товара не считается', async () => {
    // Сторнированная пара «движение + его отмена» не должна попадать в
    // цепочку ни одной из сторон: товар никуда не ушёл.
    // Партию берём не первую попавшуюся со сторно, а такую, у которой цепочка
    // не пустая: у партии без единого живого прихода и расхода проверка ниже
    // зелёная всегда, чем бы сервер ни ответил. Ровно так она и сломалась,
    // когда посев перетасовал данные.
    const { rows } = await db.query(`
      SELECT b.uid::text AS uid
        FROM batch b
       WHERE EXISTS (SELECT 1 FROM stock_move m
                      WHERE m.batch_id = b.id
                        AND EXISTS (SELECT 1 FROM stock_move r WHERE r.reversal_of_id = m.id))
         AND EXISTS (SELECT 1 FROM stock_move m2
                      WHERE m2.batch_id = b.id
                        AND m2.operation_type IN
                            ('receipt', 'output', 'issue_to_production', 'shipment', 'write_off')
                        AND m2.reversal_of_id IS NULL
                        AND NOT EXISTS (SELECT 1 FROM stock_move r2 WHERE r2.reversal_of_id = m2.id))
       LIMIT 1`);
    expect(
      rows.length,
      'в базе нет партии со сторнированным движением и живой цепочкой — проверять нечего',
    ).toBe(1);

    const d = await trace(rows[0].uid);
    const reversedUids = new Set<string>(
      d.moves.filter((m: any) => m.reversed || m.reversalOf !== null).map((m: any) => m.uid),
    );
    expect(reversedUids.size).toBeGreaterThan(0);
    const links = [...d.upstream, ...d.downstream];
    // Без этой строки проверка ниже пустая: у звена без номера движения она
    // всегда зелёная, чего бы ни отдал сервер.
    expect(
      links.filter((l: any) => l.uid !== null && l.uid !== undefined).length,
      'ни одно звено цепочки не назвало своего движения',
    ).toBeGreaterThan(0);
    for (const link of links) {
      expect(reversedUids.has(link.uid ?? '')).toBe(false);
    }
  });
});

/**
 * Язык карточки партии.
 *
 * Названия в цепочке приходят из базы, и локаль им задаёт `app_loc(ru, uz)` по
 * `app.locale`. Поставщик и склады в движениях через него уже шли, а
 * номенклатура — нет: она возвращалась полем `nameRu` всегда по-русски, в
 * голове партии, в материалах, в выпусках и в карточке серии. Для человека на
 * узбекском это выглядело так, будто перевода нет вовсе — ровно на том экране,
 * где смотрят происхождение металла.
 */
describe('язык карточки партии', () => {
  /** Партия, у номенклатуры которой узбекское название есть и отличается от русского. */
  let dual: { uid: string; number: string; nameRu: string; nameUz: string };

  beforeAll(async () => {
    const { rows } = await db.query(`
      SELECT b.uid::text AS uid, b.number, i.name_ru, i.name_uz
        FROM batch b
        JOIN item i ON i.id = b.item_id
       WHERE i.name_uz IS NOT NULL AND i.name_uz <> '' AND i.name_uz <> i.name_ru
       ORDER BY b.id LIMIT 1`);
    if (rows.length === 0) {
      throw new Error('в базе нет партии с узбекским названием номенклатуры — проверять нечего');
    }
    dual = {
      uid: rows[0].uid,
      number: rows[0].number,
      nameRu: rows[0].name_ru,
      nameUz: rows[0].name_uz,
    };
  });

  const traceIn = async (uid: string, locale: 'ru' | 'uz') =>
    (
      await api(`/api/v1/warehouse/batches/${uid}`, {
        headers: { ...auth(admin.token), 'Accept-Language': locale },
      })
    ).body.data;

  it('номенклатура партии названа на языке запроса', async () => {
    const uz = await traceIn(dual.uid, 'uz');
    const ru = await traceIn(dual.uid, 'ru');

    expect(uz.batch.item.name, `партия ${dual.number} под узбекским`).toBe(dual.nameUz);
    expect(ru.batch.item.name, `партия ${dual.number} под русским`).toBe(dual.nameRu);
    // Старое поле ушло вместе с русским значением: пока оно есть, экран берёт его.
    expect(uz.batch.item.nameRu).toBeUndefined();
  });

  it('склад в остатках назван на языке запроса', async () => {
    const { rows } = await db.query(`
      SELECT b.uid::text AS uid, w.name_ru, w.name_uz
        FROM batch b
        JOIN stock_balance sb ON sb.batch_id = b.id AND sb.qty_on_hand > 0
        JOIN warehouse w      ON w.id = sb.warehouse_id
       WHERE w.name_uz IS NOT NULL AND w.name_uz <> '' AND w.name_uz <> w.name_ru
       ORDER BY b.id LIMIT 1`);
    expect(rows.length, 'в базе нет склада с узбекским названием — проверять нечего').toBe(1);

    const uz = await traceIn(rows[0].uid, 'uz');
    const names = uz.balances.map((b: any) => b.warehouse);
    expect(names.length, 'у партии нет остатков — проверять нечего').toBeGreaterThan(0);
    expect(names).toContain(rows[0].name_uz);
    expect(names).not.toContain(rows[0].name_ru);
  });

  it('номенклатура материалов и выпусков названа на языке запроса', async () => {
    const uz = await traceIn(made.uid, 'uz');
    const links = [...uz.upstream, ...uz.downstream].filter((l: any) => l.item !== null);
    expect(links.length, `в цепочке партии ${made.number} нет звеньев с номенклатурой`).toBeGreaterThan(0);

    // Сверяем с базой поимённо: у номенклатуры с заполненным узбекским именем
    // звено обязано назвать именно его, а не русское.
    let checked = 0;
    for (const link of links) {
      expect(link.item.nameRu).toBeUndefined();
      const { rows } = await db.query('SELECT name_ru, name_uz FROM item WHERE code = $1', [
        link.item.code,
      ]);
      expect(rows.length, `номенклатуры ${link.item.code} нет в базе`).toBe(1);
      const { name_ru: ru, name_uz: uz } = rows[0];
      if (!uz || uz === ru) continue;
      expect(link.item.name, `звено ${link.kind} партии ${made.number}`).toBe(uz);
      checked += 1;
    }
    expect(
      checked,
      'ни у одной номенклатуры в цепочке нет узбекского названия — проверка пустая',
    ).toBeGreaterThan(0);
  });
});
