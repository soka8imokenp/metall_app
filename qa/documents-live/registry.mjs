/**
 * Документы Э1 — реестр на живом API, проверка на стенде.
 *
 * Сервер проверен тестами; здесь смотрим то, чего тест не видит: экран правда
 * ушёл с фикстур (номера на экране совпадают с тем, что отдаёт API, а не с
 * выдуманными «СЧ-2024-0001»), вкладки статусов работают фильтром и не
 * пропадают после нажатия, тип в выпадающем списке не задвоен по компаниям,
 * карточка называет источник, и ничего не уезжает вбок на 360.
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

const browser = await chromium.launch({ channel: 'chromium' });
for (const theme of ['light', 'dark']) {
  for (const [w, h] of [[1440, 900], [360, 800]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    await ctx.addInitScript((t) => localStorage.setItem('metall_theme', t), theme);
    const page = await ctx.newPage();
    const ce = [];
    page.on('console', (m) => { if (m.type() === 'error') ce.push(m.text().slice(0, 160)); });
    page.on('pageerror', (e) => ce.push('pageerror: ' + String(e).slice(0, 160)));
    await page.goto(STAND, { waitUntil: 'networkidle' });
    await page.locator('input[autocomplete="username"]').first().fill('admin');
    await page.locator('input[autocomplete="current-password"]').first().fill('admin');
    await page.getByRole('button', { name: 'Войти' }).click();
    await page.waitForTimeout(2500);
    await page.getByRole('button', { name: 'Документы', exact: true }).first().click();
    await page.waitForTimeout(2000);
    const tag = `${theme}/${w}`;

    // 1. Экран ушёл с фикстур: номера на экране те же, что у API.
    const apiNumbers = await page.evaluate(async () => {
      const t = JSON.parse(sessionStorage.getItem('metall_session') || '{}')?.token;
      const r = await fetch('/api/v1/documents?limit=5', { headers: { authorization: `Bearer ${t}` } });
      const j = await r.json();
      return (j.data?.rows ?? []).map((d) => d.number);
    });
    if (!apiNumbers.length) errors.push(`${tag}: API вернул пустой реестр — проверять нечего`);
    const body0 = await page.locator('body').innerText();
    for (const n of apiNumbers) {
      if (!body0.includes(n)) errors.push(`${tag}: номера ${n} из API на экране нет`);
    }
    if (/СЧ-2024-000/.test(body0)) errors.push(`${tag}: на экране остались фикстуры`);

    // 2. Вкладки статусов: фильтруют и сами не пропадают.
    const tabAll = page.getByRole('tab', { name: /^Все / });
    const allText = await tabAll.innerText();
    const totalAll = Number(allText.replace(/\D+/g, ''));
    if (!totalAll) errors.push(`${tag}: вкладка «Все» без числа: «${allText}»`);
    const pending = page.getByRole('tab', { name: /^На согласовании / });
    const pendingN = Number((await pending.innerText()).replace(/\D+/g, ''));
    await pending.click();
    await page.waitForTimeout(1200);
    const afterText = await page.getByRole('tab', { name: /^На согласовании / }).innerText();
    if (Number(afterText.replace(/\D+/g, '')) !== pendingN) {
      errors.push(`${tag}: счётчик «на согласовании» поменялся после нажатия: ${pendingN} → ${afterText}`);
    }
    const rowsAfter = await page.locator('li button').count();
    const statuses = await page.locator('li button').evaluateAll((els) =>
      els.map((e) => e.innerText.includes('На согласовании')));
    if (rowsAfter && statuses.some((ok) => !ok)) {
      errors.push(`${tag}: после фильтра по статусу в списке есть чужие строки`);
    }
    if (pendingN >= totalAll) errors.push(`${tag}: «на согласовании» не меньше «всех» — фильтр ничего не значит`);
    await tabAll.click();
    await page.waitForTimeout(1000);

    // 3. Тип документа не задвоен по компаниям.
    //
    // Дубль виден только в режиме холдинга: под одной компанией справочник
    // отдаёт по одной строке на код, и проверка зелёная при любом коде экрана.
    // Поэтому переключаемся на «все компании» тем же переключателем, что и
    // человек — и только там спрашиваем список типов.
    await page.locator('aside [data-company-switch="logo"]').first().click();
    await page.waitForTimeout(500);
    await page.getByText('Сводный холдинг', { exact: false }).first().click({ timeout: 5000 });
    await page.waitForTimeout(1600);
    const holdingRows = await page.locator('li button').count();
    if (!holdingRows) errors.push(`${tag}: в режиме холдинга реестр пуст`);
    // Переключатель компании меняет заголовок запроса, но не перезапрашивает
    // экран сам: если экран не подписан на смену, в холдинге останется список
    // торгового дома, и число во «всех» не изменится.
    const holdingAll = Number((await page.getByRole('tab', { name: /^Все / }).innerText()).replace(/\D+/g, ''));
    if (holdingAll <= totalAll) {
      errors.push(`${tag}: в холдинге документов не больше, чем в торговом доме (${totalAll} → ${holdingAll}) — экран не перечитался`);
    }

    // Нумерация у компаний своя: в холдинге одинаковые номера обязаны быть
    // различимы, иначе строки «ТТН-26/00003» и «ТТН-26/00003» — загадка.
    const numbers = await page.locator('li button').evaluateAll((els) =>
      els.map((e) => e.innerText.split('\n')[0].trim()));
    const repeated = numbers.filter((n, i) => numbers.indexOf(n) !== i);
    if (repeated.length) {
      const marks = await page.locator('li button').evaluateAll((els) =>
        els.map((e) => e.innerText));
      const unmarked = repeated.filter((n) =>
        !marks.some((m) => m.startsWith(n) && /\b(trade|plant)\b/.test(m)));
      if (unmarked.length) {
        errors.push(`${tag}: в холдинге повторяются номера без пометки компании: ${[...new Set(unmarked)].join(', ')}`);
      }
    }

    const typeSelect = page.getByRole('button', { name: 'Тип документа' });
    await typeSelect.click();
    await page.waitForTimeout(500);
    const opts = await page.getByRole('option').allInnerTexts();
    const dup = opts.filter((o, i) => opts.indexOf(o) !== i);
    if (dup.length) errors.push(`${tag}: типы задвоены в списке: ${dup.join(', ')}`);
    if (opts.length < 3) errors.push(`${tag}: в списке типов всего ${opts.length} строк`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);

    // Фильтр, сжатый до «Ном» и двух стрелок без подписи, формально помещается
    // на экран — и им нельзя пользоваться. Ширину в точках тут мерить нечем:
    // поле даты в 114 точек читается, поле типа в 114 — уже нет. Смотрим то,
    // что видит человек: подпись поля не должна быть обрезана.
    const panelWidth =
      (await page.locator('input[aria-label="Поиск по номеру"]').first()
        .evaluate((n) => n.closest('div.flex.flex-wrap')?.clientWidth ?? 0)) || 0;
    if (!panelWidth) errors.push(`${tag}: не нашёл панель фильтров, ширину мерить не от чего`);

    for (const [name, sel] of [
      ['поиск', 'input[aria-label="Поиск по номеру"]'],
      ['тип', 'button[aria-label="Тип документа"]'],
      ['дата с', '[aria-label="Дата с"]'],
      ['дата по', '[aria-label="Дата по"]'],
    ]) {
      const el = page.locator(sel).first();
      if (!(await el.count())) { errors.push(`${tag}: фильтра «${name}» на экране нет`); continue; }
      const clipped = await el.evaluate((node) => {
        // Мерить обрезку по scrollWidth нельзя: у элемента с многоточием он
        // равен clientWidth, и «Дата…» выглядит как полностью помещающийся
        // текст. Поэтому считаем настоящую ширину надписи скрытой копией
        // в том же начертании и сравниваем с местом, которое ей отвели.
        const width = (text, font) => {
          const probe = document.createElement('span');
          probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre';
          probe.style.font = font;
          probe.textContent = text;
          document.body.appendChild(probe);
          const w = probe.offsetWidth;
          probe.remove();
          return w;
        };
        if (node.tagName === 'INPUT') {
          const t = node.placeholder || '';
          return t && width(t, getComputedStyle(node).font) > node.clientWidth - 8 ? t.slice(0, 30) : null;
        }
        for (const n of node.querySelectorAll('*')) {
          const t = (n.childElementCount ? '' : n.textContent || '').trim();
          if (!t) continue;
          // Надпись лежит в inline-span с нулевыми размерами, место ей даёт
          // ближайший предок, который её и обрезает.
          let box = n;
          while (box && !box.clientWidth) box = box.parentElement;
          if (!box) continue;
          if (width(t, getComputedStyle(n).font) > box.clientWidth + 1) return t.slice(0, 30);
        }
        return null;
      });
      if (clipped) errors.push(`${tag}: у фильтра «${name}» обрезана подпись «${clipped}»`);

      // Замер ширины текста ловит не всё: «Дата с» не влезала в поле на две
      // точки, и арифметика по шрифту это проглатывала, а глазами было видно
      // «Дата…». Поэтому на узком экране проверяем правило вёрстки прямо:
      // фильтр занимает строку целиком, а не делит её с соседом.
      if (w < 640) {
        const box = await el.boundingBox();
        if (box && box.width < panelWidth * 0.6) {
          errors.push(
            `${tag}: фильтр «${name}» делит строку с соседом — ${Math.round(box.width)} точек из ${Math.round(panelWidth)}`,
          );
        }
      }
    }

    let o = await overflow(page);
    if (o.scrollers.length || o.page) errors.push(`${tag}: реестр уезжает вбок ${JSON.stringify(o)}`);
    await page.screenshot({ path: `${OUT}documents-list-${theme}-${w}.png`, fullPage: false });

    // 4. Карточка: источник назван, реквизиты на месте.
    await page.locator('li button').first().click();
    await page.waitForTimeout(1200);
    const card = await page.locator('body').innerText();
    for (const label of ['Тип', 'Дата', 'Контрагент', 'Сумма', 'Основание', 'Файлы']) {
      if (!card.includes(label)) errors.push(`${tag}: на карточке нет поля «${label}»`);
    }
    if (!/(Заказ|Сделка|Платёж|Производство)\s+\S+/.test(card)) {
      errors.push(`${tag}: карточка не называет источник документа`);
    }
    o = await overflow(page);
    if (o.scrollers.length || o.page) errors.push(`${tag}: карточка уезжает вбок ${JSON.stringify(o)}`);
    await page.screenshot({ path: `${OUT}documents-card-${theme}-${w}.png`, fullPage: false });

    await page.getByRole('button', { name: 'К списку' }).click();
    await page.waitForTimeout(900);
    if (!(await page.locator('li button').count())) errors.push(`${tag}: возврат к списку показал пустой реестр`);

    if (ce.length) errors.push(`${tag}: ошибки в консоли: ${ce.join(' | ')}`);
    await ctx.close();
  }
}
await browser.close();

if (errors.length) {
  console.error('НАШЛОСЬ:\n' + errors.map((e) => '  - ' + e).join('\n'));
  process.exit(1);
}
console.log('ВСЁ ЧИСТО: реестр на живом API, статусы фильтруют, типы не задвоены, карточка называет источник');
