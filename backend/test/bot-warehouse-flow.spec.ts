/**
 * Устройство разговора о складе: разбор чисел и порядок вопросов.
 *
 * Порядок здесь главное — он непостоянный, и ошибка в нём означает вопрос не по
 * делу: ячейка у выдачи в цех или количество у штучной трубы. Проверяется без
 * базы и без Telegram, поэтому падает ровно на том, что сломали.
 */
import { describe, expect, it } from 'vitest';
import {
  type Flow,
  nextStep,
  order,
  parseCost,
  parseQty,
  prevStep,
} from '../src/bot/warehouse.flow.js';

const flow = (over: Partial<Flow> = {}): Flow =>
  ({ kind: 'wh', step: 'item', type: 'receipt', ...over }) as Flow;

describe('количество и цена из сообщения', () => {
  it('принимает дробное с запятой и разряды пробелами', () => {
    expect(parseQty('12,5')).toBe('12.5');
    expect(parseQty('1 200')).toBe('1200');
    // Столько знаков хранит база: пересчёт подтверждают тем же числом,
    // которое система сама и показывает.
    expect(parseQty('114,526542')).toBe('114.526542');
  });

  it('не принимает ноль, минус и слова', () => {
    expect(parseQty('0')).toBeNull();
    expect(parseQty('-5')).toBeNull();
    expect(parseQty('пять')).toBeNull();
    expect(parseQty('5 тонн')).toBeNull();
  });

  it('цену принимает нулевую: «не знаю» — осознанный ответ', () => {
    expect(parseCost('0')).toBe('0');
    expect(parseCost('8 500 000,25')).toBe('8500000.25');
    expect(parseCost('-1')).toBeNull();
  });
});

describe('порядок вопросов', () => {
  it('у прихода нет склада отправления, у списания — получения', () => {
    const receipt = order(flow({ type: 'receipt' }), false);
    expect(receipt).toContain('toWarehouse');
    expect(receipt, 'у прихода спросили, откуда берём').not.toContain('fromWarehouse');

    const off = order(flow({ type: 'write_off' }), false);
    expect(off).toContain('fromWarehouse');
    expect(off, 'у списания спросили, куда кладём').not.toContain('toWarehouse');
  });

  it('цену спрашивает только приход, причину — списание и излишек', () => {
    expect(order(flow({ type: 'receipt' }), false)).toContain('cost');
    expect(order(flow({ type: 'transfer' }), false)).not.toContain('cost');
    expect(order(flow({ type: 'write_off' }), false)).toContain('reason');
    expect(order(flow({ type: 'surplus' }), false)).toContain('reason');
    expect(order(flow({ type: 'transfer' }), false)).not.toContain('reason');
  });

  it('партию и номер спрашивает сама номенклатура', () => {
    expect(order(flow({ trackBatches: true }), false)).toContain('batch');
    expect(order(flow({ trackBatches: false }), false)).not.toContain('batch');
    const serial = order(flow({ trackSerials: true }), false);
    expect(serial).toContain('serial');
    expect(serial, 'у штучной позиции спросили количество').not.toContain('qty');
  });

  it('ячейку не спрашивает там, где ячеек нет', () => {
    expect(
      order(flow({ type: 'receipt', toCells: false }), false),
      'спросили ячейку на складе без ячеек',
    ).not.toContain('toLocation');
    expect(order(flow({ type: 'receipt', toCells: true }), false)).toContain('toLocation');
  });

  it('шаги идут вперёд и назад, из первого назад некуда', () => {
    const f = flow({ type: 'transfer', step: 'item', trackBatches: false });
    expect(nextStep(f, false)).toBe('qty');
    expect(prevStep(f, false)).toBeNull();
    expect(prevStep({ ...f, step: 'qty' }, false)).toBe('item');
    expect(prevStep({ ...f, step: 'item' }, true)).toBe('company');
  });
});
