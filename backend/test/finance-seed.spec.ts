/**
 * Данные финансов в базе: экран финансов нечем наполнить, если в сиде одни
 * приходы от покупателей.
 *
 * Зачем сторож. До этой проверки сид делал 577 операций одного типа `income`
 * в одном статусе `posted`, задействуя 2 счёта из 16. Экран согласования на
 * таких данных — пустая рамка, план-факт — план против нуля, отчёт ДДС —
 * один приток. Проверяем не «сид отработал», а что каждый блок экрана есть
 * чем показать, и что непроведённая операция не влияет на сальдо.
 *
 * Ходим ролью владельца: это проверка состава данных, а не прав.
 */
import 'dotenv/config';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let db: Client;

const one = async (sql: string, params: unknown[] = []) => {
  const { rows } = await db.query(sql, params);
  return rows[0] as Record<string, string>;
};

beforeAll(async () => {
  db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
});

afterAll(async () => {
  await db.end();
});

describe('операции финансов', () => {
  it('есть все четыре типа: приход, расход, перевод, конверсия валюты', async () => {
    const { rows } = await db.query(
      `SELECT operation_type, count(*)::int AS n FROM finance_operation GROUP BY 1`,
    );
    const got = Object.fromEntries(rows.map((r) => [r.operation_type, r.n]));
    for (const type of ['income', 'expense', 'transfer', 'conversion']) {
      expect(got[type] ?? 0, `операций типа «${type}»`).toBeGreaterThan(0);
    }
  });

  it('очередь согласования не пустая: есть черновики, поданные и согласованные', async () => {
    const { rows } = await db.query(
      `SELECT status, count(*)::int AS n FROM finance_operation GROUP BY 1`,
    );
    const got = Object.fromEntries(rows.map((r) => [r.status, r.n]));
    for (const status of ['draft', 'pending_approval', 'approved', 'posted', 'rejected']) {
      expect(got[status] ?? 0, `операций в статусе «${status}»`).toBeGreaterThan(0);
    }
  });

  it('расход разнесён по всем расходным статьям ДДС, а не свален в одну', async () => {
    const { rows } = await db.query(
      `SELECT c.name_ru, count(o.id)::int AS n
         FROM cashflow_item c
         LEFT JOIN finance_operation o ON o.cashflow_item_id = c.id
        WHERE c.direction = 'outflow'
        GROUP BY 1`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(Number(r.n), `операций по статье «${r.name_ru}»`).toBeGreaterThan(0);
    }
  });

  it('задействованы обе компании', async () => {
    const r = await one(
      `SELECT count(DISTINCT company_id)::int AS n FROM finance_operation WHERE operation_type <> 'income'`,
    );
    expect(Number(r.n)).toBe(2);
  });
});

describe('проводки', () => {
  it('есть у каждой проведённой операции и только у неё', async () => {
    const r = await one(`
      SELECT count(*) FILTER (WHERE o.status = 'posted' AND e.id IS NULL)::int  AS posted_without,
             count(*) FILTER (WHERE o.status <> 'posted' AND e.id IS NOT NULL)::int AS unposted_with
        FROM finance_operation o
        LEFT JOIN finance_entry e ON e.operation_id = o.id
    `);
    expect(Number(r.posted_without), 'проведённых операций без проводок').toBe(0);
    expect(Number(r.unposted_with), 'проводок у непроведённой операции').toBe(0);
  });

  it('сходятся по каждой операции: дебет равен кредиту', async () => {
    const r = await one(`
      SELECT count(*)::int AS n FROM (
        SELECT operation_id FROM finance_entry
         GROUP BY operation_id HAVING sum(debit) <> sum(credit)) bad
    `);
    expect(Number(r.n), 'операций с несходящейся проводкой').toBe(0);
  });

  it('у каждой проведённой операции записан счёт-корреспондент', async () => {
    // Сторно строит обратную проводку по паре «счёт — корреспондент». Если
    // корреспондент лежит только в строке проводки, а в самой операции пусто,
    // операцию нельзя ни отменить, ни показать в карточке целиком: так было
    // у всех 577 приходов, пока сид не начал писать его в операцию.
    const { rows } = await db.query(
      `SELECT operation_type, count(*)::int AS n
         FROM finance_operation
        WHERE status = 'posted' AND counter_account_id IS NULL
        GROUP BY 1`,
    );
    expect(rows, `проведённые операции без корреспондента: ${JSON.stringify(rows)}`).toEqual([]);
  });

  it('счёт-корреспондент операции совпадает со второй стороной её проводки', async () => {
    const r = await one(`
      SELECT count(*)::int AS n
        FROM finance_operation o
       WHERE o.status = 'posted'
         AND NOT EXISTS (
           SELECT 1 FROM finance_entry e
            WHERE e.operation_id = o.id AND e.account_id = o.counter_account_id)
    `);
    expect(Number(r.n), 'операций, где корреспондент не участвует в проводке').toBe(0);
  });

  it('трогают больше двух счетов: касса, поставщики, расходы и налоги тоже в обороте', async () => {
    const r = await one(`SELECT count(DISTINCT account_id)::int AS n FROM finance_entry`);
    expect(Number(r.n)).toBeGreaterThanOrEqual(8);
  });

  it('оставляют на расчётном счёте положительный остаток', async () => {
    const { rows } = await db.query(`
      SELECT a.company_id, sum(e.debit - e.credit) AS saldo
        FROM finance_entry e JOIN account a ON a.id = e.account_id
       WHERE a.code = '5110'
       GROUP BY 1
    `);
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(Number(r.saldo), `остаток 5110 компании ${r.company_id}`).toBeGreaterThan(0);
    }
  });
});

describe('план-факт по бюджетам', () => {
  it('у каждого бюджета есть факт внутри его периода', async () => {
    const { rows } = await db.query(`
      SELECT b.id, c.name_ru,
             coalesce(sum(o.amount_base), 0) AS fact
        FROM budget b
        JOIN cashflow_item c ON c.id = b.cashflow_item_id
        LEFT JOIN finance_operation o
               ON o.cashflow_item_id = b.cashflow_item_id
              AND o.company_id = b.company_id
              AND o.status = 'posted'
              AND o.occurred_at::date BETWEEN b.period_start AND b.period_end
       GROUP BY b.id, c.name_ru
    `);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(Number(r.fact), `факт по бюджету статьи «${r.name_ru}»`).toBeGreaterThan(0);
    }
  });

  it('есть и недобор плана, и перерасход — отклонение видно в обе стороны', async () => {
    const { rows } = await db.query(`
      SELECT b.amount_planned::float8 AS plan,
             coalesce(sum(o.amount_base), 0)::float8 AS fact
        FROM budget b
        LEFT JOIN finance_operation o
               ON o.cashflow_item_id = b.cashflow_item_id
              AND o.company_id = b.company_id
              AND o.status = 'posted'
              AND o.occurred_at::date BETWEEN b.period_start AND b.period_end
       GROUP BY b.id, b.amount_planned
    `);
    expect(rows.some((r) => r.fact > r.plan), 'ни одного перерасхода').toBe(true);
    expect(rows.some((r) => r.fact < r.plan), 'ни одного недобора').toBe(true);
  });
});
