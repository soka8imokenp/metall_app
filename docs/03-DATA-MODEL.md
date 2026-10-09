# Модель данных

PostgreSQL 18. Ниже — состав таблиц, ключевые поля, инварианты и индексы.
Типы указаны сокращённо; полная схема будет в миграциях Prisma на этапе бэкенда.

## Общие соглашения

- Первичный ключ — `id bigint generated always as identity`.
- Внешние идентификаторы для API — отдельное поле `uid uuid` (не светим
  последовательные id наружу).
- Все таблицы данных: `company_id bigint not null` + RLS.
- Аудит-поля: `created_at`, `created_by`, `updated_at`, `updated_by`.
- Мягкое удаление только у справочников: `archived_at`. Операционные документы
  не удаляются — отменяются.
- Количества — `numeric(20,6)`, деньги — `numeric(20,4)`, проценты — `numeric(9,4)`.
  `double precision` в учётных полях запрещён.
- Двуязычные наименования — `name_ru`, `name_uz` (не JSON: по ним идут поиск,
  сортировка и индексы).
- Временные метки — `timestamptz`, хранение в UTC, отображение в Asia/Tashkent.

---

## 1. Доступ и организация

### company
`id, uid, name_ru, name_uz, inn, legal_address, bank_details jsonb, base_currency_id, is_active`

Две записи: торговая компания и завод. Список может вырасти — поле, а не константа.

### department
`id, company_id, parent_id, name_ru, name_uz, is_active`

### user_account
`id, uid, login, email, phone, password_hash, full_name, locale, is_active,
 last_login_at, telegram_user_id, failed_login_count, locked_until`

`telegram_user_id` — уникален, заполняется при привязке по одноразовому коду;
рядом `telegram_linked_at` — когда подключили. Кто отключил — в журнале действий:
это событие, а не состояние.

### telegram_link_code
`id, user_id, code_hash, expires_at, used_at, revoked_at, created_by, created_at`

Одноразовый код привязки Telegram (ТЗ 11.2). Лежит **хешем** sha256: код виден
один раз, в ответе на выдачу. Хеш уникален. Живёт 15 минут; выдача нового гасит
прежние неиспользованные (`revoked_at`). Использованные и отозванные строки
остаются — по ним видно, кто выдавал и чем кончилось.

### role
`id, company_id (nullable — системная роль), code, name_ru, name_uz, is_system`

### permission
`id, code, module, description_ru, description_uz`

Код вида `warehouse.receipt.create`. Справочник заполняется миграцией,
администратор его не правит — он правит состав ролей.

### role_permission
`role_id, permission_id` — PK составной.

### user_role_assignment
`id, user_id, role_id, company_id, department_id (nullable), warehouse_id (nullable),
 scope enum('all','department','warehouse','own'), valid_from, valid_to`

Одна строка = «в этой компании у пользователя такая роль с такой областью».
Пользователь с ролями в обеих компаниях получает сводный доступ.

### audit_log
`id, company_id, user_id, occurred_at, source enum('web','mobile','bot','integration','system'),
 entity_type, entity_id, action, changes jsonb, ip, request_id`

Только `INSERT`. `UPDATE`/`DELETE` отозваны у прикладной роли БД.
Индексы: `(company_id, occurred_at desc)`, `(entity_type, entity_id)`.

Пишут сюда CRM, документы, админка, склад (движения, резервы, инвентаризация),
финансы (операции, согласование, бюджеты) и справочники — списком действий по
сущностям `docs/04-API-CONTRACT.md` §14.20. Запись идёт той же транзакцией, что
и само изменение, иначе журнал расходится с данными.

### login_log
`id, user_id, occurred_at, success bool, ip, user_agent, failure_reason`

---

## 2. Справочники

### currency
`id, code, symbol, precision, is_base_for_company_id`

### currency_rate
`id, currency_id, rate_date, rate numeric(20,8), source`
Уникально `(currency_id, rate_date)`.

### unit
`id, code, name_ru, name_uz, kind enum('weight','length','piece','volume')`

### item (номенклатура)
`id, company_id, uid, code, name_ru, name_uz, item_type enum('raw','goods','component','semi','finished'),
 group_id, base_unit_id, vat_rate, track_batches bool, track_serials bool,
 is_weighted bool, min_qty, critical_qty, barcode, is_active`

Индексы: `(company_id, code)` уникально, полнотекст по `name_ru`, `name_uz`,
btree по `barcode`.

### item_group
`id, company_id, parent_id, name_ru, name_uz`

### item_unit (дополнительные единицы)
`id, item_id, unit_id, factor numeric(20,8)`

Коэффициент к базовой единице. Для металлопроката вес метра зависит от
типоразмера, поэтому коэффициент хранится у позиции, а не глобально.

### item_attribute (характеристики металлопроката)
`id, item_id, pipe_type, steel_grade, diameter_mm, wall_thickness_mm, length_mm,
 weight_kg_per_unit, extra jsonb`

Отдельные поля, а не строка в названии: по ним фильтры, подбор и отчёты.

### partner (контрагент)
`id, company_id, uid, partner_type enum('company','person'), name_ru, name_uz, inn,
 bank_details jsonb, legal_address, actual_address, is_client bool, is_supplier bool,
 manager_id, source_id, price_type_id, payment_delay_days, debt_limit, is_active`

### partner_contact
`id, partner_id, full_name, position, phone, email, telegram, is_primary`

---

## 3. Склад

### warehouse
`id, company_id, code, name_ru, name_uz, address, is_active`

### warehouse_zone
`id, warehouse_id, code, name_ru, name_uz`

### storage_location (место хранения)
`id, zone_id, code, barcode, is_active`

### batch (партия)
`id, company_id, item_id, number, produced_at, received_at, supplier_id,
 production_order_id, unit_cost numeric(20,4), expires_at, certificate_file_id`

Уникально `(company_id, item_id, number)`.

### serial_number
`id, company_id, item_id, batch_id, number, current_state enum('in_stock','in_production','shipped','written_off')`

Уникально `(company_id, number)`.

### stock_move — журнал движений
```
id, company_id, uid, moved_at, operation_type, item_id, attribute_id,
batch_id, serial_id, from_warehouse_id, from_location_id,
to_warehouse_id, to_location_id, qty numeric(20,6), unit_id,
qty_base numeric(20,6), cost_total numeric(20,4),
source_doc_type, source_doc_id, partner_id, reason_id,
reversal_of_id, created_by, created_at, idempotency_key
```

`operation_type`: `receipt`, `transfer`, `issue_to_production`,
`return_from_production`, `shipment`, `return_from_client`, `write_off`,
`surplus`, `output` (выпуск).

**Инварианты:**
- `qty_base > 0` всегда; направление задают `from_*` / `to_*`;
- заполнен хотя бы один из `from_warehouse_id`, `to_warehouse_id`;
- строка никогда не обновляется и не удаляется; исправление — новая строка
  с `reversal_of_id`;
- `idempotency_key` уникален в пределах компании.

Индексы: `(company_id, item_id, moved_at)`, `(batch_id)`, `(serial_id)`,
`(source_doc_type, source_doc_id)`. Партиционирование по `moved_at` помесячно
при росте объёма.

### stock_balance — агрегат остатков
`company_id, warehouse_id, location_id, item_id, attribute_id, batch_id, serial_id,
 qty_on_hand, qty_reserved, updated_at`

PK — составной по всем измерениям. `qty_available` — генерируемое поле
`qty_on_hand - qty_reserved`. Обновляется в одной транзакции с `stock_move`
через `INSERT ... ON CONFLICT DO UPDATE`.

Ограничения: `qty_on_hand >= 0`, `qty_reserved >= 0`, `qty_reserved <= qty_on_hand`.
Последнее — именно то, что не даёт зарезервировать воздух.

### stock_reservation
`id, company_id, sales_order_line_id, item_id, batch_id, warehouse_id,
 qty, expires_at, status enum('active','released','consumed'), created_by, created_at`

### inventory_check (инвентаризация)
`id, company_id, warehouse_id, zone_id, number, status enum('draft','counting','review','approved','cancelled'),
 started_at, finished_at, blocking_mode enum('block','defer'), responsible_id`

### inventory_check_line
`id, check_id, item_id, batch_id, location_id, qty_expected, qty_counted, qty_diff,
 reason_id, counted_by, counted_at`

### stock_reason (справочник причин)
`id, company_id, kind enum('write_off','downtime','defect','inventory'), name_ru, name_uz`

---

## 4. Производство

### tech_card
`id, company_id, item_id, version int, name_ru, name_uz, status enum('draft','active','archived'),
 output_qty, output_unit_id, valid_from, created_by`

Уникально `(company_id, item_id, version)`. Активная версия одна.

### tech_card_stage
`id, tech_card_id, seq int, name_ru, name_uz, work_center_id, norm_duration_min,
 required_role_id, is_parallel bool, waste_percent`

### tech_card_material
`id, tech_card_id, stage_id (nullable), item_id, qty_per_unit, unit_id, is_auto_writeoff bool`

### work_center (участок)
`id, company_id, code, name_ru, name_uz, capacity_per_shift, is_active`

### production_order
```
id, company_id, uid, number, item_id, tech_card_id, tech_card_version,
qty_planned, qty_produced, qty_defect, qty_waste, unit_id,
due_date, status, priority, responsible_id,
sales_order_id (nullable), parent_order_id (nullable, переделка),
started_at, finished_at, closed_at, created_by, created_at
```

`status`: `draft`, `planned`, `in_progress`, `paused`, `produced`, `closed`, `cancelled`.

**Инварианты:**
- переход в `in_progress` фиксирует `tech_card_version` — последующие правки
  карты на заказ не влияют;
- отмена невозможна, если по заказу есть движения материалов;
- `closed` требует рассчитанной себестоимости.

### production_stage
`id, production_order_id, seq, name_ru, name_uz, work_center_id, responsible_id,
 planned_start, planned_end, status enum('pending','running','paused','done','skipped'),
 actual_duration_min, comment`

### production_stage_event
`id, stage_id, event enum('start','pause','resume','finish'), occurred_at, user_id,
 downtime_reason_id, comment`

Фактическое время этапа считается по событиям, а не хранится перезаписью.

### production_material
`id, production_order_id, stage_id, item_id, qty_planned, qty_issued, qty_used,
 qty_returned, unit_id, cost_total`

`qty_deviation` = `qty_used − qty_planned` (вычисляемое в отчётах).

### production_output
`id, production_order_id, stage_id, item_id, batch_id, qty, kind enum('good','defect','waste','semi'),
 defect_reason_id, occurred_at, user_id, photo_file_ids`

### production_order_cost (снимок себестоимости)
`id, production_order_id, calculated_at, material_cost, semi_cost, direct_cost,
 rework_cost, total_cost, qty_good, unit_cost, calculated_by, is_current bool`

Пересчёт создаёт новую строку, прежняя помечается `is_current = false`.
История расчётов не теряется.

### deviation_log (журнал отклонений)
`id, company_id, production_order_id, stage_id, kind enum('downtime','overuse','defect','delay'),
 reason_id, occurred_at, duration_min, amount, comment, registered_by`

---

## 5. Продажи

### price_type
`id, company_id, code, name_ru, name_uz, kind enum('retail','wholesale','contract','cash','cashless')`

### price_list
`id, company_id, price_type_id, item_id, price, currency_id, valid_from, valid_to`

### partner_price (индивидуальная цена)
`id, company_id, partner_id, item_id, price, currency_id, valid_from, valid_to`

Перекрывает прайс-лист.

### sales_order
```
id, company_id, uid, number, partner_id, deal_id (nullable), manager_id,
order_date, delivery_date, warehouse_id, price_type_id, currency_id, rate,
amount_net, amount_vat, amount_total, cost_total, margin_total,
status, payment_status, shipment_status,
payment_due_date, comment, created_by, created_at
```

`status`: `draft`, `confirmed`, `reserved`, `in_production`, `picking`,
`shipped`, `closed`, `cancelled`.
`payment_status`: `unpaid`, `partial`, `paid`.
`shipment_status`: `none`, `partial`, `full`.

Два статуса отдельными осями — потому что отгруженный неоплаченный заказ
это нормальная ситуация с отсрочкой, а не исключение.

### sales_order_line
`id, sales_order_id, seq, item_id, attribute_id, qty, unit_id, price, discount_percent,
 vat_rate, amount_net, amount_vat, amount_total, cost_total, warehouse_id,
 production_order_id (nullable), price_overridden_by, price_override_comment`

### shipment
`id, company_id, sales_order_id, number, shipped_at, warehouse_id, responsible_id,
 status, document_id`

### shipment_line
`id, shipment_id, sales_order_line_id, item_id, batch_id, serial_id, qty, cost_total`

---

## 6. Финансы

### account (счёт учёта)
`id, company_id, code, name_ru, name_uz, kind enum('cash','bank','receivable','payable','income','expense','vat','transit'),
 currency_id, is_active`

### cashflow_item (статья ДДС)
`id, company_id, parent_id, name_ru, name_uz, direction enum('in','out'),
 activity enum('operating','investing','financing')`

### finance_operation
```
id, company_id, uid, number, operation_type enum('income','expense','transfer','conversion'),
occurred_at, planned_date, account_id, counter_account_id,
amount, currency_id, rate, amount_base,
cashflow_item_id, partner_id,
source_doc_type, source_doc_id, project_id,
status enum('draft','pending_approval','approved','posted','rejected','reversed'),
reversal_of_id, comment, created_by, approved_by, posted_at, idempotency_key
```

### finance_entry (проводка)
`id, operation_id, company_id, account_id, debit numeric(20,4), credit numeric(20,4),
 currency_id, amount_base, occurred_at`

**Инвариант:** по каждой операции `SUM(debit) = SUM(credit)`. Проверяется
отложенным ограничением на уровне транзакции. Проводки не редактируются.

### budget
`id, company_id, department_id, cashflow_item_id, period_start, period_end,
 amount_planned, currency_id, threshold_warn_percent, responsible_id`

### kpi_scheme / kpi_result
`kpi_scheme: id, company_id, name_ru, name_uz, metric enum('sales_amount','margin','collected_payment','new_clients','no_overdue'),
 period_kind, target_value, scale jsonb, bonus_base, is_active`
`kpi_result: id, scheme_id, user_id, period_start, period_end, fact_value,
 achievement_percent, bonus_amount, calculated_at, approved_by`

ОТКРЫТО: правила от заказчика. Схема настраиваемая, поэтому правила ложатся
в данные, а не в код.

---

## 7. CRM

### lead
`id, company_id, uid, source_id, name, phone, email, comment, status enum('new','qualified','converted','rejected'),
 partner_id (после конвертации), manager_id, created_at, rejected_reason_id`

### lead_source
`id, company_id, code, name_ru, name_uz, channel enum('site','ads','call','manual','telegram','other')`

### deal (сделка)
`id, company_id, uid, number, partner_id, manager_id, stage_id, amount, currency_id,
 probability, expected_close_date, status enum('open','won','lost'), lost_reason_id,
 created_at, closed_at`

### deal_stage
`id, company_id, seq, name_ru, name_uz, probability_default, is_final`

### activity (звонок, встреча, письмо, заметка)
`id, company_id, kind enum('call','meeting','email','note','message'), partner_id, deal_id,
 user_id, occurred_at, duration_sec, direction enum('in','out'), phone_number,
 recording_file_id, external_id, subject, body`

### task
`id, company_id, kind, title, description, partner_id, deal_id, sales_order_id,
 assignee_id, due_at, remind_at, status enum('open','done','cancelled'), result, closed_at`

---

## 8. Документы

### document_type
`id, company_id, code, name_ru, name_uz, numbering_mask, counter_scope enum('company','company_period'),
 approval_route jsonb, is_active`

### document_template
`id, document_type_id, company_id, locale enum('ru','uz'), file_id, field_map jsonb,
 version, status enum('draft','published','archived'), published_at`

Русский и узбекский — разные шаблоны, не один файл на два языка.

### document
```
id, company_id, uid, document_type_id, number, document_date, partner_id,
source_doc_type, source_doc_id, currency_id, amount_total,
status enum('draft','pending_approval','approved','signed','returned','cancelled'),
current_version_id, created_by, created_at
```

### document_version
`id, document_id, version int, data jsonb, template_id, docx_file_id, pdf_file_id,
 created_by, created_at, comment`

`data` — снимок подставленных значений: документ должен воспроизводиться
даже после того, как заказ изменился.

### document_approval
`id, document_id, version_id, step int, approver_id, decision enum('pending','approved','returned'),
 decided_at, comment`

### document_counter
`id, company_id, document_type_id, period_key, last_number`

Выдача номера — `UPDATE ... RETURNING` под блокировкой строки: два
одновременных создания не получат один номер.

---

## 9. Файлы, уведомления, интеграции

### file_object
`id, company_id, uid, storage_key, original_name, mime_type, size_bytes,
 checksum_sha256, uploaded_by, uploaded_at, entity_type, entity_id`

### notification
`id, company_id, user_id, kind, title_ru, title_uz, body_ru, body_uz, payload jsonb,
 channel enum('in_app','telegram','push'), status enum('pending','sent','failed','read'),
 created_at, sent_at, read_at`

### outbox_event
`id, company_id, event_type, payload jsonb, occurred_at, status enum('new','processing','done','failed'),
 attempts, last_error, next_attempt_at`

### integration_endpoint
`id, company_id, system enum('1c','regos','bank','telephony','site','other'),
 direction enum('in','out'), url, secret_ref, is_active, settings jsonb`

`secret_ref` — ссылка на файл секрета, не само значение.

### integration_log
`id, company_id, endpoint_id, occurred_at, direction, external_id, request jsonb,
 response jsonb, status, error, retry_count`

### external_id_map
`id, company_id, system, entity_type, internal_id, external_id`

Без этой таблицы обмен с 1С разваливается на первом же несовпадении кодов.

### idempotency_key
`key, company_id, user_id, endpoint, request_hash, response_status, response_body,
 created_at, expires_at`

Повторный запрос с тем же ключом возвращает сохранённый ответ, а не создаёт
второй документ.

---

## 10. Ключевые инварианты (сводно)

1. `stock_move` — append-only; исправление только сторно.
2. `stock_balance.qty_reserved <= qty_on_hand`, обе величины `>= 0`.
3. По каждой `finance_operation`: `SUM(debit) = SUM(credit)`.
4. Проведённая финансовая операция и её проводки не изменяются.
5. `production_order` в статусе `closed` имеет актуальный снимок себестоимости.
6. Номер документа уникален в пределах компании, типа и периода.
7. Каждая изменяющая операция несёт `idempotency_key`, уникальный в компании.
8. `audit_log` — только `INSERT`.
9. Любая строка операционных таблиц принадлежит ровно одной компании и
   недоступна вне её через RLS.
