import {
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
import { nameCol } from '../common/name.js';

/**
 * Этапы заказа и фиксация факта (ТЗ 4.1, Э3).
 *
 * До этой службы этапы были только в посеве: карточка заказа показывала ход
 * работы, которого никто не отмечал. Здесь появляются сами задания и отметки
 * по ним — «начал», «пауза», «продолжил», «закончил».
 *
 * Правила, из-за которых это служба, а не поле в форме:
 *
 * - **фактическое время не вводят руками.** Оно складывается из отметок: от
 *   «начал» до «пауза» и от «продолжил» до «закончил». Поле, в которое время
 *   пишут числом, отвечает на вопрос «что написали», а не «сколько шло»;
 * - **пауза без причины не ставится.** Из причин пауз растёт журнал простоев
 *   (ТЗ 4.1): при возобновлении сюда же ложится строка `deviation_log` с
 *   длительностью простоя и той причиной, которую назвали;
 * - **этапы разворачиваются из техкарты той версии, которую помнит заказ.**
 *   Карту потом поправят новой версией — у этого заказа норма останется той,
 *   по которой его завели;
 * - **рабочий отмечает только свои этапы.** Право `production.work` даёт
 *   отметку по этапу, где он ответственный (или ответственный за весь заказ);
 *   `production.manage` — по любому. Чужая отметка — это чужая смена и чужая
 *   выработка;
 * - **этапы заводятся до запуска.** Пока заказ не начат, список можно
 *   перезаписать целиком; после первой отметки — нельзя: это уже история.
 *
 * Чего здесь сознательно нет:
 *
 * - **порядка этапов.** Запретить начать второй этап раньше первого легко, но
 *   у этапа заказа нет признака параллельности — он есть только в техкарте
 *   (`tech_card_stage.is_parallel`). Строгий порядок запретил бы то, что цех
 *   делает параллельно, а это хуже, чем отсутствие проверки. Появится вместе с
 *   календарём (Э7), где у этапа будут свои сроки;
 * - **плановых дат этапа.** `planned_start` и `planned_end` остаются пустыми:
 *   разложить норму по датам нельзя без графика смен — это Э7;
 * - **выпуска по завершению последнего этапа.** Закрытый этап означает, что
 *   работа сделана, а не что продукция принята на склад: приход — Э5.
 */

export type StageMark = 'start' | 'pause' | 'resume' | 'finish';

export type StageStatusName = 'pending' | 'running' | 'paused' | 'done' | 'skipped';

export type StageInput = {
  seq: number;
  nameRu: string;
  nameUz: string;
  workCenterCode?: string;
  /** Кому поручен этап. Пусто — отмечает тот, кто ведёт заказ. */
  responsibleUid?: string;
  plannedDurationMin: number;
};

export type StageBrief = {
  seq: number;
  nameRu: string;
  status: StageStatusName;
  actualDurationMin: number;
  orderStatus: string;
};

type OrderRow = {
  id: bigint;
  uid: string;
  company_id: bigint;
  number: string;
  status: string;
  qty_planned: string;
  tech_card_id: bigint | null;
  tech_card_version: number | null;
  responsible_id: bigint | null;
};

type StageRow = {
  id: bigint;
  seq: number;
  name_ru: string;
  /** То же название на языке запроса: оно попадает в текст отказа. */
  name: string;
  status: StageStatusName;
  responsible_id: bigint | null;
  actual_duration_min: number;
};

/** Что можно нажать на этапе в этом состоянии. */
const NEXT_MARK: Record<StageStatusName, StageMark[]> = {
  pending: ['start'],
  running: ['pause', 'finish'],
  paused: ['resume'],
  done: [],
  skipped: [],
};

const MARK_TO_STATUS: Record<StageMark, StageStatusName> = {
  start: 'running',
  pause: 'paused',
  resume: 'running',
  finish: 'done',
};

/** Названия отметок на языке запроса: они попадают в текст отказа. */
const markName = (): Record<StageMark, string> => ({
  start: say('начать', 'boshlash'),
  pause: say('поставить на паузу', 'to‘xtatib qo‘yish'),
  resume: say('продолжить', 'davom ettirish'),
  finish: say('закончить', 'tugatish'),
});

@Injectable()
export class ProductionStagesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Развернуть этапы заказа из его техкарты.
   *
   * Норма карты задана на одну единицу продукции, поэтому план этапа — норма
   * на количество заказа, округлённая вверх: полминуты работы всё равно
   * занимают человека и станок.
   */
  async planFromCard(orderUid: string): Promise<StageBrief[]> {
    this.requireManage();

    return this.prisma.withTenant(async (tx) => {
      const order = await this.orderRow(tx, orderUid);
      this.mustBeOpen(order);
      await this.noMarks(tx, order);

      if (!order.tech_card_id) {
        throw new UnprocessableEntityException(say(
          `У заказа ${order.number} нет техкарты: заведите карту на эту продукцию ` +
            'и введите её в работу или добавьте этапы руками', `${order.number} buyurtmasida texkarta yo‘q: bu mahsulotga karta kiriting ` + 'va uni ishga tushiring yoki bosqichlarni qo‘lda qo‘shing'));
      }

      const card = await tx.$queryRaw<
        {
          seq: number;
          name_ru: string;
          name_uz: string;
          norm_duration_min: number;
          work_center_id: bigint | null;
        }[]
      >`
        SELECT seq, name_ru, name_uz, norm_duration_min, work_center_id
          FROM tech_card_stage WHERE tech_card_id = ${order.tech_card_id} ORDER BY seq`;
      if (card.length === 0) {
        throw new UnprocessableEntityException(say(
          `В техкарте заказа ${order.number} нет этапов: разворачивать нечего`, `${order.number} buyurtmasining texkartasida bosqich yo‘q: yoyish uchun narsa yo‘q`));
      }

      const qty = Number(order.qty_planned);
      await tx.$executeRaw`DELETE FROM production_stage WHERE production_order_id = ${order.id}`;
      for (const s of card) {
        await tx.$executeRaw`
          INSERT INTO production_stage
            (production_order_id, seq, name_ru, name_uz, work_center_id, responsible_id,
             planned_duration_min, status)
          VALUES (${order.id}, ${s.seq}, ${s.name_ru}, ${s.name_uz}, ${s.work_center_id},
                  ${order.responsible_id}, ${Math.ceil(s.norm_duration_min * qty)}, 'pending')`;
      }

      await writeAudit(tx, {
        companyId: order.company_id,
        entityType: 'production_order',
        entityId: order.uid,
        action: 'stage.plan',
        changes: {
          number: { from: null, to: order.number },
          stages: { from: null, to: card.length },
          techCardVersion: { from: null, to: order.tech_card_version },
        },
      });

      return this.briefs(tx, order);
    });
  }

  /**
   * Задать этапы руками — целиком, а не по строке.
   *
   * Правка плана работ это правка целого: убрали этап, перенумеровали
   * остальные. Отдельные маршруты на строку заставили бы экран выстраивать
   * порядок вызовов, и половина правки доезжала бы при обрыве.
   */
  async replace(orderUid: string, stages: StageInput[]): Promise<StageBrief[]> {
    this.requireManage();

    return this.prisma.withTenant(async (tx) => {
      const order = await this.orderRow(tx, orderUid);
      this.mustBeOpen(order);
      await this.noMarks(tx, order);

      if (stages.length === 0) {
        throw new UnprocessableEntityException(say(
          'Список этапов пуст: заказ без этапов запустить нельзя, нормировать нечего', 'Bosqichlar ro‘yxati bo‘sh: bosqichsiz buyurtmani ishga tushirib bo‘lmaydi, me’yorlash uchun narsa yo‘q'));
      }
      const seqs = stages.map((s) => s.seq).sort((a, b) => a - b);
      const gap = seqs.findIndex((v, i) => v !== i + 1);
      if (gap !== -1) {
        throw new UnprocessableEntityException(say(
          `Этапы нумеруются подряд с 1: пришло ${seqs.join(', ')}`, `Bosqichlar 1 dan ketma-ket raqamlanadi: kelgani ${seqs.join(', ')}`));
      }

      await tx.$executeRaw`DELETE FROM production_stage WHERE production_order_id = ${order.id}`;
      for (const s of stages) {
        const workCenterId = s.workCenterCode
          ? await this.workCenterId(tx, order.company_id, s.workCenterCode)
          : null;
        const responsibleId = s.responsibleUid
          ? await this.userId(tx, s.responsibleUid)
          : order.responsible_id;
        await tx.$executeRaw`
          INSERT INTO production_stage
            (production_order_id, seq, name_ru, name_uz, work_center_id, responsible_id,
             planned_duration_min, status)
          VALUES (${order.id}, ${s.seq}, ${this.text(s.nameRu, 'Название этапа')},
                  ${this.text(s.nameUz, 'Nomi')}, ${workCenterId}, ${responsibleId},
                  ${this.minutes(s.plannedDurationMin)}, 'pending')`;
      }

      await writeAudit(tx, {
        companyId: order.company_id,
        entityType: 'production_order',
        entityId: order.uid,
        action: 'stage.plan',
        changes: {
          number: { from: null, to: order.number },
          stages: { from: null, to: stages.length },
        },
      });

      return this.briefs(tx, order);
    });
  }

  /**
   * Отметка по этапу: начал, пауза, продолжил, закончил.
   *
   * Время берётся из часов базы, а не из браузера: у телефона в цеху часы
   * свои, и выработка смены не должна от них зависеть.
   */
  async mark(
    orderUid: string,
    seq: number,
    kind: StageMark,
    input: { reasonUid?: string; comment?: string } = {},
  ): Promise<StageBrief> {
    const ctx = this.requireWork();

    return this.prisma.withTenant(async (tx) => {
      const order = await this.orderRow(tx, orderUid);
      const stage = await this.stageRow(tx, order, seq);

      if (order.status !== 'in_progress') {
        throw new ConflictException(say(
          `Заказ ${order.number} не в работе (статус «${order.status}»): ` +
            'запускает заказ начальник производства кнопкой «Запустить»', `${order.number} buyurtmasi ishda emas (holat «${order.status}»): ` + 'buyurtmani ishlab chiqarish boshlig‘i «Ishga tushirish» tugmasi bilan boshlaydi'));
      }

      this.mustBeMine(ctx, order, stage);

      const allowed = NEXT_MARK[stage.status];
      if (!allowed.includes(kind)) {
        const name = markName();
        const where =
          allowed.length === 0
            ? say('ничего: этап уже закрыт', 'hech narsa: bosqich allaqachon yopilgan')
            : allowed.map((m) => `«${name[m]}»`).join(', ');
        throw new ConflictException(
          say(
            `Этап ${stage.seq} «${stage.name}» нельзя ${name[kind]}: ` +
              `он в состоянии «${stage.status}», здесь можно ${where}`,
            `${stage.seq}-bosqich «${stage.name}»: ${name[kind]} mumkin emas — ` +
              `u «${stage.status}» holatida, bu yerda ${where} mumkin`,
          ),
        );
      }

      let reasonId: bigint | null = null;
      if (kind === 'pause') {
        if (!input.reasonUid) {
          throw new UnprocessableEntityException(say(
            'Выберите причину остановки: из неё складывается журнал простоев, ' +
              'и без неё в нём останется только «кто-то нажал»', 'To‘xtash sababini tanlang: to‘xtashlar jurnali shundan yig‘iladi, ' + 'usiz jurnalda faqat «kimdir bosdi» qoladi'));
        }
        reasonId = await this.downtimeReasonId(tx, order.company_id, input.reasonUid);
      }

      const comment = this.comment(input.comment);

      /** Последняя отметка: от неё считается и работа, и простой. */
      const last = await tx.$queryRaw<{ occurred_at: Date; event: string; reason_id: bigint | null }[]>`
        SELECT occurred_at, event::text AS event, reason_id FROM production_stage_event
         WHERE stage_id = ${stage.id} ORDER BY occurred_at DESC, id DESC LIMIT 1`;
      const since = last[0]?.occurred_at ?? null;

      await tx.$executeRaw`
        INSERT INTO production_stage_event (stage_id, event, user_id, reason_id, comment)
        VALUES (${stage.id}, ${kind}::"StageEvent", ${ctx.userId ?? null}, ${reasonId}, ${comment})`;

      if (kind === 'pause' || kind === 'finish') {
        // Закрылся отрезок работы: от «начал» или «продолжил» до сейчас.
        await tx.$executeRaw`
          UPDATE production_stage
             SET actual_duration_min = actual_duration_min
                   + greatest(0, round(extract(epoch FROM (now() - ${since}::timestamptz)) / 60))::int,
                 status = ${MARK_TO_STATUS[kind]}::"StageStatus"
           WHERE id = ${stage.id}`;
      } else {
        await tx.$executeRaw`
          UPDATE production_stage SET status = ${MARK_TO_STATUS[kind]}::"StageStatus"
           WHERE id = ${stage.id}`;
      }

      if (kind === 'resume' && since) {
        // Закрылся простой: сколько стояли и почему — в журнал отклонений.
        await tx.$executeRaw`
          INSERT INTO deviation_log
            (company_id, production_order_id, stage_id, kind, reason_id, duration_min,
             comment, registered_by)
          SELECT ${order.company_id}, ${order.id}, ${stage.id}, 'downtime', ${last[0].reason_id},
                 greatest(0, round(extract(epoch FROM (now() - ${since}::timestamptz)) / 60))::int,
                 ${comment}, ${ctx.userId ?? null}`;
      }

      await writeAudit(tx, {
        companyId: order.company_id,
        entityType: 'production_order',
        entityId: order.uid,
        action: `stage.${kind}`,
        changes: {
          number: { from: null, to: order.number },
          stage: { from: null, to: `${stage.seq} ${stage.name}` },
          status: { from: stage.status, to: MARK_TO_STATUS[kind] },
          ...(comment ? { comment: { from: null, to: comment } } : {}),
        },
      });

      const after = await this.stageRow(tx, order, seq);
      return {
        seq: after.seq,
        nameRu: after.name_ru,
        status: after.status,
        actualDurationMin: after.actual_duration_min,
        orderStatus: order.status,
      };
    });
  }

  /**
   * Мои задания: этапы, которые отмечать мне.
   *
   * Рабочему незачем искать свой этап в чужих заказах — список собран по нему
   * самому. Начальнику производства он тоже отвечает: у него тут свои этапы, а
   * не весь цех.
   */
  async mine(limit: number) {
    const ctx = this.requireView();

    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.$queryRaw<
        {
          order_uid: string;
          number: string;
          due_date: Date;
          order_status: string;
          item_code: string;
          item_name_ru: string;
          item_name_uz: string;
          seq: number;
          name_ru: string;
          name_uz: string;
          status: StageStatusName;
          planned_duration_min: number;
          actual_duration_min: number;
          wc_code: string | null;
          wc_name_ru: string | null;
          wc_name_uz: string | null;
          last_event: string | null;
          last_at: Date | null;
        }[]
      >`
        SELECT o.uid::text AS order_uid, o.number, o.due_date, o.status::text AS order_status,
               i.code AS item_code, i.name_ru AS item_name_ru, i.name_uz AS item_name_uz,
               s.seq, s.name_ru, s.name_uz, s.status::text AS status,
               s.planned_duration_min, s.actual_duration_min,
               w.code AS wc_code, w.name_ru AS wc_name_ru, w.name_uz AS wc_name_uz,
               e.event::text AS last_event, e.occurred_at AS last_at
          FROM production_stage s
          JOIN production_order o ON o.id = s.production_order_id
          JOIN item i ON i.id = o.item_id
          LEFT JOIN work_center w ON w.id = s.work_center_id
          LEFT JOIN LATERAL (
            SELECT event, occurred_at FROM production_stage_event
             WHERE stage_id = s.id ORDER BY occurred_at DESC, id DESC LIMIT 1
          ) e ON true
         WHERE o.status IN ('planned', 'in_progress')
           AND s.status NOT IN ('done', 'skipped')
           AND ${ctx.userId ?? null}::bigint IS NOT NULL
           AND (s.responsible_id = ${ctx.userId ?? null}::bigint
                OR (s.responsible_id IS NULL AND o.responsible_id = ${ctx.userId ?? null}::bigint))
         ORDER BY o.due_date, o.number, s.seq
         LIMIT ${limit}`;

      return {
        rows: rows.map((r) => ({
          orderUid: r.order_uid,
          orderNumber: r.number,
          orderStatus: r.order_status,
          dueDate: r.due_date.toISOString().slice(0, 10),
          itemCode: r.item_code,
          itemNameRu: r.item_name_ru,
          itemNameUz: r.item_name_uz,
          seq: r.seq,
          nameRu: r.name_ru,
          nameUz: r.name_uz,
          status: r.status,
          plannedDurationMin: r.planned_duration_min,
          actualDurationMin: r.actual_duration_min,
          workCenterCode: r.wc_code,
          workCenterNameRu: r.wc_name_ru,
          workCenterNameUz: r.wc_name_uz,
          /** Что сейчас можно нажать — считает сервер, а не экран. */
          marks: NEXT_MARK[r.status],
          runningSince:
            r.last_event === 'start' || r.last_event === 'resume'
              ? (r.last_at?.toISOString() ?? null)
              : null,
          pausedSince: r.last_event === 'pause' ? (r.last_at?.toISOString() ?? null) : null,
        })),
      };
    });
  }

  // --- внутреннее ----------------------------------------------------------

  private async briefs(tx: Tx, order: OrderRow): Promise<StageBrief[]> {
    const rows = await tx.$queryRaw<
      { seq: number; name_ru: string; status: StageStatusName; actual_duration_min: number }[]
    >`
      SELECT seq, name_ru, status::text AS status, actual_duration_min
        FROM production_stage WHERE production_order_id = ${order.id} ORDER BY seq`;
    return rows.map((r) => ({
      seq: r.seq,
      nameRu: r.name_ru,
      status: r.status,
      actualDurationMin: r.actual_duration_min,
      orderStatus: order.status,
    }));
  }

  /**
   * Что сделано, то сделано: по выпущенному, закрытому и отменённому заказу
   * план работ не переписывают. Пока заказ идёт — можно, но только если по
   * этапам ещё никто не отработал: это проверяет `noMarks`.
   */
  private mustBeOpen(order: OrderRow) {
    if (!['produced', 'closed', 'cancelled'].includes(order.status)) return;
    throw new ConflictException(say(
      `Заказ ${order.number} уже не в работе (статус «${order.status}»): ` +
        'план работ по нему переписывать нечего', `${order.number} buyurtmasi endi ishda emas (holat «${order.status}»): ` + 'uning ish rejasini qayta yozishga hojat yo‘q'));
  }

  /**
   * План работ меняют, пока по нему никто не отработал.
   *
   * Правило не про статус заказа, а про труд: заказ запустили утром, мастер
   * увидел, что забыли этап, — пусть поправит. А после первой отметки список
   * этапов это уже история смены, и перезапись стёрла бы отработанное время
   * вместе с событиями, из которых оно посчитано.
   */
  private async noMarks(tx: Tx, order: OrderRow): Promise<void> {
    const marked = await tx.$queryRaw<{ seq: number }[]>`
      SELECT s.seq FROM production_stage s
       WHERE s.production_order_id = ${order.id}
         AND (s.status <> 'pending'
              OR EXISTS (SELECT 1 FROM production_stage_event e WHERE e.stage_id = s.id))
       ORDER BY s.seq LIMIT 1`;
    if (marked[0]) {
      throw new ConflictException(say(
        `По этапу ${marked[0].seq} заказа ${order.number} уже есть отметки: ` +
          'переписать план работ нельзя, иначе пропадёт отработанное время', `${order.number} buyurtmasining ${marked[0].seq}-bosqichida belgilar bor: ` + 'ish rejasini qayta yozib bo‘lmaydi, aks holda ishlangan vaqt yo‘qoladi'));
    }
  }

  private mustBeMine(
    ctx: ReturnType<typeof currentContext> & object,
    order: OrderRow,
    stage: StageRow,
  ) {
    if (ctx.permissions.has('production.manage')) return;
    const me = ctx.userId ?? null;
    const own =
      me !== null &&
      (stage.responsible_id === me || (stage.responsible_id === null && order.responsible_id === me));
    if (own) return;
    throw new ForbiddenException(
      say(
        `Этап ${stage.seq} «${stage.name}» поручен не вам: отмечают свою работу, а не чужую`,
        `${stage.seq}-bosqich «${stage.name}» sizga topshirilmagan: o‘z ishini belgilaydi, boshqaning emas`,
      ),
    );
  }

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

  private requireWork() {
    const ctx = currentContext();
    if (!ctx?.permissions.has('production.work') && !ctx?.permissions.has('production.manage')) {
      throw new ForbiddenException(MSG.noRight('production.work'));
    }
    return ctx!;
  }

  private async orderRow(tx: Tx, uid: string): Promise<OrderRow> {
    if (!/^[0-9a-f-]{36}$/i.test(uid)) throw new NotFoundException(MSG.orderNotFound());
    const rows = await tx.$queryRaw<OrderRow[]>`
      SELECT id, uid::text AS uid, company_id, number, status::text AS status,
             qty_planned::text AS qty_planned, tech_card_id, tech_card_version, responsible_id
        FROM production_order WHERE uid = ${uid}::uuid`;
    if (!rows[0]) throw new NotFoundException(MSG.orderNotFound());
    return rows[0];
  }

  private async stageRow(tx: Tx, order: OrderRow, seq: number): Promise<StageRow> {
    const rows = await tx.$queryRaw<StageRow[]>`
      SELECT id, seq, name_ru, ${nameCol('production_stage')} AS name, status::text AS status,
             responsible_id, actual_duration_min
        FROM production_stage
       WHERE production_order_id = ${order.id} AND seq = ${seq}`;
    if (!rows[0]) {
      throw new NotFoundException(say(`В заказе ${order.number} нет этапа ${seq}`, `${order.number} buyurtmasida ${seq}-bosqich yo‘q`));
    }
    return rows[0];
  }

  private async downtimeReasonId(tx: Tx, companyId: bigint, uid: string): Promise<bigint> {
    if (!/^[0-9a-f-]{36}$/i.test(uid)) {
      throw new UnprocessableEntityException(say('Причина остановки не найдена', 'To‘xtash sababi topilmadi'));
    }
    const rows = await tx.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM stock_reason
       WHERE uid = ${uid}::uuid AND company_id = ${companyId} AND kind = 'downtime' AND is_active`;
    if (!rows[0]) {
      throw new UnprocessableEntityException(say(
        'Причина остановки не найдена или выключена: выберите из списка причин простоя', 'To‘xtash sababi topilmadi yoki o‘chirilgan: to‘xtash sabablari ro‘yxatidan tanlang'));
    }
    return rows[0].id;
  }

  private async workCenterId(tx: Tx, companyId: bigint, code: string): Promise<bigint> {
    const rows = await tx.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM work_center
       WHERE company_id = ${companyId} AND code = ${String(code).trim()} AND is_active`;
    if (!rows[0]) {
      throw new UnprocessableEntityException(say(`Рабочий центр ${code} не найден или выключен`, `${code} ish markazi topilmadi yoki o‘chirilgan`));
    }
    return rows[0].id;
  }

  private async userId(tx: Tx, uid: string): Promise<bigint> {
    if (!/^[0-9a-f-]{36}$/i.test(uid)) {
      throw new UnprocessableEntityException(say('Ответственный не найден', 'Mas’ul topilmadi'));
    }
    const rows = await tx.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM user_account WHERE uid = ${uid}::uuid AND is_active`;
    if (!rows[0]) throw new UnprocessableEntityException(say('Ответственный не найден или отключён', 'Mas’ul topilmadi yoki o‘chirilgan'));
    return rows[0].id;
  }

  private text(raw: string, what: string): string {
    const value = String(raw ?? '').trim();
    if (value === '') throw new UnprocessableEntityException(say(`${what}: пустая строка не годится`, `${what}: bo‘sh satr to‘g‘ri kelmaydi`));
    if (value.length > 200) throw new UnprocessableEntityException(say(`${what} длиннее 200 знаков`, `${what} 200 belgidan uzun`));
    return value;
  }

  private minutes(raw: number): number {
    if (!Number.isInteger(raw) || raw < 0 || raw > 1_000_000) {
      throw new UnprocessableEntityException(say(
        'План этапа — целое число минут от 0 до 1 000 000', 'Bosqich rejasi — 0 dan 1 000 000 gacha butun daqiqa'));
    }
    return raw;
  }

  private comment(raw: string | undefined): string | null {
    const value = String(raw ?? '').trim();
    if (value === '') return null;
    if (value.length > 500) {
      throw new UnprocessableEntityException(MSG.commentTooLong());
    }
    return value;
  }
}
