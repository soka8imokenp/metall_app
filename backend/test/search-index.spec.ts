/**
 * Поиск умеет ходить по индексу, а не перебором строк.
 *
 * `ILIKE '%кусок%'` обычным индексом не покрывается: база читает таблицу
 * целиком. Пока в базе тысячи строк, это незаметно — и именно поэтому
 * проверять надо не время ответа, а план запроса. К сотням тысяч строк разница
 * станет видна уже у заказчика, а не здесь.
 *
 * Как проверяется: у базы спрашивается план **того самого** запроса, который
 * уходит в работу (SQL берётся из сервиса, а не переписывается рядом), и в
 * плане ищется обращение к триграммному индексу.
 *
 * Про запреты планировщику: на нынешних объёмах он честно выберет перебор — по
 * трёмстам строкам это и правда дешевле любого индекса. Запреты отвечают на
 * другой вопрос: «может ли этот запрос вообще воспользоваться индексом».
 *
 * Почему запретов три, а не один. Одного `enable_seqscan = off` не хватило:
 * база обошла таблицу по первичному ключу и отфильтровала результат — то есть
 * тот же перебор, только другим путём, и проверка то проходила, то падала в
 * зависимости от статистики, которую меняют соседние прогоны. Обход по ключу и
 * чтение только из индекса тоже запрещены, и остаётся единственный путь —
 * выборка по битовой карте. Построить её можно только по индексу, выражение
 * которого совпадает с выражением в запросе. Разойдутся — имени индекса в
 * плане не будет вовсе, как бы ни легла статистика.
 */
import 'dotenv/config';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { groupSql, searchKinds } from '../src/search/search.service.js';

let db: Client;

/** Какой индекс обязан появиться в плане для каждой группы. */
const INDEX_BY_KIND: Record<string, string> = {
  item: 'item_search_trgm_idx',
  partner: 'partner_search_trgm_idx',
  salesOrder: 'sales_order_search_trgm_idx',
  productionOrder: 'production_order_search_trgm_idx',
  batch: 'batch_search_trgm_idx',
  document: 'document_search_trgm_idx',
  deal: 'deal_search_trgm_idx',
  warehouse: 'warehouse_search_trgm_idx',
  user: 'user_account_search_trgm_idx',
};

async function plan(sql: string): Promise<string> {
  const res = await db.query(`EXPLAIN ${sql}`, ['%труб%', 5]);
  return res.rows.map((r) => r['QUERY PLAN']).join('\n');
}

beforeAll(async () => {
  db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  // Смотрим только на применимость индекса, а не на выбор планировщика.
  await db.query('SET enable_seqscan = off');
  await db.query('SET enable_indexscan = off');
  await db.query('SET enable_indexonlyscan = off');
});

afterAll(async () => {
  await db?.end().catch(() => null);
});

describe('поиск опирается на триграммный индекс', () => {
  it('расширение и функция поиска на месте', async () => {
    const ext = await db.query(`SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'`);
    expect(ext.rowCount, 'нет расширения pg_trgm').toBe(1);
    const fn = await db.query(`SELECT 1 FROM pg_proc WHERE proname = 'app_search'`);
    expect(fn.rowCount, 'нет функции app_search').toBe(1);
  });

  it('все группы поиска описаны в этом прогоне', () => {
    // Иначе новая группа появится без индекса и без единого красного прогона.
    expect(searchKinds().sort()).toEqual(Object.keys(INDEX_BY_KIND).sort());
  });

  for (const kind of Object.keys(INDEX_BY_KIND)) {
    it(`группа «${kind}» ищется по индексу ${INDEX_BY_KIND[kind]}`, async () => {
      const text = await plan(groupSql(kind));
      expect(text, `план без индекса:\n${text}`).toContain(INDEX_BY_KIND[kind]);
    });
  }
});
