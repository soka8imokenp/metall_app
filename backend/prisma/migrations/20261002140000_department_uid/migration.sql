-- Подразделению нужен внешний идентификатор.
--
-- Наружу API отдаёт только uid: внутренний id не показываем нигде. Из-за этого
-- подразделение нельзя было ни назвать в бюджете (ТЗ 6.6), ни выбрать при
-- назначении роли — код в admin уже искал `department.uid`, которого в базе не
-- было, и этот путь просто не мог сработать.
ALTER TABLE department ADD COLUMN IF NOT EXISTS uid uuid;
UPDATE department SET uid = gen_random_uuid() WHERE uid IS NULL;
ALTER TABLE department ALTER COLUMN uid SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "department_uid_key" ON department (uid);
