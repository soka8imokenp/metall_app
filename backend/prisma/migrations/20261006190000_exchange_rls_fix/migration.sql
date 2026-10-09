-- Снятие RLS с двух таблиц обмена: с той, что читают до того, как компания
-- известна, и с очереди, которую проходит служба.
--
-- Почему это не ослабление разреза, а исправление ошибки. RLS отбирает строки
-- по `app.company_ids` — списку компаний того, кто пришёл. У входящего вебхука
-- этого списка нет и быть не может: чужая система не присылает заголовок
-- `X-Company-Id`, компанию определяет сам ключ подключения. Со включённым RLS
-- запрос «найди подключение по ключу» идёт с пустым списком и не находит
-- ничего — любой верный ключ получал 403. Тест `exchange-layer.e2e.spec.ts`
-- краснел ровно на этом.
--
-- Так же сделано у `site_key` (миграция 20261001110000_lead_marks): «RLS нет по
-- той же причине, что у `user_account`: ключ читают до того, как компания
-- известна, — он её и определяет». И так же у `notification_outbox`: очередь
-- проходит служба, у неё компании нет вовсе.
--
-- Правило разреза никуда не девается, оно переезжает в запрос и остаётся
-- буквально тем же: `company_id = ANY (app.current_company_ids())` — та самая
-- функция, которой пользовался RLS. В `ExchangeSystemsService.list()`,
-- `ExchangeJournalService.messages()` и `facets()` стоит именно она.
--
-- `webhook_subscription` и `external_ref` остаются под RLS: их читают внутри
-- транзакции того, кто пришёл, компания в контексте есть.

ALTER TABLE "external_system" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "external_system" NO FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS company_isolation ON "external_system";

ALTER TABLE "exchange_message" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "exchange_message" NO FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS company_isolation ON "exchange_message";
