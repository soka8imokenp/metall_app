import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { isUz, say } from '../common/say.js';

export type PlanTab = 'plan' | 'done';

/**
 * Таблица на дашборде «План производства и поставок».
 *
 * Строки двух природ: заказ на производство у завода и строка заказа
 * покупателя у торгового дома. Сводим их в одну форму, но природу не прячем —
 * поле kind, по нему фронт ставит иконку завода или склада.
 */
export interface PlanRow {
  uid: string;
  kind: 'production' | 'supply';
  number: string;
  header: string;
  sectionType: string;
  status: 'done' | 'in_process';
  planQty: string;
  factQty: string;
  unit: string;
  enterprise: string;
  customer: string;
  responsible: string;
  priority: 'standard' | 'urgent';
  dueDate: string | null;
}

const DONE_PRODUCTION = ['produced', 'closed'] as const;
const OPEN_PRODUCTION = ['planned', 'in_progress', 'paused'] as const;

const qty = (v: unknown) => Number(v ?? 0).toFixed(3);

/**
 * Название справочника на языке запроса. Экран сводки получает готовую строку,
 * а не пару: это таблица «план и факт», в ней поля уже склеены.
 */
const pick = (r: { nameRu: string; nameUz: string }) => (isUz() ? r.nameUz || r.nameRu : r.nameRu);

@Injectable()
export class PlanService {
  constructor(private readonly prisma: PrismaService) {}

  async rows(tab: PlanTab, limit: number) {
    return this.prisma.withTenant(async (tx) => {
      const orders = await tx.productionOrder.findMany({
        where: { status: { in: tab === 'done' ? [...DONE_PRODUCTION] : [...OPEN_PRODUCTION] } },
        orderBy: [{ priority: 'desc' }, { dueDate: 'asc' }],
        take: limit,
        select: {
          uid: true,
          number: true,
          qtyPlanned: true,
          qtyProduced: true,
          dueDate: true,
          priority: true,
          status: true,
          item: {
            select: { nameRu: true, nameUz: true, group: { select: { nameRu: true, nameUz: true } } },
          },
          unit: { select: { code: true } },
          company: { select: { code: true } },
          responsible: { select: { fullName: true } },
          salesOrder: { select: { partner: { select: { nameRu: true, nameUz: true } } } },
        },
      });

      // Поставки торгового дома: план — строка заказа, факт — что реально
      // ушло со склада по этой строке. Отгрузки может не быть вовсе.
      const lines = await tx.salesOrderLine.findMany({
        where: {
          salesOrder: {
            status: { in: tab === 'done' ? ['shipped', 'closed'] : ['confirmed', 'reserved', 'picking'] },
          },
        },
        orderBy: { salesOrder: { orderDate: 'desc' } },
        take: limit,
        select: {
          uid: true,
          qty: true,
          item: {
            select: { nameRu: true, nameUz: true, group: { select: { nameRu: true, nameUz: true } } },
          },
          unit: { select: { code: true } },
          shipmentLines: { select: { qty: true } },
          salesOrder: {
            select: {
              number: true,
              deliveryDate: true,
              status: true,
              company: { select: { code: true } },
              partner: { select: { nameRu: true, nameUz: true } },
              manager: { select: { fullName: true } },
            },
          },
        },
      });

      const fromProduction: PlanRow[] = orders.map((o) => ({
        uid: o.uid,
        kind: 'production',
        number: o.number,
        header: pick(o.item),
        sectionType: o.item.group ? pick(o.item.group) : '—',
        status: DONE_PRODUCTION.includes(o.status as never) ? 'done' : 'in_process',
        planQty: qty(o.qtyPlanned),
        factQty: qty(o.qtyProduced),
        unit: o.unit.code,
        enterprise: o.company.code,
        customer: o.salesOrder ? pick(o.salesOrder.partner) : say('Склад', 'Ombor'),
        responsible: o.responsible?.fullName ?? '—',
        priority: o.priority > 0 ? 'urgent' : 'standard',
        dueDate: o.dueDate ? o.dueDate.toISOString().slice(0, 10) : null,
      }));

      const fromSupply: PlanRow[] = lines.map((l) => {
        const shipped = l.shipmentLines.reduce((s, x) => s + Number(x.qty), 0);
        return {
          uid: l.uid,
          kind: 'supply',
          number: l.salesOrder.number,
          header: pick(l.item),
          sectionType: l.item.group ? pick(l.item.group) : '—',
          status: tab === 'done' ? 'done' : 'in_process',
          planQty: qty(l.qty),
          factQty: qty(shipped),
          unit: l.unit.code,
          enterprise: l.salesOrder.company.code,
          customer: pick(l.salesOrder.partner),
          responsible: l.salesOrder.manager?.fullName ?? '—',
          priority: 'standard',
          dueDate: l.salesOrder.deliveryDate
            ? l.salesOrder.deliveryDate.toISOString().slice(0, 10)
            : null,
        };
      });

      return [...fromProduction, ...fromSupply].slice(0, limit);
    });
  }
}
