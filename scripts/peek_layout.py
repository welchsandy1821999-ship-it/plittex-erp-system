import openpyxl
import sys

sys.stdout.reconfigure(encoding='utf-8')

def peek_rows(file_path):
    wb = openpyxl.load_workbook(file_path, read_only=True, data_only=True)
    sheet = wb.active
    # Scan rows 80 to 120
    for i, row in enumerate(sheet.iter_rows(min_row=80, max_row=120), 80):
        vals = [str(cell.value) if cell.value is not None else "" for cell in row]
        print(f"Row {i:3}: {' | '.join(vals)}")

peek_rows(r'c:\Users\Пользователь\Desktop\plittex-erp\Price_март2026.xlsx')
