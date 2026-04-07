import openpyxl
import sys

sys.stdout.reconfigure(encoding='utf-8')

def find_klasiko(file_path):
    wb = openpyxl.load_workbook(file_path, read_only=True, data_only=True)
    sheet = wb.active
    for i, row in enumerate(sheet.iter_rows(min_row=1, max_row=1000), 1):
        vals = [str(cell.value) if cell.value is not None else "" for cell in row]
        text = " | ".join(vals)
        if "классико" in text.lower():
            print(f"Row {i:3}: {text}")

find_klasiko(r'c:\Users\Пользователь\Desktop\plittex-erp\Price_март2026.xlsx')
