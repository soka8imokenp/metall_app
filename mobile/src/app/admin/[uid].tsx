import React from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Badge, Button, Card, Divider, EmptyState, ErrorState, KV, Screen, Section, Skeleton } from '@/ui/components';
import { Text } from '@/ui/Text';
import { DeviceCard, SessionCard, userState } from '@/components/admin/Access';
import { useApi } from '@/api/query';
import { useAction } from '@/api/action';
import { useAuth } from '@/auth/AuthProvider';
import { useI18n } from '@/i18n';
import { dateTime } from '@/lib/format';

/** Пользователь: доступ (включить, отключить, разблокировать), роли, сессии, устройства. */
export default function AdminUser() {
  const { uid } = useLocalSearchParams<{ uid: string }>();
  const router = useRouter();
  const { t, pick } = useI18n();
  const { user: me } = useAuth();
  const act = useAction();
  // отдельного GET /admin/users/:uid нет — берём из списка (он кэширован после экрана списка)
  const users = useApi<{ rows: any[] }>('/admin/users', { limit: 500 });
  const sessions = useApi<any[]>('/admin/sessions', { userUid: uid });
  const devices = useApi<any[]>('/admin/devices', { userUid: uid });
  const u = users.data?.rows.find((r) => r.uid === uid);
  const self = !!u && u.login === me?.login;

  const refresh = () => { users.refetch(); sessions.refetch(); devices.refetch(); };

  return (
    <Screen title={u?.fullName ?? '…'} subtitle={u ? `@${u.login}` : undefined} back={() => router.back()} padBottom={false} contentStyle={{ paddingBottom: 40 }} onRefresh={refresh} refreshing={sessions.isRefetching}>
      {users.isLoading ? (
        <View style={{ padding: 20, gap: 12 }}><Skeleton h={160} r={16} /><Skeleton h={100} r={16} /></View>
      ) : users.error ? (
        <ErrorState message={users.error.message} onRetry={() => users.refetch()} />
      ) : !u ? (
        <EmptyState icon="users" title={t('admNoUsers')} />
      ) : (
        <>
          <Section>
            <Card style={{ gap: 8 }}>
              {(() => { const [sk, tone] = userState(u); return <Badge label={t(sk)} tone={tone} />; })()}
              <KV k={t('admLastLogin')} v={u.lastLoginAt ? dateTime(u.lastLoginAt) : '—'} />
              {!!u.phone && <KV k={t('admPhone')} v={u.phone} />}
              {!!u.email && <KV k="Email" v={u.email} />}
              {!!u.lockedUntil && new Date(u.lockedUntil).getTime() > Date.now() && <KV k={t('admLockedUntil')} v={dateTime(u.lockedUntil)} />}
              {u.failedLoginCount > 0 && <KV k={t('admFailed')} v={String(u.failedLoginCount)} />}
              <Divider />
              {(u.assignments ?? []).map((a: any, i: number) => (
                <View key={i} style={{ gap: 2 }}>
                  <Text variant="callout" style={{ fontWeight: '600' }}>{pick(a.role, 'name')}</Text>
                  <Text variant="caption" tone="secondary" numberOfLines={1}>{a.company ? pick(a.company, 'name') : t('bothCompanies')}</Text>
                </View>
              ))}
            </Card>
          </Section>

          {!self && (
            <Section>
              <View style={{ gap: 10 }}>
                {!!u.lockedUntil && new Date(u.lockedUntil).getTime() > Date.now() && (
                  <Button title={t('admUnlock')} icon="unlock" needsNetwork loading={act.busy} onPress={() => act.run('POST', `/admin/users/${u.uid}/unlock`, {}, { success: t('admUnlocked') })} />
                )}
                <Button
                  title={u.isActive ? t('admDeactivate') : t('admActivate')}
                  icon={u.isActive ? 'user-x' : 'user-check'}
                  variant={u.isActive ? 'secondary' : 'primary'}
                  needsNetwork
                  loading={act.busy}
                  onPress={() => act.run('PATCH', `/admin/users/${u.uid}`, { isActive: !u.isActive }, { success: t('saved') })}
                />
              </View>
            </Section>
          )}

          <Section title={`${t('admSessions')}${sessions.data ? ` · ${sessions.data.length}` : ''}`}>
            {!sessions.data?.length ? (
              <Text variant="callout" tone="secondary">{sessions.isLoading ? '…' : t('admNoSessions')}</Text>
            ) : (
              <View style={{ gap: 10 }}>{sessions.data.map((s) => <SessionCard key={s.uid} s={s} />)}</View>
            )}
          </Section>

          <Section title={`${t('admDevices')}${devices.data ? ` · ${devices.data.length}` : ''}`}>
            {!devices.data?.length ? (
              <Text variant="callout" tone="secondary">{devices.isLoading ? '…' : t('admNoDevices')}</Text>
            ) : (
              <View style={{ gap: 10 }}>{devices.data.map((d) => <DeviceCard key={d.uid} d={d} />)}</View>
            )}
          </Section>
        </>
      )}
    </Screen>
  );
}
