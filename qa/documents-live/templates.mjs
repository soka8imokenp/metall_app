/**
 * Документы Э4 — шаблоны печатных форм на живом стенде.
 *
 * Сервер закрыт тестами; здесь то, чего тест не видит: порядок работы виден
 * глазами и проходится мышью — загрузил файл, увидел чужой тег, сопоставил,
 * проверил, опубликовал. И главное: кнопка «Скачать DOCX» в карточке отдаёт
 * файл, а не молчит.
 *
 * Прогон убирает за собой: снимает свою публикацию, возвращает черновую форму
 * посева и удаляет загруженный шаблон.
 */
import { chromium } from 'playwright-core';
// Заготовку DOCX собираем тем же кодом, что и сервер: второй сборщик Word
// в прогоне рано или поздно разошёлся бы с настоящим.
import { buildDocx } from '../../backend/dist/documents/docx-build.js';
import JSZip from '../../backend/node_modules/jszip/dist/jszip.min.js';

/** Текст собранного DOCX — чтобы смотреть, что подставилось, а не что осталось. */
async function docxText(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file('word/document.xml').async('string');
  return xml.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&');
}

const STAND = 'https://metall-asia.cloudplus.uz';
const OUT = new URL('./shots/', import.meta.url).pathname;
const errors = [];
const stamp = String(Date.now()).slice(-5);

/** Шаблон с чужим тегом — ровно тот случай, ради которого есть сопоставление. */
const alien = await buildDocx([
  { kind: 'p', text: `QA${stamp} {НомерСчета} от {doc.date}`, bold: true },
  { kind: 'p', text: '{company.name} / {partner.name}' },
  {
    kind: 'table',
    head: true,
    rows: [
      ['№', 'Наименование', 'Сумма'],
      ['{#lines}{seq}', '{name}', '{total}{/lines}'],
    ],
  },
  { kind: 'p', text: 'Всего: {amount.total} {currency}, прописью {amount.words}' },
]);

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
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, acceptDownloads: true });
    await ctx.addInitScript((t) => localStorage.setItem('metall_theme', t), theme);
    const page = await ctx.newPage();
    const ce = [];
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      // 409/422 здесь — проверяемое поведение: публикация непроверенного
      // шаблона и отказ в удалении напечатанного.
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
    const tag = `${theme}/${w}`;

    // --- 1. Карточка документа отдаёт файл ---------------------------------
    await page.locator('ul li button').first().click();
    await page.waitForTimeout(1800);
    const cardNumber = (await page.locator('h2').last().innerText()).trim();
    // Без этой строчки проверка ниже стала бы пустой: `includes('')` истинно
    // всегда, и сломанная сборка прошла бы молча.
    if (!/\d/.test(cardNumber)) errors.push(`${tag}: не нашли номер в карточке: «${cardNumber}»`);
    const [dl] = await Promise.all([
      page.waitForEvent('download', { timeout: 20_000 }).catch(() => null),
      page.getByRole('button', { name: /^DOCX$/ }).click(),
    ]);
    if (!dl) {
      errors.push(`${tag}: кнопка DOCX не отдала файл`);
    } else {
      const name = dl.suggestedFilename();
      // Имя из номера документа, а не «document.docx»: в папке «Загрузки»
      // десяток одинаковых имён не различить.
      if (!/\.docx$/.test(name) || /^_+/.test(name)) {
        errors.push(`${tag}: файл сохраняется под именем «${name}»`);
      }
      const path = await dl.path();
      const { readFileSync } = await import('node:fs');
      const bytes = readFileSync(path);
      const head = bytes.subarray(0, 2).toString();
      if (head !== 'PK') {
        errors.push(`${tag}: скачался не DOCX (начало «${head}»)`);
      } else {
        // Смотрим внутрь: «файл скачался» ещё не значит, что в нём бумага.
        const text = await docxText(bytes);
        if (!text.includes(cardNumber)) {
          errors.push(`${tag}: в собранной форме нет номера документа ${cardNumber}`);
        }
        if (/\{[A-Za-zА-Яа-я#/]/.test(text)) {
          errors.push(`${tag}: в собранной форме остались незаполненные теги`);
        }
      }
    }
    await page.screenshot({ path: `${OUT}document-print-${theme}-${w}.png` });
    await page.getByRole('button', { name: 'К списку' }).click();
    await page.waitForTimeout(1200);

    // --- 2. Список шаблонов -------------------------------------------------
    await page.getByRole('tab', { name: 'Шаблоны' }).click();
    await page.waitForTimeout(1800);
    let body = await page.locator('body').innerText();
    if (/Шаблонов нет/.test(body)) errors.push(`${tag}: список шаблонов пуст`);
    for (const need of ['Счёт на оплату', 'публикуется', 'версия']) {
      if (!body.includes(need)) errors.push(`${tag}: в списке шаблонов нет «${need}»`);
    }
    let o = await overflow(page);
    if (o.scrollers.length || o.page) errors.push(`${tag}: список шаблонов уезжает вбок ${JSON.stringify(o)}`);
    await page.screenshot({ path: `${OUT}document-templates-${theme}-${w}.png` });

    // --- 3. Загрузка: чужой тег назван, публикация не проходит -------------
    // Файл выбирают мышью, а не `setInputFiles`: скрытый input можно наполнить
    // из прогона и не заметить, что видимая кнопка не открывает окно выбора.
    const pickBtn = page.getByRole('button', { name: 'Выбрать файл', exact: true }).first();
    if (!(await pickBtn.count())) {
      errors.push(`${tag}: в панели загрузки нет кнопки «Выбрать файл»`);
      await ctx.close();
      continue;
    }
    // Тип ещё не выбран — кнопка обязана ответить объяснением, а не молчанием.
    // Отказ смотрим до и после нажатия: иначе проверка поймала бы подсказку,
    // которая висит на панели и так, и прошла бы на молчащей кнопке.
    const refused = () => page.locator('body').innerText().then((t) => /Тип документа не выбран/.test(t));
    if (await refused()) errors.push(`${tag}: отказ «тип не выбран» показан до нажатия`);
    await pickBtn.click();
    await page.waitForTimeout(500);
    if (!(await refused())) {
      errors.push(`${tag}: кнопка «Выбрать файл» без выбранного типа молчит`);
    }
    await page.getByRole('button', { name: 'Тип документа' }).click();
    await page.waitForTimeout(600);
    await page.getByRole('option', { name: /Счёт на оплату/ }).first().click();
    await page.waitForTimeout(400);
    const fileName = `qa-${stamp}-${theme}-${w}.docx`;
    const chooser = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 8000 }).catch(() => null),
      pickBtn.click(),
    ]).then((r) => r[0]);
    if (!chooser) {
      errors.push(`${tag}: кнопка «Выбрать файл» не открывает окно выбора файла`);
      await ctx.close();
      continue;
    }
    await chooser.setFiles({
      name: fileName,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: alien,
    });
    await page.waitForTimeout(2200);

    const mine = page.locator('li', { hasText: fileName }).first();
    if (!(await mine.count())) {
      errors.push(`${tag}: загруженный шаблон не появился в списке`);
      if (ce.length) errors.push(`${tag}: ошибки в консоли: ${ce.join(' | ')}`);
      await ctx.close();
      continue;
    }
    let mineText = await mine.innerText();
    if (!/черновик/.test(mineText)) {
      errors.push(`${tag}: свежезагруженный шаблон сразу печатается — проверки нет`);
    }
    if (!/теги без поля/.test(mineText)) {
      errors.push(`${tag}: чужой тег в файле не отмечен в строке`);
    }

    await mine.getByRole('button', { name: 'Проверить' }).click();
    await page.waitForTimeout(1600);
    mineText = await mine.innerText();
    if (!/НомерСчета/.test(mineText)) {
      errors.push(`${tag}: проверка не назвала тег, который не заполнится: ${mineText.slice(0, 200)}`);
    }

    await mine.getByRole('button', { name: 'Опубликовать' }).click();
    await page.waitForTimeout(1600);
    body = await page.locator('body').innerText();
    if (!/НомерСчета/.test(body)) {
      errors.push(`${tag}: отказ в публикации не объяснён тегом`);
    }
    if (/публикуется/.test(await mine.innerText())) {
      errors.push(`${tag}: непроверенный шаблон всё-таки опубликовался`);
    }

    // --- 4. Сопоставление и публикация -------------------------------------
    await mine.getByRole('button', { name: 'Теги' }).click();
    await page.waitForTimeout(900);
    const dialog = page.getByRole('dialog', { name: 'Сопоставление тегов' });
    if (!(await dialog.count())) {
      errors.push(`${tag}: диалог сопоставления не открылся`);
    } else {
      o = await overflow(page);
      if (o.scrollers.length || o.page) {
        errors.push(`${tag}: диалог сопоставления уезжает вбок ${JSON.stringify(o)}`);
      }
      await page.screenshot({ path: `${OUT}document-template-mapping-${theme}-${w}.png` });
      await dialog.getByRole('button', { name: 'Поле НомерСчета' }).click();
      await page.waitForTimeout(500);
      await page.getByRole('option', { name: /^doc\.number/ }).first().click();
      await page.waitForTimeout(400);
      await dialog.getByRole('button', { name: 'Сохранить и проверить' }).click();
      await page.waitForTimeout(2200);
    }

    mineText = await mine.innerText();
    if (/теги без поля/.test(mineText)) {
      errors.push(`${tag}: после сопоставления тег всё ещё считается чужим`);
    }
    await mine.getByRole('button', { name: 'Опубликовать' }).click();
    await page.waitForTimeout(2000);
    mineText = await mine.innerText();
    if (!/публикуется/.test(mineText)) {
      errors.push(`${tag}: сопоставленный и проверенный шаблон не опубликовался: ${mineText.slice(0, 200)}`);
    }
    // Опубликованный на тип и язык один: черновая форма посева обязана сняться.
    const seeded = page.locator('li', { hasText: 'inv-ru-черновик.docx' }).first();
    if ((await seeded.count()) && /публикуется/.test(await seeded.innerText())) {
      errors.push(`${tag}: на тип и язык осталось два опубликованных шаблона`);
    }

    // --- 5. Убираем за собой -----------------------------------------------
    await mine.getByRole('button', { name: 'Снять' }).click();
    await page.waitForTimeout(1600);
    if (await seeded.count()) {
      await seeded.getByRole('button', { name: 'Опубликовать' }).click();
      await page.waitForTimeout(1800);
      if (!/публикуется/.test(await seeded.innerText())) {
        errors.push(`${tag}: черновую форму посева не удалось вернуть в печать`);
      }
    }
    if (await mine.count()) {
      await mine.getByRole('button', { name: 'Удалить' }).click();
      await page.waitForTimeout(1600);
      if (await page.locator('li', { hasText: fileName }).count()) {
        errors.push(`${tag}: свой шаблон не удалился — останется мусором на стенде`);
      }
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
console.log('ВСЁ ЧИСТО: шаблон загружается, чужой тег назван, до сопоставления не публикуется, DOCX скачивается');
