import csv
import json
import re
import sys
from difflib import SequenceMatcher

sys.stdout.reconfigure(encoding='utf-8')

ARTIFACT_PATH = r'c:\Users\Пользователь\Desktop\plittex-erp\csv_db_match_report.md'

def normalize_name(name):
    if not name: return ""
    name = str(name).lower()
    name = re.sub(r'["\'-]', ' ', name)
    name = re.sub(r'\s+', ' ', name).strip()
    return name.replace('x', 'х')

def similar(a, b):
    words_a = set(a.split())
    words_b = set(b.split())
    if not words_a or not words_b: return 0
    common = words_a.intersection(words_b)
    return len(common) / max(len(words_a), len(words_b))

def main():
    json_file = r'C:\Users\Пользователь\.gemini\antigravity\brain\104a1864-8ecc-4e2f-825c-f290b319d8b4\.system_generated\steps\9201\output.txt'
    csv_file = r'c:\Users\Пользователь\Desktop\plittex-erp\ревизия_склада_март2026.csv'
    
    db_items_list = []
    try:
        with open(json_file, 'r', encoding='utf-8') as f:
            data = json.load(f)
            db_items_list = data[0]['json_agg']
    except Exception as e:
        print(f"Error parsing JSON: {e}")
        return

    db_map = {}
    db_norm_map = {}
    for item in db_items_list:
        db_map[item['name']] = item
        db_norm_map[normalize_name(item['name'])] = item

    csv_items = []
    try:
        with open(csv_file, 'r', encoding='utf-8-sig') as f:
            reader = csv.reader(f, delimiter=';')
            next(reader) 
            for row in reader:
                if len(row) >= 5 and row[0] and row[0] != "ИТОГО ПО СКЛАДУ":
                    csv_items.append({
                        'name': row[0].strip(),
                        'grade': row[1].strip() if len(row) > 1 else '1 сорт',
                        'qty': float(row[2].replace(',', '.') if row[2] else 0),
                        'base_price': float(row[3].replace(',', '.') if row[3] else 0),
                        'unit_price': float(row[4].replace(',', '.') if row[4] else 0)
                    })
    except Exception as e:
        print(f"Error parsing CSV: {e}")
        return

    exact_matches = []
    fuzzy_matches = []
    not_found = []

    for c_item in csv_items:
        c_name = c_item['name']
        c_norm = normalize_name(c_name)
        
        is_derived = "2 сорт" in c_name.lower() or "экспериментальная" in c_name.lower() or "эксперементальная" in c_name.lower()
        if c_name in db_map:
            exact_matches.append((c_item, db_map[c_name]))
            continue
        if c_norm in db_norm_map:
            exact_matches.append((c_item, db_norm_map[c_norm]))
            continue
            
        if is_derived:
            not_found.append(c_item)
            continue

        best_match = None
        best_score = 0
        for d_norm, d_item in db_norm_map.items():
            score = similar(c_norm, d_norm)
            if score > best_score:
                best_score = score
                best_match = d_item
                
        if best_score >= 0.7:
            fuzzy_matches.append((c_item, best_match, best_score))
        else:
            not_found.append(c_item)

    report = "# Отчет: Сопоставление ревизии с БД (Март 2026)\n\n"
    report += f"- **Всего позиций в CSV:** {len(csv_items)}\n"
    report += f"- **Точных совпадений (существуют в БД):** {len(exact_matches)}\n"
    report += f"- **Частичных совпадений (возможны опечатки):** {len(fuzzy_matches)}\n"
    report += f"- **Не найдено (Нужно создать карточки):** {len(not_found)}\n\n"

    if not_found:
        report += "## 🆕 Новые позиции (К созданию в ERP)\n\n"
        report += "> [!IMPORTANT]\n> Эти карточки (в основном 2-й сорт и экспериментальная продукция) отсутствуют в текущем справочнике и будут созданы.\n\n"
        report += "| Наименование (Из CSV) | Сорт | Будущая цена (руб) |\n"
        report += "|---|---|---|\n"
        for item in sorted(not_found, key=lambda x: x['name']):
            report += f"| {item['name']} | {item['grade']} | {item['unit_price']:.2f} |\n"
        report += "\n"

    if fuzzy_matches:
        report += "## ⚠️ Возможные опечатки (Частичные совпадения)\n\n"
        report += "> [!WARNING]\n> Найдены очень похожие названия, но с небольшими отличиями. Нужно проверить, создавать новые карточки, или объединить их.\n\n"
        report += "| Название в файле ревизии (CSV) | Самое похожее в БД ERP | Совпадение |\n"
        report += "|---|---|---|\n"
        for item, db_item, score in sorted(fuzzy_matches, key=lambda x: x[0]['name']):
            report += f"| {item['name']} | {db_item['name']} | {score:.0%} |\n"
        report += "\n"

    price_diffs = []
    for item, db_item in exact_matches:
        if item['grade'] == '1 сорт' and item['base_price'] != db_item['current_price']:
            price_diffs.append((item, db_item))

    if price_diffs:
        report += "## 💰 Расхождения в ценах (1 сорт)\n\n"
        report += "> [!NOTE]\n> Следующие товары из ревизии имеют новую цену по сравнению с текущей стоимостью в БД. Цены в БД будут обновлены.\n\n"
        report += "| Наименование | Цена в БД (Старая) | Цена в ревизии (Новая) |\n"
        report += "|---|---|---|\n"
        for item, db_item in sorted(price_diffs, key=lambda x: x[0]['name']):
            report += f"| {item['name']} | {db_item['current_price']:.2f} | {item['base_price']:.2f} |\n"

    try:
        with open(ARTIFACT_PATH, 'w', encoding='utf-8') as f:
            f.write(report)
        print("Success")
    except Exception as e:
        print(f"Error writing artifact: {e}")

if __name__ == '__main__':
    main()
