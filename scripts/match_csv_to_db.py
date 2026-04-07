import csv
import psycopg2
import sys
import re
from difflib import SequenceMatcher

sys.stdout.reconfigure(encoding='utf-8')

# Database connection params
DB_PARAMS = {
    'dbname': 'plittex_db',
    'user': 'postgres',
    'password': 'password',
    'host': 'localhost',
    'port': '5432'
}

def normalize_name(name):
    # Lowercase and remove multiple spaces
    name = str(name).lower().strip()
    name = re.sub(r'\s+', ' ', name)
    # Standardize dimensions separator (x vs х)
    name = name.replace('x', 'х')
    return name

def similar(a, b):
    return SequenceMatcher(None, a, b).ratio()

def analyze():
    csv_file = r'c:\Users\Пользователь\Desktop\plittex-erp\ревизия_склада_март2026.csv'
    
    # 1. Read CSV
    csv_items = []
    try:
        with open(csv_file, 'r', encoding='utf-8-sig') as f:
            reader = csv.reader(f, delimiter=';')
            headers = next(reader)
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
        print(f"Error reading CSV: {e}")
        return

    # 2. Get DB Items
    db_items = {}
    try:
        conn = psycopg2.connect(**DB_PARAMS)
        cur = conn.cursor()
        cur.execute("SELECT id, name, category, current_price FROM items WHERE category != 'Сырье'")
        for row in cur.fetchall():
            db_items[row[1]] = {
                'id': row[0],
                'name': row[1],
                'category': row[2],
                'current_price': float(row[3] or 0)
            }
        cur.close()
        conn.close()
    except Exception as e:
        print(f"Error querying DB: {e}")
        return

    db_names_normalized = {normalize_name(name): name for name in db_items.keys()}
    
    # 3. Match
    exact_matches = []
    fuzzy_matches = []
    not_found = []
    
    for item in csv_items:
        norm_csv_name = normalize_name(item['name'])
        
        # Try exact match first
        if item['name'] in db_items:
            db_item = db_items[item['name']]
            exact_matches.append((item, db_item))
            continue
            
        # Try normalized match
        if norm_csv_name in db_names_normalized:
            db_original_name = db_names_normalized[norm_csv_name]
            db_item = db_items[db_original_name]
            # Consider this an exact match but flag the case difference
            exact_matches.append((item, db_item))
            continue
            
        # Try fuzzy match
        best_ratio = 0
        best_match = None
        for db_norm, db_orig in db_names_normalized.items():
            ratio = similar(norm_csv_name, db_norm)
            if ratio > best_ratio:
                best_ratio = ratio
                best_match = db_orig
                
        if best_ratio > 0.85:
            fuzzy_matches.append((item, db_items[best_match], best_ratio))
        else:
            not_found.append(item)

    # 4. Generate Report
    print(f"# Отчет о сопоставлении ревизии с базой данных ERP\n")
    print(f"**Всего уникальных позиций в файле ревизии:** {len(csv_items)}")
    print(f"**Найдено точных совпадений:** {len(exact_matches)}")
    print(f"**Найдено частичных совпадений (требуют проверки):** {len(fuzzy_matches)}")
    print(f"**Не найдено в базе (нужно создать карточки):** {len(not_found)}\n")

    if not_found:
        print(f"## 🚨 Не найдено в базе ERP (Новые позиции: {len(not_found)})")
        print("| Наименование в CSV | Сорт | Цена в CSV | Ожидаемое действие |")
        print("|---|---|---|---|")
        for item in not_found:
            print(f"| {item['name']} | {item['grade']} | {item['unit_price']} | Создать новую карточку товара |")
        print("\n")

    if fuzzy_matches:
        print(f"## ⚠️ Частичные совпадения (Возможные опечатки: {len(fuzzy_matches)})")
        print("| Наименование в CSV | Наименование в БД | Совпадение | Цена CSV | Цена БД |")
        print("|---|---|---|---|---|")
        for item, db_item, ratio in fuzzy_matches:
            print(f"| {item['name']} | {db_item['name']} | {ratio:.0%} | {item['unit_price']} | {db_item['current_price']} |")
        print("\n")

    # Let's check exact matches for price discrepancy (for 1 сорт only, or base price vs db price).
    price_diffs = []
    for item, db_item in exact_matches:
        if item['grade'] == '1 сорт' and item['base_price'] != db_item['current_price']:
            price_diffs.append((item, db_item))
            
    if price_diffs:
        print(f"## 💰 Расхождения цен по 1-му сорту ({len(price_diffs)})")
        print("| Наименование | Цена в CSV (Новая) | Цена в БД (Старая) |")
        print("|---|---|---|")
        for item, db_item in price_diffs:
            print(f"| {item['name']} | {item['base_price']} | {db_item['current_price']} |")

if __name__ == '__main__':
    analyze()
