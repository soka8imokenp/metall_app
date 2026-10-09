/**
 * Данные страницы склада.
 *
 * Провайдер монтируется вместе с разделом: пока открыт дашборд, остатки
 * серверу не нужны.
 *
 * Фильтры живут здесь, а не в экране, потому что каждый из них — запрос.
 * Поиск с задержкой: кладовщик набирает номер партии посимвольно, и без
 * задержки каждый символ уходил бы на сервер.
 *
 * Прослеживаемость партии грузится отдельно и только по клику: это журнал
 * движений, и тянуть его на каждую строку списка незачем.
 *
 * Запись — приход, списание, перемещение и отмена — живёт здесь же. После
 * каждой записи перечитываются сводка, остатки и открытый путь партии: остаток
 * меняется сразу, и экран, показывающий прежнее число, врёт кладовщику.
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  DashboardPeriod,
  WarehouseBatchTrace,
  WarehouseSerialTrace,
  WarehouseMoveInput,
  WarehouseMovesPage,
  WarehouseOperationType,
  WarehouseRefs,
  WarehouseReservationInput,
  WarehouseReservationsPage,
  WarehousePurchaseNeeds,
  WarehouseReport,
  WarehouseReportKind,
  WarehouseStockRow,
  WarehouseSummary,
  WarehouseScanHit,
  WarehouseLabelSheet,
  WarehouseLabelTemplate,
  CodeKind,
  InventorySheetDetail,
  InventorySheetInput,
  InventorySheetsPage,
  InventoryStatus,
  ReportFormat,
} from '../types/api';
import { ApiError, apiClient } from '../lib/api-client';
import { AsyncState } from './DashboardContext';
import { useApp } from './AppContext';
import { useSearchJump } from '../lib/use-search-jump';
import { useAuth } from './AuthContext';

export type WarehouseTab =
  | 'stock'
  | 'moves'
  | 'reservations'
  | 'inventory'
  | 'needs'
  | 'reports'
  | 'refs';

/** Размер страницы журнала. Больше двухсот сервер не отдаст. */
export const MOVES_PAGE_SIZE = 50;

export interface MovesFilters {
  operationType: WarehouseOperationType | null;
  itemCode: string;
  batchNumber: string;
  from: string;
  to: string;
  search: string;
}

const NO_MOVES_FILTERS: MovesFilters = {
  operationType: null,
  itemCode: '',
  batchNumber: '',
  from: '',
  to: '',
  search: '',
};

interface WarehouseContextValue {
  period: DashboardPeriod;
  setPeriod: (p: DashboardPeriod) => void;
  summary: AsyncState<WarehouseSummary>;

  search: string;
  setSearch: (s: string) => void;
  warehouseUid: string | null;
  setWarehouseUid: (uid: string | null) => void;
  criticalOnly: boolean;
  setCriticalOnly: (v: boolean) => void;
  stock: AsyncState<{ rows: WarehouseStockRow[] }>;
  reloadStock: () => void;

  traceUid: string | null;
  setTraceUid: (uid: string | null) => void;
  trace: AsyncState<WarehouseBatchTrace>;

  /**
   * Путь серийного номера. Отдельно от пути партии: у штучной позиции партии
   * нет вовсе, и открывать её карточку было бы нечем.
   */
  serialNumber: string | null;
  setSerialNumber: (n: string | null) => void;
  serialTrace: AsyncState<WarehouseSerialTrace>;

  /** Вкладка левой карты: остатки или журнал движений. */
  tab: WarehouseTab;
  setTab: (t: WarehouseTab) => void;
  /**
   * Журнал движений. Свои фильтры, а не общие с остатками: у остатка нет типа
   * операции и периода, а у движения нет критического уровня.
   */
  moves: AsyncState<WarehouseMovesPage>;
  movesFilters: MovesFilters;
  setMovesFilter: <K extends keyof MovesFilters>(key: K, value: MovesFilters[K]) => void;
  resetMovesFilters: () => void;
  movesPage: number;
  setMovesPage: (p: number) => void;
  reloadMoves: () => void;

  /**
   * Резервы. Отдельный список, а не колонка в остатках: в остатке от резерва
   * есть только число, а кому обещано и до какого срока — здесь.
   */
  reservations: AsyncState<WarehouseReservationsPage>;
  reloadReservations: () => void;
  /** Постановка резерва. Возвращает uid или null при отказе. */
  reserve: (input: WarehouseReservationInput) => Promise<string | null>;
  reserving: boolean;
  reserveError: ApiError | null;
  clearReserveError: () => void;
  /** Снятие резерва. uid снимаемого — чтобы заблокировать его кнопку. */
  releaseReservation: (uid: string) => Promise<void>;
  releasing: string | null;

  /**
   * Инвентаризация (ТЗ 5.8). Список листов и открытый лист — два запроса, а не
   * один: строк в листе бывают сотни, и тянуть их на каждую строку списка
   * незачем. Открытый лист держим по uid, чтобы он выжил перечитывание списка.
   */
  sheets: AsyncState<InventorySheetsPage>;
  reloadSheets: () => void;
  sheetStatus: InventoryStatus | null;
  setSheetStatus: (s: InventoryStatus | null) => void;
  sheetUid: string | null;
  setSheetUid: (uid: string | null) => void;
  sheet: AsyncState<InventorySheetDetail>;
  reloadSheet: () => void;
  /** Новый лист. Возвращает uid созданного или null при отказе. */
  createSheet: (input: InventorySheetInput) => Promise<string | null>;
  /** Факт по строке листа. Ноль — законный результат подсчёта. */
  countLine: (lineUid: string, qty: string, comment?: string) => Promise<boolean>;
  /** «Посчитали» — лист уходит на утверждение. */
  finishSheet: (uid: string) => Promise<void>;
  /** Утверждение: расхождения уходят в журнал движениями. */
  approveSheet: (uid: string) => Promise<void>;
  /** Отмена листа: остаток не меняется. */
  cancelSheet: (uid: string) => Promise<void>;
  /** Что сейчас выполняется по листу: строка `count:<uid>` или действие. */
  sheetBusy: string | null;
  sheetError: ApiError | null;
  clearSheetError: () => void;

  /**
   * Потребность в закупке (ТЗ 5.10). Отдельная вкладка, а не колонка в
   * остатках: остаток — про партию на полке, потребность — про позицию
   * целиком, и строк в них разное число.
   *
   * Уровни отчёт только читает: править их пока негде, справочники на запись —
   * Э8. Свой фильтр здесь один — состояние; склад берётся из общего сверху.
   */
  needs: AsyncState<WarehousePurchaseNeeds>;
  reloadNeeds: () => void;
  needsState: 'critical' | 'below_min' | null;
  setNeedsState: (s: 'critical' | 'below_min' | null) => void;
  /** Показывать ли позиции без нехватки: по умолчанию отчёт — это тревога. */
  needsAll: boolean;
  setNeedsAll: (v: boolean) => void;

  /**
   * Отчёты склада (ТЗ 5.1). Свои фильтры — вид отчёта и период; склад берётся
   * из общего сверху, как у журнала и резервов.
   *
   * Выгрузка идёт мимо состояния: файл не показывают на экране, его сохраняют.
   * Поэтому `downloadReport` ничего не возвращает и только сообщает об отказе.
   */
  reportKind: WarehouseReportKind;
  setReportKind: (k: WarehouseReportKind) => void;
  reportFrom: string;
  reportTo: string;
  setReportPeriod: (from: string, to: string) => void;
  report: AsyncState<WarehouseReport>;
  reloadReport: () => void;
  downloadReport: (format: ReportFormat) => Promise<void>;
  /** Какой формат сейчас скачивается: кнопка на нём блокируется. */
  downloading: ReportFormat | null;
  downloadError: ApiError | null;

  /** Справочники формы движения. */
  refs: AsyncState<WarehouseRefs>;
  reloadRefs: () => void;
  /** Запись движения. Возвращает uid записанного или null при отказе. */
  save: (input: WarehouseMoveInput) => Promise<string | null>;
  saving: boolean;
  saveError: ApiError | null;
  clearSaveError: () => void;
  /** Номер партии и склад последнего записанного движения — для подсказки. */
  lastSaved: { uid: string; kind: string; qty: string; itemCode: string } | null;

  /** Отмена движения зеркальным движением. */
  reverseMove: (uid: string, comment?: string) => Promise<void>;
  /** uid движения, которое сейчас отменяется: кнопка на нём блокируется. */
  reversing: string | null;
  reverseError: ApiError | null;

  /* --- Сканер и этикетки (ТЗ 5.9) --- */
  /** Разобрать то, что принёс сканер. Сам же и переводит экран на объект. */
  scan: (code: string) => Promise<void>;
  scanHit: WarehouseScanHit | null;
  scanning: boolean;
  scanError: ApiError | null;
  clearScan: () => void;
  /** Ключи строк остатка, отмеченных к печати. */
  labelKeys: string[];
  toggleLabelKey: (key: string) => void;
  clearLabelKeys: () => void;
  /** Что печатать по отмеченным строкам: позицию, партию, номер или ячейку. */
  labelKind: CodeKind;
  setLabelKind: (k: CodeKind) => void;
  labelTemplates: AsyncState<{ rows: WarehouseLabelTemplate[] }>;
  labelSheet: WarehouseLabelSheet | null;
  buildLabels: (templateUid: string, copies: number, codes: string[]) => Promise<void>;
  labelBusy: boolean;
  labelError: ApiError | null;
  clearLabelSheet: () => void;
}

const WarehouseContext = createContext<WarehouseContextValue | undefined>(undefined);

const idle = <T,>(): AsyncState<T> => ({ data: null, isLoading: false, error: null });
const toApiError = (e: unknown) =>
  e instanceof ApiError ? e : new ApiError('INTERNAL_ERROR', '', 0);

/** Запрос в состояние: та же обвязка, что на продажах и в производстве. */
function useAsync<T>(
  run: () => Promise<{ data: T }>,
  deps: unknown[],
  enabled: boolean,
): [AsyncState<T>, () => void] {
  const [state, setState] = useState<AsyncState<T>>(idle<T>());
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    // Прошлые строки не стираем: при смене фильтра таблица не должна
    // схлопываться в пустоту, достаточно показать загрузку поверх.
    setState((s) => ({ ...s, isLoading: true, error: null }));

    run()
      .then(({ data }) => {
        if (!cancelled) setState({ data, isLoading: false, error: null });
      })
      .catch((e) => {
        if (!cancelled) setState({ data: null, isLoading: false, error: toApiError(e) });
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled, nonce]);

  return [state, () => setNonce((n) => n + 1)];
}

export const WarehouseProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { company, locale } = useApp();
  const { session } = useAuth();
  const ready = Boolean(session);

  const [period, setPeriod] = useState<DashboardPeriod>('30d');
  const [search, setSearch] = useState('');
  const [warehouseUid, setWarehouseUid] = useState<string | null>(null);
  const [criticalOnly, setCriticalOnly] = useState(false);
  const [traceUid, setTraceUid] = useState<string | null>(null);

  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Склад выбран у одной компании, а переключились на другую — фильтр надо
  // снять, иначе экран покажет пустую таблицу и не скажет почему.
  useEffect(() => {
    setWarehouseUid(null);
  }, [company]);

  const [summary, reloadSummary] = useAsync(
    () => apiClient.warehouse.getSummary(period),
    [company, locale, period],
    ready,
  );

  const [stock, reloadStock] = useAsync(
    () =>
      apiClient.warehouse.getStock({
        warehouse: warehouseUid ?? undefined,
        search: debounced,
        critical: criticalOnly,
        limit: 200,
      }),
    [company, locale, warehouseUid, debounced, criticalOnly],
    ready,
  );

  const [trace, reloadTrace] = useAsync(
    () => apiClient.warehouse.getBatch(traceUid!),
    [company, locale, traceUid],
    ready && traceUid !== null,
  );

  const [serialNumber, setSerialNumber] = useState<string | null>(null);
  const [serialTrace, reloadSerialTrace] = useAsync(
    () => apiClient.warehouse.getSerial(serialNumber!),
    [company, locale, serialNumber],
    ready && serialNumber !== null,
  );

  const [tab, setTab] = useState<WarehouseTab>('stock');
  // Находка из общего поиска. Номенклатуру и партии ищут на остатках, сами
  // склады — в справочниках, и подставлять там строку остатков нечего.
  useSearchJump('warehouse', (q) => {
    setSearch(q);
    setTab('stock');
  }, 'stock');
  useSearchJump('warehouse', () => setTab('refs'), 'refs');
  const [movesFilters, setMovesFilters] = useState<MovesFilters>(NO_MOVES_FILTERS);
  const [movesPage, setMovesPage] = useState(0);

  // Фильтр поменялся — страница снова первая: иначе человек видит пустоту,
  // потому что стоит на третьей странице выборки из десяти строк.
  const setMovesFilter = useCallback(
    <K extends keyof MovesFilters>(key: K, value: MovesFilters[K]) => {
      setMovesFilters((f) => ({ ...f, [key]: value }));
      setMovesPage(0);
    },
    [],
  );
  const resetMovesFilters = useCallback(() => {
    setMovesFilters(NO_MOVES_FILTERS);
    setMovesPage(0);
  }, []);

  // Компанию переключили — склад в фильтре журнала чужой, как и в остатках.
  useEffect(() => {
    setMovesFilters(NO_MOVES_FILTERS);
    setMovesPage(0);
  }, [company]);

  const [movesSearch, setMovesSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setMovesSearch(movesFilters.search.trim()), 300);
    return () => clearTimeout(t);
  }, [movesFilters.search]);

  /**
   * Журнал грузится только на своей вкладке: пока открыты остатки, серверу
   * незачем считать полторы тысячи движений.
   *
   * Склад журнал берёт из общего фильтра сверху — тот же выбор, что у остатков:
   * два разных списка складов на одном экране человек читает как ошибку.
   */
  const [moves, reloadMoves] = useAsync(
    () =>
      apiClient.warehouse.getMoves({
        warehouse: warehouseUid ?? undefined,
        operationType: movesFilters.operationType ?? undefined,
        itemCode: movesFilters.itemCode || undefined,
        batchNumber: movesFilters.batchNumber || undefined,
        from: movesFilters.from || undefined,
        to: movesFilters.to || undefined,
        search: movesSearch || undefined,
        limit: MOVES_PAGE_SIZE,
        offset: movesPage * MOVES_PAGE_SIZE,
      }),
    [
      company,
      locale,
      warehouseUid,
      movesFilters.operationType,
      movesFilters.itemCode,
      movesFilters.batchNumber,
      movesFilters.from,
      movesFilters.to,
      movesSearch,
      movesPage,
    ],
    ready && tab === 'moves',
  );

  /**
   * Резервы грузятся только на своей вкладке — как и журнал. Склад берут из
   * общего фильтра сверху: третий список складов на экране читался бы как
   * ошибка.
   */
  const [reservations, reloadReservations] = useAsync(
    () =>
      apiClient.warehouse.getReservations({
        warehouse: warehouseUid ?? undefined,
        limit: 200,
      }),
    [company, locale, warehouseUid],
    ready && tab === 'reservations',
  );

  /**
   * Листы инвентаризации. Склад берут из общего фильтра сверху — как журнал и
   * резервы. Статус — свой фильтр: у остатка статуса нет.
   */
  const [sheetStatus, setSheetStatus] = useState<InventoryStatus | null>(null);
  const [sheets, reloadSheets] = useAsync(
    () =>
      apiClient.warehouse.getSheets({
        warehouse: warehouseUid ?? undefined,
        status: sheetStatus ?? undefined,
        limit: 100,
      }),
    [company, locale, warehouseUid, sheetStatus],
    ready && tab === 'inventory',
  );

  /**
   * Потребность в закупке. Грузится только на своей вкладке: отчёт обходит
   * уровни, остаток, резервы и планы цеха — на вкладке остатков это работа
   * впустую.
   */
  const [needsState, setNeedsState] = useState<'critical' | 'below_min' | null>(null);
  const [needsAll, setNeedsAll] = useState(false);
  const [needs, reloadNeeds] = useAsync(
    () =>
      apiClient.warehouse.getPurchaseNeeds({
        warehouse: warehouseUid ?? undefined,
        state: needsState ?? undefined,
        all: needsAll,
        limit: 300,
      }),
    [company, locale, warehouseUid, needsState, needsAll],
    ready && tab === 'needs',
  );

  /**
   * Отчёты. Грузятся только на своей вкладке и только выбранный вид: каждый
   * отчёт — это обход остатков или журнала целиком.
   */
  const [reportKind, setReportKind] = useState<WarehouseReportKind>('stock');
  const [reportFrom, setReportFrom] = useState('');
  const [reportTo, setReportTo] = useState('');
  const setReportPeriod = useCallback((from: string, to: string) => {
    setReportFrom(from);
    setReportTo(to);
  }, []);

  const [report, reloadReport] = useAsync(
    () =>
      apiClient.warehouse.getReport({
        kind: reportKind,
        warehouse: warehouseUid ?? undefined,
        from: reportFrom || undefined,
        to: reportTo || undefined,
        // На экран — первые пятьсот строк: отчёт смотрят, чтобы убедиться, что
        // выгружается то самое. Целиком он уходит в файл.
        limit: 500,
      }),
    [company, locale, warehouseUid, reportKind, reportFrom, reportTo],
    ready && tab === 'reports',
  );

  const [downloading, setDownloading] = useState<ReportFormat | null>(null);
  const [downloadError, setDownloadError] = useState<ApiError | null>(null);

  const downloadReport = useCallback(
    async (format: ReportFormat) => {
      setDownloading(format);
      setDownloadError(null);
      try {
        const { blob, filename } = await apiClient.warehouse.downloadReport({
          kind: reportKind,
          format,
          warehouse: warehouseUid ?? undefined,
          from: reportFrom || undefined,
          to: reportTo || undefined,
        });
        // Ссылку создаём и тут же отзываем: без отзыва файл висит в памяти
        // вкладки до её закрытия, а отчётов за смену скачивают десяток.
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      } catch (e) {
        setDownloadError(toApiError(e));
      } finally {
        setDownloading(null);
      }
    },
    [reportKind, warehouseUid, reportFrom, reportTo],
  );

  /**
   * Открытый лист. Грузится по uid, а не берётся из списка: список даёт только
   * счётчики, а у полки нужны строки. Уходя с вкладки, лист закрываем — иначе
   * он открылся бы снова при возврате, уже устаревший.
   */
  const [sheetUid, setSheetUid] = useState<string | null>(null);
  const [sheet, reloadSheet] = useAsync(
    () => apiClient.warehouse.getSheet(sheetUid!),
    [company, locale, sheetUid],
    ready && sheetUid !== null,
  );
  useEffect(() => {
    if (tab !== 'inventory') setSheetUid(null);
  }, [tab]);
  // Компанию переключили — лист принадлежит прежней книге.
  useEffect(() => {
    setSheetUid(null);
  }, [company]);

  // Справочники формы. Форма стоит в панели постоянно, поэтому грузим их вместе
  // с экраном, а не по нажатию: список номенклатуры нужен уже первому полю.
  // Справочники формы операции перечитываются по требованию: экран
  // «Справочники» правит номенклатуру и ячейки, и подбор в форме обязан
  // увидеть это сразу, а не после перезагрузки страницы.
  const [refs, reloadRefs] = useAsync(() => apiClient.warehouse.getRefs(), [company, locale], ready);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<ApiError | null>(null);
  const clearSaveError = useCallback(() => setSaveError(null), []);
  const [lastSaved, setLastSaved] = useState<{
    uid: string;
    kind: string;
    qty: string;
    itemCode: string;
  } | null>(null);

  const [reversing, setReversing] = useState<string | null>(null);
  const [reverseError, setReverseError] = useState<ApiError | null>(null);

  // Компанию переключили — склады и номенклатура в форме уже чужие, а прошлая
  // ошибка относилась к другой книге.
  useEffect(() => {
    setSaveError(null);
    setReverseError(null);
    setLastSaved(null);
  }, [company]);

  /**
   * Ключ идемпотентности живёт от одного записанного движения до следующего.
   * Общая обвязка клиента шлёт новый ключ на каждый запрос, поэтому двойное
   * нажатие «Записать» завело бы два прихода; со стабильным ключом сервер
   * вернёт тот же. А удалить лишний приход потом нельзя — журнал движений
   * только пополняется.
   */
  const newKey = () => `wh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const idempotencyKey = React.useRef(newKey());

  const save = useCallback(
    async (input: WarehouseMoveInput): Promise<string | null> => {
      if (saving) return null;
      setSaving(true);
      setSaveError(null);
      try {
        const { data } = await apiClient.warehouse.createMove(input, idempotencyKey.current);
        // Движение записано — следующему нужен свой ключ, иначе сервер отдаст на
        // него же это самое движение.
        idempotencyKey.current = newKey();
        setLastSaved({
          uid: data.uid,
          kind: data.operationType,
          qty: data.qty,
          itemCode: data.itemCode,
        });
        reloadStock();
        reloadSummary();
        if (traceUid) reloadTrace();
        if (serialNumber) reloadSerialTrace();
        // Журнал открыт — записанное движение должно появиться в нём сразу,
        // иначе список выглядит так, будто запись не прошла.
        if (tab === 'moves') reloadMoves();
        return data.uid;
      } catch (e) {
        setSaveError(toApiError(e));
        return null;
      } finally {
        setSaving(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [saving, traceUid, serialNumber, tab],
  );

  const reverseMove = useCallback(
    async (uid: string, comment?: string) => {
      if (reversing) return;
      setReversing(uid);
      setReverseError(null);
      try {
        await apiClient.warehouse.reverseMove(uid, comment);
      } catch (e) {
        setReverseError(toApiError(e));
      } finally {
        setReversing(null);
        // Перечитываем в любом исходе: на успехе изменился остаток, на отказе
        // движение уже отменил кто-то другой — и путь партии это покажет.
        reloadStock();
        reloadSummary();
        if (traceUid) reloadTrace();
        if (serialNumber) reloadSerialTrace();
        if (tab === 'moves') reloadMoves();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [reversing, traceUid, serialNumber, tab],
  );

  const [reserving, setReserving] = useState(false);
  const [reserveError, setReserveError] = useState<ApiError | null>(null);
  const clearReserveError = useCallback(() => setReserveError(null), []);
  const [releasing, setReleasing] = useState<string | null>(null);

  useEffect(() => {
    setReserveError(null);
  }, [company]);

  /**
   * Постановка и снятие резерва меняют доступное в остатке — значит перечитать
   * надо и остатки со сводкой, а не только список резервов. Экран, где резерв
   * уже стоит, а доступное прежнее, кладовщик читает как «не сохранилось».
   */
  const refreshAfterReserve = useCallback(() => {
    reloadReservations();
    reloadStock();
    reloadSummary();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reserve = useCallback(
    async (input: WarehouseReservationInput): Promise<string | null> => {
      if (reserving) return null;
      setReserving(true);
      setReserveError(null);
      try {
        const { data } = await apiClient.warehouse.createReservation(input);
        refreshAfterReserve();
        return data.uid;
      } catch (e) {
        setReserveError(toApiError(e));
        return null;
      } finally {
        setReserving(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [reserving],
  );

  const releaseReservation = useCallback(
    async (uid: string) => {
      if (releasing) return;
      setReleasing(uid);
      setReserveError(null);
      try {
        await apiClient.warehouse.releaseReservation(uid);
      } catch (e) {
        setReserveError(toApiError(e));
      } finally {
        setReleasing(null);
        // Перечитываем в любом исходе: на отказе резерв мог снять кто-то другой.
        refreshAfterReserve();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [releasing],
  );

  const [sheetBusy, setSheetBusy] = useState<string | null>(null);
  const [sheetError, setSheetError] = useState<ApiError | null>(null);
  const clearSheetError = useCallback(() => setSheetError(null), []);
  useEffect(() => {
    setSheetError(null);
  }, [company]);

  /**
   * Одна обвязка на все действия по листу: у каждого из них один и тот же
   * порядок — занять кнопку, снять прошлую ошибку, перечитать в любом исходе.
   * На отказе перечитать важнее, чем на успехе: лист мог утвердить кто-то
   * другой, и экран с прежним состоянием предлагал бы сделать это снова.
   *
   * Что перечитывать, решает сам вызов: подсчёт строки остатка не меняет, а
   * утверждение меняет и остаток, и сводку.
   */
  const sheetAction = useCallback(
    async <T,>(
      busy: string,
      run: () => Promise<T>,
      after: { stock?: boolean } = {},
    ): Promise<T | null> => {
      setSheetBusy(busy);
      setSheetError(null);
      try {
        return await run();
      } catch (e) {
        setSheetError(toApiError(e));
        return null;
      } finally {
        setSheetBusy(null);
        reloadSheets();
        if (sheetUid) reloadSheet();
        if (after.stock) {
          reloadStock();
          reloadSummary();
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sheetUid],
  );

  const createSheet = useCallback(
    async (input: InventorySheetInput): Promise<string | null> => {
      const res = await sheetAction('create', () => apiClient.warehouse.createSheet(input));
      // Созданный лист сразу открываем: за ним сюда и пришли.
      if (res) setSheetUid(res.data.uid);
      return res?.data.uid ?? null;
    },
    [sheetAction],
  );

  const countLine = useCallback(
    async (lineUid: string, qty: string, comment?: string): Promise<boolean> => {
      const res = await sheetAction(`count:${lineUid}`, () =>
        apiClient.warehouse.countLine(lineUid, qty, comment),
      );
      return res !== null;
    },
    [sheetAction],
  );

  const finishSheet = useCallback(
    async (uid: string) => {
      await sheetAction('finish', () => apiClient.warehouse.finishSheet(uid));
    },
    [sheetAction],
  );

  const approveSheet = useCallback(
    async (uid: string) => {
      await sheetAction('approve', () => apiClient.warehouse.approveSheet(uid), { stock: true });
    },
    [sheetAction],
  );

  const cancelSheet = useCallback(
    async (uid: string) => {
      await sheetAction('cancel', () => apiClient.warehouse.cancelSheet(uid));
    },
    [sheetAction],
  );

  /* ---------------- Сканер и этикетки (ТЗ 5.9) ---------------- */

  const [scanHit, setScanHit] = useState<WarehouseScanHit | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<ApiError | null>(null);

  const clearScan = useCallback(() => {
    setScanHit(null);
    setScanError(null);
  }, []);

  /**
   * Сканирование ведёт к объекту, а не только показывает карточку: человек
   * подносит сканер к трубе, чтобы её увидеть, и лишнее нажатие после каждого
   * пикания — это лишнее нажатие на каждой трубе.
   */
  const scan = useCallback(async (code: string) => {
    const value = code.trim();
    if (!value) return;
    setScanning(true);
    setScanError(null);
    try {
      const { data } = await apiClient.warehouse.scanCode(value);
      setScanHit(data);
      if (data.kind === 'batch') {
        setSerialNumber(null);
        setTraceUid(data.uid);
      } else if (data.kind === 'serial') {
        setTraceUid(null);
        setSerialNumber(data.number);
      } else if (data.kind === 'item') {
        setTab('stock');
        setSearch(data.code);
      } else {
        // Ячейку в остатках не ищут: поиск идёт по позиции, партии и номеру.
        // Показать её карточку — всё, что тут честно можно сделать.
        setTab('stock');
      }
    } catch (e) {
      setScanHit(null);
      setScanError(toApiError(e));
    } finally {
      setScanning(false);
    }
  }, []);

  const [labelKeys, setLabelKeys] = useState<string[]>([]);
  const [labelKind, setLabelKind] = useState<CodeKind>('batch');
  const [labelSheet, setLabelSheet] = useState<WarehouseLabelSheet | null>(null);
  const [labelBusy, setLabelBusy] = useState(false);
  const [labelError, setLabelError] = useState<ApiError | null>(null);

  const toggleLabelKey = useCallback((key: string) => {
    setLabelKeys((keys) => (keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key]));
  }, []);
  const clearLabelKeys = useCallback(() => setLabelKeys([]), []);
  const clearLabelSheet = useCallback(() => {
    setLabelSheet(null);
    setLabelError(null);
  }, []);

  // Отметки живут в пределах одной выборки: строка ушла из фильтра, а её код
  // остался бы в печати — человек получил бы этикетку на то, чего не видит.
  useEffect(() => {
    setLabelKeys([]);
  }, [company, warehouseUid, debounced, criticalOnly]);

  const [labelTemplates] = useAsync(
    () => apiClient.warehouse.getLabelTemplates(),
    [company, locale],
    ready,
  );

  const buildLabels = useCallback(
    async (templateUid: string, copies: number, codes: string[]) => {
      setLabelBusy(true);
      setLabelError(null);
      try {
        const { data } = await apiClient.warehouse.buildLabels({ templateUid, codes, copies });
        setLabelSheet(data);
      } catch (e) {
        setLabelSheet(null);
        setLabelError(toApiError(e));
      } finally {
        setLabelBusy(false);
      }
    },
    [],
  );

  const value = useMemo<WarehouseContextValue>(
    () => ({
      period,
      setPeriod,
      summary,
      search,
      setSearch,
      warehouseUid,
      setWarehouseUid,
      criticalOnly,
      setCriticalOnly,
      stock,
      reloadStock,
      traceUid,
      setTraceUid,
      trace,
      serialNumber,
      setSerialNumber,
      serialTrace,
      tab,
      setTab,
      moves,
      movesFilters,
      setMovesFilter,
      resetMovesFilters,
      movesPage,
      setMovesPage,
      reloadMoves,
      reservations,
      reloadReservations,
      reserve,
      reserving,
      reserveError,
      clearReserveError,
      releaseReservation,
      releasing,
      sheets,
      reloadSheets,
      sheetStatus,
      setSheetStatus,
      sheetUid,
      setSheetUid,
      sheet,
      reloadSheet,
      createSheet,
      countLine,
      finishSheet,
      approveSheet,
      cancelSheet,
      sheetBusy,
      sheetError,
      clearSheetError,
      reportKind,
      setReportKind,
      reportFrom,
      reportTo,
      setReportPeriod,
      report,
      reloadReport,
      downloadReport,
      downloading,
      downloadError,
      needs,
      reloadNeeds,
      needsState,
      setNeedsState,
      needsAll,
      setNeedsAll,
      refs,
      reloadRefs,
      save,
      saving,
      saveError,
      clearSaveError,
      lastSaved,
      reverseMove,
      reversing,
      reverseError,
      scan,
      scanHit,
      scanning,
      scanError,
      clearScan,
      labelKeys,
      toggleLabelKey,
      clearLabelKeys,
      labelKind,
      setLabelKind,
      labelTemplates,
      labelSheet,
      buildLabels,
      labelBusy,
      labelError,
      clearLabelSheet,
    }),
    [
      period,
      summary,
      search,
      warehouseUid,
      criticalOnly,
      stock,
      traceUid,
      trace,
      serialNumber,
      serialTrace,
      tab,
      moves,
      movesFilters,
      setMovesFilter,
      resetMovesFilters,
      movesPage,
      reservations,
      reserve,
      reserving,
      reserveError,
      clearReserveError,
      releaseReservation,
      releasing,
      sheets,
      sheetStatus,
      sheetUid,
      sheet,
      createSheet,
      countLine,
      finishSheet,
      approveSheet,
      cancelSheet,
      sheetBusy,
      sheetError,
      clearSheetError,
      reportKind,
      reportFrom,
      reportTo,
      setReportPeriod,
      report,
      downloadReport,
      downloading,
      downloadError,
      needs,
      needsState,
      needsAll,
      refs,
      reloadRefs,
      save,
      saving,
      saveError,
      clearSaveError,
      lastSaved,
      reverseMove,
      reversing,
      reverseError,
      scan,
      scanHit,
      scanning,
      scanError,
      clearScan,
      labelKeys,
      toggleLabelKey,
      clearLabelKeys,
      labelKind,
      labelTemplates,
      labelSheet,
      buildLabels,
      labelBusy,
      labelError,
      clearLabelSheet,
    ],
  );

  return <WarehouseContext.Provider value={value}>{children}</WarehouseContext.Provider>;
};

export function useWarehouse(): WarehouseContextValue {
  const ctx = useContext(WarehouseContext);
  if (!ctx) throw new Error('useWarehouse вызван вне WarehouseProvider');
  return ctx;
}
