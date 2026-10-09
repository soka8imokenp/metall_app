import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { currentContext } from '../common/request-context.js';
import { writeAudit } from '../common/audit.js';
import { MSG } from '../common/messages.js';
import { say } from '../common/say.js';

/**
 * Справочники на запись (ТЗ 5.2, 5.3, 5.10).
 *
 * До этого этапа номенклатура, склады, зоны, ячейки, причины списания и уровни
 * запаса приходили из сида: завести новую марку стали значило попросить
 * разработчика. Здесь они правятся из интерфейса.
 *
 * Общее правило на всё: **справочник, по которому уже есть движения, не
 * удаляют — его выключают.** Удаление увело бы из истории название, по которому
 * читается прошлое: «списано по причине …» превратилось бы в «списано по
 * причине пусто», а остаток на ячейке — в остаток нигде. Поэтому удаление тут
 * разрешено только тому, что ещё ни разу не участвовало ни в одной операции,
 * и это проверяется, а не обещается.
 *
 * Второе правило: **то, что меняет смысл уже записанного, запрещено.** Смена
 * базовой единицы у позиции с движениями пересчитала бы всю её историю задним
 * числом; выключенный партионный учёт у позиции с партиями оставил бы партии
 * без хозяина. Такие правки сервер отклоняет с объяснением, а не «сохраняет
 * по возможности».
 */
@Injectable()
export class RefsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Компания запроса: правка справочника всегда идёт в одну компанию. */
  private async resolveCompany(tx: Tx, companyUid: string | undefined): Promise<bigint> {
    const ids = currentContext()?.companyIds ?? [];
    if (ids.length === 0) throw new UnprocessableEntityException(MSG.noCompany());

    if (!companyUid) {
      if (ids.length > 1) {
        throw new UnprocessableEntityException(
          MSG.bothCompanies(),
        );
      }
      return ids[0]!;
    }

    const rows = await tx.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM company WHERE uid = ${companyUid}::uuid`;
    const id = rows[0]?.id;
    if (id === undefined || !ids.includes(id)) {
      throw new NotFoundException(MSG.companyNotFound());
    }
    return id;
  }

  private async count(tx: Tx, sql: string, ...params: unknown[]): Promise<number> {
    const rows = await tx.$queryRawUnsafe<{ n: bigint }[]>(sql, ...params);
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * Уровни позиции: критический не выше минимального. Та же проверка стоит
   * ограничением в базе, но ограничение отвечает пятисотой с текстом про
   * `item_levels_sane`, а человеку нужно знать, что именно он перепутал.
   */
  private checkLevels(minQty?: number, criticalQty?: number, current?: { min: number; crit: number }) {
    const min = minQty ?? current?.min ?? 0;
    const crit = criticalQty ?? current?.crit ?? 0;
    if (min > 0 && crit > min) {
      throw new UnprocessableEntityException(say(
        `Критический уровень (${crit}) выше минимального (${min}): позиция провалится ` +
          'в критические, ни разу не побывав «ниже минимума»', `Kritik daraja (${crit}) minimaldan (${min}) yuqori: pozitsiya «minimumdan past» ` + 'bo‘lmay turib to‘g‘ridan-to‘g‘ri kritiklarga tushadi'));
    }
  }

  // --- номенклатура ---------------------------------------------------------

  async items(params: { search?: string; limit?: number; all?: boolean }) {
    const search = params.search?.trim() ?? '';
    const limit = params.limit ?? 100;

    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT i.uid, i.code, i.name_ru, i.name_uz, i.item_type::text AS item_type,
                i.vat_rate, i.track_batches, i.track_serials, i.is_weighted,
                i.min_qty, i.critical_qty, i.barcode, i.is_active, i.version,
                co.uid AS company_uid, co.code AS company_code,
                bu.code AS base_unit, app_loc(g.name_ru, g.name_uz) AS group_name,
                a.pipe_type, a.steel_grade, a.diameter_mm, a.wall_thickness_mm,
                a.length_mm, a.weight_kg_per_unit, a.insulation_type, a.gost,
                (SELECT count(*) FROM stock_move m WHERE m.item_id = i.id) AS moves,
                COALESCE(
                  (SELECT json_agg(json_build_object('unit', u2.code, 'factor', iu.factor)
                                   ORDER BY u2.code)
                     FROM item_unit iu JOIN unit u2 ON u2.id = iu.unit_id
                    WHERE iu.item_id = i.id),
                  '[]'::json) AS units
           FROM item i
           JOIN company co ON co.id = i.company_id
           JOIN unit bu ON bu.id = i.base_unit_id
           LEFT JOIN item_group g ON g.id = i.group_id
           LEFT JOIN item_attribute a ON a.item_id = i.id
          WHERE ($1::boolean OR i.is_active)
            AND ($2::text = '' OR i.code ILIKE '%' || $2::text || '%'
                 OR i.name_ru ILIKE '%' || $2::text || '%'
                 OR a.steel_grade ILIKE '%' || $2::text || '%')
          ORDER BY co.code, i.name_ru
          LIMIT $3`,
        params.all ?? false,
        search,
        limit,
      );
      return { rows: rows.map(itemView) };
    });
  }

  async createItem(input: ItemInput) {
    this.checkLevels(input.minQty, input.criticalQty);
    return this.prisma.withTenant(async (tx) => {
      const companyId = await this.resolveCompany(tx, input.companyUid);
      const unitId = await this.unitIdByCode(tx, input.baseUnit);

      const dup = await this.count(
        tx,
        `SELECT count(*) AS n FROM item WHERE company_id = $1 AND code = $2`,
        companyId,
        input.code.trim(),
      );
      if (dup > 0) {
        throw new ConflictException(say(`Позиция с кодом «${input.code.trim()}» в компании уже есть`, `Kompaniyada «${input.code.trim()}» kodli pozitsiya allaqachon bor`));
      }

      const rows = await tx.$queryRawUnsafe<{ id: bigint; uid: string }[]>(
        // uid генерирует база: у этой таблицы он без умолчания, а значение
        // раньше подставлял клиент Prisma — сырой INSERT остался бы без него.
        `INSERT INTO item (uid, company_id, code, name_ru, name_uz, item_type, base_unit_id,
                           vat_rate, track_batches, track_serials, is_weighted,
                           min_qty, critical_qty, barcode)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::"ItemType", $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING id, uid`,
        companyId,
        input.code.trim(),
        input.nameRu.trim(),
        (input.nameUz ?? input.nameRu).trim(),
        input.itemType,
        unitId,
        input.vatRate ?? 12,
        input.trackBatches ?? false,
        input.trackSerials ?? false,
        input.isWeighted ?? false,
        input.minQty ?? 0,
        input.criticalQty ?? 0,
        input.barcode?.trim() || null,
      );
      const item = rows[0]!;

      await this.writeAttributes(tx, item.id, input);
      await this.writeUnits(tx, item.id, unitId, input.units ?? []);

      // Журнал действий (ТЗ 3.4). Справочники в него не писали: заведение
      // позиции, смена её единицы или уровней — решения, по которым потом
      // разбирают, почему склад считает не то, что ждали.
      await writeAudit(tx, {
        companyId,
        entityType: 'item',
        entityId: item.uid,
        action: 'create',
        changes: {
          code: { from: null, to: input.code.trim() },
          name: { from: null, to: input.nameRu.trim() },
          itemType: { from: null, to: input.itemType },
          baseUnit: { from: null, to: input.baseUnit ?? null },
          trackBatches: { from: null, to: input.trackBatches ?? false },
          trackSerials: { from: null, to: input.trackSerials ?? false },
        },
      });
      return { uid: item.uid, code: input.code.trim() };
    });
  }

  async updateItem(uid: string, input: Partial<ItemInput>) {
    return this.prisma.withTenant(async (tx) => {
      const item = await this.itemByUid(tx, uid);
      const moves = await this.count(
        tx,
        `SELECT count(*) AS n FROM stock_move WHERE item_id = $1`,
        item.id,
      );

      // Код позиции печатается на этикетке и стоит в каждой строке истории.
      // Менять его, когда движения уже есть, значит развести этикетку на полке
      // и ту же позицию в журнале.
      if (input.code !== undefined && input.code.trim() !== item.code) {
        if (moves > 0) {
          throw new UnprocessableEntityException(say(
            `По позиции ${moves} движений: код уже напечатан на этикетках и стоит в истории`, `Pozitsiya bo‘yicha ${moves} harakat bor: kod allaqachon yorliqlarga bosilgan va tarixda turadi`));
        }
        const dup = await this.count(
          tx,
          `SELECT count(*) AS n FROM item WHERE company_id = $1 AND code = $2 AND id <> $3`,
          item.company_id,
          input.code.trim(),
          item.id,
        );
        if (dup > 0) throw new ConflictException(say(`Код «${input.code.trim()}» уже занят`, `«${input.code.trim()}» kodi allaqachon band`));
      }

      this.checkLevels(input.minQty, input.criticalQty, {
        min: Number(item.min_qty),
        crit: Number(item.critical_qty),
      });

      let baseUnitId = item.base_unit_id;
      if (input.baseUnit !== undefined) {
        baseUnitId = await this.unitIdByCode(tx, input.baseUnit);
        if (baseUnitId !== item.base_unit_id && moves > 0) {
          throw new UnprocessableEntityException(say(
            'Базовую единицу нельзя сменить: в истории уже есть количества в прежней, ' +
              'и смена пересчитала бы их задним числом', 'Asosiy birlikni o‘zgartirib bo‘lmaydi: tarixda avvalgi birlikdagi miqdorlar bor, ' + 'o‘zgartirish ularni orqaga qarab qayta hisoblardi'));
        }
      }

      if (input.trackBatches === false && item.track_batches) {
        const batches = await this.count(
          tx,
          `SELECT count(*) AS n FROM batch WHERE item_id = $1`,
          item.id,
        );
        if (batches > 0) {
          throw new UnprocessableEntityException(say(
            `Партионный учёт не выключить: по позиции заведено партий — ${batches}`, `Partiyali hisobni o‘chirib bo‘lmaydi: pozitsiya bo‘yicha partiyalar bor — ${batches}`));
        }
      }

      if (input.trackSerials === false && item.track_serials) {
        const serials = await this.count(
          tx,
          `SELECT count(*) AS n FROM serial_number WHERE item_id = $1`,
          item.id,
        );
        if (serials > 0) {
          throw new UnprocessableEntityException(say(
            `Штучный учёт не выключить: по позиции заведено номеров — ${serials}`, `Donalab hisobni o‘chirib bo‘lmaydi: pozitsiya bo‘yicha raqamlar bor — ${serials}`));
        }
      }

      await tx.$queryRawUnsafe(
        `UPDATE item SET
           code = COALESCE($2, code),
           name_ru = COALESCE($3, name_ru),
           name_uz = COALESCE($4, name_uz),
           item_type = COALESCE($5::"ItemType", item_type),
           base_unit_id = $6,
           vat_rate = COALESCE($7, vat_rate),
           track_batches = COALESCE($8, track_batches),
           track_serials = COALESCE($9, track_serials),
           is_weighted = COALESCE($10, is_weighted),
           min_qty = COALESCE($11, min_qty),
           critical_qty = COALESCE($12, critical_qty),
           barcode = COALESCE($13, barcode),
           is_active = COALESCE($14, is_active),
           version = version + 1
         WHERE id = $1`,
        item.id,
        input.code?.trim() ?? null,
        input.nameRu?.trim() ?? null,
        input.nameUz?.trim() ?? null,
        input.itemType ?? null,
        baseUnitId,
        input.vatRate ?? null,
        input.trackBatches ?? null,
        input.trackSerials ?? null,
        input.isWeighted ?? null,
        input.minQty ?? null,
        input.criticalQty ?? null,
        input.barcode?.trim() ?? null,
        input.isActive ?? null,
      );

      if (hasAttributes(input)) await this.writeAttributes(tx, item.id, input);
      if (input.units) await this.writeUnits(tx, item.id, baseUnitId, input.units);

      // В журнал — только присланные поля: PATCH приходит частичным, и молчание
      // о поле означает «не трогай», а не «очисти».
      await writeAudit(tx, {
        companyId: item.company_id,
        entityType: 'item',
        entityId: uid,
        action: 'update',
        changes: {
          code: { from: item.code, to: input.code?.trim() ?? item.code },
          ...(input.nameRu !== undefined ? { name: { from: null, to: input.nameRu.trim() } } : {}),
          ...(input.baseUnit !== undefined ? { baseUnit: { from: null, to: input.baseUnit } } : {}),
          ...(input.minQty !== undefined
            ? { minQty: { from: Number(item.min_qty), to: input.minQty } }
            : {}),
          ...(input.criticalQty !== undefined
            ? { criticalQty: { from: Number(item.critical_qty), to: input.criticalQty } }
            : {}),
          ...(input.trackBatches !== undefined
            ? { trackBatches: { from: item.track_batches, to: input.trackBatches } }
            : {}),
          ...(input.trackSerials !== undefined
            ? { trackSerials: { from: item.track_serials, to: input.trackSerials } }
            : {}),
          ...(input.isActive !== undefined ? { isActive: { from: null, to: input.isActive } } : {}),
        },
      });

      return { uid, updated: true as const };
    });
  }

  /**
   * Удаление позиции — только пока она ни в чём не участвовала. Всё остальное
   * выключается: `is_active = false` убирает её из подбора, но оставляет в
   * истории под своим именем.
   */
  async deleteItem(uid: string) {
    return this.prisma.withTenant(async (tx) => {
      const item = await this.itemByUid(tx, uid);
      const used = await this.count(
        tx,
        `SELECT (SELECT count(*) FROM stock_move WHERE item_id = $1)
              + (SELECT count(*) FROM stock_balance WHERE item_id = $1)
              + (SELECT count(*) FROM sales_order_line WHERE item_id = $1)
              + (SELECT count(*) FROM batch WHERE item_id = $1) AS n`,
        item.id,
      );
      if (used > 0) {
        throw new ConflictException(say(
          `Позиция участвует в ${used} записях: её можно только выключить, иначе история перестанет читаться`, `Pozitsiya ${used} yozuvda qatnashadi: uni faqat o‘chirib qo‘yish mumkin, aks holda tarix o‘qilmay qoladi`));
      }
      await tx.$queryRawUnsafe(`DELETE FROM item WHERE id = $1`, item.id);
      await writeAudit(tx, {
        companyId: item.company_id,
        entityType: 'item',
        entityId: uid,
        action: 'delete',
        changes: { code: { from: item.code, to: null } },
      });
      return { uid, removed: true as const };
    });
  }

  private async itemByUid(tx: Tx, uid: string) {
    const rows = await tx.$queryRaw<
      {
        id: bigint;
        company_id: bigint;
        code: string;
        base_unit_id: bigint;
        track_batches: boolean;
        track_serials: boolean;
        min_qty: string;
        critical_qty: string;
      }[]
    >`SELECT id, company_id, code, base_unit_id, track_batches, track_serials,
             min_qty, critical_qty
        FROM item WHERE uid = ${uid}::uuid`;
    const row = rows[0];
    if (!row) throw new NotFoundException(MSG.lineNotFound());
    return row;
  }

  private async unitIdByCode(tx: Tx, code: string | undefined): Promise<bigint> {
    if (!code) throw new UnprocessableEntityException(say('Не указана базовая единица', 'Asosiy birlik ko‘rsatilmagan'));
    const rows = await tx.$queryRaw<{ id: bigint }[]>`SELECT id FROM unit WHERE code = ${code}`;
    const id = rows[0]?.id;
    if (id === undefined) throw new UnprocessableEntityException(say(`Единицы «${code}» нет`, `«${code}» birligi yo‘q`));
    return id;
  }

  private async writeAttributes(tx: Tx, itemId: bigint, input: Partial<ItemInput>) {
    await tx.$queryRawUnsafe(
      `INSERT INTO item_attribute (item_id, pipe_type, steel_grade, diameter_mm,
                                   wall_thickness_mm, length_mm, weight_kg_per_unit,
                                   insulation_type, gost)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (item_id) DO UPDATE SET
         pipe_type = EXCLUDED.pipe_type,
         steel_grade = EXCLUDED.steel_grade,
         diameter_mm = EXCLUDED.diameter_mm,
         wall_thickness_mm = EXCLUDED.wall_thickness_mm,
         length_mm = EXCLUDED.length_mm,
         weight_kg_per_unit = EXCLUDED.weight_kg_per_unit,
         insulation_type = EXCLUDED.insulation_type,
         gost = EXCLUDED.gost`,
      itemId,
      input.pipeType?.trim() || null,
      input.steelGrade?.trim() || null,
      input.diameterMm ?? null,
      input.wallThicknessMm ?? null,
      input.lengthMm ?? null,
      input.weightKgPerUnit ?? null,
      input.insulationType?.trim() || null,
      input.gost?.trim() || null,
    );
  }

  /**
   * Коэффициенты пересчёта позиции (ТЗ 5.2): тонна ↔ метр ↔ штука.
   *
   * Базовая единица в списке не хранится: её коэффициент равен единице по
   * определению, и запись «т = 0,98 т» означала бы, что количество зависит от
   * того, как его спросили.
   */
  private async writeUnits(
    tx: Tx,
    itemId: bigint,
    baseUnitId: bigint,
    units: { unit: string; factor: number }[],
  ) {
    const seen = new Set<string>();
    const pairs: { unitId: bigint; factor: number }[] = [];
    for (const u of units) {
      if (seen.has(u.unit)) {
        throw new UnprocessableEntityException(say(`Единица «${u.unit}» указана дважды`, `«${u.unit}» birligi ikki marta ko‘rsatilgan`));
      }
      seen.add(u.unit);
      const unitId = await this.unitIdByCode(tx, u.unit);
      if (unitId === baseUnitId) {
        throw new UnprocessableEntityException(say(
          'Коэффициент базовой единицы задавать нечем: он равен единице', 'Asosiy birlik koeffitsiyentini berish shart emas: u birga teng'));
      }
      if (!(u.factor > 0)) {
        throw new UnprocessableEntityException(say(`Коэффициент «${u.unit}» должен быть больше нуля`, `«${u.unit}» koeffitsiyenti noldan katta bo‘lishi kerak`));
      }
      pairs.push({ unitId, factor: u.factor });
    }

    await tx.$queryRawUnsafe(`DELETE FROM item_unit WHERE item_id = $1`, itemId);
    for (const p of pairs) {
      await tx.$queryRawUnsafe(
        `INSERT INTO item_unit (item_id, unit_id, factor) VALUES ($1, $2, $3)`,
        itemId,
        p.unitId,
        p.factor,
      );
    }
  }
}

export interface ItemInput {
  companyUid?: string;
  code: string;
  nameRu: string;
  nameUz?: string;
  itemType: string;
  baseUnit: string;
  vatRate?: number;
  trackBatches?: boolean;
  trackSerials?: boolean;
  isWeighted?: boolean;
  minQty?: number;
  criticalQty?: number;
  barcode?: string;
  isActive?: boolean;
  pipeType?: string;
  steelGrade?: string;
  diameterMm?: number;
  wallThicknessMm?: number;
  lengthMm?: number;
  weightKgPerUnit?: number;
  insulationType?: string;
  gost?: string;
  units?: { unit: string; factor: number }[];
}

const hasAttributes = (input: Partial<ItemInput>): boolean =>
  [
    input.pipeType,
    input.steelGrade,
    input.diameterMm,
    input.wallThicknessMm,
    input.lengthMm,
    input.weightKgPerUnit,
    input.insulationType,
    input.gost,
  ].some((v) => v !== undefined);

const num = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

const itemView = (r: Record<string, any>) => ({
  uid: r.uid,
  code: r.code,
  nameRu: r.name_ru,
  nameUz: r.name_uz,
  itemType: r.item_type,
  company: { uid: r.company_uid, code: r.company_code },
  baseUnit: r.base_unit,
  group: r.group_name,
  vatRate: num(r.vat_rate),
  trackBatches: r.track_batches,
  trackSerials: r.track_serials,
  isWeighted: r.is_weighted,
  minQty: num(r.min_qty),
  criticalQty: num(r.critical_qty),
  barcode: r.barcode,
  isActive: r.is_active,
  version: Number(r.version),
  /** Сколько движений уже есть: по этому числу экран прячет правку кода. */
  moves: Number(r.moves),
  attributes: {
    pipeType: r.pipe_type,
    steelGrade: r.steel_grade,
    diameterMm: num(r.diameter_mm),
    wallThicknessMm: num(r.wall_thickness_mm),
    lengthMm: num(r.length_mm),
    weightKgPerUnit: num(r.weight_kg_per_unit),
    insulationType: r.insulation_type,
    gost: r.gost,
  },
  units: (r.units as { unit: string; factor: string }[]).map((u) => ({
    unit: u.unit,
    factor: String(u.factor),
  })),
});
