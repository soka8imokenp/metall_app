import { Platform } from 'react-native';
import * as Sharing from 'expo-sharing';
import { File, Paths } from 'expo-file-system';
import { API_BASE, headers } from '@/api/client';

/**
 * Скачать файл с авторизацией и отдать системе: в браузере — открыть вкладку,
 * на телефоне — сохранить во временную папку и показать окно «Поделиться/Открыть».
 */
export async function openRemoteFile(path: string, fallbackName: string) {
  const res = await fetch(`${API_BASE}${path}`, { headers: headers() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const cd = res.headers.get('content-disposition') ?? '';
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
  const name = m ? decodeURIComponent(m[1]) : fallbackName;
  if (Platform.OS === 'web') {
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
    return;
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const file = new File(Paths.cache, name.replace(/[^\w.\-]+/g, '_'));
  if (file.exists) file.delete();
  file.create();
  file.write(bytes);
  if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(file.uri);
}
