-- Табличная часть документа и снимок реквизитов (ТЗ 7.1).
--
-- Документ до сих пор держал только итоговую сумму. В каждой печатной форме
-- есть строки: позиция, количество, цена, НДС, — и брать их из заказа в момент
-- печати нельзя. Счёт, выставленный в марте, печатается мартовскими строками и
-- мартовскими ценами, даже если в заказе потом всё поменяли: он уже ушёл
-- клиенту и по нему платят.
--
-- Поэтому строки — снимок, а не ссылка. Здесь лежат названия и единицы
-- текстом, а не только ссылки на номенклатуру: переименовали позицию —
-- в выставленном счёте остаётся то название, по которому её приняли.
-- `item_id` оставлен для перехода к карточке, но печать на него не смотрит.
CREATE TABLE "document_line" (
  "id"               BIGSERIAL PRIMARY KEY,
  "uid"              UUID NOT NULL DEFAULT gen_random_uuid(),
  "company_id"       BIGINT NOT NULL REFERENCES "company"("id"),
  "document_id"      BIGINT NOT NULL REFERENCES "document"("id") ON DELETE CASCADE,
  "seq"              INTEGER NOT NULL,
  "item_id"          BIGINT REFERENCES "item"("id"),
  "item_code"        TEXT,
  "name"             TEXT NOT NULL,
  "qty"              DECIMAL(20, 6) NOT NULL,
  "unit_code"        TEXT NOT NULL,
  "unit_name"        TEXT NOT NULL,
  "price"            DECIMAL(20, 4) NOT NULL DEFAULT 0,
  "discount_percent" DECIMAL(9, 4) NOT NULL DEFAULT 0,
  "vat_rate"         DECIMAL(9, 4) NOT NULL DEFAULT 0,
  "amount_net"       DECIMAL(20, 4) NOT NULL DEFAULT 0,
  "amount_vat"       DECIMAL(20, 4) NOT NULL DEFAULT 0,
  "amount_total"     DECIMAL(20, 4) NOT NULL DEFAULT 0,
  CONSTRAINT "document_line_qty_positive" CHECK ("qty" > 0)
);
CREATE UNIQUE INDEX "document_line_uid_key" ON "document_line"("uid");
CREATE UNIQUE INDEX "document_line_seq_key" ON "document_line"("document_id", "seq");

ALTER TABLE "document_line" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "document_line" FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON "document_line"
  USING (company_id = ANY (app.current_company_ids()))
  WITH CHECK (company_id = ANY (app.current_company_ids()));

-- Разбивка суммы. `amount_total` у документа был и раньше; без чистой суммы и
-- НДС отдельно счёт не напечатать — в форме это три разные строки, и
-- вычитать одно из другого при печати значит считать налог задним числом.
ALTER TABLE "document"
  ADD COLUMN "amount_net" DECIMAL(20, 4),
  ADD COLUMN "amount_vat" DECIMAL(20, 4);

-- Снимок реквизитов на момент выписки.
--
-- Банковский счёт компании, адрес и ИНН контрагента, срок и условия оплаты —
-- всё это печатается на документе и меняется со временем. Сменили расчётный
-- счёт — в прошлых счетах обязан остаться прежний: по нему уже платили, и
-- переписать его значит соврать о том, куда ушли деньги.
--
-- JSON, а не колонки: состав реквизитов у договора, счёта и накладной разный
-- и будет дополняться под образцы заказчика. Колонка на каждый реквизит
-- означала бы миграцию на каждую новую печатную форму.
ALTER TABLE "document" ADD COLUMN "requisites" JSONB;
