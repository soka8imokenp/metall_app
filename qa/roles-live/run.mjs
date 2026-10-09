/**
 * Вход по ролям и обязательная смена пароля — против живого бэкенда.
 *
 * Зачем прогон. Две вещи проверяются только целиком, браузером:
 *
 *  1. Выданный пароль действительно запирает систему. Серверные тесты
 *     (`backend/test/password-change.e2e.spec.ts`) держат отказ на маршрутах,
 *     но человек видит не отказ, а экран: он обязан появиться сразу после
 *     входа, а не после первого неудачного запроса, и мимо него не должно
 *     быть хода.
 *  2. Меню показывает только свои разделы. До 06.10 сайдбар рисовал все семь
 *     любой роли, и отказ сервера выглядел поломкой. Проверка идёт по
 *     `data-module`, то есть по тому, что на самом деле в разметке, а не по
 *     картинке.
 *  3. Переключатель компаний показывает ровно то, что дала сессия. Двух
 *     собственников (поправка от 06.10) разделяет только список компаний в
 *     учётке, поэтому и список в сайдбаре, и отказ на чужой `X-Company-Id`
 *     проверяются здесь же, на собранном бэкенде и собранном фронте.
 *
 * Учётки прогон заводит сам — через `POST /admin/users`, тем же путём, которым
 * их заводит администратор. Это заодно и проверка того, что признак
 * «пароль временный» встаёт при создании: читаем его прямо из базы.
 *
 * Перед запуском собрать фронт с живым API:
 *   cd dev/frontend && bun run build:qa
 *
 * Запуск:
 *   cd dev/qa && bun run roles-live
 */
import { spawn } from 'node:child_process';
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import pgPkg from 'pg';
// Правило дефолтного пароля берём из того же файла, по которому его выдаёт сид
// и сервер (`backend/src/common/default-password.ts`), а не повторяем здесь
// строкой. Повтор уже обманывал: правило «логин+123» разошлось с тем, что
// просил заказчик («роль+123»), а прогон этого не замечал — он проверял свою
// копию правила. Node 26 читает `.ts` сам, без сборки.
import { defaultPasswordFor } from '../../backend/src/common/default-password.ts';

const { Client } = pgPkg;

/** Тот же браузер, что в остальных прогонах. */
const CHROME = '/home/an/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '../../frontend/dist-qa');
const BACKEND = path.resolve(HERE, '../../backend');
const OUT = path.resolve(HERE, 'shots');
/** Порт 4400, а не 4000: на 4000 живёт внешний стенд со своей базой. */
const API_PORT = Number(process.env.QA_API_PORT ?? 4400);
const API = `http://127.0.0.1:${API_PORT}/api/v1`;
const WEB_PORT = 4321;
const WEB = `http://127.0.0.1:${WEB_PORT}`;

/** Администратор профиля `dev`: у него признак не поднят, он и заводит учётки. */
const ADMIN = 'admin';
const ADMIN_PASSWORD = process.env.SEED_PASSWORD ?? 'metall-dev-2026';

const stamp = String(Date.now()).slice(-6);
/** Пароль, который человек ставит себе сам. Не дефолтный — такой сервер отбивает. */
const OWN_PASSWORD = `Qa-roles-${stamp}`;

/**
 * Какие разделы роль обязана видеть в меню. Набор тот же, что в
 * `backend/prisma/rbac.ts`, но записан отдельно нарочно: прогон обязан
 * падать, когда права роли молча поменяли.
 *
 * `help` — «Справка», она открыта любой вошедшей роли (`Sidebar.tsx`): это не
 * участок учёта, а инструкции, и прав у неё нет. В списках её не было, потому
 * что раздел появился позже самого прогона, — и прогон честно отбивал её как
 * чужой раздел у обеих ролей.
 */
const ROLES = [
  {
    code: 'warehouse_keeper',
    tag: 'wh',
    ru: 'Кладовщик',
    modules: ['dashboard', 'sales', 'warehouse', 'production', 'help'],
  },
  {
    code: 'owner',
    tag: 'ow',
    ru: 'Собственник',
    modules: [
      'dashboard',
      'sales',
      'warehouse',
      'production',
      'finance',
      'documents',
      'crm',
      'help',
    ],
  },
];

fs.mkdirSync(OUT, { recursive: true });

const problems = [];
const errors = [];
/** Шаги, где отказ сервера — проверяемый путь, а не находка. */
let quiet = false;
let backend;
let server;
let browser;
let db;

const bad = (text) => {
  problems.push(text);
  console.log(`  ✗ ${text}`);
};
const ok = (text) => console.log(`  ✓ ${text}`);

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

async function apiJson(url, init = {}) {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

/** Признак «пароль временный» прямо из базы: экран мог бы его и не показать. */
async function flag(login) {
  const r = await db.query('SELECT must_change_password AS f FROM user_account WHERE login = $1', [
    login,
  ]);
  if (r.rowCount === 0) throw new Error(`учётки ${login} нет в базе`);
  return r.rows[0].f;
}

const field = (page, id) => page.locator(`#${id}`);
const errorBox = (page) => page.locator('[data-role="change-password-error"]');
const screen = (page) => page.locator('[data-screen="change-password"]');

async function submitChange(page, current, next, repeat) {
  await field(page, 'cp-current').fill(current);
  await field(page, 'cp-next').fill(next);
  await field(page, 'cp-repeat').fill(repeat ?? next);
  await page.getByRole('button', { name: /Сменить пароль/ }).click();
  await page.waitForTimeout(1200);
}

/**
 * Прогон собирает и бэкенд, и фронт сам.
 *
 * Пока сборку делали руками, прогон проверял прошлый код: 06.10 я добавил на
 * экран смены пароля подпись к логину и новую проверку к ней — проверка
 * краснела на собранном раньше `dist-qa`, хотя правка в `src` была верной.
 * Ровно та же ловушка уже ловила бэкенд в `production-live`. Сборка
 * инкрементальная: при свежем `dist` почти ничего не стоит, при правленом
 * `src` делает то, без чего прогон врёт.
 */
async function build(what, cmd, args, cwd) {
  await new Promise((ok_, fail) => {
    const p = spawn(cmd, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) =>
      code === 0 ? ok_() : fail(new Error(`${what} не собрался (${code}): ${err.slice(-400)}`)),
    );
  });
  console.log(`${what} собран из исходников`);
}

try {
  await assertPortFree();
  await build('бэкенд', 'npm', ['run', 'build'], BACKEND);
  await build('фронт', 'bun', ['run', 'build:qa'], path.resolve(HERE, '../../frontend'));
  if (!fs.existsSync(ROOT)) {
    throw new Error(`нет сборки ${ROOT} — проверьте скрипт build:qa во фронте`);
  }

  db = new Client({ connectionString: databaseUrl() });
  await db.connect();

  backend = spawn('node', ['dist/main.js'], {
    cwd: BACKEND,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(API_PORT), CORS_ORIGINS: `${WEB}` },
  });
  backend.stdout.on('data', () => {});
  backend.stderr.on('data', (d) => process.stderr.write(`[api!] ${d}`));
  await waitForApi(20000);

  const app = express();
  app.use(express.static(ROOT));
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(ROOT, 'index.html')));
  server = await new Promise((resolve) => {
    const s = app.listen(WEB_PORT, '127.0.0.1', () => resolve(s));
  });

  // Администратор и компания, в которой заводим учётки.
  const adminLogin = await apiJson(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: ADMIN, password: ADMIN_PASSWORD }),
  });
  if (adminLogin.status !== 201) {
    throw new Error(`администратор не вошёл: ${adminLogin.status}. Задай SEED_PASSWORD.`);
  }
  const adminToken = adminLogin.body.data.token;
  const trade = adminLogin.body.data.companies.find((c) => c.code === 'trade');
  if (!trade) throw new Error('у администратора нет компании trade');
  const plant = adminLogin.body.data.companies.find((c) => c.code === 'plant');
  if (!plant) throw new Error('у администратора нет компании plant');
  const companyUid = { trade: trade.uid, plant: plant.uid };

  browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });

  for (const [w, h] of [
    [1440, 900],
    [360, 780],
  ]) {
    for (const theme of ['light', 'dark']) {
      const at = `${w}-${theme}`;
      console.log(`\n=== ${at} ===`);

      const ctx = await browser.newContext({ viewport: { width: w, height: h } });
      const page = await ctx.newPage();
      page.on('console', (m) => {
        if (m.type() !== 'error' || quiet) return;
        errors.push(`[${at}] ${m.text().slice(0, 300)}`);
      });
      page.on('pageerror', (e) => errors.push(`[${at}] PAGEERROR ${e.message.slice(0, 300)}`));
      // Тема берётся из localStorage (`AppContext.tsx`, ключ `metall_theme`),
      // а не из `prefers-color-scheme`: без этой строки «тёмный» проход молча
      // идёт светлым и снимки ничего не доказывают.
      await page.addInitScript((t) => localStorage.setItem('metall_theme', t), theme);

      for (const role of ROLES) {
        const login = `qa_${role.tag}_${stamp}_${w}${theme[0]}`;
        const made = await apiJson(`${API}/admin/users`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
          body: JSON.stringify({
            login,
            fullName: `Прогон ролей: ${role.ru}`,
            password: defaultPasswordFor(login),
            assignments: [{ roleCode: role.code, companyUid: trade.uid }],
          }),
        });
        if (made.status !== 201) {
          throw new Error(`не завёл учётку ${login}: ${made.status} ${JSON.stringify(made.body)}`);
        }

        // 1. Признак встал при создании — без него весь остальной путь не о том.
        if (await flag(login)) ok(`${role.code}: учётка создана с временным паролем`);
        else bad(`${role.code}: созданная учётка без признака «пароль временный»`);

        await page.goto(WEB, { waitUntil: 'networkidle' });
        await page.evaluate(() => sessionStorage.clear());
        await page.goto(WEB, { waitUntil: 'networkidle' });
        await page
          .getByLabel('Логин')
          .or(page.locator('input[autocomplete="username"]'))
          .first()
          .fill(login);
        await page.locator('input[autocomplete="current-password"]').first().fill(defaultPasswordFor(login));
        await page.getByRole('button', { name: 'Войти' }).click();

        // 2. Экран смены пароля вместо интерфейса — сразу, а не после отказа.
        await page.waitForSelector('[data-screen="change-password"]', { timeout: 15000 });
        ok(`${role.code}: вход ведёт на экран смены пароля`);
        if (await page.locator('[data-module]').count()) {
          bad(`${role.code}: за экраном смены пароля отрисовано меню`);
        } else {
          ok(`${role.code}: мимо экрана ничего не отрисовано`);
        }

        // Логин на экране — обязательно с подписью. Голая строка читается как
        // сбой: заказчик 06.10 так и прочёл её на снимке («непонятный текст
        // на панели» — туда попала временная учётка прогона).
        // Через `count()`, а не сразу `textContent()`: у отсутствующего узла
        // ожидание висит 30 секунд и валит прогон исключением вместо
        // понятной красной строки.
        const acctBox = page.locator('[data-role="change-password-account"]').first();
        const acct = (await acctBox.count()) ? ((await acctBox.textContent()) ?? '') : '';
        if (acct.includes('Учётная запись') && acct.includes(login)) {
          ok(`${role.code}: учётная запись названа и подписана`);
        } else {
          bad(`${role.code}: логин на экране без подписи или не тот: «${acct.trim()}»`);
        }

        const isDark = await page.evaluate(() =>
          document.documentElement.classList.contains('dark'),
        );
        if (isDark === (theme === 'dark')) ok(`тема применилась`);
        else bad(`[${at}] тема не применилась: на странице ${isDark ? 'тёмная' : 'светлая'}`);

        if (role.tag === 'wh') {
          const over = await page.evaluate(() => {
            const el = document.documentElement;
            return el.scrollWidth - el.clientWidth;
          });
          if (over > 1) bad(`[${at}] экран смены пароля шире окна на ${over} точек`);
          await page.screenshot({ path: `${OUT}/${at}-change-password.png`, fullPage: true });
        }

        // 3. Неверный текущий пароль, пароль по умолчанию и расхождение полей —
        //    все три отказа человек должен видеть на экране.
        quiet = true;
        await submitChange(page, 'не-тот-пароль', OWN_PASSWORD);
        if ((await errorBox(page).count()) && (await screen(page).count())) {
          ok(`${role.code}: неверный текущий пароль отбит`);
        } else {
          bad(`${role.code}: неверный текущий пароль прошёл молча`);
        }

        await submitChange(page, defaultPasswordFor(login), defaultPasswordFor(login));
        if ((await errorBox(page).count()) && (await screen(page).count())) {
          ok(`${role.code}: пароль по умолчанию как новый отбит`);
        } else {
          bad(`${role.code}: пароль по умолчанию принят как новый`);
        }
        if (await flag(login)) ok(`${role.code}: признак после отказов на месте`);
        else bad(`${role.code}: признак снят, а пароль не сменён`);

        await submitChange(page, defaultPasswordFor(login), OWN_PASSWORD, `${OWN_PASSWORD}x`);
        if ((await errorBox(page).count()) && (await screen(page).count())) {
          ok(`${role.code}: расхождение двух полей отбито`);
        } else {
          bad(`${role.code}: расхождение двух полей прошло — учётку можно запереть опечаткой`);
        }
        quiet = false;

        // 4. Свой пароль принят, признак снят, интерфейс открылся.
        await submitChange(page, defaultPasswordFor(login), OWN_PASSWORD);
        await page.waitForSelector('[data-module]', { timeout: 15000 });
        ok(`${role.code}: свой пароль принят, интерфейс открылся`);
        if (await flag(login)) bad(`${role.code}: пароль сменён, а признак в базе остался`);
        else ok(`${role.code}: признак в базе снят`);

        // 5. Меню — только свои разделы.
        await page.waitForTimeout(1500);
        const shown = await page.$$eval('[data-module]', (els) =>
          els.map((e) => e.getAttribute('data-module')),
        );
        const extra = shown.filter((m) => !role.modules.includes(m));
        const missing = role.modules.filter((m) => !shown.includes(m));
        if (extra.length) bad(`${role.code}: в меню чужие разделы — ${extra.join(', ')}`);
        else ok(`${role.code}: чужих разделов в меню нет`);
        if (missing.length) bad(`${role.code}: в меню нет своих разделов — ${missing.join(', ')}`);
        else ok(`${role.code}: все свои разделы на месте`);
        if (shown.includes('admin')) bad(`${role.code}: видна кнопка «Настройки»`);

        const over = await page.evaluate(() => {
          const el = document.documentElement;
          return el.scrollWidth - el.clientWidth;
        });
        if (over > 1) bad(`[${at}] ${role.code}: интерфейс шире окна на ${over} точек`);
        await page.screenshot({ path: `${OUT}/${at}-sidebar-${role.tag}.png`, fullPage: true });

        // 6. Собственник открывает финансы и видит данные: право `finance.view`
        //    у него есть, и отказа на этом разделе быть не должно.
        if (role.tag === 'ow') {
          await page.locator('[data-module="finance"]').first().click();
          await page.waitForTimeout(2500);
          const text = await page.locator('main').innerText();
          if (/Нет прав|Huquq yo‘q|403/.test(text)) {
            bad('owner: раздел финансов отвечает отказом');
          } else {
            ok('owner: раздел финансов открылся');
          }
          await page.screenshot({ path: `${OUT}/${at}-owner-finance.png`, fullPage: true });
        }
      }

      await ctx.close();
    }
  }

  /**
   * Собственники и компании (поправка заказчика от 06.10).
   *
   * `owner1` и `owner2` — люди на одной роли, права у них совпадают до
   * последнего кода, и отличаются они только списком компаний в учётке. Значит
   * проверять надо две вещи, и обе — целиком:
   *
   *  - заголовок `X-Company-Id` с чужой компанией даёт отказ, а не чужие цифры.
   *    Серверный сторож на это есть (`backend/test/owner-companies.e2e.spec.ts`),
   *    здесь тот же запрос идёт к собранному бэкенду;
   *  - переключатель компаний в сайдбаре показывает ровно то, что дала сессия.
   *    Лишний пункт в нём — это обещание показать цифры, которых человек не
   *    увидит: он выберет компанию, а сервер ответит отказом.
   *
   * Проход один, на 1440 в светлой теме: список компаний от ширины и темы не
   * зависит, а четвёртый прогон учёток ничего нового не доказывает.
   */
  console.log('\n=== собственники и компании ===');
  const OWNERS = [
    {
      tag: 'owb',
      ru: 'Собственник, обе компании',
      companies: ['trade', 'plant'],
      // Сводный пункт «все» появляется только тогда, когда сводить есть что
      // (`frontend/src/lib/companies.ts`).
      options: ['company_trade', 'company_factory', 'all'],
    },
    {
      tag: 'owp',
      ru: 'Собственник, Завод',
      companies: ['plant'],
      options: ['company_factory'],
    },
  ];

  const ownerCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const ownerPage = await ownerCtx.newPage();
  ownerPage.on('pageerror', (e) => errors.push(`[owners] PAGEERROR ${e.message.slice(0, 300)}`));

  const perms = {};
  for (const who of OWNERS) {
    const login = `qa_${who.tag}_${stamp}`;
    const made = await apiJson(`${API}/admin/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        login,
        fullName: `Прогон компаний: ${who.ru}`,
        password: defaultPasswordFor(login),
        assignments: who.companies.map((c) => ({ roleCode: 'owner', companyUid: companyUid[c] })),
      }),
    });
    if (made.status !== 201) {
      throw new Error(`не завёл учётку ${login}: ${made.status} ${JSON.stringify(made.body)}`);
    }

    // Пароль меняем сразу: с временным паролем любой маршрут отвечает отказом
    // по своей причине, и проверка компаний была бы зелёной ни о чём.
    const first = await apiJson(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login, password: defaultPasswordFor(login) }),
    });
    const changed = await apiJson(`${API}/auth/me/password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${first.body.data.token}`,
      },
      body: JSON.stringify({ currentPassword: defaultPasswordFor(login), newPassword: OWN_PASSWORD }),
    });
    if (changed.status !== 201 && changed.status !== 200) {
      throw new Error(`${login}: пароль не сменился (${changed.status})`);
    }
    const back = await apiJson(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login, password: OWN_PASSWORD }),
    });
    const token = back.body.data.token;
    const ask = (path, company) =>
      apiJson(`${API}${path}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          ...(company ? { 'X-Company-Id': companyUid[company] } : {}),
        },
      });

    // 1. Сессия отдаёт ровно назначенные компании.
    const me = await ask('/auth/me');
    const got = me.body.data.companies.map((c) => c.code).sort();
    const want = [...who.companies].sort();
    if (got.join(',') === want.join(',')) ok(`${who.tag}: в сессии компании ${got.join('+')}`);
    else bad(`${who.tag}: в сессии компании ${got.join('+')}, а назначены ${want.join('+')}`);
    perms[who.tag] = me.body.data.permissions.join(',');

    // 2. Каждая компания по отдельности: своя открыта, чужая отбита отказом, и
    //    в ответе нет данных — именно это спросил заказчик.
    for (const code of ['trade', 'plant']) {
      const mine = who.companies.includes(code);
      for (const path of ['/auth/me', '/finance/reports/summary', '/sales/orders']) {
        const res = await ask(path, code);
        if (mine) {
          if (res.status === 200) ok(`${who.tag}: ${code} → ${path} открыт`);
          else bad(`${who.tag}: своя компания ${code} на ${path} отбита (${res.status})`);
        } else if (res.status === 403 && !res.body?.data) {
          ok(`${who.tag}: чужая компания ${code} → ${path} отказ без данных`);
        } else {
          bad(
            `${who.tag}: чужая компания ${code} на ${path} дала ${res.status}` +
              (res.body?.data ? ' и данные в ответе' : ''),
          );
        }
      }
    }

    // 3. Переключатель компаний в сайдбаре — по разметке, а не по картинке.
    await ownerPage.goto(WEB, { waitUntil: 'networkidle' });
    await ownerPage.evaluate(() => sessionStorage.clear());
    await ownerPage.goto(WEB, { waitUntil: 'networkidle' });
    await ownerPage
      .getByLabel('Логин')
      .or(ownerPage.locator('input[autocomplete="username"]'))
      .first()
      .fill(login);
    await ownerPage.locator('input[autocomplete="current-password"]').first().fill(OWN_PASSWORD);
    await ownerPage.getByRole('button', { name: 'Войти' }).click();
    await ownerPage.waitForSelector('[data-module]', { timeout: 15000 });
    ok(`${who.tag}: вход без экрана смены пароля — пароль уже свой`);

    await ownerPage.locator('[data-company-switch="label"]').first().click();
    await ownerPage.waitForTimeout(600);
    const shownCompanies = await ownerPage.$$eval('[data-company-option]', (els) =>
      els.map((e) => e.getAttribute('data-company-option')),
    );
    if (shownCompanies.join(',') === who.options.join(',')) {
      ok(`${who.tag}: в переключателе ${shownCompanies.join(', ')}`);
    } else {
      bad(
        `${who.tag}: в переключателе ${shownCompanies.join(', ') || '— пусто'}, ` +
          `а должно быть ${who.options.join(', ')}`,
      );
    }
    await ownerPage.screenshot({ path: `${OUT}/owners-${who.tag}-companies.png`, fullPage: true });
  }

  // 4. Роль одна: права обоих совпадают. Иначе «более крутой аккаунт» уехал бы
  //    во вторую роль, а заказчик просил разделить их списком компаний.
  if (perms.owb === perms.owp) ok('права у обоих собственников одни и те же');
  else bad('права собственников разошлись: доступ к компаниям сделан второй ролью');

  await ownerCtx.close();

  fs.writeFileSync(`${OUT}/console-errors.txt`, (errors.join('\n') || 'нет') + '\n');
  console.log('\n--- ошибки консоли ---');
  console.log(errors.join('\n') || 'нет');
  if (errors.length) problems.push(`ошибок в консоли: ${errors.length}`);

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
  if (db) {
    // Учётки прогона выключаем: удалять нельзя — на них уже висит запись в
    // журнале администратора, а она ссылается на пользователя.
    // Два шаблона: учётки ролей идут с хвостом прохода (`…_1440l`), учётки
    // собственников — без него. Один шаблон оставил бы половину включённой.
    await db
      .query(`UPDATE user_account SET is_active = false WHERE login LIKE $1 OR login LIKE $2`, [
        `qa\\_%\\_${stamp}\\_%`,
        `qa\\_%\\_${stamp}`,
      ])
      .catch(() => {});
    await db.end().catch(() => {});
  }
}
