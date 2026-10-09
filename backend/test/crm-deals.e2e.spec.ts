/**
 * CRM Э3 — воронка и сделки (ТЗ 8.3).
 *
 * Проверяем правила, ради которых этап делался: доска рисует стадии компании,
 * а не вшитые колонки; каждый переход оставляет след с автором; в конечную
 * стадию не переносят — закрывают выигрышем или проигрышем, и проигрыш без
 * причины из справочника не проходит; закрытая сделка — история, её не
 * двигают; версия сделки не даёт двоим затереть переносы друг друга.
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
const created: string[] = [];
let partnerUid: string;
let stages: any[];
let reasons: any[];

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
  stages = (await get('/api/v1/crm/deal-stages', admin)).body.data.rows
    .filter((s: any) => s.company.code === 'trade');
  reasons = (await get('/api/v1/crm/lost-reasons', admin)).body.data.rows
    .filter((r: any) => r.company.code === 'trade');
}, 60_000);

afterAll(async () => {
  for (const uid of created) {
    await db?.query('DELETE FROM deal WHERE uid = $1', [uid]);
  }
  await db?.end();
  await app?.close();
});

const open = () => stages.filter((s: any) => !s.isFinal).sort((a: any, b: any) => a.seq - b.seq);

async function newDeal(title: string) {
  const res = await post('/api/v1/crm/deals', admin, {
    partnerUid,
    title: `${title} ${stamp}`,
    amount: 250000000,
  });
  expect(res.status).toBe(201);
  created.push(res.body.data.uid);
  return res.body.data;
}

describe('стадии воронки — из базы компании (ТЗ 8.3)', () => {
  it('стадии уходят наружу по uid, в порядке компании, с конечными отдельно', () => {
    expect(stages.length).toBeGreaterThanOrEqual(3);
    expect(String(stages[0].uid)).toMatch(/^[0-9a-f-]{36}$/);
    const seqs = stages.map((s: any) => s.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect(stages.filter((s: any) => s.isFinal).map((s: any) => s.code).sort()).toEqual(['lost', 'won']);
  });

  it('доска рисует столько колонок, сколько стадий, и суммы по ним', async () => {
    const res = await get('/api/v1/crm/deals/board', admin);
    expect(res.status).toBe(200);
    const trade = res.body.data.stages.filter((s: any) => s.company.code === 'trade');
    expect(trade.map((s: any) => s.uid)).toEqual(stages.map((s: any) => s.uid));
    for (const col of trade.filter((s: any) => !s.isFinal)) {
      const sum = col.deals.reduce((a: number, d: any) => a + Number(d.amount), 0);
      expect(Number(col.amount)).toBeCloseTo(sum, 2);
      expect(col.count).toBe(col.deals.length);
      // На доске только открытые: закрытые не вытесняют сегодняшнюю работу.
      expect(col.deals.every((d: any) => d.status === 'open')).toBe(true);
    }
    // Конечные колонки несут последние закрытые — не больше десяти, свежие
    // сверху. Итог в заголовке при этом полный.
    for (const col of trade.filter((s: any) => s.isFinal)) {
      expect(col.deals.length).toBeLessThanOrEqual(10);
      expect(col.deals.length).toBeLessThanOrEqual(col.count);
      expect(col.deals.every((d: any) => d.status !== 'open')).toBe(true);
      const at = col.deals.map((d: any) => Date.parse(d.closedAt));
      expect([...at].sort((a, b) => b - a)).toEqual(at);
    }
  });
});

describe('список сделок — то же, но целиком', () => {
  it('сортируется по заданному столбцу и делится на страницы без пропусков', async () => {
    const all = (await get('/api/v1/crm/deals?limit=200&sort=amount&dir=desc', admin)).body.data;
    const amounts = all.rows.map((r: any) => Number(r.amount));
    expect([...amounts].sort((a, b) => b - a)).toEqual(amounts);
    expect(all.total).toBeGreaterThanOrEqual(all.rows.length);

    // Догрузка: две страницы подряд дают ровно начало полного списка. Без
    // второго ключа сортировки строки с одинаковой суммой тасуются, и одна
    // сделка пропала бы между страницами.
    const p1 = (await get('/api/v1/crm/deals?limit=5&offset=0&sort=amount&dir=desc', admin)).body
      .data;
    const p2 = (await get('/api/v1/crm/deals?limit=5&offset=5&sort=amount&dir=desc', admin)).body
      .data;
    expect([...p1.rows, ...p2.rows].map((r: any) => r.uid)).toEqual(
      all.rows.slice(0, 10).map((r: any) => r.uid),
    );

    const asc = (await get('/api/v1/crm/deals?limit=200&sort=amount&dir=asc', admin)).body.data;
    expect(Number(asc.rows[0].amount)).toBeLessThanOrEqual(Number(all.rows[0].amount));
  });

  it('фильтр по компании сужает список, а имя столбца с улицы не принимается', async () => {
    const both = (await get('/api/v1/crm/deals?limit=200', admin, '')).body.data;
    const trade = (await get(`/api/v1/crm/deals?limit=200&companyUid=${tradeUid}`, admin, '')).body
      .data;
    expect(trade.rows.every((r: any) => r.company.code === 'trade')).toBe(true);
    expect(trade.total).toBeLessThanOrEqual(both.total);

    // Сортировка приходит ключом из списка: произвольная строка в запрос не уходит.
    expect((await get('/api/v1/crm/deals?sort=d.id%3B%20DROP', admin)).status).toBe(400);
    expect((await get('/api/v1/crm/deals?dir=вверх', admin)).status).toBe(400);
  });

  it('в строке списка виден исход словами, а не только причина', async () => {
    const d = await newDeal('QA Исход в списке');
    await post(`/api/v1/crm/deals/${d.uid}/win`, admin, {
      version: d.version,
      comment: 'Согласовали отсрочку 30 дней',
    });
    const res = await get(`/api/v1/crm/deals?search=QA%20Исход%20в%20списке%20${stamp}`, admin);
    const row = res.body.data.rows.find((r: any) => r.uid === d.uid);
    expect(row.closeComment).toBe('Согласовали отсрочку 30 дней');
    expect(row.closedAt).toBeTruthy();
  });
});

describe('сделка по воронке', () => {
  let deal: any;

  it('заводится в первой стадии со своим номером и первой записью следа', async () => {
    deal = await newDeal('QA Воронка');
    expect(deal.stage.uid).toBe(open()[0].uid);
    expect(deal.number).toMatch(/^СД-\d{4}$/);
    expect(deal.status).toBe('open');
    expect(deal.history).toHaveLength(1);
    expect(deal.history[0].from).toBeNull();
    expect(deal.history[0].user).toBeTruthy();
  });

  it('переносится вперёд и назад, и каждый шаг пишет след с автором', async () => {
    const [, second, third] = open();
    let res = await post(`/api/v1/crm/deals/${deal.uid}/move`, admin, {
      stageUid: third.uid,
      version: deal.version,
    });
    expect(res.status).toBe(201);
    expect(res.body.data.probability).toBe(third.probabilityDefault);

    res = await post(`/api/v1/crm/deals/${deal.uid}/move`, admin, {
      stageUid: second.uid,
      version: res.body.data.version,
    });
    expect(res.status).toBe(201);
    deal = res.body.data;
    expect(deal.stage.uid).toBe(second.uid);
    expect(deal.history.map((h: any) => h.to)).toEqual([
      open()[0].nameRu,
      third.nameRu,
      second.nameRu,
    ]);
    expect(deal.history[2].from).toBe(third.nameRu);
  });

  it('перенос с устаревшей версией — конфликт с текущей версией', async () => {
    const res = await post(`/api/v1/crm/deals/${deal.uid}/move`, admin, {
      stageUid: open()[0].uid,
      version: deal.version - 1,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.details.version).toBe(deal.version);
  });

  it('в конечную стадию не переносят: только выигрыш или проигрыш', async () => {
    const won = stages.find((s: any) => s.code === 'won');
    const res = await post(`/api/v1/crm/deals/${deal.uid}/move`, admin, {
      stageUid: won.uid,
      version: deal.version,
    });
    expect(res.status).toBe(422);
    expect(String(res.body.error.message)).toContain('причина');
  });

  it('стадию чужой компании не принимает: под заголовком торгового дома её просто нет', async () => {
    const plant = await db.query<{ uid: string }>(
      `SELECT s.uid FROM deal_stage s JOIN company c ON c.id = s.company_id
        WHERE c.code = 'plant' AND NOT s.is_final LIMIT 1`,
    );
    const res = await post(`/api/v1/crm/deals/${deal.uid}/move`, admin, {
      stageUid: plant.rows[0]!.uid,
      version: deal.version,
    });
    // Изоляция компаний отвечает раньше правила: чужая стадия не видна вовсе.
    expect(res.status).toBe(404);
  });
});

describe('закрытие сделки', () => {
  it('проигрыш без причины из справочника не проходит', async () => {
    const d = await newDeal('QA Проигрыш');
    const bare = await post(`/api/v1/crm/deals/${d.uid}/lose`, admin, { version: d.version });
    expect(bare.status).toBe(400);

    const res = await post(`/api/v1/crm/deals/${d.uid}/lose`, admin, {
      version: d.version,
      reasonUid: reasons[0].uid,
      comment: 'Взяли у соседей на 3% дешевле',
    });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('lost');
    expect(res.body.data.probability).toBe(0);
    expect(res.body.data.lostReason.uid).toBe(reasons[0].uid);
    expect(res.body.data.closeComment).toBe('Взяли у соседей на 3% дешевле');
    expect(res.body.data.history.at(-1).toCode).toBe('lost');
  });

  it('база сама не даёт проигранной сделке остаться без причины', async () => {
    const d = await newDeal('QA Проигрыш в обход');
    await expect(
      db.query(
        `UPDATE deal SET status = 'lost', lost_reason_id = NULL WHERE uid = $1`,
        [d.uid],
      ),
    ).rejects.toThrow(/deal_lost_needs_reason/);
  });

  it('закрытие без комментария не проходит ни на одном исходе', async () => {
    // Исход без слов — это пустая строка в карточке через полгода. Причина
    // из справочника отвечает отчёту, комментарий — человеку.
    const a = await newDeal('QA Закрытие без слов');
    const noWin = await post(`/api/v1/crm/deals/${a.uid}/win`, admin, { version: a.version });
    expect(noWin.status).toBe(400);

    const b = await newDeal('QA Отказ без слов');
    const noLose = await post(`/api/v1/crm/deals/${b.uid}/lose`, admin, {
      version: b.version,
      reasonUid: reasons[0].uid,
    });
    expect(noLose.status).toBe(400);

    // Пробелы вместо слов длину проходят, но их отбивает сама служба.
    const blank = await post(`/api/v1/crm/deals/${a.uid}/win`, admin, {
      version: a.version,
      comment: '   ',
    });
    expect(blank.status).toBe(422);
  });

  it('выигрыш ставит конечную стадию и вероятность 100', async () => {
    const d = await newDeal('QA Выигрыш');
    const res = await post(`/api/v1/crm/deals/${d.uid}/win`, admin, {
      version: d.version,
      comment: 'Подписали договор, аванс 30%',
    });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('won');
    expect(res.body.data.probability).toBe(100);
    expect(res.body.data.stage.code).toBe('won');
    expect(res.body.data.closedAt).toBeTruthy();
    expect(res.body.data.closeComment).toBe('Подписали договор, аванс 30%');
    expect(res.body.data.permissions.canMove).toBe(false);

    // Закрытая сделка — история: не двигается и не правится.
    const again = await post(`/api/v1/crm/deals/${d.uid}/move`, admin, {
      stageUid: open()[0].uid,
      version: res.body.data.version,
    });
    expect(again.status).toBe(422);
    expect(String(again.body.error.message)).toContain('история');
    const edit = await patch(`/api/v1/crm/deals/${d.uid}`, admin, {
      version: res.body.data.version,
      amount: 1,
    });
    expect(edit.status).toBe(422);
  });

  it('закрытая сделка видна карточкой в своей конечной колонке', async () => {
    const d = await newDeal('QA Доска закрытых');
    await post(`/api/v1/crm/deals/${d.uid}/win`, admin, {
      version: d.version,
      comment: 'QA: проверяем, что закрытая видна на доске',
    });
    const board = (await get('/api/v1/crm/deals/board', admin)).body.data.stages;
    const won = board.find((s: any) => s.company.code === 'trade' && s.code === 'won');
    // Только что закрытая — первая: её и ищут на доске сразу после закрытия.
    expect(won.deals[0].uid).toBe(d.uid);
    expect(won.count).toBeGreaterThanOrEqual(won.deals.length);
    const lost = board.find((s: any) => s.company.code === 'trade' && s.code === 'lost');
    expect(lost.deals.every((x: any) => x.status === 'lost')).toBe(true);
  });

  it('обращение, превращённое со сделкой, тоже оставляет след в воронке', async () => {
    const src = await db.query<{ uid: string }>(
      `SELECT s.uid FROM lead_source s JOIN company c ON c.id = s.company_id WHERE c.code = 'trade' LIMIT 1`,
    );
    const lead = await post('/api/v1/crm/leads', admin, {
      sourceUid: src.rows[0]!.uid,
      name: `QA След ${stamp}`,
    });
    const conv = await post(`/api/v1/crm/leads/${lead.body.data.uid}/convert`, admin, {
      partnerUid,
      withDeal: true,
    });
    created.push(conv.body.data.dealUid);
    const card = (await get(`/api/v1/crm/deals/${conv.body.data.dealUid}`, admin)).body.data;
    expect(card.history).toHaveLength(1);
    await db.query('DELETE FROM lead WHERE uid = $1', [lead.body.data.uid]);
  });

  it('кладовщик воронку не видит', async () => {
    expect((await get('/api/v1/crm/deals/board', keeper)).status).toBe(403);
  });
});
