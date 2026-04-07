import openpyxl
import sys

sys.stdout.reconfigure(encoding='utf-8')

def peek_sklad2(file_path):
    wb = openpyxl.load_workbook(file_path, read_only=True, data_only=True)
    sheet = wb.active
    print(f"Sheet: {sheet.title}")
    
    for i, row in enumerate(sheet.iter_rows(max_row=20), 1):
        vals = [str(cell.value) if cell.value is not None else "" for cell in row]
        print(f"Row {i:3}: {' | '.join(vals)}")

peek_sklad2(r'c:\Users\Пользователь\Desktop\plittex-erp\склад2.xlsx')
