/**
 * Сессия пользователя.
 *
 * Токен держим в памяти и в sessionStorage: перезагрузка страницы не должна
 * выбрасывать на форму входа, но и переживать закрытие вкладки токену незачем.
 * Права приходят с сервера и здесь только читаются — решение о доступе всегда
 * принимает бэкенд, интерфейс лишь не рисует то, чего пользователю нельзя.
 */

import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { AuthSession } from '../types/api';
import { ApiError, apiClient, setApiToken, setCompanyUidMap } from '../lib/api-client';

const STORAGE_KEY = 'metall_session';

interface AuthContextValue {
  session: AuthSession | null;
  isReady: boolean;
  isPending: boolean;
  login: (login: string, password: string) => Promise<void>;
  logout: () => void;
  can: (permission: string) => boolean;
  /**
   * Смена своего пароля. Управление возвращается только после того, как
   * сервер подтвердил снятие признака: окно «Измените пароль» закрывается по
   * обновлённой сессии, а не по факту нажатия кнопки.
   */
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

/** Ключи компаний во фронте — коды компаний на бэкенде. */
function uidPairs(session: AuthSession) {
  const byCode = (code: string) => session.companies.find((c) => c.code === code)?.uid;
  const pairs: Array<{ key: string; uid: string }> = [];
  const trade = byCode('trade');
  const plant = byCode('plant');
  if (trade) pairs.push({ key: 'company_trade', uid: trade });
  if (plant) pairs.push({ key: 'company_factory', uid: plant });
  return pairs;
}

function applySession(session: AuthSession) {
  setApiToken(session.token);
  setCompanyUidMap(uidPairs(session));
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [isPending, setIsPending] = useState(false);

  // Восстановление сессии до первого запроса данных: иначе дашборд успеет
  // сходить на сервер без токена и получить 401.
  //
  // Сохранённой сессии верим только в части токена. Состав компаний и права
  // перечитываем с сервера: пересев данных пересоздаёт компании, их uid
  // меняются, и открытая с прошлого раза вкладка отправляла бы
  // X-Company-Id несуществующей компании. Токен при этом ещё годен, поэтому
  // снаружи это выглядело не как «войдите заново», а как «показатели не
  // загрузились» при выборе одной компании и рабочий экран при «всех» —
  // там заголовок не шлётся вовсе.
  //
  // Сверка идёт с пустой таблицей uid: заголовок компании в ней ещё
  // некому построить, и сам запрос сверки не может упереться в тот же 403.
  useEffect(() => {
    let alive = true;
    let restored: AuthSession | null = null;
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (raw) restored = JSON.parse(raw) as AuthSession;
    } catch {
      sessionStorage.removeItem(STORAGE_KEY);
    }

    if (!restored) {
      setIsReady(true);
      return;
    }

    setApiToken(restored.token);
    setCompanyUidMap([]);

    const token = restored.token;
    apiClient.auth
      .me()
      .then(({ data }) => {
        if (!alive) return;
        const fresh: AuthSession = { ...data, token };
        applySession(fresh);
        setSession(fresh);
        try {
          sessionStorage.setItem(STORAGE_KEY, JSON.stringify(fresh));
        } catch {
          // Хранилище может быть недоступно — сессия от этого не ломается.
        }
      })
      .catch(() => {
        // Сервер сессию не признал: чинить нечего, показываем вход.
        if (!alive) return;
        setApiToken(null);
        setCompanyUidMap([]);
        setSession(null);
        sessionStorage.removeItem(STORAGE_KEY);
      })
      .finally(() => {
        if (alive) setIsReady(true);
      });

    return () => {
      alive = false;
    };
  }, []);

  const login = useCallback(async (loginName: string, password: string) => {
    setIsPending(true);
    try {
      const { data } = await apiClient.auth.login(loginName, password);
      applySession(data);
      setSession(data);
      try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      } catch {
        // Хранилище может быть недоступно — вход от этого не ломается.
      }
    } catch (e) {
      // Текст отказа собирает экран входа: он знает язык интерфейса, а этот
      // слой стоит снаружи AppProvider и языка не видит. Здесь — только
      // проброс ошибки наверх (ТЗ 13.4).
      throw e;
    } finally {
      setIsPending(false);
    }
  }, []);

  const logout = useCallback(() => {
    setApiToken(null);
    setCompanyUidMap([]);
    setSession(null);
    sessionStorage.removeItem(STORAGE_KEY);
  }, []);

  const can = useCallback(
    (permission: string) => !!session?.permissions.includes(permission),
    [session],
  );

  /**
   * Своя смена пароля.
   *
   * Токен после смены остаётся годным — сервер его не отзывает, — поэтому
   * входить заново не нужно. Но права и признак перечитываются с сервера, а
   * не выставляются здесь по памяти: до смены пароля человек не получал ни
   * одного ответа с данными, и состав прав в сессии мог быть только тем, что
   * вернул вход.
   */
  const changePassword = useCallback(
    async (currentPassword: string, newPassword: string) => {
      setIsPending(true);
      try {
        await apiClient.auth.changePassword(currentPassword, newPassword);
        const { data } = await apiClient.auth.me();
        setSession((prev) => {
          if (!prev) return prev;
          const fresh: AuthSession = { ...data, token: prev.token };
          applySession(fresh);
          try {
            sessionStorage.setItem(STORAGE_KEY, JSON.stringify(fresh));
          } catch {
            // Хранилище может быть недоступно — смена пароля от этого не ломается.
          }
          return fresh;
        });
      } finally {
        setIsPending(false);
      }
    },
    [],
  );

  return (
    <AuthContext.Provider
      value={{ session, isReady, isPending, login, logout, can, changePassword }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth вызван вне AuthProvider');
  return ctx;
}
