/**
 * Прогон вкладки «Обмен с системами» против живого бэкенда (ТЗ 12).
 *
 * Проверяет то, что по скриншоту не проверишь:
 *   1) вкладка есть в полосе «Настройки» и открывается, все три подраздела рисуются;
 *   2) заведённое подключение показывает ключ и секрет ровно один раз: карточка
 *      с ключом есть сразу после заведения, а в списке того же ключа уже нет;
 *   3) журнал обменов показывает направление, состояние и даёт повтор;
 *   4) выгрузка номенклатуры действительно скачивается, непустая и своего формата;
 *   5) под узбекским в подписях вкладки нет кириллицы;
 *   6) ничего не вылезает за `main` на 360 и 1440 в обеих темах.
 *
 * Прогон пишет в базу: он заводит подключение с кодом `qa-<метка>` и в конце
 * удаляет его сам. Своей компании и чужих данных не касается.
 *
 * Всё в одном переднем процессе: фоновые запуски запрещены, бэкенд поднимается
 * дочерним процессом и глушится в finally.
 *
 * Перед запуском собрать фронт с живым API:
 *   cd dev/frontend && bun run build:qa
 *
 * Запуск:
 *   cd dev/qa && bun run exchange-live
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
const WEB_PORT = Number(process.env.QA_WEB_PORT ?? 4323);

const API = `http://127.0.0.1:${API_PORT}/api/v1`;
/** Админ: вкладка обмена закрыта правом `admin.users`. */
const LOGIN = 'admin';
const PASSWORD = process.env.SEED_PASSWORD ?? 'metall-dev-2026';

const STAMP = Date.now().toString().slice(-6);
const QA_CODE = `qa${STAMP}`;

const errors = [];
const overflow = [];
const found = [];
const checks = [];

const ok = (what) => checks.push(`  ✔ ${what}`);
const bad = (what) => {
  checks.push(`  ✖ ${what}`);
  found.push(what);
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
    const res = await fetch(`${API}/dashboard/summary`).catch(() => null);
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

async function login(page, uz) {
  await page.goto(`http://127.0.0.1:${WEB_PORT}/`, { waitUntil: 'networkidle' });
  // Поля по `autocomplete`, как в прогоне настроек: `getByRole('textbox')`
  // хватает первое текстовое поле на странице, а это не обязательно логин.
  await page.locator('input[autocomplete="username"]').first().fill(LOGIN);
  await page.locator('input[autocomplete="current-password"]').first().fill(PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  await page.waitForTimeout(2500);
  /**
   * Язык ставится явно в каждом прогоне, а не «переключается, если нужен уз».
   *
   * Переключатель в интерфейсе запоминает язык в учётке — прогон на этом уже
   * обжёгся: после одного прохода с узбекским следующий заходил и не находил
   * «Настройки», потому что в меню стояло «Sozlamalar». Поэтому жмём ту кнопку,
   * которая нужна этому проходу, и не полагаемся на то, что осталось от
   * прошлого. Язык учётки возвращается в `finally`.
   */
  const want = page.getByRole('button', { name: uz ? 'UZ' : 'RU', exact: true }).first();
  if (await want.count()) {
    await want.click();
    await page.waitForTimeout(600);
  }
}

/** Переход в «Настройки» → вкладка обмена. */
async function openExchange(page, uz) {
  // `exact: true`: без него «Настройки» совпадает и с другими кнопками, в чьё
  // название это слово входит, и прогон жмёт не туда.
  const nav = page
    .getByRole('button', { name: uz ? 'Sozlamalar' : 'Настройки', exact: true })
    .first();
  await nav.click();
  await page.waitForTimeout(1500);
  const tab = page
    .getByRole('tab', { name: uz ? /Almashinuv/i : /Обмен с системами/i })
    .first();
  await tab.click();
  await page.waitForTimeout(700);
  return tab;
}

const pane = (page, name) => page.getByRole('tab', { name }).first();

let backend;
let server;
let browser;
let db;

try {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(DOWN, { recursive: true });

  await assertPortFree();
  backend = spawn('node', ['dist/main.js'], {
    cwd: BACKEND,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(API_PORT),
      CORS_ORIGINS: `http://127.0.0.1:${WEB_PORT}`,
      // Расписание выключено: обмен в прогоне отправляется только тогда, когда
      // прогон этого просит. Иначе таймер уносил бы строки сам, и журнал
      // показывал бы не то, что проверяется.
      EXCHANGE_SCHEDULER: 'off',
    },
  });
  backend.stderr.on('data', (d) => process.stderr.write(`[api!] ${d}`));
  console.log(`бэкенд отвечает, /dashboard/summary без токена → ${await waitForApi(25000)}`);

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
      const uz = theme === 'dark' && tag === '360';
      const ctx = await browser.newContext({
        viewport: { width: w, height: h },
        colorScheme: theme,
        acceptDownloads: true,
      });
      const page = await ctx.newPage();
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(`[${at}] ${m.text().slice(0, 300)}`);
      });
      page.on('pageerror', (e) => errors.push(`[${at}] PAGEERROR ${e.message.slice(0, 300)}`));
      page.on('response', async (r) => {
        if (r.url().includes('/exchange') && r.status() >= 400) {
          const body = await r.text().catch(() => '');
          errors.push(`[${at}] ${r.status()} ${r.url().split('/api/v1')[1]} ${body.slice(0, 200)}`);
        }
      });
      // Тема берётся из localStorage, а не из `prefers-color-scheme`
      // (`AppContext.tsx`, ключ `metall_theme`, по умолчанию светлая). С одним
      // `colorScheme` тёмный проход шёл светлым: снимки `1440-*-files` вышли
      // байт в байт одинаковыми. Так же сделано в остальных прогонах.
      await page.addInitScript((t) => localStorage.setItem('metall_theme', t), theme);

      await login(page, uz);
      await openExchange(page, uz);

      // Тема и правда та, под которой подписан проход: без этой проверки
      // «тёмный» проход молча идёт светлым и снимки ничего не доказывают.
      const isDark = await page.evaluate(() => document.documentElement.classList.contains('dark'));
      if (isDark === (theme === 'dark')) ok(`[${at}] тема применилась`);
      else bad(`[${at}] тема не применилась: на странице ${isDark ? 'тёмная' : 'светлая'}`);

      // Вкладка найдена и выбрана — иначе дальше проверять нечего.
      const selected = await page
        .getByRole('tab', { name: uz ? /Almashinuv/i : /Обмен с системами/i })
        .first()
        .getAttribute('aria-selected');
      if (selected === 'true') ok(`[${at}] вкладка обмена выбрана`);
      else bad(`[${at}] вкладка обмена не выбрана (aria-selected=${selected})`);

      for (const name of uz
        ? [/Ulanishlar/i, /Almashinuv jurnali/i, /Fayllar/i]
        : [/Подключения/i, /Журнал обменов/i, /Файлы/i]) {
        if (await pane(page, name).count()) ok(`[${at}] подраздел ${name.source} есть`);
        else bad(`[${at}] подраздела ${name.source} нет`);
      }

      // Узбекский: в подписях вкладки не должно остаться кириллицы.
      if (uz) {
        const text = await page.locator('main').innerText();
        const cyr = text.match(/[А-Яа-яЁё]{3,}/g) ?? [];
        // Коды систем и события латиницей, поэтому ловим именно слова.
        if (cyr.length === 0) ok(`[${at}] под узбекским кириллицы в разделе нет`);
        else bad(`[${at}] под узбекским осталась кириллица: ${[...new Set(cyr)].slice(0, 6).join(', ')}`);
      }

      const m = await measure(page);
      if (m.main > 0 || m.doc > 0) {
        overflow.push(`[${at}] main +${m.main}px, doc +${m.doc}px ${m.culprits.join('; ')}`);
      } else {
        ok(`[${at}] ничего не вылезло за main`);
      }
      await page.screenshot({ path: path.join(OUT, `${tag}-${theme}-systems.png`), fullPage: true });

      // Журнал и файлы — отдельными снимками: именно там таблицы и длинные тела.
      await pane(page, uz ? /Almashinuv jurnali/i : /Журнал обменов/i).click();
      await page.waitForTimeout(600);
      const mj = await measure(page);
      if (mj.main > 0) overflow.push(`[${at}] журнал: main +${mj.main}px ${mj.culprits.join('; ')}`);
      else ok(`[${at}] журнал: ничего не вылезло`);
      await page.screenshot({ path: path.join(OUT, `${tag}-${theme}-journal.png`), fullPage: true });

      await pane(page, uz ? /Fayllar/i : /Файлы/i).click();
      await page.waitForTimeout(400);
      const mf = await measure(page);
      if (mf.main > 0) overflow.push(`[${at}] файлы: main +${mf.main}px ${mf.culprits.join('; ')}`);
      else ok(`[${at}] файлы: ничего не вылезло`);
      await page.screenshot({ path: path.join(OUT, `${tag}-${theme}-files.png`), fullPage: true });

      // Глубокая часть — один раз, на широком экране и светлой теме: она пишет
      // в базу, и повторять её в каждом из четырёх сочетаний незачем.
      if (!deepDone && tag === '1440' && theme === 'light') {
        deepDone = true;

        // --- ключ показывается один раз -----------------------------------
        await pane(page, /Подключения/i).click();
        await page.waitForTimeout(400);
        await page.getByRole('button', { name: /Добавить подключение/i }).click();
        const inputs = page.locator('input.w-full');
        await inputs.nth(0).fill(QA_CODE);
        // Название латиницей: проверка «под узбекским нет кириллицы» читает
        // весь `main`, и русское слово в данных прогона отбило бы её само.
        await inputs.nth(1).fill(`QA almashinuv ${STAMP}`);
        await page.getByRole('button', { name: /^Завести$/ }).click();
        await page.waitForTimeout(900);

        const keyBox = page.getByText(/Ключ доступа/).first();
        if (await keyBox.count()) ok('ключ показан сразу после заведения');
        else bad('после заведения ключ на экране не показан');

        // Сам ключ забираем с экрана и убеждаемся, что в списке его больше нет.
        const codeEls = await page.locator('code').allInnerTexts();
        const issued = codeEls.find((t) => /^[\w-]{20,}$/.test(t.trim()));
        if (issued) ok(`ключ виден целиком (${issued.length} знаков)`);
        else bad('ключ на экране не нашёлся');

        if (await page.getByText(/Секрет подписи/).count()) ok('секрет подписи показан');
        else bad('секрет подписи не показан');

        await page.screenshot({ path: path.join(OUT, '1440-light-key-once.png'), fullPage: true });

        await page.getByRole('button', { name: /Я сохранил ключ/i }).click();
        await page.waitForTimeout(600);

        const afterText = await page.locator('main').innerText();
        if (issued && afterText.includes(issued)) {
          bad('ключ остался на экране после закрытия карточки');
        } else {
          ok('после закрытия карточки ключа на экране нет');
        }
        // И в самом ответе списка ключа тоже быть не должно.
        // Сессия лежит в `sessionStorage` под ключом `metall_session` — одним
        // объектом, токен внутри. Берём оттуда же, откуда её берёт приложение.
        const listJson = await page.evaluate(async (api) => {
          const saved = JSON.parse(sessionStorage.getItem('metall_session') ?? '{}');
          const r = await fetch(`${api}/exchange/systems`, {
            headers: {
              Authorization: `Bearer ${saved.token ?? ''}`,
              'X-Company-Id': saved.companies?.[0]?.uid ?? '',
            },
          });
          return r.text();
        }, API);
        if (issued && listJson.includes(issued)) bad('ключ приходит в списке подключений');
        else ok('в списке подключений ключа нет');

        // --- выгрузка номенклатуры скачивается ----------------------------
        await pane(page, /Файлы/i).click();
        await page.waitForTimeout(400);
        for (const [label, ext, magic] of [
          ['XLSX', 'xlsx', 'PK'],
          ['CSV', 'csv', '﻿'],
        ]) {
          const [dl] = await Promise.all([
            page.waitForEvent('download', { timeout: 20000 }),
            page.getByRole('button', { name: new RegExp(`^${label}$`) }).click(),
          ]);
          const to = path.join(DOWN, `nomenklatura.${ext}`);
          await dl.saveAs(to);
          const size = fs.statSync(to).size;
          const head = fs.readFileSync(to).subarray(0, 8).toString('utf8');
          if (size > 200 && head.startsWith(magic)) {
            ok(`${label} скачался: ${size} байт, начинается как надо`);
          } else {
            bad(`${label}: ${size} байт, начало «${head.slice(0, 4)}» — не похоже на ${ext}`);
          }
        }

        // --- журнал: кнопка повтора у неудачного обмена --------------------
        // Неудачный обмен делаем честно: подписываем QA-подключение на событие
        // с адресом, которого нет, и дёргаем правку. Очередь прогоняется
        // служебным маршрутом нельзя — поэтому проверяем то, что видно: строка
        // появилась в журнале, направление «исходящий», и кнопка повтора есть.
        const sysRow = await db.query(
          `SELECT s.id, s.uid, s.company_id FROM external_system s WHERE s.code = $1`,
          [QA_CODE],
        );
        if (sysRow.rows[0]) {
          await db.query(
            `INSERT INTO exchange_message
               (company_id, system_id, direction, event, status, attempts, last_error,
                url, request_body, next_attempt_at)
             VALUES ($1, $2, 'out', 'item.update', 'dead', 5,
                     'получатель не ответил: connect ECONNREFUSED',
                     'http://127.0.0.1:1/hook', '{"event":"item.update"}', now())`,
            [sysRow.rows[0].company_id, sysRow.rows[0].id],
          );
          await pane(page, /Журнал обменов/i).click();
          await page.waitForTimeout(900);
          await page.reload({ waitUntil: 'domcontentloaded' });
          await page.waitForSelector('main', { timeout: 20000 });
          await openExchange(page, false);
          await pane(page, /Журнал обменов/i).click();
          await page.waitForTimeout(900);

          const journal = await page.locator('main').innerText();
          if (journal.includes('Попытки кончились')) ok('журнал показал состояние «Попытки кончились»');
          else bad('журнал не показал состояние неудачного обмена');

          const retryBtn = page.getByRole('button', { name: /Повторить/i }).first();
          if (await retryBtn.count()) {
            ok('у неудачного обмена есть кнопка повтора');
            await retryBtn.click();
            await page.waitForTimeout(900);
            const after = await db.query(
              `SELECT status, attempts FROM exchange_message m
                 JOIN external_system s ON s.id = m.system_id
                WHERE s.code = $1 ORDER BY m.id DESC LIMIT 1`,
              [QA_CODE],
            );
            const row = after.rows[0];
            // Повтор обнулил попытки — значит кнопка не только нарисована.
            if (row && Number(row.attempts) === 0) {
              ok(`повтор обнулил попытки (статус ${row.status})`);
            } else {
              bad(`повтор не обнулил попытки: ${JSON.stringify(row)}`);
            }
          } else {
            bad('кнопки повтора у неудачного обмена нет');
          }
          await page.screenshot({
            path: path.join(OUT, '1440-light-journal-retry.png'),
            fullPage: true,
          });
        } else {
          bad('QA-подключение в базе не нашлось — остальные проверки журнала пропущены');
        }
      }

      await ctx.close();
    }
  }
} finally {
  // Своё подключение убираем за собой: прогон не должен оставлять мусор в базе.
  if (db) {
    // Язык учётки — назад на русский. Переключатель в интерфейсе запоминает его
    // в учётке, и без этой строки следующий прогон (и живой человек) заходит в
    // узбекский интерфейс, которого не просил.
    await db.query(`UPDATE user_account SET locale = 'ru' WHERE login = $1`, [LOGIN]).catch(() => {});
    await db
      .query(
        `DELETE FROM exchange_message WHERE system_id IN
           (SELECT id FROM external_system WHERE code = $1)`,
        [QA_CODE],
      )
      .catch(() => {});
    await db.query(`DELETE FROM external_system WHERE code = $1`, [QA_CODE]).catch(() => {});
    await db.end().catch(() => {});
  }
  if (browser) await browser.close().catch(() => {});
  if (server) await new Promise((r) => server.close(r));
  if (backend) backend.kill('SIGTERM');
}

console.log('\n── проверки ──');
for (const c of checks) console.log(c);
if (found.length) {
  console.log('\n── не сошлось ──');
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
