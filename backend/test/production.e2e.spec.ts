import 'dotenv/config';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { AuthGuard } from '../src/auth/auth.guard.js';
import { ProductionModule } from '../src/production/production.module.js';
import { ContextMiddleware } from '../src/common/context.middleware.js';
import { EnvelopeInterceptor } from '../src/common/envelope.interceptor.js';
import { ErrorFilter } from '../src/common/error.filter.js';

/**
 * Сквозная проверка производства: приложение целиком, живая база, те же
 * политики RLS. Производство принадлежит заводу, поэтому здесь важна ещё одна
 * вещь, которой нет в продажах: менеджер торгового дома не должен видеть
 * цеховые заказы вовсе — ни списком, ни по прямой ссылке.
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
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
}, 60_000);

afterAll(async () => {
  await app?.close();
});

describe('GET /production/summary', () => {
  it('отдаёт состав заказов, выпуск, простои и загрузку участков', async () => {
    const me = await login('admin');
    const res = await api('/api/v1/production/summary?period=3m', { headers: auth(me.token) });

    expect(res.status).toBe(200);
    const d = res.body.data;

    expect(d.orders.total).toBeGreaterThan(0);
    const parts =
      d.orders.planned + d.orders.inProgress + d.orders.paused + d.orders.produced + d.orders.closed;
    expect(parts, 'разбивка по состояниям должна покрывать все заказы').toBe(d.orders.total);

    expect(d.output.length).toBeGreaterThan(0);
    expect(d.downtime.minutes).toBeGreaterThan(0);
    expect(d.workCenters.length).toBeGreaterThan(0);
  });

  it('выпуск разложен по единицам и не смешан в одну цифру', async () => {
    const me = await login('admin');
    const res = await api('/api/v1/production/summary?period=3m', { headers: auth(me.token) });

    const units = res.body.data.output.map((o: any) => o.unit);
    expect(new Set(units).size, 'единица не должна повторяться').toBe(units.length);
    for (const o of res.body.data.output) {
      expect(typeof o.good).toBe('string');
      expect(o.defectPercent === null || typeof o.defectPercent).toBeTruthy();
      if (Number(o.good) === 0) expect(o.defectPercent, 'нулевой выпуск — доли нет').toBeNull();
    }
  });

  it('простои разложены по причинам, и сумма сходится', async () => {
    const me = await login('admin');
    const res = await api('/api/v1/production/summary?period=3m', { headers: auth(me.token) });
    const d = res.body.data.downtime;

    expect(d.byReason.length).toBeGreaterThan(0);
    const minutes = d.byReason.reduce((s: number, r: any) => s + r.minutes, 0);
    const events = d.byReason.reduce((s: number, r: any) => s + r.events, 0);
    expect(minutes).toBe(d.minutes);
    expect(events).toBe(d.events);
    for (const r of d.byReason) expect(typeof r.reasonRu).toBe('string');
  });
});

describe('GET /production/orders', () => {
  it('отдаёт список заказов цеха', async () => {
    const me = await login('admin');
    const res = await api('/api/v1/production/orders?limit=100', { headers: auth(me.token) });

    expect(res.status).toBe(200);
    expect(res.body.data.rows.length).toBeGreaterThan(0);
    for (const o of res.body.data.rows) {
      expect(o.number).toMatch(/^\D+-\d+$/);
      expect(typeof o.itemNameRu).toBe('string');
      // Этапов может не быть вовсе: с появлением заведения заказов (Э1) в
      // списке законно живёт только что заведённый заказ, которому этапы ещё
      // не разворачивали. Сломанное здесь — это «сделано больше, чем всего».
      expect(o.stagesDone).toBeLessThanOrEqual(o.stagesTotal);
    }
    expect(
      res.body.data.rows.some((o: any) => o.stagesTotal > 0),
      'список обязан показывать ход по этапам хотя бы у одного заказа',
    ).toBe(true);
  });

  it('фильтр по состоянию не смешивает работу с архивом', async () => {
    const me = await login('admin');
    const active = await api('/api/v1/production/orders?state=active&limit=100', {
      headers: auth(me.token),
    });
    const done = await api('/api/v1/production/orders?state=done&limit=100', {
      headers: auth(me.token),
    });

    expect(active.body.data.rows.length).toBeGreaterThan(0);
    for (const o of active.body.data.rows) expect(['in_progress', 'paused']).toContain(o.status);
    for (const o of done.body.data.rows) expect(['produced', 'closed']).toContain(o.status);
  });

  it('незапущенный заказ не показывает выпуска', async () => {
    const me = await login('admin');
    const res = await api('/api/v1/production/orders?state=planned&limit=100', {
      headers: auth(me.token),
    });
    // Без этой строки проверка холостая: на пустом списке цикл ниже не
    // выполнится ни разу и тест будет зелёным, даже если фильтр сломан.
    expect(res.body.data.rows.length, 'запланированных заказов нет вовсе').toBeGreaterThan(0);
    for (const o of res.body.data.rows) {
      expect(Number(o.qtyProduced), `заказ ${o.number}`).toBe(0);
      expect(o.stagesDone, `заказ ${o.number}`).toBe(0);
    }
  });

  it('поиск идёт по номеру и по продукции', async () => {
    const me = await login('admin');
    const all = await api('/api/v1/production/orders?limit=100', { headers: auth(me.token) });
    const sample = all.body.data.rows[0];

    const byNumber = await api(
      `/api/v1/production/orders?search=${encodeURIComponent(sample.number)}`,
      { headers: auth(me.token) },
    );
    expect(byNumber.body.data.rows.map((o: any) => o.number)).toContain(sample.number);

    const byItem = await api(
      `/api/v1/production/orders?search=${encodeURIComponent(sample.itemCode)}&limit=100`,
      { headers: auth(me.token) },
    );
    expect(byItem.body.data.rows.length).toBeGreaterThan(0);
    for (const o of byItem.body.data.rows) expect(o.itemCode).toBe(sample.itemCode);
  });
});

describe('GET /production/orders/:uid', () => {
  it('отдаёт этапы с журналом, материалы и себестоимость', async () => {
    const me = await login('admin');
    const list = await api('/api/v1/production/orders?state=done&limit=1', {
      headers: auth(me.token),
    });
    const uid = list.body.data.rows[0].uid as string;

    const res = await api(`/api/v1/production/orders/${uid}`, { headers: auth(me.token) });
    expect(res.status).toBe(200);
    const d = res.body.data;

    expect(d.stages.length).toBeGreaterThan(0);
    expect(d.materials.length).toBeGreaterThan(0);
    for (const s of d.stages) {
      expect(s.seq).toBeGreaterThan(0);
      expect(s.events.length, `этап ${s.seq} завершён, но журнал пуст`).toBeGreaterThan(0);
      expect(s.events[0].event).toBe('start');
      expect(s.events.at(-1).event).toBe('finish');
    }
  });

  it('фактическая длительность этапа сходится с его журналом', async () => {
    const me = await login('admin');
    const list = await api('/api/v1/production/orders?state=done&limit=5', {
      headers: auth(me.token),
    });

    for (const o of list.body.data.rows) {
      const res = await api(`/api/v1/production/orders/${o.uid}`, { headers: auth(me.token) });
      for (const s of res.body.data.stages) {
        // Сумма отрезков между «начали/возобновили» и следующим событием.
        let worked = 0;
        for (let i = 0; i < s.events.length - 1; i += 1) {
          const e = s.events[i];
          if (e.event !== 'start' && e.event !== 'resume') continue;
          worked +=
            (Date.parse(s.events[i + 1].occurredAt) - Date.parse(e.occurredAt)) / 60_000;
        }
        expect(Math.round(worked), `${o.number}, этап ${s.seq}`).toBe(s.actualDurationMin);
      }
    }
  });

  it('этап на паузе показывает причину, а не просто остановку', async () => {
    const me = await login('admin');
    const list = await api('/api/v1/production/orders?state=active&limit=100', {
      headers: auth(me.token),
    });

    let seen = 0;
    for (const o of list.body.data.rows) {
      const res = await api(`/api/v1/production/orders/${o.uid}`, { headers: auth(me.token) });
      for (const s of res.body.data.stages) {
        if (s.status !== 'paused') continue;
        seen += 1;
        expect(s.pausedSince, `${o.number}, этап ${s.seq}`).toBeTruthy();
        expect(s.pauseReasonRu, `${o.number}, этап ${s.seq}`).toBeTruthy();
        expect(s.downtimeMin, `${o.number}, этап ${s.seq}`).toBeGreaterThan(0);
      }
    }
    expect(seen, 'в сиде должен быть хотя бы один этап на паузе').toBeGreaterThan(0);
  });

  it('идущий этап отдаёт время начала, а не приписанные минуты', async () => {
    const me = await login('admin');
    const list = await api('/api/v1/production/orders?state=active&limit=100', {
      headers: auth(me.token),
    });

    let seen = 0;
    for (const o of list.body.data.rows) {
      const res = await api(`/api/v1/production/orders/${o.uid}`, { headers: auth(me.token) });
      for (const s of res.body.data.stages) {
        if (s.status !== 'running') continue;
        seen += 1;
        expect(s.runningSince, `${o.number}, этап ${s.seq}`).toBeTruthy();
      }
      for (const s of res.body.data.stages) {
        if (s.status !== 'pending') continue;
        expect(s.events, `неначатый этап ${s.seq} с журналом`).toHaveLength(0);
        expect(s.actualDurationMin).toBe(0);
      }
    }
    expect(seen, 'в сиде должен быть хотя бы один идущий этап').toBeGreaterThan(0);
  });

  it('неизвестный заказ — 404, а не пустой объект', async () => {
    const me = await login('admin');
    const res = await api('/api/v1/production/orders/01999999-9999-7999-8999-999999999999', {
      headers: auth(me.token),
    });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('заказ завода не открывается в контексте торгового дома', async () => {
    const admin = await login('admin');
    const plantUid = admin.companies.find((c) => c.code === 'plant')!.uid;
    const tradeUid = admin.companies.find((c) => c.code === 'trade')!.uid;

    const list = await api('/api/v1/production/orders?limit=1', {
      headers: auth(admin.token, [plantUid]),
    });
    const uid = list.body.data.rows[0].uid as string;

    const res = await api(`/api/v1/production/orders/${uid}`, {
      headers: auth(admin.token, [tradeUid]),
    });
    expect(res.status).toBe(404);
  });
});

describe('доступ к производству', () => {
  it('менеджер торгового дома не видит цеховых заказов', async () => {
    const manager = await login('d.karimov');
    expect(manager.companies.map((c) => c.code)).toEqual(['trade']);

    const res = await api('/api/v1/production/orders?limit=100', { headers: auth(manager.token) });
    // Право на просмотр у роли есть, но чужих данных за ним нет: изоляцию
    // держит RLS, а не отсутствие кнопки.
    if (res.status === 200) expect(res.body.data.rows).toEqual([]);
    else expect(res.status).toBe(403);
  });

  it('мастер цеха открывает производство', async () => {
    const master = await login('j.tashpulatov');
    expect(master.permissions).toContain('production.view');

    const res = await api('/api/v1/production/orders?limit=10', { headers: auth(master.token) });
    expect(res.status).toBe(200);
    expect(res.body.data.rows.length).toBeGreaterThan(0);
  });

  it('без токена не отдаёт ничего', async () => {
    const res = await api('/api/v1/production/orders');
    expect(res.status).toBe(401);
  });
});
