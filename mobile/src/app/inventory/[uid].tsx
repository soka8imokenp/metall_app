import React, { useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { ListScreen } from '@/ui/ListScreen';
import { Badge, Button, Card, Field } from '@/ui/components';
import { Sheet } from '@/ui/Sheet';
import { Text } from '@/ui/Text';
import { useApi } from '@/api/query';
import { useAction } from '@/api/action';
import { useAuth } from '@/auth/AuthProvider';
import { useI18n } from '@/i18n';
import { num } from '@/lib/format';

export default function InventorySheet() {
  const { uid } = useLocalSearchParams<{ uid: string }>();
  const { t, pick } = useI18n();
  const { can } = useAuth();
  const router = useRouter();
  const qc = useQueryClient();
  const q = useApi<any>(`/warehouse/inventory/${uid}`);
  const act = useAction();
  const [line, setLine] = useState<any | null>(null);
  const [val, setVal] = useState('');

  const d = q.data;
  const editable = d && ['counting', 'draft'].includes(d.status) && can('warehouse.inventory');

  const save = async () => {
    const qty = val.trim().replace(',', '.');
    if (!/^\d+(\.\d{1,6})?$/.test(qty)) return;
    const r = await act.run('POST', `/warehouse/inventory/lines/${line.uid}/count`, { qty }, { success: t('whDone') });
    if (r) setLine(null);
  };

  return (
    <>
      <ListScreen<any>
        title={d?.number ?? '…'}
        subtitle={d ? `${pick(d.warehouse, 'name')} · ${d.counted}/${d.lines}` : undefined}
        back={() => router.back()}
        padBottom={false}
        data={d?.rows}
        keyExtractor={(r) => r.uid}
        loading={q.isLoading}
        error={q.error?.message}
        onRetry={() => q.refetch()}
        onRefresh={() => qc.invalidateQueries({ queryKey: ['api'] })}
        refreshing={q.isRefetching}
        emptyTitle={t('empty')}
        header={
          d && editable ? (
            <View style={{ paddingHorizontal: 20, marginBottom: 12 }}>
              <Button title={t('whFinish')} variant="secondary" icon="check-square" needsNetwork onPress={() => act.run('POST', `/warehouse/inventory/${uid}/finish`, undefined, { success: t('whDone') })} loading={act.busy} />
            </View>
          ) : d && d.status === 'review' && can('warehouse.inventory.approve') ? (
            <View style={{ paddingHorizontal: 20, marginBottom: 12 }}>
              <Button title={t('whApprove')} icon="check" needsNetwork onPress={() => act.run('POST', `/warehouse/inventory/${uid}/approve`, undefined, { success: t('whDone') })} loading={act.busy} />
            </View>
          ) : null
        }
        renderItem={(r) => {
          const diff = Number(r.qtyDiff);
          return (
            <Card onPress={editable ? () => { setLine(r); setVal(r.qtyCounted ?? ''); act.reset(); } : undefined} style={{ gap: 6 }}>
              <Text variant="callout" style={{ fontWeight: '600' }} numberOfLines={2}>{pick(r.item, 'name')}</Text>
              <Text variant="caption" tone="secondary">{r.location ?? '—'}{r.batch ? ` · ${r.batch}` : ''}</Text>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text variant="caption" tone="secondary" num>{t('whExpected')}: {num(r.qtyExpected, 3)}</Text>
                {r.qtyCounted === null || r.qtyCounted === undefined ? (
                  <Badge label="—" />
                ) : (
                  <Badge label={diff === 0 ? `${num(r.qtyCounted, 3)}` : `${num(r.qtyCounted, 3)} (${diff > 0 ? '+' : ''}${num(diff, 3)})`} tone={diff === 0 ? 'success' : 'warning'} />
                )}
              </View>
            </Card>
          );
        }}
      />
      <Sheet visible={!!line} onClose={() => setLine(null)} title={t('whCountSave')}>
        {line && (
          <>
            <Text variant="headline">{pick(line.item, 'name')}</Text>
            <Text tone="secondary" num>{t('whExpected')}: {num(line.qtyExpected, 3)}</Text>
            <Field label={t('whCounted')} value={val} onChangeText={setVal} keyboardType="decimal-pad" autoFocus />
            {!!act.error && <Text tone="danger" variant="callout">{act.error}</Text>}
            <Button title={t('whCountSave')} onPress={save} loading={act.busy} needsNetwork />
          </>
        )}
      </Sheet>
    </>
  );
}
