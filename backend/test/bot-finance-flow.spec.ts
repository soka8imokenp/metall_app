/**
 * Разбор ответов человека в мастере финансов.
 *
 * Проверяется то, из-за чего в деньгах появляется неверная цифра: сумма с
 * пробелами, запятая вместо точки, несуществующая дата, дата без года. Это
 * чистые функции, поэтому проверка идёт без базы и без Telegram — и падает
 * ровно на том, что сломали.
 */
import { bullets, fields } from '../src/bot/section.js';
import { fit } from '../src/bot/format.js';
import { describe, expect, it } from 'vitest';
import {
  nextStep,
  order,
  parseAmount,
  parseDay,
  prevStep,
  shiftDay,
  showDay,
  sum,
  today,
} from '../src/bot/finance.flow.js';

describe('сумма из сообщения', () => {
  it('принимает разряды пробелами и запятую как десятичную', () => {
    expect(parseAmount('1 500 000')).toBe('1500000');
    expect(parseAmount('1 500 000')).toBe('1500000');
    expect(parseAmount('250000,50')).toBe('250000.5');
    expect(parseAmount('250000.50')).toBe('250000.5');
  });

  it('не угадывает сокращения и не принимает ноль с минусом', () => {
    // «500к» человек имел в виду пятьсот тысяч, но может и пятьсот. В деньгах
    // догадка дороже вопроса.
    expect(parseAmount('500к')).toBeNull();
    expect(parseAmount('пятьсот тысяч')).toBeNull();
    expect(parseAmount('0')).toBeNull();
    expect(parseAmount('-100')).toBeNull();
    expect(parseAmount('100,555')).toBeNull();
    expect(parseAmount('')).toBeNull();
  });
});

describe('дата из сообщения', () => {
  const now = new Date('2026-10-03T06:00:00Z');

  it('читает день первым и достаёт год, если его не написали', () => {
    expect(parseDay('28.09.2026', now)).toBe('2026-09-28');
    expect(parseDay('28.09.26', now)).toBe('2026-09-28');
    expect(parseDay('28.09', now)).toBe('2026-09-28');
    expect(parseDay('28/09/2026', now)).toBe('2026-09-28');
    expect(parseDay('1-2-2026', now)).toBe('2026-02-01');
  });

  it('не принимает несуществующий день', () => {
    // `new Date(2026, 1, 31)` молча сдвинул бы это на 3 марта, и человек
    // увидел бы в карточке не тот день, который написал.
    expect(parseDay('31.02.2026', now)).toBeNull();
    expect(parseDay('32.01.2026', now)).toBeNull();
    expect(parseDay('28.13.2026', now)).toBeNull();
    expect(parseDay('вчера', now)).toBeNull();
  });

  it('сегодня считает по Ташкенту, а не по часам сервера', () => {
    // Полночь UTC — это уже пять утра следующего дня в Ташкенте.
    expect(today(new Date('2026-10-03T20:00:00Z'))).toBe('2026-10-04');
    expect(shiftDay('2026-10-01', -1)).toBe('2026-09-30');
    expect(showDay('2026-10-03')).toBe('03.10.2026');
  });
});

describe('как выглядит текст экрана', () => {
  /**
   * Перечисление в боте идёт пунктами, а не через запятую: абзац из пяти дел
   * человек в возрасте читает как стену и половину пропускает.
   */
  it('перечисление собирается пунктами', () => {
    expect(bullets(['раз', 'два'])).toBe('• раз\n• два');
  });

  /**
   * Поля карточки — пунктами, но подзаголовок и вложенная строка точку не
   * получают: список внутри списка с двумя точками читается хуже.
   */
  it('поля идут пунктами, подзаголовок и вложенная строка — нет', () => {
    const out = fields(['Сумма: 10', 'Позиции:', '  1. труба']);
    expect(out).toContain('• Сумма: 10');
    expect(out).toContain('\nПозиции:');
    expect(out).toContain('\n  1. труба');
    expect(out.startsWith('<blockquote>')).toBe(true);
  });

  /**
   * Подпись панели Telegram обрезает молча — значит, обрезать и считать
   * потерю должен бот, иначе пропавший хвост никто не найдёт.
   */
  it('подпись укладывается в предел и говорит, сколько не влезло', () => {
    expect(fit('коротко', 100)).toEqual({ text: 'коротко', cut: 0 });
    const long = 'я'.repeat(1200);
    const out = fit(long, 1024);
    expect(out.text.length).toBe(1024);
    expect(out.text.endsWith('…')).toBe(true);
    expect(out.cut, 'не посчитано, сколько знаков потеряно').toBe(1200 - 1023);
  });
});

describe('деньги и порядок вопросов', () => {
  it('сумму показываем разрядами и знаком валюты', () => {
    expect(sum('1500000', 'UZS').replace(/ /g, ' ')).toBe('1 500 000 сум');
    expect(sum('1234.5', 'USD').replace(/ /g, ' ')).toBe('1 234,5 $');
  });

  /**
   * Сум подписан на языке человека: по-русски «сум», по-узбекски «so‘m».
   * Раньше на оба языка стояло одно «сўм» — узбекская кириллица и в русском
   * экране, и в узбекском, который весь остальной латиницей.
   */
  it('сум подписан на языке человека', () => {
    expect(sum('250000', 'UZS', false)).toContain('сум');
    expect(sum('250000', 'UZS', true)).toContain('so‘m');
    expect(sum('250000', 'UZS', true)).not.toContain('сўм');
    // Валюта, которой нет в таблице, остаётся кодом — выдумывать знак нельзя.
    expect(sum('10', 'EUR', true)).toBe('10 EUR');
  });

  it('компанию спрашивает только у того, у кого их несколько', () => {
    expect(order({}, false)[0]).toBe('amount');
    expect(order({}, true)[0]).toBe('company');
    expect(order({}, true).length).toBe(order({}, false).length + 1);
  });

  /**
   * Платёж по заказу: компания, покупатель и валюта заданы заказом, а статья —
   * когда она в компании одна. Лишний вопрос здесь не безобиден: человек,
   * которому бот заменяет систему, читает его как возможность ошибиться.
   */
  it('у платежа по заказу известное не спрашивается', () => {
    const pay = order({ orderUid: 'o-1', itemFixed: true }, true);
    expect(pay).toEqual(['amount', 'account', 'date', 'comment', 'confirm']);
    expect(pay).not.toContain('company');
    expect(pay).not.toContain('partner');
    // Статей несколько — про статью спросить придётся.
    expect(order({ orderUid: 'o-1' }, true)).toContain('item');
  });

  const at = (step: string) => ({ kind: 'fin', type: 'income', step }) as never;

  it('шаги идут вперёд и назад, из первого назад некуда', () => {
    expect(nextStep(at('amount'), false)).toBe('item');
    expect(prevStep(at('item'), false)).toBe('amount');
    expect(prevStep(at('amount'), false)).toBeNull();
    expect(prevStep(at('amount'), true)).toBe('company');
    // Из проверки дальше не уезжаем: следующий экран — уже запись.
    expect(nextStep(at('confirm'), false)).toBe('confirm');
  });

  it('в платеже после суммы сразу счёт, назад из суммы — выход', () => {
    const pay = { kind: 'fin', type: 'income', orderUid: 'o-1', itemFixed: true } as never;
    expect(nextStep({ ...(pay as object), step: 'amount' } as never, true)).toBe('account');
    expect(prevStep({ ...(pay as object), step: 'amount' } as never, true)).toBeNull();
  });
});
