-- Разговор человека с ботом живёт здесь, а не в памяти процесса: перезапуск
-- бота не должен спрашивать язык и пароль заново. Компании у строки нет
-- намеренно — диалог принадлежит человеку, а не компании, и политике по
-- company_id здесь не на что опереться.
CREATE TABLE telegram_session (
  id               bigserial PRIMARY KEY,
  chat_id          bigint      NOT NULL UNIQUE,
  telegram_user_id bigint      NOT NULL,
  user_id          bigint      REFERENCES user_account(id) ON DELETE SET NULL,
  locale           text        NOT NULL DEFAULT 'ru',
  step             text        NOT NULL DEFAULT 'language',
  -- Логин ждёт пароля один шаг. Пароль здесь не хранится никогда: он
  -- проверяется и забывается в той же функции, которая его прочитала.
  pending_login    text,
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX telegram_session_user_idx ON telegram_session (user_id);
