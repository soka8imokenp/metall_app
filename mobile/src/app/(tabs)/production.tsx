import React, { useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ListScreen } from '@/ui/ListScreen';
import { Badge, Card, Segmented, Tabs, SearchBar, Appear } from '@/ui/components';
import { Text } from '@/ui/Text';
import { StageCard } from '@/components/production/StageCard';
import { useApi } from '@/api/query';
import { useI18n } from '@/i18n';
import { useTheme } from '@/theme/ThemeProvider';
import { useDebounced } from '@/lib/hooks';
import { dateShort, num, unit } from '@/lib/format';
import { ORDER_STATUS } from '@/lib/status';
import { useAuth } from '@/auth/AuthProvider';

type Tab = 'mine' | 'orders';

export default function Production() {
  const { t, pick } = useI18n();
  const { can } = useAuth();
  const router = useRouter();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>(can('production.work') && !can('production.manage') ? 'mine' : 'orders');
  const params = useLocalSearchParams<{ tab?: string }>();
  useEffect(() => { if (params.tab === 'mine' || params.tab === 'orders') setTab(params.tab); }, [params.tab]);
  const [state, setState] = useState<'all' | 'planned' | 'active' | 'done'>('active');
  const [search, setSearch] = useState('');
  const q = useDebounced(search, 350);

  const mine = useApi<{ rows: any[] }>(tab === 'mine' ? '/production/my-stages' : null, { limit: 100 });
  const orders = useApi<{ rows: any[] }>(tab === 'orders' ? '/production/orders' : null, { state, search: q || undefined, limit: 60 });
  const active = tab === 'mine' ? mine : orders;
  const sum = useApi<any>('/production/summary');
  const metrics = sum.data ? [
    { label: t('prActive'), value: String(sum.data.orders?.inProgress ?? 0), sub: `${sum.data.orders?.planned ?? 0} · ${t('prPlanned').toLowerCase()}` },
    { label: t('prOverdue'), value: String(sum.data.orders?.overdue ?? 0), sub: `${sum.data.orders?.produced ?? 0} · ${t('prStatusProduced').toLowerCase()}` },
  ] : undefined;

  const header = (
    <View>
      <Tabs options={[{ value: 'mine', label: t('prMyStages') }, { value: 'orders', label: t('prOrders') }]} value={tab} onChange={setTab} />
      {tab === 'orders' && (
        <>
          <Segmented
            options={[
              { value: 'active', label: t('prActive') },
              { value: 'planned', label: t('prPlanned') },
              { value: 'done', label: t('prDone') },
              { value: 'all', label: t('prAll') },
            ]}
            value={state}
            onChange={setState}
          />
          <SearchBar value={search} onChange={setSearch} placeholder={t('search')} />
        </>
      )}
    </View>
  );

  return (
    <ListScreen<any>
      title={t('tabProduction')}
      header={header}
      metrics={metrics}
      animKey={`${tab}-${state}`}
      data={tab === 'mine' ? mine.data?.rows : orders.data?.rows}
      keyExtractor={(r) => (tab === 'mine' ? `${r.orderUid}-${r.seq}` : r.uid)}
      loading={active.isLoading}
      error={active.error?.message}
      onRetry={() => active.refetch()}
      onRefresh={() => qc.invalidateQueries({ queryKey: ['api'] })}
      refreshing={active.isRefetching}
      emptyTitle={tab === 'mine' ? t('prNoStages') : t('prNoOrders')}
      emptyIcon="tool"
      renderItem={(r, i) =>
        tab === 'mine' ? (
          <>
            <StageCard s={r} orderStatus={r.orderStatus} orderUid={r.orderUid} orderNumber={r.orderNumber} itemName={pick(r, 'itemName')} onOpenOrder={() => router.push(`/production/${r.orderUid}`)} />
          </>
        ) : (
          <>
            <OrderRow r={r} onPress={() => router.push(`/production/${r.uid}`)} />
          </>
        )
      }
    />
  );
}

function OrderRow({ r, onPress }: { r: any; onPress: () => void }) {
  const { t, pick } = useI18n();
  const { colors } = useTheme();
  const [k, tone] = ORDER_STATUS[r.status] ?? ['prStatusDraft', 'neutral'];
  const pct = Math.min(100, Number(r.qtyPercent ?? 0));
  const overdue = r.dueDate && new Date(r.dueDate) < new Date() && !['produced', 'closed', 'cancelled'].includes(r.status);
  return (
    <Card onPress={onPress} style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text variant="headline">{r.number}</Text>
        <Badge label={t(k)} tone={tone} />
      </View>
      <Text variant="callout" numberOfLines={2}>{pick(r, 'itemName')}</Text>
      <View style={{ height: 6, borderRadius: 3, backgroundColor: colors.muted, overflow: 'hidden' }}>
        <View style={{ width: `${pct}%`, height: 6, backgroundColor: colors.accent, borderRadius: 3 }} />
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text variant="caption" tone="secondary" num>{num(r.qtyProduced, 1)} / {num(r.qtyPlanned, 1)} {unit(r.unit)} · {r.stagesDone}/{r.stagesTotal}</Text>
        <Text variant="caption" tone={overdue ? 'danger' : 'secondary'} style={{ fontWeight: overdue ? '700' : '400' }}>{t('prDue')} {dateShort(r.dueDate)}</Text>
      </View>
    </Card>
  );
}
