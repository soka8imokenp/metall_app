import React, { createContext, useCallback, useContext, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import Animated, { runOnJS, useAnimatedProps, useAnimatedStyle, useSharedValue, withDelay, withSequence, withTiming } from 'react-native-reanimated';
import Svg, { Circle, Path } from 'react-native-svg';
import * as Haptics from 'expo-haptics';
import { Text } from './Text';
import { neu } from './components';
import { EASE_OUT } from './motion';
import { useTheme } from '@/theme/ThemeProvider';

type Ctx = { play: (label: string) => void };
const SuccessCtx = createContext<Ctx>({ play: () => {} });
export const useSuccess = () => useContext(SuccessCtx);

const ACircle = Animated.createAnimatedComponent(Circle);
const APath = Animated.createAnimatedComponent(Path);
const SIZE = 96;
const R = 40;
const RING = 2 * Math.PI * R;
const CHECK = 'M30 49 L43 62 L67 36';
const CHECK_LEN = 56;

/**
 * Подтверждение важного действия (согласовано, подписано, проведено):
 * кольцо прорисовывается по кругу, внутри рисуется галочка, телефон отвечает
 * «успешной» вибрацией. Не перекрывает экран надолго: ~1,2 с и исчезает.
 */
export function SuccessProvider({ children }: { children: React.ReactNode }) {
  const { colors } = useTheme();
  const [label, setLabel] = useState<string | null>(null);
  const ring = useSharedValue(0);
  const check = useSharedValue(0);
  const show = useSharedValue(0);

  const hide = useCallback(() => setLabel(null), []);
  const play = useCallback(
    (l: string) => {
      setLabel(l);
      ring.value = 0;
      check.value = 0;
      show.value = 0;
      show.value = withSequence(
        withTiming(1, { duration: 220, easing: EASE_OUT }),
        withDelay(950, withTiming(0, { duration: 260 }, (f) => { if (f) runOnJS(hide)(); })),
      );
      ring.value = withDelay(80, withTiming(1, { duration: 520, easing: EASE_OUT }));
      check.value = withDelay(420, withTiming(1, { duration: 300, easing: EASE_OUT }));
      if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    },
    [ring, check, show, hide],
  );

  const wrap = useAnimatedStyle(() => ({ opacity: show.value }));
  const lens = useAnimatedStyle(() => ({ transform: [{ scale: 0.82 + show.value * 0.18 }] }));
  const ringProps = useAnimatedProps(() => ({ strokeDashoffset: RING * (1 - ring.value) }));
  const checkProps = useAnimatedProps(() => ({ strokeDashoffset: CHECK_LEN * (1 - check.value) }));

  return (
    <SuccessCtx.Provider value={{ play }}>
      {children}
      {label !== null && (
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center', backgroundColor: colors.isDark ? 'rgba(0,0,0,0.35)' : 'rgba(231,233,238,0.55)' }, wrap]}>
          <Animated.View style={[{ alignItems: 'center', gap: 14, paddingHorizontal: 28, paddingTop: 26, paddingBottom: 20, borderRadius: 30, backgroundColor: colors.card }, neu(colors, 'raisedLg'), lens]}>
            <View style={[{ width: SIZE + 12, height: SIZE + 12, borderRadius: (SIZE + 12) / 2, backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center' }, neu(colors, 'inset')]}>
              <Svg width={SIZE} height={SIZE} viewBox="0 0 96 96">
                <Circle cx={48} cy={48} r={R} stroke={colors.muted} strokeWidth={7} fill="none" />
                <ACircle cx={48} cy={48} r={R} stroke={colors.success} strokeWidth={7} fill="none" strokeLinecap="round" strokeDasharray={`${RING} ${RING}`} animatedProps={ringProps} transform="rotate(-90 48 48)" />
                <APath d={CHECK} stroke={colors.success} strokeWidth={8} fill="none" strokeLinecap="round" strokeLinejoin="round" strokeDasharray={`${CHECK_LEN} ${CHECK_LEN}`} animatedProps={checkProps} />
              </Svg>
            </View>
            <Text variant="headline" style={{ fontWeight: '700' }}>{label}</Text>
          </Animated.View>
        </Animated.View>
      )}
    </SuccessCtx.Provider>
  );
}
