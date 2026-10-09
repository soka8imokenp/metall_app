import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { currentContext } from '../common/request-context.js';
import { writeAudit } from '../common/audit.js';
import { MSG } from '../common/messages.js';
import { say } from '../common/say.js';

/**
 * Бюджеты на запись (ТЗ 6.6).
 *
 * План-факт читался с первого дня, а завести бюджет было нечем: ни маршрута,
 * ни формы — строки появлялись только посевом. То есть отчёт показывал план,
 * которого в системе никто не задавал.
 *
 * Два правила, которые здесь держатся кодом, а не договорённостью.
 *
 * **Период — месяц или квартал, и его считает сервер.** На входе `2026-10` или
 * `2026-Q4`, а не произвольные даты: бюджет «с 7 числа по 19-е» не сходится ни
 * с отчётом, ни с тем, как планируют деньги. Даты границ вычисляются здесь —
 * иначе каждый экран посчитал бы конец месяца по-своему.
 *
 * **Один бюджет на компанию, подразделение, статью и период.** Два плана на
 * одну статью в одном месяце — это две разные правды, и план-факт сложит их в
 * сумму, которую никто не утверждал. Дубль отклоняется, и это же держит
 * уникальный индекс в базе.
 */
@Injectable()
export class BudgetsService {
  constructor(private readonly prisma: PrismaService) {}

  private async resolveCompany(tx: Tx, companyUid: string | undefined): Promise<bigint> {
    const ids = currentContext()?.companyIds ?? [];
    if (ids.length === 0) throw new UnprocessableEntityException(MSG.noCompany());
    if (!companyUid) {
      if (ids.length > 1) {
        throw new UnprocessableEntityException(say('Выбраны обе компании: укажите, чей бюджет пишем', 'Ikkala kompaniya tanlangan: kimning budjeti yozilishini ko‘rsating'));
      }
      return ids[0]!;
    }
    const rows = await tx.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM company WHERE uid = ${companyUid}::uuid`;
    const id = rows[0]?.id;
    if (id === undefined || !ids.includes(id)) throw new NotFoundException(MSG.companyNotFound());
    return id;
  }

  /**
   * Границы периода из короткой записи: `2026-10` — месяц, `2026-Q4` — квартал.
   * Возвращает дни, а не отметки времени: бюджет живёт датами.
   */
  private period(raw: string): { start: Date; end: Date; label: string } {
    const s = String(raw ?? '').trim().toUpperCase();
    const month = s.match(/^(\d{4})-(\d{2})$/);
    if (month) {
      const y = Number(month[1]);
      const m = Number(month[2]);
      if (m < 1 || m > 12) throw new UnprocessableEntityException(say('Месяц от 01 до 12', 'Oy 01 dan 12 gacha'));
      return {
        start: new Date(Date.UTC(y, m - 1, 1)),
        end: new Date(Date.UTC(y, m, 0)),
        label: `${month[1]}-${month[2]}`,
      };
    }
    const quarter = s.match(/^(\d{4})-Q([1-4])$/);
    if (quarter) {
      const y = Number(quarter[1]);
      const q = Number(quarter[2]);
      return {
        start: new Date(Date.UTC(y, (q - 1) * 3, 1)),
        end: new Date(Date.UTC(y, q * 3, 0)),
        label: `${quarter[1]}-Q${q}`,
      };
    }
    throw new UnprocessableEntityException(say('Период: месяц «2026-10» или квартал «2026-Q4». Произвольные даты бюджет не принимает', 'Davr: «2026-10» oyi yoki «2026-Q4» choragi. Budjet erkin sanalarni qabul qilmaydi'));
  }

  /** Обратно: по границам — короткая запись, чтобы экран показывал то же, что приняли. */
  static periodLabel(start: Date, end: Date): string {
    const y = start.getUTCFullYear();
    const m = start.getUTCMonth();
    const lastOfMonth = new Date(Date.UTC(y, m + 1, 0));
    if (start.getUTCDate() === 1 && end.getTime() === lastOfMonth.getTime()) {
      return `${y}-${String(m + 1).padStart(2, '0')}`;
    }
    const lastOfQuarter = new Date(Date.UTC(y, Math.floor(m / 3) * 3 + 3, 0));
    if (start.getUTCDate() === 1 && m % 3 === 0 && end.getTime() === lastOfQuarter.getTime()) {
      return `${y}-Q${Math.floor(m / 3) + 1}`;
    }
    // Бюджет из прежних данных мог стоять произвольными днями: показываем как есть.
    return `${start.toISOString().slice(0, 10)}…${end.toISOString().slice(0, 10)}`;
  }

  private money(raw: unknown): number {
    const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').replace(',', '.'));
    if (!Number.isFinite(n)) throw new UnprocessableEntityException(say('Сумма плана не число', 'Reja summasi son emas'));
    if (n <= 0) throw new UnprocessableEntityException(say('Сумма плана должна быть больше нуля', 'Reja summasi noldan katta bo‘lishi kerak'));
    if (n > 1e18) throw new UnprocessableEntityException(say('Сумма плана слишком велика', 'Reja summasi juda katta'));
    return Math.round(n * 1e4) / 1e4;
  }

  private percent(raw: unknown): number {
    const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').replace(',', '.'));
    if (!Number.isFinite(n)) throw new UnprocessableEntityException(say('Порог не число', 'Chegara son emas'));
    if (n < 1 || n > 100) {
      throw new UnprocessableEntityException(say('Порог предупреждения — от 1 до 100 %: сам план и есть 100 %', 'Ogohlantirish chegarasi — 1 dan 100 % gacha: rejaning o‘zi 100 %'));
    }
    return Math.round(n * 1e4) / 1e4;
  }

  /** Справочники формы бюджета: статьи расхода, подразделения, ответственные. */
  async refs() {
    return this.prisma.withTenant(async (tx) => {
      const [items, departments, people] = await Promise.all([
        tx.$queryRaw<
          { company_uid: string; uid: string; name_ru: string; name_uz: string; direction: string }[]
        >`
          SELECT co.uid AS company_uid, i.uid, i.name_ru, i.name_uz,
                 i.direction::text AS direction
            FROM cashflow_item i
            JOIN company co ON co.id = i.company_id
           ORDER BY co.code, i.direction, i.name_ru`,
        tx.$queryRaw<{ company_uid: string; uid: string; name_ru: string; name_uz: string }[]>`
          SELECT co.uid AS company_uid, d.uid, d.name_ru, d.name_uz
            FROM department d
            JOIN company co ON co.id = d.company_id
           ORDER BY co.code, d.name_ru`,
        tx.$queryRaw<{ company_uid: string; uid: string; full_name: string }[]>`
          SELECT DISTINCT co.uid AS company_uid, u.uid, u.full_name
            FROM user_account u
            JOIN user_role_assignment ra ON ra.user_id = u.id
            JOIN company co ON co.id = ra.company_id
           WHERE u.is_active
           ORDER BY co.uid, u.full_name`,
      ]);
      return {
        items: items.map((i) => ({
          companyUid: i.company_uid,
          uid: i.uid,
          nameRu: i.name_ru,
          nameUz: i.name_uz,
          direction: i.direction,
        })),
        departments: departments.map((d) => ({
          companyUid: d.company_uid,
          uid: d.uid,
          nameRu: d.name_ru,
          nameUz: d.name_uz,
        })),
        people: people.map((p) => ({
          companyUid: p.company_uid,
          uid: p.uid,
          fullName: p.full_name,
        })),
      };
    });
  }

  async create(input: {
    companyUid?: string;
    departmentUid?: string;
    itemUid: string;
    period: string;
    amountPlanned: unknown;
    thresholdWarnPercent?: unknown;
    responsibleUid?: string;
  }) {
    return this.prisma.withTenant(async (tx) => {
      const companyId = await this.resolveCompany(tx, input.companyUid);
      const period = this.period(input.period);
      const amount = this.money(input.amountPlanned);
      const threshold =
        input.thresholdWarnPercent === undefined ? 80 : this.percent(input.thresholdWarnPercent);

      const item = await tx.$queryRaw<{ id: bigint; name: string; direction: string }[]>`
        SELECT id, app_loc(name_ru, name_uz) AS name, direction::text AS direction FROM cashflow_item
         WHERE company_id = ${companyId} AND uid = ${input.itemUid}::uuid`;
      if (!item[0]) throw new UnprocessableEntityException(say('Статья движения не найдена', 'Harakat moddasi topilmadi'));

      const departmentId = input.departmentUid
        ? await this.departmentId(tx, companyId, input.departmentUid)
        : null;
      const responsibleId = input.responsibleUid
        ? await this.personId(tx, companyId, input.responsibleUid)
        : null;

      const dup = await tx.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM budget
         WHERE company_id = ${companyId} AND cashflow_item_id = ${item[0].id}
           AND period_start = ${period.start} AND period_end = ${period.end}
           AND department_id IS NOT DISTINCT FROM ${departmentId}`;
      if (Number(dup[0]?.n ?? 0) > 0) {
        throw new UnprocessableEntityException(say(`Бюджет по статье «${item[0].name}» на ${period.label} уже задан: ` +
            `поправьте существующий, а не заводите второй`, `«${item[0].name}» moddasi bo‘yicha ${period.label} uchun budjet allaqachon berilgan: ` + `ikkinchisini kiritmay, borini to‘g‘rilang`));
      }

      const created = await tx.$queryRaw<{ uid: string }[]>`
        INSERT INTO budget (uid, company_id, department_id, cashflow_item_id, period_start,
                            period_end, amount_planned, threshold_warn_percent, responsible_id)
        VALUES (gen_random_uuid(), ${companyId}, ${departmentId}, ${item[0].id}, ${period.start},
                ${period.end}, ${amount}, ${threshold}, ${responsibleId})
        RETURNING uid`;

      await writeAudit(tx, {
        companyId,
        entityType: 'budget',
        entityId: created[0]!.uid,
        action: 'create',
        changes: {
          item: { from: null, to: item[0].name },
          period: { from: null, to: period.label },
          amountPlanned: { from: null, to: amount },
          thresholdWarnPercent: { from: null, to: threshold },
        },
      });
      return { uid: created[0]!.uid, period: period.label, amountPlanned: amount };
    });
  }

  async update(
    uid: string,
    input: {
      amountPlanned?: unknown;
      thresholdWarnPercent?: unknown;
      responsibleUid?: string | null;
      departmentUid?: string | null;
    },
  ) {
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.$queryRaw<
        {
          id: bigint;
          company_id: bigint;
          amount_planned: unknown;
          threshold_warn_percent: unknown;
          responsible_id: bigint | null;
          department_id: bigint | null;
          item_name: string;
        }[]
      >`
        SELECT b.id, b.company_id, b.amount_planned, b.threshold_warn_percent,
               b.responsible_id, b.department_id, app_loc(c.name_ru, c.name_uz) AS item_name
          FROM budget b JOIN cashflow_item c ON c.id = b.cashflow_item_id
         WHERE b.uid = ${uid}::uuid`;
      const row = rows[0];
      if (!row) throw new NotFoundException(say('Бюджет не найден', 'Budjet topilmadi'));

      // Статью и период не меняем: это другой бюджет, а не правка этого.
      // Иначе факт, уже посчитанный по прежней статье, молча переехал бы на
      // новую, и отклонение стало бы неразбираемым.
      const amount =
        input.amountPlanned === undefined
          ? Number(row.amount_planned)
          : this.money(input.amountPlanned);
      const threshold =
        input.thresholdWarnPercent === undefined
          ? Number(row.threshold_warn_percent)
          : this.percent(input.thresholdWarnPercent);
      const responsibleId =
        input.responsibleUid === undefined
          ? row.responsible_id
          : input.responsibleUid === null
            ? null
            : await this.personId(tx, row.company_id, input.responsibleUid);
      const departmentId =
        input.departmentUid === undefined
          ? row.department_id
          : input.departmentUid === null
            ? null
            : await this.departmentId(tx, row.company_id, input.departmentUid);

      await tx.$executeRaw`
        UPDATE budget
           SET amount_planned = ${amount}, threshold_warn_percent = ${threshold},
               responsible_id = ${responsibleId}, department_id = ${departmentId}
         WHERE id = ${row.id}`;

      await writeAudit(tx, {
        companyId: row.company_id,
        entityType: 'budget',
        entityId: uid,
        action: 'update',
        changes: {
          ...(amount !== Number(row.amount_planned)
            ? { amountPlanned: { from: Number(row.amount_planned), to: amount } }
            : {}),
          ...(threshold !== Number(row.threshold_warn_percent)
            ? {
                thresholdWarnPercent: {
                  from: Number(row.threshold_warn_percent),
                  to: threshold,
                },
              }
            : {}),
        },
      });
      return { uid, amountPlanned: amount, thresholdWarnPercent: threshold };
    });
  }

  /**
   * Удаление бюджета. Факт при этом не теряется: он живёт в проведённых
   * операциях, а бюджет — это только план. Поэтому запрета нет, но запись в
   * журнал остаётся: план, по которому спрашивали, не должен исчезать молча.
   */
  async remove(uid: string) {
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.$queryRaw<
        { id: bigint; company_id: bigint; amount_planned: unknown; item_name: string }[]
      >`
        SELECT b.id, b.company_id, b.amount_planned, app_loc(c.name_ru, c.name_uz) AS item_name
          FROM budget b JOIN cashflow_item c ON c.id = b.cashflow_item_id
         WHERE b.uid = ${uid}::uuid`;
      const row = rows[0];
      if (!row) throw new NotFoundException(say('Бюджет не найден', 'Budjet topilmadi'));
      await tx.$executeRaw`DELETE FROM budget WHERE id = ${row.id}`;
      await writeAudit(tx, {
        companyId: row.company_id,
        entityType: 'budget',
        entityId: uid,
        action: 'delete',
        changes: {
          item: { from: row.item_name, to: null },
          amountPlanned: { from: Number(row.amount_planned), to: null },
        },
      });
      return { uid, deleted: true };
    });
  }

  private async departmentId(tx: Tx, companyId: bigint, uid: string): Promise<bigint> {
    const rows = await tx.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM department WHERE company_id = ${companyId} AND uid = ${uid}::uuid`;
    if (!rows[0]) throw new UnprocessableEntityException(MSG.departmentNotFound());
    return rows[0].id;
  }

  private async personId(tx: Tx, companyId: bigint, uid: string): Promise<bigint> {
    const rows = await tx.$queryRaw<{ id: bigint }[]>`
      SELECT u.id
        FROM user_account u
        JOIN user_role_assignment ra ON ra.user_id = u.id AND ra.company_id = ${companyId}
       WHERE u.uid = ${uid}::uuid AND u.is_active
       LIMIT 1`;
    if (!rows[0]) {
      throw new UnprocessableEntityException(say('Ответственный не найден среди людей этой компании', 'Mas’ul bu kompaniya xodimlari orasida topilmadi'));
    }
    return rows[0].id;
  }
}
