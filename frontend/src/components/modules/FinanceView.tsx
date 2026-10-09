/**
 * Финансы: движение денег, остатки счетов, журнал операций, дебиторка, план-факт.
 *
 * Всё приходит из `/api/v1/finance/*`. Правая панель одна на все три вкладки и
 * всегда показывает карточку операции с её проводками — это единственное место,
 * где видно двойную запись целиком.
 *
 * Действия над операцией живут в правой панели и ровно те, что разрешает её
 * статус: черновик отправляют на согласование, ожидающую утверждают или
 * отклоняют, утверждённую проводят. Кнопку показываем только если у человека
 * есть право на неё, — иначе она бы обещала то, чем кончится 403.
 *
 * Переводы и покупка валюты не входят в приток и отток: деньги не приходят в
 * компанию и не уходят из неё, а перекладываются между своими счетами. Их
 * количество показано отдельной строкой, чтобы «итого операций» сходилось.
 */

import React from 'react';
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AlertCircle, ArrowDownLeft, ArrowUpRight, RefreshCw, Search, X } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import { errorText, periodLabel } from '../../context/DashboardContext';
import { FinanceFormMode, FinanceSection, useFinance } from '../../context/FinanceContext';
import {
  DashboardPeriod,
  FinanceAccountBalance,
  FinanceAction,
  FinanceOperationCard,
  FinanceOperationRow,
  FinanceOperationType,
  FinancePlanFact,
  FinancePlanFactRow,
  FinanceReceivableRow,
  FinanceStatus,
  FinanceSummary,
} from '../../types/api';
import {
  formatDate,
  formatMoneyShort,
  formatNumber,
  formatPercent,
  monthNames,
  plural,
  refName,
  toNumber,
} from '../../lib/formatters';
import { CustomSelect, type CustomSelectOption } from '../common/CustomSelect';
import { apiClient, type ApiError } from '../../lib/api-client';
import { CustomDatePicker } from '../common/CustomDatePicker';
import { RatesStrip } from './CurrencyRates';
import { FinanceReportsPanel } from './FinanceReports';

const CARD =
  'rounded-xl border border-zinc-200 dark:border-zinc-800/80 bg-white dark:bg-[#18181b] shadow-2xs';

const PERIODS: DashboardPeriod[] = ['7d', '30d', '3m'];
const PERIOD_SHORT: Record<DashboardPeriod, { ru: string; uz: string }> = {
  '7d': { ru: '7 дн', uz: '7 kun' },
  '30d': { ru: '30 дн', uz: '30 kun' },
  '3m': { ru: '3 мес', uz: '3 oy' },
};

const OP_TYPE: Record<FinanceOperationType, { ru: string; uz: string }> = {
  income: { ru: 'Поступление', uz: 'Tushum' },
  expense: { ru: 'Расход', uz: 'Xarajat' },
  transfer: { ru: 'Перевод', uz: 'O‘tkazma' },
  conversion: { ru: 'Конверсия', uz: 'Konversiya' },
};

const OP_STATUS: Record<FinanceStatus, { ru: string; uz: string }> = {
  draft: { ru: 'Черновик', uz: 'Qoralama' },
  pending_approval: { ru: 'На согласовании', uz: 'Kelishuvda' },
  approved: { ru: 'Утверждена', uz: 'Tasdiqlangan' },
  posted: { ru: 'Проведена', uz: 'O‘tkazilgan' },
  rejected: { ru: 'Отклонена', uz: 'Rad etilgan' },
  reversed: { ru: 'Сторнирована', uz: 'Storno' },
};

const ACCOUNT_KIND: Record<string, { ru: string; uz: string }> = {
  cash: { ru: 'Касса', uz: 'Kassa' },
  bank: { ru: 'Расчётный счёт', uz: 'Hisob raqam' },
  receivable: { ru: 'Дебиторка', uz: 'Debitorlik' },
  payable: { ru: 'Кредиторка', uz: 'Kreditorlik' },
  income: { ru: 'Доходы', uz: 'Daromadlar' },
  expense: { ru: 'Расходы', uz: 'Xarajatlar' },
  vat: { ru: 'НДС', uz: 'QQS' },
  transit: { ru: 'Транзит', uz: 'Tranzit' },
};

const label = (
  map: Record<string, { ru: string; uz: string }>,
  key: string,
  isUz: boolean,
): string => (map[key] ? (isUz ? map[key].uz : map[key].ru) : key);

/** Дата с временем: за один день операций бывает десяток, порядок иначе не виден. */
function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const two = (n: number) => String(n).padStart(2, '0');
  return `${formatDate(iso)}, ${two(d.getHours())}:${two(d.getMinutes())}`;
}

// ---------------------------------------------------------------------------
// Общие состояния карточки
// ---------------------------------------------------------------------------

const ErrorBox: React.FC<{
  text: string;
  onRetry?: () => void;
  isUz: boolean;
}> = ({ text, onRetry, isUz }) => (
  <div
    role="alert"
    className="h-full flex flex-col items-center justify-center gap-2 p-4 text-center"
  >
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
// Ряд 1: движение денег по статьям ДДС
// ---------------------------------------------------------------------------

const CashflowCard: React.FC<{
  summary: FinanceSummary | null;
  isLoading: boolean;
  isUz: boolean;
  theme: string;
  period: DashboardPeriod;
  setPeriod: (p: DashboardPeriod) => void;
}> = ({ summary, isLoading, isUz, theme, period, setPeriod }) => {
  const flow = summary?.flow;

  // Статьи сортируем по модулю суммы и берём восемь: на столбик уже ниже
  // тридцати пикселей подпись не помещается, а полсотни статей в карточку
  // высотой 230 не влезут никак.
  const data = [...(summary?.byItem ?? [])]
    .sort((a, b) => toNumber(b.amount) - toNumber(a.amount))
    .slice(0, 8)
    .map((s) => ({
      name: refName(s, isUz),
      amount: toNumber(s.amount),
      direction: s.direction,
      ops: s.ops,
    }));

  const inflowColor = theme === 'dark' ? '#FAFAFA' : '#09090B';
  const outflowColor = theme === 'dark' ? '#52525B' : '#A1A1AA';

  return (
    <div
      className={`lg:col-span-8 min-h-[230px] lg:h-[230px] ${CARD} p-4 sm:p-5 flex flex-col justify-between transition-opacity ${
        isLoading ? 'opacity-60' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-3 pb-2 border-b border-zinc-100 dark:border-zinc-800/60">
        <div className="min-w-0">
          <span className="text-[11px] font-mono text-zinc-400 uppercase tracking-wider">
            {isUz ? 'Pul oqimi moddalar bo‘yicha' : 'Движение денег по статьям'}
          </span>
          <div className="flex items-baseline gap-2 mt-0.5">
            <span className="text-xl font-bold font-mono text-zinc-950 dark:text-zinc-50 whitespace-nowrap">
              {flow ? `${formatMoneyShort(flow.net, isUz ? 'uz' : 'ru')} UZS` : '—'}
            </span>
            <span className="hidden sm:inline text-xs text-zinc-500 font-mono">
              {isUz ? 'sof oqim' : 'чистый поток'}
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
                {isUz ? 'Tushum' : 'Приток'}{' '}
                {flow ? formatMoneyShort(flow.inflow, isUz ? 'uz' : 'ru') : '—'}
              </span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-xs bg-zinc-400 dark:bg-zinc-600" />
              <span className="text-zinc-500">
                {isUz ? 'Chiqim' : 'Отток'}{' '}
                {flow ? formatMoneyShort(flow.outflow, isUz ? 'uz' : 'ru') : '—'}
              </span>
            </span>
          </div>
        </div>
      </div>

      <div className="w-full h-[120px] pt-2">
        {data.length === 0 ? (
          <Empty text={isUz ? 'Davrda operatsiya yo‘q' : 'За период операций нет'} />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 5, right: 8, left: 0, bottom: 0 }}>
              <XAxis
                dataKey="name"
                stroke={theme === 'dark' ? '#52525B' : '#A1A1AA'}
                fontSize={10}
                tickLine={false}
                interval={0}
                // Полные названия статей («Оплата поставщикам металлолома») в
                // подпись не влезают: режем до 14 символов, целиком видно в
                // подсказке.
                tickFormatter={(v: string) => (v.length > 14 ? `${v.slice(0, 13)}…` : v)}
                axisLine={{ stroke: theme === 'dark' ? '#27272A' : '#E4E4E7' }}
              />
              <YAxis
                stroke={theme === 'dark' ? '#52525B' : '#A1A1AA'}
                fontSize={10}
                tickLine={false}
                axisLine={false}
                // 52 хватало продажам с их «120т», но «4,0 млрд» в них не
                // влезает: подпись обрезается по первому знаку.
                width={66}
                tickFormatter={(val: number) => formatMoneyShort(val, isUz ? 'uz' : 'ru')}
              />
              <Tooltip
                cursor={{ fill: theme === 'dark' ? '#27272A66' : '#F4F4F566' }}
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const p = payload[0].payload as (typeof data)[number];
                  return (
                    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-2 shadow-md text-xs font-mono max-w-[260px]">
                      <div className="font-semibold text-zinc-950 dark:text-zinc-50 border-b border-zinc-100 dark:border-zinc-800 pb-1 mb-1 break-words">
                        {p.name}
                      </div>
                      <div className="text-zinc-500 flex justify-between gap-3">
                        <span>
                          {p.direction === 'inflow'
                            ? isUz
                              ? 'Tushum:'
                              : 'Приток:'
                            : isUz
                              ? 'Chiqim:'
                              : 'Отток:'}
                        </span>
                        <span className="font-semibold text-zinc-950 dark:text-zinc-50">
                          {formatNumber(p.amount, 0)} UZS
                        </span>
                      </div>
                      <div className="text-zinc-500 flex justify-between gap-3">
                        <span>{isUz ? 'Operatsiyalar:' : 'Операций:'}</span>
                        <span>{p.ops}</span>
                      </div>
                    </div>
                  );
                }}
              />
              <Bar dataKey="amount" radius={[3, 3, 0, 0]} maxBarSize={36}>
                {data.map((d, i) => (
                  <Cell key={i} fill={d.direction === 'inflow' ? inflowColor : outflowColor} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Ряд 1: остатки и очередь согласования
// ---------------------------------------------------------------------------

/** Деньги компании: касса и расчётные счета. Доходы и НДС — не остаток. */
const isMoney = (a: FinanceAccountBalance) => a.kind === 'cash' || a.kind === 'bank';

const BalanceCard: React.FC<{
  summary: FinanceSummary | null;
  isLoading: boolean;
  isUz: boolean;
}> = ({ summary, isLoading, isUz }) => {
  const money = (summary?.accounts ?? []).filter(isMoney);
  const total = money.reduce((sum, a) => sum + toNumber(a.saldo), 0);
  const approval = summary?.approval;
  const flow = summary?.flow;

  return (
    <div
      className={`lg:col-span-4 min-h-[230px] lg:h-[230px] ${CARD} p-4 sm:p-5 flex flex-col justify-between transition-opacity ${
        isLoading ? 'opacity-60' : ''
      }`}
    >
      <div className="flex items-center justify-between gap-2 pb-2 border-b border-zinc-100 dark:border-zinc-800/60">
        <span className="text-[11px] font-mono text-zinc-400 uppercase tracking-wider">
          {isUz ? 'Hisoblardagi qoldiq' : 'Остатки на счетах'}
        </span>
        <span className="text-[11px] font-mono font-semibold text-zinc-900 dark:text-zinc-100 shrink-0">
          {summary
            ? `${money.length} ${isUz ? 'ta hisob' : plural(money.length, 'счёт', 'счёта', 'счетов')}`
            : '—'}
        </span>
      </div>

      <div className="py-1 space-y-1.5 flex-1 overflow-y-auto min-h-0">
        <div className="font-mono font-bold text-lg text-zinc-950 dark:text-zinc-50">
          {summary ? `${formatMoneyShort(total, isUz ? 'uz' : 'ru')} UZS` : '—'}
        </div>
        {money.length === 0 && summary && (
          <div className="text-[11px] text-zinc-400">
            {isUz ? 'Pul hisoblari yo‘q' : 'Денежных счетов нет'}
          </div>
        )}
        {money.map((a) => (
          <div
            key={a.key}
            className="flex items-center justify-between gap-2 text-[11px] font-mono border-b border-zinc-100 dark:border-zinc-800/60 pb-1 last:border-0"
          >
            <span className="min-w-0 truncate text-zinc-500">
              <span className="text-zinc-900 dark:text-zinc-100">{a.code}</span>{' '}
              {label(ACCOUNT_KIND, a.kind, isUz)} · {a.company.code}
            </span>
            <span className="shrink-0 text-zinc-900 dark:text-zinc-100">
              {formatMoneyShort(a.saldo, isUz ? 'uz' : 'ru')}
            </span>
          </div>
        ))}
      </div>

      {/* Очередь согласования — счётчик, а не действие: маршрутов записи нет. */}
      <div className="pt-2 border-t border-zinc-100 dark:border-zinc-800/60 flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 text-[11px] text-zinc-400 font-mono">
        <span className="truncate">
          {approval
            ? `${isUz ? 'Kelishuvda' : 'На согласовании'}: ${approval.pendingApproval + approval.approved} ${
                isUz
                  ? 'operatsiya'
                  : plural(
                      approval.pendingApproval + approval.approved,
                      'операция',
                      'операции',
                      'операций',
                    )
              }`
            : '—'}
        </span>
        <span className="text-zinc-900 dark:text-zinc-100 shrink-0">
          {approval ? `${formatMoneyShort(approval.amountPending, isUz ? 'uz' : 'ru')} UZS` : ''}
        </span>
        <span className="w-full truncate">
          {flow
            ? `${isUz ? 'O‘tkazma va konversiya' : 'Переводы и конверсии'}: ${flow.transferOps} ${
                isUz ? 'operatsiya' : plural(flow.transferOps, 'операция', 'операции', 'операций')
              }`
            : ''}
        </span>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Ряд 2: строки списков
// ---------------------------------------------------------------------------

const OperationRow: React.FC<{
  row: FinanceOperationRow;
  isUz: boolean;
  selected: boolean;
  onOpen: () => void;
}> = ({ row, isUz, selected, onOpen }) => {
  const outgoing = row.type === 'expense' || row.type === 'transfer' || row.type === 'conversion';
  return (
    <button
      type="button"
      onClick={onOpen}
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
          <span className="text-[10px] text-zinc-400 font-mono">{formatDate(row.occurredAt)}</span>
          <span className="text-[10px] px-1.5 rounded border border-zinc-200 dark:border-zinc-800 text-zinc-500 font-mono">
            {row.company.code}
          </span>
          {/* Непроведённую видно сразу: у неё нет проводок и она не в остатке. */}
          {row.status !== 'posted' && (
            <span className="text-[10px] px-1.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 font-mono">
              {label(OP_STATUS, row.status, isUz)}
            </span>
          )}
        </div>
        <div className="font-medium text-xs text-zinc-900 dark:text-zinc-100 truncate mt-0.5 flex items-center gap-1">
          {outgoing ? (
            <ArrowUpRight size={12} className="shrink-0 text-zinc-500" />
          ) : (
            <ArrowDownLeft size={12} className="shrink-0 text-zinc-500" />
          )}
          <span className="truncate">
            {label(OP_TYPE, row.type, isUz)}
            {row.partner ? ` · ${refName(row.partner, isUz)}` : ''}
          </span>
        </div>
        <div className="text-[11px] text-zinc-500 truncate mt-0.5">
          {row.cashflowItem ? (refName(row.cashflowItem, isUz)) : '—'}
          {' • '}
          {row.account.code} {refName(row.account, isUz)}
          {row.counterAccount ? ` → ${row.counterAccount.code}` : ''}
        </div>
      </div>

      <div className="text-right shrink-0">
        <div className="font-mono font-bold text-xs text-zinc-950 dark:text-zinc-50">
          {formatNumber(row.amount, 0)}
          <span className="text-[10px] text-zinc-400 font-normal ml-1">{row.currency}</span>
        </div>
        {/* Валютную операцию без суммы в сумах не сверить с остатком счёта. */}
        {row.currency !== 'UZS' && (
          <div className="text-[10px] text-zinc-400 font-mono mt-0.5">
            {formatMoneyShort(row.amountBase, isUz ? 'uz' : 'ru')} UZS
          </div>
        )}
        <div className="text-[10px] text-zinc-400 font-mono mt-0.5">
          {row.entries === 0
            ? isUz
              ? 'provodkasiz'
              : 'без проводок'
            : `${row.entries} ${isUz ? 'provodka' : plural(row.entries, 'проводка', 'проводки', 'проводок')}`}
        </div>
      </div>
    </button>
  );
};

const ReceivableRow: React.FC<{ row: FinanceReceivableRow; isUz: boolean }> = ({ row, isUz }) => {
  const debt = toNumber(row.debt);
  const overdue = toNumber(row.overdue);
  const share = debt > 0 ? Math.min((overdue / debt) * 100, 100) : 0;

  return (
    <div className="px-4 py-3 flex items-center justify-between gap-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono font-bold text-xs text-zinc-950 dark:text-zinc-50 truncate max-w-[220px]">
            {refName(row.partner, isUz)}
          </span>
          {row.overLimit && (
            <span className="text-[10px] px-1.5 rounded bg-red-100 dark:bg-red-950/50 text-red-700 dark:text-red-300 font-mono">
              {isUz ? 'limitdan oshgan' : 'лимит превышен'}
            </span>
          )}
        </div>
        <div className="text-[11px] text-zinc-500 truncate mt-0.5">
          {isUz ? 'Limit:' : 'Лимит:'} {formatMoneyShort(row.debtLimit, isUz ? 'uz' : 'ru')} UZS
          {' • '}
          {isUz ? 'kechikish' : 'отсрочка'} {row.paymentDelayDays}{' '}
          {isUz ? 'kun' : plural(row.paymentDelayDays, 'день', 'дня', 'дней')}
          {' • '}
          {row.orders} {isUz ? 'buyurtma' : plural(row.orders, 'заказ', 'заказа', 'заказов')}
        </div>
        <div className="text-[11px] text-zinc-500 truncate mt-0.5">
          {row.maxOverdueDays > 0
            ? `${isUz ? 'Eng katta kechikish:' : 'Максимальная просрочка:'} ${row.maxOverdueDays} ${
                isUz ? 'kun' : plural(row.maxOverdueDays, 'день', 'дня', 'дней')
              }${row.oldestDueDate ? ` (${formatDate(row.oldestDueDate)})` : ''}`
            : isUz
              ? 'Kechikish yo‘q'
              : 'Просрочки нет'}
        </div>
      </div>

      <div className="text-right shrink-0 w-32 sm:w-36">
        <div className="font-mono font-bold text-xs text-zinc-950 dark:text-zinc-50">
          {formatMoneyShort(row.debt, isUz ? 'uz' : 'ru')} UZS
        </div>
        <div className="text-[10px] text-zinc-400 font-mono mt-0.5">
          {isUz ? 'kechikkan' : 'просрочено'} {formatMoneyShort(row.overdue, isUz ? 'uz' : 'ru')}
        </div>
        <div className="w-full bg-zinc-200 dark:bg-zinc-800 h-1.5 rounded-full overflow-hidden mt-1">
          <div
            className={`h-full rounded-full ${overdue > 0 ? 'bg-zinc-950 dark:bg-zinc-100' : 'bg-zinc-400'}`}
            style={{ width: `${share}%` }}
          />
        </div>
      </div>
    </div>
  );
};

/**
 * План-факт: колонки задаёт сервер, экран их не выдумывает. Знак отклонения
 * важнее модуля — минус означает перерасход, и красится именно он.
 */
/**
 * Состояние бюджета приходит с сервера. Неизвестное имя состояния — это не
 * повод уронить экран: показываем как «в норме» и красим нейтрально.
 */
const budgetState = (status: FinancePlanFactRow['status']) => BUDGET_STATUS[status] ?? BUDGET_STATUS.ok;

const BUDGET_STATUS: Record<
  FinancePlanFactRow['status'],
  { ru: string; uz: string; cls: string }
> = {
  ok: {
    ru: 'в норме',
    uz: 'normada',
    cls: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300',
  },
  warn: {
    ru: 'у порога',
    uz: 'chegaraga yaqin',
    cls: 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
  },
  over: {
    ru: 'перерасход',
    uz: 'ortiqcha sarf',
    cls: 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300',
  },
};

const PlanFactTable: React.FC<{
  data: FinancePlanFact;
  isUz: boolean;
  selected: string | null;
  onSelect: (uid: string) => void;
}> = ({ data, isUz, selected, onSelect }) => (
  // Четыре колонки с суммами в сумах в 360 не помещаются, а карточка режет
  // вылезшее своим overflow-hidden. Поэтому таблица прокручивается вбок сама,
  // с честной минимальной шириной, а не обрезается молча.
  <div className="overflow-x-auto">
    <table className="w-full min-w-[520px] text-left border-collapse text-xs">
      <thead>
        <tr className="h-9 bg-zinc-50 dark:bg-zinc-900 text-zinc-500 border-b border-zinc-100 dark:border-zinc-800/60">
          {data.columns.map((c) => (
            <th
              key={c.key}
              className={`px-4 py-2 font-medium whitespace-nowrap ${
                c.align === 'right' ? 'text-right' : 'text-left'
              }`}
            >
              {isUz ? (c.titleUz ?? c.titleRu) : c.titleRu}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/40">
        {data.rows.map((row) => {
          const deviation = toNumber(row.deviation);
          const state = budgetState(row.status);
          return (
            <tr
              key={row.uid}
              onClick={() => onSelect(row.uid)}
              aria-selected={selected === row.uid}
              className={`cursor-pointer ${
                selected === row.uid
                  ? 'bg-zinc-100 dark:bg-zinc-800/60'
                  : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/30'
              }`}
            >
              {data.columns.map((c) => {
                if (c.key === 'itemName') {
                  return (
                    <td key={c.key} className="px-4 py-2.5 min-w-[160px]">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="font-medium text-zinc-900 dark:text-zinc-100 truncate max-w-[200px]">
                          {isUz ? row.itemNameUz : row.itemName}
                        </span>
                        {/* Состояние пришло с сервера: экран не решает, с какого
                            процента краснеть, — порог у каждого бюджета свой. */}
                        {row.status !== 'ok' && (
                          <span
                            className={`shrink-0 px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wide ${state.cls}`}
                          >
                            {isUz ? state.uz : state.ru}
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] text-zinc-400 font-mono truncate max-w-[240px]">
                        {row.period}
                        {row.usedPercent === null ? '' : ` • ${formatPercent(row.usedPercent)}`}
                        {row.department ? ` • ${refName(row.department, isUz)}` : ''}
                      </div>
                    </td>
                  );
                }
                const value =
                  c.key === 'plan' ? row.plan : c.key === 'fact' ? row.fact : row.deviation;
                const colored = c.colorBySign && deviation !== 0;
                return (
                  <td
                    key={c.key}
                    className={`px-4 py-2.5 font-mono tabular-nums whitespace-nowrap ${
                      c.align === 'right' ? 'text-right' : ''
                    } ${
                      colored
                        ? deviation < 0
                          ? 'text-red-600 dark:text-red-400 font-semibold'
                          : 'text-zinc-900 dark:text-zinc-100'
                        : 'text-zinc-700 dark:text-zinc-300'
                    }`}
                  >
                    {formatNumber(value, 0)}
                  </td>
                );
              })}
            </tr>
          );
        })}
      </tbody>
    </table>
  </div>
);

/**
 * Период бюджета — список, а не поле ввода.
 *
 * Сервер принимает только месяц («2026-10») и квартал («2026-Q4»): бюджет «с 7
 * числа по 19-е» не сходится ни с отчётом, ни с тем, как планируют деньги.
 * Поэтому экран и не предлагает выбрать даты — он предлагает период.
 */

const periodOptions = (isUz: boolean): CustomSelectOption[] => {
  const now = new Date();
  const year = now.getFullYear();
  const out: CustomSelectOption[] = [];
  for (const y of [year, year + 1]) {
    for (let m = 1; m <= 12; m++) {
      out.push({
        value: `${y}-${String(m).padStart(2, '0')}`,
        label: `${monthNames(isUz ? 'uz' : 'ru')[m - 1]} ${y}`,
      });
    }
    for (let q = 1; q <= 4; q++) {
      out.push({ value: `${y}-Q${q}`, label: `${q} ${isUz ? 'chorak' : 'квартал'} ${y}` });
    }
  }
  return out;
};

const currentPeriod = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
};

/**
 * Бюджет в правой панели раздела «План-факт» (ТЗ 6.6).
 *
 * Выбранная строка открывается на правку, пустой выбор — это заведение нового:
 * панель одна, и отдельной кнопки «новый бюджет» здесь не нужно, как и в
 * операциях. Статью и период правка не меняет — это был бы другой бюджет, а не
 * правка этого, и факт, уже посчитанный по прежней статье, молча переехал бы на
 * новую.
 */
const BudgetPanel: React.FC<{
  rows: FinancePlanFactRow[];
  selected: string | null;
  onSelect: (uid: string | null) => void;
  isUz: boolean;
}> = ({ rows, selected, onSelect, isUz }) => {
  const { can, session } = useAuth();
  const { company } = useApp();
  const { budgetRefs, reloadPlanFact } = useFinance();
  const row = rows.find((r) => r.uid === selected) ?? null;
  const editing = row !== null;
  const mayWrite = can('finance.approve');

  const CODE_BY_SWITCH: Record<string, string> = {
    company_trade: 'trade',
    company_factory: 'plant',
  };
  const onlyCode = CODE_BY_SWITCH[company];
  const companies = (session?.companies ?? []).filter((c) => !onlyCode || c.code === onlyCode);

  const [companyUid, setCompanyUid] = React.useState(companies[0]?.uid ?? '');
  const [itemUid, setItemUid] = React.useState('');
  const [period, setPeriod] = React.useState(currentPeriod);
  const [amount, setAmount] = React.useState('');
  const [threshold, setThreshold] = React.useState('80');
  const [departmentUid, setDepartmentUid] = React.useState('');
  const [responsibleUid, setResponsibleUid] = React.useState('');
  const [busy, setBusy] = React.useState<null | 'save' | 'delete'>(null);
  const [error, setError] = React.useState<ApiError | null>(null);

  // Переключатель компаний наверху мог закрыть ту, что выбрана в форме: иначе
  // справочники отфильтруются в ноль, и списки опустеют без объяснения.
  const companyKey = companies.map((c) => c.uid).join(',');
  React.useEffect(() => {
    if (companies.length === 0) return;
    if (companies.some((c) => c.uid === companyUid)) return;
    setCompanyUid(companies[0].uid);
    setItemUid('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyKey, companyUid]);

  // Выбрали строку — поля показывают её, а не прошлый набор.
  React.useEffect(() => {
    setError(null);
    if (!row) {
      setAmount('');
      setThreshold('80');
      setDepartmentUid('');
      setResponsibleUid('');
      return;
    }
    setCompanyUid(row.company.uid);
    setPeriod(row.period);
    setAmount(String(row.plan));
    setThreshold(String(row.thresholdWarnPercent));
    setDepartmentUid(row.department?.uid ?? '');
    setResponsibleUid(row.responsible?.uid ?? '');
  }, [row?.uid]); // eslint-disable-line react-hooks/exhaustive-deps

  const refs = budgetRefs.data;
  const ofCompany = <T extends { companyUid: string }>(xs: T[] | undefined) =>
    (xs ?? []).filter((x) => x.companyUid === companyUid);
  // Бюджет — это план расхода: статьи притока здесь не предлагаем.
  const items = ofCompany(refs?.items).filter((i) => i.direction === 'outflow');
  const departments = ofCompany(refs?.departments);
  const people = ofCompany(refs?.people);

  const itemOptions: CustomSelectOption[] = [
    { value: '', label: isUz ? 'tanlang' : 'выберите' },
    ...items.map((i) => ({ value: i.uid, label: refName(i, isUz) })),
  ];
  const deptOptions: CustomSelectOption[] = [
    { value: '', label: isUz ? 'butun kompaniya' : 'вся компания' },
    ...departments.map((d) => ({ value: d.uid, label: refName(d, isUz) })),
  ];
  const peopleOptions: CustomSelectOption[] = [
    { value: '', label: isUz ? 'ko‘rsatilmagan' : 'не указан' },
    ...people.map((pp) => ({ value: pp.uid, label: pp.fullName })),
  ];

  // Те же проверки, что у сервера: отправлять заведомо отказной запрос, чтобы
  // прочитать отказ, — лишний круг.
  const invalid = (): string | null => {
    if (!editing && !itemUid) return isUz ? 'Moddani tanlang' : 'Выберите статью';
    if (!MONEY_RE.test(amount.trim())) return isUz ? 'Reja summasi' : 'Сумма плана числом';
    if (Number(amount.replace(',', '.')) <= 0) {
      return isUz ? 'Reja noldan katta' : 'План больше нуля';
    }
    const t = Number(threshold.replace(',', '.'));
    if (!Number.isFinite(t) || t < 1 || t > 100) {
      return isUz ? 'Chegara 1..100 %' : 'Порог от 1 до 100 %';
    }
    return null;
  };
  const problem = invalid();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (problem) return;
    setBusy('save');
    setError(null);
    try {
      const amountPlanned = Number(amount.replace(',', '.'));
      const thresholdWarnPercent = Number(threshold.replace(',', '.'));
      if (row) {
        await apiClient.finance.patchBudget(row.uid, {
          amountPlanned,
          thresholdWarnPercent,
          responsibleUid,
          departmentUid,
        });
        reloadPlanFact();
      } else {
        const res = await apiClient.finance.createBudget({
          ...(companies.length > 1 ? { companyUid } : {}),
          itemUid,
          period,
          amountPlanned,
          thresholdWarnPercent,
          ...(departmentUid ? { departmentUid } : {}),
          ...(responsibleUid ? { responsibleUid } : {}),
        });
        reloadPlanFact();
        setItemUid('');
        setAmount('');
        onSelect(res.data.uid);
      }
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!row) return;
    setBusy('delete');
    setError(null);
    try {
      await apiClient.finance.deleteBudget(row.uid);
      onSelect(null);
      reloadPlanFact();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(null);
    }
  };

  // Только чтение: показываем выбранный бюджет и прямо говорим, почему полей нет.
  if (!mayWrite) {
    if (!row) {
      return (
        <Empty
          text={
            isUz
              ? 'Byudjetni tanlang: rejani o‘zgartirish uchun «finance.approve» huquqi kerak'
              : 'Выберите бюджет. Чтобы править план, нужно право «finance.approve»'
          }
        />
      );
    }
    return (
      <div className="space-y-3 text-xs">
        <div className="font-medium text-sm text-zinc-900 dark:text-zinc-100">
          {isUz ? row.itemNameUz : row.itemName}
        </div>
        <div className="font-mono text-[11px] text-zinc-500">
          {row.period} • {row.company.code}
        </div>
        <BudgetFacts row={row} isUz={isUz} />
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col h-full min-h-0 gap-3 text-xs">
      <div className="flex items-start justify-between gap-2 shrink-0">
        <div className="min-w-0">
          <div className="font-medium text-sm text-zinc-900 dark:text-zinc-100 truncate">
            {editing
              ? isUz
                ? row!.itemNameUz
                : row!.itemName
              : isUz
                ? 'Yangi byudjet'
                : 'Новый бюджет'}
          </div>
          <div className="font-mono text-[11px] text-zinc-500">
            {editing ? `${row!.period} • ${row!.company.code}` : isUz ? 'reja' : 'план расхода'}
          </div>
        </div>
        {editing && (
          <button
            type="button"
            onClick={() => onSelect(null)}
            className={BTN_GHOST}
            disabled={busy !== null}
          >
            {isUz ? 'Yangi' : 'Новый'}
          </button>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto space-y-3 pr-0.5">
        {editing && <BudgetFacts row={row!} isUz={isUz} />}

        {!editing && (
          <>
            {companies.length > 1 && (
              <FieldRow label={isUz ? 'Kompaniya' : 'Компания'}>
                <CustomSelect
                  portal
                  ariaLabel={isUz ? 'Kompaniya' : 'Компания'}
                  value={companyUid}
                  onChange={(v) => {
                    setCompanyUid(v);
                    setItemUid('');
                    setDepartmentUid('');
                    setResponsibleUid('');
                  }}
                  options={companies.map((c) => ({
                    value: c.uid,
                    label: refName(c, isUz),
                  }))}
                />
              </FieldRow>
            )}
            <FieldRow label={isUz ? 'Xarajat moddasi' : 'Статья расхода'}>
              <CustomSelect
                portal
                ariaLabel={isUz ? 'Xarajat moddasi' : 'Статья расхода'}
                value={itemUid}
                onChange={setItemUid}
                options={itemOptions}
              />
            </FieldRow>
            <FieldRow
              label={isUz ? 'Davr' : 'Период'}
              hint={isUz ? 'Oy yoki chorak' : 'Месяц или квартал'}
            >
              <CustomSelect
                portal
                ariaLabel={isUz ? 'Davr' : 'Период'}
                value={period}
                onChange={setPeriod}
                options={periodOptions(isUz)}
              />
            </FieldRow>
          </>
        )}

        <div className="grid grid-cols-2 gap-2">
          <FieldRow label={isUz ? 'Reja summasi' : 'Сумма плана'}>
            <input
              type="text"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              aria-label={isUz ? 'Reja summasi' : 'Сумма плана'}
              className={`${FIELD} font-mono`}
            />
          </FieldRow>
          <FieldRow
            label={isUz ? 'Ogohlantirish, %' : 'Порог, %'}
            hint={isUz ? 'Rejaning o‘zi — 100 %' : 'Сам план — 100 %'}
          >
            <input
              type="text"
              inputMode="numeric"
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
              aria-label={isUz ? 'Ogohlantirish chegarasi' : 'Порог предупреждения'}
              className={`${FIELD} font-mono`}
            />
          </FieldRow>
        </div>

        <FieldRow label={isUz ? 'Bo‘lim' : 'Подразделение'}>
          <CustomSelect
            portal
            ariaLabel={isUz ? 'Bo‘lim' : 'Подразделение'}
            value={departmentUid}
            onChange={setDepartmentUid}
            options={deptOptions}
          />
        </FieldRow>
        <FieldRow label={isUz ? 'Mas’ul' : 'Ответственный'}>
          <CustomSelect
            portal
            ariaLabel={isUz ? 'Mas’ul' : 'Ответственный'}
            value={responsibleUid}
            onChange={setResponsibleUid}
            options={peopleOptions}
          />
        </FieldRow>
      </div>

      <div className="pt-3 border-t border-zinc-100 dark:border-zinc-800/60 shrink-0 space-y-2">
        {error && (
          <div className="flex items-start gap-2 p-2 rounded-lg bg-red-50 dark:bg-red-950/30 text-[11px] text-red-700 dark:text-red-300">
            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-px" />
            <span className="min-w-0">{errorText(error, isUz)}</span>
          </div>
        )}
        {problem && <div className="text-[11px] text-zinc-500">{problem}</div>}
        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" disabled={busy !== null || problem !== null} className={BTN_PRIMARY}>
            {busy === 'save'
              ? isUz
                ? 'Saqlanmoqda…'
                : 'Сохраняю…'
              : isUz
                ? 'Saqlash'
                : 'Сохранить'}
          </button>
          {editing && (
            <button type="button" onClick={remove} disabled={busy !== null} className={BTN_GHOST}>
              {busy === 'delete' ? (isUz ? 'O‘chirilmoqda…' : 'Удаляю…') : isUz ? 'O‘chirish' : 'Удалить'}
            </button>
          )}
          <span className="text-[10px] text-zinc-400">
            {editing
              ? isUz
                ? 'Modda va davr o‘zgarmaydi'
                : 'Статья и период не меняются'
              : isUz
                ? 'Bir davrga bitta byudjet'
                : 'Один бюджет на статью и период'}
          </span>
        </div>
      </div>
    </form>
  );
};

/** План, факт и отклонение выбранного бюджета: то же, что в строке, но крупно. */
const BudgetFacts: React.FC<{ row: FinancePlanFactRow; isUz: boolean }> = ({ row, isUz }) => {
  const deviation = toNumber(row.deviation);
  const state = budgetState(row.status);
  return (
    <div className="rounded-lg border border-zinc-100 dark:border-zinc-800/60 divide-y divide-zinc-100 dark:divide-zinc-800/60">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-zinc-500">{isUz ? 'Reja' : 'План'}</span>
        <span className="font-mono tabular-nums">{formatNumber(row.plan, 0)}</span>
      </div>
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-zinc-500">
          {isUz ? 'Fakt' : 'Факт'}
          <span className="text-[10px] text-zinc-400">
            {' '}
            {row.ops} {isUz ? 'operatsiya' : plural(row.ops, 'операция', 'операции', 'операций')}
          </span>
        </span>
        <span className="font-mono tabular-nums">{formatNumber(row.fact, 0)}</span>
      </div>
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-zinc-500">{isUz ? 'Chetlanish' : 'Отклонение'}</span>
        <span
          className={`font-mono tabular-nums ${
            deviation < 0 ? 'text-red-600 dark:text-red-400 font-semibold' : ''
          }`}
        >
          {formatNumber(row.deviation, 0)}
        </span>
      </div>
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-zinc-500">{isUz ? 'Holat' : 'Состояние'}</span>
        <span className={`px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide ${state.cls}`}>
          {isUz ? state.uz : state.ru}
        </span>
      </div>
      {row.responsible && (
        <div className="flex items-center justify-between px-3 py-2">
          <span className="text-zinc-500">{isUz ? 'Mas’ul' : 'Ответственный'}</span>
          <span className="truncate max-w-[60%] text-right">{row.responsible.fullName}</span>
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Ряд 2: правая панель — карточка операции с проводками
// ---------------------------------------------------------------------------

/**
 * Что можно сделать с операцией в её нынешнем статусе.
 *
 * Список тот же, что сторожит сервер, и это сознательное дублирование: экран
 * не должен предлагать кнопку, которая гарантированно вернёт 409. Решает всё
 * равно сервер — здесь только то, что человеку показывать.
 */
const ACTIONS: Record<string, { action: FinanceAction; right: string; primary?: boolean }[]> = {
  draft: [{ action: 'submit', right: 'finance.post', primary: true }],
  pending_approval: [
    { action: 'approve', right: 'finance.approve', primary: true },
    { action: 'reject', right: 'finance.approve' },
  ],
  approved: [
    { action: 'post', right: 'finance.post', primary: true },
    { action: 'reject', right: 'finance.approve' },
  ],
};

const ACTION_LABEL: Record<FinanceAction, { ru: string; uz: string }> = {
  submit: { ru: 'На согласование', uz: 'Kelishuvga' },
  approve: { ru: 'Утвердить', uz: 'Tasdiqlash' },
  reject: { ru: 'Отклонить', uz: 'Rad etish' },
  post: { ru: 'Провести', uz: 'O‘tkazish' },
};

const BTN_BASE =
  'px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-40 ' +
  'disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400';
const BTN_PRIMARY =
  BTN_BASE +
  ' bg-zinc-900 text-zinc-50 hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200';
const BTN_GHOST =
  BTN_BASE +
  ' border border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300 ' +
  'hover:bg-zinc-100 dark:hover:bg-zinc-800';

/**
 * Полоса действий под карточкой.
 *
 * Отклонение просит причину и не отпускает без неё: «отклонено» без объяснения
 * возвращается к тому, кто подавал заявку, вопросом в мессенджер, а не работой.
 * Остальные три действия подтверждения не требуют — каждое обратимо следующим
 * шагом, кроме проведения, а проведение сторнируется отдельной операцией.
 */
const ActionBar: React.FC<{ card: FinanceOperationCard; isUz: boolean }> = ({ card, isUz }) => {
  const op = card.operation;
  const { can } = useAuth();
  const { act, reverse, acting, actionError, clearActionError, openForm } = useFinance();

  // Что сейчас подтверждают: отклонение или сторно. Оба спрашивают причину,
  // но отклонение без неё не отпускает, а сторно её только предлагает.
  const [pending, setPending] = React.useState<'reject' | 'reverse' | null>(null);
  const [reason, setReason] = React.useState('');

  // Сменили операцию — форма отказа от прошлой к этой отношения не имеет.
  React.useEffect(() => {
    setPending(null);
    setReason('');
  }, [op.uid]);

  const allowed = (ACTIONS[op.status] ?? []).filter((a) => can(a.right));
  const canEdit = op.status === 'draft' && can('finance.post');
  // Сторнируют проведённую, и только если у неё есть корреспондент: зеркалить
  // проводку не на что, и сервер откажет 409.
  const canReverse = op.status === 'posted' && op.counterAccount !== null && can('finance.post');

  if (allowed.length === 0 && !canEdit && !canReverse && !actionError) {
    return (
      <div className="pt-3 border-t border-zinc-100 dark:border-zinc-800/60 shrink-0 text-[11px] text-zinc-400">
        {isUz
          ? 'Bu holatda amal yo‘q'
          : op.status === 'reversed'
            ? 'Операция сторнирована: её проводки уже отменены'
            : op.status === 'posted'
              ? 'Операция закрыта: у неё нет корреспондента, сторнировать нечем'
              : 'Действий в этом статусе нет или не хватает прав'}
      </div>
    );
  }

  const run = async (action: FinanceAction) => {
    if (action === 'reject' && pending !== 'reject') {
      clearActionError();
      setPending('reject');
      return;
    }
    await act(action, action === 'reject' ? reason.trim() : undefined);
    setPending(null);
    setReason('');
  };

  const runReverse = async () => {
    if (pending !== 'reverse') {
      clearActionError();
      setPending('reverse');
      return;
    }
    await reverse(reason.trim() || undefined);
    setPending(null);
    setReason('');
  };

  const busy = acting !== null;

  return (
    <div className="pt-3 border-t border-zinc-100 dark:border-zinc-800/60 shrink-0 space-y-2">
      {actionError && (
        <div className="flex items-start gap-2 p-2 rounded-lg bg-red-50 dark:bg-red-950/30 text-[11px] text-red-700 dark:text-red-300">
          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-px" />
          <span className="min-w-0">{actionError.message}</span>
        </div>
      )}

      {pending === 'reverse' && (
        <div className="text-[11px] text-zinc-500">
          {isUz
            ? 'Storno original provodkalarni qaytaruvchi ikkinchi operatsiya yaratadi'
            : 'Сторно заведёт вторую операцию с обратной проводкой; исходная останется в журнале'}
        </div>
      )}

      {pending && (
        <input
          type="text"
          value={reason}
          autoFocus
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
          placeholder={
            pending === 'reject'
              ? isUz
                ? 'Rad etish sababi'
                : 'Причина отклонения'
              : isUz
                ? 'Storno sababi, majburiy emas'
                : 'Причина сторно, необязательно'
          }
          aria-label={
            pending === 'reject'
              ? isUz
                ? 'Rad etish sababi'
                : 'Причина отклонения'
              : isUz
                ? 'Storno sababi'
                : 'Причина сторно'
          }
          className="w-full px-2.5 py-1.5 rounded-lg text-xs bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400"
        />
      )}

      <div className="flex flex-wrap items-center gap-2">
        {allowed.map(({ action, primary }) => (
          <button
            key={action}
            type="button"
            onClick={() => run(action)}
            disabled={
              busy ||
              (action === 'reject' && pending === 'reject' && reason.trim().length === 0) ||
              pending === 'reverse'
            }
            className={primary ? BTN_PRIMARY : BTN_GHOST}
          >
            {acting === action
              ? isUz
                ? 'Bajarilmoqda…'
                : 'Выполняю…'
              : isUz
                ? ACTION_LABEL[action].uz
                : ACTION_LABEL[action].ru}
          </button>
        ))}

        {canEdit && (
          <button
            type="button"
            onClick={() => openForm({ mode: 'edit', uid: op.uid })}
            disabled={busy || pending !== null}
            className={BTN_GHOST}
          >
            {isUz ? 'Tahrirlash' : 'Править'}
          </button>
        )}

        {canReverse && (
          <button type="button" onClick={runReverse} disabled={busy} className={BTN_GHOST}>
            {acting === 'reverse'
              ? isUz
                ? 'Bajarilmoqda…'
                : 'Выполняю…'
              : pending === 'reverse'
                ? isUz
                  ? 'Stornoni tasdiqlash'
                  : 'Подтвердить сторно'
                : isUz
                  ? 'Storno'
                  : 'Сторно'}
          </button>
        )}

        {pending && (
          <button
            type="button"
            onClick={() => {
              setPending(null);
              setReason('');
            }}
            disabled={busy}
            className={BTN_GHOST}
          >
            {isUz ? 'Bekor qilish' : 'Отмена'}
          </button>
        )}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Форма операции: заведение и правка черновика
// ---------------------------------------------------------------------------

/**
 * Поля формы держим строками ровно в том виде, в каком их примет сервер:
 * сумма и курс — строки, потому что у `number` копейки на миллиардах теряются,
 * а дата — `YYYY-MM-DD` из `input[type=date]`.
 */
type FormState = {
  companyUid: string;
  operationType: FinanceOperationType;
  accountCode: string;
  counterAccountCode: string;
  amount: string;
  currencyCode: string;
  rate: string;
  occurredAt: string;
  plannedDate: string;
  cashflowItemUid: string;
  partnerUid: string;
  comment: string;
};

const FIELD =
  'w-full h-8 px-2.5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white ' +
  'dark:bg-zinc-900 text-xs text-zinc-950 dark:text-zinc-50 placeholder:text-zinc-400 ' +
  'focus:outline-hidden focus:border-zinc-400 transition-colors shadow-2xs';

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

const MONEY_RE = /^\d{1,15}([.,]\d{1,4})?$/;

/** Режим «заведение» для панели покоя: он там всегда один и тот же. */
const CREATE: Exclude<FinanceFormMode, null> = { mode: 'create' };

/**
 * Сегодня — по Ташкенту. `new Date().toISOString()` до 05:00 местного времени
 * отдаёт прошлую дату: ночная смена получала в поле «Дата» вчерашнее число.
 */
const today = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date());

/**
 * Форма занимает правую панель целиком, а не всплывает поверх экрана.
 *
 * Причина простая: при заведении операции человек сверяется с журналом слева —
 * туда он и смотрит, набирая сумму и выбирая счёт. Модалка закрыла бы ровно то,
 * ради чего её открыли, а на 360 закрыла бы и вовсе всё.
 *
 * Списки — наш `CustomSelect`, тот же, что на складе, в продажах и на
 * производстве; календарь — наш `CustomDatePicker`, до сих пор не встроенный
 * никуда. Раньше здесь стояли родные `select` и `input type=date`
 * ровно по одной причине: панель прокручиваемая, а выпадашка на
 * `position: absolute` обрезается её краем. Теперь эти два поля умеют рисовать
 * свой список поверх страницы (`portal`), так что причина держаться за системные
 * контролы исчезла, а экран перестал выбиваться из остального интерфейса.
 */
const OperationForm: React.FC<{
  mode: Exclude<FinanceFormMode, null>;
  card: FinanceOperationCard | null;
  isUz: boolean;
  /**
   * Форма — постоянное содержимое правой панели, а не открытый поверх неё шаг.
   * Закрывать её некуда, поэтому вторая кнопка сбрасывает набранное.
   */
  standalone?: boolean;
}> = ({ mode, card, isUz, standalone = false }) => {
  const { session } = useAuth();
  const { company } = useApp();
  const { refs, save, saving, saveError, closeForm } = useFinance();
  const editing = mode.mode === 'edit';
  const op = editing ? card?.operation : undefined;

  /**
   * Компании — только те, что сейчас открыты переключателем наверху.
   *
   * Он же задаёт заголовок `X-Company-Id`, а сервер по нему сужает доступ. Если
   * предложить в форме компанию, которую заголовок закрыл, сохранение вернёт
   * «компания недоступна» — отказ на выбор, который сама форма и предложила.
   */
  const CODE_BY_SWITCH: Record<string, string> = { company_trade: 'trade', company_factory: 'plant' };
  const onlyCode = CODE_BY_SWITCH[company];
  const companies = (session?.companies ?? []).filter((c) => !onlyCode || c.code === onlyCode);

  const blank = (): FormState => ({
    companyUid: op?.company.uid ?? companies[0]?.uid ?? '',
    operationType: op?.type ?? 'expense',
    accountCode: op?.account.code ?? '',
    counterAccountCode: op?.counterAccount?.code ?? '',
    amount: op ? String(op.amount) : '',
    currencyCode: op?.currency ?? 'UZS',
    rate: op ? String(op.rate) : '1',
    occurredAt: op ? op.occurredAt.slice(0, 10) : today(),
    plannedDate: op?.plannedDate ? op.plannedDate.slice(0, 10) : '',
    cashflowItemUid: '',
    partnerUid: op?.partner?.uid ?? '',
    comment: op?.comment ?? '',
  });

  const [state, setState] = React.useState<FormState>(blank);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setState((s) => ({ ...s, [key]: value }));

  const data = refs.data;

  /**
   * Справочник приходит по всем компаниям пользователя сразу, и строки в нём
   * неразличимы на вид: счёт 5010 есть в обеих книгах, «Заработная плата» —
   * тоже. Предложить их общим списком значит подставить человеку отказ: счёт
   * подберётся по коду в его же компании и промолчит, а статья ДДС и
   * контрагент опознаются по id и вернут 422 на сохранении. Поэтому в форме
   * видно ровно ту компанию, в которую операция и пишется.
   */
  const ofCompany = <T extends { companyUid: string }>(rows: T[] | undefined) =>
    (rows ?? []).filter((r) => r.companyUid === state.companyUid);

  const accounts = ofCompany(data?.accounts);
  const cashflowItems = ofCompany(data?.cashflowItems);
  const partners = ofCompany(data?.partners);
  const inBase = state.currencyCode === 'UZS';

  /**
   * Пустая строка в начале списка — это «не выбрано», а не значение. Счёту она
   * нужна, чтобы форма не подставила первый счёт плана как будто его выбрали;
   * статье и контрагенту — потому что они необязательны.
   */
  const accountOptions: CustomSelectOption[] = [
    { value: '', label: isUz ? 'tanlang' : 'выберите' },
    ...accounts.map((a) => ({
      value: a.code,
      label: refName(a, isUz),
      badge: a.code,
    })),
  ];

  const companyOptions: CustomSelectOption[] = companies.map((c) => ({
    value: c.uid,
    label: refName(c, isUz),
  }));

  const typeOptions: CustomSelectOption[] = (Object.keys(OP_TYPE) as FinanceOperationType[]).map(
    (t) => ({ value: t, label: label(OP_TYPE, t, isUz) }),
  );

  const currencyOptions: CustomSelectOption[] = (data?.currencies ?? [state.currencyCode]).map(
    (c) => ({ value: c, label: c }),
  );

  const cashflowOptions: CustomSelectOption[] = [
    {
      value: '',
      label: editing
        ? isUz
          ? 'o‘zgartirmaslik'
          : 'не менять'
        : isUz
          ? 'ko‘rsatilmagan'
          : 'не указана',
    },
    ...cashflowItems.map((i) => ({ value: i.uid, label: refName(i, isUz) })),
  ];

  const partnerOptions: CustomSelectOption[] = [
    { value: '', label: isUz ? 'ko‘rsatilmagan' : 'не указан' },
    ...partners.map((p) => ({ value: p.uid, label: refName(p, isUz) })),
  ];

  /**
   * Смена компании обнуляет всё, что выбрано из её справочника. Без этого
   * прежний выбор остался бы в поле молча: коды счетов в компаниях совпадают,
   * так что «5010» выглядит выбранным и после переключения — но это уже другой
   * счёт другой книги.
   */
  /**
   * Переключатель компаний наверху мог закрыть ту, что выбрана в форме.
   *
   * Раньше это решалось само: смена компании закрывала форму, и следующая
   * открывалась с чистого листа. Теперь форма — постоянное содержимое панели и
   * смену компании переживает, так что выбор надо поправить руками. Иначе
   * `companyUid` останется от прошлой книги, справочники по нему отфильтруются
   * в ноль, и человек увидит пустые списки счетов без всякого объяснения.
   */
  const companyKey = companies.map((c) => c.uid).join(',');
  React.useEffect(() => {
    if (companies.length === 0) return;
    if (companies.some((c) => c.uid === state.companyUid)) return;
    set('companyUid', companies[0].uid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyKey, state.companyUid]);

  const prevCompany = React.useRef(state.companyUid);
  React.useEffect(() => {
    if (prevCompany.current === state.companyUid) return;
    prevCompany.current = state.companyUid;
    setState((s) => ({
      ...s,
      accountCode: '',
      counterAccountCode: '',
      cashflowItemUid: '',
      partnerUid: '',
    }));
  }, [state.companyUid]);

  // Проверки те же, что у сервера, и это сознательное дублирование: отправлять
  // заведомо отказной запрос, чтобы прочитать отказ, — лишний круг.
  const problem = (): string | null => {
    if (!state.accountCode || !state.counterAccountCode) {
      return isUz ? 'Hisoblarni tanlang' : 'Выберите оба счёта';
    }
    if (state.accountCode === state.counterAccountCode) {
      return isUz ? 'Hisob va korrespondent har xil bo‘lsin' : 'Счёт и корреспондент должны различаться';
    }
    if (!MONEY_RE.test(state.amount.trim())) {
      return isUz ? 'Summa — nuqtadan keyin 4 tagacha raqam' : 'Сумма: число, до четырёх знаков после запятой';
    }
    if (!inBase && !MONEY_RE.test(state.rate.trim())) {
      return isUz ? 'Kurs kerak' : 'Для валюты нужен курс';
    }
    return null;
  };

  const invalid = problem();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (invalid || saving) return;

    const common = {
      accountCode: state.accountCode,
      counterAccountCode: state.counterAccountCode,
      amount: state.amount.trim().replace(',', '.'),
      currencyCode: state.currencyCode,
      // Курс в базовой валюте всегда единица: слать пересчёт сума в сум незачем.
      ...(inBase ? {} : { rate: state.rate.trim().replace(',', '.') }),
      occurredAt: state.occurredAt,
      ...(state.plannedDate ? { plannedDate: state.plannedDate } : {}),
      ...(state.cashflowItemUid ? { cashflowItemUid: state.cashflowItemUid } : {}),
      ...(state.partnerUid ? { partnerUid: state.partnerUid } : {}),
      ...(state.comment.trim() ? { comment: state.comment.trim() } : {}),
    };

    await save(
      editing
        ? { version: op!.version, ...common }
        : { companyUid: state.companyUid, operationType: state.operationType, ...common },
    );
  };

  return (
    <form onSubmit={submit} className="flex-1 flex flex-col justify-between overflow-hidden gap-3">
      <div className="flex items-start justify-between gap-2 pb-2.5 border-b border-zinc-100 dark:border-zinc-800/60 shrink-0">
        <div className="min-w-0">
          <span className="text-[10px] font-mono text-zinc-400 uppercase tracking-wider">
            {isUz ? 'Operatsiya' : 'Операция'}
          </span>
          <div className="text-base font-bold text-zinc-950 dark:text-zinc-50">
            {editing
              ? isUz
                ? 'Qoralamani tahrirlash'
                : 'Правка черновика'
              : isUz
                ? 'Yangi operatsiya'
                : 'Новая операция'}
          </div>
          {editing && op && <div className="text-[11px] font-mono text-zinc-500">{op.number}</div>}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto pr-1 space-y-2.5">
        {refs.error && !data && (
          <ErrorBox text={errorText(refs.error, isUz)} isUz={isUz} />
        )}

        {!editing && companies.length > 1 && (
          <FieldRow label={isUz ? 'Kompaniya' : 'Компания'}>
            <CustomSelect
              portal
              ariaLabel={isUz ? 'Kompaniya' : 'Компания'}
              value={state.companyUid}
              onChange={(v) => set('companyUid', v)}
              options={companyOptions}
            />
          </FieldRow>
        )}

        {!editing && (
          <FieldRow label={isUz ? 'Turi' : 'Тип'}>
            <CustomSelect
              portal
              ariaLabel={isUz ? 'Turi' : 'Тип'}
              value={state.operationType}
              onChange={(v) => set('operationType', v as FinanceOperationType)}
              options={typeOptions}
            />
          </FieldRow>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          <FieldRow label={isUz ? 'Hisob' : 'Счёт'}>
            <CustomSelect
              portal
              ariaLabel={isUz ? 'Hisob' : 'Счёт'}
              value={state.accountCode}
              onChange={(v) => set('accountCode', v)}
              options={accountOptions}
            />
          </FieldRow>

          <FieldRow label={isUz ? 'Korrespondent' : 'Корреспондент'}>
            <CustomSelect
              portal
              ariaLabel={isUz ? 'Korrespondent' : 'Корреспондент'}
              value={state.counterAccountCode}
              onChange={(v) => set('counterAccountCode', v)}
              options={accountOptions}
            />
          </FieldRow>

          <FieldRow label={isUz ? 'Summa' : 'Сумма'}>
            <input
              type="text"
              inputMode="decimal"
              value={state.amount}
              onChange={(e) => set('amount', e.target.value)}
              placeholder="1250000.00"
              aria-label={isUz ? 'Summa' : 'Сумма'}
              className={`${FIELD} font-mono`}
            />
          </FieldRow>

          <FieldRow label={isUz ? 'Valyuta' : 'Валюта'}>
            <CustomSelect
              portal
              ariaLabel={isUz ? 'Valyuta' : 'Валюта'}
              value={state.currencyCode}
              onChange={(v) => set('currencyCode', v)}
              options={currencyOptions}
            />
          </FieldRow>

          {/* Курс спрашиваем только там, где он что-то значит: в сумах он всегда
              единица, и поле под него было бы обязательным вопросом ни о чём. */}
          {!inBase && (
            <FieldRow
              label={isUz ? 'Kurs' : 'Курс'}
              hint={isUz ? 'Bazaviy valyutaga' : 'К сумам, для проводки'}
            >
              <input
                type="text"
                inputMode="decimal"
                value={state.rate}
                onChange={(e) => set('rate', e.target.value)}
                aria-label={isUz ? 'Kurs' : 'Курс'}
                className={`${FIELD} font-mono`}
              />
            </FieldRow>
          )}

          <FieldRow label={isUz ? 'Sana' : 'Дата'}>
            <CustomDatePicker
              portal
              ariaLabel={isUz ? 'Sana' : 'Дата'}
              value={state.occurredAt}
              onChange={(v) => set('occurredAt', v)}
            />
          </FieldRow>

          <FieldRow label={isUz ? 'Reja sanasi' : 'Плановая дата'}>
            <CustomDatePicker
              portal
              ariaLabel={isUz ? 'Reja sanasi' : 'Плановая дата'}
              value={state.plannedDate}
              onChange={(v) => set('plannedDate', v)}
              placeholder={isUz ? 'ko‘rsatilmagan' : 'не указана'}
            />
          </FieldRow>
        </div>

        {/* Статью правка не подставляет: в карточке приходит её название, а не
            id, и у холдинга одноимённые статьи есть в обеих компаниях — угадав
            не ту, форма сохранила бы операцию по статье чужой книги. Пустой
            выбор здесь означает «оставить как есть», и так и подписан. */}
        <FieldRow label={isUz ? 'PDH moddasi' : 'Статья ДДС'}>
          <CustomSelect
            portal
            ariaLabel={isUz ? 'PDH moddasi' : 'Статья ДДС'}
            value={state.cashflowItemUid}
            onChange={(v) => set('cashflowItemUid', v)}
            options={cashflowOptions}
          />
        </FieldRow>

        <FieldRow label={isUz ? 'Kontragent' : 'Контрагент'}>
          <CustomSelect
            portal
            ariaLabel={isUz ? 'Kontragent' : 'Контрагент'}
            value={state.partnerUid}
            onChange={(v) => set('partnerUid', v)}
            options={partnerOptions}
          />
        </FieldRow>

        <FieldRow label={isUz ? 'Izoh' : 'Комментарий'}>
          <input
            type="text"
            value={state.comment}
            maxLength={500}
            onChange={(e) => set('comment', e.target.value)}
            aria-label={isUz ? 'Izoh' : 'Комментарий'}
            className={FIELD}
          />
        </FieldRow>
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
            {saving
              ? isUz
                ? 'Saqlanmoqda…'
                : 'Сохраняю…'
              : isUz
                ? 'Saqlash'
                : 'Сохранить'}
          </button>
          <button
            type="button"
            onClick={() => (standalone ? setState(blank()) : closeForm())}
            disabled={saving}
            className={BTN_GHOST}
          >
            {standalone ? (isUz ? 'Tozalash' : 'Сбросить') : isUz ? 'Bekor qilish' : 'Отмена'}
          </button>
          <span className="text-[10px] text-zinc-400">
            {isUz ? 'Qoralama sifatida saqlanadi' : 'Сохранится черновиком'}
          </span>
        </div>
      </div>
    </form>
  );
};

const OperationPanel: React.FC<{
  card: FinanceOperationCard;
  isUz: boolean;
}> = ({ card, isUz }) => {
  const op = card.operation;
  const { setSelectedUid } = useFinance();

  return (
    <div className="flex-1 flex flex-col justify-between overflow-hidden">
      <div className="space-y-3 text-xs overflow-y-auto pr-1">
        <div className="flex items-start justify-between gap-2 pb-2.5 border-b border-zinc-100 dark:border-zinc-800/60">
          <div className="min-w-0">
            <span className="text-[10px] font-mono text-zinc-400 uppercase tracking-wider">
              {isUz ? 'Operatsiya kartasi' : 'Карточка операции'}
            </span>
            <div className="text-base font-bold font-mono text-zinc-950 dark:text-zinc-50">
              {op.number}
            </div>
            <div className="text-[11px] text-zinc-500 font-mono">
              {formatDateTime(op.occurredAt)} • {op.company.code}
            </div>
          </div>
          <div className="flex flex-col items-end gap-1 shrink-0">
            <div className="flex items-center gap-1.5">
              <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100">
                {label(OP_STATUS, op.status, isUz)}
              </span>
              {/* Карточку надо уметь закрыть: панель одна, и пока в ней открыта
                  операция, заводить следующую негде. */}
              <button
                type="button"
                onClick={() => setSelectedUid(null)}
                aria-label={isUz ? 'Kartani yopish' : 'Закрыть карточку'}
                className="p-1 rounded-md text-zinc-400 hover:text-zinc-950 dark:hover:text-zinc-50 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
              >
                <X size={13} />
              </button>
            </div>
            <span className="text-[10px] text-zinc-500">{label(OP_TYPE, op.type, isUz)}</span>
          </div>
        </div>

        <div className="p-3 rounded-lg border border-zinc-100 dark:border-zinc-800 bg-zinc-50/60 dark:bg-zinc-900/40 space-y-1">
          <div className="text-[10px] text-zinc-400 uppercase tracking-wider">
            {isUz ? 'Summa' : 'Сумма'}
          </div>
          <div className="font-mono font-bold text-zinc-950 dark:text-zinc-50 text-sm">
            {formatNumber(op.amount, 0)} {op.currency}
          </div>
          <div className="text-[11px] font-mono text-zinc-500">
            {op.currency === 'UZS'
              ? `${isUz ? 'Modda' : 'Статья'}: ${
                  op.cashflowItem ? (refName(op.cashflowItem, isUz)) : '—'
                }`
              : `${isUz ? 'Kurs' : 'Курс'} ${formatNumber(op.rate, 2)} → ${formatNumber(
                  op.amountBase,
                  0,
                )} UZS`}
          </div>
        </div>

        {/* Проводки — то, ради чего панель существует: дебет против кредита. */}
        <div className="space-y-1.5">
          <div className="text-[10px] text-zinc-400 uppercase tracking-wider">
            {isUz ? 'Provodkalar' : 'Проводки'}
          </div>
          {card.entries.length === 0 ? (
            <div className="text-[11px] text-zinc-400">
              {isUz ? 'Provodkalar o‘tkazishda paydo bo‘ladi' : 'Проводки появятся при проведении'}
            </div>
          ) : (
            card.entries.map((e, i) => {
              const debit = toNumber(e.debit);
              return (
                <div
                  key={`${e.account.code}-${i}`}
                  className="p-2.5 rounded-lg border border-zinc-100 dark:border-zinc-800 space-y-1"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-zinc-900 dark:text-zinc-100 text-xs truncate">
                      <span className="font-mono">{e.account.code}</span>{' '}
                      {refName(e.account, isUz)}
                    </span>
                    <span className="text-[10px] font-mono text-zinc-400 shrink-0">
                      {label(ACCOUNT_KIND, e.account.kind, isUz)}
                    </span>
                  </div>
                  <div className="flex justify-between gap-2 text-[11px] font-mono">
                    <span className="text-zinc-500">
                      {debit > 0 ? (isUz ? 'Debet' : 'Дебет') : isUz ? 'Kredit' : 'Кредит'}
                    </span>
                    <span className="font-semibold text-zinc-950 dark:text-zinc-50">
                      {formatNumber(debit > 0 ? e.debit : e.credit, 0)} UZS
                    </span>
                  </div>
                </div>
              );
            })
          )}
        </div>

        <div className="p-3 rounded-lg border border-zinc-100 dark:border-zinc-800 space-y-1.5 font-mono text-[11px]">
          <div className="flex justify-between gap-2 text-zinc-500">
            <span>{isUz ? 'Debet jami:' : 'Итого дебет:'}</span>
            <span>{formatNumber(card.totals.debit, 0)}</span>
          </div>
          <div className="flex justify-between gap-2 text-zinc-500">
            <span>{isUz ? 'Kredit jami:' : 'Итого кредит:'}</span>
            <span>{formatNumber(card.totals.credit, 0)}</span>
          </div>
          <div className="flex justify-between gap-2 pt-1 border-t border-zinc-100 dark:border-zinc-800 text-xs font-bold">
            <span className="text-zinc-500">{isUz ? 'Balans:' : 'Баланс:'}</span>
            <span
              className={
                card.balanced ? 'text-zinc-950 dark:text-zinc-50' : 'text-red-600 dark:text-red-400'
              }
            >
              {card.balanced ? (isUz ? 'teng' : 'сходится') : isUz ? 'teng emas' : 'не сходится'}
            </span>
          </div>
        </div>

        <div className="text-[11px] text-zinc-500 space-y-1">
          <div>
            {isUz ? 'Hisob:' : 'Счёт:'} {op.account.code} {op.account.nameRu}
          </div>
          {op.counterAccount && (
            <div>
              {isUz ? 'Korrespondent:' : 'Корреспондент:'} {op.counterAccount.code}{' '}
              {refName(op.counterAccount, isUz)}
            </div>
          )}
          <div>
            {isUz ? 'Kontragent:' : 'Контрагент:'} {op.partner ? op.partner.nameRu : '—'}
          </div>
          <div>
            {isUz ? 'Reja sanasi:' : 'Плановая дата:'} {formatDate(op.plannedDate)}
          </div>
          <div>
            {isUz ? 'O‘tkazilgan:' : 'Проведена:'} {formatDateTime(op.postedAt)}
          </div>
          <div>
            {isUz ? 'Yaratdi:' : 'Создал:'} {op.createdBy ?? '—'}
            {op.approvedBy ? ` • ${isUz ? 'tasdiqladi' : 'утвердил'} ${op.approvedBy}` : ''}
          </div>
          {op.comment && <div className="text-zinc-400">{op.comment}</div>}
        </div>
      </div>

      <div className="pt-2 shrink-0 text-[11px] font-mono text-zinc-400 flex items-center justify-between gap-2">
        <span className="truncate">{op.sourceDocType ?? (isUz ? 'qo‘lda' : 'вручную')}</span>
        <span className="shrink-0">
          {card.entries.length}{' '}
          {isUz ? 'provodka' : plural(card.entries.length, 'проводка', 'проводки', 'проводок')}
        </span>
      </div>

      <ActionBar card={card} isUz={isUz} />
    </div>
  );
};

// ---------------------------------------------------------------------------

export const FinanceView: React.FC = () => {
  const { theme, locale } = useApp();
  const isUz = locale === 'uz';
  const {
    period,
    setPeriod,
    summary,
    reloadSummary,
    section,
    setSection,
    status,
    setStatus,
    type,
    setType,
    search,
    setSearch,
    operations,
    reloadOperations,
    overdueOnly,
    setOverdueOnly,
    receivables,
    planFact,
    report,
    selectedUid,
    setSelectedUid,
    operation,
    form,
  } = useFinance();
  const { can } = useAuth();
  /** Выбранный бюджет живёт отдельно от выбранной операции: это разные разделы. */
  const [budgetUid, setBudgetUid] = React.useState<string | null>(null);

  const statusOptions = [
    { value: 'all', label: isUz ? 'Barcha holatlar' : 'Все статусы' },
    ...(Object.keys(OP_STATUS) as FinanceStatus[]).map((s) => ({
      value: s,
      label: label(OP_STATUS, s, isUz),
    })),
  ];

  const typeOptions = [
    { value: 'all', label: isUz ? 'Barcha turlar' : 'Все типы' },
    ...(Object.keys(OP_TYPE) as FinanceOperationType[]).map((t) => ({
      value: t,
      label: label(OP_TYPE, t, isUz),
    })),
  ];

  const tabs: {
    key: FinanceSection;
    ru: string;
    uz: string;
    count: number | null;
  }[] = [
    {
      key: 'operations',
      ru: 'Операции',
      uz: 'Operatsiyalar',
      count: operations.data?.rows.length ?? null,
    },
    {
      key: 'receivables',
      ru: 'Дебиторка',
      uz: 'Debitorlik',
      count: receivables.data?.rows.length ?? null,
    },
    {
      key: 'planfact',
      ru: 'План-факт',
      uz: 'Reja-fakt',
      count: planFact.data?.rows.length ?? null,
    },
    {
      key: 'reports',
      ru: 'Отчёты',
      uz: 'Hisobotlar',
      count: report.data?.total ?? null,
    },
  ];

  /**
   * Отчёт занимает всю ширину: у него собственная шапка с видами, периодом и
   * выгрузкой, а в таблице до четырнадцати колонок. В восьми колонках сетки
   * правый край уехал бы под прокрутку — а именно там стоят просрочка и
   * рентабельность, ради которых отчёт и открывают.
   */
  const wide = section === 'reports';

  const active =
    section === 'operations'
      ? operations
      : section === 'receivables'
        ? receivables
        : section === 'reports'
          ? report
          : planFact;
  const rowCount =
    section === 'operations'
      ? (operations.data?.rows.length ?? null)
      : section === 'receivables'
        ? (receivables.data?.rows.length ?? null)
        : section === 'reports'
          ? (report.data?.total ?? null)
          : (planFact.data?.rows.length ?? null);

  const renderList = () => {
    // Отчёт сам показывает и загрузку, и ошибку, и пустоту: у него своя шапка,
    // и общая заглушка стёрла бы её вместе с выбранным видом и периодом.
    if (section === 'reports') return <FinanceReportsPanel isUz={isUz} />;

    if (active.error && !active.data) {
      return (
        <ErrorBox
          text={errorText(active.error, isUz)}
          onRetry={section === 'operations' ? reloadOperations : undefined}
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

    if (section === 'operations') {
      const rows = operations.data?.rows ?? [];
      if (rows.length === 0) {
        return (
          <Empty
            text={
              search
                ? isUz
                  ? 'So‘rov bo‘yicha operatsiya topilmadi'
                  : 'По запросу операций не найдено'
                : isUz
                  ? 'Bu filtr bo‘yicha operatsiya yo‘q'
                  : 'По этому фильтру операций нет'
            }
          />
        );
      }
      return (
        <div className="divide-y divide-zinc-100 dark:divide-zinc-800/40">
          {rows.map((row) => (
            <OperationRow
              key={row.uid}
              row={row}
              isUz={isUz}
              selected={selectedUid === row.uid}
              onOpen={() => setSelectedUid(row.uid)}
            />
          ))}
        </div>
      );
    }

    if (section === 'receivables') {
      const rows = receivables.data?.rows ?? [];
      if (rows.length === 0) {
        return (
          <Empty
            text={
              overdueOnly
                ? isUz
                  ? 'Kechikkan qarz yo‘q'
                  : 'Просроченной задолженности нет'
                : isUz
                  ? 'Qarzdorlar yo‘q'
                  : 'Должников нет'
            }
          />
        );
      }
      return (
        <div className="divide-y divide-zinc-100 dark:divide-zinc-800/40">
          {rows.map((row) => (
            <ReceivableRow key={row.partner.uid} row={row} isUz={isUz} />
          ))}
        </div>
      );
    }

    const pf = planFact.data;
    if (!pf || pf.rows.length === 0) {
      return (
        <Empty
          text={
            can('finance.approve')
              ? isUz
                ? 'Byudjetlar kiritilmagan: o‘ngdagi shaklda birinchisini kiriting'
                : 'Бюджеты не заданы: заведите первый формой справа'
              : isUz
                ? 'Byudjetlar kiritilmagan'
                : 'Бюджеты не заданы'
          }
        />
      );
    }
    return (
      <PlanFactTable
        data={pf}
        isUz={isUz}
        selected={budgetUid}
        onSelect={(uid) => setBudgetUid(uid === budgetUid ? null : uid)}
      />
    );
  };

  const renderPanel = () => {
    // В «План-факте» панель про бюджет, а не про операцию: в этом разделе
    // карточки операции нет вовсе, и форма заведения — это форма бюджета.
    if (section === 'planfact') {
      if (planFact.error && !planFact.data) {
        return <ErrorBox text={errorText(planFact.error, isUz)} isUz={isUz} />;
      }
      return (
        <BudgetPanel
          rows={planFact.data?.rows ?? []}
          selected={budgetUid}
          onSelect={setBudgetUid}
          isUz={isUz}
        />
      );
    }
    // Форма перекрывает карточку: панель одна, и показывать рядом правку
    // черновика и его же карточку значило бы показывать одно и то же дважды.
    if (form) {
      return <OperationForm mode={form} card={operation.data} isUz={isUz} />;
    }
    // Ничего не выбрано — панель не пустует, а сразу принимает новую операцию:
    // отдельной кнопки «Новая операция» больше нет, форма и есть состояние
    // покоя. Кому заводить нельзя, тот видит прежнюю подсказку.
    if (selectedUid === null) {
      if (can('finance.post')) {
        return <OperationForm mode={CREATE} card={null} isUz={isUz} standalone />;
      }
      return (
        <Empty
          text={
            isUz
              ? 'Provodkalarni ko‘rish uchun operatsiyani tanlang'
              : 'Выберите операцию, чтобы увидеть проводки'
          }
        />
      );
    }
    if (operation.error && !operation.data) {
      return <ErrorBox text={errorText(operation.error, isUz)} isUz={isUz} />;
    }
    if (!operation.data) {
      return (
        <div className="flex-1 space-y-2 animate-pulse" aria-hidden>
          <div className="h-5 w-32 rounded bg-zinc-200 dark:bg-zinc-800" />
          <div className="h-16 w-full rounded bg-zinc-200 dark:bg-zinc-800" />
          <div className="h-20 w-full rounded bg-zinc-200 dark:bg-zinc-800" />
          <div className="h-24 w-full rounded bg-zinc-200 dark:bg-zinc-800" />
        </div>
      );
    }
    return <OperationPanel card={operation.data} isUz={isUz} />;
  };

  const footerLeft = () => {
    if (section === 'operations') {
      return operations.data && operations.data.rows.length >= 100
        ? isUz
          ? 'So‘nggi 100 yozuv ko‘rsatilgan'
          : 'Показаны последние 100 записей'
        : periodLabel(period, isUz);
    }
    if (section === 'receivables') {
      const totals = receivables.data?.totals;
      return totals
        ? `${isUz ? 'Qarz' : 'Долг'} ${formatMoneyShort(totals.debt, isUz ? 'uz' : 'ru')} • ${
            isUz ? 'kechikkan' : 'просрочено'
          } ${formatMoneyShort(totals.overdue, isUz ? 'uz' : 'ru')}`
        : '—';
    }
    if (section === 'reports') {
      // Подзаголовок отчёта сервер уже собрал — он же уходит в файл. Второй
      // свой итог здесь разошёлся бы с ним.
      return report.data?.subtitle ?? '—';
    }
    const totals = planFact.data?.totals;
    if (!totals) return '—';
    // Сколько бюджетов у порога и сколько перерасходовано — числом в подвале:
    // иначе это предлагается считать глазами по строкам.
    const flags = [
      totals.warn > 0 ? `${isUz ? 'chegarada' : 'у порога'} ${totals.warn}` : null,
      totals.over > 0 ? `${isUz ? 'ortiqcha' : 'перерасход'} ${totals.over}` : null,
    ].filter(Boolean);
    return `${isUz ? 'Reja' : 'План'} ${formatMoneyShort(totals.plan, isUz ? 'uz' : 'ru')} • ${
      isUz ? 'fakt' : 'факт'
    } ${formatMoneyShort(totals.fact, isUz ? 'uz' : 'ru')}${
      flags.length > 0 ? ` • ${flags.join(' • ')}` : ''
    }`;
  };

  return (
    <>
      {/* Курс стоит выше остатков: по нему считается валютная операция, и
          вопрос «по какому курсу» задают до того, как её заводят. */}
      <RatesStrip />

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {summary.error && !summary.data ? (
          <div className={`lg:col-span-12 min-h-[230px] lg:h-[230px] ${CARD}`}>
            <ErrorBox text={errorText(summary.error, isUz)} onRetry={reloadSummary} isUz={isUz} />
          </div>
        ) : (
          <>
            <CashflowCard
              summary={summary.data}
              isLoading={summary.isLoading}
              isUz={isUz}
              theme={theme}
              period={period}
              setPeriod={setPeriod}
            />
            <BalanceCard summary={summary.data} isLoading={summary.isLoading} isUz={isUz} />
          </>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch">
        <div
          className={`${wide ? 'lg:col-span-12' : 'lg:col-span-8'} h-[540px] ${CARD} overflow-hidden flex flex-col justify-between`}
        >
          {/* Шапка переносит строки: полоска разделов и фильтры — два неделимых
              куска, и когда они перестают помещаться рядом, фильтры уходят вниз.
              Та же причина, что на продажах: иначе их срезает overflow-hidden. */}
          <div className="p-3 border-b border-zinc-100 dark:border-zinc-800/60 bg-zinc-50/50 dark:bg-zinc-900/30 flex flex-col sm:flex-row sm:flex-wrap sm:items-center justify-between gap-3 shrink-0">
            <div
              role="group"
              aria-label={isUz ? 'Moliya bo‘limlari' : 'Разделы финансов'}
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
                  {/* Место под счётчик занято всегда: данные вкладки грузятся по
                      первому заходу, и без запаса полоска прыгала бы под курсором. */}
                  <span
                    aria-hidden={t.count === null}
                    className="ml-1.5 font-mono text-[10px] opacity-80 inline-block min-w-[5ch] text-right tabular-nums"
                  >
                    {t.count === null ? '' : `(${t.count})`}
                  </span>
                </button>
              ))}
            </div>

            {section === 'operations' && (
              <div className="flex flex-col sm:flex-row sm:items-center gap-2 w-full sm:w-auto">
                <CustomSelect
                  value={status ?? 'all'}
                  onChange={(v) => setStatus(v === 'all' ? null : (v as FinanceStatus))}
                  options={statusOptions}
                  className="w-full sm:w-36"
                />
                <CustomSelect
                  value={type ?? 'all'}
                  onChange={(v) => setType(v === 'all' ? null : (v as FinanceOperationType))}
                  options={typeOptions}
                  className="w-full sm:w-32"
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
                    placeholder={isUz ? 'Raqam yoki kontragent...' : 'Номер или контрагент...'}
                    aria-label={isUz ? 'Operatsiyalarni qidirish' : 'Поиск операций'}
                    className="h-8 w-full sm:w-44 pl-7 pr-2.5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-xs text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 focus:outline-hidden focus:border-zinc-400 transition-colors shadow-2xs"
                  />
                </div>
              </div>
            )}

            {section === 'receivables' && (
              <button
                type="button"
                onClick={() => setOverdueOnly(!overdueOnly)}
                aria-pressed={overdueOnly}
                className={`h-8 px-3 rounded-lg border text-xs font-medium transition-colors cursor-pointer shadow-2xs whitespace-nowrap ${
                  overdueOnly
                    ? 'bg-zinc-950 text-white dark:bg-zinc-100 dark:text-zinc-950 border-zinc-950 dark:border-zinc-100'
                    : 'border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-zinc-600 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-zinc-100'
                }`}
              >
                {isUz ? 'Faqat kechikkanlar' : 'Только просроченные'}
              </button>
            )}
          </div>

          <div
            className={`flex-1 overflow-y-auto w-full transition-opacity ${
              active.isLoading && active.data ? 'opacity-60' : ''
            }`}
          >
            {renderList()}
          </div>

          <div className="px-4 py-2 border-t border-zinc-100 dark:border-zinc-800/60 bg-zinc-50/30 dark:bg-zinc-900/20 text-xs text-zinc-400 flex items-center justify-between gap-2 font-mono shrink-0">
            <span className="truncate">{footerLeft()}</span>
            <span className="shrink-0">
              {rowCount === null ? '—' : `${isUz ? 'Yozuvlar:' : 'Записей:'} ${rowCount}`}
            </span>
          </div>
        </div>

        {!wide && (
          <div
            className={`lg:col-span-4 h-[540px] ${CARD} p-4 sm:p-5 flex flex-col justify-between`}
          >
            {renderPanel()}
          </div>
        )}
      </div>
    </>
  );
};
