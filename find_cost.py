with open(r'c:\Users\Пользователь\Desktop\plittex-erp\public\js\sales.js', 'r', encoding='utf8') as f:
    lines = f.readlines()
for i, line in enumerate(lines):
    if "const costEl = document.getElementById('cart-total-cost');" in line:
        start = max(0, i - 5)
        for j in range(start, i + 30):
            print(lines[j], end='')
        break
