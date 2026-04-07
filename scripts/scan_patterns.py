import openpyxl
import sys

sys.stdout.reconfigure(encoding='utf-8')

def scan_prices(file_path):
    try:
        wb = openpyxl.load_workbook(file_path, read_only=True, data_only=True)
        sheet = wb.active
        
        # Scan and look for items and prices
        # Focus on rows 90-150 to get the pattern
        for i, row in enumerate(sheet.iter_rows(min_row=90, max_row=150), 90):
            values = [str(cell.value) if cell.value is not None else "" for cell in row]
            print(f"Row {i}: {values}")
                
    except Exception as e:
        print(f"Error: {e}")

scan_prices(r'c:\Users\Пользователь\Desktop\plittex-erp\Price_март2026.xlsx')
