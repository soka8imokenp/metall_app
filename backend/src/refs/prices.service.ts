import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { currentContext } from '../common/request-context.js';
import { writeAudit } from '../common/audit.js';
import { MSG } from '../common/messages.js';
import { say } from '../common/say.js';

/**
 * Прайс-лист и индивидуальные цены клиентов (ТЗ 9.2).
 *
 * Таблицы `price_type`, `price_list` и `partner_price` стояли в базе с первого
 * дня, но ни один маршрут их не читал: цену в строке заказа менеджер набирал
 * руками с чистого листа. Прайс был мёртвым грузом, а «договорная цена
 * клиента» — словами в ТЗ.
 *
 * Два правила, от которых здесь всё зависит.
 *
 * **Цена живёт периодом, а не значением.** Строка прайса не правится на месте:
 * новая цена заводится новой строкой с датой начала, а предыдущая закрывается
 * днём раньше. Иначе заказ, выписанный в прошлом месяце, после правки прайса
 * стал бы «выписанным не по прайсу», и спорить о нём было бы нечем.
 *
 * **История не удаляется.** Удалить можно только последнюю строку по позиции и
 * типу цены — тогда предыдущая снова открывается, и в периодах не остаётся
 * дыры. Удаление строки из середины увело бы из истории цену, по которой уже
 * продано.
 */
@Injectable()
export class PricesService {
  constructor(private readonly prisma: PrismaService) {}

  // --- общее ----------------------------------------------------------------

  private async resolveCompany(tx: Tx, companyUid: string | undefined): Promise<bigint> {
    const ids = currentContext()?.companyIds ?? [];
    if (ids.length === 0) throw new UnprocessableEntityException(MSG.noCompany());
    if (!companyUid) {
      if (ids.length > 1) {
        throw new UnprocessableEntityException(say('Выбраны обе компании: укажите, в чей прайс пишем', 'Ikkala kompaniya tanlangan: qaysi birining narxnomasiga yozilishini ko‘rsating'));
      }
      return ids[0]!;
    }
    const rows = await tx.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM company WHERE uid = ${companyUid}::uuid`;
    const id = rows[0]?.id;
    if (id === undefined || !ids.includes(id)) throw new NotFoundException(MSG.companyNotFound());
    return id;
  }

  /** Цена: положительное число, не больше четырёх знаков после запятой. */
  private money(raw: unknown): number {
    const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').replace(',', '.'));
    if (!Number.isFinite(n)) throw new UnprocessableEntityException(say('Цена не число', 'Narx son emas'));
    if (n <= 0) throw new UnprocessableEntityException(say('Цена должна быть больше нуля', 'Narx noldan katta bo‘lishi kerak'));
    if (n > 1e15) throw new UnprocessableEntityException(say('Цена слишком велика', 'Narx juda katta'));
    return Math.round(n * 1e4) / 1e4;
  }

  /** Дата начала действия: только день, без времени и без часового пояса. */
  private day(raw: unknown, what: string): Date {
    const s = String(raw ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      throw new UnprocessableEntityException(say(`${what}: дата в виде ГГГГ-ММ-ДД`, `${what}: sana YYYY-MM-DD ko‘rinishida`));
    }
    const d = new Date(`${s}T00:00:00.000Z`);
    if (Number.isNaN(d.getTime())) throw new UnprocessableEntityException(say(`${what}: такой даты нет`, `${what}: bunday sana yo‘q`));
    return d;
  }

  private today(): Date {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }

  private async itemByCode(tx: Tx, companyId: bigint, code: string) {
    const rows = await tx.$queryRaw<{ id: bigint; name: string }[]>`
      SELECT id, app_loc(name_ru, name_uz) AS name FROM item
       WHERE company_id = ${companyId} AND code = ${String(code ?? '').trim()}`;
    if (!rows[0]) throw new UnprocessableEntityException(say(`Позиция ${code} не найдена`, `${code} pozitsiyasi topilmadi`));
    return rows[0];
  }

  private async uzsId(tx: Tx): Promise<bigint> {
    const rows = await tx.$queryRaw<{ id: bigint }[]>`SELECT id FROM currency WHERE code = 'UZS'`;
    if (!rows[0]) throw new UnprocessableEntityException(MSG.currencyNotFound('UZS'));
    return rows[0].id;
  }

  // --- типы цен -------------------------------------------------------------

  /**
   * Типы цен компании. `usedBy` нужен экрану, чтобы объяснить погашенную
   * кнопку удаления числами, а не словом «нельзя».
   */
  async priceTypes(companyUid?: string) {
    return this.prisma.withTenant(async (tx) => {
      const ids = currentContext()?.companyIds ?? [];
      if (ids.length === 0) throw new UnprocessableEntityException(MSG.noCompany());
      const only = companyUid ? await this.resolveCompany(tx, companyUid) : null;
      const rows = await tx.$queryRaw<
        {
          uid: string;
          code: string;
          name_ru: string;
          name_uz: string;
          kind: string;
          company_uid: string;
          company_code: string;
          prices: bigint;
          partners: bigint;
          orders: bigint;
        }[]
      >`
        SELECT pt.uid, pt.code, pt.name_ru, pt.name_uz, pt.kind::text AS kind,
               c.uid AS company_uid, c.code AS company_code,
               (SELECT count(*) FROM price_list pl WHERE pl.price_type_id = pt.id) AS prices,
               (SELECT count(*) FROM partner p WHERE p.price_type_id = pt.id) AS partners,
               (SELECT count(*) FROM sales_order so WHERE so.price_type_id = pt.id) AS orders
          FROM price_type pt
          JOIN company c ON c.id = pt.company_id
         WHERE pt.company_id = ANY(${ids}) AND (${only}::bigint IS NULL OR pt.company_id = ${only})
         ORDER BY c.code, pt.code`;
      return {
        rows: rows.map((r) => ({
          uid: r.uid,
          code: r.code,
          nameRu: r.name_ru,
          nameUz: r.name_uz,
          kind: r.kind,
          company: { uid: r.company_uid, code: r.company_code },
          usedBy: {
            prices: Number(r.prices),
            partners: Number(r.partners),
            orders: Number(r.orders),
          },
        })),
      };
    });
  }

  async createPriceType(input: {
    companyUid?: string;
    code: string;
    nameRu: string;
    nameUz?: string;
    kind: string;
  }) {
    return this.prisma.withTenant(async (tx) => {
      const companyId = await this.resolveCompany(tx, input.companyUid);
      const code = String(input.code ?? '').trim();
      if (!/^[a-z0-9_]{2,32}$/.test(code)) {
        throw new UnprocessableEntityException(say(
          'Код типа цены: латиница в нижнем регистре, цифры и подчёркивание, 2–32 знака', 'Narx turi kodi: kichik lotin harflari, raqamlar va pastki chiziq, 2–32 belgi'));
      }
      const dup = await tx.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM price_type WHERE company_id = ${companyId} AND code = ${code}`;
      if (Number(dup[0]?.n ?? 0) > 0) {
        throw new UnprocessableEntityException(say(`Тип цены ${code} в этой компании уже есть`, `${code} narx turi bu kompaniyada allaqachon bor`));
      }
      const nameRu = String(input.nameRu ?? '').trim();
      if (!nameRu) throw new UnprocessableEntityException(say('Название типа цены не задано', 'Narx turining nomi berilmagan'));
      const rows = await tx.$queryRaw<{ uid: string }[]>`
        INSERT INTO price_type (company_id, code, name_ru, name_uz, kind)
        VALUES (${companyId}, ${code}, ${nameRu}, ${String(input.nameUz ?? '').trim() || nameRu},
                ${input.kind}::"PriceTypeKind")
        RETURNING uid`;
      await writeAudit(tx, {
        companyId,
        entityType: 'price_type',
        entityId: rows[0]!.uid,
        action: 'create',
        changes: { code: { from: null, to: code }, nameRu: { from: null, to: nameRu } },
      });
      return { uid: rows[0]!.uid, code };
    });
  }

  async updatePriceType(uid: string, input: { nameRu?: string; nameUz?: string; kind?: string }) {
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.$queryRaw<
        { id: bigint; company_id: bigint; name_ru: string; name_uz: string; kind: string }[]
      >`
        SELECT id, company_id, name_ru, name_uz, kind::text AS kind
          FROM price_type WHERE uid = ${uid}::uuid`;
      const row = rows[0];
      if (!row) throw new NotFoundException(MSG.priceTypeNotFound());

      const nameRu = input.nameRu === undefined ? row.name_ru : String(input.nameRu).trim();
      const nameUz = input.nameUz === undefined ? row.name_uz : String(input.nameUz).trim();
      if (!nameRu) throw new UnprocessableEntityException(say('Название типа цены не задано', 'Narx turining nomi berilmagan'));
      const kind = input.kind === undefined ? row.kind : input.kind;

      await tx.$executeRaw`
        UPDATE price_type
           SET name_ru = ${nameRu}, name_uz = ${nameUz || nameRu}, kind = ${kind}::"PriceTypeKind"
         WHERE id = ${row.id}`;
      await writeAudit(tx, {
        companyId: row.company_id,
        entityType: 'price_type',
        entityId: uid,
        action: 'update',
        changes: {
          ...(nameRu !== row.name_ru ? { nameRu: { from: row.name_ru, to: nameRu } } : {}),
          ...(kind !== row.kind ? { kind: { from: row.kind, to: kind } } : {}),
        },
      });
      return { uid, nameRu, kind };
    });
  }

  /**
   * Удаление типа цены — только пока им никто не пользовался. Тип, которым
   * выписан хоть один заказ, оставил бы заказ без типа цены, а отчёт по марже
   * сравнивает факт именно с ним.
   */
  async deletePriceType(uid: string) {
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.$queryRaw<{ id: bigint; company_id: bigint; code: string }[]>`
        SELECT id, company_id, code FROM price_type WHERE uid = ${uid}::uuid`;
      const row = rows[0];
      if (!row) throw new NotFoundException(MSG.priceTypeNotFound());
      const used = await tx.$queryRaw<{ prices: bigint; partners: bigint; orders: bigint }[]>`
        SELECT (SELECT count(*) FROM price_list WHERE price_type_id = ${row.id}) AS prices,
               (SELECT count(*) FROM partner WHERE price_type_id = ${row.id}) AS partners,
               (SELECT count(*) FROM sales_order WHERE price_type_id = ${row.id}) AS orders`;
      const u = used[0]!;
      const parts = [
        Number(u.prices) ? `строк прайса — ${Number(u.prices)}` : null,
        Number(u.partners) ? `клиентов — ${Number(u.partners)}` : null,
        Number(u.orders) ? `заказов — ${Number(u.orders)}` : null,
      ].filter(Boolean);
      if (parts.length) {
        throw new UnprocessableEntityException(say(
          `Тип цены уже используется (${parts.join(', ')}): удалить нельзя, иначе прошлое останется без типа цены`, `Narx turi allaqachon ishlatilmoqda (${parts.join(', ')}): o‘chirib bo‘lmaydi, aks holda o‘tgan yozuvlar narx turisiz qoladi`));
      }
      await tx.$executeRaw`DELETE FROM price_type WHERE id = ${row.id}`;
      await writeAudit(tx, {
        companyId: row.company_id,
        entityType: 'price_type',
        entityId: uid,
        action: 'delete',
        changes: { code: { from: row.code, to: null } },
      });
      return { uid, deleted: true };
    });
  }

  // --- прайс-лист -----------------------------------------------------------

  /**
   * Прайс матрицей: строка — позиция, столбцы — типы цен, в клетке цена,
   * действующая на дату. Так его и читают: «сколько стоит швеллер оптом».
   */
  async prices(params: {
    companyUid?: string;
    search?: string;
    onDate?: string;
    limit?: number;
    offset?: number;
  }) {
    return this.prisma.withTenant(async (tx) => {
      const ids = currentContext()?.companyIds ?? [];
      if (ids.length === 0) throw new UnprocessableEntityException(MSG.noCompany());
      const only = params.companyUid ? await this.resolveCompany(tx, params.companyUid) : null;
      const onDate = params.onDate ? this.day(params.onDate, 'Дата') : this.today();
      const limit = Math.min(Math.max(Number(params.limit ?? 50) || 50, 1), 200);
      const offset = Math.max(Number(params.offset ?? 0) || 0, 0);
      const search = (params.search ?? '').trim();
      const like = search ? `%${search.toLowerCase()}%` : null;

      const types = await tx.$queryRaw<
        { uid: string; code: string; name_ru: string; kind: string; company_uid: string }[]
      >`
        SELECT pt.uid, pt.code, pt.name_ru, pt.kind::text AS kind, c.uid AS company_uid
          FROM price_type pt JOIN company c ON c.id = pt.company_id
         WHERE pt.company_id = ANY(${ids}) AND (${only}::bigint IS NULL OR pt.company_id = ${only})
         ORDER BY c.code, pt.code`;

      const total = await tx.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM item i
         WHERE i.company_id = ANY(${ids}) AND (${only}::bigint IS NULL OR i.company_id = ${only})
           AND i.is_active
           AND (${like}::text IS NULL
                OR lower(i.code) LIKE ${like} OR lower(i.name_ru) LIKE ${like})`;

      const items = await tx.$queryRaw<
        { uid: string; code: string; name: string; unit: string; company_uid: string }[]
      >`
        SELECT i.uid, i.code, app_loc(i.name_ru, i.name_uz) AS name, u.code AS unit, c.uid AS company_uid
          FROM item i
          JOIN unit u ON u.id = i.base_unit_id
          JOIN company c ON c.id = i.company_id
         WHERE i.company_id = ANY(${ids}) AND (${only}::bigint IS NULL OR i.company_id = ${only})
           AND i.is_active
           AND (${like}::text IS NULL
                OR lower(i.code) LIKE ${like} OR lower(i.name_ru) LIKE ${like})
         ORDER BY i.code
         LIMIT ${limit}::int OFFSET ${offset}::int`;

      const codes = items.map((i) => i.code);
      const cells = codes.length
        ? await tx.$queryRaw<
            {
              item_uid: string;
              type_uid: string;
              uid: string;
              price: unknown;
              valid_from: Date;
              valid_to: Date | null;
            }[]
          >`
            SELECT i.uid AS item_uid, pt.uid AS type_uid, pl.uid, pl.price,
                   pl.valid_from, pl.valid_to
              FROM price_list pl
              JOIN item i ON i.id = pl.item_id
              JOIN price_type pt ON pt.id = pl.price_type_id
             WHERE pl.company_id = ANY(${ids})
               AND i.code = ANY(${codes})
               AND pl.valid_from <= ${onDate}
               AND (pl.valid_to IS NULL OR pl.valid_to >= ${onDate})`
        : [];

      const byItem = new Map<string, Record<string, unknown>>();
      for (const c of cells) {
        let m = byItem.get(c.item_uid);
        if (!m) byItem.set(c.item_uid, (m = {}));
        m[c.type_uid] = {
          uid: c.uid,
          price: Number(c.price),
          validFrom: c.valid_from.toISOString().slice(0, 10),
          validTo: c.valid_to ? c.valid_to.toISOString().slice(0, 10) : null,
        };
      }

      return {
        onDate: onDate.toISOString().slice(0, 10),
        total: Number(total[0]?.n ?? 0),
        types: types.map((t) => ({
          uid: t.uid,
          code: t.code,
          nameRu: t.name_ru,
          kind: t.kind,
          companyUid: t.company_uid,
        })),
        rows: items.map((i) => ({
          item: { uid: i.uid, code: i.code, name: i.name, unit: i.unit, companyUid: i.company_uid },
          prices: byItem.get(i.uid) ?? {},
        })),
      };
    });
  }

  /** История цены по позиции и типу: все периоды, новые сверху. */
  async priceHistory(params: { itemUid: string; priceTypeUid: string }) {
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.$queryRaw<
        { uid: string; price: unknown; valid_from: Date; valid_to: Date | null }[]
      >`
        SELECT pl.uid, pl.price, pl.valid_from, pl.valid_to
          FROM price_list pl
          JOIN item i ON i.id = pl.item_id
          JOIN price_type pt ON pt.id = pl.price_type_id
         WHERE i.uid = ${params.itemUid}::uuid AND pt.uid = ${params.priceTypeUid}::uuid
         ORDER BY pl.valid_from DESC`;
      return {
        rows: rows.map((r) => ({
          uid: r.uid,
          price: Number(r.price),
          validFrom: r.valid_from.toISOString().slice(0, 10),
          validTo: r.valid_to ? r.valid_to.toISOString().slice(0, 10) : null,
        })),
      };
    });
  }

  /**
   * Новая цена по позиции и типу. Предыдущая открытая строка закрывается днём
   * раньше — правкой на месте мы переписали бы цену, по которой уже продано.
   */
  async setPrice(input: {
    companyUid?: string;
    itemCode: string;
    priceTypeCode: string;
    price: unknown;
    validFrom?: string;
  }) {
    return this.prisma.withTenant(async (tx) => {
      const companyId = await this.resolveCompany(tx, input.companyUid);
      const item = await this.itemByCode(tx, companyId, input.itemCode);
      const typeRows = await tx.$queryRaw<{ id: bigint; code: string }[]>`
        SELECT id, code FROM price_type
         WHERE company_id = ${companyId} AND code = ${String(input.priceTypeCode ?? '').trim()}`;
      const type = typeRows[0];
      if (!type) throw new UnprocessableEntityException(say(`Тип цены ${input.priceTypeCode} не найден`, `${input.priceTypeCode} narx turi topilmadi`));

      const price = this.money(input.price);
      const validFrom = input.validFrom ? this.day(input.validFrom, 'Дата начала') : this.today();
      const currencyId = await this.uzsId(tx);

      const last = await tx.$queryRaw<
        { id: bigint; price: unknown; valid_from: Date; valid_to: Date | null }[]
      >`
        SELECT id, price, valid_from, valid_to FROM price_list
         WHERE company_id = ${companyId} AND item_id = ${item.id} AND price_type_id = ${type.id}
         ORDER BY valid_from DESC LIMIT 1`;

      if (last[0] && last[0].valid_from >= validFrom) {
        const was = last[0].valid_from.toISOString().slice(0, 10);
        throw new UnprocessableEntityException(say(
          `По этой позиции уже есть цена с ${was}: новая цена вводится датой позже, прошлое не переписываем`, `Bu pozitsiya bo‘yicha ${was} dan narx bor: yangi narx keyingi sana bilan kiritiladi, o‘tgani qayta yozilmaydi`));
      }

      if (last[0] && last[0].valid_to === null) {
        const dayBefore = new Date(validFrom.getTime() - 86_400_000);
        await tx.$executeRaw`
          UPDATE price_list SET valid_to = ${dayBefore} WHERE id = ${last[0].id}`;
      }

      const created = await tx.$queryRaw<{ uid: string }[]>`
        INSERT INTO price_list (uid, company_id, price_type_id, item_id, price, currency_id, valid_from)
        VALUES (gen_random_uuid(), ${companyId}, ${type.id}, ${item.id}, ${price}, ${currencyId},
                ${validFrom})
        RETURNING uid`;

      await writeAudit(tx, {
        companyId,
        entityType: 'price_list',
        entityId: created[0]!.uid,
        action: 'create',
        changes: {
          item: { from: null, to: String(input.itemCode).trim() },
          priceType: { from: null, to: type.code },
          price: { from: last[0] ? Number(last[0].price) : null, to: price },
          validFrom: { from: null, to: validFrom.toISOString().slice(0, 10) },
        },
      });

      return {
        uid: created[0]!.uid,
        price,
        validFrom: validFrom.toISOString().slice(0, 10),
        closedPrevious: Boolean(last[0] && last[0].valid_to === null),
      };
    });
  }

  /**
   * Снять последнюю цену. Предыдущая строка при этом снова открывается: иначе
   * в периодах осталась бы дыра, и позиция на день стала бы без цены.
   */
  async deletePrice(uid: string) {
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.$queryRaw<
        {
          id: bigint;
          company_id: bigint;
          item_id: bigint;
          price_type_id: bigint;
          price: unknown;
          valid_from: Date;
        }[]
      >`
        SELECT id, company_id, item_id, price_type_id, price, valid_from
          FROM price_list WHERE uid = ${uid}::uuid`;
      const row = rows[0];
      if (!row) throw new NotFoundException(say('Строка прайса не найдена', 'Narxnoma qatori topilmadi'));

      const later = await tx.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM price_list
         WHERE company_id = ${row.company_id} AND item_id = ${row.item_id}
           AND price_type_id = ${row.price_type_id} AND valid_from > ${row.valid_from}`;
      if (Number(later[0]?.n ?? 0) > 0) {
        throw new UnprocessableEntityException(say(
          'Это не последняя цена по позиции: история прайса не удаляется, иначе из периодов выпадет день', 'Bu pozitsiya bo‘yicha oxirgi narx emas: narxnoma tarixi o‘chirilmaydi, aks holda davrlardan bir kun chiqib qoladi'));
      }

      await tx.$executeRaw`DELETE FROM price_list WHERE id = ${row.id}`;
      await tx.$executeRaw`
        UPDATE price_list SET valid_to = NULL
         WHERE company_id = ${row.company_id} AND item_id = ${row.item_id}
           AND price_type_id = ${row.price_type_id}
           AND valid_from = (SELECT max(valid_from) FROM price_list
                              WHERE company_id = ${row.company_id} AND item_id = ${row.item_id}
                                AND price_type_id = ${row.price_type_id})`;
      await writeAudit(tx, {
        companyId: row.company_id,
        entityType: 'price_list',
        entityId: uid,
        action: 'delete',
        changes: { price: { from: Number(row.price), to: null } },
      });
      return { uid, deleted: true };
    });
  }

  // --- индивидуальные цены клиента -----------------------------------------

  /** Договорные цены клиента (ТЗ 9.2): перекрывают прайс, а не дополняют его. */
  async partnerPrices(params: { partnerUid: string; onDate?: string }) {
    return this.prisma.withTenant(async (tx) => {
      const onDate = params.onDate ? this.day(params.onDate, 'Дата') : this.today();
      const rows = await tx.$queryRaw<
        {
          uid: string;
          item_uid: string;
          item_code: string;
          item_name: string;
          unit: string;
          price: unknown;
          valid_from: Date;
          valid_to: Date | null;
        }[]
      >`
        SELECT pp.uid, i.uid AS item_uid, i.code AS item_code, app_loc(i.name_ru, i.name_uz) AS item_name,
               u.code AS unit, pp.price, pp.valid_from, pp.valid_to
          FROM partner_price pp
          JOIN partner p ON p.id = pp.partner_id
          JOIN item i ON i.id = pp.item_id
          JOIN unit u ON u.id = i.base_unit_id
         WHERE p.uid = ${params.partnerUid}::uuid
         ORDER BY i.code, pp.valid_from DESC`;
      return {
        onDate: onDate.toISOString().slice(0, 10),
        rows: rows.map((r) => ({
          uid: r.uid,
          item: { uid: r.item_uid, code: r.item_code, name: r.item_name, unit: r.unit },
          price: Number(r.price),
          validFrom: r.valid_from.toISOString().slice(0, 10),
          validTo: r.valid_to ? r.valid_to.toISOString().slice(0, 10) : null,
          isCurrent:
            r.valid_from <= onDate && (r.valid_to === null || r.valid_to >= onDate),
        })),
      };
    });
  }

  async setPartnerPrice(input: {
    companyUid?: string;
    partnerUid: string;
    itemCode: string;
    price: unknown;
    validFrom?: string;
  }) {
    return this.prisma.withTenant(async (tx) => {
      const companyId = await this.resolveCompany(tx, input.companyUid);
      const partner = await tx.$queryRaw<{ id: bigint; name: string }[]>`
        SELECT id, app_loc(name_ru, name_uz) AS name FROM partner
         WHERE company_id = ${companyId} AND uid = ${input.partnerUid}::uuid AND is_client`;
      if (!partner[0]) throw new UnprocessableEntityException(MSG.partnerNotFound());
      const item = await this.itemByCode(tx, companyId, input.itemCode);
      const price = this.money(input.price);
      const validFrom = input.validFrom ? this.day(input.validFrom, 'Дата начала') : this.today();
      const currencyId = await this.uzsId(tx);

      const last = await tx.$queryRaw<{ id: bigint; price: unknown; valid_from: Date; valid_to: Date | null }[]>`
        SELECT id, price, valid_from, valid_to FROM partner_price
         WHERE company_id = ${companyId} AND partner_id = ${partner[0].id} AND item_id = ${item.id}
         ORDER BY valid_from DESC LIMIT 1`;
      if (last[0] && last[0].valid_from >= validFrom) {
        const was = last[0].valid_from.toISOString().slice(0, 10);
        throw new UnprocessableEntityException(say(
          `У клиента уже есть цена по этой позиции с ${was}: новая вводится датой позже`, `Mijozda bu pozitsiya bo‘yicha ${was} dan narx bor: yangisi keyingi sana bilan kiritiladi`));
      }
      if (last[0] && last[0].valid_to === null) {
        const dayBefore = new Date(validFrom.getTime() - 86_400_000);
        await tx.$executeRaw`UPDATE partner_price SET valid_to = ${dayBefore} WHERE id = ${last[0].id}`;
      }
      const created = await tx.$queryRaw<{ uid: string }[]>`
        INSERT INTO partner_price (uid, company_id, partner_id, item_id, price, currency_id, valid_from)
        VALUES (gen_random_uuid(), ${companyId}, ${partner[0].id}, ${item.id}, ${price},
                ${currencyId}, ${validFrom})
        RETURNING uid`;
      await writeAudit(tx, {
        companyId,
        entityType: 'partner',
        entityId: input.partnerUid,
        action: 'price',
        changes: {
          item: { from: null, to: String(input.itemCode).trim() },
          price: { from: last[0] ? Number(last[0].price) : null, to: price },
          validFrom: { from: null, to: validFrom.toISOString().slice(0, 10) },
        },
      });
      return { uid: created[0]!.uid, price, validFrom: validFrom.toISOString().slice(0, 10) };
    });
  }

  async deletePartnerPrice(uid: string) {
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.$queryRaw<
        {
          id: bigint;
          company_id: bigint;
          partner_id: bigint;
          item_id: bigint;
          price: unknown;
          valid_from: Date;
          partner_uid: string;
        }[]
      >`
        SELECT pp.id, pp.company_id, pp.partner_id, pp.item_id, pp.price, pp.valid_from,
               p.uid AS partner_uid
          FROM partner_price pp JOIN partner p ON p.id = pp.partner_id
         WHERE pp.uid = ${uid}::uuid`;
      const row = rows[0];
      if (!row) throw new NotFoundException(say('Цена клиента не найдена', 'Mijoz narxi topilmadi'));
      const later = await tx.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM partner_price
         WHERE partner_id = ${row.partner_id} AND item_id = ${row.item_id}
           AND valid_from > ${row.valid_from}`;
      if (Number(later[0]?.n ?? 0) > 0) {
        throw new UnprocessableEntityException(say(
          'Это не последняя цена по позиции: история не удаляется', 'Bu pozitsiya bo‘yicha oxirgi narx emas: tarix o‘chirilmaydi'));
      }
      await tx.$executeRaw`DELETE FROM partner_price WHERE id = ${row.id}`;
      await tx.$executeRaw`
        UPDATE partner_price SET valid_to = NULL
         WHERE partner_id = ${row.partner_id} AND item_id = ${row.item_id}
           AND valid_from = (SELECT max(valid_from) FROM partner_price
                              WHERE partner_id = ${row.partner_id} AND item_id = ${row.item_id})`;
      await writeAudit(tx, {
        companyId: row.company_id,
        entityType: 'partner',
        entityId: row.partner_uid,
        action: 'price',
        changes: { price: { from: Number(row.price), to: null } },
      });
      return { uid, deleted: true };
    });
  }
}
