import openpyxl
import json
import io
import os

def parse_xlsx(filename):
    if not os.path.exists(filename):
        print(f"Error: {filename} not found")
        return
    
    wb = openpyxl.load_workbook(filename, data_only=True)
    sheet = wb.active
    data = []
    
    for row in sheet.rows:
        row_data = [cell.value for cell in row]
        # Ignore empty rows
        if any(v is not None for v in row_data):
            data.append(row_data)
            
    with io.open('tmp_revision.json', 'w', encoding='utf-8') as f:
        f.write(json.dumps(data, ensure_ascii=False, indent=2))
    print("Successfully wrote tmp_revision.json")

if __name__ == "__main__":
    parse_xlsx('склад.xlsx')
