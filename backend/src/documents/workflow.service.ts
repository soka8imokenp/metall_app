import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { currentContext, requireContext } from '../common/request-context.js';
import { writeAudit } from '../common/audit.js';
import { amountInWords } from './amount-words.js';
import {
  EDIT_REFUSAL,
  EDIT_REFUSAL_UZ,
  TransitionError,
  availableActions,
  checkTransition,
  editMode,
  type DocumentAction,
  type DocumentStatus,
} from './workflow.js';
import { MSG } from '../common/messages.js';
import { say } from '../common/say.js';

export interface LineInput {
  name: string;
  qty: string;
  unitCode?: string;
  unitName?: string;
  itemCode?: string | null;
  price: string;
  discountPercent?: string;
  vatRate?: string;
}

export interface PatchInput {
  version: number;
  documentDate?: string;
  locale?: 'ru' | 'uz';
  lines?: LineInput[];
}

/**
 * Деньги документа — тийины, не доли тийина.
 *
 * Колонка держит четыре знака, потому что цена за тонну бывает с четырьмя
 * (0,3333), но сумма к оплате — нет: печатной формы на четверть тийина не
 * существует. 3 × 0,3333 = 0,9999 давало в цифрах 1,00, а прописью
 * «99 тийинов» — счёт, который спорит сам с собой, и клиент вправе его не
 * принять. Округляем здесь, до записи, чтобы итог, строки, слова и бумага
 * считали одну и ту же сумму.
 */
const money = (n: number) => n.toFixed(2);

/**
 * Согласование, версии и журнал документа (ТЗ 7.4).
 *
 * Три правила, на которых всё держится:
 *
 * 1. **Двигать документ и решать его судьбу — разные права.** Счёт выписывает
 *    менеджер, утверждает не он. Держит это таблица переходов в `workflow.ts`,
 *    а не проверки вразнобой по коду.
 * 2. **Правка утверждённого не переписывает его.** Прежняя редакция уходит в
 *    архив целиком — со своими суммами, строками, реквизитами и собранным
 *    PDF, — а документ возвращается в черновик: утверждали не это.
 * 3. **Каждое движение остаётся в журнале.** Той же транзакцией, что и само
 *    изменение: иначе «кто вернул счёт» однажды окажется без ответа.
 */
@Injectable()
export class DocumentWorkflowService {
  constructor(private readonly prisma: PrismaService) {}

  /** Движение по маршруту: отправить, утвердить, вернуть, подписать, отменить. */
  async act(uid: string, action: DocumentAction, comment?: string | null) {
    const ctx = requireContext();
    return this.prisma.withTenant(async (tx) => {
      const doc = await this.load(tx, uid);
      const status = doc.status as DocumentStatus;

      let rule;
      try {
        rule = checkTransition(action, status, comment);
      } catch (e) {
        if (e instanceof TransitionError) throw new UnprocessableEntityException(e.message);
        throw e;
      }
      // Право проверяет и маршрут, и декоратор на контроллере. Здесь — потому
      // что право зависит от действия, а действие приходит телом запроса:
      // один общий код на маршруте был бы либо шире нужного, либо запрещал бы
      // половину случаев.
      if (!ctx.permissions.has(rule.permission)) {
        throw new UnprocessableEntityException(say(
          `Для действия «${rule.titleRu}» нужно право «${rule.permission}»`, `«${rule.titleUz}» amali uchun «${rule.permission}» huquqi kerak`));
      }

      const text = String(comment ?? '').trim() || null;
      await tx.$executeRawUnsafe(
        `UPDATE document
            SET status = $1::"DocumentStatus", status_comment = $2,
                status_at = now(), status_by = $3
          WHERE id = $4`,
        rule.to,
        text,
        ctx.userId,
        doc.id,
      );
      await writeAudit(tx, {
        companyId: doc.company_id as bigint,
        entityType: 'document',
        entityId: uid,
        action,
        changes: {
          status: { from: status, to: rule.to },
          ...(text ? { comment: { from: null, to: text } } : {}),
        },
      });

      return { uid, status: rule.to, comment: text };
    });
  }

  /**
   * Правка документа.
   *
   * `version` в теле обязательна — как у карточки клиента: двое открыли
   * документ, один сохранил, второй не должен затереть чужое молча.
   */
  async patch(uid: string, body: PatchInput) {
    const ctx = requireContext();
    return this.prisma.withTenant(async (tx) => {
      const doc = await this.load(tx, uid);
      const status = doc.status as DocumentStatus;

      if (Number(doc.version) !== Number(body.version)) {
        throw new ConflictException({
          message: say(`Документ уже изменили: у вас версия ${body.version}, сейчас ${doc.version}. ` +
            'Откройте его заново', `Hujjat allaqachon o‘zgargan: sizda ${body.version} versiyasi, hozir ${doc.version}. ` + 'Uni qaytadan oching'),
          details: { version: Number(doc.version) },
        });
      }

      const mode = editMode(status);
      if (mode === 'forbidden') {
        throw new ConflictException(say(EDIT_REFUSAL[status] ?? 'Документ в этом статусе не правят', EDIT_REFUSAL_UZ[status] ?? 'Bu holatdagi hujjat tahrirlanmaydi'));
      }

      const countRow = await tx.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM document_line WHERE document_id = $1`,
        doc.id,
      );
      const before = {
        documentDate: this.day(doc.document_date),
        locale: doc.locale,
        amountTotal: doc.amount_total,
        linesCount: Number(countRow[0]?.n ?? 0),
      };

      // Правка утверждённого: прежняя редакция уходит в архив целиком.
      if (mode === 'newVersion') await this.snapshot(tx, doc, ctx.userId);

      const date = body.documentDate ?? this.day(doc.document_date);
      const locale = body.locale ?? (doc.locale as 'ru' | 'uz');

      let totals: { net: string; vat: string; total: string } | null = null;
      if (body.lines) {
        if (body.lines.length === 0) {
          throw new UnprocessableEntityException(say(
            'Табличную часть нельзя оставить пустой: документ без строк выписывают ' +
              'из сделки или платежа, а этот уже со строками', 'Jadval qismini bo‘sh qoldirib bo‘lmaydi: qatorsiz hujjat bitim yoki ' + 'to‘lovdan yoziladi, bunisi esa allaqachon qatorli'));
        }
        totals = await this.replaceLines(tx, doc, body.lines);
      }

      const requisites = this.retouchRequisites(
        (doc.requisites ?? {}) as Record<string, any>,
        totals ? totals.total : (doc.amount_total as string | null),
        locale,
      );

      const nextVersion = mode === 'newVersion' ? Number(doc.version) + 1 : Number(doc.version);
      // Правку утверждённого возвращаем в черновик: согласующий смотрел не
      // эти цифры, и оставить документ утверждённым значило бы подписать
      // чужими руками то, чего никто не видел.
      const nextStatus: DocumentStatus = mode === 'newVersion' ? 'draft' : status;

      await tx.$executeRawUnsafe(
        `UPDATE document
            SET document_date = $1::date, locale = $2::"Locale",
                amount_net = COALESCE($3::numeric, amount_net),
                amount_vat = COALESCE($4::numeric, amount_vat),
                amount_total = COALESCE($5::numeric, amount_total),
                requisites = $6::jsonb, version = $7,
                status = $8::"DocumentStatus",
                status_comment = CASE WHEN $9 THEN NULL ELSE status_comment END,
                status_at = CASE WHEN $9 THEN now() ELSE status_at END,
                status_by = CASE WHEN $9 THEN $10 ELSE status_by END,
                -- Готовый PDF относится к прежней редакции: он уехал вместе
                -- с ней в архив, и ссылку на него здесь надо снять, иначе
                -- документ печатался бы старым файлом.
                pdf_key = CASE WHEN $9 THEN NULL ELSE pdf_key END,
                pdf_size = CASE WHEN $9 THEN NULL ELSE pdf_size END,
                pdf_built_at = CASE WHEN $9 THEN NULL ELSE pdf_built_at END,
                pdf_version = CASE WHEN $9 THEN NULL ELSE pdf_version END
          WHERE id = $11`,
        date,
        locale,
        totals?.net ?? null,
        totals?.vat ?? null,
        totals?.total ?? null,
        JSON.stringify(requisites),
        nextVersion,
        nextStatus,
        mode === 'newVersion',
        ctx.userId,
        doc.id,
      );

      // Правка на месте тоже обнуляет готовый PDF: он собран из прежних цифр.
      if (mode === 'inplace' && (totals || body.documentDate || body.locale)) {
        await tx.$executeRawUnsafe(
          `UPDATE document SET pdf_key = NULL, pdf_size = NULL,
                               pdf_built_at = NULL, pdf_version = NULL
            WHERE id = $1`,
          doc.id,
        );
      }

      const changes: Record<string, { from: unknown; to: unknown }> = {};
      if (before.documentDate !== date) {
        changes.documentDate = { from: before.documentDate, to: date };
      }
      if (before.locale !== locale) changes.locale = { from: before.locale, to: locale };
      if (totals && String(before.amountTotal) !== totals.total) {
        changes.amountTotal = { from: before.amountTotal, to: totals.total };
      }
      if (totals) changes.lines = { from: before.linesCount, to: body.lines!.length };
      if (mode === 'newVersion') {
        changes.version = { from: Number(doc.version), to: nextVersion };
        changes.status = { from: status, to: nextStatus };
      }
      await writeAudit(tx, {
        companyId: doc.company_id as bigint,
        entityType: 'document',
        entityId: uid,
        action: mode === 'newVersion' ? 'edit_new_version' : 'edit',
        changes,
      });

      return { uid, version: nextVersion, status: nextStatus };
    });
  }

  /** Архив редакций: что было до правок и чем это печаталось. */
  async versions(uid: string) {
    return this.prisma.withTenant(async (tx) => {
      const doc = await this.load(tx, uid);
      const rows = await tx.$queryRawUnsafe<Record<string, any>[]>(
        `SELECT v.uid, v.version, v.status::text AS status, v.document_date,
                v.locale::text AS locale, v.amount_total::text AS amount_total,
                v.lines, v.pdf_key IS NOT NULL AS has_pdf,
                v.template_id IS NOT NULL AS has_template, v.replaced_at,
                u.full_name AS author
           FROM document_version v
           LEFT JOIN user_account u ON u.id = v.replaced_by
          WHERE v.document_id = $1
          ORDER BY v.version DESC`,
        doc.id,
      );
      return {
        current: Number(doc.version),
        rows: rows.map((r) => ({
          uid: r.uid,
          version: Number(r.version),
          status: r.status,
          documentDate: r.document_date,
          locale: r.locale,
          amountTotal: r.amount_total,
          linesCount: Array.isArray(r.lines) ? r.lines.length : 0,
          hasPdf: r.has_pdf === true,
          // Редакцию, которую не печатали, собрать нечем: шаблон закрепляется
          // на документе первой удачной печатью, и без него DOCX этой
          // редакции был бы не тем файлом, а догадкой о нём.
          hasTemplate: r.has_template === true,
          replacedAt: r.replaced_at,
          author: r.author ?? null,
        })),
      };
    });
  }

  /** Журнал по документу: движения по маршруту и правки. */
  async history(uid: string) {
    return this.prisma.withTenant(async (tx) => {
      await this.load(tx, uid);
      const rows = await tx.$queryRawUnsafe<Record<string, any>[]>(
        `SELECT a.occurred_at, a.action, a.changes, u.full_name AS user_name
           FROM audit_log a
           LEFT JOIN user_account u ON u.id = a.user_id
          WHERE a.entity_type = 'document' AND a.entity_id = $1
          ORDER BY a.occurred_at DESC, a.id DESC
          LIMIT 200`,
        uid,
      );
      return {
        rows: rows.map((r) => ({
          at: r.occurred_at,
          action: r.action as string,
          user: r.user_name ?? null,
          changes: (r.changes ?? {}) as Record<string, { from: unknown; to: unknown }>,
        })),
        total: rows.length,
      };
    });
  }

  /** Какие кнопки показывать на карточке при этих правах. */
  actionsFor(status: string) {
    const ctx = currentContext();
    return availableActions(status as DocumentStatus, ctx?.permissions ?? []);
  }

  // --- внутреннее ----------------------------------------------------------

  private async snapshot(tx: Tx, doc: Record<string, any>, userId: bigint | null) {
    const lines = await tx.$queryRawUnsafe<Record<string, any>[]>(
      `SELECT seq, item_code, name, qty::text AS qty, unit_code, unit_name,
              price::text AS price, discount_percent::text AS discount_percent,
              vat_rate::text AS vat_rate, amount_net::text AS amount_net,
              amount_vat::text AS amount_vat, amount_total::text AS amount_total
         FROM document_line WHERE document_id = $1 ORDER BY seq`,
      doc.id,
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO document_version
         (company_id, document_id, version, status, document_date, locale,
          amount_net, amount_vat, amount_total, requisites, lines,
          template_id, pdf_key, pdf_size, replaced_by)
       VALUES ($1, $2, $3, $4::"DocumentStatus", $5::date, $6::"Locale",
               $7::numeric, $8::numeric, $9::numeric, $10::jsonb, $11::jsonb,
               $12, $13, $14, $15)`,
      doc.company_id,
      doc.id,
      Number(doc.version),
      doc.status,
      this.day(doc.document_date),
      doc.locale,
      doc.amount_net,
      doc.amount_vat,
      doc.amount_total,
      JSON.stringify(doc.requisites ?? null),
      JSON.stringify(lines),
      doc.template_id,
      doc.pdf_key,
      doc.pdf_size,
      userId,
    );
  }

  private async replaceLines(tx: Tx, doc: Record<string, any>, input: LineInput[]) {
    const computed = input.map((l, i) => {
      const qty = Number(l.qty);
      const price = Number(l.price);
      const discount = Number(l.discountPercent ?? '0');
      const vatRate = Number(l.vatRate ?? '0');
      if (!Number.isFinite(qty) || qty <= 0) {
        throw new UnprocessableEntityException(say(
          `Строка ${i + 1}: количество должно быть больше нуля`, `${i + 1}-qator: miqdor noldan katta bo‘lishi kerak`));
      }
      if (!Number.isFinite(price) || price < 0) {
        throw new UnprocessableEntityException(say(`Строка ${i + 1}: цена не может быть отрицательной`, `${i + 1}-qator: narx manfiy bo‘lmaydi`));
      }
      if (!String(l.name ?? '').trim()) {
        throw new UnprocessableEntityException(say(`Строка ${i + 1}: наименование обязательно`, `${i + 1}-qator: nomi majburiy`));
      }
      const gross = qty * price;
      const net = gross * (1 - discount / 100);
      const vat = net * (vatRate / 100);
      return {
        seq: i + 1,
        name: String(l.name).trim(),
        itemCode: l.itemCode ?? null,
        qty: String(qty),
        unitCode: l.unitCode ?? '',
        unitName: l.unitName ?? '',
        price: String(price),
        discountPercent: String(discount),
        vatRate: String(vatRate),
        amountNet: money(net),
        amountVat: money(vat),
        amountTotal: money(net + vat),
      };
    });

    // Строки заменяются целиком, а не правятся по одной: документ — снимок,
    // и его табличная часть это один предмет, а не набор независимых записей.
    await tx.$executeRawUnsafe(`DELETE FROM document_line WHERE document_id = $1`, doc.id);
    for (const l of computed) {
      await tx.$executeRawUnsafe(
        `INSERT INTO document_line
           (company_id, document_id, seq, item_code, name, qty, unit_code, unit_name,
            price, discount_percent, vat_rate, amount_net, amount_vat, amount_total)
         VALUES ($1, $2, $3, $4, $5, $6::numeric, $7, $8, $9::numeric, $10::numeric,
                 $11::numeric, $12::numeric, $13::numeric, $14::numeric)`,
        doc.company_id,
        doc.id,
        l.seq,
        l.itemCode,
        l.name,
        l.qty,
        l.unitCode,
        l.unitName,
        l.price,
        l.discountPercent,
        l.vatRate,
        l.amountNet,
        l.amountVat,
        l.amountTotal,
      );
    }

    const sum = (pick: (l: (typeof computed)[number]) => string) =>
      money(computed.reduce((a, l) => a + Number(pick(l)), 0));
    return {
      net: sum((l) => l.amountNet),
      vat: sum((l) => l.amountVat),
      total: sum((l) => l.amountTotal),
    };
  }

  /**
   * Реквизиты после правки.
   *
   * Пересчитывается только сумма прописью — она выводится из итога, и
   * оставить её прежней значит напечатать счёт, где цифры и слова расходятся.
   * Остальное в реквизитах — снимок на момент выписки, и правка его не
   * трогает: адрес контрагента в выписанном счёте тот, по которому его
   * приняли.
   */
  private retouchRequisites(
    req: Record<string, any>,
    total: string | null,
    locale: 'ru' | 'uz',
  ) {
    if (total === null || total === undefined) return req;
    return {
      ...req,
      amountInWords: amountInWords(total, (req.currency as string) ?? 'UZS', locale),
    };
  }

  private day(v: unknown) {
    return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
  }

  private async load(tx: Tx, uid: string) {
    const rows = await tx.$queryRawUnsafe<Record<string, any>[]>(
      `SELECT id, company_id, number, version, status::text AS status, locale::text AS locale,
              document_date, amount_net::text AS amount_net, amount_vat::text AS amount_vat,
              amount_total::text AS amount_total, requisites, template_id, pdf_key, pdf_size
         FROM document WHERE uid = $1::uuid`,
      uid,
    );
    if (!rows[0]) throw new NotFoundException(MSG.documentNotFound());
    return rows[0];
  }
}
