import React, { useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, Divider, ErrorState, Field, KV, Screen, Section, Skeleton } from '@/ui/components';
import { Sheet } from '@/ui/Sheet';
import { PickerField } from '@/ui/Picker';
import { Text } from '@/ui/Text';
import { useApi } from '@/api/query';
import { useAction } from '@/api/action';
import { useAuth } from '@/auth/AuthProvider';
import { useI18n } from '@/i18n';
import { useTheme } from '@/theme/ThemeProvider';
import { dateShort, money, num, unit } from '@/lib/format';
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
    const r = await act.run('POST', `/sales/orders/${uid}/shipments`, { vehicle: vehicle || undefined, driver: driver || undefined, lines }, { success: t('slShipped') });
    if (r) setShipOpen(false);
  };
  const doPay = async () => {
    const acc = (finRefs.data?.accounts ?? []).find((a: any) => a.code === payAcc);
    const recv = (finRefs.data?.accounts ?? []).find((a: any) => a.kind === 'receivable' && a.currency === 'UZS');
    if (!acc || !recv) return;
    const body = { companyUid: o.enterpriseUid, operationType: 'income', accountCode: acc.code, counterAccountCode: recv.code, amount: payAmount.trim().replace(',', '.'), currencyCode: 'UZS', salesOrderUid: o.uid, comment: `Оплата по заказу ${o.number}` };
    const r = await act.run('POST', '/finance/operations', body, { success: t('slPaid2') });
    if (r) setPayOpen(false);
  };

  return (
    <Screen title={o?.number ?? '…'} subtitle={o ? pick(o.partner, 'name') : undefined} back={() => router.back()} onRefresh={() => qc.invalidateQueries({ queryKey: ['api'] })} refreshing={q.isRefetching} padBottom={false} contentStyle={{ paddingBottom: 40 }}>
      {q.isLoading ? (
        <View style={{ padding: 20, gap: 12 }}><Skeleton h={170} r={16} /><Skeleton h={100} r={16} /></View>
      ) : q.error ? (
        <ErrorState message={q.error.message} onRetry={() => q.refetch()} />
      ) : o ? (
        <>
          <Section>
            <Card style={{ gap: 8 }}>
              <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                <Badge label={t(`slS${o.status}` as any)} tone={SALES_STATUS_TONE[o.status] ?? 'neutral'} />
                <Badge label={t(`slP${o.paymentStatus}` as any)} tone={PAY_TONE[o.paymentStatus] ?? 'neutral'} />
              </View>
              <Text variant="largeTitle" num>{money(o.amountTotal, o.currency)}</Text>
              <View style={{ height: 6, borderRadius: 3, backgroundColor: colors.muted, overflow: 'hidden' }}>
                <View style={{ width: `${Math.min(100, (Number(o.paidAmount) / Math.max(1, Number(o.amountTotal))) * 100)}%`, height: 6, backgroundColor: colors.success }} />
              </View>
              <KV k={t('slPaid')} v={money(o.paidAmount, o.currency)} />
              <Divider />
              <KV k={t('slDelivery')} v={dateShort(o.deliveryDate)} />
              <KV k={t('slWarehouse')} v={pick(o, 'warehouseName')} />
              <KV k={t('slManager')} v={o.managerName ?? '—'} />
              <KV k={t('slDebtLimit')} v={money(o.partner?.debtLimit)} />
            </Card>
          </Section>

          {edit && (
            <Section>
              <View style={{ gap: 10 }}>
                {canShip && <Button title={t('slShip')} icon="truck" needsNetwork onPress={() => { act.reset(); setShipOpen(true); }} />}
                {can('finance.post') && rest > 0 && o.status !== 'cancelled' && <Button title={t('slReceivePay')} icon="dollar-sign" variant="secondary" needsNetwork onPress={() => { act.reset(); setPayAmount(String(Math.round(rest))); setPayOpen(true); }} />}
                {nexts.length > 0 && <Button title={t('slChangeStatus')} icon="chevrons-right" variant="secondary" needsNetwork onPress={() => { act.reset(); setStatusOpen(true); }} />}
              </View>
            </Section>
          )}

          <Section title={t('dcLines')}>
            <Card padded={false}>
              {o.lines.map((l: any, i: number) => {
                const a = (av.data?.lines ?? []).find((x: any) => x.lineUid === l.uid);
                const short = a && Number(a.shortage) > 0;
                return (
                  <View key={l.uid}>
                    {i > 0 && <View style={{ height: 1, backgroundColor: colors.border }} />}
                    <View style={{ padding: 14, gap: 4 }}>
                      <Text variant="callout" style={{ fontWeight: '600' }} numberOfLines={2}>{pick(l, 'itemName')}</Text>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                        <Text variant="caption" tone="secondary" num>{num(l.qty, 3)} {unit(l.unit)} × {money(l.price)}</Text>
                        <Text variant="callout" num style={{ fontWeight: '700' }}>{money(l.amountTotal)}</Text>
                      </View>
                      {a && (
                        <Text variant="caption" tone={short ? 'danger' : 'secondary'} num>
                          {t('slAvailable')}: {num(a.availableQty, 3)}{short ? ` · ${t('slShortage')}: ${num(a.shortage, 3)}` : ''} · {t('slRemaining')}: {num(a.remainingQty, 3)}
                        </Text>
                      )}
                    </View>
                  </View>
                );
              })}
            </Card>
          </Section>

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
