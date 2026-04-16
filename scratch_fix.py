js_path = r'c:\Users\Пользователь\Desktop\plittex-erp\public\js\sales.js'
with open(js_path, 'r', encoding='utf-8') as f:
    js_text = f.read()

# I need to modify `cart.map` productCostBreakdownMap logic
js_target3 = """        // Развернутая агрегация себестоимости
        if (!productCostBreakdownMap[pKey]) productCostBreakdownMap[pKey] = {
            qty: 0, unitCost: unitCost,
            matSum: item.baseMatCost || 0, amortSum: item.amortization || 0, 
            overSum: currentOverhead, wageSum: item.wage || 0
        };
        productCostBreakdownMap[pKey].qty += qty;"""

js_rep3 = """        // Развернутая агрегация себестоимости
        if (!productCostBreakdownMap[pKey]) productCostBreakdownMap[pKey] = {
            qty: 0, costSum: 0, matSum: 0, amortSum: 0, overSum: 0, wageSum: 0
        };
        productCostBreakdownMap[pKey].qty += qty;
        productCostBreakdownMap[pKey].costSum += costSum;
        productCostBreakdownMap[pKey].matSum += qty * (parseFloat(item.baseMatCost) || 0);
        productCostBreakdownMap[pKey].amortSum += qty * (parseFloat(item.amortization) || 0);
        productCostBreakdownMap[pKey].overSum += qty * currentOverhead;
        productCostBreakdownMap[pKey].wageSum += qty * (parseFloat(item.wage) || 0);"""

js_text = js_text.replace(js_target3, js_rep3)

with open(js_path, 'w', encoding='utf-8') as f:
    f.write(js_text)

print("done")
