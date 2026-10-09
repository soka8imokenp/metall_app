-- Задачи и активности CRM (ТЗ 8.4).
--
-- Две таблицы, а не одна, потому что это разные времена. Задача смотрит вперёд:
-- у неё есть срок, ответственный и она бывает просрочена. Активность смотрит
-- назад: звонок состоялся, письмо ушло, встреча прошла — срока у них нет и
-- просроченной активность не бывает. Одна таблица на оба смысла означала бы
-- колонку «срок», пустую у половины строк, и список просроченного, в который
-- попадают состоявшиеся звонки.

CREATE TYPE "CrmTaskType" AS ENUM ('call', 'meeting', 'letter', 'document', 'other');
CREATE TYPE "CrmTaskStatus" AS ENUM ('open', 'done', 'cancelled');
CREATE TYPE "CrmActivityType" AS ENUM ('call', 'meeting', 'letter', 'note');
CREATE TYPE "CrmActivityDirection" AS ENUM ('incoming', 'outgoing');

-- 1. Задача.
--
-- Связь с клиентом или сделкой обязательна (ТЗ 8.4: «связь с клиентом/сделкой»).
-- Задача без обеих — это личное напоминание, ему место в органайзере: в карточке
-- клиента и в карточке сделки такая строка не покажется никогда, и найти её
-- потом нельзя ничем, кроме списка «все задачи».
--
-- Закрытая задача обязана нести результат: строка «позвонить Ахмедову»,
-- отмеченная галочкой без единого слова, не говорит, дозвонились ли, и через
-- неделю работа делается заново. То же правило, что у отказа по обращению и
-- проигрыша по сделке.
CREATE TABLE "crm_task" (
  "id"          BIGSERIAL PRIMARY KEY,
  "uid"         UUID NOT NULL,
  "company_id"  BIGINT NOT NULL REFERENCES "company"("id"),
  "type"        "CrmTaskType" NOT NULL,
  "title"       TEXT NOT NULL,
  "description" TEXT,
  "due_at"      TIMESTAMPTZ NOT NULL,
  "assignee_id" BIGINT NOT NULL REFERENCES "user_account"("id"),
  "partner_id"  BIGINT REFERENCES "partner"("id"),
  "deal_id"     BIGINT REFERENCES "deal"("id") ON DELETE CASCADE,
  "status"      "CrmTaskStatus" NOT NULL DEFAULT 'open',
  "result"      TEXT,
  "version"     INTEGER NOT NULL DEFAULT 1,
  "created_by"  BIGINT REFERENCES "user_account"("id"),
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  "closed_at"   TIMESTAMPTZ,
  CONSTRAINT "crm_task_needs_owner"
    CHECK ("partner_id" IS NOT NULL OR "deal_id" IS NOT NULL),
  CONSTRAINT "crm_task_closed_needs_result"
    CHECK ("status" = 'open' OR ("result" IS NOT NULL AND "closed_at" IS NOT NULL))
);
CREATE UNIQUE INDEX "crm_task_uid_key" ON "crm_task"("uid");
CREATE INDEX "crm_task_due_idx" ON "crm_task"("company_id", "status", "due_at");
CREATE INDEX "crm_task_assignee_idx" ON "crm_task"("assignee_id", "status", "due_at");
CREATE INDEX "crm_task_partner_idx" ON "crm_task"("partner_id", "due_at");
CREATE INDEX "crm_task_deal_idx" ON "crm_task"("deal_id", "due_at");

ALTER TABLE "crm_task" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "crm_task" FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON "crm_task"
  USING (company_id = ANY (app.current_company_ids()))
  WITH CHECK (company_id = ANY (app.current_company_ids()));

-- 2. Активность: что уже произошло.
--
-- `direction` и `duration_sec` относятся только к звонку — у письма нет
-- длительности, у заметки нет направления. База это и держит, иначе в карточке
-- клиента появятся встречи длиной 40 секунд.
--
-- `task_id` заполняется, когда активность родилась из закрытой задачи. Это
-- единственный способ не заставлять менеджера писать одно и то же дважды:
-- закрыл задачу «позвонить» с результатом — звонок сам лёг в ленту клиента.
CREATE TABLE "crm_activity" (
  "id"           BIGSERIAL PRIMARY KEY,
  "uid"          UUID NOT NULL,
  "company_id"   BIGINT NOT NULL REFERENCES "company"("id"),
  "type"         "CrmActivityType" NOT NULL,
  "direction"    "CrmActivityDirection",
  "subject"      TEXT NOT NULL,
  "note"         TEXT,
  "at"           TIMESTAMPTZ NOT NULL DEFAULT now(),
  "duration_sec" INTEGER,
  "partner_id"   BIGINT REFERENCES "partner"("id"),
  "deal_id"      BIGINT REFERENCES "deal"("id") ON DELETE CASCADE,
  "task_id"      BIGINT REFERENCES "crm_task"("id") ON DELETE SET NULL,
  "user_id"      BIGINT REFERENCES "user_account"("id"),
  "created_at"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "crm_activity_needs_owner"
    CHECK ("partner_id" IS NOT NULL OR "deal_id" IS NOT NULL),
  CONSTRAINT "crm_activity_call_only_fields"
    CHECK ("type" = 'call' OR ("direction" IS NULL AND "duration_sec" IS NULL)),
  CONSTRAINT "crm_activity_duration_positive"
    CHECK ("duration_sec" IS NULL OR "duration_sec" >= 0)
);
CREATE UNIQUE INDEX "crm_activity_uid_key" ON "crm_activity"("uid");
CREATE INDEX "crm_activity_feed_idx" ON "crm_activity"("company_id", "at");
CREATE INDEX "crm_activity_partner_idx" ON "crm_activity"("partner_id", "at");
CREATE INDEX "crm_activity_deal_idx" ON "crm_activity"("deal_id", "at");

ALTER TABLE "crm_activity" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "crm_activity" FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON "crm_activity"
  USING (company_id = ANY (app.current_company_ids()))
  WITH CHECK (company_id = ANY (app.current_company_ids()));
