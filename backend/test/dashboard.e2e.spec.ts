import 'dotenv/config';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { AuthGuard } from '../src/auth/auth.guard.js';
import { DashboardModule } from '../src/dashboard/dashboard.module.js';
import { ContextMiddleware } from '../src/common/context.middleware.js';
import { EnvelopeInterceptor } from '../src/common/envelope.interceptor.js';
import { ErrorFilter } from '../src/common/error.filter.js';

/**
 * Сквозная проверка дашборда: поднимаем приложение целиком, логинимся живым
 * пользователем из сида и ходим в эндпоинты по HTTP. Ничего не подменяем —
 * запросы идут в ту же базу и через те же политики RLS, что и в работе.
 */
let app: INestApplication;
let base: string;

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

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [PrismaModule, AuthModule, DashboardModule],
    providers: [
      { provide: APP_GUARD, useClass: AuthGuard },
      { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
      { provide: APP_FILTER, useClass: ErrorFilter },
    ],
  }).compile();

  app = moduleRef.createNestApplication();
  app.use(new ContextMiddleware().use.bind(new ContextMiddleware()));
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
}, 60_000);

afterAll(async () => {
  await app?.close();
});

describe('аутентификация', () => {
  it('пускает админа и отдаёт его компании и права', async () => {
    const me = await login('admin');
    expect(me.token).toMatch(/\./);
    expect(me.companies.map((c) => c.code).sort()).toEqual(['plant', 'trade']);
    expect(me.permissions).toContain('dashboard.view');
  });

  it('не пускает с неверным паролем', async () => {
    const res = await api('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: 'admin', password: 'нет-такого-пароля' }),
    });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  // Вход не судит длину пароля: какой пароль заведён, тем и входят. Требование
  // минимальной длины на этом маршруте отбивало короткий пароль 400 ещё до
  // сверки хеша — учётку с коротким паролем нельзя было использовать вовсе,
  // хотя хеш в базе правильный. Заодно 400 вместо 401 подсказывает
  // подбирающему, что пароль не той длины.
  it('короткий пароль доходит до сверки хеша, а не отбивается валидацией', async () => {
    const res = await api('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: 'admin', password: 'admin' }),
    });
    expect(res.status, 'пятисимвольный пароль не должен давать 400').not.toBe(400);
    expect([200, 201, 401]).toContain(res.status);
  });

  it('не пускает с пустым паролем', async () => {
    const res = await api('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: 'admin', password: '' }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('не пускает без токена', async () => {
    const res = await api('/api/v1/dashboard/summary');
    expect(res.status).toBe(401);
  });
});

describe('GET /dashboard/summary', () => {
  it('в холдинге отдаёт 4 KPI и ряд графика за период', async () => {
    const me = await login('admin');
    const res = await api('/api/v1/dashboard/summary?period=30d', { headers: auth(me.token) });

    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.scope).toBe('holding');
    expect(d.kpis).toHaveLength(4);
    expect(d.chart).toHaveLength(30);

    // Все величины — строки: деньги и тонны не уходят числами JS.
    for (const k of d.kpis) expect(typeof k.value).toBe('string');
    for (const p of d.chart) expect(typeof p.totalRevenue).toBe('string');
  });

  it('период меняет длину ряда', async () => {
    const me = await login('admin');
    for (const [period, len] of [['7d', 7], ['30d', 30], ['3m', 90]] as const) {
      const res = await api(`/api/v1/dashboard/summary?period=${period}`, { headers: auth(me.token) });
      expect(res.body.data.chart).toHaveLength(len);
    }
  });

  it('отклоняет неизвестный период', async () => {
    const me = await login('admin');
    const res = await api('/api/v1/dashboard/summary?period=1y', { headers: auth(me.token) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('X-Company-Id сужает выборку: одна компания даёт меньше выручки, чем холдинг', async () => {
    const me = await login('admin');
    const trade = me.companies.find((c) => c.code === 'trade')!;

    const all = await api('/api/v1/dashboard/summary?period=30d', { headers: auth(me.token) });
    const one = await api('/api/v1/dashboard/summary?period=30d', {
      headers: auth(me.token, [trade.uid]),
    });

    expect(one.body.data.scope).toBe('trade');
    expect(one.body.data.companies).toHaveLength(1);
    expect(Number(one.body.data.kpis[0].value)).toBeLessThan(Number(all.body.data.kpis[0].value));
    expect(Number(one.body.data.kpis[0].value)).toBeGreaterThan(0);

    // В выборке одной компании чужих тонн быть не должно.
    const plantTons = one.body.data.chart.reduce((s: number, p: any) => s + Number(p.plantTons), 0);
    expect(plantTons).toBe(0);
  });

  it('сумма по компаниям на графике равна итогу дня', async () => {
    const me = await login('admin');
    const res = await api('/api/v1/dashboard/summary?period=30d', { headers: auth(me.token) });
    for (const p of res.body.data.chart) {
      const revenue = Number(p.plantRevenue) + Number(p.tradeRevenue);
      const tons = Number(p.plantTons) + Number(p.tradeTons);
      expect(Math.abs(revenue - Number(p.totalRevenue))).toBeLessThan(0.02);
      expect(Math.abs(tons - Number(p.totalTons))).toBeLessThan(0.2);
    }
  });

  it('ряд графика сходится с карточкой выручки за тот же период', async () => {
    const me = await login('admin');
    const res = await api('/api/v1/dashboard/summary?period=30d', { headers: auth(me.token) });
    const d = res.body.data;

    const fromChart = d.chart.reduce((s: number, p: any) => s + Number(p.totalRevenue), 0);
    const fromKpi = Number(d.kpis.find((k: any) => k.key === 'revenue').value);

    // Обе величины в млрд сумов; расхождение допускаем только на округлении
    // подневных сумм до копеек миллиарда.
    expect(Math.abs(fromChart - fromKpi)).toBeLessThan(0.5);
    expect(fromKpi).toBeGreaterThan(0);
  });

  it('ряд графика сходится с карточкой отгрузок за тот же период', async () => {
    const me = await login('admin');
    const res = await api('/api/v1/dashboard/summary?period=30d', { headers: auth(me.token) });
    const d = res.body.data;

    const fromChart = d.chart.reduce((s: number, p: any) => s + Number(p.totalTons), 0);
    const fromKpi = Number(d.kpis.find((k: any) => k.key === 'shipped_tons').value);

    expect(Math.abs(fromChart - fromKpi) / fromKpi).toBeLessThan(0.02);
    expect(fromKpi).toBeGreaterThan(0);
  });
});

describe('GET /dashboard/plan', () => {
  it('отдаёт строки плана с планом и фактом', async () => {
    const me = await login('admin');
    const res = await api('/api/v1/dashboard/plan?tab=plan&limit=20', { headers: auth(me.token) });

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data.length).toBeLessThanOrEqual(20);

    for (const row of res.body.data) {
      expect(['production', 'supply']).toContain(row.kind);
      expect(row.status).toBe('in_process');
      expect(typeof row.planQty).toBe('string');
      expect(Number(row.planQty)).toBeGreaterThan(0);
    }
  });

  it('вкладка выполненных отдаёт только закрытые строки', async () => {
    const me = await login('admin');
    const res = await api('/api/v1/dashboard/plan?tab=done&limit=20', { headers: auth(me.token) });
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    for (const row of res.body.data) expect(row.status).toBe('done');
  });

  it('отклоняет посторонний параметр запроса', async () => {
    const me = await login('admin');
    const res = await api('/api/v1/dashboard/plan?tab=plan&drop=table', { headers: auth(me.token) });
    expect(res.status).toBe(400);
  });
});

describe('права и изоляция компаний', () => {
  it('кладовщик не видит финансовый блок, бухгалтер видит', async () => {
    const keeper = await login('a.saidov');
    const accountant = await login('m.rahimova');

    expect(keeper.permissions).not.toContain('finance.view');
    expect(accountant.permissions).toContain('finance.view');

    const asKeeper = await api('/api/v1/dashboard/summary', { headers: auth(keeper.token) });
    const asAccountant = await api('/api/v1/dashboard/summary', { headers: auth(accountant.token) });

    expect(asKeeper.body.data.permissions.canViewFinance).toBe(false);
    expect(asAccountant.body.data.permissions.canViewFinance).toBe(true);
  });

  it('пользователь одной компании видит только её', async () => {
    const me = await login('b.ergashev');
    expect(me.companies.map((c) => c.code)).toEqual(['plant']);

    const res = await api('/api/v1/dashboard/summary?period=30d', { headers: auth(me.token) });
    expect(res.body.data.scope).toBe('plant');

    const tradeTons = res.body.data.chart.reduce((s: number, p: any) => s + Number(p.tradeTons), 0);
    const tradeRevenue = res.body.data.chart.reduce((s: number, p: any) => s + Number(p.tradeRevenue), 0);
    expect(tradeTons).toBe(0);
    expect(tradeRevenue).toBe(0);
  });

  it('заголовком X-Company-Id нельзя открыть чужую компанию', async () => {
    const admin = await login('admin');
    const trade = admin.companies.find((c) => c.code === 'trade')!;

    const me = await login('b.ergashev');
    const res = await api('/api/v1/dashboard/summary', { headers: auth(me.token, [trade.uid]) });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  /**
   * Заголовок приходит снаружи, и в нём может оказаться что угодно. Столбец
   * `uid` — uuid, поэтому нечитаемое значение роняет сам запрос к базе: наружу
   * уходит 500, в журнал — стек Prisma. Пятисотка на кривой ввод прячет
   * настоящие сбои в том же журнале и говорит зовущему «сломались мы», хотя
   * сломан его запрос.
   *
   * Поимённо проверяем `company_trade`: это ключ переключателя в интерфейсе,
   * и однажды он уже приезжал в заголовок вместо uid.
   *
   * Значения только ASCII, и это не лень: заголовок HTTP — ByteString, кириллицу
   * `fetch` в него не положит вовсе и падает ещё до отправки. Русский мусор сюда
   * просто не доедет, проверять его нечем.
   */
  it('нечитаемый X-Company-Id отвергается, а не роняет запрос', async () => {
    const me = await login('admin');

    for (const value of ['company_trade', 'not-a-uuid', '123', '../../etc/passwd']) {
      const res = await api('/api/v1/dashboard/summary', {
        headers: { Authorization: `Bearer ${me.token}`, 'X-Company-Id': value },
      });
      expect(res.status, `X-Company-Id: ${value}`).toBe(400);
      expect(res.body.error.code, `X-Company-Id: ${value}`).toBe('VALIDATION_ERROR');
    }
  });

  it('годный uid среди мусора не спасает заголовок целиком', async () => {
    const me = await login('admin');
    const trade = me.companies.find((c) => c.code === 'trade')!;

    const res = await api('/api/v1/dashboard/summary', {
      headers: { Authorization: `Bearer ${me.token}`, 'X-Company-Id': `${trade.uid},garbage` },
    });
    // Молча отбросить непонятную половину значит сузить доступ не туда, куда
    // просили, и промолчать об этом.
    expect(res.status).toBe(400);
  });
});

describe('честность карточек', () => {
  it('у складского остатка прироста нет: deltaPercent === null', async () => {
    const me = await login('admin');
    const res = await api('/api/v1/dashboard/summary?period=30d', { headers: auth(me.token) });

    const stock = res.body.data.kpis.find((k: any) => k.key === 'goods_stock' || k.key === 'raw_stock');
    expect(stock).toBeDefined();
    // Остаток — срез на сегодня, сравнивать его с «прошлым периодом» не с чем.
    // Нулевой прирост со стрелкой вверх читался бы как «динамика нулевая».
    expect(stock.deltaPercent).toBeNull();
  });

  it('у остальных карточек прирост есть и он разбирается в число', async () => {
    const me = await login('admin');
    const res = await api('/api/v1/dashboard/summary?period=30d', { headers: auth(me.token) });

    const others = res.body.data.kpis.filter(
      (k: any) => k.key !== 'goods_stock' && k.key !== 'raw_stock',
    );
    expect(others.length).toBe(3);
    for (const k of others) {
      expect(k.deltaPercent).not.toBeNull();
      expect(Number.isFinite(Number(k.deltaPercent))).toBe(true);
    }
  });

  it('в подписях дробная часть отделяется запятой, а в машинных полях точкой', async () => {
    const me = await login('admin');
    const res = await api('/api/v1/dashboard/summary?period=30d', { headers: auth(me.token) });

    for (const k of res.body.data.kpis) {
      for (const text of [k.sub1Ru, k.sub1Uz, k.sub2Ru, k.sub2Uz]) {
        // Подпись — готовый текст для человека: «77,9% заказов», не «77.9%».
        expect(text, `подпись «${text}» карточки ${k.key}`).not.toMatch(/\d\.\d/);
      }
      // value и deltaPercent разбирает фронт — там точка обязательна.
      expect(Number.isFinite(Number(k.value))).toBe(true);
    }
  });
});
