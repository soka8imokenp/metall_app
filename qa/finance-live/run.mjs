/**
 * Прогон страницы «Финансы» против живого бэкенда.
 *
 * Проверяет то, что по скриншоту не проверишь:
 *   1) на экране нет чисел и подписей из импортированного макета;
 *   2) данные пришли — строки на всех трёх вкладках, остаток счетов числом,
 *      карточка операции с проводками и сошедшимся балансом;
 *   3) полоска разделов не прокручивается и не меняет размер после клика,
 *      шапка списка не вылезает за карточку;
 *   4) содержимое не вылезает за контейнер на 360 и 1440 в обеих темах;
 *   5) кнопка «На согласование» действительно меняет статус на сервере —
 *      нажатие в браузере, а не запрос мимо экрана.
 *
 * Пятая проверка пишет в базу, поэтому делается один раз, на 1440/light, а
 * задетая строка возвращается в исходный статус и версию в finally. Без отката
 * второй прогон взял бы уже отправленную заявку и позеленел впустую.
 *
 * Всё в одном переднем процессе: фоновые запуски запрещены, бэкенд поднимается
 * дочерним процессом и глушится в finally.
 *
 * Перед запуском собрать фронт с живым API:
 *   cd dev/frontend && bun run build:qa   # сборка для прогона, каталог dist-qa
 *
 * Запуск:
 *   cd dev/qa && bun run finance-live
 */
import { spawn } from 'node:child_process';
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import pgPkg from 'pg';

const { Client } = pgPkg;

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '../../frontend/dist-qa');
const BACKEND = path.resolve(HERE, '../../backend');
const OUT = path.resolve(HERE, 'shots');
/** Порт 4400, а не 4000: на 4000 живёт внешний стенд со своей базой. */
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
/** Директор: у него есть finance.view и обе компании. */
const LOGIN = 's.radjabov';
const PASSWORD = process.env.SEED_PASSWORD ?? 'metall-dev-2026';

/**
 * Выдумки из импортированного макета: контрагенты, должности и подписи, за
 * которыми нет ни одной строки в базе. Любая на экране — провал прогона.
 */
const FICTION = [
  'Движение денежных средств (Операции и согласование)',
  'Дебиторская задолженность (Возрастная структура 1-60+ дней)',
  'Tashkent City Construction',
  'ХимПром Синтез',
  'Samarkand Pipe Grid',
  'Бухара ГазСтрой',
  'Фин. директор',
  'Снабженец Рустам',
  'Сформируются при проведении',
  'ПРЕВЫШЕН',
  'Просрочка 1–7 дн',
  'ПЛ-000412',
  'ПЛ-000418',
];

const TABS = [
  { key: 'operations', label: 'Операции' },
  { key: 'receivables', label: 'Дебиторка' },
  { key: 'planfact', label: 'План-факт' },
];

fs.mkdirSync(OUT, { recursive: true });

const errors = [];
const overflow = [];
const found = [];
const notes = [];
let backend;
let server;
let browser;
let db;
/** Заявка, которую прогон отправит на согласование, и её исходное состояние. */
let victim = null;
/** Запись через интерфейс проверяем один раз: она меняет данные. */
let writeChecked = false;
/** uid операций, которые прогон завёл сам: снести вместе с проводками. */
const createdUids = [];
/** Сумма новой операции: по ней её потом находят в базе. */
const NEW_AMOUNT = '777000.00';
/** Бюджеты, заведённые прогоном: снести в finally, иначе второй прогон упрётся в дубль. */
const createdBudgets = [];
/** Суммы бюджета прогона: по ним его находят в базе до и после правки. */
const BUDGET_AMOUNT = '654000000';
const BUDGET_EDITED = '987000000';
/** Пара счетов торгового дома для формы: заполняется после подключения к базе. */
let formAccounts = null;

/**
 * Поля формы — наши `CustomSelect` и `CustomDatePicker`, а не родные контролы,
 * поэтому `selectOption` к ним неприменим: триггер — `button` с `aria-label`,
 * список — `role="listbox"`, нарисованный в конце `body`.
 */
const formField = (page, ariaLabel) =>
  page
    .locator('form')
    .first()
    .getByRole('button', { name: ariaLabel, exact: true })
    .first();

/**
 * Календарь: тот же приём, но список у него не `listbox`, а сетка дней. Признак
 * раскрытия — шапка недели: она есть только внутри календаря.
 */
async function openCalendar(page, at, ariaLabel) {
  const trigger = formField(page, ariaLabel);
  if ((await trigger.count()) === 0) {
    errors.push(`[${at}] в форме нет поля «${ariaLabel}»`);
    return false;
  }
  await trigger.click();
  const monday = page.getByText('Пн', { exact: true }).first();
  try {
    await monday.waitFor({ state: 'visible', timeout: 4000 });
  } catch {
    errors.push(`[${at}] «${ariaLabel}»: календарь не раскрылся`);
    return false;
  }
  return true;
}
async function openMenu(page, at, ariaLabel) {
  // Искать поле по всей странице нельзя: у журнала есть столбцы с теми же
  // именами («Дата», «Счёт»), и клик уходил в сортировку, а проверка при этом
  // оставалась зелёной — снимок показывал журнал вместо раскрытого списка.
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

/** Тексты пунктов списка. Список закрывается: он нужен был только на просмотр. */
async function optionTexts(page, at, ariaLabel) {
  const menu = await openMenu(page, at, ariaLabel);
  if (!menu) return [];
  // Тексты снимаем одним вызовом: справочник мог догрузиться, и перебор по
  // одному пункту напоролся бы на перерисованный список.
  const texts = (await menu.locator('button').allInnerTexts()).map((t) =>
    t.replace(/\s+/g, ' ').trim(),
  );
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  return texts;
}

/** Выбор пункта по предикату на его тексте. */
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
  // Что в списке было — важнее самого отказа: пустой список и список не той
  // компании ломаются одинаково, а чинятся по-разному.
  errors.push(
    `[${at}] в списке «${ariaLabel}» нет пункта ${what}; есть: ` +
      (seen.length ? seen.slice(0, 4).join(' | ') : 'ничего'),
  );
  return false;
}

/**
 * Круг по бюджету (ТЗ 6.6): завести, поправить, удалить — кнопками на экране.
 *
 * Проверяется база, а не текст в панели: экран мог бы нарисовать новый план и
 * без запроса. Период берём в следующем году — на текущие месяцы бюджеты уже
 * посеяны, и второй на ту же статью сервер отклонит по делу.
 */
async function runBudgetCircle(page, at, tag, theme) {
  const click = async (name) => {
    const b = page.getByRole('button', { name }).first();
    if ((await b.count()) === 0) {
      errors.push(`[${at}] нет кнопки «${name}»`);
      return false;
    }
    await b.click();
    await page.waitForTimeout(1800);
    return true;
  };

  // Панель могла остаться на выбранном бюджете: форму заведения открывает
  // «Новый», другого способа нет — кнопки «новый бюджет» на экране не держим.
  const fresh = page.getByRole('button', { name: /^Новый$/ }).first();
  if ((await fresh.count()) > 0) {
    await fresh.click();
    await page.waitForTimeout(800);
  }

  const amount = page.getByRole('textbox', { name: 'Сумма плана', exact: true }).first();
  if ((await amount.count()) === 0) {
    errors.push(`[${at}] правая панель не показывает форму нового бюджета`);
    return;
  }

  const year = new Date().getFullYear() + 1;
  const want = `Декабрь ${year}`;
  const notEmpty = (t) => t.length > 0 && !/^выберите$/i.test(t);
  if (!(await chooseOption(page, at, 'Статья расхода', notEmpty, 'статья расхода'))) return;
  if (!(await chooseOption(page, at, 'Период', (t) => t === want, `«${want}»`))) return;
  await amount.fill(BUDGET_AMOUNT);
  await page.getByRole('textbox', { name: 'Порог предупреждения', exact: true }).first().fill('90');
  await page.screenshot({ path: `${OUT}/finance-budget-form-${tag}-${theme}.png` });

  if (!(await click(/^Сохранить$/))) return;

  const made = await db.query(
    `SELECT b.uid, b.amount_planned::text AS amount, b.threshold_warn_percent::text AS th,
            to_char(b.period_start, 'YYYY-MM-DD') AS starts,
            to_char(b.period_end, 'YYYY-MM-DD') AS ends
       FROM budget b
      WHERE b.period_start = $1::date
      ORDER BY b.id DESC LIMIT 1`,
    [`${year}-12-01`],
  );
  if (made.rowCount === 0) {
    const panel = await page
      .locator('form')
      .first()
      .innerText()
      .catch(() => '');
    errors.push(
      `[${at}] форма не завела бюджет на ${want}; на экране: ` +
        panel.replace(/\s+/g, ' ').slice(-200),
    );
    return;
  }
  const budget = made.rows[0];
  createdBudgets.push(budget.uid);
  notes.push(
    `[${at}] форма завела бюджет ${budget.starts}…${budget.ends} ` +
      `план ${budget.amount} порог ${budget.th}`,
  );
  if (Number(budget.amount) !== Number(BUDGET_AMOUNT)) {
    errors.push(`[${at}] план записан как ${budget.amount}, ждали ${BUDGET_AMOUNT}`);
  }
  if (budget.ends !== `${year}-12-31`) {
    errors.push(`[${at}] период бюджета кончается ${budget.ends}, а декабрь — ${year}-12-31`);
  }
  if (Number(budget.th) !== 90) {
    errors.push(`[${at}] порог записан как ${budget.th}, ждали 90`);
  }

  // Строка обязана появиться в план-факте: завели — значит видно.
  const table = await page
    .locator('table')
    .first()
    .innerText()
    .catch(() => '');
  if (!table.includes(`${year}-12`)) {
    errors.push(`[${at}] заведённого бюджета нет в план-факте: ${year}-12 в таблице не найден`);
  }

  // Правка: форма после сохранения стоит на созданном бюджете.
  const planField = page.getByRole('textbox', { name: 'Сумма плана', exact: true }).first();
  if ((await planField.count()) === 0) {
    errors.push(`[${at}] после заведения панель не открыла бюджет на правку`);
    return;
  }
  await planField.fill(BUDGET_EDITED);
  if (!(await click(/^Сохранить$/))) return;
  const after = await db.query(`SELECT amount_planned::text AS amount FROM budget WHERE uid = $1`, [
    budget.uid,
  ]);
  notes.push(`[${at}] правка плана: ${budget.amount} → ${after.rows[0]?.amount ?? '(нет строки)'}`);
  if (Number(after.rows[0]?.amount) !== Number(BUDGET_EDITED)) {
    errors.push(
      `[${at}] правка не дошла до базы: в базе ${after.rows[0]?.amount}, ждали ${BUDGET_EDITED}`,
    );
  }

  // Удаление: план исчезает, факт остаётся в операциях — его бюджет не держит.
  if (!(await click(/^Удалить$/))) return;
  const gone = await db.query(`SELECT count(*)::int AS n FROM budget WHERE uid = $1`, [budget.uid]);
  if (gone.rows[0].n !== 0) {
    errors.push(`[${at}] кнопка «Удалить» не удалила бюджет из базы`);
  } else {
    notes.push(`[${at}] бюджет удалён кнопкой`);
  }
  const log = await db.query(
    `SELECT action FROM audit_log WHERE entity_type = 'budget' AND entity_id = $1 ORDER BY id`,
    [budget.uid],
  );
  const actions = log.rows.map((r) => r.action).join(',');
  notes.push(`[${at}] журнал по бюджету: ${actions || '(пусто)'}`);
  for (const need of ['create', 'update', 'delete']) {
    if (!actions.includes(need)) {
      errors.push(`[${at}] в журнале действий нет записи «${need}» по бюджету`);
    }
  }
}

/**
 * Приводит правую панель к форме заведения.
 *
 * Кнопки «Новая операция» на экране нет по требованию заказчика: форма и есть
 * состояние покоя панели. Значит открыть её нечем — можно только закрыть
 * карточку, если в панели сейчас открыта операция.
 */
async function openCreateForm(page, at) {
  const stray = page.getByRole('button', { name: /Новая операция/ });
  if ((await stray.count()) > 0) {
    errors.push(`[${at}] кнопка «Новая операция» вернулась: её убрали сознательно`);
  }

  const closeCard = page.getByRole('button', { name: 'Закрыть карточку', exact: true }).first();
  if ((await closeCard.count()) > 0) {
    await closeCard.click();
    await page.waitForTimeout(1000);
  }

  const amount = page.getByRole('textbox', { name: 'Сумма', exact: true }).first();
  if ((await amount.count()) === 0) {
    errors.push(`[${at}] правая панель не показывает форму заведения операции`);
    return false;
  }
  return true;
}

/** Сальдо счёта по коду в торговом доме: сумма проводок, а не хранимое поле. */
async function saldo(code) {
  const r = await db.query(
    `SELECT coalesce(sum(e.debit - e.credit), 0)::text AS s
       FROM finance_entry e
       JOIN account a ON a.id = e.account_id
       JOIN company c ON c.id = a.company_id
      WHERE c.code = 'trade' AND a.code = $1`,
    [code],
  );
  return Number(r.rows[0].s);
}

/**
 * Строка подключения для отката. Берём из .env бэкенда владельческой ролью:
 * роль приложения под RLS, а откат идёт вне контекста компании.
 */
function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const env = fs.readFileSync(path.join(BACKEND, '.env'), 'utf8');
  const hit = env.match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
  if (!hit) throw new Error('DATABASE_URL не найден ни в окружении, ни в backend/.env');
  return hit[1];
}

/**
 * Полный круг записи через интерфейс: форма → черновик → согласование →
 * проведение → сторно.
 *
 * Проверяется не текст на экране, а строки в базе: экран мог бы нарисовать
 * новый статус и без запроса. Главное число здесь — сальдо счёта: после сторно
 * оно обязано вернуться ровно к тому, что было до проведения. Всё заведённое
 * прогон сносит в `finally`.
 */
/**
 * Справочники формы под «Сводным холдингом».
 *
 * Пока в шапке выбрана одна компания, браузер шлёт `X-Company-Id`, и сервер
 * сужает справочник сам — дублей не видно. На «Сводном холдинге» заголовка нет,
 * приходят обе книги разом, и строки в списке становятся неразличимы: счёт 5010
 * есть в каждой компании, «Заработная плата» — тоже. Человек выбирает строку
 * чужой книги, а отказ получает на сохранении: 422 «Статья ДДС не найдена».
 * Отказ за выбор из списка, который ему сами и выдали.
 *
 * Поэтому проверка живёт отдельным шагом и именно на «Сводном холдинге»: в
 * обычном режиме она зелёная всегда и ничего не сторожит.
 */
async function checkRefsScope(page, at) {
  const pick = async (name) => {
    await page.locator('aside button').first().click();
    await page.waitForTimeout(400);
    const item = page.getByRole('button', { name }).first();
    if ((await item.count()) === 0) {
      errors.push(`[${at}] в переключателе компаний нет пункта ${name}`);
      return false;
    }
    await item.click();
    await page.waitForTimeout(1200);
    return true;
  };

  // Пункты переключателя названы так же, как юрлица в уставе: «Сводный
  // холдинг» и «Торговый дом» были именами из макета, а не компаниями.
  if (!(await pick(/Обе компании/))) return;

  if (!(await openCreateForm(page, `${at} сводный`))) {
    await pick(/ООО «Металл Азия»/);
    return;
  }

  for (const label of ['Счёт', 'Статья ДДС', 'Контрагент']) {
    const opts = await optionTexts(page, at, label);
    // Пункты-подсказки («выберите», «не указана», «не менять») в счёт не идут:
    // они по смыслу одни и те же в каждом списке.
    const real = opts
      .map((t) => t.trim())
      .filter((t) => t && !/^(выберите|не указан|не менять)/i.test(t));
    const twice = [...new Set(real.filter((t, i) => real.indexOf(t) !== i))];
    if (twice.length) {
      errors.push(
        `[${at}] «${label}» на сводном холдинге показывает обе компании: ` +
          `повторяются ${twice.slice(0, 3).join(', ')}`,
      );
    }
    if (real.length === 0) {
      errors.push(`[${at}] «${label}» на сводном холдинге пуст: выбрать нечего`);
    }
  }

  await pick(/ООО «Металл Азия»/);
}

async function runWriteCircle(page, at, tag, theme) {
  const click = async (name) => {
    const b = page.getByRole('button', { name }).first();
    if ((await b.count()) === 0) {
      errors.push(`[${at}] нет кнопки «${name}»`);
      return false;
    }
    await b.click();
    await page.waitForTimeout(1800);
    return true;
  };

  if (!(await openCreateForm(page, at))) return;

  // Код счёта в пункте списка стоит отдельной пометкой, поэтому сверяем его как
  // отдельное слово: иначе «5010» нашлось бы внутри «50100».
  const byCode = (code) => (text) => new RegExp(`(^|\\s)${code}(\\s|$)`).test(text);
  if (!(await chooseOption(page, at, 'Счёт', byCode(formAccounts.account), formAccounts.account)))
    return;
  if (
    !(await chooseOption(
      page,
      at,
      'Корреспондент',
      byCode(formAccounts.counter),
      formAccounts.counter,
    ))
  )
    return;
  await page.getByRole('textbox', { name: 'Сумма', exact: true }).fill(NEW_AMOUNT);
  await page.screenshot({ path: `${OUT}/finance-form-${tag}-${theme}.png` });

  if (!(await click(/^Сохранить$/))) return;

  const made = await db.query(
    `SELECT uid, number, status::text AS status, version
       FROM finance_operation
      WHERE amount = $1::numeric AND reversal_of_id IS NULL
      ORDER BY id DESC LIMIT 1`,
    [NEW_AMOUNT],
  );
  if (made.rowCount === 0) {
    // Текст отказа берём с экрана: без него «не завела» не говорит, что чинить.
    const panel = await page
      .locator('form')
      .first()
      .innerText()
      .catch(() => '');
    errors.push(
      `[${at}] форма не завела операцию на ${NEW_AMOUNT}; на экране: ` +
        panel.replace(/\s+/g, ' ').slice(-200),
    );
    return;
  }
  const fresh = made.rows[0];
  createdUids.push(fresh.uid);
  notes.push(`[${at}] форма завела ${fresh.number} ${fresh.status} v${fresh.version}`);
  if (fresh.status !== 'draft') {
    errors.push(`[${at}] новая операция пришла в статусе ${fresh.status}, ждали draft`);
  }

  const before = await saldo(formAccounts.account);

  if (!(await click(/^На согласование$/))) return;
  if (!(await click(/^Утвердить$/))) return;
  if (!(await click(/^Провести$/))) return;

  const posted = await db.query(
    `SELECT status::text AS status,
            (SELECT count(*)::int FROM finance_entry e WHERE e.operation_id = o.id) AS n
       FROM finance_operation o WHERE o.uid = $1`,
    [fresh.uid],
  );
  notes.push(`[${at}] после проведения: ${posted.rows[0].status}, проводок ${posted.rows[0].n}`);
  if (posted.rows[0].status !== 'posted' || posted.rows[0].n !== 2) {
    errors.push(
      `[${at}] проведение через экран не дало проводок: ` +
        `${posted.rows[0].status}, проводок ${posted.rows[0].n}`,
    );
    return;
  }

  // Сторно в два нажатия: первое спрашивает причину, второе выполняет.
  if (!(await click(/^Сторно$/))) return;
  await page.screenshot({ path: `${OUT}/finance-reverse-confirm-${tag}-${theme}.png` });
  if (!(await click(/^Подтвердить сторно$/))) return;

  const mirror = await db.query(
    `SELECT o.uid, o.number, o.status::text AS status,
            (SELECT count(*)::int FROM finance_entry e WHERE e.operation_id = o.id) AS n
       FROM finance_operation o
      WHERE o.reversal_of_id = (SELECT id FROM finance_operation WHERE uid = $1)`,
    [fresh.uid],
  );
  if (mirror.rowCount === 0) {
    errors.push(`[${at}] сторно не создано`);
    return;
  }
  createdUids.push(mirror.rows[0].uid);

  const origin = await db.query(
    `SELECT status::text AS status FROM finance_operation WHERE uid = $1`,
    [fresh.uid],
  );
  const after = await saldo(formAccounts.account);
  notes.push(
    `[${at}] сторно ${mirror.rows[0].number}: проводок ${mirror.rows[0].n}, ` +
      `оригинал ${origin.rows[0].status}, сальдо ${before} → ${after}`,
  );
  if (origin.rows[0].status !== 'reversed') {
    errors.push(`[${at}] оригинал после сторно в статусе ${origin.rows[0].status}, ждали reversed`);
  }
  if (mirror.rows[0].n !== 2) {
    errors.push(`[${at}] у сторно ${mirror.rows[0].n} проводок, ждали 2`);
  }
  if (Math.abs(after - before) > 0.01) {
    errors.push(`[${at}] сальдо ${formAccounts.account} не вернулось: ${before} → ${after}`);
  }
}

async function waitForApi(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // 401 тоже годится: значит процесс слушает и маршруты подняты.
      const r = await fetch(`${API}/finance/summary?period=7d`);
      if (r.status > 0) return r.status;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error('бэкенд не поднялся за отведённое время');
}

/** Полоска разделов: её размер и собственная прокрутка. */
async function tabsBox(page) {
  return page
    .getByRole('group', { name: /Разделы финансов|Moliya bo/i })
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
 * У карточки `overflow-hidden`, поэтому вылезшие фильтры не двигают `main` и
 * обычным замером не ловятся — их просто срезает по краю.
 */
async function headerFits(page) {
  return page
    .getByRole('group', { name: /Разделы финансов|Moliya bo/i })
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
          out.push(
            `${el.tagName.toLowerCase()}${
              el.getAttribute('aria-label') ? `[${el.getAttribute('aria-label')}]` : ''
            } +${over}px`,
          );
        }
      }
      return out;
    });
}

/**
 * Список целиком внутри карточки.
 *
 * Та же ловушка, что с шапкой: карточка режет вылезшее своим `overflow-hidden`,
 * и таблица план-факта шире карточки не двигает `main` — её просто обрезает по
 * краю, молча. Элементы внутри собственного горизонтального скроллера не в
 * счёт: они прокручиваются, а не теряются.
 */
async function listFits(page) {
  return page
    .getByRole('group', { name: /Разделы финансов|Moliya bo/i })
    .first()
    .evaluate((tabs) => {
      const card = tabs.parentElement?.parentElement;
      const list = card?.querySelector('div[class*="overflow-y-auto"]');
      if (!card || !list) return [];
      const edge = card.getBoundingClientRect().right;
      const out = [];
      for (const el of list.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0) continue;
        const over = Math.round(r.right - edge);
        if (over <= 0) continue;
        const scroller = el.closest('[class*="overflow-x-auto"]');
        if (scroller && scroller !== el) continue;
        out.push(`${el.tagName.toLowerCase()} +${over}px`);
        if (out.length >= 3) break;
      }
      return out;
    });
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
          `${el.tagName.toLowerCase()}.${String(el.className).split(' ').slice(0, 3).join('.')} +${Math.round(
            r.right - right,
          )}px`,
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
  console.log(`бэкенд отвечает, /finance/summary без токена → ${status}`);

  db = new Client({ connectionString: databaseUrl() });
  await db.connect();
  const draft = await db.query(
    `SELECT uid, number, status::text AS status, version
       FROM finance_operation
      WHERE status = 'draft'
      ORDER BY id
      LIMIT 1`,
  );
  if (draft.rowCount === 0) {
    throw new Error('в базе нет черновика: отправку на согласование проверять не на чем');
  }
  victim = draft.rows[0];
  console.log(`черновик для проверки записи: ${victim.number} (версия ${victim.version})`);

  // Два счёта торгового дома: переключатель компаний по умолчанию стоит на нём,
  // и форма предложит счета именно этой книги.
  const pair = await db.query(
    `SELECT a.code, a.kind::text AS kind
       FROM account a JOIN company c ON c.id = a.company_id
      WHERE c.code = 'trade' AND a.is_active AND a.kind IN ('bank', 'cash', 'payable')
      ORDER BY a.kind, a.code`,
  );
  const bank = pair.rows.find((r) => r.kind === 'bank' || r.kind === 'cash');
  const payable = pair.rows.find((r) => r.kind === 'payable');
  if (!bank || !payable) throw new Error('в торговом доме нет пары счетов для формы');
  formAccounts = { account: bank.code, counter: payable.code };
  console.log(`счета для формы: ${formAccounts.account} → ${formAccounts.counter}`);

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

  for (const [w, h, tag] of [
    [1440, 900, '1440'],
    [360, 780, '360'],
  ]) {
    for (const theme of ['light', 'dark']) {
      const at = `${tag}/${theme}`;
      const ctx = await browser.newContext({ viewport: { width: w, height: h } });
      const page = await ctx.newPage();
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(`[${at}] ${m.text().slice(0, 300)}`);
      });
      page.on('pageerror', (e) => errors.push(`[${at}] PAGEERROR ${e.message.slice(0, 300)}`));
      page.on('response', async (r) => {
        if (r.url().includes('/finance/') && r.status() >= 400) {
          // Тело отказа важнее кода: 422 бывает и про счёт, и про компанию,
          // и про статью, а по одному номеру их не различить.
          const body = await r.text().catch(() => '');
          const sent = r.request().postData() ?? '';
          const co = r.request().headers()['x-company-id'] ?? '(нет)';
          errors.push(
            `[${at}] ${r.status()} ${new URL(r.url()).pathname} ${body.replace(/\s+/g, ' ').slice(0, 160)}` +
              ` | X-Company-Id=${co} | тело=${sent.slice(0, 200)}`,
          );
        }
      });
      await page.addInitScript((t) => localStorage.setItem('metall_theme', t), theme);

      await page.goto('http://127.0.0.1:4321/', { waitUntil: 'networkidle' });
      await page.waitForTimeout(300);

      await page.locator('input[autocomplete="username"]').first().fill(LOGIN);
      await page.locator('input[autocomplete="current-password"]').first().fill(PASSWORD);
      await page.getByRole('button', { name: 'Войти' }).click();
      await page.waitForSelector('text=/Выручка|Tushum/', { state: 'attached', timeout: 15000 });

      await page.getByRole('button', { name: 'Финансы', exact: true }).first().click();
      await page.waitForTimeout(1500);

      // Шапка: чистый поток должен быть числом, а не прочерком.
      const headline = (await page.locator('text=чистый поток').count())
        ? await page
            .locator('text=чистый поток')
            .first()
            .evaluate((el) => el.parentElement?.textContent ?? '')
        : '';
      notes.push(`[${at}] шапка графика: ${headline.trim().slice(0, 80) || '(не найдена)'}`);
      if (!/\d/.test(headline)) {
        errors.push(`[${at}] чистый поток не отрисовался: «${headline.trim()}»`);
      }

      // Остатки: карточка справа должна показать сумму, а не прочерк.
      const balance = (await page.locator('text=Остатки на счетах').count())
        ? await page
            .locator('text=Остатки на счетах')
            .first()
            .evaluate((el) => el.closest('div[class*="lg:col-span-4"]')?.textContent ?? '')
        : '';
      notes.push(`[${at}] остатки: ${balance.trim().slice(0, 120) || '(не найдены)'}`);
      if (!/\d/.test(balance)) {
        errors.push(`[${at}] остатки на счетах не отрисовались`);
      }

      // Панелька курсов (ТЗ 6.1-6.3): официальный курс на сегодня, время
      // проверки и кнопка загрузки. Без неё непонятно, по какому курсу
      // посчитается валютная операция, которую сейчас заведут.
      const strip = (await page.locator('text=Курс ЦБ РУз').count())
        ? await page
            .locator('text=Курс ЦБ РУз')
            .first()
            .evaluate((el) => el.closest('div[class*="flex-col"]')?.textContent ?? '')
        : '';
      notes.push(`[${at}] курсы: ${strip.trim().slice(0, 160) || '(панель не найдена)'}`);
      if (!strip) {
        errors.push(`[${at}] панели с курсом ЦБ РУз на экране нет`);
      } else {
        if (!/USD/.test(strip)) errors.push(`[${at}] в панели курсов нет доллара`);
        if (!/\d[\d\s]*,\d/.test(strip)) {
          errors.push(`[${at}] курс в панели не числом: «${strip.trim().slice(0, 80)}»`);
        }
        if (!/проверено \d{2}:\d{2}/.test(strip)) {
          errors.push(`[${at}] панель курсов не говорит, когда курс проверяли`);
        }
      }

      const tabsAtStart = await tabsBox(page);
      notes.push(`[${at}] полоска разделов при открытии: ${tabsAtStart.w}×${tabsAtStart.h}`);
      if (tabsAtStart.scroll > 0) {
        errors.push(`[${at}] полоска разделов прокручивается при открытии: +${tabsAtStart.scroll}px`);
      }

      for (const { key, label } of TABS) {
        await page.getByRole('button', { name: new RegExp(`^${label}`) }).first().click();
        await page.waitForTimeout(1200);

        const box = await tabsBox(page);
        if (box.scroll > 0) {
          errors.push(`[${at}/${key}] в полоске разделов скроллбар: +${box.scroll}px`);
        }
        const outside = await headerFits(page);
        if (outside.length) {
          errors.push(`[${at}/${key}] шапка списка вылезла за карточку: ${outside.join(', ')}`);
        }
        const clipped = await listFits(page);
        if (clipped.length) {
          errors.push(`[${at}/${key}] список обрезан краем карточки: ${clipped.join(', ')}`);
        }
        if (box.w !== tabsAtStart.w || box.h !== tabsAtStart.h) {
          errors.push(
            `[${at}/${key}] полоска разделов изменила размер после выбора вкладки: ` +
              `${tabsAtStart.w}×${tabsAtStart.h} → ${box.w}×${box.h}`,
          );
        }

        const footer = await page
          .locator('text=/Записей:\\s*\\d+/')
          .first()
          .innerText()
          .catch(() => '');
        const count = Number(footer.match(/(\d+)/)?.[1] ?? 0);
        notes.push(`[${at}] ${key}: ${footer.trim() || '(подвал не найден)'}`);
        if (count === 0) errors.push(`[${at}] вкладка «${label}» пуста: ${footer || 'подвала нет'}`);

        // На вкладке операций открываем первую: панель справа обязана показать
        // проводки, иначе двойная запись на экране так и не появилась.
        if (key === 'operations') {
          await page.locator('div[class*="divide-y"] > button').first().click();
          await page.waitForTimeout(1200);
          if ((await page.locator('text=Карточка операции').count()) === 0) {
            errors.push(`[${at}] карточка операции не открылась`);
          }
          const panel = await page
            .locator('text=Карточка операции')
            .first()
            .evaluate((el) => el.closest('div[class*="lg:col-span-4"]')?.textContent ?? '')
            .catch(() => '');
          notes.push(`[${at}] баланс карточки: ${/сходится/.test(panel) ? 'сходится' : 'нет'}`);
          // Первая строка журнала — проведённая операция: у неё проводки есть
          // и дебет обязан сойтись с кредитом.
          if (!/сходится/.test(panel)) {
            errors.push(`[${at}] в карточке операции баланс не сошёлся или проводок нет`);
          }

          // Запись через интерфейс. Находим черновик поиском по номеру,
          // открываем и жмём настоящую кнопку. Проверяем не текст на экране,
          // а строку в базе: экран мог бы нарисовать новый статус и без запроса.
          if (!writeChecked && at === '1440/light') {
            writeChecked = true;
            const box = page.getByRole('textbox', { name: /Поиск операций/i }).first();
            await box.fill(victim.number);
            await page.waitForTimeout(1500);

            const row = page.locator('div[class*="divide-y"] > button').first();
            await row.click();
            await page.waitForTimeout(1200);

            const submit = page.getByRole('button', { name: 'На согласование' }).first();
            if ((await submit.count()) === 0) {
              errors.push(`[${at}] у черновика ${victim.number} нет кнопки «На согласование»`);
            } else {
              await page.screenshot({ path: `${OUT}/finance-draft-actions-${tag}-${theme}.png` });
              await submit.click();
              await page.waitForTimeout(2000);

              const now = await db.query(
                `SELECT status::text AS status, version FROM finance_operation WHERE uid = $1`,
                [victim.uid],
              );
              const got = now.rows[0];
              notes.push(
                `[${at}] запись: ${victim.number} ${victim.status} v${victim.version} → ` +
                  `${got.status} v${got.version}`,
              );
              if (got.status !== 'pending_approval' || got.version !== victim.version + 1) {
                errors.push(
                  `[${at}] кнопка не изменила операцию в базе: ` +
                    `${got.status} v${got.version}, ждали pending_approval v${victim.version + 1}`,
                );
              }
              // Проводок быть не должно: заявка на оплату деньги не двигает.
              const entries = await db.query(
                `SELECT count(*)::int AS n FROM finance_entry
                  WHERE operation_id = (SELECT id FROM finance_operation WHERE uid = $1)`,
                [victim.uid],
              );
              if (entries.rows[0].n !== 0) {
                errors.push(`[${at}] отправка на согласование создала проводки: ${entries.rows[0].n}`);
              }
            }

            await box.fill('');
            await page.waitForTimeout(1200);
            await page.locator('div[class*="divide-y"] > button').first().click();
            await page.waitForTimeout(800);

            await checkRefsScope(page, at);
            await runWriteCircle(page, at, tag, theme);
          }

          // Форму смотрим на каждой ширине и в обеих темах: замер переполнения
          // ниже должен видеть её, а не только журнал. Плюс раскрытый список и
          // календарь — они рисуются поверх страницы, и если их место посчитано
          // неверно, за контейнер выедут именно они.
          if (at !== '1440/light') {
            if (await openCreateForm(page, at)) {
              await page.screenshot({ path: `${OUT}/finance-form-${tag}-${theme}.png` });
              const ovForm = await measure(page);
              overflow.push({ key: `${at}/form`, isDefault: true, ...ovForm });

              if (await openMenu(page, at, 'Счёт')) {
                await page.screenshot({ path: `${OUT}/finance-select-${tag}-${theme}.png` });
                const ovSel = await measure(page);
                overflow.push({ key: `${at}/form-select`, isDefault: true, ...ovSel });
                await page.keyboard.press('Escape');
                await page.waitForTimeout(300);
              }

              if (await openCalendar(page, at, 'Дата')) {
                await page.screenshot({ path: `${OUT}/finance-calendar-${tag}-${theme}.png` });
                const ovCal = await measure(page);
                overflow.push({ key: `${at}/form-calendar`, isDefault: true, ...ovCal });
                await page.keyboard.press('Escape');
                await page.waitForTimeout(300);
              }
            }
          }
        }

        // План-факт: строка адресуема, в панели — её план, факт и отклонение.
        if (key === 'planfact') {
          const row = page.locator('table tbody tr').first();
          if ((await row.count()) === 0) {
            errors.push(`[${at}] в план-факте нет ни одной строки`);
          } else {
            await row.click();
            await page.waitForTimeout(900);
            // Последняя колонка страницы — правая панель второго ряда.
            // Первая — карточка остатков в шапке, и прежняя проверка читала её.
            const panel = await page
              .locator('div[class*="lg:col-span-4"]')
              .last()
              .innerText()
              .catch(() => '');
            notes.push(`[${at}] панель бюджета: ${panel.replace(/\s+/g, ' ').slice(0, 120)}`);
            if (!/Отклонение/.test(panel) || !/Состояние/.test(panel)) {
              errors.push(`[${at}] выбор строки план-факта не открыл бюджет в панели`);
            }
            await page.screenshot({ path: `${OUT}/finance-budget-${tag}-${theme}.png` });
            const ovBudget = await measure(page);
            overflow.push({ key: `${at}/budget`, isDefault: true, ...ovBudget });
          }
          if (at === '1440/light') {
            await runBudgetCircle(page, at, tag, theme);
          }
        }

        await page.screenshot({ path: `${OUT}/finance-${key}-${tag}-${theme}.png`, fullPage: true });

        const ov = await measure(page);
        overflow.push({ key: `${at}/${key}`, isDefault: true, ...ov });

        const body = await page.locator('body').innerText();
        for (const phrase of FICTION) {
          if (body.includes(phrase)) found.push(`[${at}/${key}] «${phrase}»`);
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
  // Откат задетой заявки. Делается и на провале прогона: иначе следующий запуск
  // не найдёт черновика и проверять запись будет не на чем.
  if (db && victim && writeChecked) {
    await db
      .query(
        `UPDATE finance_operation SET status = $2::"FinanceStatus", version = $3 WHERE uid = $1`,
        [victim.uid, victim.status, victim.version],
      )
      .then(() => console.log(`заявка ${victim.number} возвращена в ${victim.status}`))
      .catch((e) => console.error(`откат заявки не прошёл: ${e.message}`));
  }
  // Сначала проводки, потом сами операции, и сторно раньше оригинала:
  // у сторно есть ссылка на операцию, которую оно отменяет.
  if (db && createdUids.length) {
    for (const uid of createdUids) {
      await db
        .query(
          `DELETE FROM finance_entry
            WHERE operation_id = (SELECT id FROM finance_operation WHERE uid = $1)`,
          [uid],
        )
        .catch((e) => console.error(`проводки ${uid} не удалились: ${e.message}`));
    }
    for (const uid of [...createdUids].reverse()) {
      await db
        .query(`DELETE FROM finance_operation WHERE uid = $1`, [uid])
        .catch((e) => console.error(`операция ${uid} не удалилась: ${e.message}`));
    }
    console.log(`удалено операций прогона: ${createdUids.length}`);
  }
  if (db && createdBudgets.length) {
    for (const uid of createdBudgets) {
      await db
        .query(`DELETE FROM budget WHERE uid = $1`, [uid])
        .catch((e) => console.error(`бюджет ${uid} не удалился: ${e.message}`));
      // Запись в журнале остаётся: таблица только для добавления, и это верно —
      // план, по которому спрашивали, не должен исчезать бесследно.
    }
    console.log(`снято бюджетов прогона: ${createdBudgets.length}`);
  }
  if (db) await db.end().catch(() => {});
  if (backend) backend.kill('SIGTERM');
}
