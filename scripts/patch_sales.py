import sys
import re

file_path = r'c:\Users\Пользователь\Desktop\plittex-erp\public\js\sales.js'
with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# Pattern 1:
# const res = await fetch(URL);
# const data = await res.json();
# -> const data = await API.get(URL);
# We need to capture the variable names and the URL.
pattern1 = r'const\s+([a-zA-Z0-9_]+)\s*=\s*await\s+fetch\(([^)]+)\);\s*const\s+([a-zA-Z0-9_]+)\s*=\s*await\s+\1\.json\(\);'
def repl1(match):
    res_var = match.group(1)
    url = match.group(2)
    data_var = match.group(3)
    return f'const {data_var} = await API.get({url});'

new_content = re.sub(pattern1, repl1, content)


# Pattern 2: (No data assignment right after)
# const res = await fetch(URL);
# if (res.ok) { const result = await res.json(); ... }
# -> we skip these by only targeting simple GETs for now

with open(file_path, 'w', encoding='utf-8') as f:
    f.write(new_content)

print("Patch applied for simple GETs!")
