import React from 'react';
import { ArrowUpRight, ArrowDownRight, AlertCircle, RefreshCw } from 'lucide-react';
import { useApp, AppModule } from '../../context/AppContext';
import { useDashboard, errorText, periodLabel } from '../../context/DashboardContext';
import { DashboardKpi } from '../../types/api';
import { formatKpiValue, formatDelta } from '../../lib/formatters';

/** Модуль, на который ведёт карточка. Незнакомое имя никуда не уводит. */
const MODULES: AppModule[] = [
  'dashboard', 'sales', 'warehouse', 'production', 'finance', 'documents', 'crm', 'admin',
];
const targetOf = (kpi: DashboardKpi): AppModule =>
  MODULES.includes(kpi.targetModule as AppModule) ? (kpi.targetModule as AppModule) : 'dashboard';

const CARD_CLASS =
  'rounded-xl border border-zinc-200 dark:border-zinc-800/80 bg-white dark:bg-[#18181b] p-5 flex flex-col justify-between shadow-2xs';

const Skeleton: React.FC = () => (
  <div className={`${CARD_CLASS} animate-pulse`} aria-hidden>
    <div className="flex items-center justify-between">
      <span className="h-3 w-28 rounded bg-zinc-200 dark:bg-zinc-800" />
      <span className="h-4 w-12 rounded bg-zinc-200 dark:bg-zinc-800" />
    </div>
    <div className="my-2 h-8 w-32 rounded bg-zinc-200 dark:bg-zinc-800" />
    <div className="flex flex-col gap-1">
      <span className="h-3 w-40 rounded bg-zinc-200 dark:bg-zinc-800" />
      <span className="h-3 w-24 rounded bg-zinc-200 dark:bg-zinc-800" />
    </div>
  </div>
);

export const KpiCards: React.FC = () => {
  const { locale, setActiveModule } = useApp();
  const { summary, period, reloadSummary } = useDashboard();
  const isUz = locale === 'uz';

  if (summary.error && !summary.data) {
    return (
      <div
        role="alert"
        className="rounded-xl border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 p-5 flex flex-col sm:flex-row sm:items-center gap-3"
      >
        <AlertCircle className="w-5 h-5 text-red-600 dark:text-red-400 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-red-900 dark:text-red-200">
            {isUz ? 'Ko‘rsatkichlar yuklanmadi' : 'Показатели не загрузились'}
          </p>
          <p className="text-xs text-red-700 dark:text-red-300 break-words">
            {errorText(summary.error, isUz)}
          </p>
        </div>
        <button
          type="button"
          onClick={reloadSummary}
          className="h-8 px-3 inline-flex items-center gap-1.5 rounded-lg border border-red-300 dark:border-red-800 text-xs font-medium text-red-900 dark:text-red-200 hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors cursor-pointer shrink-0"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          {isUz ? 'Qayta urinish' : 'Повторить'}
        </button>
      </div>
    );
  }

  if (!summary.data) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} />
        ))}
      </div>
    );
  }

  return (
    <div
      className={`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 transition-opacity ${
        summary.isLoading ? 'opacity-60' : ''
      }`}
    >
      {summary.data.kpis.map((card) => {
        const title = isUz ? card.titleUz : card.titleRu;
        return (
          <button
            key={card.key}
            type="button"
            onClick={() => setActiveModule(targetOf(card))}
            title={`${title} — ${periodLabel(period, isUz)}`}
            className={`${CARD_CLASS} text-left transition-all hover:border-zinc-400 dark:hover:border-zinc-700 cursor-pointer group`}
          >
            {/* flex-wrap: на узкой карточке бейдж прироста уходит на свою строку,
                а не выдавливает заголовок за границу контейнера. */}
            <div className="flex flex-wrap items-start justify-between gap-2">
              <span className="text-[13px] font-normal text-zinc-600 dark:text-zinc-400 group-hover:text-zinc-950 dark:group-hover:text-zinc-100 transition-colors min-w-0 break-words">
                {title}
              </span>
              {/*
                Прироста может не быть вовсе: у складского остатка нет прошлого
                периода. Тогда бейдж не рисуем — «↗ 0,0 %» читается как «динамика
                нулевая», а это не то же самое, что «динамику не считают».
              */}
              {card.deltaPercent !== null && (
                <div className="flex items-center gap-1 px-1.5 py-0.5 rounded-md border border-zinc-200 dark:border-zinc-800 text-[11px] font-semibold text-zinc-900 dark:text-zinc-100 bg-white dark:bg-zinc-900 shadow-2xs shrink-0">
                  {card.isPositive ? (
                    <ArrowUpRight size={11} className="stroke-[2.5] text-zinc-700 dark:text-zinc-300" />
                  ) : (
                    <ArrowDownRight size={11} className="stroke-[2.5] text-zinc-700 dark:text-zinc-300" />
                  )}
                  <span className="font-mono text-[10px] tracking-tight tabular-nums">
                    {formatDelta(card.deltaPercent)}
                  </span>
                </div>
              )}
            </div>

            <div className="my-2">
              <div className="text-[28px] font-bold tracking-tight text-zinc-950 dark:text-zinc-50 tabular-nums break-words">
                {formatKpiValue(card.value, card.unit)}
              </div>
            </div>

            <div className="flex flex-col gap-0.5 text-xs min-w-0">
              <div className="flex items-start gap-1 font-normal text-zinc-700 dark:text-zinc-300">
                <span className="text-[12px] min-w-0 break-words">
                  {isUz ? card.sub1Uz : card.sub1Ru}
                </span>
                {card.deltaPercent === null ? null : card.isPositive ? (
                  <ArrowUpRight size={12} className="text-zinc-500 shrink-0 mt-0.5" />
                ) : (
                  <ArrowDownRight size={12} className="text-zinc-500 shrink-0 mt-0.5" />
                )}
              </div>
              <span className="text-[11px] text-zinc-400 dark:text-zinc-500 break-words">
                {isUz ? card.sub2Uz : card.sub2Ru}
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
};
