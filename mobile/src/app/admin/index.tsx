import React, { useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { Badge, Button, Card, EmptyState, ErrorState, Field, IconBubble, KV, Screen, SearchBar, Section, Skeleton } from '@/ui/components';
import { Sheet } from '@/ui/Sheet';
import { Text } from '@/ui/Text';
import { Feather } from '@/ui/Icon';
import { useApi } from '@/api/query';
import { useAction } from '@/api/action';
import { useAuth } from '@/auth/AuthProvider';
import { useI18n } from '@/i18n';
import { useTheme } from '@/theme/ThemeProvider';
import { useDebounced } from '@/lib/hooks';
import { dateTime } from '@/lib/format';
import { userState } from '@/components/admin/Access';

/**
 * Администрирование (ТЗ: «Администратор — управление доступом, устройствами
 * и настройками мобильного приложения»): пользователи, их сессии и
 * устройства, минимальная версия приложения.
 */
export default function Admin() {
  const router = useRouter();
  const { t, pick } = useI18n();
  const { colors } = useTheme();
  const { can } = useAuth();
  const [search, setSearch] = useState('');
  const q = useDebounced(search, 350);
  const users = useApi<{ total: number; rows: any[] }>(can('admin.users') ? '/admin/users' : null, { search: q || undefined, limit: 200 });
  const devices = useApi<any[]>(can('admin.users') ? '/admin/devices' : null);
  const cfg = useApi<any>(can('settings.edit') ? '/admin/mobile-config' : null);
  const [cfgOpen, setCfgOpen] = useState(false);

  const activeDevices = (devices.data ?? []).filter((d) => !d.revokedAt).length;

  return (
    <Screen title={t('admTitle')} back={() => router.back()} padBottom={false} contentStyle={{ paddingBottom: 40 }} onRefresh={() => { users.refetch(); devices.refetch(); cfg.refetch(); }} refreshing={users.isRefetching}>
      {can('settings.edit') && (
        <Section title={t('admApp')}>
          <Card onPress={() => setCfgOpen(true)} style={{ gap: 8 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <IconBubble name="smartphone" tone="accent" />
              <View style={{ flex: 1 }}>
                <Text variant="headline">{t('admMinVersion')}</Text>
                <Text variant="caption" tone="secondary">{cfg.data?.minVersion || t('admNotSet')}</Text>
              </View>
              <Feather name="chevron-right" size={18} color={colors.textMuted} />
            </View>
            {!!(cfg.data && pick(cfg.data, 'message')) && <Text variant="caption" tone="secondary">{pick(cfg.data, 'message')}</Text>}
          </Card>
        </Section>
      )}

      {can('admin.users') && (
        <Section title={t('admDevices')}>
          <Card onPress={() => router.push('/admin/devices')}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <IconBubble name="shield" />
              <View style={{ flex: 1 }}>
                <Text variant="headline">{t('admAllDevices')}</Text>
                <Text variant="caption" tone="secondary">{devices.data ? `${devices.data.length} · ${t('admActiveN')} ${activeDevices}` : '…'}</Text>
              </View>
              <Feather name="chevron-right" size={18} color={colors.textMuted} />
            </View>
          </Card>
        </Section>
      )}

      {can('admin.users') && (
        <Section title={`${t('admUsers')}${users.data ? ` · ${users.data.total}` : ''}`}>
          <View style={{ marginHorizontal: -20 }}>
            <SearchBar value={search} onChange={setSearch} placeholder={t('search')} />
          </View>
          {users.isLoading ? (
            <View style={{ gap: 10 }}><Skeleton h={70} r={16} /><Skeleton h={70} r={16} /></View>
          ) : users.error ? (
            <ErrorState message={users.error.message} onRetry={() => users.refetch()} />
          ) : !users.data?.rows.length ? (
            <EmptyState icon="users" title={t('admNoUsers')} />
          ) : (
            <View style={{ gap: 10 }}>
              {users.data.rows.map((u) => {
                const [sk, tone] = userState(u);
                const roles = Array.from(new Set((u.assignments ?? []).map((a: any) => pick(a.role, 'name')))).join(', ');
                return (
                  <Card key={u.uid} onPress={() => router.push(`/admin/${u.uid}`)} style={{ gap: 4 }}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                      <Text variant="headline" numberOfLines={1} style={{ flex: 1 }}>{u.fullName}</Text>
                      <Badge label={t(sk)} tone={tone} />
                    </View>
                    <Text variant="caption" tone="secondary" numberOfLines={1}>@{u.login}{roles ? ` · ${roles}` : ''}</Text>
                    <Text variant="caption" tone="muted">{t('admLastLogin')}: {u.lastLoginAt ? dateTime(u.lastLoginAt) : '—'}</Text>
                  </Card>
                );
              })}
            </View>
          )}
        </Section>
      )}

      {cfg.data && <ConfigSheet visible={cfgOpen} onClose={() => setCfgOpen(false)} cfg={cfg.data} />}
    </Screen>
  );
}

function ConfigSheet({ visible, onClose, cfg }: { visible: boolean; onClose: () => void; cfg: any }) {
  const { t } = useI18n();
  const act = useAction();
  const [minVersion, setMin] = useState(cfg.minVersion ?? '');
  const [messageRu, setRu] = useState(cfg.messageRu ?? '');
  const [messageUz, setUz] = useState(cfg.messageUz ?? '');
  const ok = !minVersion || /^\d+\.\d+\.\d+$/.test(minVersion.trim());

  const save = async () => {
    const r = await act.run('PUT', '/admin/mobile-config', { minVersion: minVersion.trim() || undefined, messageRu, messageUz }, { success: t('saved') });
    if (r) onClose();
  };

  return (
    <Sheet visible={visible} onClose={onClose} title={t('admApp')}>
      <Text variant="callout" tone="secondary">{t('admMinHint')}</Text>
      <Field label={t('admMinVersion')} value={minVersion} onChangeText={setMin} placeholder="0.9.0" keyboardType="numbers-and-punctuation" error={ok ? null : t('admVersionFmt')} />
      <Field label={`${t('admMessage')} (RU)`} value={messageRu} onChangeText={setRu} multiline style={{ height: 80, paddingTop: 12, textAlignVertical: 'top' }} />
      <Field label={`${t('admMessage')} (UZ)`} value={messageUz} onChangeText={setUz} multiline style={{ height: 80, paddingTop: 12, textAlignVertical: 'top' }} />
      {!!cfg.latestVersion && <KV k={t('admLatest')} v={cfg.latestVersion} />}
      <Button title={t('save')} icon="check" needsNetwork loading={act.busy} disabled={!ok} onPress={save} />
    </Sheet>
  );
}
