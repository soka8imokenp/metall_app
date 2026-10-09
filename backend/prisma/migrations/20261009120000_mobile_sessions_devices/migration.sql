-- Мобильное приложение: сессии, устройства, push и настройки (ТЗ 10,
-- 02-ARCHITECTURE 7.1, 06-BACKEND §7).
--
-- Политик RLS у этих таблиц нет, как и у `user_account`: сессии и устройства
-- принадлежат человеку, а не компании — кладовщик с одного телефона работает
-- в обеих. Видимость решает код (свои — всем, чужие — только с `admin.users`).

-- Устройство — установка приложения на конкретном телефоне. Ключ —
-- `installation_id`, который приложение придумывает само при первом запуске:
-- модель телефона не уникальна, а серийные номера телефоны не отдают.
CREATE TABLE "device" (
  "id"              BIGSERIAL PRIMARY KEY,
  "uid"             UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id"         BIGINT NOT NULL REFERENCES "user_account"("id") ON DELETE CASCADE,
  "installation_id" TEXT NOT NULL,
  "platform"        TEXT NOT NULL,
  "model"           TEXT,
  "os_version"      TEXT,
  "app_version"     TEXT,
  -- Адрес для push. Пусто — уведомлений на это устройство не шлём.
  "push_token"      TEXT,
  "push_provider"   TEXT,
  "created_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  "last_seen_at"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Отзыв администратором: телефон потерян или сотрудник ушёл. С отозванного
  -- устройства не входят и не обновляют сессию, пока его не вернут.
  "revoked_at"      TIMESTAMPTZ,
  "revoked_by"      BIGINT REFERENCES "user_account"("id"),
  CONSTRAINT "device_platform_known" CHECK ("platform" IN ('android', 'ios', 'web')),
  CONSTRAINT "device_push_provider_known" CHECK ("push_provider" IS NULL OR "push_provider" IN ('expo', 'fcm'))
);
CREATE UNIQUE INDEX "device_uid_key" ON "device"("uid");
CREATE UNIQUE INDEX "device_user_installation_key" ON "device"("user_id", "installation_id");

-- Сессия входа. Есть у каждого входа — и у браузера, и у телефона: отозвать
-- администратор должен уметь любую. У телефона короткий токен доступа (15 мин)
-- и долгий refresh-токен; в базе лежит только хеш refresh-токена, сам токен
-- знает лишь телефон.
CREATE TABLE "auth_session" (
  "id"            BIGSERIAL PRIMARY KEY,
  "uid"           UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id"       BIGINT NOT NULL REFERENCES "user_account"("id") ON DELETE CASCADE,
  "client"        TEXT NOT NULL,
  "device_id"     BIGINT REFERENCES "device"("id") ON DELETE SET NULL,
  "refresh_hash"  TEXT,
  "ip"            TEXT,
  "user_agent"    TEXT,
  "created_at"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  "last_used_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  "expires_at"    TIMESTAMPTZ NOT NULL,
  "revoked_at"    TIMESTAMPTZ,
  "revoked_by"    BIGINT REFERENCES "user_account"("id"),
  "revoke_reason" TEXT,
  CONSTRAINT "auth_session_client_known" CHECK ("client" IN ('web', 'mobile'))
);
CREATE UNIQUE INDEX "auth_session_uid_key" ON "auth_session"("uid");
CREATE UNIQUE INDEX "auth_session_refresh_hash_key" ON "auth_session"("refresh_hash");
CREATE INDEX "auth_session_user_active" ON "auth_session"("user_id") WHERE "revoked_at" IS NULL;
CREATE INDEX "auth_session_device" ON "auth_session"("device_id") WHERE "revoked_at" IS NULL;

-- Push идёт той же очередью, что Telegram (06-BACKEND §7), но отмечается
-- отдельно: одно и то же уведомление может уйти в бот и не уйти на телефон,
-- и наоборот.
ALTER TABLE "notification_outbox"
  ADD COLUMN "push_sent_at"  TIMESTAMPTZ,
  ADD COLUMN "push_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "push_error"    TEXT;

-- Настройки системы, которые меняет администратор, а не выкатка. Первая —
-- `mobile`: минимальная и актуальная версия приложения, ссылка на обновление.
CREATE TABLE "app_setting" (
  "key"        TEXT PRIMARY KEY,
  "value"      JSONB NOT NULL,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_by" BIGINT REFERENCES "user_account"("id")
);
