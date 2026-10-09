import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { currentContext } from '../common/request-context.js';
import { writeAudit } from '../common/audit.js';
import { WriteService as WarehouseWriteService } from '../warehouse/write.service.js';
import { MSG } from '../common/messages.js';
import { say } from '../common/say.js';

/**
 * Материалы заказа: план расхода, выдача в цех, возврат и факт (ТЗ 4.1, Э4).
 *
 * Своей механики склада у производства нет и не будет: выдача и возврат — это
 * обычные складские движения `issue_to_production` и `return_from_production`,
 * их делает та же служба, что и складской экран. Здесь только то, чего у
 * склада нет: план по заказу, счётчики «выдано / израсходовано / возвращено» и
 * перерасход против нормы.
 *
 * Правила, из-за которых это служба:
 *
 * - **движение и счётчик пишутся одной транзакцией.** Разными у нас однажды
 *   получился бы материал, ушедший со склада мимо заказа: на складе минус, в
 *   заказе ноль, и объяснять это некому;
 * - **выдаёт кладовщик, расход отмечает производство.** Выдача меняет остаток
 *   склада, поэтому требует `warehouse.move`; «израсходовано» склада не
 *   касается — это факт цеха, и он идёт по `production.manage`;
 * - **вернуть и израсходовать можно только то, что на руках.** Больше
 *   выданного за вычетом возвращённого и уже израсходованного — отказ;
 * - **перерасход не прячется.** Расход сверх плана пишет строку
 *   `deviation_log` вида `overuse` с разницей — это и есть журнал отклонений
 *   из ТЗ 4.1;
 * - **план меняют, пока со склада ничего не выдали.** После первой выдачи
 *   перезапись плана стёрла бы то, подо что материал уже ушёл.
 *
 * Чего здесь нет: себестоимости. Деньги по этим движениям считает Э6 — по тем
 * самым движениям, которыми материал выдали, а не по плану.
 */

export type MaterialInput = {
  itemCode: string;
  qtyPlanned: string;
  /** К какому этапу относится расход. Пусто — к заказу целиком. */
  stageSeq?: number;
};

export type MaterialMoveInput = {
  itemCode: string;
  qty: string;
  warehouseCode: string;
  locationCode?: string;
  batchNumber?: string;
  comment?: string;
};

export type MaterialBrief = {
  itemCode: string;
  qtyPlanned: string;
  qtyIssued: string;
  qtyUsed: string;
  qtyReturned: string;
  /** Сколько сейчас на руках у цеха: выдано минус возвращено и израсходовано. */
  qtyOnHand: string;
};

type OrderRow = {
  id: bigint;
  uid: string;
  company_id: bigint;
  company_uid: string;
  number: string;
  status: string;
  qty_planned: string;
  tech_card_id: bigint | null;
};

type MaterialRow = {
  id: bigint;
  item_id: bigint;
  item_code: string;
  qty_planned: string;
  qty_issued: string;
  qty_used: string;
  qty_returned: string;
  unit_id: bigint;
};

/** Статусы, в которых со складом по заказу ещё работают. */
const MOVABLE = ['planned', 'in_progress', 'paused'];

const num = (v: string | number) => Number(v);
const qty6 = (v: number) => v.toFixed(6);

@Injectable()
export class ProductionMaterialsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly warehouse: WarehouseWriteService,
  ) {}

  /**
   * Развернуть план расхода из техкарты заказа.
   *
   * Норма карты задана на единицу продукции, поэтому план — норма на
   * количество заказа. Процент отхода этапа, к которому привязан материал,
   * входит в план: если на этапе теряется 2% материала, выдать надо с запасом,
   * иначе цех остановится на последней трубе. Материал без этапа берётся без
   * надбавки — отход там не описан.
   */
  async planFromCard(orderUid: string): Promise<MaterialBrief[]> {
    this.requireManage();

    return this.prisma.withTenant(async (tx) => {
      const order = await this.orderRow(tx, orderUid);
      this.mustBeOpen(order);
      await this.nothingIssued(tx, order);

      if (!order.tech_card_id) {
        throw new UnprocessableEntityException(say(
          `У заказа ${order.number} нет техкарты: заведите карту на эту продукцию ` +
            'и введите её в работу или задайте материалы руками', `${order.number} buyurtmasida texkarta yo‘q: bu mahsulotga karta kiriting ` + 'va uni ishga tushiring yoki materiallarni qo‘lda bering'));
      }

      const rows = await tx.$queryRaw<
        {
          item_id: bigint;
          code: string;
          unit_id: bigint;
          qty_per_unit: string;
          waste_percent: string | null;
          stage_seq: number | null;
        }[]
      >`
        SELECT m.item_id, i.code, i.base_unit_id AS unit_id, m.qty_per_unit::text AS qty_per_unit,
               s.waste_percent::text AS waste_percent, s.seq AS stage_seq
          FROM tech_card_material m
          JOIN item i ON i.id = m.item_id
          LEFT JOIN tech_card_stage s ON s.id = m.stage_id
         WHERE m.tech_card_id = ${order.tech_card_id}
         ORDER BY i.code`;
      if (rows.length === 0) {
        throw new UnprocessableEntityException(say(
          `В техкарте заказа ${order.number} нет материалов: разворачивать нечего`, `${order.number} buyurtmasining texkartasida material yo‘q: yoyish uchun narsa yo‘q`));
      }

      const total = num(order.qty_planned);
      await tx.$executeRaw`DELETE FROM production_material WHERE production_order_id = ${order.id}`;
      for (const r of rows) {
        const waste = r.waste_percent === null ? 0 : num(r.waste_percent);
        const planned = num(r.qty_per_unit) * total * (1 + waste / 100);
        const stageId = await this.stageId(tx, order, r.stage_seq);
        await tx.$executeRaw`
          INSERT INTO production_material
            (production_order_id, stage_id, item_id, qty_planned, unit_id)
          VALUES (${order.id}, ${stageId}, ${r.item_id}, ${qty6(planned)}::numeric, ${r.unit_id})`;
      }

      await writeAudit(tx, {
        companyId: order.company_id,
        entityType: 'production_order',
        entityId: order.uid,
        action: 'material.plan',
        changes: {
          number: { from: null, to: order.number },
          materials: { from: null, to: rows.length },
        },
      });

      return this.briefs(tx, order);
    });
  }

  /** Задать материалы руками — списком целиком, пока ничего не выдали. */
  async replace(orderUid: string, materials: MaterialInput[]): Promise<MaterialBrief[]> {
    this.requireManage();

    return this.prisma.withTenant(async (tx) => {
      const order = await this.orderRow(tx, orderUid);
      this.mustBeOpen(order);
      await this.nothingIssued(tx, order);

      if (materials.length === 0) {
        throw new UnprocessableEntityException(say(
          'Список материалов пуст: заказ без материалов считать нечем. ' +
            'Если материал правда не нужен, оставьте план из карты', 'Materiallar ro‘yxati bo‘sh: materialsiz buyurtmani hisoblash uchun asos yo‘q. ' + 'Agar material rostdan kerak bo‘lmasa, kartadagi rejani qoldiring'));
      }

      const seen = new Set<string>();
      await tx.$executeRaw`DELETE FROM production_material WHERE production_order_id = ${order.id}`;
      for (const m of materials) {
        const item = await this.itemRow(tx, order.company_id, m.itemCode);
        if (seen.has(item.code)) {
          throw new UnprocessableEntityException(say(
            `Материал ${item.code} в списке дважды: сложите строки в одну`, `${item.code} materiali ro‘yxatda ikki marta: qatorlarni bittaga qo‘shing`));
        }
        seen.add(item.code);
        const stageId = await this.stageId(tx, order, m.stageSeq ?? null);
        await tx.$executeRaw`
          INSERT INTO production_material
            (production_order_id, stage_id, item_id, qty_planned, unit_id)
          VALUES (${order.id}, ${stageId}, ${item.id}, ${this.qty(m.qtyPlanned)}::numeric,
                  ${item.base_unit_id})`;
      }

      await writeAudit(tx, {
        companyId: order.company_id,
        entityType: 'production_order',
        entityId: order.uid,
        action: 'material.plan',
        changes: {
          number: { from: null, to: order.number },
          materials: { from: null, to: materials.length },
        },
      });

      return this.briefs(tx, order);
    });
  }

  /** Выдать материал со склада в цех. Движение делает складская служба. */
  async issue(orderUid: string, input: MaterialMoveInput): Promise<MaterialBrief> {
    return this.move(orderUid, input, 'issue');
  }

  /** Вернуть неиспользованное обратно на склад. */
  async returnToStock(orderUid: string, input: MaterialMoveInput): Promise<MaterialBrief> {
    return this.move(orderUid, input, 'return');
  }

  /**
   * Отметить, сколько материала ушло в работу.
   *
   * Склада это не касается: материал уже в цеху. Касается себестоимости, и
   * поэтому расход сверх плана тут же становится строкой журнала отклонений.
   */
  async use(orderUid: string, input: { itemCode: string; qty: string; comment?: string }) {
    const ctx = this.requireManage();

    return this.prisma.withTenant(async (tx) => {
      const order = await this.orderRow(tx, orderUid);
      if (order.status !== 'in_progress' && order.status !== 'paused') {
        throw new ConflictException(say(
          `Заказ ${order.number} не в работе (статус «${order.status}»): ` +
            'расход отмечают по идущей работе', `${order.number} buyurtmasi ishda emas (holat «${order.status}»): ` + 'sarf davom etayotgan ish bo‘yicha belgilanadi'));
      }

      const row = await this.materialRow(tx, order, input.itemCode);
      const qty = num(this.qty(input.qty));
      const onHand = num(row.qty_issued) - num(row.qty_returned) - num(row.qty_used);
      if (qty > onHand + 1e-9) {
        throw new UnprocessableEntityException(say(
          `В цеху по заказу ${order.number} сейчас ${qty6(onHand)} ${row.item_code}: ` +
            'больше израсходовать нечего. Сначала выдайте материал со склада', `Sexda ${order.number} buyurtmasi bo‘yicha hozir ${qty6(onHand)} ${row.item_code} bor: ` + 'bundan ortiq sarflashga narsa yo‘q. Avval omborda materialni bering'));
      }

      const used = num(row.qty_used) + qty;
      const comment = this.comment(input.comment);
      await tx.$executeRaw`
        UPDATE production_material SET qty_used = ${qty6(used)}::numeric WHERE id = ${row.id}`;

      // Перерасход против плана — отдельной строкой журнала отклонений, и
      // только на ту часть, которая вышла за план именно сейчас.
      const planned = num(row.qty_planned);
      const over = Math.max(0, used - planned) - Math.max(0, num(row.qty_used) - planned);
      if (planned > 0 && over > 1e-9) {
        await tx.$executeRaw`
          INSERT INTO deviation_log
            (company_id, production_order_id, stage_id, kind, amount, comment, registered_by)
          SELECT ${order.company_id}, ${order.id}, pm.stage_id, 'overuse', ${qty6(over)}::numeric,
                 ${comment ?? `Перерасход ${row.item_code}: сверх плана ${qty6(over)}`},
                 ${ctx.userId ?? null}
            FROM production_material pm WHERE pm.id = ${row.id}`;
      }

      await writeAudit(tx, {
        companyId: order.company_id,
        entityType: 'production_order',
        entityId: order.uid,
        action: 'material.use',
        changes: {
          number: { from: null, to: order.number },
          item: { from: null, to: row.item_code },
          qtyUsed: { from: row.qty_used, to: qty6(used) },
          ...(over > 1e-9 ? { overuse: { from: null, to: qty6(over) } } : {}),
          ...(comment ? { comment: { from: null, to: comment } } : {}),
        },
      });

      return this.brief(tx, order, row.id);
    });
  }

  /**
   * Где взять этот материал: склад, ячейка, партия и сколько свободно.
   *
   * Без этого списка выдача превращается в угадывание номера партии: на заводе
   * почти всё сырьё учитывается партиями, и склад откажет, если номер не тот.
   * Спрашиваем у остатков, а не у человека.
   */
  async whereToTake(orderUid: string, itemCode: string) {
    const ctx = currentContext();
    if (!ctx?.permissions.has('production.view')) {
      throw new ForbiddenException(MSG.noRight('production.view'));
    }

    return this.prisma.withTenant(async (tx) => {
      const order = await this.orderRow(tx, orderUid);
      const item = await this.itemRow(tx, order.company_id, itemCode);

      const rows = await tx.$queryRaw<
        {
          warehouse_code: string;
          warehouse_name_ru: string;
          warehouse_name_uz: string;
          location_code: string | null;
          batch_number: string | null;
          free: string;
        }[]
      >`
        SELECT w.code AS warehouse_code, w.name_ru AS warehouse_name_ru,
               w.name_uz AS warehouse_name_uz, l.code AS location_code, b.number AS batch_number,
               (bal.qty_on_hand - bal.qty_reserved)::text AS free
          FROM stock_balance bal
          JOIN warehouse w ON w.id = bal.warehouse_id
          LEFT JOIN storage_location l ON l.id = bal.location_id
          LEFT JOIN batch b ON b.id = bal.batch_id
         WHERE bal.company_id = ${order.company_id} AND bal.item_id = ${item.id}
           AND bal.qty_on_hand - bal.qty_reserved > 0
         ORDER BY bal.qty_on_hand - bal.qty_reserved DESC
         LIMIT 50`;

      return {
        itemCode: item.code,
        /** Пусто — материала на складах нет вовсе, и это ответ, а не ошибка. */
        rows: rows.map((r) => ({
          warehouseCode: r.warehouse_code,
          warehouseNameRu: r.warehouse_name_ru,
          warehouseNameUz: r.warehouse_name_uz,
          locationCode: r.location_code,
          batchNumber: r.batch_number,
          qtyFree: r.free,
        })),
      };
    });
  }

  // --- внутреннее ----------------------------------------------------------

  private async move(
    orderUid: string,
    input: MaterialMoveInput,
    kind: 'issue' | 'return',
  ): Promise<MaterialBrief> {
    // Право складское: остаток меняет это движение, а не заказ. Проверяем до
    // транзакции — ровно там же, где его проверяет складской экран.
    const ctx = currentContext();
    if (!ctx?.permissions.has('warehouse.move')) {
      throw new ForbiddenException(say(
        'Нет права «warehouse.move»: материал со склада выдаёт кладовщик', '«warehouse.move» huquqi yo‘q: materialni ombordan omborchi beradi'));
    }

    return this.prisma.withTenant(async (tx) => {
      const order = await this.orderRow(tx, orderUid);
      if (!MOVABLE.includes(order.status)) {
        throw new ConflictException(say(
          `Заказ ${order.number} в статусе «${order.status}»: ` +
            (order.status === 'draft'
              ? 'сначала запланируйте его — цех ещё не знает об этом заказе'
              : 'материал по нему со складом больше не двигают'), `${order.number} buyurtmasi «${order.status}» holatida: ` + (order.status === 'draft' ? 'avval uni rejalashtiring — sex bu buyurtmani hali bilmaydi' : 'u bo‘yicha material endi ombor bilan harakatlanmaydi')));
      }

      const qty = num(this.qty(input.qty));
      const row = await this.materialRow(tx, order, input.itemCode, kind === 'issue');

      if (kind === 'return') {
        const onHand = num(row.qty_issued) - num(row.qty_returned) - num(row.qty_used);
        if (qty > onHand + 1e-9) {
          throw new UnprocessableEntityException(say(
            `Вернуть можно не больше, чем на руках: по ${row.item_code} это ` +
              `${qty6(onHand)}. Израсходованное возвращают не на склад, а переделкой`, `Qo‘lda borlikdan ortiq qaytarib bo‘lmaydi: ${row.item_code} bo‘yicha bu ` + `${qty6(onHand)}. Sarflangani omborga emas, qayta ishlash orqali qaytariladi`));
        }
      }

      const brief = await this.warehouse.createIn(
        tx,
        {
          // Компанию называем сами: у человека их может быть несколько, и
          // «выбери за меня» здесь неуместно — компания у заказа одна.
          companyUid: order.company_uid,
          operationType: kind === 'issue' ? 'issue_to_production' : 'return_from_production',
          itemCode: row.item_code,
          qty: qty6(qty),
          ...(kind === 'issue'
            ? { fromWarehouseCode: input.warehouseCode, fromLocationCode: input.locationCode }
            : { toWarehouseCode: input.warehouseCode, toLocationCode: input.locationCode }),
          ...(input.batchNumber ? { batchNumber: input.batchNumber } : {}),
          comment: this.comment(input.comment) ?? `Заказ ${order.number}`,
        },
        undefined,
        // Пометка основания: по ней прослеживаемость склада находит, в какой
        // заказ ушла партия (`batches.service`), и это уже написанный код.
        { docType: 'production_material', docId: row.id },
      );

      const issued = kind === 'issue' ? num(row.qty_issued) + qty : num(row.qty_issued);
      const returned = kind === 'return' ? num(row.qty_returned) + qty : num(row.qty_returned);
      await tx.$executeRaw`
        UPDATE production_material
           SET qty_issued = ${qty6(issued)}::numeric, qty_returned = ${qty6(returned)}::numeric
         WHERE id = ${row.id}`;

      await writeAudit(tx, {
        companyId: order.company_id,
        entityType: 'production_order',
        entityId: order.uid,
        action: `material.${kind}`,
        changes: {
          number: { from: null, to: order.number },
          item: { from: null, to: row.item_code },
          qty: { from: null, to: qty6(qty) },
          warehouse: { from: null, to: input.warehouseCode },
          move: { from: null, to: brief.uid },
        },
      });

      return this.brief(tx, order, row.id);
    });
  }

  /**
   * Строка плана под этот материал. При выдаче строки может не быть вовсе:
   * цех попросил то, чего в карте нет. Заводим её с нулевым планом — тогда
   * весь расход по ней станет перерасходом, и это правда.
   */
  private async materialRow(
    tx: Tx,
    order: OrderRow,
    itemCode: string,
    createIfMissing = false,
  ): Promise<MaterialRow> {
    const code = String(itemCode ?? '').trim();
    const found = await tx.$queryRaw<MaterialRow[]>`
      SELECT pm.id, pm.item_id, i.code AS item_code, pm.qty_planned::text AS qty_planned,
             pm.qty_issued::text AS qty_issued, pm.qty_used::text AS qty_used,
             pm.qty_returned::text AS qty_returned, pm.unit_id
        FROM production_material pm JOIN item i ON i.id = pm.item_id
       WHERE pm.production_order_id = ${order.id} AND i.code = ${code}`;
    if (found[0]) return found[0];

    if (!createIfMissing) {
      throw new UnprocessableEntityException(say(
        `Материала ${code} в заказе ${order.number} нет: он не выдавался`, `${order.number} buyurtmasida ${code} materiali yo‘q: u berilmagan`));
    }

    const item = await this.itemRow(tx, order.company_id, code);
    await tx.$executeRaw`
      INSERT INTO production_material (production_order_id, item_id, qty_planned, unit_id)
      VALUES (${order.id}, ${item.id}, 0, ${item.base_unit_id})`;
    const made = await tx.$queryRaw<MaterialRow[]>`
      SELECT pm.id, pm.item_id, i.code AS item_code, pm.qty_planned::text AS qty_planned,
             pm.qty_issued::text AS qty_issued, pm.qty_used::text AS qty_used,
             pm.qty_returned::text AS qty_returned, pm.unit_id
        FROM production_material pm JOIN item i ON i.id = pm.item_id
       WHERE pm.production_order_id = ${order.id} AND i.code = ${code}`;
    return made[0];
  }

  private async briefs(tx: Tx, order: OrderRow): Promise<MaterialBrief[]> {
    const rows = await tx.$queryRaw<
      {
        item_code: string;
        qty_planned: string;
        qty_issued: string;
        qty_used: string;
        qty_returned: string;
      }[]
    >`
      SELECT i.code AS item_code, pm.qty_planned::text AS qty_planned,
             pm.qty_issued::text AS qty_issued, pm.qty_used::text AS qty_used,
             pm.qty_returned::text AS qty_returned
        FROM production_material pm JOIN item i ON i.id = pm.item_id
       WHERE pm.production_order_id = ${order.id} ORDER BY i.code`;
    return rows.map((r) => ({
      itemCode: r.item_code,
      qtyPlanned: r.qty_planned,
      qtyIssued: r.qty_issued,
      qtyUsed: r.qty_used,
      qtyReturned: r.qty_returned,
      qtyOnHand: qty6(num(r.qty_issued) - num(r.qty_returned) - num(r.qty_used)),
    }));
  }

  private async brief(tx: Tx, order: OrderRow, id: bigint): Promise<MaterialBrief> {
    const all = await this.briefs(tx, order);
    const row = await tx.$queryRaw<{ code: string }[]>`
      SELECT i.code FROM production_material pm JOIN item i ON i.id = pm.item_id
       WHERE pm.id = ${id}`;
    return all.find((m) => m.itemCode === row[0].code)!;
  }

  /** План правят, пока со склада по заказу ничего не выдали. */
  private async nothingIssued(tx: Tx, order: OrderRow): Promise<void> {
    const issued = await tx.$queryRaw<{ code: string }[]>`
      SELECT i.code FROM production_material pm JOIN item i ON i.id = pm.item_id
       WHERE pm.production_order_id = ${order.id} AND pm.qty_issued > 0
       ORDER BY i.code LIMIT 1`;
    if (issued[0]) {
      throw new ConflictException(say(
        `По заказу ${order.number} уже выдали ${issued[0].code}: ` +
          'переписать план расхода нельзя, иначе пропадёт то, подо что материал ушёл', `${order.number} buyurtmasi bo‘yicha ${issued[0].code} allaqachon berilgan: ` + 'sarf rejasini qayta yozib bo‘lmaydi, aks holda material nimaga ketgani yo‘qoladi'));
    }
  }

  private mustBeOpen(order: OrderRow) {
    if (!['produced', 'closed', 'cancelled'].includes(order.status)) return;
    throw new ConflictException(say(
      `Заказ ${order.number} уже не в работе (статус «${order.status}»): ` +
        'план расхода по нему переписывать нечего', `${order.number} buyurtmasi endi ishda emas (holat «${order.status}»): ` + 'uning sarf rejasini qayta yozishga hojat yo‘q'));
  }

  private async stageId(tx: Tx, order: OrderRow, seq: number | null): Promise<bigint | null> {
    if (seq === null || seq === undefined) return null;
    const rows = await tx.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM production_stage
       WHERE production_order_id = ${order.id} AND seq = ${seq}`;
    // Этап мог быть ещё не заведён: материал тогда висит на заказе целиком, а
    // не теряется вместе со ссылкой.
    return rows[0]?.id ?? null;
  }

  private async itemRow(tx: Tx, companyId: bigint, code: string) {
    const rows = await tx.$queryRaw<
      { id: bigint; code: string; base_unit_id: bigint; is_active: boolean }[]
    >`
      SELECT id, code, base_unit_id, is_active FROM item
       WHERE company_id = ${companyId} AND code = ${String(code ?? '').trim()}`;
    const item = rows[0];
    if (!item) throw new UnprocessableEntityException(MSG.materialNotFound(code));
    if (!item.is_active) throw new UnprocessableEntityException(MSG.materialArchived(code));
    return item;
  }

  private async orderRow(tx: Tx, uid: string): Promise<OrderRow> {
    if (!/^[0-9a-f-]{36}$/i.test(uid)) throw new NotFoundException(MSG.orderNotFound());
    const rows = await tx.$queryRaw<OrderRow[]>`
      SELECT o.id, o.uid::text AS uid, o.company_id, c.uid::text AS company_uid, o.number,
             o.status::text AS status, o.qty_planned::text AS qty_planned, o.tech_card_id
        FROM production_order o JOIN company c ON c.id = o.company_id
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

  private qty(raw: string): string {
    const value = Number(String(raw ?? '').replace(',', '.'));
    if (!Number.isFinite(value) || value <= 0) {
      throw new UnprocessableEntityException(MSG.qtyPositive());
    }
    if (value > 1e9) throw new UnprocessableEntityException(MSG.qtyTooBig());
    return value.toFixed(6);
  }

  private comment(raw: string | undefined): string | null {
    const value = String(raw ?? '').trim();
    if (value === '') return null;
    if (value.length > 500) {
      throw new UnprocessableEntityException(MSG.commentTooLong());
    }
    return value;
  }
}
