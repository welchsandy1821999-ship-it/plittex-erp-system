import re

js_path = r"c:\Users\Пользователь\Desktop\plittex-erp\public\js\sales.js"
with open(js_path, "r", encoding="utf-8") as f:
    text = f.read()

dead_funcs = [
    'setHistoryDateRange', 'toggleDeliveryType', 'openPoaManager', 
    'onSalesProductChange', 'triggerSalesSearch'
]

# We will remove their blocks using an atomic trick.
# Since these are window.FuncName = function(...) { ... }; 
# we can use regex to remove them safely if they are strictly defined that way.
for func in dead_funcs:
    # A simple but dangerous way, let's just log them out instead of regex replacing it blindly
    # to avoid brace counting mismatches. I will manually replace them using multi_replace.
    pass
