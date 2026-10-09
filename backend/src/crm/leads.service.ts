import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { writeAudit } from '../common/audit.js';
import { currentContext } from '../common/request-context.js';
import { MSG } from '../common/messages.js';
import { say } from '../common/say.js';

/**
 * Лиды: приём обращения и превращение его в клиента (ТЗ 8.1, 8.3).
 *
 * Лид — это ещё не клиент. Позвонили, спросили цену, назвали имя и телефон —
 * записи в базе контрагентов такому взяться неоткуда: у него нет ни ИНН, ни
 * реквизитов, и половина таких звонков ничем не кончается. Заводить их
 * клиентами значит засорить базу, по которой потом выставляют счета.
 *
 * Поэтому у лида своя таблица и свой конец жизни:
 *
 * - **Источник обязателен.** Без него отчёт по источникам (ТЗ 8.1) пуст, а
 *   ради него лиды и считают: рекламу оплачивают по этому числу.
 * - **Превращение необратимо и одноразово.** Лид, ставший клиентом, держит
 *   ссылку на него. Повторное нажатие возвращает того же клиента, а не заводит
 *   второго: менеджер жмёт дважды, когда ответ пришёл не сразу.
 * - **Отказ требует причины, и причина своя.** Комментарий заявки для этого не
 *   годится: в нём записано, что человек спрашивал, а не почему он ушёл. Одно
 *   поле на два смысла означало бы, что отчёт по причинам отказов считает
 *   пересказ разговора. То же правило, что у проигранной сделки.
 */
@Injectable()
export class LeadsService {
  constructor(private readonly prisma: PrismaService) {}

  private async resolveCompany(tx: Tx, companyUid: string | undefined): Promise<bigint> {
    const ids = currentContext()?.companyIds ?? [];
    if (ids.length === 0) throw new UnprocessableEntityException(MSG.noCompany());
    if (!companyUid) {
      if (ids.length > 1) {
        throw new UnprocessableEntityException(say(
          'Выбраны обе компании: укажите, в чью базу принимаем обращение', 'Ikkala kompaniya tanlangan: murojaat kimning bazasiga qabul qilinishini ko‘rsating'));
      }
      return ids[0]!;
    }
    const rows = await tx.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM company WHERE uid = ${companyUid}::uuid`;
    const id = rows[0]?.id;
    if (id === undefined || !ids.includes(id)) throw new NotFoundException(MSG.companyNotFound());
    return id;
  }

  async list(params: {
    search?: string;
    status?: string;
    sourceUid?: string;
    managerUid?: string;
    limit?: number;
    offset?: number;
  }) {
    const search = params.search?.trim() ?? '';
    const limit = params.limit ?? 50;
    const offset = params.offset ?? 0;

    return this.prisma.withTenant(async (tx) => {
      const where = `WHERE ($1::text = '' OR l.name ILIKE '%' || $1::text || '%'
                            OR l.phone ILIKE '%' || $1::text || '%'
                            OR l.email ILIKE '%' || $1::text || '%')
                       AND ($2::text = '' OR l.status::text = $2::text)
                       AND ($3::uuid IS NULL OR s.uid = $3::uuid)
                       AND ($4::uuid IS NULL OR m.uid = $4::uuid)`;
      const args = [search, params.status ?? '', params.sourceUid ?? null, params.managerUid ?? null];

      const rows = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT l.uid, l.name, l.phone, l.email, l.comment, l.status::text AS status,
                l.reject_reason, l.created_at,
                co.uid AS company_uid, co.code AS company_code,
                s.uid AS source_uid, app_loc(s.name_ru, s.name_uz) AS source_name, s.channel::text AS channel,
                m.uid AS manager_uid, m.full_name AS manager_name,
                p.uid AS partner_uid, app_loc(p.name_ru, p.name_uz) AS partner_name,
                l.utm_source, l.utm_medium, l.utm_campaign, l.utm_content, l.utm_term,
                l.click_id, l.analytics_id, l.form_code, l.landing_url, l.referrer,
                l.visitor_id, l.first_at, l.first_source, l.first_medium, l.first_campaign,
                l.first_landing_url, l.first_referrer, app_loc(fs.name_ru, fs.name_uz) AS first_source_name
           FROM lead l
           JOIN company co ON co.id = l.company_id
           LEFT JOIN lead_source s ON s.id = l.source_id
           LEFT JOIN lead_source fs ON fs.id = l.first_source_id
           LEFT JOIN user_account m ON m.id = l.manager_id
           LEFT JOIN partner p ON p.id = l.partner_id
           ${where}
          ORDER BY l.created_at DESC
          LIMIT $5 OFFSET $6`,
        ...args,
        limit,
        offset,
      );

      const totals = await tx.$queryRawUnsafe<{ status: string; n: bigint }[]>(
        `SELECT l.status::text AS status, count(*) AS n
           FROM lead l
           LEFT JOIN lead_source s ON s.id = l.source_id
           LEFT JOIN user_account m ON m.id = l.manager_id
           ${where}
          GROUP BY l.status`,
        ...args,
      );

      const byStatus: Record<string, number> = {};
      let total = 0;
      for (const t of totals) {
        byStatus[t.status] = Number(t.n);
        total += Number(t.n);
      }

      return { rows: rows.map(leadView), total, byStatus, limit, offset };
    });
  }

  async one(uid: string) {
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT l.uid, l.name, l.phone, l.email, l.comment, l.status::text AS status,
                l.reject_reason, l.created_at,
                co.uid AS company_uid, co.code AS company_code,
                s.uid AS source_uid, app_loc(s.name_ru, s.name_uz) AS source_name, s.channel::text AS channel,
                m.uid AS manager_uid, m.full_name AS manager_name,
                p.uid AS partner_uid, app_loc(p.name_ru, p.name_uz) AS partner_name,
                l.utm_source, l.utm_medium, l.utm_campaign, l.utm_content, l.utm_term,
                l.click_id, l.analytics_id, l.form_code, l.landing_url, l.referrer,
                l.visitor_id, l.first_at, l.first_source, l.first_medium, l.first_campaign,
                l.first_landing_url, l.first_referrer, app_loc(fs.name_ru, fs.name_uz) AS first_source_name
           FROM lead l
           JOIN company co ON co.id = l.company_id
           LEFT JOIN lead_source s ON s.id = l.source_id
           LEFT JOIN lead_source fs ON fs.id = l.first_source_id
           LEFT JOIN user_account m ON m.id = l.manager_id
           LEFT JOIN partner p ON p.id = l.partner_id
          WHERE l.uid = $1::uuid`,
        uid,
      );
      if (!rows[0]) throw new NotFoundException(MSG.leadNotFound());
      return leadView(rows[0]);
    });
  }

  async create(input: LeadInput) {
    const uid = await this.prisma.withTenant(async (tx) => {
      const companyId = await this.resolveCompany(tx, input.companyUid);
      const sourceId = await this.sourceId(tx, companyId, input.sourceUid);
      const managerId = await this.userId(tx, input.managerUid);

      const rows = await tx.$queryRawUnsafe<{ uid: string }[]>(
        `INSERT INTO lead (uid, company_id, source_id, name, phone, email, comment,
                           status, manager_id)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 'new'::"LeadStatus", $7)
         RETURNING uid`,
        companyId,
        sourceId,
        input.name.trim(),
        input.phone?.trim() ?? null,
        input.email?.trim() ?? null,
        input.comment?.trim() ?? null,
        managerId,
      );
      return rows[0]!.uid;
    });
    return this.one(uid);
  }

  async update(uid: string, input: LeadPatch) {
    await this.prisma.withTenant(async (tx) => {
      const lead = await this.lead(tx, uid);

      if (lead.status === 'converted') {
        throw new UnprocessableEntityException(say(
          'Обращение уже стало клиентом: правьте карточку клиента, а не заявку', 'Murojaat allaqachon mijozga aylangan: arizani emas, mijoz kartasini tahrirlang'));
      }
      if (input.status === 'converted') {
        throw new UnprocessableEntityException(say(
          'В «клиента» обращение переводит только превращение: оно и заводит карточку', 'Murojaatni «mijoz» holatiga faqat aylantirish o‘tkazadi: kartani ham u kiritadi'));
      }
      if (input.status === 'rejected' && !(input.rejectReason ?? lead.reject_reason)?.trim()) {
        throw new UnprocessableEntityException(say(
          'Укажите причину отказа: без неё отчёт по причинам отказов не наполняется', 'Rad etish sababini ko‘rsating: usiz rad etish sabablari hisoboti to‘lmaydi'));
      }

      const sourceId =
        input.sourceUid === undefined
          ? undefined
          : await this.sourceId(tx, lead.company_id, input.sourceUid);
      const managerId =
        input.managerUid === undefined ? undefined : await this.userId(tx, input.managerUid);

      await tx.$queryRawUnsafe(
        `UPDATE lead SET
           name = COALESCE($2, name),
           phone = COALESCE($3, phone),
           email = COALESCE($4, email),
           comment = COALESCE($5, comment),
           status = COALESCE($6::"LeadStatus", status),
           source_id = COALESCE($7, source_id),
           manager_id = CASE WHEN $8::boolean THEN $9 ELSE manager_id END,
           reject_reason = COALESCE($10, reject_reason)
         WHERE id = $1`,
        lead.id,
        input.name?.trim() ?? null,
        input.phone?.trim() ?? null,
        input.email?.trim() ?? null,
        input.comment?.trim() ?? null,
        input.status ?? null,
        sourceId ?? null,
        input.managerUid !== undefined,
        managerId ?? null,
        input.rejectReason?.trim() ?? null,
      );
    });
    return this.one(uid);
  }

  /**
   * Превращение обращения в клиента, при желании сразу со сделкой.
   *
   * Всё одной транзакцией: клиент, контактное лицо, отметка на обращении и
   * сделка. Оборвись это посередине — остался бы клиент без телефона и
   * обращение, которое выглядит новым, хотя карточка уже заведена.
   */
  async convert(uid: string, input: ConvertInput) {
    const result = await this.prisma.withTenant(async (tx) => {
      const lead = await this.lead(tx, uid);

      if (lead.status === 'converted' && lead.partner_id) {
        // Повторное нажатие возвращает того же клиента: менеджер жмёт второй
        // раз, когда ответ пришёл не сразу, а второй карточки быть не должно.
        const existing = await tx.$queryRawUnsafe<{ uid: string }[]>(
          `SELECT uid FROM partner WHERE id = $1`,
          lead.partner_id,
        );
        return { partnerUid: existing[0]!.uid, dealUid: null, alreadyConverted: true };
      }
      if (lead.status === 'rejected') {
        throw new UnprocessableEntityException(say(
          'Обращение отклонено: верните его в работу, прежде чем заводить клиента', 'Murojaat rad etilgan: mijoz kiritishdan oldin uni ishga qaytaring'));
      }

      let partnerId: bigint;
      let partnerUid: string;

      if (input.partnerUid) {
        // Обращение от того, кто у нас уже есть: второй карточки не заводим.
        const rows = await tx.$queryRawUnsafe<{ id: bigint; uid: string; company_id: bigint }[]>(
          `SELECT id, uid, company_id FROM partner WHERE uid = $1::uuid`,
          input.partnerUid,
        );
        const found = rows[0];
        if (!found) throw new NotFoundException(MSG.partnerNotFound());
        if (found.company_id !== lead.company_id) {
          throw new UnprocessableEntityException(say(
            'Клиент заведён в другой компании: обращение и карточка должны быть в одной', 'Mijoz boshqa kompaniyada kiritilgan: murojaat va karta bitta kompaniyada bo‘lishi kerak'));
        }
        partnerId = found.id;
        partnerUid = found.uid;

        // Обращение, привязанное к заведённому клиенту, — событие его истории.
        // Иначе в карточке появляется сделка из обращения, которого там нет.
        await writeAudit(tx, {
          companyId: lead.company_id,
          entityType: 'partner',
          entityId: partnerUid,
          action: 'lead.link',
          changes: { fromLead: { from: null, to: lead.name.trim() } },
        });
      } else {
        const name = (input.nameRu ?? lead.name).trim();
        const inn = input.inn?.trim() || null;
        if (inn) {
          const dup = await tx.$queryRawUnsafe<{ uid: string; name_ru: string }[]>(
            `SELECT uid, name_ru FROM partner WHERE company_id = $1 AND inn = $2`,
            lead.company_id,
            inn,
          );
          if (dup[0]) {
            throw new UnprocessableEntityException(say(
              `Клиент с ИНН ${inn} уже есть: «${dup[0].name_ru}». ` +
                'Свяжите обращение с ним, а не заводите второго', `${inn} STIR raqamli mijoz allaqachon bor: «${dup[0].name_ru}». ` + 'Murojaatni ikkinchisini kiritmay, shu mijozga bog‘lang'));
          }
        }

        const created = await tx.$queryRawUnsafe<{ id: bigint; uid: string }[]>(
          `INSERT INTO partner (uid, company_id, partner_type, name_ru, name_uz, inn,
                                is_client, manager_id, source_id)
           VALUES (gen_random_uuid(), $1, $2::"PartnerType", $3, $3, $4, true, $5, $6)
           RETURNING id, uid`,
          lead.company_id,
          input.partnerType ?? 'company',
          name,
          inn,
          lead.manager_id,
          lead.source_id,
        );
        partnerId = created[0]!.id;
        partnerUid = created[0]!.uid;

        // История карточки начинается здесь. Через форму «Добавить клиента»
        // запись пишется, а через превращение обращения — не писалась вовсе,
        // и такой клиент появлялся в базе из ниоткуда. Журнал читают как
        // доказательство, и начало в нём обязано быть.
        await writeAudit(tx, {
          companyId: lead.company_id,
          entityType: 'partner',
          entityId: partnerUid,
          action: 'create',
          changes: {
            nameRu: { from: null, to: name },
            inn: { from: null, to: inn },
            fromLead: { from: null, to: lead.name.trim() },
          },
        });

        // Телефон и почта обращения не теряются: это единственный способ
        // связаться, и в карточке им место среди контактных лиц.
        if (lead.phone || lead.email) {
          await tx.$queryRawUnsafe(
            `INSERT INTO partner_contact (uid, partner_id, full_name, phone, email, is_primary)
             VALUES (gen_random_uuid(), $1, $2, $3, $4, true)`,
            partnerId,
            lead.name.trim(),
            lead.phone,
            lead.email,
          );
        }
      }

      let dealUid: string | null = null;
      if (input.withDeal) {
        dealUid = await this.createDeal(tx, {
          companyId: lead.company_id,
          partnerId,
          managerId: lead.manager_id,
          title: input.dealTitle?.trim() || `Обращение: ${lead.name.trim()}`,
          amount: input.dealAmount ?? 0,
        });
      }

      await tx.$queryRawUnsafe(
        `UPDATE lead SET status = 'converted'::"LeadStatus", partner_id = $2 WHERE id = $1`,
        lead.id,
        partnerId,
      );

      return { partnerUid, dealUid, alreadyConverted: false };
    });

    return { ...result, lead: await this.one(uid) };
  }

  /** Сделка первой стадии воронки: номер выдаётся под блокировкой компании. */
  private async createDeal(
    tx: Tx,
    input: { companyId: bigint; partnerId: bigint; managerId: bigint | null; title: string; amount: number },
  ): Promise<string> {
    const stage = await tx.$queryRawUnsafe<{ id: bigint; probability_default: number }[]>(
      `SELECT id, probability_default FROM deal_stage
        WHERE company_id = $1 AND NOT is_final AND is_active ORDER BY seq LIMIT 1`,
      input.companyId,
    );
    if (!stage[0]) {
      throw new UnprocessableEntityException(say('У компании не заведены стадии воронки', 'Kompaniyada varonka bosqichlari kiritilmagan'));
    }

    const currency = await tx.$queryRaw<{ id: bigint }[]>`SELECT id FROM currency WHERE code = 'UZS'`;
    if (!currency[0]) throw new UnprocessableEntityException(MSG.currencyNotFound('UZS'));

    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${input.companyId}:СД`}))`;
    const next = await tx.$queryRaw<{ next: number }[]>`
      SELECT coalesce(max(substring(number from '[0-9]+$')::int), 0) + 1 AS next
        FROM deal WHERE company_id = ${input.companyId} AND number LIKE 'СД-%'`;
    const number = `СД-${String(next[0]!.next).padStart(4, '0')}`;

    const rows = await tx.$queryRawUnsafe<{ uid: string }[]>(
      `INSERT INTO deal (uid, company_id, number, title, partner_id, manager_id, stage_id,
                         amount, currency_id, probability, status)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, 'open'::"DealStatus")
       RETURNING uid`,
      input.companyId,
      number,
      input.title,
      input.partnerId,
      input.managerId,
      stage[0].id,
      input.amount,
      currency[0].id,
      stage[0].probability_default,
    );
    // Сделка из обращения тоже оставляет след: иначе в конверсии воронки она
    // появилась бы из ниоткуда.
    await tx.$queryRawUnsafe(
      `INSERT INTO deal_stage_event (deal_id, from_stage_id, to_stage_id, user_id)
       SELECT id, NULL, stage_id, $2 FROM deal WHERE uid = $1::uuid`,
      rows[0]!.uid,
      currentContext()?.userId ?? null,
    );
    return rows[0]!.uid;
  }

  private async lead(tx: Tx, uid: string) {
    const rows = await tx.$queryRaw<
      {
        id: bigint;
        company_id: bigint;
        status: string;
        partner_id: bigint | null;
        manager_id: bigint | null;
        source_id: bigint | null;
        name: string;
        phone: string | null;
        email: string | null;
        comment: string | null;
        reject_reason: string | null;
      }[]
    >`SELECT id, company_id, status::text AS status, partner_id, manager_id, source_id,
             name, phone, email, comment, reject_reason
        FROM lead WHERE uid = ${uid}::uuid`;
    if (!rows[0]) throw new NotFoundException(MSG.leadNotFound());
    return rows[0];
  }

  private async sourceId(tx: Tx, companyId: bigint, uid: string): Promise<bigint> {
    const rows = await tx.$queryRawUnsafe<{ id: bigint; company_id: bigint; is_active: boolean }[]>(
      `SELECT id, company_id, is_active FROM lead_source WHERE uid = $1::uuid`,
      uid,
    );
    const row = rows[0];
    if (!row) throw new NotFoundException(say('Источник не найден', 'Manba topilmadi'));
    if (row.company_id !== companyId) {
      throw new UnprocessableEntityException(say('Источник заведён в другой компании', 'Manba boshqa kompaniyada kiritilgan'));
    }
    if (!row.is_active) {
      throw new UnprocessableEntityException(say('Источник выключен: выберите действующий', 'Manba o‘chirilgan: amaldagisini tanlang'));
    }
    return row.id;
  }

  private async userId(tx: Tx, uid: string | null | undefined): Promise<bigint | null> {
    if (!uid) return null;
    const rows = await tx.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM user_account WHERE uid = ${uid}::uuid`;
    if (!rows[0]) throw new NotFoundException(MSG.managerNotFound());
    return rows[0].id;
  }
}

const leadView = (r: Record<string, any>) => ({
  uid: r.uid,
  name: r.name,
  phone: r.phone,
  email: r.email,
  comment: r.comment,
  rejectReason: r.reject_reason,
  status: r.status as 'new' | 'qualified' | 'converted' | 'rejected',
  company: { uid: r.company_uid, code: r.company_code },
  source: r.source_uid ? { uid: r.source_uid, name: r.source_name, channel: r.channel } : null,
  manager: r.manager_uid ? { uid: r.manager_uid, name: r.manager_name } : null,
  partner: r.partner_uid ? { uid: r.partner_uid, name: r.partner_name } : null,
  createdAt: r.created_at,
  /**
   * Откуда пришёл. `last` — метки визита, в котором оставили заявку, `first` —
   * первого визита этого же посетителя. Для SEO важны оба: находят в поиске,
   * а заявку оставляют через неделю прямым заходом.
   */
  marks: {
    has: Boolean(
      r.utm_source || r.utm_medium || r.click_id || r.landing_url || r.referrer || r.first_at,
    ),
    last: {
      source: r.utm_source ?? null,
      medium: r.utm_medium ?? null,
      campaign: r.utm_campaign ?? null,
      content: r.utm_content ?? null,
      term: r.utm_term ?? null,
      clickId: r.click_id ?? null,
      landing: r.landing_url ?? null,
      referrer: r.referrer ?? null,
    },
    first: {
      at: r.first_at ?? null,
      source: r.first_source ?? null,
      medium: r.first_medium ?? null,
      campaign: r.first_campaign ?? null,
      landing: r.first_landing_url ?? null,
      referrer: r.first_referrer ?? null,
      sourceName: r.first_source_name ?? null,
    },
    analyticsId: r.analytics_id ?? null,
    visitorId: r.visitor_id ?? null,
    formCode: r.form_code ?? null,
  },
});

export type LeadInput = {
  companyUid?: string;
  sourceUid: string;
  name: string;
  phone?: string;
  email?: string;
  comment?: string;
  managerUid?: string;
};

export type LeadPatch = {
  name?: string;
  phone?: string;
  email?: string;
  comment?: string;
  rejectReason?: string;
  status?: 'new' | 'qualified' | 'rejected' | 'converted';
  sourceUid?: string;
  managerUid?: string | null;
};

export type ConvertInput = {
  partnerUid?: string;
  nameRu?: string;
  inn?: string;
  partnerType?: string;
  withDeal?: boolean;
  dealTitle?: string;
  dealAmount?: number;
};
