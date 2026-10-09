-- Вложения к производственному заданию и к документу (ТЗ 4.1, 7.1).
--
-- Продолжение того же решения, что и в первой таблице вложений: владелец —
-- не полиморфная пара «тип + id», а отдельная ссылка на каждый вид. Цена —
-- по столбцу на вид, выгода — целостность стережёт база: удалили документ,
-- вложение ушло каскадом, а не осталось сиротой с файлом на диске.

ALTER TABLE "attachment"
  ADD COLUMN "production_order_id" BIGINT
    REFERENCES "production_order"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD COLUMN "document_id" BIGINT
    REFERENCES "document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Владелец по-прежнему ровно один.
ALTER TABLE "attachment" DROP CONSTRAINT "attachment_one_owner";
ALTER TABLE "attachment"
  ADD CONSTRAINT "attachment_one_owner"
  CHECK (num_nonnulls(
    "stock_move_id", "batch_id", "finance_operation_id",
    "production_order_id", "document_id"
  ) = 1);

CREATE INDEX "attachment_production_order_idx" ON "attachment"("production_order_id");
CREATE INDEX "attachment_document_idx" ON "attachment"("document_id");
