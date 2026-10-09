-- Производственный календарь (Э7): смены, выходные и рабочая неделя.
--
-- До этого сроки считались календарными днями, а загрузка участка — только
-- отработанными минутами: сказать «участок загружен на 80%» было не из чего.

-- Рабочая неделя компании: ISO-дни недели (1 — понедельник, 7 — воскресенье).
-- Умолчание «понедельник–суббота» — демо-значение; свой график завод назовёт
-- отдельно (09-CLIENT-INPUTS.md).
ALTER TABLE "company"
  ADD COLUMN IF NOT EXISTS "work_days" integer[] NOT NULL DEFAULT ARRAY[1,2,3,4,5,6];

-- Смена: во сколько начинается и во сколько кончается. Ночная смена проходит
-- через полночь — конец меньше начала, и длительность считается с переходом.
CREATE TABLE IF NOT EXISTS "production_shift" (
  "id"         BIGSERIAL    NOT NULL,
  "uid"        UUID         NOT NULL DEFAULT gen_random_uuid(),
  "company_id" BIGINT       NOT NULL,
  "code"       TEXT         NOT NULL,
  "name_ru"    TEXT         NOT NULL,
  "name_uz"    TEXT         NOT NULL,
  "starts_at"  TIME(0)      NOT NULL,
  "ends_at"    TIME(0)      NOT NULL,
  "is_active"  BOOLEAN      NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "production_shift_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "production_shift_company_fkey" FOREIGN KEY ("company_id")
    REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "production_shift_uid_key" ON "production_shift"("uid");
CREATE UNIQUE INDEX IF NOT EXISTS "production_shift_code_key"
  ON "production_shift"("company_id", "code");

ALTER TABLE "production_shift" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "production_shift" FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE tablename = 'production_shift' AND policyname = 'company_isolation'
  ) THEN
    CREATE POLICY company_isolation ON "production_shift"
      USING (company_id = ANY (app.current_company_ids()))
      WITH CHECK (company_id = ANY (app.current_company_ids()));
  END IF;
END $$;

-- Исключения календаря: праздник среди недели или рабочая суббота. Обычные
-- дни в таблице не лежат — их задаёт рабочая неделя компании.
CREATE TABLE IF NOT EXISTS "production_calendar_day" (
  "id"         BIGSERIAL    NOT NULL,
  "company_id" BIGINT       NOT NULL,
  "day"        DATE         NOT NULL,
  "is_working" BOOLEAN      NOT NULL,
  "comment"    TEXT,
  "created_by" BIGINT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "production_calendar_day_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "production_calendar_day_company_fkey" FOREIGN KEY ("company_id")
    REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "production_calendar_day_user_fkey" FOREIGN KEY ("created_by")
    REFERENCES "user_account"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "production_calendar_day_key"
  ON "production_calendar_day"("company_id", "day");

ALTER TABLE "production_calendar_day" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "production_calendar_day" FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE tablename = 'production_calendar_day' AND policyname = 'company_isolation'
  ) THEN
    CREATE POLICY company_isolation ON "production_calendar_day"
      USING (company_id = ANY (app.current_company_ids()))
      WITH CHECK (company_id = ANY (app.current_company_ids()));
  END IF;
END $$;

-- Простой участка бывает и без этапа: линия стояла без заказа, а записать это
-- надо. Поэтому у отклонения появляется свой участок.
ALTER TABLE "deviation_log"
  ADD COLUMN IF NOT EXISTS "work_center_id" BIGINT;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'deviation_log_work_center_fkey'
  ) THEN
    ALTER TABLE "deviation_log"
      ADD CONSTRAINT "deviation_log_work_center_fkey" FOREIGN KEY ("work_center_id")
      REFERENCES "work_center"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
