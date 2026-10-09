-- Тип документа наружу адресуется по uid (ТЗ 7.3, контракт §1.4).
--
-- Третий случай той же дыры: `lead_source` и `price_type` чинились в
-- 20260929151000, `deal_stage` — в 20260929170000. Справочник задумывался
-- внутренним перечислением, а в реестре документов оказался фильтром на
-- экране. Отдавать вместо uid числовой id нельзя — это внутренний ключ, по
-- нему перебирают соседние записи.
ALTER TABLE "document_type" ADD COLUMN "uid" UUID;
UPDATE "document_type" SET "uid" = gen_random_uuid() WHERE "uid" IS NULL;
ALTER TABLE "document_type" ALTER COLUMN "uid" SET NOT NULL;
CREATE UNIQUE INDEX "document_type_uid_key" ON "document_type"("uid");
