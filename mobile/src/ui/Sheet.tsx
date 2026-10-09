import React, { useCallback, useEffect, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable as RNPressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from './Icon';
import { useTheme } from '@/theme/ThemeProvider';
import { Text } from './Text';
import { neu } from './components';
import { EASE_SHEET } from './motion';

/**
 * Нижний лист в духе iOS: выезжает по кривой листа Apple, закрывается
 * крестиком, тапом по фону или свайпом вниз за верхнюю часть (ручку и
 * заголовок). Анимация — на одном значении сдвига, без layout-анимаций:
 * с ними на Android кнопки внутри листа не получали нажатий.
 */
export function Sheet({ visible, onClose, title, children, tall, dismissable = true }: { visible: boolean; onClose: () => void; title?: string; children: React.ReactNode; tall?: boolean; /** false — лист не закрывается: обязательное действие (например, обязательное обновление). */ dismissable?: boolean }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const [mounted, setMounted] = useState(visible);
  const y = useSharedValue(height);
  const fade = useSharedValue(0);

  // открытие и закрытие снаружи (visible)
  useEffect(() => {
    if (visible) {
      setMounted(true);
      y.value = height;
      requestAnimationFrame(() => {
        y.value = withTiming(0, { duration: 420, easing: EASE_SHEET });
        fade.value = withTiming(1, { duration: 300 });
      });
    } else if (mounted) {
      fade.value = withTiming(0, { duration: 220 });
      y.value = withTiming(height, { duration: 280, easing: EASE_SHEET }, (done) => {
        if (done) runOnJS(setMounted)(false);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const close = useCallback(() => { if (dismissable) onClose(); }, [onClose, dismissable]);

  const pan = Gesture.Pan()
    .enabled(dismissable)
    .activeOffsetY(6)
    .onUpdate((e) => {
      // вверх лист почти не тянется (сопротивление), вниз — за пальцем
      y.value = e.translationY > 0 ? e.translationY : e.translationY * 0.15;
    })
    .onEnd((e) => {
      if (e.translationY > 110 || e.velocityY > 900) {
        runOnJS(close)();
      } else {
        y.value = withTiming(0, { duration: 300, easing: EASE_SHEET });
      }
    });

  const sheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }] }));
  const backdrop = useAnimatedStyle(() => ({ opacity: fade.value }));

  if (!mounted) return null;
  return (
    <Modal visible transparent animationType="none" onRequestClose={close} statusBarTranslucent navigationBarTranslucent>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
          <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: colors.overlay }, backdrop]}>
            <RNPressable style={{ flex: 1 }} onPress={close} />
          </Animated.View>
          <View style={{ flex: 1, justifyContent: 'flex-end', alignItems: 'center' }} pointerEvents="box-none">
            <Animated.View
              style={[
                {
                  width: '100%',
                  maxWidth: 560,
                  maxHeight: tall ? '92%' : '84%',
                  backgroundColor: colors.canvas,
                  borderTopLeftRadius: 30,
                  borderTopRightRadius: 30,
                  paddingBottom: insets.bottom + 14,
                },
                neu(colors, 'raisedLg'),
                sheetStyle,
              ]}
            >
              {/* за шапку листа можно тянуть вниз; крестик — отдельно от жеста, чтобы жест не съедал нажатие */}
              <View>
                <GestureDetector gesture={pan}>
                  <View collapsable={false} style={{ paddingRight: 70 }}>
                    <View style={{ alignItems: 'center', paddingTop: 10, paddingBottom: 4, marginRight: -70 }}>
                      <View style={[{ width: 44, height: 6, borderRadius: 3, backgroundColor: colors.canvas }, neu(colors, 'insetSm')]} />
                    </View>
                    <View style={{ paddingLeft: 22, paddingTop: 10, paddingBottom: 14, minHeight: 62, justifyContent: 'center' }}>
                      <Text variant="title" style={{ fontSize: 20, fontWeight: '700' }} numberOfLines={1}>{title}</Text>
                    </View>
                  </View>
                </GestureDetector>
                {dismissable && <RNPressable
                  onPress={close}
                  hitSlop={14}
                  accessibilityRole="button"
                  accessibilityLabel="close"
                  style={({ pressed }) => [
                    { position: 'absolute', right: 22, top: 26, width: 38, height: 38, borderRadius: 19, backgroundColor: colors.canvas, alignItems: 'center', justifyContent: 'center' },
                    neu(colors, pressed ? 'insetSm' : 'raisedSm'),
                  ]}
                >
                  <Feather name="x" size={18} color={colors.textSecondary} strokeWidth={2.2} />
                </RNPressable>}
              </View>
              <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: 22, paddingTop: 4, paddingBottom: 10, gap: 16 }} showsVerticalScrollIndicator={false}>
                {children}
              </ScrollView>
            </Animated.View>
          </View>
        </KeyboardAvoidingView>
      </GestureHandlerRootView>
    </Modal>
  );
}
