/**
 * Что такое «долг клиента» — в одном месте на всю систему.
 *
 * Задолженность считается по заказам: сколько отгружено и не оплачено. Второй
 * счёт тех же денег в CRM завести нельзя — он разойдётся с финансовым, и на
 * вопрос «сколько должен» система начнёт давать два ответа. Поэтому и список
 * дебиторов в финансах, и вкладка «финансы» в карточке клиента берут выражения
 * отсюда, а не переписывают их каждый у себя.
 *
 * Отменённый заказ из счёта выпадает: он не отгружался. Просрочка считается по
 * `payment_due_date` — дате, до которой договорились заплатить, а не по дате
 * заказа: отсрочка на 30 дней это не долг, это условие работы.
 */
export const UNPAID_ORDERS_WHERE = `o.paid_amount < o.amount_total AND o.status <> 'cancelled'`;

export const DEBT_EXPR = `sum(o.amount_total - o.paid_amount)`;

export const OVERDUE_EXPR =
  `coalesce(sum(o.amount_total - o.paid_amount) ` +
  `FILTER (WHERE o.payment_due_date < current_date), 0)`;

export const OLDEST_DUE_EXPR =
  `min(o.payment_due_date) FILTER (WHERE o.payment_due_date < current_date)`;

export const MAX_OVERDUE_DAYS_EXPR =
  `max(current_date - o.payment_due_date) FILTER (WHERE o.payment_due_date < current_date)::int`;
