-- Инварианты и изоляция арендаторов.
--
-- Всё, что Prisma не умеет описать в schema.prisma: CHECK-ограничения,
-- триггеры, отложенные ограничения и политики RLS. Prisma эти объекты не
-- отслеживает и при следующих миграциях их не трогает.
--
-- Смысл файла один: правила учёта держатся ограничениями базы, а не
-- аккуратностью прикладного кода. Отрицательный остаток, несходящаяся
-- проводка и правка задним числом в журнале движений должны быть
-- невозможны физически.

-- ---------------------------------------------------------------------------
-- 1. Контекст запроса
-- ---------------------------------------------------------------------------
-- Приложение в начале транзакции выставляет SET LOCAL app.user_id и
-- app.company_ids. Значения живут до конца транзакции, поэтому соседний
-- запрос из пула соединений чужой контекст не подхватит.

CREATE SCHEMA IF NOT EXISTS app;
GRANT USAGE ON SCHEMA app TO metall_app;

-- Пусто или не выставлено — пустой массив, то есть не видно ничего.
-- Отказ закрытый: забытый контекст даёт ноль строк, а не всю базу.
CREATE OR REPLACE FUNCTION app.current_company_ids() RETURNS bigint[]
LANGUAGE plpgsql STABLE AS $fn$
DECLARE raw text;
BEGIN
  raw := current_setting('app.company_ids', true);
  IF raw IS NULL OR btrim(raw) = '' THEN
    RETURN ARRAY[]::bigint[];
  END IF;
  RETURN string_to_array(btrim(raw), ',')::bigint[];
END
$fn$;

CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS bigint
LANGUAGE plpgsql STABLE AS $fn$
DECLARE raw text;
BEGIN
  raw := current_setting('app.user_id', true);
  IF raw IS NULL OR btrim(raw) = '' THEN
    RETURN NULL;
  END IF;
  RETURN btrim(raw)::bigint;
END
$fn$;

-- ---------------------------------------------------------------------------
-- 2. Складские остатки
-- ---------------------------------------------------------------------------
-- qty_available вычисляется триггером, а не пишется приложением, и
-- дополнительно закрыт CHECK: разойтись с qty_on_hand - qty_reserved нельзя
-- даже при прямом UPDATE из psql.

CREATE OR REPLACE FUNCTION app.stock_balance_available() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  NEW.qty_available := NEW.qty_on_hand - NEW.qty_reserved;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER stock_balance_available
  BEFORE INSERT OR UPDATE ON stock_balance
  FOR EACH ROW EXECUTE FUNCTION app.stock_balance_available();

ALTER TABLE stock_balance
  ADD CONSTRAINT stock_balance_qty_on_hand_non_negative CHECK (qty_on_hand >= 0),
  ADD CONSTRAINT stock_balance_qty_reserved_non_negative CHECK (qty_reserved >= 0),
  ADD CONSTRAINT stock_balance_reserved_le_on_hand CHECK (qty_reserved <= qty_on_hand),
  ADD CONSTRAINT stock_balance_available_computed
    CHECK (qty_available = qty_on_hand - qty_reserved);

ALTER TABLE stock_reservation
  ADD CONSTRAINT stock_reservation_qty_positive CHECK (qty > 0);

-- Журнал движений только пополняется. Ошибочная строка исправляется
-- сторнирующей строкой с reversal_of_id, а не правкой прежней: иначе
-- остаток на любую прошлую дату перестаёт быть воспроизводимым.
CREATE OR REPLACE FUNCTION app.deny_change() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'таблица % только для добавления: % запрещён',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END
$fn$;

CREATE TRIGGER stock_move_append_only
  BEFORE UPDATE OR DELETE ON stock_move
  FOR EACH ROW EXECUTE FUNCTION app.deny_change();

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION app.deny_change();

ALTER TABLE stock_move
  ADD CONSTRAINT stock_move_qty_positive CHECK (qty > 0 AND qty_base > 0),
  -- Движение обязано иметь хотя бы одну сторону: приход, расход или перемещение.
  ADD CONSTRAINT stock_move_has_side
    CHECK (from_warehouse_id IS NOT NULL OR to_warehouse_id IS NOT NULL);

-- ---------------------------------------------------------------------------
-- 3. Двойная запись
-- ---------------------------------------------------------------------------

ALTER TABLE finance_entry
  ADD CONSTRAINT finance_entry_amounts_non_negative CHECK (debit >= 0 AND credit >= 0),
  -- Строка проводки — либо дебет, либо кредит, не оба сразу.
  ADD CONSTRAINT finance_entry_single_side
    CHECK ((debit = 0) <> (credit = 0) OR (debit = 0 AND credit = 0));

-- Проверка сходимости отложенная: внутри транзакции строки появляются по
-- одной, и на каждой отдельной строке равенство заведомо не выполняется.
CREATE OR REPLACE FUNCTION app.finance_entry_balanced() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  op_id bigint;
  diff numeric(20, 4);
BEGIN
  op_id := COALESCE(NEW.operation_id, OLD.operation_id);

  SELECT COALESCE(SUM(debit), 0) - COALESCE(SUM(credit), 0)
    INTO diff
    FROM finance_entry
   WHERE operation_id = op_id;

  IF diff <> 0 THEN
    RAISE EXCEPTION 'проводки операции % не сходятся: дебет минус кредит = %',
      op_id, diff
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END
$fn$;

CREATE CONSTRAINT TRIGGER finance_entry_balanced
  AFTER INSERT OR UPDATE OR DELETE ON finance_entry
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.finance_entry_balanced();

-- ---------------------------------------------------------------------------
-- 4. Продажи и производство
-- ---------------------------------------------------------------------------

ALTER TABLE sales_order_line
  ADD CONSTRAINT sales_order_line_qty_positive CHECK (qty > 0),
  ADD CONSTRAINT sales_order_line_price_non_negative CHECK (price >= 0),
  ADD CONSTRAINT sales_order_line_discount_range
    CHECK (discount_percent >= 0 AND discount_percent <= 100);

ALTER TABLE sales_order
  ADD CONSTRAINT sales_order_paid_non_negative CHECK (paid_amount >= 0),
  ADD CONSTRAINT sales_order_rate_positive CHECK (rate > 0);

ALTER TABLE shipment_line
  ADD CONSTRAINT shipment_line_qty_positive CHECK (qty > 0);

ALTER TABLE production_order
  ADD CONSTRAINT production_order_qty_planned_positive CHECK (qty_planned > 0),
  ADD CONSTRAINT production_order_qty_facts_non_negative
    CHECK (qty_produced >= 0 AND qty_defect >= 0 AND qty_waste >= 0);

ALTER TABLE production_output
  ADD CONSTRAINT production_output_qty_positive CHECK (qty > 0);

-- Действующий расчёт себестоимости по заказу ровно один.
CREATE UNIQUE INDEX production_order_cost_one_current
  ON production_order_cost (production_order_id)
  WHERE is_current;

ALTER TABLE currency_rate
  ADD CONSTRAINT currency_rate_positive CHECK (rate > 0);

ALTER TABLE budget
  ADD CONSTRAINT budget_period_order CHECK (period_end >= period_start);

-- ---------------------------------------------------------------------------
-- 5. RLS: изоляция компаний
-- ---------------------------------------------------------------------------
-- FORCE включаем по условию Босса: политики должны действовать и на владельца
-- таблиц, иначе на дев-стенде дыра не видна. Миграции и сид ходят ролью
-- metall_owner, ей отдельно выдан BYPASSRLS (см. scripts/db-bootstrap.sh);
-- рабочая роль metall_app не имеет ни SUPERUSER, ни BYPASSRLS.

DO $rls$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'company_id'
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
       AND a.attnum > 0
       AND NOT a.attisdropped
       AND c.relname <> 'role'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY company_isolation ON %I USING (company_id = ANY (app.current_company_ids())) WITH CHECK (company_id = ANY (app.current_company_ids()))',
      t);
  END LOOP;
END
$rls$;

-- Сама компания: колонка ключа называется id, а не company_id.
ALTER TABLE company ENABLE ROW LEVEL SECURITY;
ALTER TABLE company FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON company
  USING (id = ANY (app.current_company_ids()))
  WITH CHECK (id = ANY (app.current_company_ids()));

-- Роли бывают системные (company_id IS NULL) — они общие для всех компаний.
ALTER TABLE "role" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "role" FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON "role"
  USING (company_id IS NULL OR company_id = ANY (app.current_company_ids()))
  WITH CHECK (company_id IS NULL OR company_id = ANY (app.current_company_ids()));

-- Подчинённые таблицы своего company_id не несут: закрываем их через родителя.
-- Дублировать company_id в каждой строке дешевле по чтению, но даёт второй
-- источник истины о принадлежности — и он рано или поздно разойдётся с родителем.

CREATE POLICY company_isolation ON item_attribute
  USING (EXISTS (SELECT 1 FROM item p WHERE p.id = item_id AND p.company_id = ANY (app.current_company_ids())))
  WITH CHECK (EXISTS (SELECT 1 FROM item p WHERE p.id = item_id AND p.company_id = ANY (app.current_company_ids())));

CREATE POLICY company_isolation ON item_unit
  USING (EXISTS (SELECT 1 FROM item p WHERE p.id = item_id AND p.company_id = ANY (app.current_company_ids())))
  WITH CHECK (EXISTS (SELECT 1 FROM item p WHERE p.id = item_id AND p.company_id = ANY (app.current_company_ids())));

CREATE POLICY company_isolation ON partner_contact
  USING (EXISTS (SELECT 1 FROM partner p WHERE p.id = partner_id AND p.company_id = ANY (app.current_company_ids())))
  WITH CHECK (EXISTS (SELECT 1 FROM partner p WHERE p.id = partner_id AND p.company_id = ANY (app.current_company_ids())));

CREATE POLICY company_isolation ON warehouse_zone
  USING (EXISTS (SELECT 1 FROM warehouse p WHERE p.id = warehouse_id AND p.company_id = ANY (app.current_company_ids())))
  WITH CHECK (EXISTS (SELECT 1 FROM warehouse p WHERE p.id = warehouse_id AND p.company_id = ANY (app.current_company_ids())));

CREATE POLICY company_isolation ON storage_location
  USING (EXISTS (SELECT 1 FROM warehouse_zone z JOIN warehouse p ON p.id = z.warehouse_id
                  WHERE z.id = zone_id AND p.company_id = ANY (app.current_company_ids())))
  WITH CHECK (EXISTS (SELECT 1 FROM warehouse_zone z JOIN warehouse p ON p.id = z.warehouse_id
                  WHERE z.id = zone_id AND p.company_id = ANY (app.current_company_ids())));

CREATE POLICY company_isolation ON sales_order_line
  USING (EXISTS (SELECT 1 FROM sales_order p WHERE p.id = sales_order_id AND p.company_id = ANY (app.current_company_ids())))
  WITH CHECK (EXISTS (SELECT 1 FROM sales_order p WHERE p.id = sales_order_id AND p.company_id = ANY (app.current_company_ids())));

CREATE POLICY company_isolation ON shipment_line
  USING (EXISTS (SELECT 1 FROM shipment p WHERE p.id = shipment_id AND p.company_id = ANY (app.current_company_ids())))
  WITH CHECK (EXISTS (SELECT 1 FROM shipment p WHERE p.id = shipment_id AND p.company_id = ANY (app.current_company_ids())));

CREATE POLICY company_isolation ON tech_card_stage
  USING (EXISTS (SELECT 1 FROM tech_card p WHERE p.id = tech_card_id AND p.company_id = ANY (app.current_company_ids())))
  WITH CHECK (EXISTS (SELECT 1 FROM tech_card p WHERE p.id = tech_card_id AND p.company_id = ANY (app.current_company_ids())));

CREATE POLICY company_isolation ON tech_card_material
  USING (EXISTS (SELECT 1 FROM tech_card p WHERE p.id = tech_card_id AND p.company_id = ANY (app.current_company_ids())))
  WITH CHECK (EXISTS (SELECT 1 FROM tech_card p WHERE p.id = tech_card_id AND p.company_id = ANY (app.current_company_ids())));

CREATE POLICY company_isolation ON production_stage
  USING (EXISTS (SELECT 1 FROM production_order p WHERE p.id = production_order_id AND p.company_id = ANY (app.current_company_ids())))
  WITH CHECK (EXISTS (SELECT 1 FROM production_order p WHERE p.id = production_order_id AND p.company_id = ANY (app.current_company_ids())));

CREATE POLICY company_isolation ON production_material
  USING (EXISTS (SELECT 1 FROM production_order p WHERE p.id = production_order_id AND p.company_id = ANY (app.current_company_ids())))
  WITH CHECK (EXISTS (SELECT 1 FROM production_order p WHERE p.id = production_order_id AND p.company_id = ANY (app.current_company_ids())));

CREATE POLICY company_isolation ON production_output
  USING (EXISTS (SELECT 1 FROM production_order p WHERE p.id = production_order_id AND p.company_id = ANY (app.current_company_ids())))
  WITH CHECK (EXISTS (SELECT 1 FROM production_order p WHERE p.id = production_order_id AND p.company_id = ANY (app.current_company_ids())));

CREATE POLICY company_isolation ON production_order_cost
  USING (EXISTS (SELECT 1 FROM production_order p WHERE p.id = production_order_id AND p.company_id = ANY (app.current_company_ids())))
  WITH CHECK (EXISTS (SELECT 1 FROM production_order p WHERE p.id = production_order_id AND p.company_id = ANY (app.current_company_ids())));

CREATE POLICY company_isolation ON production_stage_event
  USING (EXISTS (SELECT 1 FROM production_stage s JOIN production_order p ON p.id = s.production_order_id
                  WHERE s.id = stage_id AND p.company_id = ANY (app.current_company_ids())))
  WITH CHECK (EXISTS (SELECT 1 FROM production_stage s JOIN production_order p ON p.id = s.production_order_id
                  WHERE s.id = stage_id AND p.company_id = ANY (app.current_company_ids())));

DO $child$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'item_attribute', 'item_unit', 'partner_contact', 'warehouse_zone',
    'storage_location', 'sales_order_line', 'shipment_line',
    'tech_card_stage', 'tech_card_material', 'production_stage',
    'production_material', 'production_output', 'production_order_cost',
    'production_stage_event'
  ])
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END
$child$;

-- Отдельные индексы под EXISTS в политиках не нужны: у всех этих таблиц
-- ссылка на родителя идёт первой колонкой уже существующего уникального
-- индекса (sales_order_line(sales_order_id, seq) и т.д.).
