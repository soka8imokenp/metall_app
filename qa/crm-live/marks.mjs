/**
 * Откуда пришёл лид: приём заявки с сайта и метки визита на экране.
 *
 * Прогон идёт тем же путём, что настоящая заявка: берёт ключ сайта с экрана
 * справочников, шлёт заявку в открытый маршрут с метками поиска и смотрит,
 * что в CRM она разложилась по источнику, показывает оба касания и попала в
 * отчёт по меткам.
 *
 * Заявку за собой прогон закрывает отказом: удалять обращения нечем, а висеть
 * в «новых» тестовая заявка не должна.
 */
import { chromium } from 'playwright-core';
const STAND = 'https://metall-asia.cloudplus.uz';
const OUT = new URL('./shots/', import.meta.url).pathname;
const errors = [];
const stamp = Date.now().toString().slice(-7);
const PHONE = `+99890${stamp}`;

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
    const tag = `${theme}/${w}`;

    // 1. Справочники → Приём с сайта: адрес, ключ и правила.
    await page.getByRole('tab', { name: 'Справочники' }).click();
    await page.waitForTimeout(1500);
    const siteTab = page.getByRole('tab', { name: 'Приём с сайта' });
    if (!(await siteTab.count())) {
      errors.push(`${tag}: в справочниках нет раздела «Приём с сайта»`);
      await ctx.close();
      continue;
    }
    await siteTab.click();
    await page.waitForTimeout(2000);
    const siteText = await page.locator('main').innerText();
    if (!/\/api\/v1\/public\/leads/.test(siteText)) {
      errors.push(`${tag}: не показан адрес приёма заявок`);
    }
    const rules = (siteText.match(/→/g) || []).length;
    if (rules < 5) errors.push(`${tag}: правил разбора меток на экране ${rules}`);
    // Ключ ищем за его собственную кнопку копирования, а не по длине текста:
    // прогон угадывал «кнопка, в которой 20+ знаков подряд», и демо-ключ
    // `demo-site-trade` (15 знаков) из посева под это правило не попадал —
    // проверка краснела на рабочем экране.
    const keyBtn = page.locator('button[title="Скопировать ключ"]').first();
    const key = (await keyBtn.count()) ? (await keyBtn.innerText()).trim().split('\n')[0] : null;
    if (!key) errors.push(`${tag}: ключ сайта на экране не найден`);
    if (w === 1440 && theme === 'light') await page.screenshot({ path: `${OUT}/crm-site-intake.png` });

    // 2. Заявка с «сайта»: приходит снаружи, с метками поиска.
    const phone = `${PHONE}${theme === 'light' ? 1 : 2}${w === 1440 ? 1 : 2}`;
    if (key) {
      const res = await page.request.post(`${STAND}/api/v1/public/leads`, {
        headers: { 'Content-Type': 'application/json' },
        data: {
          key,
          name: `QA Заявка с сайта ${stamp}`,
          phone,
          comment: 'Прогон: нужен швеллер 10',
          marks: {
            source: 'google',
            medium: 'organic',
            term: 'швеллер 10 цена',
            landing: 'https://metallasia.uz/shveller',
            referrer: 'https://www.google.com/',
            formCode: 'qa-callback',
            firstAt: '2026-09-01T10:00:00.000Z',
            firstSource: 'google',
            firstMedium: 'organic',
            firstLanding: 'https://metallasia.uz/blog/shveller',
          },
        },
      });
      if (!res.ok()) {
        errors.push(`${tag}: заявку с сайта не приняли (${res.status()})`);
      }
    }

    // 3. Обращения: метки видны и разложены по источнику.
    await page.getByRole('tab', { name: 'Обращения' }).click();
    await page.waitForTimeout(1500);
    await page.getByRole('textbox').first().fill(phone.slice(-7));
    await page.waitForTimeout(2500);
    const body = await page.locator('main').innerText();
    if (!body.includes('Поиск (SEO)')) {
      errors.push(`${tag}: заявка с меткой organic не стала «Поиск (SEO)»`);
    }
    const marksBtn = page.getByRole('button', { name: 'Откуда пришёл' }).first();
    if (!(await marksBtn.count())) {
      errors.push(`${tag}: у обращения нет ссылки «Откуда пришёл»`);
    } else {
      await marksBtn.click();
      await page.waitForTimeout(1000);
      const dlg = page.getByRole('dialog', { name: 'Метки визита' });
      if (!(await dlg.count())) {
        errors.push(`${tag}: окно меток не открылось`);
      } else {
        const t = await dlg.innerText();
        for (const need of [
          'google',
          'organic',
          'швеллер 10 цена',
          'metallasia.uz/shveller',
          'metallasia.uz/blog/shveller',
          'Первый визит',
        ]) {
          if (!t.includes(need)) errors.push(`${tag}: в метках нет «${need}»`);
        }
        // Ответ стоит первым, техника под ним: менеджер читает «Поиск (SEO)»,
        // а не ищет его между utm_source и utm_medium.
        const iSrc = t.indexOf('Поиск (SEO)');
        const iUtm = t.indexOf('utm_source');
        if (iSrc < 0) errors.push(`${tag}: в окне меток не назван источник словами`);
        else if (iUtm >= 0 && iSrc > iUtm)
          errors.push(`${tag}: источник показан после технических меток (${iSrc} > ${iUtm})`);
        // Касания идут по времени: сначала первый визит, потом тот, где оставили заявку.
        const iFirst = t.indexOf('Первый визит');
        const iLast = t.indexOf('Визит с заявкой');
        if (iLast < 0) errors.push(`${tag}: в окне нет касания «Визит с заявкой»`);
        else if (iFirst > iLast) errors.push(`${tag}: первый визит показан после последнего`);
        // Непереданные метки не занимают строк, но названы одной строкой.
        const dashes = (t.match(/—/g) || []).length;
        if (dashes > 1) errors.push(`${tag}: в метках ${dashes} пустых строк с прочерком`);
        if (!/не передано/i.test(t)) errors.push(`${tag}: не сказано, какие метки не передали`);
        // Число склоняется: «30 дней», «31 день», «32 дня». Шаблон «дн» ловил
        // только «дней» — проверка краснела в зависимости от числа месяца.
        if (!/\d+\s*(день|дня|дней|kun)|тот же день|oʻsha kuni/i.test(t))
          errors.push(`${tag}: не сказано, сколько прошло между первым визитом и заявкой`);
        // Адреса страниц — ссылки, а не строка для чтения глазами.
        const links = await dlg.locator('a[href*="metallasia.uz"]').count();
        if (links < 2) errors.push(`${tag}: адреса страниц не ссылки (${links})`);
        // Два касания: на 1440 рядом, на 360 друг под другом.
        const touches = dlg.locator('[data-touch]');
        const nt = await touches.count();
        if (nt !== 2) {
          errors.push(`${tag}: касаний в окне ${nt}, а не 2`);
        } else {
          const a = await touches.nth(0).boundingBox();
          const b = await touches.nth(1).boundingBox();
          if (w === 1440 && !(Math.abs(a.y - b.y) < 4 && b.x > a.x + 20))
            errors.push(`${tag}: на 1440 касания не стоят рядом`);
          if (w === 360 && !(b.y > a.y + 20))
            errors.push(`${tag}: на 360 касания не друг под другом`);
        }
        const box = await dlg.boundingBox();
        if (box.height > h) errors.push(`${tag}: окно меток выше экрана ${Math.round(box.height)}`);
        if (w === 1440 && theme === 'light') await page.screenshot({ path: `${OUT}/crm-lead-marks.png` });
        await dlg.getByRole('button', { name: 'Закрыть метки визита' }).click();
        await page.waitForTimeout(500);
      }
    }

    // 4. Отчёт «Метки сайта».
    await page.getByRole('tab', { name: 'Отчёты' }).click();
    await page.waitForTimeout(1500);
    const marksReport = page.getByRole('button', { name: 'Метки сайта' });
    if (!(await marksReport.count())) {
      errors.push(`${tag}: в отчётах нет вида «Метки сайта»`);
    } else {
      await marksReport.click();
      await page.waitForTimeout(2500);
      const report = await page.locator('main').innerText();
      for (const need of ['organic', 'Обращений (первое)', 'google']) {
        if (!report.includes(need)) errors.push(`${tag}: в отчёте по меткам нет «${need}»`);
      }
      if (w === 1440 && theme === 'light') await page.screenshot({ path: `${OUT}/crm-marks-report.png` });
    }

    // 5. Убираем за собой: заявку закрываем отказом.
    await page.getByRole('tab', { name: 'Обращения' }).click();
    await page.waitForTimeout(1200);
    await page.getByRole('textbox').first().fill(phone.slice(-7));
    await page.waitForTimeout(2200);
    const reject = page.getByRole('button', { name: 'Отказ' }).first();
    if (await reject.count()) {
      await reject.click();
      await page.waitForTimeout(600);
      const reason = page.getByRole('textbox', { name: 'Причина отказа' }).first();
      if (await reason.count()) {
        await reason.fill('QA: проверочная заявка прогона');
        await page.waitForTimeout(300);
        const save = page.getByRole('button', { name: 'Записать отказ' }).first();
        if (await save.count()) {
          await save.click();
          await page.waitForTimeout(1500);
        }
      }
    }

    // 6. Ничего не уехало за край.
    const over = await page.evaluate(() => {
      const d = document.documentElement;
      return { page: d.scrollWidth - d.clientWidth };
    });
    if (over.page) errors.push(`${tag}: экран уезжает вбок +${over.page}px`);
    console.log(`${tag}: ключ ${key ? 'есть' : 'нет'}, правил ${rules}, ошибок консоли ${ce.length}`);
    if (ce.length) errors.push(`${tag}: консоль ${ce[0]}`);
    await ctx.close();
  }
}
await browser.close();
console.log(errors.length ? `--- НЕ ПРОЙДЕН --- ${errors.join(' ;; ')}` : '--- прогон пройден ---');
process.exit(errors.length ? 1 : 0);
