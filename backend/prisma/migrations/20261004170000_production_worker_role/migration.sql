-- Роль «Сотрудник производства» и право «отметки по своим этапам» (ТЗ 4.1).
--
-- Права и системные роли заводит сид, но сид — это посев пустой базы. На
-- стенде и в проде база уже живёт, пересевать её нельзя, а роль нужна там же,
-- где и в разработке. Поэтому справочные строки едут миграцией и пишутся так,
-- чтобы повторный прогон ничего не испортил.

INSERT INTO permission (code, module, description_ru, description_uz)
VALUES ('production.work', 'production', 'Отметки по своим этапам',
        'O‘z bosqichlari bo‘yicha belgilar')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role (company_id, code, name_ru, name_uz, is_system)
VALUES (NULL, 'production_worker', 'Сотрудник производства', 'Ishlab chiqarish xodimi', true)
ON CONFLICT DO NOTHING;

-- Кто отмечает этапы: рабочий — свои, начальник производства и выше — любые.
INSERT INTO role_permission (role_id, permission_id)
SELECT r.id, p.id
  FROM role r, permission p
 WHERE r.company_id IS NULL
   AND r.code IN ('admin', 'director', 'production_master', 'production_worker')
   AND p.code = 'production.work'
ON CONFLICT DO NOTHING;

-- Что рабочий видит: панель и производство. Больше ничего.
INSERT INTO role_permission (role_id, permission_id)
SELECT r.id, p.id
  FROM role r, permission p
 WHERE r.company_id IS NULL
   AND r.code = 'production_worker'
   AND p.code IN ('dashboard.view', 'production.view')
ON CONFLICT DO NOTHING;
