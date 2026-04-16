import os

ejs_path = r'c:\Users\Пользователь\Desktop\plittex-erp\views\modules\sales.ejs'
with open(ejs_path, 'r', encoding='utf-8') as f:
    ejs_text = f.read()

ejs_target = """                <!-- 🚀 Блок себестоимости -->
                <div class="mt-15 pt-15 border-top" id="top-cart-cost-block">
                    <div class="flex-between font-14 text-muted mb-0">
                        <span>Общая себестоимость продукции:</span>
                        <strong><span id="cart-total-cost">0</span> ₽</strong>
                    </div>
                </div>"""

ejs_replacement = """                <!-- 🚀 Блок себестоимости -->
                <div class="mt-15 pt-15 border-top" id="top-cart-cost-block">
                    <div class="flex-between font-14 text-muted mb-0 align-center">
                        <span class="d-flex align-center gap-10">
                            Общая себестоимость:
                            <label class="cursor-pointer font-12 flex-row align-center m-0" style="color: #666; background: #eee; padding: 2px 8px; border-radius: 4px;">
                                <input type="checkbox" id="cart-include-finance" checked class="mr-5" onchange="if(window.renderCart) window.renderCart()">
                                ⚙️ Налоги + Оверхед
                            </label>
                        </span>
                        <strong><span id="cart-total-cost">0</span> ₽</strong>
                    </div>
                </div>"""

if ejs_target in ejs_text:
    ejs_text = ejs_text.replace(ejs_target, ejs_replacement)
    with open(ejs_path, 'w', encoding='utf-8') as f:
        f.write(ejs_text)


js_path = r'c:\Users\Пользователь\Desktop\plittex-erp\public\js\sales.js'
with open(js_path, 'r', encoding='utf-8') as f:
    js_text = f.read()

# I need to modify `renderCart` logic
# 1. safeTaxPct logic
js_target1 = """    const safeTaxPct = parseFloat(window.FINANCE_TAX_PERCENT) || 0;"""
js_rep1 = """    const useFinance = document.getElementById('cart-include-finance')?.checked !== false;
    const safeTaxPct = useFinance ? (parseFloat(window.FINANCE_TAX_PERCENT) || 0) : 0;"""

js_text = js_text.replace(js_target1, js_rep1)

# 2. Inside `cart.map`
js_target2 = """        const unitCost = parseFloat(item.unitCost) || 0;"""
js_rep2 = """        const currentOverhead = useFinance ? (parseFloat(item.overhead) || 0) : 0;
        const unitCost = (parseFloat(item.baseMatCost) || 0) + (parseFloat(item.amortization) || 0) + (parseFloat(item.wage) || 0) + currentOverhead;"""

js_text = js_text.replace(js_target2, js_rep2)

# 3. Inside the breakdown map
js_target3 = """        if (!productCostBreakdownMap[pKey]) productCostBreakdownMap[pKey] = {
            qty: 0, unitCost: item.unitCost || 0,
            matSum: item.baseMatCost || 0, amortSum: item.amortization || 0, 
            overSum: item.overhead || 0, wageSum: item.wage || 0
        };"""
js_rep3 = """        if (!productCostBreakdownMap[pKey]) productCostBreakdownMap[pKey] = {
            qty: 0, unitCost: unitCost,
            matSum: item.baseMatCost || 0, amortSum: item.amortization || 0, 
            overSum: currentOverhead, wageSum: item.wage || 0
        };"""

js_text = js_text.replace(js_target3, js_rep3)

with open(js_path, 'w', encoding='utf-8') as f:
    f.write(js_text)

print("done")
