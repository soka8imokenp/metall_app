import JSZip from 'jszip';

/**
 * Разбор загружаемой таблицы: CSV и XLSX (ТЗ 12, импорт файлов).
 *
 * Зеркало выгрузки. `common/csv.ts` пишет `;`, BOM и десятичную запятую — значит
 * читать надо ровно это, иначе система не прочитает собственный же файл, а это
 * первое, что сделает человек: выгрузит, поправит в Excel и загрузит обратно.
 * Запятая как разделитель тоже принимается — файл от чужой программы приходит
 * с ней, и отказывать из-за разделителя было бы придиркой.
 *
 * XLSX читается своим кодом по той же причине, по которой `common/xlsx.ts`
 * своим пишет: нужный нам лист — это два XML внутри zip, а `exceljs` тянет в
 * поставку API полтора десятка зависимостей ради того же результата. `jszip`
 * уже стоит в зависимостях — им же пишется `.docx`.
 *
 * Что сознательно не читается: формулы (берётся посчитанное значение `<v>`,
 * а если его нет — пусто), несколько листов (только первый), объединённые
 * ячейки, форматы и стили. Для таблицы обмена этого достаточно, и каждый
 * лишний разобранный случай — ещё одна причина принять не то, что в файле.
 */

export interface ParsedTable {
  /** Заголовки первой строки, приведённые к нижнему регистру без пробелов. */
  header: string[];
  /** Строки данных. Короткие строки дополнены пустыми ячейками до ширины шапки. */
  rows: string[][];
}

export class FileParseError extends Error {}

/** Разделитель определяется по шапке: в ней он встречается чаще всего. */
function guessDelimiter(head: string): ';' | ',' | '\t' {
  const counts: [';' | ',' | '\t', number][] = [
    [';', (head.match(/;/g) ?? []).length],
    [',', (head.match(/,/g) ?? []).length],
    ['\t', (head.match(/\t/g) ?? []).length],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0]![1] > 0 ? counts[0]![0] : ';';
}

/**
 * Разбор CSV по RFC 4180: кавычки экранируют разделитель и перевод строки,
 * удвоенная кавычка внутри поля означает саму кавычку.
 *
 * Своим разбором, а не `split(';')`: в наименовании номенклатуры точка с
 * запятой встречается («Труба 57; ГОСТ 10704»), и `split` разъехал бы всю
 * строку, свалив ГОСТ в колонку единицы измерения.
 */
export function parseCsv(text: string): ParsedTable {
  // BOM в начале — наш собственный, его пишет `buildCsv`. Не снять — и первая
  // колонка шапки будет называться «﻿код», то есть не найдётся никогда.
  const body = text.replace(/^﻿/, '');
  const firstEol = body.search(/\r?\n/);
  const delimiter = guessDelimiter(firstEol < 0 ? body : body.slice(0, firstEol));

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]!;
    if (quoted) {
      if (ch === '"') {
        if (body[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell === '') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch !== '\r') {
      cell += ch;
    }
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }

  return shape(rows);
}

/** Буквенный адрес колонки в номер: `A` → 0, `AB` → 27. */
function columnIndex(ref: string): number {
  const letters = /^([A-Z]+)/.exec(ref)?.[1] ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Номер строки из адреса ячейки: `B12` → 12. */
function rowNumber(ref: string): number {
  return Number(/(\d+)$/.exec(ref)?.[1] ?? '0');
}

const unescapeXml = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');

/** Текст элемента `<t>` со всеми его кусками: Excel рвёт строку на `<r><t>`. */
function textOf(xml: string): string {
  const parts = xml.match(/<t[^>]*>([\s\S]*?)<\/t>/g) ?? [];
  return unescapeXml(parts.map((p) => p.replace(/<[^>]+>/g, '')).join(''));
}

export async function parseXlsx(bytes: Buffer): Promise<ParsedTable> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new FileParseError('файл не читается как xlsx');
  }

  // Общая таблица строк: в XLSX текст ячейки чаще лежит не в ней, а здесь, и
  // ячейка ссылается на него номером (`t="s"`).
  const sharedXml = await zip.file('xl/sharedStrings.xml')?.async('string');
  const shared = (sharedXml?.match(/<si>[\s\S]*?<\/si>/g) ?? []).map(textOf);

  const sheetFile =
    zip.file('xl/worksheets/sheet1.xml') ??
    zip.file(/xl\/worksheets\/sheet\d+\.xml/)[0] ??
    null;
  if (!sheetFile) throw new FileParseError('в файле нет ни одного листа');
  const sheetXml = await sheetFile.async('string');

  const grid = new Map<number, Map<number, string>>();
  let maxCol = 0;
  for (const cellXml of sheetXml.match(/<c [^>]*\/>|<c [^>]*>[\s\S]*?<\/c>/g) ?? []) {
    const ref = /r="([A-Z]+\d+)"/.exec(cellXml)?.[1];
    if (!ref) continue;
    const r = rowNumber(ref);
    const c = columnIndex(ref);
    const type = /t="([^"]+)"/.exec(cellXml)?.[1] ?? 'n';

    let value: string;
    if (type === 's') {
      const idx = Number(/<v>([^<]*)<\/v>/.exec(cellXml)?.[1] ?? '-1');
      value = shared[idx] ?? '';
    } else if (type === 'inlineStr') {
      value = textOf(cellXml);
    } else {
      // Числа и посчитанные формулы: берётся `<v>`, то есть значение, а не
      // выражение. Формулу система не считает и считать не должна.
      value = unescapeXml(/<v>([^<]*)<\/v>/.exec(cellXml)?.[1] ?? '');
    }
    if (!grid.has(r)) grid.set(r, new Map());
    grid.get(r)!.set(c, value);
    if (c > maxCol) maxCol = c;
  }

  const rows: string[][] = [];
  for (const r of [...grid.keys()].sort((a, b) => a - b)) {
    const line = grid.get(r)!;
    rows.push(Array.from({ length: maxCol + 1 }, (_, c) => line.get(c) ?? ''));
  }
  return shape(rows);
}

/**
 * Шапка и строки. Пустые строки выбрасываются: Excel охотно отдаёт тысячу
 * пустых строк после последней заполненной, и без этого протокол импорта
 * состоял бы из тысячи «нет кода».
 */
function shape(rows: string[][]): ParsedTable {
  const clean = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (clean.length === 0) throw new FileParseError('файл пустой');
  const header = clean[0]!.map((h) => h.trim().toLowerCase());
  const width = header.length;
  return {
    header,
    rows: clean
      .slice(1)
      .map((r) => Array.from({ length: width }, (_, i) => (r[i] ?? '').trim())),
  };
}

/** Число из ячейки: и «313,44», и «313.44», и пробелы разрядов. */
export function cellNumber(raw: string): number | null {
  const s = raw.replace(/[\s ]/g, '').replace(',', '.');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** «да/нет», «ha/yo‘q», «true/false», «1/0» — всё, чем это пишут в таблице. */
export function cellBool(raw: string): boolean | null {
  const s = raw.trim().toLowerCase();
  if (s === '') return null;
  if (['да', 'ha', 'true', '1', '+', 'yes'].includes(s)) return true;
  if (['нет', 'yo‘q', "yo'q", 'false', '0', '-', 'no'].includes(s)) return false;
  return null;
}
