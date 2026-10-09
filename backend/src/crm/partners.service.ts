import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { currentContext } from '../common/request-context.js';
import { diff, writeAudit } from '../common/audit.js';
import { MSG } from '../common/messages.js';
import { say } from '../common/say.js';

/**
 * Клиенты и поставщики — карточка контрагента (ТЗ 8.2).
 *
 * Это основание всего модуля CRM: лид превращается в клиента, сделка ссылается
 * на клиента, заказ и документ создаются из его карточки. Поэтому таблица одна
 * на все роли контрагента — `is_client` и `is_supplier` это признаки, а не два
 * разных справочника. Один и тот же завод и покупает у нас, и возит нам трубу;
 * заведённый дважды, он дал бы две разные задолженности по одному ИНН.
 *
 * Правила записи те же, что в складских справочниках, и по той же причине:
 *
 * - **Участвовал в операциях — выключается, а не удаляется.** Удалённый клиент
 *   увёл бы из истории имя, по которому читается прошлое: «отгружено кому»
 *   превратилось бы в «отгружено пусто».
 * - **Правка, меняющая смысл записанного, отклоняется.** ИНН — реквизит, он
 *   уже напечатан в выставленных счетах и накладных. Сменить его у клиента с
 *   отгрузками и платежами значит задним числом переписать, кому они ушли.
 * - **Версия записи обязательна при правке** (контракт §1.7): двое открыли
 *   карточку, один сохранил — второй должен узнать об этом, а не затереть.
 */
@Injectable()
export class PartnersService {
  constructor(private readonly prisma: PrismaService) {}

  /** Компания запроса: клиент заводится в одну компанию, а не в обе сразу. */
  private async resolveCompany(tx: Tx, companyUid: string | undefined): Promise<bigint> {
    const ids = currentContext()?.companyIds ?? [];
    if (ids.length === 0) throw new UnprocessableEntityException(MSG.noCompany());

    if (!companyUid) {
      if (ids.length > 1) {
        throw new UnprocessableEntityException(say(
          'Выбраны обе компании: укажите, в чьей базе заводим клиента', 'Ikkala kompaniya tanlangan: mijoz kimning bazasiga kiritilishini ko‘rsating'));
      }
      return ids[0]!;
    }

    const rows = await tx.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM company WHERE uid = ${companyUid}::uuid`;
    const id = rows[0]?.id;
    if (id === undefined || !ids.includes(id)) throw new NotFoundException(MSG.companyNotFound());
    return id;
  }

  private async one(tx: Tx, uid: string) {
    // Поля берём все, какие сравнивает журнал изменений: добирать их вторым
    // запросом уже после UPDATE значило бы сравнивать новое с новым.
    const rows = await tx.$queryRaw<
      {
        id: bigint;
        company_id: bigint;
        inn: string | null;
        version: number;
        name_ru: string;
        name_uz: string;
        partner_type: string;
        legal_address: string | null;
        actual_address: string | null;
        is_client: boolean;
        is_supplier: boolean;
        payment_delay_days: number;
        debt_limit: string;
        is_active: boolean;
        tags: string[];
      }[]
    >`SELECT id, company_id, inn, version, name_ru, name_uz, partner_type::text AS partner_type,
             legal_address, actual_address, is_client, is_supplier, payment_delay_days,
             debt_limit::text AS debt_limit, is_active, tags
        FROM partner WHERE uid = ${uid}::uuid`;
    const row = rows[0];
    if (!row) throw new NotFoundException(MSG.partnerNotFound());
    return row;
  }

  /**
   * Где клиент уже участвует. Одним запросом, а не шестью: это и ответ на
   * «почему нельзя удалить», и содержимое вкладок карточки.
   */
  private async usage(tx: Tx, id: bigint) {
    const rows = await tx.$queryRawUnsafe<Record<string, bigint>[]>(
      `SELECT (SELECT count(*) FROM deal WHERE partner_id = $1) AS deals,
              (SELECT count(*) FROM lead WHERE partner_id = $1) AS leads,
              (SELECT count(*) FROM sales_order WHERE partner_id = $1) AS orders,
              (SELECT count(*) FROM stock_move WHERE partner_id = $1) AS moves,
              (SELECT count(*) FROM finance_operation WHERE partner_id = $1) AS payments,
              (SELECT count(*) FROM batch WHERE supplier_id = $1) AS batches,
              (SELECT count(*) FROM document WHERE partner_id = $1) AS documents,
              (SELECT count(*) FROM partner_price WHERE partner_id = $1) AS prices,
              (SELECT count(*) FROM crm_task WHERE partner_id = $1) AS tasks,
              (SELECT count(*) FROM crm_activity WHERE partner_id = $1) AS activities,
              (SELECT count(*) FROM attachment WHERE partner_id = $1) AS files`,
      id,
    );
    const r = rows[0]!;
    const used = {
      deals: Number(r.deals),
      leads: Number(r.leads),
      orders: Number(r.orders),
      moves: Number(r.moves),
      payments: Number(r.payments),
      batches: Number(r.batches),
      documents: Number(r.documents),
      prices: Number(r.prices),
      tasks: Number(r.tasks),
      activities: Number(r.activities),
      files: Number(r.files),
    };
    return { ...used, total: Object.values(used).reduce((a, b) => a + b, 0) };
  }

  // --- чтение ---------------------------------------------------------------

  async list(params: {
    search?: string;
    managerUid?: string;
    sourceUid?: string;
    role?: string;
    all?: boolean;
    limit?: number;
    offset?: number;
  }) {
    const search = params.search?.trim() ?? '';
    const limit = params.limit ?? 50;
    const offset = params.offset ?? 0;
    const role = params.role ?? 'any';

    return this.prisma.withTenant(async (tx) => {
      const where =
        `WHERE ($1::boolean OR p.is_active)
           AND ($2::text = '' OR p.name_ru ILIKE '%' || $2::text || '%'
                OR p.name_uz ILIKE '%' || $2::text || '%'
                OR p.inn ILIKE '%' || $2::text || '%'
                OR EXISTS (SELECT 1 FROM partner_contact c
                            WHERE c.partner_id = p.id
                              AND (c.full_name ILIKE '%' || $2::text || '%'
                                   OR c.phone ILIKE '%' || $2::text || '%')))
           AND ($3::uuid IS NULL OR m.uid = $3::uuid)
           AND ($4::uuid IS NULL OR s.uid = $4::uuid)
           AND ($5::text = 'any'
                OR ($5::text = 'client' AND p.is_client)
                OR ($5::text = 'supplier' AND p.is_supplier))`;

      const args = [
        params.all ?? false,
        search,
        params.managerUid ?? null,
        params.sourceUid ?? null,
        role,
      ];

      const rows = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT p.uid, p.partner_type::text AS partner_type, p.name_ru, p.name_uz, p.inn,
                p.is_client, p.is_supplier, p.payment_delay_days, p.debt_limit,
                p.is_active, p.version, p.tags, p.created_at,
                co.uid AS company_uid, co.code AS company_code,
                co.name_ru AS company_name_ru, co.name_uz AS company_name_uz,
                m.uid AS manager_uid, m.full_name AS manager_name,
                s.uid AS source_uid, app_loc(s.name_ru, s.name_uz) AS source_name,
                pt.uid AS price_type_uid, app_loc(pt.name_ru, pt.name_uz) AS price_type_name,
                (SELECT count(*) FROM partner_contact c WHERE c.partner_id = p.id) AS contacts_count,
                (SELECT c.phone FROM partner_contact c
                  WHERE c.partner_id = p.id
                  ORDER BY c.is_primary DESC, c.id LIMIT 1) AS phone
           FROM partner p
           JOIN company co ON co.id = p.company_id
           LEFT JOIN user_account m ON m.id = p.manager_id
           LEFT JOIN lead_source s ON s.id = p.source_id
           LEFT JOIN price_type pt ON pt.id = p.price_type_id
           ${where}
          ORDER BY p.is_active DESC, p.name_ru
          LIMIT $6 OFFSET $7`,
        ...args,
        limit,
        offset,
      );

      const totalRows = await tx.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n
           FROM partner p
           LEFT JOIN user_account m ON m.id = p.manager_id
           LEFT JOIN lead_source s ON s.id = p.source_id
           ${where}`,
        ...args,
      );

      return {
        rows: rows.map(partnerRow),
        total: Number(totalRows[0]?.n ?? 0),
        limit,
        offset,
      };
    });
  }

  async card(uid: string) {
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT p.id, p.uid, p.partner_type::text AS partner_type, p.name_ru, p.name_uz, p.inn,
                p.bank_details, p.legal_address, p.actual_address,
                p.is_client, p.is_supplier, p.payment_delay_days, p.debt_limit,
                p.is_active, p.version, p.tags, p.created_at,
                co.uid AS company_uid, co.code AS company_code,
                co.name_ru AS company_name_ru, co.name_uz AS company_name_uz,
                m.uid AS manager_uid, m.full_name AS manager_name,
                s.uid AS source_uid, app_loc(s.name_ru, s.name_uz) AS source_name,
                pt.uid AS price_type_uid, app_loc(pt.name_ru, pt.name_uz) AS price_type_name,
                COALESCE(
                  (SELECT json_agg(json_build_object(
                            'uid', c.uid, 'fullName', c.full_name, 'position', c.position,
                            'phone', c.phone, 'email', c.email, 'telegram', c.telegram,
                            'isPrimary', c.is_primary)
                          ORDER BY c.is_primary DESC, c.full_name)
                     FROM partner_contact c WHERE c.partner_id = p.id),
                  '[]'::json) AS contacts
           FROM partner p
           JOIN company co ON co.id = p.company_id
           LEFT JOIN user_account m ON m.id = p.manager_id
           LEFT JOIN lead_source s ON s.id = p.source_id
           LEFT JOIN price_type pt ON pt.id = p.price_type_id
          WHERE p.uid = $1::uuid`,
        uid,
      );
      const r = rows[0];
      if (!r) throw new NotFoundException(MSG.partnerNotFound());

      const used = await this.usage(tx, r.id as bigint);
      return {
        ...partnerRow(r),
        bankDetails: r.bank_details ?? null,
        legalAddress: r.legal_address ?? null,
        actualAddress: r.actual_address ?? null,
        contacts: r.contacts,
        usage: used,
        /** Кнопки строятся по этому полю, а не по матрице прав на клиенте. */
        permissions: { canEdit: true, canDelete: used.total === 0 },
      };
    });
  }

  // --- запись ---------------------------------------------------------------

  /*
   * Карточка во всех действиях записи читается **после** транзакции, а не в
   * ней. `card` открывает свою транзакцию, а незафиксированную запись соседняя
   * транзакция не видит — вложенное чтение отвечало бы «клиент не найден» на
   * только что заведённого клиента.
   */
  async create(input: PartnerInput) {
    const uid = await this.prisma.withTenant(async (tx) => {
      const companyId = await this.resolveCompany(tx, input.companyUid);
      const inn = input.inn?.trim() || null;

      if (inn) {
        const dup = await tx.$queryRawUnsafe<{ name_ru: string }[]>(
          `SELECT name_ru FROM partner WHERE company_id = $1 AND inn = $2`,
          companyId,
          inn,
        );
        if (dup[0]) {
          throw new ConflictException(say(`Клиент с ИНН ${inn} уже есть: «${dup[0].name_ru}»`, `${inn} STIR raqamli mijoz allaqachon bor: «${dup[0].name_ru}»`));
        }
      }

      const managerId = await this.userIdByUid(tx, input.managerUid);
      const sourceId = await this.refIdByUid(tx, 'lead_source', input.sourceUid);
      const priceTypeId = await this.refIdByUid(tx, 'price_type', input.priceTypeUid);

      const rows = await tx.$queryRawUnsafe<{ uid: string }[]>(
        // uid генерирует база: у таблицы нет умолчания, а сырой INSERT мимо
        // клиента Prisma остался бы без значения.
        `INSERT INTO partner (uid, company_id, partner_type, name_ru, name_uz, inn,
                              bank_details, legal_address, actual_address,
                              is_client, is_supplier, manager_id, source_id, price_type_id,
                              payment_delay_days, debt_limit, tags)
         VALUES (gen_random_uuid(), $1, $2::"PartnerType", $3, $4, $5, $6::jsonb, $7, $8,
                 $9, $10, $11, $12, $13, $14, $15, $16::text[])
         RETURNING uid`,
        companyId,
        input.partnerType ?? 'company',
        input.nameRu.trim(),
        (input.nameUz ?? input.nameRu).trim(),
        inn,
        input.bankDetails ? JSON.stringify(input.bankDetails) : null,
        input.legalAddress?.trim() ?? null,
        input.actualAddress?.trim() ?? null,
        input.isClient ?? true,
        input.isSupplier ?? false,
        managerId,
        sourceId,
        priceTypeId,
        input.paymentDelayDays ?? 0,
        input.debtLimit ?? 0,
        normalizeTags(input.tags),
      );
      const created = rows[0]!.uid;
      await writeAudit(tx, {
        companyId,
        entityType: 'partner',
        entityId: created,
        action: 'create',
        changes: { nameRu: { from: null, to: input.nameRu.trim() }, inn: { from: null, to: inn } },
      });
      return created;
    });
    return this.card(uid);
  }

  async update(uid: string, input: PartnerPatch) {
    await this.prisma.withTenant(async (tx) => {
      const partner = await this.one(tx, uid);
      this.checkVersion(partner.version, input.version);
      const used = await this.usage(tx, partner.id);

      let inn = partner.inn;
      if (input.inn !== undefined) {
        const next = input.inn?.trim() || null;
        if (next !== partner.inn) {
          // Отгрузки и платежи несут реквизиты на бумаге. Сменить ИНН у такого
          // клиента значит переписать задним числом, кому они ушли.
          const printed = used.moves + used.payments + used.documents;
          if (printed > 0) {
            throw new UnprocessableEntityException(say(
              `ИНН не сменить: по клиенту уже есть записей с реквизитами — ${printed}. ` +
                'Заведите нового контрагента, а этого выключите', `STIR o‘zgartirilmaydi: mijoz bo‘yicha rekvizitli yozuvlar bor — ${printed}. ` + 'Yangi kontragent kiriting, bunisini o‘chirib qo‘ying'));
          }
          if (next) {
            const dup = await tx.$queryRawUnsafe<{ name_ru: string }[]>(
              `SELECT name_ru FROM partner WHERE company_id = $1 AND inn = $2 AND id <> $3`,
              partner.company_id,
              next,
              partner.id,
            );
            if (dup[0]) {
              throw new ConflictException(say(`Клиент с ИНН ${next} уже есть: «${dup[0].name_ru}»`, `${next} STIR raqamli mijoz allaqachon bor: «${dup[0].name_ru}»`));
            }
          }
          inn = next;
        }
      }

      const managerId =
        input.managerUid === undefined ? undefined : await this.userIdByUid(tx, input.managerUid);
      const sourceId =
        input.sourceUid === undefined
          ? undefined
          : await this.refIdByUid(tx, 'lead_source', input.sourceUid);
      const priceTypeId =
        input.priceTypeUid === undefined
          ? undefined
          : await this.refIdByUid(tx, 'price_type', input.priceTypeUid);

      await tx.$queryRawUnsafe(
        `UPDATE partner SET
           partner_type = COALESCE($2::"PartnerType", partner_type),
           name_ru = COALESCE($3, name_ru),
           name_uz = COALESCE($4, name_uz),
           inn = $5,
           bank_details = COALESCE($6::jsonb, bank_details),
           legal_address = COALESCE($7, legal_address),
           actual_address = COALESCE($8, actual_address),
           is_client = COALESCE($9, is_client),
           is_supplier = COALESCE($10, is_supplier),
           manager_id = CASE WHEN $11::boolean THEN $12 ELSE manager_id END,
           source_id = CASE WHEN $13::boolean THEN $14 ELSE source_id END,
           price_type_id = CASE WHEN $15::boolean THEN $16 ELSE price_type_id END,
           payment_delay_days = COALESCE($17, payment_delay_days),
           debt_limit = COALESCE($18, debt_limit),
           tags = COALESCE($19::text[], tags),
           is_active = COALESCE($20, is_active),
           archived_at = CASE WHEN $20::boolean IS FALSE THEN now()
                              WHEN $20::boolean IS TRUE THEN NULL
                              ELSE archived_at END,
           version = version + 1
         WHERE id = $1`,
        partner.id,
        input.partnerType ?? null,
        input.nameRu?.trim() ?? null,
        input.nameUz?.trim() ?? null,
        inn,
        input.bankDetails ? JSON.stringify(input.bankDetails) : null,
        input.legalAddress?.trim() ?? null,
        input.actualAddress?.trim() ?? null,
        input.isClient ?? null,
        input.isSupplier ?? null,
        input.managerUid !== undefined,
        managerId ?? null,
        input.sourceUid !== undefined,
        sourceId ?? null,
        input.priceTypeUid !== undefined,
        priceTypeId ?? null,
        input.paymentDelayDays ?? null,
        input.debtLimit ?? null,
        input.tags === undefined ? null : normalizeTags(input.tags),
        input.isActive ?? null,
      );

      // Пишем то, что действительно поменялось, а не всё тело запроса: PATCH
      // приходит с полями, равными прежним, и без сравнения журнал наполнялся
      // бы строками «наименование: было А, стало А».
      const changes = diff(
        {
          partnerType: partner.partner_type,
          nameRu: partner.name_ru,
          nameUz: partner.name_uz,
          inn: partner.inn,
          legalAddress: partner.legal_address,
          actualAddress: partner.actual_address,
          isClient: partner.is_client,
          isSupplier: partner.is_supplier,
          paymentDelayDays: partner.payment_delay_days,
          debtLimit: partner.debt_limit,
          isActive: partner.is_active,
          tags: (partner.tags ?? []).join(', '),
        },
        {
          partnerType: input.partnerType,
          nameRu: input.nameRu?.trim(),
          nameUz: input.nameUz?.trim(),
          inn,
          legalAddress: input.legalAddress?.trim(),
          actualAddress: input.actualAddress?.trim(),
          isClient: input.isClient,
          isSupplier: input.isSupplier,
          paymentDelayDays: input.paymentDelayDays,
          debtLimit: input.debtLimit,
          isActive: input.isActive,
          tags: input.tags === undefined ? undefined : normalizeTags(input.tags).join(', '),
        },
      );
      if (Object.keys(changes).length > 0) {
        await writeAudit(tx, {
          companyId: partner.company_id,
          entityType: 'partner',
          entityId: uid,
          action: input.isActive === false ? 'archive' : input.isActive === true ? 'restore' : 'update',
          changes,
        });
      }
    });
    return this.card(uid);
  }

  async remove(uid: string) {
    return this.prisma.withTenant(async (tx) => {
      const partner = await this.one(tx, uid);
      const used = await this.usage(tx, partner.id);
      if (used.total > 0) {
        throw new ConflictException({
          message: say(`Клиент «${partner.name_ru}» участвует в записях — ${used.total}. ` +
            'Его выключают, а не удаляют: иначе история останется без имени', `«${partner.name_ru}» mijozi yozuvlarda qatnashadi — ${used.total}. ` + 'Uni o‘chirib qo‘yadi, o‘chirib tashlamaydi: aks holda tarix nomsiz qoladi'),
          details: used,
        });
      }
      await tx.$queryRawUnsafe(`DELETE FROM partner WHERE id = $1`, partner.id);
      return { deleted: true };
    });
  }

  // --- контактные лица ------------------------------------------------------

  async addContact(partnerUid: string, input: ContactInput) {
    await this.prisma.withTenant(async (tx) => {
      const partner = await this.one(tx, partnerUid);
      if (input.isPrimary) await this.dropPrimary(tx, partner.id);
      await tx.$queryRawUnsafe(
        `INSERT INTO partner_contact (uid, partner_id, full_name, position, phone, email,
                                      telegram, is_primary)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7)`,
        partner.id,
        input.fullName.trim(),
        input.position?.trim() ?? null,
        input.phone?.trim() ?? null,
        input.email?.trim() ?? null,
        input.telegram?.trim() ?? null,
        input.isPrimary ?? false,
      );
      await writeAudit(tx, {
        companyId: partner.company_id,
        entityType: 'partner',
        entityId: partnerUid,
        action: 'contact.add',
        changes: { contact: { from: null, to: input.fullName.trim() } },
      });
    });
    return this.card(partnerUid);
  }

  async updateContact(uid: string, input: ContactPatch) {
    const partnerUid = await this.prisma.withTenant(async (tx) => {
      const rows = await tx.$queryRaw<
        {
          id: bigint;
          partner_id: bigint;
          partner_uid: string;
          company_id: bigint;
          full_name: string;
          position: string | null;
          phone: string | null;
          email: string | null;
          telegram: string | null;
          is_primary: boolean;
        }[]
      >`
        SELECT c.id, c.partner_id, p.uid AS partner_uid, p.company_id,
               c.full_name, c.position, c.phone, c.email, c.telegram, c.is_primary
          FROM partner_contact c JOIN partner p ON p.id = c.partner_id
         WHERE c.uid = ${uid}::uuid`;
      const row = rows[0];
      if (!row) throw new NotFoundException(say('Контактное лицо не найдено', 'Aloqa shaxsi topilmadi'));

      if (input.isPrimary) await this.dropPrimary(tx, row.partner_id);
      await tx.$queryRawUnsafe(
        `UPDATE partner_contact SET
           full_name = COALESCE($2, full_name),
           position = COALESCE($3, position),
           phone = COALESCE($4, phone),
           email = COALESCE($5, email),
           telegram = COALESCE($6, telegram),
           is_primary = COALESCE($7, is_primary)
         WHERE id = $1`,
        row.id,
        input.fullName?.trim() ?? null,
        input.position?.trim() ?? null,
        input.phone?.trim() ?? null,
        input.email?.trim() ?? null,
        input.telegram?.trim() ?? null,
        input.isPrimary ?? null,
      );
      const changes = diff(
        {
          fullName: row.full_name,
          position: row.position,
          phone: row.phone,
          email: row.email,
          telegram: row.telegram,
          isPrimary: row.is_primary,
        },
        {
          fullName: input.fullName?.trim(),
          position: input.position?.trim(),
          phone: input.phone?.trim(),
          email: input.email?.trim(),
          telegram: input.telegram?.trim(),
          isPrimary: input.isPrimary,
        },
      );
      if (Object.keys(changes).length > 0) {
        await writeAudit(tx, {
          companyId: row.company_id,
          entityType: 'partner',
          entityId: row.partner_uid,
          action: 'contact.update',
          changes: { contact: { from: row.full_name, to: row.full_name }, ...changes },
        });
      }
      return row.partner_uid;
    });
    return this.card(partnerUid);
  }

  async removeContact(uid: string) {
    const partnerUid = await this.prisma.withTenant(async (tx) => {
      const rows = await tx.$queryRaw<
        { id: bigint; partner_uid: string; company_id: bigint; full_name: string }[]
      >`
        SELECT c.id, p.uid AS partner_uid, p.company_id, c.full_name
          FROM partner_contact c JOIN partner p ON p.id = c.partner_id
         WHERE c.uid = ${uid}::uuid`;
      const row = rows[0];
      if (!row) throw new NotFoundException(say('Контактное лицо не найдено', 'Aloqa shaxsi topilmadi'));
      // Контакт — не история: это телефон живого человека, который уволился.
      // Его удаляют, и ни одна прошлая запись от этого не теряет смысла.
      await tx.$queryRawUnsafe(`DELETE FROM partner_contact WHERE id = $1`, row.id);
      await writeAudit(tx, {
        companyId: row.company_id,
        entityType: 'partner',
        entityId: row.partner_uid,
        action: 'contact.remove',
        changes: { contact: { from: row.full_name, to: null } },
      });
      return row.partner_uid;
    });
    return this.card(partnerUid);
  }

  /** Главный контакт ровно один: иначе «позвонить клиенту» становится выбором. */
  private async dropPrimary(tx: Tx, partnerId: bigint) {
    await tx.$queryRawUnsafe(
      `UPDATE partner_contact SET is_primary = false WHERE partner_id = $1 AND is_primary`,
      partnerId,
    );
  }

  private checkVersion(current: number, sent: number | undefined) {
    if (sent === undefined) {
      throw new UnprocessableEntityException(say(
        'Не указана версия записи: правка без неё затёрла бы чужое сохранение', 'Yozuv versiyasi ko‘rsatilmagan: usiz tahrir boshqaning saqlaganini o‘chirib yuborardi'));
    }
    if (sent !== current) {
      throw new ConflictException({
        message: say('Карточку уже изменили: перезагрузите её и повторите правку', 'Karta allaqachon o‘zgargan: uni qayta yuklab, tahrirni takrorlang'),
        details: { version: current },
      });
    }
  }

  private async userIdByUid(tx: Tx, uid: string | null | undefined): Promise<bigint | null> {
    if (!uid) return null;
    const rows = await tx.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM user_account WHERE uid = ${uid}::uuid`;
    if (!rows[0]) throw new NotFoundException(MSG.managerNotFound());
    return rows[0].id;
  }

  private async refIdByUid(
    tx: Tx,
    table: 'lead_source' | 'price_type',
    uid: string | null | undefined,
  ): Promise<bigint | null> {
    if (!uid) return null;
    const rows = await tx.$queryRawUnsafe<{ id: bigint; is_active: boolean }[]>(
      `SELECT id, ${table === 'lead_source' ? 'is_active' : 'true AS is_active'} FROM ${table}
        WHERE uid = $1::uuid`,
      uid,
    );
    if (!rows[0]) {
      throw new NotFoundException(say(
        table === 'lead_source' ? 'Источник не найден' : 'Тип цены не найден', table === 'lead_source' ? 'Manba topilmadi' : 'Narx turi topilmadi'));
    }
    // Выключенный источник остаётся у тех, кто по нему уже пришёл, но новую
    // карточку им не помечают: иначе выключение ничего не значит.
    if (!rows[0].is_active) {
      throw new UnprocessableEntityException(say('Источник выключен: выберите действующий', 'Manba o‘chirilgan: amaldagisini tanlang'));
    }
    return rows[0].id;
  }

  /** Справочники для формы карточки: менеджеры, источники, типы цен. */
  async options() {
    return this.prisma.withTenant(async (tx) => {
      const managers = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT DISTINCT u.uid, u.full_name
           FROM user_account u
           JOIN user_role_assignment a ON a.user_id = u.id
          WHERE u.is_active AND a.company_id = ANY (app.current_company_ids())
          ORDER BY u.full_name`,
      );
      const sources = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT uid, code, name_ru, name_uz, channel::text AS channel
           FROM lead_source WHERE is_active ORDER BY name_ru`,
      );
      const priceTypes = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT uid, code, name_ru FROM price_type ORDER BY name_ru`,
      );
      // Компании, в которых человек вправе завести клиента. Их может быть две,
      // и тогда сервер отказывается угадывать, в чьей базе заводить.
      const companies = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT uid, code, name_ru, name_uz
           FROM company WHERE id = ANY (app.current_company_ids()) ORDER BY name_ru`,
      );
      return {
        managers: managers.map((m) => ({ uid: m.uid, name: m.full_name })),
        companies: companies.map((c) => ({
          uid: c.uid,
          code: c.code,
          nameRu: c.name_ru,
          nameUz: c.name_uz,
        })),
        sources: sources.map((s) => ({
          uid: s.uid,
          code: s.code,
          nameRu: s.name_ru,
          nameUz: s.name_uz,
          channel: s.channel,
        })),
        priceTypes: priceTypes.map((p) => ({ uid: p.uid, code: p.code, name: p.name_ru })),
      };
    });
  }
}

/** Тег — метка для поиска: без пустых, без дублей, в нижнем регистре. */
const normalizeTags = (tags: string[] | undefined): string[] => {
  if (!tags) return [];
  const seen = new Set<string>();
  for (const t of tags) {
    const v = t.trim().toLowerCase();
    if (v) seen.add(v);
  }
  return [...seen];
};

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

const partnerRow = (r: Record<string, any>) => ({
  uid: r.uid,
  partnerType: r.partner_type,
  nameRu: r.name_ru,
  nameUz: r.name_uz,
  inn: r.inn,
  isClient: r.is_client,
  isSupplier: r.is_supplier,
  company: {
    uid: r.company_uid,
    code: r.company_code,
    // Название компании отдаёт база, а не вёрстка: «Завод» и «Торговый дом»
    // были вписаны в экран и существовали только по-русски.
    nameRu: r.company_name_ru,
    nameUz: r.company_name_uz,
  },
  manager: r.manager_uid ? { uid: r.manager_uid, name: r.manager_name } : null,
  source: r.source_uid ? { uid: r.source_uid, name: r.source_name } : null,
  priceType: r.price_type_uid ? { uid: r.price_type_uid, name: r.price_type_name } : null,
  paymentDelayDays: Number(r.payment_delay_days ?? 0),
  debtLimit: String(r.debt_limit ?? '0'),
  tags: (r.tags ?? []) as string[],
  isActive: r.is_active,
  version: Number(r.version),
  contactsCount: r.contacts_count === undefined ? undefined : Number(r.contacts_count),
  phone: r.phone ?? null,
  createdAt: r.created_at,
});

export type PartnerInput = {
  companyUid?: string;
  partnerType?: string;
  nameRu: string;
  nameUz?: string;
  inn?: string;
  bankDetails?: Record<string, unknown>;
  legalAddress?: string;
  actualAddress?: string;
  isClient?: boolean;
  isSupplier?: boolean;
  managerUid?: string;
  sourceUid?: string;
  priceTypeUid?: string;
  paymentDelayDays?: number;
  debtLimit?: number;
  tags?: string[];
};

export type PartnerPatch = Partial<PartnerInput> & {
  version?: number;
  isActive?: boolean;
  managerUid?: string | null;
  sourceUid?: string | null;
  priceTypeUid?: string | null;
};

export type ContactInput = {
  fullName: string;
  position?: string;
  phone?: string;
  email?: string;
  telegram?: string;
  isPrimary?: boolean;
};

export type ContactPatch = Partial<ContactInput>;
