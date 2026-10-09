/**
 * Устройство разговора о продажах: порядок вопросов в новом заказе и разбор
 * того, что человек написал.
 *
 * Отдельно от экранов и без зависимостей: заказ собирается из нескольких
 * позиций, и порядок «позиция → количество → цена → ещё позиция» — главное,
 * что здесь можно сломать незаметно.
 */
import type { SectionFlow } from './section.js';

export type Step =
  /** Поиск заказа: разговор без мастера, человек пишет номер или клиента. */
  | 'search'
  | 'company'
  | 'partner'
  | 'item'
  | 'qty'
  | 'price'
  | 'priceWhy'
  | 'more'
  | 'warehouse'
  | 'due'
  | 'confirm'
  /** Отгрузка по заказу: количество по каждой строке, машина, подтверждение. */
  | 'shipQty'
  | 'shipBatch'
  | 'shipInfo'
  | 'shipConfirm';

/** Строка заказа, как её собрал разговор. */
export interface Line {
  itemCode: string;
  itemName: string;
  unit: string;
  qty: string;
  /** Цена за единицу. Пусто — подставит прайс на сервере. */
  price?: string;
  /** Откуда цена: из прайса или названа руками. */
  source?: 'list' | 'manual';
  /** Обязателен, когда цену назвали руками. */
  priceComment?: string;
}

/** Строка заказа, которую собираются отгрузить. */
export interface ShipLine {
  lineUid: string;
  itemName: string;
  unit: string;
  /** Сколько ещё не уехало по этой строке. */
  remaining: string;
  /** Сколько свободно на складе прямо сейчас. */
  available: string;
  /** Сколько повезут. Пусто — строку ещё не спрашивали. */
  qty?: string;
  /**
   * Партионный учёт: сервер сам партию не выбирает — в накладной должен стоять
   * номер той, которую реально грузят. Поэтому её спрашиваем.
   */
  trackBatches: boolean;
  batches: { number: string; available: string }[];
  batch?: string;
}

export interface Flow extends SectionFlow {
  kind: 'sales';
  step: Step;
  companyUid?: string;
  companyName?: string;
  partnerUid?: string;
  partnerName?: string;
  /** Отсрочка по договору с этим покупателем, дней. */
  partnerDelay?: number;
  /** Откуда повезут: склад заказа. Без него отгрузка не знает, что снимать. */
  warehouseCode?: string;
  warehouseName?: string;
  /**
   * У компании один склад — вопрос не задаём. Признак хранится в разговоре, а
   * не вычисляется заново: порядок шагов должен оставаться тем же до конца
   * мастера, иначе «назад» уведёт человека не туда.
   */
  oneWarehouse?: boolean;
  /** Что сказал прайс о цене текущей позиции: показать и объяснить. */
  hintPrice?: string;
  hintSource?: 'partner' | 'list' | 'none';
  hintCost?: string;
  lines?: Line[];
  /** Позиция, о которой идёт разговор прямо сейчас. */
  draft?: Line;
  dueDate?: string;
  comment?: string;
  orderUid?: string;
  orderNumber?: string;
  vehicle?: string;
  driver?: string;
  /** Строки отгрузки по порядку и та, о которой спрашивают сейчас. */
  shipLines?: ShipLine[];
  shipAt?: number;
  key?: string;
}

/** Порядок вопросов нового заказа. Цену спрашиваем только когда прайс молчит. */
export function order(flow: Flow, many: boolean): Step[] {
  const steps: Step[] = [];
  if (many) steps.push('company');
  steps.push('partner', 'item', 'qty', 'price');
  // «Почему такая цена» спрашиваем только у названной руками: у цены из прайса
  // объяснение уже есть — прайс.
  if (flow.draft?.source === 'manual') steps.push('priceWhy');
  steps.push('more');
  // Склад спрашиваем после спецификации: он один на заказ, и от него зависит,
  // что покажет наличие и откуда поедет машина.
  if (!flow.oneWarehouse) steps.push('warehouse');
  steps.push('due', 'confirm');
  return steps;
}

/**
 * Следующий вопрос.
 *
 * Цену показываем всегда — но если прайс её знает, человеку остаётся нажать
 * кнопку. Молча подставить цену нельзя: менеджер обещает её клиенту вслух и
 * должен видеть, что обещает.
 */
export function nextStep(flow: Flow, many: boolean): Step {
  const all = order(flow, many);
  const i = all.indexOf(flow.step);
  if (i < 0) return all[0]!;
  return all[Math.min(i + 1, all.length - 1)]!;
}

export function prevStep(flow: Flow, many: boolean): Step | null {
  const all = order(flow, many);
  const i = all.indexOf(flow.step);
  return i <= 0 ? null : all[i - 1]!;
}

/** Количество из сообщения: шесть знаков после запятой — как хранит база. */
export function parseQty(raw: string): string | null {
  const cleaned = raw.replace(/[\s  '`’]/g, '').replace(',', '.');
  if (!/^\d{1,13}(\.\d{1,6})?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) && value > 0 ? String(value) : null;
}

/** Цена за единицу: больше нуля. Ноль в заказе означал бы подарок. */
export function parsePrice(raw: string): string | null {
  const cleaned = raw.replace(/[\s  '`’]/g, '').replace(',', '.');
  if (!/^\d{1,15}(\.\d{1,4})?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) && value > 0 ? String(value) : null;
}

/** Итог по строке без НДС: количество на цену. Для экрана проверки. */
export function lineTotal(line: Line): number {
  return Number(line.qty) * Number(line.price ?? 0);
}
