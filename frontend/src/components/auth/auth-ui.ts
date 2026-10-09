/*
  Оформление экранов входа. Вынесено из `LoginScreen.tsx`, когда рядом с ним
  встал второй такой экран — обязательная смена пароля. Эти два человек видит
  подряд, одной задачей, и разъехавшиеся на пиксель карточки читались бы как
  переход в другую систему.

  Решения те же, что были, и причины их те же:

  1. Радиусы вложены: карточка 16, поля внутри 8. Одинаковый радиус у всего —
     первый признак дешёвой вёрстки.
  2. Один источник света. Тень двухслойная (контактная и мягкая), сверху
     светлая линия внутрь: она даёт ощущение поверхности лучше любого блюра.
  3. Подписи капителью с разрядкой: прописные без разрядки выглядят сжатыми.

  Цвета серые. Система монохромная — красный остаётся только на знаке.
*/

export const LABEL =
  'text-[11px] font-medium uppercase tracking-[0.08em] text-zinc-500 dark:text-zinc-400';

export const INPUT =
  'h-10 w-full rounded-lg border border-zinc-900/10 dark:border-white/10 ' +
  'bg-white/70 dark:bg-zinc-900/50 px-3 text-sm text-zinc-950 dark:text-zinc-50 ' +
  'outline-none transition-[border-color,box-shadow] duration-150 ' +
  'focus-visible:border-zinc-400 dark:focus-visible:border-zinc-500 ' +
  'focus-visible:ring-[3px] focus-visible:ring-zinc-900/10 dark:focus-visible:ring-white/10';

export const CARD =
  'flex flex-col gap-5 rounded-2xl p-6 min-w-0 backdrop-blur-xl ' +
  'bg-white/80 dark:bg-zinc-950/60 ring-1 ring-zinc-900/[0.06] dark:ring-white/[0.08] ' +
  'shadow-[inset_0_1px_0_rgb(255_255_255/0.7),0_1px_2px_rgb(9_9_11/0.06),0_16px_40px_-12px_rgb(9_9_11/0.22)] ' +
  'dark:shadow-[inset_0_1px_0_rgb(255_255_255/0.06),0_1px_2px_rgb(0_0_0/0.5),0_24px_56px_-16px_rgb(0_0_0/0.8)]';

/*
  Кнопка под курсором заливается красным знака.

  Заливка — проявление слоя, а не шторка слева направо. Шторка в тёмной теме
  на полпути давала белый текст на ещё белом фоне: буквы пропадали на треть
  секунды. Проявление меняет фон и цвет текста одной длительностью, и такого
  промежутка нет вовсе.
*/
export const SUBMIT =
  'group relative isolate overflow-hidden h-10 w-full inline-flex items-center ' +
  'justify-center gap-2 rounded-lg text-sm font-medium ' +
  // Обводка в цвет противоположной темы. В покое она сливается с кнопкой —
  // и это нормально: её работа начинается, когда кнопка залилась красным,
  // и заливке нужен край. Слой заливки лежит внутри рамки, не поверх.
  'border border-zinc-900 dark:border-white ' +
  'bg-zinc-900 text-zinc-50 dark:bg-zinc-50 dark:text-zinc-900 ' +
  'shadow-[inset_0_1px_0_rgb(255_255_255/0.14),0_1px_2px_rgb(9_9_11/0.3)] ' +
  'dark:shadow-[inset_0_1px_0_rgb(255_255_255/0.6),0_1px_2px_rgb(0_0_0/0.4)] ' +
  'transition-colors duration-[320ms] ease-[cubic-bezier(0.2,0,0,1)] ' +
  'hover:text-white dark:hover:text-white ' +
  'disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer ' +
  'outline-none focus-visible:ring-[3px] focus-visible:ring-zinc-900/20 dark:focus-visible:ring-white/20';

/** Слой заливки. Его рисуем только на живой кнопке: гаснущая кнопка не
 *  должна отзываться на курсор — это обещание действия, которого не будет. */
export const FILL =
  'absolute inset-0 -z-10 bg-brand opacity-0 ' +
  'transition-opacity duration-[320ms] ease-[cubic-bezier(0.2,0,0,1)] ' +
  'group-hover:opacity-100 group-focus-visible:opacity-100';

export const LINK =
  'text-xs text-zinc-600 dark:text-zinc-400 hover:text-zinc-950 dark:hover:text-zinc-100 ' +
  'underline underline-offset-4 decoration-zinc-300 dark:decoration-zinc-700 ' +
  'transition-colors duration-150 cursor-pointer outline-none ' +
  'focus-visible:ring-[3px] focus-visible:ring-zinc-900/15 dark:focus-visible:ring-white/15 rounded-sm';

export const SWITCH =
  'px-2 py-0.5 rounded-md text-[11px] font-medium transition-colors duration-150 cursor-pointer';
