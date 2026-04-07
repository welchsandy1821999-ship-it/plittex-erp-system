import json
import io
import re

# Load DB items
with io.open(r'C:\Users\Пользователь\.gemini\antigravity\brain\104a1864-8ecc-4e2f-825c-f290b319d8b4\.system_generated\steps\8792\output.txt', 'r', encoding='utf-8') as f:
    db_items = {item['id']: item for item in json.load(f)}

# Load Excel data
with io.open('tmp_revision.json', 'r', encoding='utf-8') as f:
    revision_data = json.load(f)

def clean_for_match(name):
    if not name: return []
    name = name.lower()
    name = re.sub(r'["«»]', '', name)
    name = re.sub(r'2 сорт|сорт 2|2сорт|уценка|экспериментальная|эксперементальная', '', name)
    name = re.sub(r'\d+х\d+х\d+', '', name)
    words = re.findall(r'[а-яё0-9a-z]+', name)
    return [w for w in words if len(w) > 1]

def get_grade(name):
    name = name.lower()
    if '2 сорт' in name or '2сорт' in name or 'уценка' in name:
        return '2 сорт'
    if 'экспериментальная' in name or 'эксперементальная' in name:
        return 'Экспериментальная'
    return '1 сорт'

final_data = []

# Simple matcher
for row in revision_data:
    if not row or len(row) < 2: continue
    xl_name = row[0]
    xl_qty = row[1]
    if xl_name is None: continue
    
    grade = get_grade(xl_name)
    xl_keywords = set(clean_for_match(xl_name))
    
    best_match_id = None
    max_matches = 0
    
    for item_id, item in db_items.items():
        db_keywords = set(clean_for_match(item['name']))
        intersection = xl_keywords.intersection(db_keywords)
        if len(intersection) > max_matches:
            max_matches = len(intersection)
            best_match_id = item_id

    final_data.append({
        'xl_name': xl_name,
        'grade': grade,
        'matched_id': best_match_id,
        'matched_name': db_items[best_match_id]['name'] if best_match_id else "НЕ НАЙДЕНО",
        'revision_qty': xl_qty
    })

# Write Table
table_md = "| № | Название в Excel | Категория | Базовый товар в БД | Статус | Новая цена (расчет) | Кол-во (Excel) |\n"
table_md += "| :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n"

for i, m in enumerate(final_data, 1):
    xl_name = m['xl_name']
    grade = m['grade']
    matched_id = m['matched_id']
    matched_name = m['matched_name']
    xl_qty = m['revision_qty']
    
    price_info = "—"
    if matched_id:
        base_price = float(db_items[matched_id].get('current_price', 0) or 0)
        if base_price > 0:
            if grade == '2 сорт':
                price_info = f"{base_price * 0.5:.2f} (50%)"
            elif grade == 'Экспериментальная':
                price_info = f"{base_price * 0.7:.2f} (70%)"
            else:
                price_info = f"{base_price:.2f} (100%)"
        else:
            price_info = "БАЗОВАЯ ЦЕНА 0.00"
            
    status = "✅ Сопоставлено" if grade == '1 сорт' and matched_id else f"🆕 Будет создан ({grade})"
    if not matched_id:
        status = "❓ ТРЕБУЕТСЯ УТОЧНЕНИЕ"
        
    table_md += f"| {i} | {xl_name} | {grade} | {matched_name} | {status} | {price_info} | {xl_qty} |\n"

with io.open('inventory_match_final_report.md', 'w', encoding='utf-8') as f:
    f.write(table_md)
