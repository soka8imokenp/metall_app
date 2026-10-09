/**
 * Сумма прописью (ТЗ 7.1).
 *
 * Печатается на счёте и в договоре рядом с числом: расхождение между ними —
 * повод не платить, поэтому пишем из той же величины, а не из округлённой
 * «для красоты».
 *
 * Две особенности, из-за которых это не тривиальный перевод числа в слова:
 *
 * 1. **Род.** По-русски «одна тысяча» и «один миллион»: у тысячи женский род,
 *    у остальных разрядов мужской. Сум — мужской: «двадцать один сум».
 * 2. **Склонение разряда.** 1 тысяча, 2 тысячи, 5 тысяч — и отдельно 11–14,
 *    которые всегда «тысяч», хотя кончаются на 1–4.
 *
 * По-узбекски проще: числительные не склоняются и рода нет, разряды пишутся
 * как есть. Поэтому узбекская ветка — прямая сборка без согласований.
 */

const RU_ONES_M = [
  '', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять',
];
const RU_ONES_F = [
  '', 'одна', 'две', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять',
];
const RU_TEENS = [
  'десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать',
  'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать',
];
const RU_TENS = [
  '', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят',
  'семьдесят', 'восемьдесят', 'девяносто',
];
const RU_HUNDREDS = [
  '', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот',
  'семьсот', 'восемьсот', 'девятьсот',
];

/** Формы разряда: 1, 2–4, 5–20. */
type Forms = [string, string, string];

const RU_SCALES: { forms: Forms; feminine: boolean }[] = [
  { forms: ['', '', ''], feminine: false }, // единицы — форма берётся у валюты
  { forms: ['тысяча', 'тысячи', 'тысяч'], feminine: true },
  { forms: ['миллион', 'миллиона', 'миллионов'], feminine: false },
  { forms: ['миллиард', 'миллиарда', 'миллиардов'], feminine: false },
  { forms: ['триллион', 'триллиона', 'триллионов'], feminine: false },
];

/** 21 сум, 22 сума, 25 сумов — и 11–14 всегда по третьей форме. */
export function plural(n: number, forms: Forms): string {
  const abs = Math.abs(n) % 100;
  if (abs >= 11 && abs <= 14) return forms[2];
  switch (abs % 10) {
    case 1:
      return forms[0];
    case 2:
    case 3:
    case 4:
      return forms[1];
    default:
      return forms[2];
  }
}

function ruTriple(n: number, feminine: boolean): string[] {
  const out: string[] = [];
  const h = Math.floor(n / 100);
  const rest = n % 100;
  if (h) out.push(RU_HUNDREDS[h]!);
  if (rest >= 10 && rest < 20) {
    out.push(RU_TEENS[rest - 10]!);
  } else {
    const t = Math.floor(rest / 10);
    const o = rest % 10;
    if (t) out.push(RU_TENS[t]!);
    if (o) out.push((feminine ? RU_ONES_F : RU_ONES_M)[o]!);
  }
  return out;
}

function ruInteger(value: bigint, currency: Forms): string {
  if (value === 0n) return `ноль ${currency[2]}`;

  const triples: number[] = [];
  let rest = value;
  while (rest > 0n) {
    triples.push(Number(rest % 1000n));
    rest /= 1000n;
  }
  if (triples.length > RU_SCALES.length) {
    // Дальше триллионов разрядов не заводим: сумма, которой не бывает,
    // лучше выглядит числом, чем выдуманным словом.
    throw new RangeError('Сумма слишком велика для записи прописью');
  }

  const parts: string[] = [];
  for (let i = triples.length - 1; i >= 0; i -= 1) {
    const t = triples[i]!;
    if (t === 0) continue;
    const scale = RU_SCALES[i]!;
    parts.push(...ruTriple(t, scale.feminine));
    if (i > 0) parts.push(plural(t, scale.forms));
  }
  parts.push(plural(triples[0]!, currency));
  return parts.join(' ');
}

const UZ_ONES = [
  '', 'bir', 'ikki', 'uch', 'to‘rt', 'besh', 'olti', 'yetti', 'sakkiz', 'to‘qqiz',
];
const UZ_TENS = [
  '', 'o‘n', 'yigirma', 'o‘ttiz', 'qirq', 'ellik', 'oltmish', 'yetmish',
  'sakson', 'to‘qson',
];
const UZ_SCALES = ['', 'ming', 'million', 'milliard', 'trillion'];

function uzTriple(n: number): string[] {
  const out: string[] = [];
  const h = Math.floor(n / 100);
  const t = Math.floor((n % 100) / 10);
  const o = n % 10;
  if (h) out.push(UZ_ONES[h]!, 'yuz');
  if (t) out.push(UZ_TENS[t]!);
  if (o) out.push(UZ_ONES[o]!);
  return out;
}

function uzInteger(value: bigint, currency: string): string {
  if (value === 0n) return `nol ${currency}`;
  const triples: number[] = [];
  let rest = value;
  while (rest > 0n) {
    triples.push(Number(rest % 1000n));
    rest /= 1000n;
  }
  if (triples.length > UZ_SCALES.length) {
    throw new RangeError('Сумма слишком велика для записи прописью');
  }
  const parts: string[] = [];
  for (let i = triples.length - 1; i >= 0; i -= 1) {
    const t = triples[i]!;
    if (t === 0) continue;
    // «bir ming» по-узбекски не говорят — просто «ming».
    if (!(i > 0 && t === 1 && i === 1)) parts.push(...uzTriple(t));
    if (i > 0) parts.push(UZ_SCALES[i]!);
  }
  parts.push(currency);
  return parts.join(' ');
}

type CurrencyWords = { ru: Forms; uz: string; fractionRu: Forms; fractionUz: string };

/**
 * Названия валют. Незнакомую валюту пишем её кодом, а не выдуманным словом:
 * «двадцать один EUR» читается странно, но не врёт.
 */
const CURRENCIES: Record<string, CurrencyWords> = {
  UZS: {
    ru: ['сум', 'сума', 'сумов'],
    uz: 'so‘m',
    fractionRu: ['тийин', 'тийина', 'тийинов'],
    fractionUz: 'tiyin',
  },
  USD: {
    ru: ['доллар', 'доллара', 'долларов'],
    uz: 'dollar',
    fractionRu: ['цент', 'цента', 'центов'],
    fractionUz: 'sent',
  },
  RUB: {
    ru: ['рубль', 'рубля', 'рублей'],
    uz: 'rubl',
    fractionRu: ['копейка', 'копейки', 'копеек'],
    fractionUz: 'tiyin',
  },
};

const unknown = (code: string): CurrencyWords => ({
  ru: [code, code, code],
  uz: code,
  fractionRu: ['', '', ''],
  fractionUz: '',
});

/**
 * Сумма прописью с копейками цифрами — так пишут в счетах: слова для целой
 * части, чтобы её нельзя было подправить пером, и цифры для дробной.
 *
 * Первая буква заглавная: строка идёт отдельным полем печатной формы.
 */
export function amountInWords(
  amount: string | number,
  currencyCode: string,
  locale: 'ru' | 'uz' = 'ru',
): string {
  const raw = typeof amount === 'number' ? amount.toFixed(2) : amount.trim();
  const negative = raw.startsWith('-');
  const clean = negative ? raw.slice(1) : raw;
  // Дробную часть **округляем**, а не отбрасываем. В базе сумма держит четыре
  // знака (цена за тонну бывает с четырьмя), а в шапке документа и на бумаге
  // стоит два: при отбрасывании в шапке выходило «…,45», а словами «44 тийина»
  // — счёт, который спорит сам с собой. Считаем на строке, без float: 0,145 в
  // double лежит чуть ниже, и половинка округлилась бы вниз.
  const [intPart = '0', fracRaw = ''] = clean.split('.');
  let whole = BigInt(intPart.replace(/\D/g, '') || '0');
  const digits = (fracRaw + '000').slice(0, 3);
  let frac = Number(digits.slice(0, 2));
  if (Number(digits[2] ?? '0') >= 5) frac += 1;
  if (frac >= 100) {
    whole += 1n;
    frac = 0;
  }

  const money = CURRENCIES[currencyCode.toUpperCase()] ?? unknown(currencyCode.toUpperCase());

  let text: string;
  if (locale === 'uz') {
    text = uzInteger(whole, money.uz);
    if (money.fractionUz) text += ` ${String(frac).padStart(2, '0')} ${money.fractionUz}`;
  } else {
    text = ruInteger(whole, money.ru);
    if (money.fractionRu[2]) {
      text += ` ${String(frac).padStart(2, '0')} ${plural(frac, money.fractionRu)}`;
    }
  }
  if (negative) text = (locale === 'uz' ? 'minus ' : 'минус ') + text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}
