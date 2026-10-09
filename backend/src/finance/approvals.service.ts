import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { currentContext } from '../common/request-context.js';
import { writeAudit } from '../common/audit.js';
import { ORDER_SOURCE, recalcOrderPayment } from '../sales/order-payment.js';
import type { OperationStatus } from './operations.service.js';
import { MSG } from '../common/messages.js';
import { say } from '../common/say.js';
import { assertApprovalAllowed } from './approval-limits.js';

/**
 * Жизненный путь финансовой операции.
 *
 * Разрешённые переходы заданы одним списком, а не россыпью `if` по маршрутам:
 * путь у заявки один, и он должен читаться целиком в одном месте. Всё, чего в
 * списке нет, — конфликт, а не «ну ладно, пропустим».
 *
 * Проводки создаются ровно в момент проведения и ровно две. Ни «утверждена»,
 * ни «на согласовании» остаток счёта не трогают: обещание заплатить — ещё не
 * платёж, и в сальдо ему места нет.
 *
 * Защита от двойного нажатия — поле `version`. Клиент присылает ту версию,
 * которую видел на экране, обновление идёт условием `version = ожидаемая`, и
 * второй такой же запрос просто не находит строку. Это же ловит правку из
 * соседней вкладки — без блокировок и без «кто последний, тот и прав».
 */

export type Action = 'submit' | 'approve' | 'reject' | 'post';

/** Из какого статуса в какой. Ключ — действие, а не статус: так короче. */
const TRANSITIONS: Record<Action, { from: OperationStatus[]; to: OperationStatus }> = {
  submit: { from: ['draft'], to: 'pending_approval' },
  approve: { from: ['pending_approval'], to: 'approved' },
  reject: { from: ['pending_approval', 'approved'], to: 'rejected' },
  post: { from: ['approved'], to: 'posted' },
};

const HUMAN: Record<OperationStatus, string> = {
  draft: 'черновик',
  pending_approval: 'на согласовании',
  approved: 'утверждена',
  posted: 'проведена',
  rejected: 'отклонена',
  reversed: 'сторнирована',
};

const HUMAN_UZ: Record<OperationStatus, string> = {
  draft: 'qoralama',
  pending_approval: 'kelishishda',
  approved: 'tasdiqlangan',
  posted: 'o‘tkazilgan',
  rejected: 'rad etilgan',
  reversed: 'storno qilingan',
};

export type ApplyResult = {
  uid: string;
  number: string;
  status: OperationStatus;
  version: number;
  entries: number;
};

@Injectable()
export class ApprovalsService {
  constructor(private readonly prisma: PrismaService) {}

  async apply(
    uid: string,
    action: Action,
    params: { version: number; comment?: string },
  ): Promise<ApplyResult> {
    const userId = currentContext()?.userId ?? null;

    return this.prisma.withTenant(async (tx) => {
      const op = await tx.financeOperation.findUnique({
        where: { uid },
        select: {
          id: true,
          companyId: true,
          number: true,
          status: true,
          version: true,
          operationType: true,
          accountId: true,
          counterAccountId: true,
          amountBase: true,
          occurredAt: true,
          // Получатель нужен порогу подтверждения: предел за период считается
          // на одного получателя, а не на компанию целиком.
          partnerId: true,
          sourceDocType: true,
          sourceDocId: true,
        },
      });

      // Чужая компания отсекается политикой RLS ещё в выборке, поэтому здесь
      // она неотличима от несуществующей. Так и надо: по коду ответа нельзя
      // узнать, что операция с таким uid вообще есть у соседа.
      if (!op) throw new NotFoundException(MSG.operationNotFound());

      const rule = TRANSITIONS[action];
      if (!rule.from.includes(op.status)) {
        throw new ConflictException(say(`Операция ${HUMAN[op.status]}: такой переход из этого состояния не разрешён`, `Operatsiya ${HUMAN_UZ[op.status]}: bu holatdan shunday o‘tish ruxsat etilmagan`));
      }

      // Счёт-корреспондент проверяем до смены статуса: операция без него
      // непроводима, и лучше отказать сразу, чем оставить её «проведённой»
      // без единой проводки.
      if (action === 'post' && op.counterAccountId === null) {
        throw new ConflictException(say('У операции не указан счёт-корреспондент: провести её нечем', 'Operatsiyada korrespondent hisob ko‘rsatilmagan: uni o‘tkazishga asos yo‘q'));
      }

      // Порог подтверждения (требование заказчика 07.10). Проверка здесь, а не
      // декоратором на маршруте: через `apply()` идёт и бот из Telegram, а
      // право на крупный платёж обязано держать оба входа одинаково.
      //
      // Только на `approve`: «отклонить» и «отправить на согласование» порог не
      // касается — он про того, кто говорит деньгам «да».
      if (action === 'approve') {
        await assertApprovalAllowed(tx, op);
      }

      const moved = await tx.financeOperation.updateMany({
        where: { id: op.id, version: params.version },
        data: {
          status: rule.to,
          version: { increment: 1 },
          ...(action === 'approve' ? { approvedBy: userId } : {}),
          ...(action === 'post' ? { postedAt: new Date() } : {}),
          ...(params.comment ? { comment: params.comment } : {}),
        },
      });

      // Ноль строк — версия не та: либо клиент показывает устаревшую карточку,
      // либо это второе нажатие той же кнопки. Снаружи это один и тот же случай.
      if (moved.count === 0) {
        throw new ConflictException(say('Операцию уже изменили: обновите страницу и повторите действие', 'Operatsiya allaqachon o‘zgargan: sahifani yangilab, amalni takrorlang'));
      }

      const entries = action === 'post' ? await this.createEntries(tx, op) : 0;

      // Проведение платежа по заказу — тот самый момент, когда долг покупателя
      // уменьшается: до проведения это обещание. Пересчёт зовём здесь, потому
      // что статус меняется здесь, и второго места у этого события нет.
      if (action === 'post' && op.sourceDocType === ORDER_SOURCE && op.sourceDocId !== null) {
        await recalcOrderPayment(tx, op.sourceDocId);
      }

      // Журнал действий (ТЗ 3.4). Переход по статусу — это и есть решение о
      // деньгах: кто отправил, кто утвердил, кто провёл. В самой операции
      // видно только последнее состояние, а спрашивают весь путь.
      await writeAudit(tx, {
        companyId: op.companyId,
        entityType: 'finance_operation',
        entityId: uid,
        action,
        changes: {
          status: { from: op.status, to: rule.to },
          number: { from: null, to: op.number },
          amount: { from: null, to: Number(op.amountBase) },
          ...(params.comment ? { comment: { from: null, to: params.comment } } : {}),
          ...(entries > 0 ? { entries: { from: 0, to: entries } } : {}),
        },
      });

      return {
        uid,
        number: op.number,
        status: rule.to,
        version: params.version + 1,
        entries,
      };
    });
  }

  /**
   * Две проводки одной вставкой: сходимость дебета и кредита база проверяет
   * отложенным ограничением в конце транзакции, так что порядок строк внутри
   * значения не имеет, а вот разрывать их на две транзакции нельзя.
   *
   * Сторона зависит от типа операции. У поступления деньги ложатся на счёт
   * операции (дебет), а источник кредитуется. У расхода, перевода и покупки
   * валюты наоборот: со счёта операции деньги уходят (кредит), принимает их
   * счёт-корреспондент. Перепутать стороны — значит увезти наличные из кассы
   * в банк вместо обратного, и сальдо разъедется молча.
   */
  private async createEntries(
    tx: Tx,
    op: {
      id: bigint;
      companyId: bigint;
      operationType: string;
      accountId: bigint;
      counterAccountId: bigint | null;
      amountBase: unknown;
      occurredAt: Date;
    },
  ): Promise<number> {
    const income = op.operationType === 'income';
    const debitAccount = income ? op.accountId : op.counterAccountId!;
    const creditAccount = income ? op.counterAccountId! : op.accountId;
    const amount = op.amountBase as never;

    const created = await tx.financeEntry.createMany({
      data: [
        {
          operationId: op.id,
          companyId: op.companyId,
          accountId: debitAccount,
          debit: amount,
          credit: 0,
          amountBase: amount,
          occurredAt: op.occurredAt,
        },
        {
          operationId: op.id,
          companyId: op.companyId,
          accountId: creditAccount,
          debit: 0,
          credit: amount,
          amountBase: amount,
          occurredAt: op.occurredAt,
        },
      ],
    });

    return created.count;
  }
}
