import {
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { TemplateHandler } from 'easy-template-x';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import {
  LocalDiskStorage,
  defaultStorageRoot,
  type FileStorage,
} from '../attachments/storage.js';
import { storageKey } from '../attachments/attachments.js';
import { PdfConvertError, PdfToolMissingError, docxToPdf } from './pdf.js';
import { MSG } from '../common/messages.js';
import { say } from '../common/say.js';

/**
 * Сборка печатной формы по шаблону (ТЗ 7.2).
 *
 * Два правила:
 *
 * 1. **Документ печатается тем шаблоном, которым его напечатали в первый раз.**
 *    Ссылка проставляется при первой сборке и дальше не меняется: заказчик
 *    обновил бумагу — новые документы идут по новой, а «перепечатай мартовский
 *    счёт» обязано дать мартовскую форму, ту самую, что ушла клиенту.
 * 2. **Подставляются только числа и строки самого документа.** Ни одного
 *    обращения к заказу: документ — снимок, и печать не повод его пересчитать.
 */
@Injectable()
export class DocumentRenderService {
  private readonly storage: FileStorage;

  constructor(private readonly prisma: PrismaService) {
    this.storage = new LocalDiskStorage(defaultStorageRoot());
  }

  /** Данные под шаблон: плоские ключи, значения — уже готовые к печати строки. */
  buildData(doc: Record<string, any>, lines: Record<string, any>[]) {
    const locale = doc.locale === 'uz' ? 'uz-UZ' : 'ru-RU';
    const money = (v: string | null) =>
      v === null || v === undefined
        ? ''
        : Number(v).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const qty = (v: string) =>
      Number(v).toLocaleString(locale, { maximumFractionDigits: 6 });
    const day = (v: string | null) =>
      v ? new Date(v).toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: 'numeric' }) : '';
    /** Банковские реквизиты печатают в столбик, а хранятся они объектом. */
    const bank = (v: unknown) => {
      if (!v || typeof v !== 'object') return '';
      return Object.entries(v as Record<string, unknown>)
        .filter(([, x]) => x !== null && x !== '')
        .map(([k, x]) => `${k}: ${x}`)
        .join('\n');
    };

    const r = (doc.requisites ?? {}) as Record<string, any>;
    const hasVat = Number(doc.amount_vat ?? 0) > 0;

    return {
      'doc.number': doc.number,
      'doc.date': day(doc.document_date),
      'doc.type': doc.locale === 'uz' ? doc.type_name_uz : doc.type_name_ru,
      'doc.basis': r.basis ?? '',

      'company.name': r.company?.name ?? '',
      'company.inn': r.company?.inn ?? '',
      'company.address': r.company?.legalAddress ?? '',
      'company.bank': bank(r.company?.bank),

      'partner.name': r.partner?.name ?? '',
      'partner.inn': r.partner?.inn ?? '',
      'partner.address': r.partner?.legalAddress ?? r.partner?.actualAddress ?? '',
      'partner.bank': bank(r.partner?.bank),

      'payment.dueDate': day(r.paymentDueDate ?? null),
      'payment.delayDays': r.paymentDelayDays === null || r.paymentDelayDays === undefined
        ? ''
        : String(r.paymentDelayDays),
      'delivery.date': day(r.deliveryDate ?? null),
      'transport.vehicle': r.vehicle ?? '',
      'transport.driver': r.driver ?? '',
      'transport.netWeight': r.netWeightT ?? '',
      'transport.grossWeight': r.grossWeightT ?? '',

      'amount.net': money(doc.amount_net),
      'amount.vat': money(doc.amount_vat),
      'amount.total': money(doc.amount_total),
      'amount.words': r.amountInWords ?? '',
      currency: r.currency ?? '',
      linesCount: String(lines.length),

      hasVat,
      noVat: !hasVat,
      hasPartner: Boolean(r.partner),
      hasLines: lines.length > 0,
      hasTransport: Boolean(r.vehicle || r.driver),

      lines: lines.map((l) => ({
        seq: String(l.seq),
        code: l.item_code ?? '',
        name: l.name,
        qty: qty(l.qty),
        unit: l.unit_code,
        price: money(l.price),
        vatRate: Number(l.vat_rate).toLocaleString(locale, { maximumFractionDigits: 2 }),
        net: money(l.amount_net),
        vat: money(l.amount_vat),
        total: money(l.amount_total),
      })),
    };
  }

  /**
   * Переименование по сопоставлению администратора.
   *
   * В бумаге заказчика может стоять `{НомерСчета}` — переписывать его файл мы
   * не вправе, поэтому сопоставление живёт у шаблона: тег → наше поле.
   */
  applyFieldMap(data: Record<string, any>, map: Record<string, string>) {
    const out = { ...data };
    for (const [tag, field] of Object.entries(map ?? {})) {
      if (field && field in data) out[tag] = data[field];
    }
    return out;
  }

  /** Собрать DOCX документа. Шаблон выбирается один раз и запоминается. */
  async docx(uid: string) {
    return this.prisma.withTenant(async (tx) => {
      const doc = await this.loadDocument(tx, uid);
      const template = await this.pickTemplate(tx, doc);

      const lines = await tx.$queryRawUnsafe<Record<string, any>[]>(
        `SELECT seq, item_code, name, qty::text AS qty, unit_code, unit_name,
                price::text AS price, vat_rate::text AS vat_rate,
                amount_net::text AS amount_net, amount_vat::text AS amount_vat,
                amount_total::text AS amount_total
           FROM document_line WHERE document_id = $1 ORDER BY seq`,
        doc.id,
      );

      const data = this.applyFieldMap(
        this.buildData(doc, lines),
        (template.field_map ?? {}) as Record<string, string>,
      );

      const handler = new TemplateHandler();
      const out = await handler.process(Buffer.from(template.content), data);

      // Запоминаем шаблон после успешной сборки: упавшая печать не должна
      // приколачивать документ к форме, которой он так и не напечатался.
      if (!doc.template_id) {
        await tx.$executeRawUnsafe(
          `UPDATE document SET template_id = $1 WHERE id = $2 AND template_id IS NULL`,
          template.id,
          doc.id,
        );
      }

      return { buffer: Buffer.from(out), fileName: this.fileName(doc, 'docx') };
    });
  }

  /**
   * Печатная форма в PDF.
   *
   * Собирается один раз и кладётся в хранилище вложений. Счёт скачивают,
   * отправляют, печатают и скачивают снова — запускать LibreOffice четыре
   * раза на один и тот же неизменившийся файл незачем.
   *
   * Готовый PDF считается годным, пока не изменилась версия документа.
   * Версия меняется правкой (это Э6) — тогда файл пересобирается, а старый
   * удаляется из хранилища: два PDF одного счёта не должны пережить правку,
   * иначе кто-то отправит клиенту прежний.
   */
  async pdf(uid: string) {
    const cached = await this.prisma.withTenant(async (tx) => {
      const doc = await this.loadDocument(tx, uid);
      if (!doc.pdf_key || doc.pdf_version !== doc.version) return null;
      try {
        return {
          buffer: await this.storage.get(doc.pdf_key as string),
          fileName: this.fileName(doc, 'pdf'),
        };
      } catch {
        // Ключ есть, а файла нет — не повод отказывать: соберём заново.
        return null;
      }
    });
    if (cached) return cached;

    const { buffer: docx } = await this.docx(uid);

    let bytes: Buffer;
    try {
      bytes = await docxToPdf(docx);
    } catch (e) {
      if (e instanceof PdfToolMissingError) {
        throw new ServiceUnavailableException(e.message);
      }
      if (e instanceof PdfConvertError) {
        throw new UnprocessableEntityException(say(
          `${e.message}. Проверьте шаблон: скачайте DOCX и откройте его в Word`, `${e.message}. Shablonni tekshiring: DOCX ni yuklab, Word da ochib ko‘ring`));
      }
      throw e;
    }

    return this.prisma.withTenant(async (tx) => {
      const doc = await this.loadDocument(tx, uid);
      const old = doc.pdf_key as string | null;
      const key = storageKey(doc.company_id as bigint, randomUUID(), 'application/pdf');
      await this.storage.put(key, bytes);
      await tx.$executeRawUnsafe(
        `UPDATE document
            SET pdf_key = $1, pdf_size = $2, pdf_built_at = now(), pdf_version = $3
          WHERE id = $4`,
        key,
        bytes.length,
        doc.version,
        doc.id,
      );
      if (old && old !== key) await this.storage.remove(old).catch(() => undefined);
      return { buffer: bytes, fileName: this.fileName(doc, 'pdf') };
    });
  }

  /**
   * Печатная форма прежней редакции.
   *
   * PDF отдаётся тот самый файл, что был собран тогда, — он лежит в архиве
   * вместе с редакцией. Пересобирать его нельзя: шрифты, шаблон и сама
   * программа с тех пор могли измениться, а спор с клиентом идёт о той
   * бумаге, которую он получил.
   *
   * DOCX собирается из снимка редакции её же шаблоном. Не из текущего
   * документа: у того уже другие цифры.
   */
  async versionFile(uid: string, version: number, format: 'docx' | 'pdf') {
    return this.prisma.withTenant(async (tx) => {
      const doc = await this.loadDocument(tx, uid);
      const rows = await tx.$queryRawUnsafe<Record<string, any>[]>(
        `SELECT v.version, v.status::text AS status, v.document_date,
                v.locale::text AS locale, v.requisites, v.lines,
                v.amount_net::text AS amount_net, v.amount_vat::text AS amount_vat,
                v.amount_total::text AS amount_total,
                v.pdf_key, v.template_id
           FROM document_version v
          WHERE v.document_id = $1 AND v.version = $2`,
        doc.id,
        version,
      );
      const v = rows[0];
      if (!v) throw new NotFoundException(say(`Редакции ${version} у этого документа нет`, `Bu hujjatda ${version} tahriri yo‘q`));

      const name = `${String(doc.number).replace(/[\/\\]/g, '-')}-v${version}.${format}`;

      if (format === 'pdf') {
        if (!v.pdf_key) {
          throw new ConflictException(say(
            `Редакция ${version} в PDF не печаталась, и собрать его заново нечестно: ` +
              'это был бы другой файл. Скачайте её DOCX', `${version} tahriri PDF ga chiqarilmagan, uni qaytadan yig‘ish halol emas: ` + 'bu boshqa fayl bo‘lardi. Uning DOCX ini yuklab oling'));
        }
        return { buffer: await this.storage.get(v.pdf_key as string), fileName: name };
      }

      if (!v.template_id) {
        throw new ConflictException(say(
          `Редакция ${version} не печаталась, формы у неё нет. ` +
            'Печатную форму получает только то, что печатали', `${version} tahriri chiqarilmagan, uning shakli yo‘q. ` + 'Chop etilgan shaklni faqat chiqarilgani oladi'));
      }
      const tpl = await tx.$queryRawUnsafe<Record<string, any>[]>(
        `SELECT id, content, field_map FROM document_template WHERE id = $1`,
        v.template_id,
      );
      if (!tpl[0]) {
        throw new ConflictException(say(
          `Шаблон редакции ${version} удалён из системы — напечатать её нечем`, `${version} tahririning shabloni tizimdan o‘chirilgan — uni chiqaradigan narsa yo‘q`));
      }

      const snapshot = {
        number: doc.number,
        document_date: v.document_date,
        locale: v.locale,
        amount_net: v.amount_net,
        amount_vat: v.amount_vat,
        amount_total: v.amount_total,
        requisites: v.requisites,
        type_name_ru: doc.type_name_ru,
        type_name_uz: doc.type_name_uz,
      };
      const lines = Array.isArray(v.lines) ? (v.lines as Record<string, any>[]) : [];
      // Строки в архиве лежат в тех же именах полей, что и в таблице, —
      // снимок снимался прямо из неё.
      const data = this.applyFieldMap(
        this.buildData(snapshot, lines),
        (tpl[0].field_map ?? {}) as Record<string, string>,
      );
      const out = await new TemplateHandler().process(Buffer.from(tpl[0].content), data);
      return { buffer: Buffer.from(out), fileName: name };
    });
  }

  /** Имя файла — из номера документа: в папке «Загрузки» их различают по нему. */
  private fileName(doc: Record<string, any>, ext: 'docx' | 'pdf') {
    return `${String(doc.number).replace(/[\/\\]/g, '-')}.${ext}`;
  }

  private async loadDocument(tx: Tx, uid: string) {
    const rows = await tx.$queryRawUnsafe<Record<string, any>[]>(
      `SELECT d.id, d.number, d.document_date, d.locale::text AS locale, d.template_id,
              d.version, d.pdf_key, d.pdf_version,
              d.amount_net::text AS amount_net, d.amount_vat::text AS amount_vat,
              d.amount_total::text AS amount_total, d.requisites,
              d.document_type_id, d.company_id,
              t.name_ru AS type_name_ru, t.name_uz AS type_name_uz, t.code AS type_code
         FROM document d
         JOIN document_type t ON t.id = d.document_type_id
        WHERE d.uid = $1::uuid`,
      uid,
    );
    if (!rows[0]) throw new NotFoundException(MSG.documentNotFound());
    return rows[0];
  }

  private async pickTemplate(tx: Tx, doc: Record<string, any>) {
    if (doc.template_id) {
      const rows = await tx.$queryRawUnsafe<Record<string, any>[]>(
        `SELECT id, content, field_map, version FROM document_template WHERE id = $1`,
        doc.template_id,
      );
      if (rows[0]) return rows[0];
    }
    const rows = await tx.$queryRawUnsafe<Record<string, any>[]>(
      `SELECT id, content, field_map, version FROM document_template
        WHERE document_type_id = $1 AND locale = $2::"Locale" AND is_published`,
      doc.document_type_id,
      doc.locale,
    );
    if (!rows[0]) {
      throw new ConflictException(say(
        `Для этого типа документа нет опубликованного шаблона на языке «${doc.locale}». ` +
          'Загрузите шаблон во вкладке «Шаблоны» и опубликуйте его', `Bu hujjat turi uchun «${doc.locale}» tilidagi e’lon qilingan shablon yo‘q. ` + '«Shablonlar» yorlig‘ida shablonni yuklab, e’lon qiling'));
    }
    return rows[0];
  }
}
