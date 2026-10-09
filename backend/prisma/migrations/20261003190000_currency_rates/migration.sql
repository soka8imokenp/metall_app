-- Валюты и курсы как справочник на запись (ТЗ 6.2).
--
-- Таблицы `currency` и `currency_rate` существовали с первой миграции, но
-- заполнял их только посев: ни названия валюты, ни признака «курс загружать с
-- ЦБ РУз», ни отметки о том, когда курс в систему попал, в них не было.
-- Без этого справочник нельзя показать человеку: код «RUB» не название, а
-- строка с курсом не отвечает, откуда она взялась.

ALTER TABLE currency
  ADD COLUMN name_ru  text    NOT NULL DEFAULT '',
  ADD COLUMN name_uz  text    NOT NULL DEFAULT '',
  -- Загружать ли курс автоматически. У учётной валюты компании курса нет
  -- вовсе, поэтому ниже она выключается.
  ADD COLUMN autoload boolean NOT NULL DEFAULT true;

UPDATE currency SET name_ru = 'Узбекский сум',     name_uz = 'O‘zbek so‘mi'    WHERE code = 'UZS';
UPDATE currency SET name_ru = 'Доллар США',        name_uz = 'AQSH dollari'    WHERE code = 'USD';
UPDATE currency SET name_ru = 'Российский рубль',  name_uz = 'Rossiya rubli'   WHERE code = 'RUB';

UPDATE currency c SET autoload = false
 WHERE EXISTS (SELECT 1 FROM company k WHERE k.base_currency = c.code);

-- Когда курс попал в систему. Дата курса — это дата банка, а не время
-- загрузки: «обновлено 19:40» на экране берётся отсюда.
ALTER TABLE currency_rate
  ADD COLUMN created_at timestamptz(6) NOT NULL DEFAULT now();
