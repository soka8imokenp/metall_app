import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, RefreshControl, ScrollView, StyleProp, TextInput, TextInputProps, View, ViewStyle } from 'react-native';
import Animated, { FadeIn, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather, IconName } from './Icon';
import { useTheme } from '@/theme/ThemeProvider';
import { Palette, radius } from '@/theme/tokens';
import { Text } from './Text';
import { Pressable } from './Pressable';
import { Appear, EASE_IN_OUT, EASE_OUT, RevealTick } from './motion';
import { useOnline } from '@/lib/network';
import { useI18n } from '@/i18n';
import { Band, Body, Metric, OnBandCtx } from './Band';
import { SteelSurface, splitStyle } from './Steel';
import { useFocusEffect } from 'expo-router';

export const TAB_BAR_SPACE = 104;

type Depth = 'raised' | 'raisedSm' | 'raisedLg' | 'inset' | 'insetSm';
/** Объём soft UI: выпуклый или вдавленный элемент. */
export const neu = (c: Palette, d: Depth = 'raised'): ViewStyle => ({ boxShadow: c[d] } as ViewStyle);

/** Совместимость со старыми экранами: «тень карточки» = выпуклость. */
export function shadow(_isDark: boolean, level: 1 | 2 = 1): ViewStyle {
  return {};
}

const webNoOutline = Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : null;

/* ---------- Карточка: стальная пластина ---------- */
export function Card({ children, style, onPress, padded = true, inset, tone = 'plate' }: { children: React.ReactNode; style?: StyleProp<ViewStyle>; onPress?: () => void; padded?: boolean; inset?: boolean; tone?: 'plate' | 'dark' }) {
  const { colors } = useTheme();
  const { outer, inner } = splitStyle(style);
  const r = radius.lg;
  if (inset) {
    return <View style={[{ backgroundColor: colors.card, borderRadius: r, padding: padded ? 16 : 0 }, neu(colors, 'inset'), outer, inner]}>{children}</View>;
  }
  const body = (
    <SteelSurface radius={r} tone={tone} innerStyle={[{ padding: padded ? 16 : 0, flexGrow: 1 }, inner]}>
      {children}
    </SteelSurface>
  );
  const frame: ViewStyle = { borderRadius: r, ...neu(colors, 'raised') };
  if (onPress) return <Pressable onPress={onPress} style={[frame, outer]} scaleTo={0.975}>{body}</Pressable>;
  return <View style={[frame, outer]}>{body}</View>;
}

/* ---------- Кнопка ---------- */
export function Button({
  title, onPress, variant = 'primary', icon, loading, disabled, needsNetwork = false, style, size = 'md',
}: {
  title: string;
  onPress?: () => void;
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger';
  icon?: IconName;
  loading?: boolean;
  disabled?: boolean;
  /** Кнопка меняет данные: без сети выключена. */
  needsNetwork?: boolean;
  style?: StyleProp<ViewStyle>;
  size?: 'sm' | 'md';
}) {
  const { colors } = useTheme();
  const online = useOnline();
  const off = disabled || loading || (needsNetwork && !online);
  const dark = variant === 'primary' || variant === 'danger';
  const bg = variant === 'primary' ? colors.accent : variant === 'danger' ? colors.brand : colors.card;
  const fg = variant === 'primary' ? colors.accentFg : variant === 'danger' ? '#fff' : variant === 'ghost' ? colors.textSecondary : colors.text;
  const h = size === 'sm' ? 40 : 52;
  return (
    <Pressable
      onPress={off ? undefined : onPress}
      pressedStyle={variant === 'ghost' ? undefined : neu(colors, 'insetSm')}
      style={[
        {
          backgroundColor: variant === 'ghost' ? 'transparent' : bg,
          height: h,
          borderRadius: size === 'sm' ? 12 : 16,
          paddingHorizontal: size === 'sm' ? 16 : 20,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 9,
          opacity: off ? 0.45 : 1,
        },
        variant !== 'ghost' && neu(colors, dark ? 'raisedSm' : 'raised'),
        style,
      ]}
    >
      {loading ? <ActivityIndicator size="small" color={fg} /> : icon ? <Feather name={icon} size={size === 'sm' ? 16 : 18} color={fg} strokeWidth={2} /> : null}
      <Text variant="callout" style={{ color: fg, fontWeight: '600', fontSize: size === 'sm' ? 13.5 : 15, letterSpacing: -0.1 }}>{title}</Text>
    </Pressable>
  );
}

/** Иконка-кнопка. На цветной шапке — полупрозрачная плитка, в теле экрана — выпуклая круглая. */
export function IconButton({ name, onPress, solid, size = 42 }: { name: IconName; onPress?: () => void; solid?: boolean; size?: number }) {
  const { colors } = useTheme();
  const onBand = React.useContext(OnBandCtx);
  if (onBand) {
    return (
      <Pressable onPress={onPress} style={{ width: size, height: size, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: solid ? '#fff' : 'rgba(255,255,255,0.16)' }}>
        <Feather name={name} size={20} color={solid ? '#1f222a' : '#fff'} />
      </Pressable>
    );
  }
  return (
    <Pressable
      onPress={onPress}
      pressedStyle={neu(colors, 'insetSm')}
      style={[{ width: size, height: size, borderRadius: size / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: solid ? colors.accent : colors.card }, neu(colors, 'raisedSm')]}
    >
      <Feather name={name} size={18} color={solid ? colors.accentFg : colors.text} />
    </Pressable>
  );
}

/* ---------- Бейдж ---------- */
export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';
export function Badge({ label, tone = 'neutral', dot = true }: { label: string; tone?: Tone; dot?: boolean }) {
  const { colors } = useTheme();
  const map = {
    neutral: [colors.infoBg, colors.textSecondary],
    info: [colors.infoBg, colors.info],
    success: [colors.successBg, colors.success],
    warning: [colors.warningBg, colors.warning],
    danger: [colors.dangerBg, colors.danger],
  } as const;
  const [bg, fg] = map[tone];
  return (
    <View style={{ backgroundColor: bg, paddingHorizontal: 9, height: 24, borderRadius: 12, alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      {dot && <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: fg }} />}
      <Text variant="caption" style={{ color: fg, fontWeight: '600', fontSize: 11.5 }} numberOfLines={1}>{label}</Text>
    </View>
  );
}

/* ---------- Скелетон ---------- */
export function Skeleton({ h = 16, w = '100%', r = 10, style }: { h?: number; w?: number | `${number}%`; r?: number; style?: StyleProp<ViewStyle> }) {
  const { colors } = useTheme();
  const o = useSharedValue(0.55);
  useEffect(() => {
    o.value = withRepeat(withTiming(1, { duration: 900, easing: EASE_IN_OUT }), -1, true);
  }, [o]);
  const a = useAnimatedStyle(() => ({ opacity: o.value }));
  return <Animated.View style={[{ height: h, width: w, borderRadius: r, backgroundColor: colors.muted }, a, style]} />;
}

export function SkeletonList({ rows = 5 }: { rows?: number }) {
  return (
    <View style={{ gap: 14 }}>
      {Array.from({ length: rows }).map((_, i) => (
        <Card key={i} style={{ gap: 10 }}>
          <Skeleton h={14} w="55%" />
          <Skeleton h={11} w="85%" />
          <Skeleton h={11} w="35%" />
        </Card>
      ))}
    </View>
  );
}

/* ---------- Экран ---------- */
export function ScreenTop({ title, right, back, metrics, wordmark }: { title?: string; right?: React.ReactNode; back?: () => void; metrics?: Metric[]; wordmark?: boolean }) {
  return <Band title={back ? undefined : title} wordmark={wordmark} back={back} right={right} metrics={metrics} />;
}

export function BigTitle({ title, subtitle }: { title?: string; subtitle?: string }) {
  if (!title) return null;
  return (
    <View style={{ paddingHorizontal: 22, paddingBottom: 16, gap: 3 }}>
      <Text variant="largeTitle" numberOfLines={2}>{title}</Text>
      {!!subtitle && <Text variant="body" tone="secondary" numberOfLines={2}>{subtitle}</Text>}
    </View>
  );
}

/**
 * Экран: неподвижная цветная шапка и под ней лист со скруглёнными углами,
 * в котором прокручивается содержимое. При переходе на экран проявляется
 * только лист — одно движение на весь экран, без анимации каждой карточки.
 */
export function Screen({
  title, subtitle, right, children, onRefresh, refreshing, back, padBottom = true, contentStyle, metrics, wordmark,
}: {
  title?: string; subtitle?: string; right?: React.ReactNode; children: React.ReactNode; onRefresh?: () => void; refreshing?: boolean;
  scroll?: boolean; back?: () => void; padBottom?: boolean; contentStyle?: StyleProp<ViewStyle>; metrics?: Metric[]; wordmark?: boolean;
}) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, backgroundColor: colors.canvas }}>
      <ScreenTop title={title} right={right} back={back} metrics={metrics} wordmark={wordmark} />
      <ContentSheet>
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={[{ flexGrow: 1, paddingTop: 22, paddingBottom: padBottom ? TAB_BAR_SPACE + insets.bottom : 32 + insets.bottom }, contentStyle]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={colors.textSecondary} colors={[colors.brand]} /> : undefined}
        >
          <OfflineBanner />
          {back ? <BigTitle title={title} subtitle={subtitle} /> : null}
          {children}
        </ScrollView>
      </ContentSheet>
    </View>
  );
}

/**
 * Лист под шапкой: наезжает на неё скруглёнными углами.
 *
 * При каждом заходе на экран (и при смене фильтра — `animKey`) лист даёт
 * «такт», и карточки внутри собираются заново по очереди (см. Appear).
 * Сам лист только чуть поднимается — сдвиг дешёвый, прозрачность листа
 * не анимируется (на Android это перерисовка всех теней в каждом кадре).
 */
export function ContentSheet({ children, animKey }: { children: React.ReactNode; animKey?: string }) {
  const { colors } = useTheme();
  const p = useSharedValue(1);
  const tick = useSharedValue(0);
  const firstFocus = useRef(true);
  const firstKey = useRef(true);
  useFocusEffect(
    React.useCallback(() => {
      p.value = 0;
      p.value = withTiming(1, { duration: 420, easing: EASE_OUT });
      if (firstFocus.current) { firstFocus.current = false; return; }
      tick.value = tick.value + 1;
    }, [p, tick]),
  );
  useEffect(() => {
    if (firstKey.current) { firstKey.current = false; return; }
    tick.value = tick.value + 1;
  }, [animKey, tick]);
  const move = useAnimatedStyle(() => ({ transform: [{ translateY: (1 - p.value) * 14 }] }));
  return (
    <RevealTick.Provider value={tick}>
      <Animated.View style={[{ flex: 1, marginTop: -28, borderTopLeftRadius: 28, borderTopRightRadius: 28, overflow: 'hidden', backgroundColor: colors.canvas }, move]}>
        {children}
      </Animated.View>
    </RevealTick.Provider>
  );
}

/* ---------- Баннер «нет связи» ---------- */
export function OfflineBanner() {
  const online = useOnline();
  const { colors } = useTheme();
  const { t } = useI18n();
  if (online) return null;
  return (
    <Animated.View entering={FadeIn.duration(260)} style={{ marginHorizontal: 20, marginBottom: 14, padding: 14, borderRadius: 16, backgroundColor: colors.warningBg, flexDirection: 'row', gap: 12, alignItems: 'center' }}>
      <Feather name="wifi-off" size={18} color={colors.warning} />
      <View style={{ flex: 1 }}>
        <Text variant="callout" style={{ color: colors.warning, fontWeight: '600' }}>{t('offlineTitle')}</Text>
        <Text variant="caption" style={{ color: colors.warning }}>{t('offlineBody')}</Text>
      </View>
    </Animated.View>
  );
}

/* ---------- Секция ---------- */
export function Section({ title, right, children, style }: { title?: string; right?: React.ReactNode; children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[{ paddingHorizontal: 20, marginBottom: 26 }, style]}>
      {(title || right) && (
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, paddingHorizontal: 2 }}>
          {!!title && <Text variant="headline" style={{ fontSize: 17, fontWeight: '700', letterSpacing: -0.4 }}>{title}</Text>}
          {right}
        </View>
      )}
      {children}
    </View>
  );
}

/* ---------- Строка ключ/значение ---------- */
export function KV({ k, v, strong }: { k: string; v: React.ReactNode; strong?: boolean }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12, paddingVertical: 7 }}>
      <Text variant="callout" tone="secondary" style={{ fontWeight: '400' }}>{k}</Text>
      {typeof v === 'string' || typeof v === 'number' ? (
        <Text variant="callout" num style={{ flexShrink: 1, textAlign: 'right', fontWeight: strong ? '700' : '500' }}>{v}</Text>
      ) : v}
    </View>
  );
}

/** Разделитель soft UI: тонкая «канавка» — тёмная линия с белой под ней. */
export function Divider({ style }: { style?: StyleProp<ViewStyle> }) {
  const { colors } = useTheme();
  return (
    <View style={[{ marginVertical: 8 }, style]}>
      <View style={{ height: 1, backgroundColor: colors.isDark ? 'rgba(0,0,0,0.45)' : 'rgba(152,160,178,0.35)' }} />
      <View style={{ height: 1, backgroundColor: colors.isDark ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.85)' }} />
    </View>
  );
}

/* ---------- Tabs: вдавленная дорожка, выпуклый ползунок ---------- */
export function Tabs<T extends string>({ options, value, onChange }: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  const { colors } = useTheme();
  const [w, setW] = useState(0);
  const idx = Math.max(0, options.findIndex((o) => o.value === value));
  const x = useSharedValue(0);
  const PAD = 5;
  const itemW = w > 0 ? (w - PAD * 2) / options.length : 0;
  const placed = useRef(false);
  useEffect(() => {
    if (itemW <= 0) return;
    if (!placed.current) { x.value = idx * itemW; placed.current = true; return; }
    x.value = withTiming(idx * itemW, { duration: 340, easing: EASE_OUT });
  }, [idx, itemW, x]);
  const thumb = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  return (
    <View
      onLayout={(e) => setW(e.nativeEvent.layout.width)}
      style={[{ marginHorizontal: 20, marginBottom: 18, padding: PAD, borderRadius: 18, backgroundColor: colors.card, flexDirection: 'row' }, neu(colors, 'inset')]}
    >
      {itemW > 0 && (
        <Animated.View style={[{ position: 'absolute', top: PAD, left: PAD, width: itemW, height: 40, borderRadius: 14, backgroundColor: colors.card }, neu(colors, 'raisedSm'), thumb]} />
      )}
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable key={o.value} onPress={() => onChange(o.value)} scaleTo={1} style={{ flex: 1, height: 40, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 }} haptic={!on}>
            <Text variant="callout" style={{ fontWeight: on ? '700' : '500', color: on ? colors.text : colors.textSecondary }} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/* ---------- Фильтры-чипы: выпуклые, выбранный — вдавлен ---------- */
export function Segmented<T extends string>({ options, value, onChange }: { options: { value: T; label: string; count?: number }[]; value: T; onChange: (v: T) => void }) {
  const { colors } = useTheme();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 20, paddingVertical: 8, gap: 10 }} style={{ flexGrow: 0, marginBottom: 10, marginTop: -6 }}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            scaleTo={0.96}
            style={[
              { paddingHorizontal: 15, height: 38, borderRadius: 13, flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: colors.card },
              neu(colors, on ? 'insetSm' : 'raisedSm'),
            ]}
          >
            <Text variant="callout" style={{ color: on ? colors.brand : colors.textSecondary, fontWeight: on ? '700' : '500' }}>{o.label}</Text>
            {o.count !== undefined && <Text variant="caption" num style={{ color: on ? colors.brand : colors.textMuted, fontWeight: '600' }}>{o.count}</Text>}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/* ---------- Поле ввода: вдавленное ---------- */
/**
 * Тень и рамка — на обёртке, а текст — во внутреннем TextInput с отступами:
 * на Android у TextInput с box-shadow отступ слева терялся и строка липла к краю.
 */
export function Field({ label, error, style, multiline, ...rest }: TextInputProps & { label?: string; error?: string | null }) {
  const { colors } = useTheme();
  const [focus, setFocus] = React.useState(false);
  const flat = (Array.isArray(style) ? Object.assign({}, ...style) : style ?? {}) as any;
  const h = flat.height ?? (multiline ? 96 : 52);
  return (
    <View style={{ gap: 8 }}>
      {!!label && <Text variant="callout" tone="secondary" style={{ fontWeight: '600', paddingLeft: 4 }}>{label}</Text>}
      <View
        style={[
          {
            minHeight: h,
            borderRadius: 16,
            backgroundColor: colors.card,
            borderWidth: 1.5,
            borderColor: error ? colors.danger : focus ? (colors.isDark ? 'rgba(239,68,96,0.45)' : 'rgba(206,31,60,0.32)') : 'transparent',
            justifyContent: multiline ? 'flex-start' : 'center',
          },
          neu(colors, 'inset'),
        ]}
      >
        <TextInput
          placeholderTextColor={colors.textMuted}
          selectionColor={colors.brand}
          cursorColor={colors.brand}
          multiline={multiline}
          {...rest}
          onFocus={(e) => { setFocus(true); rest.onFocus?.(e); }}
          onBlur={(e) => { setFocus(false); rest.onBlur?.(e); }}
          style={[
            {
              minHeight: h - 3,
              paddingLeft: 18,
              paddingRight: 48,
              paddingVertical: multiline ? 14 : 0,
              fontSize: 16,
              color: colors.text,
              fontFamily: 'Inter_500Medium',
              textAlignVertical: multiline ? 'top' : 'center',
              backgroundColor: 'transparent',
            },
            webNoOutline,
          ]}
        />
      </View>
      {!!error && <Text variant="caption" tone="danger" style={{ paddingLeft: 4 }}>{error}</Text>}
    </View>
  );
}

export function SearchBar({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const { colors } = useTheme();
  return (
    <View style={[{ marginHorizontal: 20, marginBottom: 16, height: 50, borderRadius: 16, backgroundColor: colors.card, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, gap: 10 }, neu(colors, 'inset')]}>
      <Feather name="search" size={18} color={colors.textMuted} />
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={colors.textMuted}
        selectionColor={colors.brand}
        cursorColor={colors.brand}
        style={[{ flex: 1, fontSize: 15.5, color: colors.text, fontFamily: 'Inter_500Medium', height: '100%' }, webNoOutline]}
        autoCorrect={false}
      />
      {!!value && (
        <Pressable onPress={() => onChange('')} haptic={false}>
          <Feather name="x-circle" size={17} color={colors.textMuted} />
        </Pressable>
      )}
    </View>
  );
}

/* ---------- Пустое и ошибка ---------- */
export function EmptyState({ icon = 'inbox', title, hint }: { icon?: IconName; title: string; hint?: string }) {
  const { colors } = useTheme();
  return (
    <View style={{ alignItems: 'center', paddingVertical: 48, paddingHorizontal: 32, gap: 12 }}>
      <View style={[{ width: 64, height: 64, borderRadius: 32, backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center' }, neu(colors, 'raised')]}>
        <Feather name={icon} size={24} color={colors.textSecondary} />
      </View>
      <Text variant="headline" style={{ textAlign: 'center' }}>{title}</Text>
      {!!hint && <Text variant="callout" tone="secondary" style={{ textAlign: 'center', fontWeight: '400' }}>{hint}</Text>}
    </View>
  );
}

export function ErrorState({ message, onRetry }: { message?: string; onRetry?: () => void }) {
  const { t } = useI18n();
  return (
    <View style={{ alignItems: 'center', paddingBottom: 24, gap: 4 }}>
      <EmptyState icon="alert-triangle" title={t('loadError')} hint={message} />
      {onRetry && <Button title={t('retry')} variant="secondary" size="sm" onPress={onRetry} />}
    </View>
  );
}

/* ---------- Иконка в круге: вдавленная лунка ---------- */
export function IconBubble({ name, size = 42, tone = 'muted' }: { name: IconName; size?: number; tone?: 'muted' | 'accent' | 'danger' | 'warning' | 'success' }) {
  const { colors } = useTheme();
  const fg = tone === 'accent' ? colors.text : tone === 'danger' ? colors.danger : tone === 'warning' ? colors.warning : tone === 'success' ? colors.success : colors.textSecondary;
  return (
    <View style={[{ width: size, height: size, borderRadius: size / 2, backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center' }, neu(colors, 'insetSm')]}>
      <Feather name={name} size={size * 0.44} color={fg} strokeWidth={2} />
    </View>
  );
}

/** Старое имя для появления. Новые экраны используют `<Appear>`. */
export const rise = (i: number) => FadeIn.delay(Math.min(i, 6) * 30).duration(320);
export { Appear };
