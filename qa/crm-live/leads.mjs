import { chromium } from 'playwright-core';
const STAND = 'https://metall-asia.cloudplus.uz';
const OUT = new URL('./shots/', import.meta.url).pathname;
const errors = [];
async function overflow(page) {
  return await page.evaluate(() => {
    const bad = [];
    document.querySelectorAll('*').forEach((el) => {
      if (el.scrollWidth - el.clientWidth > 1 && el.clientWidth > 0) {
        const st = getComputedStyle(el);
        if (['auto','scroll'].includes(st.overflowX)) bad.push((el.className||'').toString().slice(0,50));
      }
    });
    const d = document.documentElement;
    return { scrollers: bad, page: d.scrollWidth - d.clientWidth };
  });
}
const browser = await chromium.launch({ channel: 'chromium' });
for (const theme of ['light','dark']) {
  for (const [w,h] of [[1440,900],[360,800]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    await ctx.addInitScript((t) => localStorage.setItem('metall_theme', t), theme);
    const page = await ctx.newPage();
    const ce = [];
    page.on('console', (m) => { if (m.type()==='error') ce.push(m.text()); });
    await page.goto(STAND, { waitUntil: 'networkidle' });
    await page.locator('input[autocomplete="username"]').first().fill('admin');
    await page.locator('input[autocomplete="current-password"]').first().fill('admin');
    await page.getByRole('button', { name: 'Войти' }).click();
    await page.waitForTimeout(2500);
    await page.getByRole('button', { name: 'CRM', exact: true }).first().click();
    await page.waitForTimeout(2500);
    const tag = `${theme}/${w}`;
    const body = await page.locator('body').innerText();
    if (!/Новое|В работе|Стал клиентом|Отказ/.test(body)) errors.push(`${tag}: нет разбивки по статусам`);
    const items = await page.locator('ul li').count();
    console.log(`${tag}: обращений на экране ${items}`);
    if (items < 5) errors.push(`${tag}: обращений ${items}`);
    const o = await overflow(page);
    console.log(`${tag}: обращения — скроллеров ${o.scrollers.length}, страница +${o.page}px`);
    if (o.scrollers.length || o.page) errors.push(`${tag}: обращения уезжают вбок ${JSON.stringify(o)}`);
    // Кнопки строки живут справа, а не в общей куче слева: на 1440 правая
    // половина панели иначе пустует. Проверяем геометрией, а не классами —
    // класс можно оставить, а колонку сломать.
    if (w === 1440) {
      const place = await page.evaluate(() => {
        const row = [...document.querySelectorAll('ul li')].find((li) =>
          [...li.querySelectorAll('button')].some((b) => /Сделать клиентом/.test(b.textContent || '')),
        );
        if (!row) return null;
        // Берём всю группу, а не одну кнопку: «Сделать клиентом» стоит
        // посередине группы, и по ней край не измеришь.
        // Узкая копия кнопок скрыта через lg:hidden — у неё нулевой прямоугольник.
        const boxes = [...row.querySelectorAll('button')]
          .map((b) => b.getBoundingClientRect())
          .filter((b) => b.width > 0);
        const r = row.getBoundingClientRect();
        return {
          rowLeft: r.left,
          rowRight: r.right,
          btnLeft: Math.min(...boxes.map((b) => b.left)),
          btnRight: Math.max(...boxes.map((b) => b.right)),
        };
      });
      if (!place) {
        errors.push(`${tag}: не нашли строку с кнопкой «Сделать клиентом»`);
      } else {
        const middle = place.rowLeft + (place.rowRight - place.rowLeft) / 2;
        if (place.btnLeft < middle) {
          errors.push(
            `${tag}: кнопки обращения слева — начало ${Math.round(place.btnLeft)} при середине ${Math.round(middle)}`,
          );
        }
        // И у правого края, а не посередине: иначе колонка просто уехала.
        // 16 точек — это `px-4` самой строки, остальное было бы съехавшей колонкой.
        if (place.rowRight - place.btnRight > 24) {
          errors.push(
            `${tag}: кнопки не прижаты к правому краю строки (${Math.round(place.rowRight - place.btnRight)}px)`,
          );
        }
      }
    }
    await page.screenshot({ path: `${OUT}/crm-leads-${theme}-${w}.png` });
    // форма приёма обращения раскрывается и просит источник
    if (w === 1440 && theme === 'light') {
      await page.getByRole('button', { name: 'Принять обращение' }).click();
      await page.waitForTimeout(600);
      const form = await page.locator('body').innerText();
      if (!/Источник обязателен/.test(form)) errors.push(`${tag}: форма не объясняет обязательность источника`);
      const btn = page.getByRole('button', { name: 'Принять', exact: true });
      if (!(await btn.isDisabled())) errors.push(`${tag}: «Принять» доступна без источника`);
      const o2 = await overflow(page);
      if (o2.scrollers.length || o2.page) errors.push(`${tag}: форма уезжает вбок ${JSON.stringify(o2)}`);
      await page.screenshot({ path: `${OUT}/crm-lead-form.png` });
    }
    console.log(`${tag}: ошибки консоли ${ce.length} ${ce.slice(0,1).join('')}`);
    if (ce.length) errors.push(`${tag}: консоль ${ce[0]}`);
    await ctx.close();
  }
}
await browser.close();
console.log(errors.length ? `--- НЕ ПРОЙДЕН --- ${errors.join(' ;; ')}` : '--- прогон пройден ---');
process.exit(errors.length ? 1 : 0);
