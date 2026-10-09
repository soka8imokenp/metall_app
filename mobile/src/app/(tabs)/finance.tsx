import React, { useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect } from 'react';
import { Feather } from '@/ui/Icon';
import { useQueryClient } from '@tanstack/react-query';
import { ListScreen } from '@/ui/ListScreen';
import { Badge, Card, IconButton, Segmented, Tabs, SearchBar, Appear } from '@/ui/components';
import { Text } from '@/ui/Text';
import { Pressable } from '@/ui/Pressable';
import { NewOperationSheet } from '@/components/finance/NewOperationSheet';
import { useApi } from '@/api/query';
import { useAuth } from '@/auth/AuthProvider';
import { useI18n } from '@/i18n';
import { useTheme } from '@/theme/ThemeProvider';
import { useDebounced } from '@/lib/hooks';
import { dateShort, money, moneyParts } from '@/lib/format';
import { FIN_STATUS, FIN_TYPE } from '@/lib/status';

type Tab = 'ops' | 'accounts' | 'debt';

export default function Finance() {
  const { t, pick } = useI18n();
  const { colors } = useTheme();
  const { can } = useAuth();
  const router = useRouter();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('ops');
  const [status, setStatus] = useState<string>(can('finance.approve') ? 'pending_approval' : 'all');
  const [search, setSearch] = useState('');
  const [create, setCreate] = useState(false);
  const q = useDebounced(search, 350);
  const params = useLocalSearchParams<{ new?: string }>();
  useEffect(() => { if (params.new) setCreate(true); }, [params.new]);

  const summary = useApi<any>('/finance/summary');
  const ops = useApi<{ rows: any[] }>(tab === 'ops' ? '/finance/operations' : null, { status: status === 'all' ? undefined : status, search: q || undefined, limit: 60 });
  const debt = useApi<{ rows: any[]; totals: any }>(tab === 'debt' ? '/finance/receivables' : null, { limit: 50 });
  const active = tab === 'ops' ? ops : tab === 'debt' ? debt : summary;
  const sm = summary.data;

  const metrics = sm
    ? [
        { label: t('fnPendingAmount'), value: moneyParts(sm.approval?.amountPending)[0], sub: `${moneyParts(sm.approval?.amountPending)[1]} · ${sm.approval?.pendingApproval ?? 0} ${t('fnStPending').toLowerCase()}`, action: can('finance.post') ? { label: t('fnPaymentShort'), onPress: () => setCreate(true) } : undefined },
        { label: `${t('fnNet')} · ${t('fnPeriod')}`, value: moneyParts(sm.flow?.net)[0], sub: moneyParts(sm.flow?.net)[1] },
      ]
    : undefined;

  const header = (
    <View>
      <Tabs options={[{ value: 'ops', label: t('fnOperations') }, { value: 'accounts', label: t('fnSummary') }, { value: 'debt', label: t('fnReceivables') }]} value={tab} onChange={setTab} />
      {tab === 'ops' && (
        <>
          <Segmented
            options={[
              { value: 'pending_approval', label: t('fnStPending') },
              { value: 'approved', label: t('fnStApproved') },
              { value: 'posted', label: t('fnStPosted') },
              { value: 'draft', label: t('fnStDraft') },
              { value: 'rejected', label: t('fnStRejected') },
              { value: 'all', label: t('all') },
            ]}
            value={status}
            onChange={setStatus}
          />
          <SearchBar value={search} onChange={setSearch} placeholder={t('search')} />
        </>
      )}
    </View>
  );

  return (
    <>
      <ListScreen<any>
        title={t('tabFinance')}
        right={
          can('finance.post') ? <IconButton name="plus" solid onPress={() => setCreate(true)} /> : undefined
        }
        header={header}
        metrics={metrics}
        animKey={`${tab}-${status}`}
        data={tab === 'ops' ? ops.data?.rows : tab === 'debt' ? debt.data?.rows : sm?.accounts}
        keyExtractor={(r) => r.uid ?? r.key ?? r.partner?.uid}
        loading={active.isLoading}
        error={active.error?.message}
        onRetry={() => active.refetch()}
        onRefresh={() => qc.invalidateQueries({ queryKey: ['api'] })}
        refreshing={active.isRefetching}
        emptyTitle={tab === 'debt' ? t('fnNoDebt') : t('fnNoOps')}
        emptyIcon="credit-card"
        renderItem={(r, i) => (
          <>
            {tab === 'ops' ? <OpRow r={r} onPress={() => router.push(`/finance/${r.uid}`)} /> : tab === 'debt' ? <DebtRow r={r} /> : <AccountRow r={r} />}
          </>
        )}
      />
      <NewOperationSheet visible={create} onClose={() => setCreate(false)} onCreated={(uid) => uid && router.push(`/finance/${uid}`)} />
    </>
  );
}

function OpRow({ r, onPress }: { r: any; onPress: () => void }) {
  const { t, pick } = useI18n();
  const { colors } = useTheme();
  const [k, tone] = FIN_STATUS[r.status] ?? ['fnStDraft', 'neutral'];
  const inc = r.type === 'income';
  return (
    <Card onPress={onPress} style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="caption" tone="secondary">{r.number} · {dateShort(r.occurredAt)}</Text>
          <Text variant="callout" style={{ fontWeight: '600' }} numberOfLines={2}>{r.cashflowItem ? pick(r.cashflowItem, 'name') : t(FIN_TYPE[r.type] ?? 'fnExpense')}</Text>
          {!!r.partner && <Text variant="caption" tone="secondary" numberOfLines={1}>{pick(r.partner, 'name')}</Text>}
        </View>
        <View style={{ alignItems: 'flex-end', gap: 2 }}>
          <Text variant="headline" num style={{ color: inc ? colors.success : colors.text }}>{inc ? '+' : r.type === 'expense' ? '−' : ''}{money(r.amount, r.currency)}</Text>
        </View>
      </View>
      <Badge label={t(k)} tone={tone} />
    </Card>
  );
}

function AccountRow({ r }: { r: any }) {
  const { pick } = useI18n();
  const { colors } = useTheme();
  const icon = r.kind === 'cash' ? 'dollar-sign' : r.kind === 'bank' ? 'briefcase' : r.kind === 'receivable' ? 'arrow-down-left' : r.kind === 'payable' ? 'arrow-up-right' : 'layers';
  const neg = Number(r.saldo) < 0;
  return (
    <Card style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <View style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: colors.muted, alignItems: 'center', justifyContent: 'center' }}>
        <Feather name={icon as any} size={18} color={colors.text} />
      </View>
      <View style={{ flex: 1 }}>
        <Text variant="callout" style={{ fontWeight: '600' }} numberOfLines={1}>{pick(r, 'name')}</Text>
        <Text variant="caption" tone="secondary">{r.code} · {r.currency}</Text>
      </View>
      <Text variant="callout" num style={{ fontWeight: '700', color: neg ? colors.danger : colors.text }}>{money(r.saldo, r.currency)}</Text>
    </Card>
  );
}

function DebtRow({ r }: { r: any }) {
  const { t, pick } = useI18n();
  return (
    <Card style={{ gap: 6 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 10 }}>
        <Text variant="callout" style={{ fontWeight: '600', flex: 1 }} numberOfLines={2}>{pick(r.partner, 'name')}</Text>
        <Text variant="headline" num>{money(r.debt)}</Text>
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text variant="caption" tone="secondary" num>{r.orders} · {t('fnOverdue')}: {money(r.overdue)}</Text>
        {r.overLimit && <Badge label={t('fnOverLimit')} tone="danger" />}
      </View>
    </Card>
  );
}
