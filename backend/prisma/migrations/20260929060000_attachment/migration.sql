-- Вложения к операциям: фото, сканы, сертификат качества партии.
-- ТЗ 5.4 («каждая операция несёт ... вложения (фото, сканы)»), 5.6
-- («сертификат качества (файл)» у партии), 6.3 («фото чека, скан накладной»
-- у финансовой операции).
--
-- Файл лежит на диске, в базе — только описание и ключ. Складывать байты в
-- Postgres значит тащить их через каждый дамп и каждую репликацию: у одного
-- скана накладной вес как у сотни тысяч строк движений.
--
-- Владелец вложения — не полиморфная пара «тип + id», а три отдельных ссылки,
-- из которых заполнена ровно одна. Так за целостность отвечает сама база:
-- удалили движение — вложение уходит каскадом, а не остаётся сиротой, на
-- которую однажды наткнётся выдача файла.

CREATE TYPE "AttachmentKind" AS ENUM ('photo', 'scan', 'certificate', 'other');

CREATE TABLE "attachment" (
  "id"                   BIGSERIAL PRIMARY KEY,
  "uid"                  UUID NOT NULL DEFAULT gen_random_uuid(),
  "company_id"           BIGINT NOT NULL REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "stock_move_id"        BIGINT REFERENCES "stock_move"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "batch_id"             BIGINT REFERENCES "batch"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "finance_operation_id" BIGINT REFERENCES "finance_operation"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "kind"                 "AttachmentKind" NOT NULL DEFAULT 'other',
  "file_name"            TEXT NOT NULL,
  "mime_type"            TEXT NOT NULL,
  "size_bytes"           INTEGER NOT NULL,
  "sha256"               CHAR(64) NOT NULL,
  "storage_key"          TEXT NOT NULL,
  "comment"              TEXT,
  "created_by"           BIGINT,
  "created_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "attachment_uid_key" ON "attachment"("uid");

-- Ключ на диске один на вложение: два описания одного файла означают, что
-- удаление первого утащит файл у второго.
CREATE UNIQUE INDEX "attachment_storage_key_key" ON "attachment"("storage_key");

-- Ровно один владелец. Ноль владельцев — файл, которого никто не найдёт;
-- два — файл, который удалится вместе с первым из них и пропадёт у второго.
ALTER TABLE "attachment"
  ADD CONSTRAINT "attachment_one_owner"
  CHECK (num_nonnulls("stock_move_id", "batch_id", "finance_operation_id") = 1);

-- Предел веса стоит и в базе, а не только в приложении: приложение можно
-- обойти сидом, скриптом или чужой ветвью кода, а это ограничение — нельзя.
-- 20 МиБ — фотография с телефона и многостраничный скан проходят, видео нет.
ALTER TABLE "attachment"
  ADD CONSTRAINT "attachment_size_sane"
  CHECK ("size_bytes" > 0 AND "size_bytes" <= 20971520);

-- Пустое имя и кривой хеш ловим здесь же: имя уходит в Content-Disposition,
-- хеш — единственный способ потом сказать, что файл на диске тот самый.
ALTER TABLE "attachment"
  ADD CONSTRAINT "attachment_file_name_not_blank"
  CHECK (btrim("file_name") <> '');

ALTER TABLE "attachment"
  ADD CONSTRAINT "attachment_sha256_hex"
  CHECK ("sha256" ~ '^[0-9a-f]{64}$');

ALTER TABLE "attachment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attachment" FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON "attachment"
  USING (company_id = ANY (app.current_company_ids()))
  WITH CHECK (company_id = ANY (app.current_company_ids()));

-- Карточка операции спрашивает свои вложения по владельцу, поэтому индекс на
-- каждую ссылку отдельно: запрос всегда идёт по одной из трёх.
CREATE INDEX "attachment_stock_move_idx" ON "attachment"("stock_move_id");
CREATE INDEX "attachment_batch_idx" ON "attachment"("batch_id");
CREATE INDEX "attachment_finance_operation_idx" ON "attachment"("finance_operation_id");
