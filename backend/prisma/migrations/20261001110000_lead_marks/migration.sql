-- Откуда пришло обращение: метки визита (SEO и реклама).
--
-- До этого происхождение знал только справочник: менеджер выбирал «Сайт» или
-- «Реклама» руками. Для SEO этого мало — надо отличать поиск от контекста, а
-- внутри поиска видеть страницу входа и запрос, и доводить это до денег.
--
-- Два касания, а не одно. Человек находит сайт в поиске, уходит думать, через
-- неделю возвращается прямым заходом и оставляет заявку. По последнему
-- касанию SEO не получит ничего, по первому — получит и чужое. Поэтому
-- хранятся оба: `source_id` и `utm_*` — последнее касание, `first_*` — первое,
-- и первое после записи не меняется.

ALTER TABLE "lead" ADD COLUMN IF NOT EXISTS "visitor_id"   TEXT;
ALTER TABLE "lead" ADD COLUMN IF NOT EXISTS "landing_url"  TEXT;
ALTER TABLE "lead" ADD COLUMN IF NOT EXISTS "referrer"     TEXT;
ALTER TABLE "lead" ADD COLUMN IF NOT EXISTS "utm_source"   TEXT;
ALTER TABLE "lead" ADD COLUMN IF NOT EXISTS "utm_medium"   TEXT;
ALTER TABLE "lead" ADD COLUMN IF NOT EXISTS "utm_campaign" TEXT;
ALTER TABLE "lead" ADD COLUMN IF NOT EXISTS "utm_content"  TEXT;
ALTER TABLE "lead" ADD COLUMN IF NOT EXISTS "utm_term"     TEXT;
-- gclid/yclid/fbclid: по нему клик опознаёт рекламная система. Хранится как
-- есть, своего смысла у нас не несёт.
ALTER TABLE "lead" ADD COLUMN IF NOT EXISTS "click_id"     TEXT;
-- client_id Метрики или GA: по нему заявку сводят с визитом в их отчётах и
-- по нему же возвращают офлайн-конверсию обратно.
ALTER TABLE "lead" ADD COLUMN IF NOT EXISTS "analytics_id" TEXT;
-- Какая форма на сайте: «заказать звонок» и «рассчитать стоимость» — разные
-- заявки, и считают их отдельно.
ALTER TABLE "lead" ADD COLUMN IF NOT EXISTS "form_code"    TEXT;

ALTER TABLE "lead" ADD COLUMN IF NOT EXISTS "first_at"           TIMESTAMPTZ;
ALTER TABLE "lead" ADD COLUMN IF NOT EXISTS "first_source"       TEXT;
ALTER TABLE "lead" ADD COLUMN IF NOT EXISTS "first_medium"       TEXT;
ALTER TABLE "lead" ADD COLUMN IF NOT EXISTS "first_campaign"     TEXT;
ALTER TABLE "lead" ADD COLUMN IF NOT EXISTS "first_landing_url"  TEXT;
ALTER TABLE "lead" ADD COLUMN IF NOT EXISTS "first_referrer"     TEXT;
ALTER TABLE "lead" ADD COLUMN IF NOT EXISTS "first_source_id"    BIGINT REFERENCES "lead_source"("id");

CREATE INDEX IF NOT EXISTS "lead_marks_campaign" ON "lead"("company_id", "utm_source", "utm_campaign");

-- Ключ сайта: по нему заявка с чужой страницы попадает в нужную компанию.
--
-- Секрета здесь нет намеренно. Форму отправляет браузер посетителя, и любой
-- «секрет» лежал бы в исходном коде страницы на виду. Защищают три вещи:
-- список разрешённых адресов страниц (origin), ограничение частоты и ловушка
-- для ботов — поле, которое человек не видит и не заполняет.
--
-- RLS нет по той же причине, что у `user_account`: ключ читают до того, как
-- компания известна, — он её и определяет.
CREATE TABLE IF NOT EXISTS "site_key" (
  "id"           BIGSERIAL PRIMARY KEY,
  "uid"          UUID NOT NULL DEFAULT gen_random_uuid(),
  "company_id"   BIGINT NOT NULL REFERENCES "company"("id") ON DELETE RESTRICT,
  "code"         TEXT NOT NULL,
  "name"         TEXT NOT NULL,
  "origins"      TEXT[] NOT NULL DEFAULT '{}',
  "is_active"    BOOLEAN NOT NULL DEFAULT true,
  "created_at"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  "last_used_at" TIMESTAMPTZ,
  "used_count"   INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS "site_key_uid_key"  ON "site_key"("uid");
CREATE UNIQUE INDEX IF NOT EXISTS "site_key_code_key" ON "site_key"("code");

-- Правило: какие метки каким источником справочника считать.
--
-- Правило строкой, а не кодом: появится новый канал — заведут правило, не
-- дожидаясь выкатки. Пустое условие значит «любой», побеждает правило с
-- меньшим приоритетом. Правило со всеми пустыми условиями — запасное.
CREATE TABLE IF NOT EXISTS "lead_source_rule" (
  "id"               BIGSERIAL PRIMARY KEY,
  "uid"              UUID NOT NULL DEFAULT gen_random_uuid(),
  "company_id"       BIGINT NOT NULL REFERENCES "company"("id") ON DELETE RESTRICT,
  "priority"         INTEGER NOT NULL DEFAULT 100,
  "name"             TEXT NOT NULL,
  "match_medium"     TEXT,
  "match_source"     TEXT,
  "match_referrer"   TEXT,
  "match_has_click"  BOOLEAN,
  "match_has_marks"  BOOLEAN,
  "match_has_referrer" BOOLEAN,
  "source_id"        BIGINT NOT NULL REFERENCES "lead_source"("id") ON DELETE RESTRICT,
  "is_active"        BOOLEAN NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX IF NOT EXISTS "lead_source_rule_uid_key" ON "lead_source_rule"("uid");
CREATE INDEX IF NOT EXISTS "lead_source_rule_order" ON "lead_source_rule"("company_id", "priority", "id");

ALTER TABLE "lead_source_rule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lead_source_rule" FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE tablename = 'lead_source_rule' AND policyname = 'company_isolation'
  ) THEN
    CREATE POLICY company_isolation ON "lead_source_rule"
      USING (company_id = ANY (app.current_company_ids()))
      WITH CHECK (company_id = ANY (app.current_company_ids()));
  END IF;
END $$;

-- Источники, которых не было: поиск, прямой заход и переход по ссылке.
-- Без них метки некуда раскладывать — «Сайт» один на всё.
INSERT INTO "lead_source" ("company_id", "uid", "code", "name_ru", "name_uz", "channel")
SELECT c.id, gen_random_uuid(), v.code, v.name_ru, v.name_uz, v.channel::"LeadChannel"
  FROM "company" c
 CROSS JOIN (VALUES
   ('seo',      'Поиск (SEO)',        'Qidiruv (SEO)',        'site'),
   ('direct',   'Прямой заход',       'To‘g‘ridan-to‘g‘ri',   'site'),
   ('referral', 'Переход по ссылке',  'Havola orqali o‘tish', 'site')
 ) AS v(code, name_ru, name_uz, channel)
 WHERE NOT EXISTS (
   SELECT 1 FROM "lead_source" s WHERE s.company_id = c.id AND s.code = v.code
 );

-- Запас правил по умолчанию. Их видно и их правят — это не код.
INSERT INTO "lead_source_rule"
  ("company_id", "priority", "name", "match_medium", "match_source", "match_referrer",
   "match_has_click", "match_has_marks", "match_has_referrer", "source_id")
SELECT s.company_id, v.priority, v.name,
       v.match_medium, v.match_source, v.match_referrer,
       v.has_click, v.has_marks, v.has_referrer, s.id
  FROM (VALUES
    (10,  'Поиск: organic',            'organic', NULL,       NULL, NULL,  NULL,  NULL,  'seo'),
    (20,  'Клик из рекламной системы', NULL,      NULL,       NULL, true,  NULL,  NULL,  'ads'),
    (30,  'Контекст: cpc',             'cpc',     NULL,       NULL, NULL,  NULL,  NULL,  'ads'),
    (40,  'Telegram',                  NULL,      'telegram', NULL, NULL,  NULL,  NULL,  'telegram'),
    (50,  'Переход: referral',         'referral', NULL,      NULL, NULL,  NULL,  NULL,  'referral'),
    (60,  'Без меток, без перехода',   NULL,      NULL,       NULL, NULL,  false, false, 'direct'),
    (70,  'Без меток, но с переходом', NULL,      NULL,       NULL, NULL,  false, true,  'referral'),
    (100, 'Запасное: сайт',            NULL,      NULL,       NULL, NULL,  NULL,  NULL,  'site')
  ) AS v(priority, name, match_medium, match_source, match_referrer,
         has_click, has_marks, has_referrer, source_code)
  JOIN "lead_source" s ON s.code = v.source_code
 WHERE NOT EXISTS (
   SELECT 1 FROM "lead_source_rule" r
    WHERE r.company_id = s.company_id AND r.priority = v.priority
 );
