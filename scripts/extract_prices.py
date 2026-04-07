import openpyxl
import sys
import json

sys.stdout.reconfigure(encoding='utf-8')

def extract_all_prices(file_path):
    extracted = {}
    try:
        wb = openpyxl.load_workbook(file_path, read_only=True, data_only=True)
        sheet = wb.active
        
        for i, row in enumerate(sheet.iter_rows(min_row=1), 1):
            # Col 2 is Name (index 1)
            name = row[1].value
            if not name or not isinstance(name, str) or len(name) < 5:
                continue
            
            # Look for prices in columns 6, 8, 9, 11 (indexes 5, 7, 8, 10)
            # We take the first numerical value found starting from index 5
            price = None
            for idx in [5, 6, 7, 8, 9, 10, 11, 12]:
                if idx < len(row):
                    val = row[idx].value
                    if isinstance(val, (int, float)) and val > 10: # Assuming prices > 10
                        price = val
                        break
            
            if price:
                extracted[name.strip()] = price
                
        print(f"Extracted {len(extracted)} unique prices.")
        with open('extracted_prices.json', 'w', encoding='utf-8') as f:
            json.dump(extracted, f, ensure_ascii=False, indent=2)
                
    except Exception as e:
        print(f"Error: {e}")

extract_all_prices(r'c:\Users\Пользователь\Desktop\plittex-erp\Price_март2026.xlsx')
