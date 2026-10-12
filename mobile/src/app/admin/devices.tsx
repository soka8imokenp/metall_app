import React from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { EmptyState, ErrorState, Screen, Section, Skeleton } from '@/ui/components';
import { DeviceCard } from '@/components/admin/Access';
import { useApi } from '@/api/query';
import { useI18n } from '@/i18n';

export default function AdminDevices() {
  const router = useRouter();
  const { t } = useI18n();
  const q = useApi<any[]>('/admin/devices');
  return (
    <Screen title={t('admAllDevices')} back={() => router.back()} padBottom={false} contentStyle={{ paddingBottom: 40 }} onRefresh={() => q.refetch()} refreshing={q.isRefetching}>
      <Section>
        {q.isLoading ? (
          <View style={{ gap: 10 }}><Skeleton h={120} r={16} /><Skeleton h={120} r={16} /></View>
        ) : q.error ? (
          <ErrorState message={q.error.message} onRetry={() => q.refetch()} />
        ) : !q.data?.length ? (
          <EmptyState icon="smartphone" title={t('admNoDevices')} />
        ) : (
          <View style={{ gap: 10 }}>{q.data.map((d) => <DeviceCard key={d.uid} d={d} showUser />)}</View>
        )}
      </Section>
    </Screen>
  );
}
