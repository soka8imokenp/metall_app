-- Демо-смены завода: две по восемь часов. Свой график завод назовёт отдельно
-- (09-CLIENT-INPUTS.md) — строки заводятся только там, где их ещё нет, и
-- только у компании с участками: смены нужны производству, не торговле.
INSERT INTO production_shift (company_id, code, name_ru, name_uz, starts_at, ends_at, is_active)
SELECT c.id, v.code, v.ru, v.uz, v.starts::time, v.ends::time, true
  FROM company c
 CROSS JOIN (VALUES
    ('S1', 'Первая смена', 'Birinchi smena', '08:00', '16:00'),
    ('S2', 'Вторая смена', 'Ikkinchi smena', '16:00', '00:00')
 ) AS v(code, ru, uz, starts, ends)
 WHERE EXISTS (SELECT 1 FROM work_center w WHERE w.company_id = c.id AND w.is_active)
   AND NOT EXISTS (
     SELECT 1 FROM production_shift s WHERE s.company_id = c.id AND s.code = v.code);
