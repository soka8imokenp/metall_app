/**
 * Откуда пришёл лид: приём заявки с сайта и разбор меток (SEO).
 *
 * Проверяем то, ради чего это делалось: метки доезжают с чужой страницы,
 * раскладываются по источникам правилами, первое касание хранится отдельно от
 * последнего, а открытый маршрут не превращается в дыру — чужой ключ, робот и
 * частота отбиваются.
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
import { PublicModule } from '../src/public/public.module.js';
import { ContextMiddleware } from '../src/common/context.middleware.js';
import { EnvelopeInterceptor } from '../src/common/envelope.interceptor.js';
import { ErrorFilter } from '../src/common/error.filter.js';

let app: INestApplication;
let base: string;
let db: Client;
let tradeUid: string;
let admin: { token: string; companies: any[] };
let siteKey: string;

const PASSWORD = process.env.SEED_PASSWORD ?? 'metall-dev-2026';
const stamp = Date.now().toString().slice(-6);
const createdLeads: string[] = [];

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as any) : null };
}

/** Заявка с сайта. Адрес отправителя разный: иначе тесты съедят лимит друг у друга. */
let ipSeq = 0;
const intake = (body: unknown, ip?: string) =>
  api('/api/v1/public/leads', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': ip ?? `10.9.0.${(ipSeq += 1) % 250}`,
    },
    body: JSON.stringify(body),
  });

const head = () => ({
  Authorization: `Bearer ${admin.token}`,
  'Content-Type': 'application/json',
  'X-Company-Id': tradeUid,
});

const lead = async (phone: string) => {
  const res = await api(`/api/v1/crm/leads?search=${encodeURIComponent(phone)}`, {
    headers: head(),
  });
  return res.body.data.rows[0];
};

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [PrismaModule, AuthModule, CrmModule, PublicModule],
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

  const login = await api('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: 'admin', password: PASSWORD }),
  });
  admin = login.body.data;
  tradeUid = admin.companies.find((c: any) => c.code === 'trade').uid;

  const key = await db.query<{ code: string }>(
    `SELECT k.code FROM site_key k JOIN company c ON c.id = k.company_id
      WHERE c.code = 'trade' AND k.is_active ORDER BY k.id LIMIT 1`,
  );
  siteKey = key.rows[0]!.code;
}, 60_000);

afterAll(async () => {
  for (const phone of createdLeads) {
    await db?.query('DELETE FROM lead WHERE phone = $1', [phone]);
  }
  await db?.end();
  await app?.close();
});

describe('приём заявки с сайта', () => {
  it('метки доезжают, раскладываются по источнику и делятся на два касания', async () => {
    const phone = `+99890${stamp}1`;
    createdLeads.push(phone);
    const res = await intake({
      key: siteKey,
      name: 'QA Поиск',
      phone: `90 ${stamp} 1`,
      comment: 'Нужен швеллер 10',
      marks: {
        source: 'google',
        medium: 'organic',
        term: 'швеллер 10 цена',
        landing: 'https://metallasia.uz/shveller',
        referrer: 'https://www.google.com/',
        visitorId: 'v-qa-1',
        formCode: 'callback',
        firstAt: '2026-09-01T10:00:00.000Z',
        firstSource: 'google',
        firstMedium: 'organic',
        firstLanding: 'https://metallasia.uz/blog/kak-vybrat-shveller',
      },
    });
    expect(res.status).toBe(201);
    expect(res.body.data.accepted).toBe(true);

    const l = await lead(phone);
    expect(l).toBeTruthy();
    // Телефон с сайта приходит как набрали — в CRM он один и тот же.
    expect(l.phone).toBe(phone);
    expect(l.source.name).toBe('Поиск (SEO)');
    expect(l.marks.has).toBe(true);
    expect(l.marks.last.term).toBe('швеллер 10 цена');
    expect(l.marks.last.landing).toBe('https://metallasia.uz/shveller');
    expect(l.marks.first.landing).toBe('https://metallasia.uz/blog/kak-vybrat-shveller');
    expect(l.marks.first.sourceName).toBe('Поиск (SEO)');
    expect(l.marks.formCode).toBe('callback');
  });

  it('реклама, переход и прямой заход расходятся по разным источникам', async () => {
    const cases: [string, Record<string, unknown>, string][] = [
      ['2', { source: 'google', medium: 'cpc', campaign: 'zima' }, 'Реклама'],
      ['3', { clickId: 'EAIaIQobChMI', landing: 'https://metallasia.uz/' }, 'Реклама'],
      ['4', { referrer: 'https://uz.wikipedia.org/' }, 'Переход по ссылке'],
      ['5', { landing: 'https://metallasia.uz/' }, 'Прямой заход'],
    ];
    for (const [tail, marks, expected] of cases) {
      const phone = `+99890${stamp}${tail}`;
      createdLeads.push(phone);
      const res = await intake({ key: siteKey, name: `QA ${expected}`, phone, marks });
      expect(res.status).toBe(201);
      const l = await lead(phone);
      expect(`${expected}: ${l.source?.name}`).toBe(`${expected}: ${expected}`);
    }
  });

  it('чужой ключ, робот и заявка без связи не проходят', async () => {
    expect((await intake({ key: 'нет такого', name: 'QA', phone: '901234567' })).status).toBe(403);

    // Ловушка: отвечаем как при успехе, но обращение не заводим — робот не
    // должен понять, что его отличили.
    const trapPhone = `+99890${stamp}6`;
    const trap = await intake({
      key: siteKey,
      name: 'QA Робот',
      phone: trapPhone,
      company: 'ООО Робот',
    });
    expect(trap.status).toBe(201);
    expect(trap.body.data.accepted).toBe(true);
    expect(await lead(trapPhone)).toBeUndefined();

    const noContact = await intake({ key: siteKey, name: 'QA Без связи' });
    expect(noContact.status).toBe(422);
    expect(String(noContact.body.error.message)).toContain('телефон');
  });

  it('частота с одного адреса ограничена', async () => {
    const ip = '10.9.9.9';
    let blocked = 0;
    for (let i = 0; i < 13; i += 1) {
      const phone = `+99891${stamp}${i % 10}`;
      createdLeads.push(phone);
      const res = await intake({ key: siteKey, name: 'QA Частота', phone }, ip);
      if (res.status === 403) blocked += 1;
    }
    expect(blocked).toBeGreaterThan(0);
  });

  it('ключ сайта виден в CRM и его можно выключить', async () => {
    const list = await api('/api/v1/crm/site-keys', { headers: head() });
    expect(list.status).toBe(200);
    const row = list.body.data.rows.find((r: any) => r.code === siteKey);
    expect(row.usedCount).toBeGreaterThan(0);

    const made = await api('/api/v1/crm/site-keys', {
      method: 'POST',
      headers: head(),
      body: JSON.stringify({ name: `QA ключ ${stamp}`, origins: ['https://qa.example'] }),
    });
    expect(made.status).toBe(201);
    const code = made.body.data.code;
    expect(code.length).toBeGreaterThanOrEqual(20);

    // Чужая страница по этому ключу не проходит: адрес указан явно.
    const wrongOrigin = await api('/api/v1/public/leads', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://zloy.example',
        'X-Forwarded-For': '10.9.1.1',
      },
      body: JSON.stringify({ key: code, name: 'QA', phone: '901112233' }),
    });
    expect(wrongOrigin.status).toBe(403);

    const off = await api(`/api/v1/crm/site-keys/${made.body.data.uid}`, {
      method: 'PATCH',
      headers: head(),
      body: JSON.stringify({ isActive: false }),
    });
    expect(off.status).toBe(200);
    expect(off.body.data.isActive).toBe(false);
    const afterOff = await intake({ key: code, name: 'QA', phone: '901112244' });
    expect(afterOff.status).toBe(403);
    await db.query('DELETE FROM site_key WHERE uid = $1', [made.body.data.uid]);
  });

  it('отчёт «Метки сайта» считает оба касания', async () => {
    const res = await api('/api/v1/crm/reports/marks', { headers: head() });
    expect(res.status).toBe(200);
    expect(res.body.data.kind).toBe('marks');
    expect(res.body.data.columns.map((c: any) => c.title)).toContain('Обращений (первое)');
    const organic = res.body.data.rows.find((r: any[]) => r[1] === 'google' && r[2] === 'organic');
    expect(organic).toBeTruthy();
    expect(Number(organic[4])).toBeGreaterThan(0);
    expect(res.body.data.totals.firstLeads).toBeGreaterThan(0);
  });
});
