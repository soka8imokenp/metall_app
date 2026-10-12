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

type Day = { date: string; label: string; value: number };
const PERIODS = [7, 14, 30] as const;

/**
 * Выручка по дням — сумма заказов клиентов по дате оформления (как на
 * главной веб-платформы). Дни идут подряд, включая пустые: пропуск дня
 * без продаж — тоже информация. Пунктир — средняя за период; сверху —
 * выбранный день полной датой, итог и среднее.
 */
function RevenueChart({ days }: { days: Day[] }) {
  const { colors } = useTheme();
  const { t, locale } = useI18n();
  const [period, setPeriod] = useState<(typeof PERIODS)[number]>(14);
  const pts = days.slice(-period);
  const lastWith = (() => { for (let i = pts.length - 1; i >= 0; i--) if (pts[i].value > 0) return i; return pts.length - 1; })();
  const [sel, setSel] = useState<number | null>(null);
  const idx = sel !== null && sel < pts.length ? sel : lastWith;
  const cur = pts[idx];
  const max = Math.max(1e-9, ...pts.map((p) => p.value));
  const total = pts.reduce((a, p) => a + p.value, 0);
  const avg = total / Math.max(1, pts.length);
  const H = 132;
  const gap = period === 30 ? 3 : period === 14 ? 5 : 8;
  const fullDate = (iso: string) => new Date(iso + 'T00:00:00').toLocaleDateString(locale === 'uz' ? 'uz-UZ' : 'ru-RU', { day: 'numeric', month: 'long', weekday: 'short' });
  const dayNum = (iso: string) => Number(iso.slice(8, 10));
  const showLabel = (i: number) => period !== 30 || ((i === 0 || i === pts.length - 1 || dayNum(pts[i].date) % 5 === 0) && Math.abs(i - idx) > 1);

  return (
    <Card style={{ padding: 18, gap: 14 }}>
      {/* период */}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text style={{ fontSize: 10.5, letterSpacing: 0.9, textTransform: 'uppercase', fontWeight: '700', color: colors.textMuted }}>{t('rvByOrders')}</Text>
        <View style={[{ flexDirection: 'row', padding: 3, borderRadius: 12, backgroundColor: colors.card }, neu(colors, 'insetSm')]}>
          {PERIODS.map((p) => (
            <Pressable key={p} onPress={() => { setPeriod(p); setSel(null); }} scaleTo={0.95} haptic={p !== period} style={[{ paddingHorizontal: 10, height: 26, borderRadius: 9, justifyContent: 'center' }, p === period ? [{ backgroundColor: colors.card }, neu(colors, 'raisedSm')] : null]}>
              <Text variant="caption" num style={{ fontWeight: p === period ? '700' : '500', color: p === period ? colors.text : colors.textMuted }}>{p} {t('rvDays')}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      {/* выбранный день */}
      <View style={{ gap: 2 }}>
        <Text variant="callout" tone="secondary">{cur ? fullDate(cur.date) : ''}</Text>
        <Text num style={{ fontSize: 28, lineHeight: 34, fontWeight: '700', letterSpacing: -0.9, color: cur && cur.value > 0 ? colors.text : colors.textMuted }}>
          {cur && cur.value > 0 ? money(cur.value * 1e9) : t('rvNoSales')}
        </Text>
      </View>

      {/* столбики дней подряд; пунктир — среднее */}
      <View style={{ height: H + 20 }}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: H, gap }}>
          {pts.map((p, i) => {
            const on = i === idx;
            const h = p.value > 0 ? Math.max(0.05, p.value / max) : 0;
            const weekend = [0, 6].includes(new Date(p.date + 'T00:00:00').getDay());
            return (
              <Pressable key={p.date} onPress={() => setSel(i)} scaleTo={0.94} haptic={!on} style={{ flex: 1, height: H, justifyContent: 'flex-end' }}>
                <View style={[{ height: H, borderRadius: period === 30 ? 4 : 9, backgroundColor: colors.card, justifyContent: 'flex-end', padding: period === 30 ? 1.5 : 3, opacity: weekend && !on ? 0.75 : 1 }, neu(colors, 'insetSm')]}>
                  {h > 0 ? (
                    <View style={{ height: `${h * 100}%`, borderRadius: period === 30 ? 3 : 7, backgroundColor: on ? colors.brand : colors.isDark ? '#4a4f5b' : '#b9bec9' }} />
                  ) : (
                    <View style={{ alignSelf: 'center', width: 3, height: 3, borderRadius: 2, backgroundColor: on ? colors.brand : colors.textMuted, marginBottom: 2, opacity: 0.6 }} />
                  )}
                </View>
              </Pressable>
            );
          })}
        </View>
        {avg > 0 && (
          <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, bottom: 20 + Math.min(1, avg / max) * (H - 6) + 3, borderTopWidth: 1, borderStyle: 'dashed', borderColor: colors.brand, opacity: 0.55 }} />
        )}
        <View style={{ flexDirection: 'row', gap, marginTop: 6 }}>
          {pts.map((p, i) => (
            // подпись шире узкой колонки (30 дней) — выходит за её края, а не обрезается
            <View key={p.date} style={{ flex: 1, alignItems: 'center', height: 14 }}>
              {(showLabel(i) || i === idx) && (
                <Text variant="caption" num style={{ position: 'absolute', width: 28, textAlign: 'center', fontSize: 10.5, fontWeight: i === idx ? '700' : '500', color: i === idx ? colors.text : colors.textMuted }}>
                  {dayNum(p.date)}
                </Text>
              )}
            </View>
          ))}
        </View>
      </View>

      {/* итог периода */}
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ fontSize: 10.5, letterSpacing: 0.9, textTransform: 'uppercase', fontWeight: '600', color: colors.textMuted }}>{t('rvTotal')} · {period} {t('rvDays')}</Text>
          <Text variant="callout" num style={{ fontWeight: '700' }}>{money(total * 1e9)}</Text>
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <View style={{ width: 14, borderTopWidth: 1, borderStyle: 'dashed', borderColor: colors.brand }} />
            <Text style={{ fontSize: 10.5, letterSpacing: 0.9, textTransform: 'uppercase', fontWeight: '600', color: colors.textMuted }}>{t('rvAvg')}</Text>
          </View>
          <Text variant="callout" num style={{ fontWeight: '700' }}>{money(avg * 1e9)}</Text>
        </View>
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
  const days: Day[] = useMemo(
    () => (dash.data?.chart ?? []).map((c: any) => ({ date: String(c.date).slice(0, 10), label: locale === 'uz' ? c.displayDateUz : c.displayDateRu, value: Number(c.totalRevenue) || 0 })),
    [dash.data, locale],
  );

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

      {days.length >= 7 && (
        <Section title={t('weekRevenue')}>
          <Appear i={2}><RevenueChart days={days} /></Appear>
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
