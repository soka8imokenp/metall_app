/**
 * CRM Э6 — отчёты (ТЗ 8: «отчёты по менеджерам, источникам, конверсии и
 * причинам отказов»).
 *
 * Четыре отчёта, одна таблица и две кнопки выгрузки — та же форма, что у
 * отчётов склада, и та же общая таблица: колонки и строки приходят с сервера,
 * экран их не пересобирает.
 *
 * Над таблицей — плашки с итогами. Их считает сервер, а не экран: сумма,
 * посчитанная по видимым пятистам строкам, разошлась бы с выгрузкой.
 *
 * Отдельно про воронку. Она считается по следу переходов, а не по текущей
 * стадии, и берёт сделки, заведённые в периоде. У свежей когорты конверсия
 * занижена — сделки ещё идут, — и экран говорит об этом строкой под
 * заголовком, а не молчит: по этим числам принимают решения о рекламе.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Download, FileSpreadsheet, Printer } from 'lucide-react';
import { apiClient, ApiError } from '../../lib/api-client';
import { errorText } from '../../context/DashboardContext';
import { useApp } from '../../context/AppContext';
import type { CrmReport, CrmReportKind, ReportFormat } from '../../types/api';
import { formatNumber } from '../../lib/formatters';
import { BTN_GHOST, CARD, Empty, ErrorBox, Skeleton } from './warehouse-ui';
import { CustomDatePicker } from '../common/CustomDatePicker';
import { ReportTable } from './ReportTable';

const KINDS: { key: CrmReportKind; ru: string; uz: string }[] = [
  { key: 'funnel', ru: 'Воронка и конверсия', uz: 'Voronka va konversiya' },
  { key: 'managers', ru: 'Менеджеры', uz: 'Menejerlar' },
  { key: 'sources', ru: 'Источники', uz: 'Manbalar' },
  { key: 'marks', ru: 'Метки сайта', uz: 'Sayt belgilari' },
  { key: 'lost-reasons', ru: 'Причины отказов', uz: 'Rad etish sabablari' },
];

/** Подписи к итоговым плашкам: какие числа приходят, зависит от отчёта. */
const TOTALS: Record<string, { ru: string; uz: string; money?: boolean; pct?: boolean }> = {
  entered: { ru: 'Вошло в воронку', uz: 'Voronkaga kirdi' },
  won: { ru: 'Заключено', uz: 'Tuzildi' },
  lost: { ru: 'Не состоялось', uz: 'Amalga oshmadi' },
  winRate: { ru: 'Доля побед', uz: 'Yutuq ulushi', pct: true },
  managers: { ru: 'Менеджеров', uz: 'Menejerlar' },
  deals: { ru: 'Сделок', uz: 'Bitimlar' },
  wonAmount: { ru: 'Сумма заключённых', uz: 'Tuzilganlar summasi', money: true },
  sources: { ru: 'Источников', uz: 'Manbalar' },
  marks: { ru: 'Сочетаний меток', uz: 'Belgilar juftligi' },
  firstLeads: { ru: 'По первому касанию', uz: 'Birinchi teginish bo‘yicha' },
  leads: { ru: 'Обращений', uz: 'Murojaatlar' },
  converted: { ru: 'Стали клиентами', uz: 'Mijoz bo‘ldi' },
  reasons: { ru: 'Причин', uz: 'Sabablar' },
  amount: { ru: 'Сумма', uz: 'Summa', money: true },
};

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date());
const shift = (days: number) => {
  const d = new Date(`${today()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export const CrmReports: React.FC = () => {
  const { locale, company } = useApp();
  const isUz = locale === 'uz';

  const [kind, setKind] = useState<CrmReportKind>('funnel');
  const [from, setFrom] = useState(shift(-90));
  const [to, setTo] = useState(today());
  const [data, setData] = useState<CrmReport | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [downloading, setDownloading] = useState<ReportFormat | null>(null);
  const [downloadError, setDownloadError] = useState<ApiError | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await apiClient.crm.report({ kind, from, to, limit: 500 });
      setData(res.data);
    } catch (e) {
      setData(null);
      setError(e as ApiError);
    }
  }, [kind, from, to, company]);

  useEffect(() => {
    void load();
  }, [load]);

  const download = async (format: ReportFormat) => {
    setDownloading(format);
    setDownloadError(null);
    try {
      const { blob, filename } = await apiClient.crm.downloadReport({ kind, format, from, to });
      // Ссылку создаём и тут же отзываем: без отзыва файл висит в памяти
      // вкладки до её закрытия.
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setDownloadError(e as ApiError);
    } finally {
      setDownloading(null);
    }
  };

  const rows = data?.rows ?? [];
  const totals = Object.entries(data?.totals ?? {}).filter(([k]) => TOTALS[k]);

  return (
    <div className={`${CARD} flex flex-col min-w-0`}>
      <div className="px-4 py-3 flex flex-col gap-2 border-b border-zinc-200 dark:border-zinc-800">
        <div className="flex flex-wrap items-center gap-1">
          {KINDS.map((k) => (
            <button
              key={k.key}
              type="button"
              aria-pressed={kind === k.key}
              onClick={() => setKind(k.key)}
              className={`h-7 px-2.5 rounded-lg border text-[11px] font-medium transition-colors cursor-pointer whitespace-nowrap ${
                kind === k.key
                  ? 'border-zinc-900 dark:border-zinc-100 bg-zinc-900 text-zinc-50 dark:bg-zinc-50 dark:text-zinc-900'
                  : 'border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800'
              }`}
            >
              {isUz ? k.uz : k.ru}
            </button>
          ))}
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <div className="flex-1 min-w-0">
              <CustomDatePicker
                portal
                value={from}
                onChange={setFrom}
                placeholder={isUz ? 'Sanadan' : 'Дата с'}
                ariaLabel={isUz ? 'Sanadan' : 'Дата с'}
              />
            </div>
            <span className="text-xs text-zinc-400">—</span>
            <div className="flex-1 min-w-0">
              <CustomDatePicker
                portal
                value={to}
                onChange={setTo}
                placeholder={isUz ? 'Sanagacha' : 'Дата по'}
                ariaLabel={isUz ? 'Sanagacha' : 'Дата по'}
              />
            </div>
          </div>

          <div className="flex items-center gap-2 sm:ms-auto">
            <button
              type="button"
              onClick={() => void download('xlsx')}
              disabled={downloading !== null || !data}
              className={BTN_GHOST + ' h-8 inline-flex items-center gap-1.5'}
            >
              <FileSpreadsheet className="w-3.5 h-3.5" />
              {downloading === 'xlsx' ? (isUz ? 'Yuklanmoqda…' : 'Готовлю…') : 'Excel'}
            </button>
            <button
              type="button"
              onClick={() => void download('csv')}
              disabled={downloading !== null || !data}
              className={BTN_GHOST + ' h-8 inline-flex items-center gap-1.5'}
            >
              <Download className="w-3.5 h-3.5" />
              {downloading === 'csv' ? (isUz ? 'Yuklanmoqda…' : 'Готовлю…') : 'CSV'}
            </button>
            {/*
              PDF — то, что печатают и подкладывают к делу. Он собирается
              дольше остальных: файл проходит через LibreOffice, поэтому
              подпись на кнопке меняется, пока идёт сборка.
            */}
            <button
              type="button"
              onClick={() => void download('pdf')}
              disabled={downloading !== null || !data}
              className={BTN_GHOST + ' h-8 inline-flex items-center gap-1.5'}
            >
              <Printer className="w-3.5 h-3.5" />
              {downloading === 'pdf' ? (isUz ? 'Yig‘ilmoqda…' : 'Собираю…') : 'PDF'}
            </button>
          </div>
        </div>

        {data && (
          <p className="text-[11px] text-zinc-500 break-words">
            {data.title}: {data.subtitle}
          </p>
        )}
        {data?.truncated && (
          <p className="text-[11px] text-amber-700 dark:text-amber-400 break-words">
            {isUz
              ? `Ekranda ${rows.length} qator, hammasi ${formatNumber(data.total)} — fayl to‘liq`
              : `На экране ${rows.length} из ${formatNumber(data.total)}: в файл уйдёт весь отчёт`}
          </p>
        )}
      </div>

      {totals.length > 0 && (
        <div className="px-4 py-3 grid grid-cols-2 lg:grid-cols-4 gap-3 border-b border-zinc-200 dark:border-zinc-800">
          {totals.map(([key, value]) => {
            const t = TOTALS[key]!;
            return (
              <div key={key} className="flex flex-col gap-0.5 min-w-0">
                <span className="text-[11px] text-zinc-500 break-words">
                  {isUz ? t.uz : t.ru}
                </span>
                <span className="text-xs font-mono tabular-nums text-zinc-900 dark:text-zinc-100 break-words">
                  {t.pct
                    ? `${formatNumber(value)} %`
                    : t.money
                      ? `${formatNumber(value)} UZS`
                      : formatNumber(value)}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {downloadError && (
        <div className="px-4 pt-3">
          <ErrorBox text={errorText(downloadError, isUz)} isUz={isUz} />
        </div>
      )}

      {error ? (
        <ErrorBox text={errorText(error, isUz)} onRetry={() => void load()} isUz={isUz} />
      ) : data === null ? (
        <Skeleton />
      ) : rows.length === 0 ? (
        <Empty text={isUz ? 'Bu davrda ko‘rsatadigan narsa yo‘q' : 'За этот период показывать нечего'} />
      ) : (
        <ReportTable columns={data.columns} rows={rows} />
      )}
    </div>
  );
};
