import { chromium } from 'playwright-core';
const STAND = 'https://metall-asia.cloudplus.uz';
const OUT = new URL('./shots/', import.meta.url).pathname;
const errors = [];
const MARK = `QA Срок ${Date.now().toString().slice(-5)}`;

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

// Срок «сегодня к 23:30» по местному времени — им и проверяется, что задача не
// становится просроченной раньше срока.
const now = new Date();
const p2 = (n) => String(n).padStart(2, '0');
const dueLocal = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}T23:30`;
const dueShown = `${p2(now.getDate())}.${p2(now.getMonth() + 1)} 23:30`;

const browser = await chromium.launch({ channel: 'chromium' });
for (const theme of ['light', 'dark']) {
  for (const [w, h] of [[1440, 900], [360, 800]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    await ctx.addInitScript((t) => localStorage.setItem('metall_theme', t), theme);
    const page = await ctx.newPage();
    const ce = [];
    page.on('console', (m) => { if (m.type() === 'error') ce.push(m.text()); });
    await page.goto(STAND, { waitUntil: 'networkidle' });
    await page.locator('input[autocomplete="username"]').first().fill('admin');
    await page.locator('input[autocomplete="current-password"]').first().fill('admin');
    await page.getByRole('button', { name: 'Войти' }).click();
    await page.waitForTimeout(2500);
    await page.getByRole('button', { name: 'CRM', exact: true }).first().click();
    await page.waitForTimeout(1500);
    await page.getByRole('tab', { name: 'Задачи' }).first().click();
    await page.waitForTimeout(2500);
    const tag = `${theme}/${w}`;

    const body = await page.locator('body').innerText();
    for (const chip of ['Просрочено', 'Сегодня', 'Неделя', 'Открытые', 'Закрытые']) {
      if (!body.includes(chip)) errors.push(`${tag}: нет вкладки «${chip}»`);
    }
    // Просрочка открывается сама: ради неё экран и сделан.
    const overdueChip = await page.getByRole('button', { name: /^Просрочено \d+$/ }).first().innerText();
    const n = Number(overdueChip.match(/\d+/)[0]);
    if (n === 0) errors.push(`${tag}: на стенде нет просроченных задач — проверять нечего`);
    const selected = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /^Просрочено \d+$/.test(x.innerText));
      return b ? getComputedStyle(b).backgroundColor : null;
    });
    console.log(`${tag}: просрочено ${n}, чип ${selected}`);

    const o = await overflow(page);
    console.log(`${tag}: задачи — скроллеров ${o.scrollers.length}, страница +${o.page}px`);
    if (o.scrollers.length || o.page) errors.push(`${tag}: задачи уезжают вбок ${JSON.stringify(o)}`);
    await page.screenshot({ path: `${OUT}/crm-tasks-${theme}-${w}.png` });

    // лента
    await page.getByRole('tab', { name: 'Лента' }).last().click();
    await page.waitForTimeout(2000);
    const feed = await page.locator('body').innerText();
    if (!/Звонок|Заметка|Встреча|Письмо/.test(feed)) errors.push(`${tag}: лента пуста`);
    const o2 = await overflow(page);
    console.log(`${tag}: лента — скроллеров ${o2.scrollers.length}, страница +${o2.page}px`);
    if (o2.scrollers.length || o2.page) errors.push(`${tag}: лента уезжает вбок ${JSON.stringify(o2)}`);
    await page.screenshot({ path: `${OUT}/crm-feed-${theme}-${w}.png` });

    if (theme === 'light' && w === 1440) {
      await page.getByRole('tab', { name: 'Задачи' }).last().click();
      await page.waitForTimeout(1500);
      await page.getByRole('button', { name: 'Новая задача' }).click();
      await page.waitForTimeout(600);

      const save = page.getByRole('button', { name: 'Поставить' });
      if (!(await save.isDisabled())) errors.push(`${tag}: задача ставится без клиента и сделки`);

      await page.getByLabel('Что сделать').fill(MARK);
      await page.locator('input[type="datetime-local"]').fill(dueLocal);
      await page.getByRole('button', { name: 'Клиент' }).first().click();
      await page.waitForTimeout(400);
      await page.locator('[role="listbox"] button').nth(1).click();
      await page.waitForTimeout(400);
      if (await save.isDisabled()) errors.push(`${tag}: задача с клиентом и сроком не ставится`);
      await save.click();
      await page.waitForTimeout(2000);

      // Задача со сроком «сегодня к 23:30» не просрочена — её место в «Сегодня».
      await page.getByRole('button', { name: /^Сегодня \d+$/ }).click();
      await page.waitForTimeout(1500);
      const today = await page.locator('body').innerText();
      if (!today.includes(MARK)) errors.push(`${tag}: задача на сегодня не попала во вкладку «Сегодня»`);
      if (!today.includes(dueShown)) errors.push(`${tag}: срок показан не как «${dueShown}»`);
      await page.getByRole('button', { name: /^Просрочено \d+$/ }).click();
      await page.waitForTimeout(1500);
      if ((await page.locator('body').innerText()).includes(MARK)) {
        errors.push(`${tag}: задача со сроком сегодня вечером считается просроченной`);
      }
      await page.screenshot({ path: `${OUT}/crm-tasks-today.png` });

      // Закрытие требует результата и рождает запись в ленте.
      await page.getByRole('button', { name: /^Сегодня \d+$/ }).click();
      await page.waitForTimeout(1500);
      const row = page.locator('li', { hasText: MARK }).first();
      await row.getByRole('button', { name: 'Сделано' }).click();
      await page.waitForTimeout(600);
      const keep = row.getByRole('button', { name: 'Сохранить' });
      if (!(await keep.isDisabled())) errors.push(`${tag}: задача закрывается без результата`);
      await row.getByLabel('Результат задачи').fill('Дозвонились, ждут счёт');
      await page.waitForTimeout(300);
      if (await keep.isDisabled()) errors.push(`${tag}: результат введён, а закрыть нельзя`);
      await keep.click();
      await page.waitForTimeout(2200);
      await page.screenshot({ path: `${OUT}/crm-tasks-done.png` });

      await page.getByRole('tab', { name: 'Лента' }).last().click();
      await page.waitForTimeout(2000);
      const after = await page.locator('body').innerText();
      if (!after.includes(MARK)) errors.push(`${tag}: закрытая задача не легла в ленту`);
      if (!after.includes('Дозвонились, ждут счёт')) errors.push(`${tag}: в ленте нет результата`);
      if (!after.includes('из задачи')) errors.push(`${tag}: в ленте не видно, что запись из задачи`);
      await page.screenshot({ path: `${OUT}/crm-feed-new.png` });
    }

    console.log(`${tag}: ошибки консоли ${ce.length} ${ce.slice(0, 1).join('')}`);
    if (ce.length) errors.push(`${tag}: консоль ${ce[0]}`);
    await ctx.close();
  }
}
await browser.close();
console.log(errors.length ? `ПРОВАЛ:\n- ${errors.join('\n- ')}` : `ВСЁ ЧИСТО (метка ${MARK})`);
process.exit(errors.length ? 1 : 0);
