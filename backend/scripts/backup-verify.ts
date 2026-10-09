/**
 * Проверка копии базы разворачиванием. Копия, которую никто не разворачивал, —
 * это файл, а не копия.
 *
 * Что делает:
 *   1. Берёт файл копии (последний в каталоге `BACKUP_DIR` или названный ключом).
 *   2. Создаёт **временную** базу `<имя>_verify_<метка>`.
 *   3. Разворачивает копию в неё через `pg_restore`.
 *   4. Считает строки в нескольких таблицах в исходной базе и во временной и
 *      сверяет числа.
 *   5. Удаляет временную базу — всегда, включая случай падения.
 *
 * **В рабочую базу не разворачивает и не может.** Имя цели собирается здесь и
 * обязано заканчиваться на `_verify_<цифры>`; совпадение с именем источника —
 * остановка. Пересев базы стенда сбрасывает пароли всех учёток, и один
 * неверный ключ в командной строке стоил бы доступа всем, кто на стенде
 * работает.
 *
 * **Почему через `docker exec`, а не напрямую.** Клиента PostgreSQL на хосте
 * нет, он есть только в контейнере базы. Файл копии лежит на хосте, поэтому
 * архив уходит в `pg_restore` через stdin: формат `custom` читается с потока.
 *
 * CREATE DATABASE требует права, которого у `metall_owner` нет намеренно
 * (`NOCREATEDB`), поэтому временной базой распоряжается суперпользователь
 * контейнера, а пароль берётся из файла секрета — ключом в командной строке он
 * попал бы в `ps`.
 *
 * Запуск:
 *   cd backend
 *   BACKUP_DIR=./var/backups \
 *   DATABASE_URL="<владельческий адрес базы>" \
 *   npx tsx scripts/backup-verify.ts [--file <имя>] [--keep-temp]
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Client } from 'pg';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};

const CONTAINER = process.env.BACKUP_PG_CONTAINER ?? 'metall-asia-postgres';
const SUPER_USER = process.env.BACKUP_PG_SUPERUSER ?? 'postgres';
const SUPER_PASSWORD_FILE =
  process.env.BACKUP_PG_SUPERUSER_PASSWORD_FILE ??
  `${process.env.HOME}/.local/state/openclaw/secrets/metall-asia-pg-super`;

/**
 * Таблицы для сверки. Не одна и не все: одна таблица ничего не доказывает (она
 * могла попасть в дамп, пока остальные не попали), а все — это сотня запросов
 * ради того же ответа.
 *
 * Набор выбран так, чтобы в нём были таблицы разной природы: справочник,
 * движения склада, деньги, документы, люди и права, журнал. Если RLS вывезет
 * таблицы пустыми, разойдутся именно движения и деньги — у них политики самые
 * плотные.
 */
const TABLES = [
  'user_account',
  'role',
  'user_role_assignment',
  'company',
  'item',
  'warehouse',
  'stock_move',
  'sales_order',
  'sales_order_line',
  'finance_operation',
  'production_order',
  'document',
  'audit_log',
  'db_backup',
];

const sh = (cmd: string, argv: string[], opts: { stdin?: string; env?: NodeJS.ProcessEnv } = {}) =>
  new Promise<{ code: number; out: string; err: string }>((resolve, reject) => {
    const p = spawn(cmd, argv, {
      stdio: [opts.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...opts.env },
    });
    let out = '';
    let err = '';
    p.stdout!.on('data', (d) => (out += d));
    p.stderr!.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => resolve({ code: code ?? -1, out, err }));
    if (opts.stdin) {
      fs.createReadStream(opts.stdin).pipe(p.stdin!);
    }
  });

const superPassword = () => {
  if (!fs.existsSync(SUPER_PASSWORD_FILE)) {
    throw new Error(`нет файла с паролем суперпользователя: ${SUPER_PASSWORD_FILE}`);
  }
  return fs.readFileSync(SUPER_PASSWORD_FILE, 'utf8').trim();
};

/** psql суперпользователем в контейнере. Пароль — переменной, не ключом. */
const psql = async (db: string, sql: string) => {
  const r = await sh(
    'docker',
    [
      'exec',
      '-i',
      '-e',
      'PGPASSWORD',
      CONTAINER,
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      SUPER_USER,
      '-d',
      db,
      '-tA',
      '-c',
      sql,
    ],
    { env: { PGPASSWORD: superPassword() } },
  );
  if (r.code !== 0) throw new Error(`psql ${db}: ${r.err.trim() || r.out.trim()}`);
  return r.out.trim();
};

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('не задана DATABASE_URL — адрес базы-источника');
  const source = new URL(url).pathname.replace(/^\//, '');

  const dir = path.resolve(process.env.BACKUP_DIR ?? './var/backups');
  const named = value('--file');
  const file = named
    ? path.resolve(dir, named)
    : path.join(
        dir,
        fs
          .readdirSync(dir)
          .filter((f) => f.endsWith('.dump'))
          .sort()
          .at(-1) ?? '',
      );
  if (!file || !fs.existsSync(file)) throw new Error(`нет файла копии: ${file || `в ${dir} пусто`}`);

  const size = fs.statSync(file).size;
  const temp = `${source}_verify_${Date.now().toString().slice(-7)}`;
  // Два запрета, а не один: имя обязано быть временным по форме И не совпадать
  // с источником. Любой из них по отдельности однажды пропустил бы опечатку.
  if (!/_verify_\d+$/.test(temp) || temp === source) {
    throw new Error(`имя временной базы «${temp}» не похоже на временное — остановка`);
  }

  console.log(`копия:    ${file} (${(size / 1024 / 1024).toFixed(1)} МБ)`);
  console.log(`источник: ${source}`);
  console.log(`времянка: ${temp}`);

  const src = new Client({ connectionString: url });
  await src.connect();

  let created = false;
  try {
    await psql('postgres', `CREATE DATABASE "${temp}"`);
    created = true;

    // `--no-owner` и `--no-privileges`: временная база нужна, чтобы сверить
    // данные, а не воспроизвести владельцев и гранты. Без них restore спорит с
    // ролями, которых в сверке нет, и шумит сотней предупреждений.
    const r = await sh(
      'docker',
      [
        'exec',
        '-i',
        '-e',
        'PGPASSWORD',
        CONTAINER,
        'pg_restore',
        '--no-owner',
        '--no-privileges',
        '--exit-on-error',
        '--dbname',
        temp,
        '-U',
        SUPER_USER,
      ],
      { stdin: file, env: { PGPASSWORD: superPassword() } },
    );
    if (r.code !== 0) {
      throw new Error(`pg_restore вышел с кодом ${r.code}: ${r.err.trim().slice(-1500)}`);
    }
    console.log('развёрнута без ошибок');

    const rows: { table: string; src: number; copy: number; same: boolean }[] = [];
    for (const table of TABLES) {
      const a = Number((await src.query(`SELECT count(*)::text AS n FROM "${table}"`)).rows[0].n);
      const b = Number(await psql(temp, `SELECT count(*) FROM "${table}"`));
      rows.push({ table, src: a, copy: b, same: a === b });
    }

    const pad = Math.max(...rows.map((r) => r.table.length));
    console.log('');
    console.log(`${'таблица'.padEnd(pad)}  источник  копия  итог`);
    for (const r of rows) {
      console.log(
        `${r.table.padEnd(pad)}  ${String(r.src).padStart(8)}  ${String(r.copy).padStart(5)}  ` +
          (r.same ? 'совпало' : 'РАСХОЖДЕНИЕ'),
      );
    }

    // Пустая база сошлась бы с пустой копией по всем таблицам сразу, и сверка
    // объявила бы победу, ничего не проверив.
    const filled = rows.filter((r) => r.src > 0).length;
    const diff = rows.filter((r) => !r.same);
    console.log('');
    if (filled === 0) {
      console.log('ОТКАЗ: в источнике все проверяемые таблицы пустые — сверять нечего');
      process.exitCode = 1;
    } else if (diff.length > 0) {
      console.log(`ОТКАЗ: расходится таблиц ${diff.length}: ${diff.map((d) => d.table).join(', ')}`);
      process.exitCode = 1;
    } else {
      console.log(`СОШЛОСЬ: ${rows.length} таблиц, из них непустых ${filled}`);
    }
  } finally {
    await src.end();
    if (created && !flag('--keep-temp')) {
      // Висящая времянка — копия всех данных системы на том же сервере, и
      // удалять её потом никто не придёт. Поэтому в finally, а не после сверки.
      await psql('postgres', `DROP DATABASE IF EXISTS "${temp}" WITH (FORCE)`);
      console.log(`времянка ${temp} удалена`);
    } else if (created) {
      console.log(`времянка ${temp} оставлена по ключу --keep-temp`);
    }
  }
}

main().catch((e: Error) => {
  console.error(`не вышло: ${e.message}`);
  process.exitCode = 1;
});
