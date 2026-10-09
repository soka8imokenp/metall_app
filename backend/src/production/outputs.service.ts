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
import { nextOrderNumber } from './write.service.js';
import { MSG } from '../common/messages.js';
import { say } from '../common/say.js';

/**
 * Выпуск заказа: годное, брак, отход, полуфабрикат и переделка (ТЗ 4.1, Э5).
 *
 * Выпуск — это момент, когда работа цеха превращается в товар. Отсюда правила:
 *
 * - **годное попадает на склад тем же движением, что и любой приход.** Своего
 *   «производственного остатка» в системе нет и не будет: продукция, которой
 *   нет на складе, не продаётся и не считается. Движение делает складская
 *   служба внутри этой же транзакции, тип `output` — он доступен только
 *   изнутри, со складского экрана такой приход не завести;
 * - **партия выпуска принадлежит заказу.** Номер по умолчанию — номер заказа:
 *   через партию прослеживаемость находит, из какого сырья сделана труба,
 *   и обратный путь (ТЗ 3.4) уже написан;
 * - **брак и отход на склад не приходуются.** Их там нет: брак либо
 *   переделывают дочерним заказом, либо списывает цех. Приход брака завёл бы
 *   остаток, который нельзя продать, но видно в отчёте как товар;
 * - **у брака и отхода причина обязательна.** Брак без причины — это цифра,
 *   из которой ничего не следует. Брак дополнительно ложится строкой
 *   `deviation_log` вида `defect`: журнал отклонений растёт из факта;
 * - **переделка — дочерний заказ**, а не правка исходного. Иначе
 *   себестоимость переделки растворится в основном заказе, и «почему эта
 *   труба стоит дороже» объяснить будет нечем;
 * - **выпуск не отменяется.** Движения склада append-only, и продукция уже
 *   лежит на складе: ошибку исправляет склад своим движением, а не
 *   производство задним числом.
 */

export type OutputKindName = 'good' | 'defect' | 'waste' | 'semi';

export type OutputInput = {
  kind: OutputKindName;
  qty: string;
  /** По какому этапу получено. Пусто — по заказу целиком. */
  stageSeq?: number;
  /** Причина: обязательна для брака и отхода. */
  reasonUid?: string;
  /** Полуфабрикат — своя номенклатура; у годного она берётся из заказа. */
  itemCode?: string;
  warehouseCode?: string;
  locationCode?: string;
  batchNumber?: string;
  comment?: string;
};

export type ReworkInput = {
  qty: string;
  dueDate: string;
  comment?: string;
};

export type OutputRow = {
  kind: OutputKindName;
  itemCode: string;
  itemNameRu: string;
  itemNameUz: string;
  unit: string;
  qty: string;
  stageSeq: number | null;
  batchNumber: string | null;
  reasonNameRu: string | null;
  reasonNameUz: string | null;
  /** Что цех сказал об этой записи. Причина — «из-за чего», это — «что было». */
  comment: string | null;
  occurredAt: string;
  userName: string | null;
};

type OrderRow = {
  id: bigint;
  uid: string;
  company_id: bigint;
  company_uid: string;
  number: string;
  status: string;
  item_id: bigint;
  item_code: string;
  unit_id: bigint;
  qty_planned: string;
  qty_produced: string;
  qty_defect: string;
  qty_waste: string;
  tech_card_id: bigint | null;
  tech_card_version: number | null;
  responsible_id: bigint | null;
  sales_order_id: bigint | null;
};

/** Причина какого вида годится этому выпуску. */
const REASON_KIND: Partial<Record<OutputKindName, string>> = {
  defect: 'defect',
  waste: 'waste',
};

/** Что из выпуска ложится на склад. */
const TO_STOCK: OutputKindName[] = ['good', 'semi'];

/** В какой счётчик заказа идёт количество. */
const COUNTER: Partial<Record<OutputKindName, 'qty_produced' | 'qty_defect' | 'qty_waste'>> = {
  good: 'qty_produced',
  defect: 'qty_defect',
  waste: 'qty_waste',
};

const TITLE: Record<OutputKindName, string> = {
  good: 'Годное',
  defect: 'Брак',
  waste: 'Отход',
  semi: 'Полуфабрикат',
};

/**
 * Во сколько раз выпуск может перерасти план, прежде чем это станет похоже на
 * опечатку. Цех иногда делает больше заказанного, и запрещать это нельзя —
 * план запущенного заказа не правят. Но «1000» вместо «10» уедет на склад
 * движением, которое уже не отменить, поэтому верхняя граница нужна.
 */
const MAX_OVER = 2;

const num = (v: string | number) => Number(v);
const qty6 = (v: number) => v.toFixed(6);

@Injectable()
export class ProductionOutputsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly warehouse: WarehouseWriteService,
  ) {}

  /** Что уже выпущено по заказу — лента событий, новые сверху. */
  async list(orderUid: string): Promise<OutputRow[]> {
    const ctx = currentContext();
    if (!ctx?.permissions.has('production.view')) {
      throw new ForbiddenException(MSG.noRight('production.view'));
    }
    return this.prisma.withTenant(async (tx) => {
      const order = await this.orderRow(tx, orderUid);
      return this.rows(tx, order);
    });
  }

  /**
   * Записать выпуск.
   *
   * Одно действие — одна строка `production_output` и, если это товар,
   * одно складское движение. Обе половины в одной транзакции: продукция,
   * которая попала на склад мимо заказа, не объясняется ничем.
   */
  async register(orderUid: string, input: OutputInput): Promise<OutputRow[]> {
    const ctx = this.requireManage();

    return this.prisma.withTenant(async (tx) => {
      const order = await this.orderRow(tx, orderUid);
      if (order.status !== 'in_progress' && order.status !== 'paused') {
        throw new ConflictException(say(
          `Заказ ${order.number} не в работе (статус «${order.status}»): ` +
            'выпуск записывают по идущей работе', `${order.number} buyurtmasi ishda emas (holat «${order.status}»): ` + 'chiqarish davom etayotgan ish bo‘yicha yoziladi'));
      }

      const kind = this.kind(input.kind);
      const qty = num(this.qty(input.qty));
      const item =
        kind === 'semi'
          ? await this.itemRow(tx, order.company_id, this.need(input.itemCode, 'Номенклатура'))
          : { id: order.item_id, code: order.item_code, base_unit_id: order.unit_id, track_batches: await this.tracksBatches(tx, order.item_id) };
      const stageId = await this.stageId(tx, order, input.stageSeq ?? null);
      const reasonId = await this.reasonId(tx, order, kind, input.reasonUid);
      const comment = this.comment(input.comment);

      this.guardTotal(order, kind, qty);

      // Партия выпуска: своя у каждого заказа, и заводит её производство —
      // складу неоткуда знать, из какого задания вышла эта труба.
      let batchId: bigint | null = null;
      let batchNumber: string | null = null;
      if (TO_STOCK.includes(kind) && item.track_batches) {
        batchNumber = (input.batchNumber ?? '').trim() || order.number;
        batchId = await this.batchId(tx, order, item.id, batchNumber);
      } else if (input.batchNumber) {
        throw new UnprocessableEntityException(say(
          `${TITLE[kind]} по ${item.code} партией не учитывается: номер партии здесь лишний`, `${item.code} bo‘yicha ${TITLE[kind]} partiya bilan yuritilmaydi: partiya raqami bu yerda keraksiz`));
      }

      const made = await tx.productionOutput.create({
        data: {
          productionOrderId: order.id,
          ...(stageId ? { stageId } : {}),
          itemId: item.id,
          ...(batchId ? { batchId } : {}),
          qty: qty6(qty),
          kind,
          ...(reasonId ? { reasonId } : {}),
          // Комментарий остаётся и на самой записи выпуска, а не только там,
          // куда она потом разошлась: у годного приход на складе, у брака
          // строка отклонений, у отхода — ничего, и до этого его слова
          // пропадали. Журнал цеха читают по заказу, а не по складу.
          ...(comment ? { comment } : {}),
          ...(ctx.userId ? { userId: BigInt(ctx.userId) } : {}),
        },
        select: { id: true },
      });

      let moveUid: string | null = null;
      if (TO_STOCK.includes(kind)) {
        const where = this.need(input.warehouseCode, 'Склад');
        const brief = await this.warehouse.createIn(
          tx,
          {
            companyUid: order.company_uid,
            operationType: 'output',
            itemCode: item.code,
            qty: qty6(qty),
            toWarehouseCode: where,
            ...(input.locationCode ? { toLocationCode: input.locationCode } : {}),
            ...(batchNumber ? { batchNumber } : {}),
            comment: comment ?? `Выпуск по заказу ${order.number}`,
          },
          undefined,
          { docType: 'production_output', docId: made.id },
        );
        moveUid = brief.uid;
      }

      const counter = COUNTER[kind];
      if (counter === 'qty_produced') {
        await tx.$executeRaw`
          UPDATE production_order SET qty_produced = qty_produced + ${qty6(qty)}::numeric
           WHERE id = ${order.id}`;
      } else if (counter === 'qty_defect') {
        await tx.$executeRaw`
          UPDATE production_order SET qty_defect = qty_defect + ${qty6(qty)}::numeric
           WHERE id = ${order.id}`;
      } else if (counter === 'qty_waste') {
        await tx.$executeRaw`
          UPDATE production_order SET qty_waste = qty_waste + ${qty6(qty)}::numeric
           WHERE id = ${order.id}`;
      }

      // Брак — отклонение, и журнал отклонений растёт из него сам: отдельно
      // заполнять его значит заполнять дважды и расходиться в числах.
      if (kind === 'defect') {
        await tx.$executeRaw`
          INSERT INTO deviation_log
            (company_id, production_order_id, stage_id, kind, reason_id, amount, comment,
             registered_by)
          VALUES (${order.company_id}, ${order.id}, ${stageId}, 'defect', ${reasonId},
                  ${qty6(qty)}::numeric,
                  ${comment ?? `Брак по заказу ${order.number}: ${qty6(qty)} ${item.code}`},
                  ${ctx.userId ?? null})`;
      }

      await writeAudit(tx, {
        companyId: order.company_id,
        entityType: 'production_order',
        entityId: order.uid,
        action: `output.${kind}`,
        changes: {
          number: { from: null, to: order.number },
          item: { from: null, to: item.code },
          qty: { from: null, to: qty6(qty) },
          ...(batchNumber ? { batch: { from: null, to: batchNumber } } : {}),
          ...(moveUid ? { move: { from: null, to: moveUid } } : {}),
          ...(comment ? { comment: { from: null, to: comment } } : {}),
        },
      });

      return this.rows(tx, order);
    });
  }

  /**
   * Завести переделку: дочерний заказ на тот же товар.
   *
   * Переделывают только то, что записано браком и ещё не отдано в переделку:
   * иначе одну и ту же тонну можно переделать трижды, и себестоимость станет
   * выдумкой. Дочерний заказ рождается черновиком — его ещё планируют.
   */
  async rework(orderUid: string, input: ReworkInput) {
    const ctx = this.requireManage();

    return this.prisma.withTenant(async (tx) => {
      const order = await this.orderRow(tx, orderUid);
      const qty = num(this.qty(input.qty));

      const defect = num(order.qty_defect);
      if (defect <= 0) {
        throw new ConflictException(say(
          `По заказу ${order.number} брака не записано: переделывать нечего`, `${order.number} buyurtmasi bo‘yicha nuqson yozilmagan: qayta ishlashga narsa yo‘q`));
      }

      const sent = await tx.$queryRaw<{ sum: string }[]>`
        SELECT coalesce(sum(qty_planned), 0)::text AS sum FROM production_order
         WHERE parent_order_id = ${order.id} AND status <> 'cancelled'`;
      const left = defect - num(sent[0].sum);
      if (qty > left + 1e-9) {
        throw new UnprocessableEntityException(say(
          `В переделку по заказу ${order.number} осталось ${qty6(Math.max(0, left))}: ` +
            'больше брака не записано. Сначала запишите брак, потом переделывайте', `${order.number} buyurtmasi bo‘yicha qayta ishlashga ${qty6(Math.max(0, left))} qoldi: ` + 'bundan ortiq nuqson yozilmagan. Avval nuqsonni yozing, keyin qayta ishlang'));
      }

      const dueDate = this.date(input.dueDate);
      const comment = this.comment(input.comment) ?? `Переделка брака по заказу ${order.number}`;
      const number = await nextOrderNumber(tx, order.company_id);

      const made = await tx.$queryRaw<{ uid: string }[]>`
        INSERT INTO production_order
          (uid, company_id, number, item_id, qty_planned, unit_id, due_date, status, priority,
           responsible_id, sales_order_id, parent_order_id, comment, tech_card_id,
           tech_card_version, created_by)
        VALUES (gen_random_uuid(), ${order.company_id}, ${number}, ${order.item_id},
                ${qty6(qty)}::numeric, ${order.unit_id}, ${dueDate}::date, 'draft', 0,
                ${order.responsible_id}, ${order.sales_order_id}, ${order.id}, ${comment},
                ${order.tech_card_id}, ${order.tech_card_version}, ${ctx.userId ?? null})
        RETURNING uid::text AS uid`;

      await writeAudit(tx, {
        companyId: order.company_id,
        entityType: 'production_order',
        entityId: order.uid,
        action: 'order.rework',
        changes: {
          number: { from: null, to: order.number },
          rework: { from: null, to: number },
          qty: { from: null, to: qty6(qty) },
        },
      });

      return {
        uid: made[0].uid,
        number,
        qtyPlanned: qty6(qty),
        parentNumber: order.number,
        qtyLeftToRework: qty6(Math.max(0, left - qty)),
      };
    });
  }

  // --- внутреннее ----------------------------------------------------------

  private async rows(tx: Tx, order: OrderRow): Promise<OutputRow[]> {
    const rows = await tx.$queryRaw<
      {
        kind: OutputKindName;
        qty: string;
        seq: number | null;
        item_code: string;
        item_name_ru: string;
        item_name_uz: string;
        unit: string;
        batch_number: string | null;
        reason_ru: string | null;
        reason_uz: string | null;
        comment: string | null;
        occurred_at: Date;
        user_name: string | null;
      }[]
    >`
      SELECT o.kind::text AS kind, o.qty::text AS qty, s.seq,
             i.code AS item_code, i.name_ru AS item_name_ru, i.name_uz AS item_name_uz,
             u.code AS unit, b.number AS batch_number,
             r.name_ru AS reason_ru, r.name_uz AS reason_uz, o.comment,
             o.occurred_at, a.full_name AS user_name
        FROM production_output o
        JOIN item i ON i.id = o.item_id
        JOIN unit u ON u.id = i.base_unit_id
        LEFT JOIN production_stage s ON s.id = o.stage_id
        LEFT JOIN batch b ON b.id = o.batch_id
        LEFT JOIN stock_reason r ON r.id = o.reason_id
        LEFT JOIN user_account a ON a.id = o.user_id
       WHERE o.production_order_id = ${order.id}
       ORDER BY o.occurred_at DESC, o.id DESC`;
    return rows.map((r) => ({
      kind: r.kind,
      itemCode: r.item_code,
      itemNameRu: r.item_name_ru,
      itemNameUz: r.item_name_uz,
      unit: r.unit,
      qty: r.qty,
      stageSeq: r.seq ?? null,
      batchNumber: r.batch_number,
      reasonNameRu: r.reason_ru,
      reasonNameUz: r.reason_uz,
      comment: r.comment,
      occurredAt: r.occurred_at.toISOString(),
      userName: r.user_name,
    }));
  }

  /**
   * Партия заказа. Заводим её здесь, а не на складе: партия принадлежит
   * заданию, и без этой связи прослеживаемость не ответит, из какого заказа
   * вышла труба.
   */
  private async batchId(
    tx: Tx,
    order: OrderRow,
    itemId: bigint,
    number: string,
  ): Promise<bigint> {
    const found = await tx.$queryRaw<{ id: bigint; production_order_id: bigint | null }[]>`
      SELECT id, production_order_id FROM batch
       WHERE company_id = ${order.company_id} AND item_id = ${itemId} AND number = ${number}`;
    if (found[0]) {
      // Чужую партию выпуск не пополняет: номер партии — это паспорт металла,
      // и дописать в него сегодняшнюю трубу значит соврать про её
      // происхождение. Своя — та, что заведена этим же заказом.
      if (found[0].production_order_id !== order.id) {
        throw new UnprocessableEntityException(say(
          `Партия ${number} уже заведена и этому заказу не принадлежит: назовите другой номер`, `${number} partiyasi allaqachon kiritilgan va bu buyurtmaga tegishli emas: boshqa raqam ko‘rsating`));
      }
      return found[0].id;
    }
    const made = await tx.batch.create({
      data: {
        companyId: order.company_id,
        itemId,
        number,
        productionOrderId: order.id,
        producedAt: new Date(),
      },
      select: { id: true },
    });
    return made.id;
  }

  /** Сколько всего можно записать: защита от опечатки, а не от цеха. */
  private guardTotal(order: OrderRow, kind: OutputKindName, qty: number) {
    if (!COUNTER[kind]) return;
    const planned = num(order.qty_planned);
    const already =
      num(order.qty_produced) + num(order.qty_defect) + num(order.qty_waste);
    if (planned > 0 && already + qty > planned * MAX_OVER + 1e-9) {
      throw new UnprocessableEntityException(say(
        `Это больше двух планов заказа ${order.number} (план ${qty6(planned)}, ` +
          `уже записано ${qty6(already)}): проверьте число или заведите отдельный заказ`, `Bu ${order.number} buyurtmasining ikki rejasidan ko‘p (reja ${qty6(planned)}, ` + `yozilgani ${qty6(already)}): raqamni tekshiring yoki alohida buyurtma kiriting`));
    }
  }

  private async reasonId(
    tx: Tx,
    order: OrderRow,
    kind: OutputKindName,
    uid: string | undefined,
  ): Promise<bigint | null> {
    const need = REASON_KIND[kind];
    const value = String(uid ?? '').trim();
    if (!need) {
      if (value) {
        throw new UnprocessableEntityException(say(
          `${TITLE[kind]} причины не требует: её называют у брака и отхода`, `${TITLE[kind]} sabab talab qilmaydi: u nuqson va chiqindida ko‘rsatiladi`));
      }
      return null;
    }
    if (!value) {
      throw new UnprocessableEntityException(say(
        kind === 'defect'
          ? 'Назовите причину брака: без неё число ни о чём не говорит'
          : 'Назовите причину отхода: иначе отход не разобрать по видам', kind === 'defect' ? 'Nuqson sababini ko‘rsating: usiz raqam hech narsa demaydi' : 'Chiqindi sababini ko‘rsating: aks holda chiqindini turlarga ajratib bo‘lmaydi'));
    }
    if (!/^[0-9a-f-]{36}$/i.test(value)) {
      throw new UnprocessableEntityException(MSG.reasonNotFound());
    }
    const rows = await tx.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM stock_reason
       WHERE uid = ${value}::uuid AND company_id = ${order.company_id}
         AND kind = ${need}::"ReasonKind" AND is_active`;
    if (!rows[0]) {
      throw new UnprocessableEntityException(say(
        kind === 'defect'
          ? 'Такой причины брака нет в справочнике вашей компании'
          : 'Такой причины отхода нет в справочнике вашей компании', kind === 'defect' ? 'Kompaniyangiz ma’lumotnomasida bunday nuqson sababi yo‘q' : 'Kompaniyangiz ma’lumotnomasida bunday chiqindi sababi yo‘q'));
    }
    return rows[0].id;
  }

  private async tracksBatches(tx: Tx, itemId: bigint): Promise<boolean> {
    const rows = await tx.$queryRaw<{ track_batches: boolean }[]>`
      SELECT track_batches FROM item WHERE id = ${itemId}`;
    return rows[0]?.track_batches ?? false;
  }

  private async stageId(tx: Tx, order: OrderRow, seq: number | null): Promise<bigint | null> {
    if (seq === null || seq === undefined) return null;
    const rows = await tx.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM production_stage
       WHERE production_order_id = ${order.id} AND seq = ${seq}`;
    if (!rows[0]) {
      throw new UnprocessableEntityException(say(`Этапа ${seq} в заказе ${order.number} нет`, `${order.number} buyurtmasida ${seq}-bosqich yo‘q`));
    }
    return rows[0].id;
  }

  private async itemRow(tx: Tx, companyId: bigint, code: string) {
    const rows = await tx.$queryRaw<
      {
        id: bigint;
        code: string;
        base_unit_id: bigint;
        track_batches: boolean;
        is_active: boolean;
      }[]
    >`
      SELECT id, code, base_unit_id, track_batches, is_active FROM item
       WHERE company_id = ${companyId} AND code = ${String(code ?? '').trim()}`;
    const item = rows[0];
    if (!item) throw new UnprocessableEntityException(MSG.itemNotFound(code));
    if (!item.is_active) {
      throw new UnprocessableEntityException(MSG.itemArchived(code));
    }
    return item;
  }

  private async orderRow(tx: Tx, uid: string): Promise<OrderRow> {
    if (!/^[0-9a-f-]{36}$/i.test(uid)) throw new NotFoundException(MSG.orderNotFound());
    const rows = await tx.$queryRaw<OrderRow[]>`
      SELECT o.id, o.uid::text AS uid, o.company_id, c.uid::text AS company_uid, o.number,
             o.status::text AS status, o.item_id, i.code AS item_code, o.unit_id,
             o.qty_planned::text AS qty_planned, o.qty_produced::text AS qty_produced,
             o.qty_defect::text AS qty_defect, o.qty_waste::text AS qty_waste,
             o.tech_card_id, o.tech_card_version, o.responsible_id, o.sales_order_id
        FROM production_order o
        JOIN company c ON c.id = o.company_id
        JOIN item i ON i.id = o.item_id
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

  private kind(raw: string): OutputKindName {
    if (raw === 'good' || raw === 'defect' || raw === 'waste' || raw === 'semi') return raw;
    throw new UnprocessableEntityException(say(
      'Вид выпуска: годное, брак, отход или полуфабрикат', 'Chiqarish turi: yaroqli, nuqson, chiqindi yoki yarim tayyor mahsulot'));
  }

  private need(value: string | undefined, what: string): string {
    const v = String(value ?? '').trim();
    if (!v) throw new UnprocessableEntityException(say(`${what} не указан`, `${what} ko‘rsatilmagan`));
    return v;
  }

  private qty(raw: string): string {
    const value = Number(String(raw ?? '').replace(',', '.'));
    if (!Number.isFinite(value) || value <= 0) {
      throw new UnprocessableEntityException(MSG.qtyPositive());
    }
    if (value > 1e9) throw new UnprocessableEntityException(MSG.qtyTooBig());
    return value.toFixed(6);
  }

  private date(raw: string): string {
    const value = String(raw ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new UnprocessableEntityException(say('Срок указывают датой в виде ГГГГ-ММ-ДД', 'Muddat YYYY-MM-DD ko‘rinishidagi sana bilan ko‘rsatiladi'));
    }
    return value;
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
