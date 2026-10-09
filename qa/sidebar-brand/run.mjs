/**
 * Сайдбар: логотип над выбором бизнеса и плавное сворачивание.
 *
 * Проверяет ровно то, что заказано:
 *   1. логотип стоит над пунктом выбора бизнеса;
 *   2. у пункта выбора бизнеса нет иконки слева от названия;
 *   3. свёрнутая панель оставляет от логотипа красный квадрат;
 *   4. панель и её пункты едут плавно — тот же узел DOM, объявленный переход
 *      по ширине и замеренная промежуточная ширина посреди движения.
 *
 * Перед запуском собрать фронт с живым API:
 *   cd dev/frontend && npm run build:qa
 *
 * Запуск:
 *   cd dev/qa && node sidebar-brand/run.mjs
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
const API = `http://127.0.0.1:${API_PORT}/api/v1`;
const LOGIN = 's.radjabov';
const PASSWORD = process.env.SEED_PASSWORD ?? 'metall-dev-2026';

fs.mkdirSync(OUT, { recursive: true });

const problems = [];
const errors = [];
let backend;
let server;
let browser;

async function assertPortFree() {
  const res = await fetch(`${API}/dashboard/summary`).catch(() => null);
  if (res) throw new Error(`порт ${API_PORT} занят: отвечает ${res.status}`);
}

async function waitForApi(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${API}/dashboard/summary?period=7d`);
      if (r.status > 0) return r.status;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error('бэкенд не поднялся за отведённое время');
}

/** Геометрия сайдбара одним замером: всё, на чём стоят проверки ниже. */
const probe = () => {
  const aside = document.querySelector('aside');
  if (!aside) return null;
  const cs = getComputedStyle(aside);
  const logo = aside.querySelector('img[alt="METALL ASIA"]');
  const logoBox = logo?.closest('button') ?? null;
  // Пункт ищется по признаку в разметке, а не по названию компании: имена
  // юрлиц сменились 08.10 («Металл Азия», «ТИЗ»), и список слов для поиска
  // устарел молча - прогон сказал «пункта нет», хотя пункт стоял на месте.
  const switcher = aside.querySelector('button[data-company-switch="label"]');
  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, top: r.top, left: r.left, right: r.right };
  };
  const nav = [...aside.querySelectorAll('nav button[data-module]')].map((b) => {
    const svg = b.querySelector('svg');
    const r = svg?.getBoundingClientRect();
    return { id: b.dataset.module, center: r ? r.left + r.width / 2 : null };
  });
  // Иконки внутри пункта выбора бизнеса: важно, стоят ли они слева от текста.
  const switcherIcons = switcher
    ? [...switcher.querySelectorAll('svg')].map((s) => {
        const r = s.getBoundingClientRect();
        const label = switcher.querySelector('span');
        const lr = label?.getBoundingClientRect();
        return { left: r.left, beforeLabel: lr ? r.left < lr.left : false };
      })
    : [];
  // Слово «METALL ASIA» — второй рисунок внутри той же плашки.
  const wordmark = logoBox ? [...logoBox.querySelectorAll('img')].find((i) => i !== logo) ?? null : null;
  return {
    aside: rect(aside),
    transitionProperty: cs.transitionProperty,
    transitionDuration: cs.transitionDuration,
    logo: rect(logo),
    wordmark: rect(wordmark),
    logoBox: rect(logoBox),
    logoOpacity: logo ? Number(getComputedStyle(logo).opacity) : null,
    glyphHeight: logo ? logo.getBoundingClientRect().height : null,
    logoBg: logoBox ? getComputedStyle(logoBox).backgroundImage : null,
    logoRadius: logoBox ? getComputedStyle(logoBox).borderTopLeftRadius : null,
    switcher: rect(switcher ?? null),
    switcherIcons,
    nav,
    docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
};

try {
  await assertPortFree();
  backend = spawn('node', ['dist/main.js'], {
    cwd: BACKEND,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(API_PORT),
      CORS_ORIGINS: 'http://localhost:5173,http://127.0.0.1:4321',
    },
  });
  backend.stderr.on('data', (d) => process.stderr.write(`[api!] ${d}`));
  await waitForApi(20000);

  const app = express();
  app.use(express.static(ROOT));
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(ROOT, 'index.html')));
  server = await new Promise((resolve) => {
    const s = app.listen(4321, '127.0.0.1', () => resolve(s));
  });

  browser = await chromium.launch({
    executablePath: '/home/an/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
    args: ['--no-sandbox'],
  });

  for (const [w, h, tag] of [[1440, 900, '1440'], [360, 780, '360']]) {
    for (const theme of ['light', 'dark']) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h } });
      const page = await ctx.newPage();
      const mark = `[${tag}/${theme}]`;
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(`${mark} ${m.text().slice(0, 300)}`);
      });
      page.on('pageerror', (e) => errors.push(`${mark} PAGEERROR ${e.message.slice(0, 300)}`));
      await page.addInitScript((t) => {
        localStorage.setItem('metall_theme', t);
        localStorage.setItem('metall_locale', 'ru');
      }, theme);
      await page.goto('http://127.0.0.1:4321/', { waitUntil: 'networkidle' });

      await page.locator('input[autocomplete="username"]').first().fill(LOGIN);
      await page.locator('input[autocomplete="current-password"]').first().fill(PASSWORD);
      await page.getByRole('button', { name: 'Войти' }).click();
      try {
        await page.waitForSelector('aside [data-module="dashboard"]', { state: 'attached', timeout: 15000 });
      } catch (e) {
        await page.screenshot({ path: `${OUT}/FAIL-${tag}-${theme}.png`, fullPage: true });
        console.log(`[fail ${mark}] текст: ${(await page.locator('body').innerText()).slice(0, 400)}`);
        console.log(`[fail ${mark}] консоль: ${errors.join(' | ').slice(0, 400) || 'нет'}`);
        throw e;
      }
      await page.waitForTimeout(1200);

      const toggle = page.getByRole('button', { name: /боковую панель/i }).first();
      if ((await toggle.count()) === 0) {
        const labels = await page.evaluate(() =>
          [...document.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') || b.title || '').filter(Boolean),
        );
        throw new Error(`кнопка сворачивания сайдбара не найдена; что есть: ${labels.join(' | ').slice(0, 300)}`);
      }

      // Начинаем всегда с развёрнутой панели: на 360 она свёрнута сама.
      let state = await page.evaluate(probe);
      if (!state) throw new Error(`${mark} сайдбара нет в разметке`);
      if (state.aside.w < 120) {
        await toggle.click();
        await page.waitForTimeout(600);
        state = await page.evaluate(probe);
      }

      // 1. Логотип есть и стоит над выбором бизнеса.
      if (!state.logo) {
        problems.push(`${mark} в сайдбаре нет логотипа (img[alt="METALL ASIA"])`);
      } else if (!state.switcher) {
        problems.push(`${mark} не нашёл пункт выбора бизнеса`);
      } else if (state.logoBox.top >= state.switcher.top) {
        problems.push(
          `${mark} логотип не над выбором бизнеса: лого y=${Math.round(state.logoBox.top)}, пункт y=${Math.round(state.switcher.top)}`,
        );
      }

      // 2. У пункта выбора бизнеса нет иконки слева от названия.
      const leftIcons = state.switcherIcons.filter((i) => i.beforeLabel);
      if (leftIcons.length > 0) {
        problems.push(`${mark} у пункта выбора бизнеса осталась иконка слева (${leftIcons.length} шт.)`);
      }

      // 1б. Плашка со скруглением и с отступом от краёв панели (решение
      // Отабека от 05.10: заливку до краёв вернули к рамке с полями).
      if (state.logoBox) {
        const a = state.aside;
        const b = state.logoBox;
        if (b.left - a.left < 4 || a.right - b.right < 4) {
          problems.push(
            `${mark} плашка легла на края панели: ${Math.round(b.left)}..${Math.round(b.right)} в панели ${Math.round(a.left)}..${Math.round(a.right)}`,
          );
        }
        if (b.top - a.top < 4) {
          problems.push(
            `${mark} над плашкой нет отступа: верх плашки ${Math.round(b.top)}, верх панели ${Math.round(a.top)}`,
          );
        }
        if (parseFloat(state.logoRadius ?? '0') < 6) {
          problems.push(`${mark} у плашки нет скругления: ${state.logoRadius}`);
        }
        // Нижний предел знака: 06.10 заказчик попросил уменьшить логотип,
        // знак стал 16 точек вместо 20. Предел опущен до 14 — ниже знак
        // перестаёт читаться, и прогон обязан краснеть.
        if ((state.glyphHeight ?? 0) < 14) {
          problems.push(`${mark} эмблема мелкая: ${Math.round(state.glyphHeight ?? 0)} точек в высоту`);
        }
        // 1в. Логотип не упирается в края плашки: поле внутри плашки слева от
        // знака и справа от слова (решение Отабека от 05.10 — «край красного
        // прямоугольника упирается в лого»).
        const padLeft = state.logo ? state.logo.left - b.left : null;
        const padRight = state.wordmark ? b.right - state.wordmark.right : null;
        if (padLeft !== null && padLeft < 10) {
          problems.push(`${mark} знак упирается в левый край плашки: поле ${Math.round(padLeft)} точек`);
        }
        if (padRight !== null && padRight < 10) {
          problems.push(`${mark} слово упирается в правый край плашки: поле ${Math.round(padRight)} точек`);
        }
      }

      // 4a. Переход по ширине объявлен на самой панели.
      const hasWidthTransition =
        /width/.test(state.transitionProperty) || /all/.test(state.transitionProperty);
      const durMs = Math.max(
        ...state.transitionDuration.split(',').map((d) => (parseFloat(d) || 0) * (d.includes('ms') ? 1 : 1000)),
      );
      if (!hasWidthTransition || durMs < 150) {
        problems.push(
          `${mark} у панели нет перехода по ширине: property=${state.transitionProperty}, duration=${state.transitionDuration}`,
        );
      }

      await page.screenshot({ path: `${OUT}/sidebar-${tag}-${theme}-expanded.png` });

      // 4b. Тот же узел DOM до и после переключения + промежуточная ширина.
      const asideHandle = await page.$('aside');
      const widthBefore = state.aside.w;
      await toggle.click();
      await page.waitForTimeout(140);
      const mid = await page.evaluate(() => {
        const a = document.querySelector('aside');
        return a ? a.getBoundingClientRect().width : 0;
      });
      await page.screenshot({ path: `${OUT}/sidebar-${tag}-${theme}-midway.png` });
      await page.waitForTimeout(600);

      const stillSame = await asideHandle.evaluate((el) => el.isConnected).catch(() => false);
      if (!stillSame) {
        problems.push(`${mark} при сворачивании панель пересобирается заново — плавности быть не может`);
      }
      if (!(mid > 70 && mid < widthBefore - 10)) {
        problems.push(
          `${mark} панель схлопнулась рывком: через 140 мс ширина ${Math.round(mid)} (была ${Math.round(widthBefore)})`,
        );
      }

      const collapsedState = await page.evaluate(probe);
      await page.screenshot({ path: `${OUT}/sidebar-${tag}-${theme}-collapsed.png` });

      // 3. От логотипа остался красный квадрат.
      if (!collapsedState.logoBox) {
        problems.push(`${mark} в свёрнутой панели логотипа нет вовсе`);
      } else {
        const { w: lw, h: lh } = collapsedState.logoBox;
        if (Math.abs(lw - lh) > 2) {
          problems.push(`${mark} свёрнутый логотип не квадрат: ${Math.round(lw)}×${Math.round(lh)}`);
        }
        if (!/rgb\(209, 35, 72\)|rgb\(179, 18, 49\)/.test(collapsedState.logoBg ?? '')) {
          problems.push(`${mark} свёрнутый логотип не красный: ${collapsedState.logoBg}`);
        }
        // Знак виден целиком в обоих состояниях: срезанный краем панели
        // знак перестаёт быть знаком, поэтому в свёрнутой полосе он садится
        // по ширине, а не обрезается.
        if (collapsedState.logoOpacity !== 1) {
          problems.push(
            `${mark} в свёрнутой панели знак пропал (opacity=${collapsedState.logoOpacity})`,
          );
        }
        // Нижний предел знака свой на состояние: в свёрнутой полосе знак
        // ограничен её шириной (аспект 2,86:1 — при высоте 14 он уже 40 точек
        // в ширину), поэтому там предел ниже. 06.10 заказчик попросил уменьшить
        // логотип в обоих состояниях: знак стал 16 в развёрнутой и 11 в
        // свёрнутой.
        for (const [where, st, min] of [
          ['развёрнутой', state, 14],
          ['свёрнутой', collapsedState, 10],
        ]) {
          const g = st.logo;
          const box = st.logoBox;
          if (!g || !box) continue;
          if (g.left < box.left - 0.5 || g.right > box.right + 0.5) {
            problems.push(
              `${mark} в ${where} панели знак обрезан краем: ${Math.round(g.left)}..${Math.round(g.right)} в плашке ${Math.round(box.left)}..${Math.round(box.right)}`,
            );
          }
          if ((st.glyphHeight ?? 0) < min) {
            problems.push(
              `${mark} в ${where} панели знак мельче ${min} точек: ${Math.round(st.glyphHeight ?? 0)}`,
            );
          }
        }
      }

      // Иконки пунктов стоят по центру свёрнутой полосы.
      const half = collapsedState.aside.w / 2;
      for (const item of collapsedState.nav ?? []) {
        if (item.center == null) continue;
        if (Math.abs(item.center - half) > 3) {
          problems.push(
            `${mark} иконка «${item.id}» не по центру свёрнутой полосы: ${Math.round(item.center)} вместо ${Math.round(half)}`,
          );
        }
      }

      if (collapsedState.docOverflow > 0) {
        problems.push(`${mark} свёрнутая панель вылезает за экран на ${collapsedState.docOverflow}`);
      }

      await ctx.close();
    }
  }
} finally {
  if (browser) await browser.close();
  if (server) server.close();
  if (backend) backend.kill('SIGTERM');
}

const consoleErrors = errors.filter((e) => !/favicon|cloudflareinsights/i.test(e));
for (const e of consoleErrors) problems.push(`консоль: ${e}`);

console.log(`снимки: ${OUT}`);
if (problems.length) {
  console.log(`\nКРАСНЫЙ, находок ${problems.length}:`);
  for (const p of problems) console.log(` - ${p}`);
  process.exit(1);
}
console.log('\nЗЕЛЁНЫЙ: логотип над выбором бизнеса, иконки у пункта нет, свёрнутый логотип — красный квадрат, панель едет плавно');
