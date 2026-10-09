/**
 * Поиск по данным на живом стенде: вводим кусок названия и смотрим, что в
 * выдаче сами записи, а не названия разделов. Доказательство для заказчика —
 * снимок, а не слова.
 *
 * Запуск: cd dev/qa && node stand-smoke/uz-search-live.mjs
 */
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { standLogin, standPassword } from '../stand-credentials.mjs';

const STAND = process.env.STAND_URL ?? 'https://metall-asia.cloudplus.uz';
const L = standLogin();
const P = standPassword();
const OUT = '/tmp/stand-search';
fs.mkdirSync(OUT, { recursive: true });

const errors = [];
const browser = await chromium.launch({
  executablePath: '/home/an/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
  args: ['--no-sandbox'],
});
try {
  for (const [locale, w, h] of [['uz', 1440, 900], ['uz', 360, 780], ['ru', 1440, 900]]) {
    const tag = `${locale}-${w}`;
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    await page.addInitScript((loc) => localStorage.setItem('metall_locale', loc), locale);
    await page.goto(STAND, { waitUntil: 'networkidle' });
    await page.locator('input[autocomplete="username"]').first().fill(L);
    await page.locator('input[autocomplete="current-password"]').first().fill(P);
    await page.locator('form button[type="submit"]').first().click();
    await page.waitForSelector('aside', { timeout: 25000 });
    await page.waitForTimeout(1500);

    await page.keyboard.press('Control+k');
    await page.waitForSelector('div.fixed.inset-0.z-50 input', { timeout: 10000 });
    await page.locator('div.fixed.inset-0.z-50 input').first().fill(process.env.Q ?? 'труб');
    await page.waitForTimeout(2500);
    const panel = page.locator('div.fixed.inset-0.z-50').first();
    const heads = await panel.evaluate((el) =>
      [...el.querySelectorAll('div.uppercase')].map((e) => e.textContent.trim()));
    await page.screenshot({ path: `${OUT}/poisk-${tag}.png` });
    const data = heads.filter((x) => !/^(Разделы|Bo‘limlar)$/.test(x));
    console.log(`[${tag}] группы: ${heads.join(' | ') || '(нет)'}`);
    if (data.length === 0) errors.push(`[${tag}] ни одной группы данных`);
    await ctx.close();
  }
} finally { await browser.close(); }
console.log(errors.length ? `\nКРАСНО: ${errors.join('; ')}` : `\nЗЕЛЕНО: стенд ищет по данным. Снимки: ${OUT}`);
process.exit(errors.length ? 1 : 0);
