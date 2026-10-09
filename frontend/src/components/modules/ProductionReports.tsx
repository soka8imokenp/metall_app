/**
 * Отчёты производства (ТЗ 4.1, Э8).
 *
 * Пять отчётов на одни и те же вопросы, которые задают в цеху: успеваем ли по
 * срокам, сколько выпустили и сколько ушло в брак, сошёлся ли расход с нормой,
 * из-за чего стояли и насколько загружены участки.
 *
 * Таблицу рисует то же, что уходит в файл: колонки и строки приходят с
 * сервера. Так на экране и в Excel одно и то же — иначе спорить об расхождении
 * придётся с клиентом.
 *
 * Период спрашивается у всех пяти: производство — это всегда «за какое время».
 * По умолчанию сервер берёт последние тридцать дней и говорит об этом в
 * подписи, чтобы пустые поля дат не выглядели как «за всё время».
 */

import React from 'react';
import { Download, FileSpreadsheet, Printer } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { errorText } from '../../context/DashboardContext';
import { useProduction } from '../../context/ProductionContext';
import { CustomDatePicker } from '../common/CustomDatePicker';
import { formatNumber } from '../../lib/formatters';
import type { ProductionReportKind } from '../../types/api';
import { ReportTable } from './ReportTable';

const CARD =
  'rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-2xs';
const GHOST =
  'px-2.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-[11px] font-medium ' +
  'text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors ' +
  'disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer';

/**
 * Подпись под каждой кнопкой объясняет, на какой вопрос отчёт отвечает.
 * Названия «Материалы» или «Загрузка» сами по себе ничего не говорят тому, кто
 * открыл экран впервые.
 */
const KINDS: {
  key: ProductionReportKind;
  ru: string;
  uz: string;
  hintRu: string;
  hintUz: string;
}[] = [
  {
    key: 'orders',
    ru: 'Сроки заказов',
    uz: 'Buyurtma muddatlari',
    hintRu: 'План и факт по каждому заказу, у кого просрочка и на сколько рабочих дней',
    hintUz: 'Har bir buyurtma bo‘yicha reja va fakt, kimda kechikish va necha ish kuni',
  },
  {
    key: 'output',
    ru: 'Выпуск и брак',
    uz: 'Chiqarish va brak',
    hintRu: 'Сколько приняли годного, сколько ушло в брак и какова его доля',
    hintUz: 'Qancha yaroqli qabul qilindi, qancha brak va uning ulushi',
  },
  {
    key: 'materials',
    ru: 'Расход материалов',
    uz: 'Material sarfi',
    hintRu: 'Норма против фактической выдачи со склада по каждому материалу',
    hintUz: 'Har bir material uchun norma va omborlardan haqiqiy berilgani',
  },
  {
    key: 'deviations',
    ru: 'Причины потерь',
    uz: 'Yo‘qotish sabablari',
    hintRu: 'Простои, перерасход и брак, сведённые по причинам и участкам',
    hintUz: 'To‘xtab turish, ortiqcha sarf va brak sabablar va uchastkalar bo‘yicha',
  },
  {
    key: 'load',
    ru: 'Загрузка участков',
    uz: 'Uchastkalar yuklanishi',
    hintRu: 'Сколько минут участок отработал против того, что даёт календарь смен',
    hintUz: 'Uchastka necha daqiqa ishlagani va smena kalendari bergani',
  },
];

export const ProductionReports: React.FC = () => {
  const { locale } = useApp();
  const isUz = locale === 'uz';
  const {
    reportKind,
    setReportKind,
    reportFrom,
    reportTo,
    setReportPeriod,
    report,
    reloadReport,
    wantReport,
    downloadReport,
    downloading,
    downloadError,
  } = useProduction();

  React.useEffect(() => {
    wantReport();
  }, [wantReport]);

  const current = KINDS.find((k) => k.key === reportKind)!;
  const data = report.data;
  const columns = data?.columns ?? [];
  const rows = data?.rows ?? [];

  return (
    <div className={`${CARD} flex flex-col min-w-0`}>
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

        {/* Что это и зачем — до того, как человек нажмёт выгрузку. */}
        <p className="text-[11px] text-zinc-500 break-words">
          {isUz ? current.hintUz : current.hintRu}
        </p>

        <div className="flex flex-col sm:flex-row sm:items-center gap-2">
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

          <div className="flex items-center gap-2 sm:ml-auto">
            <button
              type="button"
              onClick={() => downloadReport('xlsx')}
              disabled={downloading !== null || !data}
              className={GHOST + ' h-8 inline-flex items-center gap-1.5'}
            >
              <FileSpreadsheet className="w-3.5 h-3.5" />
              {downloading === 'xlsx' ? (isUz ? 'Yuklanmoqda…' : 'Готовлю…') : 'Excel'}
            </button>
            <button
              type="button"
              onClick={() => downloadReport('csv')}
              disabled={downloading !== null || !data}
              className={GHOST + ' h-8 inline-flex items-center gap-1.5'}
            >
              <Download className="w-3.5 h-3.5" />
              {downloading === 'csv' ? (isUz ? 'Yuklanmoqda…' : 'Готовлю…') : 'CSV'}
            </button>
            <button
              type="button"
              onClick={() => downloadReport('pdf')}
              disabled={downloading !== null || !data}
              className={GHOST + ' h-8 inline-flex items-center gap-1.5'}
            >
              <Printer className="w-3.5 h-3.5" />
              {downloading === 'pdf' ? (isUz ? 'Yig‘ilmoqda…' : 'Собираю…') : 'PDF'}
            </button>
          </div>
        </div>

        {/* Какой период и какая компания попали в файл: без этой строки
            выгруженный отчёт через день не отличить от соседнего. */}
        {data && (
          <p className="text-[11px] text-zinc-500 break-words">
            {data.title}: {data.subtitle}
          </p>
        )}
        {data?.truncated && (
          <p className="text-[11px] text-amber-700 dark:text-amber-400 break-words">
            {isUz
              ? `Ekranda ${rows.length} qator, hammasi ${formatNumber(data.total)} — fayl to‘liq yuklanadi`
              : `На экране ${rows.length} ${rows.length === 1 ? 'строка' : 'строк'} из ${formatNumber(data.total)}: в файл уйдёт весь отчёт`}
          </p>
        )}
      </div>

      {downloadError && (
        <div className="px-4 pt-3">
          <p className="text-xs text-red-600 dark:text-red-400 break-words">
            {errorText(downloadError, isUz)}
          </p>
        </div>
      )}

      {report.error && !data ? (
        <div className="px-4 py-6 flex flex-col items-center gap-2">
          <p className="text-xs text-red-600 dark:text-red-400 text-center break-words">
            {errorText(report.error, isUz)}
          </p>
          <button type="button" onClick={reloadReport} className={GHOST + ' h-7'}>
            {isUz ? 'Qayta urinish' : 'Повторить'}
          </button>
        </div>
      ) : report.isLoading && rows.length === 0 ? (
        <p className="px-4 py-6 text-xs text-zinc-400 text-center">
          {isUz ? 'Yuklanmoqda…' : 'Загружаю…'}
        </p>
      ) : rows.length === 0 ? (
        <p className="px-4 py-6 text-xs text-zinc-500 text-center break-words">
          {isUz
            ? 'Bu davrda ko‘rsatadigan narsa yo‘q: boshqa sanalarni tanlang'
            : 'За этот период показывать нечего: выберите другие даты'}
        </p>
      ) : (
        <ReportTable columns={columns} rows={rows} />
      )}
    </div>
  );
};
