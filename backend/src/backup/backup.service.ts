import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { PrismaService } from '../prisma/prisma.service.js';
import { say } from '../common/say.js';

/**
 * Ежедневная резервная копия базы средствами самой системы (требование
 * Отабека от 07.10).
 *
 * **Где лежит копия.** Заказчик сказал «сохранять она будет у себя в бд».
 * Копию базы нельзя держать внутри самой базы: она защищает ровно от того,
 * что базы не стало, а копия внутри неё исчезнет вместе с ней. Поэтому дамп
 * пишется на диск сервера, рядом с системой, в отдельный каталог
 * `BACKUP_DIR`. Это и есть «у себя» — не чужое облако, чего заказчик и просил.
 *
 * **Чем делается.** `pg_dump` в своём формате (`--format=custom`) со сжатием:
 * он восстанавливается `pg_restore` в любую другую базу, в отличие от простого
 * текста, который можно залить только целиком и только psql'ом.
 *
 * Команда задаётся переменной `BACKUP_PG_DUMP`, по умолчанию `pg_dump`. На
 * стенде база живёт в контейнере, а клиента PostgreSQL на хосте нет, поэтому
 * там переменная выглядит так:
 * `docker exec -i -e PGPASSWORD metall-asia-postgres pg_dump`.
 * Форма `-e PGPASSWORD` без значения — осознанно: пароль приходит из окружения
 * дочернего процесса и не попадает ни в `ps`, ни в журнал.
 *
 * **Почему поток, а не `--file`.** `pg_dump -f` пишет файл там, где он сам
 * работает, то есть внутри контейнера — а копия нужна на диске сервера.
 * Поэтому дамп идёт в stdout, а мы считаем его в файл и по тому же проходу
 * считаем sha256 и размер: второй раз файл читать не нужно.
 *
 * **Кто узнает о неудаче.** Этот сервис никому не пишет сам: он пишет строку
 * `status='failed'` в журнал. Сообщение администратору собирает существующий
 * тракт уведомлений по виду `backup_failed`
 * (`notifications/kinds.ts`, `notifications.service.ts`) и отправляет бот.
 * Своего отправителя здесь нет намеренно: второй путь в Telegram означал бы
 * второй набор правил «кому писать» и «что человек выключил», и они разошлись
 * бы с первым.
 */

export interface BackupRow {
  uid: string;
  status: string;
  source: string;
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
  fileName: string;
  sizeBytes: number | null;
  sha256: string | null;
  error: string | null;
  starterName: string | null;
  /** Файл ещё на диске. Копия старше срока хранения — запись есть, файла нет. */
  onDisk: boolean;
}

interface Conn {
  host: string;
  port: string;
  user: string;
  db: string;
  password: string;
}

/** Сколько копий держим на диске. Старше — удаляются после удачной новой. */
const KEEP_DEFAULT = 30;

/** Дамп, который не успел за это время, считаем зависшим. */
const TIMEOUT_MS = 30 * 60_000;

@Injectable()
export class BackupService {
  private readonly log = new Logger('backup');
  /** Замок на процесс: два `pg_dump` одновременно только мешают друг другу. */
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  /** Каталог копий. Относительный путь — от рабочего каталога службы. */
  get dir(): string {
    return path.resolve(process.env.BACKUP_DIR ?? './var/backups');
  }

  get keep(): number {
    const n = Number(process.env.BACKUP_KEEP ?? KEEP_DEFAULT);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : KEEP_DEFAULT;
  }

  /**
   * Во сколько ночью делать копию, `HH:MM` местного времени сервера.
   * Ночь по умолчанию: днём дамп отнимает диск и процессор у работающих людей.
   */
  get at(): { hour: number; minute: number } {
    const raw = process.env.BACKUP_AT ?? '03:20';
    const m = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
    const hour = m ? Number(m[1]) : 3;
    const minute = m ? Number(m[2]) : 20;
    if (!m || hour > 23 || minute > 59) {
      this.log.warn(`BACKUP_AT=${raw} не похоже на время, беру 03:20`);
      return { hour: 3, minute: 20 };
    }
    return { hour, minute };
  }

  // --- копия ----------------------------------------------------------------

  /**
   * Сделать копию. Возвращает строку журнала — удачную или упавшую.
   *
   * Исключение наружу не летит: расписание не должно падать от недоступной
   * базы, а кнопка должна показать человеку причину, а не пустой экран.
   */
  async run(source: 'schedule' | 'manual', startedBy: bigint | null): Promise<BackupRow> {
    if (this.running) {
      throw new BadRequestException(say('Копия уже делается', 'Nusxa allaqachon olinmoqda'));
    }
    this.running = true;
    const started = Date.now();
    // Номер журнала берём до имени файла, потому что он в это имя входит.
    const id = await this.nextId();
    const fileName = `metall-asia-${stamp(new Date())}-${id}.dump`;
    await this.open(id, fileName, source, startedBy);
    try {
      await fs.mkdir(this.dir, { recursive: true });
      const { size, sha256 } = await this.dump(path.join(this.dir, fileName));
      // Пустой файл — это не копия. Дамп самой маленькой базы весит килобайты,
      // так что нижняя граница здесь не про «мало данных», а про «ничего не
      // записалось, а код выхода соврал».
      if (size < 1024) throw new Error(`файл копии пустой: ${size} байт`);
      await this.close(id, { size, sha256, durationMs: Date.now() - started });
      this.log.log(`копия ${fileName}: ${human(size)} за ${Math.round((Date.now() - started) / 1000)} с`);
      await this.rotate();
    } catch (e) {
      const message = (e as Error).message;
      await this.fail(id, message, Date.now() - started);
      // Недописанный файл на диске хуже отсутствующего: его видно в каталоге,
      // и его можно принять за копию.
      await fs.rm(path.join(this.dir, fileName), { force: true }).catch(() => {});
      this.log.error(`копия не сделана: ${message}`);
    } finally {
      this.running = false;
    }
    const row = await this.one(id);
    if (!row) throw new Error('строка журнала копий исчезла сразу после записи');
    return row;
  }

  /** Запустить `pg_dump`, считая поток в файл и в хеш одновременно. */
  private dump(target: string): Promise<{ size: number; sha256: string }> {
    const conn = this.conn();
    const argv = (process.env.BACKUP_PG_DUMP ?? 'pg_dump').trim().split(/\s+/);
    const args = [
      ...argv.slice(1),
      '--format=custom',
      '--compress=9',
      `--host=${conn.host}`,
      `--port=${conn.port}`,
      `--username=${conn.user}`,
      `--dbname=${conn.db}`,
    ];

    return new Promise((resolve, reject) => {
      const child = spawn(argv[0], args, {
        env: { ...process.env, PGPASSWORD: conn.password },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const out = createWriteStream(target);
      const hash = createHash('sha256');
      let size = 0;
      let stderr = '';
      // Промах один: `reject` после `resolve` ничего не делает, а вот запись в
      // журнал двумя путями сразу — делает, и строка копии становится то
      // удачной, то упавшей.
      let settled = false;
      const fail = (e: Error) => {
        if (settled) return;
        settled = true;
        reject(e);
      };
      const done = (v: { size: number; sha256: string }) => {
        if (settled) return;
        settled = true;
        resolve(v);
      };
      const kill = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);

      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        hash.update(chunk);
      });
      child.stdout.pipe(out);
      child.stderr.on('data', (chunk: Buffer) => {
        // Хвост, а не всё: ошибка живёт в последних строках, а в начале бывает
        // мегабайт предупреждений, и он уйдёт в столбец журнала.
        stderr = (stderr + chunk.toString()).slice(-2000);
      });

      // Диск кончился, каталог только для чтения, файл кто-то убрал из-под
      // руки — это ошибка записи, а не ошибка `pg_dump`. Без обработчика поток
      // роняет весь процесс службы необработанным событием, и копия забирает
      // с собой работающую систему. Ровно та цена, которой бэкап не стоит.
      out.on('error', (e) => {
        clearTimeout(kill);
        child.kill('SIGKILL');
        fail(new Error(`не удалось записать ${target}: ${e.message}`));
      });

      child.on('error', (e) => {
        clearTimeout(kill);
        out.destroy();
        fail(new Error(`${argv[0]} не запустился: ${e.message}`));
      });
      child.on('close', (code, signal) => {
        clearTimeout(kill);
        // Файл закрываем до разбора кода выхода: иначе удачная копия вернулась
        // бы вызывающему раньше, чем последние байты легли на диск, и `stat`
        // в журнале показал бы размер меньше настоящего.
        out.end(() => {
          if (signal === 'SIGKILL') {
            fail(new Error(`pg_dump не уложился в ${TIMEOUT_MS / 60_000} минут`));
          } else if (code !== 0) {
            fail(new Error(`pg_dump вышел с кодом ${code}: ${stderr.trim() || 'без вывода'}`));
          } else {
            done({ size, sha256: hash.digest('hex') });
          }
        });
      });
    });
  }

  /**
   * Подключение для `pg_dump`.
   *
   * Своя переменная, а не та, по которой работает служба, и подстановки одной
   * вместо другой здесь нет — по двум причинам.
   *
   * Первая: `pg_dump` работает не там, где служба. На стенде база в контейнере,
   * внутри него порт 5432, а со стороны хоста тот же сервер виден как 5433.
   *
   * Вторая, важнее: роль для дампа должна обходить RLS — та же, под которой
   * идут миграции. Прикладная роль (`NOBYPASSRLS`), которой ходит служба,
   * вывезет таблицы с `FORCE ROW LEVEL SECURITY` пустыми, и об этом не узнает
   * никто: код выхода нулевой, файл на месте, размер правдоподобный. Молчаливая
   * подстановка рабочего адреса дала бы ровно такую копию, поэтому адрес
   * задаётся явно, а без него копия не делается вовсе.
   */
  private conn(): Conn {
    const raw = process.env.BACKUP_DATABASE_URL;
    if (!raw) {
      throw new Error(
        'не задана BACKUP_DATABASE_URL: нужен адрес базы ролью-владельцем схемы, ' +
          'прикладной ролью дамп выйдет пустым',
      );
    }
    const u = new URL(raw);
    return {
      host: u.hostname,
      port: u.port || '5432',
      user: decodeURIComponent(u.username),
      db: u.pathname.replace(/^\//, ''),
      password: decodeURIComponent(u.password),
    };
  }

  /**
   * Удалить лишние файлы, оставив `keep` последних удачных.
   *
   * Удаляются файлы, а записи журнала остаются: по ним видно, что копия в тот
   * день была. Иначе через месяц журнал выглядит так, будто система начала
   * делать копии вчера.
   */
  private async rotate(): Promise<void> {
    const rows = await this.prisma.withContext(null, [], (tx) =>
      tx.$queryRaw<{ file_name: string }[]>`
        SELECT file_name FROM db_backup
         WHERE status = 'ok' ORDER BY started_at DESC OFFSET ${this.keep}`,
    );
    for (const r of rows) {
      await fs.rm(path.join(this.dir, r.file_name), { force: true }).catch(() => {});
    }
    // Файлы, которых нет в журнале, не трогаем: каталог может быть не только
    // наш, и удалять в нём чужое — не наше дело.
  }

  // --- журнал ---------------------------------------------------------------

  /**
   * Номер будущей записи журнала — он же хвост имени файла.
   *
   * Имя из одного времени начала не годится: двух копий в одну секунду
   * достаточно, чтобы вторая записалась в тот же файл, а в журнале осталось две
   * строки про один файл — с размером и sha256 от разных дампов. Ротация потом
   * удаляет этот файл по одной строке, и вторая строка показывает копию,
   * которой нет. Нашлось тестом `backup.e2e.spec.ts` на четырёх копиях подряд.
   *
   * Номер берётся из той же последовательности, что поставит `bigserial`, и
   * вставляется явно: подбор свободного имени перебором («-2», «-3») — это
   * проверка и запись двумя шагами, то есть гонка между двумя процессами.
   * Заодно файл в каталоге читается глазами вместе со своей строкой журнала.
   */
  private nextId(): Promise<bigint> {
    return this.prisma.withContext(null, [], async (tx) => {
      const rows = await tx.$queryRaw<{ id: bigint }[]>`
        SELECT nextval(pg_get_serial_sequence('db_backup', 'id')) AS id`;
      return BigInt(rows[0].id);
    });
  }

  private open(
    id: bigint,
    fileName: string,
    source: string,
    startedBy: bigint | null,
  ): Promise<void> {
    return this.prisma.withContext(null, [], async (tx) => {
      await tx.$executeRaw`
        INSERT INTO db_backup (id, file_name, source, started_by)
        VALUES (${id}, ${fileName}, ${source}, ${startedBy})`;
    });
  }

  private close(
    id: bigint,
    done: { size: number; sha256: string; durationMs: number },
  ): Promise<void> {
    return this.prisma.withContext(null, [], async (tx) => {
      await tx.$executeRaw`
        UPDATE db_backup
           SET status = 'ok', finished_at = now(), duration_ms = ${done.durationMs},
               size_bytes = ${BigInt(done.size)}, sha256 = ${done.sha256}, error = NULL
         WHERE id = ${id}`;
    });
  }

  private fail(id: bigint, error: string, durationMs: number): Promise<void> {
    return this.prisma.withContext(null, [], async (tx) => {
      await tx.$executeRaw`
        UPDATE db_backup
           SET status = 'failed', finished_at = now(), duration_ms = ${durationMs},
               error = ${error.slice(0, 2000)}
         WHERE id = ${id}`;
    });
  }

  /**
   * Была ли сегодня удачная копия по расписанию.
   *
   * Расписание помнит сделанный день в памяти процесса, и этой памяти хватает
   * ровно до перезапуска службы. Выкатка в рабочий день перезапускает её — и
   * каждый перезапуск после 03:20 начинал бы новый `pg_dump`. Журнал помнит
   * дольше процесса, поэтому спрашиваем его.
   */
  madeToday(now = new Date()): Promise<boolean> {
    const day = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
    return this.prisma.withContext(null, [], async (tx) => {
      const rows = await tx.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM db_backup
         WHERE source = 'schedule' AND status = 'ok'
           AND started_at::date = ${day}::date`;
      return Number(rows[0].n) > 0;
    });
  }

  /** Последние копии для экрана настроек. */
  async list(limit = 60): Promise<BackupRow[]> {
    const rows = await this.prisma.withContext(null, [], (tx) =>
      tx.$queryRaw<RawRow[]>`
        SELECT b.uid, b.status, b.source, b.started_at, b.finished_at, b.duration_ms,
               b.file_name, b.size_bytes, b.sha256, b.error, u.full_name AS starter_name
          FROM db_backup b LEFT JOIN user_account u ON u.id = b.started_by
         ORDER BY b.started_at DESC LIMIT ${limit}`,
    );
    return Promise.all(rows.map((r) => this.shape(r)));
  }

  private async one(id: bigint): Promise<BackupRow | null> {
    const rows = await this.prisma.withContext(null, [], (tx) =>
      tx.$queryRaw<RawRow[]>`
        SELECT b.uid, b.status, b.source, b.started_at, b.finished_at, b.duration_ms,
               b.file_name, b.size_bytes, b.sha256, b.error, u.full_name AS starter_name
          FROM db_backup b LEFT JOIN user_account u ON u.id = b.started_by
         WHERE b.id = ${id}`,
    );
    return rows[0] ? this.shape(rows[0]) : null;
  }

  private async shape(r: RawRow): Promise<BackupRow> {
    return {
      uid: r.uid,
      status: r.status,
      source: r.source,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      durationMs: r.duration_ms,
      fileName: r.file_name,
      sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes),
      sha256: r.sha256,
      error: r.error,
      starterName: r.starter_name,
      onDisk: await exists(path.join(this.dir, r.file_name)),
    };
  }

  /**
   * Файл копии для скачивания.
   *
   * Отдаём путь, а не байты: копия базы — это десятки мегабайт, и держать её
   * в памяти целиком незачем, когда поток делает то же самое.
   */
  async file(uid: string): Promise<{ fileName: string; full: string; size: number }> {
    const rows = await this.prisma.withContext(null, [], (tx) =>
      tx.$queryRaw<{ file_name: string; status: string }[]>`
        SELECT file_name, status FROM db_backup WHERE uid = ${uid}::uuid`,
    );
    const row = rows[0];
    if (!row) throw new NotFoundException(say('Копия не найдена', 'Nusxa topilmadi'));
    if (row.status !== 'ok') {
      throw new BadRequestException(
        say('Эта копия не сделана, скачивать нечего', 'Bu nusxa olinmagan, yuklab olishga narsa yo‘q'),
      );
    }
    const full = path.join(this.dir, row.file_name);
    const stat = await fs.stat(full).catch(() => null);
    if (!stat) {
      throw new NotFoundException(
        say(
          'Файл копии уже удалён по сроку хранения',
          'Nusxa fayli saqlash muddati tugab, allaqachon o‘chirilgan',
        ),
      );
    }
    return { fileName: row.file_name, full, size: stat.size };
  }

  /** Что показать на экране над списком: куда пишем, во сколько, сколько храним. */
  settings() {
    const { hour, minute } = this.at;
    return {
      dir: this.dir,
      at: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
      keep: this.keep,
      // Та же переменная, что у будильника (`backup.scheduler.ts`,
      // `schedulerEnabled`), но без оговорки про `VITEST`: экран показывает,
      // что настроено на сервере, а не завёлся ли таймер в этом процессе.
      scheduler: process.env.BACKUP_SCHEDULER !== 'off',
    };
  }
}

interface RawRow {
  uid: string;
  status: string;
  source: string;
  started_at: Date;
  finished_at: Date | null;
  duration_ms: number | null;
  file_name: string;
  size_bytes: bigint | null;
  sha256: string | null;
  error: string | null;
  starter_name: string | null;
}

const exists = (p: string) =>
  fs
    .access(p)
    .then(() => true)
    .catch(() => false);

/**
 * Время начала в имени файла: сортировка по имени совпадает с хронологией.
 * Секунды — чтобы две копии кнопкой в одну минуту не оказались рядом по имени;
 * от совпадения имён защищает не время, а номер журнала (см. `nextId`).
 */
const stamp = (d: Date) =>
  [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
    '-',
    String(d.getHours()).padStart(2, '0'),
    String(d.getMinutes()).padStart(2, '0'),
    String(d.getSeconds()).padStart(2, '0'),
  ].join('');

const human = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} МБ` : `${Math.round(bytes / 1024)} КБ`;
