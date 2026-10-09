/**
 * Отчёты склада и выгрузка (ТЗ 5.1).
 *
 * Пять отчётов из ТЗ, одна таблица и две кнопки выгрузки. Таблицу рисует то
 * же, что уходит в файл: колонки и строки приходят с сервера, экран их не
 * пересобирает. Иначе на экране одно, а в Excel другое — и спорить об этом
 * придётся с клиентом, а не между собой.
 *
 * На экран приходят первые пятьсот строк: отчёт смотрят, чтобы убедиться, что
 * выгружается то самое. Обрезанный отчёт говорит об этом вслух — молча
 * показанная половина хуже, чем её отсутствие.
 *
 * Период спрашивается не у всех: остатки и доступность отвечают на вопрос
 * «что сейчас», и поля дат у них только сбивали бы с толку.
 */

import React from 'react';
import { Download, FileSpreadsheet, Printer } from 'lucide-react';
import { errorText } from '../../context/DashboardContext';
import { useWarehouse } from '../../context/WarehouseContext';
import type { WarehouseReportKind } from '../../types/api';
import { formatNumber } from '../../lib/formatters';
import { BTN_GHOST, Empty, ErrorBox, Skeleton } from './warehouse-ui';
import { CustomDatePicker } from '../common/CustomDatePicker';
import { ReportTable } from './ReportTable';

const KINDS: { key: WarehouseReportKind; ru: string; uz: string; period: boolean }[] = [
  { key: 'stock', ru: 'Остатки', uz: 'Qoldiqlar', period: false },
  { key: 'moves', ru: 'Движение', uz: 'Harakat', period: true },
  {
    key: 'availability',
    ru: 'Доступное и зарезервированное',
    uz: 'Mavjud va zaxiradagi',
    period: false,
  },
  { key: 'turnover', ru: 'Оборачиваемость', uz: 'Aylanuvchanlik', period: true },
  {
    key: 'inventory-diff',
    ru: 'Расхождения инвентаризации',
    uz: 'Inventarizatsiya farqlari',
    period: true,
  },
];

export const ReportsPanel: React.FC<{ isUz: boolean }> = ({ isUz }) => {
  const {
    reportKind,
    setReportKind,
    reportFrom,
    reportTo,
    setReportPeriod,
    report,
    reloadReport,
    downloadReport,
    downloading,
    downloadError,
  } = useWarehouse();

  const current = KINDS.find((k) => k.key === reportKind)!;
  const data = report.data;
  const columns = data?.columns ?? [];
  const rows = data?.rows ?? [];

  return (
    <div
      role="tabpanel"
      aria-label={isUz ? 'Hisobotlar' : 'Отчёты'}
      className="flex flex-col min-w-0"
    >
      <div className="px-4 py-3 flex flex-col gap-2 border-b border-zinc-200 dark:border-zinc-800">
        <div className="flex flex-wrap items-center gap-1">
          {KINDS.map((k) => (
            <button
              key={k.key}
              type="button"
              aria-pressed={reportKind === k.key}
              onClick={() => setReportKind(k.key)}
              className={`h-7 px-2.5 rounded-lg border text-[11px] font-medium transition-colors cursor-pointer ${
                reportKind === k.key
                  ? 'border-zinc-900 dark:border-zinc-100 bg-zinc-900 text-zinc-50 dark:bg-zinc-50 dark:text-zinc-900'
                  : 'border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800'
              }`}
            >
              {isUz ? k.uz : k.ru}
            </button>
          ))}
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center gap-2">
          {/* Период — только у тех отчётов, у которых он есть смысл. */}
          {current.period && (
            <div className="flex items-center gap-2 min-w-0">
              <div className="flex-1 min-w-0">
                <CustomDatePicker
                  portal
                  value={reportFrom}
                  onChange={(v) => setReportPeriod(v, reportTo)}
                  placeholder={isUz ? 'Sanadan' : 'Дата с'}
                  ariaLabel={isUz ? 'Sanadan' : 'Дата с'}
                />
              </div>
              <span className="text-xs text-zinc-400">—</span>
              <div className="flex-1 min-w-0">
                <CustomDatePicker
                  portal
                  value={reportTo}
                  onChange={(v) => setReportPeriod(reportFrom, v)}
                  placeholder={isUz ? 'Sanagacha' : 'Дата по'}
                  ariaLabel={isUz ? 'Sanagacha' : 'Дата по'}
                />
              </div>
            </div>
          )}

          <div className="flex items-center gap-2 sm:ml-auto">
            <button
              type="button"
              onClick={() => downloadReport('xlsx')}
              disabled={downloading !== null || !data}
              className={BTN_GHOST + ' h-8 inline-flex items-center gap-1.5'}
            >
              <FileSpreadsheet className="w-3.5 h-3.5" />
              {downloading === 'xlsx' ? (isUz ? 'Yuklanmoqda…' : 'Готовлю…') : 'Excel'}
            </button>
            <button
              type="button"
              onClick={() => downloadReport('csv')}
              disabled={downloading !== null || !data}
              className={BTN_GHOST + ' h-8 inline-flex items-center gap-1.5'}
            >
              <Download className="w-3.5 h-3.5" />
              {downloading === 'csv' ? (isUz ? 'Yuklanmoqda…' : 'Готовлю…') : 'CSV'}
            </button>
            {/*
              PDF — то, что печатают и подкладывают к делу. Собирается дольше
              остальных: файл проходит через LibreOffice, поэтому подпись на
              кнопке меняется, пока идёт сборка.
            */}
            <button
              type="button"
              onClick={() => downloadReport('pdf')}
              disabled={downloading !== null || !data}
              className={BTN_GHOST + ' h-8 inline-flex items-center gap-1.5'}
            >
              <Printer className="w-3.5 h-3.5" />
              {downloading === 'pdf' ? (isUz ? 'Yig‘ilmoqda…' : 'Собираю…') : 'PDF'}
            </button>
          </div>
        </div>

        {/* Что именно попало в отчёт: склад, период, число строк. Без этой
            строки выгруженный файл через день не отличить от соседнего. */}
        {data && (
          <p className="text-[11px] text-zinc-500 break-words">
            {data.title}: {data.subtitle}
          </p>
        )}
        {data?.truncated && (
          <p className="text-[11px] text-amber-700 dark:text-amber-400 break-words">
            {isUz
              ? `Ekranda ${rows.length} qator ko‘rsatilgan, hammasi ${formatNumber(data.total)} — fayl to‘liq yuklanadi`
              : `На экране ${rows.length} ${rows.length === 1 ? 'строка' : 'строк'} из ${formatNumber(data.total)}: в файл уйдёт весь отчёт`}
          </p>
        )}
      </div>

      {downloadError && (
        <div className="px-4 pt-3">
          <ErrorBox text={errorText(downloadError, isUz)} isUz={isUz} />
        </div>
      )}

      {report.error ? (
        <ErrorBox text={errorText(report.error, isUz)} onRetry={reloadReport} isUz={isUz} />
      ) : report.isLoading && rows.length === 0 ? (
        <Skeleton />
      ) : rows.length === 0 ? (
        <Empty
          text={
            isUz ? 'Bu davrda ko‘rsatadigan narsa yo‘q' : 'За этот период показывать нечего'
          }
        />
      ) : (
        <ReportTable columns={columns} rows={rows} />
      )}
    </div>
  );
};
