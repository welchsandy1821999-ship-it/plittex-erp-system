import openpyxl
import re
import json

def clean_price(val):
    if val is None: return None
    if isinstance(val, (int, float)): return float(val)
    if isinstance(val, str):
        s = re.sub(r'[^\d]', '', val) # remove all non-digits
        try:
            return float(s)
        except:
            return None
    return None

def extract_advanced_prices(file_path):
    extracted = []
    try:
        wb = openpyxl.load_workbook(file_path, read_only=True, data_only=True)
        sheet = wb.active
        
        last_category = ""
        for i, row in enumerate(sheet.iter_rows(min_row=1), 1):
            row_vals = [cell.value for cell in row]
            
            # Category Check (Merged rows or just large text)
            cat_candidate = row_vals[0]
            if cat_candidate and isinstance(cat_candidate, str) and len(cat_candidate) > 10 and not any(d in cat_candidate for d in "0123456789"):
                last_category = cat_candidate.strip()
            
            # Product Row Check
            name = row_vals[0] # Item title
            dims = row_vals[2] # Dimensions
            
            if name and dims and isinstance(dims, str) and re.search(r'\d+х\d+', dims):
                # Standard Price (Col 6 - index 5)
                price_grey = clean_price(row_vals[5])
                if price_grey:
                    extracted.append({
                        "name": f"{name} {dims} Серый",
                        "price": price_grey
                    })
                
                # Red Price (Col 8 - index 7)
                price_red = clean_price(row_vals[7])
                if price_red:
                    extracted.append({
                        "name": f"{name} {dims} Красный",
                        "price": price_red
                    })
                    
                # Yellow Price (Col 9 - index 8)
                price_yellow = clean_price(row_vals[8])
                if price_yellow:
                    extracted.append({
                        "name": f"{name} {dims} Желтый",
                        "price": price_yellow
                    })

        print(f"Extracted {len(extracted)} items with prices.")
        with open('extracted_prices_advanced.json', 'w', encoding='utf-8') as f:
            json.dump(extracted, f, ensure_ascii=False, indent=2)
                
    except Exception as e:
        print(f"Error: {e}")

extract_advanced_prices(r'c:\Users\Пользователь\Desktop\plittex-erp\Price_март2026.xlsx')
