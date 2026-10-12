import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { Platform, StyleSheet, Text as RNText, View } from 'react-native';
import Animated, {
  Easing, interpolate, runOnJS, useAnimatedProps, useAnimatedStyle, useSharedValue, withDelay, withTiming,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { Image } from 'expo-image';
import Svg, { Circle, Defs, Line, Path, RadialGradient, Stop } from 'react-native-svg';
import * as Haptics from 'expo-haptics';
import * as SplashScreen from 'expo-splash-screen';

/*
 * Порядок запуска, чтобы заставка шла без рывков:
 *   playing — играет анимация; тяжёлое (экраны, вкладки) не строится;
 *   holding — анимация доиграла и стоит на последнем кадре; под ним строится приложение;
 *   done    — приложение построено, заставка растворилась; теперь можно звать отпечаток.
 */
type Phase = 'playing' | 'holding' | 'done';
let phase: Phase = 'playing';
let appReady = false;
let appMounted = false;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
const setPhase = (p: Phase) => { phase = p; emit(); };
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };

/** Вход прочитан и шрифты загружены. */
export function markAppReady() { if (!appReady) { appReady = true; emit(); } }
/** Экраны приложения построены (первый кадр под заставкой). */
export function markAppMounted() { if (!appMounted) { appMounted = true; emit(); } }
export const useIntroPhase = () => useSyncExternalStore(subscribe, () => phase, () => phase);
const useFlags = () => useSyncExternalStore(subscribe, () => (appReady ? 1 : 0) + (appMounted ? 2 : 0), () => 0);

const AnimatedPath = Animated.createAnimatedComponent(Path);
const ALine = Animated.createAnimatedComponent(Line);
const EASE = Easing.bezier(0.22, 1, 0.36, 1);
const IN_OUT = Easing.bezier(0.65, 0, 0.35, 1);

const S = 300; // поле рисунка
const C = S / 2;
const R = 62; // стальная труба
const L = 2 * Math.PI * R; // длина полосы = окружность трубы
const N = 72; // точек на полосе
const PLATE_W = 156;
const PLATE_H = 72;

/**
 * Заставка — как делают трубу: на чертеже проводятся осевые линии, стальная
 * полоса выезжает и сворачивается в трубу (как на стане ТЭСА), шов
 * сваривается — вспышка и искры, нарастает слой ППУ-изоляции и оболочка,
 * рядом считается диаметр. Готовое сечение поднимается, под ним проявляется
 * METALL ASIA. Всё на нативных анимациях.
 */
export function Intro() {
  const p = useIntroPhase();
  const flags = useFlags();
  const [gone, setGone] = useState(false);

  const axes = useSharedValue(0); // осевые линии чертежа
  const strip = useSharedValue(0); // полоса выезжает
  const bend = useSharedValue(0); // полоса сворачивается
  const weld = useSharedValue(0); // сварка шва
  const foam = useSharedValue(0); // ППУ и оболочка
  const logo = useSharedValue(0); // сечение превращается в знак
  const lift = useSharedValue(0); // надпись
  const out = useSharedValue(0); // уход

  useEffect(() => {
    // отладка в браузере: ?introAt=1200 — кадр замирает на 1200 мс
    const at = Platform.OS === 'web' ? Number(new URLSearchParams(globalThis.location?.search ?? '').get('introAt')) : NaN;
    if (Number.isFinite(at) && at >= 0) {
      const outE = (x: number) => 1 - Math.pow(1 - x, 3);
      const io = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
      const q = (d: number, len: number, e: (x: number) => number = outE) => e(Math.max(0, Math.min(1, (at - d) / len)));
      axes.value = q(0, 600); strip.value = q(150, 550); bend.value = q(650, 750, io);
      weld.value = q(1380, 700, (x) => x); foam.value = q(1550, 700); logo.value = q(2050, 650); lift.value = q(2450, 700);
      return;
    }
    SplashScreen.hideAsync().catch(() => {});
    axes.value = withTiming(1, { duration: 600, easing: EASE });
    strip.value = withDelay(150, withTiming(1, { duration: 550, easing: EASE }));
    bend.value = withDelay(650, withTiming(1, { duration: 750, easing: IN_OUT }, (f) => { if (f) runOnJS(tick)('weld'); }));
    weld.value = withDelay(1380, withTiming(1, { duration: 700, easing: Easing.linear }));
    foam.value = withDelay(1550, withTiming(1, { duration: 700, easing: EASE }));
    logo.value = withDelay(2050, withTiming(1, { duration: 650, easing: EASE }, (f) => { if (f) runOnJS(soft)(); }));
    lift.value = withDelay(2450, withTiming(1, { duration: 700, easing: EASE }, (f) => { if (f) runOnJS(setPhase)('holding'); }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // приложение построено под последним кадром — растворяемся
  useEffect(() => {
    if (p !== 'holding' || (flags & 3) !== 3 || gone) return;
    out.value = withDelay(120, withTiming(1, { duration: 480, easing: Easing.inOut(Easing.quad) }, (f) => {
      if (f) { runOnJS(setGone)(true); runOnJS(setPhase)('done'); }
    }));
  }, [p, flags, gone, out]);

  /* полоса → труба: дуга постоянной длины с растущей кривизной */
  const stripProps = useAnimatedProps(() => {
    const th = Math.max(0.0001, bend.value * 2 * Math.PI * 0.997);
    const k = th / L;
    const len = L * strip.value;
    const y0 = C - R * bend.value; // готовая труба встаёт в центр
    let d = '';
    for (let i = 0; i <= N; i++) {
      const s = (i / N - 0.5) * len;
      const x = C + Math.sin(k * s) / k;
      const y = y0 + (1 - Math.cos(k * s)) / k;
      d += (i ? 'L' : 'M') + x.toFixed(2) + ',' + y.toFixed(2);
    }
    return { d };
  });
  // при сварке шов раскаляется: поверх полосы — её оранжевая копия, вспыхивает и гаснет
  const hot = useAnimatedStyle(() => ({ opacity: interpolate(weld.value, [0, 0.1, 0.5, 1], [0, 1, 0.15, 0], 'clamp') }));

  const axisH = useAnimatedProps(() => ({ x1: C - axes.value * C, x2: C + axes.value * C }));
  const axisV = useAnimatedProps(() => ({ y1: C - axes.value * C, y2: C + axes.value * C }));
  const axesStyle = useAnimatedStyle(() => ({ opacity: interpolate(logo.value, [0, 1], [1, 0.3]) }));

  // вспышка в точке шва (низ трубы)
  const flash = useAnimatedStyle(() => ({
    opacity: interpolate(weld.value, [0, 0.06, 0.4], [0, 1, 0], 'clamp'),
    transform: [{ scale: interpolate(weld.value, [0, 0.1, 0.4], [0.2, 1, 1.8], 'clamp') }],
  }));

  const foamStyle = useAnimatedStyle(() => ({ opacity: foam.value, transform: [{ scale: 0.86 + foam.value * 0.14 }, { rotate: `${(1 - foam.value) * -40}deg` }] }));
  const jacketStyle = useAnimatedStyle(() => ({ opacity: interpolate(foam.value, [0.3, 1], [0, 1], 'clamp'), transform: [{ scale: 0.92 + foam.value * 0.08 }] }));

  // диаметр готовой трубы — подпись чертежа
  const diaStyle = useAnimatedStyle(() => ({ opacity: interpolate(foam.value, [0, 0.3, 1], [0, 1, 1]) * interpolate(logo.value, [0, 0.4], [1, 0], 'clamp') }));

  // готовое сечение сжимается в точку знака и уступает ему место
  const emblem = useAnimatedStyle(() => ({
    opacity: interpolate(logo.value, [0, 0.55], [1, 0], 'clamp'),
    transform: [{ translateY: -logo.value * 40 }, { scale: 1 - logo.value * 0.55 }],
  }));
  // знак: красная плашка раскрывается из сечения, внутри снизу вырастают горы
  const plate = useAnimatedStyle(() => ({
    opacity: interpolate(logo.value, [0.15, 0.55], [0, 1], 'clamp'),
    transform: [{ translateY: -40 }, { scale: interpolate(logo.value, [0.15, 1], [0.45, 1], 'clamp') }],
  }));
  const mountains = useAnimatedStyle(() => ({ height: interpolate(logo.value, [0.45, 1], [0, PLATE_H], 'clamp') }));
  const word = useAnimatedStyle(() => ({ opacity: lift.value, transform: [{ translateY: (1 - lift.value) * 14 }] }));
  const wordMask = useAnimatedStyle(() => ({ width: interpolate(lift.value, [0.1, 0.85], [0, 216], 'clamp') }));
  const sheen = useAnimatedStyle(() => ({ transform: [{ translateX: interpolate(lift.value, [0.35, 1], [-60, 260], 'clamp') }], opacity: interpolate(lift.value, [0.35, 0.6, 1], [0, 1, 0], 'clamp') }));
  const underline = useAnimatedStyle(() => ({ width: interpolate(lift.value, [0.3, 1], [0, 150], 'clamp') }));
  const root = useAnimatedStyle(() => ({ opacity: 1 - out.value }));
  const content = useAnimatedStyle(() => ({ transform: [{ scale: 1 + out.value * 0.05 }] }));

  if (gone) return null;
  return (
    <Animated.View pointerEvents={p === 'playing' ? 'auto' : 'none'} style={[StyleSheet.absoluteFill, { zIndex: 1000 }, root]}>
      <LinearGradient colors={['#1d2028', '#121419', '#0a0b0e']} start={{ x: 0.2, y: 0 }} end={{ x: 0.8, y: 1 }} style={StyleSheet.absoluteFill} />
      <Animated.View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }, content]}>
        <Animated.View style={[{ width: S, height: S }, emblem]}>
          {/* мягкое красное свечение под трубой */}
          <Svg width={S} height={S} style={StyleSheet.absoluteFill}>
            <Defs>
              <RadialGradient id="glow" cx="50%" cy="50%" r="50%">
                <Stop offset="0" stopColor="#ce1f3c" stopOpacity={0.32} />
                <Stop offset="0.55" stopColor="#ce1f3c" stopOpacity={0.08} />
                <Stop offset="1" stopColor="#ce1f3c" stopOpacity={0} />
              </RadialGradient>
            </Defs>
            <Circle cx={C} cy={C} r={C} fill="url(#glow)" />
          </Svg>

          {/* осевые линии чертежа — штрихпунктир */}
          <Animated.View style={[StyleSheet.absoluteFill, axesStyle]}>
            <Svg width={S} height={S}>
              <ALine y1={C} y2={C} stroke="rgba(255,255,255,0.22)" strokeWidth={1} strokeDasharray="14 4 2 4" animatedProps={axisH} />
              <ALine x1={C} x2={C} stroke="rgba(255,255,255,0.22)" strokeWidth={1} strokeDasharray="14 4 2 4" animatedProps={axisV} />
            </Svg>
          </Animated.View>

          {/* слой ППУ: пористое кольцо янтарного цвета пены */}
          <Animated.View style={[StyleSheet.absoluteFill, foamStyle]}>
            <Svg width={S} height={S}>
              <Circle cx={C} cy={C} r={R + 21} stroke="#e0a63a" strokeOpacity={0.55} strokeWidth={30} strokeDasharray="2.5 3.5" fill="none" />
            </Svg>
          </Animated.View>
          {/* оболочка */}
          <Animated.View style={[StyleSheet.absoluteFill, jacketStyle]}>
            <Svg width={S} height={S}>
              <Circle cx={C} cy={C} r={R + 39} stroke="#3c414c" strokeWidth={7} fill="none" />
              <Circle cx={C} cy={C} r={R + 42} stroke="rgba(255,255,255,0.35)" strokeWidth={1} fill="none" />
            </Svg>
          </Animated.View>

          {/* стальная полоса → труба */}
          <Svg width={S} height={S} style={StyleSheet.absoluteFill}>
            <AnimatedPath animatedProps={stripProps} stroke="#c9ced8" strokeWidth={8} strokeLinecap="round" strokeLinejoin="round" fill="none" />
          </Svg>
          <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, hot]}>
            <Svg width={S} height={S}>
              <Circle cx={C} cy={C} r={R} stroke="#ffb35c" strokeWidth={8} fill="none" />
            </Svg>
          </Animated.View>

          {/* сварка: вспышка и искры у шва */}
          <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: C - 13, top: C + R - 13, width: 26, height: 26, borderRadius: 13, backgroundColor: '#fff3d6', boxShadow: '0px 0px 18px #ff9a3c, 0px 0px 40px #ff6a1a' } as any, flash]} />
          {SPARKS.map((sp, i) => <Spark key={i} sp={sp} t={weld} />)}

          {/* диаметр */}
          <Animated.View style={[{ position: 'absolute', left: C + R + 50, top: C - 24, width: 80 }, diaStyle]}>
            <RNText numberOfLines={1} style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12, fontWeight: '700', letterSpacing: 1, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }}>{'Ø\u00a01020'}</RNText>
          </Animated.View>
        </Animated.View>

        {/* знак METALL ASIA — остаётся на последнем кадре */}
        <Animated.View style={[{ position: 'absolute', width: PLATE_W, height: PLATE_H, borderRadius: 16, overflow: 'hidden', boxShadow: '0px 14px 40px rgba(206,31,60,0.45)' } as any, plate]}>
          <LinearGradient colors={['#de2a47', '#c41a35']} start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }} style={StyleSheet.absoluteFill} />
          <LinearGradient colors={['rgba(255,255,255,0.22)', 'rgba(255,255,255,0)']} style={[StyleSheet.absoluteFill, { height: PLATE_H / 2 }]} />
          <Animated.View style={[{ position: 'absolute', left: 0, right: 0, bottom: 0, overflow: 'hidden' }, mountains]}>
            <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: PLATE_H, alignItems: 'center', justifyContent: 'center' }}>
              <Image source={require('../../assets/brand/metall-asia-glyph.png')} style={{ width: PLATE_W * 0.78, height: PLATE_W * 0.78 * (142 / 406) }} contentFit="contain" />
            </View>
          </Animated.View>
        </Animated.View>

        {/* надпись проявляется слева направо, по ней пробегает блик */}
        <Animated.View style={[{ position: 'absolute', top: '50%', marginTop: 30, alignItems: 'center', gap: 12 }, word]}>
          <Animated.View style={[{ height: 216 * (29 / 343), overflow: 'hidden' }, wordMask]}>
            <Image source={require('../../assets/brand/metall-asia-wordmark-white.png')} style={{ width: 216, height: 216 * (29 / 343) }} contentFit="contain" />
            <Animated.View pointerEvents="none" style={[{ position: 'absolute', top: -6, bottom: -6, width: 46 }, sheen]}>
              <LinearGradient colors={['rgba(255,255,255,0)', 'rgba(255,255,255,0.75)', 'rgba(255,255,255,0)']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFill} />
            </Animated.View>
          </Animated.View>
          <Animated.View style={[{ height: 2, borderRadius: 1, backgroundColor: '#ce1f3c' }, underline]} />
        </Animated.View>
      </Animated.View>
    </Animated.View>
  );
}

/* искры сварки: разлёт с «гравитацией» и угасанием */
const SPARKS = Array.from({ length: 12 }).map((_, i) => {
  const a = Math.PI * (0.12 + (0.76 * i) / 11); // веером вниз-в стороны
  const v = 70 + ((i * 37) % 50);
  return { dx: Math.cos(a) * v, dy: Math.sin(a) * v * 0.8, len: 6 + (i % 3) * 3, rot: (a * 180) / Math.PI };
});

function Spark({ sp, t }: { sp: (typeof SPARKS)[number]; t: { value: number } }) {
  const st = useAnimatedStyle(() => {
    const q = Math.min(1, t.value / 0.75);
    return {
      opacity: t.value <= 0.02 || q >= 1 ? 0 : 1 - q,
      transform: [{ translateX: sp.dx * q }, { translateY: sp.dy * q + 90 * q * q }, { rotate: `${sp.rot}deg` }],
    };
  });
  return <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: C - sp.len / 2, top: C + R, width: sp.len, height: 2, borderRadius: 1, backgroundColor: '#ffcf7a' }, st]} />;
}

function soft() {
  if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft).catch(() => {});
}

function tick(_k: string) {
  if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Rigid).catch(() => {});
}
