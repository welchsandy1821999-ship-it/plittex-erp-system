# -*- coding: utf-8 -*-
import paramiko, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect('159.194.207.6', username='root', password='+JjJWwaK5+6b', timeout=30)

PSQL = "PGPASSWORD='ERP_secret_2026' psql -h localhost -U plittex -d plittex_erp"
OUTPUT_FILE = "c:\\Users\\Пользователь\\Desktop\\plittex-erp\\deploy\\audit_output.txt"

results = []

def run(label, sql, timeout=60):
    results.append(f"\n{'='*80}")
    results.append(f"=== {label} ===")
    results.append('='*80)
    _, o, e = client.exec_command(f"{PSQL} -c \"{sql}\"", timeout=timeout)
    out = o.read().decode(errors='replace').strip()
    err = e.read().decode(errors='replace').strip()
    if out: results.append(out)
    if err: results.append("ERR: " + err[:500])

PRODUCT_CATS = "('Бордюры и поребрики','Плитка гладкая','Плитка гранитная','Плитка меланж гладкая','Плитка меланж гранит','Стеновые блоки')"

run("ОБЩАЯ СТАТИСТИКА ПО СОРТАМ", f"""
SELECT 
  CASE 
    WHEN name ILIKE '%2 сорт%' OR name ILIKE '%2сорт%' THEN '2 сорт'
    WHEN name ILIKE '%экспер%' THEN 'Экспериментальный'
    ELSE '1 сорт'
  END AS grade,
  category,
  COUNT(*) AS cnt
FROM items 
WHERE category IN {PRODUCT_CATS}
  AND is_deleted = false
GROUP BY grade, category
ORDER BY category, grade;
""")

run("ВСЕ 1-СОРТ (id, name, category, unit, price, dealer_price, weight, qty_per_cycle, mold_id, gost, article, mix_main, mix_face, min_stock, default_layer)", f"""
SELECT id, name, category, unit, current_price, dealer_price, 
       weight_kg, qty_per_cycle, mold_id, gost_mark, article,
       mix_main_tpl, mix_face_tpl, min_stock, default_layer
FROM items 
WHERE category IN {PRODUCT_CATS}
  AND is_deleted = false
  AND name NOT ILIKE '%2 сорт%'
  AND name NOT ILIKE '%2сорт%'
  AND name NOT ILIKE '%экспер%'
ORDER BY category, name;
""")

run("ВСЕ 2-СОРТ", f"""
SELECT id, name, category, unit, current_price, dealer_price, weight_kg, qty_per_cycle, mold_id, gost_mark, article, mix_main_tpl, mix_face_tpl
FROM items 
WHERE category IN {PRODUCT_CATS}
  AND is_deleted = false
  AND (name ILIKE '%2 сорт%' OR name ILIKE '%2сорт%')
ORDER BY category, name;
""")

run("ВСЕ ЭКСПЕРИМЕНТАЛЬНЫЕ", f"""
SELECT id, name, category, unit, current_price, dealer_price, weight_kg, qty_per_cycle, mold_id, gost_mark, article
FROM items 
WHERE category IN {PRODUCT_CATS}
  AND is_deleted = false
  AND name ILIKE '%экспер%'
ORDER BY category, name;
""")

run("УДАЛЁННЫЕ", f"""
SELECT id, name, category FROM items 
WHERE category IN {PRODUCT_CATS}
  AND is_deleted = true
ORDER BY category, name;
""")

run("ПУСТЫЕ КРИТИЧНЫЕ ПОЛЯ (1 сорт)", f"""
SELECT id, name, category,
  CASE WHEN current_price IS NULL OR current_price = 0 THEN 'NO_PRICE' END AS p,
  CASE WHEN weight_kg IS NULL OR weight_kg = 0 THEN 'NO_WEIGHT' END AS w,
  CASE WHEN qty_per_cycle IS NULL OR qty_per_cycle = 0 THEN 'NO_QTY' END AS q,
  CASE WHEN mold_id IS NULL THEN 'NO_MOLD' END AS m,
  CASE WHEN mix_main_tpl IS NULL OR mix_main_tpl = '' THEN 'NO_MIX' END AS mx,
  CASE WHEN gost_mark IS NULL OR gost_mark = '' THEN 'NO_GOST' END AS g,
  CASE WHEN article IS NULL OR article = '' THEN 'NO_ART' END AS a
FROM items 
WHERE category IN {PRODUCT_CATS}
  AND is_deleted = false
  AND name NOT ILIKE '%2 сорт%'
  AND name NOT ILIKE '%экспер%'
  AND (
    current_price IS NULL OR current_price = 0
    OR weight_kg IS NULL OR weight_kg = 0
    OR qty_per_cycle IS NULL OR qty_per_cycle = 0
    OR mold_id IS NULL
    OR mix_main_tpl IS NULL OR mix_main_tpl = ''
    OR gost_mark IS NULL OR gost_mark = ''
    OR article IS NULL OR article = ''
  )
ORDER BY category, name;
""")

run("БОРДЮРЫ — все", f"""
SELECT id, name, unit, current_price, weight_kg, qty_per_cycle, mold_id, article
FROM items WHERE category = 'Бордюры и поребрики' AND is_deleted = false
ORDER BY name;
""")

client.close()

full_text = '\n'.join(results)
with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
    f.write(full_text)
print(f"Saved {len(full_text)} chars to {OUTPUT_FILE}")
print("Done")
