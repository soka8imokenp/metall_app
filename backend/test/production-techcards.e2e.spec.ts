/**
 * Техкарты производства с версиями (ТЗ 4.1, Э2): приложение целиком, живая база.
 *
 * Карта — это норма: сколько этапов, сколько времени и сколько материала уходит
 * на единицу продукции. По ней потом развернутся этапы заказа и посчитается
 * себестоимость, поэтому главное здесь не «сохранилась ли строка», а то, ради
 * чего заведены версии: **правка действующей карты не меняет прошлую**. Заказ
 * помнит версию, по которой его считали, и вчерашняя себестоимость не должна
 * поехать от того, что сегодня поправили норму.
 *
 * Второе главное — на номенклатуре действует ровно одна карта. Две активные
 * означали бы, что при заведении заказа система выбирает норму сама и молча.
 *
 * Прибираемся удалением своих карт и заказов: `tech_card` — справочник, а не
 * журнал, append-only на нём нет. Записи журнала действий остаются.
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
import { TechCardsService } from '../src/production/tech-cards.service.js';
import { ContextMiddleware } from '../src/common/context.middleware.js';
import { EnvelopeInterceptor } from '../src/common/envelope.interceptor.js';
import { ErrorFilter } from '../src/common/error.filter.js';
import { runWithContext } from '../src/common/request-context.js';

let app: INestApplication;
let base: string;
let db: Client;
let cards: TechCardsService;

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
/** Номенклатура: своя продукция без карты, продукция с картой из посева, сырьё. */
let freshItem: string;
let seededItem: string;
let rawItem: string;
let workCenter: string;

/** Что завёл прогон: карты и заказы удаляются в конце. */
const cardTrash: string[] = [];
const orderTrash: string[] = [];
/**
 * Состояние карт посева до прогона.
 *
 * Прогон вводит свою карту в работу, а это уводит прежнюю действующую в архив
 * — и после уборки номенклатура осталась бы вовсе без нормы. Снимок и возврат
 * в конце: база разработки должна пережить проверку такой же, какой была.
 */
let cardsBefore: { uid: string; status: string }[] = [];

const day = (shift: number) => new Date(Date.now() + shift * 86_400_000).toISOString().slice(0, 10);

const post = (token: string, path: string, body?: unknown) =>
  api(path, {
    method: 'POST',
    headers: json(token),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const patch = (token: string, path: string, body: unknown) =>
  api(path, { method: 'PATCH', headers: json(token), body: JSON.stringify(body) });

/**
 * Завести карту, предварительно убрав прошлый черновик по этой номенклатуре —
 * ровно то, что служба и предлагает сделать человеку. Иначе каждый следующий
 * прогон упирался бы в хвост от предыдущего.
 */
async function makeCard(itemCode: string, over: Record<string, unknown> = {}) {
  await archiveDrafts(itemCode);
  const res = await post(master.token, '/api/v1/production/tech-cards', {
    itemCode,
    nameRu: 'Проверка нормы',
    nameUz: 'Norma tekshiruvi',
    ...over,
  });
  if (res.status === 201 && res.body?.data?.uid) cardTrash.push(res.body.data.uid);
  return res;
}

async function archiveDrafts(itemCode: string) {
  const list = await api(
    `/api/v1/production/tech-cards?status=draft&itemCode=${encodeURIComponent(itemCode)}`,
    { headers: auth(master.token) },
  );
  for (const c of list.body?.data?.rows ?? []) {
    await post(master.token, `/api/v1/production/tech-cards/${c.uid}/archive`);
  }
}

/** Обычный набор этапов и материалов: два этапа, один материал на первом. */
const filling = (itemCode: string) => ({
  stages: [
    {
      seq: 1,
      nameRu: 'Резка заготовки',
      nameUz: 'Zagotovkani kesish',
      workCenterCode: workCenter,
      normDurationMin: 45,
      wastePercent: '1.5',
    },
    { seq: 2, nameRu: 'Сварка', nameUz: 'Payvandlash', normDurationMin: 90 },
  ],
  materials: [{ itemCode, qtyPerUnit: '1.08', stageSeq: 1 }],
});

const cardRow = async (uid: string) =>
  (
    await db.query<{ version: number; status: string; name_ru: string; item_id: string }>(
      `SELECT version, status::text AS status, name_ru, item_id::text
         FROM tech_card WHERE uid = $1::uuid`,
      [uid],
    )
  ).rows[0];

const audit = async (uid: string) =>
  (
    await db.query<{ action: string; changes: any }>(
      `SELECT action, changes FROM audit_log
        WHERE entity_type = 'tech_card' AND entity_id = $1 ORDER BY occurred_at, id`,
      [uid],
    )
  ).rows;

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
  cards = app.get(TechCardsService);

  db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  master = await login('j.tashpulatov');
  keeper = await login('a.saidov');

  plantId = BigInt(
    (await db.query<{ id: string }>(`SELECT id::text FROM company WHERE code = 'plant'`)).rows[0].id,
  );
  masterId = BigInt(
    (await db.query<{ id: string }>(`SELECT id::text FROM user_account WHERE login = 'j.tashpulatov'`))
      .rows[0].id,
  );

  const pick = async (sql: string) => (await db.query<{ code: string }>(sql)).rows[0].code;
  seededItem = await pick(
    `SELECT i.code FROM tech_card tc JOIN item i ON i.id = tc.item_id
      WHERE tc.company_id = ${plantId} AND tc.status = 'active' ORDER BY tc.id LIMIT 1`,
  );
  freshItem = await pick(
    `SELECT code FROM item WHERE company_id = ${plantId} AND item_type = 'finished' AND is_active
       AND NOT track_serials
       AND id NOT IN (SELECT item_id FROM tech_card WHERE company_id = ${plantId})
     ORDER BY code LIMIT 1`,
  );
  rawItem = await pick(
    `SELECT code FROM item WHERE company_id = ${plantId} AND item_type IN ('raw', 'component')
       AND is_active ORDER BY code LIMIT 1`,
  );
  workCenter = await pick(
    `SELECT code FROM work_center WHERE company_id = ${plantId} AND is_active ORDER BY id LIMIT 1`,
  );

  cardsBefore = (
    await db.query<{ uid: string; status: string }>(
      `SELECT uid::text AS uid, status::text AS status FROM tech_card`,
    )
  ).rows;
}, 90_000);

afterAll(async () => {
  if (db) {
    if (orderTrash.length) {
      await db.query(`DELETE FROM production_order WHERE uid = ANY($1::uuid[])`, [orderTrash]);
    }
    if (cardTrash.length) {
      await db.query(`DELETE FROM tech_card WHERE uid = ANY($1::uuid[])`, [cardTrash]);
    }
    for (const c of cardsBefore) {
      await db.query(`UPDATE tech_card SET status = $2::"TechCardStatus" WHERE uid = $1::uuid`, [
        c.uid,
        c.status,
      ]);
    }
  }
  await db?.end();
  await app?.close();
});

describe('POST /production/tech-cards', () => {
  it('карта заводится черновиком: пока её не ввели в работу, она ничего не нормирует', async () => {
    const res = await makeCard(freshItem);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.status).toBe('draft');
    expect(res.body.data.version).toBe(1);

    const r = await cardRow(res.body.data.uid);
    expect(r.status).toBe('draft');

    const list = await api('/api/v1/production/tech-cards?status=active', {
      headers: auth(master.token),
    });
    expect(
      list.body.data.rows.some((c: any) => c.uid === res.body.data.uid),
      'черновик не должен числиться действующим',
    ).toBe(false);

    expect((await audit(res.body.data.uid)).map((l) => l.action)).toEqual(['create']);
  });

  it('незаконченный черновик на номенклатуре может быть только один', async () => {
    const first = await makeCard(freshItem);
    expect(first.status).toBe(201);

    const second = await post(master.token, '/api/v1/production/tech-cards', {
      itemCode: freshItem,
      nameRu: 'Второй черновик',
      nameUz: 'Ikkinchi qoralama',
    });
    // Если правило снято (а обратная поломка именно это и делает), карта
    // всё-таки заведётся — её тоже надо убрать за собой.
    if (second.status === 201) cardTrash.push(second.body.data.uid);
    expect(second.status).toBe(409);
    expect(String(second.body.error.message)).toMatch(/черновик/i);

    // Убрали прошлый — следующая версия продолжает нумерацию, а не начинает её.
    const next = await makeCard(freshItem);
    expect(next.status).toBe(201);
    expect(next.body.data.version).toBe(first.body.data.version + 1);
  });

  it('карту заводят на то, что завод производит', async () => {
    const res = await makeCard(rawItem);
    expect(res.status).toBe(422);
    expect(String(res.body.error.message)).toMatch(/производ/i);
  });

  it('кладовщик карту не заводит', async () => {
    const res = await post(keeper.token, '/api/v1/production/tech-cards', {
      itemCode: freshItem,
      nameRu: 'Нельзя',
      nameUz: 'Mumkin emas',
    });
    expect(res.status).toBe(403);
  });

  it('право просмотра карту не пишет', async () => {
    const ctx = (perms: string[]) => ({
      requestId: 'qa-tech-cards',
      userId: masterId,
      companyIds: [plantId],
      allCompanyIds: [plantId],
      permissions: new Set(perms),
      locale: 'ru' as const,
      source: 'web' as const,
    });

    await expect(
      runWithContext(ctx(['production.view']), () =>
        cards.create({ itemCode: freshItem, nameRu: 'Нельзя', nameUz: 'Mumkin emas' }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    await archiveDrafts(freshItem);
    const ok = await runWithContext(ctx(['production.view', 'production.manage']), () =>
      cards.create({ itemCode: freshItem, nameRu: 'Можно', nameUz: 'Mumkin' }),
    );
    cardTrash.push(ok.uid);
    expect(ok.status).toBe('draft');
  });
});

describe('PATCH /production/tech-cards/:uid', () => {
  it('этапы и материалы ложатся в карту и возвращаются по порядку', async () => {
    const made = await makeCard(freshItem);
    const uid = made.body.data.uid;

    const res = await patch(master.token, `/api/v1/production/tech-cards/${uid}`, filling(rawItem));
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const card = (await api(`/api/v1/production/tech-cards/${uid}`, { headers: auth(master.token) }))
      .body.data;
    expect(card.stages.map((s: any) => s.seq)).toEqual([1, 2]);
    expect(card.stages[0].workCenterCode).toBe(workCenter);
    expect(card.stages[0].normDurationMin).toBe(45);
    expect(Number(card.stages[0].wastePercent)).toBeCloseTo(1.5, 4);
    expect(card.totalDurationMin, 'норма времени по карте — сумма этапов').toBe(135);
    expect(card.materials[0].itemCode).toBe(rawItem);
    expect(Number(card.materials[0].qtyPerUnit)).toBeCloseTo(1.08, 6);
    expect(card.materials[0].stageSeq).toBe(1);

    expect((await audit(uid)).map((l) => l.action)).toEqual(['create', 'update']);
  });

  it('этапы нумеруются подряд, без дыр', async () => {
    const made = await makeCard(freshItem);
    const res = await patch(master.token, `/api/v1/production/tech-cards/${made.body.data.uid}`, {
      stages: [
        { seq: 1, nameRu: 'Первый', nameUz: 'Birinchi', normDurationMin: 10 },
        { seq: 3, nameRu: 'Третий', nameUz: 'Uchinchi', normDurationMin: 10 },
      ],
    });
    expect(res.status).toBe(422);
    expect(String(res.body.error.message)).toMatch(/подряд|1/i);
  });

  it('карта не делает сама себя: продукция не может быть своим материалом', async () => {
    const made = await makeCard(freshItem);
    const res = await patch(master.token, `/api/v1/production/tech-cards/${made.body.data.uid}`, {
      stages: [{ seq: 1, nameRu: 'Этап', nameUz: 'Bosqich', normDurationMin: 10 }],
      materials: [{ itemCode: freshItem, qtyPerUnit: '1' }],
    });
    expect(res.status).toBe(422);
  });

  it('материал нельзя повесить на этап, которого в карте нет', async () => {
    const made = await makeCard(freshItem);
    const res = await patch(master.token, `/api/v1/production/tech-cards/${made.body.data.uid}`, {
      stages: [{ seq: 1, nameRu: 'Этап', nameUz: 'Bosqich', normDurationMin: 10 }],
      materials: [{ itemCode: rawItem, qtyPerUnit: '1', stageSeq: 9 }],
    });
    expect(res.status).toBe(422);
  });

  it('норма времени и процент отхода проверяются', async () => {
    const made = await makeCard(freshItem);
    const uid = made.body.data.uid;
    const bad = async (stage: Record<string, unknown>) =>
      (
        await patch(master.token, `/api/v1/production/tech-cards/${uid}`, {
          stages: [{ seq: 1, nameRu: 'Этап', nameUz: 'Bosqich', ...stage }],
        })
      ).status;

    expect(await bad({ normDurationMin: -5 })).toBeGreaterThanOrEqual(400);
    expect(await bad({ normDurationMin: 10, wastePercent: '150' })).toBeGreaterThanOrEqual(400);
    expect(await bad({ normDurationMin: 10, workCenterCode: 'НЕТ-ТАКОГО' })).toBe(422);
  });
});

describe('версии и ввод в работу', () => {
  it('в работе у номенклатуры ровно одна карта: прежняя уходит в архив', async () => {
    const made = await makeCard(seededItem);
    const uid = made.body.data.uid;
    await patch(master.token, `/api/v1/production/tech-cards/${uid}`, filling(rawItem));

    const res = await post(master.token, `/api/v1/production/tech-cards/${uid}/activate`);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.status).toBe('active');

    const live = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM tech_card tc JOIN item i ON i.id = tc.item_id
        WHERE i.code = $1 AND tc.status = 'active'`,
      [seededItem],
    );
    expect(live.rows[0].n, 'действующая карта на номенклатуре одна').toBe('1');

    expect((await audit(uid)).map((l) => l.action)).toContain('activate');
  });

  it('карта говорит, с какого момента она норма', async () => {
    const made = await makeCard(freshItem);
    const uid = made.body.data.uid;

    const draft = await api(`/api/v1/production/tech-cards/${uid}`, { headers: auth(master.token) });
    expect(draft.body.data.validFrom, 'черновик ещё не норма').toBeNull();

    await patch(master.token, `/api/v1/production/tech-cards/${uid}`, filling(rawItem));
    const before = Date.now();
    await post(master.token, `/api/v1/production/tech-cards/${uid}/activate`);

    const live = await api(`/api/v1/production/tech-cards/${uid}`, { headers: auth(master.token) });
    expect(live.body.data.validFrom, 'введена в работу — дата есть').toBeTruthy();
    const from = new Date(live.body.data.validFrom).getTime();
    expect(from, 'дата — момент ввода в работу, не посев').toBeGreaterThanOrEqual(before - 60_000);

    // Уход в архив по вводу следующей версии дату начала не стирает.
    const next = await post(master.token, `/api/v1/production/tech-cards/${uid}/new-version`);
    const nextUid = next.body.data.uid as string;
    cardTrash.push(nextUid);
    await post(master.token, `/api/v1/production/tech-cards/${nextUid}/activate`);
    const pushedOut = await api(`/api/v1/production/tech-cards/${uid}`, {
      headers: auth(master.token),
    });
    expect(pushedOut.body.data.status).toBe('archived');
    expect(pushedOut.body.data.validFrom, 'прежняя версия помнит, с какого дня работала').toBe(
      live.body.data.validFrom,
    );

    // И уход в архив вручную — тоже.
    const nextFrom = (
      await api(`/api/v1/production/tech-cards/${nextUid}`, { headers: auth(master.token) })
    ).body.data.validFrom;
    await post(master.token, `/api/v1/production/tech-cards/${nextUid}/archive`);
    const archived = await api(`/api/v1/production/tech-cards/${nextUid}`, {
      headers: auth(master.token),
    });
    expect(archived.body.data.validFrom, 'в архиве дата начала остаётся').toBe(nextFrom);
  });

  it('пустую карту в работу не вводят', async () => {
    const made = await makeCard(freshItem);
    const res = await post(
      master.token,
      `/api/v1/production/tech-cards/${made.body.data.uid}/activate`,
    );
    expect(res.status).toBe(409);
    expect(String(res.body.error.message)).toMatch(/этап/i);
  });

  it('действующую карту не правят — поднимают версию, и прошлая остаётся прежней', async () => {
    const made = await makeCard(freshItem);
    const uid = made.body.data.uid;
    await patch(master.token, `/api/v1/production/tech-cards/${uid}`, filling(rawItem));
    await post(master.token, `/api/v1/production/tech-cards/${uid}/activate`);

    const refused = await patch(master.token, `/api/v1/production/tech-cards/${uid}`, {
      nameRu: 'Правка на ходу',
    });
    expect(refused.status).toBe(409);
    expect(String(refused.body.error.message)).toMatch(/Поднимите версию/i);

    const next = await post(master.token, `/api/v1/production/tech-cards/${uid}/new-version`);
    expect(next.status).toBe(201);
    cardTrash.push(next.body.data.uid);
    expect(next.body.data.status).toBe('draft');
    expect(next.body.data.version).toBe(made.body.data.version + 1);

    // Копия пришла со всем содержимым, иначе «новая версия» означала бы
    // «заведите карту заново».
    const copy = (
      await api(`/api/v1/production/tech-cards/${next.body.data.uid}`, {
        headers: auth(master.token),
      })
    ).body.data;
    expect(copy.stages.length).toBe(2);
    expect(copy.materials.length).toBe(1);

    await patch(master.token, `/api/v1/production/tech-cards/${next.body.data.uid}`, {
      stages: [{ seq: 1, nameRu: 'Только один этап', nameUz: 'Bitta bosqich', normDurationMin: 5 }],
      materials: [],
    });

    const old = (await api(`/api/v1/production/tech-cards/${uid}`, { headers: auth(master.token) }))
      .body.data;
    expect(old.stages.length, 'прошлая версия не поехала').toBe(2);
    expect(old.totalDurationMin).toBe(135);
    expect((await audit(next.body.data.uid)).map((l) => l.action)).toContain('version');
  });

  it('архив вместо удаления', async () => {
    const made = await makeCard(freshItem);
    const uid = made.body.data.uid;
    const res = await post(master.token, `/api/v1/production/tech-cards/${uid}/archive`);
    expect(res.status).toBe(201);
    expect((await cardRow(uid)).status).toBe('archived');

    const del = await api(`/api/v1/production/tech-cards/${uid}`, {
      method: 'DELETE',
      headers: auth(master.token),
    });
    expect(del.status, 'удаления карт не бывает').toBe(404);
  });
});

describe('заказ и версия карты', () => {
  it('заказ берёт действующую карту и запоминает её версию', async () => {
    const made = await makeCard(freshItem);
    const cardUid = made.body.data.uid;
    await patch(master.token, `/api/v1/production/tech-cards/${cardUid}`, filling(rawItem));
    await post(master.token, `/api/v1/production/tech-cards/${cardUid}/activate`);
    const version = made.body.data.version;

    const order = await post(master.token, '/api/v1/production/orders', {
      itemCode: freshItem,
      qtyPlanned: '5',
      dueDate: day(9),
    });
    expect(order.status, JSON.stringify(order.body)).toBe(201);
    orderTrash.push(order.body.data.uid);

    const card = (
      await api(`/api/v1/production/orders/${order.body.data.uid}`, { headers: auth(master.token) })
    ).body.data;
    expect(card.techCardVersion).toBe(version);

    // Подняли версию и ввели её в работу — у заведённого заказа норма прежняя.
    const next = await post(master.token, `/api/v1/production/tech-cards/${cardUid}/new-version`);
    cardTrash.push(next.body.data.uid);
    await post(master.token, `/api/v1/production/tech-cards/${next.body.data.uid}/activate`);

    const again = (
      await api(`/api/v1/production/orders/${order.body.data.uid}`, { headers: auth(master.token) })
    ).body.data;
    expect(again.techCardVersion, 'заказ считают по той норме, по которой завели').toBe(version);

    const fresh = await post(master.token, '/api/v1/production/orders', {
      itemCode: freshItem,
      qtyPlanned: '5',
      dueDate: day(9),
    });
    orderTrash.push(fresh.body.data.uid);
    const freshCard = (
      await api(`/api/v1/production/orders/${fresh.body.data.uid}`, { headers: auth(master.token) })
    ).body.data;
    expect(freshCard.techCardVersion, 'новый заказ берёт действующую норму').toBe(version + 1);
  });

  it('карты в архиве и в черновике норму заказу не дают', async () => {
    // Номенклатуру готовим сами: архивируем всё действующее, а черновики и
    // архив по ней остаются от прошлых проверок. Если заказ начнёт хватать
    // карту «любую, какая есть», он посчитается по норме, которую отменили.
    const all = await api(
      `/api/v1/production/tech-cards?itemCode=${encodeURIComponent(freshItem)}`,
      { headers: auth(master.token) },
    );
    for (const c of all.body.data.rows) {
      if (c.status === 'active') {
        await post(master.token, `/api/v1/production/tech-cards/${c.uid}/archive`);
      }
    }
    const left = (
      await api(`/api/v1/production/tech-cards?itemCode=${encodeURIComponent(freshItem)}`, {
        headers: auth(master.token),
      })
    ).body.data.rows;
    expect(left.length, 'карты по номенклатуре должны остаться — иначе проверять нечего').toBeGreaterThan(0);
    expect(left.every((c: any) => c.status !== 'active')).toBe(true);

    const order = await post(master.token, '/api/v1/production/orders', {
      itemCode: freshItem,
      qtyPlanned: '3',
      dueDate: day(9),
    });
    expect(order.status).toBe(201);
    orderTrash.push(order.body.data.uid);
    const card = (
      await api(`/api/v1/production/orders/${order.body.data.uid}`, { headers: auth(master.token) })
    ).body.data;
    expect(card.techCardVersion, 'отменённая норма в заказ не попадает').toBeNull();
  });
});

describe('GET /production/tech-cards', () => {
  it('список показывает версию, состояние, число этапов и норму времени', async () => {
    const res = await api('/api/v1/production/tech-cards', { headers: auth(master.token) });
    expect(res.status).toBe(200);
    expect(res.body.data.rows.length).toBeGreaterThan(0);
    for (const c of res.body.data.rows) {
      expect(typeof c.itemCode).toBe('string');
      expect(typeof c.version).toBe('number');
      expect(['draft', 'active', 'archived']).toContain(c.status);
      expect(c.stagesCount).toBeGreaterThanOrEqual(0);
      expect(c.totalDurationMin).toBeGreaterThanOrEqual(0);
    }
  });

  it('кладовщик карты читает (ему по ним выдавать), но норму не правит', async () => {
    // Право `production.view` у кладовщика появилось вместе с материалами:
    // без него он не знает, что и подо что выдаёт. Менять норму всё равно
    // нельзя — это дело цеха.
    const res = await api('/api/v1/production/tech-cards', { headers: auth(keeper.token) });
    expect(res.status).toBe(200);

    const create = await post(keeper.token, '/api/v1/production/tech-cards', {
      itemCode: freshItem,
      stages: [{ seq: 1, name: 'Сам придумал', workCenterCode: null, normDurationMin: 10 }],
    });
    expect(create.status, 'кладовщик не заводит техкарту').toBe(403);

    const any = res.body.data.rows[0];
    const edit = await api(`/api/v1/production/tech-cards/${any.uid}`, {
      method: 'PATCH',
      headers: { ...auth(keeper.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: 'правка кладовщика' }),
    });
    expect(edit.status, 'кладовщик не правит техкарту').toBe(403);
  });
});
