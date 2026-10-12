import React, { useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { Badge, Button, Card, Field } from '@/ui/components';
import { Feather } from '@/ui/Icon';
import { useTheme } from '@/theme/ThemeProvider';
import { Sheet } from '@/ui/Sheet';
import { PickerField } from '@/ui/Picker';
import { Text } from '@/ui/Text';
import { useAction } from '@/api/action';
import { useApi } from '@/api/query';
import { useAuth } from '@/auth/AuthProvider';
import { useI18n } from '@/i18n';
import { MARK_LABEL, STAGE_STATUS } from '@/lib/status';

/** Этап заказа и отметки по нему: начать, пауза (с причиной), продолжить, завершить. */
export function StageCard({ s, orderUid, orderNumber, itemName, orderStatus, onOpenOrder }: { s: any; orderUid: string; orderNumber?: string; itemName?: string; orderStatus?: string; onOpenOrder?: () => void }) {
  const { t, pick } = useI18n();
  const { can } = useAuth();
  const { colors } = useTheme();
  const act = useAction();
  // Лист отметки: пауза (причина + комментарий) или завершение (комментарий).
  const [sheet, setSheet] = useState<'pause' | 'finish' | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const opts = useApi<any>(sheet === 'pause' ? '/production/options' : null, undefined, { staleTime: 5 * 60_000 });
  const [k, tone] = STAGE_STATUS[s.status] ?? ['prStagePending', 'neutral'];
  const marks: string[] = s.marks ?? [];
  const canWork = can('production.work', 'production.manage');

  const doMark = async (kind: string, reasonUid?: string, note?: string) => {
    const r = await act.run(
      'POST',
      `/production/orders/${orderUid}/stages/${s.seq}/mark`,
      { kind, reasonUid, comment: note?.trim() || undefined },
      { success: t('prDone2') },
    );
    if (r) { setSheet(null); setComment(''); setReason(null); }
  };

  return (
    <Card onPress={onOpenOrder} style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <View style={{ flex: 1, gap: 2 }}>
          {!!orderNumber && <Text variant="caption" tone="secondary">{orderNumber}{itemName ? ` · ${itemName}` : ''}</Text>}
          <Text variant="headline" numberOfLines={2}>{s.seq}. {pick(s, 'name')}</Text>
          {!!s.workCenterCode && <Text variant="caption" tone="secondary">{pick(s, 'workCenterName')}</Text>}
        </View>
        <Badge label={t(k)} tone={tone} />
      </View>
      {orderStatus === 'planned' && (
        can('production.manage') ? (
          <Button size="sm" icon="play" needsNetwork loading={act.busy} title={t('prLaunch')} style={{ alignSelf: 'flex-start' }} onPress={() => act.run('POST', `/production/orders/${orderUid}/status`, { status: 'in_progress' }, { success: t('prDone2') })} />
        ) : (
          <Text variant="caption" tone="warning">{t('prNotLaunched')}</Text>
        )
      )}
      {canWork && marks.length > 0 && orderStatus !== 'planned' && (
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          {marks.map((m) => (
            <Button
              key={m}
              size="sm"
              needsNetwork
              loading={act.busy}
              variant={m === 'finish' || m === 'start' || m === 'resume' ? 'primary' : 'secondary'}
              title={t(MARK_LABEL[m])}
              onPress={() => (m === 'pause' || m === 'finish' ? (setComment(''), setSheet(m)) : doMark(m))}
            />
          ))}
        </View>
      )}
      {!!s.comment && (
        <View style={{ flexDirection: 'row', gap: 6, alignItems: 'flex-start' }}>
          <Feather name="file-text" size={13} color={colors.textMuted} />
          <Text variant="caption" tone="secondary" style={{ flex: 1 }} numberOfLines={3}>{s.comment}</Text>
        </View>
      )}
      <Sheet visible={!!sheet} onClose={() => setSheet(null)} title={sheet === 'pause' ? t('prPauseReason') : t('prMarkFinish')}>
        {sheet === 'pause' && (
          <PickerField
            label={t('prReason')}
            value={reason}
            options={(opts.data?.downtimeReasons ?? []).map((r: any) => ({ value: r.uid, label: pick(r, 'name') }))}
            onChange={setReason}
          />
        )}
        <Field label={`${t('whComment')} (${t('whOptional')})`} value={comment} onChangeText={setComment} multiline style={{ height: 80 }} />
        {!!act.error && <Text variant="callout" tone="danger">{act.error}</Text>}
        <Button
          title={sheet === 'pause' ? t('prMarkPause') : t('prMarkFinish')}
          needsNetwork
          loading={act.busy}
          onPress={() => doMark(sheet!, sheet === 'pause' ? reason ?? undefined : undefined, comment)}
        />
      </Sheet>
    </Card>
  );
}
