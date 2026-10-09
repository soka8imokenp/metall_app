/**
 * Что на самом деле видно на стенде: версия сборки и поиск по данным.
 *
 * Заказчик говорит, что изменений не видит даже после перезагрузки с
 * очисткой кэша. Проверка отвечает на вопрос фактом, а не рассуждением: с
 * чистого браузерного профиля заходим на публичный адрес и смотрим, какую
 * версию показывает сайдбар и что находит окно поиска. Расхождение с тем, что
 * отдаёт `/version.json`, значит проблему на стороне стенда; совпадение —
 * что смотрят не туда или не тем клиентом.
 *
 * Запуск: cd dev/qa && node stand-smoke/version-live.mjs
 */
import { chromium } from 'playwright-core';
import { standLogin, standPassword } from '../stand-credentials.mjs';
import fs from 'node:fs';

const STAND = process.env.STAND_URL ?? 'https://metall-asia.cloudplus.uz';
const L = standLogin();
const P = standPassword();
const OUT = '/tmp/stand-version';
fs.mkdirSync(OUT, { recursive: true });
const errors = [];

const served = await fetch(`${STAND}/version.json`, { cache: 'no-store' }).then((r) => r.json());
console.log(`/version.json отдаёт: ${served.version} (собрано ${served.builtAt})`);

const browser = await chromium.launch({
  executablePath: '/home/an/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
  args: ['--no-sandbox'],
});
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(STAND, { waitUntil: 'networkidle' });
  await page.locator('input[autocomplete="username"]').first().fill(L);
  await page.locator('input[autocomplete="current-password"]').first().fill(P);
  await page.locator('form button[type="submit"]').first().click();
  await page.waitForSelector('aside', { timeout: 25000 });
  await page.waitForTimeout(1500);

  const aside = await page.locator('aside').innerText();
  const shown = aside.match(/v\s(\S+)/)?.[1] ?? '(нет)';
  console.log(`в сайдбаре видно: ${shown}`);
  if (shown !== served.version) {
    errors.push(`сайдбар показывает «${shown}», а сервер «${served.version}»`);
  }
  await page.screenshot({ path: `${OUT}/sajdbar.png` });

  // Поиск по данным — то, чего заказчик, по его словам, не видит.
  await page.keyboard.press('Control+k');
  await page.waitForSelector('div.fixed.inset-0.z-50 input', { timeout: 10000 });
  await page.locator('div.fixed.inset-0.z-50 input').first().fill(process.env.Q ?? 'Демо');
  await page.waitForTimeout(2500);
  const panel = page.locator('div.fixed.inset-0.z-50').first();
  const heads = await panel.evaluate((el) =>
    [...el.querySelectorAll('div.uppercase')].map((e) => e.textContent.trim()));
  await page.screenshot({ path: `${OUT}/poisk.png` });
  const data = heads.filter((x) => !/^(Разделы|Bo‘limlar)$/.test(x));
  console.log(`группы в выдаче: ${heads.join(' | ') || '(нет)'}`);
  if (data.length === 0) errors.push('поиск не даёт ни одной группы данных');

  await ctx.close();
} finally {
  await browser.close();
}
console.log(errors.length ? `\nКРАСНО: ${errors.join('; ')}` : `\nЗЕЛЕНО: стенд показывает ту же версию и ищет по данным. Снимки: ${OUT}`);
process.exit(errors.length ? 1 : 0);
