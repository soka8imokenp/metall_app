import React, { useEffect, useState } from 'react';
import { Sheet } from '@/ui/Sheet';
import { PickerField } from '@/ui/Picker';
import { Button, Field, Segmented } from '@/ui/components';
import { Text } from '@/ui/Text';
import { useApi } from '@/api/query';
import { useAction } from '@/api/action';
import { useI18n } from '@/i18n';

/** Ввод дохода или расхода. Фото чека прикладывается в карточке сразу после создания. */
export function NewOperationSheet({ visible, onClose, onCreated }: { visible: boolean; onClose: () => void; onCreated: (uid?: string) => void }) {
  const { t, pick } = useI18n();
  const refs = useApi<any>(visible ? '/finance/refs' : null, undefined, { staleTime: 5 * 60_000 });
  const act = useAction();
  const [type, setType] = useState<'income' | 'expense'>('expense');
  const [account, setAccount] = useState<string | null>(null);
  const [counter, setCounter] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('UZS');
  const [item, setItem] = useState<string | null>(null);
  const [partner, setPartner] = useState<string | null>(null);
  const [comment, setComment] = useState('');

  useEffect(() => {
    if (visible) { act.reset(); setAmount(''); setComment(''); setItem(null); setPartner(null); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const accOpts = (refs.data?.accounts ?? []).map((a: any) => ({ value: a.code, label: `${a.code} · ${pick(a, 'name')}`, hint: a.currency }));
  const money = (refs.data?.accounts ?? []).filter((a: any) => ['cash', 'bank'].includes(a.kind)).map((a: any) => ({ value: a.code, label: `${a.code} · ${pick(a, 'name')}`, hint: a.currency }));
  const items = (refs.data?.cashflowItems ?? []).filter((i: any) => (type === 'income' ? i.direction === 'inflow' : i.direction === 'outflow'));
  const amountOk = /^\d{1,15}([.,]\d{1,4})?$/.test(amount.trim()) && Number(amount.replace(',', '.')) > 0;
  const valid = !!account && !!counter && amountOk;

  const submit = async () => {
    if (!valid) return;
    const body: any = { operationType: type, accountCode: account, counterAccountCode: counter, amount: amount.trim().replace(',', '.'), currencyCode: currency };
    if (item) body.cashflowItemUid = item;
    if (partner) body.partnerUid = partner;
    if (comment.trim()) body.comment = comment.trim();
    const r: any = await act.run('POST', '/finance/operations', body, { success: t('fnCreated') });
    if (r) { onClose(); onCreated(r.uid ?? r.operation?.uid); }
  };

  return (
    <Sheet visible={visible} onClose={onClose} title={t('fnNew')} tall>
      <Segmented options={[{ value: 'expense', label: t('fnExpense') }, { value: 'income', label: t('fnIncome') }]} value={type} onChange={(v) => { setType(v); setItem(null); }} />
      <PickerField label={t('fnAccount')} value={account} options={money} onChange={(v) => { setAccount(v); const a = (refs.data?.accounts ?? []).find((x: any) => x.code === v); if (a) setCurrency(a.currency); }} />
      <PickerField label={t('fnCounter')} value={counter} options={accOpts} onChange={setCounter} />
      <Field label={`${t('fnAmount')}, ${currency}`} value={amount} onChangeText={setAmount} keyboardType="decimal-pad" />
      <PickerField label={t('fnItem')} value={item} options={items.map((i: any) => ({ value: i.uid, label: pick(i, 'name') }))} onChange={setItem} />
      <PickerField label={t('fnPartner')} value={partner} options={(refs.data?.partners ?? []).map((p: any) => ({ value: p.uid, label: pick(p, 'name') }))} onChange={setPartner} searchable />
      <Field label={t('fnComment')} value={comment} onChangeText={setComment} multiline style={{ height: 70, paddingTop: 12, textAlignVertical: 'top' }} />
      {!!act.error && <Text tone="danger" variant="callout">{act.error}</Text>}
      <Button title={t('save')} needsNetwork loading={act.busy} disabled={!valid} onPress={submit} />
    </Sheet>
  );
}
