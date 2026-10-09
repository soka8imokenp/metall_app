/**
 * Снимок карточки «Загрузка участков» с публичного стенда.
 *
 * Снимается сама карточка, а не вся страница: на полном снимке 360 она тонет,
 * а смотреть надо именно на неё — помещаются ли участки без прокрутки.
 *
 * Логин и пароль берутся из файлов 600 и в вывод не попадают.
 *
 * Запуск:
 *   cd dev/qa && node stand-shot-centers.mjs
 */
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { standLogin, standPassword } from './stand-credentials.mjs';

const URL = process.env.STAND_URL ?? 'https://metall-asia.cloudplus.uz';
const EXE = '/home/an/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const LOGIN = standLogin();
const PASSWORD = standPassword();
const OUT = '/tmp/centers-shots';

fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });

const shoot = async (width, theme) => {
  const ctx = await browser.newContext({
    viewport: { width, height: width === 360 ? 900 : 950 },
    colorScheme: theme,
  });
  const page = await ctx.newPage();
  await page.addInitScript((t) => localStorage.setItem('metall_theme', t), theme);
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.locator('input[autocomplete="username"]').first().fill(LOGIN);
  await page.locator('input[autocomplete="current-password"]').first().fill(PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  await page.waitForTimeout(3500);

  // Цех есть только у завода: под торговым домом карточка будет пустой.
  const wide = page.locator('aside').first().getByText('METALL ASIA', { exact: false }).first();
  const narrow = page.locator('aside button[aria-label*="METALL ASIA"]').first();
  const head = (await wide.count()) ? wide : narrow;
  const current = (await wide.count())
    ? await wide.innerText()
    : String(await narrow.getAttribute('aria-label'));
  if (!current.includes('Plant')) {
    await head.click();
    await page.waitForTimeout(600);
    await page.getByText('Ташкентский изоляционный завод', { exact: false }).last().click();
    await page.waitForTimeout(3000);
  }

  await page.getByRole('button', { name: 'Производство', exact: true }).first().click();
  await page.waitForTimeout(2500);

  const card = page
    .locator('text=Загрузка участков')
    .first()
    .locator('xpath=ancestor::div[contains(@class,"rounded-xl")][1]');
  await card.scrollIntoViewIfNeeded();
  const name = `uchastki-${width}-${theme}`;
  await card.screenshot({ path: `${OUT}/${name}.png` });

  const stats = await card.evaluate((el) => {
    const scrollers = [...el.querySelectorAll('*')].filter((n) => n.scrollHeight - n.clientHeight > 2);
    const codes = [...el.querySelectorAll('span[class*="font-mono"]')]
      .map((n) => n.textContent.trim())
      .filter((t) => /^[A-Z]{2,}[A-Z0-9-]*$/.test(t));
    return { h: Math.round(el.getBoundingClientRect().height), codes, scrollers: scrollers.length };
  });
  console.log(`${name}: высота ${stats.h}px, участки ${stats.codes.join(', ')}, прокрутка ${stats.scrollers}`);
  await ctx.close();
};

for (const w of [1440, 360]) {
  for (const theme of ['light', 'dark']) await shoot(w, theme);
}
await browser.close();
console.log(`снимки: ${OUT}`);
