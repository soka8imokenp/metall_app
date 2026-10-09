import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { currentContext } from '../common/request-context.js';
import { resolveOwner } from './crm-owner.js';
import { ActivitiesService } from './activities.service.js';
import { MSG } from '../common/messages.js';
import { say } from '../common/say.js';

const TZ = 'Asia/Tashkent';

/** Начало сегодняшнего дня по Ташкенту как граница по timestamptz. */
const DAY_START = `(date_trunc('day', now() AT TIME ZONE '${TZ}') AT TIME ZONE '${TZ}')`;

/**
 * Задачи CRM (ТЗ 8.4).
 *
 * Тип, срок, ответственный, связь с клиентом или сделкой, результат.
 *
 * Три правила, ради которых эта служба существует:
 *
 * - **Закрытие требует результата.** Галочка без единого слова не говорит,
 *   дозвонились ли и о чём договорились, — через неделю работа делается
 *   заново. Правило то же, что у отказа по обращению и проигрыша по сделке, и
 *   держит его ещё и база.
 * - **Закрытая задача становится активностью.** Менеджер не пишет одно и то же
 *   дважды: закрыл «позвонить Ахмедову» с результатом — звонок сам лёг в ленту
 *   клиента, откуда его увидит карточка.
 * - **Закрытую задачу не правят.** Она история: срок и ответственный в ней
 *   говорят, как было, а не как удобно сейчас.
 *
 * Чего здесь нет: уведомления ответственному и руководителю о просрочке
 * (ТЗ 8.4 `[С]`). Просроченное видно на экране и считается в `counts`, а рассылка
 * упирается в общий тракт уведомлений — он не в этом модуле.
 */
@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activities: ActivitiesService,
  ) {}

  async list(params: {
    scope?: string;
    assigneeUid?: string;
    partnerUid?: string;
    dealUid?: string;
    typeUid?: string;
    limit?: number;
    offset?: number;
  }) {
    const limit = params.limit ?? 50;
    const offset = params.offset ?? 0;
    const scope = params.scope ?? 'open';

    return this.prisma.withTenant(async (tx) => {
      const filters = `WHERE ($1::uuid IS NULL OR a.uid = $1::uuid)
                         AND ($2::uuid IS NULL OR p.uid = $2::uuid)
                         AND ($3::uuid IS NULL OR d.uid = $3::uuid)
                         AND ($4::uuid IS NULL OR tt.uid = $4::uuid)`;
      const args = [
        params.assigneeUid ?? null,
        params.partnerUid ?? null,
        params.dealUid ?? null,
        params.typeUid ?? null,
      ];

      const rows = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
        `${TASK_SELECT} ${filters} AND ${scopeSql(scope)}
          ORDER BY (t.status = 'open') DESC, t.due_at ASC, t.id ASC
          LIMIT $5 OFFSET $6`,
        ...args,
        limit,
        offset,
      );

      // Счётчики считаются по тем же фильтрам, но без выбранной вкладки:
      // иначе «Просрочено 7» пропадало бы, как только открыли «Сделанные».
      const counts = await tx.$queryRawUnsafe<Record<string, bigint>[]>(
        `SELECT
           count(*) FILTER (WHERE ${scopeSql('overdue')}) AS overdue,
           count(*) FILTER (WHERE ${scopeSql('today')})   AS today,
           count(*) FILTER (WHERE ${scopeSql('week')})    AS week,
           count(*) FILTER (WHERE ${scopeSql('open')})    AS open,
           count(*) FILTER (WHERE ${scopeSql('closed')})  AS closed,
           count(*)                                       AS all
           FROM crm_task t
           JOIN crm_task_type tt ON tt.id = t.type_id
           LEFT JOIN user_account a ON a.id = t.assignee_id
           LEFT JOIN partner p ON p.id = t.partner_id
           LEFT JOIN deal d ON d.id = t.deal_id
           ${filters}`,
        ...args,
      );
      const c = counts[0] ?? {};
      const num = (k: string) => Number(c[k] ?? 0);

      return {
        rows: rows.map(taskView),
        total: num(scope === 'all' ? 'all' : scope),
        counts: {
          overdue: num('overdue'),
          today: num('today'),
          week: num('week'),
          open: num('open'),
          closed: num('closed'),
          all: num('all'),
        },
        scope,
        limit,
        offset,
      };
    });
  }

  async one(uid: string) {
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
        `${TASK_SELECT} WHERE t.uid = $1::uuid`,
        uid,
      );
      if (!rows[0]) throw new NotFoundException(say('Задача не найдена', 'Vazifa topilmadi'));
      return taskView(rows[0]);
    });
  }

  async create(input: TaskInput) {
    const uid = await this.prisma.withTenant(async (tx) => {
      const owner = await resolveOwner(tx, input);
      const dueAt = this.parseDue(input.dueAt);
      const assigneeId = input.assigneeUid
        ? await this.userIdByUid(tx, input.assigneeUid)
        : await this.currentUserId(tx);
      if (assigneeId === null) {
        throw new UnprocessableEntityException(say(
          'Укажите ответственного: задача без него не попадёт ни в чей список', 'Mas’ulni ko‘rsating: usiz vazifa birorta ro‘yxatga tushmaydi'));
      }
      const authorId = await this.currentUserId(tx);

      const rows = await tx.$queryRawUnsafe<{ uid: string }[]>(
        `INSERT INTO crm_task (uid, company_id, type_id, title, description, due_at,
                               assignee_id, partner_id, deal_id, created_by)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING uid`,
        owner.companyId,
        await this.taskTypeId(tx, owner.companyId, input.typeUid),
        input.title.trim(),
        input.description?.trim() ?? null,
        dueAt,
        assigneeId,
        owner.partnerId,
        owner.dealId,
        authorId,
      );
      return rows[0]!.uid;
    });
    return this.one(uid);
  }

  async update(uid: string, input: TaskPatch) {
    await this.prisma.withTenant(async (tx) => {
      const task = await this.task(tx, uid);
      this.checkVersion(task.version, input.version);
      this.requireOpen(task);

      const assigneeId =
        input.assigneeUid === undefined ? null : await this.userIdByUid(tx, input.assigneeUid);
      const dueAt = input.dueAt === undefined ? null : this.parseDue(input.dueAt);

      await tx.$queryRawUnsafe(
        `UPDATE crm_task SET
           type_id = COALESCE($2, type_id),
           title = COALESCE($3, title),
           description = COALESCE($4, description),
           due_at = COALESCE($5, due_at),
           assignee_id = COALESCE($6, assignee_id),
           version = version + 1
         WHERE id = $1`,
        task.id,
        input.typeUid === undefined
          ? null
          : await this.taskTypeId(tx, task.company_id, input.typeUid),
        input.title?.trim() ?? null,
        input.description?.trim() ?? null,
        dueAt,
        assigneeId,
      );
    });
    return this.one(uid);
  }

  /**
   * Закрытие задачи: результат обязателен, и из него рождается активность.
   *
   * Обе записи одной транзакцией. Оборвись это посередине — задача выглядела бы
   * сделанной, а в ленте клиента звонка бы не было.
   */
  async complete(uid: string, input: CloseInput) {
    await this.prisma.withTenant(async (tx) => {
      const task = await this.task(tx, uid);
      this.checkVersion(task.version, input.version);
      this.requireOpen(task);
      const result = input.result?.trim() ?? '';
      if (!result) {
        throw new UnprocessableEntityException(say(
          'Напишите результат: закрытая задача без него не говорит, чем кончилось', 'Natijani yozing: usiz yopilgan vazifa nima bilan tugaganini aytmaydi'));
      }

      await tx.$queryRawUnsafe(
        `UPDATE crm_task
            SET status = 'done'::"CrmTaskStatus", result = $2, closed_at = now(),
                version = version + 1
          WHERE id = $1`,
        task.id,
        result,
      );

      await this.activities.insert(tx, {
        companyId: task.company_id,
        partnerId: task.partner_id,
        dealId: task.deal_id,
        type: task.activity_kind,
        subject: task.title,
        note: result,
        at: new Date(),
        direction: null,
        durationSec: null,
        taskId: task.id,
        userId: await this.currentUserId(tx),
      });
    });
    return this.one(uid);
  }

  /** Отмена: причина обязательна так же, как результат. Активности не рождает — ничего не было. */
  async cancel(uid: string, input: CloseInput) {
    await this.prisma.withTenant(async (tx) => {
      const task = await this.task(tx, uid);
      this.checkVersion(task.version, input.version);
      this.requireOpen(task);
      const reason = input.result?.trim() ?? '';
      if (!reason) {
        throw new UnprocessableEntityException(say(
          'Напишите причину отмены: иначе в истории остаётся задача, пропавшая без объяснения', 'Bekor qilish sababini yozing: aks holda tarixda izohsiz yo‘qolgan vazifa qoladi'));
      }
      await tx.$queryRawUnsafe(
        `UPDATE crm_task
            SET status = 'cancelled'::"CrmTaskStatus", result = $2, closed_at = now(),
                version = version + 1
          WHERE id = $1`,
        task.id,
        reason,
      );
    });
    return this.one(uid);
  }

  private parseDue(value: string): Date {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) throw new UnprocessableEntityException(say('Неверный срок', 'Muddat noto‘g‘ri'));
    return d;
  }

  private async task(tx: Tx, uid: string) {
    const rows = await tx.$queryRaw<
      {
        id: bigint;
        company_id: bigint;
        partner_id: bigint | null;
        deal_id: bigint | null;
        activity_kind: string;
        title: string;
        status: string;
        version: number;
      }[]
    >`SELECT t.id, t.company_id, t.partner_id, t.deal_id,
             tt.activity_kind::text AS activity_kind, t.title,
             t.status::text AS status, t.version
        FROM crm_task t
        JOIN crm_task_type tt ON tt.id = t.type_id
       WHERE t.uid = ${uid}::uuid`;
    if (!rows[0]) throw new NotFoundException(say('Задача не найдена', 'Vazifa topilmadi'));
    return rows[0];
  }

  /**
   * Тип задачи — строка справочника своей компании (ТЗ 8.4).
   *
   * Выключенный тип не ставится: выключение затем и делают, чтобы им
   * перестали пользоваться, а уже заведённые задачи его сохраняют.
   */
  private async taskTypeId(tx: Tx, companyId: bigint, uid: string): Promise<bigint> {
    const rows = await tx.$queryRawUnsafe<{ id: bigint; company_id: bigint; is_active: boolean }[]>(
      `SELECT id, company_id, is_active FROM crm_task_type WHERE uid = $1::uuid`,
      uid,
    );
    const row = rows[0];
    if (!row) throw new NotFoundException(MSG.taskTypeNotFound());
    if (row.company_id !== companyId) {
      throw new UnprocessableEntityException(say('Тип задачи заведён в другой компании', 'Vazifa turi boshqa kompaniyada kiritilgan'));
    }
    if (!row.is_active) {
      throw new UnprocessableEntityException(say('Тип задачи выключен: выберите действующий', 'Vazifa turi o‘chirilgan: amaldagisini tanlang'));
    }
    return row.id;
  }

  private requireOpen(task: { status: string }) {
    if (task.status !== 'open') {
      throw new UnprocessableEntityException(say(
        task.status === 'done'
          ? 'Задача уже закрыта: закрытая задача — история, её не правят и не закрывают дважды'
          : 'Задача отменена: заведите новую, а не воскрешайте отменённую', task.status === 'done' ? 'Vazifa allaqachon yopilgan: yopilgan vazifa — tarix, u tahrirlanmaydi va ikki marta yopilmaydi' : 'Vazifa bekor qilingan: bekor qilinganini tiriltirmay, yangisini kiriting'));
    }
  }

  private checkVersion(current: number, sent: number | undefined) {
    if (sent === undefined) {
      throw new UnprocessableEntityException(say(
        'Не указана версия задачи: без неё правка затёрла бы чужую', 'Vazifa versiyasi ko‘rsatilmagan: usiz tahrir boshqaning ishini o‘chirib yuborardi'));
    }
    if (sent !== current) {
      throw new ConflictException({
        message: say('Задачу уже изменили: обновите список и повторите', 'Vazifa allaqachon o‘zgargan: ro‘yxatni yangilab, qaytadan urinib ko‘ring'),
        details: { version: current },
      });
    }
  }

  private async userIdByUid(tx: Tx, uid: string): Promise<bigint> {
    const rows = await tx.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM user_account WHERE uid = ${uid}::uuid`;
    if (!rows[0]) throw new NotFoundException(say('Сотрудник не найден', 'Xodim topilmadi'));
    return rows[0].id;
  }

  private async currentUserId(tx: Tx): Promise<bigint | null> {
    const id = currentContext()?.userId;
    if (id === undefined || id === null) return null;
    const rows = await tx.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM user_account WHERE id = ${id}`;
    return rows[0]?.id ?? null;
  }
}

/**
 * Вкладки списка.
 *
 * «Сегодня» и «Неделя» — про срок, который ещё не прошёл: просроченное живёт в
 * своей вкладке и не растворяется среди сегодняшнего. Границы дня считаются по
 * Ташкенту, а не по таймзоне процесса: с UTC задача со сроком в 9 утра
 * оказывалась бы «вчерашней» весь рабочий день.
 */
function scopeSql(scope: string): string {
  switch (scope) {
    case 'overdue':
      return `(t.status = 'open' AND t.due_at < now())`;
    case 'today':
      return `(t.status = 'open' AND t.due_at >= now() AND t.due_at < ${DAY_START} + interval '1 day')`;
    case 'week':
      return `(t.status = 'open' AND t.due_at >= now() AND t.due_at < ${DAY_START} + interval '7 days')`;
    case 'closed':
      return `(t.status <> 'open')`;
    case 'all':
      return `true`;
    case 'open':
    default:
      return `(t.status = 'open')`;
  }
}

const TASK_SELECT = `
  SELECT t.uid, tt.uid AS type_uid, tt.code AS type_code,
         tt.name_ru AS type_name_ru, tt.name_uz AS type_name_uz,
         t.title, t.description, t.due_at, t.status::text AS status,
         t.result, t.version, t.created_at, t.closed_at,
         (t.status = 'open' AND t.due_at < now()) AS is_overdue,
         co.uid AS company_uid, co.code AS company_code,
         a.uid AS assignee_uid, a.full_name AS assignee_name,
         au.uid AS author_uid, au.full_name AS author_name,
         p.uid AS partner_uid, app_loc(p.name_ru, p.name_uz) AS partner_name,
         d.uid AS deal_uid, d.number AS deal_number, d.title AS deal_title
    FROM crm_task t
    JOIN company co ON co.id = t.company_id
    JOIN crm_task_type tt ON tt.id = t.type_id
    LEFT JOIN user_account a ON a.id = t.assignee_id
    LEFT JOIN user_account au ON au.id = t.created_by
    LEFT JOIN partner p ON p.id = t.partner_id
    LEFT JOIN deal d ON d.id = t.deal_id`;

export const taskView = (r: Record<string, any>) => ({
  uid: r.uid,
  type: {
    uid: r.type_uid,
    code: r.type_code,
    nameRu: r.type_name_ru,
    nameUz: r.type_name_uz,
  },
  title: r.title,
  description: r.description,
  dueAt: r.due_at,
  status: r.status as 'open' | 'done' | 'cancelled',
  isOverdue: r.is_overdue === true,
  result: r.result,
  version: Number(r.version),
  company: { uid: r.company_uid, code: r.company_code },
  assignee: r.assignee_uid ? { uid: r.assignee_uid, name: r.assignee_name } : null,
  author: r.author_uid ? { uid: r.author_uid, name: r.author_name } : null,
  partner: r.partner_uid ? { uid: r.partner_uid, name: r.partner_name } : null,
  deal: r.deal_uid ? { uid: r.deal_uid, number: r.deal_number, title: r.deal_title } : null,
  createdAt: r.created_at,
  closedAt: r.closed_at,
});

export type TaskInput = {
  typeUid: string;
  title: string;
  description?: string;
  dueAt: string;
  assigneeUid?: string;
  partnerUid?: string;
  dealUid?: string;
};

export type TaskPatch = {
  typeUid?: string;
  title?: string;
  description?: string;
  dueAt?: string;
  assigneeUid?: string;
  version?: number;
};

export type CloseInput = {
  result?: string;
  version?: number;
};
