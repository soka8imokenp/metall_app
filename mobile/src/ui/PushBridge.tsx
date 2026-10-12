import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { useRouter } from 'expo-router';
import * as Notifications from 'expo-notifications';
import { useAuth } from '@/auth/AuthProvider';
import { registerPush, routeForKind } from '@/lib/push';
import { storage } from '@/lib/storage';

/**
 * Связка push с сессией: после входа регистрирует адрес телефона (разрешение
 * спрашивает один раз), при каждом запуске обновляет его, а нажатие на
 * уведомление открывает нужный раздел.
 */
export function PushBridge() {
  const { user } = useAuth();
  const router = useRouter();
  const handled = useRef<string | null>(null);
  const response = Platform.OS === 'web' ? null : Notifications.useLastNotificationResponse();

  useEffect(() => {
    if (!user || Platform.OS === 'web') return;
    (async () => {
      const asked = (await storage.get('pushAsked')) === '1';
      await registerPush(!asked).catch(() => undefined);
      if (!asked) await storage.set('pushAsked', '1');
    })();
  }, [user]);

  useEffect(() => {
    if (!user || !response) return;
    const id = response.notification.request.identifier;
    if (handled.current === id) return;
    handled.current = id;
    const to = routeForKind(response.notification.request.content.data?.kind as string | undefined);
    if (to) router.navigate(to as any);
  }, [response, user, router]);

  return null;
}
