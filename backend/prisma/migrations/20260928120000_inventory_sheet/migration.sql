-- Инвентаризация (ТЗ 5.8): лист пересчёта и его строки.
--
-- Лист — снимок учётного количества на момент создания. Сравнивать посчитанное
-- с текущим остатком нельзя: пока идут подсчёт и утверждение, остаток живёт
-- своей жизнью, и расхождение поплывёт вместе с ним.

CREATE TYPE "InventoryStatus" AS ENUM ('draft', 'counting', 'review', 'approved', 'cancelled');
CREATE TYPE "InventoryBlockMode" AS ENUM ('block', 'mark');

CREATE TABLE "inventory_sheet" (
  "id"           BIGSERIAL PRIMARY KEY,
  "uid"          UUID NOT NULL DEFAULT gen_random_uuid(),
  "company_id"   BIGINT NOT NULL REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "number"       TEXT NOT NULL,
  "warehouse_id" BIGINT NOT NULL REFERENCES "warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "zone_id"      BIGINT REFERENCES "warehouse_zone"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  "status"       "InventoryStatus" NOT NULL DEFAULT 'draft',
  "block_mode"   "InventoryBlockMode" NOT NULL DEFAULT 'mark',
  "comment"      TEXT,
  "created_by"   BIGINT REFERENCES "user_account"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "counted_at"   TIMESTAMPTZ(6),
  "approved_by"  BIGINT REFERENCES "user_account"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  "approved_at"  TIMESTAMPTZ(6)
);

CREATE UNIQUE INDEX "inventory_sheet_uid_key" ON "inventory_sheet"("uid");
CREATE UNIQUE INDEX "inventory_sheet_company_id_number_key"
  ON "inventory_sheet"("company_id", "number");
CREATE INDEX "inventory_sheet_company_id_status_idx"
  ON "inventory_sheet"("company_id", "status");
CREATE INDEX "inventory_sheet_company_id_warehouse_id_status_idx"
  ON "inventory_sheet"("company_id", "warehouse_id", "status");

-- Строка листа живёт тем же ключом, что и остаток: ячейка, позиция, партия.
-- Расхождение считает база, как и qty_available у остатка: приложение его не
-- пишет, а CHECK не даёт ему разойтись с посчитанным.
CREATE TABLE "inventory_sheet_line" (
  "id"           BIGSERIAL PRIMARY KEY,
  "uid"          UUID NOT NULL DEFAULT gen_random_uuid(),
  "sheet_id"     BIGINT NOT NULL REFERENCES "inventory_sheet"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "seq"          INTEGER NOT NULL,
  "item_id"      BIGINT NOT NULL REFERENCES "item"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "batch_id"     BIGINT REFERENCES "batch"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  "location_id"  BIGINT REFERENCES "storage_location"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  "qty_expected" DECIMAL(20, 6) NOT NULL DEFAULT 0,
  "qty_counted"  DECIMAL(20, 6),
  "qty_diff"     DECIMAL(20, 6),
  "unit_cost"    DECIMAL(20, 4) NOT NULL DEFAULT 0,
  "counted_by"   BIGINT REFERENCES "user_account"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  "counted_at"   TIMESTAMPTZ(6),
  "comment"      TEXT
);

CREATE UNIQUE INDEX "inventory_sheet_line_uid_key" ON "inventory_sheet_line"("uid");
CREATE UNIQUE INDEX "inventory_sheet_line_sheet_id_seq_key"
  ON "inventory_sheet_line"("sheet_id", "seq");
CREATE INDEX "inventory_sheet_line_sheet_id_idx" ON "inventory_sheet_line"("sheet_id");

-- Расхождение заполняет триггер: посчитанное минус учётное, и никак иначе.
CREATE OR REPLACE FUNCTION inventory_line_diff() RETURNS trigger AS $$
BEGIN
  NEW.qty_diff := NEW.qty_counted - NEW.qty_expected;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER inventory_sheet_line_diff
  BEFORE INSERT OR UPDATE ON "inventory_sheet_line"
  FOR EACH ROW EXECUTE FUNCTION inventory_line_diff();

ALTER TABLE "inventory_sheet_line"
  ADD CONSTRAINT "inventory_sheet_line_diff_matches"
  CHECK ("qty_diff" IS NOT DISTINCT FROM "qty_counted" - "qty_expected");

-- Посчитать можно ноль (позиции нет на месте), но не минус.
ALTER TABLE "inventory_sheet_line"
  ADD CONSTRAINT "inventory_sheet_line_counted_not_negative"
  CHECK ("qty_counted" IS NULL OR "qty_counted" >= 0);

-- Один склад — один незакрытый лист на зону. Два пересчёта одного и того же
-- места дают два разных «правильных» количества, и чей снимок верный, узнать
-- уже не из чего. `zone_id IS NULL` — пересчёт всего склада, и он так же
-- исключает второй лист по этому складу.
CREATE UNIQUE INDEX "inventory_sheet_one_open_per_zone"
  ON "inventory_sheet"("company_id", "warehouse_id", COALESCE("zone_id", 0))
  WHERE "status" IN ('draft', 'counting', 'review');

-- Пометка «прошло во время пересчёта» для режима mark (ТЗ 5.8).
ALTER TABLE "stock_move"
  ADD COLUMN "during_inventory" BOOLEAN NOT NULL DEFAULT false;

-- Журнал только дополняется, и триггер append-only это стережёт. Строка листа
-- — не журнал: её для того и заводят, чтобы вписать посчитанное. Поэтому
-- обычная таблица, а неизменность утверждённого листа держит статус.

ALTER TABLE "inventory_sheet" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_sheet" FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON "inventory_sheet"
  USING (company_id = ANY (app.current_company_ids()))
  WITH CHECK (company_id = ANY (app.current_company_ids()));

-- У строки своего company_id нет: принадлежность одна, у листа. Второй
-- источник той же истины рано или поздно разойдётся с первым.
ALTER TABLE "inventory_sheet_line" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_sheet_line" FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON "inventory_sheet_line"
  USING (EXISTS (SELECT 1 FROM inventory_sheet s
                  WHERE s.id = sheet_id AND s.company_id = ANY (app.current_company_ids())))
  WITH CHECK (EXISTS (SELECT 1 FROM inventory_sheet s
                  WHERE s.id = sheet_id AND s.company_id = ANY (app.current_company_ids())));
