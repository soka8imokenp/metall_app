import React, { useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { Button, ErrorState, Field, Screen, Section, Skeleton } from '@/ui/components';
import { ActionDock, DOCK_SPACE, DockKey, Readout, SlideConfirm, SpecPlate, StatusLamp, type Spec } from '@/ui/Instrument';
import { Appear } from '@/ui/motion';
import { Sheet } from '@/ui/Sheet';
import { Text } from '@/ui/Text';
import { PhotoStrip } from '@/components/Photos';
import { useApi } from '@/api/query';
import { useAction } from '@/api/action';
import { useAuth } from '@/auth/AuthProvider';
import { useI18n } from '@/i18n';
import { useTheme } from '@/theme/ThemeProvider';
import { dateShort, moneyParts } from '@/lib/format';
import { FIN_STATUS, FIN_TYPE } from '@/lib/status';

export default function OperationDetail() {
  const { uid } = useLocalSearchParams<{ uid: string }>();
  const { t, pick } = useI18n();
  const { can } = useAuth();
  const { colors } = useTheme();
  const router = useRouter();
  const qc = useQueryClient();
  const q = useApi<any>(`/finance/operations/${uid}`);
  const act = useAction();
  const [reject, setReject] = useState(false);
  const [comment, setComment] = useState('');

  const o = q.data?.operation;
  const [sk, stone] = o ? FIN_STATUS[o.status] ?? ['fnStDraft', 'neutral'] : ['fnStDraft', 'neutral'];

  const call = async (action: 'submit' | 'approve' | 'reject' | 'post', c?: string) => {
    const label = action === 'approve' ? t('fnApproved') : action === 'post' ? t('fnPosted') : action === 'submit' ? t('fnSubmitted') : t('prDone2');
    const r = await act.run('POST', `/finance/operations/${uid}/${action}`, { version: o.version, comment: c || undefined }, { success: label, burst: action !== 'reject' });
    if (r) setReject(false);
  };

  const canSubmit = o?.status === 'draft' && can('finance.post');
  const canApprove = o?.status === 'pending_approval' && can('finance.approve');
  const canPost = o?.status === 'approved' && can('finance.post');
  const [value, scale] = o ? moneyParts(o.amount) : ['', ''];
  const cur = o?.currency && o.currency !== 'UZS' ? scale.replace('сум', o.currency) : scale;

  const specs: Spec[] = o
    ? [
        { label: t('fnAccount'), value: pick(o.account, 'name') },
        { label: t('fnCounter'), value: pick(o.counterAccount, 'name') },
        ...(o.cashflowItem ? [{ label: t('fnItem'), value: pick(o.cashflowItem, 'name') }] : []),
        ...(o.partner ? [{ label: t('fnPartner'), value: pick(o.partner, 'name') }] : []),
        { label: t('fnPlanned'), value: dateShort(o.plannedDate ?? o.occurredAt) },
        { label: t('fnAuthor'), value: o.createdBy ?? '—' },
      ]
    : [];

  const dock = o && (canSubmit || canApprove || canPost) ? (
    <ActionDock>
      {canApprove && <DockKey icon="x" label={t('fnReject')} tone="danger" onPress={() => { act.reset(); setComment(''); setReject(true); }} />}
      {canSubmit && <SlideConfirm label={t('fnSubmit')} icon="send" busy={act.busy} onConfirm={() => call('submit')} />}
      {canApprove && <SlideConfirm label={t('fnApprove')} busy={act.busy} onConfirm={() => call('approve')} />}
      {canPost && <SlideConfirm label={t('fnPost')} icon="check-circle" tone="brand" busy={act.busy} onConfirm={() => call('post')} />}
    </ActionDock>
  ) : null;

  return (
    <Screen
      title={o?.number ?? '…'}
      back={() => router.back()}
      onRefresh={() => qc.invalidateQueries({ queryKey: ['api'] })}
      refreshing={q.isRefetching}
      padBottom={false}
      contentStyle={{ paddingBottom: dock ? DOCK_SPACE : 40 }}
      footer={dock}
    >
      {q.isLoading ? (
        <View style={{ padding: 20, gap: 12 }}><Skeleton h={120} r={16} /><Skeleton h={140} r={16} /></View>
      ) : q.error ? (
        <ErrorState message={q.error.message} onRetry={() => q.refetch()} />
      ) : o ? (
        <>
          {/* показание: статус-лампа и сумма */}
          <View style={{ paddingHorizontal: 22, marginBottom: 22, gap: 12 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <StatusLamp tone={stone as any} label={t(sk as any)} pulse={o.status === 'pending_approval'} />
              <Text variant="caption" tone="muted" style={{ letterSpacing: 0.8, textTransform: 'uppercase', fontWeight: '600' }}>{t(FIN_TYPE[o.type] ?? 'fnExpense')}</Text>
            </View>
            <Readout value={value} unit={cur} color={o.type === 'income' ? colors.success : undefined} />
          </View>

          <Appear i={1}><Section><SpecPlate items={specs} /></Section></Appear>

          {!!o.comment && (
            <Appear i={2}>
              <Section>
                <View style={{ borderLeftWidth: 3, borderLeftColor: colors.brand, paddingLeft: 14, paddingVertical: 2 }}>
                  <Text variant="callout" tone="secondary">{o.comment}</Text>
                </View>
              </Section>
            </Appear>
          )}

          <Appear i={3}>
            <Section title={t('fnReceipt')}>
              <PhotoStrip owner="finance_operation" uid={o.uid} canEdit={can('finance.post')} />
            </Section>
          </Appear>

          <Sheet visible={reject} onClose={() => setReject(false)} title={t('fnReject')}>
            <Field label={t('fnCommentReject')} value={comment} onChangeText={setComment} multiline style={{ height: 90, paddingTop: 12, textAlignVertical: 'top' }} autoFocus />
            <Button title={t('fnReject')} variant="danger" needsNetwork loading={act.busy} disabled={!comment.trim()} onPress={() => call('reject', comment)} />
          </Sheet>
        </>
      ) : null}
    </Screen>
  );
}
