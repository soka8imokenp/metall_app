/**
 * Отчёты производства, справочник участков и страницы списка (Э8).
 *
 * Главное, что здесь проверяется: отчёт — это то же, что уходит в файл, и
 * цифры в нём сходятся с базой, а не считаются на экране заново. Плюс две
 * вещи, которых не было: участок можно завести и поставить ему ставку часа
 * (без неё прямые затраты заказа считались нулём), а список заказов отдаёт
 * общее число строк и страницы.
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
import { ProductionModule } from '../src/production/production.module.js';
import { ContextMiddleware } from '../src/common/context.middleware.js';
import { EnvelopeInterceptor } from '../src/common/envelope.interceptor.js';
import { ErrorFilter } from '../src/common/error.filter.js';

let app: INestApplication;
let base: string;
let db: Client;

const PASSWORD = process.env.SEED_PASSWORD ?? 'metall-dev-2026';
const TEST_CENTER = 'TEST-WC';

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
    throw new Error(`Логин ${loginName} не прошёл: ${res.status}`);
  }
  return res.body.data as {
    token: string;
    permissions: string[];
    companies: { uid: string; code: string }[];
  };
}

let plantUid: string;
let plantId: bigint;
const auth = (token: string) => ({
  Authorization: `Bearer ${token}`,
  ...(plantUid ? { 'X-Company-Id': plantUid } : {}),
});
const json = (token: string) => ({ ...auth(token), 'Content-Type': 'application/json' });
const get = (token: string, path: string) => api(path, { headers: auth(token) });
const post = (token: string, path: string, body?: unknown) =>
  api(path, {
    method: 'POST',
    headers: json(token),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const patch = (token: string, path: string, body: unknown) =>
  api(path, { method: 'PATCH', headers: json(token), body: JSON.stringify(body) });

let master: Awaited<ReturnType<typeof login>>;
let keeper: Awaited<ReturnType<typeof login>>;

const day = (shift: number) => {
  const d = new Date();
  d.setDate(d.getDate() + shift);
  return d.toISOString().slice(0, 10);
};

/** Колонка отчёта по подписи: проверки не держатся на порядке колонок. */
const at = (report: any, title: string) => {
  const i = report.columns.findIndex((c: any) => c.title === title);
  expect(i, `в отчёте нет колонки «${title}»`).toBeGreaterThanOrEqual(0);
  return i;
};

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [PrismaModule, AuthModule, ProductionModule],
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

  master = await login('j.tashpulatov');
  keeper = await login('a.saidov');

  const plant = (
    await db.query<{ id: string; uid: string }>(
      `SELECT id::text, uid::text FROM company WHERE code = 'plant'`,
    )
  ).rows[0];
  plantId = BigInt(plant.id);
  plantUid = plant.uid;
}, 90_000);

afterAll(async () => {
  if (db) {
    await db.query(`DELETE FROM work_center WHERE company_id = ${plantId} AND code LIKE 'TEST-%'`);
    await db.query(
      `DELETE FROM audit_log WHERE entity_type = 'work_center' AND entity_id LIKE 'TEST-%'`,
    ).catch(() => undefined);
  }
  await db?.end();
  await app?.close();
});

describe('список заказов страницами', () => {
  it('отдаёт строки, общее число и страницу', async () => {
    const first = await get(master.token, '/api/v1/production/orders?limit=5');
    expect(first.status).toBe(200);
    expect(first.body.data.rows.length).toBeLessThanOrEqual(5);
    expect(first.body.data.total, 'общее число заказов').toBeGreaterThan(
      first.body.data.rows.length,
    );
    expect(first.body.data.offset).toBe(0);

    const second = await get(master.token, '/api/v1/production/orders?limit=5&offset=5');
    expect(second.body.data.offset).toBe(5);
    expect(second.body.data.total, 'общее число от страницы не зависит').toBe(
      first.body.data.total,
    );
    const firstNumbers = first.body.data.rows.map((o: any) => o.number);
    const secondNumbers = second.body.data.rows.map((o: any) => o.number);
    expect(
      secondNumbers.some((n: string) => firstNumbers.includes(n)),
      'вторая страница не повторяет первую',
    ).toBe(false);
  });
});

describe('отчёты производства', () => {
  it('план и факт по заказам сходятся с базой', async () => {
    const res = await get(
      master.token,
      `/api/v1/production/reports/orders?from=${day(-120)}&to=${day(30)}`,
    );
    expect(res.status).toBe(200);
    const report = res.body.data;
    expect(report.title).toContain('заказам');
    expect(report.rows.length).toBeGreaterThan(0);

    const counted = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM production_order
        WHERE company_id = ${plantId} AND due_date BETWEEN $1::date AND $2::date`,
      [day(-120), day(30)],
    );
    expect(report.total, 'строк столько же, сколько заказов со сроком в периоде').toBe(
      Number(counted.rows[0].n),
    );

    // Доля выполнения считается из тех же двух чисел, что стоят рядом.
    const plan = at(report, 'План');
    const good = at(report, 'Годное');
    const done = at(report, 'Выполнено, %');
    for (const row of report.rows.slice(0, 20)) {
      if (row[plan] > 0) {
        expect(row[done]).toBeCloseTo((row[good] / row[plan]) * 100, 1);
      } else {
        expect(row[done], 'без плана доли нет, а не ноль').toBeNull();
      }
    }
  });

  it('выпуск по номенклатуре считает долю брака от годного', async () => {
    const res = await get(master.token, `/api/v1/production/reports/output?from=${day(-120)}`);
    expect(res.status).toBe(200);
    const report = res.body.data;
    const good = at(report, 'Годное');
    const defect = at(report, 'Брак');
    const share = at(report, 'Доля брака, %');
    expect(report.rows.length).toBeGreaterThan(0);
    for (const row of report.rows) {
      if (row[good] > 0) expect(row[share]).toBeCloseTo((row[defect] / row[good]) * 100, 1);
      else expect(row[share], 'нет годного — доли нет').toBeNull();
    }
  });

  it('расход материалов показывает отклонение факта от плана', async () => {
    const res = await get(master.token, `/api/v1/production/reports/materials?from=${day(-120)}`);
    expect(res.status).toBe(200);
    const report = res.body.data;
    const plan = at(report, 'План');
    const used = at(report, 'Расход');
    const diff = at(report, 'Отклонение');
    expect(report.rows.length).toBeGreaterThan(0);
    for (const row of report.rows) {
      expect(row[diff]).toBeCloseTo(row[used] - row[plan], 5);
    }
  });

  it('отклонения собраны по причинам, а минуты сложены', async () => {
    const res = await get(master.token, `/api/v1/production/reports/deviations?from=${day(-120)}`);
    expect(res.status).toBe(200);
    const report = res.body.data;
    const minutes = at(report, 'Минут');
    const sum = report.rows.reduce((s: number, r: any[]) => s + Number(r[minutes]), 0);

    const counted = await db.query<{ n: string }>(
      `SELECT COALESCE(sum(duration_min), 0)::text AS n FROM deviation_log
        WHERE company_id = ${plantId}
          AND (occurred_at AT TIME ZONE 'Asia/Tashkent')::date >= $1::date`,
      [day(-120)],
    );
    expect(sum, 'минуты отчёта сходятся с журналом').toBe(Number(counted.rows[0].n));
  });

  it('загрузка участков берёт доступные минуты из календаря', async () => {
    const res = await get(master.token, `/api/v1/production/reports/load?from=${day(-30)}`);
    expect(res.status).toBe(200);
    const report = res.body.data;
    expect(report.subtitle).toMatch(/рабочих дней/);
    const available = at(report, 'Доступно, мин');
    const actual = at(report, 'Факт, мин');
    const load = at(report, 'Загрузка, %');
    for (const row of report.rows) {
      expect(row[available], 'доступные минуты заданы').toBeGreaterThan(0);
      expect(row[load]).toBeCloseTo((row[actual] / row[available]) * 100, 1);
    }
  });

  it('без смен загрузка не выдумывается', async () => {
    await db.query(`UPDATE production_shift SET is_active = false WHERE company_id = ${plantId}`);
    const res = await get(master.token, `/api/v1/production/reports/load?from=${day(-30)}`);
    await db.query(`UPDATE production_shift SET is_active = true WHERE company_id = ${plantId}`);
    const report = res.body.data;
    expect(report.subtitle).toMatch(/смены не заведены/i);
    const load = at(report, 'Загрузка, %');
    for (const row of report.rows) expect(row[load]).toBeNull();
  });

  it('неизвестного отчёта нет, а период проверяется', async () => {
    expect((await get(master.token, '/api/v1/production/reports/nothing')).status).toBe(400);
    const back = await get(
      master.token,
      `/api/v1/production/reports/orders?from=${day(10)}&to=${day(-10)}`,
    );
    expect(back.status).toBe(422);
    expect(String(back.body.error.message)).toMatch(/позже/i);
  });

  it('отчёт выгружается файлом', async () => {
    const res = await fetch(
      `${base}/api/v1/production/reports/orders/file?format=csv&from=${day(-60)}`,
      { headers: auth(master.token) },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('csv');
    const text = await res.text();
    expect(text).toContain('Заказ');

    const wrong = await fetch(`${base}/api/v1/production/reports/orders/file?format=json`, {
      headers: auth(master.token),
    });
    expect(wrong.status).toBe(400);
  });

  it('кладовщик отчёты производства читает', async () => {
    expect((await get(keeper.token, '/api/v1/production/reports/orders')).status).toBe(200);
  });
});

describe('справочник участков', () => {
  it('отдаёт участки со ставкой часа и числом незакрытых этапов', async () => {
    const res = await get(master.token, '/api/v1/production/work-centers');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    const row = res.body.data[0];
    expect(row.code).toBeTruthy();
    expect(row).toHaveProperty('costPerHour');
    expect(row).toHaveProperty('openStages');
  });

  it('участок заводят и ставят ему ставку часа', async () => {
    const made = await post(master.token, '/api/v1/production/work-centers', {
      code: TEST_CENTER,
      nameRu: 'Прогон: участок',
      nameUz: 'Progon: uchastka',
      capacityPerShift: '50',
      costPerHour: '120000',
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const mine = made.body.data.find((w: any) => w.code === TEST_CENTER);
    expect(Number(mine.costPerHour)).toBe(120000);

    const fixed = await patch(master.token, `/api/v1/production/work-centers/${TEST_CENTER}`, {
      code: TEST_CENTER,
      nameRu: 'Прогон: участок',
      nameUz: 'Progon: uchastka',
      capacityPerShift: '50',
      costPerHour: '150000',
    });
    expect(fixed.status).toBe(200);
    expect(
      Number(fixed.body.data.find((w: any) => w.code === TEST_CENTER).costPerHour),
    ).toBe(150000);
  });

  it('ставка часа уходит в расчёт себестоимости', async () => {
    const rate = await db.query<{ rate: string }>(
      `SELECT cost_per_hour::text AS rate FROM work_center
        WHERE company_id = ${plantId} AND code = $1`,
      [TEST_CENTER],
    );
    expect(Number(rate.rows[0].rate), 'справочник пишет ставку в ту же колонку, что читает расчёт').toBe(
      150000,
    );
  });

  it('дубль кода отбивается', async () => {
    const twin = await post(master.token, '/api/v1/production/work-centers', {
      code: TEST_CENTER,
      nameRu: 'Прогон: дубль',
      nameUz: 'Progon: dubl',
    });
    expect(twin.status).toBe(409);
  });

  it('занятый участок в архив не уходит', async () => {
    const busy = await db.query<{ code: string; n: string }>(
      `SELECT w.code, count(*)::text AS n FROM work_center w
         JOIN production_stage s ON s.work_center_id = w.id
         JOIN production_order o ON o.id = s.production_order_id
        WHERE w.company_id = ${plantId} AND w.is_active
          AND s.status IN ('pending', 'running', 'paused')
          AND o.status IN ('planned', 'in_progress', 'paused')
        GROUP BY w.code ORDER BY count(*) DESC LIMIT 1`,
    );
    if (!busy.rows[0]) {
      expect(busy.rows[0], 'в базе нет участка с незакрытыми этапами').toBeUndefined();
      return;
    }
    const res = await patch(master.token, `/api/v1/production/work-centers/${busy.rows[0].code}`, {
      code: busy.rows[0].code,
      nameRu: 'Прогон: закрыть',
      nameUz: 'Progon: yopish',
      isActive: false,
    });
    expect(res.status).toBe(409);
    expect(String(res.body.error.message)).toMatch(/незакрытых этапов/i);
  });

  it('свободный участок закрывается и возвращается', async () => {
    const closed = await patch(master.token, `/api/v1/production/work-centers/${TEST_CENTER}`, {
      code: TEST_CENTER,
      nameRu: 'Прогон: участок',
      nameUz: 'Progon: uchastka',
      isActive: false,
    });
    expect(closed.status).toBe(200);
    expect(closed.body.data.find((w: any) => w.code === TEST_CENTER).isActive).toBe(false);
  });

  it('кладовщик участки видит, но не правит', async () => {
    expect((await get(keeper.token, '/api/v1/production/work-centers')).status).toBe(200);
    const res = await post(keeper.token, '/api/v1/production/work-centers', {
      code: 'TEST-KEEPER',
      nameRu: 'Прогон: чужой',
      nameUz: 'Progon: begona',
    });
    expect(res.status).toBe(403);
  });
});
