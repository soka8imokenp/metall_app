-- Воронка сделок (ТЗ 8.3): стадии наружу по uid, след переходов, причины
-- проигрыша справочником.

-- 1. Стадия уходит наружу выбором в форме и колонкой доски — по uid, как всё
--    остальное. Та же дыра, что была у источников лидов и типов цен.
ALTER TABLE "deal_stage" ADD COLUMN "uid" UUID;
UPDATE "deal_stage" SET "uid" = gen_random_uuid() WHERE "uid" IS NULL;
ALTER TABLE "deal_stage" ALTER COLUMN "uid" SET NOT NULL;
CREATE UNIQUE INDEX "deal_stage_uid_key" ON "deal_stage"("uid");

-- 2. Версия сделки: двое тянут одну карточку по доске — второй должен узнать,
--    что её уже передвинули, а не вернуть на прежнее место.
ALTER TABLE "deal" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

-- 3. Причины проигрыша — справочник, а не свободная строка. ТЗ 8.3: «Проигрыш
--    требует указания причины из справочника — иначе отчёт по причинам отказов
--    не наполняется». Из свободной строки отчёт собирался бы из опечаток:
--    «дорого», «Дорого», «дороже конкурента» — три причины вместо одной.
CREATE TABLE "deal_lost_reason" (
  "id"         BIGSERIAL PRIMARY KEY,
  "uid"        UUID NOT NULL,
  "company_id" BIGINT NOT NULL REFERENCES "company"("id"),
  "code"       TEXT NOT NULL,
  "name_ru"    TEXT NOT NULL,
  "name_uz"    TEXT NOT NULL,
  "is_active"  BOOLEAN NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX "deal_lost_reason_uid_key" ON "deal_lost_reason"("uid");
CREATE UNIQUE INDEX "deal_lost_reason_company_code_key" ON "deal_lost_reason"("company_id", "code");

ALTER TABLE "deal_lost_reason" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "deal_lost_reason" FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON "deal_lost_reason"
  USING (company_id = ANY (app.current_company_ids()))
  WITH CHECK (company_id = ANY (app.current_company_ids()));

-- Уже записанные причины переезжают в справочник, а не теряются.
INSERT INTO "deal_lost_reason" ("uid", "company_id", "code", "name_ru", "name_uz")
SELECT gen_random_uuid(), d.company_id,
       'r' || row_number() OVER (PARTITION BY d.company_id ORDER BY d.lost_reason),
       d.lost_reason, d.lost_reason
  FROM (SELECT DISTINCT company_id, lost_reason FROM "deal" WHERE lost_reason IS NOT NULL) d;

ALTER TABLE "deal" ADD COLUMN "lost_reason_id" BIGINT REFERENCES "deal_lost_reason"("id");
UPDATE "deal" d SET "lost_reason_id" = r.id
  FROM "deal_lost_reason" r
 WHERE r.company_id = d.company_id AND r.name_ru = d.lost_reason;
ALTER TABLE "deal" DROP COLUMN "lost_reason";
ALTER TABLE "deal" ADD COLUMN "lost_comment" TEXT;

-- Проигранная сделка без причины невозможна — правило держит база.
ALTER TABLE "deal"
  ADD CONSTRAINT "deal_lost_needs_reason"
  CHECK (status <> 'lost' OR "lost_reason_id" IS NOT NULL);

-- 4. След переходов по стадиям. Без него воронка показывает, где сделки
--    сейчас, но не как они туда шли, и конверсию между стадиями считать не из
--    чего: текущая стадия не говорит, сколько сделок через неё прошло.
CREATE TABLE "deal_stage_event" (
  "id"            BIGSERIAL PRIMARY KEY,
  "deal_id"       BIGINT NOT NULL REFERENCES "deal"("id") ON DELETE CASCADE,
  "from_stage_id" BIGINT REFERENCES "deal_stage"("id"),
  "to_stage_id"   BIGINT NOT NULL REFERENCES "deal_stage"("id"),
  "user_id"       BIGINT REFERENCES "user_account"("id"),
  "at"            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX "deal_stage_event_deal_idx" ON "deal_stage_event"("deal_id", "at");
CREATE INDEX "deal_stage_event_to_idx" ON "deal_stage_event"("to_stage_id", "at");

ALTER TABLE "deal_stage_event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "deal_stage_event" FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON "deal_stage_event"
  USING (EXISTS (SELECT 1 FROM "deal" d WHERE d.id = deal_id AND d.company_id = ANY (app.current_company_ids())))
  WITH CHECK (EXISTS (SELECT 1 FROM "deal" d WHERE d.id = deal_id AND d.company_id = ANY (app.current_company_ids())));

-- Уже лежащим сделкам честно известно одно: где они сейчас. Одна запись
-- «появилась в текущей стадии» в момент создания — выдумывать им путь по
-- воронке задним числом значило бы нарисовать конверсию, которой не было.
INSERT INTO "deal_stage_event" ("deal_id", "from_stage_id", "to_stage_id", "user_id", "at")
SELECT d.id, NULL, d.stage_id, d.manager_id, d.created_at FROM "deal" d;
