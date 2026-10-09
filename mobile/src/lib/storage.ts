import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

/**
 * Хранилище ключ-значение. На телефоне — Keychain/Keystore (там токен), в
 * браузере — localStorage: другого безопасного места у веб-сборки нет, а она
 * нужна только для разработки и просмотра.
 */
const web = {
  get: async (k: string) => {
    try { return globalThis.localStorage?.getItem(k) ?? null; } catch { return null; }
  },
  set: async (k: string, v: string) => {
    try { globalThis.localStorage?.setItem(k, v); } catch {}
  },
  del: async (k: string) => {
    try { globalThis.localStorage?.removeItem(k); } catch {}
  },
};

const native = {
  get: (k: string) => SecureStore.getItemAsync(k).catch(() => null),
  set: (k: string, v: string) => SecureStore.setItemAsync(k, v).catch(() => {}),
  del: (k: string) => SecureStore.deleteItemAsync(k).catch(() => {}),
};

export const storage = Platform.OS === 'web' ? web : native;
