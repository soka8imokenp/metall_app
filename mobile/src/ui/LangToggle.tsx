import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useI18n, Locale } from '@/i18n';
import { useTheme } from '@/theme/ThemeProvider';
import { Pressable } from './Pressable';
import { Text } from './Text';
import { neu } from './components';
import { EASE_OUT } from './motion';
import { Feather } from './Icon';

/**
 * Тумблер языка: вдавленная дорожка, по ней скользит выпуклая «таблетка».
 * Нажатие в любом месте переключает язык.
 */
export function LangToggle({ width = 116, height = 40 }: { width?: number; height?: number }) {
  const { locale, setLocale } = useI18n();
  const { colors } = useTheme();
  const pad = 4;
  const half = (width - pad * 2) / 2;
  const x = useSharedValue(locale === 'uz' ? half : 0);
  const [, force] = useState(0);
  useEffect(() => {
    x.value = withTiming(locale === 'uz' ? half : 0, { duration: 320, easing: EASE_OUT });
    force((n) => n + 1);
  }, [locale, half, x]);
  const thumb = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  const opts: { v: Locale; l: string }[] = [{ v: 'ru', l: 'RU' }, { v: 'uz', l: 'UZ' }];
  return (
    <Pressable
      onPress={() => setLocale(locale === 'ru' ? 'uz' : 'ru')}
      scaleTo={0.97}
      accessibilityLabel="language"
      style={[{ width, height, borderRadius: height / 2, backgroundColor: colors.card, padding: pad, flexDirection: 'row' }, neu(colors, 'insetSm')]}
    >
      <Animated.View
        style={[
          { position: 'absolute', top: pad, left: pad, width: half, height: height - pad * 2, borderRadius: (height - pad * 2) / 2, backgroundColor: colors.brand },
          { boxShadow: '0px 3px 8px rgba(206,31,60,0.35)' } as any,
          thumb,
        ]}
      />
      {opts.map((o) => (
        <View key={o.v} style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <Text variant="callout" style={{ fontWeight: '700', letterSpacing: 0.6, color: locale === o.v ? '#fff' : colors.textSecondary }}>{o.l}</Text>
        </View>
      ))}
    </Pressable>
  );
}

/** Тумблер темы: солнце и луна, та же дорожка и «таблетка», что у языка. */
export function ThemeToggle({ width = 116, height = 40 }: { width?: number; height?: number }) {
  const { colors, setMode } = useTheme();
  const pad = 4;
  const half = (width - pad * 2) / 2;
  const isDark = colors.isDark;
  const x = useSharedValue(isDark ? half : 0);
  useEffect(() => {
    x.value = withTiming(isDark ? half : 0, { duration: 320, easing: EASE_OUT });
  }, [isDark, half, x]);
  const thumb = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  return (
    <Pressable
      onPress={() => setMode(isDark ? 'light' : 'dark')}
      scaleTo={0.97}
      accessibilityLabel="theme"
      style={[{ width, height, borderRadius: height / 2, backgroundColor: colors.card, padding: pad, flexDirection: 'row' }, neu(colors, 'insetSm')]}
    >
      <Animated.View
        style={[
          { position: 'absolute', top: pad, left: pad, width: half, height: height - pad * 2, borderRadius: (height - pad * 2) / 2, backgroundColor: colors.accent },
          { boxShadow: isDark ? '0px 3px 8px rgba(0,0,0,0.4)' : '0px 3px 8px rgba(31,34,42,0.3)' } as any,
          thumb,
        ]}
      />
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <Feather name="sun" size={17} color={!isDark ? colors.accentFg : colors.textSecondary} strokeWidth={2.2} />
      </View>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <Feather name="moon" size={16} color={isDark ? colors.accentFg : colors.textSecondary} strokeWidth={2.2} />
      </View>
    </Pressable>
  );
}
