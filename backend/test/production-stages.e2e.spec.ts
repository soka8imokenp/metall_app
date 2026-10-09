/**
 * Этапы заказа и фиксация факта: приложение целиком, живая база.
 *
 * Проверяется не «ответил ли сервер», а то, ради чего отметки вообще сделаны
 * событиями: фактическое время складывается из нажатий и не вводится руками,
 * пауза без причины не ставится и превращается в строку журнала простоев,
 * план работ после первой отметки не переписывается, рабочий отмечает только
 * свои этапы, а заказ без этапов не запускается.
 *
 * Прибираемся удалением своих заказов: `production_order` — не журнал,
 * триггера append-only на нём нет. Этапы, события и отклонения уезжают
 * вместе с заказом каскадом и ссылкой.
 */
import 'dotenv/config';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ForbiddenException, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { AuthGuard } from '../src/auth/auth.guard.js';
import { ProductionModule } from '../src/production/production.module.js';
import { ProductionStagesService } from '../src/production/stages.service.js';
import { ContextMiddleware } from '../src/common/context.middleware.js';
import { EnvelopeInterceptor } from '../src/common/envelope.interceptor.js';
import { ErrorFilter } from '../src/common/error.filter.js';
import { runWithContext } from '../src/common/request-context.js';

let app: INestApplication;
let base: string;
let db: Client;
let stages: ProductionStagesService;

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

let master: Awaited<ReturnType<typeof login>>;
let keeper: Awaited<ReturnType<typeof login>>;

let plantId: bigint;
let masterId: bigint;
let otherId: bigint;
let otherUid: string;
/** Продукция с действующей техкартой и без неё. */
let cardedItem: string;
let plainItem: string;
let downtimeUid: string;
let workCenter: string;

const trash: string[] = [];

const day = (shift: number) => new Date(Date.now() + shift * 86_400_000).toISOString().slice(0, 10);

const post = (token: string, path: string, body?: unknown) =>
  api(path, {
    method: 'POST',
    headers: json(token),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const put = (token: string, path: string, body: unknown) =>
  api(path, { method: 'PUT', headers: json(token), body: JSON.stringify(body) });

const get = (token: string, path: string) => api(path, { headers: auth(token) });

async function makeOrder(itemCode: string, over: Record<string, unknown> = {}) {
  const res = await post(master.token, '/api/v1/production/orders', {
    itemCode,
    qtyPlanned: '4',
    dueDate: day(7),
    ...over,
  });
  if (res.body?.data?.uid) trash.push(res.body.data.uid);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.uid as string;
}

const setStatus = (uid: string, status: string, comment?: string) =>
  post(master.token, `/api/v1/production/orders/${uid}/status`, {
    status,
    ...(comment ? { comment } : {}),
  });

/** Завести заказ и довести его до работы с этапами из карты. */
async function running(over: Record<string, unknown> = {}) {
  const uid = await makeOrder(cardedItem, over);
  const planned = await post(master.token, `/api/v1/production/orders/${uid}/stages/from-card`);
  expect(planned.status, JSON.stringify(planned.body)).toBe(201);
  await setStatus(uid, 'planned');
  expect((await setStatus(uid, 'in_progress')).status).toBe(201);
  return uid;
}

const mark = (token: string, uid: string, seq: number, body: Record<string, unknown>) =>
  post(token, `/api/v1/production/orders/${uid}/stages/${seq}/mark`, body);

const stageRows = async (uid: string) =>
  (
    await db.query<{
      seq: number;
      status: string;
      planned_duration_min: number;
      actual_duration_min: number;
      responsible_id: string | null;
    }>(
      `SELECT s.seq, s.status::text AS status, s.planned_duration_min, s.actual_duration_min,
              s.responsible_id::text
         FROM production_stage s JOIN production_order o ON o.id = s.production_order_id
        WHERE o.uid = $1::uuid ORDER BY s.seq`,
      [uid],
    )
  ).rows;

const events = async (uid: string, seq: number) =>
  (
    await db.query<{ event: string; user_id: string | null; reason_id: string | null }>(
      `SELECT e.event::text AS event, e.user_id::text, e.reason_id::text
         FROM production_stage_event e
         JOIN production_stage s ON s.id = e.stage_id
         JOIN production_order o ON o.id = s.production_order_id
        WHERE o.uid = $1::uuid AND s.seq = $2
        ORDER BY e.occurred_at, e.id`,
      [uid, seq],
    )
  ).rows;

const audit = async (uid: string) =>
  (
    await db.query<{ action: string; changes: any }>(
      `SELECT action, changes FROM audit_log
        WHERE entity_type = 'production_order' AND entity_id = $1 ORDER BY occurred_at, id`,
      [uid],
    )
  ).rows;

/**
 * Отметить годное прямо в базе: эти проверки про этапы и статусы, а не про
 * выпуск. Настоящий путь выпуска проверяет `production-outputs.e2e`.
 */
const produce = (uid: string) =>
  db.query(`UPDATE production_order SET qty_produced = qty_planned WHERE uid = $1::uuid`, [uid]);

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
  stages = app.get(ProductionStagesService);

  db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  master = await login('j.tashpulatov');
  keeper = await login('a.saidov');

  plantId = BigInt(
    (await db.query<{ id: string }>(`SELECT id::text FROM company WHERE code = 'plant'`)).rows[0].id,
  );
  const me = await db.query<{ id: string }>(
    `SELECT id::text FROM user_account WHERE login = 'j.tashpulatov'`,
  );
  masterId = BigInt(me.rows[0].id);
  const other = await db.query<{ id: string; uid: string }>(
    `SELECT id::text, uid::text FROM user_account WHERE login = 'b.ergashev'`,
  );
  otherId = BigInt(other.rows[0].id);
  otherUid = other.rows[0].uid;

  cardedItem = (
    await db.query<{ code: string }>(
      `SELECT i.code FROM item i JOIN tech_card tc ON tc.item_id = i.id AND tc.status = 'active'
        WHERE i.company_id = ${plantId} ORDER BY i.code LIMIT 1`,
    )
  ).rows[0].code;
  plainItem = (
    await db.query<{ code: string }>(
      `SELECT i.code FROM item i
        WHERE i.company_id = ${plantId} AND i.item_type = 'finished' AND i.is_active
          AND NOT EXISTS (SELECT 1 FROM tech_card tc WHERE tc.item_id = i.id)
        ORDER BY i.code LIMIT 1`,
    )
  ).rows[0].code;
  downtimeUid = (
    await db.query<{ uid: string }>(
      `SELECT uid::text FROM stock_reason
        WHERE company_id = ${plantId} AND kind = 'downtime' AND is_active ORDER BY id LIMIT 1`,
    )
  ).rows[0].uid;
  workCenter = (
    await db.query<{ code: string }>(
      `SELECT code FROM work_center WHERE company_id = ${plantId} AND is_active ORDER BY code LIMIT 1`,
    )
  ).rows[0].code;
}, 90_000);

afterAll(async () => {
  if (db && trash.length > 0) {
    await db.query(
      `DELETE FROM deviation_log WHERE production_order_id IN
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
  await db?.end();
  await app?.close();
});

describe('план работ: откуда берутся этапы', () => {
  it('заказ без этапов не запускается', async () => {
    const uid = await makeOrder(cardedItem);
    await setStatus(uid, 'planned');

    const res = await setStatus(uid, 'in_progress');
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(String(res.body.error.message)).toMatch(/этап/i);
    expect((await stageRows(uid)).length).toBe(0);
  });

  it('этапы разворачиваются из карты, а план считается на количество заказа', async () => {
    const uid = await makeOrder(cardedItem, { qtyPlanned: '4' });
    const res = await post(master.token, `/api/v1/production/orders/${uid}/stages/from-card`);
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const card = await db.query<{ seq: number; norm: number }>(
      `SELECT cs.seq, cs.norm_duration_min AS norm
         FROM tech_card_stage cs
         JOIN production_order o ON o.tech_card_id = cs.tech_card_id
        WHERE o.uid = $1::uuid ORDER BY cs.seq`,
      [uid],
    );
    const rows = await stageRows(uid);
    expect(rows.length, 'этапов столько же, сколько в карте').toBe(card.rows.length);
    expect(rows.length).toBeGreaterThan(0);
    for (const [i, r] of rows.entries()) {
      expect(r.status).toBe('pending');
      expect(r.planned_duration_min, `этап ${r.seq}: норма на 4 единицы`).toBe(
        Math.ceil(card.rows[i].norm * 4),
      );
    }
    expect((await audit(uid)).map((l) => l.action)).toContain('stage.plan');
  });

  it('у продукции без карты разворачивать нечего, и сказано что делать', async () => {
    const uid = await makeOrder(plainItem);
    const res = await post(master.token, `/api/v1/production/orders/${uid}/stages/from-card`);
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(String(res.body.error.message)).toMatch(/карт/i);
  });

  it('этапы заводятся руками: номера подряд, пустой список не принимается', async () => {
    const uid = await makeOrder(plainItem);

    const gap = await put(master.token, `/api/v1/production/orders/${uid}/stages`, {
      stages: [
        { seq: 1, nameRu: 'Резка', nameUz: 'Kesish', plannedDurationMin: 30 },
        { seq: 3, nameRu: 'Сварка', nameUz: 'Payvandlash', plannedDurationMin: 40 },
      ],
    });
    expect(gap.status, JSON.stringify(gap.body)).toBe(422);

    const empty = await put(master.token, `/api/v1/production/orders/${uid}/stages`, { stages: [] });
    expect(empty.status).toBe(422);

    const ok = await put(master.token, `/api/v1/production/orders/${uid}/stages`, {
      stages: [
        {
          seq: 1,
          nameRu: 'Резка',
          nameUz: 'Kesish',
          workCenterCode: workCenter,
          responsibleUid: otherUid,
          plannedDurationMin: 30,
        },
        { seq: 2, nameRu: 'Сварка', nameUz: 'Payvandlash', plannedDurationMin: 40 },
      ],
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const rows = await stageRows(uid);
    expect(rows.map((r) => r.seq)).toEqual([1, 2]);
    expect(rows[0].responsible_id, 'этап поручен названному человеку').toBe(String(otherId));
    expect(rows[0].planned_duration_min).toBe(30);
  });

  it('несуществующий рабочий центр в этапе отбивается', async () => {
    const uid = await makeOrder(plainItem);
    const res = await put(master.token, `/api/v1/production/orders/${uid}/stages`, {
      stages: [
        {
          seq: 1,
          nameRu: 'Резка',
          nameUz: 'Kesish',
          workCenterCode: 'НЕТ-ТАКОГО',
          plannedDurationMin: 10,
        },
      ],
    });
    expect(res.status).toBe(422);
    expect((await stageRows(uid)).length, 'ничего не записалось').toBe(0);
  });

  it('после первой отметки план работ не переписывают', async () => {
    const uid = await running();
    expect((await mark(master.token, uid, 1, { kind: 'start' })).status).toBe(201);

    const res = await post(master.token, `/api/v1/production/orders/${uid}/stages/from-card`);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(String(res.body.error.message)).toMatch(/отработанное время/i);
  });

  it('пока по этапам не отработали, план правят даже у запущенного заказа', async () => {
    const uid = await running();
    const res = await put(master.token, `/api/v1/production/orders/${uid}/stages`, {
      stages: [{ seq: 1, nameRu: 'Забытый этап', nameUz: 'Unutilgan bosqich', plannedDurationMin: 5 }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const rows = await stageRows(uid);
    expect(rows.length, 'список заменён целиком').toBe(1);
  });

  it('у закрытого заказа план работ не переписывают', async () => {
    const uid = await running();
    const total = (await stageRows(uid)).length;
    for (let seq = 1; seq <= total; seq += 1) {
      await mark(master.token, uid, seq, { kind: 'start' });
      await mark(master.token, uid, seq, { kind: 'finish' });
    }
    await produce(uid);
    expect((await setStatus(uid, 'produced')).status).toBe(201);

    const res = await put(master.token, `/api/v1/production/orders/${uid}/stages`, {
      stages: [{ seq: 1, nameRu: 'Поздно', nameUz: 'Kech', plannedDurationMin: 5 }],
    });
    expect(res.status).toBe(409);
    expect(String(res.body.error.message)).toMatch(/не в работе/i);
  });

  it('кладовщик в план работ не лезет', async () => {
    const uid = await makeOrder(cardedItem);
    const res = await post(keeper.token, `/api/v1/production/orders/${uid}/stages/from-card`);
    expect(res.status).toBe(403);
  });
});

describe('отметки по этапу', () => {
  it('путь этапа: начал → пауза → продолжил → закончил, время из отметок', async () => {
    const uid = await running();

    const started = await mark(master.token, uid, 1, { kind: 'start' });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    expect(started.body.data.status).toBe('running');

    const paused = await mark(master.token, uid, 1, {
      kind: 'pause',
      reasonUid: downtimeUid,
      comment: 'Ждём заготовку',
    });
    expect(paused.status).toBe(201);
    expect(paused.body.data.status).toBe('paused');

    expect((await mark(master.token, uid, 1, { kind: 'resume' })).status).toBe(201);
    const finished = await mark(master.token, uid, 1, { kind: 'finish' });
    expect(finished.status).toBe(201);
    expect(finished.body.data.status).toBe('done');

    expect((await events(uid, 1)).map((e) => e.event)).toEqual([
      'start',
      'pause',
      'resume',
      'finish',
    ]);
    expect((await events(uid, 1))[0].user_id, 'в отметке записан человек').toBe(String(masterId));
    expect((await events(uid, 1))[1].reason_id, 'у паузы названа причина').not.toBeNull();

    const log = (await audit(uid)).map((l) => l.action);
    for (const action of ['stage.start', 'stage.pause', 'stage.resume', 'stage.finish']) {
      expect(log, `журнал помнит «${action}»`).toContain(action);
    }
  });

  it('пауза без причины не ставится, с чужой причиной — тоже', async () => {
    const uid = await running();
    await mark(master.token, uid, 1, { kind: 'start' });

    const blank = await mark(master.token, uid, 1, { kind: 'pause' });
    expect(blank.status, JSON.stringify(blank.body)).toBe(422);
    // Не просто «422», а именно просьба назвать причину: ответ «причина не
    // найдена» на пустое поле означал бы, что правила про журнал простоев нет,
    // а есть случайно сработавшая проверка ссылки.
    expect(String(blank.body.error.message)).toMatch(/журнал простоев/i);

    // Причина своей же компании, но другого вида: иначе проверку прошла бы не
    // разборчивость по виду причины, а отсечение чужой компании.
    const foreign = (
      await db.query<{ uid: string }>(
        `SELECT uid::text FROM stock_reason
          WHERE company_id = ${plantId} AND kind = 'write_off' ORDER BY id LIMIT 1`,
      )
    ).rows[0].uid;
    const wrong = await mark(master.token, uid, 1, { kind: 'pause', reasonUid: foreign });
    expect(wrong.status, 'причина списания — не причина простоя').toBe(422);

    const rows = await stageRows(uid);
    expect(rows[0].status, 'отбитая пауза этап не трогала').toBe('running');
  });

  it('из паузы растёт журнал простоев', async () => {
    const uid = await running();
    await mark(master.token, uid, 1, { kind: 'start' });
    await mark(master.token, uid, 1, { kind: 'pause', reasonUid: downtimeUid });

    const during = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM deviation_log d
         JOIN production_order o ON o.id = d.production_order_id
        WHERE o.uid = $1::uuid AND d.kind = 'downtime'`,
      [uid],
    );
    expect(during.rows[0].n, 'пока стоим — простой ещё не закрыт').toBe('0');

    await mark(master.token, uid, 1, { kind: 'resume' });
    const after = await db.query<{ n: string; reason_id: string | null }>(
      `SELECT count(*)::text AS n, max(d.reason_id)::text AS reason_id FROM deviation_log d
         JOIN production_order o ON o.id = d.production_order_id
        WHERE o.uid = $1::uuid AND d.kind = 'downtime'`,
      [uid],
    );
    expect(after.rows[0].n, 'продолжили — простой закрылся строкой').toBe('1');
    expect(after.rows[0].reason_id, 'в простое та же причина, что назвали на паузе').not.toBeNull();
  });

  it('отработанное время считается из отметок, а не из нажатия кнопки', async () => {
    const uid = await running();
    await mark(master.token, uid, 1, { kind: 'start' });

    // Отодвигаем отметку начала на 25 минут назад: ровно так выглядит смена,
    // в которой человек нажал «начал» и работал, а не кликал подряд.
    await db.query(
      `UPDATE production_stage_event e SET occurred_at = now() - interval '25 minutes'
         FROM production_stage s, production_order o
        WHERE e.stage_id = s.id AND s.production_order_id = o.id
          AND o.uid = $1::uuid AND s.seq = 1 AND e.event = 'start'`,
      [uid],
    );
    await mark(master.token, uid, 1, { kind: 'pause', reasonUid: downtimeUid });
    const worked = (await stageRows(uid))[0].actual_duration_min;
    expect(worked, 'закрытый отрезок работы лёг в факт').toBeGreaterThanOrEqual(24);
    expect(worked, 'и не больше, чем прошло').toBeLessThanOrEqual(26);

    // Та же мера для простоя: стояли 15 минут — столько и в журнале отклонений.
    await db.query(
      `UPDATE production_stage_event e SET occurred_at = now() - interval '15 minutes'
         FROM production_stage s, production_order o
        WHERE e.stage_id = s.id AND s.production_order_id = o.id
          AND o.uid = $1::uuid AND s.seq = 1 AND e.event = 'pause'`,
      [uid],
    );
    await mark(master.token, uid, 1, { kind: 'resume' });
    const downtime = (
      await db.query<{ min: number }>(
        `SELECT d.duration_min AS min FROM deviation_log d
           JOIN production_order o ON o.id = d.production_order_id
          WHERE o.uid = $1::uuid AND d.kind = 'downtime'`,
        [uid],
      )
    ).rows[0].min;
    expect(downtime, 'простой записан той же длительностью').toBeGreaterThanOrEqual(14);
    expect(downtime).toBeLessThanOrEqual(16);

    // Возобновление время работы не трогает: оно копится отрезками.
    expect((await stageRows(uid))[0].actual_duration_min, 'простой в работу не приписан').toBe(
      worked,
    );
  });

  it('нажатие не по состоянию отбивается и говорит, что можно', async () => {
    const uid = await running();
    await mark(master.token, uid, 1, { kind: 'start' });

    const again = await mark(master.token, uid, 1, { kind: 'start' });
    expect(again.status).toBe(409);
    expect(String(again.body.error.message)).toMatch(/пауз|законч/i);

    await mark(master.token, uid, 1, { kind: 'pause', reasonUid: downtimeUid });
    const finish = await mark(master.token, uid, 1, { kind: 'finish' });
    expect(finish.status, 'этап на паузе сначала продолжают').toBe(409);
    expect(String(finish.body.error.message)).toMatch(/продолж/i);
  });

  it('по незапущенному заказу отметок нет', async () => {
    const uid = await makeOrder(cardedItem);
    await post(master.token, `/api/v1/production/orders/${uid}/stages/from-card`);
    await setStatus(uid, 'planned');

    const res = await mark(master.token, uid, 1, { kind: 'start' });
    expect(res.status).toBe(409);
    expect(String(res.body.error.message)).toMatch(/Запустить|не в работе/i);
  });

  it('этапа с таким номером в заказе нет', async () => {
    const uid = await running();
    const res = await mark(master.token, uid, 42, { kind: 'start' });
    expect(res.status).toBe(404);
  });

  it('кладовщик отметок не ставит', async () => {
    const uid = await running();
    const res = await mark(keeper.token, uid, 1, { kind: 'start' });
    expect(res.status).toBe(403);
    expect((await stageRows(uid))[0].status).toBe('pending');
  });
});

describe('рабочий отмечает только свои этапы', () => {
  /**
   * Рабочий — это право `production.work` без `production.manage`. Своей
   * учётки у роли в базе разработки может не быть до пересева, поэтому права
   * собираются руками: проверяется правило службы, а не чей-то логин.
   */
  const asWorker = <T>(userId: bigint, fn: () => Promise<T>) =>
    runWithContext(
      {
        userId,
        companyIds: [plantId],
        permissions: new Set(['production.view', 'production.work']),
        requestId: 'test-worker',
        source: 'web',
      } as any,
      fn,
    );

  it('свой этап отмечает, чужой — нет', async () => {
    const uid = await running({ responsibleUid: otherUid });

    await expect(
      asWorker(masterId, () => stages.mark(uid, 1, 'start')),
      'этап поручен другому',
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect((await stageRows(uid))[0].status).toBe('pending');

    const res = await asWorker(otherId, () => stages.mark(uid, 1, 'start'));
    expect(res.status, 'свой этап отмечается').toBe('running');
  });

  it('рабочий не заводит план работ', async () => {
    const uid = await makeOrder(cardedItem);
    await expect(
      asWorker(masterId, () => stages.planFromCard(uid)),
      'разворачивать этапы — не его право',
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('«мои задания» показывают свои этапы и не показывают чужие', async () => {
    const mineUid = await running({ responsibleUid: otherUid });
    const foreignUid = await running();

    const list = await asWorker(otherId, () => stages.mine(100));
    const mine = list.rows.filter((r) => r.orderUid === mineUid);
    expect(mine.length, 'свои этапы в списке есть').toBeGreaterThan(0);
    expect(mine[0].marks, 'сервер говорит, что можно нажать').toEqual(['start']);
    expect(
      list.rows.some((r) => r.orderUid === foreignUid),
      'чужой заказ в «мои задания» не попал',
    ).toBe(false);
  });

  it('закрытый этап из заданий уходит', async () => {
    const uid = await running({ responsibleUid: otherUid });
    await asWorker(otherId, () => stages.mark(uid, 1, 'start'));
    await asWorker(otherId, () => stages.mark(uid, 1, 'finish'));

    const list = await asWorker(otherId, () => stages.mine(100));
    const left = list.rows.filter((r) => r.orderUid === uid).map((r) => r.seq);
    expect(left, 'закрытый первый этап в заданиях не висит').not.toContain(1);
  });
});

describe('карточка заказа после отметок', () => {
  it('показывает ход работы: кто в работе, сколько отработано, причина паузы', async () => {
    const uid = await running();
    await mark(master.token, uid, 1, { kind: 'start' });
    await mark(master.token, uid, 1, {
      kind: 'pause',
      reasonUid: downtimeUid,
      comment: 'Нет сырья на участке',
    });

    const card = await get(master.token, `/api/v1/production/orders/${uid}`);
    const stage = card.body.data.stages[0];
    expect(stage.status).toBe('paused');
    expect(stage.pausedSince, 'видно, с какого времени стоим').toBeTruthy();
    expect(stage.pauseReasonRu, 'причина простоя названа').toBeTruthy();
    expect(stage.events.map((e: any) => e.event)).toEqual(['start', 'pause']);
    expect(card.body.data.stagesTotal ?? stage.seq).toBeTruthy();
  });

  it('заказ со всеми закрытыми этапами выпускается', async () => {
    const uid = await running();
    const total = (await stageRows(uid)).length;
    for (let seq = 1; seq <= total; seq += 1) {
      expect((await mark(master.token, uid, seq, { kind: 'start' })).status).toBe(201);
      expect((await mark(master.token, uid, seq, { kind: 'finish' })).status).toBe(201);
    }
    await produce(uid);
    expect((await setStatus(uid, 'produced')).status, 'работа сделана — можно выпускать').toBe(201);
  });
});
