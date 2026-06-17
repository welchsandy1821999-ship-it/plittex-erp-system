-- ============================================================
-- МИГРАЦИЯ: Шаг 2 — заполнение пустых полей 2-сорта из 1-сорта
-- Дата: 2026-06-17
-- ============================================================

BEGIN;

UPDATE items s2
SET
    weight_kg     = CASE WHEN s2.weight_kg = 0 THEN s1.weight_kg ELSE s2.weight_kg END,
    qty_per_cycle = CASE WHEN s2.qty_per_cycle = 1 AND s1.qty_per_cycle != 1 THEN s1.qty_per_cycle ELSE s2.qty_per_cycle END,
    mold_id       = CASE WHEN s2.mold_id IS NULL THEN s1.mold_id ELSE s2.mold_id END,
    gost_mark     = CASE WHEN s2.gost_mark IS NULL OR s2.gost_mark = '' THEN s1.gost_mark ELSE s2.gost_mark END,
    mix_main_tpl  = CASE WHEN s2.mix_main_tpl IS NULL OR s2.mix_main_tpl = '' THEN s1.mix_main_tpl ELSE s2.mix_main_tpl END,
    mix_face_tpl  = CASE WHEN s2.mix_face_tpl IS NULL OR s2.mix_face_tpl = '' THEN s1.mix_face_tpl ELSE s2.mix_face_tpl END,
    article       = CASE WHEN s2.article IS NULL OR s2.article = '' THEN s1.article || '2S' ELSE s2.article END
FROM items s1
WHERE
    REPLACE(REPLACE(LOWER(s2.name), ' 2 сорт', ''), '2сорт', '') = LOWER(s1.name)
    AND s1.is_deleted = false
    AND s1.name NOT ILIKE '%2 сорт%'
    AND s1.name NOT ILIKE '%эксперим%'
    AND (s2.name ILIKE '%2 сорт%' OR s2.name ILIKE '%2сорт%')
    AND s2.is_deleted = false
    AND s2.category IN (
        'Бордюры и поребрики','Плитка гладкая','Плитка гранитная',
        'Плитка меланж гладкая','Плитка меланж гранит'
    )
    AND (
        s2.weight_kg = 0 OR s2.qty_per_cycle = 1
        OR s2.mold_id IS NULL
        OR s2.gost_mark IS NULL OR s2.gost_mark = ''
        OR s2.mix_main_tpl IS NULL OR s2.mix_main_tpl = ''
        OR s2.mix_face_tpl IS NULL OR s2.mix_face_tpl = ''
    );

-- Ручные правки для ID 632 и 645
UPDATE items SET qty_per_cycle=0.8, mold_id=8, mix_main_tpl='main_tile_40', mix_face_tpl='face_granite_white', article='PL-229E2S' WHERE id=632;
UPDATE items SET name='Тротуарная плитка КЛАССИКО - 2.КО.6 60мм Гранит Белая 2 сорт', weight_kg=129.46, gost_mark='ТУ 23.61.11-001-50829991-2023', article='PL-3012S' WHERE id=645;

COMMIT;
