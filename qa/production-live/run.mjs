/**
 * Прогон страницы «Производство» против живого бэкенда.
 *
 * Проверяет то, что по скриншоту не увидишь:
 *   1) на экране нет придуманных причин простоя и номеров из макета;
 *   2) данные пришли — список наполнен, панель заказа открывается, в журнале
 *      этапа есть события;
 *   3) заказ правда заводится: форма открывается, продукция в ней с сервера,
 *      а кнопки перехода соответствуют состоянию заказа — у работающего есть
 *      отмена, у закрытого действий нет вовсе;
 *   4) техкарты: список открывается, у действующей карты нет правки на месте,
 *      а редактор черновика умеет этапы и материалы;
 *   5) содержимое не вылезает за контейнер на 360 и 1440 в обеих темах.
 *
 * Всё в одном переднем процессе: фоновые запуски запрещены, бэкенд поднимается
 * дочерним процессом и глушится в finally.
 *
 * Перед запуском собрать фронт с живым API:
 *   cd dev/frontend && bun run build:qa   # сборка для прогона, каталог dist-qa
 *
 * Запуск:
 *   cd dev/qa && bun run production-live
 */
import { spawn } from 'node:child_process';
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { chromium } from 'playwright-core';
import { Client } from 'pg';

/** Настоящий PNG в один пиксель: служба вложений проверяет тип по байтам. */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

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
const LOGIN = 'j.tashpulatov';
const PASSWORD = process.env.SEED_PASSWORD ?? 'metall-dev-2026';

/**
 * Выдумки из импортированного макета. Причины простоя были вбиты в вёрстку и
 * не существовали ни в одной таблице; номер ПЗ-000104 — оттуда же. Любая из
 * этих строк на экране означает, что кусок макета вернулся.
 */
const FICTION = [
  'Ожидание разогрева заливочной головки',
  'Внеплановое ТО дробеметного барабана',
  'Отсутствие ПЭ оболочки нужного диаметра',
  'Пересменка операторов',
  'ПЗ-000104',
  // Подписи из макета. «Запустить», «Приостановить» и «Зафиксировать простой»
  // из списка ушли: с Э1 и Э7 это настоящие действия, а не слова на кнопке.
  'Снимок себестоимости заказа',
];

/** Вкладки правой панели: у каждой своё содержимое, и каждую надо открыть. */
const PANEL_TABS = [
  { key: 'stages', label: 'Этапы' },
  { key: 'materials', label: 'Материалы' },
  { key: 'cost', label: 'Себестоимость' },
];

fs.mkdirSync(OUT, { recursive: true });

const errors = [];
const overflow = [];
const found = [];
const notes = [];
let backend;
let server;
let browser;
/** Черновик техкарты, заведённый прогоном ради снимка редактора. */
let draftCardUid = null;
/** Заказы, заведённые прогоном ради проверки этапов: удаляются в конце. */
let stageOrderUids = [];
let apiToken = null;

async function waitForApi(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // 401 тоже годится: значит процесс слушает и маршруты подняты.
      const r = await fetch(`${API}/production/summary?period=7d`);
      if (r.status > 0) return r.status;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error('бэкенд не поднялся за отведённое время');
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
          `${el.tagName.toLowerCase()}.${String(el.className).split(' ').slice(0, 3).join('.')} +${Math.round(r.right - right)}px`,
        );
        if (culprits.length >= 3) break;
      }
    }
    return { doc: de.scrollWidth - de.clientWidth, main: over, culprits };
  });
}

/**
 * Какие заказы брать для проверки переходов.
 *
 * Спрашиваем у API, а не ищем глазами в фильтре: состав посева меняется, и
 * прогон, который «нажал третью строку», однажды проверит не то, что хотел.
 * Номер потом набирается в поиске — так открывается именно нужный заказ.
 */
/**
 * Черновик техкарты под снимок редактора.
 *
 * Редактор живёт только у черновика, а в базе разработки черновиков нет —
 * проверки за собой убирают. Заводим свой и удаляем в конце: прогон экрана не
 * должен оставлять следов в демо-данных.
 */
async function makeDraftCard() {
  const token = await apiLogin();
  const opts = await fetch(`${API}/production/options`, {
    headers: { Authorization: `Bearer ${token}` },
  }).then((r) => r.json());
  const item = opts.data?.items?.[0];
  if (!item) return null;

  // Хвост от прошлого прогона мог остаться — убираем его, иначе служба
  // откажет: незаконченный черновик на номенклатуре может быть только один.
  const existing = await fetch(
    `${API}/production/tech-cards?status=draft&itemCode=${encodeURIComponent(item.code)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  ).then((r) => r.json());
  for (const c of existing.data?.rows ?? []) {
    await fetch(`${API}/production/tech-cards/${c.uid}/archive`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  const made = await fetch(`${API}/production/tech-cards`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      itemCode: item.code,
      nameRu: `Прогон экрана: ${item.nameRu}`,
      nameUz: `Ekran tekshiruvi: ${item.nameUz}`,
      stages: [
        { seq: 1, nameRu: 'Резка заготовки', nameUz: 'Zagotovkani kesish', normDurationMin: 45 },
        { seq: 2, nameRu: 'Сварка шва', nameUz: 'Chokni payvandlash', normDurationMin: 90 },
      ],
    }),
  }).then((r) => r.json());
  if (!made.data) {
    notes.push(`черновик карты не завёлся: ${JSON.stringify(made.error ?? made).slice(0, 160)}`);
    return null;
  }
  return { uid: made.data.uid, itemCode: item.code };
}

/**
 * Два заказа под проверку этапов (Э3).
 *
 * Первый доведён до работы с этапами из техкарты — на нём видны кнопки цеха.
 * Второй остановлен на «запланирован» без этапов: на нём экран обязан сказать,
 * что плана работ нет и как его завести. В посеве таких состояний нет — там
 * этапы у заказов уже проставлены, а пустых заказов в работе не бывает.
 */
async function makeStageOrders() {
  const token = await apiLogin();
  const head = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const opts = await fetch(`${API}/production/options`, { headers: head }).then((r) => r.json());
  const carded = opts.data?.items ?? [];
  const due = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);

  const create = async (itemCode, comment) => {
    const made = await fetch(`${API}/production/orders`, {
      method: 'POST',
      headers: head,
      body: JSON.stringify({ itemCode, qtyPlanned: '3', dueDate: due, comment }),
    }).then((r) => r.json());
    return made.data ?? null;
  };
  const call = (path, body) =>
    fetch(`${API}${path}`, {
      method: 'POST',
      headers: head,
      ...(body ? { body: JSON.stringify(body) } : {}),
    }).then((r) => r.json());

  let running = null;
  let empty = null;
  for (const item of carded) {
    const order = await create(item.code, 'Прогон экрана: этапы');
    if (!order) continue;
    stageOrderUids.push(order.uid);
    const planned = await call(`/production/orders/${order.uid}/stages/from-card`);
    if (!planned.data) continue; // у этой продукции нет действующей карты
    await call(`/production/orders/${order.uid}/status`, { status: 'planned' });
    const started = await call(`/production/orders/${order.uid}/status`, {
      status: 'in_progress',
    });
    if (started.data) running = order.number;
    break;
  }

  // Заказ с планом материалов и выданным материалом: на нём видно и «выдать»,
  // и «списать в работу». Материал возвращается в конце прогона.
  let withMaterials = null;
  if (running) {
    const uid = stageOrderUids[stageOrderUids.length - 1];
    const planned = await call(`/production/orders/${uid}/materials/from-card`);
    if (planned.data?.length) {
      // Кладовщик выдаёт первый материал плана — столько, сколько лежит.
      const keeper = await keeperLogin();
      const khead = { Authorization: `Bearer ${keeper}`, 'Content-Type': 'application/json' };
      const code = planned.data[0].itemCode;
      const where = await fetch(
        `${API}/production/orders/${uid}/materials/stock?itemCode=${encodeURIComponent(code)}`,
        { headers: khead },
      ).then((r) => r.json());
      const place = where.data?.rows?.[0];
      if (place) {
        const res = await fetch(`${API}/production/orders/${uid}/materials/issue`, {
          method: 'POST',
          headers: khead,
          body: JSON.stringify({
            itemCode: code,
            qty: '1',
            warehouseCode: place.warehouseCode,
            ...(place.locationCode ? { locationCode: place.locationCode } : {}),
            ...(place.batchNumber ? { batchNumber: place.batchNumber } : {}),
          }),
        }).then((r) => r.json());
        if (res.data) withMaterials = running;
        else notes.push(`материал не выдан: ${JSON.stringify(res.error ?? res).slice(0, 140)}`);
      }
    }
  }

  const bare = await create(carded[0]?.code, 'Прогон экрана: заказ без этапов');
  if (bare) {
    stageOrderUids.push(bare.uid);
    await call(`/production/orders/${bare.uid}/status`, { status: 'planned' });
    empty = bare.number;
  }

  return { running, empty, withMaterials };
}

/** Строка подключения владельца — из `.env` бэкенда: своего у прогона нет. */
function ownerUrl() {
  const env = fs.readFileSync(path.join(BACKEND, '.env'), 'utf8');
  const line = env.split('\n').find((l) => l.startsWith('DATABASE_URL='));
  return line.slice('DATABASE_URL='.length).replace(/^"|"$/g, '').trim();
}

/**
 * Вход кладовщиком: выдать материал в цех мастер не может, и это проверяемое
 * правило, а не неудобство. Прогону выдача нужна, чтобы на экране мастера
 * появилось «списать в работу».
 */
async function keeperLogin() {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: 'a.saidov', password: PASSWORD }),
  });
  return (await res.json()).data.token;
}

async function apiLogin() {
  if (apiToken) return apiToken;
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: LOGIN, password: PASSWORD }),
  });
  apiToken = (await res.json()).data.token;
  return apiToken;
}

/** Карточка заказа по номеру: проверки экрана сверяются с тем, что в базе. */
async function orderCard(number) {
  const token = await apiLogin();
  const head = { Authorization: `Bearer ${token}` };
  const list = await fetch(`${API}/production/orders?limit=200`, { headers: head });
  const row = ((await list.json()).data?.rows ?? []).find((o) => o.number === number);
  if (!row) return {};
  const one = await fetch(`${API}/production/orders/${row.uid}`, { headers: head });
  return (await one.json()).data ?? {};
}

/**
 * Файлы этапа в журнале отметок (ТЗ 4.1, 4.6).
 *
 * Снимок замера и брака прикладывают к той строке, о которой он: до этого
 * доказательство цеха ложилось на весь заказ, и к какой операции оно
 * относится, приходилось выяснивать по времени загрузки.
 *
 * Прогон идёт тем же путём, что и человек: открывает скрепку у этапа,
 * прикладывает настоящий PNG, убеждается, что строка появилась своим именем,
 * и убирает её за собой — база разработки не свалка снимков.
 */
async function runStageFiles(page, at, tag, theme) {
  // Скрепку этапа ищем по её подписи, а не по роли и имени: скрепка заказа
  // называется ровно так же и стоит на том же экране выше — `first()` по роли
  // открыл бы файлы заказа, и проверка прошла бы, ничего не проверив.
  const clips = page.locator('xpath=//span[text()="Файлы этапа"]/preceding-sibling::button[1]');
  const count = await clips.count();
  notes.push(`[${at}] скрепок у этапов: ${count}`);
  if (count === 0) {
    errors.push(`[${at}] у этапов в журнале нет подписанной скрепки «Файлы этапа»`);
    return;
  }

  await clips.first().click();
  const dialog = page.locator('[role="dialog"][aria-label="Вложения"]');
  try {
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
  } catch {
    errors.push(`[${at}] окно файлов этапа не открылось`);
    return;
  }
  await page.waitForTimeout(1200);

  // Заголовок окна пишем в заметки: он должен называть этап номером и
  // операцией, иначе непонятно, к чему прикладываешь, когда этапов пять.
  const head = (await dialog.innerText()).replace(/\s+/g, ' ').slice(0, 90);
  notes.push(`[${at}] окно файлов этапа: ${head}`);

  await page.screenshot({ path: `${OUT}/production-stage-files-${tag}-${theme}.png`, fullPage: true });
  overflow.push({ key: `${at}/stage-files`, isDefault: false, ...(await measure(page)) });

  const before = await dialog.locator('li').count();
  const file = path.join(os.tmpdir(), `qa-etap-${Date.now()}.png`);
  fs.writeFileSync(file, PNG_1PX);
  await dialog.locator('input[type="file"]').setInputFiles(file);
  await page.waitForTimeout(2500);

  const after = await dialog.locator('li').count();
  notes.push(`[${at}] файлов этапа было ${before}, стало ${after}`);
  if (after !== before + 1) {
    const why = (await dialog.innerText()).replace(/\s+/g, ' ').slice(0, 200);
    errors.push(`[${at}] файл к этапу не приложился: было ${before}, стало ${after}. Окно: ${why}`);
  } else {
    const mine = dialog.locator('li').filter({ hasText: path.basename(file) }).first();
    if ((await mine.count()) === 0) {
      errors.push(`[${at}] приложенный к этапу файл не назван своим именем`);
    } else {
      // Убираем сразу: следующий круг (тема, ширина) считает строки заново, и
      // оставленный снимок сдвинул бы ему «было».
      await mine.getByRole('button', { name: 'Удалить вложение' }).click();
      await page.waitForTimeout(2000);
      const left = await dialog.locator('li').count();
      if (left !== before) {
        errors.push(`[${at}] после удаления файлов этапа ${left}, а до загрузки было ${before}`);
      }
    }
  }

  fs.rmSync(file, { force: true });
  await dialog.getByRole('button', { name: 'Закрыть вложения' }).click();
  await page.waitForTimeout(400);
}

async function pickOrders() {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: LOGIN, password: PASSWORD }),
  });
  const token = (await res.json()).data.token;
  const get = async (state) => {
    const r = await fetch(`${API}/production/orders?state=${state}&limit=100`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return (await r.json()).data?.rows ?? [];
  };
  const active = await get('active');
  const done = await get('done');
  // Заказ с уже отработанными этапами — для проверки журнала отметок. Первая
  // строка списка для этого не годится: прогон сам заводит свежие заказы, и
  // они встают наверх, а событий у них ещё нет.
  const worked = [...active, ...done].find((o) => o.stagesDone > 0);
  return {
    active: active[0]?.number ?? null,
    paused: active.find((o) => o.status === 'paused')?.number ?? null,
    closed: done.find((o) => o.status === 'closed')?.number ?? null,
    worked: worked?.number ?? null,
  };
}

/**
 * Прогон поднимает собранный `dist`, а не исходники, и сам ничего не собирает.
 * Значит правка в `src` без сборки прогоном не проверяется: он зелёный, потому
 * что проверял прошлый код. На этом однажды уже вышел ложный зелёный —
 * вложения к этапу прикладывались в старый бэкенд и получали 400.
 *
 * Собираем сами, а не сверяем время файлов: сборка инкрементальная, и прогон
 * без изменений не перезаписывает ни `.js`, ни `.tsbuildinfo` — отметки, по
 * которой «собрано позже, чем правлено», просто нет. Сборка же при свежем
 * `dist` почти ничего не стоит, а при правленом `src` делает ровно то, чего
 * не хватало.
 */
async function buildBackend() {
  await new Promise((ok, fail) => {
    const p = spawn('npm', ['run', 'build'], { cwd: BACKEND, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) =>
      code === 0 ? ok() : fail(new Error(`бэкенд не собрался (${code}): ${err.slice(-400)}`)),
    );
  });
  console.log('бэкенд собран из исходников');
}

try {
  await assertPortFree();
  await buildBackend();
  backend = spawn('node', ['dist/main.js'], {
    cwd: BACKEND,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(API_PORT),
      CORS_ORIGINS: 'http://localhost:5173,http://127.0.0.1:4323',
    },
  });
  backend.stdout.on('data', (d) => process.stdout.write(`[api] ${d}`));
  backend.stderr.on('data', (d) => process.stderr.write(`[api!] ${d}`));

  const status = await waitForApi(20000);
  console.log(`бэкенд отвечает, /production/summary без токена → ${status}`);

  const picked = await pickOrders();
  const draft = await makeDraftCard();
  draftCardUid = draft?.uid ?? null;
  const stageCase = await makeStageOrders();
  console.log(
    `для этапов заведены: в работе ${stageCase.running ?? '—'}, без этапов ${stageCase.empty ?? '—'}`,
  );
  console.log(`черновик карты для снимка редактора: ${draft ? draft.itemCode : 'не завёлся'}`);
  console.log(
    `для переходов взяты: в работе ${picked.active ?? '—'}, закрыт ${picked.closed ?? '—'}, ` +
      `с отметками ${picked.worked ?? '—'}`,
  );

  const app = express();
  app.use(express.static(ROOT));
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(ROOT, 'index.html')));
  server = await new Promise((resolve) => {
    const s = app.listen(4323, '127.0.0.1', () => resolve(s));
  });

  browser = await chromium.launch({
    executablePath: '/home/an/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
    args: ['--no-sandbox'],
  });

  for (const [w, h, tag] of [[1440, 900, '1440'], [360, 780, '360']]) {
    for (const theme of ['light', 'dark']) {
      const at = `${tag}/${theme}`;
      const ctx = await browser.newContext({ viewport: { width: w, height: h } });
      const page = await ctx.newPage();
      // Падение внутри прогона — находка, а не авария скрипта: иначе первая же
      // поломка убивает процесс раньше, чем он скажет, что именно не так.
      try {
        page.on('console', (m) => {
          if (m.type() === 'error') errors.push(`[${at}] ${m.text().slice(0, 300)}`);
        });
        page.on('pageerror', (e) => errors.push(`[${at}] PAGEERROR ${e.message.slice(0, 300)}`));
        let optionsOk = false;
        page.on('response', (r) => {
          if (r.url().includes('/production/options') && r.status() === 200) optionsOk = true;
          if (r.url().includes('/production/') && r.status() >= 400) {
            errors.push(`[${at}] ${r.status()} ${new URL(r.url()).pathname}`);
          }
        });
        await page.addInitScript((t) => localStorage.setItem('metall_theme', t), theme);

        await page.goto('http://127.0.0.1:4323/', { waitUntil: 'networkidle' });
        await page.waitForTimeout(300);

        await page.locator('input[autocomplete="username"]').first().fill(LOGIN);
        await page.locator('input[autocomplete="current-password"]').first().fill(PASSWORD);
        await page.getByRole('button', { name: 'Войти' }).click();
        await page.waitForSelector('text=/Выручка|Tushum/', { state: 'attached', timeout: 15000 });

        await page.getByRole('button', { name: 'Производство', exact: true }).first().click();
        await page.waitForTimeout(1500);

        // Шапка сайдбара должна называть ту компанию, чьи данные на экране.
        // У мастера цеха в сессии только завод: если в шапке стоит торговый
        // дом, подпись противоречит списку заказов под ней.
        // Свёрнутый сайдбар рисует только значок, название живёт в title —
        // поэтому берём и текст, и подсказки.
        const company = await page
          .locator('aside')
          .first()
          .evaluate((el) => {
            const titles = [...el.querySelectorAll('[title]')].map((n) => n.getAttribute('title'));
            return [el.innerText, ...titles].join(' | ');
          })
          .catch(() => '');
        const shown = company.includes('Металл Азия')
          ? 'Trade'
          : company.includes('Ташкентский изоляционный завод')
            ? 'Plant'
            : company.includes('Обе')
              ? 'Group'
              : '(не найдена)';
        notes.push(`[${at}] компания в шапке: ${shown}`);
        if (shown !== 'Plant') {
          errors.push(`[${at}] в шапке «${shown}», а заказы показаны заводские`);
        }

        // Загрузка участков: если сводка не пришла, вместо минут будет пусто.
        const load = await page
          .locator('text=Загрузка участков')
          .first()
          .evaluate((el) => el.closest('div[class*="rounded-xl"]')?.textContent ?? '')
          .catch(() => '');
        notes.push(`[${at}] шапка: ${load.replace(/\s+/g, ' ').trim().slice(0, 90) || '(не найдена)'}`);
        if (!/\d/.test(load)) errors.push(`[${at}] загрузка участков не отрисовалась`);

        // Участки видны все и сразу. Карточка держала их в прокручиваемом
        // окне: при четырёх участках помещались два, остальные были за краем —
        // а загрузка цеха это как раз то, ради чего на экран и смотрят. Прятать
        // половину в скролл на обзорной карточке нельзя: человек не узнает, что
        // там что-то есть.
        //
        // Сверяемся со сводкой того же периода, что выбран на экране: иначе
        // проверка не заметит, если карточка начнёт показывать первые три из
        // четырёх.
        const activePeriod = await page
          .locator('[aria-pressed="true"]')
          .first()
          .innerText()
          .catch(() => '');
        const periodKey =
          { '7 дн': '7d', '30 дн': '30d', '3 мес': '3m' }[activePeriod.trim()] ?? '30d';
        const apiSummary = await fetch(`${API}/production/summary?period=${periodKey}`, {
          headers: { Authorization: `Bearer ${await apiLogin()}` },
        })
          .then((r) => r.json())
          .then((b) => b.data?.workCenters ?? [])
          .catch(() => []);
        const apiCenters = apiSummary.map((c) => c.code);

        const centers = await page
          .locator('text=Загрузка участков')
          .first()
          .evaluate((el) => {
            const card = el.closest('div[class*="rounded-xl"]');
            if (!card) return null;
            const box = card.getBoundingClientRect();
            // Прокручиваемое окно внутри карточки — это и есть спрятанное
            // содержимое, независимо от того, каким классом оно сделано.
            const scrollers = [...card.querySelectorAll('*')]
              .filter((n) => n.scrollHeight - n.clientHeight > 2)
              .map((n) => `${n.tagName.toLowerCase()} +${n.scrollHeight - n.clientHeight}px`);
            // Строка участка: та, что начинается с кода в моноширинном.
            const rows = [...card.querySelectorAll('span[class*="font-mono"]')]
              .filter((n) => /^[A-Z]{2,}[A-Z0-9-]*$/.test(n.textContent.trim()))
              .map((n) => {
                const r = n.getBoundingClientRect();
                // Полоса этого участка: внутри той же ячейки сетки.
                const cell = n.closest('div[class*="flex-col"]');
                const track = cell?.querySelector('div[class*="rounded-full"]');
                const fill = track?.querySelector('div');
                return {
                  code: n.textContent.trim(),
                  below: Math.round(r.bottom - box.bottom),
                  above: Math.round(box.top - r.top),
                  // Доля заливки от дорожки: с ней сверяются минуты.
                  fill:
                    track && fill && track.clientWidth > 0
                      ? fill.getBoundingClientRect().width / track.clientWidth
                      : null,
                };
              });
            return { scrollers, rows, text: card.innerText };
          })
          .catch(() => null);

        if (!centers) {
          errors.push(`[${at}] карточка загрузки участков не найдена`);
        } else {
          const missing = apiCenters.filter((c) => !centers.text.includes(c));
          const cut = centers.rows.filter((r) => r.below > 1 || r.above > 1);
          notes.push(
            `[${at}] участков в сводке ${apiCenters.length}, строк на карточке ${centers.rows.length}` +
              `, за краем ${cut.length}, прокрутки ${centers.scrollers.length}`,
          );
          if (missing.length) {
            errors.push(`[${at}] участки не показаны целиком: нет ${missing.join(', ')}`);
          }
          if (centers.scrollers.length) {
            errors.push(
              `[${at}] загрузка участков прокручивается, часть скрыта: ${centers.scrollers.join('; ')}`,
            );
          }
          if (cut.length) {
            errors.push(
              `[${at}] строки участков вышли за карточку: ${cut
                .map((r) => `${r.code} ${r.below > 0 ? `+${r.below}px вниз` : `+${r.above}px вверх`}`)
                .join(', ')}`,
            );
          }

          // Полоса должна быть пропорциональна минутам, иначе картинка врёт
          // убедительнее любого числа: участок на 15% загрузки, нарисованный
          // полным, читается как «работает на пределе».
          const scale = Math.max(
            1,
            ...apiSummary.map((c) => Math.max(c.plannedMin ?? 0, c.actualMin ?? 0)),
          );
          const skew = [];
          for (const c of apiSummary) {
            const row = centers.rows.find((r) => r.code === c.code);
            if (!row || row.fill === null) continue;
            const want = (c.actualMin ?? 0) / scale;
            if (Math.abs(row.fill - want) > 0.03) {
              skew.push(
                `${c.code}: нарисовано ${Math.round(row.fill * 100)}%, по минутам ${Math.round(want * 100)}%`,
              );
            }
          }
          notes.push(`[${at}] полосы по минутам: ${skew.length ? skew.join('; ') : 'сходятся'}`);
          if (skew.length) errors.push(`[${at}] полоса загрузки врёт: ${skew.join('; ')}`);
        }

        // Подвал списка: с Э8 это «Заказы 1–25 из 36», а на одной странице —
        // прежнее «Записей: N». Пустой список виден по нулю в любом из них.
        const footer = await page
          .locator('text=/(Заказы\\s*\\d+–\\d+\\s*из\\s*\\d+|Записей:\\s*\\d+)/')
          .first()
          .innerText()
          .catch(() => '');
        const count = Number(footer.match(/(\d+)\s*$/)?.[1] ?? footer.match(/(\d+)/)?.[1] ?? 0);
        notes.push(`[${at}] список: ${footer.trim() || '(подвал не найден)'}`);
        if (count === 0) errors.push(`[${at}] список заказов пуст: ${footer || 'подвала нет'}`);

        /** Открыть заказ по номеру через поиск: так это делает и человек. */
        const openByNumber = async (number) => {
          const box = page.locator('input[aria-label="Поиск заказов"]').first();
          await box.fill('');
          await box.fill(number);
          await page.waitForTimeout(1200);
          const row = page.locator('div[class*="divide-y"] > button').first();
          if (!(await row.count())) return false;
          await row.click();
          await page.waitForTimeout(1200);
          return true;
        };

        // Карточку смотрим на заказе, по которому уже работали: журнал отметок
        // проверяется именно там, а не на первой строке списка.
        if (!picked.worked || !(await openByNumber(picked.worked))) {
          errors.push(`[${at}] заказ с отработанными этапами не нашёлся`);
          await page.locator('div[class*="divide-y"] > button').first().click();
          await page.waitForTimeout(1200);
        }

        for (const { key, label } of PANEL_TABS) {
          await page.getByRole('button', { name: label, exact: true }).first().click();
          await page.waitForTimeout(600);

          if (key === 'stages') {
            // Журнал этапа: без событий экран снова показывал бы минуты,
            // за которыми ничего не стоит.
            const body = await page.locator('body').innerText();
            const events = (body.match(/завершили|начали|остановили|возобновили/g) ?? []).length;
            notes.push(`[${at}] событий в журнале этапов: ${events}`);
            if (events === 0) errors.push(`[${at}] в журнале этапов нет ни одного события`);

            await runStageFiles(page, at, tag, theme);
          }

          await page.screenshot({ path: `${OUT}/production-${key}-${tag}-${theme}.png`, fullPage: true });

          const ov = await measure(page);
          overflow.push({ key: `${at}/${key}`, isDefault: true, ...ov });

          const body = await page.locator('body').innerText();
          for (const phrase of FICTION) {
            if (body.includes(phrase)) found.push(`[${at}/${key}] «${phrase}»`);
          }
        }

        // --- заведение заказа и переходы (Э1) -------------------------------

        // Форма наполняется с сервера: список продукции приходит в
        // `/production/options`. Вбитый в вёрстку список однажды разойдётся с
        // номенклатурой, поэтому проверяем сам запрос, а не только поле.
        const newBtn = page.getByRole('button', { name: /^Заказ$/ }).first();
        if (!(await newBtn.count())) {
          errors.push(`[${at}] мастеру не предложено завести заказ`);
        } else {
          await newBtn.click();
          await page.waitForTimeout(900);
          // `innerText` отдаёт текст как он нарисован, а подписи полей
          // капитализированы вёрсткой: сравниваем без регистра.
          const formText = (await page.locator('body').innerText()).toLowerCase();
          for (const must of ['новый заказ цеха', 'что производим', 'срок сдачи', 'завести черновиком']) {
            if (!formText.includes(must)) errors.push(`[${at}] в форме нет «${must}»`);
          }
          if (!optionsOk) errors.push(`[${at}] справочник формы с сервера не пришёл`);
          await page.screenshot({ path: `${OUT}/production-form-${tag}-${theme}.png`, fullPage: true });
          overflow.push({ key: `${at}/form`, isDefault: true, ...(await measure(page)) });
          await page.getByRole('button', { name: 'Отмена', exact: true }).first().click();
          await page.waitForTimeout(400);
        }

        // Работающий заказ: отмена возможна из любого незакрытого состояния.
        if (!picked.active) {
          notes.push(`[${at}] заказов в работе нет — переходы проверять не на чем`);
        } else if (await openByNumber(picked.active)) {
          const text = await page.locator('body').innerText();
          if (!text.includes('Отменить')) {
            errors.push(`[${at}] у заказа ${picked.active} в работе нет отмены`);
          }
          notes.push(`[${at}] ${picked.active}: отмена предложена`);
          await page.screenshot({ path: `${OUT}/production-actions-${tag}-${theme}.png`, fullPage: true });
          overflow.push({ key: `${at}/actions`, isDefault: true, ...(await measure(page)) });
        } else {
          errors.push(`[${at}] заказ ${picked.active} не нашёлся поиском`);
        }

        // С паузы заказ продолжают, а не запускают: статус тот же, слово другое.
        if (!picked.paused) {
          notes.push(`[${at}] приостановленных заказов нет`);
        } else if (await openByNumber(picked.paused)) {
          const text = await page.locator('body').innerText();
          if (!text.includes('Продолжить')) {
            errors.push(`[${at}] у приостановленного ${picked.paused} нет «Продолжить»`);
          }
          notes.push(`[${at}] ${picked.paused}: предложено продолжить`);
        }

        // Закрытый заказ: действий нет, и экран говорит об этом словами.
        if (!picked.closed) {
          notes.push(`[${at}] закрытых заказов нет`);
        } else if (await openByNumber(picked.closed)) {
          const text = await page.locator('body').innerText();
          if (!text.includes('действий больше нет')) {
            errors.push(`[${at}] у закрытого ${picked.closed} предложены действия`);
          }
          if (text.includes('Отменить')) {
            errors.push(`[${at}] у закрытого ${picked.closed} предложена отмена`);
          }
          notes.push(`[${at}] ${picked.closed}: действий нет — верно`);
        } else {
          errors.push(`[${at}] заказ ${picked.closed} не нашёлся поиском`);
        }

        // --- этапы заказа и отметки цеха (Э3) --------------------------------

        if (!stageCase.running) {
          errors.push(`[${at}] заказ с этапами в работе не завёлся — отметки проверять не на чем`);
        } else if (await openByNumber(stageCase.running)) {
          const panel = await page.locator('body').innerText();
          for (const must of ['Начал', 'Время считает система']) {
            if (!panel.includes(must)) {
              errors.push(`[${at}] у работающего заказа нет «${must}»`);
            }
          }
          // Пауза спрашивает причину до остановки, а не после.
          const pause = page.getByRole('button', { name: 'Начал', exact: true }).first();
          if (await pause.count()) {
            await pause.click();
            await page.waitForTimeout(1200);
            const after = await page.locator('body').innerText();
            if (!after.includes('Пауза') || !after.includes('Закончил')) {
              errors.push(`[${at}] после «Начал» не предложены пауза и завершение`);
            }
            await page.getByRole('button', { name: 'Пауза', exact: true }).first().click();
            await page.waitForTimeout(600);
            const asking = await page.locator('body').innerText();
            if (!asking.includes('Почему останавливаем')) {
              errors.push(`[${at}] пауза не спрашивает причину простоя`);
            }
            await page.screenshot({
              path: `${OUT}/production-stage-marks-${tag}-${theme}.png`,
              fullPage: true,
            });
            overflow.push({ key: `${at}/stage-marks`, isDefault: true, ...(await measure(page)) });
            await page.getByRole('button', { name: 'Назад', exact: true }).first().click();
            await page.waitForTimeout(400);
          } else {
            errors.push(`[${at}] кнопки «Начал» на этапе нет`);
          }
          notes.push(`[${at}] ${stageCase.running}: отметки цеха на месте`);
        } else {
          errors.push(`[${at}] заказ ${stageCase.running} не нашёлся поиском`);
        }

        if (stageCase.empty && (await openByNumber(stageCase.empty))) {
          const panel = await page.locator('body').innerText();
          for (const must of ['План работ ещё не задан', 'Этапы из техкарты']) {
            if (!panel.includes(must)) {
              errors.push(`[${at}] у заказа без этапов нет «${must}»`);
            }
          }
          notes.push(`[${at}] ${stageCase.empty}: сказано, что плана работ нет`);
        }

        // --- срок в рабочих днях и раскладка по сменам (Э7) -----------------

        if (stageCase.running && (await openByNumber(stageCase.running))) {
          const panel = await page.locator('body').innerText();
          if (!/(До срока \d+ рабочих дней|Срок прошёл: \d+ рабочих дней назад)/.test(panel)) {
            errors.push(`[${at}] в карточке не сказано, сколько рабочих дней до срока`);
          }
          const spread = page
            .getByRole('button', { name: 'Разложить по сменам', exact: true })
            .first();
          if (!(await spread.count())) {
            errors.push(`[${at}] нет кнопки «Разложить по сменам»`);
          } else {
            await spread.click();
            await page.waitForTimeout(1500);
            const after = await page.locator('body').innerText();
            if (!/По графику закончим/.test(after)) {
              errors.push(`[${at}] раскладка молчит о том, успеваем ли к сроку`);
            }
            if (!/план: \d{2}\.\d{2}/.test(after)) {
              errors.push(`[${at}] у этапов не появились плановые даты`);
            }
            overflow.push({ key: `${at}/schedule`, isDefault: true, ...(await measure(page)) });
          }
          notes.push(`[${at}] сроки: рабочие дни и раскладка по сменам на месте`);
        }

        // --- материалы заказа (Э4) ------------------------------------------

        if (stageCase.withMaterials && (await openByNumber(stageCase.withMaterials))) {
          await page.getByRole('button', { name: 'Материалы', exact: true }).first().click();
          await page.waitForTimeout(900);
          const panel = await page.locator('body').innerText();
          if (!panel.includes('план') || !panel.includes('выдано')) {
            errors.push(`[${at}] в материалах нет плана и выдачи`);
          }
          // Мастер цеха склад не двигает: выдача — право кладовщика, и кнопки
          // у мастера быть не должно. А отметить расход он может.
          if (panel.includes('Выдать в цех')) {
            errors.push(`[${at}] мастеру предложена выдача со склада`);
          }
          const useBtn = page
            .getByRole('button', { name: 'Списать в работу', exact: true })
            .first();
          if (!(await useBtn.count())) {
            errors.push(`[${at}] нет кнопки «Списать в работу» при материале на руках`);
          } else {
            await useBtn.click();
            await page.waitForTimeout(900);
            const asking = await page.locator('body').innerText();
            if (!asking.includes('ушло в работу') || !asking.includes('журнал отклонений')) {
              errors.push(`[${at}] списание не объясняет, что считается перерасходом`);
            }
            await page.screenshot({
              path: `${OUT}/production-materials-${tag}-${theme}.png`,
              fullPage: true,
            });
            overflow.push({ key: `${at}/materials-use`, isDefault: true, ...(await measure(page)) });
            await page.getByRole('button', { name: 'Назад', exact: true }).first().click();
            await page.waitForTimeout(400);
          }
          if (!panel.includes('На руках у цеха')) {
            errors.push(`[${at}] не сказано, сколько материала на руках у цеха`);
          }

          // Нормы расхода у ППУ-труб мелкие: 0,0264 т на трубу. Если округлить
          // до одного знака, цех прочитает «план 0,0» — и решит, что материал
          // не нужен вовсе.
          const lines = await page.evaluate(() =>
            [...document.querySelectorAll('span')]
              .filter((s) => /^(план|reja)\s/.test((s.textContent ?? '').trim()))
              .map((s) => ({
                qty: (s.textContent ?? '').trim(),
                dev: (s.parentElement?.lastElementChild?.textContent ?? '').trim(),
              })),
          );
          if (!lines.length) errors.push(`[${at}] строк материалов на экране нет`);
          const planned = (await orderCard(stageCase.withMaterials)).materials ?? [];
          if (planned.some((m) => Number(m.qtyPlanned) > 0) && lines.some((l) => /^план 0,0 /.test(l.qty))) {
            errors.push(`[${at}] ненулевой план показан нулём: ${lines.find((l) => /^план 0,0 /.test(l.qty)).qty}`);
          }
          // Материал, который ещё не расходовали, отклонения не имеет: число
          // в углу строки читается как перерасход или экономия, а их не было.
          const idle = lines.find((l) => /расход 0,0 /.test(l.qty));
          if (idle && idle.dev && idle.dev !== idle.qty) {
            errors.push(`[${at}] у нетронутого материала показано отклонение «${idle.dev}»`);
          }
          // Цена строки берётся из движения выдачи. Ноль там означает, что
          // цену списания система не знает, а «0 UZS» читается как «бесплатно».
          if (/\b0\s*UZS/.test(panel)) {
            errors.push(`[${at}] в материалах показана цена 0 UZS: цена списания неизвестна`);
          }
          notes.push(`[${at}] материалы: план, выдача и расход на месте`);
        } else if (stageCase.withMaterials) {
          errors.push(`[${at}] заказ ${stageCase.withMaterials} не нашёлся поиском`);
        }

        // --- выпуск заказа (Э5) ---------------------------------------------

        if (stageCase.withMaterials && (await openByNumber(stageCase.withMaterials))) {
          await page.getByRole('button', { name: 'Выпуск', exact: true }).first().click();
          await page.waitForTimeout(900);
          const panel = await page.locator('body').innerText();
          for (const must of ['Годное', 'Брак', 'Отход']) {
            if (!panel.includes(must)) errors.push(`[${at}] на выпуске нет «${must}»`);
          }
          if (!panel.includes('партией с номером заказа')) {
            errors.push(`[${at}] не сказано, что годное принимается партией заказа`);
          }

          const goodBtn = page.getByRole('button', { name: 'Записать годное', exact: true }).first();
          if (!(await goodBtn.count())) {
            errors.push(`[${at}] нет кнопки «Записать годное» по заказу в работе`);
          } else {
            await goodBtn.click();
            await page.waitForTimeout(700);
            const asking = await page.locator('body').innerText();
            if (!asking.includes('вырастет остаток склада')) {
              errors.push(`[${at}] запись годного не объясняет, что будет с остатком`);
            }
            // Комментарий к выпуску: причина отвечает «из-за чего», а словами
            // цех говорит «что именно было». До этого сказать было негде.
            if (!(await page.locator('[aria-label="Комментарий"]').count())) {
              errors.push(`[${at}] у записи годного нет поля «Комментарий»`);
            }
            await page.screenshot({
              path: `${OUT}/production-output-${tag}-${theme}.png`,
              fullPage: true,
            });
            overflow.push({ key: `${at}/output-good`, isDefault: true, ...(await measure(page)) });
            await page.getByRole('button', { name: 'Назад', exact: true }).first().click();
            await page.waitForTimeout(400);
          }

          const defectBtn = page.getByRole('button', { name: 'Записать брак', exact: true }).first();
          if (await defectBtn.count()) {
            await defectBtn.click();
            await page.waitForTimeout(700);
            const asking = await page.locator('body').innerText();
            if (!asking.includes('журнал отклонений')) {
              errors.push(`[${at}] брак не объясняет, куда он попадёт`);
            }
            // Причину спрашивают списком, а не полем для набора текста.
            const picker = page.locator('[aria-label="Причина"]').first();
            if (!(await picker.count())) {
              errors.push(`[${at}] у брака не спрашивают причину`);
            }
            // Причина — из справочника, и подробность смены в неё не
            // укладывается: у брака комментарий нужен тем более.
            if (!(await page.locator('[aria-label="Комментарий"]').count())) {
              errors.push(`[${at}] у записи брака нет поля «Комментарий»`);
            }
            await page.getByRole('button', { name: 'Назад', exact: true }).first().click();
            await page.waitForTimeout(400);
          } else {
            errors.push(`[${at}] нет кнопки «Записать брак» по заказу в работе`);
          }
          notes.push(`[${at}] выпуск: годное, брак и отход на месте`);
        }

        // --- себестоимость заказа (Э6) --------------------------------------

        if (picked.closed && (await openByNumber(picked.closed))) {
          await page.getByRole('button', { name: 'Себестоимость', exact: true }).first().click();
          await page.waitForTimeout(1200);
          const panel = await page.locator('body').innerText();
          if (!panel.includes('по той цене, по которой их выдали со склада')) {
            errors.push(`[${at}] себестоимость не объясняет, по какой цене взят материал`);
          }
          if (!panel.includes('брак цену годного не уменьшает')) {
            errors.push(`[${at}] не сказано, что брак цену годного не уменьшает`);
          }
          const card = await orderCard(picked.closed);
          if (card.cost) {
            for (const must of ['Итого', 'Годного выпущено', 'Себестоимость 1']) {
              if (!panel.includes(must)) {
                errors.push(`[${at}] в расчёте нет строки «${must}»`);
              }
            }
            // Цифра под документом не берётся из воздуха: на экране должно
            // стоять то же число, что в карточке заказа с сервера.
            const shown = [...panel.matchAll(/([\d\s\u00a0]+)\s*UZS/g)].map((m) =>
              Number(m[1].replace(/[\s\u00a0]/g, '')),
            );
            const total = Math.round(Number(card.cost.totalCost));
            if (!shown.some((v) => Math.abs(v - total) <= 1)) {
              errors.push(
                `[${at}] итог на экране (${shown.join(', ')}) не совпал с расчётом сервера (${total})`,
              );
            }
          } else if (!panel.includes('ещё не рассчитана')) {
            errors.push(`[${at}] у заказа без расчёта экран не говорит, что расчёта нет`);
          }
          const again = page
            .getByRole('button', { name: /^(Рассчитать|Пересчитать)$/ })
            .first();
          if (!(await again.count())) {
            errors.push(`[${at}] по выпущенному заказу нет кнопки расчёта`);
          }
          await page.screenshot({ path: `${OUT}/production-cost-${tag}-${theme}.png`, fullPage: true });
          overflow.push({ key: `${at}/cost`, isDefault: true, ...(await measure(page)) });
          notes.push(`[${at}] себестоимость: разбор и кнопка расчёта на месте`);
        }

        // Заказ в работе считать нельзя: кнопки там нет, а причина названа.
        if (stageCase.running && (await openByNumber(stageCase.running))) {
          await page.getByRole('button', { name: 'Себестоимость', exact: true }).first().click();
          await page.waitForTimeout(900);
          const panel = await page.locator('body').innerText();
          if (!panel.includes('когда заказ выпущен')) {
            errors.push(`[${at}] у заказа в работе не сказано, почему расчёта нет`);
          }
          if (await page.getByRole('button', { name: /^(Рассчитать|Пересчитать)$/ }).count()) {
            errors.push(`[${at}] по заказу в работе предлагают считать себестоимость`);
          }
        }

        // --- загрузка участков по календарю (Э7) ----------------------------

        {
          const head = await page.locator('body').innerText();
          if (!/По календарю \d+ рабочих дней/.test(head)) {
            errors.push(`[${at}] загрузка участков не говорит, сколько завод работал`);
          }
        }

        // --- отклонения и простои (Э7) --------------------------------------

        await page.getByRole('button', { name: 'Отклонения', exact: true }).first().click();
        await page.waitForTimeout(1200);
        {
          const panel = await page.locator('body').innerText();
          if (!panel.includes('пошло не по плану')) {
            errors.push(`[${at}] журнал отклонений не объясняет, что в нём лежит`);
          }
          const stop = page.getByRole('button', { name: 'Зафиксировать простой', exact: true }).first();
          if (!(await stop.count())) {
            errors.push(`[${at}] нет кнопки «Зафиксировать простой»`);
          } else {
            await stop.click();
            await page.waitForTimeout(700);
            const asking = await page.locator('body').innerText();
            if (!asking.includes('будет видна в загрузке участка')) {
              errors.push(`[${at}] запись простоя не объясняет, куда она попадёт`);
            }
            for (const field of ['Участок', 'Причина', 'Длительность']) {
              if (!(await page.locator(`[aria-label="${field}"]`).count())) {
                errors.push(`[${at}] у простоя не спрашивают «${field}»`);
              }
            }
            await page.screenshot({
              path: `${OUT}/production-deviations-${tag}-${theme}.png`,
              fullPage: true,
            });
            overflow.push({ key: `${at}/deviations`, isDefault: true, ...(await measure(page)) });
            await page.getByRole('button', { name: 'Назад', exact: true }).first().click();
            await page.waitForTimeout(400);
          }
          notes.push(`[${at}] отклонения: журнал и запись простоя на месте`);
        }

        // --- календарь завода (Э7) ------------------------------------------

        await page.getByRole('button', { name: 'Календарь', exact: true }).first().click();
        await page.waitForTimeout(1200);
        {
          const panel = await page.locator('body').innerText();
          for (const must of ['Рабочая неделя и смены', 'Ближайшие дни', 'рабочих дней']) {
            if (!panel.includes(must)) {
              errors.push(`[${at}] в календаре нет «${must}»`);
            }
          }
          // Дни недели — кнопки, а не текст: по ним неделю и задают.
          if (!(await page.locator('button[aria-label="Пн"]').count())) {
            errors.push(`[${at}] рабочую неделю нечем задать: нет кнопок дней`);
          }
          // Смены должны быть названы временем, а не одними номерами.
          if (!/\d{2}:\d{2}–\d{2}:\d{2}/.test(panel)) {
            errors.push(`[${at}] у смен не видно времени начала и конца`);
          }
          if (!panel.includes('выходной')) {
            errors.push(`[${at}] в ближайших днях не отмечены выходные`);
          }
          await page.screenshot({
            path: `${OUT}/production-calendar-${tag}-${theme}.png`,
            fullPage: true,
          });
          overflow.push({ key: `${at}/calendar`, isDefault: true, ...(await measure(page)) });
          notes.push(`[${at}] календарь: неделя, смены и ближайшие дни на месте`);
        }

        // --- отчёты модуля (Э8) ---------------------------------------------

        await page.getByRole('button', { name: 'Отчёты', exact: true }).first().click();
        await page.waitForTimeout(1600);
        {
          const panel = await page.locator('body').innerText();
          // Каждый отчёт назван вопросом, на который отвечает, и выбирается кнопкой.
          for (const must of [
            'Сроки заказов',
            'Выпуск и брак',
            'Расход материалов',
            'Причины потерь',
            'Загрузка участков',
          ]) {
            if (!(await page.getByRole('button', { name: must, exact: true }).count())) {
              errors.push(`[${at}] в отчётах нет «${must}»`);
            }
          }
          if (!panel.includes('у кого просрочка')) {
            errors.push(`[${at}] отчёт не объясняет, что в нём смотрят`);
          }
          // Период спрашивают, а не берут молча.
          for (const field of ['Дата с', 'Дата по']) {
            if (!(await page.locator(`[aria-label="${field}"]`).count())) {
              errors.push(`[${at}] у отчёта не спрашивают «${field}»`);
            }
          }
          // Подпись отчёта говорит, за какой период он собран.
          if (!/с \d{2}\.\d{2}\.\d{4} по \d{2}\.\d{2}\.\d{4}/.test(panel)) {
            errors.push(`[${at}] подпись отчёта не говорит период`);
          }
          for (const fmt of ['Excel', 'CSV', 'PDF']) {
            if (!(await page.getByRole('button', { name: fmt, exact: true }).count())) {
              errors.push(`[${at}] отчёт нечем выгрузить в ${fmt}`);
            }
          }
          // Таблица должна быть не пустой: заказы со сроком за период есть в данных.
          const cells = await page.locator('table td').count();
          if (cells === 0) errors.push(`[${at}] отчёт по срокам пуст`);
          await page.screenshot({
            path: `${OUT}/production-reports-${tag}-${theme}.png`,
            fullPage: true,
          });
          overflow.push({ key: `${at}/reports`, isDefault: true, ...(await measure(page)) });

          // Другой отчёт — другие колонки, а не та же таблица.
          await page.getByRole('button', { name: 'Загрузка участков', exact: true }).first().click();
          await page.waitForTimeout(1600);
          const load = await page.locator('body').innerText();
          if (!load.includes('Загрузка, %')) {
            errors.push(`[${at}] в отчёте загрузки нет колонки загрузки`);
          }
          notes.push(`[${at}] отчёты: пять видов, период и выгрузка на месте`);
        }

        // --- участки цеха (Э8) ----------------------------------------------

        await page.getByRole('button', { name: 'Участки', exact: true }).first().click();
        await page.waitForTimeout(1400);
        {
          const panel = await page.locator('body').innerText();
          if (!panel.includes('Участок — место, где делают работу')) {
            errors.push(`[${at}] раздел участков не объясняет, что такое участок`);
          }
          if (!panel.includes('Ставка часа')) {
            errors.push(`[${at}] в списке участков не видно ставки часа`);
          }
          const add = page.getByRole('button', { name: 'Добавить участок', exact: true }).first();
          if (!(await add.count())) {
            errors.push(`[${at}] участок нечем добавить`);
          } else {
            await add.click();
            await page.waitForTimeout(600);
            for (const field of ['Код участка', 'Название по-русски', 'Ставка часа']) {
              if (!(await page.locator(`[aria-label="${field}"]`).count())) {
                errors.push(`[${at}] у участка не спрашивают «${field}»`);
              }
            }
            const form = await page.locator('body').innerText();
            // Ставка часа — то, из чего считают работу в себестоимости.
            if (!form.includes('считают работу в себестоимости')) {
              errors.push(`[${at}] форма участка не объясняет, зачем ставка часа`);
            }
            await page.screenshot({
              path: `${OUT}/production-centers-${tag}-${theme}.png`,
              fullPage: true,
            });
            overflow.push({ key: `${at}/centers`, isDefault: true, ...(await measure(page)) });
            await page.getByRole('button', { name: 'Отмена', exact: true }).first().click();
            await page.waitForTimeout(400);
          }
          // Участок закрывают, а не удаляют: у прошлых заказов пропало бы место работы.
          const edit = page.getByRole('button', { name: 'Изменить', exact: true }).first();
          if (await edit.count()) {
            await edit.click();
            await page.waitForTimeout(600);
            const card = await page.locator('body').innerText();
            if (!card.includes('в прошлых заказах он останется')) {
              errors.push(`[${at}] закрытие участка не объясняет, что будет с прошлыми заказами`);
            }
            if (await page.getByRole('button', { name: 'Удалить', exact: true }).count()) {
              errors.push(`[${at}] участок предлагают удалить`);
            }
            await page.getByRole('button', { name: 'Отмена', exact: true }).first().click();
            await page.waitForTimeout(400);
          }
          notes.push(`[${at}] участки: список, ставка часа и закрытие на месте`);
        }

        await page.getByRole('button', { name: 'Заказы цеха', exact: true }).first().click();
        await page.waitForTimeout(1400);

        // --- страницы списка заказов (Э8) -----------------------------------

        {
          // Поиск по номеру остался со проверок карточки: со фильтром в списке
          // одна строка, и листать в нём нечего. Чистим, как это сделал бы человек.
          const box = page.locator('input[aria-label="Поиск заказов"]').first();
          await box.fill('');
          await page.waitForTimeout(1600);

          const panel = await page.locator('body').innerText();
          if (!/Заказы \d+–\d+ из \d+/.test(panel)) {
            errors.push(`[${at}] список заказов не говорит, где человек в нём находится`);
          }
          const next = page.locator('button[aria-label="Вперёд"]').first();
          if (!(await next.count())) {
            notes.push(`[${at}] заказов на одну страницу — листать нечего`);
          } else {
            const firstPage = await page.locator('div[class*="divide-y"] > button:visible').count();
            await next.click();
            await page.waitForTimeout(1500);
            const moved = await page.locator('body').innerText();
            if (/Заказы 1–/.test(moved)) {
              errors.push(`[${at}] «Вперёд» не уводит со первой страницы`);
            }
            notes.push(`[${at}] страницы: на первой ${firstPage} заказов, вторая открылась`);
            await page.locator('button[aria-label="Назад"]').first().click();
            await page.waitForTimeout(1500);
            const back = await page.locator('body').innerText();
            if (!/Заказы 1–/.test(back)) {
              errors.push(`[${at}] «Назад» не возвращает на первую страницу`);
            }
          }
        }

        // --- техкарты (Э2) --------------------------------------------------

        await page.getByRole('button', { name: 'Техкарты', exact: true }).first().click();
        await page.waitForTimeout(1500);

        const cardsText = await page.locator('body').innerText();
        if (!/v\d/.test(cardsText)) errors.push(`[${at}] в списке карт не видно версий`);
        // Раздел заказов остаётся в разметке скрытым — берём только видимое,
        // иначе строки заказов посчитаются как карты.
        notes.push(
          `[${at}] карт в списке: ${await page.locator('div[class*="divide-y"] > button:visible').count()}`,
        );
        await page.screenshot({ path: `${OUT}/production-cards-${tag}-${theme}.png`, fullPage: true });
        overflow.push({ key: `${at}/cards`, isDefault: true, ...(await measure(page)) });

        // Действующая карта: правки на месте нет, предложена новая версия.
        const active = page
          .locator('div[class*="divide-y"] > button:visible')
          .filter({ hasText: 'В работе' })
          .first();
        if (!(await active.count())) {
          notes.push(`[${at}] действующих карт в списке нет`);
        } else {
          await active.click();
          await page.waitForTimeout(1200);
          const panel = await page.locator('body').innerText();
          if (!panel.includes('Новая версия')) {
            errors.push(`[${at}] у действующей карты не предложена новая версия`);
          }
          if (panel.includes('Править')) {
            errors.push(`[${at}] действующую карту предлагают править на месте`);
          }
          if (!/Действует с \d{2}\.\d{2}\.\d{4}/.test(panel)) {
            errors.push(`[${at}] не сказано, с какого дня карта действует`);
          }
          notes.push(`[${at}] действующая карта: правка только версией — верно`);
        }

        // Черновик: редактор с этапами и материалами.
        const draftRow = page
          .locator('div[class*="divide-y"] > button:visible')
          .filter({ hasText: 'Черновик' })
          .first();
        if (!(await draftRow.count())) {
          notes.push(`[${at}] черновиков карт в списке нет`);
        } else {
          await draftRow.click();
          await page.waitForTimeout(1200);
          const edit = page.getByRole('button', { name: 'Править', exact: true }).first();
          if (!(await edit.count())) {
            errors.push(`[${at}] черновик карты не предлагают править`);
          } else {
            await edit.click();
            await page.waitForTimeout(1200);
            const form = (await page.locator('body').innerText()).toLowerCase();
            for (const must of ['нормы задаются на одну единицу', 'этапы', 'материалы']) {
              if (!form.includes(must)) errors.push(`[${at}] в редакторе карты нет «${must}»`);
            }
            await page.screenshot({
              path: `${OUT}/production-card-editor-${tag}-${theme}.png`,
              fullPage: true,
            });
            overflow.push({ key: `${at}/card-editor`, isDefault: true, ...(await measure(page)) });
          }
        }

        await page.getByRole('button', { name: 'Заказы цеха', exact: true }).first().click();
        await page.waitForTimeout(800);

        // Развёрнутый сайдбар — отдельный замер, спрос с него мягче: это уже
        // осознанное действие пользователя, а не состояние по умолчанию.
        const toggle = page.getByRole('button', { name: /боковую панель/i }).first();
        if (await toggle.count()) {
          await toggle.click();
          await page.waitForTimeout(500);
          const ov = await measure(page);
          overflow.push({ key: `${at}/toggled`, isDefault: false, ...ov });
        }
      } catch (e) {
        errors.push(`[${at}] прогон оборвался: ${String(e.message).split('\n')[0]}`);
        await page.screenshot({ path: `${OUT}/FAIL-${tag}-${theme}.png`, fullPage: true }).catch(() => {});
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
  fs.writeFileSync(`${OUT}/fiction.txt`, (found.join('\n') || 'нет') + '\n');
  fs.writeFileSync(`${OUT}/data.txt`, notes.join('\n') + '\n');

  console.log('--- что показано ---');
  console.log(notes.join('\n'));
  console.log('--- переполнение по горизонтали ---');
  console.log(lines.join('\n'));
  console.log('--- выдумки из макета ---');
  console.log(found.join('\n') || 'нет');
  console.log('--- ошибки консоли ---');
  console.log(errors.join('\n') || 'нет');

  const problems = [];
  if (errors.length) problems.push(`ошибок: ${errors.length}`);
  if (found.length) problems.push(`выдуманных подписей на экране: ${found.length}`);
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
  if (draftCardUid) {
    // Прогон экрана не оставляет следов в демо-данных: свою карту убираем
    // совсем, а не прячем в архив.
    const db = new Client({ connectionString: ownerUrl() });
    try {
      await db.connect();
      await db.query('DELETE FROM tech_card WHERE uid = $1::uuid', [draftCardUid]);
      console.log('черновик карты убран');
    } catch (e) {
      console.error(`черновик карты остался: ${e.message}`);
    } finally {
      await db.end().catch(() => {});
    }
  }
  if (stageOrderUids.length) {
    const db = new Client({ connectionString: ownerUrl() });
    try {
      await db.connect();
      // Материал, выданный прогоном, возвращаем на склад тем же путём, каким
      // он уходил: остаток демо-данных должен остаться прежним.
      // Возвращает кладовщик: у мастера складского права нет, и это правило,
      // а не оплошность прогона.
      const token = await keeperLogin().catch(() => null);
      if (token) {
        const left = await db.query(
          `SELECT o.uid::text AS order_uid, i.code, (pm.qty_issued - pm.qty_returned)::text AS qty,
                  w.code AS warehouse, l.code AS location, b.number AS batch
             FROM production_material pm
             JOIN production_order o ON o.id = pm.production_order_id
             JOIN item i ON i.id = pm.item_id
             JOIN LATERAL (
               SELECT m.from_warehouse_id, m.from_location_id, m.batch_id FROM stock_move m
                WHERE m.source_doc_type = 'production_material' AND m.source_doc_id = pm.id
                  AND m.operation_type = 'issue_to_production' ORDER BY m.id DESC LIMIT 1
             ) mv ON true
             JOIN warehouse w ON w.id = mv.from_warehouse_id
             LEFT JOIN storage_location l ON l.id = mv.from_location_id
             LEFT JOIN batch b ON b.id = mv.batch_id
            WHERE o.uid = ANY($1::uuid[]) AND pm.qty_issued - pm.qty_returned > 0`,
          [stageOrderUids],
        );
        for (const row of left.rows) {
          const res = await fetch(`${API}/production/orders/${row.order_uid}/materials/return`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              itemCode: row.code,
              qty: row.qty,
              warehouseCode: row.warehouse,
              ...(row.location ? { locationCode: row.location } : {}),
              ...(row.batch ? { batchNumber: row.batch } : {}),
            }),
          });
          console.log(
            res.ok
              ? `материал ${row.code} вернулся на склад`
              : `материал ${row.code} не вернулся: ${res.status}`,
          );
        }
      }
      await db.query(
        `DELETE FROM production_material WHERE production_order_id IN
           (SELECT id FROM production_order WHERE uid = ANY($1::uuid[]))`,
        [stageOrderUids],
      );
      await db.query(
        `DELETE FROM deviation_log WHERE production_order_id IN
           (SELECT id FROM production_order WHERE uid = ANY($1::uuid[]))`,
        [stageOrderUids],
      );
      await db.query(
        `DELETE FROM production_stage WHERE production_order_id IN
           (SELECT id FROM production_order WHERE uid = ANY($1::uuid[]))`,
        [stageOrderUids],
      );
      await db.query('DELETE FROM production_order WHERE uid = ANY($1::uuid[])', [stageOrderUids]);
      console.log('заказы прогона убраны');
    } catch (e) {
      console.error(`заказы прогона остались: ${e.message}`);
    } finally {
      await db.end().catch(() => {});
    }
  }
  if (server) server.close();
  if (backend) backend.kill('SIGTERM');
}
