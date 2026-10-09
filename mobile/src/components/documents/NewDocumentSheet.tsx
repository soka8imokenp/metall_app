import React, { useEffect, useState } from 'react';
import { Sheet } from '@/ui/Sheet';
import { PickerField } from '@/ui/Picker';
import { Button } from '@/ui/components';
import { Text } from '@/ui/Text';
import { useApi } from '@/api/query';
import { useAction } from '@/api/action';
import { useI18n } from '@/i18n';

const KINDS = [
  ['sales_order', 'srcSalesOrder'],
  ['shipment', 'srcShipment'],
  ['production_order', 'srcProduction'],
  ['finance_operation', 'srcFinance'],
  ['partner', 'srcPartner'],
] as const;

/** Создание документа по шаблону: тип документа + основание (заказ, отгрузка…) — остальное заполняет сервер. */
export function NewDocumentSheet({ visible, onClose, onCreated }: { visible: boolean; onClose: () => void; onCreated: (uid?: string) => void }) {
  const { t, pick, locale } = useI18n();
  const act = useAction();
  const [type, setType] = useState<string | null>(null);
  const [kind, setKind] = useState<string>('sales_order');
  const [source, setSource] = useState<string | null>(null);
  const types = useApi<{ rows: any[] }>(visible ? '/documents/types' : null);
  const sources = useApi<{ rows: any[] }>(visible ? '/documents/sources' : null, { kind });

  useEffect(() => { if (visible) { act.reset(); setSource(null); } /* eslint-disable-next-line */ }, [visible]);

  const submit = async () => {
    if (!type || !source) return;
    const r: any = await act.run('POST', '/documents/from-source', { documentTypeUid: type, sourceType: kind, sourceUid: source, locale }, { success: t('dcCreated') });
    if (r) { onClose(); onCreated(r.uid ?? r.document?.uid); }
  };

  return (
    <Sheet visible={visible} onClose={onClose} title={t('dcNew')} tall>
      <PickerField label={t('dcType')} value={type} options={(types.data?.rows ?? []).filter((x) => x.isActive).map((x) => ({ value: x.uid, label: pick(x, 'name'), hint: x.code }))} onChange={setType} />
      <PickerField label={t('dcSourceKind')} value={kind} options={KINDS.map(([v, l]) => ({ value: v, label: t(l) }))} onChange={(v) => { setKind(v); setSource(null); }} />
      <PickerField
        label={t('dcSource')}
        value={source}
        options={(sources.data?.rows ?? []).map((s: any) => ({ value: s.uid, label: s.number ?? s.name ?? s.uid, hint: [s.partner, s.at].filter(Boolean).join(' · ') }))}
        onChange={setSource}
        searchable
      />
      {!!act.error && <Text tone="danger" variant="callout">{act.error}</Text>}
      <Button title={t('dcCreate')} needsNetwork loading={act.busy} disabled={!type || !source} onPress={submit} />
    </Sheet>
  );
}
