import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import Animated, {
  Easing, interpolate, runOnJS, useAnimatedProps, useAnimatedStyle, useSharedValue, withDelay, withTiming,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { Image } from 'expo-image';
import Svg, { Circle, Defs, RadialGradient, Stop } from 'react-native-svg';
import * as Haptics from 'expo-haptics';
import * as SplashScreen from 'expo-splash-screen';

/* ---------- готовность приложения (вход прочитан, шрифты загружены) ---------- */
let readyFlag = false;
const subs = new Set<() => void>();
export function markAppReady() {
  if (readyFlag) return;
  readyFlag = true;
  subs.forEach((f) => f());
}
const useAppReady = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => readyFlag, () => readyFlag);

const ACircle = Animated.createAnimatedComponent(Circle);
const EASE = Easing.bezier(0.22, 1, 0.36, 1);
const S = 220; // поле сечения
const C = S / 2;
const R_SHELL = 96;
const R_FOAM = 74;
const R_STEEL = 48;
const SHELL_LEN = 2 * Math.PI * R_SHELL;
const PLATE_W = 168;
const PLATE_H = 78;
const MIN_SHOW = 2100;

/**
 * Заставка при запуске — то, что делает завод: сечение трубы в ППУ-изоляции
 * (оболочка, пенополиуретан, стальная труба) собирается по кругу, «камера»
 * проходит сквозь трубу, из глубины выходит красная плашка знака, внутри
 * снизу вверх вырастают горы, под ними — надпись и красная черта. Когда
 * приложение готово (вход прочитан, шрифты загружены), заставка растворяется.
 * Всё на нативных анимациях: ни видео, ни Lottie, на любом экране чётко.
 */
export function Intro() {
  const ready = useAppReady();
  const [gone, setGone] = useState(false);
  const [minDone, setMinDone] = useState(false);

  const shell = useSharedValue(0); // прорисовка оболочки
  const foam = useSharedValue(0); // пенополиуретан
  const steel = useSharedValue(0); // стальная труба
  const through = useSharedValue(0); // пролёт сквозь трубу
  const plate = useSharedValue(0); // плашка знака
  const rise = useSharedValue(0); // горы
  const word = useSharedValue(0); // надпись и черта
  const out = useSharedValue(0); // уход

  useEffect(() => {
    if (gone) return;
    // отладка в браузере: ?introAt=1200 — кадр замирает на 1200 мс
    const at = Platform.OS === 'web' ? Number(new URLSearchParams(globalThis.location?.search ?? '').get('introAt')) : NaN;
    if (Number.isFinite(at) && at >= 0) {
      const outE = (x: number) => 1 - Math.pow(1 - x, 3);
      const p = (d: number, len: number, e: (x: number) => number = outE) => e(Math.max(0, Math.min(1, (at - d) / len)));
      shell.value = p(0, 700); foam.value = p(120, 700); steel.value = p(260, 560);
      through.value = p(780, 620, (x) => x * x); plate.value = p(900, 620);
      rise.value = p(1180, 560); word.value = p(1420, 600);
      return;
    }
    // нативная заставка — тот же графит без картинки: переход незаметен
    SplashScreen.hideAsync().catch(() => {});
    shell.value = withTiming(1, { duration: 700, easing: EASE });
    foam.value = withDelay(120, withTiming(1, { duration: 700, easing: EASE }));
    steel.value = withDelay(260, withTiming(1, { duration: 560, easing: EASE }));
    through.value = withDelay(780, withTiming(1, { duration: 620, easing: Easing.in(Easing.quad) }));
    plate.value = withDelay(900, withTiming(1, { duration: 620, easing: EASE }, (f) => {
      if (f && Platform.OS !== 'web') runOnJS(softTap)();
    }));
    rise.value = withDelay(1180, withTiming(1, { duration: 560, easing: EASE }));
    word.value = withDelay(1420, withTiming(1, { duration: 600, easing: EASE }));
    const t = setTimeout(() => setMinDone(true), MIN_SHOW);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (gone || !ready || !minDone) return;
    out.value = withTiming(1, { duration: 420, easing: Easing.inOut(Easing.quad) }, (f) => { if (f) runOnJS(setGone)(true); });
  }, [ready, minDone, gone, out]);

  const shellProps = useAnimatedProps(() => ({ strokeDashoffset: SHELL_LEN * (1 - shell.value) }));
  const rings = useAnimatedStyle(() => ({
    opacity: interpolate(through.value, [0, 0.7, 1], [1, 0.25, 0]),
    transform: [{ scale: 0.9 + steel.value * 0.1 + through.value * 1.6 }],
  }));
  const foamStyle = useAnimatedStyle(() => ({ opacity: foam.value * 0.55, transform: [{ rotate: `${(1 - foam.value) * -70}deg` }] }));
  const steelStyle = useAnimatedStyle(() => ({ opacity: steel.value, transform: [{ scale: 0.55 + steel.value * 0.45 }] }));
  const plateStyle = useAnimatedStyle(() => ({
    opacity: plate.value,
    transform: [{ translateY: (1 - plate.value) * 14 }, { scale: 0.62 + plate.value * 0.38 }],
  }));
  const glow = useAnimatedStyle(() => ({ opacity: plate.value * 0.9, transform: [{ scale: 0.6 + plate.value * 0.4 }] }));
  const mountains = useAnimatedStyle(() => ({ height: rise.value * PLATE_H }));
  const wordStyle = useAnimatedStyle(() => ({ opacity: word.value, transform: [{ translateY: (1 - word.value) * 10 }] }));
  const line = useAnimatedStyle(() => ({ width: word.value * 132 }));
  const root = useAnimatedStyle(() => ({ opacity: 1 - out.value }));
  const content = useAnimatedStyle(() => ({ transform: [{ scale: 1 + out.value * 0.06 }] }));

  if (gone) return null;
  return (
    <Animated.View pointerEvents={ready && minDone ? 'none' : 'auto'} style={[StyleSheet.absoluteFill, { zIndex: 1000 }, root]}>
      <LinearGradient colors={['#1d2028', '#121419', '#0b0c0f']} start={{ x: 0.2, y: 0 }} end={{ x: 0.8, y: 1 }} style={StyleSheet.absoluteFill} />
      <Animated.View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }, content]}>
        {/* красное свечение за знаком */}
        <Animated.View style={[{ position: 'absolute', width: 420, height: 420 }, glow]}>
          <Svg width={420} height={420}>
            <Defs>
              <RadialGradient id="g" cx="50%" cy="50%" r="50%">
                <Stop offset="0" stopColor="#ce1f3c" stopOpacity={0.6} />
                <Stop offset="0.45" stopColor="#ce1f3c" stopOpacity={0.2} />
                <Stop offset="1" stopColor="#ce1f3c" stopOpacity={0} />
              </RadialGradient>
            </Defs>
            <Circle cx={210} cy={210} r={210} fill="url(#g)" />
          </Svg>
        </Animated.View>

        {/* сечение трубы */}
        <Animated.View style={[{ position: 'absolute', width: S, height: S }, rings]}>
          <Svg width={S} height={S} style={{ transform: [{ rotate: '-90deg' }] }}>
            <ACircle cx={C} cy={C} r={R_SHELL} stroke="rgba(255,255,255,0.85)" strokeWidth={3} fill="none" strokeLinecap="round" strokeDasharray={`${SHELL_LEN} ${SHELL_LEN}`} animatedProps={shellProps} />
          </Svg>
          <Animated.View style={[StyleSheet.absoluteFill, foamStyle]}>
            <Svg width={S} height={S}>
              <Circle cx={C} cy={C} r={R_FOAM} stroke="#ffffff" strokeWidth={30} strokeDasharray="3 5" fill="none" opacity={0.5} />
            </Svg>
          </Animated.View>
          <Animated.View style={[StyleSheet.absoluteFill, steelStyle]}>
            <Svg width={S} height={S}>
              <Circle cx={C} cy={C} r={R_STEEL} stroke="#ce1f3c" strokeWidth={10} fill="none" />
            </Svg>
          </Animated.View>
        </Animated.View>

        {/* знак: красная плашка, горы вырастают снизу */}
        <Animated.View style={[{ width: PLATE_W, height: PLATE_H, borderRadius: 16, overflow: 'hidden', boxShadow: '0px 14px 40px rgba(206,31,60,0.45)' } as any, plateStyle]}>
          <LinearGradient colors={['#de2a47', '#c41a35']} start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }} style={StyleSheet.absoluteFill} />
          <LinearGradient colors={['rgba(255,255,255,0.22)', 'rgba(255,255,255,0)']} style={[StyleSheet.absoluteFill, { height: PLATE_H / 2 }]} />
          <Animated.View style={[{ position: 'absolute', left: 0, right: 0, bottom: 0, overflow: 'hidden' }, mountains]}>
            <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: PLATE_H, alignItems: 'center', justifyContent: 'center' }}>
              <Image source={require('../../assets/brand/metall-asia-glyph.png')} style={{ width: PLATE_W * 0.78, height: PLATE_W * 0.78 * (142 / 406) }} contentFit="contain" />
            </View>
          </Animated.View>
        </Animated.View>

        {/* надпись и красная черта */}
        <Animated.View style={[{ alignItems: 'center', marginTop: 26, gap: 12 }, wordStyle]}>
          <Image source={require('../../assets/brand/metall-asia-wordmark-white.png')} style={{ width: 196, height: 196 * (29 / 343) }} contentFit="contain" />
          <Animated.View style={[{ height: 2, borderRadius: 1, backgroundColor: '#ce1f3c' }, line]} />
        </Animated.View>
      </Animated.View>
    </Animated.View>
  );
}

function softTap() {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft).catch(() => {});
}
