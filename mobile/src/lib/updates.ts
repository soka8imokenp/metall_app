import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as FileSystem from 'expo-file-system/legacy';
import * as IntentLauncher from 'expo-intent-launcher';
import { api, API_BASE, headers } from '@/api/client';

export const APP_VERSION = Constants.expoConfig?.version ?? '0.0.0';

export type UpdateInfo = {
  version: string;
  notes: string;
  size: number | null;
  /** Ниже минимальной версии работать нельзя — окно не закрывается. */
  mandatory: boolean;
};

/** Сравнение «1.4.0»: −1, 0, 1. */
export function cmpVersion(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * Есть ли версия новее установленной. Спрашиваем свой сервер, а не GitHub:
 * репозиторий приватный, ключ к нему живёт только на сервере.
 */
export async function checkUpdate(): Promise<UpdateInfo | null> {
  const r = await api<{ version: string | null; notes: string; size: number | null; minVersion: string | null }>('/mobile/update');
  if (!r.version || cmpVersion(r.version, APP_VERSION) <= 0) return null;
  return {
    version: r.version,
    notes: r.notes ?? '',
    size: r.size,
    mandatory: !!r.minVersion && cmpVersion(APP_VERSION, r.minVersion) < 0,
  };
}

/** Можно ли поставить обновление прямо из приложения: только Android. */
export const canSelfInstall = Platform.OS === 'android';

/** Скачать APK с прогрессом. Возвращает путь к файлу и функцию отмены. */
export function downloadUpdate(version: string, onProgress: (written: number, total: number) => void) {
  const target = `${FileSystem.cacheDirectory}MetallAsia-${version}.apk`;
  const task = FileSystem.createDownloadResumable(
    `${API_BASE}/mobile/update/apk`,
    target,
    { headers: headers() },
    (p) => onProgress(p.totalBytesWritten, p.totalBytesExpectedToWrite),
  );
  return {
    promise: task.downloadAsync().then((r) => {
      if (!r || r.status !== 200) throw new Error(`HTTP ${r?.status ?? 0}`);
      return r.uri;
    }),
    cancel: () => task.cancelAsync().catch(() => undefined),
  };
}

/**
 * Открыть системный установщик. Файл отдаём через content://, а не file://:
 * Android 7+ не даёт другим приложениям читать наши файлы по прямому пути.
 */
export async function installApk(fileUri: string) {
  const contentUri = await FileSystem.getContentUriAsync(fileUri);
  await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
    data: contentUri,
    flags: 1, // FLAG_GRANT_READ_URI_PERMISSION
    type: 'application/vnd.android.package-archive',
  });
}
