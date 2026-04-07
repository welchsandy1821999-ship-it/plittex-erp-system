import openpyxl
import sys
import re

sys.stdout.reconfigure(encoding='utf-8')

def find_keywords_in_xlsx(file_path, keywords):
    try:
        wb = openpyxl.load_workbook(file_path, read_only=True, data_only=True)
        sheet = wb.active
        
        for i, row in enumerate(sheet.iter_rows(min_row=1, max_row=1000), 1):
            row_vals = [str(cell.value) if cell.value is not None else "" for cell in row]
            text = " | ".join(row_vals)
            if any(kw.lower() in text.lower() for kw in keywords):
                print(f"Row {i}: {text}")
                
    except Exception as e:
        print(f"Error: {e}")

find_keywords_in_xlsx(r'c:\Users\Пользователь\Desktop\plittex-erp\Price_март2026.xlsx', ["Бордюр дорожный", "Кирпичик", "Плитка"])
