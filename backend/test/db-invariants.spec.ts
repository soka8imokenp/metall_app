/**
 * Проверки правил, которые держит сама база.
 *
 * Ходим ролью metall_app — той, которой будет ходить приложение. Проверять
 * RLS ролью владельца бессмысленно: у metall_owner есть BYPASSRLS, и политики
 * на нём не видны, как и на суперпользователе.
 */
import 'dotenv/config';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const appUrl = process.env.APP_DATABASE_URL!;
const ownerUrl = process.env.DATABASE_URL!;

let app: Client;
let owner: Client;
let tradeId: string;
let plantId: string;

/** Контекст запроса живёт в транзакции: SET LOCAL, а не SET. */
async function asCompany<T>(companyIds: string[], fn: () => Promise<T>): Promise<T> {
  await app.query('BEGIN');
  await app.query(`SELECT set_config('app.company_ids', $1, true)`, [companyIds.join(',')]);
  try {
    return await fn();
  } finally {
    await app.query('ROLLBACK');
  }
}

beforeAll(async () => {
  app = new Client({ connectionString: appUrl });
  owner = new Client({ connectionString: ownerUrl });
  await app.connect();
  await owner.connect();

  const { rows } = await owner.query(`SELECT code, id::text FROM company ORDER BY code`);
  plantId = rows.find((r) => r.code === 'plant')!.id;
  tradeId = rows.find((r) => r.code === 'trade')!.id;
});

afterAll(async () => {
  await app.end();
  await owner.end();
});

describe('роль приложения', () => {
  it('не имеет ни SUPERUSER, ни BYPASSRLS', async () => {
    const { rows } = await app.query(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
    );
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });
});

describe('RLS: изоляция компаний', () => {
  it('без контекста не видно ни одной строки', async () => {
    await app.query('BEGIN');
    const { rows } = await app.query('SELECT count(*)::int AS n FROM sales_order');
    await app.query('ROLLBACK');
    expect(rows[0].n).toBe(0);
  });

  it('с контекстом одной компании видны только её заказы', async () => {
    const seen = await asCompany([tradeId], async () => {
      const { rows } = await app.query(
        'SELECT DISTINCT company_id::text AS id FROM sales_order',
      );
      return rows.map((r) => r.id);
    });
    expect(seen).toEqual([tradeId]);
  });

  it('холдинг видит обе компании сразу', async () => {
    const seen = await asCompany([tradeId, plantId], async () => {
      const { rows } = await app.query(
        'SELECT DISTINCT company_id::text AS id FROM sales_order ORDER BY 1',
      );
      return rows.map((r) => r.id).sort();
    });
    expect(seen.sort()).toEqual([tradeId, plantId].sort());
  });

  it('строки заказа чужой компании тоже недоступны', async () => {
    const n = await asCompany([tradeId], async () => {
      const { rows } = await app.query(`
        SELECT count(*)::int AS n
          FROM sales_order_line l
          JOIN sales_order o ON o.id = l.sales_order_id
         WHERE o.company_id <> $1`, [tradeId]);
      return rows[0].n;
    });
    expect(n).toBe(0);
  });

  it('запись с чужим company_id отклоняется', async () => {
    await expect(
      asCompany([tradeId], async () => {
        await app.query(
          `INSERT INTO stock_reason (company_id, kind, name_ru, name_uz)
           VALUES ($1, 'write_off', 'подмена', 'almashtirish')`,
          [plantId],
        );
      }),
    ).rejects.toThrow(/row-level security/i);
  });
});

describe('складские инварианты', () => {
  it('остаток не уходит в минус', async () => {
    await expect(
      owner.query(`UPDATE stock_balance SET qty_on_hand = -1 WHERE id = (SELECT min(id) FROM stock_balance)`),
    ).rejects.toThrow(/qty_on_hand_non_negative/);
  });

  it('нельзя зарезервировать больше, чем лежит', async () => {
    await expect(
      owner.query(`UPDATE stock_balance SET qty_reserved = qty_on_hand + 1 WHERE id = (SELECT min(id) FROM stock_balance)`),
    ).rejects.toThrow(/reserved_le_on_hand/);
  });

  it('доступный остаток пересчитывается сам и подменить его нельзя', async () => {
    await owner.query('BEGIN');
    await owner.query(
      `UPDATE stock_balance SET qty_available = 0 WHERE id = (SELECT min(id) FROM stock_balance)`,
    );
    const { rows } = await owner.query(
      `SELECT qty_available, qty_on_hand - qty_reserved AS expected
         FROM stock_balance WHERE id = (SELECT min(id) FROM stock_balance)`,
    );
    await owner.query('ROLLBACK');
    expect(rows[0].qty_available).toBe(rows[0].expected);
  });

  it('журнал движений нельзя править задним числом', async () => {
    await expect(
      owner.query(`UPDATE stock_move SET qty = qty + 1 WHERE id = (SELECT min(id) FROM stock_move)`),
    ).rejects.toThrow(/только для добавления/);
  });

  it('строку журнала движений нельзя удалить', async () => {
    await expect(
      owner.query(`DELETE FROM stock_move WHERE id = (SELECT min(id) FROM stock_move)`),
    ).rejects.toThrow(/только для добавления/);
  });

  it('журнал аудита нельзя переписать', async () => {
    await owner.query('BEGIN');
    await owner.query(
      `INSERT INTO audit_log (company_id, entity_type, entity_id, action)
       VALUES ($1, 'test', '1', 'create')`, [tradeId],
    );
    await expect(
      owner.query(`UPDATE audit_log SET action = 'update' WHERE entity_type = 'test'`),
    ).rejects.toThrow(/только для добавления/);
    await owner.query('ROLLBACK');
  });
});

describe('двойная запись', () => {
  it('несходящаяся проводка не проходит', async () => {
    await owner.query('BEGIN');
    const { rows } = await owner.query(
      `SELECT id::text, company_id::text, account_id::text FROM finance_operation LIMIT 1`,
    );
    const op = rows[0];
    await owner.query(
      `INSERT INTO finance_entry (operation_id, company_id, account_id, debit, credit, amount_base)
       VALUES ($1, $2, $3, 1000, 0, 1000)`,
      [op.id, op.company_id, op.account_id],
    );
    // Дебет добавили, кредит — нет. Ошибка приходит на COMMIT, а не на INSERT:
    // ограничение отложенное, иначе проводку нельзя было бы собрать построчно.
    await expect(owner.query('COMMIT')).rejects.toThrow(/не сходятся/);
    await owner.query('ROLLBACK');
  });

  it('парная проводка проходит', async () => {
    await owner.query('BEGIN');
    const { rows } = await owner.query(
      `SELECT id::text, company_id::text, account_id::text FROM finance_operation LIMIT 1`,
    );
    const op = rows[0];
    await owner.query(
      `INSERT INTO finance_entry (operation_id, company_id, account_id, debit, credit, amount_base)
       VALUES ($1, $2, $3, 1000, 0, 1000), ($1, $2, $3, 0, 1000, 1000)`,
      [op.id, op.company_id, op.account_id],
    );
    await expect(owner.query('COMMIT')).resolves.toBeDefined();
    await owner.query(`DELETE FROM finance_entry WHERE amount_base = 1000`);
  });

  it('все проводки в базе сходятся', async () => {
    const { rows } = await owner.query(`
      SELECT count(*)::int AS n FROM (
        SELECT operation_id FROM finance_entry
         GROUP BY operation_id HAVING sum(debit) <> sum(credit)
      ) x`);
    expect(rows[0].n).toBe(0);
  });
});
