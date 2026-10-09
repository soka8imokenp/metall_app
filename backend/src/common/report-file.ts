import type { Response } from 'express';
import { ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { buildCsv } from './csv.js';
import { buildXlsx } from './xlsx.js';
import type { ReportTable } from './report.js';
import { buildDocx, type DocxBlock } from '../documents/docx-build.js';
import { PdfConvertError, PdfToolMissingError, docxToPdf } from '../documents/pdf.js';

export const REPORT_FORMATS = ['xlsx', 'csv', 'pdf'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

/**
 * Сколько строк уходит в PDF.
 *
 * Excel и CSV отдают отчёт целиком — их открывают, чтобы считать. PDF
 * печатают и подписывают, и двадцать тысяч строк это триста листов, которые
 * никто не откроет и которые собираются минуту. Предел назван на самой
 * бумаге, а не проглочен молча.
 */
export const PDF_ROW_LIMIT = 1000;

const MIME: Record<ReportFormat, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv; charset=utf-8',
  pdf: 'application/pdf',
};

/**
 * Отчёт на бумаге.
 *
 * Тот же тракт, что у печатных форм документов: собираем DOCX и отдаём его
 * LibreOffice. Второй способ делать PDF означал бы две разные бумаги из одной
 * системы — с разными шрифтами и разным форматом чисел.
 *
 * Лист альбомный от семи колонок: отчёт по оборачиваемости в портрет не
 * встаёт, а прокрутки у бумаги нет.
 */
export async function reportPdf(report: ReportTable): Promise<Buffer> {
  const landscape = report.columns.length > 6;

  const cell = (v: unknown) =>
    v === null || v === undefined
      ? ''
      : typeof v === 'number'
        ? v.toLocaleString('ru-RU', { maximumFractionDigits: 4 })
        : String(v);
  const body = report.rows.map((r) => r.map(cell));

  /**
   * Ширина колонки — по самому длинному, что в ней стоит.
   *
   * Отчёт по остаткам это тринадцать колонок, и поровну они не делятся:
   * «Ед.» получала бы столько же, сколько «Стоимость», и «283 309 339,12»
   * переносилось бы посередине разряда — на бумаге это читается как другое
   * число. Заголовок считается с запасом: он переносится по словам, число —
   * нет, и рвать надо заголовок.
   *
   * Верхний предел не даёт одной длинной строке съесть лист, а прибавка —
   * это поля ячейки: они одинаковы у всех колонок, и без неё узкие («Ед.»,
   * «Зона») получают ширину меньше собственных полей и ломают заголовок.
   */
  const widths = report.columns.map((c, i) => {
    const longest = body.reduce((m, r) => Math.max(m, (r[i] ?? '').length), 0);
    // Самое длинное слово заголовка, а не весь заголовок: «Серийный номер»
    // переносится по пробелу и лишней ширины не требует, а «Себестоимость»
    // переносить негде — колонка должна быть под него.
    const head = Math.max(...c.title.split(/\s+/).map((w) => w.length)) + 2;
    return Math.max(4, Math.min(28, Math.max(longest, head)) + 3);
  });

  /**
   * Кегль по числу колонок.
   *
   * Тринадцать колонок восьмым кеглем в альбомный лист не встают, и таблица
   * начинает рвать числа. Проверено на собранном PDF, а не рассчитано.
   */
  const size = report.columns.length > 10 ? 6 : report.columns.length > 6 ? 7 : 8;

  const blocks: DocxBlock[] = [
    { kind: 'p', text: report.title, bold: true, size: 13 },
    { kind: 'p', text: report.subtitle, size: 9 },
    { kind: 'p', text: '' },
    {
      kind: 'table',
      head: true,
      size,
      widths,
      rows: [report.columns.map((c) => c.title), ...body],
    },
  ];

  if (report.truncated) {
    blocks.push({ kind: 'p', text: '' });
    blocks.push({
      kind: 'p',
      size: 9,
      text:
        `Показаны первые ${report.rows.length} строк из ${report.total}. ` +
        'Отчёт целиком выгружается в Excel.',
    });
  }

  const docx = await buildDocx(blocks, { landscape });
  try {
    return await docxToPdf(docx);
  } catch (e) {
    if (e instanceof PdfToolMissingError) throw new ServiceUnavailableException(e.message);
    if (e instanceof PdfConvertError) throw new UnprocessableEntityException(e.message);
    throw e;
  }
}

/**
 * Отдача отчёта файлом — одна на склад и CRM.
 *
 * `@Res()` без `passthrough` у вызывающего — сознательно: иначе
 * конверт-перехватчик завернёт байты в JSON. Заголовки собраны здесь, чтобы
 * два модуля не разошлись в имени файла и в типе содержимого.
 */
export async function sendReportFile(
  res: Response,
  report: ReportTable,
  baseName: string,
  format: ReportFormat,
) {
  const name = `${baseName}.${format}`;
  const body =
    format === 'csv'
      ? Buffer.from(buildCsv(report.columns, report.rows), 'utf8')
      : format === 'pdf'
        ? await reportPdf(report)
        : buildXlsx({ name: report.title, columns: report.columns, rows: report.rows });

  res.setHeader('Content-Type', MIME[format]);
  res.setHeader('Content-Length', String(body.length));
  // Имя в кавычках плюс filename* по RFC 5987: в именах отчётов бывает
  // кириллица, а без звёздной формы браузер сохранит её подчёркиваниями.
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; ` +
      `filename*=UTF-8''${encodeURIComponent(name)}`,
  );
  res.setHeader('Cache-Control', 'private, max-age=0, no-store');
  res.end(body);
}
