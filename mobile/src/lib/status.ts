import type { Dict } from '@/i18n/ru';
import type { Tone } from '@/ui/components';

export const ORDER_STATUS: Record<string, [keyof Dict, Tone]> = {
  draft: ['prStatusDraft', 'neutral'],
  planned: ['prStatusPlanned', 'neutral'],
  in_progress: ['prStatusInProgress', 'info'],
  paused: ['prStatusPaused', 'warning'],
  produced: ['prStatusProduced', 'success'],
  closed: ['prStatusClosed', 'success'],
  cancelled: ['prStatusCancelled', 'danger'],
};

export const STAGE_STATUS: Record<string, [keyof Dict, Tone]> = {
  pending: ['prStagePending', 'neutral'],
  running: ['prStageRunning', 'info'],
  paused: ['prStagePaused', 'warning'],
  done: ['prStageDone', 'success'],
};

export const MARK_LABEL: Record<string, keyof Dict> = {
  start: 'prMarkStart',
  pause: 'prMarkPause',
  resume: 'prMarkResume',
  finish: 'prMarkFinish',
};

export const FIN_STATUS: Record<string, [keyof Dict, Tone]> = {
  draft: ['fnStDraft', 'neutral'],
  pending_approval: ['fnStPending', 'warning'],
  approved: ['fnStApproved', 'info'],
  posted: ['fnStPosted', 'success'],
  rejected: ['fnStRejected', 'danger'],
  reversed: ['fnStReversed', 'neutral'],
};

export const FIN_TYPE: Record<string, keyof Dict> = {
  income: 'fnIncome',
  expense: 'fnExpense',
  transfer: 'fnTransfer',
  conversion: 'fnConversion',
};

export const DOC_STATUS: Record<string, [keyof Dict, Tone]> = {
  draft: ['dcStDraft', 'neutral'],
  pending_approval: ['dcStPending', 'warning'],
  approved: ['dcStApproved', 'info'],
  signed: ['dcStSigned', 'success'],
  returned: ['dcStReturned', 'danger'],
  rejected: ['dcStReturned', 'danger'],
  cancelled: ['dcStCancelled', 'danger'],
};

export const SALES_STATUS_TONE: Record<string, Tone> = {
  draft: 'neutral',
  confirmed: 'info',
  reserved: 'info',
  in_production: 'info',
  picking: 'warning',
  shipped: 'success',
  closed: 'success',
  cancelled: 'danger',
};
export const PAY_TONE: Record<string, Tone> = { unpaid: 'danger', partial: 'warning', paid: 'success', overdue: 'danger' };
export const NEXT_SALES: Record<string, string[]> = {
  draft: ['confirmed', 'cancelled'],
  confirmed: ['reserved', 'in_production', 'picking', 'cancelled'],
  reserved: ['in_production', 'picking', 'cancelled'],
  in_production: ['picking', 'cancelled'],
  picking: ['cancelled'],
  shipped: ['closed'],
  closed: [],
  cancelled: [],
};

/**
 * Маршрут статуса: где объект на своём пути. Шаги одинаковы для списка и
 * карточки — статус читается как участок трубопровода (пройдено / сейчас /
 * впереди), а не как цветная плашка. `broken` — путь оборван (отказ, отмена).
 */
export type Route = { step: number; total: number; tone: Tone; broken?: boolean; wait?: boolean };

const SALES_STEP: Record<string, number> = { draft: 0, confirmed: 1, reserved: 2, in_production: 2, picking: 3, shipped: 4, closed: 5 };
const FIN_STEP: Record<string, number> = { draft: 0, pending_approval: 1, approved: 2, posted: 3 };
const DOC_STEP: Record<string, number> = { draft: 0, pending_approval: 1, approved: 2, signed: 3 };
const ORDER_STEP: Record<string, number> = { draft: 0, planned: 1, in_progress: 2, paused: 2, produced: 3, closed: 4 };
const STAGE_STEP: Record<string, number> = { pending: 0, running: 1, paused: 1, done: 2 };
const SHEET_STEP: Record<string, number> = { draft: 0, counting: 1, review: 2, approved: 3 };

export function routeOf(kind: 'sales' | 'finance' | 'document' | 'order' | 'stage' | 'inventory', status: string): Route {
  switch (kind) {
    case 'sales':
      if (status === 'cancelled') return { step: 1, total: 6, tone: 'danger', broken: true };
      return { step: SALES_STEP[status] ?? 0, total: 6, tone: SALES_STATUS_TONE[status] ?? 'neutral' };
    case 'finance':
      if (status === 'rejected') return { step: 1, total: 4, tone: 'danger', broken: true };
      if (status === 'reversed') return { step: 3, total: 4, tone: 'neutral', broken: true };
      return { step: FIN_STEP[status] ?? 0, total: 4, tone: FIN_STATUS[status]?.[1] ?? 'neutral', wait: status === 'pending_approval' };
    case 'document':
      if (status === 'returned' || status === 'rejected' || status === 'cancelled') return { step: 1, total: 4, tone: 'danger', broken: true };
      return { step: DOC_STEP[status] ?? 0, total: 4, tone: DOC_STATUS[status]?.[1] ?? 'neutral', wait: status === 'pending_approval' };
    case 'order':
      if (status === 'cancelled') return { step: 1, total: 5, tone: 'danger', broken: true };
      return { step: ORDER_STEP[status] ?? 0, total: 5, tone: ORDER_STATUS[status]?.[1] ?? 'neutral', wait: status === 'paused' };
    case 'inventory':
      if (status === 'cancelled') return { step: 1, total: 4, tone: 'danger', broken: true };
      return { step: SHEET_STEP[status] ?? 0, total: 4, tone: status === 'approved' ? 'success' : status === 'review' ? 'warning' : status === 'counting' ? 'info' : 'neutral', wait: status === 'review' };
    case 'stage':
      return { step: STAGE_STEP[status] ?? 0, total: 3, tone: STAGE_STATUS[status]?.[1] ?? 'neutral', wait: status === 'paused' };
  }
}
