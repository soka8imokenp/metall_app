import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import Animated, { Easing, interpolate, runOnJS, SharedValue, useAnimatedStyle, useSharedValue, withDelay, withTiming } from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { Image } from 'expo-image';
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

const EASE = Easing.bezier(0.22, 1, 0.36, 1);
const IN_OUT = Easing.bezier(0.65, 0, 0.35, 1);

const PW = 196; // плашка знака
const PH = 90;
const GW = PW * 0.78; // горы
const GH = GW * (142 / 406);
const WW = 220; // надпись
const WH = WW * (29 / 343);

/**
 * Заставка — знак собирается из собственной геометрии. Проводится тонкая
 * красная линия, из неё по вертикали раскрывается плашка; две диагональные
 * развёртки навстречу друг другу проявляют горы вдоль их наклона (по фронту —
 * тонкая световая грань), по знаку проходит блик, проявляется надпись.
 * Без посторонних элементов и вибрации — только знак, точное движение и пауза.
 */
export function Intro() {
  const p = useIntroPhase();
  const flags = useFlags();
  const [gone, setGone] = useState(false);

  const line = useSharedValue(0);
  const open = useSharedValue(0);
  const left = useSharedValue(0);
  const right = useSharedValue(0);
  const sheen = useSharedValue(0);
  const word = useSharedValue(0);
  const out = useSharedValue(0);

  useEffect(() => {
    // отладка в браузере: ?introAt=1200 — кадр замирает на 1200 мс
    const raw = Platform.OS === 'web' ? new URLSearchParams(globalThis.location?.search ?? '').get('introAt') : null;
    const at = raw === null ? NaN : Number(raw);
    if (Number.isFinite(at) && at >= 0) {
      const o = (x: number) => 1 - Math.pow(1 - x, 3);
      const io = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
      const q = (d: number, len: number, e: (x: number) => number = o) => e(Math.max(0, Math.min(1, (at - d) / len)));
      line.value = q(150, 420, io); open.value = q(520, 420); left.value = q(820, 620, io); right.value = q(920, 620, io);
      sheen.value = q(1500, 700, io); word.value = q(1560, 650);
      return;
    }
    SplashScreen.hideAsync().catch(() => {});
    line.value = withDelay(150, withTiming(1, { duration: 420, easing: IN_OUT }));
    open.value = withDelay(520, withTiming(1, { duration: 420, easing: EASE }));
    left.value = withDelay(820, withTiming(1, { duration: 620, easing: IN_OUT }));
    right.value = withDelay(920, withTiming(1, { duration: 620, easing: IN_OUT }));
    sheen.value = withDelay(1500, withTiming(1, { duration: 700, easing: IN_OUT }));
    word.value = withDelay(1560, withTiming(1, { duration: 650, easing: EASE }, (f) => { if (f) runOnJS(setPhase)('holding'); }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // приложение построено под последним кадром — растворяемся
  useEffect(() => {
    if (p !== 'holding' || (flags & 3) !== 3 || gone) return;
    out.value = withDelay(150, withTiming(1, { duration: 480, easing: Easing.inOut(Easing.quad) }, (f) => {
      if (f) { runOnJS(setGone)(true); runOnJS(setPhase)('done'); }
    }));
  }, [p, flags, gone, out]);

  const lineStyle = useAnimatedStyle(() => ({ width: line.value * PW, opacity: 1 - open.value }));
  const plateStyle = useAnimatedStyle(() => ({ height: Math.max(2, open.value * PH), opacity: open.value > 0 ? 1 : 0 }));
  const sheenStyle = useAnimatedStyle(() => ({
    opacity: interpolate(sheen.value, [0, 0.2, 0.8, 1], [0, 1, 1, 0]),
    transform: [{ translateX: interpolate(sheen.value, [0, 1], [-PW * 0.7, PW * 1.1]) }, { rotate: '20deg' }],
  }));
  const wordStyle = useAnimatedStyle(() => ({ opacity: word.value, transform: [{ translateY: (1 - word.value) * 8 }, { scale: 1.035 - word.value * 0.035 }] }));
  const root = useAnimatedStyle(() => ({ opacity: 1 - out.value }));
  const content = useAnimatedStyle(() => ({ transform: [{ scale: 1 + out.value * 0.04 }] }));

  if (gone) return null;
  return (
    <Animated.View pointerEvents={p === 'playing' ? 'auto' : 'none'} style={[StyleSheet.absoluteFill, { zIndex: 1000 }, root]}>
      <LinearGradient colors={['#1c1f26', '#121419', '#0b0c0f']} start={{ x: 0.2, y: 0 }} end={{ x: 0.8, y: 1 }} style={StyleSheet.absoluteFill} />
      <Animated.View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }, content]}>
        <View style={{ width: PW, height: PH, alignItems: 'center', justifyContent: 'center' }}>
          {/* линия, из которой раскрывается плашка */}
          <Animated.View style={[{ position: 'absolute', height: 2, borderRadius: 1, backgroundColor: '#ce1f3c' }, lineStyle]} />
          <Animated.View style={[{ width: PW, borderRadius: 18, overflow: 'hidden', boxShadow: '0px 18px 44px rgba(206,31,60,0.32)' } as any, plateStyle]}>
            <View style={{ position: 'absolute', left: 0, right: 0, top: '50%', marginTop: -PH / 2, height: PH }}>
              <LinearGradient colors={['#df2b48', '#c41a35']} style={StyleSheet.absoluteFill} />
              <LinearGradient colors={['rgba(255,255,255,0.18)', 'rgba(255,255,255,0)']} style={[StyleSheet.absoluteFill, { height: PH / 2 }]} />
              {/* горы: левая половина — развёртка снизу-слева, правая — снизу-справа */}
              <View style={{ position: 'absolute', left: 0, top: 0, width: PW / 2, height: PH, overflow: 'hidden' }}>
                <Wipe t={left} angle={-45} offsetX={0} />
              </View>
              <View style={{ position: 'absolute', left: PW / 2, top: 0, width: PW / 2, height: PH, overflow: 'hidden' }}>
                <Wipe t={right} angle={-135} offsetX={-PW / 2} />
              </View>
              {/* блик по готовому знаку */}
              <Animated.View pointerEvents="none" style={[{ position: 'absolute', top: -PH, bottom: -PH, width: 38 }, sheenStyle]}>
                <LinearGradient colors={['rgba(255,255,255,0)', 'rgba(255,255,255,0.28)', 'rgba(255,255,255,0)']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFill} />
              </Animated.View>
            </View>
          </Animated.View>
        </View>

        <Animated.View style={[{ marginTop: 26 }, wordStyle]}>
          <Image source={require('../../assets/brand/metall-asia-wordmark-white.png')} style={{ width: WW, height: WH }} contentFit="contain" />
        </Animated.View>
      </Animated.View>
    </Animated.View>
  );
}

/**
 * Диагональная развёртка половины знака. Окно-квадрат повёрнуто на `angle` и
 * едет вдоль своей оси, открывая горы; содержимое внутри едет обратно, чтобы
 * горы стояли на месте. По переднему краю окна — тонкая световая грань.
 */
const Q = PW + PH; // сторона окна: перекрывает половину плашки при любом повороте
function Wipe({ t, angle, offsetX }: { t: SharedValue<number>; angle: number; offsetX: number }) {
  const win = useAnimatedStyle(() => {
    const tx = -Q + t.value * Q;
    return { transform: [{ rotate: `${angle}deg` }, { translateX: tx }] };
  });
  const inner = useAnimatedStyle(() => {
    const tx = -Q + t.value * Q;
    return { transform: [{ translateX: -tx }, { rotate: `${-angle}deg` }] };
  });
  const edge = useAnimatedStyle(() => ({ opacity: interpolate(t.value, [0, 0.08, 0.85, 1], [0, 1, 1, 0]) }));
  const cx = PW / 4; // центр половины плашки
  const cy = PH / 2;
  return (
    <Animated.View style={[{ position: 'absolute', width: Q, height: Q, left: cx - Q / 2, top: cy - Q / 2, overflow: 'hidden' }, win]}>
      <Animated.View style={[{ position: 'absolute', width: Q, height: Q }, inner]}>
        {/* горы целиком, сдвинуты так, чтобы в окне была нужная половина */}
        <Image
          source={require('../../assets/brand/metall-asia-glyph.png')}
          style={{ position: 'absolute', width: GW, height: GH, left: Q / 2 - cx + (PW - GW) / 2 + offsetX, top: Q / 2 - cy + (PH - GH) / 2 }}
          contentFit="contain"
        />
      </Animated.View>
      <Animated.View style={[{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 2, backgroundColor: 'rgba(255,255,255,0.85)', boxShadow: '0px 0px 8px rgba(255,255,255,0.8)' } as any, edge]} />
    </Animated.View>
  );
}
