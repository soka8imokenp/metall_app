import React from 'react';
import { StyleProp, StyleSheet, View, ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Circle } from 'react-native-svg';
import { useTheme } from '@/theme/ThemeProvider';

/**
 * Материал «стальная пластина». Не плоская заливка: лёгкий перелив сверху
 * вниз (верх светлее, как у листа металла под верхним светом) и
 * отражающая кромка в 1 pt — светлая сверху, темнее снизу.
 * Всё на нативных градиентах, без размытия и шейдеров.
 */
export function steelColors(isDark: boolean, tone: 'plate' | 'dark' = 'plate') {
  if (tone === 'dark') {
    return {
      face: ['#2c3039', '#1b1e24'] as const,
      edge: ['rgba(255,255,255,0.22)', 'rgba(255,255,255,0.02)'] as const,
    };
  }
  return isDark
    ? { face: ['#2a2d35', '#1f2228'] as const, edge: ['rgba(255,255,255,0.11)', 'rgba(0,0,0,0.35)'] as const }
    : { face: ['#fbfbfd', '#eceef2'] as const, edge: ['rgba(255,255,255,1)', 'rgba(140,148,166,0.30)'] as const };
}

const OUTER = ['flex', 'flexGrow', 'flexShrink', 'flexBasis', 'width', 'maxWidth', 'minWidth', 'alignSelf', 'margin', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight', 'marginHorizontal', 'marginVertical', 'position', 'top', 'left', 'right', 'bottom', 'zIndex'];

/** Делит стиль: геометрия — снаружи (рамка), раскладка содержимого — внутри. */
export function splitStyle(style: StyleProp<ViewStyle>) {
  const flat = (StyleSheet.flatten(style) ?? {}) as Record<string, any>;
  const outer: Record<string, any> = {};
  const inner: Record<string, any> = {};
  for (const [k, v] of Object.entries(flat)) (OUTER.includes(k) ? outer : inner)[k] = v;
  return { outer: outer as ViewStyle, inner: inner as ViewStyle };
}

export function SteelSurface({ radius = 20, tone = 'plate', children, innerStyle }: { radius?: number; tone?: 'plate' | 'dark'; children?: React.ReactNode; innerStyle?: StyleProp<ViewStyle> }) {
  const { colors } = useTheme();
  const c = steelColors(colors.isDark, tone);
  return (
    <>
      <LinearGradient colors={c.edge as any} start={{ x: 0.3, y: 0 }} end={{ x: 0.7, y: 1 }} style={[StyleSheet.absoluteFill, { borderRadius: radius }]} />
      <LinearGradient colors={c.face as any} start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }} style={[StyleSheet.absoluteFill, { margin: 1, borderRadius: radius - 1 }]} />
      <View style={[{ borderRadius: radius }, innerStyle]}>{children}</View>
    </>
  );
}

/**
 * Сечение трубы в ППУ-изоляции — фирменный мотив: стальная труба (толстое
 * кольцо), слой пенополиуретана (пунктир — пористость) и оболочка (тонкое
 * кольцо). Это то, что производит завод заказчика, а не украшение «вообще».
 */
export function PipeRings({ size = 120, color = '#ce1f3c', opacity = 0.12, style }: { size?: number; color?: string; opacity?: number; style?: StyleProp<ViewStyle> }) {
  const c = size / 2;
  return (
    <View pointerEvents="none" style={[{ position: 'absolute', width: size, height: size, opacity }, style]}>
      <Svg width={size} height={size}>
        {/* оболочка */}
        <Circle cx={c} cy={c} r={c - 1.5} stroke={color} strokeWidth={2} fill="none" />
        {/* пенополиуретан */}
        <Circle cx={c} cy={c} r={c * 0.76} stroke={color} strokeWidth={c * 0.3} strokeDasharray={`${c * 0.05} ${c * 0.07}`} fill="none" opacity={0.45} />
        {/* стальная труба */}
        <Circle cx={c} cy={c} r={c * 0.5} stroke={color} strokeWidth={c * 0.1} fill="none" />
      </Svg>
    </View>
  );
}
