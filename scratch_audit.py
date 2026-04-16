import re

paths = [
    r"c:\Users\Пользователь\Desktop\plittex-erp\public\js\sales.js",
    r"c:\Users\Пользователь\Desktop\plittex-erp\views\modules\sales.ejs"
]

for path in paths:
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()
    
    print(f"=== {path} ===")
    
    # Check for hardcoded colors in styles
    matches = re.finditer(r'style=[\'"]([^\'"]+)[\'"]', text)
    count = 0
    for m in matches:
        style_content = m.group(1).lower()
        if 'color' in style_content or 'background' in style_content:
            # Maybe hardcoded color issue for dark mode
            print(f"Inline color style: {style_content}")
            count += 1
    
    print(f"Found {count} inline color styles.", end="\n\n")

    # Check for dead functions or broken logic hooks
    # ...
