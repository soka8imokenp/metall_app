import { randomUUID } from 'node:crypto';
import { runWithContext, type RequestContext } from '../common/request-context.js';
import type { InlineButton, InlineKeyboard } from './telegram.api.js';
import { BLUE, CB } from './menu.js';

/**
 * Общее основание рабочих разделов бота.
 *
 * Разделов стало пять — финансы, склад, продажи, документы, сводка, — и у них
 * совпадает ровно то, что совпадать должно: как бот зовёт службы системы от
 * имени человека, что такое «экран» и как выглядит незаконченный разговор.
 * Три копии подъёма контекста означали бы, что однажды в одной из них забудут
 * `source: 'bot'` или сузят список компаний, и расхождение найдётся в журнале,
 * а не в коде.
 *
 * Чего здесь нет — ни одного правила о складе, деньгах или документах. Правила
 * живут в своих модулях, разделы бота их только зовут.
 */

export interface Me {
  userId: bigint;
  permissions: Set<string>;
  companyIds: bigint[];
  /**
   * Компании человека. Внутренний номер лежит рядом с названием не для
   * красоты: сводка сравнивает компании, сужая контекст до одной, а по uid
   * контекст не сужается — политика RLS смотрит на номера.
   */
  companies: { id: bigint; uid: string; nameRu: string; nameUz: string }[];
}

/** Что бот покажет: подпись, кнопки и — если разговор идёт — его состояние. */
export interface Screen {
  text: string;
  keyboard: InlineKeyboard;
  /**
   * Прислать новым сообщением, а не правкой прежнего. Нужно после того, как
   * человек ответил текстом: правка ушла бы выше его собственного сообщения, и
   * он остался бы смотреть в свою строку, не понимая, что бот ответил.
   */
  fresh?: boolean;
  /** Всплывающая подсказка на кнопке. */
  toast?: string;
  /** Файл, который надо отправить вместе с экраном. */
  file?: { bytes: ArrayBuffer; fileName: string; mimeType: string };
  /**
   * Новое состояние разговора. `undefined` — не трогать, `null` — разговора
   * больше нет.
   */
  flow?: SectionFlow | null;
}

/**
 * Файл, присланный человеком в чат: уже скачанный, с именем и типом.
 *
 * Скачивает его каркас, а разделы получают готовые байты: ходить в Telegram
 * за файлом из раздела значило бы, что про токен и про срок жизни пути знают
 * пять мест вместо одного.
 */
export interface Incoming {
  fileName: string;
  mimeType: string;
  bytes: Buffer;
}

/** Чей это незаконченный разговор. Без пометки бот не знает, кому его отдать. */
export type FlowKind = 'fin' | 'wh' | 'sales' | 'doc' | 'chief' | 'prod';

export interface SectionFlow {
  kind: FlowKind;
  step: string;
}

/**
 * Позвать службу системы от имени вошедшего человека.
 *
 * Это и есть причина, по которой бот не отдельный пользователь системы: RLS,
 * права и журнал смотрят на контекст запроса, и действие из Telegram должно
 * быть подписано тем, кто его сделал. `source: 'bot'` отличает его в журнале
 * от работы в браузере — иначе на вопрос «кто и откуда» ответа нет.
 */
export function asUser<T>(me: Me, uz: boolean, fn: () => Promise<T>): Promise<T> {
  const ctx: RequestContext = {
    requestId: `bot-${randomUUID()}`,
    userId: me.userId,
    companyIds: me.companyIds,
    allCompanyIds: me.companyIds,
    permissions: me.permissions,
    locale: uz ? 'uz' : 'ru',
    source: 'bot',
  };
  return runWithContext(ctx, fn);
}

/** Названия приходят из базы: в них может оказаться знак разметки. */
export function escape(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Количество словами человека: разряды пробелами, единица рядом. */
export function qtyText(value: string | number, unit?: string | null): string {
  const shown = new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
  }).format(Number(value));
  return unit ? `${shown} ${unit}` : shown;
}

/**
 * Список по пунктам.
 *
 * Абзац из пяти дел человек в возрасте читает как стену и половину пропускает;
 * те же пять дел строками он просматривает глазами. Поэтому всё, что по смыслу
 * перечисление, в боте идёт пунктами, а не через запятую.
 */
export function bullets(items: string[]): string {
  return items.map((i) => `• ${i}`).join('\n');
}

/**
 * Поля карточки или экрана проверки: цитатой и по пунктам.
 *
 * Точку не получают две строки: подзаголовок (кончается двоеточием) и
 * вложенная строка (начинается с пробела) — список внутри списка с двумя
 * точками читается хуже, чем с одной.
 */
export function fields(lines: string[]): string {
  const marked = lines.map((l) =>
    l.startsWith(' ') || l.startsWith('•') || l.trimEnd().endsWith(':') ? l : `• ${l}`,
  );
  return `<blockquote>${marked.join('\n')}</blockquote>`;
}

/**
 * Строка «что спрошу дальше» под вопросом шага.
 *
 * Человеку, который системой не пользуется, мало номера шага: «шаг 3 из 6» не
 * говорит, чего от него ещё хотят, и он бросает разговор на середине, потому
 * что не знает, сколько терпеть. Здесь перечислены сами вопросы — видно, что
 * осталось три коротких ответа, а не неизвестность.
 */
export function comingNext(isUz: boolean, titles: string[]): string {
  if (titles.length === 0) return '';
  return `\n\n<i>${isUz ? 'Keyin' : 'Дальше'}: ${titles.join(' → ')}</i>`;
}

/**
 * «Я не понял» — кнопка на экране подтверждения.
 *
 * Перед записью денег, товара или обещания клиенту человек должен понимать,
 * что именно сейчас произойдёт. Экран подтверждения перечисляет поля, но
 * словами «что это значит» не объясняет: перечень полей и объяснение — разные
 * вещи. Нажавший эту кнопку получает то же самое другими словами, и ничего при
 * этом не записывается.
 */
export function explainButton(isUz: boolean, data: string): InlineButton {
  return { text: isUz ? '🤔 Tushunmadim' : '🤔 Я не понял', data, style: BLUE };
}

/** Возврат с объяснения на тот же экран подтверждения. */
export function understoodButton(isUz: boolean, data: string): InlineButton {
  return {
    text: isUz ? '⬅️ Tekshirishga qaytish' : '⬅️ Вернуться к проверке',
    data,
    style: BLUE,
  };
}

/** Ряд возврата: в сам раздел и в главное меню. */
export function homeRow(
  section: string,
  titleRu: string,
  titleUz: string,
  isUz: boolean,
): InlineButton[] {
  return [
    { text: `⬅️ ${isUz ? titleUz : titleRu}`, data: section, style: BLUE },
    { text: isUz ? '⬅️ Menyu' : '⬅️ Меню', data: CB.menu, style: BLUE },
  ];
}
