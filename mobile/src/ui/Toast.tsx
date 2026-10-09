import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import { Platform, View } from 'react-native';
import Animated, { FadeInUp, FadeOutUp } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { Feather } from '@/ui/Icon';
import { useTheme } from '@/theme/ThemeProvider';
import { Text } from './Text';

type Tone = 'success' | 'error' | 'info';
type Ctx = { show: (msg: string, tone?: Tone) => void };
const ToastCtx = createContext<Ctx>({ show: () => {} });

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [item, setItem] = useState<{ id: number; msg: string; tone: Tone } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback((msg: string, tone: Tone = 'info') => {
    if (Platform.OS !== 'web') Haptics.notificationAsync(tone === 'error' ? Haptics.NotificationFeedbackType.Error : Haptics.NotificationFeedbackType.Success).catch(() => {});
    setItem({ id: Date.now(), msg, tone });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setItem(null), tone === 'error' ? 4500 : 2600);
  }, []);

  const bg = item?.tone === 'error' ? colors.danger : item?.tone === 'success' ? colors.success : colors.accent;
  return (
    <ToastCtx.Provider value={{ show }}>
      {children}
      {item && (
        <View pointerEvents="none" style={{ position: 'absolute', top: insets.top + 8, left: 0, right: 0, alignItems: 'center', zIndex: 999 }}>
          <Animated.View
            key={item.id}
            entering={FadeInUp.duration(320)}
            exiting={FadeOutUp.duration(160)}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 10, maxWidth: 440, marginHorizontal: 16, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 16, backgroundColor: colors.isDark && item.tone === 'info' ? colors.card : bg }}
          >
            <Feather name={item.tone === 'error' ? 'alert-circle' : item.tone === 'success' ? 'check-circle' : 'info'} size={18} color={item.tone === 'info' && colors.isDark ? colors.text : '#fff'} />
            <Text variant="callout" style={{ color: item.tone === 'info' && colors.isDark ? colors.text : '#fff', flexShrink: 1, fontWeight: '600' }}>{item.msg}</Text>
          </Animated.View>
        </View>
      )}
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);
