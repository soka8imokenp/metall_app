/**
 * Данные страницы продаж.
 *
 * Провайдер монтируется вместе с самим разделом, а не на входе в систему:
 * пока пользователь смотрит дашборд, четыре запроса продаж серверу не нужны.
 *
 * Разделов на экране три (заказы, ТТН, покупатели), и каждый грузится своим
 * запросом по мере открытия — журнал ТТН не должен ехать к тому, кто зашёл
 * посмотреть один заказ.
 *
 * Запись — заказ, смена статуса и ТТН — живёт здесь же. После каждой записи
 * перечитываются список, сводка и открытый заказ: ТТН меняет и статус заказа, и
 * остаток по строкам, и экран с прежними числами врёт менеджеру.
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  DashboardPeriod,
  SalesAvailability,
  SalesOrderBrief,
  SalesOrderDetail,
  SalesOrderInput,
  SalesOrderRow,
  SalesOrderStatus,
  SalesPartnerRow,
  SalesRefs,
  SalesShipmentBrief,
  SalesShipmentInput,
  SalesShipmentRow,
  SalesStage,
  SalesSummary,
} from '../types/api';
import { ApiError, apiClient } from '../lib/api-client';
import { AsyncState } from './DashboardContext';
import { useApp } from './AppContext';
import { useSearchJump } from '../lib/use-search-jump';
import { useAuth } from './AuthContext';

export type SalesSection = 'orders' | 'shipments' | 'partners' | 'prices';

interface SalesContextValue {
  period: DashboardPeriod;
  setPeriod: (p: DashboardPeriod) => void;
  summary: AsyncState<SalesSummary>;
  reloadSummary: () => void;

  section: SalesSection;
  setSection: (s: SalesSection) => void;

  stage: SalesStage;
  setStage: (s: SalesStage) => void;
  search: string;
  setSearch: (s: string) => void;
  orders: AsyncState<SalesOrderRow[]>;
  reloadOrders: () => void;

  selectedUid: string | null;
  setSelectedUid: (uid: string | null) => void;
  order: AsyncState<SalesOrderDetail>;

  shipments: AsyncState<SalesShipmentRow[]>;
  partners: AsyncState<SalesPartnerRow[]>;

  /** Справочники формы заказа. */
  refs: AsyncState<SalesRefs>;
  /** Что по выбранному заказу осталось отгрузить: основа формы ТТН. */
  availability: AsyncState<SalesAvailability>;
  reloadAvailability: () => void;

  /** Запись заказа. Возвращает карточку записанного или null при отказе. */
  saveOrder: (input: SalesOrderInput) => Promise<SalesOrderBrief | null>;
  /** Смена статуса заказа. */
  changeStatus: (
    uid: string,
    status: SalesOrderStatus,
    comment?: string,
  ) => Promise<SalesOrderBrief | null>;
  /** Запись ТТН по выбранному заказу. */
  saveShipment: (
    orderUid: string,
    input: SalesShipmentInput,
  ) => Promise<SalesShipmentBrief | null>;
  saving: boolean;
  saveError: ApiError | null;
  clearSaveError: () => void;
  /** Последнее записанное: экран подтверждает номером, а не словом «готово». */
  lastSaved: { kind: 'order' | 'status' | 'shipment'; number: string; note: string } | null;
}

const SalesContext = createContext<SalesContextValue | undefined>(undefined);

const idle = <T,>(): AsyncState<T> => ({ data: null, isLoading: false, error: null });
const toApiError = (e: unknown) =>
  e instanceof ApiError ? e : new ApiError('INTERNAL_ERROR', '', 0);

/** Запрос в состояние: одна и та же обвязка на все четыре источника. */
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

export const SalesProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { company, locale } = useApp();
  const { session } = useAuth();
  const ready = Boolean(session);

  const [period, setPeriod] = useState<DashboardPeriod>('30d');
  const [section, setSection] = useState<SalesSection>('orders');
  const [stage, setStage] = useState<SalesStage>('all');
  const [search, setSearch] = useState('');
  const [selectedUid, setSelectedUid] = useState<string | null>(null);
  // Находка из общего окна поиска: раздел подставляет её себе в строку.
  useSearchJump('sales', (q) => {
    setSearch(q);
    setSection('orders');
  }, 'orders');

  // Поиск набирают посимвольно: без задержки каждый символ уходил бы запросом.
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const [summary, reloadSummary] = useAsync(
    () => apiClient.sales.getSummary(period),
    [company, locale, period],
    ready,
  );

  const [orders, reloadOrders] = useAsync(
    () => apiClient.sales.getOrders(stage, debounced, 100),
    [company, locale, stage, debounced],
    ready,
  );

  const [order, reloadOrder] = useAsync(
    () => apiClient.sales.getOrder(selectedUid!),
    [company, locale, selectedUid],
    ready && selectedUid !== null,
  );

  const [shipments] = useAsync(
    () => apiClient.sales.getShipments(100),
    [company, locale],
    ready && section === 'shipments',
  );

  const [partners] = useAsync(
    () => apiClient.sales.getPartners(100),
    [company, locale],
    ready && section === 'partners',
  );

  // Справочники формы. Форма заказа открывается кнопкой, но список
  // номенклатуры нужен уже первому полю — грузим вместе с экраном.
  const [refs] = useAsync(() => apiClient.sales.getRefs(), [company, locale], ready);

  const [availability, reloadAvailability] = useAsync(
    () => apiClient.sales.getAvailability(selectedUid!),
    [company, locale, selectedUid],
    ready && selectedUid !== null,
  );

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<ApiError | null>(null);
  const clearSaveError = useCallback(() => setSaveError(null), []);
  const [lastSaved, setLastSaved] = useState<{
    kind: 'order' | 'status' | 'shipment';
    number: string;
    note: string;
  } | null>(null);

  // Компанию переключили — покупатели и номенклатура в форме уже чужие, а
  // прошлая ошибка относилась к другому заказу.
  useEffect(() => {
    setSaveError(null);
    setLastSaved(null);
  }, [company]);

  /**
   * Ключ идемпотентности живёт от одной записанной ТТН до следующей. Общая
   * обвязка клиента шлёт новый ключ на каждый запрос, поэтому двойное нажатие
   * «Выписать» выписало бы две накладные; со стабильным ключом сервер вернёт ту
   * же. А удалить лишнюю ТТН потом нельзя: движения склада только пополняются.
   */
  const newKey = () => `sl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const shipmentKey = React.useRef(newKey());

  const saveOrder = useCallback(
    async (input: SalesOrderInput): Promise<SalesOrderBrief | null> => {
      if (saving) return null;
      setSaving(true);
      setSaveError(null);
      try {
        const { data } = await apiClient.sales.createOrder(input);
        setLastSaved({
          kind: 'order',
          number: data.number,
          note: `${locale === 'uz' ? 'satr' : 'строк'}: ${data.linesCount}`,
        });
        reloadOrders();
        reloadSummary();
        return data;
      } catch (e) {
        setSaveError(toApiError(e));
        return null;
      } finally {
        setSaving(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [saving, locale],
  );

  const changeStatus = useCallback(
    async (uid: string, status: SalesOrderStatus, comment?: string) => {
      if (saving) return null;
      setSaving(true);
      setSaveError(null);
      try {
        const { data } = await apiClient.sales.setOrderStatus(uid, status, comment);
        setLastSaved({ kind: 'status', number: data.number, note: data.status });
        reloadOrders();
        reloadSummary();
        reloadAvailability();
        // Открытую карточку заказа перечитываем принудительно: статус виден в
        // ней же, а ключ запроса не изменился — сам по себе он не обновится.
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

  const saveShipment = useCallback(
    async (orderUid: string, input: SalesShipmentInput) => {
      if (saving) return null;
      setSaving(true);
      setSaveError(null);
      try {
        const { data } = await apiClient.sales.createShipment(
          orderUid,
          input,
          shipmentKey.current,
        );
        // ТТН записана — следующей нужен свой ключ, иначе сервер отдаст на него
        // же эту самую накладную.
        shipmentKey.current = newKey();
        setLastSaved({
          kind: 'shipment',
          number: data.number,
          note:
            data.shipmentStatus === 'full'
              ? locale === 'uz'
                ? 'buyurtma to‘liq jo‘natildi'
                : 'заказ отгружен полностью'
              : locale === 'uz'
                ? 'qisman jo‘natildi'
                : 'отгружено частично',
        });
        reloadOrders();
        reloadSummary();
        reloadAvailability();
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
    [saving, locale],
  );

  const value = useMemo<SalesContextValue>(
    () => ({
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
      refs,
      availability,
      reloadAvailability,
      saveOrder,
      changeStatus,
      saveShipment,
      saving,
      saveError,
      clearSaveError,
      lastSaved,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      period,
      summary,
      section,
      stage,
      search,
      orders,
      selectedUid,
      order,
      shipments,
      partners,
      refs,
      availability,
      saving,
      saveError,
      lastSaved,
    ],
  );

  return <SalesContext.Provider value={value}>{children}</SalesContext.Provider>;
};

export function useSales(): SalesContextValue {
  const ctx = useContext(SalesContext);
  if (!ctx) throw new Error('useSales вызван вне SalesProvider');
  return ctx;
}
