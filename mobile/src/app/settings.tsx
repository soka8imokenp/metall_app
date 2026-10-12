import React, { useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { Card, Screen, Section } from '@/ui/components';
import { Feather, IconName } from '@/ui/Icon';
import { Text } from '@/ui/Text';
import { Pressable } from '@/ui/Pressable';
import { Switch } from '@/ui/Switch';
import { LangToggle, ThemeToggle } from '@/ui/LangToggle';
import { PinSetupSheet, useAppLock } from '@/ui/AppLock';
import { useUpdates } from '@/ui/UpdatePrompt';
import { useToast } from '@/ui/Toast';
import { useAuth } from '@/auth/AuthProvider';
import { useI18n } from '@/i18n';
import { useTheme } from '@/theme/ThemeProvider';
import { APP_VERSION } from '@/lib/updates';
import { API_BASE } from '@/api/client';

/** Строка настройки: иконка и подпись слева, управление справа. */
function Row({ icon, label, hint, right, onPress, last }: { icon: IconName; label: string; hint?: string; right?: React.ReactNode; onPress?: () => void; last?: boolean }) {
  const { colors } = useTheme();
  const body = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14, borderBottomWidth: last ? 0 : 1, borderBottomColor: colors.border }}>
      <View style={{ width: 34, height: 34, borderRadius: 10, backgroundColor: colors.canvas, alignItems: 'center', justifyContent: 'center' }}>
        <Feather name={icon} size={17} color={colors.textSecondary} />
      </View>
      <View style={{ flex: 1 }}>
        <Text variant="body" style={{ fontWeight: '600' }}>{label}</Text>
        {!!hint && <Text variant="caption" tone="muted" numberOfLines={1}>{hint}</Text>}
      </View>
      {right ?? (onPress ? <Feather name="chevron-right" size={18} color={colors.textMuted} /> : null)}
    </View>
  );
  return onPress ? <Pressable onPress={onPress} scaleTo={0.99}>{body}</Pressable> : body;
}

/**
 * Настройки: всё, что раньше теснилось в боковом меню. Язык и тема, код и
 * отпечаток, версия и обновления, учётная запись.
 */
export default function Settings() {
  const router = useRouter();
  const { t } = useI18n();
  const { user, signOut } = useAuth();
  const lock = useAppLock();
  const updates = useUpdates();
  const toast = useToast();
  const { colors } = useTheme();
  const [pinOpen, setPinOpen] = useState(false);

  return (
    <Screen title={t('settings')} back={() => router.back()} padBottom={false}>
      <Section title={t('appearance')}>
        <Card padded={false} style={{ paddingHorizontal: 16 }}>
          <Row icon="globe" label={t('language')} right={<LangToggle width={104} height={38} />} />
          <Row icon={colors.isDark ? 'moon' : 'sun'} label={t('theme')} right={<ThemeToggle width={104} height={38} />} last />
        </Card>
      </Section>

      <Section title={t('lkSecurity')}>
        <Card padded={false} style={{ paddingHorizontal: 16 }}>
          <Row
            icon="lock"
            label={t('lkPin')}
            right={
              <Switch
                value={lock.pinSet}
                onChange={async (on) => {
                  if (on) setPinOpen(true);
                  else { await lock.clearPin(); toast.show(t('lkOff'), 'info'); }
                }}
              />
            }
            last={!lock.pinSet}
          />
          {lock.pinSet && <Row icon="edit-3" label={t('lkChange')} onPress={() => setPinOpen(true)} />}
          {lock.pinSet && (
            <Row
              icon={lock.bioKind === 'face' ? 'scan-face' : 'fingerprint'}
              label={t('lkBio')}
              hint={lock.bioAvailable ? undefined : t('lkNoBio')}
              right={
                <Switch
                  value={lock.bioEnabled}
                  disabled={!lock.bioAvailable}
                  onChange={async (on) => {
                    if (!lock.bioAvailable) { toast.show(t('lkNoBio'), 'error'); return; }
                    await lock.setBio(on);
                  }}
                />
              }
              last
            />
          )}
        </Card>
      </Section>

      <Section title={t('appSection')}>
        <Card padded={false} style={{ paddingHorizontal: 16 }}>
          <Row icon="refresh-cw" label={t('upCheck')} hint={`${t('version')} ${APP_VERSION}`} onPress={() => void updates.check(true)} />
          <Row icon="settings" label={t('server')} hint={API_BASE.replace(/^https?:\/\//, '').replace('/api/v1', '')} last />
        </Card>
      </Section>

      <Section title={t('account')} style={{ marginBottom: 40 }}>
        <Card padded={false} style={{ paddingHorizontal: 16 }}>
          <Row icon="briefcase" label={user?.fullName ?? ''} hint={`@${user?.login ?? ''}`} />
          <Pressable onPress={signOut} scaleTo={0.99}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14 }}>
              <View style={{ width: 34, height: 34, borderRadius: 10, backgroundColor: colors.dangerBg, alignItems: 'center', justifyContent: 'center' }}>
                <Feather name="log-out" size={17} color={colors.brand} />
              </View>
              <Text variant="body" style={{ fontWeight: '700', color: colors.brand }}>{t('signOut')}</Text>
            </View>
          </Pressable>
        </Card>
      </Section>

      <PinSetupSheet visible={pinOpen} onClose={() => setPinOpen(false)} onDone={() => { setPinOpen(false); toast.show(t('lkOn'), 'success'); }} />
    </Screen>
  );
}
