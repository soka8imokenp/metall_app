/**
 * Жизненный цикл заказа на производство: приложение целиком, живая база.
 *
 * До этой работы в производстве не было ни одного действия: заказы можно было
 * только смотреть. Здесь проверяется не «ответил ли сервер 201», а то, ради
 * чего переход статуса вообще делают действием, а не полем: перескок через
 * статус отбивается, выпуск не ставится поверх незавершённого этапа, отмена не
 * стирает уже выпущенное, пауза без причины не принимается, и каждый шаг
 * остаётся в журнале с парой «было → стало».
 *
 * Прибираемся удалением своих заказов: `production_order` — не журнал, триггера
 * append-only на нём нет, а оставлять в демо-данных десяток заказов «QA» хуже.
 * Записи журнала при этом остаются: действие правда было.
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
import { ProductionWriteService } from '../src/production/write.service.js';
import { ContextMiddleware } from '../src/common/context.middleware.js';
import { EnvelopeInterceptor } from '../src/common/envelope.interceptor.js';
import { ErrorFilter } from '../src/common/error.filter.js';
import { runWithContext } from '../src/common/request-context.js';

let app: INestApplication;
let base: string;
let db: Client;
let write: ProductionWriteService;

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
const json = (token: string, companyUids?: string[]) => ({
  ...auth(token, companyUids),
  'Content-Type': 'application/json',
});

/** Мастер цеха — он и ведёт производство. Директор видит обе компании. */
let master: Awaited<ReturnType<typeof login>>;
let director: Awaited<ReturnType<typeof login>>;
let keeper: Awaited<ReturnType<typeof login>>;

let plantId: bigint;
let masterId: bigint;
let masterUid: string;
/** Что завод правда производит и что он только продаёт. */
let finishedCode: string;
let serialCode: string;
let boughtCode: string;

/** Заказы, заведённые прогоном: удаляются в конце. */
const trash: string[] = [];

const day = (shift: number) =>
  new Date(Date.now() + shift * 86_400_000).toISOString().slice(0, 10);

async function create(
  token: string,
  body: Record<string, unknown>,
  companyUids?: string[],
) {
  const res = await api('/api/v1/production/orders', {
    method: 'POST',
    headers: json(token, companyUids),
    body: JSON.stringify(body),
  });
  if (res.status === 201 && res.body?.data?.uid) trash.push(res.body.data.uid);
  return res;
}

/** Обычный пригодный заказ: количество, срок и настоящая продукция завода. */
const sample = (over: Record<string, unknown> = {}) => ({
  itemCode: finishedCode,
  qtyPlanned: '12.5',
  dueDate: day(10),
  priority: 5,
  ...over,
});

const setStatus = (token: string, uid: string, status: string, comment?: string) =>
  api(`/api/v1/production/orders/${uid}/status`, {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify({ status, ...(comment ? { comment } : {}) }),
  });

const patch = (token: string, uid: string, body: Record<string, unknown>) =>
  api(`/api/v1/production/orders/${uid}`, {
    method: 'PATCH',
    headers: json(token),
    body: JSON.stringify(body),
  });

/**
 * Дать заказу этап перед запуском.
 *
 * С Э3 запуск без этапов отбивается: цеху нечего отмечать. Здесь проверяется
 * путь заказа, а не разворачивание плана работ, поэтому этап ставится одной
 * строкой — своё правило про этапы проверяет `production-stages.e2e`.
 */
const giveStage = (uid: string, status: 'pending' | 'done' = 'pending', name = 'Резка заготовки') =>
  db.query(
    `INSERT INTO production_stage (production_order_id, seq, name_ru, name_uz, status)
     SELECT id, 1, $2, 'Zagotovkani kesish', $3::"StageStatus"
       FROM production_order WHERE uid = $1::uuid`,
    [uid, name, status],
  );

const row = async (uid: string) =>
  (
    await db.query<{
      number: string;
      status: string;
      qty_planned: string;
      due_date: string;
      priority: number;
      responsible_id: string | null;
      created_by: string | null;
      started_at: string | null;
      finished_at: string | null;
      closed_at: string | null;
      version: number;
    }>(
      `SELECT number, status::text AS status, qty_planned::text, due_date::text,
              priority, responsible_id::text, created_by::text,
              started_at::text, finished_at::text, closed_at::text, version
         FROM production_order WHERE uid = $1::uuid`,
      [uid],
    )
  ).rows[0];

const audit = async (uid: string) =>
  (
    await db.query<{ action: string; changes: any; source: string }>(
      `SELECT action, changes, source::text AS source FROM audit_log
        WHERE entity_type = 'production_order' AND entity_id = $1
        ORDER BY occurred_at, id`,
      [uid],
    )
  ).rows;

/** Выпуск по заказу — отдельная проверка; здесь важен только переход. */
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
  write = app.get(ProductionWriteService);

  db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  master = await login('j.tashpulatov');
  director = await login('s.radjabov');
  keeper = await login('a.saidov');

  const plant = await db.query<{ id: string }>(`SELECT id::text FROM company WHERE code = 'plant'`);
  plantId = BigInt(plant.rows[0].id);

  const me = await db.query<{ id: string; uid: string }>(
    `SELECT id::text, uid::text FROM user_account WHERE login = 'j.tashpulatov'`,
  );
  masterId = BigInt(me.rows[0].id);
  masterUid = me.rows[0].uid;

  const pick = async (sql: string) => (await db.query<{ code: string }>(sql)).rows[0].code;
  finishedCode = await pick(
    `SELECT code FROM item WHERE company_id = ${plantId} AND item_type = 'finished'
       AND NOT track_serials AND is_active ORDER BY code LIMIT 1`,
  );
  serialCode = await pick(
    `SELECT code FROM item WHERE company_id = ${plantId} AND item_type = 'finished'
       AND track_serials AND is_active ORDER BY code LIMIT 1`,
  );
  // Покупное у завода — сырьё: его привозят и расходуют, а не производят.
  boughtCode = await pick(
    `SELECT code FROM item WHERE company_id = ${plantId} AND item_type = 'raw'
       AND is_active ORDER BY code LIMIT 1`,
  );
}, 90_000);

afterAll(async () => {
  if (db && trash.length > 0) {
    await db.query(`DELETE FROM production_stage WHERE production_order_id IN
                      (SELECT id FROM production_order WHERE uid = ANY($1::uuid[]))`, [trash]);
    await db.query(`DELETE FROM production_order WHERE uid = ANY($1::uuid[])`, [trash]);
  }
  await db?.end();
  await app?.close();
});

describe('POST /production/orders', () => {
  it('мастер заводит заказ: номер по порядку, черновик и запись в журнале', async () => {
    const res = await create(master.token, sample({ responsibleUid: masterUid }));

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.number).toMatch(/^ПР-\d{5}$/);
    expect(res.body.data.status).toBe('draft');

    const r = await row(res.body.data.uid);
    expect(r.qty_planned).toBe('12.500000');
    expect(r.due_date).toBe(day(10));
    expect(r.priority).toBe(5);
    expect(r.responsible_id).toBe(String(masterId));
    expect(r.created_by, 'кто завёл — в самом заказе').toBe(String(masterId));
    expect(r.started_at, 'черновик ещё не в работе').toBeNull();

    const log = await audit(res.body.data.uid);
    expect(log.map((l) => l.action)).toEqual(['create']);
    expect(log[0].changes.number.to).toBe(res.body.data.number);
  });

  it('номер не повторяется, когда заказы заводят одновременно', async () => {
    // Пять отправок разом, а не две: на `(company_id, number)` стоит
    // уникальный индекс, и без блокировки номера часть заказов упала бы
    // человеку в лицо ошибкой базы.
    const made = await Promise.all(Array.from({ length: 5 }, () => create(master.token, sample())));
    expect(made.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
    const numbers = made.map((r) => r.body.data.number);
    expect(new Set(numbers).size, `номера: ${numbers.join(', ')}`).toBe(5);
  });

  it('количество нулём не принимается, а дата — только ГГГГ-ММ-ДД', async () => {
    const zero = await create(master.token, sample({ qtyPlanned: '0' }));
    expect(zero.status).toBe(422);
    const bad = await create(master.token, sample({ dueDate: '31.12.2026' }));
    expect(bad.status).toBe(400);
  });

  it('то, что завод не производит, в заказ не встаёт', async () => {
    const res = await create(master.token, sample({ itemCode: boughtCode }));
    expect(res.status).toBe(422);
    expect(String(res.body.error.message)).toMatch(/производ/i);
  });

  it('штучную продукцию заказывают целыми штуками', async () => {
    const res = await create(master.token, sample({ itemCode: serialCode, qtyPlanned: '2.5' }));
    expect(res.status).toBe(422);
  });

  it('кладовщик заказ на производство завести не может', async () => {
    const res = await create(keeper.token, sample());
    expect(res.status).toBe(403);
  });

  it('в торговом доме заводской продукции нет: заказ там не рождается', async () => {
    const trade = director.companies.find((c) => c.code === 'trade')!;
    const res = await create(director.token, sample(), [trade.uid]);
    expect(res.status).toBe(422);
  });

  it('право просмотра записывать не разрешает', async () => {
    const ctx = (perms: string[]) => ({
      requestId: 'qa-production-write',
      userId: masterId,
      companyIds: [plantId],
      allCompanyIds: [plantId],
      permissions: new Set(perms),
      locale: 'ru' as const,
      source: 'web' as const,
    });

    await expect(
      runWithContext(ctx(['production.view']), () =>
        write.create({ itemCode: finishedCode, qtyPlanned: '1', dueDate: day(5) }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const ok = await runWithContext(ctx(['production.view', 'production.manage']), () =>
      write.create({ itemCode: finishedCode, qtyPlanned: '1', dueDate: day(5) }),
    );
    trash.push(ok.uid);
    expect(ok.status).toBe('draft');
  });
});

describe('PATCH /production/orders/:uid', () => {
  it('черновик правится, и правка ложится в журнал парой было → стало', async () => {
    const made = await create(master.token, sample());
    const uid = made.body.data.uid;

    const res = await patch(master.token, uid, { qtyPlanned: '20', priority: 1 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const r = await row(uid);
    expect(r.qty_planned).toBe('20.000000');
    expect(r.priority).toBe(1);
    expect(r.version).toBe(2);

    const log = await audit(uid);
    expect(log.map((l) => l.action)).toEqual(['create', 'update']);
    expect(log[1].changes.qtyPlanned).toEqual({ from: '12.500000', to: '20.000000' });
  });

  it('примечание стирается, а ответственный возвращается в карточку', async () => {
    const made = await create(
      master.token,
      sample({ responsibleUid: masterUid, comment: 'Под заказ ТД, срочно' }),
    );
    const uid = made.body.data.uid;

    const card = await api(`/api/v1/production/orders/${uid}`, { headers: auth(master.token) });
    expect(card.body.data.comment).toBe('Под заказ ТД, срочно');
    expect(card.body.data.statusReason, 'переходов ещё не было').toBeNull();
    expect(card.body.data.responsibleUid, 'иначе форма правки снимет ответственного').toBe(
      masterUid,
    );

    // Пустое поле из формы — это «стереть», а не «не трогай».
    expect((await patch(master.token, uid, { comment: '' })).status).toBe(200);
    const after = await api(`/api/v1/production/orders/${uid}`, { headers: auth(master.token) });
    expect(after.body.data.comment).toBeNull();

    expect((await patch(master.token, uid, { responsibleUid: '' })).status).toBe(200);
    expect((await row(uid)).responsible_id).toBeNull();
  });

  it('запланированный заказ правке не поддаётся: его уже увидел цех', async () => {
    const made = await create(master.token, sample());
    const uid = made.body.data.uid;
    expect((await setStatus(master.token, uid, 'planned')).status).toBe(201);

    const res = await patch(master.token, uid, { qtyPlanned: '30' });
    expect(res.status).toBe(409);
    expect(String(res.body.error.message)).toMatch(/черновик/i);
  });
});

describe('POST /production/orders/:uid/status', () => {
  it('путь заказа: план → работа → выпуск → закрытие, и каждый шаг в журнале', async () => {
    const made = await create(master.token, sample());
    const uid = made.body.data.uid;

    await giveStage(uid, 'done');
    await produce(uid);

    for (const next of ['planned', 'in_progress', 'produced', 'closed']) {
      const res = await setStatus(master.token, uid, next);
      expect(res.status, `${next}: ${JSON.stringify(res.body)}`).toBe(201);
      expect(res.body.data.status).toBe(next);
    }

    const r = await row(uid);
    expect(r.status).toBe('closed');
    expect(r.started_at, 'запуск отметил время').not.toBeNull();
    expect(r.finished_at, 'выпуск отметил время').not.toBeNull();
    expect(r.closed_at, 'закрытие отметило время').not.toBeNull();

    const log = await audit(uid);
    // Закрытие заодно считает себестоимость (ТЗ 4.7): расчёт встаёт в журнал
    // перед самим закрытием, потому что считают закрываемый заказ.
    expect(log.map((l) => l.action)).toEqual([
      'create',
      'status',
      'status',
      'status',
      'cost.calculate',
      'status',
    ]);
    expect(log[1].changes.status).toEqual({ from: 'draft', to: 'planned' });

    const card = await api(`/api/v1/production/orders/${uid}`, { headers: auth(master.token) });
    expect(card.body.data.nextStatuses, 'из закрытого хода нет').toEqual([]);
    expect(card.body.data.canEdit).toBe(false);
  });

  it('перескок через статус отбивается и говорит, куда можно', async () => {
    const made = await create(master.token, sample());
    const res = await setStatus(master.token, made.body.data.uid, 'produced');
    expect(res.status).toBe(409);
    expect(String(res.body.error.message)).toMatch(/planned/);
  });

  it('пауза без причины не принимается, с причиной — попадает в журнал', async () => {
    const made = await create(master.token, sample());
    const uid = made.body.data.uid;
    await giveStage(uid);
    await setStatus(master.token, uid, 'planned');
    await setStatus(master.token, uid, 'in_progress');

    const blank = await setStatus(master.token, uid, 'paused');
    expect(blank.status).toBe(422);
    expect(String(blank.body.error.message)).toMatch(/причин/i);

    const ok = await setStatus(master.token, uid, 'paused', 'Нет заготовки на участке');
    expect(ok.status).toBe(201);
    const log = await audit(uid);
    expect(log.at(-1)!.changes.comment.to).toBe('Нет заготовки на участке');

    // Причина остановки и примечание заказа — разные вещи. Причина приходит в
    // карточку отдельным полем, а «зачем этот заказ» остаётся на месте:
    // затирать одно другим значит терять то, что написали при заведении.
    const card = await api(`/api/v1/production/orders/${uid}`, { headers: auth(master.token) });
    expect(card.body.data.statusReason).toBe('Нет заготовки на участке');
    expect(typeof card.body.data.statusReasonAt).toBe('string');
    expect(card.body.data.comment, 'примечание заказа не затёрто причиной').toBeNull();

    // С паузы заказ возвращается в работу, и время запуска не переписывается.
    const before = await row(uid);
    expect((await setStatus(master.token, uid, 'in_progress')).status).toBe(201);
    expect((await row(uid)).started_at).toBe(before.started_at);
  });

  it('заказ с незавершённым этапом выпустить нельзя', async () => {
    const made = await create(master.token, sample());
    const uid = made.body.data.uid;
    await giveStage(uid);
    await setStatus(master.token, uid, 'planned');
    await setStatus(master.token, uid, 'in_progress');

    const stuck = await setStatus(master.token, uid, 'produced');
    expect(stuck.status).toBe(409);
    expect(String(stuck.body.error.message)).toMatch(/Резка заготовки/);

    await db.query(
      `UPDATE production_stage SET status = 'done'
        WHERE production_order_id = (SELECT id FROM production_order WHERE uid = $1::uuid)`,
      [uid],
    );
    await produce(uid);
    expect((await setStatus(master.token, uid, 'produced')).status).toBe(201);
  });

  it('отменить заказ, по которому уже есть выпуск, нельзя', async () => {
    const made = await create(master.token, sample());
    const uid = made.body.data.uid;
    await giveStage(uid);
    await setStatus(master.token, uid, 'planned');
    await setStatus(master.token, uid, 'in_progress');

    await db.query(
      `UPDATE production_order SET qty_produced = 5 WHERE uid = $1::uuid`,
      [uid],
    );
    const no = await setStatus(master.token, uid, 'cancelled', 'Заказчик снял заявку');
    expect(no.status).toBe(409);
    expect(String(no.body.error.message)).toMatch(/выпуск/i);

    await db.query(`UPDATE production_order SET qty_produced = 0 WHERE uid = $1::uuid`, [uid]);
    const blank = await setStatus(master.token, uid, 'cancelled');
    expect(blank.status, 'отмена без причины не проходит').toBe(422);
    expect((await setStatus(master.token, uid, 'cancelled', 'Заказчик снял заявку')).status).toBe(
      201,
    );
    expect((await row(uid)).status).toBe('cancelled');
  });

  it('кладовщик статус заказа не меняет', async () => {
    const made = await create(master.token, sample());
    const res = await setStatus(keeper.token, made.body.data.uid, 'planned');
    expect(res.status).toBe(403);
    expect((await row(made.body.data.uid)).status, 'отбитое нажатие ничего не записало').toBe(
      'draft',
    );
  });
});

describe('GET /production/options', () => {
  it('форма заведения берёт продукцию и ответственных с сервера', async () => {
    const res = await api('/api/v1/production/options', { headers: auth(master.token) });
    expect(res.status).toBe(200);

    const codes = res.body.data.items.map((i: any) => i.code);
    expect(codes).toContain(finishedCode);
    expect(codes, 'то, что завод покупает, в список продукции не попадает').not.toContain(boughtCode);

    const uids = res.body.data.responsibles.map((u: any) => u.uid);
    expect(uids, 'мастер цеха — свой же ответственный').toContain(masterUid);

    // Техкарту заводят на том же экране: ей нужны участки и то, из чего делают.
    expect(res.body.data.workCenters.length, 'участки для этапов карты').toBeGreaterThan(0);
    expect(typeof res.body.data.workCenters[0].code).toBe('string');
    const materials = res.body.data.materials.map((m: any) => m.code);
    expect(materials, 'в материалы попадает и покупное').toContain(boughtCode);
    expect(res.body.data.materials[0].unit, 'единица измерения материала').toBeTruthy();
  });
});
