/**
 * Деньги и даты словами человека.
 *
 * Эти функции нужны всем разделам бота: сумма в заказе пишется так же, как
 * сумма в платеже, а срок оплаты разбирается так же, как дата операции. Файл
 * без зависимостей — ни Nest, ни базы, ни Telegram: ошибка здесь дороже
 * остальных, она превращается в неверную сумму или не ту дату.
 */

/**
 * Чем подписываем сумму. Код валюты человек в возрасте не читает.
 *
 * Сум подписан на языке человека: по-русски «сум», по-узбекски «so‘m». Раньше
 * здесь стояло одно «сўм» на оба языка — узбекская кириллица в русском экране
 * и в узбекском, который весь остальной латиницей. Та же подпись и в вебе, и в
 * строках приветствия, иначе одна система отвечает по-разному на один вопрос.
 */
const SYMBOL: Record<string, { ru: string; uz: string }> = {
  UZS: { ru: 'сум', uz: 'so‘m' },
  USD: { ru: '$', uz: '$' },
  RUB: { ru: '₽', uz: '₽' },
};

/** Валюта учёта. Для неё курс не нужен: она сама себе курс. */
export const BASE_CURRENCY = 'UZS';

/** Сегодня по Ташкенту, а не по часам сервера: день закрывают по месту. */
export function today(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tashkent',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function shiftDay(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const at = new Date(Date.UTC(y!, m! - 1, d! + days));
  return at.toISOString().slice(0, 10);
}

/**
 * Дата из сообщения: `28.09.2026`, `28.09.26` или `28.09` — год тогда текущий.
 * Разделителем принимаем точку, косую и дефис: на телефоне набирают как придётся.
 *
 * Несуществующий день (`31.02`) не принимаем молча: `new Date` сдвинул бы его
 * на март, и человек увидел бы в карточке не то, что написал.
 */
export function parseDay(raw: string, now: Date): string | null {
  const m = raw.trim().match(/^(\d{1,2})[.\-/](\d{1,2})(?:[.\-/](\d{2}|\d{4}))?$/);
  if (!m) return null;
  const d = Number(m[1]);
  const mo = Number(m[2]);
  const nowYear = Number(today(now).slice(0, 4));
  const y = m[3] === undefined ? nowYear : m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const at = new Date(Date.UTC(y, mo - 1, d));
  if (at.getUTCFullYear() !== y || at.getUTCMonth() !== mo - 1 || at.getUTCDate() !== d)
    return null;
  return at.toISOString().slice(0, 10);
}

/** `2026-09-28` → `28.09.2026`. Человек читает день первым. */
export function showDay(day: string): string {
  const [y, m, d] = day.split('-');
  return `${d}.${m}.${y}`;
}

/**
 * Чем подписать сумму на языке человека. Отдельной функцией, потому что
 * сводка округляет суммы по-своему, а называть сум двумя способами в одной
 * системе нельзя.
 */
export function currencyMark(currency: string, isUz = false): string {
  const mark = SYMBOL[currency];
  return mark ? (isUz ? mark.uz : mark.ru) : currency;
}

/** Деньги словами человека: разряды пробелами, валюта знаком на его языке. */
export function sum(amount: string | number, currency: string, isUz = false): string {
  const value = Number(amount);
  const shown = new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(value);
  return `${shown} ${currencyMark(currency, isUz)}`;
}

/**
 * Уложить подпись в предел Telegram.
 *
 * Предел — 1024 знака, и лишнее Telegram не отбивает ошибкой: он обрезает
 * молча. Один раз так уже пропал хвост подсказки у администратора. Поэтому
 * обрезает бот сам и говорит, сколько знаков не поместилось: в журнале это
 * видно, а не выясняется жалобой человека.
 */
export function fit(text: string, limit: number): { text: string; cut: number } {
  if (text.length <= limit) return { text, cut: 0 };
  return { text: `${text.slice(0, limit - 1)}…`, cut: text.length - limit + 1 };
}

/** Момент для операции: полдень по Ташкенту, чтобы дата не сползла в соседний день. */
export function moment(day: string): string {
  return `${day}T12:00:00+05:00`;
}
