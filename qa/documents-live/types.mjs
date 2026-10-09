/**
 * Документы Э2 — типы и нумерация, проверка на живом стенде.
 *
 * Сервер проверен тестами; здесь смотрим то, чего тест не видит: справочник
 * открывается и показывает маску, счётчик и следующий номер; форма считает
 * пример номера и объясняет отказ словами, а не молчанием; заведённый тип
 * появляется в фильтре реестра; у типа с выданными номерами код и счётчик
 * заблокированы прямо в форме, а не только на сервере. И ничего не уезжает
 * вбок на 360.
 *
 * Прогон убирает за собой заведённый тип.
 */
import { chromium } from 'playwright-core';
const STAND = 'https://metall-asia.cloudplus.uz';
const OUT = new URL('./shots/', import.meta.url).pathname;
const errors = [];
const stamp = String(Date.now()).slice(-4);

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
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      // Отказы сервера на нарочно неверной маске и на удалении занятого типа
      // приходят как 409/422 — это проверяемое поведение, а не поломка.
      if (/\b(409|422)\b/.test(m.text())) return;
      ce.push(m.text().slice(0, 160));
    });
    page.on('pageerror', (e) => ce.push('pageerror: ' + String(e).slice(0, 160)));
    await page.goto(STAND, { waitUntil: 'networkidle' });
    await page.locator('input[autocomplete="username"]').first().fill('admin');
    await page.locator('input[autocomplete="current-password"]').first().fill('admin');
    await page.getByRole('button', { name: 'Войти' }).click();
    await page.waitForTimeout(2500);
    await page.getByRole('button', { name: 'Документы', exact: true }).first().click();
    await page.waitForTimeout(1800);
    await page.getByRole('tab', { name: 'Типы документов' }).click();
    await page.waitForTimeout(1500);
    const tag = `${theme}/${w}`;

    const body = await page.locator('body').innerText();
    if (/Типов нет|Пусто/.test(body)) errors.push(`${tag}: справочник типов пуст`);
    // Маска, счётчик и следующий номер — то, ради чего экран и делался.
    if (!/\{SEQ\}/.test(body)) errors.push(`${tag}: в строке типа не видно маски номера`);
    if (!/следующий/i.test(body)) errors.push(`${tag}: не показан следующий номер`);
    if (!/с начала года|сквозной/.test(body)) errors.push(`${tag}: не видно, как работает счётчик`);

    let o = await overflow(page);
    if (o.scrollers.length || o.page) errors.push(`${tag}: справочник уезжает вбок ${JSON.stringify(o)}`);
    await page.screenshot({ path: `${OUT}document-types-${theme}-${w}.png` });

    // 1. Форма считает пример номера.
    await page.getByRole('button', { name: 'Добавить тип' }).click();
    await page.waitForTimeout(800);

    // 1б. Номер собирается простыми полями, а не маской: маска в форме
    //     читалась шифром, и ошибиться в `{SEQ:3}` было проще, чем попасть.
    await page.getByLabel('Код типа').fill(`QA${stamp}`);
    await page.getByLabel('Начало номера').fill('ПР');
    await page.waitForTimeout(1000);

    const seen = async () => (await page.locator('body').innerText());
    const year = page.getByRole('button', { name: 'Год 26', exact: true });
    const month = page.getByRole('button', { name: 'Месяц', exact: true });
    if (!(await year.count()) || !(await month.count())) {
      errors.push(`${tag}: в форме нет простых полей номера — только маска`);
    } else {
      // Год выключается и включается, и это сразу видно в примере номера.
      if ((await year.getAttribute('aria-pressed')) !== 'true') await year.click();
      await page.waitForTimeout(1100);
      if (!/ПР[-/.]\d{2}[-/.]00001/.test(await seen())) {
        errors.push(`${tag}: с годом пример номера не собрался: ${(await seen()).match(/ПР\S*/)?.[0]}`);
      }
      await year.click();
      await page.waitForTimeout(1100);
      if (/ПР[-/.]\d{2}[-/.]/.test(await seen())) {
        errors.push(`${tag}: год убрали, а он остался в номере`);
      }
      await year.click();
      await page.waitForTimeout(1100);

      // Месяц добавляется своим разделителем, а не слипается с годом.
      await month.click();
      await page.waitForTimeout(1100);
      const withMonth = (await seen()).match(/ПР\S*/)?.[0] ?? '';
      if (!/^ПР[-/.]\d{2}[-/.]\d{2}[-/.]?0*1$/.test(withMonth)) {
        errors.push(`${tag}: с месяцем номер собрался странно: «${withMonth}»`);
      }
      await month.click();
      await page.waitForTimeout(900);

      // Длина счётчика — кнопками, с показанным видом.
      const w4 = page.getByRole('button', { name: '0001', exact: true });
      if (!(await w4.count())) {
        errors.push(`${tag}: длину счётчика нельзя выбрать`);
      } else {
        await w4.click();
        await page.waitForTimeout(1100);
        if (!/ПР[-/.]\d{2}[-/.]0001\b/.test(await seen())) {
          errors.push(`${tag}: счётчик не стал четырёхзначным: ${(await seen()).match(/ПР\S*/)?.[0]}`);
        }
      }

      // Разделитель один на весь номер.
      await page.getByRole('button', { name: '.', exact: true }).click();
      await page.waitForTimeout(1100);
      if (!/ПР\.\d{2}\.0001/.test(await seen())) {
        errors.push(`${tag}: разделитель не применился ко всему номеру: ${(await seen()).match(/ПР\S*/)?.[0]}`);
      }
    }

    // Маска остаётся, но под отдельной кнопкой — для сложных случаев.
    await page.getByRole('button', { name: 'Задать маской' }).click();
    await page.waitForTimeout(700);
    const maskShown = await page.getByLabel('Маска номера').inputValue();
    if (!/\{SEQ(:\d+)?\}/.test(maskShown)) {
      errors.push(`${tag}: под «Задать маской» не та маска: «${maskShown}»`);
    }
    const seqChip = page.getByRole('button', { name: '{SEQ:3}', exact: true });
    if (!(await seqChip.count())) {
      errors.push(`${tag}: подстановки маски нельзя вставить нажатием`);
    } else {
      const mask = page.getByLabel('Маска номера');
      await mask.fill('ПР-/ГОД');
      await mask.click();
      await page.keyboard.press('Home');
      for (let i = 0; i < 3; i += 1) await page.keyboard.press('ArrowRight');
      await seqChip.click();
      await page.waitForTimeout(800);
      if ((await mask.inputValue()) !== 'ПР-{SEQ:3}/ГОД') {
        errors.push(`${tag}: подстановка встала не по курсору: «${await mask.inputValue()}»`);
      }
      // Такую маску простыми полями не собрать — форма обязана сказать это,
      // а не показывать поля, которые её не описывают.
      if (!/сложнее простых полей/.test(await seen())) {
        errors.push(`${tag}: форма не сказала, что маску простыми полями не собрать`);
      }

      // Маска без счётчика — отказ словами, а не молча испорченный номер.
      await mask.fill('ПР-{YY}');
      await page.waitForTimeout(1100);
      const why = await seen();
      if (!/\{SEQ\}/.test(why) || !/номер/i.test(why)) {
        errors.push(`${tag}: маска без счётчика не объяснена словами`);
      }
    }

    // 1в. У кнопок в строке справочника всплывает, для чего они.
    //     Три иконки подряд без подписи читаются наугад.
    const firstRow = page.locator('li', { hasText: 'Счёт на оплату' }).first();
    for (const name of ['Править', 'Удалить']) {
      const title = await firstRow.getByRole('button', { name }).first().getAttribute('title');
      if (!title || title.length < 10) {
        errors.push(`${tag}: у кнопки «${name}» нет всплывающей подсказки: ${title}`);
      }
    }

    // 2. Заведённый тип появляется в фильтре реестра.
    const code = `QA${stamp}`;
    await page.getByLabel('Код типа').fill(code);
    await page.getByLabel('Название по-русски').fill(`Проверка ${stamp}`);
    await page.getByLabel('Название по-узбекски').fill(`Tekshiruv ${stamp}`);
    await page.getByLabel('Маска номера').fill(`КА${stamp}-{YY}/{SEQ}`);
    await page.waitForTimeout(700);
    await page.getByRole('button', { name: 'Сохранить' }).click();
    await page.waitForTimeout(1600);
    const after = await page.locator('body').innerText();
    if (!after.includes(code)) errors.push(`${tag}: заведённый тип не появился в справочнике`);
    if (!new RegExp(`КА${stamp}-\\d{2}/00001`).test(after)) {
      errors.push(`${tag}: у нового типа не показан следующий номер`);
    }

    await page.getByRole('tab', { name: 'Реестр' }).click();
    await page.waitForTimeout(1400);
    await page.getByRole('button', { name: 'Тип документа' }).click();
    await page.waitForTimeout(600);
    const opts = await page.getByRole('option').allInnerTexts();
    if (!opts.some((t) => t.includes(`Проверка ${stamp}`))) {
      errors.push(`${tag}: новый тип не попал в фильтр реестра: ${opts.join(' | ')}`);
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);

    // 3. У типа с выданными номерами код и счётчик заблокированы в форме.
    await page.getByRole('tab', { name: 'Типы документов' }).click();
    await page.waitForTimeout(1400);
    const usedRow = page.locator('li', { hasText: 'Счёт на оплату' }).first();
    await usedRow.getByRole('button', { name: 'Править' }).click();
    await page.waitForTimeout(900);
    const codeInput = page.getByLabel('Код типа');
    if (await codeInput.isEnabled()) {
      errors.push(`${tag}: у типа с выданными номерами код правится прямо в форме`);
    }
    const why = await page.locator('body').innerText();
    if (!/уже выданы номера/i.test(why)) {
      errors.push(`${tag}: форма не объясняет, почему код заблокирован`);
    }
    // Пример в форме правки обязан совпасть с тем, что написано в строке
    // справочника: иначе форма обещает «СЧ-26/00001», а напечатается 00072.
    const nextInRow = (await usedRow.innerText()).match(/СЧ-\d{2}\/\d{5}/)?.[0];
    const nextInForm = why.match(/Следующий номер будет\s*\n?\s*(\S+)/)?.[1];
    if (!nextInRow || nextInForm !== nextInRow) {
      errors.push(`${tag}: в строке следующий номер ${nextInRow}, а в форме ${nextInForm}`);
    }
    o = await overflow(page);
    if (o.scrollers.length || o.page) errors.push(`${tag}: форма типа уезжает вбок ${JSON.stringify(o)}`);
    await page.screenshot({ path: `${OUT}document-type-form-${theme}-${w}.png` });
    await page.getByRole('button', { name: 'Отмена' }).click();
    await page.waitForTimeout(600);

    // 4. Удаление типа с документами объяснено числами, а не отказом молча.
    await usedRow.getByRole('button', { name: 'Удалить' }).click();
    await page.waitForTimeout(1300);
    const refusal = await page.locator('body').innerText();
    if (!/выключают, а не удаляют/i.test(refusal)) {
      errors.push(`${tag}: удаление занятого типа не объяснено словами`);
    }

    // Убираем за собой: свой тип удаляем, он ничем не занят.
    const myRow = page.locator('li', { hasText: code }).first();
    if (await myRow.count()) {
      await myRow.getByRole('button', { name: 'Удалить' }).click();
      await page.waitForTimeout(1300);
      const gone = await page.locator('body').innerText();
      if (gone.includes(code)) errors.push(`${tag}: свободный тип не удалился`);
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
console.log('ВСЁ ЧИСТО: справочник типов открывается, маска считается, запреты объяснены словами');
