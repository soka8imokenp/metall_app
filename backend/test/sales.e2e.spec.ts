import 'dotenv/config';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { AuthGuard } from '../src/auth/auth.guard.js';
import { SalesModule } from '../src/sales/sales.module.js';
import { ContextMiddleware } from '../src/common/context.middleware.js';
import { EnvelopeInterceptor } from '../src/common/envelope.interceptor.js';
import { ErrorFilter } from '../src/common/error.filter.js';

/**
 * Сквозная проверка продаж: приложение целиком, живая база, те же политики RLS.
 * Ничего не подменяем — иначе проверяется не то, что работает у пользователя.
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
    imports: [PrismaModule, AuthModule, SalesModule],
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

describe('GET /sales/summary', () => {
  it('отдаёт портфель, исполнение и ряд погрузки за период', async () => {
    const me = await login('admin');
    const res = await api('/api/v1/sales/summary?period=30d', { headers: auth(me.token) });

    expect(res.status).toBe(200);
    const d = res.body.data;

    expect(typeof d.portfolio.totalAmount).toBe('string');
    expect(typeof d.portfolio.paidAmount).toBe('string');
    expect(typeof d.portfolio.overdueAmount).toBe('string');
    expect(d.portfolio.activeOrders).toBeGreaterThan(0);

    expect(d.fulfillment.totalOrders).toBeGreaterThan(0);
    expect(Number(d.fulfillment.closedPercent)).toBeGreaterThanOrEqual(0);

    // Ряд погрузки — ровно длина периода, дни без рейсов остаются нулями.
    expect(d.loading.series).toHaveLength(30);
    for (const p of d.loading.series) expect(typeof p.netTons).toBe('string');
  });

  it('опорная линия — среднее за период, а не выдуманная норма', async () => {
    const me = await login('admin');
    const res = await api('/api/v1/sales/summary?period=30d', { headers: auth(me.token) });
    const d = res.body.data;

    const sum = d.loading.series.reduce((s: number, p: any) => s + Number(p.netTons), 0);
    const avg = sum / d.loading.series.length;
    expect(Number(d.loading.averagePerDay)).toBeCloseTo(avg, 2);
    for (const p of d.loading.series) {
      expect(Number(p.baselineTons)).toBeCloseTo(avg, 2);
    }
  });

  it('оплачено и просрочено не больше портфеля', async () => {
    const me = await login('admin');
    const res = await api('/api/v1/sales/summary?period=30d', { headers: auth(me.token) });
    const p = res.body.data.portfolio;

    expect(Number(p.paidAmount)).toBeLessThanOrEqual(Number(p.totalAmount));
    expect(Number(p.overdueAmount)).toBeLessThanOrEqual(Number(p.totalAmount));
  });

  it('в подписях дробная часть отделяется запятой, а в машинных полях точкой', async () => {
    const me = await login('admin');
    const res = await api('/api/v1/sales/summary?period=30d', { headers: auth(me.token) });
    const p = res.body.data.portfolio;

    for (const text of [p.sub1Ru, p.sub1Uz, p.sub2Ru, p.sub2Uz]) {
      expect(text, `подпись «${text}»`).not.toMatch(/\d\.\d/);
    }
    expect(Number.isFinite(Number(p.totalAmount))).toBe(true);
    expect(Number.isFinite(Number(p.paidPercent))).toBe(true);
  });

  it('отклоняет неизвестный период', async () => {
    const me = await login('admin');
    const res = await api('/api/v1/sales/summary?period=век', { headers: auth(me.token) });
    expect(res.status).toBe(400);
  });
});

describe('GET /sales/orders', () => {
  it('отдаёт список с машинными суммами и разобранными статусами', async () => {
    const me = await login('admin');
    const res = await api('/api/v1/sales/orders?limit=20', { headers: auth(me.token) });

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data.length).toBeLessThanOrEqual(20);

    for (const o of res.body.data) {
      expect(typeof o.uid).toBe('string');
      expect(typeof o.amountTotal).toBe('string');
      expect(typeof o.paidAmount).toBe('string');
      expect(o.partnerName.length).toBeGreaterThan(0);
      expect(['draft', 'confirmed', 'reserved', 'in_production', 'picking', 'shipped', 'closed', 'cancelled'])
        .toContain(o.status);
    }
  });

  it('этап «оплачен» отдаёт только оплаченные', async () => {
    const me = await login('admin');
    const res = await api('/api/v1/sales/orders?stage=paid&limit=50', { headers: auth(me.token) });

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    for (const o of res.body.data) expect(o.paymentStatus).toBe('paid');
  });

  it('этап «ожидает оплаты» не отдаёт оплаченные', async () => {
    const me = await login('admin');
    const res = await api('/api/v1/sales/orders?stage=unpaid&limit=50', { headers: auth(me.token) });

    expect(res.status).toBe(200);
    for (const o of res.body.data) expect(o.paymentStatus).not.toBe('paid');
  });

  it('поиск по номеру заказа сужает выборку', async () => {
    const me = await login('admin');
    const all = await api('/api/v1/sales/orders?limit=5', { headers: auth(me.token) });
    const number = all.body.data[0].number as string;

    const res = await api(`/api/v1/sales/orders?search=${encodeURIComponent(number)}`, {
      headers: auth(me.token),
    });
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    for (const o of res.body.data) {
      expect(`${o.number} ${o.partnerName}`.toLowerCase()).toContain(number.toLowerCase());
    }
  });

  it('отклоняет посторонний параметр запроса', async () => {
    const me = await login('admin');
    const res = await api('/api/v1/sales/orders?выдумка=1', { headers: auth(me.token) });
    expect(res.status).toBe(400);
  });

  it('без токена не отдаёт ничего', async () => {
    const res = await api('/api/v1/sales/orders');
    expect(res.status).toBe(401);
  });
});

describe('GET /sales/orders/{uid}', () => {
  it('отдаёт спецификацию, и сумма строк сходится с суммой заказа', async () => {
    const me = await login('admin');
    const list = await api('/api/v1/sales/orders?limit=10', { headers: auth(me.token) });
    const uid = list.body.data[0].uid as string;

    const res = await api(`/api/v1/sales/orders/${uid}`, { headers: auth(me.token) });
    expect(res.status).toBe(200);

    const d = res.body.data;
    expect(d.lines.length).toBeGreaterThan(0);
    expect(d.partner.inn === null || typeof d.partner.inn === 'string').toBe(true);

    const net = d.lines.reduce((s: number, l: any) => s + Number(l.amountNet), 0);
    expect(Number(d.amountNet)).toBeCloseTo(net, 2);

    const total = d.lines.reduce((s: number, l: any) => s + Number(l.amountTotal), 0);
    expect(Number(d.amountTotal)).toBeCloseTo(total, 2);
  });

  it('неизвестный заказ — 404, а не пустой объект', async () => {
    const me = await login('admin');
    const res = await api('/api/v1/sales/orders/01999999-9999-7999-8999-999999999999', {
      headers: auth(me.token),
    });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('заказ чужой компании не открывается даже по прямой ссылке', async () => {
    const admin = await login('admin');
    const plantUid = admin.companies.find((c) => c.code === 'plant')!.uid;
    const tradeUid = admin.companies.find((c) => c.code === 'trade')!.uid;

    const plantOrders = await api('/api/v1/sales/orders?limit=1', {
      headers: auth(admin.token, [plantUid]),
    });
    const uid = plantOrders.body.data[0].uid as string;

    const res = await api(`/api/v1/sales/orders/${uid}`, { headers: auth(admin.token, [tradeUid]) });
    expect(res.status).toBe(404);
  });

  it('менеджер торгового дома не видит заказов завода', async () => {
    const manager = await login('d.karimov');
    expect(manager.companies.map((c) => c.code)).toEqual(['trade']);

    const res = await api('/api/v1/sales/orders?limit=100', { headers: auth(manager.token) });
    expect(res.status).toBe(200);
    for (const o of res.body.data) expect(o.enterprise).toBe('trade');
  });
});

describe('GET /sales/shipments', () => {
  it('отдаёт журнал ТТН с весом и машиной', async () => {
    const me = await login('admin');
    const res = await api('/api/v1/sales/shipments?limit=20', { headers: auth(me.token) });

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    for (const s of res.body.data) {
      expect(typeof s.number).toBe('string');
      expect(typeof s.orderNumber).toBe('string');
      expect(s.netWeightT === null || typeof s.netWeightT === 'string').toBe(true);
      expect(s.linesCount).toBeGreaterThan(0);
    }
  });

  it('рейсы отсортированы от свежих к старым', async () => {
    const me = await login('admin');
    const res = await api('/api/v1/sales/shipments?limit=20', { headers: auth(me.token) });
    const dates = res.body.data.map((s: any) => s.shippedAt);
    expect([...dates].sort().reverse()).toEqual(dates);
  });
});

describe('GET /sales/partners', () => {
  it('отдаёт покупателей с лимитом и выборкой', async () => {
    const me = await login('admin');
    const res = await api('/api/v1/sales/partners?limit=20', { headers: auth(me.token) });

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    for (const p of res.body.data) {
      expect(typeof p.debtLimit).toBe('string');
      expect(typeof p.receivable).toBe('string');
      expect(p.usedPercent === null || typeof p.usedPercent === 'string').toBe(true);
    }
  });

  it('доля выборки сходится с лимитом и задолженностью', async () => {
    const me = await login('admin');
    const res = await api('/api/v1/sales/partners?limit=100', { headers: auth(me.token) });

    // Лимит задан у всех посеянных покупателей, но в базе разработки живут и
    // клиенты, заведённые соседними прогонами, — у них лимита нет. Это не
    // дефект продаж: без лимита доля не считается вовсе, и экран обязан
    // показать прочерк, а не ноль процентов. Проверяем обе ветки.
    let withLimit = 0;
    for (const p of res.body.data) {
      const limit = Number(p.debtLimit);
      if (limit === 0) {
        expect(p.usedPercent, `покупатель ${p.nameRu}: доли без лимита быть не может`).toBeNull();
        continue;
      }
      withLimit += 1;
      expect(Number(p.usedPercent)).toBeCloseTo((Number(p.receivable) / limit) * 100, 1);
    }
    expect(withLimit, 'ни у одного покупателя нет лимита — проверять нечего').toBeGreaterThan(0);
  });
});
