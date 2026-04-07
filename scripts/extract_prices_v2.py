import openpyxl
import re
import json

def clean_price(val):
    if val is None: return None
    if isinstance(val, (int, float)): return float(val)
    if isinstance(val, str):
        # Remove spaces and non-digit/dot characters
        # Handling "1 100" or "1.100"
        s = re.sub(r'[^\d.,]', '', val).replace(',', '.')
        try:
            return float(s)
        except:
            return None
    return None

def extract_robust_prices(file_path):
    extracted = {}
    try:
        wb = openpyxl.load_workbook(file_path, read_only=True, data_only=True)
        sheet = wb.active
        
        last_name = None
        for i, row in enumerate(sheet.iter_rows(min_row=1), 1):
            row_vals = [cell.value for cell in row]
            
            # Name check: Col 2 (idx 1). 
            # If name is there, it's the "Current Item"
            name_val = row_vals[1] if len(row_vals) > 1 else None
            if name_val and isinstance(name_val, str) and len(name_val.split()) > 2:
                last_name = name_val.strip()
            
            # If we have a name, look for prices in this row or subsequent rows before the next name
            if last_name:
                for idx, val in enumerate(row_vals):
                    price = clean_price(val)
                    if price and price > 100: # Assuming typical product prices > 100
                        # Column 6, 8, 9, 11 are common price columns
                        if idx in [5, 6, 7, 8, 9, 10, 11]:
                            if last_name not in extracted:
                                extracted[last_name] = price
        
        print(f"Extracted {len(extracted)} product prices.")
        with open('extracted_prices_v2.json', 'w', encoding='utf-8') as f:
            json.dump(extracted, f, ensure_ascii=False, indent=2)
                
    except Exception as e:
        print(f"Error: {e}")

extract_robust_prices(r'c:\Users\Пользователь\Desktop\plittex-erp\Price_март2026.xlsx')
