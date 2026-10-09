import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { currentContext } from '../common/request-context.js';
import { checkMaskWithScope, renderNumber } from './numbering.js';
import { NumberingService } from './numbering.service.js';
import { MSG } from '../common/messages.js';
import { say } from '../common/say.js';

type Scope = 'company' | 'company_period';

/**
 * Типы документов и нумерация на запись (ТЗ 7.3).
 *
 * Правила те же, что у складских и CRM-справочников, и по той же причине:
 * запись, по которой уже что-то сделано, выключается, а не удаляется, а
 * правка, меняющая смысл уже записанного, отклоняется с объяснением.
 *
 * Здесь к ним добавляется своё, чего у других справочников нет:
 *
 * - **Код типа заморожен с первого документа.** Он уходит в номер через
 *   `{TYPE}` и остаётся в уже напечатанных бумагах.
 * - **Область счётчика заморожена с первого выданного номера.** Переключив
 *   сквозной счётчик на периодический, мы начали бы год с единицы и выдали
 *   номер, который уже лежит в базе.
 * - **Маску менять можно, и действует она вперёд.** Выданные номера не
 *   переписываются: они напечатаны на бумаге и названы в договорах.
 */
@Injectable()
export class DocumentTypesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
  ) {}

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

  /** Код типа: латиница в верхнем регистре — он уходит в номер через {TYPE}. */
  private code(raw: string): string {
    const code = raw.trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9_-]*$/.test(code)) {
      throw new UnprocessableEntityException(say(
        'Код пишется латиницей: буквы, цифры, дефис и подчёркивание', 'Kod lotin harflarida yoziladi: harflar, raqamlar, chiziqcha va pastki chiziq'));
    }
    if (code.length > 20) throw new UnprocessableEntityException(say('Код длиннее 20 знаков', 'Kod 20 belgidan uzun'));
    return code;
  }

  private name(raw: string | undefined, what: string): string {
    const v = raw?.trim();
    if (!v) throw new UnprocessableEntityException(say(`Не заполнено: ${what}`, `To‘ldirilmagan: ${what}`));
    if (v.length > 120) throw new UnprocessableEntityException(say(`${what}: длиннее 120 знаков`, `${what}: 120 belgidan uzun`));
    return v;
  }

  private async load(tx: Tx, uid: string) {
    const rows = await tx.$queryRawUnsafe<Record<string, any>[]>(
      `SELECT t.id, t.uid, t.company_id, t.code, t.name_ru, t.name_uz,
              t.numbering_mask, t.counter_scope::text AS counter_scope, t.is_active,
              co.code AS company_code
         FROM document_type t
         JOIN company co ON co.id = t.company_id
        WHERE t.uid = $1::uuid`,
      uid,
    );
    const row = rows[0];
    if (!row) throw new NotFoundException(MSG.documentTypeNotFound());
    return row;
  }

  /** Где тип уже участвует: документы и выданные номера. */
  private async usage(tx: Tx, typeId: bigint) {
    const documents = await this.count(
      tx,
      `SELECT count(*) AS n FROM document WHERE document_type_id = $1`,
      typeId,
    );
    const issued = await this.count(
      tx,
      `SELECT coalesce(sum(last_number), 0) AS n FROM document_counter
        WHERE document_type_id = $1`,
      typeId,
    );
    return { documents, issued };
  }

  // --- чтение ---------------------------------------------------------------

  async list(showHidden = false) {
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.$queryRawUnsafe<Record<string, any>[]>(
        `SELECT t.id, t.uid, t.code, t.name_ru, t.name_uz, t.numbering_mask,
                t.counter_scope::text AS counter_scope, t.is_active,
                co.id AS company_id, co.uid AS company_uid, co.code AS company_code,
                co.name_ru AS company_name_ru, co.name_uz AS company_name_uz,
                (SELECT count(*) FROM document d WHERE d.document_type_id = t.id) AS documents,
                (SELECT coalesce(sum(c.last_number), 0) FROM document_counter c
                  WHERE c.document_type_id = t.id) AS issued
           FROM document_type t
           JOIN company co ON co.id = t.company_id
          WHERE ($1::boolean OR t.is_active)
          ORDER BY co.code, t.code`,
        showHidden,
      );

      const today = new Date();
      const out = [];
      for (const r of rows) {
        out.push({
          uid: r.uid,
          code: r.code,
          nameRu: r.name_ru,
          nameUz: r.name_uz,
          numberingMask: r.numbering_mask,
          counterScope: r.counter_scope as Scope,
          isActive: r.is_active,
          company: {
            uid: r.company_uid,
            code: r.company_code,
            nameRu: r.company_name_ru,
            nameUz: r.company_name_uz,
          },
          usage: { documents: Number(r.documents), issued: Number(r.issued) },
          // Следующий номер показываем, не занимая: справочник открывают
          // чаще, чем выписывают документ, и дырки в нумерации от просмотра
          // объяснить потом невозможно.
          nextNumber: await this.numbering.peek(
            tx,
            {
              id: r.id,
              companyId: r.company_id,
              code: r.code,
              mask: r.numbering_mask,
              scope: r.counter_scope as Scope,
            },
            { code: r.company_code },
            today,
          ),
        });
      }
      return { rows: out };
    });
  }

  // --- запись ---------------------------------------------------------------

  async create(body: {
    companyUid?: string;
    code: string;
    nameRu: string;
    nameUz: string;
    numberingMask: string;
    counterScope?: Scope;
  }) {
    return this.prisma.withTenant(async (tx) => {
      const companyId = await this.resolveCompany(tx, body.companyUid);
      const code = this.code(body.code);
      const nameRu = this.name(body.nameRu, 'название по-русски');
      const nameUz = this.name(body.nameUz, 'название по-узбекски');
      const scope: Scope = body.counterScope ?? 'company_period';
      const mask = body.numberingMask.trim();
      checkMaskWithScope(mask, scope);

      const taken = await this.count(
        tx,
        `SELECT count(*) AS n FROM document_type WHERE company_id = $1 AND code = $2`,
        companyId,
        code,
      );
      if (taken) throw new ConflictException(say(`Тип с кодом ${code} в этой компании уже есть`, `${code} kodli tur bu kompaniyada allaqachon bor`));

      const rows = await tx.$queryRawUnsafe<{ uid: string }[]>(
        // uid ставим сами: умолчания в базе у него нет — так же, как у
        // справочников CRM, которые пишутся сырым SQL.
        `INSERT INTO document_type
           (uid, company_id, code, name_ru, name_uz, numbering_mask, counter_scope, is_active)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6::"CounterScope", true)
         RETURNING uid`,
        companyId,
        code,
        nameRu,
        nameUz,
        mask,
        scope,
      );
      return { uid: rows[0]!.uid };
    });
  }

  async patch(
    uid: string,
    body: {
      code?: string;
      nameRu?: string;
      nameUz?: string;
      numberingMask?: string;
      counterScope?: Scope;
      isActive?: boolean;
    },
  ) {
    return this.prisma.withTenant(async (tx) => {
      const t = await this.load(tx, uid);
      const used = await this.usage(tx, t.id);

      const sets: string[] = [];
      const args: unknown[] = [];
      const put = (col: string, value: unknown, cast = '') => {
        args.push(value);
        sets.push(`${col} = $${args.length}${cast}`);
      };

      if (body.code !== undefined) {
        const code = this.code(body.code);
        if (code !== t.code) {
          if (used.documents > 0 || used.issued > 0) {
            throw new ConflictException({
              message: say('Код типа уже в выданных номерах и в истории документов — его не меняют. ' +
                'Заведите новый тип, а этот выключите', 'Tur kodi berilgan raqamlarda va hujjatlar tarixida bor — u o‘zgartirilmaydi. ' + 'Yangi tur kiriting, bunisini o‘chirib qo‘ying'),
              details: used,
            });
          }
          const taken = await this.count(
            tx,
            `SELECT count(*) AS n FROM document_type
              WHERE company_id = $1 AND code = $2 AND id <> $3`,
            t.company_id,
            code,
            t.id,
          );
          if (taken) throw new ConflictException(say(`Тип с кодом ${code} в этой компании уже есть`, `${code} kodli tur bu kompaniyada allaqachon bor`));
          put('code', code);
        }
      }

      const scope: Scope = (body.counterScope ?? t.counter_scope) as Scope;
      if (body.counterScope !== undefined && body.counterScope !== t.counter_scope) {
        if (used.issued > 0) {
          throw new ConflictException({
            message: say('По типу уже выданы номера: сменив область счётчика, мы начнём период ' +
              'заново и повторим уже выданный номер', 'Tur bo‘yicha raqamlar berilgan: hisoblagich sohasini o‘zgartirsak, davrni ' + 'qaytadan boshlaymiz va berilgan raqamni takrorlaymiz'),
            details: used,
          });
        }
        put('counter_scope', scope, '::"CounterScope"');
      }

      if (body.numberingMask !== undefined) {
        const mask = body.numberingMask.trim();
        checkMaskWithScope(mask, scope);
        put('numbering_mask', mask);
      } else if (body.counterScope !== undefined) {
        // Маска осталась прежней, а область счётчика меняется — их всё равно
        // надо сверить между собой.
        checkMaskWithScope(t.numbering_mask, scope);
      }

      if (body.nameRu !== undefined) put('name_ru', this.name(body.nameRu, 'название по-русски'));
      if (body.nameUz !== undefined) put('name_uz', this.name(body.nameUz, 'название по-узбекски'));
      if (body.isActive !== undefined) put('is_active', body.isActive);

      if (!sets.length) return { uid };
      args.push(t.id);
      await tx.$executeRawUnsafe(
        `UPDATE document_type SET ${sets.join(', ')} WHERE id = $${args.length}`,
        ...args,
      );
      return { uid };
    });
  }

  async remove(uid: string) {
    return this.prisma.withTenant(async (tx) => {
      const t = await this.load(tx, uid);
      const used = await this.usage(tx, t.id);
      if (used.documents > 0 || used.issued > 0) {
        throw new ConflictException({
          message: say(`По типу «${t.name_ru}» записано документов: ${used.documents}, ` +
            `выдано номеров: ${used.issued}. Такой тип выключают, а не удаляют — ` +
            'иначе из истории пропадёт, чем эти документы были', `«${t.name}» turi bo‘yicha yozilgan hujjatlar: ${used.documents}, ` + `berilgan raqamlar: ${used.issued}. Bunday tur o‘chirib qo‘yiladi, o‘chirib tashlanmaydi — ` + 'aks holda tarixdan bu hujjatlar nima bo‘lgani yo‘qoladi'),
          details: used,
        });
      }
      await tx.$executeRawUnsafe(`DELETE FROM document_type WHERE id = $1`, t.id);
      return { uid };
    });
  }

  /**
   * Каким будет следующий номер по этой маске — подсказка в форме.
   *
   * Для существующего типа считается от его счётчика, а не от единицы: у
   * счёта выдано  номеров, и форма правки, обещающая «СЧ-26/00001»,
   * показывала бы число, которого не будет. Счётчик при этом не двигается —
   * форму открывают чаще, чем выписывают документ.
   */
  async sample(mask: string, scope: Scope, code: string, typeUid?: string) {
    checkMaskWithScope(mask, scope);
    if (!typeUid) {
      return {
        sample: renderNumber(mask, 1, {
          date: new Date(),
          typeCode: code || 'TYPE',
          companyCode: 'trade',
        }),
      };
    }
    return this.prisma.withTenant(async (tx) => {
      const t = await this.load(tx, typeUid);
      return {
        sample: await this.numbering.peek(
          tx,
          {
            id: t.id,
            companyId: t.company_id,
            code: code || t.code,
            mask,
            scope,
          },
          { code: t.company_code },
          new Date(),
        ),
      };
    });
  }
}
