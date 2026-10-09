import 'dotenv/config';
import { Client } from 'pg';
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

/**
 * Журнал движений отдельным списком: до этого маршрута движение можно было
 * увидеть только внутри карточки партии, то есть зная партию заранее.
 *
 * Счётчик `total` здесь сверяется прямым запросом в базу, а не сам с собой:
 * ответ, в котором и строки, и счётчик посчитаны одним и тем же SQL, остаётся
 * складным даже когда фильтр молча перестал работать.
 */
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
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();

  db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.end();
});

describe('GET /warehouse/moves', () => {
  it('отдаёт журнал новыми движениями вперёд и с человеческими подписями', async () => {
    const me = await login('admin');
    const res = await api('/api/v1/warehouse/moves?limit=25', { headers: auth(me.token) });

    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.rows.length).toBe(25);
    expect(d.total).toBeGreaterThan(25);

    for (const r of d.rows) {
      expect(r.uid).toMatch(/^[0-9a-f-]{36}$/);
      expect(r.item.code).toBeTruthy();
      expect(r.item.unit).toBeTruthy();
      expect(Number(r.qty)).toBeGreaterThan(0);
      // Движение обязано хоть куда-то относиться: приход имеет приёмник,
      // списание — источник, перемещение оба. Строка без складов не значит ничего.
      expect(Boolean(r.fromWarehouse) || Boolean(r.toWarehouse)).toBe(true);
    }

    const dates = d.rows.map((r: any) => new Date(r.movedAt).getTime());
    expect(dates).toEqual([...dates].sort((a, b) => b - a));
  });

  it('фильтр по типу операции: и строки, и счётчик сходятся с базой', async () => {
    const me = await login('admin');
    const res = await api('/api/v1/warehouse/moves?operationType=write_off&limit=50', {
      headers: auth(me.token),
    });

    expect(res.status).toBe(200);
    expect(res.body.data.rows.length).toBeGreaterThan(0);
    for (const r of res.body.data.rows) expect(r.operationType).toBe('write_off');

    const inDb = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM stock_move WHERE operation_type = 'write_off'`,
    );
    expect(res.body.data.total).toBe(Number(inDb.rows[0]!.n));
  });

  /**
   * Каждый тип операции, который можно провести с экрана склада, обязан быть
   * в журнале. Фильтр, под который после пересева ничего не находится, ничем
   * не отличается от сломанного: проверить его на живых данных нечем, а
   * кладовщик видит пустой список и считает, что потерялись движения.
   */
  it('каждый тип операции с экрана склада есть в журнале', async () => {
    const me = await login('admin');
    const kinds = [
      'receipt',
      'write_off',
      'transfer',
      'issue_to_production',
      'return_from_production',
      'return_from_client',
      'surplus',
    ];
    const empty: string[] = [];
    for (const kind of kinds) {
      const res = await api(`/api/v1/warehouse/moves?operationType=${kind}&limit=5`, {
        headers: auth(me.token),
      });
      expect(res.status).toBe(200);
      if (res.body.data.total === 0) empty.push(kind);
    }
    expect(empty).toEqual([]);
  });

  it('возврат от клиента несёт контрагента, излишек — причину, оба лежат в ячейке', async () => {
    const me = await login('admin');

    const ret = await api('/api/v1/warehouse/moves?operationType=return_from_client&limit=5', {
      headers: auth(me.token),
    });
    expect(ret.body.data.rows.length).toBeGreaterThan(0);
    // Сторно несёт тот же тип операции, но стороны у него зеркальные: товар
    // уходит оттуда, куда возврат его положил. Это не дефект, а устройство
    // исправления, поэтому проверяем только прямые строки.
    const direct = ret.body.data.rows.filter((r: any) => !r.reversalOf);
    expect(direct.length).toBeGreaterThan(0);
    for (const r of direct) {
      expect(r.partner).toBeTruthy();
      expect(r.toLocation).toMatch(/^[A-Z0-9-]+\/[A-Z0-9-]+$/);
      expect(r.fromWarehouse).toBeFalsy();
    }

    const sur = await api('/api/v1/warehouse/moves?operationType=surplus&limit=5', {
      headers: auth(me.token),
    });
    expect(sur.body.data.rows.length).toBeGreaterThan(0);
    for (const r of sur.body.data.rows.filter((r: any) => !r.reversalOf)) {
      // Излишек, найденный при инвентаризации, причины из справочника не несёт:
      // объяснение - лист пересчёта, и строка показывает его номер документом.
      // Причина требуется от излишка, который провели руками.
      if (r.docType === 'inventory_sheet') expect(r.docNumber).toBeTruthy();
      else expect(r.reason).toBeTruthy();
      expect(r.toLocation).toMatch(/^[A-Z0-9-]+\/[A-Z0-9-]+$/);
    }

    const back = await api('/api/v1/warehouse/moves?operationType=return_from_production&limit=5', {
      headers: auth(me.token),
    });
    expect(back.body.data.rows.length).toBeGreaterThan(0);
    for (const r of back.body.data.rows.filter((r: any) => !r.reversalOf)) {
      expect(r.toLocation).toMatch(/^[A-Z0-9-]+\/[A-Z0-9-]+$/);
      expect(r.fromWarehouse).toBeFalsy();
    }
  });

  it('фильтр по складу оставляет только движения этого склада', async () => {
    const me = await login('admin');
    const summary = await api('/api/v1/warehouse/summary', { headers: auth(me.token) });
    const wh = summary.body.data.warehouses.find((w: any) => w.rows > 0);

    const res = await api(`/api/v1/warehouse/moves?warehouse=${wh.uid}&limit=100`, {
      headers: auth(me.token),
    });
    expect(res.status).toBe(200);
    expect(res.body.data.rows.length).toBeGreaterThan(0);
    for (const r of res.body.data.rows) {
      expect([r.fromWarehouse?.uid, r.toWarehouse?.uid]).toContain(wh.uid);
    }

    const inDb = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM stock_move m
         JOIN warehouse w ON w.uid = $1::uuid
        WHERE m.from_warehouse_id = w.id OR m.to_warehouse_id = w.id`,
      [wh.uid],
    );
    expect(res.body.data.total).toBe(Number(inDb.rows[0]!.n));
  });

  it('фильтр по позиции и по партии', async () => {
    const me = await login('admin');
    const stock = await api('/api/v1/warehouse/stock?limit=50', { headers: auth(me.token) });
    const row = stock.body.data.rows.find((r: any) => r.batch);

    const byItem = await api(
      `/api/v1/warehouse/moves?itemCode=${encodeURIComponent(row.item.code)}&limit=100`,
      { headers: auth(me.token) },
    );
    expect(byItem.status).toBe(200);
    expect(byItem.body.data.rows.length).toBeGreaterThan(0);
    for (const r of byItem.body.data.rows) expect(r.item.code).toBe(row.item.code);

    const byBatch = await api(
      `/api/v1/warehouse/moves?batchNumber=${encodeURIComponent(row.batch.number)}&limit=100`,
      { headers: auth(me.token) },
    );
    expect(byBatch.status).toBe(200);
    expect(byBatch.body.data.rows.length).toBeGreaterThan(0);
    for (const r of byBatch.body.data.rows) expect(r.batch.number).toBe(row.batch.number);

    // Партия уже и по позиции: фильтр по партии не может отдать больше,
    // чем фильтр по её позиции.
    expect(byBatch.body.data.total).toBeLessThanOrEqual(byItem.body.data.total);
  });

  it('период считается по местному дню, а не по таймзоне сервера', async () => {
    // Граница дня — Ташкент, и это не придирка: у дев-базы сессия в UTC, а
    // клиент Prisma подставляет таймзону процесса. Пока граница считалась
    // «как получится», один и тот же фильтр давал 288 движений вместо 269 —
    // в выборку попадал вечер предыдущего дня.
    const me = await login('admin');
    const to = new Date();
    const from = new Date(to.getTime() - 7 * 24 * 3600 * 1000);
    const iso = (d: Date) => d.toISOString().slice(0, 10);

    const res = await api(
      `/api/v1/warehouse/moves?from=${iso(from)}&to=${iso(to)}&limit=200`,
      { headers: auth(me.token) },
    );
    expect(res.status).toBe(200);
    expect(res.body.data.rows.length).toBeGreaterThan(0);

    // Смысл проверки, а не повтор реализации: ни одно отданное движение не
    // относится к местному дню раньше запрошенного.
    const localDay = (iso8601: string) =>
      new Date(iso8601).toLocaleDateString('en-CA', { timeZone: 'Asia/Tashkent' });
    for (const r of res.body.data.rows) {
      expect(localDay(r.movedAt) >= iso(from)).toBe(true);
      expect(localDay(r.movedAt) <= iso(to)).toBe(true);
    }

    const inDb = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM stock_move
        WHERE (moved_at AT TIME ZONE 'Asia/Tashkent')::date BETWEEN $1::date AND $2::date`,
      [iso(from), iso(to)],
    );
    expect(res.body.data.total).toBe(Number(inDb.rows[0]!.n));
  });

  it('страницы не пересекаются и в сумме дают тот же счётчик', async () => {
    const me = await login('admin');
    const p1 = await api('/api/v1/warehouse/moves?limit=10&offset=0', { headers: auth(me.token) });
    const p2 = await api('/api/v1/warehouse/moves?limit=10&offset=10', { headers: auth(me.token) });

    expect(p1.status).toBe(200);
    expect(p2.status).toBe(200);
    expect(p1.body.data.total).toBe(p2.body.data.total);

    const uids1 = p1.body.data.rows.map((r: any) => r.uid);
    const uids2 = p2.body.data.rows.map((r: any) => r.uid);
    expect(uids1.filter((u: string) => uids2.includes(u))).toEqual([]);
  });

  it('сторно и отменённое движение помечены — кнопка не предлагается напрасно', async () => {
    const me = await login('admin');
    const res = await api('/api/v1/warehouse/moves?limit=200', { headers: auth(me.token) });

    for (const r of res.body.data.rows) {
      expect(typeof r.reversed).toBe('boolean');
      expect(r.reversalOf === null || typeof r.reversalOf === 'string').toBe(true);
      // Движение под документом со склада не отменяют: склад и продажи
      // разошлись бы. Экран должен знать это до нажатия.
      if (r.docType) expect(r.canReverse).toBe(false);
      if (r.reversed || r.reversalOf) expect(r.canReverse).toBe(false);
    }
  });

  it('кладовщик торгового дома не видит заводских движений', async () => {
    const trade = await login('d.karimov');
    const admin = await login('admin');
    const plant = admin.companies.find((c) => c.code === 'plant')!;

    const forced = await api('/api/v1/warehouse/moves?limit=50', {
      headers: auth(trade.token, [plant.uid]),
    });
    expect(forced.status).toBe(403);

    const own = await api('/api/v1/warehouse/moves?limit=200', { headers: auth(trade.token) });
    expect(own.status).toBe(200);
    expect(own.body.data.rows.length).toBeGreaterThan(0);
    for (const r of own.body.data.rows) {
      for (const w of [r.fromWarehouse, r.toWarehouse]) {
        if (w) expect(w.code.startsWith('ZAVOD')).toBe(false);
      }
    }

    // И счётчик тоже под RLS, а не по всей базе.
    const all = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM stock_move`);
    expect(own.body.data.total).toBeLessThan(Number(all.rows[0]!.n));
  });

  it('без права warehouse.view не пускает', async () => {
    const accountant = await login('m.rahimova');
    expect(accountant.permissions).not.toContain('warehouse.view');

    const res = await api('/api/v1/warehouse/moves', { headers: auth(accountant.token) });
    expect(res.status).toBe(403);
  });

  it('негодный фильтр — отказ с указанием поля, а не молчаливая выдача всего', async () => {
    const me = await login('admin');

    const badType = await api('/api/v1/warehouse/moves?operationType=vydacha', {
      headers: auth(me.token),
    });
    expect(badType.status).toBe(400);

    const badLimit = await api('/api/v1/warehouse/moves?limit=100000', {
      headers: auth(me.token),
    });
    expect(badLimit.status).toBe(400);

    const badDate = await api('/api/v1/warehouse/moves?from=вчера', { headers: auth(me.token) });
    expect(badDate.status).toBe(400);
  });
});
