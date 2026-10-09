-- Уведомления бота (ТЗ 11.1): просроченные этапы, критические остатки,
-- просроченные задачи и платежи, документы на согласовании.
--
-- Две таблицы, а не одна. Настройка говорит, что человек хочет получать;
-- очередь помнит, что ему уже отправлено. Без очереди одно и то же событие
-- приходило бы на каждой проверке: «просрочено» не перестаёт быть просроченным
-- от того, что о нём сказали.
--
-- Компании у строк нет намеренно — как у `telegram_session`: уведомление
-- принадлежит человеку. Что он вправе увидеть, решается при сборке события:
-- оно собирается внутри его контекста (его права, его компании), и чужая
-- цифра в текст попасть не может.
CREATE TABLE notification_setting (
  id         bigserial PRIMARY KEY,
  user_id    bigint      NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  kind       text        NOT NULL,
  enabled    boolean     NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, kind)
);

CREATE TABLE notification_outbox (
  id         bigserial PRIMARY KEY,
  user_id    bigint      NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  kind       text        NOT NULL,
  -- Ключ повтора: предмет и дата события. Один платёж с одним сроком — одно
  -- сообщение, сколько бы раз проверка ни прошла.
  dedupe_key text        NOT NULL,
  text_ru    text        NOT NULL,
  text_uz    text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at    timestamptz,
  attempts   int         NOT NULL DEFAULT 0,
  last_error text,
  UNIQUE (user_id, kind, dedupe_key)
);

CREATE INDEX notification_outbox_pending_idx
  ON notification_outbox (sent_at, created_at)
  WHERE sent_at IS NULL;

-- Telegram не даёт боту написать первым тому, кто его заблокировал или не
-- нажимал «Старт». Это не ошибка отправки, а состояние человека: его видно в
-- «Настройки → Люди», и очередь на него больше не тратится.
ALTER TABLE user_account
  ADD COLUMN telegram_blocked    boolean NOT NULL DEFAULT false,
  ADD COLUMN telegram_blocked_at timestamptz;
