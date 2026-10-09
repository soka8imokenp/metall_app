import React, { useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect } from 'react';
import { Feather } from '@/ui/Icon';
import { useQueryClient } from '@tanstack/react-query';
import { ListScreen } from '@/ui/ListScreen';
import { Badge, Card, IconButton, Segmented, SearchBar, Appear } from '@/ui/components';
import { Text } from '@/ui/Text';
import { Pressable } from '@/ui/Pressable';
import { NewDocumentSheet } from '@/components/documents/NewDocumentSheet';
import { useApi, useApiFull } from '@/api/query';
import { useAuth } from '@/auth/AuthProvider';
import { useI18n } from '@/i18n';
import { useTheme } from '@/theme/ThemeProvider';
import { useDebounced } from '@/lib/hooks';
import { dateShort, money } from '@/lib/format';
import { DOC_STATUS } from '@/lib/status';

export default function Documents() {
  const { t, pick } = useI18n();
  const { colors } = useTheme();
  const { can } = useAuth();
  const router = useRouter();
  const qc = useQueryClient();
  const [status, setStatus] = useState<string>(can('documents.approve') ? 'pending_approval' : 'all');
  const [search, setSearch] = useState('');
  const [create, setCreate] = useState(false);
  const q = useDebounced(search, 350);
  const params = useLocalSearchParams<{ new?: string }>();
  useEffect(() => { if (params.new) setCreate(true); }, [params.new]);
  const list = useApiFull<{ rows: any[]; byStatus?: Record<string, number> } | any>('/documents', { status: status === 'all' ? undefined : status, search: q || undefined, limit: 60 });
  const body: any = list.data?.data;
  const by = body?.byStatus ?? {};

  const metrics = [
    { label: t('dcStPending'), value: String(by.pending_approval ?? 0), sub: undefined as string | undefined, action: can('documents.edit') ? { label: t('dcNewShort'), onPress: () => setCreate(true) } : undefined },
    { label: t('dcStApproved'), value: String(by.approved ?? 0), sub: `${by.signed ?? 0} · ${t('dcStSigned').toLowerCase()}` },
  ];

  const header = (
    <View>
      <Segmented
        options={[
          { value: 'pending_approval', label: t('dcStPending'), count: by.pending_approval },
          { value: 'approved', label: t('dcStApproved'), count: by.approved },
          { value: 'signed', label: t('dcStSigned'), count: by.signed },
          { value: 'draft', label: t('dcStDraft'), count: by.draft },
          { value: 'returned', label: t('dcStReturned'), count: by.returned },
          { value: 'all', label: t('all') },
        ]}
        value={status}
        onChange={setStatus}
      />
      <SearchBar value={search} onChange={setSearch} placeholder={t('search')} />
    </View>
  );

  return (
    <>
      <ListScreen<any>
        title={t('tabDocuments')}
        right={
          can('documents.edit') ? <IconButton name="plus" solid onPress={() => setCreate(true)} />: undefined
        }
        header={header}
        metrics={metrics}
        animKey={status}
        data={body?.rows}
        keyExtractor={(r) => r.uid}
        loading={list.isLoading}
        error={list.error?.message}
        onRetry={() => list.refetch()}
        onRefresh={() => qc.invalidateQueries({ queryKey: ['apiFull'] })}
        refreshing={list.isRefetching}
        emptyTitle={t('dcNoDocs')}
        emptyIcon="file-text"
        renderItem={(r, i) => {
          const [k, tone] = DOC_STATUS[r.status] ?? ['dcStDraft', 'neutral'];
          return (
            <>
              <Card onPress={() => router.push(`/documents/${r.uid}`)} style={{ gap: 8 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text variant="headline">{r.number}</Text>
                  <Badge label={t(k)} tone={tone} />
                </View>
                <Text variant="callout" tone="secondary" numberOfLines={1}>{pick(r.type, 'name')}</Text>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                  <Text variant="caption" tone="secondary" numberOfLines={1} style={{ flex: 1 }}>{r.partner?.name ?? '—'} · {dateShort(r.documentDate)}</Text>
                  <Text variant="callout" num style={{ fontWeight: '700' }}>{money(r.amountTotal, r.currency)}</Text>
                </View>
              </Card>
            </>
          );
        }}
      />
      <NewDocumentSheet visible={create} onClose={() => setCreate(false)} onCreated={(uid) => uid && router.push(`/documents/${uid}`)} />
    </>
  );
}
