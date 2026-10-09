import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { currentContext } from '../common/request-context.js';
import { writeAudit } from '../common/audit.js';
import { MSG } from '../common/messages.js';
import { say } from '../common/say.js';
import { nameCol } from '../common/name.js';

/**
 * Контроль производства (ТЗ 4.1, Э7): журнал отклонений и простои.
 *
 * Отклонения копились с третьего захода — пауза этапа клала строку простоя,
 * перерасход материала и брак ложились своими строками, — но смотреть на них
 * было негде: журнал существовал только внутри сводки, свёрнутый до итогов по
 * причинам. Здесь он становится списком, который можно открыть и прочитать.
 *
 * Простой руками — второе, чего не хватало. Пауза этапа отвечает на вопрос
 * «почему встал заказ», а участок простаивает и без заказа: нет сырья, нет
 * людей, стоит линия. Такой простой никто не записывал, и в загрузке участка
 * он выглядел просто отсутствием работы.
 *
 * Решения:
 *
 * - **простой заводят с причиной из справочника.** Свободный текст в причине
 *   означал бы, что через месяц одно и то же называется тремя словами и не
 *   собирается в отчёт;
 * - **длительность в минутах, а не «с … по …».** Цех помнит «стояли полтора
 *   часа», а не точные отметки времени; точные отметки есть у паузы этапа —
 *   их система ставит сама;
 * - **запись простоя не трогает этапы и заказы.** Это наблюдение за участком,
 *   а не действие над работой.
 */

export type DeviationKindName = 'downtime' | 'overuse' | 'defect' | 'delay';

export type DeviationRow = {
  occurredAt: string;
  kind: DeviationKindName;
  orderNumber: string | null;
  orderUid: string | null;
  stageNameRu: string | null;
  stageNameUz: string | null;
  workCenterCode: string | null;
  reasonRu: string | null;
  reasonUz: string | null;
  durationMin: number;
  amount: string;
  comment: string | null;
  authorName: string | null;
};

export type DowntimeInput = {
  workCenterCode: string;
  reasonUid: string;
  minutes: number;
  occurredAt?: string;
  comment?: string;
};

const PERIOD_DAYS: Record<string, number> = { '7d': 7, '30d': 30, '3m': 90 };

/** Сутки в минутах: простой длиннее суток — это опечатка, а не простой. */
const MAX_DOWNTIME_MIN = 24 * 60;

@Injectable()
export class ProductionControlService {
  constructor(private readonly prisma: PrismaService) {}

  /** Журнал отклонений: что пошло не по плану и сколько это стоило времени. */
  async deviations(
    period: string,
    kind?: DeviationKindName,
    limit = 100,
  ): Promise<{
    period: string;
    rows: DeviationRow[];
    totals: { kind: DeviationKindName; events: number; minutes: number; amount: string }[];
  }> {
    this.requireView();
    const days = PERIOD_DAYS[period] ?? 30;
    const take = Math.min(Math.max(limit, 1), 200);

    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.$queryRaw<
        {
          occurred_at: Date;
          kind: DeviationKindName;
          order_number: string | null;
          order_uid: string | null;
          stage_ru: string | null;
          stage_uz: string | null;
          center: string | null;
          reason_ru: string | null;
          reason_uz: string | null;
          duration_min: number;
          amount: string;
          comment: string | null;
          author: string | null;
        }[]
      >`
        SELECT d.occurred_at, d.kind::text AS kind,
               o.number AS order_number, o.uid::text AS order_uid,
               s.name_ru AS stage_ru, s.name_uz AS stage_uz,
               w.code AS center,
               r.name_ru AS reason_ru, r.name_uz AS reason_uz,
               d.duration_min, d.amount::text AS amount, d.comment,
               a.full_name AS author
          FROM deviation_log d
          LEFT JOIN production_order o ON o.id = d.production_order_id
          LEFT JOIN production_stage s ON s.id = d.stage_id
          LEFT JOIN work_center w ON w.id = COALESCE(d.work_center_id, s.work_center_id)
          LEFT JOIN stock_reason r ON r.id = d.reason_id
          LEFT JOIN user_account a ON a.id = d.registered_by
         WHERE d.occurred_at >= current_date - ${days}::int
           AND (${kind ?? null}::text IS NULL OR d.kind::text = ${kind ?? null})
         ORDER BY d.occurred_at DESC, d.id DESC
         LIMIT ${take}`;

      const totals = await tx.$queryRaw<
        { kind: DeviationKindName; events: bigint; minutes: bigint; amount: string }[]
      >`
        SELECT d.kind::text AS kind, count(*)::bigint AS events,
               COALESCE(sum(d.duration_min), 0)::bigint AS minutes,
               COALESCE(sum(d.amount), 0)::text AS amount
          FROM deviation_log d
         WHERE d.occurred_at >= current_date - ${days}::int
         GROUP BY d.kind
         ORDER BY d.kind`;

      return {
        period,
        rows: rows.map((r) => ({
          occurredAt: r.occurred_at.toISOString(),
          kind: r.kind,
          orderNumber: r.order_number,
          orderUid: r.order_uid,
          stageNameRu: r.stage_ru,
          stageNameUz: r.stage_uz,
          workCenterCode: r.center,
          reasonRu: r.reason_ru,
          reasonUz: r.reason_uz,
          durationMin: Number(r.duration_min),
          amount: Number(r.amount).toFixed(4),
          comment: r.comment,
          authorName: r.author,
        })),
        totals: totals.map((t) => ({
          kind: t.kind,
          events: Number(t.events),
          minutes: Number(t.minutes),
          amount: Number(t.amount).toFixed(4),
        })),
      };
    });
  }

  /** Записать простой участка: линия стояла, и этого никто не видел. */
  async registerDowntime(input: DowntimeInput): Promise<DeviationRow> {
    const ctx = this.requireManage();
    const minutes = Math.round(Number(input.minutes));
    if (!Number.isFinite(minutes) || minutes <= 0) {
      throw new UnprocessableEntityException(say('Сколько простояли — число минут больше нуля', 'Qancha to‘xtab turgani — noldan katta daqiqa soni'));
    }
    if (minutes > MAX_DOWNTIME_MIN) {
      throw new UnprocessableEntityException(say(
        `Простой длиннее суток (${minutes} мин) — похоже на опечатку: запишите по дням`, `To‘xtash bir kundan uzun (${minutes} daqiqa) — xato yozuvga o‘xshaydi: kunlar bo‘yicha yozing`));
    }

    return this.prisma.withTenant(async (tx) => {
      const center = await this.center(tx, input.workCenterCode);
      const reason = await this.reason(tx, input.reasonUid, center.company_id);
      const when = input.occurredAt?.trim();
      if (when && !/^\d{4}-\d{2}-\d{2}$/.test(when)) {
        throw new UnprocessableEntityException(say('Дата простоя — в виде ГГГГ-ММ-ДД', 'To‘xtash sanasi — YYYY-MM-DD ko‘rinishida'));
      }

      const made = await tx.$queryRaw<{ id: bigint; occurred_at: Date }[]>`
        INSERT INTO deviation_log
          (company_id, kind, reason_id, work_center_id, occurred_at, duration_min, comment, registered_by)
        VALUES (${center.company_id}, 'downtime', ${reason.id}, ${center.id},
                COALESCE(${when ?? null}::date, now()), ${minutes},
                ${input.comment?.trim() || null}, ${ctx.userId ?? null})
        RETURNING id, occurred_at`;

      await writeAudit(tx, {
        companyId: center.company_id,
        entityType: 'deviation_log',
        entityId: String(made[0]!.id),
        action: 'downtime.register',
        changes: {
          workCenter: { from: null, to: center.code },
          reason: { from: null, to: reason.name_ru },
          durationMin: { from: null, to: String(minutes) },
        },
      });

      return {
        occurredAt: made[0]!.occurred_at.toISOString(),
        kind: 'downtime' as const,
        orderNumber: null,
        orderUid: null,
        stageNameRu: null,
        stageNameUz: null,
        workCenterCode: center.code,
        reasonRu: reason.name_ru,
        reasonUz: reason.name_uz,
        durationMin: minutes,
        amount: '0.0000',
        comment: input.comment?.trim() || null,
        authorName: null,
      };
    });
  }

  // --- внутреннее ----------------------------------------------------------

  private requireView() {
    const ctx = currentContext();
    if (!ctx?.permissions.has('production.view')) {
      throw new ForbiddenException(MSG.noRight('production.view'));
    }
    return ctx;
  }

  private requireManage() {
    const ctx = currentContext();
    if (!ctx?.permissions.has('production.manage')) {
      throw new ForbiddenException(MSG.noRight('production.manage'));
    }
    return ctx;
  }

  private async center(tx: Tx, code: string) {
    const rows = await tx.$queryRaw<
      { id: bigint; company_id: bigint; code: string; is_active: boolean }[]
    >`
      SELECT id, company_id, code, is_active FROM work_center
       WHERE code = ${String(code ?? '').trim()}`;
    const row = rows[0];
    if (!row) throw new UnprocessableEntityException(MSG.workCenterNotFound(code));
    if (!row.is_active) {
      throw new UnprocessableEntityException(say(`Участок ${row.code} закрыт: простой по нему не записывают`, `${row.code} uchastkasi yopilgan: u bo‘yicha to‘xtash yozilmaydi`));
    }
    return row;
  }

  /**
   * Причина простоя — из справочника и своего вида: причинами брака простой не
   * объясняют, иначе отчёт по простоям соберёт в себя чужие строки.
   */
  private async reason(tx: Tx, uid: string, companyId: bigint) {
    const rows = await tx.$queryRaw<
      { id: bigint; name_ru: string; name_uz: string; name: string; kind: string; company_id: bigint }[]
    >`
      SELECT id, name_ru, name_uz, ${nameCol('stock_reason')} AS name,
             kind::text AS kind, company_id
        FROM stock_reason WHERE uid = ${String(uid ?? '')}::uuid AND is_active`;
    const row = rows[0];
    if (!row) throw new NotFoundException(say('Причина простоя не найдена', 'To‘xtash sababi topilmadi'));
    if (row.company_id !== companyId) {
      throw new UnprocessableEntityException(say('Причина заведена в другой компании', 'Sabab boshqa kompaniyada kiritilgan'));
    }
    if (row.kind !== 'downtime') {
      throw new UnprocessableEntityException(say(
        `«${row.name_ru}» — это причина другого вида: у простоя свой список причин`, `«${row.name}» — bu boshqa turdagi sabab: to‘xtashning o‘z sabablar ro‘yxati bor`));
    }
    return row;
  }
}
