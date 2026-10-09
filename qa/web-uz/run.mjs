/**
 * Приёмка узбекского в веб-экранах (ТЗ 13.4).
 *
 * Берёт не исходники, а то, что видит человек: открывает каждый модуль и
 * каждую вкладку под узбекским языком и собирает надписи интерфейса —
 * заголовки, подписи полей, шапки таблиц, кнопки, подсказки и всё, что живёт
 * в title/aria-label/placeholder. Любая кириллица в них — непереведённое
 * место.
 *
 * Данные заказчика русские и такими останутся: названия номенклатуры,
 * контрагентов, складов, участков и имена людей заведены в базе по-русски.
 * Поэтому словарь данных читается прямо из базы, и надпись, совпавшая с
 * записью, в находки не идёт. Это та же граница, что в боте (`qa/bot-uz.mjs`):
 * переводим интерфейс, данные не выдумываем.
 *
 * Перед запуском собрать фронт с живым API:
 *   cd dev/frontend && npm run build:qa
 *
 * Запуск:
 *   cd dev/qa && node web-uz/run.mjs
 */
import { spawn } from 'node:child_process';
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { Client } from 'pg';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '../../frontend/dist-qa');
const BACKEND = path.resolve(HERE, '../../backend');
const OUT = path.resolve(HERE, 'shots');
/**
 * Порт 4400 задан в сборке `build:qa` (VITE_API_URL), менять его здесь нельзя:
 * фронт из dist-qa стучится именно туда, и на другом порту прогон молча
 * не войдёт. На 4000 живёт внешний стенд — туда попадать нельзя.
 */
const API_PORT = Number(process.env.QA_API_PORT ?? 4400);
const WEB_PORT = Number(process.env.QA_WEB_PORT ?? 4324);
const API = `http://127.0.0.1:${API_PORT}/api/v1`;
/** Админ видит все модули, включая «Настройки» — иначе часть экранов не открыть. */
const LOGIN = process.env.QA_LOGIN ?? 'admin';
const PASSWORD = process.env.SEED_PASSWORD ?? 'metall-dev-2026';

const MODULES = [
  'dashboard',
  'sales',
  'warehouse',
  'production',
  'finance',
  'documents',
  'crm',
  'admin',
];

const CYR = /[А-Яа-яЁё]/;

/**
 * Слова, которые по-узбекски пишутся кириллицей или вообще не переводятся:
 * «сўм» — узбекская кириллица в латинском экране не нужна, а вот «т», «м³»
 * и ГОСТ остаются как есть. Список держим коротким и явным.
 */
const KEEP = [/^ГОСТ/, /^ТУ\b/, /^т$/, /^кг$/, /^м$/, /^м2$/, /^м3$/, /^п\.м\.$/, /^шт$/];

fs.mkdirSync(OUT, { recursive: true });

const found = [];
const notes = [];
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
    const res = await fetch(`${API}/dashboard/summary`).catch(() => null);
    if (res) return res.status;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('бэкенд не поднялся');
}

/**
 * Что на экране можно считать данными, а что переводом.
 *
 * Справочники в базе двуязычны: у номенклатуры, контрагентов, складов,
 * участков, причин и статей есть `name_ru` и `name_uz`. Поэтому:
 *   — русское название, у которого в базе есть узбекское, — находка:
 *     экран показывает не то поле;
 *   — русское название без узбекского (его завёл человек руками) — данные,
 *     переводить за заказчика их нельзя;
 *   — имена людей — данные всегда.
 */
function dbUrl() {
  return fs
    .readFileSync(path.join(BACKEND, '.env'), 'utf8')
    .split('\n')
    .find((l) => l.startsWith('DATABASE_URL='))
    .slice('DATABASE_URL='.length)
    .replace(/^"|"$/g, '');
}

/**
 * Язык — настройка человека, и прогон её меняет.
 *
 * Пока язык жил только в браузере, прогон никого не трогал. Теперь выбор
 * уходит в `user_account.locale`, и учётка остаётся узбекской после прогона —
 * следующий прогон видит узбекский экран и падает на русской надписи. Поэтому
 * язык возвращаем сами, даже если прогон оборвался.
 */
async function localeOf(login) {
  const db = new Client({ connectionString: dbUrl() });
  await db.connect();
  const r = await db.query('select locale from user_account where login = $1', [login]);
  await db.end();
  return r.rows[0]?.locale ?? 'ru';
}

async function setLocale(login, locale) {
  const db = new Client({ connectionString: dbUrl() });
  await db.connect();
  await db.query('update user_account set locale = $1 where login = $2', [locale, login]);
  await db.end();
}

async function dataVocabulary() {
  const url = dbUrl();
  const db = new Client({ connectionString: url });
  await db.connect();
  const tables = await db.query(
    `select table_name from information_schema.columns
      where column_name = 'name_uz' and table_schema = 'public'`,
  );
  /** Русское название → узбекское, когда узбекское настоящее. */
  const translated = new Map();
  /** Русские названия, у которых узбекского нет: это данные. */
  const data = new Set();
  for (const { table_name: table } of tables.rows) {
    const res = await db.query(`select name_ru, name_uz from "${table}"`).catch((e) => {
      notes.push(`словарь данных: ${table} не прочитан — ${e.message}`);
      return null;
    });
    if (!res) continue;
    for (const row of res.rows) {
      const ru = String(row.name_ru ?? '').trim();
      const uz = String(row.name_uz ?? '').trim();
      if (!ru) continue;
      if (!uz || uz === ru || /[А-Яа-яЁё]/.test(uz)) data.add(ru);
      else translated.set(ru, uz);
    }
  }
  // Имена людей, ячейки, марки стали и типы изоляции — данные без вариантов:
  // «Ст3сп5» и «А500С» это обозначение по ГОСТ, а не слово для перевода.
  //
  // Эти значения собираются отдельным набором, а не только в `data`, потому
  // что с ними в `review()` обращаемся иначе: вычёркиваем раньше номеров
  // документов и без порога длины. Иначе марка «09Г2С-15» теряет хвост под
  // регуляркой номеров и остаётся огрызком «09Г2», а трёхзначная «н/у»
  // короче порога и в вычёркивание не попадает вовсе — и обе выглядят
  // непереведённой надписью, которой нет.
  const marks = new Set();
  for (const q of [
    'select full_name as v from user_account',
    'select code as v from storage_location',
    'select distinct steel_grade as v from item_attribute',
    'select distinct pipe_type as v from item_attribute',
    'select distinct insulation_type as v from item_attribute',
    'select distinct gost as v from item_attribute',
  ]) {
    const res = await db.query(q).catch(() => null);
    for (const row of res?.rows ?? []) {
      const v = String(row.v ?? '').trim();
      if (v) {
        data.add(v);
        if (v.length >= 2) marks.add(v);
      }
    }
  }
  await db.end();
  // Длинные вперёд: иначе «Склад» вычеркнет часть «Склад «Сергели»» и остаток
  // станет неузнаваемым.
  const dataSorted = [...data].sort((a, b) => b.length - a.length);
  const marksSorted = [...marks].sort((a, b) => b.length - a.length);
  const translatedSorted = [...translated.entries()].sort((a, b) => b[0].length - a[0].length);
  return { data, translated, dataSorted, marksSorted, translatedSorted };
}

/**
 * Разбор одной надписи.
 *
 * Сначала вычёркиваем данные заказчика: номера документов и партий, имена,
 * марки стали, названия без узбекского варианта. Потом смотрим, не осталось
 * ли в строке русского названия, у которого узбекское в базе есть — это
 * находка «показано не то поле». Что осталось с кириллицей после вычёркивания
 * — непереведённая надпись интерфейса.
 */
function review(text, vocab) {
  let rest = text;
  // Обозначения (марки стали, виды проката, ГОСТ, ячейки, имена) — первыми:
  // марка «09Г2С-15» сама похожа на номер документа, и регулярка ниже съела
  // бы её хвост.
  for (const w of vocab.marksSorted) {
    if (rest.includes(w)) rest = rest.split(w).join(' ');
  }
  // Номера документов и партий: ПР-00031, ТД-00372, ЗЯВ-000131, П-00150,
  // а также составные вида ТТН-ТД-00435 — номер накладной с номером заказа.
  rest = rest.replace(/(?:[А-ЯЁ]{1,4}-)+\d{2,}/g, ' ');
  for (const w of vocab.dataSorted) {
    if (w.length >= 4 && rest.includes(w)) rest = rest.split(w).join(' ');
  }
  for (const [ru, uz] of vocab.translatedSorted) {
    if (rest.includes(ru)) return { why: `в базе есть узбекское: «${uz.slice(0, 60)}»`, text: ru };
  }
  if (!CYR.test(rest)) return null;
  return { why: 'надпись интерфейса', text: rest.replace(/\s+/g, ' ').trim() };
}

/** Надписи интерфейса с открытого экрана. */
async function chrome(page) {
  return page.evaluate(() => {
    const out = [];
    const add = (where, text) => {
      const t = String(text ?? '')
        .replace(/\s+/g, ' ')
        .trim();
      if (t) out.push({ where, text: t });
    };
    const each = (sel, fn) => document.querySelectorAll(sel).forEach(fn);
    each('h1,h2,h3,h4', (el) => add('заголовок', el.innerText));
    each('th', (el) => add('шапка таблицы', el.innerText));
    each('label', (el) => add('подпись поля', el.innerText));
    each('[role="tab"],button[aria-pressed]', (el) => add('вкладка', el.innerText));
    each('input[placeholder],textarea[placeholder]', (el) => add('подсказка в поле', el.placeholder));
    each('[aria-label]', (el) => add('aria-label', el.getAttribute('aria-label')));
    each('[title]', (el) => add('title', el.getAttribute('title')));
    each('option', (el) => add('пункт списка', el.textContent));
    // Клетки таблиц: в них и данные, и переведённые слова вроде статуса.
    // Данные отсеиваются словарём, а не выбором места.
    each('td', (el) => add('клетка таблицы', el.innerText));
    // Кнопки действий: короткие и без вложенной разметки. Строки списков
    // тоже кнопки, но в них несколько полей сразу — их пропускаем.
    each('button', (el) => {
      const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
      if (t && t.length <= 36 && el.querySelectorAll('*').length <= 3) add('кнопка', t);
    });
    return out;
  });
}

/**
 * Надписи из окна или выпадающей панели поверх страницы.
 *
 * Обычный сбор берёт заголовки, кнопки и поля — а месяц и дни недели в
 * календаре лежат в обычных `div` и `span`, и так их не видно. Внутри
 * всплывающего слоя данных заказчика почти нет, поэтому здесь можно брать
 * любой короткий текст у листового элемента.
 */
async function overlayChrome(page) {
  return page.evaluate(() => {
    const out = [];
    const panels = [...document.querySelectorAll('*')].filter((el) => {
      const cls = typeof el.className === 'string' ? el.className : '';
      const over = el.getAttribute('role') === 'dialog' || cls.includes('z-[70]') || cls.includes('z-50');
      if (!over) return false;
      const r = el.getBoundingClientRect();
      return r.width > 80 && r.height > 60;
    });
    for (const panel of panels) {
      for (const el of panel.querySelectorAll('*')) {
        if (el.children.length) continue;
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (t && t.length <= 60) out.push({ where: 'окно', text: t });
      }
    }
    return out;
  });
}

function collect(screen, items, vocab) {
  for (const it of items) {
    if (!CYR.test(it.text)) continue;
    if (KEEP.some((re) => re.test(it.text))) continue;
    const verdict = review(it.text, vocab);
    if (!verdict) continue;
    found.push({
      screen,
      where: it.where,
      text: verdict.text.slice(0, 120),
      why: verdict.why,
      // Целая надпись: по остатку после вычёркивания данных не всегда видно,
      // где её искать в коде.
      whole: it.text.slice(0, 160),
    });
  }
}

let localeWas = null;

try {
  localeWas = await localeOf(LOGIN);
  await assertPortFree(API_PORT);
  await assertPortFree(WEB_PORT);
  if (!fs.existsSync(ROOT)) throw new Error(`нет сборки ${ROOT}: сначала npm run build:qa`);

  const vocab = await dataVocabulary();
  console.log(
    `справочники: ${vocab.translated.size} названий с узбекским, ` +
      `${vocab.data.size} без него (это данные)`,
  );

  backend = spawn('node', ['dist/main.js'], {
    cwd: BACKEND,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(API_PORT), CORS_ORIGINS: `http://127.0.0.1:${WEB_PORT}` },
  });
  backend.stderr.on('data', (d) => process.stderr.write(`[api!] ${d}`));
  const status = await waitForApi(25000);
  console.log(`бэкенд отвечает (${status})`);

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
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message.slice(0, 200)}`));

  await page.goto(`http://127.0.0.1:${WEB_PORT}/`, { waitUntil: 'networkidle' });
  await page.locator('input[autocomplete="username"]').first().fill(LOGIN);
  await page.locator('input[autocomplete="current-password"]').first().fill(PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  await page.waitForSelector('aside', { timeout: 20000 });
  await page.waitForTimeout(1200);

  // Экран входа — тоже экран: смотрим его отдельным проходом ниже, а сейчас
  // переключаем язык и идём по модулям.
  await page.getByRole('button', { name: 'UZ', exact: true }).click();
  await page.waitForTimeout(600);

  for (const mod of MODULES) {
    const btn = page.locator(`[data-module="${mod}"]`).first();
    if ((await btn.count()) === 0) {
      notes.push(`модуль ${mod}: кнопки нет — у ${LOGIN} нет доступа`);
      continue;
    }
    await btn.click();
    await page.waitForTimeout(1400);
    collect(mod, await chrome(page), vocab);

    const tabs = page.locator('[role="tab"], button[aria-pressed]');
    const count = await tabs.count();
    for (let i = 0; i < count; i += 1) {
      const tab = page.locator('[role="tab"], button[aria-pressed]').nth(i);
      if ((await tab.count()) === 0) break;
      const name = (await tab.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      await tab.click({ timeout: 5000 }).catch(() => null);
      await page.waitForTimeout(900);
      collect(`${mod} → ${name || i}`, await chrome(page), vocab);
    }
    // Карточка: половина надписей живёт в правой панели, а она открывается
    // только по строке списка. Без этого прогон зелёный на пустом месте.
    const row = page.locator('div[class*="divide-y"] > button').first();
    if (await row.count()) {
      await row.click({ timeout: 5000 }).catch(() => null);
      await page.waitForTimeout(1200);
      collect(`${mod} → карточка`, await chrome(page), vocab);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }

    console.log(`${mod}: вкладок ${count}`);
  }

  // Поверх экранов живут окна и выпадающие панели: обход по модулям их не
  // открывает, и русский в них прогон не видел. Открываем то, что человек
  // достаёт с любого экрана: поиск по разделам (Ctrl+K) и календарь.
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(600);
  const searchOpen = await page.locator('input[type="text"], input:not([type])').first().count();
  if (!searchOpen) notes.push('поиск по Ctrl+K не открылся');
  collect('поиск (Ctrl+K)', await chrome(page), vocab);
  collect('поиск (Ctrl+K)', await overlayChrome(page), vocab);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // Календарь — отдельный компонент с месяцами и днями недели, и его видно
  // только раскрытым. Иконка из lucide даёт класс `lucide-calendar`.
  let calendarSeen = false;
  for (const mod of ['documents', 'warehouse', 'sales']) {
    const btn = page.locator(`[data-module="${mod}"]`).first();
    if ((await btn.count()) === 0) continue;
    await btn.click();
    await page.waitForTimeout(1200);
    const cal = page.locator('button:has(svg.lucide-calendar)').first();
    if ((await cal.count()) === 0) continue;
    await cal.click({ timeout: 5000 }).catch(() => null);
    await page.waitForTimeout(600);
    collect(`${mod} → календарь`, await chrome(page), vocab);
    collect(`${mod} → календарь`, await overlayChrome(page), vocab);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    calendarSeen = true;
    break;
  }
  if (!calendarSeen) notes.push('календарь не открылся ни на одном экране');

  await page.screenshot({ path: path.join(OUT, 'uz-last.png') });

  // Экран входа под узбекским: выходим и смотрим его.
  await page.evaluate(() => localStorage.setItem('metall_locale', 'uz'));
  await page.goto(`http://127.0.0.1:${WEB_PORT}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  const uzOnLogin = await page.getByRole('button', { name: 'UZ', exact: true }).count();
  if (uzOnLogin) {
    await page.getByRole('button', { name: 'UZ', exact: true }).click();
    await page.waitForTimeout(400);
  }
  collect('вход', await chrome(page), vocab);
} finally {
  if (browser) await browser.close().catch(() => null);
  if (server) await new Promise((r) => server.close(r));
  if (backend) backend.kill('SIGTERM');
  if (localeWas !== null) {
    await setLocale(LOGIN, localeWas).catch((e) => console.error(`язык не возвращён: ${e.message}`));
    console.log(`язык ${LOGIN} возвращён: ${localeWas}`);
  }
}

const uniq = new Map();
for (const f of found) {
  const key = `${f.where}|${f.text}`;
  if (!uniq.has(key)) uniq.set(key, { ...f, screens: new Set([f.screen]) });
  else uniq.get(key).screens.add(f.screen);
}
const rows = [...uniq.values()].sort((a, b) => a.text.localeCompare(b.text, 'ru'));

console.log(`\n=== русский в интерфейсе под узбекским: ${rows.length}`);
for (const r of rows) {
  console.log(`  [${r.where}] ${r.text}   — ${r.why}; ${[...r.screens].slice(0, 3).join(', ')}`);
  if (r.whole && r.whole !== r.text) console.log(`      вся надпись: ${r.whole}`);
}
for (const n of notes) console.log(`замечание: ${n}`);
for (const e of errors) console.log(`ошибка страницы: ${e}`);

if (rows.length) {
  console.log('\nПРОГОН КРАСНЫЙ: интерфейс под узбекским говорит по-русски.');
  process.exit(1);
}
console.log('\nПРОГОН ЗЕЛЁНЫЙ: русского в надписях интерфейса нет.');
