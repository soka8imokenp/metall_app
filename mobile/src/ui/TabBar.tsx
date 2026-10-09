import React from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather, IconName } from './Icon';
import { useTheme } from '@/theme/ThemeProvider';
import { Pressable } from './Pressable';
import { Text } from './Text';

export type TabItem = { key: string; label: string; icon: IconName; badge?: number };

/** Матовое стекло: настоящее размытие на iOS, Android 12+ и в вебе; на старом Android — полупрозрачная подложка. */
export function Glass({ target, style, children, strong }: { target?: React.RefObject<View | null>; style?: any; children?: React.ReactNode; strong?: boolean }) {
  const { colors } = useTheme();
  const tint = colors.isDark ? 'rgba(27,29,34,0.62)' : 'rgba(244,245,248,0.66)';
  if (Platform.OS === 'web') {
    return (
      <View style={[style, { backgroundColor: tint }, { backdropFilter: 'blur(24px) saturate(1.6)', WebkitBackdropFilter: 'blur(24px) saturate(1.6)' } as any]}>
        {children}
      </View>
    );
  }
  return (
    <View style={[style, { overflow: 'hidden' }]}>
      <BlurView
        blurTarget={target}
        blurMethod="dimezisBlurViewSdk31Plus"
        intensity={strong ? 80 : 60}
        tint={colors.isDark ? 'dark' : 'light'}
        style={StyleSheet.absoluteFill}
      />
      <View style={[StyleSheet.absoluteFill, { backgroundColor: tint }]} />
      {children}
    </View>
  );
}

const Item = React.memo(function Item({ it, on, onPress }: { it: TabItem; on: boolean; onPress: (k: string) => void }) {
  const { colors } = useTheme();
  const color = on ? colors.brand : colors.text;
  return (
    <Pressable
      onPress={() => onPress(it.key)}
      accessibilityLabel={it.label}
      haptic={!on}
      scaleTo={0.92}
      style={{ flex: 1, height: 58, alignItems: 'center', justifyContent: 'center', gap: 3 }}
    >
      <Feather name={it.icon} size={23} color={color} strokeWidth={on ? 2.3 : 1.8} />
      <Text variant="caption" numberOfLines={1} style={{ fontSize: 11, lineHeight: 13, fontWeight: on ? '700' : '600', color }}>
        {it.label}
      </Text>
      {!!it.badge && !on && (
        <View style={{ position: 'absolute', top: 6, right: '22%', minWidth: 16, height: 16, borderRadius: 8, backgroundColor: colors.brand, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 }}>
          <Text variant="caption" style={{ color: '#fff', fontSize: 10, lineHeight: 12, fontWeight: '700' }}>{it.badge > 99 ? '99+' : it.badge}</Text>
        </View>
      )}
    </Pressable>
  );
});

/**
 * Нижняя панель как в Telegram: «таблетка» из матового стекла висит над
 * содержимым; выбранная вкладка — красная, без подложки. Под системными
 * кнопками телефона содержимое плавно затухает градиентом, а не обрывается
 * сплошной полосой.
 */
export function FloatingTabBar({ items, active, onPress, target }: { items: TabItem[]; active: string; onPress: (key: string) => void; target?: React.RefObject<View | null> }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const fade = colors.isDark ? '27,29,34' : '231,233,238';
  return (
    <>
      <LinearGradient
        pointerEvents="none"
        colors={[`rgba(${fade},0)`, `rgba(${fade},0.6)`, `rgba(${fade},0.94)`]}
        locations={[0, 0.5, 1]}
        style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: insets.bottom + 100 }}
      />
      <View pointerEvents="box-none" style={{ position: 'absolute', left: 0, right: 0, bottom: insets.bottom + 10, alignItems: 'center' }}>
        <Glass
          target={target}
          strong
          style={[
            {
              width: '92%',
              maxWidth: 480,
              borderRadius: 34,
              padding: 6,
              borderWidth: 1,
              borderColor: colors.isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.7)',
            },
            { boxShadow: colors.isDark ? '0px 10px 30px rgba(0,0,0,0.45)' : '0px 10px 30px rgba(90,98,118,0.22)' } as any,
          ]}
        >
          <View style={{ flexDirection: 'row' }}>
            {items.map((it) => (
              <Item key={it.key} it={it} on={it.key === active} onPress={onPress} />
            ))}
          </View>
        </Glass>
      </View>
    </>
  );
}
