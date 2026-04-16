import re

path = r"c:\Users\Пользователь\Desktop\plittex-erp\public\js\sales.js"

with open(path, "r", encoding="utf-8") as f:
    text = f.read()

target = """        if (clientBalance > 0) {
            clientBalanceBadge = `<div class="sales-balance-badge balance-overpaid">💰 Переплата (Аванс): +${clientBalance.toLocaleString('ru-RU')} ₽</div>`;
        } else if (clientBalance < 0) {
            clientBalanceBadge = `<div class="sales-balance-badge balance-debt">📉 Общий долг: ${Math.abs(clientBalance).toLocaleString('ru-RU')} ₽</div>`;
        }"""

replacement = """        if (clientBalance < 0) {
            clientBalanceBadge = `<div class="sales-balance-badge balance-overpaid">💰 Переплата (Аванс): +${Math.abs(clientBalance).toLocaleString('ru-RU')} ₽</div>`;
        } else if (clientBalance > 0) {
            clientBalanceBadge = `<div class="sales-balance-badge balance-debt">📉 Общий долг: ${clientBalance.toLocaleString('ru-RU')} ₽</div>`;
        }"""

if target in text:
    text = text.replace(target, replacement)
    
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    print("Success! UI logic fixed.")
else:
    print("Target not found. Let's try flexible search.")
    # More flexible regex to find the two if statements
    target2Regex = re.compile(r"if\s*\(\s*clientBalance\s*>\s*0\s*\)\s*\{\s*clientBalanceBadge[^}]+}\s*else\s*if\s*\(\s*clientBalance\s*<\s*0\s*\)\s*\{[^}]+}")
    
    matches = target2Regex.findall(text)
    if matches:
        print("Found with regex!")
        new_text = target2Regex.sub(replacement, text)
        with open(path, "w", encoding="utf-8") as f:
            f.write(new_text)
    else:
         print("Absolutely not found!")
