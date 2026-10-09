import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { currentContext } from '../common/request-context.js';
import { writeAudit, diff } from '../common/audit.js';
import { MSG } from '../common/messages.js';
import { say } from '../common/say.js';

/** Назначение: роль в компании, с необязательным сужением области видимости. */
export type AssignmentInput = {
  roleCode: string;
  companyUid: string;
  departmentUid?: string;
  warehouseUid?: string;
  scope?: 'all' | 'own' | 'department' | 'warehouse';
};

export type UserInput = {
  login: string;
  fullName: string;
  password: string;
  email?: string;
  phone?: string;
  locale?: 'ru' | 'uz';
  assignments: AssignmentInput[];
};

export type UserPatch = {
  fullName?: string;
  email?: string | null;
  phone?: string | null;
  locale?: 'ru' | 'uz';
  isActive?: boolean;
};

const ROUNDS = 10;

/**
 * Пользователи, их роли и пароли (ТЗ 3.3).
 *
 * До этого модуля человека в системе заводил только пересев базы: администратор
 * клиента не мог ни принять нового кладовщика, ни закрыть доступ уволившемуся.
 *
 * Два запрета, которые здесь не обходятся ничем:
 *
 * 1. **Себя не выключают и себе роли не снимают.** Администратор, снявший
 *    себе доступ, запирает систему: вернуть права некому, кроме нас с базой
 *    в руках.
 * 2. **Последнего администратора не отключают.** То же самое другой рукой —
 *    когда активный администратор один, его нельзя ни выключить, ни лишить
 *    роли.
 *
 * Пароль здесь только задаётся. Прежний не показывается и не возвращается
 * никогда: в ответе его нет, в журнале остаётся факт смены без значения.
 */
@Injectable()
export class AdminUsersService {
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

  /** Компания, в чей журнал пишем действие: та, в которой администратор работает. */
  private auditCompany(): bigint {
    const ctx = currentContext();
    const ids = ctx?.companyIds?.length ? ctx.companyIds : (ctx?.allCompanyIds ?? []);
    if (ids.length === 0) throw new UnprocessableEntityException(MSG.noCompany());
    return ids[0]!;
  }

  async list(params: { search?: string; limit: number; offset: number; includeInactive: boolean }) {
    return this.withAdminScope(async (tx) => {
      const search = params.search?.trim() ? `%${params.search.trim()}%` : null;
      const total = await tx.$queryRaw<{ n: bigint }[]>`
        SELECT count(*)::bigint AS n FROM user_account u
         WHERE (${params.includeInactive}::boolean OR u.is_active)
           AND (${search}::text IS NULL
                OR u.login ILIKE ${search} OR u.full_name ILIKE ${search}
                OR coalesce(u.email, '') ILIKE ${search})`;

      const rows = await tx.$queryRaw<
        {
          uid: string;
          login: string;
          full_name: string;
          email: string | null;
          phone: string | null;
          locale: 'ru' | 'uz';
          is_active: boolean;
          last_login_at: Date | null;
          locked_until: Date | null;
          failed_login_count: number;
          created_at: Date;
          telegram_user_id: bigint | null;
          telegram_linked_at: Date | null;
          telegram_blocked: boolean;
          telegram_blocked_at: Date | null;
          code_expires_at: Date | null;
        }[]
      >`
        SELECT u.uid, u.login, u.full_name, u.email, u.phone, u.locale::text AS locale,
               u.is_active, u.last_login_at, u.locked_until, u.failed_login_count, u.created_at,
               u.telegram_user_id, u.telegram_linked_at,
               u.telegram_blocked, u.telegram_blocked_at,
               -- Живой код привязки: администратор должен видеть, что код уже
               -- выдан и до какого времени он годится, иначе выдаст второй и
               -- погасит первый, который человек в это время набирает.
               (SELECT c.expires_at FROM telegram_link_code c
                 WHERE c.user_id = u.id AND c.used_at IS NULL AND c.revoked_at IS NULL
                   AND c.expires_at > now()
                 ORDER BY c.expires_at DESC LIMIT 1) AS code_expires_at
          FROM user_account u
         WHERE (${params.includeInactive}::boolean OR u.is_active)
           AND (${search}::text IS NULL
                OR u.login ILIKE ${search} OR u.full_name ILIKE ${search}
                OR coalesce(u.email, '') ILIKE ${search})
         ORDER BY u.is_active DESC, u.login, u.uid
         LIMIT ${params.limit}::int OFFSET ${params.offset}::int`;

      // Назначения берём одним запросом на всю страницу: по запросу на человека
      // список из сорока учёток давал бы сорок обращений к базе.
      //
      // RLS на user_role_assignment закрывает его по компании, и это ровно то,
      // что нужно: администратор «Торгового дома» видит, кто и кем работает у
      // него, а не весь флот компаний.
      const assignments = await tx.$queryRaw<
        {
          user_uid: string;
          role_code: string;
          role_name_ru: string;
          role_name_uz: string;
          company_uid: string;
          company_code: string;
          company_name_ru: string;
          department: string | null;
          warehouse: string | null;
          scope: string;
        }[]
      >`
        SELECT u.uid AS user_uid,
               r.code AS role_code, r.name_ru AS role_name_ru, r.name_uz AS role_name_uz,
               c.uid AS company_uid, c.code AS company_code, c.name_ru AS company_name_ru,
               app_loc(d.name_ru, d.name_uz) AS department, app_loc(w.name_ru, w.name_uz) AS warehouse, a.scope::text AS scope
          FROM user_role_assignment a
          JOIN user_account u ON u.id = a.user_id
          JOIN "role" r       ON r.id = a.role_id
          JOIN company c      ON c.id = a.company_id
          LEFT JOIN department d ON d.id = a.department_id
          LEFT JOIN warehouse w  ON w.id = a.warehouse_id
         ORDER BY c.code, r.code`;

      const byUser = new Map<string, unknown[]>();
      for (const a of assignments) {
        const list = byUser.get(a.user_uid) ?? [];
        list.push({
          role: { code: a.role_code, nameRu: a.role_name_ru, nameUz: a.role_name_uz },
          company: { uid: a.company_uid, code: a.company_code, nameRu: a.company_name_ru },
          department: a.department,
          warehouse: a.warehouse,
          scope: a.scope,
        });
        byUser.set(a.user_uid, list);
      }

      return {
        total: Number(total[0]?.n ?? 0),
        rows: rows.map((r) => ({
          uid: r.uid,
          login: r.login,
          fullName: r.full_name,
          email: r.email,
          phone: r.phone,
          locale: r.locale,
          isActive: r.is_active,
          lastLoginAt: r.last_login_at,
          // Блокировка живёт по времени: истёкшую не показываем как действующую,
          // иначе администратор снимает замок, которого уже нет.
          lockedUntil: r.locked_until && r.locked_until > new Date() ? r.locked_until : null,
          failedLoginCount: r.failed_login_count,
          createdAt: r.created_at,
          // Привязка Telegram (ТЗ 11.2): подключён или нет, когда и ждёт ли код.
          // Сам `telegram_user_id` — строкой: BigInt не переживёт JSON.
          telegram: {
            linked: r.telegram_user_id !== null,
            userId: r.telegram_user_id === null ? null : String(r.telegram_user_id),
            linkedAt: r.telegram_linked_at,
            codeExpiresAt: r.code_expires_at,
            // Привязка есть, а писать нечем: человек закрыл бота или не нажимал
            // «Старт». Telegram такое сообщение отбивает, и администратор должен
            // это видеть — иначе уведомления «уходят» в никуда.
            blocked: r.telegram_blocked,
            blockedAt: r.telegram_blocked_at,
          },
          assignments: byUser.get(r.uid) ?? [],
        })),
      };
    });
  }

  async create(input: UserInput) {
    const hash = await bcrypt.hash(input.password, ROUNDS);
    return this.withAdminScope(async (tx) => {
      const taken = await tx.$queryRaw<{ n: bigint }[]>`
        SELECT count(*)::bigint AS n FROM user_account WHERE login = ${input.login}`;
      if (Number(taken[0]!.n) > 0) {
        throw new ConflictException(say('Такой логин уже занят', 'Bunday login allaqachon band'));
      }

      // `must_change_password = true`: пароль новой учётке придумал
      // администратор, значит он известен ещё как минимум одному человеку и
      // прошёл через переписку. Первым делом человек обязан сменить его сам.
      const made = await tx.$queryRaw<{ id: bigint; uid: string }[]>`
        INSERT INTO user_account (uid, login, full_name, email, phone, password_hash, locale,
                                  must_change_password)
        VALUES (gen_random_uuid(), ${input.login}, ${input.fullName},
                ${input.email ?? null}, ${input.phone ?? null}, ${hash},
                ${input.locale ?? 'ru'}::"Locale", true)
        RETURNING id, uid`;
      const user = made[0]!;

      await this.replaceAssignments(tx, user.id, input.assignments);

      await writeAudit(tx, {
        companyId: this.auditCompany(),
        entityType: 'user',
        entityId: user.uid,
        action: 'create',
        changes: {
          login: { from: null, to: input.login },
          fullName: { from: null, to: input.fullName },
          roles: {
            from: null,
            to: input.assignments.map((a) => a.roleCode).join(', ') || 'без ролей',
          },
        },
      });

      return this.one(tx, user.uid);
    });
  }

  async update(uid: string, patch: UserPatch) {
    return this.withAdminScope(async (tx) => {
      const before = await this.row(tx, uid);

      if (patch.isActive === false) {
        await this.guardSelf(before.id, 'Выключить себя нельзя: вернуть доступ будет некому');
        await this.guardLastAdmin(tx, before.id);
      }

      await tx.$queryRaw`
        UPDATE user_account
           SET full_name = coalesce(${patch.fullName ?? null}, full_name),
               email = CASE WHEN ${patch.email === undefined}::boolean THEN email
                            ELSE ${patch.email ?? null} END,
               phone = CASE WHEN ${patch.phone === undefined}::boolean THEN phone
                            ELSE ${patch.phone ?? null} END,
               locale = coalesce(${patch.locale ?? null}::"Locale", locale),
               is_active = coalesce(${patch.isActive ?? null}::boolean, is_active),
               -- Включение снимает замок и счётчик неудачных попыток: иначе
               -- человек включён, а войти не может ещё четверть часа.
               locked_until = CASE WHEN ${patch.isActive === true}::boolean THEN NULL
                                   ELSE locked_until END,
               failed_login_count = CASE WHEN ${patch.isActive === true}::boolean THEN 0
                                         ELSE failed_login_count END
         WHERE uid = ${uid}::uuid`;

      const changes = diff(
        {
          fullName: before.full_name,
          email: before.email,
          phone: before.phone,
          locale: before.locale,
          isActive: before.is_active,
        },
        {
          fullName: patch.fullName,
          email: patch.email,
          phone: patch.phone,
          locale: patch.locale,
          isActive: patch.isActive,
        },
      );
      if (Object.keys(changes).length > 0) {
        await writeAudit(tx, {
          companyId: this.auditCompany(),
          entityType: 'user',
          entityId: uid,
          action: 'update',
          changes,
        });
      }

      return this.one(tx, uid);
    });
  }

  /** Снятие замка после неудачных попыток — не правка человека, а отдельное действие. */
  async unlock(uid: string) {
    return this.withAdminScope(async (tx) => {
      await this.row(tx, uid);
      await tx.$queryRaw`
        UPDATE user_account SET locked_until = NULL, failed_login_count = 0
         WHERE uid = ${uid}::uuid`;
      await writeAudit(tx, {
        companyId: this.auditCompany(),
        entityType: 'user',
        entityId: uid,
        action: 'unlock',
        changes: null,
      });
      return this.one(tx, uid);
    });
  }

  async setPassword(uid: string, password: string) {
    const hash = await bcrypt.hash(password, ROUNDS);
    return this.withAdminScope(async (tx) => {
      await this.row(tx, uid);
      // Признак поднимается и здесь: пароль, назначенный администратором, —
      // временный по определению, кем бы он ни был назначен и зачем.
      await tx.$queryRaw`
        UPDATE user_account
           SET password_hash = ${hash}, locked_until = NULL, failed_login_count = 0,
               must_change_password = true
         WHERE uid = ${uid}::uuid`;
      // В журнал — только факт. Пароль не пишется ни в каком виде: журнал
      // читают люди, у которых доступа к этой учётке быть не должно.
      await writeAudit(tx, {
        companyId: this.auditCompany(),
        entityType: 'user',
        entityId: uid,
        action: 'password_set',
        changes: null,
      });
      return { uid, passwordChanged: true };
    });
  }

  async setRoles(uid: string, assignments: AssignmentInput[]) {
    return this.withAdminScope(async (tx) => {
      const user = await this.row(tx, uid);
      const before = await this.roleCodes(tx, user.id);

      // Себя не разжалуют: администратор, снявший себе admin-роль, теряет сам
      // экран, на котором эту правку делал.
      if (!assignments.some((a) => a.roleCode === 'admin')) {
        if (before.includes('admin')) {
          await this.guardSelf(user.id, 'Снять роль администратора у себя нельзя');
          await this.guardLastAdmin(tx, user.id);
        }
      }

      await this.replaceAssignments(tx, user.id, assignments);

      const after = await this.roleCodes(tx, user.id);
      if (before.join(',') !== after.join(',')) {
        await writeAudit(tx, {
          companyId: this.auditCompany(),
          entityType: 'user',
          entityId: uid,
          action: 'roles_set',
          changes: { roles: { from: before.join(', '), to: after.join(', ') } },
        });
      }

      return this.one(tx, uid);
    });
  }

  // --- внутреннее -----------------------------------------------------------

  private async row(tx: Tx, uid: string) {
    const rows = await tx.$queryRaw<
      {
        id: bigint;
        full_name: string;
        email: string | null;
        phone: string | null;
        locale: string;
        is_active: boolean;
      }[]
    >`
      SELECT id, full_name, email, phone, locale::text AS locale, is_active
        FROM user_account WHERE uid = ${uid}::uuid`;
    const row = rows[0];
    if (!row) throw new NotFoundException(say('Учётная запись не найдена', 'Hisob topilmadi'));
    return row;
  }

  private async one(tx: Tx, uid: string) {
    const rows = await tx.$queryRaw<Record<string, unknown>[]>`
      SELECT u.uid, u.login, u.full_name AS "fullName", u.email, u.phone,
             u.locale::text AS locale, u.is_active AS "isActive",
             u.last_login_at AS "lastLoginAt", u.created_at AS "createdAt"
        FROM user_account u WHERE u.uid = ${uid}::uuid`;
    const assignments = await tx.$queryRaw<Record<string, unknown>[]>`
      SELECT r.code AS "roleCode", c.uid AS "companyUid", c.code AS "companyCode",
             a.scope::text AS scope
        FROM user_role_assignment a
        JOIN "role" r  ON r.id = a.role_id
        JOIN company c ON c.id = a.company_id
       WHERE a.user_id = (SELECT id FROM user_account WHERE uid = ${uid}::uuid)
       ORDER BY c.code, r.code`;
    return { ...rows[0]!, assignments };
  }

  private async roleCodes(tx: Tx, userId: bigint): Promise<string[]> {
    const rows = await tx.$queryRaw<{ code: string; company: string }[]>`
      SELECT r.code, c.code AS company
        FROM user_role_assignment a
        JOIN "role" r  ON r.id = a.role_id
        JOIN company c ON c.id = a.company_id
       WHERE a.user_id = ${userId}
       ORDER BY c.code, r.code`;
    return rows.map((r) => `${r.code}@${r.company}`);
  }

  private async guardSelf(userId: bigint, message: string) {
    if (currentContext()?.userId === userId) {
      throw new UnprocessableEntityException(message);
    }
  }

  /**
   * Последний действующий администратор.
   *
   * Считаем по назначениям роли `admin` среди активных учётных записей. Если
   * этот человек — единственный, правку отклоняем: без администратора систему
   * нельзя ни настроить, ни починить изнутри.
   */
  private async guardLastAdmin(tx: Tx, userId: bigint) {
    const rows = await tx.$queryRaw<{ n: bigint }[]>`
      SELECT count(DISTINCT u.id)::bigint AS n
        FROM user_account u
        JOIN user_role_assignment a ON a.user_id = u.id
        JOIN "role" r ON r.id = a.role_id
       WHERE u.is_active AND r.code = 'admin' AND u.id <> ${userId}`;
    const isAdmin = await tx.$queryRaw<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n
        FROM user_role_assignment a
        JOIN "role" r ON r.id = a.role_id
       WHERE a.user_id = ${userId} AND r.code = 'admin'`;
    if (Number(isAdmin[0]!.n) > 0 && Number(rows[0]!.n) === 0) {
      throw new UnprocessableEntityException(say('Это последний действующий администратор: сначала назначьте другого', 'Bu oxirgi amaldagi administrator: avval boshqasini tayinlang'));
    }
  }

  /**
   * Назначения заменяются списком целиком, а не по одному.
   *
   * Правка по одному назначению заставляла бы экран угадывать, что именно
   * изменилось, и расходилась бы с ним при двух открытых вкладках: прислали
   * набор — он и стоит.
   */
  private async replaceAssignments(tx: Tx, userId: bigint, assignments: AssignmentInput[]) {
    const seen = new Set<string>();
    const resolved: {
      roleId: bigint;
      companyId: bigint;
      departmentId: bigint | null;
      warehouseId: bigint | null;
      scope: string;
    }[] = [];

    for (const a of assignments) {
      const company = await tx.$queryRaw<{ id: bigint }[]>`
        SELECT id FROM company WHERE uid = ${a.companyUid}::uuid`;
      const companyId = company[0]?.id;
      if (companyId === undefined) throw new NotFoundException(MSG.companyNotFound());

      // Роль берём либо системную (company_id IS NULL), либо свою этой же
      // компании: роль соседней компании здесь не назначить.
      const role = await tx.$queryRaw<{ id: bigint }[]>`
        SELECT id FROM "role"
         WHERE code = ${a.roleCode} AND (company_id IS NULL OR company_id = ${companyId})
         ORDER BY company_id NULLS LAST
         LIMIT 1`;
      const roleId = role[0]?.id;
      if (roleId === undefined) throw new NotFoundException(say(`Роль ${a.roleCode} не найдена`, `${a.roleCode} roli topilmadi`));

      const key = `${roleId}:${companyId}`;
      if (seen.has(key)) {
        throw new UnprocessableEntityException(say('Одна роль в одной компании назначена дважды', 'Bitta rol bitta kompaniyada ikki marta berilgan'));
      }
      seen.add(key);

      let departmentId: bigint | null = null;
      if (a.departmentUid) {
        const d = await tx.$queryRaw<{ id: bigint }[]>`
          SELECT id FROM department WHERE uid = ${a.departmentUid}::uuid AND company_id = ${companyId}`;
        departmentId = d[0]?.id ?? null;
        if (departmentId === null) throw new NotFoundException(MSG.departmentNotFound());
      }
      let warehouseId: bigint | null = null;
      if (a.warehouseUid) {
        const w = await tx.$queryRaw<{ id: bigint }[]>`
          SELECT id FROM warehouse WHERE uid = ${a.warehouseUid}::uuid AND company_id = ${companyId}`;
        warehouseId = w[0]?.id ?? null;
        if (warehouseId === null) throw new NotFoundException(MSG.warehouseNotFound());
      }

      resolved.push({
        roleId,
        companyId,
        departmentId,
        warehouseId,
        scope: a.scope ?? 'all',
      });
    }

    await tx.$queryRaw`DELETE FROM user_role_assignment WHERE user_id = ${userId}`;
    for (const r of resolved) {
      await tx.$queryRaw`
        INSERT INTO user_role_assignment (user_id, role_id, company_id, department_id,
                                          warehouse_id, scope)
        VALUES (${userId}, ${r.roleId}, ${r.companyId}, ${r.departmentId}, ${r.warehouseId},
                ${r.scope}::"RoleScope")`;
    }
  }
}
