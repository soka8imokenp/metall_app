-- Шаблоны печатных форм (ТЗ 7.2).
--
-- Печатная форма — файл, а не код. Заказчик меняет свои бумаги, не трогая
-- систему: загрузил новый шаблон — со следующего документа печатается он.
--
-- Русская и узбекская версии — две строки, а не одна с двумя файлами: ТЗ 7.2
-- требует два файла, и у них своя жизнь — узбекский могут обновить, а русский
-- оставить.
--
-- Файл лежит в самой таблице, а не на диске рядом с вложениями. Вложения —
-- пользовательские файлы: их много, они тяжёлые, и потеря одного фото приёмки
-- не ломает систему. Шаблон — часть настройки: он лёгкий, их десяток, и без
-- него перестают печататься документы. В дампе базы он обязан быть вместе с
-- типами документов, а не отдельным архивом каталога.
CREATE TABLE "document_template" (
  "id"               BIGSERIAL PRIMARY KEY,
  "uid"              UUID NOT NULL DEFAULT gen_random_uuid(),
  "company_id"       BIGINT NOT NULL REFERENCES "company"("id"),
  "document_type_id" BIGINT NOT NULL REFERENCES "document_type"("id"),
  "locale"           "Locale" NOT NULL,
  "version"          INTEGER NOT NULL,
  "file_name"        TEXT NOT NULL,
  "file_size"        INTEGER NOT NULL,
  "content"          BYTEA NOT NULL,
  -- Теги, вычитанные из самого файла. Ими администратор и сопоставляет
  -- плейсхолдеры с полями системы: сопоставлять было бы не с чем, если не
  -- прочитать их из загруженного документа.
  "tags"             JSONB NOT NULL DEFAULT '[]',
  -- Чужое имя тега → поле системы. Нужен, когда в бумаге заказчика уже
  -- написано {НомерСчета}, а переписывать его файл мы не вправе.
  "field_map"        JSONB NOT NULL DEFAULT '{}',
  "is_published"     BOOLEAN NOT NULL DEFAULT false,
  "created_by"       BIGINT REFERENCES "user_account"("id"),
  "created_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),
  "published_at"     TIMESTAMPTZ,
  CONSTRAINT "document_template_size_positive" CHECK ("file_size" > 0)
);
CREATE UNIQUE INDEX "document_template_uid_key" ON "document_template"("uid");
CREATE UNIQUE INDEX "document_template_version_key"
  ON "document_template"("document_type_id", "locale", "version");

-- Опубликованный шаблон на тип и язык ровно один: «какой из двух печатается»
-- — вопрос, которого не должно возникать.
CREATE UNIQUE INDEX "document_template_published_key"
  ON "document_template"("document_type_id", "locale")
  WHERE "is_published";

ALTER TABLE "document_template" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "document_template" FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON "document_template"
  USING (company_id = ANY (app.current_company_ids()))
  WITH CHECK (company_id = ANY (app.current_company_ids()));

-- Каким шаблоном документ напечатан.
--
-- Проставляется при первой сборке файла и дальше не меняется. Заказчик
-- обновил бумагу — новые документы печатаются новой, а у прошлых остаётся та,
-- которой они напечатаны и которая ушла клиенту. Без этой ссылки «перепечатай
-- мартовский счёт» давало бы сентябрьскую форму.
ALTER TABLE "document" ADD COLUMN "template_id" BIGINT REFERENCES "document_template"("id");
