import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { currentContext } from '../common/request-context.js';
import { writeAudit } from '../common/audit.js';
import { ORDER_SOURCE, paymentState, recalcOrderPayment } from '../sales/order-payment.js';
import type { OperationStatus, OperationType } from './operations.service.js';
import { MSG } from '../common/messages.js';
import { say } from '../common/say.js';

/**
 * Заведение, правка и сторно финансовой операции.
 *
 * Переходы по статусам живут в `approvals.service.ts`; здесь то, откуда
 * операция берётся и чем её отменяют.
 *
 * Правка разрешена только черновику. Как только заявку отправили на
 * согласование, её сумма и счета — то, на что смотрел согласующий, и менять
 * их за его спиной нельзя. Проведённую не правят вовсе: проводки уже ушли
 * в отчётность, и единственный законный способ отменить — сторно, то есть
 * вторая операция с зеркальными проводками. Обе остаются в журнале, и по
 * нему видно, что именно отменили и почему.
 */

/** Префикс номера по типу операции. Номер не меняется при смене статуса. */
/** Деньги в отказе — человеку, а не разработчику: «1 250 000,00». */
const RU = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt = (value: number) => RU.format(value);

const PREFIX: Record<OperationType, string> = {
  income: 'ПП',
  expense: 'РП',
  transfer: 'ПЕР',
  conversion: 'КНВ',
};

export type CreateInput = {
  companyUid?: string;
  operationType: OperationType;
  accountCode: string;
  counterAccountCode: string;
  amount: string;
  currencyCode: string;
  rate?: string;
  occurredAt?: string;
  plannedDate?: string;
  cashflowItemUid?: string;
  partnerUid?: string;
  comment?: string;
  /**
   * Заказ, который этим платежом оплачивают (ТЗ 6.1: привязка платежа к
   * заказу). Только для поступления: по заказу деньги приходят.
   */
  salesOrderUid?: string;
};

export type PatchInput = {
  version: number;
  accountCode?: string;
  counterAccountCode?: string;
  amount?: string;
  currencyCode?: string;
  rate?: string;
  occurredAt?: string;
  plannedDate?: string;
  cashflowItemUid?: string;
  partnerUid?: string;
  comment?: string;
};

type Brief = {
  uid: string;
  number: string;
  status: OperationStatus;
  version: number;
  entries: number;
};

@Injectable()
export class WriteService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Справочники для формы: без них экран не сможет предложить ни счёт, ни статью.
   *
   * Каждая строка помечена компанией. Это не украшение ответа: счёт, статья ДДС
   * и контрагент существуют внутри компании, а у пользователя их может быть
   * несколько — тогда список приезжает объединённым. Названия при этом совпадают
   * дословно («Заработная плата» дважды, счёт 5010 дважды), и без пометки форма
   * не может отличить свою строку от чужой. Выбранная чужая даёт 422 на
   * сохранении — отказ, которого человек не заслужил: он выбирал из того списка,
   * что ему выдали.
   */
  async refs() {
    return this.prisma.withTenant(async (tx) => {
      const [accounts, items, currencies, partners] = await Promise.all([
        tx.$queryRaw<
          {
            company_uid: string;
            code: string;
            name_ru: string;
            name_uz: string;
            kind: string;
            currency: string;
          }[]
        >`
          SELECT co.uid AS company_uid, a.code, a.name_ru, a.name_uz,
                 a.kind::text AS kind, cur.code AS currency
            FROM account a
            JOIN company co ON co.id = a.company_id
            JOIN currency cur ON cur.id = a.currency_id
           WHERE a.is_active
           ORDER BY co.code, a.code`,
        tx.$queryRaw<
          {
            company_uid: string;
            uid: string;
            name_ru: string;
            name_uz: string;
            direction: string;
          }[]
        >`
          SELECT co.uid AS company_uid, i.uid, i.name_ru, i.name_uz,
                 i.direction::text AS direction
            FROM cashflow_item i
            JOIN company co ON co.id = i.company_id
           ORDER BY co.code, i.direction, i.name_ru`,
        tx.$queryRaw<{ code: string }[]>`
          SELECT DISTINCT cur.code
            FROM account a JOIN currency cur ON cur.id = a.currency_id
           WHERE a.is_active
           ORDER BY cur.code`,
        tx.$queryRaw<{ company_uid: string; uid: string; name_ru: string }[]>`
          SELECT co.uid AS company_uid, p.uid, p.name_ru
            FROM partner p
            JOIN company co ON co.id = p.company_id
           WHERE p.is_active
           ORDER BY co.code, p.name_ru
           LIMIT 500`,
      ]);

      return {
        accounts: accounts.map((a) => ({
          companyUid: a.company_uid,
          code: a.code,
          nameRu: a.name_ru,
          nameUz: a.name_uz,
          kind: a.kind,
          currency: a.currency,
        })),
        cashflowItems: items.map((i) => ({
          companyUid: i.company_uid,
          uid: i.uid,
          nameRu: i.name_ru,
          nameUz: i.name_uz,
          direction: i.direction,
        })),
        currencies: currencies.map((c) => c.code),
        partners: partners.map((p) => ({
          companyUid: p.company_uid,
          uid: p.uid,
          nameRu: p.name_ru,
        })),
      };
    });
  }

  async create(input: CreateInput, idempotencyKey?: string): Promise<Brief> {
    const ctx = currentContext();
    const userId = ctx?.userId ?? null;
    const companyIds = ctx?.companyIds ?? [];

    return this.prisma.withTenant(async (tx) => {
      const companyId = await this.resolveCompany(tx, input.companyUid, companyIds);

      // Повтор запроса не должен заводить вторую заявку. Ключ уникален в паре
      // с компанией, так что здесь просто отдаём то, что уже создано.
      if (idempotencyKey) {
        const seen = await tx.financeOperation.findFirst({
          where: { companyId, idempotencyKey },
          select: { uid: true, number: true, status: true, version: true },
        });
        if (seen) return { ...seen, entries: 0 } as Brief;
      }

      const parts = await this.resolveParts(tx, companyId, input);
      const amount = this.money(input.amount);
      const rate = input.rate ? this.money(input.rate) : 1;
      if (rate <= 0) throw new BadRequestException(MSG.ratePositive());

      // Платёж по заказу проверяется до записи: правила «в валюте заказа»,
      // «не больше остатка» и «корреспондент — расчёты с покупателями» нужны
      // и браузеру, и боту, поэтому живут в службе, а не в экране.
      const order = input.salesOrderUid
        ? await this.resolveOrder(tx, companyId, input.salesOrderUid, {
            operationType: input.operationType,
            currencyId: parts.currencyId!,
            counterAccountId: parts.counterAccountId ?? null,
            amount,
          })
        : null;

      const number = await this.nextNumber(tx, companyId, input.operationType);

      const op = await tx.financeOperation.create({
        data: {
          companyId,
          number,
          operationType: input.operationType,
          occurredAt: input.occurredAt ? new Date(input.occurredAt) : new Date(),
          plannedDate: input.plannedDate ? new Date(input.plannedDate) : null,
          // Счета, валюта и сумма на создании обязательны в DTO, поэтому
          // разрешение их точно нашло — в отличие от правки, где поля
          // необязательные и часть остаётся прежней.
          accountId: parts.accountId!,
          counterAccountId: parts.counterAccountId!,
          amount: amount as never,
          currencyId: parts.currencyId!,
          rate: rate as never,
          amountBase: (amount * rate) as never,
          cashflowItemId: parts.cashflowItemId,
          // Контрагент платежа по заказу очевиден — это покупатель заказа, и
          // спрашивать его второй раз значит дать возможность ошибиться.
          partnerId: parts.partnerId ?? order?.partnerId ?? null,
          sourceDocType: order ? ORDER_SOURCE : null,
          sourceDocId: order?.id ?? null,
          status: 'draft',
          comment: input.comment ?? null,
          createdBy: userId,
          idempotencyKey: idempotencyKey ?? null,
        },
        select: { uid: true, number: true, status: true, version: true },
      });

      // Журнал действий (ТЗ 3.4): заявка на деньги заведена. Финансы в журнал
      // не писали вовсе — был виден только последний статус самой операции.
      await writeAudit(tx, {
        companyId,
        entityType: 'finance_operation',
        entityId: op.uid,
        action: 'create',
        changes: {
          number: { from: null, to: op.number },
          operationType: { from: null, to: input.operationType },
          amount: { from: null, to: amount },
          currency: { from: null, to: input.currencyCode },
          account: { from: null, to: input.accountCode },
          counterAccount: { from: null, to: input.counterAccountCode },
          ...(order ? { salesOrder: { from: null, to: order.number } } : {}),
        },
      });

      return { ...op, entries: 0 };
    });
  }

  async patch(uid: string, input: PatchInput): Promise<Brief> {
    return this.prisma.withTenant(async (tx) => {
      const op = await tx.financeOperation.findUnique({
        where: { uid },
        select: {
          id: true,
          companyId: true,
          status: true,
          version: true,
          amount: true,
          rate: true,
          currencyId: true,
          accountId: true,
          counterAccountId: true,
          operationType: true,
          sourceDocType: true,
          sourceDocId: true,
        },
      });
      if (!op) throw new NotFoundException(MSG.operationNotFound());

      // Черновик — единственное состояние, где правка никого не обманывает.
      if (op.status !== 'draft') {
        throw new ConflictException(say('Править можно только черновик: отправленную заявку исправляют отзывом, проведённую — сторно', 'Faqat qoralamani tahrirlash mumkin: yuborilgan arizani qaytarib olish bilan, o‘tkazilganini storno bilan to‘g‘rilaydi'));
      }

      const parts = await this.resolveParts(tx, op.companyId, input);

      // Тот же запрет, что при создании, но по итоговой паре: правка меняет
      // обычно один счёт из двух, и сравнивать только присланное — значит
      // пропустить ровно тот случай, ради которого запрет и нужен.
      const account = parts.accountId ?? op.accountId;
      const counter = parts.counterAccountId ?? op.counterAccountId;
      if (counter !== null && account === counter) {
        throw new UnprocessableEntityException(say('Счёт и корреспондент должны различаться', 'Hisob va korrespondent har xil bo‘lishi kerak'));
      }

      const amount = input.amount === undefined ? Number(op.amount) : this.money(input.amount);
      const rate = input.rate === undefined ? Number(op.rate) : this.money(input.rate);
      if (rate <= 0) throw new BadRequestException(MSG.ratePositive());

      // Правку платежа по заказу проверяем теми же правилами, что заведение.
      // Сумму в черновике меняют чаще, чем заводят заново, и оставить здесь
      // лазейку значило бы, что проверка остатка не работает вовсе. Свою
      // прежнюю сумму платёж при этом не занимает — иначе её нельзя увеличить.
      if (op.sourceDocType === ORDER_SOURCE && op.sourceDocId !== null) {
        const linked = await tx.salesOrder.findUnique({
          where: { id: op.sourceDocId },
          select: { uid: true },
        });
        if (linked) {
          await this.resolveOrder(tx, op.companyId, linked.uid, {
            operationType: op.operationType as OperationType,
            currencyId: parts.currencyId ?? op.currencyId,
            counterAccountId: counter,
            amount,
            exclude: op.id,
          });
        }
      }

      const moved = await tx.financeOperation.updateMany({
        where: { id: op.id, version: input.version },
        data: {
          version: { increment: 1 },
          amount: amount as never,
          rate: rate as never,
          amountBase: (amount * rate) as never,
          ...(parts.accountId !== undefined ? { accountId: parts.accountId } : {}),
          ...(parts.counterAccountId !== undefined
            ? { counterAccountId: parts.counterAccountId }
            : {}),
          ...(parts.currencyId !== undefined ? { currencyId: parts.currencyId } : {}),
          ...(parts.cashflowItemId !== undefined ? { cashflowItemId: parts.cashflowItemId } : {}),
          ...(parts.partnerId !== undefined ? { partnerId: parts.partnerId } : {}),
          ...(input.occurredAt ? { occurredAt: new Date(input.occurredAt) } : {}),
          ...(input.plannedDate ? { plannedDate: new Date(input.plannedDate) } : {}),
          ...(input.comment !== undefined ? { comment: input.comment } : {}),
        },
      });
      if (moved.count === 0) {
        throw new ConflictException(MSG.stale());
      }

      const after = await tx.financeOperation.findUniqueOrThrow({
        where: { id: op.id },
        select: { uid: true, number: true, status: true, version: true },
      });

      // В журнал пишем только то, что действительно изменилось: снимок всей
      // заявки не отвечает на вопрос, ради которого журнал читают.
      await writeAudit(tx, {
        companyId: op.companyId,
        entityType: 'finance_operation',
        entityId: uid,
        action: 'update',
        changes: {
          number: { from: null, to: after.number },
          ...(amount !== Number(op.amount)
            ? { amount: { from: Number(op.amount), to: amount } }
            : {}),
          ...(rate !== Number(op.rate) ? { rate: { from: Number(op.rate), to: rate } } : {}),
          ...(input.accountCode ? { account: { from: null, to: input.accountCode } } : {}),
          ...(input.counterAccountCode
            ? { counterAccount: { from: null, to: input.counterAccountCode } }
            : {}),
          ...(input.comment !== undefined ? { comment: { from: null, to: input.comment } } : {}),
        },
      });
      return { ...after, entries: 0 };
    });
  }

  /**
   * Сторно проведённой операции.
   *
   * Новая операция с теми же счетами и суммой, но зеркальными проводками:
   * что было дебетом, становится кредитом. Оригинал получает статус
   * `reversed`, а его проводки остаются на месте — они уже попали в отчётность
   * прошлого периода, и стирать их задним числом нельзя. Сальдо счёта после
   * сторно возвращается ровно к тому, что было до проведения.
   */
  async reverse(uid: string, params: { version: number; comment?: string }): Promise<Brief> {
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
          occurredAt: true,
          accountId: true,
          counterAccountId: true,
          amount: true,
          currencyId: true,
          rate: true,
          amountBase: true,
          cashflowItemId: true,
          partnerId: true,
          sourceDocType: true,
          sourceDocId: true,
        },
      });
      if (!op) throw new NotFoundException(MSG.operationNotFound());

      if (op.status !== 'posted') {
        throw new ConflictException(say('Сторнировать можно только проведённую операцию: у остальных проводок нет', 'Faqat o‘tkazilgan operatsiyani storno qilish mumkin: qolganlarda provodka yo‘q'));
      }
      if (op.counterAccountId === null) {
        throw new ConflictException(say('У операции нет счёта-корреспондента: зеркалить нечего', 'Operatsiyada korrespondent hisob yo‘q: oynaga olishga narsa yo‘q'));
      }

      const closed = await tx.financeOperation.updateMany({
        where: { id: op.id, version: params.version, status: 'posted' },
        data: { status: 'reversed', version: { increment: 1 } },
      });
      if (closed.count === 0) {
        throw new ConflictException(MSG.stale());
      }

      const number = await this.nextNumber(tx, op.companyId, op.operationType as OperationType);
      const mirror = await tx.financeOperation.create({
        data: {
          companyId: op.companyId,
          number,
          operationType: op.operationType,
          occurredAt: new Date(),
          accountId: op.accountId,
          counterAccountId: op.counterAccountId,
          amount: op.amount,
          currencyId: op.currencyId,
          rate: op.rate,
          amountBase: op.amountBase,
          cashflowItemId: op.cashflowItemId,
          partnerId: op.partnerId,
          status: 'posted',
          reversalOfId: op.id,
          comment: params.comment ?? `Сторно ${op.number}`,
          createdBy: userId,
          approvedBy: userId,
          postedAt: new Date(),
        },
        select: { id: true, uid: true, number: true, status: true, version: true },
      });

      // Стороны перевёрнуты относительно исходного проведения: у поступления
      // деньги уходят со счёта, у расхода — возвращаются на него.
      const income = op.operationType === 'income';
      const debitAccount = income ? op.counterAccountId : op.accountId;
      const creditAccount = income ? op.accountId : op.counterAccountId;

      await tx.financeEntry.createMany({
        data: [
          {
            operationId: mirror.id,
            companyId: op.companyId,
            accountId: debitAccount,
            debit: op.amountBase,
            credit: 0,
            amountBase: op.amountBase,
            occurredAt: new Date(),
          },
          {
            operationId: mirror.id,
            companyId: op.companyId,
            accountId: creditAccount,
            debit: 0,
            credit: op.amountBase,
            amountBase: op.amountBase,
            occurredAt: new Date(),
          },
        ],
      });

      // Платёж по заказу: оригинал перестал быть проведённым, значит
      // оплаченное по заказу надо пересчитать. Ссылку на заказ зеркало не
      // получает намеренно — иначе отмена платежа увеличивала бы оплаченное
      // вместо того, чтобы его уменьшить.
      if (op.sourceDocType === ORDER_SOURCE && op.sourceDocId !== null) {
        await recalcOrderPayment(tx, op.sourceDocId);
      }

      // Сторно — отдельная операция, и в журнале оно стоит отдельной записью
      // со ссылкой на отменённую: «проведено» и «отменено» спрашивают порознь.
      await writeAudit(tx, {
        companyId: op.companyId,
        entityType: 'finance_operation',
        entityId: mirror.uid,
        action: 'reverse',
        changes: {
          number: { from: null, to: mirror.number },
          reversalOf: { from: null, to: op.number },
          amount: { from: null, to: Number(op.amountBase) },
          ...(params.comment ? { comment: { from: null, to: params.comment } } : {}),
        },
      });

      return {
        uid: mirror.uid,
        number: mirror.number,
        status: mirror.status,
        version: mirror.version,
        entries: 2,
      };
    });
  }

  // -------------------------------------------------------------------------

  /**
   * В какой компании заводим. У директора их две, и угадывать нельзя: операция
   * попадёт не в ту книгу и будет найдена не там, где её ищут.
   */
  private async resolveCompany(
    tx: Tx,
    companyUid: string | undefined,
    allowed: readonly bigint[],
  ): Promise<bigint> {
    if (!companyUid) {
      if (allowed.length === 1) return allowed[0];
      throw new BadRequestException(
        MSG.pickCompany(),
      );
    }
    const rows = await tx.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM company WHERE uid = ${companyUid}::uuid`;
    const id = rows[0]?.id;
    // Политика RLS чужую компанию и так не отдаст, но список из токена —
    // вторая проверка на случай, если политику однажды ослабят.
    if (!id || !allowed.some((a) => a === id)) {
      throw new UnprocessableEntityException(MSG.companyUnavailable());
    }
    return id;
  }

  /** Коды и uid из тела запроса — в идентификаторы строк. Чего нет — 422. */
  private async resolveParts(
    tx: Tx,
    companyId: bigint,
    input: Partial<CreateInput>,
  ): Promise<{
    accountId?: bigint;
    counterAccountId?: bigint | null;
    currencyId?: bigint;
    cashflowItemId?: bigint | null;
    partnerId?: bigint | null;
  }> {
    const out: Record<string, unknown> = {};

    for (const [field, code] of [
      ['accountId', input.accountCode],
      ['counterAccountId', input.counterAccountCode],
    ] as const) {
      if (code === undefined) continue;
      const rows = await tx.$queryRaw<{ id: bigint }[]>`
        SELECT id FROM account
         WHERE company_id = ${companyId} AND code = ${code} AND is_active`;
      if (!rows[0]) {
        throw new UnprocessableEntityException(say(`Счёт ${code} не найден в этой компании`, `${code} hisobi bu kompaniyada topilmadi`));
      }
      out[field] = rows[0].id;
    }

    // Счёт сам себе корреспондентом даёт дебет и кредит по одной строке: сумма
    // сходится, триггер двойной записи молчит, а денег никуда не ушло. Такую
    // операцию отличить от опечатки потом нельзя, поэтому не принимаем сразу.
    if (
      out.accountId !== undefined &&
      out.counterAccountId !== undefined &&
      out.accountId === out.counterAccountId
    ) {
      throw new UnprocessableEntityException(say('Счёт и корреспондент должны различаться', 'Hisob va korrespondent har xil bo‘lishi kerak'));
    }

    if (input.currencyCode !== undefined) {
      const rows = await tx.$queryRaw<{ id: bigint }[]>`
        SELECT id FROM currency WHERE code = ${input.currencyCode}`;
      if (!rows[0]) {
        throw new UnprocessableEntityException(say(`Валюта ${input.currencyCode} не найдена`, `${input.currencyCode} valyutasi topilmadi`));
      }
      out.currencyId = rows[0].id;
    }

    if (input.cashflowItemUid !== undefined) {
      const rows = await tx.$queryRaw<{ id: bigint }[]>`
        SELECT id FROM cashflow_item
         WHERE company_id = ${companyId} AND uid = ${input.cashflowItemUid}::uuid`;
      if (!rows[0]) throw new UnprocessableEntityException(say('Статья ДДС не найдена', 'Pul oqimi moddasi topilmadi'));
      out.cashflowItemId = rows[0].id;
    }

    if (input.partnerUid !== undefined) {
      const rows = await tx.$queryRaw<{ id: bigint }[]>`
        SELECT id FROM partner WHERE company_id = ${companyId} AND uid = ${input.partnerUid}::uuid`;
      if (!rows[0]) throw new UnprocessableEntityException(say('Контрагент не найден', 'Kontragent topilmadi'));
      out.partnerId = rows[0].id;
    }

    return out;
  }

  /**
   * Заказ, к которому привязывают платёж, со всеми проверками.
   *
   * Остаток считается вместе с незаконченными платежами: иначе двое заведут
   * по полному остатку каждый, оба пройдут согласование, и заказ окажется
   * оплачен дважды. Что считается оплаченным — в `sales/order-payment.ts`.
   */
  private async resolveOrder(
    tx: Tx,
    companyId: bigint,
    uid: string,
    check: {
      operationType: OperationType;
      currencyId: bigint;
      counterAccountId: bigint | null;
      amount: number;
      exclude?: bigint;
    },
  ): Promise<{ id: bigint; number: string; partnerId: bigint }> {
    if (check.operationType !== 'income') {
      throw new BadRequestException(say('К заказу привязывают только поступление: по заказу деньги приходят, а не уходят', 'Buyurtmaga faqat tushum bog‘lanadi: buyurtma bo‘yicha pul keladi, ketmaydi'));
    }

    const rows = await tx.$queryRaw<
      { id: bigint; number: string; partner_id: bigint; currency_id: bigint; status: string }[]
    >`
      SELECT id, number, partner_id, currency_id, status::text AS status
        FROM sales_order
       WHERE uid = ${uid}::uuid AND company_id = ${companyId}`;
    const order = rows[0];
    if (!order) throw new NotFoundException(MSG.orderNotFound());

    if (order.status === 'cancelled') {
      throw new ConflictException(say(`Заказ ${order.number} отменён: платёж к нему не привязывают`, `${order.number} buyurtmasi bekor qilingan: unga to‘lov bog‘lanmaydi`));
    }
    if (order.currency_id !== check.currencyId) {
      throw new UnprocessableEntityException(say(`Заказ ${order.number} заведён в другой валюте: платёж по нему заводят в валюте заказа`, `${order.number} buyurtmasi boshqa valyutada kiritilgan: to‘lov buyurtma valyutasida kiritiladi`));
    }

    // Корреспондент такого платежа — счёт расчётов с покупателями: деньги
    // закрывают долг, а доход по этой продаже признан при отгрузке. Пустить
    // их на счёт дохода значит посчитать выручку дважды.
    const kind =
      check.counterAccountId === null ? null : await this.accountKind(tx, check.counterAccountId);
    if (kind !== 'receivable') {
      throw new UnprocessableEntityException(say('Платёж по заказу закрывает долг покупателя: корреспондентом должен быть счёт расчётов с покупателями', 'Buyurtma bo‘yicha to‘lov xaridor qarzini yopadi: korrespondent xaridorlar bilan hisob-kitob hisobi bo‘lishi kerak'));
    }

    const state = await paymentState(tx, order.id, check.exclude);
    if (check.amount > state.remaining + 0.005) {
      const pending = state.pending > 0 ? `, ещё ${fmt(state.pending)} ждут согласования` : '';
      throw new UnprocessableEntityException(say(`По заказу ${order.number} остаток к оплате ${fmt(state.remaining)}${pending}: ` +
          `платёж на ${fmt(check.amount)} больше остатка`, `${order.number} buyurtmasi bo‘yicha to‘lovga qoldiq ${fmt(state.remaining)}${pending}: ` + `${fmt(check.amount)} to‘lov qoldiqdan ko‘p`));
    }

    return { id: order.id, number: order.number, partnerId: order.partner_id };
  }

  private async accountKind(tx: Tx, id: bigint): Promise<string | null> {
    const rows = await tx.$queryRaw<{ kind: string }[]>`
      SELECT kind::text AS kind FROM account WHERE id = ${id}`;
    return rows[0]?.kind ?? null;
  }

  /**
   * Следующий номер в пределах компании и префикса.
   *
   * Консультативная блокировка на пару «компания + префикс»: без неё два
   * одновременных запроса вычислят один и тот же максимум и второй упрётся
   * в уникальный индекс. Блокировка снимается вместе с транзакцией.
   */
  private async nextNumber(tx: Tx, companyId: bigint, type: OperationType): Promise<string> {
    const prefix = PREFIX[type];
    // Именно $executeRaw: функция возвращает void, а $queryRaw такой столбец
    // разобрать не умеет и падает на пустом месте.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${companyId}:${prefix}`}))`;

    const rows = await tx.$queryRaw<{ next: number }[]>`
      SELECT coalesce(max(substring(number from '[0-9]+$')::int), 0) + 1 AS next
        FROM finance_operation
       WHERE company_id = ${companyId} AND number LIKE ${`${prefix}-%`}`;

    return `${prefix}-${String(rows[0].next).padStart(6, '0')}`;
  }

  /** Деньги приходят строкой: у числа с плавающей точкой копейки теряются. */
  private money(raw: string): number {
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      throw new BadRequestException(say('Сумма должна быть числом больше нуля', 'Summa noldan katta son bo‘lishi kerak'));
    }
    return value;
  }
}
