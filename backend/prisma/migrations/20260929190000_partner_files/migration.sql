-- Файлы клиента (ТЗ 8.2: вкладка «файлы» в карточке клиента).
--
-- Продолжение того же решения, что и у прежних владельцев вложения: не
-- полиморфная пара «тип + id», а отдельная ссылка на каждый вид. Удалили
-- клиента — его доверенность и карточка предприятия ушли каскадом, а не
-- остались сиротами с файлами на диске.
ALTER TABLE "attachment"
  ADD COLUMN "partner_id" BIGINT
    REFERENCES "partner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "attachment" DROP CONSTRAINT "attachment_one_owner";
ALTER TABLE "attachment"
  ADD CONSTRAINT "attachment_one_owner"
  CHECK (num_nonnulls(
    "stock_move_id", "batch_id", "finance_operation_id",
    "production_order_id", "document_id", "partner_id"
  ) = 1);

CREATE INDEX "attachment_partner_idx" ON "attachment"("partner_id");
