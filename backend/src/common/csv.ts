/**
 * Выгрузка таблицы в CSV (ТЗ 5.1: «Excel или CSV»).
 *
 * CSV нужен там, где файл читает не человек, а чужая программа: 1С и REGOS
 * берут именно его (см. 02-ARCHITECTURE, обменный слой). Человеку же мы отдаём
 * `.xlsx` — в нём числа остаются числами.
 *
 * Три решения, каждое из-за русского Excel, и каждое ломает файл, если его
 * отменить:
 *
 *   - **разделитель `;`**, а не запятая. В русской локали Excel разбирает CSV
 *     точкой с запятой, а файл с запятыми кладёт целиком в первую колонку;
 *   - **BOM** в начале. Без него Excel читает UTF-8 как однобайтовую кодировку,
 *     и вся кириллица превращается в «Ð¢Ñ€ÑƒÐ±Ð°»;
 *   - **десятичная запятая** в числах. С точкой Excel считает «313.44» текстом,
 *     и сумма по колонке не берётся.
 *
 * Перевод строки — CRLF: так требует RFC 4180, и так его ждут старые импортёры.
 */

export type CsvValue = string | number | null;

export interface CsvColumn {
  title: string;
  /** Числовая колонка: точка в дробной части меняется на запятую. */
  numeric?: boolean;
}

const BOM = '﻿';
const EOL = '\r\n';

/**
 * Поле в кавычках, если в нём есть разделитель, кавычка или перевод строки.
 * Кавычка внутри удваивается — иначе она закрывает поле раньше времени, и
 * дальше съезжает вся строка.
 */
function cell(raw: string): string {
  return /[";\r\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

export function buildCsv(columns: CsvColumn[], rows: CsvValue[][]): string {
  const head = columns.map((c) => cell(c.title)).join(';');
  const body = rows.map((row) =>
    row
      .map((value, i) => {
        if (value === null) return '';
        const text = String(value);
        return cell(columns[i]?.numeric ? text.replace('.', ',') : text);
      })
      .join(';'),
  );
  return BOM + [head, ...body].join(EOL) + EOL;
}
