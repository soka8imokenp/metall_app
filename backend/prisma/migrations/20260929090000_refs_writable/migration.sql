-- Справочники на запись (ТЗ 5.2, 5.3, 5.10): номенклатура, склады, зоны,
-- ячейки, причины списания, уровни запаса. До этого этапа они приходили из
-- сида и правились только пересевом.
--
-- Что добавляется:
--   1) `uid` зонам, ячейкам и причинам. Снаружи объект зовут по uid, а не по
--      коду: код — это то, что человек правит, и правка кода не должна
--      означать «удалили одно, завели другое».
--   2) `is_active` зонам и причинам. Справочник, по которому уже есть
--      движения, не удаляют: история перестала бы читаться. Его выключают.

ALTER TABLE "warehouse_zone"   ADD COLUMN "uid" UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE "storage_location" ADD COLUMN "uid" UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE "stock_reason"     ADD COLUMN "uid" UUID NOT NULL DEFAULT gen_random_uuid();

CREATE UNIQUE INDEX "warehouse_zone_uid_key"   ON "warehouse_zone"("uid");
CREATE UNIQUE INDEX "storage_location_uid_key" ON "storage_location"("uid");
CREATE UNIQUE INDEX "stock_reason_uid_key"     ON "stock_reason"("uid");

ALTER TABLE "warehouse_zone" ADD COLUMN "is_active" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "stock_reason"   ADD COLUMN "is_active" BOOLEAN NOT NULL DEFAULT true;

-- Код в справочнике — не украшение: по нему человек находит место глазами, и
-- пустой код превращает список в перечень безымянных строк.
ALTER TABLE "warehouse"
  ADD CONSTRAINT "warehouse_code_not_blank" CHECK (btrim("code") <> '');
ALTER TABLE "warehouse_zone"
  ADD CONSTRAINT "warehouse_zone_code_not_blank" CHECK (btrim("code") <> '');
ALTER TABLE "storage_location"
  ADD CONSTRAINT "storage_location_code_not_blank" CHECK (btrim("code") <> '');
ALTER TABLE "item"
  ADD CONSTRAINT "item_code_not_blank" CHECK (btrim("code") <> '');
ALTER TABLE "item"
  ADD CONSTRAINT "item_name_not_blank" CHECK (btrim("name_ru") <> '');

-- Уровни позиции на компанию (ТЗ 5.10) — та же проверка, что уже стоит на
-- складских уровнях: критический не выше минимального, иначе позиция
-- проваливается в критические, ни разу не побывав «ниже минимума».
ALTER TABLE "item"
  ADD CONSTRAINT "item_levels_sane"
  CHECK ("min_qty" >= 0 AND "critical_qty" >= 0
         AND ("min_qty" = 0 OR "critical_qty" <= "min_qty"));

-- Коэффициент пересчёта тонна ↔ метр ↔ штука (ТЗ 5.2). Ноль и отрицательное
-- значение не «странная настройка», а деление на ноль и отрицательный остаток
-- в первом же приходе.
ALTER TABLE "item_unit"
  ADD CONSTRAINT "item_unit_factor_positive" CHECK ("factor" > 0);

-- Характеристики металлопроката: размеры не бывают отрицательными.
ALTER TABLE "item_attribute"
  ADD CONSTRAINT "item_attribute_sizes_positive"
  CHECK (
    ("diameter_mm" IS NULL OR "diameter_mm" > 0) AND
    ("wall_thickness_mm" IS NULL OR "wall_thickness_mm" > 0) AND
    ("length_mm" IS NULL OR "length_mm" > 0) AND
    ("weight_kg_per_unit" IS NULL OR "weight_kg_per_unit" > 0)
  );
