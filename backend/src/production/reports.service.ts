import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import type { ReportTable } from '../common/report.js';
import { currentContext } from '../common/request-context.js';
import { ProductionCalendarService } from './calendar.service.js';
import { say } from '../common/say.js';
import { nameCol } from '../common/name.js';

/**
 * Отчёты производства (ТЗ 4.1, Э8).
 *
 * Форма отчёта общая на все модули (`common/report.ts`): заголовки колонок и
 * строки значений. Из неё же собирается выгрузка в Excel, CSV и PDF — поэтому
 * экран ничего не пересобирает, и в файле лежит ровно то, что видно.
 *
 * Числа уходят числами, а не подписанными строками: в Excel по колонке берут
 * сумму, а «313,4 т» суммировать нельзя.
 */
export const REPORT_KINDS = ['orders', 'output', 'materials', 'deviations', 'load'] as const;
export type ProductionReportKind = (typeof REPORT_KINDS)[number];

export interface ProductionReport extends ReportTable {
  kind: ProductionReportKind;
}

const TZ = 'Asia/Tashkent';
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());

function shiftDays(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

const num = (v: unknown) => Number(v ?? 0);

/** Подписи на языке запроса — поэтому функции, а не константы модуля. */
const status = (): Record<string, string> => ({
  draft: say('Черновик', 'Qoralama'),
  planned: say('Запланирован', 'Rejalashtirilgan'),
  in_progress: say('В работе', 'Ishda'),
  paused: say('Приостановлен', 'To‘xtatilgan'),
  produced: say('Выпущен', 'Chiqarilgan'),
  closed: say('Закрыт', 'Yopilgan'),
  cancelled: say('Отменён', 'Bekor qilingan'),
});

const kind = (): Record<string, string> => ({
  downtime: say('Простой', 'To‘xtash'),
  overuse: say('Перерасход', 'Ortiqcha sarf'),
  defect: say('Брак', 'Nuqson'),
  delay: say('Срыв срока', 'Muddat buzilishi'),
});

@Injectable()
export class ProductionReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly calendar: ProductionCalendarService,
  ) {}

  async build(params: {
    kind: ProductionReportKind;
    from?: string;
    to?: string;
    limit: number;
  }): Promise<ProductionReport> {
    const period = this.period(params.from, params.to);

    return this.prisma.withTenant(async (tx) => {
      switch (params.kind) {
        case 'orders':
          return this.orders(tx, params.limit, period);
        case 'output':
          return this.output(tx, params.limit, period);
        case 'materials':
          return this.materials(tx, params.limit, period);
        case 'deviations':
          return this.deviations(tx, params.limit, period);
        case 'load':
          return this.load(tx, params.limit, period);
      }
    });
  }

  /** Границы периода — календарные дни местного времени, как на складе. */
  private period(from?: string, to?: string) {
    const end = to ?? today();
    const start = from ?? shiftDays(end, -30);
    if (!DAY.test(start) || !DAY.test(end)) {
      throw new UnprocessableEntityException(
        say('Период отчёта: даты в формате ГГГГ-ММ-ДД', 'Hisobot davri: sanalar YYYY-MM-DD ko‘rinishida'),
      );
    }
    if (start > end) {
      throw new UnprocessableEntityException(
        say('Период отчёта: дата «с» позже даты «по»', 'Hisobot davri: «dan» sanasi «gacha» sanasidan keyin'),
      );
    }
    // Период в подписи читает человек, в том числе в выгруженном файле:
    // пишем его так, как его пишут на заводе, а не так, как хранит база.
    const human = (d: string) => d.split('-').reverse().join('.');
    return {
      start,
      end,
      text: say(`с ${human(start)} по ${human(end)}`, `${human(start)} dan ${human(end)} gacha`),
    };
  }

  private cut<T>(rows: T[], limit: number) {
    return { rows: rows.slice(0, limit), total: rows.length, truncated: rows.length > limit };
  }

  /**
   * План и факт по заказам со сроком в периоде.
   *
   * Берём по сроку сдачи, а не по дате заведения: вопрос, на который отвечает
   * отчёт, — «что мы должны были сдать и что сдали».
   */
  private async orders(
    tx: Tx,
    limit: number,
    period: { start: string; end: string; text: string },
  ): Promise<ProductionReport> {
    const rows = await tx.$queryRaw<Record<string, string | null>[]>`
      SELECT o.number, ${nameCol('i')} AS item, u.code AS unit,
             o.qty_planned::text AS planned, o.qty_produced::text AS produced,
             o.qty_defect::text AS defect, o.qty_waste::text AS waste,
             to_char(o.due_date, 'DD.MM.YYYY') AS due,
             o.status::text AS status,
             CASE WHEN o.status IN ('produced', 'closed', 'cancelled') THEN NULL
                  WHEN o.due_date >= current_date THEN NULL
                  ELSE (SELECT count(*)::text FROM generate_series(o.due_date + 1, current_date, '1 day') d
                         LEFT JOIN production_calendar_day c
                           ON c.company_id = o.company_id AND c.day = d::date
                         JOIN company co ON co.id = o.company_id
                        WHERE COALESCE(c.is_working, EXTRACT(isodow FROM d)::int = ANY (co.work_days)))
             END AS overdue
        FROM production_order o
        JOIN item i ON i.id = o.item_id
        JOIN unit u ON u.id = o.unit_id
       WHERE o.due_date BETWEEN ${period.start}::date AND ${period.end}::date
       ORDER BY o.due_date, o.number`;

    const cut = this.cut(rows, limit);
    return {
      kind: 'orders',
      title: say('План и факт по заказам', 'Buyurtmalar bo‘yicha reja va fakt'),
      subtitle: `${say('Срок сдачи', 'Topshirish muddati')} ${period.text} · ${say('строк', 'qator')}: ${cut.total}`,
      columns: [
        { title: say('Заказ', 'Buyurtma'), width: 14 },
        { title: say('Продукция', 'Mahsulot'), width: 42 },
        { title: say('Ед.', 'Birlik'), width: 8 },
        { title: say('План', 'Reja'), numeric: true },
        { title: say('Годное', 'Yaroqli'), numeric: true },
        { title: say('Брак', 'Nuqson'), numeric: true },
        { title: say('Отход', 'Chiqindi'), numeric: true },
        { title: say('Выполнено, %', 'Bajarildi, %'), numeric: true },
        { title: say('Срок', 'Muddat'), width: 12 },
        { title: say('Статус', 'Holat'), width: 16 },
        { title: say('Просрочка, раб. дн.', 'Kechikish, ish kuni'), numeric: true },
      ],
      rows: cut.rows.map((r) => {
        const planned = num(r.planned);
        return [
          r.number,
          r.item,
          r.unit,
          planned,
          num(r.produced),
          num(r.defect),
          num(r.waste),
          // Доли нет, когда делить не на что: ноль в плане — это не «0 %».
          planned > 0 ? Number(((num(r.produced) / planned) * 100).toFixed(1)) : null,
          r.due,
          status()[r.status ?? ''] ?? r.status,
          r.overdue === null ? null : num(r.overdue),
        ];
      }),
      total: cut.total,
      truncated: cut.truncated,
    };
  }

  /** Выпуск по номенклатуре: годное, брак, отход и доля брака. */
  private async output(
    tx: Tx,
    limit: number,
    period: { start: string; end: string; text: string },
  ): Promise<ProductionReport> {
    const rows = await tx.$queryRaw<Record<string, string | null>[]>`
      SELECT i.code AS item_code, ${nameCol('i')} AS item, u.code AS unit,
             COALESCE(sum(p.qty) FILTER (WHERE p.kind = 'good'), 0)::text   AS good,
             COALESCE(sum(p.qty) FILTER (WHERE p.kind = 'semi'), 0)::text   AS semi,
             COALESCE(sum(p.qty) FILTER (WHERE p.kind = 'defect'), 0)::text AS defect,
             COALESCE(sum(p.qty) FILTER (WHERE p.kind = 'waste'), 0)::text  AS waste
        FROM production_output p
        JOIN item i ON i.id = p.item_id
        JOIN unit u ON u.id = i.base_unit_id
       WHERE (p.occurred_at AT TIME ZONE ${TZ})::date
             BETWEEN ${period.start}::date AND ${period.end}::date
       GROUP BY i.code, ${nameCol('i')}, u.code
       ORDER BY i.code`;

    const cut = this.cut(rows, limit);
    return {
      kind: 'output',
      title: say('Выпуск по номенклатуре', 'Nomenklatura bo‘yicha chiqarish'),
      subtitle: `${period.text} · ${say('строк', 'qator')}: ${cut.total}`,
      columns: [
        { title: say('Код', 'Kod'), width: 18 },
        { title: say('Номенклатура', 'Nomenklatura'), width: 42 },
        { title: say('Ед.', 'Birlik'), width: 8 },
        { title: say('Годное', 'Yaroqli'), numeric: true },
        { title: say('Полуфабрикат', 'Yarim tayyor mahsulot'), numeric: true },
        { title: say('Брак', 'Nuqson'), numeric: true },
        { title: say('Отход', 'Chiqindi'), numeric: true },
        { title: say('Доля брака, %', 'Nuqson ulushi, %'), numeric: true },
      ],
      rows: cut.rows.map((r) => {
        const good = num(r.good);
        return [
          r.item_code,
          r.item,
          r.unit,
          good,
          num(r.semi),
          num(r.defect),
          num(r.waste),
          good > 0 ? Number(((num(r.defect) / good) * 100).toFixed(1)) : null,
        ];
      }),
      total: cut.total,
      truncated: cut.truncated,
    };
  }

  /** Расход материалов: план, выдача, возврат, факт и отклонение. */
  private async materials(
    tx: Tx,
    limit: number,
    period: { start: string; end: string; text: string },
  ): Promise<ProductionReport> {
    const rows = await tx.$queryRaw<Record<string, string | null>[]>`
      SELECT o.number, i.code AS item_code, ${nameCol('i')} AS item, u.code AS unit,
             m.qty_planned::text AS planned, m.qty_issued::text AS issued,
             m.qty_returned::text AS returned, m.qty_used::text AS used,
             m.cost_total::text AS cost
        FROM production_material m
        JOIN production_order o ON o.id = m.production_order_id
        JOIN item i ON i.id = m.item_id
        JOIN unit u ON u.id = m.unit_id
       WHERE o.due_date BETWEEN ${period.start}::date AND ${period.end}::date
         AND (m.qty_planned > 0 OR m.qty_issued > 0 OR m.qty_used > 0)
       ORDER BY o.number, i.code`;

    const cut = this.cut(rows, limit);
    return {
      kind: 'materials',
      title: say('Расход материалов', 'Materiallar sarfi'),
      subtitle:
        `${say('Заказы, срок сдачи', 'Buyurtmalar, topshirish muddati')} ${period.text} · ` +
        `${say('строк', 'qator')}: ${cut.total}`,
      columns: [
        { title: say('Заказ', 'Buyurtma'), width: 14 },
        { title: say('Код', 'Kod'), width: 18 },
        { title: say('Материал', 'Material'), width: 38 },
        { title: say('Ед.', 'Birlik'), width: 8 },
        { title: say('План', 'Reja'), numeric: true },
        { title: say('Выдано', 'Berilgan'), numeric: true },
        { title: say('Возврат', 'Qaytarilgan'), numeric: true },
        { title: say('Расход', 'Sarf'), numeric: true },
        { title: say('Отклонение', 'Chetlanish'), numeric: true },
        { title: say('Стоимость', 'Qiymati'), numeric: true },
      ],
      rows: cut.rows.map((r) => [
        r.number,
        r.item_code,
        r.item,
        r.unit,
        num(r.planned),
        num(r.issued),
        num(r.returned),
        num(r.used),
        // Отклонение — факт минус план: перерасход плюсом, экономия минусом.
        Number((num(r.used) - num(r.planned)).toFixed(6)),
        num(r.cost),
      ]),
      total: cut.total,
      truncated: cut.truncated,
    };
  }

  /** Отклонения по причинам: из-за чего встали и сколько это стоило времени. */
  private async deviations(
    tx: Tx,
    limit: number,
    period: { start: string; end: string; text: string },
  ): Promise<ProductionReport> {
    const rows = await tx.$queryRaw<Record<string, string | null>[]>`
      SELECT d.kind::text AS kind,
             COALESCE(${nameCol('r')}, ${say('— без причины', '— sabab ko‘rsatilmagan')}) AS reason,
             w.code AS center,
             count(*)::text AS events,
             COALESCE(sum(d.duration_min), 0)::text AS minutes,
             COALESCE(sum(d.amount), 0)::text AS amount
        FROM deviation_log d
        LEFT JOIN stock_reason r ON r.id = d.reason_id
        LEFT JOIN production_stage s ON s.id = d.stage_id
        LEFT JOIN work_center w ON w.id = COALESCE(d.work_center_id, s.work_center_id)
       WHERE (d.occurred_at AT TIME ZONE ${TZ})::date
             BETWEEN ${period.start}::date AND ${period.end}::date
       GROUP BY d.kind, ${nameCol('r')}, w.code
       ORDER BY sum(d.duration_min) DESC, count(*) DESC`;

    const cut = this.cut(rows, limit);
    return {
      kind: 'deviations',
      title: say('Отклонения по причинам', 'Sabablar bo‘yicha chetlanishlar'),
      subtitle: `${period.text} · ${say('строк', 'qator')}: ${cut.total}`,
      columns: [
        { title: say('Вид', 'Turi'), width: 16 },
        { title: say('Причина', 'Sabab'), width: 40 },
        { title: say('Участок', 'Uchastka'), width: 14 },
        { title: say('Случаев', 'Holatlar'), numeric: true },
        { title: say('Минут', 'Daqiqa'), numeric: true },
        { title: say('Количество', 'Miqdor'), numeric: true },
      ],
      rows: cut.rows.map((r) => [
        kind()[r.kind ?? ''] ?? r.kind,
        r.reason,
        r.center,
        num(r.events),
        num(r.minutes),
        num(r.amount),
      ]),
      total: cut.total,
      truncated: cut.truncated,
    };
  }

  /**
   * Загрузка участков: отработанные минуты против доступных по календарю.
   *
   * Доступные минуты считает календарь завода (Э7): рабочие дни периода на
   * длину смен. Смен нет — колонки загрузки пустые, а не нулевые.
   */
  private async load(
    tx: Tx,
    limit: number,
    period: { start: string; end: string; text: string },
  ): Promise<ProductionReport> {
    const ids = currentContext()?.companyIds ?? [];
    const available =
      ids.length === 1
        ? await (async () => {
            const days = await this.calendar.workingDays(tx, ids[0], period.start, period.end);
            const minutes = await this.calendar.dayMinutes(tx, ids[0]);
            return minutes > 0 ? { days, minutes, total: days * minutes } : null;
          })()
        : null;

    const rows = await tx.$queryRaw<Record<string, string | null>[]>`
      SELECT w.code, ${nameCol('w')} AS name, w.capacity_per_shift::text AS capacity,
             w.cost_per_hour::text AS rate,
             count(s.id)::text AS stages,
             COALESCE(sum(s.planned_duration_min), 0)::text AS planned,
             COALESCE(sum(s.actual_duration_min), 0)::text AS actual,
             COALESCE((SELECT sum(d.duration_min) FROM deviation_log d
                        WHERE d.kind = 'downtime'
                          AND (d.occurred_at AT TIME ZONE ${TZ})::date
                              BETWEEN ${period.start}::date AND ${period.end}::date
                          AND COALESCE(d.work_center_id,
                                       (SELECT st.work_center_id FROM production_stage st
                                         WHERE st.id = d.stage_id)) = w.id), 0)::text AS downtime
        FROM work_center w
        LEFT JOIN production_stage s ON s.work_center_id = w.id
         AND EXISTS (SELECT 1 FROM production_stage_event e
                      WHERE e.stage_id = s.id
                        AND (e.occurred_at AT TIME ZONE ${TZ})::date
                            BETWEEN ${period.start}::date AND ${period.end}::date)
       WHERE w.is_active
       GROUP BY w.id, w.code, ${nameCol('w')}, w.capacity_per_shift, w.cost_per_hour
       ORDER BY w.code`;

    const cut = this.cut(rows, limit);
    return {
      kind: 'load',
      title: say('Загрузка участков', 'Uchastkalar yuklanishi'),
      subtitle: available
        ? `${period.text} · ` +
          say(
            `${available.days} рабочих дней по ${available.minutes} мин`,
            `${available.days} ish kuni, har biri ${available.minutes} daqiqa`,
          ) +
          ` · ${say('строк', 'qator')}: ${cut.total}`
        : `${period.text} · ` +
          say(
            'смены не заведены, загрузка в процентах не считается',
            'smenalar kiritilmagan, yuklanish foizda hisoblanmaydi',
          ) +
          ` · ${say('строк', 'qator')}: ${cut.total}`,
      columns: [
        { title: say('Участок', 'Uchastka'), width: 14 },
        { title: say('Название', 'Nomi'), width: 36 },
        { title: say('Мощность смены', 'Smena quvvati'), numeric: true },
        { title: say('Ставка часа', 'Soat stavkasi'), numeric: true },
        { title: say('Этапов', 'Bosqichlar'), numeric: true },
        { title: say('План, мин', 'Reja, daqiqa'), numeric: true },
        { title: say('Факт, мин', 'Fakt, daqiqa'), numeric: true },
        { title: say('Простой, мин', 'To‘xtash, daqiqa'), numeric: true },
        { title: say('Доступно, мин', 'Mavjud, daqiqa'), numeric: true },
        { title: say('Загрузка, %', 'Yuklanish, %'), numeric: true },
      ],
      rows: cut.rows.map((r) => {
        const actual = num(r.actual);
        return [
          r.code,
          r.name,
          num(r.capacity),
          num(r.rate),
          num(r.stages),
          num(r.planned),
          actual,
          num(r.downtime),
          available ? available.total : null,
          available ? Number(((actual / available.total) * 100).toFixed(1)) : null,
        ];
      }),
      total: cut.total,
      truncated: cut.truncated,
    };
  }
}
