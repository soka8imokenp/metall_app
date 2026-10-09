/**
 * Продажи: портфель, заказы, журнал ТТН и лимиты покупателей.
 *
 * Всё на экране приходит из `/api/v1/sales/*`. Вкладок три, но правая панель
 * одна на все три — она всегда показывает выбранный заказ: строка ТТН ведёт к
 * своему заказу, строка покупателя — к его заказам через поиск. Так у панели
 * один смысл, а не три разных в зависимости от вкладки.
 *
 * Чего здесь нет и не будет, пока не появится в данных: «нормы пропускной
 * способности» (опорная линия на графике — среднее за период, так и подписана),
 * договоров как сущности (вместо них лимит ДЗ из карточки покупателя) и
 * «синхронизации с 1С».
 */

import React from 'react';
import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from 'recharts';
import { AlertCircle, Plus, RefreshCw, Search, Truck, X } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import { errorText, periodLabel } from '../../context/DashboardContext';
import { useSales, SalesSection } from '../../context/SalesContext';
import {
  DashboardPeriod,
  OrderStatus,
  PaymentStatus,
  SalesAvailability,
  SalesOrderDetail,
  SalesOrderStatus,
  SalesPartnerRow,
  SalesPriceHint,
  SalesShipmentRow,
  SalesStage,
  SalesSummary,
  ShipmentStatus,
} from '../../types/api';
import { formatDate, formatMoneyShort, formatNumber, formatPercent, formatQty, formatUnit, plural, refName, toNumber } from '../../lib/formatters';
import { apiClient } from '../../lib/api-client';
import { PricePanel, PricesList, type PriceItem } from './SalesPrices';
import { CustomSelect, type CustomSelectOption } from '../common/CustomSelect';
import { CustomDatePicker } from '../common/CustomDatePicker';

const CARD =
  'rounded-xl border border-zinc-200 dark:border-zinc-800/80 bg-white dark:bg-[#18181b] shadow-2xs';

const PERIODS: DashboardPeriod[] = ['7d', '30d', '3m'];
const PERIOD_SHORT: Record<DashboardPeriod, { ru: string; uz: string }> = {
  '7d': { ru: '7 дн', uz: '7 kun' },
  '30d': { ru: '30 дн', uz: '30 kun' },
  '3m': { ru: '3 мес', uz: '3 oy' },
};

const ORDER_STATUS: Record<OrderStatus, { ru: string; uz: string }> = {
  draft: { ru: 'Черновик', uz: 'Qoralama' },
  confirmed: { ru: 'Подтверждён', uz: 'Tasdiqlangan' },
  reserved: { ru: 'Зарезервирован', uz: 'Zahiralangan' },
  in_production: { ru: 'В производстве', uz: 'Ishlab chiqarishda' },
  picking: { ru: 'Комплектуется', uz: 'Yig‘ilmoqda' },
  shipped: { ru: 'Отгружен', uz: 'Jo‘natilgan' },
  closed: { ru: 'Закрыт', uz: 'Yopilgan' },
  cancelled: { ru: 'Отменён', uz: 'Bekor qilingan' },
};

const PAYMENT_STATUS: Record<PaymentStatus, { ru: string; uz: string }> = {
  unpaid: { ru: 'Не оплачен', uz: 'To‘lanmagan' },
  partial: { ru: 'Частично оплачен', uz: 'Qisman to‘langan' },
  paid: { ru: 'Оплачен', uz: 'To‘langan' },
};

const SHIPMENT_STATUS: Record<ShipmentStatus, { ru: string; uz: string }> = {
  none: { ru: 'Не отгружен', uz: 'Jo‘natilmagan' },
  partial: { ru: 'Отгружен частично', uz: 'Qisman jo‘natilgan' },
  full: { ru: 'Отгружен полностью', uz: 'To‘liq jo‘natilgan' },
};

const label = (
  map: Record<string, { ru: string; uz: string }>,
  key: string,
  isUz: boolean,
): string => (map[key] ? (isUz ? map[key].uz : map[key].ru) : key);

/** Дата и время рейса: без времени журнал ТТН за один день не упорядочить. */
function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const two = (n: number) => String(n).padStart(2, '0');
  return `${formatDate(iso)}, ${two(d.getHours())}:${two(d.getMinutes())}`;
}

const isOverdue = (dueDate: string | null, paymentStatus: PaymentStatus): boolean => {
  if (!dueDate || paymentStatus === 'paid') return false;
  return new Date(dueDate).getTime() < Date.now();
};

// ---------------------------------------------------------------------------
// Общие состояния карточки
// ---------------------------------------------------------------------------

const ErrorBox: React.FC<{ text: string; onRetry?: () => void; isUz: boolean }> = ({
  text,
  onRetry,
  isUz,
}) => (
  <div role="alert" className="h-full flex flex-col items-center justify-center gap-2 p-4 text-center">
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

const Empty: React.FC<{ text: string }> = ({ text }) => (
  <div className="h-full flex items-center justify-center p-6 text-center text-xs text-zinc-400">
    {text}
  </div>
);

const RowSkeleton: React.FC = () => (
  <div className="px-4 py-3 flex items-center justify-between gap-3 animate-pulse" aria-hidden>
    <div className="flex-1 space-y-1.5">
      <div className="h-3 w-40 rounded bg-zinc-200 dark:bg-zinc-800" />
      <div className="h-3 w-56 rounded bg-zinc-200 dark:bg-zinc-800" />
      <div className="h-3 w-32 rounded bg-zinc-200 dark:bg-zinc-800" />
    </div>
    <div className="space-y-1.5 text-right">
      <div className="h-3 w-24 rounded bg-zinc-200 dark:bg-zinc-800 ml-auto" />
      <div className="h-3 w-16 rounded bg-zinc-200 dark:bg-zinc-800 ml-auto" />
    </div>
  </div>
);

// ---------------------------------------------------------------------------
// Ряд 1: аналитика
// ---------------------------------------------------------------------------

const LoadingChart: React.FC<{
  summary: SalesSummary | null;
  isLoading: boolean;
  isUz: boolean;
  theme: string;
  period: DashboardPeriod;
  setPeriod: (p: DashboardPeriod) => void;
}> = ({ summary, isLoading, isUz, theme, period, setPeriod }) => {
  const loading = summary?.loading;
  const unit = loading ? (isUz ? loading.unitUz : loading.unitRu) : isUz ? 't' : 'т';

  const data = (loading?.series ?? []).map((p) => ({
    day: isUz ? p.displayDateUz : p.displayDateRu,
    netTons: toNumber(p.netTons),
    baselineTons: toNumber(p.baselineTons),
  }));

  return (
    <div
      className={`lg:col-span-8 min-h-[230px] lg:h-[230px] ${CARD} p-4 sm:p-5 flex flex-col justify-between transition-opacity ${
        isLoading ? 'opacity-60' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-3 pb-2 border-b border-zinc-100 dark:border-zinc-800/60">
        <div className="min-w-0">
          <span className="text-[11px] font-mono text-zinc-400 uppercase tracking-wider">
            {isUz ? 'Terminallardan kunlik yuklash' : 'Суточная погрузка с терминалов'}
          </span>
          <div className="flex items-baseline gap-2 mt-0.5">
            <span className="text-xl font-bold font-mono text-zinc-950 dark:text-zinc-50 whitespace-nowrap">
              {loading ? `${formatNumber(loading.averagePerDay, 1)} ${unit}` : '—'}
            </span>
            {/* Подпись — пояснение к числу. На узком экране её прячем целиком,
                а не обрезаем до «в…», из чего ничего не понять. */}
            <span className="hidden sm:inline text-xs text-zinc-500 font-mono">
              {isUz ? 'o‘rtacha kunlik' : 'в среднем за сутки'}
            </span>
          </div>
        </div>

        <div className="flex flex-col items-end gap-1.5 shrink-0">
          <div className="inline-flex h-7 items-center rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-0.5">
            {PERIODS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPeriod(p)}
                aria-pressed={period === p}
                title={periodLabel(p, isUz)}
                className={`h-6 px-2 text-[11px] font-medium rounded-md transition-all cursor-pointer ${
                  period === p
                    ? 'bg-zinc-950 text-white dark:bg-zinc-100 dark:text-zinc-950'
                    : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-200'
                }`}
              >
                {isUz ? PERIOD_SHORT[p].uz : PERIOD_SHORT[p].ru}
              </button>
            ))}
          </div>

          <div className="hidden lg:flex items-center gap-3 text-[11px] font-mono">
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-xs bg-zinc-950 dark:bg-zinc-100" />
              <span className="text-zinc-600 dark:text-zinc-400">
                {isUz ? `Netto (${unit})` : `Вывезено нетто (${unit})`}
              </span>
            </span>
            {/* Не «норма»: норматива погрузки в данных нет, это среднее за период. */}
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-0.5 bg-zinc-400 border-t border-dashed border-zinc-400" />
              <span className="text-zinc-500">{isUz ? 'Davr o‘rtachasi' : 'Среднее за период'}</span>
            </span>
          </div>
        </div>
      </div>

      <div className="w-full h-[120px] pt-2">
        {data.length === 0 ? (
          <Empty text={isUz ? 'Reyslar yo‘q' : 'Рейсов нет'} />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ top: 5, right: 8, left: 0, bottom: 0 }}>
              <XAxis
                dataKey="day"
                stroke={theme === 'dark' ? '#52525B' : '#A1A1AA'}
                fontSize={11}
                tickLine={false}
                interval="preserveStartEnd"
                minTickGap={24}
                axisLine={{ stroke: theme === 'dark' ? '#27272A' : '#E4E4E7' }}
              />
              <YAxis
                stroke={theme === 'dark' ? '#52525B' : '#A1A1AA'}
                fontSize={10}
                tickLine={false}
                axisLine={false}
                width={52}
                tickFormatter={(val: number) => `${formatNumber(val, 0)}${unit}`}
              />
              <Tooltip
                cursor={{ fill: theme === 'dark' ? '#27272A66' : '#F4F4F566' }}
                content={({ active, payload, label: tick }) => {
                  if (!active || !payload?.length) return null;
                  const net = payload.find((p) => p.dataKey === 'netTons')?.value;
                  const base = payload.find((p) => p.dataKey === 'baselineTons')?.value;
                  return (
                    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-2 shadow-md text-xs font-mono">
                      <div className="font-semibold text-zinc-950 dark:text-zinc-50 border-b border-zinc-100 dark:border-zinc-800 pb-1 mb-1">
                        {tick}
                      </div>
                      <div className="text-zinc-500 flex justify-between gap-3">
                        <span>{isUz ? 'Netto:' : 'Нетто:'}</span>
                        <span className="font-semibold text-zinc-950 dark:text-zinc-50">
                          {formatNumber(Number(net ?? 0), 1)} {unit}
                        </span>
                      </div>
                      <div className="text-zinc-500 flex justify-between gap-3">
                        <span>{isUz ? 'O‘rtacha:' : 'Среднее:'}</span>
                        <span>
                          {formatNumber(Number(base ?? 0), 1)} {unit}
                        </span>
                      </div>
                    </div>
                  );
                }}
              />
              <Bar
                dataKey="netTons"
                fill={theme === 'dark' ? '#FAFAFA' : '#09090B'}
                radius={[3, 3, 0, 0]}
                maxBarSize={24}
              />
              <Line
                type="monotone"
                dataKey="baselineTons"
                stroke={theme === 'dark' ? '#71717A' : '#A1A1AA'}
                strokeWidth={1.5}
                strokeDasharray="3 3"
                dot={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
};

const PortfolioCard: React.FC<{
  summary: SalesSummary | null;
  isLoading: boolean;
  isUz: boolean;
  theme: string;
}> = ({ summary, isLoading, isUz, theme }) => {
  const done = summary ? toNumber(summary.fulfillment.closedPercent) : 0;
  const ring = [
    { value: Math.min(done, 100), color: theme === 'dark' ? '#FAFAFA' : '#09090B' },
    { value: Math.max(100 - done, 0), color: theme === 'dark' ? '#27272A' : '#E4E4E7' },
  ];
  const portfolio = summary?.portfolio;

  return (
    <div
      className={`lg:col-span-4 min-h-[230px] lg:h-[230px] ${CARD} p-4 sm:p-5 flex flex-col justify-between transition-opacity ${
        isLoading ? 'opacity-60' : ''
      }`}
    >
      <div className="flex items-center justify-between gap-2 pb-2 border-b border-zinc-100 dark:border-zinc-800/60">
        <span className="text-[11px] font-mono text-zinc-400 uppercase tracking-wider">
          {isUz ? 'Yetkazib berish ijrosi' : 'Исполнение поставок'}
        </span>
        <span className="text-[11px] font-mono font-semibold text-zinc-900 dark:text-zinc-100 shrink-0">
          {summary
            ? `${summary.fulfillment.closedOrders} / ${summary.fulfillment.totalOrders}`
            : '—'}
        </span>
      </div>

      <div className="flex items-center justify-between py-1 gap-3">
        <div className="relative w-24 h-24 sm:w-28 sm:h-28 shrink-0 flex items-center justify-center">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={ring}
                cx="50%"
                cy="50%"
                innerRadius="72%"
                outerRadius="100%"
                startAngle={90}
                endAngle={-270}
                paddingAngle={2}
                dataKey="value"
                isAnimationActive={false}
              >
                {ring.map((entry, i) => (
                  <Cell key={i} fill={entry.color} />
                ))}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
          <div className="absolute flex flex-col items-center">
            <span className="text-lg font-bold font-mono text-zinc-950 dark:text-zinc-50">
              {summary ? formatPercent(summary.fulfillment.closedPercent) : '—'}
            </span>
            <span className="text-[9px] text-zinc-400 font-mono">
              {isUz ? 'jo‘natilgan' : 'отгружено'}
            </span>
          </div>
        </div>

        <div className="space-y-2 text-xs flex-1 min-w-0">
          <div>
            <div className="text-[11px] text-zinc-400">
              {isUz ? 'Portfel summasi:' : 'Сумма портфеля:'}
            </div>
            <div className="font-mono font-bold text-zinc-950 dark:text-zinc-50 text-sm">
              {portfolio ? `${formatMoneyShort(portfolio.totalAmount, isUz ? 'uz' : 'ru')} UZS` : '—'}
            </div>
          </div>
          <div>
            <div className="text-[11px] text-zinc-400">
              {isUz ? 'To‘langan:' : 'Оплачено:'}
            </div>
            <div className="font-mono text-zinc-900 dark:text-zinc-100 text-xs">
              {portfolio
                ? `${formatMoneyShort(portfolio.paidAmount, isUz ? 'uz' : 'ru')} UZS` +
                  (portfolio.paidPercent === null ? '' : ` (${formatPercent(portfolio.paidPercent)})`)
                : '—'}
            </div>
          </div>
        </div>
      </div>

      <div className="pt-2 border-t border-zinc-100 dark:border-zinc-800/60 flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 text-[11px] text-zinc-400 font-mono">
        <span>{portfolio ? (isUz ? portfolio.sub2Uz : portfolio.sub2Ru) : '—'}</span>
        <span className="text-zinc-900 dark:text-zinc-100 shrink-0">
          {portfolio
            ? `${portfolio.activeOrders} ${
                isUz ? 'buyurtma' : plural(portfolio.activeOrders, 'заказ', 'заказа', 'заказов')
              }`
            : ''}
        </span>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Ряд 2: список
// ---------------------------------------------------------------------------

const ShipmentRow: React.FC<{
  row: SalesShipmentRow;
  isUz: boolean;
  onOpen: () => void;
}> = ({ row, isUz, onOpen }) => (
  <button
    type="button"
    onClick={onOpen}
    className="w-full text-left px-4 py-3 flex items-center justify-between gap-3 hover:bg-zinc-50 dark:hover:bg-zinc-800/30 transition-colors cursor-pointer"
  >
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-mono font-bold text-xs text-zinc-950 dark:text-zinc-50">{row.number}</span>
        <span className="text-[10px] text-zinc-400 font-mono">
          {isUz ? 'buyurtma' : 'к заказу'} {row.orderNumber}
        </span>
        <span className="text-[10px] text-zinc-400 font-mono">{formatDateTime(row.shippedAt)}</span>
      </div>
      <div className="font-medium text-xs text-zinc-900 dark:text-zinc-100 truncate mt-0.5">
        {isUz ? row.partnerNameUz : row.partnerName}
      </div>
      <div className="text-[11px] text-zinc-500 truncate mt-0.5">
        {isUz ? row.cargoUz : row.cargoRu}
        {row.vehicle ? ` • ${row.vehicle}` : ''}
        {row.driver ? ` (${row.driver})` : ''}
      </div>
    </div>

    <div className="text-right shrink-0">
      <div className="font-mono font-bold text-xs text-zinc-950 dark:text-zinc-50">
        {row.netWeightT === null
          ? '—'
          : `${formatNumber(row.netWeightT, 2)} ${isUz ? 't netto' : 'т нетто'}`}
      </div>
      <div className="text-[10px] text-zinc-400 font-mono">
        {row.grossWeightT === null
          ? ''
          : `${formatNumber(row.grossWeightT, 2)} ${isUz ? 't brutto' : 'т брутто'}`}
      </div>
    </div>
  </button>
);

const PartnerRow: React.FC<{
  row: SalesPartnerRow;
  isUz: boolean;
  onOpen: () => void;
}> = ({ row, isUz, onOpen }) => {
  // Полоса рисуется только когда лимит задан: без лимита доли нет, и пустая
  // полоса читалась бы как «выбрано ноль», а это другое утверждение.
  const percent = row.usedPercent === null ? null : toNumber(row.usedPercent);

  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full text-left px-4 py-3 flex items-center justify-between gap-3 hover:bg-zinc-50 dark:hover:bg-zinc-800/30 transition-colors cursor-pointer"
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono font-bold text-xs text-zinc-950 dark:text-zinc-50 truncate max-w-[220px]">
            {refName(row, isUz)}
          </span>
          <span className="text-[10px] px-1.5 rounded border border-zinc-200 dark:border-zinc-800 text-zinc-500 font-mono">
            {row.enterprise}
          </span>
        </div>
        <div className="text-[11px] text-zinc-500 font-mono mt-0.5">
          {row.inn ? `${isUz ? 'STIR' : 'ИНН'}: ${row.inn}` : isUz ? 'STIR yo‘q' : 'ИНН не указан'}
        </div>
        <div className="text-[11px] text-zinc-500 truncate mt-0.5">
          {isUz ? 'DZ limiti:' : 'Лимит ДЗ:'} {formatMoneyShort(row.debtLimit, isUz ? 'uz' : 'ru')} UZS
          {' • '}
          {isUz ? 'Kechikish:' : 'Отсрочка:'} {row.paymentDelayDays}{' '}
          {isUz ? 'kun' : plural(row.paymentDelayDays, 'день', 'дня', 'дней')}
          {' • '}
          {isUz ? 'Faol buyurtmalar:' : 'Активных заказов:'} {row.activeOrders}
        </div>
      </div>

      <div className="text-right shrink-0 w-32 sm:w-36">
        <div className="font-mono font-bold text-xs text-zinc-950 dark:text-zinc-50">
          {formatMoneyShort(row.receivable, isUz ? 'uz' : 'ru')} UZS
        </div>
        {percent === null ? (
          <div className="text-[10px] text-zinc-400 font-mono mt-1">
            {isUz ? 'limit belgilanmagan' : 'лимит не задан'}
          </div>
        ) : (
          <>
            <div className="text-[10px] text-zinc-400 font-mono mt-0.5">
              {formatPercent(row.usedPercent)} {isUz ? 'limitdan' : 'лимита'}
            </div>
            <div className="w-full bg-zinc-200 dark:bg-zinc-800 h-1.5 rounded-full overflow-hidden mt-1">
              <div
                className={`h-full rounded-full ${
                  percent > 85 ? 'bg-zinc-950 dark:bg-zinc-100' : 'bg-zinc-500'
                }`}
                style={{ width: `${Math.min(percent, 100)}%` }}
              />
            </div>
          </>
        )}
      </div>
    </button>
  );
};

// ---------------------------------------------------------------------------
// Ряд 2: правая панель — запись (заказ, статус, ТТН)
// ---------------------------------------------------------------------------

const FIELD =
  'w-full h-8 px-2.5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white ' +
  'dark:bg-zinc-900 text-xs text-zinc-950 dark:text-zinc-50 placeholder:text-zinc-400 ' +
  'focus:outline-hidden focus:border-zinc-400 transition-colors shadow-2xs';

const BTN_BASE =
  'px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-40 ' +
  'disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400';
const BTN_PRIMARY =
  BTN_BASE +
  ' bg-zinc-900 text-zinc-50 hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200 cursor-pointer';
const BTN_GHOST =
  BTN_BASE +
  ' border border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300 ' +
  'hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer';
/** Отмена заказа выделена цветом: из неё возврата нет, заказ становится конечным. */
const BTN_DANGER =
  BTN_BASE +
  ' border border-red-200 dark:border-red-900/60 text-red-700 dark:text-red-300 ' +
  'hover:bg-red-50 dark:hover:bg-red-950/40 cursor-pointer';

/**
 * Подпись — `span`, а не `label`, и это не небрежность.
 *
 * Выпадающие списки и календарь у нас свои, и внутри у них `button`. Клик по
 * `label` был бы переадресован кнопке — то есть поверх настоящего клика по ней
 * прилетал бы второй, и список открывался бы и тут же закрывался. Поэтому
 * подпись не связана с полем разметкой, а доступность держится на `aria-label`
 * самого поля.
 */
const FieldRow: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({
  label,
  hint,
  children,
}) => (
  <div className="flex flex-col gap-1">
    <span className="text-[10px] text-zinc-400 uppercase tracking-wider">{label}</span>
    {children}
    {hint && <span className="text-[10px] text-zinc-400">{hint}</span>}
  </div>
);

/** Те же маски, что у сервера: числа приходят строками, точность решает столбец. */
const QTY_RE = /^\d{1,14}([.,]\d{1,6})?$/;
const MONEY_RE = /^\d{1,15}([.,]\d{1,4})?$/;
const PERCENT_RE = /^\d{1,3}([.,]\d{1,4})?$/;

/**
 * Сегодня — по Ташкенту. `new Date().toISOString()` до 05:00 местного времени
 * отдаёт прошлую дату: ночная смена получала в поле «Дата» вчерашнее число.
 */
const today = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date());
const num = (raw: string) => Number(raw.trim().replace(',', '.'));

/**
 * Куда заказ переводят руками. Повтор серверной таблицы, и это сознательно:
 * кнопка, которая наверняка вернёт 409, хуже отсутствующей кнопки. Правда —
 * всё равно на сервере, здесь только то, что показывать.
 */
const NEXT_STATUS: Record<string, SalesOrderStatus[]> = {
  draft: ['confirmed', 'cancelled'],
  confirmed: ['reserved', 'in_production', 'picking', 'cancelled'],
  reserved: ['in_production', 'picking', 'cancelled'],
  in_production: ['picking', 'cancelled'],
  picking: ['cancelled'],
  shipped: ['closed'],
  closed: [],
  cancelled: [],
};

/** Статусы, из которых выписывают ТТН. Черновик — нет: сначала подтверждение. */
const SHIPPABLE = ['confirmed', 'reserved', 'in_production', 'picking'];

/**
 * Компании формы — только те, что открыты переключателем наверху.
 *
 * Он же задаёт заголовок `X-Company-Id`, а сервер по нему сужает доступ. Если
 * предложить в форме компанию, которую заголовок закрыл, сохранение вернёт
 * «компания недоступна» — отказ на выбор, который сама форма и предложила.
 */
const CODE_BY_SWITCH: Record<string, string> = { company_trade: 'trade', company_factory: 'plant' };

/**
 * Строка спецификации.
 *
 * `manual` — цену правил человек. Пока он её не трогал, в запрос она не уходит
 * вовсе: цену ставит сервер по прайсу, и это единственное место, где она
 * определяется. Отправлять подставленное значение обратно значило бы объявить
 * его ручным вводом — с правом и обязательным основанием на каждую строку.
 */
type LineState = {
  itemCode: string;
  qty: string;
  price: string;
  discountPercent: string;
  manual: boolean;
  priceComment: string;
  hint: SalesPriceHint | null;
};

const blankLine = (): LineState => ({
  itemCode: '',
  qty: '',
  price: '',
  discountPercent: '',
  manual: false,
  priceComment: '',
  hint: null,
});

/**
 * Цена в строке отличается от того, что предлагает прайс, — значит её назвал
 * человек. Сравниваем с точностью до четырёх знаков: столько хранит база.
 */
const offPrice = (l: LineState): boolean => {
  if (!l.manual) return false;
  const price = num(l.price);
  if (!Number.isFinite(price) || price <= 0) return false;
  if (l.hint?.price === null || l.hint?.price === undefined) return true;
  return Math.abs(price - l.hint.price) > 1e-4;
};

/** Цена после скидки ниже себестоимости остатка (ТЗ 9.2). */
const belowCost = (l: LineState): boolean => {
  const cost = l.hint?.cost;
  if (cost === null || cost === undefined) return false;
  const price = num(l.price);
  if (!Number.isFinite(price) || price <= 0) return false;
  const discount = l.discountPercent.trim() === '' ? 0 : num(l.discountPercent);
  if (!Number.isFinite(discount)) return false;
  return price * (1 - discount / 100) < cost - 1e-4;
};

/** Подпись под полем цены: откуда она и с чем сравнивается. */
const priceHintText = (l: LineState, isUz: boolean): string | undefined => {
  const h = l.hint;
  if (!h) return undefined;
  if (h.price === null) return isUz ? 'narxnomada yo‘q' : 'нет в прайсе';
  const sum = formatNumber(String(h.price), 0);
  if (h.source === 'partner') return isUz ? `mijoz narxi ${sum}` : `цена клиента ${sum}`;
  const type = h.priceTypeName ? ` ${h.priceTypeName.toLowerCase()}` : '';
  return isUz ? `narxnoma${type} ${sum}` : `прайс${type} ${sum}`;
};

/**
 * Новый заказ занимает правую панель целиком, а не всплывает поверх экрана.
 *
 * Менеджер заводит заказ, сверяясь со списком слева — там видно, что этому
 * покупателю уже обещано. Модалка закрыла бы ровно то, ради чего её открыли, а
 * на 360 закрыла бы и весь экран.
 *
 * `standalone` — форма и есть состояние покоя панели: отдельной кнопки
 * «Новый заказ» на экране нет, открывать нечего. В этом виде закрывать форму
 * тоже нечем, поэтому крестик в шапке не показываем, а «Отмена» становится
 * «Сбросить» — она чистит набранное, а не прячет панель.
 *
 * Суммы здесь считаются только для показа. Записывает их сервер по своим
 * правилам, и присланные из браузера поля он отвергает: деньги на слово не
 * берут.
 */
const OrderForm: React.FC<{
  isUz: boolean;
  onSaved: (uid: string) => void;
  onCancel: () => void;
  standalone?: boolean;
}> = ({ isUz, onSaved, onCancel, standalone = false }) => {
  const { session } = useAuth();
  const { company } = useApp();
  const { refs, saveOrder, saving, saveError, clearSaveError } = useSales();

  const onlyCode = CODE_BY_SWITCH[company];
  const companies = (session?.companies ?? []).filter((c) => !onlyCode || c.code === onlyCode);

  const [companyUid, setCompanyUid] = React.useState(companies[0]?.uid ?? '');
  const [partnerUid, setPartnerUid] = React.useState('');
  const [warehouseCode, setWarehouseCode] = React.useState('');
  const [orderDate, setOrderDate] = React.useState(today());
  const [deliveryDate, setDeliveryDate] = React.useState('');
  const [paymentDueDate, setPaymentDueDate] = React.useState('');
  const [comment, setComment] = React.useState('');
  const [lines, setLines] = React.useState<LineState[]>([blankLine()]);

  // Переключатель компаний наверху мог закрыть ту, что выбрана в форме: форма
  // живёт в панели и смену компании переживает, так что выбор правим сами.
  const companyKey = companies.map((c) => c.uid).join(',');
  React.useEffect(() => {
    if (companies.length === 0) return;
    if (companies.some((c) => c.uid === companyUid)) return;
    setCompanyUid(companies[0].uid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyKey, companyUid]);

  // Смена компании обнуляет всё, что выбрано из её справочника: коды складов и
  // номенклатуры в компаниях совпадают, и прежний выбор выглядел бы выбранным,
  // оставаясь чужим.
  const prevCompany = React.useRef(companyUid);
  React.useEffect(() => {
    if (prevCompany.current === companyUid) return;
    prevCompany.current = companyUid;
    setPartnerUid('');
    setWarehouseCode('');
    setLines([blankLine()]);
  }, [companyUid]);

  /** Сброс набранного: в постоянной панели это единственный способ начать заново. */
  const reset = () => {
    clearSaveError();
    setPartnerUid('');
    setWarehouseCode('');
    setOrderDate(today());
    setDeliveryDate('');
    setPaymentDueDate('');
    setComment('');
    setLines([blankLine()]);
  };

  const ofCompany = <T extends { companyUid: string }>(rows: T[] | undefined) =>
    (rows ?? []).filter((r) => r.companyUid === companyUid);

  const partners = ofCompany(refs.data?.partners);
  const items = ofCompany(refs.data?.items);
  const warehouses = ofCompany(refs.data?.warehouses);
  const itemByCode = (code: string) => items.find((i) => i.code === code);

  const companyOptions: CustomSelectOption[] = companies.map((c) => ({
    value: c.uid,
    label: refName(c, isUz),
  }));
  const partnerOptions: CustomSelectOption[] = [
    { value: '', label: isUz ? 'tanlang' : 'выберите' },
    ...partners.map((p) => ({
      value: p.uid,
      label: refName(p, isUz),
      sublabel: p.inn ? `${isUz ? 'STIR' : 'ИНН'} ${p.inn}` : undefined,
    })),
  ];
  const warehouseOptions: CustomSelectOption[] = [
    { value: '', label: isUz ? 'ko‘rsatilmagan' : 'не указан' },
    ...warehouses.map((w) => ({ value: w.code, label: refName(w, isUz), badge: w.code })),
  ];
  const itemOptions: CustomSelectOption[] = [
    { value: '', label: isUz ? 'tanlang' : 'выберите' },
    ...items.map((i) => ({
      value: i.code,
      label: refName(i, isUz),
      sublabel: i.code,
    })),
  ];

  const setLine = (idx: number, patch: Partial<LineState>) =>
    setLines((ls) => ls.map((l, i) => (i === idx ? { ...l, ...patch } : l)));

  /**
   * Цену подставляет прайс (ТЗ 9.2), а не последняя продажа.
   *
   * Спрашиваем сервер: у клиента может стоять индивидуальная цена, и порядок
   * «цена клиента → прайс по его типу цен» живёт там. Считать его второй раз
   * здесь значило бы завести вторую версию правила.
   */
  const pickItem = (idx: number, code: string) => {
    setLines((ls) =>
      ls.map((l, i) =>
        i === idx ? { ...l, itemCode: code, hint: null, ...(l.manual ? {} : { price: '' }) } : l,
      ),
    );
    if (!code || !partnerUid) return;
    apiClient.sales
      .priceHint(partnerUid, code, orderDate)
      .then((res) => {
        setLines((ls) =>
          ls.map((l, i) =>
            i === idx && l.itemCode === code
              ? {
                  ...l,
                  hint: res.data,
                  price: l.manual ? l.price : res.data.price === null ? '' : String(res.data.price),
                }
              : l,
          ),
        );
      })
      .catch(() => {
        /* Подсказка не пришла — цену назовёт человек, сервер всё равно проверит. */
      });
  };

  // Смена покупателя меняет и цены: у другого клиента свой тип цен и свои
  // договорные цены. Строки остаются, подсказки перезапрашиваются.
  React.useEffect(() => {
    if (!partnerUid) return;
    for (const [idx, l] of lines.entries()) {
      if (l.itemCode) pickItem(idx, l.itemCode);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partnerUid]);

  const filled = lines.filter((l) => l.itemCode !== '');

  /** Предварительные суммы: ровно те же формулы, что у сервера. */
  const totals = filled.reduce(
    (acc, l) => {
      const item = itemByCode(l.itemCode);
      const qty = num(l.qty);
      const price = num(l.price);
      const discount = l.discountPercent.trim() === '' ? 0 : num(l.discountPercent);
      if (!Number.isFinite(qty) || !Number.isFinite(price)) return acc;
      const net = qty * price * (1 - discount / 100);
      const vat = (net * Number(item?.vatRate ?? 12)) / 100;
      return { net: acc.net + net, vat: acc.vat + vat };
    },
    { net: 0, vat: 0 },
  );

  // Проверки те же, что у сервера, и это сознательное дублирование: отправлять
  // заведомо отказной запрос, чтобы прочитать отказ, — лишний круг.
  const problem = (): string | null => {
    if (!companyUid) return isUz ? 'Kompaniyani tanlang' : 'Выберите компанию';
    if (!partnerUid) return isUz ? 'Xaridorni tanlang' : 'Выберите покупателя';
    if (filled.length === 0) return isUz ? 'Kamida bitta qator kerak' : 'Добавьте хотя бы одну позицию';
    for (const l of filled) {
      const item = itemByCode(l.itemCode);
      const name = item ? (refName(item, isUz)) : l.itemCode;
      if (!QTY_RE.test(l.qty.trim()) || num(l.qty) <= 0) {
        return `${name}: ${isUz ? 'miqdor — nuqtadan keyin 6 tagacha raqam' : 'количество, до шести знаков после запятой'}`;
      }
      if (!MONEY_RE.test(l.price.trim()) || num(l.price) <= 0) {
        return `${name}: ${isUz ? 'narx — nuqtadan keyin 4 tagacha raqam' : 'цена, до четырёх знаков после запятой'}`;
      }
      // ТЗ 9.2. Те же два правила, что и на сервере: основание на ручную цену
      // и запрет продавать ниже себестоимости, когда компания это запретила.
      if (offPrice(l) && !l.priceComment.trim()) {
        return `${name}: ${isUz ? 'narx qo‘lda — asosini yozing' : 'цена поставлена руками — напишите основание'}`;
      }
      if (belowCost(l) && l.hint?.belowCostMode === 'block') {
        return `${name}: ${isUz ? 'narx tannarxdan past' : 'цена со скидкой ниже себестоимости'}`;
      }
      if (l.discountPercent.trim() !== '' && !PERCENT_RE.test(l.discountPercent.trim())) {
        return `${name}: ${isUz ? 'chegirma — 0 dan 100 gacha foiz' : 'скидка — процент от 0 до 100'}`;
      }
    }
    if (deliveryDate && deliveryDate < orderDate) {
      return isUz ? 'Yetkazish sanasi buyurtma sanasidan oldin' : 'Дата поставки раньше даты заказа';
    }
    if (paymentDueDate && paymentDueDate < orderDate) {
      return isUz ? 'To‘lov muddati buyurtma sanasidan oldin' : 'Срок оплаты раньше даты заказа';
    }
    return null;
  };

  const invalid = problem();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (invalid || saving) return;
    const brief = await saveOrder({
      companyUid,
      partnerUid,
      orderDate,
      ...(deliveryDate ? { deliveryDate } : {}),
      ...(paymentDueDate ? { paymentDueDate } : {}),
      ...(warehouseCode ? { warehouseCode } : {}),
      ...(comment.trim() ? { comment: comment.trim() } : {}),
      lines: filled.map((l) => ({
        itemCode: l.itemCode,
        qty: l.qty.trim().replace(',', '.'),
        // Цену отдаём только если её назвал человек: иначе её ставит сервер по
        // прайсу — одно правило, одно место.
        ...(offPrice(l)
          ? {
              price: l.price.trim().replace(',', '.'),
              priceComment: l.priceComment.trim(),
            }
          : {}),
        ...(l.discountPercent.trim()
          ? { discountPercent: l.discountPercent.trim().replace(',', '.') }
          : {}),
      })),
    });
    if (brief) onSaved(brief.uid);
  };

  return (
    <form onSubmit={submit} className="flex-1 flex flex-col justify-between overflow-hidden">
      <div className="space-y-3 text-xs overflow-y-auto pr-1">
        <div className="flex items-start justify-between gap-2 pb-2.5 border-b border-zinc-100 dark:border-zinc-800/60">
          <div className="min-w-0">
            <span className="text-[10px] font-mono text-zinc-400 uppercase tracking-wider">
              {isUz ? 'Yangi buyurtma' : 'Новый заказ'}
            </span>
            <div className="text-base font-bold text-zinc-950 dark:text-zinc-50">
              {isUz ? 'Buyurtma qoralamasi' : 'Черновик заказа'}
            </div>
            <div className="text-[11px] text-zinc-500">
              {isUz
                ? 'Raqamni server beradi, summalarni ham'
                : 'Номер и суммы присвоит сервер'}
            </div>
          </div>
          {!standalone && (
            <button
              type="button"
              onClick={() => {
                clearSaveError();
                onCancel();
              }}
              aria-label={isUz ? 'Formani yopish' : 'Закрыть форму'}
              className="p-1 rounded-md text-zinc-400 hover:text-zinc-950 dark:hover:text-zinc-50 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer shrink-0"
            >
              <X size={13} />
            </button>
          )}
        </div>

        {refs.error && !refs.data && (
          <div className="flex items-start gap-2 p-2 rounded-lg bg-red-50 dark:bg-red-950/30 text-[11px] text-red-700 dark:text-red-300">
            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-px" />
            <span className="min-w-0">{errorText(refs.error, isUz)}</span>
          </div>
        )}

        {companies.length > 1 && (
          <FieldRow label={isUz ? 'Kompaniya' : 'Компания'}>
            <CustomSelect
              portal
              ariaLabel={isUz ? 'Kompaniya' : 'Компания'}
              value={companyUid}
              onChange={setCompanyUid}
              options={companyOptions}
            />
          </FieldRow>
        )}

        <FieldRow label={isUz ? 'Xaridor' : 'Покупатель'}>
          <CustomSelect
            portal
            ariaLabel={isUz ? 'Xaridor' : 'Покупатель'}
            value={partnerUid}
            onChange={setPartnerUid}
            options={partnerOptions}
          />
        </FieldRow>

        <div className="grid grid-cols-2 gap-2">
          <FieldRow label={isUz ? 'Buyurtma sanasi' : 'Дата заказа'}>
            <CustomDatePicker
              portal
              ariaLabel={isUz ? 'Buyurtma sanasi' : 'Дата заказа'}
              value={orderDate}
              onChange={setOrderDate}
            />
          </FieldRow>
          <FieldRow label={isUz ? 'Yetkazish' : 'Поставка'}>
            <CustomDatePicker
              portal
              ariaLabel={isUz ? 'Yetkazish sanasi' : 'Дата поставки'}
              value={deliveryDate}
              onChange={setDeliveryDate}
              minDate={orderDate}
              placeholder={isUz ? 'ko‘rsatilmagan' : 'не указана'}
            />
          </FieldRow>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <FieldRow label={isUz ? 'To‘lov muddati' : 'Срок оплаты'}>
            <CustomDatePicker
              portal
              ariaLabel={isUz ? 'To‘lov muddati' : 'Срок оплаты'}
              value={paymentDueDate}
              onChange={setPaymentDueDate}
              minDate={orderDate}
              placeholder={isUz ? 'ko‘rsatilmagan' : 'не указан'}
            />
          </FieldRow>
          {/* Склад заказа становится складом отгрузки: с него потом уйдёт ТТН. */}
          <FieldRow
            label={isUz ? 'Ombor' : 'Склад'}
            hint={isUz ? 'Yuk xati shu ombordan ketadi' : 'С него уйдёт ТТН'}
          >
            <CustomSelect
              portal
              ariaLabel={isUz ? 'Ombor' : 'Склад'}
              value={warehouseCode}
              onChange={setWarehouseCode}
              options={warehouseOptions}
            />
          </FieldRow>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] text-zinc-400 uppercase tracking-wider">
              {isUz ? 'Spetsifikatsiya' : 'Спецификация'}
            </span>
            <button
              type="button"
              onClick={() => setLines((ls) => [...ls, blankLine()])}
              className="h-6 px-2 inline-flex items-center gap-1 rounded-md border border-zinc-200 dark:border-zinc-800 text-[10px] font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
            >
              <Plus size={11} />
              {isUz ? 'Qator' : 'Строка'}
            </button>
          </div>

          {lines.map((l, idx) => {
            const item = itemByCode(l.itemCode);
            const unit = item ? formatUnit(item.unit, isUz ? 'uz' : 'ru') : '';
            return (
              <div
                key={idx}
                className="p-2.5 rounded-lg border border-zinc-100 dark:border-zinc-800 space-y-2"
              >
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <CustomSelect
                      portal
                      ariaLabel={`${isUz ? 'Nomenklatura' : 'Номенклатура'} ${idx + 1}`}
                      value={l.itemCode}
                      onChange={(v) => pickItem(idx, v)}
                      options={itemOptions}
                    />
                  </div>
                  {lines.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setLines((ls) => ls.filter((_, i) => i !== idx))}
                      aria-label={`${isUz ? 'Qatorni olib tashlash' : 'Убрать строку'} ${idx + 1}`}
                      className="mt-0.5 p-1 rounded-md text-zinc-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer shrink-0"
                    >
                      <X size={13} />
                    </button>
                  )}
                </div>

                <div className="grid grid-cols-3 gap-2">
                  <FieldRow label={isUz ? 'Miqdor' : 'Кол-во'} hint={unit || undefined}>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={l.qty}
                      onChange={(e) => setLine(idx, { qty: e.target.value })}
                      aria-label={`${isUz ? 'Miqdor' : 'Количество'} ${idx + 1}`}
                      className={`${FIELD} font-mono`}
                    />
                  </FieldRow>
                  <FieldRow
                    label={isUz ? 'Narx' : 'Цена'}
                    hint={priceHintText(l, isUz)}
                  >
                    <input
                      type="text"
                      inputMode="decimal"
                      value={l.price}
                      onChange={(e) => setLine(idx, { price: e.target.value, manual: true })}
                      aria-label={`${isUz ? 'Narx' : 'Цена'} ${idx + 1}`}
                      className={`${FIELD} font-mono`}
                    />
                  </FieldRow>
                  <FieldRow label={isUz ? 'Chegirma, %' : 'Скидка, %'}>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={l.discountPercent}
                      onChange={(e) => setLine(idx, { discountPercent: e.target.value })}
                      aria-label={`${isUz ? 'Chegirma' : 'Скидка'} ${idx + 1}`}
                      className={`${FIELD} font-mono`}
                    />
                  </FieldRow>
                </div>

                {/* Ручная цена — осознанное действие (ТЗ 9.2): основание
                    спрашиваем сразу, а не отказом сервера после сохранения. */}
                {offPrice(l) && (
                  <FieldRow
                    label={isUz ? 'Narx asosi' : 'Основание цены'}
                    hint={
                      l.hint?.price === null
                        ? isUz
                          ? 'narx narxnomada yo‘q'
                          : 'в прайсе цены нет'
                        : isUz
                          ? `narxnomada ${formatNumber(String(l.hint?.price ?? 0), 0)}`
                          : `в прайсе ${formatNumber(String(l.hint?.price ?? 0), 0)}`
                    }
                  >
                    <input
                      type="text"
                      value={l.priceComment}
                      maxLength={300}
                      onChange={(e) => setLine(idx, { priceComment: e.target.value })}
                      aria-label={`${isUz ? 'Narx asosi' : 'Основание цены'} ${idx + 1}`}
                      className={FIELD}
                    />
                  </FieldRow>
                )}

                {belowCost(l) && (
                  <div className="flex items-start gap-1.5 text-[11px] text-amber-700 dark:text-amber-400">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-px" />
                    <span className="min-w-0">
                      {isUz
                        ? `Chegirmali narx tannarxdan past: ${formatNumber(String(l.hint?.cost ?? 0), 0)}`
                        : `Цена со скидкой ниже себестоимости ${formatNumber(String(l.hint?.cost ?? 0), 0)}`}
                      {l.hint?.belowCostMode === 'block'
                        ? isUz
                          ? ' — kompaniya sozlamasida taqiqlangan'
                          : ' — в настройках компании это запрещено'
                        : isUz
                          ? ' — maxsus huquq kerak'
                          : ' — нужно право «Продажа ниже себестоимости»'}
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <FieldRow label={isUz ? 'Izoh' : 'Комментарий'}>
          <input
            type="text"
            value={comment}
            maxLength={500}
            onChange={(e) => setComment(e.target.value)}
            aria-label={isUz ? 'Izoh' : 'Комментарий'}
            className={FIELD}
          />
        </FieldRow>

        {/* Суммы — предварительные, и так и подписаны: считает их сервер. */}
        <div className="p-3 rounded-lg border border-zinc-100 dark:border-zinc-800 space-y-1.5 font-mono text-[11px]">
          <div className="flex justify-between gap-2 text-zinc-500">
            <span>{isUz ? 'QQSsiz:' : 'Без НДС:'}</span>
            <span>{formatNumber(totals.net, 0)} UZS</span>
          </div>
          <div className="flex justify-between gap-2 text-zinc-500">
            <span>{isUz ? 'QQS:' : 'НДС:'}</span>
            <span>{formatNumber(totals.vat, 0)} UZS</span>
          </div>
          <div className="flex justify-between gap-2 text-zinc-950 dark:text-zinc-50 font-bold pt-1 border-t border-zinc-100 dark:border-zinc-800 text-xs">
            <span>{isUz ? 'Taxminan:' : 'Предварительно:'}</span>
            <span>{formatNumber(totals.net + totals.vat, 0)} UZS</span>
          </div>
        </div>
      </div>

      <div className="pt-3 border-t border-zinc-100 dark:border-zinc-800/60 shrink-0 space-y-2">
        {saveError && (
          <div className="flex items-start gap-2 p-2 rounded-lg bg-red-50 dark:bg-red-950/30 text-[11px] text-red-700 dark:text-red-300">
            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-px" />
            <span className="min-w-0">{saveError.message}</span>
          </div>
        )}
        {invalid && <div className="text-[11px] text-zinc-500">{invalid}</div>}

        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" disabled={saving || invalid !== null} className={BTN_PRIMARY}>
            {saving ? (isUz ? 'Saqlanmoqda…' : 'Сохраняю…') : isUz ? 'Saqlash' : 'Сохранить'}
          </button>
          <button
            type="button"
            onClick={() => (standalone ? reset() : onCancel())}
            disabled={saving}
            className={BTN_GHOST}
          >
            {standalone
              ? isUz
                ? 'Tozalash'
                : 'Сбросить'
              : isUz
                ? 'Bekor qilish'
                : 'Отмена'}
          </button>
          <span className="text-[10px] text-zinc-400">
            {isUz ? 'Qoralama sifatida saqlanadi' : 'Сохранится черновиком'}
          </span>
        </div>
      </div>
    </form>
  );
};

type ShipLineState = { include: boolean; qty: string; batchNumber: string; serials: string[] };

/**
 * ТТН по заказу.
 *
 * Форма собирается не по спецификации, а по ответу `availability`: обещанное
 * количество и наличие на складе — разные числа, и грузят вторым. По
 * партионной номенклатуре партию выбирают из тех, что действительно лежат:
 * номер, набранный по памяти, сервер всё равно отвергнет.
 *
 * У штучной позиции количество не набирают руками: отмечают трубы по номерам,
 * а количество — это сколько их отмечено. Поле, где можно написать «2», не
 * назвав номера, означало бы накладную, по которой приехавшее не сверить.
 */
const ShipmentForm: React.FC<{
  order: SalesOrderDetail;
  availability: SalesAvailability;
  isUz: boolean;
  onSaved: () => void;
  onCancel: () => void;
}> = ({ order, availability, isUz, onSaved, onCancel }) => {
  const { saveShipment, saving, saveError, clearSaveError } = useSales();

  const open = availability.lines.filter((l) => Number(l.remainingQty) > 0);

  const [shippedAt, setShippedAt] = React.useState(today());
  const [vehicle, setVehicle] = React.useState('');
  const [driver, setDriver] = React.useState('');
  const [netWeightT, setNetWeightT] = React.useState('');
  const [grossWeightT, setGrossWeightT] = React.useState('');

  /** По умолчанию грузим всё, что осталось, из партии, где этого хватает. */
  const initial = (): Record<string, ShipLineState> => {
    const out: Record<string, ShipLineState> = {};
    for (const l of open) {
      const remaining = Number(l.remainingQty);
      const enough = l.batches.find((b) => Number(b.availableQty) >= remaining);
      // Штучную позицию заранее не отмечаем: какие именно трубы уедут,
      // решает кладовщик у стеллажа, а не форма за него.
      out[l.lineUid] = {
        include: true,
        qty: l.trackSerials ? '0' : l.remainingQty,
        batchNumber: l.trackBatches ? (enough?.number ?? l.batches[0]?.number ?? '') : '',
        serials: [],
      };
    }
    return out;
  };

  const [rows, setRows] = React.useState<Record<string, ShipLineState>>(initial);
  const setRow = (uid: string, patch: Partial<ShipLineState>) =>
    setRows((r) => ({ ...r, [uid]: { ...r[uid], ...patch } }));

  const toggleSerial = (uid: string, number: string) =>
    setRows((r) => {
      const had = r[uid].serials.includes(number);
      const serials = had
        ? r[uid].serials.filter((n) => n !== number)
        : [...r[uid].serials, number];
      return { ...r, [uid]: { ...r[uid], serials, qty: String(serials.length) } };
    });

  const chosen = open.filter((l) => rows[l.lineUid]?.include);

  /** Доступно по выбранной партии, а не по строке целиком. */
  const availableFor = (l: SalesAvailability['lines'][number]): number => {
    const state = rows[l.lineUid];
    if (l.trackSerials) return l.serials.length;
    if (!l.trackBatches || !state?.batchNumber) return Number(l.availableQty);
    const batch = l.batches.find((b) => b.number === state.batchNumber);
    return Number(batch?.availableQty ?? 0);
  };

  const problem = (): string | null => {
    if (chosen.length === 0) return isUz ? 'Kamida bitta qator kerak' : 'Выберите хотя бы одну строку';
    for (const l of chosen) {
      const state = rows[l.lineUid];
      const name = isUz ? l.itemNameUz : l.itemNameRu;
      if (!QTY_RE.test(state.qty.trim()) || num(state.qty) <= 0) {
        return `${name}: ${isUz ? 'miqdor — nuqtadan keyin 6 tagacha raqam' : 'количество, до шести знаков после запятой'}`;
      }
      if (num(state.qty) > Number(l.remainingQty) + 1e-9) {
        return `${name}: ${isUz ? 'qolgani' : 'осталось отгрузить'} ${formatQty(l.remainingQty)}`;
      }
      if (l.trackBatches && !state.batchNumber) {
        return `${name}: ${isUz ? 'partiyani tanlang' : 'выберите партию'}`;
      }
      if (l.trackSerials && state.serials.length === 0) {
        return `${name}: ${isUz ? 'quvur raqamlarini belgilang' : 'отметьте номера труб'}`;
      }
      const available = availableFor(l);
      if (num(state.qty) > available + 1e-9) {
        return `${name}: ${isUz ? 'omborda bor' : 'доступно только'} ${formatQty(available)}`;
      }
      if (!l.warehouseCode) {
        return `${name}: ${isUz ? 'ombor ko‘rsatilmagan' : 'не указан склад отгрузки'}`;
      }
    }
    if (netWeightT.trim() && !QTY_RE.test(netWeightT.trim())) {
      return isUz ? 'Netto — son' : 'Вес нетто: число';
    }
    if (grossWeightT.trim() && !QTY_RE.test(grossWeightT.trim())) {
      return isUz ? 'Brutto — son' : 'Вес брутто: число';
    }
    return null;
  };

  const invalid = problem();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (invalid || saving) return;
    const brief = await saveShipment(order.uid, {
      shippedAt,
      ...(vehicle.trim() ? { vehicle: vehicle.trim() } : {}),
      ...(driver.trim() ? { driver: driver.trim() } : {}),
      ...(netWeightT.trim() ? { netWeightT: netWeightT.trim().replace(',', '.') } : {}),
      ...(grossWeightT.trim() ? { grossWeightT: grossWeightT.trim().replace(',', '.') } : {}),
      lines: chosen.map((l) => ({
        lineUid: l.lineUid,
        qty: rows[l.lineUid].qty.trim().replace(',', '.'),
        ...(l.trackBatches ? { batchNumber: rows[l.lineUid].batchNumber } : {}),
        ...(l.trackSerials ? { serialNumbers: rows[l.lineUid].serials } : {}),
      })),
    });
    if (brief) onSaved();
  };

  return (
    <form onSubmit={submit} className="flex-1 flex flex-col justify-between overflow-hidden">
      <div className="space-y-3 text-xs overflow-y-auto pr-1">
        <div className="flex items-start justify-between gap-2 pb-2.5 border-b border-zinc-100 dark:border-zinc-800/60">
          <div className="min-w-0">
            <span className="text-[10px] font-mono text-zinc-400 uppercase tracking-wider">
              {isUz ? 'Yuk xati' : 'Товарно-транспортная накладная'}
            </span>
            <div className="text-base font-bold font-mono text-zinc-950 dark:text-zinc-50">
              {order.number}
            </div>
            <div className="text-[11px] text-zinc-500 truncate">
              {refName(order.partner, isUz)}
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              clearSaveError();
              onCancel();
            }}
            aria-label={isUz ? 'Formani yopish' : 'Закрыть форму'}
            className="p-1 rounded-md text-zinc-400 hover:text-zinc-950 dark:hover:text-zinc-50 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer shrink-0"
          >
            <X size={13} />
          </button>
        </div>

        {open.length === 0 ? (
          <div className="text-[11px] text-zinc-500">
            {isUz
              ? 'Buyurtma bo‘yicha jo‘natish uchun qoldiq yo‘q'
              : 'По заказу больше нечего отгружать'}
          </div>
        ) : (
          <div className="space-y-2">
            <span className="text-[10px] text-zinc-400 uppercase tracking-wider">
              {isUz ? 'Yuk' : 'Груз'}
            </span>
            {open.map((l) => {
              const state = rows[l.lineUid];
              const unit = formatUnit(l.unit, isUz ? 'uz' : 'ru');
              const available = availableFor(l);
              const batchOptions: CustomSelectOption[] = [
                { value: '', label: isUz ? 'tanlang' : 'выберите' },
                ...l.batches
                  .filter((b) => b.number !== null)
                  .map((b) => ({
                    value: b.number as string,
                    label: b.number as string,
                    sublabel: `${formatQty(b.availableQty)} ${unit}`,
                  })),
              ];
              return (
                <div
                  key={l.lineUid}
                  className="p-2.5 rounded-lg border border-zinc-100 dark:border-zinc-800 space-y-2"
                >
                  <div className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={state?.include ?? false}
                      onChange={(e) => setRow(l.lineUid, { include: e.target.checked })}
                      aria-label={`${isUz ? 'Qatorni qo‘shish' : 'Включить строку'} ${l.seq}`}
                      className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-zinc-900 dark:accent-zinc-100 cursor-pointer"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-zinc-900 dark:text-zinc-100 text-xs truncate">
                        {isUz ? l.itemNameUz : l.itemNameRu}
                      </div>
                      <div className="text-[10px] font-mono text-zinc-400">
                        {isUz ? 'qoldiq' : 'осталось'} {formatQty(l.remainingQty)} {unit} •{' '}
                        {isUz ? 'omborda' : 'доступно'} {formatQty(available)} {unit}
                        {l.warehouseCode ? ` • ${l.warehouseCode}` : ''}
                      </div>
                    </div>
                  </div>

                  {state?.include && (
                    <>
                      <div className={`grid gap-2 ${l.trackBatches ? 'grid-cols-2' : 'grid-cols-1'}`}>
                        <FieldRow label={isUz ? 'Miqdor' : 'Количество'} hint={unit}>
                          <input
                            type="text"
                            inputMode="decimal"
                            value={state.qty}
                            readOnly={l.trackSerials}
                            onChange={(e) => setRow(l.lineUid, { qty: e.target.value })}
                            aria-label={`${isUz ? 'Miqdor' : 'Количество'} ${l.seq}`}
                            className={`${FIELD} font-mono ${l.trackSerials ? 'opacity-60' : ''}`}
                          />
                        </FieldRow>
                        {l.trackBatches && (
                          <FieldRow label={isUz ? 'Partiya' : 'Партия'}>
                            <CustomSelect
                              portal
                              ariaLabel={`${isUz ? 'Partiya' : 'Партия'} ${l.seq}`}
                              value={state.batchNumber}
                              onChange={(v) => setRow(l.lineUid, { batchNumber: v })}
                              options={batchOptions}
                            />
                          </FieldRow>
                        )}
                      </div>
                      {l.trackSerials && (
                        <FieldRow label={isUz ? 'Quvur raqamlari' : 'Номера труб'}>
                          <div
                            role="group"
                            aria-label={`${isUz ? 'Quvur raqamlari' : 'Номера труб'} ${l.seq}`}
                            className="flex flex-wrap gap-1.5"
                          >
                            {l.serials.length === 0 ? (
                              <span className="text-[11px] text-zinc-500">
                                {isUz
                                  ? 'Omborda bo‘sh raqam yo‘q'
                                  : 'Свободных номеров на складе нет'}
                              </span>
                            ) : (
                              l.serials.map((n) => {
                                const on = state.serials.includes(n);
                                return (
                                  <button
                                    key={n}
                                    type="button"
                                    aria-pressed={on}
                                    onClick={() => toggleSerial(l.lineUid, n)}
                                    className={`px-2 py-1 rounded-md border font-mono text-[11px] transition-colors ${
                                      on
                                        ? 'border-zinc-900 bg-zinc-900 text-zinc-50 dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900'
                                        : 'border-zinc-200 text-zinc-600 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-300'
                                    }`}
                                  >
                                    {n}
                                  </button>
                                );
                              })
                            )}
                          </div>
                        </FieldRow>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <FieldRow label={isUz ? 'Jo‘natish sanasi' : 'Дата отгрузки'}>
          <CustomDatePicker
            portal
            ariaLabel={isUz ? 'Jo‘natish sanasi' : 'Дата отгрузки'}
            value={shippedAt}
            onChange={setShippedAt}
          />
        </FieldRow>

        <div className="grid grid-cols-2 gap-2">
          <FieldRow label={isUz ? 'Mashina' : 'Машина'}>
            <input
              type="text"
              value={vehicle}
              maxLength={60}
              onChange={(e) => setVehicle(e.target.value)}
              aria-label={isUz ? 'Mashina' : 'Машина'}
              className={FIELD}
            />
          </FieldRow>
          <FieldRow label={isUz ? 'Haydovchi' : 'Водитель'}>
            <input
              type="text"
              value={driver}
              maxLength={120}
              onChange={(e) => setDriver(e.target.value)}
              aria-label={isUz ? 'Haydovchi' : 'Водитель'}
              className={FIELD}
            />
          </FieldRow>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <FieldRow label={isUz ? 'Netto, t' : 'Нетто, т'}>
            <input
              type="text"
              inputMode="decimal"
              value={netWeightT}
              onChange={(e) => setNetWeightT(e.target.value)}
              aria-label={isUz ? 'Netto vazni' : 'Вес нетто'}
              className={`${FIELD} font-mono`}
            />
          </FieldRow>
          <FieldRow label={isUz ? 'Brutto, t' : 'Брутто, т'}>
            <input
              type="text"
              inputMode="decimal"
              value={grossWeightT}
              onChange={(e) => setGrossWeightT(e.target.value)}
              aria-label={isUz ? 'Brutto vazni' : 'Вес брутто'}
              className={`${FIELD} font-mono`}
            />
          </FieldRow>
        </div>
      </div>

      <div className="pt-3 border-t border-zinc-100 dark:border-zinc-800/60 shrink-0 space-y-2">
        {saveError && (
          <div className="flex items-start gap-2 p-2 rounded-lg bg-red-50 dark:bg-red-950/30 text-[11px] text-red-700 dark:text-red-300">
            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-px" />
            <span className="min-w-0">{saveError.message}</span>
          </div>
        )}
        {invalid && <div className="text-[11px] text-zinc-500">{invalid}</div>}

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="submit"
            disabled={saving || invalid !== null || open.length === 0}
            className={BTN_PRIMARY}
          >
            {saving ? (isUz ? 'Yozilmoqda…' : 'Выписываю…') : isUz ? 'Yuk xatini yozish' : 'Выписать ТТН'}
          </button>
          <button type="button" onClick={onCancel} disabled={saving} className={BTN_GHOST}>
            {isUz ? 'Bekor qilish' : 'Отмена'}
          </button>
          {/* Отгрузка — расход со склада, и отменить её стиранием нельзя. */}
          <span className="text-[10px] text-zinc-400">
            {isUz ? 'Ombordan chiqim bo‘ladi' : 'Спишет товар со склада'}
          </span>
        </div>
      </div>
    </form>
  );
};

// ---------------------------------------------------------------------------
// Ряд 2: правая панель — спецификация заказа
// ---------------------------------------------------------------------------

/** Подписи кнопок — глагол, а не название статуса: жмут действие, а не состояние. */
const STATUS_ACTION: Record<string, { ru: string; uz: string }> = {
  confirmed: { ru: 'Подтвердить', uz: 'Tasdiqlash' },
  reserved: { ru: 'Зарезервировать', uz: 'Zaxiralash' },
  in_production: { ru: 'В производство', uz: 'Ishlab chiqarishga' },
  picking: { ru: 'На сборку', uz: 'Yig‘ishga' },
  closed: { ru: 'Закрыть', uz: 'Yopish' },
  cancelled: { ru: 'Отменить', uz: 'Bekor qilish' },
};

const OrderPanel: React.FC<{
  order: SalesOrderDetail;
  isUz: boolean;
  onShipment: () => void;
  onClose: () => void;
}> = ({ order, isUz, onShipment, onClose }) => {
  const { can } = useAuth();
  const { availability, changeStatus, saving, saveError, lastSaved } = useSales();
  const currency = order.currency;
  const remainder = toNumber(order.amountTotal) - toNumber(order.paidAmount);

  const mayEdit = can('sales.edit');
  const mayCancel = can('sales.delete');
  // Отмена — право отдельное: менеджер заводит и ведёт заказ, снимает его директор.
  const transitions = (NEXT_STATUS[order.status] ?? []).filter((s) =>
    s === 'cancelled' ? mayCancel : mayEdit,
  );
  // Кнопку ТТН показываем по ответу сервера, а не по своему списку статусов:
  // `canShip` считает он, и отгружать нечего, если весь заказ уже уехал.
  const openLines = (availability.data?.lines ?? []).filter((l) => Number(l.remainingQty) > 0);
  const mayShip =
    mayEdit &&
    SHIPPABLE.includes(order.status) &&
    availability.data?.orderUid === order.uid &&
    availability.data.canShip &&
    openLines.length > 0;

  return (
    <div className="flex-1 flex flex-col justify-between overflow-hidden">
      <div className="space-y-3 text-xs overflow-y-auto pr-1">
        <div className="flex items-start justify-between gap-2 pb-2.5 border-b border-zinc-100 dark:border-zinc-800/60">
          <div className="min-w-0">
            <span className="text-[10px] font-mono text-zinc-400 uppercase tracking-wider">
              {isUz ? 'Buyurtma spetsifikatsiyasi' : 'Спецификация заказа'}
            </span>
            <div className="text-base font-bold font-mono text-zinc-950 dark:text-zinc-50">
              {order.number}
            </div>
            <div className="text-[11px] text-zinc-500 font-mono">
              {formatDate(order.orderDate)} • {order.enterprise}
            </div>
          </div>
          <div className="flex items-start gap-1.5 shrink-0">
            <div className="flex flex-col items-end gap-1">
              <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100">
                {label(ORDER_STATUS, order.status, isUz)}
              </span>
              <span className="text-[10px] text-zinc-500">
                {label(PAYMENT_STATUS, order.paymentStatus, isUz)}
              </span>
            </div>
            {/* Панель одна: закрыть карточку — значит вернуть форму заведения. */}
            <button
              type="button"
              onClick={onClose}
              aria-label={isUz ? 'Kartochkani yopish' : 'Закрыть карточку'}
              className="p-1 rounded-md text-zinc-400 hover:text-zinc-950 dark:hover:text-zinc-50 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
            >
              <X size={13} />
            </button>
          </div>
        </div>

        <div className="p-3 rounded-lg border border-zinc-100 dark:border-zinc-800 bg-zinc-50/60 dark:bg-zinc-900/40 space-y-1">
          <div className="text-[10px] text-zinc-400 uppercase tracking-wider">
            {isUz ? 'Xaridor' : 'Покупатель'}
          </div>
          <div className="font-semibold text-zinc-900 dark:text-zinc-100 text-xs">
            {refName(order.partner, isUz)}
          </div>
          <div className="text-[11px] font-mono text-zinc-500">
            {order.partner.inn ? `${isUz ? 'STIR' : 'ИНН'}: ${order.partner.inn} • ` : ''}
            {isUz ? 'Limit' : 'Лимит'}: {formatMoneyShort(order.partner.debtLimit, isUz ? 'uz' : 'ru')}
            {' • '}
            {isUz ? 'kechikish' : 'отсрочка'} {order.partner.paymentDelayDays}{' '}
            {isUz ? 'kun' : plural(order.partner.paymentDelayDays, 'день', 'дня', 'дней')}
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="text-[10px] text-zinc-400 uppercase tracking-wider">
            {isUz ? 'Nomenklatura' : 'Номенклатура'}
          </div>
          {order.lines.map((l) => {
            const unit = formatUnit(l.unit, isUz ? 'uz' : 'ru');
            const shipped = toNumber(l.shippedQty);
            return (
              <div
                key={l.uid}
                className="p-2.5 rounded-lg border border-zinc-100 dark:border-zinc-800 space-y-1"
              >
                <div className="font-medium text-zinc-900 dark:text-zinc-100 text-xs">
                  {isUz ? l.itemNameUz : l.itemNameRu}
                </div>
                <div className="flex justify-between gap-2 text-[11px] font-mono text-zinc-500">
                  <span className="truncate">
                    {formatQty(l.qty)} {unit} × {formatNumber(l.price, 0)}
                  </span>
                  <span className="font-semibold text-zinc-950 dark:text-zinc-50 shrink-0">
                    {formatNumber(l.amountTotal, 0)} {currency}
                  </span>
                </div>
                {/* План и факт рядом: иначе менеджер сверяет спецификацию с ТТН руками. */}
                <div className="text-[10px] font-mono text-zinc-400">
                  {isUz ? 'jo‘natilgan:' : 'отгружено:'} {formatQty(l.shippedQty)} {unit}
                  {shipped === 0 ? '' : ` ${isUz ? 'dan' : 'из'} ${formatQty(l.qty)} ${unit}`}
                </div>

                {/* ТЗ 9.2: откуда цена. Цена из прайса и цена, назначенная
                    руками, выглядели одинаково — спор «почему продали дешевле»
                    разбирать было нечем. */}
                <div className="text-[10px] font-mono text-zinc-400">
                  {l.priceSource === 'partner'
                    ? isUz
                      ? 'mijoz narxi'
                      : 'цена клиента'
                    : l.priceSource === 'list'
                      ? isUz
                        ? 'narxnoma bo‘yicha'
                        : 'по прайсу'
                      : isUz
                        ? 'narx qo‘lda qo‘yilgan'
                        : 'цена поставлена руками'}
                  {l.priceSource === 'manual' && l.listPrice
                    ? ` · ${isUz ? 'narxnomada' : 'в прайсе'} ${formatNumber(l.listPrice, 0)}`
                    : ''}
                </div>
                {l.priceComment && (
                  <div className="text-[11px] text-zinc-600 dark:text-zinc-400">
                    {l.priceComment}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="p-3 rounded-lg border border-zinc-100 dark:border-zinc-800 space-y-1.5 font-mono text-[11px]">
          <div className="flex justify-between gap-2 text-zinc-500">
            <span>{isUz ? 'QQSsiz:' : 'Без НДС:'}</span>
            <span>
              {formatNumber(order.amountNet, 0)} {currency}
            </span>
          </div>
          <div className="flex justify-between gap-2 text-zinc-500">
            <span>{isUz ? 'QQS:' : 'НДС:'}</span>
            <span>
              {formatNumber(order.amountVat, 0)} {currency}
            </span>
          </div>
          <div className="flex justify-between gap-2 text-zinc-950 dark:text-zinc-50 font-bold pt-1 border-t border-zinc-100 dark:border-zinc-800 text-xs">
            <span>{isUz ? 'Jami:' : 'Итого:'}</span>
            <span>
              {formatNumber(order.amountTotal, 0)} {currency}
            </span>
          </div>
          <div className="flex justify-between gap-2 text-zinc-500">
            <span>{isUz ? 'To‘langan:' : 'Оплачено:'}</span>
            <span>
              {formatNumber(order.paidAmount, 0)} {currency}
            </span>
          </div>
          {remainder > 0 && (
            <div className="flex justify-between gap-2 text-zinc-700 dark:text-zinc-300">
              <span>{isUz ? 'Qoldiq:' : 'Остаток:'}</span>
              <span>
                {formatNumber(remainder, 0)} {currency}
              </span>
            </div>
          )}
        </div>

        <div className="space-y-1.5">
          <div className="text-[10px] text-zinc-400 uppercase tracking-wider">
            {isUz ? 'Yuk xatlari' : 'Отгрузки по заказу'}
          </div>
          {order.shipments.length === 0 ? (
            <div className="text-[11px] text-zinc-400">
              {isUz ? 'Reyslar hali yo‘q' : 'Рейсов пока нет'}
            </div>
          ) : (
            order.shipments.map((s) => (
              <div
                key={s.uid}
                className="flex items-center justify-between gap-2 text-[11px] font-mono text-zinc-500 border-b border-zinc-100 dark:border-zinc-800/60 pb-1 last:border-0"
              >
                <span className="flex items-center gap-1.5 min-w-0">
                  <Truck size={11} className="shrink-0" />
                  <span className="truncate text-zinc-900 dark:text-zinc-100">{s.number}</span>
                  <span className="truncate">{formatDateTime(s.shippedAt)}</span>
                </span>
                <span className="shrink-0">
                  {s.netWeightT === null ? '—' : `${formatNumber(s.netWeightT, 2)} ${isUz ? 't' : 'т'}`}
                </span>
              </div>
            ))
          )}
        </div>

        <div className="text-[11px] text-zinc-500 space-y-1">
          <div>
            {isUz ? 'Ombor' : 'Склад'}:{' '}
            {(isUz ? order.warehouseNameUz : order.warehouseNameRu) ?? (isUz ? 'ko‘rsatilmagan' : 'не указан')}
          </div>
          <div>
            {isUz ? 'Yetkazish muddati:' : 'Срок поставки:'} {formatDate(order.deliveryDate)}
          </div>
          <div>
            {isUz ? 'To‘lov muddati:' : 'Оплата до:'} {formatDate(order.paymentDueDate)}
          </div>
          <div>
            {isUz ? 'Menejer:' : 'Менеджер:'} {order.managerName ?? '—'}
          </div>
          {order.comment && <div className="text-zinc-400">{order.comment}</div>}
        </div>
      </div>

      <div className="pt-3 border-t border-zinc-100 dark:border-zinc-800/60 shrink-0 space-y-2">
        {saveError && (
          <div className="flex items-start gap-2 p-2 rounded-lg bg-red-50 dark:bg-red-950/30 text-[11px] text-red-700 dark:text-red-300">
            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-px" />
            <span className="min-w-0">{saveError.message}</span>
          </div>
        )}
        {!saveError && lastSaved && lastSaved.kind !== 'order' && (
          <div className="text-[11px] text-zinc-500">
            {lastSaved.number} — {lastSaved.note}
          </div>
        )}

        {/* «Отгружен» в списке действий не появится: этот статус ставит ТТН. */}
        {(transitions.length > 0 || mayShip) && (
          <div className="flex flex-wrap items-center gap-2">
            {mayShip && (
              <button type="button" onClick={onShipment} disabled={saving} className={BTN_PRIMARY}>
                <span className="inline-flex items-center gap-1.5">
                  <Truck size={12} />
                  {isUz ? 'Yuk xati' : 'Выписать ТТН'}
                </span>
              </button>
            )}
            {transitions.map((next) => (
              <button
                key={next}
                type="button"
                onClick={() => changeStatus(order.uid, next)}
                disabled={saving}
                className={next === 'cancelled' ? BTN_DANGER : BTN_GHOST}
              >
                {isUz ? STATUS_ACTION[next].uz : STATUS_ACTION[next].ru}
              </button>
            ))}
          </div>
        )}

        <div className="text-[11px] font-mono text-zinc-400 flex items-center justify-between gap-2">
          <span className="truncate">{label(SHIPMENT_STATUS, order.shipmentStatus, isUz)}</span>
          <span className="shrink-0">
            {order.lines.length}{' '}
            {isUz ? 'qator' : plural(order.lines.length, 'строка', 'строки', 'строк')}
          </span>
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------

export const SalesView: React.FC = () => {
  const { theme, locale, company } = useApp();
  const { can, session } = useAuth();
  const isUz = locale === 'uz';
  const {
    period,
    setPeriod,
    summary,
    reloadSummary,
    section,
    setSection,
    stage,
    setStage,
    search,
    setSearch,
    orders,
    reloadOrders,
    selectedUid,
    setSelectedUid,
    order,
    shipments,
    partners,
    availability,
    clearSaveError,
  } = useSales();

  /**
   * Что показывает правая панель поверх обычного её содержимого: форму ТТН.
   *
   * Обычное содержимое — карточка выбранного заказа, а если не выбран ни один,
   * то форма нового заказа: она и есть состояние покоя панели.
   *
   * Состояние местное, а не в контексте: форма — это состояние экрана, а не
   * данных, и переживать уход с раздела ей незачем.
   */
  const [panel, setPanel] = React.useState<'ttn' | null>(null);

  // Смена компании или выбор другого заказа закрывают форму: в форме ТТН уже
  // набраны количества по прежнему заказу, и дописывать их в новый нельзя.
  React.useEffect(() => {
    setPanel(null);
  }, [company, selectedUid]);

  /**
   * То, что открыли в панели, довести до экрана.
   *
   * Ниже `lg` панель стоит не сбоку, а под списком заказов — то есть целиком
   * за нижним краем окна. Без этого нажатие «Выписать ТТН» или выбор заказа
   * выглядят как ничего не сделавшие: открылось там, где не видно. Двигаем
   * только когда панель и правда за краем, иначе на широком экране страница
   * дёргалась бы на каждое нажатие.
   */
  const panelRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (panel === null && selectedUid === null) return;
    const el = panelRef.current;
    if (!el) return;
    if (el.getBoundingClientRect().top > window.innerHeight - 120) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [panel, selectedUid]);

  /** Выбранная в прайсе позиция: у раздела цен своя правая панель. */
  const [priceItem, setPriceItem] = React.useState<PriceItem | null>(null);
  const [priceTotal, setPriceTotal] = React.useState<number | null>(null);

  const stageOptions = [
    { value: 'all' as SalesStage, label: isUz ? 'Barcha bosqichlar' : 'Все этапы' },
    { value: 'unpaid' as SalesStage, label: isUz ? 'To‘lanmagan' : 'Не оплачены' },
    { value: 'paid' as SalesStage, label: isUz ? 'To‘langan' : 'Оплачены' },
    { value: 'production' as SalesStage, label: isUz ? 'Ishlab chiqarishda' : 'В производстве' },
    { value: 'shipped' as SalesStage, label: isUz ? 'Jo‘natilgan' : 'Отгружены' },
  ];

  const tabs: { key: SalesSection; ru: string; uz: string; count: number | null }[] = [
    {
      key: 'orders',
      ru: 'Заказы',
      uz: 'Buyurtmalar',
      count: orders.data?.length ?? null,
    },
    {
      key: 'shipments',
      ru: 'Журнал ТТН',
      uz: 'Yuk xatlari',
      count: shipments.data?.length ?? null,
    },
    {
      key: 'partners',
      ru: 'Покупатели и лимиты',
      uz: 'Xaridorlar va limitlar',
      count: partners.data?.length ?? null,
    },
    // ТЗ 9.2. Прайс стоит рядом с заказами, а не в складских справочниках: его
    // смотрит тот, кто выписывает заказ, и подсказка цены в форме приходит
    // отсюда же.
    {
      key: 'prices',
      ru: 'Цены',
      uz: 'Narxlar',
      count: priceTotal,
    },

  ];

  const active =
    section === 'orders' ? orders : section === 'shipments' ? shipments : partners;

  /** Со строки ТТН — на её заказ. Правая панель одна, и она про заказ. */
  const openOrder = (uid: string) => {
    setSelectedUid(uid);
    setSection('orders');
  };

  const renderList = () => {
    if (section === 'prices') {
      return (
        <PricesList
          isUz={isUz}
          companyUid={
            CODE_BY_SWITCH[company]
              ? (session?.companies.find((c) => c.code === CODE_BY_SWITCH[company])?.uid ?? null)
              : null
          }
          selected={priceItem?.uid ?? null}
          onSelect={setPriceItem}
          onTotal={setPriceTotal}
        />
      );
    }
    if (active.error && !active.data) {
      return (
        <ErrorBox
          text={errorText(active.error, isUz)}
          onRetry={section === 'orders' ? reloadOrders : undefined}
          isUz={isUz}
        />
      );
    }
    if (!active.data) {
      return (
        <div className="divide-y divide-zinc-100 dark:divide-zinc-800/40">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <RowSkeleton key={i} />
          ))}
        </div>
      );
    }

    if (section === 'orders') {
      const rows = orders.data ?? [];
      if (rows.length === 0) {
        return (
          <Empty
            text={
              search
                ? isUz
                  ? 'So‘rov bo‘yicha buyurtma topilmadi'
                  : 'По запросу заказов не найдено'
                : isUz
                ? 'Bu bosqichda buyurtma yo‘q'
                : 'На этом этапе заказов нет'
            }
          />
        );
      }
      return (
        <div className="divide-y divide-zinc-100 dark:divide-zinc-800/40">
          {rows.map((row) => {
            const selected = selectedUid === row.uid;
            const overdue = isOverdue(row.paymentDueDate, row.paymentStatus);
            return (
              <button
                key={row.uid}
                type="button"
                onClick={() => setSelectedUid(row.uid)}
                className={`w-full text-left px-4 py-3 cursor-pointer transition-colors flex items-center justify-between gap-3 ${
                  selected
                    ? 'bg-zinc-100/70 dark:bg-zinc-800/60'
                    : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/30'
                }`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono font-bold text-xs text-zinc-950 dark:text-zinc-50">
                      {row.number}
                    </span>
                    <span className="text-[10px] text-zinc-400 font-mono">
                      {formatDate(row.orderDate)}
                    </span>
                    <span className="text-[10px] px-1.5 rounded border border-zinc-200 dark:border-zinc-800 text-zinc-500 font-mono">
                      {row.enterprise}
                    </span>
                    {overdue && (
                      <span className="text-[10px] px-1.5 rounded bg-red-100 dark:bg-red-950/50 text-red-700 dark:text-red-300 font-mono">
                        {isUz ? 'muddati o‘tgan' : 'просрочка'}
                      </span>
                    )}
                  </div>
                  <div className="font-medium text-xs text-zinc-900 dark:text-zinc-100 truncate mt-0.5">
                    {isUz ? row.partnerNameUz : row.partnerName}
                  </div>
                  <div className="text-[11px] text-zinc-500 truncate mt-0.5">
                    {label(ORDER_STATUS, row.status, isUz)} • {row.linesCount}{' '}
                    {isUz ? 'qator' : plural(row.linesCount, 'строка', 'строки', 'строк')}
                    {row.managerName ? ` • ${row.managerName}` : ''}
                  </div>
                </div>

                <div className="text-right shrink-0">
                  <div className="font-mono font-bold text-xs text-zinc-950 dark:text-zinc-50">
                    {formatNumber(row.amountTotal, 0)}
                    <span className="text-[10px] text-zinc-400 font-normal ml-1">UZS</span>
                  </div>
                  <div className="mt-1 flex items-center justify-end gap-1.5">
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${
                        row.paymentStatus === 'paid' ? 'bg-zinc-950 dark:bg-zinc-100' : 'bg-zinc-400'
                      }`}
                    />
                    <span className="text-[11px] font-medium text-zinc-700 dark:text-zinc-300">
                      {label(PAYMENT_STATUS, row.paymentStatus, isUz)}
                    </span>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      );
    }

    if (section === 'shipments') {
      const rows = shipments.data ?? [];
      if (rows.length === 0) {
        return <Empty text={isUz ? 'Yuk xatlari yo‘q' : 'Рейсов нет'} />;
      }
      return (
        <div className="divide-y divide-zinc-100 dark:divide-zinc-800/40">
          {rows.map((row) => (
            <ShipmentRow key={row.uid} row={row} isUz={isUz} onOpen={() => openOrder(row.orderUid)} />
          ))}
        </div>
      );
    }

    const rows = partners.data ?? [];
    if (rows.length === 0) {
      return <Empty text={isUz ? 'Xaridorlar yo‘q' : 'Покупателей нет'} />;
    }
    return (
      <div className="divide-y divide-zinc-100 dark:divide-zinc-800/40">
        {rows.map((row) => (
          <PartnerRow
            key={row.uid}
            row={row}
            isUz={isUz}
            onOpen={() => {
              // У покупателя нет своей панели: показываем его заказы поиском.
              setSearch(refName(row, isUz));
              setStage('all');
              setSection('orders');
            }}
          />
        ))}
      </div>
    );
  };

  const renderPanel = () => {
    if (section === 'prices') {
      if (!priceItem) {
        return (
          <Empty
            text={isUz ? 'Narxnomadan nomenklatura tanlang' : 'Выберите позицию из прайса'}
          />
        );
      }
      return <PricePanel item={priceItem} isUz={isUz} />;
    }
    // Ничего не выбрано — панель не пустует, а сразу принимает новый заказ:
    // отдельной кнопки «Новый заказ» на экране нет, форма и есть состояние
    // покоя. Кому заводить нельзя, тот видит прежнюю подсказку.
    if (selectedUid === null) {
      if (can('sales.edit')) {
        return (
          <OrderForm
            isUz={isUz}
            standalone
            onSaved={(uid) => {
              // После записи сразу открываем заказ: следующий шаг по нему —
              // подтвердить и выписать ТТН, а они живут в его же панели.
              setSection('orders');
              setSelectedUid(uid);
            }}
            onCancel={() => setSelectedUid(null)}
          />
        );
      }
      return (
        <Empty text={isUz ? 'Ro‘yxatdan buyurtmani tanlang' : 'Выберите заказ из списка'} />
      );
    }
    if (order.error && !order.data) {
      return <ErrorBox text={errorText(order.error, isUz)} isUz={isUz} />;
    }
    if (!order.data) {
      return (
        <div className="flex-1 space-y-2 animate-pulse" aria-hidden>
          <div className="h-5 w-32 rounded bg-zinc-200 dark:bg-zinc-800" />
          <div className="h-16 w-full rounded bg-zinc-200 dark:bg-zinc-800" />
          <div className="h-20 w-full rounded bg-zinc-200 dark:bg-zinc-800" />
          <div className="h-24 w-full rounded bg-zinc-200 dark:bg-zinc-800" />
        </div>
      );
    }
    if (panel === 'ttn') {
      // Форма ТТН собирается по `availability`: без него количеств и партий
      // нет, а угадывать их нельзя — товар списывается настоящий.
      if (availability.error && !availability.data) {
        return <ErrorBox text={errorText(availability.error, isUz)} isUz={isUz} />;
      }
      if (!availability.data || availability.data.orderUid !== order.data.uid) {
        return (
          <div className="flex-1 space-y-2 animate-pulse" aria-hidden>
            <div className="h-5 w-32 rounded bg-zinc-200 dark:bg-zinc-800" />
            <div className="h-20 w-full rounded bg-zinc-200 dark:bg-zinc-800" />
            <div className="h-16 w-full rounded bg-zinc-200 dark:bg-zinc-800" />
          </div>
        );
      }
      return (
        <ShipmentForm
          order={order.data}
          availability={availability.data}
          isUz={isUz}
          onSaved={() => setPanel(null)}
          onCancel={() => setPanel(null)}
        />
      );
    }
    return (
      <OrderPanel
        order={order.data}
        isUz={isUz}
        onShipment={() => {
          clearSaveError();
          setPanel('ttn');
        }}
        onClose={() => {
          clearSaveError();
          setSelectedUid(null);
        }}
      />
    );
  };

  return (
    <>
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {summary.error && !summary.data ? (
          <div className={`lg:col-span-12 min-h-[230px] lg:h-[230px] ${CARD}`}>
            <ErrorBox text={errorText(summary.error, isUz)} onRetry={reloadSummary} isUz={isUz} />
          </div>
        ) : (
          <>
            <LoadingChart
              summary={summary.data}
              isLoading={summary.isLoading}
              isUz={isUz}
              theme={theme}
              period={period}
              setPeriod={setPeriod}
            />
            <PortfolioCard
              summary={summary.data}
              isLoading={summary.isLoading}
              isUz={isUz}
              theme={theme}
            />
          </>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch">
        <div className={`lg:col-span-8 h-[540px] ${CARD} overflow-hidden flex flex-col justify-between`}>
          {/*
            Шапка переносит строки: полоска разделов и блок поиска — два
            неделимых куска, и когда они перестают помещаться рядом, поиск
            уходит под полоску. Без переноса он вылезал за карточку и его
            срезало её `overflow-hidden` — молча, без следов в замере main.
          */}
          <div className="p-3 border-b border-zinc-100 dark:border-zinc-800/60 bg-zinc-50/50 dark:bg-zinc-900/30 flex flex-col sm:flex-row sm:flex-wrap sm:items-center justify-between gap-3 shrink-0">
            {/*
              Кнопки переносятся, а не прокручиваются: собственная прокрутка
              полоски давала скроллбар посреди шапки, стоило подписям со
              счётчиками перестать помещаться. Высота поэтому min-h, а не h:
              на узком экране строк становится две.
            */}
            <div
              role="group"
              aria-label={isUz ? 'Sotuv bo‘limlari' : 'Разделы продаж'}
              className="flex flex-wrap w-full sm:w-auto sm:shrink-0 min-h-8 items-center content-center rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-0.5 shadow-2xs"
            >
              {tabs.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setSection(t.key)}
                  aria-pressed={section === t.key}
                  className={`h-7 px-2.5 text-xs font-medium rounded-md transition-all cursor-pointer whitespace-nowrap ${
                    section === t.key
                      ? 'bg-zinc-950 text-white dark:bg-zinc-100 dark:text-zinc-950 shadow-2xs'
                      : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-200'
                  }`}
                >
                  <span>{isUz ? t.uz : t.ru}</span>
                  {/*
                    Место под счётчик занято всегда, даже пока данных вкладки
                    нет: они грузятся по первому заходу на вкладку, и раньше
                    подпись расширялась уже после клика — полоска прыгала под
                    курсором. Ширина **фиксированная**, а не минимальная: с
                    `min-w` ширина всё равно зависела от содержимого, и сумма
                    четырёх вкладок округлялась то в 505, то в 506 пикселей —
                    полоска дрожала на один пиксель при каждом переключении.
                  */}
                  <span
                    aria-hidden={t.count === null}
                    className="ml-1.5 font-mono text-[10px] opacity-80 inline-block w-[6ch] text-right tabular-nums overflow-hidden"
                  >
                    {t.count === null ? '' : `(${t.count})`}
                  </span>
                </button>
              ))}
            </div>

            {/* Поиск и фильтр этапа относятся к заказам: на других вкладках их нет. */}
            <div className="flex flex-col sm:flex-row sm:items-center gap-2 w-full sm:w-auto">
              {/* Поиск и фильтр этапа относятся к заказам: на других вкладках их нет. */}
              {section === 'orders' && (
                <>
                  <CustomSelect
                    value={stage}
                    onChange={setStage}
                    options={stageOptions}
                    className="w-full sm:w-40"
                  />
                  <div className="relative w-full sm:w-auto">
                    <Search
                      size={12}
                      className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400"
                    />
                    <input
                      type="text"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder={isUz ? 'Raqam yoki xaridor...' : 'Номер или покупатель...'}
                      aria-label={isUz ? 'Buyurtmalarni qidirish' : 'Поиск заказов'}
                      className="h-8 w-full sm:w-48 pl-7 pr-2.5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-xs text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 focus:outline-hidden focus:border-zinc-400 transition-colors shadow-2xs"
                    />
                  </div>
                </>
              )}
              {/*
                Кнопки «Новый заказ» здесь нет по требованию заказчика: форма
                стоит в правой панели постоянно, и на всех трёх вкладках —
                заказ заводят и глядя на лимиты покупателя, и разбирая журнал ТТН.
              */}
            </div>
          </div>

          <div
            className={`flex-1 overflow-y-auto w-full transition-opacity ${
              active.isLoading && active.data ? 'opacity-60' : ''
            }`}
          >
            {renderList()}
          </div>

          <div className="px-4 py-2 border-t border-zinc-100 dark:border-zinc-800/60 bg-zinc-50/30 dark:bg-zinc-900/20 text-xs text-zinc-400 flex items-center justify-between gap-2 font-mono shrink-0">
            <span className="truncate">
              {/* Список ограничен сотней строк: если она набралась, это надо сказать. */}
              {active.data && active.data.length >= 100
                ? isUz
                  ? 'So‘nggi 100 yozuv ko‘rsatilgan'
                  : 'Показаны последние 100 записей'
                : periodLabel(period, isUz)}
            </span>
            <span className="shrink-0">
              {active.data ? `${isUz ? 'Yozuvlar:' : 'Записей:'} ${active.data.length}` : '—'}
            </span>
          </div>
        </div>

        <div
          ref={panelRef}
          className={`lg:col-span-4 h-[540px] ${CARD} p-4 sm:p-5 flex flex-col justify-between`}
        >
          {renderPanel()}
        </div>
      </div>
    </>
  );
};
