/**
 * Прогон дашборда против живого бэкенда.
 *
 * Всё в одном переднем процессе: фоновые запуски (`&`, `nohup`, `tmux`) запрещены,
 * поэтому бэкенд поднимается дочерним процессом и глушится в finally.
 *
 * Перед запуском собрать фронт с живым API:
 *   cd dev/frontend && bun run build:qa   # сборка для прогона, каталог dist-qa
 *
 * Запуск:
 *   cd dev/qa && bun run dashboard-live
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
/**
 * Порт 4400, а не 4000: на 4000 живёт внешний стенд (юнит
 * `metall-asia-stand-api`), у него своя база. Прогон, попавший на чужой
 * бэкенд, врёт молча — поэтому занятый порт здесь ошибка, а не предупреждение.
 */
const API_PORT = Number(process.env.QA_API_PORT ?? 4400);

async function assertPortFree() {
  const res = await fetch(`http://127.0.0.1:${API_PORT}/api/v1/dashboard/summary`).catch(() => null);
  if (res) {
    throw new Error(
      `порт ${API_PORT} уже занят: на нём кто-то отвечает (${res.status}). ` +
        'Останови чужой процесс или задай QA_API_PORT.',
    );
  }
}

const API = `http://127.0.0.1:${API_PORT}/api/v1`;
const LOGIN = 's.radjabov';
const PASSWORD = process.env.SEED_PASSWORD ?? 'metall-dev-2026';

fs.mkdirSync(OUT, { recursive: true });

const errors = [];
const overflow = [];
/**
 * Код единицы вместо подписи: в ячейке стоит «120 t», а не «120 т».
 *
 * Коды (`t`, `pm`, `pcs`) — внутренний язык базы. Человек на русском экране
 * должен видеть «т», «п.м.», «шт», иначе он не поймёт, в чём план.
 */
const unitCodes = [];
/** Переход по номеру заказа из строки плана: раздел и подстановка номера. */
const jump = [];
let backend;
let server;
let browser;

async function waitForApi(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // 401 тоже годится: значит процесс слушает и маршруты подняты.
      const r = await fetch(`${API}/dashboard/summary?period=7d`);
      if (r.status > 0) return r.status;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error('бэкенд не поднялся за отведённое время');
}

try {
  await assertPortFree();
  backend = spawn('node', ['dist/main.js'], {
    cwd: BACKEND,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Статика прогона отдаётся с 4321, а не с вайтовского 5173 — иначе
    // preflight не проходит и фронт видит только «сервер недоступен».
    env: {
      ...process.env,
      PORT: String(API_PORT),
      CORS_ORIGINS: 'http://localhost:5173,http://127.0.0.1:4321',
    },
  });
  backend.stdout.on('data', (d) => process.stdout.write(`[api] ${d}`));
  backend.stderr.on('data', (d) => process.stderr.write(`[api!] ${d}`));

  const status = await waitForApi(20000);
  console.log(`бэкенд отвечает, /dashboard/summary без токена → ${status}`);

  const app = express();
  app.use(express.static(ROOT));
  // Express 5 / path-to-regexp v8: звёздочка без имени больше не маршрут.
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
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(`[${tag}/${theme}] ${m.text().slice(0, 300)}`);
      });
      page.on('pageerror', (e) => errors.push(`[${tag}/${theme}] PAGEERROR ${e.message.slice(0, 300)}`));
      await page.addInitScript((t) => localStorage.setItem('metall_theme', t), theme);

      await page.goto('http://127.0.0.1:4321/', { waitUntil: 'networkidle' });
      await page.waitForTimeout(400);

      // Экран входа: убеждаемся, что предупреждения про моки нет.
      const mockNotice = await page.getByText('Режим моков').count();
      if (mockNotice > 0) errors.push(`[${tag}/${theme}] фронт собран в режиме моков`);
      await page.screenshot({ path: `${OUT}/login-${tag}-${theme}.png`, fullPage: true });

      await page.getByLabel('Логин').or(page.locator('input[autocomplete="username"]')).first().fill(LOGIN);
      await page.locator('input[autocomplete="current-password"]').first().fill(PASSWORD);
      page.on('response', (r) => {
        if (r.url().includes('/auth/login')) console.log(`[login] → ${r.status()}`);
      });
      await page.getByRole('button', { name: 'Войти' }).click();

      // Ждём первую карточку KPI с настоящим числом.
      try {
        // attached, а не visible: на 360 карточка может быть за краем вьюпорта,
        // и это отдельная находка про вёрстку, а не повод падать на входе.
        await page.waitForSelector('text=/Выручка|Tushum/', { state: 'attached', timeout: 15000 });
      } catch (e) {
        await page.screenshot({ path: `${OUT}/FAIL-${tag}-${theme}.png`, fullPage: true });
        const txt = await page.locator('body').innerText();
        console.log(`[fail ${tag}/${theme}] текст страницы: ${txt.slice(0, 500) || '(пусто)'}`);
        console.log(`[fail ${tag}/${theme}] консоль:\n${errors.join('\n') || 'нет'}`);
        throw e;
      }
      await page.waitForTimeout(1200);

      const raw = await page.evaluate(() => {
        const out = [];
        for (const td of document.querySelectorAll('main table td')) {
          const t = (td.innerText || '').trim();
          if (t) out.push(t.slice(0, 60));
        }
        return out;
      });
      for (const cell of raw) {
        const hit = cell.match(/(?:^|\s)(t|kg|pm|m|pcs|m3)$/);
        if (hit) unitCodes.push(`[${tag}/${theme}] «${cell}» — код «${hit[1]}» вместо подписи`);
      }

      for (const collapsed of [false, true]) {
        if (collapsed) {
          const toggle = page.getByRole('button', { name: /боковую панель/i }).first();
          if ((await toggle.count()) === 0) throw new Error('кнопка сворачивания сайдбара не найдена');
          await toggle.click();
          await page.waitForTimeout(500);
        }
        // Подпись по факту, а не по намерению: на узком экране сайдбар уже
        // свёрнут при старте, и клик по кнопке его разворачивает.
        const asideWidth = await page.evaluate(() => {
          const a = document.querySelector('aside');
          return a ? Math.round(a.getBoundingClientRect().width) : 0;
        });
        const suffix = asideWidth > 120 ? 'expanded' : 'collapsed';
        await page.screenshot({ path: `${OUT}/dashboard-${tag}-${theme}-${suffix}.png`, fullPage: true });

        const ov = await page.evaluate(() => {
          const de = document.documentElement;
          const main = document.querySelector('main');
          const over = main ? main.scrollWidth - main.clientWidth : null;

          // Кто именно вылез: элемент шире родителя, у которого нет своей
          // горизонтальной прокрутки. Без этого «main=142» ни о чём не говорит.
          const culprits = [];
          if (main && over > 0) {
            const right = main.getBoundingClientRect().right;
            for (const el of main.querySelectorAll('*')) {
              const r = el.getBoundingClientRect();
              if (r.width === 0 || r.right <= right + 1) continue;
              const scroller = el.closest('[class*="overflow-x-auto"]');
              if (scroller && scroller !== el) continue;
              culprits.push(
                `${el.tagName.toLowerCase()}.${String(el.className).split(' ').slice(0, 3).join('.')} +${Math.round(r.right - right)}px`,
              );
              if (culprits.length >= 3) break;
            }
          }
          return { doc: de.scrollWidth - de.clientWidth, main: over, culprits };
        });
        // Первый замер в каждом прогоне — состояние по умолчанию, то, что
        // пользователь видит, ничего не нажимая. Спрос с него строгий.
        overflow.push({
          key: `${tag}/${theme}/${suffix}`,
          isDefault: !collapsed,
          doc: ov.doc,
          main: ov.main,
          culprits: ov.culprits,
        });
      }

      // Вкладки таблицы: вторая с данными, третья без источника.
      for (const [label, name] of [
        ['Выполненные', 'done'],
        ['Смены и персонал', 'nosource'],
      ]) {
        const tab = page.getByRole('button', { name }).first();
        const byText = page.locator('button', { hasText: new RegExp(`^\\s*${label}`) }).first();
        const target = (await byText.count()) ? byText : tab;
        if (await target.count()) {
          await target.click({ timeout: 3000 }).catch(() => {});
          await page.waitForTimeout(900);
          await page.screenshot({ path: `${OUT}/table-${name}-${tag}-${theme}.png`, fullPage: true });
        }
      }

      /**
       * Номер в строке плана ведёт в сам заказ.
       *
       * Раньше он открывал окно прослеживаемости партии и передавал туда номер
       * заказа. Партии с таким идентификатором нет: окно отвечало отказом всегда,
       * на любой строке. Проверяем по делу — после клика открыт раздел заказа и
       * номер подставлен в его поиск, а список сужен до этой записи.
       */
      await page.locator('button', { hasText: /^\s*(План производства|Ishlab chiqarish rejasi)/ }).first().click();
      await page.waitForTimeout(1200);

      const numberLink = page.locator('main table td button.font-mono').first();
      if ((await numberLink.count()) === 0) {
        jump.push(`[${tag}/${theme}] в плане нет ни одного номера-ссылки`);
      } else {
        const number = (await numberLink.innerText()).trim();
        await numberLink.click();
        await page.waitForTimeout(1800);

        const after = await page.evaluate(() => {
          const active = [...document.querySelectorAll('aside button, aside a')].find(
            (n) => n.getAttribute('aria-current') === 'page' || /bg-zinc-9|bg-white/.test(String(n.className)),
          );
          const inputs = [...document.querySelectorAll('main input')].map((i) => i.value);
          // Название раздела живёт в шапке рядом с кнопкой сайдбара, а не в main.
          const header = document.querySelector('header');
          return {
            head: (header?.innerText ?? '').split('\n').map((s) => s.trim()).filter(Boolean).join(' '),
            inputs,
            body: (document.querySelector('main')?.innerText ?? '').slice(0, 4000),
            aside: (active?.textContent ?? '').trim(),
          };
        });

        // Старое окно узнаётся по своему отказу: пока он на экране, переход не состоялся.
        if (/Прослеживаемость партии показать не удалось|Partiya kuzatuvi ko/.test(after.body)) {
          jump.push(`[${tag}/${theme}] клик по номеру ${number} открыл окно прослеживаемости с отказом`);
        }
        if (!/Производство|Продажи|Ishlab chiqarish|Sotuvlar/.test(after.head)) {
          jump.push(`[${tag}/${theme}] после клика по ${number} раздел не открылся, заголовок: «${after.head}»`);
        }
        if (!after.inputs.some((v) => v === number)) {
          jump.push(
            `[${tag}/${theme}] номер ${number} не подставлен в поиск раздела (в полях: ${after.inputs.join(' | ') || 'пусто'})`,
          );
        }
        if (!after.body.includes(number)) {
          jump.push(`[${tag}/${theme}] заказ ${number} не найден в открытом разделе`);
        }
        await page.screenshot({ path: `${OUT}/jump-order-${tag}-${theme}.png`, fullPage: true });
        console.log(`[${tag}/${theme}] переход по номеру ${number} → «${after.head}»`);
      }

      await ctx.close();
    }
  }

  const lines = overflow.map(
    (o) =>
      `${o.key}${o.isDefault ? ' (по умолчанию)' : ''}: doc=${o.doc} main=${o.main}` +
      (o.culprits.length ? `\n    виновники: ${o.culprits.join(' | ')}` : ''),
  );
  fs.writeFileSync(`${OUT}/overflow.txt`, lines.join('\n') + '\n');
  fs.writeFileSync(`${OUT}/console-errors.txt`, (errors.join('\n') || 'нет') + '\n');
  console.log('--- переполнение по горизонтали ---');
  console.log(lines.join('\n'));
  console.log('--- ошибки консоли ---');
  console.log(errors.join('\n') || 'нет');

  // Прогон обязан падать сам, иначе «посмотрел и вроде норм» — не проверка.
  const problems = [];
  if (errors.length) problems.push(`ошибок в консоли: ${errors.length}`);
  for (const j of jump) problems.push(`переход по номеру заказа — ${j}`);
  for (const u of new Set(unitCodes)) problems.push(`единица кодом, а не подписью — ${u}`);
  for (const o of overflow) {
    if (o.doc > 0) problems.push(`документ вылез за вьюпорт — ${o.key}: doc=${o.doc}`);
    if (o.isDefault && o.main > 0) {
      problems.push(
        `содержимое вылезло в состоянии по умолчанию — ${o.key}: main=${o.main}` +
          (o.culprits.length ? ` (${o.culprits[0]})` : ''),
      );
    }
  }
  if (problems.length) {
    console.error('--- ПРОГОН НЕ ПРОЙДЕН ---\n' + problems.join('\n'));
    process.exitCode = 1;
  } else {
    console.log('--- прогон пройден ---');
  }
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.close();
  if (backend) backend.kill('SIGTERM');
}
