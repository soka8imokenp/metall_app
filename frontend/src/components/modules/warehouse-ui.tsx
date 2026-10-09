/**
 * Общая мелочь экранов склада: классы карточки, кнопок и поля, а также три
 * состояния списка — ошибка, пусто, загрузка.
 *
 * Вынесено сюда не ради красоты. Склад давно не один файл: остатки и журнал,
 * этикетки со сканером, потребность в закупке. Каждый новый файл либо тащил бы
 * вторую копию этих сорока строк — и она разошлась бы с первой на первой же
 * правке отступа, — либо импортировал бы их из `WarehouseView`, замкнув импорт
 * в кольцо: тот сам показывает эти панели.
 *
 * Здесь только разметка без данных: ни одного запроса и ни одного состояния
 * страницы. Иначе это был бы ещё один контекст, а он уже есть.
 */

import React from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';

export const CARD =
  'rounded-xl border border-zinc-200 dark:border-zinc-800/80 bg-white dark:bg-[#18181b] shadow-2xs';

export const BTN_BASE =
  'px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-40 ' +
  'disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400';
export const BTN_PRIMARY =
  BTN_BASE +
  ' bg-zinc-900 text-zinc-50 hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200';
export const BTN_GHOST =
  BTN_BASE +
  ' border border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300 ' +
  'hover:bg-zinc-100 dark:hover:bg-zinc-800';

export const FIELD =
  'w-full h-8 px-2.5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white ' +
  'dark:bg-zinc-900 text-xs text-zinc-950 dark:text-zinc-50 placeholder:text-zinc-400 ' +
  'focus:outline-hidden focus:border-zinc-400 transition-colors shadow-2xs';

export const ErrorBox: React.FC<{ text: string; onRetry?: () => void; isUz: boolean }> = ({
  text,
  onRetry,
  isUz,
}) => (
  <div role="alert" className="flex flex-col items-center justify-center gap-2 p-6 text-center">
    <AlertCircle className="w-5 h-5 text-red-600 dark:text-red-400" />
    <p className="text-xs text-red-700 dark:text-red-300 break-words max-w-full">{text}</p>
    {onRetry && (
      <button
        type="button"
        onClick={onRetry}
        className="h-7 px-3 inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 dark:border-zinc-800 text-[11px] font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
      >
        <RefreshCw className="w-3 h-3" />
        {isUz ? 'Qayta urinish' : 'Повторить'}
      </button>
    )}
  </div>
);

export const Empty: React.FC<{ text: string }> = ({ text }) => (
  <div className="flex items-center justify-center p-8 text-center text-xs text-zinc-400">
    {text}
  </div>
);

export const Skeleton: React.FC<{ rows?: number }> = ({ rows = 6 }) => (
  <div className="divide-y divide-zinc-200 dark:divide-zinc-800/60" aria-hidden>
    {Array.from({ length: rows }).map((_, i) => (
      <div key={i} className="px-4 py-3 flex items-center gap-3 animate-pulse">
        <div className="h-3 w-24 rounded bg-zinc-200 dark:bg-zinc-800" />
        <div className="h-3 flex-1 rounded bg-zinc-200 dark:bg-zinc-800" />
        <div className="h-3 w-16 rounded bg-zinc-200 dark:bg-zinc-800" />
      </div>
    ))}
  </div>
);
