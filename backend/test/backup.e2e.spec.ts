/**
 * Копия базы: расписание, журнал, ротация, неудача и право на маршрут.
 *
 * Прогон делает **настоящие** копии базы разработки — `pg_dump` запускается
 * по-честному. Подменять его нельзя: весь смысл этого кода в том, что внешняя
 * команда получает нужные ключи и её поток доезжает до файла целым. Подменённый
 * `pg_dump` проверял бы только нашу обёртку вокруг него.
 *
 * Копии пишутся в свой временный каталог (`BACKUP_DIR` на время прогона) и
 * убираются за собой вместе со строками журнала: класть их в рабочий каталог
 * значит вытеснить ротацией настоящие копии.
 *
 * Чего здесь нет: восстановления. Его проверяет `scripts/backup-verify.ts` — он
 * разворачивает копию во временную базу и сверяет число записей. Внутри vitest
 * этого не сделать: `CREATE DATABASE` требует суперпользователя, а прогоны
 * ходят ролью без такого права.
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from 'pg';
import * as bcrypt from 'bcryptjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { BackupModule } from '../src/backup/backup.module.js';
import { BackupService } from '../src/backup/backup.service.js';
import { BackupScheduler, schedulerEnabled } from '../src/backup/backup.scheduler.js';
import { NotificationsModule } from '../src/notifications/notifications.module.js';
import { NotificationsService } from '../src/notifications/notifications.service.js';
import { AuthGuard } from '../src/auth/auth.guard.js';
import { ContextMiddleware } from '../src/common/context.middleware.js';
import { EnvelopeInterceptor } from '../src/common/envelope.interceptor.js';
import { ErrorFilter } from '../src/common/error.filter.js';
import { KINDS, KIND_BY_CODE } from '../src/notifications/kinds.js';

let app: INestApplication;
let base: string;
let db: Client;
let backup: BackupService;
let scheduler: BackupScheduler;
let notifications: NotificationsService;

const stamp = Date.now().toString().slice(-7);
const PASSWORD = 'Bekap-Tekshiruv-2026';
/** Админу право на копии есть, кладовщику — нет: на нём проверяется отказ. */
const ROLES = ['admin', 'warehouse_keeper'] as const;
const loginOf = (role: string) => `bkp_${role}_${stamp}`;
const token: Record<string, string> = {};
const userId: Record<string, string> = {};

/** Свой каталог копий: рабочий трогать нельзя — ротация унесёт чужие файлы. */
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-backup-test-'));

/** Начало прогона: по нему за собой убираются строки журнала. */
const RUN_STARTED = new Date();

/** Копии, заведённые этим прогоном: по ним прогон себя и проверяет. */
const made: string[] = [];
const remember = (uid: string) => {
  made.push(uid);
  return uid;
};

/**
 * Команда `pg_dump`. На хосте её нет, она живёт в контейнере базы — ровно та же
 * форма, что прописана окружению стенда.
 */
const PG_DUMP =
  process.env.BACKUP_PG_DUMP ?? 'docker exec -i -e PGPASSWORD metall-asia-postgres pg_dump';

/**
 * Адрес для `pg_dump`: та же база, но изнутри контейнера — там порт 5432, а не
 * 5433, который виден с хоста.
 */
const dumpUrl = () => {
  const u = new URL(process.env.DATABASE_URL!);
  u.port = '5432';
  return u.toString();
};

async function api(p: string, init: RequestInit = {}) {
  const res = await fetch(`${base}${p}`, init);
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as any) : null };
}

const as = (role: string, p: string, init: RequestInit = {}) =>
  api(p, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token[role]}`,
    },
  });

const journal = async (uid: string) =>
  (
    await db.query(
      `SELECT status, source, file_name, size_bytes, sha256, error, duration_ms,
              finished_at, started_by
         FROM db_backup WHERE uid = $1::uuid`,
      [uid],
    )
  ).rows[0];

/** Удачные копии этого прогона, новые сверху. */
const mineOk = async () =>
  (
    await db.query(
      `SELECT uid::text AS uid, file_name FROM db_backup
        WHERE status = 'ok' AND uid = ANY($1::uuid[]) ORDER BY started_at DESC`,
      [made],
    )
  ).rows as { uid: string; file_name: string }[];

beforeAll(async () => {
  process.env.BACKUP_DIR = DIR;
  process.env.BACKUP_PG_DUMP = PG_DUMP;
  process.env.BACKUP_DATABASE_URL = dumpUrl();
  // Три копии вместо тридцати: ротацию надо увидеть, а не сделать тридцать
  // дампов настоящей базы.
  process.env.BACKUP_KEEP = '3';

  const moduleRef = await Test.createTestingModule({
    imports: [PrismaModule, AuthModule, BackupModule, NotificationsModule],
    providers: [
      { provide: APP_GUARD, useClass: AuthGuard },
      { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
      { provide: APP_FILTER, useClass: ErrorFilter },
    ],
  }).compile();

  app = moduleRef.createNestApplication();
  const ctx = new ContextMiddleware();
  app.use(ctx.use.bind(ctx));
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();

  backup = app.get(BackupService);
  scheduler = app.get(BackupScheduler);
  notifications = app.get(NotificationsService);

  db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  const hash = await bcrypt.hash(PASSWORD, 4);
  for (const role of ROLES) {
    const login = loginOf(role);
    const created = await db.query(
      `INSERT INTO user_account (uid, login, full_name, password_hash)
       VALUES (gen_random_uuid(), $1, $2, $3) RETURNING id`,
      [login, `Проверка копий: ${role}`, hash],
    );
    userId[role] = String(created.rows[0].id);
    await db.query(
      `INSERT INTO user_role_assignment (user_id, role_id, company_id)
       SELECT $1, r.id, c.id FROM role r, company c WHERE r.code = $2 AND c.code = 'trade'`,
      [created.rows[0].id, role],
    );
    const res = await api('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login, password: PASSWORD }),
    });
    expect(res.status, `вход ролью «${role}»`).toBe(201);
    token[role] = res.body.data.token;
  }
}, 180_000);

afterAll(async () => {
  // Уведомления собираются по журналу: оставленные строки `failed` заставили бы
  // настоящий бот писать администратору про чужой прогон тестов.
  await db.query(`DELETE FROM notification_outbox WHERE kind = 'backup_failed'`);
  // По времени, а не по списку `made`: копию может сделать и то, что мы не
  // записали — например расписание, проверенное на свежем экземпляре. Забытая
  // строка «сегодня копия по расписанию была» заставила бы следующий прогон
  // считать, что тик отработал, и он падал бы на ровном месте. В базе
  // разработки `db_backup` пишет только этот прогон, так что срез по времени
  // чужого не заденет.
  await db.query(`DELETE FROM db_backup WHERE started_at >= $1`, [RUN_STARTED]);
  await db.query(`UPDATE user_account SET is_active = false WHERE login LIKE $1`, [
    `bkp_%_${stamp}`,
  ]);
  await db.end();
  await app?.close();
  fs.rmSync(DIR, { recursive: true, force: true });
});

describe('копия делается и попадает в журнал', () => {
  it('файл на диске, размер и sha256 в журнале совпадают с файлом', async () => {
    const row = await backup.run('manual', BigInt(userId.admin));
    remember(row.uid);

    expect(row.status, `копия не сделалась: ${row.error}`).toBe('ok');
    expect(row.source).toBe('manual');

    const full = path.join(DIR, row.fileName);
    expect(fs.existsSync(full), `нет файла ${full}`).toBe(true);

    // Журнал обязан описывать именно тот файл, который лежит на диске: размер
    // и хеш «на глаз» обнаружились бы только при попытке восстановиться.
    const bytes = fs.readFileSync(full);
    expect(row.sizeBytes).toBe(bytes.length);
    expect(row.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));

    // Дамп своего формата начинается с подписи PGDMP: обрубок её не содержит, и
    // `pg_restore` на таком файле падает.
    expect(bytes.subarray(0, 5).toString()).toBe('PGDMP');

    const saved = await journal(row.uid);
    expect(saved.status).toBe('ok');
    expect(Number(saved.size_bytes)).toBe(bytes.length);
    expect(saved.error).toBeNull();
    expect(saved.duration_ms).toBeGreaterThan(0);
    expect(saved.finished_at).not.toBeNull();
    expect(String(saved.started_by)).toBe(userId.admin);
  }, 180_000);

  it('копия по расписанию запускается тиком и никем не подписана', async () => {
    // Тик вызывается руками с нужным временем: ждать 03:20 значит проверять не
    // расписание, а терпение.
    const at = backup.at;
    const now = new Date();
    now.setHours(at.hour, at.minute + 1, 0, 0);

    expect(await scheduler.tick(now)).toBe(true);
    const row = (
      await db.query(
        `SELECT uid::text AS uid, status, started_by FROM db_backup
          WHERE source = 'schedule' ORDER BY started_at DESC LIMIT 1`,
      )
    ).rows[0] as { uid: string; status: string; started_by: string | null };
    remember(row.uid);
    expect(row.status).toBe('ok');
    // Расписание не нажимает никто — иначе в списке появился бы «виноватый».
    expect(row.started_by).toBeNull();

    // Второй тик в тот же день копию не повторяет: иначе служба, поднятая после
    // срока, делала бы дамп каждую минуту до утра.
    expect(await scheduler.tick(now)).toBe(false);

    // Перезапуск службы — это новый процесс с пустой памятью, а день, за который
    // копия уже сделана, помнит журнал. Без этого каждая дневная выкатка
    // начинала бы ещё один дамп: именно так на стенде появились две копии «по
    // расписанию» подряд.
    const afterRestart = new BackupScheduler(backup);
    expect(await afterRestart.tick(now)).toBe(false);
  }, 240_000);

  it('расписание — переключатель: на сервере заказчика включено само, выключается переменной', () => {
    // Уточнение Отабека от 07.10: «клиент не должен об этом думать, всё
    // сохраняется само». Значит включённость — состояние по умолчанию, а
    // выключение — осознанное действие одной переменной. На стенде копии не
    // копим, там стоит `BACKUP_SCHEDULER=off`.
    expect(schedulerEnabled({}), 'сервер заказчика: ничего не настраивал').toBe(true);
    expect(schedulerEnabled({ BACKUP_SCHEDULER: 'off' }), 'стенд').toBe(false);
    // Любое другое значение — не выключение: «0», «false» и опечатка не должны
    // тихо лишить заказчика копий.
    expect(schedulerEnabled({ BACKUP_SCHEDULER: 'on' })).toBe(true);
    expect(schedulerEnabled({ BACKUP_SCHEDULER: 'false' })).toBe(true);
    expect(schedulerEnabled({ BACKUP_SCHEDULER: '' })).toBe(true);
    // Процесс бота поднимает те же модули: будильник должен быть у одного.
    expect(schedulerEnabled({ VITEST: '1' })).toBe(false);
  });

  it('до срока копия не делается', async () => {
    const at = backup.at;
    // В 00:xx «часом раньше» не бывает — тогда проверять нечего, а не врать.
    if (at.hour === 0) return;
    const fresh = new BackupScheduler(backup);
    const early = new Date();
    early.setHours(at.hour - 1, at.minute, 0, 0);
    expect(await fresh.tick(early)).toBe(false);
  });
});

describe('ротация', () => {
  it('на диске остаётся BACKUP_KEEP последних копий, записи журнала остаются все', async () => {
    const keep = backup.keep;
    expect(keep, 'прогон настраивает BACKUP_KEEP=3').toBe(3);

    // Копий должно стать больше, чем keep: к этому месту их уже две.
    while ((await mineOk()).length <= keep) {
      const row = await backup.run('manual', BigInt(userId.admin));
      remember(row.uid);
      expect(row.status, row.error ?? '').toBe('ok');
    }

    const rows = await mineOk();
    expect(rows.length).toBeGreaterThan(keep);

    const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.dump'));
    expect(files.length, `на диске ${files.join(', ')}`).toBe(keep);
    // На диске — именно последние, а не случайные.
    expect([...files].sort()).toEqual(
      rows
        .slice(0, keep)
        .map((r) => r.file_name)
        .sort(),
    );

    // Записи журнала ротация не удаляет: иначе через месяц журнал выглядел бы
    // так, будто система начала делать копии вчера.
    const gone = rows[keep]!;
    expect(fs.existsSync(path.join(DIR, gone.file_name))).toBe(false);
    expect((await journal(gone.uid)).status, 'запись вытесненной копии').toBe('ok');
  }, 300_000);
});

describe('неудача', () => {
  it('пишет причину в журнал и не оставляет обрубка', async () => {
    const prev = process.env.BACKUP_PG_DUMP;
    // Команды нет вовсе — ближайшее к настоящей беде «на сервере нет pg_dump».
    process.env.BACKUP_PG_DUMP = 'pg_dump-kotorogo-net';
    try {
      const row = await backup.run('schedule', null);
      remember(row.uid);
      expect(row.status).toBe('failed');
      expect(row.error, 'причина обязана быть записана словами').toMatch(/не запустился/);
      expect(row.sizeBytes).toBeNull();
      expect(row.sha256).toBeNull();

      const saved = await journal(row.uid);
      expect(saved.status).toBe('failed');
      expect(saved.error).toMatch(/не запустился/);
      expect(saved.finished_at, 'упавшая копия тоже закрыта по времени').not.toBeNull();

      // Недописанный файл хуже отсутствующего: его видно в каталоге, и его
      // можно принять за копию.
      expect(fs.existsSync(path.join(DIR, row.fileName))).toBe(false);
    } finally {
      process.env.BACKUP_PG_DUMP = prev;
    }
  }, 60_000);

  it('без BACKUP_DATABASE_URL копия не делается, а не берёт прикладную роль', async () => {
    // Подстановка рабочего адреса дала бы дамп прикладной ролью: таблицы с
    // `FORCE ROW LEVEL SECURITY` вывезлись бы пустыми при нулевом коде выхода.
    // Такую копию не отличить от настоящей до попытки восстановиться, поэтому
    // отсутствие адреса — отказ, а не умолчание.
    const prev = process.env.BACKUP_DATABASE_URL;
    delete process.env.BACKUP_DATABASE_URL;
    try {
      const row = await backup.run('schedule', null);
      remember(row.uid);
      expect(row.status).toBe('failed');
      expect(row.error).toMatch(/BACKUP_DATABASE_URL/);
      expect(row.error, 'сказано, чем это кончилось бы').toMatch(/пуст/);
    } finally {
      process.env.BACKUP_DATABASE_URL = prev;
    }
  }, 60_000);

  it('упавшая копия становится уведомлением администратору, а не строкой в логе', async () => {
    // Бот пишет только тем, у кого есть привязка и кто его не заблокировал.
    await db.query(
      `UPDATE user_account SET telegram_user_id = $2, telegram_blocked = false WHERE id = $1`,
      [userId.admin, 700000000 + Number(stamp)],
    );
    await db.query(`DELETE FROM notification_outbox WHERE user_id = $1`, [userId.admin]);

    const prev = process.env.BACKUP_PG_DUMP;
    process.env.BACKUP_PG_DUMP = 'pg_dump-kotorogo-net';
    let failed: string;
    try {
      const row = await backup.run('schedule', null);
      remember(row.uid);
      expect(row.status).toBe('failed');
      failed = row.uid;
    } finally {
      process.env.BACKUP_PG_DUMP = prev;
    }

    await notifications.scan();

    const queued = (
      await db.query(
        `SELECT dedupe_key, text_ru, text_uz FROM notification_outbox
          WHERE user_id = $1 AND kind = 'backup_failed'`,
        [userId.admin],
      )
    ).rows as { dedupe_key: string; text_ru: string; text_uz: string }[];

    const mine = queued.find((q) => q.dedupe_key === `backup:${failed}`);
    expect(mine, `в очереди ${queued.map((q) => q.dedupe_key).join(', ') || 'пусто'}`).toBeTruthy();
    // Текст называет причину и говорит, что делать: «что-то сломалось» в три
    // ночи не помогает никому.
    expect(mine!.text_ru).toMatch(/Копия базы не сделалась/);
    expect(mine!.text_ru).toMatch(/не запустился/);
    expect(mine!.text_ru).toMatch(/Сделать копию сейчас/);
    expect(mine!.text_uz).toMatch(/Baza nusxasi olinmadi/);
    expect(mine!.text_uz).toMatch(/Hozir nusxa olish/);

    // Второй проход того же события не повторяет: «не сделалась» не перестаёт
    // быть правдой, и без ключа повтора админ получал бы её каждые пять минут.
    await notifications.scan();
    const again = Number(
      (
        await db.query(
          `SELECT count(*)::int AS n FROM notification_outbox
            WHERE user_id = $1 AND dedupe_key = $2`,
          [userId.admin, `backup:${failed}`],
        )
      ).rows[0].n,
    );
    expect(again).toBe(1);

    await db.query(`UPDATE user_account SET telegram_user_id = NULL WHERE id = $1`, [userId.admin]);
  }, 120_000);

  it('кладовщику про упавшую копию не пишут', async () => {
    // Вид висит на праве «Настройки». Уведомление «база без копии» человеку,
    // который ничего с этим сделать не может, — это шум, который учит не
    // читать уведомления.
    const kind = KIND_BY_CODE.get('backup_failed');
    expect(kind, 'вид backup_failed обязан быть в KINDS').toBeTruthy();
    expect(kind!.permission).toBe('admin.users');
    expect(kind!.group).toBe('system');
    // Группа заведена не ради одного вида: её должен знать бот, иначе
    // переключателя не будет и выключить уведомление будет нечем.
    expect(KINDS.filter((k) => k.group === 'system').length).toBeGreaterThan(0);

    const row = (
      await db.query(
        `SELECT count(*)::int AS n FROM notification_outbox
          WHERE user_id = $1 AND kind = 'backup_failed'`,
        [userId.warehouse_keeper],
      )
    ).rows[0] as { n: number };
    expect(row.n).toBe(0);
  });
});

describe('право на маршрут', () => {
  it('администратор видит список и настройки', async () => {
    const res = await as('admin', '/api/v1/admin/backups');
    expect(res.status).toBe(200);
    expect(res.body.data.settings.dir).toBe(DIR);
    expect(res.body.data.settings.keep).toBe(3);
    expect(res.body.data.rows.length).toBeGreaterThan(0);
    // Экран решает по `onDisk`, можно ли скачать: поле обязано приходить.
    expect(typeof res.body.data.rows[0].onDisk).toBe('boolean');
  });

  it('кладовщику список, запуск и файл закрыты — 403 на каждом', async () => {
    const uid = made[0]!;
    for (const [method, p] of [
      ['GET', '/api/v1/admin/backups'],
      ['POST', '/api/v1/admin/backups'],
      ['GET', `/api/v1/admin/backups/${uid}/file`],
    ] as const) {
      const res = await as('warehouse_keeper', p, { method });
      expect(res.status, `${method} ${p}`).toBe(403);
    }
  });

  it('без входа маршрут не отвечает данными', async () => {
    const res = await api('/api/v1/admin/backups');
    expect(res.status).toBe(401);
  });

  it('файл отдаётся потоком с именем копии, а не JSON-конвертом', async () => {
    const row = (await mineOk())[0]!;
    const res = await fetch(`${base}/api/v1/admin/backups/${row.uid}/file`, {
      headers: { Authorization: `Bearer ${token.admin}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toContain(row.file_name);
    // Копия базы — это вся база: ни в общий кэш, ни в чужой прокси.
    expect(res.headers.get('cache-control')).toContain('no-store');

    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(0, 5).toString(), 'пришёл не дамп').toBe('PGDMP');
    expect(bytes.length).toBe(fs.statSync(path.join(DIR, row.file_name)).size);
  }, 60_000);

  it('вытесненная ротацией копия не скачивается, и причина названа', async () => {
    const rows = await mineOk();
    const gone = rows[rows.length - 1]!;
    expect(fs.existsSync(path.join(DIR, gone.file_name)), 'эта копия должна быть вытеснена').toBe(
      false,
    );

    const res = await as('admin', `/api/v1/admin/backups/${gone.uid}/file`);
    expect(res.status).toBe(404);
    expect(res.body.error.message).toMatch(/удал/);
  });

  it('чужой uid — 404, мусор вместо uid — 400', async () => {
    const absent = await as(
      'admin',
      '/api/v1/admin/backups/0199c2a0-0000-7000-8000-000000000999/file',
    );
    expect(absent.status).toBe(404);
    const junk = await as('admin', '/api/v1/admin/backups/not-a-uuid/file');
    expect(junk.status).toBe(400);
  });
});
