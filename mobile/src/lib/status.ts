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
