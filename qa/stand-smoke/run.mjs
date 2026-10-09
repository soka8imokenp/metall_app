/**
 * Проверка сборки для внешнего стенда: фронт и API на одном адресе.
 *
 * Отличие от `dashboard-live` и `sales-live` — там фронт и бэкенд на разных
 * портах и живут за счёт CORS. На стенде так не будет: снаружи один хост,
 * `/api/v1` проксируется на бэкенд. Это другая топология, и ломается она
 * по-своему: относительный адрес API, куки и заголовки, пути SPA.
 *
 * Прогон повторяет именно её, поэтому доказывает ровно то, что нужно:
 * собранный `build:stand` работает без `VITE_API_URL` на внешний порт.
 *
 * Перед запуском:
 *   cd dev/frontend && bun run build:stand
 *
 * Запуск по локальной копии топологии:
 *   cd dev/qa && node stand-smoke/run.mjs
 *
 * Запуск против поднятого стенда — тот же прогон, но ничего не поднимает сам:
 *   STAND_URL=https://<хост> STAND_LOGIN=director \
 *   STAND_PASSWORD_FILE=~/.local/state/openclaw/secrets/<файл> \
 *   node stand-smoke/run.mjs
 *
 * Пароль читается из файла и в вывод не попадает.
 */
import { spawn } from 'node:child_process';
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { chromium } from 'playwright-core';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '../../frontend/dist');
const BACKEND = path.resolve(HERE, '../../backend');
const OUT = path.resolve(HERE, 'shots');
// 4400, а не 4000: на 4000 слушает внешний стенд (юнит
// `metall-asia-stand-api`) со своей базой, и прогон бы молча проверял его.
const API_PORT = Number(process.env.QA_API_PORT ?? 4400);
const UPSTREAM = `http://127.0.0.1:${API_PORT}`;
/** Задан внешний адрес — прогон ничего не поднимает, только проверяет. */
const EXTERNAL = process.env.STAND_URL?.replace(/\/$/, '') || null;
const STAND = EXTERNAL ?? 'http://127.0.0.1:4322';
const LOGIN = process.env.STAND_LOGIN ?? 's.radjabov';

/**
 * Пароль стенда живёт в файле 600 и в вывод не попадает. В файле должно быть
 * одно значение и ничего больше: сложить туда весь вывод сида — значит
 * отправить в форму входа всю портянку и получить 401 без объяснения.
 */
function password() {
  const file = process.env.STAND_PASSWORD_FILE;
  if (!file) return process.env.SEED_PASSWORD ?? 'metall-dev-2026';
  const raw = fs.readFileSync(file.replace(/^~/, process.env.HOME), 'utf8').trim();
  if (raw.includes('\n')) {
    throw new Error(`в ${file} больше одной строки: нужен файл с одним паролем`);
  }
  return raw;
}
const PASSWORD = password();

fs.mkdirSync(OUT, { recursive: true });

const errors = [];
const notes = [];
/** Куда уходили запросы: ни один не должен идти мимо адреса стенда. */
const outbound = new Set();
let backend;
let server;
let browser;

async function waitForApi(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${UPSTREAM}/api/v1/dashboard/summary?period=7d`);
      if (r.status > 0) return r.status;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error('бэкенд не поднялся за отведённое время');
}

try {
  if (EXTERNAL) {
    // Снаружи поднимать нечего: всё уже развёрнуто. Проверяем то же самое —
    // что фронт ходит только на адрес стенда и разделы наполнены.
    const r = await fetch(`${STAND}/api/v1/dashboard/summary?period=7d`);
    console.log(`стенд ${STAND}, /api/v1/dashboard/summary без токена → ${r.status}`);
    if (r.status !== 401) {
      errors.push(`сводка без токена вернула ${r.status}, ожидался 401`);
    }
  } else {
  // CORS не задаём намеренно: если фронт всё-таки ходит на чужой адрес,
  // прогон должен это показать, а не замаскировать разрешением.
  const busy = await fetch(`${UPSTREAM}/api/v1/dashboard/summary`).catch(() => null);
  if (busy) throw new Error(`порт ${API_PORT} занят: отвечает чужой процесс (${busy.status})`);
  backend = spawn('node', ['dist/main.js'], {
    cwd: BACKEND,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(API_PORT) },
  });
  backend.stdout.on('data', (d) => process.stdout.write(`[api] ${d}`));
  backend.stderr.on('data', (d) => process.stderr.write(`[api!] ${d}`));
  const status = await waitForApi(20000);
  console.log(`бэкенд отвечает: ${status}`);

  const app = express();

  // Прокси того же вида, что поставит Босс на стенде: путь сохраняется,
  // заголовки и тело переносятся как есть.
  app.use('/api', async (req, res) => {
    const url = `${UPSTREAM}/api${req.originalUrl.slice('/api'.length)}`;
    const headers = { ...req.headers };
    delete headers.host;
    delete headers['content-length'];
    const chunks = [];
    for await (const c of req) chunks.push(c);
    try {
      const upstream = await fetch(url, {
        method: req.method,
        headers,
        body: chunks.length ? Buffer.concat(chunks) : undefined,
      });
      res.status(upstream.status);
      upstream.headers.forEach((v, k) => {
        if (k !== 'content-encoding' && k !== 'content-length' && k !== 'transfer-encoding') {
          res.setHeader(k, v);
        }
      });
      res.send(Buffer.from(await upstream.arrayBuffer()));
    } catch (e) {
      errors.push(`прокси не дошёл до бэкенда: ${e.message}`);
      res.status(502).json({ error: { code: 'PROXY_FAILED', message: e.message } });
    }
  });

  app.use(express.static(ROOT));
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(ROOT, 'index.html')));
  server = await new Promise((resolve) => {
    const s = app.listen(4322, '127.0.0.1', () => resolve(s));
  });
  }

  // Снимки внешнего прогона не затирают локальные: это разные стенды.
  const SUFFIX = EXTERNAL ? '-снаружи' : '';
  for (const [w, h, base] of [[1440, 900, '1440'], [360, 780, '360']]) {
    const tag = `${base}${SUFFIX}`;
    // Браузер на каждый размер свой. Один на оба не годится снаружи: после
    // первого захода Chromium запоминает alt-svc h3 от Cloudflare, второй
    // контекст пробует QUIC и стабильно падает с ERR_QUIC_PROTOCOL_ERROR.
    // Память эта живёт в профиле, а новый запуск получает чистый профиль.
    // Ключ --disable-quic пробовал: он рвёт и обычный TCP (ERR_CONNECTION_RESET).
    browser = await chromium.launch({
      executablePath: '/home/an/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
      args: ['--no-sandbox'],
    });
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    // Падение внутри прогона — это находка, а не авария скрипта. Иначе самая
    // частая поломка (фронт собран на чужой адрес) убивает процесс раньше,
    // чем он успеет сказать, на какой именно адрес фронт ходил.
    try {
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`[${tag}] ${m.text().slice(0, 300)}`);
    });
    page.on('pageerror', (e) => errors.push(`[${tag}] PAGEERROR ${e.message.slice(0, 300)}`));
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (u.protocol.startsWith('http')) outbound.add(u.origin);
    });
    page.on('response', (r) => {
      if (r.url().includes('/api/v1/') && r.status() >= 400) {
        errors.push(`[${tag}] ${r.status()} ${new URL(r.url()).pathname}`);
      }
    });

    await page.goto(STAND, { waitUntil: 'networkidle' });

    // Предупреждение про моки на экране входа — значит собрали не тем скриптом.
    if (await page.getByText('Режим моков').count()) {
      errors.push(`[${tag}] сборка в режиме моков, нужен build:stand`);
    }

    await page.locator('input[autocomplete="username"]').first().fill(LOGIN);
    await page.locator('input[autocomplete="current-password"]').first().fill(PASSWORD);
    await page.getByRole('button', { name: 'Войти' }).click();
    await page.waitForSelector('text=/Выручка|Tushum/', { state: 'attached', timeout: 15000 });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${OUT}/dashboard-${tag}.png`, fullPage: true });
    notes.push(`[${tag}] дашборд открылся под ${LOGIN}`);

    await page.getByRole('button', { name: 'Продажи', exact: true }).first().click();
    await page.waitForTimeout(1500);
    const footer = await page.locator('text=/Записей:\\s*\\d+/').first().innerText().catch(() => '');
    const count = Number(footer.match(/(\d+)/)?.[1] ?? 0);
    notes.push(`[${tag}] продажи: ${footer.trim() || '(подвала нет)'}`);
    if (count === 0) errors.push(`[${tag}] продажи пусты: ${footer || 'подвала нет'}`);
    await page.screenshot({ path: `${OUT}/sales-${tag}.png`, fullPage: true });

    // Цех есть только у завода: под торговым домом производство пусто и это
    // правда. Значит компанию надо переключить — тем же переключателем, что
    // и у человека, и на узком экране тоже.
    await page.locator('aside [data-company-switch="logo"]').first().click();
    await page.waitForTimeout(400);
    await page.getByText('Ташкентский изоляционный завод', { exact: false }).first().click({ timeout: 5000 });
    await page.waitForTimeout(1200);
    notes.push(`[${tag}] компания переключена на завод`);

    // Производство: третий живой раздел. В цеховых заказах должны быть не
    // только строки, но и события журнала — без них длительности этапов не
    // на чем держаться.
    await page.getByRole('button', { name: 'Производство', exact: true }).first().click();
    await page.waitForTimeout(1500);

    // Подвал этого списка показывает наполненность двумя разными строками, и
    // какая из них видна — зависит от количества заказов. Пока всё влезло на
    // страницу, это «Записей: N»; как только заказов стало больше страницы
    // (25 штук), на то же место встаёт «Заказы 1–25 из 36» с кнопками
    // листания. Проверка знала только первую строку и на стенде, где заказов
    // 36, читала «подвала нет» — то есть объявляла раздел пустым ровно
    // потому, что он наполнен сверх одной страницы.
    const prodFooter = await page
      .locator('text=/(Записей|Yozuvlar):\\s*\\d+|(Заказы|Buyurtmalar)\\s+\\d+.+\\d+/')
      .first()
      .innerText()
      .catch(() => '');
    // Берём наибольшее число строки: у «Записей: 25» оно одно, у «Заказы 1–25
    // из 36» это всего заказов, а не размер страницы.
    const prodCount = Math.max(0, ...(prodFooter.match(/\d+/g) ?? []).map(Number));
    notes.push(`[${tag}] производство: ${prodFooter.trim() || '(подвала нет)'}`);
    if (prodCount === 0) errors.push(`[${tag}] производство пусто: ${prodFooter || 'подвала нет'}`);

    // Журнал этапов смотрим не у первого заказа списка, а у первого, где он
    // вообще должен быть. Сверху лежат самые поздние по сроку, а поздний заказ
    // обычно ещё не запускали: у черновика и у свежесозданного этапов нет, и
    // пустой журнал у него — правда, а не поломка. Прежняя проверка кликала
    // первую строку и падала на ПР-00033 с пометкой «этапы 0/0».
    const list = page.locator('div[class*="divide-y"]').first();
    const rows = list.locator(':scope > button');
    // Панель заказа, а не весь body: слова журнала не должны случайно
    // находиться в соседних блоках страницы.
    const panel = page.locator('div[class*="col-span-4"]').last();
    const tries = Math.min(await rows.count(), 6);
    let events = 0;
    let checked = 0;
    let seen = '';
    for (let i = 0; i < tries && events === 0; i += 1) {
      await rows.nth(i).click();
      await page.waitForTimeout(1200);
      const text = await panel.innerText().catch(() => '');
      events = (text.match(/завершили|начали|остановили|возобновили/g) ?? []).length;
      seen = (text.split('\n')[0] ?? '').trim();
      checked = i + 1;
    }
    notes.push(`[${tag}] журнал этапов: открыто заказов ${checked} из ${tries}, событий у ${seen || '—'}: ${events}`);
    if (events === 0) {
      errors.push(`[${tag}] ни у одного из ${tries} заказов в журнале этапов нет событий`);
    }
    await page.screenshot({ path: `${OUT}/production-${tag}.png`, fullPage: true });

    // Перезагрузка по внутреннему пути: на стенде SPA отдаётся с любого адреса,
    // и вход не должен слетать от F5.
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    if ((await page.locator('input[autocomplete="current-password"]').count()) > 0) {
      errors.push(`[${tag}] после перезагрузки выбросило на экран входа`);
    }
    } catch (e) {
      errors.push(`[${tag}] прогон оборвался: ${String(e.message).split('\n')[0]}`);
      await page.screenshot({ path: `${OUT}/FAIL-${tag}.png`, fullPage: true }).catch(() => {});
    }

    await ctx.close();
    // Браузер свой на каждый размер — закрываем тут же. Оставленный живым
    // держит процесс после конца прогона: вывод уже напечатан, а node не
    // выходит.
    await browser.close().catch(() => {});
    browser = null;
  }

  /**
   * Чужой адрес в запросах — по умолчанию ошибка. Разрешать поимённо через
   * STAND_ALLOWED_ORIGINS: Cloudflare, например, сам вставляет в страницу свой
   * beacon аналитики, и это решение владельца зоны, а не свойство сборки.
   * Молча зеленеть на стороннем скрипте прогон не должен.
   */
  const allowed = (process.env.STAND_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const foreign = [...outbound].filter((o) => o !== STAND && !allowed.includes(o));
  if (foreign.length) errors.push(`запросы мимо стенда: ${foreign.join(', ')}`);

  const allowedSeen = [...outbound].filter((o) => allowed.includes(o));
  if (allowedSeen.length) notes.push(`сторонние источники, разрешённые явно: ${allowedSeen.join(', ')}`);

  fs.writeFileSync(`${OUT}/stand${EXTERNAL ? '-снаружи' : ''}.txt`, [...notes, `адреса: ${[...outbound].join(', ')}`].join('\n') + '\n');
  fs.writeFileSync(`${OUT}/console-errors${EXTERNAL ? '-снаружи' : ''}.txt`, (errors.join('\n') || 'нет') + '\n');

  console.log('--- что показано ---');
  console.log(notes.join('\n'));
  console.log(`--- адреса запросов ---\n${[...outbound].join('\n')}`);
  console.log('--- ошибки ---');
  console.log(errors.join('\n') || 'нет');

  if (errors.length) {
    console.error(`--- ПРОГОН НЕ ПРОЙДЕН --- ошибок: ${errors.length}`);
    process.exitCode = 1;
  } else {
    console.log('--- прогон пройден ---');
  }
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.close();
  if (backend) backend.kill('SIGTERM');
}
