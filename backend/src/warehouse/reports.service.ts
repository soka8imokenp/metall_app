import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import type { CellValue } from '../common/xlsx.js';
import type { ReportTable } from '../common/report.js';
import { say } from '../common/say.js';
import { nameCol } from '../common/name.js';

/** Отчёты склада из ТЗ 5.1. Порядок — как в самом списке. */
export const REPORT_KINDS = [
  'stock',
  'moves',
  'availability',
  'turnover',
  'inventory-diff',
] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

/** Форма отчёта общая на все модули — `common/report.ts`. */
export type { ReportColumn } from '../common/report.js';

export interface Report extends ReportTable {
  kind: ReportKind;
}

/**
 * Подписи операций и состояний собираются на языке запроса, поэтому это
 * функции, а не константы: константа посчиталась бы один раз при загрузке
 * модуля — вне запроса и всегда по-русски.
 */
const operation = (): Record<string, string> => ({
  receipt: say('Приход', 'Kirim'),
  transfer: say('Перемещение', 'Ko‘chirish'),
  issue_to_production: say('Выдача в цех', 'Sexga berish'),
  return_from_production: say('Возврат из цеха', 'Sexdan qaytarish'),
  shipment: say('Отгрузка', 'Yuklash'),
  return_from_client: say('Возврат от клиента', 'Mijozdan qaytarish'),
  write_off: say('Списание', 'Chiqim'),
  surplus: say('Оприходование излишка', 'Ortiqchani kirim qilish'),
  output: say('Выпуск из цеха', 'Sexdan chiqarish'),
});

const sheetStatus = (): Record<string, string> => ({
  draft: say('Черновик', 'Qoralama'),
  counting: say('Считают', 'Sanab chiqilmoqda'),
  review: say('На утверждении', 'Tasdiqlashda'),
  approved: say('Утверждён', 'Tasdiqlangan'),
  cancelled: say('Отменён', 'Bekor qilingan'),
});

const num = (v: unknown) => Number(v ?? 0);

/**
 * Часовой пояс учёта. Время в базе хранится в UTC, а человек спрашивает
 * «с 1 по 30 сентября» по своему календарю: границы периода и подписи времени
 * строит Postgres через `AT TIME ZONE`, а не JavaScript по часовому поясу
 * процесса. Тот же приём, что в журнале движений.
 */
const TZ = 'Asia/Tashkent';

/** Сегодняшняя дата в часовом поясе учёта, а не в поясе процесса. */
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());

/** Сдвиг календарной даты на дни. Строка, а не Date: время тут ни при чём. */
function shiftDays(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Отчёты склада и выгрузка (ТЗ 5.1).
 *
 * Отчёт здесь — это таблица: заголовки колонок и строки значений. Ни экран, ни
 * выгрузка не решают, что в какой колонке: иначе в Excel уезжает одно, а на
 * экране показано другое, и спорить об этом придётся с клиентом.
 *
 * Числа в строках — числа, а не подписанные строки. Из-за этого в Excel по
 * колонке берётся сумма, а на экране число можно отформатировать по локали.
 * Формат («313,4 т») собирается там, где показывают, и только там.
 *
 * Периода нет только у остатков и доступности: они отвечают на вопрос «что
 * сейчас», и «остаток за март» — вопрос без смысла. У движений, оборачиваемости
 * и расхождений период есть, и по умолчанию это последние 30 дней.
 */
@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async build(params: {
    kind: ReportKind;
    warehouseUid?: string;
    from?: string;
    to?: string;
    limit: number;
  }): Promise<Report> {
    const period = this.period(params.from, params.to);

    return this.prisma.withTenant(async (tx) => {
      const where = await this.scope(tx, params.warehouseUid);

      switch (params.kind) {
        case 'stock':
          return this.stock(tx, params, where);
        case 'moves':
          return this.moves(tx, params, where, period);
        case 'availability':
          return this.availability(tx, params, where);
        case 'turnover':
          return this.turnover(tx, params, where, period);
        case 'inventory-diff':
          return this.inventoryDiff(tx, params, where, period);
      }
    });
  }

  /**
   * Период отчёта. Границы — календарные дни в местном времени: человек
   * спрашивает «с 1 по 30 сентября», а не «с полуночи UTC».
   */
  private period(from?: string, to?: string) {
    const end = to ?? today();
    const start = from ?? shiftDays(end, -30);
    if (!DAY.test(start) || !DAY.test(end)) {
      throw new UnprocessableEntityException(
        say('Период отчёта: даты в формате ГГГГ-ММ-ДД', 'Hisobot davri: sanalar YYYY-MM-DD ko‘rinishida'),
      );
    }
    // Даты в ISO сравниваются как строки: разбирать их в Date ради сравнения
    // значит снова зависеть от часового пояса процесса.
    if (start > end) {
      throw new UnprocessableEntityException(
        say('Период отчёта: дата «с» позже даты «по»', 'Hisobot davri: «dan» sanasi «gacha» sanasidan keyin'),
      );
    }
    const days =
      Math.round(
        (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000,
      ) + 1;
    return { start, end, days, text: `${start} — ${end}` };
  }

  /**
   * Выбранный склад. Проверяем его существование сразу: иначе пустой отчёт по
   * опечатке в uid выглядит как «на складе ничего нет».
   */
  private async scope(tx: Tx, warehouseUid?: string) {
    if (!warehouseUid) return { id: null as bigint | null, text: say('все склады', 'barcha omborlar') };
    const rows = await tx.$queryRaw<{ id: bigint; name: string }[]>`
      SELECT id, ${nameCol('warehouse')} AS name FROM warehouse WHERE uid = ${warehouseUid}::uuid`;
    if (!rows[0]) throw new UnprocessableEntityException(say('Склад не найден', 'Ombor topilmadi'));
    return { id: rows[0].id, text: rows[0].name };
  }

  private cut<T>(rows: T[], limit: number) {
    return { rows: rows.slice(0, limit), total: rows.length, truncated: rows.length > limit };
  }

  /** Остатки: что и где лежит сейчас. */
  private async stock(
    tx: Tx,
    params: { limit: number },
    where: { id: bigint | null; text: string },
  ): Promise<Report> {
    const rows = await tx.$queryRaw<Record<string, string | null>[]>`
      SELECT ${nameCol('w')} AS warehouse, z.code AS zone, l.code AS location,
             i.code AS item_code, ${nameCol('i')} AS item_name, u.code AS unit,
             bt.number AS batch, sn.number AS serial,
             b.qty_on_hand::text, b.qty_reserved::text, b.qty_available::text,
             b.unit_cost::text, (b.qty_on_hand * b.unit_cost)::text AS value
        FROM stock_balance b
        JOIN item i      ON i.id = b.item_id
        JOIN unit u      ON u.id = i.base_unit_id
        JOIN warehouse w ON w.id = b.warehouse_id
        LEFT JOIN storage_location l ON l.id = b.location_id
        LEFT JOIN warehouse_zone z   ON z.id = l.zone_id
        LEFT JOIN batch bt           ON bt.id = b.batch_id
        LEFT JOIN serial_number sn   ON sn.id = b.serial_id
       WHERE b.qty_on_hand > 0
         AND (${where.id}::bigint IS NULL OR b.warehouse_id = ${where.id}::bigint)
       ORDER BY w.code, i.code, bt.number NULLS FIRST, z.code NULLS FIRST, l.code NULLS FIRST`;

    const cut = this.cut(rows, params.limit);
    return {
      kind: 'stock',
      title: say('Остатки', 'Qoldiqlar'),
      subtitle: `${where.text}, ${say('строк', 'qatorlar')} ${cut.total}`,
      columns: [
        { title: say('Склад', 'Ombor'), width: 28 },
        { title: say('Зона', 'Zona'), width: 8 },
        { title: say('Ячейка', 'Yacheyka'), width: 10 },
        { title: say('Код', 'Kod'), width: 16 },
        { title: say('Номенклатура', 'Nomenklatura'), width: 44 },
        { title: say('Партия', 'Partiya'), width: 12 },
        { title: say('Серийный номер', 'Seriya raqami'), width: 18 },
        { title: say('Ед.', 'Birlik'), width: 6 },
        { title: say('Наличие', 'Qoldiq'), numeric: true, width: 14 },
        { title: say('Резерв', 'Zaxira'), numeric: true, width: 14 },
        { title: say('Доступно', 'Mavjud'), numeric: true, width: 14 },
        { title: say('Себестоимость', 'Tannarx'), numeric: true, width: 16 },
        { title: say('Стоимость', 'Qiymati'), numeric: true, width: 18 },
      ],
      rows: cut.rows.map((r) => [
        r.warehouse,
        r.zone,
        r.location,
        r.item_code,
        r.item_name,
        r.batch,
        r.serial,
        r.unit,
        num(r.qty_on_hand),
        num(r.qty_reserved),
        num(r.qty_available),
        num(r.unit_cost),
        num(r.value),
      ]),
      total: cut.total,
      truncated: cut.truncated,
    };
  }

  /** Движение за период: журнал целиком, а не первая его страница. */
  private async moves(
    tx: Tx,
    params: { limit: number },
    where: { id: bigint | null; text: string },
    period: { start: string; end: string; text: string },
  ): Promise<Report> {
    const rows = await tx.$queryRaw<Record<string, string | null>[]>`
      SELECT m.moved_at, m.operation_type::text AS operation,
             i.code AS item_code, ${nameCol('i')} AS item_name, u.code AS unit,
             bt.number AS batch, sn.number AS serial,
             to_char(m.moved_at AT TIME ZONE ${TZ}, 'YYYY-MM-DD HH24:MI') AS moved_at_local,
             m.qty_base::text, m.cost_total::text,
             ${nameCol('fw')} AS from_warehouse, ${nameCol('tw')} AS to_warehouse,
             ${nameCol('p')} AS partner, m.source_doc_type, ua.full_name AS author,
             m.comment, (m.reversal_of_id IS NOT NULL) AS is_reversal
        FROM stock_move m
        JOIN item i ON i.id = m.item_id
        JOIN unit u ON u.id = i.base_unit_id
        LEFT JOIN batch bt         ON bt.id = m.batch_id
        LEFT JOIN serial_number sn ON sn.id = m.serial_id
        LEFT JOIN warehouse fw     ON fw.id = m.from_warehouse_id
        LEFT JOIN warehouse tw     ON tw.id = m.to_warehouse_id
        LEFT JOIN partner p        ON p.id = m.partner_id
        LEFT JOIN user_account ua  ON ua.id = m.created_by
       WHERE m.moved_at >= (${period.start}::date::timestamp AT TIME ZONE ${TZ})
         AND m.moved_at < ((${period.end}::date + 1)::timestamp AT TIME ZONE ${TZ})
         AND (${where.id}::bigint IS NULL
              OR m.from_warehouse_id = ${where.id}::bigint
              OR m.to_warehouse_id = ${where.id}::bigint)
       ORDER BY m.moved_at DESC, m.id DESC`;

    const cut = this.cut(rows, params.limit);
    return {
      kind: 'moves',
      title: say('Движение', 'Harakatlar'),
      subtitle: `${where.text}, ${period.text}, ${say('движений', 'harakatlar')} ${cut.total}`,
      columns: [
        { title: say('Дата', 'Sana'), width: 18 },
        { title: say('Операция', 'Operatsiya'), width: 22 },
        { title: say('Код', 'Kod'), width: 16 },
        { title: say('Номенклатура', 'Nomenklatura'), width: 44 },
        { title: say('Партия', 'Partiya'), width: 12 },
        { title: say('Серийный номер', 'Seriya raqami'), width: 18 },
        { title: say('Ед.', 'Birlik'), width: 6 },
        { title: say('Количество', 'Miqdor'), numeric: true, width: 14 },
        { title: say('Откуда', 'Qayerdan'), width: 26 },
        { title: say('Куда', 'Qayerga'), width: 26 },
        { title: say('Себестоимость', 'Tannarx'), numeric: true, width: 18 },
        { title: say('Документ', 'Hujjat'), width: 14 },
        { title: say('Контрагент', 'Kontragent'), width: 30 },
        { title: say('Автор', 'Kim yozdi'), width: 26 },
        { title: say('Примечание', 'Izoh'), width: 40 },
      ],
      rows: cut.rows.map((r) => [
        r.moved_at_local,
        // Сторно называем сторно: в отчёте две одинаковые строки с разным
        // знаком иначе читаются как двойной ввод.
        r.is_reversal
          ? `${operation()[r.operation!] ?? r.operation} ${say('(сторно)', '(storno)')}`
          : (operation()[r.operation!] ?? r.operation),
        r.item_code,
        r.item_name,
        r.batch,
        r.serial,
        r.unit,
        num(r.qty_base),
        r.from_warehouse,
        r.to_warehouse,
        num(r.cost_total),
        r.source_doc_type,
        r.partner,
        r.author,
        r.comment,
      ]),
      total: cut.total,
      truncated: cut.truncated,
    };
  }

  /**
   * Доступное и зарезервированное по позиции и складу (ТЗ 5.1).
   *
   * Обещанное берём из резервов, а не из `qty_reserved`: остаток обрезан
   * наличием, и резерв сверх наличия в нём выглядел бы как его отсутствие.
   * Поэтому доступное здесь бывает отрицательным — и это не ошибка отчёта,
   * а ровно та строка, из-за которой встанет отгрузка.
   */
  private async availability(
    tx: Tx,
    params: { limit: number },
    where: { id: bigint | null; text: string },
  ): Promise<Report> {
    const rows = await tx.$queryRaw<Record<string, string | null>[]>`
      WITH stock AS (
        SELECT item_id, warehouse_id,
               sum(qty_on_hand) AS on_hand,
               sum(qty_on_hand * unit_cost) AS value
          FROM stock_balance GROUP BY item_id, warehouse_id),
      held AS (
        SELECT item_id, warehouse_id, sum(qty) AS promised
          FROM stock_reservation
         WHERE status = 'active' AND (expires_at IS NULL OR expires_at > now())
         GROUP BY item_id, warehouse_id)
      SELECT ${nameCol('w')} AS warehouse, i.code AS item_code, ${nameCol('i')} AS item_name,
             u.code AS unit,
             coalesce(s.on_hand, 0)::text AS on_hand,
             coalesce(h.promised, 0)::text AS promised,
             (coalesce(s.on_hand, 0) - coalesce(h.promised, 0))::text AS available,
             coalesce(s.value, 0)::text AS value
        FROM stock s
        FULL JOIN held h ON h.item_id = s.item_id AND h.warehouse_id = s.warehouse_id
        JOIN item i      ON i.id = coalesce(s.item_id, h.item_id)
        JOIN unit u      ON u.id = i.base_unit_id
        JOIN warehouse w ON w.id = coalesce(s.warehouse_id, h.warehouse_id)
       WHERE (coalesce(s.on_hand, 0) <> 0 OR coalesce(h.promised, 0) <> 0)
         AND (${where.id}::bigint IS NULL
              OR coalesce(s.warehouse_id, h.warehouse_id) = ${where.id}::bigint)
       ORDER BY w.code, i.code`;

    const cut = this.cut(rows, params.limit);
    return {
      kind: 'availability',
      title: say('Доступное и зарезервированное', 'Mavjud va zaxiradagi'),
      subtitle: `${where.text}, ${say('позиций', 'pozitsiyalar')} ${cut.total}`,
      columns: [
        { title: say('Склад', 'Ombor'), width: 28 },
        { title: say('Код', 'Kod'), width: 16 },
        { title: say('Номенклатура', 'Nomenklatura'), width: 44 },
        { title: say('Ед.', 'Birlik'), width: 6 },
        { title: say('Наличие', 'Qoldiq'), numeric: true, width: 14 },
        { title: say('Обещано', 'Va’da qilingan'), numeric: true, width: 14 },
        { title: say('Доступно', 'Mavjud'), numeric: true, width: 14 },
        { title: say('Стоимость запаса', 'Zaxira qiymati'), numeric: true, width: 20 },
      ],
      rows: cut.rows.map((r) => [
        r.warehouse,
        r.item_code,
        r.item_name,
        r.unit,
        num(r.on_hand),
        num(r.promised),
        num(r.available),
        num(r.value),
      ]),
      total: cut.total,
      truncated: cut.truncated,
    };
  }

  /**
   * Оборачиваемость за период.
   *
   * Остаток на конец периода не берётся из `stock_balance` как есть: там
   * лежит «сейчас», а период может кончаться вчера. Остаток — свёртка журнала,
   * поэтому конец периода восстанавливается из неё же: текущее наличие минус
   * всё, что пришло после `to`, плюс всё, что после `to` ушло.
   *
   * Перемещения между складами в оборот не входят: товар остался в компании,
   * и считать его расходом значит удвоить оборот на каждой перекладке.
   *
   * Отчёт по компании, а не по складу: оборачиваемость складской полки —
   * другой вопрос, и фильтр склада здесь только сузил бы движения, оставив
   * остаток общим. Поэтому выбранный склад к этому отчёту не применяется.
   */
  private async turnover(
    tx: Tx,
    params: { limit: number },
    where: { text: string },
    period: { start: string; end: string; days: number; text: string },
  ): Promise<Report> {
    const rows = await tx.$queryRaw<Record<string, string | null>[]>`
      WITH now_stock AS (
        SELECT item_id, sum(qty_on_hand) AS on_hand FROM stock_balance GROUP BY item_id),
      after AS (
        SELECT item_id,
               sum(CASE WHEN to_warehouse_id IS NOT NULL AND from_warehouse_id IS NULL
                        THEN qty_base ELSE 0 END) AS came,
               sum(CASE WHEN from_warehouse_id IS NOT NULL AND to_warehouse_id IS NULL
                        THEN qty_base ELSE 0 END) AS went
          FROM stock_move
         WHERE moved_at >= ((${period.end}::date + 1)::timestamp AT TIME ZONE ${TZ})
         GROUP BY item_id),
      inside AS (
        SELECT item_id,
               sum(CASE WHEN to_warehouse_id IS NOT NULL AND from_warehouse_id IS NULL
                        THEN qty_base ELSE 0 END) AS came,
               sum(CASE WHEN from_warehouse_id IS NOT NULL AND to_warehouse_id IS NULL
                        THEN qty_base ELSE 0 END) AS went
          FROM stock_move
         WHERE moved_at >= (${period.start}::date::timestamp AT TIME ZONE ${TZ})
           AND moved_at < ((${period.end}::date + 1)::timestamp AT TIME ZONE ${TZ})
         GROUP BY item_id)
      SELECT i.code AS item_code, ${nameCol('i')} AS item_name, u.code AS unit,
             (coalesce(n.on_hand, 0) - coalesce(a.came, 0) + coalesce(a.went, 0))::text AS at_end,
             coalesce(d.came, 0)::text AS came,
             coalesce(d.went, 0)::text AS went
        FROM item i
        JOIN unit u ON u.id = i.base_unit_id
        LEFT JOIN now_stock n ON n.item_id = i.id
        LEFT JOIN after a     ON a.item_id = i.id
        LEFT JOIN inside d    ON d.item_id = i.id
       WHERE i.is_active AND i.archived_at IS NULL
         AND (coalesce(n.on_hand, 0) <> 0 OR coalesce(d.came, 0) <> 0 OR coalesce(d.went, 0) <> 0)
       ORDER BY i.code`;

    const mapped = rows.map((r) => {
      const atEnd = num(r.at_end);
      const came = num(r.came);
      const went = num(r.went);
      const atStart = atEnd - came + went;
      const average = (atStart + atEnd) / 2;
      // Оборачиваемость при нулевом среднем остатке не считается: делить не на
      // что, и ноль тут соврал бы — товар-то двигался.
      const turns = average > 0 ? went / average : null;
      const days = went > 0 && average > 0 ? (period.days * average) / went : null;
      return [
        r.item_code,
        r.item_name,
        r.unit,
        round6(atStart),
        round6(came),
        round6(went),
        round6(atEnd),
        round6(average),
        turns === null ? null : Math.round(turns * 100) / 100,
        days === null ? null : Math.round(days),
      ] as CellValue[];
    });

    const cut = this.cut(mapped, params.limit);
    return {
      kind: 'turnover',
      title: say('Оборачиваемость', 'Aylanma'),
      subtitle:
        `${say('по компании', 'kompaniya bo‘yicha')}, ${period.text}, ` +
        `${say('дней', 'kunlar')} ${period.days}, ${say('позиций', 'pozitsiyalar')} ${cut.total}`,
      columns: [
        { title: say('Код', 'Kod'), width: 16 },
        { title: say('Номенклатура', 'Nomenklatura'), width: 44 },
        { title: say('Ед.', 'Birlik'), width: 6 },
        { title: say('Остаток на начало', 'Boshidagi qoldiq'), numeric: true, width: 18 },
        { title: say('Приход', 'Kirim'), numeric: true, width: 14 },
        { title: say('Расход', 'Chiqim'), numeric: true, width: 14 },
        { title: say('Остаток на конец', 'Oxiridagi qoldiq'), numeric: true, width: 18 },
        { title: say('Средний остаток', 'O‘rtacha qoldiq'), numeric: true, width: 18 },
        { title: say('Оборотов за период', 'Davr aylanmasi'), numeric: true, width: 20 },
        { title: say('Дней запаса', 'Zaxira kunlari'), numeric: true, width: 14 },
      ],
      rows: cut.rows,
      total: cut.total,
      truncated: cut.truncated,
    };
  }

  /**
   * Расхождения инвентаризации (ТЗ 5.1, 5.8).
   *
   * Только строки, где посчитанное разошлось с учётом: лист на восемьдесят
   * строк с двумя расхождениями читают ради этих двух. Отменённые листы не
   * берём — по ним ничего не решали.
   */
  private async inventoryDiff(
    tx: Tx,
    params: { limit: number },
    where: { id: bigint | null; text: string },
    period: { start: string; end: string; text: string },
  ): Promise<Report> {
    const rows = await tx.$queryRaw<Record<string, string | null>[]>`
      SELECT s.number AS sheet, s.status::text AS status,
             to_char(coalesce(s.approved_at, s.counted_at, s.created_at) AT TIME ZONE ${TZ},
                     'YYYY-MM-DD') AS happened_on,
             ${nameCol('w')} AS warehouse, z.code AS zone, l.code AS location,
             i.code AS item_code, ${nameCol('i')} AS item_name, u.code AS unit,
             bt.number AS batch, sn.number AS serial,
             ln.qty_expected::text, ln.qty_counted::text, ln.qty_diff::text,
             ln.unit_cost::text, (ln.qty_diff * ln.unit_cost)::text AS diff_value,
             ua.full_name AS author
        FROM inventory_sheet_line ln
        JOIN inventory_sheet s ON s.id = ln.sheet_id
        JOIN item i      ON i.id = ln.item_id
        JOIN unit u      ON u.id = i.base_unit_id
        JOIN warehouse w ON w.id = s.warehouse_id
        LEFT JOIN storage_location l ON l.id = ln.location_id
        LEFT JOIN warehouse_zone z   ON z.id = l.zone_id
        LEFT JOIN batch bt           ON bt.id = ln.batch_id
        LEFT JOIN serial_number sn   ON sn.id = ln.serial_id
        LEFT JOIN user_account ua    ON ua.id = s.created_by
       WHERE ln.qty_diff IS NOT NULL AND ln.qty_diff <> 0
         AND s.status <> 'cancelled'
         AND coalesce(s.approved_at, s.counted_at, s.created_at)
               >= (${period.start}::date::timestamp AT TIME ZONE ${TZ})
         AND coalesce(s.approved_at, s.counted_at, s.created_at)
               < ((${period.end}::date + 1)::timestamp AT TIME ZONE ${TZ})
         AND (${where.id}::bigint IS NULL OR s.warehouse_id = ${where.id}::bigint)
       ORDER BY coalesce(s.approved_at, s.counted_at, s.created_at) DESC, s.number, ln.seq`;

    const cut = this.cut(rows, params.limit);
    return {
      kind: 'inventory-diff',
      title: say('Расхождения инвентаризации', 'Inventarizatsiya tafovutlari'),
      subtitle: `${where.text}, ${period.text}, ${say('расхождений', 'tafovutlar')} ${cut.total}`,
      columns: [
        { title: say('Лист', 'Varaq'), width: 14 },
        { title: say('Дата', 'Sana'), width: 12 },
        { title: say('Состояние', 'Holat'), width: 18 },
        { title: say('Склад', 'Ombor'), width: 28 },
        { title: say('Зона', 'Zona'), width: 8 },
        { title: say('Ячейка', 'Yacheyka'), width: 10 },
        { title: say('Код', 'Kod'), width: 16 },
        { title: say('Номенклатура', 'Nomenklatura'), width: 44 },
        { title: say('Партия', 'Partiya'), width: 12 },
        { title: say('Серийный номер', 'Seriya raqami'), width: 18 },
        { title: say('Ед.', 'Birlik'), width: 6 },
        { title: say('По учёту', 'Hisobda'), numeric: true, width: 14 },
        { title: say('Посчитано', 'Sanab chiqilgan'), numeric: true, width: 14 },
        { title: say('Расхождение', 'Tafovut'), numeric: true, width: 14 },
        { title: say('Себестоимость', 'Tannarx'), numeric: true, width: 16 },
        { title: say('Сумма расхождения', 'Tafovut summasi'), numeric: true, width: 20 },
        { title: say('Кто считал', 'Kim sanadi'), width: 26 },
      ],
      rows: cut.rows.map((r) => [
        r.sheet,
        r.happened_on,
        sheetStatus()[r.status!] ?? r.status,
        r.warehouse,
        r.zone,
        r.location,
        r.item_code,
        r.item_name,
        r.batch,
        r.serial,
        r.unit,
        num(r.qty_expected),
        num(r.qty_counted),
        num(r.qty_diff),
        num(r.unit_cost),
        num(r.diff_value),
        r.author,
      ]),
      total: cut.total,
      truncated: cut.truncated,
    };
  }
}

/** Количества в базе — `decimal(20,6)`; хвост float в отчёте читается поломкой. */
const round6 = (v: number) => Number(v.toFixed(6));
