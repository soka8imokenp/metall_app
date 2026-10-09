-- Справочники CRM на запись (ТЗ 8.3, 8.4).
--
-- До этой миграции стадии воронки, источники обращений и типы задач правились
-- только разработчиком: первые два жили строками сида, третий — перечислением
-- в самой базе. ТЗ 8.3 говорит «стадии настраиваются», а отчёт по источникам
-- оплачивают рекламой — значит и то и другое ведёт заказчик, а не мы.

-- 1. Выключение вместо удаления.
--
-- Справочник, по которому уже что-то записано, не удаляют: из отчёта за
-- прошлый квартал исчезло бы название, по которому он читается. Поэтому
-- источнику и стадии нужен тот же признак, что уже есть у причин отказа и у
-- складских причин списания.
ALTER TABLE "lead_source" ADD COLUMN "is_active" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "deal_stage" ADD COLUMN "is_active" BOOLEAN NOT NULL DEFAULT true;

-- Порядок стадий — это и есть воронка, читать её вразнобой нельзя.
CREATE INDEX "deal_stage_seq_idx" ON "deal_stage"("company_id", "seq");

-- 2. Типы задач справочником, а не перечислением в базе.
--
-- Перечисление меняется миграцией, то есть разработчиком: «выезд на объект»
-- заказчик себе не заведёт. Но тип задачи у нас не ярлык — закрытая задача
-- ложится активностью в ленту клиента, и от типа зависит, какой именно.
-- Поэтому у типа есть обязательное поле `activity_kind`: заводя свой тип,
-- человек обязан сказать, чем он окажется в истории общения. Без него лента
-- заполнилась бы заметками без разбора, и «покажи все звонки» перестало бы
-- отвечать правду.
CREATE TABLE "crm_task_type" (
  "id"            BIGSERIAL PRIMARY KEY,
  "uid"           UUID NOT NULL,
  "company_id"    BIGINT NOT NULL REFERENCES "company"("id"),
  "code"          TEXT NOT NULL,
  "name_ru"       TEXT NOT NULL,
  "name_uz"       TEXT NOT NULL,
  "activity_kind" "CrmActivityType" NOT NULL,
  "seq"           INTEGER NOT NULL DEFAULT 100,
  "is_active"     BOOLEAN NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX "crm_task_type_uid_key" ON "crm_task_type"("uid");
CREATE UNIQUE INDEX "crm_task_type_company_code_key" ON "crm_task_type"("company_id", "code");
CREATE INDEX "crm_task_type_seq_idx" ON "crm_task_type"("company_id", "seq");

ALTER TABLE "crm_task_type" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "crm_task_type" FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON "crm_task_type"
  USING (company_id = ANY (app.current_company_ids()))
  WITH CHECK (company_id = ANY (app.current_company_ids()));

-- Четыре типа из ТЗ 8.4 и «другое» переезжают как есть, каждой компании свои:
-- справочник у компаний раздельный, как вся остальная CRM.
INSERT INTO "crm_task_type" ("uid", "company_id", "code", "name_ru", "name_uz", "activity_kind", "seq")
SELECT gen_random_uuid(), c."id", t.code, t.name_ru, t.name_uz, t.kind::"CrmActivityType", t.seq
  FROM "company" c
  CROSS JOIN (VALUES
    ('call',     'Звонок',               'Qoʻngʻiroq',        'call',    10),
    ('meeting',  'Встреча',              'Uchrashuv',         'meeting', 20),
    ('letter',   'Письмо',               'Xat',               'letter',  30),
    ('document', 'Подготовить документ', 'Hujjat tayyorlash', 'note',    40),
    ('other',    'Другое',               'Boshqa',            'note',    50)
  ) AS t(code, name_ru, name_uz, kind, seq);

-- Уже заведённые задачи переезжают на справочник по своему же коду.
ALTER TABLE "crm_task" ADD COLUMN "type_id" BIGINT REFERENCES "crm_task_type"("id");
UPDATE "crm_task" t
   SET "type_id" = tt."id"
  FROM "crm_task_type" tt
 WHERE tt."company_id" = t."company_id" AND tt."code" = t."type"::text;
ALTER TABLE "crm_task" ALTER COLUMN "type_id" SET NOT NULL;
CREATE INDEX "crm_task_type_idx" ON "crm_task"("type_id");

ALTER TABLE "crm_task" DROP COLUMN "type";
DROP TYPE "CrmTaskType";
