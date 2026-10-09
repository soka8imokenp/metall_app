import React, { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Feather } from '@/ui/Icon';
import { useQueryClient } from '@tanstack/react-query';
import { ListScreen } from '@/ui/ListScreen';
import { Badge, Button, Card, KV, Divider, IconButton, Tabs, SearchBar, Appear } from '@/ui/components';
import { Sheet } from '@/ui/Sheet';
import { Text } from '@/ui/Text';
import { Pressable } from '@/ui/Pressable';
import { MoveSheet, MoveInit, MOVE_LABEL } from '@/components/warehouse/MoveSheet';
import { useApi } from '@/api/query';
import { useAuth } from '@/auth/AuthProvider';
import { useI18n } from '@/i18n';
import { useTheme } from '@/theme/ThemeProvider';
import { dateTime, money, num, unit as u, moneyParts } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';

type Tab = 'stock' | 'moves' | 'inventory';

export default function Warehouse() {
  const { t, pick } = useI18n();
  const { colors } = useTheme();
  const { can } = useAuth();
  const router = useRouter();
  const qc = useQueryClient();
  const params = useLocalSearchParams<{ q?: string; move?: string; item?: string; batch?: string; new?: string }>();

  const [tab, setTab] = useState<Tab>('stock');
  const [search, setSearch] = useState('');
  const [critical, setCritical] = useState(false);
  const [detail, setDetail] = useState<any | null>(null);
  const [move, setMove] = useState<MoveInit | null>(null);
  const q = useDebounced(search, 350);

  // пришли со сканера: подставить поиск или сразу открыть операцию
  useEffect(() => {
    if (params.q) { setTab('stock'); setSearch(String(params.q)); }
    if (params.new) setMove({});
    if (params.move) setMove({ itemCode: params.item as string | undefined, batchNumber: params.batch as string | undefined });
  }, [params.q, params.move, params.item, params.batch, params.new]);

  const summary = useApi<any>('/warehouse/summary');
  const stock = useApi<{ rows: any[] }>(tab === 'stock' ? '/warehouse/stock' : null, { search: q || undefined, critical: critical ? 'true' : undefined, limit: 100 });
  const moves = useApi<{ rows: any[]; total: number }>(tab === 'moves' ? '/warehouse/moves' : null, { limit: 60 });
  const sheets = useApi<{ rows: any[] }>(tab === 'inventory' ? '/warehouse/inventory' : null, { limit: 50 });

  const canMove = can('warehouse.move');
  const active = tab === 'stock' ? stock : tab === 'moves' ? moves : sheets;
  const refresh = () => qc.invalidateQueries({ queryKey: ['api'] });

  const metrics = summary.data
    ? [
        { label: t('whValue'), value: moneyParts(summary.data.stock?.value)[0], sub: moneyParts(summary.data.stock?.value)[1], action: canMove ? { label: t('opReceipt'), onPress: () => setMove({ type: 'receipt' }) } : undefined },
        { label: t('whItems'), value: String(summary.data.stock?.items ?? 0), sub: `${summary.data.levels?.belowMin ?? 0} · ${t('whBelowMin').toLowerCase()}`, action: { label: t('whScan'), onPress: () => router.push('/scan') } },
      ]
    : undefined;

  const header = (
    <View>
      <Tabs
        options={[
          { value: 'stock', label: t('whStock') },
          { value: 'moves', label: t('whMoves') },
          { value: 'inventory', label: t('whInventory') },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'stock' && (
        <>
          <SearchBar value={search} onChange={setSearch} placeholder={t('search')} />
          <View style={{ flexDirection: 'row', paddingHorizontal: 20, marginBottom: 12 }}>
            <Pressable
              onPress={() => setCritical((c) => !c)}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, height: 32, borderRadius: 16, borderWidth: 1.5, borderColor: critical ? colors.danger : colors.border, backgroundColor: critical ? colors.dangerBg : 'transparent' }}
            >
              <Feather name="alert-triangle" size={13} color={critical ? colors.danger : colors.textSecondary} />
              <Text variant="caption" style={{ fontWeight: '600', color: critical ? colors.danger : colors.textSecondary }}>{t('whCritical')}</Text>
            </Pressable>
          </View>
        </>
      )}
    </View>
  );

  const rightBtns = (
    <View style={{ flexDirection: 'row', gap: 8 }}>
      {canMove && <IconButton name="plus" onPress={() => setMove({})} />}
    </View>
  );

  const data = tab === 'stock' ? stock.data?.rows : tab === 'moves' ? moves.data?.rows : sheets.data?.rows;

  return (
    <>
      <ListScreen<any>
        title={t('tabWarehouse')}
        right={rightBtns}
        header={header}
        metrics={metrics}
        animKey={`${tab}-${critical}`}
        data={data}
        keyExtractor={(r) => r.key ?? r.uid}
        loading={active.isLoading}
        error={active.error?.message}
        onRetry={() => active.refetch()}
        onRefresh={refresh}
        refreshing={active.isRefetching}
        emptyTitle={tab === 'moves' ? t('whNoMoves') : t('whNoStock')}
        emptyIcon="package"
        renderItem={(r, i) =>
          tab === 'stock' ? (
            <>
              <StockRow r={r} onPress={() => setDetail(r)} />
            </>
          ) : tab === 'moves' ? (
            <MoveRow r={r} />
          ) : (
            <SheetRow r={r} onPress={() => router.push(`/inventory/${r.uid}`)} />
          )
        }
      />

      <Sheet visible={!!detail} onClose={() => setDetail(null)} title={detail ? detail.item?.code : ''}>
        {detail && (
          <>
            <Text variant="headline">{pick(detail.item, 'name')}</Text>
            <Card>
              <KV k={t('whWarehouse')} v={pick(detail.warehouse, 'name')} />
              <KV k={t('whLocation')} v={detail.location ?? '—'} />
              <KV k={t('whBatch')} v={detail.batch?.number ?? '—'} />
              <Divider />
              <KV k={t('whOnHand')} v={`${num(detail.qtyOnHand, 3)} ${u(detail.item?.unit)}`} strong />
              <KV k={t('whReserved')} v={`${num(detail.qtyReserved, 3)} ${u(detail.item?.unit)}`} />
              <KV k={t('whAvailable')} v={`${num(detail.qtyAvailable, 3)} ${u(detail.item?.unit)}`} strong />
            </Card>
            {canMove && (
              <Button
                title={t('whNewMove')}
                icon="repeat"
                onPress={() => {
                  setMove({ itemCode: detail.item?.code, batchNumber: detail.batch?.number, warehouseCode: detail.warehouse?.code, locationCode: detail.location });
                  setDetail(null);
                }}
              />
            )}
          </>
        )}
      </Sheet>

      <MoveSheet visible={!!move} init={move ?? undefined} onClose={() => setMove(null)} />
    </>
  );
}

function StockRow({ r, onPress }: { r: any; onPress: () => void }) {
  const { pick, t } = useI18n();
  const unit = u(r.item?.unit);
  return (
    <Card onPress={onPress} style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="callout" style={{ fontWeight: '600' }} numberOfLines={2}>{pick(r.item, 'name')}</Text>
          <Text variant="caption" tone="secondary" numberOfLines={1}>{pick(r.warehouse, 'name')} · {r.location ?? '—'}{r.batch?.number ? ` · ${r.batch.number}` : ''}</Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text variant="headline" num>{num(r.qtyAvailable, 2)}</Text>
          <Text variant="caption" tone="secondary">{unit}</Text>
        </View>
      </View>
      {(r.isBelowCritical || r.isBelowMin) && (
        <View style={{ flexDirection: 'row', gap: 6 }}>
          {r.isBelowCritical ? <Badge label={t('whBelowCritical')} tone="danger" /> : <Badge label={t('whBelowMin')} tone="warning" />}
        </View>
      )}
    </Card>
  );
}

function MoveRow({ r }: { r: any }) {
  const { pick, t } = useI18n();
  const { colors } = useTheme();
  const incoming = ['receipt', 'surplus', 'return_from_client', 'return_from_production'].includes(r.operationType);
  const transfer = r.operationType === 'transfer';
  const icon = transfer ? 'repeat' : incoming ? 'arrow-down-left' : 'arrow-up-right';
  return (
    <Card style={{ flexDirection: 'row', gap: 12, alignItems: 'center', opacity: r.reversed ? 0.5 : 1 }}>
      <View style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: colors.muted, alignItems: 'center', justifyContent: 'center' }}>
        <Feather name={icon as any} size={18} color={transfer ? colors.text : incoming ? colors.success : colors.danger} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="callout" style={{ fontWeight: '600' }} numberOfLines={1}>{pick(r.item, 'name')}</Text>
        <Text variant="caption" tone="secondary" numberOfLines={1}>{MOVE_LABEL[r.operationType] ? t(MOVE_LABEL[r.operationType]) : r.operationType} · {dateTime(r.movedAt)}</Text>
      </View>
      <View style={{ alignItems: 'flex-end' }}>
        <Text variant="callout" num style={{ fontWeight: '700' }}>{num(r.qty, 3)}</Text>
        <Text variant="caption" tone="secondary">{u(r.item?.unit)}</Text>
      </View>
    </Card>
  );
}

const SHEET_STATUS: Record<string, [string, 'neutral' | 'info' | 'success' | 'warning' | 'danger']> = {
  draft: ['whStatusDraft', 'neutral'],
  counting: ['whStatusCounting', 'info'],
  review: ['whStatusReview', 'warning'],
  approved: ['whStatusApproved', 'success'],
  cancelled: ['whStatusCancelled', 'danger'],
};

function SheetRow({ r, onPress }: { r: any; onPress: () => void }) {
  const { t, pick } = useI18n();
  const [k, tone] = SHEET_STATUS[r.status] ?? ['whStatusDraft', 'neutral'];
  return (
    <Card onPress={onPress} style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text variant="headline">{r.number}</Text>
        <Badge label={t(k as any)} tone={tone} />
      </View>
      <Text variant="caption" tone="secondary">{pick(r.warehouse, 'name')}{r.zone ? ` · ${r.zone}` : ''}</Text>
      <View style={{ flexDirection: 'row', gap: 16 }}>
        <Text variant="caption" tone="secondary" num>{t('whCounted')}: {r.counted}/{r.lines}</Text>
        {r.diffLines > 0 && <Text variant="caption" tone="warning" num>{t('whDiff')}: {r.diffLines}</Text>}
      </View>
    </Card>
  );
}
