import React, { useEffect, useMemo, useState } from 'react';
import { Platform, View } from 'react-native';
import Animated, { runOnJS, useAnimatedProps, useAnimatedStyle, useSharedValue, withTiming, Easing } from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Svg, { Defs, Line, LinearGradient, Path, Stop } from 'react-native-svg';
import * as Haptics from 'expo-haptics';
import { Card, neu, Tabs } from '@/ui/components';
import { Pressable } from '@/ui/Pressable';
import { Text } from '@/ui/Text';
import { Feather } from '@/ui/Icon';
import { useTheme } from '@/theme/ThemeProvider';
import { useI18n } from '@/i18n';
import { money } from '@/lib/format';

export type Day = { date: string; value: number };
type Period = '7' | '14' | '30';

const APath = Animated.createAnimatedComponent(Path);
const H = 168;
const PAD_TOP = 14;
const PAD_BOTTOM = 6;

/** Плавная кривая через точки (Catmull-Rom → кубические Безье), без выбросов ниже нуля. */
function smooth(pts: { x: number; y: number }[], floor: number) {
  if (pts.length < 2) return '';
  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = Math.min(floor, p1.y + (p2.y - p0.y) / 6);
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = Math.min(floor, p2.y - (p3.y - p1.y) / 6);
    d += ` C${c1x},${c1y} ${c2x},${c2y} ${p2.x},${p2.y}`;
  }
  return d;
}

/**
 * Выручка по дням (сумма заказов по дате оформления). Палец ведут по графику
 * в любом месте — курсор и точка идут за ним, на каждом дне щелчок вибрации,
 * сверху крупно дата и сумма. Отпустил — снова итог периода и сравнение с
 * прошлым таким же периодом. Никаких мелких столбиков, в которые надо целиться.
 */
export function RevenueChart({ days }: { days: Day[] }) {
  const { colors } = useTheme();
  const { t, locale } = useI18n();
  const [period, setPeriod] = useState<Period>('14');
  const n = Number(period);
  const pts = days.slice(-n);
  const prev = days.slice(-2 * n, -n);
  const total = pts.reduce((a, p) => a + p.value, 0);
  const prevTotal = prev.length === n ? prev.reduce((a, p) => a + p.value, 0) : null;
  const delta = prevTotal && prevTotal > 0 ? (total - prevTotal) / prevTotal : null;
  const avg = total / Math.max(1, pts.length);
  const max = Math.max(1e-9, ...pts.map((p) => p.value)) * 1.12;

  const [w, setW] = useState(0);
  const [sel, setSel] = useState<number | null>(null);

  const geo = useMemo(() => {
    if (w <= 0 || pts.length < 2) return null;
    const step = w / (pts.length - 1);
    const floor = H - PAD_BOTTOM;
    const xy = pts.map((p, i) => ({ x: i * step, y: PAD_TOP + (1 - p.value / max) * (floor - PAD_TOP) }));
    const line = smooth(xy, floor);
    const area = `${line} L${w},${H} L0,${H} Z`;
    let len = 0;
    for (let i = 1; i < xy.length; i++) len += Math.hypot(xy[i].x - xy[i - 1].x, xy[i].y - xy[i - 1].y);
    return { xy, line, area, step, len: len * 1.08, avgY: PAD_TOP + (1 - avg / max) * (floor - PAD_TOP) };
  }, [w, pts, max, avg]);

  // прорисовка линии слева направо при открытии и смене периода
  const draw = useSharedValue(0);
  useEffect(() => {
    draw.value = 0;
    draw.value = withTiming(1, { duration: 900, easing: Easing.out(Easing.cubic) });
  }, [period, w, draw]);
  const lineProps = useAnimatedProps(() => ({ strokeDashoffset: (geo?.len ?? 0) * (1 - draw.value) }));
  const fillStyle = useAnimatedStyle(() => ({ opacity: draw.value }));

  // курсор: положение — на потоке интерфейса, номер дня — в React (для подписи)
  const cx = useSharedValue(-1);
  const cy = useSharedValue(0);
  const shown = useSharedValue(0);
  const tick = (i: number) => {
    setSel(i);
    if (Platform.OS !== 'web') Haptics.selectionAsync().catch(() => {});
  };
  const release = () => setSel(null);
  const xs = geo?.xy.map((p) => p.x) ?? [];
  const ys = geo?.xy.map((p) => p.y) ?? [];
  const step = geo?.step ?? 1;
  const last = useSharedValue(-1);

  // ведение пальцем — только по горизонтали: вертикальный жест остаётся прокрутке страницы
  const pick = (x: number) => {
    'worklet';
    const i = Math.max(0, Math.min(xs.length - 1, Math.round(x / step)));
    cx.value = shown.value > 0 ? withTiming(xs[i], { duration: 70 }) : xs[i];
    cy.value = shown.value > 0 ? withTiming(ys[i], { duration: 70 }) : ys[i];
    shown.value = withTiming(1, { duration: 140 });
    if (i !== last.value) { last.value = i; runOnJS(tick)(i); }
  };
  const pan = Gesture.Pan()
    .activeOffsetX([-6, 6])
    .failOffsetY([-14, 14])
    .onStart((e) => pick(e.x))
    .onUpdate((e) => pick(e.x));
  const tap = Gesture.Tap().maxDuration(400).onEnd((e) => pick(e.x));
  const gesture = Gesture.Exclusive(pan, tap);
  const reset = () => {
    shown.value = withTiming(0, { duration: 200 });
    last.value = -1;
    release();
  };

  const cursor = useAnimatedStyle(() => ({ opacity: shown.value, transform: [{ translateX: cx.value }] }));
  const dot = useAnimatedStyle(() => ({ opacity: shown.value, transform: [{ translateX: cx.value - 7 }, { translateY: cy.value - 7 }, { scale: 0.6 + shown.value * 0.4 }] }));

  const fmtDate = (iso: string, opts: Intl.DateTimeFormatOptions) => new Date(iso + 'T00:00:00').toLocaleDateString(locale === 'uz' ? 'uz-UZ' : 'ru-RU', opts);
  const cur = sel !== null ? pts[sel] : null;
  const ticks = pts.length ? [0, Math.round((pts.length - 1) / 3), Math.round(((pts.length - 1) * 2) / 3), pts.length - 1] : [];
  const up = (delta ?? 0) >= 0;

  return (
    <Card style={{ padding: 0, overflow: 'hidden' }}>
      {/* показание: итог периода или выбранный день */}
      <View style={{ paddingHorizontal: 20, paddingTop: 18, gap: 4, height: 112 }}>
        <Text style={{ fontSize: 11, letterSpacing: 0.9, textTransform: 'uppercase', fontWeight: '700', color: colors.textMuted }}>
          {cur ? fmtDate(cur.date, { weekday: 'long', day: 'numeric', month: 'long' }) : `${t('rvTotal')} · ${n} ${t('rvDays')}`}
        </Text>
        <Text num style={{ fontSize: 30, lineHeight: 36, fontWeight: '700', letterSpacing: -1, color: cur && cur.value === 0 ? colors.textMuted : colors.text }}>
          {cur ? (cur.value > 0 ? money(cur.value * 1e9) : t('rvNoSales')) : money(total * 1e9)}
        </Text>
        {!cur && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            {delta !== null && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <Feather name={up ? 'trending-up' : 'trending-down'} size={15} color={up ? colors.success : colors.danger} />
                <Text variant="callout" num style={{ fontWeight: '700', color: up ? colors.success : colors.danger }}>{up ? '+' : '−'}{total > 0 ? Math.min(99, Math.abs(Math.round(delta * 100))) : 100}%</Text>
                <Text variant="caption" tone="muted">{t('rvVsPrev')}</Text>
              </View>
            )}
            <Text variant="caption" tone="secondary" num>{t('rvAvg')}: {money(avg * 1e9)}</Text>
          </View>
        )}
        {cur ? (
          <Pressable onPress={reset} style={{ position: 'absolute', right: 16, top: 16, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, height: 32, borderRadius: 16, backgroundColor: colors.card, ...neu(colors, 'raisedSm') }}>
            <Feather name="x" size={14} color={colors.textSecondary} />
            <Text variant="caption" style={{ fontWeight: '700', color: colors.textSecondary }}>{t('rvTotal')}</Text>
          </Pressable>
        ) : (
          <Text variant="caption" tone="muted" style={{ marginTop: 2 }}>{t('rvHint')}</Text>
        )}
      </View>

      {/* график: ведите пальцем */}
      <GestureDetector gesture={gesture}>
        <View onLayout={(e) => setW(e.nativeEvent.layout.width)} style={{ height: H, marginTop: 10 }} collapsable={false}>
          {geo && (
            <>
              <Animated.View style={[{ position: 'absolute', left: 0, top: 0 }, fillStyle]}>
                <Svg width={w} height={H}>
                  <Defs>
                    <LinearGradient id="rv" x1="0" y1="0" x2="0" y2="1">
                      <Stop offset="0" stopColor={colors.brand} stopOpacity={colors.isDark ? 0.42 : 0.28} />
                      <Stop offset="1" stopColor={colors.brand} stopOpacity={0} />
                    </LinearGradient>
                  </Defs>
                  <Path d={geo.area} fill="url(#rv)" />
                  {avg > 0 && <Line x1={0} x2={w} y1={geo.avgY} y2={geo.avgY} stroke={colors.textMuted} strokeWidth={1} strokeDasharray="4 5" opacity={0.7} />}
                </Svg>
              </Animated.View>
              <Svg width={w} height={H} style={{ position: 'absolute' }}>
                <APath d={geo.line} stroke={colors.brand} strokeWidth={2.6} fill="none" strokeLinecap="round" strokeLinejoin="round" strokeDasharray={`${geo.len} ${geo.len}`} animatedProps={lineProps} />
              </Svg>
              {/* курсор и точка */}
              <Animated.View pointerEvents="none" style={[{ position: 'absolute', top: 0, bottom: 0, width: 1.5, backgroundColor: colors.text, opacity: 0.5 }, cursor]} />
              <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: 0, top: 0, width: 14, height: 14, borderRadius: 7, backgroundColor: colors.brand, borderWidth: 3, borderColor: colors.card }, dot]} />
            </>
          )}
        </View>
      </GestureDetector>

      {/* ось дат: только опорные, с месяцем */}
      <View style={{ height: 22, marginTop: 6, marginHorizontal: 0 }}>
        {geo && ticks.map((i, k) => (
          <Text
            key={k}
            variant="caption"
            tone={sel === i ? undefined : 'muted'}
            num
            style={{ position: 'absolute', width: 70, left: Math.max(0, Math.min(w - 70, geo.xy[i].x - 35)) + (k === 0 ? 8 : k === ticks.length - 1 ? -8 : 0), textAlign: k === 0 ? 'left' : k === ticks.length - 1 ? 'right' : 'center', fontSize: 11.5, fontWeight: '600' }}
          >
            {fmtDate(pts[i].date, { day: 'numeric', month: 'short' }).replace('.', '')}
          </Text>
        ))}
      </View>

      {/* период — широкие клавиши, по ним легко попасть */}
      <View style={{ paddingTop: 10, paddingBottom: 2 }}>
        <Tabs
          options={[{ value: '7', label: `7 ${t('rvDays')}` }, { value: '14', label: `14 ${t('rvDays')}` }, { value: '30', label: `30 ${t('rvDays')}` }]}
          value={period}
          onChange={(v) => { setPeriod(v); reset(); }}
        />
      </View>
    </Card>
  );
}
