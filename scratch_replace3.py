import re

path = r"c:\Users\Пользователь\Desktop\plittex-erp\public\js\inventory.js"

with open(path, "r", encoding="utf-8") as f:
    text = f.read()

target = """                score: function (search) {
                    var score = this.getScoreFunction(search);
                    return function (item) {"""

replacement = """                score: function (search) {
                    if (!search) return function() { return 1; };
                    var score = this.getScoreFunction(search);
                    return function (item) {"""

new_text = text.replace(target, replacement)

if new_text != text:
    with open(path, "w", encoding="utf-8") as f:
        f.write(new_text)
    print("Success! Empty search score fixed.")
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
