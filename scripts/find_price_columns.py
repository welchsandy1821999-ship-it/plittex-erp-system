import openpyxl
import sys

# Set encoding for output
sys.stdout.reconfigure(encoding='utf-8')

def peek_xlsx(file_path):
    try:
        wb = openpyxl.load_workbook(file_path, read_only=True, data_only=True)
        sheet = wb.active
        print(f"Sheet: {sheet.title}")
        
        # Look for headers in the first 100 rows
        for i, row in enumerate(sheet.iter_rows(max_row=100), 1):
            values = [str(cell.value) if cell.value is not None else "" for cell in row]
            text = " | ".join(values)
            if any(kw in text.lower() for kw in ["цена", "изделие", "наименование"]):
                print(f"Row {i} (MATCH?): {text}")
            elif i < 20: # Show first 20 regardless
                print(f"Row {i}: {text}")
                
    except Exception as e:
        print(f"Error: {e}")

peek_xlsx(r'c:\Users\Пользователь\Desktop\plittex-erp\Price_март2026.xlsx')
