import openpyxl

def raw_peek(file_path, row_idx):
    wb = openpyxl.load_workbook(file_path, read_only=True, data_only=True)
    sheet = wb.active
    row = list(sheet.iter_rows(min_row=row_idx, max_row=row_idx))[0]
    for i, cell in enumerate(row):
        print(f"Col {i+1}: Type={type(cell.value)}, Value='{cell.value}'")

raw_peek(r'c:\Users\Пользователь\Desktop\plittex-erp\Price_март2026.xlsx', 97)
