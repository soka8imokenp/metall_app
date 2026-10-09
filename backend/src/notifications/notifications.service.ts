/**
 * Тракт уведомлений (ТЗ 11.1): кто получает, что получает и что уже получил.
 *
 * Бот не умеет «следить» — он умеет писать. Следит этот сервис: раз в несколько
 * минут он собирает события заново и кладёт в очередь только новые. Очередь
 * нужна не ради надёжности доставки, а ради тишины: «просрочено» не перестаёт
 * быть просроченным, и без ключа повтора человек получал бы одно и то же каждые
 * пять минут, пока не выключил бы бота совсем.
 *
 * **События собираются в контексте человека, а не «для всех».** Для каждого
 * получателя запрос идёт внутри `withContext(его id, его компании)`, то есть
 * через те же политики базы, что и веб. Так в текст физически не попадёт чужая
 * компания. Цена — запрос на человека на вид события; получателей бота единицы
 * (роли ограничены), и это дешевле, чем второй набор правил видимости.
 *
 * Правила счёта берём у системы: нехватка — `NeedsService`, долг — выражения из
 * `receivables.ts`. Бот и веб не должны отвечать по-разному на один вопрос.
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { AuthService } from '../auth/auth.service.js';
import { NeedsService } from '../warehouse/needs.service.js';
import { UNPAID_ORDERS_WHERE } from '../finance/receivables.js';
import { botAllowed } from '../bot/menu.js';
import { sum } from '../bot/format.js';
// Имена кнопок берём там же, где их рисует бот: «нажмите X» обязано
// совпадать с тем, что человек видит на экране. Переименуют кнопку —
// переименуется и уведомление.
import { ACTION } from '../bot/finance.texts.js';
import { ACTION as DOC_ACTION } from '../bot/documents.texts.js';
import { KINDS, type NotificationKind } from './kinds.js';

/** Одно событие: предмет, дата и текст на двух языках. */
interface Event {
  dedupeKey: string;
  ru: string;
  uz: string;
}

export interface Pending {
  id: bigint;
  userId: bigint;
  chatId: bigint;
  locale: string;
  kind: string;
  textRu: string;
  textUz: string;
  attempts: number;
}

/** Сколько раз пробуем отправить, прежде чем отложить строку насовсем. */
const MAX_ATTEMPTS = 5;
/** Сколько предметов называем в одном сообщении: дальше читать перестают. */
const LIST_LIMIT = 5;

/**
 * Насколько назад смотрим решения по чужим нажатиям. Без окна первый же проход
 * после включения вывалил бы человеку всю историю его записей.
 */
const DECISION_WINDOW = '2 days';

interface OpRow {
  id: bigint;
  number: string;
  amount: string;
  currency: string;
  type: string;
  item_ru: string | null;
  item_uz: string | null;
  who: string | null;
}

/** Крупный платёж: к обычной шапке операции добавлены получатель и предел. */
interface BigOpRow extends OpRow {
  partner_ru: string | null;
  partner_uz: string | null;
  base: string;
  single: string | null;
  period: string | null;
  days: number;
  total: string;
}

interface DecisionRow extends Omit<OpRow, 'id'> {
  id: bigint;
  action: string;
  note: string | null;
}

interface OrderEventRow {
  id: bigint;
  number: string;
  status: string;
  partner: string;
  amount: string;
  currency: string;
  who: string | null;
}

interface OrderMoveRow {
  id: bigint;
  action: string;
  changes: unknown;
  number: string;
  partner: string;
  who: string | null;
}

interface ReservedRow {
  id: bigint;
  number: string;
  partner: string;
  warehouse: string;
  lines: number;
}

interface VarianceRow {
  id: bigint;
  number: string;
  warehouse: string;
  diffs: number;
}

/**
 * Статус заказа словами. В уведомлении нельзя писать `in_production`: его
 * читает человек, который системой не пользуется.
 */
const ORDER_STATUS_RU: Record<string, string> = {
  draft: 'черновик',
  confirmed: 'подтверждён',
  reserved: 'товар отложен',
  in_production: 'в производстве',
  picking: 'собирается',
  shipped: 'отгружен',
  closed: 'закрыт',
  cancelled: 'отменён',
};

const ORDER_STATUS_UZ: Record<string, string> = {
  draft: 'qoralama',
  confirmed: 'tasdiqlangan',
  reserved: 'tovar band',
  in_production: 'ishlab chiqarishda',
  picking: 'yig‘ilmoqda',
  shipped: 'jo‘natilgan',
  closed: 'yopilgan',
  cancelled: 'bekor qilingan',
};

interface DocDecisionRow {
  id: bigint;
  action: string;
  number: string;
  type_ru: string;
  type_uz: string;
  who: string | null;
  note: string | null;
}

/** Одной строкой: что за запись, на сколько и по какой статье. */
const opHead = (r: Omit<OpRow, 'id'>, uz: boolean) => {
  const kind = r.type === 'income' ? (uz ? 'Kirim' : 'Поступление') : uz ? 'Chiqim' : 'Расход';
  const item = uz ? r.item_uz : r.item_ru;
  const amount = sum(r.amount, r.currency, uz);
  const head = uz ? `${kind} ${r.number} — ${amount}` : `${kind} ${r.number} на ${amount}`;
  return `${head}${item ? ` — ${item}` : ''}.`;
};

const money = (v: unknown) => Math.round(Number(v ?? 0)).toLocaleString('ru-RU');
const day = (v: Date | string) => new Date(v).toISOString().slice(0, 10);
const ru = (v: Date | string) => new Date(v).toLocaleDateString('ru-RU');

@Injectable()
export class NotificationsService {
  private readonly log = new Logger('notifications');

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly needs: NeedsService,
  ) {}

  // --- сборка ---------------------------------------------------------------

  /** Собрать события всем, кто подключён к боту. Возвращает число новых строк. */
  async scan(): Promise<number> {
    let added = 0;
    for (const user of await this.recipients()) {
      const access = await this.auth.loadProfile(user.id);
      const roles = await this.roleCodes(user.id);
      // Бот открыт не всем ролям — и уведомления от бота тоже. Но у кого есть
      // телефон с push, тому собираем всё равно: телефон — не бот.
      if (!user.push && !botAllowed(roles)) continue;
      const off = await this.disabled(user.id);

      for (const kind of KINDS) {
        if (off.has(kind.kind)) continue;
        if (!access.permissions.has(kind.permission)) continue;
        const events = await this.prisma.withContext(user.id, access.companyIds, (tx) =>
          this.build(tx, kind.kind, user.id),
        );
        for (const event of events) added += await this.put(user.id, kind.kind, event);
      }
    }
    if (added > 0) this.log.log(`новых уведомлений: ${added}`);
    return added;
  }

  /**
   * Кому есть чем написать: боту (привязка есть, человек нас не заблокировал)
   * или на телефон (живое устройство с push-адресом).
   */
  private recipients(): Promise<{ id: bigint; push: boolean }[]> {
    return this.prisma.withContext(null, [], async (tx) => {
      const rows = await tx.$queryRaw<{ id: bigint; push: boolean }[]>`
        SELECT u.id,
               EXISTS (SELECT 1 FROM device d
                        WHERE d.user_id = u.id AND d.push_token IS NOT NULL AND d.revoked_at IS NULL) AS push
          FROM user_account u
         WHERE u.is_active
           AND ((u.telegram_user_id IS NOT NULL AND NOT u.telegram_blocked)
                OR EXISTS (SELECT 1 FROM device d
                            WHERE d.user_id = u.id AND d.push_token IS NOT NULL AND d.revoked_at IS NULL))
         ORDER BY u.id`;
      return rows.map((r) => ({ id: BigInt(r.id), push: r.push }));
    });
  }

  private roleCodes(userId: bigint): Promise<string[]> {
    return this.prisma.withContext(userId, [], async (tx) => {
      const rows = await tx.$queryRaw<{ code: string }[]>`
        SELECT DISTINCT r.code
          FROM user_role_assignment a JOIN role r ON r.id = a.role_id
         WHERE a.user_id = ${userId}`;
      return rows.map((r) => r.code);
    });
  }

  /** Виды, которые человек выключил сам. Нет строки — получает. */
  private disabled(userId: bigint): Promise<Set<string>> {
    return this.prisma.withContext(userId, [], async (tx) => {
      const rows = await tx.$queryRaw<{ kind: string }[]>`
        SELECT kind FROM notification_setting WHERE user_id = ${userId} AND NOT enabled`;
      return new Set(rows.map((r) => r.kind));
    });
  }

  /**
   * Сборщик на каждый вид. Таблицей, а не цепочкой `if`: новый вид в
   * `NotificationKind` без сборщика не скомпилируется. Цепочка молча отправляла
   * бы его в последнюю ветку, и человек получил бы чужой текст.
   */
  private get builders(): Record<NotificationKind, (tx: Tx, userId: bigint) => Promise<Event[]>> {
    return {
      payment_overdue: (tx) => this.paymentOverdue(tx),
      finance_pending: (tx) => this.financePending(tx),
      finance_big_pending: (tx) => this.financeBigPending(tx),
      finance_to_post: (tx) => this.financeToPost(tx),
      finance_decided: (tx, userId) => this.financeDecided(tx, userId),
      document_pending: (tx) => this.documentPending(tx),
      document_decided: (tx, userId) => this.documentDecided(tx, userId),
      order_assigned: (tx, userId) => this.orderAssigned(tx, userId),
      order_moved: (tx, userId) => this.orderMoved(tx, userId),
      stock_reserved: (tx) => this.stockReserved(tx),
      inventory_variance: (tx) => this.inventoryVariance(tx),
      stock_critical: (tx) => this.stockCritical(tx),
      stage_overdue: (tx) => this.stageOverdue(tx),
      task_overdue: (tx, userId) => this.taskOverdue(tx, userId),
      deal_overdue: (tx, userId) => this.dealOverdue(tx, userId),
      backup_failed: (tx) => this.backupFailed(tx),
    };
  }

  private build(tx: Tx, kind: NotificationKind, userId: bigint): Promise<Event[]> {
    return this.builders[kind](tx, userId);
  }

  /**
   * Заявка на деньги ждёт согласования.
   *
   * Это главный повод написать первым: до него бот умел напомнить о чужом
   * долге, но не о том, что решения ждут от самого человека. Руководитель
   * узнавал о заявке, только если сам заходил в «Ждут решения», — а он не
   * заходит, он ждёт сообщения.
   *
   * Повод живёт на праве `finance.approve`, а не `finance.view`: «нажмите
   * Согласовать» тому, у кого этой кнопки нет, — обман, он откроет карточку и
   * не найдёт её.
   */
  private async financePending(tx: Tx): Promise<Event[]> {
    const rows = await tx.$queryRaw<OpRow[]>`
      SELECT o.id, o.number, o.amount::text AS amount, c.code AS currency,
             o.operation_type::text AS type, ci.name_ru AS item_ru, ci.name_uz AS item_uz,
             a.full_name AS who
        FROM finance_operation o
        JOIN currency c ON c.id = o.currency_id
        LEFT JOIN cashflow_item ci ON ci.id = o.cashflow_item_id
        LEFT JOIN user_account a ON a.id = o.created_by
       WHERE o.status = 'pending_approval'
       ORDER BY o.created_at LIMIT ${LIST_LIMIT}`;
    return rows.map((r) => ({
      dedupeKey: `op:${r.id}:pending`,
      ru:
        `<b>Деньги ждут вашего согласования</b>\n` +
        `${opHead(r, false)}${r.who ? `\nОтправил: ${r.who}.` : ''}\n\n` +
        `Что сделать: откройте «Финансы» → «Ждут решения», прочитайте и нажмите ` +
        `«${ACTION.approve.ru}» или «${ACTION.reject.ru}». Пока не нажмёте — деньги стоят.`,
      uz:
        `<b>Pul sizning tasdig‘ingizni kutmoqda</b>\n` +
        `${opHead(r, true)}${r.who ? `\nYubordi: ${r.who}.` : ''}\n\n` +
        `Nima qilish kerak: «Moliya» → «Qarorni kutmoqda» ni ochib, o‘qing va ` +
        `«${ACTION.approve.uz}» yoki «${ACTION.reject.uz}» ni bosing. Bosmaguningizcha pul turadi.`,
    }));
  }

  /**
   * Крупный платёж ждёт подтверждения (требование заказчика 07.10).
   *
   * Условие то же, по которому отказывает сторож в `finance/approval-limits.ts`:
   * платёж дороже порога или получатель вышел за предел периода. Повторять
   * правило в двух местах плохо, но выбора нет: сторож смотрит одну операцию в
   * контексте запроса, а здесь нужен список и сумма по получателю одним
   * запросом. Сойдутся они или разъедутся — проверяет тест: уведомление должно
   * приходить ровно по тем платежам, которые финансист утвердить не может.
   *
   * В тексте есть то, чего нет в обычной заявке: кому платят, кто завёл и
   * сколько этому получателю уже ушло за окно. Без последнего числа
   * подтверждение вслепую — ровно та история, из-за которой порог и просили.
   */
  private async financeBigPending(tx: Tx): Promise<Event[]> {
    const rows = await tx.$queryRaw<BigOpRow[]>`
      SELECT o.id, o.number, o.amount::text AS amount, c.code AS currency,
             o.operation_type::text AS type, ci.name_ru AS item_ru, ci.name_uz AS item_uz,
             a.full_name AS who, p.name_ru AS partner_ru, p.name_uz AS partner_uz,
             o.amount_base::text AS base, co.approval_limit_single::text AS single,
             co.approval_limit_period::text AS period, co.approval_period_days AS days,
             coalesce(t.total, o.amount_base)::text AS total
        FROM finance_operation o
        JOIN company co ON co.id = o.company_id
        JOIN currency c ON c.id = o.currency_id
        LEFT JOIN cashflow_item ci ON ci.id = o.cashflow_item_id
        LEFT JOIN user_account a ON a.id = o.created_by
        LEFT JOIN partner p ON p.id = o.partner_id
        LEFT JOIN LATERAL (
          SELECT sum(x.amount_base) AS total
            FROM finance_operation x
           WHERE x.company_id = o.company_id AND x.partner_id = o.partner_id
             AND x.operation_type = 'expense'
             AND x.status IN ('pending_approval', 'approved', 'posted')
             AND x.occurred_at > o.occurred_at - make_interval(days => co.approval_period_days)
             AND x.occurred_at <= o.occurred_at
        ) t ON o.partner_id IS NOT NULL
       WHERE o.status = 'pending_approval' AND o.operation_type = 'expense'
         AND (
           (co.approval_limit_single IS NOT NULL AND o.amount_base > co.approval_limit_single)
           OR (co.approval_limit_period IS NOT NULL AND o.partner_id IS NOT NULL
               AND coalesce(t.total, 0) > co.approval_limit_period)
         )
       ORDER BY o.created_at LIMIT ${LIST_LIMIT}`;

    return rows.map((r) => {
      const over =
        r.single !== null && Number(r.base) > Number(r.single)
          ? {
              ru: `Порог одной платёжки: ${money(r.single)}.`,
              uz: `Bitta to‘lov chegarasi: ${money(r.single)}.`,
            }
          : {
              ru: `Предел на получателя за ${r.days} дн.: ${money(r.period)}.`,
              uz: `Oluvchiga ${r.days} kun uchun chegara: ${money(r.period)}.`,
            };
      const partner = (uz: boolean) => (uz ? r.partner_uz : r.partner_ru);
      return {
        dedupeKey: `op:${r.id}:big`,
        ru:
          `<b>Крупный платёж ждёт вашего подтверждения</b>\n` +
          `${opHead(r, false)}\n` +
          `${partner(false) ? `Получатель: ${partner(false)}.\n` : ''}` +
          `${r.who ? `Завёл: ${r.who}.\n` : ''}` +
          `${over.ru}\n` +
          `${partner(false) ? `Этому получателю за ${r.days} дн., с этим платежом: ${money(r.total)}.\n` : ''}` +
          `\nЧто сделать: откройте «Финансы» → «Ждут решения» и нажмите ` +
          `«${ACTION.approve.ru}» или «${ACTION.reject.ru}». Обычные платежи проходят без вас, ` +
          `этот — только с вашим «да».`,
        uz:
          `<b>Yirik to‘lov sizning tasdig‘ingizni kutmoqda</b>\n` +
          `${opHead(r, true)}\n` +
          `${partner(true) ? `Oluvchi: ${partner(true)}.\n` : ''}` +
          `${r.who ? `Kiritdi: ${r.who}.\n` : ''}` +
          `${over.uz}\n` +
          `${partner(true) ? `Bu oluvchiga ${r.days} kun ichida, shu to‘lov bilan: ${money(r.total)}.\n` : ''}` +
          `\nNima qilish kerak: «Moliya» → «Qarorni kutmoqda» ni ochib, ` +
          `«${ACTION.approve.uz}» yoki «${ACTION.reject.uz}» ni bosing. Oddiy to‘lovlar sizsiz ` +
          `o‘tadi, bu esa faqat siz «ha» deganda.`,
      };
    });
  }

  /**
   * Согласовано — осталось провести. Отдельный повод, потому что это другая
   * работа и часто другой человек: согласующий сказал «да», но со счёта деньги
   * снимает проводящий, и до его нажатия платежа нет.
   */
  private async financeToPost(tx: Tx): Promise<Event[]> {
    const rows = await tx.$queryRaw<OpRow[]>`
      SELECT o.id, o.number, o.amount::text AS amount, c.code AS currency,
             o.operation_type::text AS type, ci.name_ru AS item_ru, ci.name_uz AS item_uz,
             a.full_name AS who
        FROM finance_operation o
        JOIN currency c ON c.id = o.currency_id
        LEFT JOIN cashflow_item ci ON ci.id = o.cashflow_item_id
        LEFT JOIN user_account a ON a.id = o.approved_by
       WHERE o.status = 'approved'
       ORDER BY o.created_at LIMIT ${LIST_LIMIT}`;
    return rows.map((r) => ({
      dedupeKey: `op:${r.id}:approved`,
      ru:
        `<b>Согласовано, можно проводить</b>\n` +
        `${opHead(r, false)}${r.who ? `\nСогласовал: ${r.who}.` : ''}\n\n` +
        `Что сделать: откройте «Финансы» → «Ждут решения» и нажмите «${ACTION.post.ru}». ` +
        `Деньги пройдут по счёту только после этого.`,
      uz:
        `<b>Tasdiqlandi, kiritish mumkin</b>\n` +
        `${opHead(r, true)}${r.who ? `\nTasdiqladi: ${r.who}.` : ''}\n\n` +
        `Nima qilish kerak: «Moliya» → «Qarorni kutmoqda» ni ochib «${ACTION.post.uz}» ni bosing. ` +
        `Pul faqat shundan keyin hisobdan o‘tadi.`,
    }));
  }

  /**
   * Ответ тому, кто завёл запись: провели, отклонили, сторнировали.
   *
   * Берётся из журнала действий, а не из статуса операции, по двум причинам:
   * в журнале есть время и тот, кто нажал (без него «отклонили» звучит как
   * сбой системы), и журнал различает второй отказ после повторной подачи —
   * по статусу это одно и то же состояние, и человек о втором не узнал бы.
   *
   * Про своё же нажатие бот не пишет, и окно — двое суток: иначе первый проход
   * после включения вывалил бы человеку всю историю.
   */
  private async financeDecided(tx: Tx, userId: bigint): Promise<Event[]> {
    const rows = await tx.$queryRaw<DecisionRow[]>`
      SELECT l.id, l.action, o.number, o.amount::text AS amount, c.code AS currency,
             o.operation_type::text AS type, ci.name_ru AS item_ru, ci.name_uz AS item_uz,
             actor.full_name AS who, o.comment AS note
        FROM audit_log l
        JOIN finance_operation o ON o.uid::text = l.entity_id
        JOIN currency c ON c.id = o.currency_id
        LEFT JOIN cashflow_item ci ON ci.id = o.cashflow_item_id
        LEFT JOIN user_account actor ON actor.id = l.user_id
       WHERE l.entity_type = 'finance_operation'
         AND l.action IN ('post', 'reject', 'reverse')
         AND l.occurred_at > now() - ${DECISION_WINDOW}::interval
         AND o.created_by = ${userId}
         AND (l.user_id IS NULL OR l.user_id <> ${userId})
       ORDER BY l.occurred_at DESC LIMIT ${LIST_LIMIT}`;
    return rows.map((r) => {
      const head = opHead(r, false);
      const headUz = opHead(r, true);
      const note = r.note ? `\nСказали так: «${r.note}».` : '';
      const noteUz = r.note ? `\nIzoh: «${r.note}».` : '';
      const by = r.who ? ` ${r.who}` : '';
      const texts: Record<string, { ru: string; uz: string }> = {
        post: {
          ru:
            `<b>Вашу запись провели</b>\n${head}\nПровёл:${by || ' в системе'}.\n\n` +
            `Деньги прошли по счёту. Делать ничего не нужно.`,
          uz:
            `<b>Yozuvingiz o‘tkazildi</b>\n${headUz}\nO‘tkazdi:${by || ' tizimda'}.\n\n` +
            `Pul hisobdan o‘tdi. Hech narsa qilish shart emas.`,
        },
        reject: {
          ru:
            `<b>Вашу запись отклонили</b>\n${head}\nОтклонил:${by || ' в системе'}.${note}\n\n` +
            `Что сделать: деньги не ушли. Исправьте, что назвали неверно, ` +
            `и заведите запись заново — «Финансы» → «Расход» или «Поступление».`,
          uz:
            `<b>Yozuvingiz rad etildi</b>\n${headUz}\nRad etdi:${by || ' tizimda'}.${noteUz}\n\n` +
            `Nima qilish kerak: pul ketmadi. Xatoni to‘g‘rilab, yozuvni qaytadan kiriting — ` +
            `«Moliya» → «Chiqim» yoki «Kirim».`,
        },
        reverse: {
          ru:
            `<b>Вашу запись сторнировали</b>\n${head}\nСторнировал:${by || ' в системе'}.\n\n` +
            `Это значит, что проведённые деньги вернули назад. ` +
            `Если так и задумано — делать ничего не нужно.`,
          uz:
            `<b>Yozuvingiz bekor qilindi</b>\n${headUz}\nBekor qildi:${by || ' tizimda'}.\n\n` +
            `Ya’ni o‘tkazilgan pul qaytarildi. Shunday kelishilgan bo‘lsa — ` +
            `hech narsa qilish shart emas.`,
        },
      };
      const text = texts[r.action]!;
      return { dedupeKey: `log:${r.id}`, ru: text.ru, uz: text.uz };
    });
  }

  /**
   * Ответ тому, кто выписал документ: утвердили, вернули, подписали, отменили.
   * Возврат без причины человек прочитать не может, поэтому причина из
   * маршрута идёт в текст — она же лежит в карточке.
   */
  private async documentDecided(tx: Tx, userId: bigint): Promise<Event[]> {
    const rows = await tx.$queryRaw<DocDecisionRow[]>`
      SELECT l.id, l.action, d.number, t.name_ru AS type_ru, t.name_uz AS type_uz,
             actor.full_name AS who, d.status_comment AS note
        FROM audit_log l
        JOIN document d ON d.uid::text = l.entity_id
        JOIN document_type t ON t.id = d.document_type_id
        LEFT JOIN user_account actor ON actor.id = l.user_id
       WHERE l.entity_type = 'document'
         AND l.action IN ('approve', 'return', 'sign', 'cancel')
         AND l.occurred_at > now() - ${DECISION_WINDOW}::interval
         AND d.created_by = ${userId}
         AND (l.user_id IS NULL OR l.user_id <> ${userId})
       ORDER BY l.occurred_at DESC LIMIT ${LIST_LIMIT}`;
    return rows.map((r) => {
      const head = `${r.type_ru} ${r.number}.`;
      const headUz = `${r.type_uz} ${r.number}.`;
      const by = r.who ? ` ${r.who}` : '';
      const note = r.note ? `\nСказали так: «${r.note}».` : '';
      const noteUz = r.note ? `\nIzoh: «${r.note}».` : '';
      const texts: Record<string, { ru: string; uz: string }> = {
        approve: {
          ru:
            `<b>Ваш документ утвердили</b>\n${head}\nУтвердил:${by || ' в системе'}.\n\n` +
            `Что сделать: можно отправлять клиенту. Файл — «Документы» → документ → «PDF».`,
          uz:
            `<b>Hujjatingiz tasdiqlandi</b>\n${headUz}\nTasdiqladi:${by || ' tizimda'}.\n\n` +
            `Nima qilish kerak: mijozga yuborish mumkin. Fayl — «Hujjatlar» → hujjat → «PDF».`,
        },
        return: {
          ru:
            `<b>Ваш документ вернули</b>\n${head}\nВернул:${by || ' в системе'}.${note}\n\n` +
            `Что сделать: исправьте то, о чём сказали, и отправьте на согласование снова.`,
          uz:
            `<b>Hujjatingiz qaytarildi</b>\n${headUz}\nQaytardi:${by || ' tizimda'}.${noteUz}\n\n` +
            `Nima qilish kerak: aytilganini to‘g‘rilab, qaytadan tasdiqlashga yuboring.`,
        },
        sign: {
          ru:
            `<b>Ваш документ отметили подписанным</b>\n${head}\nОтметил:${by || ' в системе'}.\n\n` +
            `Бумага подписана обеими сторонами. Делать ничего не нужно.`,
          uz:
            `<b>Hujjatingiz imzolangan deb belgilandi</b>\n${headUz}\nBelgiladi:${by || ' tizimda'}.\n\n` +
            `Qog‘oz ikki tomondan imzolangan. Hech narsa qilish shart emas.`,
        },
        cancel: {
          ru:
            `<b>Ваш документ отменили</b>\n${head}\nОтменил:${by || ' в системе'}.${note}\n\n` +
            `Что сделать: этот документ больше не в деле. Если он всё-таки нужен — выпишите новый.`,
          uz:
            `<b>Hujjatingiz bekor qilindi</b>\n${headUz}\nBekor qildi:${by || ' tizimda'}.${noteUz}\n\n` +
            `Nima qilish kerak: bu hujjat ishdan chiqdi. Kerak bo‘lsa — yangisini chiqaring.`,
        },
      };
      const text = texts[r.action]!;
      return { dedupeKey: `log:${r.id}`, ru: text.ru, uz: text.uz };
    });
  }

  private async paymentOverdue(tx: Tx): Promise<Event[]> {
    const rows = await tx.$queryRawUnsafe<
      { id: bigint; number: string; partner: string; due: Date; debt: string }[]
    >(`
      SELECT o.id, o.number, p.name_ru AS partner, o.payment_due_date AS due,
             (o.amount_total - o.paid_amount)::text AS debt
        FROM sales_order o JOIN partner p ON p.id = o.partner_id
       WHERE ${UNPAID_ORDERS_WHERE} AND o.payment_due_date < current_date
       ORDER BY o.payment_due_date LIMIT ${LIST_LIMIT}`);
    return rows.map((r) => ({
      dedupeKey: `order:${r.id}:${day(r.due)}`,
      ru:
        `<b>Просроченная оплата</b>\n` +
        `Заказ ${r.number}, клиент ${r.partner}.\n` +
        `Должны были заплатить до ${ru(r.due)}, не заплатили: ${money(r.debt)} сум.\n\n` +
        `Что сделать: позвонить клиенту и договориться о дате. ` +
        `Если деньги уже пришли — проведите оплату, и напоминание исчезнет.`,
      uz:
        `<b>Muddati o‘tgan to‘lov</b>\n` +
        `Buyurtma ${r.number}, mijoz ${r.partner}.\n` +
        `${ru(r.due)} gacha to‘lashi kerak edi, to‘lanmadi: ${money(r.debt)} so‘m.\n\n` +
        `Nima qilish kerak: mijozga qo‘ng‘iroq qilib sana belgilang. ` +
        `Pul kelgan bo‘lsa — to‘lovni kiriting, eslatma yo‘qoladi.`,
    }));
  }

  private async documentPending(tx: Tx): Promise<Event[]> {
    const rows = await tx.$queryRaw<
      { id: bigint; number: string; type_ru: string; type_uz: string; amount: string | null }[]
    >`
      SELECT d.id, d.number, t.name_ru AS type_ru, t.name_uz AS type_uz,
             d.amount_total::text AS amount
        FROM document d JOIN document_type t ON t.id = d.document_type_id
       WHERE d.status = 'pending_approval'
       ORDER BY d.document_date LIMIT ${LIST_LIMIT}`;
    return rows.map((r) => ({
      dedupeKey: `doc:${r.id}`,
      ru:
        `<b>Документ ждёт согласования</b>\n` +
        `${r.type_ru} ${r.number}` +
        (r.amount ? ` на ${money(r.amount)} сум` : '') +
        `.\n\nЧто сделать: откройте «Документы» в боте, прочитайте и нажмите ` +
        `«${DOC_ACTION.approve.mark} ${DOC_ACTION.approve.ru}» или ` +
        `«${DOC_ACTION.return.mark} ${DOC_ACTION.return.ru}». Пока не нажмёте — документ стоит.`,
      uz:
        `<b>Hujjat tasdiqlashni kutmoqda</b>\n` +
        `${r.type_uz} ${r.number}` +
        (r.amount ? `, ${money(r.amount)} so‘m` : '') +
        `.\n\nNima qilish kerak: botda «Hujjatlar» ni ochib, o‘qing va ` +
        `«${DOC_ACTION.approve.mark} ${DOC_ACTION.approve.uz}» yoki ` +
        `«${DOC_ACTION.return.mark} ${DOC_ACTION.return.uz}» ni bosing. ` +
        `Bosmaguningizcha hujjat turadi.`,
    }));
  }

  /**
   * Критический остаток — одним сообщением в день на человека. Позиций бывает
   * много, а дело одно: посмотреть и заказать. Пять в списке, остальное числом.
   */
  private async stockCritical(tx: Tx): Promise<Event[]> {
    const { rows, critical } = await this.needs.criticalRows(tx, LIST_LIMIT);
    if (critical === 0) return [];
    const listRu = rows
      .map((r) => `• ${r.item.nameRu}: осталось ${Number(r.available)} ${r.item.unit}`)
      .join('\n');
    const listUz = rows
      .map((r) => `• ${r.item.nameUz}: ${Number(r.available)} ${r.item.unit} qoldi`)
      .join('\n');
    const more = critical > rows.length ? critical - rows.length : 0;
    return [
      {
        dedupeKey: `day:${day(new Date())}`,
        ru:
          `<b>Критический остаток: ${critical}</b>\n${listRu}` +
          (more > 0 ? `\n… и ещё ${more}` : '') +
          `\n\nЭто меньше того запаса, который вы сами назвали крайним. ` +
          `Что сделать: посмотрите «Склад» в боте и скажите, что закупить.`,
        uz:
          `<b>Kritik qoldiq: ${critical}</b>\n${listUz}` +
          (more > 0 ? `\n… va yana ${more}` : '') +
          `\n\nBu siz belgilagan eng kam zaxiradan ham kam. ` +
          `Nima qilish kerak: botda «Ombor» ni ko‘rib, nima sotib olishni ayting.`,
      },
    ];
  }

  private async stageOverdue(tx: Tx): Promise<Event[]> {
    const rows = await tx.$queryRaw<
      { id: bigint; name_ru: string; name_uz: string; number: string; due: Date }[]
    >`
      SELECT s.id, s.name_ru, s.name_uz, o.number, s.planned_end AS due
        FROM production_stage s JOIN production_order o ON o.id = s.production_order_id
       WHERE s.status IN ('pending', 'running', 'paused')
         AND s.planned_end IS NOT NULL AND s.planned_end < now()
       ORDER BY s.planned_end LIMIT ${LIST_LIMIT}`;
    return rows.map((r) => ({
      dedupeKey: `stage:${r.id}:${day(r.due)}`,
      ru:
        `<b>Просроченный этап</b>\n` +
        `Заказ ${r.number}, этап «${r.name_ru}».\n` +
        `Должен был закончиться ${ru(r.due)}, но не закрыт.\n\n` +
        `Что сделать: если работа сделана — отметьте окончание. ` +
        `Если нет — скажите причину, чтобы срок заказа пересчитали.`,
      uz:
        `<b>Muddati o‘tgan bosqich</b>\n` +
        `Buyurtma ${r.number}, bosqich «${r.name_uz}».\n` +
        `${ru(r.due)} da tugashi kerak edi, yopilmagan.\n\n` +
        `Nima qilish kerak: ish bitgan bo‘lsa — tugaganini belgilang. ` +
        `Aks holda sababini ayting, buyurtma muddati qayta hisoblanadi.`,
    }));
  }

  private async taskOverdue(tx: Tx, userId: bigint): Promise<Event[]> {
    const rows = await tx.$queryRaw<{ id: bigint; title: string; due: Date }[]>`
      SELECT id, title, due_at AS due FROM crm_task
       WHERE status = 'open' AND due_at < now() AND assignee_id = ${userId}
       ORDER BY due_at LIMIT ${LIST_LIMIT}`;
    return rows.map((r) => ({
      dedupeKey: `task:${r.id}:${day(r.due)}`,
      ru:
        `<b>Просроченная задача</b>\n` +
        `«${r.title}» — срок был ${ru(r.due)}.\n\n` +
        `Что сделать: выполните и отметьте результат, ` +
        `или перенесите срок, чтобы задача не висела просроченной.`,
      uz:
        `<b>Muddati o‘tgan vazifa</b>\n` +
        `«${r.title}» — muddat ${ru(r.due)} edi.\n\n` +
        `Nima qilish kerak: bajarib natijasini belgilang ` +
        `yoki muddatni ko‘chiring.`,
    }));
  }

  /**
   * Сделка, которую ждали закрыть к сроку. ТЗ 11.1 называет и задачи, и сделки:
   * забытая сделка стоит дороже забытой задачи.
   */
  private async dealOverdue(tx: Tx, userId: bigint): Promise<Event[]> {
    const rows = await tx.$queryRaw<
      { id: bigint; number: string; title: string; partner: string | null; due: Date }[]
    >`
      SELECT d.id, d.number, d.title, p.name_ru AS partner, d.expected_close_date AS due
        FROM deal d LEFT JOIN partner p ON p.id = d.partner_id
       WHERE d.status = 'open' AND d.manager_id = ${userId}
         AND d.expected_close_date IS NOT NULL AND d.expected_close_date < current_date
       ORDER BY d.expected_close_date LIMIT ${LIST_LIMIT}`;
    return rows.map((r) => ({
      dedupeKey: `deal:${r.id}:${day(r.due)}`,
      ru:
        `<b>Сделка стоит</b>\n` +
        `${r.number} «${r.title}»${r.partner ? `, клиент ${r.partner}` : ''}.\n` +
        `Ждали закрыть до ${ru(r.due)}, она всё открыта.\n\n` +
        `Что сделать: позвонить и либо двигать дальше, ` +
        `либо закрыть с причиной — иначе она висит в плане продаж.`,
      uz:
        `<b>Bitim to‘xtab qoldi</b>\n` +
        `${r.number} «${r.title}»${r.partner ? `, mijoz ${r.partner}` : ''}.\n` +
        `${ru(r.due)} gacha yopish kutilgan edi, hali ochiq.\n\n` +
        `Nima qilish kerak: qo‘ng‘iroq qilib davom ettiring ` +
        `yoki sabab bilan yoping.`,
    }));
  }

  /**
   * Заказ завели и назначили человеку. Берём из журнала, потому что важен не
   * сам факт «заказ существует», а то, что его завёл кто-то другой: свой
   * заказ менеджер и так видел на экране, когда нажимал «Записать».
   */
  private async orderAssigned(tx: Tx, userId: bigint): Promise<Event[]> {
    const rows = await tx.$queryRaw<OrderEventRow[]>`
      SELECT l.id, o.number, o.status::text AS status, p.name_ru AS partner,
             o.amount_total::text AS amount, c.code AS currency, actor.full_name AS who
        FROM audit_log l
        JOIN sales_order o ON o.uid::text = l.entity_id
        JOIN partner p ON p.id = o.partner_id
        JOIN currency c ON c.id = o.currency_id
        LEFT JOIN user_account actor ON actor.id = l.user_id
       WHERE l.entity_type = 'sales_order'
         AND l.action = 'create'
         AND l.occurred_at > now() - ${DECISION_WINDOW}::interval
         AND o.manager_id = ${userId}
         AND (l.user_id IS NULL OR l.user_id <> ${userId})
       ORDER BY l.occurred_at DESC LIMIT ${LIST_LIMIT}`;
    return rows.map((r) => ({
      dedupeKey: `log:${r.id}`,
      ru:
        `<b>Новый заказ на вас</b>\n` +
        `${r.number}, клиент ${r.partner}, на ${sum(r.amount, r.currency, false)}.` +
        `${r.who ? `\nЗавёл: ${r.who}.` : ''}\n\n` +
        `Что сделать: откройте «Продажи» → «Все заказы», проверьте товар и срок ` +
        `оплаты. Пока заказ черновик, обещания клиенту ещё нет.`,
      uz:
        `<b>Sizga yangi buyurtma</b>\n` +
        `${r.number}, mijoz ${r.partner}, ${sum(r.amount, r.currency, true)}.` +
        `${r.who ? `\nKiritdi: ${r.who}.` : ''}\n\n` +
        `Nima qilish kerak: «Savdo» → «Barcha buyurtmalar» ni ochib, tovar va ` +
        `to‘lov muddatini tekshiring.`,
    }));
  }

  /**
   * Ваш заказ двинул кто-то другой: подтвердили, зарезервировали, отгрузили,
   * отменили. Менеджер в поле узнаёт об этом из сообщения, а не когда клиент
   * спросит, где его машина.
   */
  private async orderMoved(tx: Tx, userId: bigint): Promise<Event[]> {
    const rows = await tx.$queryRaw<OrderMoveRow[]>`
      SELECT l.id, l.action, l.changes, o.number, p.name_ru AS partner,
             actor.full_name AS who
        FROM audit_log l
        JOIN sales_order o ON o.uid::text = l.entity_id
        JOIN partner p ON p.id = o.partner_id
        LEFT JOIN user_account actor ON actor.id = l.user_id
       WHERE l.entity_type = 'sales_order'
         AND l.action IN ('status', 'ship')
         AND l.occurred_at > now() - ${DECISION_WINDOW}::interval
         AND o.manager_id = ${userId}
         AND (l.user_id IS NULL OR l.user_id <> ${userId})
       ORDER BY l.occurred_at DESC LIMIT ${LIST_LIMIT}`;
    return rows.map((r) => {
      const to = String((r.changes as { status?: { to?: string } })?.status?.to ?? '');
      const by = r.who ? ` ${r.who}` : '';
      const shipped = r.action === 'ship';
      return {
        dedupeKey: `log:${r.id}`,
        ru:
          `<b>${shipped ? 'Ваш заказ отгрузили' : 'Ваш заказ сдвинули'}</b>\n` +
          `${r.number}, клиент ${r.partner}.\n` +
          `Теперь это «${ORDER_STATUS_RU[to] ?? to}».${by ? `\nСделал:${by}.` : ''}\n\n` +
          `Что сделать: посмотрите карточку заказа — там видно оплату и отгрузку. ` +
          `Если клиент ждёт другого, звоните ему сейчас, а не после.`,
        uz:
          `<b>${shipped ? 'Buyurtmangiz jo‘natildi' : 'Buyurtmangiz o‘zgardi'}</b>\n` +
          `${r.number}, mijoz ${r.partner}.\n` +
          `Hozir bu «${ORDER_STATUS_UZ[to] ?? to}».${by ? `\nBajardi:${by}.` : ''}\n\n` +
          `Nima qilish kerak: buyurtma kartasini ko‘ring — to‘lov va jo‘natish ko‘rinadi.`,
      };
    });
  }

  /**
   * Под заказ отложили товар — кладовщику пора собирать.
   *
   * Повод состоянием, а не событием: резерв живёт, пока заказ не уехал, и
   * напомнить о нём надо тому, кто придёт на смену завтра, а не только тому,
   * кто был в сети в минуту резерва.
   */
  private async stockReserved(tx: Tx): Promise<Event[]> {
    const rows = await tx.$queryRaw<ReservedRow[]>`
      SELECT o.id, o.number, p.name_ru AS partner, w.name_ru AS warehouse,
             count(*)::int AS lines
        FROM stock_reservation r
        JOIN sales_order_line sl ON sl.id = r.sales_order_line_id
        JOIN sales_order o ON o.id = sl.sales_order_id
        JOIN partner p ON p.id = o.partner_id
        JOIN warehouse w ON w.id = r.warehouse_id
       WHERE r.status = 'active' AND o.shipment_status = 'none'
         AND o.status NOT IN ('cancelled', 'closed')
       GROUP BY o.id, o.number, p.name_ru, w.name_ru
       ORDER BY o.id LIMIT ${LIST_LIMIT}`;
    return rows.map((r) => ({
      dedupeKey: `order:${r.id}:reserved`,
      ru:
        `<b>Товар под заказ отложен</b>\n` +
        `${r.number}, клиент ${r.partner}. Позиций: ${r.lines}, склад «${r.warehouse}».\n\n` +
        `Что сделать: соберите заказ и отгрузите. Отложенное не продаётся ` +
        `никому другому — пока заказ стоит, товар занят.`,
      uz:
        `<b>Buyurtma uchun tovar band</b>\n` +
        `${r.number}, mijoz ${r.partner}. Pozitsiya: ${r.lines}, ombor «${r.warehouse}».\n\n` +
        `Nima qilish kerak: buyurtmani yig‘ib jo‘nating. Band tovar boshqaga ` +
        `sotilmaydi.`,
    }));
  }

  /**
   * Пересчёт показал разницу, а лист не закрыт. Это деньги на полке: пока
   * расхождение не утвердили или не пересчитали, остаток в системе не равен
   * тому, что лежит на складе.
   */
  private async inventoryVariance(tx: Tx): Promise<Event[]> {
    const rows = await tx.$queryRaw<VarianceRow[]>`
      SELECT s.id, s.number, w.name_ru AS warehouse,
             count(*) FILTER (WHERE l.qty_diff IS NOT NULL AND l.qty_diff <> 0)::int AS diffs
        FROM inventory_sheet s
        JOIN warehouse w ON w.id = s.warehouse_id
        LEFT JOIN inventory_sheet_line l ON l.sheet_id = s.id
       WHERE s.status = 'review'
       GROUP BY s.id, s.number, w.name_ru
      HAVING count(*) FILTER (WHERE l.qty_diff IS NOT NULL AND l.qty_diff <> 0) > 0
       ORDER BY s.id LIMIT ${LIST_LIMIT}`;
    return rows.map((r) => ({
      dedupeKey: `sheet:${r.id}:review`,
      ru:
        `<b>Расхождения в пересчёте</b>\n` +
        `Лист ${r.number}, склад «${r.warehouse}». Не сходится позиций: ${r.diffs}.\n\n` +
        `Что сделать: откройте «Склад» → «Пересчёт». Либо пересчитайте спорное ` +
        `ещё раз, либо утвердите — тогда остаток в системе станет таким, ` +
        `как на полке.`,
      uz:
        `<b>Qayta hisobda farq</b>\n` +
        `Varaq ${r.number}, ombor «${r.warehouse}». Mos kelmagan pozitsiya: ${r.diffs}.\n\n` +
        `Nima qilish kerak: «Ombor» → «Qayta hisob» ni ochib, qaytadan sanang ` +
        `yoki tasdiqlang — shundan keyin qoldiq javonda yotgan bilan tenglashadi.`,
    }));
  }

  /**
   * Ночная копия базы не сделалась.
   *
   * Повод не про чужую работу, а про саму систему, и узнать о нём можно только
   * сообщением: экран копий администратор открывает раз в месяц, а до тех пор
   * он уверен, что копии есть. День без копии — это день, который при потере
   * базы не вернуть.
   *
   * Собирается из журнала `db_backup`, а не из исключения в момент падения:
   * `pg_dump` падает в три ночи, бот в это время может быть не в сети, и
   * отправка «сейчас или никогда» потеряла бы единственную новость, которую
   * терять нельзя. Строка в журнале ждёт, пока бот её прочитает.
   *
   * Разрез — `uid` строки, поэтому повторные падения приходят каждое: пять
   * ночей подряд без копии должны выглядеть как пять сообщений, а не как одно.
   * Окно то же, что у решений, иначе первый проход после включения вывалил бы
   * администратору всю историю неудач.
   */
  private async backupFailed(tx: Tx): Promise<Event[]> {
    const rows = await tx.$queryRaw<
      { uid: string; started_at: Date; file_name: string; error: string | null }[]
    >`
      SELECT uid::text AS uid, started_at, file_name, error
        FROM db_backup
       WHERE status = 'failed'
         AND started_at > now() - ${DECISION_WINDOW}::interval
       ORDER BY started_at DESC LIMIT ${LIST_LIMIT}`;
    return rows.map((r) => ({
      dedupeKey: `backup:${r.uid}`,
      ru:
        `<b>Копия базы не сделалась</b>\n` +
        `Начали ${new Date(r.started_at).toLocaleString('ru-RU')}, файл ${r.file_name}.\n` +
        `Причина: ${(r.error ?? 'причина не записана').slice(0, 300)}\n\n` +
        `Что сделать: откройте «Настройки» → «Копии базы» и нажмите ` +
        `«Сделать копию сейчас». Получится — значит сбой был разовый. ` +
        `Не получится — покажите эту причину тому, кто ведёт сервер: ` +
        `пока копии нет, данные существуют в одном экземпляре.`,
      uz:
        `<b>Baza nusxasi olinmadi</b>\n` +
        `Boshlandi ${new Date(r.started_at).toLocaleString('ru-RU')}, fayl ${r.file_name}.\n` +
        `Sabab: ${(r.error ?? 'sabab yozilmagan').slice(0, 300)}\n\n` +
        `Nima qilish kerak: «Sozlamalar» → «Baza nusxalari» ni ochib ` +
        `«Hozir nusxa olish» ni bosing. Chiqsa — nosozlik bir martalik edi. ` +
        `Chiqmasa — bu sababni serverni yuritadigan odamga ko‘rsating: ` +
        `nusxa bo‘lmaguncha ma’lumot bitta nusxada turadi.`,
    }));
  }

  /** Положить в очередь. Уже лежало — ничего не делаем и не считаем. */
  private async put(userId: bigint, kind: string, event: Event): Promise<number> {
    return this.prisma.withContext(null, [], async (tx) => {
      const rows = await tx.$queryRaw<{ id: bigint }[]>`
        INSERT INTO notification_outbox (user_id, kind, dedupe_key, text_ru, text_uz)
        VALUES (${userId}, ${kind}, ${event.dedupeKey}, ${event.ru}, ${event.uz})
        ON CONFLICT (user_id, kind, dedupe_key) DO NOTHING
        RETURNING id`;
      return rows.length;
    });
  }

  // --- отправка -------------------------------------------------------------

  /**
   * Что ещё не отправлено. Язык берём из профиля: бот и веб говорят одинаково.
   *
   * Берём не первые `limit` строк по времени, а по `perUser` на человека:
   * иначе один директор с накопившимся хвостом занимает всю отправку, и
   * кладовщик не получает своего критического остатка, пока того не разгребут.
   * Проход бота всё равно отдаёт человеку не больше трёх сообщений, так что
   * остальные строки в выборке были бы выброшены.
   */
  pending(limit = 20, perUser = 3): Promise<Pending[]> {
    return this.prisma.withContext(null, [], async (tx) => {
      const rows = await tx.$queryRaw<
        {
          id: bigint;
          user_id: bigint;
          chat_id: bigint;
          locale: string;
          kind: string;
          text_ru: string;
          text_uz: string;
          attempts: number;
        }[]
      >`
        SELECT id, user_id, chat_id, locale, kind, text_ru, text_uz, attempts FROM (
          SELECT o.id, o.user_id, u.telegram_user_id AS chat_id, u.locale::text AS locale,
                 o.kind, o.text_ru, o.text_uz, o.attempts, o.created_at,
                 row_number() OVER (PARTITION BY o.user_id ORDER BY o.created_at) AS rn
            FROM notification_outbox o
            JOIN user_account u ON u.id = o.user_id
           WHERE o.sent_at IS NULL
             AND o.attempts < ${MAX_ATTEMPTS}
             AND u.is_active
             AND u.telegram_user_id IS NOT NULL
             AND NOT u.telegram_blocked
        ) q
         WHERE q.rn <= ${perUser}
         ORDER BY q.created_at
         LIMIT ${limit}`;
      return rows.map((r) => ({
        id: BigInt(r.id),
        userId: BigInt(r.user_id),
        chatId: BigInt(r.chat_id),
        locale: r.locale,
        kind: r.kind,
        textRu: r.text_ru,
        textUz: r.text_uz,
        attempts: r.attempts,
      }));
    });
  }

  markSent(id: bigint): Promise<void> {
    return this.prisma.withContext(null, [], async (tx) => {
      await tx.$executeRaw`
        UPDATE notification_outbox SET sent_at = now(), attempts = attempts + 1, last_error = NULL
         WHERE id = ${id}`;
    });
  }

  markFailed(id: bigint, error: string): Promise<void> {
    return this.prisma.withContext(null, [], async (tx) => {
      await tx.$executeRaw`
        UPDATE notification_outbox
           SET attempts = attempts + 1, last_error = ${error.slice(0, 500)}
         WHERE id = ${id}`;
    });
  }

  /**
   * Человек закрыл боту дверь. Это не ошибка отправки: пока он сам не напишет
   * боту, писать ему нечем. Отмечаем, чтобы очередь не билась об него и чтобы
   * администратор видел это в «Настройки → Люди».
   */
  markBlocked(userId: bigint): Promise<void> {
    return this.prisma.withContext(null, [], async (tx) => {
      await tx.$executeRaw`
        UPDATE user_account
           SET telegram_blocked = true, telegram_blocked_at = now()
         WHERE id = ${userId}`;
    });
  }

  /** Снова доступен: человек вернулся в бота сам. */
  markReachable(userId: bigint): Promise<void> {
    return this.prisma.withContext(null, [], async (tx) => {
      await tx.$executeRaw`
        UPDATE user_account
           SET telegram_blocked = false, telegram_blocked_at = NULL
         WHERE id = ${userId} AND telegram_blocked`;
    });
  }

  // --- настройки человека ---------------------------------------------------

  async settings(userId: bigint): Promise<Map<string, boolean>> {
    const rows = await this.prisma.withContext(
      userId,
      [],
      (tx) =>
        tx.$queryRaw<{ kind: string; enabled: boolean }[]>`
        SELECT kind, enabled FROM notification_setting WHERE user_id = ${userId}`,
    );
    return new Map(rows.map((r) => [r.kind, r.enabled]));
  }

  async toggle(userId: bigint, kind: string): Promise<boolean> {
    const current = (await this.settings(userId)).get(kind) ?? true;
    const next = !current;
    await this.prisma.withContext(userId, [], async (tx) => {
      await tx.$executeRaw`
        INSERT INTO notification_setting (user_id, kind, enabled)
        VALUES (${userId}, ${kind}, ${next})
        ON CONFLICT (user_id, kind)
          DO UPDATE SET enabled = ${next}, updated_at = now()`;
    });
    return next;
  }
}
