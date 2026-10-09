import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { NEXT_STATUS } from './write.service.js';
import { MSG } from '../common/messages.js';

/**
 * Состояние заказа глазами цеха. В модели статусов больше (`draft`,
 * `cancelled`), но на экране мастера они ничего не меняют: черновик ещё
 * не работа, отменённый — уже не работа.
 */
export type State = 'all' | 'planned' | 'active' | 'done';

const STATE_WHERE: Record<Exclude<State, 'all'>, object> = {
  planned: { status: { in: ['draft', 'planned'] as const } },
  active: { status: { in: ['in_progress', 'paused'] as const } },
  done: { status: { in: ['produced', 'closed'] as const } },
};

const money = (v: unknown) => Number(v ?? 0).toFixed(4);
const qty = (v: unknown) => Number(v ?? 0).toFixed(6);
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

/**
 * Доля выпуска от плана. База — план: нулевой план означает, что доли нет,
 * а не что выполнено ноль процентов.
 */
const percent = (part: number, whole: number): string | null =>
  whole === 0 ? null : ((part / whole) * 100).toFixed(1);

@Injectable()
export class ProductionOrdersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Список заказов страницами (Э8).
   *
   * Отдаём `rows` и `total`, как остальные списки системы: без общего числа
   * человек не знает, где он — на первой странице из трёх или видит всё.
   */
  async list(state: State, search: string | undefined, limit: number, offset = 0) {
    return this.prisma.withTenant(async (tx) => {
      const term = search?.trim();
      const where = {
        status: { not: 'cancelled' as const },
        ...(state === 'all' ? {} : STATE_WHERE[state]),
        ...(term
          ? {
              OR: [
                { number: { contains: term, mode: 'insensitive' as const } },
                { item: { nameRu: { contains: term, mode: 'insensitive' as const } } },
                { item: { nameUz: { contains: term, mode: 'insensitive' as const } } },
                { item: { code: { contains: term, mode: 'insensitive' as const } } },
              ],
            }
          : {}),
      };

      const total = await tx.productionOrder.count({ where });
      const rows = await tx.productionOrder.findMany({
        where,
        orderBy: [{ dueDate: 'desc' }, { number: 'desc' }],
        take: limit,
        skip: offset,
        select: {
          uid: true,
          number: true,
          dueDate: true,
          status: true,
          priority: true,
          qtyPlanned: true,
          qtyProduced: true,
          qtyDefect: true,
          qtyWaste: true,
          unit: { select: { code: true } },
          item: { select: { code: true, nameRu: true, nameUz: true } },
          responsible: { select: { fullName: true } },
          company: { select: { code: true } },
          stages: { select: { status: true } },
        },
      });

      const list = rows.map((o) => {
        const done = o.stages.filter((s) => s.status === 'done' || s.status === 'skipped').length;
        return {
          uid: o.uid,
          number: o.number,
          enterprise: o.company.code,
          itemCode: o.item.code,
          itemNameRu: o.item.nameRu,
          itemNameUz: o.item.nameUz,
          unit: o.unit.code,
          dueDate: day(o.dueDate),
          status: o.status,
          priority: o.priority,
          responsibleName: o.responsible?.fullName ?? null,
          qtyPlanned: qty(o.qtyPlanned),
          qtyProduced: qty(o.qtyProduced),
          qtyDefect: qty(o.qtyDefect),
          qtyWaste: qty(o.qtyWaste),
          // Два разных прогресса, и они намеренно не слиты в один: по этапам
          // работа может быть почти закончена, а выпуска ещё не быть.
          qtyPercent: percent(Number(o.qtyProduced), Number(o.qtyPlanned)),
          stagesDone: done,
          stagesTotal: o.stages.length,
        };
      });

      return { rows: list, total, limit, offset };
    });
  }

  /**
   * Заказ целиком. Чужая компания сюда не попадёт не проверкой в коде, а
   * политикой RLS: строка не вернётся, и ответ будет 404 — тот же, что для
   * несуществующего заказа. Разные ответы на «нет» и «не твоё» дают способ
   * пересчитать чужие заказы.
   */
  async one(uid: string) {
    return this.prisma.withTenant(async (tx) => {
      const o = await tx.productionOrder.findFirst({
        where: { uid },
        select: {
          uid: true,
          companyId: true,
          number: true,
          dueDate: true,
          status: true,
          priority: true,
          qtyPlanned: true,
          qtyProduced: true,
          qtyDefect: true,
          qtyWaste: true,
          startedAt: true,
          finishedAt: true,
          closedAt: true,
          comment: true,
          techCardVersion: true,
          unit: { select: { code: true } },
          item: { select: { code: true, nameRu: true, nameUz: true } },
          company: { select: { code: true, nameRu: true, nameUz: true } },
          // Не только имя: форма правки подставляет ответственного обратно, а
          // по имени этого не сделать — отправив пустое поле, она бы его сняла.
          responsible: { select: { uid: true, fullName: true } },
          techCard: { select: { nameRu: true, nameUz: true, version: true } },
          salesOrder: {
            select: { uid: true, number: true, partner: { select: { nameRu: true, nameUz: true } } },
          },
          stages: {
            orderBy: { seq: 'asc' },
            select: {
              // uid этапа нужен карточке, чтобы спросить его файлы: вложение
              // адресует владельца uid, а не парой «заказ и номер».
              uid: true,
              seq: true,
              nameRu: true,
              nameUz: true,
              status: true,
              plannedDurationMin: true,
              actualDurationMin: true,
              plannedStart: true,
              plannedEnd: true,
              comment: true,
              workCenter: { select: { code: true, nameRu: true, nameUz: true } },
              // Кто нажал, в ответе нет: `production_stage_event.user_id`
              // не связан с `user_account` внешним ключом, как и ещё десяток
              // таких же колонок в схеме. Показывать имя по нему — значит
              // обещать, что оно верное; отдельная задача со связью и
              // миграцией, а не строчка в этом select.
              events: {
                orderBy: { occurredAt: 'asc' },
                select: {
                  event: true,
                  occurredAt: true,
                  comment: true,
                  reason: { select: { nameRu: true, nameUz: true } },
                },
              },
              deviations: {
                where: { kind: 'downtime' },
                select: { durationMin: true },
              },
            },
          },
          materials: {
            orderBy: { id: 'asc' },
            select: {
              qtyPlanned: true,
              qtyIssued: true,
              qtyUsed: true,
              qtyReturned: true,
              costTotal: true,
              item: { select: { code: true, nameRu: true, nameUz: true } },
              unit: { select: { code: true } },
            },
          },
          outputs: {
            orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
            select: {
              kind: true,
              qty: true,
              occurredAt: true,
              stage: { select: { seq: true } },
              batch: { select: { number: true } },
              reason: { select: { nameRu: true, nameUz: true } },
              item: {
                select: { code: true, nameRu: true, nameUz: true, baseUnit: { select: { code: true } } },
              },
            },
          },
          // Переделки этого заказа: дочерние заказы на тот же товар. Видеть их
          // надо из родителя, иначе брак выглядит исчезнувшим.
          reworks: {
            orderBy: { id: 'asc' },
            select: { uid: true, number: true, status: true, qtyPlanned: true },
          },
          parentOrder: { select: { uid: true, number: true } },
          costs: {
            where: { isCurrent: true },
            orderBy: { calculatedAt: 'desc' },
            take: 1,
            select: {
              calculatedAt: true,
              materialCost: true,
              semiCost: true,
              directCost: true,
              reworkCost: true,
              totalCost: true,
              qtyGood: true,
              unitCost: true,
            },
          },
        },
      });

      if (!o) throw new NotFoundException(MSG.orderNotFound());

      /**
       * Последняя названная причина перехода — из журнала действий.
       *
       * Своего поля под неё у заказа нет намеренно: причина остановки не
       * заменяет примечание «зачем этот заказ», а заводить второе поле ради
       * того, что и так лежит в журнале, значит держать два источника одной
       * правды. Берётся одна строка, по индексу `audit_log(entity_type,
       * entity_id)`.
       */
      const reason = await tx.$queryRaw<{ reason: string; occurred_at: Date }[]>`
        SELECT changes -> 'comment' ->> 'to' AS reason, occurred_at
          FROM audit_log
         WHERE entity_type = 'production_order' AND entity_id = ${uid}
           AND action = 'status' AND changes -> 'comment' ->> 'to' IS NOT NULL
         ORDER BY occurred_at DESC, id DESC
         LIMIT 1`;

      const cost = o.costs[0] ?? null;

      /**
       * Сколько рабочих дней до срока (Э7).
       *
       * «Осталось два дня» и «осталось два рабочих дня» — разные вещи, если
       * между ними воскресенье. Считаем по календарю завода; у заказа, работа
       * по которому кончилась, срок уже ничего не значит, и цифры нет.
       */
      const live = !['produced', 'closed', 'cancelled'].includes(o.status);
      const due = live
        ? await tx.$queryRaw<{ left: number; overdue: number; due_working: boolean }[]>`
            SELECT (SELECT count(*)::int FROM generate_series(current_date, ${o.dueDate}::date, '1 day') d
                     LEFT JOIN production_calendar_day c
                       ON c.company_id = ${o.companyId} AND c.day = d::date
                     JOIN company co ON co.id = ${o.companyId}
                    WHERE COALESCE(c.is_working, EXTRACT(isodow FROM d)::int = ANY (co.work_days))
                      AND ${o.dueDate}::date >= current_date) AS left,
                   (SELECT count(*)::int FROM generate_series(${o.dueDate}::date + 1, current_date, '1 day') d
                     LEFT JOIN production_calendar_day c
                       ON c.company_id = ${o.companyId} AND c.day = d::date
                     JOIN company co ON co.id = ${o.companyId}
                    WHERE COALESCE(c.is_working, EXTRACT(isodow FROM d)::int = ANY (co.work_days))
                      AND ${o.dueDate}::date < current_date) AS overdue,
                   (SELECT COALESCE(c.is_working,
                                    EXTRACT(isodow FROM ${o.dueDate}::date)::int = ANY (co.work_days))
                      FROM company co
                      LEFT JOIN production_calendar_day c
                        ON c.company_id = co.id AND c.day = ${o.dueDate}::date
                     WHERE co.id = ${o.companyId}) AS due_working`
        : [];

      return {
        uid: o.uid,
        number: o.number,
        enterprise: o.company.code,
        enterpriseNameRu: o.company.nameRu,
        enterpriseNameUz: o.company.nameUz,
        itemCode: o.item.code,
        itemNameRu: o.item.nameRu,
        itemNameUz: o.item.nameUz,
        unit: o.unit.code,
        dueDate: day(o.dueDate),
        /** Рабочих дней до срока включительно; просрочка — своим числом. */
        workDaysLeft: due[0] ? due[0].left : null,
        workDaysOverdue: due[0] ? due[0].overdue : null,
        /** Срок выпал на выходной — цех об этом должен знать заранее. */
        dueOnWorkingDay: due[0] ? due[0].due_working : null,
        status: o.status,
        priority: o.priority,
        responsibleName: o.responsible?.fullName ?? null,
        responsibleUid: o.responsible?.uid ?? null,
        startedAt: o.startedAt?.toISOString() ?? null,
        finishedAt: o.finishedAt?.toISOString() ?? null,
        closedAt: o.closedAt?.toISOString() ?? null,
        comment: o.comment,
        /** Почему остановили или отменили: последняя причина из журнала. */
        statusReason: reason[0]?.reason ?? null,
        statusReasonAt: reason[0]?.occurred_at.toISOString() ?? null,
        /**
         * Куда заказ можно перевести — считает сервер, а не экран.
         *
         * Правило одно, кнопок двое: экран в браузере и бот. Своя копия
         * таблицы переходов на экране однажды разошлась бы с проверкой на
         * сервере, и человек увидел бы кнопку, на которую ему ответят 409.
         */
        nextStatuses: NEXT_STATUS[o.status],
        canEdit: o.status === 'draft',
        techCardNameRu: o.techCard?.nameRu ?? null,
        techCardNameUz: o.techCard?.nameUz ?? null,
        techCardVersion: o.techCardVersion ?? o.techCard?.version ?? null,
        salesOrderUid: o.salesOrder?.uid ?? null,
        salesOrderNumber: o.salesOrder?.number ?? null,
        salesPartnerRu: o.salesOrder?.partner.nameRu ?? null,
        salesPartnerUz: o.salesOrder?.partner.nameUz ?? null,
        qtyPlanned: qty(o.qtyPlanned),
        qtyProduced: qty(o.qtyProduced),
        qtyDefect: qty(o.qtyDefect),
        qtyWaste: qty(o.qtyWaste),
        qtyPercent: percent(Number(o.qtyProduced), Number(o.qtyPlanned)),
        stages: o.stages.map((s) => {
          const last = s.events.at(-1) ?? null;
          const open = last && (last.event === 'start' || last.event === 'resume') ? last : null;
          const pause = last?.event === 'pause' ? last : null;
          return {
            uid: s.uid,
            seq: s.seq,
            nameRu: s.nameRu,
            nameUz: s.nameUz,
            status: s.status,
            workCenterCode: s.workCenter?.code ?? null,
            workCenterNameRu: s.workCenter?.nameRu ?? null,
            workCenterNameUz: s.workCenter?.nameUz ?? null,
            plannedStart: s.plannedStart?.toISOString() ?? null,
            plannedEnd: s.plannedEnd?.toISOString() ?? null,
            plannedDurationMin: s.plannedDurationMin,
            // Закрытое время работы: столько этап уже отработал по журналу.
            actualDurationMin: s.actualDurationMin,
            // Незакрытый отрезок не приписан к факту: фронт покажет его как
            // «идёт с такого-то времени», а не подмешает в сумму минут.
            runningSince: open ? open.occurredAt.toISOString() : null,
            pausedSince: pause ? pause.occurredAt.toISOString() : null,
            pauseReasonRu: pause?.reason?.nameRu ?? null,
            pauseReasonUz: pause?.reason?.nameUz ?? null,
            downtimeMin: s.deviations.reduce((sum, d) => sum + d.durationMin, 0),
            comment: s.comment,
            events: s.events.map((e) => ({
              event: e.event,
              occurredAt: e.occurredAt.toISOString(),
              reasonRu: e.reason?.nameRu ?? null,
              reasonUz: e.reason?.nameUz ?? null,
              comment: e.comment,
            })),
          };
        }),
        materials: o.materials.map((m) => {
          const planned = Number(m.qtyPlanned);
          const used = Number(m.qtyUsed);
          return {
            itemCode: m.item.code,
            itemNameRu: m.item.nameRu,
            itemNameUz: m.item.nameUz,
            unit: m.unit.code,
            qtyPlanned: qty(planned),
            qtyIssued: qty(m.qtyIssued),
            qtyUsed: qty(used),
            qtyReturned: qty(m.qtyReturned),
            // Перерасход положительный, экономия отрицательная — знак здесь
            // несёт смысл, поэтому модуль не берём.
            deviationQty: qty(used - planned),
            costTotal: money(m.costTotal),
          };
        }),
        outputs: o.outputs.map((v) => ({
          kind: v.kind,
          qty: qty(v.qty),
          itemCode: v.item.code,
          itemNameRu: v.item.nameRu,
          itemNameUz: v.item.nameUz,
          unit: v.item.baseUnit.code,
          stageSeq: v.stage?.seq ?? null,
          batchNumber: v.batch?.number ?? null,
          reasonNameRu: v.reason?.nameRu ?? null,
          reasonNameUz: v.reason?.nameUz ?? null,
          occurredAt: v.occurredAt.toISOString(),
        })),
        reworks: o.reworks.map((r) => ({
          uid: r.uid,
          number: r.number,
          status: r.status,
          qtyPlanned: qty(r.qtyPlanned),
        })),
        parentOrder: o.parentOrder && { uid: o.parentOrder.uid, number: o.parentOrder.number },
        cost: cost && {
          calculatedAt: cost.calculatedAt.toISOString(),
          materialCost: money(cost.materialCost),
          semiCost: money(cost.semiCost),
          directCost: money(cost.directCost),
          reworkCost: money(cost.reworkCost),
          totalCost: money(cost.totalCost),
          qtyGood: qty(cost.qtyGood),
          unitCost: money(cost.unitCost),
        },
      };
    });
  }
}
