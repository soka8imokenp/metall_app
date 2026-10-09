import { say } from '../common/say.js';
/**
 * Маршрут документа (ТЗ 7.4).
 *
 * Правила отдельно от службы — они здесь единственный источник ответа на
 * вопрос «можно ли из этого статуса в тот». Разбросанные по коду `if`, каждый
 * со своим мнением, однажды разойдутся: один разрешит подписать возвращённый
 * документ, другой запретит.
 */

export const DOCUMENT_STATUSES = [
  'draft',
  'pending_approval',
  'approved',
  'signed',
  'returned',
  'cancelled',
] as const;

export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const DOCUMENT_ACTIONS = ['submit', 'approve', 'return', 'sign', 'cancel'] as const;
export type DocumentAction = (typeof DOCUMENT_ACTIONS)[number];

export interface TransitionRule {
  from: DocumentStatus[];
  to: DocumentStatus;
  /** Право, без которого действие не пройдёт. */
  permission: 'documents.edit' | 'documents.approve';
  /** Слова обязательны: без них запись в журнале ничего не объясняет. */
  needsComment: boolean;
  titleRu: string;
  titleUz: string;
}

/**
 * Кто и куда может двигать документ.
 *
 * Разделение прав — суть требования: счёт выписывает менеджер, утверждает не
 * он. `documents.edit` двигает документ к согласованию, `documents.approve`
 * решает его судьбу.
 *
 * Отмена — правом работы с документами, а не согласования: отзывать свой
 * ошибочный черновик менеджер должен сам, не отвлекая бухгалтерию.
 */
export const TRANSITIONS: Record<DocumentAction, TransitionRule> = {
  submit: {
    from: ['draft', 'returned'],
    to: 'pending_approval',
    permission: 'documents.edit',
    needsComment: false,
    titleRu: 'Отправить на согласование',
    titleUz: 'Kelishishga yuborish',
  },
  approve: {
    from: ['pending_approval'],
    to: 'approved',
    permission: 'documents.approve',
    needsComment: false,
    titleRu: 'Утвердить',
    titleUz: 'Tasdiqlash',
  },
  return: {
    from: ['pending_approval'],
    to: 'returned',
    permission: 'documents.approve',
    // Возврат без причины — это «переделай, а что именно, догадайся».
    // То же правило, что у отказа по обращению и проигрыша сделки в CRM.
    needsComment: true,
    titleRu: 'Вернуть на доработку',
    titleUz: 'Qayta ishlashga qaytarish',
  },
  sign: {
    from: ['approved'],
    to: 'signed',
    permission: 'documents.approve',
    needsComment: false,
    titleRu: 'Отметить подписанным',
    titleUz: 'Imzolangan deb belgilash',
  },
  cancel: {
    // Из любого состояния, кроме уже отменённого. Подписанный тоже: бумага
    // бывает аннулирована после подписи, и запрет здесь означал бы документ,
    // который система считает действующим вопреки жизни. Кто и почему отменил
    // — остаётся в журнале.
    from: ['draft', 'returned', 'pending_approval', 'approved', 'signed'],
    to: 'cancelled',
    permission: 'documents.edit',
    needsComment: true,
    titleRu: 'Отменить',
    titleUz: 'Bekor qilish',
  },
};

/** Статусы, из которых документ ещё живёт своей жизнью. */
export const isFinal = (s: DocumentStatus) => s === 'cancelled';

/**
 * Можно ли править содержимое документа в этом статусе — и что будет.
 *
 * - `draft`, `returned` — правка на месте: документ ещё никто не утверждал;
 * - `pending_approval` — нет: пока его читает согласующий, менять под ним
 *   цифры значит утвердить не то, что смотрели;
 * - `approved`, `signed` — правка заводит новую редакцию, прежняя уходит в
 *   архив со своими файлами и статусом, а документ возвращается в черновик:
 *   утверждали не это;
 * - `cancelled` — нет: отменённое не правят.
 */
export type EditMode = 'inplace' | 'newVersion' | 'forbidden';

export function editMode(status: DocumentStatus): EditMode {
  if (status === 'draft' || status === 'returned') return 'inplace';
  if (status === 'approved' || status === 'signed') return 'newVersion';
  return 'forbidden';
}

export const EDIT_REFUSAL: Record<string, string> = {
  pending_approval:
    'Документ на согласовании: пока его смотрят, менять в нём цифры нельзя. ' +
    'Верните его на доработку или дождитесь решения',
  cancelled: 'Документ отменён: отменённые не правят. Выпишите новый',
};

export const EDIT_REFUSAL_UZ: Record<string, string> = {
  pending_approval:
    'Hujjat kelishishda: uni ko‘rib turganda ichidagi raqamlarni o‘zgartirib bo‘lmaydi. ' +
    'Uni qayta ishlashga qaytaring yoki qarorni kuting',
  cancelled: 'Hujjat bekor qilingan: bekor qilinganlar tahrirlanmaydi. Yangisini yozing',
};

/**
 * Какие действия доступны из этого статуса при этих правах.
 * Экран рисует кнопки по этому же списку — второй перечень на фронте
 * рано или поздно разошёлся бы с сервером.
 */
export function availableActions(
  status: DocumentStatus,
  permissions: Iterable<string>,
): DocumentAction[] {
  const has = new Set(permissions);
  return DOCUMENT_ACTIONS.filter((a) => {
    const rule = TRANSITIONS[a];
    return rule.from.includes(status) && has.has(rule.permission);
  });
}

export class TransitionError extends Error {}

/** Проверка перехода. Отказ объясняет, что не так, а не просто «нельзя». */
export function checkTransition(
  action: DocumentAction,
  status: DocumentStatus,
  comment: string | null | undefined,
): TransitionRule {
  const rule = TRANSITIONS[action];
  if (!rule.from.includes(status)) {
    throw new TransitionError(
      say(
        `Из статуса «${statusRu(status)}» действие «${rule.titleRu}» недоступно. ` +
          `Оно работает из: ${rule.from.map(statusRu).join(', ')}`,
        `«${statusUz(status)}» holatidan «${rule.titleUz}» amali mumkin emas. ` +
          `U quyidagilardan ishlaydi: ${rule.from.map(statusUz).join(', ')}`,
      ),
    );
  }
  if (rule.needsComment && !String(comment ?? '').trim()) {
    throw new TransitionError(
      say(
        `«${rule.titleRu}» требует объяснения: без него в журнале останется ` +
          'действие без причины, а исполнитель не узнает, что переделывать',
        `«${rule.titleUz}» izoh talab qiladi: usiz jurnalda sababsiz amal qoladi, ` +
          'ijrochi esa nimani qayta qilishni bilmaydi',
      ),
    );
  }
  return rule;
}

export const STATUS_RU: Record<DocumentStatus, string> = {
  draft: 'Черновик',
  pending_approval: 'На согласовании',
  approved: 'Утверждён',
  signed: 'Подписан',
  returned: 'Возвращён',
  cancelled: 'Отменён',
};

export const STATUS_UZ: Record<DocumentStatus, string> = {
  draft: 'Qoralama',
  pending_approval: 'Kelishishda',
  approved: 'Tasdiqlangan',
  signed: 'Imzolangan',
  returned: 'Qaytarilgan',
  cancelled: 'Bekor qilingan',
};

const statusRu = (s: DocumentStatus) => STATUS_RU[s] ?? s;
const statusUz = (s: DocumentStatus) => STATUS_UZ[s] ?? s;
