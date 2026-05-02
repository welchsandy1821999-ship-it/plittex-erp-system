-- =============================================================
-- MIGRATION 008: EPIC-4 P5 — Денормализация shipment_doc_number
-- Дата: 2026-05-02
-- Цель: Устранение GROUP BY SUBSTRING(description FROM 'УТ-[0-9]+')
--        в истории продаж. Прямая колонка вместо regexp-парсинга.
-- =============================================================

-- 1. Добавляем колонку
ALTER TABLE inventory_movements
    ADD COLUMN IF NOT EXISTS shipment_doc_number VARCHAR(50);

-- 2. Backfill: извлекаем номер документа из description для старых записей
--    Поддерживаем все 3 формата: УТ-XXXX, PH-XXXX, РН-XXXX
UPDATE inventory_movements
SET shipment_doc_number = COALESCE(
    SUBSTRING(description FROM 'УТ-[0-9]+'),
    SUBSTRING(description FROM 'PH-[0-9]+'),
    SUBSTRING(description FROM 'РН-[0-9]+')
)
WHERE movement_type = 'sales_shipment'
  AND shipment_doc_number IS NULL
  AND (description ~ 'УТ-[0-9]+' OR description ~ 'PH-[0-9]+' OR description ~ 'РН-[0-9]+');

-- 3. Partial индекс для быстрой группировки
CREATE INDEX IF NOT EXISTS idx_inv_mov_doc_num
    ON inventory_movements(shipment_doc_number)
    WHERE shipment_doc_number IS NOT NULL;
