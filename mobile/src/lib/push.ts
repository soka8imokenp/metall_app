import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { api } from '@/api/client';
import { deviceInfo } from './device';
import { storage } from './storage';

/**
 * Push-уведомления. Сервер кладёт события в очередь (просрочки, согласования,
 * критические остатки…) и отправляет их через службу Expo на адрес телефона.
 * Адрес (Expo push token) телефон получает здесь и регистрирует на сервере
 * вместе с устройством; выключение в настройках стирает адрес на сервере.
 *
 * Адрес выдаётся только приложению, привязанному к проекту Expo
 * (`extra.eas.projectId`), а на Android ещё и к проекту Firebase
 * (`google-services.json`). Пока их нет — push тихо не работает, остальное
 * приложение это не задевает.
 */

export const PUSH_CHANNEL = 'default';
const projectId: string | undefined =
  (Constants.expoConfig?.extra as any)?.eas?.projectId ?? (Constants as any).easConfig?.projectId;

/** Сборка умеет получать push: телефон и проект Expo подключён. */
export const pushConfigured = Platform.OS !== 'web' && !!projectId;

if (Platform.OS !== 'web') {
  // уведомление, пришедшее при открытом приложении, тоже показываем баннером
  Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldPlaySound: true, shouldSetBadge: false, shouldShowBanner: true, shouldShowList: true }),
  });
}

export async function pushEnabled(): Promise<boolean> {
  return (await storage.get('pushEnabled')) !== '0';
}

export type PushState = 'on' | 'off' | 'denied' | 'unavailable';

/**
 * Получить адрес и сообщить серверу. `ask` — можно спросить разрешение у
 * человека (при входе и из настроек); при запуске приложения не спрашиваем.
 */
export async function registerPush(ask: boolean): Promise<PushState> {
  if (!pushConfigured) return 'unavailable';
  if (!(await pushEnabled())) return 'off';
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(PUSH_CHANNEL, {
      name: 'METALL ASIA',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 200, 120, 200],
      lightColor: '#ce1f3c',
    });
  }
  let perm = await Notifications.getPermissionsAsync();
  if (!perm.granted && perm.canAskAgain && ask) perm = await Notifications.requestPermissionsAsync();
  if (!perm.granted) return 'denied';
  const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  if ((await storage.get('pushToken')) !== token || ask) {
    await api('/devices/register', { method: 'POST', body: { ...(await deviceInfo()), pushToken: token, pushProvider: 'expo' } });
    await storage.set('pushToken', token);
  }
  return 'on';
}

/** Выключить: адрес на сервере стирается, уведомления на этот телефон не идут. */
export async function disablePush(): Promise<void> {
  await storage.set('pushEnabled', '0');
  await storage.del('pushToken');
  if (Platform.OS === 'web') return;
  await api('/devices/register', { method: 'POST', body: { ...(await deviceInfo()), pushToken: '' } });
}

export async function enablePush(): Promise<PushState> {
  await storage.set('pushEnabled', '1');
  return registerPush(true);
}

/** Куда вести по нажатию на уведомление — по его виду. */
export function routeForKind(kind?: string): string | null {
  if (!kind) return null;
  if (kind.startsWith('finance_')) return '/(tabs)/finance';
  if (kind.startsWith('document_')) return '/(tabs)/documents';
  if (kind === 'stock_critical' || kind === 'stock_reserved' || kind === 'inventory_variance') return '/(tabs)/warehouse';
  if (kind === 'stage_overdue') return '/(tabs)/production';
  if (kind === 'payment_overdue' || kind === 'order_assigned' || kind === 'order_moved') return '/(tabs)/sales';
  return '/(tabs)';
}
