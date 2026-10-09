/**
 * Подписи статуса документа.
 *
 * Отдельным файлом, потому что их читают два экрана: реестр с карточкой и
 * блок согласования. Второй перечень статусов однажды разошёлся бы с первым,
 * и один экран называл бы документ утверждённым, а другой — подписанным.
 */
import type { DocumentStatus } from '../../types/api';

export const DOCUMENT_STATUS: Record<DocumentStatus, { ru: string; uz: string; cls: string }> = {
  draft: {
    ru: 'Черновик',
    uz: 'Qoralama',
    cls: 'text-zinc-600 dark:text-zinc-400 border-zinc-200 dark:border-zinc-700',
  },
  pending_approval: {
    ru: 'На согласовании',
    uz: 'Kelishuvda',
    cls: 'text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-900/60',
  },
  approved: {
    ru: 'Утверждён',
    uz: 'Tasdiqlangan',
    cls: 'text-sky-700 dark:text-sky-400 border-sky-200 dark:border-sky-900/60',
  },
  signed: {
    ru: 'Подписан',
    uz: 'Imzolangan',
    cls: 'text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-900/60',
  },
  returned: {
    ru: 'Возвращён',
    uz: 'Qaytarilgan',
    cls: 'text-rose-700 dark:text-rose-400 border-rose-200 dark:border-rose-900/60',
  },
  cancelled: {
    ru: 'Отменён',
    uz: 'Bekor qilingan',
    cls: 'text-zinc-500 border-zinc-200 dark:border-zinc-700',
  },
};

/**
 * Подпись статуса берётся с запасным вариантом: новое значение на сервере не
 * должно ронять экран, пока ему не завели перевод. Ровно на этом падала
 * карточка клиента, когда в CRM добавились счётчики задач.
 */
export const statusText = (code: string, isUz: boolean) => {
  const s = DOCUMENT_STATUS[code as DocumentStatus];
  return s ? (isUz ? s.uz : s.ru) : code;
};

export const statusCls = (code: string) =>
  DOCUMENT_STATUS[code as DocumentStatus]?.cls ?? 'border-zinc-200';
