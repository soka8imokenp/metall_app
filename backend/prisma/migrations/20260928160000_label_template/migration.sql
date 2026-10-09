-- Этикетки со штрихкодом и QR (ТЗ 5.9): «формат листа и размер — настройка».
--
-- Настройка живёт таблицей, а не константой в коде: у завода рулонный принтер
-- 58×40, у торговой конторы обычный лист A4 с наклейками, и лист у них разный.
-- Компания у шаблона своя — печатает каждая на своём.
--
-- Сам код на этикетке не хранится: он вычисляется из вида объекта и его
-- идентификатора (`src/warehouse/codes.ts`). Хранимый код пришлось бы
-- стеречь на уникальность и сверять с объектом, а вычисленный разойтись
-- с объектом не может.

CREATE TYPE "LabelSymbology" AS ENUM ('code128', 'qr');

CREATE TABLE "label_template" (
  "id"              BIGSERIAL PRIMARY KEY,
  "uid"             UUID NOT NULL DEFAULT gen_random_uuid(),
  "company_id"      BIGINT NOT NULL REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "code"            TEXT NOT NULL,
  "name_ru"         TEXT NOT NULL,
  "name_uz"         TEXT NOT NULL,
  "page_width_mm"   DECIMAL(8, 2) NOT NULL,
  "page_height_mm"  DECIMAL(8, 2) NOT NULL,
  "label_width_mm"  DECIMAL(8, 2) NOT NULL,
  "label_height_mm" DECIMAL(8, 2) NOT NULL,
  "columns"         INTEGER NOT NULL,
  "rows"            INTEGER NOT NULL,
  "margin_top_mm"   DECIMAL(8, 2) NOT NULL DEFAULT 0,
  "margin_left_mm"  DECIMAL(8, 2) NOT NULL DEFAULT 0,
  "gap_x_mm"        DECIMAL(8, 2) NOT NULL DEFAULT 0,
  "gap_y_mm"        DECIMAL(8, 2) NOT NULL DEFAULT 0,
  "symbology"       "LabelSymbology" NOT NULL DEFAULT 'code128',
  "is_default"      BOOLEAN NOT NULL DEFAULT false,
  "is_active"       BOOLEAN NOT NULL DEFAULT true
);

CREATE UNIQUE INDEX "label_template_uid_key" ON "label_template"("uid");
CREATE UNIQUE INDEX "label_template_company_id_code_key"
  ON "label_template"("company_id", "code");

-- Шаблон по умолчанию в компании один: «какой из двух взять» — вопрос без
-- ответа, а печать без ответа не ждёт.
CREATE UNIQUE INDEX "label_template_one_default_per_company"
  ON "label_template"("company_id") WHERE "is_default";

ALTER TABLE "label_template"
  ADD CONSTRAINT "label_template_grid_positive"
  CHECK ("columns" >= 1 AND "rows" >= 1
         AND "label_width_mm" > 0 AND "label_height_mm" > 0
         AND "page_width_mm" > 0 AND "page_height_mm" > 0
         AND "margin_top_mm" >= 0 AND "margin_left_mm" >= 0
         AND "gap_x_mm" >= 0 AND "gap_y_mm" >= 0);

-- Сетка обязана помещаться на лист. Шаблон, который не помещается, печатает
-- обрезанные этикетки: половина кодов не читается, и понимает это кладовщик
-- уже у полки. Проверка тут, а не в форме: форма не единственный путь в базу.
ALTER TABLE "label_template"
  ADD CONSTRAINT "label_template_grid_fits_page"
  CHECK ("margin_left_mm" + "columns" * "label_width_mm"
           + ("columns" - 1) * "gap_x_mm" <= "page_width_mm"
     AND "margin_top_mm" + "rows" * "label_height_mm"
           + ("rows" - 1) * "gap_y_mm" <= "page_height_mm");

ALTER TABLE "label_template" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "label_template" FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON "label_template"
  USING (company_id = ANY (app.current_company_ids()))
  WITH CHECK (company_id = ANY (app.current_company_ids()));
