import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { MSG } from '../common/messages.js';

/**
 * Этапы — это вкладки экрана, а не статус заказа. Статус в модели один
 * (`OrderStatus`), но менеджер смотрит на заказ с трёх сторон сразу: оплачен
 * ли, в производстве ли, уехал ли. Поэтому фильтр отдельный.
 */
export type Stage = 'all' | 'unpaid' | 'paid' | 'production' | 'shipped';

const money = (v: unknown) => Number(v ?? 0).toFixed(4);
const qty = (v: unknown) => Number(v ?? 0).toFixed(6);
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

const STAGE_WHERE: Record<Exclude<Stage, 'all'>, object> = {
  unpaid: { paymentStatus: { in: ['unpaid', 'partial'] as const } },
  paid: { paymentStatus: 'paid' as const },
  production: { status: 'in_production' as const },
  shipped: { status: { in: ['shipped', 'closed'] as const } },
};

@Injectable()
export class OrdersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(stage: Stage, search: string | undefined, limit: number) {
    return this.prisma.withTenant(async (tx) => {
      const term = search?.trim();
      const rows = await tx.salesOrder.findMany({
        where: {
          ...(stage === 'all' ? {} : STAGE_WHERE[stage]),
          ...(term
            ? {
                OR: [
                  { number: { contains: term, mode: 'insensitive' as const } },
                  { partner: { nameRu: { contains: term, mode: 'insensitive' as const } } },
                  { partner: { nameUz: { contains: term, mode: 'insensitive' as const } } },
                ],
              }
            : {}),
        },
        orderBy: [{ orderDate: 'desc' }, { number: 'desc' }],
        take: limit,
        select: {
          uid: true,
          number: true,
          orderDate: true,
          deliveryDate: true,
          paymentDueDate: true,
          amountTotal: true,
          paidAmount: true,
          status: true,
          paymentStatus: true,
          shipmentStatus: true,
          company: { select: { code: true } },
          partner: { select: { nameRu: true, nameUz: true, inn: true } },
          manager: { select: { fullName: true } },
          _count: { select: { lines: true } },
        },
      });

      return rows.map((o) => ({
        uid: o.uid,
        number: o.number,
        orderDate: day(o.orderDate),
        deliveryDate: day(o.deliveryDate),
        paymentDueDate: day(o.paymentDueDate),
        enterprise: o.company.code,
        partnerName: o.partner.nameRu,
        partnerNameUz: o.partner.nameUz,
        partnerInn: o.partner.inn,
        managerName: o.manager?.fullName ?? null,
        amountTotal: money(o.amountTotal),
        paidAmount: money(o.paidAmount),
        status: o.status,
        paymentStatus: o.paymentStatus,
        shipmentStatus: o.shipmentStatus,
        linesCount: o._count.lines,
      }));
    });
  }

  /**
   * Спецификация заказа. Чужая компания сюда не попадает не потому, что
   * проверено в коде, а потому, что политика RLS не отдаст строку: запрос
   * вернёт null, и это 404 — тот же ответ, что и для несуществующего заказа.
   * Разные ответы на «нет» и «не твоё» — это способ пересчитать чужие заказы.
   */
  async one(uid: string) {
    return this.prisma.withTenant(async (tx) => {
      const o = await tx.salesOrder.findFirst({
        where: { uid },
        select: {
          uid: true,
          number: true,
          orderDate: true,
          deliveryDate: true,
          paymentDueDate: true,
          amountNet: true,
          amountVat: true,
          amountTotal: true,
          paidAmount: true,
          status: true,
          paymentStatus: true,
          shipmentStatus: true,
          comment: true,
          company: { select: { uid: true, code: true, nameRu: true, nameUz: true } },
          currency: { select: { code: true } },
          warehouse: { select: { nameRu: true, nameUz: true } },
          manager: { select: { fullName: true } },
          partner: {
            select: {
              uid: true,
              nameRu: true,
              nameUz: true,
              inn: true,
              debtLimit: true,
              paymentDelayDays: true,
            },
          },
          lines: {
            orderBy: { seq: 'asc' },
            select: {
              uid: true,
              seq: true,
              qty: true,
              price: true,
              discountPercent: true,
              vatRate: true,
              amountNet: true,
              amountVat: true,
              amountTotal: true,
              priceSource: true,
              listPrice: true,
              costRef: true,
              priceComment: true,
              item: { select: { code: true, nameRu: true, nameUz: true } },
              unit: { select: { code: true } },
              shipmentLines: { select: { qty: true } },
            },
          },
          shipments: {
            orderBy: { shippedAt: 'desc' },
            select: {
              uid: true,
              number: true,
              shippedAt: true,
              vehicle: true,
              driver: true,
              netWeightT: true,
              grossWeightT: true,
            },
          },
        },
      });

      if (!o) throw new NotFoundException(MSG.orderNotFound());

      return {
        uid: o.uid,
        number: o.number,
        orderDate: day(o.orderDate),
        deliveryDate: day(o.deliveryDate),
        paymentDueDate: day(o.paymentDueDate),
        enterprise: o.company.code,
        // uid компании нужен тому, кто по карточке заказа заводит запись в
        // другой службе: платёж заводится в компании заказа, а не в той,
        // которую человек выберет из своего списка.
        enterpriseUid: o.company.uid,
        enterpriseNameRu: o.company.nameRu,
        enterpriseNameUz: o.company.nameUz,
        currency: o.currency.code,
        warehouseNameRu: o.warehouse?.nameRu ?? null,
        warehouseNameUz: o.warehouse?.nameUz ?? null,
        managerName: o.manager?.fullName ?? null,
        comment: o.comment,
        status: o.status,
        paymentStatus: o.paymentStatus,
        shipmentStatus: o.shipmentStatus,
        amountNet: money(o.amountNet),
        amountVat: money(o.amountVat),
        amountTotal: money(o.amountTotal),
        paidAmount: money(o.paidAmount),
        partner: {
          uid: o.partner.uid,
          nameRu: o.partner.nameRu,
          nameUz: o.partner.nameUz,
          inn: o.partner.inn,
          debtLimit: money(o.partner.debtLimit),
          paymentDelayDays: o.partner.paymentDelayDays,
        },
        lines: o.lines.map((l) => ({
          uid: l.uid,
          seq: l.seq,
          itemCode: l.item.code,
          itemNameRu: l.item.nameRu,
          itemNameUz: l.item.nameUz,
          unit: l.unit.code,
          qty: qty(l.qty),
          // Сколько по этой строке реально уехало: план и факт рядом, чтобы
          // менеджер не сверял спецификацию с журналом ТТН вручную.
          shippedQty: qty(l.shipmentLines.reduce((s, x) => s + Number(x.qty), 0)),
          price: money(l.price),
          discountPercent: Number(l.discountPercent).toFixed(2),
          vatRate: Number(l.vatRate).toFixed(2),
          amountNet: money(l.amountNet),
          amountVat: money(l.amountVat),
          amountTotal: money(l.amountTotal),
          // ТЗ 9.2: откуда цена. Без этого в карточке не отличить цену из
          // прайса от назначенной руками, а спор «почему так дорого/дешево»
          // разбирать нечем.
          priceSource: l.priceSource,
          listPrice: l.listPrice === null ? null : money(l.listPrice),
          costRef: l.costRef === null ? null : money(l.costRef),
          priceComment: l.priceComment,
        })),
        shipments: o.shipments.map((s) => ({
          uid: s.uid,
          number: s.number,
          shippedAt: s.shippedAt.toISOString(),
          vehicle: s.vehicle,
          driver: s.driver,
          netWeightT: s.netWeightT === null ? null : qty(s.netWeightT),
          grossWeightT: s.grossWeightT === null ? null : qty(s.grossWeightT),
        })),
      };
    });
  }

  /** Журнал ТТН. */
  async shipments(limit: number) {
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.shipment.findMany({
        orderBy: { shippedAt: 'desc' },
        take: limit,
        select: {
          uid: true,
          number: true,
          shippedAt: true,
          vehicle: true,
          driver: true,
          netWeightT: true,
          grossWeightT: true,
          company: { select: { code: true } },
          warehouse: { select: { nameRu: true, nameUz: true } },
          salesOrder: {
            select: { uid: true, number: true, partner: { select: { nameRu: true, nameUz: true } } },
          },
          lines: {
            select: { qty: true, item: { select: { nameRu: true, nameUz: true } } },
          },
        },
      });

      return rows.map((s) => ({
        uid: s.uid,
        number: s.number,
        shippedAt: s.shippedAt.toISOString(),
        enterprise: s.company.code,
        warehouseNameRu: s.warehouse?.nameRu ?? null,
        warehouseNameUz: s.warehouse?.nameUz ?? null,
        orderUid: s.salesOrder.uid,
        orderNumber: s.salesOrder.number,
        partnerName: s.salesOrder.partner.nameRu,
        partnerNameUz: s.salesOrder.partner.nameUz,
        vehicle: s.vehicle,
        driver: s.driver,
        netWeightT: s.netWeightT === null ? null : qty(s.netWeightT),
        grossWeightT: s.grossWeightT === null ? null : qty(s.grossWeightT),
        // Груз одной строкой: первая позиция и сколько осталось за ней.
        cargoRu: cargo(s.lines.map((l) => l.item.nameRu), 'ещё'),
        cargoUz: cargo(s.lines.map((l) => l.item.nameUz), 'yana'),
        linesCount: s.lines.length,
      }));
    });
  }
}

function cargo(names: string[], more: string): string {
  if (names.length === 0) return '—';
  if (names.length === 1) return names[0]!;
  return `${names[0]} + ${more} ${names.length - 1}`;
}
