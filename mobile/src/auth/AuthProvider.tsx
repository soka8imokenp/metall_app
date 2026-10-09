import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, ApiError, session, setApiBase } from '@/api/client';
import { storage } from '@/lib/storage';
import { deviceInfo } from '@/lib/device';
import { useI18n } from '@/i18n';

export type Company = { uid: string; code: 'trade' | 'plant'; nameRu: string; nameUz: string };
export type User = { uid: string; login: string; fullName: string; locale: 'ru' | 'uz' };

type Stored = {
  token: string;
  /** Ключ обновления короткого токена. Нет у входов, сделанных до сессий. */
  refreshToken?: string | null;
  user: User;
  companies: Company[];
  permissions: string[];
  mustChangePassword: boolean;
};

type Ctx = {
  ready: boolean;
  user: User | null;
  companies: Company[];
  permissions: Set<string>;
  mustChangePassword: boolean;
  /** uid выбранной компании или `all` — обе. */
  companyKey: string;
  company: Company | null;
  setCompanyKey: (k: string) => void;
  can: (...perms: string[]) => boolean;
  signIn: (login: string, password: string) => Promise<void>;
  signOut: () => void;
  changePassword: (current: string, next: string) => Promise<void>;
};

const AuthCtx = createContext<Ctx>(null as unknown as Ctx);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const { locale, setLocale } = useI18n();
  const [ready, setReady] = useState(false);
  const [state, setState] = useState<Stored | null>(null);
  const [companyKey, setCompanyKeyState] = useState<string>('all');

  session.locale = locale;

  const clear = useCallback(() => {
    session.token = null;
    session.refreshToken = null;
    session.companyUid = null;
    setState(null);
    storage.del('auth');
  }, []);

  useEffect(() => {
    session.onUnauthorized = clear;
    session.onPasswordChange = () => setState((s) => (s ? { ...s, mustChangePassword: true } : s));
    // Новые токены после обновления сохраняем сразу: иначе после перезапуска
    // приложение предъявит уже потраченный ключ и выйдет из учётки.
    session.onTokens = (token, refreshToken) =>
      setState((s) => {
        if (!s) return s;
        const n = { ...s, token, refreshToken };
        storage.set('auth', JSON.stringify(n));
        return n;
      });
  }, [clear]);

  useEffect(() => {
    (async () => {
      setApiBase(await storage.get('apiBase'));
      const raw = await storage.get('auth');
      const ck = await storage.get('company');
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as Stored;
          session.token = parsed.token;
          session.refreshToken = parsed.refreshToken ?? null;
          // Токен доступа живёт 15 минут и почти наверняка истёк, пока приложение
          // лежало: запрос ниже сам обновит его по ключу обновления.
          await api('/auth/me');
          // обновление могло сменить токены — берём актуальные из сессии
          const s = { ...parsed, token: session.token ?? parsed.token, refreshToken: session.refreshToken };
          storage.set('auth', JSON.stringify(s));
          setState(s);
          if (ck && (ck === 'all' || s.companies.some((c) => c.uid === ck))) setCompanyKeyState(ck);
          else setCompanyKeyState(s.companies.length === 1 ? s.companies[0].uid : 'all');
        } catch (e) {
          // нет сети — оставляем вход и показываем кэш; 401 уже очистил сессию
          if (e instanceof ApiError && e.isNetwork) {
            const s = JSON.parse(raw) as Stored;
            setState(s);
            setCompanyKeyState(ck ?? 'all');
          } else clear();
        }
      }
      setReady(true);
    })();
  }, [clear]);

  useEffect(() => {
    session.companyUid = companyKey === 'all' ? null : companyKey;
  }, [companyKey]);

  const setCompanyKey = useCallback((k: string) => {
    session.companyUid = k === 'all' ? null : k;
    setCompanyKeyState(k);
    storage.set('company', k);
  }, []);

  const signIn = useCallback(
    async (login: string, password: string) => {
      const device = await deviceInfo();
      const r = await api<any>('/auth/login', { method: 'POST', body: { login: login.trim(), password, device } });
      const s: Stored = {
        token: r.token,
        refreshToken: r.refreshToken ?? null,
        user: r.user,
        companies: r.companies,
        permissions: r.permissions,
        mustChangePassword: !!r.mustChangePassword,
      };
      session.token = s.token;
      session.refreshToken = s.refreshToken ?? null;
      await storage.set('auth', JSON.stringify(s));
      setState(s);
      const ck = s.companies.length === 1 ? s.companies[0].uid : 'all';
      setCompanyKeyState(ck);
      session.companyUid = ck === 'all' ? null : ck;
      storage.set('company', ck);
      if (s.user.locale && s.user.locale !== locale) setLocale(s.user.locale);
    },
    [locale, setLocale],
  );

  /** Выход: сервер закрывает сессию (токены больше не действуют), потом чистим телефон. */
  const signOut = useCallback(() => {
    if (session.token) void api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    clear();
  }, [clear]);

  const changePassword = useCallback(async (current: string, next: string) => {
    await api('/auth/me/password', { method: 'POST', body: { currentPassword: current, newPassword: next } });
    setState((s) => {
      if (!s) return s;
      const n = { ...s, mustChangePassword: false };
      storage.set('auth', JSON.stringify(n));
      return n;
    });
  }, []);

  const permissions = useMemo(() => new Set(state?.permissions ?? []), [state]);
  const value = useMemo<Ctx>(
    () => ({
      ready,
      user: state?.user ?? null,
      companies: state?.companies ?? [],
      permissions,
      mustChangePassword: !!state?.mustChangePassword,
      companyKey,
      company: state?.companies.find((c) => c.uid === companyKey) ?? null,
      setCompanyKey,
      can: (...p) => p.some((x) => permissions.has(x)),
      signIn,
      signOut,
      changePassword,
    }),
    [ready, state, permissions, companyKey, setCompanyKey, signIn, signOut, changePassword],
  );

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export const useAuth = () => useContext(AuthCtx);
