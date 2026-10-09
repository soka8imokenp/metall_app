/**
 * Таблица отчёта: то же, что уходит в файл.
 *
 * Колонки и строки приходят с сервера, экран их не пересобирает — иначе на
 * экране одно, а в Excel другое, и спорить об этом придётся с клиентом.
 *
 * Вбок отчёт не едет. Прокрутка прячет правый край: человек видит «Наличие»,
 * не видит «Доступно» и сверяет не то. Ширину держат сами колонки — подписи и
 * текст переносятся, числа остаются одной строкой и выровнены по разряду.
 * Ниже `lg` строка становится карточкой «подпись — значение» в том же порядке,
 * что колонки: порядок и есть то, по чему сверяют выгрузку.
 *
 * Общий на склад и CRM: два похожих куска вёрстки разошлись бы, и один отчёт
 * начал бы прятать правый край, пока второй его показывает.
 */

import React from 'react';
import { formatNumber } from '../../lib/formatters';

export interface ReportColumnView {
  title: string;
  numeric?: boolean;
  width?: number;
}

/** Число форматирует экран, а не сервер: в файл уходит настоящее число. */
const cellText = (value: string | number | null): string => {
  if (value === null || value === '') return '—';
  return typeof value === 'number' ? formatNumber(value) : value;
};

export const ReportTable: React.FC<{
  columns: ReportColumnView[];
  rows: (string | number | null)[][];
}> = ({ columns, rows }) => (
  <>
    <div className="hidden lg:block">
      <table className="w-full text-left text-xs border-collapse px-4 [&_th:last-child]:pr-4 [&_td:last-child]:pr-4 [&_th:first-child]:pl-4 [&_td:first-child]:pl-4">
        <thead>
          <tr className="border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50/70 dark:bg-zinc-900/50 text-zinc-500 font-medium">
            {columns.map((c, i) => (
              <th
                key={i}
                className={`px-2 py-2 align-bottom leading-tight ${
                  c.numeric ? 'text-right whitespace-nowrap' : 'break-words'
                }`}
              >
                {c.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800/60">
          {rows.map((row, r) => (
            <tr key={r} className="hover:bg-zinc-50/80 dark:hover:bg-zinc-800/40 transition-colors">
              {row.map((value, i) => (
                <td
                  key={i}
                  className={`px-2 py-1.5 align-top ${
                    columns[i]?.numeric
                      ? 'text-right whitespace-nowrap font-mono tabular-nums text-zinc-800 dark:text-zinc-200'
                      : 'break-words text-zinc-700 dark:text-zinc-300'
                  }`}
                >
                  {cellText(value)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>

    <ul className="lg:hidden divide-y divide-zinc-200 dark:divide-zinc-800/60">
      {rows.map((row, r) => (
        <li key={r} className="px-4 py-3">
          <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
            {row.map((value, i) => {
              const column = columns[i];
              if (!column) return null;
              return (
                <React.Fragment key={i}>
                  <dt className="text-[11px] text-zinc-500 break-words">{column.title}</dt>
                  <dd
                    className={
                      column.numeric
                        ? 'text-end font-mono tabular-nums text-zinc-900 dark:text-zinc-100'
                        : 'text-start text-zinc-700 dark:text-zinc-300'
                    }
                  >
                    {cellText(value)}
                  </dd>
                </React.Fragment>
              );
            })}
          </dl>
        </li>
      ))}
    </ul>
  </>
);
