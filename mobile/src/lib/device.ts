import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import { storage } from './storage';

/**
 * Кто этот телефон для сервера. `installationId` придумываем сами при первом
 * запуске и храним: модель телефона не уникальна, а серийник телефоны не
 * отдают. По нему администратор видит устройство и может его отозвать.
 */
export async function deviceInfo() {
  let installationId = await storage.get('installationId');
  if (!installationId) {
    installationId = `${Platform.OS}-${Crypto.randomUUID()}`;
    await storage.set('installationId', installationId);
  }
  const c = (Platform as any).constants ?? {};
  const model = [c.Manufacturer, c.Model].filter(Boolean).join(' ') || (Platform.OS === 'ios' ? 'iPhone' : undefined);
  return {
    installationId,
    platform: (Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web') as 'ios' | 'android' | 'web',
    model: model?.slice(0, 120),
    osVersion: String(Platform.Version ?? '').slice(0, 40) || undefined,
    appVersion: Constants.expoConfig?.version ?? undefined,
  };
}
