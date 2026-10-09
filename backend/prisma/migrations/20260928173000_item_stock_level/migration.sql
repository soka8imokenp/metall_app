-- Минимальный и критический уровень на складе (ТЗ 5.10): «по каждой позиции
-- минимальный и критический уровень, на компанию или на склад».
--
-- На компанию уровень уже есть — `item.min_qty` и `item.critical_qty`. Здесь
-- появляется уровень на склад, и это именно перекрытие, а не второе слагаемое:
-- если у позиции заведён хотя бы один складской уровень, компанийский для неё
-- в потребности не участвует. Складывать их значило бы посчитать одну и ту же
-- нехватку дважды — один раз по складу, другой по компании.
--
-- Отдельной таблицей, а не парой столбцов в `stock_balance`: уровень задают на
-- склад целиком, а строка остатка живёт на ячейке и партии. Уровень на ячейку
-- никто не задаёт, и хранить его там значит переписывать одно и то же число в
-- десятке строк, которые заводит и удаляет приход.

CREATE TABLE "item_stock_level" (
  "id"           BIGSERIAL PRIMARY KEY,
  "uid"          UUID NOT NULL DEFAULT gen_random_uuid(),
  "company_id"   BIGINT NOT NULL REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "item_id"      BIGINT NOT NULL REFERENCES "item"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "warehouse_id" BIGINT NOT NULL REFERENCES "warehouse"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "min_qty"      DECIMAL(20, 6) NOT NULL DEFAULT 0,
  "critical_qty" DECIMAL(20, 6) NOT NULL DEFAULT 0,
  "comment"      TEXT,
  "updated_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "item_stock_level_uid_key" ON "item_stock_level"("uid");

-- Уровень на пару «позиция + склад» один. Два разных числа про один и тот же
-- склад — вопрос без ответа, а потребность в закупке ответа не ждёт.
CREATE UNIQUE INDEX "item_stock_level_item_warehouse_key"
  ON "item_stock_level"("company_id", "item_id", "warehouse_id");

-- Критический уровень не выше минимального. Наоборот — не строгость, а тишина:
-- позиция проваливалась бы в критические, ни разу не побывав «ниже минимума»,
-- и предупреждение приходило бы вместе с аварией. Ноль — это «уровень не задан»,
-- поэтому «только критический, без минимального» проверку проходит: по такой
-- позиции ждать нечего до самой аварии — так решил тот, кто её заводил.
ALTER TABLE "item_stock_level"
  ADD CONSTRAINT "item_stock_level_qty_sane"
  CHECK ("min_qty" >= 0 AND "critical_qty" >= 0
         AND ("min_qty" = 0 OR "critical_qty" <= "min_qty"));

-- Пустая строка уровня ничего не говорит и только мешает: позиция считается
-- «с заданным складским уровнем» и перестаёт участвовать в компанийском.
ALTER TABLE "item_stock_level"
  ADD CONSTRAINT "item_stock_level_not_empty"
  CHECK ("min_qty" > 0 OR "critical_qty" > 0);

ALTER TABLE "item_stock_level" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "item_stock_level" FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON "item_stock_level"
  USING (company_id = ANY (app.current_company_ids()))
  WITH CHECK (company_id = ANY (app.current_company_ids()));

-- Потребность читает уровни по складу и позиции сразу за все склады: индекс
-- уникальности начинается с компании и позиции, а обход «какие уровни заведены
-- на этом складе» идёт другим порядком.
CREATE INDEX "item_stock_level_warehouse_idx"
  ON "item_stock_level"("company_id", "warehouse_id");
