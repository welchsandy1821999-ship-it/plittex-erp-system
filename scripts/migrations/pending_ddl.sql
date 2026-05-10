-- =============================================================================
-- Вынесено из runtime API (routes): выполнять вручную администратором БД (окно обслуживания).
-- Идемпотентные конструкции IF NOT EXISTS / ON CONFLICT-совместимые индексы.
-- (Копия логики бывших initReportsInfra, ensureCategoryAliasesTable, DDL возвратов.)
-- =============================================================================

-- --- Продажи / возвраты (раньше POST /api/sales/returns) ---------------------
ALTER TABLE client_order_items ADD COLUMN IF NOT EXISTS qty_returned numeric DEFAULT 0;
ALTER TABLE client_orders ADD COLUMN IF NOT EXISTS has_returns boolean DEFAULT false;

-- --- Финансы: алиасы категорий (ensureCategoryAliasesTable) -----------------
CREATE TABLE IF NOT EXISTS category_aliases (
    id SERIAL PRIMARY KEY,
    old_name VARCHAR(255) NOT NULL,
    old_name_norm VARCHAR(255) NOT NULL,
    target_name VARCHAR(255) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS category_aliases_old_name_norm_uq
    ON category_aliases (old_name_norm);

-- --- Отчёты: reg_* и индексы (initReportsInfra) ------------------------------
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS reg_is_posted BOOLEAN;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS reg_is_primary_doc BOOLEAN;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS reg_document_no VARCHAR(120);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS reg_document_date DATE;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS reg_source_tag VARCHAR(40);

UPDATE transactions SET reg_is_posted = true WHERE reg_is_posted IS NULL;
UPDATE transactions SET reg_is_primary_doc = false WHERE reg_is_primary_doc IS NULL;
UPDATE transactions SET reg_source_tag = 'legacy' WHERE reg_source_tag IS NULL OR TRIM(reg_source_tag) = '';

ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS reg_is_posted BOOLEAN;
ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS reg_is_primary_doc BOOLEAN;
ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS reg_document_no VARCHAR(120);
ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS reg_document_date DATE;
ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS reg_source_tag VARCHAR(40);
ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS unit_price NUMERIC(14,4);

UPDATE inventory_movements SET reg_is_posted = true WHERE reg_is_posted IS NULL;
UPDATE inventory_movements SET reg_is_primary_doc = false WHERE reg_is_primary_doc IS NULL;
UPDATE inventory_movements SET reg_source_tag = 'legacy' WHERE reg_source_tag IS NULL OR TRIM(reg_source_tag) = '';

CREATE INDEX IF NOT EXISTS idx_tx_report_date_type ON transactions(transaction_date, transaction_type);
CREATE INDEX IF NOT EXISTS idx_tx_report_account ON transactions(account_id, transaction_date);
CREATE INDEX IF NOT EXISTS idx_tx_reg_source_tag ON transactions(reg_source_tag, transaction_date);
CREATE INDEX IF NOT EXISTS idx_inv_report_date_wh_item ON inventory_movements(movement_date, warehouse_id, item_id);
CREATE INDEX IF NOT EXISTS idx_inv_report_created_wh_item ON inventory_movements(created_at, warehouse_id, item_id);
CREATE INDEX IF NOT EXISTS idx_inv_reg_source_tag ON inventory_movements(reg_source_tag, movement_date);

-- --- Номенклатура: склад по умолчанию (2 сорт / markdown и др.) — маршрут резерва без ручного выбора ---
ALTER TABLE items ADD COLUMN IF NOT EXISTS default_warehouse_id INT REFERENCES warehouses(id) ON DELETE SET NULL;
