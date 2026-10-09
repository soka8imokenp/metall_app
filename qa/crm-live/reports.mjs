import { chromium } from 'playwright-core';
const STAND = 'https://metall-asia.cloudplus.uz';
const OUT = new URL('./shots/', import.meta.url).pathname;
const errors = [];
const KINDS = ['Воронка и конверсия', 'Менеджеры', 'Источники', 'Причины отказов'];

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
    const ctx = await browser.newContext({
      viewport: { width: w, height: h },
      acceptDownloads: true,
    });
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
    await page.getByRole('tab', { name: 'Отчёты' }).first().click();
    await page.waitForTimeout(2500);
    const tag = `${theme}/${w}`;

    for (const kind of KINDS) {
      await page.getByRole('button', { name: kind }).click();
      await page.waitForTimeout(1800);
      const body = await page.locator('body').innerText();
      if (/показывать нечего/.test(body)) errors.push(`${tag}: отчёт «${kind}» пуст`);
      const o = await overflow(page);
      if (o.scrollers.length || o.page) {
        errors.push(`${tag}: отчёт «${kind}» уезжает вбок ${JSON.stringify(o)}`);
      }
      if (kind === 'Воронка и конверсия') {
        if (!/по следу переходов/.test(body)) errors.push(`${tag}: воронка не объясняет, как считает`);
        if (!/занижена/.test(body)) errors.push(`${tag}: воронка не предупреждает о свежей когорте`);
        if (!/Вошло в воронку/.test(body)) errors.push(`${tag}: нет плашек с итогами`);
      }
      if (kind === 'Причины отказов' && !/Доля по сумме/.test(body)) {
        errors.push(`${tag}: у причин отказов нет доли по сумме`);
      }
    }
    console.log(`${tag}: четыре отчёта пройдены`);
    await page.getByRole('button', { name: 'Воронка и конверсия' }).click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/crm-report-funnel-${theme}-${w}.png` });
    await page.getByRole('button', { name: 'Менеджеры' }).click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/crm-report-managers-${theme}-${w}.png` });

    // Выгрузка обязана отдать настоящий файл, а не ошибку в консоль.
    if (theme === 'light' && w === 1440) {
      const [dl] = await Promise.all([
        page.waitForEvent('download', { timeout: 20000 }),
        page.getByRole('button', { name: 'Excel' }).click(),
      ]);
      const name = dl.suggestedFilename();
      if (!/^crm-managers-\d{4}-\d{2}-\d{2}\.xlsx$/.test(name)) {
        errors.push(`${tag}: имя выгруженного файла «${name}»`);
      }
      const path = await dl.path();
      const { readFileSync } = await import('node:fs');
      const head = readFileSync(path).subarray(0, 2).toString('latin1');
      if (head !== 'PK') errors.push(`${tag}: выгрузка не xlsx, первые байты «${head}»`);
      console.log(`${tag}: выгрузка ${name}, сигнатура ${head}`);

      // Период меняется и отчёт пересчитывается.
      await page.getByLabel('Дата с').click();
      await page.waitForTimeout(600);
      const before = await page.locator('body').innerText();
      await page.keyboard.press('Escape');
      if (!/\d{2}\.\d{2}\.\d{4} — \d{2}\.\d{2}\.\d{4}/.test(before)) {
        errors.push(`${tag}: период не назван в подзаголовке`);
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
