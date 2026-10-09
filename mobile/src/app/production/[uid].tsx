import React, { useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, Divider, KV, Screen, Section, Skeleton, ErrorState, Field, Segmented } from '@/ui/components';
import { Sheet } from '@/ui/Sheet';
import { PickerField } from '@/ui/Picker';
import { Text } from '@/ui/Text';
import { StageCard } from '@/components/production/StageCard';
import { PhotoStrip } from '@/components/Photos';
import { useApi } from '@/api/query';
import { useAction } from '@/api/action';
import { useAuth } from '@/auth/AuthProvider';
import { useI18n } from '@/i18n';
import { useTheme } from '@/theme/ThemeProvider';
import { dateShort, num, unit } from '@/lib/format';
import { ORDER_STATUS } from '@/lib/status';

export default function OrderDetail() {
  const { uid } = useLocalSearchParams<{ uid: string }>();
  const { t, pick } = useI18n();
  const { can } = useAuth();
  const { colors } = useTheme();
  const router = useRouter();
  const qc = useQueryClient();
  const q = useApi<any>(`/production/orders/${uid}`);
  const opts = useApi<any>('/production/options', undefined, { staleTime: 5 * 60_000 });
  const act = useAction();
  const [out, setOut] = useState(false);
  const [kind, setKind] = useState<'good' | 'defect' | 'waste'>('good');
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState<string | null>(null);
  const [status, setStatus] = useState(false);
  const [mat, setMat] = useState<any | null>(null);
  const [matQty, setMatQty] = useState('');

  const o = q.data;
  const manage = can('production.manage');
  const [sk, stone] = o ? ORDER_STATUS[o.status] ?? ['prStatusDraft', 'neutral'] : ['prStatusDraft', 'neutral'];
  const qtyOk = /^\d+([.,]\d{1,6})?$/.test(qty.trim()) && Number(qty.replace(',', '.')) > 0;
  const reasons = kind === 'defect' ? opts.data?.defectReasons : kind === 'waste' ? opts.data?.wasteReasons : [];

  const register = async () => {
    if (!qtyOk) return;
    const r = await act.run('POST', `/production/orders/${uid}/output`, { kind, qty: qty.trim().replace(',', '.'), reasonUid: reason ?? undefined }, { success: t('prDone2') });
    if (r) { setOut(false); setQty(''); setReason(null); }
  };
  const useMat = async () => {
    if (!/^\d+([.,]\d{1,6})?$/.test(matQty.trim())) return;
    const r = await act.run('POST', `/production/orders/${uid}/materials/use`, { itemCode: mat.itemCode, qty: matQty.trim().replace(',', '.') }, { success: t('prDone2') });
    if (r) { setMat(null); setMatQty(''); }
  };

  return (
    <Screen
      title={o?.number ?? '…'}
      subtitle={o ? pick(o, 'itemName') : undefined}
      back={() => router.back()}
      onRefresh={() => qc.invalidateQueries({ queryKey: ['api'] })}
      refreshing={q.isRefetching}
      padBottom={false}
      contentStyle={{ paddingBottom: 40 }}
    >
      {q.isLoading ? (
        <View style={{ padding: 20, gap: 12 }}><Skeleton h={120} r={16} /><Skeleton h={80} r={16} /></View>
      ) : q.error ? (
        <ErrorState message={q.error.message} onRetry={() => q.refetch()} />
      ) : o ? (
        <>
          <Section>
            <Card style={{ gap: 10 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Badge label={t(sk as any)} tone={stone as any} />
                <Text variant="caption" tone="secondary">{t('prDue')} {dateShort(o.dueDate)}</Text>
              </View>
              <View style={{ height: 8, borderRadius: 4, backgroundColor: colors.muted, overflow: 'hidden' }}>
                <View style={{ width: `${Math.min(100, Number(o.qtyPercent))}%`, height: 8, backgroundColor: colors.accent }} />
              </View>
              <KV k={t('prProgress')} v={`${num(o.qtyProduced, 2)} / ${num(o.qtyPlanned, 2)} ${unit(o.unit)}`} strong />
              <KV k={t('prDefect')} v={`${num(o.qtyDefect, 2)} ${unit(o.unit)}`} />
              <KV k={t('prWaste')} v={`${num(o.qtyWaste, 2)} ${unit(o.unit)}`} />
              <Divider />
              <KV k={t('prResponsible')} v={o.responsibleName ?? '—'} />
            </Card>
          </Section>

          {manage && (
            <Section>
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <Button style={{ flex: 1 }} title={t('prRegister')} icon="plus-circle" needsNetwork onPress={() => { act.reset(); setOut(true); }} />
                {o.nextStatuses?.length > 0 && <Button variant="secondary" title={t('prChangeStatus')} needsNetwork onPress={() => setStatus(true)} />}
              </View>
            </Section>
          )}

          <Section title={t('prStages')}>
            <View style={{ gap: 10 }}>
              {o.stages.map((s: any) => (
                <StageCard key={s.seq} s={{ ...s, marks: markFor(s) }} orderStatus={o.status} orderUid={o.uid} />
              ))}
            </View>
          </Section>

          {o.materials?.length > 0 && (
            <Section title={t('prMaterials')}>
              <Card padded={false}>
                {o.materials.map((m: any, i: number) => (
                  <View key={m.itemCode}>
                    {i > 0 && <View style={{ height: 1, backgroundColor: colors.border }} />}
                    <View style={{ padding: 14, gap: 4 }}>
                      <Text variant="callout" style={{ fontWeight: '600' }}>{pick(m, 'itemName')}</Text>
                      <Text variant="caption" tone="secondary" num>
                        {t('prPlan')} {num(m.qtyPlanned, 2)} · {t('prIssued')} {num(m.qtyIssued, 2)} · {t('prUsed')} {num(m.qtyUsed, 2)} {unit(m.unit)}
                      </Text>
                      {manage && <Button size="sm" variant="secondary" title={t('prUseMaterial')} needsNetwork style={{ alignSelf: 'flex-start', marginTop: 6 }} onPress={() => { act.reset(); setMat(m); }} />}
                    </View>
                  </View>
                ))}
              </Card>
            </Section>
          )}

          <Section title={t('prOutputs')}>
            <Card padded={false}>
              {o.outputs?.length ? o.outputs.map((x: any, i: number) => (
                <View key={i}>
                  {i > 0 && <View style={{ height: 1, backgroundColor: colors.border }} />}
                  <View style={{ padding: 14, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                    <View style={{ gap: 2 }}>
                      <Badge label={x.kind === 'good' ? t('prGood') : x.kind === 'defect' ? t('prDefect') : x.kind === 'waste' ? t('prWaste') : x.kind} tone={x.kind === 'good' ? 'success' : x.kind === 'defect' ? 'danger' : 'warning'} />
                      <Text variant="caption" tone="secondary">{dateShort(x.occurredAt)}</Text>
                    </View>
                    <Text variant="callout" num style={{ fontWeight: '700' }}>{num(x.qty, 3)} {unit(x.unit)}</Text>
                  </View>
                </View>
              )) : <Text tone="secondary" style={{ padding: 16 }}>{t('empty')}</Text>}
            </Card>
          </Section>

          <Section title={t('prPhotos')}>
            <PhotoStrip owner="production_order" uid={o.uid} canEdit={can('production.manage', 'production.work')} />
          </Section>

          <Sheet visible={out} onClose={() => setOut(false)} title={t('prRegister')}>
            <Segmented options={[{ value: 'good', label: t('prGood') }, { value: 'defect', label: t('prDefect') }, { value: 'waste', label: t('prWaste') }]} value={kind} onChange={(v) => { setKind(v); setReason(null); }} />
            <Field label={`${t('whQty')}, ${unit(o.unit)}`} value={qty} onChangeText={setQty} keyboardType="decimal-pad" autoFocus />
            {kind !== 'good' && (
              <PickerField label={t('prReason')} value={reason} options={(reasons ?? []).map((r: any) => ({ value: r.uid, label: pick(r, 'name') }))} onChange={setReason} />
            )}
            {!!act.error && <Text tone="danger" variant="callout">{act.error}</Text>}
            <Button title={t('confirm')} needsNetwork loading={act.busy} disabled={!qtyOk} onPress={register} />
          </Sheet>

          <Sheet visible={status} onClose={() => setStatus(false)} title={t('prChangeStatus')}>
            {(o.nextStatuses ?? []).map((s: string) => {
              const [k] = ORDER_STATUS[s] ?? ['prStatusDraft'];
              return (
                <Button key={s} variant="secondary" title={t(k as any)} needsNetwork loading={act.busy} onPress={async () => { const r = await act.run('POST', `/production/orders/${uid}/status`, { status: s }, { success: t('prDone2') }); if (r) setStatus(false); }} />
              );
            })}
          </Sheet>

          <Sheet visible={!!mat} onClose={() => setMat(null)} title={t('prUseMaterial')}>
            {mat && (
              <>
                <Text variant="headline">{pick(mat, 'itemName')}</Text>
                <Field label={`${t('whQty')}, ${unit(mat.unit)}`} value={matQty} onChangeText={setMatQty} keyboardType="decimal-pad" autoFocus />
                {!!act.error && <Text tone="danger" variant="callout">{act.error}</Text>}
                <Button title={t('confirm')} needsNetwork loading={act.busy} onPress={useMat} />
              </>
            )}
          </Sheet>
        </>
      ) : null}
    </Screen>
  );
}

/** В карточке заказа у этапа нет готового списка допустимых отметок — выводим по статусу. */
function markFor(s: any): string[] {
  if (s.marks) return s.marks;
  if (s.status === 'pending') return ['start'];
  if (s.status === 'running') return ['pause', 'finish'];
  if (s.status === 'paused') return ['resume'];
  return [];
}
