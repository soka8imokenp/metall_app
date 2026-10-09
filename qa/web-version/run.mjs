/**
 * Приложение замечает выкатку само.
 *
 * Жалоба заказчика «у меня это не отображается» означала не сорванную выкатку,
 * а открытое окно с прежней сборкой: `index.html` лежал в кэше браузера, а
 * вместе с ним и ссылки на прежние файлы. Проверяется то, что закрывает эту
 * жалобу навсегда:
 *
 *   — собранная страница знает свою версию и показывает её в сайдбаре;
 *   — рядом со сборкой лежит `version.json` с той же версией;
 *   — пока версии совпадают, полосы «вышло обновление» нет;
 *   — как только на сервере версия сменилась, полоса появляется, и по кнопке
 *     страница перезагружается уже на новую версию.
 *
 * Выкатка подделывается подменой `version.json` на отдаваемой статике — ровно
 * то, что происходит на стенде при `npm run build:stand`.
 *
 * Перед запуском: backend npm run build, frontend npm run build:qa.
 * Запуск: cd dev/qa && node web-version/run.mjs
 */
import { spawn } from 'node:child_process';
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { chromium } from 'playwright-core';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '../../frontend/dist-qa');
const BACKEND = path.resolve(HERE, '../../backend');
const OUT = path.resolve(HERE, 'shots');
const API_PORT = Number(process.env.QA_API_PORT ?? 4400);
const WEB_PORT = Number(process.env.QA_WEB_PORT ?? 4325);
const LOGIN = process.env.QA_LOGIN ?? 'admin';
const PASSWORD = process.env.SEED_PASSWORD ?? 'metall-dev-2026';

fs.mkdirSync(OUT, { recursive: true });
const notes = [];
const errors = [];
let backend;
let server;
let browser;

/** Что отдавать на /version.json — меняется по ходу прогона. */
let served = null;

async function waitForApi(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const res = await fetch(`http://127.0.0.1:${API_PORT}/api/v1/auth/me`).catch(() => null);
    if (res) return res.status;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('бэкенд не поднялся');
}

const banner = (page) =>
  page.locator('button', { hasText: /Перезагрузить|Qayta yuklash/ }).first();

try {
  if (!fs.existsSync(ROOT)) throw new Error(`нет сборки ${ROOT}: сначала npm run build:qa`);

  // Версия сборки — из файла, который положил Vite. Хардкодить её здесь нельзя:
  // прогон должен ловить и то, что файл перестали писать.
  const versionPath = path.join(ROOT, 'version.json');
  if (!fs.existsSync(versionPath)) {
    throw new Error('сборка не положила version.json — приложению нечего спрашивать');
  }
  const built = JSON.parse(fs.readFileSync(versionPath, 'utf8'));
  if (!built.version || typeof built.version !== 'string') {
    throw new Error(`в version.json нет версии: ${JSON.stringify(built)}`);
  }
  served = built;
  notes.push(`версия сборки: ${built.version}`);

  // Версия обязана быть и внутри собранных файлов, иначе сравнивать не с чем.
  const bundles = fs
    .readdirSync(path.join(ROOT, 'assets'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => fs.readFileSync(path.join(ROOT, 'assets', f), 'utf8'));
  if (!bundles.some((b) => b.includes(built.version))) {
    errors.push('версии нет внутри собранных файлов: страница не узнает свою сборку');
  }

  backend = spawn('node', ['dist/main.js'], {
    cwd: BACKEND,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(API_PORT), CORS_ORIGINS: `http://127.0.0.1:${WEB_PORT}` },
  });
  backend.stderr.on('data', (d) => process.stderr.write(`[api!] ${d}`));
  notes.push(`бэкенд отвечает (${await waitForApi(25000)})`);

  const app = express();
  // Перед статикой: нам нужно подменять этот файл на ходу.
  app.get('/version.json', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(served);
  });
  app.use(express.static(ROOT));
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(ROOT, 'index.html')));
  server = await new Promise((resolve) => {
    const s = app.listen(WEB_PORT, '127.0.0.1', () => resolve(s));
  });

  browser = await chromium.launch({
    executablePath: '/home/an/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
    args: ['--no-sandbox'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message.slice(0, 200)}`));

  await page.goto(`http://127.0.0.1:${WEB_PORT}/`, { waitUntil: 'networkidle' });

  // Версия обязана быть видна ДО входа. Когда спорят «я выкатил» — «я не вижу»,
  // просить человека войти, открыть нужный угол и прочитать мелкую строку —
  // лишние три шага, на каждом из которых разговор буксует. Открыл адрес —
  // увидел версию.
  const loginText = await page.locator('body').innerText();
  const onLogin = loginText.includes(built.version);
  notes.push(`версия видна на экране входа — ${onLogin}`);
  if (!onLogin) {
    errors.push(`версии ${built.version} нет на экране входа: сверить сборку можно только войдя`);
  }
  await page.screenshot({ path: `${OUT}/vhod.png` });

  await page.locator('input[autocomplete="username"]').first().fill(LOGIN);
  await page.locator('input[autocomplete="current-password"]').first().fill(PASSWORD);
  await page.locator('form button[type="submit"]').first().click();
  await page.waitForSelector('aside', { timeout: 20000 });
  await page.waitForTimeout(1500);

  // --- версия видна человеку ---
  const shown = await page.locator('aside').innerText();
  const marked = shown.includes(built.version);
  notes.push(`версия видна в сайдбаре — ${marked}`);
  if (!marked) errors.push(`версии ${built.version} нет в сайдбаре: спросить её у заказчика нечем`);

  // --- пока версии совпадают, полосы быть не должно ---
  await page.screenshot({ path: path.join(OUT, 'bez-obnovleniya.png') });
  if (await banner(page).count()) {
    errors.push('полоса обновления висит на свежей сборке: её перестанут замечать');
  }
  notes.push('на своей версии полосы нет');

  // --- выкатили новую сборку ---
  served = { version: `${built.version}-next`, builtAt: new Date().toISOString() };
  // Окно спрашивает версию при возврате к вкладке — это и самый частый случай.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await banner(page)
    .waitFor({ state: 'visible', timeout: 15000 })
    .catch(() => null);
  const appeared = (await banner(page).count()) > 0;
  await page.screenshot({ path: path.join(OUT, 'est-obnovlenie.png') });
  notes.push(`после выкатки полоса появилась — ${appeared}`);
  if (!appeared) {
    errors.push('на сервере версия новее, а окно об этом не сказало — жалоба повторится');
  }

  // --- кнопка действительно перезагружает ---
  if (appeared) {
    await banner(page).click();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1200);
    const reloaded = await page.evaluate(() => performance.getEntriesByType('navigation').length);
    notes.push(`перезагрузка по кнопке состоялась — ${reloaded > 0}`);
    if (!reloaded) errors.push('кнопка не перезагрузила страницу');
  }

  await ctx.close();
} catch (e) {
  errors.push(`прогон сорвался: ${e.message}`);
} finally {
  if (browser) await browser.close().catch(() => null);
  if (server) await new Promise((r) => server.close(r));
  if (backend) backend.kill('SIGTERM');
}

console.log('--- что происходило ---');
for (const n of notes) console.log(`  ${n}`);
if (errors.length) {
  console.log('--- находки ---');
  for (const e of errors) console.log(`  ${e}`);
  console.log(`\nПРОГОН КРАСНЫЙ: находок ${errors.length}. Снимки: ${OUT}`);
  process.exit(1);
}
console.log(`\nПРОГОН ЗЕЛЁНЫЙ: приложение замечает выкатку само. Снимки: ${OUT}`);
