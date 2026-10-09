-- Статье движения денег нужен внешний идентификатор.
--
-- До этого форма операции выбирала статью внутренним `id` из базы: он уезжал в
-- браузер и приезжал обратно. Остальные сущности так не адресуются — наружу
-- ходит только uid, и по нему же бюджет (ТЗ 6.6) называет свою статью.
ALTER TABLE cashflow_item ADD COLUMN IF NOT EXISTS uid uuid;
UPDATE cashflow_item SET uid = gen_random_uuid() WHERE uid IS NULL;
ALTER TABLE cashflow_item ALTER COLUMN uid SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "cashflow_item_uid_key" ON cashflow_item (uid);
