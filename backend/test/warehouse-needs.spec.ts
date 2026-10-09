/**
 * Расчёт потребности в закупке числами (ТЗ 5.10).
 *
 * Без базы и без Nest: здесь проверяется сама арифметика — что тревога идёт по
 * доступному, а дозаказ по доступному с планом, и что эти две вещи не
 * перепутаны. Сквозной прогон на живой базе (`warehouse-needs.e2e.spec.ts`)
 * проверяет другое: что в расчёт приходят те числа, которые лежат в базе.
 */
import { describe, expect, it } from 'vitest';
import { calcNeed, isNeeded } from '../src/warehouse/needs.js';

const LEVELS = { minQty: 10, criticalQty: 4 };

describe('потребность в закупке: арифметика', () => {
  it('склад полон — потребности нет', () => {
    const n = calcNeed(LEVELS, { onHand: 12, promised: 0, plannedOut: 0 });
    expect(n.state).toBe('ok');
    expect(n.needQty).toBe(0);
    expect(isNeeded(n)).toBe(false);
  });

  it('резерв съедает запас: тревога идёт по доступному, а не по наличию', () => {
    // На складе двенадцать тонн, одиннадцать обещаны заказам. Физически всё
    // хорошо, обещать больше нечего.
    const n = calcNeed(LEVELS, { onHand: 12, promised: 11, plannedOut: 0 });
    expect(n.available).toBe(1);
    expect(n.state).toBe('critical');
    expect(n.needQty).toBe(9);
  });

  it('уровень «ниже минимума» не путается с критическим', () => {
    const n = calcNeed(LEVELS, { onHand: 6, promised: 0, plannedOut: 0 });
    expect(n.state).toBe('below_min');
    expect(n.needQty).toBe(4);
  });

  it('плановый расход цеха входит в дозаказ, но не в тревогу', () => {
    // Доступно ровно минимум — тревоги нет. Но запущенный заказ выберет три
    // тонны, и без них закупка заказала бы ноль.
    const n = calcNeed(LEVELS, { onHand: 10, promised: 0, plannedOut: 3 });
    expect(n.state).toBe('ok');
    expect(n.projected).toBe(7);
    expect(n.needQty).toBe(3);
    // Тревоги нет, а дозаказ есть — строка обязана попасть в отчёт.
    expect(isNeeded(n)).toBe(true);
  });

  it('дозаказ считается до минимального уровня, а не до критического', () => {
    const n = calcNeed(LEVELS, { onHand: 0, promised: 0, plannedOut: 0 });
    expect(n.needQty).toBe(10);
  });

  it('задан только критический уровень — дозаказ до него', () => {
    const n = calcNeed({ minQty: 0, criticalQty: 4 }, { onHand: 1, promised: 0, plannedOut: 0 });
    expect(n.state).toBe('critical');
    expect(n.needQty).toBe(3);
  });

  it('уровни не заданы — тревоги нет, но минус по доступному виден', () => {
    const none = { minQty: 0, criticalQty: 0 };
    const ok = calcNeed(none, { onHand: 5, promised: 1, plannedOut: 0 });
    expect(ok.state).toBe('ok');
    expect(isNeeded(ok)).toBe(false);

    // Обещано больше, чем лежит: право `sales.order.oversell` это позволяет,
    // и именно такую позицию закупка должна увидеть.
    const oversold = calcNeed(none, { onHand: 5, promised: 8, plannedOut: 0 });
    expect(oversold.available).toBe(-3);
    expect(oversold.state).toBe('ok');
    expect(oversold.needQty).toBe(0);
    expect(isNeeded(oversold)).toBe(true);
  });

  it('доступное на уровне ровно — это ещё не тревога', () => {
    // Шестой знак: уровень 10, доступно 10.000000. Сравнение «меньше» с
    // порогом 1e-9 не должно поднимать тревогу на равенстве.
    const n = calcNeed(LEVELS, { onHand: 10.0000004, promised: 0.0000004, plannedOut: 0 });
    expect(n.available).toBe(10);
    expect(n.state).toBe('ok');
  });

  it('хвостов float в ответе нет', () => {
    const n = calcNeed(LEVELS, { onHand: 0.3, promised: 0.1, plannedOut: 0.1 });
    expect(n.available).toBe(0.2);
    expect(n.projected).toBe(0.1);
    expect(n.needQty).toBe(9.9);
  });
});
