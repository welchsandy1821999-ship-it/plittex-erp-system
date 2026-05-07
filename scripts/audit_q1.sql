-- AUDIT PHASE 1: Read-Only Analysis
-- ===================================

-- ШАГ 1.1: Найти ID нужных материалов
SELECT id, name, unit, current_price, item_type 
FROM items 
WHERE name ILIKE '%песок%' OR name ILIKE '%пигмент%белый%' OR name ILIKE '%пигмент%диоксид%'
ORDER BY name;
