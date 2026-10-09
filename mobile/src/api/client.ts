import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';

/**
 * Клиент API. Один в один с веб-клиентом по договорённостям контракта
 * (docs/04-API-CONTRACT.md): конверт `{data, meta}`, ошибка `{error}`,
 * `Idempotency-Key` на каждой записи, `X-Company-Id` — uid компании или не
 * шлём вовсе для «обеих».
 */

function resolveBase(): string {
  const env = process.env.EXPO_PUBLIC_API_URL;
  if (env) return env.replace(/\/$/, '');
  // Разработка: бэкенд на том же компьютере, что раздаёт приложение, а к нему
  // ведёт мост scripts/dev-proxy.mjs (порт 4001) — он виден из Wi-Fi сети.
  if (Platform.OS === 'web') {
    const host = typeof location !== 'undefined' ? location.hostname : 'localhost';
    return `http://${host}:4001/api/v1`;
  }
  const hostUri = Constants.expoConfig?.hostUri ?? '';
  const host = hostUri.split(':')[0] || 'localhost';
  return `http://${host}:4001/api/v1`;
}

export let API_BASE = resolveBase();
export const DEFAULT_API_BASE = API_BASE;

/** Адрес сервера можно поменять на экране входа (для APK: ПК в сети, стенд или рабочий сервер). */
export function setApiBase(url: string | null) {
  const clean = (url ?? '').trim().replace(/\/+$/, '');
  API_BASE = clean || DEFAULT_API_BASE;
}

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public details?: unknown,
  ) {
    super(message);
  }
  get isNetwork() {
    return this.code === 'NETWORK';
  }
}

type Session = {
  token: string | null;
  /** Долгий ключ обновления (только у телефона). Короткий токен доступа живёт 15 минут. */
  refreshToken: string | null;
  companyUid: string | null;
  locale: 'ru' | 'uz';
  onUnauthorized?: () => void;
  onPasswordChange?: () => void;
  /** Новые токены после обновления — их нужно сохранить. */
  onTokens?: (token: string, refreshToken: string) => void;
};

export const session: Session = { token: null, refreshToken: null, companyUid: null, locale: 'ru' };

type Opts = {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  idempotencyKey?: string;
  signal?: AbortSignal;
};

export function newKey() {
  return Crypto.randomUUID();
}

function qs(query?: Opts['query']) {
  if (!query) return '';
  const p = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return p.length ? `?${p.join('&')}` : '';
}

export function headers(extra: Record<string, string> = {}) {
  const h: Record<string, string> = {
    Accept: 'application/json',
    'Accept-Language': session.locale,
    'X-Request-Id': Crypto.randomUUID(),
    // Сервер по этому заголовку выдаёт короткий токен с обновлением, требует
    // ключ повтора на записях и пишет действия в журнал как «с телефона».
    'X-Client': 'mobile',
    ...extra,
  };
  if (session.token) h.Authorization = `Bearer ${session.token}`;
  if (session.companyUid) h['X-Company-Id'] = session.companyUid;
  return h;
}

/**
 * Обновление токена — одно на всё приложение: если пять запросов разом
 * получили 401, ключ обновления тратится один раз, остальные ждут его.
 */
let refreshing: Promise<boolean> | null = null;
export function refreshTokens(): Promise<boolean> {
  if (!session.refreshToken) return Promise.resolve(false);
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const res = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Client': 'mobile', 'Accept-Language': session.locale },
        body: JSON.stringify({ refreshToken: session.refreshToken }),
      });
      if (!res.ok) return false;
      const json = await res.json();
      session.token = json.data.token;
      session.refreshToken = json.data.refreshToken;
      session.onTokens?.(json.data.token, json.data.refreshToken);
      return true;
    } catch {
      // Нет сети — это не конец сессии: войти заново не требуем.
      return false;
    } finally {
      setTimeout(() => { refreshing = null; }, 0);
    }
  })();
  return refreshing;
}

/**
 * Запрос с одним повтором после обновления токена. 401 на входе и на самом
 * обновлении — настоящий отказ; на остальных маршрутах сначала пробуем
 * обновить короткий токен.
 */
async function send(path: string, init: { method: string; body?: string; extra?: Record<string, string>; signal?: AbortSignal }): Promise<Response> {
  const go = () =>
    fetch(`${API_BASE}${path}`, { method: init.method, headers: headers(init.extra), body: init.body, signal: init.signal });
  let res: Response;
  try {
    res = await go();
    if (res.status === 401 && session.refreshToken && !path.startsWith('/auth/login') && !path.startsWith('/auth/refresh')) {
      if (await refreshTokens()) res = await go();
    }
  } catch (e: any) {
    if (e?.name === 'AbortError') throw e;
    throw new ApiError('NETWORK', 'Сервер недоступен', 0);
  }
  return res;
}

export async function api<T = any>(path: string, opts: Opts = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const extra: Record<string, string> = {};
  let body: string | undefined;
  if (opts.body !== undefined) {
    extra['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  // Один ключ на попытку, в том числе на повтор после обновления токена:
  // сервер узнает повтор и не выполнит действие дважды.
  if (method !== 'GET') extra['Idempotency-Key'] = opts.idempotencyKey ?? newKey();

  const res = await send(`${path}${qs(opts.query)}`, { method, body, extra, signal: opts.signal });

  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* не JSON — ответ шлюза */
  }

  if (!res.ok) {
    const err = json?.error;
    const e = new ApiError(err?.code ?? `HTTP_${res.status}`, err?.message ?? `Ошибка ${res.status}`, res.status, err?.details);
    if (res.status === 401 && !path.startsWith('/auth/login')) session.onUnauthorized?.();
    if (e.code === 'PASSWORD_CHANGE_REQUIRED') session.onPasswordChange?.();
    throw e;
  }
  return (json && 'data' in json ? json.data : json) as T;
}

/** Ответ с мета-данными (списки с курсором и общим числом). */
export async function apiFull<T = any>(path: string, opts: Opts = {}): Promise<{ data: T; meta: any }> {
  const res = await send(`${path}${qs(opts.query)}`, { method: 'GET', signal: opts.signal });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401) session.onUnauthorized?.();
    throw new ApiError(json?.error?.code ?? `HTTP_${res.status}`, json?.error?.message ?? `Ошибка ${res.status}`, res.status, json?.error?.details);
  }
  return { data: json.data, meta: json.meta };
}
