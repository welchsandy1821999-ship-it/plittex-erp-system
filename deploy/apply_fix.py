# -*- coding: utf-8 -*-
import paramiko, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect('159.194.207.6', username='root', password='+JjJWwaK5+6b', timeout=30)

PSQL = "PGPASSWORD='ERP_secret_2026' psql -h localhost -U plittex -d plittex_erp"

SQL = """
BEGIN;

-- 1. Все 2-сорт позиции → склад 5 (markdown)
UPDATE items
SET default_warehouse_id = 5
WHERE (items.name ILIKE '%2 сорт%' OR items.name ILIKE '%2сорт%' OR items.name ILIKE '%уценка%')
  AND is_deleted = false
  AND (default_warehouse_id IS NULL OR default_warehouse_id != 5);

-- 2. Все 1-сорт и экспериментальные → склад 4 (finished)
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

-- Проверка итогов
SELECT 
    CASE WHEN i.name ILIKE '%2 сорт%' THEN '2 сорт'
         WHEN i.name ILIKE '%эксперим%' THEN 'Экспериментальный'
         ELSE '1 сорт' END AS grade,
    i.default_warehouse_id AS wh_id,
    w.name AS warehouse_name,
    COUNT(*) AS cnt
FROM items i
LEFT JOIN warehouses w ON w.id = i.default_warehouse_id
WHERE i.category IN (
    'Бордюры и поребрики','Плитка гладкая','Плитка гранитная',
    'Плитка меланж гладкая','Плитка меланж гранит'
)
AND i.is_deleted = false
GROUP BY grade, i.default_warehouse_id, w.name
ORDER BY grade, i.default_warehouse_id;

COMMIT;
"""

sftp = client.open_sftp()
with sftp.open('/tmp/fix_warehouses.sql', 'w') as f:
    f.write(SQL)
sftp.close()

print("=== УСТАНОВКА default_warehouse_id (исправленная) ===\n")
_, o, e = client.exec_command(f"{PSQL} -f /tmp/fix_warehouses.sql", timeout=30)
out = o.read().decode(errors='replace')
err = e.read().decode(errors='replace')
print(out)
if err and 'ERROR' in err: print("ERR:", err)

client.close()
