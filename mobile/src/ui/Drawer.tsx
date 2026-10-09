import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { Platform, Pressable as RNPressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, { interpolate, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { EASE_SHEET } from './motion';
import { LinearGradient } from 'expo-linear-gradient';
import { neu } from './components';
import { LangToggle, ThemeToggle } from './LangToggle';
import { useUpdates } from './UpdatePrompt';
import { PinSetupSheet, useAppLock } from './AppLock';
import { useToast } from './Toast';
import { APP_VERSION } from '@/lib/updates';
import { useRouter, useSegments } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather, IconName } from './Icon';
import { Text } from './Text';
import { Pressable } from './Pressable';
import { useAuth } from '@/auth/AuthProvider';
import { useI18n } from '@/i18n';
import { useTheme } from '@/theme/ThemeProvider';
import { MODULES, visibleModules } from '@/lib/modules';

type Ctx = { open: () => void; close: () => void; toggle: () => void; isOpen: boolean };
const DrawerCtx = createContext<Ctx>({ open: () => {}, close: () => {}, toggle: () => {}, isOpen: false });
export const useDrawer = () => useContext(DrawerCtx);

const OPEN = { duration: 460, easing: EASE_SHEET };
const CLOSE = { duration: 380, easing: EASE_SHEET };

/**
 * Боковое меню. Экран сдвигается вправо и уменьшается, открывая меню под собой
 * (как в референсе). Всё на одном значении `p` 0..1 — открытие, закрытие и
 * следящие за ним тень, скругление и затемнение.
 */
export function DrawerShell({ children }: { children: React.ReactNode }) {
  const { width } = useWindowDimensions();
  const p = useSharedValue(0);
  const [isOpen, setOpen] = useState(false);
  const { user } = useAuth();
  const { colors } = useTheme();
  const frameW = Platform.OS === 'web' ? Math.min(width, 480) : width;

  const open = useCallback(() => { setOpen(true); p.value = withTiming(1, OPEN); }, [p]);
  const close = useCallback(() => { setOpen(false); p.value = withTiming(0, CLOSE); }, [p]);
  const toggle = useCallback(() => (isOpen ? close() : open()), [isOpen, open, close]);
  const value = useMemo(() => ({ open, close, toggle, isOpen }), [open, close, toggle, isOpen]);

  const content = useAnimatedStyle(() => ({
    transform: [{ translateX: interpolate(p.value, [0, 1], [0, frameW * 0.72]) }, { scale: interpolate(p.value, [0, 1], [1, 0.86]) }],
    borderRadius: interpolate(p.value, [0, 1], [0, 32]),
  }));
  const menu = useAnimatedStyle(() => ({
    opacity: interpolate(p.value, [0, 0.6, 1], [0, 0.6, 1]),
    transform: [{ translateX: interpolate(p.value, [0, 1], [-24, 0]) }],
  }));

  if (!user) return <DrawerCtx.Provider value={value}>{children}</DrawerCtx.Provider>;
  return (
    <DrawerCtx.Provider value={value}>
      <View style={{ flex: 1, backgroundColor: colors.canvas }}>
        <Animated.View style={[StyleSheet.absoluteFill, menu]}>
          <Menu onNavigate={close} />
        </Animated.View>
        <Animated.View style={[{ flex: 1, overflow: 'hidden', backgroundColor: colors.canvas }, isOpen ? ({ boxShadow: colors.isDark ? '-18px 0 50px rgba(0,0,0,0.6)' : '-16px 0 44px rgba(120,128,146,0.45)' } as any) : null, content]}>
          {children}
          {isOpen && <RNPressable onPress={close} style={StyleSheet.absoluteFill} />}
        </Animated.View>
      </View>
    </DrawerCtx.Provider>
  );
}

function Menu({ onNavigate }: { onNavigate: () => void }) {
  const { user, can, signOut, companyKey, company } = useAuth();
  const { t, locale, setLocale, pick } = useI18n();
  const { colors, setMode } = useTheme();
  const updates = useUpdates();
  const lock = useAppLock();
  const toast = useToast();
  const [pinOpen, setPinOpen] = React.useState(false);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const segs = useSegments() as string[];
  const mods = visibleModules(can);
  const parts = (user?.fullName ?? '').split(' ');
  const initials = parts.slice(0, 2).map((x) => x.charAt(0)).join('');

  const go = (to: string) => { router.navigate(to as any); onNavigate(); };
  const items: { icon: IconName; label: string; to: string; key: string }[] = [
    { icon: 'home', label: t('tabHome'), to: '/(tabs)', key: 'index' },
    ...mods.map((k) => ({ icon: MODULES[k].icon as IconName, label: t(MODULES[k].label), to: `/(tabs)/${k}`, key: k })),
    ...(can('warehouse.view') ? [{ icon: 'maximize' as IconName, label: t('whScan'), to: '/scan', key: 'scan' }] : []),
  ];
  const last = segs[segs.length - 1];
  const current = segs.includes('(tabs)') ? (last === '(tabs)' ? 'index' : last) : '';
  const lineDark = colors.isDark ? 'rgba(0,0,0,0.45)' : 'rgba(152,160,178,0.32)';
  const lineLight = colors.isDark ? 'rgba(255,255,255,0.035)' : 'rgba(255,255,255,0.85)';

  return (
    <View style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: '74%', backgroundColor: colors.canvas }}>
      {/* красная шапка меню с графитовой волной — как у экранов */}
      <View style={{ paddingTop: insets.top + 14, paddingHorizontal: 24, paddingBottom: 26, overflow: 'hidden', borderBottomRightRadius: 32 }}>
        <LinearGradient colors={[colors.bandFrom, colors.bandTo]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
        <View pointerEvents="none" style={{ position: 'absolute', left: '-40%', right: '-40%', bottom: '-125%', height: '190%', borderTopLeftRadius: 900, borderTopRightRadius: 240, backgroundColor: colors.graphite, opacity: 0.95, transform: [{ rotate: '-12deg' }] }} />
        <Text variant="label" style={{ color: 'rgba(255,255,255,0.65)', fontSize: 10.5, letterSpacing: 1.2, textTransform: 'uppercase', fontWeight: '600' }}>{t('company')}</Text>
        <Text variant="headline" style={{ color: '#fff', marginTop: 2 }} numberOfLines={1}>{companyKey === 'all' ? t('bothCompanies') : company ? pick(company, 'name').replace(/[«»"]/g, '') : ''}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 22 }}>
          <View style={{ width: 60, height: 60, borderRadius: 30, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' }}>
            <Text variant="title" style={{ color: '#1f222a', fontWeight: '700' }}>{initials}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text variant="headline" style={{ color: '#fff', fontSize: 16, fontWeight: '700' }} numberOfLines={2}>{user?.fullName}</Text>
            <Text variant="caption" style={{ color: 'rgba(255,255,255,0.7)' }}>@{user?.login}</Text>
          </View>
        </View>
      </View>

      <ScrollView contentContainerStyle={{ paddingHorizontal: 18, paddingTop: 18, paddingBottom: insets.bottom + 20 }} showsVerticalScrollIndicator={false}>
        {items.map((it, i) => {
          const on = it.key === current;
          return (
            <View key={it.key}>
              <Pressable
                onPress={() => go(it.to)}
                scaleTo={0.98}
                style={[
                  { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 13, paddingHorizontal: 12, borderRadius: 16, backgroundColor: colors.canvas },
                  on ? neu(colors, 'insetSm') : null,
                ]}
              >
                <Feather name={it.icon} size={19} color={on ? colors.brand : colors.textSecondary} strokeWidth={on ? 2.2 : 1.8} />
                <Text variant="body" style={{ color: on ? colors.text : colors.textSecondary, fontWeight: on ? '700' : '500', fontSize: 15, flex: 1 }}>{it.label}</Text>
                {on && <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.brand }} />}
              </Pressable>
              {i < items.length - 1 && !on && items[i + 1]?.key !== current && (
                <View style={{ marginHorizontal: 12 }}>
                  <View style={{ height: 1, backgroundColor: lineDark }} />
                  <View style={{ height: 1, backgroundColor: lineLight }} />
                </View>
              )}
            </View>
          );
        })}

        {/* настройки: каждая — своей строкой, подпись слева, тумблер справа */}
        <View style={[{ marginTop: 26, borderRadius: 20, backgroundColor: colors.card, paddingHorizontal: 16, paddingVertical: 6 }, neu(colors, 'raisedSm')]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Feather name="globe" size={18} color={colors.textSecondary} />
              <Text variant="body" style={{ fontWeight: '600' }}>{t('language')}</Text>
            </View>
            <LangToggle width={104} height={38} />
          </View>
          <View style={{ height: 1, backgroundColor: colors.border }} />
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Feather name={colors.isDark ? 'moon' : 'sun'} size={18} color={colors.textSecondary} />
              <Text variant="body" style={{ fontWeight: '600' }}>{t('theme')}</Text>
            </View>
            <ThemeToggle width={104} height={38} />
          </View>
        </View>

        {/* безопасность: код и отпечаток */}
        <View style={[{ marginTop: 16, borderRadius: 20, backgroundColor: colors.card, paddingHorizontal: 16, paddingVertical: 6 }, neu(colors, 'raisedSm')]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Feather name="lock" size={18} color={colors.textSecondary} />
              <Text variant="body" style={{ fontWeight: '600' }}>{t('lkPin')}</Text>
            </View>
            <Switch
              value={lock.pinSet}
              onChange={async (on) => {
                if (on) setPinOpen(true);
                else { await lock.clearPin(); toast.show(t('lkOff'), 'info'); }
              }}
            />
          </View>
          <View style={{ height: 1, backgroundColor: colors.border }} />
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10, opacity: lock.pinSet && lock.bioAvailable ? 1 : 0.45 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Feather name={lock.bioKind === 'face' ? 'scan-face' : 'fingerprint'} size={18} color={colors.textSecondary} />
              <Text variant="body" style={{ fontWeight: '600' }}>{t('lkBio')}</Text>
            </View>
            <Switch
              value={lock.bioEnabled}
              onChange={async (on) => {
                if (!lock.bioAvailable) { toast.show(t('lkNoBio'), 'error'); return; }
                if (!lock.pinSet) { setPinOpen(true); return; }
                await lock.setBio(on);
              }}
            />
          </View>
        </View>
        <PinSetupSheet visible={pinOpen} onClose={() => setPinOpen(false)} onDone={() => { setPinOpen(false); toast.show(t('lkOn'), 'success'); }} />

        <Pressable
          onPress={() => void updates.check(true)}
          pressedStyle={neu(colors, 'insetSm')}
          style={[{ marginTop: 16, height: 50, borderRadius: 16, backgroundColor: colors.card, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, gap: 10 }, neu(colors, 'raisedSm')]}
        >
          <Feather name="refresh-cw" size={17} color={colors.textSecondary} />
          <Text variant="body" style={{ fontWeight: '600', flex: 1 }}>{t('upCheck')}</Text>
          <Text variant="caption" tone="muted" num>v{APP_VERSION}</Text>
        </Pressable>

        <Pressable
          onPress={() => { onNavigate(); signOut(); }}
          pressedStyle={neu(colors, 'insetSm')}
          style={[{ marginTop: 16, height: 50, borderRadius: 16, backgroundColor: colors.card, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 }, neu(colors, 'raisedSm')]}
        >
          <Feather name="log-out" size={18} color={colors.brand} />
          <Text variant="body" style={{ fontWeight: '700', color: colors.brand }}>{t('signOut')}</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

/** Переключатель в стиле soft UI: вдавленная дорожка, выпуклый бегунок, красный — включено. */
function Switch({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  const { colors } = useTheme();
  const x = useSharedValue(value ? 1 : 0);
  React.useEffect(() => {
    x.value = withTiming(value ? 1 : 0, { duration: 260 });
  }, [value, x]);
  const thumb = useAnimatedStyle(() => ({ transform: [{ translateX: x.value * 22 }] }));
  return (
    <Pressable onPress={() => onChange(!value)} scaleTo={0.95} style={[{ width: 56, height: 32, borderRadius: 16, padding: 3, backgroundColor: value ? colors.brand : colors.card }, value ? null : neu(colors, 'insetSm')]}>
      <Animated.View style={[{ width: 26, height: 26, borderRadius: 13, backgroundColor: '#fff' }, { boxShadow: '0px 2px 5px rgba(0,0,0,0.25)' } as any, thumb]} />
    </Pressable>
  );
}
