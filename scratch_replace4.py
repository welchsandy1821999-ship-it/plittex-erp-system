import re

path = r"c:\Users\Пользователь\Desktop\plittex-erp\public\js\inventory.js"

with open(path, "r", encoding="utf-8") as f:
    text = f.read()

target = """            new TomSelect(switchEl, {
                create: false,
                dropdownParent: 'body',"""

replacement = """            new TomSelect(switchEl, {
                plugins: ['clear_button'],
                create: false,
                dropdownParent: 'body',"""

new_text = text.replace(target, replacement)

if new_text != text:
    with open(path, "w", encoding="utf-8") as f:
        f.write(new_text)
    print("Success! plugins added.")
else:
    print("Failed to replace string. Trying regex fallback")
    # try normalize spaces
    def normalize_spaces(s):
        return re.sub(r'\s+', ' ', s).strip()
    
    pat = re.escape(normalize_spaces(target)).replace(r'\ ', r'\s+')
    if re.search(pat, text):
        new_text = re.sub(pat, replacement, text, count=1)
        with open(path, "w", encoding="utf-8") as f:
            f.write(new_text)
        print("Success! Replaced via regex.")
    else:
        print("Target absolutely not found!!!")
