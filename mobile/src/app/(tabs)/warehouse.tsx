import React, { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Feather } from '@/ui/Icon';
import { useQueryClient } from '@tanstack/react-query';
import { ListScreen } from '@/ui/ListScreen';
import { Badge, Button, Card, KV, Divider, Field, IconButton, Tabs, SearchBar, Appear } from '@/ui/components';
import { Sheet } from '@/ui/Sheet';
import { PipeLevel, StatusTrack } from '@/ui/Instrument';
import { routeOf } from '@/lib/status';
import { Text } from '@/ui/Text';
import { Pressable } from '@/ui/Pressable';
import { MoveSheet, MoveInit, MOVE_LABEL } from '@/components/warehouse/MoveSheet';
import { NewInventorySheet } from '@/components/warehouse/NewInventorySheet';
import { useAction } from '@/api/action';
import { useApi } from '@/api/query';
import { useAuth } from '@/auth/AuthProvider';
import { useI18n } from '@/i18n';
import { useTheme } from '@/theme/ThemeProvider';
import { dateTime, itemTitle, money, num, unit as u, moneyParts } from '@/lib/format';
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
  const [newSheet, setNewSheet] = useState(false);
  const [moveDetail, setMoveDetail] = useState<any | null>(null);
  const [revNote, setRevNote] = useState('');
  const rev = useAction();
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
      {tab === 'inventory' && can('warehouse.inventory') && (
        <View style={{ paddingHorizontal: 20, marginBottom: 16 }}>
          <Button title={t('whNewSheet')} icon="plus" variant="secondary" needsNetwork onPress={() => setNewSheet(true)} />
        </View>
      )}
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
            <MoveRow r={r} onPress={() => { rev.reset(); setRevNote(''); setMoveDetail(r); }} />
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
      <NewInventorySheet visible={newSheet} onClose={() => setNewSheet(false)} />

      <Sheet visible={!!moveDetail} onClose={() => setMoveDetail(null)} title={moveDetail ? t(MOVE_LABEL[moveDetail.operationType] ?? 'whMove') : ''}>
        {moveDetail && (
          <>
            <Text variant="headline">{pick(moveDetail.item, 'name')}</Text>
            <Card>
              <KV k={t('whQty')} v={`${num(moveDetail.qty, 3)} ${u(moveDetail.item?.unit)}`} strong />
              {!!moveDetail.batch?.number && <KV k={t('whBatch')} v={moveDetail.batch.number} />}
              {!!moveDetail.fromWarehouse && <KV k={t('whFrom')} v={`${pick(moveDetail.fromWarehouse, 'name')}${moveDetail.fromLocation ? ` · ${moveDetail.fromLocation}` : ''}`} />}
              {!!moveDetail.toWarehouse && <KV k={t('whTo')} v={`${pick(moveDetail.toWarehouse, 'name')}${moveDetail.toLocation ? ` · ${moveDetail.toLocation}` : ''}`} />}
              <Divider />
              <KV k={t('whAuthor')} v={moveDetail.author ?? '—'} />
              <KV k={t('date')} v={dateTime(moveDetail.movedAt)} />
              {!!moveDetail.docNumber && <KV k={t('whDoc')} v={moveDetail.docNumber} />}
              {!!moveDetail.comment && <Text variant="callout" tone="secondary" style={{ marginTop: 6 }}>{moveDetail.comment}</Text>}
            </Card>
            {moveDetail.reversed && <Badge label={t('whReversed')} tone="neutral" />}
            {moveDetail.canReverse && canMove && !moveDetail.reversed && (
              <>
                <Field label={`${t('whComment')} (${t('whOptional')})`} value={revNote} onChangeText={setRevNote} multiline style={{ height: 70 }} />
                {!!rev.error && <Text variant="callout" tone="danger">{rev.error}</Text>}
                <Button
                  title={t('whReverseConfirm')}
                  icon="corner-up-left"
                  variant="danger"
                  needsNetwork
                  loading={rev.busy}
                  onPress={async () => {
                    const r = await rev.run('POST', `/warehouse/moves/${moveDetail.uid}/reverse`, { comment: revNote.trim() || undefined }, { success: t('whReversed') });
                    if (r) setMoveDetail(null);
                  }}
                />
              </>
            )}
          </>
        )}
      </Sheet>
    </>
  );
}

/**
 * Строка остатка: сечение трубы, стенка которого заполнена по уровню запаса
 * относительно минимума (красное и мигает — ниже критического), размер
 * крупно, марка и место мелко, количество справа. Без плашек и длинных имён.
 */
function StockRow({ r, onPress }: { r: any; onPress: () => void }) {
  const { pick } = useI18n();
  const it = itemTitle(pick(r.item, 'name'));
  const d = Number(r.item?.diameterMm);
  const head = d > 0 && r.item?.wallThicknessMm ? `Ø${d}×${num(r.item.wallThicknessMm, 1)}` : it.head;
  const min = Number(r.minQty);
  const level = min > 0 ? Number(r.levelAvailable) / (min * 2) : 1;
  const tone = r.isBelowCritical ? 'critical' : r.isBelowMin ? 'low' : 'ok';
  const wall = d > 0 ? 0.14 + Math.min(0.12, (Number(r.item.wallThicknessMm) / d) * 3) : 0.2;
  const name = pick(r.item, 'name') ?? '';
  const iso = name.match(/ППУ[-‑]?[А-ЯA-Z]+/)?.[0];
  const sub = [iso, it.pipe || d > 0 ? r.item?.steelGrade : null, r.location, r.batch?.number].filter(Boolean).join(' · ');
  return (
    <Card onPress={onPress} style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 12 }}>
      <PipeLevel level={level} tone={tone} size={40} wall={wall} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="headline" num numberOfLines={1} style={{ fontSize: it.pipe || d > 0 ? 17 : 15 }}>{head}</Text>
        <Text variant="caption" tone="muted" numberOfLines={1}>{sub}</Text>
      </View>
      <View style={{ alignItems: 'flex-end' }}>
        <Text num style={{ fontSize: 19, fontWeight: '700', letterSpacing: -0.5 }}>{num(r.qtyAvailable, 2)}</Text>
        <Text variant="caption" tone="secondary">{u(r.item?.unit)}</Text>
      </View>
    </Card>
  );
}

function MoveRow({ r, onPress }: { r: any; onPress: () => void }) {
  const { pick, t } = useI18n();
  const { colors } = useTheme();
  const incoming = ['receipt', 'surplus', 'return_from_client', 'return_from_production'].includes(r.operationType);
  const transfer = r.operationType === 'transfer';
  const icon = transfer ? 'repeat' : incoming ? 'arrow-down-left' : 'arrow-up-right';
  return (
    <Card onPress={onPress} style={{ flexDirection: 'row', gap: 12, alignItems: 'center', opacity: r.reversed ? 0.5 : 1 }}>
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
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <Text variant="headline">{r.number}</Text>
        <StatusTrack route={routeOf('inventory', r.status)} label={t(k as any)} align="right" />
      </View>
      <Text variant="caption" tone="secondary">{pick(r.warehouse, 'name')}{r.zone ? ` · ${r.zone}` : ''}</Text>
      <View style={{ flexDirection: 'row', gap: 16 }}>
        <Text variant="caption" tone="secondary" num>{t('whCounted')}: {r.counted}/{r.lines}</Text>
        {r.diffLines > 0 && <Text variant="caption" tone="warning" num>{t('whDiff')}: {r.diffLines}</Text>}
      </View>
    </Card>
  );
}
