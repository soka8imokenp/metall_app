/**
 * Устройство разговора о складе: какие бывают движения, о чём спрашивать и в
 * каком порядке.
 *
 * Отдельным файлом без зависимостей — порядок шагов здесь главное, и проверяется
 * он без базы и без Telegram. Порядок непостоянный: у списания нет склада
 * получения, у штучной трубы нет количества, а партию спрашивают только у той
 * номенклатуры, которая учитывается партиями. Собирать это цепочкой `if` по
 * экранам значит однажды спросить ячейку у выдачи в цех.
 */
import type { SectionFlow } from './section.js';

/** Типы движений, которые человек делает руками. Отгрузка и выпуск — не здесь. */
export const MOVE_KINDS = [
  'receipt',
  'write_off',
  'transfer',
  'issue_to_production',
  'return_from_production',
  'return_from_client',
  'surplus',
] as const;

export type MoveKind = (typeof MOVE_KINDS)[number];

/** Какие стороны есть у движения: откуда берём и куда кладём. */
export const SIDES: Record<MoveKind, { from: boolean; to: boolean }> = {
  receipt: { from: false, to: true },
  write_off: { from: true, to: false },
  transfer: { from: true, to: true },
  issue_to_production: { from: true, to: false },
  return_from_production: { from: false, to: true },
  return_from_client: { from: false, to: true },
  surplus: { from: false, to: true },
};

/** Виды причин, которые годятся этому типу. Пусто — причину не спрашиваем. */
export const REASON_KINDS: Partial<Record<MoveKind, string[]>> = {
  write_off: ['write_off', 'defect'],
  surplus: ['inventory'],
};

/**
 * Нужен ли контрагент и кто это. `need` — без него сервер откажет, `ask` —
 * спрашиваем, но можно пропустить.
 */
export const PARTNER: Partial<Record<MoveKind, { role: 'supplier' | 'client'; need: boolean }>> = {
  receipt: { role: 'supplier', need: false },
  return_from_client: { role: 'client', need: true },
};

export type Step =
  | 'company'
  | 'item'
  | 'qty'
  | 'serial'
  | 'batch'
  | 'fromWarehouse'
  | 'fromLocation'
  | 'toWarehouse'
  | 'toLocation'
  | 'cost'
  | 'reason'
  | 'partner'
  | 'comment'
  | 'confirm'
  /** Разговоры вне мастера движения: пересчёт строки листа и поиск остатка. */
  | 'countQty'
  | 'stockSearch'
  /**
   * Бот ждёт фотографию к уже записанному движению. В список вопросов шаг не
   * входит: это ожидание файла, а не поле для заполнения.
   */
  | 'photo';

export interface Flow extends SectionFlow {
  kind: 'wh';
  step: Step;
  /** К какому движению ждём фотографию и что на нём было. */
  photoFor?: string;
  photoWhat?: string;
  type?: MoveKind;
  companyUid?: string;
  companyName?: string;
  itemCode?: string;
  itemName?: string;
  unit?: string;
  trackBatches?: boolean;
  trackSerials?: boolean;
  qty?: string;
  serial?: string;
  batch?: string;
  fromWarehouse?: string;
  fromWarehouseName?: string;
  fromCells?: boolean;
  fromLocation?: string;
  toWarehouse?: string;
  toWarehouseName?: string;
  toCells?: boolean;
  toLocation?: string;
  cost?: string;
  reasonId?: string;
  reasonName?: string;
  partnerUid?: string;
  partnerName?: string;
  comment?: string;
  /** Строка листа пересчёта, которую считают. */
  lineUid?: string;
  lineTitle?: string;
  lineExpected?: string;
  sheetUid?: string;
  key?: string;
}

/**
 * Порядок вопросов для этого движения.
 *
 * Зависит от того, что человек уже выбрал: партия — от номенклатуры, ячейка —
 * от того, есть ли ячейки на выбранном складе. Поэтому число шагов уточняется
 * по ходу, и это честнее, чем обещать семь, а спросить восемь.
 */
export function order(flow: Flow, many: boolean): Step[] {
  const type = flow.type;
  if (!type) return ['confirm'];
  const sides = SIDES[type];
  const steps: Step[] = [];
  if (many) steps.push('company');
  steps.push('item');
  // Штучный учёт: одно движение — одна труба, количество спрашивать нечего.
  steps.push(flow.trackSerials ? 'serial' : 'qty');
  if (flow.trackBatches) steps.push('batch');
  if (sides.from) {
    steps.push('fromWarehouse');
    if (flow.fromCells !== false) steps.push('fromLocation');
  }
  if (sides.to) {
    steps.push('toWarehouse');
    if (flow.toCells !== false) steps.push('toLocation');
  }
  // Цену спрашиваем только у прихода: у расхода и перемещения её считает
  // метод компании, и назначать её заново значит переписать историю закупки.
  if (type === 'receipt') steps.push('cost');
  if (REASON_KINDS[type]) steps.push('reason');
  if (PARTNER[type]) steps.push('partner');
  steps.push('comment', 'confirm');
  return steps;
}

export function nextStep(flow: Flow, many: boolean): Step {
  const all = order(flow, many);
  const i = all.indexOf(flow.step);
  // Шага нет в списке — его только что вычеркнуло уточнение (штучная труба
  // вместо количества). Тогда следующий — первый из тех, что ещё не заполнен.
  if (i < 0) return all[0]!;
  return all[Math.min(i + 1, all.length - 1)]!;
}

export function prevStep(flow: Flow, many: boolean): Step | null {
  const all = order(flow, many);
  const i = all.indexOf(flow.step);
  return i <= 0 ? null : all[i - 1]!;
}

/**
 * Количество из сообщения. Дробное бывает: тонны и погонные метры.
 *
 * Шесть знаков после запятой — ровно столько, сколько хранит база. Меньше
 * означало бы, что пересчёт нельзя подтвердить тем числом, которое система сама
 * же показывает: кладовщик вводит 114,526542, а бот отвечает «это не похоже на
 * количество».
 */
export function parseQty(raw: string): string | null {
  const cleaned = raw.replace(/[\s  '`’]/g, '').replace(',', '.');
  if (!/^\d{1,13}(\.\d{1,6})?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value <= 0) return null;
  return String(value);
}

/** Цена за единицу: ноль разрешён — это «не знаю», но осознанное. */
export function parseCost(raw: string): string | null {
  const cleaned = raw.replace(/[\s  '`’]/g, '').replace(',', '.');
  if (!/^\d{1,15}(\.\d{1,4})?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) && value >= 0 ? String(value) : null;
}
