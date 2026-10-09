import React, { useState, useMemo, useEffect } from 'react';
import {
  AreaChart,
  Area,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
} from 'recharts';
import { useApp } from '../../context/AppContext';
import { useDashboard, errorText } from '../../context/DashboardContext';
import { toNumber } from '../../lib/formatters';
import { Building2, Factory, Warehouse, TrendingUp, Layers, AlertCircle, RefreshCw } from 'lucide-react';

export type EnterpriseId = 'all' | 'plant' | 'trade';
export type MetricType = 'tons' | 'revenue';
export type TimeframeType = '3m' | '30d' | '7d';

export interface EnterpriseChartPoint {
  date: string;
  displayDate: string;
  plantTons: number;      // ООО «Ташкентский изоляционный завод» (ППУ и ТЭСА)
  plantRevenue: number;   // Выручка завода (млрд UZS)
  tradeTons: number;      // ООО «Металл Азия» (Торговый дом и сбыт)
  tradeRevenue: number;   // Выручка торгового дома (млрд UZS)
  totalTons: number;      // Консолидированный объем холдинга
  totalRevenue: number;   // Консолидированная выручка холдинга
  /**
   * Опорная линия — средний дневной факт за период, а НЕ план.
   * Планирования продаж в модели данных нет (04-API-CONTRACT.md §14.1),
   * и подписывать эту линию планом нельзя.
   */
  baselineTons: number;
}

// Custom monochrome tooltip with enterprise breakdown
interface TooltipProps {
  active?: boolean;
  payload?: any[];
  label?: string;
  isUz: boolean;
  metric: MetricType;
  enterprise: EnterpriseId;
}

const CustomEnterpriseTooltip: React.FC<TooltipProps> = ({
  active,
  payload,
  label,
  isUz,
  metric,
  enterprise,
}) => {
  if (!active || !payload || !payload.length) return null;

  const dataPoint = payload[0]?.payload as EnterpriseChartPoint | undefined;
  if (!dataPoint) return null;

  const unitLabel = metric === 'tons' ? (isUz ? 't' : 'т') : (isUz ? 'mlrd UZS' : 'млрд UZS');

  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white/95 dark:bg-[#18181b]/95 backdrop-blur-md p-3 shadow-xl text-xs flex flex-col gap-2 min-w-[210px]">
      <div className="flex items-center justify-between pb-1.5 border-b border-zinc-100 dark:border-zinc-800">
        <span className="font-semibold text-zinc-950 dark:text-zinc-50 text-[11px]">
          {label}
        </span>
        <span className="text-[10px] font-medium text-zinc-500 dark:text-zinc-400">
          {metric === 'tons' ? (isUz ? 'Faktik hajm' : 'Фактический объем') : (isUz ? 'Aylanma' : 'Оборот')}
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        {(enterprise === 'all' || enterprise === 'plant') && (
          <div className="flex items-center justify-between text-zinc-600 dark:text-zinc-400 text-[11px]">
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-[2px] bg-zinc-950 dark:bg-zinc-100" />
              <span>{isUz ? 'TIZ' : 'ТИЗ'}</span>
            </div>
            <span className="font-semibold tabular-nums text-zinc-950 dark:text-zinc-50">
              {metric === 'tons' ? dataPoint.plantTons : dataPoint.plantRevenue} {unitLabel}
            </span>
          </div>
        )}

        {(enterprise === 'all' || enterprise === 'trade') && (
          <div className="flex items-center justify-between text-zinc-600 dark:text-zinc-400 text-[11px]">
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-[2px] bg-zinc-500 dark:bg-zinc-400" />
              <span>{isUz ? '«Metall Asia»' : '«Металл Азия»'}</span>
            </div>
            <span className="font-semibold tabular-nums text-zinc-950 dark:text-zinc-50">
              {metric === 'tons' ? dataPoint.tradeTons : dataPoint.tradeRevenue} {unitLabel}
            </span>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between text-zinc-950 dark:text-zinc-50 text-[11px] font-semibold pt-1.5 border-t border-zinc-100 dark:border-zinc-800">
        <span>{isUz ? 'Jami hajm' : 'Всего'}</span>
        <span className="tabular-nums">
          {enterprise === 'all'
            ? metric === 'tons'
              ? dataPoint.totalTons
              : dataPoint.totalRevenue
            : enterprise === 'plant'
            ? metric === 'tons'
              ? dataPoint.plantTons
              : dataPoint.plantRevenue
            : metric === 'tons'
            ? dataPoint.tradeTons
            : dataPoint.tradeRevenue}{' '}
          {unitLabel}
        </span>
      </div>
    </div>
  );
};

export const MonochromeAreaChart: React.FC = () => {
  const { theme, locale, company } = useApp();
  const isUz = locale === 'uz';

  // Период общий с карточками KPI: он живёт в контексте дашборда.
  const { period, setPeriod, summary, reloadSummary } = useDashboard();
  const timeframe = period as TimeframeType;
  const setTimeframe = setPeriod;

  const [enterprise, setEnterprise] = useState<EnterpriseId>(
    company === 'company_factory' ? 'plant' : company === 'company_trade' ? 'trade' : 'all'
  );
  const [metric, setMetric] = useState<MetricType>('tons');

  // Synchronize enterprise when user changes company in Sidebar
  useEffect(() => {
    if (company === 'company_factory') {
      setEnterprise('plant');
    } else if (company === 'company_trade') {
      setEnterprise('trade');
    } else {
      setEnterprise('all');
    }
  }, [company]);

  // Строки из API в числа — один раз, здесь. Recharts работает с числами,
  // но приведение не должно расползаться по разметке.
  const activeData: EnterpriseChartPoint[] = useMemo(() => {
    const points = summary.data?.chart ?? [];
    return points.map((p) => ({
      date: p.date,
      displayDate: isUz ? p.displayDateUz : p.displayDateRu,
      plantTons: toNumber(p.plantTons),
      plantRevenue: toNumber(p.plantRevenue),
      tradeTons: toNumber(p.tradeTons),
      tradeRevenue: toNumber(p.tradeRevenue),
      totalTons: toNumber(p.totalTons),
      totalRevenue: toNumber(p.totalRevenue),
      baselineTons: toNumber(p.baselineTons),
    }));
  }, [summary.data, isUz]);

  // Aggregate statistics calculated for current selection
  const statistics = useMemo(() => {
    const daysCount = activeData.length || 1;
    const plantSumTons = activeData.reduce((acc, c) => acc + c.plantTons, 0);
    const tradeSumTons = activeData.reduce((acc, c) => acc + c.tradeTons, 0);

    const plantSumRev = activeData.reduce((acc, c) => acc + c.plantRevenue, 0);
    const tradeSumRev = activeData.reduce((acc, c) => acc + c.tradeRevenue, 0);

    const totalSumTons = plantSumTons + tradeSumTons;
    const totalSumRev = plantSumRev + tradeSumRev;

    let selectedTons = totalSumTons;
    let selectedRev = totalSumRev;

    if (enterprise === 'plant') {
      selectedTons = plantSumTons;
      selectedRev = plantSumRev;
    } else if (enterprise === 'trade') {
      selectedTons = tradeSumTons;
      selectedRev = tradeSumRev;
    }

    const avgDailyTons = Math.round(selectedTons / daysCount);
    const avgDailyRev = Number((selectedRev / daysCount).toFixed(2));

    // Доля выбранного предприятия в общем объёме холдинга. Раньше здесь
    // стояло «выполнение плана», зажатое в 91.8–104.2 — числа взялись из
    // воздуха, плана в данных нет.
    const sharePercent =
      totalSumTons > 0 ? Number(((selectedTons / totalSumTons) * 100).toFixed(1)) : 0;

    return {
      totalSumTons,
      totalSumRev: Number(totalSumRev.toFixed(1)),
      selectedTons,
      selectedRev: Number(selectedRev.toFixed(1)),
      avgDailyTons,
      avgDailyRev,
      sharePercent,
      plantSumTons,
      tradeSumTons,
    };
  }, [activeData, enterprise]);

  // Опорная линия: для холдинга берём среднее с бэкенда, для одного
  // предприятия считаем среднее по его же ряду — иначе линия не про него.
  const baseline = useMemo(() => {
    if (activeData.length === 0) return 0;
    if (enterprise === 'all') return activeData[0].baselineTons;
    const key = enterprise === 'plant' ? 'plantTons' : 'tradeTons';
    const sum = activeData.reduce((acc, p) => acc + p[key], 0);
    return Number((sum / activeData.length).toFixed(1));
  }, [activeData, enterprise]);

  // Засечки оси X. Хук стоит до ранних выходов: React требует, чтобы
  // число хуков не зависело от состояния экрана (ошибка #310).
  const currentTicks = useMemo(() => {
    if (timeframe === '3m') {
      return activeData
        .filter((_, idx) => idx % 6 === 0 || idx === activeData.length - 1)
        .map((d) => d.displayDate);
    }
    if (timeframe === '30d') {
      return activeData
        .filter((_, idx) => idx % 3 === 0 || idx === activeData.length - 1)
        .map((d) => d.displayDate);
    }
    return activeData.map((d) => d.displayDate);
  }, [timeframe, activeData]);

  // Состояния экрана: ошибка и первая загрузка. Пустой график без объяснения
  // выглядит как «нулевые продажи», а это другое.
  if (summary.error && !summary.data) {
    return (
      <div
        role="alert"
        className="w-full rounded-xl border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 p-5 flex flex-col sm:flex-row sm:items-center gap-3"
      >
        <AlertCircle className="w-5 h-5 text-red-600 dark:text-red-400 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-red-900 dark:text-red-200">
            {isUz ? 'Grafik yuklanmadi' : 'График не загрузился'}
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

  if (activeData.length === 0) {
    return (
      <div className="w-full rounded-xl border border-zinc-200 dark:border-zinc-800/80 bg-white dark:bg-[#18181b] p-5 flex flex-col gap-3">
        <div className="h-4 w-48 rounded bg-zinc-200 dark:bg-zinc-800 animate-pulse" />
        <div className="h-[260px] rounded-lg bg-zinc-100 dark:bg-zinc-900 animate-pulse" />
      </div>
    );
  }

  return (
    <div className="w-full rounded-xl border border-zinc-200 dark:border-zinc-800/80 bg-white dark:bg-[#18181b] p-4 sm:p-5 transition-colors shadow-2xs">
      {/* Clean Single-Row Header: Title on Left, Unit & Timeframe on Right */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-zinc-100 dark:border-zinc-800/80">
        <div>
          <h2 className="text-sm font-semibold tracking-tight text-zinc-950 dark:text-zinc-50">
            {company === 'company_factory'
              ? isUz
                ? 'TIZ dinamikasi'
                : 'Динамика ТИЗ'
              : company === 'company_trade'
              ? isUz
                ? '«Metall Asia» dinamikasi'
                : 'Динамика «Металл Азии»'
              : isUz
              ? 'METALL ASIA xoldingi dinamikasi'
              : 'Сводная динамика холдинга METALL ASIA'}
          </h2>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            {company === 'company_factory'
              ? isUz
                ? 'Elektr payvandlangan to‘g‘ri chokli TESA va PPU quvurlari ishlab chiqarish'
                : 'Выпуск электросварных прямошовных труб ТЭСА и предизолированных труб ППУ'
              : company === 'company_trade'
              ? isUz
                ? 'Choksiz va elektr payvandlangan po‘lat quvurlar ta’minoti'
                : 'Поставки бесшовных и электросварных стальных труб'
              : isUz
              ? 'Ishlab chiqarish, ta’minot va ombor logistikasi (Metall Asia + TIZ)'
              : 'Совокупный выпуск продукции, торговые поставки и складская логистика'}
          </p>
        </div>

        {/* Minimalist Controls: Metric Toggle & Timeframe */}
        <div className="flex items-center gap-2 self-start sm:self-auto">
          {/* Unit Toggle: т vs млрд */}
          <div className="inline-flex h-7 items-center rounded-lg border border-zinc-200/80 dark:border-zinc-800 bg-zinc-100/60 dark:bg-zinc-900/60 p-0.5">
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setMetric('tons')}
              className={`h-6 px-2 text-[11px] font-medium rounded-md transition-all cursor-pointer select-none ${
                metric === 'tons'
                  ? 'bg-white dark:bg-zinc-800 text-zinc-950 dark:text-zinc-50 shadow-2xs'
                  : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-200'
              }`}
            >
              {isUz ? 'Tonna (t)' : 'Тонны (т)'}
            </button>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setMetric('revenue')}
              className={`h-6 px-2 text-[11px] font-medium rounded-md transition-all cursor-pointer select-none ${
                metric === 'revenue'
                  ? 'bg-white dark:bg-zinc-800 text-zinc-950 dark:text-zinc-50 shadow-2xs'
                  : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-200'
              }`}
            >
              {isUz ? 'Milliard so‘m' : 'Млрд UZS'}
            </button>
          </div>

          {/* Timeframe Selector: 3m / 30d / 7d */}
          <div className="inline-flex h-7 items-center rounded-lg border border-zinc-200/80 dark:border-zinc-800 bg-zinc-100/60 dark:bg-zinc-900/60 p-0.5">
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setTimeframe('3m')}
              className={`h-6 px-2 text-[11px] font-medium rounded-md transition-all cursor-pointer select-none ${
                timeframe === '3m'
                  ? 'bg-white dark:bg-zinc-800 text-zinc-950 dark:text-zinc-50 shadow-2xs'
                  : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-200'
              }`}
            >
              {isUz ? '3 oy' : '3 мес'}
            </button>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setTimeframe('30d')}
              className={`h-6 px-2 text-[11px] font-medium rounded-md transition-all cursor-pointer select-none ${
                timeframe === '30d'
                  ? 'bg-white dark:bg-zinc-800 text-zinc-950 dark:text-zinc-50 shadow-2xs'
                  : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-200'
              }`}
            >
              {isUz ? '30 kun' : '30 дн'}
            </button>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setTimeframe('7d')}
              className={`h-6 px-2 text-[11px] font-medium rounded-md transition-all cursor-pointer select-none ${
                timeframe === '7d'
                  ? 'bg-white dark:bg-zinc-800 text-zinc-950 dark:text-zinc-50 shadow-2xs'
                  : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-200'
              }`}
            >
              {isUz ? '7 kun' : '7 дн'}
            </button>
          </div>
        </div>
      </div>

      {/* Sub-bar: Minimalist Interactive Legend (Left) & Subtle KPIs (Right) */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 pt-3 pb-2 text-xs">
        {/* Interactive Legend / Filter */}
        <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
          {company === 'all' ? (
            <>
              <button
                type="button"
                onClick={() => setEnterprise('all')}
                className={`px-2 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer flex items-center gap-1.5 ${
                  enterprise === 'all'
                    ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-950 dark:text-zinc-50'
                    : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200'
                }`}
              >
                <span>{isUz ? 'Barchasi' : 'Все'}</span>
              </button>

              <button
                type="button"
                onClick={() => setEnterprise('plant')}
                className={`px-2 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer flex items-center gap-1.5 ${
                  enterprise === 'plant'
                    ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-950 dark:text-zinc-50'
                    : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200'
                }`}
              >
                <span className="w-2 h-2 rounded-full bg-zinc-950 dark:bg-zinc-100 shrink-0" />
                <span>{isUz ? 'TIZ' : 'ТИЗ'}</span>
              </button>

              <button
                type="button"
                onClick={() => setEnterprise('trade')}
                className={`px-2 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer flex items-center gap-1.5 ${
                  enterprise === 'trade'
                    ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-950 dark:text-zinc-50'
                    : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200'
                }`}
              >
                <span className="w-2 h-2 rounded-full bg-zinc-500 dark:bg-zinc-400 shrink-0" />
                <span>{isUz ? 'Metall Asia' : 'Металл Азия'}</span>
              </button>
            </>
          ) : company === 'company_factory' ? (
            <div className="px-2.5 py-1 rounded-md text-[11px] font-medium bg-zinc-100 dark:bg-zinc-800 text-zinc-950 dark:text-zinc-50 flex items-center gap-1.5 shadow-2xs">
              <span className="w-2 h-2 rounded-full bg-zinc-950 dark:bg-zinc-100 shrink-0" />
              <span>{isUz ? 'TIZ (quvur va PPU ishlab chiqarish)' : 'ТИЗ (ППУ и ТЭСА производство)'}</span>
            </div>
          ) : (
            <div className="px-2.5 py-1 rounded-md text-[11px] font-medium bg-zinc-100 dark:bg-zinc-800 text-zinc-950 dark:text-zinc-50 flex items-center gap-1.5 shadow-2xs">
              <span className="w-2 h-2 rounded-full bg-zinc-500 dark:bg-zinc-400 shrink-0" />
              <span>{isUz ? '«Metall Asia» (po‘lat quvurlar ulgurji ta’minoti)' : '«Металл Азия» (оптовые поставки стальных труб)'}</span>
            </div>
          )}
        </div>

        {/* Minimal Subtle Stats */}
        <div className="flex items-center gap-3 text-[11px] text-zinc-400 dark:text-zinc-500 self-end sm:self-auto">
          <div>
            <span>{isUz ? 'Sutkalik:' : 'Суточно:'} </span>
            <span className="font-medium text-zinc-700 dark:text-zinc-300 tabular-nums">
              {metric === 'tons'
                ? `${statistics.avgDailyTons} ${isUz ? 't' : 'т'}`
                : `${statistics.avgDailyRev} ${isUz ? 'mlrd' : 'млрд'}`}
            </span>
          </div>
          <span>•</span>
          <div>
            <span>{isUz ? 'Ulush:' : 'Доля:'} </span>
            <span className="font-medium text-zinc-900 dark:text-zinc-100 tabular-nums">
              {statistics.sharePercent}%
            </span>
          </div>
        </div>
      </div>

      {/* Recharts Area / Line Chart with pure monochrome elegance */}
      <div className="w-full h-[260px]">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={activeData}
            margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
          >
            <defs>
              {/* Plant Gradient (solid dark / white gradient) */}
              <linearGradient id="fillPlant" x1="0" y1="0" x2="0" y2="1">
                <stop
                  offset="5%"
                  stopColor={theme === 'dark' ? '#f4f4f5' : '#18181b'}
                  stopOpacity={theme === 'dark' ? 0.35 : 0.25}
                />
                <stop
                  offset="95%"
                  stopColor={theme === 'dark' ? '#18181b' : '#ffffff'}
                  stopOpacity={0.0}
                />
              </linearGradient>

              {/* Trade Gradient (mid-tone zinc monochrome) */}
              <linearGradient id="fillTrade" x1="0" y1="0" x2="0" y2="1">
                <stop
                  offset="5%"
                  stopColor={theme === 'dark' ? '#a1a1aa' : '#71717a'}
                  stopOpacity={theme === 'dark' ? 0.25 : 0.18}
                />
                <stop
                  offset="95%"
                  stopColor={theme === 'dark' ? '#18181b' : '#ffffff'}
                  stopOpacity={0.0}
                />
              </linearGradient>
            </defs>

            <CartesianGrid
              vertical={false}
              strokeDasharray="3 3"
              stroke={theme === 'dark' ? '#27272a' : '#f4f4f5'}
            />

            <XAxis
              dataKey="displayDate"
              ticks={currentTicks}
              tickLine={false}
              axisLine={false}
              tickMargin={10}
              minTickGap={16}
              tick={{
                fontSize: 11,
                fill: theme === 'dark' ? '#71717a' : '#a1a1aa',
              }}
            />

            <YAxis
              tickLine={false}
              axisLine={false}
              tick={{
                fontSize: 10,
                fill: theme === 'dark' ? '#71717a' : '#a1a1aa',
              }}
              tickFormatter={(val) => `${val}`}
            />

            {/* Средний дневной факт периода. Не план: планирования продаж
                в модели данных нет, и подпись говорит именно «среднее». */}
            {metric === 'tons' && baseline > 0 && (
              <ReferenceLine
                y={baseline}
                stroke={theme === 'dark' ? '#52525b' : '#d4d4d8'}
                strokeDasharray="4 4"
                label={{
                  value: isUz ? 'O‘rtacha' : 'Среднее',
                  position: 'insideTopRight',
                  fontSize: 10,
                  fill: theme === 'dark' ? '#71717a' : '#a1a1aa',
                }}
              />
            )}

            <Tooltip
              content={
                <CustomEnterpriseTooltip
                  isUz={isUz}
                  metric={metric}
                  enterprise={enterprise}
                />
              }
              cursor={{
                stroke: theme === 'dark' ? '#52525b' : '#d4d4d8',
                strokeWidth: 1,
                strokeDasharray: '3 3',
              }}
              animationDuration={150}
              isAnimationActive={true}
            />

            {/* If Plant is visible */}
            {(company === 'company_factory' || (company === 'all' && (enterprise === 'all' || enterprise === 'plant'))) && (
              <Area
                dataKey={metric === 'tons' ? 'plantTons' : 'plantRevenue'}
                type="monotone"
                fill="url(#fillPlant)"
                fillOpacity={1}
                stroke={theme === 'dark' ? '#f4f4f5' : '#18181b'}
                strokeWidth={enterprise === 'plant' || company === 'company_factory' ? 2.25 : 1.75}
                isAnimationActive={true}
                animationDuration={600}
                animationEasing="ease-out"
                name={isUz ? 'TIZ' : 'ТИЗ'}
              />
            )}

            {/* If Trade is visible */}
            {(company === 'company_trade' || (company === 'all' && (enterprise === 'all' || enterprise === 'trade'))) && (
              <Area
                dataKey={metric === 'tons' ? 'tradeTons' : 'tradeRevenue'}
                type="monotone"
                fill="url(#fillTrade)"
                fillOpacity={1}
                stroke={theme === 'dark' ? '#a1a1aa' : '#52525b'}
                strokeWidth={enterprise === 'trade' || company === 'company_trade' ? 2.25 : 1.5}
                isAnimationActive={true}
                animationDuration={600}
                animationEasing="ease-out"
                name={isUz ? 'Metall Asia' : 'Металл Азия'}
              />
            )}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};
