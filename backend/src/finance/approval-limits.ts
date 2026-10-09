import { ForbiddenException } from '@nestjs/common';
import type { Tx } from '../prisma/prisma.service.js';
import { requireContext } from '../common/request-context.js';
import { say } from '../common/say.js';

/**
 * Порог подтверждения платёжки (требование заказчика со встречи 07.10, §5).
 *
 * Заказчик сказал прямо, зачем это: «не могу слепо доверять бухгалтерам, у
 * знакомого бухгалтер украл до миллиарда сумов мелкими транзакциями». Отсюда
 * два предела, а не один, и второй здесь главный.
 *
 * 1. **Порог по одной операции.** Платёж дороже порога утверждает только тот,
 *    кому выдано `finance.approve.large`. Один порог от того случая не спасает:
 *    именно так и крали — суммами, каждая из которых ниже любого порога.
 * 2. **Предел на одного получателя за окно.** Складываются все платежи этому
 *    получателю за последние N дней, **включая те, что ещё висят на
 *    согласовании**. Считать только утверждённые — значит оставить ту же
 *    дыру: десять заявок подаются сразу, каждая проходит по отдельности.
 *
 * Считаем по `amount_base` — сумме в базовой валюте, пересчитанной курсом дня
 * операции. По `amount` порог обходился бы валютой: тысяча долларов и тысяча
 * сумов — одно число в поле и совершенно разные деньги.
 *
 * Черновики и отклонённые в сумму не идут: черновик никто не подавал, а
 * отклонённый платёж не состоялся. Сторно тоже: оно гасит проведённую
 * операцию, и считать его вторым расходом нельзя.
 *
 * Где стоит проверка — важно не меньше, чем сама проверка. Она в сервисе
 * согласования, а не на маршруте: тот же `apply()` зовёт и бот из Telegram
 * (`src/bot/finance.bot.ts`), и декоратор на контроллере его бы не прикрыл.
 */

/** Право подтверждать платёж, вышедший за порог или за предел периода. */
export const LARGE_APPROVAL_PERMISSION = 'finance.approve.large';

/** Статусы, в которых платёж считается обещанным или состоявшимся. */
const COUNTED: readonly string[] = ['pending_approval', 'approved', 'posted'];

interface Limits {
  single: string | null;
  period: string | null;
  days: number;
}

/** Сумма словами человека: разряды пробелами, без копеек. */
const money = (v: number) => Math.round(v).toLocaleString('ru-RU').replace(/ /g, ' ');

/**
 * Можно ли этому человеку утвердить эту операцию.
 *
 * Ничего не возвращает: либо проходит молча, либо бросает 403 с объяснением,
 * какой именно предел задет и на сколько. «Нет доступа» без числа заставляет
 * человека гадать, а дальше звонить разработчику.
 */
export async function assertApprovalAllowed(
  tx: Tx,
  op: {
    companyId: bigint;
    partnerId: bigint | null;
    amountBase: unknown;
    occurredAt: Date;
    id: bigint;
  },
): Promise<void> {
  // Право есть — предел не при чём: он и заведён для того, чтобы передать
  // решение этому человеку.
  if (requireContext().permissions.has(LARGE_APPROVAL_PERMISSION)) return;

  const rows = await tx.$queryRaw<Limits[]>`
    SELECT approval_limit_single::text AS single, approval_limit_period::text AS period,
           approval_period_days AS days
      FROM company WHERE id = ${op.companyId}`;
  const limits = rows[0];
  if (!limits) return;

  const amount = Number(op.amountBase);
  const single = limits.single === null ? null : Number(limits.single);
  const period = limits.period === null ? null : Number(limits.period);

  if (single !== null && amount > single) {
    throw new ForbiddenException(
      say(
        `Платёж крупный: ${money(amount)} больше порога ${money(single)}. ` +
          'Подтвердить его может только тот, у кого есть право на крупные платежи',
        `To‘lov yirik: ${money(amount)} chegaradan (${money(single)}) ortiq. ` +
          'Uni faqat yirik to‘lovlarni tasdiqlash huquqi bo‘lgan kishi tasdiqlaydi',
      ),
    );
  }

  // Предел за период считается на получателя. Без получателя складывать не с
  // чем: такой платёж держит только порог по одной операции.
  if (period === null || op.partnerId === null) return;

  // Статусы подставлены в текст запроса, а не параметром: это константа кода,
  // снаружи она не приходит, а массив через параметр Prisma отдаёт базе не
  // массивом — условие тогда не совпадает ни с чем и предел молча не работает.
  // Окно — `make_interval`, а не склейка строки: `число || ' days'` в Postgres
  // неоднозначно по типам.
  const list = COUNTED.map((s) => `'${s}'`).join(', ');
  const sums = await tx.$queryRawUnsafe<{ total: string }[]>(
    `SELECT coalesce(sum(amount_base), 0)::text AS total
       FROM finance_operation
      WHERE company_id = $1
        AND partner_id = $2
        AND operation_type = 'expense'
        AND status::text IN (${list})
        AND id <> $5
        AND occurred_at > $3::timestamptz - make_interval(days => $4::int)
        AND occurred_at <= $3::timestamptz`,
    op.companyId,
    op.partnerId,
    op.occurredAt,
    limits.days,
    op.id,
  );
  // Саму операцию исключаем из выборки и прибавляем её сумму руками, а не
  // ловим окном. Дата в базе хранится с микросекундами, а в приложение
  // приезжает округлённой до миллисекунд: по условию `occurred_at <= дата
  // операции` собственная строка в сумму не попадала, и предел недосчитывал
  // ровно тот платёж, который сейчас утверждают.
  const total = Number(sums[0]?.total ?? 0) + amount;

  if (total > period) {
    throw new ForbiddenException(
      say(
        `Этому получателю за период (${limits.days} дн.) набралось ${money(total)} ` +
          `при пределе ${money(period)} — вместе с этим платежом и с теми, что ещё ждут ` +
          'согласования. Подтвердить может только тот, у кого есть право на крупные платежи',
        `Bu oluvchiga davr uchun (${limits.days} kun) ${money(total)} yig‘ildi, ` +
          `chegara ${money(period)} — bu to‘lov va kelishishda turganlar bilan birga. ` +
          'Faqat yirik to‘lovlarni tasdiqlash huquqi bo‘lgan kishi tasdiqlaydi',
      ),
    );
  }
}
