import React, { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { PipeRings } from '@/ui/Steel';
import { useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { Appear, Card, Screen, Section, Skeleton, neu } from '@/ui/components';
import { Feather, IconName } from '@/ui/Icon';
import { Text } from '@/ui/Text';
import { Pressable } from '@/ui/Pressable';
import { BandButton, Metric } from '@/ui/Band';
import { useAuth } from '@/auth/AuthProvider';
import { useI18n } from '@/i18n';
import { useTheme } from '@/theme/ThemeProvider';
import { useApi, useApiFull } from '@/api/query';
import { num, money } from '@/lib/format';

type Kpi = { key: string; value: string; unit: string; deltaPercent: string | null; isPositive: boolean; targetModule?: string } & Record<string, any>;

/** Плитка-показатель: крупное число и подпись. */
function StatTile({ value, label, caption, onPress, tone }: { value: string | number; label: string; caption: string; onPress: () => void; tone?: 'danger' }) {
  const { colors } = useTheme();
  return (
    <Card onPress={onPress} style={{ flex: 1, padding: 18, minHeight: 112, justifyContent: 'space-between', overflow: 'hidden' }}>
      <PipeRings size={96} color={tone === 'danger' ? colors.brand : colors.text} opacity={tone === 'danger' ? 0.14 : 0.07} style={{ right: -26, bottom: -26 }} />
      <Text variant="caption" tone="muted" style={{ fontSize: 11, letterSpacing: 0.9, textTransform: 'uppercase', fontWeight: '600' }} numberOfLines={1}>{caption}</Text>
      <View>
        <Text num style={{ fontSize: 34, lineHeight: 40, letterSpacing: -1.4, fontWeight: '700', color: tone === 'danger' ? colors.brand : colors.text }}>{value}</Text>
        <Text variant="callout" tone="secondary" style={{ fontWeight: '500' }} numberOfLines={1}>{label}</Text>
      </View>
    </Card>
  );
}

/** Плитка-действие: вдавленная лунка с иконкой и выпуклая тёмная кнопка «+». */
function ActionTile({ icon, label, caption, onPress }: { icon: IconName; label: string; caption: string; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Card onPress={onPress} style={{ flex: 1, padding: 16, minHeight: 124, justifyContent: 'space-between' }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <View style={[{ width: 46, height: 46, borderRadius: 23, backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center' }, neu(colors, 'insetSm')]}>
          <Feather name={icon} size={21} color={colors.text} strokeWidth={1.8} />
        </View>
        <View style={[{ width: 34, height: 34, borderRadius: 17, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }, neu(colors, 'raisedSm')]}>
          <LinearGradient colors={['#3a3e48', '#16181d']} start={{ x: 0.2, y: 0 }} end={{ x: 0.8, y: 1 }} style={StyleSheet.absoluteFill} />
          <View><Feather name="plus" size={16} color="#fff" strokeWidth={2.4} /></View>
        </View>
      </View>
      <View>
        <Text variant="caption" tone="muted" style={{ fontSize: 10.5, letterSpacing: 0.9, textTransform: 'uppercase', fontWeight: '600' }} numberOfLines={1}>{caption}</Text>
        <Text variant="headline" style={{ fontSize: 15.5, fontWeight: '700' }} numberOfLines={1}>{label}</Text>
      </View>
    </Card>
  );
}

/** Выручка по дням: вдавленные дорожки, заполненные тёмным столбиком; выбранный день — красный. */
function WeekBars({ points }: { points: { label: string; value: number }[] }) {
  const { colors } = useTheme();
  const { t } = useI18n();
  const [sel, setSel] = useState(points.length - 1);
  const max = Math.max(1, ...points.map((p) => p.value));
  const cur = points[sel];
  return (
    <Card style={{ padding: 18, gap: 16 }}>
      <View style={{ alignItems: 'center', gap: 2 }}>
        <Text variant="callout" tone="secondary">{t('kpiRevenue')} · <Text variant="callout" style={{ fontWeight: '700' }}>{cur?.label}</Text></Text>
        <Text num style={{ fontSize: 26, lineHeight: 32, fontWeight: '700', letterSpacing: -0.8, color: colors.text }}>{num(cur?.value ?? 0, 2)} <Text variant="body" tone="secondary">{t('bln')}</Text></Text>
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
        {points.map((p, i) => {
          const on = i === sel;
          const h = Math.max(0.06, p.value / max);
          return (
            <Pressable key={p.label + i} onPress={() => setSel(i)} scaleTo={0.96} style={{ flex: 1, alignItems: 'center', gap: 8 }}>
              <View style={[{ width: '100%', maxWidth: 34, height: 120, borderRadius: 12, backgroundColor: colors.card, justifyContent: 'flex-end', padding: 4 }, neu(colors, 'insetSm')]}>
                <View style={[{ height: `${h * 100}%`, borderRadius: 9, backgroundColor: on ? colors.brand : colors.isDark ? '#3a3e48' : '#c9cdd6' }, on ? neu(colors, 'raisedSm') : null]} />
              </View>
              <Text variant="caption" style={{ fontSize: 11, fontWeight: on ? '700' : '500', color: on ? colors.text : colors.textMuted }}>{p.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </Card>
  );
}

export default function Home() {
  const { can } = useAuth();
  const { t, pick, locale } = useI18n();
  const { colors } = useTheme();
  const router = useRouter();
  const qc = useQueryClient();

  const dash = useApi<{ kpis: Kpi[]; chart: any[] }>(can('dashboard.view') ? '/dashboard/summary' : null);
  const wh = useApi<any>(can('warehouse.view') ? '/warehouse/summary' : null);
  const fin = useApiFull<any>(can('finance.approve') ? '/finance/operations' : null, { status: 'pending_approval', limit: 4 });
  const docs = useApiFull<any>(can('documents.approve') ? '/documents' : null, { status: 'pending_approval', limit: 4 });
  const stages = useApi<{ rows: any[] }>(can('production.view') ? '/production/my-stages' : null, { limit: 20 });
  const prod = useApi<any>(can('production.view') ? '/production/summary' : null);

  const refresh = () => qc.invalidateQueries({ queryKey: ['api'] }).then(() => qc.invalidateQueries({ queryKey: ['apiFull'] }));

  const finRows: any[] = Array.isArray(fin.data?.data) ? fin.data!.data : fin.data?.data?.rows ?? [];
  const finTotal = fin.data?.meta?.total ?? finRows.length;
  const docRows: any[] = docs.data?.data?.rows ?? [];
  const docTotal = docs.data?.data?.byStatus?.pending_approval ?? docRows.length;
  const minCount = wh.data?.levels?.belowMin ?? 0;
  const stRows = stages.data?.rows ?? [];

  /* шапка */
  const k = dash.data?.kpis ?? [];
  const quick = (a: 'order' | 'payment' | 'receipt') =>
    a === 'order' ? { label: t('slOrderShort'), onPress: () => router.navigate('/(tabs)/sales?new=1' as any) }
    : a === 'payment' ? { label: t('fnPaymentShort'), onPress: () => router.navigate('/(tabs)/finance?new=1' as any) }
    : { label: t('opReceipt'), onPress: () => router.navigate('/(tabs)/warehouse?new=1' as any) };
  const act1 = can('sales.edit') ? quick('order') : can('warehouse.move') ? quick('receipt') : undefined;
  const act2 = can('finance.post') ? quick('payment') : can('warehouse.move') && act1?.label !== t('opReceipt') ? quick('receipt') : undefined;
  const metrics: Metric[] | undefined = k.length >= 2
    ? [
        { label: k[0].key === 'revenue' ? t('kpiRevenue') : pick(k[0], 'title'), value: num(k[0].value, 1), sub: k[0].unit, action: act1 },
        { label: k[1].key.includes('ship') ? t('kpiShipped') : pick(k[1], 'title'), value: num(k[1].value, 1), sub: k[1].unit, action: act2 },
      ]
    : undefined;

  /* плитки */
  const approvals = (can('finance.approve') ? finTotal : 0) + (can('documents.approve') ? docTotal : 0);
  const stats: { value: number | string; label: string; caption: string; to: string; tone?: 'danger' }[] = [];
  if (can('finance.approve') || can('documents.approve')) stats.push({ value: approvals, label: t('statApprovals'), caption: t('today'), to: can('finance.approve') ? '/(tabs)/finance' : '/(tabs)/documents' });
  if (can('warehouse.view')) stats.push({ value: minCount, label: t('whBelowMin'), caption: t('tabWarehouse'), to: '/(tabs)/warehouse', tone: minCount ? 'danger' : undefined });
  if (can('production.view')) stats.push({ value: stRows.length || (prod.data?.orders?.inProgress ?? 0), label: stRows.length ? t('prMyStages') : t('prActive'), caption: t('tabProduction'), to: '/(tabs)/production?tab=' + (stRows.length ? 'mine' : 'orders') });
  const tiles = stats.slice(0, 2);

  const actions: { icon: IconName; label: string; caption: string; onPress: () => void }[] = [];
  if (can('warehouse.view')) actions.push({ icon: 'maximize', label: t('whScan'), caption: t('tabWarehouse'), onPress: () => router.push('/scan') });
  if (can('sales.edit')) actions.push({ icon: 'shopping-bag', label: t('slNew'), caption: t('tabSales'), onPress: () => router.navigate('/(tabs)/sales?new=1' as any) });
  else if (can('finance.post')) actions.push({ icon: 'credit-card', label: t('fnNew'), caption: t('tabFinance'), onPress: () => router.navigate('/(tabs)/finance?new=1' as any) });
  else if (can('warehouse.move')) actions.push({ icon: 'repeat', label: t('whNewMove'), caption: t('tabWarehouse'), onPress: () => router.navigate('/(tabs)/warehouse?new=1' as any) });
  if (actions.length < 2 && can('documents.edit')) actions.push({ icon: 'file-text', label: t('dcNew'), caption: t('tabDocuments'), onPress: () => router.navigate('/(tabs)/documents?new=1' as any) });

  /* неделя */
  const week = useMemo(() => {
    const rows = (dash.data?.chart ?? []).filter((c: any) => Number(c.totalRevenue) > 0).slice(-6);
    return rows.map((c: any) => ({ label: String(locale === 'uz' ? c.displayDateUz : c.displayDateRu).split(' ')[0], value: Number(c.totalRevenue) }));
  }, [dash.data, locale]);

  /* задачи */
  type Task = { id: string; icon: IconName; tag: string; title: string; right?: string; to: string; tone: 'danger' | 'neutral' };
  const tasks: Task[] = [
    ...finRows.slice(0, 3).map((o) => ({ id: o.uid, icon: 'arrow-up-right' as IconName, tag: `${t('tabFinance')} · ${o.number}`, title: o.cashflowItem ? pick(o.cashflowItem, 'name') : o.number, right: `−${money(o.amount, o.currency)}`, to: `/finance/${o.uid}`, tone: 'danger' as const })),
    ...docRows.slice(0, 3).map((d) => ({ id: d.uid, icon: 'file-text' as IconName, tag: `${t('tabDocuments')} · ${d.number}`, title: pick(d.type, 'name'), right: money(d.amountTotal, d.currency), to: `/documents/${d.uid}`, tone: 'neutral' as const })),
    ...stRows.slice(0, 3).map((s) => ({ id: `${s.orderUid}-${s.seq}`, icon: 'tool' as IconName, tag: s.orderNumber, title: pick(s, 'name'), right: undefined, to: `/production/${s.orderUid}`, tone: 'neutral' as const })),
  ].slice(0, 6);

  return (
    <Screen
      title="METALL ASIA"
      wordmark
      metrics={metrics}
      right={can('warehouse.view') ? <BandButton name="maximize" onPress={() => router.push('/scan')} /> : undefined}
      onRefresh={refresh}
      refreshing={dash.isRefetching || wh.isRefetching}
    >
      <View style={{ paddingHorizontal: 20, gap: 18, marginBottom: 30 }}>
        {dash.isLoading && can('dashboard.view') ? (
          <>
            <Skeleton h={112} r={20} />
            <Skeleton h={124} r={20} />
          </>
        ) : (
          <>
            {tiles.length > 0 && (
              <Appear i={0} style={{ flexDirection: 'row', gap: 16 }}>
                {tiles.map((s) => <StatTile key={s.label} value={s.value} label={s.label} caption={s.caption} tone={s.tone} onPress={() => router.navigate(s.to as any)} />)}
                {tiles.length === 1 && <View style={{ flex: 1 }} />}
              </Appear>
            )}
            {actions.length > 0 && (
              <Appear i={1} style={{ flexDirection: 'row', gap: 16 }}>
                {actions.slice(0, 2).map((a) => <ActionTile key={a.label} {...a} />)}
                {actions.length === 1 && <View style={{ flex: 1 }} />}
              </Appear>
            )}
          </>
        )}
      </View>

      {week.length >= 3 && (
        <Section title={t('weekRevenue')}>
          <Appear i={2}><WeekBars points={week} /></Appear>
        </Section>
      )}

      {tasks.length > 0 && (
        <Section title={t('tasksToday')} style={{ marginBottom: 8 }}>
          <View style={{ gap: 14 }}>
            {tasks.map((x, i) => (
              <Appear key={x.id} i={i + 3}>
                <Card onPress={() => router.push(x.to as any)} style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 14, paddingHorizontal: 14 }}>
                  <View style={[{ width: 44, height: 44, borderRadius: 22, backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center' }, neu(colors, 'insetSm')]}>
                    <Feather name={x.icon} size={19} color={x.tone === 'danger' ? colors.brand : colors.text} strokeWidth={2} />
                  </View>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text variant="headline" style={{ fontSize: 14.5, fontWeight: '700' }} numberOfLines={1}>{x.title}</Text>
                    <Text variant="caption" tone="muted" numberOfLines={1}>{x.tag}</Text>
                  </View>
                  {!!x.right && <Text variant="callout" num style={{ fontWeight: '700', color: x.tone === 'danger' ? colors.brand : colors.text }}>{x.right}</Text>}
                </Card>
              </Appear>
            ))}
          </View>
        </Section>
      )}
    </Screen>
  );
}
