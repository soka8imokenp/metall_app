-- Фото и комментарии в производстве (ТЗ 4.1, 4.6).
--
-- Заказу вложения уже положены, этапу — нет, а снимают в цеху именно операцию:
-- у задания из пяти этапов фото «вот эта раковина» без этапа отвечает, в каком
-- задании это было, но не на какой операции. На следующем заказе по той же
-- карте смотрят, что было на этой же операции, — и этот разрез даёт только
-- ссылка на этап.

-- Этап адресуется наружу uid, как заказ и движение.
--
-- До этого этап адресовался парой «uid заказа + номер по порядку», и для
-- отметок цеха этого хватало: номер этапа человек видит на экране. Вложению
-- не хватает: механизм вложений спрашивает владельца одним uuid, и пара в него
-- не укладывается, а второй способ адресации владельца означал бы, что право
-- на файл спрашивают не там, где все остальные.
ALTER TABLE "production_stage"
  ADD COLUMN "uid" UUID NOT NULL DEFAULT gen_random_uuid();

CREATE UNIQUE INDEX "production_stage_uid_key" ON "production_stage"("uid");

-- Ссылка на этап — отдельной колонкой, как у всех прежних владельцев
-- вложения, а не полиморфной парой «тип + id». Удалили заказ — его этапы
-- ушли каскадом, а вместе с ними и снимки операций: иначе на диске остались
-- бы файлы, про которые база больше ничего не знает.
ALTER TABLE "attachment"
  ADD COLUMN "production_stage_id" BIGINT
    REFERENCES "production_stage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "attachment" DROP CONSTRAINT "attachment_one_owner";
ALTER TABLE "attachment"
  ADD CONSTRAINT "attachment_one_owner"
  CHECK (num_nonnulls(
    "stock_move_id", "batch_id", "finance_operation_id",
    "production_order_id", "production_stage_id", "document_id", "partner_id"
  ) = 1);

CREATE INDEX "attachment_production_stage_idx" ON "attachment"("production_stage_id");

-- Комментарий к записи выпуска, брака и отхода.
--
-- Комментарий служба принимала и раньше, но складывала его в чужие записи: у
-- годного — в комментарий складского прихода, у брака — в журнал отклонений,
-- у отхода — никуда, кроме аудита. В журнале выпуска, то есть там, где цех на
-- него и смотрит, его не было ни у одного вида. «Почему 0,5 т ушло в отход»
-- спрашивают, глядя на строку отхода, а не листая аудит.
ALTER TABLE "production_output" ADD COLUMN "comment" TEXT;
