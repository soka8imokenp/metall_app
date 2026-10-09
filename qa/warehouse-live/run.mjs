/**
 * Прогон страницы «Склад» против живого бэкенда.
 *
 * Проверяет то, чего не видно на скриншоте:
 *   1) на экране нет складов, партий и предупреждений из импортированного
 *      макета — они были вбиты в вёрстку и не существуют ни в одной таблице;
 *   2) данные пришли: сводка с цифрами, строки остатков, путь партии с
 *      движениями, и остаток в строке сходится с суммой её журнала;
 *   3) фильтры действительно фильтруют, а не только красят кнопку;
 *   4) содержимое не вылезает за контейнер на 360 и 1440 в обеих темах.
 *
 * Всё в одном переднем процессе: фоновые запуски запрещены, бэкенд поднимается
 * дочерним процессом и глушится в finally.
 *
 * Перед запуском собрать фронт с живым API:
 *   cd dev/frontend && bun run build:qa   # сборка для прогона, каталог dist-qa
 *
 * Запуск:
 *   cd dev/qa && bun run warehouse-live
 */
import { spawn } from 'node:child_process';
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { chromium } from 'playwright-core';

/** Наименьший настоящий png: прикладываем его, а не текст с расширением. */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '../../frontend/dist-qa');
const BACKEND = path.resolve(HERE, '../../backend');
const OUT = path.resolve(HERE, 'shots');
/**
 * Порт 4400, а не 4000: на 4000 живёт внешний стенд (юнит
 * `metall-asia-stand-api`), у него своя база. Прогон, попавший на чужой
 * бэкенд, врёт молча — поэтому занятый порт здесь ошибка, а не предупреждение.
 */
const API_PORT = Number(process.env.QA_API_PORT ?? 4400);

async function assertPortFree() {
  const res = await fetch(`http://127.0.0.1:${API_PORT}/api/v1/dashboard/summary`).catch(() => null);
  if (res) {
    throw new Error(
      `порт ${API_PORT} уже занят: на нём кто-то отвечает (${res.status}). ` +
        'Останови чужой процесс или задай QA_API_PORT.',
    );
  }
}

const API = `http://127.0.0.1:${API_PORT}/api/v1`;
/** Кладовщик: у него есть `warehouse.view` и видны обе компании. */
const LOGIN = 'a.saidov';
const PASSWORD = process.env.SEED_PASSWORD ?? 'metall-dev-2026';

/**
 * Выдумки из импортированного макета. Склады «Сергели» и «Зангиата», партии
 * «П-2026-…» и предупреждение про PPU-219-315 были вбиты в вёрстку: ни одной
 * такой строки в базе нет. Любая из них на экране означает, что кусок макета
 * вернулся.
 */
const FICTION = [
  'Центральный склад металлопроката (Сергели)',
  'Склад готовой изоляции Завода (Зангиата)',
  'П-2026-0891',
  'П-2026-0902',
  'П-2026-1044',
  'SN-PPU-99120',
  'Сектор А',
  'А-04-12',
  'ниже критического уровня (4 м доступно',
  'Все марки стали',
  'Ст20 (электросварная)',
  'Сканировать штрихкод',
];

fs.mkdirSync(OUT, { recursive: true });

/**
 * Ненайденный код — нормальный ответ сканера, и прогон проверяет его нарочно.
 * На время этой проверки браузерная жалоба «Failed to load resource: 404»
 * ошибкой не считается: она про тот же самый ожидаемый 404.
 */
let expectScanMiss = false;

const errors = [];
const overflow = [];
const found = [];
const notes = [];
let backend;
let server;
let browser;

async function waitForApi(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // 401 тоже годится: значит процесс слушает и маршруты подняты.
      const r = await fetch(`${API}/warehouse/summary?period=7d`);
      if (r.status > 0) return r.status;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error('бэкенд не поднялся за отведённое время');
}

/** Переполнение по горизонтали и кто именно вылез. */
/**
 * Обрезанная таблица общий замер не ловит: она лежит в `overflow-x-auto`,
 * и виновники внутри скроллера из него исключены. А это ровно тот случай,
 * когда последние колонки — себестоимость, автор, кнопка — уезжают под правую
 * панель, и экран выглядит рабочим, пока не потянешь таблицу вбок.
 */
async function tableCut(page) {
  // Ищем по всей странице, а не внутри `[role="tabpanel"]`: вкладки стоят
  // только над журналом, на остатках панели с такой ролью нет, и замер,
  // привязанный к ней, просто висел бы до таймаута.
  return page.evaluate(() => {
      const scroller = [...document.querySelectorAll('[class*="overflow-x-auto"]')].find(
        (el) => el.offsetParent !== null && el.querySelector('thead th'),
      );
      if (!scroller) return null;
      const head = [...scroller.querySelectorAll('thead th')];
      const hidden = head
        .filter((th) => th.getBoundingClientRect().right > scroller.getBoundingClientRect().right + 1)
        .map((th) => th.innerText.trim());
      // Ширины колонок: без них «лишних 8px» не говорит, какую колонку ужимать.
      const cols = head.map((th) => `${th.innerText.trim()} ${Math.round(th.getBoundingClientRect().width)}`);
      return { over: scroller.scrollWidth - scroller.clientWidth, hidden, cols };
  });
}

function reportCut(cut, at, what) {
  if (!cut) return;
  notes.push(`[${at}] ${what}, ширина таблицы: лишних ${cut.over}px; колонки: ${cut.cols.join(', ')}`);
  if (cut.over > 0) {
    errors.push(
      `[${at}] таблица «${what}» не влезает: лишних ${cut.over}px` +
        (cut.hidden.length ? `, за краем колонки ${cut.hidden.join(', ')}` : ''),
    );
  }
}

async function measure(page) {
  return page.evaluate(() => {
    const de = document.documentElement;
    const main = document.querySelector('main');
    const over = main ? main.scrollWidth - main.clientWidth : null;

    const culprits = [];
    if (main && over > 0) {
      const right = main.getBoundingClientRect().right;
      for (const el of main.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.right <= right + 1) continue;
        const scroller = el.closest('[class*="overflow-x-auto"]');
        if (scroller && scroller !== el) continue;
        culprits.push(
          `${el.tagName.toLowerCase()}.${String(el.className).split(' ').slice(0, 3).join('.')} +${Math.round(r.right - right)}px`,
        );
        if (culprits.length >= 3) break;
      }
    }
    return { doc: de.scrollWidth - de.clientWidth, main: over, culprits };
  });
}

const rowCount = (page) =>
  page
    .locator('text=/Записей:\\s*\\d+/')
    .first()
    .innerText()
    // «Записей: 1 066» — разряды отбиты неразрывным пробелом, и первая же
    // группа цифр это «1». Счётчик перевалил за тысячу, и прогон стал
    // сравнивать единицу с длиной страницы.
    .then((t) => Number((t.match(/Записей:\s*([\d\s\u00a0\u202f]+)/)?.[1] ?? '0').replace(/\D/g, '')))
    .catch(() => 0);

// ---------------------------------------------------------------------------
// Круг записи через интерфейс
// ---------------------------------------------------------------------------

/**
 * Поле формы, а не одноимённый столбец таблицы.
 *
 * У остатков есть колонки «Код, партия», «Остаток», «Склад / Ячейка» — поиск по имени
 * по всей странице попадал бы в них, клик уходил в сортировку, а проверка
 * оставалась зелёной со снимком таблицы вместо раскрытого списка.
 */
const formField = (page, ariaLabel) =>
  page.locator('form').first().getByRole('button', { name: ariaLabel, exact: true }).first();

const formInput = (page, ariaLabel) =>
  page.locator('form').first().getByRole('textbox', { name: ariaLabel, exact: true }).first();

async function openMenu(page, at, ariaLabel) {
  const trigger = formField(page, ariaLabel);
  if ((await trigger.count()) === 0) {
    errors.push(`[${at}] в форме нет поля «${ariaLabel}»`);
    return null;
  }
  await trigger.click();
  const menu = page.locator('[role="listbox"]').last();
  try {
    await menu.waitFor({ state: 'visible', timeout: 4000 });
  } catch {
    errors.push(`[${at}] «${ariaLabel}»: список не раскрылся`);
    return null;
  }
  return menu;
}

/**
 * Выбор пункта по предикату на его тексте. Тексты снимаем одним вызовом:
 * справочник мог догрузиться, и перебор по одному напоролся бы на
 * перерисованный список.
 */
async function chooseOption(page, at, ariaLabel, matches, what) {
  const menu = await openMenu(page, at, ariaLabel);
  if (!menu) return false;
  const items = menu.locator('button');
  const seen = (await items.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
  const hit = seen.findIndex(matches);
  if (hit >= 0) {
    await items.nth(hit).click();
    await page.waitForTimeout(400);
    return true;
  }
  await page.keyboard.press('Escape');
  // Что было в списке — важнее самого отказа: пустой список и список не той
  // компании ломаются одинаково, а чинятся по-разному.
  errors.push(
    `[${at}] в списке «${ariaLabel}» нет пункта ${what}; есть: ` +
      (seen.length ? seen.slice(0, 4).join(' | ') : 'ничего'),
  );
  return false;
}

/**
 * Тип операции в форме — список, а не три кнопки.
 *
 * Пока типов было три, они стояли переключателем и выбирались по имени кнопки.
 * Типов семь, переключатель не влезал ни на 360, ни на 1440, и его заменил
 * список. Поиск по имени кнопки после этого попадал бы в строку журнала с тем
 * же словом — например «Списание» в таблице — и прогон оставался бы зелёным,
 * ни разу не переключив тип.
 */
async function chooseKind(page, at, name) {
  const ok = await chooseOption(page, at, 'Тип операции', (t) => t === name, `«${name}»`);
  if (ok) await page.waitForTimeout(400);
  return ok;
}

/** Календарь раскрыт: шапка недели есть только внутри него. */
async function openCalendar(page, at, ariaLabel) {
  const trigger = formField(page, ariaLabel);
  if ((await trigger.count()) === 0) {
    errors.push(`[${at}] в форме нет поля «${ariaLabel}»`);
    return false;
  }
  await trigger.click();
  try {
    await page
      .getByText('Пн', { exact: true })
      .first()
      .waitFor({ state: 'visible', timeout: 4000 });
  } catch {
    errors.push(`[${at}] «${ariaLabel}»: календарь не раскрылся`);
    return false;
  }
  return true;
}

/** Число из ячейки вида «12,5 т» → 12.5. Разрядные пробелы убираем. */
const toNum = (text) => {
  const m = String(text).replace(/[\s ]/g, '').match(/-?\d+(?:[.,]\d+)?/);
  return m ? Number(m[0].replace(',', '.')) : NaN;
};

/** Остаток строки «код + партия» из таблицы: сверяем по обеим колонкам сразу. */
/**
 * Остаток строки остатков.
 *
 * Ячейка в ключе обязательна: после перекладки одна партия лежит на двух
 * полках, и «первая строка с этим кодом и партией» — уже не та, в которую
 * форма записывала. Сверка велась бы с чужим числом и оставалась зелёной.
 */
const stockOf = (page, code, batch, cell) =>
  page.evaluate(
    ({ code, batch, cell }) => {
      // Первая колонка таблицы — отметка к печати этикетки, текста в ней нет.
      // Считать её данными значило бы сдвинуть все индексы на один и молча
      // искать партию в пустой строке.
      const dataCells = (tr) =>
        [...tr.querySelectorAll('td')]
          .filter((td) => !td.querySelector('input[type="checkbox"]'))
          .map((td) => td.innerText.trim());
      const norm = (t) => t.replace(/\s*\/\s*/g, '/').trim();
      for (const tr of document.querySelectorAll('table tbody tr')) {
        const cells = dataCells(tr);
        if (cells.length < 8) continue;
        // Колонки: 0 код и партия, 2 склад и ячейка, 3 остаток.
        const first = cells[0].split('\n').map((x) => x.trim());
        const place = cells[2].split('\n').map((x) => x.trim());
        if (first[0] === code && first[1] === batch && (!cell || norm(place[1] ?? '') === cell)) {
          return cells[3];
        }
      }
      return null;
    },
    { code, batch, cell },
  );

/**
 * Номенклатура открывается отдельным окном посреди страницы, а не списком,
 * пришитым к полю.
 *
 * Требование Отабека от 08.10: «панель должна открываться отдельно, всплывающая
 * панель по середине страницы». Проверяем не вид, а три измеримых признака
 * окна: за ним есть затемнение на весь экран, само окно объявлено диалогом, и
 * его центр совпадает с центром экрана по обеим осям. Последнее и отличает
 * окно от списка под полем: список стоит там, где поле, то есть у края.
 */
async function checkItemDialog(page, at) {
  const overlay = page.locator('[data-select-overlay]').last();
  if ((await overlay.count()) === 0) {
    errors.push(`[${at}] номенклатура открылась без затемнения — это список у поля, а не окно`);
    return;
  }

  const panel = page.locator('[role="dialog"]').last();
  if ((await panel.count()) === 0) {
    errors.push(`[${at}] у окна номенклатуры нет role="dialog"`);
    return;
  }
  if ((await panel.getAttribute('aria-modal')) !== 'true') {
    errors.push(`[${at}] окно номенклатуры не объявлено модальным (aria-modal)`);
  }

  const view = page.viewportSize();
  const over = await overlay.boundingBox();
  if (!over || over.width < view.width - 1 || over.height < view.height - 1) {
    errors.push(
      `[${at}] затемнение не на весь экран: ${over ? `${Math.round(over.width)}×${Math.round(over.height)}` : 'нет'} при ${view.width}×${view.height}`,
    );
  }

  const box = await panel.boundingBox();
  if (!box) {
    errors.push(`[${at}] окно номенклатуры не отрисовано`);
    return;
  }
  // Допуск в 8px: на дробной плотности пикселей центр считается не нацело.
  const offX = Math.abs(box.x + box.width / 2 - view.width / 2);
  const offY = Math.abs(box.y + box.height / 2 - view.height / 2);
  if (offX > 8 || offY > 8) {
    errors.push(
      `[${at}] окно номенклатуры не по центру: смещение ${Math.round(offX)}px по ширине и ${Math.round(offY)}px по высоте`,
    );
  }
  if (box.height > view.height - 8 || box.width > view.width - 8) {
    errors.push(
      `[${at}] окно номенклатуры не вписалось в экран: ${Math.round(box.width)}×${Math.round(box.height)} при ${view.width}×${view.height}`,
    );
  }
  notes.push(
    `[${at}] окно номенклатуры ${Math.round(box.width)}×${Math.round(box.height)}, смещение от центра ${Math.round(offX)}/${Math.round(offY)}px`,
  );
}

/**
 * Поиск внутри списка номенклатуры и полные названия в нём.
 *
 * Номенклатуры триста позиций, и называются они одинаково до последних
 * знаков: «Труба стальная 1020×10 мм электросварная прямошовная, 09Г2С,
 * ГОСТ 20295-85». Список без поиска листают вручную, а обрезанная строка
 * отличает позицию от соседней ровно тем куском, который и обрезан, — выбрать
 * по ней нельзя, и это не придирка к виду, а ошибка в документе.
 *
 * Проверяем три вещи: поле поиска есть внутри раскрытого списка, оно
 * действительно сужает список, и строка показана целиком, а не обрезана по
 * ширине панели.
 */
async function runItemSearch(page, at) {
  const menu = await openMenu(page, at, 'Номенклатура');
  if (!menu) return;

  await checkItemDialog(page, at);

  // Поле поиска ищем в самой панели, а не в прокручиваемом списке: в окне
  // шапка с поиском стоит рядом со списком, а не внутри него — именно для
  // того, чтобы не уезжать вместе со строками. Внутри списка его там нет.
  const panel = page.locator('[role="dialog"]').last();
  const host = (await panel.count()) ? panel : menu;
  const search = host.getByRole('searchbox').first();
  if ((await search.count()) === 0) {
    errors.push(`[${at}] в раскрытой панели номенклатуры нет поля поиска`);
    await page.keyboard.press('Escape');
    return;
  }

  const options = menu.locator('[role="option"]');
  const before = await options.count();
  if (before < 20) {
    errors.push(`[${at}] в списке номенклатуры всего ${before} строк — искать не в чем`);
    await page.keyboard.press('Escape');
    return;
  }

  // Запрос берём из самого списка, а не вписываем словом: номенклатуру
  // заказчика меняют, и прогон с зашитым «09Г2С» однажды станет зелёным
  // просто потому, что искать стало нечего.
  const sample = (await options.nth(3).innerText()).replace(/\s+/g, ' ').trim();
  const needle = (sample.match(/(\d{2,4}×\d{1,2})/) ?? [])[1];
  if (!needle) {
    errors.push(`[${at}] не из чего собрать запрос: строка списка «${sample}»`);
    await page.keyboard.press('Escape');
    return;
  }

  await search.fill(needle);
  await page.waitForTimeout(300);
  const after = await options.count();
  if (after === 0) {
    errors.push(`[${at}] поиск «${needle}» не нашёл ничего, хотя строку взяли из этого же списка`);
    await page.keyboard.press('Escape');
    return;
  }
  if (after >= before) {
    errors.push(`[${at}] поиск «${needle}» не сузил список: было ${before}, стало ${after}`);
    await page.keyboard.press('Escape');
    return;
  }

  const left = (await options.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
  const stray = left.filter((t) => !t.toLowerCase().includes(needle.toLowerCase()));
  if (stray.length) {
    errors.push(`[${at}] в выдаче поиска «${needle}» лишние строки: ${stray.slice(0, 3).join(' | ')}`);
  }

  // Обрезка: на экране её не видно, потому что многоточие рисует сам браузер.
  // Спрашиваем у элемента, целиком ли он помещается в свою ширину.
  const cut = await options.first().evaluate((el) => {
    const inner = el.querySelector('[data-full-name]') ?? el;
    return { scroll: inner.scrollWidth, client: inner.clientWidth, text: inner.innerText.trim() };
  });
  if (cut.scroll > cut.client + 1) {
    errors.push(
      `[${at}] название в списке обрезано: лишних ${cut.scroll - cut.client}px у «${cut.text}»`,
    );
  }

  await page.screenshot({ path: `${OUT}/warehouse-item-search-${at.replace(/\//g, '-')}.png` });

  // Выбор из суженного списка должен работать так же, как из полного.
  const picked = left[0];
  await options.first().click();
  await page.waitForTimeout(400);
  const field = (await formField(page, 'Номенклатура').innerText()).replace(/\s+/g, ' ').trim();
  if (!field || field === 'выберите') {
    errors.push(`[${at}] выбор из суженного списка не записался в поле: там «${field}»`);
  }
  notes.push(`[${at}] поиск «${needle}»: ${before} → ${after}, выбрано «${picked.slice(0, 48)}»`);
}

/**
 * Выбор из списка на узком экране, с первого нажатия.
 *
 * Поле причины стоит ниже сгиба: браузер доводит его до видимой области уже
 * после нажатия, а список поверх страницы закрывается по любой прокрутке.
 * Пока эти два правила не разведены во времени, список захлопывается ровно в
 * момент открытия, и поле выглядит ненажимающимся.
 */
async function runNarrowSelect(page, at) {
  if (!(await chooseKind(page, at, 'Списание'))) return;

  const trigger = formField(page, 'Причина');
  if ((await trigger.count()) === 0) {
    errors.push(`[${at}] в форме списания нет поля «Причина»`);
    return;
  }
  await trigger.click();
  await page.waitForTimeout(150);

  // Доводочную прокрутку воспроизводим сами: на стенде она приходит от
  // `main` сразу после нажатия, а локально страница успевает встать на место
  // до клика, и проверка без этого шага зелёная на сломанном коде.
  const scrolled = await page.evaluate(() => {
    const main = document.querySelector('main');
    if (!main) return false;
    main.scrollTop += 24;
    return true;
  });
  if (!scrolled) errors.push(`[${at}] не нашёлся прокручиваемый main`);
  await page.waitForTimeout(250);

  const items = page.locator('[role="listbox"]').last().locator('button');
  const texts = (await items.allInnerTexts().catch(() => [])).map((t) =>
    t.replace(/\s+/g, ' ').trim(),
  );
  if (texts.length === 0) {
    errors.push(`[${at}] список причин закрылся от доводочной прокрутки сразу после открытия`);
    return;
  }

  const hit = texts.findIndex((t) => t !== 'выберите' && t.length > 0);
  if (hit < 0) {
    errors.push(`[${at}] в списке причин нет ни одной причины: ${texts.join(' | ')}`);
    return;
  }
  await items.nth(hit).click();
  await page.waitForTimeout(500);

  const picked = (await formField(page, 'Причина').innerText()).replace(/\s+/g, ' ').trim();
  if (!picked.includes(texts[hit].slice(0, 8))) {
    errors.push(`[${at}] причина не выбралась: в поле «${picked}», выбирали «${texts[hit]}»`);
  }
  notes.push(`[${at}] причина выбрана с первого нажатия: ${picked}`);

  // Обратная сторона поблажки: настоящая прокрутка список всё-таки закрывает.
  // Иначе он повиснет посреди экрана — место ему считают один раз.
  await trigger.click();
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    const main = document.querySelector('main');
    if (main) main.scrollTop += 60;
  });
  await page.waitForTimeout(400);
  if ((await page.locator('[role="listbox"]').count()) > 0) {
    errors.push(`[${at}] список не закрылся от прокрутки и повис поверх страницы`);
  }

  await chooseKind(page, at, 'Приход');
}

/**
 * Полный круг записи: приход из формы, сверка остатка, сторно из пути партии,
 * сверка возврата.
 *
 * Партию, номенклатуру и склад берём с экрана, а не вписываем в прогон: какая
 * компания открыта по умолчанию, такая номенклатура и лежит на её складах.
 * Приход в уже существующую партию к тому же не заводит новых строк справочника —
 * пополняется только журнал движений, а он и так только пополняется.
 *
 * Круг идёт на широком экране: ниже `lg` таблица остатков скрыта, а остаток
 * сверяется именно по ней.
 */
const pickStockRow = (page) =>
  page.evaluate(() => {
    // Отметка к печати этикетки — служебная колонка, в данные она не идёт.
    const dataCells = (tr) =>
      [...tr.querySelectorAll('td')]
        .filter((td) => !td.querySelector('input[type="checkbox"]'))
        .map((td) => td.innerText.trim());
    for (const tr of document.querySelectorAll('table tbody tr')) {
      const cells = dataCells(tr);
      if (cells.length < 8) continue;
      // Колонка «Код, партия»: первая строка — код, вторая — номер партии.
      const first = cells[0].split('\n').map((x) => x.trim());
      const batch = first[1] ?? '';
      if (!batch || batch === '—') continue;
      // Колонка «Склад / Ячейка»: первая строка — склад, вторая — «ЗОНА / ЯЧЕЙКА».
      // Пробелы вокруг косой на экране есть, в значении списка их нет.
      const place = cells[2].split('\n').map((x) => x.trim());
      const cell = (place[1] ?? '').replace(/\s*\/\s*/g, '/');
      if (!cell || cell === '—') continue;
      return { code: first[0], batch, warehouse: place[0], cell };
    }
    return null;
  });

async function runWriteCircle(page, at) {
  const pick = await pickStockRow(page);
  if (!pick) {
    errors.push(`[${at}] в таблице нет строки с партией: круг записи не начать`);
    return;
  }
  notes.push(`[${at}] круг записи: ${pick.code} / ${pick.batch} / ${pick.warehouse} / ${pick.cell}`);

  // Сужаем таблицу до этой партии: поиск по номеру партии — заявленная
  // возможность экрана, и на одной строке сверка чисел однозначна.
  await page.getByRole('searchbox', { name: 'Поиск' }).first().fill(pick.batch);
  await page.waitForTimeout(1500);

  const before = toNum(await stockOf(page, pick.code, pick.batch, pick.cell));
  if (!Number.isFinite(before)) {
    errors.push(`[${at}] не прочитался остаток строки ${pick.code} / ${pick.batch}`);
    return;
  }

  const QTY = 3;
  if (
    !(await chooseOption(
      page,
      at,
      'Номенклатура',
      (t) => t.includes(pick.code),
      `с кодом ${pick.code}`,
    ))
  ) {
    return;
  }

  await formInput(page, 'Партия').fill(pick.batch);
  await formInput(page, 'Количество').fill(String(QTY));
  await formInput(page, 'Цена за единицу').fill('1000');

  if (
    !(await chooseOption(
      page,
      at,
      'Склад получения',
      (t) => t.includes(pick.warehouse),
      `со складом ${pick.warehouse}`,
    ))
  ) {
    return;
  }

  // Ячейка получения: без неё форма законно не даёт записать — остаток лежит
  // по ячейкам, и движение «на склад вообще» встало бы строкой «нигде».
  if (
    !(await chooseOption(
      page,
      at,
      'Ячейка получения',
      (t) => t.includes(pick.cell.split('/')[1]),
      `с ячейкой ${pick.cell}`,
    ))
  ) {
    return;
  }

  // Календарь открываем ради самого календаря: поле даты заполнено по
  // умолчанию, и без этого снимка выпадающая часть нигде не видна.
  const tag = at.replace('/', '-');
  if (await openCalendar(page, at, 'Дата')) {
    await page.screenshot({ path: `${OUT}/warehouse-calendar-${tag}.png` });
    overflow.push({ key: `${at}/calendar`, isDefault: false, ...(await measure(page)) });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }

  await page.screenshot({ path: `${OUT}/warehouse-form-${tag}.png`, fullPage: true });

  await page.getByRole('button', { name: 'Записать', exact: true }).first().click();
  await page.waitForTimeout(2000);

  if ((await page.locator('text=/^Записано:/').count()) === 0) {
    const problem = await page
      .locator('form [role="alert"]')
      .first()
      .innerText()
      .catch(() => '');
    errors.push(`[${at}] приход не записался${problem ? `: ${problem.replace(/\s+/g, ' ')}` : ''}`);
    return;
  }

  const after = toNum(await stockOf(page, pick.code, pick.batch, pick.cell));
  notes.push(`[${at}] остаток ${before} → ${after} (приход ${QTY})`);
  if (!Number.isFinite(after) || Math.abs(after - before - QTY) > 0.001) {
    errors.push(`[${at}] приход ${QTY} изменил остаток не так: было ${before}, стало ${after}`);
  }

  // --- сторно из пути партии ---------------------------------------------
  await page.getByRole('button', { name: /^Путь( партии)?$/ }).first().click();
  await page.waitForTimeout(1500);

  const storno = page.getByRole('button', { name: /^Сторно$/ });
  const count = await storno.count();
  notes.push(`[${at}] кнопок «Сторно» в пути партии: ${count}`);
  if (count === 0) {
    errors.push(`[${at}] у записанного движения нет кнопки «Сторно»`);
    return;
  }
  // Кнопка есть только у движений, заведённых человеком: у сеяных движений
  // отгрузки и цеха стоит документ, и сервер отменять их не даёт.
  await storno.last().click();
  await page.waitForTimeout(2500);

  const back = toNum(await stockOf(page, pick.code, pick.batch, pick.cell));
  notes.push(`[${at}] после сторно: ${back}`);
  if (!Number.isFinite(back) || Math.abs(back - before) > 0.001) {
    errors.push(`[${at}] сторно не вернуло остаток: было ${before}, стало ${back}`);
  }
  if ((await page.locator('li:has-text("сторно")').count()) === 0) {
    errors.push(`[${at}] сторно не помечено в журнале партии`);
  }

  await page.screenshot({ path: `${OUT}/warehouse-storno-${tag}.png`, fullPage: true });

  await page.getByRole('button', { name: 'Закрыть', exact: true }).first().click();
  await page.waitForTimeout(400);

  // --- нехватка видна до нажатия -------------------------------------------
  // Списывается доступное, а не то, что лежит: под заказ товар резервируют.
  // Форма обязана сказать об этом сама, иначе человек узнаёт об отказе только
  // из ответа сервера и читает его как поломку.
  await chooseKind(page, at, 'Списание');
  const chosen =
    (await chooseOption(page, at, 'Номенклатура', (t) => t.includes(pick.code), `с кодом ${pick.code}`)) &&
    (await chooseOption(page, at, 'Причина', (t) => t !== 'выберите' && t.length > 0, 'причины списания')) &&
    (await chooseOption(
      page,
      at,
      'Склад отправления',
      (t) => t.includes(pick.warehouse),
      `со складом ${pick.warehouse}`,
    ));

  // --- ячейка обязательна, и говорит об этом форма -------------------------
  // Склад выбран, ячейка нет: на складе с ячейками движение «на склад вообще»
  // сервер отклонит. Человек должен узнать это из формы, а не из отказа.
  if (chosen) {
    await formInput(page, 'Партия').fill(pick.batch);
    await formInput(page, 'Количество').fill('1');
    await page.waitForTimeout(500);
    const said = await page.locator('form').first().innerText();
    const canSend = await page
      .getByRole('button', { name: 'Записать', exact: true })
      .first()
      .isEnabled();
    if (!said.includes('ячейку отправления')) {
      errors.push(`[${at}] форма не попросила выбрать ячейку отправления`);
    }
    if (canSend) errors.push(`[${at}] кнопка «Записать» активна без выбранной ячейки`);
    notes.push(`[${at}] без ячейки: форма ${said.includes('ячейку отправления') ? 'просит ячейку' : 'молчит'}, кнопка ${canSend ? 'активна' : 'заперта'}`);
  }

  const ready =
    chosen &&
    (await chooseOption(
      page,
      at,
      'Ячейка отправления',
      (t) => t.includes(pick.cell.split('/')[1]),
      `с ячейкой ${pick.cell}`,
    ));
  if (ready) {
    await formInput(page, 'Партия').fill(pick.batch);
    await formInput(page, 'Количество').fill('999999');
    await page.waitForTimeout(500);
    const said = await page.locator('form').first().innerText();
    if (!said.includes('Доступно только')) {
      errors.push(`[${at}] форма не предупредила о нехватке при списании 999999`);
    }
    const canSend = await page
      .getByRole('button', { name: 'Записать', exact: true })
      .first()
      .isEnabled();
    if (canSend) errors.push(`[${at}] кнопка «Записать» активна при заведомой нехватке`);
    await page.screenshot({ path: `${OUT}/warehouse-short-${tag}.png`, fullPage: true });
    notes.push(`[${at}] нехватка при списании: форма предупредила, кнопка ${canSend ? 'активна' : 'заперта'}`);
  }
  await chooseKind(page, at, 'Приход');
  await page.getByRole('searchbox', { name: 'Поиск' }).first().fill('');
  await page.waitForTimeout(1200);
}

// ---------------------------------------------------------------------------
// Журнал движений
// ---------------------------------------------------------------------------

/** Поле журнала, а не одноимённое поле формы операции: подписи пересекаются. */
const journalField = (page, ariaLabel) =>
  page
    .locator('[role="tabpanel"]')
    .first()
    .getByRole('button', { name: ariaLabel, exact: true })
    .first();

/** Строки журнала: на 1440 это таблица, на 360 — карточки. Читаем то, что показано. */
const journalRows = (page) =>
  page
    .locator('[role="tabpanel"]')
    .first()
    .evaluate((panel) => {
      const table = panel.querySelector('table tbody');
      if (table && table.offsetParent !== null) {
        return [...table.querySelectorAll('tr')].map((tr) => ({
          text: tr.innerText.replace(/\s+/g, ' ').trim(),
        }));
      }
      const list = panel.querySelector('ul');
      return list
        ? [...list.querySelectorAll('li')].map((li) => ({
            text: li.innerText.replace(/\s+/g, ' ').trim(),
          }))
        : [];
    });

/**
 * Журнал движений: весь склад по времени.
 *
 * Проверяется не наличие таблицы, а то, ради чего её открывают: что фильтр по
 * типу операции сужает выборку и в ней не остаётся чужих операций, что период
 * сужает, что вторая страница — другие движения, и что отмена не предлагается
 * там, где сервер её не даст (движение под документом, сторно, уже отменённое).
 *
 * Счётчик «Записей» приходит от сервера и больше числа строк на экране:
 * страница ровно на 50. Сравняется — значит на экран вывели длину массива,
 * и человек прочтёт «50» там, где движений тысяча.
 */
async function runMovesTab(page, at, h, withWrite = false) {
  // Позицию берём с открытых остатков, пока они ещё на экране: в журнале
  // склад назначения написан прозой («… → —»), и разбирать его оттуда значит
  // проверять свой же разбор, а не экран.
  const pick = withWrite ? await pickStockRow(page) : null;
  if (withWrite && !pick) {
    errors.push(`[${at}] в таблице остатков нет строки с партией: запись из журнала не проверить`);
  }

  const tab = page.getByRole('tab', { name: 'Журнал движений' });
  if ((await tab.count()) === 0) {
    errors.push(`[${at}] на экране склада нет вкладки «Журнал движений»`);
    return;
  }
  await tab.first().click();
  await page.waitForTimeout(1800);

  const panel = page.locator('[role="tabpanel"]').first();
  if ((await panel.count()) === 0) {
    errors.push(`[${at}] вкладка «Журнал движений» открылась пустой: панели журнала нет`);
    return;
  }

  const total = await rowCount(page);
  let rows = await journalRows(page);
  notes.push(`[${at}] журнал: всего ${total}, на странице ${rows.length}`);
  if (total === 0 || rows.length === 0) {
    errors.push(`[${at}] журнал движений пуст: всего ${total}, строк ${rows.length}`);
    return;
  }
  if (rows.length > 50) {
    errors.push(`[${at}] на странице журнала ${rows.length} строк, страница объявлена на 50`);
  }
  if (total <= rows.length) {
    errors.push(
      `[${at}] счётчик журнала (${total}) не больше длины страницы (${rows.length}): ` +
        'на экране длина массива, а не общее число движений',
    );
  }

  const pager = await panel.innerText();
  const range = pager.match(/(\d[\d\s ]*)[–-](\d[\d\s ]*)\s+из\s+([\d\s ]+)/);
  if (!range) {
    errors.push(`[${at}] в журнале нет счётчика страниц вида «1-50 из N»`);
  } else {
    const nums = range.slice(1).map((s) => Number(String(s).replace(/[\s ]/g, '')) || 0);
    notes.push(`[${at}] журнал, страница: ${nums[0]}-${nums[1]} из ${nums[2]}`);
    if (nums[0] !== 1 || nums[1] !== rows.length || nums[2] !== total) {
      errors.push(
        `[${at}] счётчик страниц журнала врёт: «${range[0]}» при ${rows.length} строках и ${total} всего`,
      );
    }
  }

  const tag = at.replace('/', '-');
  await page.screenshot({ path: `${OUT}/warehouse-moves-${tag}.png`, fullPage: true });
  overflow.push({ key: `${at}/moves`, isDefault: true, ...(await measure(page)) });

  // Страница целиком не прокручивается — прокручивается `main`, поэтому
  // `fullPage` даёт ровно экран. На узком экране сами строки журнала лежат
  // ниже сгиба, и без этого кадра их никто не видел.
  await page.evaluate(() => {
    const row = document.querySelector('[role="tabpanel"] ul li, [role="tabpanel"] tbody tr');
    row?.scrollIntoView({ block: 'center' });
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/warehouse-moves-rows-${tag}.png` });
  overflow.push({ key: `${at}/moves-rows`, isDefault: true, ...(await measure(page)) });

  // Обрезанная таблица общий замер не ловит: она лежит в `overflow-x-auto`,
  // и виновники внутри скроллера из него исключены. А это ровно тот случай,
  // когда последние колонки — автор и кнопка отмены — уезжают под правую
  // панель, и журнал выглядит рабочим, пока не потянешь его вбок.
  reportCut(await tableCut(page), at, 'журнал');

  // --- фильтр по типу операции ---------------------------------------------
  // Тип берём с экрана, а не вписываем в прогон: какая компания открыта по
  // умолчанию, такие операции у неё и есть. У торгового дома нет ни одного
  // списания, и жёстко вписанное «Списание» ругалось бы на исправный фильтр.
  // Берём самый редкий из показанных: по нему сужение видно наверняка.
  const OP_LABELS = [
    'Оприходование излишка',
    'Возврат от клиента',
    'Возврат из цеха',
    'Выдача в цех',
    'Выпуск из цеха',
    'Перемещение',
    'Списание',
    'Отгрузка',
    'Приход',
  ];
  const seenOps = new Map();
  for (const r of rows) {
    const op = OP_LABELS.find((l) => r.text.includes(l));
    if (op) seenOps.set(op, (seenOps.get(op) ?? 0) + 1);
  }
  const pickedOp = [...seenOps.entries()].sort((a, b) => a[1] - b[1])[0]?.[0] ?? null;
  notes.push(
    `[${at}] журнал, операции на странице: ` +
      ([...seenOps.entries()].map(([k, v]) => `${k}=${v}`).join(', ') || 'ни одной узнанной'),
  );
  if (!pickedOp) {
    errors.push(`[${at}] в строках журнала не узнаётся ни одна операция: подписи потерялись`);
    return;
  }

  const typeField = journalField(page, 'Тип операции');
  if ((await typeField.count()) === 0) {
    errors.push(`[${at}] в журнале нет фильтра «Тип операции»`);
  } else {
    await typeField.click();
    const menu = page.locator('[role="listbox"]').last();
    let opened = true;
    try {
      await menu.waitFor({ state: 'visible', timeout: 4000 });
    } catch {
      opened = false;
      errors.push(`[${at}] журнал: список типов операции не раскрылся`);
    }
    if (opened) {
      const items = menu.locator('button');
      const seen = (await items.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
      const hit = seen.findIndex((t) => t === pickedOp);
      if (hit < 0) {
        errors.push(
          `[${at}] в фильтре типов журнала нет «${pickedOp}», хотя такие движения на экране есть; ` +
            `в списке: ${seen.slice(0, 5).join(' | ')}`,
        );
        await page.keyboard.press('Escape');
      } else {
        await items.nth(hit).click();
        await page.waitForTimeout(1800);
        const byType = await rowCount(page);
        const typed = await journalRows(page);
        notes.push(`[${at}] журнал, только «${pickedOp}»: ${byType} из ${total}`);
        if (byType === 0) {
          errors.push(
            `[${at}] фильтр «${pickedOp}» не нашёл ни одного движения, хотя они есть на первой странице`,
          );
        }
        if (byType >= total) {
          errors.push(`[${at}] фильтр типа не сузил журнал: ${byType} из ${total}`);
        }
        // Мало сузить счётчик: на экране не должно остаться чужих операций.
        const alien = typed.filter((r) => !r.text.includes(pickedOp));
        if (alien.length) {
          errors.push(
            `[${at}] при фильтре «${pickedOp}» в журнале чужие операции (${alien.length}), ` +
              `например: ${alien[0].text.slice(0, 90)}`,
          );
        }
        await page.screenshot({ path: `${OUT}/warehouse-moves-filtered-${tag}.png`, fullPage: true });
        overflow.push({ key: `${at}/moves-filtered`, isDefault: true, ...(await measure(page)) });
      }
    }
  }

  // --- сброс фильтров -------------------------------------------------------
  const reset = panel.getByRole('button', { name: 'Сбросить' }).first();
  if ((await reset.count()) === 0) {
    errors.push(`[${at}] в журнале нет кнопки «Сбросить»`);
  } else {
    await reset.click();
    await page.waitForTimeout(1800);
    const back = await rowCount(page);
    if (back !== total) {
      errors.push(`[${at}] после сброса фильтров журнала ${back} движений вместо ${total}`);
    }
  }

  // --- вторая страница ------------------------------------------------------
  rows = await journalRows(page);
  const firstBefore = rows[0]?.text ?? '';
  const next = panel.getByRole('button', { name: 'Далее' }).first();
  if ((await next.count()) === 0) {
    errors.push(`[${at}] в журнале нет кнопки «Далее»`);
  } else if (total > rows.length) {
    await next.click();
    await page.waitForTimeout(1800);
    const second = await journalRows(page);
    const secondTotal = await rowCount(page);
    notes.push(`[${at}] журнал, вторая страница: ${second.length} строк, всего ${secondTotal}`);
    if (second.length === 0) {
      errors.push(`[${at}] вторая страница журнала пуста при ${total} движениях`);
    }
    if (secondTotal !== total) {
      errors.push(
        `[${at}] при переходе на вторую страницу счётчик журнала поехал: ${secondTotal} вместо ${total}`,
      );
    }
    if (second[0]?.text && second[0].text === firstBefore) {
      errors.push(`[${at}] вторая страница журнала повторяет первую: «${firstBefore.slice(0, 80)}»`);
    }
    if (!(await panel.innerText()).match(new RegExp(`${rows.length + 1}\\s*[–-]`))) {
      errors.push(`[${at}] на второй странице журнала счётчик не начинается с ${rows.length + 1}`);
    }
    await panel.getByRole('button', { name: 'Назад' }).first().click();
    await page.waitForTimeout(1500);
  }

  // --- отмена предлагается не везде ----------------------------------------
  // Признак считает сервер (`canReverse`): движение под документом, сторно и
  // уже отменённое отменять нельзя. Экран обязан это показывать, иначе человек
  // нажимает и получает отказ от сервера.
  rows = await journalRows(page);
  const docRows = rows.filter((r) => r.text.includes('по документу'));
  const docWithStorno = docRows.filter((r) => r.text.includes('Сторно'));
  notes.push(
    `[${at}] журнал: движений по документу ${docRows.length}, из них с кнопкой «Сторно» ${docWithStorno.length}`,
  );
  if (docRows.length === 0) {
    errors.push(`[${at}] в журнале нет ни одного движения по документу: отмену проверять не на чем`);
  }
  if (docWithStorno.length) {
    errors.push(
      `[${at}] у движения по документу предложена отмена: ${docWithStorno[0].text.slice(0, 90)}`,
    );
  }

  // --- период ---------------------------------------------------------------
  // Сегодняшний день против всего времени: сеяные движения идут за месяцы,
  // за один день их обязано быть меньше.
  const fromField = journalField(page, 'Дата с');
  if ((await fromField.count()) === 0) {
    errors.push(`[${at}] в журнале нет поля «Дата с»`);
  } else {
    await fromField.click();
    try {
      await page
        .getByText('Пн', { exact: true })
        .first()
        .waitFor({ state: 'visible', timeout: 4000 });
    } catch {
      errors.push(`[${at}] журнал: календарь «Дата с» не раскрылся`);
    }
    const day = String(new Date().getDate());
    const cell = page.getByRole('button', { name: day, exact: true }).last();
    if (await cell.count()) {
      const box = await cell.boundingBox();
      if (box && box.y + box.height > h) {
        errors.push(
          `[${at}] календарь журнала не поместился на экране: день на ${Math.round(box.y)} при высоте ${h}`,
        );
      }
      await cell.click();
      await page.waitForTimeout(1800);
      const byDay = await rowCount(page);
      notes.push(`[${at}] журнал с сегодняшнего дня: ${byDay} из ${total}`);
      if (byDay > total) {
        errors.push(`[${at}] период за один день дал движений больше, чем всё время: ${byDay} > ${total}`);
      }
      if (byDay === total && total > 0) {
        errors.push(`[${at}] фильтр периода в журнале ничего не сузил: ${byDay} из ${total}`);
      }
      await panel.getByRole('button', { name: 'Сбросить' }).first().click();
      await page.waitForTimeout(1500);
    } else {
      await page.keyboard.press('Escape');
      errors.push(`[${at}] в календаре журнала не нашлось сегодняшнего числа (${day})`);
    }
  }

  // --- запись и отмена, не уходя с журнала ---------------------------------
  // Форма стоит в правой панели и на этой вкладке тоже. Проверяется три вещи
  // сразу: журнал сам обновился после записи (иначе человек нажимает F5 и
  // решает, что запись не прошла), у своего движения отмена предложена, и
  // отмена действительно отменяет — сторно сверху, у прежней строки пометка.
  if (pick) {
    const before = await rowCount(page);
    const ok =
      (await chooseOption(page, at, 'Номенклатура', (t) => t.includes(pick.code), `с кодом ${pick.code}`)) &&
      (await chooseOption(
        page,
        at,
        'Склад получения',
        (t) => t.includes(pick.warehouse),
        `со складом ${pick.warehouse}`,
      )) &&
      (await chooseOption(
        page,
        at,
        'Ячейка получения',
        (t) => t.includes(pick.cell.split('/')[1]),
        `с ячейкой ${pick.cell}`,
      ));
    if (ok) {
      await formInput(page, 'Партия').fill(pick.batch);
      await formInput(page, 'Количество').fill('2');
      await formInput(page, 'Цена за единицу').fill('1000');
      await page.getByRole('button', { name: 'Записать', exact: true }).first().click();
      await page.waitForTimeout(2500);

      const afterWrite = await rowCount(page);
      const written = await journalRows(page);
      const mine = written.filter((r) => r.text.includes('Сторно'));
      notes.push(
        `[${at}] журнал после записи: ${before} → ${afterWrite}, строк с отменой ${mine.length}`,
      );
      if (afterWrite <= before) {
        errors.push(`[${at}] журнал не обновился после записи: было ${before}, стало ${afterWrite}`);
      }
      // Записанное движение стоит в журнале первой строкой и помечено временем
      // записи. Журнал упорядочен по времени операции, и движению, которому
      // поставили день без времени, достаётся начало дня: на живом складе оно
      // уезжает под полсотни чужих строк, и человек не находит сверху того,
      // что только что записал. Проверяем обе половины сразу — и порядок, и
      // само время: иначе на свежей базе, где за сегодня движений мало,
      // запись с начала дня тоже оказалась бы на первой странице.
      const minutes = Array.from({ length: 6 }, (_, i) => {
        const d = new Date(Date.now() - i * 60000);
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      });
      const head = written[0]?.text ?? '';
      notes.push(`[${at}] журнал, первая строка после записи: ${head.slice(0, 80)}`);
      const headIsMine =
        head.includes(pick.batch) && head.includes('Приход') && !head.includes('сторно');
      if (!headIsMine || !minutes.some((t) => head.includes(t))) {
        errors.push(
          `[${at}] записанного прихода нет сверху журнала временем записи: «${head.slice(0, 90)}»`,
        );
      }
      if (mine.length === 0) {
        errors.push(`[${at}] у своего движения в журнале не предложена отмена`);
      } else if (!mine.some((r) => r.text.includes(pick.code) && r.text.includes('Приход'))) {
        errors.push(
          `[${at}] отмена предложена не у записанного прихода: «${mine[0].text.slice(0, 90)}»`,
        );
      } else {
        const storno = page
          .locator('[role="tabpanel"] tbody tr, [role="tabpanel"] ul li')
          .filter({ has: page.getByRole('button', { name: 'Сторно' }) })
          .first();
        await storno.getByRole('button', { name: 'Сторно' }).first().click();
        await page.waitForTimeout(2500);

        const after = await journalRows(page);
        const afterStorno = await rowCount(page);
        notes.push(
          `[${at}] журнал после отмены: ${afterWrite} → ${afterStorno}, сверху: ${(after[0]?.text ?? '').slice(0, 60)}`,
        );
        if (afterStorno <= afterWrite) {
          errors.push(`[${at}] сторно не добавило встречного движения: ${afterWrite} → ${afterStorno}`);
        }
        // Встречное движение пишется текущим временем, поэтому оно наверху.
        if (!(after[0]?.text ?? '').includes('сторно')) {
          errors.push(
            `[${at}] встречное движение не помечено «сторно»: «${(after[0]?.text ?? '').slice(0, 90)}»`,
          );
        }
        if (!after.some((r) => r.text.includes('отменено'))) {
          errors.push(`[${at}] отменённое движение нигде не помечено «отменено»`);
        }
        // И отмену больше не предлагают ни встречному движению, ни
        // отменённому: второе сторно того же движения сервер не примет.
        const again = after.filter(
          (r) => (r.text.includes('сторно') || r.text.includes('отменено')) && r.text.includes('Сторно'),
        );
        if (again.length) {
          errors.push(
            `[${at}] отмену предлагают уже отменённому движению (${again.length}): «${again[0].text.slice(0, 90)}»`,
          );
        }
        await page.screenshot({ path: `${OUT}/warehouse-moves-storno-${tag}.png` });
      }
    }
  }

  // Возвращаемся на остатки: дальше прогон сверяет числа по их таблице.
  await page.getByRole('tab', { name: 'Остатки по партиям' }).first().click();
  await page.waitForTimeout(1500);
}

// ---------------------------------------------------------------------------
// Резервы
// ---------------------------------------------------------------------------

/**
 * Поле формы резерва: она стоит внутри панели вкладки, а не в `<form>` правой
 * панели. Поиск по всей странице попадал бы в одноимённые поля формы операции.
 */
const reserveField = (page, ariaLabel) =>
  page
    .locator('[role="tabpanel"]')
    .first()
    .getByRole('button', { name: ariaLabel, exact: true })
    .first();

const reserveInput = (page, ariaLabel) =>
  page
    .locator('[role="tabpanel"]')
    .first()
    .getByRole('textbox', { name: ariaLabel, exact: true })
    .first();

/**
 * На сколько раскрытый список обрезан своими предками.
 *
 * Список резерва рисуется внутри блока, а не поверх страницы, и любой предок с
 * `overflow` режет его по своему краю. На вид это просто короткий список —
 * Playwright такой пункт считает видимым и спокойно по нему щёлкает, так что
 * без прямого замера проверка остаётся зелёной на обрезанной панели.
 */
const menuClipped = (menu) =>
  menu.evaluate((el) => {
    const r = el.getBoundingClientRect();
    let box = { top: 0, left: 0, right: window.innerWidth, bottom: window.innerHeight };
    for (let p = el.parentElement; p; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (!/auto|scroll|hidden|clip/.test(cs.overflowY + cs.overflowX)) continue;
      const pr = p.getBoundingClientRect();
      box = {
        top: Math.max(box.top, pr.top),
        left: Math.max(box.left, pr.left),
        right: Math.min(box.right, pr.right),
        bottom: Math.min(box.bottom, pr.bottom),
      };
    }
    return {
      bottom: Math.round(Math.max(0, r.bottom - box.bottom)),
      top: Math.round(Math.max(0, box.top - r.top)),
      right: Math.round(Math.max(0, r.right - box.right)),
    };
  });

/** Выбор пункта в списке формы резерва. То же, что `chooseOption`, но в панели. */
async function chooseInPanel(page, at, ariaLabel, matches, what) {
  const trigger = reserveField(page, ariaLabel);
  if ((await trigger.count()) === 0) {
    errors.push(`[${at}] в форме резерва нет поля «${ariaLabel}»`);
    return null;
  }
  await trigger.click();
  const menu = page.locator('[role="listbox"]').last();
  try {
    await menu.waitFor({ state: 'visible', timeout: 4000 });
  } catch {
    errors.push(`[${at}] «${ariaLabel}»: список резерва не раскрылся`);
    return null;
  }
  const cut = await menuClipped(menu);
  if (cut.bottom > 1 || cut.top > 1 || cut.right > 1) {
    errors.push(
      `[${at}] список «${ariaLabel}» обрезан предком: снизу ${cut.bottom}px, сверху ${cut.top}px, справа ${cut.right}px`,
    );
  }
  const items = menu.locator('button');
  const seen = (await items.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
  const hit = seen.findIndex(matches);
  if (hit < 0) {
    await page.keyboard.press('Escape');
    errors.push(
      `[${at}] в списке «${ariaLabel}» нет пункта ${what}; есть: ` +
        (seen.length ? seen.slice(0, 3).join(' | ') : 'ничего'),
    );
    return null;
  }
  const text = seen[hit];
  await items.nth(hit).click();
  await page.waitForTimeout(500);
  return text;
}

/**
 * Резервы: кому обещан товар, который ещё лежит на складе.
 *
 * Проверяется не наличие таблицы, а то, ради чего вкладку открывают: что резерв
 * назван заказом и покупателем (иначе список говорит «обещано», но не кому),
 * что резерв ставится с экрана и что снятие возвращает доступное.
 *
 * Круг «поставить — снять» идёт по свободному количеству из списка выбора: оно
 * считается сервером из тех же строк резерва, и если после постановки доступное
 * не уменьшилось, значит `qty_reserved` перестал быть их свёрткой.
 */
async function runReservationsTab(page, at, withWrite = false) {
  const tab = page.getByRole('tab', { name: 'Резервы' });
  if ((await tab.count()) === 0) {
    errors.push(`[${at}] на экране склада нет вкладки «Резервы»`);
    return;
  }
  await tab.first().click();
  await page.waitForTimeout(1800);

  const panel = page.locator('[role="tabpanel"]').first();
  if ((await panel.count()) === 0) {
    errors.push(`[${at}] вкладка «Резервы» открылась пустой: панели резервов нет`);
    return;
  }

  const total = await rowCount(page);
  const rows = await journalRows(page);
  notes.push(`[${at}] резервы: всего ${total}, на странице ${rows.length}`);
  if (total === 0 || rows.length === 0) {
    errors.push(`[${at}] список резервов пуст: всего ${total}, строк ${rows.length}`);
    return;
  }

  // Заказ и покупатель: резерв без них никому не объясняет, чей товар держит.
  const named = rows.filter((r) => /(ТД|ЗВ)-\d{5}/.test(r.text)).length;
  notes.push(`[${at}] резервов с номером заказа: ${named} из ${rows.length}`);
  if (named === 0) {
    errors.push(`[${at}] ни один резерв не назван заказом: ${rows[0].text.slice(0, 120)}`);
  }

  const tag = at.replace('/', '-');
  await page.screenshot({ path: `${OUT}/warehouse-reservations-${tag}.png`, fullPage: true });
  overflow.push({ key: `${at}/reservations`, isDefault: true, ...(await measure(page)) });
  reportCut(await tableCut(page), at, 'резервы');

  // Строки списка лежат ниже формы постановки: на узком экране без прокрутки
  // их никто не видел.
  await page.evaluate(() => {
    const row = document.querySelector('[role="tabpanel"] ul li, [role="tabpanel"] tbody tr');
    row?.scrollIntoView({ block: 'center' });
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/warehouse-reservations-rows-${tag}.png` });
  overflow.push({ key: `${at}/reservations-rows`, isDefault: true, ...(await measure(page)) });

  // Состав формы постановки. Кладовщик имеет право `warehouse.move`, поэтому
  // форма ему показана; без права её не должно быть вовсе, но это проверяет
  // сервер, а не экран.
  for (const field of ['Номенклатура и партия', 'Срок резерва']) {
    if ((await reserveField(page, field).count()) === 0) {
      errors.push(`[${at}] в форме резерва нет поля «${field}»`);
    }
  }
  for (const field of ['Количество', 'Номер заказа']) {
    if ((await reserveInput(page, field).count()) === 0) {
      errors.push(`[${at}] в форме резерва нет поля «${field}»`);
    }
  }
  if ((await panel.getByRole('button', { name: 'Зарезервировать' }).count()) === 0) {
    errors.push(`[${at}] в форме резерва нет кнопки «Зарезервировать»`);
  }

  if (!withWrite) {
    await page.getByRole('tab', { name: 'Остатки по партиям' }).first().click();
    await page.waitForTimeout(1500);
    return;
  }

  // --- круг «поставить — снять» ---------------------------------------------
  const free = (text) => {
    const m = String(text).match(/доступно\s+([\d\s ,.]+)/);
    return m ? Number(m[1].replace(/[\s ]/g, '').replace(',', '.')) : null;
  };

  const picked = await chooseInPanel(
    page,
    at,
    'Номенклатура и партия',
    (t) => /доступно\s+[1-9]/.test(t),
    'с доступным количеством',
  );
  if (!picked) return;
  const before = free(picked);
  notes.push(`[${at}] резерв ставим на «${picked}»`);

  await reserveInput(page, 'Количество').fill('1');
  await page.getByRole('button', { name: 'Зарезервировать' }).first().click();
  await page.waitForTimeout(2000);

  const after = await rowCount(page);
  if (after !== total + 1) {
    errors.push(`[${at}] после постановки резервов ${after}, а было ${total}: резерв не появился`);
    return;
  }

  // Доступное должно просесть ровно на зарезервированное: экран читает его из
  // остатка, а остаток — свёртка резервов.
  const again = await chooseInPanel(
    page,
    at,
    'Номенклатура и партия',
    (t) => t.startsWith(picked.split(' — ')[0]),
    'та же партия после постановки',
  );
  const now = again ? free(again) : null;
  notes.push(`[${at}] доступно было ${before}, стало ${now}`);
  if (before !== null && now !== null && Math.abs(before - now - 1) > 0.001) {
    errors.push(
      `[${at}] доступное не уменьшилось на резерв: было ${before}, стало ${now}, зарезервировано 1`,
    );
  }

  await page.screenshot({ path: `${OUT}/warehouse-reserve-made-${tag}.png`, fullPage: true });
  overflow.push({ key: `${at}/reserve-made`, isDefault: true, ...(await measure(page)) });

  // Снимаем свой резерв: он стоит первым — список отсортирован по времени.
  const drop = panel.getByRole('button', { name: 'Снять' }).first();
  if ((await drop.count()) === 0) {
    errors.push(`[${at}] у резерва нет кнопки «Снять»`);
    return;
  }
  await drop.click();
  await page.waitForTimeout(2000);

  const back = await rowCount(page);
  notes.push(`[${at}] после снятия резервов ${back}`);
  if (back !== total) {
    errors.push(`[${at}] после снятия резервов ${back}, а до круга было ${total}`);
  }

  await page.getByRole('tab', { name: 'Остатки по партиям' }).first().click();
  await page.waitForTimeout(1500);
}

/**
 * Переход по цепочке прослеживаемости (ТЗ 5.6).
 *
 * Ответ «сделано из партии П-00123» обязан вести дальше: иначе следующий
 * вопрос — «а та партия откуда» — человек закрывает поиском по таблице руками.
 *
 * Идём на завод: цепочка длиннее одного звена бывает только там, где есть цех.
 * У торгового дома партия куплена и отгружена, ссылаться в ней не на что, и
 * требовать перехода на его складе значило бы требовать выдуманных данных.
 * Партию перебираем по строкам: первая попавшаяся может оказаться купленной.
 */
async function runChainJump(page, at) {
  await page.getByRole('button', { name: 'Закрыть' }).first().click();
  await page.waitForTimeout(400);
  if (!(await switchCompany(page, 'Ташкентский изоляционный завод', at))) return;

  const number = () => page.locator('span.font-mono.text-sm').first().innerText();
  const close = async () => {
    const x = page.getByRole('button', { name: 'Закрыть' });
    if ((await x.count()) > 0) await x.first().click({ timeout: 5000 });
    await page.waitForTimeout(300);
  };
  let found = false;
  let opened = 0;

  // Партий на складе завода шесть десятков, и цепочка длиннее звена есть
  // примерно у трети: перебираем, пока не найдём, а не смотрим одну верхнюю.
  for (let row = 0; row < 15 && !found; row += 1) {
    const open = page.getByRole('button', { name: /^Путь( партии)?$/ });
    if ((await open.count()) <= row) break;
    await open.nth(row).click({ timeout: 5000 });
    await page.waitForTimeout(800);
    if ((await page.getByText('Откуда пришло', { exact: true }).count()) === 0) {
      errors.push(`[${at}] панель пути партии не открылась на заводе`);
      return;
    }
    opened += 1;

    const jump = page.locator('button.font-mono.underline');
    if ((await jump.count()) === 0) {
      await close();
      continue;
    }

    found = true;
    const before = await number();
    await jump.first().click();
    await page.waitForTimeout(1200);
    const after = await number();
    if (after === before) {
      errors.push(`[${at}] переход по цепочке не сменил партию (${before})`);
    } else {
      notes.push(`[${at}] переход по цепочке: ${before} → ${after}`);
    }
    await page.screenshot({ path: `${OUT}/warehouse-trace-chain.png`, fullPage: true });
    overflow.push({ key: `${at}/trace-chain`, isDefault: true, ...(await measure(page)) });
    await page.getByRole('button', { name: 'Закрыть' }).first().click();
    await page.waitForTimeout(300);
  }

  if (!found) {
    errors.push(
      `[${at}] ни у одной из первых ${opened} партий завода цепочка не ведёт дальше`,
    );
  }

  await switchCompany(page, 'Металл Азия', at);
  // Возвращаем экран в то состояние, в котором проверка его забрала: открытая
  // панель пути у торгового дома. Иначе следующий шаг ищет кнопку «Закрыть»
  // у закрытой панели и висит до таймаута.
  await page.getByRole('button', { name: /^Путь( партии)?$/ }).first().click({ timeout: 5000 });
  await page.waitForTimeout(1200);
}

/**
 * Штучный учёт (ТЗ 5.6).
 *
 * Труба большого диаметра лежит на складе завода по своему номеру, а не
 * тоннами. Проверяем то, из-за чего штучный учёт и заводят: строка остатка
 * названа номером, у неё своя кнопка пути, и по ней открывается не карточка
 * партии, а путь одной штуки — с состоянием и местом.
 *
 * Ничего не пишет: и поиск, и панель — чтение.
 */
async function runSerialTrace(page, at, tag, theme) {
  // На узком экране сайдбар свёрнут, и переключателя компаний в нём нет:
  // без этого шага клик уходил мимо, и прогон дальше смотрел не на ту
  // компанию, не заметив этого. Разворачиваем только на время переключения и
  // сразу сворачиваем: замер ширины идёт в состоянии по умолчанию, а с
  // развёрнутым сайдбаром на 360 контенту остаётся полоса в сотню пикселей —
  // вылезет что угодно, и к серийному учёту это отношения не имеет.
  const narrow = tag === '360';
  const toggleSidebar = async () => {
    const toggle = page.getByRole('button', { name: /боковую панель/i }).first();
    if ((await toggle.count()) === 0) return false;
    await toggle.click({ timeout: 5000 });
    await page.waitForTimeout(600);
    return true;
  };
  /** Переключение компании: на узком экране — с разворотом сайдбара и обратно. */
  const toCompany = async (name) => {
    if (!narrow) return switchCompany(page, name, at);
    if (!(await toggleSidebar())) {
      errors.push(`[${at}] на узком экране нет кнопки сайдбара: компанию не переключить`);
      return false;
    }
    const ok = await switchCompany(page, name, at);
    await toggleSidebar();
    return ok;
  };

  if (!(await toCompany('Ташкентский изоляционный завод'))) return;

  const box = page.getByRole('searchbox', { name: 'Поиск' }).first();
  await box.fill('SN-530');
  await page.waitForTimeout(1600);

  const rows = await rowCount(page);
  notes.push(`[${at}] поиск по серийному номеру «SN-530»: ${rows}`);
  if (rows === 0) {
    errors.push(`[${at}] поиск по серийному номеру не нашёл ни одной строки`);
    await box.fill('');
    await toCompany('Металл Азия');
    return;
  }

  // Номер обязан быть на строке остатка: без него восемь одинаковых труб
  // на экране неразличимы, и кладовщик не знает, какую снимать с полки.
  const body = await page.locator('body').innerText();
  if (!/SN-530-\d{4}-\d{4}/.test(body)) {
    errors.push(`[${at}] в строке остатка нет серийного номера`);
  }

  const open = page.getByRole('button', { name: /^Путь( номера)?$/ });
  if ((await open.count()) === 0) {
    errors.push(`[${at}] у строки с серийным номером нет кнопки пути`);
    await box.fill('');
    await toCompany('Металл Азия');
    return;
  }
  await open.first().click({ timeout: 5000 });
  await page.waitForTimeout(1400);

  // «Сейчас» и «Журнал движений» — то, ради чего панель открывают. Раздела
  // «Откуда пришло» тут быть не должно: это карточка партии, а у штучной
  // позиции партии нет.
  for (const head of ['Сейчас', 'Журнал движений']) {
    if ((await page.getByText(head, { exact: true }).count()) === 0) {
      errors.push(`[${at}] в пути номера нет раздела «${head}»`);
    }
  }
  const state = await page
    .locator('text=Журнал движений')
    .first()
    .evaluate((el) => el.closest('div[class*="rounded-xl"]')?.innerText ?? '')
    .catch(() => '');
  if (!/на складе|в производстве|отгружена|списана/.test(state)) {
    errors.push(`[${at}] путь номера не называет состояние штуки`);
  } else {
    notes.push(`[${at}] путь номера открыт: ${state.split('\n').slice(0, 3).join(' · ')}`);
  }

  await page.getByText('Журнал движений', { exact: true }).first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/warehouse-serial-${tag}-${theme}.png`, fullPage: true });
  overflow.push({ key: `${at}/serial`, isDefault: true, ...(await measure(page)) });

  await page.getByRole('button', { name: 'Закрыть' }).first().click({ timeout: 5000 });
  await page.waitForTimeout(400);
  await box.fill('');
  await page.waitForTimeout(1200);
  await toCompany('Металл Азия');
}

/**
 * Переключатель компаний в шапке сайдбара — тот же, которым пользуется человек.
 *
 * Выбираем кнопкой из списка, а не первым совпадением текста: короткое имя
 * компании стоит и в самой шапке, и оно же попадается раньше пункта списка —
 * клик по нему просто закрывает список, и прогон дальше смотрит не на ту
 * компанию, не заметив этого. Поэтому после выбора сверяем шапку.
 */
async function switchCompany(page, name, at) {
  await page.locator('aside [data-company-switch="logo"]').first().click();
  await page.waitForTimeout(400);
  const option = page.locator('aside button').filter({ hasText: name });
  if ((await option.count()) === 0) {
    errors.push(`[${at}] в переключателе нет компании «${name}»`);
    await page.keyboard.press('Escape');
    return false;
  }
  await option.last().click({ timeout: 5000 });
  await page.waitForTimeout(1500);

  // Сверяем по подписи значка, а не по тексту сайдбара: в шапке стоит короткое
  // имя («ТИЗ»), а не название юрлица целиком, и после переименования компаний
  // 08.10 проверка по innerText ругалась на верном переключении.
  const head =
    (await page.locator('aside [data-company-switch="logo"]').first().getAttribute('title')) ?? '';
  if (!head.includes(name)) {
    errors.push(`[${at}] компания не переключилась на «${name}»`);
    return false;
  }
  return true;
}

/**
 * Инвентаризация (ТЗ 5.8).
 *
 * Проверяем не только «таблица нарисовалась»: у листа есть состояние, и от него
 * зависит, что человеку показано. Утверждённый лист считать нельзя — поля факта
 * в нём быть не должно; кладовщику, у которого нет права
 * `warehouse.inventory.approve`, нельзя показывать кнопку утверждения, иначе он
 * будет жать её и получать отказ.
 *
 * Подсчёт строки остаток не меняет — меняет его только утверждение. Поэтому
 * круг «записать факт» безопасен для живой базы, и делать его можно в любом
 * прогоне; факт пишем равным учётному, чтобы лист не оброс расхождениями,
 * которых у полки никто не видел.
 */
async function runInventoryTab(page, at, withWrite = false) {
  const tab = page.getByRole('tab', { name: 'Инвентаризация' });
  if ((await tab.count()) === 0) {
    errors.push(`[${at}] на экране склада нет вкладки «Инвентаризация»`);
    return;
  }
  await tab.first().click();
  await page.waitForTimeout(1800);

  const panel = page.locator('[role="tabpanel"]').first();
  if ((await panel.count()) === 0) {
    errors.push(`[${at}] вкладка «Инвентаризация» открылась пустой`);
    return;
  }

  const tag = at.replace('/', '-');
  const total = await rowCount(page);
  const rows = await journalRows(page);
  notes.push(`[${at}] листы инвентаризации: всего ${total}, на странице ${rows.length}`);
  if (total === 0 || rows.length === 0) {
    errors.push(`[${at}] список листов пуст: всего ${total}, строк ${rows.length}`);
    return;
  }

  // Состояния должны быть разные: на одном «Черновик» ни фильтр, ни цвет
  // проверить нечем, а экран выглядит рабочим.
  const states = ['Утверждён', 'Считают', 'На утверждении', 'Отменён'].filter((s) =>
    rows.some((r) => r.text.includes(s)),
  );
  notes.push(`[${at}] состояния на экране: ${states.join(', ') || 'ни одного'}`);
  if (!states.includes('Утверждён')) {
    errors.push(`[${at}] среди листов нет утверждённого: ${rows[0].text.slice(0, 120)}`);
  }
  if (states.length < 2) {
    errors.push(`[${at}] листы все в одном состоянии: ${states.join(', ')}`);
  }

  // Форма нового листа. Режим на время пересчёта выбирают здесь, до подсчёта.
  for (const field of ['Склад', 'Зона', 'Режим на время пересчёта']) {
    if ((await reserveField(page, field).count()) === 0) {
      errors.push(`[${at}] в форме нового листа нет поля «${field}»`);
    }
  }
  if ((await reserveInput(page, 'Комментарий').count()) === 0) {
    errors.push(`[${at}] в форме нового листа нет поля «Комментарий»`);
  }
  if ((await panel.getByRole('button', { name: 'Новый лист' }).count()) === 0) {
    errors.push(`[${at}] в форме нового листа нет кнопки «Новый лист»`);
  }

  await page.screenshot({ path: `${OUT}/warehouse-inventory-${tag}.png`, fullPage: true });
  overflow.push({ key: `${at}/inventory`, isDefault: true, ...(await measure(page)) });
  reportCut(await tableCut(page), at, 'листы инвентаризации');

  // --- утверждённый лист ----------------------------------------------------
  const approvedAt = rows.findIndex((r) => r.text.includes('Утверждён'));
  if (approvedAt >= 0) {
    await openSheetAt(page, approvedAt);
    const head = await panel.innerText();
    if (!/ИНВ-\d{5}/.test(head)) {
      errors.push(`[${at}] у открытого листа нет номера: ${head.slice(0, 120)}`);
    }
    const lines = await journalRows(page);
    notes.push(`[${at}] утверждённый лист: строк ${lines.length}`);
    if (lines.length === 0) errors.push(`[${at}] открытый лист без строк`);
    // Расхождение читаем из своей колонки, а не поиском «минуса» по строке:
    // дефис есть и в артикуле, и в номере партии, и такая проверка была бы
    // зелёной всегда.
    const diffs = await sheetDiffCount(panel);
    if (diffs === null) {
      notes.push(`[${at}] расхождения в строках считаем на широком экране`);
    } else {
      notes.push(`[${at}] строк с расхождением: ${diffs} из ${lines.length}`);
      if (diffs === 0) {
        errors.push(`[${at}] в утверждённом листе ни одного расхождения: сверять нечего`);
      }
      if (diffs === lines.length && lines.length > 1) {
        errors.push(`[${at}] расхождение стоит у всех ${lines.length} строк: колонка читается неверно`);
      }
    }
    // Утверждённый лист не считают: поля факта в нём быть не должно.
    if ((await panel.getByRole('button', { name: 'Записать' }).count()) > 0) {
      errors.push(`[${at}] в утверждённом листе есть кнопка «Записать»: его нельзя пересчитывать`);
    }
    // Кладовщику утверждение недоступно — права `warehouse.inventory.approve`
    // у него нет, и кнопки быть не должно ни на одном листе.
    if ((await panel.getByRole('button', { name: 'Утвердить' }).count()) > 0) {
      errors.push(`[${at}] кладовщику показана кнопка «Утвердить», хотя права на это у него нет`);
    }
    await page.screenshot({ path: `${OUT}/warehouse-inventory-sheet-${tag}.png`, fullPage: true });
    overflow.push({ key: `${at}/inventory-sheet`, isDefault: true, ...(await measure(page)) });
    reportCut(await tableCut(page), at, 'строки листа');
    await backToSheets(page);
  }

  // --- лист в подсчёте ------------------------------------------------------
  const countingAt = (await journalRows(page)).findIndex((r) => r.text.includes('Считают'));
  if (countingAt >= 0) {
    await openSheetAt(page, countingAt);
    const write = panel.getByRole('button', { name: 'Записать' });
    if ((await write.count()) === 0) {
      errors.push(`[${at}] в листе «Считают» нет кнопки «Записать»: считать нечем`);
    } else if (withWrite) {
      // Факт берём равным учётному: строка станет посчитанной, а расхождения
      // не появится — живая база останется такой, какой была.
      const pick = await panel.evaluate((p) => {
        for (const tr of p.querySelectorAll('tbody tr')) {
          const tds = tr.querySelectorAll('td');
          if (tds.length < 5 || !tds[4].querySelector('input')) continue;
          if (tds[4].querySelector('input').value.trim() !== '') continue;
          return { seq: tds[0].innerText.trim(), expected: tds[3].innerText.trim() };
        }
        return null;
      });
      if (!pick) {
        notes.push(`[${at}] в листе «Считают» непосчитанных строк не осталось`);
      } else {
        const qty = pick.expected.replace(/[\s ]/g, '').replace(',', '.').match(/[\d.]+/)?.[0];
        notes.push(`[${at}] пишем факт ${qty} в строку ${pick.seq}`);
        const row = panel.locator('tbody tr').filter({ hasText: pick.seq }).first();
        await row.getByRole('textbox').first().fill(qty);
        await row.getByRole('button', { name: 'Записать' }).first().click();
        await page.waitForTimeout(2000);
        const saved = await row.getByRole('textbox').first().inputValue();
        if (Math.abs(Number(saved.replace(',', '.')) - Number(qty)) > 0.000001) {
          errors.push(`[${at}] факт не записался: в поле «${saved}», писали «${qty}»`);
        }
        await page.screenshot({
          path: `${OUT}/warehouse-inventory-counted-${tag}.png`,
          fullPage: true,
        });
        overflow.push({ key: `${at}/inventory-counted`, isDefault: true, ...(await measure(page)) });
      }
    }
    await backToSheets(page);
  } else {
    errors.push(`[${at}] среди листов нет идущего подсчёта: считать нечего`);
  }

  await page.getByRole('tab', { name: 'Остатки по партиям' }).first().click();
  await page.waitForTimeout(1500);
}

/**
 * Сколько строк листа разошлись с учётом. Считаем по колонке «Расхождение»:
 * `null` — таблицы на экране нет (узкий экран рисует карточки).
 */
const sheetDiffCount = (panel) =>
  panel.evaluate((p) => {
    const tb = p.querySelector('table tbody');
    if (!tb || tb.offsetParent === null) return null;
    let n = 0;
    for (const tr of tb.querySelectorAll('tr')) {
      const tds = tr.querySelectorAll('td');
      if (tds.length < 6) continue;
      const t = tds[5].innerText.trim();
      if (!t || t === '—') continue;
      const v = Number(t.replace(/[\s +]/g, '').replace(',', '.'));
      if (Number.isFinite(v) && v !== 0) n += 1;
    }
    return n;
  });

/** Открыть лист по его порядку в списке: кнопка «Открыть» стоит в строке. */
async function openSheetAt(page, index) {
  const panel = page.locator('[role="tabpanel"]').first();
  await panel.getByRole('button', { name: 'Открыть' }).nth(index).click();
  await page.waitForTimeout(1800);
}

/** Вернуться к списку листов. */
async function backToSheets(page) {
  await page
    .locator('[role="tabpanel"]')
    .first()
    .getByRole('button', { name: 'К списку' })
    .first()
    .click();
  await page.waitForTimeout(1500);
}

// ---------------------------------------------------------------------------
// Штрихкоды, QR и сканер (ТЗ 5.9)
// ---------------------------------------------------------------------------

/**
 * Круг «напечатали — отсканировали».
 *
 * Проверяет не картинку, а то, что код с этикетки возвращает ровно тот объект,
 * на который её клеили. Разойдись печать и разбор хоть на символ — эта
 * проверка упадёт, а на скриншоте обе стороны выглядели бы одинаково живыми.
 */
async function runScanLabels(page, at, tag, theme) {
  const scanner = page.getByRole('textbox', { name: 'Сканер кода' }).first();
  if ((await scanner.count()) === 0) {
    errors.push(`[${at}] поля сканера на экране нет`);
    return;
  }

  // 1. Негодный код: сообщение, а не тишина и не падение экрана.
  expectScanMiss = true;
  await scanner.fill('MA-НЕТ-ТАКОГО');
  await scanner.press('Enter');
  await page.waitForTimeout(1200);
  expectScanMiss = false;
  const body1 = await page.locator('body').innerText();
  if (!/не распознан|не найден/i.test(body1)) {
    errors.push(`[${at}] сканер промолчал на заведомо негодном коде`);
  }
  // Поле само чистится: следующий штрихкод не должен дописаться к прошлому.
  if ((await scanner.inputValue()) !== '') {
    errors.push(`[${at}] поле сканера не очистилось после ввода`);
  }

  // 2. Отметить строку и напечатать на неё этикетку.
  const mark = page.getByRole('checkbox', { name: /^Отметить к печати:/ }).first();
  if ((await mark.count()) === 0) {
    errors.push(`[${at}] в остатках нет отметки «к печати»`);
    return;
  }
  const marked = (await mark.getAttribute('aria-label')).replace('Отметить к печати:', '').trim();
  await mark.check();
  await page.waitForTimeout(200);

  const openLabels = page.getByRole('button', { name: /^Этикетки/ }).first();
  if ((await openLabels.count()) === 0) {
    errors.push(`[${at}] кнопки «Этикетки» нет`);
    return;
  }
  await openLabels.click();
  await page.waitForTimeout(600);

  const panel = page.getByRole('dialog', { name: 'Этикетки' }).first();
  if ((await panel.count()) === 0) {
    errors.push(`[${at}] панель этикеток не открылась`);
    return;
  }

  // Вид объекта: позиция есть у любой строки остатка, партия — не у любой.
  // Выбор здесь свой, а не общий `chooseOption`: тот ищет поле внутри `form`,
  // а панель этикеток — диалог, формы в нём нет.
  const kindTrigger = panel.getByRole('button', { name: 'Что печатаем', exact: true }).first();
  if ((await kindTrigger.count()) === 0) {
    errors.push(`[${at}] в панели этикеток нет выбора «Что печатаем»`);
  } else {
    await kindTrigger.click();
    const menu = page.locator('[role="listbox"]').last();
    await menu.waitFor({ state: 'visible', timeout: 4000 });
    const items = menu.locator('button');
    const seen = (await items.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
    const hit = seen.findIndex((t) => t === 'Позиция');
    if (hit < 0) {
      errors.push(`[${at}] в списке «Что печатаем» нет «Позиция»; есть: ${seen.join(' | ')}`);
      await page.keyboard.press('Escape');
    } else {
      await items.nth(hit).click();
      await page.waitForTimeout(300);
    }
  }

  await panel.getByRole('button', { name: 'Предпросмотр' }).click();
  await page.waitForTimeout(1500);

  const sheet = page.locator('#label-sheet');
  if ((await sheet.count()) === 0) {
    errors.push(`[${at}] предпросмотр листа этикеток не построился (отмечено ${marked})`);
    await panel.getByRole('button', { name: 'Закрыть этикетки' }).click();
    return;
  }

  // Рисунок кода: без него этикетка — просто подписанный прямоугольник.
  const bars = await sheet.locator('svg rect').count();
  notes.push(`[${at}] этикетки: прямоугольников кода ${bars}`);
  if (bars < 20) errors.push(`[${at}] на этикетке нет рисунка кода: ${bars} прямоугольников`);

  // Лист меряется в миллиметрах, а не в пикселях: 70 мм на бумаге должны
  // остаться семьюдесятью миллиметрами.
  const geom = await sheet.locator('.label-page').first().evaluate((el) => {
    const s = getComputedStyle(el);
    // `offsetWidth` — ширина без сжатия предпросмотра, `getBoundingClientRect`
    // — то, что видно на экране. Для бумаги важна первая.
    return {
      w: Math.round(el.getBoundingClientRect().width),
      raw: el.offsetWidth,
      cols: s.gridTemplateColumns,
    };
  });
  notes.push(`[${at}] лист: на экране ${geom.w}px, в миллиметрах ${geom.raw}px, колонки ${geom.cols}`);
  // 96 dpi: миллиметр это 3.7795 пикселя. Лист A4 шириной 210 мм — 794 px.
  if (geom.raw < 100) errors.push(`[${at}] лист этикеток схлопнулся: ${geom.raw}px`);

  // Панель — окно постоянного размера, а не растущая лента. Раньше лист
  // вытягивал её на три с половиной метра: кнопка «Печать» и шапка уезжали за
  // край, и человек печатал, не видя, что именно.
  const vp = page.viewportSize();
  const panelBox = await panel.boundingBox();
  notes.push(`[${at}] панель этикеток: ${Math.round(panelBox.height)}px при экране ${vp.height}px`);
  if (panelBox.height > vp.height) {
    errors.push(
      `[${at}] панель этикеток выше экрана: ${Math.round(panelBox.height)}px при ${vp.height}px`,
    );
  }
  if (!(await panel.getByRole('button', { name: 'Печать', exact: true }).isVisible())) {
    errors.push(`[${at}] после предпросмотра кнопка «Печать» не видна`);
  }

  // Лист ужимается до ширины панели целиком. Прокрутка вбок показывала на
  // телефоне один столбец из трёх — то есть прятала ровно то, ради чего
  // предпросмотр и нужен.
  const fit = await page.evaluate(() => {
    const slot = document.querySelector('.sheet-slot');
    const box = document.querySelector('.sheet-box');
    if (!slot || !box) return null;
    return {
      slot: Math.round(slot.getBoundingClientRect().width),
      box: Math.round(box.clientWidth),
    };
  });
  if (!fit) {
    errors.push(`[${at}] лист этикеток не в рамке предпросмотра`);
  } else {
    notes.push(`[${at}] лист в панели: ${fit.slot}px в области ${fit.box}px`);
    if (fit.slot > fit.box + 1) {
      errors.push(`[${at}] лист не влезает в панель: ${fit.slot}px при ${fit.box}px`);
    }
  }

  // На экране виден один лист, на бумагу уходят все.
  const inDom = await sheet.locator('.label-page').count();
  const onScreen = await sheet.locator('.label-page:visible').count();
  notes.push(`[${at}] листов в разметке ${inDom}, на экране видно ${onScreen}`);
  if (inDom > 1 && onScreen !== 1) {
    errors.push(`[${at}] на экране видно листов ${onScreen}, а должен быть один`);
  }

  const code = (await sheet.locator('span.font-mono').first().innerText()).trim();
  notes.push(`[${at}] код первой этикетки: ${code}`);
  if (!/^MA[IBSL]\d{10}$/.test(code)) {
    errors.push(`[${at}] на этикетке напечатан код неизвестного вида: «${code}»`);
  }

  if (tag === '1440' && theme === 'light') {
    await page.screenshot({ path: `${OUT}/warehouse-labels-${tag}-${theme}.png`, fullPage: true });
  }
  overflow.push({ key: `${at}/labels`, isDefault: false, ...(await measure(page)) });

  // На бумагу должен уйти лист, а не экран. Проверяем правилами печати, а не
  // на глаз: `@media print` в браузере ничем другим не видно, а напечатанное
  // меню поверх этикетки замечают уже на испорченной бумаге.
  await page.emulateMedia({ media: 'print' });
  await page.waitForTimeout(300);
  const printed = {
    sheet: await sheet.isVisible(),
    menu: await page.getByRole('button', { name: 'Дашборд' }).first().isVisible(),
    panelHead: await panel.getByText('Печать этикеток').first().isVisible(),
  };
  if (!printed.sheet) errors.push(`[${at}] при печати лист этикеток не виден`);
  // Сжатие предпросмотра на бумагу не уходит: 96 dpi, A4 — 794 px.
  const paper = await sheet.locator('.label-page').first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  });
  const paperPages = await sheet.locator('.label-page:visible').count();
  notes.push(`[${at}] на бумаге лист ${paper.w}×${paper.h}px, листов ${paperPages}`);
  if (Math.abs(paper.w - geom.raw) > 1) {
    errors.push(
      `[${at}] на бумагу лист уходит сжатым: ${paper.w}px вместо ${geom.raw}px`,
    );
  }
  if (paperPages !== inDom) {
    errors.push(`[${at}] на бумагу уходит листов ${paperPages} из ${inDom}`);
  }
  if (printed.menu) errors.push(`[${at}] при печати на бумагу уходит боковое меню`);
  if (printed.panelHead) errors.push(`[${at}] при печати на бумагу уходит шапка панели`);
  if (tag === '1440' && theme === 'light') {
    await page.screenshot({ path: `${OUT}/warehouse-labels-print.png`, fullPage: true });
  }
  await page.emulateMedia({ media: 'screen' });
  await page.waitForTimeout(300);

  await panel.getByRole('button', { name: 'Закрыть этикетки' }).click();
  await page.waitForTimeout(400);

  // 3. Тот же код обратно в сканер: должна найтись та же позиция.
  await scanner.fill(code);
  await scanner.press('Enter');
  await page.waitForTimeout(1500);
  const hit = await page.locator('body').innerText();
  if (!hit.includes(code)) {
    errors.push(`[${at}] код с этикетки «${code}» не нашёл объект`);
  } else if (!hit.includes('по нашей этикетке')) {
    errors.push(`[${at}] код с этикетки «${code}» разобран не как наш код`);
  }
  if (!hit.includes(marked)) {
    errors.push(`[${at}] этикетку печатали на «${marked}», а скан привёл к другому объекту`);
  }

  // Прибрать за собой. Скан позиции сам ставит её код в поиск — так и надо
  // человеку, но следующие проверки прогона считают строки всей выборки.
  await page.getByRole('searchbox', { name: 'Поиск' }).first().fill('');
  await page.waitForTimeout(1200);
  const left = page.getByRole('checkbox', { name: /^Отметить к печати:/ });
  const n = await left.count();
  for (let i = 0; i < n; i += 1) {
    if (await left.nth(i).isChecked()) await left.nth(i).uncheck();
  }
  await page.waitForTimeout(200);
}

/**
 * Потребность в закупке (ТЗ 5.10).
 *
 * Проверяется не «таблица нарисовалась», а то, ради чего отчёт открывают:
 *   - в нём есть строки с дозаказом, и нулевых сразу все не бывает;
 *   - критическая строка действительно критическая: доступное ниже уровня,
 *     а не просто покрашено красным;
 *   - фильтр состояния сужает выборку и сходится со счётчиком тревоги, а
 *     «с теми, что в норме» расширяет показ, счётчиков не трогая;
 *   - разрез строки назван: «по компании» или склад — одна цифра про все
 *     склады и цифра про один закупаются по-разному.
 *
 * Отчёт только читает, поэтому прогон здесь ничего не пишет и не убирает.
 */
async function needsRows(page) {
  return page
    .locator('[role="tabpanel"]')
    .first()
    .evaluate((panel) => {
      const table = panel.querySelector('table tbody');
      if (table && table.offsetParent !== null) {
        return [...table.querySelectorAll('tr')].map((tr) => ({
          text: tr.innerText.replace(/\s+/g, ' ').trim(),
          cells: [...tr.querySelectorAll('td')].map((td) =>
            td.innerText.replace(/\s+/g, ' ').trim(),
          ),
        }));
      }
      const list = panel.querySelector('ul');
      return list
        ? [...list.querySelectorAll('li')].map((li) => ({
            text: li.innerText.replace(/\s+/g, ' ').trim(),
            cells: [],
          }))
        : [];
    });
}

async function runNeedsTab(page, at, tag, theme) {
  const tab = page.getByRole('tab', { name: 'Потребность в закупке' });
  if ((await tab.count()) === 0) {
    errors.push(`[${at}] на экране склада нет вкладки «Потребность в закупке»`);
    return;
  }
  await tab.first().click();
  await page.waitForTimeout(1800);

  const panel = page.locator('[role="tabpanel"]').first();
  if ((await panel.count()) === 0) {
    errors.push(`[${at}] вкладка «Потребность в закупке» открылась пустой`);
    return;
  }

  const total = await rowCount(page);
  const rows = await needsRows(page);
  notes.push(`[${at}] потребность: всего ${total}, на экране ${rows.length}`);
  if (total === 0 || rows.length === 0) {
    errors.push(`[${at}] отчёт потребности пуст: всего ${total}, строк ${rows.length}`);
    return;
  }

  // Счётчики тревоги. Без цифр в них отчёт не говорит, что горит.
  const counters = await panel.innerText();
  const critical = Number(counters.match(/критических:\s*(\d+)/)?.[1] ?? -1);
  const belowMin = Number(counters.match(/ниже минимума:\s*(\d+)/)?.[1] ?? -1);
  notes.push(`[${at}] счётчики: критических ${critical}, ниже минимума ${belowMin}`);
  if (critical < 0 || belowMin < 0) {
    errors.push(`[${at}] в отчёте нет счётчиков тревоги`);
  }

  // Дозаказ. Строка отчёта без числа «сколько дозаказать» бесполезна: именно
  // за ним закупка сюда и приходит.
  const withNeed = rows.filter((r) => /\+\s?[\d\s.,]+/.test(r.text)).length;
  notes.push(`[${at}] строк с дозаказом: ${withNeed} из ${rows.length}`);
  if (withNeed === 0) {
    errors.push(`[${at}] ни в одной строке отчёта нет дозаказа: ${rows[0].text.slice(0, 140)}`);
  }

  // Разрез: складская строка называет склад, компанийская — говорит об этом.
  const scoped = rows.filter((r) => /По компании|Kompaniya bo/.test(r.text)).length;
  notes.push(`[${at}] строк «по компании»: ${scoped} из ${rows.length}`);
  if (scoped === rows.length) {
    errors.push(`[${at}] в отчёте нет ни одной складской строки: уровень на склад не показан`);
  }

  // Критическая строка: доступное обязано быть ниже уровня. Числа берём из
  // ячеек таблицы — на 360 её нет, и там эта проверка пропускается.
  const criticalRow = rows.find((r) => r.text.includes('Критический'));
  if (criticalRow && criticalRow.cells.length >= 8) {
    const available = toNum(criticalRow.cells[4]);
    const level = toNum(criticalRow.cells[6]);
    notes.push(`[${at}] критическая строка: доступно ${available}, уровень ${level}`);
    if (!(available < level)) {
      errors.push(
        `[${at}] строка помечена критической, но доступно ${available} не ниже уровня ${level}`,
      );
    }
  }

  await page.screenshot({ path: `${OUT}/warehouse-needs-${tag}-${theme}.png`, fullPage: true });
  overflow.push({ key: `${at}/needs`, isDefault: true, ...(await measure(page)) });
  reportCut(await tableCut(page), at, 'потребность в закупке');

  // --- фильтр состояния ---------------------------------------------------
  await panel.getByRole('button', { name: 'Критические' }).first().click();
  await page.waitForTimeout(1400);
  const onlyCritical = await rowCount(page);
  const emptyCritical = await page.locator('text=Позиций ниже критического уровня нет').count();
  notes.push(`[${at}] фильтр критических: ${onlyCritical} из ${total} (пусто: ${emptyCritical})`);
  if (onlyCritical > total) {
    errors.push(`[${at}] критических ${onlyCritical} больше, чем всех ${total}`);
  }
  if (onlyCritical === total && total > 0 && emptyCritical === 0) {
    errors.push(`[${at}] фильтр критических ничего не отфильтровал: ${onlyCritical} из ${total}`);
  }
  // Счётчик и фильтр считают одно и то же: разойдись они, человек не поймёт,
  // какому числу верить.
  if (critical >= 0 && onlyCritical !== critical) {
    errors.push(
      `[${at}] отфильтровано ${onlyCritical} строк, а счётчик критических говорит ${critical}`,
    );
  }

  await panel.getByRole('button', { name: 'Все' }).first().click();
  await page.waitForTimeout(1400);

  // --- «с теми, что в норме» ---------------------------------------------
  // Показ шире, а тревога та же: счётчики от кнопки меняться не должны.
  await panel.getByRole('button', { name: 'С теми, что в норме' }).first().click();
  await page.waitForTimeout(1600);
  const wide = await rowCount(page);
  const wideText = await panel.innerText();
  const wideCritical = Number(wideText.match(/критических:\s*(\d+)/)?.[1] ?? -1);
  notes.push(`[${at}] с нормой: ${wide} строк, счётчик критических ${wideCritical}`);
  if (wide <= total) {
    errors.push(`[${at}] «с теми, что в норме» не расширило выборку: ${wide} против ${total}`);
  }
  if (wideCritical !== critical) {
    errors.push(
      `[${at}] счётчик тревоги поехал от показа нормы: было ${critical}, стало ${wideCritical}`,
    );
  }
  if (!/В норме/.test(wideText)) {
    errors.push(`[${at}] среди показанных строк нет ни одной «В норме»`);
  }
  await panel.getByRole('button', { name: 'С теми, что в норме' }).first().click();
  await page.waitForTimeout(1200);

  // Возвращаем экран на остатки: дальше идёт круг записи, и он ищет строку
  // партии в таблице остатков.
  await page.getByRole('tab', { name: 'Остатки по партиям' }).first().click();
  await page.waitForTimeout(1200);
}

/**
 * Отчёты склада и выгрузка (ТЗ 5.1).
 *
 * Проверяется то, ради чего отчёт открывают:
 *   - пять отчётов из ТЗ на месте и каждый строится;
 *   - смена вида меняет и шапку, и строки, а не только цвет кнопки;
 *   - период спрашивается там, где он имеет смысл, и не спрашивается там,
 *     где его нет: у остатка «за март» — вопрос без ответа;
 *   - кнопка выгрузки действительно отдаёт файл, и это `.xlsx`, а не страница
 *     с ошибкой.
 *
 * Ширину таблицы отчёта прогон не стережёт, в отличие от остальных: колонок у
 * расхождений инвентаризации семнадцать, и сузить их нельзя — отчёт на то и
 * отчёт. Он прокручивается вбок сознательно, поэтому `reportCut` здесь не
 * зовётся. Общий замер переполнения остаётся: за край страницы не должно
 * вылезать ничего.
 */
async function reportHead(page) {
  return page
    .locator('[role="tabpanel"]')
    .first()
    .evaluate((panel) => {
      const table = panel.querySelector('table');
      if (!table) return { head: [], rows: 0 };
      return {
        head: [...table.querySelectorAll('thead th')].map((th) => th.innerText.trim()),
        rows: table.querySelectorAll('tbody tr').length,
      };
    });
}

/**
 * Вложения к операции (ТЗ 5.4, 5.6, 6.3).
 *
 * Круг целиком, а не «панель открылась»: у движения из журнала открываем
 * скрепку, видим вложение из сида, прикладываем свой файл, убеждаемся, что он
 * появился в списке, скачиваем его и удаляем. Файл кладём настоящий png:
 * сервер проверяет тип по Content-Type, а браузер подставляет его по файлу.
 */
/**
 * Справочники на запись (ТЗ 5.2, 5.3, 5.7, 5.10).
 *
 * Круг: завести позицию с характеристиками и коэффициентом, увидеть её в
 * списке, убедиться, что она доехала до подбора формы операции, и убрать за
 * собой. Плюс снимки всех четырёх разделов — их вёрстку тоже надо видеть.
 */
async function runRefsTab(page, at, tag, theme, withWrite = false) {
  const tab = page.getByRole('tab', { name: 'Справочники' });
  if ((await tab.count()) === 0) {
    errors.push(`[${at}] на экране склада нет вкладки «Справочники»`);
    return;
  }
  await tab.first().click();
  await page.waitForTimeout(1800);

  const panel = page.locator('[role="tabpanel"][aria-label="Справочники"]');
  if ((await panel.count()) === 0) {
    errors.push(`[${at}] вкладка «Справочники» открылась пустой`);
    return;
  }

  const itemRows = await panel.locator('table tbody tr').count();
  const cards = await panel.locator('ul > li').count();
  notes.push(`[${at}] номенклатура: строк ${itemRows}, карточек ${cards}`);
  if (itemRows === 0 && cards === 0) errors.push(`[${at}] справочник номенклатуры пуст`);

  await page.screenshot({ path: `${OUT}/warehouse-refs-items-${tag}-${theme}.png`, fullPage: true });
  overflow.push({ key: `${at}/refs-items`, isDefault: true, ...(await measure(page)) });

  for (const [name, key] of [
    ['Места хранения', 'places'],
    ['Причины списания', 'reasons'],
    ['Уровни запаса', 'levels'],
    ['Учёт', 'settings'],
  ]) {
    await panel.getByRole('tab', { name, exact: true }).first().click();
    await page.waitForTimeout(1500);
    const text = (await panel.innerText()).replace(/\s+/g, ' ').slice(0, 90);
    notes.push(`[${at}] раздел «${name}»: ${text}`);
    await page.screenshot({ path: `${OUT}/warehouse-refs-${key}-${tag}-${theme}.png`, fullPage: true });
    overflow.push({ key: `${at}/refs-${key}`, isDefault: true, ...(await measure(page)) });
  }

  // Метод списания (ТЗ 5.7) виден каждому, кто смотрит склад, но кладовщику
  // он только показан: менять его — право `settings.edit`, которого у него нет.
  await panel.getByRole('tab', { name: 'Учёт', exact: true }).first().click();
  await page.waitForTimeout(1200);
  const chosen = await panel.getByText('выбран', { exact: false }).count();
  if (chosen === 0) errors.push(`[${at}] в разделе «Учёт» не отмечен метод списания`);
  const canSwitch = await panel.getByRole('button', { name: /Средневзвешенная|FIFO/ }).count();
  const enabled = await panel
    .getByRole('button', { name: /Средневзвешенная|FIFO/ })
    .filter({ hasNot: page.locator('[disabled]') })
    .count();
  notes.push(`[${at}] метод списания: кнопок ${canSwitch}, доступных кладовщику ${enabled}`);

  // Порог подтверждения платёжки (требование заказчика 07.10). Три поля стоят
  // в том же разделе «Учёт»: это правило компании, а не чья-то настройка. У
  // кладовщика они только показаны - права `settings.edit` у него нет, и
  // кнопка сохранения обязана быть недоступной.
  const limitFields = [
    'Порог одной платёжки',
    'Предел на получателя за окно',
    'Окно, дней',
  ];
  for (const name of limitFields) {
    const field = panel.getByLabel(name, { exact: false });
    if ((await field.count()) === 0) {
      errors.push(`[${at}] в разделе «Учёт» нет поля «${name}»`);
      continue;
    }
    if (await field.first().isEnabled()) {
      errors.push(`[${at}] поле «${name}» доступно кладовщику, а права settings.edit у него нет`);
    }
  }
  const saveLimits = panel.getByRole('button', { name: 'Сохранить', exact: true });
  const saveCount = await saveLimits.count();
  notes.push(`[${at}] порог платёжки: полей ${limitFields.length}, кнопок «Сохранить» ${saveCount}`);
  if (saveCount === 0) {
    errors.push(`[${at}] в разделе «Учёт» нет кнопки сохранения порога`);
  } else if (await saveLimits.first().isEnabled()) {
    errors.push(`[${at}] кладовщик может сохранить порог платёжки`);
  }

  await panel.getByRole('tab', { name: 'Номенклатура', exact: true }).first().click();
  await page.waitForTimeout(1200);

  // Кладовщик справочник читает, но не правит: право `refs.edit` ему не дано.
  // Кнопки правки на его экране быть не должно — это проверка, а не оформление.
  const mayEdit = await panel.getByRole('button', { name: 'Добавить' }).count();
  notes.push(`[${at}] кнопка «Добавить» под кладовщиком: ${mayEdit}`);
  if (mayEdit > 0) {
    errors.push(`[${at}] кладовщику показывают правку справочника, а права refs.edit у него нет`);
  }

  if (!withWrite) {
    await page.getByRole('tab', { name: 'Остатки по партиям' }).first().click();
    await page.waitForTimeout(1000);
    return;
  }

  // Круг записи идёт под администратором: у кладовщика права на правку нет,
  // и проверять её на нём значило бы проверять отказ, а не работу.
  await runRefsWriteCircle(page.context().browser(), at, tag, theme);

  // Экран возвращаем на остатки: следующий круг ищет там строку партии.
  await page.getByRole('tab', { name: 'Остатки по партиям' }).first().click();
  await page.waitForTimeout(1200);
}

async function runRefsWriteCircle(browser, at, tag, theme) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`[${at}] refs PAGEERROR ${e.message.slice(0, 200)}`));

  try {
    await page.goto('http://127.0.0.1:4323/', { waitUntil: 'networkidle' });
    await page.locator('input[autocomplete="username"]').first().fill('admin');
    await page.locator('input[autocomplete="current-password"]').first().fill(PASSWORD);
    await page.getByRole('button', { name: 'Войти' }).click();
    await page.waitForSelector('text=/Выручка|Tushum/', { state: 'attached', timeout: 15000 });
    await page.getByRole('button', { name: 'Склад', exact: true }).first().click();
    await page.waitForTimeout(1500);
    await page.getByRole('tab', { name: 'Справочники' }).first().click();
    await page.waitForTimeout(1800);
  } catch (e) {
    errors.push(`[${at}] не дошли до справочников под админом: ${String(e).slice(0, 160)}`);
    await ctx.close();
    return;
  }

  const panel = page.locator('[role="tabpanel"][aria-label="Справочники"]');
  const code = `QA-UI-${Date.now().toString().slice(-6)}`;

  try {
    await panel.getByRole('button', { name: 'Добавить' }).first().click();
  const form = page.locator('[role="dialog"][aria-label="Новая позиция"]');
  try {
    await form.waitFor({ state: 'visible', timeout: 5000 });
  } catch {
    errors.push(`[${at}] форма новой позиции не открылась`);
    return;
  }

  await form.getByLabel('Код', { exact: true }).fill(code);
  await form.getByLabel('Наименование', { exact: true }).fill(`Труба QA ${code}`);
  await form.getByLabel('Марка стали').fill('Ст3сп');
  await form.getByLabel('Диаметр, мм').fill('57');
  await form.getByLabel('Толщина стенки, мм').fill('3.5');
  await form.getByLabel('Минимальный уровень').fill('10');
  await form.getByLabel('Критический уровень').fill('4');

  await form.getByRole('button', { name: 'Коэффициент' }).click();
  await page.waitForTimeout(300);
  await form.getByLabel('Единица').last().selectOption('m');
  await form.getByLabel('Коэффициент', { exact: true }).last().fill('0.0285');

  await page.screenshot({ path: `${OUT}/warehouse-refs-form-${tag}-${theme}.png`, fullPage: true });
  overflow.push({ key: `${at}/refs-form`, isDefault: false, ...(await measure(page)) });

  await form.getByRole('button', { name: 'Сохранить' }).click();
  await page.waitForTimeout(2500);

  if ((await form.count()) > 0) {
    const why = (await form.innerText()).replace(/\s+/g, ' ').slice(0, 200);
    errors.push(`[${at}] позиция не сохранилась, форма осталась открытой: ${why}`);
    return;
  }

  await panel.getByLabel('Поиск по справочнику').fill(code);
  await page.waitForTimeout(2000);
  const found = await panel.getByText(code, { exact: false }).count();
  notes.push(`[${at}] заведённая позиция ${code}: найдено строк ${found}`);
  if (found === 0) {
    errors.push(`[${at}] заведённая позиция не появилась в справочнике`);
    return;
  }

  // Та же позиция должна доехать до подбора формы операции: справочник,
  // который видно только в справочнике, складу бесполезен.
  await page.getByRole('tab', { name: 'Остатки по партиям' }).first().click();
  await page.waitForTimeout(1500);
  if (await openMenu(page, at, 'Номенклатура')) {
    const options = await page.locator('[role="listbox"]').last().innerText();
    if (!options.includes(code)) {
      errors.push(`[${at}] заведённая позиция не появилась в подборе формы операции`);
    } else {
      notes.push(`[${at}] позиция ${code} есть в подборе формы операции`);
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }

  // Убираем за собой: прогон не должен оставлять мусор в справочнике.
  await page.getByRole('tab', { name: 'Справочники' }).first().click();
  await page.waitForTimeout(1500);
  await panel.getByLabel('Поиск по справочнику').fill(code);
  await page.waitForTimeout(2000);
  const del = panel.getByRole('button', { name: 'Удалить позицию' });
  if ((await del.count()) === 0) {
    errors.push(`[${at}] у заведённой позиции нет кнопки удаления`);
  } else {
    await del.first().click();
    await page.waitForTimeout(2000);
    const left = await panel.getByText(code, { exact: false }).count();
    if (left > 0) errors.push(`[${at}] позиция ${code} осталась после удаления`);
  }

  } catch (e) {
    errors.push(`[${at}] круг справочника оборвался: ${String(e).slice(0, 200)}`);
  } finally {
    await ctx.close();
  }
}

async function runAttachments(page, at, tag, theme, withWrite = false) {
  const tab = page.getByRole('tab', { name: 'Журнал движений' });
  if ((await tab.count()) === 0) {
    errors.push(`[${at}] нет вкладки «Журнал движений»: вложения не проверить`);
    return;
  }
  await tab.first().click();
  await page.waitForTimeout(1500);

  const clips = page.getByRole('button', { name: 'Вложения' });
  const count = await clips.count();
  notes.push(`[${at}] скрепок в журнале: ${count}`);
  if (count === 0) {
    errors.push(`[${at}] в журнале движений нет кнопки «Вложения»`);
    return;
  }

  await clips.first().click();
  const dialog = page.locator('[role="dialog"][aria-label="Вложения"]');
  try {
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
  } catch {
    errors.push(`[${at}] окно вложений не открылось`);
    return;
  }
  await page.waitForTimeout(1200);

  const text = (await dialog.innerText()).replace(/\s+/g, ' ');
  notes.push(`[${at}] окно вложений: ${text.slice(0, 120)}`);

  // Тип вложения рисуем мы, а не браузер: системный `select` в тёмной теме
  // приходил белым списком чужого вида. Признак нашего — кнопка со списком
  // `role="listbox"`, а не элемент `select`.
  if (await dialog.locator('select').count()) {
    errors.push(`[${at}] тип вложения — системный select, а не наш список`);
  }
  const kindBtn = dialog.getByRole('button', { name: 'Тип вложения' });
  if (!(await kindBtn.count())) {
    errors.push(`[${at}] списка «Тип вложения» на месте нет`);
  } else {
    await kindBtn.click();
    await page.waitForTimeout(500);
    const opts = (await page.getByRole('option').allInnerTexts()).join(' | ');
    for (const kind of ['Фото', 'Скан', 'Сертификат', 'Файл']) {
      if (!opts.includes(kind)) errors.push(`[${at}] в списке типов нет «${kind}»: ${opts}`);
    }
    // Чем эти типы различаются, должно быть написано: иначе «Скан» и «Файл»
    // выбирают наугад.
    if (!/сертификат качества|со сканера/i.test(opts)) {
      errors.push(`[${at}] список типов не объясняет, чем они различаются: ${opts}`);
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
  }
  await page.screenshot({ path: `${OUT}/warehouse-attachments-${tag}-${theme}.png`, fullPage: true });
  overflow.push({ key: `${at}/attachments`, isDefault: false, ...(await measure(page)) });

  if (!withWrite) {
    await dialog.getByRole('button', { name: 'Закрыть вложения' }).click();
    await page.waitForTimeout(400);
    await page.getByRole('tab', { name: 'Остатки по партиям' }).first().click();
    await page.waitForTimeout(1000);
    return;
  }

  // --- свой файл ----------------------------------------------------------
  const before = await dialog.locator('li').count();
  const file = path.join(os.tmpdir(), `qa-vlozhenie-${Date.now()}.png`);
  fs.writeFileSync(file, PNG_1PX);
  await dialog.locator('input[type="file"]').setInputFiles(file);
  await page.waitForTimeout(2500);

  const after = await dialog.locator('li').count();
  notes.push(`[${at}] вложений было ${before}, стало ${after}`);
  if (after !== before + 1) {
    const why = (await dialog.innerText()).replace(/\s+/g, ' ').slice(0, 200);
    errors.push(`[${at}] файл не приложился: строк было ${before}, стало ${after}. Окно: ${why}`);
    fs.rmSync(file, { force: true });
    await dialog.getByRole('button', { name: 'Закрыть вложения' }).click();
    return;
  }

  const mine = dialog.locator('li').filter({ hasText: path.basename(file) }).first();
  if ((await mine.count()) === 0) {
    errors.push(`[${at}] приложенный файл не назван своим именем в списке`);
  }

  // Скачивание: на выдаче стоит право, и запрос идёт с токеном — если бы файл
  // открывался ссылкой, сюда приехал бы 401, а не файл.
  const wait = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
  await mine.getByRole('button', { name: 'Скачать' }).click();
  const got = await wait;
  if (!got) {
    errors.push(`[${at}] вложение не скачалось`);
  } else {
    const name = got.suggestedFilename();
    notes.push(`[${at}] скачано вложение: ${name}`);
    if (name !== path.basename(file)) {
      errors.push(`[${at}] вложение сохранилось как «${name}», а приложен был ${path.basename(file)}`);
    }
    await got.delete().catch(() => {});
  }

  await mine.getByRole('button', { name: 'Удалить вложение' }).click();
  await page.waitForTimeout(2000);
  const left = await dialog.locator('li').count();
  if (left !== before) {
    errors.push(`[${at}] после удаления строк ${left}, а было до загрузки ${before}`);
  }

  fs.rmSync(file, { force: true });
  await dialog.getByRole('button', { name: 'Закрыть вложения' }).click();
  await page.waitForTimeout(400);

  // Экран возвращаем на остатки: следующий круг ищет строку партии в таблице,
  // а мы стоим на журнале движений.
  await page.getByRole('tab', { name: 'Остатки по партиям' }).first().click();
  await page.waitForTimeout(1200);
}

async function runReportsTab(page, at, tag, theme, withDownload = false) {
  const tab = page.getByRole('tab', { name: 'Отчёты' });
  if ((await tab.count()) === 0) {
    errors.push(`[${at}] на экране склада нет вкладки «Отчёты»`);
    return;
  }
  await tab.first().click();
  await page.waitForTimeout(2000);

  const panel = page.locator('[role="tabpanel"]').first();
  if ((await panel.count()) === 0) {
    errors.push(`[${at}] вкладка «Отчёты» открылась пустой`);
    return;
  }

  // Пять отчётов из ТЗ 5.1. Меньше — значит какой-то не доехал до экрана.
  const kinds = [
    'Остатки',
    'Движение',
    'Доступное и зарезервированное',
    'Оборачиваемость',
    'Расхождения инвентаризации',
  ];
  for (const kind of kinds) {
    if ((await panel.getByRole('button', { name: kind, exact: true }).count()) === 0) {
      errors.push(`[${at}] среди отчётов нет «${kind}»`);
    }
  }

  const stock = await reportHead(page);
  notes.push(
    `[${at}] отчёт «Остатки»: колонок ${stock.head.length}, строк ${stock.rows}` +
      ` (${stock.head.slice(0, 4).join(', ')})`,
  );
  if (stock.rows === 0) errors.push(`[${at}] отчёт «Остатки» пуст`);
  if (stock.head[0] !== 'Склад') {
    errors.push(`[${at}] первая колонка остатков — «${stock.head[0]}», а не «Склад»`);
  }

  // У остатков периода нет: они про «сейчас».
  if ((await panel.getByRole('button', { name: 'Дата с' }).count()) > 0) {
    errors.push(`[${at}] у отчёта остатков спрашивают период`);
  }

  await page.screenshot({ path: `${OUT}/warehouse-reports-${tag}-${theme}.png`, fullPage: true });
  overflow.push({ key: `${at}/reports`, isDefault: true, ...(await measure(page)) });

  // --- смена вида отчёта --------------------------------------------------
  await panel.getByRole('button', { name: 'Оборачиваемость', exact: true }).first().click();
  await page.waitForTimeout(2000);
  const turnover = await reportHead(page);
  notes.push(
    `[${at}] отчёт «Оборачиваемость»: колонок ${turnover.head.length}, строк ${turnover.rows}`,
  );
  if (turnover.rows === 0) errors.push(`[${at}] отчёт «Оборачиваемость» пуст`);
  if (turnover.head.join('|') === stock.head.join('|')) {
    errors.push(`[${at}] шапка отчёта не изменилась при смене вида`);
  }
  if (!turnover.head.includes('Оборотов за период')) {
    errors.push(`[${at}] в оборачиваемости нет колонки «Оборотов за период»: ${turnover.head.join(', ')}`);
  }
  // А вот здесь период нужен, и он обязан появиться.
  if ((await panel.getByRole('button', { name: 'Дата с' }).count()) === 0) {
    errors.push(`[${at}] у отчёта оборачиваемости не спрашивают период`);
  }

  await page.screenshot({
    path: `${OUT}/warehouse-reports-turnover-${tag}-${theme}.png`,
    fullPage: true,
  });
  overflow.push({ key: `${at}/reports-turnover`, isDefault: true, ...(await measure(page)) });

  // --- выгрузка -----------------------------------------------------------
  // Один раз за прогон: файл каждый раз один и тот же, а скачивание — самая
  // медленная проверка на этой вкладке.
  if (withDownload) {
    for (const [button, ext] of [
      ['Excel', 'xlsx'],
      ['CSV', 'csv'],
    ]) {
      const wait = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
      await panel.getByRole('button', { name: button, exact: true }).first().click();
      const file = await wait;
      if (!file) {
        errors.push(`[${at}] кнопка «${button}» не отдала файл`);
        continue;
      }
      const name = file.suggestedFilename();
      notes.push(`[${at}] выгрузка «${button}»: ${name}`);
      if (!name.endsWith(`.${ext}`)) {
        errors.push(`[${at}] «${button}» отдал ${name}, а ждали файл .${ext}`);
      }
      // Имя файла берётся из Content-Disposition, а его браузер отдаёт странице
      // только если заголовок назван в exposedHeaders. Не назван — файл
      // сохраняется как «report», и папка «Загрузки» становится бесполезной.
      if (!name.startsWith('sklad-')) {
        errors.push(`[${at}] выгрузка сохранилась как «${name}»: имя из заголовка не доехало`);
      }
      // Пустой файл — это отказ, доехавший под видом выгрузки.
      const path = await file.path();
      const size = path ? (await import('node:fs')).statSync(path).size : 0;
      if (size < 200) errors.push(`[${at}] выгруженный ${name} подозрительно мал: ${size} байт`);
      await file.delete().catch(() => {});
    }
  }

  // Возвращаем экран на остатки: дальше прогон ищет строку партии в таблице.
  await page.getByRole('tab', { name: 'Остатки по партиям' }).first().click();
  await page.waitForTimeout(1200);
}

try {
  await assertPortFree();
  backend = spawn('node', ['dist/main.js'], {
    cwd: BACKEND,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(API_PORT),
      CORS_ORIGINS: 'http://localhost:5173,http://127.0.0.1:4323',
    },
  });
  backend.stdout.on('data', (d) => process.stdout.write(`[api] ${d}`));
  backend.stderr.on('data', (d) => process.stderr.write(`[api!] ${d}`));

  const status = await waitForApi(20000);
  console.log(`бэкенд отвечает, /warehouse/summary без токена → ${status}`);

  const app = express();
  app.use(express.static(ROOT));
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(ROOT, 'index.html')));
  server = await new Promise((resolve) => {
    const s = app.listen(4323, '127.0.0.1', () => resolve(s));
  });

  browser = await chromium.launch({
    executablePath: '/home/an/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
    args: ['--no-sandbox'],
  });

  // QA_ONLY=360/dark сужает прогон до одного сочетания: разбирать падение на
  // 360 не за что, если ради него каждый раз ждать полный круг по четырём.
  const only = process.env.QA_ONLY ?? '';
  for (const [w, h, tag] of [[1440, 900, '1440'], [360, 780, '360']]) {
    for (const theme of ['light', 'dark']) {
      if (only && only !== `${tag}/${theme}`) continue;
      const at = `${tag}/${theme}`;
      const ctx = await browser.newContext({ viewport: { width: w, height: h } });
      const page = await ctx.newPage();
      // Падение внутри прогона — находка, а не авария скрипта: иначе первая же
      // поломка убивает процесс раньше, чем он скажет, что именно не так.
      try {
        page.on('console', (m) => {
          if (m.type() !== 'error') return;
          if (expectScanMiss && m.text().includes('Failed to load resource')) return;
          errors.push(`[${at}] ${m.text().slice(0, 300)}`);
        });
        page.on('pageerror', (e) => errors.push(`[${at}] PAGEERROR ${e.message.slice(0, 300)}`));
        page.on('response', (r) => {
          // 404 на сканере — обычный ответ, а не поломка: «такого кода нет»
          // сервер говорит именно так, и прогон проверяет этот случай нарочно.
          if (r.url().includes('/warehouse/scan') && r.status() === 404) return;
          if (r.url().includes('/warehouse/') && r.status() >= 400) {
            errors.push(`[${at}] ${r.status()} ${new URL(r.url()).pathname}`);
          }
        });
        await page.addInitScript((t) => localStorage.setItem('metall_theme', t), theme);

        await page.goto('http://127.0.0.1:4323/', { waitUntil: 'networkidle' });
        await page.waitForTimeout(300);

        await page.locator('input[autocomplete="username"]').first().fill(LOGIN);
        await page.locator('input[autocomplete="current-password"]').first().fill(PASSWORD);
        await page.getByRole('button', { name: 'Войти' }).click();
        await page.waitForSelector('text=/Выручка|Tushum/', { state: 'attached', timeout: 15000 });

        await page.getByRole('button', { name: 'Склад', exact: true }).first().click();
        await page.waitForTimeout(1500);

        // Сводка: стоимость запаса без цифры означает, что /summary не дошёл.
        const value = await page
          .locator('text=Стоимость запаса')
          .first()
          .evaluate((el) => el.closest('div[class*="rounded-xl"]')?.textContent ?? '')
          .catch(() => '');
        notes.push(`[${at}] запас: ${value.replace(/\s+/g, ' ').trim().slice(0, 80) || '(не найден)'}`);
        if (!/\d/.test(value)) errors.push(`[${at}] стоимость запаса не отрисовалась`);

        const total = await rowCount(page);
        notes.push(`[${at}] строк остатка: ${total}`);
        if (total === 0) errors.push(`[${at}] таблица остатков пуста`);

        await page.screenshot({ path: `${OUT}/warehouse-stock-${tag}-${theme}.png`, fullPage: true });
        overflow.push({ key: `${at}/stock`, isDefault: true, ...(await measure(page)) });
        reportCut(await tableCut(page), at, 'остатки');

        // --- форма операции ---------------------------------------------------
        // Она стоит в панели постоянно, поэтому попадает в замер по умолчанию
        // выше. Отдельно снимаем раскрытый список: он рисуется поверх страницы
        // (`portal`), и обрезка его краем панели видна только раскрытым.
        // Тип операции — список: переключателем из кнопок семь типов не влезают
        // ни на 360, ни на 1440. Проверяем наличие самого поля.
        if ((await formField(page, 'Тип операции').count()) === 0) {
          errors.push(`[${at}] в форме нет поля «Тип операции»`);
        }

        if (await openMenu(page, at, 'Номенклатура')) {
          await page.screenshot({ path: `${OUT}/warehouse-select-${tag}-${theme}.png` });
          overflow.push({ key: `${at}/select`, isDefault: false, ...(await measure(page)) });
          // Обрезанный список — это когда пунктов на экране меньше, чем в нём
          // есть. Проверяем не картинкой: видимая высота против полной.
          const cut = await page.locator('[role="listbox"]').last().evaluate((el) => ({
            visible: el.clientHeight,
            full: el.scrollHeight,
            top: Math.round(el.getBoundingClientRect().top),
            bottom: Math.round(el.getBoundingClientRect().bottom),
          }));
          notes.push(
            `[${at}] список номенклатуры: видно ${cut.visible} из ${cut.full}px, ` +
              `сверху ${cut.top}, снизу ${cut.bottom}`,
          );
          if (cut.top < 0 || cut.bottom > h) {
            errors.push(`[${at}] раскрытый список вышел за экран: ${cut.top}…${cut.bottom} при ${h}`);
          }
          await page.keyboard.press('Escape');
          await page.waitForTimeout(300);
        }

        // Списание меняет состав полей: у него есть причина и нет цены. Снимок
        // нужен именно этого состояния — на нём видно, что поля переставились.
        await chooseKind(page, at, 'Списание');
        await page.screenshot({ path: `${OUT}/warehouse-writeoff-${tag}-${theme}.png`, fullPage: true });
        overflow.push({ key: `${at}/writeoff`, isDefault: true, ...(await measure(page)) });
        const hasReason = await formField(page, 'Причина').count();
        const hasCost = await formInput(page, 'Цена за единицу').count();
        if (hasReason === 0) errors.push(`[${at}] у списания нет поля «Причина»`);
        if (hasCost > 0) errors.push(`[${at}] у списания спрашивают цену за единицу`);

        // --- состав полей у новых типов -------------------------------------
        // Стороны движения у каждого типа свои: выдача в цех только списывает,
        // возвраты и излишек только приходуют. Проверяем сами поля, а не
        // подпись типа: подпись меняется всегда, а поля — только если таблица
        // сторон на фронте и на сервере сходятся.
        const kindFields = [
          {
            kind: 'Выдача в цех',
            need: ['Склад отправления', 'Ячейка отправления'],
            deny: ['Склад получения', 'Ячейка получения'],
            denyInput: ['Цена за единицу'],
          },
          {
            kind: 'Возврат из цеха',
            need: ['Склад получения', 'Ячейка получения'],
            deny: ['Склад отправления', 'Ячейка отправления'],
            denyInput: [],
          },
          {
            kind: 'Возврат от клиента',
            need: ['Склад получения', 'Клиент'],
            deny: ['Склад отправления'],
            denyInput: [],
            lists: [{ field: 'Клиент' }],
          },
          {
            kind: 'Оприходование излишка',
            need: ['Склад получения', 'Причина'],
            deny: ['Склад отправления'],
            denyInput: [],
            lists: [{ field: 'Причина', expect: /инвентаризац/i }],
          },
        ];
        for (const f of kindFields) {
          if (!(await chooseKind(page, at, f.kind))) continue;
          // Ячейка появляется следом за своим складом: пустой список выбирать
          // нечем. Поэтому склад выбираем первым, а уже потом ищем поля.
          for (const side of ['Склад отправления', 'Склад получения']) {
            if (f.need.includes(side)) {
              await chooseOption(
                page,
                at,
                side,
                (t) => t !== 'выберите' && t.length > 0,
                'любого склада',
              );
            }
          }
          for (const name of f.need) {
            if ((await formField(page, name).count()) === 0) {
              errors.push(`[${at}] «${f.kind}»: в форме нет поля «${name}»`);
            }
          }
          for (const name of f.deny) {
            if ((await formField(page, name).count()) > 0) {
              errors.push(`[${at}] «${f.kind}»: в форме лишнее поле «${name}»`);
            }
          }
          for (const name of f.denyInput) {
            if ((await formInput(page, name).count()) > 0) {
              errors.push(`[${at}] «${f.kind}»: в форме лишнее поле «${name}»`);
            }
          }
          // Список, в котором нечего выбрать, ломается молча: поле есть, форма
          // выглядит рабочей, а записать нельзя. Возврату нужны клиенты,
          // излишку — причина инвентаризации, и оба списка раньше были не те.
          for (const list of f.lists ?? []) {
            const menu = await openMenu(page, at, list.field);
            if (!menu) continue;
            const seen = (await menu.locator('button').allInnerTexts()).map((t) =>
              t.replace(/\s+/g, ' ').trim(),
            );
            const real = seen.filter((t) => t !== 'выберите' && t !== 'не указан' && t.length > 0);
            if (real.length === 0) {
              errors.push(`[${at}] «${f.kind}»: список «${list.field}» пуст`);
            } else if (list.expect && !real.some((t) => list.expect.test(t))) {
              errors.push(
                `[${at}] «${f.kind}»: в списке «${list.field}» нет подходящего пункта; ` +
                  `есть: ${real.slice(0, 4).join(' | ')}`,
              );
            } else {
              notes.push(`[${at}] «${f.kind}»: «${list.field}» — ${real.length} пунктов`);
            }
            await page.keyboard.press('Escape');
            await page.waitForTimeout(250);
          }
          overflow.push({
            key: `${at}/${f.kind}`,
            isDefault: true,
            ...(await measure(page)),
          });
        }
        await page.screenshot({ path: `${OUT}/warehouse-surplus-${tag}-${theme}.png`, fullPage: true });
        notes.push(`[${at}] состав полей проверен у ${kindFields.length} новых типов операций`);

        // Отгрузки и выпуска цеха в форме быть не должно: отгрузка списывает по
        // продаже, выпуск заводит цех. Тип, заведённый руками, разошёлся бы с
        // документом, и отменить такое движение уже нельзя.
        const kindList = await openMenu(page, at, 'Тип операции');
        if (kindList) {
          const kinds = (await kindList.locator('button').allInnerTexts()).map((t) => t.trim());
          for (const forbidden of ['Отгрузка', 'Выпуск из цеха']) {
            if (kinds.includes(forbidden)) {
              errors.push(`[${at}] в списке типов есть «${forbidden}» — он делается документом`);
            }
          }
          if (kinds.length !== 7) {
            errors.push(`[${at}] типов операций ${kinds.length}, а не 7: ${kinds.join(' | ')}`);
          }
          await page.keyboard.press('Escape');
          await page.waitForTimeout(300);
        }

        await chooseKind(page, at, 'Приход');

        // --- путь партии ---------------------------------------------------
        // Кнопка называется по-разному в таблице и в карточке: на 1440 «Путь»,
        // на 360 «Путь партии». Берём первую подходящую.
        await page.getByRole('button', { name: /^Путь( партии)?$/ }).first().click();
        await page.waitForTimeout(1200);

        const trace = await page
          .locator('text=Происхождение')
          .first()
          .evaluate((el) => el.closest('div[class*="rounded-xl"]')?.innerText ?? '')
          .catch(() => '');
        const moveRows = await page.locator('li:has-text("Приход"), li:has-text("Выпуск из цеха"), li:has-text("Отгрузка"), li:has-text("Выдача в цех")').count();
        notes.push(`[${at}] путь партии: движений ${moveRows}`);
        if (!trace) {
          errors.push(`[${at}] панель пути партии не открылась`);
        } else {
          // Происхождение: либо поставщик, либо заказ цеха. «не указано»
          // означает, что партия пришла ниоткуда — сертификат привязать не к чему.
          if (trace.includes('не указано')) {
            errors.push(`[${at}] у партии потеряно происхождение`);
          }
          if (moveRows === 0) errors.push(`[${at}] в пути партии нет ни одного движения`);
        }

        // Цепочка в обе стороны (ТЗ 5.6): оба конца обязаны быть на экране,
        // даже когда один из них пуст — «пока никуда» это ответ, а отсутствие
        // раздела означает, что вопрос не задан.
        for (const head of ['Откуда пришло', 'Куда ушло']) {
          if ((await page.getByText(head, { exact: true }).count()) === 0) {
            errors.push(`[${at}] в пути партии нет раздела «${head}»`);
          }
        }

        if (tag === '1440' && theme === 'light') {
          await runChainJump(page, at);
        }
        // Страница скроллится внутри себя, и `fullPage` снимает только экран:
        // без этой прокрутки на 360 в кадр попадал список остатков, а не то,
        // что проверено выше. Смотреть надо на цепочку.
        await page.getByText('Откуда пришло', { exact: true }).first().scrollIntoViewIfNeeded();
        await page.waitForTimeout(400);
        await page.screenshot({ path: `${OUT}/warehouse-trace-${tag}-${theme}.png`, fullPage: true });
        overflow.push({ key: `${at}/trace`, isDefault: true, ...(await measure(page)) });

        // Закрываем панель: дальше проверяются фильтры, и лишний блок сверху
        // только мешает читать скриншот.
        await page.getByRole('button', { name: 'Закрыть' }).first().click();
        await page.waitForTimeout(400);

        // --- фильтр «только критические» -------------------------------------
        // Кнопка должна менять выборку, а не только свой цвет.
        await page.getByRole('button', { name: 'Только критические' }).first().click();
        await page.waitForTimeout(1200);
        const critical = await rowCount(page);
        const emptyCritical = await page
          .locator('text=Позиций ниже критического уровня нет')
          .count();
        notes.push(`[${at}] по фильтру критических: ${critical} (пустой экран: ${emptyCritical})`);
        if (critical > total) {
          errors.push(`[${at}] критических строк ${critical} больше, чем всех ${total}`);
        }
        if (critical === total && total > 0 && emptyCritical === 0) {
          errors.push(`[${at}] фильтр критических ничего не отфильтровал: ${critical} из ${total}`);
        }
        await page.screenshot({ path: `${OUT}/warehouse-critical-${tag}-${theme}.png`, fullPage: true });
        overflow.push({ key: `${at}/critical`, isDefault: true, ...(await measure(page)) });

        await page.getByRole('button', { name: 'Только критические' }).first().click();
        await page.waitForTimeout(1000);

        // --- поиск ------------------------------------------------------------
        // Запрос берём с экрана, а не вписываем в прогон: какая компания
        // открыта по умолчанию, такая номенклатура и лежит на складе. Жёстко
        // вписанный артикул завода у кладовщика торгового дома не найдётся,
        // и прогон ругался бы на исправный поиск.
        const code = await page.evaluate(() => {
          const re = /^[A-Z][A-Z0-9]*([-.][A-Z0-9.]+)+$/;
          for (const el of document.querySelectorAll('[class*="font-mono"]')) {
            const t = (el.textContent ?? '').trim();
            if (re.test(t)) return t;
          }
          return null;
        });
        if (!code) throw new Error('на экране не нашлось ни одного артикула');

        await page.getByRole('searchbox', { name: 'Поиск' }).first().fill(code);
        await page.waitForTimeout(1500);
        const searched = await rowCount(page);
        notes.push(`[${at}] поиск «${code}»: ${searched} из ${total}`);
        if (searched === 0) errors.push(`[${at}] поиск по «${code}» не нашёл ничего`);
        if (searched === total && total > 0) {
          errors.push(`[${at}] поиск не сузил выборку: ${searched} из ${total}`);
        }
        await page.getByRole('searchbox', { name: 'Поиск' }).first().fill('');
        await page.waitForTimeout(1200);

        // --- штрихкоды, QR и сканер (ТЗ 5.9) -----------------------------------
        // Во всех четырёх состояниях: лист этикеток меряется в миллиметрах,
        // и схлопнуться он может ровно в одном из них.
        await runScanLabels(page, at, tag, theme);

        // --- штучный учёт ------------------------------------------------------
        // Во всех четырёх состояниях: панель номера на 360 — тот же блок, что
        // и на 1440, и выехать за контейнер он может только в одном из них.
        await runSerialTrace(page, at, tag, theme);

        // --- журнал движений ---------------------------------------------------
        // Во всех четырёх состояниях: на 1440 журнал — таблица на девять
        // колонок, на 360 — карточки, и вылезти за контейнер он может только
        // в одном из них.
        // Запись и отмену из журнала — один раз за прогон: каждая оставляет в
        // журнале пару движений, а журнал только пополняется.
        await runMovesTab(page, at, h, tag === '1440' && theme === 'light');

        // Резервы — во всех четырёх состояниях, круг «поставить — снять» один
        // раз за прогон: каждый круг трогает остаток живой базы.
        await runReservationsTab(page, at, tag === '1440' && theme === 'light');

        // Инвентаризация — во всех четырёх состояниях. Запись факта только на
        // широком светлом: строку листа выбираем по таблице, а она `hidden lg:block`.
        await runInventoryTab(page, at, tag === '1440' && theme === 'light');

        // Потребность в закупке — во всех четырёх состояниях: на 1440 это
        // таблица на восемь колонок, на 360 — карточки, и разъехаться может
        // только одна из них. Круг записи ей не нужен: отчёт только читает.
        await runNeedsTab(page, at, tag, theme);

        // Отчёты и выгрузка — во всех четырёх состояниях; сама выгрузка один
        // раз за прогон: файл каждый раз один и тот же.
        await runReportsTab(page, at, tag, theme, tag === '1440' && theme === 'light');

        await runAttachments(page, at, tag, theme, tag === '1440' && theme === 'light');

        await runRefsTab(page, at, tag, theme, tag === '1440' && theme === 'light');

        // --- круг записи ------------------------------------------------------
        // Один раз за прогон: каждый круг оставляет в журнале пару «приход +
        // сторно», а журнал только пополняется. Широкий экран — потому что
        // остаток сверяется по таблице, а она `hidden lg:block`.
        if (tag === '1440' && theme === 'light') await runWriteCircle(page, at);
        // Списки на узком экране проверяем там, где они и ломались.
        if (tag === '360' && theme === 'light') await runNarrowSelect(page, at);
        // Поиск в номенклатуре — во всех четырёх состояниях: на 360 панель
        // стоит в тех же восьми пикселях от края, что и сам список, а в тёмной
        // теме у поля поиска своя рамка и свой фон.
        await runItemSearch(page, at);

        const body = await page.locator('body').innerText();
        for (const phrase of FICTION) {
          if (body.includes(phrase)) found.push(`[${at}] «${phrase}»`);
        }

        // Развёрнутый сайдбар — отдельный замер, спрос с него мягче: это уже
        // осознанное действие пользователя, а не состояние по умолчанию.
        const toggle = page.getByRole('button', { name: /боковую панель/i }).first();
        if (await toggle.count()) {
          await toggle.click();
          await page.waitForTimeout(500);
          overflow.push({ key: `${at}/toggled`, isDefault: false, ...(await measure(page)) });
        }
      } catch (e) {
        // Первая строка Playwright говорит только «Timeout». Причина — в журнале
        // вызова ниже: вне экрана, перекрыт, не устоялся. Без неё разбор слепой.
        const why = String(e.message)
          .split('\n')
          .map((x) => x.trim())
          .filter((x) => x && !x.startsWith('- waiting') && !x.startsWith('- locator'))
          .slice(0, 6)
          .join(' | ');
        errors.push(`[${at}] прогон оборвался: ${why}`);
        await page.screenshot({ path: `${OUT}/FAIL-${tag}-${theme}.png`, fullPage: true }).catch(() => {});
      }

      await ctx.close();
    }
  }

  const lines = overflow.map(
    (o) =>
      `${o.key}${o.isDefault ? ' (по умолчанию)' : ''}: doc=${o.doc} main=${o.main}` +
      (o.culprits.length ? `\n    виновники: ${o.culprits.join(' | ')}` : ''),
  );
  fs.writeFileSync(`${OUT}/overflow.txt`, lines.join('\n') + '\n');
  fs.writeFileSync(`${OUT}/console-errors.txt`, (errors.join('\n') || 'нет') + '\n');
  fs.writeFileSync(`${OUT}/fiction.txt`, (found.join('\n') || 'нет') + '\n');
  fs.writeFileSync(`${OUT}/data.txt`, notes.join('\n') + '\n');

  console.log('--- что показано ---');
  console.log(notes.join('\n'));
  console.log('--- переполнение по горизонтали ---');
  console.log(lines.join('\n'));
  console.log('--- выдумки из макета ---');
  console.log(found.join('\n') || 'нет');
  console.log('--- ошибки консоли ---');
  console.log(errors.join('\n') || 'нет');

  const problems = [];
  if (errors.length) problems.push(`ошибок: ${errors.length}`);
  if (found.length) problems.push(`выдуманных подписей на экране: ${found.length}`);
  for (const o of overflow) {
    if (o.doc > 0) problems.push(`документ вылез за вьюпорт — ${o.key}: doc=${o.doc}`);
    if (o.isDefault && o.main > 0) {
      problems.push(
        `содержимое вылезло в состоянии по умолчанию — ${o.key}: main=${o.main}` +
          (o.culprits.length ? ` (${o.culprits[0]})` : ''),
      );
    }
  }
  if (problems.length) {
    console.error('--- ПРОГОН НЕ ПРОЙДЕН ---\n' + problems.join('\n'));
    process.exitCode = 1;
  } else {
    console.log('--- прогон пройден ---');
  }
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.close();
  if (backend) backend.kill('SIGTERM');
}
