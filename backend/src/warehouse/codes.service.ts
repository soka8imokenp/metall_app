import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import {
  buildCode,
  parseCode,
  renderSymbol,
  type CodeKind,
  type CodeSymbol,
  type Symbology,
} from './codes.js';
import { say } from '../common/say.js';

/**
 * Штрихкоды, QR и сканер (ТЗ 5.9).
 *
 * Три обязанности одного кода: его печатают на этикетке, им ищут объект, и он
 * же приезжает со сканера в форму операции. Поэтому и печать, и разбор живут
 * в одном месте — разойдись они, этикетка напечаталась бы одним кодом,
 * а искался бы другой.
 */

export type ScanHit =
  | {
      kind: 'item';
      matchedBy: string;
      labelCode: string;
      companyUid: string;
      code: string;
      nameRu: string;
      nameUz: string;
      unit: string;
      trackBatches: boolean;
      trackSerials: boolean;
    }
  | {
      kind: 'batch';
      matchedBy: string;
      labelCode: string;
      companyUid: string;
      uid: string;
      number: string;
      itemCode: string;
      itemNameRu: string;
    }
  | {
      kind: 'serial';
      matchedBy: string;
      labelCode: string;
      companyUid: string;
      number: string;
      state: string;
      itemCode: string;
      itemNameRu: string;
    }
  | {
      kind: 'location';
      matchedBy: string;
      labelCode: string;
      companyUid: string;
      warehouseCode: string;
      warehouseNameRu: string;
      zoneCode: string;
      code: string;
    };

export type LabelRequest = { templateUid: string; codes: string[]; copies?: number };

type TemplateRow = {
  company_uid: string;
  uid: string;
  code: string;
  name_ru: string;
  name_uz: string;
  page_width_mm: string;
  page_height_mm: string;
  label_width_mm: string;
  label_height_mm: string;
  columns: number;
  rows: number;
  margin_top_mm: string;
  margin_left_mm: string;
  gap_x_mm: string;
  gap_y_mm: string;
  symbology: string;
  is_default: boolean;
};

const MAX_LABELS = 500;

@Injectable()
export class CodesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Разбор того, что принёс сканер.
   *
   * Порядок важен. Сначала наш код: он с контрольной цифрой, и совпадение
   * в нём случайным быть не может. Потом чужие штрихкоды и человеческие
   * номера — там совпадение как раз бывает, и разбирать их первыми значит
   * иногда находить не то, что наклеено.
   */
  async scan(raw: string): Promise<ScanHit> {
    const value = raw.trim();
    if (!value) throw new BadRequestException(say('пустой код', 'bo‘sh kod'));

    return this.prisma.withTenant(async (tx) => {
      const parsed = parseCode(value);
      if (parsed) {
        const hit = await this.byId(tx, parsed.kind, parsed.id, 'labelCode');
        // Код разобрался, а объекта нет: либо он чужой компании (его прячет
        // RLS), либо удалён. Разница видна только владельцу базы, и называть
        // её вслух незачем.
        if (!hit) throw new NotFoundException(say(`код ${value} не найден`, `${value} kodi topilmadi`));
        return hit;
      }

      const upper = value.toUpperCase();
      return (
        (await this.byItemBarcode(tx, value)) ??
        (await this.byLocationBarcode(tx, value)) ??
        (await this.bySerialNumber(tx, upper)) ??
        (await this.byItemCode(tx, upper)) ??
        (() => {
          throw new NotFoundException(say(`код «${value}» не распознан`, `«${value}» kodi aniqlanmadi`));
        })()
      );
    });
  }

  async templates() {
    return this.prisma.withTenant(async (tx) => ({
      rows: (await this.loadTemplates(tx, null)).map(templateOut),
    }));
  }

  private loadTemplates(tx: Tx, uid: string | null) {
    return tx.$queryRaw<TemplateRow[]>`
      SELECT co.uid AS company_uid, t.uid, t.code, t.name_ru, t.name_uz,
             t.page_width_mm, t.page_height_mm,
             t.label_width_mm, t.label_height_mm,
             t.columns, t.rows,
             t.margin_top_mm, t.margin_left_mm, t.gap_x_mm, t.gap_y_mm,
             t.symbology::text AS symbology, t.is_default
        FROM label_template t
        JOIN company co ON co.id = t.company_id
       WHERE t.is_active
         AND (${uid}::uuid IS NULL OR t.uid = ${uid}::uuid)
       ORDER BY co.code, t.is_default DESC, t.code`;
  }

  /**
   * Готовые этикетки: текст плюс уже посчитанный рисунок кода. Считает
   * сервер, а не экран, — рисунок один и тот же и на печати из браузера,
   * и в будущей выгрузке PDF, и в мобильном приложении.
   */
  async labels(body: LabelRequest) {
    const copies = body.copies ?? 1;
    if (copies < 1 || copies > 50) {
      throw new BadRequestException(say('число копий — от 1 до 50', 'nusxalar soni — 1 dan 50 gacha'));
    }
    if (body.codes.length === 0) throw new BadRequestException(say('не выбрано ни одного объекта', 'birorta obyekt tanlanmagan'));
    if (body.codes.length * copies > MAX_LABELS) {
      throw new BadRequestException(say(`столько этикеток за раз не печатаем: ${body.codes.length * copies} при пределе ${MAX_LABELS}`, `bir vaqtda bunchalik yorliq chiqarmaymiz: ${body.codes.length * copies}, cheklov ${MAX_LABELS}`));
    }

    return this.prisma.withTenant(async (tx) => {
      const template = (await this.loadTemplates(tx, body.templateUid))[0];
      if (!template) throw new NotFoundException(say('шаблон этикетки не найден', 'yorliq shabloni topilmadi'));
      const symbology = template.symbology as Symbology;

      const labels: {
        labelCode: string;
        kind: CodeKind;
        title: string;
        subtitle: string;
        lines: string[];
        symbol: CodeSymbol;
      }[] = [];

      for (const raw of body.codes) {
        const parsed = parseCode(raw);
        if (!parsed) throw new BadRequestException(say(`код «${raw}» не разобран`, `«${raw}» kodi o‘qilmadi`));
        const hit = await this.byId(tx, parsed.kind, parsed.id, 'labelCode');
        if (!hit) throw new NotFoundException(say(`код ${raw} не найден`, `${raw} kodi topilmadi`));
        const text = labelText(hit);
        const symbol = renderSymbol(symbology, hit.labelCode);
        for (let c = 0; c < copies; c += 1) {
          labels.push({ labelCode: hit.labelCode, kind: hit.kind, ...text, symbol });
        }
      }

      return { template: templateOut(template), symbology, labels };
    });
  }

  /* ---------------------------------------------------------------- */

  private async byId(
    tx: Tx,
    kind: CodeKind,
    id: bigint,
    matchedBy: string,
  ): Promise<ScanHit | null> {
    if (kind === 'item') return this.item(tx, matchedBy, { id });
    if (kind === 'batch') {
      const rows = await tx.$queryRaw<
        {
          company_uid: string;
          uid: string;
          number: string;
          item_code: string;
          item_name_ru: string;
        }[]
      >`
        SELECT co.uid AS company_uid, b.uid::text AS uid, b.number,
               i.code AS item_code, i.name_ru AS item_name_ru
          FROM batch b
          JOIN item i ON i.id = b.item_id
          JOIN company co ON co.id = b.company_id
         WHERE b.id = ${id}`;
      const r = rows[0];
      return r
        ? {
            kind: 'batch',
            matchedBy,
            labelCode: buildCode('batch', id),
            companyUid: r.company_uid,
            uid: r.uid,
            number: r.number,
            itemCode: r.item_code,
            itemNameRu: r.item_name_ru,
          }
        : null;
    }
    if (kind === 'serial') {
      const rows = await tx.$queryRaw<
        {
          company_uid: string;
          number: string;
          state: string;
          item_code: string;
          item_name_ru: string;
        }[]
      >`
        SELECT co.uid AS company_uid, sn.number, sn.current_state::text AS state,
               i.code AS item_code, i.name_ru AS item_name_ru
          FROM serial_number sn
          JOIN item i ON i.id = sn.item_id
          JOIN company co ON co.id = sn.company_id
         WHERE sn.id = ${id}`;
      const r = rows[0];
      return r
        ? {
            kind: 'serial',
            matchedBy,
            labelCode: buildCode('serial', id),
            companyUid: r.company_uid,
            number: r.number,
            state: r.state,
            itemCode: r.item_code,
            itemNameRu: r.item_name_ru,
          }
        : null;
    }
    return this.location(tx, matchedBy, { id });
  }

  /**
   * Позиция по одному из трёх ключей: наш идентификатор, код номенклатуры или
   * штрихкод поставщика. Один запрос с тремя ветками, а не три запроса:
   * ключ всегда задан ровно один, а `NULL::text IS NOT NULL` гасит остальные.
   */
  private async item(
    tx: Tx,
    matchedBy: string,
    by: { id?: bigint | null; code?: string; barcode?: string },
  ): Promise<ScanHit | null> {
    const id = by.id ?? null;
    const code = by.code ?? null;
    const barcode = by.barcode ?? null;
    const rows = await tx.$queryRaw<
      {
        id: bigint;
        company_uid: string;
        code: string;
        name_ru: string;
        name_uz: string;
        unit: string;
        track_batches: boolean;
        track_serials: boolean;
      }[]
    >`
      SELECT i.id, co.uid AS company_uid, i.code, i.name_ru, i.name_uz,
             u.code AS unit, i.track_batches, i.track_serials
        FROM item i
        JOIN company co ON co.id = i.company_id
        JOIN unit u ON u.id = i.base_unit_id
       WHERE (${id}::bigint IS NOT NULL AND i.id = ${id}::bigint)
          OR (${code}::text IS NOT NULL AND upper(i.code) = ${code}::text AND i.is_active)
          OR (${barcode}::text IS NOT NULL AND i.barcode = ${barcode}::text AND i.is_active)
       ORDER BY i.id
       LIMIT 1`;
    const r = rows[0];
    return r
      ? {
          kind: 'item',
          matchedBy,
          labelCode: buildCode('item', r.id),
          companyUid: r.company_uid,
          code: r.code,
          nameRu: r.name_ru,
          nameUz: r.name_uz,
          unit: r.unit,
          trackBatches: r.track_batches,
          trackSerials: r.track_serials,
        }
      : null;
  }

  private async location(
    tx: Tx,
    matchedBy: string,
    by: { id?: bigint | null; barcode?: string },
  ): Promise<ScanHit | null> {
    const id = by.id ?? null;
    const barcode = by.barcode ?? null;
    const rows = await tx.$queryRaw<
      {
        id: bigint;
        company_uid: string;
        warehouse_code: string;
        warehouse_name_ru: string;
        zone_code: string;
        code: string;
      }[]
    >`
      SELECT l.id, co.uid AS company_uid, w.code AS warehouse_code,
             w.name_ru AS warehouse_name_ru, z.code AS zone_code, l.code
        FROM storage_location l
        JOIN warehouse_zone z ON z.id = l.zone_id
        JOIN warehouse w ON w.id = z.warehouse_id
        JOIN company co ON co.id = w.company_id
       WHERE (${id}::bigint IS NOT NULL AND l.id = ${id}::bigint)
          OR (${barcode}::text IS NOT NULL AND l.barcode = ${barcode}::text AND l.is_active)
       ORDER BY l.id
       LIMIT 1`;
    const r = rows[0];
    return r
      ? {
          kind: 'location',
          matchedBy,
          labelCode: buildCode('location', r.id),
          companyUid: r.company_uid,
          warehouseCode: r.warehouse_code,
          warehouseNameRu: r.warehouse_name_ru,
          zoneCode: r.zone_code,
          code: r.code,
        }
      : null;
  }

  private byItemBarcode(tx: Tx, barcode: string) {
    return this.item(tx, 'itemBarcode', { barcode });
  }

  private byItemCode(tx: Tx, code: string) {
    return this.item(tx, 'itemCode', { code });
  }

  private byLocationBarcode(tx: Tx, barcode: string) {
    return this.location(tx, 'locationBarcode', { barcode });
  }

  private async bySerialNumber(tx: Tx, number: string): Promise<ScanHit | null> {
    const rows = await tx.$queryRaw<
      {
        id: bigint;
        company_uid: string;
        number: string;
        state: string;
        item_code: string;
        item_name_ru: string;
      }[]
    >`
      SELECT sn.id, co.uid AS company_uid, sn.number, sn.current_state::text AS state,
             i.code AS item_code, i.name_ru AS item_name_ru
        FROM serial_number sn
        JOIN item i ON i.id = sn.item_id
        JOIN company co ON co.id = sn.company_id
       WHERE upper(sn.number) = ${number}
       LIMIT 1`;
    const r = rows[0];
    return r
      ? {
          kind: 'serial',
          matchedBy: 'serialNumber',
          labelCode: buildCode('serial', r.id),
          companyUid: r.company_uid,
          number: r.number,
          state: r.state,
          itemCode: r.item_code,
          itemNameRu: r.item_name_ru,
        }
      : null;
  }
}

function templateOut(t: TemplateRow) {
  const mm = (v: unknown) => Number(v ?? 0);
  return {
    companyUid: t.company_uid,
    uid: t.uid,
    code: t.code,
    nameRu: t.name_ru,
    nameUz: t.name_uz,
    pageWidthMm: mm(t.page_width_mm),
    pageHeightMm: mm(t.page_height_mm),
    labelWidthMm: mm(t.label_width_mm),
    labelHeightMm: mm(t.label_height_mm),
    columns: t.columns,
    rows: t.rows,
    marginTopMm: mm(t.margin_top_mm),
    marginLeftMm: mm(t.margin_left_mm),
    gapXMm: mm(t.gap_x_mm),
    gapYMm: mm(t.gap_y_mm),
    symbology: t.symbology as Symbology,
    isDefault: t.is_default,
    perPage: t.columns * t.rows,
  };
}

/**
 * Что написать на этикетке рядом с кодом. Человеку у полки нужен не код,
 * а название: код читает сканер, а сверяет глазами человек.
 */
function labelText(hit: ScanHit): { title: string; subtitle: string; lines: string[] } {
  switch (hit.kind) {
    case 'item':
      return { title: hit.code, subtitle: hit.nameRu, lines: [`ед. изм.: ${hit.unit}`] };
    case 'batch':
      return {
        title: hit.number,
        subtitle: hit.itemNameRu,
        lines: [`позиция: ${hit.itemCode}`],
      };
    case 'serial':
      return {
        title: hit.number,
        subtitle: hit.itemNameRu,
        lines: [`позиция: ${hit.itemCode}`],
      };
    case 'location':
      return {
        title: `${hit.zoneCode}/${hit.code}`,
        subtitle: hit.warehouseNameRu,
        lines: [`склад: ${hit.warehouseCode}`],
      };
  }
}
