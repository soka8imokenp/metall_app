import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { currentContext } from '../common/request-context.js';
import { resolveOwner } from './crm-owner.js';
import { say } from '../common/say.js';

/**
 * Активности: что уже произошло (ТЗ 8.4).
 *
 * Звонок, встреча, письмо, заметка. Лента активностей — то, из чего в карточке
 * клиента складывается история общения: кто последний раз звонил, о чём
 * договорились, когда писали.
 *
 * Два правила, которые держит эта служба:
 *
 * - **Активность не бывает в будущем.** «Позвоню завтра» — это задача, у неё
 *   есть срок и ответственный. Пустив будущее в ленту, мы получили бы историю
 *   общения, в которой записаны не состоявшиеся разговоры.
 * - **Длительность и направление — только у звонка.** У письма нет
 *   длительности, у заметки нет направления. Правило дублирует база.
 */
@Injectable()
export class ActivitiesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(params: {
    partnerUid?: string;
    dealUid?: string;
    type?: string;
    limit?: number;
    offset?: number;
  }) {
    const limit = params.limit ?? 50;
    const offset = params.offset ?? 0;

    return this.prisma.withTenant(async (tx) => {
      const where = `WHERE ($1::uuid IS NULL OR p.uid = $1::uuid)
                       AND ($2::uuid IS NULL OR d.uid = $2::uuid)
                       AND ($3::text = '' OR a.type::text = $3::text)`;
      const args = [params.partnerUid ?? null, params.dealUid ?? null, params.type ?? ''];

      const rows = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
        `${ACTIVITY_SELECT} ${where}
          ORDER BY a.at DESC, a.id DESC
          LIMIT $4 OFFSET $5`,
        ...args,
        limit,
        offset,
      );
      const totals = await tx.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n
           FROM crm_activity a
           LEFT JOIN partner p ON p.id = a.partner_id
           LEFT JOIN deal d ON d.id = a.deal_id
           ${where}`,
        ...args,
      );

      return { rows: rows.map(activityView), total: Number(totals[0]?.n ?? 0), limit, offset };
    });
  }

  async create(input: ActivityInput) {
    const uid = await this.prisma.withTenant(async (tx) => {
      const owner = await resolveOwner(tx, input);
      const at = input.at ? new Date(input.at) : new Date();
      if (Number.isNaN(at.getTime())) throw new UnprocessableEntityException(say('Неверная дата', 'Sana noto‘g‘ri'));
      if (at.getTime() > Date.now() + 60_000) {
        throw new UnprocessableEntityException(say(
          'Активность — то, что уже было: на будущее заводят задачу со сроком', 'Faoliyat — bo‘lib o‘tgan ish: kelajak uchun muddatli vazifa kiritiladi'));
      }
      if (input.type !== 'call' && (input.direction || input.durationSec !== undefined)) {
        throw new UnprocessableEntityException(say(
          'Направление и длительность есть только у звонка', 'Yo‘nalish va davomiylik faqat qo‘ng‘iroqda bo‘ladi'));
      }
      const userId = await this.currentUserId(tx);
      return this.insert(tx, {
        companyId: owner.companyId,
        partnerId: owner.partnerId,
        dealId: owner.dealId,
        type: input.type,
        subject: input.subject.trim(),
        note: input.note?.trim() ?? null,
        at,
        direction: input.direction ?? null,
        durationSec: input.durationSec ?? null,
        taskId: null,
        userId,
      });
    });
    return this.one(uid);
  }

  async one(uid: string) {
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
        `${ACTIVITY_SELECT} WHERE a.uid = $1::uuid`,
        uid,
      );
      if (!rows[0]) throw new NotFoundException(say('Активность не найдена', 'Faoliyat topilmadi'));
      return activityView(rows[0]);
    });
  }

  /** Вставка одной строки. Ею же пользуются задачи при закрытии. */
  async insert(
    tx: Tx,
    row: {
      companyId: bigint;
      partnerId: bigint | null;
      dealId: bigint | null;
      type: string;
      subject: string;
      note: string | null;
      at: Date;
      direction: string | null;
      durationSec: number | null;
      taskId: bigint | null;
      userId: bigint | null;
    },
  ): Promise<string> {
    const rows = await tx.$queryRawUnsafe<{ uid: string }[]>(
      `INSERT INTO crm_activity (uid, company_id, type, direction, subject, note, at,
                                 duration_sec, partner_id, deal_id, task_id, user_id)
       VALUES (gen_random_uuid(), $1, $2::"CrmActivityType", $3::"CrmActivityDirection",
               $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING uid`,
      row.companyId,
      row.type,
      row.direction,
      row.subject,
      row.note,
      row.at,
      row.durationSec,
      row.partnerId,
      row.dealId,
      row.taskId,
      row.userId,
    );
    return rows[0]!.uid;
  }

  private async currentUserId(tx: Tx): Promise<bigint | null> {
    const id = currentContext()?.userId;
    if (id === undefined || id === null) return null;
    const rows = await tx.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM user_account WHERE id = ${id}`;
    return rows[0]?.id ?? null;
  }
}

const ACTIVITY_SELECT = `
  SELECT a.uid, a.type::text AS type, a.direction::text AS direction, a.subject, a.note,
         a.at, a.duration_sec, a.created_at,
         co.uid AS company_uid, co.code AS company_code,
         p.uid AS partner_uid, app_loc(p.name_ru, p.name_uz) AS partner_name,
         d.uid AS deal_uid, d.number AS deal_number, d.title AS deal_title,
         t.uid AS task_uid, t.title AS task_title,
         u.uid AS user_uid, u.full_name AS user_name
    FROM crm_activity a
    JOIN company co ON co.id = a.company_id
    LEFT JOIN partner p ON p.id = a.partner_id
    LEFT JOIN deal d ON d.id = a.deal_id
    LEFT JOIN crm_task t ON t.id = a.task_id
    LEFT JOIN user_account u ON u.id = a.user_id`;

export const activityView = (r: Record<string, any>) => ({
  uid: r.uid,
  type: r.type as 'call' | 'meeting' | 'letter' | 'note',
  direction: r.direction as 'incoming' | 'outgoing' | null,
  subject: r.subject,
  note: r.note,
  at: r.at,
  durationSec: r.duration_sec === null ? null : Number(r.duration_sec),
  company: { uid: r.company_uid, code: r.company_code },
  partner: r.partner_uid ? { uid: r.partner_uid, name: r.partner_name } : null,
  deal: r.deal_uid ? { uid: r.deal_uid, number: r.deal_number, title: r.deal_title } : null,
  task: r.task_uid ? { uid: r.task_uid, title: r.task_title } : null,
  user: r.user_uid ? { uid: r.user_uid, name: r.user_name } : null,
  createdAt: r.created_at,
});

export type ActivityInput = {
  type: 'call' | 'meeting' | 'letter' | 'note';
  subject: string;
  note?: string;
  at?: string;
  direction?: 'incoming' | 'outgoing';
  durationSec?: number;
  partnerUid?: string;
  dealUid?: string;
};
