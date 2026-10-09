-- Название справочника на языке запроса, одной функцией в SQL.
--
-- Справочники двуязычны (name_ru, name_uz), а запросы брали только русское —
-- на узбекском экране и в выгрузке показывалось русское название. Выбирать
-- колонку в коде пришлось бы в восьмидесяти запросах, в том числе собранных
-- строками: подставить туда имя колонки нечем. Поэтому язык живёт в настройке
-- транзакции рядом с app.company_ids, по которой уже работает RLS, а запрос
-- спрашивает app_loc(ru, uz).
--
-- IMMUTABLE здесь нельзя: функция зависит от настройки сеанса. STABLE значит
-- «в пределах одного запроса не меняется» — этого планировщику достаточно.
CREATE OR REPLACE FUNCTION app_loc(ru text, uz text) RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT CASE
           WHEN current_setting('app.locale', true) = 'uz' AND coalesce(uz, '') <> '' THEN uz
           ELSE ru
         END
$$;

COMMENT ON FUNCTION app_loc(text, text) IS
  'Название на языке запроса: app.locale = uz -> второй аргумент, иначе первый';
