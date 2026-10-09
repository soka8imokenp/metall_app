import { chromium } from 'playwright-core';
const STAND = 'https://metall-asia.cloudplus.uz';
const OUT = new URL('./shots/', import.meta.url).pathname;
const errors = [];
const TABS = [
  'Сделки',
  'Заказы',
  // ТЗ 9.2: договорные цены клиента. Вкладка появилась 02.10 — без неё
  // индивидуальную цену было негде ни увидеть, ни завести.
  'Цены',
  'Документы',
  'Финансы',
  'Задачи',
  'Общение',
  'Файлы',
  'История',
];

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
    await page.getByRole('tab', { name: 'Клиенты' }).first().click();
    await page.waitForTimeout(2500);
    const tag = `${theme}/${w}`;

    // Берём клиента, у которого есть заказы: пустая карточка ничего не проверяет.
    await page.locator('ul li button').first().click();
    await page.waitForTimeout(2000);
    const open = page.getByRole('button', { name: 'Открыть карточку целиком' });
    if (!(await open.count())) { errors.push(`${tag}: в обзоре нет кнопки открытия карточки`); await ctx.close(); continue; }
    await open.click();
    await page.waitForTimeout(2500);

    const head = await page.locator('body').innerText();
    if (!/К списку/.test(head)) errors.push(`${tag}: из карточки нельзя вернуться к списку`);

    for (const t of TABS) {
      // Вкладок с этим именем две: верхняя в CRM и вкладка карточки. Нужна последняя.
      await page.getByRole('tab', { name: new RegExp(`^${t}( \\d+)?$`) }).last().click();
      await page.waitForTimeout(1200);
      const o = await overflow(page);
      if (o.scrollers.length || o.page) {
        errors.push(`${tag}: вкладка «${t}» уезжает вбок ${JSON.stringify(o)}`);
      }
      const body = await page.locator('body').innerText();
      if (t === 'Документы' && !/Только просмотр/.test(body)) {
        errors.push(`${tag}: вкладка документов не предупреждает, что она только на чтение`);
      }
      if (t === 'Финансы' && !/Задолженность/.test(body)) {
        errors.push(`${tag}: на вкладке финансов нет задолженности`);
      }
      if (t === 'Цены' && !/перекрывает прайс/.test(body)) {
        errors.push(`${tag}: вкладка цен не объясняет, что цена клиента перекрывает прайс`);
      }
      if (t === 'История' && !/Карточка заведена/.test(body)) {
        errors.push(`${tag}: в истории нет записи о заведении карточки`);
      }
    }
    console.log(`${tag}: вкладок пройдено ${TABS.length}`);
    await page.getByRole('tab', { name: /^Финансы$/ }).last().click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: `${OUT}/crm-card-finance-${theme}-${w}.png` });
    await page.getByRole('tab', { name: /^История( \d+)?$/ }).click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: `${OUT}/crm-card-history-${theme}-${w}.png` });

    // Правка в обзоре обязана появиться в журнале изменений.
    if (theme === 'light' && w === 1440) {
      await page.getByRole('button', { name: 'К списку' }).click();
      await page.waitForTimeout(1500);
      const delay = page.getByLabel('Отсрочка платежа, дней');
      const was = Number(await delay.inputValue());
      const next = was === 21 ? 14 : 21;
      await delay.fill(String(next));
      await page.getByRole('button', { name: 'Сохранить' }).first().click();
      await page.waitForTimeout(2000);
      await page.getByRole('button', { name: 'Открыть карточку целиком' }).click();
      await page.waitForTimeout(1500);
      await page.getByRole('tab', { name: /^История( \d+)?$/ }).last().click();
      await page.waitForTimeout(1500);
      const hist = await page.locator('body').innerText();
      if (!/Правка карточки/.test(hist)) errors.push(`${tag}: правка не попала в журнал`);
      if (!new RegExp(`Отсрочка, дней: ${was} → ${next}`).test(hist)) {
        errors.push(`${tag}: в журнале нет «было ${was} → стало ${next}»`);
      }
      await page.screenshot({ path: `${OUT}/crm-card-history-after-edit.png` });
    }

    console.log(`${tag}: ошибки консоли ${ce.length} ${ce.slice(0, 1).join('')}`);
    if (ce.length) errors.push(`${tag}: консоль ${ce[0]}`);
    await ctx.close();
  }
}
await browser.close();
console.log(errors.length ? `ПРОВАЛ:\n- ${errors.join('\n- ')}` : 'ВСЁ ЧИСТО');
process.exit(errors.length ? 1 : 0);
