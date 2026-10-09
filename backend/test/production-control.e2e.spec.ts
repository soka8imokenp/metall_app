/**
 * Производственный календарь и контроль (Э7). Живая база, приложение целиком.
 *
 * Что здесь проверяется по сути: завод живёт по своему календарю, а не по
 * суткам подряд. Сроки считаются рабочими днями, этапы раскладываются по
 * сменам с переносом на следующий рабочий день, загрузка участка считается от
 * того, сколько завод вообще работал, а простой участка можно записать и без
 * заказа.
 *
 * За собой убираем полностью: свои смены и дни календаря удаляем, рабочую
 * неделю возвращаем той, какой застали.
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

/**
 * Кладовщик работает в двух компаниях, и календарь завода без выбора компании
 * ему не отдадут: это правило службы, а не особенность прогона. Заголовок тот
 * же, что ставит экран.
 */
let plantUid: string;
const auth = (token: string) => ({
  Authorization: `Bearer ${token}`,
  ...(plantUid ? { 'X-Company-Id': plantUid } : {}),
});
const json = (token: string) => ({ ...auth(token), 'Content-Type': 'application/json' });
const post = (token: string, path: string, body?: unknown) =>
  api(path, {
    method: 'POST',
    headers: json(token),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const patch = (token: string, path: string, body: unknown) =>
  api(path, { method: 'PATCH', headers: json(token), body: JSON.stringify(body) });
const get = (token: string, path: string) => api(path, { headers: auth(token) });

let master: Awaited<ReturnType<typeof login>>;
let keeper: Awaited<ReturnType<typeof login>>;

let plantId: bigint;
let madeItem: string;
let centerCode: string;
let downtimeReason: string;
let defectReason: string;
let weekBefore: number[];

const trash: string[] = [];
const shiftCodes: string[] = [];
const calendarDays: string[] = [];

const day = (shift: number) => {
  const d = new Date();
  d.setDate(d.getDate() + shift);
  return d.toISOString().slice(0, 10);
};

/** Ближайшая дата с нужным днём недели: проверки про выходные опираются на неё. */
const nextWeekday = (iso: number) => {
  const d = new Date();
  for (let i = 1; i <= 14; i++) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay() === 0 ? 7 : d.getDay();
    if (dow === iso) return d.toISOString().slice(0, 10);
  }
  throw new Error('не нашёлся день недели');
};

const calendar = async (token = master.token) =>
  (await get(token, '/api/v1/production/calendar')).body.data;

async function makeOrder(due: string, qty = '4') {
  const res = await post(master.token, '/api/v1/production/orders', {
    itemCode: madeItem,
    qtyPlanned: qty,
    dueDate: due,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  trash.push(res.body.data.uid);
  return res.body.data.uid as string;
}

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
    await db.query<{ id: string; uid: string; work_days: number[] }>(
      `SELECT id::text, uid::text, work_days FROM company WHERE code = 'plant'`,
    )
  ).rows[0];
  plantId = BigInt(plant.id);
  plantUid = plant.uid;
  weekBefore = plant.work_days;

  madeItem = (
    await db.query<{ code: string }>(
      `SELECT i.code FROM item i JOIN tech_card c ON c.item_id = i.id AND c.status = 'active'
        WHERE i.company_id = ${plantId} ORDER BY i.code LIMIT 1`,
    )
  ).rows[0].code;

  centerCode = (
    await db.query<{ code: string }>(
      `SELECT code FROM work_center WHERE company_id = ${plantId} AND is_active ORDER BY code LIMIT 1`,
    )
  ).rows[0].code;

  const reason = async (kind: string) =>
    (
      await db.query<{ uid: string }>(
        `SELECT uid::text FROM stock_reason
          WHERE company_id = ${plantId} AND kind = $1::"ReasonKind" AND is_active
          ORDER BY name_ru LIMIT 1`,
        [kind],
      )
    ).rows[0].uid;
  downtimeReason = await reason('downtime');
  defectReason = await reason('defect');
}, 90_000);

afterAll(async () => {
  if (db) {
    await db.query(`UPDATE company SET work_days = $1::int[] WHERE id = ${plantId}`, [weekBefore]);
    if (shiftCodes.length > 0) {
      await db.query(
        `DELETE FROM production_shift WHERE company_id = ${plantId} AND code = ANY($1::text[])`,
        [shiftCodes],
      );
    }
    await db.query(`UPDATE production_shift SET is_active = true WHERE company_id = ${plantId}`);
    if (calendarDays.length > 0) {
      await db.query(
        `DELETE FROM production_calendar_day WHERE company_id = ${plantId} AND day = ANY($1::date[])`,
        [calendarDays],
      );
    }
    await db.query(
      `DELETE FROM deviation_log WHERE comment LIKE 'прогон контроля%'
         OR production_order_id IN (SELECT id FROM production_order WHERE uid = ANY($1::uuid[]))`,
      [trash],
    );
    if (trash.length > 0) {
      await db.query(
        `DELETE FROM production_stage_event WHERE stage_id IN
           (SELECT s.id FROM production_stage s JOIN production_order o ON o.id = s.production_order_id
             WHERE o.uid = ANY($1::uuid[]))`,
        [trash],
      );
      await db.query(
        `DELETE FROM production_material WHERE production_order_id IN
           (SELECT id FROM production_order WHERE uid = ANY($1::uuid[]))`,
        [trash],
      );
      await db.query(
        `DELETE FROM production_stage WHERE production_order_id IN
           (SELECT id FROM production_order WHERE uid = ANY($1::uuid[]))`,
        [trash],
      );
      await db.query(`DELETE FROM production_order WHERE uid = ANY($1::uuid[])`, [trash]);
    }
  }
  await db?.end();
  await app?.close();
});

describe('календарь завода', () => {
  it('отдаёт рабочую неделю, смены и дни периода', async () => {
    const res = await get(master.token, '/api/v1/production/calendar');
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.workDays.length, 'рабочая неделя задана').toBeGreaterThan(0);
    expect(data.shifts.length, 'смены заведены').toBeGreaterThan(0);
    expect(data.dayMinutes, 'рабочий день в минутах').toBeGreaterThan(0);
    expect(data.days.length, 'дни периода').toBeGreaterThan(20);
    expect(data.workingDays).toBeLessThan(data.days.length);
  });

  it('воскресенье по умолчанию нерабочее, и это видно в днях', async () => {
    const sunday = nextWeekday(7);
    const data = await calendar();
    const row = data.days.find((d: any) => d.day === sunday);
    expect(row, `в календаре нет ${sunday}`).toBeDefined();
    expect(row.isWorking, 'воскресенье — выходной').toBe(false);
    expect(row.isException, 'обычный выходной исключением не считается').toBe(false);
  });

  it('праздник среди недели уменьшает число рабочих дней', async () => {
    const holiday = nextWeekday(3);
    calendarDays.push(holiday);
    const before = (await calendar()).workingDays;
    const res = await post(master.token, '/api/v1/production/calendar/days', {
      day: holiday,
      isWorking: false,
      comment: 'прогон контроля: праздник',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.workingDays).toBe(before - 1);
    const row = res.body.data.days.find((d: any) => d.day === holiday);
    expect(row.isWorking).toBe(false);
    expect(row.isException, 'день отмечен как исключение').toBe(true);
    expect(row.comment).toContain('праздник');
  });

  it('выходной без причины не заводят: цех должен знать, почему не работает', async () => {
    const res = await post(master.token, '/api/v1/production/calendar/days', {
      day: nextWeekday(2),
      isWorking: false,
    });
    expect(res.status).toBe(422);
    expect(String(res.body.error.message)).toMatch(/почему/i);
  });

  it('исключение, повторяющее обычную неделю, отбивается', async () => {
    const sunday = nextWeekday(7);
    const res = await post(master.token, '/api/v1/production/calendar/days', {
      day: sunday,
      isWorking: false,
      comment: 'прогон контроля',
    });
    expect(res.status).toBe(409);
    expect(String(res.body.error.message)).toMatch(/и так выходной/i);
  });

  it('снятое исключение возвращает день к неделе, а чужого дня нет', async () => {
    const saturday = nextWeekday(6);
    calendarDays.push(saturday);
    await post(master.token, '/api/v1/production/calendar/days', {
      day: saturday,
      isWorking: false,
      comment: 'прогон контроля: короткая неделя',
    });
    const cleared = await post(
      master.token,
      `/api/v1/production/calendar/days/${saturday}/clear`,
    );
    expect(cleared.status).toBe(201);
    const row = cleared.body.data.days.find((d: any) => d.day === saturday);
    expect(row.isException).toBe(false);
    expect(row.isWorking, 'суббота у завода рабочая').toBe(true);

    const again = await post(master.token, `/api/v1/production/calendar/days/${saturday}/clear`);
    expect(again.status, 'снимать нечего').toBe(404);
  });

  it('пустая рабочая неделя не принимается', async () => {
    const res = await post(master.token, '/api/v1/production/calendar/week', { days: [] });
    expect(res.status).toBe(422);
    expect(String(res.body.error.message)).toMatch(/хотя бы один день/i);
  });

  it('рабочая неделя меняется и считается заново', async () => {
    const res = await post(master.token, '/api/v1/production/calendar/week', {
      days: [1, 2, 3, 4, 5],
    });
    expect(res.status).toBe(201);
    expect(res.body.data.workDays).toEqual([1, 2, 3, 4, 5]);
    const saturday = res.body.data.days.find((d: any) => d.day === nextWeekday(6));
    expect(saturday.isWorking, 'суббота стала выходной').toBe(false);

    await post(master.token, '/api/v1/production/calendar/week', { days: weekBefore });
  });

  it('кладовщик календарь видит, но не правит', async () => {
    expect((await get(keeper.token, '/api/v1/production/calendar')).status).toBe(200);
    const res = await post(keeper.token, '/api/v1/production/calendar/week', { days: [1, 2, 3] });
    expect(res.status).toBe(403);
  });
});

describe('смены', () => {
  it('ночная смена считает длительность через полночь', async () => {
    shiftCodes.push('TEST-N');
    const res = await post(master.token, '/api/v1/production/calendar/shifts', {
      code: 'TEST-N',
      nameRu: 'Прогон: ночная',
      nameUz: 'Progon: tungi',
      startsAt: '22:00',
      endsAt: '06:00',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const made = res.body.data.shifts.find((s: any) => s.code === 'TEST-N');
    expect(made.durationMin, 'восемь часов через полночь').toBe(480);
  });

  it('смена длиной ноль не заводится, а дубль кода отбивается', async () => {
    const zero = await post(master.token, '/api/v1/production/calendar/shifts', {
      code: 'TEST-0',
      nameRu: 'Прогон: пустая',
      nameUz: 'Progon: bo‘sh',
      startsAt: '08:00',
      endsAt: '08:00',
    });
    expect(zero.status).toBe(422);
    expect(String(zero.body.error.message)).toMatch(/ноль/i);

    const twin = await post(master.token, '/api/v1/production/calendar/shifts', {
      code: 'TEST-N',
      nameRu: 'Прогон: дубль',
      nameUz: 'Progon: dubl',
      startsAt: '10:00',
      endsAt: '12:00',
    });
    expect(twin.status).toBe(409);
  });

  it('закрытая смена в рабочий день не считается', async () => {
    const before = (await calendar()).dayMinutes;
    const uid = (await calendar()).shifts.find((s: any) => s.code === 'TEST-N').uid;
    const res = await patch(master.token, `/api/v1/production/calendar/shifts/${uid}`, {
      code: 'TEST-N',
      nameRu: 'Прогон: ночная',
      nameUz: 'Progon: tungi',
      startsAt: '22:00',
      endsAt: '06:00',
      isActive: false,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.dayMinutes).toBe(before - 480);
  });
});

describe('раскладка этапов по сменам', () => {
  it('пишет плановые даты подряд и переносит на следующий рабочий день', async () => {
    const uid = await makeOrder(day(30), '40');
    await post(master.token, `/api/v1/production/orders/${uid}/stages/from-card`);

    const res = await post(master.token, `/api/v1/production/orders/${uid}/stages/schedule`);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const stages = res.body.data.stages;
    expect(stages.length).toBeGreaterThan(1);
    for (let i = 1; i < stages.length; i++) {
      expect(
        new Date(stages[i].plannedStart) >= new Date(stages[i - 1].plannedEnd),
        'этап начинается не раньше, чем кончился прошлый',
      ).toBe(true);
    }

    const card = await get(master.token, `/api/v1/production/orders/${uid}`);
    expect(card.body.data.stages[0].plannedStart, 'план попал в карточку').toBeTruthy();

    // Ни один плановый отрезок не падает на нерабочий день.
    const cal = await calendar();
    const offDays = new Set(cal.days.filter((d: any) => !d.isWorking).map((d: any) => d.day));
    for (const s of stages) {
      const started = new Date(s.plannedStart).toLocaleDateString('en-CA', {
        timeZone: 'Asia/Tashkent',
      });
      expect(offDays.has(started), `этап ${s.seq} начат в выходной ${started}`).toBe(false);
    }
  });

  it('говорит, успеваем ли к сроку', async () => {
    const uid = await makeOrder(day(1), '200');
    await post(master.token, `/api/v1/production/orders/${uid}/stages/from-card`);
    const res = await post(master.token, `/api/v1/production/orders/${uid}/stages/schedule`);
    expect(res.status).toBe(201);
    expect(res.body.data.finishesOn > res.body.data.dueDate, 'по графику не успеваем').toBe(true);
    expect(res.body.data.lateDays, 'опоздание в рабочих днях').toBeGreaterThan(0);
  });

  it('без этапов раскладывать нечего', async () => {
    const uid = await makeOrder(day(20));
    const res = await post(master.token, `/api/v1/production/orders/${uid}/stages/schedule`);
    expect(res.status).toBe(409);
    expect(String(res.body.error.message)).toMatch(/этап/i);
  });

  it('без смен раскладка отказывается считать', async () => {
    const uid = await makeOrder(day(20));
    await post(master.token, `/api/v1/production/orders/${uid}/stages/from-card`);
    await db.query(`UPDATE production_shift SET is_active = false WHERE company_id = ${plantId}`);
    const res = await post(master.token, `/api/v1/production/orders/${uid}/stages/schedule`);
    await db.query(
      `UPDATE production_shift SET is_active = true
        WHERE company_id = ${plantId} AND code <> 'TEST-N'`,
    );
    expect(res.status).toBe(409);
    expect(String(res.body.error.message)).toMatch(/смен/i);
  });
});

describe('срок заказа в рабочих днях', () => {
  it('выходной между сегодня и сроком в счёт не идёт', async () => {
    const uid = await makeOrder(day(10));
    const before = (await get(master.token, `/api/v1/production/orders/${uid}`)).body.data;
    expect(before.workDaysLeft, 'рабочих дней до срока').toBeGreaterThan(0);
    expect(before.workDaysLeft, 'календарных дней больше').toBeLessThan(12);

    const holiday = (await calendar()).days.find(
      (d: any) => d.isWorking && d.day > day(0) && d.day < day(10),
    ).day;
    calendarDays.push(holiday);
    await post(master.token, '/api/v1/production/calendar/days', {
      day: holiday,
      isWorking: false,
      comment: 'прогон контроля: праздник среди срока',
    });

    const after = (await get(master.token, `/api/v1/production/orders/${uid}`)).body.data;
    expect(after.workDaysLeft, 'праздник забрал один рабочий день').toBe(before.workDaysLeft - 1);
    await post(master.token, `/api/v1/production/calendar/days/${holiday}/clear`);
  });
});

describe('простои и журнал отклонений', () => {
  it('простой участка записывается с причиной и попадает в журнал', async () => {
    const res = await post(master.token, '/api/v1/production/deviations/downtime', {
      workCenterCode: centerCode,
      reasonUid: downtimeReason,
      minutes: 45,
      comment: 'прогон контроля: стояли без сырья',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.workCenterCode).toBe(centerCode);
    expect(res.body.data.durationMin).toBe(45);

    const log = await get(master.token, '/api/v1/production/deviations?kind=downtime');
    expect(log.status).toBe(200);
    const mine = log.body.data.rows.find((r: any) => r.comment?.includes('стояли без сырья'));
    expect(mine, 'записанный простой виден в журнале').toBeDefined();
    expect(mine.workCenterCode).toBe(centerCode);
    expect(mine.reasonRu).toBeTruthy();
  });

  it('простой уходит в загрузку участка', async () => {
    const before = (await get(master.token, '/api/v1/production/summary?period=7d')).body.data;
    const was = before.workCenters.find((w: any) => w.code === centerCode).downtimeMin;
    await post(master.token, '/api/v1/production/deviations/downtime', {
      workCenterCode: centerCode,
      reasonUid: downtimeReason,
      minutes: 30,
      comment: 'прогон контроля: загрузка',
    });
    const after = (await get(master.token, '/api/v1/production/summary?period=7d')).body.data;
    const now = after.workCenters.find((w: any) => w.code === centerCode).downtimeMin;
    expect(now).toBe(was + 30);
  });

  it('причиной брака простой не объясняют', async () => {
    const res = await post(master.token, '/api/v1/production/deviations/downtime', {
      workCenterCode: centerCode,
      reasonUid: defectReason,
      minutes: 10,
      comment: 'прогон контроля',
    });
    expect(res.status).toBe(422);
    expect(String(res.body.error.message)).toMatch(/другого вида/i);
  });

  it('простой длиннее суток — это опечатка', async () => {
    const res = await post(master.token, '/api/v1/production/deviations/downtime', {
      workCenterCode: centerCode,
      reasonUid: downtimeReason,
      minutes: 2000,
      comment: 'прогон контроля',
    });
    expect(res.status).toBe(400);
  });

  it('кладовщик журнал читает, но простой не записывает', async () => {
    expect((await get(keeper.token, '/api/v1/production/deviations')).status).toBe(200);
    const res = await post(keeper.token, '/api/v1/production/deviations/downtime', {
      workCenterCode: centerCode,
      reasonUid: downtimeReason,
      minutes: 15,
      comment: 'прогон контроля: чужой',
    });
    expect(res.status).toBe(403);
  });

  it('журнал считает итоги по видам и фильтрует по виду', async () => {
    const all = await get(master.token, '/api/v1/production/deviations?period=30d');
    expect(all.status).toBe(200);
    const totals = all.body.data.totals;
    expect(totals.length, 'итоги по видам').toBeGreaterThan(0);
    const downtime = totals.find((t: any) => t.kind === 'downtime');
    expect(downtime.minutes, 'минуты простоя сложены').toBeGreaterThan(0);

    const only = await get(master.token, '/api/v1/production/deviations?kind=defect');
    expect(only.body.data.rows.every((r: any) => r.kind === 'defect'), 'фильтр по виду').toBe(true);
  });
});

describe('загрузка участков по календарю', () => {
  it('процент считается от рабочих дней и смен, а не от суток', async () => {
    const res = await get(master.token, '/api/v1/production/summary?period=30d');
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.calendar.workingDays, 'рабочие дни окна').toBeGreaterThan(0);
    // Окно в 30 дней всегда содержит выходные: если их посчитали рабочими,
    // загрузка участка выйдет заниженной, и никто этого не заметит.
    expect(data.calendar.workingDays, 'выходные в окно не идут').toBeLessThan(30);
    expect(data.calendar.dayMinutes, 'минуты рабочего дня').toBeGreaterThan(0);
    expect(data.calendar.availableMin).toBe(data.calendar.workingDays * data.calendar.dayMinutes);

    const center = data.workCenters.find((w: any) => w.code === centerCode);
    expect(center.availableMin).toBe(data.calendar.availableMin);
    expect(Number(center.loadPercent)).toBeCloseTo(
      (center.actualMin / data.calendar.availableMin) * 100,
      1,
    );
  });

  it('без смен процента нет вовсе, а не ноль', async () => {
    await db.query(`UPDATE production_shift SET is_active = false WHERE company_id = ${plantId}`);
    const res = await get(master.token, '/api/v1/production/summary?period=30d');
    await db.query(
      `UPDATE production_shift SET is_active = true
        WHERE company_id = ${plantId} AND code <> 'TEST-N'`,
    );
    expect(res.body.data.calendar.availableMin).toBeNull();
    expect(res.body.data.workCenters[0].loadPercent).toBeNull();
  });
});
