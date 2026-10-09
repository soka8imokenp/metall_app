import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { currentContext } from '../common/request-context.js';
import { NumberingService } from './numbering.service.js';
import { amountInWords } from './amount-words.js';
import { MSG } from '../common/messages.js';
import { say } from '../common/say.js';

/**
 * Создание документа из источника (ТЗ 7.1).
 *
 * Основной сценарий: менеджер стоит в заказе, жмёт «Счёт» и получает
 * заполненный черновик. Заполняет его сервер, а не человек: реквизиты,
 * табличная часть, суммы, НДС, срок оплаты — всё это уже есть в системе, и
 * перепечатывание руками добавляет только опечатки.
 *
 * Два правила держат весь этап:
 *
 * 1. **Документ — снимок, а не вид на источник.** Строки, цены, реквизиты и
 *    сумма прописью записываются в сам документ. Счёт, выставленный в марте,
 *    печатается мартовскими числами, даже если в заказе потом всё поменяли:
 *    он ушёл клиенту, и по нему платят.
 * 2. **Номер выдаётся в той же транзакции.** Оборвалось создание — откатился
 *    и счётчик: дырки в нумерации объяснять налоговой.
 */
@Injectable()
export class DocumentsFromSourceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
  ) {}

  /**
   * Из чего документ делается.
   *
   * Список закрытый, и имя таблицы в запрос не подставляется: `source_doc_type`
   * хранит строку, и собрать по ней `FROM ${kind}` было бы дырой.
   */
  static readonly SOURCES = [
    'sales_order',
    'shipment',
    'deal',
    'finance_operation',
    'production_order',
    'partner',
  ] as const;

  async create(body: {
    documentTypeUid: string;
    sourceType: string;
    sourceUid: string;
    locale?: 'ru' | 'uz';
    documentDate?: string;
  }) {
    const ctx = currentContext();
    return this.prisma.withTenant(async (tx) => {
      const type = await this.loadType(tx, body.documentTypeUid);
      const locale = body.locale ?? 'ru';
      const src = await this.loadSource(tx, body.sourceType, body.sourceUid);

      if (src.companyId !== type.company_id) {
        throw new UnprocessableEntityException(say(
          'Тип документа и источник принадлежат разным компаниям: ' +
            'у каждой своя нумерация, и номер из чужой серии в документе значил бы неправду', 'Hujjat turi va manba turli kompaniyalarga tegishli: ' + 'har birining o‘z raqamlashi bor, boshqa seriyadagi raqam hujjatda yolg‘on bo‘lardi'));
      }

      const date = body.documentDate ? new Date(body.documentDate) : new Date();
      if (Number.isNaN(date.getTime())) {
        throw new UnprocessableEntityException(say('Дата документа не разобрана', 'Hujjat sanasi o‘qilmadi'));
      }

      const number = await this.numbering.issue(
        tx,
        {
          id: type.id,
          companyId: type.company_id,
          code: type.code,
          mask: type.numbering_mask,
          scope: type.counter_scope,
        },
        { code: type.company_code },
        date,
      );

      const totals = this.totals(src.lines, src.amountTotal);
      const requisites = await this.requisites(tx, type.company_id, src, locale, totals);

      const inserted = await tx.$queryRawUnsafe<{ id: bigint; uid: string }[]>(
        `INSERT INTO document
           (uid, company_id, document_type_id, number, document_date, partner_id,
            source_doc_type, source_doc_id, currency_id,
            amount_net, amount_vat, amount_total, requisites, locale, status, version, created_by)
         VALUES (gen_random_uuid(), $1, $2, $3, $4::date, $5, $6, $7, $8,
                 $9, $10, $11, $12::jsonb, $13::"Locale", 'draft', 1, $14)
         RETURNING id, uid`,
        type.company_id,
        type.id,
        number,
        date.toISOString().slice(0, 10),
        src.partnerId,
        body.sourceType,
        src.id,
        src.currencyId,
        totals.net,
        totals.vat,
        totals.total,
        JSON.stringify(requisites),
        locale,
        ctx?.userId ?? null,
      );
      const doc = inserted[0]!;

      for (const [i, line] of src.lines.entries()) {
        await tx.$executeRawUnsafe(
          `INSERT INTO document_line
             (company_id, document_id, seq, item_id, item_code, name, qty,
              unit_code, unit_name, price, discount_percent, vat_rate,
              amount_net, amount_vat, amount_total)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
          type.company_id,
          doc.id,
          i + 1,
          line.itemId,
          line.itemCode,
          line.name,
          line.qty,
          line.unitCode,
          line.unitName,
          line.price,
          line.discountPercent,
          line.vatRate,
          line.amountNet,
          line.amountVat,
          line.amountTotal,
        );
      }

      return { uid: doc.uid, number };
    });
  }

  /**
   * Поиск источника по номеру — для формы «выписать документ».
   *
   * Запросы под каждый вид написаны отдельно, а не собраны строкой из
   * `kind`: имя таблицы, пришедшее из данных, в запрос не подставляется.
   */
  /**
   * Какой документ уместно выписать из какого источника.
   *
   * Запрета на остальное нет и не вводится: кто работает в полной форме,
   * знает, что делает, и ломать ему сложившийся порядок задним числом нельзя.
   * Это подсказка, но живёт она здесь, а не в экране: иначе бот предложил бы
   * из заказа товарно-транспортную накладную — документ о том, что машина
   * уехала, хотя никто ничего не отгружал.
   */
  static readonly SUGGESTED: Record<string, string[]> = {
    sales_order: ['INV', 'SPEC', 'CONTRACT'],
    shipment: ['TTN', 'ACT'],
    deal: ['CONTRACT', 'SPEC'],
    partner: ['CONTRACT'],
    finance_operation: [],
    production_order: [],
  };

  /**
   * Типы документов компании источника, уместные первыми.
   *
   * Компанию берём из самого источника, а не спрашиваем: документ по заказу
   * торгового дома в серии завода означал бы чужой номер в бумаге, которая
   * уйдёт клиенту.
   */
  async typesFor(sourceType: string, sourceUid: string) {
    return this.prisma.withTenant(async (tx) => {
      const src = await this.loadSource(tx, sourceType, sourceUid);
      const suggested = DocumentsFromSourceService.SUGGESTED[sourceType] ?? [];
      const rows = await tx.$queryRaw<
        { uid: string; code: string; name_ru: string; name_uz: string }[]
      >`
        SELECT uid, code, name_ru, name_uz
          FROM document_type
         WHERE company_id = ${src.companyId} AND is_active
         ORDER BY code`;
      return {
        rows: rows
          .map((r) => ({
            uid: r.uid,
            code: r.code,
            nameRu: r.name_ru,
            nameUz: r.name_uz,
            suggested: suggested.includes(r.code),
          }))
          .sort((a, b) => {
            if (a.suggested !== b.suggested) return a.suggested ? -1 : 1;
            const ai = suggested.indexOf(a.code);
            const bi = suggested.indexOf(b.code);
            return a.suggested ? ai - bi : a.code.localeCompare(b.code);
          }),
      };
    });
  }

  async sources(kind: string, search: string) {
    if (!(DocumentsFromSourceService.SOURCES as readonly string[]).includes(kind)) {
      throw new UnprocessableEntityException(say(`Источник «${kind}» не поддерживается`, `«${kind}» manbasi qo‘llab-quvvatlanmaydi`));
    }
    const like = `%${search.trim()}%`;
    const sql: Record<string, string> = {
      sales_order: `SELECT o.uid, o.number, o.order_date AS at, app_loc(p.name_ru, p.name_uz) AS partner,
                           o.amount_total::text AS amount
                      FROM sales_order o LEFT JOIN partner p ON p.id = o.partner_id
                     WHERE o.number ILIKE $1 ORDER BY o.order_date DESC, o.id DESC LIMIT 20`,
      shipment: `SELECT s.uid, s.number, s.shipped_at AS at, app_loc(p.name_ru, p.name_uz) AS partner, NULL AS amount
                   FROM shipment s
                   JOIN sales_order o ON o.id = s.sales_order_id
                   LEFT JOIN partner p ON p.id = o.partner_id
                  WHERE s.number ILIKE $1 ORDER BY s.shipped_at DESC, s.id DESC LIMIT 20`,
      deal: `SELECT d.uid, d.number, d.created_at AS at, app_loc(p.name_ru, p.name_uz) AS partner,
                    d.amount::text AS amount
               FROM deal d LEFT JOIN partner p ON p.id = d.partner_id
              WHERE d.number ILIKE $1 OR d.title ILIKE $1
              ORDER BY d.created_at DESC LIMIT 20`,
      finance_operation: `SELECT f.uid, f.number, f.occurred_at AS at, app_loc(p.name_ru, p.name_uz) AS partner,
                                 f.amount::text AS amount
                            FROM finance_operation f LEFT JOIN partner p ON p.id = f.partner_id
                           WHERE f.number ILIKE $1 ORDER BY f.occurred_at DESC LIMIT 20`,
      production_order: `SELECT po.uid, po.number, po.due_date AS at, NULL AS partner,
                                NULL AS amount
                           FROM production_order po
                          WHERE po.number ILIKE $1 ORDER BY po.due_date DESC, po.id DESC LIMIT 20`,
      partner: `SELECT p.uid, app_loc(p.name_ru, p.name_uz) AS number, NULL AS at, app_loc(p.name_ru, p.name_uz) AS partner, NULL AS amount
                  FROM partner p
                 WHERE p.is_active AND (p.name_ru ILIKE $1 OR coalesce(p.inn, '') ILIKE $1)
                 ORDER BY p.name_ru LIMIT 20`,
    };
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.$queryRawUnsafe<Record<string, any>[]>(sql[kind]!, like);
      return {
        rows: rows.map((r) => ({
          uid: r.uid,
          number: r.number,
          at: r.at ? new Date(r.at).toISOString().slice(0, 10) : null,
          partner: r.partner ?? null,
          amount: r.amount ?? null,
        })),
      };
    });
  }

  // --- источники ------------------------------------------------------------

  private async loadType(tx: Tx, uid: string) {
    const rows = await tx.$queryRawUnsafe<Record<string, any>[]>(
      `SELECT t.id, t.company_id, t.code, t.name_ru, t.numbering_mask,
              t.counter_scope::text AS counter_scope, t.is_active,
              co.code AS company_code
         FROM document_type t
         JOIN company co ON co.id = t.company_id
        WHERE t.uid = $1::uuid`,
      uid,
    );
    const t = rows[0];
    if (!t) throw new NotFoundException(MSG.documentTypeNotFound());
    if (!t.is_active) {
      throw new ConflictException(say(
        `Тип «${t.name_ru}» выключен: по нему не выписывают новые документы`, `«${t.name}» turi o‘chirilgan: u bo‘yicha yangi hujjat yozilmaydi`));
    }
    return t;
  }

  private async loadSource(tx: Tx, kind: string, uid: string) {
    if (!(DocumentsFromSourceService.SOURCES as readonly string[]).includes(kind)) {
      throw new UnprocessableEntityException(say(
        `Источник «${kind}» не поддерживается. Документ делают из: ` +
          DocumentsFromSourceService.SOURCES.join(', '), `«${kind}» manbasi qo‘llab-quvvatlanmaydi. Hujjat quyidagilardan tuziladi: ` + DocumentsFromSourceService.SOURCES.join(', ')));
    }
    switch (kind) {
      case 'sales_order':
        return this.fromSalesOrder(tx, uid);
      case 'shipment':
        return this.fromShipment(tx, uid);
      case 'deal':
        return this.fromDeal(tx, uid);
      case 'finance_operation':
        return this.fromFinanceOperation(tx, uid);
      case 'production_order':
        return this.fromProductionOrder(tx, uid);
      default:
        return this.fromPartner(tx, uid);
    }
  }

  private notFound(what: string): never {
    throw new NotFoundException(say(`${what} не найден`, `${what} topilmadi`));
  }

  private async fromSalesOrder(tx: Tx, uid: string) {
    const rows = await tx.$queryRawUnsafe<Record<string, any>[]>(
      `SELECT o.id, o.company_id, o.number, o.partner_id, o.currency_id,
              o.amount_total::text AS amount_total, o.payment_due_date, o.delivery_date,
              o.order_date
         FROM sales_order o WHERE o.uid = $1::uuid`,
      uid,
    );
    const o = rows[0] ?? this.notFound('Заказ');
    const lines = await tx.$queryRawUnsafe<Record<string, any>[]>(
      `SELECT l.seq, l.item_id, i.code AS item_code, i.name_ru, i.name_uz,
              l.qty::text AS qty, u.code AS unit_code, u.name_ru AS unit_ru, u.name_uz AS unit_uz,
              l.price::text AS price, l.discount_percent::text AS discount_percent,
              l.vat_rate::text AS vat_rate, l.amount_net::text AS amount_net,
              l.amount_vat::text AS amount_vat, l.amount_total::text AS amount_total
         FROM sales_order_line l
         JOIN item i ON i.id = l.item_id
         JOIN unit u ON u.id = l.unit_id
        WHERE l.sales_order_id = $1
        ORDER BY l.seq`,
      o.id,
    );
    return {
      id: o.id as bigint,
      companyId: o.company_id as bigint,
      number: o.number as string,
      partnerId: o.partner_id as bigint | null,
      currencyId: o.currency_id as bigint | null,
      amountTotal: o.amount_total as string | null,
      paymentDueDate: o.payment_due_date as Date | null,
      deliveryDate: o.delivery_date as Date | null,
      basis: `Заказ ${o.number}`,
      lines: lines.map((l) => this.line(l)),
    };
  }

  private async fromShipment(tx: Tx, uid: string) {
    const rows = await tx.$queryRawUnsafe<Record<string, any>[]>(
      `SELECT s.id, s.company_id, s.number, o.partner_id, o.currency_id,
              o.payment_due_date, s.vehicle, s.driver,
              s.net_weight_t::text AS net_weight_t, s.gross_weight_t::text AS gross_weight_t
         FROM shipment s
         JOIN sales_order o ON o.id = s.sales_order_id
        WHERE s.uid = $1::uuid`,
      uid,
    );
    const s = rows[0] ?? this.notFound('Отгрузка');
    // В накладной печатают то, что реально уехало, а цену берут из строки
    // заказа: отгрузили половину — в накладной половина, но по той же цене.
    const lines = await tx.$queryRawUnsafe<Record<string, any>[]>(
      `SELECT row_number() OVER (ORDER BY sl.id) AS seq,
              sl.item_id, i.code AS item_code, i.name_ru, i.name_uz,
              sl.qty::text AS qty,
              u.code AS unit_code, u.name_ru AS unit_ru, u.name_uz AS unit_uz,
              coalesce(ol.price, 0)::text AS price,
              coalesce(ol.discount_percent, 0)::text AS discount_percent,
              coalesce(ol.vat_rate, i.vat_rate)::text AS vat_rate
         FROM shipment_line sl
         JOIN item i ON i.id = sl.item_id
         LEFT JOIN sales_order_line ol ON ol.id = sl.sales_order_line_id
         LEFT JOIN unit u ON u.id = coalesce(ol.unit_id, i.base_unit_id)
        WHERE sl.shipment_id = $1
        ORDER BY sl.id`,
      s.id,
    );
    return {
      id: s.id as bigint,
      companyId: s.company_id as bigint,
      number: s.number as string,
      partnerId: s.partner_id as bigint | null,
      currencyId: s.currency_id as bigint | null,
      amountTotal: null as string | null,
      paymentDueDate: s.payment_due_date as Date | null,
      deliveryDate: null as Date | null,
      basis: `Отгрузка ${s.number}`,
      vehicle: s.vehicle as string | null,
      driver: s.driver as string | null,
      netWeightT: s.net_weight_t as string | null,
      grossWeightT: s.gross_weight_t as string | null,
      // Суммы считаются по количеству отгрузки и цене заказа, а не берутся
      // из заказа целиком.
      lines: lines.map((l) => this.line(l, true)),
    };
  }

  private async fromDeal(tx: Tx, uid: string) {
    const rows = await tx.$queryRawUnsafe<Record<string, any>[]>(
      `SELECT d.id, d.company_id, d.number, d.title, d.partner_id, d.currency_id,
              d.amount::text AS amount
         FROM deal d WHERE d.uid = $1::uuid`,
      uid,
    );
    const d = rows[0] ?? this.notFound('Сделка');
    if (!d.partner_id) {
      throw new UnprocessableEntityException(say(
        'У сделки нет контрагента: документ выписывать некому. ' +
          'Сначала свяжите сделку с клиентом', 'Bitimda kontragent yo‘q: hujjatni yozadigan tomon yo‘q. ' + 'Avval bitimni mijozga bog‘lang'));
    }
    return {
      id: d.id as bigint,
      companyId: d.company_id as bigint,
      number: d.number as string,
      partnerId: d.partner_id as bigint,
      currencyId: d.currency_id as bigint | null,
      amountTotal: d.amount as string | null,
      paymentDueDate: null as Date | null,
      deliveryDate: null as Date | null,
      basis: `Сделка ${d.number} «${d.title}»`,
      lines: [] as ReturnType<DocumentsFromSourceService['line']>[],
    };
  }

  private async fromFinanceOperation(tx: Tx, uid: string) {
    const rows = await tx.$queryRawUnsafe<Record<string, any>[]>(
      `SELECT f.id, f.company_id, f.number, f.partner_id, f.currency_id,
              f.amount::text AS amount, f.comment
         FROM finance_operation f WHERE f.uid = $1::uuid`,
      uid,
    );
    const f = rows[0] ?? this.notFound('Платёж');
    return {
      id: f.id as bigint,
      companyId: f.company_id as bigint,
      number: f.number as string,
      partnerId: f.partner_id as bigint | null,
      currencyId: f.currency_id as bigint | null,
      amountTotal: f.amount as string | null,
      paymentDueDate: null as Date | null,
      deliveryDate: null as Date | null,
      basis: `Платёж ${f.number}`,
      lines: [] as ReturnType<DocumentsFromSourceService['line']>[],
    };
  }

  private async fromProductionOrder(tx: Tx, uid: string) {
    const rows = await tx.$queryRawUnsafe<Record<string, any>[]>(
      `SELECT p.id, p.company_id, p.number, p.item_id, p.qty_planned::text AS qty_planned,
              p.qty_produced::text AS qty_produced,
              i.code AS item_code, i.name_ru, i.name_uz, i.vat_rate::text AS vat_rate,
              u.code AS unit_code, u.name_ru AS unit_ru, u.name_uz AS unit_uz,
              o.partner_id, o.currency_id
         FROM production_order p
         JOIN item i ON i.id = p.item_id
         JOIN unit u ON u.id = p.unit_id
         LEFT JOIN sales_order o ON o.id = p.sales_order_id
        WHERE p.uid = $1::uuid`,
      uid,
    );
    const p = rows[0] ?? this.notFound('Производственное задание');
    // В задании печатают выпущенное, а пока не выпущено — плановое.
    const qty = Number(p.qty_produced) > 0 ? p.qty_produced : p.qty_planned;
    return {
      id: p.id as bigint,
      companyId: p.company_id as bigint,
      number: p.number as string,
      partnerId: p.partner_id as bigint | null,
      currencyId: p.currency_id as bigint | null,
      amountTotal: null as string | null,
      paymentDueDate: null as Date | null,
      deliveryDate: null as Date | null,
      basis: `Производственное задание ${p.number}`,
      lines: [
        this.line(
          {
            seq: 1,
            item_id: p.item_id,
            item_code: p.item_code,
            name_ru: p.name_ru,
            name_uz: p.name_uz,
            qty,
            unit_code: p.unit_code,
            unit_ru: p.unit_ru,
            unit_uz: p.unit_uz,
            price: '0',
            discount_percent: '0',
            vat_rate: p.vat_rate,
          },
          true,
        ),
      ],
    };
  }

  private async fromPartner(tx: Tx, uid: string) {
    const rows = await tx.$queryRawUnsafe<Record<string, any>[]>(
      `SELECT p.id, p.company_id, p.name_ru, p.payment_delay_days
         FROM partner p WHERE p.uid = $1::uuid`,
      uid,
    );
    const p = rows[0] ?? this.notFound('Контрагент');
    return {
      id: p.id as bigint,
      companyId: p.company_id as bigint,
      number: p.name_ru as string,
      partnerId: p.id as bigint,
      currencyId: null as bigint | null,
      amountTotal: null as string | null,
      paymentDueDate: null as Date | null,
      deliveryDate: null as Date | null,
      basis: `Контрагент ${p.name_ru}`,
      lines: [] as ReturnType<DocumentsFromSourceService['line']>[],
    };
  }

  // --- сборка ---------------------------------------------------------------

  /**
   * Строка документа.
   *
   * `recompute` — для источников, где суммы строк не посчитаны заранее
   * (отгрузка, производство): там есть количество и цена, а итог надо сложить
   * здесь. Для заказа суммы берутся его собственные: пересчитав их по-своему,
   * мы однажды напечатали бы в счёте не то, что стоит в заказе.
   */
  private line(l: Record<string, any>, recompute = false) {
    const qty = l.qty as string;
    const price = (l.price ?? '0') as string;
    const discount = (l.discount_percent ?? '0') as string;
    const vatRate = (l.vat_rate ?? '0') as string;

    let net = l.amount_net as string | undefined;
    let vat = l.amount_vat as string | undefined;
    let total = l.amount_total as string | undefined;
    if (recompute || net === undefined) {
      const gross = Number(qty) * Number(price);
      const n = gross * (1 - Number(discount) / 100);
      const v = n * (Number(vatRate) / 100);
      net = n.toFixed(4);
      vat = v.toFixed(4);
      total = (n + v).toFixed(4);
    }

    return {
      itemId: (l.item_id ?? null) as bigint | null,
      itemCode: (l.item_code ?? null) as string | null,
      name: l.name_ru as string,
      nameUz: l.name_uz as string,
      qty,
      unitCode: (l.unit_code ?? '') as string,
      unitName: (l.unit_ru ?? '') as string,
      unitNameUz: (l.unit_uz ?? '') as string,
      price,
      discountPercent: discount,
      vatRate,
      // Деньги документа — тийины, не доли тийина: то же правило, что в
      // согласовании (`workflow.service.ts`). Источник держит четыре знака,
      // документ показывает два — несведённый остаток всплывал суммой
      // прописью, которая расходилась с шапкой на один тийин.
      amountNet: this.money(net!),
      amountVat: this.money(vat ?? '0'),
      amountTotal: this.money(total ?? net!),
    };
  }

  /**
   * Итог документа.
   *
   * Есть строки — складываем их: иначе шапка и таблица разойдутся, и спорить
   * будут именно об этом. Строк нет (сделка, платёж) — берём сумму источника.
   */
  /** Деньги документа округляются до тийинов (ТЗ 7.1). */
  private money(n: string | number): string {
    return Number(n).toFixed(2);
  }

  private totals(lines: { amountNet: string; amountVat: string; amountTotal: string }[], fallback: string | null) {
    if (!lines.length) {
      const t = fallback ?? '0';
      return { net: t, vat: '0', total: t };
    }
    // Складываем уже округлённые строки и держим два знака: шапка обязана
    // сойтись с тем, что напечатано в таблице, до тийина.
    const sum = (pick: (l: (typeof lines)[number]) => string) =>
      lines.reduce((a, l) => a + Number(pick(l)), 0).toFixed(2);
    return {
      net: sum((l) => l.amountNet),
      vat: sum((l) => l.amountVat),
      total: sum((l) => l.amountTotal),
    };
  }

  /**
   * Снимок реквизитов.
   *
   * Всё, что печатается в шапке и подвале: кто выписал, кому, по какому
   * основанию, до какого числа платить и сумма прописью. Сменили расчётный
   * счёт — в выписанных счетах остаётся прежний.
   */
  private async requisites(
    tx: Tx,
    companyId: bigint,
    src: Awaited<ReturnType<DocumentsFromSourceService['loadSource']>>,
    locale: 'ru' | 'uz',
    totals: { net: string; vat: string; total: string },
  ) {
    const co = (
      await tx.$queryRawUnsafe<Record<string, any>[]>(
        `SELECT name_ru, name_uz, inn, legal_address, bank_details, base_currency
           FROM company WHERE id = $1`,
        companyId,
      )
    )[0]!;

    let partner: Record<string, any> | null = null;
    if (src.partnerId) {
      partner =
        (
          await tx.$queryRawUnsafe<Record<string, any>[]>(
            `SELECT name_ru, name_uz, inn, legal_address, actual_address, bank_details,
                    payment_delay_days
               FROM partner WHERE id = $1`,
            src.partnerId,
          )
        )[0] ?? null;
    }

    let currency = co.base_currency as string;
    if (src.currencyId) {
      const c = await tx.$queryRawUnsafe<{ code: string }[]>(
        `SELECT code FROM currency WHERE id = $1`,
        src.currencyId,
      );
      if (c[0]) currency = c[0].code;
    }

    const anySrc = src as Record<string, any>;
    return {
      company: {
        name: locale === 'uz' ? co.name_uz : co.name_ru,
        inn: co.inn,
        legalAddress: co.legal_address,
        bank: co.bank_details ?? null,
      },
      partner: partner && {
        name: locale === 'uz' ? partner.name_uz : partner.name_ru,
        inn: partner.inn,
        legalAddress: partner.legal_address,
        actualAddress: partner.actual_address,
        bank: partner.bank_details ?? null,
      },
      basis: src.basis,
      paymentDueDate: src.paymentDueDate
        ? new Date(src.paymentDueDate).toISOString().slice(0, 10)
        : null,
      paymentDelayDays: partner?.payment_delay_days ?? null,
      deliveryDate: src.deliveryDate
        ? new Date(src.deliveryDate).toISOString().slice(0, 10)
        : null,
      vehicle: anySrc.vehicle ?? null,
      driver: anySrc.driver ?? null,
      netWeightT: anySrc.netWeightT ?? null,
      grossWeightT: anySrc.grossWeightT ?? null,
      currency,
      amountInWords: amountInWords(totals.total, currency, locale),
    };
  }
}
