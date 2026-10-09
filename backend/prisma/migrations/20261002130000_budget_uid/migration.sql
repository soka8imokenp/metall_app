-- Бюджет становится управляемым из интерфейса (ТЗ 6.6).
--
-- План-факт по бюджетам читался с первого дня, а завести или поправить бюджет
-- было нечем: ни маршрута, ни формы. Чтобы строкой бюджета можно было
-- управлять, ей нужен `uid` — внутренний `id` наружу не отдаём.
ALTER TABLE budget ADD COLUMN uid uuid;
UPDATE budget SET uid = gen_random_uuid() WHERE uid IS NULL;
ALTER TABLE budget ALTER COLUMN uid SET NOT NULL;
CREATE UNIQUE INDEX "budget_uid_key" ON budget (uid);

-- Один бюджет на «компания + подразделение + статья + период»: два плана на
-- одну статью в одном месяце — это две разные правды, и план-факт по ним
-- посчитает сумму, которую никто не утверждал.
CREATE UNIQUE INDEX "budget_scope_key"
  ON budget (company_id, cashflow_item_id, period_start, period_end,
             coalesce(department_id, 0));
