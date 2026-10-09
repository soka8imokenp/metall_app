import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { currentContext } from '../common/request-context.js';
import { writeAudit } from '../common/audit.js';
import { lockItem, requireAvailable, shiftBalance } from './stock.js';
import { issueUnitCost } from './costing.js';
import { applyReservations } from './reservations.js';
import { MSG } from '../common/messages.js';
import { say } from '../common/say.js';

/**
 * Инвентаризация (ТЗ 5.8): лист пересчёта от создания до утверждения.
 *
 * Лист — это снимок. При создании в строки записывается учётное количество по
 * каждой ячейке и партии, и расхождение считается от него, а не от текущего
 * остатка: пока идут подсчёт и утверждение, остаток живёт своей жизнью, и
 * расхождение «поехало бы» вместе с ним.
 *
 * Права разведены: считать — `warehouse.inventory`, утверждать —
 * `warehouse.inventory.approve`. Утверждение списывает недостачу на компанию;
 * это решение не того, кто стоит у полки, — в недостаче он же и виноват.
 */
const COUNT = 'warehouse.inventory';
const APPROVE = 'warehouse.inventory.approve';

/** Статусы, в которых лист ещё живой: по ним же работает запрет операций. */
const OPEN = ['draft', 'counting', 'review'];

export type CreateSheetInput = {
  companyUid?: string;
  warehouseCode: string;
  zoneCode?: string;
  blockMode?: 'block' | 'mark';
  comment?: string;
};

export type CountInput = { qty: string; comment?: string };

export type SheetRow = {
  uid: string;
  companyUid: string;
  number: string;
  warehouse: { uid: string; code: string; nameRu: string; nameUz: string };
  zone: string | null;
  status: string;
  blockMode: string;
  comment: string | null;
  author: string | null;
  createdAt: string;
  countedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  lines: number;
  counted: number;
  diffLines: number;
  /** Деньги расхождения: недостача минусом, излишек плюсом. */
  diffCost: string;
};

export type SheetLineRow = {
  uid: string;
  seq: number;
  item: { code: string; nameRu: string; nameUz: string; unit: string };
  batch: string | null;
  /** Серийный номер: у штучной позиции строка листа заведена на одну трубу. */
  serial: string | null;
  location: string | null;
  qtyExpected: string;
  qtyCounted: string | null;
  qtyDiff: string | null;
  unitCost: string;
  countedBy: string | null;
  countedAt: string | null;
  comment: string | null;
};

@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService) {}

  /** Листы склада: свежие сверху, утверждённые и отменённые тоже видны. */
  async list(params: { warehouseUid?: string; status?: string; limit: number }) {
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.$queryRaw<
        {
          uid: string;
          company_uid: string;
          number: string;
          warehouse_uid: string;
          warehouse_code: string;
          warehouse_name_ru: string;
          warehouse_name_uz: string;
          zone: string | null;
          status: string;
          block_mode: string;
          comment: string | null;
          author: string | null;
          created_at: Date;
          counted_at: Date | null;
          approver: string | null;
          approved_at: Date | null;
          lines: number;
          counted: number;
          diff_lines: number;
          diff_cost: string;
        }[]
      >`
        SELECT s.uid, co.uid AS company_uid, s.number,
               w.uid AS warehouse_uid, w.code AS warehouse_code,
               w.name_ru AS warehouse_name_ru, w.name_uz AS warehouse_name_uz,
               z.code AS zone, s.status::text AS status, s.block_mode::text AS block_mode,
               s.comment,
               au.full_name AS author, s.created_at, s.counted_at,
               ap.full_name AS approver, s.approved_at,
               (SELECT count(*)::int FROM inventory_sheet_line l WHERE l.sheet_id = s.id) AS lines,
               (SELECT count(*)::int FROM inventory_sheet_line l
                 WHERE l.sheet_id = s.id AND l.qty_counted IS NOT NULL) AS counted,
               (SELECT count(*)::int FROM inventory_sheet_line l
                 WHERE l.sheet_id = s.id AND l.qty_diff <> 0) AS diff_lines,
               (SELECT COALESCE(sum(l.qty_diff * l.unit_cost), 0)::text
                  FROM inventory_sheet_line l WHERE l.sheet_id = s.id) AS diff_cost
          FROM inventory_sheet s
          JOIN company co ON co.id = s.company_id
          JOIN warehouse w ON w.id = s.warehouse_id
          LEFT JOIN warehouse_zone z ON z.id = s.zone_id
          LEFT JOIN user_account au ON au.id = s.created_by
          LEFT JOIN user_account ap ON ap.id = s.approved_by
         WHERE (${params.warehouseUid ?? null}::uuid IS NULL OR w.uid = ${params.warehouseUid ?? null}::uuid)
           AND (${params.status ?? null}::text IS NULL OR s.status::text = ${params.status ?? null}::text)
         ORDER BY s.created_at DESC, s.id DESC
         LIMIT ${params.limit}`;

      const total = await tx.$queryRaw<{ n: string }[]>`
        SELECT count(*)::text AS n FROM inventory_sheet s
          JOIN warehouse w ON w.id = s.warehouse_id
         WHERE (${params.warehouseUid ?? null}::uuid IS NULL OR w.uid = ${params.warehouseUid ?? null}::uuid)
           AND (${params.status ?? null}::text IS NULL OR s.status::text = ${params.status ?? null}::text)`;

      return {
        total: Number(total[0]?.n ?? 0),
        rows: rows.map((r) => this.sheetRow(r)),
      };
    });
  }

  /** Лист со строками: то, с чем человек стоит у полки. */
  async get(uid: string): Promise<SheetRow & { rows: SheetLineRow[] }> {
    return this.prisma.withTenant(async (tx) => {
      const head = await this.head(tx, uid);
      const rows = await tx.$queryRaw<
        {
          uid: string;
          seq: number;
          code: string;
          name_ru: string;
          name_uz: string;
          unit: string;
          batch: string | null;
          location: string | null;
          qty_expected: string;
          qty_counted: string | null;
          qty_diff: string | null;
          unit_cost: string;
          serial: string | null;
          counted_by: string | null;
          counted_at: Date | null;
          comment: string | null;
        }[]
      >`
        SELECT l.uid, l.seq, i.code, i.name_ru, i.name_uz, u.code AS unit,
               b.number AS batch, sn.number AS serial,
               CASE WHEN loc.id IS NULL THEN NULL ELSE z.code || '/' || loc.code END AS location,
               l.qty_expected::text, l.qty_counted::text, l.qty_diff::text, l.unit_cost::text,
               ua.full_name AS counted_by, l.counted_at, l.comment
          FROM inventory_sheet_line l
          JOIN item i ON i.id = l.item_id
          JOIN unit u ON u.id = i.base_unit_id
          LEFT JOIN batch b ON b.id = l.batch_id
          LEFT JOIN serial_number sn ON sn.id = l.serial_id
          LEFT JOIN storage_location loc ON loc.id = l.location_id
          LEFT JOIN warehouse_zone z ON z.id = loc.zone_id
          LEFT JOIN user_account ua ON ua.id = l.counted_by
         WHERE l.sheet_id = ${head.id}
         ORDER BY l.seq`;

      return {
        ...this.sheetRow(head),
        rows: rows.map((r) => ({
          uid: r.uid,
          seq: r.seq,
          item: { code: r.code, nameRu: r.name_ru, nameUz: r.name_uz, unit: r.unit },
          batch: r.batch,
          serial: r.serial,
          location: r.location,
          qtyExpected: r.qty_expected,
          qtyCounted: r.qty_counted,
          qtyDiff: r.qty_diff,
          unitCost: r.unit_cost,
          countedBy: r.counted_by,
          countedAt: r.counted_at?.toISOString() ?? null,
          comment: r.comment,
        })),
      };
    });
  }

  /**
   * Создание листа: снимок остатка по складу или зоне.
   *
   * В лист попадают строки с наличием — пересчитывают то, что лежит. Позицию,
   * которой по учёту нет, а на полке нашли, вносят отдельным листом или
   * приходом: «посчитать» можно только то, что в листе есть, иначе подсчёт
   * превращается в свободный ввод чего угодно.
   */
  async create(input: CreateSheetInput): Promise<SheetRow> {
    const ctx = currentContext();
    if (!ctx?.permissions.has(COUNT)) throw new ForbiddenException(MSG.noRight(COUNT));

    return this.prisma.withTenant(async (tx) => {
      const companyId = await this.company(tx, input.companyUid, ctx?.companyIds ?? []);
      const warehouseId = await this.warehouse(tx, companyId, input.warehouseCode);
      const zoneId = await this.zone(tx, warehouseId, input.zoneCode);

      // Второй открытый лист по тому же месту даёт два разных «правильных»
      // количества, и какой снимок верный — выяснить уже не из чего. В базе на
      // это стоит частичный уникальный индекс, здесь — понятный ответ.
      const busy = await tx.$queryRaw<{ number: string }[]>`
        SELECT number FROM inventory_sheet
         WHERE company_id = ${companyId} AND warehouse_id = ${warehouseId}
           AND status::text IN (${OPEN[0]!}, ${OPEN[1]!}, ${OPEN[2]!})
           AND (zone_id IS NOT DISTINCT FROM ${zoneId} OR zone_id IS NULL OR ${zoneId}::bigint IS NULL)
         LIMIT 1`;
      if (busy[0]) {
        throw new UnprocessableEntityException(say(`По этому складу уже идёт пересчёт: лист ${busy[0].number}`, `Bu ombor bo‘yicha allaqachon qayta hisob ketmoqda: ${busy[0].number} varaqi`));
      }

      const number = await this.nextNumber(tx, companyId);
      const sheet = await tx.inventorySheet.create({
        data: {
          companyId,
          number,
          warehouseId,
          zoneId,
          blockMode: input.blockMode ?? 'mark',
          comment: input.comment ?? null,
          createdBy: ctx?.userId ?? null,
        },
        select: { id: true, uid: true },
      });

      const snapshot = await tx.$queryRaw<
        {
          item_id: bigint;
          batch_id: bigint | null;
          serial_id: bigint | null;
          location_id: bigint | null;
          qty: string;
          unit_cost: string;
        }[]
      >`
        SELECT sb.item_id, sb.batch_id, sb.serial_id, sb.location_id,
               sb.qty_on_hand::text AS qty, sb.unit_cost::text AS unit_cost
          FROM stock_balance sb
          JOIN item i ON i.id = sb.item_id
          LEFT JOIN storage_location l ON l.id = sb.location_id
          LEFT JOIN warehouse_zone z ON z.id = l.zone_id
          LEFT JOIN batch b ON b.id = sb.batch_id
          LEFT JOIN serial_number sn ON sn.id = sb.serial_id
         WHERE sb.company_id = ${companyId} AND sb.warehouse_id = ${warehouseId}
           AND sb.qty_on_hand > 0
           AND (${zoneId}::bigint IS NULL OR z.id = ${zoneId})
         ORDER BY z.code NULLS FIRST, l.code NULLS FIRST, i.code,
                  b.number NULLS FIRST, sn.number NULLS FIRST`;

      if (snapshot.length === 0) {
        throw new UnprocessableEntityException(say('Считать нечего: по этому складу или зоне остатка нет', 'Sanashga narsa yo‘q: bu ombor yoki zonada qoldiq yo‘q'));
      }

      await tx.inventorySheetLine.createMany({
        data: snapshot.map((s, i) => ({
          sheetId: sheet.id,
          seq: i + 1,
          itemId: s.item_id,
          batchId: s.batch_id,
          // Штучная позиция — строка на номер: сложить двенадцать труб в
          // «двенадцать штук» значит не пересчитать их, а поверить на слово.
          serialId: s.serial_id,
          locationId: s.location_id,
          qtyExpected: s.qty,
          unitCost: s.unit_cost,
        })),
      });

      await writeAudit(tx, {
        companyId,
        entityType: 'inventory_sheet',
        entityId: sheet.uid,
        action: 'create',
        changes: {
          number: { from: null, to: number },
          warehouse: { from: null, to: input.warehouseCode },
          ...(input.zoneCode ? { zone: { from: null, to: input.zoneCode } } : {}),
          lines: { from: null, to: snapshot.length },
          blockMode: { from: null, to: input.blockMode ?? 'mark' },
        },
      });

      return this.sheetRow(await this.head(tx, sheet.uid));
    });
  }

  /**
   * Подсчёт строки. Первая же посчитанная строка переводит лист в «считают»:
   * отдельная кнопка «начать» ничего не добавляет, а забыть её можно.
   */
  async count(uid: string, input: CountInput): Promise<SheetLineRow> {
    const ctx = currentContext();
    if (!ctx?.permissions.has(COUNT)) throw new ForbiddenException(MSG.noRight(COUNT));

    const qty = this.qty(input.qty);

    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.$queryRaw<
        {
          id: bigint;
          sheet_id: bigint;
          status: string;
          company_id: bigint;
          sheet_uid: string;
          item_code: string;
          qty_expected: string;
        }[]
      >`
        SELECT l.id, l.sheet_id, s.status::text AS status, s.company_id,
               s.uid AS sheet_uid, i.code AS item_code, l.qty_expected::text AS qty_expected
          FROM inventory_sheet_line l
          JOIN inventory_sheet s ON s.id = l.sheet_id
          JOIN item i ON i.id = l.item_id
         WHERE l.uid = ${uid}::uuid
         FOR UPDATE OF l`;
      const line = rows[0];
      if (!line) throw new NotFoundException(say('Строка листа не найдена', 'Varaq qatori topilmadi'));
      if (line.status !== 'draft' && line.status !== 'counting') {
        throw new UnprocessableEntityException(say(line.status === 'approved'
            ? 'Лист утверждён: пересчитать его строки уже нельзя'
            : `Лист в состоянии «${line.status}»: подсчёт закрыт`, line.status === 'approved' ? 'Varaq tasdiqlangan: uning qatorlarini qayta sanab bo‘lmaydi' : `Varaq «${line.status}» holatida: sanoq yopilgan`));
      }

      await tx.$executeRaw`
        UPDATE inventory_sheet_line
           SET qty_counted = ${qty.toFixed(6)}::numeric,
               counted_by = ${ctx?.userId ?? null},
               counted_at = now(),
               comment = ${input.comment ?? null}
         WHERE id = ${line.id}`;

      if (line.status === 'draft') {
        await tx.$executeRaw`
          UPDATE inventory_sheet SET status = 'counting' WHERE id = ${line.sheet_id}`;
      }

      const made = await this.line(tx, uid);

      // Подсчёт пишем на лист, а не на строку: журнал читают по документу, и
      // сорок записей о сорока полках в нём не ищут. Строка названа внутри.
      await writeAudit(tx, {
        companyId: line.company_id,
        entityType: 'inventory_sheet',
        entityId: line.sheet_uid,
        action: 'count',
        changes: {
          line: { from: null, to: line.item_code },
          qtyExpected: { from: null, to: Number(line.qty_expected) },
          qtyCounted: { from: null, to: qty },
        },
      });
      return made;
    });
  }

  /**
   * Подсчёт закончен — лист уходит на утверждение.
   *
   * Непосчитанные строки не пропускаем: пустая строка и «на полке ноль» — разные
   * вещи, а при утверждении разница между ними стоит списания. Не нашли товар —
   * так и ставят ноль, это осознанное действие.
   */
  async finish(uid: string): Promise<SheetRow> {
    const ctx = currentContext();
    if (!ctx?.permissions.has(COUNT)) throw new ForbiddenException(MSG.noRight(COUNT));

    return this.prisma.withTenant(async (tx) => {
      const head = await this.head(tx, uid);
      if (head.status !== 'counting' && head.status !== 'draft') {
        throw new UnprocessableEntityException(say(`Лист в состоянии «${head.status}»`, `Varaq «${head.status}» holatida`));
      }

      const left = await tx.$queryRaw<{ n: string }[]>`
        SELECT count(*)::text AS n FROM inventory_sheet_line
         WHERE sheet_id = ${head.id} AND qty_counted IS NULL`;
      const n = Number(left[0]?.n ?? 0);
      if (n > 0) {
        throw new UnprocessableEntityException(say(`Не посчитано строк: ${n}. Если товара нет на месте — ставьте ноль`, `Sanalmagan qatorlar: ${n}. Agar tovar joyida bo‘lmasa — nol qo‘ying`));
      }

      await tx.$executeRaw`
        UPDATE inventory_sheet SET status = 'review', counted_at = now() WHERE id = ${head.id}`;
      await writeAudit(tx, {
        companyId: head.company_id,
        entityType: 'inventory_sheet',
        entityId: uid,
        action: 'finish',
        changes: {
          status: { from: head.status, to: 'review' },
          number: { from: null, to: head.number },
        },
      });
      return this.sheetRow(await this.head(tx, uid));
    });
  }

  /**
   * Утверждение: расхождения становятся движениями.
   *
   * Излишек приходуется (`surplus`), недостача списывается (`write_off`) — по
   * той же ячейке и партии, где считали, и той же себестоимостью, что была в
   * снимке. Документ у этих движений — сам лист (`source_doc_type`), поэтому
   * отменить их со складского экрана нельзя: пересчёт отменяют пересчётом, а не
   * сторно одной строки.
   */
  async approve(uid: string): Promise<SheetRow> {
    const ctx = currentContext();
    if (!ctx?.permissions.has(APPROVE)) throw new ForbiddenException(say(`Нет права «${APPROVE}»`, MSG.noRight(APPROVE)));

    return this.prisma.withTenant(async (tx) => {
      const head = await this.head(tx, uid);
      if (head.status !== 'review') {
        throw new UnprocessableEntityException(say(head.status === 'approved'
            ? 'Лист уже утверждён'
            : `Лист в состоянии «${head.status}»: утверждать нечего`, head.status === 'approved' ? 'Varaq allaqachon tasdiqlangan' : `Varaq «${head.status}» holatida: tasdiqlashga narsa yo‘q`));
      }

      const lines = await tx.$queryRaw<
        {
          id: bigint;
          item_id: bigint;
          batch_id: bigint | null;
          serial_id: bigint | null;
          location_id: bigint | null;
          diff: string;
          unit_cost: string;
          base_unit_id: bigint;
          code: string;
        }[]
      >`
        SELECT l.id, l.item_id, l.batch_id, l.serial_id, l.location_id,
               l.qty_diff::text AS diff, l.unit_cost::text AS unit_cost,
               i.base_unit_id, i.code
          FROM inventory_sheet_line l
          JOIN item i ON i.id = l.item_id
         WHERE l.sheet_id = ${head.id} AND l.qty_diff <> 0
         ORDER BY l.seq`;

      for (const line of lines) {
        const diff = Number(line.diff);
        await lockItem(tx, head.company_id, line.item_id);

        // Себестоимость излишка берём из снимка: товар тот же самый, просто
        // учёт его потерял. Назначать ему новую цену значит придумать закупку,
        // которой не было.
        const unitCost =
          diff > 0
            ? Number(line.unit_cost)
            : await issueUnitCost(
                tx,
                head.company_id,
                head.warehouse_id,
                line.location_id,
                line.item_id,
                line.batch_id,
                line.serial_id,
              );

        if (diff < 0) {
          await requireAvailable(
            tx,
            head.company_id,
            head.warehouse_id,
            line.location_id,
            line.item_id,
            line.batch_id,
            -diff,
            line.code,
            line.serial_id,
          );
        }

        await shiftBalance(
          tx,
          head.company_id,
          head.warehouse_id,
          line.location_id,
          line.item_id,
          line.batch_id,
          diff,
          diff > 0 ? unitCost : null,
          line.serial_id,
        );

        // Номер выбыл или нашёлся — состояние переписываем тут же, в той же
        // транзакции, что и остаток: иначе труба числилась бы на складе после
        // того, как пересчёт её не нашёл.
        if (line.serial_id !== null) {
          const state = diff > 0 ? 'in_stock' : 'written_off';
          await tx.$executeRaw`
            UPDATE serial_number SET current_state = ${state}::"SerialState"
             WHERE id = ${line.serial_id}`;
        }

        // Остаток полки изменился — обещанное по ней надо разложить заново,
        // иначе резерв останется висеть на количестве, которого там больше нет.
        await applyReservations(tx, head.company_id, line.item_id, line.batch_id, head.warehouse_id);

        await tx.stockMove.create({
          data: {
            companyId: head.company_id,
            operationType: diff > 0 ? 'surplus' : 'write_off',
            itemId: line.item_id,
            batchId: line.batch_id,
            serialId: line.serial_id,
            fromWarehouseId: diff < 0 ? head.warehouse_id : null,
            fromLocationId: diff < 0 ? line.location_id : null,
            toWarehouseId: diff > 0 ? head.warehouse_id : null,
            toLocationId: diff > 0 ? line.location_id : null,
            qty: Math.abs(diff).toFixed(6),
            unitId: line.base_unit_id,
            qtyBase: Math.abs(diff).toFixed(6),
            costTotal: (Math.abs(diff) * unitCost).toFixed(4),
            sourceDocType: 'inventory_sheet',
            sourceDocId: head.id,
            comment: `Инвентаризация ${head.number}`,
            createdBy: ctx?.userId ?? null,
          },
          select: { id: true },
        });
      }

      await tx.$executeRaw`
        UPDATE inventory_sheet
           SET status = 'approved', approved_by = ${ctx?.userId ?? null}, approved_at = now()
         WHERE id = ${head.id}`;

      // Утверждение — единственное место, где пересчёт двигает остаток и
      // деньги. Сколько строк разошлось, пишем числом: по журналу должно быть
      // видно, что именно утвердили, не открывая сам лист.
      await writeAudit(tx, {
        companyId: head.company_id,
        entityType: 'inventory_sheet',
        entityId: uid,
        action: 'approve',
        changes: {
          status: { from: 'review', to: 'approved' },
          number: { from: null, to: head.number },
          diffLines: { from: null, to: lines.length },
        },
      });

      return this.sheetRow(await this.head(tx, uid));
    });
  }

  /**
   * Отмена листа. Строки остаются: пересчёт был, и то, что его бросили, —
   * тоже факт, который потом спрашивают.
   */
  async cancel(uid: string): Promise<SheetRow> {
    const ctx = currentContext();
    if (!ctx?.permissions.has(COUNT)) throw new ForbiddenException(MSG.noRight(COUNT));

    return this.prisma.withTenant(async (tx) => {
      const head = await this.head(tx, uid);
      if (!OPEN.includes(head.status)) {
        throw new UnprocessableEntityException(say(`Лист в состоянии «${head.status}»: отменять нечего`, `Varaq «${head.status}» holatida: bekor qilishga narsa yo‘q`));
      }
      await tx.$executeRaw`UPDATE inventory_sheet SET status = 'cancelled' WHERE id = ${head.id}`;
      await writeAudit(tx, {
        companyId: head.company_id,
        entityType: 'inventory_sheet',
        entityId: uid,
        action: 'cancel',
        changes: {
          status: { from: head.status, to: 'cancelled' },
          number: { from: null, to: head.number },
        },
      });
      return this.sheetRow(await this.head(tx, uid));
    });
  }

  // -------------------------------------------------------------------------

  private async head(tx: Tx, uid: string) {
    const rows = await tx.$queryRaw<
      {
        id: bigint;
        company_id: bigint;
        warehouse_id: bigint;
        uid: string;
        company_uid: string;
        number: string;
        warehouse_uid: string;
        warehouse_code: string;
        warehouse_name_ru: string;
        warehouse_name_uz: string;
        zone: string | null;
        status: string;
        block_mode: string;
        comment: string | null;
        author: string | null;
        created_at: Date;
        counted_at: Date | null;
        approver: string | null;
        approved_at: Date | null;
        lines: number;
        counted: number;
        diff_lines: number;
        diff_cost: string;
      }[]
    >`
      SELECT s.id, s.company_id, s.warehouse_id, s.uid, co.uid AS company_uid, s.number,
             w.uid AS warehouse_uid, w.code AS warehouse_code,
             w.name_ru AS warehouse_name_ru, w.name_uz AS warehouse_name_uz,
             z.code AS zone, s.status::text AS status, s.block_mode::text AS block_mode,
             s.comment, au.full_name AS author, s.created_at, s.counted_at,
             ap.full_name AS approver, s.approved_at,
             (SELECT count(*)::int FROM inventory_sheet_line l WHERE l.sheet_id = s.id) AS lines,
             (SELECT count(*)::int FROM inventory_sheet_line l
               WHERE l.sheet_id = s.id AND l.qty_counted IS NOT NULL) AS counted,
             (SELECT count(*)::int FROM inventory_sheet_line l
               WHERE l.sheet_id = s.id AND l.qty_diff <> 0) AS diff_lines,
             (SELECT COALESCE(sum(l.qty_diff * l.unit_cost), 0)::text
                FROM inventory_sheet_line l WHERE l.sheet_id = s.id) AS diff_cost
        FROM inventory_sheet s
        JOIN company co ON co.id = s.company_id
        JOIN warehouse w ON w.id = s.warehouse_id
        LEFT JOIN warehouse_zone z ON z.id = s.zone_id
        LEFT JOIN user_account au ON au.id = s.created_by
        LEFT JOIN user_account ap ON ap.id = s.approved_by
       WHERE s.uid = ${uid}::uuid`;
    const row = rows[0];
    if (!row) throw new NotFoundException(say('Лист инвентаризации не найден', 'Inventarizatsiya varaqi topilmadi'));
    return row;
  }

  private sheetRow(r: {
    uid: string;
    company_uid: string;
    number: string;
    warehouse_uid: string;
    warehouse_code: string;
    warehouse_name_ru: string;
    warehouse_name_uz: string;
    zone: string | null;
    status: string;
    block_mode: string;
    comment: string | null;
    author: string | null;
    created_at: Date;
    counted_at: Date | null;
    approver: string | null;
    approved_at: Date | null;
    lines: number;
    counted: number;
    diff_lines: number;
    diff_cost: string;
  }): SheetRow {
    return {
      uid: r.uid,
      companyUid: r.company_uid,
      number: r.number,
      warehouse: {
        uid: r.warehouse_uid,
        code: r.warehouse_code,
        nameRu: r.warehouse_name_ru,
        nameUz: r.warehouse_name_uz,
      },
      zone: r.zone,
      status: r.status,
      blockMode: r.block_mode,
      comment: r.comment,
      author: r.author,
      createdAt: r.created_at.toISOString(),
      countedAt: r.counted_at?.toISOString() ?? null,
      approvedBy: r.approver,
      approvedAt: r.approved_at?.toISOString() ?? null,
      lines: r.lines,
      counted: r.counted,
      diffLines: r.diff_lines,
      diffCost: r.diff_cost,
    };
  }

  private async line(tx: Tx, uid: string): Promise<SheetLineRow> {
    const rows = await tx.$queryRaw<
      {
        uid: string;
        seq: number;
        code: string;
        name_ru: string;
        name_uz: string;
        unit: string;
        batch: string | null;
        location: string | null;
        qty_expected: string;
        qty_counted: string | null;
        qty_diff: string | null;
        unit_cost: string;
        serial: string | null;
        counted_by: string | null;
        counted_at: Date | null;
        comment: string | null;
      }[]
    >`
      SELECT l.uid, l.seq, i.code, i.name_ru, i.name_uz, u.code AS unit,
             b.number AS batch, sn.number AS serial,
             CASE WHEN loc.id IS NULL THEN NULL ELSE z.code || '/' || loc.code END AS location,
             l.qty_expected::text, l.qty_counted::text, l.qty_diff::text, l.unit_cost::text,
             ua.full_name AS counted_by, l.counted_at, l.comment
        FROM inventory_sheet_line l
        JOIN item i ON i.id = l.item_id
        JOIN unit u ON u.id = i.base_unit_id
        LEFT JOIN batch b ON b.id = l.batch_id
        LEFT JOIN serial_number sn ON sn.id = l.serial_id
        LEFT JOIN storage_location loc ON loc.id = l.location_id
        LEFT JOIN warehouse_zone z ON z.id = loc.zone_id
        LEFT JOIN user_account ua ON ua.id = l.counted_by
       WHERE l.uid = ${uid}::uuid`;
    const r = rows[0]!;
    return {
      uid: r.uid,
      seq: r.seq,
      item: { code: r.code, nameRu: r.name_ru, nameUz: r.name_uz, unit: r.unit },
      batch: r.batch,
      serial: r.serial,
      location: r.location,
      qtyExpected: r.qty_expected,
      qtyCounted: r.qty_counted,
      qtyDiff: r.qty_diff,
      unitCost: r.unit_cost,
      countedBy: r.counted_by,
      countedAt: r.counted_at?.toISOString() ?? null,
      comment: r.comment,
    };
  }

  /** Номер листа в пределах компании; блокировка — как у финансовых операций. */
  private async nextNumber(tx: Tx, companyId: bigint): Promise<string> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${companyId}:ИНВ`}))`;
    const rows = await tx.$queryRaw<{ next: number }[]>`
      SELECT coalesce(max(substring(number from '[0-9]+$')::int), 0) + 1 AS next
        FROM inventory_sheet
       WHERE company_id = ${companyId} AND number LIKE 'ИНВ-%'`;
    return `ИНВ-${String(rows[0]!.next).padStart(5, '0')}`;
  }

  /** Посчитать можно ноль: «на полке пусто» — такой же результат подсчёта. */
  private qty(raw: string): number {
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      throw new UnprocessableEntityException(say('Количество: число не меньше нуля', 'Miqdor: noldan kichik bo‘lmagan son'));
    }
    return value;
  }

  private async company(tx: Tx, uid: string | undefined, allowed: readonly bigint[]) {
    if (!allowed.length) throw new ForbiddenException(MSG.noCompany());
    if (!uid) return allowed[0]!;
    const rows = await tx.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM company WHERE uid = ${uid}::uuid`;
    const id = rows[0]?.id;
    if (!id || !allowed.some((c) => c === id)) throw new ForbiddenException(MSG.companyUnavailable());
    return id;
  }

  private async warehouse(tx: Tx, companyId: bigint, code: string) {
    const rows = await tx.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM warehouse
       WHERE company_id = ${companyId} AND code = ${code} AND is_active`;
    if (!rows[0]) throw new UnprocessableEntityException(MSG.warehouseCodeNotFound(code));
    return rows[0].id;
  }

  private async zone(tx: Tx, warehouseId: bigint, code?: string): Promise<bigint | null> {
    if (!code) return null;
    const rows = await tx.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM warehouse_zone WHERE warehouse_id = ${warehouseId} AND code = ${code}`;
    if (!rows[0]) throw new UnprocessableEntityException(say(`Зона ${code} на этом складе не найдена`, `Bu omborda ${code} zonasi topilmadi`));
    return rows[0].id;
  }
}
