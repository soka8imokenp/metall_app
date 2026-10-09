import React, { useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, Divider, ErrorState, Field, KV, Screen, Section, Skeleton } from '@/ui/components';
import { Sheet } from '@/ui/Sheet';
import { Text } from '@/ui/Text';
import { PhotoStrip } from '@/components/Photos';
import { useApi } from '@/api/query';
import { useAction } from '@/api/action';
import { useAuth } from '@/auth/AuthProvider';
import { useI18n } from '@/i18n';
import { useTheme } from '@/theme/ThemeProvider';
import { dateShort, money } from '@/lib/format';
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
    const r = await act.run('POST', `/finance/operations/${uid}/${action}`, { version: o.version, comment: c || undefined }, { success: t('prDone2') });
    if (r) setReject(false);
  };

  return (
    <Screen title={o?.number ?? '…'} back={() => router.back()} onRefresh={() => qc.invalidateQueries({ queryKey: ['api'] })} refreshing={q.isRefetching} padBottom={false} contentStyle={{ paddingBottom: 40 }}>
      {q.isLoading ? (
        <View style={{ padding: 20, gap: 12 }}><Skeleton h={160} r={16} /><Skeleton h={90} r={16} /></View>
      ) : q.error ? (
        <ErrorState message={q.error.message} onRetry={() => q.refetch()} />
      ) : o ? (
        <>
          <Section>
            <Card style={{ gap: 10 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Badge label={t(sk as any)} tone={stone as any} />
                <Text variant="caption" tone="secondary">{t(FIN_TYPE[o.type] ?? 'fnExpense')}</Text>
              </View>
              <Text variant="largeTitle" num style={{ color: o.type === 'income' ? colors.success : colors.text }}>{money(o.amount, o.currency)}</Text>
              <Divider />
              <KV k={t('fnAccount')} v={pick(o.account, 'name')} />
              <KV k={t('fnCounter')} v={pick(o.counterAccount, 'name')} />
              {!!o.cashflowItem && <KV k={t('fnItem')} v={pick(o.cashflowItem, 'name')} />}
              {!!o.partner && <KV k={t('fnPartner')} v={pick(o.partner, 'name')} />}
              <KV k={t('fnPlanned')} v={dateShort(o.plannedDate ?? o.occurredAt)} />
              <KV k={t('fnAuthor')} v={o.createdBy ?? '—'} />
              {!!o.comment && <Text variant="callout" tone="secondary" style={{ marginTop: 6 }}>{o.comment}</Text>}
            </Card>
          </Section>

          <Section>
            <View style={{ gap: 10 }}>
              {o.status === 'draft' && can('finance.post') && <Button title={t('fnSubmit')} icon="send" needsNetwork loading={act.busy} onPress={() => call('submit')} />}
              {o.status === 'pending_approval' && can('finance.approve') && (
                <>
                  <Button title={t('fnApprove')} icon="check" needsNetwork loading={act.busy} onPress={() => call('approve')} />
                  <Button title={t('fnReject')} variant="secondary" icon="x" needsNetwork onPress={() => { act.reset(); setComment(''); setReject(true); }} />
                </>
              )}
              {o.status === 'approved' && can('finance.post') && <Button title={t('fnPost')} icon="check-circle" needsNetwork loading={act.busy} onPress={() => call('post')} />}
              {!!act.error && <Text tone="danger" variant="callout">{act.error}</Text>}
            </View>
          </Section>

          <Section title={t('fnReceipt')}>
            <PhotoStrip owner="finance_operation" uid={o.uid} canEdit={can('finance.post')} />
          </Section>

          <Sheet visible={reject} onClose={() => setReject(false)} title={t('fnReject')}>
            <Field label={t('fnCommentReject')} value={comment} onChangeText={setComment} multiline style={{ height: 90, paddingTop: 12, textAlignVertical: 'top' }} autoFocus />
            <Button title={t('fnReject')} variant="danger" needsNetwork loading={act.busy} disabled={!comment.trim()} onPress={() => call('reject', comment)} />
          </Sheet>
        </>
      ) : null}
    </Screen>
  );
}
