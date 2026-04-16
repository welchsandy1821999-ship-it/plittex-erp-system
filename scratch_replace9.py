import re

path = r"c:\Users\Пользователь\Desktop\plittex-erp\public\js\sales.js"

with open(path, "r", encoding="utf-8") as f:
    text = f.read()

count = text.count("escapeHTML(")
if count > 0:
    new_text = text.replace("escapeHTML(", "Utils.escapeHtml(")
    with open(path, "w", encoding="utf-8") as f:
        f.write(new_text)
    print(f"Success! Replaced {count} instances of escapeHTML.")
else:
    print("No instances found.")
