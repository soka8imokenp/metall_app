import 'dotenv/config';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { AuthGuard } from '../src/auth/auth.guard.js';
import { WarehouseModule } from '../src/warehouse/warehouse.module.js';
import { CrmModule } from '../src/crm/crm.module.js';
import { ProductionModule } from '../src/production/production.module.js';
import { RefsModule } from '../src/refs/refs.module.js';
import { DocumentsModule } from '../src/documents/documents.module.js';
import { ContextMiddleware } from '../src/common/context.middleware.js';
import { EnvelopeInterceptor } from '../src/common/envelope.interceptor.js';
import { ErrorFilter } from '../src/common/error.filter.js';

/**
 * Язык интерфейса (ТЗ 13.4) с той стороны, где его видно меньше всего: в
 * ответах сервера. Шапки отчётов и тексты ошибок приходят с бэкенда, и под
 * узбекским экраном они обязаны быть узбекскими — иначе человек видит
 * половину экрана на своём языке, а половину нет.
 *
 * И выбор языка: в боте он запоминается за человеком, в вебе до этой правки
 * сбрасывался на русский при каждой перезагрузке.
 */
let app: INestApplication;
let base: string;

const PASSWORD = process.env.SEED_PASSWORD ?? 'metall-dev-2026';
const CYR = /[А-Яа-яЁё]/;

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

const uz = (token: string, companyUids?: string[]) => ({
  Authorization: `Bearer ${token}`,
  'Accept-Language': 'uz',
  ...(companyUids?.length ? { 'X-Company-Id': companyUids.join(',') } : {}),
});

let token: string;
let companies: { uid: string; code: string }[];
/** Язык, который был у человека до проверки: вернём его при любом исходе. */
let localeWas: 'ru' | 'uz' = 'ru';

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [
      PrismaModule,
      AuthModule,
      WarehouseModule,
      CrmModule,
      ProductionModule,
      RefsModule,
      DocumentsModule,
    ],
    providers: [
      { provide: APP_GUARD, useClass: AuthGuard },
      { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
      { provide: APP_FILTER, useClass: ErrorFilter },
    ],
  }).compile();
  app = moduleRef.createNestApplication();
  app.use(new ContextMiddleware().use.bind(new ContextMiddleware()));
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(0);
  base = await app.getUrl();
  const session = await login('admin');
  token = session.token;
  companies = session.companies;
  const me = await api('/api/v1/auth/me', { headers: { Authorization: `Bearer ${token}` } });
  localeWas = me.body.data.user.locale;
});

afterAll(async () => {
  // Язык — настройка живого человека, и провалившаяся проверка не должна
  // оставить его переключённым: иначе следующий прогон увидит узбекский
  // экран там, где ждёт русский. Возвращаем здесь, а не в теле проверки.
  if (app && token) {
    await api('/api/v1/auth/me/locale', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ locale: localeWas }),
    }).catch(() => null);
  }
  await app?.close();
});

describe('язык человека', () => {
  it('выбор языка в вебе запоминается за человеком', async () => {
    const set = await api('/api/v1/auth/me/locale', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ locale: 'uz' }),
    });
    expect(set.status).toBeLessThan(300);

    const me = await api('/api/v1/auth/me', { headers: { Authorization: `Bearer ${token}` } });
    expect(me.body.data.user.locale).toBe('uz');

    // Возвращаем как было ещё и здесь: следующая проверка в этом файле
    // ожидает русский. Страховка на случай падения — в afterAll.
    await api('/api/v1/auth/me/locale', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ locale: 'ru' }),
    });
    const back = await api('/api/v1/auth/me', { headers: { Authorization: `Bearer ${token}` } });
    expect(back.body.data.user.locale).toBe('ru');
  });

  it('чужой язык не принимается', async () => {
    const bad = await api('/api/v1/auth/me/locale', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ locale: 'en' }),
    });
    expect(bad.status).toBe(400);
  });
});

describe('шапки отчётов на языке запроса', () => {
  const cases: [string, string][] = [
    ['склад', '/api/v1/warehouse/reports/stock?limit=5'],
    ['CRM', '/api/v1/crm/reports/funnel'],
    ['производство', '/api/v1/production/reports/orders'],
  ];

  for (const [name, path] of cases) {
    it(`отчёт ${name} приходит по-узбекски`, async () => {
      const res = await api(path, { headers: uz(token, companies.map((c) => c.uid)) });
      expect(res.status).toBe(200);
      const report = res.body.data;
      const chrome = [
        report.title,
        report.subtitle,
        ...(report.columns ?? []).map((c: { title: string }) => c.title),
      ].filter(Boolean);
      expect(chrome.length).toBeGreaterThan(3);
      const russian = chrome.filter((s: string) => CYR.test(s));
      expect(russian, `русские надписи в отчёте ${name}: ${russian.join(' | ')}`).toEqual([]);
    });
  }
});

describe('названия справочников на языке запроса', () => {
  it('в отчёте остатков склад назван по-узбекски', async () => {
    const res = await api('/api/v1/warehouse/reports/stock?limit=20', {
      headers: uz(token, companies.map((c) => c.uid)),
    });
    expect(res.status).toBe(200);
    const report = res.body.data;
    const at = report.columns.findIndex((c: { title: string }) => c.title === 'Ombor');
    expect(at, 'колонки «Ombor» в отчёте нет').toBeGreaterThanOrEqual(0);
    expect(report.rows.length).toBeGreaterThan(0);
    // Названия складов заведены на двух языках, и узбекские — латиницей.
    // Кириллица в этой колонке значит, что отдали русское поле.
    const russian = [...new Set(report.rows.map((r: unknown[]) => String(r[at] ?? '')))].filter(
      (v) => CYR.test(v as string),
    );
    expect(russian, `склады по-русски: ${russian.join(' | ')}`).toEqual([]);
  });

  it('в журнале движений контрагент и причина названы по-узбекски', async () => {
    const res = await api('/api/v1/warehouse/moves?limit=100', {
      headers: uz(token, companies.map((c) => c.uid)),
    });
    expect(res.status).toBe(200);
    const rows = res.body.data.rows ?? [];
    expect(rows.length).toBeGreaterThan(0);
    // Это путь через app_loc: имя колонки выбирает сама база по app.locale.
    // Контрагенты и причины заведены на двух языках, узбекские — латиницей.
    const russian = [
      ...new Set(
        rows.flatMap((r: { partner: string | null; reason: string | null }) =>
          [r.partner, r.reason].filter(Boolean),
        ),
      ),
    ].filter((v) => CYR.test(String(v)));
    expect(russian, `по-русски: ${russian.join(' | ')}`).toEqual([]);
  });

  it('список складов отдаёт оба названия', async () => {
    const res = await api('/api/v1/refs/places', {
      headers: uz(token, companies.map((c) => c.uid)),
    });
    expect(res.status).toBe(200);
    const rows = res.body.data.rows ?? res.body.data;
    const first = Array.isArray(rows) ? rows[0] : null;
    // Справочник мест — дерево: склад, его зоны и ячейки.
    expect(first, 'складов в справочнике нет').toBeTruthy();
    expect(typeof first.nameRu).toBe('string');
    expect(typeof first.nameUz).toBe('string');
    expect(first.nameUz).not.toMatch(CYR);
  });
});

describe('справочники настроек', () => {
  it('поля шаблона документа названы по-узбекски', async () => {
    // Список открыт на экране «Шаблоны»: администратор сопоставляет по нему
    // теги файла с полями системы. До правки он приходил только с titleRu, и
    // на узбекском экране весь список оставался русским.
    const res = await api('/api/v1/documents/templates/fields', {
      headers: uz(token, companies.map((c) => c.uid)),
    });
    expect(res.status).toBe(200);
    const all = [...(res.body.data.document ?? []), ...(res.body.data.line ?? [])];
    expect(all.length).toBeGreaterThan(10);
    // Каждое поле обязано прийти с подписью: пустая подпись — тот же русский
    // список на экране, только молча.
    const noTitle = all.filter((f: { title?: string }) => !String(f.title ?? '').trim());
    expect(noTitle.map((f: { name: string }) => f.name), 'поля без подписи').toEqual([]);
    const russian = all
      .map((f: { title?: string }) => String(f.title ?? ''))
      .filter((t) => CYR.test(t));
    expect(russian, `по-русски: ${russian.join(' | ')}`).toEqual([]);
  });
});

describe('ошибки на языке запроса', () => {
  it('отказ склада объясняется по-узбекски', async () => {
    const res = await api('/api/v1/warehouse/stock/write-off', {
      method: 'POST',
      headers: { ...uz(token, companies.map((c) => c.uid)), 'Content-Type': 'application/json' },
      body: JSON.stringify({ lines: [] }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const message = String(res.body?.error?.message ?? res.body?.message ?? '');
    expect(message, `ошибка пришла по-русски: ${message}`).not.toMatch(CYR);
  });
});
