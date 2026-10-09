import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import type { ReportTable } from '../common/report.js';
import { say } from '../common/say.js';
import { currentContext } from '../common/request-context.js';
import { MSG } from '../common/messages.js';
import { writeAudit } from '../common/audit.js';
import { cut } from './events.js';
import { FileParseError, cellBool, cellNumber, parseCsv, parseXlsx } from './file-parse.js';

/**
 * Импорт и экспорт номенклатуры файлом (ТЗ 12) — рабочий круг обменного слоя.
 *
 * Номенклатура выбрана не случайно: это единственный справочник, который
 * придётся переносить и из 1С, и из REGOS, и именно по нему расходятся коды.
 * Круг замкнутый: выгрузили, поправили в Excel, загрузили обратно — и система
 * читает свой же файл. Это и есть проверка того, что обмен работает, а не
 * того, что у нас есть кнопка «выгрузить».
 *
 * Выгрузка идёт **тем же механизмом, что отчёты** — собирается `ReportTable`,
 * отдаётся `sendReportFile` (`common/report-file.ts`). Второй способ делать
 * таблицу означал бы, что в одном файле системы число с запятой, а в другом с
 * точкой, и чужая программа прочитает только один из них.
 *
 * Главное правило загрузки: **данные не затираются молча**. Строка с ошибкой не
 * применяется, остальные применяются, и по каждой отклонённой в протоколе
 * сказано, что с ней не так и какая это строка файла. Файл целиком из-за одной
 * опечатки не отвергается — в выгрузке из 1С опечатка будет всегда, а ждать
 * идеального файла значит не перенести справочник никогда.
 */
@Injectable()
export class ExchangeItemsFileService {
  constructor(private readonly prisma: PrismaService) {}

  /** Колонки круга. Те же имена читаются при загрузке — см. `COLUMN_KEYS`. */
  private static readonly COLUMNS = [
    { key: 'code', title: 'Код' },
    { key: 'nameRu', title: 'Наименование (ru)' },
    { key: 'nameUz', title: 'Nomi (uz)' },
    { key: 'itemType', title: 'Вид' },
    { key: 'baseUnit', title: 'Единица' },
    { key: 'vatRate', title: 'НДС, %', numeric: true },
    { key: 'minQty', title: 'Минимальный запас', numeric: true },
    { key: 'criticalQty', title: 'Критический запас', numeric: true },
    { key: 'barcode', title: 'Штрихкод' },
    { key: 'trackBatches', title: 'Учёт партий' },
    { key: 'trackSerials', title: 'Штучный учёт' },
    { key: 'isActive', title: 'В работе' },
  ] as const;

  async table(): Promise<ReportTable> {
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.$queryRawUnsafe<Record<string, any>[]>(
        `SELECT i.code, i.name_ru, i.name_uz, i.item_type::text AS item_type,
                u.code AS base_unit, i.vat_rate, i.min_qty, i.critical_qty,
                i.barcode, i.track_batches, i.track_serials, i.is_active
           FROM item i JOIN unit u ON u.id = i.base_unit_id
          WHERE i.company_id = ANY (app.current_company_ids())
          ORDER BY i.code`,
      );
      return {
        title: 'Номенклатура',
        subtitle: `Позиций: ${rows.length}. Этот же файл читается загрузкой.`,
        columns: ExchangeItemsFileService.COLUMNS.map((c) => ({
          title: c.title,
          numeric: 'numeric' in c ? c.numeric : undefined,
        })),
        rows: rows.map((r) => [
          r.code,
          r.name_ru,
          r.name_uz,
          r.item_type,
          r.base_unit,
          Number(r.vat_rate),
          Number(r.min_qty),
          Number(r.critical_qty),
          r.barcode ?? '',
          yesNo(r.track_batches),
          yesNo(r.track_serials),
          yesNo(r.is_active),
        ]),
        total: rows.length,
        truncated: false,
      };
    });
  }

  /**
   * Загрузка файла с разбором и протоколом по строкам.
   *
   * `dryRun` считает тот же протокол и не пишет ничего. Это не удобство: перед
   * тем как влить в справочник пять тысяч позиций из 1С, человек обязан иметь
   * возможность посмотреть, что из них примется, и не узнать об этом по факту.
   */
  async importFile(
    bytes: Buffer,
    opts: { fileName?: string; dryRun: boolean; systemUid?: string },
  ): Promise<ImportReport> {
    const parsed = await this.parse(bytes, opts.fileName);

    const map = new Map<string, number>();
    parsed.header.forEach((h, i) => {
      const key = COLUMN_KEYS[h];
      if (key && !map.has(key)) map.set(key, i);
    });
    for (const need of ['code', 'nameRu'] as const) {
      if (!map.has(need)) {
        throw new UnprocessableEntityException(
          say(
            `В файле нет обязательной колонки «${
              need === 'code' ? 'Код' : 'Наименование'
            }». Выгрузите образец кнопкой рядом и заполните его`,
            `Faylda majburiy «${
              need === 'code' ? 'Kod' : 'Nomi'
            }» ustuni yo‘q. Yonidagi tugma bilan namunani yuklab oling va to‘ldiring`,
          ),
        );
      }
    }
    const at = (row: string[], key: string): string => {
      const i = map.get(key);
      return i === undefined ? '' : (row[i] ?? '').trim();
    };

    const accepted: ImportLine[] = [];
    const rejected: ImportLine[] = [];
    /** Дубль внутри самого файла. Применить обе строки нельзя: какая верная? */
    const seen = new Map<string, number>();

    return this.prisma.withTenant(async (tx) => {
      const companyId = await this.companyId(tx);
      /**
       * Единица узнаётся и по коду, и по названию. Выгрузка пишет код (`pcs`),
       * а файл из чужой программы придёт с «шт» — и отбивать из-за этого
       * каждую строку значило бы, что импорт работает только с нашим же файлом.
       * Ключ приведён к нижнему регистру: в Excel «ШТ» встречается не реже.
       */
      const units = new Map<string, string>();
      for (const u of await tx.$queryRawUnsafe<
        { code: string; name_ru: string; name_uz: string }[]
      >(`SELECT code, name_ru, name_uz FROM unit`)) {
        for (const alias of [u.code, u.name_ru, u.name_uz]) {
          const key = alias?.trim().toLowerCase();
          if (key && !units.has(key)) units.set(key, u.code);
        }
      }

      for (let i = 0; i < parsed.rows.length; i += 1) {
        // Номер строки файла, а не массива: человек ищет её в Excel, где шапка
        // занимает первую строку.
        const lineNo = i + 2;
        const row = parsed.rows[i]!;
        const code = at(row, 'code');
        const nameRu = at(row, 'nameRu');

        const reject = (reasonRu: string, reasonUz: string) => {
          rejected.push({ line: lineNo, code, reasonRu, reasonUz });
        };

        if (!code) {
          reject('нет кода позиции', 'pozitsiya kodi yo‘q');
          continue;
        }
        if (!nameRu) {
          reject('нет наименования', 'nomi yo‘q');
          continue;
        }
        const was = seen.get(code);
        if (was !== undefined) {
          reject(
            `код «${code}» уже встречался в строке ${was}`,
            `«${code}» kodi ${was}-satrda allaqachon uchragan`,
          );
          continue;
        }

        const unitRaw = at(row, 'baseUnit');
        // Дальше в запросы идёт код из справочника, а не то, что было в файле:
        // в базе `base_unit_id` ищется по коду.
        const unit = unitRaw ? (units.get(unitRaw.toLowerCase()) ?? '') : '';
        if (unitRaw && !unit) {
          reject(
            `единица «${unitRaw}» в справочнике не числится`,
            `«${unitRaw}» birligi ma’lumotnomada yo‘q`,
          );
          continue;
        }
        const itemType = at(row, 'itemType');
        if (itemType && !ITEM_TYPES.includes(itemType)) {
          reject(
            `вид «${itemType}» не из перечня: ${ITEM_TYPES.join(', ')}`,
            `«${itemType}» turi ro‘yxatda yo‘q: ${ITEM_TYPES.join(', ')}`,
          );
          continue;
        }

        const minQty = cellNumber(at(row, 'minQty'));
        const criticalQty = cellNumber(at(row, 'criticalQty'));
        const vatRate = cellNumber(at(row, 'vatRate'));
        if (at(row, 'minQty') && minQty === null) {
          reject('минимальный запас — не число', 'eng kam zaxira — raqam emas');
          continue;
        }
        if (at(row, 'criticalQty') && criticalQty === null) {
          reject('критический запас — не число', 'tanqidiy zaxira — raqam emas');
          continue;
        }
        if (minQty !== null && minQty < 0) {
          reject('минимальный запас отрицательный', 'eng kam zaxira manfiy');
          continue;
        }

        const existing = await tx.$queryRawUnsafe<Record<string, any>[]>(
          `SELECT i.id, i.min_qty, i.critical_qty, u.code AS base_unit,
                  (SELECT count(*) FROM stock_move m WHERE m.item_id = i.id) AS moves
             FROM item i JOIN unit u ON u.id = i.base_unit_id
            WHERE i.company_id = $1 AND i.code = $2`,
          companyId,
          code,
        );
        const had = existing[0] ?? null;

        /**
         * Уровни сверяются с тем, что получится в итоге, а не с тем, что в
         * файле: в файле может стоять только критический, а минимальный уже
         * лежит в базе — и проверять надо их пару.
         */
        const finalMin = minQty ?? (had ? Number(had.min_qty) : 0);
        const finalCrit = criticalQty ?? (had ? Number(had.critical_qty) : 0);
        if (finalCrit > 0 && finalMin > 0 && finalCrit > finalMin) {
          reject(
            `критический запас ${finalCrit} выше минимального ${finalMin}`,
            `tanqidiy zaxira ${finalCrit} eng kam ${finalMin} dan yuqori`,
          );
          continue;
        }

        if (!had && !unit) {
          reject(
            'новой позиции нужна единица измерения',
            'yangi pozitsiyaga o‘lchov birligi kerak',
          );
          continue;
        }

        seen.set(code, lineNo);
        accepted.push({
          line: lineNo,
          code,
          reasonRu: had ? 'обновлено' : 'заведено',
          reasonUz: had ? 'yangilandi' : 'yaratildi',
        });

        if (opts.dryRun) continue;

        if (had) {
          await tx.$queryRawUnsafe(
            `UPDATE item
                SET name_ru = $2,
                    name_uz = coalesce($3, name_uz),
                    item_type = coalesce($4::"ItemType", item_type),
                    base_unit_id = CASE
                      WHEN $5::text IS NULL THEN base_unit_id
                      ELSE (SELECT id FROM unit WHERE code = $5::text) END,
                    vat_rate = coalesce($6::numeric, vat_rate),
                    min_qty = coalesce($7::numeric, min_qty),
                    critical_qty = coalesce($8::numeric, critical_qty),
                    barcode = coalesce($9, barcode),
                    track_batches = coalesce($10::boolean, track_batches),
                    track_serials = coalesce($11::boolean, track_serials),
                    is_active = coalesce($12::boolean, is_active),
                    version = version + 1
              WHERE id = $1`,
            had.id,
            nameRu,
            at(row, 'nameUz') || null,
            itemType || null,
            // Единицу у позиции с движениями не меняем: по ней уже посчитаны
            // остатки, и смена «т» на «шт» переписала бы склад задним числом.
            unit && Number(had.moves) === 0 && unit !== had.base_unit ? unit : null,
            vatRate,
            minQty,
            criticalQty,
            at(row, 'barcode') || null,
            cellBool(at(row, 'trackBatches')),
            cellBool(at(row, 'trackSerials')),
            cellBool(at(row, 'isActive')),
          );
        } else {
          await tx.$queryRawUnsafe(
            `INSERT INTO item (uid, company_id, code, name_ru, name_uz, item_type,
                               base_unit_id, vat_rate, track_batches, track_serials,
                               min_qty, critical_qty, barcode, is_active)
             VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::"ItemType",
                     (SELECT id FROM unit WHERE code = $6), $7, $8, $9, $10, $11, $12, $13)`,
            companyId,
            code,
            nameRu,
            at(row, 'nameUz') || nameRu,
            itemType || 'goods',
            unit,
            vatRate ?? 12,
            cellBool(at(row, 'trackBatches')) ?? false,
            cellBool(at(row, 'trackSerials')) ?? false,
            minQty ?? 0,
            criticalQty ?? 0,
            at(row, 'barcode') || null,
            cellBool(at(row, 'isActive')) ?? true,
          );
        }
      }

      const report: ImportReport = {
        fileName: opts.fileName ?? null,
        dryRun: opts.dryRun,
        total: parsed.rows.length,
        acceptedCount: accepted.length,
        rejectedCount: rejected.length,
        accepted,
        rejected,
      };

      /**
       * Загрузка — это обмен, и в журнале обменов она обязана быть: иначе на
       * вопрос «кто влил в справочник эти пятьсот позиций» ответа нет. Строка
       * пишется той же транзакцией, что и сами позиции.
       */
      if (!opts.dryRun) {
        const systemId = await this.systemId(tx, opts.systemUid, companyId);
        if (systemId !== null) {
          await tx.$queryRawUnsafe(
            `INSERT INTO exchange_message
               (company_id, system_id, direction, event, status, request_body,
                response_body, processed_at)
             VALUES ($1, $2, 'in', 'import.item',
                     CASE WHEN $3::int > 0 THEN 'failed' ELSE 'done' END,
                     $4, $5, now())`,
            companyId,
            systemId,
            rejected.length,
            cut(`файл: ${opts.fileName ?? 'без имени'}, строк ${parsed.rows.length}`),
            cut(JSON.stringify({ accepted: accepted.length, rejected })),
          );
        }
        await writeAudit(tx, {
          companyId,
          entityType: 'item',
          entityId: 'import',
          action: 'import',
          source: 'integration',
          changes: {
            file: { from: null, to: opts.fileName ?? 'без имени' },
            accepted: { from: null, to: accepted.length },
            rejected: { from: null, to: rejected.length },
          },
        });
      }
      return report;
    });
  }

  private async parse(bytes: Buffer, fileName: string | undefined) {
    const xlsx = (fileName ?? '').toLowerCase().endsWith('.xlsx') || isZip(bytes);
    try {
      return xlsx ? await parseXlsx(bytes) : parseCsv(bytes.toString('utf8'));
    } catch (e) {
      if (e instanceof FileParseError) {
        throw new UnprocessableEntityException(
          say(`Файл не разобран: ${e.message}`, `Fayl o‘qilmadi: ${e.message}`),
        );
      }
      throw e;
    }
  }

  /**
   * Чьим обменом считать загрузку. Подключение указано — его; не указано —
   * берётся единственное в компании. Нет ни одного — строки журнала обменов не
   * будет, и это честнее, чем заводить подключение «файл» самим: подключений в
   * справочнике ровно столько, сколько их завёл человек.
   */
  private async systemId(
    tx: Tx,
    systemUid: string | undefined,
    companyId: bigint,
  ): Promise<bigint | null> {
    if (systemUid) {
      const rows = await tx.$queryRawUnsafe<{ id: bigint }[]>(
        // Компания названа прямо: RLS на `external_system` нет намеренно
        // (миграция 20261006190000_exchange_rls_fix), а подписать загрузку
        // чужим подключением нельзя.
        `SELECT id FROM external_system WHERE uid = $1::uuid AND company_id = $2`,
        systemUid,
        companyId,
      );
      return rows[0]?.id ?? null;
    }
    const rows = await tx.$queryRawUnsafe<{ id: bigint }[]>(
      `SELECT id FROM external_system WHERE company_id = $1 ORDER BY id LIMIT 2`,
      companyId,
    );
    return rows.length === 1 ? rows[0]!.id : null;
  }

  private async companyId(tx: Tx): Promise<bigint> {
    const ids = currentContext()?.companyIds ?? [];
    if (ids.length === 0) throw new UnprocessableEntityException(MSG.noCompany());
    if (ids.length > 1) {
      // Файл не говорит, чья это номенклатура, и угадывать нельзя: позиции
      // ушли бы в чужую компанию, а разрез по компаниям — это требование ТЗ.
      throw new UnprocessableEntityException(
        say(
          'Выбраны обе компании: переключитесь на одну, прежде чем загружать номенклатуру',
          'Ikkala kompaniya tanlangan: nomenklaturani yuklashdan oldin bittasiga o‘ting',
        ),
      );
    }
    return ids[0]!;
  }
}

const ITEM_TYPES: string[] = ['raw', 'goods', 'component', 'semi', 'finished'];

/**
 * Имена колонок, которые читаются при загрузке. Русские — те же, что пишет
 * выгрузка (круг должен замыкаться), узбекские и машинные — потому что файл
 * может прийти из чужой программы и из узбекского интерфейса.
 */
const COLUMN_KEYS: Record<string, string> = {
  'код': 'code',
  'kod': 'code',
  'code': 'code',
  'наименование (ru)': 'nameRu',
  'наименование': 'nameRu',
  'название': 'nameRu',
  'nomi (uz)': 'nameUz',
  'nomi': 'nameRu',
  'name_ru': 'nameRu',
  'name_uz': 'nameUz',
  'наименование (uz)': 'nameUz',
  'вид': 'itemType',
  'turi': 'itemType',
  'item_type': 'itemType',
  'единица': 'baseUnit',
  'birlik': 'baseUnit',
  'unit': 'baseUnit',
  'ед.': 'baseUnit',
  'ндс, %': 'vatRate',
  'ндс': 'vatRate',
  'qqs, %': 'vatRate',
  'vat_rate': 'vatRate',
  'минимальный запас': 'minQty',
  'eng kam zaxira': 'minQty',
  'min_qty': 'minQty',
  'критический запас': 'criticalQty',
  'tanqidiy zaxira': 'criticalQty',
  'critical_qty': 'criticalQty',
  'штрихкод': 'barcode',
  'shtrix-kod': 'barcode',
  'barcode': 'barcode',
  'учёт партий': 'trackBatches',
  'учет партий': 'trackBatches',
  'partiya hisobi': 'trackBatches',
  'track_batches': 'trackBatches',
  'штучный учёт': 'trackSerials',
  'штучный учет': 'trackSerials',
  'donalab hisob': 'trackSerials',
  'track_serials': 'trackSerials',
  'в работе': 'isActive',
  'ishda': 'isActive',
  'is_active': 'isActive',
};

/** Выгрузка пишет «да/нет» — значит и читать надо то же. */
const yesNo = (v: boolean) => (v ? 'да' : 'нет');

/** Признак zip: `PK\x03\x04`. По нему xlsx узнаётся без имени файла. */
const isZip = (b: Buffer) =>
  b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

export interface ImportLine {
  line: number;
  code: string;
  reasonRu: string;
  reasonUz: string;
}

export interface ImportReport {
  fileName: string | null;
  dryRun: boolean;
  total: number;
  acceptedCount: number;
  rejectedCount: number;
  accepted: ImportLine[];
  rejected: ImportLine[];
}
