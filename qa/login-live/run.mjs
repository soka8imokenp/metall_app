/**
 * Экран входа против живого бэкенда: короткий пароль проходит весь путь.
 *
 * Зачем прогон. Длина пароля была зашита в двух местах — `@MinLength(6)` в
 * `LoginDto` и `password.length < 6` в кнопке `LoginScreen`. Учётка с коротким
 * паролем при правильном хеше в базе войти не могла: форма не давала нажать,
 * а API отбивал 400 ещё до сверки. Тест в `dashboard.e2e.spec.ts` держит
 * серверную половину, этот прогон — клиентскую и их стык.
 *
 * Перед запуском собрать фронт с живым API:
 *   cd dev/frontend && bun run build:qa
 *
 * Запуск:
 *   cd dev/qa && bun run login-live
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
/** Пять знаков: ровно тот случай, который запирала прежняя проверка длины. */
const SHORT = 'admin';
/** Логин, которого нет: заявку на сброс принимают и на выдуманный. */
const GHOST = `qa-reset-${String(Date.now()).slice(-6)}`;

fs.mkdirSync(OUT, { recursive: true });

const problems = [];
const errors = [];
let backend;
let server;
let browser;

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

const loginButton = (page) => page.getByRole('button', { name: 'Войти' });

/**
 * Светлота цвета от 0 до 1. Tailwind 4 отдаёт цвета в `oklch`, но браузер
 * может вернуть и `rgb` — считаем оба, иначе проверка сломается не от
 * дефекта, а от формы записи.
 */
const lightness = (color) => {
  const ok = color.match(/^oklch\(\s*([\d.]+)/);
  if (ok) return Number(ok[1]);
  const rgb = color.match(/^rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
  if (!rgb) return null;
  const [r, g, b] = rgb.slice(1, 4).map((v) => Number(v) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const borderOf = (page) =>
  loginButton(page).evaluate((el) => {
    const st = getComputedStyle(el);
    return { width: st.borderTopWidth, color: st.borderTopColor };
  });
const loginField = (page) =>
  page.getByLabel('Логин').or(page.locator('input[autocomplete="username"]')).first();
const passField = (page) => page.locator('input[autocomplete="current-password"]').first();

try {
  if (!fs.existsSync(ROOT)) {
    throw new Error(`нет сборки ${ROOT} — сначала cd ../frontend && bun run build:qa`);
  }
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
  backend.stdout.on('data', (d) => process.stdout.write(`[api] ${d}`));
  backend.stderr.on('data', (d) => process.stderr.write(`[api!] ${d}`));

  const status = await waitForApi(20000);
  console.log(`бэкенд отвечает, /dashboard/summary без токена → ${status}`);

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
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const text = m.text();
      if (expect401 && text.includes('401')) return;
      errors.push(`[${tag}] ${text.slice(0, 300)}`);
    });
    page.on('pageerror', (e) => errors.push(`[${tag}] PAGEERROR ${e.message.slice(0, 300)}`));

    const statuses = [];
    page.on('response', (r) => {
      if (r.url().includes('/auth/login')) statuses.push(r.status());
    });

    // Неверный пароль отправляется здесь нарочно, и браузер честно пишет в
    // консоль «401 Unauthorized». Это ожидаемый ответ проверяемого пути,
    // а не находка: на время шага консоль не считаем.
    let expect401 = false;

    await page.goto('http://127.0.0.1:4321/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);

    // 0. Оформление входа: знак, название, фон, два языка, две темы.
    //
    // Название на экране — картинка с их шрифтом, а не набранный текст,
    // поэтому ищем его по доступному имени: пропадёт файл — пропадёт и имя.
    if (!(await page.getByRole('img', { name: 'METALL ASIA' }).count())) {
      problems.push(`${tag}: на входе нет названия компании METALL ASIA`);
    }
    if (!(await page.locator('img[src*="metall-asia-mark"]').count())) {
      problems.push(`${tag}: на входе нет знака компании`);
    }
    // Фон обязан быть один из двух: волны на WebGL или неподвижная замена.
    // Пустой экран без обоих — это упавший фон, и молчать о нём нельзя.
    const backdrop = await page.evaluate(() => {
      const c = document.querySelector('canvas');
      const still = document.querySelector('[class*="radial-gradient"]');
      return { canvas: c ? [c.width, c.height] : null, still: !!still };
    });
    if (!backdrop.canvas && !backdrop.still) {
      problems.push(`${tag}: фона входа нет вовсе — ни волн, ни замены`);
    }
    if (backdrop.canvas && (backdrop.canvas[0] < 10 || backdrop.canvas[1] < 10)) {
      problems.push(`${tag}: холст волн схлопнулся в ${backdrop.canvas.join('×')}`);
    }

    // Узбекский: переключатель на экране входа, а не только внутри системы.
    // Нет самого переключателя — говорим об этом и не виснем в ожидании
    // клика: одна находка не должна прятать остальные.
    const lang = async (code) => {
      const btn = page.getByRole('button', { name: code, exact: true });
      if (!(await btn.count())) {
        problems.push(`${tag}: на входе нет переключателя языка (${code})`);
        return false;
      }
      await btn.click();
      await page.waitForTimeout(400);
      return true;
    };

    if (await lang('UZ')) {
      const uz = await page.locator('body').innerText();
      for (const need of ['Parol', 'Kirish', 'Yagona boshqaruv tizimi']) {
        if (!uz.includes(need)) problems.push(`${tag}: по-узбекски нет «${need}»`);
      }
      // Подписи полей набраны капителью через CSS, и `innerText` отдаёт их
      // прописными: искать «Пароль» здесь бессмысленно. Смотрим на строки,
      // которые регистр не меняет.
      if (/Войти|Единая система управления/.test(uz)) {
        problems.push(`${tag}: по-узбекски остался русский текст`);
      }
      await page.screenshot({ path: `${OUT}/login-uz-${tag}.png`, fullPage: true });
      if (await lang('RU')) {
        if (!(await page.locator('body').innerText()).includes('Единая система управления')) {
          problems.push(`${tag}: обратно на русский не переключается`);
        }
      }
    }

    // Тема: на входе её меняют до входа в систему, значит кнопка здесь нужна.
    const isDark = () => page.evaluate(() => document.documentElement.classList.contains('dark'));
    const themeBtn = page.getByRole('button', { name: /тему$/ });
    const hasTheme = (await themeBtn.count()) > 0;
    if (!hasTheme) problems.push(`${tag}: на входе нет кнопки смены темы`);
    if (hasTheme) {
      const before = await isDark();
      await themeBtn.click();
      await page.waitForTimeout(500);
      if ((await isDark()) === before) problems.push(`${tag}: тема с входа не переключается`);
      // Обводка кнопки входа идёт в цвет противоположной темы.
      const darkBorder = await borderOf(page);
      if (parseFloat(darkBorder.width) < 0.5) {
        problems.push(`${tag}: у кнопки «Войти» нет обводки (${darkBorder.width})`);
      } else if ((lightness(darkBorder.color) ?? 0) < 0.9) {
        problems.push(`${tag}: в тёмной теме обводка не белая: ${darkBorder.color}`);
      }
      await page.screenshot({ path: `${OUT}/login-dark-${tag}.png`, fullPage: true });
    }
    const over = await page.evaluate(() => {
      const d = document.documentElement;
      const bad = [];
      document.querySelectorAll('*').forEach((el) => {
        if (el.scrollWidth - el.clientWidth > 1 && el.clientWidth > 0) {
          const st = getComputedStyle(el);
          if (['auto', 'scroll'].includes(st.overflowX)) bad.push((el.className || '').toString().slice(0, 40));
        }
      });
      return { page: d.scrollWidth - d.clientWidth, bad };
    });
    if (over.page || over.bad.length) {
      problems.push(`${tag}: вход уезжает вбок ${JSON.stringify(over)}`);
    }
    if (hasTheme) {
      await themeBtn.click();
      await page.waitForTimeout(400);
    }

    // 0а. Появление не должно быть рывком: длительность общая, смотрим её.
    const riseDur = await page
      .locator('.rise')
      .first()
      .evaluate((el) => getComputedStyle(el).animationDuration)
      .catch(() => '0s');
    if (parseFloat(riseDur) < 0.5) {
      problems.push(`${tag}: появление резкое — ${riseDur}, ждали не меньше 0.5s`);
    }

    // 0б. «Забыли пароль» — заявка, а не сброс.
    //
    // Проверяется и то, что форма есть, и то, что она отвечает одинаково на
    // выдуманный логин: иначе она рассказывала бы, какие учётки существуют.
    const forgot = page.getByRole('button', { name: 'Забыли пароль?' });
    if (!(await forgot.count())) {
      problems.push(`${tag}: на входе нет «Забыли пароль?»`);
    } else {
      await forgot.click();
      await page.waitForTimeout(400);
      if (!(await page.locator('body').innerText()).includes('Восстановление доступа')) {
        problems.push(`${tag}: «Забыли пароль?» не открывает форму заявки`);
      }
      await loginField(page).fill(`${GHOST}-${tag}`);
      await page.getByPlaceholder('Телефон или почта').fill('+998 90 000-00-00');
      await page.getByRole('button', { name: 'Отправить заявку' }).click();
      await page.waitForTimeout(1800);
      const sent = await page.locator('body').innerText();
      if (!sent.includes('Заявка принята')) {
        problems.push(`${tag}: заявка на выдуманный логин не принята: «${sent.slice(0, 120)}»`);
      }
      await page.screenshot({ path: `${OUT}/login-reset-sent-${tag}.png`, fullPage: true });
      await page.getByRole('button', { name: /Вернуться ко входу/ }).click();
      await page.waitForTimeout(400);
      if (!(await passField(page).count())) {
        problems.push(`${tag}: со страницы заявки нет дороги обратно ко входу`);
      }
      await loginField(page).fill('');
    }

    // 1. Пустой пароль кнопку не включает.
    await loginField(page).fill(LOGIN);
    if (!(await loginButton(page).isDisabled())) {
      problems.push(`${tag}: кнопка «Войти» доступна с пустым паролем`);
    }

    // 2. Пять знаков — кнопка должна включиться.
    await passField(page).fill(SHORT);
    await page.waitForTimeout(150);
    if (await loginButton(page).isDisabled()) {
      problems.push(`${tag}: кнопка «Войти» заперта пятисимвольным паролем`);
    }
    await page.screenshot({ path: `${OUT}/short-password-${tag}.png`, fullPage: true });

    // 2а. Обводка в светлой теме — тёмная.
    const lightBorder = await borderOf(page);
    if (parseFloat(lightBorder.width) < 0.5) {
      problems.push(`${tag}: у кнопки «Войти» нет обводки (${lightBorder.width})`);
    } else if ((lightness(lightBorder.color) ?? 1) > 0.35) {
      problems.push(`${tag}: в светлой теме обводка не тёмная: ${lightBorder.color}`);
    }

    // 2б. Кнопка входа под курсором заливается красным знака.
    //
    // Слой рисуется только на живой кнопке, поэтому проверка стоит здесь —
    // после заполнения полей, а не на пустой форме.
    const fill = page.locator('button[type="submit"] span[aria-hidden="true"]').first();
    if (!(await fill.count())) {
      problems.push(`${tag}: у кнопки «Войти» нет слоя заливки`);
    } else {
      const before = await fill.evaluate((el) => getComputedStyle(el).opacity);
      if (Number(before) > 0.01) problems.push(`${tag}: заливка кнопки видна без наведения`);
      await loginButton(page).hover();
      await page.waitForTimeout(700);
      const after = await fill.evaluate((el) => {
        const st = getComputedStyle(el);
        return { o: st.opacity, color: st.backgroundColor, dur: st.transitionDuration };
      });
      if (Number(after.o) < 0.99) {
        problems.push(`${tag}: кнопка «Войти» под курсором не заливается (${after.o})`);
      }
      // Тон знака, а не «какой-то красный»: цвет снят с их логотипа.
      if (after.color !== 'rgb(206, 31, 60)') {
        problems.push(`${tag}: заливка не цвета знака: ${after.color}`);
      }
      if (parseFloat(after.dur) < 0.2) {
        problems.push(`${tag}: заливка мгновенная (${after.dur}), а не плавная`);
      }
      await page.mouse.move(5, 5);
      await page.waitForTimeout(400);
    }

    // 3. Запрос уходит и получает 401 — судят хеш, а не длину.
    // Клик с коротким таймаутом: на запертой кнопке прогон должен назвать
    // находку и идти дальше, а не умирать в ожидании на две минуты.
    expect401 = true;
    await loginButton(page)
      .click({ timeout: 5000 })
      .catch(() => problems.push(`${tag}: по кнопке «Войти» не удалось нажать с коротким паролем`));
    await page.waitForTimeout(1500);
    const short = statuses.at(-1);
    console.log(`[${tag}] короткий пароль → ${short ?? 'запроса не было'}`);
    if (short === undefined) problems.push(`${tag}: запрос на /auth/login не ушёл`);
    else if (short === 400) problems.push(`${tag}: /auth/login отбил короткий пароль 400`);
    else if (short !== 401) problems.push(`${tag}: ждали 401 на неверный короткий пароль, получили ${short}`);
    const shown = await page.locator('body').innerText();
    if (!shown.includes('Неверный логин или пароль')) {
      problems.push(`${tag}: на экране нет сообщения об ошибке входа`);
    }
    // Ошибка хранится ключом, а не готовой строкой: человек, переключивший
    // язык после отказа, должен прочитать отказ на своём языке.
    if (await lang('UZ')) {
      if (!(await page.locator('body').innerText()).includes('Login yoki parol')) {
        problems.push(`${tag}: отказ входа остался по-русски после перехода на узбекский`);
      }
      await lang('RU');
    }
    await page.screenshot({ path: `${OUT}/short-password-rejected-${tag}.png`, fullPage: true });

    // 4. Регрессия: настоящий пароль по-прежнему пускает внутрь.
    expect401 = false;
    await passField(page).fill(PASSWORD);
    await loginButton(page).click();
    try {
      await page.waitForSelector('text=/Выручка/', { state: 'attached', timeout: 15000 });
    } catch {
      problems.push(`${tag}: вход настоящим паролем больше не работает (статус ${statuses.at(-1)})`);
      await page.screenshot({ path: `${OUT}/FAIL-real-password-${tag}.png`, fullPage: true });
    }
    console.log(`[${tag}] настоящий пароль → ${statuses.at(-1)}`);

    // 5. Сессия старше пересева данных.
    //
    // Пересев пересоздаёт компании, и их uid меняются. Открытая вкладка
    // держит в `sessionStorage` прежние: токен ещё годен, а заголовок
    // X-Company-Id указывает на компанию, которой больше нет, — сервер
    // отвечает 403. Снаружи это выглядит как «показатели не загрузились»
    // при выборе одной компании и рабочий экран при «всех»: без заголовка
    // запрос проходит. Лечиться перелогином человек не обязан — сессию
    // сверяем с сервером при восстановлении.
    const stale = await page.evaluate(() => {
      const raw = sessionStorage.getItem('metall_session');
      if (!raw) return false;
      const session = JSON.parse(raw);
      session.companies = session.companies.map((c, i) => ({
        ...c,
        uid: `00000000-0000-4000-8000-00000000000${i}`,
      }));
      sessionStorage.setItem('metall_session', JSON.stringify(session));
      return true;
    });
    if (!stale) {
      problems.push(`${tag}: сессия не сохранилась — проверить протухшие uid не на чем`);
    } else {
      const forbidden = [];
      const onResponse = (r) => {
        if (r.url().includes('/api/v1/') && r.status() === 403) {
          forbidden.push(new URL(r.url()).pathname);
        }
      };
      page.on('response', onResponse);
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForTimeout(2500);

      const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
      const broken = body.includes('Показатели не загрузились') || body.includes('yuklanmadi');
      const asked = await page.locator('input[autocomplete="current-password"]').count();
      console.log(
        `[${tag}] старые uid компаний: экран ${broken ? 'сломан' : asked ? 'просит войти' : 'работает'}` +
          `, 403 на ${forbidden.length} запросах`,
      );
      if (broken) {
        problems.push(
          `${tag}: с протухшими uid компаний дашборд показывает «Показатели не загрузились» вместо данных`,
        );
        await page.screenshot({ path: `${OUT}/FAIL-stale-company-${tag}.png`, fullPage: true });
      }
      page.off('response', onResponse);
    }

    await ctx.close();
  }

  // --- 6. Заявки видит администратор, и только он -------------------------
  //
  // Это вторая половина «забыли пароль»: без места, где заявку читают и
  // закрывают, форма была бы ящиком без дна.
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`[очередь] PAGEERROR ${e.message.slice(0, 200)}`));
    await page.goto('http://127.0.0.1:4321/', { waitUntil: 'networkidle' });

    // Директор: прав `admin.*` у него нет. С 06.10 сайдбар закрытых разделов
    // не рисует вовсе, поэтому проверяем сначала отсутствие самой кнопки —
    // раньше она была у всех, и вкладку заявок закрывал только сервер.
    await loginField(page).fill(LOGIN);
    await passField(page).fill(PASSWORD);
    await loginButton(page).click();
    await page.waitForSelector('text=/Выручка/', { state: 'attached', timeout: 15000 });
    if (await page.locator('[data-module="admin"]').count()) {
      problems.push('очередь: директору видна кнопка «Настройки», хотя прав admin.* у него нет');
      await page.locator('[data-module="admin"]').first().click();
      await page.waitForTimeout(1200);
      if ((await page.locator('body').innerText()).includes('Заявки на пароль')) {
        problems.push('очередь: вкладка заявок видна директору, у которого нет admin.users');
      }
    }

    // Администратор: вкладка есть, заявки прогона в ней лежат, закрываются.
    await ctx.clearCookies();
    await page.evaluate(() => sessionStorage.clear());
    await page.goto('http://127.0.0.1:4321/', { waitUntil: 'networkidle' });
    await loginField(page).fill('admin');
    await passField(page).fill(PASSWORD);
    await loginButton(page).click();
    await page.waitForSelector('text=/Выручка/', { state: 'attached', timeout: 15000 });
    await page.getByRole('button', { name: 'Настройки' }).first().click();
    await page.waitForTimeout(1000);
    const tab = page.getByRole('tab', { name: 'Заявки на пароль' });
    if (!(await tab.count())) {
      problems.push('очередь: у администратора нет вкладки «Заявки на пароль»');
    } else {
      await tab.click();
      await page.waitForTimeout(1500);
      const queue = page.locator('li', { hasText: GHOST }).first();
      if (!(await queue.count())) {
        problems.push('очередь: заявки прогона нет в списке администратора');
      } else {
        const text = await queue.innerText();
        // Разбирающий обязан видеть, что такой учётки нет: заявку принимают
        // на любой набранный логин.
        if (!text.includes('такой учётки нет')) {
          problems.push('очередь: не сказано, что учётки с таким логином нет');
        }
        await page.screenshot({ path: `${OUT}/admin-reset-queue.png`, fullPage: true });
        // Заявок столько, сколько ширин прошёл прогон: закрываем все свои,
        // иначе следующий запуск найдёт чужие и решит, что закрытие не идёт.
        for (let i = 0; i < 5; i++) {
          const row = page.locator('li', { hasText: GHOST }).first();
          if (!(await row.count())) break;
          await row.getByRole('button', { name: 'Закрыть заявку' }).click();
          await page.waitForTimeout(300);
          // Кнопка переименована 06.10: пароль теперь выдаёт система, а не
          // разбирающий. На выдуманный логин пароля не выдаётся — учётки нет.
          await row.getByRole('button', { name: 'Сбросить пароль' }).click();
          await page.waitForTimeout(1500);
        }
        if (await page.locator('li', { hasText: GHOST }).count()) {
          problems.push('очередь: закрытая заявка осталась в списке «в очереди»');
        }
      }
    }
    await ctx.close();
  }

  fs.writeFileSync(`${OUT}/console-errors.txt`, (errors.join('\n') || 'нет') + '\n');
  console.log('--- ошибки консоли ---');
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
}
