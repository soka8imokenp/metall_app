/**
 * CRM → Клиенты: карточка и форма заведения.
 *
 * Проверяем не вёрстку, а согласие двух экранов: в карточке не должно быть
 * поля, которого негде заполнить, и у всех клиентов карточка должна быть
 * одинаковой. Иначе часть данных приходит из посева и выглядит как настройка,
 * которой на самом деле нет.
 */
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
        if (['auto', 'scroll'].includes(st.overflowX)) bad.push((el.className || '').toString().slice(0, 50));
      }
    });
    const d = document.documentElement;
    return { scrollers: bad, page: d.scrollWidth - d.clientWidth };
  });
}

/** «Отсрочка, дн.» и «Отсрочка» — одно поле, сравниваем по сути. */
const norm = (s) => s.replace(/[,:].*$/, '').trim().toLowerCase();

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
    await page.waitForTimeout(2000);
    await page.getByRole('tab', { name: 'Клиенты', exact: true }).first().click();
    await page.waitForTimeout(2000);
    const tag = `${theme}/${w}`;

    const rows = page.locator('ul li button').filter({ hasText: 'ИНН' });
    const count = await rows.count();
    console.log(`${tag}: клиентов на экране ${count}`);
    if (count < 5) errors.push(`${tag}: клиентов ${count}`);

    // 1. Карточка у всех одинаковая: поля не появляются и не исчезают
    //    от того, что посев заполнил их не всем.
    const sets = [];
    for (const i of [0, 1, 2, 3]) {
      if (i >= count) break;
      await rows.nth(i).click();
      await page.waitForTimeout(900);
      const labels = await page.locator('dl dt').allInnerTexts();
      sets.push(labels.map(norm));
    }
    const first = JSON.stringify(sets[0] ?? []);
    sets.forEach((s, i) => {
      if (JSON.stringify(s) !== first) {
        errors.push(`${tag}: карточка ${i + 1} с другим набором полей: ${s.join(', ')} вместо ${sets[0].join(', ')}`);
      }
    });

    // 1а. Правило про удаление живёт на кнопке, а не абзацем в карточке:
    //     числа «сделки — 1» приходят с сервера, а нравоучение рядом с ними
    //     повторялось у каждого клиента и объясняло не то место.
    let withUsage = false;
    for (const i of [0, 1, 2, 3, 4, 5, 6, 7]) {
      if (i >= count) break;
      await rows.nth(i).click();
      await page.waitForTimeout(800);
      const text = await page.locator('body').innerText();
      if (!text.includes('Где участвует')) continue;
      withUsage = true;
      if (/Поэтому его не удаляют/.test(text)) {
        errors.push(`${tag}: правило про удаление осталось абзацем в карточке`);
      }
      const del = page.getByRole('button', { name: 'Удалить', exact: true }).first();
      if (!(await del.count())) {
        errors.push(`${tag}: у клиента с историей нет кнопки удаления — непонятно, почему нельзя`);
      } else {
        if (!(await del.isDisabled())) errors.push(`${tag}: «Удалить» доступна клиенту с историей`);
        const t = (await del.getAttribute('title')) ?? '';
        if (!/\d/.test(t) || !/нельзя/i.test(t)) {
          errors.push(`${tag}: «Удалить» не называет причину числами (title «${t}»)`);
        }
      }
      break;
    }
    if (!withUsage) errors.push(`${tag}: не нашли клиента, у которого есть история`);

    const o = await overflow(page);
    console.log(`${tag}: карточка — скроллеров ${o.scrollers.length}, страница +${o.page}px`);
    if (o.scrollers.length || o.page) errors.push(`${tag}: клиенты уезжают вбок ${JSON.stringify(o)}`);

    // 2. Кнопка «Выключить» объясняет последствие: само слово ничего не говорит,
    //    а действие задевает все списки, где клиент выбирается.
    const off = page.getByRole('button', { name: /^(Выключить|Включить)$/ }).first();
    if (await off.count()) {
      const t = (await off.getAttribute('title')) ?? '';
      if (t.trim().length < 25) errors.push(`${tag}: у «Выключить» нет пояснения (title «${t}»)`);
    } else {
      errors.push(`${tag}: не нашли кнопку «Выключить»`);
    }

    await page.screenshot({ path: `${OUT}/crm-partners-${theme}-${w}.png` });

    // 3. Форма заведения: в ней есть всё, что показывает карточка.
    if (w === 1440) {
      const cardLabels = sets[0] ?? [];
      await page.getByRole('button', { name: 'Добавить клиента' }).click();
      await page.waitForTimeout(700);
      const formText = await page.evaluate(() => {
        const fits = [...document.querySelectorAll('div')].filter(
          (d) =>
            (d.innerText || '').includes('Новый клиент') &&
            [...d.querySelectorAll('button')].some((b) => (b.textContent || '').trim() === 'Завести'),
        );
        return (fits[fits.length - 1]?.innerText ?? '').toLowerCase();
      });
      for (const l of cardLabels) {
        if (!formText.includes(l)) errors.push(`${tag}: поле «${l}» видно в карточке, но его нет в «Добавить клиента»`);
      }
      const o2 = await overflow(page);
      if (o2.scrollers.length || o2.page) errors.push(`${tag}: форма уезжает вбок ${JSON.stringify(o2)}`);
      if (theme === 'light') await page.screenshot({ path: `${OUT}/crm-partner-form.png` });

      // 4. Заведение доходит до конца, а не упирается в невидимое поле.
      if (theme === 'light') {
        const name = `QA Клиент ${Date.now()}`;
        await page.getByRole('textbox').filter({ hasNot: page.locator('[type=number]') }).nth(1).fill(name);
        await page.waitForTimeout(200);
        await page.getByRole('button', { name: 'Завести', exact: true }).click();
        await page.waitForTimeout(2500);
        const after = await page.locator('body').innerText();
        if (!after.includes(name)) {
          errors.push(`${tag}: клиент не завёлся — «${after.split('\n').filter((s) => /не|ошиб|Компан/i.test(s)).slice(0, 2).join(' / ')}»`);
        } else {
          const del = page.getByRole('button', { name: 'Удалить', exact: true }).first();
          if (await del.count()) { await del.click(); await page.waitForTimeout(1500); }
        }
      }
    }

    console.log(`${tag}: ошибки консоли ${ce.length} ${ce.slice(0, 1).join('')}`);
    if (ce.length) errors.push(`${tag}: консоль ${ce[0]}`);
    await ctx.close();
  }
}
await browser.close();
console.log(errors.length ? `--- НЕ ПРОЙДЕН --- ${errors.join(' ;; ')}` : '--- прогон пройден ---');
process.exit(errors.length ? 1 : 0);
