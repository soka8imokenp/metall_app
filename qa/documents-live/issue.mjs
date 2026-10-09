/**
 * Документы Э3 — выписка из источника, проверка на живом стенде.
 *
 * Сервер проверен тестами; здесь смотрим то, чего тест не видит: форма выписки
 * находит заказ по номеру, выписанный документ открывается сам, в нём видны
 * табличная часть, реквизиты и сумма прописью, итог таблицы сходится с
 * итогом шапки, и ничего не уезжает вбок на 360.
 *
 * Выписанный документ прогон за собой НЕ удаляет, и это не недосмотр:
 * удаления документов в API нет — номер уже выдан, а выданный номер не
 * исчезает. Отменяют такой документ статусом, и это идёт этапом Э6. За четыре
 * сочетания экрана и темы прогон оставляет на стенде четыре черновика;
 * пересев стенда их убирает.
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

const money = (s) => Number(String(s).replace(/[^\d,.-]/g, '').replace(/\s/g, '').replace(',', '.'));

const browser = await chromium.launch({ channel: 'chromium' });
for (const theme of ['light', 'dark']) {
  for (const [w, h] of [[1440, 900], [360, 800]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    await ctx.addInitScript((t) => localStorage.setItem('metall_theme', t), theme);
    const page = await ctx.newPage();
    const ce = [];
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      if (/\b(409|422|404)\b/.test(m.text())) return;
      ce.push(m.text().slice(0, 160));
    });
    page.on('pageerror', (e) => ce.push('pageerror: ' + String(e).slice(0, 160)));
    await page.goto(STAND, { waitUntil: 'networkidle' });
    await page.locator('input[autocomplete="username"]').first().fill('admin');
    await page.locator('input[autocomplete="current-password"]').first().fill('admin');
    await page.getByRole('button', { name: 'Войти' }).click();
    await page.waitForTimeout(2500);
    await page.getByRole('button', { name: 'Документы', exact: true }).first().click();
    await page.waitForTimeout(2000);
    const tag = `${theme}/${w}`;

    await page.getByRole('button', { name: 'Выписать документ' }).click();
    await page.waitForTimeout(1400);

    // Заказ берём из самой формы: она показывает то, что видно в выбранной
    // компании, а запрос мимо неё вернул бы чужой заказ.
    const dialog = page.getByRole('dialog', { name: 'Выписать документ' });
    const first = dialog.locator('li button').first();
    if (!(await first.count())) {
      errors.push(`${tag}: форма выписки не показала ни одного заказа`);
      await ctx.close();
      continue;
    }
    const orderNumber = (await first.innerText()).split('\n')[0].trim().split(/\s/)[0];

    // Поиск по номеру обязан сузить список до этого заказа.
    await page.getByLabel('Поиск источника').fill(orderNumber);
    await page.waitForTimeout(1500);
    const pick = dialog.locator('li button', { hasText: orderNumber }).first();
    if (!(await pick.count())) {
      errors.push(`${tag}: заказ ${orderNumber} не нашёлся поиском по своему же номеру`);
      await ctx.close();
      continue;
    }
    const order = { number: orderNumber };
    // Пока основание не выбрано, выписывать нечего — кнопка обязана быть заперта.
    if (await page.getByRole('button', { name: 'Выписать', exact: true }).isEnabled()) {
      errors.push(`${tag}: «Выписать» доступна до выбора основания`);
    }
    await pick.click();
    await page.waitForTimeout(400);

    let o = await overflow(page);
    if (o.scrollers.length || o.page) errors.push(`${tag}: форма выписки уезжает вбок ${JSON.stringify(o)}`);
    await page.screenshot({ path: `${OUT}document-issue-${theme}-${w}.png` });

    await page.getByRole('button', { name: 'Выписать', exact: true }).click();
    await page.waitForTimeout(2600);

    // Выписанное открывается сразу: человек жал «выписать», чтобы увидеть документ.
    const card = await page.locator('body').innerText();
    // И об этом сказано словами. Закрывшееся окно — не ответ: если карточка
    // не откроется, человек не узнает, выписан документ или нет.
    if (!/Документ выписан/.test(card)) {
      errors.push(`${tag}: после «Выписать» на экране не сказано, что документ выписан`);
    }
    if (!/К списку/.test(card)) {
      errors.push(`${tag}: после выписки карточка не открылась`);
      await ctx.close();
      continue;
    }
    const number = card.match(/(?:СЧ|ТТН|ДГ|СП|АКТ)-\d{2}\/\d{5}/)?.[0];
    if (!number) errors.push(`${tag}: на карточке нет номера документа`);

    for (const label of ['Реквизиты на момент выписки', 'Сумма прописью', 'Основание']) {
      if (!card.includes(label)) errors.push(`${tag}: на карточке нет блока «${label}»`);
    }
    if (!/сум/i.test(card)) errors.push(`${tag}: сумма прописью не похожа на сумму в сумах`);
    if (!card.includes(order.number)) {
      errors.push(`${tag}: карточка не называет заказ ${order.number}, из которого выписана`);
    }

    // Табличная часть: строки есть, и итог таблицы сходится с итогом шапки.
    if (!/Табличная часть/.test(card)) {
      errors.push(`${tag}: табличной части нет`);
    } else {
      const total = card.match(/Итого\s*\n?\s*([\d\s.,]+)\s*(?:UZS|USD|RUB)/)?.[1];
      const head = card.match(/Сумма\s*\n?\s*([\d\s.,]+)\s*(?:UZS|USD|RUB)/)?.[1];
      if (!total || !head) {
        errors.push(`${tag}: не нашёл итог таблицы или сумму в шапке`);
      } else if (Math.abs(money(total) - money(head)) > 0.005) {
        errors.push(`${tag}: итог таблицы ${total} расходится с суммой в шапке ${head}`);
      }
      // Сумма прописью — тот же реквизит, что число в шапке. Разойдутся
      // копейки — и документ можно не принимать.
      const kop = card.match(/(\d{2}) тийин/)?.[1];
      const headKop = head.trim().split(',')[1];
      if (kop !== undefined && headKop !== undefined && kop !== headKop) {
        errors.push(`${tag}: прописью ${kop} тийин, а в шапке ,${headKop}`);
      }
    }

    o = await overflow(page);
    if (o.scrollers.length || o.page) errors.push(`${tag}: карточка уезжает вбок ${JSON.stringify(o)}`);
    await page.screenshot({ path: `${OUT}document-issued-${theme}-${w}.png` });

    // Выписанное обязано находиться в реестре поиском по номеру — иначе
    // человек его потом не найдёт.
    if (number) {
      const gone = await page.evaluate(async (n) => {
        const t = JSON.parse(sessionStorage.getItem('metall_session') || '{}')?.token;
        const r = await fetch(`/api/v1/documents?search=${encodeURIComponent(n)}&limit=1`, {
          headers: { authorization: `Bearer ${t}` },
        });
        const j = await r.json();
        return j.data?.rows?.[0]?.uid ?? null;
      }, number);
      if (!gone) errors.push(`${tag}: выписанный документ ${number} не нашёлся в реестре`);
    }

    if (ce.length) errors.push(`${tag}: ошибки в консоли: ${ce.join(' | ')}`);
    await ctx.close();
  }
}
await browser.close();

if (errors.length) {
  console.error('НАШЛОСЬ:\n' + errors.map((e) => '  - ' + e).join('\n'));
  process.exit(1);
}
console.log('ВСЁ ЧИСТО: документ выписывается из заказа, строки и реквизиты на месте, итоги сходятся');
