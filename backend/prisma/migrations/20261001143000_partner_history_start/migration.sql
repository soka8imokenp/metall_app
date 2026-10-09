-- Начало истории у клиентов, заведённых превращением обращения.
--
-- `convert()` журнал не писал вовсе, поэтому такой клиент появлялся в базе
-- из ниоткуда: в карточке есть сделки и правки, а записи о заведении нет.
-- Служба теперь пишет её сама; этой миграцией чинятся уже заведённые.
--
-- Это не выдуманная история: время берётся из самой карточки, автор — её
-- менеджер, источник помечен `system`, чтобы запись не выдавала себя за
-- действие человека в интерфейсе. Правок задним числом не дописываем —
-- только начало, которого не было.
INSERT INTO audit_log (company_id, user_id, occurred_at, source, entity_type, entity_id,
                       action, changes)
SELECT p.company_id,
       p.manager_id,
       p.created_at,
       'system'::"AuditSource",
       'partner',
       p.uid::text,
       'create',
       jsonb_build_object('nameRu', jsonb_build_object('from', NULL, 'to', p.name_ru))
  FROM partner p
 WHERE NOT EXISTS (
         SELECT 1
           FROM audit_log al
          WHERE al.entity_type = 'partner'
            AND al.entity_id = p.uid::text
            AND al.action = 'create'
       );
