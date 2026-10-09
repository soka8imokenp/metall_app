/**
 * Потребность в закупке (ТЗ 5.10).
 *
 * Отчёт отвечает на один вопрос: что дозаказать и сколько. Поэтому главная
 * колонка здесь — «дозаказать», а не остаток: остаток человек уже посмотрел на
 * соседней вкладке.
 *
 * Четыре числа в строке — не избыток. «Дозаказать 27 тонн» без объяснения
 * читается как ошибка, когда на складе лежат двести: закупщик должен видеть
 * цепочку целиком — лежит, обещано, доступно, план цеха. Считает их сервер,
 * экран ничего не пересчитывает: вторая копия правила разошлась бы с первой.
 *
 * Уровни отчёт только показывает. Править их пока негде — справочники на
 * запись идут отдельным этапом, и кнопки «поменять уровень» здесь нет
 * сознательно: поле, которое некуда сохранить, хуже его отсутствия.
 */

import React from 'react';
import { AlertTriangle, Layers, Warehouse as WarehouseIcon } from 'lucide-react';
import { errorText } from '../../context/DashboardContext';
import { useWarehouse } from '../../context/WarehouseContext';
import type { WarehousePurchaseNeedRow } from '../../types/api';
import { formatQty, formatUnit, toNumber, refName } from '../../lib/formatters';
import { Empty, ErrorBox, Skeleton } from './warehouse-ui';

/**
 * Состояние строки. Цвет несёт тот же смысл, что и слово: красное встало,
 * жёлтое ещё едет, серое просто посчитано.
 */
const STATE: Record<
  WarehousePurchaseNeedRow['state'],
  { ru: string; uz: string; tone: string }
> = {
  critical: {
    ru: 'Критический',
    uz: 'Kritik',
    tone: 'text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-900/60',
  },
  below_min: {
    ru: 'Ниже минимума',
    uz: 'Minimumdan past',
    tone: 'text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-900/60',
  },
  ok: {
    ru: 'В норме',
    uz: 'Normada',
    tone: 'text-zinc-600 dark:text-zinc-400 bg-zinc-50 dark:bg-zinc-900/60 border-zinc-200 dark:border-zinc-800',
  },
};

const StateChip: React.FC<{ state: WarehousePurchaseNeedRow['state']; isUz: boolean }> = ({
  state,
  isUz,
}) => (
  <span
    className={`inline-flex items-center h-5 px-2 rounded-md border text-[10px] font-medium whitespace-nowrap ${STATE[state].tone}`}
  >
    {isUz ? STATE[state].uz : STATE[state].ru}
  </span>
);

/**
 * Разрез строки. Компанийская цифра — про все склады сразу, складская — про
 * один, и путать их нельзя: «не хватает на Сергели» и «не хватает в компании»
 * закупаются по-разному.
 */
const ScopeMark: React.FC<{ row: WarehousePurchaseNeedRow; isUz: boolean }> = ({ row, isUz }) =>
  row.warehouse ? (
    <span className="inline-flex items-center gap-1 text-[11px] text-zinc-600 dark:text-zinc-400 min-w-0">
      <WarehouseIcon className="w-3 h-3 shrink-0" />
      <span className="truncate">{refName(row.warehouse, isUz)}</span>
    </span>
  ) : (
    <span
      className="inline-flex items-center gap-1 text-[11px] text-zinc-500"
      title={
        isUz
          ? 'Kompaniya darajasi: barcha omborlar birga'
          : 'Уровень на компанию: все склады вместе'
      }
    >
      <Layers className="w-3 h-3 shrink-0" />
      {isUz ? 'Kompaniya bo‘yicha' : 'По компании'}
    </span>
  );

/** Размер металлопроката строкой — тот же вид, что и в остатках. */
const sizeText = (row: WarehousePurchaseNeedRow): string =>
  [
    row.item.steelGrade,
    row.item.diameterMm ? `⌀${row.item.diameterMm}` : null,
    row.item.wallThicknessMm ? `×${row.item.wallThicknessMm}` : null,
  ]
    .filter(Boolean)
    .join(' ');

/**
 * Почему дозаказ такой. Одна строка вместо четырёх колонок на узком экране —
 * и она же подсказка к колонке «дозаказать» на широком.
 */
function whyText(row: WarehousePurchaseNeedRow, isUz: boolean, unit: string): string {
  const parts = [
    `${isUz ? 'omborda' : 'на складе'} ${formatQty(row.onHand)}`,
    `${isUz ? 'zaxirada' : 'в резерве'} ${formatQty(row.promised)}`,
  ];
  if (toNumber(row.plannedOut) > 0) {
    parts.push(`${isUz ? 'sex rejasi' : 'план цеха'} ${formatQty(row.plannedOut)}`);
  }
  const target = toNumber(row.minQty) > 0 ? row.minQty : row.criticalQty;
  parts.push(`${isUz ? 'daraja' : 'уровень'} ${formatQty(target)}`);
  return `${parts.join(', ')} ${unit}`;
}

export const NeedsPanel: React.FC<{ isUz: boolean }> = ({ isUz }) => {
  const { needs, reloadNeeds, needsState, setNeedsState, needsAll, setNeedsAll } = useWarehouse();

  const rows = needs.data?.rows ?? [];
  const totals = needs.data?.totals;

  const filters: [null | 'critical' | 'below_min', string][] = [
    [null, isUz ? 'Hammasi' : 'Все'],
    ['critical', isUz ? 'Kritik' : 'Критические'],
    ['below_min', isUz ? 'Minimumdan past' : 'Ниже минимума'],
  ];

  return (
    <div
      role="tabpanel"
      aria-label={isUz ? 'Xarid ehtiyoji' : 'Потребность в закупке'}
      className="flex flex-col min-w-0"
    >
      <div className="px-4 py-3 flex flex-wrap items-center gap-2 border-b border-zinc-200 dark:border-zinc-800">
        <div className="flex flex-wrap items-center gap-1">
          {filters.map(([value, text]) => (
            <button
              key={value ?? 'all'}
              type="button"
              aria-pressed={needsState === value}
              onClick={() => setNeedsState(value)}
              className={`h-7 px-2.5 rounded-lg border text-[11px] font-medium transition-colors cursor-pointer ${
                needsState === value
                  ? 'border-zinc-900 dark:border-zinc-100 bg-zinc-900 text-zinc-50 dark:bg-zinc-50 dark:text-zinc-900'
                  : 'border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800'
              }`}
            >
              {text}
            </button>
          ))}
        </div>

        {/* «Показать все» — не фильтр состояния, а другой вопрос: не «что
            горит», а «как стоят уровни». Поэтому отдельной кнопкой справа. */}
        <button
          type="button"
          aria-pressed={needsAll}
          onClick={() => setNeedsAll(!needsAll)}
          className={`h-7 px-2.5 rounded-lg border text-[11px] font-medium transition-colors cursor-pointer sm:ml-auto ${
            needsAll
              ? 'border-zinc-400 dark:border-zinc-600 bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100'
              : 'border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800'
          }`}
        >
          {isUz ? 'Normadagilar bilan' : 'С теми, что в норме'}
        </button>
      </div>

      {/* Счётчики считают тревогу, а не показанные строки: включив «с теми, что
          в норме», человек не должен решить, что тревог стало больше. */}
      {totals && (
        <div className="px-4 py-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-zinc-500 border-b border-zinc-200 dark:border-zinc-800/60">
          <span>
            {isUz ? 'Xaridga' : 'К закупке'}:{' '}
            <span className="font-medium text-zinc-800 dark:text-zinc-200 tabular-nums">
              {totals.rows}
            </span>
          </span>
          <span className="text-red-700 dark:text-red-400">
            {isUz ? 'kritik' : 'критических'}:{' '}
            <span className="font-medium tabular-nums">{totals.critical}</span>
          </span>
          <span className="text-amber-700 dark:text-amber-400">
            {isUz ? 'minimumdan past' : 'ниже минимума'}:{' '}
            <span className="font-medium tabular-nums">{totals.belowMin}</span>
          </span>
          {totals.plannedHidden > 0 && (
            <span className="inline-flex items-center gap-1">
              <AlertTriangle className="w-3 h-3 shrink-0" />
              {isUz
                ? `${totals.plannedHidden} qatorda sex rejasi hisobga olinmadi: pozitsiya bir necha omborda`
                : `в ${totals.plannedHidden} ${totals.plannedHidden === 1 ? 'строке' : 'строках'} план цеха не учтён: позиция лежит на нескольких складах`}
            </span>
          )}
        </div>
      )}

      {needs.error ? (
        <ErrorBox text={errorText(needs.error, isUz)} onRetry={reloadNeeds} isUz={isUz} />
      ) : needs.isLoading && rows.length === 0 ? (
        <Skeleton />
      ) : rows.length === 0 ? (
        <Empty
          text={
            needsState === 'critical'
              ? isUz
                ? 'Kritik darajadan past nomenklatura yo‘q'
                : 'Позиций ниже критического уровня нет'
              : isUz
                ? 'Xarid qilish kerak bo‘lgan narsa yo‘q'
                : 'Закупать нечего: запасы выше уровней'
          }
        />
      ) : (
        <>
          {/* Узкий экран: те же данные карточками. Дозаказ — крупно справа,
              остальное объяснением под ним. */}
          <ul className="lg:hidden divide-y divide-zinc-200 dark:divide-zinc-800/60">
            {rows.map((r) => {
              const unit = formatUnit(r.item.unit, isUz ? 'uz' : 'ru');
              return (
                <li key={r.key} className="px-4 py-3 flex flex-col gap-1.5">
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100 break-words min-w-0">
                      <span className="font-mono">{r.item.code}</span> ·{' '}
                      {refName(r.item, isUz)}
                    </span>
                    <span className="text-xs font-mono tabular-nums font-bold text-zinc-950 dark:text-zinc-50 shrink-0">
                      {toNumber(r.needQty) > 0 ? `+${formatQty(r.needQty)} ${unit}` : '—'}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <StateChip state={r.state} isUz={isUz} />
                    <ScopeMark row={r} isUz={isUz} />
                    {sizeText(r) && (
                      <span className="text-[11px] text-zinc-500">{sizeText(r)}</span>
                    )}
                  </div>
                  <span className="text-[10px] text-zinc-400 break-words">
                    {whyText(r, isUz, unit)}
                  </span>
                  {!r.plannedApplied && toNumber(r.plannedCompany) > 0 && (
                    <span className="text-[10px] text-amber-700 dark:text-amber-400 break-words">
                      {isUz
                        ? `Kompaniyada sex rejasi ${formatQty(r.plannedCompany)} ${unit}: omborlarga bo‘lib berilmaydi`
                        : `План цеха по компании ${formatQty(r.plannedCompany)} ${unit}: по складам его разложить нечем`}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>

          <div className="hidden lg:block">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50/70 dark:bg-zinc-900/50 text-zinc-500 font-medium h-9">
                  <th className="px-2 py-2">{isUz ? 'Nomenklatura' : 'Номенклатура'}</th>
                  <th className="px-2 py-2">{isUz ? 'Kesim' : 'Разрез'}</th>
                  <th className="px-2 py-2 text-right">{isUz ? 'Omborda' : 'На складе'}</th>
                  <th className="px-2 py-2 text-right">{isUz ? 'Zaxirada' : 'В резерве'}</th>
                  <th className="px-2 py-2 text-right">{isUz ? 'Mavjud' : 'Доступно'}</th>
                  <th className="px-2 py-2 text-right">{isUz ? 'Sex rejasi' : 'План цеха'}</th>
                  <th className="px-2 py-2 text-right">{isUz ? 'Daraja' : 'Уровень'}</th>
                  <th className="px-2 py-2 text-right">{isUz ? 'Dozakaz' : 'Дозаказать'}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800/60">
                {rows.map((r) => {
                  const unit = formatUnit(r.item.unit, isUz ? 'uz' : 'ru');
                  return (
                    <tr
                      key={r.key}
                      className="h-10 hover:bg-zinc-50/80 dark:hover:bg-zinc-800/40 transition-colors"
                    >
                      <td className="px-2 py-2 font-medium text-zinc-900 dark:text-zinc-100">
                        <div className="flex flex-col">
                          <span className="font-mono">{r.item.code}</span>
                          <span className="text-[10px] text-zinc-400 font-normal">
                            {refName(r.item, isUz)}
                          </span>
                        </div>
                      </td>
                      <td className="px-2 py-2">
                        <div className="flex flex-col gap-1 items-start">
                          <StateChip state={r.state} isUz={isUz} />
                          <ScopeMark row={r} isUz={isUz} />
                        </div>
                      </td>
                      <td className="px-2 py-2 text-right font-mono tabular-nums text-zinc-700 dark:text-zinc-300 whitespace-nowrap">
                        {formatQty(r.onHand)}
                      </td>
                      <td className="px-2 py-2 text-right font-mono tabular-nums text-zinc-600 dark:text-zinc-400 whitespace-nowrap">
                        {formatQty(r.promised)}
                      </td>
                      {/* Доступное бывает отрицательным: обещано больше, чем
                          лежит. Минус не прячем — именно он и есть повод. */}
                      <td
                        className={`px-2 py-2 text-right font-mono tabular-nums whitespace-nowrap ${
                          toNumber(r.available) < 0
                            ? 'text-red-700 dark:text-red-400 font-bold'
                            : 'text-zinc-800 dark:text-zinc-200'
                        }`}
                      >
                        {formatQty(r.available)}
                      </td>
                      <td className="px-2 py-2 text-right font-mono tabular-nums text-zinc-600 dark:text-zinc-400 whitespace-nowrap">
                        {toNumber(r.plannedOut) > 0 ? (
                          formatQty(r.plannedOut)
                        ) : toNumber(r.plannedCompany) > 0 ? (
                          <span
                            className="text-amber-700 dark:text-amber-400"
                            title={
                              isUz
                                ? `Kompaniyada ${formatQty(r.plannedCompany)} ${unit}, lekin omborlarga bo‘lib berilmaydi: ishlab chiqarish buyurtmasi omborni ko‘rsatmaydi`
                                : `По компании ${formatQty(r.plannedCompany)} ${unit}, но по складам его разложить нечем: производственный заказ склада не называет`
                            }
                          >
                            ({formatQty(r.plannedCompany)})
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="px-2 py-2 text-right font-mono tabular-nums text-zinc-600 dark:text-zinc-400 whitespace-nowrap">
                        <div className="flex flex-col items-end">
                          <span>{formatQty(toNumber(r.minQty) > 0 ? r.minQty : r.criticalQty)}</span>
                          {toNumber(r.criticalQty) > 0 && toNumber(r.minQty) > 0 && (
                            <span className="text-[10px] text-zinc-400">
                              {isUz ? 'kritik' : 'крит.'} {formatQty(r.criticalQty)}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-2 py-2 text-right font-mono tabular-nums font-bold text-zinc-950 dark:text-zinc-50 whitespace-nowrap">
                        <div className="flex flex-col items-end">
                          <span>
                            {toNumber(r.needQty) > 0 ? `+${formatQty(r.needQty)}` : '—'}
                          </span>
                          <span className="text-[10px] font-normal text-zinc-400">{unit}</span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
};
