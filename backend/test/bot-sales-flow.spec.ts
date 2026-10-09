/**
 * Порядок вопросов в заказе и разбор того, что написал человек.
 *
 * Без базы и без Telegram: это чистые функции, и ошибка в них превращается в
 * неверную цену в обещании клиенту.
 */
import { describe, expect, it } from 'vitest';
import {
  type Flow,
  lineTotal,
  nextStep,
  order,
  parsePrice,
  parseQty,
  prevStep,
} from '../src/bot/sales.flow.js';

const flow = (over: Partial<Flow> = {}): Flow => ({
  kind: 'sales',
  step: 'partner',
  ...over,
});

describe('порядок вопросов', () => {
  it('у одной компании про компанию не спрашивает', () => {
    expect(order(flow(), false)[0]).toBe('partner');
    expect(order(flow(), true)[0]).toBe('company');
  });

  it('про причину цены спрашивает только если цену назвали руками', () => {
    const fromList = order(
      flow({ draft: { itemCode: 'A', itemName: 'A', unit: 't', qty: '1', source: 'list' } }),
      false,
    );
    expect(fromList).not.toContain('priceWhy');

    const byHand = order(
      flow({
        draft: { itemCode: 'A', itemName: 'A', unit: 't', qty: '1', price: '10', source: 'manual' },
      }),
      false,
    );
    expect(byHand).toContain('priceWhy');
    // И причина спрашивается сразу после цены, а не в конце разговора.
    expect(byHand[byHand.indexOf('price') + 1]).toBe('priceWhy');
  });

  it('ведёт от цены к списку позиций и к сроку оплаты', () => {
    expect(nextStep(flow({ step: 'qty' }), false)).toBe('price');
    expect(nextStep(flow({ step: 'price' }), false)).toBe('more');
    // После спецификации — склад: он один на заказ и решает, откуда повезут.
    expect(nextStep(flow({ step: 'more' }), false)).toBe('warehouse');
    expect(nextStep(flow({ step: 'warehouse' }), false)).toBe('due');
    // У компании один склад — вопроса нет вовсе.
    expect(nextStep(flow({ step: 'more', oneWarehouse: true }), false)).toBe('due');
    expect(nextStep(flow({ step: 'due' }), false)).toBe('confirm');
    // Дальше проверки некуда: это последний шаг.
    expect(nextStep(flow({ step: 'confirm' }), false)).toBe('confirm');
  });

  it('назад с первого шага не ведёт', () => {
    expect(prevStep(flow({ step: 'partner' }), false)).toBeNull();
    expect(prevStep(flow({ step: 'qty' }), false)).toBe('item');
  });
});

describe('разбор количества и цены', () => {
  it('принимает запятую, пробелы и дробное', () => {
    expect(parseQty('12,5')).toBe('12.5');
    expect(parseQty('1 200')).toBe('1200');
    expect(parseQty('0,000001')).toBe('0.000001');
  });

  it('не принимает ноль, минус и слова', () => {
    expect(parseQty('0')).toBeNull();
    expect(parseQty('-3')).toBeNull();
    expect(parseQty('три')).toBeNull();
    expect(parseQty('5 тонн')).toBeNull();
  });

  it('цену читает так же, но нулевую не берёт: заказ не подарок', () => {
    expect(parsePrice('1 880 000')).toBe('1880000');
    expect(parsePrice('14500,55')).toBe('14500.55');
    expect(parsePrice('0')).toBeNull();
    expect(parsePrice('500к')).toBeNull();
  });

  it('итог по строке считает количеством на цену', () => {
    expect(lineTotal({ itemCode: 'A', itemName: 'A', unit: 't', qty: '3', price: '1880000' })).toBe(
      5_640_000,
    );
    // Цены ещё нет — итог ноль, а не NaN: этот ноль уезжает на экран.
    expect(lineTotal({ itemCode: 'A', itemName: 'A', unit: 't', qty: '3' })).toBe(0);
  });
});
