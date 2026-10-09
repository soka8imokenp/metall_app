-- Журнал резервных копий базы (требование Отабека от 07.10).
--
-- Копию делает сама система по расписанию, а не cron операционной системы:
-- система уезжает на сервер заказчика целиком, и там никто не будет
-- дописывать crontab. Строка в этой таблице — единственное доказательство,
-- что копия была: файл могут удалить, а запись о нём останется.
--
-- Политик RLS здесь нет сознательно. Копия — это вся база целиком, а не
-- данные одного юридического лица: делить её по company_id нечего. Таблица
-- системная, как `user_account` и `password_reset_request`, — подробности в
-- `prisma.service.ts` и в миграции `auth_without_bypassrls`.
CREATE TABLE IF NOT EXISTS "db_backup" (
  "id"          bigserial PRIMARY KEY,
  "uid"         uuid NOT NULL DEFAULT gen_random_uuid(),
  -- running → ok | failed. Строка заводится до запуска pg_dump: упавший
  -- процесс иначе не оставил бы следа вообще.
  "status"      text NOT NULL DEFAULT 'running',
  -- schedule — по расписанию, manual — кнопкой «Сделать копию сейчас».
  "source"      text NOT NULL DEFAULT 'schedule',
  "started_at"  timestamptz(6) NOT NULL DEFAULT now(),
  "finished_at" timestamptz(6),
  "duration_ms" integer,
  "file_name"   text NOT NULL,
  "size_bytes"  bigint,
  -- Контроль целостности: размер отвечает «файл не пустой», sha256 — «файл
  -- тот самый». Считается на лету, при записи потока, вторым чтением файла.
  "sha256"      text,
  "error"       text,
  -- Кто нажал кнопку. Расписание не нажимает никто, поэтому NULL допустим.
  "started_by"  bigint REFERENCES "user_account"("id") ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "db_backup_uid_key" ON "db_backup" ("uid");
CREATE INDEX IF NOT EXISTS "db_backup_started_at_idx" ON "db_backup" ("started_at" DESC);
-- Уведомление об упавшей копии ищет по этому разрезу.
CREATE INDEX IF NOT EXISTS "db_backup_status_idx" ON "db_backup" ("status", "started_at" DESC);
