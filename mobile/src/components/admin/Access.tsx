import React, { useState } from 'react';
import { View } from 'react-native';
import { Badge, Button, Card, Field } from '@/ui/components';
import { Sheet } from '@/ui/Sheet';
import { Text } from '@/ui/Text';
import { Feather } from '@/ui/Icon';
import { useAction } from '@/api/action';
import { useI18n } from '@/i18n';
import { useTheme } from '@/theme/ThemeProvider';
import { dateTime } from '@/lib/format';

/** Состояние учётной записи: отключена, заблокирована после неудачных входов или активна. */
export function userState(u: any): ['admDisabled' | 'admLocked' | 'admActive', 'danger' | 'warning' | 'success'] {
  if (!u.isActive) return ['admDisabled', 'danger'];
  if (u.lockedUntil && new Date(u.lockedUntil).getTime() > Date.now()) return ['admLocked', 'warning'];
  return ['admActive', 'success'];
}

/**
 * Устройство пользователя. Отзыв устройства закрывает все его сессии: телефон
 * выходит из приложения и войти с него снова нельзя, пока устройство не
 * восстановят.
 */
export function DeviceCard({ d, showUser }: { d: any; showUser?: boolean }) {
  const { t } = useI18n();
  const { colors } = useTheme();
  const act = useAction();
  const [ask, setAsk] = useState(false);
  const [reason, setReason] = useState('');
  const revoked = !!d.revokedAt;

  const revoke = async () => {
    const r = await act.run('POST', `/admin/devices/${d.uid}/revoke`, { reason: reason.trim() || undefined }, { success: t('admRevoked') });
    if (r) setAsk(false);
  };

  return (
    <Card style={{ gap: 6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Feather name="smartphone" size={18} color={revoked ? colors.textMuted : colors.textSecondary} />
        <Text variant="headline" numberOfLines={1} style={{ flex: 1 }}>{d.model || d.platform}</Text>
        <Badge label={revoked ? t('admDevRevoked') : t('admActive')} tone={revoked ? 'danger' : 'success'} />
      </View>
      {showUser && !!d.user && <Text variant="callout" numberOfLines={1}>{d.user.fullName} · @{d.user.login}</Text>}
      <Text variant="caption" tone="secondary">
        {[d.platform, d.osVersion && `OS ${d.osVersion}`, d.appVersion && `v${d.appVersion}`, `${t('admSessionsN')} ${d.activeSessions ?? 0}`].filter(Boolean).join(' · ')}
      </Text>
      <Text variant="caption" tone="muted">{t('admLastSeen')}: {dateTime(d.lastSeenAt)}</Text>
      {revoked ? (
        <Button size="sm" variant="secondary" icon="refresh-cw" title={t('admRestore')} needsNetwork loading={act.busy} onPress={() => act.run('POST', `/admin/devices/${d.uid}/restore`, {}, { success: t('admRestored') })} />
      ) : (
        <Button size="sm" variant="secondary" icon="x-circle" title={t('admRevoke')} needsNetwork onPress={() => { act.reset(); setReason(''); setAsk(true); }} />
      )}
      <Sheet visible={ask} onClose={() => setAsk(false)} title={t('admRevokeDevice')}>
        <Text variant="callout" tone="secondary">{t('admRevokeHint')}</Text>
        <Field label={t('admReason')} value={reason} onChangeText={setReason} />
        <Button title={t('admRevoke')} variant="danger" icon="x-circle" needsNetwork loading={act.busy} onPress={revoke} />
      </Sheet>
    </Card>
  );
}

/** Активная сессия (вход в веб или в приложение); её можно закрыть. */
export function SessionCard({ s }: { s: any }) {
  const current = !!s.current;
  const { t } = useI18n();
  const { colors } = useTheme();
  const act = useAction();
  return (
    <Card style={{ gap: 6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Feather name={s.client === 'mobile' ? 'smartphone' : 'globe'} size={18} color={colors.textSecondary} />
        <Text variant="headline" numberOfLines={1} style={{ flex: 1 }}>{s.device?.model || (s.client === 'mobile' ? t('admMobile') : t('admWeb'))}</Text>
        {current && <Badge label={t('admThis')} tone="info" />}
      </View>
      <Text variant="caption" tone="secondary" numberOfLines={1}>{[s.ip, s.userAgent].filter(Boolean).join(' · ')}</Text>
      <Text variant="caption" tone="muted">{t('admLastSeen')}: {dateTime(s.lastUsedAt)} · {t('admUntil')} {dateTime(s.expiresAt)}</Text>
      {!current && <Button size="sm" variant="secondary" icon="log-out" title={t('admEndSession')} needsNetwork loading={act.busy} onPress={() => act.run('DELETE', `/admin/sessions/${s.uid}`, undefined, { success: t('admSessionEnded') })} />}
    </Card>
  );
}
