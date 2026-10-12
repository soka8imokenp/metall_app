import React, { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { Sheet } from '@/ui/Sheet';
import { PickerField } from '@/ui/Picker';
import { Button, Field } from '@/ui/components';
import { Switch } from '@/ui/Switch';
import { Text } from '@/ui/Text';
import { useApi } from '@/api/query';
import { useAction } from '@/api/action';
import { useI18n } from '@/i18n';

/**
 * Новый лист инвентаризации (ТЗ 5.8): склад, зона (или весь склад) и режим.
 * «Остановить движения» — режим `block`: пока идёт подсчёт, операции по
 * зоне не проходят; иначе (`mark`) они идут и отмечаются в листе.
 */
export function NewInventorySheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { t, pick } = useI18n();
  const router = useRouter();
  const refs = useApi<any>(visible ? '/warehouse/refs' : null, undefined, { staleTime: 5 * 60_000 });
  const act = useAction();
  const [wh, setWh] = useState<string | null>(null);
  const [zone, setZone] = useState<string>('');
  const [block, setBlock] = useState(false);
  const [comment, setComment] = useState('');

  useEffect(() => {
    if (visible) { act.reset(); setZone(''); setBlock(false); setComment(''); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const zones = useMemo(() => {
    const seen = new Map<string, string>();
    for (const l of refs.data?.locations ?? []) if (l.warehouseCode === wh && !seen.has(l.zoneCode)) seen.set(l.zoneCode, pick(l, 'zoneName'));
    return [{ value: '', label: t('whAllZones') }, ...[...seen].map(([value, label]) => ({ value, label: `${value} · ${label}` }))];
  }, [refs.data, wh, pick, t]);

  const submit = async () => {
    if (!wh) return;
    const r: any = await act.run(
      'POST',
      '/warehouse/inventory',
      { warehouseCode: wh, zoneCode: zone || undefined, blockMode: block ? 'block' : 'mark', comment: comment.trim() || undefined },
      { success: t('whSheetCreated') },
    );
    if (r) {
      onClose();
      if (r.uid) router.push(`/inventory/${r.uid}`);
    }
  };

  return (
    <Sheet visible={visible} onClose={onClose} title={t('whNewSheet')} tall>
      <PickerField label={t('whWarehouse')} value={wh} options={(refs.data?.warehouses ?? []).map((w: any) => ({ value: w.code, label: pick(w, 'name') }))} onChange={(v) => { setWh(v); setZone(''); }} />
      {!!wh && <PickerField label={t('whZone')} value={zone} options={zones} onChange={setZone} />}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Text variant="body" style={{ flex: 1 }}>{t('whBlock')}</Text>
        <Switch value={block} onChange={setBlock} />
      </View>
      <Field label={`${t('whComment')} (${t('whOptional')})`} value={comment} onChangeText={setComment} multiline style={{ height: 80 }} />
      {!!act.error && <Text variant="callout" tone="danger">{act.error}</Text>}
      <Button title={t('confirm')} needsNetwork loading={act.busy} disabled={!wh} onPress={submit} />
    </Sheet>
  );
}
