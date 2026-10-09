import React, { useState } from 'react';
import { Pressable as RNPressable, PressableProps, StyleProp, ViewStyle, Platform } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { EASE_OUT } from './motion';

const AnimatedPressable = Animated.createAnimatedComponent(RNPressable);

/**
 * Нажатие: элемент чуть уменьшается (без пружины) и, если задан `pressedStyle`,
 * «вдавливается» — меняет выпуклую тень на впалую. Отклик вибрацией — лёгкий.
 */
export function Pressable({
  style, pressedStyle, haptic = true, scaleTo = 0.975, onPressIn, onPressOut, onPress, ...rest
}: Omit<PressableProps, 'style'> & { style?: StyleProp<ViewStyle>; pressedStyle?: StyleProp<ViewStyle>; haptic?: boolean; scaleTo?: number }) {
  const s = useSharedValue(1);
  const [down, setDown] = useState(false);
  const a = useAnimatedStyle(() => ({ transform: [{ scale: s.value }] }));
  return (
    <AnimatedPressable
      {...rest}
      onPressIn={(e) => {
        s.value = withTiming(scaleTo, { duration: 110, easing: EASE_OUT });
        if (pressedStyle) setDown(true);
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        s.value = withTiming(1, { duration: 260, easing: EASE_OUT });
        if (pressedStyle) setDown(false);
        onPressOut?.(e);
      }}
      onPress={(e) => {
        if (haptic && Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
        onPress?.(e);
      }}
      style={[style, down && pressedStyle, a]}
    />
  );
}
