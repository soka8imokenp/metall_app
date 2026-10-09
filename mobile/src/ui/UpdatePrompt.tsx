import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Platform, ScrollView, StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withRepeat, withTiming, Easing } from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { Sheet } from './Sheet';
import { Text } from './Text';
import { Button, neu } from './components';
import { Feather } from './Icon';
import { PipeRings } from './Steel';
import { useToast } from './Toast';
import { EASE_OUT } from './motion';
import { useTheme } from '@/theme/ThemeProvider';
import { useI18n } from '@/i18n';
import { APP_VERSION, canSelfInstall, checkUpdate, downloadUpdate, installApk, type UpdateInfo } from '@/lib/updates';

type Ctx = { check: (manual?: boolean) => Promise<void> };
const UpdateCtx = createContext<Ctx>({ check: async () => {} });
export const useUpdates = () => useContext(UpdateCtx);

type Phase = 'idle' | 'downloading' | 'ready' | 'error';

/**
 * Обновление приложения. Проверка — при запуске (и вручную из меню); новая
 * версия показывается листом: что нового, «Скачать» с полосой загрузки и
 * «Установить» в конце. Обязательное обновление (версия ниже минимальной)
 * лист не закрывает.
 *
 * Установка из приложения — только Android: на iPhone Apple ставит
 * приложения лишь через App Store/TestFlight, там лист просто сообщает.
 */
export function UpdateProvider({ children }: { children: React.ReactNode }) {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [open, setOpen] = useState(false);
  const toast = useToast();
  const { t } = useI18n();
  // Отложенное «Позже» помним до следующего запуска: не ворчим при каждом экране.
  const postponed = useRef<string | null>(null);

  const check = useCallback(
    async (manual = false) => {
      try {
        const u = await checkUpdate();
        if (!u) {
          if (manual) toast.show(`${t('upLatest')} · ${APP_VERSION}`, 'success');
          return;
        }
        if (!manual && !u.mandatory && postponed.current === u.version) return;
        setInfo(u);
        setOpen(true);
      } catch {
        if (manual) toast.show(t('networkDown'), 'error');
      }
    },
    [toast, t],
  );

  useEffect(() => {
    if (Platform.OS === 'web') return; // веб-сборка — только для разработки
    const id = setTimeout(() => void check(false), 1500);
    return () => clearTimeout(id);
  }, [check]);

  return (
    <UpdateCtx.Provider value={{ check }}>
      {children}
      {info && (
        <UpdateSheet
          info={info}
          visible={open}
          onClose={() => {
            postponed.current = info.version;
            setOpen(false);
          }}
        />
      )}
    </UpdateCtx.Provider>
  );
}

function UpdateSheet({ info, visible, onClose }: { info: UpdateInfo; visible: boolean; onClose: () => void }) {
  const { colors } = useTheme();
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>('idle');
  const [file, setFile] = useState<string | null>(null);
  const [bytes, setBytes] = useState({ written: 0, total: info.size ?? 0 });
  const cancelRef = useRef<(() => void) | null>(null);

  const mb = (n: number) => (n / 1048576).toFixed(1).replace('.', ',');
  const pct = bytes.total > 0 ? Math.min(1, bytes.written / bytes.total) : 0;

  const start = () => {
    setPhase('downloading');
    setBytes({ written: 0, total: info.size ?? 0 });
    const job = downloadUpdate(info.version, (written, total) => setBytes({ written, total: total > 0 ? total : info.size ?? 0 }));
    cancelRef.current = job.cancel;
    job.promise
      .then((uri) => {
        setFile(uri);
        setPhase('ready');
        // сразу предлагаем установку — как в магазине приложений
        void installApk(uri).catch(() => undefined);
      })
      .catch(() => setPhase('error'));
  };

  const close = () => {
    if (phase === 'downloading') cancelRef.current?.();
    setPhase(file ? 'ready' : 'idle');
    onClose();
  };

  return (
    <Sheet visible={visible} onClose={close} title={t('upTitle')} dismissable={!info.mandatory}>
      {/* карточка версии: тёмная сталь и сечение трубы */}
      <View style={[{ borderRadius: 22, overflow: 'hidden', padding: 20 }, neu(colors, 'raised')]}>
        <LinearGradient colors={['#2c3039', '#16181d']} start={{ x: 0.1, y: 0 }} end={{ x: 0.9, y: 1 }} style={StyleSheet.absoluteFill} />
        <PipeRings size={150} color="#ffffff" opacity={0.08} style={{ right: -40, top: -36 }} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
          <View style={{ width: 52, height: 52, borderRadius: 16, backgroundColor: colors.brand, alignItems: 'center', justifyContent: 'center' }}>
            <Feather name="download" size={24} color="#fff" strokeWidth={2.2} />
          </View>
          <View style={{ flex: 1 }}>
            <Text variant="caption" style={{ color: 'rgba(255,255,255,0.6)', letterSpacing: 1, textTransform: 'uppercase', fontWeight: '600' }}>{t('upVersion')}</Text>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
              <Text num style={{ color: '#fff', fontSize: 28, lineHeight: 34, fontWeight: '700', letterSpacing: -0.8 }}>{info.version}</Text>
              <Text variant="callout" style={{ color: 'rgba(255,255,255,0.45)' }}>← {APP_VERSION}</Text>
            </View>
          </View>
        </View>
        {!!info.size && <Text variant="caption" style={{ color: 'rgba(255,255,255,0.55)', marginTop: 10 }}>APK · {mb(info.size)} {t('mb')}</Text>}
      </View>

      {info.mandatory && (
        <View style={{ padding: 14, borderRadius: 16, backgroundColor: colors.warningBg, flexDirection: 'row', gap: 10 }}>
          <Feather name="alert-triangle" size={18} color={colors.warning} />
          <Text variant="callout" style={{ color: colors.warning, flex: 1 }}>{t('upMandatory')}</Text>
        </View>
      )}

      {!!info.notes.trim() && (
        <View style={{ gap: 8 }}>
          <Text variant="callout" tone="secondary" style={{ fontWeight: '600', paddingLeft: 4 }}>{t('upWhatsNew')}</Text>
          <View style={[{ borderRadius: 16, backgroundColor: colors.card, maxHeight: 180 }, neu(colors, 'inset')]}>
            <ScrollView contentContainerStyle={{ padding: 16 }} nestedScrollEnabled>
              <Text variant="body" tone="secondary">{info.notes.trim()}</Text>
            </ScrollView>
          </View>
        </View>
      )}

      {!canSelfInstall ? (
        <Text variant="callout" tone="secondary" style={{ textAlign: 'center' }}>{t('upIosHint')}</Text>
      ) : phase === 'idle' ? (
        <Button title={t('upDownload')} icon="download" onPress={start} />
      ) : phase === 'downloading' ? (
        <View style={{ gap: 10 }}>
          <Progress value={pct} />
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <Text variant="callout" style={{ fontWeight: '600' }}>{t('upDownloading')} · {Math.round(pct * 100)}%</Text>
            <Text variant="callout" tone="secondary" num>{mb(bytes.written)} / {mb(bytes.total)} {t('mb')}</Text>
          </View>
        </View>
      ) : phase === 'ready' ? (
        <View style={{ gap: 10 }}>
          <Progress value={1} done />
          <Text variant="callout" tone="success" style={{ fontWeight: '600', textAlign: 'center' }}>{t('upReady')}</Text>
          <Button title={t('upInstall')} icon="check-circle" variant="danger" onPress={() => file && void installApk(file)} />
          <Text variant="caption" tone="muted" style={{ textAlign: 'center' }}>{t('upInstallHint')}</Text>
        </View>
      ) : (
        <View style={{ gap: 10 }}>
          <Text variant="callout" tone="danger" style={{ textAlign: 'center' }}>{t('upFailed')}</Text>
          <Button title={t('upRetry')} icon="refresh-cw" onPress={start} />
        </View>
      )}

      {!info.mandatory && phase !== 'downloading' && <Button title={t('upLater')} variant="ghost" onPress={close} />}
    </Sheet>
  );
}

/**
 * Полоса загрузки: вдавленная дорожка, красная заливка плавно догоняет
 * настоящий прогресс, по заливке бежит блик — видно, что работа идёт, даже
 * когда байты приходят рывками.
 */
function Progress({ value, done }: { value: number; done?: boolean }) {
  const { colors } = useTheme();
  const [w, setW] = useState(0);
  const p = useSharedValue(0);
  const shine = useSharedValue(0);
  useEffect(() => {
    p.value = withTiming(value, { duration: 450, easing: EASE_OUT });
  }, [value, p]);
  useEffect(() => {
    shine.value = withRepeat(withTiming(1, { duration: 1300, easing: Easing.inOut(Easing.quad) }), -1, false);
  }, [shine]);
  const fill = useAnimatedStyle(() => ({ width: Math.max(14, (w - 8) * p.value) }));
  const glare = useAnimatedStyle(() => ({ transform: [{ translateX: -80 + shine.value * (w + 80) }], opacity: done ? 0 : 1 }));
  return (
    <View onLayout={(e) => setW(e.nativeEvent.layout.width)} style={[{ height: 22, borderRadius: 11, padding: 4, backgroundColor: colors.card }, neu(colors, 'inset')]}>
      <Animated.View style={[{ height: 14, borderRadius: 7, overflow: 'hidden' }, fill]}>
        <LinearGradient colors={done ? ['#22a05a', '#17864a'] : ['#ef4460', colors.brand]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFill} />
        <Animated.View style={[{ position: 'absolute', top: 0, bottom: 0, width: 60 }, glare]}>
          <LinearGradient colors={['rgba(255,255,255,0)', 'rgba(255,255,255,0.45)', 'rgba(255,255,255,0)']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFill} />
        </Animated.View>
      </Animated.View>
    </View>
  );
}
