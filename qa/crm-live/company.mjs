/**
 * Смена компании в шапке: экран обязан перечитать данные.
 *
 * Проверка поведения, а не вёрстки, поэтому ширина одна. Сигнал — запрос к
 * API после переключения: сравнивать видимые строки нельзя, у двух компаний
 * они местами совпадают, и экран, застрявший на прежней, выглядел бы живым.
 */
import { chromium } from 'playwright-core';
const STAND = 'https://metall-asia.cloudplus.uz';
const TABS = ['Обращения', 'Клиенты', 'Сделки', 'Задачи', 'Справочники', 'Отчёты'];
const errors = [];

const browser = await chromium.launch({ channel: 'chromium' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
let calls = 0;
page.on('request', (r) => { if (r.url().includes('/api/v1/crm/')) calls += 1; });

await page.goto(STAND, { waitUntil: 'networkidle' });
await page.locator('input[autocomplete="username"]').first().fill('admin');
await page.locator('input[autocomplete="current-password"]').first().fill('admin');
await page.getByRole('button', { name: 'Войти' }).click();
await page.waitForTimeout(2500);
await page.getByRole('button', { name: 'CRM', exact: true }).first().click();
await page.waitForTimeout(2000);

/** Переключает компанию в сайдбаре и возвращает её название. */
const switchCompany = async (want) => {
  // Переключатель — первая кнопка сайдбара: подписи у неё нет, выбирают её
  // глазами по названию компании.
  const opener = page.locator('aside button').first();
  await opener.click();
  await page.waitForTimeout(400);
  const item = page.locator('aside button', { hasText: want }).first();
  if (!(await item.count())) throw new Error(`в списке компаний нет «${want}»`);
  await item.click();
  await page.waitForTimeout(1800);
};

for (const tab of TABS) {
  await page.getByRole('tab', { name: tab }).click();
  await page.waitForTimeout(2000);
  for (const want of ['Plant', 'Trade']) {
    calls = 0;
    await switchCompany(want);
    if (calls === 0) {
      errors.push(`«${tab}»: смена компании на ${want} не перечитала данные (0 запросов)`);
    }
  }
}

console.log(`проверено вкладок: ${TABS.length}`);
await ctx.close();
await browser.close();
console.log(errors.length ? `--- НЕ ПРОЙДЕН --- ${errors.join(' ;; ')}` : '--- прогон пройден ---');
process.exit(errors.length ? 1 : 0);
