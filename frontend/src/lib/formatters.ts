/**
 * Единственное место, где строки из API превращаются в числа и в текст.
 *
 * Бэкенд отдаёт деньги и количества строками намеренно: десятичные значения
 * учёта не должны проходить через double. Разбирать их россыпью по компонентам
 * нельзя — так появляются `parseFloat` на деньгах и расхождение форматов между
 * экранами. Здесь же живут правила разделителей: в системе два языка, и в обоих
 * группы разделяются узким пробелом, а не запятой.
 */

/** Узкий неразрывный пробел: цифры не рвутся по строкам. */
const NBSP = ' ';

/**
 * Строка из API в число. Только для отрисовки: графику и сравнениям число
 * нужно, учётным операциям — нет, они остаются на стороне бэкенда.
 */
export function toNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === '') return 0;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Разряды узким пробелом, дробная часть — ровно fractionDigits знаков. */
export function formatNumber(
  value: string | number | null | undefined,
  fractionDigits = 0,
): string {
  const n = toNumber(value);
  const fixed = n.toFixed(fractionDigits);
  const [int, frac] = fixed.split('.');
  const sign = int.startsWith('-') ? '-' : '';
  const digits = sign ? int.slice(1) : int;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  return frac ? `${sign}${grouped},${frac}` : `${sign}${grouped}`;
}

/** Количество: один знак после запятой — как приходит с бэкенда. */
export const formatQty = (value: string | number | null | undefined) =>
  formatNumber(value, 1);

/**
 * Количество, которое нельзя округлить до нуля. Нормы расхода бывают мелкими
 * (0,0264 т полиэтилена на трубу), и «0,0» на экране цех читает как «не нужно».
 * Знаков берём ровно столько, чтобы число перестало быть нулём, но не больше
 * шести: дальше считает база, а человеку это не нужно.
 */
export function formatQtyFine(value: string | number | null | undefined): string {
  const n = toNumber(value);
  if (n === 0) return formatNumber(0, 1);
  for (let digits = 1; digits < 6; digits++) {
    if (Math.abs(Number(n.toFixed(digits))) > 0) return formatNumber(n, digits);
  }
  return formatNumber(n, 6);
}

/** Значение KPI с единицей: «14,12 млрд UZS», «396,9 т», «15,0 %». */
export function formatKpiValue(value: string | number | null | undefined, unit: string): string {
  const digits = unit === '%' || unit === 'т' ? 1 : 2;
  return `${formatNumber(value, digits)}${NBSP}${unit}`;
}

/** Прирост со знаком: «+12,4 %», «−3,2 %». Минус — типографский. */
export function formatDelta(percent: string | number | null | undefined): string {
  const n = toNumber(percent);
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  return `${sign}${formatNumber(Math.abs(n), 1)}${NBSP}%`;
}

/** Код единицы измерения из справочника — в подпись на языке интерфейса. */
const UNIT_LABELS: Record<string, { ru: string; uz: string }> = {
  t: { ru: 'т', uz: 't' },
  kg: { ru: 'кг', uz: 'kg' },
  pm: { ru: 'п.м.', uz: 'p.m.' },
  m: { ru: 'м', uz: 'm' },
  pcs: { ru: 'шт', uz: 'dona' },
  m3: { ru: 'м³', uz: 'm³' },
};

export function formatUnit(code: string, locale: 'ru' | 'uz'): string {
  return UNIT_LABELS[code]?.[locale] ?? code;
}

/** Дата ISO в короткий вид: «29.09.2026». Пустая дата — тире, не «Invalid Date». */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
}

/** Доля выполнения в процентах, срезанная сверху: 140% на шкале не рисуют. */
export function progressPercent(
  fact: string | number | null | undefined,
  plan: string | number | null | undefined,
): number {
  const p = toNumber(plan);
  if (p <= 0) return 0;
  return Math.min(100, Math.max(0, (toNumber(fact) / p) * 100));
}

/**
 * Крупная сумма коротко: «43,2 млрд», «890,0 млн», «12 500».
 *
 * Порог — миллион: суммы мельче в продажах читают целиком, а не в долях
 * миллиона. Валюта не подставляется — её подписывают рядом, потому что на
 * одном экране встречаются и UZS, и USD.
 */
export function formatMoneyShort(
  value: string | number | null | undefined,
  locale: 'ru' | 'uz',
): string {
  const n = toNumber(value);
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) {
    return `${formatNumber(n / 1_000_000_000, 1)}${NBSP}${locale === 'uz' ? 'mlrd' : 'млрд'}`;
  }
  if (abs >= 1_000_000) {
    return `${formatNumber(n / 1_000_000, 1)}${NBSP}${locale === 'uz' ? 'mln' : 'млн'}`;
  }
  return formatNumber(n, 0);
}

/** Доля из API: строка или null. null — доли нет, и рисовать нечего. */
export function formatPercent(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return `${formatNumber(value, 1)}${NBSP}%`;
}

/**
 * Русское склонение по числу: «1 строка», «2 строки», «5 строк».
 *
 * Узбекский не склоняет, поэтому там просто одна форма — вызывать эту функцию
 * для него не нужно.
 */
export function plural(n: number, one: string, few: string, many: string): string {
  const mod100 = Math.abs(n) % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  const mod10 = mod100 % 10;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

/**
 * Размер файла словами: «320 КБ», «1,4 МБ» / «320 KB», «1,4 MB».
 *
 * Сокращения единиц — тоже надпись интерфейса: на узбекском экране «КБ»
 * оставалось кириллицей в списке шаблонов и во вложениях склада. Порог —
 * мегабайт: ниже него доли мегабайта читать неудобно.
 */
export function formatBytes(bytes: number, locale: 'ru' | 'uz'): string {
  const kb = locale === 'uz' ? 'KB' : 'КБ';
  const mb = locale === 'uz' ? 'MB' : 'МБ';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))}${NBSP}${kb}`;
  return `${formatNumber(bytes / 1024 / 1024, 1)}${NBSP}${mb}`;
}

/**
 * Название из справочника на языке экрана.
 *
 * Справочники двуязычны, и API отдаёт пару `nameRu`/`nameUz`. Экран, бравший
 * только `nameRu`, показывал русское название склада и контрагента в
 * узбекском интерфейсе. Узбекского может не быть — его заводит человек, и для
 * записи, заведённой руками, поля просто нет: тогда показываем русское, а не
 * пустоту.
 */
export function refName(
  ref: { nameRu: string; nameUz?: string | null } | null | undefined,
  isUz: boolean,
): string {
  if (!ref) return '';
  if (isUz && ref.nameUz && ref.nameUz.trim() !== '') return ref.nameUz;
  return ref.nameRu;
}

/**
 * Месяцы и дни недели словами.
 *
 * Были заведены дважды — в календаре и в выборе периода бюджета, — и октябрь
 * расходился: «Oktyabr» в календаре против «Oktabr» в бюджете. Список один на
 * интерфейс, иначе расхождение возвращается с каждым новым экраном.
 */
const MONTHS: Record<'ru' | 'uz', readonly string[]> = {
  ru: [
    'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
    'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
  ],
  uz: [
    'Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'Iyun',
    'Iyul', 'Avgust', 'Sentabr', 'Oktabr', 'Noyabr', 'Dekabr',
  ],
};

const WEEKDAYS: Record<'ru' | 'uz', readonly string[]> = {
  ru: ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'],
  uz: ['Du', 'Se', 'Ch', 'Pa', 'Ju', 'Sh', 'Ya'],
};

export const monthNames = (locale: 'ru' | 'uz'): readonly string[] => MONTHS[locale];
export const weekdayNames = (locale: 'ru' | 'uz'): readonly string[] => WEEKDAYS[locale];
