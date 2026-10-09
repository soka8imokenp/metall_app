import React, { createContext, useContext, useEffect } from 'react';
import { StyleProp, ViewStyle } from 'react-native';
import Animated, { Easing, SharedValue, useAnimatedReaction, useAnimatedStyle, useSharedValue, withDelay, withTiming } from 'react-native-reanimated';

/**
 * Движение в духе iOS: без пружин с перелётом, короткие расстояния, долгий
 * мягкий выход. Кривые — те, что Apple использует для листов и переходов.
 */
export const EASE_OUT = Easing.bezier(0.22, 1, 0.36, 1); // плавный выход
export const EASE_SHEET = Easing.bezier(0.32, 0.72, 0, 1); // лист iOS
export const EASE_IN_OUT = Easing.bezier(0.45, 0, 0.25, 1);

export const T = { fast: 160, base: 280, slow: 420 };

/**
 * «Такт» сборки экрана. Лист экрана поднимает его при каждом заходе на экран
 * и при смене вкладки-фильтра; каждая карточка, подписанная на такт,
 * собирается заново со своей задержкой. Работает целиком на UI-потоке:
 * смена такта не перерисовывает React-дерево.
 */
export const RevealTick = createContext<SharedValue<number> | null>(null);

const MAX_STAGGER = 8;

/**
 * Карточка «собирается» на экране, как в Framer Motion: поднимается на 18 pt,
 * чуть увеличивается и проявляется, с задержкой по порядку. Только первые
 * восемь — дальше элементы под экраном, их анимировать незачем.
 */
export function Appear({ i = 0, children, style, distance = 18 }: { i?: number; children: React.ReactNode; style?: StyleProp<ViewStyle>; distance?: number }) {
  const tick = useContext(RevealTick);
  const animate = i < MAX_STAGGER;
  const p = useSharedValue(animate ? 0 : 1);

  const run = () => {
    'worklet';
    if (!animate) return;
    p.value = 0;
    p.value = withDelay(i * 45, withTiming(1, { duration: 520, easing: EASE_OUT }));
  };

  useEffect(() => {
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useAnimatedReaction(
    () => (tick ? tick.value : 0),
    (cur, prev) => {
      if (prev !== null && cur !== prev) run();
    },
  );

  const a = useAnimatedStyle(() => ({
    opacity: p.value,
    transform: [{ translateY: (1 - p.value) * distance }, { scale: 0.965 + p.value * 0.035 }],
  }));
  return <Animated.View style={[style, a]}>{children}</Animated.View>;
}
