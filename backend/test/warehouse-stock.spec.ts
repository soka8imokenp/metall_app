/**
 * Остаток — свёртка журнала движений, а не самостоятельное число.
 *
 * Так сказано в самой модели: `stock_balance` объявлен агрегатом, который
 * «обновляется в одной транзакции со StockMove». Пока агрегат пишется отдельно
 * от журнала, экран склада показывает остаток, который ничем не подтверждён:
 * открыв карточку позиции, кладовщик увидит движения, не сходящиеся с цифрой
 * в строке над ними.
 *
 * Второй разрыв того же рода — производство. В журнале движений есть только
 * приход и отгрузка: выпущенная продукция на склад не попадает, а материалы
 * со склада не уходят. Цех и склад в таких данных живут в разных мирах.
 *
 * Проверка ходит ролью владельца: она смотрит согласованность данных, а не
 * изоляцию компаний — для изоляции есть `db-invariants` и `runtime-privileges`.
 */
import 'dotenv/config';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let owner: Client;

beforeAll(async () => {
  owner = new Client({ connectionString: process.env.DATABASE_URL! });
  await owner.connect();
});

afterAll(async () => {
  await owner.end();
});

/**
 * Свёртка журнала до остатка. Ключ тот же, что у уникального индекса
 * `stock_balance`: компания, склад, **ячейка**, номенклатура, партия. Приход —
 * движение «куда», расход — «откуда»; перемещение попадает в обе части и
 * поэтому считается дважды, каждый раз со своей стороной.
 *
 * Ячейка в ключе — не придирка. Без неё свёртка сходится и тогда, когда товар
 * списан не с той полки, куда его положили: по складу итог тот же, а по ячейкам
 * одна ушла в минус, другая зависла навсегда. Серийный номер — из того же
 * ряда: без него восемь труб по одной сворачиваются в «восемь штук», и
 * отгруженная не та труба остатку незаметна.
 */
const NET_FROM_MOVES = `
  WITH parts AS (
    SELECT company_id, to_warehouse_id AS warehouse_id, to_location_id AS location_id,
           item_id, batch_id, serial_id, qty_base AS q
      FROM stock_move WHERE to_warehouse_id IS NOT NULL
    UNION ALL
    SELECT company_id, from_warehouse_id, from_location_id, item_id, batch_id, serial_id,
           -qty_base
      FROM stock_move WHERE from_warehouse_id IS NOT NULL)
  SELECT company_id, warehouse_id, location_id, item_id, batch_id, serial_id,
         sum(q) AS from_moves
    FROM parts GROUP BY 1, 2, 3, 4, 5, 6`;

describe('остатки склада', () => {
  it('остаток сходится с журналом движений', () =>
    owner
      .query(
        `WITH net AS (${NET_FROM_MOVES})
         SELECT count(*)::int AS n
           FROM net n
           FULL JOIN stock_balance b
             ON b.company_id = n.company_id
            AND b.warehouse_id = n.warehouse_id
            AND b.location_id IS NOT DISTINCT FROM n.location_id
            AND b.item_id = n.item_id
            AND b.batch_id IS NOT DISTINCT FROM n.batch_id
            AND b.serial_id IS NOT DISTINCT FROM n.serial_id
          WHERE abs(coalesce(b.qty_on_hand, 0) - coalesce(n.from_moves, 0)) > 0.000001`,
      )
      .then(({ rows }) =>
        expect(rows[0].n, 'строк, где остаток не равен свёртке движений').toBe(0),
      ));

  it('остаток не уходит в минус', () =>
    owner
      .query(`SELECT count(*)::int AS n FROM stock_balance WHERE qty_on_hand < 0`)
      .then(({ rows }) => expect(rows[0].n, 'строк с отрицательным остатком').toBe(0)));

  it('журнал нигде не уводит позицию в минус по ходу времени', () =>
    // Проверка строже предыдущей: итог может сойтись, а в середине периода
    // склад успел отгрузить то, чего на нём ещё не было.
    owner
      .query(
        `WITH parts AS (
           SELECT company_id, to_warehouse_id AS warehouse_id, to_location_id AS location_id,
                  item_id, batch_id, moved_at, id, qty_base AS q
             FROM stock_move WHERE to_warehouse_id IS NOT NULL
           UNION ALL
           SELECT company_id, from_warehouse_id, from_location_id, item_id, batch_id,
                  moved_at, id, -qty_base
             FROM stock_move WHERE from_warehouse_id IS NOT NULL),
         running AS (
           SELECT company_id, warehouse_id, location_id, item_id, batch_id, moved_at,
                  sum(q) OVER (PARTITION BY company_id, warehouse_id, location_id,
                                            item_id, batch_id
                               ORDER BY moved_at, id) AS balance
             FROM parts)
         SELECT count(*)::int AS n FROM running WHERE balance < -0.000001`,
      )
      .then(({ rows }) => expect(rows[0].n, 'моментов, когда остаток был отрицательным').toBe(0)));

  it('доступный остаток равен остатку за вычетом резерва', () =>
    owner
      .query(
        `SELECT count(*)::int AS n FROM stock_balance
          WHERE abs(qty_available - (qty_on_hand - qty_reserved)) > 0.000001`,
      )
      .then(({ rows }) => expect(rows[0].n, 'строк с неверным доступным остатком').toBe(0)));

  it('зарезервировано не больше, чем лежит на складе', () =>
    owner
      .query(`SELECT count(*)::int AS n FROM stock_balance WHERE qty_reserved > qty_on_hand`)
      .then(({ rows }) => expect(rows[0].n, 'строк, где резерв больше остатка').toBe(0)));

  it('у каждого движения есть хотя бы один склад', () =>
    // Движение без обоих складов не меняет ничего и ничего не значит.
    owner
      .query(
        `SELECT count(*)::int AS n FROM stock_move
          WHERE from_warehouse_id IS NULL AND to_warehouse_id IS NULL`,
      )
      .then(({ rows }) => expect(rows[0].n, 'движений без склада').toBe(0)));

  it('приход и расход стоят на своих местах', () =>
    // Отгрузка обязана уносить со склада, приход — приносить на склад.
    // Перепутанные стороны дают остаток, растущий от продаж.
    //
    // Сторно из проверки исключено сознательно: у него тип тот же, что у
    // отменяемого движения, а стороны по определению обратные — приход
    // отменяют снятием со склада. Правило для сторно ниже, отдельное и строже.
    owner
      .query(
        `SELECT count(*)::int AS n FROM stock_move
          WHERE reversal_of_id IS NULL
            AND ((operation_type IN ('receipt', 'surplus', 'output', 'return_from_client',
                                     'return_from_production')
                  AND to_warehouse_id IS NULL)
              OR (operation_type IN ('shipment', 'write_off', 'issue_to_production')
                  AND from_warehouse_id IS NULL))`,
      )
      .then(({ rows }) => expect(rows[0].n, 'движений с перепутанными сторонами').toBe(0)));

  it('сторно зеркалит отменяемое движение', () =>
    // Сторно, не совпавшее с оригиналом по количеству или сторонам, — это не
    // отмена, а второе независимое движение: остаток после него не вернётся к
    // тому, что было до ошибки.
    owner
      .query(
        `SELECT count(*)::int AS n FROM stock_move s
           JOIN stock_move o ON o.id = s.reversal_of_id
          WHERE s.reversal_of_id IS NOT NULL
            AND (s.qty_base <> o.qty_base
              OR s.company_id <> o.company_id
              OR s.item_id <> o.item_id
              OR s.batch_id IS DISTINCT FROM o.batch_id
              OR s.from_warehouse_id IS DISTINCT FROM o.to_warehouse_id
              OR s.to_warehouse_id IS DISTINCT FROM o.from_warehouse_id)`,
      )
      .then(({ rows }) => expect(rows[0].n, 'сторно, не совпавших с оригиналом').toBe(0)));

  it('одно движение отменяют один раз', () =>
    // Две отмены одного движения вернут товар дважды: остаток вырастет из
    // ничего, а журнал будет выглядеть законно.
    owner
      .query(
        `SELECT count(*)::int AS n FROM (
           SELECT reversal_of_id FROM stock_move
            WHERE reversal_of_id IS NOT NULL
            GROUP BY reversal_of_id HAVING count(*) > 1) t`,
      )
      .then(({ rows }) => expect(rows[0].n, 'движений, отменённых дважды').toBe(0)));
});

describe('склад и производство связаны', () => {
  it('годная продукция попадает на склад', () =>
    owner
      .query(
        `SELECT count(*)::int AS n
           FROM production_output o
          WHERE o.kind = 'good' AND o.qty > 0
            AND NOT EXISTS (
              SELECT 1 FROM stock_move m
               WHERE m.operation_type = 'output'
                 AND m.source_doc_type = 'production_output'
                 AND m.source_doc_id = o.id)`,
      )
      .then(({ rows }) => expect(rows[0].n, 'выпусков без прихода на склад').toBe(0)));

  it('брак и отходы на склад не приходуются', () =>
    // Обратная сторона предыдущей проверки. Брак, попавший на склад готовой
    // продукции, назавтра уедет клиенту: склад не знает, что он брак.
    owner
      .query(
        `SELECT count(*)::int AS n
           FROM stock_move m
           JOIN production_output o ON o.id = m.source_doc_id
          WHERE m.source_doc_type = 'production_output' AND o.kind <> 'good'`,
      )
      .then(({ rows }) => expect(rows[0].n, 'движений по браку и отходам').toBe(0)));

  it('израсходованные материалы уходят со склада', () =>
    owner
      .query(
        `SELECT count(*)::int AS n
           FROM production_material pm
          WHERE pm.qty_issued > 0
            AND NOT EXISTS (
              SELECT 1 FROM stock_move m
               WHERE m.operation_type = 'issue_to_production'
                 AND m.source_doc_type = 'production_material'
                 AND m.source_doc_id = pm.id)`,
      )
      .then(({ rows }) => expect(rows[0].n, 'выдач материала без списания со склада').toBe(0)));

  it('списания указывают причину или лист пересчёта', () =>
    // Причина списания — единственное, что отличает брак от недостачи.
    // Недостача по инвентаризации — исключение: её объясняет лист, на который
    // ссылается строка, и причина из справочника тут дублировала бы документ.
    // Но без одного из двух списание остаётся немотивированным.
    owner
      .query(
        `SELECT count(*)::int AS n FROM stock_move
          WHERE operation_type = 'write_off' AND reason_id IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM inventory_sheet s
               WHERE s.id = stock_move.source_doc_id
                 AND stock_move.source_doc_type = 'inventory_sheet')`,
      )
      .then(({ rows }) => expect(rows[0].n, 'списаний без причины и без листа').toBe(0)));
});
