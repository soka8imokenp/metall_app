import React, { useState, useMemo } from 'react';
import {
  Columns3,
  GripVertical,
  ChevronDown,
  AlertCircle,
  ArrowUpRight,
  RefreshCw,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import { useDashboard, errorText } from '../../context/DashboardContext';
import { ApiError } from '../../lib/api-client';
import { DashboardPlanRow, DashboardPlanTab } from '../../types/api';
import { formatDate, formatQty, formatUnit, toNumber } from '../../lib/formatters';

export interface DocumentItem {
  id: string;
  header: string;
  sectionType: string;
  status: 'done' | 'in_process';
  target: number;
  limit: number;
  reviewer: string;
  category: 'outline' | 'past_perf' | 'key_personnel' | 'focus_docs';
  specNumber?: string;
  /**
   * Чей это номер. Строка плана — всегда заказ: цеховой или покупателя, и по
   * номеру переходят в его раздел. Без вида переход не собрать: один и тот же
   * номер в двух разделах — разные записи.
   */
  kind?: 'production' | 'supply';
  description?: string;
  unit?: 'т' | 'п.м.' | 'шт';
  enterprise?: 'plant' | 'trade';
  customer?: string;
  priority?: 'standard' | 'urgent';
  steelGrade?: string;
  size?: string;
}

/** Вкладки экрана. Данными обеспечены только первые две. */
type PlanCategory = 'outline' | 'past_perf' | 'key_personnel' | 'focus_docs';

const TAB_TO_API: Partial<Record<PlanCategory, DashboardPlanTab>> = {
  outline: 'plan',
  past_perf: 'done',
};

/**
 * Строка плана из API в форму таблицы.
 *
 * `target` и `limit` — наследие шаблона shadcn: в этой таблице это план и факт.
 * Имена оставлены, чтобы не переписывать 700 строк разметки разом; смысл
 * задаётся здесь и только здесь.
 */
function toDocumentItem(row: DashboardPlanRow, locale: 'ru' | 'uz'): DocumentItem {
  return {
    id: row.uid,
    header: row.header,
    sectionType: row.sectionType,
    status: row.status,
    target: toNumber(row.planQty),
    limit: toNumber(row.factQty),
    reviewer: row.responsible,
    category: 'outline',
    specNumber: row.number,
    kind: row.kind,
    description:
      row.kind === 'production'
        ? `${locale === 'uz' ? 'Ishlab chiqarish buyurtmasi' : 'Заказ на производство'} • ${row.customer}`
        : `${locale === 'uz' ? 'Xaridor buyurtmasi' : 'Заказ покупателя'} • ${row.customer}`,
    unit: formatUnit(row.unit, locale) as DocumentItem['unit'],
    enterprise: row.enterprise === 'plant' ? 'plant' : 'trade',
    customer: row.customer,
    priority: row.priority,
    size: row.dueDate ? formatDate(row.dueDate) : undefined,
  };
}

/**
 * Почему таблица пуста. Состояния различаются намеренно: «идёт загрузка»,
 * «сервер не ответил», «вкладку нечем наполнить» и «данных за период нет» —
 * это четыре разные новости для пользователя, а не один серый прочерк.
 */
type EmptyState = 'loading' | 'error' | 'no_source' | 'empty';

const EmptyRow: React.FC<{
  state: EmptyState;
  isUz: boolean;
  error: ApiError | null;
  onRetry: () => void;
}> = ({ state, isUz, error, onRetry }) => {
  if (state === 'loading') {
    return (
      <div className="flex flex-col gap-2.5 animate-pulse" aria-hidden>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex items-center gap-3">
            <span className="h-3 flex-1 rounded bg-zinc-100 dark:bg-zinc-800" />
            <span className="h-3 w-24 rounded bg-zinc-100 dark:bg-zinc-800" />
            <span className="h-3 w-16 rounded bg-zinc-100 dark:bg-zinc-800" />
          </div>
        ))}
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div role="alert" className="flex flex-col sm:flex-row sm:items-center gap-3">
        <AlertCircle className="w-4 h-4 text-red-600 dark:text-red-400 shrink-0" />
        <span className="flex-1 min-w-0 text-xs text-red-700 dark:text-red-300 break-words">
          {error ? errorText(error, isUz) : isUz ? 'Xatolik' : 'Ошибка'}
        </span>
        <button
          type="button"
          onClick={onRetry}
          className="h-7 px-2.5 inline-flex items-center gap-1.5 rounded-lg border border-red-300 dark:border-red-800 text-[11px] font-medium text-red-900 dark:text-red-200 hover:bg-red-50 dark:hover:bg-red-900/40 transition-colors cursor-pointer shrink-0"
        >
          <RefreshCw className="w-3 h-3" />
          {isUz ? 'Qayta urinish' : 'Повторить'}
        </button>
      </div>
    );
  }

  if (state === 'no_source') {
    return (
      <div className="flex flex-col items-center gap-1.5 text-center">
        <span className="text-xs font-medium text-zinc-600 dark:text-zinc-300">
          {isUz ? 'Bu bo‘lim uchun ma’lumot manbasi yo‘q' : 'Для этого раздела нет источника данных'}
        </span>
        <span className="max-w-md text-[11px] leading-relaxed text-zinc-400 dark:text-zinc-500">
          {isUz
            ? 'Smenalar, xodimlar va GOST reglamentlari ma’lumotlar modelida hali yo‘q. Bo‘limni to‘ldirish — buyurtmachining qarori (04-API-CONTRACT.md §14.1).'
            : 'Смен, персонала и регламентов ГОСТ нет в модели данных. Наполнять раздел или убрать его — решение заказчика (04-API-CONTRACT.md §14.1).'}
        </span>
      </div>
    );
  }

  return (
    <span className="block text-center text-xs text-zinc-400 dark:text-zinc-500">
      {isUz ? 'Ushbu bo‘limda yozuvlar yo‘q' : 'В этом разделе нет записей'}
    </span>
  );
};

export const DataTableSection: React.FC = () => {
  const { locale, company, jumpToSearch } = useApp();
  const { can } = useAuth();
  const isUz = locale === 'uz';

  const { plan, planTab, setPlanTab, reloadPlan } = useDashboard();

  /**
   * Куда ведёт номер в строке.
   *
   * Строка плана — заказ, и переход открывает его собственный раздел тем же
   * способом, которым это делает общее окно поиска: раздел подставляет номер
   * себе в строку и сужает список до одной записи. Раньше здесь открывалось
   * окно прослеживаемости партии, и ему передавали номер заказа — партии с
   * таким идентификатором нет, окно отвечало отказом всегда. Партия и заказ —
   * разные записи, и uid партии в данных плана не приходит вовсе.
   */
  const target = (row: DocumentItem) =>
    row.kind === 'production'
      ? ({ module: 'production', permission: 'production.view' } as const)
      : ({ module: 'sales', permission: 'sales.view' } as const);

  /** Номер — ссылка только тому, кому открыт раздел заказа. */
  const canOpen = (row: DocumentItem) => Boolean(row.specNumber && row.kind && can(target(row).permission));

  const openOrder = (row: DocumentItem) => {
    if (!canOpen(row)) return;
    jumpToSearch({ module: target(row).module, view: 'orders', query: row.specNumber! });
  };

  const [activeTab, setActiveTabState] = useState<PlanCategory>('outline');

  // Вкладка экрана и вкладка запроса связаны: две вкладки из четырёх
  // обеспечены данными, остальные данных не запрашивают вовсе.
  const setActiveTab = (tab: PlanCategory) => {
    setActiveTabState(tab);
    const apiTab = TAB_TO_API[tab];
    if (apiTab && apiTab !== planTab) setPlanTab(apiTab);
  };

  const documents: DocumentItem[] = useMemo(
    () => (plan.data ?? []).map((row) => toDocumentItem(row, locale)),
    [plan.data, locale],
  );

  // Column visibility controls
  const [columnsVisibility, setColumnsVisibility] = useState({
    header: true,
    sectionType: true,
    status: true,
    target: true,
    limit: true,
    reviewer: true,
  });

  const [isCustomizeOpen, setIsCustomizeOpen] = useState(false);

  // Filter documents based on active tab and company context
  const filteredData = useMemo(() => {
    // Вкладки без источника данных ничего не показывают — и говорят об этом
    // отдельным состоянием ниже, а не пустой таблицей.
    if (!TAB_TO_API[activeTab]) return [];

    return documents.filter((doc) => {
      // Разрез по предприятию из сайдбара:
      // 'all' -> show all documents across both businesses
      // 'company_factory' -> only show plant documents
      // 'company_trade' -> only show trade documents
      if (company === 'company_factory') {
        return doc.enterprise === 'plant';
      }
      if (company === 'company_trade') {
        return doc.enterprise === 'trade';
      }
      return true;
    });
  }, [documents, activeTab, company]);

  const emptyState: EmptyState = !TAB_TO_API[activeTab]
    ? 'no_source'
    : plan.error
      ? 'error'
      : plan.data === null || plan.isLoading
        ? 'loading'
        : 'empty';

  const toggleColumn = (key: keyof typeof columnsVisibility) => {
    setColumnsVisibility((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  };


  const renderStatusBadge = (status: DocumentItem['status']) => {
    if (status === 'done') {
      return (
        <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-zinc-950 dark:text-zinc-50">
          <span className="w-1.5 h-1.5 rounded-full bg-zinc-900 dark:bg-zinc-100 shrink-0" />
          <span>{isUz ? 'Bajarildi' : 'Выполнено'}</span>
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] font-normal text-zinc-500 dark:text-zinc-400">
        <span className="w-1.5 h-1.5 rounded-full bg-zinc-400 dark:bg-zinc-600 shrink-0" />
        <span>{isUz ? 'Jarayonda' : 'В производстве'}</span>
      </span>
    );
  };

  return (
    <div className="flex flex-col gap-3">
      {/* Top Filter Bar: Tab pills on left, Actions on right */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-1">
        {/* Segmented Filter Group */}
        <div className="inline-flex h-8 items-center rounded-lg border border-zinc-200/80 dark:border-zinc-800/80 bg-zinc-100/60 dark:bg-zinc-900/60 p-0.5 shadow-2xs overflow-x-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setActiveTab('outline')}
            className={`h-7 px-3 rounded-md text-xs font-medium transition-all duration-150 cursor-pointer whitespace-nowrap flex items-center select-none ${
              activeTab === 'outline'
                ? 'bg-white dark:bg-zinc-800 text-zinc-950 dark:text-zinc-50 shadow-2xs'
                : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
            }`}
          >
            <span>{isUz ? 'Ishlab chiqarish rejasi' : 'План производства'}</span>
          </button>

          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setActiveTab('past_perf')}
            className={`h-7 px-3 rounded-md text-xs font-medium transition-all duration-150 cursor-pointer whitespace-nowrap flex items-center select-none ${
              activeTab === 'past_perf'
                ? 'bg-white dark:bg-zinc-800 text-zinc-950 dark:text-zinc-50 shadow-2xs'
                : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
            }`}
          >
            <span>{isUz ? 'Bajarilgan partiyalar' : 'Выполненные партии'}</span>
          </button>

          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setActiveTab('key_personnel')}
            className={`h-7 px-3 rounded-md text-xs font-medium transition-all duration-150 cursor-pointer whitespace-nowrap flex items-center select-none ${
              activeTab === 'key_personnel'
                ? 'bg-white dark:bg-zinc-800 text-zinc-950 dark:text-zinc-50 shadow-2xs'
                : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
            }`}
          >
            <span>{isUz ? 'Smenalar & Xodimlar' : 'Смены и персонал'}</span>
          </button>

          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setActiveTab('focus_docs')}
            className={`h-7 px-3 rounded-md text-xs font-medium transition-all duration-150 cursor-pointer whitespace-nowrap flex items-center select-none ${
              activeTab === 'focus_docs'
                ? 'bg-white dark:bg-zinc-800 text-zinc-950 dark:text-zinc-50 shadow-2xs'
                : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
            }`}
          >
            <span>{isUz ? 'GOST va Hujjatlar' : 'ГОСТы и регламенты'}</span>
          </button>
        </div>

        {/* Right Actions: Customize Columns dropdown + Add Section button */}
        <div className="flex items-center gap-2 relative">
          {/* Customize Columns Button */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setIsCustomizeOpen((prev) => !prev)}
              className="h-8 flex items-center gap-1.5 px-3 rounded-lg border border-zinc-200 dark:border-zinc-800 text-xs font-medium text-zinc-700 dark:text-zinc-300 bg-white dark:bg-zinc-900 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors cursor-pointer shadow-2xs"
            >
              <Columns3 size={13} className="text-zinc-500 dark:text-zinc-400" />
              <span>{isUz ? 'Ustunlar' : 'Колонки'}</span>
              <ChevronDown size={12} className="text-zinc-400" />
            </button>

            {/* Customize Columns Dropdown Menu */}
            {isCustomizeOpen && (
              <>
                <div
                  className="fixed inset-0 z-20"
                  onClick={() => setIsCustomizeOpen(false)}
                />
                <div className="absolute right-0 top-9 w-60 bg-white dark:bg-[#18181b] border border-zinc-200 dark:border-zinc-800 rounded-xl shadow-lg p-2.5 z-30 text-xs flex flex-col gap-1.5">
                  <div className="flex items-center justify-between px-2 py-1 border-b border-zinc-100 dark:border-zinc-800 pb-1.5">
                    <span className="text-[11px] font-semibold text-zinc-950 dark:text-zinc-50">
                      {isUz ? 'Ustunlar sozlamasi' : 'Настройка колонок'}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setColumnsVisibility({
                          header: true,
                          sectionType: true,
                          status: true,
                          target: true,
                          limit: true,
                          reviewer: true,
                        })
                      }
                      className="text-[10px] text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 cursor-pointer"
                    >
                      {isUz ? 'Tiklash' : 'Сброс'}
                    </button>
                  </div>

                  <label className="flex items-center gap-2 px-2 py-1 hover:bg-zinc-50 dark:hover:bg-zinc-800 rounded-md cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={columnsVisibility.header}
                      onChange={() => toggleColumn('header')}
                      className="rounded border-zinc-300 dark:border-zinc-700 cursor-pointer"
                    />
                    <span className="text-zinc-800 dark:text-zinc-200">
                      {isUz ? 'Nomi' : 'Наименование'}
                    </span>
                  </label>

                  <label className="flex items-center gap-2 px-2 py-1 hover:bg-zinc-50 dark:hover:bg-zinc-800 rounded-md cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={columnsVisibility.sectionType}
                      onChange={() => toggleColumn('sectionType')}
                      className="rounded border-zinc-300 dark:border-zinc-700 cursor-pointer"
                    />
                    <span className="text-zinc-800 dark:text-zinc-200">
                      {isUz ? 'Turi' : 'Тип продукции'}
                    </span>
                  </label>

                  <label className="flex items-center gap-2 px-2 py-1 hover:bg-zinc-50 dark:hover:bg-zinc-800 rounded-md cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={columnsVisibility.status}
                      onChange={() => toggleColumn('status')}
                      className="rounded border-zinc-300 dark:border-zinc-700 cursor-pointer"
                    />
                    <span className="text-zinc-800 dark:text-zinc-200">
                      {isUz ? 'Holat' : 'Статус'}
                    </span>
                  </label>

                  <label className="flex items-center gap-2 px-2 py-1 hover:bg-zinc-50 dark:hover:bg-zinc-800 rounded-md cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={columnsVisibility.target}
                      onChange={() => toggleColumn('target')}
                      className="rounded border-zinc-300 dark:border-zinc-700 cursor-pointer"
                    />
                    <span className="text-zinc-800 dark:text-zinc-200">
                      {isUz ? 'Reja' : 'План'}
                    </span>
                  </label>

                  <label className="flex items-center gap-2 px-2 py-1 hover:bg-zinc-50 dark:hover:bg-zinc-800 rounded-md cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={columnsVisibility.limit}
                      onChange={() => toggleColumn('limit')}
                      className="rounded border-zinc-300 dark:border-zinc-700 cursor-pointer"
                    />
                    <span className="text-zinc-800 dark:text-zinc-200">
                      {isUz ? 'Fakt' : 'Факт'}
                    </span>
                  </label>

                  <label className="flex items-center gap-2 px-2 py-1 hover:bg-zinc-50 dark:hover:bg-zinc-800 rounded-md cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={columnsVisibility.reviewer}
                      onChange={() => toggleColumn('reviewer')}
                      className="rounded border-zinc-300 dark:border-zinc-700 cursor-pointer"
                    />
                    <span className="text-zinc-800 dark:text-zinc-200">
                      {isUz ? 'Mas’ul' : 'Ответственный'}
                    </span>
                  </label>
                </div>
              </>
            )}
          </div>

          {/*
            Таблица только на чтение: в контракте (04-API-CONTRACT.md §14.1) для
            плана определены лишь GET-эндпоинты. Создание и правка спецификаций
            появятся вместе с записью на бэкенде, кнопка «в никуда» здесь не стоит.
          */}
          <button
            type="button"
            onClick={reloadPlan}
            disabled={plan.isLoading}
            className="h-8 flex items-center gap-1.5 px-3 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 text-xs font-medium hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer shadow-2xs"
          >
            <RefreshCw
              size={13}
              className={`stroke-[2.2] text-zinc-600 dark:text-zinc-300 ${plan.isLoading ? 'animate-spin' : ''}`}
            />
            <span>{isUz ? 'Yangilash' : 'Обновить'}</span>
          </button>
        </div>
      </div>

      {/* Dense hairline-separated table */}
      <div className="rounded-xl border border-zinc-200 dark:border-zinc-800/80 bg-white dark:bg-[#18181b] overflow-hidden shadow-2xs min-h-[385px] flex flex-col justify-between">
        <div className="overflow-x-auto flex-1">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="border-b border-zinc-200 dark:border-zinc-800/80 bg-zinc-50/70 dark:bg-zinc-900/50 text-zinc-500 dark:text-zinc-400 font-medium h-9">
                <th className="w-8 pl-3.5 pr-1"></th>
                {columnsVisibility.header && (
                  <th className="px-4 py-2 font-medium">
                    {isUz ? 'Nomi va shifr' : 'Наименование и шифр'}
                  </th>
                )}
                {columnsVisibility.sectionType && (
                  <th className="px-4 py-2 font-medium">
                    {isUz ? 'Turi' : 'Тип'}
                  </th>
                )}
                {columnsVisibility.status && (
                  <th className="px-4 py-2 font-medium">
                    {isUz ? 'Holat' : 'Статус'}
                  </th>
                )}
                {columnsVisibility.target && (
                  <th className="px-4 py-2 text-right font-medium">
                    {isUz ? 'Reja' : 'План'}
                  </th>
                )}
                {columnsVisibility.limit && (
                  <th className="px-4 py-2 text-right font-medium">
                    {isUz ? 'Fakt' : 'Факт'}
                  </th>
                )}
                {columnsVisibility.reviewer && (
                  <th className="px-4 py-2 font-medium">
                    {isUz ? 'Mas’ul' : 'Ответственный'}
                  </th>
                )}
                <th className="w-8 px-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/60">
              {filteredData.map((row) => {
                return (
                  <tr
                    key={row.id}
                    className="h-12 transition-colors hover:bg-zinc-50/80 dark:hover:bg-zinc-800/40"
                  >
                    {/* Drag Grip icon */}
                    <td className="w-8 pl-3.5 pr-1 text-zinc-300 dark:text-zinc-600 hover:text-zinc-500 cursor-grab">
                      <GripVertical size={13} />
                    </td>

                    {/* Header & Subtitle info */}
                    {columnsVisibility.header && (
                      <td className="px-4 py-2 font-medium text-zinc-950 dark:text-zinc-50">
                        <div className="flex items-center gap-2">
                          <span className="truncate max-w-[280px] sm:max-w-[360px]">{row.header}</span>
                          {row.priority === 'urgent' && (
                            <span className="text-[9px] uppercase tracking-wider font-semibold px-1.5 py-0.2 rounded bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 shrink-0">
                              {isUz ? 'Shoshilinch' : 'Срочно'}
                            </span>
                          )}
                        </div>
                        <div className="text-[10px] text-zinc-400 font-normal mt-0.5 flex items-center gap-1.5 flex-wrap">
                          {row.specNumber &&
                            (canOpen(row) ? (
                              <button
                                type="button"
                                onClick={() => openOrder(row)}
                                title={
                                  row.kind === 'production'
                                    ? isUz
                                      ? 'Ishlab chiqarish buyurtmasini ochish'
                                      : 'Открыть заказ цеха'
                                    : isUz
                                      ? 'Xaridor buyurtmasini ochish'
                                      : 'Открыть заказ покупателя'
                                }
                                className="font-mono text-zinc-500 dark:text-zinc-400 hover:text-zinc-950 dark:hover:text-zinc-100 hover:underline cursor-pointer"
                              >
                                {row.specNumber}
                              </button>
                            ) : (
                              // Права на раздел нет — номер остаётся номером, а не
                              // ссылкой в пустоту.
                              <span className="font-mono text-zinc-500 dark:text-zinc-400">{row.specNumber}</span>
                            ))}
                          {row.customer && <span>• {row.customer}</span>}
                          {row.enterprise && (
                            <span className="text-zinc-500 dark:text-zinc-400">
                              {/* Короткое имя юрлица, а не внутренний код:
                                  в строке таблицы место на два-три слова.
                                  Оба написания нужны: под узбекским русское
                                  название ловит прогон `qa/web-uz`. */}
                              •{' '}
                              {row.enterprise === 'plant'
                                ? isUz
                                  ? 'TIZ'
                                  : 'ТИЗ'
                                : isUz
                                  ? 'Metall Asia'
                                  : 'Металл Азия'}
                            </span>
                          )}
                        </div>
                      </td>
                    )}

                    {/* Section Type: clean typography without pill border */}
                    {columnsVisibility.sectionType && (
                      <td className="px-4 py-2 whitespace-nowrap text-xs text-zinc-600 dark:text-zinc-400 font-normal">
                        {row.sectionType}
                      </td>
                    )}

                    {/* Status Badge */}
                    {columnsVisibility.status && (
                      <td className="px-4 py-2 whitespace-nowrap">
                        {renderStatusBadge(row.status)}
                      </td>
                    )}

                    {/* Target */}
                    {columnsVisibility.target && (
                      <td className="px-4 py-2 text-right font-medium tabular-nums text-zinc-900 dark:text-zinc-100 whitespace-nowrap">
                        {formatQty(row.target)} {row.unit || (isUz ? 't' : 'т')}
                      </td>
                    )}

                    {/* Limit */}
                    {columnsVisibility.limit && (
                      <td className="px-4 py-2 text-right font-medium tabular-nums text-zinc-500 dark:text-zinc-400 whitespace-nowrap">
                        {formatQty(row.limit)} {row.unit || (isUz ? 't' : 'т')}
                      </td>
                    )}

                    {/* Reviewer */}
                    {columnsVisibility.reviewer && (
                      <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300 whitespace-nowrap">
                        {row.reviewer}
                      </td>
                    )}

                    {/*
                      Из меню строки осталось единственное действие, у которого
                      есть чем подтвердиться, — переход в сам заказ.
                      «Отметить выполненным» и «Удалить» писали в локальный массив
                      и исчезали при перезагрузке; эндпоинтов записи в контракте нет.
                      Прослеживаемость партии отсюда не открыть: это другая запись,
                      и её uid в плане не приходит. Цепочка партии — в разделе
                      «Склад», от самой партии.
                    */}
                    <td className="w-8 px-2 text-right">
                      {canOpen(row) && (
                        <button
                          type="button"
                          onClick={() => openOrder(row)}
                          title={isUz ? 'Buyurtmani ochish' : 'Открыть заказ'}
                          className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 p-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                        >
                          <ArrowUpRight size={13} />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}

              {filteredData.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-8">
                    <EmptyRow
                      state={emptyState}
                      isUz={isUz}
                      error={plan.error}
                      onRetry={reloadPlan}
                    />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

    </div>
  );
};
