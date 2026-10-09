import React, { useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect } from 'react';
import { Feather } from '@/ui/Icon';
import { useQueryClient } from '@tanstack/react-query';
import { ListScreen } from '@/ui/ListScreen';
import { Badge, Card, IconButton, Segmented, SearchBar, Appear } from '@/ui/components';
import { Text } from '@/ui/Text';
import { Pressable } from '@/ui/Pressable';
import { NewOrderSheet } from '@/components/sales/NewOrderSheet';
import { useApi } from '@/api/query';
import { useAuth } from '@/auth/AuthProvider';
import { useI18n } from '@/i18n';
import { useTheme } from '@/theme/ThemeProvider';
import { useDebounced } from '@/lib/hooks';
import { dateShort, money, moneyParts } from '@/lib/format';
import { PAY_TONE, SALES_STATUS_TONE } from '@/lib/status';

type Stage = 'all' | 'unpaid' | 'paid' | 'production' | 'shipped';

export function OrderRow({ r, onPress }: { r: any; onPress: () => void }) {
  const { t, pick } = useI18n();
  const { colors } = useTheme();
  const paidPct = Number(r.amountTotal) > 0 ? Math.min(100, (Number(r.paidAmount) / Number(r.amountTotal)) * 100) : 0;
  return (
    <Card onPress={onPress} style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text variant="headline">{r.number}</Text>
        <Badge label={t(`slS${r.status}` as any)} tone={SALES_STATUS_TONE[r.status] ?? 'neutral'} />
      </View>
      <Text variant="callout" numberOfLines={1}>{pick(r, 'partnerName')}</Text>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text variant="headline" num>{money(r.amountTotal)}</Text>
        <Badge label={t(`slP${r.paymentStatus}` as any)} tone={PAY_TONE[r.paymentStatus] ?? 'neutral'} />
      </View>
      <View style={{ height: 4, borderRadius: 2, backgroundColor: colors.muted, overflow: 'hidden' }}>
        <View style={{ width: `${paidPct}%`, height: 4, backgroundColor: colors.success }} />
      </View>
      <Text variant="caption" tone="secondary">{r.managerName} · {t('slDelivery')} {dateShort(r.deliveryDate)}</Text>
    </Card>
  );
}

export default function Sales() {
  const { t } = useI18n();
  const { colors } = useTheme();
  const { can } = useAuth();
  const router = useRouter();
  const qc = useQueryClient();
  const [stage, setStage] = useState<Stage>('all');
  const [search, setSearch] = useState('');
  const [create, setCreate] = useState(false);
  const q = useDebounced(search, 350);
  const params = useLocalSearchParams<{ new?: string }>();
  useEffect(() => { if (params.new) setCreate(true); }, [params.new]);
  const orders = useApi<any[]>('/sales/orders', { stage, search: q || undefined, limit: 60 });

  const sum = useApi<any>('/sales/summary');
  const pf = sum.data?.portfolio;
  const metrics = pf
    ? [
        { label: t('slPortfolio'), value: moneyParts(pf.totalAmount)[0], sub: `${moneyParts(pf.totalAmount)[1]} · ${pf.activeOrders} ${t('slOrders').toLowerCase()}`, action: can('sales.edit') ? { label: t('slOrderShort'), onPress: () => setCreate(true) } : undefined },
        { label: t('slPaid'), value: `${pf.paidPercent}%`, sub: `${t('fnOverdue').toLowerCase()} ${pf.overduePercent}%` },
      ]
    : undefined;

  const header = (
    <View>
      <Segmented
        options={[
          { value: 'all', label: t('slStAll') },
          { value: 'unpaid', label: t('slStUnpaid') },
          { value: 'paid', label: t('slStPaid') },
          { value: 'production', label: t('slStProduction') },
          { value: 'shipped', label: t('slStShipped') },
        ]}
        value={stage}
        onChange={setStage}
      />
      <SearchBar value={search} onChange={setSearch} placeholder={t('search')} />
    </View>
  );

  return (
    <>
      <ListScreen<any>
        title={t('tabSales')}
        right={
          can('sales.edit') ? <IconButton name="plus" solid onPress={() => setCreate(true)} />: undefined
        }
        header={header}
        metrics={metrics}
        animKey={stage}
        data={orders.data}
        keyExtractor={(r) => r.uid}
        loading={orders.isLoading}
        error={orders.error?.message}
        onRetry={() => orders.refetch()}
        onRefresh={() => qc.invalidateQueries({ queryKey: ['api'] })}
        refreshing={orders.isRefetching}
        emptyTitle={t('slNoOrders')}
        emptyIcon="shopping-bag"
        renderItem={(r, i) => (
          <>
            <OrderRow r={r} onPress={() => router.push(`/sales/${r.uid}`)} />
          </>
        )}
      />
      <NewOrderSheet visible={create} onClose={() => setCreate(false)} onCreated={(uid) => uid && router.push(`/sales/${uid}`)} />
    </>
  );
}
