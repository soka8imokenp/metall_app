/**
 * CRM Э7 — справочники на запись (ТЗ 8.3, 8.4).
 *
 * Проверяем правила, ради которых этап делался: использованный справочник
 * выключается, а не удаляется; правка, меняющая смысл записанного (код стадии,
 * канал источника), отклоняется; последнюю строку выключить нельзя, иначе
 * форма, из которой её выбирают, перестанет работать; порядок стадий задаётся
 * списком целиком, а конечные всегда последние; выключенная строка не
 * предлагается в формах, но остаётся у тех, кто по ней уже записан; тип задачи
 * решает, какой активностью она ляжет в ленту клиента; запись закрыта правом
 * `refs.edit`.
 *
 * Прогон пишет и за собой убирает.
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
import { CrmModule } from '../src/crm/crm.module.js';
import { ContextMiddleware } from '../src/common/context.middleware.js';
import { EnvelopeInterceptor } from '../src/common/envelope.interceptor.js';
import { ErrorFilter } from '../src/common/error.filter.js';

let app: INestApplication;
let base: string;
let db: Client;

const PASSWORD = process.env.SEED_PASSWORD ?? 'metall-dev-2026';

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as any) : null };
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
  return res.body.data as { token: string; permissions: string[]; companies: any[] };
}

let admin: Awaited<ReturnType<typeof login>>;
let keeper: Awaited<ReturnType<typeof login>>;
let tradeUid: string;

const head = (s: Awaited<ReturnType<typeof login>>, companyUid?: string) => ({
  Authorization: `Bearer ${s.token}`,
  'Content-Type': 'application/json',
  ...(companyUid ? { 'X-Company-Id': companyUid } : {}),
});

const get = (path: string, s: typeof admin, companyUid = tradeUid) =>
  api(path, { headers: head(s, companyUid) });
const post = (path: string, s: typeof admin, body: unknown, companyUid = tradeUid) =>
  api(path, { method: 'POST', headers: head(s, companyUid), body: JSON.stringify(body) });
const patch = (path: string, s: typeof admin, body: unknown, companyUid = tradeUid) =>
  api(path, { method: 'PATCH', headers: head(s, companyUid), body: JSON.stringify(body) });
const del = (path: string, s: typeof admin, companyUid = tradeUid) =>
  api(path, { method: 'DELETE', headers: head(s, companyUid) });

const stamp = Date.now().toString().slice(-6);

/** Что завели за прогон — убираем в обратном порядке. */
const madeStages: string[] = [];
const madeSources: string[] = [];
const madeReasons: string[] = [];
const madeTypes: string[] = [];
const madeTasks: string[] = [];
/** Что выключили по ходу проверок — включаем обратно даже после падения. */
const turnedOff = { stages: [] as string[], lostReasons: [] as string[], taskTypes: [] as string[] };

let partnerUid: string;

const refs = async () => (await get('/api/v1/crm/refs?all=true', admin)).body.data;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [PrismaModule, AuthModule, CrmModule],
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

  admin = await login('admin');
  keeper = await login('a.saidov');
  tradeUid = admin.companies.find((c: any) => c.code === 'trade').uid;

  const p = await db.query<{ uid: string }>(
    `SELECT p.uid FROM partner p JOIN company c ON c.id = p.company_id
      WHERE c.code = 'trade' AND p.is_client ORDER BY p.id LIMIT 1`,
  );
  partnerUid = p.rows[0]!.uid;
}, 60_000);

afterAll(async () => {
  if (db) {
    await db.query(`UPDATE deal_lost_reason SET is_active = true WHERE uid = ANY($1::uuid[])`, [
      turnedOff.lostReasons,
    ]);
    await db.query(`UPDATE deal_stage SET is_active = true WHERE uid = ANY($1::uuid[])`, [
      turnedOff.stages,
    ]);
    await db.query(`UPDATE crm_task_type SET is_active = true WHERE uid = ANY($1::uuid[])`, [
      turnedOff.taskTypes,
    ]);
  }
  for (const uid of madeTasks) {
    await db?.query(
      'DELETE FROM crm_activity WHERE task_id IN (SELECT id FROM crm_task WHERE uid = $1)',
      [uid],
    );
    await db?.query('DELETE FROM crm_task WHERE uid = $1', [uid]);
  }
  for (const uid of madeTypes) await db?.query('DELETE FROM crm_task_type WHERE uid = $1', [uid]);
  for (const uid of madeReasons) await db?.query('DELETE FROM deal_lost_reason WHERE uid = $1', [uid]);
  for (const uid of madeSources) await db?.query('DELETE FROM lead_source WHERE uid = $1', [uid]);
  for (const uid of madeStages) await db?.query('DELETE FROM deal_stage WHERE uid = $1', [uid]);
  await db?.end();
  await app?.close();
});

describe('справочник виден целиком, со счётчиками использования', () => {
  it('четыре раздела и число записей, в которых строка участвует', async () => {
    const d = await refs();
    expect(d.stages.length).toBeGreaterThan(0);
    expect(d.sources.length).toBeGreaterThan(0);
    expect(d.lostReasons.length).toBeGreaterThan(0);
    expect(d.taskTypes.length).toBeGreaterThan(0);

    // Счётчик — это то, ради чего справочник вообще показывают: по нему видно,
    // что выключать, а что ещё живо.
    const used = d.stages.find((s: any) => s.usage.deals > 0);
    expect(used, 'ни по одной стадии нет сделок — проверять нечего').toBeTruthy();
    expect(used.usage.events).toBeGreaterThan(0);

    const callType = d.taskTypes.find((t: any) => t.code === 'call');
    expect(callType.activityKind).toBe('call');
  });
});

describe('стадии воронки (ТЗ 8.3)', () => {
  it('новая стадия встаёт перед конечными, а не после «выиграна»', async () => {
    const res = await post('/api/v1/crm/refs/stages', admin, {
      companyUid: tradeUid,
      code: `qa-stage-${stamp}`,
      nameRu: `QA Замер ${stamp}`,
      probabilityDefault: 45,
    });
    expect(res.status).toBe(201);
    madeStages.push(res.body.data.uid);

    const list = (await refs()).stages.filter((s: any) => s.company.uid === tradeUid);
    const mine = list.find((s: any) => s.uid === res.body.data.uid);
    const finals = list.filter((s: any) => s.isFinal);
    expect(mine.isFinal).toBe(false);
    expect(mine.probabilityDefault).toBe(45);
    for (const f of finals) expect(f.seq).toBeGreaterThan(mine.seq);

    // Порядок пересчитан ровно, без дырок и повторов.
    const seqs = list.map((s: any) => s.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect([...seqs].sort((a: number, b: number) => a - b)).toEqual(seqs);
  });

  it('стадию со сделками не удалить — 409 с числом сделок и переходов', async () => {
    const list = (await refs()).stages;
    const used = list.find((s: any) => s.usage.deals > 0 && !s.isFinal);
    const res = await del(`/api/v1/crm/refs/stages/${used.uid}`, admin);
    expect(res.status).toBe(409);
    expect(res.body.error.details.deals).toBe(used.usage.deals);
    expect(res.body.error.message).toContain('выключить');
  });

  it('стадию с открытыми сделками не выключить — они пропали бы с доски', async () => {
    const list = (await refs()).stages;
    const busy = list.find((s: any) => s.usage.openDeals > 0 && !s.isFinal);
    const res = await patch(`/api/v1/crm/refs/stages/${busy.uid}`, admin, { isActive: false });
    expect(res.status).toBe(409);
    expect(res.body.error.details.openDeals).toBe(busy.usage.openDeals);
  });

  it('конечную стадию не выключить и не удалить: в неё закрываются сделки', async () => {
    const won = (await refs()).stages.find((s: any) => s.code === 'won' && s.company.uid === tradeUid);
    expect((await patch(`/api/v1/crm/refs/stages/${won.uid}`, admin, { isActive: false })).status).toBe(422);
    expect((await del(`/api/v1/crm/refs/stages/${won.uid}`, admin)).status).toBe(422);
  });

  it('код стадии, по которой ходили сделки, не меняется — по нему читается след', async () => {
    const used = (await refs()).stages.find((s: any) => s.usage.events > 0 && !s.isFinal);
    const res = await patch(`/api/v1/crm/refs/stages/${used.uid}`, admin, { code: `qa-new-${stamp}` });
    expect(res.status).toBe(409);
    expect(res.body.error.details.events).toBe(used.usage.events);

    // А название меняется: это подпись, а не смысл записанного.
    const renamed = await patch(`/api/v1/crm/refs/stages/${used.uid}`, admin, {
      nameRu: `${used.nameRu} `,
    });
    expect(renamed.status).toBe(200);
  });

  it('порядок задаётся списком целиком; неполный список отклоняется', async () => {
    const before = (await refs()).stages.filter(
      (s: any) => s.company.uid === tradeUid && !s.isFinal,
    );
    const uids = before.map((s: any) => s.uid);

    const partial = await post('/api/v1/crm/refs/stages/order', admin, {
      companyUid: tradeUid,
      uids: uids.slice(0, uids.length - 1),
    });
    expect(partial.status).toBe(422);

    const swapped = [...uids];
    [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
    expect(
      (await post('/api/v1/crm/refs/stages/order', admin, { companyUid: tradeUid, uids: swapped }))
        .status,
    ).toBe(201);

    const after = (await refs()).stages.filter((s: any) => s.company.uid === tradeUid && !s.isFinal);
    expect(after.map((s: any) => s.uid)).toEqual(swapped);
    const finals = (await refs()).stages.filter((s: any) => s.company.uid === tradeUid && s.isFinal);
    for (const f of finals) expect(f.seq).toBeGreaterThan(after[after.length - 1].seq);

    // Возвращаем как было — прогон не меняет воронку стенда.
    await post('/api/v1/crm/refs/stages/order', admin, { companyUid: tradeUid, uids });
  });

  it('выключенная стадия пропадает из доски и в неё нельзя перенести сделку', async () => {
    const stageUid = madeStages[0]!;
    turnedOff.stages.push(stageUid);
    expect((await patch(`/api/v1/crm/refs/stages/${stageUid}`, admin, { isActive: false })).status).toBe(200);

    const stages = (await get('/api/v1/crm/deal-stages', admin)).body.data.rows;
    expect(stages.some((s: any) => s.uid === stageUid)).toBe(false);

    const deal = await db.query<{ uid: string; version: number }>(
      `SELECT d.uid, d.version FROM deal d JOIN company c ON c.id = d.company_id
        WHERE c.code = 'trade' AND d.status = 'open' ORDER BY d.id LIMIT 1`,
    );
    const move = await post(`/api/v1/crm/deals/${deal.rows[0]!.uid}/move`, admin, {
      stageUid,
      version: deal.rows[0]!.version,
    });
    expect(move.status).toBe(422);
    expect(move.body.error.message).toContain('выключена');

    await patch(`/api/v1/crm/refs/stages/${stageUid}`, admin, { isActive: true });
  });
});

describe('источники обращений (ТЗ 8.1)', () => {
  it('источник с обращениями не удаляется и канал у него не меняется', async () => {
    const used = (await refs()).sources.find((s: any) => s.usage.leads > 0);
    const kill = await del(`/api/v1/crm/refs/sources/${used.uid}`, admin);
    expect(kill.status).toBe(409);
    expect(kill.body.error.details.leads).toBe(used.usage.leads);

    const chan = await patch(`/api/v1/crm/refs/sources/${used.uid}`, admin, {
      channel: used.channel === 'ads' ? 'site' : 'ads',
    });
    expect(chan.status).toBe(409);
    expect(chan.body.error.message).toContain('откуда они пришли');
  });

  it('выключенный источник не предлагается в форме и не принимается в обращении', async () => {
    const res = await post('/api/v1/crm/refs/sources', admin, {
      companyUid: tradeUid,
      code: `qa-src-${stamp}`,
      nameRu: `QA Выставка ${stamp}`,
      channel: 'other',
    });
    expect(res.status).toBe(201);
    const uid = res.body.data.uid;
    madeSources.push(uid);

    const optionsOn = (await get('/api/v1/crm/partners/options', admin)).body.data;
    expect(optionsOn.sources.some((s: any) => s.uid === uid)).toBe(true);

    expect((await patch(`/api/v1/crm/refs/sources/${uid}`, admin, { isActive: false })).status).toBe(200);
    const optionsOff = (await get('/api/v1/crm/partners/options', admin)).body.data;
    expect(optionsOff.sources.some((s: any) => s.uid === uid)).toBe(false);

    const lead = await post('/api/v1/crm/leads', admin, {
      companyUid: tradeUid,
      name: `QA Обращение ${stamp}`,
      sourceUid: uid,
      phone: '+998 90 000-00-00',
    });
    expect(lead.status).toBe(422);
    expect(lead.body.error.message).toContain('выключен');
  });

  it('код латиницей: кириллица и дубль отклоняются', async () => {
    const cyr = await post('/api/v1/crm/refs/sources', admin, {
      companyUid: tradeUid,
      code: 'выставка',
      nameRu: 'QA Кириллица',
      channel: 'other',
    });
    expect(cyr.status).toBe(422);

    const dup = await post('/api/v1/crm/refs/sources', admin, {
      companyUid: tradeUid,
      code: `qa-src-${stamp}`,
      nameRu: 'QA Дубль',
      channel: 'other',
    });
    expect(dup.status).toBe(409);
  });
});

describe('причины отказа (ТЗ 8.3)', () => {
  it('последнюю действующую причину выключить нельзя: проигрыш требует причины', async () => {
    const mine = await post('/api/v1/crm/refs/lost-reasons', admin, {
      companyUid: tradeUid,
      code: `qa-reason-${stamp}`,
      nameRu: `QA Причина ${stamp}`,
    });
    expect(mine.status).toBe(201);
    madeReasons.push(mine.body.data.uid);

    const others = (await refs()).lostReasons.filter(
      (r: any) => r.company.uid === tradeUid && r.isActive && r.uid !== mine.body.data.uid,
    );
    for (const r of others) {
      turnedOff.lostReasons.push(r.uid);
      expect((await patch(`/api/v1/crm/refs/lost-reasons/${r.uid}`, admin, { isActive: false })).status).toBe(200);
    }

    const last = await patch(`/api/v1/crm/refs/lost-reasons/${mine.body.data.uid}`, admin, {
      isActive: false,
    });
    expect(last.status).toBe(422);
    expect(last.body.error.message).toContain('последняя причина');

    for (const r of others) {
      await patch(`/api/v1/crm/refs/lost-reasons/${r.uid}`, admin, { isActive: true });
    }
  });
});

describe('типы задач (ТЗ 8.4)', () => {
  it('свой тип задаёт, какой активностью задача ляжет в ленту', async () => {
    const created = await post('/api/v1/crm/refs/task-types', admin, {
      companyUid: tradeUid,
      code: `qa-type-${stamp}`,
      nameRu: `QA Выезд ${stamp}`,
      activityKind: 'meeting',
    });
    expect(created.status).toBe(201);
    const typeUid = created.body.data.uid;
    madeTypes.push(typeUid);

    const task = await post('/api/v1/crm/tasks', admin, {
      typeUid,
      title: `QA Замер ${stamp}`,
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
      partnerUid,
    });
    expect(task.status).toBe(201);
    madeTasks.push(task.body.data.uid);
    expect(task.body.data.type.nameRu).toContain('QA Выезд');

    await post(`/api/v1/crm/tasks/${task.body.data.uid}/complete`, admin, {
      version: task.body.data.version,
      result: 'Замер сделан, объём подтвердили',
    });
    const feed = (await get(`/api/v1/crm/activities?partnerUid=${partnerUid}`, admin)).body.data;
    const mine = feed.rows.find((a: any) => a.task?.uid === task.body.data.uid);
    expect(mine, 'закрытая задача не легла в ленту').toBeTruthy();
    expect(mine.type).toBe('meeting');
  });

  it('тип с задачами не удаляется, выключенный тип не ставится', async () => {
    const typeUid = madeTypes[0]!;
    const kill = await del(`/api/v1/crm/refs/task-types/${typeUid}`, admin);
    expect(kill.status).toBe(409);
    expect(kill.body.error.details.tasks).toBeGreaterThan(0);

    turnedOff.taskTypes.push(typeUid);
    expect((await patch(`/api/v1/crm/refs/task-types/${typeUid}`, admin, { isActive: false })).status).toBe(200);
    const res = await post('/api/v1/crm/tasks', admin, {
      typeUid,
      title: `QA После выключения ${stamp}`,
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
      partnerUid,
    });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('выключен');

    await patch(`/api/v1/crm/refs/task-types/${typeUid}`, admin, { isActive: true });
  });
});

describe('право на правку справочника', () => {
  it('кладовщик справочник CRM не правит', async () => {
    const res = await post('/api/v1/crm/refs/task-types', keeper, {
      companyUid: tradeUid,
      code: `qa-keeper-${stamp}`,
      nameRu: 'QA Кладовщик',
      activityKind: 'note',
    });
    expect(res.status).toBe(403);
  });
});
