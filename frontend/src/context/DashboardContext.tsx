/**
 * Данные дашборда.
 *
 * Сводка — один запрос на всю страницу: и карточки, и график читают её из
 * контекста. Три компонента, каждый со своим запросом, дали бы три обращения
 * к серверу на один экран и расхождение чисел между карточкой и графиком.
 *
 * Период живёт здесь же: переключатель стоит на графике, но карточки считают
 * прирост за тот же период, и они обязаны меняться вместе.
 */

import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import {
  DashboardPeriod,
  DashboardPlanRow,
  DashboardPlanTab,
  DashboardSummary,
} from '../types/api';
import { ApiError, apiClient } from '../lib/api-client';
import { useApp } from './AppContext';
import { useAuth } from './AuthContext';

export interface AsyncState<T> {
  data: T | null;
  isLoading: boolean;
  error: ApiError | null;
}

interface DashboardContextValue {
  period: DashboardPeriod;
  setPeriod: (p: DashboardPeriod) => void;
  summary: AsyncState<DashboardSummary>;
  reloadSummary: () => void;
  planTab: DashboardPlanTab;
  setPlanTab: (t: DashboardPlanTab) => void;
  plan: AsyncState<DashboardPlanRow[]>;
  reloadPlan: () => void;
}

const DashboardContext = createContext<DashboardContextValue | undefined>(undefined);

const toApiError = (e: unknown) =>
  e instanceof ApiError ? e : new ApiError('INTERNAL_ERROR', '', 0);

export const DashboardProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { company, locale } = useApp();
  const { session } = useAuth();

  const [period, setPeriod] = useState<DashboardPeriod>('30d');
  const [planTab, setPlanTab] = useState<DashboardPlanTab>('plan');
  const [nonce, setNonce] = useState(0);
  const [planNonce, setPlanNonce] = useState(0);

  const [summary, setSummary] = useState<AsyncState<DashboardSummary>>({
    data: null,
    isLoading: true,
    error: null,
  });
  const [plan, setPlan] = useState<AsyncState<DashboardPlanRow[]>>({
    data: null,
    isLoading: true,
    error: null,
  });

  useEffect(() => {
    if (!session) return;
    let cancelled = false;

    // Прошлые данные не стираем: при смене периода экран не должен схлопываться
    // в пустоту, достаточно показать загрузку поверх.
    setSummary((s) => ({ ...s, isLoading: true, error: null }));

    apiClient.dashboard
      .getSummary(period)
      .then(({ data }) => {
        if (!cancelled) setSummary({ data, isLoading: false, error: null });
      })
      .catch((e) => {
        if (!cancelled) setSummary({ data: null, isLoading: false, error: toApiError(e) });
      });

    return () => {
      cancelled = true;
    };
  }, [session, company, locale, period, nonce]);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;

    setPlan((s) => ({ ...s, isLoading: true, error: null }));

    apiClient.dashboard
      .getPlan(planTab, 50)
      .then(({ data }) => {
        if (!cancelled) setPlan({ data, isLoading: false, error: null });
      })
      .catch((e) => {
        if (!cancelled) setPlan({ data: null, isLoading: false, error: toApiError(e) });
      });

    return () => {
      cancelled = true;
    };
  }, [session, company, locale, planTab, planNonce]);

  const value = useMemo<DashboardContextValue>(
    () => ({
      period,
      setPeriod,
      summary,
      reloadSummary: () => setNonce((n) => n + 1),
      planTab,
      setPlanTab,
      plan,
      reloadPlan: () => setPlanNonce((n) => n + 1),
    }),
    [period, summary, planTab, plan],
  );

  return <DashboardContext.Provider value={value}>{children}</DashboardContext.Provider>;
};

export function useDashboard(): DashboardContextValue {
  const ctx = useContext(DashboardContext);
  if (!ctx) throw new Error('useDashboard вызван вне DashboardProvider');
  return ctx;
}

/** Подпись к периоду — в одном месте, чтобы не расходилась между экранами. */
export function periodLabel(period: DashboardPeriod, isUz: boolean): string {
  if (period === '7d') return isUz ? 'So‘nggi 7 kun' : 'Последние 7 дней';
  if (period === '30d') return isUz ? 'So‘nggi 30 kun' : 'Последние 30 дней';
  return isUz ? 'So‘nggi 3 oy' : 'Последние 3 месяца';
}

/** Короткий текст ошибки для состояния экрана. */
export function errorText(e: ApiError, isUz: boolean): string {
  if (e.code === 'NETWORK_ERROR') {
    return isUz ? 'Server javob bermadi' : 'Сервер недоступен';
  }
  if (e.code === 'FORBIDDEN') {
    return isUz ? 'Bu bo‘lim uchun huquq yo‘q' : 'Нет прав на этот раздел';
  }
  /*
   * Пустое сообщение приходит от обёртки над не-ApiError: текста там нет,
   * и назвать ошибку по-человечески можно только здесь, где известен язык
   * экрана. Сообщение сервера переводит сам сервер (`say`) — его не подменяем.
   */
  return e.message || (isUz ? 'Noma’lum xato' : 'Неизвестная ошибка');
}
