import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { TemplateHandler } from 'easy-template-x';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { currentContext } from '../common/request-context.js';
import { DocumentRenderService } from './render.service.js';
import { fieldsCatalogue, isKnownField } from './template-fields.js';
import { MSG } from '../common/messages.js';
import { say } from '../common/say.js';

/** DOCX — zip; первые два байта у него всегда PK. */
const looksLikeDocx = (b: Buffer) =>
  b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05);

const MAX_SIZE = 5 * 1024 * 1024;

/**
 * Шаблоны печатных форм (ТЗ 7.2).
 *
 * Порядок работы задан требованием «администратор сопоставляет плейсхолдеры
 * с полями системы»: загрузил файл → система прочитала из него теги → назвала
 * те, которых не знает → администратор либо правит бумагу, либо сопоставляет
 * чужое имя с нашим полем → и только тогда публикует.
 *
 * Публикация — отдельное действие, и это главное правило этапа. Загруженный
 * файл не печатается сам собой: шаблон с опечаткой в теге дал бы пустую
 * строку в счёте, который уже ушёл клиенту. Поэтому до публикации шаблон
 * обязан собраться на настоящем документе этого типа.
 */
@Injectable()
export class DocumentTemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly render: DocumentRenderService,
  ) {}

  private async count(tx: Tx, sql: string, ...p: unknown[]) {
    const rows = await tx.$queryRawUnsafe<{ n: bigint }[]>(sql, ...p);
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * Теги файла с разбором на знакомые и чужие.
   *
   * Открывающий и закрывающий теги цикла приходят парой — считаем их один
   * раз, иначе администратору показалось бы, что тегов вдвое больше.
   */
  async readTags(file: Buffer, fieldMap: Record<string, string> = {}) {
    let raw;
    try {
      raw = await new TemplateHandler().parseTags(file);
    } catch (e) {
      throw new UnprocessableEntityException(say(
        `Файл не читается как шаблон DOCX: ${(e as Error).message}`, `Fayl DOCX shablon sifatida o‘qilmadi: ${(e as Error).message}`));
    }
    const seen = new Map<string, string>();
    for (const t of raw) {
      const name = String(t.name ?? '').trim();
      if (!name) continue;
      const kind = String(t.disposition) === 'SelfClosed' ? 'text' : 'block';
      if (!seen.has(name)) seen.set(name, kind);
    }
    const tags = [...seen.entries()].map(([name, kind]) => ({
      name,
      kind,
      known: isKnownField(name) || Boolean(fieldMap[name]),
      mappedTo: fieldMap[name] ?? null,
    }));
    return {
      tags,
      unknown: tags.filter((t) => !t.known).map((t) => t.name),
    };
  }

  async list(documentTypeUid?: string) {
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.$queryRawUnsafe<Record<string, any>[]>(
        `SELECT tpl.uid, tpl.locale::text AS locale, tpl.version, tpl.file_name,
                tpl.file_size, tpl.tags, tpl.field_map, tpl.is_published,
                tpl.created_at, tpl.published_at,
                t.uid AS type_uid, t.code AS type_code, t.name_ru AS type_name_ru,
                t.name_uz AS type_name_uz,
                co.uid AS company_uid, co.code AS company_code,
                u.full_name AS author,
                (SELECT count(*) FROM document d WHERE d.template_id = tpl.id) AS printed
           FROM document_template tpl
           JOIN document_type t ON t.id = tpl.document_type_id
           JOIN company co ON co.id = tpl.company_id
           LEFT JOIN user_account u ON u.id = tpl.created_by
          WHERE ($1::uuid IS NULL OR t.uid = $1::uuid)
          ORDER BY co.code, t.code, tpl.locale, tpl.version DESC`,
        documentTypeUid ?? null,
      );
      return {
        rows: rows.map((r) => ({
          uid: r.uid,
          locale: r.locale,
          version: r.version,
          fileName: r.file_name,
          fileSize: Number(r.file_size),
          tags: r.tags,
          fieldMap: r.field_map,
          isPublished: r.is_published,
          createdAt: r.created_at,
          publishedAt: r.published_at,
          author: r.author ?? null,
          printed: Number(r.printed),
          type: {
            uid: r.type_uid,
            code: r.type_code,
            nameRu: r.type_name_ru,
            nameUz: r.type_name_uz,
          },
          company: { uid: r.company_uid, code: r.company_code },
        })),
      };
    });
  }

  async upload(params: {
    documentTypeUid: string;
    locale: 'ru' | 'uz';
    fileName: string;
    file: Buffer;
  }) {
    const ctx = currentContext();
    if (!looksLikeDocx(params.file)) {
      throw new UnprocessableEntityException(say(
        'Это не DOCX. Шаблон — файл Word, сохранённый как .docx, а не .doc и не PDF', 'Bu DOCX emas. Shablon — .docx ko‘rinishida saqlangan Word fayli, .doc yoki PDF emas'));
    }
    if (params.file.length > MAX_SIZE) {
      throw new UnprocessableEntityException(say('Шаблон больше 5 МБ', 'Shablon 5 MB dan katta'));
    }

    const { tags } = await this.readTags(params.file);

    return this.prisma.withTenant(async (tx) => {
      const type = await this.loadType(tx, params.documentTypeUid);
      const next =
        (await this.count(
          tx,
          `SELECT coalesce(max(version), 0) AS n FROM document_template
            WHERE document_type_id = $1 AND locale = $2::"Locale"`,
          type.id,
          params.locale,
        )) + 1;

      const rows = await tx.$queryRawUnsafe<{ uid: string }[]>(
        `INSERT INTO document_template
           (company_id, document_type_id, locale, version, file_name, file_size,
            content, tags, is_published, created_by)
         VALUES ($1, $2, $3::"Locale", $4, $5, $6, $7, $8::jsonb, false, $9)
         RETURNING uid`,
        type.company_id,
        type.id,
        params.locale,
        next,
        params.fileName.slice(0, 200),
        params.file.length,
        params.file,
        JSON.stringify(tags),
        ctx?.userId ?? null,
      );
      return { uid: rows[0]!.uid, version: next, tags };
    });
  }

  /** Сопоставление чужих тегов с полями системы. */
  async setFieldMap(uid: string, fieldMap: Record<string, string>) {
    for (const [tag, field] of Object.entries(fieldMap)) {
      if (!isKnownField(field)) {
        throw new UnprocessableEntityException(say(
          `Поля «${field}» нет: тег «${tag}» не с чем сопоставлять`, `«${field}» maydoni yo‘q: «${tag}» tegini solishtirishga narsa yo‘q`));
      }
    }
    return this.prisma.withTenant(async (tx) => {
      const tpl = await this.load(tx, uid);
      if (tpl.is_published) {
        throw new ConflictException(say(
          'Шаблон опубликован: сопоставление у него менять нельзя — ' +
            'по нему уже печатают. Загрузите новую версию', 'Shablon e’lon qilingan: unda moslashtirishni o‘zgartirib bo‘lmaydi — ' + 'u bo‘yicha allaqachon chiqarilmoqda. Yangi versiyani yuklang'));
      }
      const { tags } = await this.readTags(Buffer.from(tpl.content), fieldMap);
      await tx.$executeRawUnsafe(
        `UPDATE document_template SET field_map = $1::jsonb, tags = $2::jsonb WHERE id = $3`,
        JSON.stringify(fieldMap),
        JSON.stringify(tags),
        tpl.id,
      );
      return { uid, tags };
    });
  }

  /**
   * Проверка шаблона на настоящем документе — до публикации.
   *
   * Берём последний документ этого типа. Нет ни одного — говорим об этом
   * прямо, а не подсовываем выдуманный: шаблон, проверенный на пустых
   * значениях, скроет ровно ту ошибку, ради которой проверка и нужна.
   */
  async check(uid: string) {
    return this.prisma.withTenant(async (tx) => {
      const tpl = await this.load(tx, uid);
      const { tags, unknown } = await this.readTags(
        Buffer.from(tpl.content),
        (tpl.field_map ?? {}) as Record<string, string>,
      );

      const docs = await tx.$queryRawUnsafe<Record<string, any>[]>(
        `SELECT d.id, d.uid, d.number, d.document_date, d.locale::text AS locale,
                d.amount_net::text AS amount_net, d.amount_vat::text AS amount_vat,
                d.amount_total::text AS amount_total, d.requisites,
                t.name_ru AS type_name_ru, t.name_uz AS type_name_uz
           FROM document d
           JOIN document_type t ON t.id = d.document_type_id
          WHERE d.document_type_id = $1
          ORDER BY d.id DESC LIMIT 1`,
        tpl.document_type_id,
      );
      const doc = docs[0];
      if (!doc) {
        return {
          ok: false,
          unknown,
          tags,
          sampleNumber: null,
          message:
            'По этому типу ещё нет ни одного документа — проверить шаблон не на чем. ' +
            'Выпишите документ и повторите проверку',
        };
      }

      const lines = await tx.$queryRawUnsafe<Record<string, any>[]>(
        `SELECT seq, item_code, name, qty::text AS qty, unit_code, unit_name,
                price::text AS price, vat_rate::text AS vat_rate,
                amount_net::text AS amount_net, amount_vat::text AS amount_vat,
                amount_total::text AS amount_total
           FROM document_line WHERE document_id = $1 ORDER BY seq`,
        doc.id,
      );

      const data = this.render.applyFieldMap(
        this.render.buildData(doc, lines),
        (tpl.field_map ?? {}) as Record<string, string>,
      );
      try {
        await new TemplateHandler().process(Buffer.from(tpl.content), data);
      } catch (e) {
        return {
          ok: false,
          unknown,
          tags,
          sampleNumber: doc.number,
          message: `Шаблон не собрался на документе ${doc.number}: ${(e as Error).message}`,
        };
      }

      return {
        ok: unknown.length === 0,
        unknown,
        tags,
        sampleNumber: doc.number,
        message:
          unknown.length === 0
            ? `Шаблон собрался на документе ${doc.number}`
            : `Шаблон собрался, но эти теги ничем не заполнятся: ${unknown.join(', ')}`,
      };
    });
  }

  async publish(uid: string) {
    const check = await this.check(uid);
    if (!check.ok) throw new UnprocessableEntityException(check.message);

    return this.prisma.withTenant(async (tx) => {
      const tpl = await this.load(tx, uid);
      // Опубликованный на этот тип и язык снимается: их не бывает двух,
      // иначе «какой из них печатается» — вопрос без ответа.
      await tx.$executeRawUnsafe(
        `UPDATE document_template SET is_published = false
          WHERE document_type_id = $1 AND locale = $2::"Locale" AND is_published AND id <> $3`,
        tpl.document_type_id,
        tpl.locale,
        tpl.id,
      );
      await tx.$executeRawUnsafe(
        `UPDATE document_template SET is_published = true, published_at = now() WHERE id = $1`,
        tpl.id,
      );
      return { uid, published: true };
    });
  }

  async unpublish(uid: string) {
    return this.prisma.withTenant(async (tx) => {
      const tpl = await this.load(tx, uid);
      await tx.$executeRawUnsafe(
        `UPDATE document_template SET is_published = false, published_at = NULL WHERE id = $1`,
        tpl.id,
      );
      return { uid, published: false };
    });
  }

  async remove(uid: string) {
    return this.prisma.withTenant(async (tx) => {
      const tpl = await this.load(tx, uid);
      const printed = await this.count(
        tx,
        `SELECT count(*) AS n FROM document WHERE template_id = $1`,
        tpl.id,
      );
      if (printed > 0) {
        throw new ConflictException({
          message: say(`Этим шаблоном напечатано документов: ${printed}. Такой шаблон не удаляют — ` +
            'иначе их нельзя будет перепечатать в том виде, в каком они ушли клиенту. ' +
            'Загрузите новую версию, старая останется у прошлых документов', `Bu shablon bilan chiqarilgan hujjatlar: ${printed}. Bunday shablon o‘chirilmaydi — ` + 'aks holda ularni mijozga ketgan ko‘rinishda qayta chiqarib bo‘lmaydi. ' + 'Yangi versiyani yuklang, eskisi o‘tgan hujjatlarda qoladi'),
          details: { printed },
        });
      }
      if (tpl.is_published) {
        throw new ConflictException(say(
          'Шаблон опубликован: сначала снимите публикацию, потом удаляйте', 'Shablon e’lon qilingan: avval e’lonni olib tashlang, keyin o‘chiring'));
      }
      await tx.$executeRawUnsafe(`DELETE FROM document_template WHERE id = $1`, tpl.id);
      return { uid };
    });
  }

  async file(uid: string) {
    return this.prisma.withTenant(async (tx) => {
      const tpl = await this.load(tx, uid);
      return { buffer: Buffer.from(tpl.content), fileName: tpl.file_name as string };
    });
  }

  fields() {
    return fieldsCatalogue();
  }

  private async load(tx: Tx, uid: string) {
    const rows = await tx.$queryRawUnsafe<Record<string, any>[]>(
      `SELECT id, company_id, document_type_id, locale::text AS locale, version,
              file_name, content, tags, field_map, is_published
         FROM document_template WHERE uid = $1::uuid`,
      uid,
    );
    if (!rows[0]) throw new NotFoundException(say('Шаблон не найден', 'Shablon topilmadi'));
    return rows[0];
  }

  private async loadType(tx: Tx, uid: string) {
    const rows = await tx.$queryRawUnsafe<Record<string, any>[]>(
      `SELECT id, company_id, code, name_ru, is_active FROM document_type WHERE uid = $1::uuid`,
      uid,
    );
    const t = rows[0];
    if (!t) throw new NotFoundException(MSG.documentTypeNotFound());
    return t;
  }
}
