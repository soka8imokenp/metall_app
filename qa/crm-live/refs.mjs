/**
 * CRM Э7 — справочники на запись, проверка на живом стенде.
 *
 * Смотрим глазами то, что сервер уже проверяет тестами: все четыре раздела
 * открываются, правило раздела написано на экране, правка проходит целиком
 * (завели тип → он появился в форме задачи), а запрет объяснён словами, а не
 * молчанием. И ничего не уезжает вбок на 360.
 */
import { chromium } from 'playwright-core';
const STAND = 'https://metall-asia.cloudplus.uz';
const OUT = new URL('./shots/', import.meta.url).pathname;
const errors = [];
const SECTIONS = ['Воронка', 'Источники', 'Причины отказа', 'Типы задач'];
const stamp = String(Date.now()).slice(-5);

async function overflow(page) {
  return await page.evaluate(() => {
    const bad = [];
    document.querySelectorAll('*').forEach((el) => {
      if (el.scrollWidth - el.clientWidth > 1 && el.clientWidth > 0) {
        const st = getComputedStyle(el);
        if (['auto', 'scroll'].includes(st.overflowX)) bad.push((el.className || '').toString().slice(0, 50));
      }
    });
    const d = document.documentElement;
    return { scrollers: bad, page: d.scrollWidth - d.clientWidth };
  });
}

const browser = await chromium.launch({ channel: 'chromium' });
for (const theme of ['light', 'dark']) {
  for (const [w, h] of [[1440, 900], [360, 800]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    await ctx.addInitScript((t) => localStorage.setItem('metall_theme', t), theme);
    const page = await ctx.newPage();
    const ce = [];
    page.on('console', (m) => { if (m.type() === 'error') ce.push(m.text().slice(0, 160)); });
    page.on('pageerror', (e) => ce.push('pageerror: ' + String(e).slice(0, 160)));
    await page.goto(STAND, { waitUntil: 'networkidle' });
    await page.locator('input[autocomplete="username"]').first().fill('admin');
    await page.locator('input[autocomplete="current-password"]').first().fill('admin');
    await page.getByRole('button', { name: 'Войти' }).click();
    await page.waitForTimeout(2500);
    await page.getByRole('button', { name: 'CRM', exact: true }).first().click();
    await page.waitForTimeout(1500);
    await page.getByRole('tab', { name: 'Справочники' }).first().click();
    await page.waitForTimeout(1800);
    const tag = `${theme}/${w}`;

    for (const s of SECTIONS) {
      await page.getByRole('tab', { name: s }).click();
      await page.waitForTimeout(900);
      const body = await page.locator('body').innerText();
      if (/Пусто/.test(body)) errors.push(`${tag}: раздел «${s}» пуст`);
      const o = await overflow(page);
      if (o.scrollers.length || o.page) {
        errors.push(`${tag}: раздел «${s}» уезжает вбок ${JSON.stringify(o)}`);
      }
      if (s === 'Воронка' && !/конечные/i.test(body)) {
        errors.push(`${tag}: воронка не объясняет, что конечные стадии последние`);
      }
      if (s === 'Типы задач' && !/в ленте/.test(body)) {
        errors.push(`${tag}: у типа задачи не видно, чем он ляжет в ленту`);
      }
    }
    console.log(`${tag}: четыре раздела пройдены`);

    await page.getByRole('tab', { name: 'Воронка' }).click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${OUT}/crm-refs-stages-${theme}-${w}.png` });
    await page.getByRole('tab', { name: 'Типы задач' }).click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${OUT}/crm-refs-types-${theme}-${w}.png` });

    if (theme === 'light' && w === 1440) {
      // Круг целиком: завести свой тип задачи, увидеть его в форме задачи,
      // убедиться, что удалить конечную стадию сервер не даёт, и убрать за собой.
      const name = `QA Тип ${stamp}`;
      await page.getByRole('button', { name: 'Добавить тип' }).click();
      await page.waitForTimeout(500);
      await page.getByPlaceholder('site-visit').fill(`qa-${stamp}`);
      await page.getByLabel('Название', { exact: true }).fill(name);
      await page.getByRole('button', { name: 'Сохранить' }).click();
      await page.waitForTimeout(1500);
      if (!(await page.locator('body').innerText()).includes(name)) {
        errors.push(`${tag}: заведённый тип «${name}» не появился в списке`);
      }

      await page.getByRole('tab', { name: 'Задачи' }).first().click();
      await page.waitForTimeout(1500);
      await page.getByRole('button', { name: 'Новая задача' }).click();
      await page.waitForTimeout(1200);
      await page.getByLabel('Тип задачи').click();
      await page.waitForTimeout(500);
      const inForm = await page.locator('[role="listbox"]').innerText();
      if (!inForm.includes(name)) {
        errors.push(`${tag}: новый тип не предлагается в форме задачи`);
      }
      await page.keyboard.press('Escape');
      console.log(`${tag}: новый тип виден и в справочнике, и в форме задачи`);

      // Конечную стадию сервер удалить не даёт — и говорит почему.
      await page.getByRole('tab', { name: 'Справочники' }).first().click();
      await page.waitForTimeout(1200);
      await page.getByRole('tab', { name: 'Воронка' }).click();
      await page.waitForTimeout(900);
      const finals = page.locator('li', { hasText: 'конечная' });
      // Дальше мы жмём заведомо запрещённое, и сервер отвечает отказом. Отказ
      // — часть проверки, а не поломка: строку об этом из журнала консоли
      // убираем, всё остальное в нём по-прежнему считается ошибкой.
      const before = ce.length;
      await finals.first().getByRole('button', { name: 'Удалить' }).click();
      await page.waitForTimeout(1500);
      const afterKill = await page.locator('body').innerText();
      if (!/закрываются сделки/.test(afterKill)) {
        errors.push(`${tag}: отказ удалить конечную стадию не объяснён словами`);
      } else {
        console.log(`${tag}: конечную стадию удалить не дали, причина названа`);
      }
      await page.screenshot({ path: `${OUT}/crm-refs-denied-${theme}-${w}.png` });
      while (ce.length > before && /status of (409|422)/.test(ce[ce.length - 1])) ce.pop();

      // Убираем свой тип.
      await page.getByRole('tab', { name: 'Типы задач' }).click();
      await page.waitForTimeout(900);
      await page.locator('li', { hasText: name }).first().getByRole('button', { name: 'Удалить' }).click();
      await page.waitForTimeout(1500);
      if ((await page.locator('body').innerText()).includes(name)) {
        errors.push(`${tag}: временный тип «${name}» остался на стенде`);
      }
    }

    console.log(`${tag}: ошибки консоли ${ce.length} ${ce.slice(0, 1).join('')}`);
    if (ce.length) errors.push(`${tag}: консоль ${ce[0]}`);
    await ctx.close();
  }
}
await browser.close();
console.log(errors.length ? `ПРОВАЛ:\n- ${errors.join('\n- ')}` : 'ВСЁ ЧИСТО');
process.exit(errors.length ? 1 : 0);
