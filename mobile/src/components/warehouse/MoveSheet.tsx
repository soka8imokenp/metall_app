import React, { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { Sheet } from '@/ui/Sheet';
import { PickerField, Option } from '@/ui/Picker';
import { Button, Field, Segmented } from '@/ui/components';
import { Text } from '@/ui/Text';
import { useApi } from '@/api/query';
import { useAction } from '@/api/action';
import { useAuth } from '@/auth/AuthProvider';
import { useI18n } from '@/i18n';
import type { Dict } from '@/i18n/ru';

export type MoveKind = 'receipt' | 'write_off' | 'transfer' | 'issue_to_production' | 'return_from_production' | 'return_from_client' | 'surplus';
export const MOVE_LABEL: Record<string, keyof Dict> = {
  receipt: 'opReceipt',
  write_off: 'opWriteOff',
  transfer: 'opTransfer',
  issue_to_production: 'opIssue',
  return_from_production: 'opReturnProd',
  return_from_client: 'opReturnClient',
  surplus: 'opSurplus',
  shipment: 'opShipment',
};

// какие концы операции нужны: откуда (f) и куда (t)
const ENDS: Record<MoveKind, { f: boolean; t: boolean }> = {
  receipt: { f: false, t: true },
  write_off: { f: true, t: false },
  transfer: { f: true, t: true },
  issue_to_production: { f: true, t: false },
  return_from_production: { f: false, t: true },
  return_from_client: { f: false, t: true },
  surplus: { f: false, t: true },
};

export type MoveInit = { type?: MoveKind; itemCode?: string; batchNumber?: string; warehouseCode?: string; locationCode?: string };

/** Форма складской операции. Живёт в панели снизу: на складе человек стоит с телефоном в одной руке. */
export function MoveSheet({ visible, onClose, init }: { visible: boolean; onClose: () => void; init?: MoveInit }) {
  const { t, pick } = useI18n();
  const { can } = useAuth();
  const refs = useApi<any>(visible ? '/warehouse/refs' : null, undefined, { staleTime: 5 * 60_000 });
  const act = useAction();

  const [type, setType] = useState<MoveKind>('receipt');
  const [item, setItem] = useState<string | null>(null);
  const [batch, setBatch] = useState('');
  const [qty, setQty] = useState('');
  const [fromW, setFromW] = useState<string | null>(null);
  const [fromL, setFromL] = useState<string | null>(null);
  const [toW, setToW] = useState<string | null>(null);
  const [toL, setToL] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!visible) return;
    act.reset();
    setType(init?.type ?? 'receipt');
    setItem(init?.itemCode ?? null);
    setBatch(init?.batchNumber ?? '');
    setQty('');
    setFromW(init?.warehouseCode ?? null);
    setFromL(init?.locationCode ?? null);
    setToW(null);
    setToL(null);
    setComment('');
    setTouched(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, init]);

  const types = useMemo(() => {
    const all: MoveKind[] = ['receipt', 'transfer', 'issue_to_production', 'return_from_production', 'return_from_client', 'write_off', 'surplus'];
    return all.filter((k) => (k === 'write_off' ? can('warehouse.writeoff') : true));
  }, [can]);

  const ends = ENDS[type];
  const itemOpts: Option[] = (refs.data?.items ?? []).map((i: any) => ({ value: i.code, label: pick(i, 'name'), hint: i.code }));
  const whOpts: Option[] = (refs.data?.warehouses ?? []).map((w: any) => ({ value: w.code, label: pick(w, 'name') }));
  const locOpts = (w: string | null): Option[] =>
    (refs.data?.locations ?? []).filter((l: any) => l.warehouseCode === w).map((l: any) => ({ value: l.code, label: l.code, hint: pick(l, 'zoneName') }));
  const itemInfo = (refs.data?.items ?? []).find((i: any) => i.code === item);

  const qtyOk = /^\d+([.,]\d{1,6})?$/.test(qty.trim()) && Number(qty.replace(',', '.')) > 0;
  // склад с ячейками требует ячейку: сервер отвечает «Укажите ячейку…»
  const needLoc = (w: string | null) => !!w && locOpts(w).length > 0;
  const batchOk = !itemInfo?.trackBatches || !!batch.trim();
  const valid = !!item && qtyOk && batchOk && (!ends.f || (!!fromW && (!needLoc(fromW) || !!fromL))) && (!ends.t || (!!toW && (!needLoc(toW) || !!toL)));

  const submit = async () => {
    setTouched(true);
    if (!valid) return;
    const body: any = { operationType: type, itemCode: item, qty: qty.trim().replace(',', '.') };
    if (batch.trim()) body.batchNumber = batch.trim();
    if (ends.f) { body.fromWarehouseCode = fromW; if (fromL) body.fromLocationCode = fromL; }
    if (ends.t) { body.toWarehouseCode = toW; if (toL) body.toLocationCode = toL; }
    if (comment.trim()) body.comment = comment.trim();
    const r = await act.run('POST', '/warehouse/moves', body, { success: t('whDone') });
    if (r) onClose();
  };

  return (
    <Sheet visible={visible} onClose={onClose} title={t('whNewMove')} tall>
      <Segmented options={types.map((k) => ({ value: k, label: t(MOVE_LABEL[k]) }))} value={type} onChange={(v) => { setType(v as MoveKind); }} />
      <View style={{ marginHorizontal: -20, marginTop: -14 }} />
      <PickerField label={t('whItem')} value={item} options={itemOpts} onChange={setItem} placeholder={t('whSelectItem')} searchable />
      {itemInfo?.trackBatches && <Field label={t('whBatchNo')} value={batch} onChangeText={setBatch} autoCapitalize="characters" error={touched && !batchOk ? t('required') : null} />}
      <Field
        label={`${t('whQty')}${itemInfo?.unit ? `, ${itemInfo.unit}` : ''}`}
        value={qty}
        onChangeText={setQty}
        keyboardType="decimal-pad"
        error={touched && !qtyOk ? t('required') : null}
      />
      {ends.f && (
        <>
          <PickerField label={t('whFrom')} value={fromW} options={whOpts} onChange={(v) => { setFromW(v); setFromL(null); }} />
          {!!fromW && locOpts(fromW).length > 0 && <PickerField label={t('whLocation')} value={fromL} options={locOpts(fromW)} onChange={setFromL} />}
        </>
      )}
      {ends.t && (
        <>
          <PickerField label={t('whTo')} value={toW} options={whOpts} onChange={(v) => { setToW(v); setToL(null); }} />
          {!!toW && locOpts(toW).length > 0 && <PickerField label={t('whLocation')} value={toL} options={locOpts(toW)} onChange={setToL} />}
        </>
      )}
      <Field label={`${t('whComment')} (${t('whOptional')})`} value={comment} onChangeText={setComment} multiline style={{ height: 70, paddingTop: 12, textAlignVertical: 'top' }} />
      {!!act.error && <Text variant="callout" tone="danger">{act.error}</Text>}
      <Button title={t('confirm')} onPress={submit} loading={act.busy} needsNetwork />
    </Sheet>
  );
}
