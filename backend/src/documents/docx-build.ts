import JSZip from 'jszip';

/**
 * Сборка минимального DOCX.
 *
 * Нужна в двух местах: черновые шаблоны, которые кладёт посев, и проверки.
 * Двоичных заготовок в репозитории не держим — по той же причине, по которой
 * их нет у демонстрационных вложений: файл в git нельзя прочитать глазами в
 * диффе, и через полгода никто не скажет, что внутри и кто его собрал.
 *
 * Это не «свой Word»: здесь ровно то, что нужно шаблону — абзацы и таблица.
 * Настоящие бумаги заказчика приедут готовыми файлами, и собирать их мы не
 * будем.
 */

const esc = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export type DocxBlock =
  | { kind: 'p'; text: string; bold?: boolean; size?: number }
  /**
   * `widths` — доли колонок; не заданы — поровну.
   * `size` — кегль в пунктах: в табличной части счёта восемь колонок, и
   * основным кеглем длинное число переносится посередине разряда.
   */
  | { kind: 'table'; rows: string[][]; head?: boolean; widths?: number[]; size?: number };

/**
 * Ширина набора в твипах: лист A4 (11906) минус поля из `sectPr`.
 * Должна совпадать с ними — иначе таблица уедет за край страницы.
 */
const CONTENT_W = 11906 - 1134 - 850;
/** То же для альбомного листа. */
const LANDSCAPE_W = 16838 - 1134 - 850;

const runProps = (b?: boolean, size?: number) => {
  const parts: string[] = [];
  if (b) parts.push('<w:b/>');
  if (size) parts.push(`<w:sz w:val="${size * 2}"/>`);
  return parts.length ? `<w:rPr>${parts.join('')}</w:rPr>` : '';
};

/**
 * Абзац с переносами строк.
 *
 * `\n` внутри текста превращается в `<w:br/>`, иначе Word склеит строки
 * в одну: в шаблоне это ровно адрес и банковские реквизиты, которые пишут
 * в столбик.
 */
const paragraph = (text: string, bold?: boolean, size?: number) => {
  const runs = esc(text)
    .split('\n')
    .map((line, i) => (i ? `<w:br/><w:t xml:space="preserve">${line}</w:t>` : `<w:t xml:space="preserve">${line}</w:t>`))
    .join('');
  return `<w:p><w:r>${runProps(bold, size)}${runs}</w:r></w:p>`;
};

const cell = (text: string, w: number, bold?: boolean, size?: number) =>
  `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/></w:tcPr>${paragraph(text, bold, size)}</w:tc>`;

/**
 * Таблица с явной сеткой колонок.
 *
 * Восемь колонок счёта в автоширине разъезжались: в PDF от таблицы оставались
 * «№» и «Наименование», остальные шесть LibreOffice терял, а название обрезал
 * на полуслове. Это видно только на бумаге — в XML файла все ячейки на месте.
 *
 * Чинит это пара, и обе половины проверены ломкой по отдельности:
 *
 * - **кегль по содержимому** (`size` у блока): в автоширине колонки не влезали
 *   в лист, и таблица схлопывалась. Убрать один кегль — проверка падает;
 * - **явные ширины** (`tblGrid`, `tcW` в `dxa`, `tblLayout fixed`): делают
 *   раскладку заданной, а не вычисленной. Сами по себе, при подходящем кегле,
 *   они уже не обязательны — но без них ширины колонок зависят от длины
 *   данных, и счёт на длинное название выглядит иначе, чем на короткое.
 */
const table = (
  rows: string[][],
  head?: boolean,
  widths?: number[],
  size?: number,
  contentW: number = CONTENT_W,
) => {
  const cols = Math.max(...rows.map((r) => r.length), 1);
  const parts =
    widths && widths.length === cols ? widths : Array.from({ length: cols }, () => 1);
  const sum = parts.reduce((a, b) => a + b, 0);
  // Последняя колонка добирает остаток: округление долей иначе оставляет
  // щель в несколько твипов, и правая граница не сходится с рамкой.
  const cw = parts.map((p) => Math.floor((contentW * p) / sum));
  cw[cols - 1] = contentW - cw.slice(0, -1).reduce((a, b) => a + b, 0);

  const body = rows
    .map(
      (r, i) =>
        `<w:tr>${r
          .map((c, j) => cell(c, cw[j] ?? cw[cols - 1]!, head && i === 0, size))
          .join('')}</w:tr>`,
    )
    .join('');
  return (
    `<w:tbl><w:tblPr><w:tblW w:w="${contentW}" w:type="dxa"/>` +
    '<w:tblLayout w:type="fixed"/>' +
    '<w:tblBorders>' +
    ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="999999"/>`)
      .join('') +
    '</w:tblBorders></w:tblPr>' +
    `<w:tblGrid>${cw.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>` +
    body +
    '</w:tbl>'
  );
};

export interface DocxOptions {
  /** Альбомный лист: отчёт на пятнадцать колонок в портрет не встаёт. */
  landscape?: boolean;
}

export async function buildDocx(
  blocks: DocxBlock[],
  options: DocxOptions = {},
): Promise<Buffer> {
  const land = options.landscape === true;
  const body = blocks
    .map((b) =>
      b.kind === 'p'
        ? paragraph(b.text, b.bold, b.size)
        : table(b.rows, b.head, b.widths, b.size, land ? LANDSCAPE_W : CONTENT_W),
    )
    .join('');

  const pg = land
    ? '<w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/>'
    : '<w:pgSz w:w="11906" w:h="16838"/>';
  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${body}<w:sectPr>${pg}` +
    '<w:pgMar w:top="1134" w:right="850" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>';

  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '</Types>',
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>',
  );
  zip.file('word/document.xml', documentXml);
  zip.file(
    'word/_rels/document.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
  );

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
