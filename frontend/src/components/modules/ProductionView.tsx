/**
 * Производство: заказы цеха, ход этапов, расход материалов, себестоимость.
 *
 * Всё на экране приходит из `/api/v1/production/*`. Главное отличие от того,
 * что было здесь на фикстурах: время этапа не берётся из одного поля, за ним
 * стоит журнал событий, и он показан рядом. Поэтому у идущего этапа написано
 * «идёт с 14:20», а не приписанные минуты, которых никто не измерял.
 *
 * Заказ здесь уже заводят и ведут: черновик, план, запуск, пауза с причиной,
 * выпуск, закрытие и отмена — всё через `/production/orders*`. Кнопки отметок
 * по этапам («начал», «закончил») по-прежнему нет: такое нажатие обязано писать
 * событие в журнал, по которому потом считают простои и фактическое время, и
 * тракта под это на сервере ещё нет. Кнопка, которая меняет только вид на
 * экране, врёт мастеру — хуже, чем её отсутствие.
 *
 * Причины простоя берутся из справочника `stock_reason` и приходят в ответе.
 * Вбитого в вёрстку списка причин здесь больше нет.
 */

import React from 'react';
import {
  AlertCircle,
  Clock,
  Loader2,
  MessageSquare,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { errorText, periodLabel } from '../../context/DashboardContext';
import { useProduction } from '../../context/ProductionContext';
import { useAuth } from '../../context/AuthContext';
import { AttachmentsButton, AttachmentsDialog } from './WarehouseAttachments';
import {
  DashboardPeriod,
  ProductionMaterialMoveInput,
  ProductionMaterialPlace,
  ProductionCostState,
  ProductionOptions,
  ProductionSchedule,
  ProductionOutputKind,
  ProductionOutputInput,
  ProductionReworkInput,
  ProductionMaterialRow,
  ProductionOrderDetail,
  ProductionStageMark,
  ProductionStageRow,
  ProductionStageStatus,
  ProductionState,
  ProductionStatus,
  ProductionSummary,
} from '../../types/api';
import { formatDate, formatNumber, formatPercent, formatQty, formatQtyFine, formatUnit, refName, toNumber } from '../../lib/formatters';
import { CustomSelect } from '../common/CustomSelect';
import { apiClient } from '../../lib/api-client';
import { ProductionOrderActions, ProductionOrderForm } from './ProductionOrderForm';
import { ProductionTechCards } from './ProductionTechCards';
import { ProductionControl } from './ProductionControl';
import { ProductionCalendar as ProductionCalendarPanel } from './ProductionCalendar';
import { ProductionReports } from './ProductionReports';
import { ProductionCenters } from './ProductionCenters';

const CARD =
  'rounded-xl border border-zinc-200 dark:border-zinc-800/80 bg-white dark:bg-[#18181b] shadow-2xs';

const PERIODS: DashboardPeriod[] = ['7d', '30d', '3m'];
const PERIOD_SHORT: Record<DashboardPeriod, { ru: string; uz: string }> = {
  '7d': { ru: '7 дн', uz: '7 kun' },
  '30d': { ru: '30 дн', uz: '30 kun' },
  '3m': { ru: '3 мес', uz: '3 oy' },
};

const ORDER_STATUS: Record<ProductionStatus, { ru: string; uz: string }> = {
  draft: { ru: 'Черновик', uz: 'Qoralama' },
  planned: { ru: 'Запланирован', uz: 'Rejalashtirilgan' },
  in_progress: { ru: 'В работе', uz: 'Ishda' },
  paused: { ru: 'Приостановлен', uz: 'To‘xtatilgan' },
  produced: { ru: 'Выпущен', uz: 'Ishlab chiqarilgan' },
  closed: { ru: 'Закрыт', uz: 'Yopilgan' },
  cancelled: { ru: 'Отменён', uz: 'Bekor qilingan' },
};

const STAGE_STATUS: Record<string, { ru: string; uz: string }> = {
  pending: { ru: 'Не начат', uz: 'Boshlanmagan' },
  running: { ru: 'Идёт', uz: 'Ketmoqda' },
  paused: { ru: 'Простой', uz: 'To‘xtash' },
  done: { ru: 'Завершён', uz: 'Yakunlangan' },
  skipped: { ru: 'Пропущен', uz: 'O‘tkazib yuborilgan' },
};

const EVENT_LABEL: Record<string, { ru: string; uz: string }> = {
  start: { ru: 'начали', uz: 'boshlandi' },
  pause: { ru: 'остановили', uz: 'to‘xtatildi' },
  resume: { ru: 'возобновили', uz: 'davom ettirildi' },
  finish: { ru: 'завершили', uz: 'yakunlandi' },
};

const label = (
  map: Record<string, { ru: string; uz: string }>,
  key: string,
  isUz: boolean,
): string => (map[key] ? (isUz ? map[key].uz : map[key].ru) : key);

/** Минуты в «4 ч 35 мин»: смену в минутах на глаз не прочитать. */
function formatDuration(minutes: number, isUz: boolean): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h === 0) return `${rest} ${isUz ? 'daq' : 'мин'}`;
  if (rest === 0) return `${h} ${isUz ? 'soat' : 'ч'}`;
  return `${h} ${isUz ? 'soat' : 'ч'} ${rest} ${isUz ? 'daq' : 'мин'}`;
}

/** Дата и время события: без времени журнал этапа за смену не упорядочить. */
function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const two = (n: number) => String(n).padStart(2, '0');
  return `${formatDate(iso)}, ${two(d.getHours())}:${two(d.getMinutes())}`;
}

const isOverdue = (dueDate: string | null, status: ProductionStatus): boolean => {
  if (!dueDate || status === 'produced' || status === 'closed' || status === 'cancelled') {
    return false;
  }
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
// Ряд 1: загрузка участков и состав работы
// ---------------------------------------------------------------------------

/**
 * Загрузка участков: план и факт в минутах по журналу этапов.
 *
 * Процента загрузки здесь нет намеренно. Мощность участка задана в штуках за
 * смену, отработанное время — в минутах; поделить одно на другое можно, но
 * полученное число ничего не будет означать.
 *
 * Про раскладку. Карточка не держит участки в прокручиваемом окне: при
 * четырёх участках в него помещались два, а про остальные человек не узнавал
 * вовсе — полоса прокрутки внутри карточки на обзорном экране не читается как
 * «здесь есть продолжение». Поэтому высота задаётся содержимым, а участки идут
 * сеткой: на широком экране в два столбца, на узком в один. Четыре участка —
 * два ряда, то есть прежняя высота карточки; вырастет справочник — вырастет и
 * карточка, но ничего не спрячется.
 *
 * План и факт — одна полоса, а не две. Две занимали вдвое больше ширины, а в
 * столбце её вдвое меньше; при наложении перерасход виден прямо: тёмная
 * (факт) уходит дальше светлой (план).
 */
const WorkCenterCard: React.FC<{
  summary: ProductionSummary | null;
  isLoading: boolean;
  isUz: boolean;
  period: DashboardPeriod;
  setPeriod: (p: DashboardPeriod) => void;
}> = ({ summary, isLoading, isUz, period, setPeriod }) => {
  const centers = summary?.workCenters ?? [];
  const scale = Math.max(1, ...centers.map((c) => Math.max(c.plannedMin, c.actualMin)));

  return (
    <div className={`lg:col-span-8 min-h-[230px] ${CARD} p-4 flex flex-col gap-3`}>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 shrink-0">
        <div className="min-w-0">
          <h3 className="text-xs font-semibold text-zinc-950 dark:text-zinc-50">
            {isUz ? 'Uchastkalar yuklamasi' : 'Загрузка участков'}
          </h3>
          <p className="text-[11px] text-zinc-500 mt-0.5 truncate">
            {summary?.calendar.availableMin
              ? isUz
                ? `Kalendar bo‘yicha ${summary.calendar.workingDays} ish kuni · ${formatDuration(summary.calendar.availableMin, isUz)}`
                : `По календарю ${summary.calendar.workingDays} рабочих дней · ${formatDuration(summary.calendar.availableMin, isUz)}`
              : isUz
                ? 'Smenalar kiritilmagan: yuklama foizi hisoblanmaydi'
                : 'Смены не заведены: загрузку в процентах считать не из чего'}
          </p>
        </div>

        <div className="inline-flex h-8 items-center rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-0.5 shadow-2xs shrink-0">
          {PERIODS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPeriod(p)}
              aria-pressed={period === p}
              className={`h-7 px-2.5 text-xs font-medium rounded-md transition-all cursor-pointer ${
                period === p
                  ? 'bg-zinc-950 text-white dark:bg-zinc-100 dark:text-zinc-950 shadow-2xs'
                  : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-200'
              }`}
            >
              {isUz ? PERIOD_SHORT[p].uz : PERIOD_SHORT[p].ru}
            </button>
          ))}
        </div>
      </div>

      {isLoading && !summary ? (
        <div className="flex-1 flex flex-col justify-center gap-2 animate-pulse" aria-hidden>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-5 w-full rounded bg-zinc-200 dark:bg-zinc-800" />
          ))}
        </div>
      ) : centers.length === 0 ? (
        <Empty text={isUz ? 'Davr ichida ish bo‘lmagan' : 'За период работ не было'} />
      ) : (
        <div className="flex-1 grid grid-cols-1 xl:grid-cols-2 gap-x-5 gap-y-2.5 content-start">
          {centers.map((c) => (
            <div key={c.code} className="flex flex-col gap-1 text-[11px] min-w-0">
              {/* На узком экране название встаёт своей строкой, а не режется
                  до пяти букв: «Экстру…» не отличить от «Экструзия», и строка
                  перестаёт отвечать на вопрос, какой это участок. */}
              <div className="flex flex-wrap items-baseline gap-x-2 min-w-0">
                <span className="shrink-0 font-mono text-zinc-500" title={c.code}>
                  {c.code}
                </span>
                <span className="order-last w-full sm:order-none sm:w-auto sm:flex-1 min-w-0 truncate text-zinc-900 dark:text-zinc-100">
                  {refName(c, isUz)}
                </span>
                <span className="ml-auto sm:ml-0 shrink-0 font-mono tabular-nums text-zinc-700 dark:text-zinc-300">
                  {formatDuration(c.actualMin, isUz)}
                </span>
                {/* Процент — от рабочих смен календаря, а не от суток подряд. */}
                {c.loadPercent !== null && (
                  <span className="shrink-0 font-mono tabular-nums text-[10px] text-zinc-400 w-10 text-right">
                    {formatPercent(c.loadPercent)}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 min-w-0">
                {/* Факт — заливка, план — засечка на той же шкале. Двумя
                    заливками одна поверх другой это не показать: когда факт
                    больше плана, верхняя перекрывает нижнюю и плана не видно
                    вовсе — а перерасход как раз тот случай, ради которого сюда
                    и смотрят. Засечка видна по обе стороны от неё. */}
                <div className="relative flex-1 min-w-0 h-2 rounded-full bg-zinc-100 dark:bg-zinc-800 overflow-hidden">
                  <div
                    className="absolute inset-y-0 left-0 bg-zinc-900 dark:bg-zinc-100"
                    style={{ width: `${(c.actualMin / scale) * 100}%` }}
                  />
                  {c.plannedMin > 0 && (
                    // Сдвиг на всю ширину засечки, а не на половину: у самого
                    // загруженного участка план приходится ровно на край
                    // дорожки, и половина засечки обрезалась бы — то есть
                    // пропадала бы именно там, где на неё и смотрят.
                    <span
                      className="absolute inset-y-0 w-0.5 -ml-0.5 bg-zinc-400 dark:bg-zinc-500"
                      style={{ left: `${(c.plannedMin / scale) * 100}%` }}
                      title={`${isUz ? 'Reja' : 'План'}: ${formatDuration(c.plannedMin, isUz)}`}
                    />
                  )}
                </div>
                {/* Простой стоит рядом с полосой: по нему видно, почему мало. */}
                <span className="shrink-0 text-[10px] text-zinc-400 whitespace-nowrap">
                  {c.downtimeMin > 0
                    ? `${isUz ? 'to‘xtash' : 'простой'} ${formatDuration(c.downtimeMin, isUz)}`
                    : ''}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="shrink-0 flex items-center gap-4 text-[10px] text-zinc-400 border-t border-zinc-100 dark:border-zinc-800/60 pt-2">
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-sm bg-zinc-900 dark:bg-zinc-100" />
          {isUz ? 'Fakt' : 'Факт'}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-0.5 h-2.5 rounded-xs bg-zinc-400 dark:bg-zinc-500" />
          {isUz ? 'Reja' : 'План'}
        </span>
      </div>
    </div>
  );
};

/** Состав работы и простои: два числа, которые мастер смотрит первыми. */
const StatusCard: React.FC<{
  summary: ProductionSummary | null;
  isLoading: boolean;
  isUz: boolean;
}> = ({ summary, isLoading, isUz }) => {
  if (isLoading && !summary) {
    return (
      <div className={`lg:col-span-4 min-h-[230px] ${CARD} p-4`}>
        <div className="h-full flex flex-col gap-2 animate-pulse" aria-hidden>
          <div className="h-4 w-32 rounded bg-zinc-200 dark:bg-zinc-800" />
          <div className="h-14 w-full rounded bg-zinc-200 dark:bg-zinc-800" />
          <div className="h-14 w-full rounded bg-zinc-200 dark:bg-zinc-800" />
        </div>
      </div>
    );
  }

  const o = summary?.orders;
  const d = summary?.downtime;

  const counters = [
    { key: 'planned', ru: 'Запланировано', uz: 'Rejalashtirilgan', value: o?.planned ?? 0 },
    { key: 'active', ru: 'В работе', uz: 'Ishda', value: (o?.inProgress ?? 0) + (o?.paused ?? 0) },
    { key: 'done', ru: 'Выпущено', uz: 'Chiqarilgan', value: (o?.produced ?? 0) + (o?.closed ?? 0) },
  ];

  // Высоту ряда задаёт соседняя карточка участков, а она растёт по их числу.
  // Поэтому здесь только нижняя граница: грид растянет карточку сам.
  return (
    <div className={`lg:col-span-4 min-h-[230px] ${CARD} p-4 flex flex-col gap-3`}>
      <div className="flex items-baseline justify-between gap-2 shrink-0">
        <h3 className="text-xs font-semibold text-zinc-950 dark:text-zinc-50">
          {isUz ? 'Sex buyurtmalari' : 'Заказы цеха'}
        </h3>
        {(o?.overdue ?? 0) > 0 && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-100 dark:bg-red-950/50 text-red-700 dark:text-red-300 font-mono">
            {isUz ? `muddati o‘tgan: ${o!.overdue}` : `просрочено: ${o!.overdue}`}
          </span>
        )}
      </div>

      <div className="grid grid-cols-3 gap-2 shrink-0">
        {counters.map((c) => (
          <div
            key={c.key}
            className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50/60 dark:bg-zinc-900/40 p-2 flex flex-col gap-0.5"
          >
            <span className="font-mono font-bold text-sm text-zinc-950 dark:text-zinc-50 tabular-nums">
              {c.value}
            </span>
            <span className="text-[10px] text-zinc-500 leading-tight">{isUz ? c.uz : c.ru}</span>
          </div>
        ))}
      </div>

      <div className="flex-1 min-h-0 flex flex-col gap-1.5 border-t border-zinc-100 dark:border-zinc-800/60 pt-2">
        <div className="flex items-center justify-between gap-2 text-[11px] shrink-0">
          <span className="text-zinc-500">{isUz ? 'To‘xtashlar' : 'Простои'}</span>
          <span className="font-mono text-zinc-900 dark:text-zinc-100">
            {d ? formatDuration(d.minutes, isUz) : '—'}
          </span>
        </div>

        {d && d.byReason.length > 0 ? (
          <div className="flex-1 overflow-y-auto flex flex-col gap-1 pr-1">
            {d.byReason.map((r, i) => (
              <div
                key={`${r.reasonRu ?? 'none'}-${i}`}
                className="flex items-center justify-between gap-2 text-[11px]"
              >
                <span className="text-zinc-700 dark:text-zinc-300 truncate">
                  {(isUz ? r.reasonUz : r.reasonRu) ??
                    (isUz ? 'Sabab ko‘rsatilmagan' : 'Причина не указана')}
                </span>
                <span className="font-mono tabular-nums text-zinc-500 shrink-0">
                  {formatDuration(r.minutes, isUz)}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[11px] text-zinc-400">
            {isUz ? 'Davr ichida to‘xtash bo‘lmagan' : 'Простоев за период не было'}
          </p>
        )}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Правая панель: этапы, материалы, себестоимость
// ---------------------------------------------------------------------------

/**
 * Что можно нажать на этапе в этом состоянии. Таблица одна и та же, что на
 * сервере, но решает всё равно сервер: экран только не предлагает лишнего.
 */
const STAGE_MARKS: Record<ProductionStageStatus, ProductionStageMark[]> = {
  pending: ['start'],
  running: ['pause', 'finish'],
  paused: ['resume'],
  done: [],
  skipped: [],
};

const MARK_LABEL: Record<ProductionStageMark, { ru: string; uz: string }> = {
  start: { ru: 'Начал', uz: 'Boshladim' },
  pause: { ru: 'Пауза', uz: 'To‘xtatish' },
  resume: { ru: 'Продолжил', uz: 'Davom ettirdim' },
  finish: { ru: 'Закончил', uz: 'Tugatdim' },
};

const MARK_BTN =
  'px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors disabled:opacity-40 ' +
  'disabled:cursor-not-allowed cursor-pointer';
const MARK_PRIMARY =
  MARK_BTN + ' bg-zinc-900 text-zinc-50 hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-900';
const MARK_GHOST =
  MARK_BTN +
  ' border border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300 ' +
  'hover:bg-zinc-100 dark:hover:bg-zinc-800';

/** Один этап с его журналом: строка времени и что за ней стоит. */
const StageBlock: React.FC<{
  stage: ProductionStageRow;
  isUz: boolean;
  /** Отметки показываются тому, кто имеет право их ставить. */
  canMark: boolean;
  orderRunning: boolean;
  reasons: { uid: string; nameRu: string; nameUz: string }[];
  onMark: (kind: ProductionStageMark, reasonUid?: string) => void;
  saving: boolean;
  /** Право приложить и убрать файл этапа: без него скрепка только показывает. */
  canEditFiles: boolean;
}> = ({ stage, isUz, canMark, orderRunning, reasons, onMark, saving, canEditFiles }) => {
  const reason = isUz ? stage.pauseReasonUz : stage.pauseReasonRu;
  const [asking, setAsking] = React.useState(false);
  const [reasonUid, setReasonUid] = React.useState('');
  // Фото операции, а не задания целиком: на следующем заказе по той же карте
  // смотрят, что было на этом же этапе (ТЗ 4.1).
  const [showFiles, setShowFiles] = React.useState(false);

  // Карточку могли переключить на другой заказ: незаконченный вопрос о причине
  // относился бы уже к чужому этапу.
  React.useEffect(() => {
    setAsking(false);
    setReasonUid('');
  }, [stage.seq, stage.status]);

  // Окно файлов привязано к этапу: при переключении заказа оно показывало бы
  // заголовок нового этапа над списком старого.
  React.useEffect(() => {
    setShowFiles(false);
  }, [stage.uid]);

  const marks = canMark && orderRunning ? STAGE_MARKS[stage.status] : [];

  return (
    <div className="py-2.5 flex flex-col gap-1.5">
      {/* На узкой панели статус и время уходят под название: иначе колонка
          названия сжимается настолько, что слова рвутся по буквам. */}
      <div className="flex flex-col gap-1 min-[420px]:flex-row min-[420px]:items-start min-[420px]:justify-between min-[420px]:gap-2">
        <div className="flex items-start gap-2 min-w-0">
          <span className="w-5 h-5 shrink-0 rounded-full border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 flex items-center justify-center font-mono text-[10px] font-semibold text-zinc-700 dark:text-zinc-300">
            {stage.seq}
          </span>
          <div className="min-w-0">
            <div className="text-[11px] font-medium text-zinc-900 dark:text-zinc-100">
              {refName(stage, isUz)}
            </div>
            <div className="text-[10px] text-zinc-500 mt-0.5 truncate">
              {(isUz ? stage.workCenterNameUz : stage.workCenterNameRu) ??
                (isUz ? 'Uchastka ko‘rsatilmagan' : 'Участок не указан')}
            </div>
            {/* План по сменам (Э7): когда этап должен идти, если начать по
                календарю завода. Ничего не запрещает — показывает срок. */}
            {stage.plannedStart && (
              <div className="text-[10px] text-zinc-400 mt-0.5 truncate">
                {isUz ? 'reja' : 'план'}: {formatDateTime(stage.plannedStart)}
                {stage.plannedEnd ? ` — ${formatDateTime(stage.plannedEnd)}` : ''}
              </div>
            )}
          </div>
        </div>

        <div className="pl-7 min-[420px]:pl-0 min-[420px]:text-right shrink-0 flex items-baseline gap-2 min-[420px]:flex-col min-[420px]:gap-0">
          <span className="text-[10px] text-zinc-400">{label(STAGE_STATUS, stage.status, isUz)}</span>
          <span className="font-mono text-[11px] text-zinc-900 dark:text-zinc-100 tabular-nums whitespace-nowrap">
            {formatDuration(stage.actualDurationMin, isUz)}
            <span className="text-zinc-400">
              {' / '}
              {formatDuration(stage.plannedDurationMin, isUz)}
            </span>
          </span>
        </div>
      </div>

      {/* Скрепка этапа — отдельной строкой под временем, а не в строке статуса:
          на 360 туда уже не влезает третий элемент, и кнопка выдавила бы время
          за край. Выравнивание — тем же отступом, что и у остальных строк. */}
      <div className="pl-7 flex items-center gap-2">
        <AttachmentsButton isUz={isUz} onOpen={() => setShowFiles(true)} />
        <span className="text-[10px] text-zinc-400 min-w-0 truncate">
          {isUz ? 'Bosqich fayllari' : 'Файлы этапа'}
        </span>
      </div>

      {showFiles && (
        <AttachmentsDialog
          owner="production_stage"
          uid={stage.uid}
          title={`${stage.seq}. ${refName(stage, isUz)}`}
          canEdit={canEditFiles}
          isUz={isUz}
          onClose={() => setShowFiles(false)}
        />
      )}

      {/* Примечание этапа: оно было в ответе службы с самого начала, но на
          экране не показывалось — «почему переделали» читали в журнале
          действий, а спрашивают его, глядя на этап (ТЗ 4.1). */}
      {stage.comment && (
        <div className="pl-7 flex items-start gap-1.5 text-[10px] text-zinc-600 dark:text-zinc-400">
          <MessageSquare size={10} className="mt-0.5 shrink-0" />
          <span className="break-words">{stage.comment}</span>
        </div>
      )}

      {/* Незакрытый отрезок показан временем начала, а не минутами: минут
          никто не измерял, этап ещё идёт. */}
      {stage.runningSince && (
        <div className="flex items-center gap-1.5 text-[10px] text-zinc-600 dark:text-zinc-400">
          <Play size={10} />
          <span>
            {isUz ? 'ketmoqda' : 'идёт с'} {formatDateTime(stage.runningSince)}
          </span>
        </div>
      )}

      {stage.pausedSince && (
        <div className="flex items-start gap-1.5 text-[10px] text-zinc-600 dark:text-zinc-400">
          <Pause size={10} className="mt-0.5 shrink-0" />
          <span className="break-words">
            {isUz ? 'to‘xtagan' : 'простой с'} {formatDateTime(stage.pausedSince)}
            {reason ? ` — ${reason}` : ''}
          </span>
        </div>
      )}

      {stage.downtimeMin > 0 && !stage.pausedSince && (
        <div className="flex items-center gap-1.5 text-[10px] text-zinc-500">
          <Clock size={10} />
          <span>
            {isUz ? 'to‘xtash' : 'простой'}: {formatDuration(stage.downtimeMin, isUz)}
          </span>
        </div>
      )}

      {stage.events.length > 0 && (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-zinc-400 font-mono">
          {stage.events.map((e, i) => (
            <span key={i}>
              {label(EVENT_LABEL, e.event, isUz)} {formatDateTime(e.occurredAt)}
            </span>
          ))}
        </div>
      )}

      {/* Слова, сказанные при отметке. Служба их пишет (`comment` у события),
          а экран до этого показывал только вид отметки и время: «встали, ждём
          краном заготовку» терялось между журналом и аудитом. Строка на
          отметку, а не свалкой в одну: иначе два простоя читаются как один. */}
      {stage.events.some((e) => e.comment) && (
        <div className="flex flex-col gap-0.5">
          {stage.events
            .map((e, i) => ({ e, i }))
            .filter(({ e }) => e.comment)
            .map(({ e, i }) => (
              <div
                key={i}
                className="flex items-start gap-1.5 text-[10px] text-zinc-600 dark:text-zinc-400"
              >
                <MessageSquare size={10} className="mt-0.5 shrink-0" />
                <span className="break-words min-w-0">
                  <span className="text-zinc-400">
                    {label(EVENT_LABEL, e.event, isUz)}
                    {(isUz ? e.reasonUz : e.reasonRu) ? ` · ${isUz ? e.reasonUz : e.reasonRu}` : ''}
                    {' — '}
                  </span>
                  {e.comment}
                </span>
              </div>
            ))}
        </div>
      )}

      {/* Причину простоя спрашивают до остановки, а не после: из неё растёт
          журнал простоев, и «вспомню потом» означает пустую строку в нём. */}
      {asking && (
        <div className="flex flex-col gap-1.5 pt-1">
          <span className="text-[10px] text-zinc-600 dark:text-zinc-400">
            {isUz
              ? 'Nega to‘xtatyapmiz? Sabab to‘xtashlar jurnaliga tushadi.'
              : 'Почему останавливаем? Причина попадёт в журнал простоев.'}
          </span>
          {reasons.length === 0 ? (
            <span className="text-[10px] text-amber-700 dark:text-amber-400">
              {isUz
                ? 'To‘xtash sabablari ma’lumotnomada yo‘q: avval ularni kiriting.'
                : 'Причины простоя не заведены в справочнике — сначала добавьте их.'}
            </span>
          ) : (
            <CustomSelect
              value={reasonUid}
              onChange={setReasonUid}
              portal
              options={[
                { value: '', label: isUz ? 'Sababni tanlang' : 'Выберите причину' },
                ...reasons.map((r) => ({ value: r.uid, label: refName(r, isUz) })),
              ]}
              ariaLabel={isUz ? 'To‘xtash sababi' : 'Причина остановки'}
            />
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={saving || reasonUid === ''}
              onClick={() => {
                onMark('pause', reasonUid);
                setAsking(false);
              }}
              className={MARK_PRIMARY}
            >
              {isUz ? 'To‘xtatish' : 'Остановить'}
            </button>
            <button type="button" onClick={() => setAsking(false)} className={MARK_GHOST}>
              {isUz ? 'Qaytish' : 'Назад'}
            </button>
          </div>
        </div>
      )}

      {!asking && marks.length > 0 && (
        <div className="flex flex-col gap-1 pt-1">
          <div className="flex flex-wrap items-center gap-2">
            {marks.map((m) => (
              <button
                key={m}
                type="button"
                disabled={saving}
                onClick={() => (m === 'pause' ? setAsking(true) : onMark(m))}
                className={m === 'finish' || m === 'start' ? MARK_PRIMARY : MARK_GHOST}
              >
                <span className="inline-flex items-center gap-1.5">
                  {saving && <Loader2 size={11} className="animate-spin" />}
                  {isUz ? MARK_LABEL[m].uz : MARK_LABEL[m].ru}
                </span>
              </button>
            ))}
          </div>
          <span className="text-[10px] text-zinc-400">
            {isUz
              ? 'Vaqtni tizim o‘zi hisoblaydi: siz bosasiz — u daqiqalarni yozadi.'
              : 'Время считает система: вы нажимаете — она записывает минуты.'}
          </span>
        </div>
      )}
    </div>
  );
};

/**
 * Материал заказа: план, что выдано и израсходовано, и действия над ним.
 *
 * Действия разведены по правам осознанно: выдачу и возврат делает кладовщик —
 * это движение склада; «списать в работу» отмечает производство — склада это
 * уже не касается, материал в цеху. Поэтому и кнопки у разных людей разные.
 */
const MaterialBlock: React.FC<{
  orderUid: string;
  orderStatus: ProductionStatus;
  material: ProductionMaterialRow;
  isUz: boolean;
  mayManage: boolean;
  mayMove: boolean;
  warehouses: { code: string; nameRu: string; nameUz: string }[];
  saving: boolean;
  onMove: (kind: 'issue' | 'return', input: ProductionMaterialMoveInput) => void;
  onUse: (input: { itemCode: string; qty: string }) => void;
}> = ({
  orderUid,
  orderStatus,
  material: m,
  isUz,
  mayManage,
  mayMove,
  warehouses,
  saving,
  onMove,
  onUse,
}) => {
  const deviation = toNumber(m.deviationQty);
  const unit = formatUnit(m.unit, isUz ? 'uz' : 'ru');
  const onHand = toNumber(m.qtyIssued) - toNumber(m.qtyReturned) - toNumber(m.qtyUsed);

  const [doing, setDoing] = React.useState<'issue' | 'return' | 'use' | null>(null);
  const [qty, setQty] = React.useState('');
  const [place, setPlace] = React.useState('');
  const [places, setPlaces] = React.useState<ProductionMaterialPlace[] | null>(null);
  const [wrong, setWrong] = React.useState<string | null>(null);

  React.useEffect(() => {
    setDoing(null);
    setQty('');
    setWrong(null);
  }, [orderUid, m.itemCode]);

  /** Откуда брать: спрашиваем у системы, а не у человека. */
  const askPlaces = async () => {
    setPlaces(null);
    try {
      const { data } = await apiClient.production.getMaterialStock(orderUid, m.itemCode);
      setPlaces(data.rows);
      setPlace(data.rows[0] ? placeKey(data.rows[0]) : '');
    } catch {
      setPlaces([]);
    }
  };

  const start = (kind: 'issue' | 'return' | 'use') => {
    setDoing(kind);
    setWrong(null);
    setQty(kind === 'use' && onHand > 0 ? formatQty(String(onHand)) : '');
    if (kind === 'issue') void askPlaces();
    if (kind === 'return') setPlaces(null);
  };

  const confirm = () => {
    const value = Number(qty.replace(',', '.'));
    if (!Number.isFinite(value) || value <= 0) {
      setWrong(isUz ? 'Miqdorni raqam bilan yozing' : 'Напишите количество числом');
      return;
    }
    if (doing === 'use' || doing === 'return') {
      if (value > onHand + 1e-9) {
        setWrong(
          isUz
            ? `Sexda hozir ${formatQtyFine(String(onHand))} ${unit}`
            : `В цеху сейчас ${formatQtyFine(String(onHand))} ${unit}`,
        );
        return;
      }
    }
    if (doing === 'issue') {
      const chosen = (places ?? []).find((p) => placeKey(p) === place);
      if (!chosen) {
        setWrong(isUz ? 'Qayerdan olishni tanlang' : 'Выберите, откуда взять');
        return;
      }
      onMove('issue', {
        itemCode: m.itemCode,
        qty: String(value),
        warehouseCode: chosen.warehouseCode,
        ...(chosen.locationCode ? { locationCode: chosen.locationCode } : {}),
        ...(chosen.batchNumber ? { batchNumber: chosen.batchNumber } : {}),
      });
    } else if (doing === 'return') {
      const where = warehouses.find((w) => w.code === place) ?? warehouses[0];
      if (!where) {
        setWrong(isUz ? 'Ombor topilmadi' : 'Склад не найден');
        return;
      }
      onMove('return', { itemCode: m.itemCode, qty: String(value), warehouseCode: where.code });
    } else {
      onUse({ itemCode: m.itemCode, qty: String(value) });
    }
    setDoing(null);
  };

  /** Со складом работают, пока заказ идёт: выпущенный уже посчитан. */
  const open = ['planned', 'in_progress', 'paused'].includes(orderStatus);
  const canIssue = mayMove && open;
  const canReturn = mayMove && open && onHand > 0;
  const canUse = mayManage && ['in_progress', 'paused'].includes(orderStatus) && onHand > 0;

  return (
    <div className="flex flex-col gap-1 text-[11px] py-1">
      <div className="flex items-start justify-between gap-2">
        <span className="text-zinc-900 dark:text-zinc-100 break-words min-w-0">
          {isUz ? m.itemNameUz : m.itemNameRu}
        </span>
        {/* Себестоимость материала считается в Э6. Пока её нет, «0 UZS» в
            строке читается как «бесплатно» — поэтому места не занимает. */}
        {toNumber(m.costTotal) > 0 && (
          <span className="font-mono tabular-nums text-zinc-500 shrink-0">
            {formatNumber(m.costTotal, 0)} UZS
          </span>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 text-[10px] text-zinc-500 font-mono">
        <span>
          {isUz ? 'reja' : 'план'} {formatQtyFine(m.qtyPlanned)} • {isUz ? 'berildi' : 'выдано'}{' '}
          {formatQtyFine(m.qtyIssued)} • {isUz ? 'sarflandi' : 'расход'} {formatQtyFine(m.qtyUsed)}{' '}
          {unit}
        </span>
        {/* Отклонение есть только там, где расход уже записали: у нетронутого
            материала «−4,2» читается как экономия, которой не было. Знак
            осмысленный: перерасход и экономия — не одно и то же. */}
        {toNumber(m.qtyUsed) > 0 && (
          <span
            className={
              deviation > 0
                ? 'text-red-600 dark:text-red-400 shrink-0'
                : 'text-zinc-500 shrink-0'
            }
          >
            {deviation > 0 ? '+' : ''}
            {formatQtyFine(m.deviationQty)}
          </span>
        )}
      </div>

      {onHand > 0 && (
        <div className="text-[10px] text-zinc-500">
          {isUz ? 'Sexda qoldi' : 'На руках у цеха'}: {formatQtyFine(String(onHand))} {unit}
          {toNumber(m.qtyReturned) > 0
            ? ` • ${isUz ? 'qaytarildi' : 'возвращено'} ${formatQtyFine(m.qtyReturned)}`
            : ''}
        </div>
      )}

      {doing !== null && (
        <div className="flex flex-col gap-1.5 pt-1">
          <span className="text-[10px] text-zinc-600 dark:text-zinc-400">
            {doing === 'issue'
              ? isUz
                ? 'Qaysi ombordan va qancha berasiz? Ombor qoldig‘i shuncha kamayadi.'
                : 'Откуда и сколько выдаём? Ровно на столько уменьшится остаток склада.'
              : doing === 'return'
                ? isUz
                  ? 'Ishlatilmagan materialni omborga qaytaramiz.'
                  : 'Возвращаем на склад то, что не пошло в работу.'
                : isUz
                  ? 'Qancha material ishga ketdi? Rejadan ortig‘i chetlanishlar jurnaliga tushadi.'
                  : 'Сколько материала ушло в работу? Сверх плана попадёт в журнал отклонений.'}
          </span>

          {doing === 'issue' &&
            (places === null ? (
              <span className="text-[10px] text-zinc-400">
                {isUz ? 'Qoldiqlar so‘ralmoqda…' : 'Смотрю остатки…'}
              </span>
            ) : places.length === 0 ? (
              <span className="text-[10px] text-amber-700 dark:text-amber-400">
                {isUz
                  ? 'Bu material omborlarda yo‘q: avval kirim qiling.'
                  : 'Этого материала на складах нет — сначала приход.'}
              </span>
            ) : (
              <CustomSelect
                value={place}
                onChange={setPlace}
                portal
                options={places.map((p) => ({
                  value: placeKey(p),
                  label:
                    `${isUz ? p.warehouseNameUz : p.warehouseNameRu}` +
                    `${p.locationCode ? ` · ${p.locationCode}` : ''}` +
                    `${p.batchNumber ? ` · ${isUz ? 'partiya' : 'партия'} ${p.batchNumber}` : ''}` +
                    ` · ${formatQtyFine(p.qtyFree)} ${unit}`,
                }))}
                ariaLabel={isUz ? 'Qayerdan olish' : 'Откуда взять'}
              />
            ))}

          {doing === 'return' && warehouses.length > 1 && (
            <CustomSelect
              value={place}
              onChange={setPlace}
              portal
              options={warehouses.map((w) => ({
                value: w.code,
                label: refName(w, isUz),
              }))}
              ariaLabel={isUz ? 'Qaysi omborga' : 'На какой склад'}
            />
          )}

          <input
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            inputMode="decimal"
            autoFocus
            placeholder={isUz ? `Miqdor, ${unit}` : `Количество, ${unit}`}
            aria-label={isUz ? 'Miqdor' : 'Количество'}
            className="w-full h-8 px-2.5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-xs text-zinc-950 dark:text-zinc-50"
          />
          {wrong && <span className="text-[10px] text-red-600 dark:text-red-400">{wrong}</span>}

          <div className="flex items-center gap-2">
            <button type="button" onClick={confirm} disabled={saving} className={MARK_PRIMARY}>
              <span className="inline-flex items-center gap-1.5">
                {saving && <Loader2 size={11} className="animate-spin" />}
                {doing === 'issue'
                  ? isUz
                    ? 'Berish'
                    : 'Выдать'
                  : doing === 'return'
                    ? isUz
                      ? 'Qaytarish'
                      : 'Вернуть'
                    : isUz
                      ? 'Hisobga olish'
                      : 'Записать расход'}
              </span>
            </button>
            <button type="button" onClick={() => setDoing(null)} className={MARK_GHOST}>
              {isUz ? 'Qaytish' : 'Назад'}
            </button>
          </div>
        </div>
      )}

      {doing === null && (canIssue || canReturn || canUse) && (
        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          {canIssue && (
            <button type="button" onClick={() => start('issue')} className={MARK_PRIMARY}>
              {isUz ? 'Berish' : 'Выдать в цех'}
            </button>
          )}
          {canUse && (
            <button type="button" onClick={() => start('use')} className={MARK_GHOST}>
              {isUz ? 'Ishga yozish' : 'Списать в работу'}
            </button>
          )}
          {canReturn && (
            <button type="button" onClick={() => start('return')} className={MARK_GHOST}>
              {isUz ? 'Omborga qaytarish' : 'Вернуть на склад'}
            </button>
          )}
        </div>
      )}
    </div>
  );
};

/** Полка и партия вместе: на одном складе их может быть несколько. */
const placeKey = (p: ProductionMaterialPlace) =>
  `${p.warehouseCode}|${p.locationCode ?? ''}|${p.batchNumber ?? ''}`;

/** Как называется вид выпуска на экране. */
const OUTPUT_LABEL: Record<ProductionOutputKind, { ru: string; uz: string }> = {
  good: { ru: 'Годное', uz: 'Yaroqli' },
  defect: { ru: 'Брак', uz: 'Brak' },
  waste: { ru: 'Отход', uz: 'Chiqindi' },
  semi: { ru: 'Полуфабрикат', uz: 'Yarim tayyor' },
};

/** Склад и ячейка одной строкой: приход без ячейки склад не примет. */
const spotKey = (warehouseCode: string, locationCode: string) =>
  `${warehouseCode}|${locationCode}`;

/**
 * Вкладка «Выпуск»: что цех сдал и что из этого не получилось.
 *
 * Один вопрос на экран: сначала выбирают, что записывают, потом спрашивается
 * только нужное. У годного — склад и количество, у брака и отхода — причина:
 * списка складов там нет вовсе, потому что на склад они не попадают.
 */
const OutputBlock: React.FC<{
  order: ProductionOrderDetail;
  isUz: boolean;
  mayManage: boolean;
  warehouses: ProductionOptions['warehouses'];
  defectReasons: ProductionOptions['defectReasons'];
  wasteReasons: ProductionOptions['wasteReasons'];
  items: ProductionOptions['materials'];
  saving: boolean;
  onRegister: (input: ProductionOutputInput) => void;
  onRework: (input: ProductionReworkInput) => void;
}> = ({
  order,
  isUz,
  mayManage,
  warehouses,
  defectReasons,
  wasteReasons,
  items,
  saving,
  onRegister,
  onRework,
}) => {
  const [doing, setDoing] = React.useState<ProductionOutputKind | 'rework' | null>(null);
  const [qty, setQty] = React.useState('');
  const [spot, setSpot] = React.useState('');
  const [reason, setReason] = React.useState('');
  const [semiItem, setSemiItem] = React.useState('');
  const [due, setDue] = React.useState('');
  /**
   * Что именно было. Служба это поле принимала и раньше, но спросить его было
   * негде: причина из справочника отвечает «из-за чего», а «раковина по кромке,
   * вторая за смену» в справочник не ложится (ТЗ 4.6).
   */
  const [note, setNote] = React.useState('');
  const [wrong, setWrong] = React.useState<string | null>(null);

  const unit = formatUnit(order.unit, isUz ? 'uz' : 'ru');
  /** Сдавать можно, пока работа идёт: выпущенный заказ уже посчитан. */
  const open = ['in_progress', 'paused'].includes(order.status);

  /** Места приёмки: склад с ячейкой и склад без неё — одной строкой. */
  const spots = React.useMemo(
    () =>
      warehouses.flatMap((w) =>
        (w.locations.length ? w.locations : ['']).map((l) => ({
          key: spotKey(w.code, l),
          warehouseCode: w.code,
          locationCode: l,
          label: `${refName(w, isUz)}${l ? ` · ${l}` : ''}`,
        })),
      ),
    [warehouses, isUz],
  );

  const reasons = doing === 'defect' ? defectReasons : wasteReasons;
  const left =
    toNumber(order.qtyDefect) -
    order.reworks.reduce((sum, r) => sum + toNumber(r.qtyPlanned), 0);

  const start = (what: ProductionOutputKind | 'rework') => {
    setDoing(what);
    setWrong(null);
    setQty('');
    setReason('');
    setSemiItem('');
    setNote('');
    setDue(new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10));
    setSpot(spots[0]?.key ?? '');
  };

  /** Пробелы в комментарий не отправляем: пустая строка — это не комментарий. */
  const noteOf = () => (note.trim() === '' ? {} : { comment: note.trim() });

  const confirm = () => {
    const value = Number(qty.replace(',', '.'));
    if (!Number.isFinite(value) || value <= 0) {
      setWrong(isUz ? 'Miqdor noldan katta bo‘lsin' : 'Количество — число больше нуля');
      return;
    }
    if (doing === 'rework') {
      if (value > left + 1e-9) {
        setWrong(
          isUz
            ? `Qayta ishlashga ${formatQtyFine(String(left))} ${unit} qoldi`
            : `В переделку осталось ${formatQtyFine(String(left))} ${unit}`,
        );
        return;
      }
      onRework({ qty: String(value), dueDate: due, ...noteOf() });
      setDoing(null);
      return;
    }
    if (doing === null) return;

    const place = spots.find((p) => p.key === spot);
    if ((doing === 'good' || doing === 'semi') && !place) {
      setWrong(isUz ? 'Qabul qiladigan ombor yo‘q' : 'Склад приёмки не выбран');
      return;
    }
    if ((doing === 'defect' || doing === 'waste') && !reason) {
      setWrong(
        doing === 'defect'
          ? isUz
            ? 'Brak sababini ayting'
            : 'Назовите причину брака'
          : isUz
            ? 'Chiqindi sababini ayting'
            : 'Назовите причину отхода',
      );
      return;
    }
    if (doing === 'semi' && !semiItem) {
      setWrong(isUz ? 'Qaysi yarim tayyor mahsulot?' : 'Какой полуфабрикат?');
      return;
    }

    onRegister({
      kind: doing,
      qty: String(value),
      ...(doing === 'semi' ? { itemCode: semiItem } : {}),
      ...(place && (doing === 'good' || doing === 'semi')
        ? {
            warehouseCode: place.warehouseCode,
            ...(place.locationCode ? { locationCode: place.locationCode } : {}),
          }
        : {}),
      ...(reason && (doing === 'defect' || doing === 'waste') ? { reasonUid: reason } : {}),
      ...noteOf(),
    });
    setDoing(null);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-3 gap-2 text-[11px]">
        {[
          { ru: 'Годное', uz: 'Yaroqli', v: order.qtyProduced },
          { ru: 'Брак', uz: 'Brak', v: order.qtyDefect },
          { ru: 'Отход', uz: 'Chiqindi', v: order.qtyWaste },
        ].map((r) => (
          <div
            key={r.ru}
            className="rounded-lg border border-zinc-200 dark:border-zinc-800 px-2 py-1.5"
          >
            <div className="text-[10px] text-zinc-500">{isUz ? r.uz : r.ru}</div>
            <div className="font-mono tabular-nums text-zinc-950 dark:text-zinc-50">
              {formatQtyFine(r.v)} {unit}
            </div>
          </div>
        ))}
      </div>

      <p className="text-[10px] text-zinc-500">
        {isUz
          ? 'Yaroqli mahsulot shu yerda omborga qabul qilinadi — partiya buyurtma raqami bilan. Brak va chiqindi omborga tushmaydi.'
          : 'Годное отсюда же принимается на склад — партией с номером заказа. Брак и отход на склад не попадают.'}
      </p>

      {doing !== null && (
        <div className="flex flex-col gap-1.5 rounded-lg border border-zinc-200 dark:border-zinc-800 p-2">
          <span className="text-[10px] text-zinc-600 dark:text-zinc-400">
            {doing === 'good'
              ? isUz
                ? 'Qancha yaroqli mahsulot topshirildi? Shuncha ombor qoldig‘iga qo‘shiladi.'
                : 'Сколько годного сдали? Ровно на столько вырастет остаток склада.'
              : doing === 'defect'
                ? isUz
                  ? 'Qancha brak chiqdi va nega? Brak chetlanishlar jurnaliga tushadi.'
                  : 'Сколько брака и почему? Брак попадёт в журнал отклонений.'
                : doing === 'waste'
                  ? isUz
                    ? 'Qancha chiqindi? Bu brak emas — texnologiya normasi.'
                    : 'Сколько отхода? Это не брак — это норма техпроцесса.'
                  : doing === 'semi'
                    ? isUz
                      ? 'Qaysi yarim tayyor mahsulot va qancha? U omborga o‘z nomi bilan tushadi.'
                      : 'Какой полуфабрикат и сколько? Он ляжет на склад своей номенклатурой.'
                    : isUz
                      ? 'Brakni qayta ishlash alohida buyurtma bo‘ladi — shu tovarga, qoralama holida.'
                      : 'Переделка станет отдельным заказом на тот же товар — черновиком.'}
          </span>

          {(doing === 'good' || doing === 'semi') && spots.length > 1 && (
            <CustomSelect
              value={spot}
              onChange={setSpot}
              portal
              options={spots.map((p) => ({ value: p.key, label: p.label }))}
              ariaLabel={isUz ? 'Qaysi omborga' : 'На какой склад'}
            />
          )}

          {doing === 'semi' && (
            <CustomSelect
              value={semiItem}
              onChange={setSemiItem}
              portal
              options={items.map((i) => ({
                value: i.code,
                label: `${i.code} · ${refName(i, isUz)}`,
              }))}
              ariaLabel={isUz ? 'Yarim tayyor mahsulot' : 'Полуфабрикат'}
            />
          )}

          {(doing === 'defect' || doing === 'waste') && (
            <CustomSelect
              value={reason}
              onChange={setReason}
              portal
              options={reasons.map((r) => ({
                value: r.uid,
                label: refName(r, isUz),
              }))}
              ariaLabel={isUz ? 'Sabab' : 'Причина'}
            />
          )}

          {doing === 'rework' && (
            <input
              type="date"
              value={due}
              onChange={(e) => setDue(e.target.value)}
              aria-label={isUz ? 'Muddat' : 'Срок'}
              className="w-full h-8 px-2.5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-xs text-zinc-950 dark:text-zinc-50"
            />
          )}

          <input
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            inputMode="decimal"
            autoFocus
            placeholder={isUz ? `Miqdor, ${unit}` : `Количество, ${unit}`}
            aria-label={isUz ? 'Miqdor' : 'Количество'}
            className="w-full h-8 px-2.5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-xs text-zinc-950 dark:text-zinc-50"
          />

          {/* Комментарий ко всем видам записи, не только к браку: отход
              объясняют так же («обрезь при настройке стана»), а у переделки он
              становится примечанием дочернего заказа. Поле необязательное:
              требовать слова к каждой штуке годного значило бы собирать
              отписки. */}
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            placeholder={
              isUz
                ? 'Izoh: nima bo‘lgani (shart emas)'
                : 'Комментарий: что было (не обязательно)'
            }
            aria-label={isUz ? 'Izoh' : 'Комментарий'}
            className="w-full h-8 px-2.5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-xs text-zinc-950 dark:text-zinc-50"
          />
          {wrong && <span className="text-[10px] text-red-600 dark:text-red-400">{wrong}</span>}

          <div className="flex items-center gap-2">
            <button type="button" onClick={confirm} disabled={saving} className={MARK_PRIMARY}>
              <span className="inline-flex items-center gap-1.5">
                {saving && <Loader2 size={11} className="animate-spin" />}
                {isUz ? 'Yozib qo‘yish' : 'Записать'}
              </span>
            </button>
            <button type="button" onClick={() => setDoing(null)} className={MARK_GHOST}>
              {isUz ? 'Qaytish' : 'Назад'}
            </button>
          </div>
        </div>
      )}

      {doing === null && mayManage && (
        <div className="flex flex-wrap items-center gap-2">
          {open && (
            <>
              <button type="button" onClick={() => start('good')} className={MARK_PRIMARY}>
                {isUz ? 'Yaroqli' : 'Записать годное'}
              </button>
              <button type="button" onClick={() => start('defect')} className={MARK_GHOST}>
                {isUz ? 'Brak' : 'Записать брак'}
              </button>
              <button type="button" onClick={() => start('waste')} className={MARK_GHOST}>
                {isUz ? 'Chiqindi' : 'Записать отход'}
              </button>
              <button type="button" onClick={() => start('semi')} className={MARK_GHOST}>
                {isUz ? 'Yarim tayyor' : 'Полуфабрикат'}
              </button>
            </>
          )}
          {left > 1e-9 && (
            <button type="button" onClick={() => start('rework')} className={MARK_GHOST}>
              {isUz ? 'Qayta ishlash' : 'Отправить в переделку'}
            </button>
          )}
        </div>
      )}

      {order.reworks.length > 0 && (
        <div className="flex flex-col gap-1 text-[11px]">
          <span className="text-[10px] text-zinc-500">
            {isUz ? 'Qayta ishlash buyurtmalari' : 'Переделки по этому заказу'}
          </span>
          {order.reworks.map((r) => (
            <div key={r.uid} className="flex items-center justify-between gap-2">
              <span className="font-mono text-zinc-900 dark:text-zinc-100">{r.number}</span>
              <span className="text-zinc-500">{label(ORDER_STATUS, r.status, isUz)}</span>
              <span className="font-mono tabular-nums text-zinc-500">
                {formatQtyFine(r.qtyPlanned)} {unit}
              </span>
            </div>
          ))}
        </div>
      )}

      {order.outputs.length === 0 ? (
        <Empty text={isUz ? 'Hali hech narsa topshirilmagan' : 'Пока ничего не сдано'} />
      ) : (
        <div className="flex flex-col gap-1.5">
          {order.outputs.map((v, i) => (
            <div
              key={`${v.occurredAt}-${i}`}
              className="flex flex-col gap-0.5 border-t border-zinc-100 dark:border-zinc-800/60 pt-1.5 text-[11px]"
            >
              <div className="flex items-center justify-between gap-2">
                <span
                  className={
                    v.kind === 'defect'
                      ? 'text-red-600 dark:text-red-400'
                      : 'text-zinc-900 dark:text-zinc-100'
                  }
                >
                  {label(OUTPUT_LABEL, v.kind, isUz)}
                </span>
                <span className="font-mono tabular-nums text-zinc-900 dark:text-zinc-100">
                  {formatQtyFine(v.qty)} {formatUnit(v.unit, isUz ? 'uz' : 'ru')}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2 text-[10px] text-zinc-500">
                <span className="truncate">
                  {v.kind === 'semi' ? (isUz ? v.itemNameUz : v.itemNameRu) : ''}
                  {v.batchNumber ? `${isUz ? 'partiya' : 'партия'} ${v.batchNumber}` : ''}
                  {v.reasonNameRu ? (isUz ? v.reasonNameUz : v.reasonNameRu) : ''}
                </span>
                <span className="shrink-0 font-mono">{formatDateTime(v.occurredAt)}</span>
              </div>
              {/* Что цех сказал об этой записи. Причина отвечает «из-за чего»
                  и выбирается из справочника, а это — «что именно было»:
                  «раковина по кромке, вторая за смену» в справочник не ляжет
                  (ТЗ 4.6). Не truncate: обрезанное на полуслове объяснение
                  брака бесполезно, а строк тут единицы за смену. */}
              {v.comment && (
                <div className="flex items-start gap-1.5 text-[10px] text-zinc-600 dark:text-zinc-400">
                  <MessageSquare size={10} className="mt-0.5 shrink-0" />
                  <span className="break-words min-w-0">{v.comment}</span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

/**
 * Вкладка «Себестоимость»: из чего сложилась цена заказа (ТЗ 4.7).
 *
 * Снимок, а не формула на лету: цифру, по которой продают, нельзя менять
 * задним числом молча, поэтому каждый расчёт складывается в историю, а на
 * экране видно, что в нём стоит под вопросом.
 */
const CostBlock: React.FC<{
  order: ProductionOrderDetail;
  cost: ProductionCostState | null;
  loading: boolean;
  isUz: boolean;
  mayManage: boolean;
  saving: boolean;
  onCalculate: () => void;
}> = ({ order, cost, loading, isUz, mayManage, saving, onCalculate }) => {
  const unit = formatUnit(order.unit, isUz ? 'uz' : 'ru');
  /** Считают по заказу, работа по которому кончилась: расход уже записан. */
  const countable = ['produced', 'closed'].includes(order.status);
  const now = cost?.current ?? null;
  const past = (cost?.history ?? []).filter((h) => !h.isCurrent);

  const parts = now
    ? [
        { ru: 'Сырьё и материалы', uz: 'Xomashyo va materiallar', v: now.materialCost },
        { ru: 'Полуфабрикаты', uz: 'Yarim tayyor mahsulot', v: now.semiCost },
        {
          ru: 'Работа участков',
          uz: 'Uchastkalar ishi',
          v: now.directCost,
        },
        { ru: 'Переделка', uz: 'Qayta ishlash', v: now.reworkCost },
      ].filter((r) => toNumber(r.v) > 0)
    : [];

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[10px] text-zinc-500">
        {isUz
          ? 'Tannarx — buyurtma zavodga qancha turgani: materiallar omborga chiqarilgan narxi bilan, yarim tayyor mahsulot uni chiqargan buyurtma hisobi bilan, uchastkalar ishi soat stavkasi bilan. Yaroqli chiqishga bo‘linadi: brak yaroqli mahsulot narxini kamaytirmaydi.'
          : 'Себестоимость — это сколько заказ стоил заводу: материалы по той цене, по которой их выдали со склада, полуфабрикаты по расчёту заказа, который их выпустил, работа участков по ставке часа. Делим на годный выпуск: брак цену годного не уменьшает.'}
      </p>

      {loading && now === null ? (
        <span className="inline-flex items-center gap-1.5 text-[11px] text-zinc-500">
          <Loader2 size={11} className="animate-spin" />
          {isUz ? 'Hisob yuklanmoqda' : 'Загружаем расчёт'}
        </span>
      ) : now === null ? (
        <Empty
          text={
            isUz
              ? 'Buyurtma bo‘yicha tannarx hisoblanmagan'
              : 'Себестоимость по заказу ещё не рассчитана'
          }
        />
      ) : (
        <div className="flex flex-col gap-2 text-[11px]">
          {parts.map((r) => (
            <div key={r.ru} className="flex items-center justify-between gap-2">
              <span className="text-zinc-600 dark:text-zinc-400">{isUz ? r.uz : r.ru}</span>
              <span className="font-mono tabular-nums text-zinc-900 dark:text-zinc-100">
                {formatNumber(r.v, 0)}
              </span>
            </div>
          ))}

          <div className="flex items-center justify-between gap-2 border-t border-zinc-100 dark:border-zinc-800/60 pt-2">
            <span className="font-medium text-zinc-900 dark:text-zinc-100">
              {isUz ? 'Jami' : 'Итого'}
            </span>
            <span className="font-mono font-bold tabular-nums text-zinc-950 dark:text-zinc-50">
              {formatNumber(now.totalCost, 0)} UZS
            </span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-zinc-600 dark:text-zinc-400">
              {isUz ? 'Yaroqli chiqish' : 'Годного выпущено'}
            </span>
            <span className="font-mono tabular-nums text-zinc-900 dark:text-zinc-100">
              {formatQtyFine(now.qtyGood)} {unit}
            </span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-zinc-600 dark:text-zinc-400">
              {isUz ? `1 ${unit} tannarxi` : `Себестоимость 1 ${unit}`}
            </span>
            <span className="font-mono tabular-nums text-zinc-900 dark:text-zinc-100">
              {formatNumber(now.unitCost, 0)} UZS
            </span>
          </div>
          <p className="text-[10px] text-zinc-400">
            {isUz ? 'Hisob sanasi' : 'Расчёт от'} {formatDateTime(now.calculatedAt)}
            {now.calculatedByName ? ` · ${now.calculatedByName}` : ''}
          </p>
        </div>
      )}

      {/* Что в расчёте под вопросом — человеку важнее итога: цифра может
          оказаться меньше правды, и об этом говорим прямо. */}
      {now !== null && now.warnings.length > 0 && (
        <div className="flex flex-col gap-1 rounded-lg border border-amber-300 dark:border-amber-700/70 bg-amber-50 dark:bg-amber-950/30 p-2">
          {now.warnings.map((w) => (
            <span key={w} className="text-[10px] text-amber-800 dark:text-amber-300">
              {w}
            </span>
          ))}
        </div>
      )}

      {now !== null && now.lines.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-[10px] text-zinc-500">
            {isUz ? 'Nimadan yig‘ilgan' : 'Из чего сложилось'}
          </span>
          {now.lines.map((l) => (
            <div
              key={`${l.itemCode}-${l.fromOrderNumber ?? ''}`}
              className="flex flex-col gap-0.5 border-t border-zinc-100 dark:border-zinc-800/60 pt-1.5 text-[11px]"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-zinc-900 dark:text-zinc-100">
                  {isUz ? l.itemNameUz : l.itemNameRu}
                </span>
                <span className="shrink-0 font-mono tabular-nums text-zinc-900 dark:text-zinc-100">
                  {formatNumber(l.total, 0)}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2 text-[10px] text-zinc-500">
                <span className="font-mono truncate">
                  {formatQtyFine(l.qty)} {formatUnit(l.unit, isUz ? 'uz' : 'ru')} ×{' '}
                  {formatNumber(l.unitCost, 0)}
                </span>
                {l.fromOrderNumber && (
                  <span className="shrink-0 font-mono">
                    {isUz ? 'buyurtmadan' : 'из заказа'} {l.fromOrderNumber}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {past.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-[10px] text-zinc-500">
            {isUz ? 'Oldingi hisoblar' : 'Прошлые расчёты'}
          </span>
          {past.map((h) => (
            <div
              key={h.calculatedAt}
              className="flex items-center justify-between gap-2 text-[10px] text-zinc-500"
            >
              <span className="font-mono">{formatDateTime(h.calculatedAt)}</span>
              <span className="font-mono tabular-nums">
                {formatNumber(h.totalCost, 0)} · {formatNumber(h.unitCost, 0)}/{unit}
              </span>
            </div>
          ))}
        </div>
      )}

      {mayManage &&
        (countable ? (
          <div className="flex items-center gap-2">
            <button type="button" onClick={onCalculate} disabled={saving} className={MARK_PRIMARY}>
              <span className="inline-flex items-center gap-1.5">
                {saving && <Loader2 size={11} className="animate-spin" />}
                {now === null
                  ? isUz
                    ? 'Hisoblash'
                    : 'Рассчитать'
                  : isUz
                    ? 'Qayta hisoblash'
                    : 'Пересчитать'}
              </span>
            </button>
            {now !== null && (
              <span className="text-[10px] text-zinc-500">
                {isUz
                  ? 'Oldingi hisob tarixda qoladi'
                  : 'Прошлый расчёт останется в истории'}
              </span>
            )}
          </div>
        ) : (
          <span className="text-[10px] text-zinc-500">
            {isUz
              ? 'Hisob buyurtma chiqarilgandan keyin: sex ishlayotganda xarajat to‘liq yozilmagan'
              : 'Считаем, когда заказ выпущен: пока цех работает, расход записан не весь'}
          </span>
        ))}
    </div>
  );
};

const OrderPanel: React.FC<{
  order: ProductionOrderDetail;
  isUz: boolean;
  onEdit: () => void;
}> = ({ order, isUz, onEdit }) => {
  const { can } = useAuth();
  const {
    options,
    wantOptions,
    planStages,
    markStage,
    planMaterials,
    moveMaterial,
    useMaterial,
    registerOutput,
    reworkOrder,
    cost,
    wantCost,
    calculateCost,
    scheduleStages,
    saving,
  } = useProduction();
  // Ответ раскладки живёт до смены заказа: он говорит, успеваем ли к сроку.
  const [schedule, setSchedule] = React.useState<ProductionSchedule | null>(null);
  React.useEffect(() => setSchedule(null), [order.uid]);
  const mayManage = can('production.manage');
  /** Отмечает тот, кто стоит у станка: право своё, не «управление». */
  const canMark = mayManage || can('production.work');
  const [tab, setTab] = React.useState<'stages' | 'materials' | 'output' | 'cost'>('stages');

  // Причины простоя нужны ровно тому, кто может остановить этап: тянуть
  // справочник тому, кто пришёл посмотреть, незачем.
  React.useEffect(() => {
    if (canMark || can('warehouse.move') || mayManage) wantOptions();
  }, [canMark, mayManage, can, wantOptions]);
  // Расчёт себестоимости — запрос не из дешёвых: уходит, когда вкладку открыли.
  React.useEffect(() => {
    if (tab === 'cost') wantCost();
  }, [tab, wantCost]);
  // Фото брака и замера живут у задания: мастер снимает их в цеху, и без них
  // отчёт о браке — это слова (ТЗ 4.6).
  const [showFiles, setShowFiles] = React.useState(false);
  const unit = formatUnit(order.unit, isUz ? 'uz' : 'ru');

  const tabs = [
    { key: 'stages' as const, ru: 'Этапы', uz: 'Bosqichlar' },
    { key: 'materials' as const, ru: 'Материалы', uz: 'Materiallar' },
    { key: 'output' as const, ru: 'Выпуск', uz: 'Chiqarish' },
    { key: 'cost' as const, ru: 'Себестоимость', uz: 'Tannarx' },
  ];

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-3">
      <div className="shrink-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono font-bold text-sm text-zinc-950 dark:text-zinc-50">
            {order.number}
          </span>
          <span className="text-[10px] px-1.5 rounded border border-zinc-200 dark:border-zinc-800 text-zinc-500">
            {label(ORDER_STATUS, order.status, isUz)}
          </span>
          <span className="ms-auto">
            <AttachmentsButton compact isUz={isUz} onOpen={() => setShowFiles(true)} />
          </span>
        </div>

        {showFiles && (
          <AttachmentsDialog
            owner="production_order"
            uid={order.uid}
            title={`${isUz ? 'Ishlab chiqarish topshirig‘i' : 'Производственное задание'} ${order.number}`}
            canEdit={can('production.manage')}
            isUz={isUz}
            onClose={() => setShowFiles(false)}
          />
        )}
        <p className="text-[11px] text-zinc-600 dark:text-zinc-400 mt-1 break-words">
          {isUz ? order.itemNameUz : order.itemNameRu}
        </p>
        <p className="text-[10px] text-zinc-400 mt-0.5">
          {order.techCardVersion
            ? `${isUz ? 'Texkarta' : 'Техкарта'} v${order.techCardVersion}`
            : isUz
            ? 'Texkarta biriktirilmagan'
            : 'Техкарта не привязана'}
          {order.salesOrderNumber ? ` • ${order.salesOrderNumber}` : ''}
        </p>

        <div className="mt-2 grid grid-cols-2 gap-2 text-[11px]">
          <div className="flex flex-col">
            <span className="text-zinc-400 text-[10px]">
              {isUz ? 'Fakt / Reja' : 'Факт / План'}
            </span>
            <span className="font-mono text-zinc-900 dark:text-zinc-100 tabular-nums">
              {formatQty(order.qtyProduced)} / {formatQty(order.qtyPlanned)} {unit}
            </span>
          </div>
          <div className="flex flex-col">
            <span className="text-zinc-400 text-[10px]">
              {isUz ? 'Nuqson / Chiqindi' : 'Брак / Отход'}
            </span>
            <span className="font-mono text-zinc-700 dark:text-zinc-300 tabular-nums">
              {formatQty(order.qtyDefect)} / {formatQty(order.qtyWaste)} {unit}
            </span>
          </div>
        </div>

        {/* Шкала рисуется только тогда, когда доля существует. */}
        {order.qtyPercent !== null && (
          <div className="mt-2 flex flex-col gap-1">
            <div className="flex items-center justify-between text-[10px] text-zinc-500">
              <span>{formatPercent(order.qtyPercent)}</span>
              <span>
                {isUz ? 'Topshirish muddati' : 'Срок сдачи'}: {formatDate(order.dueDate)}
              </span>
            </div>
            <div className="w-full h-1.5 rounded-full bg-zinc-100 dark:bg-zinc-800 overflow-hidden">
              <div
                className="h-full bg-zinc-900 dark:bg-zinc-100 rounded-full"
                style={{ width: `${Math.min(100, toNumber(order.qtyPercent))}%` }}
              />
            </div>
          </div>
        )}

        {/* Срок в рабочих днях завода (Э7): «осталось два дня» и «осталось два
            рабочих дня» — разные вещи, если между ними воскресенье. */}
        {order.workDaysLeft !== null && (
          <p
            className={`mt-1 text-[10px] ${
              (order.workDaysOverdue ?? 0) > 0
                ? 'text-red-600 dark:text-red-400'
                : 'text-zinc-500'
            }`}
          >
            {(order.workDaysOverdue ?? 0) > 0
              ? isUz
                ? `Muddat o‘tdi: ${order.workDaysOverdue} ish kuni`
                : `Срок прошёл: ${order.workDaysOverdue} рабочих дней назад`
              : isUz
                ? `Muddatgacha ${order.workDaysLeft} ish kuni`
                : `До срока ${order.workDaysLeft} рабочих дней`}
            {order.dueOnWorkingDay === false
              ? isUz
                ? ' · muddat dam olish kuniga tushgan'
                : ' · срок выпал на выходной'
              : ''}
          </p>
        )}
      </div>

      {/* Вкладок стало четыре, и на 360 они в строку не помещаются: переносим
          по строкам, а не прячем за горизонтальной прокруткой — выехавшую
          вкладку на телефоне никто не ищет. */}
      <div className="inline-flex flex-wrap min-h-7 max-w-full items-center rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-0.5 shadow-2xs shrink-0 self-start">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            aria-pressed={tab === t.key}
            className={`h-6 px-2 text-[11px] font-medium rounded-md transition-all cursor-pointer whitespace-nowrap ${
              tab === t.key
                ? 'bg-zinc-950 text-white dark:bg-zinc-100 dark:text-zinc-950'
                : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-200'
            }`}
          >
            {isUz ? t.uz : t.ru}
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto pr-1">
        {tab === 'stages' &&
          (order.stages.length === 0 ? (
            <div className="flex flex-col gap-2 py-2">
              <p className="text-[11px] text-zinc-600 dark:text-zinc-400">
                {isUz
                  ? 'Ish rejasi hali yo‘q. Bosqichlarsiz buyurtma ishga tushmaydi: sexga nima qilishni aytilmagan.'
                  : 'План работ ещё не задан. Без этапов заказ не запустится: цеху не сказали, что делать.'}
              </p>
              {mayManage && (
                <>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void planStages(order.uid)}
                    className={MARK_PRIMARY}
                  >
                    <span className="inline-flex items-center gap-1.5">
                      {saving && <Loader2 size={11} className="animate-spin" />}
                      {isUz ? 'Texkartadan bosqichlar' : 'Этапы из техкарты'}
                    </span>
                  </button>
                  <span className="text-[10px] text-zinc-400">
                    {isUz
                      ? 'Normalar buyurtma miqdoriga ko‘paytiriladi va o‘sha versiyadan olinadi, qaysi biri buyurtmada yozilgan.'
                      : 'Нормы умножатся на количество заказа и возьмутся из той версии карты, которую помнит заказ.'}
                  </span>
                </>
              )}
            </div>
          ) : (
            <div className="divide-y divide-zinc-100 dark:divide-zinc-800/60">
              {mayManage && (
                <div className="flex flex-col gap-1 pb-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={saving}
                      onClick={async () => {
                        const plan = await scheduleStages(order.uid);
                        if (plan) setSchedule(plan);
                      }}
                      className={MARK_GHOST}
                    >
                      <span className="inline-flex items-center gap-1.5">
                        {saving && <Loader2 size={11} className="animate-spin" />}
                        {isUz ? 'Smenalarga taqsimlash' : 'Разложить по сменам'}
                      </span>
                    </button>
                    <span className="text-[10px] text-zinc-400">
                      {isUz
                        ? 'Normalar zavod kalendari bo‘yicha kunlarga yotadi'
                        : 'Нормы лягут на дни по календарю завода'}
                    </span>
                  </div>
                  {schedule && (
                    <p
                      className={`text-[10px] ${
                        schedule.lateDays > 0
                          ? 'text-red-600 dark:text-red-400'
                          : 'text-zinc-500'
                      }`}
                    >
                      {schedule.lateDays > 0
                        ? isUz
                          ? `Grafik bo‘yicha ${formatDate(schedule.finishesOn)} da tugaydi — muddatdan ${schedule.lateDays} ish kuni kech`
                          : `По графику закончим ${formatDate(schedule.finishesOn)} — на ${schedule.lateDays} рабочих дней позже срока`
                        : isUz
                          ? `Grafik bo‘yicha ${formatDate(schedule.finishesOn)} da tugaydi — muddatga ulguramiz`
                          : `По графику закончим ${formatDate(schedule.finishesOn)} — к сроку успеваем`}
                    </p>
                  )}
                </div>
              )}
              {order.stages.map((s) => (
                <StageBlock
                  key={s.seq}
                  stage={s}
                  isUz={isUz}
                  canMark={canMark}
                  canEditFiles={can('production.manage')}
                  orderRunning={order.status === 'in_progress'}
                  reasons={options.data?.downtimeReasons ?? []}
                  saving={saving}
                  onMark={(kind, reasonUid) =>
                    void markStage(order.uid, s.seq, kind, reasonUid ? { reasonUid } : {})
                  }
                />
              ))}
            </div>
          ))}

        {tab === 'materials' &&
          (order.materials.length === 0 ? (
            <div className="flex flex-col gap-2 py-2">
              <p className="text-[11px] text-zinc-600 dark:text-zinc-400">
                {isUz
                  ? 'Sarf rejasi hali yo‘q. Rejasiz sexga nima berish kerakligi ham, ortiqcha sarf ham ko‘rinmaydi.'
                  : 'План расхода не задан. Без него не видно ни что выдавать цеху, ни перерасход.'}
              </p>
              {mayManage && (
                <>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void planMaterials(order.uid)}
                    className={MARK_PRIMARY}
                  >
                    <span className="inline-flex items-center gap-1.5">
                      {saving && <Loader2 size={11} className="animate-spin" />}
                      {isUz ? 'Texkartadan materiallar' : 'Материалы из техкарты'}
                    </span>
                  </button>
                  <span className="text-[10px] text-zinc-400">
                    {isUz
                      ? 'Normalar buyurtma miqdoriga ko‘paytiriladi, bosqich chiqindisi ham qo‘shiladi.'
                      : 'Нормы умножатся на количество заказа, отход этапа войдёт в план.'}
                  </span>
                </>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-2.5">
              {order.materials.map((m) => (
                <MaterialBlock
                  key={m.itemCode}
                  orderUid={order.uid}
                  orderStatus={order.status}
                  material={m}
                  isUz={isUz}
                  mayManage={mayManage}
                  mayMove={can('warehouse.move')}
                  warehouses={options.data?.warehouses ?? []}
                  saving={saving}
                  onMove={(kind, input) => void moveMaterial(order.uid, kind, input)}
                  onUse={(input) => void useMaterial(order.uid, input)}
                />
              ))}
            </div>
          ))}

        {tab === 'output' && (
          <OutputBlock
            order={order}
            isUz={isUz}
            mayManage={mayManage}
            warehouses={options.data?.warehouses ?? []}
            defectReasons={options.data?.defectReasons ?? []}
            wasteReasons={options.data?.wasteReasons ?? []}
            items={options.data?.materials ?? []}
            saving={saving}
            onRegister={(input) => void registerOutput(order.uid, input)}
            onRework={(input) => void reworkOrder(order.uid, input)}
          />
        )}

        {tab === 'cost' && (
          <CostBlock
            order={order}
            cost={cost.data}
            loading={cost.isLoading}
            isUz={isUz}
            mayManage={mayManage}
            saving={saving}
            onCalculate={() => void calculateCost(order.uid)}
          />
        )}
      </div>

      {/* Зачем этот заказ — то, что написали при заведении. */}
      {order.comment && (
        <p className="shrink-0 text-[11px] text-zinc-600 dark:text-zinc-400 border-s-2 border-zinc-200 dark:border-zinc-700 ps-2">
          {order.comment}
        </p>
      )}

      {/* Почему стоит — отдельной строкой и только там, где это правда сейчас.
          У работающего заказа прошлая причина остановки сбивает с толку; её
          история целиком лежит в журнале действий. */}
      {order.statusReason && (order.status === 'paused' || order.status === 'cancelled') && (
        <p className="shrink-0 text-[11px] text-amber-700 dark:text-amber-400 border-s-2 border-amber-300 dark:border-amber-700/70 ps-2">
          {order.status === 'paused'
            ? isUz
              ? 'To‘xtash sababi: '
              : 'Причина остановки: '
            : isUz
              ? 'Bekor qilish sababi: '
              : 'Причина отмены: '}
          {order.statusReason}
          {order.statusReasonAt && (
            <span className="text-zinc-400"> • {formatDateTime(order.statusReasonAt)}</span>
          )}
        </p>
      )}

      {can('production.manage') && (
        <ProductionOrderActions order={order} isUz={isUz} onEdit={onEdit} />
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------

export const ProductionView: React.FC = () => {
  const { locale } = useApp();
  const isUz = locale === 'uz';
  const {
    period,
    setPeriod,
    summary,
    reloadSummary,
    state,
    setState,
    search,
    setSearch,
    orders,
    reloadOrders,
    offset,
    setOffset,
    pageSize,
    selectedUid,
    setSelectedUid,
    order,
  } = useProduction();
  const { can } = useAuth();
  const mayManage = can('production.manage');

  /**
   * Панель справа одна на три вида: карточка заказа, форма заведения и правка
   * черновика. Форма не диалог поверх экрана: на телефоне диалог закрывает
   * список, из которого человек только что выбрал заказ.
   */
  const [form, setForm] = React.useState<'new' | 'edit' | null>(null);

  /**
   * Заказы и техкарты — два разных дела на одном экране.
   *
   * Карта живёт дольше заказа и описывает не конкретную работу, а правило, по
   * которому её считают. Складывать их в один список значило бы мешать «что
   * делаем сейчас» с «как это делается вообще».
   */
  const [section, setSection] = React.useState<
    'orders' | 'cards' | 'control' | 'calendar' | 'reports' | 'centers'
  >('orders');

  const stateOptions = [
    { value: 'all' as ProductionState, label: isUz ? 'Barcha buyurtmalar' : 'Все заказы' },
    { value: 'planned' as ProductionState, label: isUz ? 'Rejalashtirilgan' : 'Запланированы' },
    { value: 'active' as ProductionState, label: isUz ? 'Ishda' : 'В работе' },
    { value: 'done' as ProductionState, label: isUz ? 'Chiqarilgan' : 'Выпущены' },
  ];

  const renderList = () => {
    if (orders.error && !orders.data) {
      return <ErrorBox text={errorText(orders.error, isUz)} onRetry={reloadOrders} isUz={isUz} />;
    }
    if (!orders.data) {
      return (
        <div className="divide-y divide-zinc-100 dark:divide-zinc-800/40">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <RowSkeleton key={i} />
          ))}
        </div>
      );
    }

    const rows = orders.data.rows;
    if (rows.length === 0) {
      return (
        <Empty
          text={
            search
              ? isUz
                ? 'So‘rov bo‘yicha buyurtma topilmadi'
                : 'По запросу заказов не найдено'
              : isUz
              ? 'Bu holatda buyurtma yo‘q'
              : 'В этом состоянии заказов нет'
          }
        />
      );
    }

    return (
      <div className="divide-y divide-zinc-100 dark:divide-zinc-800/40">
        {rows.map((row) => {
          const selected = selectedUid === row.uid;
          const overdue = isOverdue(row.dueDate, row.status);
          const unit = formatUnit(row.unit, isUz ? 'uz' : 'ru');
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
                    {formatDate(row.dueDate)}
                  </span>
                  {overdue && (
                    <span className="text-[10px] px-1.5 rounded bg-red-100 dark:bg-red-950/50 text-red-700 dark:text-red-300 font-mono">
                      {isUz ? 'muddati o‘tgan' : 'просрочка'}
                    </span>
                  )}
                </div>
                <div className="font-medium text-xs text-zinc-900 dark:text-zinc-100 truncate mt-0.5">
                  {isUz ? row.itemNameUz : row.itemNameRu}
                </div>
                <div className="text-[11px] text-zinc-500 truncate mt-0.5">
                  {label(ORDER_STATUS, row.status, isUz)} • {isUz ? 'bosqichlar' : 'этапы'}{' '}
                  {row.stagesDone}/{row.stagesTotal}
                  {row.responsibleName ? ` • ${row.responsibleName}` : ''}
                </div>
              </div>

              <div className="text-right shrink-0">
                <div className="font-mono font-bold text-xs text-zinc-950 dark:text-zinc-50 tabular-nums">
                  {formatQty(row.qtyProduced)}
                  <span className="text-zinc-400 font-normal">
                    {' / '}
                    {formatQty(row.qtyPlanned)}
                  </span>
                  <span className="text-[10px] text-zinc-400 font-normal ml-1">{unit}</span>
                </div>
                {row.qtyPercent !== null && (
                  <div className="mt-1 text-[11px] font-medium text-zinc-700 dark:text-zinc-300">
                    {formatPercent(row.qtyPercent)}
                  </div>
                )}
              </div>
            </button>
          );
        })}
      </div>
    );
  };

  const renderPanel = () => {
    if (form === 'new') {
      return (
        <ProductionOrderForm
          order={null}
          isUz={isUz}
          onDone={(uid) => {
            setForm(null);
            setSelectedUid(uid);
          }}
          onCancel={() => setForm(null)}
        />
      );
    }
    if (form === 'edit' && order.data) {
      return (
        <ProductionOrderForm
          order={order.data}
          isUz={isUz}
          onDone={() => setForm(null)}
          onCancel={() => setForm(null)}
        />
      );
    }
    if (selectedUid === null) {
      return (
        <div className="flex-1 flex flex-col items-center justify-center gap-3">
          <Empty text={isUz ? 'Ro‘yxatdan buyurtmani tanlang' : 'Выберите заказ из списка'} />
          {mayManage && (
            <button
              type="button"
              onClick={() => setForm('new')}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-zinc-900 text-zinc-50 hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200 cursor-pointer"
            >
              <span className="inline-flex items-center gap-1.5">
                <Plus size={12} />
                {isUz ? 'Yangi buyurtma' : 'Новый заказ'}
              </span>
            </button>
          )}
        </div>
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
    return <OrderPanel order={order.data} isUz={isUz} onEdit={() => setForm('edit')} />;
  };

  return (
    <>
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {summary.error && !summary.data ? (
          <div className={`lg:col-span-12 min-h-[230px] ${CARD}`}>
            <ErrorBox text={errorText(summary.error, isUz)} onRetry={reloadSummary} isUz={isUz} />
          </div>
        ) : (
          <>
            <WorkCenterCard
              summary={summary.data}
              isLoading={summary.isLoading}
              isUz={isUz}
              period={period}
              setPeriod={setPeriod}
            />
            <StatusCard summary={summary.data} isLoading={summary.isLoading} isUz={isUz} />
          </>
        )}
      </div>

      {/* Выпуск за период — отдельной строкой и по единицам измерения: тонны
          трубы и погонные метры скорлупы в одну цифру не складываются. */}
      {summary.data && summary.data.output.length > 0 && (
        <div className={`${CARD} p-3 flex flex-wrap items-center gap-x-6 gap-y-2`}>
          <span className="text-[11px] text-zinc-500 shrink-0">
            {isUz ? 'Davr ichida chiqarildi' : 'Выпуск за период'}
          </span>
          {summary.data.output.map((o) => (
            <div key={o.unit} className="flex items-baseline gap-2 text-xs">
              <span className="font-mono font-bold text-zinc-950 dark:text-zinc-50 tabular-nums">
                {formatQty(o.good)} {formatUnit(o.unit, isUz ? 'uz' : 'ru')}
              </span>
              <span className="text-[11px] text-zinc-500">
                {isUz ? 'nuqson' : 'брак'} {formatQty(o.defect)}
                {o.defectPercent !== null ? ` (${formatPercent(o.defectPercent)})` : ''}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Переключатель разделов переносится по строкам: на 360 с развёрнутым
          сайдабром две кнопки в одну строку не встают и вылезали за экран. */}
      <div className="inline-flex flex-wrap min-h-8 max-w-full items-center gap-0.5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-0.5 shadow-2xs self-start">
        {[
          { key: 'orders' as const, ru: 'Заказы цеха', uz: 'Sex buyurtmalari' },
          { key: 'cards' as const, ru: 'Техкарты', uz: 'Texkartalar' },
          { key: 'control' as const, ru: 'Отклонения', uz: 'Chetlanishlar' },
          { key: 'calendar' as const, ru: 'Календарь', uz: 'Kalendar' },
          { key: 'reports' as const, ru: 'Отчёты', uz: 'Hisobotlar' },
          { key: 'centers' as const, ru: 'Участки', uz: 'Uchastkalar' },
        ].map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setSection(t.key)}
            aria-pressed={section === t.key}
            className={`h-7 px-3 text-[11px] font-medium rounded-md transition-all cursor-pointer whitespace-nowrap ${
              section === t.key
                ? 'bg-zinc-950 text-white dark:bg-zinc-100 dark:text-zinc-950'
                : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-200'
            }`}
          >
            {isUz ? t.uz : t.ru}
          </button>
        ))}
      </div>

      {section === 'cards' && <ProductionTechCards />}
      {section === 'control' && <ProductionControl />}
      {section === 'calendar' && <ProductionCalendarPanel />}
      {section === 'reports' && <ProductionReports />}
      {section === 'centers' && <ProductionCenters />}

      <div
        className={`grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch ${
          section === 'orders' ? '' : 'hidden'
        }`}
      >
        <div className={`lg:col-span-8 h-[540px] ${CARD} overflow-hidden flex flex-col justify-between`}>
          <div className="p-3 border-b border-zinc-100 dark:border-zinc-800/60 bg-zinc-50/50 dark:bg-zinc-900/30 flex flex-col sm:flex-row sm:items-center justify-between gap-3 shrink-0">
            <h3 className="text-xs font-semibold text-zinc-950 dark:text-zinc-50 shrink-0">
              {isUz ? 'Ishlab chiqarish buyurtmalari' : 'Производственные заказы'}
            </h3>

            <div className="flex flex-col sm:flex-row sm:items-center gap-2 w-full sm:w-auto">
              {mayManage && (
                <button
                  type="button"
                  onClick={() => {
                    setSelectedUid(null);
                    setForm('new');
                  }}
                  className="h-8 px-3 rounded-lg text-xs font-medium bg-zinc-900 text-zinc-50 hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200 cursor-pointer w-full sm:w-auto"
                >
                  <span className="inline-flex items-center justify-center gap-1.5">
                    <Plus size={12} />
                    {isUz ? 'Buyurtma' : 'Заказ'}
                  </span>
                </button>
              )}
              <CustomSelect
                value={state}
                onChange={setState}
                options={stateOptions}
                className="w-full sm:w-44"
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
                  placeholder={isUz ? 'Raqam yoki mahsulot...' : 'Номер или продукция...'}
                  aria-label={isUz ? 'Buyurtmalarni qidirish' : 'Поиск заказов'}
                  className="h-8 w-full sm:w-48 pl-7 pr-2.5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-xs text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 focus:outline-hidden focus:border-zinc-400 transition-colors shadow-2xs"
                />
              </div>
            </div>
          </div>

          <div
            className={`flex-1 overflow-y-auto w-full transition-opacity ${
              orders.isLoading && orders.data ? 'opacity-60' : ''
            }`}
          >
            {renderList()}
          </div>

          <div className="px-4 py-2 border-t border-zinc-100 dark:border-zinc-800/60 bg-zinc-50/30 dark:bg-zinc-900/20 text-xs text-zinc-400 flex items-center justify-between gap-2 font-mono shrink-0">
            {/* Листаем страницами: человек видит, где он в списке, а не «последние 100». */}
            <span className="truncate">
              {orders.data && orders.data.total > 0
                ? `${isUz ? 'Buyurtmalar' : 'Заказы'} ${orders.data.offset + 1}–${
                    orders.data.offset + orders.data.rows.length
                  } ${isUz ? 'dan' : 'из'} ${orders.data.total}`
                : periodLabel(period, isUz)}
            </span>
            {orders.data && orders.data.total > orders.data.rows.length ? (
              <span className="shrink-0 flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setOffset(Math.max(0, offset - pageSize))}
                  disabled={offset === 0 || orders.isLoading}
                  aria-label={isUz ? 'Orqaga' : 'Назад'}
                  className="h-6 px-2 rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-zinc-700 dark:text-zinc-200 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer hover:border-zinc-400 transition-colors"
                >
                  {isUz ? 'Orqaga' : 'Назад'}
                </button>
                <button
                  type="button"
                  onClick={() => setOffset(offset + pageSize)}
                  disabled={
                    orders.isLoading || offset + orders.data.rows.length >= orders.data.total
                  }
                  aria-label={isUz ? 'Oldinga' : 'Вперёд'}
                  className="h-6 px-2 rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-zinc-700 dark:text-zinc-200 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer hover:border-zinc-400 transition-colors"
                >
                  {isUz ? 'Oldinga' : 'Вперёд'}
                </button>
              </span>
            ) : (
              <span className="shrink-0">
                {orders.data ? `${isUz ? 'Yozuvlar:' : 'Записей:'} ${orders.data.rows.length}` : '—'}
              </span>
            )}
          </div>
        </div>

        <div className={`lg:col-span-4 h-[540px] ${CARD} p-4 sm:p-5 flex flex-col justify-between`}>
          {renderPanel()}
        </div>
      </div>
    </>
  );
};
