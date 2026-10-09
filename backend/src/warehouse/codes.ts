/**
 * Штрихкоды и QR (ТЗ 5.9), чистая часть: из чего состоит код и как он
 * превращается в полосы и клетки. Без Nest и без базы — это позволяет
 * сверить кодирование с независимой реализацией в тестах.
 *
 * Код печатаем свой, а не человеческий номер. Причина не в красоте:
 * номер партии в системе кириллический (`П-00012`), а Code 128 кодирует
 * только ASCII — кириллицу он не возьмёт вовсе. Второй довод — длина:
 * номер и код позиции вместе не влезают на этикетку 38×21 мм.
 */

import qrcode from 'qrcode-generator';

/** Что именно помечено кодом (ТЗ 5.9: позиция, партия, серийный номер, место). */
export const CODE_KINDS = ['item', 'batch', 'serial', 'location'] as const;
export type CodeKind = (typeof CODE_KINDS)[number];

const KIND_LETTER: Record<CodeKind, string> = {
  item: 'I',
  batch: 'B',
  serial: 'S',
  location: 'L',
};

const KIND_BY_LETTER = new Map<string, CodeKind>(
  CODE_KINDS.map((k) => [KIND_LETTER[k], k]),
);

/**
 * Вид кода участвует в контрольной цифре собственным разрядом. Без этого
 * `MAI...` и `MAB...` с одинаковым идентификатором отличались бы ровно одной
 * буквой, и сканер, прочитавший её неверно, молча нашёл бы другой объект.
 */
const KIND_DIGIT: Record<CodeKind, number> = { item: 1, batch: 2, serial: 3, location: 4 };

const ID_DIGITS = 9;

/** `MA` + вид + 9 цифр идентификатора + контрольная цифра. */
const CODE_RE = /^MA([IBSL])(\d{9})(\d)$/;

/**
 * Контрольная цифра по Луну. Ловит и одну неверную цифру, и перестановку
 * соседних — два самых частых искажения при ручном вводе и при плохом
 * прочтении полос.
 */
export function luhn(digits: string): number {
  let sum = 0;
  let double = true; // считаем справа, крайняя справа цифра удваивается
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    double = !double;
    sum += d;
  }
  return (10 - (sum % 10)) % 10;
}

export function buildCode(kind: CodeKind, id: bigint | number | string): string {
  const body = String(id).padStart(ID_DIGITS, '0');
  if (body.length > ID_DIGITS || !/^\d+$/.test(body)) {
    throw new Error(`идентификатор не помещается в код: ${String(id)}`);
  }
  return `MA${KIND_LETTER[kind]}${body}${luhn(`${KIND_DIGIT[kind]}${body}`)}`;
}

export type ParsedCode = { kind: CodeKind; id: bigint };

/**
 * Разбор кода. Возвращает `null`, а не бросает: сканер приносит и чужие коды
 * (штрихкод поставщика, серийный номер россыпью), и они ищутся дальше по
 * своим справочникам.
 */
export function parseCode(raw: string): ParsedCode | null {
  const m = CODE_RE.exec(raw.trim().toUpperCase());
  if (!m) return null;
  const kind = KIND_BY_LETTER.get(m[1]!)!;
  const body = m[2]!;
  if (luhn(`${KIND_DIGIT[kind]}${body}`) !== Number(m[3])) return null;
  return { kind, id: BigInt(body) };
}

/* ------------------------------------------------------------------ */
/* Code 128                                                            */
/* ------------------------------------------------------------------ */

/**
 * Таблица символов Code 128 (ISO/IEC 15417): 103 значения данных, три старта
 * и стоп. Каждая строка — рисунок из 11 модулей, начинается полосой; у стопа
 * 13 модулей вместе с замыкающей полосой.
 */
const BARS = [
  '11011001100', '11001101100', '11001100110', '10010011000', '10010001100',
  '10001001100', '10011001000', '10011000100', '10001100100', '11001001000',
  '11001000100', '11000100100', '10110011100', '10011011100', '10011001110',
  '10111001100', '10011101100', '10011100110', '11001110010', '11001011100',
  '11001001110', '11011100100', '11001110100', '11101101110', '11101001100',
  '11100101100', '11100100110', '11101100100', '11100110100', '11100110010',
  '11011011000', '11011000110', '11000110110', '10100011000', '10001011000',
  '10001000110', '10110001000', '10001101000', '10001100010', '11010001000',
  '11000101000', '11000100010', '10110111000', '10110001110', '10001101110',
  '10111011000', '10111000110', '10001110110', '11101110110', '11010001110',
  '11000101110', '11011101000', '11011100010', '11011101110', '11101011000',
  '11101000110', '11100010110', '11101101000', '11101100010', '11100011010',
  '11101111010', '11001000010', '11110001010', '10100110000', '10100001100',
  '10010110000', '10010000110', '10000101100', '10000100110', '10110010000',
  '10110000100', '10011010000', '10011000010', '10000110100', '10000110010',
  '11000010010', '11001010000', '11110111010', '11000010100', '10001111010',
  '10100111100', '10010111100', '10010011110', '10111100100', '10011110100',
  '10011110010', '11110100100', '11110010100', '11110010010', '11011011110',
  '11011110110', '11110110110', '10101111000', '10100011110', '10001011110',
  '10111101000', '10111100010', '11110101000', '11110100010', '10111011110',
  '10111101110', '11101011110', '11110101110', '11010000100', '11010010000',
  '11010011100', '1100011101011',
];

const CODE_C = 99; // переход в набор C из набора B
const CODE_B = 100; // переход в набор B из набора C
const START_B = 104;
const START_C = 105;
const STOP = 106;

const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';

/** Сколько цифр подряд начиная с позиции `i`. */
function digitRun(value: string, i: number): number {
  let n = 0;
  while (isDigit(value[i + n])) n += 1;
  return n;
}

/**
 * Значения символов Code 128 для строки. Наборы B и C переключаются по
 * обычному правилу: в набор C уходим, когда впереди чётная пачка из четырёх
 * и более цифр (в начале строки — из четырёх), обратно — как только пары
 * кончились. Набор A не используется: в кодах нет управляющих символов,
 * а лишний набор — лишний способ ошибиться.
 */
export function code128Values(value: string): number[] {
  for (const ch of value) {
    const c = ch.charCodeAt(0);
    if (c < 32 || c > 126) {
      throw new Error(`Code 128 не кодирует символ «${ch}»: только печатный ASCII`);
    }
  }
  if (value.length === 0) throw new Error('Code 128: пустая строка');

  // С цифр начинается — начинаем прямо в наборе C: стартовый символ и так
  // нужен, и пара цифр в нём стоит один символ вместо двух. Порог здесь
  // ниже, чем в середине строки, потому что перехода тут не покупаем.
  const startInC = digitRun(value, 0) >= 2;
  const values: number[] = [startInC ? START_C : START_B];
  let inC = startInC;
  let i = 0;

  while (i < value.length) {
    if (inC) {
      if (isDigit(value[i]) && isDigit(value[i + 1])) {
        values.push(Number(value.slice(i, i + 2)));
        i += 2;
        continue;
      }
      values.push(CODE_B);
      inC = false;
      continue;
    }

    const run = digitRun(value, i);
    // Четыре цифры — порог окупаемости: переход стоит один символ, а четыре
    // цифры в наборе C занимают два вместо четырёх.
    if (run >= 4) {
      // Нечётную пачку начинаем одной цифрой в наборе B. Иначе её нечётный
      // хвост остался бы за набором C и возврат в B стоил бы лишний символ:
      // «12345» это «1» + C(23,45), а не C(12,34) + «5».
      if (run % 2 === 1) {
        values.push(value.charCodeAt(i) - 32);
        i += 1;
      }
      values.push(CODE_C);
      inC = true;
      continue;
    }
    values.push(value.charCodeAt(i) - 32);
    i += 1;
  }

  let sum = values[0]!;
  for (let k = 1; k < values.length; k += 1) sum += values[k]! * k;
  values.push(sum % 103);
  values.push(STOP);
  return values;
}

/** Рисунок штрихкода: строка из «1» (полоса) и «0» (пробел), по модулю на символ. */
export function code128Pattern(value: string): string {
  return code128Values(value)
    .map((v) => BARS[v]!)
    .join('');
}

/**
 * Полосы для отрисовки: ширины чередующихся полос и пробелов, начиная с
 * полосы. Экрану остаётся сложить прямоугольники — разбирать битовую строку
 * в браузере незачем.
 */
export function code128Bars(value: string): { widths: number[]; modules: number } {
  const pattern = code128Pattern(value);
  const widths: number[] = [];
  let run = 0;
  for (let i = 0; i < pattern.length; i += 1) {
    run += 1;
    if (pattern[i] !== pattern[i + 1]) {
      widths.push(run);
      run = 0;
    }
  }
  return { widths, modules: pattern.length };
}

/* ------------------------------------------------------------------ */
/* QR                                                                  */
/* ------------------------------------------------------------------ */

/**
 * Матрица QR строками из «1» и «0». Уровень коррекции M: на складской
 * этикетке код трут рукавицей и пачкают маслом, а L восстанавливает 7%
 * против 15% у M. Версия подбирается автоматически.
 */
export function qrMatrix(value: string): { size: number; rows: string[] } {
  const qr = qrcode(0, 'M');
  qr.addData(value, 'Byte');
  qr.make();
  const size = qr.getModuleCount();
  const rows: string[] = [];
  for (let r = 0; r < size; r += 1) {
    let row = '';
    for (let c = 0; c < size; c += 1) row += qr.isDark(r, c) ? '1' : '0';
    rows.push(row);
  }
  return { size, rows };
}

export const SYMBOLOGIES = ['code128', 'qr'] as const;
export type Symbology = (typeof SYMBOLOGIES)[number];

export type Symbol128 = { symbology: 'code128'; widths: number[]; modules: number };
export type SymbolQr = { symbology: 'qr'; size: number; rows: string[] };
export type CodeSymbol = Symbol128 | SymbolQr;

export function renderSymbol(symbology: Symbology, value: string): CodeSymbol {
  if (symbology === 'qr') return { symbology: 'qr', ...qrMatrix(value) };
  return { symbology: 'code128', ...code128Bars(value) };
}
