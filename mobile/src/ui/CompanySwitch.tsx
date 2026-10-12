import React, { useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { Feather } from '@/ui/Icon';
import { useAuth } from '@/auth/AuthProvider';
import { useI18n } from '@/i18n';
import { useTheme } from '@/theme/ThemeProvider';
import type { Dict } from '@/i18n/ru';
import { Pressable } from './Pressable';
import { Text } from './Text';
import { Sheet } from './Sheet';
import { neu } from './components';
import { BrandMark } from './Brand';
import { PipeRings, SteelSurface } from './Steel';

/**
 * Охват данных: обе компании, «Металл Азия» (торговля) или трубный завод.
 * От выбора зависят все разделы — поэтому он виден в шапке каждого главного
 * экрана строкой под заголовком, а не спрятан в меню.
 */
export const SCOPES: { key: 'all' | 'trade' | 'plant'; name: keyof Dict; sub: keyof Dict }[] = [
  { key: 'all', name: 'coAll', sub: 'coAllSub' },
  { key: 'trade', name: 'coTrade', sub: 'coTradeSub' },
  { key: 'plant', name: 'coPlant', sub: 'coPlantSub' },
];

export function useScope() {
  const { companies, companyKey, setCompanyKey } = useAuth();
  const list = SCOPES.filter((s) => s.key === 'all' || companies.some((c) => c.code === s.key));
  const cur = companyKey === 'all' ? 'all' : companies.find((c) => c.uid === companyKey)?.code ?? 'all';
  const set = (k: 'all' | 'trade' | 'plant') => {
    const uid = k === 'all' ? 'all' : companies.find((c) => c.code === k)?.uid;
    if (uid && uid !== companyKey) setCompanyKey(uid);
  };
  return { list, cur: cur as 'all' | 'trade' | 'plant', set, enabled: companies.length > 1 };
}

/** Знак охвата: два сечения — обе компании, марка — торговля, сечение трубы — завод. */
function ScopeGlyph({ k, on }: { k: 'all' | 'trade' | 'plant'; on: boolean }) {
  const { colors } = useTheme();
  const c = on ? colors.brand : colors.textSecondary;
  return (
    <View style={[{ width: 52, height: 52, borderRadius: 16, backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }, neu(colors, 'insetSm')]}>
      {k === 'trade' ? (
        <View style={{ opacity: on ? 1 : 0.75 }}><BrandMark height={20} /></View>
      ) : k === 'plant' ? (
        <PipeRings size={34} color={c} opacity={1} style={{ left: 9, top: 9 }} />
      ) : (
        <>
          <PipeRings size={26} color={c} opacity={0.95} style={{ left: 6, top: 13 }} />
          <PipeRings size={26} color={c} opacity={0.55} style={{ left: 20, top: 13 }} />
        </>
      )}
    </View>
  );
}

/**
 * Заголовок шапки с охватом: касание — выбор компании, свайп вбок —
 * следующая/предыдущая с вибрацией. Если компания у человека одна —
 * просто заголовок.
 */
export function ScopeTitle({ children }: { children: React.ReactNode }) {
  const scope = useScope();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (!scope.enabled) return <>{children}</>;

  const cycle = (dir: number) => {
    const i = scope.list.findIndex((s) => s.key === scope.cur);
    const next = scope.list[(i + dir + scope.list.length) % scope.list.length];
    if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    scope.set(next.key);
  };
  const swipe = Gesture.Pan()
    .activeOffsetX([-18, 18])
    .failOffsetY([-12, 12])
    .onEnd((e) => {
      if (Math.abs(e.translationX) > 40) runOnJS(cycle)(e.translationX < 0 ? 1 : -1);
    });
  const label = t(SCOPES.find((s) => s.key === scope.cur)!.name);

  return (
    <>
      <GestureDetector gesture={swipe}>
        <Pressable onPress={() => setOpen(true)} scaleTo={0.96} style={{ flex: 1, alignItems: 'center', gap: 3 }} accessibilityLabel={label}>
          {children}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <Text style={{ color: 'rgba(255,255,255,0.72)', fontSize: 10, letterSpacing: 1.2, textTransform: 'uppercase', fontWeight: '700' }} numberOfLines={1}>{label}</Text>
            <Feather name="chevron-down" size={11} color="rgba(255,255,255,0.72)" strokeWidth={2.6} />
          </View>
        </Pressable>
      </GestureDetector>
      <ScopeSheet visible={open} onClose={() => setOpen(false)} />
    </>
  );
}

export function ScopeSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const scope = useScope();
  const { t } = useI18n();
  const { colors } = useTheme();
  return (
    <Sheet visible={visible} onClose={onClose} title={t('coTitle')}>
      <Text variant="callout" tone="secondary" style={{ marginTop: -6 }}>{t('coHint')}</Text>
      {scope.list.map((s) => {
        const on = s.key === scope.cur;
        return (
          <Pressable
            key={s.key}
            onPress={() => { scope.set(s.key); onClose(); }}
            scaleTo={0.98}
            style={[{ borderRadius: 22 }, on ? neu(colors, 'inset') : neu(colors, 'raised')]}
          >
            {on ? (
              <View style={[StyleSheet.absoluteFill, { borderRadius: 22, backgroundColor: colors.card }]} />
            ) : (
              <SteelSurface radius={22} />
            )}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14 }}>
              <ScopeGlyph k={s.key} on={on} />
              <View style={{ flex: 1, gap: 2 }}>
                <Text variant="headline" style={{ color: on ? colors.brand : colors.text }}>{t(s.name)}</Text>
                <Text variant="caption" tone="secondary">{t(s.sub)}</Text>
              </View>
              <View style={[{ width: 22, height: 22, borderRadius: 11, backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center' }, neu(colors, 'insetSm')]}>
                {on && <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: colors.brand, boxShadow: `0px 0px 6px ${colors.brand}` } as any} />}
              </View>
            </View>
          </Pressable>
        );
      })}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, justifyContent: 'center', marginTop: 2 }}>
        <Feather name="repeat" size={13} color={colors.textMuted} />
        <Text variant="caption" tone="muted">{t('coSwipeHint')}</Text>
      </View>
    </Sheet>
  );
}

/** Старый чип выбора компании — теперь тот же лист. */
export function CompanyChip() {
  const scope = useScope();
  const { t } = useI18n();
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  if (!scope.enabled) return null;
  return (
    <>
      <Pressable onPress={() => setOpen(true)} style={[{ flexDirection: 'row', alignItems: 'center', gap: 6, height: 38, paddingHorizontal: 14, borderRadius: 19, backgroundColor: colors.card }, neu(colors, 'raisedSm')]}>
        <Feather name="briefcase" size={14} color={colors.textSecondary} />
        <Text variant="callout" style={{ fontWeight: '600' }}>{t(SCOPES.find((s) => s.key === scope.cur)!.name)}</Text>
        <Feather name="chevron-down" size={14} color={colors.textMuted} />
      </Pressable>
      <ScopeSheet visible={open} onClose={() => setOpen(false)} />
    </>
  );
}
