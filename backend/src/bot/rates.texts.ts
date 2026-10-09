/**
 * Экран «Курс валют» словами человека.
 *
 * Отдельным файлом, как и у остальных разделов: тексты правят чаще кода, и
 * искать их в логике неудобно. Узбекский рядом с русским, строка в строку —
 * так забытый перевод виден глазом, а не всплывает у человека в поле.
 */

/** Флаг страны валюты: на телефоне он находится быстрее, чем три буквы кода. */
const FLAG: Record<string, string> = {
  UZS: '🇺🇿',
  USD: '🇺🇸',
  RUB: '🇷🇺',
  EUR: '🇪🇺',
  GBP: '🇬🇧',
  KZT: '🇰🇿',
  KGS: '🇰🇬',
  CNY: '🇨🇳',
  JPY: '🇯🇵',
  TRY: '🇹🇷',
  AED: '🇦🇪',
  CHF: '🇨🇭',
  KRW: '🇰🇷',
  INR: '🇮🇳',
};

export const flagOf = (code: string): string => FLAG[code] ?? '💱';

export const R = {
  title: (uz: boolean) => (uz ? '💱 <b>Valyuta kursi</b>' : '💱 <b>Курс валют</b>'),

  head: (uz: boolean, day: string) =>
    uz
      ? `O‘zbekiston Markaziy bankining rasmiy kursi, <b>${day}</b> holatiga.`
      : `Официальный курс Центрального банка Узбекистана на <b>${day}</b>.`,

  /** Строка валюты: «1 $ = 11 772,95 сум» и насколько изменился за день. */
  line: (uz: boolean, flag: string, name: string, one: string, value: string) =>
    `${flag} <b>${name}</b>\n1 ${one} = <b>${value}</b>`,

  change: (uz: boolean, up: boolean, value: string) =>
    uz
      ? ` (${up ? '+' : '−'}${value} kunlik o‘zgarish)`
      : ` (${up ? '+' : '−'}${value} за день)`,

  /** Курс есть, но не сегодняшний: банк ещё не опубликовал или не отвечал. */
  onDay: (uz: boolean, day: string) => (uz ? ` · ${day} kursi` : ` · курс на ${day}`),

  noRate: (uz: boolean) =>
    uz ? '\n<i>Kurs hali kiritilmagan</i>' : '\n<i>Курса пока нет</i>',

  base: (uz: boolean, flag: string, name: string) =>
    uz
      ? `${flag} <b>${name}</b> — hisob valyutasi: butun tizim shunda hisoblanadi.`
      : `${flag} <b>${name}</b> — учётная валюта: в ней считается вся система.`,

  /** Зачем этот экран вообще нужен — два предложения, не лекция. */
  why: (uz: boolean) =>
    uz
      ? '<blockquote>Valyutadagi operatsiya shu kurs bo‘yicha so‘mga aylantiriladi. ' +
        'Kurs o‘tkazilgan paytda qotadi va orqaga qarab o‘zgarmaydi.</blockquote>'
      : '<blockquote>По этому курсу валютная операция пересчитывается в сумы. ' +
        'Курс запоминается в момент проведения и задним числом не меняется.</blockquote>',

  checked: (uz: boolean, time: string) =>
    uz
      ? `${time} da tekshirildi. Bank kursni ish kunida bir marta e’lon qiladi.`
      : `Проверено в ${time}. Банк публикует курс раз в рабочий день.`,

  /** Банк не ответил: показываем последний известный и говорим об этом. */
  bankSilent: (uz: boolean, reason: string) =>
    uz
      ? `⚠️ Markaziy bank javob bermadi (${reason}). Oxirgi ma’lum kurs ko‘rsatilgan.`
      : `⚠️ Банк сейчас не отвечает (${reason}). Показан последний известный курс.`,

  refresh: (uz: boolean) => (uz ? '🔄 Yangilash' : '🔄 Обновить'),

  refreshed: (uz: boolean, day: string) =>
    uz ? `Kurs yangilandi: ${day}` : `Курс обновлён: на ${day}`,

  refreshFailed: (uz: boolean) =>
    uz ? 'Bank javob bermadi, keyinroq urinib ko‘ring' : 'Банк не ответил, попробуйте позже',

  /** Пересчёт на экране проверки валютной операции. */
  inBase: (uz: boolean, value: string, rate: string, day: string) =>
    uz
      ? `${value} (${day} kursi bo‘yicha ${rate})`
      : `${value} (по курсу ${rate} на ${day})`,
} as const;
