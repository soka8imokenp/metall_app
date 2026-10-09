-- Согласование и версии документа (ТЗ 7.4).

-- Последнее движение по маршруту: кто, когда и с какими словами.
--
-- Комментарий живёт на самом документе, а не только в журнале, потому что
-- читают его не в истории, а в карточке: «вернули — почему?» должно быть
-- видно там же, где статус. Полный след остаётся в `audit_log`.
ALTER TABLE "document" ADD COLUMN "status_comment" TEXT;
ALTER TABLE "document" ADD COLUMN "status_at"      TIMESTAMPTZ;
ALTER TABLE "document" ADD COLUMN "status_by"      BIGINT REFERENCES "user_account"("id");

-- Предыдущие редакции документа.
--
-- Правка утверждённого документа не переписывает его: прежняя редакция
-- уходит сюда целиком — со своими суммами, строками, реквизитами, шаблоном и
-- собранным PDF. Счёт на 100 млн, который уже ушёл клиенту, обязан остаться
-- тем, каким ушёл, даже если в системе его переписали на 120.
--
-- Строки лежат снимком в JSONB, а не отдельной таблицей: их не ищут и не
-- соединяют, их печатают. Отдельная таблица `document_line_version` дала бы
-- вторую копию всех правил работы со строками ради одной операции чтения.
CREATE TABLE "document_version" (
  "id"            BIGSERIAL PRIMARY KEY,
  "uid"           UUID NOT NULL DEFAULT gen_random_uuid(),
  "company_id"    BIGINT NOT NULL REFERENCES "company"("id"),
  "document_id"   BIGINT NOT NULL REFERENCES "document"("id") ON DELETE CASCADE,
  "version"       INTEGER NOT NULL,
  "status"        "DocumentStatus" NOT NULL,
  "document_date" DATE NOT NULL,
  "locale"        "Locale" NOT NULL,
  "amount_net"    NUMERIC(20, 4),
  "amount_vat"    NUMERIC(20, 4),
  "amount_total"  NUMERIC(20, 4),
  "requisites"    JSONB,
  "lines"         JSONB NOT NULL DEFAULT '[]',
  -- Каким шаблоном и каким файлом эта редакция была напечатана.
  "template_id"   BIGINT REFERENCES "document_template"("id"),
  "pdf_key"       TEXT,
  "pdf_size"      INTEGER,
  "replaced_by"   BIGINT REFERENCES "user_account"("id"),
  "replaced_at"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "document_version_version_positive" CHECK ("version" > 0)
);
CREATE UNIQUE INDEX "document_version_uid_key" ON "document_version"("uid");
CREATE UNIQUE INDEX "document_version_key" ON "document_version"("document_id", "version");

ALTER TABLE "document_version" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "document_version" FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON "document_version"
  USING (company_id = ANY (app.current_company_ids()))
  WITH CHECK (company_id = ANY (app.current_company_ids()));
