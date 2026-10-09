import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AppState, Platform, StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSequence, withTiming } from 'react-native-reanimated';
import * as LocalAuthentication from 'expo-local-authentication';
import * as Crypto from 'expo-crypto';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { storage } from '@/lib/storage';
import { useAuth } from '@/auth/AuthProvider';
import { useI18n } from '@/i18n';
import { useTheme } from '@/theme/ThemeProvider';
import { Feather, IconName } from './Icon';
import { Pressable } from './Pressable';
import { Text } from './Text';
import { BrandMark } from './Brand';
import { neu } from './components';
import { EASE_OUT } from './motion';
import { Sheet } from './Sheet';

/**
 * Блокировка приложения: свой код из 4 цифр и отпечаток / Face ID.
 *
 * Код — замок на телефоне, а не пароль учётки: он не уходит на сервер, в
 * хранилище телефона (Keychain/Keystore) лежит только его SHA-256 с солью.
 * Отпечаток — быстрый способ открыть тот же замок, поэтому включается только
 * поверх кода: без кода нечем открыть приложение, если отпечаток не сработал.
 *
 * Замок закрывается при запуске и при возврате, если приложение было свёрнуто
 * дольше `RELOCK_MS`. После `MAX_TRIES` неверных кодов — выход из учётки: дальше
 * только вход по логину и паролю (иначе код из 4 цифр перебирается за минуты).
 */

const RELOCK_MS = 30_000;
const MAX_TRIES = 5;
const PIN_LEN = 4;
const K_PIN = 'lockPinHash';
const K_BIO = 'lockBio';

const hashPin = async (pin: string) => {
  let salt = await storage.get('lockSalt');
  if (!salt) {
    salt = Crypto.randomUUID();
    await storage.set('lockSalt', salt);
  }
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `${salt}:${pin}`);
};

type Ctx = {
  pinSet: boolean;
  bioEnabled: boolean;
  bioAvailable: boolean;
  bioKind: 'face' | 'finger';
  setPin: (pin: string) => Promise<void>;
  clearPin: () => Promise<void>;
  setBio: (on: boolean) => Promise<boolean>;
};
const LockCtx = createContext<Ctx>(null as unknown as Ctx);
export const useAppLock = () => useContext(LockCtx);

export function AppLockProvider({ children }: { children: React.ReactNode }) {
  const { user, signOut } = useAuth();
  const [ready, setReady] = useState(false);
  const [pinSet, setPinSet] = useState(false);
  const [bioEnabled, setBioEnabled] = useState(false);
  const [bioAvailable, setBioAvailable] = useState(false);
  const [bioKind, setBioKind] = useState<'face' | 'finger'>('finger');
  const [locked, setLocked] = useState(false);
  const leftAt = useRef<number | null>(null);

  useEffect(() => {
    (async () => {
      const [pin, bio] = await Promise.all([storage.get(K_PIN), storage.get(K_BIO)]);
      setPinSet(!!pin);
      setBioEnabled(bio === '1');
      if (Platform.OS !== 'web') {
        const [hw, enrolled, types] = await Promise.all([
          LocalAuthentication.hasHardwareAsync(),
          LocalAuthentication.isEnrolledAsync(),
          LocalAuthentication.supportedAuthenticationTypesAsync(),
        ]);
        setBioAvailable(hw && enrolled);
        setBioKind(types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION) && !types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT) ? 'face' : 'finger');
      }
      // Холодный запуск с кодом — сразу замок.
      if (pin) setLocked(true);
      setReady(true);
    })();
  }, []);

  // Свернули и вернулись: замок, если прошло больше RELOCK_MS.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'background' || s === 'inactive') {
        if (leftAt.current === null) leftAt.current = Date.now();
      } else if (s === 'active') {
        const away = leftAt.current ? Date.now() - leftAt.current : 0;
        leftAt.current = null;
        if (pinSet && away > RELOCK_MS) setLocked(true);
      }
    });
    return () => sub.remove();
  }, [pinSet]);

  const setPin = useCallback(async (pin: string) => {
    await storage.set(K_PIN, await hashPin(pin));
    setPinSet(true);
  }, []);

  const clearPin = useCallback(async () => {
    await Promise.all([storage.del(K_PIN), storage.del(K_BIO)]);
    setPinSet(false);
    setBioEnabled(false);
    setLocked(false);
  }, []);

  const setBio = useCallback(async (on: boolean) => {
    if (on) {
      // Включаем только после удачной проверки: иначе можно «включить»
      // то, что на этом телефоне не сработает.
      const r = await LocalAuthentication.authenticateAsync({ promptMessage: 'METALL ASIA', disableDeviceFallback: true, cancelLabel: 'Отмена' });
      if (!r.success) return false;
    }
    await storage.set(K_BIO, on ? '1' : '0');
    setBioEnabled(on);
    return true;
  }, []);

  // Выход из учётки снимает и замок: следующий человек на этом телефоне
  // заведёт свой код.
  const wasUser = useRef<string | null>(null);
  useEffect(() => {
    if (wasUser.current && !user) void clearPin();
    wasUser.current = user?.uid ?? null;
  }, [user, clearPin]);

  const value = { pinSet, bioEnabled, bioAvailable, bioKind, setPin, clearPin, setBio };
  return (
    <LockCtx.Provider value={value}>
      {children}
      {ready && locked && user && (
        <LockScreen
          onUnlock={() => setLocked(false)}
          onGiveUp={() => {
            setLocked(false);
            signOut();
          }}
        />
      )}
    </LockCtx.Provider>
  );
}

/** Экран замка: знак, точки кода, клавиатура и кнопка отпечатка. */
function LockScreen({ onUnlock, onGiveUp }: { onUnlock: () => void; onGiveUp: () => void }) {
  const { colors } = useTheme();
  const { t } = useI18n();
  const { bioEnabled, bioAvailable, bioKind } = useAppLock();
  const insets = useSafeAreaInsets();
  const [code, setCode] = useState('');
  const [tries, setTries] = useState(0);
  const [error, setError] = useState(false);
  const shake = useSharedValue(0);
  const fade = useSharedValue(0);

  useEffect(() => {
    fade.value = withTiming(1, { duration: 260, easing: EASE_OUT });
  }, [fade]);

  const bio = useCallback(async () => {
    if (!bioEnabled || !bioAvailable) return;
    const r = await LocalAuthentication.authenticateAsync({ promptMessage: t('lkBioPrompt'), cancelLabel: t('cancel2'), disableDeviceFallback: true });
    if (r.success) onUnlock();
  }, [bioEnabled, bioAvailable, onUnlock, t]);

  // Отпечаток предлагаем сразу — код только запасной путь.
  useEffect(() => {
    const id = setTimeout(() => void bio(), 350);
    return () => clearTimeout(id);
  }, [bio]);

  const check = async (full: string) => {
    const saved = await storage.get(K_PIN);
    if (saved && saved === (await hashPin(full))) {
      if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      onUnlock();
      return;
    }
    const n = tries + 1;
    setTries(n);
    setError(true);
    if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
    shake.value = withSequence(
      withTiming(-12, { duration: 50 }), withTiming(12, { duration: 70 }),
      withTiming(-8, { duration: 60 }), withTiming(8, { duration: 60 }), withTiming(0, { duration: 50 }),
    );
    setTimeout(() => setCode(''), 260);
    if (n >= MAX_TRIES) setTimeout(onGiveUp, 500);
  };

  const press = (d: string) => {
    if (code.length >= PIN_LEN) return;
    setError(false);
    const next = code + d;
    setCode(next);
    if (next.length === PIN_LEN) setTimeout(() => void check(next), 120);
  };

  const dots = useAnimatedStyle(() => ({ transform: [{ translateX: shake.value }] }));
  const screen = useAnimatedStyle(() => ({ opacity: fade.value }));

  return (
    <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: colors.canvas, zIndex: 1000, paddingTop: insets.top + 40, paddingBottom: insets.bottom + 24, alignItems: 'center' }, screen]}>
      <BrandMark height={44} />
      <Text variant="title" style={{ marginTop: 28, fontWeight: '700' }}>{t('lkTitle')}</Text>
      <Text variant="callout" tone={error ? 'danger' : 'secondary'} style={{ marginTop: 6, minHeight: 18 }}>
        {error ? `${t('lkWrong')} · ${t('lkLeft')}: ${Math.max(0, MAX_TRIES - tries)}` : ' '}
      </Text>

      <Animated.View style={[{ flexDirection: 'row', gap: 18, marginTop: 26 }, dots]}>
        {Array.from({ length: PIN_LEN }).map((_, i) => {
          const on = i < code.length;
          return (
            <View key={i} style={[{ width: 20, height: 20, borderRadius: 10, backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center' }, neu(colors, 'insetSm')]}>
              {on && <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: error ? colors.danger : colors.brand }} />}
            </View>
          );
        })}
      </Animated.View>

      <View style={{ flex: 1 }} />

      <View style={{ width: 300, flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 18 }}>
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => <Key key={d} label={d} onPress={() => press(d)} />)}
        <Key icon={bioEnabled && bioAvailable ? (bioKind === 'face' ? 'scan-face' : 'fingerprint') : undefined} onPress={() => void bio()} ghost />
        <Key label="0" onPress={() => press('0')} />
        <Key icon="delete" onPress={() => { setError(false); setCode((c) => c.slice(0, -1)); }} ghost />
      </View>

      <Pressable onPress={onGiveUp} style={{ marginTop: 26, padding: 8 }}>
        <Text variant="callout" tone="secondary" style={{ fontWeight: '600' }}>{t('lkForgot')}</Text>
      </Pressable>
    </Animated.View>
  );
}

function Key({ label, icon, onPress, ghost }: { label?: string; icon?: IconName; onPress: () => void; ghost?: boolean }) {
  const { colors } = useTheme();
  if (ghost && !icon) return <View style={{ width: 80, height: 80 }} />;
  return (
    <Pressable
      onPress={onPress}
      scaleTo={0.92}
      pressedStyle={ghost ? undefined : neu(colors, 'insetSm')}
      style={[{ width: 80, height: 80, borderRadius: 40, alignItems: 'center', justifyContent: 'center', backgroundColor: ghost ? 'transparent' : colors.card }, ghost ? null : neu(colors, 'raised')]}
    >
      {label ? <Text style={{ fontSize: 30, lineHeight: 36, fontWeight: '500', color: colors.text }}>{label}</Text> : <Feather name={icon!} size={28} color={colors.text} strokeWidth={1.8} />}
    </Pressable>
  );
}

/**
 * Установка кода: ввести 4 цифры и повторить. Открывается листом из меню.
 */
export function PinSetupSheet({ visible, onClose, onDone }: { visible: boolean; onClose: () => void; onDone: () => void }) {
  const { colors } = useTheme();
  const { t } = useI18n();
  const { setPin } = useAppLock();
  const [first, setFirst] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState(false);
  const shake = useSharedValue(0);

  useEffect(() => {
    if (visible) { setFirst(null); setCode(''); setError(false); }
  }, [visible]);

  const press = async (d: string) => {
    if (code.length >= PIN_LEN) return;
    setError(false);
    const next = code + d;
    setCode(next);
    if (next.length < PIN_LEN) return;
    await new Promise((r) => setTimeout(r, 140));
    if (first === null) {
      setFirst(next);
      setCode('');
      return;
    }
    if (next === first) {
      await setPin(next);
      onDone();
      return;
    }
    setError(true);
    shake.value = withSequence(withTiming(-10, { duration: 50 }), withTiming(10, { duration: 70 }), withTiming(0, { duration: 60 }));
    setFirst(null);
    setCode('');
  };

  const dots = useAnimatedStyle(() => ({ transform: [{ translateX: shake.value }] }));
  return (
    <Sheet visible={visible} onClose={onClose} title={t('lkSetTitle')}>
      <View style={{ alignItems: 'center', gap: 6 }}>
        <Text variant="callout" tone={error ? 'danger' : 'secondary'}>{error ? t('lkMismatch') : first === null ? t('lkSetHint') : t('lkRepeat')}</Text>
        <Animated.View style={[{ flexDirection: 'row', gap: 18, marginVertical: 16 }, dots]}>
          {Array.from({ length: PIN_LEN }).map((_, i) => (
            <View key={i} style={[{ width: 20, height: 20, borderRadius: 10, backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center' }, neu(colors, 'insetSm')]}>
              {i < code.length && <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: colors.brand }} />}
            </View>
          ))}
        </Animated.View>
        <View style={{ width: 280, flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 14 }}>
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => <Key key={d} label={d} onPress={() => void press(d)} />)}
          <View style={{ width: 80, height: 80 }} />
          <Key label="0" onPress={() => void press('0')} />
          <Key icon="delete" onPress={() => setCode((c) => c.slice(0, -1))} ghost />
        </View>
      </View>
    </Sheet>
  );
}
