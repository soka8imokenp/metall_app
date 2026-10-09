-- Источники лидов и типы цен наружу адресуются по uid (ТЗ 8.2, контракт §1.4).
--
-- Обе таблицы завели без него: они задумывались как внутренние перечисления,
-- а в карточке клиента оказались выбором в форме. Отдавать вместо uid числовой
-- id нельзя — это внутренний ключ, по нему перебирают соседние записи.

ALTER TABLE "lead_source" ADD COLUMN "uid" UUID;
UPDATE "lead_source" SET "uid" = gen_random_uuid() WHERE "uid" IS NULL;
ALTER TABLE "lead_source" ALTER COLUMN "uid" SET NOT NULL;
CREATE UNIQUE INDEX "lead_source_uid_key" ON "lead_source"("uid");

ALTER TABLE "price_type" ADD COLUMN "uid" UUID;
UPDATE "price_type" SET "uid" = gen_random_uuid() WHERE "uid" IS NULL;
ALTER TABLE "price_type" ALTER COLUMN "uid" SET NOT NULL;
CREATE UNIQUE INDEX "price_type_uid_key" ON "price_type"("uid");
