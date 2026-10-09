/**
 * Что значит «заказ оплачен» — в одном месте на всю систему.
 *
 * Дебиторка считается выражением из `receivables.ts`: сумма заказа минус
 * `sales_order.paid_amount`. Значит оплаченное по заказу — не подпись в
 * карточке, а источник долга для списка должников, карточки клиента и сводки
 * руководителя. Поэтому его нельзя наращивать «на единицу платежа» из разных
 * мест: один пропущенный сторно, и долг разойдётся с кассой навсегда.
 *
 * Вместо накопления — пересчёт из первоисточника: оплаченное равно сумме
 * проведённых поступлений, привязанных к заказу. Сторно при этом не вычитается
 * отдельно — сторнированная операция просто перестаёт быть проведённой и
 * выпадает из суммы сама. Пересчёт идёмпотентен: вызвать его лишний раз
 * безопасно, а это главное свойство для кода, который зовут из двух служб.
 *
 * Статус оплаты ведётся отдельной осью (ТЗ 9.3): не оплачен / частично /
 * оплачен полностью. Он вычисляется здесь же — чтобы «частично» и «полностью»
 * не оказались в системе двумя разными правилами.
 */
import type { Tx } from '../prisma/prisma.service.js';

/** Чем помечен платёж по заказу в `finance_operation.source_doc_type`. */
export const ORDER_SOURCE = 'sales_order';

/**
 * Статусы платежа, который деньгами ещё не стал, но место под них занял.
 *
 * Занятым остаток считается вместе с ними: иначе двое заведут по полному
 * остатку каждый, оба платежа честно пройдут согласование, и заказ окажется
 * оплачен дважды — а узнают об этом по отрицательному долгу.
 */
const PENDING = ['draft', 'pending_approval', 'approved'] as const;

/** Копейки: колонка держит четыре знака, сумма заказа складывается из строк. */
const EPS = 0.005;

export type PaymentState = {
  /** Сумма заказа. */
  total: number;
  /** Проведено. */
  paid: number;
  /** Заведено, но ещё не проведено. */
  pending: number;
  /** Сколько ещё можно заплатить, с учётом незаконченных платежей. */
  remaining: number;
};

export function paymentStatusOf(paid: number, total: number): 'unpaid' | 'partial' | 'paid' {
  if (paid <= EPS) return 'unpaid';
  if (paid + EPS >= total) return 'paid';
  return 'partial';
}

/**
 * Состояние оплаты заказа. `exclude` — операция, которую не надо считать
 * занятой: при правке черновика его собственная сумма остатка не занимает,
 * иначе исправить сумму с 10 на 11 будет нельзя.
 */
export async function paymentState(
  tx: Tx,
  orderId: bigint,
  exclude?: bigint,
): Promise<PaymentState> {
  const order = await tx.salesOrder.findUnique({
    where: { id: orderId },
    select: { amountTotal: true },
  });
  const total = Number(order?.amountTotal ?? 0);

  const sumOf = async (where: Record<string, unknown>) => {
    const out = await tx.financeOperation.aggregate({
      _sum: { amount: true },
      where: {
        sourceDocType: ORDER_SOURCE,
        sourceDocId: orderId,
        operationType: 'income',
        ...where,
      },
    });
    return Number(out._sum.amount ?? 0);
  };

  const paid = await sumOf({ status: 'posted' });
  const pending = await sumOf({
    status: { in: [...PENDING] },
    ...(exclude === undefined ? {} : { id: { not: exclude } }),
  });

  return { total, paid, pending, remaining: total - paid - pending };
}

/**
 * То же состояние, но по uid заказа: снаружи внутренних номеров не видно.
 * Возвращает `null`, если заказа нет или он не свой — отличать одно от
 * другого вызывающему не нужно, ответ в обоих случаях один.
 */
export async function paymentStateByUid(
  tx: Tx,
  uid: string,
): Promise<(PaymentState & { number: string }) | null> {
  const order = await tx.salesOrder.findFirst({
    where: { uid },
    select: { id: true, number: true },
  });
  if (!order) return null;
  return { ...(await paymentState(tx, order.id)), number: order.number };
}

/**
 * Переписать оплаченное и статус оплаты по проведённым платежам.
 *
 * Версию заказа не трогаем: её смысл — «карточка, которую видел человек,
 * устарела», а оплата приходит сбоку и правку заказа не отменяет. Иначе
 * каждый платёж ломал бы открытую у менеджера форму.
 */
export async function recalcOrderPayment(tx: Tx, orderId: bigint): Promise<PaymentState> {
  const state = await paymentState(tx, orderId);
  await tx.salesOrder.update({
    where: { id: orderId },
    data: {
      paidAmount: state.paid.toFixed(4) as never,
      paymentStatus: paymentStatusOf(state.paid, state.total),
    },
  });
  return state;
}
