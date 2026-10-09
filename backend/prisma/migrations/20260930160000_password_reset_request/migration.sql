-- Заявка на сброс пароля.
--
-- Пароль система сама не рассылает: почтового и телеграм-тракта нет ни в
-- одном модуле, а выдавать новый пароль по одному лишь знанию логина нельзя —
-- это готовый способ захватить чужую учётку. Поэтому заявка не меняет пароль,
-- а кладётся в очередь: администратор видит её, узнаёт человека и выдаёт
-- пароль тем способом, которым у них принято.
--
-- Компании у заявки нет: её подают снаружи, до входа, когда неизвестно ещё
-- ничего, кроме набранного логина. По этой же причине здесь нет RLS.
CREATE TABLE "password_reset_request" (
  "id"           BIGSERIAL PRIMARY KEY,
  "uid"          UUID NOT NULL DEFAULT gen_random_uuid(),
  -- Что человек набрал в поле «логин». Может не совпасть ни с чьим: заявку
  -- принимаем всё равно, иначе форма отвечала бы, какие логины существуют.
  "login"        TEXT NOT NULL,
  "contact"      TEXT NOT NULL,
  "note"         TEXT,
  "user_id"      BIGINT REFERENCES "user_account"("id"),
  "status"       TEXT NOT NULL DEFAULT 'new',
  "handled_by"   BIGINT REFERENCES "user_account"("id"),
  "handled_at"   TIMESTAMPTZ,
  "handled_note" TEXT,
  "created_at"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "password_reset_request_status_known"
    CHECK ("status" IN ('new', 'done', 'rejected'))
);

CREATE UNIQUE INDEX "password_reset_request_uid_key" ON "password_reset_request"("uid");
CREATE INDEX "password_reset_request_queue" ON "password_reset_request"("status", "created_at" DESC);

-- Открытая заявка по логину ровно одна. Нажали «отправить» десять раз —
-- в очереди одна строка со свежим временем, а не десять одинаковых: список
-- администратора не должен тонуть от повторного нажатия.
CREATE UNIQUE INDEX "password_reset_request_open_login"
  ON "password_reset_request"("login") WHERE "status" = 'new';
