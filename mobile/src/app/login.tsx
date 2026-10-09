import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@/ui/Icon';
import { useTheme } from '@/theme/ThemeProvider';
import { useI18n } from '@/i18n';
import { useAuth } from '@/auth/AuthProvider';
import { ApiError, API_BASE, setApiBase, DEFAULT_API_BASE } from '@/api/client';
import { storage } from '@/lib/storage';
import { Sheet } from '@/ui/Sheet';
import { LangToggle } from '@/ui/LangToggle';
import { Appear, Button, Field, IconButton, neu } from '@/ui/components';
import { LinearGradient } from 'expo-linear-gradient';
import { Text } from '@/ui/Text';
import { Pressable } from '@/ui/Pressable';
import { BrandMark, BrandWordmark } from '@/ui/Brand';
import { useOnline } from '@/lib/network';

export default function Login() {
  const { colors, mode, setMode } = useTheme();
  const { t, locale, setLocale } = useI18n();
  const { signIn } = useAuth();
  const insets = useSafeAreaInsets();
  const online = useOnline();
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [srvOpen, setSrvOpen] = useState(false);
  const [srv, setSrv] = useState(API_BASE);
  const [srvMsg, setSrvMsg] = useState<string | null>(null);
  const [srvShown, setSrvShown] = useState(API_BASE);

  const submit = async () => {
    if (!login || !password || busy) return;
    setBusy(true);
    setError(null);
    try {
      await signIn(login, password);
    } catch (e) {
      if (e instanceof ApiError) {
        setError(e.isNetwork ? t('networkDown') : e.status === 401 ? t('invalidCreds') : e.status === 403 || e.status === 423 || e.status === 429 ? t('blocked') : e.message || t('loginFailed'));
      } else setError(t('loginFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: colors.canvas }}>
      {/* мягкое свечение сверху: красный знака и холодный белый */}
      <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 420, overflow: 'hidden' }}>
        <LinearGradient colors={[colors.isDark ? 'rgba(206,31,60,0.22)' : 'rgba(206,31,60,0.07)', 'transparent']} style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 420 }} />
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8, paddingTop: insets.top + 8, paddingHorizontal: 16 }}>
        <LangToggle />
        <IconButton name={colors.isDark ? 'sun' : 'moon'} onPress={() => setMode(colors.isDark ? 'light' : 'dark')} />
      </View>

      <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: 24 }} keyboardShouldPersistTaps="handled">
        <Appear distance={10} style={{ gap: 30 }}>
          <View style={{ alignItems: 'center', gap: 18 }}>
            <BrandMark height={60} />
            <BrandWordmark height={15} />
            <Text tone="secondary" variant="callout">{t('subtitle')}</Text>
          </View>

          <View style={[{ gap: 18, padding: 22, borderRadius: 28, backgroundColor: colors.card }, neu(colors, 'raisedLg')]}>
            <Field
              label={t('login')}
              value={login}
              onChangeText={setLogin}
              autoCapitalize="none"
              autoCorrect={false}
              textContentType="username"
              returnKeyType="next"
            />
            <View>
              <Field
                label={t('password')}
                value={password}
                onChangeText={setPassword}
                secureTextEntry={!show}
                autoCapitalize="none"
                textContentType="password"
                returnKeyType="go"
                onSubmitEditing={submit}
              />
              <Pressable onPress={() => setShow((s) => !s)} style={{ position: 'absolute', right: 6, bottom: 5, width: 42, height: 42, alignItems: 'center', justifyContent: 'center' }} haptic={false} scaleTo={0.9}>
                <Feather name={show ? 'eye-off' : 'eye'} size={18} color={colors.textMuted} />
              </Pressable>
            </View>

            {!!error && (
              <Appear style={{ backgroundColor: colors.dangerBg, padding: 12, borderRadius: 14 }}>
                <Text variant="callout" tone="danger">{error}</Text>
              </Appear>
            )}
            {!online && <Text variant="caption" tone="warning">{t('offlineBody')}</Text>}

            <Button title={busy ? t('signingIn') : t('signIn')} onPress={submit} loading={busy} disabled={!login || !password || !online} />
          </View>

          <Text variant="caption" tone="muted" style={{ textAlign: 'center' }}>{t('accessNote')}</Text>
          <Pressable onPress={() => { setSrv(API_BASE); setSrvMsg(null); setSrvOpen(true); }} style={{ alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6, paddingHorizontal: 10 }}>
            <Feather name="settings" size={13} color={colors.textMuted} />
            <Text variant="caption" tone="muted" numberOfLines={1}>{srvShown.replace(/^https?:\/\//, '').replace('/api/v1', '')}</Text>
          </Pressable>
        </Appear>
      </ScrollView>
      <Sheet visible={srvOpen} onClose={() => setSrvOpen(false)} title={t('server')}>
        <Field label="URL API" value={srv} onChangeText={setSrv} autoCapitalize="none" autoCorrect={false} keyboardType="url" />
        {!!srvMsg && <Text variant="callout" tone={srvMsg.startsWith('✓') ? 'success' : 'danger'}>{srvMsg}</Text>}
        <Button
          title={t('save')}
          onPress={async () => {
            const url = srv.trim().replace(/\/+$/, '');
            try {
              const r = await fetch(`${url}/auth/me`, { headers: { Accept: 'application/json' } });
              if (r.status !== 401 && !r.ok) throw new Error(String(r.status));
            } catch {
              setSrvMsg(t('networkDown'));
              return;
            }
            setApiBase(url);
            await storage.set('apiBase', url);
            setSrvShown(url);
            setSrvMsg('✓ OK');
            setTimeout(() => setSrvOpen(false), 500);
          }}
        />
        <Button title="Сброс" variant="ghost" onPress={async () => { setApiBase(null); await storage.del('apiBase'); setSrv(DEFAULT_API_BASE); setSrvShown(DEFAULT_API_BASE); }} />
      </Sheet>
    </KeyboardAvoidingView>
  );
}
