import { chromium } from 'playwright-core';
const URL = 'https://metall-asia.cloudplus.uz';
const EXE = '/home/an/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const [login, password, tag] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
const shoot = async (width, theme, name) => {
  const ctx = await browser.newContext({ viewport: { width, height: width === 360 ? 900 : 950 }, colorScheme: theme });
  const page = await ctx.newPage();
  await page.addInitScript((t) => localStorage.setItem('metall_theme', t), theme);
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  await page.locator('input[autocomplete="username"]').first().fill(login);
  await page.locator('input[autocomplete="current-password"]').first().fill(password);
  await page.getByRole('button', { name: 'Войти' }).click();
  await page.waitForTimeout(3000);
  // У кладовщика в сессии две компании, и первой встаёт торговая: заказы
  // производства живут на заводе, поэтому сначала переключаем компанию.
  // Полоса на 360 свёрнута: там компания живёт в значке с aria-label.
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
  await page.waitForTimeout(2000);

  // Раздел модуля («Отклонения», «Календарь», «Техкарты»): снимок делается
  // прямо на нём, без захода в карточку заказа.
  if (process.env.SECTION) {
    const tabs = page.getByRole('button', { name: process.env.SECTION, exact: true });
    if (await tabs.count()) {
      await tabs.first().click();
      await page.waitForTimeout(2000);
    } else {
      console.log('раздел не найден:', process.env.SECTION);
    }
    await page.screenshot({ path: `/tmp/shots/${name}.png`, fullPage: true });
    console.log('снято:', name);
    await ctx.close();
    return;
  }

  const box = page.locator('input[aria-label="Поиск заказов"]').first();
  await box.fill('ПР-00040');
  await page.waitForTimeout(1500);
  await page.locator('div[class*="divide-y"] > button').first().click();
  await page.waitForTimeout(1800);
  const tab = page.getByRole('button', { name: process.env.TAB ?? 'Материалы', exact: true }).first();
  if (await tab.count()) {
    await tab.scrollIntoViewIfNeeded().catch(() => {});
    await tab.click();
    await page.waitForTimeout(1200);
  } else {
    console.log('вкладка не найдена');
  }
  await page.screenshot({ path: `/tmp/shots/${name}.png`, fullPage: true });
  console.log('снято:', name);
  await ctx.close();
};
await shoot(1440, 'light', `mat-${tag}-1440`);
await shoot(360, 'light', `mat-${tag}-360`);
await browser.close();
