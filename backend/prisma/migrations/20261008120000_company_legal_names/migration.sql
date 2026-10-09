-- Настоящие названия юрлиц вместо «METALL ASIA Trade» и «METALL ASIA Plant».
--
-- Со встречи 07.10 (реплика 152): это две разные компании - оптовая торговля
-- ООО «Металл Азия» и завод ООО «Ташкентский изоляционный завод» (ТИЗ), а не
-- два подразделения одного бренда. Написание сверено с сайтами клиента
-- metallasia.uz и tiz.uz.
--
-- Миграцией, а не пересевом: пересев стирает данные и сбрасывает пароли, а на
-- стенде и на дев-базе уже живут операции и учётки.
--
-- Пометка «(демо)» сохраняется: по ней на стенде видно, что данные
-- ненастоящие, и терять её при переименовании нельзя.
UPDATE "company"
   SET "name_ru" = CASE WHEN "name_ru" LIKE '%(демо)%'
                        THEN 'ООО «Металл Азия» (демо)'
                        ELSE 'ООО «Металл Азия»' END,
       "name_uz" = CASE WHEN "name_uz" LIKE '%(demo)%'
                        THEN '«Metall Asia» MChJ (demo)'
                        ELSE '«Metall Asia» MChJ' END
 WHERE "code" = 'trade';

UPDATE "company"
   SET "name_ru" = CASE WHEN "name_ru" LIKE '%(демо)%'
                        THEN 'ООО «Ташкентский изоляционный завод» (демо)'
                        ELSE 'ООО «Ташкентский изоляционный завод»' END,
       "name_uz" = CASE WHEN "name_uz" LIKE '%(demo)%'
                        THEN '«Toshkent izolyatsiya zavodi» MChJ (demo)'
                        ELSE '«Toshkent izolyatsiya zavodi» MChJ' END
 WHERE "code" = 'plant';
