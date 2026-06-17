-- ============================================================
-- МИГРАЦИЯ: Шаг 3 — создание недостающих 2-сорт позиций (267 шт.)
-- Дата: 2026-06-17
-- ============================================================

BEGIN;

INSERT INTO items (
    name, item_type, unit, current_price, weight_kg, category,
    qty_per_cycle, amortization_per_cycle, mold_id, gost_mark, article,
    dealer_price, is_deleted, piece_rate, legacy_name,
    mix_main_tpl, mix_face_tpl, min_stock, default_layer, default_warehouse_id,
    planned_cycles
)
SELECT
    s1.name || ' 2 сорт',
    s1.item_type, s1.unit,
    ROUND(s1.current_price * 0.50, 0),
    s1.weight_kg, s1.category,
    s1.qty_per_cycle, s1.amortization_per_cycle, s1.mold_id, s1.gost_mark,
    CASE WHEN s1.article IS NOT NULL AND s1.article != '' THEN s1.article || '2S' ELSE NULL END,
    0, false, s1.piece_rate, NULL,
    s1.mix_main_tpl, s1.mix_face_tpl, s1.min_stock,
    s1.default_layer, s1.default_warehouse_id, s1.planned_cycles
FROM items s1
WHERE NOT EXISTS (
    SELECT 1 FROM items s2
    WHERE LOWER(s2.name) = LOWER(s1.name) || ' 2 сорт'
      AND s2.is_deleted = false
)
AND s1.category IN (
    'Бордюры и поребрики','Плитка гладкая','Плитка гранитная',
    'Плитка меланж гладкая','Плитка меланж гранит'
)
AND s1.is_deleted = false
AND s1.name NOT ILIKE '%2 сорт%'
AND s1.name NOT ILIKE '%эксперим%';

COMMIT;
