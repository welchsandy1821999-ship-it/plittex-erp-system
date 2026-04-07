import openpyxl
import sys

sys.stdout.reconfigure(encoding='utf-8')

def find_others(file_path):
    wb = openpyxl.load_workbook(file_path, read_only=True, data_only=True)
    sheet = wb.active
    keywords = ["плита", "паркет", "сити-микс", "урико"]
    for i, row in enumerate(sheet.iter_rows(min_row=1, max_row=1000), 1):
        vals = [str(cell.value) if cell.value is not None else "" for cell in row]
        text = " | ".join(vals)
        if any(kw in text.lower() for kw in keywords):
            print(f"Row {i:3}: {text}")

find_others(r'c:\Users\Пользователь\Desktop\plittex-erp\Price_март2026.xlsx')
