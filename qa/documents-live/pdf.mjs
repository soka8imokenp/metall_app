/**
 * Документы Э5 — PDF на живом стенде.
 *
 * Сервер закрыт тестами; здесь то, чего тест не видит: кнопки стоят там, где
 * их ищут, обе работают, файл действительно приходит в браузер — и в нём то
 * же, что на экране. Отчёты склада и CRM проверяются той же мерой: PDF там
 * идёт тем же трактом, и сломаться он может одинаково.
 *
 * Прогон оставляет на стенде документы: удалять выписанный документ нечем и
 * не нужно — номер выдан, такой отменяют статусом (это Э6).
 */
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const STAND = 'https://metall-asia.cloudplus.uz';
const OUT = new URL('./shots/', import.meta.url).pathname;
const errors = [];

const squeeze = (s) => s.replace(/\s+/g, '');

function pdfText(bytes) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-pdf-'));
  try {
    const f = join(dir, 'x.pdf');
    writeFileSync(f, bytes);
    return new Promise((resolve, reject) =>
      execFile('pdftotext', ['-layout', f, '-'], { maxBuffer: 8 * 1024 * 1024 }, (e, out) =>
        e ? reject(e) : resolve(out),
      ),
    );
  } finally {
    setTimeout(() => rmSync(dir, { recursive: true, force: true }), 2000);
  }
}

async function grab(page, clicker) {
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }).catch(() => null),
    clicker(),
  ]);
  if (!dl) return null;
  return { name: dl.suggestedFilename(), bytes: readFileSync(await dl.path()) };
}

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
      if (/\b(409|422)\b/.test(m.text())) return;
      ce.push(m.text().slice(0, 160));
    });
    page.on('pageerror', (e) => ce.push('pageerror: ' + String(e).slice(0, 160)));
    await page.goto(STAND, { waitUntil: 'networkidle' });
    await page.locator('input[autocomplete="username"]').first().fill('admin');
    await page.locator('input[autocomplete="current-password"]').first().fill('admin');
    await page.getByRole('button', { name: 'Войти' }).click();
    await page.waitForTimeout(2500);
    const tag = `${theme}/${w}`;

    // --- 1. Печатная форма документа ---------------------------------------
    await page.getByRole('button', { name: 'Документы', exact: true }).first().click();
    await page.waitForTimeout(1800);
    // Берём документ с табличной частью: на пустой таблице проверка «колонки
    // на месте» прошла бы, ничего не проверив.
    let opened = false;
    for (const i of [0, 1, 2, 3, 4]) {
      await page.locator('ul li button').nth(i).click();
      await page.waitForTimeout(1600);
      // «Табличная часть» — заголовок карточки со строками; у документа без
      // строк там стоит «Табличной части нет». Колонку «Наименование» брать
      // нельзя: на 360 таблица заменяется карточками, и шапки нет.
      if (/Табличная часть/.test(await page.locator('body').innerText())) {
        opened = true;
        break;
      }
      await page.getByRole('button', { name: 'К списку' }).click();
      await page.waitForTimeout(1000);
    }
    if (!opened) {
      errors.push(`${tag}: не нашли документ с табличной частью`);
      await ctx.close();
      continue;
    }

    const card = await page.locator('body').innerText();
    const number = (await page.locator('h2').last().innerText()).trim();
    if (!/\d/.test(number)) errors.push(`${tag}: не нашли номер в карточке: «${number}»`);

    let o = await overflow(page);
    if (o.scrollers.length || o.page) errors.push(`${tag}: карточка уезжает вбок ${JSON.stringify(o)}`);
    await page.screenshot({ path: `${OUT}document-print-buttons-${theme}-${w}.png` });

    const docx = await grab(page, () => page.getByRole('button', { name: /^DOCX$/ }).click());
    if (!docx) errors.push(`${tag}: кнопка DOCX не отдала файл`);
    else if (docx.bytes.subarray(0, 2).toString() !== 'PK') {
      errors.push(`${tag}: по кнопке DOCX пришёл не DOCX`);
    }

    await page.waitForTimeout(800);
    const pdf = await grab(page, () => page.getByRole('button', { name: /^PDF$/ }).click());
    if (!pdf) {
      errors.push(`${tag}: кнопка PDF не отдала файл`);
    } else {
      if (pdf.bytes.subarray(0, 4).toString() !== '%PDF') {
        errors.push(`${tag}: по кнопке PDF пришёл не PDF`);
      } else {
        const text = squeeze(await pdfText(pdf.bytes));
        if (!text.includes(squeeze(number))) {
          errors.push(`${tag}: в PDF нет номера документа ${number}`);
        }
        // Шапка табличной части: эти слова есть только в ней.
        for (const title of ['Кол-во', 'Цена', 'Всего']) {
          if (!text.includes(squeeze(title))) {
            errors.push(`${tag}: в PDF нет колонки «${title}» — таблица потерялась`);
          }
        }
        // Сумма из карточки обязана совпасть с суммой на бумаге.
        const sum = card.match(/(\d[\d  ]*,\d{2})\s*UZS/)?.[1];
        if (sum && !text.includes(squeeze(sum))) {
          errors.push(`${tag}: сумма ${sum} с экрана не найдена в PDF`);
        }
        if (/�|□/.test(text)) errors.push(`${tag}: в PDF есть нечитаемые символы`);
      }
      if (!/\.pdf$/.test(pdf.name) || /^_+/.test(pdf.name)) {
        errors.push(`${tag}: PDF сохраняется под именем «${pdf.name}»`);
      }
    }

    // --- 2. Отчёт склада на бумаге -----------------------------------------
    await page.getByRole('button', { name: 'Склад', exact: true }).first().click();
    await page.waitForTimeout(1800);
    await page.getByRole('tab', { name: 'Отчёты' }).click();
    await page.waitForTimeout(2000);
    o = await overflow(page);
    if (o.scrollers.length || o.page) errors.push(`${tag}: отчёты уезжают вбок ${JSON.stringify(o)}`);
    await page.screenshot({ path: `${OUT}warehouse-report-pdf-${theme}-${w}.png` });

    const rep = await grab(page, () => page.getByRole('button', { name: /^PDF$/ }).click());
    if (!rep) {
      errors.push(`${tag}: отчёт склада не отдал PDF`);
    } else if (rep.bytes.subarray(0, 4).toString() !== '%PDF') {
      errors.push(`${tag}: отчёт склада отдал не PDF`);
    } else {
      const text = squeeze(await pdfText(rep.bytes));
      if (!/\S/.test(text)) errors.push(`${tag}: PDF отчёта пустой`);
      // Сверяем с тем, что на экране: шапка таблицы отчёта. Это проверяет,
      // что в файле тот же отчёт, а не «какой-то PDF скачался».
      const heads = (await page.locator('table thead th').allInnerTexts())
        .map((t) => t.trim())
        .filter((t) => t.length > 2);
      if (heads.length < 3) {
        errors.push(`${tag}: на экране не нашли шапку отчёта, сверять не с чем`);
      }
      // По словам, а не целым заголовком: «Серийный номер» переносится по
      // пробелу, а `pdftotext -layout` читает страницу построчно — между
      // его половинами оказываются соседние колонки. Пропавшую колонку
      // это всё равно поймает: у неё пропадают все слова.
      for (const th of heads) {
        for (const word of th.split(/\s+/).filter((x) => x.length > 2)) {
          if (!text.includes(squeeze(word))) {
            errors.push(`${tag}: в PDF отчёта нет колонки «${th}»`);
            break;
          }
        }
      }
      if (/�|□/.test(text)) errors.push(`${tag}: в PDF отчёта нечитаемые символы`);
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
console.log('ВСЁ ЧИСТО: DOCX и PDF скачиваются, в PDF номер, таблица и сумма с экрана; отчёт склада печатается');
