-- Обменный слой для интеграций (ТЗ 12, 02-ARCHITECTURE §10).
--
-- Универсальный каркас, а не коннектор: ни по 1С, ни по REGOS, ни по банку,
-- ни по телефонии нет ни доступа, ни документации, и ТЗ 12 прямо говорит, что
-- состав каждой интеграции уточняется после их предоставления. Каркас при этом
-- нужен сейчас: он снимает интеграции с критического пути — 1С недоступна,
-- а заказ всё равно создаётся, обмен ждёт в очереди.
--
-- Четыре таблицы, и ни одной лишней. Журнал обменов и очередь исходящих — это
-- одна и та же таблица `exchange_message`: разведи их, и вторая разойдётся
-- с первой на первом же повторе.

-- Внешняя система: подключение с ключом.
--
-- Устроено по образцу `site_key` (ключи сайта, ТЗ 2.4) — тот же набор полей,
-- та же пара «выключить и завести новый» вместо смены пароля. Разница в двух
-- местах, и обе от того, что обмен серверный, а не браузерный:
--
--   * ключ здесь настоящий секрет, в исходный код чужой страницы он не уходит.
--     Поэтому в базе лежит `sha256`, а не сам ключ. Именно sha256, а не bcrypt:
--     по ключу нужен поиск на входящем запросе, а bcrypt найти строку не даёт.
--     Перебирать там нечего — 24 знака из 18 случайных байт;
--   * `allowed_ips` — адреса отправителя, а не адреса страницы: браузера в
--     обмене нет, и `Origin` ничего не значит.
--
-- `signing_secret` лежит восстановимым: HMAC без него не посчитать. Наружу он
-- не отдаётся ни разу после создания — API сообщает только, задан он или нет.
CREATE TABLE IF NOT EXISTS "external_system" (
  "id"             BIGSERIAL      NOT NULL,
  "uid"            UUID           NOT NULL DEFAULT gen_random_uuid(),
  "company_id"     BIGINT         NOT NULL,
  "code"           TEXT           NOT NULL,
  "name"           TEXT           NOT NULL,
  "is_active"      BOOLEAN        NOT NULL DEFAULT true,
  "key_hash"       TEXT           NOT NULL,
  -- Последние знаки ключа: по ним человек узнаёт, тот ли ключ прописан у него
  -- в чужой системе, не получая ключ второй раз.
  "key_tail"       TEXT           NOT NULL,
  "signing_secret" TEXT,
  "allowed_ips"    TEXT[]         NOT NULL DEFAULT '{}',
  "comment"        TEXT,
  "created_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "last_used_at"   TIMESTAMPTZ(6),
  "used_count"     INTEGER        NOT NULL DEFAULT 0,
  CONSTRAINT "external_system_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "external_system_company_fkey" FOREIGN KEY ("company_id")
    REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "external_system_uid_key" ON "external_system"("uid");
CREATE UNIQUE INDEX IF NOT EXISTS "external_system_code_key"
  ON "external_system"("company_id", "code");
-- Поиск по ключу идёт без компании: входящий запрос ещё не знает, чей он.
-- Ключ уникален во всей таблице, иначе один и тот же ключ мог бы завестись
-- в двух компаниях и обмен уходил бы не туда.
CREATE UNIQUE INDEX IF NOT EXISTS "external_system_key_hash_key"
  ON "external_system"("key_hash");

ALTER TABLE "external_system" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "external_system" FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE tablename = 'external_system' AND policyname = 'company_isolation'
  ) THEN
    CREATE POLICY company_isolation ON "external_system"
      USING (company_id = ANY (app.current_company_ids()))
      WITH CHECK (company_id = ANY (app.current_company_ids()));
  END IF;
END $$;

-- Подписка на событие системы.
--
-- Событие — это запись журнала действий: `<сущность>.<действие>`
-- (`sales_order.ship`, `item.create`). Второго списка событий в системе не
-- заводится: журнал значимых действий (ТЗ 13.3) уже отобран по смыслу и уже
-- переведён на два языка, а второй список разошёлся бы с ним на первой правке.
CREATE TABLE IF NOT EXISTS "webhook_subscription" (
  "id"         BIGSERIAL      NOT NULL,
  "uid"        UUID           NOT NULL DEFAULT gen_random_uuid(),
  "company_id" BIGINT         NOT NULL,
  "system_id"  BIGINT         NOT NULL,
  "event"      TEXT           NOT NULL,
  "url"        TEXT           NOT NULL,
  "is_active"  BOOLEAN        NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "webhook_subscription_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "webhook_subscription_company_fkey" FOREIGN KEY ("company_id")
    REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "webhook_subscription_system_fkey" FOREIGN KEY ("system_id")
    REFERENCES "external_system"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "webhook_subscription_uid_key"
  ON "webhook_subscription"("uid");
CREATE UNIQUE INDEX IF NOT EXISTS "webhook_subscription_event_key"
  ON "webhook_subscription"("system_id", "event");
-- Под крючок в `writeAudit`: на каждую запись журнала спрашивается, подписан ли
-- кто-нибудь на это событие в этой компании. Без индекса это был бы проход по
-- таблице на каждой складской операции.
CREATE INDEX IF NOT EXISTS "webhook_subscription_lookup"
  ON "webhook_subscription"("company_id", "event") WHERE "is_active";

ALTER TABLE "webhook_subscription" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "webhook_subscription" FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE tablename = 'webhook_subscription' AND policyname = 'company_isolation'
  ) THEN
    CREATE POLICY company_isolation ON "webhook_subscription"
      USING (company_id = ANY (app.current_company_ids()))
      WITH CHECK (company_id = ANY (app.current_company_ids()));
  END IF;
END $$;

-- Сообщение обмена: оно же очередь исходящих, оно же защита от повтора
-- входящих, оно же журнал обменов.
--
-- Механика доставки повторена с очереди уведомлений (`notification_outbox`):
-- `attempts`, `last_error`, предел попыток, пара «отметить доставленным /
-- отметить неудачей». Чего в уведомлениях нет и что добавлено здесь:
--
--   * `next_attempt_at` — нарастающая задержка. Уведомления берут неудачную
--     строку снова на том же проходе, и для Telegram это терпимо; для чужого
--     сервера, который лежит, это обстрел;
--   * `external_id` с уникальностью — идемпотентность входящих;
--   * получатель. У уведомления получатель — человек с Telegram
--     (`user_id NOT NULL`), у вебхука — URL. Долить вебхуки в ту таблицу
--     значило бы сломать и колонку, и её уникальность.
CREATE TABLE IF NOT EXISTS "exchange_message" (
  "id"              BIGSERIAL      NOT NULL,
  "uid"             UUID           NOT NULL DEFAULT gen_random_uuid(),
  "company_id"      BIGINT         NOT NULL,
  "system_id"       BIGINT         NOT NULL,
  -- `in` — пришло к нам, `out` — ушло от нас. Словами, а не типом: вид обмена
  -- читают в журнале, и расширять перечисление миграцией тут незачем.
  "direction"       TEXT           NOT NULL,
  "event"           TEXT           NOT NULL,
  -- Идентификатор сообщения во внешней системе. Пусто — повтор отследить
  -- нечем, и это её выбор, а не наш недосмотр.
  "external_id"     TEXT,
  "status"          TEXT           NOT NULL DEFAULT 'pending',
  "attempts"        INTEGER        NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "last_error"      TEXT,
  "url"             TEXT,
  "http_status"     INTEGER,
  -- Тела усечены при записи, а не при показе: журнал обменов за месяц иначе
  -- занимает больше, чем весь учёт.
  "request_body"    TEXT,
  "response_body"   TEXT,
  "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "processed_at"    TIMESTAMPTZ(6),
  CONSTRAINT "exchange_message_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "exchange_message_company_fkey" FOREIGN KEY ("company_id")
    REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "exchange_message_system_fkey" FOREIGN KEY ("system_id")
    REFERENCES "external_system"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "exchange_message_direction_chk"
    CHECK ("direction" IN ('in', 'out')),
  CONSTRAINT "exchange_message_status_chk"
    CHECK ("status" IN ('pending', 'done', 'failed', 'dead'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "exchange_message_uid_key"
  ON "exchange_message"("uid");
-- Идемпотентность. Частичный индекс: пустой `external_id` повтором считать
-- нельзя, и NULL в уникальном индексе не сравниваются — без `WHERE` второе
-- сообщение без идентификатора прошло бы, а третье нет (в зависимости от
-- версии), и поведение было бы необъяснимым.
CREATE UNIQUE INDEX IF NOT EXISTS "exchange_message_external_key"
  ON "exchange_message"("system_id", "direction", "external_id")
  WHERE "external_id" IS NOT NULL;
-- Выборка очереди: что не доставлено и чей срок подошёл.
CREATE INDEX IF NOT EXISTS "exchange_message_queue"
  ON "exchange_message"("next_attempt_at")
  WHERE "status" = 'pending' AND "direction" = 'out';
-- Журнал: последние сверху, в разрезе компании.
CREATE INDEX IF NOT EXISTS "exchange_message_journal"
  ON "exchange_message"("company_id", "created_at" DESC);

ALTER TABLE "exchange_message" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "exchange_message" FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE tablename = 'exchange_message' AND policyname = 'company_isolation'
  ) THEN
    CREATE POLICY company_isolation ON "exchange_message"
      USING (company_id = ANY (app.current_company_ids()))
      WITH CHECK (company_id = ANY (app.current_company_ids()));
  END IF;
END $$;

-- Карта соответствий внешних и наших идентификаторов.
--
-- Обязательна, и это не предосторожность: коды номенклатуры в 1С и у нас не
-- совпадут никогда. Без карты каждый обмен заводил бы позицию заново.
CREATE TABLE IF NOT EXISTS "external_ref" (
  "id"           BIGSERIAL      NOT NULL,
  "uid"          UUID           NOT NULL DEFAULT gen_random_uuid(),
  "company_id"   BIGINT         NOT NULL,
  "system_id"    BIGINT         NOT NULL,
  "entity_type"  TEXT           NOT NULL,
  "external_id"  TEXT           NOT NULL,
  "internal_uid" UUID           NOT NULL,
  "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "external_ref_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "external_ref_company_fkey" FOREIGN KEY ("company_id")
    REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "external_ref_system_fkey" FOREIGN KEY ("system_id")
    REFERENCES "external_system"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "external_ref_uid_key" ON "external_ref"("uid");
-- В обе стороны, и это не дублирование. Только «чужой → наш», и наша позиция
-- могла бы получить два чужих кода — то есть ровно тот дубль, от которого карта
-- и заводится. Только «наш → чужой» — и чужой код лёг бы на две наши позиции.
CREATE UNIQUE INDEX IF NOT EXISTS "external_ref_external_key"
  ON "external_ref"("system_id", "entity_type", "external_id");
CREATE UNIQUE INDEX IF NOT EXISTS "external_ref_internal_key"
  ON "external_ref"("system_id", "entity_type", "internal_uid");

ALTER TABLE "external_ref" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "external_ref" FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE tablename = 'external_ref' AND policyname = 'company_isolation'
  ) THEN
    CREATE POLICY company_isolation ON "external_ref"
      USING (company_id = ANY (app.current_company_ids()))
      WITH CHECK (company_id = ANY (app.current_company_ids()));
  END IF;
END $$;
