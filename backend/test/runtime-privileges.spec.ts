/**
 * Рантайм не обходит RLS — ни ролью, ни вторым подключением.
 *
 * Проверка нужна потому, что обход возвращается тихо: достаточно одной строки
 * `new PrismaClient({ connectionString: process.env.DATABASE_URL })` или одного
 * `ALTER ROLE ... BYPASSRLS`, и все политики перестают что-либо значить, а
 * остальные тесты при этом останутся зелёными.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const appUrl = process.env.APP_DATABASE_URL!;
const ownerUrl = process.env.DATABASE_URL!;
const SRC = path.resolve(import.meta.dirname, '../src');

let app: Client;
let owner: Client;
let userWithAssignments: string;

/** Контекст входа: известен пользователь, компании — ещё нет. */
async function asUser<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  await app.query('BEGIN');
  await app.query(`SELECT set_config('app.company_ids', '', true)`);
  await app.query(`SELECT set_config('app.user_id', $1, true)`, [userId]);
  try {
    return await fn();
  } finally {
    await app.query('ROLLBACK');
  }
}

/** Все .ts приложения, кроме сгенерированного Prisma клиента. */
function sources(): string[] {
  return fs
    .readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((rel) => rel.endsWith('.ts') && !rel.startsWith('generated'))
    .map((rel) => path.join(SRC, rel));
}

beforeAll(async () => {
  app = new Client({ connectionString: appUrl });
  owner = new Client({ connectionString: ownerUrl });
  await app.connect();
  await owner.connect();

  const { rows } = await owner.query(
    `SELECT user_id::text AS id FROM user_role_assignment ORDER BY user_id LIMIT 1`,
  );
  userWithAssignments = rows[0]!.id;
});

afterAll(async () => {
  await app.end();
  await owner.end();
});

describe('роль приложения', () => {
  it('не суперпользователь и не BYPASSRLS', async () => {
    const { rows } = await app.query(
      `SELECT rolsuper, rolbypassrls, rolname FROM pg_roles WHERE rolname = current_user`,
    );
    expect(rows[0].rolsuper, `роль ${rows[0].rolname}`).toBe(false);
    expect(rows[0].rolbypassrls, `роль ${rows[0].rolname}`).toBe(false);
  });
});

describe('исходники сервиса', () => {
  it('нигде не открывают подключение владельца схемы', () => {
    const guilty = sources().filter((file) =>
      /(?<!APP_)\bDATABASE_URL\b/.test(fs.readFileSync(file, 'utf8')),
    );
    // Владельцем схемы ходят только миграции и сид — то есть prisma.config.ts
    // и prisma/seed.ts, а они лежат вне src/.
    expect(guilty, `файлы с DATABASE_URL: ${guilty.join(', ')}`).toEqual([]);
  });

  it('не обращаются к пулу в обход контекста', () => {
    const guilty = sources().filter((file) =>
      /\bprisma\.(admin|owner|raw)\b/.test(fs.readFileSync(file, 'utf8')),
    );
    expect(guilty, `файлы с обходным пулом: ${guilty.join(', ')}`).toEqual([]);
  });
});

describe('вход без контекста компаний', () => {
  it('видит свои назначения ролей', async () => {
    const n = await asUser(userWithAssignments, async () => {
      const { rows } = await app.query(
        `SELECT count(*)::int AS n FROM user_role_assignment`,
      );
      return rows[0].n as number;
    });
    expect(n).toBeGreaterThan(0);
  });

  it('видит только свои, чужих назначений не видит', async () => {
    const others = await asUser(userWithAssignments, async () => {
      const { rows } = await app.query(
        `SELECT count(*)::int AS n FROM user_role_assignment WHERE user_id <> $1`,
        [userWithAssignments],
      );
      return rows[0].n as number;
    });
    expect(others).toBe(0);
  });

  it('данных арендаторов через этот контекст не достаёт', async () => {
    const seen = await asUser(userWithAssignments, async () => {
      const { rows } = await app.query(
        `SELECT (SELECT count(*) FROM sales_order)::int AS orders,
                (SELECT count(*) FROM company)::int     AS companies,
                (SELECT count(*) FROM stock_balance)::int AS stock`,
      );
      return rows[0];
    });
    expect(seen.orders).toBe(0);
    expect(seen.companies).toBe(0);
    expect(seen.stock).toBe(0);
  });

  it('без выставленного пользователя не видит и назначений', async () => {
    await app.query('BEGIN');
    try {
      const { rows } = await app.query(
        `SELECT count(*)::int AS n FROM user_role_assignment`,
      );
      expect(rows[0].n).toBe(0);
    } finally {
      await app.query('ROLLBACK');
    }
  });
});
