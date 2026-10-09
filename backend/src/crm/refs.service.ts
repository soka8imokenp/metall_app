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
 * Справочники CRM на запись (ТЗ 8.3, 8.4): стадии воронки, источники
 * обращений, причины отказа, типы задач.
 *
 * Правила те же, что у складских справочников, и по той же причине:
 *
 * 1. **Что уже участвовало в записях — выключается, а не удаляется.** Удалив
 *    источник «Реклама», мы стёрли бы его из отчёта за прошлый квартал, по
 *    которому оплачивали рекламу. `DELETE` отвечает 409 и называет число
 *    записей, где справочник встречается.
 * 2. **Правка, меняющая смысл записанного, отклоняется.** Код стадии, по
 *    которой уже ходили сделки, менять нельзя: след переходов читается по
 *    нему. Имя и вероятность — можно, это подпись, а не смысл.
 * 3. **Справочник не может опустеть.** Обращение не принимается без
 *    источника, проигрыш — без причины, задача — без типа, сделка заводится
 *    в первой не конечной стадии. Выключив последнюю активную строку, мы
 *    сломали бы форму, из которой её выбирают, — поэтому последнюю выключить
 *    нельзя.
 */
@Injectable()
export class CrmRefsService {
  constructor(private readonly prisma: PrismaService) {}

  // --- общее ----------------------------------------------------------------

  private async resolveCompany(tx: Tx, companyUid?: string): Promise<bigint> {
    const ids = currentContext()?.companyIds ?? [];
    if (ids.length === 0) throw new UnprocessableEntityException(MSG.noCompany());
    if (!companyUid) {
      if (ids.length > 1) {
        throw new UnprocessableEntityException(
          MSG.bothCompanies(),
        );
      }
      return ids[0]!;
    }
    const rows = await tx.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM company WHERE uid = ${companyUid}::uuid`;
    const id = rows[0]?.id;
    if (id === undefined || !ids.includes(id)) throw new NotFoundException(MSG.companyNotFound());
    return id;
  }

  private async count(tx: Tx, sql: string, ...p: unknown[]): Promise<number> {
    const rows = await tx.$queryRawUnsafe<{ n: bigint }[]>(sql, ...p);
    return Number(rows[0]?.n ?? 0);
  }

  /** Сколько активных строк останется в справочнике, если выключить эту. */
  private async activeLeft(tx: Tx, table: string, companyId: bigint, exceptId: bigint, extra = '') {
    return this.count(
      tx,
      `SELECT count(*) AS n FROM ${table}
        WHERE company_id = $1 AND is_active AND id <> $2 ${extra}`,
      companyId,
      exceptId,
    );
  }

  private trim(v: string | undefined | null): string | null {
    const t = v?.trim();
    return t ? t : null;
  }

  /** Код справочника: латиница, цифры, дефис — он уходит в выгрузки и в URL. */
  private code(raw: string): string {
    const code = raw.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(code)) {
      throw new UnprocessableEntityException(say(
        'Код пишется латиницей: буквы, цифры, дефис и подчёркивание', 'Kod lotin harflarida yoziladi: harflar, raqamlar, chiziqcha va pastki chiziq'));
    }
    return code;
  }

  private async codeTaken(tx: Tx, table: string, companyId: bigint, code: string, exceptId?: bigint) {
    const n = await this.count(
      tx,
      `SELECT count(*) AS n FROM ${table}
        WHERE company_id = $1 AND code = $2 AND ($3::bigint IS NULL OR id <> $3)`,
      companyId,
      code,
      exceptId ?? null,
    );
    if (n > 0) throw new ConflictException(say(`Код «${code}» в этой компании уже занят`, `«${code}» kodi bu kompaniyada allaqachon band`));
  }

  // --- чтение: весь справочник одним запросом --------------------------------

  /**
   * Все четыре раздела сразу.
   *
   * Экран справочников показывает их вместе, и четыре отдельных запроса дали
   * бы четыре разных момента времени: выключенная стадия успела бы попасть в
   * один ответ и не попасть в другой.
   */
  async all(showHidden = false) {
    return this.prisma.withTenant(async (tx) => {
      const stages = await tx.$queryRawUnsafe<Record<string, any>[]>(
        `SELECT s.uid, s.seq, s.code, s.name_ru, s.name_uz, s.probability_default,
                s.is_final, s.is_active,
                co.uid AS company_uid, co.code AS company_code,
                (SELECT count(*) FROM deal d WHERE d.stage_id = s.id) AS deals,
                (SELECT count(*) FROM deal d
                  WHERE d.stage_id = s.id AND d.status = 'open') AS open_deals,
                (SELECT count(*) FROM deal_stage_event e
                  WHERE e.to_stage_id = s.id OR e.from_stage_id = s.id) AS events
           FROM deal_stage s JOIN company co ON co.id = s.company_id
          WHERE ($1::boolean OR s.is_active)
          ORDER BY co.code, s.is_final, s.seq`,
        showHidden,
      );

      const sources = await tx.$queryRawUnsafe<Record<string, any>[]>(
        `SELECT s.uid, s.code, s.name_ru, s.name_uz, s.channel::text AS channel, s.is_active,
                co.uid AS company_uid, co.code AS company_code,
                (SELECT count(*) FROM lead l WHERE l.source_id = s.id) AS leads,
                (SELECT count(*) FROM partner p WHERE p.source_id = s.id) AS partners
           FROM lead_source s JOIN company co ON co.id = s.company_id
          WHERE ($1::boolean OR s.is_active)
          ORDER BY co.code, s.name_ru`,
        showHidden,
      );

      const lostReasons = await tx.$queryRawUnsafe<Record<string, any>[]>(
        `SELECT r.uid, r.code, r.name_ru, r.name_uz, r.is_active,
                co.uid AS company_uid, co.code AS company_code,
                (SELECT count(*) FROM deal d WHERE d.lost_reason_id = r.id) AS deals
           FROM deal_lost_reason r JOIN company co ON co.id = r.company_id
          WHERE ($1::boolean OR r.is_active)
          ORDER BY co.code, r.name_ru`,
        showHidden,
      );

      const taskTypes = await tx.$queryRawUnsafe<Record<string, any>[]>(
        `SELECT t.uid, t.code, t.name_ru, t.name_uz, t.activity_kind::text AS activity_kind,
                t.seq, t.is_active,
                co.uid AS company_uid, co.code AS company_code,
                (SELECT count(*) FROM crm_task k WHERE k.type_id = t.id) AS tasks
           FROM crm_task_type t JOIN company co ON co.id = t.company_id
          WHERE ($1::boolean OR t.is_active)
          ORDER BY co.code, t.seq, t.name_ru`,
        showHidden,
      );

      const company = (r: Record<string, any>) => ({ uid: r.company_uid, code: r.company_code });
      return {
        stages: stages.map((r) => ({
          uid: r.uid,
          seq: Number(r.seq),
          code: r.code,
          nameRu: r.name_ru,
          nameUz: r.name_uz,
          probabilityDefault: Number(r.probability_default),
          isFinal: r.is_final,
          isActive: r.is_active,
          company: company(r),
          usage: { deals: Number(r.deals), openDeals: Number(r.open_deals), events: Number(r.events) },
        })),
        sources: sources.map((r) => ({
          uid: r.uid,
          code: r.code,
          nameRu: r.name_ru,
          nameUz: r.name_uz,
          channel: r.channel,
          isActive: r.is_active,
          company: company(r),
          usage: { leads: Number(r.leads), partners: Number(r.partners) },
        })),
        lostReasons: lostReasons.map((r) => ({
          uid: r.uid,
          code: r.code,
          nameRu: r.name_ru,
          nameUz: r.name_uz,
          isActive: r.is_active,
          company: company(r),
          usage: { deals: Number(r.deals) },
        })),
        taskTypes: taskTypes.map((r) => ({
          uid: r.uid,
          code: r.code,
          nameRu: r.name_ru,
          nameUz: r.name_uz,
          activityKind: r.activity_kind,
          seq: Number(r.seq),
          isActive: r.is_active,
          company: company(r),
          usage: { tasks: Number(r.tasks) },
        })),
      };
    });
  }

  // --- стадии воронки (ТЗ 8.3) ----------------------------------------------

  /**
   * Порядок стадий — это и есть воронка: по нему считается, откуда куда
   * человек ушёл. Пересчитываем его целиком, а не правим одну строку: после
   * вставки в середину соседние номера всё равно расходятся, а конечные
   * стадии обязаны остаться последними.
   */
  private async normalizeStageSeq(tx: Tx, companyId: bigint) {
    await tx.$executeRawUnsafe(
      `WITH ordered AS (
         SELECT id, (row_number() OVER (ORDER BY is_final, seq, id)) * 10 AS s
           FROM deal_stage WHERE company_id = $1
       )
       UPDATE deal_stage d SET seq = o.s FROM ordered o
        WHERE o.id = d.id AND d.seq <> o.s`,
      companyId,
    );
  }

  private async stageRow(tx: Tx, uid: string) {
    const rows = await tx.$queryRaw<
      { id: bigint; company_id: bigint; code: string; is_final: boolean; is_active: boolean }[]
    >`SELECT id, company_id, code, is_final, is_active FROM deal_stage WHERE uid = ${uid}::uuid`;
    const row = rows[0];
    if (!row) throw new NotFoundException(MSG.stageNotFound());
    return row;
  }

  private async stageUsage(tx: Tx, id: bigint) {
    const rows = await tx.$queryRawUnsafe<{ deals: bigint; open: bigint; events: bigint }[]>(
      `SELECT (SELECT count(*) FROM deal WHERE stage_id = $1) AS deals,
              (SELECT count(*) FROM deal WHERE stage_id = $1 AND status = 'open') AS open,
              (SELECT count(*) FROM deal_stage_event
                WHERE to_stage_id = $1 OR from_stage_id = $1) AS events`,
      id,
    );
    const r = rows[0]!;
    return { deals: Number(r.deals), open: Number(r.open), events: Number(r.events) };
  }

  /**
   * Новая стадия встаёт последней среди рабочих, перед «выиграна» и
   * «проиграна»: конечные — это дно воронки, и что-то после них означало бы
   * стадию, в которую сделка попадает после закрытия.
   *
   * Конечную стадию завести нельзя. Их ровно две, и закрытие идёт не
   * переносом, а действием «выиграна»/«проиграна» — оно ищет стадию по коду.
   * Третья конечная стала бы колонкой, в которую невозможно попасть.
   */
  async createStage(input: {
    companyUid?: string;
    code: string;
    nameRu: string;
    nameUz?: string;
    probabilityDefault?: number;
  }) {
    return this.prisma.withTenant(async (tx) => {
      const companyId = await this.resolveCompany(tx, input.companyUid);
      const code = this.code(input.code);
      await this.codeTaken(tx, 'deal_stage', companyId, code);

      const nameRu = this.trim(input.nameRu);
      if (!nameRu) throw new UnprocessableEntityException(say('Название стадии обязательно', 'Bosqich nomi majburiy'));

      const last = await this.count(
        tx,
        `SELECT coalesce(max(seq), 0) AS n FROM deal_stage
          WHERE company_id = $1 AND NOT is_final`,
        companyId,
      );
      const rows = await tx.$queryRawUnsafe<{ uid: string }[]>(
        `INSERT INTO deal_stage (uid, company_id, seq, code, name_ru, name_uz,
                                 probability_default, is_final)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, false) RETURNING uid`,
        companyId,
        last + 1,
        code,
        nameRu,
        this.trim(input.nameUz) ?? nameRu,
        input.probabilityDefault ?? 0,
      );
      await this.normalizeStageSeq(tx, companyId);
      return { uid: rows[0]!.uid };
    });
  }

  async updateStage(
    uid: string,
    input: {
      code?: string;
      nameRu?: string;
      nameUz?: string;
      probabilityDefault?: number;
      isActive?: boolean;
    },
  ) {
    return this.prisma.withTenant(async (tx) => {
      const row = await this.stageRow(tx, uid);
      const usage = await this.stageUsage(tx, row.id);

      let code: string | null = null;
      if (input.code !== undefined && this.code(input.code) !== row.code) {
        code = this.code(input.code);
        if (row.is_final) {
          throw new UnprocessableEntityException(say(
            'Код конечной стадии менять нельзя: по нему сделка закрывается как выигранная или проигранная', 'Yakuniy bosqich kodini o‘zgartirib bo‘lmaydi: bitim shu kod bo‘yicha tuzilgan yoki amalga oshmagan deb yopiladi'));
        }
        if (usage.deals + usage.events > 0) {
          throw new ConflictException({
            message: say(`По стадии уже прошло ${usage.events} переходов и лежит ${usage.deals} сделок: ` +
              'код читается в следе переходов, его можно только завести заново', `Bosqich bo‘yicha ${usage.events} o‘tish bo‘lgan va ${usage.deals} bitim turadi: ` + 'kod o‘tishlar izida o‘qiladi, uni faqat qaytadan kiritish mumkin'),
            details: { deals: usage.deals, events: usage.events },
          });
        }
        await this.codeTaken(tx, 'deal_stage', row.company_id, code, row.id);
      }

      if (input.isActive === false && row.is_active) {
        if (row.is_final) {
          throw new UnprocessableEntityException(say(
            'Конечную стадию выключить нельзя: в неё закрываются сделки', 'Yakuniy bosqichni o‘chirib bo‘lmaydi: bitimlar shunga yopiladi'));
        }
        if (usage.open > 0) {
          throw new ConflictException({
            message: say(`В стадии лежит ${usage.open} открытых сделок: с выключенной стадии они пропадут с доски`, `Bosqichda ${usage.open} ochiq bitim turadi: o‘chirilgan bosqichdan ular doskadan yo‘qoladi`),
            details: { openDeals: usage.open },
          });
        }
        const left = await this.activeLeft(
          tx,
          'deal_stage',
          row.company_id,
          row.id,
          'AND NOT is_final',
        );
        if (left === 0) {
          throw new UnprocessableEntityException(say(
            'Это последняя рабочая стадия: без неё новую сделку некуда завести', 'Bu oxirgi ishchi bosqich: usiz yangi bitimni kiritadigan joy yo‘q'));
        }
      }

      await tx.$executeRawUnsafe(
        `UPDATE deal_stage
            SET code = COALESCE($2, code),
                name_ru = COALESCE($3, name_ru),
                name_uz = COALESCE($4, name_uz),
                probability_default = COALESCE($5, probability_default),
                is_active = COALESCE($6, is_active)
          WHERE id = $1`,
        row.id,
        code,
        this.trim(input.nameRu),
        this.trim(input.nameUz),
        input.probabilityDefault ?? null,
        input.isActive ?? null,
      );
      return { uid, updated: true as const };
    });
  }

  async deleteStage(uid: string) {
    return this.prisma.withTenant(async (tx) => {
      const row = await this.stageRow(tx, uid);
      if (row.is_final) {
        throw new UnprocessableEntityException(say(
          'Конечную стадию удалить нельзя: в неё закрываются сделки', 'Yakuniy bosqichni o‘chirib tashlab bo‘lmaydi: bitimlar shunga yopiladi'));
      }
      const usage = await this.stageUsage(tx, row.id);
      if (usage.deals + usage.events > 0) {
        throw new ConflictException({
          message: say(`По стадии прошло ${usage.events} переходов и лежит ${usage.deals} сделок: ` +
            'удаление стёрло бы их путь из воронки, стадию можно выключить', `Bosqich bo‘yicha ${usage.events} o‘tish bo‘lgan va ${usage.deals} bitim turadi: ` + 'o‘chirish ularning varonkadagi yo‘lini yo‘qotardi, bosqichni o‘chirib qo‘yish mumkin'),
          details: { deals: usage.deals, events: usage.events },
        });
      }
      const left = await this.activeLeft(tx, 'deal_stage', row.company_id, row.id, 'AND NOT is_final');
      if (left === 0) {
        throw new UnprocessableEntityException(say(
          'Это последняя рабочая стадия: без неё новую сделку некуда завести', 'Bu oxirgi ishchi bosqich: usiz yangi bitimni kiritadigan joy yo‘q'));
      }
      await tx.$executeRawUnsafe(`DELETE FROM deal_stage WHERE id = $1`, row.id);
      await this.normalizeStageSeq(tx, row.company_id);
      return { uid, removed: true as const };
    });
  }

  /**
   * Порядок задаётся списком целиком, а не номером у каждой строки: две правки
   * по одной стадии оставили бы воронку с двумя третьими стадиями.
   */
  async reorderStages(input: { companyUid?: string; uids: string[] }) {
    return this.prisma.withTenant(async (tx) => {
      const companyId = await this.resolveCompany(tx, input.companyUid);
      const rows = await tx.$queryRawUnsafe<{ id: bigint; uid: string; is_final: boolean }[]>(
        `SELECT id, uid, is_final FROM deal_stage WHERE company_id = $1 ORDER BY is_final, seq`,
        companyId,
      );
      const movable = rows.filter((r) => !r.is_final);
      const sent = new Set(input.uids);
      if (sent.size !== input.uids.length || sent.size !== movable.length ||
          movable.some((r) => !sent.has(r.uid))) {
        throw new UnprocessableEntityException(say(
          'В порядке перечисляются все рабочие стадии воронки по одному разу; конечные всегда последние', 'Tartibda varonkaning barcha ishchi bosqichlari bir marta sanab o‘tiladi; yakuniylar doim oxirida'));
      }
      for (const [i, uid] of input.uids.entries()) {
        await tx.$executeRawUnsafe(
          `UPDATE deal_stage SET seq = $2 WHERE company_id = $1 AND uid = $3::uuid`,
          companyId,
          (i + 1) * 10,
          uid,
        );
      }
      const base = (movable.length + 1) * 10;
      for (const [j, r] of rows.filter((x) => x.is_final).entries()) {
        await tx.$executeRawUnsafe(`UPDATE deal_stage SET seq = $2 WHERE id = $1`, r.id, base + j * 10);
      }
      return { reordered: input.uids.length };
    });
  }

  // --- источники обращений (ТЗ 8.1) -----------------------------------------

  private async sourceRow(tx: Tx, uid: string) {
    const rows = await tx.$queryRaw<
      { id: bigint; company_id: bigint; code: string; channel: string; is_active: boolean }[]
    >`SELECT id, company_id, code, channel::text AS channel, is_active
        FROM lead_source WHERE uid = ${uid}::uuid`;
    const row = rows[0];
    if (!row) throw new NotFoundException(say('Источник не найден', 'Manba topilmadi'));
    return row;
  }

  private async sourceUsage(tx: Tx, id: bigint) {
    const rows = await tx.$queryRawUnsafe<{ leads: bigint; partners: bigint }[]>(
      `SELECT (SELECT count(*) FROM lead WHERE source_id = $1) AS leads,
              (SELECT count(*) FROM partner WHERE source_id = $1) AS partners`,
      id,
    );
    const r = rows[0]!;
    return { leads: Number(r.leads), partners: Number(r.partners) };
  }

  async createSource(input: {
    companyUid?: string;
    code: string;
    nameRu: string;
    nameUz?: string;
    channel: string;
  }) {
    return this.prisma.withTenant(async (tx) => {
      const companyId = await this.resolveCompany(tx, input.companyUid);
      const code = this.code(input.code);
      await this.codeTaken(tx, 'lead_source', companyId, code);
      const nameRu = this.trim(input.nameRu);
      if (!nameRu) throw new UnprocessableEntityException(say('Название источника обязательно', 'Manba nomi majburiy'));

      const rows = await tx.$queryRawUnsafe<{ uid: string }[]>(
        `INSERT INTO lead_source (uid, company_id, code, name_ru, name_uz, channel)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::"LeadChannel") RETURNING uid`,
        companyId,
        code,
        nameRu,
        this.trim(input.nameUz) ?? nameRu,
        input.channel,
      );
      return { uid: rows[0]!.uid };
    });
  }

  /**
   * Канал у источника, а не у обращения: сменив его задним числом, мы
   * переписали бы канал всем обращениям, которые по нему уже пришли. Поэтому
   * у использованного источника канал и код закрыты — заводится новый.
   */
  async updateSource(
    uid: string,
    input: { code?: string; nameRu?: string; nameUz?: string; channel?: string; isActive?: boolean },
  ) {
    return this.prisma.withTenant(async (tx) => {
      const row = await this.sourceRow(tx, uid);
      const usage = await this.sourceUsage(tx, row.id);
      const used = usage.leads + usage.partners;

      let code: string | null = null;
      if (input.code !== undefined && this.code(input.code) !== row.code) {
        code = this.code(input.code);
        if (used > 0) {
          throw new ConflictException({
            message: say(`По источнику записано ${usage.leads} обращений и ${usage.partners} клиентов: код менять нельзя`, `Manba bo‘yicha ${usage.leads} murojaat va ${usage.partners} mijoz yozilgan: kodni o‘zgartirib bo‘lmaydi`),
            details: usage,
          });
        }
        await this.codeTaken(tx, 'lead_source', row.company_id, code, row.id);
      }
      if (input.channel !== undefined && input.channel !== row.channel && used > 0) {
        throw new ConflictException({
          message: say(`По источнику записано ${usage.leads} обращений и ${usage.partners} клиентов: ` +
            'смена канала переписала бы, откуда они пришли', `Manba bo‘yicha ${usage.leads} murojaat va ${usage.partners} mijoz yozilgan: ` + 'kanalni o‘zgartirish ular qayerdan kelganini qayta yozardi'),
          details: usage,
        });
      }
      if (input.isActive === false && row.is_active) {
        const left = await this.activeLeft(tx, 'lead_source', row.company_id, row.id);
        if (left === 0) {
          throw new UnprocessableEntityException(say(
            'Это последний источник: обращение не принимается без источника', 'Bu oxirgi manba: murojaat manbasiz qabul qilinmaydi'));
        }
      }

      await tx.$executeRawUnsafe(
        `UPDATE lead_source
            SET code = COALESCE($2, code),
                name_ru = COALESCE($3, name_ru),
                name_uz = COALESCE($4, name_uz),
                channel = COALESCE($5::"LeadChannel", channel),
                is_active = COALESCE($6, is_active)
          WHERE id = $1`,
        row.id,
        code,
        this.trim(input.nameRu),
        this.trim(input.nameUz),
        input.channel ?? null,
        input.isActive ?? null,
      );
      return { uid, updated: true as const };
    });
  }

  async deleteSource(uid: string) {
    return this.prisma.withTenant(async (tx) => {
      const row = await this.sourceRow(tx, uid);
      const usage = await this.sourceUsage(tx, row.id);
      const used = usage.leads + usage.partners;
      if (used > 0) {
        throw new ConflictException({
          message: say(`По источнику записано ${usage.leads} обращений и ${usage.partners} клиентов: ` +
            'удаление вычло бы их из отчёта по источникам, источник можно выключить', `Manba bo‘yicha ${usage.leads} murojaat va ${usage.partners} mijoz yozilgan: ` + 'o‘chirish ularni manbalar hisobotidan chiqarib tashlardi, manbani o‘chirib qo‘yish mumkin'),
          details: usage,
        });
      }
      const left = await this.activeLeft(tx, 'lead_source', row.company_id, row.id);
      if (left === 0) {
        throw new UnprocessableEntityException(say(
          'Это последний источник: обращение не принимается без источника', 'Bu oxirgi manba: murojaat manbasiz qabul qilinmaydi'));
      }
      await tx.$executeRawUnsafe(`DELETE FROM lead_source WHERE id = $1`, row.id);
      return { uid, removed: true as const };
    });
  }

  // --- причины отказа (ТЗ 8.3) ----------------------------------------------

  private async lostReasonRow(tx: Tx, uid: string) {
    const rows = await tx.$queryRaw<
      { id: bigint; company_id: bigint; code: string; is_active: boolean }[]
    >`SELECT id, company_id, code, is_active FROM deal_lost_reason WHERE uid = ${uid}::uuid`;
    const row = rows[0];
    if (!row) throw new NotFoundException(say('Причина отказа не найдена', 'Rad etish sababi topilmadi'));
    return row;
  }

  async createLostReason(input: { companyUid?: string; code: string; nameRu: string; nameUz?: string }) {
    return this.prisma.withTenant(async (tx) => {
      const companyId = await this.resolveCompany(tx, input.companyUid);
      const code = this.code(input.code);
      await this.codeTaken(tx, 'deal_lost_reason', companyId, code);
      const nameRu = this.trim(input.nameRu);
      if (!nameRu) throw new UnprocessableEntityException(say('Название причины обязательно', 'Sabab nomi majburiy'));

      const rows = await tx.$queryRawUnsafe<{ uid: string }[]>(
        `INSERT INTO deal_lost_reason (uid, company_id, code, name_ru, name_uz)
         VALUES (gen_random_uuid(), $1, $2, $3, $4) RETURNING uid`,
        companyId,
        code,
        nameRu,
        this.trim(input.nameUz) ?? nameRu,
      );
      return { uid: rows[0]!.uid };
    });
  }

  async updateLostReason(
    uid: string,
    input: { code?: string; nameRu?: string; nameUz?: string; isActive?: boolean },
  ) {
    return this.prisma.withTenant(async (tx) => {
      const row = await this.lostReasonRow(tx, uid);
      const deals = await this.count(
        tx,
        `SELECT count(*) AS n FROM deal WHERE lost_reason_id = $1`,
        row.id,
      );

      let code: string | null = null;
      if (input.code !== undefined && this.code(input.code) !== row.code) {
        code = this.code(input.code);
        if (deals > 0) {
          throw new ConflictException({
            message: say(`По причине закрыто ${deals} сделок: код менять нельзя`, `Sabab bo‘yicha ${deals} bitim yopilgan: kodni o‘zgartirib bo‘lmaydi`),
            details: { deals },
          });
        }
        await this.codeTaken(tx, 'deal_lost_reason', row.company_id, code, row.id);
      }
      if (input.isActive === false && row.is_active) {
        const left = await this.activeLeft(tx, 'deal_lost_reason', row.company_id, row.id);
        if (left === 0) {
          throw new UnprocessableEntityException(say(
            'Это последняя причина отказа: проигрыш сделки без причины не записывается', 'Bu oxirgi rad etish sababi: bitimning amalga oshmaganligi sababsiz yozilmaydi'));
        }
      }

      await tx.$executeRawUnsafe(
        `UPDATE deal_lost_reason
            SET code = COALESCE($2, code),
                name_ru = COALESCE($3, name_ru),
                name_uz = COALESCE($4, name_uz),
                is_active = COALESCE($5, is_active)
          WHERE id = $1`,
        row.id,
        code,
        this.trim(input.nameRu),
        this.trim(input.nameUz),
        input.isActive ?? null,
      );
      return { uid, updated: true as const };
    });
  }

  async deleteLostReason(uid: string) {
    return this.prisma.withTenant(async (tx) => {
      const row = await this.lostReasonRow(tx, uid);
      const deals = await this.count(
        tx,
        `SELECT count(*) AS n FROM deal WHERE lost_reason_id = $1`,
        row.id,
      );
      if (deals > 0) {
        throw new ConflictException({
          message: say(`По причине закрыто ${deals} сделок: удаление опустошило бы отчёт по причинам отказов, её можно выключить`, `Sabab bo‘yicha ${deals} bitim yopilgan: o‘chirish rad etish sabablari hisobotini bo‘shatardi, uni o‘chirib qo‘yish mumkin`),
          details: { deals },
        });
      }
      const left = await this.activeLeft(tx, 'deal_lost_reason', row.company_id, row.id);
      if (left === 0) {
        throw new UnprocessableEntityException(say(
          'Это последняя причина отказа: проигрыш сделки без причины не записывается', 'Bu oxirgi rad etish sababi: bitimning amalga oshmaganligi sababsiz yozilmaydi'));
      }
      await tx.$executeRawUnsafe(`DELETE FROM deal_lost_reason WHERE id = $1`, row.id);
      return { uid, removed: true as const };
    });
  }

  // --- типы задач (ТЗ 8.4) --------------------------------------------------

  private async taskTypeRow(tx: Tx, uid: string) {
    const rows = await tx.$queryRaw<
      { id: bigint; company_id: bigint; code: string; is_active: boolean }[]
    >`SELECT id, company_id, code, is_active FROM crm_task_type WHERE uid = ${uid}::uuid`;
    const row = rows[0];
    if (!row) throw new NotFoundException(MSG.taskTypeNotFound());
    return row;
  }

  async createTaskType(input: {
    companyUid?: string;
    code: string;
    nameRu: string;
    nameUz?: string;
    activityKind: string;
  }) {
    return this.prisma.withTenant(async (tx) => {
      const companyId = await this.resolveCompany(tx, input.companyUid);
      const code = this.code(input.code);
      await this.codeTaken(tx, 'crm_task_type', companyId, code);
      const nameRu = this.trim(input.nameRu);
      if (!nameRu) throw new UnprocessableEntityException(say('Название типа обязательно', 'Tur nomi majburiy'));

      const last = await this.count(
        tx,
        `SELECT coalesce(max(seq), 0) AS n FROM crm_task_type WHERE company_id = $1`,
        companyId,
      );
      const rows = await tx.$queryRawUnsafe<{ uid: string }[]>(
        `INSERT INTO crm_task_type (uid, company_id, code, name_ru, name_uz, activity_kind, seq)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::"CrmActivityType", $6) RETURNING uid`,
        companyId,
        code,
        nameRu,
        this.trim(input.nameUz) ?? nameRu,
        input.activityKind,
        last + 10,
      );
      return { uid: rows[0]!.uid };
    });
  }

  /**
   * Вид активности менять можно даже у использованного типа: уже записанные
   * активности лежат в ленте своим видом и задним числом не переписываются —
   * меняется только то, чем ляжет следующая закрытая задача.
   */
  async updateTaskType(
    uid: string,
    input: {
      code?: string;
      nameRu?: string;
      nameUz?: string;
      activityKind?: string;
      seq?: number;
      isActive?: boolean;
    },
  ) {
    return this.prisma.withTenant(async (tx) => {
      const row = await this.taskTypeRow(tx, uid);
      const tasks = await this.count(
        tx,
        `SELECT count(*) AS n FROM crm_task WHERE type_id = $1`,
        row.id,
      );

      let code: string | null = null;
      if (input.code !== undefined && this.code(input.code) !== row.code) {
        code = this.code(input.code);
        if (tasks > 0) {
          throw new ConflictException({
            message: say(`По типу заведено ${tasks} задач: код менять нельзя`, `Tur bo‘yicha ${tasks} vazifa kiritilgan: kodni o‘zgartirib bo‘lmaydi`),
            details: { tasks },
          });
        }
        await this.codeTaken(tx, 'crm_task_type', row.company_id, code, row.id);
      }
      if (input.isActive === false && row.is_active) {
        const left = await this.activeLeft(tx, 'crm_task_type', row.company_id, row.id);
        if (left === 0) {
          throw new UnprocessableEntityException(say(
            'Это последний тип задачи: задача без типа не заводится', 'Bu oxirgi vazifa turi: tursiz vazifa kiritilmaydi'));
        }
      }

      await tx.$executeRawUnsafe(
        `UPDATE crm_task_type
            SET code = COALESCE($2, code),
                name_ru = COALESCE($3, name_ru),
                name_uz = COALESCE($4, name_uz),
                activity_kind = COALESCE($5::"CrmActivityType", activity_kind),
                seq = COALESCE($6, seq),
                is_active = COALESCE($7, is_active)
          WHERE id = $1`,
        row.id,
        code,
        this.trim(input.nameRu),
        this.trim(input.nameUz),
        input.activityKind ?? null,
        input.seq ?? null,
        input.isActive ?? null,
      );
      return { uid, updated: true as const };
    });
  }

  async deleteTaskType(uid: string) {
    return this.prisma.withTenant(async (tx) => {
      const row = await this.taskTypeRow(tx, uid);
      const tasks = await this.count(
        tx,
        `SELECT count(*) AS n FROM crm_task WHERE type_id = $1`,
        row.id,
      );
      if (tasks > 0) {
        throw new ConflictException({
          message: say(`По типу заведено ${tasks} задач: удаление стёрло бы, чем они были, тип можно выключить`, `Tur bo‘yicha ${tasks} vazifa kiritilgan: o‘chirish ular nima bo‘lganini yo‘qotardi, turni o‘chirib qo‘yish mumkin`),
          details: { tasks },
        });
      }
      const left = await this.activeLeft(tx, 'crm_task_type', row.company_id, row.id);
      if (left === 0) {
        throw new UnprocessableEntityException(say(
          'Это последний тип задачи: задача без типа не заводится', 'Bu oxirgi vazifa turi: tursiz vazifa kiritilmaydi'));
      }
      await tx.$executeRawUnsafe(`DELETE FROM crm_task_type WHERE id = $1`, row.id);
      return { uid, removed: true as const };
    });
  }
}
