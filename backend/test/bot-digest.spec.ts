/**
 * Числительные в сводке бота. Проверка мелкая, но строку с ней человек видит
 * каждый раз, когда открывает бота: «3 позиций» читается как сбой.
 */
import { describe, expect, it } from 'vitest';
import { pick, plural, stamp, type Line } from '../src/bot/digest.service.js';
import { BLUE, GREEN, mainMenu } from '../src/bot/menu.js';

describe('числительные сводки', () => {
  const pos = (v: number) => `${v} ${plural(v, 'позиция', 'позиции', 'позиций')}`;

  it('согласует слово с числом', () => {
    expect(pos(1)).toBe('1 позиция');
    expect(pos(2)).toBe('2 позиции');
    expect(pos(4)).toBe('4 позиции');
    expect(pos(5)).toBe('5 позиций');
    expect(pos(0)).toBe('0 позиций');
  });

  it('не спотыкается на одиннадцати и двадцати одном', () => {
    expect(pos(11)).toBe('11 позиций');
    expect(pos(12)).toBe('12 позиций');
    expect(pos(14)).toBe('14 позиций');
    expect(pos(21)).toBe('21 позиция');
    expect(pos(22)).toBe('22 позиции');
    expect(pos(111)).toBe('111 позиций');
    expect(pos(101)).toBe('101 позиция');
  });
});

describe('отбор строк сводки', () => {
  const line = (ru: string, severity: Line['severity']): Line => ({ ru, uz: ru, severity });

  it('критичное идёт раньше того, что просто ждёт решения', () => {
    const out = pick([
      line('на согласовании', 'attention'),
      line('просрочена оплата', 'critical'),
      line('ниже минимума', 'attention'),
      line('просрочены этапы', 'critical'),
    ]);
    expect(out.map((l) => l.ru)).toEqual([
      'просрочена оплата',
      'просрочены этапы',
      'на согласовании',
      'ниже минимума',
    ]);
  });

  it('оставляет не больше пяти строк и держит место для цифры дела', () => {
    const many: Line[] = [
      line('a', 'critical'),
      line('b', 'critical'),
      line('c', 'attention'),
      line('d', 'attention'),
      line('e', 'attention'),
      line('f', 'attention'),
      line('продажи', 'info'),
    ];
    const out = pick(many);
    expect(out).toHaveLength(5);
    expect(out[4]!.ru, 'цифру дела вытеснили тревогами').toBe('продажи');
    expect(out.map((l) => l.ru).slice(0, 2)).toEqual(['a', 'b']);
  });

  it('без цифры дела берёт пять тревог', () => {
    const out = pick([
      line('a', 'critical'),
      line('b', 'attention'),
      line('c', 'attention'),
      line('d', 'attention'),
      line('e', 'attention'),
      line('f', 'attention'),
    ]);
    expect(out).toHaveLength(5);
  });

  it('время показа — часы и минуты', () => {
    expect(stamp(new Date('2026-10-02T12:05:00Z'))).toBe('17:05');
    expect(stamp()).toMatch(/^\d{2}:\d{2}$/);
  });
});

describe('цвета кнопок', () => {
  it('разделы синие, «Настройки» зелёная, «Админ» синий', () => {
    const rows = mainMenu(['warehouse.view', 'finance.view', 'admin.users'], false);
    const tiles = rows.slice(0, -1).flat();
    expect(tiles.length).toBeGreaterThan(1);
    for (const b of tiles) {
      expect(b.style, `кнопка «${b.text}» не синяя`).toBe(BLUE);
    }
    const bottom = rows[rows.length - 1]!;
    expect(bottom[0]!.style, 'кнопка настроек не зелёная').toBe(GREEN);
    expect(bottom[0]!.text).toMatch(/Настройки/);
    expect(bottom[1]!.style, 'кнопка админа не синяя').toBe(BLUE);
  });

  it('тематический значок в подписи остался', () => {
    const rows = mainMenu(['warehouse.view', 'finance.view'], false);
    const texts = rows.slice(0, -1).flat().map((b) => b.text);
    expect(texts.join(' '), 'значок раздела потерян').toMatch(/📦 Склад/);
    expect(texts.join(' ')).toMatch(/💵 Финансы/);
  });
});
