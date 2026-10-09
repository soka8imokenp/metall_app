/**
 * Данные страницы финансов.
 *
 * Провайдер монтируется вместе с разделом: пока открыт дашборд, ни остатки
 * счетов, ни журнал операций серверу не нужны.
 *
 * Фильтры журнала живут здесь, а не в экране, потому что каждый из них —
 * запрос. Поиск с задержкой: номер операции набирают посимвольно.
 *
 * Дебиторка и план-факт грузятся только при заходе на свою вкладку: это два
 * отдельных запроса, и тянуть их ради шапки незачем. Счётчики вкладок поэтому
 * появляются не сразу — место под них на экране занято заранее.
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  DashboardPeriod,
  FinanceAction,
  FinanceCreateInput,
  FinanceOperationCard,
  FinancePatchInput,
  FinanceRefs,
  FinanceOperationRow,
  FinanceOperationType,
  FinanceBudgetRefs,
  FinancePlanFact,
  FinanceReceivables,
  FinanceReport,
  FinanceReportKind,
  FinanceMarginBreakdown,
  ReportFormat,
  FinanceStatus,
  FinanceSummary,
} from '../types/api';
import { ApiError, apiClient } from '../lib/api-client';
import { AsyncState } from './DashboardContext';
import { useApp } from './AppContext';
import { useAuth } from './AuthContext';

export type FinanceSection = 'operations' | 'receivables' | 'planfact' | 'reports';

interface FinanceContextValue {
  period: DashboardPeriod;
  setPeriod: (p: DashboardPeriod) => void;
  summary: AsyncState<FinanceSummary>;
  reloadSummary: () => void;

  section: FinanceSection;
  setSection: (s: FinanceSection) => void;

  status: FinanceStatus | null;
  setStatus: (s: FinanceStatus | null) => void;
  type: FinanceOperationType | null;
  setType: (t: FinanceOperationType | null) => void;
  search: string;
  setSearch: (s: string) => void;
  operations: AsyncState<{ rows: FinanceOperationRow[] }>;
  reloadOperations: () => void;

  overdueOnly: boolean;
  setOverdueOnly: (v: boolean) => void;
  receivables: AsyncState<FinanceReceivables>;

  /**
   * Отчёты (ТЗ 6.9). Вид, период и разрез живут здесь, а не в экране: каждый
   * из них — запрос. Выгрузка ничего не возвращает и только сообщает об
   * отказе: файл сохраняет браузер.
   */
  reportKind: FinanceReportKind;
  setReportKind: (k: FinanceReportKind) => void;
  reportFrom: string;
  reportTo: string;
  setReportPeriod: (from: string, to: string) => void;
  marginBy: FinanceMarginBreakdown;
  setMarginBy: (by: FinanceMarginBreakdown) => void;
  report: AsyncState<FinanceReport>;
  reloadReport: () => void;
  downloadReport: (format: ReportFormat) => Promise<void>;
  downloading: ReportFormat | null;
  downloadError: ApiError | null;

  planFact: AsyncState<FinancePlanFact>;
  /** Перечитать план-факт: после правки бюджета строки должны обновиться. */
  reloadPlanFact: () => void;
  /** Справочники формы бюджета. Грузятся вместе с разделом «План-факт». */
  budgetRefs: AsyncState<FinanceBudgetRefs>;

  selectedUid: string | null;
  setSelectedUid: (uid: string | null) => void;
  operation: AsyncState<FinanceOperationCard>;

  /** Действие над выбранной операцией. Версия берётся из её же карточки. */
  act: (action: FinanceAction, comment?: string) => Promise<void>;
  /** Какое действие сейчас выполняется: кнопки на это время заперты. */
  acting: FinanceBusy | null;
  actionError: ApiError | null;
  clearActionError: () => void;

  /** Сторно проведённой операции: отдельная операция с обратной проводкой. */
  reverse: (comment?: string) => Promise<void>;

  /**
   * Форма операции. `null` — правая панель показывает карточку; `create` —
   * заведение новой; `edit` — правка черновика, который сейчас выбран.
   */
  form: FinanceFormMode;
  openForm: (mode: Exclude<FinanceFormMode, null>) => void;
  closeForm: () => void;
  /** Справочники формы. Грузятся при первом её открытии, а не с разделом. */
  refs: AsyncState<FinanceRefs>;
  /** Сохранение формы. Возвращает uid, чтобы экран выбрал созданную операцию. */
  save: (input: FinanceCreateInput | FinancePatchInput) => Promise<string | null>;
  saving: boolean;
  saveError: ApiError | null;
}

/** Действия, на время которых кнопки заперты. Сторно — не переход по статусу. */
export type FinanceBusy = FinanceAction | 'reverse';

export type FinanceFormMode = { mode: 'create' } | { mode: 'edit'; uid: string } | null;

/** Заведение: режим по умолчанию, когда форма стоит в панели сама по себе. */
const CREATE: Exclude<FinanceFormMode, null> = { mode: 'create' };

const FinanceContext = createContext<FinanceContextValue | undefined>(undefined);

const idle = <T,>(): AsyncState<T> => ({ data: null, isLoading: false, error: null });
const toApiError = (e: unknown) =>
  e instanceof ApiError ? e : new ApiError('INTERNAL_ERROR', '', 0);

/** Запрос в состояние: та же обвязка, что на продажах, складе и производстве. */
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

export const FinanceProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { company, locale } = useApp();
  const { session } = useAuth();
  const ready = Boolean(session);

  const [period, setPeriod] = useState<DashboardPeriod>('30d');
  const [section, setSection] = useState<FinanceSection>('operations');
  const [status, setStatus] = useState<FinanceStatus | null>(null);
  const [type, setType] = useState<FinanceOperationType | null>(null);
  const [search, setSearch] = useState('');
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [selectedUid, setSelectedUid] = useState<string | null>(null);

  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Компанию переключили — выбранная операция могла остаться в той, которой
  // больше не видно. Снимаем выбор, иначе панель покажет ошибку доступа.
  useEffect(() => {
    setSelectedUid(null);
  }, [company]);

  const [summary, reloadSummary] = useAsync(
    () => apiClient.finance.getSummary(period),
    [company, locale, period],
    ready,
  );

  const [operations, reloadOperations] = useAsync(
    () => apiClient.finance.getOperations({ status, type, search: debounced, limit: 100 }),
    [company, locale, status, type, debounced],
    ready,
  );

  const [receivables] = useAsync(
    () => apiClient.finance.getReceivables({ overdueOnly, limit: 100 }),
    [company, locale, overdueOnly],
    ready && section === 'receivables',
  );

  const [planFact, reloadPlanFact] = useAsync(
    () => apiClient.finance.getPlanFact(),
    [company, locale],
    ready && section === 'planfact',
  );

  const [budgetRefs] = useAsync(
    () => apiClient.finance.getBudgetRefs(),
    [company, locale],
    ready && section === 'planfact',
  );

  /**
   * Отчёты (ТЗ 6.9). Как и соседние вкладки, грузятся только на своей: это
   * отдельный запрос, и тянуть его ради шапки незачем.
   *
   * Период пуст по умолчанию — сервер сам возьмёт последние девяносто дней.
   * Проставлять их здесь значило бы завести второе определение «периода по
   * умолчанию», и однажды оно разошлось бы с серверным.
   */
  const [reportKind, setReportKind] = useState<FinanceReportKind>('cashflow');
  const [reportFrom, setReportFrom] = useState('');
  const [reportTo, setReportTo] = useState('');
  const [marginBy, setMarginBy] = useState<FinanceMarginBreakdown>('order');
  const setReportPeriod = useCallback((from: string, to: string) => {
    setReportFrom(from);
    setReportTo(to);
  }, []);

  const [report, reloadReport] = useAsync(
    () =>
      apiClient.finance.getReport({
        kind: reportKind,
        from: reportFrom || undefined,
        to: reportTo || undefined,
        by: reportKind === 'margin' ? marginBy : undefined,
        limit: 500,
      }),
    [company, locale, reportKind, reportFrom, reportTo, marginBy],
    ready && section === 'reports',
  );

  const [downloading, setDownloading] = useState<ReportFormat | null>(null);
  const [downloadError, setDownloadError] = useState<ApiError | null>(null);

  const downloadReport = useCallback(
    async (format: ReportFormat) => {
      setDownloading(format);
      setDownloadError(null);
      try {
        const { blob, filename } = await apiClient.finance.downloadReport({
          kind: reportKind,
          format,
          from: reportFrom || undefined,
          to: reportTo || undefined,
          by: reportKind === 'margin' ? marginBy : undefined,
        });
        // Ссылку создаём и тут же отзываем: без отзыва файл висит в памяти
        // вкладки до её закрытия, а отчётов за день скачивают десяток.
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
    [reportKind, reportFrom, reportTo, marginBy],
  );

  const [operation, reloadOperation] = useAsync(
    () => apiClient.finance.getOperation(selectedUid!),
    [company, locale, selectedUid],
    ready && selectedUid !== null,
  );

  const [acting, setActing] = useState<FinanceBusy | null>(null);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const clearActionError = useCallback(() => setActionError(null), []);

  const [form, setForm] = useState<FinanceFormMode>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<ApiError | null>(null);

  // Выбрали другую операцию — прошлая ошибка к ней отношения не имеет.
  useEffect(() => {
    setActionError(null);
  }, [selectedUid]);

  // Компанию переключили — счета и статьи в форме уже чужие, держать её открытой
  // значит предлагать сохранить операцию со справочником не той книги.
  useEffect(() => {
    setForm(null);
    setSaveError(null);
  }, [company]);

  /**
   * Справочники нужны форме — а форма теперь стоит в правой панели и когда
   * ничего не выбрано: отдельной кнопки «Новая операция» на экране нет. Поэтому
   * грузим их и в состоянии покоя, но не грузим, пока человек читает карточку
   * операции: там ни счетов, ни статей не выбирают.
   */
  const [refs] = useAsync(
    () => apiClient.finance.getRefs(),
    [company, locale],
    ready && (form !== null || selectedUid === null),
  );

  const act = useCallback(
    async (action: FinanceAction, comment?: string) => {
      const op = operation.data?.operation;
      if (!op || acting) return;

      setActing(action);
      setActionError(null);
      try {
        await apiClient.finance.act(op.uid, action, op.version, comment);
      } catch (e) {
        setActionError(toApiError(e));
      } finally {
        setActing(null);
        // Перечитываем в любом исходе. На успехе меняются статус, версия и
        // проводки; на 409 карточка как раз и устарела — показать старую
        // версию рядом с «операцию уже изменили» было бы издевательством.
        reloadOperation();
        reloadOperations();
        reloadSummary();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [operation.data, acting],
  );

  const reverse = useCallback(
    async (comment?: string) => {
      const op = operation.data?.operation;
      if (!op || acting) return;

      setActing('reverse');
      setActionError(null);
      try {
        const { data } = await apiClient.finance.reverse(op.uid, op.version, comment);
        // Переводим выбор на сторно: человек нажал кнопку, чтобы увидеть
        // обратную проводку, а не чтобы смотреть на закрытый оригинал.
        setSelectedUid(data.uid);
      } catch (e) {
        setActionError(toApiError(e));
      } finally {
        setActing(null);
        reloadOperation();
        reloadOperations();
        reloadSummary();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [operation.data, acting],
  );

  /**
   * Ключ идемпотентности живёт от одного заведённого документа до следующего.
   * Общая обвязка клиента шлёт новый ключ на каждый запрос, и повторное нажатие
   * «Сохранить» завело бы вторую такую же заявку; со стабильным ключом сервер
   * вернёт ту же. Ключ выдаём сразу при монтировании, потому что форма создания
   * теперь может быть открыта без `openForm` — она и есть покой правой панели.
   */
  const newKey = () =>
    `fin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const idempotencyKey = React.useRef(newKey());

  const openForm = useCallback((mode: Exclude<FinanceFormMode, null>) => {
    setSaveError(null);
    if (mode.mode === 'create') idempotencyKey.current = newKey();
    setForm(mode);
  }, []);

  const closeForm = useCallback(() => {
    setForm(null);
    setSaveError(null);
  }, []);

  const save = useCallback(
    async (input: FinanceCreateInput | FinancePatchInput): Promise<string | null> => {
      if (saving) return null;
      // Форма создания живёт в панели и без `openForm`: там `form` остаётся
      // null, а сохранять всё равно надо — и именно как создание.
      const target = form ?? CREATE;
      setSaving(true);
      setSaveError(null);
      try {
        const { data } =
          target.mode === 'create'
            ? await apiClient.finance.create(input as FinanceCreateInput, idempotencyKey.current)
            : await apiClient.finance.patch(target.uid, input as FinancePatchInput);
        // Документ заведён — следующий должен получить свой ключ, иначе сервер
        // отдаст на него же ту самую первую операцию.
        if (target.mode === 'create') idempotencyKey.current = newKey();
        setForm(null);
        setSelectedUid(data.uid);
        reloadOperations();
        reloadSummary();
        if (target.mode === 'edit') reloadOperation();
        return data.uid;
      } catch (e) {
        setSaveError(toApiError(e));
        return null;
      } finally {
        setSaving(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [form, saving],
  );

  const value = useMemo<FinanceContextValue>(
    () => ({
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
      reportKind,
      setReportKind,
      reportFrom,
      reportTo,
      setReportPeriod,
      marginBy,
      setMarginBy,
      report,
      reloadReport,
      downloadReport,
      downloading,
      downloadError,
      planFact,
      reloadPlanFact,
      budgetRefs,
      selectedUid,
      setSelectedUid,
      operation,
      act,
      acting,
      actionError,
      clearActionError,
      reverse,
      form,
      openForm,
      closeForm,
      refs,
      save,
      saving,
      saveError,
    }),
    [
      period,
      summary,
      section,
      status,
      type,
      search,
      operations,
      overdueOnly,
      receivables,
      reportKind,
      reportFrom,
      reportTo,
      setReportPeriod,
      marginBy,
      report,
      reloadReport,
      downloadReport,
      downloading,
      downloadError,
      planFact,
      reloadPlanFact,
      budgetRefs,
      selectedUid,
      operation,
      act,
      acting,
      actionError,
      clearActionError,
      reverse,
      form,
      openForm,
      closeForm,
      refs,
      save,
      saving,
      saveError,
    ],
  );

  return <FinanceContext.Provider value={value}>{children}</FinanceContext.Provider>;
};

export function useFinance(): FinanceContextValue {
  const ctx = useContext(FinanceContext);
  if (!ctx) throw new Error('useFinance вызван вне FinanceProvider');
  return ctx;
}
