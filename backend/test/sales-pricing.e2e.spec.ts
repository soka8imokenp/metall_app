/**
 * Прайс-лист, индивидуальная цена клиента и запрет продавать ниже
 * себестоимости (ТЗ 9.2) — приложение целиком, живая база.
 *
 * До этого этапа таблицы `price_list` и `partner_price` в базе были, но ни один
 * маршрут их не читал: цену в строке заказа менеджер набирал руками с чистого
 * листа, и проверить её было нечем. Здесь проверяется именно это: цену называет
 * система, ручной ввод требует права и основания, а продажа дешевле
 * себестоимости подчиняется настройке компании.
 *
 * Прогон ничего не ломает в демо-данных: заведённые строки прайса и цены
 * клиента снимаются тем же маршрутом (он возвращает прежней строке открытый
 * период), настройка компании возвращается, а заказы остаются черновиками —
 * товар они не двигают.
 */
import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { AuthGuard } from '../src/auth/auth.guard.js';
import { SalesModule } from '../src/sales/sales.module.js';
import { RefsModule } from '../src/refs/refs.module.js';
import { ContextMiddleware } from '../src/common/context.middleware.js';
import { EnvelopeInterceptor } from '../src/common/envelope.interceptor.js';
import { ErrorFilter } from '../src/common/error.filter.js';

let app: INestApplication;
let base: string;

const PASSWORD = process.env.SEED_PASSWORD ?? 'metall-dev-2026';
const RUN = Date.now().toString(36).toUpperCase();

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
  return res.body.data as { token: string; permissions: string[]; companies: { uid: string; code: string }[] };
}

const auth = (token: string, companyUid?: string) => ({
  Authorization: `Bearer ${token}`,
  ...(companyUid ? { 'X-Company-Id': companyUid } : {}),
});
const json = (token: string, companyUid?: string) => ({
  ...auth(token, companyUid),
  'Content-Type': 'application/json',
});

let seller: Awaited<ReturnType<typeof login>>;
let director: Awaited<ReturnType<typeof login>>;

let company: { uid: string; code: string };
let partnerUid: string;
let itemCode: string;
let priceTypeCode: string;
/** Цена позиции в прайсе по типу цен клиента и её себестоимость на складе. */
let listPrice: number;
let cost: number;
/** Что вернуть после прогона. */
const cleanup: { path: string }[] = [];
let settingsRestored = false;

const day = (shift: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + shift);
  return d.toISOString().slice(0, 10);
};

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [PrismaModule, AuthModule, SalesModule, RefsModule],
    providers: [
      { provide: APP_GUARD, useClass: AuthGuard },
      { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
      { provide: APP_FILTER, useClass: ErrorFilter },
    ],
  }).compile();

  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  app.use(new ContextMiddleware().use);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(0);
  base = await app.getUrl();

  seller = await login('d.karimov');
  director = await login('s.radjabov');
  company = director.companies.find((c) => c.code === 'trade') ?? director.companies[0]!;

  // Клиент этой компании и позиция, у которой есть и цена в прайсе, и остаток
  // на складе: без остатка сравнивать цену с себестоимостью не с чем, и
  // половина проверок потеряла бы смысл.
  const refs = await api(`/api/v1/sales/refs`, { headers: auth(director.token, company.uid) });
  partnerUid = refs.body.data.partners.find((p: any) => p.companyUid === company.uid).uid;
  const candidates: { code: string }[] = refs.body.data.items.filter(
    (i: any) => i.companyUid === company.uid,
  );
  for (const cand of candidates) {
    const hint = await api(
      `/api/v1/sales/price?partnerUid=${partnerUid}&itemCode=${encodeURIComponent(cand.code)}`,
      { headers: auth(director.token, company.uid) },
    );
    if (hint.status !== 200) continue;
    const d = hint.body.data;
    if (d.price !== null && d.cost !== null && d.source === 'list') {
      itemCode = cand.code;
      listPrice = d.price;
      cost = d.cost;
      priceTypeCode = d.priceTypeCode;
      break;
    }
  }
  if (!itemCode) throw new Error('Не нашёл позицию с ценой в прайсе и остатком на складе');
});

afterAll(async () => {
  for (const c of cleanup.reverse()) {
    await api(c.path, { method: 'DELETE', headers: auth(director.token, company.uid) });
  }
  if (settingsRestored) {
    await api('/api/v1/refs/settings', {
      method: 'PATCH',
      headers: json(director.token, company.uid),
      body: JSON.stringify({ companyUid: company.uid, belowCostMode: 'block' }),
    });
  }
  await app?.close();
});

const order = (
  token: string,
  line: Record<string, unknown>,
  comment = `Проверка цены ${RUN}`,
) =>
  api('/api/v1/sales/orders', {
    method: 'POST',
    headers: json(token, company.uid),
    body: JSON.stringify({
      companyUid: company.uid,
      partnerUid,
      comment,
      lines: [{ itemCode, qty: '1', ...line }],
    }),
  });

describe('прайс-лист (ТЗ 9.2)', () => {
  it('отдаёт матрицу «позиция × тип цены» с ценой на дату', async () => {
    const res = await api(`/api/v1/refs/prices?search=${encodeURIComponent(itemCode)}&limit=5`, {
      headers: auth(director.token, company.uid),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const d = res.body.data;
    expect(d.types.length, 'типы цен не отданы — матрицу нечем озаглавить').toBeGreaterThan(0);
    const row = d.rows.find((r: any) => r.item.code === itemCode);
    expect(row, `позиции ${itemCode} нет в прайсе`).toBeTruthy();
    const cell = Object.values(row.prices)[0] as any;
    expect(cell?.price, 'в клетке матрицы нет цены').toBeGreaterThan(0);
    expect(cell?.validFrom, 'у цены нет даты начала действия').toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('подсказка цены называет источник и себестоимость', async () => {
    const res = await api(
      `/api/v1/sales/price?partnerUid=${partnerUid}&itemCode=${encodeURIComponent(itemCode)}`,
      { headers: auth(seller.token, company.uid) },
    );
    expect(res.status).toBe(200);
    expect(res.body.data.source).toBe('list');
    expect(res.body.data.price).toBe(listPrice);
    expect(res.body.data.priceTypeCode, 'не сказано, по какому типу цен').toBeTruthy();
    expect(res.body.data.cost, 'не сказана себестоимость').toBeGreaterThan(0);
  });

  it('новая цена закрывает прежнюю, а задним числом не принимается', async () => {
    const created = await api('/api/v1/refs/prices', {
      method: 'POST',
      headers: json(director.token, company.uid),
      body: JSON.stringify({
        companyUid: company.uid,
        itemCode,
        priceTypeCode,
        price: listPrice * 1.05,
        validFrom: day(1),
      }),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data.closedPrevious, 'прежняя цена осталась без даты окончания').toBe(true);
    cleanup.push({ path: `/api/v1/refs/prices/${created.body.data.uid}` });

    const history = await api(
      `/api/v1/refs/prices/history?itemUid=${(
        await api(`/api/v1/refs/prices?search=${encodeURIComponent(itemCode)}&limit=5`, {
          headers: auth(director.token, company.uid),
        })
      ).body.data.rows.find((r: any) => r.item.code === itemCode).item.uid}&priceTypeUid=${
        (
          await api('/api/v1/refs/price-types', { headers: auth(director.token, company.uid) })
        ).body.data.rows.find((t: any) => t.code === priceTypeCode).uid
      }`,
      { headers: auth(director.token, company.uid) },
    );
    expect(history.body.data.rows.length, 'история цены пуста').toBeGreaterThan(1);
    expect(history.body.data.rows[0].validTo, 'последняя цена не должна быть закрыта').toBeNull();

    const back = await api('/api/v1/refs/prices', {
      method: 'POST',
      headers: json(director.token, company.uid),
      body: JSON.stringify({
        companyUid: company.uid,
        itemCode,
        priceTypeCode,
        price: listPrice,
        validFrom: day(-10),
      }),
    });
    expect(back.status, 'цена задним числом переписала бы прошлые заказы').toBe(422);
    expect(JSON.stringify(back.body)).toMatch(/прошлое не переписываем/);
  });

  it('менеджеру прайс править нечем', async () => {
    const res = await api('/api/v1/refs/prices', {
      method: 'POST',
      headers: json(seller.token, company.uid),
      body: JSON.stringify({ companyUid: company.uid, itemCode, priceTypeCode, price: 1 }),
    });
    expect(res.status).toBe(403);
  });
});

describe('цена в заказе (ТЗ 9.2)', () => {
  it('без цены в строке подставляет прайс и помечает источник', async () => {
    const res = await order(seller.token, {});
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const card = await api(`/api/v1/sales/orders/${res.body.data.uid}`, {
      headers: auth(seller.token, company.uid),
    });
    const line = card.body.data.lines[0];
    expect(Number(line.price)).toBe(listPrice);
    expect(line.priceSource).toBe('list');
    expect(Number(line.listPrice)).toBe(listPrice);
    expect(line.priceComment).toBeNull();
  });

  it('ручная цена без основания не принимается', async () => {
    const res = await order(director.token, { price: String(listPrice * 1.2) });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toMatch(/напишите основание/);
  });

  it('менеджеру цену мимо прайса ставить нельзя', async () => {
    const res = await order(seller.token, {
      price: String(listPrice * 1.2),
      priceComment: 'Клиент согласовал дороже',
    });
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toMatch(/sales\.price/);
  });

  it('руководителю можно, и основание остаётся в строке', async () => {
    const res = await order(director.token, {
      price: String(listPrice * 1.2),
      priceComment: `Срочная поставка, доставка наша ${RUN}`,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const card = await api(`/api/v1/sales/orders/${res.body.data.uid}`, {
      headers: auth(director.token, company.uid),
    });
    const line = card.body.data.lines[0];
    expect(line.priceSource).toBe('manual');
    expect(line.priceComment).toContain(RUN);
    expect(Number(line.listPrice), 'не записано, что показывал прайс').toBe(listPrice);
    expect(Number(line.costRef), 'не записано, с какой себестоимостью сравнивали').toBeGreaterThan(0);
  });

  it('индивидуальная цена клиента перекрывает прайс', async () => {
    const own = listPrice * 0.99 > cost ? listPrice * 0.99 : cost * 1.01;
    const created = await api('/api/v1/refs/partner-prices', {
      method: 'POST',
      headers: json(director.token, company.uid),
      body: JSON.stringify({ companyUid: company.uid, partnerUid, itemCode, price: own }),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    cleanup.push({ path: `/api/v1/refs/partner-prices/${created.body.data.uid}` });

    const hint = await api(
      `/api/v1/sales/price?partnerUid=${partnerUid}&itemCode=${encodeURIComponent(itemCode)}`,
      { headers: auth(seller.token, company.uid) },
    );
    expect(hint.body.data.source).toBe('partner');
    expect(hint.body.data.price).toBe(Math.round(own * 1e4) / 1e4);

    const res = await order(seller.token, {});
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const card = await api(`/api/v1/sales/orders/${res.body.data.uid}`, {
      headers: auth(seller.token, company.uid),
    });
    expect(card.body.data.lines[0].priceSource).toBe('partner');
  });
});

describe('ниже себестоимости (ТЗ 9.2)', () => {
  it('при запрете не проходит ни у кого, и причина названа числами', async () => {
    const res = await order(director.token, {
      price: Math.max(cost * 0.5, 1).toFixed(2),
      priceComment: 'Проверка запрета',
    });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toMatch(/ниже себестоимости/);
    // Отказ обязан назвать обе цифры: «столько просят против такой
    // себестоимости». Отказ без чисел менеджер не может ни проверить, ни
    // оспорить.
    expect(JSON.stringify(res.body)).toMatch(/против себестоимости \d/);
  });

  it('скидка тоже считается: цена выше себестоимости, а со скидкой ниже', async () => {
    const price = (cost * 1.05).toFixed(2);
    const res = await order(director.token, {
      price: price,
      discountPercent: '30',
      priceComment: 'Проверка скидки',
    });
    expect(res.status, 'скидку мимо себестоимости пропустили').toBe(422);
  });

  it('в режиме «по праву» проходит у руководителя и не проходит у менеджера', async () => {
    const patch = await api('/api/v1/refs/settings', {
      method: 'PATCH',
      headers: json(director.token, company.uid),
      body: JSON.stringify({ companyUid: company.uid, belowCostMode: 'approve' }),
    });
    expect(patch.status, JSON.stringify(patch.body)).toBe(200);
    expect(patch.body.data.belowCostMode).toBe('approve');
    settingsRestored = true;

    const cheap = Math.max(cost * 0.9, 1).toFixed(2);
    const ok = await order(director.token, {
      price: cheap,
      priceComment: 'Убыток согласован: закрываем остаток склада',
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);

    // Менеджеру нельзя и в этом режиме. Какое именно право назовёт сервер,
    // зависит от порядка проверок (цена мимо прайса — тоже право), поэтому
    // проверяем не текст, а то, что отказ назвал недостающее право.
    const denied = await order(seller.token, {
      price: cheap,
      priceComment: 'Хочу продать дешевле',
    });
    expect(denied.status).toBe(403);
    expect(JSON.stringify(denied.body)).toMatch(/нужно право/);
  });
});
