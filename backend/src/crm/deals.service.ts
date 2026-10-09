import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { currentContext } from '../common/request-context.js';
import { MSG } from '../common/messages.js';
import { say } from '../common/say.js';

/**
 * Воронка и сделки (ТЗ 8.3).
 *
 * Три решения, на которых держится этап:
 *
 * 1. **Стадии — из базы компании, а не из вёрстки.** ТЗ: «стадии
 *    настраиваются». Доска рисует столько колонок, сколько стадий у компании,
 *    в их порядке и под их названиями.
 * 2. **Каждый переход оставляет след** (`deal_stage_event`): кто, когда,
 *    откуда, куда. Текущая стадия говорит, где сделка сейчас, но не сколько
 *    сделок через стадию прошло — а конверсия считается именно по этому.
 * 3. **Закрытие — отдельное действие, не перенос.** «Выиграна» и «проиграна»
 *    не колонки, куда перетаскивают карточку: проигрыш требует причины из
 *    справочника, выигрыш ставит вероятность 100. Перенос в конечную стадию
 *    мимо этих действий оставил бы проигрыш без причины.
 *
 * Закрытая сделка — история. Её не двигают и не правят: иначе отчёт за
 * прошлый месяц менялся бы от сегодняшних правок.
 */
@Injectable()
export class DealsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Автор перехода: след без автора не отвечает на «кто передвинул». */
  private userId(): bigint | null {
    return currentContext()?.userId ?? null;
  }

  private async resolveCompany(tx: Tx, companyUid: string | undefined): Promise<bigint> {
    const ids = currentContext()?.companyIds ?? [];
    if (ids.length === 0) throw new UnprocessableEntityException(MSG.noCompany());
    if (!companyUid) {
      if (ids.length > 1) {
        throw new UnprocessableEntityException(say(
          'Выбраны обе компании: укажите, в чью воронку заводим сделку', 'Ikkala kompaniya tanlangan: bitim kimning varonkasiga kiritilishini ko‘rsating'));
      }
      return ids[0]!;
    }
    const rows = await tx.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM company WHERE uid = ${companyUid}::uuid`;
    const id = rows[0]?.id;
    if (id === undefined || !ids.includes(id)) throw new NotFoundException(MSG.companyNotFound());
    return id;
  }

  // --- справочники воронки ---------------------------------------------------

  async stages() {
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT s.uid, s.seq, s.code, s.name_ru, s.name_uz, s.probability_default, s.is_final,
                co.uid AS company_uid, co.code AS company_code
           FROM deal_stage s JOIN company co ON co.id = s.company_id
          WHERE s.is_active
          ORDER BY co.code, s.seq`,
      );
      return { rows: rows.map(stageView) };
    });
  }

  async lostReasons() {
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT r.uid, r.code, r.name_ru, r.name_uz, co.uid AS company_uid, co.code AS company_code
           FROM deal_lost_reason r JOIN company co ON co.id = r.company_id
          WHERE r.is_active
          ORDER BY co.code, r.name_ru`,
      );
      return {
        rows: rows.map((r) => ({
          uid: r.uid,
          code: r.code,
          nameRu: r.name_ru,
          nameUz: r.name_uz,
          company: { uid: r.company_uid, code: r.company_code },
        })),
      };
    });
  }

  // --- доска -----------------------------------------------------------------

  /**
   * Доска: все стадии колонками со сделками.
   *
   * В конечных стадиях лежат только последние {@link CLOSED_ON_BOARD}
   * закрытых — за полгода их сотни, и они вытеснили бы с экрана то, с чем
   * работают сегодня. Но пустая колонка с одним итогом не отвечала на «куда
   * уехала сделка, которую я только что закрыл», и это главное, зачем на
   * доску смотрят сразу после закрытия. Число и сумма в заголовке остаются
   * полными, остальные — в таблице с фильтром по статусу.
   */
  async board(params: { managerUid?: string; search?: string }) {
    const search = params.search?.trim() ?? '';
    return this.prisma.withTenant(async (tx) => {
      const stages = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT s.id, s.uid, s.seq, s.code, s.name_ru, s.name_uz, s.probability_default, s.is_final,
                co.uid AS company_uid, co.code AS company_code,
                co.name_ru AS company_name_ru, co.name_uz AS company_name_uz
           FROM deal_stage s JOIN company co ON co.id = s.company_id
          WHERE s.is_active
          ORDER BY co.code, s.seq`,
      );

      const deals = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
        `${DEAL_SELECT}
          WHERE d.status = 'open'
            AND ($1::uuid IS NULL OR m.uid = $1::uuid)
            AND ($2::text = '' OR d.title ILIKE '%' || $2::text || '%'
                 OR d.number ILIKE '%' || $2::text || '%'
                 OR p.name_ru ILIKE '%' || $2::text || '%')
          ORDER BY d.expected_close_date NULLS LAST, d.created_at`,
        params.managerUid ?? null,
        search,
      );

      const closed = await tx.$queryRawUnsafe<{ stage_id: bigint; n: bigint; amount: string }[]>(
        `SELECT d.stage_id, count(*) AS n, coalesce(sum(d.amount), 0)::text AS amount
           FROM deal d
           LEFT JOIN user_account m ON m.id = d.manager_id
          WHERE d.status <> 'open'
            AND ($1::uuid IS NULL OR m.uid = $1::uuid)
          GROUP BY d.stage_id`,
        params.managerUid ?? null,
      );
      const closedBy = new Map(closed.map((c) => [String(c.stage_id), c]));

      // Последние закрытые по каждой конечной стадии: свежая сверху, чтобы
      // только что закрытая сделка была видна без поиска по таблице.
      const closedCards = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT * FROM (
           SELECT q.*, row_number() OVER (
                    PARTITION BY q.stage_id
                        ORDER BY q.closed_at DESC NULLS LAST, q.created_at DESC) AS rn
             FROM (${DEAL_SELECT}
                    WHERE d.status <> 'open'
                      AND ($1::uuid IS NULL OR m.uid = $1::uuid)
                      AND ($2::text = '' OR d.title ILIKE '%' || $2::text || '%'
                           OR d.number ILIKE '%' || $2::text || '%'
                           OR p.name_ru ILIKE '%' || $2::text || '%')) q
         ) z
         WHERE z.rn <= ${CLOSED_ON_BOARD}`,
        params.managerUid ?? null,
        search,
      );

      return {
        stages: stages.map((s) => {
          const inStage = (s.is_final ? closedCards : deals)
            .filter((d) => String(d.stage_id) === String(s.id))
            .map(dealView);
          const c = closedBy.get(String(s.id));
          return {
            ...stageView(s),
            // В заголовке — всё закрытое по стадии, а не только показанное:
            // «заключено 7» и семь карточек расходятся, и об этом говорит сам
            // экран строкой «ещё N».
            count: s.is_final ? Number(c?.n ?? 0) : inStage.length,
            amount: s.is_final
              ? String(c?.amount ?? '0')
              : String(inStage.reduce((a, d) => a + Number(d.amount), 0)),
            deals: inStage,
          };
        }),
      };
    });
  }

  // --- список и карточка -----------------------------------------------------

  /**
   * Список сделок: то же, что на доске, но целиком и в любом порядке.
   *
   * Сортировка приходит ключом из {@link DEAL_SORTS}, а не строкой столбца:
   * имя столбца подставляется в запрос, и принимать его с улицы нельзя.
   * Вторым ключом всегда `d.id`: без него две сделки с одной датой на границе
   * страницы могли бы поменяться местами и одна пропала бы из догрузки.
   */
  async list(params: {
    search?: string;
    status?: string;
    stageUid?: string;
    managerUid?: string;
    partnerUid?: string;
    companyUid?: string;
    sort?: string;
    dir?: string;
    limit?: number;
    offset?: number;
  }) {
    const search = params.search?.trim() ?? '';
    const limit = params.limit ?? 50;
    const offset = params.offset ?? 0;
    const sort = DEAL_SORTS[params.sort ?? ''] ?? DEAL_SORTS.created!;
    const dir = params.dir === 'asc' ? 'ASC' : 'DESC';
    return this.prisma.withTenant(async (tx) => {
      const where = `WHERE ($1::text = '' OR d.title ILIKE '%' || $1::text || '%'
                            OR d.number ILIKE '%' || $1::text || '%'
                            OR p.name_ru ILIKE '%' || $1::text || '%')
                       AND ($2::text = '' OR d.status::text = $2::text)
                       AND ($3::uuid IS NULL OR s.uid = $3::uuid)
                       AND ($4::uuid IS NULL OR m.uid = $4::uuid)
                       AND ($5::uuid IS NULL OR p.uid = $5::uuid)
                       AND ($6::uuid IS NULL OR co.uid = $6::uuid)`;
      const args = [
        search,
        params.status ?? '',
        params.stageUid ?? null,
        params.managerUid ?? null,
        params.partnerUid ?? null,
        params.companyUid ?? null,
      ];
      const rows = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
        `${DEAL_SELECT} ${where}
          ORDER BY ${sort} ${dir} NULLS LAST, d.id DESC
          LIMIT $7 OFFSET $8`,
        ...args,
        limit,
        offset,
      );
      const total = await tx.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n
           FROM deal d
           JOIN deal_stage s ON s.id = d.stage_id
           JOIN company co ON co.id = d.company_id
           LEFT JOIN partner p ON p.id = d.partner_id
           LEFT JOIN user_account m ON m.id = d.manager_id
           ${where}`,
        ...args,
      );
      return { rows: rows.map(dealView), total: Number(total[0]?.n ?? 0), limit, offset };
    });
  }

  async card(uid: string) {
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
        `${DEAL_SELECT} WHERE d.uid = $1::uuid`,
        uid,
      );
      const r = rows[0];
      if (!r) throw new NotFoundException(MSG.dealNotFound());

      const history = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT e.at, app_loc(fs.name_ru, fs.name_uz) AS from_name, app_loc(ts.name_ru, ts.name_uz) AS to_name, ts.code AS to_code,
                u.full_name AS user_name
           FROM deal_stage_event e
           LEFT JOIN deal_stage fs ON fs.id = e.from_stage_id
           JOIN deal_stage ts ON ts.id = e.to_stage_id
           LEFT JOIN user_account u ON u.id = e.user_id
          WHERE e.deal_id = $1
          ORDER BY e.at, e.id`,
        r.id,
      );
      const orders = await tx.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM sales_order WHERE deal_id = $1`,
        r.id,
      );

      const open = r.status === 'open';
      return {
        ...dealView(r),
        orders: Number(orders[0]?.n ?? 0),
        history: history.map((h) => ({
          at: h.at,
          from: h.from_name ?? null,
          to: h.to_name,
          toCode: h.to_code,
          user: h.user_name ?? null,
        })),
        permissions: { canEdit: open, canMove: open, canClose: open },
      };
    });
  }

  // --- запись ----------------------------------------------------------------

  async create(input: DealInput) {
    const uid = await this.prisma.withTenant(async (tx) => {
      const companyId = await this.resolveCompany(tx, input.companyUid);

      const partner = await tx.$queryRawUnsafe<{ id: bigint; company_id: bigint; manager_id: bigint | null }[]>(
        `SELECT id, company_id, manager_id FROM partner WHERE uid = $1::uuid`,
        input.partnerUid,
      );
      if (!partner[0]) throw new NotFoundException(MSG.partnerNotFound());
      if (partner[0].company_id !== companyId) {
        throw new UnprocessableEntityException(say('Клиент заведён в другой компании', 'Mijoz boshqa kompaniyada kiritilgan'));
      }

      const stage = input.stageUid
        ? await this.stageByUid(tx, companyId, input.stageUid)
        : await this.firstStage(tx, companyId);
      if (stage.is_final) {
        throw new UnprocessableEntityException(say(
          'Сделку заводят в открытой стадии: закрыть её можно только выигрышем или проигрышем', 'Bitim ochiq bosqichda kiritiladi: uni faqat tuzilgan yoki amalga oshmagan deb yopish mumkin'));
      }

      const managerId = input.managerUid
        ? await this.userIdByUid(tx, input.managerUid)
        : partner[0].manager_id;

      const currency = await tx.$queryRaw<{ id: bigint }[]>`SELECT id FROM currency WHERE code = 'UZS'`;
      if (!currency[0]) throw new UnprocessableEntityException(MSG.currencyNotFound('UZS'));

      const number = await this.nextNumber(tx, companyId);
      const rows = await tx.$queryRawUnsafe<{ id: bigint; uid: string }[]>(
        `INSERT INTO deal (uid, company_id, number, title, partner_id, manager_id, stage_id,
                           amount, currency_id, probability, expected_close_date, status)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::date, 'open'::"DealStatus")
         RETURNING id, uid`,
        companyId,
        number,
        input.title.trim(),
        partner[0].id,
        managerId,
        stage.id,
        input.amount ?? 0,
        currency[0].id,
        stage.probability_default,
        input.expectedCloseDate ?? null,
      );
      await this.event(tx, rows[0]!.id, null, stage.id);
      return rows[0]!.uid;
    });
    return this.card(uid);
  }

  async update(uid: string, input: DealPatch) {
    await this.prisma.withTenant(async (tx) => {
      const deal = await this.deal(tx, uid);
      this.checkVersion(deal.version, input.version);
      this.requireOpen(deal.status);

      const managerId =
        input.managerUid === undefined ? undefined : await this.userIdByUid(tx, input.managerUid);

      await tx.$queryRawUnsafe(
        `UPDATE deal SET
           title = COALESCE($2, title),
           amount = COALESCE($3, amount),
           probability = COALESCE($4, probability),
           expected_close_date = COALESCE($5::date, expected_close_date),
           manager_id = CASE WHEN $6::boolean THEN $7 ELSE manager_id END,
           version = version + 1
         WHERE id = $1`,
        deal.id,
        input.title?.trim() ?? null,
        input.amount ?? null,
        input.probability ?? null,
        input.expectedCloseDate ?? null,
        input.managerUid !== undefined,
        managerId ?? null,
      );
    });
    return this.card(uid);
  }

  /** Перенос по открытым стадиям, в обе стороны: сделка и откатывается. */
  async move(uid: string, input: { stageUid: string; version?: number }) {
    await this.prisma.withTenant(async (tx) => {
      const deal = await this.deal(tx, uid);
      this.checkVersion(deal.version, input.version);
      this.requireOpen(deal.status);

      const stage = await this.stageByUid(tx, deal.company_id, input.stageUid);
      if (stage.is_final) {
        throw new UnprocessableEntityException(say(
          'В конечную стадию не переносят: сделку закрывают выигрышем или проигрышем — ' +
            'у проигрыша обязательна причина', 'Yakuniy bosqichga ko‘chirilmaydi: bitim tuzilgan yoki amalga oshmagan deb yopiladi — ' + 'amalga oshmaganida sabab majburiy'));
      }
      if (stage.id === deal.stage_id) {
        throw new UnprocessableEntityException(say('Сделка уже в этой стадии', 'Bitim allaqachon shu bosqichda'));
      }

      await tx.$queryRawUnsafe(
        `UPDATE deal SET stage_id = $2, probability = $3, version = version + 1 WHERE id = $1`,
        deal.id,
        stage.id,
        stage.probability_default,
      );
      await this.event(tx, deal.id, deal.stage_id, stage.id);
    });
    return this.card(uid);
  }

  async win(uid: string, input: { version?: number; comment?: string }) {
    await this.prisma.withTenant(async (tx) => {
      const deal = await this.deal(tx, uid);
      this.checkVersion(deal.version, input.version);
      this.requireOpen(deal.status);
      // Чем закончилась сделка словами — это то, что читают через полгода,
      // когда к тому же клиенту приходят снова. Пустую строку не берём.
      const comment = input.comment?.trim();
      if (!comment) {
        throw new UnprocessableEntityException(say('Напишите, чем закончилась сделка', 'Bitim nima bilan tugaganini yozing'));
      }
      const stage = await this.finalStage(tx, deal.company_id, 'won');

      await tx.$queryRawUnsafe(
        `UPDATE deal SET stage_id = $2, status = 'won'::"DealStatus", probability = 100,
                         close_comment = $3, closed_at = now(), version = version + 1
          WHERE id = $1`,
        deal.id,
        stage.id,
        comment,
      );
      await this.event(tx, deal.id, deal.stage_id, stage.id);
    });
    return this.card(uid);
  }

  async lose(uid: string, input: { version?: number; reasonUid: string; comment?: string }) {
    await this.prisma.withTenant(async (tx) => {
      const deal = await this.deal(tx, uid);
      this.checkVersion(deal.version, input.version);
      this.requireOpen(deal.status);
      // Причина из справочника даёт отчёт, комментарий — разбор: «дорого»
      // в отчёте и «дороже на 3% у соседей» в карточке это разные сведения.
      const comment = input.comment?.trim();
      if (!comment) {
        throw new UnprocessableEntityException(say('Напишите, почему сделка не состоялась', 'Bitim nega amalga oshmaganini yozing'));
      }

      const reason = await tx.$queryRawUnsafe<{ id: bigint; company_id: bigint; is_active: boolean }[]>(
        `SELECT id, company_id, is_active FROM deal_lost_reason WHERE uid = $1::uuid`,
        input.reasonUid,
      );
      if (!reason[0]) throw new NotFoundException(MSG.reasonNotFound());
      if (reason[0].company_id !== deal.company_id) {
        throw new UnprocessableEntityException(say('Причина из справочника другой компании', 'Sabab boshqa kompaniya ma’lumotnomasidan'));
      }
      if (!reason[0].is_active) {
        throw new UnprocessableEntityException(say('Эта причина выключена в справочнике', 'Bu sabab ma’lumotnomada o‘chirilgan'));
      }
      const stage = await this.finalStage(tx, deal.company_id, 'lost');

      await tx.$queryRawUnsafe(
        `UPDATE deal SET stage_id = $2, status = 'lost'::"DealStatus", probability = 0,
                         lost_reason_id = $3, close_comment = $4,
                         closed_at = now(), version = version + 1
          WHERE id = $1`,
        deal.id,
        stage.id,
        reason[0].id,
        comment,
      );
      await this.event(tx, deal.id, deal.stage_id, stage.id);
    });
    return this.card(uid);
  }

  // --- служебное -------------------------------------------------------------

  private async event(tx: Tx, dealId: bigint, fromId: bigint | null, toId: bigint) {
    await tx.$queryRawUnsafe(
      `INSERT INTO deal_stage_event (deal_id, from_stage_id, to_stage_id, user_id)
       VALUES ($1, $2, $3, $4)`,
      dealId,
      fromId,
      toId,
      this.userId(),
    );
  }

  private async deal(tx: Tx, uid: string) {
    const rows = await tx.$queryRaw<
      { id: bigint; company_id: bigint; stage_id: bigint; status: string; version: number }[]
    >`SELECT id, company_id, stage_id, status::text AS status, version
        FROM deal WHERE uid = ${uid}::uuid`;
    if (!rows[0]) throw new NotFoundException(MSG.dealNotFound());
    return rows[0];
  }

  private requireOpen(status: string) {
    if (status !== 'open') {
      throw new UnprocessableEntityException(say(
        'Сделка закрыта: закрытая сделка — история, её не двигают и не правят. ' +
          'Иначе отчёт за прошлый месяц менялся бы от сегодняшних правок', 'Bitim yopilgan: yopilgan bitim — tarix, u ko‘chirilmaydi va tahrirlanmaydi. ' + 'Aks holda o‘tgan oy hisoboti bugungi tahrirlardan o‘zgarardi'));
    }
  }

  private checkVersion(current: number, sent: number | undefined) {
    if (sent === undefined) {
      throw new UnprocessableEntityException(say(
        'Не указана версия сделки: без неё перенос затёр бы чужой', 'Bitim versiyasi ko‘rsatilmagan: usiz ko‘chirish boshqaning ishini o‘chirib yuborardi'));
    }
    if (sent !== current) {
      throw new ConflictException({
        message: say('Сделку уже изменили: обновите доску и повторите', 'Bitim allaqachon o‘zgargan: doskani yangilab, qaytadan urinib ko‘ring'),
        details: { version: current },
      });
    }
  }

  private async stageByUid(tx: Tx, companyId: bigint, uid: string) {
    const rows = await tx.$queryRawUnsafe<
      {
        id: bigint;
        company_id: bigint;
        is_final: boolean;
        is_active: boolean;
        probability_default: number;
      }[]
    >(
      `SELECT id, company_id, is_final, is_active, probability_default
         FROM deal_stage WHERE uid = $1::uuid`,
      uid,
    );
    const row = rows[0];
    if (!row) throw new NotFoundException(MSG.stageNotFound());
    if (row.company_id !== companyId) {
      throw new UnprocessableEntityException(say('Стадия из воронки другой компании', 'Bosqich boshqa kompaniya varonkasidan'));
    }
    if (!row.is_active) {
      throw new UnprocessableEntityException(say('Стадия выключена: перенести в неё сделку нельзя', 'Bosqich o‘chirilgan: unga bitimni ko‘chirib bo‘lmaydi'));
    }
    return row;
  }

  private async firstStage(tx: Tx, companyId: bigint) {
    const rows = await tx.$queryRawUnsafe<
      { id: bigint; is_final: boolean; probability_default: number }[]
    >(
      `SELECT id, is_final, probability_default FROM deal_stage
        WHERE company_id = $1 AND NOT is_final AND is_active ORDER BY seq LIMIT 1`,
      companyId,
    );
    if (!rows[0]) throw new UnprocessableEntityException(say('У компании не заведены стадии воронки', 'Kompaniyada varonka bosqichlari kiritilmagan'));
    return rows[0];
  }

  private async finalStage(tx: Tx, companyId: bigint, code: 'won' | 'lost') {
    const rows = await tx.$queryRawUnsafe<{ id: bigint }[]>(
      `SELECT id FROM deal_stage WHERE company_id = $1 AND is_final AND code = $2`,
      companyId,
      code,
    );
    if (!rows[0]) {
      throw new UnprocessableEntityException(say(
        code === 'won'
          ? 'В воронке компании нет стадии «выиграна»'
          : 'В воронке компании нет стадии «проиграна»', code === 'won' ? 'Kompaniya varonkasida «tuzilgan» bosqichi yo‘q' : 'Kompaniya varonkasida «amalga oshmagan» bosqichi yo‘q'));
    }
    return rows[0];
  }

  private async nextNumber(tx: Tx, companyId: bigint): Promise<string> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${companyId}:СД`}))`;
    const rows = await tx.$queryRaw<{ next: number }[]>`
      SELECT coalesce(max(substring(number from '[0-9]+$')::int), 0) + 1 AS next
        FROM deal WHERE company_id = ${companyId} AND number LIKE 'СД-%'`;
    return `СД-${String(rows[0]!.next).padStart(4, '0')}`;
  }

  private async userIdByUid(tx: Tx, uid: string | null): Promise<bigint | null> {
    if (!uid) return null;
    const rows = await tx.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM user_account WHERE uid = ${uid}::uuid`;
    if (!rows[0]) throw new NotFoundException(MSG.managerNotFound());
    return rows[0].id;
  }
}

/** По чему сортируется список. Ключ приходит снаружи, столбец — отсюда. */
const DEAL_SORTS: Record<string, string> = {
  number: 'd.number',
  title: 'd.title',
  partner: 'p.name_ru',
  amount: 'd.amount',
  stage: 's.seq',
  manager: 'm.full_name',
  created: 'd.created_at',
  closed: 'd.closed_at',
  expected: 'd.expected_close_date',
};

/** Сколько закрытых сделок лежит карточками в конечной колонке. */
const CLOSED_ON_BOARD = 10;

const DEAL_SELECT = `
  SELECT d.id, d.uid, d.number, d.title, d.amount::text AS amount, d.probability,
         d.expected_close_date, d.status::text AS status, d.version, d.created_at, d.closed_at,
         d.stage_id, d.close_comment,
         s.uid AS stage_uid, app_loc(s.name_ru, s.name_uz) AS stage_name, s.code AS stage_code,
         co.uid AS company_uid, co.code AS company_code,
         p.uid AS partner_uid, app_loc(p.name_ru, p.name_uz) AS partner_name,
         m.uid AS manager_uid, m.full_name AS manager_name,
         r.uid AS reason_uid, app_loc(r.name_ru, r.name_uz) AS reason_name,
         cur.code AS currency
    FROM deal d
    JOIN deal_stage s ON s.id = d.stage_id
    JOIN company co ON co.id = d.company_id
    JOIN currency cur ON cur.id = d.currency_id
    LEFT JOIN partner p ON p.id = d.partner_id
    LEFT JOIN user_account m ON m.id = d.manager_id
    LEFT JOIN deal_lost_reason r ON r.id = d.lost_reason_id`;

const stageView = (s: Record<string, any>) => ({
  uid: s.uid,
  seq: Number(s.seq),
  code: s.code,
  nameRu: s.name_ru,
  nameUz: s.name_uz,
  probabilityDefault: Number(s.probability_default),
  isFinal: s.is_final,
  company: {
    uid: s.company_uid,
    code: s.company_code,
    // Доска выбирает компанию переключателем, и подписать его нечем, пока
    // наружу уходит только код.
    nameRu: s.company_name_ru,
    nameUz: s.company_name_uz,
  },
});

const dealView = (r: Record<string, any>) => ({
  uid: r.uid,
  number: r.number,
  title: r.title,
  amount: String(r.amount),
  currency: r.currency,
  probability: Number(r.probability),
  expectedCloseDate: r.expected_close_date,
  status: r.status as 'open' | 'won' | 'lost',
  version: Number(r.version),
  stage: { uid: r.stage_uid, name: r.stage_name, code: r.stage_code },
  company: { uid: r.company_uid, code: r.company_code },
  partner: r.partner_uid ? { uid: r.partner_uid, name: r.partner_name } : null,
  manager: r.manager_uid ? { uid: r.manager_uid, name: r.manager_name } : null,
  lostReason: r.reason_uid ? { uid: r.reason_uid, name: r.reason_name } : null,
  createdAt: r.created_at,
  closedAt: r.closed_at,
  closeComment: r.close_comment ?? null,
});

export type DealInput = {
  companyUid?: string;
  partnerUid: string;
  title: string;
  amount?: number;
  expectedCloseDate?: string;
  managerUid?: string;
  stageUid?: string;
};

export type DealPatch = {
  version?: number;
  title?: string;
  amount?: number;
  probability?: number;
  expectedCloseDate?: string;
  managerUid?: string | null;
};
