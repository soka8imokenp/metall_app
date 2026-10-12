import React, { useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, ErrorState, Field, Screen, Section, Skeleton } from '@/ui/components';
import { ActionDock, DOCK_SPACE, DockKey, DockMain, GaugeBar, Readout, SpecPlate, StatusLamp } from '@/ui/Instrument';
import { Appear } from '@/ui/motion';
import { Sheet } from '@/ui/Sheet';
import { PickerField } from '@/ui/Picker';
import { Text } from '@/ui/Text';
import { Pressable } from '@/ui/Pressable';
import { useApi } from '@/api/query';
import { useAction } from '@/api/action';
import { useAuth } from '@/auth/AuthProvider';
import { useI18n } from '@/i18n';
import { useTheme } from '@/theme/ThemeProvider';
import { dateShort, itemTitle, money, moneyParts, num, unit } from '@/lib/format';
import { NEXT_SALES, PAY_TONE, SALES_STATUS_TONE } from '@/lib/status';

export default function OrderDetail() {
  const { uid } = useLocalSearchParams<{ uid: string }>();
  const { t, pick } = useI18n();
  const { can } = useAuth();
  const { colors } = useTheme();
  const router = useRouter();
  const qc = useQueryClient();
  const q = useApi<any>(`/sales/orders/${uid}`);
  const av = useApi<any>(`/sales/orders/${uid}/availability`);
  // Резервы склада по этому заказу: сервер фильтрует по товару, номер заказа сверяем здесь.
  const resv = useApi<{ rows: any[] }>('/warehouse/reservations', { limit: 200 });
  const [rsLine, setRsLine] = useState<any | null>(null);
  const [rsBatch, setRsBatch] = useState<string | null>(null);
  const [rsQty, setRsQty] = useState('');
  const finRefs = useApi<any>('/finance/refs', undefined, { staleTime: 5 * 60_000, enabled: can('finance.post') });
  const act = useAction();
  const [statusOpen, setStatusOpen] = useState(false);
  const [shipOpen, setShipOpen] = useState(false);
  const [vehicle, setVehicle] = useState('');
  const [driver, setDriver] = useState('');
  const [payOpen, setPayOpen] = useState(false);
  const [payAmount, setPayAmount] = useState('');
  const [payAcc, setPayAcc] = useState<string | null>(null);

  const o = q.data;
  const edit = can('sales.edit');
  const rest = o ? Number(o.amountTotal) - Number(o.paidAmount) : 0;
  const nexts = o ? NEXT_SALES[o.status] ?? [] : [];
  const canShip = !!av.data?.canShip && ['confirmed', 'reserved', 'picking', 'in_production'].includes(o?.status) && edit;

  const doStatus = async (s: string) => {
    const r = await act.run('POST', `/sales/orders/${uid}/status`, { status: s }, { success: t('slStatusChanged') });
    if (r) setStatusOpen(false);
  };
  const doShip = async () => {
    const lines = (av.data?.lines ?? []).filter((l: any) => Number(l.remainingQty) > 0 && Number(l.availableQty) > 0).map((l: any) => ({
      lineUid: l.lineUid,
      qty: String(Math.min(Number(l.remainingQty), Number(l.availableQty))),
    }));
    const r = await act.run('POST', `/sales/orders/${uid}/shipments`, { vehicle: vehicle || undefined, driver: driver || undefined, lines }, { success: t('slShipped'), burst: true });
    if (r) setShipOpen(false);
  };
  const doPay = async () => {
    const acc = (finRefs.data?.accounts ?? []).find((a: any) => a.code === payAcc);
    const recv = (finRefs.data?.accounts ?? []).find((a: any) => a.kind === 'receivable' && a.currency === 'UZS');
    if (!acc || !recv) return;
    const body = { companyUid: o.enterpriseUid, operationType: 'income', accountCode: acc.code, counterAccountCode: recv.code, amount: payAmount.trim().replace(',', '.'), currencyCode: 'UZS', salesOrderUid: o.uid, comment: `Оплата по заказу ${o.number}` };
    const r = await act.run('POST', '/finance/operations', body, { success: t('slPaid2'), burst: true });
    if (r) setPayOpen(false);
  };

  const canPay = can('finance.post') && rest > 0 && o?.status !== 'cancelled';
  const openPay = () => { act.reset(); setPayAmount(String(Math.round(rest))); setPayOpen(true); };
  const dock = o && edit && (canShip || canPay || nexts.length > 0) ? (
    <ActionDock>
      {nexts.length > 0 && <DockKey icon="chevrons-right" label={t('slStatusShort')} onPress={() => { act.reset(); setStatusOpen(true); }} />}
      {canShip && canPay && <DockKey icon="dollar-sign" label={t('slPayShort')} onPress={openPay} />}
      {canShip ? (
        <DockMain icon="truck" label={t('slShip')} onPress={() => { act.reset(); setShipOpen(true); }} />
      ) : canPay ? (
        <DockMain icon="dollar-sign" label={t('slReceivePay')} onPress={openPay} />
      ) : <View style={{ flex: 1 }} />}
    </ActionDock>
  ) : null;
  const paid = o ? Math.min(1, Number(o.paidAmount) / Math.max(1, Number(o.amountTotal))) : 0;

  return (
    <Screen
      title={o?.number ?? '…'}
      subtitle={o ? pick(o.partner, 'name') : undefined}
      back={() => router.back()}
      onRefresh={() => qc.invalidateQueries({ queryKey: ['api'] })}
      refreshing={q.isRefetching}
      padBottom={false}
      contentStyle={{ paddingBottom: dock ? DOCK_SPACE : 40 }}
      footer={dock}
    >
      {q.isLoading ? (
        <View style={{ padding: 20, gap: 12 }}><Skeleton h={170} r={16} /><Skeleton h={100} r={16} /></View>
      ) : q.error ? (
        <ErrorState message={q.error.message} onRetry={() => q.refetch()} />
      ) : o ? (
        <>
          <View style={{ paddingHorizontal: 22, marginBottom: 24, gap: 12 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
              <StatusLamp tone={SALES_STATUS_TONE[o.status] ?? 'neutral'} label={t(`slS${o.status}` as any)} />
              <StatusLamp tone={PAY_TONE[o.paymentStatus] ?? 'neutral'} label={t(`slP${o.paymentStatus}` as any)} pulse={o.paymentStatus === 'overdue'} />
            </View>
            <Readout value={moneyParts(o.amountTotal)[0]} unit={moneyParts(o.amountTotal)[1]} />
            <GaugeBar value={paid} color={colors.success} left={`${t('slPaid')} ${money(o.paidAmount, o.currency)}`} right={rest > 0 ? `${t('slLeft')} ${money(rest, o.currency)}` : ''} />
          </View>

          <Appear i={1}>
            <Section>
              <SpecPlate
                items={[
                  { label: t('slDelivery'), value: dateShort(o.deliveryDate) },
                  { label: t('slDebtLimit'), value: money(o.partner?.debtLimit) },
                  { label: t('slWarehouse'), value: pick(o, 'warehouseName') || '—' },
                  { label: t('slManager'), value: o.managerName ?? '—' },
                ]}
              />
            </Section>
          </Appear>

          <Section title={t('dcLines')}>
            <Card padded={false}>
              {o.lines.map((l: any, i: number) => {
                const a = (av.data?.lines ?? []).find((x: any) => x.lineUid === l.uid);
                const short = a && Number(a.shortage) > 0;
                return (
                  <View key={l.uid}>
                    {i > 0 && <View style={{ height: 1, backgroundColor: colors.border }} />}
                    <View style={{ padding: 14, gap: 4 }}>
                      {(() => {
                        const it = itemTitle(pick(l, 'itemName'));
                        return it.pipe ? (
                          <View>
                            <Text variant="headline" num>{it.head}</Text>
                            {!!it.sub && <Text variant="caption" tone="muted" numberOfLines={1}>{it.sub}</Text>}
                          </View>
                        ) : <Text variant="callout" style={{ fontWeight: '600' }} numberOfLines={2}>{pick(l, 'itemName')}</Text>;
                      })()}
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                        <Text variant="caption" tone="secondary" num>{num(l.qty, 3)} {unit(l.unit)} × {money(l.price)}</Text>
                        <Text variant="callout" num style={{ fontWeight: '700' }}>{money(l.amountTotal)}</Text>
                      </View>
                      {a && (
                        <Text variant="caption" tone={short ? 'danger' : 'secondary'} num>
                          {t('slAvailable')}: {num(a.availableQty, 3)}{short ? ` · ${t('slShortage')}: ${num(a.shortage, 3)}` : ''} · {t('slRemaining')}: {num(a.remainingQty, 3)}
                        </Text>
                      )}
                      {/* резервы этой позиции и кнопка «Резерв» */}
                      {(resv.data?.rows ?? []).filter((r) => r.orderNumber === o.number && r.item?.code === l.itemCode).map((r) => (
                        <View key={r.uid} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 }}>
                          <Badge label={`${t('slReserved')} ${num(r.qty, 3)} ${unit(l.unit)}${r.batch ? ` · ${r.batch}` : ''}`} tone="info" />
                          {edit && (
                            <Pressable onPress={() => act.run('DELETE', `/warehouse/reservations/${r.uid}`, undefined, { success: t('slReleased') })} haptic>
                              <Text variant="caption" tone="danger" style={{ fontWeight: '700' }}>{t('slRelease')}</Text>
                            </Pressable>
                          )}
                        </View>
                      ))}
                      {edit && a && Number(a.remainingQty) > 0 && !['shipped', 'closed', 'cancelled'].includes(o.status) && (
                        <Button
                          size="sm"
                          variant="secondary"
                          icon="package"
                          title={t('slReserve')}
                          style={{ alignSelf: 'flex-start', marginTop: 6 }}
                          needsNetwork
                          onPress={() => { act.reset(); setRsLine({ ...a, unit: l.unit, itemCode: l.itemCode, name: pick(l, 'itemName') }); setRsBatch(null); setRsQty(String(Number(a.remainingQty))); }}
                        />
                      )}
                    </View>
                  </View>
                );
              })}
            </Card>
          </Section>

          <Sheet visible={!!rsLine} onClose={() => setRsLine(null)} title={t('slReserveBatch')}>
            {rsLine && (
              <>
                <Text variant="headline">{rsLine.name}</Text>
                {(rsLine.batches ?? []).length === 0 ? (
                  <Text tone="secondary">{t('slNoBatches')}</Text>
                ) : (
                  <PickerField
                    label={t('whBatch')}
                    value={rsBatch}
                    options={(rsLine.batches ?? []).map((b: any) => ({ value: b.number, label: b.number, hint: `${t('slAvailable')}: ${num(b.availableQty, 3)} ${unit(rsLine.unit)}` }))}
                    onChange={setRsBatch}
                  />
                )}
                <Field label={`${t('whQty')}, ${unit(rsLine.unit)}`} value={rsQty} onChangeText={setRsQty} keyboardType="decimal-pad" />
                {!!act.error && <Text tone="danger" variant="callout">{act.error}</Text>}
                <Button
                  title={t('confirm')}
                  needsNetwork
                  loading={act.busy}
                  disabled={!rsBatch || !/^\d+([.,]\d{1,6})?$/.test(rsQty.trim())}
                  onPress={async () => {
                    const r = await act.run('POST', '/warehouse/reservations', {
                      companyUid: o.enterpriseUid,
                      itemCode: rsLine.itemCode,
                      batchNumber: rsBatch,
                      warehouseCode: rsLine.warehouseCode,
                      qty: rsQty.trim().replace(',', '.'),
                      salesOrderNumber: o.number,
                    }, { success: t('slReserveDone') });
                    if (r) setRsLine(null);
                  }}
                />
              </>
            )}
          </Sheet>

          <Sheet visible={statusOpen} onClose={() => setStatusOpen(false)} title={t('slNextStatus')}>
            {nexts.map((s) => (
              <Button key={s} title={t(`slS${s}` as any)} variant={s === 'cancelled' ? 'danger' : 'secondary'} needsNetwork loading={act.busy} onPress={() => doStatus(s)} />
            ))}
            {!!act.error && <Text tone="danger" variant="callout">{act.error}</Text>}
          </Sheet>

          <Sheet visible={shipOpen} onClose={() => setShipOpen(false)} title={t('slShip')}>
            <Field label={t('slVehicle')} value={vehicle} onChangeText={setVehicle} autoCapitalize="characters" />
            <Field label={t('slDriver')} value={driver} onChangeText={setDriver} />
            {!!act.error && <Text tone="danger" variant="callout">{act.error}</Text>}
            <Button title={t('slShip')} needsNetwork loading={act.busy} onPress={doShip} />
          </Sheet>

          <Sheet visible={payOpen} onClose={() => setPayOpen(false)} title={t('slReceivePay')}>
            <Field label={`${t('fnAmount')}, UZS`} value={payAmount} onChangeText={setPayAmount} keyboardType="decimal-pad" />
            <PickerField label={t('slPayAccount')} value={payAcc} options={(finRefs.data?.accounts ?? []).filter((a: any) => ['cash', 'bank'].includes(a.kind) && a.currency === 'UZS').map((a: any) => ({ value: a.code, label: `${a.code} · ${pick(a, 'name')}` }))} onChange={setPayAcc} />
            {!!act.error && <Text tone="danger" variant="callout">{act.error}</Text>}
            <Button title={t('confirm')} needsNetwork loading={act.busy} disabled={!payAcc || !payAmount} onPress={doPay} />
          </Sheet>
        </>
      ) : null}
    </Screen>
  );
}
