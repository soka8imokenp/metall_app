import { ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { currentContext } from '../common/request-context.js';
import { writeAudit } from '../common/audit.js';
import { lockItem } from './stock.js';
import { applyReservations, reservableQty } from './reservations.js';
import { MSG } from '../common/messages.js';
import { say } from '../common/say.js';

/**
 * Резерв товара под заказ: поставить, снять, показать.
 *
 * Право на постановку и снятие — `warehouse.move`. Резерв обещает товар, и
 * обещание уменьшает доступное на складе ровно так же, как перемещение: тот,
 * кто отвечает за остаток, отвечает и за то, сколько из него обещано. Заказ
 * резерв только обосновывает, поэтому ссылка на строку заказа необязательна —
 * бывает резерв под устную договорённость и под самовывоз.
 *
 * Отдельное право `sales.order.oversell` — на превышение доступного (ТЗ 5.5).
 * Без него пообещать больше, чем свободно, нельзя; с ним можно, и тогда резерв
 * превышает наличие сознательно, под поставку, которая ещё в пути.
 */
const PERMISSION = 'warehouse.move';
const OVERSELL = 'sales.order.oversell';

export type CreateReservationInput = {
  companyUid?: string;
  itemCode: string;
  batchNumber?: string;
  warehouseCode: string;
  qty: string;
  expiresAt?: string;
  salesOrderNumber?: string;
  comment?: string;
};

export type ReservationRow = {
  uid: string;
  companyUid: string;
  item: { code: string; nameRu: string; nameUz: string; unit: string };
  batch: string | null;
  warehouse: { uid: string; code: string; nameRu: string; nameUz: string };
  qty: string;
  expiresAt: string | null;
  createdAt: string;
  author: string | null;
  orderNumber: string | null;
  partner: string | null;
  /** Наличие меньше обещанного: резерв стоит под товар, которого ещё нет. */
  overSold: boolean;
};

@Injectable()
export class ReservationsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Активные резервы. Снятые не показываем: снятый резерв ничего не держит, а
   * список, в котором половина строк ничего не значит, читать невозможно.
   * История снятий остаётся в таблице и достаётся отчётом, когда понадобится.
   */
  async list(params: { warehouseUid?: string; itemCode?: string; limit: number }) {
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.$queryRaw<
        {
          uid: string;
          company_uid: string;
          item_code: string;
          item_name_ru: string;
          item_name_uz: string;
          unit: string;
          batch_number: string | null;
          warehouse_uid: string;
          warehouse_code: string;
          warehouse_name_ru: string;
          warehouse_name_uz: string;
          qty: string;
          expires_at: Date | null;
          created_at: Date;
          author: string | null;
          order_number: string | null;
          partner: string | null;
          on_hand: string;
        }[]
      >`
        SELECT r.uid, co.uid AS company_uid,
               i.code AS item_code, i.name_ru AS item_name_ru, i.name_uz AS item_name_uz,
               u.code AS unit, b.number AS batch_number,
               w.uid AS warehouse_uid, w.code AS warehouse_code,
               w.name_ru AS warehouse_name_ru, w.name_uz AS warehouse_name_uz,
               r.qty::text, r.expires_at, r.created_at,
               au.full_name AS author, so.number AS order_number, app_loc(p.name_ru, p.name_uz) AS partner,
               COALESCE((
                 SELECT SUM(sb.qty_on_hand) FROM stock_balance sb
                  WHERE sb.company_id = r.company_id AND sb.item_id = r.item_id
                    AND sb.batch_id IS NOT DISTINCT FROM r.batch_id
                    AND sb.warehouse_id = r.warehouse_id AND sb.serial_id IS NULL
               ), 0)::text AS on_hand
          FROM stock_reservation r
          JOIN company co ON co.id = r.company_id
          JOIN item i ON i.id = r.item_id
          JOIN unit u ON u.id = i.base_unit_id
          JOIN warehouse w ON w.id = r.warehouse_id
          LEFT JOIN batch b ON b.id = r.batch_id
          LEFT JOIN user_account au ON au.id = r.created_by
          LEFT JOIN sales_order_line sol ON sol.id = r.sales_order_line_id
          LEFT JOIN sales_order so ON so.id = sol.sales_order_id
          LEFT JOIN partner p ON p.id = so.partner_id
         WHERE r.status = 'active'
           AND (r.expires_at IS NULL OR r.expires_at > now())
           AND (${params.warehouseUid}::uuid IS NULL OR w.uid = ${params.warehouseUid}::uuid)
           AND (${params.itemCode ?? null}::text IS NULL OR i.code = ${params.itemCode ?? null}::text)
         ORDER BY r.created_at DESC, r.id DESC
         LIMIT ${params.limit}`;

      const total = await tx.$queryRaw<{ n: string }[]>`
        SELECT count(*)::text AS n FROM stock_reservation r
          JOIN warehouse w ON w.id = r.warehouse_id
          JOIN item i ON i.id = r.item_id
         WHERE r.status = 'active' AND (r.expires_at IS NULL OR r.expires_at > now())
           AND (${params.warehouseUid}::uuid IS NULL OR w.uid = ${params.warehouseUid}::uuid)
           AND (${params.itemCode ?? null}::text IS NULL OR i.code = ${params.itemCode ?? null}::text)`;

      return {
        total: Number(total[0]?.n ?? 0),
        rows: rows.map(
          (r): ReservationRow => ({
            uid: r.uid,
            companyUid: r.company_uid,
            item: {
              code: r.item_code,
              nameRu: r.item_name_ru,
              nameUz: r.item_name_uz,
              unit: r.unit,
            },
            batch: r.batch_number,
            warehouse: {
              uid: r.warehouse_uid,
              code: r.warehouse_code,
              nameRu: r.warehouse_name_ru,
              nameUz: r.warehouse_name_uz,
            },
            qty: Number(r.qty).toFixed(6),
            expiresAt: r.expires_at ? r.expires_at.toISOString() : null,
            createdAt: r.created_at.toISOString(),
            author: r.author,
            orderNumber: r.order_number,
            partner: r.partner,
            overSold: Number(r.qty) > Number(r.on_hand),
          }),
        ),
      };
    });
  }

  async create(input: CreateReservationInput): Promise<{ uid: string }> {
    const ctx = currentContext();
    if (!ctx?.permissions.has(PERMISSION)) {
      throw new ForbiddenException(MSG.noRight(PERMISSION));
    }
    const qty = this.qty(input.qty);

    return this.prisma.withTenant(async (tx) => {
      const companyId = await this.company(tx, input.companyUid, ctx?.companyIds ?? []);
      const item = await this.item(tx, companyId, input.itemCode);
      const warehouseId = await this.warehouse(tx, companyId, input.warehouseCode);

      // Тот же замок, что у движения: без него два резерва прочитают одно и то
      // же свободное количество и оба решат, что товара хватает.
      await lockItem(tx, companyId, item.id);

      const batchId = await this.batch(tx, companyId, item, input.batchNumber);
      const expiresAt = this.expires(input.expiresAt);
      const orderLineId = await this.orderLine(tx, companyId, item.id, input.salesOrderNumber);

      const { free, onHand, reserved } = await reservableQty(
        tx,
        companyId,
        item.id,
        batchId,
        warehouseId,
      );
      if (qty > free && !ctx?.permissions.has(OVERSELL)) {
        throw new UnprocessableEntityException(say(`Свободно только ${free} (на складе ${onHand}, обещано ${reserved}). ` +
            `Резерв сверх свободного требует права «${OVERSELL}»`, `Faqat ${free} erkin (omborda ${onHand}, va’da qilingan ${reserved}). ` + `Erkin qoldiqdan ortiq zaxira «${OVERSELL}» huquqini talab qiladi`));
      }

      const made = await tx.$queryRaw<{ uid: string }[]>`
        INSERT INTO stock_reservation (
          company_id, sales_order_line_id, item_id, batch_id, warehouse_id,
          qty, expires_at, status, created_by, created_at
        ) VALUES (
          ${companyId}, ${orderLineId}, ${item.id}, ${batchId}, ${warehouseId},
          ${qty.toFixed(6)}::numeric, ${expiresAt}, 'active', ${ctx?.userId ?? null}, now()
        )
        RETURNING uid`;

      await applyReservations(tx, companyId, item.id, batchId, warehouseId);

      // Резерв делает товар недоступным для других заказов — это решение, за
      // которое спрашивают, и в журнале действий оно должно быть видно.
      await writeAudit(tx, {
        companyId,
        entityType: 'stock_reservation',
        entityId: made[0]!.uid,
        action: 'create',
        changes: {
          item: { from: null, to: input.itemCode },
          warehouse: { from: null, to: input.warehouseCode },
          qty: { from: null, to: qty },
          free: { from: null, to: free },
          ...(input.salesOrderNumber
            ? { salesOrder: { from: null, to: input.salesOrderNumber } }
            : {}),
          ...(qty > free ? { overSell: { from: null, to: true } } : {}),
        },
      });
      return { uid: made[0]!.uid };
    });
  }

  /**
   * Снятие резерва. Строку не удаляем: снятый резерв — это история обещания,
   * по которой потом объясняют, почему товар месяц лежал недоступным.
   */
  async release(uid: string): Promise<{ uid: string }> {
    const ctx = currentContext();
    if (!ctx?.permissions.has(PERMISSION)) {
      throw new ForbiddenException(MSG.noRight(PERMISSION));
    }

    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.$queryRaw<
        { id: bigint; company_id: bigint; item_id: bigint; batch_id: bigint | null; warehouse_id: bigint; status: string }[]
      >`
        SELECT id, company_id, item_id, batch_id, warehouse_id, status::text AS status
          FROM stock_reservation WHERE uid = ${uid}::uuid`;
      const row = rows[0];
      if (!row) throw new NotFoundException(say('Резерв не найден', 'Zaxira topilmadi'));
      if (row.status !== 'active') {
        throw new UnprocessableEntityException(say('Резерв уже снят', 'Zaxira allaqachon olingan'));
      }

      await lockItem(tx, row.company_id, row.item_id);
      await tx.$executeRaw`
        UPDATE stock_reservation SET status = 'released' WHERE id = ${row.id}`;
      await applyReservations(tx, row.company_id, row.item_id, row.batch_id, row.warehouse_id);

      await writeAudit(tx, {
        companyId: row.company_id,
        entityType: 'stock_reservation',
        entityId: uid,
        action: 'release',
        changes: { status: { from: 'active', to: 'released' } },
      });
      return { uid };
    });
  }

  // --- разбор входа ---------------------------------------------------------

  private qty(raw: string): number {
    const value = Number(String(raw).replace(',', '.'));
    if (!Number.isFinite(value) || value <= 0) {
      throw new UnprocessableEntityException(say('Количество: число больше нуля', 'Miqdor: noldan katta son'));
    }
    return value;
  }

  private expires(raw?: string): Date | null {
    if (!raw) return null;
    const when = new Date(raw);
    if (Number.isNaN(when.getTime())) {
      throw new UnprocessableEntityException(say('Срок резерва: дата в формате ГГГГ-ММ-ДД', 'Zaxira muddati: sana YYYY-MM-DD ko‘rinishida'));
    }
    // Срок задаётся днём, а держать резерв надо весь этот день: до конца суток.
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) when.setUTCHours(23, 59, 59, 0);
    if (when.getTime() <= Date.now()) {
      throw new UnprocessableEntityException(say('Срок резерва уже прошёл', 'Zaxira muddati o‘tib ketgan'));
    }
    return when;
  }

  private async company(tx: Tx, uid: string | undefined, allowed: readonly bigint[]) {
    if (!allowed.length) throw new ForbiddenException(MSG.noCompany());
    if (!uid) return allowed[0]!;
    const rows = await tx.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM company WHERE uid = ${uid}::uuid`;
    const id = rows[0]?.id;
    if (!id || !allowed.some((c) => c === id)) {
      throw new ForbiddenException(MSG.companyUnavailable());
    }
    return id;
  }

  private async item(tx: Tx, companyId: bigint, code: string) {
    const rows = await tx.$queryRaw<{ id: bigint; track_batches: boolean }[]>`
      SELECT id, track_batches FROM item
       WHERE company_id = ${companyId} AND code = ${code} AND is_active`;
    if (!rows[0]) throw new UnprocessableEntityException(MSG.itemNotFound(code));
    return rows[0];
  }

  private async warehouse(tx: Tx, companyId: bigint, code: string) {
    const rows = await tx.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM warehouse
       WHERE company_id = ${companyId} AND code = ${code} AND is_active`;
    if (!rows[0]) throw new UnprocessableEntityException(MSG.warehouseCodeNotFound(code));
    return rows[0].id;
  }

  /**
   * Партию резерв не заводит: обещать можно только то, что уже приняли.
   *
   * По партионной номенклатуре партия обязательна, и это не формальность.
   * Остаток такой позиции весь разложен по партиям, а `qty_reserved` — свёртка
   * резервов того же ключа. Резерв «любой партией» лёг бы в ключ с пустой
   * партией, где остатка нет вовсе: обещание висело бы в таблице, а в остатке
   * не отражалось, и доступное осталось бы прежним. Непартионной позиции,
   * наоборот, партию указывать нечем — там ключ с пустой партией и есть остаток.
   */
  private async batch(
    tx: Tx,
    companyId: bigint,
    item: { id: bigint; track_batches: boolean },
    number?: string,
  ): Promise<bigint | null> {
    if (!number) {
      if (item.track_batches) {
        throw new UnprocessableEntityException(say('Номенклатура ведётся по партиям: укажите партию резерва', 'Nomenklatura partiyalar bo‘yicha yuritiladi: zaxira partiyasini ko‘rsating'));
      }
      return null;
    }
    const rows = await tx.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM batch
       WHERE company_id = ${companyId} AND item_id = ${item.id} AND number = ${number}`;
    if (!rows[0]) throw new UnprocessableEntityException(say(`Партия ${number} не найдена`, `${number} partiyasi topilmadi`));
    return rows[0].id;
  }

  /**
   * Строка заказа под этот же товар. Заказ указывают номером — его человек
   * видит на экране, внутренних id он не знает. Строка ищется по номенклатуре:
   * в заказе их несколько, а резерв стоит под одну.
   */
  private async orderLine(
    tx: Tx,
    companyId: bigint,
    itemId: bigint,
    number?: string,
  ): Promise<bigint | null> {
    if (!number) return null;
    const rows = await tx.$queryRaw<{ id: bigint }[]>`
      SELECT sol.id FROM sales_order_line sol
        JOIN sales_order so ON so.id = sol.sales_order_id
       WHERE so.company_id = ${companyId} AND so.number = ${number} AND sol.item_id = ${itemId}
       ORDER BY sol.id LIMIT 1`;
    if (!rows[0]) {
      throw new UnprocessableEntityException(say(`В заказе ${number} нет строки с этой номенклатурой`, `${number} buyurtmasida bu nomenklatura bo‘yicha qator yo‘q`));
    }
    return rows[0].id;
  }
}
