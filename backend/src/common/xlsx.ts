/**
 * Выгрузка таблицы в Excel (ТЗ 5.1, 6.9: «каждый отчёт выгружается в
 * Excel/CSV»).
 *
 * Пишется настоящий `.xlsx`, а не CSV с расширением `.xls`. Разница не в
 * названии: в CSV число — это текст, и «313,440420» в русском Excel
 * превращается то в дату, то в строку, а сумму по колонке бухгалтер не
 * получает. Здесь количества уходят числами, и лист открывается посчитанным.
 *
 * Своя реализация, а не библиотека, по той же причине, что и Code 128: весь
 * нужный нам `xlsx` — это zip из пяти небольших XML, и формат их описан. Взамен
 * `exceljs` (и его зависимостей) в поставке API — сто пятьдесят строк, которые
 * читаются целиком.
 *
 * Что сознательно не делается: формулы, несколько листов, объединённые ячейки,
 * картинки и стили сверх шапки. Отчёту они не нужны, а каждый из них — это
 * ещё одна часть пакета и ещё одна причина, по которой файл не откроется.
 *
 * Проверяется независимым читателем: `test/export-formats.spec.ts` открывает
 * готовый файл библиотекой `exceljs` (devDependency, только в проверке) и
 * сверяет значения, типы ячеек и имя листа. Свой писатель, проверенный своим
 * же читателем, не проверен ничем — так же сверяется и Code 128.
 */

import { deflateRawSync, crc32 } from 'node:zlib';

export type CellValue = string | number | null;

export interface SheetColumn {
  title: string;
  /** Числовые колонки уходят числами: по ним в Excel считается сумма. */
  numeric?: boolean;
  /** Ширина в знаках. Без неё Excel даёт всем колонкам одинаковую. */
  width?: number;
}

export interface Sheet {
  /** Имя листа. Excel не принимает в нём : \ / ? * [ ] и длину больше 31. */
  name: string;
  columns: SheetColumn[];
  rows: CellValue[][];
}

/** Имя листа по правилам Excel. Файл с недопустимым именем он не открывает. */
function sheetName(raw: string): string {
  const cleaned = raw.replace(/[:\\/?*[\]]/g, ' ').trim() || 'Лист1';
  return cleaned.slice(0, 31);
}

const escapeXml = (v: string) =>
  v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // Управляющие знаки в XML недопустимы вовсе: один такой в комментарии
    // кладовщика — и файл не откроется целиком.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

/** A, B … Z, AA, AB … — адрес колонки, а не её номер. */
export function columnLetter(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rest = (n - 1) % 26;
    out = String.fromCharCode(65 + rest) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

/**
 * Стили: обычная ячейка и жирная шапка.
 *
 * Пустая заливка и `gray125` вторым номером — не украшение и не случайность:
 * Excel ждёт в файле ровно эти две первыми и без них считает книгу битой.
 */
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>
</styleSheet>`;

function workbookXml(name: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${escapeXml(name)}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;
}

function sheetXml(sheet: Sheet): string {
  const last = columnLetter(Math.max(sheet.columns.length - 1, 0));
  const cols = sheet.columns
    .map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width ?? 16}" customWidth="1"/>`)
    .join('');

  const head = sheet.columns
    .map(
      (c, i) =>
        `<c r="${columnLetter(i)}1" s="1" t="inlineStr"><is><t xml:space="preserve">${escapeXml(c.title)}</t></is></c>`,
    )
    .join('');

  const body = sheet.rows
    .map((row, r) => {
      const n = r + 2;
      const cells = row
        .map((value, i) => {
          const ref = `${columnLetter(i)}${n}`;
          if (value === null || value === '') return '';
          if (sheet.columns[i]?.numeric && typeof value === 'number' && Number.isFinite(value)) {
            return `<c r="${ref}"><v>${value}</v></c>`;
          }
          // Текстом, а не общей ячейкой: артикул «PPU-530-710» Excel иначе
          // пытается прочитать как дату и показывает не то, что выгрузили.
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(String(value))}</t></is></c>`;
        })
        .join('');
      return `<row r="${n}">${cells}</row>`;
    })
    .join('');

  // Шапка закреплена и с фильтром: отчёт на тысячу строк без этого читают,
  // прокручивая обратно наверх за названием колонки.
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${cols}</cols>
<sheetData><row r="1">${head}</row>${body}</sheetData>
<autoFilter ref="A1:${last}${sheet.rows.length + 1}"/>
</worksheet>`;
}

/* ------------------------------------------------------------------ */
/* Упаковка zip                                                        */
/* ------------------------------------------------------------------ */

interface Entry {
  name: string;
  data: Buffer;
}

/**
 * Zip без библиотек: локальные заголовки, центральный каталог и его хвост.
 *
 * Дата в записях одна и та же, а не `now()`: иначе два одинаковых отчёта дают
 * разные файлы, и сверить выгрузку с эталоном в проверке нечем.
 */
function zip(entries: Entry[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const deflated = deflateRawSync(entry.data, { level: 9 });
    const sum = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // версия, нужная для распаковки
    local.writeUInt16LE(0x0800, 6); // имена в UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10); // время
    local.writeUInt16LE(0x0021, 12); // дата: 1980-01-01
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, name, deflated);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(0x0021, 14);
    dir.writeUInt32LE(sum, 16);
    dir.writeUInt32LE(deflated.length, 20);
    dir.writeUInt32LE(entry.data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(0, 38); // внешние атрибуты
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);

    offset += local.length + name.length + deflated.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...chunks, centralBuf, end]);
}

/** Готовый файл `.xlsx` одним листом. */
export function buildXlsx(sheet: Sheet): Buffer {
  const name = sheetName(sheet.name);
  const utf8 = (s: string) => Buffer.from(s, 'utf8');
  return zip([
    { name: '[Content_Types].xml', data: utf8(CONTENT_TYPES) },
    { name: '_rels/.rels', data: utf8(ROOT_RELS) },
    { name: 'xl/workbook.xml', data: utf8(workbookXml(name)) },
    { name: 'xl/_rels/workbook.xml.rels', data: utf8(WORKBOOK_RELS) },
    { name: 'xl/styles.xml', data: utf8(STYLES) },
    { name: 'xl/worksheets/sheet1.xml', data: utf8(sheetXml({ ...sheet, name })) },
  ]);
}
