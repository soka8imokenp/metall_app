import React, { useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, Divider, ErrorState, Field, KV, Screen, Section, Skeleton } from '@/ui/components';
import { Sheet } from '@/ui/Sheet';
import { Text } from '@/ui/Text';
import { PhotoStrip } from '@/components/Photos';
import { useAuth } from '@/auth/AuthProvider';
import { useApi } from '@/api/query';
import { useAction } from '@/api/action';
import { useToast } from '@/ui/Toast';
import { useI18n } from '@/i18n';
import { useTheme } from '@/theme/ThemeProvider';
import { dateShort, dateTime, money, num } from '@/lib/format';
import { DOC_STATUS } from '@/lib/status';
import { openRemoteFile } from '@/lib/files';
import { useOnline } from '@/lib/network';
import type { Dict } from '@/i18n/ru';

const ACTION_LABEL: Record<string, keyof Dict> = { submit: 'dcSubmit', approve: 'dcApprove', return: 'dcReturn', sign: 'dcSign', cancel: 'dcCancel' };
const NEEDS_COMMENT = ['return', 'cancel'];

export default function DocumentDetail() {
  const { uid } = useLocalSearchParams<{ uid: string }>();
  const { t, pick } = useI18n();
  const { colors } = useTheme();
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const online = useOnline();
  const { can } = useAuth();
  const q = useApi<any>(`/documents/${uid}`);
  const hist = useApi<{ rows: any[] }>(`/documents/${uid}/history`);
  const vers = useApi<{ current: number; rows: any[] }>(`/documents/${uid}/versions`);
  const act = useAction();
  const [ask, setAsk] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [opening, setOpening] = useState(false);

  const d = q.data;
  const [sk, stone] = d ? DOC_STATUS[d.status] ?? ['dcStDraft', 'neutral'] : ['dcStDraft', 'neutral'];

  const run = async (action: string, c?: string) => {
    const r = await act.run('POST', `/documents/${uid}/actions`, { action, comment: c || undefined }, { success: t('prDone2') });
    if (r) setAsk(null);
  };

  const open = async (format: 'pdf' | 'docx', version?: number) => {
    if (!online) return toast.show(t('needsNetwork'), 'error');
    setOpening(true);
    try {
      const path = version ? `/documents/${uid}/versions/${version}/file?format=${format}` : `/documents/${uid}/file?format=${format}`;
      await openRemoteFile(path, `${d.number}${version ? `-v${version}` : ''}.${format}`);
    } catch {
      toast.show(t('dcOpenFail'), 'error');
    } finally {
      setOpening(false);
    }
  };

  return (
    <Screen title={d?.number ?? '…'} subtitle={d ? pick(d.type, 'name') : undefined} back={() => router.back()} onRefresh={() => qc.invalidateQueries({ queryKey: ['api'] })} refreshing={q.isRefetching} padBottom={false} contentStyle={{ paddingBottom: 40 }}>
      {q.isLoading ? (
        <View style={{ padding: 20, gap: 12 }}><Skeleton h={150} r={16} /><Skeleton h={100} r={16} /></View>
      ) : q.error ? (
        <ErrorState message={q.error.message} onRetry={() => q.refetch()} />
      ) : d ? (
        <>
          <Section>
            <Card style={{ gap: 8 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Badge label={t(sk as any)} tone={stone as any} />
                <Text variant="caption" tone="secondary">{dateShort(d.documentDate)}</Text>
              </View>
              <Text variant="largeTitle" num>{money(d.amountTotal, d.currency)}</Text>
              <Divider />
              <KV k={t('dcPartner')} v={d.partner?.name ?? '—'} />
              {!!d.source && <KV k={t('dcSource')} v={d.source.number} />}
              <KV k={t('dcVat')} v={money(d.amountVat, d.currency)} />
              <KV k={t('fnAuthor')} v={d.author?.name ?? '—'} />
              {!!d.statusComment && <Text variant="callout" tone="secondary" style={{ marginTop: 6 }}>{d.statusComment}</Text>}
            </Card>
          </Section>

          <Section>
            <View style={{ gap: 10 }}>
              {(d.actions ?? []).map((a: string) => (
                <Button
                  key={a}
                  title={t(ACTION_LABEL[a] ?? 'confirm')}
                  variant={a === 'approve' || a === 'submit' || a === 'sign' ? 'primary' : 'secondary'}
                  icon={a === 'approve' ? 'check' : a === 'submit' ? 'send' : a === 'sign' ? 'edit-3' : a === 'return' ? 'corner-up-left' : 'x'}
                  needsNetwork
                  loading={act.busy && !ask}
                  onPress={() => (NEEDS_COMMENT.includes(a) ? (act.reset(), setComment(''), setAsk(a)) : run(a))}
                />
              ))}
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <Button style={{ flex: 1 }} variant="secondary" icon="file" title={t('dcPdf')} loading={opening} needsNetwork onPress={() => open('pdf')} />
                <Button style={{ flex: 1 }} variant="secondary" icon="file-text" title={t('dcDocx')} loading={opening} needsNetwork onPress={() => open('docx')} />
              </View>
              {!!act.error && !ask && <Text tone="danger" variant="callout">{act.error}</Text>}
            </View>
          </Section>

          <Section title={t('dcLines')}>
            <Card padded={false}>
              {(d.lines ?? []).map((l: any, i: number) => (
                <View key={l.uid}>
                  {i > 0 && <View style={{ height: 1, backgroundColor: colors.border }} />}
                  <View style={{ padding: 14, gap: 4 }}>
                    <Text variant="callout" style={{ fontWeight: '600' }}>{l.name}</Text>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                      <Text variant="caption" tone="secondary" num>{num(l.qty, 3)} {l.unitName ?? l.unitCode} × {money(l.price, d.currency)}</Text>
                      <Text variant="callout" num style={{ fontWeight: '700' }}>{money(l.amountTotal, d.currency)}</Text>
                    </View>
                  </View>
                </View>
              ))}
            </Card>
          </Section>

          <Section title={t('dcScans')}>
            <PhotoStrip owner="document" uid={d.uid ?? uid} canEdit={can('documents.edit')} />
          </Section>

          {!!vers.data?.rows?.length && (
            <Section title={t('dcVersions')}>
              <Card padded={false}>
                <View style={{ padding: 14, flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text variant="callout" style={{ fontWeight: '600' }}>{t('dcVersionN')} {vers.data.current}</Text>
                  <Badge label={t('dcCurrent')} tone="success" />
                </View>
                {vers.data.rows.map((v: any) => {
                  const [vk, vt] = DOC_STATUS[v.status] ?? ['dcStDraft', 'neutral'];
                  return (
                    <View key={v.uid}>
                      <View style={{ height: 1, backgroundColor: colors.border }} />
                      <View style={{ padding: 14, gap: 6 }}>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                          <Text variant="callout" style={{ fontWeight: '600' }}>{t('dcVersionN')} {v.version}</Text>
                          <Badge label={t(vk as any)} tone={vt as any} />
                        </View>
                        <Text variant="caption" tone="secondary" num>
                          {money(v.amountTotal, d.currency)} · {v.linesCount} · {[v.author, dateTime(v.replacedAt)].filter(Boolean).join(' · ')}
                        </Text>
                        {can('documents.edit') && (v.hasPdf || v.hasTemplate) && (
                          <View style={{ flexDirection: 'row', gap: 10, marginTop: 4 }}>
                            {v.hasPdf && <Button style={{ flex: 1 }} size="sm" variant="secondary" icon="file" title={t('dcPdf')} loading={opening} needsNetwork onPress={() => open('pdf', v.version)} />}
                            {v.hasTemplate && <Button style={{ flex: 1 }} size="sm" variant="secondary" icon="file-text" title={t('dcDocx')} loading={opening} needsNetwork onPress={() => open('docx', v.version)} />}
                          </View>
                        )}
                      </View>
                    </View>
                  );
                })}
              </Card>
            </Section>
          )}

          <Section title={t('dcHistory')}>
            <Card padded={false}>
              {!hist.data?.rows?.length ? (
                <Text variant="callout" tone="secondary" style={{ padding: 14 }}>{hist.isLoading ? '…' : t('dcNoHistory')}</Text>
              ) : (
                hist.data.rows.map((h: any, i: number) => {
                  const st = h.changes?.status?.to as string | undefined;
                  const label = (t as any)(`dcH${h.action}`);
                  const comment = h.changes?.comment?.to as string | undefined;
                  return (
                    <View key={`${h.at}-${i}`}>
                      {i > 0 && <View style={{ height: 1, backgroundColor: colors.border }} />}
                      <View style={{ padding: 14, gap: 4 }}>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                          <Text variant="callout" style={{ fontWeight: '600', flex: 1 }}>{label && !label.startsWith('dcH') ? label : h.action}</Text>
                          {!!st && DOC_STATUS[st] && <Badge label={t(DOC_STATUS[st][0])} tone={DOC_STATUS[st][1]} />}
                        </View>
                        <Text variant="caption" tone="secondary">{[h.user, dateTime(h.at)].filter(Boolean).join(' · ')}</Text>
                        {!!comment && <Text variant="caption">{comment}</Text>}
                      </View>
                    </View>
                  );
                })
              )}
            </Card>
          </Section>

          <Sheet visible={!!ask} onClose={() => setAsk(null)} title={ask ? t(ACTION_LABEL[ask]) : ''}>
            <Field label={ask === 'return' ? t('dcReturnReason') : t('dcComment')} value={comment} onChangeText={setComment} multiline style={{ height: 90, paddingTop: 12, textAlignVertical: 'top' }} autoFocus />
            {!!act.error && <Text tone="danger" variant="callout">{act.error}</Text>}
            <Button title={t('confirm')} variant={ask === 'cancel' ? 'danger' : 'primary'} needsNetwork loading={act.busy} disabled={!comment.trim()} onPress={() => ask && run(ask, comment)} />
          </Sheet>
        </>
      ) : null}
    </Screen>
  );
}
