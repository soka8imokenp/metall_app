import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Sheet } from '@/ui/Sheet';
import { PickerField } from '@/ui/Picker';
import { Button, Card, Field } from '@/ui/components';
import { Text } from '@/ui/Text';
import { Pressable } from '@/ui/Pressable';
import { useApi } from '@/api/query';
import { useAction } from '@/api/action';
import { useI18n } from '@/i18n';
import { useAuth } from '@/auth/AuthProvider';
import { api } from '@/api/client';
import { Feather } from '@/ui/Icon';
import { useTheme } from '@/theme/ThemeProvider';

type Line = { item: string | null; qty: string; price: string };
const empty = (): Line => ({ item: null, qty: '', price: '' });

/** Новый заказ: клиент, склад и позиции. Цена подтягивается из прайса клиента и правится руками при праве `sales.price`. */
export function NewOrderSheet({ visible, onClose, onCreated }: { visible: boolean; onClose: () => void; onCreated: (uid?: string) => void }) {
  const { t, pick } = useI18n();
  const { can, companies, companyKey } = useAuth();
  const { colors } = useTheme();
  const refs = useApi<any>(visible ? '/sales/refs' : null, undefined, { staleTime: 5 * 60_000 });
  const act = useAction();
  const [partner, setPartner] = useState<string | null>(null);
  const [wh, setWh] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([empty()]);
  const [comment, setComment] = useState('');

  useEffect(() => { if (visible) { act.reset(); setPartner(null); setLines([empty()]); setComment(''); } /* eslint-disable-next-line */ }, [visible]);

  const setLine = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  const pickItem = async (i: number, code: string) => {
    setLine(i, { item: code });
    if (partner) {
      try {
        const p: any = await api('/sales/price', { query: { partnerUid: partner, itemCode: code } });
        if (p?.price) setLine(i, { item: code, price: String(p.price).replace(/\.0+$/, '') });
      } catch { /* цены нет — введут руками или возьмётся прайс на сервере */ }
    }
  };

  const items = (refs.data?.items ?? []).map((x: any) => ({ value: x.code, label: pick(x, 'name'), hint: x.code }));
  const qtyOk = (s: string) => /^\d+([.,]\d{1,6})?$/.test(s.trim()) && Number(s.replace(',', '.')) > 0;
  const valid = !!partner && lines.every((l) => l.item && qtyOk(l.qty));

  const submit = async () => {
    if (!valid) return;
    const body: any = {
      partnerUid: partner,
      comment: comment.trim() || undefined,
      warehouseCode: wh ?? undefined,
      lines: lines.map((l) => ({ itemCode: l.item, qty: l.qty.trim().replace(',', '.'), price: l.price.trim() ? l.price.trim().replace(',', '.') : undefined })),
    };
    const cu = companyKey !== 'all' ? companyKey : companies.find((c) => c.code === 'trade')?.uid ?? companies[0]?.uid;
    if (cu) body.companyUid = cu;
    const r: any = await act.run('POST', '/sales/orders', body, { success: t('slCreated') });
    if (r) { onClose(); onCreated(r.uid ?? r.order?.uid); }
  };

  return (
    <Sheet visible={visible} onClose={onClose} title={t('slNew')} tall>
      <PickerField label={t('slPartner')} value={partner} options={(refs.data?.partners ?? []).map((p: any) => ({ value: p.uid, label: pick(p, 'name'), hint: p.inn }))} onChange={setPartner} searchable />
      <PickerField label={t('slWarehouse')} value={wh} options={(refs.data?.warehouses ?? []).map((w: any) => ({ value: w.code, label: pick(w, 'name') }))} onChange={setWh} />
      {lines.map((l, i) => (
        <Card key={i} style={{ gap: 10 }}>
          <PickerField label={`${t('whItem')} ${lines.length > 1 ? i + 1 : ''}`} value={l.item} options={items} onChange={(v) => pickItem(i, v)} placeholder={t('whSelectItem')} searchable />
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <View style={{ flex: 1 }}><Field label={t('whQty')} value={l.qty} onChangeText={(v) => setLine(i, { qty: v })} keyboardType="decimal-pad" /></View>
            <View style={{ flex: 1 }}><Field label={t('slPrice')} value={l.price} onChangeText={(v) => setLine(i, { price: v })} keyboardType="decimal-pad" editable={can('sales.price')} /></View>
          </View>
          {lines.length > 1 && (
            <Pressable onPress={() => setLines((ls) => ls.filter((_, k) => k !== i))} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-end' }}>
              <Feather name="trash-2" size={14} color={colors.danger} />
              <Text variant="caption" tone="danger">{t('slRemoveLine')}</Text>
            </Pressable>
          )}
        </Card>
      ))}
      <Button title={t('slAddLine')} variant="secondary" icon="plus" onPress={() => setLines((ls) => [...ls, empty()])} />
      <Field label={t('fnComment')} value={comment} onChangeText={setComment} multiline style={{ height: 70, paddingTop: 12, textAlignVertical: 'top' }} />
      {!!act.error && <Text tone="danger" variant="callout">{act.error}</Text>}
      <Button title={t('save')} needsNetwork loading={act.busy} disabled={!valid} onPress={submit} />
    </Sheet>
  );
}
