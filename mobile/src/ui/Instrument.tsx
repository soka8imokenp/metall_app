import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, StyleProp, StyleSheet, TextInput, View, ViewStyle } from 'react-native';
import Animated, {
  Easing, interpolate, runOnJS, useAnimatedProps, useAnimatedStyle, useSharedValue, withDelay, withRepeat, withSequence, withTiming,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Circle, Line } from 'react-native-svg';
import * as Haptics from 'expo-haptics';
import { Feather, IconName } from './Icon';
import { Text } from './Text';
import { Pressable } from './Pressable';
import { neu, Tone } from './components';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { EASE_OUT } from './motion';
import { useTheme } from '@/theme/ThemeProvider';
import { useOnline } from '@/lib/network';
import type { Palette } from '@/theme/tokens';

/**
 * «Приборная» часть дизайна: экраны карточек читаются как панель прибора
 * трубного завода, а не как веб-таблица. Сигнальная лампа вместо плашки
 * статуса, крупное показание вместо строки «Сумма: …», табличка
 * характеристик вместо столбика «ключ — значение», док действий у большого
 * пальца и свайп для необратимого подтверждения.
 */

export const toneColor = (c: Palette, tone: Tone) =>
  tone === 'success' ? c.success : tone === 'warning' ? c.warning : tone === 'danger' ? c.danger : tone === 'info' ? c.info : c.textSecondary;

/* ---------- Сигнальная лампа ---------- */
/**
 * Статус — лампа в вдавленном гнезде и подпись. `pulse` — состояние ждёт
 * чьего-то действия (на согласовании, пауза): лампа мягко «дышит».
 */
export function StatusLamp({ tone, label, pulse }: { tone: Tone; label: string; pulse?: boolean }) {
  const { colors } = useTheme();
  const c = toneColor(colors, tone);
  const g = useSharedValue(0);
  useEffect(() => {
    g.value = pulse ? withRepeat(withTiming(1, { duration: 1100, easing: Easing.inOut(Easing.quad) }), 6, true) : 0;
  }, [pulse, g]);
  const halo = useAnimatedStyle(() => ({ opacity: 0.18 + g.value * 0.4, transform: [{ scale: 1 + g.value * 0.55 }] }));
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <View style={[{ width: 20, height: 20, borderRadius: 10, backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center' }, neu(colors, 'insetSm')]}>
        <Animated.View style={[{ position: 'absolute', width: 10, height: 10, borderRadius: 5, backgroundColor: c }, halo]} />
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: c, boxShadow: `0px 0px 6px ${c}` } as any} />
      </View>
      <Text variant="callout" style={{ color: c, fontWeight: '700', letterSpacing: -0.1 }}>{label}</Text>
    </View>
  );
}

/* ---------- Показание с отсчётом ---------- */
/**
 * Крупная цифра «докручивается» от нуля, как стрелка прибора при включении:
 * так глаз сразу ловит главное число экрана. Формат («292,1», «1 250»)
 * сохраняется — меняется только значение.
 */
const ATextInput = Animated.createAnimatedComponent(TextInput);

/** Формат числа внутри анимации (там нет Intl): «1 250,5» — пробелы разрядов и запятая. */
function fmt(v: number, frac: number, neg: boolean) {
  'worklet';
  const f = Math.pow(10, frac);
  const r = Math.round(v * f) / f;
  const int = Math.floor(r);
  let s = String(int);
  let out = '';
  while (s.length > 3) { out = '\u00a0' + s.slice(-3) + out; s = s.slice(0, -3); }
  out = s + out;
  if (frac > 0) {
    const dec = String(Math.round((r - int) * f));
    out += ',' + '0'.repeat(frac - dec.length) + dec;
  }
  return (neg ? '-' : '') + out;
}

export function CountText({ value, style, duration = 750 }: { value: string; style?: any; duration?: number }) {
  const m = value.match(/^(-?)([\d\s\u00a0]+)(?:,(\d+))?$/);
  const target = m ? Number(m[2].replace(/[\s\u00a0]/g, '')) + (m[3] ? Number(`0.${m[3]}`) : 0) : NaN;
  const frac = m?.[3]?.length ?? 0;
  const neg = !!m?.[1];
  const p = useSharedValue(0);
  const ran = useRef(false);
  useEffect(() => {
    if (!Number.isFinite(target)) return;
    // докручиваем один раз — при открытии экрана; при обновлении данных цифра просто меняется
    if (ran.current) { p.value = 1; return; }
    ran.current = true;
    p.value = withTiming(1, { duration, easing: Easing.out(Easing.quad) });
  }, [target, duration, p]);
  const props = useAnimatedProps(() => ({ text: fmt(target * p.value, frac, neg), defaultValue: '' }) as any);
  // веб-сборка (только для просмотра) — без докрутки: там нет нативного обновления текста
  if (!Number.isFinite(target) || Platform.OS === 'web') return <Text num style={style}>{value}</Text>;
  const flat = StyleSheet.flatten(style) ?? {};
  // анимация идёт на потоке интерфейса: текст меняется без перерисовки React
  return (
    <ATextInput
      editable={false}
      underlineColorAndroid="transparent"
      animatedProps={props}
      defaultValue={fmt(0, frac, neg)}
      style={[{ padding: 0, margin: 0, fontFamily: 'Inter_700Bold', fontVariant: ['tabular-nums'] }, flat, { fontWeight: undefined }]}
    />
  );
}

/** Главное показание экрана: число крупно, разряд и единица — рядом мельче. */
export function Readout({ value, unit, color, size = 46 }: { value: string; unit?: string; color?: string; size?: number }) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
      <CountText value={value} style={{ fontSize: size, lineHeight: size * 1.12, fontWeight: '700', letterSpacing: -size * 0.04, color: color ?? colors.text }} />
      {!!unit && <Text style={{ fontSize: 17, fontWeight: '600', color: colors.textSecondary, letterSpacing: -0.2 }}>{unit}</Text>}
    </View>
  );
}

/* ---------- Табличка характеристик ---------- */
export type Spec = { label: string; value: string; wide?: boolean };
/**
 * Вместо столбика «ключ — значение» на всю ширину — заводская табличка:
 * вдавленная пластина с заклёпками по углам, поля по два в ряд, подпись
 * мелко заглавными над значением. Читается взглядом, а не строкой.
 */
export function SpecPlate({ items, style }: { items: Spec[]; style?: StyleProp<ViewStyle> }) {
  const { colors } = useTheme();
  const groove = colors.isDark ? 'rgba(0,0,0,0.45)' : 'rgba(152,160,178,0.32)';
  const shine = colors.isDark ? 'rgba(255,255,255,0.035)' : 'rgba(255,255,255,0.9)';
  const rows: Spec[][] = [];
  let cur: Spec[] = [];
  for (const it of items) {
    if (it.wide) { if (cur.length) rows.push(cur); rows.push([it]); cur = []; continue; }
    cur.push(it);
    if (cur.length === 2) { rows.push(cur); cur = []; }
  }
  if (cur.length) rows.push(cur);
  const rivet = (pos: ViewStyle) => (
    <View style={[{ position: 'absolute', width: 6, height: 6, borderRadius: 3, backgroundColor: colors.canvas }, neu(colors, 'raisedSm'), pos]} />
  );
  return (
    <View style={[{ borderRadius: 20, backgroundColor: colors.card, paddingHorizontal: 18, paddingVertical: 6 }, neu(colors, 'inset'), style]}>
      {rivet({ top: 8, left: 8 })}
      {rivet({ top: 8, right: 8 })}
      {rivet({ bottom: 8, left: 8 })}
      {rivet({ bottom: 8, right: 8 })}
      {rows.map((r, i) => (
        <View key={i}>
          {i > 0 && (
            <View>
              <View style={{ height: 1, backgroundColor: groove }} />
              <View style={{ height: 1, backgroundColor: shine }} />
            </View>
          )}
          <View style={{ flexDirection: 'row' }}>
            {r.map((s, j) => (
              <View key={j} style={{ flex: 1, paddingVertical: 13, paddingLeft: j > 0 ? 14 : 0, borderLeftWidth: j > 0 ? 1 : 0, borderLeftColor: groove, gap: 4 }}>
                <Text style={{ fontSize: 10.5, letterSpacing: 0.9, textTransform: 'uppercase', fontWeight: '600', color: colors.textMuted }} numberOfLines={1}>{s.label}</Text>
                <Text variant="callout" style={{ fontWeight: '600' }} numberOfLines={2}>{s.value}</Text>
              </View>
            ))}
          </View>
        </View>
      ))}
    </View>
  );
}

/* ---------- Мерная шкала ---------- */
/**
 * Прогресс как мерная линейка: вдавленный жёлоб, заливка набегает слева,
 * риски через каждые 10 %, крупные — через 50 %. Подписи — начало и цель.
 */
export function GaugeBar({ value, color, left, right }: { value: number; color?: string; left?: string; right?: string }) {
  const { colors } = useTheme();
  const [w, setW] = useState(0);
  const p = useSharedValue(0);
  useEffect(() => {
    p.value = 0;
    p.value = withDelay(150, withTiming(Math.max(0, Math.min(1, value)), { duration: 900, easing: EASE_OUT }));
  }, [value, p]);
  const fill = useAnimatedStyle(() => ({ width: p.value <= 0.001 ? 0 : Math.max(10, (w - 6) * p.value) }));
  const c = color ?? colors.brand;
  return (
    <View style={{ gap: 6 }}>
      <View onLayout={(e) => setW(e.nativeEvent.layout.width)} style={[{ height: 18, borderRadius: 9, padding: 3, backgroundColor: colors.card }, neu(colors, 'insetSm')]}>
        <Animated.View style={[{ height: 12, borderRadius: 6, overflow: 'hidden' }, fill]}>
          <LinearGradient colors={[c, c]} style={StyleSheet.absoluteFill} />
          <LinearGradient colors={['rgba(255,255,255,0.35)', 'rgba(255,255,255,0)']} style={[StyleSheet.absoluteFill, { height: 6 }]} />
        </Animated.View>
      </View>
      {w > 0 && (
        <Svg width={w} height={7}>
          {Array.from({ length: 11 }).map((_, i) => {
            const x = 3 + ((w - 6) * i) / 10;
            const major = i % 5 === 0;
            return <Line key={i} x1={x} x2={x} y1={0} y2={major ? 7 : 4} stroke={colors.textMuted} strokeWidth={major ? 1.4 : 1} opacity={major ? 0.9 : 0.55} />;
          })}
        </Svg>
      )}
      {(left || right) && (
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <Text variant="caption" tone="secondary" num style={{ fontWeight: '600' }}>{left}</Text>
          <Text variant="caption" tone="muted" num>{right}</Text>
        </View>
      )}
    </View>
  );
}

/* ---------- Сечение трубы как уровень ---------- */
const ACircle = Animated.createAnimatedComponent(Circle);
/**
 * Сечение трубы, стенка которого заполняется по уровню: сколько есть
 * относительно нормы. Красная — ниже критического, янтарная — ниже минимума.
 * Толщина стенки на картинке — от реальной толщины трубы, если она известна.
 */
export function PipeLevel({ level, tone, size = 46, wall = 0.18 }: { level: number; tone: 'ok' | 'low' | 'critical'; size?: number; wall?: number }) {
  const { colors } = useTheme();
  const c = tone === 'critical' ? colors.danger : tone === 'low' ? colors.warning : colors.accent;
  const sw = Math.max(4, Math.min(size * 0.22, size * wall));
  const r = (size - sw) / 2 - 1;
  const len = 2 * Math.PI * r;
  const p = useSharedValue(0);
  useEffect(() => {
    p.value = withDelay(120, withTiming(Math.max(0.04, Math.min(1, level)), { duration: 800, easing: EASE_OUT }));
  }, [level, p]);
  const props = useAnimatedProps(() => ({ strokeDashoffset: len * (1 - p.value) }));
  return (
    <View style={[{ width: size + 8, height: size + 8, borderRadius: (size + 8) / 2, backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center' }, neu(colors, 'insetSm')]}>
      <Svg width={size} height={size} style={{ transform: [{ rotate: '-90deg' }] }}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={colors.muted} strokeWidth={sw} fill="none" />
        <ACircle cx={size / 2} cy={size / 2} r={r} stroke={c} strokeWidth={sw} fill="none" strokeDasharray={`${len} ${len}`} animatedProps={props} strokeLinecap="round" />
      </Svg>
      {tone === 'critical' && <PulseDot color={colors.danger} />}
    </View>
  );
}

function PulseDot({ color }: { color: string }) {
  // в списке их могут быть десятки — без анимации, только свечение
  return <View style={{ position: 'absolute', width: 8, height: 8, borderRadius: 4, backgroundColor: color, boxShadow: `0px 0px 5px ${color}` } as any} />;
}

/* ---------- Док действий ---------- */
/**
 * Действия живут внизу, под большим пальцем, в стеклянном доке — как нижняя
 * панель, а не столбик кнопок посреди страницы. Главное действие — справа и
 * крупно, второстепенные — круглые клавиши с подписью.
 */
export function ActionDock({ children }: { children: React.ReactNode }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const fade = colors.isDark ? '27,29,34' : '231,233,238';
  // своё затухание под доком: содержимое уходит под него мягко, а не обрезается
  return (
    <>
      <LinearGradient
        pointerEvents="none"
        colors={[`rgba(${fade},0)`, `rgba(${fade},0.75)`, `rgba(${fade},0.97)`]}
        locations={[0, 0.45, 1]}
        style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: insets.bottom + 110 }}
      />
      <View pointerEvents="box-none" style={{ position: 'absolute', left: 0, right: 0, bottom: insets.bottom + 10, alignItems: 'center' }}>
        <View
          style={[
            {
              width: '93%',
              maxWidth: 520,
              borderRadius: 33,
              padding: 7,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4,
              backgroundColor: colors.isDark ? 'rgba(35,38,45,0.97)' : 'rgba(244,245,248,0.97)',
              borderWidth: 1,
              borderColor: colors.isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.8)',
            },
            { boxShadow: colors.isDark ? '0px 10px 30px rgba(0,0,0,0.45)' : '0px 10px 30px rgba(90,98,118,0.22)' } as any,
          ]}
        >
          {children}
        </View>
      </View>
    </>
  );
}

/** Отступ снизу у содержимого экрана с доком, чтобы последний блок не прятался под ним. */
export const DOCK_SPACE = 120;

export function DockKey({ icon, label, onPress, tone, needsNetwork = true }: { icon: IconName; label: string; onPress: () => void; tone?: 'danger'; needsNetwork?: boolean }) {
  const { colors } = useTheme();
  const online = useOnline();
  const off = needsNetwork && !online;
  return (
    <Pressable onPress={off ? undefined : onPress} scaleTo={0.92} style={{ width: 62, alignItems: 'center', gap: 3, opacity: off ? 0.4 : 1, paddingVertical: 2 }}>
      <View style={[{ width: 42, height: 42, borderRadius: 21, backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center' }, neu(colors, 'raisedSm')]}>
        <Feather name={icon} size={18} color={tone === 'danger' ? colors.danger : colors.text} strokeWidth={2} />
      </View>
      <Text style={{ fontSize: 10.5, fontWeight: '600', color: colors.textSecondary }} numberOfLines={1}>{label}</Text>
    </Pressable>
  );
}

/** Главная клавиша дока для действий, которые открывают форму (не необратимых). */
export function DockMain({ icon, label, onPress, needsNetwork = true }: { icon: IconName; label: string; onPress: () => void; needsNetwork?: boolean }) {
  const { colors } = useTheme();
  const online = useOnline();
  const off = needsNetwork && !online;
  return (
    <Pressable onPress={off ? undefined : onPress} scaleTo={0.96} style={[{ flex: 1, height: 58, borderRadius: 23, backgroundColor: colors.accent, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, opacity: off ? 0.45 : 1 }, neu(colors, 'raisedSm')]}>
      <Feather name={icon} size={19} color={colors.accentFg} strokeWidth={2.2} />
      <Text variant="callout" style={{ color: colors.accentFg, fontWeight: '700', fontSize: 15.5 }}>{label}</Text>
    </Pressable>
  );
}

/* ---------- Свайп-подтверждение ---------- */
/**
 * Необратимое (согласовать, подписать, провести) — не случайным касанием, а
 * движением: ведёшь ручку вправо до упора. На полпути — лёгкий щелчок, у
 * края — «тяжёлый». Стрелки внутри бегут, подсказывая направление.
 */
export function SlideConfirm({ label, onConfirm, busy, tone = 'accent', icon = 'check' }: { label: string; onConfirm: () => Promise<unknown> | void; busy?: boolean; tone?: 'accent' | 'brand'; icon?: IconName }) {
  const { colors } = useTheme();
  const online = useOnline();
  const [w, setW] = useState(0);
  const KNOB = 50;
  const max = Math.max(1, w - KNOB - 8);
  const x = useSharedValue(0);
  const half = useSharedValue(false);
  const hint = useSharedValue(0);
  const bg = tone === 'brand' ? colors.brand : colors.accent;
  const fg = tone === 'brand' ? '#fff' : colors.accentFg;

  useEffect(() => {
    // три подсказки направления после появления — и тишина: бесконечная анимация держит экран в перерисовке
    hint.value = withDelay(400, withRepeat(withSequence(withTiming(1, { duration: 900, easing: Easing.inOut(Easing.quad) }), withTiming(0, { duration: 0 })), 3, false));
  }, [hint]);
  useEffect(() => { if (!busy) x.value = withTiming(0, { duration: 380, easing: EASE_OUT }); }, [busy, x]);

  const tick = (heavy: boolean) => {
    if (Platform.OS === 'web') return;
    Haptics.impactAsync(heavy ? Haptics.ImpactFeedbackStyle.Heavy : Haptics.ImpactFeedbackStyle.Light).catch(() => {});
  };
  const fire = () => { void onConfirm(); };

  const pan = Gesture.Pan()
    .enabled(online && !busy)
    .onUpdate((e) => {
      x.value = Math.max(0, Math.min(max, e.translationX));
      const h = x.value > max / 2;
      if (h !== half.value) { half.value = h; if (h) runOnJS(tick)(false); }
    })
    .onEnd(() => {
      if (x.value > max * 0.86) {
        x.value = withTiming(max, { duration: 140 });
        runOnJS(tick)(true);
        runOnJS(fire)();
      } else {
        x.value = withTiming(0, { duration: 380, easing: EASE_OUT });
      }
      half.value = false;
    });

  const knob = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  const trail = useAnimatedStyle(() => ({ width: x.value + KNOB + 4 }));
  const text = useAnimatedStyle(() => ({ opacity: interpolate(x.value, [0, max * 0.6], [1, 0], 'clamp'), transform: [{ translateX: x.value * 0.25 }] }));
  const arrows = useAnimatedStyle(() => ({ opacity: interpolate(hint.value, [0, 0.5, 1], [0.15, 0.9, 0.15]), transform: [{ translateX: hint.value * 10 }] }));

  return (
    <View
      onLayout={(e) => setW(e.nativeEvent.layout.width)}
      style={[{ flex: 1, height: 58, borderRadius: 29, backgroundColor: colors.card, padding: 4, justifyContent: 'center', opacity: online ? 1 : 0.45 }, neu(colors, 'inset')]}
    >
      <Animated.View style={[{ position: 'absolute', left: 4, top: 4, bottom: 4, borderRadius: 25, backgroundColor: bg, opacity: 0.16 }, trail]} />
      <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: KNOB + 18, right: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 }, text]}>
        <Text variant="callout" style={{ fontWeight: '700', color: colors.text }} numberOfLines={1}>{label}</Text>
        <Animated.View style={arrows}><Feather name="chevrons-right" size={17} color={colors.textSecondary} /></Animated.View>
      </Animated.View>
      <GestureDetector gesture={pan}>
        <Animated.View style={[{ width: KNOB, height: KNOB, borderRadius: KNOB / 2, backgroundColor: bg, alignItems: 'center', justifyContent: 'center' }, neu(colors, 'raisedSm'), knob]}>
          {busy ? <ActivityIndicator color={fg} /> : <Feather name={icon} size={21} color={fg} strokeWidth={2.4} />}
        </Animated.View>
      </GestureDetector>
    </View>
  );
}
