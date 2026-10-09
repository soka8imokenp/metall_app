-- Демо-формулировки причин отхода: по одной паре на каждую компанию.
-- Свои слова заказчик назовёт отдельно (09-CLIENT-INPUTS.md), поэтому строки
-- заводятся только там, где их ещё нет.
INSERT INTO stock_reason (company_id, kind, name_ru, name_uz, is_active)
SELECT c.id, 'waste', v.ru, v.uz, true
  FROM company c
 CROSS JOIN (VALUES
    ('Технологическая обрезь', 'Texnologik qirqim'),
    ('Стружка и окалина', 'Qirindi va kuyundi')
 ) AS v(ru, uz)
 WHERE NOT EXISTS (
   SELECT 1 FROM stock_reason r
    WHERE r.company_id = c.id AND r.kind = 'waste' AND r.name_ru = v.ru);
