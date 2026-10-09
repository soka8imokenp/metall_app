import React from 'react';
import { StyleSheet, Text as RNText, TextProps, TextStyle } from 'react-native';
import { useTheme } from '@/theme/ThemeProvider';

type Variant = 'largeTitle' | 'title' | 'headline' | 'body' | 'callout' | 'caption' | 'label' | 'mono';
type Tone = 'primary' | 'secondary' | 'muted' | 'danger' | 'success' | 'warning' | 'accentFg';

/** Inter: у кастомных шрифтов в RN вес задаётся семейством, а не fontWeight — поэтому подбираем семейство по весу. */
const FAMILY: Record<string, string> = {
  '400': 'Inter_400Regular',
  '500': 'Inter_500Medium',
  '600': 'Inter_600SemiBold',
  '700': 'Inter_700Bold',
  normal: 'Inter_400Regular',
  bold: 'Inter_700Bold',
};
const family = (w?: string | number) => FAMILY[String(w ?? '400')] ?? 'Inter_500Medium';

const styles: Record<Variant, TextStyle> = {
  largeTitle: { fontSize: 28, lineHeight: 34, fontWeight: '600', letterSpacing: -0.9 },
  title: { fontSize: 20, lineHeight: 26, fontWeight: '600', letterSpacing: -0.5 },
  headline: { fontSize: 15, lineHeight: 21, fontWeight: '600', letterSpacing: -0.2 },
  body: { fontSize: 14, lineHeight: 20, fontWeight: '400', letterSpacing: -0.1 },
  callout: { fontSize: 13, lineHeight: 18, fontWeight: '500', letterSpacing: -0.1 },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: '400' },
  label: { fontSize: 12, lineHeight: 16, fontWeight: '500', letterSpacing: 0.1 },
  mono: { fontSize: 13, lineHeight: 18, fontWeight: '500', fontVariant: ['tabular-nums'] },
};

export function Text({ variant = 'body', tone = 'primary', style, num, ...rest }: TextProps & { variant?: Variant; tone?: Tone; num?: boolean }) {
  const { colors } = useTheme();
  const color =
    tone === 'primary' ? colors.text
    : tone === 'secondary' ? colors.textSecondary
    : tone === 'muted' ? colors.textMuted
    : tone === 'danger' ? colors.danger
    : tone === 'success' ? colors.success
    : tone === 'warning' ? colors.warning
    : colors.accentFg;
  const flat = StyleSheet.flatten([styles[variant], { color }, num && { fontVariant: ['tabular-nums'] as TextStyle['fontVariant'] }, style]) as TextStyle;
  // fontWeight остаётся в стиле: на вебе он нужен для синтеза, на телефоне семейство решает
  return <RNText {...rest} style={[flat, { fontFamily: family(flat.fontWeight) }]} />;
}
