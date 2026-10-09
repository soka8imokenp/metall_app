-- Кладовщик видит производство (ТЗ 4.1, Э4).
--
-- Материал в цех выдаёт он, и выдаёт по заказу: без права смотреть заказ
-- выдача из карточки заказа ему недоступна, а выдача «вообще со склада»
-- не привязывается ни к какому заказу. Только просмотр — вести заказы
-- производства кладовщик по-прежнему не может.

INSERT INTO role_permission (role_id, permission_id)
SELECT r.id, p.id
  FROM role r, permission p
 WHERE r.company_id IS NULL AND r.code = 'warehouse_keeper' AND p.code = 'production.view'
ON CONFLICT DO NOTHING;
