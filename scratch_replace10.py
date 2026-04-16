import re

path = r"c:\Users\Пользователь\Desktop\plittex-erp\views\modules\sales.ejs"

with open(path, "r", encoding="utf-8") as f:
    text = f.read()

target = '<div id="sales-kanban-board" class="sales-kanban-board" style="display: none;">'
replacement = '<div id="sales-kanban-board" class="sales-kanban-board d-none">'

if target in text:
    text = text.replace(target, replacement)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    print("Fixed EJS.")
else:
    print("Target not found.")

