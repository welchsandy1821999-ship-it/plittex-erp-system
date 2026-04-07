import csv
import json
import re
import sys
from collections import defaultdict

sys.stdout.reconfigure(encoding='utf-8')

ARTIFACT_PATH = r'c:\Users\Пользователь\Desktop\plittex-erp\csv_db_match_report.md'

def extract_sku(name):
    # Match patterns like 2.К.4, 2.КО.6, 2.П.6, 1.СМ.8, 3.П.8, 1.ПР.8, 2.У.6
    # Optional spaces around dots usually not there but just in case
    match = re.search(r'\d+\.[А-Яа-яA-Za-z]+\.\d+(?:,\d+)?', name)
    if match:
        # Convert comma to dot if present for floating cases like 2.К.0,4 (though normally it's 2.К.4)
        return match.group(0).upper()
    return None

def normalize_color(name):
    name = name.lower().replace('ё', 'е')
    colors = ["бел", "желт", "коричнев", "красн", "оранжев", "сер", "черн", "оникс", "осень", "рубин", "яшма", "янтар"]
    found = []
    for c in colors:
        if c in name:
            found.append(c)
    if "меланж" in name:
        found.append("меланж")
    return set(found)

def normalize_texture(name):
    txt = set()
    if "гранит" in name.lower():
        txt.add("гранит")
    elif "гладк" in name.lower() or "сырая" in name.lower():
        txt.add("гладк")
    return txt

def main():
    json_file = r'C:\Users\Пользователь\.gemini\antigravity\brain\104a1864-8ecc-4e2f-825c-f290b319d8b4\.system_generated\steps\9201\output.txt'
    csv_file = r'c:\Users\Пользователь\Desktop\plittex-erp\ревизия_склада_март2026.csv'
    
    try:
        with open(json_file, 'r', encoding='utf-8') as f:
            data = json.load(f)
            db_items = data[0]['json_agg']
    except Exception as e:
        print(f"Error parsing JSON: {e}")
        return

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
    not_found = []
    fuzzy_matches = [] # Kept for any true edge cases

    for c_item in csv_items:
        c_name = c_item['name']
        c_low = c_name.lower()
        
        is_derived = "2 сорт" in c_low or "экспериментальная" in c_low or "эксперементальная" in c_low
        is_uriko = "урико" in c_low
        
        # We know inherently that 2 sort, experimental, and uriko are "new" to the DB
        if is_derived or is_uriko:
            not_found.append(c_item)
            continue
            
        c_sku = extract_sku(c_name)
        c_colors = normalize_color(c_name)
        c_textures = normalize_texture(c_name)
        
        match_found = False
        
        # Check DB items
        for d_item in db_items:
            d_name = d_item['name']
            
            # Simple Exact/Normalization check first
            if c_name == d_name or c_name.replace('x', 'х').lower() == d_name.replace('x', 'х').lower():
                exact_matches.append((c_item, d_item))
                match_found = True
                break
                
            d_sku = extract_sku(d_name)
            
            # If both have SKUs and they match...
            if c_sku and d_sku and c_sku == d_sku:
                d_colors = normalize_color(d_name)
                d_textures = normalize_texture(d_name)
                
                # Check if color and texture align well enough
                # Allow a match if colors mostly intersect and textures match.
                c_c_clean = c_colors - {"меланж"}
                d_c_clean = d_colors - {"меланж"}
                
                # Try to be strict: if the color signatures exactly intersect 
                if c_colors == d_colors and c_textures == d_textures:
                    exact_matches.append((c_item, d_item))
                    match_found = True
                    break
        
        if not match_found:
            # Maybe it's a Bordur (no sku)?
            if "бордюр" in c_low or "поребрик" in c_low or "полублок" in c_low:
                # Custom match for bordurs based on keywords rather than SKU
                for d_item in db_items:
                    d_name = d_item['name']
                    d_low = d_name.lower()
                    if ("бордюр" in c_low and "бордюр" in d_low) or ("поребрик" in c_low and "поребрик" in d_low):
                        if normalize_color(c_name) == normalize_color(d_name) and normalize_texture(c_name) == normalize_texture(d_name):
                            # Ensure dimension string matches if present
                            c_dim = re.search(r'\d+х\d+х\d+', c_low.replace('x', 'х'))
                            d_dim = re.search(r'\d+х\d+х\d+', d_low.replace('x', 'х'))
                            
                            c_d_str = c_dim.group(0) if c_dim else ""
                            d_d_str = d_dim.group(0) if d_dim else ""
                            
                            if (c_d_str and d_d_str and c_d_str == d_d_str) or (not c_d_str):
                                exact_matches.append((c_item, d_item))
                                match_found = True
                                break
                                
            if not match_found:
                fuzzy_matches.append(c_item)

    report = "# Анализ: Сопоставление по артикулам (SKU)\n\n"
    report += f"- **Всего позиций в CSV:** {len(csv_items)}\n"
    report += f"- **Успешно сопоставлено (1 сорт по артикулу и цвету):** {len(exact_matches)}\n"
    report += f"- **Планируется к созданию (Урико, 2 сорт, Эксп.):** {len(not_found)}\n"
    report += f"- **Не удалось сопоставить:** {len(fuzzy_matches)}\n\n"
    
    if fuzzy_matches:
        report += "## ⚠️ Ошибки сопоставления (Не найден аналог в БД)\n"
        report += "| Название в CSV |\n|---|\n"
        for item in fuzzy_matches:
             report += f"| {item['name']} |\n"
        report += "\n"

    new_uriko = [i for i in not_found if "урико" in i['name'].lower()]
    new_grade2 = [i for i in not_found if "2 сорт" in i['grade'].lower()]
    new_exp = [i for i in not_found if "экспериментальная" in i['grade'].lower()]
    
    report += f"## 🆕 Классы новых позиций (К созданию: {len(not_found)})\n\n"
    
    report += f"**1. Новая продукция (Урико, 60мм)** - {len(new_uriko)} позиций\n"
    if new_grade2:
        report += f"**2. Продукция 2-го сорта (50% цены)** - {len(new_grade2)} позиций\n"
    if new_exp:
        report += f"**3. Экспериментальная продукция (70% цены)** - {len(new_exp)} позиций\n"
    
    try:
        with open(ARTIFACT_PATH, 'w', encoding='utf-8') as f:
            f.write(report)
        print("Success")
    except Exception as e:
        print(f"Error writing artifact: {e}")

if __name__ == '__main__':
    main()
