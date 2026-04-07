import csv

csv_file = r'c:\Users\Пользователь\Desktop\plittex-erp\ревизия_склада_март2026.csv'
try:
    with open(csv_file, 'r', encoding='utf-8-sig') as f:
        reader = csv.reader(f, delimiter=';')
        next(reader) 
        for i, row in enumerate(reader):
            if i < 15 or "сорт" in row[0].lower():
                print(row[0])
            if i > 50: break
except Exception as e:
    print(f"Error: {e}")
