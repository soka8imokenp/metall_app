-- Серийный номер в строке листа пересчёта (ТЗ 5.6).
--
-- Ключ строки листа повторяет ключ остатка: ячейка, позиция, партия. У
-- штучного учёта к ним добавляется номер, и без этого столбца пересчёт
-- серийной позиции сворачивал бы десять разных труб в одну строку
-- «десять штук» — то есть отвечал бы не на тот вопрос, ради которого
-- номера и заведены.
ALTER TABLE "inventory_sheet_line"
  ADD COLUMN "serial_id" BIGINT
  REFERENCES "serial_number"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "inventory_sheet_line_serial_id_idx"
  ON "inventory_sheet_line"("serial_id");
