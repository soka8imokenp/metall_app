import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import type { OperationType } from '../generated/prisma/client.js';
import { currentContext } from '../common/request-context.js';
import { lockItem, requireAvailable, shiftBalance } from './stock.js';
import { issueUnitCost } from './costing.js';
import { applyReservations } from './reservations.js';
import { guardInventorySides } from './inventory.js';
import { buildCode } from './codes.js';
import { writeAudit } from '../common/audit.js';
import { MSG } from '../common/messages.js';
import { say } from '../common/say.js';

/**
 * Дата операции из формы приходит днём без времени. `new Date('2026-09-28')`
 * читает его как полночь UTC, то есть 05:00 по Ташкенту, и движение,
 * помеченное началом дня, показывалось в журнале пятью часами позже. Смещение
 * зашито числом сознательно: в Узбекистане перехода на летнее время нет, а
 * `AT TIME ZONE` здесь негде применить — дату разбирает не база.
 */
const movedAtOf = (raw?: string): Date =>
  raw ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00+05:00` : raw) : new Date();

/**
 * Приход, списание и перемещение по складу.
 *
 * Журнал движений `stock_move` на уровне базы только пополняется: UPDATE и
 * DELETE по нему запрещены триггером `stock_move_append_only`. Это не прихоть
 * схемы, а условие, без которого остаток на прошлую дату нельзя повторить.
 * Поэтому ошибочное движение здесь не правят и не удаляют — его отменяют
 * зеркальным движением, и в журнале остаются оба.
 *
 * Остаток `stock_balance` — производная от журнала, и меняется в той же
 * транзакции. Расхождение между ними ловит `test/warehouse-stock.spec.ts`
 * сверткой журнала против остатков, поэтому любая ошибка здесь видна снаружи,
 * а не только по коду.
 */

/**
 * Типы, которые делает человек с экрана.
 *
 * Отгрузки (`shipment`) здесь нет и быть не должно: она списывает по продаже,
 * и её заводит ТТН из заказа. Движение, сделанное со склада мимо заказа, увезло
 * бы товар, о котором продажи не знают: заказ остался бы «не отгружен» при
 * пустом складе, а отменить такое движение со склада уже нельзя — на нём стоит
 * документ. Выпуск цеха (`output`) по той же причине рождается в производстве.
 */
export type MoveKind =
  | 'receipt'
  | 'write_off'
  | 'transfer'
  | 'issue_to_production'
  | 'return_from_production'
  | 'return_from_client'
  | 'surplus';

/**
 * Типы, которые склад выполняет, но не заводит сам.
 *
 * `output` — приход продукции из цеха. Движение складское, а основание
 * производственное: количество годного, партия и заказ известны выпуску, а не
 * кладовщику. Поэтому тип доступен только через `createIn` — изнутри чужой
 * транзакции, с пометкой основания, — и ни с какого экрана склада его завести
 * нельзя.
 */
export type InternalMoveKind = MoveKind | 'output';

/**
 * Право, без которого движение этого типа не заводят.
 *
 * Излишек стоит рядом со списанием, а не с приходом: у него нет внешнего
 * основания — ни поставщика, ни цеха. Остаток растёт из ниоткуда по слову
 * человека, и это ровно та же мера доверия, что списать «из ниоткуда» в минус.
 */
const PERMISSION: Record<MoveKind, string> = {
  receipt: 'warehouse.move',
  transfer: 'warehouse.move',
  write_off: 'warehouse.writeoff',
  issue_to_production: 'warehouse.move',
  return_from_production: 'warehouse.move',
  return_from_client: 'warehouse.move',
  surplus: 'warehouse.writeoff',
};

/**
 * Какие стороны у движения. `need` — сторона обязательна, `no` — её не бывает.
 *
 * Таблицей, а не цепочкой проверок: типов стало семь, и правило «у выдачи
 * в цех есть только откуда» должно читаться в одном месте, а не собираться
 * из разрозненных `if`.
 */
const SIDES: Record<InternalMoveKind, { from: 'need' | 'no'; to: 'need' | 'no' }> = {
  receipt: { from: 'no', to: 'need' },
  write_off: { from: 'need', to: 'no' },
  transfer: { from: 'need', to: 'need' },
  issue_to_production: { from: 'need', to: 'no' },
  return_from_production: { from: 'no', to: 'need' },
  return_from_client: { from: 'no', to: 'need' },
  surplus: { from: 'no', to: 'need' },
  output: { from: 'no', to: 'need' },
};

/** Как назвать тип в отказе. */
const TITLE: Record<InternalMoveKind, string> = {
  receipt: 'Приход',
  write_off: 'Списание',
  transfer: 'Перемещение',
  issue_to_production: 'Выдача в производство',
  return_from_production: 'Возврат из производства',
  return_from_client: 'Возврат от клиента',
  surplus: 'Оприходование излишков',
  output: 'Выпуск цеха',
};

/**
 * Причины склада. `downtime` — про простой линии, не про склад, поэтому его тут
 * нет ни у одного типа.
 *
 * Список — на тип операции, а не общий: причина «Брак при транспортировке» на
 * приходе излишка читается как объяснение, которого не было, а «Излишки по
 * инвентаризации» на списании — как списание того, что только нашли. Тип, у
 * которого причины нет вовсе, отвергает её.
 */
const REASON_KINDS: Partial<Record<InternalMoveKind, string[]>> = {
  write_off: ['write_off', 'defect'],
  surplus: ['inventory'],
};

/** Все причины, годные складу: этим списком сужается справочник формы. */
const STOCK_REASONS = [...new Set(Object.values(REASON_KINDS).flat())];

/**
 * Куда уходит номер после движения (ТЗ 5.6).
 *
 * Состояние номера — производная от последнего движения, а не второй учёт:
 * `serial_number.current_state` переписывается в той же транзакции, что и
 * остаток. Перемещение состояние не меняет — труба как лежала на складе, так
 * и лежит, просто на другой полке.
 */
const SERIAL_STATE: Partial<Record<InternalMoveKind, 'in_stock' | 'in_production' | 'written_off'>> = {
  receipt: 'in_stock',
  return_from_production: 'in_stock',
  return_from_client: 'in_stock',
  surplus: 'in_stock',
  issue_to_production: 'in_production',
  write_off: 'written_off',
  output: 'in_stock',
};

export type CreateMoveInput = {
  companyUid?: string;
  operationType: MoveKind;
  itemCode: string;
  batchNumber?: string;
  /** Штучный учёт: одно движение — один номер, количество 1. */
  serialNumber?: string;
  qty: string;
  fromWarehouseCode?: string;
  fromLocationCode?: string;
  toWarehouseCode?: string;
  toLocationCode?: string;
  unitCost?: string;
  reasonId?: string;
  partnerUid?: string;
  movedAt?: string;
  comment?: string;
};

type Brief = {
  uid: string;
  operationType: string;
  qty: string;
  qtyBase: string;
  itemCode: string;
  batchNumber: string | null;
  serialNumber: string | null;
  fromWarehouseCode: string | null;
  fromLocationCode: string | null;
  toWarehouseCode: string | null;
  toLocationCode: string | null;
  reversalOf: string | null;
};

type ItemRow = {
  id: bigint;
  code: string;
  name_ru: string;
  base_unit_id: bigint;
  track_batches: boolean;
  track_serials: boolean;
};

@Injectable()
export class WriteService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Справочники формы. Каждая строка помечена компанией: склад, номенклатура,
   * причина и контрагент живут внутри компании, а у пользователя их бывает
   * несколько — тогда список приезжает объединённым, и названия в нём
   * повторяются дословно. Без пометки форма предложит чужую строку, а отказ
   * человек получит уже на сохранении.
   */
  async refs() {
    return this.prisma.withTenant(async (tx) => {
      const [warehouses, locations, items, reasons, partners] = await Promise.all([
        tx.$queryRaw<
          { company_uid: string; code: string; name_ru: string; name_uz: string }[]
        >`
          SELECT co.uid AS company_uid, w.code, w.name_ru, w.name_uz
            FROM warehouse w
            JOIN company co ON co.id = w.company_id
           WHERE w.is_active
           ORDER BY co.code, w.code`,
        // Ячейки приезжают вместе со складами, а не отдельным запросом по
        // выбранному складу: их на все четыре склада двенадцать штук, второй
        // поход в сеть на каждый выбор склада дороже, чем весь список сразу.
        tx.$queryRaw<
          {
            id: bigint;
            company_uid: string;
            warehouse_code: string;
            zone_code: string;
            zone_name_ru: string;
            zone_name_uz: string;
            code: string;
            barcode: string | null;
          }[]
        >`
          SELECT l.id, co.uid AS company_uid, w.code AS warehouse_code,
                 z.code AS zone_code, z.name_ru AS zone_name_ru, z.name_uz AS zone_name_uz,
                 l.code, l.barcode
            FROM storage_location l
            JOIN warehouse_zone z ON z.id = l.zone_id
            JOIN warehouse w ON w.id = z.warehouse_id
            JOIN company co ON co.id = w.company_id
           WHERE l.is_active AND w.is_active
           ORDER BY co.code, w.code, z.code, l.code`,
        tx.$queryRaw<
          {
            id: bigint;
            company_uid: string;
            code: string;
            name_ru: string;
            name_uz: string;
            unit: string;
            track_batches: boolean;
            track_serials: boolean;
          }[]
        >`
          SELECT i.id, co.uid AS company_uid, i.code, i.name_ru, i.name_uz,
                 u.code AS unit, i.track_batches, i.track_serials
            FROM item i
            JOIN company co ON co.id = i.company_id
            JOIN unit u ON u.id = i.base_unit_id
           WHERE i.is_active
           ORDER BY co.code, i.name_ru`,
        tx.$queryRaw<
          { company_uid: string; id: bigint; kind: string; name_ru: string; name_uz: string }[]
        >`
          SELECT co.uid AS company_uid, r.id, r.kind::text AS kind, r.name_ru, r.name_uz
            FROM stock_reason r
            JOIN company co ON co.id = r.company_id
           WHERE r.kind::text = ANY(${STOCK_REASONS})
           ORDER BY co.code, r.kind, r.name_ru`,
        // Клиенты нужны наравне с поставщиками: возврат от клиента спрашивает
        // клиента, приход — поставщика. Роль отдаём строкой признаков, а не
        // двумя списками: контрагент бывает и тем, и другим сразу.
        tx.$queryRaw<
          {
            company_uid: string;
            uid: string;
            name_ru: string;
            is_supplier: boolean;
            is_client: boolean;
          }[]
        >`
          SELECT co.uid AS company_uid, p.uid, p.name_ru, p.is_supplier, p.is_client
            FROM partner p
            JOIN company co ON co.id = p.company_id
           WHERE p.is_active AND (p.is_supplier OR p.is_client)
           ORDER BY co.code, p.name_ru
           LIMIT 500`,
      ]);

      return {
        warehouses: warehouses.map((w) => ({
          companyUid: w.company_uid,
          code: w.code,
          nameRu: w.name_ru,
          nameUz: w.name_uz,
        })),
        locations: locations.map((l) => ({
          companyUid: l.company_uid,
          warehouseCode: l.warehouse_code,
          zoneCode: l.zone_code,
          zoneNameRu: l.zone_name_ru,
          zoneNameUz: l.zone_name_uz,
          code: l.code,
          barcode: l.barcode,
          labelCode: buildCode('location', l.id),
        })),
        items: items.map((i) => ({
          companyUid: i.company_uid,
          code: i.code,
          nameRu: i.name_ru,
          nameUz: i.name_uz,
          unit: i.unit,
          trackBatches: i.track_batches,
          trackSerials: i.track_serials,
          labelCode: buildCode('item', i.id),
        })),
        // id причины наружу строкой: BigInt не переживёт JSON.
        reasons: reasons.map((r) => ({
          companyUid: r.company_uid,
          id: String(r.id),
          kind: r.kind,
          nameRu: r.name_ru,
          nameUz: r.name_uz,
        })),
        partners: partners.map((p) => ({
          companyUid: p.company_uid,
          uid: p.uid,
          nameRu: p.name_ru,
          isSupplier: p.is_supplier,
          isClient: p.is_client,
        })),
      };
    });
  }

  async create(input: CreateMoveInput, idempotencyKey?: string): Promise<Brief> {
    const ctx = currentContext();

    // Право проверяем по типу движения, а не одно на весь маршрут: списание
    // уводит товар в никуда и стоит отдельного права, приход и перемещение
    // остаток компании не уменьшают.
    // Тип без права в таблице со склада не заводят вовсе: это `output`,
    // выпуск цеха. Он приходит через `createIn` из производства и несёт на
    // себе заказ — со складского экрана такое движение было бы продукцией без
    // основания.
    const need = PERMISSION[input.operationType];
    if (!need) {
      throw new UnprocessableEntityException(say(
        `${TITLE[input.operationType] ?? input.operationType} со склада не заводят: ` +
          'это движение рождается в производстве', `${TITLE[input.operationType] ?? input.operationType} omborda kiritilmaydi: ` + 'bu harakat ishlab chiqarishda tug‘iladi'));
    }
    if (!ctx?.permissions.has(need)) {
      throw new ForbiddenException(MSG.noRight(need));
    }

    return this.prisma.withTenant((tx) => this.createIn(tx, input, idempotencyKey));
  }

  /**
   * То же движение, но внутри чужой транзакции и с пометкой основания.
   *
   * Нужно производству: выдача материала в цех — это одно действие, у которого
   * две половины. Движение по складу и счётчик «выдано» в заказе должны
   * записаться вместе или не записаться вовсе; разными транзакциями однажды
   * получится товар, ушедший со склада мимо заказа.
   *
   * Право здесь не проверяется — его проверяет тот, кто зовёт: у выдачи в цех
   * из производства то же `warehouse.move`, что и со складского экрана, но
   * проверка стоит до открытия транзакции.
   */
  async createIn(
    tx: Tx,
    input: Omit<CreateMoveInput, 'operationType'> & { operationType: InternalMoveKind },
    idempotencyKey?: string,
    source?: { docType: string; docId: bigint },
  ): Promise<Brief> {
    const ctx = currentContext();
    const userId = ctx?.userId ?? null;
    const companyIds = ctx?.companyIds ?? [];

    {
      const companyId = await this.resolveCompany(tx, input.companyUid, companyIds);

      if (idempotencyKey) {
        const seen = await tx.$queryRaw<{ uid: string }[]>`
          SELECT uid FROM stock_move
           WHERE company_id = ${companyId} AND idempotency_key = ${idempotencyKey}`;
        if (seen[0]) return this.brief(tx, seen[0].uid);
      }

      const item = await this.resolveItem(tx, companyId, input.itemCode);
      const qty = this.qty(input.qty);
      const sides = await this.resolveSides(tx, companyId, input);

      // Остаток держим от гонки блокировкой на пару «компания + номенклатура»:
      // без неё два одновременных списания прочитают один и тот же доступный
      // остаток и оба решат, что товара хватает.
      await lockItem(tx, companyId, item.id);

      const batchId = await this.resolveBatch(tx, companyId, item, input, sides);
      const serialId = await this.resolveSerial(tx, companyId, item, input, sides, batchId, qty);
      const reasonId = await this.resolveReason(tx, companyId, input);

      // Пересчёт по одной из сторон — либо запрет, либо пометка (ТЗ 5.8).
      const duringInventory = await guardInventorySides(tx, companyId, [
        { warehouseId: sides.fromWarehouseId, locationId: sides.fromLocationId },
        { warehouseId: sides.toWarehouseId, locationId: sides.toLocationId },
      ]);

      // Себестоимость прихода задаёт человек, у расхода и перемещения её
      // считает метод компании (ТЗ 5.7): назначать её заново значит переписать
      // историю закупки.
      const unitCost =
        sides.fromWarehouseId === null
          ? this.cost(input.unitCost)
          : await issueUnitCost(
              tx,
              companyId,
              sides.fromWarehouseId,
              sides.fromLocationId,
              item.id,
              batchId,
              serialId,
            );

      if (sides.fromWarehouseId !== null) {
        await requireAvailable(
          tx,
          companyId,
          sides.fromWarehouseId,
          sides.fromLocationId,
          item.id,
          batchId,
          qty,
          undefined,
          serialId,
        );
        await shiftBalance(
          tx,
          companyId,
          sides.fromWarehouseId,
          sides.fromLocationId,
          item.id,
          batchId,
          -qty,
          null,
          serialId,
        );
      }
      if (sides.toWarehouseId !== null) {
        await shiftBalance(
          tx,
          companyId,
          sides.toWarehouseId,
          sides.toLocationId,
          item.id,
          batchId,
          qty,
          unitCost,
          serialId,
        );
      }

      // Состояние номера — производная от движения, пишется тут же. Партию
      // номер запоминает на первом приходе: дальше она у него не меняется.
      if (serialId !== null) {
        const state = SERIAL_STATE[input.operationType];
        if (state) {
          await tx.$executeRaw`
            UPDATE serial_number
               SET current_state = ${state}::"SerialState",
                   batch_id = COALESCE(batch_id, ${batchId})
             WHERE id = ${serialId}`;
        }
      }

      // Резерв стоит на складе, а лежит товар в ячейках. Перекладка между
      // полками оставила бы обещанное на старой: там `qty_reserved` стал бы
      // больше наличия, и следующее движение по этой полке упёрлось бы в CHECK
      // `qty_reserved <= qty_on_hand` пятисоткой на ровном месте.
      for (const warehouseId of new Set(
        [sides.fromWarehouseId, sides.toWarehouseId].filter((w): w is bigint => w !== null),
      )) {
        await applyReservations(tx, companyId, item.id, batchId, warehouseId);
      }

      // Строку журнала пишем клиентом Prisma, а не сырым INSERT: `uid` у нас
      // раздаёт клиент (`@default(uuid(7))`), в самой таблице значения по
      // умолчанию нет, и сырая вставка упирается в NOT NULL.
      const made = await tx.stockMove.create({
        data: {
          companyId,
          movedAt: movedAtOf(input.movedAt),
          operationType: input.operationType,
          itemId: item.id,
          batchId,
          serialId,
          fromWarehouseId: sides.fromWarehouseId,
          fromLocationId: sides.fromLocationId,
          toWarehouseId: sides.toWarehouseId,
          toLocationId: sides.toLocationId,
          qty,
          unitId: item.base_unit_id,
          qtyBase: qty,
          costTotal: (qty * unitCost).toFixed(4),
          partnerId: sides.partnerId,
          reasonId,
          duringInventory,
          comment: input.comment ?? null,
          createdBy: userId,
          idempotencyKey: idempotencyKey ?? null,
          ...(source ? { sourceDocType: source.docType, sourceDocId: source.docId } : {}),
        },
        select: { uid: true },
      });

      // Журнал действий (ТЗ 3.4). Склад не писал в него вовсе: само движение
      // видно в журнале склада, но «кто и когда это сделал» там живёт рядом с
      // данными, которые тот же человек и правит. Журнал действий — отдельный
      // след, его нельзя ни исправить, ни удалить.
      await writeAudit(tx, {
        companyId,
        entityType: 'stock_move',
        entityId: made.uid,
        action: 'create',
        changes: {
          operationType: { from: null, to: input.operationType },
          item: { from: null, to: input.itemCode },
          qty: { from: null, to: qty },
          from: { from: null, to: input.fromWarehouseCode ?? null },
          to: { from: null, to: input.toWarehouseCode ?? null },
          ...(input.batchNumber ? { batch: { from: null, to: input.batchNumber } } : {}),
          ...(input.serialNumber ? { serial: { from: null, to: input.serialNumber } } : {}),
        },
      });

      return this.brief(tx, made.uid);
    }
  }

  /**
   * Отмена движения зеркальным движением.
   *
   * Стороны меняются местами, количество то же. Дважды отменить нельзя: вторая
   * отмена вернула бы товар, которого на складе уже нет, и остаток разошёлся бы
   * с журналом. Сторнирующее движение не сторнируют — отменять отмену незачем,
   * для этого заводят обычный приход.
   */
  async reverse(uid: string, comment?: string): Promise<Brief> {
    const ctx = currentContext();
    const userId = ctx?.userId ?? null;

    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.$queryRaw<
        {
          id: bigint;
          company_id: bigint;
          operation_type: string;
          item_id: bigint;
          batch_id: bigint | null;
          serial_id: bigint | null;
          from_warehouse_id: bigint | null;
          from_location_id: bigint | null;
          to_warehouse_id: bigint | null;
          to_location_id: bigint | null;
          qty: string;
          unit_id: bigint;
          cost_total: string;
          partner_id: bigint | null;
          reason_id: bigint | null;
          reversal_of_id: bigint | null;
          source_doc_type: string | null;
          reversed: number;
        }[]
      >`
        SELECT m.id, m.company_id, m.operation_type::text AS operation_type, m.item_id,
               m.batch_id, m.serial_id, m.from_warehouse_id, m.from_location_id,
               m.to_warehouse_id, m.to_location_id, m.qty::text,
               m.unit_id, m.cost_total::text, m.partner_id, m.reason_id, m.reversal_of_id,
               m.source_doc_type,
               (SELECT count(*)::int FROM stock_move r WHERE r.reversal_of_id = m.id) AS reversed
          FROM stock_move m WHERE m.uid = ${uid}::uuid`;
      const move = rows[0];
      if (!move) throw new NotFoundException(say('Движение не найдено', 'Harakat topilmadi'));

      const kind = move.operation_type as MoveKind;
      const need = PERMISSION[kind] ?? 'warehouse.move';
      if (!ctx?.permissions.has(need)) {
        throw new ForbiddenException(MSG.noRight(need));
      }
      if (move.reversal_of_id !== null) {
        throw new ConflictException(say('Это уже сторно: отменять отмену нечем', 'Bu allaqachon storno: bekor qilishni bekor qilib bo‘lmaydi'));
      }
      // Движение отгрузки или цеха — след документа, а не самостоятельная
      // запись. Отменить его со склада значит вернуть товар на остаток, оставив
      // отгрузку отгруженной: документ и склад начнут рассказывать разное.
      if (move.source_doc_type !== null) {
        throw new ConflictException(say(
          'Движение принадлежит документу: отменяйте документ, а не движение', 'Harakat hujjatga tegishli: harakatni emas, hujjatni bekor qiling'));
      }
      if (move.reversed > 0) {
        throw new ConflictException(say('Движение уже отменено', 'Harakat allaqachon bekor qilingan'));
      }

      const qty = Number(move.qty);
      await lockItem(tx, move.company_id, move.item_id);

      // Отмена — такое же движение по полке, и пересчёт её так же закрывает:
      // вернуть товар в считаемую зону значит сбить уже сделанный подсчёт.
      const duringInventory = await guardInventorySides(tx, move.company_id, [
        { warehouseId: move.from_warehouse_id, locationId: move.from_location_id },
        { warehouseId: move.to_warehouse_id, locationId: move.to_location_id },
      ]);

      // Зеркало: куда было — оттуда снимаем, откуда было — туда возвращаем.
      // Снимать проверяем так же, как обычный расход: товар с прихода могли уже
      // увезти, и тогда отменять нечего — иначе остаток уйдёт в минус.
      const unitCost = qty === 0 ? 0 : Number(move.cost_total) / qty;
      if (move.to_warehouse_id !== null) {
        await requireAvailable(
          tx,
          move.company_id,
          move.to_warehouse_id,
          move.to_location_id,
          move.item_id,
          move.batch_id,
          qty,
          undefined,
          move.serial_id,
        );
        await shiftBalance(
          tx,
          move.company_id,
          move.to_warehouse_id,
          move.to_location_id,
          move.item_id,
          move.batch_id,
          -qty,
          null,
          move.serial_id,
        );
      }
      if (move.from_warehouse_id !== null) {
        await shiftBalance(
          tx,
          move.company_id,
          move.from_warehouse_id,
          move.from_location_id,
          move.item_id,
          move.batch_id,
          qty,
          unitCost,
          move.serial_id,
        );
      }

      // Состояние номера после отмены берём с остатка, а не из типа движения:
      // тип у сторно тот же, что у отменяемого, и восстановить по нему нечего.
      // Лежит на складе — `in_stock`; не лежит — `written_off`: отдельного
      // «номер не заводился» в перечислении нет, а отменённый приход именно
      // выбытие и означает.
      if (move.serial_id !== null) {
        const left = await tx.$queryRaw<{ qty: string }[]>`
          SELECT COALESCE(SUM(qty_on_hand), 0)::text AS qty
            FROM stock_balance WHERE serial_id = ${move.serial_id}`;
        const state = Number(left[0]?.qty ?? 0) > 0 ? 'in_stock' : 'written_off';
        await tx.$executeRaw`
          UPDATE serial_number SET current_state = ${state}::"SerialState"
           WHERE id = ${move.serial_id}`;
      }

      // Сторно двигает остаток так же, как движение, — значит и резерв по
      // затронутым складам надо разложить заново.
      for (const warehouseId of new Set(
        [move.from_warehouse_id, move.to_warehouse_id].filter((w): w is bigint => w !== null),
      )) {
        await applyReservations(tx, move.company_id, move.item_id, move.batch_id, warehouseId);
      }

      const made = await tx.stockMove.create({
        data: {
          companyId: move.company_id,
          movedAt: new Date(),
          operationType: move.operation_type as OperationType,
          itemId: move.item_id,
          batchId: move.batch_id,
          serialId: move.serial_id,
          // Стороны меняются местами вместе с ячейками: это и есть зеркало.
          // Ячейку зеркала не выбирают заново — товар возвращается на ту же
          // полку, откуда его увезли, иначе отмена сама станет перемещением.
          fromWarehouseId: move.to_warehouse_id,
          fromLocationId: move.to_location_id,
          toWarehouseId: move.from_warehouse_id,
          toLocationId: move.from_location_id,
          qty: move.qty,
          unitId: move.unit_id,
          qtyBase: move.qty,
          costTotal: move.cost_total,
          partnerId: move.partner_id,
          reasonId: move.reason_id,
          reversalOfId: move.id,
          duringInventory,
          comment: comment ?? null,
          createdBy: userId,
        },
        select: { uid: true },
      });

      // Отмена — то же действие с деньгами и остатком, что и само движение,
      // поэтому в журнале стоит отдельной записью, а не правкой прежней.
      await writeAudit(tx, {
        companyId: move.company_id,
        entityType: 'stock_move',
        entityId: made.uid,
        action: 'reverse',
        changes: {
          reversalOf: { from: null, to: uid },
          operationType: { from: null, to: move.operation_type },
          qty: { from: null, to: Number(move.qty) },
          ...(comment ? { comment: { from: null, to: comment } } : {}),
        },
      });

      return this.brief(tx, made.uid);
    });
  }

  /** Короткая карточка движения: то, что экран показывает сразу после записи. */
  private async brief(tx: Tx, uid: string): Promise<Brief> {
    const rows = await tx.$queryRaw<
      {
        uid: string;
        operation_type: string;
        qty: string;
        qty_base: string;
        item_code: string;
        batch_number: string | null;
        serial_number: string | null;
        from_code: string | null;
        from_location: string | null;
        to_code: string | null;
        to_location: string | null;
        reversal_of: string | null;
      }[]
    >`
      SELECT m.uid, m.operation_type::text AS operation_type, m.qty::text, m.qty_base::text,
             i.code AS item_code, b.number AS batch_number, sn.number AS serial_number,
             fw.code AS from_code, tw.code AS to_code,
             CASE WHEN fl.id IS NULL THEN NULL ELSE fz.code || '/' || fl.code END AS from_location,
             CASE WHEN tl.id IS NULL THEN NULL ELSE tz.code || '/' || tl.code END AS to_location,
             r.uid AS reversal_of
        FROM stock_move m
        JOIN item i ON i.id = m.item_id
        LEFT JOIN batch b ON b.id = m.batch_id
        LEFT JOIN serial_number sn ON sn.id = m.serial_id
        LEFT JOIN warehouse fw ON fw.id = m.from_warehouse_id
        LEFT JOIN warehouse tw ON tw.id = m.to_warehouse_id
        LEFT JOIN storage_location fl ON fl.id = m.from_location_id
        LEFT JOIN warehouse_zone fz   ON fz.id = fl.zone_id
        LEFT JOIN storage_location tl ON tl.id = m.to_location_id
        LEFT JOIN warehouse_zone tz   ON tz.id = tl.zone_id
        LEFT JOIN stock_move r ON r.id = m.reversal_of_id
       WHERE m.uid = ${uid}::uuid`;
    const r = rows[0];
    return {
      uid: r.uid,
      operationType: r.operation_type,
      qty: r.qty,
      qtyBase: r.qty_base,
      itemCode: r.item_code,
      batchNumber: r.batch_number,
      serialNumber: r.serial_number,
      fromWarehouseCode: r.from_code,
      fromLocationCode: r.from_location,
      toWarehouseCode: r.to_code,
      toLocationCode: r.to_location,
      reversalOf: r.reversal_of,
    };
  }

  /** Стороны движения по его типу. Лишняя сторона — не мелочь: она меняет смысл. */
  private async resolveSides(
    tx: Tx,
    companyId: bigint,
    input: Omit<CreateMoveInput, 'operationType'> & { operationType: InternalMoveKind },
  ) {
    const { operationType: type, fromWarehouseCode: from, toWarehouseCode: to } = input;

    const rule = SIDES[type];
    if (!rule) throw new UnprocessableEntityException(say('Неизвестный тип операции', 'Operatsiya turi noma’lum'));
    const title = TITLE[type];

    if (rule.from === 'need' && !from) {
      throw new UnprocessableEntityException(say(`${title}: нужен склад отправления`, `${title}: jo‘natuvchi ombor kerak`));
    }
    if (rule.from === 'no' && from) {
      throw new UnprocessableEntityException(say(`${title}: склад отправления не указывается`, `${title}: jo‘natuvchi ombor ko‘rsatilmaydi`));
    }
    if (rule.to === 'need' && !to) {
      throw new UnprocessableEntityException(say(`${title}: нужен склад получения`, `${title}: qabul qiluvchi ombor kerak`));
    }
    if (rule.to === 'no' && to) {
      throw new UnprocessableEntityException(say(`${title}: склад получения не указывается`, `${title}: qabul qiluvchi ombor ko‘rsatilmaydi`));
    }
    if (rule.from === 'no' && input.fromLocationCode) {
      throw new UnprocessableEntityException(say(`${title}: ячейка отправления не указывается`, `${title}: jo‘natuvchi yacheyka ko‘rsatilmaydi`));
    }
    if (rule.to === 'no' && input.toLocationCode) {
      throw new UnprocessableEntityException(say(`${title}: ячейка получения не указывается`, `${title}: qabul qiluvchi yacheyka ko‘rsatilmaydi`));
    }

    const fromWarehouseId = from ? await this.warehouseId(tx, companyId, from) : null;
    const toWarehouseId = to ? await this.warehouseId(tx, companyId, to) : null;

    const fromLocationId =
      fromWarehouseId === null
        ? null
        : await this.locationId(tx, fromWarehouseId, from!, input.fromLocationCode, 'отправления');
    const toLocationId =
      toWarehouseId === null
        ? null
        : await this.locationId(tx, toWarehouseId, to!, input.toLocationCode, 'получения');

    // Перемещение внутри склада между ячейками — обычная работа кладовщика:
    // товар переложили с открытой площадки под навес. А вот перемещение из
    // ячейки в неё же не двигает ничего: остаток тот же, а в журнале остаётся
    // строка, по которой потом ищут пропавший товар.
    if (
      fromWarehouseId !== null &&
      fromWarehouseId === toWarehouseId &&
      fromLocationId === toLocationId
    ) {
      throw new UnprocessableEntityException(say(
        fromLocationId === null
          ? 'Склады перемещения должны различаться'
          : 'Ячейки перемещения должны различаться', fromLocationId === null ? 'Ko‘chirish omborlari har xil bo‘lishi kerak' : 'Ko‘chirish yacheykalari har xil bo‘lishi kerak'));
    }

    // Возврат от клиента без клиента — товар, взявшийся ниоткуда: по такой
    // строке потом не ответить, кому его вернули и по какой отгрузке.
    if (type === 'return_from_client' && !input.partnerUid) {
      throw new UnprocessableEntityException(say('Возврат от клиента: укажите контрагента', 'Mijozdan qaytarish: kontragentni ko‘rsating'));
    }

    let partnerId: bigint | null = null;
    if (input.partnerUid) {
      const rows = await tx.$queryRaw<{ id: bigint; is_supplier: boolean; is_client: boolean }[]>`
        SELECT id, is_supplier, is_client FROM partner
         WHERE company_id = ${companyId} AND uid = ${input.partnerUid}::uuid`;
      if (!rows[0]) throw new UnprocessableEntityException(say('Контрагент не найден', 'Kontragent topilmadi'));
      // Роль проверяем по строке справочника: приход от клиента и возврат от
      // поставщика — складные записи, по которым не сойдётся ни долг, ни
      // история отгрузок, а на глаз в журнале они не отличаются от верных.
      if (type === 'return_from_client' && !rows[0].is_client) {
        throw new UnprocessableEntityException(say('Возврат от клиента: контрагент не клиент', 'Mijozdan qaytarish: kontragent mijoz emas'));
      }
      if (type === 'receipt' && !rows[0].is_supplier) {
        throw new UnprocessableEntityException(say('Приход: контрагент не поставщик', 'Kirim: kontragent ta’minotchi emas'));
      }
      partnerId = rows[0].id;
    }

    return { fromWarehouseId, fromLocationId, toWarehouseId, toLocationId, partnerId };
  }

  private async warehouseId(tx: Tx, companyId: bigint, code: string): Promise<bigint> {
    const rows = await tx.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM warehouse
       WHERE company_id = ${companyId} AND code = ${code} AND is_active`;
    if (!rows[0]) {
      throw new UnprocessableEntityException(say(`Склад ${code} не найден в этой компании`, `${code} ombori bu kompaniyada topilmadi`));
    }
    return rows[0].id;
  }

  /**
   * Ячейка стороны движения.
   *
   * Обязательна там, где у склада вообще есть ячейки: остаток лежит по ячейкам,
   * и движение без ячейки встало бы отдельной строкой «нигде» — та же дыра, что
   * партия без номера. Склад без ячеек при этом продолжает работать как был:
   * навязывать ячейку там, где полок никто не размечал, значит остановить работу
   * ради формы.
   *
   * Код ячейки уникален внутри зоны, а не внутри склада, поэтому одноимённая
   * ячейка в двух зонах — не ошибка данных. Угадывать за человека, какая из них
   * его, нельзя: в этом случае просим назвать зону явно, `ЗОНА/ЯЧЕЙКА`.
   */
  private async locationId(
    tx: Tx,
    warehouseId: bigint,
    warehouseCode: string,
    raw: string | undefined,
    side: string,
  ): Promise<bigint | null> {
    const cells = await tx.$queryRaw<{ id: bigint; zone_code: string; code: string }[]>`
      SELECT l.id, z.code AS zone_code, l.code
        FROM storage_location l
        JOIN warehouse_zone z ON z.id = l.zone_id
       WHERE z.warehouse_id = ${warehouseId} AND l.is_active
       ORDER BY z.code, l.code`;

    const wanted = raw?.trim();
    if (!wanted) {
      if (cells.length === 0) return null;
      throw new UnprocessableEntityException(say(
        `Укажите ячейку ${side} на складе ${warehouseCode}`, `${warehouseCode} omborida ${side} yacheykasini ko‘rsating`));
    }
    if (cells.length === 0) {
      throw new UnprocessableEntityException(say(`На складе ${warehouseCode} ячеек нет`, `${warehouseCode} omborida yacheykalar yo‘q`));
    }

    // Принимаем и «A-01», и «A/A-01»: первое — то, что выбрали в списке,
    // второе — то, как ячейка подписана на экране остатков.
    const [zonePart, cellPart] = wanted.includes('/')
      ? wanted.split('/').map((x) => x.trim())
      : [null, wanted];
    const hit = cells.filter(
      (c) => c.code === cellPart && (zonePart === null || c.zone_code === zonePart),
    );
    if (hit.length === 0) {
      throw new UnprocessableEntityException(say(
        `Ячейка ${wanted} не найдена на складе ${warehouseCode}`, `${warehouseCode} omborida ${wanted} yacheykasi topilmadi`));
    }
    if (hit.length > 1) {
      throw new UnprocessableEntityException(say(
        `Ячейка ${cellPart} есть в нескольких зонах склада ${warehouseCode}: ` +
          `${hit.map((c) => c.zone_code).join(', ')}. Укажите зону: ЗОНА/ЯЧЕЙКА`, `${cellPart} yacheykasi ${warehouseCode} omborining bir nechta zonasida bor: ` + `${hit.map((c) => c.zone_code).join(', ')}. Zonani ko‘rsating: ZONA/YACHEYKA`));
    }
    return hit[0].id;
  }

  private async resolveItem(tx: Tx, companyId: bigint, code: string): Promise<ItemRow> {
    const rows = await tx.$queryRaw<ItemRow[]>`
      SELECT id, code, name_ru, base_unit_id, track_batches, track_serials
        FROM item WHERE company_id = ${companyId} AND code = ${code} AND is_active`;
    if (!rows[0]) {
      throw new UnprocessableEntityException(say(`Номенклатура ${code} не найдена в этой компании`, `${code} nomenklaturasi bu kompaniyada topilmadi`));
    }
    return rows[0];
  }

  /**
   * Партия движения.
   *
   * Номенклатуре с партионным учётом партия обязательна: без неё остаток
   * встанет отдельной строкой без партии, и прослеживаемость — то, ради чего
   * партии и введены, — перестанет работать молча. На приходе неизвестный номер
   * создаёт партию, на расходе — нет: списывать из партии, которой не было,
   * значит выдумать историю поступления.
   */
  private async resolveBatch(
    tx: Tx,
    companyId: bigint,
    item: ItemRow,
    input: Omit<CreateMoveInput, 'operationType'> & { operationType: InternalMoveKind },
    sides: { fromWarehouseId: bigint | null; partnerId: bigint | null },
  ): Promise<bigint | null> {
    const number = input.batchNumber?.trim();
    if (!item.track_batches) {
      if (number) {
        throw new UnprocessableEntityException(say(
          `Номенклатура ${item.code} учитывается без партий`, `${item.code} nomenklaturasi partiyalarsiz yuritiladi`));
      }
      return null;
    }
    if (!number) {
      throw new UnprocessableEntityException(say(`Для ${item.code} нужен номер партии`, `${item.code} uchun partiya raqami kerak`));
    }

    const found = await tx.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM batch
       WHERE company_id = ${companyId} AND item_id = ${item.id} AND number = ${number}`;
    if (found[0]) return found[0].id;

    // Новую партию заводит только приход. Возврат и излишек — про товар,
    // который уже был: номер партии у них берётся с прежнего прихода, и
    // придуманный на месте номер завёл бы вторую партию того же металла.
    if (sides.fromWarehouseId !== null || input.operationType !== 'receipt') {
      throw new UnprocessableEntityException(say(`Партия ${number} по ${item.code} не найдена`, `${item.code} bo‘yicha ${number} partiyasi topilmadi`));
    }

    const made = await tx.batch.create({
      data: {
        companyId,
        itemId: item.id,
        number,
        supplierId: sides.partnerId,
        unitCost: this.cost(input.unitCost).toFixed(4),
      },
      select: { id: true },
    });
    return made.id;
  }

  /**
   * Серийный номер движения (ТЗ 5.6).
   *
   * Штучный учёт: одно движение — один номер, количество ровно единица.
   * Собирать десять труб в одну строку журнала нельзя: строка несёт один
   * `serial_id`, и «десять штук с номером такой-то» было бы неправдой про
   * девять из них.
   *
   * Новый номер заводит только приход: на расходе номер, которого не было,
   * означает либо опечатку, либо товар, которого склад не принимал.
   */
  private async resolveSerial(
    tx: Tx,
    companyId: bigint,
    item: ItemRow,
    input: Omit<CreateMoveInput, 'operationType'> & { operationType: InternalMoveKind },
    sides: { fromWarehouseId: bigint | null },
    batchId: bigint | null,
    qty: number,
  ): Promise<bigint | null> {
    const number = input.serialNumber?.trim();
    if (!item.track_serials) {
      if (number) {
        throw new UnprocessableEntityException(say(
          `Номенклатура ${item.code} учитывается без серийных номеров`, `${item.code} nomenklaturasi seriya raqamlarisiz yuritiladi`));
      }
      return null;
    }
    if (!number) {
      throw new UnprocessableEntityException(say(`Для ${item.code} нужен серийный номер`, `${item.code} uchun seriya raqami kerak`));
    }
    if (Math.abs(qty - 1) > 1e-9) {
      throw new UnprocessableEntityException(say(
        `Серийный номер — одна штука: количество ${qty} не годится, заведите движение на каждый номер`, `Seriya raqami — bitta dona: ${qty} miqdori to‘g‘ri kelmaydi, har bir raqamga alohida harakat kiriting`));
    }

    const found = await tx.$queryRaw<{ id: bigint; item_id: bigint }[]>`
      SELECT id, item_id FROM serial_number
       WHERE company_id = ${companyId} AND number = ${number}`;

    if (found[0]) {
      // Номер уникален по компании, а не по позиции: одна и та же труба не
      // может числиться и арматурой, и трубой.
      if (found[0].item_id !== item.id) {
        throw new UnprocessableEntityException(say(
          `Серийный номер ${number} закреплён за другой номенклатурой`, `${number} seriya raqami boshqa nomenklaturaga tegishli`));
      }
      if (sides.fromWarehouseId === null) {
        // Приход номера, который уже лежит на складе, завёл бы вторую штуку
        // с тем же номером — дальше по нему не отличить, какую отгрузили.
        const onHand = await tx.$queryRaw<{ qty: string }[]>`
          SELECT COALESCE(SUM(qty_on_hand), 0)::text AS qty
            FROM stock_balance WHERE serial_id = ${found[0].id}`;
        if (Number(onHand[0]?.qty ?? 0) > 0) {
          throw new UnprocessableEntityException(say(`Серийный номер ${number} уже на складе`, `${number} seriya raqami allaqachon omborda`));
        }
      }
      return found[0].id;
    }

    if (sides.fromWarehouseId !== null || input.operationType !== 'receipt') {
      throw new UnprocessableEntityException(say(
        `Серийный номер ${number} по ${item.code} не найден`, `${item.code} bo‘yicha ${number} seriya raqami topilmadi`));
    }

    const made = await tx.serialNumber.create({
      data: { companyId, itemId: item.id, batchId, number },
      select: { id: true },
    });
    return made.id;
  }

  private async resolveReason(
    tx: Tx,
    companyId: bigint,
    input: Omit<CreateMoveInput, 'operationType'> & { operationType: InternalMoveKind },
  ): Promise<bigint | null> {
    const kinds = REASON_KINDS[input.operationType];
    if (!kinds) {
      if (input.reasonId) {
        throw new UnprocessableEntityException(say(
          'Причина указывается только у списания и оприходования излишка', 'Sabab faqat chiqim va ortiqchani kirim qilishda ko‘rsatiladi'));
      }
      return null;
    }
    // Списание без причины — дыра в учёте: товара нет, а почему, не знает никто.
    // Излишек без причины — та же дыра в плюс: товар есть, а откуда, не знает
    // никто. Оба закрываются только основанием, и основания у них разные.
    if (!input.reasonId) {
      throw new UnprocessableEntityException(say(
        input.operationType === 'surplus'
          ? 'Оприходование излишка без причины не принимается'
          : 'Списание без причины не принимается', input.operationType === 'surplus' ? 'Sababsiz ortiqchani kirim qilish qabul qilinmaydi' : 'Sababsiz chiqim qabul qilinmaydi'));
    }
    const rows = await tx.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM stock_reason
       WHERE company_id = ${companyId} AND id = ${BigInt(input.reasonId)}
         AND kind::text = ANY(${kinds})`;
    if (!rows[0]) {
      throw new UnprocessableEntityException(say(
        input.operationType === 'surplus'
          ? 'Причина излишка не найдена: основание — инвентаризация'
          : 'Причина списания не найдена', input.operationType === 'surplus' ? 'Ortiqcha sababi topilmadi: asos — inventarizatsiya' : 'Chiqim sababi topilmadi'));
    }
    return rows[0].id;
  }

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
    if (!id || !allowed.some((a) => a === id)) {
      throw new UnprocessableEntityException(MSG.companyUnavailable());
    }
    return id;
  }

  /**
   * Количество. Верхняя граница не от придирчивости: столбец `decimal(20,6)`,
   * а Number теряет точность на целых выше 2^53 — принять такое число значит
   * записать не то, что прислали.
   */
  private qty(raw: string): number {
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      throw new BadRequestException(MSG.qtyPositive());
    }
    if (value > 1e12) {
      throw new BadRequestException(MSG.qtyTooBig());
    }
    return value;
  }

  private cost(raw: string | undefined): number {
    if (raw === undefined || raw === '') return 0;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      throw new BadRequestException(say('Себестоимость должна быть числом не меньше нуля', 'Tannarx noldan kichik bo‘lmagan son bo‘lishi kerak'));
    }
    return value;
  }
}
