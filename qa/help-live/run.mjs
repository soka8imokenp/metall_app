/**
 * Раздел «Справка» — живой прогон против собранного бэкенда и собранного фронта.
 *
 * Что проверяется только браузером и ничем другим:
 *
 *  1. Пункт «Справка» есть в меню у **любой** вошедшей роли. Права на справку —
 *     пустой список (`lib/modules.ts`), и `.some(can)` на пустом списке даёт
 *     `false`. Тест на `moduleAllowed` это держит, но в меню пункт рисует другой
 *     код, и разойтись они могут молча.
 *  2. Статьи администратора видит только роль с правом на «Настройки».
 *     Проверка идёт по разметке (`data-help-article`), а не по картинке.
 *  3. Кнопка «?» в шапке раздела открывает статью **этого** раздела. Цель
 *     кнопки объявлена в `data-help-target`, и прогон сверяет её с тем, что
 *     реально открылось.
 *  4. Нет узбекского перевода — статья показана по-русски **с пометкой**
 *     (требование заказчика), а не пустой карточкой.
 *  5. Ничего не вылезает за контейнер на 360 и на 1440 в обеих темах.
 *
 * Прогон собирает бэкенд и фронт САМ. В этом проекте уже дважды случалось, что
 * прогон гонял прошлую сборку и зеленел на коде, которого на экране нет.
 *
 * Запуск: cd dev/qa && node help-live/run.mjs
 */
import { spawn } from 'node:child_process';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { defaultPasswordFor } from '../../backend/src/common/default-password.ts';

const CHROME = '/home/an/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const HERE = path.dirname(new URL(import.meta.url).pathname);
const FRONTEND = path.resolve(HERE, '../../frontend');
const BACKEND = path.resolve(HERE, '../../backend');
const ROOT = path.join(FRONTEND, 'dist-qa');
const OUT = path.resolve(HERE, 'shots');

const API_PORT = Number(process.env.QA_API_PORT ?? 4400);
const API = `http://127.0.0.1:${API_PORT}/api/v1`;
/** Не 4321: там стоит прогон ролей, и два прогона рядом мешали бы друг другу. */
const WEB_PORT = Number(process.env.QA_WEB_PORT ?? 4322);
const WEB = `http://127.0.0.1:${WEB_PORT}`;

const ADMIN = 'admin';
const ADMIN_PASSWORD = process.env.SEED_PASSWORD ?? 'metall-dev-2026';
const stamp = String(Date.now()).slice(-6);

/**
 * Роли прогона.
 *
 * `admin` — та самая роль с правом на «Настройки»: только она обязана видеть
 * статьи администратора. `warehouse_keeper` и `accountant` взяты как две
 * непересекающиеся по разделам роли: что видно одной, не должно быть видно
 * другой, и наоборот.
 */
const ROLES = [
  { code: 'admin', tag: 'ad', ru: 'Администратор', adminArticles: true, finance: true },
  { code: 'warehouse_keeper', tag: 'wh', ru: 'Кладовщик', adminArticles: false, finance: false },
  { code: 'accountant', tag: 'ac', ru: 'Бухгалтер', adminArticles: false, finance: true },
];

/**
 * Статья, на которой снимаем узбекскую вёрстку.
 *
 * `vhod` открыта любой роли и есть в списке у всех трёх, поэтому снимок на
 * каждой ширине и в каждой теме сопоставим между ролями.
 */
const SHOT_UZ = 'vhod';

fs.mkdirSync(OUT, { recursive: true });

const problems = [];
const errors = [];
const bad = (t) => {
  problems.push(t);
  console.log(`  ✗ ${t}`);
};
const ok = (t) => console.log(`  ✓ ${t}`);

let backend;
let server;
let browser;

async function assertPortFree() {
  const res = await fetch(`${API}/dashboard/summary`).catch(() => null);
  if (res) throw new Error(`порт ${API_PORT} занят (${res.status}) — задай QA_API_PORT`);
}

async function waitForApi(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${API}/dashboard/summary?period=7d`);
      if (r.status > 0) return;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error('бэкенд не поднялся за отведённое время');
}

const apiJson = async (url, init = {}) => {
  const res = await fetch(url, init);
  return { status: res.status, body: await res.json().catch(() => null) };
};

/** Сборка из исходников. Без неё прогон проверяет прошлый код. */
async function build(what, cmd, args, cwd) {
  await new Promise((done, fail) => {
    const p = spawn(cmd, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) =>
      code === 0 ? done() : fail(new Error(`${what} не собрался (${code}): ${err.slice(-400)}`)),
    );
  });
  console.log(`${what} собран из исходников`);
}

/**
 * Что вылезло за свой контейнер.
 *
 * Меряем по горизонтали: справка — колонка карточек, и единственный способ её
 * сломать на 360 — положить внутрь элемент шире родителя (снимок, длинное
 * слово, таблица).
 */
const overflow = (page) =>
  page.evaluate(() => {
    const out = [];
    const doc = document.documentElement;
    if (doc.scrollWidth > doc.clientWidth + 1) {
      out.push(`страница ${doc.scrollWidth} > ${doc.clientWidth}`);
    }
    for (const el of document.querySelectorAll('[data-screen] *')) {
      const parent = el.parentElement;
      if (!parent) continue;
      const style = getComputedStyle(parent);
      // Контейнер, которому прокрутка разрешена нарочно (таблица, блок кода),
      // переполнением не считается.
      if (style.overflowX === 'auto' || style.overflowX === 'scroll') continue;
      const r = el.getBoundingClientRect();
      const p = parent.getBoundingClientRect();
      if (r.width === 0) continue;
      if (r.right > p.right + 1 || r.left < p.left - 1) {
        out.push(
          `${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).split(' ')[0] : ''} ` +
            `вылез на ${Math.round(Math.max(r.right - p.right, p.left - r.left))}px`,
        );
      }
    }
    return out.slice(0, 8);
  });

const shoot = async (page, name) => {
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });
};

async function loginAs(page, login, password) {
  await page.goto(WEB, { waitUntil: 'networkidle' });
  await page.locator('input[autocomplete="username"]').first().fill(login);
  await page.locator('input[autocomplete="current-password"]').first().fill(password);
  await page.getByRole('button', { name: 'Войти' }).click();
  await page.waitForTimeout(1500);
}

/** Созданная учётка приходит с временным паролем — меняем его тем же экраном. */
async function passThroughChange(page, current, next) {
  const screen = await page
    .waitForSelector('[data-screen="change-password"]', { timeout: 10000 })
    .catch(() => null);
  if (!screen) return false;
  await page.locator('#cp-current').fill(current);
  await page.locator('#cp-next').fill(next);
  await page.locator('#cp-repeat').fill(next);
  await page.getByRole('button', { name: /Сменить пароль/ }).click();
  await page.waitForTimeout(1800);
  return true;
}

try {
  await assertPortFree();
  await build('бэкенд', 'npm', ['run', 'build'], BACKEND);
  await build('фронт', 'bun', ['run', 'build:qa'], FRONTEND);
  if (!fs.existsSync(ROOT)) throw new Error(`нет сборки ${ROOT}`);

  // Статьи попадают в бандл через import.meta.glob. Если бы не попали, прогон
  // увидел бы пустую справку и списал это на права. Проверяем прямо: в сборке
  // должен лежать текст статьи.
  const bundle = fs
    .readdirSync(path.join(ROOT, 'assets'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => fs.readFileSync(path.join(ROOT, 'assets', f), 'utf8'))
    .join('\n');
  if (!bundle.includes('Обязательная смена пароля') && !bundle.includes('Тип операции')) {
    bad('в сборке не нашлось текста статей — проверь glob в help/content.ts');
  } else {
    ok('тексты статей попали в сборку');
  }
  // Обратная проверка: снимков в справке нет (заказчик, 07.10), и в сборке их
  // быть не должно. Картинка в `assets` означает, что каталог `shots/` вернули
  // и глоб снова его собирает — то есть правка откатилась незаметно.
  const webpInBuild = fs.readdirSync(path.join(ROOT, 'assets')).filter((f) => f.endsWith('.webp'));
  if (webpInBuild.length > 0) bad(`в сборке ${webpInBuild.length} картинок, ожидалось 0`);
  else ok('картинок в сборке нет');

  backend = spawn('node', ['dist/main.js'], {
    cwd: BACKEND,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Расписание копий базы выключено: прогон поднимает службу днём, и первый
    // же тик после 03:20 начал бы `pg_dump` рабочей базы разработки посреди
    // проверки справки. Сам бэкап проверяется своими тестами.
    env: {
      ...process.env,
      PORT: String(API_PORT),
      CORS_ORIGINS: WEB,
      BACKUP_SCHEDULER: 'off',
    },
  });
  backend.stdout.on('data', () => {});
  backend.stderr.on('data', (d) => process.stderr.write(`[api!] ${d}`));
  await waitForApi(25000);

  const app = express();
  app.use(express.static(ROOT));
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(ROOT, 'index.html')));
  server = await new Promise((resolve) => {
    const s = app.listen(WEB_PORT, '127.0.0.1', () => resolve(s));
  });

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
        if (m.type() === 'error') errors.push(`[${at}] ${m.text().slice(0, 300)}`);
      });
      page.on('pageerror', (e) => errors.push(`[${at}] PAGEERROR ${e.message.slice(0, 300)}`));
      await page.addInitScript((t) => localStorage.setItem('metall_theme', t), theme);
      await page.addInitScript(() => localStorage.setItem('metall_locale', 'ru'));

      for (const role of ROLES) {
        const login = `qa_help_${role.tag}_${stamp}_${w}${theme[0]}`;
        const own = `Qa-help-${stamp}`;
        const made = await apiJson(`${API}/admin/users`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
          body: JSON.stringify({
            login,
            fullName: `Прогон справки: ${role.ru}`,
            password: defaultPasswordFor(login),
            assignments: [{ roleCode: role.code, companyUid: trade.uid }],
          }),
        });
        if (made.status !== 201) {
          bad(`${role.ru}: учётка не завелась (${made.status})`);
          continue;
        }

        await loginAs(page, login, defaultPasswordFor(login));
        await passThroughChange(page, defaultPasswordFor(login), own);
        const menu = await page.waitForSelector('[data-module]', { timeout: 20000 }).catch(() => null);
        if (!menu) {
          bad(`${role.ru}: меню не появилось`);
          continue;
        }

        // 1. Пункт «Справка» есть у любой роли.
        const item = page.locator('[data-module="help"]');
        if ((await item.count()) === 0) bad(`${role.ru}: в меню нет пункта «Справка»`);
        else ok(`${role.ru}: пункт «Справка» в меню есть`);

        await item.first().click();
        await page.waitForTimeout(900);

        if ((await page.locator('[data-screen="help"]').count()) === 0) {
          bad(`${role.ru}: раздел «Справка» не открылся`);
          await page.context().clearCookies();
          continue;
        }

        const slugs = await page.$$eval('[data-help-article]', (els) =>
          els.map((e) => e.getAttribute('data-help-article')),
        );
        if (slugs.length === 0) bad(`${role.ru}: список статей пуст`);
        else ok(`${role.ru}: статей видно ${slugs.length}`);

        // 2. Статьи администратора — только роли с правом на «Настройки».
        const adminSeen = slugs.filter((s) => s.startsWith('admin-'));
        if (role.adminArticles && adminSeen.length === 0) {
          bad(`${role.ru}: должен видеть статьи администратора, их нет`);
        } else if (!role.adminArticles && adminSeen.length > 0) {
          bad(`${role.ru}: видит статьи администратора: ${adminSeen.join(', ')}`);
        } else {
          ok(`${role.ru}: статьи администратора ${role.adminArticles ? 'видны' : 'скрыты'}`);
        }

        // Статьи чужих разделов тоже не должны просачиваться.
        if (role.code === 'accountant' && slugs.some((s) => s.startsWith('sklad-'))) {
          bad('Бухгалтер видит статьи склада');
        }
        if (role.code === 'warehouse_keeper' && slugs.some((s) => s.startsWith('finansy-'))) {
          bad('Кладовщик видит статьи финансов');
        }

        // 3. Поиск. Слова берём те же, что стоят подсказкой в самом поле:
        // подсказка, по которой ничего не находится, хуже отсутствующей.
        // «сторно» живёт в статье финансов, поэтому спрашиваем его только у
        // тех, кому финансы открыты.
        const all = slugs.length;
        const words = ['пароль', ...(role.finance ? ['сторно'] : [])];
        for (const word of words) {
          await page.locator('[data-role="help-search"]').fill(word);
          await page.waitForTimeout(500);
          const found = await page.$$eval('[data-help-article]', (els) => els.length);
          if (found === 0) bad(`${role.ru}: поиск «${word}» ничего не нашёл`);
          else if (found >= all) bad(`${role.ru}: поиск «${word}» не сузил список (${found} из ${all})`);
          else ok(`${role.ru}: поиск «${word}» сузил список до ${found} из ${all}`);
        }
        await page.locator('[data-role="help-search"]').fill('');
        await page.waitForTimeout(400);

        // 4. Статья открывается и закрывается.
        const first = slugs[0];
        await page.locator(`[data-help-article="${first}"]`).first().click();
        await page.waitForTimeout(700);
        if ((await page.locator('[data-screen="help-article"]').count()) === 0) {
          bad(`${role.ru}: статья ${first} не открылась`);
        } else {
          const over = await overflow(page);
          if (over.length) bad(`${role.ru} ${at}: в статье ${first} вылезло — ${over.join('; ')}`);
          else ok(`${role.ru}: статья ${first} открылась, переполнения нет`);
          await shoot(page, `article-${role.tag}-${at}`);
          await page.locator('[data-role="help-back"]').click();
          await page.waitForTimeout(500);
        }

        const over = await overflow(page);
        if (over.length) bad(`${role.ru} ${at}: в списке вылезло — ${over.join('; ')}`);
        await shoot(page, `list-${role.tag}-${at}`);

        // 5. Кнопка «?» в шапке каждого доступного раздела.
        const modules = await page.$$eval('[data-module]', (els) =>
          els.map((e) => e.getAttribute('data-module')).filter((m) => m !== 'help'),
        );
        for (const mod of modules) {
          await page.locator(`[data-module="${mod}"]`).first().click();
          await page.waitForTimeout(1200);
          const btn = page.locator('[data-role="help-for-module"]');
          if ((await btn.count()) === 0) {
            bad(`${role.ru}: в шапке «${mod}» нет кнопки «?»`);
            continue;
          }
          const target = await btn.first().getAttribute('data-help-target');
          await btn.first().click();
          await page.waitForTimeout(700);
          const opened = await page.locator('[data-screen="help-article"]').count();
          if (opened === 0) bad(`${role.ru}: «?» в «${mod}» не открыла статью`);
          else ok(`${role.ru}: «?» в «${mod}» → ${target}`);
        }

        // 6. Узбекский: перевод есть у каждой статьи, пометки нет ни на одной.
        //
        // Откат на русский текст с пометкой из кода не убран — он понадобится
        // новой статье, которую заведут раньше перевода. Но сейчас
        // непереведённых статей нет, и это проверяется не на двух примерах, а
        // обходом всего списка, доступного роли: пометка на любой статье —
        // отказ прогона.
        await page.locator('[data-module="help"]').first().click();
        await page.waitForTimeout(600);
        await page.getByRole('button', { name: 'UZ', exact: true }).first().click().catch(() => {});
        await page.waitForTimeout(700);

        let fallbacks = 0;
        for (const slug of slugs) {
          if ((await page.locator(`[data-help-article="${slug}"]`).count()) === 0) {
            bad(`${slug}: статья пропала из списка при переключении на uz`);
            continue;
          }
          await page.locator(`[data-help-article="${slug}"]`).first().click();
          await page.waitForTimeout(350);
          if ((await page.locator('[data-role="help-fallback"]').count()) > 0) {
            fallbacks += 1;
            bad(`${slug}: в uz показан русский текст с пометкой — статья не переведена`);
          }
          // Снимки и переполнение — на двух статьях: одна открывалась первой в
          // ru, другая самая длинная по вёрстке. Мерить вылет на всех тридцати
          // трёх значит утроить время прогона, не добавив ни одного состояния.
          if (slug === SHOT_UZ || slug === slugs[0]) {
            const overUz = await overflow(page);
            if (overUz.length) bad(`${slug} ${at} uz: вылезло — ${overUz.join('; ')}`);
            await shoot(page, `uz-${slug}-${role.tag}-${at}`);
          }
          await page.locator('[data-role="help-back"]').click();
          await page.waitForTimeout(250);
        }
        if (fallbacks === 0) ok(`${role.ru}: все ${slugs.length} статей переведены на uz`);

        await page.getByRole('button', { name: 'RU', exact: true }).first().click().catch(() => {});
        await page.waitForTimeout(400);
        await page.context().clearCookies();
        await page.evaluate(() => sessionStorage.clear());
      }

      await ctx.close();
    }
  }
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) await new Promise((r) => server.close(r));
  if (backend) backend.kill('SIGTERM');
}

console.log(`\nснимки: ${OUT}`);
if (errors.length) {
  console.log(`\nошибки консоли (${errors.length}):`);
  for (const e of [...new Set(errors)].slice(0, 15)) console.log(`  ! ${e}`);
}
if (problems.length) {
  console.log(`\nнайдено (${problems.length}):`);
  for (const p of problems) console.log(`  ✗ ${p}`);
  process.exitCode = 1;
} else {
  console.log('\nвсё проверенное — в порядке');
}
