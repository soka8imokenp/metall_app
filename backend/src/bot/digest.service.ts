/**
 * «На что обратить внимание» — первые строки, которые человек видит в боте.
 *
 * Решение клиента 02.10: под приветствием не нужны список компаний и «выберите
 * раздел», нужно то, ради чего он открыл бота. Поэтому здесь не украшение, а
 * числа из базы: что ждёт его решения и что уже просрочено.
 *
 * Правила счёта не переписываем. Долг берётся выражениями из `receivables.ts`,
 * нехватка на складе — `NeedsService.counts`. Иначе бот и веб начнут давать
 * разные ответы на один вопрос, и верить будет нечему.
 *
 * Строка показывается только когда число не ноль: «просрочено 0» — шум, за
 * которым не видно настоящей тревоги. Строки — по правам: кладовщик не узнаёт
 * из приветствия, сколько у компании долгов.
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { NeedsService } from '../warehouse/needs.service.js';
import { OVERDUE_EXPR, UNPAID_ORDERS_WHERE } from '../finance/receivables.js';

/**
 * Насколько строка срочная. Клиент сказал (02.10): в сводке — самое важное и
 * критическое, а не всё, что система умеет посчитать. Поэтому у строки есть
 * вес, и место в подписи достаётся по весу, а не по порядку запросов.
 */
export type Severity = 'critical' | 'attention' | 'info';

export interface Line {
  ru: string;
  uz: string;
  severity: Severity;
}

/** Пять строк — всё, что человек читает одним взглядом, не листая. */
const MAX_LINES = 5;

const MARK: Record<Severity, string> = {
  critical: '🔴',
  attention: '🟡',
  info: 'ℹ️',
};

const WEIGHT: Record<Severity, number> = { critical: 0, attention: 1, info: 2 };

/**
 * Что покажем. Сначала просроченное, потом ждущее решения; строке «как идут
 * дела» место оставляем всегда — руководитель открывает бота ради неё, и
 * вытеснять её пятью тревогами значит прятать то, за чем пришли.
 */
export function pick(lines: Line[]): Line[] {
  const alarms = [...lines]
    .filter((l) => l.severity !== 'info')
    .sort((a, b) => WEIGHT[a.severity] - WEIGHT[b.severity]);
  const info = lines.filter((l) => l.severity === 'info').slice(0, 1);
  return [...alarms.slice(0, MAX_LINES - info.length), ...info];
}

/** Время показа: клиент просил, чтобы сводка каждый раз была свежей и это было видно. */
export function stamp(now: Date = new Date()): string {
  return now.toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Tashkent',
  });
}

const n = (v: number) => v.toLocaleString('ru-RU');
const money = (v: string) => Math.round(Number(v)).toLocaleString('ru-RU');

/**
 * «3 позиций» выдаёт машину с головой. Руководителю бот показывает цифры
 * каждый день — пусть говорит по-русски.
 */
export function plural(v: number, one: string, few: string, many: string): string {
  const hundred = Math.abs(v) % 100;
  const ten = Math.abs(v) % 10;
  if (hundred >= 11 && hundred <= 14) return many;
  if (ten === 1) return one;
  if (ten >= 2 && ten <= 4) return few;
  return many;
}

@Injectable()
export class DigestService {
  private readonly log = new Logger('bot:digest');

  constructor(
    private readonly prisma: PrismaService,
    private readonly needs: NeedsService,
  ) {}

  /**
   * Строки для приветствия. Запрос падать не должен: приветствие важнее сводки,
   * поэтому ошибка здесь гасится и человек видит экран без строк, а не пустоту.
   */
  async lines(
    userId: bigint,
    companyIds: readonly bigint[],
    permissions: Set<string>,
    uz: boolean,
  ): Promise<string[]> {
    try {
      const found = await this.prisma.withContext(userId, companyIds, (tx) =>
        this.collect(tx, userId, permissions),
      );
      const shown = pick(found).map((l) => `${MARK[l.severity]} ${uz ? l.uz : l.ru}`);
      if (shown.length === 0) return [];
      shown.push(uz ? `Yangilandi ${stamp()}` : `Обновлено ${stamp()}`);
      return shown;
    } catch (e) {
      this.log.error(`сводка не собралась: ${(e as Error).message}`);
      return [];
    }
  }

  /**
   * Все строки целиком, без отбора пяти.
   *
   * Приветствие показывает пять — больше человек одним взглядом не читает. А
   * экран «на что смотреть» в разделе «Сводка» открывают намеренно, и там
   * прятать половину тревог нельзя. Счёт один и тот же: иначе приветствие и
   * экран давали бы разные числа об одном и том же.
   */
  async all(
    userId: bigint,
    companyIds: readonly bigint[],
    permissions: Set<string>,
  ): Promise<Line[]> {
    const found = await this.prisma.withContext(userId, companyIds, (tx) =>
      this.collect(tx, userId, permissions),
    );
    return [...found].sort((a, b) => WEIGHT[a.severity] - WEIGHT[b.severity]);
  }

  /** Значок срочности строки: тот же, что в приветствии. */
  static mark(severity: Severity): string {
    return MARK[severity];
  }

  private async collect(tx: Tx, userId: bigint, has: Set<string>): Promise<Line[]> {
    const out: Line[] = [];

    // Руководителю первой строкой — как идут дела: он открывает бота за этим.
    // Иначе строка о продажах оказывается седьмой и в подпись не попадает.
    //
    // Окно — 30 дней, а не «с начала месяца»: второго числа месяц ещё пустой,
    // и руководитель видел бы ноль там, где дела идут. Проверено на стенде.
    if (has.has('dashboard.view')) {
      const rows = await tx.$queryRawUnsafe<{ amt: string }[]>(`
        SELECT COALESCE(sum(amount_total), 0)::text AS amt
          FROM sales_order
         WHERE status <> 'cancelled' AND order_date > current_date - 30`);
      if (Number(rows[0]?.amt ?? 0) > 0) {
        out.push({
          ru: `Продажи за 30 дней: ${money(rows[0]!.amt)} сум`,
          uz: `30 kundagi sotuv: ${money(rows[0]!.amt)} so‘m`,
          severity: 'info',
        });
      }
    }

    // Порядок — по срочности: сначала то, что ждёт решения этого человека,
    // потом просроченное, в конце цифра «как идут дела».
    if (has.has('finance.view')) {
      const pending = await this.count(
        tx,
        `SELECT count(*)::int AS n FROM finance_operation WHERE status = 'pending_approval'`,
      );
      if (pending > 0) {
        out.push({
          ru: `Операции на согласовании: ${n(pending)}`,
          uz: `Tasdiqlashda operatsiyalar: ${n(pending)}`,
          severity: 'attention',
        });
      }

      const debt = await tx.$queryRawUnsafe<{ cnt: number; amt: string }[]>(`
        SELECT count(*) FILTER (WHERE o.payment_due_date < current_date)::int AS cnt,
               ${OVERDUE_EXPR}::text AS amt
          FROM sales_order o
         WHERE ${UNPAID_ORDERS_WHERE}`);
      const overdue = debt[0]?.cnt ?? 0;
      if (overdue > 0) {
        out.push({
          ru:
            `Просроченная оплата: ${n(overdue)} ` +
            `${plural(overdue, 'заказ', 'заказа', 'заказов')} на ${money(debt[0]!.amt)} сум`,
          uz: `Muddati o‘tgan to‘lov: ${n(overdue)} buyurtma, ${money(debt[0]!.amt)} so‘m`,
          severity: 'critical',
        });
      }
    }

    if (has.has('documents.view')) {
      const docs = await this.count(
        tx,
        `SELECT count(*)::int AS n FROM document WHERE status = 'pending_approval'`,
      );
      if (docs > 0) {
        out.push({
          ru: `Документы ждут согласования: ${n(docs)}`,
          uz: `Hujjatlar tasdiqlashni kutmoqda: ${n(docs)}`,
          severity: 'attention',
        });
      }
    }

    if (has.has('warehouse.view')) {
      const { belowCritical, belowMin } = await this.needs.counts(tx);
      if (belowCritical > 0) {
        out.push({
          ru:
            `Критический остаток: ${n(belowCritical)} ` +
            plural(belowCritical, 'позиция', 'позиции', 'позиций'),
          uz: `Kritik qoldiq: ${n(belowCritical)} pozitsiya`,
          severity: 'critical',
        });
      }
      if (belowMin > 0) {
        out.push({
          ru: `Ниже минимума: ${n(belowMin)} ` + plural(belowMin, 'позиция', 'позиции', 'позиций'),
          uz: `Minimumdan past: ${n(belowMin)} pozitsiya`,
          severity: 'attention',
        });
      }
      const sheets = await this.count(
        tx,
        `SELECT count(*)::int AS n FROM inventory_sheet
          WHERE status IN ('draft', 'counting', 'review')`,
      );
      if (sheets > 0) {
        out.push({
          ru: `Незакрытая инвентаризация: ${n(sheets)}`,
          uz: `Yopilmagan inventarizatsiya: ${n(sheets)}`,
          severity: 'attention',
        });
      }
    }

    if (has.has('production.view')) {
      const late = await this.count(
        tx,
        `SELECT count(*)::int AS n FROM production_stage
          WHERE status IN ('pending', 'running', 'paused')
            AND planned_end IS NOT NULL AND planned_end < now()`,
      );
      if (late > 0) {
        out.push({
          ru: `Просроченные этапы производства: ${n(late)}`,
          uz: `Muddati o‘tgan ishlab chiqarish bosqichlari: ${n(late)}`,
          severity: 'critical',
        });
      }
    }

    if (has.has('crm.view')) {
      const tasks = await this.count(
        tx,
        `SELECT count(*)::int AS n FROM crm_task
          WHERE status = 'open' AND due_at < now() AND assignee_id = ${userId}`,
      );
      if (tasks > 0) {
        out.push({
          ru: `Ваши просроченные задачи: ${n(tasks)}`,
          uz: `Muddati o‘tgan vazifalaringiz: ${n(tasks)}`,
          severity: 'critical',
        });
      }
    }

    if (has.has('sales.view')) {
      const waiting = await this.count(
        tx,
        `SELECT count(*)::int AS n FROM sales_order
          WHERE status IN ('confirmed', 'reserved', 'picking')`,
      );
      if (waiting > 0) {
        out.push({
          ru: `Заказы ждут отгрузки: ${n(waiting)}`,
          uz: `Buyurtmalar jo‘natishni kutmoqda: ${n(waiting)}`,
          severity: 'attention',
        });
      }
    }

    return out;
  }

  private async count(tx: Tx, sql: string): Promise<number> {
    const rows = await tx.$queryRawUnsafe<{ n: number }[]>(sql);
    return Number(rows[0]?.n ?? 0);
  }
}
