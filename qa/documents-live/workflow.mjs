/**
 * Документы Э6 — согласование, редакции и журнал на живом стенде.
 *
 * Сервер закрыт тестами (20 проверок в `documents-workflow.e2e.spec.ts`);
 * здесь смотрим то, чего тест не видит: кнопки маршрута на карточке, запрос
 * причины при возврате, что причина видна тому, кто документ переделывает,
 * что правка утверждённого предупреждает о новой редакции, а прежняя редакция
 * остаётся в архиве и печатается оттуда.
 *
 * Прогон меняет данные стенда и не прячет этого: он берёт документ на
 * согласовании, возвращает его с причиной, снова отправляет, утверждает,
 * правит — и оставляет черновиком с одной прежней редакцией в архиве и
 * записями в журнале. Черновиков на свежем стенде нет: сид кладёт документы
 * уже в маршруте, и начинать приходится с того, что там есть.
 * Удаления документов в API нет и не будет: выданный номер не исчезает.
 * Пересев стенда убирает следы.
 *
 * Права проверяются двумя входами: администратор согласует, менеджер по
 * продажам — нет. Разделение прав это и есть требование ТЗ 7.4 («счёт
 * выписывает менеджер, утверждает не он»), и на экране оно обязано выглядеть
 * не отказом после нажатия, а отсутствием кнопки.
 */
import { execFile } from 'node:child_process';
import { chromium } from 'playwright-core';

const STAND = process.env.STAND_URL ?? 'https://metall-asia.cloudplus.uz';
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

/** Текст DOCX — из `word/document.xml`: сравнивать сами байты нельзя, zip их перемешивает. */
const docxText = (path) =>
  new Promise((resolve, reject) =>
    execFile('unzip', ['-p', path, 'word/document.xml'], { maxBuffer: 8 * 1024 * 1024 }, (e, out) =>
      e ? reject(e) : resolve(out.replace(/<[^>]+>/g, '').replace(/\s+/g, '')),
    ),
  );

const money = (s) =>
  Number(String(s).replace(/[^\d,.-]/g, '').replace(/\s/g, '').replace(',', '.'));

async function login(page, user, password) {
  await page.goto(STAND, { waitUntil: 'networkidle' });
  await page.locator('input[autocomplete="username"]').first().fill(user);
  await page.locator('input[autocomplete="current-password"]').first().fill(password);
  await page.getByRole('button', { name: 'Войти' }).click();
  await page.waitForTimeout(2500);
  await page.getByRole('button', { name: 'Документы', exact: true }).first().click();
  await page.waitForTimeout(2000);
}

/** Открыть документ по номеру через поиск реестра — так же, как это делает человек. */
async function openByNumber(page, number) {
  await page.locator('input[aria-label="Поиск по номеру"]').first().fill(number);
  await page.waitForTimeout(1600);
  const row = page.locator('li button', { hasText: number }).first();
  if (!(await row.count())) return false;
  await row.click();
  await page.waitForTimeout(1800);
  return true;
}

const browser = await chromium.launch({ channel: 'chromium' });

for (const theme of ['light', 'dark']) {
  for (const [w, h] of [[1440, 900], [360, 800]]) {
    const tag = `${theme}/${w}`;
    const ctx = await browser.newContext({
      viewport: { width: w, height: h },
      acceptDownloads: true,
    });
    await ctx.addInitScript((t) => localStorage.setItem('metall_theme', t), theme);
    const page = await ctx.newPage();
    const ce = [];
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      if (/\b(409|422|404)\b/.test(m.text())) return;
      ce.push(m.text().slice(0, 160));
    });
    page.on('pageerror', (e) => ce.push('pageerror: ' + String(e).slice(0, 160)));

    // Падение внутри хода не должно уносить с собой уже найденное: без этого
    // один таймаут прятал весь список расхождений, и чинить приходилось
    // вслепую, по одному за прогон.
    await (async () => {
      try {
    await login(page, 'admin', 'admin');

      // Документ выбирается на самом экране, а не сырым запросом к API.
      // Запрос без заголовка компании отвечает по всему холдингу, а номера у
      // компаний свои: прогон брал «ТТН-26/00007» завода и открывал в реестре
      // торгового дома другой документ с тем же номером.
      await page.getByRole('button', { name: 'Тип документа' }).click();
      await page.waitForTimeout(600);
      await page.getByRole('option', { name: /Счёт на оплату/ }).first().click();
      await page.waitForTimeout(1600);

      // Входим с той ступени, что есть в реестре: прогон каждой темы уводит
      // свой счёт в черновики, и через несколько прогонов на согласовании их
      // не остаётся. Черновик сначала отправляем — маршрут от этого не меняется.
      let entry = null;
      for (const name of [/^На согласовании/, /^Черновик/, /^Возвращён/]) {
        const t = page.getByRole('tab', { name }).first();
        if (await t.count()) {
          entry = name;
          await t.click();
          await page.waitForTimeout(1600);
          break;
        }
      }
      if (!entry) {
        errors.push(`${tag}: в реестре нет счетов ни на согласовании, ни в черновиках`);
        return;
      }

      const firstRow = page.locator('li button').first();
      if (!(await firstRow.count())) {
        errors.push(`${tag}: вкладка «На согласовании» пуста`);
        return;
      }
      const picked = { number: (await firstRow.innerText()).split('\n')[0].trim() };
      await firstRow.click();
      await page.waitForTimeout(2000);

          let card = await page.locator('body').innerText();
    if (!/К списку/.test(card)) {
        errors.push(`${tag}: карточка документа ${picked.number} не открылась`);
        return;
      }
      if (!/Согласование/.test(card)) errors.push(`${tag}: на карточке нет блока «Согласование»`);
    for (const pane of ['Документ', 'Редакции', 'Журнал']) {
      if (!card.includes(pane)) errors.push(`${tag}: на карточке нет раздела «${pane}»`);
    }
    // Черновик и возвращённый доводим до согласования сами.
    if (await page.getByRole('button', { name: 'На согласование', exact: true }).count()) {
      await page.getByRole('button', { name: 'На согласование', exact: true }).click();
      await page.waitForTimeout(1800);
      card = await page.locator('body').innerText();
    }
    if (!/На согласовании/.test(card)) {
      errors.push(`${tag}: документ ${picked.number} не встал на согласование`);
    }
    // Отправлять то, что уже отправлено, нечего: вторая отправка сбросила бы
    // решение согласующего и запутала журнал.
    if (await page.getByRole('button', { name: 'На согласование', exact: true }).count()) {
      errors.push(`${tag}: документу на согласовании снова предлагают «На согласование»`);
    }
    for (const b of ['Утвердить', 'Вернуть']) {
      if (!(await page.getByRole('button', { name: b, exact: true }).count())) {
        errors.push(`${tag}: на согласовании нет кнопки «${b}»`);
      }
    }
    await page.screenshot({ path: `${OUT}workflow-pending-${theme}-${w}.png` });

    // --- возврат: причина спрашивается до отправки -------------------------
    await page.getByRole('button', { name: 'Вернуть', exact: true }).click();
    await page.waitForTimeout(700);
    const dialog = page.getByRole('dialog', { name: 'Вернуть', exact: true });
    if (!(await dialog.count())) {
      errors.push(`${tag}: «Вернуть» не спросила причину`);
    } else {
      if (await dialog.getByRole('button', { name: 'Готово', exact: true }).isEnabled()) {
        errors.push(`${tag}: возврат без причины разрешён — в журнале останется действие без объяснения`);
      }
      const reason = 'проверка Э6: нет печати и подписи';
      await dialog.getByLabel('Причина').fill(reason);
      await dialog.getByRole('button', { name: 'Готово', exact: true }).click();
      await page.waitForTimeout(1800);
      card = await page.locator('body').innerText();
      if (!/Возвращён/.test(card)) errors.push(`${tag}: после возврата статус не стал «Возвращён»`);
      // Причина нужна тому, кто переделывает, и на карточке, а не в журнале.
      if (!card.includes(reason)) {
        errors.push(`${tag}: причина возврата не видна на карточке`);
      }
    }
    await page.screenshot({ path: `${OUT}workflow-returned-${theme}-${w}.png` });

    // --- повторная отправка и утверждение ---------------------------------
    await page.getByRole('button', { name: 'На согласование', exact: true }).click();
    await page.waitForTimeout(1600);
    await page.getByRole('button', { name: 'Утвердить', exact: true }).click();
    await page.waitForTimeout(1800);
    card = await page.locator('body').innerText();
    if (!/Утверждён/.test(card)) errors.push(`${tag}: после утверждения статус не стал «Утверждён»`);
    if (!(await page.getByRole('button', { name: 'Подписан', exact: true }).count())) {
      errors.push(`${tag}: у утверждённого нет отметки «Подписан»`);
    }
    const totalBefore = money(
      (await page.locator('body').innerText()).match(/Сумма\s*\n?\s*([\d\s.,]+)\s*(?:UZS|USD|RUB)/)?.[1] ?? '0',
    );
    const versionBefore = Number(
      (await page.locator('body').innerText()).match(/Версия\s*\n?\s*(\d+)/)?.[1] ?? '0',
    );
    let o = await overflow(page);
    if (o.scrollers.length || o.page) errors.push(`${tag}: карточка уезжает вбок ${JSON.stringify(o)}`);
    await page.screenshot({ path: `${OUT}workflow-approved-${theme}-${w}.png` });

    // Печать до правки: она закрепляет на документе шаблон, и прежняя редакция
    // уезжает в архив вместе с ним. Без этого шага проверять «редакция
    // остаётся со своими файлами» было бы не на чем.
    const printed = page.waitForEvent('download', { timeout: 60000 }).catch(() => null);
    await page.getByRole('button', { name: 'DOCX', exact: true }).first().click();
    const printedFile = await printed;
    if (!printedFile) {
      errors.push(`${tag}: утверждённый документ не напечатался в DOCX`);
    }

    // --- правка утверждённого: новая редакция ------------------------------
    await page.getByRole('button', { name: 'Править', exact: true }).click();
    await page.waitForTimeout(800);
    const edit = page.getByRole('dialog', { name: 'Правка документа' });
    if (!(await edit.count())) {
      errors.push(`${tag}: «Править» не открыла форму`);
      return;
    }
    const warn = await edit.innerText();
    if (!/новую редакцию/i.test(warn)) {
      errors.push(`${tag}: форма правки не предупреждает, что заведёт новую редакцию`);
    }
    if (!/Табличная часть/.test(warn)) {
      errors.push(`${tag}: в форме правки нет табличной части`);
    }
    o = await overflow(page);
    if (o.scrollers.length || o.page) errors.push(`${tag}: форма правки уезжает вбок ${JSON.stringify(o)}`);
    await page.screenshot({ path: `${OUT}workflow-edit-${theme}-${w}.png` });

    const qty = edit.getByLabel('Количество 1');
    const shown = await qty.inputValue();
    // Поле правит человек, а не база: хвоста нулей в нём быть не должно.
    if (/\.\d*0$/.test(shown)) {
      errors.push(`${tag}: количество в форме правки показано как «${shown}» — хвост нулей из базы`);
    }
    const vat = await edit.getByLabel('НДС 1').inputValue();
    if (/\.\d*0$/.test(vat)) {
      errors.push(`${tag}: ставка НДС в форме правки показана как «${vat}»`);
    }
    // Запятая — то, что на этом экране пишут: всюду вокруг разделитель такой.
    const was = Number(shown.replace(',', '.'));
    await qty.fill(String(was + 1).replace('.', ','));
    await page.waitForTimeout(300);
    await edit.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await page.waitForTimeout(2600);

    card = await page.locator('body').innerText();
    if (await page.getByRole('dialog', { name: 'Правка документа' }).count()) {
      errors.push(`${tag}: форма правки осталась открытой — сохранение не прошло`);
    }
    // Согласующий смотрел не эти цифры: документ обязан вернуться в черновик.
    if (!/Черновик/.test(card)) {
      errors.push(`${tag}: после правки утверждённого статус не вернулся в «Черновик»`);
    }
    const versionAfter = Number(card.match(/Версия\s*\n?\s*(\d+)/)?.[1] ?? '0');
    if (versionAfter !== versionBefore + 1) {
      errors.push(`${tag}: версия ${versionBefore} → ${versionAfter}, ожидалась ${versionBefore + 1}`);
    }
    const totalAfter = money(card.match(/Сумма\s*\n?\s*([\d\s.,]+)\s*(?:UZS|USD|RUB)/)?.[1] ?? '0');
    if (!(totalAfter > totalBefore)) {
      errors.push(`${tag}: количество выросло, а сумма ${totalBefore} → ${totalAfter} не выросла`);
    }
    // Сумма прописью — тот же реквизит: пересчитать цифры и оставить прежние
    // слова значит выдать документ, который сам себе противоречит.
    const words = card.match(/Сумма прописью\s*\n?\s*([^\n]+)/)?.[1] ?? '';
    const kop = words.match(/(\d{2}) тийин/)?.[1];
    const headKop = String(totalAfter.toFixed(2)).split('.')[1];
    if (kop !== undefined && kop !== headKop) {
      errors.push(`${tag}: прописью ${kop} тийин, а в сумме ,${headKop}`);
    }

    // --- архив редакций ----------------------------------------------------
    await page.getByRole('tab', { name: /Редакции/ }).click();
    await page.waitForTimeout(1600);
    const vers = await page.locator('body').innerText();
    if (!new RegExp(`ред\\. ${versionBefore}\\b`).test(vers)) {
      errors.push(`${tag}: прежней редакции ${versionBefore} нет в архиве: ${vers.slice(0, 200)}`);
    }
    if (!/утверждён/i.test(vers)) {
      errors.push(`${tag}: архив не говорит, в каком статусе редакцию застала правка`);
    }
    o = await overflow(page);
    if (o.scrollers.length || o.page) errors.push(`${tag}: редакции уезжают вбок ${JSON.stringify(o)}`);
    await page.screenshot({ path: `${OUT}workflow-versions-${theme}-${w}.png` });

    // Прежняя редакция печатается из архива — иначе «остаётся со своими
    // файлами» это только слова.
    const dl = page.waitForEvent('download', { timeout: 30000 }).catch(() => null);
    await page.locator('li', { hasText: `ред. ${versionBefore}` }).getByRole('button', { name: 'DOCX' })
      .first()
      .click();
    const file = await dl;
    if (!file) {
      errors.push(`${tag}: прежняя редакция не скачалась`);
    } else {
      const path = await file.path();
      if (!/\.docx$/.test(file.suggestedFilename())) {
        errors.push(`${tag}: файл редакции назван «${file.suggestedFilename()}»`);
      }
      // Размером тут ничего не докажешь: форма посева весит около трёх
      // килобайт, и порог пришлось бы гадать. Сравниваем с тем файлом, который
      // напечатали до правки: это та же редакция, и текст обязан совпасть —
      // иначе из архива приходит не та бумага, о которой спорят с клиентом.
      if (path && printedFile) {
        const beforePath = await printedFile.path();
        const [now, was] = await Promise.all([docxText(path), docxText(beforePath)]);
        if (!was.length) {
          errors.push(`${tag}: напечатанный до правки файл пуст — сравнивать не с чем`);
        } else if (now !== was) {
          errors.push(
            `${tag}: из архива пришла не та редакция: текст разошёлся с напечатанным до правки ` +
              `(${was.length} против ${now.length} знаков)`,
          );
        }
      }
    }

    // --- журнал ------------------------------------------------------------
    await page.getByRole('tab', { name: /Журнал/ }).click();
    await page.waitForTimeout(1600);
    const log = await page.locator('body').innerText();
    for (const line of [
      'Отправлен на согласование',
      'Возвращён на доработку',
      'Утверждён',
      'Изменён — заведена новая редакция',
    ]) {
      if (!log.includes(line)) errors.push(`${tag}: в журнале нет записи «${line}»`);
    }
    if (!/нет печати и подписи/.test(log)) {
      errors.push(`${tag}: журнал не сохранил причину возврата`);
    }
    if (!/Табличная часть/.test(log)) {
      errors.push(`${tag}: журнал не отметил правку табличной части`);
    }
    // Деньги в журнале — в том же виде, что и везде: без сырых точек из базы.
    const raw = log.match(/\d{3,}\.\d{2,}/);
    if (raw) errors.push(`${tag}: в журнале сумма сырым числом из базы: ${raw[0]}`);
    o = await overflow(page);
    if (o.scrollers.length || o.page) errors.push(`${tag}: журнал уезжает вбок ${JSON.stringify(o)}`);
    await page.screenshot({ path: `${OUT}workflow-history-${theme}-${w}.png` });

      } catch (e) {
        errors.push(`${tag}: прогон упал: ${String(e).split('\n')[0].slice(0, 200)}`);
      }
    })();

    if (ce.length) errors.push(`${tag}: ошибки в консоли: ${ce.join(' | ')}`);
    await ctx.close();
  }
}

// --- права: менеджер выписывает, но не утверждает ---------------------------
// Пароль демо-учётки с 01.10 известен и постоянен: логин плюс `123` (правило
// держит `backend/test/stand-logins.spec.ts`). Файл с паролем больше не нужен —
// он был нужен, пока сид выдавал случайный пароль на каждый пересев.
const demoPassword = process.env.STAND_SALES_PASSWORD ?? 'sales123';

if (demoPassword) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await login(page, 'sales', demoPassword);

  // Менеджеру нужен документ на согласовании: там и видно, чего он не может.
  const pending = await page.evaluate(async () => {
    const t = JSON.parse(sessionStorage.getItem('metall_session') || '{}')?.token;
    const r = await fetch('/api/v1/documents?status=pending_approval&limit=1', {
      headers: { authorization: `Bearer ${t}` },
    });
    return (await r.json()).data?.rows?.[0]?.number ?? null;
  });

  if (!pending) {
    errors.push('права: на стенде нет документа на согласовании — проверять запрет не на чем');
  } else if (!(await openByNumber(page, pending))) {
    errors.push(`права: документ ${pending} не открылся менеджером`);
  } else {
    for (const b of ['Утвердить', 'Вернуть']) {
      if (await page.getByRole('button', { name: b, exact: true }).count()) {
        errors.push(`права: менеджеру по продажам предлагают «${b}» — он согласует сам свои счёта`);
      }
    }
    // Своё отозвать он может: это не согласование, а отказ от собственного
    // документа. Права на отмену у него есть, и кнопка обязана быть.
    if (!(await page.getByRole('button', { name: 'Отменить', exact: true }).count())) {
      errors.push('права: менеджер не может отменить собственный документ');
    }
    await page.screenshot({ path: `${OUT}workflow-manager-1440.png` });
  }
  await ctx.close();
}

await browser.close();

if (errors.length) {
  console.error('НАШЛОСЬ:\n' + errors.map((e) => '  - ' + e).join('\n'));
  process.exit(1);
}
console.log(
  'ВСЁ ЧИСТО: маршрут проходится с карточки, возврат требует причины и показывает её, ' +
    'правка утверждённого заводит редакцию, прежняя печатается из архива, журнал полон, ' +
    'менеджеру согласование не предлагается',
);
