import React, { useEffect } from 'react';
import { Platform, View } from 'react-native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ThemeProvider, useTheme } from '@/theme/ThemeProvider';
import { I18nProvider } from '@/i18n';
import { NetworkProvider } from '@/lib/network';
import { AuthProvider, useAuth } from '@/auth/AuthProvider';
import { ToastProvider } from '@/ui/Toast';
import { DrawerShell } from '@/ui/Drawer';
import { UpdateProvider } from '@/ui/UpdatePrompt';
import { useFonts, Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold } from '@expo-google-fonts/inter';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 24 * 3600_000,
      retry: (n, e: any) => n < 1 && e?.status !== 401 && e?.status !== 403 && e?.status !== 404,
      refetchOnWindowFocus: false,
      networkMode: 'offlineFirst',
    },
  },
});

// Кэш для режима «без связи» пишется в память телефона целиком, строкой JSON,
// в основном потоке. Пишем редко (раз в 10 с) и без справочников на сотни
// позиций: иначе запись совпадала с анимациями переходов и давала рывки.
const persister = createAsyncStoragePersister({ storage: AsyncStorage, key: 'ma-cache', throttleTime: 10_000 });
const HEAVY = ['/refs', '/options', '/sources', '/attachments'];
const shouldPersist = (q: any) => q.state.status === 'success' && !HEAVY.some((h) => String(q.queryKey?.[4] ?? '').includes(h));

function Gate() {
  const { colors } = useTheme();
  const { ready: authReady, user, mustChangePassword } = useAuth();
  const [fontsLoaded] = useFonts({ Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold });
  const ready = authReady && fontsLoaded;
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (!ready) return;
    const first = segments[0] as string | undefined;
    if (!user) {
      queryClient.clear();
      if (first !== 'login') router.replace('/login');
    } else if (mustChangePassword) {
      if (first !== 'change-password') router.replace('/change-password');
    } else if (first === 'login' || first === 'change-password' || first === undefined) {
      router.replace('/(tabs)');
    }
  }, [ready, user, mustChangePassword, segments, router]);

  // пока не прочитали сохранённый вход, экраны не рисуем: иначе они на миг
  // увидят пустые права и выберут не тот фильтр по умолчанию
  if (!ready) return <View style={{ flex: 1, backgroundColor: colors.canvas }} />;

  return (
    <>
      <StatusBar style={(segments[0] as string) === 'login' || (segments[0] as string) === 'change-password' ? (colors.isDark ? 'light' : 'dark') : 'light'} />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.canvas }, animation: 'ios_from_right' as any, animationDuration: 380 }}>
        <Stack.Screen name="(tabs)" options={{ animation: 'fade' }} />
        <Stack.Screen name="login" options={{ animation: 'fade' }} />
        <Stack.Screen name="scan" options={{ presentation: 'fullScreenModal', animation: 'slide_from_bottom' }} />
      </Stack>
    </>
  );
}

export default function Root() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <I18nProvider>
            <NetworkProvider>
              <PersistQueryClientProvider client={queryClient} persistOptions={{ persister, maxAge: 24 * 3600_000, buster: 'v2', dehydrateOptions: { shouldDehydrateQuery: shouldPersist } }}>
                <AuthProvider>
                  <WebFrame>
                    <ToastProvider>
                      <UpdateProvider>
                        <DrawerShell>
                          <Gate />
                        </DrawerShell>
                      </UpdateProvider>
                    </ToastProvider>
                  </WebFrame>
                </AuthProvider>
              </PersistQueryClientProvider>
            </NetworkProvider>
          </I18nProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

/** В браузере на большом мониторе показываем приложение колонкой телефона. */
function WebFrame({ children }: { children: React.ReactNode }) {
  const { colors } = useTheme();
  if (Platform.OS !== 'web') return <>{children}</>;
  return (
    <View style={{ flex: 1, backgroundColor: colors.isDark ? '#000' : '#e4e4e7', alignItems: 'center' }}>
      <View style={{ flex: 1, width: '100%', maxWidth: 480, backgroundColor: colors.canvas, overflow: 'hidden' }}>{children}</View>
    </View>
  );
}
