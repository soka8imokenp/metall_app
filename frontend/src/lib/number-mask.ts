/**
 * Разбор и сборка маски номера документа.
 *
 * Маска — это то, что хранит и понимает сервер: `СЧ-{YY}/{SEQ}`. Человеку,
 * который заводит тип документа раз в год, читать и набирать её нечем: в
 * форме это выглядело шифром из фигурных скобок, и ошибиться в `{SEQ:3}`
 * было проще, чем попасть.
 *
 * Поэтому экран показывает простые поля — начало номера, что в него входит,
 * разделитель и длину счётчика, — а маску собирает сам. Здесь только разбор
 * в части и сборка обратно; никакой вёрстки.
 *
 * Разбор обязан быть обратимым: собрав разобранное без правок, мы должны
 * получить ту же строку. Не получилось — значит маска сложнее простых полей
 * (так бывает), и форма честно показывает её текстом, а не делает вид, что
 * поняла.
 */

export interface NumberParts {
  /** Текст перед номером: «СЧ». Пусто, если номер начинается с подстановки. */
  start: string;
  /** Начало — код типа (`{TYPE}`), а не свой текст. */
  startIsType: boolean;
  year: '' | 'YY' | 'YYYY';
  month: boolean;
  company: boolean;
  /** Сколько знаков в счётчике. */
  seqWidth: number;
  /** Счётчик записан как `{SEQ}` — без явной ширины. */
  seqPlain: boolean;
  /** Разделители на стыках частей, по одному на стык. */
  seps: string[];
}

/** Разделители, которые форма умеет показывать кнопками. */
export const SEPARATORS = ['-', '/', '.', ''] as const;

const TOKEN = /\{(SEQ:\d+|SEQ|YYYY|YY|MM|TYPE|COMPANY)\}/g;

const isSep = (s: string) => (SEPARATORS as readonly string[]).includes(s);

/** Ширина счётчика по умолчанию — столько знаков даёт `{SEQ}`. */
export const DEFAULT_SEQ_WIDTH = 5;

export function parseMask(mask: string): NumberParts | null {
  const tokens: { name: string; from: number; to: number }[] = [];
  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(mask); m; m = TOKEN.exec(mask)) {
    tokens.push({ name: m[1], from: m.index, to: m.index + m[0].length });
  }
  if (tokens.length === 0) return null;

  const head = mask.slice(0, tokens[0].from);
  if (head.includes('{') || head.includes('}')) return null;

  let start = '';
  let startIsType = false;
  let rest = tokens;
  const seps: string[] = [];

  if (tokens[0].name === 'TYPE' && head === '') {
    startIsType = true;
    rest = tokens.slice(1);
  } else {
    // «СЧ-» — это начало и разделитель за ним, а не одно поле: иначе
    // переключатель разделителя не дотянулся бы до первого стыка.
    const tail = head.slice(-1);
    if (head !== '' && isSep(tail) && tail !== '') {
      start = head.slice(0, -1);
      seps.push(tail);
    } else {
      start = head;
      seps.push('');
    }
    if (start.includes('{')) return null;
  }

  const parts: NumberParts = {
    start,
    startIsType,
    year: '',
    month: false,
    company: false,
    seqWidth: DEFAULT_SEQ_WIDTH,
    seqPlain: true,
    seps,
  };

  // Порядок частей задан: год, месяц, компания, счётчик. Другой порядок
  // встречается, и подогнать его под кнопки нельзя — такую маску форма
  // показывает текстом.
  const order = ['year', 'month', 'company', 'seq'];
  let at = 0;

  for (let i = 0; i < rest.length; i += 1) {
    const t = rest[i];
    if (i > 0 || startIsType) {
      const prev = i === 0 ? tokens[0] : rest[i - 1];
      const between = mask.slice(prev.to, t.from);
      if (!isSep(between)) return null;
      seps.push(between);
    }

    const kind =
      t.name === 'YY' || t.name === 'YYYY'
        ? 'year'
        : t.name === 'MM'
          ? 'month'
          : t.name === 'COMPANY'
            ? 'company'
            : t.name.startsWith('SEQ')
              ? 'seq'
              : null;
    if (!kind) return null;
    const pos = order.indexOf(kind);
    if (pos < at) return null;
    at = pos + 1;

    if (kind === 'year') parts.year = t.name as 'YY' | 'YYYY';
    if (kind === 'month') parts.month = true;
    if (kind === 'company') parts.company = true;
    if (kind === 'seq') {
      if (i !== rest.length - 1) return null;
      const width = t.name.includes(':') ? Number(t.name.split(':')[1]) : DEFAULT_SEQ_WIDTH;
      if (!Number.isInteger(width) || width < 1 || width > 12) return null;
      parts.seqWidth = width;
      parts.seqPlain = !t.name.includes(':');
    }
  }

  if (at !== 4) return null; // счётчик обязателен и стоит последним
  if (mask.slice(tokens[tokens.length - 1].to) !== '') return null;

  return buildMask(parts) === mask ? parts : null;
}

export function buildMask(parts: NumberParts): string {
  const pieces: string[] = [parts.startIsType ? '{TYPE}' : parts.start];
  if (parts.year) pieces.push(`{${parts.year}}`);
  if (parts.month) pieces.push('{MM}');
  if (parts.company) pieces.push('{COMPANY}');
  pieces.push(parts.seqPlain && parts.seqWidth === DEFAULT_SEQ_WIDTH ? '{SEQ}' : `{SEQ:${parts.seqWidth}}`);

  // Начало может быть пустым — тогда первого стыка нет.
  const skipFirst = pieces[0] === '';
  const body = skipFirst ? pieces.slice(1) : pieces;
  const seps = skipFirst ? parts.seps.slice(1) : parts.seps;

  let out = body[0] ?? '';
  for (let i = 1; i < body.length; i += 1) out += (seps[i - 1] ?? '-') + body[i];
  return out;
}

/** Пустое начало стыка не даёт: его разделитель в номер не попадает. */
const headless = (parts: NumberParts) => !parts.startIsType && parts.start === '';

/** Разделители, которые видно в номере. */
export function realSeparators(parts: NumberParts): string[] {
  return headless(parts) ? parts.seps.slice(1) : parts.seps.slice();
}

/** Ровно тот разделитель, если он один на всю маску; иначе `null` — «разные». */
export function singleSeparator(parts: NumberParts): string | null {
  const used = realSeparators(parts);
  if (used.length === 0) return null;
  return used.every((s) => s === used[0]) ? used[0] : null;
}

/** Разделитель для новой части: тот, что уже стоит в маске. */
export function defaultSeparator(parts: NumberParts): string {
  return singleSeparator(parts) ?? realSeparators(parts)[0] ?? '-';
}

/** Один разделитель на все стыки. */
export function withSeparator(parts: NumberParts, sep: string): NumberParts {
  const seps = parts.seps.map((s, i) => (headless(parts) && i === 0 ? s : sep));
  return { ...parts, seps };
}

type OptionalPart = 'year' | 'month' | 'company';

const ORDER: OptionalPart[] = ['year', 'month', 'company'];

const has = (parts: NumberParts, k: OptionalPart) =>
  k === 'year' ? parts.year !== '' : k === 'month' ? parts.month : parts.company;

/**
 * Включить или выключить часть номера.
 *
 * Разделитель вставляется и убирается вместе с частью: иначе включение
 * месяца в «СЧ-26/00001» дало бы «СЧ-2609/00001» — два поля слиплись бы в
 * одно число, и номер стал бы неразборчивым.
 */
export function togglePart(
  parts: NumberParts,
  kind: OptionalPart,
  on: boolean | 'YY' | 'YYYY',
): NumberParts {
  const next: NumberParts = { ...parts, seps: [...parts.seps] };
  const had = has(parts, kind);
  const want = on !== false;

  let pos = 1; // элемент 0 — начало номера, оно есть всегда
  for (const k of ORDER) {
    if (k === kind) break;
    if (has(parts, k)) pos += 1;
  }

  if (want && !had) next.seps.splice(pos - 1 + 1, 0, defaultSeparator(parts));
  if (!want && had) next.seps.splice(pos - 1 + 1, 1);

  if (kind === 'year') next.year = want ? (on as 'YY' | 'YYYY') : '';
  if (kind === 'month') next.month = want;
  if (kind === 'company') next.company = want;
  return next;
}
