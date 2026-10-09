import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { currentContext } from '../common/request-context.js';
import { writeAudit } from '../common/audit.js';
import { MSG } from '../common/messages.js';
import { say } from '../common/say.js';

/**
 * Себестоимость производственного заказа (ТЗ 4.7, Э6).
 *
 * Правила, из-за которых это отдельная служба, а не запрос на лету:
 *
 * - **расчёт — снимок, а не формула.** Вчерашняя себестоимость не должна
 *   меняться от сегодняшнего прихода на склад. Пересчёт пишет новую строку
 *   `production_order_cost`, прежняя остаётся с `is_current = false`: иначе
 *   нельзя объяснить, почему цифра изменилась;
 * - **материалы считаются по факту, а не по плану** (ТЗ 4.5): количество —
 *   то, что цех записал израсходованным, цена — та, по которой материал ушёл
 *   со склада. Цену не выдумываем и не берём из прайса: её посчитал метод
 *   компании в момент выдачи и записал в движение;
 * - **полуфабрикат стоит столько, во сколько он обошёлся** (ТЗ 4.7 п.2): если
 *   партию выпустил другой заказ и по нему есть расчёт, берётся его
 *   себестоимость единицы, а не ноль со склада;
 * - **брак базу не уменьшает.** Его стоимость остаётся в заказе и удорожает
 *   годное: иначе брак получается бесплатным, и отчёт по нему теряет смысл;
 * - **переделка добавляется к родителю** (ТЗ 4.6): затраты дочерних заказов
 *   входят отдельной строкой, а не растворяются;
 * - **расчёт переоценивает то, что ещё лежит на складе.** Выпуск приходуется
 *   раньше, чем известна цена, поэтому партия выпуска встаёт на склад нулём.
 *   Расчёт проставляет ей цену — и дальше труба продаётся с настоящей
 *   себестоимостью. То, что успели отгрузить до расчёта, ушло по прежней
 *   цене: журнал движений задним числом не переписывается.
 */

export type CostLine = {
  itemCode: string;
  itemNameRu: string;
  itemNameUz: string;
  unit: string;
  qty: string;
  unitCost: string;
  total: string;
  /** Полуфабрикат оценён по расчёту заказа, который его выпустил. */
  fromOrderNumber: string | null;
};

export type CostSnapshot = {
  calculatedAt: string;
  materialCost: string;
  semiCost: string;
  directCost: string;
  reworkCost: string;
  totalCost: string;
  qtyGood: string;
  unitCost: string;
  isCurrent: boolean;
  calculatedByName: string | null;
};

export type CostResult = CostSnapshot & {
  lines: CostLine[];
  /** Что в расчёте стоит под вопросом: человеку это важнее итога. */
  warnings: string[];
};

type OrderRow = {
  id: bigint;
  uid: string;
  company_id: bigint;
  number: string;
  status: string;
  unit: string;
};

/** Статусы, в которых заказ уже можно считать: работа кончилась. */
const COUNTABLE = ['produced', 'closed'];

/** Глубина обхода переделок: дочерний заказ сам может иметь переделку. */
const MAX_DEPTH = 5;

const num = (v: string | number | null) => Number(v ?? 0);
const money = (v: number) => v.toFixed(4);
const qty6 = (v: number) => v.toFixed(6);

@Injectable()
export class ProductionCostService {
  constructor(private readonly prisma: PrismaService) {}

  /** Текущий расчёт со строками и история: чем отличается от прошлого. */
  async current(orderUid: string): Promise<{ current: CostResult | null; history: CostSnapshot[] }> {
    const ctx = currentContext();
    if (!ctx?.permissions.has('production.view')) {
      throw new ForbiddenException(MSG.noRight('production.view'));
    }

    return this.prisma.withTenant(async (tx) => {
      const order = await this.orderRow(tx, orderUid);
      const rows = await this.snapshots(tx, order);
      if (rows.length === 0) return { current: null, history: [] };

      const now = rows.find((r) => r.isCurrent) ?? rows[0];
      const detail = await this.collect(tx, order, 0);
      return {
        current: { ...now, lines: detail.lines, warnings: detail.warnings },
        history: rows,
      };
    });
  }

  /**
   * Посчитать и зафиксировать себестоимость.
   *
   * Считают по заказу, работа по которому кончилась: пока цех режет, расход
   * ещё не записан, и цифра получилась бы заведомо неполной.
   */
  async calculate(orderUid: string): Promise<CostResult> {
    const ctx = this.requireManage();

    return this.prisma.withTenant(async (tx) => {
      const order = await this.orderRow(tx, orderUid);
      if (!COUNTABLE.includes(order.status)) {
        throw new ConflictException(say(
          `Заказ ${order.number} ещё в работе (статус «${order.status}»): ` +
            'себестоимость считают по выпущенному заказу, когда расход записан', `${order.number} buyurtmasi hali ishda (holat «${order.status}»): ` + 'tannarx chiqarilgan buyurtma bo‘yicha, sarf yozilgandan keyin hisoblanadi'));
      }
      return this.writeSnapshot(tx, order, ctx.userId ?? null, 0);
    });
  }

  /**
   * Расчёт при закрытии заказа — зовётся из перехода статуса (ТЗ 4.7).
   *
   * Отдельным методом, а не повторением правил в двух местах: закрытие и
   * кнопка «Рассчитать» обязаны давать одно и то же число.
   */
  async calculateOnClose(tx: Tx, order: OrderRow, userId: bigint | null): Promise<void> {
    await this.writeSnapshot(tx, order, userId, 0);
  }

  // --- внутреннее ----------------------------------------------------------

  private async writeSnapshot(
    tx: Tx,
    order: OrderRow,
    userId: bigint | null,
    depth: number,
  ): Promise<CostResult> {
    const got = await this.collect(tx, order, depth);

    await tx.$executeRaw`
      UPDATE production_order_cost SET is_current = false
       WHERE production_order_id = ${order.id} AND is_current`;
    await tx.$executeRaw`
      INSERT INTO production_order_cost
        (production_order_id, material_cost, semi_cost, direct_cost, rework_cost, total_cost,
         qty_good, unit_cost, calculated_by, is_current)
      VALUES (${order.id}, ${money(got.materialCost)}::numeric, ${money(got.semiCost)}::numeric,
              ${money(got.directCost)}::numeric, ${money(got.reworkCost)}::numeric,
              ${money(got.totalCost)}::numeric, ${qty6(got.qtyGood)}::numeric,
              ${money(got.unitCost)}::numeric, ${userId}, true)`;

    // Партия выпуска получает цену: до расчёта она стояла на складе нулём, и
    // продажа этой трубы показала бы нулевую себестоимость.
    if (got.unitCost > 0) {
      await tx.$executeRaw`
        UPDATE batch SET unit_cost = ${money(got.unitCost)}::numeric
         WHERE production_order_id = ${order.id}`;
      await tx.$executeRaw`
        UPDATE stock_balance sb SET unit_cost = ${money(got.unitCost)}::numeric
          FROM batch b
         WHERE b.id = sb.batch_id AND b.production_order_id = ${order.id}
           AND sb.qty_on_hand > 0`;
    }

    await writeAudit(tx, {
      companyId: order.company_id,
      entityType: 'production_order',
      entityId: order.uid,
      action: 'cost.calculate',
      changes: {
        number: { from: null, to: order.number },
        totalCost: { from: null, to: money(got.totalCost) },
        unitCost: { from: null, to: money(got.unitCost) },
        qtyGood: { from: null, to: qty6(got.qtyGood) },
      },
    });

    const rows = await this.snapshots(tx, order);
    const now = rows.find((r) => r.isCurrent)!;
    return { ...now, lines: got.lines, warnings: got.warnings };
  }

  /** Собрать числа заказа. Ничего не пишет: этим же считают и предпросмотр. */
  private async collect(tx: Tx, order: OrderRow, depth: number) {
    const warnings: string[] = [];
    const lines: CostLine[] = [];

    /**
     * Материалы: количество — записанный расход, цена — средняя по выдачам
     * этого материала в этот заказ. Выдачу делал склад, и цену в движении
     * посчитал метод компании (ТЗ 5.7): своей оценки у производства нет.
     */
    const materials = await tx.$queryRaw<
      {
        item_code: string;
        name_ru: string;
        name_uz: string;
        unit: string;
        item_type: string;
        qty_used: string;
        qty_on_hand: string;
        moved_qty: string | null;
        moved_amount: string | null;
        semi_unit_cost: string | null;
        semi_order: string | null;
      }[]
    >`
      SELECT i.code AS item_code, i.name_ru, i.name_uz, u.code AS unit,
             i.item_type::text AS item_type,
             pm.qty_used::text AS qty_used,
             (pm.qty_issued - pm.qty_returned - pm.qty_used)::text AS qty_on_hand,
             mv.qty::text AS moved_qty, mv.amount::text AS moved_amount,
             semi.unit_cost::text AS semi_unit_cost, semi.number AS semi_order
        FROM production_material pm
        JOIN item i ON i.id = pm.item_id
        JOIN unit u ON u.id = pm.unit_id
        LEFT JOIN LATERAL (
          SELECT SUM(CASE WHEN m.operation_type = 'issue_to_production' THEN m.qty ELSE -m.qty END) AS qty,
                 SUM(CASE WHEN m.operation_type = 'issue_to_production' THEN m.cost_total
                          ELSE -m.cost_total END) AS amount
            FROM stock_move m
           WHERE m.source_doc_type = 'production_material' AND m.source_doc_id = pm.id
        ) mv ON true
        -- Полуфабрикат своего выпуска: цена — из расчёта того заказа, который
        -- его сделал. Партию выдачи помнит движение.
        LEFT JOIN LATERAL (
          SELECT c.unit_cost, o2.number
            FROM stock_move m
            JOIN batch b ON b.id = m.batch_id
            JOIN production_order o2 ON o2.id = b.production_order_id
            JOIN production_order_cost c ON c.production_order_id = o2.id AND c.is_current
           WHERE m.source_doc_type = 'production_material' AND m.source_doc_id = pm.id
             AND m.operation_type = 'issue_to_production' AND c.unit_cost > 0
           ORDER BY m.id DESC LIMIT 1
        ) semi ON true
       WHERE pm.production_order_id = ${order.id}
       ORDER BY i.code`;

    let materialCost = 0;
    let semiCost = 0;
    for (const m of materials) {
      const used = num(m.qty_used);
      const onHand = num(m.qty_on_hand);
      if (onHand > 1e-9) {
        warnings.push(
          `${m.item_code}: на руках у цеха ещё ${qty6(onHand)} ${m.unit} — ` +
            'верните на склад, иначе расход по заказу неполный',
        );
      }
      if (used <= 0) continue;

      const movedQty = num(m.moved_qty);
      const movedAmount = num(m.moved_amount);
      const fromSemi = m.semi_unit_cost !== null ? num(m.semi_unit_cost) : null;
      const unitCost = fromSemi ?? (movedQty > 0 ? movedAmount / movedQty : 0);
      if (unitCost <= 0) {
        warnings.push(
          `${m.item_code}: цена списания неизвестна — материал попал в заказ без ` +
            'складской выдачи, и в себестоимость он войдёт нулём',
        );
      }
      const total = used * unitCost;
      if (m.item_type === 'semi') semiCost += total;
      else materialCost += total;

      lines.push({
        itemCode: m.item_code,
        itemNameRu: m.name_ru,
        itemNameUz: m.name_uz,
        unit: m.unit,
        qty: qty6(used),
        unitCost: money(unitCost),
        total: money(total),
        fromOrderNumber: fromSemi !== null ? m.semi_order : null,
      });
    }

    /**
     * Прямые затраты цеха: отработанные минуты этапов на ставку участка.
     * Ставок у заказчика пока нет, и нулевая ставка честно даёт ноль — но
     * механизм считает, а не делает вид.
     */
    const direct = await tx.$queryRaw<{ amount: string | null; without_rate: bigint }[]>`
      SELECT SUM(s.actual_duration_min / 60.0 * w.cost_per_hour)::text AS amount,
             count(*) FILTER (WHERE w.id IS NULL OR w.cost_per_hour = 0)::bigint AS without_rate
        FROM production_stage s
        LEFT JOIN work_center w ON w.id = s.work_center_id
       WHERE s.production_order_id = ${order.id} AND s.actual_duration_min > 0`;
    const directCost = num(direct[0]?.amount ?? null);
    if (Number(direct[0]?.without_rate ?? 0) > 0) {
      warnings.push(
        'У части участков не задана стоимость часа: прямые затраты цеха посчитаны не полностью',
      );
    }

    /**
     * Переделки. Дочерний заказ, который уже можно считать, но ещё не
     * посчитан, считаем тут же: иначе итог родителя зависит от того, нажал ли
     * кто-то кнопку на дочернем.
     */
    let reworkCost = 0;
    const children = await tx.$queryRaw<OrderRow[]>`
      SELECT c.id, c.uid::text AS uid, c.company_id, c.number, c.status::text AS status,
             u.code AS unit
        FROM production_order c JOIN unit u ON u.id = c.unit_id
       WHERE c.parent_order_id = ${order.id} AND c.status <> 'cancelled'
       ORDER BY c.id`;
    for (const child of children) {
      const own = await tx.$queryRaw<{ total: string }[]>`
        SELECT total_cost::text AS total FROM production_order_cost
         WHERE production_order_id = ${child.id} AND is_current`;
      if (own[0]) {
        reworkCost += num(own[0].total);
        continue;
      }
      if (COUNTABLE.includes(child.status) && depth < MAX_DEPTH) {
        const made = await this.writeSnapshot(tx, child, null, depth + 1);
        reworkCost += num(made.totalCost);
      } else {
        warnings.push(
          `Переделка ${child.number} ещё в работе (статус «${child.status}»): ` +
            'её затраты в этот расчёт не вошли',
        );
      }
    }

    const good = await tx.$queryRaw<{ qty: string | null }[]>`
      SELECT SUM(qty)::text AS qty FROM production_output
       WHERE production_order_id = ${order.id} AND kind = 'good'`;
    const qtyGood = num(good[0]?.qty ?? null);
    if (qtyGood <= 0) {
      warnings.push('Годного выпуска по заказу нет: себестоимость единицы считать не из чего');
    }

    const totalCost = materialCost + semiCost + directCost + reworkCost;
    // Брак базу не уменьшает: его стоимость остаётся в заказе и удорожает
    // годное (ТЗ 4.7). Поэтому делим на годное, а не на весь выпуск.
    const unitCost = qtyGood > 0 ? totalCost / qtyGood : 0;

    return { materialCost, semiCost, directCost, reworkCost, totalCost, qtyGood, unitCost, lines, warnings };
  }

  private async snapshots(tx: Tx, order: OrderRow): Promise<CostSnapshot[]> {
    const rows = await tx.$queryRaw<
      {
        calculated_at: Date;
        material_cost: string;
        semi_cost: string;
        direct_cost: string;
        rework_cost: string;
        total_cost: string;
        qty_good: string;
        unit_cost: string;
        is_current: boolean;
        full_name: string | null;
      }[]
    >`
      SELECT c.calculated_at, c.material_cost::text, c.semi_cost::text, c.direct_cost::text,
             c.rework_cost::text, c.total_cost::text, c.qty_good::text, c.unit_cost::text,
             c.is_current, a.full_name
        FROM production_order_cost c
        LEFT JOIN user_account a ON a.id = c.calculated_by
       WHERE c.production_order_id = ${order.id}
       ORDER BY c.calculated_at DESC, c.id DESC`;
    return rows.map((r) => ({
      calculatedAt: r.calculated_at.toISOString(),
      materialCost: r.material_cost,
      semiCost: r.semi_cost,
      directCost: r.direct_cost,
      reworkCost: r.rework_cost,
      totalCost: r.total_cost,
      qtyGood: r.qty_good,
      unitCost: r.unit_cost,
      isCurrent: r.is_current,
      calculatedByName: r.full_name,
    }));
  }

  async orderRow(tx: Tx, uid: string): Promise<OrderRow> {
    if (!/^[0-9a-f-]{36}$/i.test(uid)) throw new NotFoundException(MSG.orderNotFound());
    const rows = await tx.$queryRaw<OrderRow[]>`
      SELECT o.id, o.uid::text AS uid, o.company_id, o.number, o.status::text AS status,
             u.code AS unit
        FROM production_order o JOIN unit u ON u.id = o.unit_id
       WHERE o.uid = ${uid}::uuid`;
    if (!rows[0]) throw new NotFoundException(MSG.orderNotFound());
    return rows[0];
  }

  private requireManage() {
    const ctx = currentContext();
    if (!ctx?.permissions.has('production.manage')) {
      throw new ForbiddenException(MSG.noRight('production.manage'));
    }
    return ctx;
  }
}
