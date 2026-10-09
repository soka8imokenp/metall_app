/**
 * Отчёты финансов и выгрузка (ТЗ 6.9).
 *
 * Восемь отчётов, одна таблица и три кнопки выгрузки. Двух из восьми —
 * «Прибыли и убытки» и «Маржа» — нет у того, кому не дано право
 * `finance.profit.view`: заказчик 07.10 просил, чтобы финансист видел
 * аналитику, не видя чистой прибыли учредителей.
 *
 * Таблицу рисует то же,
 * что уходит в файл: колонки и строки приходят с сервера, экран их не
 * пересобирает. Иначе на экране одно, а в Excel другое — и спорить об этом
 * придётся с клиентом, а не между собой.
 *
 * На экран приходят первые пятьсот строк: отчёт смотрят, чтобы убедиться, что
 * выгружается то самое. Обрезанный отчёт говорит об этом вслух.
 *
 * Период спрашивается не у всех. Остатки и задолженность отвечают на вопрос
 * «сколько сейчас»: поля дат у них только сбивали бы с толку — человек
 * выставил бы прошлый месяц и решил, что видит долг на ту дату.
 *
 * KPI менеджеров в списке нет и не появится до разговора с заказчиком: правил
 * расчёта он не давал. Показатель, формулу которого никто не утверждал, в
 * отчёте рисовать нельзя — по нему начнут платить бонусы.
 */

import React from 'react';
import { Download, FileSpreadsheet, Printer } from 'lucide-react';
import { errorText } from '../../context/DashboardContext';
import { useAuth } from '../../context/AuthContext';
import { useFinance } from '../../context/FinanceContext';
import type { FinanceMarginBreakdown, FinanceReportKind } from '../../types/api';
import { formatNumber } from '../../lib/formatters';
import { BTN_GHOST, Empty, ErrorBox, Skeleton } from './warehouse-ui';
import { CustomDatePicker } from '../common/CustomDatePicker';
import { ReportTable } from './ReportTable';

/**
 * Право на финансовый результат (требование заказчика 07.10: финансист видит
 * аналитику, но не чистую прибыль учредителей).
 *
 * Кнопку спрятать мало — адрес набирается руками, и решает это сервер:
 * `build` в `backend/src/finance/reports.service.ts` отказывает и ответом, и
 * файлом. Здесь кнопка убрана, чтобы человек не нажимал на отказ.
 */
const PROFIT_PERMISSION = 'finance.profit.view';

const KINDS: {
  key: FinanceReportKind;
  ru: string;
  uz: string;
  period: boolean;
  perm?: string;
}[] = [
  { key: 'cashflow', ru: 'Движение денег', uz: 'Pul oqimi', period: true },
  { key: 'balances', ru: 'Остатки по кассам и счетам', uz: 'Kassa va hisob qoldiqlari', period: true },
  { key: 'receivables', ru: 'Дебиторка', uz: 'Debitorlik', period: false },
  { key: 'payables', ru: 'Кредиторка', uz: 'Kreditorlik', period: false },
  { key: 'plan-fact', ru: 'План-факт', uz: 'Reja-fakt', period: true },
  { key: 'pnl', ru: 'Прибыли и убытки', uz: 'Foyda va zararlar', period: true, perm: PROFIT_PERMISSION },
  { key: 'margin', ru: 'Маржа', uz: 'Marja', period: true, perm: PROFIT_PERMISSION },
  // Сводный остаётся у всех: без права на результат сервер убирает из него
  // раздел «Результат» и говорит об этом в подзаголовке.
  { key: 'summary', ru: 'Сводный', uz: 'Yig‘ma', period: true },
];

/** Разрезы маржи из ТЗ 6.7: заказ, товар, клиент, менеджер. */
const BREAKDOWNS: { key: FinanceMarginBreakdown; ru: string; uz: string }[] = [
  { key: 'order', ru: 'По заказам', uz: 'Buyurtmalar bo‘yicha' },
  { key: 'item', ru: 'По товарам', uz: 'Tovarlar bo‘yicha' },
  { key: 'partner', ru: 'По клиентам', uz: 'Mijozlar bo‘yicha' },
  { key: 'manager', ru: 'По менеджерам', uz: 'Menejerlar bo‘yicha' },
];

const CHIP_ON =
  'border-zinc-900 dark:border-zinc-100 bg-zinc-900 text-zinc-50 dark:bg-zinc-50 dark:text-zinc-900';
const CHIP_OFF =
  'border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800';
const CHIP = 'h-7 px-2.5 rounded-lg border text-[11px] font-medium transition-colors cursor-pointer';

export const FinanceReportsPanel: React.FC<{ isUz: boolean }> = ({ isUz }) => {
  const {
    reportKind,
    setReportKind,
    reportFrom,
    reportTo,
    setReportPeriod,
    marginBy,
    setMarginBy,
    report,
    reloadReport,
    downloadReport,
    downloading,
    downloadError,
  } = useFinance();
  const { can } = useAuth();

  const kinds = React.useMemo(() => KINDS.filter((k) => !k.perm || can(k.perm)), [can]);

  /**
   * Выбранный отчёт мог закрыться правами — тогда ведём на первый открытый.
   *
   * Без этого экран остался бы на отчёте, кнопки которого нет: человек видел
   * бы отказ сервера и не понимал, откуда он взялся и как с него уйти.
   */
  React.useEffect(() => {
    if (!kinds.some((k) => k.key === reportKind) && kinds[0]) setReportKind(kinds[0].key);
  }, [kinds, reportKind, setReportKind]);

  const current = kinds.find((k) => k.key === reportKind) ?? kinds[0]!;
  const data = report.data;
  const columns = data?.columns ?? [];
  const rows = data?.rows ?? [];

  const busy = (format: 'xlsx' | 'csv' | 'pdf', idle: string, work: string) =>
    downloading === format ? work : idle;

  return (
    <div
      role="tabpanel"
      aria-label={isUz ? 'Hisobotlar' : 'Отчёты'}
      className="flex flex-col min-w-0"
    >
      <div className="px-4 py-3 flex flex-col gap-2 border-b border-zinc-200 dark:border-zinc-800">
        <div className="flex flex-wrap items-center gap-1">
          {kinds.map((k) => (
            <button
              key={k.key}
              type="button"
              aria-pressed={reportKind === k.key}
              onClick={() => setReportKind(k.key)}
              className={`${CHIP} ${reportKind === k.key ? CHIP_ON : CHIP_OFF}`}
            >
              {isUz ? k.uz : k.ru}
            </button>
          ))}
        </div>

        {/* Разрез — только у маржи: у остальных его нет, и показывать пустой
            переключатель значило бы обещать разрез, которого не будет. */}
        {reportKind === 'margin' && (
          <div className="flex flex-wrap items-center gap-1">
            {BREAKDOWNS.map((b) => (
              <button
                key={b.key}
                type="button"
                aria-pressed={marginBy === b.key}
                onClick={() => setMarginBy(b.key)}
                className={`${CHIP} ${marginBy === b.key ? CHIP_ON : CHIP_OFF}`}
              >
                {isUz ? b.uz : b.ru}
              </button>
            ))}
          </div>
        )}

        <div className="flex flex-col sm:flex-row sm:items-center gap-2">
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
              {busy('xlsx', 'Excel', isUz ? 'Yuklanmoqda…' : 'Готовлю…')}
            </button>
            <button
              type="button"
              onClick={() => downloadReport('csv')}
              disabled={downloading !== null || !data}
              className={BTN_GHOST + ' h-8 inline-flex items-center gap-1.5'}
            >
              <Download className="w-3.5 h-3.5" />
              {busy('csv', 'CSV', isUz ? 'Yuklanmoqda…' : 'Готовлю…')}
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
              {busy('pdf', 'PDF', isUz ? 'Yig‘ilmoqda…' : 'Собираю…')}
            </button>
          </div>
        </div>

        {/* Что именно попало в отчёт: период, число строк, ключевые итоги. Без
            этой строки выгруженный файл через день не отличить от соседнего. */}
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
          text={isUz ? 'Bu davrda ko‘rsatadigan narsa yo‘q' : 'За этот период показывать нечего'}
        />
      ) : (
        <ReportTable columns={columns} rows={rows} />
      )}
    </div>
  );
};
