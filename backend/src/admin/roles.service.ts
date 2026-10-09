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

/** Человеческие названия модулей: в праве стоит код, на экране — раздел. */
const MODULE_NAMES: Record<string, { ru: string; uz: string }> = {
  dashboard: { ru: 'Сводка', uz: 'Boshqaruv paneli' },
  sales: { ru: 'Продажи', uz: 'Sotuvlar' },
  warehouse: { ru: 'Склад', uz: 'Ombor' },
  production: { ru: 'Производство', uz: 'Ishlab chiqarish' },
  finance: { ru: 'Финансы', uz: 'Moliya' },
  crm: { ru: 'CRM', uz: 'CRM' },
  documents: { ru: 'Документы', uz: 'Hujjatlar' },
  refs: { ru: 'Справочники', uz: 'Ma’lumotnomalar' },
  settings: { ru: 'Настройки учёта', uz: 'Hisob sozlamalari' },
  admin: { ru: 'Администрирование', uz: 'Administratorlik' },
};

/**
 * Роли и матрица прав (ТЗ 3.3).
 *
 * Роль — именованный набор прав; право — атом вида `warehouse.writeoff`.
 * Матрица на экране и есть эта связь, и правится она здесь.
 *
 * Два правила:
 *
 * 1. **У системной роли правятся права, но не код и не существование.** Код
 *    системной роли — то, по чему её узнаёт сид и тесты; переименовав его, мы
 *    оставили бы назначения висеть на незнакомом имени.
 * 2. **Роль `admin` не может снять себе управление.** Матрица — обычная форма,
 *    и в ней легко снять галочку «Управление пользователями» у самих
 *    администраторов. После этого экран прав закрыт для всех и вернуть его
 *    изнутри нельзя.
 */
@Injectable()
export class AdminRolesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Областью запроса здесь служат все компании человека, а не выбранная.
   *
   * Люди и роли компании не принадлежат: один кладовщик работает и в
   * «Торговом доме», и на заводе. Сузив область заголовком, администратор не
   * увидел бы половину назначений и не смог бы назначить роль во второй
   * компании — политика по компании отклонила бы вставку.
   */
  private withAdminScope<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const ctx = currentContext();
    const ids = ctx?.allCompanyIds?.length ? ctx.allCompanyIds : (ctx?.companyIds ?? []);
    return this.prisma.withContext(ctx?.userId ?? null, ids, fn);
  }

  private auditCompany(): bigint {
    const ctx = currentContext();
    const ids = ctx?.companyIds?.length ? ctx.companyIds : (ctx?.allCompanyIds ?? []);
    if (ids.length === 0) throw new UnprocessableEntityException(MSG.noCompany());
    return ids[0]!;
  }

  /** Каталог прав, сгруппированный по модулям: порядок модулей — порядок разделов. */
  async permissions() {
    return this.withAdminScope(async (tx) => {
      const rows = await tx.$queryRaw<
        { code: string; module: string; description_ru: string; description_uz: string }[]
      >`
        SELECT code, module, description_ru, description_uz
          FROM permission ORDER BY module, code`;

      const order = Object.keys(MODULE_NAMES);
      const groups = new Map<string, { code: string; descriptionRu: string; descriptionUz: string }[]>();
      for (const r of rows) {
        const list = groups.get(r.module) ?? [];
        list.push({
          code: r.code,
          descriptionRu: r.description_ru,
          descriptionUz: r.description_uz,
        });
        groups.set(r.module, list);
      }

      return {
        modules: [...groups.entries()]
          .sort((a, b) => {
            const ia = order.indexOf(a[0]);
            const ib = order.indexOf(b[0]);
            return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
          })
          .map(([module, permissions]) => ({
            module,
            nameRu: MODULE_NAMES[module]?.ru ?? module,
            nameUz: MODULE_NAMES[module]?.uz ?? module,
            permissions,
          })),
      };
    });
  }

  async list() {
    return this.withAdminScope(async (tx) => {
      const rows = await tx.$queryRaw<
        {
          id: bigint;
          code: string;
          name_ru: string;
          name_uz: string;
          is_system: boolean;
          company_uid: string | null;
          company_code: string | null;
          users: bigint;
        }[]
      >`
        SELECT r.id, r.code, r.name_ru, r.name_uz, r.is_system,
               c.uid AS company_uid, c.code AS company_code,
               (SELECT count(DISTINCT a.user_id)::bigint
                  FROM user_role_assignment a WHERE a.role_id = r.id) AS users
          FROM "role" r
          LEFT JOIN company c ON c.id = r.company_id
         ORDER BY r.is_system DESC, r.code`;

      const perms = await tx.$queryRaw<{ role_id: bigint; code: string }[]>`
        SELECT rp.role_id, p.code
          FROM role_permission rp
          JOIN permission p ON p.id = rp.permission_id
         ORDER BY p.module, p.code`;

      const byRole = new Map<string, string[]>();
      for (const p of perms) {
        const key = String(p.role_id);
        byRole.set(key, [...(byRole.get(key) ?? []), p.code]);
      }

      return {
        rows: rows.map((r) => ({
          code: r.code,
          nameRu: r.name_ru,
          nameUz: r.name_uz,
          isSystem: r.is_system,
          company: r.company_uid ? { uid: r.company_uid, code: r.company_code } : null,
          users: Number(r.users),
          permissions: byRole.get(String(r.id)) ?? [],
        })),
      };
    });
  }

  async create(input: { code: string; nameRu: string; nameUz: string; permissions: string[] }) {
    return this.withAdminScope(async (tx) => {
      const companyId = this.auditCompany();
      const taken = await tx.$queryRaw<{ n: bigint }[]>`
        SELECT count(*)::bigint AS n FROM "role"
         WHERE code = ${input.code} AND (company_id IS NULL OR company_id = ${companyId})`;
      if (Number(taken[0]!.n) > 0) {
        throw new ConflictException(say('Роль с таким кодом уже есть', 'Bunday kodli rol allaqachon bor'));
      }

      const made = await tx.$queryRaw<{ id: bigint }[]>`
        INSERT INTO "role" (company_id, code, name_ru, name_uz, is_system)
        VALUES (${companyId}, ${input.code}, ${input.nameRu}, ${input.nameUz}, false)
        RETURNING id`;
      const roleId = made[0]!.id;
      await this.replacePermissions(tx, roleId, input.permissions);

      await writeAudit(tx, {
        companyId,
        entityType: 'role',
        entityId: input.code,
        action: 'create',
        changes: {
          nameRu: { from: null, to: input.nameRu },
          permissions: { from: null, to: input.permissions.join(', ') },
        },
      });

      return this.one(tx, input.code);
    });
  }

  async update(code: string, patch: { nameRu?: string; nameUz?: string }) {
    return this.withAdminScope(async (tx) => {
      const role = await this.row(tx, code);
      await tx.$queryRaw`
        UPDATE "role"
           SET name_ru = coalesce(${patch.nameRu ?? null}, name_ru),
               name_uz = coalesce(${patch.nameUz ?? null}, name_uz)
         WHERE id = ${role.id}`;
      await writeAudit(tx, {
        companyId: this.auditCompany(),
        entityType: 'role',
        entityId: code,
        action: 'update',
        changes: { nameRu: { from: role.name_ru, to: patch.nameRu ?? role.name_ru } },
      });
      return this.one(tx, code);
    });
  }

  async setPermissions(code: string, permissions: string[]) {
    return this.withAdminScope(async (tx) => {
      const role = await this.row(tx, code);

      if (code === 'admin') {
        const keeps = permissions.filter((p) => p.startsWith('admin.'));
        const needed = await tx.$queryRaw<{ code: string }[]>`
          SELECT code FROM permission WHERE module = 'admin' ORDER BY code`;
        const missing = needed.map((n) => n.code).filter((n) => !keeps.includes(n));
        if (missing.length > 0) {
          throw new UnprocessableEntityException(say(`У роли admin нельзя снять управление: ${missing.join(', ')} — ` +
              'иначе настроить систему будет некому', `admin rolidan boshqaruvni olib tashlab bo‘lmaydi: ${missing.join(', ')} — ` + 'aks holda tizimni sozlaydigan odam qolmaydi'));
        }
      }

      const before = await this.permissionCodes(tx, role.id);
      await this.replacePermissions(tx, role.id, permissions);
      const after = await this.permissionCodes(tx, role.id);

      if (before.join(',') !== after.join(',')) {
        const added = after.filter((p) => !before.includes(p));
        const removed = before.filter((p) => !after.includes(p));
        await writeAudit(tx, {
          companyId: this.auditCompany(),
          entityType: 'role',
          entityId: code,
          action: 'permissions_set',
          changes: {
            // «Было → стало» целым списком читается плохо: прав двадцать шесть.
            // Человеку важно, что именно добавили и что отобрали.
            added: { from: null, to: added.join(', ') || 'ничего' },
            removed: { from: removed.join(', ') || 'ничего', to: null },
          },
        });
      }

      return this.one(tx, code);
    });
  }

  async remove(code: string) {
    return this.withAdminScope(async (tx) => {
      const role = await this.row(tx, code);
      if (role.is_system) {
        throw new UnprocessableEntityException(say('Системную роль не удаляют: на её код опирается настройка системы', 'Tizim rolini o‘chirib tashlanmaydi: tizim sozlamasi uning kodiga tayanadi'));
      }
      const used = await tx.$queryRaw<{ n: bigint }[]>`
        SELECT count(*)::bigint AS n FROM user_role_assignment WHERE role_id = ${role.id}`;
      if (Number(used[0]!.n) > 0) {
        throw new ConflictException(say(`Роль назначена людям (${Number(used[0]!.n)}): сначала переназначьте их`, `Rol xodimlarga berilgan (${Number(used[0]!.n)}): avval ularni boshqasiga o‘tkazing`));
      }
      await tx.$queryRaw`DELETE FROM role_permission WHERE role_id = ${role.id}`;
      await tx.$queryRaw`DELETE FROM "role" WHERE id = ${role.id}`;
      await writeAudit(tx, {
        companyId: this.auditCompany(),
        entityType: 'role',
        entityId: code,
        action: 'delete',
        changes: { nameRu: { from: role.name_ru, to: null } },
      });
      return { code, deleted: true };
    });
  }

  // --- внутреннее -----------------------------------------------------------

  private async row(tx: Tx, code: string) {
    const ctx = currentContext();
    const ids = ctx?.allCompanyIds?.length ? ctx.allCompanyIds : (ctx?.companyIds ?? []);
    const rows = await tx.$queryRaw<
      { id: bigint; name_ru: string; is_system: boolean; company_id: bigint | null }[]
    >`
      SELECT id, name_ru, is_system, company_id FROM "role"
       WHERE code = ${code}
         AND (company_id IS NULL OR company_id = ANY (${ids}::bigint[]))
       ORDER BY company_id NULLS LAST
       LIMIT 1`;
    const row = rows[0];
    if (!row) throw new NotFoundException(say('Роль не найдена', 'Rol topilmadi'));
    return row;
  }

  private async one(tx: Tx, code: string) {
    const role = await this.row(tx, code);
    return {
      code,
      nameRu: role.name_ru,
      isSystem: role.is_system,
      permissions: await this.permissionCodes(tx, role.id),
    };
  }

  private async permissionCodes(tx: Tx, roleId: bigint): Promise<string[]> {
    const rows = await tx.$queryRaw<{ code: string }[]>`
      SELECT p.code FROM role_permission rp
        JOIN permission p ON p.id = rp.permission_id
       WHERE rp.role_id = ${roleId}
       ORDER BY p.module, p.code`;
    return rows.map((r) => r.code);
  }

  private async replacePermissions(tx: Tx, roleId: bigint, permissions: string[]) {
    const unique = [...new Set(permissions)];
    const known = await tx.$queryRaw<{ code: string; id: bigint }[]>`
      SELECT code, id FROM permission WHERE code = ANY (${unique}::text[])`;
    const unknown = unique.filter((c) => !known.some((k) => k.code === c));
    if (unknown.length > 0) {
      throw new UnprocessableEntityException(say(`Неизвестные права: ${unknown.join(', ')}`, `Noma’lum huquqlar: ${unknown.join(', ')}`));
    }
    await tx.$queryRaw`DELETE FROM role_permission WHERE role_id = ${roleId}`;
    for (const k of known) {
      await tx.$queryRaw`
        INSERT INTO role_permission (role_id, permission_id) VALUES (${roleId}, ${k.id})`;
    }
  }
}
