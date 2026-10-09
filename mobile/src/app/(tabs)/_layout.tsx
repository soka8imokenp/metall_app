import React, { useCallback, useMemo, useRef } from 'react';
import { Platform, View } from 'react-native';
import { Tabs, usePathname, useRouter } from 'expo-router';
import { BlurTargetView } from 'expo-blur';
import { FloatingTabBar, TabItem } from '@/ui/TabBar';
import { useAuth } from '@/auth/AuthProvider';
import { useI18n } from '@/i18n';
import { useTheme } from '@/theme/ThemeProvider';
import { MODULES, visibleModules, ModuleKey } from '@/lib/modules';

const ALL = ['index', 'warehouse', 'production', 'finance', 'sales', 'documents'] as const;

/**
 * Вкладки. Панель рисуется не навигатором, а поверх экранов.
 * Панель — матовое стекло: на Android размытию нужен «источник»
 * (BlurTargetView вокруг экранов), на iOS и в вебе размытие системное.
 *
 * Переключение без анимации навигатора: появление делает сам экран одним
 * лёгким движением (ContentSheet). Неактивные вкладки заморожены
 * (freezeOnBlur) — они не перерисовываются, пока их не видно.
 */
export default function TabsLayout() {
  const { can } = useAuth();
  const { t } = useI18n();
  const { colors } = useTheme();
  const router = useRouter();
  const pathname = usePathname();
  const target = useRef<View>(null);

  const items = useMemo<TabItem[]>(() => {
    const mods = visibleModules(can);
    // «Ещё» нет: остальное и настройки — в боковом меню (кнопка в шапке)
    const shown: ModuleKey[] = mods.slice(0, 4);
    return [
      { key: 'index', label: t('tabHome'), icon: 'home' },
      // в панели — короткие подписи: «Ishlab chiqarish» не влезает, там «Zavod»
      ...shown.map((k) => ({ key: k, label: k === 'production' ? t('tabProductionShort') : t(MODULES[k].label), icon: MODULES[k].icon })),
    ];
  }, [can, t]);

  const seg = pathname.split('/').filter(Boolean)[0] ?? 'index';
  const active = items.some((i) => i.key === seg) ? seg : '';
  const go = useCallback((k: string) => router.navigate(k === 'index' ? '/(tabs)' : (`/(tabs)/${k}` as any)), [router]);

  const screens = (
    <Tabs
      screenOptions={{
        headerShown: false,
        animation: 'none',
        // все вкладки готовы заранее: переход — показ уже собранного экрана, без сборки на лету
        lazy: false,
        freezeOnBlur: true,
        sceneStyle: { backgroundColor: colors.canvas },
      }}
      tabBar={() => null}
    >
      {ALL.map((n) => (
        <Tabs.Screen key={n} name={n} />
      ))}
    </Tabs>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.canvas }}>
      {Platform.OS === 'android' ? (
        <BlurTargetView ref={target} style={{ flex: 1 }}>
          {screens}
        </BlurTargetView>
      ) : (
        screens
      )}
      <FloatingTabBar items={items} active={active} onPress={go} target={target} />
    </View>
  );
}
