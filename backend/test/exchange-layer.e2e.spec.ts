/**
 * Обменный слой с внешними системами (ТЗ 12).
 *
 * Проверяем то, из-за чего обмен ломается в жизни, а не то, что маршрут
 * отвечает 200: ключ и подпись отбивают чужого, повторная доставка одного и
 * того же сообщения не плодит вторую запись, упавший получатель не обстреливается
 * без паузы и в конце концов отпускается, одна и та же пара «внешний код ↔ наш
 * объект» не заводится дважды, а строка файла с ошибкой не применяется молча.
 */
import 'dotenv/config';
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { AuthGuard } from '../src/auth/auth.guard.js';
import { ExchangeModule } from '../src/exchange/exchange.module.js';
import { ExchangeOutboxService } from '../src/exchange/outbox.service.js';
import { ContextMiddleware } from '../src/common/context.middleware.js';
import { EnvelopeInterceptor } from '../src/common/envelope.interceptor.js';
import { ErrorFilter } from '../src/common/error.filter.js';

let app: INestApplication;
let base: string;
let db: Client;
let tradeUid: string;
let admin: { token: string; companies: any[] };
let outbox: ExchangeOutboxService;

/** Получатель исходящих вебхуков: без него доставку проверять нечем. */
let sink: Server;
let sinkUrl: string;
let sinkHits: { body: string; signature: string | undefined; event: string | undefined }[] = [];
let sinkStatus = 200;

const PASSWORD = process.env.SEED_PASSWORD ?? 'metall-dev-2026';
const stamp = Date.now().toString().slice(-7);
const SYS_CODE = `qa${stamp}`;
const cleanupSystems: string[] = [];
const cleanupItems: string[] = [];

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as any) : null };
}

const head = () => ({
  Authorization: `Bearer ${admin.token}`,
  'Content-Type': 'application/json',
  'X-Company-Id': tradeUid,
});

/** Входящий вебхук. Адрес отправителя разный: иначе тесты съедят лимит друг у друга. */
let ipSeq = 0;
const hook = (
  code: string,
  raw: string,
  headers: Record<string, string | undefined> = {},
) => {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Forwarded-For': `10.77.0.${(ipSeq += 1) % 250}`,
  };
  for (const [k, v] of Object.entries(headers)) if (v !== undefined) h[k] = v;
  return api(`/api/v1/hooks/${code}`, { method: 'POST', headers: h, body: raw });
};

const sign = (secret: string, raw: string) =>
  `sha256=${createHmac('sha256', secret).update(raw, 'utf8').digest('hex')}`;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [PrismaModule, AuthModule, ExchangeModule],
    providers: [
      { provide: APP_GUARD, useClass: AuthGuard },
      { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
      { provide: APP_FILTER, useClass: ErrorFilter },
    ],
  }).compile();

  app = moduleRef.createNestApplication();
  const { raw } = await import('express');
  // Те же монтирования, что в `main.ts`: без сырого тела подпись не сойдётся,
  // а файл импорта не доедет. Проверять обмен на другом разборе тела значило бы
  // проверять не то, что работает на стенде.
  app.use('/api/v1/hooks', raw({ type: () => true, limit: '2mb' }));
  app.use('/api/v1/exchange/items/import', raw({ type: () => true, limit: '6mb' }));
  app.use(new ContextMiddleware().use.bind(new ContextMiddleware()));
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
  outbox = app.get(ExchangeOutboxService);

  db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  const login = await api('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: 'admin', password: PASSWORD }),
  });
  admin = login.body.data;
  tradeUid = admin.companies.find((c: any) => c.code === 'trade').uid;

  sink = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      sinkHits.push({
        body: Buffer.concat(chunks).toString('utf8'),
        signature: req.headers['x-exchange-signature'] as string | undefined,
        event: req.headers['x-exchange-event'] as string | undefined,
      });
      res.statusCode = sinkStatus;
      res.end(sinkStatus === 200 ? 'ok' : 'получатель не принял');
    });
  });
  await new Promise<void>((done) => sink.listen(0, '127.0.0.1', done));
  sinkUrl = `http://127.0.0.1:${(sink.address() as any).port}/hook`;
}, 60_000);

afterAll(async () => {
  for (const code of cleanupSystems) {
    await db?.query('DELETE FROM external_system WHERE code = $1', [code]);
  }
  for (const code of cleanupItems) {
    await db?.query('DELETE FROM item WHERE code = $1', [code]);
  }
  await new Promise<void>((done) => sink?.close(() => done()));
  await db?.end();
  await app?.close();
});

/** Подключение заводится на каждую группу своё: ключ выдаётся один раз. */
async function newSystem(suffix: string, opts: { withSecret?: boolean } = {}) {
  const code = `${SYS_CODE}${suffix}`;
  cleanupSystems.push(code);
  const res = await api('/api/v1/exchange/systems', {
    method: 'POST',
    headers: head(),
    body: JSON.stringify({
      code,
      name: `QA обмен ${suffix}`,
      withSecret: opts.withSecret ?? false,
    }),
  });
  expect(res.status).toBe(201);
  return { code, ...(res.body.data as { uid: string; key: string; secret?: string }) };
}

describe('справочник подключений', () => {
  it('ключ отдаётся один раз, дальше только хвост', async () => {
    const sys = await newSystem('a', { withSecret: true });
    expect(sys.key).toMatch(/^[\w-]{20,}$/);
    expect(sys.secret).toBeTruthy();

    const list = await api('/api/v1/exchange/systems', { headers: head() });
    const row = list.body.data.rows.find((r: any) => r.uid === sys.uid);
    expect(row.keyTail).toBe(sys.key.slice(-6));
    // Главное в этой проверке — чего в ответе НЕТ. Ключ и секрет из списка
        // забрать нельзя, иначе «показываем один раз» ничего не значит.
    expect(JSON.stringify(row)).not.toContain(sys.key);
    expect(JSON.stringify(row)).not.toContain(sys.secret);
    expect(row.hasSecret).toBe(true);
  });

  it('перевыпуск ключа отменяет прежний', async () => {
    const sys = await newSystem('b');
    const payload = JSON.stringify({ messageId: `m-${stamp}-rot`, hello: 1 });
    expect((await hook(sys.code, payload, { 'X-Exchange-Key': sys.key })).status).toBe(201);

    const rotated = await api(`/api/v1/exchange/systems/${sys.uid}/key`, {
      method: 'POST',
      headers: head(),
      body: JSON.stringify({}),
    });
    const fresh = rotated.body.data.key as string;
    expect(fresh).not.toBe(sys.key);

    const old = await hook(sys.code, JSON.stringify({ messageId: `m-${stamp}-old` }), {
      'X-Exchange-Key': sys.key,
    });
    expect(old.status).toBe(403);
    const now = await hook(sys.code, JSON.stringify({ messageId: `m-${stamp}-new` }), {
      'X-Exchange-Key': fresh,
    });
    expect(now.status).toBe(201);
  });
});

describe('входящие вебхуки', () => {
  it('без ключа, с чужим ключом и под чужим кодом — отказ, и причина одна', async () => {
    const sys = await newSystem('c');
    const body = JSON.stringify({ messageId: `m-${stamp}-x` });

    expect((await hook(sys.code, body)).status).toBe(403);
    // Ключ латиницей: в значение заголовка кириллица не лезет по самому HTTP.
    const wrong = await hook(sys.code, body, { 'X-Exchange-Key': 'kluch-iz-vozduha' });
    expect(wrong.status).toBe(403);
    // Код чужой, ключ свой: подключение существует, но не то. Отказ тот же
    // текстом — иначе перебором кодов можно узнать, какие системы заведены.
    const otherCode = await hook('netakogo', body, { 'X-Exchange-Key': sys.key });
    expect(otherCode.status).toBe(403);
    expect(wrong.body.error.message).toBe(otherCode.body.error.message);
  });

  it('подпись проверяется по сырым байтам', async () => {
    const sys = await newSystem('d', { withSecret: true });
    const body = JSON.stringify({ messageId: `m-${stamp}-sig`, qty: 3 });

    const nope = await hook(sys.code, body, {
      'X-Exchange-Key': sys.key,
      'X-Exchange-Signature': 'sha256=00',
    });
    expect(nope.status).toBe(403);

    const ok = await hook(sys.code, body, {
      'X-Exchange-Key': sys.key,
      'X-Exchange-Signature': sign(sys.secret!, body),
    });
    expect(ok.status).toBe(201);

    // Тот же разбор, другие байты: пробел между ключами. Подпись должна
    // развалиться — ровно это и значит «по сырым байтам», а не по объекту.
    const spaced = JSON.stringify(JSON.parse(body), null, 1);
    const reshaped = await hook(sys.code, spaced, {
      'X-Exchange-Key': sys.key,
      'X-Exchange-Signature': sign(sys.secret!, body),
      'X-Exchange-Message-Id': `m-${stamp}-sig2`,
    });
    expect(reshaped.status).toBe(403);
  });

  it('повтор того же сообщения не заводит вторую запись', async () => {
    const sys = await newSystem('e');
    const id = `m-${stamp}-dup`;
    const body = JSON.stringify({ messageId: id, amount: 10 });

    const first = await hook(sys.code, body, { 'X-Exchange-Key': sys.key });
    const again = await hook(sys.code, body, { 'X-Exchange-Key': sys.key });
    expect(first.body.data.duplicate).toBe(false);
    expect(again.body.data.duplicate).toBe(true);
    expect(again.body.data.uid).toBe(first.body.data.uid);

    const n = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM exchange_message m
         JOIN external_system s ON s.id = m.system_id
        WHERE s.code = $1 AND m.direction = 'in' AND m.external_id = $2`,
      [sys.code, id],
    );
    expect(Number(n.rows[0]!.n)).toBe(1);
  });

  it('слишком большое тело отбивается с названной причиной', async () => {
    const sys = await newSystem('f');
    const fat = JSON.stringify({ messageId: `m-${stamp}-fat`, pad: 'x'.repeat(1_100_000) });
    const res = await hook(sys.code, fat, { 'X-Exchange-Key': sys.key });
    // 413, а не обрыв соединения: предел назван в сервисе выше предела express
    // именно для того, чтобы чужая система прочла причину.
    expect(res.status).toBe(413);
    expect(res.body.error.message).toMatch(/КБ|KB/);
  });
});

describe('исходящие вебхуки', () => {
  it('событие уходит подписчику с подписью, а упавший получатель ждёт всё дольше', async () => {
    const sys = await newSystem('g', { withSecret: true });
    await api(`/api/v1/exchange/systems/${sys.uid}/subscriptions`, {
      method: 'PUT',
      headers: head(),
      body: JSON.stringify({ event: 'external_system.update', url: sinkUrl }),
    });

    sinkHits = [];
    sinkStatus = 200;
    // Событие рождается из обычной правки: подписка слушает журнал действий,
    // отдельного «сообщить» в коде нет.
    await api(`/api/v1/exchange/systems/${sys.uid}`, {
      method: 'PATCH',
      headers: head(),
      body: JSON.stringify({ comment: `правка ${stamp}` }),
    });

    const sent = await outbox.tick();
    expect(sent.sent).toBe(1);
    expect(sinkHits).toHaveLength(1);
    expect(sinkHits[0]!.event).toBe('external_system.update');
    expect(sinkHits[0]!.signature).toBe(sign(sys.secret!, sinkHits[0]!.body));

    // Теперь получатель отвечает ошибкой. Ждём не «упало», а что будет дальше:
    // задержка растёт, и после предела попыток строка отпускается.
    sinkStatus = 500;
    await api(`/api/v1/exchange/systems/${sys.uid}`, {
      method: 'PATCH',
      headers: head(),
      body: JSON.stringify({ comment: `вторая правка ${stamp}` }),
    });
    const failed = await outbox.tick();
    expect(failed.failed).toBe(1);

    const row = async () =>
      (
        await db.query<{ status: string; attempts: number; last_error: string; wait: string }>(
          `SELECT m.status, m.attempts, m.last_error,
                  round(extract(epoch FROM m.next_attempt_at - now())) AS wait
             FROM exchange_message m JOIN external_system s ON s.id = m.system_id
            WHERE s.code = $1 AND m.direction = 'out' AND m.status <> 'done'
            ORDER BY m.id DESC LIMIT 1`,
          [sys.code],
        )
      ).rows[0]!;

    const after1 = await row();
    expect(after1.status).toBe('pending');
    expect(after1.attempts).toBe(1);
    expect(after1.last_error).toBeTruthy();
    // Первая пауза — минута, а не «сейчас же»: иначе упавшего получателя
    // обстреливают каждую секунду.
    expect(Number(after1.wait)).toBeGreaterThan(30);
    expect(Number(after1.wait)).toBeLessThanOrEqual(60);

    // Срок сдвигаем в прошлое руками: ждать 1+5+25+125 минут тест не может,
    // а проверить нужно именно рост паузы и предел попыток.
    const push = async () => {
      await db.query(
        `UPDATE exchange_message m SET next_attempt_at = now() - interval '1 second'
           FROM external_system s
          WHERE s.id = m.system_id AND s.code = $1 AND m.status = 'pending'
            AND m.direction = 'out'`,
        [sys.code],
      );
      await outbox.tick();
    };
    await push();
    const after2 = await row();
    expect(after2.attempts).toBe(2);
    expect(Number(after2.wait)).toBeGreaterThan(Number(after1.wait));

    while ((await row()).attempts < ExchangeOutboxService.MAX_ATTEMPTS) await push();
    const atLimit = await row();
    expect(atLimit.attempts).toBe(ExchangeOutboxService.MAX_ATTEMPTS);
    // Предел достигнут — строка больше не берётся. Иначе очередь годами
    // стучится в адрес, которого нет, и прячет живые обмены за собой.
    expect(atLimit.status).toBe('dead');
    const idle = await outbox.tick();
    expect(idle.sent + idle.failed).toBe(0);
  }, 60_000);

  it('повтор кнопкой обнуляет попытки и отправляет сразу', async () => {
    const dead = await db.query<{ uid: string }>(
      `SELECT m.uid FROM exchange_message m JOIN external_system s ON s.id = m.system_id
        WHERE s.code = $1 AND m.status = 'dead' ORDER BY m.id DESC LIMIT 1`,
      [`${SYS_CODE}g`],
    );
    expect(dead.rows[0]).toBeTruthy();

    sinkStatus = 200;
    sinkHits = [];
    const res = await api(`/api/v1/exchange/messages/${dead.rows[0]!.uid}/retry`, {
      method: 'POST',
      headers: head(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);

    const again = await outbox.tick();
    expect(again.sent).toBe(1);
    const after = await db.query<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM exchange_message WHERE uid = $1::uuid`,
      [dead.rows[0]!.uid],
    );
    expect(after.rows[0]!.status).toBe('done');
  }, 30_000);
});

describe('карта соответствий', () => {
  it('одна и та же пара не заводится дважды, а чужая связь не перезаписывается молча', async () => {
    const sys = await newSystem('h');
    const items = await db.query<{ uid: string }>(
      `SELECT i.uid FROM item i JOIN company c ON c.id = i.company_id
        WHERE c.uid = $1::uuid ORDER BY i.id LIMIT 2`,
      [tradeUid],
    );
    const [one, two] = items.rows.map((r) => r.uid);
    const ref = (externalId: string, internalUid: string) =>
      api('/api/v1/exchange/refs', {
        method: 'PUT',
        headers: head(),
        body: JSON.stringify({ systemUid: sys.uid, entityType: 'item', externalId, internalUid }),
      });

    const first = await ref('1C-00042', one!);
    expect(first.status).toBe(200);
    // Повтор того же — то же самое, а не вторая строка: обмен идёт каждый час,
    // и без этого карта за сутки выросла бы в двадцать четыре раза.
    const same = await ref('1C-00042', one!);
    expect(same.body.data.uid).toBe(first.body.data.uid);

    // Тот же внешний код на другой наш объект — отказ. Переписать молча значит
    // увести чужие остатки на другую номенклатуру, и никто не заметит.
    const clash = await ref('1C-00042', two!);
    expect(clash.status).toBe(409);

    const n = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM external_ref r JOIN external_system s ON s.id = r.system_id
        WHERE s.code = $1`,
      [sys.code],
    );
    expect(Number(n.rows[0]!.n)).toBe(1);
  });
});

describe('импорт и экспорт номенклатуры', () => {
  it('выгрузка читается обратно: круг замыкается', async () => {
    const res = await fetch(`${base}/api/v1/exchange/items/file?format=csv`, { headers: head() });
    expect(res.status).toBe(200);
    const text = Buffer.from(await res.arrayBuffer()).toString('utf8');
    expect(text.charCodeAt(0)).toBe(0xfeff); // BOM: иначе Excel покажет кракозябры
    expect(text.split('\n')[0]).toContain('Код');

    // Загружаем ровно то, что выгрузили. Ни одной отбитой строки быть не должно:
    // система обязана прочитать собственный файл.
    const back = await fetch(`${base}/api/v1/exchange/items/import?dryRun=true&name=u.csv`, {
      method: 'POST',
      headers: { ...head(), 'Content-Type': 'text/csv' },
      body: text,
    });
    const report = (await back.json() as any).data;
    expect(report.rejectedCount).toBe(0);
    expect(report.total).toBeGreaterThan(0);
  }, 30_000);

  it('строка с ошибкой не применяется, и причина названа по строке', async () => {
    const good = `qa-imp-${stamp}`;
    cleanupItems.push(good);
    // Единица здесь написана по-русски («шт»), а не кодом («pcs»): именно так
    // её пришлёт чужая программа, и импорт обязан её узнать.
    const csv = [
      'Код;Наименование (ru);Nomi (uz);Вид;Единица;Минимальный запас;Критический запас',
      `${good};Швеллер QA;QA shveller;goods;шт;10;5`,
      `;Без кода;Kodsiz;goods;шт;1;1`,
      `qa-bad-unit-${stamp};Единица из воздуха;Noma'lum birlik;goods;парсек;1;1`,
      `qa-bad-crit-${stamp};Критический выше минимального;Xato;goods;шт;5;9`,
      `${good};Повтор кода в файле;Takror;goods;шт;1;1`,
    ].join('\r\n');

    const res = await fetch(`${base}/api/v1/exchange/items/import?name=qa.csv`, {
      method: 'POST',
      headers: { ...head(), 'Content-Type': 'text/csv' },
      body: `﻿${csv}`,
    });
    const r = (await res.json() as any).data;

    expect(r.acceptedCount).toBe(1);
    expect(r.rejectedCount).toBe(4);
    // Номер строки — файла, а не массива: человек ищет её в Excel глазами.
    // Шапка — строка 1, значит первая строка данных — 2, и ошибки с 3-й по 6-ю.
    expect(r.rejected.map((l: any) => l.line).sort((a: number, b: number) => a - b)).toEqual([
      3, 4, 5, 6,
    ]);
    expect(r.rejected.every((l: any) => l.reasonRu && l.reasonUz)).toBe(true);

    // Отбитые строки не доехали до базы — ровно это и значит «не применяется
    // молча»: иначе половина файла легла бы, а человек увидел бы «есть ошибки».
    const bad = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM item WHERE code LIKE $1`,
      [`qa-bad-%${stamp}`],
    );
    expect(Number(bad.rows[0]!.n)).toBe(0);

    const ok = await db.query<{ n: string }>(`SELECT count(*) AS n FROM item WHERE code = $1`, [
      good,
    ]);
    expect(Number(ok.rows[0]!.n)).toBe(1);
  }, 30_000);

  it('проверочный прогон не пишет в базу', async () => {
    const code = `qa-dry-${stamp}`;
    const csv = [
      'Код;Наименование (ru);Nomi (uz);Вид;Единица',
      `${code};Проверочный;Sinov;goods;pcs`,
    ].join('\r\n');
    const res = await fetch(`${base}/api/v1/exchange/items/import?dryRun=true`, {
      method: 'POST',
      headers: { ...head(), 'Content-Type': 'text/csv' },
      body: csv,
    });
    expect(((await res.json() as any).data).acceptedCount).toBe(1);
    const n = await db.query<{ n: string }>(`SELECT count(*) AS n FROM item WHERE code = $1`, [
      code,
    ]);
    expect(Number(n.rows[0]!.n)).toBe(0);
  }, 30_000);
});

describe('журнал обменов', () => {
  it('показывает направление, итог, попытки и обрезанные тела', async () => {
    const res = await api('/api/v1/exchange/messages?limit=50', { headers: head() });
    expect(res.status).toBe(200);
    const rows = res.body.data.rows as any[];
    expect(rows.length).toBeGreaterThan(0);
    expect(res.body.data.total).toBeGreaterThanOrEqual(rows.length);

    const inbound = rows.find((r) => r.direction === 'in');
    expect(inbound.statusRu).toBeTruthy();
    expect(inbound.statusUz).toBeTruthy();
    expect(inbound.requestBody.length).toBeLessThanOrEqual(4100);

    const dead = await api('/api/v1/exchange/messages?status=dead', { headers: head() });
    expect(dead.body.data.rows.every((r: any) => r.status === 'dead')).toBe(true);
  });

  it('отбор по системе и направлению сужает выдачу, а не делает вид', async () => {
    const all = await api('/api/v1/exchange/messages?direction=out', { headers: head() });
    expect(all.body.data.rows.every((r: any) => r.direction === 'out')).toBe(true);
    const facets = await api('/api/v1/exchange/messages/facets', { headers: head() });
    expect(facets.body.data.systems.length).toBeGreaterThan(0);
    expect(facets.body.data.statuses).toHaveLength(4);
  });
});
