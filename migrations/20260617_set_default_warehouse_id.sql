-- ============================================================
-- МИГРАЦИЯ: Установка default_warehouse_id для всех позиций
-- Дата: 2026-06-17
-- ============================================================

BEGIN;

-- Все 2-сорт → склад 5 (markdown)
UPDATE items
SET default_warehouse_id = 5
WHERE (items.name ILIKE '%2 сорт%' OR items.name ILIKE '%2сорт%' OR items.name ILIKE '%уценка%')
  AND is_deleted = false
  AND (default_warehouse_id IS NULL OR default_warehouse_id != 5);

-- Все 1-сорт и экспериментальные → склад 4 (finished)
UPDATE items
SET default_warehouse_id = 4
WHERE items.name NOT ILIKE '%2 сорт%'
  AND items.name NOT ILIKE '%2сорт%'
  AND items.name NOT ILIKE '%уценка%'
  AND is_deleted = false
  AND category IN (
    'Бордюры и поребрики','Плитка гладкая','Плитка гранитная',
    'Плитка меланж гладкая','Плитка меланж гранит','Стеновые блоки'
  )
  AND (default_warehouse_id IS NULL OR default_warehouse_id = 0);

COMMIT;
