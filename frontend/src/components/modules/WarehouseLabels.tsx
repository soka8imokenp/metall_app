/**
 * Штрихкоды, QR и сканер склада (ТЗ 5.9).
 *
 * Здесь три вещи: поле быстрого ввода со сканера, рисование кода и лист
 * этикеток к печати.
 *
 * Рисунок кода — ширины полос и матрица QR — приходит с сервера готовым.
 * Экран складывает из него прямоугольники и ничего не кодирует сам: разойдись
 * эти два кодирования хоть на символ, напечаталось бы одно, а искалось другое.
 *
 * Лист меряется в миллиметрах, а не в пикселях. Этикетка клеится на трубу, и
 * 70 мм на бумаге должны быть семьюдесятью миллиметрами при любом мониторе;
 * `@page` берёт размер листа из того же шаблона, что и сетка.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Printer, QrCode, ScanLine, X } from 'lucide-react';
import { errorText } from '../../context/DashboardContext';
import { useWarehouse } from '../../context/WarehouseContext';
import type {
  CodeKind,
  CodeSymbol,
  WarehouseLabel,
  WarehouseLabelTemplate,
  WarehouseScanHit,
} from '../../types/api';
import { CustomSelect } from '../common/CustomSelect';
import { CARD } from './warehouse-ui';
import { refName } from '../../lib/formatters';

/** Тихая зона Code 128 по стандарту — десять модулей с каждой стороны. */
const QUIET_128 = 10;
/** Тихая зона QR — четыре модуля. */
const QUIET_QR = 4;

export const KIND_TEXT: Record<CodeKind, { ru: string; uz: string }> = {
  item: { ru: 'Позиция', uz: 'Nomenklatura' },
  batch: { ru: 'Партия', uz: 'Partiya' },
  serial: { ru: 'Серийный номер', uz: 'Seriya raqami' },
  location: { ru: 'Ячейка', uz: 'Yacheyka' },
};

const MATCHED_TEXT: Record<string, { ru: string; uz: string }> = {
  labelCode: { ru: 'по нашей этикетке', uz: 'bizning yorliq bo‘yicha' },
  itemBarcode: { ru: 'по штрихкоду поставщика', uz: 'yetkazuvchi shtrixkodi bo‘yicha' },
  locationBarcode: { ru: 'по штрихкоду ячейки', uz: 'yacheyka shtrixkodi bo‘yicha' },
  serialNumber: { ru: 'по серийному номеру', uz: 'seriya raqami bo‘yicha' },
  itemCode: { ru: 'по коду номенклатуры', uz: 'nomenklatura kodi bo‘yicha' },
};

/* ------------------------------------------------------------------ */
/* Рисунок кода                                                        */
/* ------------------------------------------------------------------ */

/**
 * Code 128: ширины чередуются, начиная с полосы. Рисуются только полосы —
 * пробел между ними это фон, а не белый прямоугольник поверх соседа.
 */
const Bars128: React.FC<{ widths: number[]; modules: number; heightMm: number }> = ({
  widths,
  modules,
  heightMm,
}) => {
  const rects: React.ReactElement[] = [];
  let x = QUIET_128;
  widths.forEach((w, i) => {
    if (i % 2 === 0) {
      rects.push(<rect key={i} x={x} y={0} width={w} height={10} fill="currentColor" />);
    }
    x += w;
  });
  return (
    <svg
      viewBox={`0 0 ${modules + QUIET_128 * 2} 10`}
      preserveAspectRatio="none"
      width="100%"
      height={`${heightMm}mm`}
      shapeRendering="crispEdges"
      aria-hidden
      className="text-zinc-950 dark:text-zinc-950"
    >
      {rects}
    </svg>
  );
};

/**
 * QR: подряд идущие тёмные модули строки сливаются в один прямоугольник.
 * Матрица версии 2 — это 625 клеток, и по прямоугольнику на клетку разметка
 * листа в полсотни этикеток разрастается до десятков тысяч узлов.
 */
const MatrixQr: React.FC<{ size: number; rows: string[]; sideMm: number }> = ({
  size,
  rows,
  sideMm,
}) => {
  const rects: React.ReactElement[] = [];
  rows.forEach((row, y) => {
    let run = 0;
    for (let x = 0; x <= size; x += 1) {
      if (row[x] === '1') {
        run += 1;
        continue;
      }
      if (run > 0) {
        rects.push(
          <rect
            key={`${y}-${x}`}
            x={x - run + QUIET_QR}
            y={y + QUIET_QR}
            width={run}
            height={1}
            fill="currentColor"
          />,
        );
        run = 0;
      }
    }
  });
  const side = size + QUIET_QR * 2;
  return (
    <svg
      viewBox={`0 0 ${side} ${side}`}
      width={`${sideMm}mm`}
      height={`${sideMm}mm`}
      shapeRendering="crispEdges"
      aria-hidden
      className="text-zinc-950 dark:text-zinc-950"
    >
      {rects}
    </svg>
  );
};

export const SymbolView: React.FC<{ symbol: CodeSymbol; widthMm: number; heightMm: number }> = ({
  symbol,
  widthMm,
  heightMm,
}) =>
  symbol.symbology === 'qr' ? (
    <MatrixQr size={symbol.size} rows={symbol.rows} sideMm={Math.min(widthMm, heightMm)} />
  ) : (
    <Bars128 widths={symbol.widths} modules={symbol.modules} heightMm={heightMm} />
  );

/* ------------------------------------------------------------------ */
/* Поле сканера                                                        */
/* ------------------------------------------------------------------ */

/**
 * Внешний сканер притворяется клавиатурой: он «набирает» код за десяток
 * миллисекунд и жмёт Enter. Поэтому поле здесь одно на весь экран и держит
 * фокус само — уйди фокус в таблицу, и следующий штрихкод уедет в никуда
 * или, хуже, в поле формы движения.
 *
 * Фокус возвращается не всегда: пока человек набирает что-то в другом поле,
 * лезть к нему нельзя. Возврат идёт только с тех мест, где ввода нет.
 */
export const ScannerField: React.FC<{ isUz: boolean }> = ({ isUz }) => {
  const { scan, scanning, scanHit, scanError, clearScan } = useWarehouse();
  const [value, setValue] = useState('');
  const ref = useRef<HTMLInputElement>(null);

  // Клик мимо полей ввода возвращает фокус сканеру: кладовщик держит сканер
  // в одной руке и мышь в другой, и «сначала кликни в поле» на каждой трубе —
  // это лишнее движение на каждой трубе.
  useEffect(() => {
    const onPointerUp = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (t.closest('input, textarea, select, button, a, [role="listbox"], [contenteditable]')) {
        return;
      }
      ref.current?.focus();
    };
    document.addEventListener('pointerup', onPointerUp);
    return () => document.removeEventListener('pointerup', onPointerUp);
  }, []);

  const submit = () => {
    const code = value.trim();
    if (!code) return;
    // Поле чистится сразу: следующий штрихкод прилетает через секунду, и
    // дописаться к предыдущему он не должен.
    setValue('');
    void scan(code);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <ScanLine className="w-3.5 h-3.5 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
        <input
          ref={ref}
          autoFocus
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
            if (e.key === 'Escape') {
              setValue('');
              clearScan();
            }
          }}
          placeholder={
            isUz ? 'Skaner yoki kodni qo‘lda kiriting' : 'Сканер или код вручную, затем Enter'
          }
          aria-label={isUz ? 'Kod skaneri' : 'Сканер кода'}
          className="w-full h-9 pl-9 pr-3 rounded-lg border border-dashed border-zinc-300 dark:border-zinc-700 bg-white dark:bg-[#18181b] font-mono text-xs text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 placeholder:font-sans outline-none focus:border-zinc-500 dark:focus:border-zinc-500 transition-colors"
        />
      </div>

      {scanning && (
        <p className="text-[11px] text-zinc-400">{isUz ? 'Qidirilmoqda…' : 'Ищем…'}</p>
      )}
      {scanError && (
        <p className="text-[11px] text-amber-700 dark:text-amber-400 break-words">
          {errorText(scanError, isUz)}
        </p>
      )}
      {scanHit && !scanning && <ScanHitCard hit={scanHit} isUz={isUz} onClose={clearScan} />}
    </div>
  );
};

const ScanHitCard: React.FC<{ hit: WarehouseScanHit; isUz: boolean; onClose: () => void }> = ({
  hit,
  isUz,
  onClose,
}) => {
  const kind = KIND_TEXT[hit.kind];
  const matched = MATCHED_TEXT[hit.matchedBy];
  const title =
    hit.kind === 'item'
      ? hit.code
      : hit.kind === 'location'
        ? `${hit.zoneCode} / ${hit.code}`
        : hit.number;
  const subtitle =
    hit.kind === 'item'
      ? isUz
        ? hit.nameUz
        : refName(hit, isUz)
      : hit.kind === 'location'
        ? hit.warehouseNameRu
        : hit.itemNameRu;

  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/60 px-3 py-2 flex items-start gap-2">
      <div className="flex flex-col gap-0.5 min-w-0 flex-1">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-[10px] uppercase tracking-wide text-zinc-400">
            {isUz ? kind.uz : kind.ru}
          </span>
          <span className="font-mono text-xs font-medium text-zinc-900 dark:text-zinc-100 break-all">
            {title}
          </span>
        </div>
        <span className="text-[11px] text-zinc-600 dark:text-zinc-400 break-words">{subtitle}</span>
        <span className="text-[10px] text-zinc-400 font-mono break-all">
          {hit.labelCode}
          {matched ? ` · ${isUz ? matched.uz : matched.ru}` : ''}
        </span>
      </div>
      {/* Имя кнопки своё и без слова «закрыть»: такие же кнопки есть у пути
          партии и пути номера, а поиск по имени ищет вхождение, не совпадение.
          Одинаковые имена путают и людей, и прогон. */}
      <button
        type="button"
        onClick={onClose}
        aria-label={isUz ? 'Skanerlash natijasini yashirish' : 'Скрыть результат сканирования'}
        className="p-1 rounded-md text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 transition-colors cursor-pointer shrink-0"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Лист этикеток                                                       */
/* ------------------------------------------------------------------ */

const LabelCell: React.FC<{ l: WarehouseLabel; t: WarehouseLabelTemplate }> = ({ l, t }) => {
  // Высота кода — половина этикетки: вторая половина уходит под текст, а без
  // текста человек у полки сверяет наклейку сканером вместо глаз.
  const symbolHeight = Math.max(6, t.labelHeightMm * 0.45);
  return (
    <div
      className="flex flex-col items-center justify-center gap-[1mm] overflow-hidden border border-zinc-200 text-zinc-950"
      style={{
        width: `${t.labelWidthMm}mm`,
        height: `${t.labelHeightMm}mm`,
        padding: '1.5mm',
      }}
    >
      <SymbolView symbol={l.symbol} widthMm={t.labelWidthMm - 3} heightMm={symbolHeight} />
      <span
        className="font-mono leading-none tracking-tight"
        style={{ fontSize: '2.2mm' }}
      >
        {l.labelCode}
      </span>
      <span
        className="font-semibold leading-tight text-center line-clamp-1"
        style={{ fontSize: '2.6mm' }}
      >
        {l.title}
      </span>
      <span className="leading-tight text-center line-clamp-2" style={{ fontSize: '2.1mm' }}>
        {l.subtitle}
      </span>
    </div>
  );
};

/**
 * Лист к печати. Он же предпросмотр: печатать «вслепую» на сорока этикетках
 * нельзя — перекос сетки виден только глазами, а бумага уже испорчена.
 *
 * На бумагу уходят все листы, на экране виден один. Шестьдесят пять этикеток
 * это три листа A4, а три листа A4 подряд — три с половиной метра прокрутки:
 * человек уезжает и от шапки панели, и от кнопки «Печать», и смотрит лист,
 * уже не видя, что именно печатает.
 */
const LabelSheetView: React.FC<{
  labels: WarehouseLabel[];
  t: WarehouseLabelTemplate;
  page: number;
}> = ({ labels, t, page }) => {
  const pages: WarehouseLabel[][] = [];
  for (let i = 0; i < labels.length; i += t.perPage) pages.push(labels.slice(i, i + t.perPage));

  return (
    <div id="label-sheet" className="flex flex-col items-center gap-4 bg-white">
      {/* Размер страницы — настройка шаблона, поэтому и правило печати
          собирается здесь, а не лежит в общем CSS. */}
      <style>{`@page { size: ${t.pageWidthMm}mm ${t.pageHeightMm}mm; margin: 0; }`}</style>
      {pages.map((p, i) => (
        // `contents` вместо обёртки: лишний блок между листом и сеткой сбил бы
        // и разрыв страницы, и отступы, заданные в миллиметрах.
        <div key={i} className={i === page ? 'contents' : 'hidden print:contents'}>
          <div
            className="label-page bg-white"
            style={{
              width: `${t.pageWidthMm}mm`,
              height: `${t.pageHeightMm}mm`,
              paddingTop: `${t.marginTopMm}mm`,
              paddingLeft: `${t.marginLeftMm}mm`,
              display: 'grid',
              gridTemplateColumns: `repeat(${t.columns}, ${t.labelWidthMm}mm)`,
              gridAutoRows: `${t.labelHeightMm}mm`,
              columnGap: `${t.gapXMm}mm`,
              rowGap: `${t.gapYMm}mm`,
              justifyContent: 'start',
              alignContent: 'start',
            }}
          >
            {p.map((l, j) => (
              <LabelCell key={`${l.labelCode}-${j}`} l={l} t={t} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
};

/** 96 dpi: миллиметр — это 3,7795 пикселя экрана. Лист A4 шириной 210 мм — 794 px. */
const MM_PX = 96 / 25.4;

/**
 * Лист в панели: ужимается до ширины панели целиком, а не прокручивается вбок.
 *
 * A4 — это 794 px, панель на телефоне — 294 px. Прокрутка вбок показывала там
 * один столбец из трёх и половину этикетки с краю, то есть ровно то, ради чего
 * предпросмотр и нужен, — перекос сетки — увидеть было нельзя.
 *
 * Сжатие живёт только на экране: `@media print` его снимает, иначе этикетка
 * 70 мм напечаталась бы двадцатью шестью.
 */
const SheetBox: React.FC<{ t: WarehouseLabelTemplate; children: React.ReactNode }> = ({
  t,
  children,
}) => {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const pageW = t.pageWidthMm * MM_PX;
  const pageH = t.pageHeightMm * MM_PX;

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => setScale(Math.min(1, el.clientWidth / pageW));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [pageW]);

  return (
    <div ref={box} className="sheet-box w-full flex justify-center">
      <div className="sheet-slot" style={{ width: pageW * scale, height: pageH * scale }}>
        <div
          className="sheet-scale"
          style={{ width: pageW, transform: `scale(${scale})`, transformOrigin: 'top left' }}
        >
          {children}
        </div>
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Панель печати                                                       */
/* ------------------------------------------------------------------ */

const KIND_ORDER: CodeKind[] = ['item', 'batch', 'serial', 'location'];

/**
 * Панель «Этикетки»: что печатаем, на каком шаблоне и сколько копий.
 *
 * Вид объекта выбирается один на всю пачку, а не на строку: этикетки клеят
 * пачкой на одно и то же — на партии прихода или на ячейки стеллажа, — и
 * спрашивать это у каждой строки значит спрашивать сорок раз подряд.
 *
 * Панель — окно постоянного размера: настройки и кнопка «Печать» стоят на
 * месте, прокручивается только лист. Растущее окно уводило кнопку печати за
 * край экрана тем дальше, чем больше этикеток напечатано.
 */
export const LabelsPanel: React.FC<{ isUz: boolean; onClose: () => void }> = ({
  isUz,
  onClose,
}) => {
  const {
    stock,
    labelKeys,
    labelKind,
    setLabelKind,
    labelTemplates,
    labelSheet,
    buildLabels,
    labelBusy,
    labelError,
    clearLabelSheet,
  } = useWarehouse();

  const [templateUid, setTemplateUid] = useState<string>('');
  const [copies, setCopies] = useState(1);
  const [page, setPage] = useState(0);

  const templates = useMemo(() => labelTemplates.data?.rows ?? [], [labelTemplates.data]);

  // Шаблон по умолчанию подставляется сам: у компании он ровно один, и
  // выбирать его каждый раз заново незачем.
  useEffect(() => {
    if (templateUid || templates.length === 0) return;
    setTemplateUid((templates.find((t) => t.isDefault) ?? templates[0]).uid);
  }, [templates, templateUid]);

  const selected = useMemo(() => {
    const keys = new Set(labelKeys);
    return (stock.data?.rows ?? []).filter((r) => keys.has(r.key));
  }, [stock.data, labelKeys]);

  // Один код на объект, а не на строку: партия лежит в двух ячейках двумя
  // строками остатка, а наклейка на ней одна.
  const codes = useMemo(
    () => [...new Set(selected.map((r) => r.labelCodes[labelKind]).filter((c): c is string => !!c))],
    [selected, labelKind],
  );

  // Строки выбраны, а этикетки уже построены по прежнему набору — показывать
  // их нельзя: человек напечатал бы не то, что отметил.
  useEffect(() => {
    clearLabelSheet();
  }, [codes.join(','), templateUid, copies, clearLabelSheet]);

  // Новый лист смотрят с первой страницы, а не с той, где остановились на
  // прошлой пачке.
  useEffect(() => {
    setPage(0);
  }, [labelSheet]);

  const total = codes.length * copies;
  const template = templates.find((t) => t.uid === templateUid) ?? null;
  const sheetPages = labelSheet
    ? Math.max(1, Math.ceil(labelSheet.labels.length / labelSheet.template.perPage))
    : 0;

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4 print:static print:bg-transparent print:p-0 print:block">
      <div
        className={`${CARD} w-full max-w-4xl max-h-[92dvh] flex flex-col overflow-hidden print:border-0 print:shadow-none print:max-w-none print:max-h-none print:overflow-visible`}
        role="dialog"
        aria-label={isUz ? 'Yorliqlar' : 'Этикетки'}
      >
        <div className="shrink-0 px-4 py-3 flex items-center justify-between gap-2 border-b border-zinc-200 dark:border-zinc-800 print:hidden">
          <div className="flex items-center gap-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            <QrCode className="w-4 h-4 shrink-0" />
            {isUz ? 'Yorliqlarni chop etish' : 'Печать этикеток'}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={isUz ? 'Yorliqlarni yopish' : 'Закрыть этикетки'}
            className="p-1 rounded-md text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="shrink-0 px-4 py-3 flex flex-col gap-3 print:hidden">
          {/* Копий — это число до пятидесяти. Поле во всю треть панели обещало
              строку, а принимало две цифры. */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_5.5rem]">
            <div className="flex flex-col gap-1 min-w-0">
              <span className="text-[11px] text-zinc-500">{isUz ? 'Nima' : 'Что печатаем'}</span>
              <CustomSelect
                ariaLabel={isUz ? 'Nima chop etiladi' : 'Что печатаем'}
                value={labelKind}
                onChange={(v) => setLabelKind(v as CodeKind)}
                options={KIND_ORDER.map((k) => ({
                  value: k,
                  label: isUz ? KIND_TEXT[k].uz : KIND_TEXT[k].ru,
                }))}
              />
            </div>

            <div className="flex flex-col gap-1 min-w-0">
              <span className="text-[11px] text-zinc-500">{isUz ? 'Shablon' : 'Шаблон'}</span>
              <CustomSelect
                ariaLabel={isUz ? 'Yorliq shabloni' : 'Шаблон этикетки'}
                value={templateUid}
                onChange={setTemplateUid}
                options={templates.map((t) => ({
                  value: t.uid,
                  label: `${t.code} · ${t.labelWidthMm}×${t.labelHeightMm} ${isUz ? 'mm' : 'мм'} · ${
                    t.symbology === 'qr' ? 'QR' : 'Code 128'
                  }`,
                }))}
              />
            </div>

            <label className="flex flex-col gap-1 min-w-0">
              <span className="text-[11px] text-zinc-500">{isUz ? 'Nusxalar' : 'Копий'}</span>
              <input
                type="number"
                aria-label={isUz ? 'Nusxalar soni' : 'Число копий'}
                min={1}
                max={50}
                value={copies}
                onChange={(e) => setCopies(Math.min(50, Math.max(1, Number(e.target.value) || 1)))}
                className="w-full h-8 px-2.5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-xs text-zinc-950 dark:text-zinc-50 outline-none focus:border-zinc-400 transition-colors"
              />
            </label>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11px] text-zinc-500 min-w-0 break-words">
              {isUz
                ? `${selected.length} qatordan ${codes.length} ta obyekt, jami ${total} yorliq`
                : `Отмечено строк: ${selected.length}, объектов: ${codes.length}, этикеток: ${total}`}
              {template
                ? ` · ${isUz ? 'varaqda' : 'на листе'} ${template.perPage} · ${
                    isUz ? 'varaqlar' : 'листов'
                  } ${Math.max(1, Math.ceil(total / template.perPage))}`
                : ''}
            </span>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                disabled={!templateUid || codes.length === 0 || labelBusy}
                onClick={() => void buildLabels(templateUid, copies, codes)}
                className="h-8 px-3 rounded-lg text-xs font-medium whitespace-nowrap bg-zinc-900 text-zinc-50 hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
              >
                {labelBusy
                  ? isUz
                    ? 'Tayyorlanmoqda…'
                    : 'Готовим…'
                  : isUz
                    ? 'Ko‘rish'
                    : 'Предпросмотр'}
              </button>
              <button
                type="button"
                disabled={!labelSheet}
                onClick={() => window.print()}
                className="h-8 px-3 inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-xs font-medium whitespace-nowrap text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
              >
                <Printer className="w-3.5 h-3.5 shrink-0" />
                {isUz ? 'Chop etish' : 'Печать'}
              </button>
            </div>
          </div>

          {codes.length === 0 && (
            <p className="text-[11px] text-zinc-400">
              {isUz
                ? 'Belgilangan qatorlarda bunday obyekt yo‘q: boshqa turni yoki boshqa qatorlarni tanlang.'
                : 'В отмеченных строках такого объекта нет: выберите другой вид или другие строки.'}
            </p>
          )}
          {labelError && (
            <p className="text-[11px] text-amber-700 dark:text-amber-400 break-words">
              {errorText(labelError, isUz)}
            </p>
          )}
        </div>

        {labelSheet ? (
          <>
            <div className="shrink-0 px-4 py-2 border-t border-zinc-200 dark:border-zinc-800 flex items-center justify-between gap-2 print:hidden">
              <span className="text-[11px] text-zinc-500 min-w-0 break-words">
                {isUz ? 'Varaq' : 'Лист'} {page + 1} {isUz ? 'dan' : 'из'} {sheetPages} ·{' '}
                {labelSheet.template.pageWidthMm}×{labelSheet.template.pageHeightMm} {isUz ? 'mm' : 'мм'}
              </span>
              {sheetPages > 1 && (
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    disabled={page === 0}
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    aria-label={isUz ? 'Oldingi varaq' : 'Предыдущий лист'}
                    className="h-7 w-7 inline-flex items-center justify-center rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    disabled={page >= sheetPages - 1}
                    onClick={() => setPage((p) => Math.min(sheetPages - 1, p + 1))}
                    aria-label={isUz ? 'Keyingi varaq' : 'Следующий лист'}
                    className="h-7 w-7 inline-flex items-center justify-center rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
                  >
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-4 bg-zinc-100 dark:bg-zinc-950 print:border-0 print:p-0 print:bg-white print:overflow-visible">
              <SheetBox t={labelSheet.template}>
                <LabelSheetView labels={labelSheet.labels} t={labelSheet.template} page={page} />
              </SheetBox>
            </div>
          </>
        ) : (
          <div className="shrink-0 px-4 pb-4 print:hidden">
            <div className="rounded-lg border border-dashed border-zinc-300 dark:border-zinc-700 px-4 py-6 flex flex-col items-center gap-1 text-center">
              <Printer className="w-4 h-4 text-zinc-400" />
              <span className="text-[11px] text-zinc-500 break-words">
                {isUz
                  ? 'Varaq shu yerda paydo bo‘ladi: avval «Ko‘rish», keyin «Chop etish».'
                  : 'Лист появится здесь: сначала «Предпросмотр», потом «Печать».'}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
