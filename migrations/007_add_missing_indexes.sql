-- =============================================================
-- MIGRATION 007: EPIC-4 — Отсутствующие индексы (12 штук)
-- Дата: 2026-05-02
-- Цель: Ускорение тяжёлых агрегаций (P&L, баланс контрагентов,
--        список заказов, взаиморасчёты, история продаж)
-- =============================================================

BEGIN;

-- ═══════ 1. transactions.counterparty_id (простой) ═══════
-- Используется: finance.js:1347, sales.js:292-295, sales.js:1340-1352
CREATE INDEX IF NOT EXISTS idx_tx_counterparty
  ON transactions(counterparty_id);

-- ═══════ 2. transactions (counterparty_id, type) partial ═══════
-- Покрывает самый частый паттерн: WHERE cp_id AND type AND NOT deleted
CREATE INDEX IF NOT EXISTS idx_tx_cp_type
  ON transactions(counterparty_id, transaction_type)
  WHERE COALESCE(is_deleted, false) = false;

-- ═══════ 3. transactions.linked_order_id partial ═══════
-- Используется: sales.js:896, finance.js:1619-1625
CREATE INDEX IF NOT EXISTS idx_tx_linked_order
  ON transactions(linked_order_id)
  WHERE linked_order_id IS NOT NULL;

-- ═══════ 4. transactions.category ═══════
-- Используется: finance.js:817 (P&L по категории)
CREATE INDEX IF NOT EXISTS idx_tx_category
  ON transactions(category);

-- ═══════ 5. transactions — partial на «живые» записи ═══════
-- Почти все запросы фильтруют is_deleted=false
CREATE INDEX IF NOT EXISTS idx_tx_not_deleted
  ON transactions(transaction_date, transaction_type)
  WHERE COALESCE(is_deleted, false) = false;

-- ═══════ 6. inventory_movements.supplier_id partial ═══════
-- Используется: sales.js:293, 529, 1342, 1350
CREATE INDEX IF NOT EXISTS idx_inv_mov_supplier
  ON inventory_movements(supplier_id)
  WHERE supplier_id IS NOT NULL;

-- ═══════ 7. inventory_movements.movement_type ═══════
-- Используется: sales.js:828, 1577, reports.js:929
CREATE INDEX IF NOT EXISTS idx_inv_mov_type
  ON inventory_movements(movement_type);

-- ═══════ 8. inventory_movements.item_id ═══════
-- Используется: sales.js:630, 1184, 1210 (баланс товара)
CREATE INDEX IF NOT EXISTS idx_inv_mov_item
  ON inventory_movements(item_id);

-- ═══════ 9. client_orders.counterparty_id ═══════
-- Используется: sales.js:291-295, 1340-1355, finance.js:1609-1688
CREATE INDEX IF NOT EXISTS idx_co_counterparty
  ON client_orders(counterparty_id);

-- ═══════ 10. client_orders.status ═══════
-- Используется: sales.js:1359, 291, 295
CREATE INDEX IF NOT EXISTS idx_co_status
  ON client_orders(status);

-- ═══════ 11. timesheet_records.record_date ═══════
-- Используется: finance.js:863 (P&L ФОТ)
CREATE INDEX IF NOT EXISTS idx_timesheet_date
  ON timesheet_records(record_date);

-- ═══════ 12. transaction_categories.name ═══════
-- Используется: finance.js:835 (LEFT JOIN в каждом P&L)
CREATE INDEX IF NOT EXISTS idx_txcat_name
  ON transaction_categories(name);

COMMIT;
