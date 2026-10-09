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
import { diff, writeAudit } from '../common/audit.js';
import { activeCardFor } from './tech-cards.service.js';
import { ProductionCostService } from './cost.service.js';
import { MSG } from '../common/messages.js';
import { say } from '../common/say.js';
import { nameCol } from '../common/name.js';

/**
 * Запись по производству: заказ цеха и его путь по статусам (ТЗ 4.1).
 *
 * До этой службы в модуле не было ни одного действия — заказы приходили из
 * посева, и экран умел только смотреть. Поэтому главное здесь не «создать
 * строку», а правила, из-за которых переход статуса делают действием, а не
 * полем в форме:
 *
 * - путь заказа задан таблицей `NEXT_STATUS`, перескок через статус отбивается
 *   с объяснением, куда можно;
 * - выпуск не ставится поверх незавершённого этапа: иначе «выпущен» означало бы
 *   «кто-то нажал кнопку», а не «работа сделана»;
 * - отмена не стирает уже выпущенное: выпуск — факт на складе, и заказ,
 *   по которому что-то вышло, отменяют сторно выпуска, а не кнопкой;
 * - пауза и отмена требуют причины: из причин паузы потом растёт журнал
 *   простоев (ТЗ 4.1), а отмена без причины — потерянная история;
 * - каждый шаг ложится в журнал действий парой «было → стало».
 *
 * Чего здесь сознательно нет: этапов, материалов, выпуска и себестоимости.
 * Это следующие заходы, и своих правил о складе и деньгах производство иметь
 * не будет — выдача и приход пойдут теми же службами склада.
 */

/** Статусы заказа из схемы. Наружу уезжают как есть, поэтому строками. */
export type ProductionStatusName =
  | 'draft'
  | 'planned'
  | 'in_progress'
  | 'paused'
  | 'produced'
  | 'closed'
  | 'cancelled';

/**
 * Куда заказ можно перевести.
 *
 * «Выпущен» стоит после работы, а не после плана: между ними цех, и заказ,
 * который не запускали, выпустить нечем. Из «закрыт» и «отменён» выхода нет
 * вовсе — это конечные состояния, и возврат из них был бы переписыванием
 * истории, а не исправлением ошибки.
 */
export const NEXT_STATUS: Record<ProductionStatusName, ProductionStatusName[]> = {
  draft: ['planned', 'cancelled'],
  planned: ['in_progress', 'cancelled'],
  in_progress: ['paused', 'produced', 'cancelled'],
  paused: ['in_progress', 'cancelled'],
  produced: ['closed'],
  closed: [],
  cancelled: [],
};

/**
 * Переходы, которые без причины не делаются.
 *
 * Пауза — будущая строка журнала простоев, отмена — снятая работа. В обоих
 * случаях через месяц спросят «почему», и ответ должен лежать в журнале, а не
 * в чьей-то памяти.
 */
export const REASON_REQUIRED: ProductionStatusName[] = ['paused', 'cancelled'];

/** Что производят, а не покупают: в заказ цеха встаёт только это. */
const PRODUCIBLE = ['finished', 'semi'];

/** Префикс номера. Так пронумерованы заказы, которые уже есть в базе. */
const NUMBER_PREFIX = 'ПР';

export type CreateOrderInput = {
  companyUid?: string;
  itemCode: string;
  qtyPlanned: string;
  dueDate: string;
  priority?: number;
  responsibleUid?: string;
  salesOrderUid?: string;
  comment?: string;
};

export type UpdateOrderInput = {
  itemCode?: string;
  qtyPlanned?: string;
  dueDate?: string;
  priority?: number;
  /** `null` — снять ответственного, отвязать заказ продажи, стереть примечание. */
  responsibleUid?: string | null;
  salesOrderUid?: string | null;
  comment?: string;
};

export type OrderBrief = {
  uid: string;
  number: string;
  status: ProductionStatusName;
  itemCode: string;
  qtyPlanned: string;
  dueDate: string;
  nextStatuses: ProductionStatusName[];
  canEdit: boolean;
};

type OrderRow = {
  id: bigint;
  uid: string;
  company_id: bigint;
  number: string;
  status: ProductionStatusName;
  item_id: bigint;
  unit_id: bigint;
  item_code: string;
  qty_planned: string;
  qty_produced: string;
  due_date: Date;
  priority: number;
  responsible_id: bigint | null;
  sales_order_id: bigint | null;
  comment: string | null;
  started_at: Date | null;
};

type ItemRow = {
  id: bigint;
  code: string;
  item_type: string;
  track_serials: boolean;
  base_unit_id: bigint;
  is_active: boolean;
};

/**
 * Следующий номер производственного заказа компании.
 *
 * Вынесено из службы: тот же номер нужен переделке, а второй счётчик рядом
 * однажды выдал бы два заказа с одним номером.
 */
export async function nextOrderNumber(tx: Tx, companyId: bigint): Promise<string> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${companyId}:production`}))`;
  const rows = await tx.$queryRaw<{ next: number }[]>`
    SELECT coalesce(max(substring(number from '[0-9]+$')::int), 0) + 1 AS next
      FROM production_order
     WHERE company_id = ${companyId} AND number LIKE ${`${NUMBER_PREFIX}-%`}`;
  return `${NUMBER_PREFIX}-${String(rows[0].next).padStart(5, '0')}`;
}

@Injectable()
export class ProductionWriteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cost: ProductionCostService,
  ) {}

  async create(input: CreateOrderInput): Promise<OrderBrief> {
    const ctx = this.require();
    const userId = ctx.userId ?? null;

    return this.prisma.withTenant(async (tx) => {
      const companyId = await this.resolveCompany(tx, input.companyUid, ctx.companyIds ?? []);
      const item = await this.producibleItem(tx, companyId, input.itemCode);
      const qty = this.qty(input.qtyPlanned, item);
      const dueDate = this.date(input.dueDate, 'Срок');
      const priority = this.priority(input.priority);
      const responsibleId = await this.responsible(tx, companyId, input.responsibleUid ?? null);
      const salesOrderId = await this.salesOrder(tx, companyId, input.salesOrderUid ?? null);
      const comment = this.comment(input.comment);

      const number = await this.nextNumber(tx, companyId);

      /**
       * Норма берётся сама — действующая техкарта номенклатуры (ТЗ 4.1).
       *
       * Версия запоминается в заказе: завтра карту поправят новой версией, а
       * этот заказ останется посчитанным по той норме, по которой его завели.
       * Карты нет — заказ живёт без неё, этапы заведут руками.
       */
      const card = await activeCardFor(tx, companyId, item.id);

      const made = await tx.$queryRaw<{ uid: string }[]>`
        INSERT INTO production_order
          (uid, company_id, number, item_id, qty_planned, unit_id, due_date, status, priority,
           responsible_id, sales_order_id, comment, tech_card_id, tech_card_version, created_by)
        VALUES (gen_random_uuid(), ${companyId}, ${number}, ${item.id}, ${qty}::numeric,
                ${item.base_unit_id}, ${dueDate}::date, 'draft', ${priority}, ${responsibleId},
                ${salesOrderId}, ${comment}, ${card?.id ?? null}, ${card?.version ?? null},
                ${userId})
        RETURNING uid::text AS uid`;
      const uid = made[0].uid;

      /**
       * Журнал действий (ТЗ 3.4). Номер в записи не для красоты: заказ могут
       * удалить из демо-данных, а вопрос «что это было» останется.
       */
      await writeAudit(tx, {
        companyId,
        entityType: 'production_order',
        entityId: uid,
        action: 'create',
        changes: {
          number: { from: null, to: number },
          itemCode: { from: null, to: item.code },
          qtyPlanned: { from: null, to: qty },
          dueDate: { from: null, to: this.dayText(dueDate) },
          priority: { from: null, to: priority },
          ...(card ? { techCardVersion: { from: null, to: card.version } } : {}),
          ...(input.responsibleUid ? { responsible: { from: null, to: input.responsibleUid } } : {}),
          ...(input.salesOrderUid ? { salesOrder: { from: null, to: input.salesOrderUid } } : {}),
          ...(comment ? { comment: { from: null, to: comment } } : {}),
        },
      });

      return this.brief(tx, uid);
    });
  }

  /**
   * Правка заказа.
   *
   * Только в черновике — и это не лишняя строгость. Запланированный заказ уже
   * увидел цех: поменять ему количество молча значит соврать мастеру, который
   * считает смену по тому, что прочитал утром. Исправляют отменой и новым
   * заказом, как в продажах с отклонением заявки.
   */
  async update(uid: string, patch: UpdateOrderInput): Promise<OrderBrief> {
    const ctx = this.require();

    return this.prisma.withTenant(async (tx) => {
      const order = await this.orderRow(tx, uid);
      if (order.status !== 'draft') {
        throw new ConflictException(say(
          `Заказ ${order.number} уже не черновик (статус «${order.status}»): править его нельзя. ` +
            'Отмените заказ и заведите новый', `${order.number} buyurtmasi endi qoralama emas (holat «${order.status}»): uni tahrirlab bo‘lmaydi. ` + 'Buyurtmani bekor qilib, yangisini kiriting'));
      }

      const item =
        patch.itemCode === undefined
          ? null
          : await this.producibleItem(tx, order.company_id, patch.itemCode);
      // Количество сверяется с той номенклатурой, которая останется в заказе:
      // иначе штучную продукцию можно было бы заказать дробью одним PATCH.
      const itemForQty =
        item ?? (await this.itemById(tx, order.company_id, order.item_id));
      const qty = patch.qtyPlanned === undefined ? null : this.qty(patch.qtyPlanned, itemForQty);
      const dueDate = patch.dueDate === undefined ? null : this.date(patch.dueDate, 'Срок');
      const priority = patch.priority === undefined ? null : this.priority(patch.priority);
      const responsibleId =
        patch.responsibleUid === undefined
          ? undefined
          : await this.responsible(tx, order.company_id, patch.responsibleUid);
      const salesOrderId =
        patch.salesOrderUid === undefined
          ? undefined
          : await this.salesOrder(tx, order.company_id, patch.salesOrderUid);
      // `undefined` — поля в правке нет, `null` — поле очистили. Разные вещи:
      // COALESCE на оба случая оставил бы старое примечание и соврал человеку,
      // который его стёр.
      const comment = patch.comment === undefined ? undefined : this.comment(patch.comment);
      const nextComment = comment === undefined ? order.comment : comment;

      // Значения считаем здесь, а не условиями в SQL: «поля нет в PATCH»
      // и «поле прислали пустым» — разные вещи, и разбирать их в запросе
      // значит прятать смысл в CASE.
      const nextResponsible =
        responsibleId === undefined ? order.responsible_id : responsibleId;
      const nextSalesOrder = salesOrderId === undefined ? order.sales_order_id : salesOrderId;

      // Сменили продукцию — норма прежней к ней не относится. Берём карту
      // новой номенклатуры или снимаем её вовсе.
      const card = item ? await activeCardFor(tx, order.company_id, item.id) : null;

      await tx.$executeRaw`
        UPDATE production_order
           SET item_id     = ${item?.id ?? order.item_id},
               unit_id     = ${item?.base_unit_id ?? order.unit_id},
               qty_planned = COALESCE(${qty}::numeric, qty_planned),
               due_date    = COALESCE(${dueDate}::date, due_date),
               priority    = COALESCE(${priority}, priority),
               responsible_id = ${nextResponsible},
               sales_order_id = ${nextSalesOrder},
               comment     = ${nextComment},
               tech_card_id = CASE WHEN ${item === null} THEN tech_card_id
                                   ELSE ${card?.id ?? null} END,
               tech_card_version = CASE WHEN ${item === null} THEN tech_card_version
                                        ELSE ${card?.version ?? null} END,
               version     = version + 1
         WHERE id = ${order.id}`;

      const changes = diff(
        {
          itemCode: order.item_code,
          qtyPlanned: order.qty_planned,
          dueDate: this.dayText(order.due_date),
          priority: order.priority,
          responsible: order.responsible_id === null ? null : String(order.responsible_id),
          salesOrder: order.sales_order_id === null ? null : String(order.sales_order_id),
          comment: order.comment,
        },
        {
          itemCode: item?.code,
          qtyPlanned: qty === null ? undefined : Number(qty).toFixed(6),
          dueDate: dueDate === null ? undefined : this.dayText(dueDate),
          priority: priority ?? undefined,
          responsible:
            responsibleId === undefined
              ? undefined
              : responsibleId === null
                ? null
                : String(responsibleId),
          salesOrder:
            salesOrderId === undefined
              ? undefined
              : salesOrderId === null
                ? null
                : String(salesOrderId),
          comment,
        },
      );

      await writeAudit(tx, {
        companyId: order.company_id,
        entityType: 'production_order',
        entityId: uid,
        action: 'update',
        changes: { ...changes, number: { from: null, to: order.number } },
      });

      return this.brief(tx, uid);
    });
  }

  /**
   * Переход заказа по статусам.
   *
   * Вся проверка здесь, а не на экране: в боте и в браузере кнопки разные, а
   * правило одно, и расходиться им нельзя.
   */
  async setStatus(
    uid: string,
    target: ProductionStatusName,
    comment?: string,
  ): Promise<OrderBrief> {
    const ctx = this.require();

    return this.prisma.withTenant(async (tx) => {
      const order = await this.orderRow(tx, uid);

      if (order.status === target) {
        throw new ConflictException(say(`Заказ ${order.number} уже в статусе «${target}»`, `${order.number} buyurtmasi allaqachon «${target}» holatida`));
      }
      const allowed = NEXT_STATUS[order.status];
      if (!allowed.includes(target)) {
        const where = allowed.length === 0 ? 'никуда: это конечный статус' : allowed.join(', ');
        throw new ConflictException(say(
          `Переход «${order.status}» → «${target}» не разрешён. Из «${order.status}» можно: ${where}`, `«${order.status}» → «${target}» o‘tishi ruxsat etilmagan. «${order.status}» dan mumkin: ${where}`));
      }

      const reason = this.comment(comment);
      if (REASON_REQUIRED.includes(target) && (reason === null || reason.length < 5)) {
        const what = target === 'paused' ? 'остановки' : 'отмены';
        throw new UnprocessableEntityException(say(
          `Напишите причину ${what}: без неё в журнале останется только «кто-то нажал»`, `${what} sababini yozing: usiz jurnalda faqat «kimdir bosdi» qoladi`));
      }

      if (target === 'in_progress') {
        /**
         * Запуск без этапов не делают.
         *
         * В Э1 этой проверки не было намеренно: этапы было нечем завести, и
         * она запретила бы запускать всё подряд. Теперь этапы разворачиваются
         * из техкарты одной кнопкой, и заказ без них означает, что цеху не
         * сказали, что делать: отмечать нечего, фактическое время считать не
         * из чего, и «в работе» будет означать только нажатую кнопку.
         */
        const stages = await tx.$queryRaw<{ n: bigint }[]>`
          SELECT count(*)::bigint AS n FROM production_stage
           WHERE production_order_id = ${order.id}`;
        if (Number(stages[0].n) === 0) {
          throw new ConflictException(say(
            `В заказе ${order.number} нет ни одного этапа: ` +
              'разверните их из техкарты или заведите руками, потом запускайте', `${order.number} buyurtmasida birorta bosqich yo‘q: ` + 'ularni texkartadan yoyib oling yoki qo‘lda kiriting, keyin ishga tushiring'));
        }
      }

      if (target === 'produced') {
        // Этап, который никто не закрыл, — это работа, которую не сделали.
        // Спрашиваем про неё первой: пока работа идёт, разговор о выпуске
        // преждевременный.
        const open = await tx.$queryRaw<{ seq: number; name: string }[]>`
          SELECT seq, ${nameCol('production_stage')} AS name FROM production_stage
           WHERE production_order_id = ${order.id}
             AND status NOT IN ('done', 'skipped')
           ORDER BY seq LIMIT 1`;
        if (open[0]) {
          throw new ConflictException(say(
            `Этап ${open[0].seq} «${open[0].name}» ещё не завершён: ` +
              'закройте этапы, потом выпускайте заказ', `${open[0].seq}-bosqich «${open[0].name}» hali tugatilmagan: ` + 'bosqichlarni yopib, keyin buyurtmani chiqaring'));
        }

        // Выпущенный заказ без выпуска — это заказ, по которому ничего не
        // приняли на склад. Проверку откладывал до Э5, пока выпуск нечем было
        // записать.
        if (Number(order.qty_produced) <= 0) {
          throw new ConflictException(say(
            `По заказу ${order.number} не записано ни одной штуки годного: ` +
              'отметьте выпуск на вкладке «Выпуск», потом закрывайте заказ', `${order.number} buyurtmasi bo‘yicha birorta yaroqli dona yozilmagan: ` + '«Chiqarish» yorlig‘ida chiqarishni belgilab, keyin buyurtmani yoping'));
        }
      }

      if (target === 'cancelled') {
        const produced = Number(order.qty_produced);
        const outputs = await tx.$queryRaw<{ n: bigint }[]>`
          SELECT count(*)::bigint AS n FROM production_output
           WHERE production_order_id = ${order.id}`;
        if (produced > 0 || Number(outputs[0].n) > 0) {
          throw new ConflictException(say(
            `По заказу ${order.number} уже есть выпуск: отменяйте выпуск, а не заказ целиком`, `${order.number} buyurtmasi bo‘yicha chiqarish bor: butun buyurtmani emas, chiqarishni bekor qiling`));
        }
        const issued = await tx.$queryRaw<{ n: bigint }[]>`
          SELECT count(*)::bigint AS n FROM production_material
           WHERE production_order_id = ${order.id} AND qty_issued > 0`;
        if (Number(issued[0].n) > 0) {
          throw new ConflictException(say(
            `В цех по заказу ${order.number} уже выдали материал: сначала верните его на склад`, `${order.number} buyurtmasi bo‘yicha sexga material berilgan: avval uni omborga qaytaring`));
        }
      }

      /**
       * Отметки времени ставит сам переход, и каждая — один раз. Возврат с
       * паузы в работу не переписывает время запуска: заказ запустили тогда,
       * когда запустили, и фактическая длительность считается от этого.
       *
       * Примечание заказа переход не трогает. Причина остановки — не замена
       * того, зачем заказ завели: раз написав туда «нет заготовки», мы потеряли
       * бы «под заказ ТД, срочно». Причина живёт в журнале, а в карточку
       * приходит отдельным полем `statusReason`.
       */
      await tx.$executeRaw`
        UPDATE production_order
           SET status = ${target}::"ProductionStatus",
               started_at  = CASE WHEN ${target}::text = 'in_progress' AND started_at IS NULL
                                  THEN now() ELSE started_at END,
               finished_at = CASE WHEN ${target}::text = 'produced' THEN now() ELSE finished_at END,
               closed_at   = CASE WHEN ${target}::text = 'closed' THEN now() ELSE closed_at END,
               version = version + 1
         WHERE id = ${order.id}`;

      /**
       * Закрытие считает себестоимость (ТЗ 4.7): «расчёт выполняется при
       * закрытии заказа и сохраняется снимком». Кнопка «Рассчитать» зовёт ту
       * же службу — два места, одно число.
       */
      if (target === 'closed') {
        await this.cost.calculateOnClose(
          tx,
          await this.cost.orderRow(tx, uid),
          ctx.userId ?? null,
        );
      }

      await writeAudit(tx, {
        companyId: order.company_id,
        entityType: 'production_order',
        entityId: uid,
        action: 'status',
        changes: {
          status: { from: order.status, to: target },
          number: { from: null, to: order.number },
          ...(reason ? { comment: { from: null, to: reason } } : {}),
        },
      });

      return this.brief(tx, uid);
    });
  }

  /**
   * Что подставлять в форму заведения: продукция завода, кому поручают и к
   * какому заказу продажи это привязать.
   *
   * Список приходит с сервера, а не собирается на экране из справочников: тип
   * «производим» знает он, и вбитый в вёрстку список однажды разойдётся с
   * номенклатурой.
   */
  async options() {
    const ctx = currentContext();
    if (!ctx?.permissions.has('production.view')) {
      throw new ForbiddenException(MSG.noRight('production.view'));
    }

    return this.prisma.withTenant(async (tx) => {
      const items = await tx.$queryRaw<
        {
          code: string;
          name_ru: string;
          name_uz: string;
          item_type: string;
          unit: string;
          track_serials: boolean;
        }[]
      >`
        SELECT i.code, i.name_ru, i.name_uz, i.item_type::text AS item_type,
               u.code AS unit, i.track_serials
          FROM item i JOIN unit u ON u.id = i.base_unit_id
         WHERE i.is_active AND i.item_type IN ('finished', 'semi')
         ORDER BY i.name_ru`;

      /**
       * Ответственные — те, кто производство правда видит. Поручить заказ
       * бухгалтеру формально можно, но в списке его быть не должно: человек
       * не увидит ни заказа, ни уведомления по нему.
       */
      const responsibles = await tx.$queryRaw<{ uid: string; full_name: string }[]>`
        SELECT DISTINCT u.uid::text AS uid, u.full_name
          FROM user_account u
          JOIN user_role_assignment a ON a.user_id = u.id
          JOIN role_permission rp ON rp.role_id = a.role_id
          JOIN permission p ON p.id = rp.permission_id
         WHERE u.is_active AND p.code = 'production.view'
         ORDER BY u.full_name`;

      /** Участки для этапов техкарты. */
      const workCenters = await tx.$queryRaw<
        { code: string; name_ru: string; name_uz: string; capacity: string }[]
      >`
        SELECT code, name_ru, name_uz, capacity_per_shift::text AS capacity
          FROM work_center WHERE is_active ORDER BY code`;

      /**
       * Из чего делают: в материалы техкарты годится любая активная позиция,
       * включая покупную. Список ограничен тремя сотнями строк — на таком
       * размере выпадающий список ещё читается; дальше нужен поиск, и это
       * будет видно по самой номенклатуре заказчика.
       */
      const materials = await tx.$queryRaw<
        { code: string; name_ru: string; name_uz: string; unit: string; item_type: string }[]
      >`
        SELECT i.code, i.name_ru, i.name_uz, u.code AS unit, i.item_type::text AS item_type
          FROM item i JOIN unit u ON u.id = i.base_unit_id
         WHERE i.is_active ORDER BY i.code LIMIT 300`;

      /**
       * Причины остановки — те же, что в складских списаниях: справочник один
       * на компанию, и заводить производству свой значило бы объяснять потом,
       * почему «нет сырья» в цехе и «нет сырья» на складе — разные строки.
       */
      const downtimeReasons = await tx.$queryRaw<
        { uid: string; name_ru: string; name_uz: string }[]
      >`
        SELECT uid::text AS uid, name_ru, name_uz FROM stock_reason
         WHERE kind = 'downtime' AND is_active ORDER BY name_ru`;

      /**
       * Причины брака и отхода. Разные списки, потому что это разные вещи:
       * обрезь при нарезке — норма техпроцесса, а «несоответствие геометрии» —
       * испорченная работа. Сложить их в один список значит сделать вид, что
       * цех всё время что-то портит.
       */
      const defectReasons = await tx.$queryRaw<
        { uid: string; name_ru: string; name_uz: string }[]
      >`
        SELECT uid::text AS uid, name_ru, name_uz FROM stock_reason
         WHERE kind = 'defect' AND is_active ORDER BY name_ru`;
      const wasteReasons = await tx.$queryRaw<
        { uid: string; name_ru: string; name_uz: string }[]
      >`
        SELECT uid::text AS uid, name_ru, name_uz FROM stock_reason
         WHERE kind = 'waste' AND is_active ORDER BY name_ru`;

      /**
       * Склады своей компании — и их ячейки.
       *
       * Ячейки нужны выпуску: у новой продукции остатка ещё нет, спросить
       * «где она лежит» не у кого, а склад с ячейками приход без ячейки не
       * примет. Список на склад короткий, поэтому отдаём сразу — иначе экран
       * пошёл бы за ним вторым запросом ровно в тот момент, когда человек уже
       * нажал кнопку.
       */
      const warehouses = await tx.$queryRaw<
        { code: string; name_ru: string; name_uz: string }[]
      >`
        SELECT code, name_ru, name_uz FROM warehouse WHERE is_active ORDER BY code`;
      const locations = await tx.$queryRaw<
        { warehouse_code: string; code: string }[]
      >`
        SELECT w.code AS warehouse_code, l.code
          FROM storage_location l
          JOIN warehouse_zone z ON z.id = l.zone_id
          JOIN warehouse w ON w.id = z.warehouse_id
         WHERE l.is_active AND z.is_active AND w.is_active
         ORDER BY w.code, l.code`;

      const salesOrders = await tx.$queryRaw<
        { uid: string; number: string; partner: string }[]
      >`
        SELECT o.uid::text AS uid, o.number, app_loc(p.name_ru, p.name_uz) AS partner
          FROM sales_order o JOIN partner p ON p.id = o.partner_id
         WHERE o.status NOT IN ('cancelled', 'closed')
         ORDER BY o.order_date DESC, o.number DESC
         LIMIT 100`;

      return {
        items: items.map((i) => ({
          code: i.code,
          nameRu: i.name_ru,
          nameUz: i.name_uz,
          itemType: i.item_type,
          unit: i.unit,
          trackSerials: i.track_serials,
        })),
        responsibles: responsibles.map((u) => ({ uid: u.uid, fullName: u.full_name })),
        workCenters: workCenters.map((w) => ({
          code: w.code,
          nameRu: w.name_ru,
          nameUz: w.name_uz,
          capacityPerShift: Number(w.capacity).toFixed(6),
        })),
        materials: materials.map((m) => ({
          code: m.code,
          nameRu: m.name_ru,
          nameUz: m.name_uz,
          unit: m.unit,
          itemType: m.item_type,
        })),
        warehouses: warehouses.map((w) => ({
          code: w.code,
          nameRu: w.name_ru,
          nameUz: w.name_uz,
          locations: locations.filter((l) => l.warehouse_code === w.code).map((l) => l.code),
        })),
        downtimeReasons: downtimeReasons.map((r) => ({
          uid: r.uid,
          nameRu: r.name_ru,
          nameUz: r.name_uz,
        })),
        defectReasons: defectReasons.map((r) => ({
          uid: r.uid,
          nameRu: r.name_ru,
          nameUz: r.name_uz,
        })),
        wasteReasons: wasteReasons.map((r) => ({
          uid: r.uid,
          nameRu: r.name_ru,
          nameUz: r.name_uz,
        })),
        salesOrders: salesOrders.map((o) => ({
          uid: o.uid,
          number: o.number,
          partnerNameRu: o.partner,
        })),
      };
    });
  }

  // -------------------------------------------------------------------------

  private require() {
    const ctx = currentContext();
    if (!ctx?.permissions.has('production.manage')) {
      throw new ForbiddenException(MSG.noRight('production.manage'));
    }
    return ctx;
  }

  private async orderRow(tx: Tx, uid: string): Promise<OrderRow> {
    if (!/^[0-9a-f-]{36}$/i.test(uid)) throw new NotFoundException(MSG.orderNotFound());
    const rows = await tx.$queryRaw<OrderRow[]>`
      SELECT o.id, o.uid::text AS uid, o.company_id, o.number, o.status::text AS status,
             o.item_id, o.unit_id, i.code AS item_code, o.qty_planned::text AS qty_planned,
             o.qty_produced::text AS qty_produced, o.due_date, o.priority,
             o.responsible_id, o.sales_order_id, o.comment, o.started_at
        FROM production_order o JOIN item i ON i.id = o.item_id
       WHERE o.uid = ${uid}::uuid`;
    // Чужая компания сюда не попадёт политикой RLS: строки просто не будет, и
    // ответ тот же, что для несуществующего заказа.
    if (!rows[0]) throw new NotFoundException(MSG.orderNotFound());
    return rows[0];
  }

  private async brief(tx: Tx, uid: string): Promise<OrderBrief> {
    const rows = await tx.$queryRaw<
      {
        uid: string;
        number: string;
        status: ProductionStatusName;
        item_code: string;
        qty_planned: string;
        due_date: Date;
      }[]
    >`
      SELECT o.uid::text AS uid, o.number, o.status::text AS status, i.code AS item_code,
             o.qty_planned::text AS qty_planned, o.due_date
        FROM production_order o JOIN item i ON i.id = o.item_id
       WHERE o.uid = ${uid}::uuid`;
    const r = rows[0]!;
    return {
      uid: r.uid,
      number: r.number,
      status: r.status,
      itemCode: r.item_code,
      qtyPlanned: Number(r.qty_planned).toFixed(6),
      dueDate: this.dayText(r.due_date),
      nextStatuses: NEXT_STATUS[r.status],
      canEdit: r.status === 'draft',
    };
  }

  private async resolveCompany(
    tx: Tx,
    companyUid: string | undefined,
    allowed: readonly bigint[],
  ): Promise<bigint> {
    if (!companyUid) {
      if (allowed.length === 1) return allowed[0];
      throw new BadRequestException(
        MSG.pickCompany(),
      );
    }
    const rows = await tx.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM company WHERE uid = ${companyUid}::uuid`;
    const id = rows[0]?.id;
    if (!id || !allowed.some((a) => a === id)) {
      throw new UnprocessableEntityException(MSG.companyUnavailable());
    }
    return id;
  }

  private async producibleItem(tx: Tx, companyId: bigint, code: string): Promise<ItemRow> {
    const rows = await tx.$queryRaw<ItemRow[]>`
      SELECT id, code, item_type::text AS item_type, track_serials, base_unit_id, is_active
        FROM item WHERE company_id = ${companyId} AND code = ${String(code).trim()}`;
    const item = rows[0];
    if (!item) throw new UnprocessableEntityException(MSG.itemNotFound(code));
    if (!item.is_active) {
      throw new UnprocessableEntityException(MSG.itemArchived(code));
    }
    if (!PRODUCIBLE.includes(item.item_type)) {
      throw new UnprocessableEntityException(say(
        `Номенклатуру ${code} завод не производит (тип «${item.item_type}»): ` +
          'в заказ ставят готовую продукцию или полуфабрикат', `${code} nomenklaturasini zavod ishlab chiqarmaydi (turi «${item.item_type}»): ` + 'buyurtmaga tayyor mahsulot yoki yarim tayyor mahsulot qo‘yiladi'));
    }
    return item;
  }

  private async itemById(tx: Tx, companyId: bigint, id: bigint): Promise<ItemRow> {
    const rows = await tx.$queryRaw<ItemRow[]>`
      SELECT id, code, item_type::text AS item_type, track_serials, base_unit_id, is_active
        FROM item WHERE company_id = ${companyId} AND id = ${id}`;
    if (!rows[0]) throw new UnprocessableEntityException(say('Номенклатура заказа не найдена', 'Buyurtma nomenklaturasi topilmadi'));
    return rows[0];
  }

  private async responsible(
    tx: Tx,
    companyId: bigint,
    uid: string | null,
  ): Promise<bigint | null> {
    if (!uid) return null;
    const rows = await tx.$queryRaw<{ id: bigint }[]>`
      SELECT u.id FROM user_account u
       WHERE u.uid = ${uid}::uuid AND u.is_active
         AND EXISTS (SELECT 1 FROM user_role_assignment a
                      WHERE a.user_id = u.id AND a.company_id = ${companyId})`;
    if (!rows[0]) {
      throw new UnprocessableEntityException(say(
        'Ответственный не найден или не работает в этой компании', 'Mas’ul topilmadi yoki bu kompaniyada ishlamaydi'));
    }
    return rows[0].id;
  }

  private async salesOrder(
    tx: Tx,
    companyId: bigint,
    uid: string | null,
  ): Promise<bigint | null> {
    if (!uid) return null;
    const rows = await tx.$queryRaw<{ id: bigint; status: string }[]>`
      SELECT id, status::text AS status FROM sales_order
       WHERE company_id = ${companyId} AND uid = ${uid}::uuid`;
    const order = rows[0];
    if (!order) throw new UnprocessableEntityException(say('Заказ продажи не найден', 'Sotuv buyurtmasi topilmadi'));
    if (order.status === 'cancelled') {
      throw new UnprocessableEntityException(say('Заказ продажи отменён: производить для него нечего', 'Sotuv buyurtmasi bekor qilingan: unga ishlab chiqarishga narsa yo‘q'));
    }
    return order.id;
  }

  /**
   * Номер заказа. Блокировка на время транзакции: без неё два одновременных
   * заведения получили бы один номер, а на `(company_id, number)` стоит
   * уникальный индекс — второе заведение просто упало бы человеку в лицо.
   */
  private async nextNumber(tx: Tx, companyId: bigint): Promise<string> {
    return nextOrderNumber(tx, companyId);
  }

  /**
   * Количество. Штучная продукция — целыми штуками: половины трубы с серийным
   * номером не бывает, а заказ на полторы доживёт до выпуска и встанет там.
   */
  private qty(raw: string, item: ItemRow): string {
    const value = Number(String(raw).replace(',', '.'));
    if (!Number.isFinite(value) || value <= 0) {
      throw new UnprocessableEntityException(MSG.qtyPositive());
    }
    if (value > 1e12) throw new UnprocessableEntityException(MSG.qtyTooBig());
    if (item.track_serials && Math.abs(value - Math.round(value)) > 1e-9) {
      throw new UnprocessableEntityException(say(
        `${item.code} считают штуками: количество должно быть целым`, `${item.code} donalab hisoblanadi: miqdor butun bo‘lishi kerak`));
    }
    return value.toFixed(6);
  }

  private date(raw: string, what: string): Date {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      throw new BadRequestException(say(`${what}: ожидается дата вида ГГГГ-ММ-ДД`, `${what}: YYYY-MM-DD ko‘rinishidagi sana kutilmoqda`));
    }
    const d = new Date(`${raw}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) throw new BadRequestException(say(`${what} ${raw} не разобран`, `${what} ${raw} o‘qilmadi`));
    return d;
  }

  private dayText(d: Date | string): string {
    return typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10);
  }

  private priority(raw: number | undefined): number {
    if (raw === undefined) return 0;
    if (!Number.isInteger(raw) || raw < 0 || raw > 99) {
      throw new UnprocessableEntityException(say('Приоритет — целое число от 0 до 99', 'Muhimlik darajasi — 0 dan 99 gacha butun son'));
    }
    return raw;
  }

  private comment(raw: string | undefined): string | null {
    const text = (raw ?? '').trim();
    if (text === '') return null;
    if (text.length > 500) throw new UnprocessableEntityException(MSG.commentTooLong());
    return text;
  }
}
