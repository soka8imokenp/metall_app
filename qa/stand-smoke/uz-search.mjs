/**
 * Окно поиска по разделам на живом стенде — под узбекским.
 *
 * Заказчик увидел эту панель по-русски уже после того, как перевод лежал в
 * коде: стенд отдавал сборку, собранную до правок. Приёмка `web-uz/run.mjs`
 * ходит по локальной сборке и такой разрыв не ловит — отсюда отдельный прогон
 * снаружи, по публичному адресу.
 *
 * Запуск: cd dev/qa && node stand-smoke/uz-search.mjs
 * Красным становится и при кириллице, и при отсутствии панели: пустая проверка
 * не должна выглядеть как успех.
 */
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { standLogin, standPassword } from '../stand-credentials.mjs';

const STAND = process.env.STAND_URL ?? 'https://metall-asia.cloudplus.uz';
const LOGIN = standLogin();
const PASS = standPassword();
const OUT = '/tmp/stand-uz';
fs.mkdirSync(OUT, { recursive: true });
const CYR = /[А-Яа-яЁё]/;

const browser = await chromium.launch({
  executablePath: '/home/an/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
  args: ['--no-sandbox'],
});
const found = [];
try {
  for (const [w, h, tag] of [[1440, 900, '1440'], [360, 780, '360']]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    await page.addInitScript(() => localStorage.setItem('metall_locale', 'uz'));
    await page.goto(STAND, { waitUntil: 'networkidle' });
    await page.locator('input[autocomplete="username"]').first().fill(LOGIN);
    await page.locator('input[autocomplete="current-password"]').first().fill(PASS);
    await page.locator('form button[type="submit"]').first().click();
    await page.waitForSelector('aside', { timeout: 20000 });
    await page.waitForTimeout(2000);

    await page.keyboard.press('Control+k');
    await page.waitForTimeout(900);
    const panel = page.locator('div.fixed.inset-0.z-50').first();
    const n = await panel.count();
    await page.screenshot({ path: `${OUT}/poisk-${tag}.png` });
    // Подписи панели: собственный текст каждого узла плюс подсказки из
    // атрибутов. Собственный, а не `textContent` потомка: строка раздела — это
    // кнопка с иконкой, её название лежит голым текстовым узлом рядом с svg, и
    // отбор «только узлы без детей» такие названия терял. Атрибуты нужны
    // отдельно: placeholder поля ввода текстом не является и проходил мимо.
    const labels = n ? await panel.evaluate((el) => {
      const out = [];
      for (const e of [el, ...el.querySelectorAll('*')]) {
        for (const node of e.childNodes) {
          if (node.nodeType === 3) out.push((node.textContent || '').trim());
        }
        for (const a of ['placeholder', 'aria-label', 'title']) {
          const v = e.getAttribute(a);
          if (v) out.push(v.trim());
        }
      }
      return out.filter(Boolean);
    }) : [];
    if (!n) { console.log(`[${tag}] панели нет — проверять нечего`); found.push(tag); }
    const cyr = labels.filter((s) => CYR.test(s));
    console.log(`[${tag}] панель найдена: ${n > 0}, надписей: ${labels.length}`);
    console.log(`[${tag}] примеры: ${labels.slice(0, 12).join(' | ')}`);
    if (cyr.length) { console.log(`[${tag}] КИРИЛЛИЦА: ${cyr.join(' | ')}`); found.push(tag); }
    await ctx.close();
  }
} finally { await browser.close(); }
console.log(found.length ? `\nКРАСНО: кириллица в панели (${found.join(', ')})` : '\nЗЕЛЕНО: в панели поиска кириллицы нет');
process.exit(found.length ? 1 : 0);
