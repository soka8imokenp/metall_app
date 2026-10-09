/**
 * Кодирование штрихкодов и QR (ТЗ 5.9), чистая часть — без базы и без Nest.
 *
 * Code 128 сверяется с независимой реализацией: `jsbarcode` стоит в
 * devDependencies и в сборку не попадает. Своя таблица символов, совпавшая
 * сама с собой, не доказывает ничего — сверять нужно с чужой.
 */

import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  buildCode,
  code128Bars,
  code128Pattern,
  code128Values,
  luhn,
  parseCode,
  qrMatrix,
  renderSymbol,
} from '../src/warehouse/codes.js';

const require = createRequire(import.meta.url);
const CODE128B = require('jsbarcode/bin/barcodes/CODE128/CODE128B.js').default;
const CODE128C = require('jsbarcode/bin/barcodes/CODE128/CODE128C.js').default;
const CODE128AUTO = require('jsbarcode/bin/barcodes/CODE128/CODE128_AUTO.js').default;

const oracle = (Kind: any, value: string) => {
  const inst = new Kind(value, { ean128: false });
  expect(inst.valid(), `${value}: чужая реализация считает строку негодной`).toBe(true);
  return inst.encode().data as string;
};

describe('код объекта', () => {
  it('собирается и разбирается обратно', () => {
    for (const [kind, id] of [
      ['item', 1n],
      ['batch', 999_999_999n],
      ['serial', 42n],
      ['location', 123_456n],
    ] as const) {
      const code = buildCode(kind, id);
      expect(code).toMatch(/^MA[IBSL]\d{10}$/);
      expect(parseCode(code)).toEqual({ kind, id });
    }
  });

  it('вид объекта входит в контрольную цифру', () => {
    // Одинаковый идентификатор у разных видов — разные коды целиком, а не
    // только одной буквой: сканер, прочитавший букву неверно, получит отказ.
    const item = buildCode('item', 12345n);
    const batch = buildCode('batch', 12345n);
    expect(item.slice(-1)).not.toBe(batch.slice(-1));
    expect(parseCode(`MAB${item.slice(3)}`)).toBeNull();
  });

  it('ловит одну неверную цифру и перестановку соседних', () => {
    const code = buildCode('batch', 20_260_928n);
    const digits = code.slice(3);
    let caughtWrong = 0;
    for (let i = 0; i < digits.length - 1; i += 1) {
      for (let d = 0; d <= 9; d += 1) {
        if (String(d) === digits[i]) continue;
        const broken = `MAB${digits.slice(0, i)}${d}${digits.slice(i + 1)}`;
        if (parseCode(broken) === null) caughtWrong += 1;
      }
    }
    expect(caughtWrong).toBe((digits.length - 1) * 9);

    const swapped = `MAB${digits.slice(0, 2)}${digits[3]}${digits[2]}${digits.slice(4)}`;
    expect(swapped).not.toBe(code);
    expect(parseCode(swapped)).toBeNull();
  });

  it('чужие строки не выдаёт за свои', () => {
    for (const raw of ['', 'SN-530-2026-0001', 'PPU-530-710', '4600000000012', 'MAX0000001234']) {
      expect(parseCode(raw)).toBeNull();
    }
  });

  it('не зависит от регистра и пробелов', () => {
    const code = buildCode('serial', 7n);
    expect(parseCode(`  ${code.toLowerCase()} `)).toEqual({ kind: 'serial', id: 7n });
  });

  it('контрольная цифра Луна считается как положено', () => {
    // Классический пример: 7992739871 → 3.
    expect(luhn('7992739871')).toBe(3);
  });
});

describe('Code 128', () => {
  it('контрольный символ считается по ISO/IEC 15417', () => {
    // Пример из описания стандарта: PJJ123C в наборе A даёт 54.
    const values = [103, 48, 42, 42, 17, 18, 19, 35];
    const sum = values.reduce((acc, v, i) => acc + v * (i === 0 ? 1 : i), 0);
    expect(sum).toBe(878);
    expect(sum % 103).toBe(54);
  });

  it('набор B совпадает с чужой реализацией', () => {
    // Ни одной пачки из четырёх цифр — обе реализации обязаны выбрать B.
    for (const value of ['MA-SKLAD', 'ABC123', 'P-12-34', 'x', 'Zz09']) {
      expect(code128Pattern(value), value).toBe(oracle(CODE128B, value));
    }
  });

  it('набор C совпадает с чужой реализацией', () => {
    for (const value of ['1234567890', '0000000001', '98765432']) {
      expect(code128Pattern(value), value).toBe(oracle(CODE128C, value));
    }
  });

  it('коды объектов совпадают с чужой реализацией посимвольно', () => {
    for (const kind of ['item', 'batch', 'serial', 'location'] as const) {
      for (const id of [1n, 42n, 1234n, 987_654_321n]) {
        const value = buildCode(kind, id);
        expect(code128Pattern(value), value).toBe(oracle(CODE128AUTO, value));
      }
    }
  });

  it('в набор C переходит с четырёх цифр, а начинает с двух', () => {
    // Порог не круглое число, а расчёт: переход стоит один символ, и две
    // цифры в наборе C занимают один вместо двух. В середине строки он
    // окупается с четырёх цифр, в начале — уже с двух, потому что стартовый
    // символ нужен всё равно и покупать переход не за что.
    const hasSwitch = (v: string) => code128Values(v).includes(99); // 99 = Code C
    expect(hasSwitch('ab123')).toBe(false);
    expect(hasSwitch('ab1234')).toBe(true);
    // Нечётная пачка начинается одной цифрой в B: «12345» это «1» и C(23,45),
    // а не C(12,34) и «5» — иначе возврат в B стоил бы лишний символ.
    expect(code128Values('ab12345').length).toBe(9);
    expect(code128Values('12ab').slice(0, 2)).toEqual([105, 12]); // 105 = Start C
    expect(code128Values('1ab').slice(0, 2)).toEqual([104, 17]); // 104 = Start B, 17 = «1»
  });

  /**
   * Сверка с чужой реализацией на случайных строках, а не только на наших
   * кодах: набор выбирается по всей строке сразу, и ошибка в этом выборе
   * видна на чём угодно, кроме тринадцати знаков одного и того же вида.
   *
   * Строчная буква в конце обязательна: наш кодировщик набором A не
   * пользуется вовсе, а `jsbarcode` при равенстве уходит в A, и расхождение
   * было бы не про выбор C, а про набор, которого у нас нет.
   */
  it('совпадает с чужой реализацией на случайных строках', () => {
    // Свой генератор, а не Math.random: упавший прогон должен падать снова.
    let seed = 20260928;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const alphabet = 'ab0123456789xz';
    const seen: string[] = [];
    for (let k = 0; k < 500; k += 1) {
      let v = '';
      const len = 1 + Math.floor(next() * 16);
      for (let i = 0; i < len; i += 1) v += alphabet[Math.floor(next() * alphabet.length)];
      v += 'a';
      seen.push(v);
      expect(code128Pattern(v), v).toBe(oracle(CODE128AUTO, v));
    }
    // Проверка проверки: без цифр в выборке она ничего не сказала бы о C.
    expect(seen.filter((v) => /\d{4}/.test(v)).length).toBeGreaterThan(50);
  });

  it('переключение наборов экономит место', () => {
    const value = buildCode('item', 1n); // MAI0000000019, 13 знаков
    // Одним набором B это 13 символов данных, с переходом в C — 10
    // (старт, «MAI», переход, пять пар цифр). Плюс контрольный и стоп.
    expect(code128Values(value).length).toBe(10 + 2);
    expect(code128Bars(value).modules).toBe(11 * 11 + 13);
  });

  it('полосы восстанавливают рисунок', () => {
    const value = buildCode('batch', 777n);
    const { widths, modules } = code128Bars(value);
    const rebuilt = widths
      .map((w, i) => (i % 2 === 0 ? '1' : '0').repeat(w))
      .join('');
    expect(rebuilt).toBe(code128Pattern(value));
    expect(widths.reduce((a, b) => a + b, 0)).toBe(modules);
  });

  it('отказывается от кириллицы вслух', () => {
    // Номер партии в системе кириллический — именно поэтому на этикетку идёт
    // свой код, а не он. Молчаливая подмена символов дала бы нечитаемый
    // штрихкод, который заметили бы уже у полки.
    expect(() => code128Pattern('П-00012')).toThrow(/только печатный ASCII/);
  });
});

describe('QR', () => {
  it('матрица квадратная и обрамлена по стандарту', () => {
    const { size, rows } = qrMatrix(buildCode('serial', 12n));
    expect(size).toBe(21); // версия 1: 13 символов с коррекцией M влезают
    expect(rows).toHaveLength(size);
    for (const row of rows) expect(row).toMatch(new RegExp(`^[01]{${size}}$`));
    // Три поисковых узора 7×7 по углам — иначе это не QR.
    const finder = (r0: number, c0: number) =>
      rows.slice(r0, r0 + 7).map((r) => r.slice(c0, c0 + 7));
    const pattern = [
      '1111111', '1000001', '1011101', '1011101', '1011101', '1000001', '1111111',
    ];
    expect(finder(0, 0)).toEqual(pattern);
    expect(finder(0, size - 7)).toEqual(pattern);
    expect(finder(size - 7, 0)).toEqual(pattern);
  });

  it('разные коды дают разные матрицы', () => {
    const a = qrMatrix(buildCode('item', 1n)).rows.join('');
    const b = qrMatrix(buildCode('item', 2n)).rows.join('');
    expect(a).not.toBe(b);
  });
});

describe('renderSymbol', () => {
  it('отдаёт то, что просили', () => {
    const code = buildCode('location', 5n);
    expect(renderSymbol('code128', code)).toMatchObject({ symbology: 'code128' });
    expect(renderSymbol('qr', code)).toMatchObject({ symbology: 'qr', size: 21 });
  });
});
