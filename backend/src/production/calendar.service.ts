import {
  BadRequestException,
  ConflictException,
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

/**
 * Производственный календарь (ТЗ 4.1, Э7): смены, рабочая неделя, выходные.
 *
 * До этой службы сроки в модуле считались календарными днями, а плановые даты
 * этапов стояли пустыми — разложить норму по датам было не на что. Теперь у
 * завода есть свой календарь, и из него растут три вещи:
 *
 * - **срок заказа в рабочих днях.** «Осталось 2 дня» и «осталось 2 рабочих
 *   дня» — разные вещи, если между ними воскресенье;
 * - **плановые даты этапов.** Норма этапа укладывается в смены подряд, с
 *   переносом на следующий рабочий день, когда смена кончилась;
 * - **доступные минуты участка.** Загрузка в процентах считается от того,
 *   сколько завод вообще работал в этот период, а не от суток подряд.
 *
 * Решения, которые видно в коде:
 *
 * - **обычные дни в таблице не лежат.** `production_calendar_day` хранит
 *   только исключения — праздник среди недели и рабочую субботу. Будни задаёт
 *   рабочая неделя компании (`company.work_days`), и календарь на год не надо
 *   заводить руками;
 * - **рабочий день — это непрерывный блок смен.** Перерывы внутри смены и
 *   между сменами не учитываются: учёта перерывов в системе нет, и выдумывать
 *   его в раскладке значило бы считать сроки по правилу, которого никто не
 *   задавал;
 * - **раскладка — это план, а не запрет.** Плановые даты этапов ничего не
 *   блокируют: цех начинает и заканчивает, когда начал и закончил, а план
 *   нужен, чтобы увидеть, успевает ли заказ к сроку.
 */

/** Часовой пояс завода: плановые даты считаются по его стенным часам. */
const TZ = 'Asia/Tashkent';

const DAY_RU = ['', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];

export type ShiftRow = {
  uid: string;
  code: string;
  nameRu: string;
  nameUz: string;
  startsAt: string;
  endsAt: string;
  durationMin: number;
  isActive: boolean;
};

export type CalendarDayRow = {
  day: string;
  isWorking: boolean;
  /** Исключение, заведённое руками, или обычный день по рабочей неделе. */
  isException: boolean;
  comment: string | null;
};

export type CalendarView = {
  workDays: number[];
  shifts: ShiftRow[];
  /** Сколько минут завод работает в рабочий день — сумма активных смен. */
  dayMinutes: number;
  from: string;
  to: string;
  workingDays: number;
  days: CalendarDayRow[];
};

export type ShiftInput = {
  code: string;
  nameRu: string;
  nameUz: string;
  startsAt: string;
  endsAt: string;
  isActive?: boolean;
};

type CompanyRow = { id: bigint; work_days: number[] };

const hhmm = (v: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v);

@Injectable()
export class ProductionCalendarService {
  constructor(private readonly prisma: PrismaService) {}

  // --- чтение --------------------------------------------------------------

  /** Календарь на период: по умолчанию месяц вперёд от сегодняшнего дня. */
  async view(from?: string, to?: string): Promise<CalendarView> {
    this.requireView();
    return this.prisma.withTenant(async (tx) => {
      const company = await this.company(tx);
      const shifts = await this.shiftRows(tx, company.id);
      const range = await this.range(tx, from, to);
      const days = await this.days(tx, company, range.from, range.to);

      return {
        workDays: company.work_days,
        shifts,
        dayMinutes: shifts.filter((s) => s.isActive).reduce((sum, s) => sum + s.durationMin, 0),
        from: range.from,
        to: range.to,
        workingDays: days.filter((d) => d.isWorking).length,
        days,
      };
    });
  }

  // --- запись --------------------------------------------------------------

  /** Рабочая неделя: ISO-дни, 1 — понедельник. */
  async setWorkWeek(days: number[]): Promise<CalendarView> {
    const ctx = this.requireManage();
    const clean = [...new Set(days)].sort((a, b) => a - b);
    if (clean.length === 0) {
      throw new UnprocessableEntityException(say(
        'Завод должен работать хотя бы один день в неделю: пустая неделя остановила бы все сроки', 'Zavod haftada kamida bir kun ishlashi kerak: bo‘sh hafta barcha muddatlarni to‘xtatardi'));
    }
    if (clean.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
      throw new UnprocessableEntityException(say('День недели — число от 1 (понедельник) до 7 (воскресенье)', 'Hafta kuni — 1 (dushanba) dan 7 (yakshanba) gacha son'));
    }

    await this.prisma.withTenant(async (tx) => {
      const company = await this.company(tx);
      await tx.$executeRaw`
        UPDATE company SET work_days = ${clean}::int[] WHERE id = ${company.id}`;
      await writeAudit(tx, {
        companyId: company.id,
        userId: ctx.userId ?? null,
        action: 'calendar.week',
        entityType: 'company',
        entityId: String(company.id),
        changes: {
          workDays: { from: company.work_days.join(','), to: clean.join(',') },
        },
      });
    });

    return this.view();
  }

  /** Исключение календаря: праздник среди недели или рабочая суббота. */
  async setDay(day: string, isWorking: boolean, comment?: string): Promise<CalendarView> {
    const ctx = this.requireManage();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      throw new UnprocessableEntityException(say('Дата дня — в виде ГГГГ-ММ-ДД', 'Kun sanasi — YYYY-MM-DD ko‘rinishida'));
    }
    if (!isWorking && !comment?.trim()) {
      throw new UnprocessableEntityException(say(
        'Напишите, почему завод не работает: цех увидит эту причину в календаре', 'Zavod nega ishlamasligini yozing: sex bu sababni kalendarda ko‘radi'));
    }

    await this.prisma.withTenant(async (tx) => {
      const company = await this.company(tx);
      const usual = await this.usualWorking(tx, company, day);
      if (usual === isWorking) {
        throw new ConflictException(say(
          isWorking
            ? `${day} и так рабочий день по неделе завода: исключение не нужно`
            : `${day} и так выходной по неделе завода: исключение не нужно`, isWorking ? `${day} zavod haftasi bo‘yicha allaqachon ish kuni: istisno kerak emas` : `${day} zavod haftasi bo‘yicha allaqachon dam olish kuni: istisno kerak emas`));
      }
      await tx.$executeRaw`
        INSERT INTO production_calendar_day (company_id, day, is_working, comment, created_by)
        VALUES (${company.id}, ${day}::date, ${isWorking}, ${comment?.trim() || null}, ${ctx.userId ?? null})
        ON CONFLICT (company_id, day)
          DO UPDATE SET is_working = EXCLUDED.is_working,
                        comment = EXCLUDED.comment,
                        created_by = EXCLUDED.created_by`;
      await writeAudit(tx, {
        companyId: company.id,
        userId: ctx.userId ?? null,
        action: 'calendar.day',
        entityType: 'production_calendar_day',
        entityId: day,
        changes: {
          day: { from: null, to: day },
          isWorking: { from: null, to: isWorking ? 'да' : 'нет' },
        },
      });
    });

    return this.view();
  }

  /** Убрать исключение: день снова живёт по рабочей неделе. */
  async clearDay(day: string): Promise<CalendarView> {
    const ctx = this.requireManage();
    await this.prisma.withTenant(async (tx) => {
      const company = await this.company(tx);
      const gone = await tx.$executeRaw`
        DELETE FROM production_calendar_day
         WHERE company_id = ${company.id} AND day = ${day}::date`;
      if (gone === 0) {
        throw new NotFoundException(say(`На ${day} исключения в календаре нет`, `${day} uchun kalendarda istisno yo‘q`));
      }
      await writeAudit(tx, {
        companyId: company.id,
        userId: ctx.userId ?? null,
        action: 'calendar.day.clear',
        entityType: 'production_calendar_day',
        entityId: day,
        changes: { day: { from: day, to: null } },
      });
    });
    return this.view();
  }

  /** Завести смену или поправить заведённую. */
  async saveShift(input: ShiftInput, uid?: string): Promise<CalendarView> {
    const ctx = this.requireManage();
    const code = input.code?.trim();
    if (!code) throw new UnprocessableEntityException(say('У смены должен быть код: по нему её узнают в списках', 'Smenaning kodi bo‘lishi kerak: ro‘yxatlarda uni shu kod bilan taniydi'));
    if (!hhmm(input.startsAt) || !hhmm(input.endsAt)) {
      throw new UnprocessableEntityException(say('Время смены — в виде ЧЧ:ММ, например 08:00', 'Smena vaqti — SS:DD ko‘rinishida, masalan 08:00'));
    }
    if (input.startsAt === input.endsAt) {
      throw new UnprocessableEntityException(say(
        'Смена длиной в ноль: начало и конец совпадают — по такой смене ничего не спланировать', 'Smena uzunligi nol: boshi va oxiri bir xil — bunday smenaga hech narsa rejalashtirib bo‘lmaydi'));
    }

    await this.prisma.withTenant(async (tx) => {
      const company = await this.company(tx);
      const twin = await tx.$queryRaw<{ uid: string }[]>`
        SELECT uid::text FROM production_shift
         WHERE company_id = ${company.id} AND code = ${code}
           AND (${uid ?? null}::uuid IS NULL OR uid <> ${uid ?? null}::uuid)`;
      if (twin.length > 0) {
        throw new ConflictException(say(`Смена с кодом ${code} уже заведена`, `${code} kodli smena allaqachon kiritilgan`));
      }

      if (uid) {
        const done = await tx.$executeRaw`
          UPDATE production_shift
             SET code = ${code}, name_ru = ${input.nameRu}, name_uz = ${input.nameUz},
                 starts_at = ${input.startsAt}::time, ends_at = ${input.endsAt}::time,
                 is_active = ${input.isActive ?? true}
           WHERE company_id = ${company.id} AND uid = ${uid}::uuid`;
        if (done === 0) throw new NotFoundException(say('Смена не найдена', 'Smena topilmadi'));
      } else {
        await tx.$executeRaw`
          INSERT INTO production_shift (company_id, code, name_ru, name_uz, starts_at, ends_at, is_active)
          VALUES (${company.id}, ${code}, ${input.nameRu}, ${input.nameUz},
                  ${input.startsAt}::time, ${input.endsAt}::time, ${input.isActive ?? true})`;
      }

      await writeAudit(tx, {
        companyId: company.id,
        userId: ctx.userId ?? null,
        action: uid ? 'shift.update' : 'shift.create',
        entityType: 'production_shift',
        entityId: uid ?? code,
        changes: {
          code: { from: null, to: code },
          time: { from: null, to: `${input.startsAt}–${input.endsAt}` },
        },
      });
    });

    return this.view();
  }

  // --- общее для других служб ---------------------------------------------

  /**
   * Рабочие дни периода включительно. Нужен и сроку заказа, и загрузке
   * участка, поэтому живёт здесь, а не в каждой службе своей копией.
   */
  async workingDays(tx: Tx, companyId: bigint, from: string, to: string): Promise<number> {
    const rows = await tx.$queryRaw<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n
        FROM generate_series(${from}::date, ${to}::date, '1 day') d
        LEFT JOIN production_calendar_day c
          ON c.company_id = ${companyId} AND c.day = d::date
        JOIN company co ON co.id = ${companyId}
       WHERE COALESCE(c.is_working, EXTRACT(isodow FROM d)::int = ANY (co.work_days))`;
    return Number(rows[0]?.n ?? 0);
  }

  /** Сколько минут завод работает в рабочий день — сумма активных смен. */
  async dayMinutes(tx: Tx, companyId: bigint): Promise<number> {
    // Время в Postgres заворачивается по кругу суток: `time '00:00' + 24 часа`
    // снова ноль. Поэтому ночную смену считаем секундами, а сутки добавляем
    // числом — иначе смена 16:00–00:00 выходит минус восемь часов.
    const rows = await tx.$queryRaw<{ minutes: string | null }[]>`
      SELECT SUM(
               (EXTRACT(EPOCH FROM ends_at) - EXTRACT(EPOCH FROM starts_at)
                 + CASE WHEN ends_at > starts_at THEN 0 ELSE 86400 END) / 60
             )::text AS minutes
        FROM production_shift
       WHERE company_id = ${companyId} AND is_active`;
    return Math.round(Number(rows[0]?.minutes ?? 0));
  }

  /**
   * Раскладка этапов заказа по сменам (ТЗ 4.1).
   *
   * Норма этапа укладывается в рабочий день подряд: не влезло — переносится на
   * следующий рабочий день. Возвращается и срок по графику, чтобы сразу было
   * видно, успевает ли заказ.
   */
  async scheduleStages(orderUid: string): Promise<{
    stages: { seq: number; nameRu: string; plannedStart: string; plannedEnd: string }[];
    finishesOn: string;
    dueDate: string;
    lateDays: number;
  }> {
    const ctx = this.requireManage();

    return this.prisma.withTenant(async (tx) => {
      const order = await this.orderRow(tx, orderUid);
      const company = await this.company(tx);
      const minutes = await this.dayMinutes(tx, company.id);
      if (minutes <= 0) {
        throw new ConflictException(say(
          'Смены не заведены: разложить этапы по сменам не из чего — заведите смены в календаре', 'Smenalar kiritilmagan: bosqichlarni smenalarga joylashtirish uchun asos yo‘q — kalendarda smena kiriting'));
      }
      const first = await tx.$queryRaw<{ starts_at: string }[]>`
        SELECT to_char(starts_at, 'HH24:MI') AS starts_at FROM production_shift
         WHERE company_id = ${company.id} AND is_active ORDER BY starts_at LIMIT 1`;
      const dayStart = first[0]!.starts_at;

      const stages = await tx.$queryRaw<
        { id: bigint; seq: number; name_ru: string; planned: number }[]
      >`
        SELECT id, seq, name_ru, planned_duration_min AS planned
          FROM production_stage
         WHERE production_order_id = ${order.id}
         ORDER BY seq`;
      if (stages.length === 0) {
        throw new ConflictException(say(
          `У заказа ${order.number} ещё нет этапов: сначала разверните их из техкарты`, `${order.number} buyurtmasida hali bosqich yo‘q: avval ularni texkartadan yoyib oling`));
      }

      // Начинаем с ближайшего рабочего дня: раскладка отвечает на вопрос
      // «когда кончим, если начнём сейчас», а не «когда начинали».
      let day = await this.nextWorkingDay(tx, company.id, this.today());
      let used = 0;
      const out: { seq: number; nameRu: string; plannedStart: string; plannedEnd: string }[] = [];

      for (const s of stages) {
        if (used >= minutes) {
          day = await this.nextWorkingDay(tx, company.id, this.plusDay(day));
          used = 0;
        }
        const startDay = day;
        const startUsed = used;
        let need = Math.max(0, s.planned);
        while (need > 0) {
          const free = minutes - used;
          if (free <= 0) {
            day = await this.nextWorkingDay(tx, company.id, this.plusDay(day));
            used = 0;
            continue;
          }
          const take = Math.min(need, free);
          used += take;
          need -= take;
        }

        const stamp = await tx.$queryRaw<{ started: string; ended: string }[]>`
          SELECT ((${startDay}::date + ${dayStart}::time) + (${startUsed} || ' minutes')::interval)
                   AT TIME ZONE ${TZ} AS started,
                 ((${day}::date + ${dayStart}::time) + (${used} || ' minutes')::interval)
                   AT TIME ZONE ${TZ} AS ended`;
        const row = stamp[0]!;
        await tx.$executeRaw`
          UPDATE production_stage
             SET planned_start = ${row.started}::timestamptz,
                 planned_end = ${row.ended}::timestamptz
           WHERE id = ${s.id}`;
        out.push({
          seq: s.seq,
          nameRu: s.name_ru,
          plannedStart: new Date(row.started).toISOString(),
          plannedEnd: new Date(row.ended).toISOString(),
        });
      }

      const due = order.due_date;
      const late = day > due ? await this.workingDays(tx, company.id, this.plusDay(due), day) : 0;

      await writeAudit(tx, {
        companyId: company.id,
        userId: ctx.userId ?? null,
        action: 'stages.schedule',
        entityType: 'production_order',
        entityId: order.uid,
        changes: {
          finishesOn: { from: null, to: day },
          dueDate: { from: null, to: due },
        },
      });

      return { stages: out, finishesOn: day, dueDate: due, lateDays: late };
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

  private today() {
    return new Date().toLocaleDateString('en-CA', { timeZone: TZ });
  }

  private plusDay(day: string) {
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  }

  /** Ближайший рабочий день, считая и сам `day`. */
  private async nextWorkingDay(tx: Tx, companyId: bigint, day: string): Promise<string> {
    const rows = await tx.$queryRaw<{ day: string }[]>`
      SELECT to_char(d, 'YYYY-MM-DD') AS day
        FROM generate_series(${day}::date, ${day}::date + 60, '1 day') d
        LEFT JOIN production_calendar_day c
          ON c.company_id = ${companyId} AND c.day = d::date
        JOIN company co ON co.id = ${companyId}
       WHERE COALESCE(c.is_working, EXTRACT(isodow FROM d)::int = ANY (co.work_days))
       ORDER BY d LIMIT 1`;
    if (!rows[0]) {
      throw new ConflictException(say(
        'В ближайшие два месяца у завода нет ни одного рабочего дня: проверьте календарь', 'Kelgusi ikki oyda zavodda birorta ish kuni yo‘q: kalendarni tekshiring'));
    }
    return rows[0].day;
  }

  /**
   * Чей календарь. Заголовок `X-Company-Id` сужает контекст до одной компании;
   * если человек работает в нескольких и не выбрал, выбирать за него нельзя —
   * календарь завода и торгового дома это разные календари.
   */
  private async company(tx: Tx): Promise<CompanyRow> {
    const ids = currentContext()?.companyIds ?? [];
    if (ids.length !== 1) {
      throw new BadRequestException(
        MSG.pickCompany(),
      );
    }
    const rows = await tx.$queryRaw<CompanyRow[]>`
      SELECT id, work_days FROM company WHERE id = ${ids[0]}`;
    if (!rows[0]) throw new NotFoundException(MSG.companyNotFound());
    return rows[0];
  }

  private async orderRow(tx: Tx, uid: string) {
    const rows = await tx.$queryRaw<
      { id: bigint; uid: string; number: string; due_date: string; status: string }[]
    >`
      SELECT id, uid::text, number, to_char(due_date, 'YYYY-MM-DD') AS due_date,
             status::text AS status
        FROM production_order WHERE uid = ${uid}::uuid`;
    if (!rows[0]) throw new NotFoundException(MSG.orderNotFound());
    return rows[0];
  }

  private async shiftRows(tx: Tx, companyId: bigint): Promise<ShiftRow[]> {
    const rows = await tx.$queryRaw<
      {
        uid: string;
        code: string;
        name_ru: string;
        name_uz: string;
        starts_at: string;
        ends_at: string;
        duration: string;
        is_active: boolean;
      }[]
    >`
      SELECT uid::text, code, name_ru, name_uz,
             to_char(starts_at, 'HH24:MI') AS starts_at,
             to_char(ends_at, 'HH24:MI') AS ends_at,
             ((EXTRACT(EPOCH FROM ends_at) - EXTRACT(EPOCH FROM starts_at)
                + CASE WHEN ends_at > starts_at THEN 0 ELSE 86400 END) / 60)::text AS duration,
             is_active
        FROM production_shift
       WHERE company_id = ${companyId}
       ORDER BY starts_at, code`;
    return rows.map((r) => ({
      uid: r.uid,
      code: r.code,
      nameRu: r.name_ru,
      nameUz: r.name_uz,
      startsAt: r.starts_at,
      endsAt: r.ends_at,
      durationMin: Math.round(Number(r.duration)),
      isActive: r.is_active,
    }));
  }

  private async range(tx: Tx, from?: string, to?: string) {
    const start = from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : this.today();
    const rows = await tx.$queryRaw<{ to: string }[]>`
      SELECT to_char(${to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? to : null}::date, 'YYYY-MM-DD') AS to`;
    const end = rows[0]?.to ?? null;
    if (end && end < start) {
      throw new UnprocessableEntityException(say('Конец периода раньше начала', 'Davr oxiri boshidan oldin'));
    }
    const auto = new Date(`${start}T00:00:00Z`);
    auto.setUTCDate(auto.getUTCDate() + 30);
    return { from: start, to: end ?? auto.toISOString().slice(0, 10) };
  }

  private async days(tx: Tx, company: CompanyRow, from: string, to: string): Promise<CalendarDayRow[]> {
    const rows = await tx.$queryRaw<
      { day: string; is_working: boolean; is_exception: boolean; comment: string | null }[]
    >`
      SELECT to_char(d, 'YYYY-MM-DD') AS day,
             COALESCE(c.is_working, EXTRACT(isodow FROM d)::int = ANY (${company.work_days}::int[])) AS is_working,
             (c.id IS NOT NULL) AS is_exception,
             c.comment
        FROM generate_series(${from}::date, ${to}::date, '1 day') d
        LEFT JOIN production_calendar_day c
          ON c.company_id = ${company.id} AND c.day = d::date
       ORDER BY d`;
    return rows.map((r) => ({
      day: r.day,
      isWorking: r.is_working,
      isException: r.is_exception,
      comment: r.comment,
    }));
  }

  /** Рабочий ли день по обычной неделе — без исключений. */
  private async usualWorking(tx: Tx, company: CompanyRow, day: string): Promise<boolean> {
    const rows = await tx.$queryRaw<{ usual: boolean }[]>`
      SELECT EXTRACT(isodow FROM ${day}::date)::int = ANY (${company.work_days}::int[]) AS usual`;
    return rows[0]?.usual ?? false;
  }

  /** Как назвать день недели в человеческом тексте. */
  static dayName(iso: number) {
    return DAY_RU[iso] ?? String(iso);
  }
}
