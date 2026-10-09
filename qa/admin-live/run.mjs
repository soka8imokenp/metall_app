/**
 * Прогон экрана «Настройки» на живом стенде (ТЗ 3.3, 3.4).
 *
 * Проверяется то, ради чего этап делался: вкладки стоят на живом API, а не на
 * выдуманных данных; матрица прав пишется и переживает перезагрузку; человек
 * заводится из интерфейса; журнал действий показывает «было → стало»;
 * журнал входов называет причину отказа словами.
 *
 * Прогон пишет на стенде: заводит учётку с меткой времени и выключает её за
 * собой, право роли ставит и возвращает обратно. Удалить учётку нельзя —
 * у системы такого действия нет, и это сознательно.
 */
import { chromium } from 'playwright-core';
import { standLogin, standPassword } from '../stand-credentials.mjs';

const STAND = process.env.STAND_URL ?? 'https://metall-asia.cloudplus.uz';
const OUT = new URL('./shots/', import.meta.url).pathname;
// Служебная учётка прогонов, а не `admin`: за админом с 06.10 обязательная
// смена пароля (`qa/stand-credentials.mjs`).
const LOGIN = standLogin();
const PASSWORD = standPassword();
const stamp = Date.now().toString().slice(-6);

const errors = [];
const notes = [];

const login = async (page, user = LOGIN, pass = PASSWORD) => {
  await page.goto(STAND, { waitUntil: 'networkidle' });
  await page.locator('input[autocomplete="username"]').first().fill(user);
  await page.locator('input[autocomplete="current-password"]').first().fill(pass);
  await page.getByRole('button', { name: 'Войти' }).click();
  await page.waitForTimeout(2500);
};

/**
 * Раздел открывается кнопкой «Настройки» — в развёрнутом меню надписью, в
 * свёрнутом (360 и вручную свёрнутое на 1440) значком с тем же названием.
 * Прогон жмёт по названию, поэтому проверяет заодно, что кнопка есть в обоих
 * состояниях меню.
 */
const openAdmin = async (page) => {
  await page.getByRole('button', { name: 'Настройки', exact: true }).first().click();
  await page.waitForTimeout(1500);
};

/**
 * Переход на вкладку. Нет её — это находка, а не падение прогона: упавший
 * прогон сообщает «таймаут», а не «вкладки нет», и разбирать его приходится
 * руками.
 */
const tab = async (page, name) => {
  const btn = page.getByRole('tab', { name }).first();
  if (!(await btn.count())) return false;
  await btn.click();
  await page.waitForTimeout(1800);
  return true;
};

/** Что уехало за край: ширина содержимого больше ширины самого блока. */
const overflow = (page) =>
  page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('main *')) {
      if (el.scrollWidth - el.clientWidth > 2 && el.clientWidth > 0) {
        const style = getComputedStyle(el);
        if (style.overflowX === 'visible') {
          out.push(`${el.tagName.toLowerCase()}.${el.className.toString().slice(0, 40)}`);
        }
      }
    }
    return { page: document.documentElement.scrollWidth > window.innerWidth + 2, bleed: out.slice(0, 3) };
  });

const browser = await chromium.launch({ channel: 'chromium' });

// --- вёрстка и наполнение: все четыре сочетания ------------------------------
for (const theme of ['light', 'dark']) {
  for (const [w, h] of [[1440, 900], [360, 800]]) {
    const tag = `${theme}/${w}`;
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    await ctx.addInitScript((t) => localStorage.setItem('metall_theme', t), theme);
    const page = await ctx.newPage();
    const ce = [];
    page.on('console', (m) => { if (m.type() === 'error') ce.push(m.text().slice(0, 160)); });
    page.on('pageerror', (e) => ce.push('pageerror: ' + String(e).slice(0, 160)));

    try {
    await login(page);
    await openAdmin(page);

    // 1. Вкладки: пять, и все называются по-человечески.
    const tabs = await page.getByRole('tab').allInnerTexts();
    notes.push(`[${tag}] вкладки: ${tabs.join(' | ')}`);
    for (const want of ['Люди', 'Роли и права', 'Валюты и курсы', 'Журнал действий', 'Журнал входов', 'Заявки на пароль']) {
      if (!tabs.some((t) => t.includes(want))) {
        errors.push(`[${tag}] нет вкладки «${want}» (есть: ${tabs.join(', ') || 'ни одной'})`);
      }
    }
    if (tabs.some((t) => /RBAC|Audit Trail/i.test(t))) {
      errors.push(`[${tag}] вкладка называется языком разработчика: ${tabs.join(', ')}`);
    }

    // 1б. Полоса вкладок объявлена по стандарту: роли `tab` нужен родитель
    // `tablist`, а состояние она сообщает через `aria-selected` — на кнопке
    // стоял `aria-pressed`, роли `tab` не положенный, и открытая вкладка
    // диктору не называлась.
    const tablists = await page.locator('[role="tablist"]').count();
    if (tablists !== 1) {
      errors.push(`[${tag}] полоса вкладок не объявлена как tablist (найдено ${tablists})`);
    }
    const selected = await page.locator('[role="tab"][aria-selected="true"]').allInnerTexts();
    if (selected.length !== 1) {
      errors.push(
        `[${tag}] открытой вкладкой помечено ${selected.length} вместо одной (aria-selected)`,
      );
    }
    if (await page.locator('[role="tab"][aria-pressed]').count()) {
      errors.push(`[${tag}] на вкладке остался aria-pressed — для роли tab он недопустим`);
    }
    if (!(await page.locator('[role="tabpanel"]').count())) {
      errors.push(`[${tag}] содержимое вкладки не объявлено как tabpanel`);
    }

    // 1в. Список людей говорит, сколько показано из скольких. Он обрезался
    // пределом молча: `total` сервер считал, а экран его не показывал — за
    // сотой учёткой администратор не узнал бы, что есть ещё.
    const shown = (await page.locator('main').innerText()).match(
      /показано (\d+) из (\d+)|(\d+) dan (\d+) ko‘rsatildi/,
    );
    if (!shown) {
      errors.push(`[${tag}] список людей не говорит, сколько показано из скольких`);
    }

    // 2. Люди: живой список, в нём есть сам администратор с ролью и компанией.
    if (!(await tab(page, 'Люди'))) {
      errors.push(`[${tag}] вкладки «Люди» нет — дальше по этому сочетанию не проверяю`);
      if (ce.length) errors.push(`[${tag}] ошибки в консоли: ${ce.join(' | ')}`);
      await ctx.close();
      continue;
    }
    const people = await page.locator('ul li').allInnerTexts();
    notes.push(`[${tag}] людей в списке: ${people.length}`);
    const self = people.find((t) => t.includes('admin'));
    if (!self) {
      errors.push(`[${tag}] в списке людей нет учётки admin`);
    } else {
      if (!/Администратор/.test(self)) {
        errors.push(`[${tag}] у admin не показана роль: «${self.replace(/\s+/g, ' ').slice(0, 90)}»`);
      }
      // Названия юрлиц - настоящие, из устава: «METALL ASIA» так называется
      // только бренд и стенд, ни одна компания в базе так не зовётся.
      if (!/ООО «(Металл Азия|Ташкентский изоляционный завод)»/.test(self)) {
        errors.push(`[${tag}] у admin не показана компания: «${self.replace(/\s+/g, ' ').slice(0, 90)}»`);
      }
      if (!/последний вход/.test(self)) {
        errors.push(`[${tag}] у admin нет последнего входа`);
      }
    }
    // Хеши и пароли на экран не попадают ни в каком виде.
    const body = await page.locator('main').innerText();
    if (/\$2[aby]\$/.test(body)) errors.push(`[${tag}] на экране виден хеш пароля`);

    // 3. Матрица: настоящие права и настоящие роли, а не семь строк из вёрстки.
    //
    // Считаем по-разному, потому что раскладки разные и это сознательно: на
    // 1440 матрица таблицей и рядом с каждым правом стоит его код, на 360
    // таблицу не построить — там роль за ролью со списком галочек, и код там
    // не нужен (он для нас, а не для администратора клиента).
    await tab(page, 'Роли и права');
    const pageText = await page.locator('main').innerText();
    let permCount;
    if (w >= 1024) {
      permCount = [
        ...new Set(
          (pageText.match(/\b[a-z]+\.[a-z_.]+\b/g) ?? []).filter((c) =>
            /^(dashboard|sales|warehouse|production|finance|crm|documents|refs|settings|admin)\./.test(c),
          ),
        ),
      ].length;
    } else {
      // Галочки по всем ролям: столько прав им вообще можно проставить.
      // Делить на роли незачем — проверяем, что права настоящие, а не семь
      // строк из вёрстки, и для этого достаточно общего числа.
      permCount = await page.locator('main input[type="checkbox"]').count();
    }
    notes.push(`[${tag}] ${w >= 1024 ? 'прав в матрице' : 'галочек в матрице по всем ролям'}: ${permCount}`);
    if (permCount < 20) {
      errors.push(`[${tag}] в матрице ${permCount} прав, а в системе их больше двадцати`);
    }
    for (const role of ['Кладовщик', 'Бухгалтер', 'Начальник производства']) {
      if (!pageText.includes(role)) errors.push(`[${tag}] в матрице нет роли «${role}»`);
    }

    // 4. Журнал действий: строки с «было → стало».
    await tab(page, 'Журнал действий');
    const audit = await page.locator('ul li').allInnerTexts();
    notes.push(`[${tag}] строк журнала действий: ${audit.length}`);
    if (audit.length === 0) errors.push(`[${tag}] журнал действий пуст, хотя аудит пишется с начала проекта`);
    const arrows = await page.locator('main svg.lucide-arrow-right').count();
    if (arrows === 0) {
      errors.push(`[${tag}] в журнале действий нет ни одного «было → стало»`);
    }

    // 5. Журнал входов: причина отказа словами, а не кодом.
    await tab(page, 'Журнал входов');
    const logins = await page.locator('main').innerText();
    if (!/Вход|вход/.test(logins)) errors.push(`[${tag}] журнал входов пуст`);
    if (/bad_password|unknown_or_inactive/.test(logins)) {
      errors.push(`[${tag}] причина отказа показана кодом, а не словами`);
    }

    // 6. Валюты и курсы (ТЗ 6.2): справочник на запись, а не подпись. На
    //    экране должны быть сами валюты, курс числом, источник и дата — иначе
    //    непонятно, по чему считается валютная операция.
    await tab(page, 'Валюты и курсы');
    const money = await page.locator('main').innerText();
    for (const want of ['USD', 'RUB', 'UZS', 'cbu.uz', 'Обновить с ЦБ РУз']) {
      if (!money.includes(want)) errors.push(`[${tag}] в валютах нет «${want}»`);
    }
    if (!/\d[\d\s]*,\d/.test(money)) {
      errors.push(`[${tag}] в валютах нет ни одного курса числом`);
    }
    if (!/учётная валюта/i.test(money)) {
      errors.push(`[${tag}] не сказано, какая валюта учётная`);
    }
    const oMoney = await overflow(page);
    if (oMoney.page || oMoney.bleed.length) {
      errors.push(`[${tag}] валюты уехали за край: ${JSON.stringify(oMoney)}`);
    }
    await page.screenshot({ path: `${OUT}admin-currencies-${theme}-${w}.png`, fullPage: false });

    // 7. Копии базы: экран обязан показывать состояние дел словами и хотя бы
    //    одну копию. Пустой список здесь — не «нечего показать», а «система
    //    стоит без резервной копии», и это надо увидеть снаружи, а не из тестов.
    if (!(await tab(page, 'Копии базы'))) {
      errors.push(`[${tag}] нет вкладки «Копии базы»`);
    } else {
      const screen = page.locator('[data-screen="admin-backups"]');
      await screen.waitFor({ timeout: 15000 }).catch(() => {});
      const backups = await page.locator('main').innerText();
      for (const want of ['Сделать копию сейчас', 'Расписание', 'Храним']) {
        if (!backups.includes(want)) errors.push(`[${tag}] на экране копий нет «${want}»`);
      }
      const health = page.locator('[data-role="backup-health"]');
      const level = (await health.count()) ? await health.getAttribute('data-level') : null;
      notes.push(`[${tag}] состояние копий: ${level ?? 'нет строки состояния'}`);
      if (level === null) errors.push(`[${tag}] на экране копий нет строки состояния`);
      // «none» значит: ни одной удачной копии. На живом стенде это ошибка.
      if (level === 'none') errors.push(`[${tag}] на стенде нет ни одной удачной копии базы`);
      if (level === 'stale') errors.push(`[${tag}] последняя удачная копия старше срока`);
      // Стенд копии не хранит (уточнение Отабека от 07.10): расписание там
      // выключено `BACKUP_SCHEDULER=off`, и правильное состояние — «off».
      // «ok» здесь означал бы, что стенд снова копит ночные копии, а «stale» —
      // что экран пугает тревогой там, где её выключили сознательно.
      if (level !== null && level !== 'off') {
        errors.push(`[${tag}] расписание копий на стенде должно быть выключено, а состояние «${level}»`);
      }
      if (!backups.includes('Выключено')) {
        errors.push(`[${tag}] на экране копий не сказано, что расписание выключено`);
      }
      const rows = await page.locator('[data-backup]').count();
      notes.push(`[${tag}] копий в списке: ${rows}`);
      if (rows === 0) errors.push(`[${tag}] список копий пуст`);
      const can = await page.locator('[data-role="backup-download"]').count();
      if (can === 0) errors.push(`[${tag}] ни одну копию нельзя скачать`);
      // Восстановления кнопкой нет сознательно — экран обязан сказать это сам,
      // иначе администратор будет искать её и решит, что не нашёл.
      if (!/[Вв]осстанов/.test(backups)) {
        errors.push(`[${tag}] на экране копий ничего не сказано про восстановление`);
      }
      const oBackups = await overflow(page);
      if (oBackups.page || oBackups.bleed.length) {
        errors.push(`[${tag}] копии базы уехали за край: ${JSON.stringify(oBackups)}`);
      }
      await page.screenshot({ path: `${OUT}admin-backups-${theme}-${w}.png`, fullPage: false });
    }

    const o = await overflow(page);
    if (o.page || o.bleed.length) {
      errors.push(`[${tag}] за край уехало: ${JSON.stringify(o)}`);
    }
    if (ce.length) errors.push(`[${tag}] ошибки в консоли: ${ce.join(' | ')}`);
    await page.screenshot({ path: `${OUT}admin-${theme}-${w}.png`, fullPage: false });
    } catch (e) {
      // Падение внутри сочетания — находка этого сочетания, а не конец прогона:
      // остальные три нужно проверить всё равно.
      errors.push(`[${tag}] не проверено: ${String(e).split('\n')[0].slice(0, 160)}`);
    }
    await ctx.close();
  }
}

// --- запись: матрица и заведение человека (один раз) ------------------------
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await login(page);
  await openAdmin(page);

  // 6. Галочка в матрице доходит до сервера и переживает перезагрузку.
  await tab(page, 'Роли и права');
  const cell = page.getByRole('button', { name: 'Начальник производства — documents.view' }).first();
  if (!(await cell.count())) {
    errors.push('в матрице нет клетки «Начальник производства — documents.view»');
  } else {
    const before = await cell.getAttribute('aria-pressed');
    await cell.click();
    const save = page.getByRole('button', { name: 'Сохранить' });
    if (!(await save.count())) {
      errors.push('после правки матрицы не предложено сохранить');
    } else {
      await save.first().click();
      await page.waitForTimeout(2500);
      await page.reload({ waitUntil: 'networkidle' });
      await openAdmin(page);
      await tab(page, 'Роли и права');
      const after = await page
        .getByRole('button', { name: 'Начальник производства — documents.view' })
        .first()
        .getAttribute('aria-pressed');
      notes.push(`матрица: было ${before}, после сохранения и перезагрузки ${after}`);
      if (after === before) {
        errors.push(`правка матрицы не сохранилась: aria-pressed так и ${after}`);
      }
      // Возвращаем как было: набор системной роли — часть демо-данных.
      const back = page
        .getByRole('button', { name: 'Начальник производства — documents.view' })
        .first();
      await back.click();
      await page.getByRole('button', { name: 'Сохранить' }).first().click();
      await page.waitForTimeout(2000);
    }
  }

  // 7. Человек заводится из интерфейса и появляется в списке.
  await tab(page, 'Люди');
  await page.getByRole('button', { name: 'Добавить человека' }).first().click();
  await page.waitForTimeout(800);
  const newLogin = `qa.probe.${stamp}`;
  const field = (label) => page.locator(`label:has(span:text-is("${label}")) input`).first();
  await field('Логин').fill(newLogin);
  await field('ФИО').fill('QA Прогон админки');
  await field('Пароль').fill('qa-probe-123');
  const roleBtn = page.getByRole('button', { name: 'Кладовщик', exact: true }).first();
  if (await roleBtn.count()) await roleBtn.click();
  await page.getByRole('button', { name: 'Завести', exact: true }).first().click();
  await page.waitForTimeout(3000);

  const listed = await page.locator('ul li').allInnerTexts();
  const made = listed.find((t) => t.includes(newLogin));
  notes.push(`заведённая учётка в списке: ${made ? 'да' : 'нет'}`);
  if (!made) {
    errors.push(`заведённая учётка ${newLogin} в списке не появилась`);
  } else {
    if (!/Кладовщик/.test(made)) {
      errors.push(`у заведённой учётки не показана роль: «${made.replace(/\s+/g, ' ').slice(0, 90)}»`);
    }
    // 7б. Привязка Telegram (ТЗ 11.2): код выдаётся, виден один раз, в списке
    // остаётся только отметка «код выдан» со сроком.
    const tgRow = page.locator('ul li').filter({ hasText: newLogin }).first();
    const connect = tgRow.getByRole('button', { name: 'Подключить Telegram' }).first();
    if ((await connect.count()) === 0) {
      errors.push('у новой учётки нет кнопки «Подключить Telegram»');
    } else {
      await connect.click();
      await page.waitForTimeout(2000);
      const shownCode = (await tgRow.innerText()).match(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/);
      if (!shownCode) {
        errors.push(
          `код привязки не показан: «${(await tgRow.innerText()).replace(/\s+/g, ' ').slice(0, 140)}»`,
        );
      } else {
        notes.push(`код привязки выдан, длина ${shownCode[0].length}, в заметки не пишем`);
        if (!/start /.test(await tgRow.innerText())) {
          errors.push('рядом с кодом нет указания, что человек пишет боту /start');
        }
        if (!/код выдан, годен до/.test(await tgRow.innerText())) {
          errors.push('в строке человека нет отметки «код выдан, годен до»');
        }

        // Второй код отличается от первого: иначе «одноразовый» ничего не значит.
        const again = tgRow.getByRole('button', { name: 'Новый код' }).first();
        if ((await again.count()) === 0) {
          errors.push('после выдачи кода кнопка не превратилась в «Новый код»');
        } else {
          await again.click();
          await page.waitForTimeout(2000);
          const second = (await tgRow.innerText()).match(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/);
          if (!second) {
            errors.push('второй код не показан');
          } else if (second[0] === shownCode[0]) {
            errors.push('второй код совпал с первым: код не одноразовый');
          }
        }

        await page.screenshot({ path: `${OUT}admin-telegram-code-1440-light.png` });

        // Код виден один раз: после перезагрузки его в списке быть не должно.
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(1500);
        await openAdmin(page);
        await tab(page, 'Люди');
        await page.waitForTimeout(1200);
        const afterReload = await page
          .locator('ul li')
          .filter({ hasText: newLogin })
          .first()
          .innerText()
          .catch(() => '');
        if (/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/.test(afterReload)) {
          errors.push('код привязки видно после перезагрузки: он обязан показываться один раз');
        }
        if (!/код выдан, годен до/.test(afterReload)) {
          errors.push('после перезагрузки нет отметки о выданном коде');
        }
      }
    }

    // Выключаем за собой: удаления учётки в системе нет и быть не должно.
    const row = page.locator('ul li').filter({ hasText: newLogin }).first();
    await row.getByRole('button', { name: 'Выключить' }).first().click();
    await page.waitForTimeout(2500);
    const off = await page.locator('ul li').filter({ hasText: newLogin }).first().innerText();
    if (!/выключен/.test(off)) {
      errors.push(`учётку прогона не удалось выключить: «${off.replace(/\s+/g, ' ').slice(0, 90)}»`);
    }
  }

  // 8. Заведение человека попало в журнал действий «было → стало».
  await tab(page, 'Журнал действий');
  const audit = await page.locator('ul li').allInnerTexts();
  const mine = audit.find((t) => t.includes('Заведено') || t.includes('Изменено'));
  if (!mine) {
    errors.push('в журнале действий нет свежей записи о заведении или правке');
  } else {
    notes.push(`журнал действий, свежая строка: ${mine.replace(/\s+/g, ' ').slice(0, 100)}`);
  }

  await page.screenshot({ path: `${OUT}admin-write-1440-light.png` });
  await ctx.close();
} catch (e) {
  errors.push(`запись на экране не проверена: ${String(e).split('\n')[0].slice(0, 180)}`);
}

await browser.close();

console.log('--- заметки ---');
for (const n of notes) console.log(n);
if (errors.length) {
  console.log('--- находки ---');
  for (const e of errors) console.log(e);
  console.log(`--- ПРОГОН НЕ ПРОЙДЕН ---\nошибок: ${errors.length}`);
  process.exit(1);
}
console.log('ВСЁ ЧИСТО: вкладки живые, матрица пишется, человек заводится, журналы отвечают');
