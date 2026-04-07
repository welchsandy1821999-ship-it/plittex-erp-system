import openpyxl
import re
import json
import sys
from collections import defaultdict

sys.stdout.reconfigure(encoding='utf-8')

# Manual dictionary for items that are hard to match automatically
# (Grey, Color)
PRICES_MANUAL = {
    "2К0,4": (1200.0, 1400.0), # Standard 40mm
    "2К0,6": (1400.0, 1500.0), # Standard 60mm
    "2К4": (1310.0, 1500.0),   # Granit 40mm
    "2К6": (1550.0, 1650.0),   # Granit 60mm
    "Урико": (1200.0, 1400.0), # Same as Classico 40mm
    "2П4": (1500.0, 1750.0),   # Plate/Parquet 40mm (Estimated from CityMix 40)
    "2П6": (1650.0, 1950.0),   # Plate/Parquet 60mm (Estimated from CityMix 60)
    "3.П.8": (2250.0, 2650.0), # Plate 80mm
    "1.ПР.8": (2250.0, 2650.0), # Parquet 80mm
}

def clean_price(val):
    if val is None: return None
    if isinstance(val, (int, float)): return float(val)
    if isinstance(val, str):
        s = re.sub(r'[^\d]', '', val)
        try: return float(s)
        except: return None
    return None

def get_grade_info(full_name):
    grade_mult = 1.0
    grade_label = "1 сорт"
    if "2 сорт" in full_name:
        grade_mult = 0.5
        grade_label = "2 сорт"
    elif "Экспериментальная" in full_name or "Эксперементальная" in full_name:
        grade_mult = 0.7
        grade_label = "Экспериментальная"
    
    # Base name for price matching
    base_name = re.sub(r'2 сорт|Экспериментальная|Эксперементальная', '', full_name).strip()
    return base_name, grade_mult, grade_label

def process():
    price_file = r'c:\Users\Пользователь\Desktop\plittex-erp\Price_март2026.xlsx'
    sklad_file = r'c:\Users\Пользователь\Desktop\plittex-erp\склад2.xlsx'
    
    # Process склад2.xlsx
    inventory = defaultdict(float)
    try:
        wb_s = openpyxl.load_workbook(sklad_file, read_only=True, data_only=True)
        ws_s = wb_s.worksheets[0]
        for row in ws_s.iter_rows(min_row=2):
            name_val = row[6].value # Col G
            qty_val = row[7].value # Col H
            if name_val:
                inventory[str(name_val).strip()] += float(qty_val or 0)
    except Exception as e:
        pass

    # Generic Fallbacks
    fallbacks = {
        "бордюрдорожный": 700.0,
        "поребрик": 680.0,
        "ситимикс": 950.0,
        "паркет": 1000.0,
        "плита": 900.0
    }

    final_rows = []
    for name, qty in inventory.items():
        base_name, grade_mult, grade_label = get_grade_info(name)
        lower_name = base_name.lower()
        
        price = 0.0
        
        # Priority 1: Manual Mapping
        for pk, pv in PRICES_MANUAL.items():
            if pk.lower() in lower_name:
                if "серый" in lower_name or "серая" in lower_name:
                    price = pv[0]
                else:
                    price = pv[1]
                break
        
        # Priority 2: Fuzzy Pattern Match
        if price == 0:
            for fk, fv in fallbacks.items():
                if fk in re.sub(r'[^\w]', '', lower_name):
                    price = fv if any(s in lower_name for s in ["серый", "серая"]) else fv + 150.0
                    break
        
        calc_price = price * grade_mult
        final_rows.append({
            "name": name,
            "grade": grade_label,
            "qty": f"{qty:.2f}",
            "base_price": f"{price:.2f}",
            "unit_price": f"{calc_price:.2f}",
            "total": f"{calc_price * qty:.2f}"
        })

    final_rows.sort(key=lambda x: x['name'])

    md = "# Сводная таблица ревизии склада (Итоговая)\n\n"
    md += "| Название товара | Сорт | Кол-во | Базовая цена | Цена за ед. | Итого |\n"
    md += "| :--- | :--- | :--- | :--- | :--- | :--- |\n"
    grand_total = 0.0
    for r in final_rows:
        md += f"| {r['name']} | {r['grade']} | {r['qty']} | {r['base_price']} | {r['unit_price']} | {r['total']} |\n"
        grand_total += float(r['total'])
    
    md += f"\n**ИТОГО ПО СКЛАДУ: {grand_total:,.2f} руб.**\n"
    
    with open('/tmp/final_revision_table_v3.md', 'w', encoding='utf-8') as f:
        f.write(md)

if __name__ == "__main__":
    process()
