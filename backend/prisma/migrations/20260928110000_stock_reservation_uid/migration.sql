-- Резерв наружу адресуется uid, как движение и заказ: внутренние id в ответы
-- не выходят и в ссылку не попадают. Без этого столбца снять резерв с экрана
-- можно было бы только по номеру строки, то есть угадыванием.
ALTER TABLE "stock_reservation"
  ADD COLUMN "uid" UUID NOT NULL DEFAULT gen_random_uuid();

CREATE UNIQUE INDEX "stock_reservation_uid_key" ON "stock_reservation"("uid");

-- Резерв ищут по складу и позиции: «что обещано с этого склада» — первый
-- вопрос и на экране, и при отгрузке.
CREATE INDEX "stock_reservation_lookup_idx"
  ON "stock_reservation"("company_id", "warehouse_id", "item_id", "status");
