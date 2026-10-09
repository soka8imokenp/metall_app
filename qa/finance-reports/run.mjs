/**
 * Прогон вкладки «Отчёты» в финансах против живого бэкенда (ТЗ 6.9).
 *
 * Проверяет то, что по скриншоту не проверишь:
 *   1) вкладка открывается, и все восемь отчётов рисуют строки;
 *   2) числа на экране сходятся с тем, что посчитано прямо в базе —
 *      не с тем, что вернул тот же сервер, а со своим запросом;
 *   3) выгрузка действительно скачивается: Excel, CSV и печатный PDF,
 *      каждый непустой и своего формата;
 *   4) под узбекским в подписях отчёта нет кириллицы;
 *   5) ничего не вылезает за карточку и за `main` на 360 и 1440 в обеих темах.
 *
 * Прогон ничего не пишет в базу: отчёты только читают. Язык учётки он тоже не
 * трогает — узбекский берётся переключателем в интерфейсе, как это делает
 * человек.
 *
 * Всё в одном переднем процессе: фоновые запуски запрещены, бэкенд поднимается
 * дочерним процессом и глушится в finally.
 *
 * Перед запуском собрать фронт с живым API:
 *   cd dev/frontend && bun run build:qa   # сборка для прогона, каталог dist-qa
 *
 * Запуск:
 *   cd dev/qa && bun run finance-reports
 */
import { spawn } from 'node:child_process';
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import pgPkg from 'pg';

const { Client } = pgPkg;

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '../../frontend/dist-qa');
const BACKEND = path.resolve(HERE, '../../backend');
const OUT = path.resolve(HERE, 'shots');
const DOWN = path.resolve(HERE, 'downloads');
/** Порт 4400, а не 4000: на 4000 живёт внешний стенд со своей базой. */
const API_PORT = Number(process.env.QA_API_PORT ?? 4400);
const WEB_PORT = Number(process.env.QA_WEB_PORT ?? 4322);

const API = `http://127.0.0.1:${API_PORT}/api/v1`;
/** Директор: у него есть finance.view и обе компании. */
const LOGIN = 's.radjabov';
/**
 * Бухгалтер: `finance.view` у него есть, права на прибыль
 * (`finance.profit.view`) нет — требование заказчика со встречи 07.10.
 * Им и проверяется, что прибыль закрыта, а остальная аналитика осталась.
 */
const ACCOUNTANT = 'm.rahimova';
const PASSWORD = process.env.SEED_PASSWORD ?? 'metall-dev-2026';

/** Все восемь отчётов и их подписи на вкладке. */
const KINDS = [
  { key: 'cashflow', ru: 'Движение денег', uz: 'Pul oqimi' },
  { key: 'balances', ru: 'Остатки по кассам и счетам', uz: 'Kassa va hisob qoldiqlari' },
  { key: 'receivables', ru: 'Дебиторка', uz: 'Debitorlik' },
  { key: 'payables', ru: 'Кредиторка', uz: 'Kreditorlik' },
  { key: 'plan-fact', ru: 'План-факт', uz: 'Reja-fakt' },
  { key: 'pnl', ru: 'Прибыли и убытки', uz: 'Foyda va zararlar' },
  { key: 'margin', ru: 'Маржа', uz: 'Marja' },
  { key: 'summary', ru: 'Сводный', uz: 'Yig‘ma' },
];

/**
 * KPI менеджеров в задачу не входит: правил расчёта заказчик не давал.
 * Появись он на вкладке — это не новая возможность, а выдуманный показатель,
 * по которому начнут платить бонусы. Поэтому он в находках.
 */
const FICTION = ['KPI менеджеров', 'KPI menejerlar', 'Бонус менеджера'];

fs.mkdirSync(OUT, { recursive: true });
fs.rmSync(DOWN, { recursive: true, force: true });
fs.mkdirSync(DOWN, { recursive: true });

const errors = [];
const overflow = [];
const found = [];
const notes = [];
const checks = [];
let backend;
let server;
let browser;
let db;

const ok = (what) => checks.push(`  ✔ ${what}`);
const bad = (what) => {
  checks.push(`  ✖ ${what}`);
  errors.push(what);
};

function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const env = fs.readFileSync(path.join(BACKEND, '.env'), 'utf8');
  const hit = env.match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
  if (!hit) throw new Error('DATABASE_URL не найден ни в окружении, ни в backend/.env');
  return hit[1];
}

async function assertPortFree() {
  const res = await fetch(`${API}/dashboard/summary`).catch(() => null);
  if (res) {
    throw new Error(
      `порт ${API_PORT} уже занят: на нём кто-то отвечает (${res.status}). ` +
        'Останови чужой процесс или задай QA_API_PORT.',
    );
  }
}

async function waitForApi(timeoutMs) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`${API}/finance/summary`).catch(() => null);
    if (res) return res.status;
    if (Date.now() > until) throw new Error('бэкенд не поднялся');
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** Переполнение по горизонтали и кто именно вылез. */
async function measure(page) {
  return page.evaluate(() => {
    const de = document.documentElement;
    const main = document.querySelector('main');
    const over = main ? main.scrollWidth - main.clientWidth : null;
    const culprits = [];
    if (main && over > 0) {
      const right = main.getBoundingClientRect().right;
      for (const el of main.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.right <= right + 1) continue;
        const scroller = el.closest('[class*="overflow-x-auto"]');
        if (scroller && scroller !== el) continue;
        culprits.push(
          `${el.tagName.toLowerCase()}.${String(el.className).split(' ').slice(0, 3).join('.')} +${Math.round(
            r.right - right,
          )}px`,
        );
        if (culprits.length >= 3) break;
      }
    }
    return { doc: de.scrollWidth - de.clientWidth, main: over, culprits };
  });
}

/**
 * Отчёт целиком внутри карточки.
 *
 * У карточки `overflow-hidden`: вылезшая таблица не двигает `main` и обычным
 * замером не ловится — её молча срезает по краю. Именно у правого края стоят
 * просрочка и рентабельность, ради которых отчёт и открывают.
 */
async function panelFits(page) {
  return reportPanel(page).evaluate((panel) => {
      const card = panel.closest('div[class*="overflow-hidden"]') ?? panel.parentElement;
      if (!card) return [];
      const edge = card.getBoundingClientRect().right;
      const out = [];
      for (const el of panel.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0) continue;
        const over = Math.round(r.right - edge);
        if (over <= 0) continue;
        const scroller = el.closest('[class*="overflow-x-auto"]');
        if (scroller && scroller !== el) continue;
        out.push(`${el.tagName.toLowerCase()} +${over}px`);
        if (out.length >= 3) break;
    }
    return out;
  });
}

/** Открыть раздел «Финансы» и вкладку «Отчёты». */
async function openReports(page, uz) {
  await page.getByRole('button', { name: uz ? 'Moliya' : 'Финансы', exact: true }).first().click();
  await page.waitForTimeout(1200);
  await page
    .getByRole('button', { name: new RegExp(uz ? 'Hisobotlar' : 'Отчёты') })
    .first()
    .click();
  await page.waitForTimeout(1200);
}

/** Панель отчётов: всё ищем внутри неё. */
const reportPanel = (page) =>
  page.getByRole('tabpanel', { name: /Отчёты|Hisobotlar/ }).first();

/**
 * Выбрать вид отчёта по подписи кнопки.
 *
 * Строго внутри панели: подписи «Дебиторка» и «План-факт» есть и у полоски
 * разделов финансов. Кликни по первой попавшейся — и прогон уйдёт с вкладки
 * отчётов, а дальше будет искать таблицу, которой там уже нет.
 */
async function pickKind(page, label) {
  await reportPanel(page).getByRole('button', { name: label, exact: true }).first().click();
  await page.waitForTimeout(900);
}

/** Вход в обход браузера: нужен, чтобы постучаться по адресу напрямую. */
async function apiLogin(login) {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login, password: PASSWORD }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`логин ${login} не прошёл: ${res.status}`);
  return body.data;
}

/** Строки таблицы отчёта на широком экране. */
const tableRows = (page) => reportPanel(page).locator('tbody tr');

/** Подписи колонок отчёта. */
const headerTexts = (page) => reportPanel(page).locator('thead th').allTextContents();

try {
  await assertPortFree();
  backend = spawn('node', ['dist/main.js'], {
    cwd: BACKEND,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(API_PORT),
      CORS_ORIGINS: `http://127.0.0.1:${WEB_PORT}`,
    },
  });
  backend.stderr.on('data', (d) => process.stderr.write(`[api!] ${d}`));
  console.log(`бэкенд отвечает, /finance/summary без токена → ${await waitForApi(25000)}`);

  db = new Client({ connectionString: databaseUrl() });
  await db.connect();

  const app = express();
  app.use(express.static(ROOT));
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(ROOT, 'index.html')));
  server = await new Promise((resolve) => {
    const s = app.listen(WEB_PORT, '127.0.0.1', () => resolve(s));
  });

  browser = await chromium.launch({
    executablePath: '/home/an/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
    args: ['--no-sandbox'],
  });

  let deepDone = false;

  for (const [w, h, tag] of [
    [1440, 900, '1440'],
    [360, 780, '360'],
  ]) {
    for (const theme of ['light', 'dark']) {
      const at = `${tag}/${theme}`;
      const ctx = await browser.newContext({
        viewport: { width: w, height: h },
        acceptDownloads: true,
      });
      const page = await ctx.newPage();
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(`[${at}] ${m.text().slice(0, 300)}`);
      });
      page.on('pageerror', (e) => errors.push(`[${at}] PAGEERROR ${e.message.slice(0, 300)}`));
      page.on('response', async (r) => {
        if (r.url().includes('/finance/reports') && r.status() >= 400) {
          const body = await r.text().catch(() => '');
          errors.push(
            `[${at}] ${r.status()} ${new URL(r.url()).pathname}${new URL(r.url()).search} ` +
              body.replace(/\s+/g, ' ').slice(0, 200),
          );
        }
      });
      await page.addInitScript((t) => localStorage.setItem('metall_theme', t), theme);

      await page.goto(`http://127.0.0.1:${WEB_PORT}/`, { waitUntil: 'networkidle' });
      await page.locator('input[autocomplete="username"]').first().fill(LOGIN);
      await page.locator('input[autocomplete="current-password"]').first().fill(PASSWORD);
      await page.getByRole('button', { name: 'Войти' }).click();
      await page.waitForSelector('text=/Выручка|Tushum/', { state: 'attached', timeout: 20000 });

      await openReports(page, false);
      console.log(`\n[${at}] вкладка «Отчёты» открыта`);

      // --- 1. Все восемь отчётов рисуют строки -----------------------------
      for (const k of KINDS) {
        await pickKind(page, k.ru);
        const panel = reportPanel(page);
        const text = await panel.innerText();

        // Ниже lg таблица превращается в карточки «подпись — значение»:
        // на 360 строк в tbody нет, и считать надо карточки.
        const rows =
          tag === '1440' ? await tableRows(page).count() : await panel.locator('li dl').count();
        if (rows === 0) bad(`[${at}] ${k.key}: отчёт пуст — ни одной строки`);
        else ok(`[${at}] ${k.key}: строк ${rows}`);

        if (!text.includes(':')) notes.push(`[${at}] ${k.key}: нет подзаголовка с периодом`);
        for (const f of FICTION) {
          if (text.includes(f)) found.push(`[${at}] ${k.key}: «${f}» на экране`);
        }

        const out = await panelFits(page);
        if (out.length) overflow.push(`[${at}] ${k.key}: вылезло ${out.join(', ')}`);
        const m = await measure(page);
        if (m.main > 0) overflow.push(`[${at}] ${k.key}: main +${m.main}px ${m.culprits.join(', ')}`);
      }

      // --- 2. Числа сходятся с базой ---------------------------------------
      // Сверяется не ответ сервера с ответом сервера, а показанное на экране
      // со своим запросом в базу: иначе проверка повторяет ту же ошибку.
      await pickKind(page, 'Кредиторка');

      // Сверяется каждая строка, а не итог: в шапке выбрана одна компания, и
      // браузер шлёт её в `X-Company-Id`. Итог по всему холдингу с таким
      // экраном не сойдётся никогда — и это правильно, так работает разделение
      // компаний. Ключ строки — компания И поставщик: «АО «Узметкомбинат»»
      // заведено в двух компаниях, по одному имени строка находится не та.
      const inDb = await db.query(
        `WITH got AS (
           SELECT co.code AS company, m.partner_id, coalesce(sum(m.cost_total), 0) AS amount
             FROM stock_move m JOIN company co ON co.id = m.company_id
            WHERE m.operation_type = 'receipt' AND m.partner_id IS NOT NULL AND m.cost_total > 0
            GROUP BY co.code, m.partner_id),
         paid AS (
           SELECT co.code AS company, o.partner_id, coalesce(sum(o.amount_base), 0) AS amount
             FROM finance_operation o
             JOIN account ca ON ca.id = o.counter_account_id
             JOIN company co ON co.id = o.company_id
            WHERE o.status = 'posted' AND o.operation_type = 'expense'
              AND ca.kind = 'payable' AND o.partner_id IS NOT NULL
            GROUP BY co.code, o.partner_id)
         SELECT g.company, p.name_ru AS partner,
                greatest(g.amount - coalesce(d.amount, 0), 0)::text AS debt
           FROM got g
           JOIN partner p ON p.id = g.partner_id
           LEFT JOIN paid d ON d.partner_id = g.partner_id AND d.company = g.company`,
      );
      const debtOf = new Map(inDb.rows.map((r) => [`${r.company}\u0000${r.partner}`, Number(r.debt)]));

      const body = await reportPanel(page).locator('tbody tr').all();
      if (!body.length) bad(`[${at}] кредиторка: на экране нет ни одной строки`);
      let matched = 0;
      for (const tr of body) {
        const cell = await tr.locator('td').allInnerTexts();
        const num = (v) => Number(String(v).replace(/[\s\u00a0\u202f]/g, '').replace(',', '.'));
        const key = `${cell[0].trim()}\u0000${cell[1].trim()}`;
        const want = debtOf.get(key);
        if (want === undefined) {
          bad(`[${at}] кредиторка: строки «${key.replace('\u0000', ' / ')}» нет в базе`);
          continue;
        }
        // Копейка расхождения заложена: в отчёте итог — сумма показанного.
        if (Math.abs(num(cell[2]) - want) >= 1) {
          bad(
            `[${at}] кредиторка «${cell[1].trim()}» (${cell[0].trim()}): ` +
              `на экране ${num(cell[2]).toFixed(2)}, в базе ${want.toFixed(2)}`,
          );
        } else matched += 1;
      }
      if (matched) ok(`[${at}] кредиторка: ${matched} строк сошлись с базой до копейки`);

      // --- 3. Выгрузка: один круг, на широком светлом ----------------------
      if (!deepDone) {
        for (const [label, ext, head] of [
          ['Excel', 'xlsx', 'PK'],
          ['CSV', 'csv', '﻿'],
          ['PDF', 'pdf', '%PDF'],
        ]) {
          const wait = page.waitForEvent('download', { timeout: 60000 });
          await reportPanel(page).getByRole('button', { name: label, exact: true }).first().click();
          const dl = await wait.catch(() => null);
          if (!dl) {
            bad(`[${at}] выгрузка ${label}: файл не пошёл`);
            continue;
          }
          const name = dl.suggestedFilename();
          const to = path.join(DOWN, name);
          await dl.saveAs(to);
          const size = fs.statSync(to).size;
          const start = fs.readFileSync(to).subarray(0, 8).toString('utf8');
          if (size === 0) bad(`[${at}] выгрузка ${label}: файл пустой`);
          else if (!name.startsWith('finansy-')) bad(`[${at}] выгрузка ${label}: имя «${name}»`);
          else if (!start.startsWith(head)) {
            bad(`[${at}] выгрузка ${label}: не похоже на ${ext} (начало «${start.slice(0, 4)}»)`);
          } else ok(`[${at}] выгрузка ${label}: ${name}, ${size} байт`);
        }

        // --- 4. Разрез маржи переключается ---------------------------------
        await pickKind(page, 'Маржа');
        for (const by of ['По заказам', 'По товарам', 'По клиентам', 'По менеджерам']) {
          await pickKind(page, by);
          const rows = await tableRows(page).count();
          if (rows === 0) bad(`[${at}] маржа «${by}»: строк нет`);
          else ok(`[${at}] маржа «${by}»: строк ${rows}`);
        }
        await page.screenshot({ path: `${OUT}/finance-reports-margin-${tag}-${theme}.png` });
        deepDone = true;
      }

      // --- 5. Узбекский: в подписях отчёта нет кириллицы -------------------
      await page.getByRole('button', { name: 'UZ', exact: true }).first().click();
      await page.waitForTimeout(1000);
      await openReports(page, true);
      for (const k of KINDS) {
        await pickKind(page, k.uz);
        const titles = tag === '1440' ? await headerTexts(page) : [];
        const subtitleUz = await reportPanel(page)
          .locator('p')
          .first()
          .innerText()
          .catch(() => '');
        // Имена контрагентов и номенклатуры — данные справочника, и кириллица
        // в них бывает законно (имена собственные). Сторожим только то, что
        // пишет сервер сам: заголовок, подзаголовок и подписи колонок.
        const dirty = [...titles, subtitleUz].filter((t) => /[А-Яа-яЁё]/.test(t));
        if (dirty.length) {
          bad(`[${at}] uz ${k.key}: кириллица в подписях — ${dirty.slice(0, 2).join(' | ')}`);
        } else ok(`[${at}] uz ${k.key}: подписи без кириллицы`);

        const out = await panelFits(page);
        if (out.length) overflow.push(`[${at}] uz ${k.key}: вылезло ${out.join(', ')}`);
      }
      await page.screenshot({
        path: `${OUT}/finance-reports-uz-${tag}-${theme}.png`,
        fullPage: true,
      });

      // Снимок по-русски на сводном: его и смотрят глазами.
      await page.getByRole('button', { name: 'RU', exact: true }).first().click();
      await page.waitForTimeout(800);
      await openReports(page, false);
      await pickKind(page, 'Сводный');
      await page.screenshot({
        path: `${OUT}/finance-reports-${tag}-${theme}.png`,
        fullPage: true,
      });

      await ctx.close();
    }
  }

  // --- 6. Бухгалтер не видит прибыль учредителей --------------------------
  // Требование заказчика 07.10. Проверяется тем путём, которым работает
  // человек: своя сессия в браузере, а не подменённые права в коде. И тем
  // путём, которым работает не человек: запрос прямо по адресу.
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`[бухгалтер] PAGEERROR ${e.message.slice(0, 300)}`));
    await page.goto(`http://127.0.0.1:${WEB_PORT}/`, { waitUntil: 'networkidle' });
    await page.locator('input[autocomplete="username"]').first().fill(ACCOUNTANT);
    await page.locator('input[autocomplete="current-password"]').first().fill(PASSWORD);
    await page.getByRole('button', { name: 'Войти' }).click();
    await page.waitForSelector('button:has-text("Финансы")', { timeout: 20000 });
    await openReports(page, false);
    console.log('\n[бухгалтер] вкладка «Отчёты» открыта');

    for (const label of ['Прибыли и убытки', 'Маржа']) {
      const seen = await reportPanel(page)
        .getByRole('button', { name: label, exact: true })
        .count();
      if (seen) bad(`бухгалтер: кнопка «${label}» на вкладке есть`);
      else ok(`бухгалтер: кнопки «${label}» нет`);
    }
    // Закрыли прибыль, а не финансы: остальные шесть отчётов обязаны остаться.
    for (const label of ['Движение денег', 'Дебиторка', 'План-факт', 'Сводный']) {
      const seen = await reportPanel(page)
        .getByRole('button', { name: label, exact: true })
        .count();
      if (!seen) bad(`бухгалтер: пропала кнопка «${label}» — закрыто лишнее`);
      else ok(`бухгалтер: «${label}» на месте`);
    }

    await pickKind(page, 'Сводный');
    const text = await reportPanel(page).innerText();
    for (const word of ['Операционная прибыль', 'Валовая прибыль', 'Выручка', 'Рентабельность']) {
      if (text.includes(word)) bad(`бухгалтер: в сводном осталась строка «${word}»`);
    }
    if (!/скрыт/i.test(text)) {
      bad('бухгалтер: сводный молчит о том, что раздел «Результат» скрыт');
    } else ok('бухгалтер: сводный без раздела «Результат» и говорит об этом');
    if (!text.includes('Дебиторская задолженность')) {
      bad('бухгалтер: из сводного пропала задолженность');
    } else ok('бухгалтер: задолженность и деньги в сводном на месте');

    await page.screenshot({
      path: `${OUT}/finance-reports-accountant-1440-light.png`,
      fullPage: true,
    });

    // Адрес набирается руками, и спрятанная кнопка никого не остановит.
    const { token } = await apiLogin(ACCOUNTANT);
    const head = { Authorization: `Bearer ${token}` };
    for (const kind of ['pnl', 'margin']) {
      const r = await fetch(`${API}/finance/reports/${kind}`, { headers: head });
      if (r.status !== 403) bad(`бухгалтер: ${kind} по адресу отдал ${r.status}, а не 403`);
      else ok(`бухгалтер: ${kind} по адресу — 403`);

      const f = await fetch(`${API}/finance/reports/${kind}/file?format=xlsx`, { headers: head });
      if (f.status !== 403) bad(`бухгалтер: ${kind} файлом отдал ${f.status}, а не 403`);
      else if (f.headers.get('content-disposition')) {
        bad(`бухгалтер: ${kind} файлом отказал, но вложение всё равно ушло`);
      } else ok(`бухгалтер: ${kind} файлом — 403 и без вложения`);
    }

    await ctx.close();
  }
} catch (e) {
  errors.push(`ПРОГОН ОБОРВАЛСЯ: ${e.stack ?? e.message}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) await new Promise((r) => server.close(r));
  if (db) await db.end().catch(() => {});
  if (backend) backend.kill('SIGTERM');
}

console.log('\n── проверки ──');
for (const c of checks) console.log(c);
if (notes.length) {
  console.log('\n── замечания ──');
  for (const n of notes) console.log(`  · ${n}`);
}
if (found.length) {
  console.log('\n── выдумки на экране ──');
  for (const f of found) console.log(`  ✖ ${f}`);
}
if (overflow.length) {
  console.log('\n── переполнение ──');
  for (const o of overflow) console.log(`  ✖ ${o}`);
}
if (errors.length) {
  console.log('\n── ошибки ──');
  for (const e of errors) console.log(`  ✖ ${e}`);
}

const failed = errors.length + overflow.length + found.length;
console.log(
  `\nитог: проверок ${checks.length}, провалов ${failed}, скриншоты в ${path.relative(process.cwd(), OUT)}`,
);
process.exit(failed === 0 ? 0 : 1);
