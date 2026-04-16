import re

js_path = r"c:\Users\Пользователь\Desktop\plittex-erp\public\js\sales.js"
with open(js_path, "r", encoding="utf-8") as f:
    text = f.read()

# Remove setHistoryDateRange
target1_start = text.find("window.setHistoryDateRange = function")
if target1_start != -1:
    target1_end = text.find("};\n", target1_start) + 3
    if target1_end > target1_start:
        text = text[:target1_start] + text[target1_end:]
        print("Removed setHistoryDateRange")

# Remove toggleDeliveryType
target2_start = text.find("window.toggleDeliveryType = function")
if target2_start != -1:
    target2_end = text.find("};\n", target2_start) + 3
    if target2_end > target2_start:
        text = text[:target2_start] + text[target2_end:]
        print("Removed toggleDeliveryType")

# Remove triggerSalesSearch
target3_start = text.find("window.triggerSalesSearch = function")
if target3_start != -1:
    target3_end = text.find("};\n", target3_start) + 3
    if target3_end > target3_start:
        text = text[:target3_start] + text[target3_end:]
        print("Removed triggerSalesSearch")

with open(js_path, "w", encoding="utf-8") as f:
    f.write(text)

print("Modifications done!")
