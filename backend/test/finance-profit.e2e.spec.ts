/**
 * Прибыль учредителей не показывается тем, кому её видеть не положено.
 *
 * Требование заказчика со встречи 07.10.2026 (Хуршид, реплики 129–140):
 * финансист видит финансовую аналитику, но **не чистую прибыль учредителей**;
 * то же про завскладом. Разбор — `dev/.notes/vstrecha-07-10-trebovaniya.md` §3.
 *
 * До этого право `finance.view` отдавало все восемь отчётов целиком, и прибыль
 * бухгалтер видел в трёх из них: «Прибыли и убытки», «Маржа» и «Сводный».
 *
 * Проверяется то, чем прибыль действительно закрыта:
 *
 *   - два отчёта, предмет которых и есть прибыль, не отдаются без права
 *     `finance.profit.view` — ни ответом, ни файлом;
 *   - в сводном отчёте пропадает весь раздел «Результат», а не одна строка
 *     «Операционная прибыль»: выручка минус себестоимость — это прибыль,
 *     посчитанная вычитанием двух оставленных строк;
 *   - остальная аналитика (деньги, задолженность, бюджет) остаётся на месте:
 *     заказчик просил спрятать прибыль, а не закрыть финансы;
 *   - у директора всё это видно.
 *
 * Прогон ничего не пишет: отчёты только читают.
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
import { FinanceModule } from '../src/finance/finance.module.js';
import { ContextMiddleware } from '../src/common/context.middleware.js';
import { EnvelopeInterceptor } from '../src/common/envelope.interceptor.js';
import { ErrorFilter } from '../src/common/error.filter.js';

let app: INestApplication;
let base: string;

const PASSWORD = process.env.SEED_PASSWORD ?? 'metall-dev-2026';

/** Право на финансовый результат: прибыль, маржа и раздел «Результат». */
const PROFIT = 'finance.profit.view';

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
  return res.body.data as { token: string; permissions: string[] };
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Бухгалтер — тот, у кого финансы есть, а прибыли быть не должно. */
let accountant: Awaited<ReturnType<typeof login>>;
/** Директор — тот, у кого прибыль остаётся. */
let director: Awaited<ReturnType<typeof login>>;

const WIDE = 'from=2026-01-01&to=2026-12-31';

interface ReportBody {
  kind: string;
  subtitle: string;
  rows: (string | number | null)[][];
  totals: Record<string, number>;
}

async function summaryFor(token: string) {
  const res = await api(`/api/v1/finance/reports/summary?${WIDE}`, { headers: auth(token) });
  if (res.status !== 200) {
    throw new Error(`Сводный отчёт не прочитался: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.data as ReportBody;
}

/** Раздел строки — первая колонка сводного отчёта. */
const sections = (r: ReportBody) => new Set(r.rows.map((row) => String(row[0])));

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [PrismaModule, AuthModule, FinanceModule],
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

  accountant = await login('m.rahimova');
  director = await login('s.radjabov');
});

afterAll(async () => {
  await app.close();
});

describe('право на финансовый результат', () => {
  it('у директора есть, у бухгалтера нет', () => {
    expect(director.permissions).toContain(PROFIT);
    expect(accountant.permissions).not.toContain(PROFIT);
  });

  it('бухгалтер остаётся при финансах: право на просмотр у него есть', () => {
    expect(accountant.permissions).toContain('finance.view');
  });
});

describe('отчёты о прибыли без права на результат', () => {
  it('«Прибыли и убытки» бухгалтеру не отдаются', async () => {
    const res = await api(`/api/v1/finance/reports/pnl?${WIDE}`, {
      headers: auth(accountant.token),
    });
    expect(res.status).toBe(403);
  });

  it('«Маржа» бухгалтеру не отдаётся', async () => {
    const res = await api(`/api/v1/finance/reports/margin?${WIDE}`, {
      headers: auth(accountant.token),
    });
    expect(res.status).toBe(403);
  });

  it('файлом эти отчёты тоже не выгружаются', async () => {
    for (const kind of ['pnl', 'margin']) {
      for (const format of ['xlsx', 'csv', 'pdf']) {
        const res = await fetch(
          `${base}/api/v1/finance/reports/${kind}/file?format=${format}&${WIDE}`,
          { headers: auth(accountant.token) },
        );
        expect(res.status, `${kind}.${format}`).toBe(403);
        // Файл не должен уехать даже с кодом ошибки: 403 с вложением в
        // браузере сохранится как файл, и в нём будет та самая прибыль.
        expect(res.headers.get('content-disposition'), `${kind}.${format}`).toBeNull();
      }
    }
  });

  it('директору отдаются оба', async () => {
    for (const kind of ['pnl', 'margin']) {
      const res = await api(`/api/v1/finance/reports/${kind}?${WIDE}`, {
        headers: auth(director.token),
      });
      expect(res.status, kind).toBe(200);
      expect(res.body.data.rows.length, kind).toBeGreaterThan(0);
    }
  });
});

describe('сводный отчёт без права на результат', () => {
  it('раздела «Результат» в нём нет целиком', async () => {
    const data = await summaryFor(accountant.token);
    expect(sections(data)).not.toContain('Результат');
    // Ни одной строки с прибылью: ни валовой, ни операционной, ни
    // рентабельности, по которой прибыль восстанавливается из выручки.
    const titles = data.rows.map((r) => String(r[1]).toLowerCase());
    for (const word of ['прибыль', 'выручка', 'себестоимость', 'рентабельность']) {
      expect(
        titles.some((t) => t.includes(word)),
        `в сводке бухгалтера осталась строка со словом «${word}»`,
      ).toBe(false);
    }
  });

  it('итог по прибыли не приходит и в числах подвала', async () => {
    const data = await summaryFor(accountant.token);
    expect(Object.keys(data.totals)).not.toContain('operating');
  });

  it('остальная аналитика у бухгалтера на месте', async () => {
    const data = await summaryFor(accountant.token);
    const got = sections(data);
    for (const section of ['Деньги', 'Задолженность', 'Бюджет']) {
      expect(got, section).toContain(section);
    }
    expect(Object.keys(data.totals)).toContain('saldo');
    expect(Object.keys(data.totals)).toContain('receivables');
  });

  it('сводка честно говорит, что раздел скрыт', async () => {
    const data = await summaryFor(accountant.token);
    expect(data.subtitle.toLowerCase()).toContain('результат');
  });

  it('у директора раздел «Результат» и итог прибыли на месте', async () => {
    const data = await summaryFor(director.token);
    expect(sections(data)).toContain('Результат');
    expect(Object.keys(data.totals)).toContain('operating');
    expect(data.subtitle.toLowerCase()).not.toContain('скрыт');
  });
});
