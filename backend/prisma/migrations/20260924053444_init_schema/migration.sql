-- CreateEnum
CREATE TYPE "Locale" AS ENUM ('ru', 'uz');

-- CreateEnum
CREATE TYPE "RoleScope" AS ENUM ('all', 'department', 'warehouse', 'own');

-- CreateEnum
CREATE TYPE "AuditSource" AS ENUM ('web', 'mobile', 'bot', 'integration', 'system');

-- CreateEnum
CREATE TYPE "UnitKind" AS ENUM ('weight', 'length', 'piece', 'volume');

-- CreateEnum
CREATE TYPE "ItemType" AS ENUM ('raw', 'goods', 'component', 'semi', 'finished');

-- CreateEnum
CREATE TYPE "PartnerType" AS ENUM ('company', 'person');

-- CreateEnum
CREATE TYPE "SerialState" AS ENUM ('in_stock', 'in_production', 'shipped', 'written_off');

-- CreateEnum
CREATE TYPE "ReasonKind" AS ENUM ('write_off', 'downtime', 'defect', 'inventory');

-- CreateEnum
CREATE TYPE "OperationType" AS ENUM ('receipt', 'transfer', 'issue_to_production', 'return_from_production', 'shipment', 'return_from_client', 'write_off', 'surplus', 'output');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('active', 'released', 'consumed');

-- CreateEnum
CREATE TYPE "TechCardStatus" AS ENUM ('draft', 'active', 'archived');

-- CreateEnum
CREATE TYPE "ProductionStatus" AS ENUM ('draft', 'planned', 'in_progress', 'paused', 'produced', 'closed', 'cancelled');

-- CreateEnum
CREATE TYPE "StageStatus" AS ENUM ('pending', 'running', 'paused', 'done', 'skipped');

-- CreateEnum
CREATE TYPE "StageEvent" AS ENUM ('start', 'pause', 'resume', 'finish');

-- CreateEnum
CREATE TYPE "OutputKind" AS ENUM ('good', 'defect', 'waste', 'semi');

-- CreateEnum
CREATE TYPE "DeviationKind" AS ENUM ('downtime', 'overuse', 'defect', 'delay');

-- CreateEnum
CREATE TYPE "PriceTypeKind" AS ENUM ('retail', 'wholesale', 'contract', 'cash', 'cashless');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('draft', 'confirmed', 'reserved', 'in_production', 'picking', 'shipped', 'closed', 'cancelled');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('unpaid', 'partial', 'paid');

-- CreateEnum
CREATE TYPE "ShipmentStatus" AS ENUM ('none', 'partial', 'full');

-- CreateEnum
CREATE TYPE "AccountKind" AS ENUM ('cash', 'bank', 'receivable', 'payable', 'income', 'expense', 'vat', 'transit');

-- CreateEnum
CREATE TYPE "CashflowDirection" AS ENUM ('inflow', 'outflow');

-- CreateEnum
CREATE TYPE "CashflowActivity" AS ENUM ('operating', 'investing', 'financing');

-- CreateEnum
CREATE TYPE "FinanceOpType" AS ENUM ('income', 'expense', 'transfer', 'conversion');

-- CreateEnum
CREATE TYPE "FinanceStatus" AS ENUM ('draft', 'pending_approval', 'approved', 'posted', 'rejected', 'reversed');

-- CreateEnum
CREATE TYPE "LeadChannel" AS ENUM ('site', 'ads', 'call', 'manual', 'telegram', 'other');

-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('new', 'qualified', 'converted', 'rejected');

-- CreateEnum
CREATE TYPE "DealStatus" AS ENUM ('open', 'won', 'lost');

-- CreateEnum
CREATE TYPE "CounterScope" AS ENUM ('company', 'company_period');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('draft', 'pending_approval', 'approved', 'signed', 'returned', 'cancelled');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('new', 'processing', 'done', 'failed');

-- CreateTable
CREATE TABLE "company" (
    "id" BIGSERIAL NOT NULL,
    "uid" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name_ru" TEXT NOT NULL,
    "name_uz" TEXT NOT NULL,
    "inn" TEXT NOT NULL,
    "legal_address" TEXT,
    "bank_details" JSONB,
    "base_currency" TEXT NOT NULL DEFAULT 'UZS',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "department" (
    "id" BIGSERIAL NOT NULL,
    "company_id" BIGINT NOT NULL,
    "parent_id" BIGINT,
    "name_ru" TEXT NOT NULL,
    "name_uz" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "department_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_account" (
    "id" BIGSERIAL NOT NULL,
    "uid" UUID NOT NULL,
    "login" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "password_hash" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "locale" "Locale" NOT NULL DEFAULT 'ru',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMPTZ(6),
    "telegram_user_id" BIGINT,
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role" (
    "id" BIGSERIAL NOT NULL,
    "company_id" BIGINT,
    "code" TEXT NOT NULL,
    "name_ru" TEXT NOT NULL,
    "name_uz" TEXT NOT NULL,
    "is_system" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permission" (
    "id" BIGSERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "description_ru" TEXT NOT NULL,
    "description_uz" TEXT NOT NULL,

    CONSTRAINT "permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permission" (
    "role_id" BIGINT NOT NULL,
    "permission_id" BIGINT NOT NULL,

    CONSTRAINT "role_permission_pkey" PRIMARY KEY ("role_id","permission_id")
);

-- CreateTable
CREATE TABLE "user_role_assignment" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "role_id" BIGINT NOT NULL,
    "company_id" BIGINT NOT NULL,
    "department_id" BIGINT,
    "warehouse_id" BIGINT,
    "scope" "RoleScope" NOT NULL DEFAULT 'all',
    "valid_from" TIMESTAMPTZ(6),
    "valid_to" TIMESTAMPTZ(6),

    CONSTRAINT "user_role_assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" BIGSERIAL NOT NULL,
    "company_id" BIGINT NOT NULL,
    "user_id" BIGINT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" "AuditSource" NOT NULL DEFAULT 'web',
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "changes" JSONB,
    "ip" TEXT,
    "request_id" TEXT,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "login_log" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "success" BOOLEAN NOT NULL,
    "ip" TEXT,
    "user_agent" TEXT,
    "failure_reason" TEXT,

    CONSTRAINT "login_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "currency" (
    "id" BIGSERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "precision" INTEGER NOT NULL DEFAULT 2,

    CONSTRAINT "currency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "currency_rate" (
    "id" BIGSERIAL NOT NULL,
    "currency_id" BIGINT NOT NULL,
    "rate_date" DATE NOT NULL,
    "rate" DECIMAL(20,8) NOT NULL,
    "source" TEXT,

    CONSTRAINT "currency_rate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unit" (
    "id" BIGSERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "name_ru" TEXT NOT NULL,
    "name_uz" TEXT NOT NULL,
    "kind" "UnitKind" NOT NULL,

    CONSTRAINT "unit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_group" (
    "id" BIGSERIAL NOT NULL,
    "company_id" BIGINT NOT NULL,
    "parent_id" BIGINT,
    "name_ru" TEXT NOT NULL,
    "name_uz" TEXT NOT NULL,

    CONSTRAINT "item_group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item" (
    "id" BIGSERIAL NOT NULL,
    "uid" UUID NOT NULL,
    "company_id" BIGINT NOT NULL,
    "code" TEXT NOT NULL,
    "name_ru" TEXT NOT NULL,
    "name_uz" TEXT NOT NULL,
    "item_type" "ItemType" NOT NULL,
    "group_id" BIGINT,
    "base_unit_id" BIGINT NOT NULL,
    "vat_rate" DECIMAL(9,4) NOT NULL DEFAULT 12,
    "track_batches" BOOLEAN NOT NULL DEFAULT false,
    "track_serials" BOOLEAN NOT NULL DEFAULT false,
    "is_weighted" BOOLEAN NOT NULL DEFAULT false,
    "min_qty" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "critical_qty" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "barcode" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "archived_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_attribute" (
    "id" BIGSERIAL NOT NULL,
    "item_id" BIGINT NOT NULL,
    "pipe_type" TEXT,
    "steel_grade" TEXT,
    "diameter_mm" DECIMAL(20,6),
    "wall_thickness_mm" DECIMAL(20,6),
    "length_mm" DECIMAL(20,6),
    "weight_kg_per_unit" DECIMAL(20,6),
    "insulation_type" TEXT,
    "gost" TEXT,
    "extra" JSONB,

    CONSTRAINT "item_attribute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_unit" (
    "id" BIGSERIAL NOT NULL,
    "item_id" BIGINT NOT NULL,
    "unit_id" BIGINT NOT NULL,
    "factor" DECIMAL(20,8) NOT NULL,

    CONSTRAINT "item_unit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner" (
    "id" BIGSERIAL NOT NULL,
    "uid" UUID NOT NULL,
    "company_id" BIGINT NOT NULL,
    "partner_type" "PartnerType" NOT NULL DEFAULT 'company',
    "name_ru" TEXT NOT NULL,
    "name_uz" TEXT NOT NULL,
    "inn" TEXT,
    "bank_details" JSONB,
    "legal_address" TEXT,
    "actual_address" TEXT,
    "is_client" BOOLEAN NOT NULL DEFAULT true,
    "is_supplier" BOOLEAN NOT NULL DEFAULT false,
    "manager_id" BIGINT,
    "source_id" BIGINT,
    "price_type_id" BIGINT,
    "payment_delay_days" INTEGER NOT NULL DEFAULT 0,
    "debt_limit" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "archived_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_contact" (
    "id" BIGSERIAL NOT NULL,
    "partner_id" BIGINT NOT NULL,
    "full_name" TEXT NOT NULL,
    "position" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "telegram" TEXT,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "partner_contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse" (
    "id" BIGSERIAL NOT NULL,
    "uid" UUID NOT NULL,
    "company_id" BIGINT NOT NULL,
    "code" TEXT NOT NULL,
    "name_ru" TEXT NOT NULL,
    "name_uz" TEXT NOT NULL,
    "address" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "warehouse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_zone" (
    "id" BIGSERIAL NOT NULL,
    "warehouse_id" BIGINT NOT NULL,
    "code" TEXT NOT NULL,
    "name_ru" TEXT NOT NULL,
    "name_uz" TEXT NOT NULL,

    CONSTRAINT "warehouse_zone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "storage_location" (
    "id" BIGSERIAL NOT NULL,
    "zone_id" BIGINT NOT NULL,
    "code" TEXT NOT NULL,
    "barcode" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "storage_location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "batch" (
    "id" BIGSERIAL NOT NULL,
    "uid" UUID NOT NULL,
    "company_id" BIGINT NOT NULL,
    "item_id" BIGINT NOT NULL,
    "number" TEXT NOT NULL,
    "produced_at" TIMESTAMPTZ(6),
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supplier_id" BIGINT,
    "production_order_id" BIGINT,
    "unit_cost" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(6),
    "certificate_number" TEXT,

    CONSTRAINT "batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "serial_number" (
    "id" BIGSERIAL NOT NULL,
    "company_id" BIGINT NOT NULL,
    "item_id" BIGINT NOT NULL,
    "batch_id" BIGINT,
    "number" TEXT NOT NULL,
    "current_state" "SerialState" NOT NULL DEFAULT 'in_stock',

    CONSTRAINT "serial_number_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_reason" (
    "id" BIGSERIAL NOT NULL,
    "company_id" BIGINT NOT NULL,
    "kind" "ReasonKind" NOT NULL,
    "name_ru" TEXT NOT NULL,
    "name_uz" TEXT NOT NULL,

    CONSTRAINT "stock_reason_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_move" (
    "id" BIGSERIAL NOT NULL,
    "uid" UUID NOT NULL,
    "company_id" BIGINT NOT NULL,
    "moved_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "operation_type" "OperationType" NOT NULL,
    "item_id" BIGINT NOT NULL,
    "batch_id" BIGINT,
    "serial_id" BIGINT,
    "from_warehouse_id" BIGINT,
    "from_location_id" BIGINT,
    "to_warehouse_id" BIGINT,
    "to_location_id" BIGINT,
    "qty" DECIMAL(20,6) NOT NULL,
    "unit_id" BIGINT NOT NULL,
    "qty_base" DECIMAL(20,6) NOT NULL,
    "cost_total" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "source_doc_type" TEXT,
    "source_doc_id" BIGINT,
    "partner_id" BIGINT,
    "reason_id" BIGINT,
    "reversal_of_id" BIGINT,
    "comment" TEXT,
    "created_by" BIGINT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotency_key" TEXT,

    CONSTRAINT "stock_move_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_balance" (
    "id" BIGSERIAL NOT NULL,
    "company_id" BIGINT NOT NULL,
    "warehouse_id" BIGINT NOT NULL,
    "location_id" BIGINT,
    "item_id" BIGINT NOT NULL,
    "batch_id" BIGINT,
    "serial_id" BIGINT,
    "qty_on_hand" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "qty_reserved" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "qty_available" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "unit_cost" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_balance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_reservation" (
    "id" BIGSERIAL NOT NULL,
    "company_id" BIGINT NOT NULL,
    "sales_order_line_id" BIGINT,
    "item_id" BIGINT NOT NULL,
    "batch_id" BIGINT,
    "warehouse_id" BIGINT NOT NULL,
    "qty" DECIMAL(20,6) NOT NULL,
    "expires_at" TIMESTAMPTZ(6),
    "status" "ReservationStatus" NOT NULL DEFAULT 'active',
    "created_by" BIGINT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_reservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_center" (
    "id" BIGSERIAL NOT NULL,
    "company_id" BIGINT NOT NULL,
    "code" TEXT NOT NULL,
    "name_ru" TEXT NOT NULL,
    "name_uz" TEXT NOT NULL,
    "capacity_per_shift" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "work_center_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tech_card" (
    "id" BIGSERIAL NOT NULL,
    "uid" UUID NOT NULL,
    "company_id" BIGINT NOT NULL,
    "item_id" BIGINT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "name_ru" TEXT NOT NULL,
    "name_uz" TEXT NOT NULL,
    "status" "TechCardStatus" NOT NULL DEFAULT 'draft',
    "output_qty" DECIMAL(20,6) NOT NULL DEFAULT 1,
    "output_unit_id" BIGINT NOT NULL,
    "valid_from" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tech_card_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tech_card_stage" (
    "id" BIGSERIAL NOT NULL,
    "tech_card_id" BIGINT NOT NULL,
    "seq" INTEGER NOT NULL,
    "name_ru" TEXT NOT NULL,
    "name_uz" TEXT NOT NULL,
    "work_center_id" BIGINT,
    "norm_duration_min" INTEGER NOT NULL DEFAULT 0,
    "is_parallel" BOOLEAN NOT NULL DEFAULT false,
    "waste_percent" DECIMAL(9,4) NOT NULL DEFAULT 0,

    CONSTRAINT "tech_card_stage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tech_card_material" (
    "id" BIGSERIAL NOT NULL,
    "tech_card_id" BIGINT NOT NULL,
    "stage_id" BIGINT,
    "item_id" BIGINT NOT NULL,
    "qty_per_unit" DECIMAL(20,6) NOT NULL,
    "unit_id" BIGINT NOT NULL,
    "is_auto_writeoff" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "tech_card_material_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_order" (
    "id" BIGSERIAL NOT NULL,
    "uid" UUID NOT NULL,
    "company_id" BIGINT NOT NULL,
    "number" TEXT NOT NULL,
    "item_id" BIGINT NOT NULL,
    "tech_card_id" BIGINT,
    "tech_card_version" INTEGER,
    "qty_planned" DECIMAL(20,6) NOT NULL,
    "qty_produced" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "qty_defect" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "qty_waste" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "unit_id" BIGINT NOT NULL,
    "due_date" DATE NOT NULL,
    "status" "ProductionStatus" NOT NULL DEFAULT 'draft',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "responsible_id" BIGINT,
    "sales_order_id" BIGINT,
    "parent_order_id" BIGINT,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "closed_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" BIGINT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "production_order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_stage" (
    "id" BIGSERIAL NOT NULL,
    "production_order_id" BIGINT NOT NULL,
    "seq" INTEGER NOT NULL,
    "name_ru" TEXT NOT NULL,
    "name_uz" TEXT NOT NULL,
    "work_center_id" BIGINT,
    "responsible_id" BIGINT,
    "planned_start" TIMESTAMPTZ(6),
    "planned_end" TIMESTAMPTZ(6),
    "planned_duration_min" INTEGER NOT NULL DEFAULT 0,
    "actual_duration_min" INTEGER NOT NULL DEFAULT 0,
    "status" "StageStatus" NOT NULL DEFAULT 'pending',
    "comment" TEXT,

    CONSTRAINT "production_stage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_stage_event" (
    "id" BIGSERIAL NOT NULL,
    "stage_id" BIGINT NOT NULL,
    "event" "StageEvent" NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id" BIGINT,
    "reason_id" BIGINT,
    "comment" TEXT,

    CONSTRAINT "production_stage_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_material" (
    "id" BIGSERIAL NOT NULL,
    "production_order_id" BIGINT NOT NULL,
    "stage_id" BIGINT,
    "item_id" BIGINT NOT NULL,
    "qty_planned" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "qty_issued" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "qty_used" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "qty_returned" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "unit_id" BIGINT NOT NULL,
    "cost_total" DECIMAL(20,4) NOT NULL DEFAULT 0,

    CONSTRAINT "production_material_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_output" (
    "id" BIGSERIAL NOT NULL,
    "production_order_id" BIGINT NOT NULL,
    "stage_id" BIGINT,
    "item_id" BIGINT NOT NULL,
    "batch_id" BIGINT,
    "qty" DECIMAL(20,6) NOT NULL,
    "kind" "OutputKind" NOT NULL,
    "reason_id" BIGINT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id" BIGINT,

    CONSTRAINT "production_output_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_order_cost" (
    "id" BIGSERIAL NOT NULL,
    "production_order_id" BIGINT NOT NULL,
    "calculated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "material_cost" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "semi_cost" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "direct_cost" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "rework_cost" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "total_cost" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "qty_good" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "unit_cost" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "calculated_by" BIGINT,
    "is_current" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "production_order_cost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deviation_log" (
    "id" BIGSERIAL NOT NULL,
    "company_id" BIGINT NOT NULL,
    "production_order_id" BIGINT,
    "stage_id" BIGINT,
    "kind" "DeviationKind" NOT NULL,
    "reason_id" BIGINT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "duration_min" INTEGER NOT NULL DEFAULT 0,
    "amount" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "comment" TEXT,
    "registered_by" BIGINT,

    CONSTRAINT "deviation_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_type" (
    "id" BIGSERIAL NOT NULL,
    "company_id" BIGINT NOT NULL,
    "code" TEXT NOT NULL,
    "name_ru" TEXT NOT NULL,
    "name_uz" TEXT NOT NULL,
    "kind" "PriceTypeKind" NOT NULL,

    CONSTRAINT "price_type_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_list" (
    "id" BIGSERIAL NOT NULL,
    "company_id" BIGINT NOT NULL,
    "price_type_id" BIGINT NOT NULL,
    "item_id" BIGINT NOT NULL,
    "price" DECIMAL(20,4) NOT NULL,
    "currency_id" BIGINT NOT NULL,
    "valid_from" DATE NOT NULL,
    "valid_to" DATE,

    CONSTRAINT "price_list_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_price" (
    "id" BIGSERIAL NOT NULL,
    "company_id" BIGINT NOT NULL,
    "partner_id" BIGINT NOT NULL,
    "item_id" BIGINT NOT NULL,
    "price" DECIMAL(20,4) NOT NULL,
    "currency_id" BIGINT NOT NULL,
    "valid_from" DATE NOT NULL,
    "valid_to" DATE,

    CONSTRAINT "partner_price_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_order" (
    "id" BIGSERIAL NOT NULL,
    "uid" UUID NOT NULL,
    "company_id" BIGINT NOT NULL,
    "number" TEXT NOT NULL,
    "partner_id" BIGINT NOT NULL,
    "deal_id" BIGINT,
    "manager_id" BIGINT,
    "order_date" DATE NOT NULL,
    "delivery_date" DATE,
    "payment_due_date" DATE,
    "warehouse_id" BIGINT,
    "price_type_id" BIGINT,
    "currency_id" BIGINT NOT NULL,
    "rate" DECIMAL(20,8) NOT NULL DEFAULT 1,
    "amount_net" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "amount_vat" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "amount_total" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "cost_total" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "margin_total" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "paid_amount" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "status" "OrderStatus" NOT NULL DEFAULT 'draft',
    "payment_status" "PaymentStatus" NOT NULL DEFAULT 'unpaid',
    "shipment_status" "ShipmentStatus" NOT NULL DEFAULT 'none',
    "comment" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" BIGINT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_order_line" (
    "id" BIGSERIAL NOT NULL,
    "uid" UUID NOT NULL,
    "sales_order_id" BIGINT NOT NULL,
    "seq" INTEGER NOT NULL,
    "item_id" BIGINT NOT NULL,
    "qty" DECIMAL(20,6) NOT NULL,
    "unit_id" BIGINT NOT NULL,
    "price" DECIMAL(20,4) NOT NULL,
    "discount_percent" DECIMAL(9,4) NOT NULL DEFAULT 0,
    "vat_rate" DECIMAL(9,4) NOT NULL DEFAULT 12,
    "amount_net" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "amount_vat" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "amount_total" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "cost_total" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "warehouse_id" BIGINT,

    CONSTRAINT "sales_order_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment" (
    "id" BIGSERIAL NOT NULL,
    "uid" UUID NOT NULL,
    "company_id" BIGINT NOT NULL,
    "sales_order_id" BIGINT NOT NULL,
    "number" TEXT NOT NULL,
    "shipped_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "warehouse_id" BIGINT,
    "responsible_id" BIGINT,
    "vehicle" TEXT,
    "driver" TEXT,
    "net_weight_t" DECIMAL(20,6),
    "gross_weight_t" DECIMAL(20,6),

    CONSTRAINT "shipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment_line" (
    "id" BIGSERIAL NOT NULL,
    "shipment_id" BIGINT NOT NULL,
    "sales_order_line_id" BIGINT,
    "item_id" BIGINT NOT NULL,
    "batch_id" BIGINT,
    "serial_id" BIGINT,
    "qty" DECIMAL(20,6) NOT NULL,
    "cost_total" DECIMAL(20,4) NOT NULL DEFAULT 0,

    CONSTRAINT "shipment_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account" (
    "id" BIGSERIAL NOT NULL,
    "company_id" BIGINT NOT NULL,
    "code" TEXT NOT NULL,
    "name_ru" TEXT NOT NULL,
    "name_uz" TEXT NOT NULL,
    "kind" "AccountKind" NOT NULL,
    "currency_id" BIGINT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cashflow_item" (
    "id" BIGSERIAL NOT NULL,
    "company_id" BIGINT NOT NULL,
    "parent_id" BIGINT,
    "name_ru" TEXT NOT NULL,
    "name_uz" TEXT NOT NULL,
    "direction" "CashflowDirection" NOT NULL,
    "activity" "CashflowActivity" NOT NULL DEFAULT 'operating',

    CONSTRAINT "cashflow_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finance_operation" (
    "id" BIGSERIAL NOT NULL,
    "uid" UUID NOT NULL,
    "company_id" BIGINT NOT NULL,
    "number" TEXT NOT NULL,
    "operation_type" "FinanceOpType" NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "planned_date" DATE,
    "account_id" BIGINT NOT NULL,
    "counter_account_id" BIGINT,
    "amount" DECIMAL(20,4) NOT NULL,
    "currency_id" BIGINT NOT NULL,
    "rate" DECIMAL(20,8) NOT NULL DEFAULT 1,
    "amount_base" DECIMAL(20,4) NOT NULL,
    "cashflow_item_id" BIGINT,
    "partner_id" BIGINT,
    "source_doc_type" TEXT,
    "source_doc_id" BIGINT,
    "status" "FinanceStatus" NOT NULL DEFAULT 'draft',
    "reversal_of_id" BIGINT,
    "comment" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" BIGINT,
    "approved_by" BIGINT,
    "posted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotency_key" TEXT,

    CONSTRAINT "finance_operation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finance_entry" (
    "id" BIGSERIAL NOT NULL,
    "operation_id" BIGINT NOT NULL,
    "company_id" BIGINT NOT NULL,
    "account_id" BIGINT NOT NULL,
    "debit" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "credit" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "amount_base" DECIMAL(20,4) NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finance_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget" (
    "id" BIGSERIAL NOT NULL,
    "company_id" BIGINT NOT NULL,
    "department_id" BIGINT,
    "cashflow_item_id" BIGINT NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "amount_planned" DECIMAL(20,4) NOT NULL,
    "threshold_warn_percent" DECIMAL(9,4) NOT NULL DEFAULT 80,
    "responsible_id" BIGINT,

    CONSTRAINT "budget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_source" (
    "id" BIGSERIAL NOT NULL,
    "company_id" BIGINT NOT NULL,
    "code" TEXT NOT NULL,
    "name_ru" TEXT NOT NULL,
    "name_uz" TEXT NOT NULL,
    "channel" "LeadChannel" NOT NULL,

    CONSTRAINT "lead_source_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead" (
    "id" BIGSERIAL NOT NULL,
    "uid" UUID NOT NULL,
    "company_id" BIGINT NOT NULL,
    "source_id" BIGINT,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "comment" TEXT,
    "status" "LeadStatus" NOT NULL DEFAULT 'new',
    "partner_id" BIGINT,
    "manager_id" BIGINT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deal_stage" (
    "id" BIGSERIAL NOT NULL,
    "company_id" BIGINT NOT NULL,
    "seq" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "name_ru" TEXT NOT NULL,
    "name_uz" TEXT NOT NULL,
    "probability_default" INTEGER NOT NULL DEFAULT 0,
    "is_final" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "deal_stage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deal" (
    "id" BIGSERIAL NOT NULL,
    "uid" UUID NOT NULL,
    "company_id" BIGINT NOT NULL,
    "number" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "partner_id" BIGINT,
    "manager_id" BIGINT,
    "stage_id" BIGINT NOT NULL,
    "amount" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "currency_id" BIGINT NOT NULL,
    "probability" INTEGER NOT NULL DEFAULT 0,
    "expected_close_date" DATE,
    "status" "DealStatus" NOT NULL DEFAULT 'open',
    "lost_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ(6),

    CONSTRAINT "deal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_type" (
    "id" BIGSERIAL NOT NULL,
    "company_id" BIGINT NOT NULL,
    "code" TEXT NOT NULL,
    "name_ru" TEXT NOT NULL,
    "name_uz" TEXT NOT NULL,
    "numbering_mask" TEXT NOT NULL DEFAULT '{TYPE}-{YY}/{SEQ}',
    "counter_scope" "CounterScope" NOT NULL DEFAULT 'company_period',
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "document_type_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document" (
    "id" BIGSERIAL NOT NULL,
    "uid" UUID NOT NULL,
    "company_id" BIGINT NOT NULL,
    "document_type_id" BIGINT NOT NULL,
    "number" TEXT NOT NULL,
    "document_date" DATE NOT NULL,
    "partner_id" BIGINT,
    "source_doc_type" TEXT,
    "source_doc_id" BIGINT,
    "currency_id" BIGINT,
    "amount_total" DECIMAL(20,4),
    "locale" "Locale" NOT NULL DEFAULT 'ru',
    "status" "DocumentStatus" NOT NULL DEFAULT 'draft',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" BIGINT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_counter" (
    "id" BIGSERIAL NOT NULL,
    "company_id" BIGINT NOT NULL,
    "document_type_id" BIGINT NOT NULL,
    "period_key" TEXT NOT NULL,
    "last_number" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "document_counter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_event" (
    "id" BIGSERIAL NOT NULL,
    "company_id" BIGINT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "OutboxStatus" NOT NULL DEFAULT 'new',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "next_attempt_at" TIMESTAMPTZ(6),

    CONSTRAINT "outbox_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_key" (
    "key" TEXT NOT NULL,
    "company_id" BIGINT NOT NULL,
    "user_id" BIGINT,
    "endpoint" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response_status" INTEGER NOT NULL,
    "response_body" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "idempotency_key_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "company_uid_key" ON "company"("uid");

-- CreateIndex
CREATE UNIQUE INDEX "company_code_key" ON "company"("code");

-- CreateIndex
CREATE INDEX "department_company_id_idx" ON "department"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_account_uid_key" ON "user_account"("uid");

-- CreateIndex
CREATE UNIQUE INDEX "user_account_login_key" ON "user_account"("login");

-- CreateIndex
CREATE UNIQUE INDEX "user_account_telegram_user_id_key" ON "user_account"("telegram_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "role_company_id_code_key" ON "role"("company_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "permission_code_key" ON "permission"("code");

-- CreateIndex
CREATE INDEX "user_role_assignment_company_id_idx" ON "user_role_assignment"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_role_assignment_user_id_role_id_company_id_key" ON "user_role_assignment"("user_id", "role_id", "company_id");

-- CreateIndex
CREATE INDEX "audit_log_company_id_occurred_at_idx" ON "audit_log"("company_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_log_entity_type_entity_id_idx" ON "audit_log"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "login_log_user_id_occurred_at_idx" ON "login_log"("user_id", "occurred_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "currency_code_key" ON "currency"("code");

-- CreateIndex
CREATE UNIQUE INDEX "currency_rate_currency_id_rate_date_key" ON "currency_rate"("currency_id", "rate_date");

-- CreateIndex
CREATE UNIQUE INDEX "unit_code_key" ON "unit"("code");

-- CreateIndex
CREATE INDEX "item_group_company_id_idx" ON "item_group"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "item_uid_key" ON "item"("uid");

-- CreateIndex
CREATE INDEX "item_company_id_barcode_idx" ON "item"("company_id", "barcode");

-- CreateIndex
CREATE INDEX "item_company_id_name_ru_idx" ON "item"("company_id", "name_ru");

-- CreateIndex
CREATE UNIQUE INDEX "item_company_id_code_key" ON "item"("company_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "item_attribute_item_id_key" ON "item_attribute"("item_id");

-- CreateIndex
CREATE INDEX "item_attribute_steel_grade_idx" ON "item_attribute"("steel_grade");

-- CreateIndex
CREATE INDEX "item_attribute_diameter_mm_idx" ON "item_attribute"("diameter_mm");

-- CreateIndex
CREATE UNIQUE INDEX "item_unit_item_id_unit_id_key" ON "item_unit"("item_id", "unit_id");

-- CreateIndex
CREATE UNIQUE INDEX "partner_uid_key" ON "partner"("uid");

-- CreateIndex
CREATE INDEX "partner_company_id_name_ru_idx" ON "partner"("company_id", "name_ru");

-- CreateIndex
CREATE UNIQUE INDEX "partner_company_id_inn_key" ON "partner"("company_id", "inn");

-- CreateIndex
CREATE INDEX "partner_contact_partner_id_idx" ON "partner_contact"("partner_id");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_uid_key" ON "warehouse"("uid");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_company_id_code_key" ON "warehouse"("company_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_zone_warehouse_id_code_key" ON "warehouse_zone"("warehouse_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "storage_location_zone_id_code_key" ON "storage_location"("zone_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "batch_uid_key" ON "batch"("uid");

-- CreateIndex
CREATE INDEX "batch_company_id_received_at_idx" ON "batch"("company_id", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "batch_company_id_item_id_number_key" ON "batch"("company_id", "item_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "serial_number_company_id_number_key" ON "serial_number"("company_id", "number");

-- CreateIndex
CREATE INDEX "stock_reason_company_id_kind_idx" ON "stock_reason"("company_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "stock_move_uid_key" ON "stock_move"("uid");

-- CreateIndex
CREATE INDEX "stock_move_company_id_item_id_moved_at_idx" ON "stock_move"("company_id", "item_id", "moved_at");

-- CreateIndex
CREATE INDEX "stock_move_company_id_moved_at_idx" ON "stock_move"("company_id", "moved_at" DESC);

-- CreateIndex
CREATE INDEX "stock_move_batch_id_idx" ON "stock_move"("batch_id");

-- CreateIndex
CREATE INDEX "stock_move_serial_id_idx" ON "stock_move"("serial_id");

-- CreateIndex
CREATE INDEX "stock_move_source_doc_type_source_doc_id_idx" ON "stock_move"("source_doc_type", "source_doc_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_move_company_id_idempotency_key_key" ON "stock_move"("company_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "stock_balance_company_id_item_id_idx" ON "stock_balance"("company_id", "item_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_balance_company_id_warehouse_id_location_id_item_id_b_key" ON "stock_balance"("company_id", "warehouse_id", "location_id", "item_id", "batch_id", "serial_id");

-- CreateIndex
CREATE INDEX "stock_reservation_company_id_status_idx" ON "stock_reservation"("company_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "work_center_company_id_code_key" ON "work_center"("company_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "tech_card_uid_key" ON "tech_card"("uid");

-- CreateIndex
CREATE UNIQUE INDEX "tech_card_company_id_item_id_version_key" ON "tech_card"("company_id", "item_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "tech_card_stage_tech_card_id_seq_key" ON "tech_card_stage"("tech_card_id", "seq");

-- CreateIndex
CREATE INDEX "tech_card_material_tech_card_id_idx" ON "tech_card_material"("tech_card_id");

-- CreateIndex
CREATE UNIQUE INDEX "production_order_uid_key" ON "production_order"("uid");

-- CreateIndex
CREATE INDEX "production_order_company_id_status_due_date_idx" ON "production_order"("company_id", "status", "due_date");

-- CreateIndex
CREATE UNIQUE INDEX "production_order_company_id_number_key" ON "production_order"("company_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "production_stage_production_order_id_seq_key" ON "production_stage"("production_order_id", "seq");

-- CreateIndex
CREATE INDEX "production_stage_event_stage_id_occurred_at_idx" ON "production_stage_event"("stage_id", "occurred_at");

-- CreateIndex
CREATE INDEX "production_material_production_order_id_idx" ON "production_material"("production_order_id");

-- CreateIndex
CREATE INDEX "production_output_production_order_id_kind_idx" ON "production_output"("production_order_id", "kind");

-- CreateIndex
CREATE INDEX "production_order_cost_production_order_id_is_current_idx" ON "production_order_cost"("production_order_id", "is_current");

-- CreateIndex
CREATE INDEX "deviation_log_company_id_occurred_at_idx" ON "deviation_log"("company_id", "occurred_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "price_type_company_id_code_key" ON "price_type"("company_id", "code");

-- CreateIndex
CREATE INDEX "price_list_company_id_item_id_price_type_id_valid_from_idx" ON "price_list"("company_id", "item_id", "price_type_id", "valid_from");

-- CreateIndex
CREATE INDEX "partner_price_company_id_partner_id_item_id_valid_from_idx" ON "partner_price"("company_id", "partner_id", "item_id", "valid_from");

-- CreateIndex
CREATE UNIQUE INDEX "sales_order_uid_key" ON "sales_order"("uid");

-- CreateIndex
CREATE INDEX "sales_order_company_id_order_date_idx" ON "sales_order"("company_id", "order_date" DESC);

-- CreateIndex
CREATE INDEX "sales_order_company_id_status_idx" ON "sales_order"("company_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "sales_order_company_id_number_key" ON "sales_order"("company_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "sales_order_line_uid_key" ON "sales_order_line"("uid");

-- CreateIndex
CREATE UNIQUE INDEX "sales_order_line_sales_order_id_seq_key" ON "sales_order_line"("sales_order_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "shipment_uid_key" ON "shipment"("uid");

-- CreateIndex
CREATE INDEX "shipment_company_id_shipped_at_idx" ON "shipment"("company_id", "shipped_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "shipment_company_id_number_key" ON "shipment"("company_id", "number");

-- CreateIndex
CREATE INDEX "shipment_line_shipment_id_idx" ON "shipment_line"("shipment_id");

-- CreateIndex
CREATE UNIQUE INDEX "account_company_id_code_key" ON "account"("company_id", "code");

-- CreateIndex
CREATE INDEX "cashflow_item_company_id_idx" ON "cashflow_item"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "finance_operation_uid_key" ON "finance_operation"("uid");

-- CreateIndex
CREATE INDEX "finance_operation_company_id_occurred_at_idx" ON "finance_operation"("company_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "finance_operation_company_id_status_idx" ON "finance_operation"("company_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "finance_operation_company_id_number_key" ON "finance_operation"("company_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "finance_operation_company_id_idempotency_key_key" ON "finance_operation"("company_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "finance_entry_operation_id_idx" ON "finance_entry"("operation_id");

-- CreateIndex
CREATE INDEX "finance_entry_company_id_account_id_occurred_at_idx" ON "finance_entry"("company_id", "account_id", "occurred_at");

-- CreateIndex
CREATE INDEX "budget_company_id_period_start_idx" ON "budget"("company_id", "period_start");

-- CreateIndex
CREATE UNIQUE INDEX "lead_source_company_id_code_key" ON "lead_source"("company_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "lead_uid_key" ON "lead"("uid");

-- CreateIndex
CREATE INDEX "lead_company_id_status_idx" ON "lead"("company_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "deal_stage_company_id_code_key" ON "deal_stage"("company_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "deal_uid_key" ON "deal"("uid");

-- CreateIndex
CREATE INDEX "deal_company_id_stage_id_idx" ON "deal"("company_id", "stage_id");

-- CreateIndex
CREATE UNIQUE INDEX "deal_company_id_number_key" ON "deal"("company_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "document_type_company_id_code_key" ON "document_type"("company_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "document_uid_key" ON "document"("uid");

-- CreateIndex
CREATE INDEX "document_company_id_document_date_idx" ON "document"("company_id", "document_date" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "document_company_id_document_type_id_number_key" ON "document"("company_id", "document_type_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "document_counter_company_id_document_type_id_period_key_key" ON "document_counter"("company_id", "document_type_id", "period_key");

-- CreateIndex
CREATE INDEX "outbox_event_status_next_attempt_at_idx" ON "outbox_event"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "idempotency_key_expires_at_idx" ON "idempotency_key"("expires_at");

-- AddForeignKey
ALTER TABLE "department" ADD CONSTRAINT "department_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "department" ADD CONSTRAINT "department_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role" ADD CONSTRAINT "role_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role_assignment" ADD CONSTRAINT "user_role_assignment_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user_account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role_assignment" ADD CONSTRAINT "user_role_assignment_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role_assignment" ADD CONSTRAINT "user_role_assignment_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role_assignment" ADD CONSTRAINT "user_role_assignment_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role_assignment" ADD CONSTRAINT "user_role_assignment_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user_account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "login_log" ADD CONSTRAINT "login_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user_account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "currency_rate" ADD CONSTRAINT "currency_rate_currency_id_fkey" FOREIGN KEY ("currency_id") REFERENCES "currency"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_group" ADD CONSTRAINT "item_group_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_group" ADD CONSTRAINT "item_group_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "item_group"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item" ADD CONSTRAINT "item_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item" ADD CONSTRAINT "item_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "item_group"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item" ADD CONSTRAINT "item_base_unit_id_fkey" FOREIGN KEY ("base_unit_id") REFERENCES "unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_attribute" ADD CONSTRAINT "item_attribute_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_unit" ADD CONSTRAINT "item_unit_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_unit" ADD CONSTRAINT "item_unit_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner" ADD CONSTRAINT "partner_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner" ADD CONSTRAINT "partner_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "user_account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner" ADD CONSTRAINT "partner_price_type_id_fkey" FOREIGN KEY ("price_type_id") REFERENCES "price_type"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner" ADD CONSTRAINT "partner_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "lead_source"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_contact" ADD CONSTRAINT "partner_contact_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse" ADD CONSTRAINT "warehouse_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_zone" ADD CONSTRAINT "warehouse_zone_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storage_location" ADD CONSTRAINT "storage_location_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "warehouse_zone"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch" ADD CONSTRAINT "batch_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch" ADD CONSTRAINT "batch_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch" ADD CONSTRAINT "batch_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "partner"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch" ADD CONSTRAINT "batch_production_order_id_fkey" FOREIGN KEY ("production_order_id") REFERENCES "production_order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "serial_number" ADD CONSTRAINT "serial_number_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "serial_number" ADD CONSTRAINT "serial_number_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "serial_number" ADD CONSTRAINT "serial_number_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reason" ADD CONSTRAINT "stock_reason_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_move" ADD CONSTRAINT "stock_move_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_move" ADD CONSTRAINT "stock_move_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_move" ADD CONSTRAINT "stock_move_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_move" ADD CONSTRAINT "stock_move_serial_id_fkey" FOREIGN KEY ("serial_id") REFERENCES "serial_number"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_move" ADD CONSTRAINT "stock_move_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_move" ADD CONSTRAINT "stock_move_from_warehouse_id_fkey" FOREIGN KEY ("from_warehouse_id") REFERENCES "warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_move" ADD CONSTRAINT "stock_move_to_warehouse_id_fkey" FOREIGN KEY ("to_warehouse_id") REFERENCES "warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_move" ADD CONSTRAINT "stock_move_from_location_id_fkey" FOREIGN KEY ("from_location_id") REFERENCES "storage_location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_move" ADD CONSTRAINT "stock_move_to_location_id_fkey" FOREIGN KEY ("to_location_id") REFERENCES "storage_location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_move" ADD CONSTRAINT "stock_move_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partner"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_move" ADD CONSTRAINT "stock_move_reason_id_fkey" FOREIGN KEY ("reason_id") REFERENCES "stock_reason"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_move" ADD CONSTRAINT "stock_move_reversal_of_id_fkey" FOREIGN KEY ("reversal_of_id") REFERENCES "stock_move"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balance" ADD CONSTRAINT "stock_balance_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balance" ADD CONSTRAINT "stock_balance_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balance" ADD CONSTRAINT "stock_balance_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "storage_location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balance" ADD CONSTRAINT "stock_balance_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balance" ADD CONSTRAINT "stock_balance_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balance" ADD CONSTRAINT "stock_balance_serial_id_fkey" FOREIGN KEY ("serial_id") REFERENCES "serial_number"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservation" ADD CONSTRAINT "stock_reservation_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservation" ADD CONSTRAINT "stock_reservation_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservation" ADD CONSTRAINT "stock_reservation_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservation" ADD CONSTRAINT "stock_reservation_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservation" ADD CONSTRAINT "stock_reservation_sales_order_line_id_fkey" FOREIGN KEY ("sales_order_line_id") REFERENCES "sales_order_line"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_center" ADD CONSTRAINT "work_center_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tech_card" ADD CONSTRAINT "tech_card_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tech_card" ADD CONSTRAINT "tech_card_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tech_card" ADD CONSTRAINT "tech_card_output_unit_id_fkey" FOREIGN KEY ("output_unit_id") REFERENCES "unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tech_card_stage" ADD CONSTRAINT "tech_card_stage_tech_card_id_fkey" FOREIGN KEY ("tech_card_id") REFERENCES "tech_card"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tech_card_stage" ADD CONSTRAINT "tech_card_stage_work_center_id_fkey" FOREIGN KEY ("work_center_id") REFERENCES "work_center"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tech_card_material" ADD CONSTRAINT "tech_card_material_tech_card_id_fkey" FOREIGN KEY ("tech_card_id") REFERENCES "tech_card"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tech_card_material" ADD CONSTRAINT "tech_card_material_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "tech_card_stage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tech_card_material" ADD CONSTRAINT "tech_card_material_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tech_card_material" ADD CONSTRAINT "tech_card_material_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_order" ADD CONSTRAINT "production_order_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_order" ADD CONSTRAINT "production_order_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_order" ADD CONSTRAINT "production_order_tech_card_id_fkey" FOREIGN KEY ("tech_card_id") REFERENCES "tech_card"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_order" ADD CONSTRAINT "production_order_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_order" ADD CONSTRAINT "production_order_responsible_id_fkey" FOREIGN KEY ("responsible_id") REFERENCES "user_account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_order" ADD CONSTRAINT "production_order_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_order" ADD CONSTRAINT "production_order_parent_order_id_fkey" FOREIGN KEY ("parent_order_id") REFERENCES "production_order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_stage" ADD CONSTRAINT "production_stage_production_order_id_fkey" FOREIGN KEY ("production_order_id") REFERENCES "production_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_stage" ADD CONSTRAINT "production_stage_work_center_id_fkey" FOREIGN KEY ("work_center_id") REFERENCES "work_center"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_stage_event" ADD CONSTRAINT "production_stage_event_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "production_stage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_stage_event" ADD CONSTRAINT "production_stage_event_reason_id_fkey" FOREIGN KEY ("reason_id") REFERENCES "stock_reason"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_material" ADD CONSTRAINT "production_material_production_order_id_fkey" FOREIGN KEY ("production_order_id") REFERENCES "production_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_material" ADD CONSTRAINT "production_material_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "production_stage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_material" ADD CONSTRAINT "production_material_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_material" ADD CONSTRAINT "production_material_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_output" ADD CONSTRAINT "production_output_production_order_id_fkey" FOREIGN KEY ("production_order_id") REFERENCES "production_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_output" ADD CONSTRAINT "production_output_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "production_stage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_output" ADD CONSTRAINT "production_output_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_output" ADD CONSTRAINT "production_output_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_output" ADD CONSTRAINT "production_output_reason_id_fkey" FOREIGN KEY ("reason_id") REFERENCES "stock_reason"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_order_cost" ADD CONSTRAINT "production_order_cost_production_order_id_fkey" FOREIGN KEY ("production_order_id") REFERENCES "production_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deviation_log" ADD CONSTRAINT "deviation_log_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deviation_log" ADD CONSTRAINT "deviation_log_production_order_id_fkey" FOREIGN KEY ("production_order_id") REFERENCES "production_order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deviation_log" ADD CONSTRAINT "deviation_log_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "production_stage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deviation_log" ADD CONSTRAINT "deviation_log_reason_id_fkey" FOREIGN KEY ("reason_id") REFERENCES "stock_reason"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_type" ADD CONSTRAINT "price_type_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_list" ADD CONSTRAINT "price_list_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_list" ADD CONSTRAINT "price_list_price_type_id_fkey" FOREIGN KEY ("price_type_id") REFERENCES "price_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_list" ADD CONSTRAINT "price_list_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_list" ADD CONSTRAINT "price_list_currency_id_fkey" FOREIGN KEY ("currency_id") REFERENCES "currency"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_price" ADD CONSTRAINT "partner_price_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_price" ADD CONSTRAINT "partner_price_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_price" ADD CONSTRAINT "partner_price_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_price" ADD CONSTRAINT "partner_price_currency_id_fkey" FOREIGN KEY ("currency_id") REFERENCES "currency"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order" ADD CONSTRAINT "sales_order_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order" ADD CONSTRAINT "sales_order_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order" ADD CONSTRAINT "sales_order_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "user_account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order" ADD CONSTRAINT "sales_order_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order" ADD CONSTRAINT "sales_order_price_type_id_fkey" FOREIGN KEY ("price_type_id") REFERENCES "price_type"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order" ADD CONSTRAINT "sales_order_currency_id_fkey" FOREIGN KEY ("currency_id") REFERENCES "currency"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order" ADD CONSTRAINT "sales_order_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_line" ADD CONSTRAINT "sales_order_line_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_line" ADD CONSTRAINT "sales_order_line_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_line" ADD CONSTRAINT "sales_order_line_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_line" ADD CONSTRAINT "sales_order_line_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_line" ADD CONSTRAINT "shipment_line_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_line" ADD CONSTRAINT "shipment_line_sales_order_line_id_fkey" FOREIGN KEY ("sales_order_line_id") REFERENCES "sales_order_line"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_line" ADD CONSTRAINT "shipment_line_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_line" ADD CONSTRAINT "shipment_line_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_line" ADD CONSTRAINT "shipment_line_serial_id_fkey" FOREIGN KEY ("serial_id") REFERENCES "serial_number"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_currency_id_fkey" FOREIGN KEY ("currency_id") REFERENCES "currency"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cashflow_item" ADD CONSTRAINT "cashflow_item_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cashflow_item" ADD CONSTRAINT "cashflow_item_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "cashflow_item"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_operation" ADD CONSTRAINT "finance_operation_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_operation" ADD CONSTRAINT "finance_operation_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_operation" ADD CONSTRAINT "finance_operation_counter_account_id_fkey" FOREIGN KEY ("counter_account_id") REFERENCES "account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_operation" ADD CONSTRAINT "finance_operation_currency_id_fkey" FOREIGN KEY ("currency_id") REFERENCES "currency"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_operation" ADD CONSTRAINT "finance_operation_cashflow_item_id_fkey" FOREIGN KEY ("cashflow_item_id") REFERENCES "cashflow_item"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_operation" ADD CONSTRAINT "finance_operation_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partner"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_operation" ADD CONSTRAINT "finance_operation_reversal_of_id_fkey" FOREIGN KEY ("reversal_of_id") REFERENCES "finance_operation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_entry" ADD CONSTRAINT "finance_entry_operation_id_fkey" FOREIGN KEY ("operation_id") REFERENCES "finance_operation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_entry" ADD CONSTRAINT "finance_entry_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_entry" ADD CONSTRAINT "finance_entry_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget" ADD CONSTRAINT "budget_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget" ADD CONSTRAINT "budget_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget" ADD CONSTRAINT "budget_cashflow_item_id_fkey" FOREIGN KEY ("cashflow_item_id") REFERENCES "cashflow_item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_source" ADD CONSTRAINT "lead_source_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead" ADD CONSTRAINT "lead_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead" ADD CONSTRAINT "lead_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "lead_source"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead" ADD CONSTRAINT "lead_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partner"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead" ADD CONSTRAINT "lead_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "user_account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_stage" ADD CONSTRAINT "deal_stage_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal" ADD CONSTRAINT "deal_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal" ADD CONSTRAINT "deal_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partner"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal" ADD CONSTRAINT "deal_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "user_account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal" ADD CONSTRAINT "deal_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "deal_stage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal" ADD CONSTRAINT "deal_currency_id_fkey" FOREIGN KEY ("currency_id") REFERENCES "currency"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_type" ADD CONSTRAINT "document_type_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_document_type_id_fkey" FOREIGN KEY ("document_type_id") REFERENCES "document_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partner"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_currency_id_fkey" FOREIGN KEY ("currency_id") REFERENCES "currency"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_counter" ADD CONSTRAINT "document_counter_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_counter" ADD CONSTRAINT "document_counter_document_type_id_fkey" FOREIGN KEY ("document_type_id") REFERENCES "document_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox_event" ADD CONSTRAINT "outbox_event_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_key" ADD CONSTRAINT "idempotency_key_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
