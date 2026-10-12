import React, { useMemo, useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { Button, Card, Divider, EmptyState, ErrorState, KV, Screen, Section, Segmented, Skeleton, Appear } from '@/ui/components';
import { Text } from '@/ui/Text';
import { useApi } from '@/api/query';
import { useAuth } from '@/auth/AuthProvider';
import { useI18n } from '@/i18n';
import { useToast } from '@/ui/Toast';
import { useOnline } from '@/lib/network';
import { openRemoteFile } from '@/lib/files';
import { num } from '@/lib/format';
import type { Dict } from '@/i18n/ru';

type Kind = 'cashflow' | 'balances' | 'receivables' | 'payables' | 'plan-fact' | 'pnl' | 'margin' | 'summary';
const KINDS: { kind: Kind; label: keyof Dict; dated: boolean; profit?: boolean }[] = [
  { kind: 'summary', label: 'rpSummary', dated: true, profit: true },
  { kind: 'cashflow', label: 'rpCashflow', dated: true },
  { kind: 'balances', label: 'rpBalances', dated: false },
  { kind: 'receivables', label: 'rpReceivables', dated: false },
  { kind: 'payables', label: 'rpPayables', dated: false },
  { kind: 'plan-fact', label: 'rpPlanFact', dated: true },
  { kind: 'pnl', label: 'rpPnl', dated: true, profit: true },
  { kind: 'margin', label: 'rpMargin', dated: true, profit: true },
];

type Report = { title: string; subtitle: string; columns: { title: string; numeric?: boolean }[]; rows: unknown[][]; total: number; truncated: boolean; totals: Record<string, number> };

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Число в отчёте: суммы — с разрядами, дроби — до двух знаков. */
const cell = (v: unknown, numeric?: boolean) => {
  if (v === null || v === undefined || v === '') return '—';
  if (numeric || typeof v === 'number') return num(v as number, Math.abs(Number(v)) >= 1000 ? 0 : 2);
  return String(v);
};

/**
 * Финансовые отчёты (ТЗ 10: «просмотр разрешённых отчётов»). Те же отчёты,
 * что в вебе, — сервер отдаёт их одной формой: колонки, строки, итоги. На
 * телефоне строка — карточка: первая колонка заголовком, остальные под ним.
 * Отчёты о прибыли видны только с правом `finance.profit.view` (правило 16).
 */
export default function FinanceReports() {
  const router = useRouter();
  const qc = useQueryClient();
  const { t, locale } = useI18n();
  const { can } = useAuth();
  const toast = useToast();
  const online = useOnline();
  const kinds = KINDS.filter((k) => !k.profit || can('finance.profit.view'));
  const [kind, setKind] = useState<Kind>(kinds[0]?.kind ?? 'cashflow');
  const [period, setPeriod] = useState<'30' | 'q' | 'y'>('30');
  const meta = KINDS.find((k) => k.kind === kind)!;

  const range = useMemo(() => {
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - (period === '30' ? 30 : period === 'q' ? 91 : 365));
    return { from: iso(from), to: iso(to) };
  }, [period]);

  const q = useApi<Report>(`/finance/reports/${kind}`, meta.dated ? { ...range, limit: 200 } : { limit: 200 });
  const r = q.data;

  const download = async (format: 'xlsx' | 'pdf') => {
    if (!online) return toast.show(t('needsNetwork'), 'error');
    const qs = new URLSearchParams({ format, ...(meta.dated ? range : {}) }).toString();
    try {
      await openRemoteFile(`/finance/reports/${kind}/file?${qs}`, `${kind}.${format}`);
    } catch {
      toast.show(t('dcOpenFail'), 'error');
    }
  };

  return (
    <Screen title={t('rpTitle')} back={() => router.back()} padBottom={false} onRefresh={() => qc.invalidateQueries({ queryKey: ['api'] })} refreshing={q.isRefetching}>
      <Segmented options={kinds.map((k) => ({ value: k.kind, label: t(k.label) }))} value={kind} onChange={setKind} />
      {meta.dated && (
        <Segmented options={[{ value: '30', label: t('rp30') }, { value: 'q', label: t('rpQuarter') }, { value: 'y', label: t('rpYear') }]} value={period} onChange={setPeriod} />
      )}

      {q.isLoading ? (
        <View style={{ paddingHorizontal: 20, gap: 14 }}><Skeleton h={120} r={20} /><Skeleton h={90} r={20} /><Skeleton h={90} r={20} /></View>
      ) : q.error ? (
        <ErrorState message={q.error.message} onRetry={() => q.refetch()} />
      ) : r ? (
        <>
          <Section>
            <Card style={{ gap: 4 }}>
              <Text variant="headline" style={{ fontWeight: '700' }}>{r.title}</Text>
              <Text variant="caption" tone="secondary">{r.subtitle}</Text>
              {Object.keys(r.totals ?? {}).length > 0 && <Divider />}
              {Object.entries(r.totals ?? {}).map(([k, v]) => (
                <KV key={k} k={totalLabel(k, locale)} v={cell(v, true)} strong={k === 'net' || k === 'margin' || k === 'operating'} />
              ))}
            </Card>
          </Section>

          <Section title={`${r.total}`} right={
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Button size="sm" variant="secondary" icon="file-text" title="Excel" onPress={() => void download('xlsx')} />
              <Button size="sm" variant="secondary" icon="file" title="PDF" onPress={() => void download('pdf')} />
            </View>
          } style={{ marginBottom: 40 }}>
            {r.rows.length === 0 ? (
              <EmptyState icon="layers" title={t('rpEmpty')} />
            ) : (
              <View style={{ gap: 14 }}>
                {r.rows.slice(0, 100).map((row, i) => (
                  <Appear key={i} i={i}>
                    <Card style={{ gap: 2 }}>
                      <Text variant="headline" style={{ fontWeight: '700', marginBottom: 4 }} numberOfLines={2}>{cell(row[0], r.columns[0]?.numeric)}</Text>
                      {r.columns.slice(1).map((c, j) => (
                        <KV key={j} k={c.title} v={cell(row[j + 1], c.numeric)} strong={c.numeric && j === r.columns.length - 2} />
                      ))}
                    </Card>
                  </Appear>
                ))}
                {(r.truncated || r.rows.length > 100) && <Text variant="caption" tone="muted" style={{ textAlign: 'center' }}>{t('rpTruncated')}</Text>}
              </View>
            )}
          </Section>
        </>
      ) : null}
    </Screen>
  );
}

/** Подписи итогов: ключи сервера → слова на языке человека. */
const TOTALS: Record<string, [string, string]> = {
  inflow: ['Поступило', 'Kirim'], outflow: ['Выбыло', 'Chiqim'], net: ['Итог', 'Natija'], ops: ['Операций', 'Operatsiyalar'],
  saldo: ['Остаток', 'Qoldiq'], accounts: ['Счетов', 'Hisoblar'], debt: ['Долг', 'Qarz'], overdue: ['Просрочено', 'Muddati o‘tgan'],
  partners: ['Контрагентов', 'Kontragentlar'], advance: ['Аванс', 'Avans'], plan: ['План', 'Reja'], fact: ['Факт', 'Fakt'],
  deviation: ['Отклонение', 'Og‘ish'], warn: ['Близко к лимиту', 'Limitga yaqin'], over: ['Превышено', 'Oshib ketgan'],
  revenue: ['Выручка', 'Tushum'], cost: ['Себестоимость', 'Tannarx'], gross: ['Валовая прибыль', 'Yalpi foyda'],
  expenses: ['Расходы', 'Xarajatlar'], operating: ['Операционная прибыль', 'Operatsion foyda'], margin: ['Маржа', 'Marja'],
  rate: ['Маржа, %', 'Marja, %'], receivables: ['Дебиторка', 'Debitorlik'], payables: ['Кредиторка', 'Kreditorlik'],
};
const totalLabel = (k: string, locale: string) => TOTALS[k]?.[locale === 'uz' ? 1 : 0] ?? k;
