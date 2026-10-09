import React from 'react';
import { Image } from 'expo-image';
import { useTheme } from '@/theme/ThemeProvider';

/** Знак и название — файлы заказчика, как в вебе; знак — красная плашка, как есть; надпись красится темой (tint). */
export function BrandMark({ height = 56 }: { height?: number }) {
  return <Image source={require('../../assets/brand/metall-asia-mark.png')} style={{ height, width: height * (512 / 236) }} contentFit="contain" />;
}

export function BrandWordmark({ height = 14, color }: { height?: number; color?: string }) {
  const { colors } = useTheme();
  return <Image source={require('../../assets/brand/metall-asia-wordmark.png')} style={{ height, width: height * (344 / 31) }} contentFit="contain" tintColor={color ?? colors.text} />;
}
