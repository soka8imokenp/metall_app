-- Поиск по всей системе: индекс вместо перебора строк.
--
-- Окно поиска отбирает записи по `ILIKE '%кусок%'`. Такой отбор индексом по
-- значению не покрывается вовсе — база читает таблицу целиком. На нынешних
-- тысячах строк это незаметно, но поиск зовут с каждой третьей буквы, и по
-- девяти таблицам сразу: к сотням тысяч строк это становится самым тяжёлым
-- запросом в системе.
--
-- Лечится триграммным индексом: pg_trgm режет строку на тройки символов и
-- кладёт их в GIN, после чего `ILIKE '%кусок%'` ищется по индексу. Расширение
-- доверенное (trusted), владелец базы ставит его сам — права администратора
-- не нужны.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Что именно ищется в таблице — одной функцией, а не перечислением полей в
-- запросе и в индексе по отдельности. Индекс по выражению работает, только
-- если запрос спрашивает ровно то же выражение; два списка полей в двух
-- местах однажды разъехались бы, и поиск молча вернулся бы к перебору.
--
-- IMMUTABLE обязательно: без этого выражение в индекс не положить. Здесь это
-- правда — результат зависит только от аргументов.
CREATE OR REPLACE FUNCTION app_search(VARIADIC parts text[]) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT array_to_string(array_remove(parts, NULL), ' ')
$$;

COMMENT ON FUNCTION app_search(text[]) IS
  'Строка, по которой ищет общий поиск. Одна и та же в запросе и в индексе';

CREATE INDEX IF NOT EXISTS item_search_trgm_idx
  ON item USING gin (app_search(code, name_ru, name_uz, barcode) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS partner_search_trgm_idx
  ON partner USING gin (app_search(name_ru, name_uz, inn) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS sales_order_search_trgm_idx
  ON sales_order USING gin (app_search(number) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS production_order_search_trgm_idx
  ON production_order USING gin (app_search(number) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS batch_search_trgm_idx
  ON batch USING gin (app_search(number, certificate_number) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS document_search_trgm_idx
  ON document USING gin (app_search(number) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS deal_search_trgm_idx
  ON deal USING gin (app_search(number, title) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS warehouse_search_trgm_idx
  ON warehouse USING gin (app_search(code, name_ru, name_uz) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS user_account_search_trgm_idx
  ON user_account USING gin (app_search(full_name, login, email, phone) gin_trgm_ops);
