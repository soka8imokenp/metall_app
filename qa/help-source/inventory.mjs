/**
 * Опись живого стенда для раздела «Справка».
 *
 * Зачем. Инструкция для сотрудника обязана называть кнопки и поля так, как они
 * на экране, а не так, как помнится по коду. Экранов восемь, в них по шесть-семь
 * вкладок, и переписывать подписи из восьми файлов по три тысячи строк — верный
 * способ соврать. Поэтому опись снимается с того же публичного стенда, на который
 * смотрит заказчик: вкладки обходятся нажатиями, с каждой собираются заголовки,
 * подписи полей и кнопки.
 *
 * Ничего не пишет: только переходы и нажатия на вкладки. Форм не отправляет.
 *
 * Вход — служебной учёткой прогонов `qa_stand` (у девяти человеческих учёток
 * стенда поднят признак «пароль временный», и первый живой вход человека менял
 * бы пароль под прогоном).
 *
 * Запуск: cd dev/qa && node help-source/inventory.mjs
 * Результат: help-source/inventory.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { standLogin, standPassword } from '../stand-credentials.mjs';

const CHROME = '/home/an/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const HERE = path.dirname(new URL(import.meta.url).pathname);
const URL_BASE = process.env.STAND_URL ?? 'https://metall-asia.cloudplus.uz';
const OUT = path.join(HERE, 'inventory.json');

const MODULES = [
  'dashboard',
  'sales',
  'warehouse',
  'production',
  'finance',
  'documents',
  'crm',
  'admin',
];

/** Что видно на открытом экране: подписи, по которым человек себя сверяет. */
const probe = () => {
  const text = (el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  const uniq = (xs) => [...new Set(xs.filter((s) => s && s.length < 160))];
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const all = (sel) => [...document.querySelectorAll(sel)].filter(vis);
  return {
    headings: uniq(all('h1,h2,h3').map(text)),
    tabs: uniq(all('[role="tab"]').map(text)),
    buttons: uniq(all('button').map(text)),
    labels: uniq(all('label').map(text)),
    placeholders: uniq(all('input,textarea').map((el) => el.getAttribute('placeholder') ?? '')),
    selects: uniq(all('select').map((el) => el.getAttribute('aria-label') ?? '')),
    tableHeads: uniq(all('th').map(text)),
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
};

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const inventory = { stand: URL_BASE, takenAt: new Date().toISOString(), modules: {} };

try {
  await page.addInitScript(() => localStorage.setItem('metall_theme', 'light'));
  await page.goto(URL_BASE, { waitUntil: 'networkidle' });
  await page.locator('input[autocomplete="username"]').first().fill(standLogin());
  await page.locator('input[autocomplete="current-password"]').first().fill(standPassword());
  await page.getByRole('button', { name: 'Войти' }).click();
  await page.waitForSelector('[data-module]', { timeout: 20000 });
  console.log('вошёл служебной учёткой');

  for (const mod of MODULES) {
    const entry = { tabs: {} };
    const nav = page.locator(`[data-module="${mod}"]`);
    if ((await nav.count()) === 0) {
      entry.missing = true;
      inventory.modules[mod] = entry;
      continue;
    }
    await nav.first().click();
    await page.waitForTimeout(2500);
    entry.base = await page.evaluate(probe);

    const tabNames = entry.base.tabs;
    for (const name of tabNames) {
      const tab = page.getByRole('tab', { name, exact: true }).first();
      if ((await tab.count()) === 0) continue;
      await tab.click().catch(() => null);
      await page.waitForTimeout(2000);
      entry.tabs[name] = await page.evaluate(probe);
      console.log(`  ${mod} / ${name}`);
    }
    inventory.modules[mod] = entry;
    console.log(`${mod}: вкладок ${Object.keys(entry.tabs).length}`);
  }
} finally {
  fs.writeFileSync(OUT, `${JSON.stringify(inventory, null, 2)}\n`);
  await browser.close();
  console.log(`опись: ${OUT}`);
}
