import re

path = r"c:\Users\Пользователь\Desktop\plittex-erp\views\modules\inventory.ejs"

with open(path, "r", encoding="utf-8") as f:
    text = f.read()

target = '<select id="history-item-switch" class="input-modern w-100" placeholder="🔍 Введите товар..." onchange="switchHistoryItem()"></select>'
replacement = '<select id="history-item-switch" class="w-100" style="width: 100%;" placeholder="🔍 Введите товар..." onchange="switchHistoryItem()"></select>'

new_text = text.replace(target, replacement)

if new_text != text:
    with open(path, "w", encoding="utf-8") as f:
        f.write(new_text)
    print("Success! input-modern removed from HTML.")
else:
    print("Failed to replace exact HTML. Trying regex...")
    target_clean = target.strip()
    pat = re.escape(target_clean).replace(r'\ ', r'\s+')
    if re.search(pat, text):
        new_text = re.sub(pat, replacement, text, count=1)
        with open(path, "w", encoding="utf-8") as f:
            f.write(new_text)
        print("Success! Replaced via HTML regex.")
    else:
        print("Could not find HTML element.")
