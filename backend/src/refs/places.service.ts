import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { writeAudit } from '../common/audit.js';
import { currentContext } from '../common/request-context.js';
import { MSG } from '../common/messages.js';
import { say } from '../common/say.js';

/** Строка настроек компании как её отдаёт база. */
interface SettingsRow {
  uid: string;
  code: string;
  name: string;
  method: string;
  below: string;
  single: string | null;
  period: string | null;
  days: number;
}

/**
 * Настройки одной компании наружу.
 *
 * Суммы приходят из базы текстом (`numeric::text`) и наружу уходят числом:
 * экран показывает их в полях ввода и считать их там нечем. Пустой порог
 * остаётся `null`, а не превращается в нуль — нуль значил бы «порог ноль, всё
 * крупное», ровно наоборот.
 */
const asSettings = (r: SettingsRow) => ({
  companyUid: r.uid,
  companyCode: r.code,
  companyName: r.name,
  costingMethod: r.method,
  belowCostMode: r.below,
  approvalLimitSingle: r.single === null ? null : Number(r.single),
  approvalLimitPeriod: r.period === null ? null : Number(r.period),
  approvalPeriodDays: r.days,
});

/**
 * Места хранения, причины списания и уровни запаса на запись
 * (ТЗ 5.3, 5.7, 5.10).
 *
 * Здесь то же правило, что и в номенклатуре: удаляем только нетронутое,
 * остальное выключаем. Разница в том, что у места хранения «нетронутое»
 * означает ещё и «пустое»: склад с остатком нельзя ни удалить, ни выключить —
 * товар с выключенного склада исчез бы из подбора, оставшись в отчёте, и
 * сошлось бы это только на бумаге.
 */
@Injectable()
export class PlacesService {
  constructor(private readonly prisma: PrismaService) {}

  private async resolveCompany(tx: Tx, companyUid?: string): Promise<bigint> {
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
    if (id === undefined || !ids.includes(id)) throw new NotFoundException(MSG.companyNotFound());
    return id;
  }

  private async count(tx: Tx, sql: string, ...p: unknown[]): Promise<number> {
    const rows = await tx.$queryRawUnsafe<{ n: bigint }[]>(sql, ...p);
    return Number(rows[0]?.n ?? 0);
  }

  // --- настройки учёта компании (ТЗ 5.7) ------------------------------------

  /**
   * Метод списания по каждой видимой компании.
   *
   * Списком, а не одной записью: компании в системе две, и у них разный учёт
   * — завод и торговля считают себестоимость по-своему. Требовать выбор
   * компании на чтение значило бы, что человек с доступом к обеим не увидит
   * настройку вовсе.
   *
   * Читать может каждый, кто видит склад: цифра себестоимости в отчёте без
   * метода не читается — непонятно, чем она посчитана.
   */
  async settings(companyUid?: string) {
    return this.prisma.withTenant(async (tx) => {
      const ids = currentContext()?.companyIds ?? [];
      if (ids.length === 0) throw new UnprocessableEntityException(MSG.noCompany());
      const only = companyUid ? await this.resolveCompany(tx, companyUid) : null;
      const rows = await tx.$queryRaw<SettingsRow[]>`
        SELECT uid, code, app_loc(name_ru, name_uz) AS name, costing_method::text AS method,
               below_cost_mode::text AS below,
               approval_limit_single::text AS single, approval_limit_period::text AS period,
               approval_period_days AS days
          FROM company
         WHERE id = ANY(${ids}) AND (${only}::bigint IS NULL OR id = ${only})
         ORDER BY code`;
      return { rows: rows.map(asSettings) };
    });
  }

  /**
   * Смена метода списания.
   *
   * Себестоимость уже проведённых движений не трогаем: она записана в журнале
   * и участвует в марже закрытых заказов. Пересчитать её задним числом значит
   * переписать прибыль по сделкам, которые уже закрыты, — метод действует с
   * момента смены и вперёд.
   */
  async setSettings(input: {
    companyUid?: string;
    costingMethod?: string;
    belowCostMode?: string;
    approvalLimitSingle?: number | null;
    approvalLimitPeriod?: number | null;
    approvalPeriodDays?: number;
  }) {
    return this.prisma.withTenant(async (tx) => {
      const companyId = await this.resolveCompany(tx, input.companyUid);
      const asked = [
        input.costingMethod,
        input.belowCostMode,
        input.approvalLimitSingle,
        input.approvalLimitPeriod,
        input.approvalPeriodDays,
      ];
      if (asked.every((v) => v === undefined)) {
        throw new UnprocessableEntityException(say('Нечего менять: настройка не указана', 'O‘zgartirishga narsa yo‘q: sozlama ko‘rsatilmagan'));
      }
      // Прежние значения читаем до записи: журнал должен сказать «было — стало».
      const prev = await tx.$queryRaw<SettingsRow[]>`
        SELECT uid, code, app_loc(name_ru, name_uz) AS name, costing_method::text AS method,
               below_cost_mode::text AS below,
               approval_limit_single::text AS single, approval_limit_period::text AS period,
               approval_period_days AS days
          FROM company WHERE id = ${companyId}`;
      const before = prev[0]!;
      if (input.costingMethod !== undefined) {
        await tx.$executeRaw`
          UPDATE company SET costing_method = ${input.costingMethod}::"CostingMethod"
           WHERE id = ${companyId}`;
      }
      // ТЗ 9.2. Правило действует с момента смены и вперёд: уже выписанные
      // строки заказов не перепроверяем — цена в них согласована тогда.
      if (input.belowCostMode !== undefined) {
        await tx.$executeRaw`
          UPDATE company SET below_cost_mode = ${input.belowCostMode}::"BelowCostMode"
           WHERE id = ${companyId}`;
      }
      // Порог подтверждения платёжки и предел за период на получателя
      // (требование заказчика со встречи 07.10). Значения заказчик называет
      // сам, поэтому это настройка, а не число в коде: порог меняют без
      // выкатки. `null` снимает ограничение совсем.
      //
      // Пустое значение отличается от «не присылали»: `undefined` — поле не
      // трогали, `null` — порог сняли. Без этого различия снять порог было бы
      // нечем.
      if (input.approvalLimitSingle !== undefined) {
        await tx.$executeRaw`
          UPDATE company SET approval_limit_single = ${input.approvalLimitSingle}::numeric
           WHERE id = ${companyId}`;
      }
      if (input.approvalLimitPeriod !== undefined) {
        await tx.$executeRaw`
          UPDATE company SET approval_limit_period = ${input.approvalLimitPeriod}::numeric
           WHERE id = ${companyId}`;
      }
      if (input.approvalPeriodDays !== undefined) {
        await tx.$executeRaw`
          UPDATE company SET approval_period_days = ${input.approvalPeriodDays}
           WHERE id = ${companyId}`;
      }
      const rows = await tx.$queryRaw<SettingsRow[]>`
        SELECT uid, code, app_loc(name_ru, name_uz) AS name, costing_method::text AS method,
               below_cost_mode::text AS below,
               approval_limit_single::text AS single, approval_limit_period::text AS period,
               approval_period_days AS days
          FROM company WHERE id = ${companyId}`;

      // Учётная политика, правило убытка и порог подтверждения меняют то, как
      // считаются и как уходят деньги по всей компании. Такое обязано
      // оставлять след: журнал действий (ТЗ 3.4). Порог — тем более: это он
      // решает, чьё «да» нужно платежу.
      await writeAudit(tx, {
        companyId,
        entityType: 'company_settings',
        entityId: rows[0].uid,
        action: 'update',
        changes: {
          ...(input.costingMethod !== undefined
            ? { costingMethod: { from: before.method, to: rows[0].method } }
            : {}),
          ...(input.belowCostMode !== undefined
            ? { belowCostMode: { from: before.below, to: rows[0].below } }
            : {}),
          ...(input.approvalLimitSingle !== undefined
            ? { approvalLimitSingle: { from: before.single, to: rows[0].single } }
            : {}),
          ...(input.approvalLimitPeriod !== undefined
            ? { approvalLimitPeriod: { from: before.period, to: rows[0].period } }
            : {}),
          ...(input.approvalPeriodDays !== undefined
            ? { approvalPeriodDays: { from: before.days, to: rows[0].days } }
            : {}),
        },
      });
      return asSettings(rows[0]);
    });
  }

  // --- склады, зоны, ячейки -------------------------------------------------

  /** Дерево целиком: складов и ячеек десятки, второй запрос за зонами лишний. */
  async places(all = false) {
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.$queryRawUnsafe<Record<string, any>[]>(
        `SELECT w.uid AS warehouse_uid, w.code AS warehouse_code,
                w.name_ru AS warehouse_name_ru, w.name_uz AS warehouse_name_uz,
                w.address, w.is_active AS warehouse_active,
                co.uid AS company_uid, co.code AS company_code,
                z.uid AS zone_uid, z.code AS zone_code,
                z.name_ru AS zone_name_ru, z.name_uz AS zone_name_uz,
                z.is_active AS zone_active,
                l.uid AS location_uid, l.code AS location_code, l.barcode,
                l.is_active AS location_active,
                (SELECT count(*) FROM stock_balance b
                  WHERE b.location_id = l.id AND b.qty_on_hand <> 0) AS location_stock
           FROM warehouse w
           JOIN company co ON co.id = w.company_id
           LEFT JOIN warehouse_zone z ON z.warehouse_id = w.id AND ($1::boolean OR z.is_active)
           LEFT JOIN storage_location l ON l.zone_id = z.id AND ($1::boolean OR l.is_active)
          WHERE ($1::boolean OR w.is_active)
          ORDER BY co.code, w.code, z.code, l.code`,
        all,
      );

      const byWarehouse = new Map<string, any>();
      for (const r of rows) {
        let w = byWarehouse.get(r.warehouse_uid);
        if (!w) {
          w = {
            uid: r.warehouse_uid,
            code: r.warehouse_code,
            nameRu: r.warehouse_name_ru,
            nameUz: r.warehouse_name_uz,
            address: r.address,
            isActive: r.warehouse_active,
            company: { uid: r.company_uid, code: r.company_code },
            zones: [],
          };
          byWarehouse.set(r.warehouse_uid, w);
        }
        if (!r.zone_uid) continue;
        let z = w.zones.find((x: any) => x.uid === r.zone_uid);
        if (!z) {
          z = {
            uid: r.zone_uid,
            code: r.zone_code,
            nameRu: r.zone_name_ru,
            nameUz: r.zone_name_uz,
            isActive: r.zone_active,
            locations: [],
          };
          w.zones.push(z);
        }
        if (!r.location_uid) continue;
        z.locations.push({
          uid: r.location_uid,
          code: r.location_code,
          barcode: r.barcode,
          isActive: r.location_active,
          hasStock: Number(r.location_stock) > 0,
        });
      }
      return { rows: [...byWarehouse.values()] };
    });
  }

  async createWarehouse(input: { companyUid?: string; code: string; nameRu: string; nameUz?: string; address?: string }) {
    return this.prisma.withTenant(async (tx) => {
      const companyId = await this.resolveCompany(tx, input.companyUid);
      const dup = await this.count(
        tx,
        `SELECT count(*) AS n FROM warehouse WHERE company_id = $1 AND code = $2`,
        companyId,
        input.code.trim(),
      );
      if (dup > 0) throw new ConflictException(say(`Склад с кодом «${input.code.trim()}» уже есть`, `«${input.code.trim()}» kodli ombor allaqachon bor`));

      const rows = await tx.$queryRawUnsafe<{ uid: string }[]>(
        `INSERT INTO warehouse (uid, company_id, code, name_ru, name_uz, address)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5) RETURNING uid`,
        companyId,
        input.code.trim(),
        input.nameRu.trim(),
        (input.nameUz ?? input.nameRu).trim(),
        input.address?.trim() || null,
      );
      await writeAudit(tx, {
        companyId,
        entityType: 'warehouse',
        entityId: rows[0]!.uid,
        action: 'create',
        changes: {
          code: { from: null, to: input.code.trim() },
          name: { from: null, to: input.nameRu.trim() },
        },
      });
      return { uid: rows[0]!.uid };
    });
  }

  async updateWarehouse(
    uid: string,
    input: { code?: string; nameRu?: string; nameUz?: string; address?: string; isActive?: boolean },
  ) {
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.$queryRaw<{ id: bigint; company_id: bigint }[]>`
        SELECT id, company_id FROM warehouse WHERE uid = ${uid}::uuid`;
      const w = rows[0];
      if (!w) throw new NotFoundException(MSG.warehouseNotFound());

      if (input.isActive === false) {
        const stock = await this.count(
          tx,
          `SELECT count(*) AS n FROM stock_balance WHERE warehouse_id = $1 AND qty_on_hand <> 0`,
          w.id,
        );
        if (stock > 0) {
          throw new UnprocessableEntityException(say(
            `На складе ${stock} строк остатка: выключенный склад исчезнет из подбора, а товар останется в отчёте`, `Omborda ${stock} qoldiq qatori bor: o‘chirilgan ombor tanlovdan yo‘qoladi, tovar esa hisobotda qoladi`));
        }
      }

      if (input.code !== undefined) {
        const dup = await this.count(
          tx,
          `SELECT count(*) AS n FROM warehouse WHERE company_id = $1 AND code = $2 AND id <> $3`,
          w.company_id,
          input.code.trim(),
          w.id,
        );
        if (dup > 0) throw new ConflictException(say(`Код «${input.code.trim()}» уже занят`, `«${input.code.trim()}» kodi allaqachon band`));
      }

      await tx.$queryRawUnsafe(
        `UPDATE warehouse SET code = COALESCE($2, code), name_ru = COALESCE($3, name_ru),
                              name_uz = COALESCE($4, name_uz), address = COALESCE($5, address),
                              is_active = COALESCE($6, is_active)
          WHERE id = $1`,
        w.id,
        input.code?.trim() ?? null,
        input.nameRu?.trim() ?? null,
        input.nameUz?.trim() ?? null,
        input.address?.trim() ?? null,
        input.isActive ?? null,
      );
      await writeAudit(tx, {
        companyId: w.company_id,
        entityType: 'warehouse',
        entityId: uid,
        action: 'update',
        changes: {
          ...(input.code !== undefined ? { code: { from: null, to: input.code.trim() } } : {}),
          ...(input.nameRu !== undefined ? { name: { from: null, to: input.nameRu.trim() } } : {}),
          ...(input.address !== undefined
            ? { address: { from: null, to: input.address.trim() } }
            : {}),
          ...(input.isActive !== undefined ? { isActive: { from: null, to: input.isActive } } : {}),
        },
      });
      return { uid, updated: true as const };
    });
  }

  async createZone(input: { warehouseUid: string; code: string; nameRu: string; nameUz?: string }) {
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.$queryRaw<{ id: bigint; company_id: bigint; code: string }[]>`
        SELECT id, company_id, code FROM warehouse WHERE uid = ${input.warehouseUid}::uuid`;
      const w = rows[0];
      if (!w) throw new NotFoundException(MSG.warehouseNotFound());

      const dup = await this.count(
        tx,
        `SELECT count(*) AS n FROM warehouse_zone WHERE warehouse_id = $1 AND code = $2`,
        w.id,
        input.code.trim(),
      );
      if (dup > 0) throw new ConflictException(say(`Зона «${input.code.trim()}» на складе уже есть`, `Omborda «${input.code.trim()}» zonasi allaqachon bor`));

      const out = await tx.$queryRawUnsafe<{ uid: string }[]>(
        `INSERT INTO warehouse_zone (warehouse_id, code, name_ru, name_uz)
         VALUES ($1, $2, $3, $4) RETURNING uid`,
        w.id,
        input.code.trim(),
        input.nameRu.trim(),
        (input.nameUz ?? input.nameRu).trim(),
      );
      await writeAudit(tx, {
        companyId: w.company_id,
        entityType: 'warehouse_zone',
        entityId: out[0]!.uid,
        action: 'create',
        changes: {
          warehouse: { from: null, to: w.code },
          code: { from: null, to: input.code.trim() },
          name: { from: null, to: input.nameRu.trim() },
        },
      });
      return { uid: out[0]!.uid };
    });
  }

  async createLocation(input: { zoneUid: string; code: string; barcode?: string }) {
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.$queryRaw<{ id: bigint; company_id: bigint; code: string }[]>`
        SELECT z.id, w.company_id, z.code
          FROM warehouse_zone z JOIN warehouse w ON w.id = z.warehouse_id
         WHERE z.uid = ${input.zoneUid}::uuid`;
      const z = rows[0];
      if (!z) throw new NotFoundException(say('Зона не найдена', 'Zona topilmadi'));

      const dup = await this.count(
        tx,
        `SELECT count(*) AS n FROM storage_location WHERE zone_id = $1 AND code = $2`,
        z.id,
        input.code.trim(),
      );
      if (dup > 0) throw new ConflictException(say(`Ячейка «${input.code.trim()}» в зоне уже есть`, `Zonada «${input.code.trim()}» yacheykasi allaqachon bor`));

      const out = await tx.$queryRawUnsafe<{ uid: string }[]>(
        `INSERT INTO storage_location (zone_id, code, barcode) VALUES ($1, $2, $3) RETURNING uid`,
        z.id,
        input.code.trim(),
        input.barcode?.trim() || null,
      );
      await writeAudit(tx, {
        companyId: z.company_id,
        entityType: 'storage_location',
        entityId: out[0]!.uid,
        action: 'create',
        changes: {
          zone: { from: null, to: z.code },
          code: { from: null, to: input.code.trim() },
          ...(input.barcode ? { barcode: { from: null, to: input.barcode.trim() } } : {}),
        },
      });
      return { uid: out[0]!.uid };
    });
  }

  async updateLocation(uid: string, input: { code?: string; barcode?: string; isActive?: boolean }) {
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.$queryRaw<
        { id: bigint; zone_id: bigint; company_id: bigint; code: string }[]
      >`
        SELECT l.id, l.zone_id, w.company_id, l.code
          FROM storage_location l
          JOIN warehouse_zone z ON z.id = l.zone_id
          JOIN warehouse w ON w.id = z.warehouse_id
         WHERE l.uid = ${uid}::uuid`;
      const l = rows[0];
      if (!l) throw new NotFoundException(MSG.locationNotFound());

      if (input.isActive === false) {
        const stock = await this.count(
          tx,
          `SELECT count(*) AS n FROM stock_balance WHERE location_id = $1 AND qty_on_hand <> 0`,
          l.id,
        );
        if (stock > 0) {
          throw new UnprocessableEntityException(say(
            'В ячейке лежит товар: сначала переложите остаток, потом выключайте', 'Yacheykada tovar bor: avval qoldiqni ko‘chiring, keyin o‘chiring'));
        }
      }

      if (input.code !== undefined) {
        const dup = await this.count(
          tx,
          `SELECT count(*) AS n FROM storage_location WHERE zone_id = $1 AND code = $2 AND id <> $3`,
          l.zone_id,
          input.code.trim(),
          l.id,
        );
        if (dup > 0) throw new ConflictException(say(`Код «${input.code.trim()}» в зоне занят`, `Zonada «${input.code.trim()}» kodi band`));
      }

      await tx.$queryRawUnsafe(
        `UPDATE storage_location SET code = COALESCE($2, code), barcode = COALESCE($3, barcode),
                                     is_active = COALESCE($4, is_active)
          WHERE id = $1`,
        l.id,
        input.code?.trim() ?? null,
        input.barcode?.trim() ?? null,
        input.isActive ?? null,
      );
      await writeAudit(tx, {
        companyId: l.company_id,
        entityType: 'storage_location',
        entityId: uid,
        action: 'update',
        changes: {
          code: { from: l.code, to: input.code?.trim() ?? l.code },
          ...(input.barcode !== undefined
            ? { barcode: { from: null, to: input.barcode.trim() } }
            : {}),
          ...(input.isActive !== undefined ? { isActive: { from: null, to: input.isActive } } : {}),
        },
      });
      return { uid, updated: true as const };
    });
  }

  async deleteLocation(uid: string) {
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.$queryRaw<{ id: bigint; company_id: bigint; code: string }[]>`
        SELECT l.id, w.company_id, l.code
          FROM storage_location l
          JOIN warehouse_zone z ON z.id = l.zone_id
          JOIN warehouse w ON w.id = z.warehouse_id
         WHERE l.uid = ${uid}::uuid`;
      const l = rows[0];
      if (!l) throw new NotFoundException(MSG.locationNotFound());

      const used = await this.count(
        tx,
        `SELECT (SELECT count(*) FROM stock_balance WHERE location_id = $1)
              + (SELECT count(*) FROM stock_move WHERE from_location_id = $1 OR to_location_id = $1)
              + (SELECT count(*) FROM inventory_sheet_line WHERE location_id = $1) AS n`,
        l.id,
      );
      if (used > 0) {
        throw new ConflictException(say(
          `Ячейка встречается в ${used} записях: её можно выключить, но не удалить`, `Yacheyka ${used} yozuvda uchraydi: uni o‘chirib qo‘yish mumkin, o‘chirib tashlash esa yo‘q`));
      }
      await tx.$queryRawUnsafe(`DELETE FROM storage_location WHERE id = $1`, l.id);
      await writeAudit(tx, {
        companyId: l.company_id,
        entityType: 'storage_location',
        entityId: uid,
        action: 'delete',
        changes: { code: { from: l.code, to: null } },
      });
      return { uid, removed: true as const };
    });
  }

  // --- причины списания (ТЗ 5.7) -------------------------------------------

  async reasons(all = false) {
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.$queryRawUnsafe<Record<string, any>[]>(
        `SELECT r.uid, r.kind::text AS kind, r.name_ru, r.name_uz, r.is_active,
                co.uid AS company_uid, co.code AS company_code,
                (SELECT count(*) FROM stock_move m WHERE m.reason_id = r.id) AS moves
           FROM stock_reason r
           JOIN company co ON co.id = r.company_id
          WHERE ($1::boolean OR r.is_active)
          ORDER BY co.code, r.kind, r.name_ru`,
        all,
      );
      return {
        rows: rows.map((r) => ({
          uid: r.uid,
          kind: r.kind,
          nameRu: r.name_ru,
          nameUz: r.name_uz,
          isActive: r.is_active,
          company: { uid: r.company_uid, code: r.company_code },
          moves: Number(r.moves),
        })),
      };
    });
  }

  async createReason(input: { companyUid?: string; kind: string; nameRu: string; nameUz?: string }) {
    return this.prisma.withTenant(async (tx) => {
      const companyId = await this.resolveCompany(tx, input.companyUid);
      const rows = await tx.$queryRawUnsafe<{ uid: string }[]>(
        `INSERT INTO stock_reason (company_id, kind, name_ru, name_uz)
         VALUES ($1, $2::"ReasonKind", $3, $4) RETURNING uid`,
        companyId,
        input.kind,
        input.nameRu.trim(),
        (input.nameUz ?? input.nameRu).trim(),
      );
      await writeAudit(tx, {
        companyId,
        entityType: 'stock_reason',
        entityId: rows[0]!.uid,
        action: 'create',
        changes: {
          kind: { from: null, to: input.kind },
          name: { from: null, to: input.nameRu.trim() },
        },
      });
      return { uid: rows[0]!.uid };
    });
  }

  async updateReason(uid: string, input: { nameRu?: string; nameUz?: string; isActive?: boolean }) {
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.$queryRaw<{ id: bigint; company_id: bigint; name_ru: string }[]>`
        SELECT id, company_id, name_ru FROM stock_reason WHERE uid = ${uid}::uuid`;
      const r = rows[0];
      if (!r) throw new NotFoundException(MSG.reasonNotFound());

      await tx.$queryRawUnsafe(
        `UPDATE stock_reason SET name_ru = COALESCE($2, name_ru), name_uz = COALESCE($3, name_uz),
                                 is_active = COALESCE($4, is_active)
          WHERE id = $1`,
        r.id,
        input.nameRu?.trim() ?? null,
        input.nameUz?.trim() ?? null,
        input.isActive ?? null,
      );
      await writeAudit(tx, {
        companyId: r.company_id,
        entityType: 'stock_reason',
        entityId: uid,
        action: 'update',
        changes: {
          ...(input.nameRu !== undefined
            ? { name: { from: r.name_ru, to: input.nameRu.trim() } }
            : {}),
          ...(input.isActive !== undefined ? { isActive: { from: null, to: input.isActive } } : {}),
        },
      });
      return { uid, updated: true as const };
    });
  }

  async deleteReason(uid: string) {
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.$queryRaw<{ id: bigint; company_id: bigint; name_ru: string }[]>`
        SELECT id, company_id, name_ru FROM stock_reason WHERE uid = ${uid}::uuid`;
      const r = rows[0];
      if (!r) throw new NotFoundException(MSG.reasonNotFound());

      const used = await this.count(
        tx,
        `SELECT (SELECT count(*) FROM stock_move WHERE reason_id = $1)
              + (SELECT count(*) FROM production_output WHERE reason_id = $1)
              + (SELECT count(*) FROM deviation_log WHERE reason_id = $1) AS n`,
        r.id,
      );
      if (used > 0) {
        throw new ConflictException(say(
          `По причине уже списано ${used} раз: удаление стёрло бы объяснение из истории, её можно выключить`, `Sabab bo‘yicha ${used} marta chiqim qilingan: o‘chirish tarixdagi izohni yo‘qotardi, uni o‘chirib qo‘yish mumkin`));
      }
      await tx.$queryRawUnsafe(`DELETE FROM stock_reason WHERE id = $1`, r.id);
      await writeAudit(tx, {
        companyId: r.company_id,
        entityType: 'stock_reason',
        entityId: uid,
        action: 'delete',
        changes: { name: { from: r.name_ru, to: null } },
      });
      return { uid, removed: true as const };
    });
  }

  // --- уровни запаса на склад (ТЗ 5.10) ------------------------------------

  async levels() {
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.$queryRaw<Record<string, any>[]>`
        SELECT sl.uid, sl.min_qty, sl.critical_qty, sl.comment,
               i.uid AS item_uid, i.code AS item_code,
               i.name_ru AS item_name_ru, i.name_uz AS item_name_uz,
               u.code AS unit,
               w.uid AS warehouse_uid, w.code AS warehouse_code,
               w.name_ru AS warehouse_name_ru, w.name_uz AS warehouse_name_uz
          FROM item_stock_level sl
          JOIN item i ON i.id = sl.item_id
          JOIN unit u ON u.id = i.base_unit_id
          JOIN warehouse w ON w.id = sl.warehouse_id
         ORDER BY w.code, i.name_ru`;
      return {
        rows: rows.map((r) => ({
          uid: r.uid,
          item: {
            uid: r.item_uid,
            code: r.item_code,
            nameRu: r.item_name_ru,
            nameUz: r.item_name_uz,
            unit: r.unit,
          },
          warehouse: {
            uid: r.warehouse_uid,
            code: r.warehouse_code,
            nameRu: r.warehouse_name_ru,
            nameUz: r.warehouse_name_uz,
          },
          minQty: String(r.min_qty),
          criticalQty: String(r.critical_qty),
          comment: r.comment,
        })),
      };
    });
  }

  /**
   * Уровень на пару «позиция + склад» один: два разных числа про один склад —
   * вопрос без ответа, а потребность в закупке ответа не ждёт. Поэтому запись
   * идёт `ON CONFLICT DO UPDATE`, а не «создать ещё одну строку».
   */
  async setLevel(input: {
    itemUid: string;
    warehouseUid: string;
    minQty: number;
    criticalQty: number;
    comment?: string;
  }) {
    return this.prisma.withTenant(async (tx) => {
      const items = await tx.$queryRaw<{ id: bigint; company_id: bigint }[]>`
        SELECT id, company_id FROM item WHERE uid = ${input.itemUid}::uuid`;
      const item = items[0];
      if (!item) throw new NotFoundException(MSG.lineNotFound());

      const whs = await tx.$queryRaw<{ id: bigint; company_id: bigint }[]>`
        SELECT id, company_id FROM warehouse WHERE uid = ${input.warehouseUid}::uuid`;
      const wh = whs[0];
      if (!wh) throw new NotFoundException(MSG.warehouseNotFound());

      // Позиция торговой конторы с уровнем на складе завода — это уровень,
      // который никогда не сработает: движений такой пары не бывает.
      if (item.company_id !== wh.company_id) {
        throw new UnprocessableEntityException(say('Позиция и склад из разных компаний', 'Pozitsiya va ombor turli kompaniyalardan'));
      }
      if (input.minQty > 0 && input.criticalQty > input.minQty) {
        throw new UnprocessableEntityException(say(
          'Критический уровень выше минимального: позиция провалится в критические, ' +
            'ни разу не побывав «ниже минимума»', 'Kritik daraja minimaldan yuqori: pozitsiya «minimumdan past» bo‘lmay turib ' + 'to‘g‘ridan-to‘g‘ri kritiklarga tushadi'));
      }
      if (input.minQty <= 0 && input.criticalQty <= 0) {
        throw new UnprocessableEntityException(say(
          'Оба уровня нулевые: такая строка ничего не говорит, но выключает уровень компании', 'Ikkala daraja nol: bunday qator hech narsa demaydi, lekin kompaniya darajasini o‘chiradi'));
      }

      const rows = await tx.$queryRawUnsafe<{ uid: string }[]>(
        `INSERT INTO item_stock_level (company_id, item_id, warehouse_id, min_qty, critical_qty, comment)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (company_id, item_id, warehouse_id) DO UPDATE
           SET min_qty = EXCLUDED.min_qty,
               critical_qty = EXCLUDED.critical_qty,
               comment = EXCLUDED.comment,
               updated_at = now()
         RETURNING uid`,
        item.company_id,
        item.id,
        wh.id,
        input.minQty,
        input.criticalQty,
        input.comment?.trim() || null,
      );
      // Уровень решает, когда позиция попадёт в потребность в закупке. Правка
      // без следа означала бы «кто-то изменил, и теперь не напоминает».
      await writeAudit(tx, {
        companyId: item.company_id,
        entityType: 'item_stock_level',
        entityId: rows[0]!.uid,
        action: 'set',
        changes: {
          minQty: { from: null, to: input.minQty },
          criticalQty: { from: null, to: input.criticalQty },
          ...(input.comment ? { comment: { from: null, to: input.comment.trim() } } : {}),
        },
      });
      return { uid: rows[0]!.uid };
    });
  }

  /** Уровень — настройка, а не история: его удаляют, а не выключают. */
  async deleteLevel(uid: string) {
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.$queryRaw<
        { id: bigint; company_id: bigint; min_qty: string; critical_qty: string }[]
      >`
        SELECT id, company_id, min_qty::text AS min_qty, critical_qty::text AS critical_qty
          FROM item_stock_level WHERE uid = ${uid}::uuid`;
      const row = rows[0];
      if (!row) throw new NotFoundException(say('Уровень не найден', 'Daraja topilmadi'));
      await tx.$queryRawUnsafe(`DELETE FROM item_stock_level WHERE id = $1`, row.id);
      await writeAudit(tx, {
        companyId: row.company_id,
        entityType: 'item_stock_level',
        entityId: uid,
        action: 'delete',
        changes: {
          minQty: { from: Number(row.min_qty), to: null },
          criticalQty: { from: Number(row.critical_qty), to: null },
        },
      });
      return { uid, removed: true as const };
    });
  }
}
