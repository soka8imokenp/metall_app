import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { currentContext } from '../common/request-context.js';
import {
  lockItem,
  pickSourceLocation,
  requireAvailable,
  shiftBalance,
} from '../warehouse/stock.js';
import { issueUnitCost } from '../warehouse/costing.js';
import { consumeReservations } from '../warehouse/reservations.js';
import { lookupPrice } from './pricing.js';
import { writeAudit } from '../common/audit.js';
import { guardInventory } from '../warehouse/inventory.js';
import { MSG } from '../common/messages.js';
import { say } from '../common/say.js';

/**
 * Запись по продажам: заказ, ТТН, смена статуса.
 *
 * Три действия связаны одной цепочкой и потому лежат вместе. Заказ — обещание
 * клиенту, статус — где это обещание сейчас, ТТН — единственное место, где
 * товар действительно уходит со склада. Отгрузка не «отмечает» заказ
 * отгруженным, а двигает остаток теми же правилами, что и склад: те же
 * функции из `warehouse/stock.ts`, та же блокировка, та же проверка доступного.
 * Иначе журнал склада и журнал продаж начали бы рассказывать разное.
 *
 * Движения ТТН помечены `source_doc_type = 'shipment'`, и складской экран их
 * сторнировать не даст — отменяют документ, а не его след.
 */

/** Статусы заказа из схемы. Держим строками: наружу они уезжают как есть. */
export type OrderStatusName =
  | 'draft'
  | 'confirmed'
  | 'reserved'
  | 'in_production'
  | 'picking'
  | 'shipped'
  | 'closed'
  | 'cancelled';

/**
 * Куда заказ можно перевести руками.
 *
 * `shipped` в таблице нет ни у одного статуса: отгруженным заказ делает ТТН, и
 * только она. Разрешить это кнопкой значит позволить сказать «уехало», не
 * тронув склад. `closed` — наоборот, решение человека: заказ закрывают, когда
 * по нему больше нечего ждать.
 */
export const NEXT_STATUS: Record<OrderStatusName, OrderStatusName[]> = {
  draft: ['confirmed', 'cancelled'],
  confirmed: ['reserved', 'in_production', 'picking', 'cancelled'],
  reserved: ['in_production', 'picking', 'cancelled'],
  in_production: ['picking', 'cancelled'],
  picking: ['cancelled'],
  shipped: ['closed'],
  closed: [],
  cancelled: [],
};

/** Статусы, из которых можно отгружать. Черновик и отменённый — нельзя. */
export const SHIPPABLE: OrderStatusName[] = ['confirmed', 'reserved', 'in_production', 'picking'];

/** Что продают: сырьё и полуфабрикат в заказ не ставят. */
const SELLABLE_TYPES = ['goods', 'finished'];

/**
 * Префикс номера по коду компании. Так пронумерованы заказы, которые уже есть
 * в базе, и новый заказ обязан попасть в ту же нумерацию — иначе «последний
 * номер» перестанет быть последним.
 */
const COMPANY_PREFIX: Record<string, string> = { trade: 'ТД', plant: 'ЗВ' };

export type CreateOrderLine = {
  itemCode: string;
  qty: string;
  /** Пусто — цену подставит прайс (ТЗ 9.2). */
  price?: string;
  discountPercent?: string;
  vatRate?: string;
  /** Обязателен, когда цену назвали руками. */
  priceComment?: string;
};

export type CreateOrderInput = {
  companyUid?: string;
  partnerUid: string;
  orderDate?: string;
  deliveryDate?: string;
  paymentDueDate?: string;
  warehouseCode?: string;
  comment?: string;
  lines: CreateOrderLine[];
};

export type CreateShipmentInput = {
  orderUid: string;
  shippedAt?: string;
  warehouseCode?: string;
  vehicle?: string;
  driver?: string;
  netWeightT?: string;
  grossWeightT?: string;
  lines: { lineUid: string; qty: string; batchNumber?: string; serialNumbers?: string[] }[];
};

type OrderBrief = {
  uid: string;
  number: string;
  status: string;
  shipmentStatus: string;
  amountTotal: string;
  linesCount: number;
};

type ShipmentBrief = {
  uid: string;
  number: string;
  orderUid: string;
  orderNumber: string;
  orderStatus: string;
  shipmentStatus: string;
  linesCount: number;
};

type OrderRow = {
  id: bigint;
  uid: string;
  company_id: bigint;
  company_code: string;
  number: string;
  status: OrderStatusName;
  shipment_status: string;
  partner_id: bigint;
  warehouse_id: bigint | null;
  amount_net: string;
  cost_total: string;
};

@Injectable()
export class SalesWriteService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Справочники формы заказа.
   *
   * Каждая строка помечена компанией: покупатель, номенклатура и склад живут
   * внутри компании, а у пользователя их бывает несколько — тогда списки
   * приезжают объединёнными, и названия в них повторяются дословно.
   */
  async refs() {
    return this.prisma.withTenant(async (tx) => {
      const [companies, partners, items, warehouses] = await Promise.all([
        tx.$queryRaw<{ uid: string; code: string; name_ru: string; name_uz: string }[]>`
          SELECT uid, code, name_ru, name_uz FROM company ORDER BY code`,
        tx.$queryRaw<
          {
            company_uid: string;
            uid: string;
            name_ru: string;
            name_uz: string;
            inn: string | null;
            payment_delay_days: number;
          }[]
        >`
          SELECT co.uid AS company_uid, p.uid, p.name_ru, p.name_uz, p.inn,
                 p.payment_delay_days
            FROM partner p
            JOIN company co ON co.id = p.company_id
           WHERE p.is_active AND p.is_client
           ORDER BY co.code, p.name_ru
           LIMIT 500`,
        tx.$queryRaw<
          {
            company_uid: string;
            code: string;
            name_ru: string;
            name_uz: string;
            unit: string;
            track_batches: boolean;
            vat_rate: string;
            last_price: string | null;
          }[]
        >`
          SELECT co.uid AS company_uid, i.code, i.name_ru, i.name_uz,
                 u.code AS unit, i.track_batches, i.vat_rate::text,
                 -- Цена последней продажи: менеджеру не нужно искать её в
                 -- прошлом заказе, а выдумывать цену за него мы не берёмся.
                 (SELECT l.price::text
                    FROM sales_order_line l
                    JOIN sales_order o ON o.id = l.sales_order_id
                   WHERE l.item_id = i.id
                   ORDER BY o.order_date DESC, l.id DESC
                   LIMIT 1) AS last_price
            FROM item i
            JOIN company co ON co.id = i.company_id
            JOIN unit u ON u.id = i.base_unit_id
           WHERE i.is_active AND i.item_type::text = ANY(${SELLABLE_TYPES})
           ORDER BY co.code, i.name_ru`,
        tx.$queryRaw<{ company_uid: string; code: string; name_ru: string; name_uz: string }[]>`
          SELECT co.uid AS company_uid, w.code, w.name_ru, w.name_uz
            FROM warehouse w
            JOIN company co ON co.id = w.company_id
           WHERE w.is_active
           ORDER BY co.code, w.code`,
      ]);

      return {
        companies: companies.map((c) => ({
          uid: c.uid,
          code: c.code,
          nameRu: c.name_ru,
          nameUz: c.name_uz,
        })),
        partners: partners.map((p) => ({
          companyUid: p.company_uid,
          uid: p.uid,
          nameRu: p.name_ru,
          nameUz: p.name_uz,
          inn: p.inn,
          paymentDelayDays: p.payment_delay_days,
        })),
        items: items.map((i) => ({
          companyUid: i.company_uid,
          code: i.code,
          nameRu: i.name_ru,
          nameUz: i.name_uz,
          unit: i.unit,
          trackBatches: i.track_batches,
          vatRate: Number(i.vat_rate).toFixed(2),
          lastPrice: i.last_price === null ? null : Number(i.last_price).toFixed(4),
        })),
        warehouses: warehouses.map((w) => ({
          companyUid: w.company_uid,
          code: w.code,
          nameRu: w.name_ru,
          nameUz: w.name_uz,
        })),
      };
    });
  }

  /**
   * Что по заказу можно отгрузить.
   *
   * Экран ТТН без этого не собрать: в спецификации стоит обещанное количество,
   * а отгружают остатком со склада — и по партионной номенклатуре ещё и
   * конкретной партией. Партии отдаём списком с доступным количеством, чтобы
   * кладовщик выбирал из того, что есть, а не угадывал номер.
   */
  async availability(orderUid: string) {
    return this.prisma.withTenant(async (tx) => {
      const order = await this.orderRow(tx, orderUid);

      const lines = await tx.$queryRaw<
        {
          uid: string;
          seq: number;
          item_id: bigint;
          item_code: string;
          item_name_ru: string;
          item_name_uz: string;
          unit: string;
          track_batches: boolean;
          track_serials: boolean;
          qty: string;
          shipped: string;
          warehouse_id: bigint | null;
          warehouse_code: string | null;
        }[]
      >`
        SELECT l.uid, l.seq, l.item_id, i.code AS item_code,
               i.name_ru AS item_name_ru, i.name_uz AS item_name_uz,
               u.code AS unit, i.track_batches, i.track_serials, l.qty::text,
               coalesce((SELECT sum(sl.qty) FROM shipment_line sl
                          WHERE sl.sales_order_line_id = l.id), 0)::text AS shipped,
               coalesce(l.warehouse_id, ${order.warehouse_id}) AS warehouse_id,
               (SELECT w.code FROM warehouse w
                 WHERE w.id = coalesce(l.warehouse_id, ${order.warehouse_id})) AS warehouse_code
          FROM sales_order_line l
          JOIN item i ON i.id = l.item_id
          JOIN unit u ON u.id = l.unit_id
         WHERE l.sales_order_id = ${order.id}
         ORDER BY l.seq`;

      const out = [];
      for (const l of lines) {
        const batches =
          l.warehouse_id === null
            ? []
            : // Доступное по партии складываем со всех ячеек склада: продажам
              // важно, есть ли товар на складе, а не на какой он полке.
              await tx.$queryRaw<{ number: string | null; available: string }[]>`
                SELECT b.number, sum(sb.qty_available)::text AS available
                  FROM stock_balance sb
                  LEFT JOIN batch b ON b.id = sb.batch_id
                 WHERE sb.company_id = ${order.company_id}
                   AND sb.warehouse_id = ${l.warehouse_id}
                   AND sb.item_id = ${l.item_id}
                   AND sb.serial_id IS NULL
                   AND sb.qty_available > 0
                 GROUP BY b.number
                 ORDER BY b.number NULLS FIRST`;

        // Штучной позиции форма отгрузки показывает не «сколько есть», а
        // какие именно трубы лежат: в накладную идут номера, и выбирают их
        // из этого списка. Полсотни хватает — больше в одну ТТН не грузят.
        const serials =
          l.warehouse_id === null || !l.track_serials
            ? []
            : (
                await tx.$queryRaw<{ number: string }[]>`
                  SELECT sn.number
                    FROM stock_balance sb
                    JOIN serial_number sn ON sn.id = sb.serial_id
                   WHERE sb.company_id = ${order.company_id}
                     AND sb.warehouse_id = ${l.warehouse_id}
                     AND sb.item_id = ${l.item_id}
                     AND sb.qty_available > 0
                   ORDER BY sn.number
                   LIMIT 50`
              ).map((r) => r.number);

        const available = l.track_serials
          ? serials.length
          : batches.reduce((s, b) => s + Number(b.available), 0);
        const remaining = Math.max(0, Number(l.qty) - Number(l.shipped));

        out.push({
          lineUid: l.uid,
          seq: l.seq,
          itemCode: l.item_code,
          itemNameRu: l.item_name_ru,
          itemNameUz: l.item_name_uz,
          unit: l.unit,
          trackBatches: l.track_batches,
          trackSerials: l.track_serials,
          qty: Number(l.qty).toFixed(6),
          shippedQty: Number(l.shipped).toFixed(6),
          remainingQty: remaining.toFixed(6),
          warehouseCode: l.warehouse_code,
          availableQty: available.toFixed(6),
          shortage: Math.max(0, remaining - available).toFixed(6),
          batches: batches.map((b) => ({
            number: b.number,
            availableQty: Number(b.available).toFixed(6),
          })),
          serials,
        });
      }

      return {
        orderUid,
        orderNumber: order.number,
        status: order.status,
        shipmentStatus: order.shipment_status,
        canShip: SHIPPABLE.includes(order.status),
        lines: out,
      };
    });
  }

  /**
   * Новый заказ вместе со спецификацией.
   *
   * Заказ без строк не заводим: пустое обещание клиенту не обещание, а мусор в
   * списке, по которому потом считают выручку. Суммы считает сервер, а не
   * форма: цифры из браузера сюда приходят как пожелание, и доверять им в
   * деньгах нельзя.
   */
  /**
   * Что система предложит за позицию этому клиенту (ТЗ 9.2).
   *
   * Форма заказа спрашивает это до ввода цены и показывает ответ словами:
   * «цена клиента», «прайс оптовый», «цены нет». Считает ту же функцию, что и
   * запись заказа, — иначе подсказка и проверка разошлись бы.
   */
  async priceHint(input: { partnerUid: string; itemCode: string; onDate?: string }) {
    return this.prisma.withTenant(async (tx) => {
      const ids = currentContext()?.companyIds ?? [];
      if (ids.length === 0) throw new UnprocessableEntityException(MSG.noCompany());
      const partner = await tx.$queryRaw<{ id: bigint; company_id: bigint; name: string }[]>`
        SELECT id, company_id, app_loc(name_ru, name_uz) AS name FROM partner
         WHERE uid = ${input.partnerUid}::uuid AND is_client AND company_id = ANY(${ids})`;
      if (!partner[0]) throw new UnprocessableEntityException(MSG.buyerNotFound());
      const item = await this.sellableItem(tx, partner[0].company_id, input.itemCode);
      const onDate = this.date(input.onDate) ?? this.today();
      const look = await lookupPrice(tx, {
        companyId: partner[0].company_id,
        partnerId: partner[0].id,
        itemId: item.id,
        onDate,
      });
      return {
        itemCode: String(input.itemCode).trim(),
        onDate: onDate.toISOString().slice(0, 10),
        ...look,
      };
    });
  }

  async createOrder(input: CreateOrderInput): Promise<OrderBrief> {
    const ctx = currentContext();
    if (!ctx?.permissions.has('sales.edit')) {
      throw new ForbiddenException(MSG.noRight('sales.edit'));
    }
    const userId = ctx.userId ?? null;

    if (!input.lines || input.lines.length === 0) {
      throw new UnprocessableEntityException(say('Заказ без строк не принимается', 'Qatorsiz buyurtma qabul qilinmaydi'));
    }
    if (input.lines.length > 200) {
      throw new UnprocessableEntityException(say('Слишком много строк в заказе: не больше 200', 'Buyurtmada qatorlar juda ko‘p: 200 dan oshmasin'));
    }

    return this.prisma.withTenant(async (tx) => {
      const companyId = await this.resolveCompany(tx, input.companyUid, ctx.companyIds ?? []);

      const partner = await tx.$queryRaw<{ id: bigint; price_type_id: bigint | null }[]>`
        SELECT id, price_type_id FROM partner
         WHERE company_id = ${companyId} AND uid = ${input.partnerUid}::uuid
           AND is_active AND is_client`;
      if (!partner[0]) throw new UnprocessableEntityException(MSG.buyerNotFound());

      const warehouseId = input.warehouseCode
        ? await this.warehouseId(tx, companyId, input.warehouseCode)
        : null;

      const currency = await tx.$queryRaw<{ id: bigint }[]>`
        SELECT id FROM currency WHERE code = 'UZS'`;
      if (!currency[0]) throw new UnprocessableEntityException(MSG.currencyNotFound('UZS'));

      // Тип цен нужен отчёту по марже: он сравнивает факт с прайсом. У
      // покупателя он свой, если назначен, иначе берём первый в компании.
      const priceType =
        partner[0].price_type_id ??
        (
          await tx.$queryRaw<{ id: bigint }[]>`
            SELECT id FROM price_type WHERE company_id = ${companyId} ORDER BY id LIMIT 1`
        )[0]?.id ??
        null;

      const orderDate = this.date(input.orderDate) ?? this.today();
      const deliveryDate = this.date(input.deliveryDate);
      const paymentDueDate = this.date(input.paymentDueDate);
      if (deliveryDate && deliveryDate < orderDate) {
        throw new UnprocessableEntityException(say('Дата поставки раньше даты заказа', 'Yetkazib berish sanasi buyurtma sanasidan oldin'));
      }
      if (paymentDueDate && paymentDueDate < orderDate) {
        throw new UnprocessableEntityException(say('Срок оплаты раньше даты заказа', 'To‘lov muddati buyurtma sanasidan oldin'));
      }

      // Строки считаем до записи: если ошибка в пятой, первые четыре не должны
      // успеть родиться. Транзакция откатила бы их и так, но номер заказа из
      // последовательности уже был бы съеден.
      const lines = [];
      let seq = 1;
      for (const raw of input.lines) {
        const item = await this.sellableItem(tx, companyId, raw.itemCode);
        const qty = this.qty(raw.qty);
        // Штучная позиция продаётся штуками: половины трубы с серийным номером
        // не бывает, а строка заказа на полторы штуки доживёт до склада и
        // встанет там — закрыть её будет нечем.
        if (item.track_serials && Math.abs(qty - Math.round(qty)) > 1e-9) {
          throw new UnprocessableEntityException(say(
            `Позиция ${raw.itemCode} учитывается по серийным номерам: ` +
              `количество только целыми штуками, ${raw.qty} не годится`, `${raw.itemCode} pozitsiyasi seriya raqamlari bilan yuritiladi: ` + `miqdor faqat butun donada, ${raw.qty} to‘g‘ri kelmaydi`));
        }
        // ТЗ 9.2. Цену предлагает система, а не менеджер с чистого листа:
        // индивидуальная цена клиента, иначе прайс по его типу цен. Ручной
        // ввод остаётся, но становится осознанным действием: правом и
        // комментарием.
        const look = await lookupPrice(tx, {
          companyId,
          partnerId: partner[0].id,
          itemId: item.id,
          onDate: orderDate,
        });
        const manual = raw.price !== undefined && String(raw.price).trim() !== '';
        if (!manual && look.price === null) {
          throw new UnprocessableEntityException(say(
            `Позиция ${raw.itemCode}: цены нет ни в прайсе, ни у клиента — ` +
              `укажите цену и основание в комментарии строки`, `${raw.itemCode} pozitsiyasi: narx na narxnomada, na mijozda yo‘q — ` + `narxni ko‘rsatib, asosini qator izohida yozing`));
        }
        const price = manual ? this.money(String(raw.price), 'Цена') : look.price!;
        const comment = String(raw.priceComment ?? '').trim();
        if (manual) {
          // Отличие от прайса — это и есть «ручное изменение цены» из ТЗ 9.2:
          // оно требует права. Если прайса по позиции нет вовсе, менять нечего,
          // но основание назвать всё равно надо — иначе через месяц никто не
          // объяснит, откуда взялась цифра.
          const differs = look.price !== null && Math.abs(price - look.price) > 1e-4;
          if (differs && !ctx.permissions.has('sales.price')) {
            throw new ForbiddenException(say(
              `Позиция ${raw.itemCode}: цена отличается от прайса (${look.price}) — ` +
                `на это нужно право «sales.price»`, `${raw.itemCode} pozitsiyasi: narx narxnomadan farq qiladi (${look.price}) — ` + `buning uchun «sales.price» huquqi kerak`));
          }
          if (!comment) {
            throw new UnprocessableEntityException(say(
              `Позиция ${raw.itemCode}: цена поставлена руками — напишите основание`, `${raw.itemCode} pozitsiyasi: narx qo‘lda qo‘yilgan — asosini yozing`));
          }
        }
        const discount = this.percent(raw.discountPercent, 'Скидка');
        const vatRate =
          raw.vatRate === undefined || raw.vatRate === ''
            ? Number(item.vat_rate)
            : this.percent(raw.vatRate, 'НДС');

        const net = round4(qty * price * (1 - discount / 100));
        const vat = round4((net * vatRate) / 100);

        // ТЗ 9.2: скидка ниже себестоимости либо запрещена, либо требует
        // разрешения — настройка компании. Сравниваем цену после скидки: сама
        // по себе цена может быть выше себестоимости, а со скидкой уйти ниже.
        const unitNet = round4(price * (1 - discount / 100));
        if (look.cost !== null && unitNet < look.cost - 1e-4) {
          const tail = `${unitNet} против себестоимости ${look.cost}`;
          if (look.belowCostMode === 'block') {
            throw new UnprocessableEntityException(say(
              `Позиция ${raw.itemCode}: цена со скидкой ниже себестоимости (${tail}). ` +
                `В настройках компании такая продажа запрещена`, `${raw.itemCode} pozitsiyasi: chegirmali narx tannarxdan past (${tail}). ` + `Kompaniya sozlamalarida bunday sotuv taqiqlangan`));
          }
          if (!ctx.permissions.has('sales.below_cost')) {
            throw new ForbiddenException(say(
              `Позиция ${raw.itemCode}: цена со скидкой ниже себестоимости (${tail}) — ` +
                `на это нужно право «sales.below_cost»`, `${raw.itemCode} pozitsiyasi: chegirmali narx tannarxdan past (${tail}) — ` + `buning uchun «sales.below_cost» huquqi kerak`));
          }
        }

        lines.push({
          seq: seq++,
          itemId: item.id,
          unitId: item.base_unit_id,
          qty,
          price,
          discountPercent: discount,
          vatRate,
          amountNet: net,
          amountVat: vat,
          amountTotal: round4(net + vat),
          warehouseId,
          priceSource: manual ? 'manual' : look.source === 'partner' ? 'partner' : 'list',
          listPrice: look.listPrice,
          costRef: look.cost,
          priceComment: manual ? comment : null,
          itemCode: String(raw.itemCode).trim(),
        });
      }

      const amountNet = round4(lines.reduce((s, l) => s + l.amountNet, 0));
      const amountVat = round4(lines.reduce((s, l) => s + l.amountVat, 0));

      const number = await this.nextOrderNumber(tx, companyId);

      // Клиентом Prisma, а не сырым INSERT: `uid` раздаёт клиент
      // (`@default(uuid(7))`), в таблице значения по умолчанию нет, и сырая
      // вставка упирается в NOT NULL.
      const order = await tx.salesOrder.create({
        data: {
          companyId,
          number,
          partnerId: partner[0].id,
          managerId: userId,
          orderDate,
          deliveryDate,
          paymentDueDate,
          warehouseId,
          priceTypeId: priceType,
          currencyId: currency[0].id,
          amountNet: amountNet.toFixed(4),
          amountVat: amountVat.toFixed(4),
          amountTotal: round4(amountNet + amountVat).toFixed(4),
          comment: input.comment ?? null,
          createdBy: userId,
          lines: {
            create: lines.map((l) => ({
              seq: l.seq,
              itemId: l.itemId,
              unitId: l.unitId,
              qty: l.qty.toFixed(6),
              price: l.price.toFixed(4),
              discountPercent: l.discountPercent.toFixed(4),
              vatRate: l.vatRate.toFixed(4),
              amountNet: l.amountNet.toFixed(4),
              amountVat: l.amountVat.toFixed(4),
              amountTotal: l.amountTotal.toFixed(4),
              warehouseId: l.warehouseId,
              priceSource: l.priceSource as never,
              listPrice: l.listPrice === null ? null : l.listPrice.toFixed(4),
              costRef: l.costRef === null ? null : l.costRef.toFixed(4),
              priceComment: l.priceComment,
            })),
          },
        },
        select: { uid: true },
      });

      // ТЗ 3.4 и 9.2: заведение заказа и каждая цена, поставленная руками,
      // ложатся в журнал. До этого продажи в журнал не писали вовсе: заказ
      // появлялся в базе, а кто его завёл, видно было только по полю «менеджер».
      await writeAudit(tx, {
        companyId,
        entityType: 'sales_order',
        entityId: order.uid,
        action: 'create',
        changes: {
          number: { from: null, to: number },
          lines: { from: null, to: lines.length },
          amountTotal: { from: null, to: round4(amountNet + amountVat) },
        },
      });
      for (const l of lines) {
        if (l.priceSource !== 'manual') continue;
        await writeAudit(tx, {
          companyId,
          entityType: 'sales_order',
          entityId: order.uid,
          action: 'price_override',
          changes: {
            item: { from: null, to: l.itemCode },
            price: { from: l.listPrice, to: l.price },
            comment: { from: null, to: l.priceComment },
          },
        });
      }

      return this.orderBrief(tx, order.uid);
    });
  }

  /**
   * Смена статуса заказа.
   *
   * Переходы перечислены в `NEXT_STATUS`, и это не формальность: «отгружен»
   * ставит только ТТН, а отмена после отгрузки оставила бы товар у клиента при
   * отменённом заказе.
   */
  async setStatus(uid: string, target: OrderStatusName, comment?: string): Promise<OrderBrief> {
    const ctx = currentContext();
    // Отмена — не обычная правка: заказ перестаёт быть обещанием, и в отчётах
    // его больше нет. Поэтому она под отдельным правом.
    const need = target === 'cancelled' ? 'sales.delete' : 'sales.edit';
    if (!ctx?.permissions.has(need)) {
      throw new ForbiddenException(MSG.noRight(need));
    }

    return this.prisma.withTenant(async (tx) => {
      const order = await this.orderRow(tx, uid);

      if (order.status === target) {
        throw new ConflictException(say(`Заказ уже в статусе «${target}»`, `Buyurtma allaqachon «${target}» holatida`));
      }
      const allowed = NEXT_STATUS[order.status];
      if (!allowed.includes(target)) {
        const where = allowed.length === 0 ? 'никуда' : allowed.join(', ');
        const extra =
          target === 'shipped'
            ? '. В «отгружен» заказ переводит ТТН, а не кнопка'
            : `. Из «${order.status}» можно: ${where}`;
        throw new ConflictException(say(`Переход «${order.status}» → «${target}» не разрешён${extra}`, `«${order.status}» → «${target}» o‘tishi ruxsat etilmagan${extra}`));
      }
      if (target === 'cancelled' && order.shipment_status !== 'none') {
        throw new ConflictException(say(
          'По заказу уже есть отгрузка: отменяйте ТТН, а не заказ целиком', 'Buyurtma bo‘yicha yuklash bor: butun buyurtmani emas, yuk xatini bekor qiling'));
      }

      await tx.$executeRaw`
        UPDATE sales_order
           SET status = ${target}::"OrderStatus",
               comment = COALESCE(${comment ?? null}, comment),
               version = version + 1
         WHERE id = ${order.id}`;

      /**
       * Журнал действий (ТЗ 3.4). Раньше переход статуса не писался никуда:
       * на вопрос «кто подтвердил заказ» и «кто его отменил» ответа не было,
       * хотя подтверждение — это обещание клиенту, а отмена его снимает.
       */
      await writeAudit(tx, {
        companyId: order.company_id,
        entityType: 'sales_order',
        entityId: uid,
        action: 'status',
        changes: {
          status: { from: order.status, to: target },
          number: { from: null, to: order.number },
          ...(comment ? { comment: { from: null, to: comment } } : {}),
        },
      });

      return this.orderBrief(tx, uid);
    });
  }

  /**
   * ТТН: товар уходит со склада.
   *
   * Здесь и только здесь заказ превращается в расход. На каждую строку — своё
   * движение `stock_move` с ссылкой на документ, остаток снимается функциями
   * склада, и всё это в одной транзакции с самой накладной: половина
   * отгруженной ТТН хуже, чем ни одной.
   */
  async createShipment(
    input: CreateShipmentInput,
    idempotencyKey?: string,
  ): Promise<ShipmentBrief> {
    const ctx = currentContext();
    if (!ctx?.permissions.has('sales.edit')) {
      throw new ForbiddenException(MSG.noRight('sales.edit'));
    }
    const userId = ctx.userId ?? null;

    if (!input.lines || input.lines.length === 0) {
      throw new UnprocessableEntityException(say('ТТН без строк не принимается', 'Qatorsiz yuk xati qabul qilinmaydi'));
    }

    return this.prisma.withTenant(async (tx) => {
      const order = await this.orderRow(tx, input.orderUid);

      // Повторная отправка формы не должна отгрузить товар дважды. Ключ живёт
      // на первом движении накладной: отдельного столбца под него у самой ТТН
      // нет, а движение и накладная рождаются вместе.
      if (idempotencyKey) {
        const seen = await tx.$queryRaw<{ uid: string }[]>`
          SELECT s.uid
            FROM stock_move m
            JOIN shipment s ON s.id = m.source_doc_id AND m.source_doc_type = 'shipment'
           WHERE m.company_id = ${order.company_id} AND m.idempotency_key = ${idempotencyKey}`;
        if (seen[0]) return this.shipmentBrief(tx, seen[0].uid);
      }

      if (!SHIPPABLE.includes(order.status)) {
        const why =
          order.status === 'draft'
            ? 'сначала подтвердите заказ'
            : `статус «${order.status}» отгрузку не допускает`;
        throw new ConflictException(say(`По заказу ${order.number} отгружать нельзя: ${why}`, `${order.number} buyurtmasi bo‘yicha yuklash mumkin emas: ${why}`));
      }

      const shippedAt = input.shippedAt ? new Date(input.shippedAt) : new Date();
      if (Number.isNaN(shippedAt.getTime())) {
        throw new BadRequestException(say('Дата отгрузки не разобрана', 'Yuklash sanasi o‘qilmadi'));
      }

      const fallbackWarehouseId = input.warehouseCode
        ? await this.warehouseId(tx, order.company_id, input.warehouseCode)
        : order.warehouse_id;

      const number = await this.nextShipmentNumber(tx, order.company_id);
      const shipment = await tx.shipment.create({
        data: {
          companyId: order.company_id,
          salesOrderId: order.id,
          number,
          shippedAt,
          warehouseId: fallbackWarehouseId,
          responsibleId: userId,
          vehicle: input.vehicle?.trim() || null,
          driver: input.driver?.trim() || null,
          netWeightT: this.optionalQty(input.netWeightT),
          grossWeightT: this.optionalQty(input.grossWeightT),
        },
        select: { id: true, uid: true },
      });

      let first = true;
      let costTotal = 0;
      // Один номер в двух строках накладной — две отгрузки одной трубы.
      // Ловим по всей накладной, а не в пределах строки.
      const usedSerials = new Set<string>();

      for (const raw of input.lines) {
        const line = await this.orderLine(tx, order, raw.lineUid);
        const qty = this.qty(raw.qty);

        // Больше обещанного не отгружаем: заказ — это и есть договорённость о
        // количестве. Уже уехавшее учитываем, иначе двумя ТТН можно вывезти
        // двойной объём.
        const remaining = Number(line.qty) - Number(line.shipped);
        if (qty > remaining + 1e-9) {
          throw new UnprocessableEntityException(say(
            `По строке ${line.seq} (${line.item_code}) осталось отгрузить ` +
              `${remaining.toFixed(6)}, просят ${qty}`, `${line.seq}-qator (${line.item_code}) bo‘yicha yuklashga ` + `${remaining.toFixed(6)} qoldi, so‘ralgani ${qty}`));
        }

        const warehouseId = line.warehouse_id ?? fallbackWarehouseId;
        if (warehouseId === null) {
          throw new UnprocessableEntityException(say(
            `Не указан склад отгрузки по строке ${line.seq} (${line.item_code})`, `${line.seq}-qator (${line.item_code}) bo‘yicha yuklash ombori ko‘rsatilmagan`));
        }

        if (raw.serialNumbers?.length && !line.track_serials) {
          throw new UnprocessableEntityException(say(
            `Позиция ${line.item_code} учитывается без серийных номеров`, `${line.item_code} pozitsiyasi seriya raqamlarisiz yuritiladi`));
        }

        // Штучная позиция уезжает не количеством, а поимённо: покупатель
        // получает не «две трубы», а две конкретные трубы с номерами на боку.
        // Поэтому каждая идёт своей строкой накладной и своим движением —
        // одна строка журнала несёт один `serial_id`, и «две штуки этим
        // номером» было бы неправдой про одну из них (ТЗ 5.6).
        if (line.track_serials) {
          const serials = await this.resolveShipmentSerials(
            tx,
            order.company_id,
            warehouseId,
            line,
            raw.serialNumbers,
            qty,
            usedSerials,
          );

          await lockItem(tx, order.company_id, line.item_id);

          for (const serial of serials) {
            const what = `${line.item_code} (номер ${serial.number})`;
            await requireAvailable(
              tx,
              order.company_id,
              warehouseId,
              serial.locationId,
              line.item_id,
              serial.batchId,
              1,
              what,
              serial.id,
            );

            const duringInventory = await guardInventory(
              tx,
              order.company_id,
              warehouseId,
              serial.locationId,
            );

            const unitCost = await issueUnitCost(
              tx,
              order.company_id,
              warehouseId,
              serial.locationId,
              line.item_id,
              serial.batchId,
              serial.id,
            );
            const serialCost = round4(unitCost);
            costTotal += serialCost;

            await shiftBalance(
              tx,
              order.company_id,
              warehouseId,
              serial.locationId,
              line.item_id,
              serial.batchId,
              -1,
              null,
              serial.id,
            );

            await tx.stockMove.create({
              data: {
                companyId: order.company_id,
                movedAt: shippedAt,
                operationType: 'shipment',
                itemId: line.item_id,
                batchId: serial.batchId,
                serialId: serial.id,
                fromWarehouseId: warehouseId,
                fromLocationId: serial.locationId,
                qty: '1.000000',
                unitId: line.base_unit_id,
                qtyBase: '1.000000',
                costTotal: serialCost.toFixed(4),
                sourceDocType: 'shipment',
                sourceDocId: shipment.id,
                partnerId: order.partner_id,
                duringInventory,
                createdBy: userId,
                idempotencyKey: first ? (idempotencyKey ?? null) : null,
              },
              select: { id: true },
            });

            // Состояние номера переписываем в той же транзакции, что и
            // остаток: «на складе» у уехавшей трубы — не задержка обновления,
            // а неправда в её карточке.
            await tx.$executeRaw`
              UPDATE serial_number SET current_state = 'shipped'::"SerialState"
               WHERE id = ${serial.id}`;

            await tx.shipmentLine.create({
              data: {
                shipmentId: shipment.id,
                salesOrderLineId: line.id,
                itemId: line.item_id,
                batchId: serial.batchId,
                serialId: serial.id,
                qty: '1.000000',
                costTotal: serialCost.toFixed(4),
              },
              select: { id: true },
            });

            first = false;
          }

          // Резерв снимаем один раз на строку: он держится на позиции и
          // складе, а не на конкретной трубе.
          await consumeReservations(tx, order.company_id, line.id, warehouseId, qty);
          continue;
        }

        const batchId = await this.resolveBatch(tx, order.company_id, line, raw.batchNumber);

        await lockItem(tx, order.company_id, line.item_id);

        // Ячейку отгрузки выбирает сервер: в ТТН её никто не пишет, а остаток
        // лежит по ячейкам. Правила выбора — в `pickSourceLocation`.
        const what = `${line.item_code}${raw.batchNumber ? ` (партия ${raw.batchNumber})` : ''}`;
        const locationId = await pickSourceLocation(
          tx,
          order.company_id,
          warehouseId,
          line.item_id,
          batchId,
          qty,
          what,
        );

        await requireAvailable(
          tx,
          order.company_id,
          warehouseId,
          locationId,
          line.item_id,
          batchId,
          qty,
          what,
        );

        // Пересчёт по этой полке идёт прямо сейчас — либо отгружать нельзя,
        // либо движение помечается «во время пересчёта» (ТЗ 5.8). Правило
        // одно на склад и продажи, потому и живёт отдельным модулем.
        const duringInventory = await guardInventory(tx, order.company_id, warehouseId, locationId);

        const unitCost = await issueUnitCost(
          tx,
          order.company_id,
          warehouseId,
          locationId,
          line.item_id,
          batchId,
        );
        const lineCost = round4(qty * unitCost);
        costTotal += lineCost;

        await shiftBalance(
          tx,
          order.company_id,
          warehouseId,
          locationId,
          line.item_id,
          batchId,
          -qty,
          null,
        );

        // Отгруженное перестаёт быть обещанным: резерв под эту строку заказа
        // уменьшается ровно на то, что уехало.
        await consumeReservations(tx, order.company_id, line.id, warehouseId, qty);

        await tx.stockMove.create({
          data: {
            companyId: order.company_id,
            movedAt: shippedAt,
            operationType: 'shipment',
            itemId: line.item_id,
            batchId,
            fromWarehouseId: warehouseId,
            fromLocationId: locationId,
            qty: qty.toFixed(6),
            unitId: line.base_unit_id,
            qtyBase: qty.toFixed(6),
            costTotal: lineCost.toFixed(4),
            sourceDocType: 'shipment',
            sourceDocId: shipment.id,
            partnerId: order.partner_id,
            duringInventory,
            createdBy: userId,
            // Ключ на первом движении: он и защищает от второй ТТН.
            idempotencyKey: first ? (idempotencyKey ?? null) : null,
          },
          select: { id: true },
        });

        await tx.shipmentLine.create({
          data: {
            shipmentId: shipment.id,
            salesOrderLineId: line.id,
            itemId: line.item_id,
            batchId,
            qty: qty.toFixed(6),
            costTotal: lineCost.toFixed(4),
          },
          select: { id: true },
        });

        first = false;
      }

      await this.refreshShipmentState(tx, order, costTotal);

      return this.shipmentBrief(tx, shipment.uid);
    });
  }

  /**
   * Состояние заказа после отгрузки.
   *
   * Отгружено ли всё — считаем по журналу ТТН, а не по тому, что прислала
   * форма: строк в заказе может быть больше, чем в этой накладной, и «уехало
   * полностью» знает только сумма по всем накладным.
   *
   * Себестоимость и маржу дописываем здесь же: до отгрузки себестоимость
   * заказа неизвестна — товар мог прийти по разной цене, — а после она
   * известна ровно по тем партиям, которые уехали.
   */
  private async refreshShipmentState(tx: Tx, order: OrderRow, addedCost: number) {
    const rows = await tx.$queryRaw<{ open: number; shipped_any: number }[]>`
      SELECT count(*) FILTER (
               WHERE l.qty > coalesce((SELECT sum(sl.qty) FROM shipment_line sl
                                        WHERE sl.sales_order_line_id = l.id), 0) + 0.000001
             )::int AS open,
             count(*) FILTER (
               WHERE coalesce((SELECT sum(sl.qty) FROM shipment_line sl
                                WHERE sl.sales_order_line_id = l.id), 0) > 0
             )::int AS shipped_any
        FROM sales_order_line l
       WHERE l.sales_order_id = ${order.id}`;

    const open = rows[0]?.open ?? 0;
    const shippedAny = (rows[0]?.shipped_any ?? 0) > 0;
    const shipmentStatus = open === 0 ? 'full' : shippedAny ? 'partial' : 'none';

    // Полная отгрузка закрывает заказ по складу: «отгружен». Частичная значит,
    // что сборка идёт, — это «picking», даже если заказ стоял в производстве:
    // часть уже уехала, и держать его в «производстве» было бы неправдой.
    const status: OrderStatusName = shipmentStatus === 'full' ? 'shipped' : 'picking';

    const cost = round4(Number(order.cost_total) + addedCost);
    const margin = round4(Number(order.amount_net) - cost);

    await tx.$executeRaw`
      UPDATE sales_order
         SET shipment_status = ${shipmentStatus}::"ShipmentStatus",
             status = ${status}::"OrderStatus",
             cost_total = ${cost.toFixed(4)}::numeric,
             margin_total = ${margin.toFixed(4)}::numeric,
             version = version + 1
       WHERE id = ${order.id}`;

    /**
     * Отгрузка — момент, когда товар физически уехал, и в журнале его не было
     * вовсе: сама ТТН лежит в своей таблице, а по заказу не оставалось ни
     * строки о том, кто его отгрузил и когда.
     */
    await writeAudit(tx, {
      companyId: order.company_id,
      entityType: 'sales_order',
      entityId: order.uid,
      action: 'ship',
      changes: {
        number: { from: null, to: order.number },
        shipment_status: { from: order.shipment_status, to: shipmentStatus },
        status: { from: order.status, to: status },
      },
    });
  }

  /**
   * Партия строки отгрузки.
   *
   * По партионной номенклатуре партия обязательна: без неё прослеживаемость —
   * то, ради чего партии и введены, — перестанет работать молча. Новую партию
   * тут не создают: отгружать из партии, которой не было, значит выдумать
   * поступление.
   */
  private async resolveBatch(
    tx: Tx,
    companyId: bigint,
    line: { item_id: bigint; item_code: string; track_batches: boolean; seq: number },
    batchNumber: string | undefined,
  ): Promise<bigint | null> {
    const number = batchNumber?.trim();
    if (!line.track_batches) {
      if (number) {
        throw new UnprocessableEntityException(say(
          `Номенклатура ${line.item_code} учитывается без партий`, `${line.item_code} nomenklaturasi partiyalarsiz yuritiladi`));
      }
      return null;
    }
    if (!number) {
      throw new UnprocessableEntityException(say(
        `По строке ${line.seq} (${line.item_code}) нужен номер партии`, `${line.seq}-qator (${line.item_code}) bo‘yicha partiya raqami kerak`));
    }
    const rows = await tx.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM batch
       WHERE company_id = ${companyId} AND item_id = ${line.item_id} AND number = ${number}`;
    if (!rows[0]) {
      throw new UnprocessableEntityException(say(`Партия ${number} по ${line.item_code} не найдена`, `${line.item_code} bo‘yicha ${number} partiyasi topilmadi`));
    }
    return rows[0].id;
  }

  private async orderRow(tx: Tx, uid: string): Promise<OrderRow> {
    const rows = await tx.$queryRaw<OrderRow[]>`
      SELECT o.id, o.uid, o.company_id, co.code AS company_code, o.number,
             o.status::text AS status, o.shipment_status::text AS shipment_status,
             o.partner_id, o.warehouse_id,
             o.amount_net::text AS amount_net, o.cost_total::text AS cost_total
        FROM sales_order o
        JOIN company co ON co.id = o.company_id
       WHERE o.uid = ${uid}::uuid`;
    // Чужая компания сюда не попадает не потому, что проверено в коде, а
    // потому, что политика RLS не отдаст строку: ответ тот же 404, что и для
    // несуществующего заказа. Разные ответы на «нет» и «не твоё» — способ
    // пересчитать чужие заказы.
    if (!rows[0]) throw new NotFoundException(MSG.orderNotFound());
    return rows[0];
  }

  private async orderLine(tx: Tx, order: OrderRow, lineUid: string) {
    const rows = await tx.$queryRaw<
      {
        id: bigint;
        seq: number;
        item_id: bigint;
        item_code: string;
        base_unit_id: bigint;
        track_batches: boolean;
        track_serials: boolean;
        qty: string;
        shipped: string;
        warehouse_id: bigint | null;
      }[]
    >`
      SELECT l.id, l.seq, l.item_id, i.code AS item_code, i.base_unit_id, i.track_batches,
             i.track_serials, l.qty::text,
             coalesce((SELECT sum(sl.qty) FROM shipment_line sl
                        WHERE sl.sales_order_line_id = l.id), 0)::text AS shipped,
             l.warehouse_id
        FROM sales_order_line l
        JOIN item i ON i.id = l.item_id
       WHERE l.uid = ${lineUid}::uuid AND l.sales_order_id = ${order.id}`;
    if (!rows[0]) {
      throw new UnprocessableEntityException(say(`Строка ${lineUid} не из заказа ${order.number}`, `${lineUid} qatori ${order.number} buyurtmasidan emas`));
    }
    return rows[0];
  }

  /**
   * Номера, которые уезжают этой строкой накладной (ТЗ 5.6).
   *
   * Проверяем до первого движения: строка без номеров или с чужим номером —
   * не мелкая недоработка формы, а накладная, по которой приехавшее не
   * сверить. Номер ищется по компании — он уникален в её пределах, и чужой
   * сюда не попадёт: политика RLS не отдаст строку.
   */
  private async resolveShipmentSerials(
    tx: Tx,
    companyId: bigint,
    warehouseId: bigint,
    line: { seq: number; item_id: bigint; item_code: string },
    numbers: string[] | undefined,
    qty: number,
    seen: Set<string>,
  ) {
    const list = (numbers ?? []).map((n) => n.trim()).filter((n) => n.length > 0);
    if (list.length === 0) {
      throw new UnprocessableEntityException(say(
        `Позиция ${line.item_code} учитывается по серийным номерам: ` +
          `назовите номера труб в строке ${line.seq}`, `${line.item_code} pozitsiyasi seriya raqamlari bilan yuritiladi: ` + `${line.seq}-qatorda quvur raqamlarini ko‘rsating`));
    }
    if (Math.abs(qty - Math.round(qty)) > 1e-9) {
      throw new UnprocessableEntityException(say(
        `Позиция ${line.item_code} отгружается целыми штуками: ${qty} не годится`, `${line.item_code} pozitsiyasi butun donada yuklanadi: ${qty} to‘g‘ri kelmaydi`));
    }
    if (list.length !== Math.round(qty)) {
      throw new UnprocessableEntityException(say(
        `По строке ${line.seq} (${line.item_code}) количество ${qty}, ` +
          `а номеров ${list.length}: каждая труба уезжает своим номером`, `${line.seq}-qator (${line.item_code}) bo‘yicha miqdor ${qty}, ` + `raqamlar esa ${list.length}: har bir quvur o‘z raqami bilan ketadi`));
    }

    const out: { id: bigint; number: string; locationId: bigint | null; batchId: bigint | null }[] =
      [];
    for (const number of list) {
      if (seen.has(number)) {
        throw new UnprocessableEntityException(say(
          `Серийный номер ${number} назван в накладной дважды`, `${number} seriya raqami yuk xatida ikki marta ko‘rsatilgan`));
      }
      seen.add(number);

      const found = await tx.$queryRaw<{ id: bigint; item_id: bigint }[]>`
        SELECT id, item_id FROM serial_number
         WHERE company_id = ${companyId} AND number = ${number}`;
      if (!found[0]) {
        throw new UnprocessableEntityException(say(
          `Серийный номер ${number} по ${line.item_code} не найден`, `${line.item_code} bo‘yicha ${number} seriya raqami topilmadi`));
      }
      if (found[0].item_id !== line.item_id) {
        throw new UnprocessableEntityException(say(
          `Серийный номер ${number} закреплён за другой номенклатурой`, `${number} seriya raqami boshqa nomenklaturaga tegishli`));
      }

      // Строка остатка у номера ровно одна: труба лежит в одной ячейке одного
      // склада. Ячейку поэтому читаем, а не выбираем правилами, как у
      // количественного учёта, — выбирать не из чего.
      const spot = await tx.$queryRaw<{ location_id: bigint | null; batch_id: bigint | null }[]>`
        SELECT location_id, batch_id FROM stock_balance
         WHERE company_id = ${companyId} AND warehouse_id = ${warehouseId}
           AND serial_id = ${found[0].id} AND qty_on_hand > 0`;
      if (!spot[0]) {
        const where = await tx.$queryRaw<{ code: string }[]>`
          SELECT code FROM warehouse WHERE id = ${warehouseId}`;
        throw new UnprocessableEntityException(say(
          `Серийный номер ${number} не лежит на складе ${where[0]?.code ?? warehouseId}: ` +
            `отгружать нечего`, `${number} seriya raqami ${where[0]?.code ?? warehouseId} omborida yo‘q: ` + `yuklashga narsa yo‘q`));
      }

      out.push({
        id: found[0].id,
        number,
        locationId: spot[0].location_id,
        batchId: spot[0].batch_id,
      });
    }
    return out;
  }

  private async sellableItem(tx: Tx, companyId: bigint, code: string) {
    const rows = await tx.$queryRaw<
      {
        id: bigint;
        base_unit_id: bigint;
        vat_rate: string;
        track_batches: boolean;
        track_serials: boolean;
      }[]
    >`
      SELECT id, base_unit_id, vat_rate::text, track_batches, track_serials
        FROM item
       WHERE company_id = ${companyId} AND code = ${code} AND is_active
         AND item_type::text = ANY(${SELLABLE_TYPES})`;
    if (!rows[0]) {
      throw new UnprocessableEntityException(say(`Номенклатура ${code} не продаётся из этой компании`, `${code} nomenklaturasi bu kompaniyadan sotilmaydi`));
    }
    return rows[0];
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
   * Следующий номер в пределах компании и префикса.
   *
   * Консультативная блокировка на пару «компания + префикс»: без неё два
   * одновременных запроса вычислят один и тот же максимум и второй упрётся в
   * уникальный индекс. Блокировка снимается вместе с транзакцией.
   */
  private async nextOrderNumber(tx: Tx, companyId: bigint): Promise<string> {
    const prefix = await this.prefix(tx, companyId);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${companyId}:order:${prefix}`}))`;
    const rows = await tx.$queryRaw<{ next: number }[]>`
      SELECT coalesce(max(substring(number from '[0-9]+$')::int), 0) + 1 AS next
        FROM sales_order
       WHERE company_id = ${companyId} AND number LIKE ${`${prefix}-%`}`;
    return `${prefix}-${String(rows[0].next).padStart(5, '0')}`;
  }

  private async nextShipmentNumber(tx: Tx, companyId: bigint): Promise<string> {
    const prefix = `ТТН-${await this.prefix(tx, companyId)}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${companyId}:shipment:${prefix}`}))`;
    const rows = await tx.$queryRaw<{ next: number }[]>`
      SELECT coalesce(max(substring(number from '[0-9]+$')::int), 0) + 1 AS next
        FROM shipment
       WHERE company_id = ${companyId} AND number LIKE ${`${prefix}-%`}`;
    return `${prefix}-${String(rows[0].next).padStart(5, '0')}`;
  }

  /** Префикс компании. Неизвестный код — не повод падать: берём его сам. */
  private async prefix(tx: Tx, companyId: bigint): Promise<string> {
    const rows = await tx.$queryRaw<{ code: string }[]>`
      SELECT code FROM company WHERE id = ${companyId}`;
    const code = rows[0]?.code ?? '';
    return COMPANY_PREFIX[code] ?? code.toUpperCase().slice(0, 3);
  }

  private async orderBrief(tx: Tx, uid: string): Promise<OrderBrief> {
    const rows = await tx.$queryRaw<
      {
        uid: string;
        number: string;
        status: string;
        shipment_status: string;
        amount_total: string;
        lines: number;
      }[]
    >`
      SELECT o.uid, o.number, o.status::text AS status,
             o.shipment_status::text AS shipment_status, o.amount_total::text,
             (SELECT count(*)::int FROM sales_order_line l WHERE l.sales_order_id = o.id) AS lines
        FROM sales_order o WHERE o.uid = ${uid}::uuid`;
    const r = rows[0]!;
    return {
      uid: r.uid,
      number: r.number,
      status: r.status,
      shipmentStatus: r.shipment_status,
      amountTotal: Number(r.amount_total).toFixed(4),
      linesCount: r.lines,
    };
  }

  private async shipmentBrief(tx: Tx, uid: string): Promise<ShipmentBrief> {
    const rows = await tx.$queryRaw<
      {
        uid: string;
        number: string;
        order_uid: string;
        order_number: string;
        order_status: string;
        shipment_status: string;
        lines: number;
      }[]
    >`
      SELECT s.uid, s.number, o.uid AS order_uid, o.number AS order_number,
             o.status::text AS order_status, o.shipment_status::text AS shipment_status,
             (SELECT count(*)::int FROM shipment_line l WHERE l.shipment_id = s.id) AS lines
        FROM shipment s
        JOIN sales_order o ON o.id = s.sales_order_id
       WHERE s.uid = ${uid}::uuid`;
    const r = rows[0]!;
    return {
      uid: r.uid,
      number: r.number,
      orderUid: r.order_uid,
      orderNumber: r.order_number,
      orderStatus: r.order_status,
      shipmentStatus: r.shipment_status,
      linesCount: r.lines,
    };
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

  /** Дата без времени: столбец `date`, и часовой пояс браузера тут только мешает. */
  private date(raw: string | undefined): Date | null {
    if (!raw) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      throw new BadRequestException(say(`Дата ${raw}: ожидается ГГГГ-ММ-ДД`, `${raw} sanasi: YYYY-MM-DD kutilmoqda`));
    }
    const d = new Date(`${raw}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) throw new BadRequestException(say(`Дата ${raw} не разобрана`, `${raw} sanasi o‘qilmadi`));
    return d;
  }

  private today(): Date {
    return new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  }

  /**
   * Количество. Верхняя граница не от придирчивости: столбец `decimal(20,6)`,
   * а Number теряет точность на целых выше 2^53 — принять такое число значит
   * записать не то, что прислали.
   */
  private qty(raw: string): number {
    const value = Number(String(raw).replace(',', '.'));
    if (!Number.isFinite(value) || value <= 0) {
      throw new BadRequestException(MSG.qtyPositive());
    }
    if (value > 1e12) throw new BadRequestException(MSG.qtyTooBig());
    return value;
  }

  private optionalQty(raw: string | undefined): string | null {
    if (raw === undefined || raw === '') return null;
    return this.qty(raw).toFixed(6);
  }

  private money(raw: string, what: string): number {
    const value = Number(String(raw).replace(',', '.'));
    if (!Number.isFinite(value) || value <= 0) {
      throw new BadRequestException(say(`${what} должна быть числом больше нуля`, `${what} noldan katta son bo‘lishi kerak`));
    }
    if (value > 1e15) throw new BadRequestException(say(`${what} слишком велика`, `${what} juda katta`));
    return value;
  }

  private percent(raw: string | undefined, what: string): number {
    if (raw === undefined || raw === '') return 0;
    const value = Number(String(raw).replace(',', '.'));
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      throw new BadRequestException(say(`${what}: процент от 0 до 100`, `${what}: foiz 0 dan 100 gacha`));
    }
    return value;
  }
}

/** Деньги округляем до копеек столбца: `decimal(20,4)`. */
function round4(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}
