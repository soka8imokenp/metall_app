-- Привязка учётной записи Telegram к человеку (ТЗ 11.2, 6.7).
--
-- Столбец `user_account.telegram_user_id` существовал с первого дня, но
-- заполнить его было нечем: ни кода, ни маршрута, ни следа в журнале. Бот без
-- этого не знает, кто ему пишет, а администратор — кто подключён.
--
-- Код живёт здесь хешем, а не текстом: это пароль на один раз. Увидеть его можно
-- только в ответе на выдачу — в базе его нет даже у владельца базы.
CREATE TABLE "telegram_link_code" (
  "id"         BIGSERIAL PRIMARY KEY,
  "user_id"    BIGINT NOT NULL REFERENCES "user_account"("id") ON DELETE CASCADE,
  "code_hash"  TEXT NOT NULL,
  "expires_at" TIMESTAMPTZ NOT NULL,
  "used_at"    TIMESTAMPTZ,
  "revoked_at" TIMESTAMPTZ,
  "created_by" BIGINT REFERENCES "user_account"("id") ON DELETE SET NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Хеш уникален: два живых кода с одним значением означали бы, что один код
-- подключает двух разных людей.
CREATE UNIQUE INDEX "telegram_link_code_hash_key" ON "telegram_link_code"("code_hash");
CREATE INDEX "telegram_link_code_user_idx" ON "telegram_link_code"("user_id", "created_at" DESC);

-- Когда подключили. Кто отключил и когда — в журнале действий: это событие, а
-- не состояние, и переписывать его следующей привязкой нельзя.
ALTER TABLE "user_account" ADD COLUMN IF NOT EXISTS "telegram_linked_at" TIMESTAMPTZ;
