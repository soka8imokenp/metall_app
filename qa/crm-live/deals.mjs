/**
 * CRM → Сделки → Воронка.
 *
 * Проверяем три вещи, которых не было: доска целиком помещается в окно (ни
 * боковой, ни нижней прокрутки страницы), карточка открывается окном, а
 * перенос включается только удержанием — случайный сдвиг не должен писать в
 * историю переход, которого не было.
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
    // Страницу прокручивает не документ, а <main>. Внутренняя прокрутка
    // колонки доски разрешена — она и есть замена прокрутке всей страницы.
    const tallOutside = [];
    document.querySelectorAll('*').forEach((el) => {
      const st = getComputedStyle(el);
      if (!['auto', 'scroll'].includes(st.overflowY)) return;
      if (el.scrollHeight - el.clientHeight <= 1) return;
      if (el.closest('[data-stage]')) return;
      tallOutside.push(`${el.tagName}+${el.scrollHeight - el.clientHeight}`);
    });
    const d = document.documentElement;
    return {
      scrollers: bad,
      page: d.scrollWidth - d.clientWidth,
      tall: Math.max(d.scrollHeight - d.clientHeight, 0),
      tallOutside,
    };
  });
}

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
    await page.getByRole('tab', { name: 'Сделки' }).click();
    await page.waitForTimeout(2500);
    const tag = `${theme}/${w}`;
    const body = await page.locator('body').innerText();

    // 1. Слова. «Выиграли/проиграли» в воронке больше нет — ни в стадиях, ни на кнопках.
    for (const bad of ['Выиграли', 'Проиграли', 'выиграна', 'проиграна', 'Выиграны', 'Проиграны']) {
      if (body.includes(bad)) errors.push(`${tag}: на экране осталось слово «${bad}»`);
    }
    for (const name of ['Новая заявка', 'Квалификация', 'Коммерческое предложение', 'Согласование договора']) {
      if (!body.includes(name)) errors.push(`${tag}: нет стадии «${name}»`);
    }

    // 2. Доска помещается: ни вбок, ни вниз.
    const o = await overflow(page);
    console.log(`${tag}: воронка — скроллеров ${o.scrollers.length}, вбок +${o.page}px, вниз ${o.tallOutside.join(',') || 'нет'}`);
    if (o.scrollers.length || o.page) errors.push(`${tag}: воронка уезжает вбок ${JSON.stringify(o)}`);
    if (o.tallOutside.length) {
      errors.push(`${tag}: страница воронки прокручивается вниз (${o.tallOutside.join(', ')})`);
    }

    // 3. На широком — все колонки компании в один ряд.
    if (w === 1440) {
      const rowTops = await page.evaluate(() => {
        const cols = [...document.querySelectorAll('[data-stage]')];
        return { n: cols.length, tops: [...new Set(cols.map((c) => Math.round(c.getBoundingClientRect().top)))] };
      });
      console.log(`${tag}: колонок ${rowTops.n}, рядов ${rowTops.tops.length}`);
      if (rowTops.n < 5) errors.push(`${tag}: колонок на доске ${rowTops.n}`);
      if (rowTops.tops.length !== 1) errors.push(`${tag}: колонки в ${rowTops.tops.length} ряда, а не в один`);
    }

    await page.screenshot({ path: `${OUT}/crm-board-${theme}-${w}.png` });

    // 3б. Закрытые сделки лежат карточками в своих колонках. Итог без карточек
    // не отвечает на «куда уехала сделка, которую я только что закрыл».
    if (w === 1440) {
      const fin = await page.evaluate(() => {
        const out = [];
        for (const c of document.querySelectorAll('[data-stage]')) {
          const text = c.innerText || '';
          const head = text.split('\n')[0].trim();
          if (!/^(Сделка заключена|Сделка не состоялась)$/.test(head)) continue;
          const m = text.match(/^\s*(\d+)\s+·/m);
          out.push({
            stage: c.dataset.stage,
            head,
            total: m ? Number(m[1]) : 0,
            cards: c.querySelectorAll('li button').length,
            text,
          });
        }
        return out;
      });
      console.log(`${tag}: конечные колонки — ${fin.map((f) => `${f.head}: ${f.cards} из ${f.total}`).join(', ')}`);
      if (fin.length !== 2) errors.push(`${tag}: конечных колонок на доске ${fin.length}, а не 2`);
      for (const f of fin) {
        if (f.total > 0 && f.cards === 0) {
          errors.push(`${tag}: в «${f.head}» ${f.total} сделок, а карточек нет — только итог`);
        }
        if (f.cards > 0 && !/СД-\d+/.test(f.text)) {
          errors.push(`${tag}: карточки в «${f.head}» без номера сделки`);
        }
        if (f.total > f.cards && !/ещё/.test(f.text)) {
          errors.push(`${tag}: в «${f.head}» видно ${f.cards} из ${f.total}, и об этом не сказано`);
        }
      }

      // Карточка закрытой сделки: действий по ней нет, итог виден.
      const withCards = fin.find((f) => f.cards > 0);
      if (!withCards) {
        if (fin.some((f) => f.total > 0)) errors.push(`${tag}: ни одной карточки в конечных колонках`);
      } else {
        const closed = page.locator(`[data-stage="${withCards.stage}"] li button`).first();
        await closed.click();
        await page.waitForTimeout(1200);
        const dlg = page.getByRole('dialog', { name: 'Карточка сделки' });
        if (!(await dlg.count())) {
          errors.push(`${tag}: карточка закрытой сделки не открылась`);
        } else {
          const t = await dlg.innerText();
          if (!/Закрыта\s+\d{2}\.\d{2}\.\d{4}/.test(t)) {
            errors.push(`${tag}: в карточке закрытой сделки не сказано, когда и чем закрыта`);
          }
          for (const bad of ['Заключить сделку', 'Следующая стадия']) {
            if (t.includes(bad)) errors.push(`${tag}: у закрытой сделки предлагается «${bad}»`);
          }
          await dlg.getByRole('button', { name: 'Закрыть карточку сделки' }).click();
          await page.waitForTimeout(400);
        }

        // Закрытую не переносят: удержание на ней не должно начинать перенос.
        if (theme === 'light') {
          const spot = await page.evaluate(
            ([stage]) => {
              const col = document.querySelector(`[data-stage="${stage}"]`);
              const card = col.querySelector('li button');
              const open = [...document.querySelectorAll('[data-stage]')].find(
                (c) => !/^(Сделка заключена|Сделка не состоялась)/.test(c.innerText || ''),
              );
              const cb = card.getBoundingClientRect();
              const ob = open.getBoundingClientRect();
              return {
                number: (card.textContent || '').match(/СД-\d+/)?.[0] ?? '',
                card: { x: cb.x + cb.width / 2, y: cb.y + 14 },
                to: { x: ob.x + ob.width / 2, y: ob.y + ob.height / 2 },
                toStage: open.dataset.stage,
              };
            },
            [withCards.stage],
          );
          await page.mouse.move(spot.card.x, spot.card.y);
          await page.mouse.down();
          await page.waitForTimeout(500);
          await page.mouse.move(spot.to.x, spot.to.y, { steps: 12 });
          const ghost = await page.evaluate(() =>
            [...document.querySelectorAll('div')].some(
              (d) => getComputedStyle(d).position === 'fixed' && /СД-\d+/.test(d.textContent || '') && d.children.length === 0,
            ),
          );
          await page.mouse.up();
          await page.waitForTimeout(1500);
          if (ghost) errors.push(`${tag}: закрытую сделку взяли на перенос`);
          const moved = await page.evaluate(
            ([s, n]) => {
              const col = document.querySelector(`[data-stage="${s}"]`);
              return !!col && (col.textContent || '').includes(n);
            },
            [spot.toStage, spot.number],
          );
          if (moved) errors.push(`${tag}: закрытая сделка ${spot.number} переехала в рабочую стадию`);
          const stray = page.getByRole('dialog');
          if (await stray.count()) {
            await page.keyboard.press('Escape');
            await page.waitForTimeout(300);
          }
        }
      }
    }

    // 4. Карточка сделки открывается нажатием и несёт то, чего нет на доске.
    const firstCard = page.locator('[data-stage] li button').first();
    if (!(await firstCard.count())) {
      errors.push(`${tag}: на доске нет карточек`);
    } else {
      await firstCard.click();
      await page.waitForTimeout(1200);
      const dlg = page.getByRole('dialog', { name: 'Карточка сделки' });
      if (!(await dlg.count())) {
        errors.push(`${tag}: карточка сделки не открылась нажатием`);
      } else {
        const t = await dlg.innerText();
        for (const need of ['Клиент', 'Менеджер', 'Вероятность', 'Путь по стадиям', 'Заключить сделку', 'Сделка не состоялась']) {
          if (!t.includes(need)) errors.push(`${tag}: в карточке сделки нет «${need}»`);
        }
        const box = await dlg.boundingBox();
        if (box.height > h) errors.push(`${tag}: карточка сделки выше экрана ${Math.round(box.height)}`);

        // Путь — лента: точки на оси, дата, автор и сколько дней в стадии.
        const path = await page.evaluate(() => {
          const ol = document.querySelector('[role="dialog"] ol');
          if (!ol) return null;
          const li = [...ol.querySelectorAll('li')];
          const dots = li.filter((x) =>
            [...x.querySelectorAll('span')].some((sp) => {
              const st = getComputedStyle(sp);
              return st.borderRadius.includes('9999') || parseFloat(st.borderRadius) >= 4;
            }),
          );
          // Ось: между точками идёт вертикальная черта, иначе это просто
          // список с кружками.
          const lines = li
            .slice(0, -1)
            .map((x) => {
              const sp = [...x.querySelectorAll(':scope > div:first-child > span')].at(-1);
              return sp ? sp.getBoundingClientRect().height : 0;
            })
            .filter((hh) => hh > 10).length;
          return { rows: li.length, dots: dots.length, lines, text: ol.innerText };
        });
        if (!path) errors.push(`${tag}: путь по стадиям не оформлен лентой`);
        else {
          if (path.dots < path.rows) errors.push(`${tag}: не у каждой стадии пути есть точка на оси`);
          if (path.rows > 1 && path.lines < path.rows - 1) {
            errors.push(`${tag}: точки пути не соединены осью (${path.lines} из ${path.rows - 1})`);
          }
          if (!/\d{2}\.\d{2}\.\d{4}/.test(path.text)) errors.push(`${tag}: в пути нет дат`);
          if (!/дн\./.test(path.text)) errors.push(`${tag}: в пути не видно, сколько дней заняла стадия`);
        }
        if (w === 1440 && theme === 'light') await page.screenshot({ path: `${OUT}/crm-deal-card.png` });

        // 5. Отказ требует причину из справочника.
        await dlg.getByRole('button', { name: 'Сделка не состоялась' }).click();
        await page.waitForTimeout(800);
        const lose = page.getByRole('dialog', { name: 'Сделка не состоялась' });
        if (!(await lose.count())) errors.push(`${tag}: окно отказа не открылось`);
        else {
          const save = lose.getByRole('button', { name: 'Записать отказ' });
          if (!(await save.isDisabled())) errors.push(`${tag}: отказ записывается без причины`);

          // Причина выбрана, слов нет — записывать всё ещё нельзя.
          await lose.getByRole('button', { name: 'Причина отказа' }).click();
          await page.waitForTimeout(400);
          const option = page.getByRole('option').nth(1);
          if (await option.count()) {
            await option.click();
            await page.waitForTimeout(400);
            if (!(await save.isDisabled())) {
              errors.push(`${tag}: отказ записывается без комментария`);
            }
            await lose.getByRole('textbox').first().fill('QA: прогон проверяет комментарий');
            await page.waitForTimeout(300);
            if (await save.isDisabled()) {
              errors.push(`${tag}: отказ не записать и с причиной, и с комментарием`);
            }
          } else {
            errors.push(`${tag}: в окне отказа не раскрылся справочник причин`);
          }
          if (w === 1440 && theme === 'light') await page.screenshot({ path: `${OUT}/crm-lose.png` });
          await lose.getByRole('button', { name: 'Отмена' }).click();
          await page.waitForTimeout(400);
        }
      }
    }

    // 6. Перенос удержанием: быстрый сдвиг не переносит, удержание — переносит.
    if (w === 1440 && theme === 'light') {
      const place = async () => await page.evaluate(() => {
        const cols = [...document.querySelectorAll('[data-stage]')];
        const final = (c) => /^(Сделка заключена|Сделка не состоялась)/.test(c.innerText || '');
        const from = cols.find((c) => !final(c) && c.querySelector('li button'));
        if (!from) return null;
        // Переносим только между рабочими стадиями: бросок в конечную — это
        // закрытие с вопросом об исходе, его проверяет отдельный пункт.
        const to = cols.find((c) => c !== from && !final(c));
        const card = from.querySelector('li button');
        const cb = card.getBoundingClientRect();
        const tb = to.getBoundingClientRect();
        return {
          fromStage: from.dataset.stage,
          toStage: to.dataset.stage,
          number: (card.textContent || '').match(/СД-\d+/)?.[0] ?? '',
          card: { x: cb.x + cb.width / 2, y: cb.y + 14 },
          to: { x: tb.x + tb.width / 2, y: tb.y + tb.height / 2 },
        };
      });

      const inStage = async (stage, number) => await page.evaluate(
        ([s, n]) => {
          const col = document.querySelector(`[data-stage="${s}"]`);
          return !!col && (col.textContent || '').includes(n);
        },
        [stage, number],
      );

      const p1 = await place();
      if (!p1 || !p1.number) {
        errors.push(`${tag}: не нашли карточку для переноса`);
      } else {
        // быстрый сдвиг — не перенос
        await page.mouse.move(p1.card.x, p1.card.y);
        await page.mouse.down();
        await page.waitForTimeout(120);
        await page.mouse.move(p1.to.x, p1.to.y, { steps: 8 });
        await page.mouse.up();
        await page.waitForTimeout(1800);
        if (await inStage(p1.toStage, p1.number)) {
          errors.push(`${tag}: сделка переехала без удержания — случайный сдвиг пишет переход`);
        }
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
        const esc = page.getByRole('dialog', { name: 'Карточка сделки' });
        if (await esc.count()) {
          await esc.getByRole('button', { name: 'Закрыть карточку сделки' }).click();
          await page.waitForTimeout(400);
        }

        // удержание — перенос, и доска подсказывает, куда можно бросить
        const p2 = await place();
        await page.mouse.move(p2.card.x, p2.card.y);
        await page.mouse.down();
        await page.waitForTimeout(500);
        await page.mouse.move(p2.to.x, p2.to.y, { steps: 12 });
        await page.waitForTimeout(300);
        const hint = await page.evaluate(
          ([to]) => {
            const cols = [...document.querySelectorAll('[data-stage]')];
            const hovered = cols.find((c) => c.dataset.stage === to);
            const ghost = [...document.querySelectorAll('div')].some(
              (d) => getComputedStyle(d).position === 'fixed' && /СД-\d+/.test(d.textContent || '') && d.children.length === 0,
            );
            return {
              dashed: cols.filter((c) => getComputedStyle(c).borderStyle === 'dashed').length,
              hovered: hovered ? getComputedStyle(hovered).borderStyle : null,
              ghost,
            };
          },
          [p2.toStage],
        );
        console.log(`${tag}: перенос — пунктирных зон ${hint.dashed}, под курсором ${hint.hovered}, ярлык ${hint.ghost}`);
        if (hint.dashed === 0) errors.push(`${tag}: при переносе не видно, куда можно бросить`);
        if (hint.hovered !== 'solid') errors.push(`${tag}: колонка под курсором не выделена (${hint.hovered})`);
        if (!hint.ghost) errors.push(`${tag}: под курсором нет ярлыка переносимой сделки`);
        if (w === 1440) await page.screenshot({ path: `${OUT}/crm-board-drag.png` });
        await page.mouse.up();
        await page.waitForTimeout(2200);
        if (!(await inStage(p2.toStage, p2.number))) {
          errors.push(`${tag}: сделка ${p2.number} не переехала после удержания`);
        } else {
          // возвращаем на место: доска — живой стенд, а не песочница
          const back = await page.evaluate(
            ([to, n]) => {
              const col = document.querySelector(`[data-stage="${to}"]`);
              const card = [...col.querySelectorAll('li button')].find((b) => (b.textContent || '').includes(n));
              if (!card) return null;
              const b = card.getBoundingClientRect();
              return { x: b.x + b.width / 2, y: b.y + 14 };
            },
            [p2.toStage, p2.number],
          );
          const home = await page.evaluate(
            ([from]) => {
              const col = document.querySelector(`[data-stage="${from}"]`);
              const b = col.getBoundingClientRect();
              return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
            },
            [p2.fromStage],
          );
          if (back) {
            await page.mouse.move(back.x, back.y);
            await page.mouse.down();
            await page.waitForTimeout(500);
            await page.mouse.move(home.x, home.y, { steps: 12 });
            await page.mouse.up();
            await page.waitForTimeout(2000);
          }
        }
      }
    }

    // 6а. Бросок в конечную стадию не закрывает молча, а спрашивает исход.
    if (w === 1440 && theme === 'light') {
      for (const [header, save] of [
        ['Сделка заключена', 'Заключить сделку'],
        ['Сделка не состоялась', 'Записать отказ'],
      ]) {
        const spot = await page.evaluate(
          ([name]) => {
            const cols = [...document.querySelectorAll('[data-stage]')];
            const from = cols.find((c) => c.querySelector('li button'));
            const to = cols.find((c) => (c.innerText || '').startsWith(name));
            if (!from || !to) return null;
            const cb = from.querySelector('li button').getBoundingClientRect();
            const tb = to.getBoundingClientRect();
            return {
              card: { x: cb.x + cb.width / 2, y: cb.y + 14 },
              to: { x: tb.x + tb.width / 2, y: tb.y + tb.height / 2 },
            };
          },
          [header],
        );
        if (!spot) {
          errors.push(`${tag}: не нашли колонку «${header}»`);
          continue;
        }
        await page.mouse.move(spot.card.x, spot.card.y);
        await page.mouse.down();
        await page.waitForTimeout(500);
        await page.mouse.move(spot.to.x, spot.to.y, { steps: 12 });
        await page.waitForTimeout(250);
        await page.mouse.up();
        await page.waitForTimeout(1200);
        const dlg = page.getByRole('dialog', { name: header });
        if (!(await dlg.count())) {
          errors.push(`${tag}: бросок в «${header}» не спросил, чем закончилось`);
        } else {
          const btn = dlg.getByRole('button', { name: save });
          if (!(await btn.isDisabled())) {
            errors.push(`${tag}: «${save}» доступна без комментария`);
          }
          if (header === 'Сделка заключена') {
            await dlg.getByRole('textbox').first().fill('QA: прогон проверяет комментарий');
            await page.waitForTimeout(300);
            if (await btn.isDisabled()) errors.push(`${tag}: «${save}» не включилась с комментарием`);
            await page.screenshot({ path: `${OUT}/crm-win.png` });
          }
          await dlg.getByRole('button', { name: 'Отмена' }).click();
          await page.waitForTimeout(500);
        }
      }
    }

    // 7. Список: то же, что доска, но целиком — и с ним можно работать.
    await page.getByRole('tab', { name: 'Список' }).click();
    await page.waitForTimeout(2500);
    const o3 = await overflow(page);
    console.log(`${tag}: список — скроллеров ${o3.scrollers.length}, вбок +${o3.page}px`);
    if (o3.scrollers.length || o3.page) errors.push(`${tag}: список уезжает вбок ${JSON.stringify(o3)}`);

    // 7а. Строка открывает ту же карточку, что доска.
    const rowBtn = page.getByRole('button', { name: /^Открыть сделку/ }).first();
    if (!(await rowBtn.count())) {
      errors.push(`${tag}: строку списка нельзя открыть — это просто текст`);
    } else {
      await rowBtn.click();
      await page.waitForTimeout(1500);
      const dlg = page.getByRole('dialog', { name: 'Карточка сделки' });
      if (!(await dlg.count())) {
        errors.push(`${tag}: карточка из списка не открылась`);
      } else {
        const t = await dlg.innerText();
        if (!t.includes('Путь по стадиям')) errors.push(`${tag}: из списка открылась неполная карточка`);
        await dlg.getByRole('button', { name: 'Закрыть карточку сделки' }).click();
        await page.waitForTimeout(500);
      }
    }

    // 7б. Фильтры списка. Компания — не здесь: её выбирают в шапке, и в
    // списке фильтр появляется только в холдинге (проверяется ниже).
    for (const name of ['Состояние сделки', 'Менеджер']) {
      if (!(await page.getByRole('button', { name }).count())) {
        errors.push(`${tag}: в списке нет фильтра «${name}»`);
      }
    }

    // 7в. Счётчик показанного и догрузка.
    const counter = (await page.locator('body').innerText()).match(/Показано (\d+) из (\d+)/);
    if (!counter) {
      errors.push(`${tag}: список не говорит, сколько строк показано из скольких`);
    } else {
      const shownN = Number(counter[1]);
      const totalN = Number(counter[2]);
      console.log(`${tag}: список — показано ${shownN} из ${totalN}`);
      if (shownN > totalN) errors.push(`${tag}: показано больше, чем всего (${shownN}/${totalN})`);
      const more = page.getByRole('button', { name: /Показать ещё/ });
      if (shownN < totalN) {
        if (!(await more.count())) {
          errors.push(`${tag}: показано не всё (${shownN} из ${totalN}), а догрузки нет`);
        } else {
          await more.click();
          await page.waitForTimeout(2000);
          const after = (await page.locator('body').innerText()).match(/Показано (\d+) из/);
          if (!after || Number(after[1]) <= shownN) {
            errors.push(`${tag}: догрузка не добавила строк (${shownN} → ${after?.[1]})`);
          }
        }
      } else if (await more.count()) {
        errors.push(`${tag}: показано всё, а кнопка догрузки осталась`);
      }
    }

    // 7г. Сортировка по столбцу и разворот порядка — на широком экране.
    if (w === 1440) {
      const amounts = async () =>
        await page.evaluate(() =>
          [...document.querySelectorAll('table tbody tr')].map((tr) =>
            Number((tr.children[3].textContent || '').replace(/\D/g, '')),
          ),
        );
      const sumHead = page.getByRole('button', { name: 'Сумма' });
      if (!(await sumHead.count())) {
        errors.push(`${tag}: заголовок «Сумма» не сортирует — по нему нечего нажать`);
      } else {
        await sumHead.click();
        await page.waitForTimeout(2000);
        const first = await amounts();
        await sumHead.click();
        await page.waitForTimeout(2000);
        const second = await amounts();
        const sorted = (a) => a.every((v, i) => i === 0 || a[i - 1] >= v);
        const rsorted = (a) => a.every((v, i) => i === 0 || a[i - 1] <= v);
        if (first.length < 2 || second.length < 2) {
          errors.push(`${tag}: в списке меньше двух строк — сортировку не проверить`);
        } else {
          if (!sorted(first) && !rsorted(first)) {
            errors.push(`${tag}: сортировка по сумме не упорядочила столбец`);
          }
          if (sorted(first) === sorted(second) && rsorted(first) === rsorted(second)) {
            errors.push(`${tag}: повторное нажатие по «Сумма» не развернуло порядок`);
          }
        }
      }

      // 7д. У заключённых видна дата закрытия и исход словами.
      await page.getByRole('button', { name: 'Состояние сделки' }).click();
      await page.waitForTimeout(500);
      await page.getByRole('option', { name: 'Заключённые' }).click();
      await page.waitForTimeout(2200);
      const closed = await page.evaluate(() =>
        [...document.querySelectorAll('table tbody tr')].map((tr) => ({
          closed: (tr.children[tr.children.length - 1].textContent || '').trim(),
          outcome: (tr.children[1].querySelector('span')?.textContent || '').trim(),
        })),
      );
      if (!closed.length) {
        errors.push(`${tag}: по фильтру «Заключённые» список пуст`);
      } else {
        if (!closed.every((r) => /\d{2}\.\d{2}\.\d{4}/.test(r.closed))) {
          errors.push(`${tag}: у заключённых сделок в списке нет даты закрытия`);
        }
        if (!closed.some((r) => r.outcome.length > 3)) {
          errors.push(`${tag}: исход словами в списке не виден`);
        }
      }
      if (theme === 'light') await page.screenshot({ path: `${OUT}/crm-deals-list.png` });
      await page.getByRole('button', { name: 'Состояние сделки' }).click();
      await page.waitForTimeout(500);
      await page.getByRole('option', { name: 'Все' }).click();
      await page.waitForTimeout(1800);
    }

    // 7е. Холдинг: список ведёт обе компании — значит, называет их и даёт
    // фильтр. Без этого две «СД-0007» разных компаний не отличить.
    if (w === 1440 && theme === 'light') {
      await page.locator('aside button').first().click();
      await page.waitForTimeout(600);
      const all = page.getByRole('button', { name: /Сводный холдинг/ });
      if (!(await all.count())) {
        errors.push(`${tag}: в переключателе шапки нет холдинга`);
      } else {
        await all.click();
        await page.waitForTimeout(2500);
        const filter = page.getByRole('button', { name: 'Компания' });
        if (!(await filter.count())) {
          errors.push(`${tag}: в холдинге у списка нет фильтра по компании`);
        } else {
          const before = (await page.locator('body').innerText()).match(/Показано \d+ из (\d+)/);
          const marked = await page.evaluate(() =>
            [...document.querySelectorAll('table tbody tr')].every((tr) =>
              (tr.children[0].textContent || '').replace(/^СД-\d+/, '').trim().length > 0,
            ),
          );
          if (!marked) errors.push(`${tag}: в холдинге строки списка не называют компанию`);
          await filter.click();
          await page.waitForTimeout(500);
          await page.getByRole('option').nth(1).click();
          await page.waitForTimeout(2500);
          const after = (await page.locator('body').innerText()).match(/Показано \d+ из (\d+)/);
          console.log(`${tag}: холдинг — всего ${before?.[1]}, по одной компании ${after?.[1]}`);
          if (!after || !before || Number(after[1]) >= Number(before[1])) {
            errors.push(`${tag}: фильтр по компании не сузил список (${before?.[1]} → ${after?.[1]})`);
          }
          await page.screenshot({ path: `${OUT}/crm-deals-holding.png` });
        }
        // возвращаем шапку как было: стенд общий
        await page.locator('aside button').first().click();
        await page.waitForTimeout(600);
        await page.getByRole('button', { name: /Металл Азия|Торговый дом/ }).first().click();
        await page.waitForTimeout(2000);
      }
    }

    const o4 = await overflow(page);
    if (o4.scrollers.length || o4.page) {
      errors.push(`${tag}: список уезжает вбок после работы с ним ${JSON.stringify(o4)}`);
    }
    await page.screenshot({ path: `${OUT}/crm-deals-table-${theme}-${w}.png` });

    console.log(`${tag}: ошибки консоли ${ce.length} ${ce.slice(0, 1).join('')}`);
    if (ce.length) errors.push(`${tag}: консоль ${ce[0]}`);
    await ctx.close();
  }
}
await browser.close();
console.log(errors.length ? `--- НЕ ПРОЙДЕН --- ${errors.join(' ;; ')}` : '--- прогон пройден ---');
process.exit(errors.length ? 1 : 0);
