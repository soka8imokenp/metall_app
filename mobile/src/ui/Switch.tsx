import React from 'react';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useTheme } from '@/theme/ThemeProvider';
import { Pressable } from './Pressable';
import { neu } from './components';

/** Переключатель в стиле soft UI: вдавленная дорожка, бегунок, красный — включено. */
export function Switch({ value, onChange, disabled }: { value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  const { colors } = useTheme();
  const x = useSharedValue(value ? 1 : 0);
  React.useEffect(() => {
    x.value = withTiming(value ? 1 : 0, { duration: 260 });
  }, [value, x]);
  const thumb = useAnimatedStyle(() => ({ transform: [{ translateX: x.value * 22 }] }));
  return (
    <Pressable
      onPress={() => onChange(!value)}
      scaleTo={0.95}
      style={[{ width: 56, height: 32, borderRadius: 16, padding: 3, backgroundColor: value ? colors.brand : colors.card, opacity: disabled ? 0.45 : 1 }, value ? null : neu(colors, 'insetSm')]}
    >
      <Animated.View style={[{ width: 26, height: 26, borderRadius: 13, backgroundColor: '#fff' }, { boxShadow: '0px 2px 5px rgba(0,0,0,0.25)' } as any, thumb]} />
    </Pressable>
  );
}
