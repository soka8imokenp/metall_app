/**
 * Прогон страницы «Продажи» против живого бэкенда.
 *
 * Проверяет три вещи, которые глазами по скриншоту не проверишь:
 *   1) на экране нет придуманных чисел и подписей из импортированного макета;
 *   2) данные действительно пришли — строки в списке и заполненная панель;
 *   3) содержимое не вылезает за контейнер на 360 и 1440 в обеих темах.
 *
 * Всё в одном переднем процессе: фоновые запуски запрещены, бэкенд поднимается
 * дочерним процессом и глушится в finally.
 *
 * Перед запуском собрать фронт с живым API:
 *   cd dev/frontend && bun run build:qa   # сборка для прогона, каталог dist-qa
 *
 * Запуск:
 *   cd dev/qa && bun run sales-live
 */
import { spawn } from 'node:child_process';
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { chromium } from 'playwright-core';

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
const LOGIN = 's.radjabov';
const PASSWORD = process.env.SEED_PASSWORD ?? 'metall-dev-2026';

/** Кладовщик: у него есть `sales.view` и нет `sales.edit` — на нём проверяются права. */
const KEEPER_LOGIN = 'a.saidov';
/** Менеджер завода: штучные позиции продаёт он. */
const PLANT_LOGIN = 'b.ergashev';

/**
 * Выдумки из импортированного макета. Любая из них на экране — провал прогона:
 * это числа и подписи, за которыми нет ни одной строки в базе.
 *
 * «Выписать ТТН» из списка убрано: в макете это была кнопка-обманка, а теперь
 * она записывает настоящую накладную — её проверяет круг записи ниже.
 */
const FICTION = [
  'Норма пропускной способности',
  '384.2',
  '72% закрыто',
  '43.2 млрд',
  '33.8 млрд',
  'Просрочка ДЗ: 0%',
  'Лимит в норме',
  'Синхронизация с 1С',
  'Паспорт ОТК',
  'ДОГ-2026',
  'ТТН-0842',
  'Enter Engineering Pte',
];

const TABS = [
  { key: 'orders', label: 'Заказы' },
  { key: 'shipments', label: 'Журнал ТТН' },
  { key: 'partners', label: 'Покупатели и лимиты' },
  { key: 'prices', label: 'Цены' },
];

fs.mkdirSync(OUT, { recursive: true });

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
      const r = await fetch(`${API}/sales/summary?period=7d`);
      if (r.status > 0) return r.status;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error('бэкенд не поднялся за отведённое время');
}

/**
 * Полоска разделов: её размер и собственная прокрутка.
 *
 * Оба дефекта, на которые указал Отабек 25.09, видны отсюда. Счётчик записей
 * в подписи вкладки появляется только после того, как её данные загрузятся,
 * — полоска меняет размер уже после клика. А когда подписи перестают
 * помещаться, у полоски включается собственная горизонтальная прокрутка,
 * и посреди шапки возникает скроллбар.
 */
async function tabsBox(page) {
  return page
    .getByRole('group', { name: /Разделы продаж|Sotuv bo/i })
    .first()
    .evaluate((el) => {
      const r = el.getBoundingClientRect();
      return {
        w: Math.round(r.width),
        h: Math.round(r.height),
        scroll: el.scrollWidth - el.clientWidth,
      };
    });
}

/**
 * Шапка списка целиком внутри карточки.
 *
 * У карточки `overflow-hidden`, поэтому вылезший поиск не двигает `main` и
 * обычным замером переполнения не ловится — его просто срезает по краю.
 * Меряем правый край каждого элемента шапки против правого края карточки.
 */
async function headerFits(page) {
  return page
    .getByRole('group', { name: /Разделы продаж|Sotuv bo/i })
    .first()
    .evaluate((tabs) => {
      const header = tabs.parentElement;
      const card = header?.parentElement;
      if (!header || !card) return [];
      const edge = card.getBoundingClientRect().right;
      const out = [];
      for (const el of header.querySelectorAll('input, button, [role="group"]')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0) continue;
        const over = Math.round(r.right - edge);
        if (over > 0) {
          out.push(`${el.tagName.toLowerCase()}${el.getAttribute('aria-label') ? `[${el.getAttribute('aria-label')}]` : ''} +${over}px`);
        }
      }
      return out;
    });
}

// ---------------------------------------------------------------------------
// Круг записи: заказ → подтверждение → ТТН
// ---------------------------------------------------------------------------

/**
 * Что продавать и откуда — спрашиваем у самого сервера, а не вписываем в прогон.
 *
 * Товар должен быть и продаваемым (`goods`/`finished` — это и есть содержимое
 * `sales/refs`), и лежащим на складе в свободном остатке. Жёстко вписанный
 * артикул пережил бы ровно до следующего пересева базы, а отгрузка без остатка
 * законно отказала бы — и прогон ругался бы на исправный экран.
 *
 * Ячейки пропускаем: остаток по строке с ячейкой лежит отдельно от строки без
 * неё, а отгрузка снимает с той, где ячейки нет.
 */
async function pickTarget() {
  /** Ответы завёрнуты в `{data}` — тем же перехватчиком, что и для браузера. */
  const body = async (res) => {
    const json = await res.json();
    return json?.data ?? json;
  };

  const auth = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: LOGIN, password: PASSWORD }),
  }).then(body);
  // Интерфейс открывается на торговом доме: подбирать надо в той же компании,
  // иначе в списках формы выбранного товара просто не будет.
  const company = auth.companies.find((c) => c.code === 'trade') ?? auth.companies[0];
  const headers = { Authorization: `Bearer ${auth.token}`, 'X-Company-Id': company.uid };

  const refs = await fetch(`${API}/sales/refs`, { headers }).then(body);
  const stock = await fetch(`${API}/warehouse/stock?limit=200`, { headers }).then(body);

  const sellable = new Map(
    (refs.items ?? [])
      .filter((i) => i.companyUid === company.uid)
      .map((i) => [i.code, i]),
  );
  // Ячейку для отгрузки выбирает сервер (`pickSourceLocation`) и берёт ту, где
  // доступного хватает целиком, — поэтому годится строка остатка с любой полкой,
  // лишь бы на ней самой хватало. Условие «строка без ячейки» стояло здесь до
  // того, как ячейка стала обязательным измерением остатка: таких строк больше
  // нет ни одной, и прогон упирался в подбор, а не в продажи.
  const row = (stock.rows ?? []).find(
    (r) => sellable.has(r.item.code) && Number(r.qtyAvailable) >= 4,
  );
  const partner = (refs.partners ?? []).find((p) => p.companyUid === company.uid);
  const warehouse = row
    ? (refs.warehouses ?? []).find((w) => w.companyUid === company.uid && w.code === row.warehouse.code)
    : null;

  if (!row || !partner || !warehouse) {
    return {
      problem:
        'не нашлось продаваемой позиции со свободным остатком ≥ 4 на складе торгового дома ' +
        `(строк остатка ${stock.rows?.length ?? 0}, продаваемых позиций ${sellable.size}, ` +
        `покупателей ${refs.partners?.length ?? 0})`,
    };
  }

  const item = sellable.get(row.item.code);
  return {
    partner: partner.nameRu,
    itemCode: row.item.code,
    itemName: item.nameRu,
    warehouseCode: warehouse.code,
    warehouseName: warehouse.nameRu,
    available: Number(row.qtyAvailable),
    trackBatches: item.trackBatches,
  };
}

/** Поле формы в правой панели, а не одноимённая подпись в списке заказов. */
const formField = (page, ariaLabel) =>
  page.locator('form').first().getByRole('button', { name: ariaLabel, exact: true }).first();

const formInput = (page, ariaLabel) =>
  page.locator('form').first().getByRole('textbox', { name: ariaLabel, exact: true }).first();

async function chooseOption(page, at, ariaLabel, matches, what) {
  const trigger = formField(page, ariaLabel);
  if ((await trigger.count()) === 0) {
    errors.push(`[${at}] в форме нет поля «${ariaLabel}»`);
    return false;
  }
  await trigger.click();
  const menu = page.locator('[role="listbox"]').last();
  try {
    await menu.waitFor({ state: 'visible', timeout: 4000 });
  } catch {
    errors.push(`[${at}] «${ariaLabel}»: список не раскрылся`);
    return false;
  }
  const items = menu.locator('button');
  // Тексты снимаем одним вызовом: справочник мог догрузиться, и перебор по
  // одному напоролся бы на перерисованный список.
  const seen = (await items.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
  const hit = seen.findIndex(matches);
  if (hit >= 0) {
    await items.nth(hit).click();
    await page.waitForTimeout(400);
    return true;
  }
  await page.keyboard.press('Escape');
  errors.push(
    `[${at}] в списке «${ariaLabel}» нет пункта ${what}; есть: ` +
      (seen.length ? seen.slice(0, 4).join(' | ') : 'ничего'),
  );
  return false;
}

/**
 * Правая панель, а не карточка портфеля.
 *
 * Узкую колонку `lg:col-span-4` занимают две карточки: портфель в верхнем ряду
 * и панель заказа в нижнем. Первая по разметке — портфель, поэтому берём
 * последнюю: иначе проверка читает сумму портфеля вместо статуса заказа и
 * ругается на исправный экран.
 */
const panelCard = (page) => page.locator('div[class*="lg:col-span-4"]').last();

/** Текст правой панели целиком: по нему сверяются статус и суммы. */
const panelText = (page) =>
  panelCard(page)
    .innerText()
    .then((t) => t.replace(/\s+/g, ' ').trim())
    .catch(() => '');

/** Номер заказа из шапки панели: формат задаёт нумератор, поэтому берём с экрана. */
const orderNumber = (page) =>
  panelCard(page)
    .locator('div[class*="font-mono"]')
    .first()
    .innerText()
    .then((t) => t.trim())
    .catch(() => '');

/**
 * Приводит правую панель к форме нового заказа.
 *
 * Кнопки «Новый заказ» на экране нет по требованию заказчика: форма и есть
 * состояние покоя панели. Значит открыть её нечем — можно только закрыть
 * карточку, если в панели сейчас открыт заказ.
 */
async function openOrderForm(page, at) {
  const stray = page.getByRole('button', { name: 'Новый заказ', exact: true });
  if ((await stray.count()) > 0) {
    errors.push(`[${at}] кнопка «Новый заказ» вернулась: её убрали сознательно`);
  }

  const closeCard = page.getByRole('button', { name: 'Закрыть карточку', exact: true }).first();
  if ((await closeCard.count()) > 0) {
    await closeCard.click();
    await page.waitForTimeout(800);
  }

  if ((await page.locator('text=Черновик заказа').count()) === 0) {
    errors.push(`[${at}] правая панель не показывает форму нового заказа`);
    return false;
  }
  return true;
}

/**
 * Подтверждённый заказ завода на штучную позицию — запросом, не формой.
 *
 * Прогону нужен повод открыть накладную, а не ещё один круг по форме заказа:
 * форма проверена выше. Возвращает номер, по которому заказ находят в списке.
 */
async function makePlantOrder() {
  const body = async (res) => {
    const json = await res.json();
    return json?.data ?? json;
  };
  const auth = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: PLANT_LOGIN, password: PASSWORD }),
  }).then(body);
  const company = auth.companies.find((c) => c.code === 'plant') ?? auth.companies[0];
  const headers = {
    Authorization: `Bearer ${auth.token}`,
    'X-Company-Id': company.uid,
    'Content-Type': 'application/json',
  };
  const refs = await fetch(`${API}/sales/refs`, { headers }).then(body);
  const partner = (refs.partners ?? []).find((p) => p.companyUid === company.uid);
  if (!partner) return null;

  const made = await fetch(`${API}/sales/orders`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      companyUid: company.uid,
      partnerUid: partner.uid,
      warehouseCode: 'ZAVOD-GP',
      comment: 'проверка QA: ТТН по номерам',
      // Цену не называем: её подставит прайс. Своя цифра здесь была бы
      // «ручной ценой» — для неё нужно право и основание, а у менеджера
      // завода права нет, и прогон уткнулся бы в 403 на ровном месте.
      lines: [{ itemCode: 'PPU-530-710', qty: '2' }],
    }),
  }).then(body);
  if (!made?.uid) return null;

  await fetch(`${API}/sales/orders/${made.uid}/status`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ status: 'confirmed' }),
  });
  return made;
}

/**
 * ТТН штучной позиции: номера труб вместо количества (ТЗ 5.6).
 *
 * Идёт в своём окне под менеджером завода, а не переключением компании у
 * директора: штучные позиции есть только у завода, а переключение посреди
 * прохода оставляет на экране карточку заказа чужой компании.
 *
 * Проверяется то, чего не видно на снимке: количество у такой строки не
 * набирается руками, номера приходят с сервера, и количество равно числу
 * отмеченных труб. Накладную не выписываем — каждая отгрузка уносит со склада
 * настоящую трубу, вернуть которую может только пересев.
 */
async function runSerialShipment(browser, at, width, height, theme) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`[${at}] PAGEERROR ${e.message.slice(0, 200)}`));
  let step = 'вход';
  try {
    await page.addInitScript((t) => localStorage.setItem('metall_theme', t), theme);
    await page.goto('http://127.0.0.1:4321/', { waitUntil: 'networkidle' });
    await page.locator('input[autocomplete="username"]').first().fill(PLANT_LOGIN);
    await page.locator('input[autocomplete="current-password"]').first().fill(PASSWORD);
    await page.getByRole('button', { name: 'Войти' }).click();
    await page.waitForSelector('text=/Выручка|Tushum/', { state: 'attached', timeout: 15000 });
    await page.getByRole('button', { name: 'Продажи', exact: true }).first().click();
    await page.waitForTimeout(1500);

    step = 'заказ через API';
    // Заказ заводим запросом, а не формой: здесь проверяется накладная, и
    // круг по форме уже пройден выше на торговом доме. Через API он ещё и
    // воспроизводим — подбор в форме зависит от того, что лежит на складе.
    const order = await makePlantOrder();
    if (!order) {
      errors.push(`[${at}] не удалось завести заказ на штучную позицию через API`);
      return;
    }
    notes.push(`[${at}] заказ на штучную позицию: ${order.number}`);

    step = 'открытие заказа';
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    await page.getByRole('button', { name: 'Продажи', exact: true }).first().click();
    await page.waitForTimeout(1500);
    const row = page.locator('div[class*="divide-y"] > button').filter({ hasText: order.number }).first();
    if ((await row.count()) === 0) {
      errors.push(`[${at}] заказ ${order.number} не виден в списке`);
      return;
    }
    await row.click();
    await page.waitForTimeout(1500);

    step = 'открытие ТТН';
    const ttn = page.getByRole('button', { name: 'Выписать ТТН' }).first();
    if ((await ttn.count()) === 0) {
      errors.push(`[${at}] у подтверждённого заказа на штучную позицию нет кнопки «Выписать ТТН»`);
      return;
    }
    await ttn.click();
    await page.waitForTimeout(1500);

    step = 'номера труб';
    const chips = page.getByRole('group', { name: /Номера труб/ }).first();
    if ((await chips.count()) === 0) {
      errors.push(`[${at}] в ТТН штучной позиции нет выбора номеров труб`);
      return;
    }
    const qty = formInput(page, 'Количество 1');
    if (!(await qty.evaluate((el) => el.readOnly))) {
      errors.push(`[${at}] количество штучной строки набирается руками, а должно считаться по номерам`);
    }
    if ((await qty.inputValue()) !== '0') {
      errors.push(`[${at}] количество штучной строки не начинается с нуля: номера ещё не отмечены`);
    }

    const buttons = chips.locator('button');
    const total = await buttons.count();
    if (total < 2) {
      notes.push(`[${at}] свободных номеров на складе ${total} — отметка пропущена`);
      return;
    }
    await buttons.nth(0).click();
    await buttons.nth(1).click();
    await page.waitForTimeout(400);
    const after = await qty.inputValue();
    notes.push(`[${at}] номеров на складе ${total}, отмечено 2, количество стало ${after}`);
    if (after !== '2') errors.push(`[${at}] после отметки двух номеров количество ${after}, а не 2`);

    await page.screenshot({ path: `${OUT}/sales-ttn-serial-${at.replace(/\//g, '-')}.png`, fullPage: true });
    overflow.push({ key: `${at}/ttn-serial`, isDefault: true, ...(await measure(page)) });

    // Снятая отметка обязана уменьшить количество: иначе число на экране
    // живёт своей жизнью.
    await buttons.nth(1).click();
    await page.waitForTimeout(300);
    const back = await qty.inputValue();
    if (back !== '1') errors.push(`[${at}] после снятия отметки количество ${back}, а не 1`);
  } catch (e) {
    errors.push(`[${at}] круг ТТН по номерам оборвался на шаге «${step}»: ${String(e.message).split('\n')[0]}`);
    await page.screenshot({ path: `${OUT}/FAIL-serial-${at.replace(/\//g, '-')}.png` }).catch(() => {});
  } finally {
    await ctx.close();
  }
}

/**
 * Полный круг: заказ из формы → подтверждение → частичная ТТН → полная ТТН.
 *
 * Идёт один раз за прогон и только на широком экране: каждый круг оставляет в
 * базе заказ и движения склада, а журнал движений только пополняется — отменить
 * отгрузку нельзя ни кнопкой, ни прогоном.
 */
async function runWriteCircle(page, at, target) {
  notes.push(
    `[${at}] круг записи: ${target.partner} / ${target.itemCode} / ${target.warehouseCode}` +
      ` (доступно ${target.available}${target.trackBatches ? ', партионный' : ''})`,
  );

  if (!(await openOrderForm(page, at))) return;

  const ready =
    (await chooseOption(page, at, 'Покупатель', (t) => t.includes(target.partner.slice(0, 12)), `с покупателем ${target.partner}`)) &&
    (await chooseOption(page, at, 'Склад', (t) => t.includes(target.warehouseCode), `со складом ${target.warehouseCode}`)) &&
    (await chooseOption(page, at, 'Номенклатура 1', (t) => t.includes(target.itemCode), `с кодом ${target.itemCode}`));
  if (!ready) return;

  // Комментарий помечает заказ как заведённый прогоном: удалить его нельзя
  // (отгрузка уже в журнале), а по базе потом видно, откуда он взялся.
  await formInput(page, 'Комментарий').fill('проверка QA sales-live');
  await formInput(page, 'Количество 1').fill('2');

  // ТЗ 9.2. Цену подставляет прайс, а не человек: поле заполнено сразу после
  // выбора позиции, и под ним сказано, откуда цифра.
  await page.waitForTimeout(600);
  const fromList = await formInput(page, 'Цена 1').inputValue();
  const formText = (await panelText(page)).toLowerCase();
  if (!fromList) {
    errors.push(`[${at}] цена из прайса не подставилась: поле пустое`);
  }
  if (!/прайс|цена клиента|нет в прайсе/.test(formText)) {
    errors.push(`[${at}] форма не говорит, откуда цена`);
  }

  // Ручная цена — осознанное действие: появляется поле основания, и без него
  // форма не отправляется.
  await formInput(page, 'Цена 1').fill(String(Math.round(Number(fromList || 1000000) * 1.3)));
  await page.waitForTimeout(400);
  if ((await formInput(page, 'Основание цены 1').count()) === 0) {
    errors.push(`[${at}] цену поставили руками, а основание не спросили`);
  } else {
    const save = page.getByRole('button', { name: 'Сохранить', exact: true }).first();
    if (await save.isEnabled()) {
      errors.push(`[${at}] «Сохранить» доступно при ручной цене без основания`);
    }
    await formInput(page, 'Основание цены 1').fill('проверка QA: цена согласована отдельно');
    await page.waitForTimeout(300);
  }

  // Дальше круг идёт по прайсу: возвращаем цену и не ставим скидку, чтобы
  // проверялась отгрузка, а не правило «ниже себестоимости».
  if (fromList) {
    await formInput(page, 'Цена 1').fill(fromList);
    await page.waitForTimeout(400);
  }
  await formInput(page, 'Скидка 1').fill('0');
  await page.waitForTimeout(300);

  // Предварительная сумма: 2 × цена − 10 % плюс НДС. Считает её форма, а не
  // прогон, — здесь проверяется только то, что она вообще появилась.
  const preview = await panelText(page);
  if (!/Предварительно: [\d\s]/.test(preview)) {
    errors.push(`[${at}] форма не показала предварительную сумму`);
  }
  await page.screenshot({ path: `${OUT}/sales-order-form-${at.replace('/', '-')}.png`, fullPage: true });
  overflow.push({ key: `${at}/order-form`, isDefault: true, ...(await measure(page)) });

  await page.getByRole('button', { name: 'Сохранить', exact: true }).first().click();
  await page.waitForTimeout(2500);

  const number = await orderNumber(page);
  let panel = await panelText(page);
  notes.push(`[${at}] заказ записан: ${number || '(номера нет)'}`);
  // Подпись панели набрана `uppercase`: сравниваем без учёта регистра.
  if (!number || !/спецификация заказа/i.test(panel)) {
    errors.push(`[${at}] после сохранения не открылась спецификация заказа: «${panel.slice(0, 160)}»`);
    return;
  }
  if (!panel.includes('Черновик')) {
    errors.push(`[${at}] новый заказ записан не черновиком: «${panel.slice(0, 120)}»`);
  }
  // Пока заказ черновик, ТТН по нему выписывать нечем: сначала подтверждение.
  if ((await page.getByRole('button', { name: 'Выписать ТТН' }).count()) > 0) {
    errors.push(`[${at}] у черновика есть кнопка «Выписать ТТН»`);
  }

  await page.getByRole('button', { name: 'Подтвердить', exact: true }).first().click();
  await page.waitForTimeout(2000);
  panel = await panelText(page);
  if (!panel.includes('Подтверждён')) {
    errors.push(`[${at}] заказ не подтвердился: «${panel.slice(0, 160)}»`);
    return;
  }
  notes.push(`[${at}] ${number}: черновик → подтверждён`);

  // --- ТТН: сначала заведомо лишнее количество ------------------------------
  // Отгрузить больше, чем в заказе, нельзя, и форма обязана сказать это до
  // нажатия: иначе человек узнаёт об отказе только из ответа сервера.
  const ttn = page.getByRole('button', { name: 'Выписать ТТН' }).first();
  if ((await ttn.count()) === 0) {
    errors.push(`[${at}] у подтверждённого заказа нет кнопки «Выписать ТТН»`);
    return;
  }
  await ttn.click();
  await page.waitForTimeout(1500);
  if ((await page.locator('text=Товарно-транспортная накладная').count()) === 0) {
    errors.push(`[${at}] форма ТТН не открылась`);
    return;
  }

  const qty = formInput(page, 'Количество 1');
  await qty.fill('999999');
  await page.waitForTimeout(500);
  const said = await panelText(page);
  if (!said.includes('осталось отгрузить')) {
    errors.push(`[${at}] форма ТТН не предупредила о количестве больше заказанного`);
  }
  const canSend = await page
    .getByRole('button', { name: 'Выписать ТТН', exact: true })
    .first()
    .isEnabled();
  if (canSend) errors.push(`[${at}] кнопка ТТН активна при количестве больше заказанного`);
  notes.push(`[${at}] лишнее количество в ТТН: предупреждение есть, кнопка ${canSend ? 'активна' : 'заперта'}`);
  await page.screenshot({ path: `${OUT}/sales-ttn-over-${at.replace('/', '-')}.png`, fullPage: true });
  overflow.push({ key: `${at}/ttn-form`, isDefault: true, ...(await measure(page)) });

  // --- частичная отгрузка ---------------------------------------------------
  await qty.fill('1');
  await formInput(page, 'Машина').fill('01 QA 999');
  await formInput(page, 'Водитель').fill('Проверка QA');
  await formInput(page, 'Вес нетто').fill('1.5');
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'Выписать ТТН', exact: true }).first().click();
  await page.waitForTimeout(3000);

  panel = await panelText(page);
  if (!panel.includes('ТТН-')) {
    errors.push(`[${at}] частичная ТТН не записалась: «${panel.slice(0, 200)}»`);
    return;
  }
  if (!panel.includes('Отгружен частично') || !panel.includes('Комплектуется')) {
    errors.push(
      `[${at}] после частичной отгрузки заказ не стал «Комплектуется / отгружен частично»: ` +
        `«${panel.slice(0, 200)}»`,
    );
  }
  notes.push(`[${at}] ${number}: частичная ТТН выписана, статус «комплектуется / частично»`);
  await page.screenshot({ path: `${OUT}/sales-ttn-partial-${at.replace('/', '-')}.png`, fullPage: true });

  // --- остаток заказа -------------------------------------------------------
  await page.getByRole('button', { name: 'Выписать ТТН' }).first().click();
  await page.waitForTimeout(1500);
  const rest = await formInput(page, 'Количество 1').inputValue();
  notes.push(`[${at}] остаток в форме второй ТТН: ${rest}`);
  if (Number(rest.replace(',', '.')) !== 1) {
    errors.push(`[${at}] форма второй ТТН подставила не остаток заказа, а ${rest}`);
  }
  await page.getByRole('button', { name: 'Выписать ТТН', exact: true }).first().click();
  await page.waitForTimeout(3000);

  panel = await panelText(page);
  if (!panel.includes('Отгружен полностью')) {
    errors.push(`[${at}] после полной отгрузки заказ не стал «отгружен полностью»: «${panel.slice(0, 200)}»`);
  } else {
    notes.push(`[${at}] ${number}: заказ отгружен полностью`);
  }
  // «Отгружен» ставит только ТТН: руками такого перехода в панели нет.
  const closable = await page.getByRole('button', { name: 'Закрыть', exact: true }).count();
  if (closable === 0) errors.push(`[${at}] у отгруженного заказа нет действия «Закрыть»`);
  if ((await page.getByRole('button', { name: 'Выписать ТТН' }).count()) > 0) {
    errors.push(`[${at}] у полностью отгруженного заказа осталась кнопка ТТН`);
  }
  await page.screenshot({ path: `${OUT}/sales-ttn-full-${at.replace('/', '-')}.png`, fullPage: true });
}

/**
 * Права на экране: у кладовщика есть `sales.view` и нет `sales.edit`.
 *
 * Отдельный контекст, потому что вход один на сессию. Сервер отказал бы и так,
 * но кнопка, которая всегда возвращает 403, — это обещание, которого экран не
 * держит.
 */
async function runKeeperView(browser, at) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  try {
    await page.goto('http://127.0.0.1:4321/', { waitUntil: 'networkidle' });
    await page.locator('input[autocomplete="username"]').first().fill(KEEPER_LOGIN);
    await page.locator('input[autocomplete="current-password"]').first().fill(PASSWORD);
    await page.getByRole('button', { name: 'Войти' }).click();
    await page.waitForSelector('text=/Выручка|Tushum/', { state: 'attached', timeout: 15000 });
    await page.getByRole('button', { name: 'Продажи', exact: true }).first().click();
    await page.waitForTimeout(1500);

    if ((await page.getByRole('button', { name: 'Новый заказ', exact: true }).count()) > 0) {
      errors.push(`[${at}] у кладовщика есть кнопка «Новый заказ»`);
    }
    // Форма в панели — то же право записи, что и кнопка: без `sales.edit`
    // панель обязана остаться подсказкой, а не стать бланком заказа.
    if ((await page.locator('text=Черновик заказа').count()) > 0) {
      errors.push(`[${at}] у кладовщика в панели стоит форма нового заказа`);
    }
    await page.locator('div[class*="divide-y"] > button').first().click();
    await page.waitForTimeout(1500);
    const panel = await panelText(page);
    if (!/спецификация заказа/i.test(panel)) {
      errors.push(`[${at}] кладовщик не видит спецификацию заказа`);
    }
    for (const name of ['Подтвердить', 'Выписать ТТН', 'Отменить']) {
      if ((await page.getByRole('button', { name }).count()) > 0) {
        errors.push(`[${at}] у кладовщика есть действие «${name}»`);
      }
    }
    notes.push(`[${at}] кладовщик: чтение есть, кнопок записи нет`);
    await page.screenshot({ path: `${OUT}/sales-keeper-1440-light.png`, fullPage: true });
  } catch (e) {
    errors.push(`[${at}] проверка прав оборвалась: ${String(e.message).split('\n')[0]}`);
  }
  await ctx.close();
}

/** Переполнение по горизонтали и кто именно вылез. */
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

try {
  await assertPortFree();
  backend = spawn('node', ['dist/main.js'], {
    cwd: BACKEND,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(API_PORT),
      CORS_ORIGINS: 'http://localhost:5173,http://127.0.0.1:4321',
    },
  });
  backend.stdout.on('data', (d) => process.stdout.write(`[api] ${d}`));
  backend.stderr.on('data', (d) => process.stderr.write(`[api!] ${d}`));

  const status = await waitForApi(20000);
  console.log(`бэкенд отвечает, /sales/summary без токена → ${status}`);

  // Что продавать — спрашиваем до браузера: если продать нечего, круг записи
  // надо назвать непройденным, а не тихо пропустить.
  const target = await pickTarget();
  console.log(
    target.problem
      ? `цель круга записи не найдена: ${target.problem}`
      : `цель круга записи: ${target.itemCode} / ${target.warehouseCode} / ${target.partner}`,
  );

  const app = express();
  app.use(express.static(ROOT));
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(ROOT, 'index.html')));
  server = await new Promise((resolve) => {
    const s = app.listen(4321, '127.0.0.1', () => resolve(s));
  });

  browser = await chromium.launch({
    executablePath: '/home/an/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
    args: ['--no-sandbox'],
  });

  for (const [w, h, tag] of [[1440, 900, '1440'], [360, 780, '360']]) {
    for (const theme of ['light', 'dark']) {
      const at = `${tag}/${theme}`;
      const ctx = await browser.newContext({ viewport: { width: w, height: h } });
      const page = await ctx.newPage();
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(`[${at}] ${m.text().slice(0, 300)}`);
      });
      page.on('pageerror', (e) => errors.push(`[${at}] PAGEERROR ${e.message.slice(0, 300)}`));
      page.on('response', (r) => {
        if (r.url().includes('/sales/') && r.status() >= 400) {
          errors.push(`[${at}] ${r.status()} ${new URL(r.url()).pathname}`);
        }
      });
      await page.addInitScript((t) => localStorage.setItem('metall_theme', t), theme);

      await page.goto('http://127.0.0.1:4321/', { waitUntil: 'networkidle' });
      await page.waitForTimeout(300);

      await page.locator('input[autocomplete="username"]').first().fill(LOGIN);
      await page.locator('input[autocomplete="current-password"]').first().fill(PASSWORD);
      await page.getByRole('button', { name: 'Войти' }).click();
      await page.waitForSelector('text=/Выручка|Tushum/', { state: 'attached', timeout: 15000 });

      // В свёрнутом сайдбаре подпись живёт в title, имя у кнопки то же.
      await page.getByRole('button', { name: 'Продажи', exact: true }).first().click();
      await page.waitForTimeout(1500);

      // Шапка: среднесуточный темп должен быть числом, а не прочерком.
      const headline = (await page.locator('text=в среднем за сутки').count())
        ? await page
            .locator('text=в среднем за сутки')
            .first()
            .evaluate((el) => el.parentElement?.textContent ?? '')
        : '';
      notes.push(`[${at}] шапка графика: ${headline.trim().slice(0, 80) || '(не найдена)'}`);
      if (!/\d/.test(headline)) {
        errors.push(`[${at}] среднесуточная погрузка не отрисовалась: «${headline.trim()}»`);
      }

      // Размер полоски до того, как пользователь тронул вкладки: с ним
      // сверяем каждое следующее состояние.
      const tabsAtStart = await tabsBox(page);
      notes.push(`[${at}] полоска разделов при открытии: ${tabsAtStart.w}×${tabsAtStart.h}`);
      if (tabsAtStart.scroll > 0) {
        errors.push(`[${at}] полоска разделов прокручивается при открытии: +${tabsAtStart.scroll}px`);
      }

      for (const { key, label } of TABS) {
        // Пропавшая вкладка — находка, а не авария скрипта: иначе один
        // отсутствующий раздел убивает прогон раньше, чем он скажет, чего нет.
        const tabButton = page.getByRole('button', { name: new RegExp(`^${label}`) }).first();
        if ((await tabButton.count()) === 0) {
          errors.push(`[${at}] в полоске разделов нет вкладки «${label}»`);
          continue;
        }
        await tabButton.click();
        await page.waitForTimeout(1200);

        const box = await tabsBox(page);
        if (box.scroll > 0) {
          errors.push(`[${at}/${key}] в полоске разделов скроллбар: +${box.scroll}px`);
        }
        const outside = await headerFits(page);
        if (outside.length) {
          errors.push(`[${at}/${key}] шапка списка вылезла за карточку: ${outside.join(', ')}`);
        }
        if (box.w !== tabsAtStart.w || box.h !== tabsAtStart.h) {
          errors.push(
            `[${at}/${key}] полоска разделов изменила размер после выбора вкладки: ` +
              `${tabsAtStart.w}×${tabsAtStart.h} → ${box.w}×${box.h}`,
          );
        }

        if (key === 'prices') {
          // У прайса свой счётчик: «показано N из M». Подвал «Записей» тут не
          // при чём — список собирается не из заказов.
          const shown = (await page.locator('main').innerText()).match(
            /показано (\d+) из (\d+)|(\d+) dan (\d+) ko‘rsatildi/,
          );
          notes.push(`[${at}] prices: ${shown ? shown[0] : '(счётчика нет)'}`);
          if (!shown) {
            errors.push(`[${at}] прайс не говорит, сколько позиций показано из скольких`);
          } else if (Number(shown[1]) === 0) {
            errors.push(`[${at}] в прайсе ни одной позиции`);
          }
          // В строке обязана быть цена с датой начала действия: прайс без
          // периода — это просто цифра, по которой нельзя разобрать прошлый заказ.
          const firstRow = await page
            .locator('div[class*="divide-y"] > button')
            .first()
            .innerText()
            .catch(() => '');
          if (!/\d[\d\s]*·\s*с\s*\d{2}\.\d{2}\.\d{4}/.test(firstRow.replace(/\u00a0/g, ' '))) {
            errors.push(
              `[${at}] в прайсе не видно цены с датой начала: «${firstRow.replace(/\s+/g, ' ').slice(0, 90)}»`,
            );
          }
          await page.locator('div[class*="divide-y"] > button').first().click();
          await page.waitForTimeout(1200);
          const pricePanel = await panelText(page);
          if (!/прайс-лист/i.test(pricePanel)) {
            errors.push(`[${at}] панель прайса не открылась: «${pricePanel.slice(0, 120)}»`);
          }
          for (const name of ['История', 'Новая цена']) {
            if ((await panelCard(page).getByRole('button', { name }).count()) === 0) {
              errors.push(`[${at}] в панели прайса нет кнопки «${name}»`);
            }
          }
        } else {
          // Строк в списке столько, сколько показал счётчик в подвале карточки.
          const footer = await page.locator('text=/Записей:\\s*\\d+/').first().innerText().catch(() => '');
          const count = Number(footer.match(/(\d+)/)?.[1] ?? 0);
          notes.push(`[${at}] ${key}: ${footer.trim() || '(подвал не найден)'}`);
          if (count === 0) errors.push(`[${at}] вкладка «${label}» пуста: ${footer || 'подвала нет'}`);
        }

        // На вкладке заказов открываем первый заказ: панель справа обязана
        // наполниться, иначе экран «работает» только до клика.
        if (key === 'orders') {
          // Строка списка — кнопка внутри контейнера с разделителями. По
          // номеру заказа не ищем: его формат задаёт нумератор, а не прогон.
          await page.locator('div[class*="divide-y"] > button').first().click();
          await page.waitForTimeout(1200);
          const spec = await page.locator('text=Спецификация заказа').count();
          if (spec === 0) errors.push(`[${at}] спецификация заказа не открылась`);
        }

        await page.screenshot({ path: `${OUT}/sales-${key}-${tag}-${theme}.png`, fullPage: true });

        const ov = await measure(page);
        overflow.push({ key: `${at}/${key}`, isDefault: true, ...ov });

        const body = await page.locator('body').innerText();
        for (const phrase of FICTION) {
          if (body.includes(phrase)) found.push(`[${at}/${key}] «${phrase}»`);
        }
      }

      // Вкладка «Цены» оставила бы в правой панели прайс, а дальше проверяется
      // панель заказа и форма нового заказа. Возвращаемся к заказам.
      await page.getByRole('button', { name: /^Заказы/ }).first().click();
      await page.waitForTimeout(1000);

      // Круг записи — один раз за прогон: он оставляет в базе заказ и движения
      // склада, а движения только пополняются. Широкий экран и светлая тема
      // выбраны, чтобы снимки форм читались.
      if (tag === '1440' && theme === 'light') {
        if (target.problem) {
          errors.push(`[${at}] круг записи не начать: ${target.problem}`);
        } else {
          await page.getByRole('button', { name: /^Заказы/ }).first().click();
          await page.waitForTimeout(800);
          // Обрыв внутри круга — находка, а не авария скрипта: иначе первая же
          // поломка убивает процесс раньше, чем он скажет, что именно не так.
          try {
            await runWriteCircle(page, at, target);
          } catch (e) {
            errors.push(`[${at}] круг записи оборвался: ${String(e.message).split('\n')[0]}`);
            await page
              .screenshot({ path: `${OUT}/FAIL-write-circle.png`, fullPage: true })
              .catch(() => {});
          }
        }
      }
      // Тёмная тема: форму надо увидеть и в ней, а записывать второй раз
      // незачем — снимок и замер.
      if (theme === 'dark' && !target.problem) {
        await openOrderForm(page, at);
        await page.waitForTimeout(600);
        await page.screenshot({ path: `${OUT}/sales-order-form-${tag}-dark.png`, fullPage: true });
        overflow.push({ key: `${at}/order-form`, isDefault: true, ...(await measure(page)) });
      }

      // Формы на узком экране: заказ заводят и с телефона.
      if (tag === '360' && theme === 'light' && !target.problem) {
        await openOrderForm(page, at);
        await page.waitForTimeout(600);

        // Ниже `lg` панель стоит под списком: выбранный заказ обязан доехать
        // до экрана сам, иначе нажатие выглядит как ничего не сделавшее.
        await page.locator('div[class*="divide-y"] > button').first().click();
        await page.waitForTimeout(1200);
        const where = await panelCard(page).evaluate((el) => {
          const r = el.getBoundingClientRect();
          return { top: Math.round(r.top), bottom: Math.round(r.bottom) };
        });
        notes.push(`[${at}] панель после выбора заказа: ${where.top}…${where.bottom} при высоте ${h}`);
        if (where.top > h - 120) {
          errors.push(`[${at}] панель осталась за нижним краем: верх на ${where.top} при высоте ${h}`);
        }
        // Обратно к форме — крестиком в карточке: другого пути к ней нет.
        const formBack = await openOrderForm(page, at);
        await page.waitForTimeout(400);
        await page.screenshot({ path: `${OUT}/sales-order-form-360-light.png`, fullPage: true });
        overflow.push({ key: `${at}/order-form`, isDefault: true, ...(await measure(page)) });
        // Замеры по полям формы имеют смысл только когда форма на месте:
        // без неё прогон должен назвать причину, а не упасть на поиске поля.
        if (formBack) {
          // Раскрытый список рисуется поверх страницы: обрезку краем панели
          // видно только раскрытым, и мерить надо его собственные края.
          await formField(page, 'Покупатель').click();
          await page.waitForTimeout(400);
          const cut = await page
            .locator('[role="listbox"]')
            .last()
            .evaluate((el) => {
              const r = el.getBoundingClientRect();
              return { top: Math.round(r.top), bottom: Math.round(r.bottom) };
            })
            .catch(() => null);
          if (cut) {
            notes.push(`[${at}] список покупателей: ${cut.top}…${cut.bottom} при высоте ${h}`);
            if (cut.top < 0 || cut.bottom > h) {
              errors.push(
                `[${at}] раскрытый список вышел за экран: ${cut.top}…${cut.bottom} при ${h}`,
              );
            }
            await page.screenshot({ path: `${OUT}/sales-order-select-360-light.png` });
          } else {
            errors.push(`[${at}] список покупателей не раскрылся на 360`);
          }
          await page.keyboard.press('Escape');
          await page.waitForTimeout(300);
          // В постоянной панели «Отмена» стала «Сбросить»: прятать нечего,
          // чистим набранное, чтобы следующий замер шёл по пустой форме.
          await page.getByRole('button', { name: 'Сбросить', exact: true }).first().click();
          await page.waitForTimeout(500);
        }
      }

      // Развёрнутый сайдбар — отдельный замер, спрос с него мягче: это уже
      // осознанное действие пользователя, а не состояние по умолчанию.
      const toggle = page.getByRole('button', { name: /боковую панель/i }).first();
      if (await toggle.count()) {
        await toggle.click();
        await page.waitForTimeout(500);
        const ov = await measure(page);
        overflow.push({ key: `${at}/toggled`, isDefault: false, ...ov });
      }

      await ctx.close();
    }
  }

  await runKeeperView(browser, '1440/light/keeper');

  // ТТН по номерам — на обоих экранах и в обеих темах: выбор труб нарисован
  // чипами, и именно они на узком экране норовят вылезти за край.
  for (const [w, h, tag] of [[1440, 900, '1440'], [360, 780, '360']]) {
    for (const theme of ['light', 'dark']) {
      await runSerialShipment(browser, `${tag}/${theme}/serial`, w, h, theme);
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
