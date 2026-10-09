/**
 * Поиск по системе — живьём, глазами браузера.
 *
 * Бэкенд проверен своими прогонами (`test/search.e2e.spec.ts`), но заказчик
 * пользуется не маршрутом, а окном: вводит кусок названия и ждёт, что увидит
 * сам товар, а не список разделов. Здесь проверяется именно это и на том же
 * пути, которым ходит человек.
 *
 * Что считается провалом:
 *   — по куску названия товара не появилось ни одной группы данных;
 *   — выдача не содержит найденного товара;
 *   — по выбору находки не открылся нужный раздел;
 *   — под узбекским в окне осталась кириллица в своих подписях.
 *
 * Перед запуском: backend npm run build, frontend npm run build:qa.
 * Запуск: cd dev/qa && node web-search/run.mjs
 */
import { spawn } from 'node:child_process';
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { Client } from 'pg';
import { chromium } from 'playwright-core';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '../../frontend/dist-qa');
const BACKEND = path.resolve(HERE, '../../backend');
const OUT = path.resolve(HERE, 'shots');
const API_PORT = Number(process.env.QA_API_PORT ?? 4400);
const WEB_PORT = Number(process.env.QA_WEB_PORT ?? 4324);
const LOGIN = process.env.QA_LOGIN ?? 'admin';
const PASSWORD = process.env.SEED_PASSWORD ?? 'metall-dev-2026';
const CYR = /[А-Яа-яЁё]/;

fs.mkdirSync(OUT, { recursive: true });
const notes = [];
const errors = [];
let backend;
let server;
let browser;
let db;

async function assertPortFree(port) {
  const res = await fetch(`http://127.0.0.1:${port}/`).catch(() => null);
  if (res) throw new Error(`порт ${port} занят: на нём кто-то отвечает (${res.status})`);
}

async function waitForApi(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const res = await fetch(`http://127.0.0.1:${API_PORT}/api/v1/auth/me`).catch(() => null);
    if (res) return res.status;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('бэкенд не поднялся');
}

/** Открыть окно поиска и набрать строку. */
async function ask(page, text) {
  await page.keyboard.press('Control+k');
  await page.waitForSelector('div.fixed.inset-0.z-50 input', { timeout: 10000 });
  await page.locator('div.fixed.inset-0.z-50 input').first().fill(text);
  // Окно откладывает запрос на четверть секунды, ответ идёт по локальной сети.
  await page.waitForTimeout(1800);
  return page.locator('div.fixed.inset-0.z-50').first();
}

/** Заголовки групп и строки выдачи — отдельно, они проверяются по-разному. */
async function readPanel(panel) {
  return panel.evaluate((el) => {
    const heads = [...el.querySelectorAll('div.uppercase')].map((e) => e.textContent.trim());
    const rows = [...el.querySelectorAll('button')]
      .map((e) => e.innerText.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    return { heads, rows };
  });
}

try {
  await assertPortFree(API_PORT);
  await assertPortFree(WEB_PORT);
  if (!fs.existsSync(ROOT)) throw new Error(`нет сборки ${ROOT}: сначала npm run build:qa`);

  // Что искать, берём из базы: привязываться к конкретной строке посева нельзя.
  db = new Client({ connectionString: process.env.DATABASE_URL ?? readEnvUrl() });
  await db.connect();
  const item = (
    await db.query(
      `SELECT i.name_ru AS name, i.code FROM item i
         JOIN company c ON c.id = i.company_id
        WHERE c.code = 'trade' AND i.is_active ORDER BY i.id LIMIT 1`,
    )
  ).rows[0];
  const partner = (
    await db.query(
      `SELECT p.name_ru AS name FROM partner p
         JOIN company c ON c.id = p.company_id
        WHERE c.code = 'trade' AND p.is_active ORDER BY p.id LIMIT 1`,
    )
  ).rows[0];
  // Сотрудник: находка по нему ведёт в админку, и это единственная группа,
  // чья вкладка не открывается по умолчанию, — её и проверяем.
  const employee = (
    await db.query(
      `SELECT u.full_name AS name, u.login FROM user_account u
        WHERE u.is_active AND u.full_name IS NOT NULL
        ORDER BY u.id LIMIT 1`,
    )
  ).rows[0];
  if (!item || !partner) throw new Error('в базе нет ни товара, ни контрагента — нечего искать');
  if (!employee) throw new Error('в базе нет ни одного сотрудника — нечего искать');
  const itemWord = item.name.split(' ').find((w) => w.length >= 5) ?? item.name;
  const partnerWord = partner.name.split(' ').find((w) => w.length >= 5) ?? partner.name;
  const employeeWord = employee.name.split(' ').find((w) => w.length >= 4) ?? employee.name;
  notes.push(
    `ищем товар по «${itemWord}», контрагента по «${partnerWord}», сотрудника по «${employeeWord}»`,
  );

  backend = spawn('node', ['dist/main.js'], {
    cwd: BACKEND,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(API_PORT), CORS_ORIGINS: `http://127.0.0.1:${WEB_PORT}` },
  });
  backend.stderr.on('data', (d) => process.stderr.write(`[api!] ${d}`));
  notes.push(`бэкенд отвечает (${await waitForApi(25000)})`);

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

  // Узкий экран отдельно: узбекские подписи длиннее русских, и выдача с
  // номером заказа справа рвалась бы именно там.
  for (const [locale, width, theme] of [
    ['ru', 1440, 'light'],
    ['uz', 1440, 'dark'],
    ['uz', 360, 'light'],
  ]) {
    const tag = `${locale}-${width}-${theme}`;
    const ctx = await browser.newContext({ viewport: { width, height: width === 360 ? 780 : 900 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`[${locale}] PAGEERROR ${e.message.slice(0, 200)}`));
    page.on('response', (r) => {
      if (r.url().includes('/api/v1/search') && r.status() >= 400) {
        errors.push(`[${tag}] поиск ответил ${r.status()}`);
      }
    });
    await page.addInitScript(
      ([loc, th]) => {
        localStorage.setItem('metall_locale', loc);
        localStorage.setItem('metall_theme', th);
      },
      [locale, theme],
    );
    await page.goto(`http://127.0.0.1:${WEB_PORT}/`, { waitUntil: 'networkidle' });
    await page.locator('input[autocomplete="username"]').first().fill(LOGIN);
    await page.locator('input[autocomplete="current-password"]').first().fill(PASSWORD);
    await page.locator('form button[type="submit"]').first().click();
    await page.waitForSelector('aside', { timeout: 20000 });
    await page.waitForTimeout(1200);

    // --- пустое состояние ---
    // Самая частая претензия «панель не изменилась» рождается здесь: если
    // сразу после открытия показать только список разделов, новая панель от
    // старой неотличима, и человек закрывает её, не начав печатать. Поэтому
    // окно обязано назвать, по чему оно ищет, и сделать это выше разделов.
    let panel = await ask(page, '');
    const emptyText = (await panel.innerText()).replace(/\s+/g, ' ');
    await page.screenshot({ path: path.join(OUT, `pusto-${tag}.png`) });
    // Заголовок группы на экране заглавными (uppercase), поэтому режем без
    // учёта регистра — иначе разрез не срабатывает и проверка проходит зря.
    const sectionsWord = (locale === 'uz' ? 'Bo‘limlar' : 'Разделы').toLowerCase();
    const headPart = emptyText.toLowerCase().split(sectionsWord)[0] ?? '';
    const kinds =
      locale === 'uz'
        ? ['mahsulot', 'mijoz', 'buyurtma', 'hujjat']
        : ['товар', 'клиент', 'заказ', 'документ'];
    const named = kinds.filter((k) => headPart.includes(k));
    notes.push(`[${tag}] в пустом окне названо видов данных до разделов: ${named.length}/4`);
    if (named.length < 3) {
      errors.push(
        `[${tag}] пустое окно не говорит, что ищет по данным, — его не отличить от старого: «${headPart.slice(0, 120)}»`,
      );
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // --- запроса нет в данных ---
    // Второй случай, в котором поиск выглядит сломанным: голое «ничего не
    // нашлось» не говорит, где искали, и читается как «поиск не работает».
    panel = await ask(page, 'щщэъхжф');
    const missText = (await panel.innerText()).replace(/\s+/g, ' ');
    await page.screenshot({ path: path.join(OUT, `net-nahodok-${tag}.png`) });
    if (!missText.includes('щщэъхжф')) {
      errors.push(`[${tag}] ответ про «ничего не нашлось» не называет сам запрос`);
    }
    const missNamed = kinds.filter((k) => missText.toLowerCase().includes(k));
    notes.push(`[${tag}] в ответе «не нашлось» названо видов данных: ${missNamed.length}/4`);
    if (missNamed.length < 3) {
      errors.push(`[${tag}] ответ «не нашлось» не говорит, где искали: «${missText.slice(0, 120)}»`);
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // --- товар ---
    panel = await ask(page, itemWord);
    let { heads, rows } = await readPanel(panel);
    await page.screenshot({ path: path.join(OUT, `tovar-${tag}.png`) });
    const dataHeads = heads.filter((h) => !/^(Разделы|Bo‘limlar)$/.test(h));
    if (dataHeads.length === 0) {
      errors.push(`[${locale}] по товару «${itemWord}» ни одной группы данных: ${heads.join(', ')}`);
    }
    if (!rows.some((r) => r.includes(item.code))) {
      errors.push(`[${locale}] товара ${item.code} нет в выдаче`);
    }
    notes.push(`[${locale}] по товару группы: ${heads.join(' | ')}`);

    if (locale === 'uz') {
      // Свои подписи окна. Данные заказчика заведены по-русски и кириллицу
      // содержат законно — поэтому проверяются только заголовки групп.
      const cyr = heads.filter((h) => CYR.test(h));
      if (cyr.length) errors.push(`[uz] заголовки групп по-русски: ${cyr.join(', ')}`);
    }

    // --- контрагент ---
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    panel = await ask(page, partnerWord);
    ({ heads, rows } = await readPanel(panel));
    await page.screenshot({ path: path.join(OUT, `kontragent-${tag}.png`) });
    if (!rows.some((r) => r.includes(partnerWord))) {
      errors.push(`[${locale}] контрагента «${partnerWord}» нет в выдаче`);
    }
    notes.push(`[${locale}] по контрагенту группы: ${heads.join(' | ')}`);

    // Выход за край окна: панель с номерами справа — первая, кто поедет.
    const out = await panel.evaluate((el) => {
      const r = el.firstElementChild.getBoundingClientRect();
      return Math.max(0, Math.round(r.right - window.innerWidth), Math.round(-r.left));
    });
    notes.push(`[${tag}] выход панели за край: ${out}`);
    if (out > 0) errors.push(`[${tag}] панель выехала за край на ${out} точек`);

    // --- переход по находке ---
    // Берём строку найденного товара и жмём её: должен открыться склад и
    // подставить ту же строку себе в поиск.
    const target = panel.locator('button').filter({ hasText: partnerWord }).first();
    if (await target.count()) {
      await target.click();
      await page.waitForTimeout(1800);
      const opened = await page.evaluate(() => document.body.innerText.slice(0, 4000));
      const inputs = await page.locator('input[type="text"], input:not([type])').all();
      let carried = false;
      for (const i of inputs) {
        const v = await i.inputValue().catch(() => '');
        if (v.includes(partnerWord)) carried = true;
      }
      if (!carried) {
        errors.push(`[${locale}] раздел открылся, но строка «${partnerWord}» в него не попала`);
      }
      notes.push(`[${locale}] переход по находке: строка подставлена — ${carried}`);
      void opened;
    } else {
      errors.push(`[${locale}] строку контрагента в выдаче не нажать`);
    }

    // --- сотрудник: находка ведёт в админку и на вкладку людей ---
    // Переход сюда ломается иначе, чем в склад: админка открывается на своей
    // вкладке, и если находку не подхватить, человек увидит полный список.
    panel = await ask(page, employeeWord);
    ({ heads, rows } = await readPanel(panel));
    await page.screenshot({ path: path.join(OUT, `sotrudnik-${tag}.png`) });
    if (!rows.some((r) => r.includes(employeeWord))) {
      errors.push(`[${locale}] сотрудника «${employeeWord}» нет в выдаче`);
    } else {
      await panel.locator('button').filter({ hasText: employeeWord }).first().click();
      await page.waitForTimeout(1800);
      const inputs = await page.locator('input[type="text"], input:not([type])').all();
      let carried = false;
      for (const i of inputs) {
        const v = await i.inputValue().catch(() => '');
        if (v.includes(employeeWord)) carried = true;
      }
      await page.screenshot({ path: path.join(OUT, `sotrudnik-perehod-${tag}.png`) });
      notes.push(`[${locale}] переход к сотруднику: строка подставлена — ${carried}`);
      if (!carried) {
        errors.push(`[${locale}] админка открылась, но «${employeeWord}» в поиск людей не попал`);
      }
    }

    await ctx.close();
  }
} catch (e) {
  errors.push(`прогон сорвался: ${e.message}`);
} finally {
  if (browser) await browser.close().catch(() => null);
  if (server) await new Promise((r) => server.close(r));
  if (backend) backend.kill('SIGTERM');
  if (db) await db.end().catch(() => null);
}

function readEnvUrl() {
  const env = fs.readFileSync(path.join(BACKEND, '.env'), 'utf8');
  return env.match(/^DATABASE_URL=["']?(.+?)["']?$/m)?.[1];
}

console.log('--- что происходило ---');
for (const n of notes) console.log(`  ${n}`);
if (errors.length) {
  console.log('--- находки ---');
  for (const e of errors) console.log(`  ${e}`);
  console.log(`\nПРОГОН КРАСНЫЙ: находок ${errors.length}. Снимки: ${OUT}`);
  process.exit(1);
}
console.log(`\nПРОГОН ЗЕЛЁНЫЙ: поиск находит данные и ведёт в раздел. Снимки: ${OUT}`);
