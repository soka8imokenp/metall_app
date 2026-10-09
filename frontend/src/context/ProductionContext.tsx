/**
 * Данные страницы производства.
 *
 * Провайдер монтируется вместе с разделом, а не на входе в систему: пока
 * открыт дашборд, цеховые запросы серверу не нужны.
 *
 * Выбранный заказ грузится отдельным запросом: в нём журнал событий по каждому
 * этапу, и тянуть его списком на сотню заказов незачем.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  DashboardPeriod,
  ProductionOptions,
  ProductionOrderBrief,
  ProductionOrderDetail,
  ProductionOrderInput,
  ProductionOrderRow,
  ProductionOrdersPage,
  ProductionReport,
  ProductionReportKind,
  ProductionState,
  ProductionWorkCenter,
  ProductionWorkCenterInput,
  ReportFormat,
  ProductionStatus,
  ProductionSummary,
  ProductionMaterialMoveInput,
  ProductionCalendar,
  ProductionCostState,
  ProductionDeviationKind,
  ProductionDeviations,
  ProductionDowntimeInput,
  ProductionSchedule,
  ProductionShiftInput,
  ProductionOutputInput,
  ProductionReworkInput,
  ProductionStageMark,
} from '../types/api';
import { ApiError, apiClient } from '../lib/api-client';
import { AsyncState } from './DashboardContext';
import { useApp } from './AppContext';
import { useSearchJump } from '../lib/use-search-jump';
import { useAuth } from './AuthContext';

interface ProductionContextValue {
  period: DashboardPeriod;
  setPeriod: (p: DashboardPeriod) => void;
  summary: AsyncState<ProductionSummary>;
  reloadSummary: () => void;

  state: ProductionState;
  setState: (s: ProductionState) => void;
  search: string;
  setSearch: (s: string) => void;
  orders: AsyncState<ProductionOrdersPage>;
  reloadOrders: () => void;
  /** Страница списка: смещение и сколько строк всего (Э8). */
  offset: number;
  setOffset: (n: number) => void;
  pageSize: number;

  /** Отчёты модуля (Э8): таблица с сервера и выгрузка файлом. */
  reportKind: ProductionReportKind;
  setReportKind: (k: ProductionReportKind) => void;
  reportFrom: string;
  reportTo: string;
  setReportPeriod: (from: string, to: string) => void;
  report: AsyncState<ProductionReport>;
  reloadReport: () => void;
  wantReport: () => void;
  downloadReport: (format: ReportFormat) => Promise<void>;
  downloading: ReportFormat | null;
  downloadError: ApiError | null;

  /** Справочник участков (Э8). */
  workCenters: AsyncState<ProductionWorkCenter[]>;
  wantWorkCenters: () => void;
  saveWorkCenter: (input: ProductionWorkCenterInput, code?: string) => Promise<boolean>;

  selectedUid: string | null;
  setSelectedUid: (uid: string | null) => void;
  order: AsyncState<ProductionOrderDetail>;
  reloadOrder: () => void;
  /** Этапы заказа: план работ и отметки цеха (ТЗ 4.1). */
  planStages: (uid: string) => Promise<boolean>;
  markStage: (
    uid: string,
    seq: number,
    kind: ProductionStageMark,
    input?: { reasonUid?: string; comment?: string },
  ) => Promise<boolean>;
  /** Материалы заказа: план расхода, выдача в цех, возврат и факт (ТЗ 4.1). */
  planMaterials: (uid: string) => Promise<boolean>;
  moveMaterial: (
    uid: string,
    kind: 'issue' | 'return',
    input: ProductionMaterialMoveInput,
  ) => Promise<boolean>;
  useMaterial: (uid: string, input: { itemCode: string; qty: string }) => Promise<boolean>;
  /** Записать выпуск: годное, брак, отход, полуфабрикат. */
  registerOutput: (uid: string, input: ProductionOutputInput) => Promise<boolean>;
  /** Завести переделку брака дочерним заказом. */
  reworkOrder: (uid: string, input: ProductionReworkInput) => Promise<boolean>;
  /**
   * Себестоимость заказа: расчёт со строками и история (ТЗ 4.7).
   *
   * Грузится с первого открытия вкладки: разбор по материалам нужен не
   * каждому, кто открыл карточку, а запрос этот не из дешёвых.
   */
  cost: AsyncState<ProductionCostState>;
  wantCost: () => void;
  calculateCost: (uid: string) => Promise<boolean>;

  /** Календарь завода: смены, рабочая неделя, выходные (Э7). */
  calendar: AsyncState<ProductionCalendar>;
  wantCalendar: () => void;
  setWorkWeek: (days: number[]) => Promise<boolean>;
  setCalendarDay: (day: string, isWorking: boolean, comment?: string) => Promise<boolean>;
  clearCalendarDay: (day: string) => Promise<boolean>;
  saveShift: (input: ProductionShiftInput, uid?: string) => Promise<boolean>;

  /** Журнал отклонений и запись простоя участка (Э7). */
  deviations: AsyncState<ProductionDeviations>;
  deviationKind: ProductionDeviationKind | 'all';
  setDeviationKind: (kind: ProductionDeviationKind | 'all') => void;
  wantDeviations: () => void;
  registerDowntime: (input: ProductionDowntimeInput) => Promise<boolean>;

  /** Разложить этапы заказа по сменам: вернётся план и срок по графику. */
  scheduleStages: (uid: string) => Promise<ProductionSchedule | null>;

  /** Чем наполнить форму заведения: грузится только когда её открыли. */
  options: AsyncState<ProductionOptions>;
  wantOptions: () => void;

  saveOrder: (input: ProductionOrderInput) => Promise<ProductionOrderBrief | null>;
  editOrder: (
    uid: string,
    input: Partial<ProductionOrderInput>,
  ) => Promise<ProductionOrderBrief | null>;
  changeStatus: (
    uid: string,
    status: ProductionStatus,
    comment?: string,
  ) => Promise<ProductionOrderBrief | null>;

  saving: boolean;
  saveError: ApiError | null;
  clearSaveError: () => void;
  /** Что получилось в последний раз: номер заказа и человеческая приписка. */
  lastSaved: { number: string; note: string } | null;
}

const ProductionContext = createContext<ProductionContextValue | undefined>(undefined);

const idle = <T,>(): AsyncState<T> => ({ data: null, isLoading: false, error: null });
const toApiError = (e: unknown) =>
  e instanceof ApiError ? e : new ApiError('INTERNAL_ERROR', '', 0);

/** Запрос в состояние: та же обвязка, что и на продажах. */
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

    // Прошлые данные не стираем: при смене фильтра список не должен
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

export const ProductionProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { company, locale } = useApp();
  const { session } = useAuth();
  const ready = Boolean(session);

  const [period, setPeriod] = useState<DashboardPeriod>('30d');
  const [state, setState] = useState<ProductionState>('all');
  const [search, setSearch] = useState('');
  useSearchJump('production', setSearch);
  const [selectedUid, setSelectedUid] = useState<string | null>(null);

  // Поиск набирают посимвольно: без задержки каждый символ уходил бы запросом.
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const [summary, reloadSummary] = useAsync(
    () => apiClient.production.getSummary(period),
    [company, locale, period],
    ready,
  );

  // Страница списка. Сбрасывается на первую при смене фильтра и поиска:
  // иначе человек меняет фильтр и видит пустоту, потому что остался на
  // четвёртой странице того, чего больше нет.
  // Двадцать пять строк на страницу: в список высотой с экран больше не
  // влезает, а листать его быстрее, чем крутить сотню.
  const pageSize = 25;
  const [offset, setOffset] = useState(0);
  useEffect(() => setOffset(0), [state, debounced, company]);

  const [orders, reloadOrders] = useAsync(
    () => apiClient.production.getOrders(state, debounced, pageSize, offset),
    [company, locale, state, debounced, offset],
    ready,
  );

  const [order, reloadOrder] = useAsync(
    () => apiClient.production.getOrder(selectedUid!),
    [company, locale, selectedUid],
    ready && selectedUid !== null,
  );

  // Справочники формы не нужны тому, кто пришёл посмотреть сводку: запрос
  // уходит с первого открытия формы и дальше живёт до смены компании.
  const [optionsWanted, setOptionsWanted] = useState(false);
  const [options] = useAsync(
    () => apiClient.production.getOptions(),
    [company, locale],
    ready && optionsWanted,
  );
  const wantOptions = useCallback(() => setOptionsWanted(true), []);

  // Себестоимость — своя вкладка в карточке, и до её открытия расчёт не
  // запрашиваем. Ключ тот же, что у карточки: открыли другой заказ — пришёл
  // его расчёт, а не прошлый.
  const [costWanted, setCostWanted] = useState(false);
  const [cost, reloadCost] = useAsync(
    () => apiClient.production.getCost(selectedUid!),
    [company, locale, selectedUid],
    ready && costWanted && selectedUid !== null,
  );
  const wantCost = useCallback(() => setCostWanted(true), []);

  // Календарь и журнал отклонений живут на своих разделах экрана: до их
  // открытия запросы не уходят — на сводке они не нужны никому.
  const [calendarWanted, setCalendarWanted] = useState(false);
  const [calendar, reloadCalendar] = useAsync(
    () => apiClient.production.getCalendar(),
    [company, locale],
    ready && calendarWanted,
  );
  const wantCalendar = useCallback(() => setCalendarWanted(true), []);

  const [deviationsWanted, setDeviationsWanted] = useState(false);
  const [deviationKind, setDeviationKind] = useState<ProductionDeviationKind | 'all'>('all');
  const [deviations, reloadDeviations] = useAsync(
    () =>
      apiClient.production.getDeviations(
        period,
        deviationKind === 'all' ? undefined : deviationKind,
      ),
    [company, locale, period, deviationKind],
    ready && deviationsWanted,
  );
  const wantDeviations = useCallback(() => setDeviationsWanted(true), []);

  // Отчёты модуля: запрос уходит с первого открытия раздела.
  const [reportWanted, setReportWanted] = useState(false);
  const [reportKind, setReportKind] = useState<ProductionReportKind>('orders');
  const [reportFrom, setReportFrom] = useState('');
  const [reportTo, setReportTo] = useState('');
  const [report, reloadReport] = useAsync(
    () =>
      apiClient.production.getReport({
        kind: reportKind,
        from: reportFrom || undefined,
        to: reportTo || undefined,
      }),
    [company, locale, reportKind, reportFrom, reportTo],
    ready && reportWanted,
  );
  const wantReport = useCallback(() => setReportWanted(true), []);
  const setReportPeriod = useCallback((from: string, to: string) => {
    setReportFrom(from);
    setReportTo(to);
  }, []);

  const [downloading, setDownloading] = useState<ReportFormat | null>(null);
  const [downloadError, setDownloadError] = useState<ApiError | null>(null);
  const downloadReport = useCallback(
    async (format: ReportFormat) => {
      if (downloading) return;
      setDownloading(format);
      setDownloadError(null);
      try {
        await apiClient.production.downloadReport({
          kind: reportKind,
          format,
          from: reportFrom || undefined,
          to: reportTo || undefined,
        });
      } catch (e) {
        setDownloadError(toApiError(e));
      } finally {
        setDownloading(null);
      }
    },
    [downloading, reportKind, reportFrom, reportTo],
  );

  const [centersWanted, setCentersWanted] = useState(false);
  const [workCenters, reloadWorkCenters] = useAsync(
    () => apiClient.production.getWorkCenters(),
    [company, locale],
    ready && centersWanted,
  );
  const wantWorkCenters = useCallback(() => setCentersWanted(true), []);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<ApiError | null>(null);
  const [lastSaved, setLastSaved] = useState<{ number: string; note: string } | null>(null);

  /**
   * Одна обвязка на три действия: заведение, правку и переход.
   *
   * После записи перечитываем список, сводку и открытую карточку. Ключ запроса
   * карточки при переходе не меняется — сама она не обновится, а статус виден
   * именно в ней.
   */
  const run = useCallback(
    async (
      call: () => Promise<{ data: ProductionOrderBrief }>,
      note: (brief: ProductionOrderBrief) => string,
    ) => {
      if (saving) return null;
      setSaving(true);
      setSaveError(null);
      try {
        const { data } = await call();
        setLastSaved({ number: data.number, note: note(data) });
        reloadOrders();
        reloadSummary();
        reloadOrder();
        return data;
      } catch (e) {
        setSaveError(toApiError(e));
        return null;
      } finally {
        setSaving(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [saving],
  );

  const saveOrder = useCallback(
    (input: ProductionOrderInput) =>
      run(
        () => apiClient.production.createOrder(input),
        () => (locale === 'uz' ? 'buyurtma qoralama sifatida kiritildi' : 'заказ заведён черновиком'),
      ),
    [run, locale],
  );

  const editOrder = useCallback(
    (uid: string, input: Partial<ProductionOrderInput>) =>
      run(
        () => apiClient.production.updateOrder(uid, input),
        () => (locale === 'uz' ? 'tahrir yozildi' : 'правка записана'),
      ),
    [run, locale],
  );

  const changeStatus = useCallback(
    (uid: string, status: ProductionStatus, comment?: string) =>
      run(
        () => apiClient.production.setOrderStatus(uid, status, comment),
        (brief) => `${locale === 'uz' ? 'holat' : 'статус'}: ${brief.status}`,
      ),
    [run, locale],
  );

  /**
   * Действия по этапам идут мимо `run`: он подписывает «заказ» и ждёт его
   * краткую карточку, а здесь ответ — сам этап. Общее тут только одно:
   * после записи перечитываются карточка и список, иначе кнопка меняет
   * вид, а цифры остаются вчерашними.
   */
  const stageAction = useCallback(
    async (call: () => Promise<unknown>) => {
      if (saving) return false;
      setSaving(true);
      setSaveError(null);
      try {
        await call();
        reloadOrders();
        reloadSummary();
        reloadOrder();
        return true;
      } catch (e) {
        setSaveError(toApiError(e));
        return false;
      } finally {
        setSaving(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [saving],
  );

  const planStages = useCallback(
    (uid: string) => stageAction(() => apiClient.production.planStagesFromCard(uid)),
    [stageAction],
  );

  const markStage = useCallback(
    (
      uid: string,
      seq: number,
      kind: ProductionStageMark,
      input: { reasonUid?: string; comment?: string } = {},
    ) => stageAction(() => apiClient.production.markStage(uid, seq, kind, input)),
    [stageAction],
  );

  const planMaterials = useCallback(
    (uid: string) => stageAction(() => apiClient.production.planMaterialsFromCard(uid)),
    [stageAction],
  );

  const moveMaterial = useCallback(
    (uid: string, kind: 'issue' | 'return', input: ProductionMaterialMoveInput) =>
      stageAction(() =>
        kind === 'issue'
          ? apiClient.production.issueMaterial(uid, input)
          : apiClient.production.returnMaterial(uid, input),
      ),
    [stageAction],
  );

  const useMaterial = useCallback(
    (uid: string, input: { itemCode: string; qty: string }) =>
      stageAction(() => apiClient.production.useMaterial(uid, input)),
    [stageAction],
  );

  const registerOutput = useCallback(
    (uid: string, input: ProductionOutputInput) =>
      stageAction(() => apiClient.production.registerOutput(uid, input)),
    [stageAction],
  );

  const reworkOrder = useCallback(
    (uid: string, input: ProductionReworkInput) =>
      stageAction(() => apiClient.production.reworkOrder(uid, input)),
    [stageAction],
  );

  /**
   * Пересчёт: после записи перечитываем и сам расчёт — иначе на экране
   * останется прошлая цифра, а в истории уже другая.
   */
  const calculateCost = useCallback(
    (uid: string) =>
      stageAction(async () => {
        await apiClient.production.calculateCost(uid);
        reloadCost();
      }),
    [stageAction, reloadCost],
  );

  /**
   * Правка календаря отвечает самим календарём: ответ службы кладём в состояние
   * без второго запроса — иначе на экране секунду живут прошлые смены.
   */
  const calendarAction = useCallback(
    async (call: () => Promise<{ data: ProductionCalendar }>) => {
      if (saving) return false;
      setSaving(true);
      setSaveError(null);
      try {
        await call();
        reloadCalendar();
        reloadSummary();
        return true;
      } catch (e) {
        setSaveError(toApiError(e));
        return false;
      } finally {
        setSaving(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [saving, reloadCalendar],
  );

  const setWorkWeek = useCallback(
    (days: number[]) => calendarAction(() => apiClient.production.setWorkWeek(days)),
    [calendarAction],
  );

  const setCalendarDay = useCallback(
    (day: string, isWorking: boolean, comment?: string) =>
      calendarAction(() => apiClient.production.setCalendarDay(day, isWorking, comment)),
    [calendarAction],
  );

  const clearCalendarDay = useCallback(
    (day: string) => calendarAction(() => apiClient.production.clearCalendarDay(day)),
    [calendarAction],
  );

  const saveShift = useCallback(
    (input: ProductionShiftInput, uid?: string) =>
      calendarAction(() => apiClient.production.saveShift(input, uid)),
    [calendarAction],
  );

  const registerDowntime = useCallback(
    (input: ProductionDowntimeInput) =>
      stageAction(async () => {
        await apiClient.production.registerDowntime(input);
        reloadDeviations();
      }),
    [stageAction, reloadDeviations],
  );

  /** Раскладка возвращает план, и экран показывает, успевает ли заказ. */
  const scheduleStages = useCallback(
    async (uid: string) => {
      if (saving) return null;
      setSaving(true);
      setSaveError(null);
      try {
        const { data } = await apiClient.production.scheduleStages(uid);
        reloadOrder();
        return data;
      } catch (e) {
        setSaveError(toApiError(e));
        return null;
      } finally {
        setSaving(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [saving],
  );

  const saveWorkCenter = useCallback(
    async (input: ProductionWorkCenterInput, code?: string) => {
      if (saving) return false;
      setSaving(true);
      setSaveError(null);
      try {
        await apiClient.production.saveWorkCenter(input, code);
        reloadWorkCenters();
        reloadSummary();
        return true;
      } catch (e) {
        setSaveError(toApiError(e));
        return false;
      } finally {
        setSaving(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [saving, reloadWorkCenters],
  );

  const clearSaveError = useCallback(() => setSaveError(null), []);

  const value = useMemo<ProductionContextValue>(
    () => ({
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
      reportKind,
      setReportKind,
      reportFrom,
      reportTo,
      setReportPeriod,
      report,
      reloadReport,
      wantReport,
      downloadReport,
      downloading,
      downloadError,
      workCenters,
      wantWorkCenters,
      saveWorkCenter,
      selectedUid,
      setSelectedUid,
      order,
      reloadOrder,
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
      calendar,
      wantCalendar,
      setWorkWeek,
      setCalendarDay,
      clearCalendarDay,
      saveShift,
      deviations,
      deviationKind,
      setDeviationKind,
      wantDeviations,
      registerDowntime,
      scheduleStages,
      options,
      wantOptions,
      saveOrder,
      editOrder,
      changeStatus,
      saving,
      saveError,
      clearSaveError,
      lastSaved,
    }),
    [
      period,
      summary,
      state,
      search,
      orders,
      offset,
      reportKind,
      reportFrom,
      reportTo,
      report,
      downloadReport,
      downloading,
      downloadError,
      workCenters,
      saveWorkCenter,
      selectedUid,
      order,
      options,
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
      calendar,
      wantCalendar,
      setWorkWeek,
      setCalendarDay,
      clearCalendarDay,
      saveShift,
      deviations,
      deviationKind,
      wantDeviations,
      registerDowntime,
      scheduleStages,
      saveOrder,
      editOrder,
      changeStatus,
      saving,
      saveError,
      lastSaved,
    ],
  );

  return <ProductionContext.Provider value={value}>{children}</ProductionContext.Provider>;
};

export function useProduction(): ProductionContextValue {
  const ctx = useContext(ProductionContext);
  if (!ctx) throw new Error('useProduction вызван вне ProductionProvider');
  return ctx;
}
