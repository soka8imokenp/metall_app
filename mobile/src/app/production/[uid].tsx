import React, { useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, Screen, Section, Skeleton, ErrorState, Field, Segmented } from '@/ui/components';
import { ActionDock, DOCK_SPACE, DockKey, DockMain, GaugeBar, Readout, SpecPlate, StatusTrack } from '@/ui/Instrument';
import { Appear } from '@/ui/motion';
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
import { dateShort, itemTitle, num, unit } from '@/lib/format';
import { ORDER_STATUS, routeOf } from '@/lib/status';

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
  const [note, setNote] = useState('');

  const o = q.data;
  const manage = can('production.manage');
  const [sk, stone] = o ? ORDER_STATUS[o.status] ?? ['prStatusDraft', 'neutral'] : ['prStatusDraft', 'neutral'];
  const qtyOk = /^\d+([.,]\d{1,6})?$/.test(qty.trim()) && Number(qty.replace(',', '.')) > 0;
  const reasons = kind === 'defect' ? opts.data?.defectReasons : kind === 'waste' ? opts.data?.wasteReasons : [];

  const register = async () => {
    if (!qtyOk) return;
    const r = await act.run('POST', `/production/orders/${uid}/output`, { kind, qty: qty.trim().replace(',', '.'), reasonUid: reason ?? undefined, comment: note.trim() || undefined }, { success: t('prOutputDone'), burst: true });
    if (r) { setOut(false); setQty(''); setReason(null); setNote(''); }
  };
  const useMat = async () => {
    if (!/^\d+([.,]\d{1,6})?$/.test(matQty.trim())) return;
    const r = await act.run('POST', `/production/orders/${uid}/materials/use`, { itemCode: mat.itemCode, qty: matQty.trim().replace(',', '.'), comment: note.trim() || undefined }, { success: t('prDone2') });
    if (r) { setMat(null); setMatQty(''); setNote(''); }
  };

  const dock = o && manage ? (
    <ActionDock>
      {o.nextStatuses?.length > 0 && <DockKey icon="chevrons-right" label={t('prStatusShort')} onPress={() => setStatus(true)} />}
      <DockMain icon="plus-circle" label={t('prRegister')} onPress={() => { act.reset(); setOut(true); }} />
    </ActionDock>
  ) : null;
  const it = o ? itemTitle(pick(o, 'itemName')) : null;
  const pct = o ? Math.min(1, Number(o.qtyPercent) / 100) : 0;

  return (
    <Screen
      title={o ? (it?.pipe ? `${o.number} · ${it.head}` : o.number) : '…'}
      subtitle={o ? (it?.pipe ? it.sub : pick(o, 'itemName')) : undefined}
      back={() => router.back()}
      onRefresh={() => qc.invalidateQueries({ queryKey: ['api'] })}
      refreshing={q.isRefetching}
      padBottom={false}
      contentStyle={{ paddingBottom: dock ? DOCK_SPACE : 40 }}
      footer={dock}
    >
      {q.isLoading ? (
        <View style={{ padding: 20, gap: 12 }}><Skeleton h={120} r={16} /><Skeleton h={80} r={16} /></View>
      ) : q.error ? (
        <ErrorState message={q.error.message} onRetry={() => q.refetch()} />
      ) : o ? (
        <>
          <View style={{ paddingHorizontal: 22, marginBottom: 24, gap: 12 }}>
            <StatusTrack size="lg" route={routeOf('order', o.status)} label={t(sk as any)} />
            <Text variant="caption" tone="muted" num style={{ fontWeight: '600', marginTop: 6 }}>{t('prDue')} {dateShort(o.dueDate)}</Text>
            <Readout value={num(o.qtyProduced, 2)} unit={`/ ${num(o.qtyPlanned, 2)} ${unit(o.unit)}`} />
            <GaugeBar value={pct} left={`${Math.round(pct * 100)}%`} right={`${t('prPlan')} ${num(o.qtyPlanned, 2)} ${unit(o.unit)}`} />
          </View>

          <Appear i={1}>
            <Section>
              <SpecPlate
                items={[
                  { label: t('prDefect'), value: `${num(o.qtyDefect, 2)} ${unit(o.unit)}` },
                  { label: t('prWaste'), value: `${num(o.qtyWaste, 2)} ${unit(o.unit)}` },
                  { label: t('prResponsible'), value: o.responsibleName ?? '—', wide: true },
                ]}
              />
            </Section>
          </Appear>

          <Section title={t('prStages')}>
            <View>
              {o.stages.map((s: any, i: number) => (
                <StageCard key={s.seq} s={{ ...s, marks: markFor(s) }} orderStatus={o.status} orderUid={o.uid} rail={{ first: i === 0, last: i === o.stages.length - 1 }} />
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
                      <Text variant="caption" tone="secondary">{dateShort(x.occurredAt)}{x.reasonNameRu ? ` · ${pick(x, 'reasonName')}` : ''}</Text>
                      {!!x.comment && <Text variant="caption" tone="muted" numberOfLines={2}>{x.comment}</Text>}
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
            <Field label={`${t('whComment')} (${t('whOptional')})`} value={note} onChangeText={setNote} multiline style={{ height: 80 }} />
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
                <Field label={`${t('whComment')} (${t('whOptional')})`} value={note} onChangeText={setNote} multiline style={{ height: 80 }} />
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
