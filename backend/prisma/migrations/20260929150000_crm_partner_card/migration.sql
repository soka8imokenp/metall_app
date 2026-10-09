-- Карточка клиента для CRM (ТЗ 8.2).
--
-- Две вещи, которых не хватало, чтобы карточка была карточкой:
--
-- 1. Контактное лицо снаружи адресуется по `uid`, как и всё остальное в API.
--    Числовой `id` — внутренний ключ; отдавая его наружу, мы бы рассказали
--    размер таблицы и дали бы перебор соседних записей.
-- 2. Теги клиента названы в ТЗ 8.2 и поля под них не было. Массив, а не
--    отдельная таблица: тег здесь — метка для поиска, у него нет ни своих
--    свойств, ни жизненного цикла.

ALTER TABLE "partner_contact" ADD COLUMN "uid" UUID;
-- Существующим строкам номер выдаётся здесь: v4 от базы, дальше Prisma пишет
-- v7. Порядок по uid нигде не используется, поэтому смешение версий безвредно.
UPDATE "partner_contact" SET "uid" = gen_random_uuid() WHERE "uid" IS NULL;
ALTER TABLE "partner_contact" ALTER COLUMN "uid" SET NOT NULL;
CREATE UNIQUE INDEX "partner_contact_uid_key" ON "partner_contact"("uid");

ALTER TABLE "partner" ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT '{}';
-- Поиск по тегу — обычный сценарий («все, кого ведём по предоплате»),
-- а без индекса это последовательный просмотр всей базы клиентов.
CREATE INDEX "partner_tags_idx" ON "partner" USING GIN ("tags");
