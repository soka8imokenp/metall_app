-- Прайс-лист в работе и контроль цены ниже себестоимости (ТЗ 9.2).
--
-- Таблицы `price_list` и `partner_price` стояли в базе с первого дня, но ни
-- один маршрут их не читал: цену в строке заказа набирали руками, и прайс был
-- мёртвым грузом. Чтобы строкой прайса можно было управлять из интерфейса, ей
-- нужен `uid` — внутренний `id` наружу не отдаём.
--
-- `below_cost_mode` — настройка компании из ТЗ 9.2: продажу дешевле
-- себестоимости либо запрещаем всем (`block`), либо пропускаем тому, кому выдано
-- право `sales.below_cost` (`approve`). Умолчание `block`: пока правило не
-- выбрано осознанно, система не должна тихо отдавать товар в убыток.
CREATE TYPE "BelowCostMode" AS ENUM ('block', 'approve');
CREATE TYPE "PriceSource" AS ENUM ('list', 'partner', 'manual');

ALTER TABLE company
  ADD COLUMN below_cost_mode "BelowCostMode" NOT NULL DEFAULT 'block';

ALTER TABLE price_list ADD COLUMN uid uuid;
UPDATE price_list SET uid = gen_random_uuid() WHERE uid IS NULL;
ALTER TABLE price_list ALTER COLUMN uid SET NOT NULL;
CREATE UNIQUE INDEX "price_list_uid_key" ON price_list (uid);

ALTER TABLE partner_price ADD COLUMN uid uuid;
UPDATE partner_price SET uid = gen_random_uuid() WHERE uid IS NULL;
ALTER TABLE partner_price ALTER COLUMN uid SET NOT NULL;
CREATE UNIQUE INDEX "partner_price_uid_key" ON partner_price (uid);

-- Строка заказа помнит, откуда взялась цена, что показывал прайс и с какой
-- себестоимостью сравнивали. Без этого отчёт по марже не отличает осознанную
-- скидку от опечатки, а спор «почему продали дешевле» разбирать нечем.
ALTER TABLE sales_order_line
  ADD COLUMN price_source "PriceSource" NOT NULL DEFAULT 'manual',
  ADD COLUMN list_price numeric(20, 4),
  ADD COLUMN cost_ref numeric(20, 4),
  ADD COLUMN price_comment text;
