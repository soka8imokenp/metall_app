/**
 * Выгрузка отчётов в CSV и Excel (ТЗ 5.1).
 *
 * Без базы и без Nest: здесь проверяются сами форматы. Файл `.xlsx` открывается
 * независимым читателем — `exceljs`, devDependency, в поставку API он не
 * входит. Свой писатель, проверенный своим же читателем, не проверен ничем: так
 * же сверяется с `jsbarcode` наш Code 128.
 *
 * Проверяется то, из-за чего выгрузка обычно и оказывается бесполезной:
 * кириллица превращается в мусор, число становится текстом, а артикул — датой.
 */
import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { buildCsv } from '../src/common/csv.js';
import { buildXlsx, columnLetter } from '../src/common/xlsx.js';

const COLUMNS = [
  { title: 'Код' },
  { title: 'Номенклатура' },
  { title: 'Наличие', numeric: true },
  { title: 'Примечание' },
];

const ROWS = [
  ['PPU-530-710', 'Труба предизолированная 530/710', 313.44042, 'без замечаний'],
  ['ARM-A500S-12', 'Арматура А500С Ø12 мм', 0, 'строка с ; и "кавычками"'],
  ['LIST-GK-4', 'Лист 4 мм', -2.5, null],
];

describe('CSV', () => {
  const csv = buildCsv(COLUMNS, ROWS);

  it('начинается с BOM: без него русский Excel читает кириллицу как мусор', () => {
    expect(csv.charCodeAt(0)).toBe(0xfeff);
  });

  it('разделитель — точка с запятой, перевод строки — CRLF', () => {
    const head = csv.slice(1).split('\r\n')[0];
    expect(head).toBe('Код;Номенклатура;Наличие;Примечание');
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it('в числовой колонке десятичная запятая, в текстовой ничего не меняется', () => {
    const line = csv.split('\r\n')[1]!;
    expect(line).toContain(';313,44042;');
    // Артикул с дефисами и цифрами — текст, и трогать его нельзя.
    expect(line.startsWith('PPU-530-710;')).toBe(true);
  });

  it('поле с разделителем и кавычками берётся в кавычки, кавычка удваивается', () => {
    const line = csv.split('\r\n')[2]!;
    expect(line).toContain('"строка с ; и ""кавычками"""');
  });

  it('пустая ячейка остаётся пустой, а не словом null', () => {
    const line = csv.split('\r\n')[3]!;
    expect(line.endsWith(';')).toBe(true);
    expect(line).not.toContain('null');
  });

  it('отрицательное число выгружается со знаком', () => {
    expect(csv).toContain(';-2,5;');
  });
});

describe('адрес колонки', () => {
  it('за Z идёт AA', () => {
    expect(columnLetter(0)).toBe('A');
    expect(columnLetter(25)).toBe('Z');
    expect(columnLetter(26)).toBe('AA');
    expect(columnLetter(27)).toBe('AB');
    expect(columnLetter(51)).toBe('AZ');
    expect(columnLetter(52)).toBe('BA');
  });
});

describe('Excel', () => {
  async function read(buffer: Buffer) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    return wb;
  }

  it('файл открывается сторонней библиотекой и лист назван как отчёт', async () => {
    const wb = await read(buildXlsx({ name: 'Остатки', columns: COLUMNS, rows: ROWS }));
    expect(wb.worksheets.length).toBe(1);
    expect(wb.worksheets[0]!.name).toBe('Остатки');
  });

  it('шапка на месте и выделена жирным', async () => {
    const wb = await read(buildXlsx({ name: 'Остатки', columns: COLUMNS, rows: ROWS }));
    const head = wb.worksheets[0]!.getRow(1);
    expect(head.getCell(1).value).toBe('Код');
    expect(head.getCell(4).value).toBe('Примечание');
    expect(head.getCell(1).font?.bold).toBe(true);
  });

  it('число остаётся числом, текст — текстом', async () => {
    const wb = await read(buildXlsx({ name: 'Остатки', columns: COLUMNS, rows: ROWS }));
    const row = wb.worksheets[0]!.getRow(2);
    expect(typeof row.getCell(3).value).toBe('number');
    expect(row.getCell(3).value).toBe(313.44042);
    // Артикул Excel не должен превратить в дату: он приходит строкой.
    expect(row.getCell(1).value).toBe('PPU-530-710');
    expect(typeof row.getCell(1).value).toBe('string');
  });

  it('кириллица и знаки XML доезжают без потерь', async () => {
    const rows = [['A&B', 'Труба <108×4> «ППУ» ГОСТ 30732-2020', 1, 'кавычка " и апостроф \'']];
    const wb = await read(buildXlsx({ name: 'Остатки', columns: COLUMNS, rows }));
    const row = wb.worksheets[0]!.getRow(2);
    expect(row.getCell(1).value).toBe('A&B');
    expect(row.getCell(2).value).toBe('Труба <108×4> «ППУ» ГОСТ 30732-2020');
    expect(row.getCell(4).value).toBe('кавычка " и апостроф \'');
  });

  it('пустая ячейка не превращается в ноль', async () => {
    const wb = await read(buildXlsx({ name: 'Остатки', columns: COLUMNS, rows: ROWS }));
    const row = wb.worksheets[0]!.getRow(4);
    expect(row.getCell(4).value == null).toBe(true);
  });

  it('имя листа чистится от знаков, которых Excel не принимает', async () => {
    const wb = await read(
      buildXlsx({ name: 'Остатки / склад [Эркин]: 2026', columns: COLUMNS, rows: ROWS }),
    );
    const name = wb.worksheets[0]!.name;
    expect(name).not.toMatch(/[:\\/?*[\]]/);
    expect(name.length).toBeLessThanOrEqual(31);
  });

  it('отчёт без строк — это лист с одной шапкой, а не битый файл', async () => {
    const wb = await read(buildXlsx({ name: 'Пусто', columns: COLUMNS, rows: [] }));
    expect(wb.worksheets[0]!.getRow(1).getCell(1).value).toBe('Код');
    expect(wb.worksheets[0]!.actualRowCount).toBe(1);
  });

  it('колонок больше двадцати шести: адреса не сбиваются', async () => {
    const columns = Array.from({ length: 30 }, (_, i) => ({ title: `К${i + 1}` }));
    const rows = [Array.from({ length: 30 }, (_, i) => `з${i + 1}`)];
    const wb = await read(buildXlsx({ name: 'Широкий', columns, rows }));
    const sheet = wb.worksheets[0]!;
    expect(sheet.getRow(1).getCell(27).value).toBe('К27');
    expect(sheet.getRow(2).getCell(30).value).toBe('з30');
  });

  it('два одинаковых отчёта дают побайтово одинаковый файл', () => {
    // Дата в записях zip зафиксирована нарочно: иначе сверить выгрузку
    // с эталоном было бы нечем, а разница между файлами ничего не значила бы.
    const a = buildXlsx({ name: 'Остатки', columns: COLUMNS, rows: ROWS });
    const b = buildXlsx({ name: 'Остатки', columns: COLUMNS, rows: ROWS });
    expect(a.equals(b)).toBe(true);
  });
});
