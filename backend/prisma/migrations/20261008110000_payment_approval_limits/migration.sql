-- Порог подтверждения платёжки и предел за период на получателя.
-- Требование заказчика со встречи 07.10: крупный платёж подтверждает владелец,
-- а не тот, кто утверждает обычные. Защита от «мелких транзакций» порогом по
-- одной операции не работает - нужен ещё предел на получателя за окно.
--
-- Миграцией, а не пересевом: пересев стенда и прода стирает данные и сбрасывает
-- пароли. Умолчания такие, что поведение существующих баз не меняется: порога и
-- предела нет, пока их не задали осознанно на экране настроек.

-- `IF NOT EXISTS` не для красоты: файл миграции Prisma не завёрнут в одну
-- транзакцию, и упавший на середине проход оставляет часть изменений в базе.
-- Без этого повторный `migrate deploy` после правки падал бы на уже созданном
-- столбце, и накатить миграцию было бы нечем.
ALTER TABLE "company"
  ADD COLUMN IF NOT EXISTS "approval_limit_single" DECIMAL(20,4),
  ADD COLUMN IF NOT EXISTS "approval_limit_period" DECIMAL(20,4),
  ADD COLUMN IF NOT EXISTS "approval_period_days" INTEGER NOT NULL DEFAULT 30;

-- Право на подтверждение крупного платежа. Имя сознательно НЕ кончается на
-- `.view`: роль «Собственник» набирает права правилом «все .view», и право на
-- решение о деньгах не должно достаться ей молча. Кому его выдать - решает
-- заказчик на экране «Роли и права», там правятся права и системных ролей.
INSERT INTO "permission" ("code", "module", "description_ru", "description_uz")
VALUES (
  'finance.approve.large',
  'finance',
  'Подтверждение крупных платежей',
  'Yirik to‘lovlarni tasdiqlash'
)
ON CONFLICT ("code") DO NOTHING;

-- Системным ролям - по тому же правилу, по которому они собраны в rbac.ts:
-- `admin` получает всё, `director` - всё, кроме администрирования.
INSERT INTO "role_permission" ("role_id", "permission_id")
SELECT r.id, p.id
  FROM "role" r
  JOIN "permission" p ON p.code = 'finance.approve.large'
 WHERE r.company_id IS NULL
   AND r.code IN ('admin', 'director')
ON CONFLICT DO NOTHING;
