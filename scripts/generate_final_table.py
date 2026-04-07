import json
import io

# Load matching results
with io.open('matching_final.json', 'r', encoding='utf-8') as f:
    matches = json.load(f)

# Load DB items to get prices
with io.open(r'C:\Users\Пользователь\.gemini\antigravity\brain\104a1864-8ecc-4e2f-825c-f290b319d8b4\.system_generated\steps\8792\output.txt', 'r', encoding='utf-8') as f:
    db_items = {item['id']: item for item in json.load(f)}

table_md = "| Название в Excel | Категория | Базовый товар в БД | Статус | Новая цена (расчет) |\n"
table_md += "| :--- | :--- | :--- | :--- | :--- |\n"

added_items = set()

for m in matches:
    xl_name = m['xl_name']
    grade = m['grade']
    matched_id = m['matched_id']
    matched_name = m['matched_name']
    
    if xl_name in added_items: continue
    added_items.add(xl_name)
    
    # Pricing logic
    price_info = "Н/Д"
    if matched_id and matched_id in db_items:
        base_price = float(db_items[matched_id].get('current_price', 0) or 0)
        if grade == '2 сорт':
            price_info = f"{base_price * 0.5:.2f} (50%)"
        elif grade == 'Экспериментальная':
            price_info = f"{base_price * 0.7:.2f} (70%)"
        else:
            price_info = f"{base_price:.2f} (100%)"
            
    status = "✅ Сопоставлено" if grade == '1 сорт' and matched_id else "🆕 Создать (2 сорт)"
    if grade == 'Экспериментальная':
        status = "🆕 Создать (Эксп.)"
    if not matched_id:
        status = "❓ ТРЕБУЕТСЯ УТОЧНЕНИЕ"
        
    table_md += f"| {xl_name} | {grade} | {matched_name} | {status} | {price_info} |\n"

with io.open('final_matching_table.md', 'w', encoding='utf-8') as f:
    f.write(table_md)
