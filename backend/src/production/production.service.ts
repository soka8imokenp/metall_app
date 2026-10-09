import { Injectable } from '@nestjs/common';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { ProductionCalendarService } from './calendar.service.js';
import { currentContext } from '../common/request-context.js';

export type Period = '7d' | '30d' | '3m';

const PERIOD_DAYS: Record<Period, number> = { '7d': 7, '30d': 30, '3m': 90 };

const qty = (v: unknown) => Number(v ?? 0).toFixed(6);
const f1 = (n: number) => n.toFixed(1);

/**
 * Шапка страницы производства.
 *
 * Здесь нет одной сводной цифры «выпущено»: завод делает трубу в тоннах и
 * скорлупу в погонных метрах, и складывать их — значит показать число, за
 * которым нет физического смысла. Выпуск разложен по единицам измерения, и
 * каждая строка подписана своей.
 */
@Injectable()
export class ProductionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly calendar: ProductionCalendarService,
  ) {}

  async summary(period: Period) {
    const days = PERIOD_DAYS[period];

    return this.prisma.withTenant(async (tx) => {
      // Последовательно, а не Promise.all: один запрос — одно соединение,
      // конвейер в pg 9.0 убирают.
      const orders = await this.orders(tx);
      const output = await this.output(tx, days);
      const downtime = await this.downtime(tx, days);
      const calendar = await this.calendarWindow(tx, days);
      const workCenters = await this.workCenters(tx, days, calendar.availableMin);

      return { period, orders, output, downtime, calendar, workCenters };
    });
  }

  /**
   * Сколько завод вообще работал в этом окне (Э7).
   *
   * Без календаря загрузку участка приходилось показывать голыми минутами:
   * «отработано 8 ч 25 мин» — много это или мало, по такой строке не понять.
   * Доступные минуты считаются из рабочих дней периода и длины смен; смены не
   * заведены — считать не из чего, и тогда процента не будет вовсе.
   */
  private async calendarWindow(tx: Tx, days: number) {
    const ids = currentContext()?.companyIds ?? [];
    if (ids.length !== 1) {
      return { workingDays: 0, dayMinutes: 0, availableMin: null as number | null };
    }
    const window = await tx.$queryRaw<{ from: string; to: string }[]>`
      SELECT to_char(current_date - ${days}::int, 'YYYY-MM-DD') AS from,
             to_char(current_date, 'YYYY-MM-DD') AS to`;
    const workingDays = await this.calendar.workingDays(tx, ids[0], window[0]!.from, window[0]!.to);
    const dayMinutes = await this.calendar.dayMinutes(tx, ids[0]);
    return {
      workingDays,
      dayMinutes,
      availableMin: dayMinutes > 0 ? workingDays * dayMinutes : null,
    };
  }

  /** Сколько заказов и в каком они состоянии, плюс просрочка по сроку сдачи. */
  private async orders(tx: Tx) {
    const rows = await tx.$queryRaw<
      {
        total: bigint;
        planned: bigint;
        in_progress: bigint;
        paused: bigint;
        produced: bigint;
        closed: bigint;
        overdue: bigint;
      }[]
    >`
      SELECT count(*)::bigint                                                      AS total,
             count(*) FILTER (WHERE status IN ('draft', 'planned'))::bigint        AS planned,
             count(*) FILTER (WHERE status = 'in_progress')::bigint                AS in_progress,
             count(*) FILTER (WHERE status = 'paused')::bigint                     AS paused,
             count(*) FILTER (WHERE status = 'produced')::bigint                   AS produced,
             count(*) FILTER (WHERE status = 'closed')::bigint                     AS closed,
             count(*) FILTER (WHERE due_date < current_date
                                AND status NOT IN ('produced', 'closed', 'cancelled'))::bigint AS overdue
        FROM production_order
       WHERE status <> 'cancelled'
    `;

    const r = rows[0]!;
    return {
      total: Number(r.total),
      planned: Number(r.planned),
      inProgress: Number(r.in_progress),
      paused: Number(r.paused),
      produced: Number(r.produced),
      closed: Number(r.closed),
      overdue: Number(r.overdue),
    };
  }

  /**
   * Выпуск за период по единицам измерения. Доля брака считается от годного
   * выпуска в той же единице — межединичных долей не бывает.
   */
  private async output(tx: Tx, days: number) {
    const rows = await tx.$queryRaw<
      { unit: string; good: string; defect: string; waste: string }[]
    >`
      SELECT u.code                                                             AS unit,
             COALESCE(sum(o.qty) FILTER (WHERE o.kind = 'good'), 0)::text       AS good,
             COALESCE(sum(o.qty) FILTER (WHERE o.kind = 'defect'), 0)::text     AS defect,
             COALESCE(sum(o.qty) FILTER (WHERE o.kind = 'waste'), 0)::text      AS waste
        FROM production_output o
        JOIN production_order p ON p.id = o.production_order_id
        JOIN unit u ON u.id = p.unit_id
       WHERE o.occurred_at >= current_date - ${days}::int
       GROUP BY u.code
       ORDER BY u.code
    `;

    return rows.map((r) => {
      const good = Number(r.good);
      const defect = Number(r.defect);
      return {
        unit: r.unit,
        good: qty(good),
        defect: qty(defect),
        waste: qty(r.waste),
        // Нулевой выпуск — доли нет, а не «ноль процентов брака».
        defectPercent: good === 0 ? null : f1((defect / good) * 100),
      };
    });
  }

  /**
   * Простои за период — из журнала отклонений, а не из статусов этапов:
   * статус показывает, что происходит сейчас, журнал — что уже случилось.
   */
  private async downtime(tx: Tx, days: number) {
    const rows = await tx.$queryRaw<
      { name_ru: string | null; name_uz: string | null; minutes: bigint; events: bigint }[]
    >`
      SELECT r.name_ru,
             r.name_uz,
             COALESCE(sum(d.duration_min), 0)::bigint AS minutes,
             count(*)::bigint                         AS events
        FROM deviation_log d
        LEFT JOIN stock_reason r ON r.id = d.reason_id
       WHERE d.kind = 'downtime'
         AND d.occurred_at >= current_date - ${days}::int
       GROUP BY r.name_ru, r.name_uz
       ORDER BY minutes DESC
    `;

    const byReason = rows.map((r) => ({
      reasonRu: r.name_ru,
      reasonUz: r.name_uz,
      minutes: Number(r.minutes),
      events: Number(r.events),
    }));

    return {
      minutes: byReason.reduce((s, x) => s + x.minutes, 0),
      events: byReason.reduce((s, x) => s + x.events, 0),
      byReason,
    };
  }

  /**
   * Загрузка участков за период: отработанные минуты против доступных по
   * календарю, плюс простои участка.
   *
   * Процент считается от календаря, а не от суток подряд: завод работает в
   * свои смены и в свои дни. Смен нет — процента нет, и экран говорит об этом
   * словами, а не рисует загрузку от выдуманной мощности.
   */
  private async workCenters(tx: Tx, days: number, availableMin: number | null) {
    const rows = await tx.$queryRaw<
      {
        code: string;
        name_ru: string;
        name_uz: string;
        capacity: string;
        stages: bigint;
        planned_min: bigint;
        actual_min: bigint;
        downtime_min: bigint;
      }[]
    >`
      SELECT w.code,
             w.name_ru,
             w.name_uz,
             w.capacity_per_shift::text                       AS capacity,
             count(s.id)::bigint                              AS stages,
             COALESCE(sum(s.planned_duration_min), 0)::bigint AS planned_min,
             COALESCE(sum(s.actual_duration_min), 0)::bigint  AS actual_min,
             COALESCE((SELECT sum(d.duration_min) FROM deviation_log d
                        WHERE d.kind = 'downtime'
                          AND d.occurred_at >= current_date - ${days}::int
                          AND COALESCE(d.work_center_id,
                                       (SELECT st.work_center_id FROM production_stage st
                                         WHERE st.id = d.stage_id)) = w.id), 0)::bigint AS downtime_min
        FROM work_center w
        LEFT JOIN production_stage s ON s.work_center_id = w.id
         AND EXISTS (SELECT 1 FROM production_stage_event e
                      WHERE e.stage_id = s.id
                        AND e.occurred_at >= current_date - ${days}::int)
       WHERE w.is_active
       GROUP BY w.id, w.code, w.name_ru, w.name_uz, w.capacity_per_shift
       ORDER BY w.code
    `;

    return rows.map((r) => {
      const actualMin = Number(r.actual_min);
      return {
        code: r.code,
        nameRu: r.name_ru,
        nameUz: r.name_uz,
        capacityPerShift: qty(r.capacity),
        stages: Number(r.stages),
        plannedMin: Number(r.planned_min),
        actualMin,
        downtimeMin: Number(r.downtime_min),
        availableMin,
        loadPercent: availableMin && availableMin > 0 ? f1((actualMin / availableMin) * 100) : null,
      };
    });
  }
}
