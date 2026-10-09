import React from 'react';
import { StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather, IconName } from './Icon';
import { Pressable } from './Pressable';
import { Text } from './Text';
import { BrandWordmark } from './Brand';
import { useTheme } from '@/theme/ThemeProvider';
import { useDrawer } from './Drawer';
import { PipeRings } from './Steel';

export const OnBandCtx = React.createContext(false);

export type Metric = { label: string; value: string; sub?: string; action?: { label: string; onPress: () => void } };

/** Кнопка на цветной шапке: полупрозрачная плитка. */
export function BandButton({ name, onPress, badge }: { name: IconName; onPress?: () => void; badge?: boolean }) {
  return (
    <Pressable onPress={onPress} style={{ width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.16)' }}>
      <Feather name={name} size={20} color="#fff" />
      {badge && <View style={{ position: 'absolute', top: 9, right: 10, width: 8, height: 8, borderRadius: 4, backgroundColor: '#fff' }} />}
    </Pressable>
  );
}

/**
 * Цветная шапка: красный градиент знака и графитовая «волна».
 *
 * Фон собран из обычных View, а не из SVG: SVG с процентными размерами на
 * Android рисовался обрезанным прямоугольником и не тянулся за высотой шапки.
 * Градиент — нативный (expo-linear-gradient), волна — большой повёрнутый
 * прямоугольник со скруглённым углом, обрезанный рамкой шапки.
 */
export function Band({
  title, wordmark, back, right, metrics, children,
}: {
  title?: string; wordmark?: boolean; back?: () => void; right?: React.ReactNode; metrics?: Metric[]; children?: React.ReactNode;
}) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const drawer = useDrawer();
  // у корневых экранов шапка всегда с показателями: пока они грузятся — прочерки, высота та же
  if (!back && !metrics) metrics = [{ label: ' ', value: '—' }, { label: ' ', value: '—' }];
  return (
    <View style={{ paddingTop: Math.max(insets.top, 14) + 6, paddingHorizontal: 20, paddingBottom: metrics ? 48 : 40, overflow: 'hidden' }}>
      <LinearGradient colors={[colors.bandFrom, colors.bandTo]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
      {/* графитовая волна снизу-слева */}
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: '-30%',
          right: '-30%',
          bottom: metrics ? '-118%' : '-150%',
          height: metrics ? '190%' : '220%',
          borderTopLeftRadius: 900,
          borderTopRightRadius: 260,
          backgroundColor: colors.graphite,
          opacity: 0.95,
          transform: [{ rotate: '-11deg' }],
        }}
      />
      {/* сечение трубы в изоляции — фирменный знак продукции, едва заметно */}
      <PipeRings size={210} color="#ffffff" opacity={0.08} style={{ right: -54, top: Math.max(insets.top, 14) - 6 }} />
      {/* мягкий блик сверху, чтобы красный не был плоским */}
      <LinearGradient colors={['rgba(255,255,255,0.12)', 'rgba(255,255,255,0)']} style={[StyleSheet.absoluteFill, { height: 120 }]} pointerEvents="none" />

      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 44 }}>
        {back ? <BandButton name="chevron-left" onPress={back} /> : <BandButton name="grid" onPress={drawer.toggle} />}
        {wordmark ? (
          <BrandWordmark height={12} color="#fff" />
        ) : (
          <Text variant="label" style={{ color: 'rgba(255,255,255,0.9)', letterSpacing: 1.8, textTransform: 'uppercase', fontWeight: '700', flex: 1, textAlign: 'center' }} numberOfLines={1}>{title}</Text>
        )}
        <OnBandCtx.Provider value={true}>
          <View style={{ flexDirection: 'row', gap: 8, minWidth: 42, justifyContent: 'flex-end' }}>{right}</View>
        </OnBandCtx.Provider>
      </View>

      {!!metrics && (
        <View style={{ flexDirection: 'row', marginTop: 20 }}>
          {metrics.map((m, i) => (
            <View key={i} style={{ flex: 1, paddingLeft: i ? 18 : 0, borderLeftWidth: i ? 1 : 0, borderLeftColor: 'rgba(255,255,255,0.22)', gap: 2 }}>
              <Text variant="label" style={{ color: 'rgba(255,255,255,0.72)', fontSize: 11, letterSpacing: 1, textTransform: 'uppercase', fontWeight: '600' }} numberOfLines={1}>{m.label}</Text>
              <Text variant="title" num style={{ color: '#fff', fontSize: 26, lineHeight: 32, letterSpacing: -0.9, fontWeight: '700' }} numberOfLines={1} adjustsFontSizeToFit>{m.value}</Text>
              {/* подпись и кнопка всегда занимают место: шапка одной высоты на всех экранах */}
              <Text variant="caption" style={{ color: 'rgba(255,255,255,0.62)' }} numberOfLines={1}>{m.sub || ' '}</Text>
              {!m.action && <View style={{ height: 42 }} />}
              {!!m.action && (
                <Pressable
                  onPress={m.action.onPress}
                  style={{ marginTop: 10, alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 8, height: 32, paddingHorizontal: 13, borderRadius: 11, backgroundColor: 'rgba(255,255,255,0.14)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)' }}
                >
                  <Text variant="label" style={{ color: '#fff', fontSize: 10.5, letterSpacing: 1.1, textTransform: 'uppercase', fontWeight: '700' }}>{m.action.label}</Text>
                  <Feather name="plus" size={13} color="#fff" strokeWidth={2.4} />
                </Pressable>
              )}
            </View>
          ))}
        </View>
      )}
      {children}
    </View>
  );
}

/** Тело экрана: лист цвета фона, наезжает на шапку скруглёнными углами. */
export function Body({ children, style }: { children: React.ReactNode; style?: any }) {
  const { colors } = useTheme();
  return <View style={[{ marginTop: -28, borderTopLeftRadius: 28, borderTopRightRadius: 28, backgroundColor: colors.canvas, paddingTop: 22, flexGrow: 1 }, style]}>{children}</View>;
}
