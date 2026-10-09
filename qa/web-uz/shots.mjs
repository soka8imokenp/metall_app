/**
 * Снимки того, что я правил в этот заход, на двух ширинах и в двух темах.
 *
 * Приёмка `web-uz/run.mjs` отвечает за слова, этот прогон — за то, что слова
 * влезли: узбекские подписи длиннее русских («Bo‘limlar bo‘yicha o‘tish»
 * против «Поиск»), и окно поиска с календарём на 360 рвались бы незаметно.
 * Поэтому здесь и снимок, и замер выхода за край: панель шире окна — находка,
 * а не «посмотрите глазами».
 *
 * Перед запуском: backend npm run build, frontend npm run build:qa.
 * Запуск: cd dev/qa && node web-uz/shots.mjs
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
const WEB_PORT = Number(process.env.QA_WEB_PORT ?? 4324);
const LOGIN = process.env.QA_LOGIN ?? 'admin';
const PASSWORD = process.env.SEED_PASSWORD ?? 'metall-dev-2026';

fs.mkdirSync(OUT, { recursive: true });

const overflow = [];
const errors = [];
let backend;
let server;
let browser;

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

/** Выход за край окна: и у страницы целиком, и у самой панели поверх неё. */
async function measure(page, tag) {
  const m = await page.evaluate(() => {
    const de = document.documentElement;
    let worst = 0;
    let who = '';
    const panels = [...document.querySelectorAll('*')].filter((el) => {
      const cls = typeof el.className === 'string' ? el.className : '';
      return cls.includes('z-[70]') || cls.includes('z-50') || el.getAttribute('role') === 'dialog';
    });
    for (const el of panels) {
      const r = el.getBoundingClientRect();
      if (r.width < 80 || r.height < 60) continue;
      const out = Math.max(0, Math.round(r.right - window.innerWidth), Math.round(-r.left));
      if (out > worst) {
        worst = out;
        who = (typeof el.className === 'string' ? el.className : '').slice(0, 60);
      }
    }
    return { doc: de.scrollWidth - de.clientWidth, panel: worst, who };
  });
  overflow.push(`${tag}: страница=${m.doc} панель=${m.panel} ${m.who}`);
  return m;
}

async function shoot(page, tag) {
  await page.screenshot({ path: path.join(OUT, `${tag}.png`) });
  return measure(page, tag);
}

try {
  await assertPortFree(API_PORT);
  await assertPortFree(WEB_PORT);
  if (!fs.existsSync(ROOT)) throw new Error(`нет сборки ${ROOT}: сначала npm run build:qa`);

  backend = spawn('node', ['dist/main.js'], {
    cwd: BACKEND,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(API_PORT), CORS_ORIGINS: `http://127.0.0.1:${WEB_PORT}` },
  });
  backend.stderr.on('data', (d) => process.stderr.write(`[api!] ${d}`));
  console.log(`бэкенд отвечает (${await waitForApi(25000)})`);

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

  for (const [w, h, tag] of [
    [1440, 900, '1440'],
    [360, 780, '360'],
  ]) {
    for (const theme of ['light', 'dark']) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h } });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => errors.push(`[${tag}/${theme}] ${e.message.slice(0, 200)}`));
      await page.addInitScript(
        ([t, loc]) => {
          localStorage.setItem('metall_theme', t);
          localStorage.setItem('metall_locale', loc);
        },
        [theme, 'uz'],
      );
      await page.goto(`http://127.0.0.1:${WEB_PORT}/`, { waitUntil: 'networkidle' });
      await page.locator('input[autocomplete="username"]').first().fill(LOGIN);
      await page.locator('input[autocomplete="current-password"]').first().fill(PASSWORD);
      // Экран входа уже под узбекским: кнопка называется «Kirish».
      await page.locator('form button[type="submit"]').first().click();
      await page.waitForSelector('aside', { timeout: 20000 });
      await page.waitForTimeout(1500);

      // Окно поиска по разделам.
      await page.keyboard.press('Control+k');
      await page.waitForTimeout(600);
      await shoot(page, `${tag}-${theme}-poisk`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);

      // Календарь в документах: самая узкая панель с длинными словами.
      const docs = page.locator('[data-module="documents"]').first();
      if (await docs.count()) {
        await docs.click();
        await page.waitForTimeout(1400);
        const cal = page.locator('button:has(svg.lucide-calendar)').first();
        if (await cal.count()) {
          await cal.click({ timeout: 5000 }).catch(() => null);
          await page.waitForTimeout(600);
          await shoot(page, `${tag}-${theme}-kalendar`);
          await page.keyboard.press('Escape');
        } else {
          overflow.push(`${tag}-${theme}-kalendar: кнопки календаря нет`);
        }
      }
      await ctx.close();
    }
  }
} finally {
  if (browser) await browser.close().catch(() => null);
  if (server) await new Promise((r) => server.close(r));
  if (backend) backend.kill('SIGTERM');
}

console.log('\n=== выход за край окна (пикселей)');
for (const line of overflow) console.log(`  ${line}`);
for (const e of errors) console.log(`ошибка страницы: ${e}`);
const bad = overflow.filter((l) => /страница=[1-9]|панель=[1-9]/.test(l));
if (bad.length) {
  console.log('\nПРОГОН КРАСНЫЙ: что-то выехало за край.');
  process.exit(1);
}
console.log(`\nПРОГОН ЗЕЛЁНЫЙ: ничего не выехало. Снимки: ${OUT}`);
