import pandas as pd
import json

try:
    # Read the Excel file - just a peek
    xl = pd.ExcelFile(r'c:\Users\Пользователь\Desktop\plittex-erp\Price_март2026.xlsx')
    print(f"Sheets: {xl.sheet_names}")
    
    # Try to read the first sheet to see structure
    for sheet in xl.sheet_names[:1]: # only first sheet for now
        df = pd.read_excel(r'c:\Users\Пользователь\Desktop\plittex-erp\Price_март2026.xlsx', sheet_name=sheet, nrows=50)
        print(f"\nSheet {sheet}:")
        print(df.to_string())

except Exception as e:
    print(f"Error: {e}")
