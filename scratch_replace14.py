import re

path = r'c:\Users\Пользователь\Desktop\plittex-erp\public\js\sales.js'
with open(path, 'r', encoding='utf-8') as f:
    text = f.read()

target = """    const taxCost = finalProductRevenue * (safeTaxPct / 100);
    const netProfit = finalProductRevenue - totalProductionCost - taxCost;
    
    const costEl = document.getElementById('cart-total-cost');
    if (costEl) costEl.innerText = totalProductionCost.toLocaleString('ru-RU', { minimumFractionDigits: 2 });"""

replacement = """    const taxCost = finalProductRevenue * (safeTaxPct / 100);
    const netProfit = finalProductRevenue - totalProductionCost - taxCost;
    
    const costEl = document.getElementById('cart-total-cost');
    if (costEl) costEl.innerText = totalProductionCost.toLocaleString('ru-RU', { minimumFractionDigits: 2 });

    // 🚀 Детализация себестоимости под итоговой суммой
    const costBlock = document.getElementById('top-cart-cost-block');
    if (costBlock) {
        let bdHtml = '';
        const pKeys = Object.keys(productCostBreakdownMap);
        if (pKeys.length > 0 && totalProductionCost > 0) {
            bdHtml += `<div class="mt-10 mb-5 font-13 font-bold text-main">В том числе:</div>`;
            bdHtml += `<div class="flex-column gap-5">`;
            pKeys.forEach(key => {
                const b = productCostBreakdownMap[key];
                const parts = [];
                if (b.matSum > 0) parts.push(`Материалы: ${b.matSum.toFixed(2)}`);
                if (b.wageSum > 0) parts.push(`Сдельщина: ${b.wageSum.toFixed(2)}`);
                if (b.amortSum > 0) parts.push(`Аморт.: ${b.amortSum.toFixed(2)}`);
                if (b.overSum > 0) parts.push(`Накладные: ${b.overSum.toFixed(2)}`);
                const partsStr = parts.length > 0 ? parts.join(', ') : 'Вручную';

                bdHtml += `
                    <div class="flex-between font-12 bg-surface-alt p-10 border-radius-6">
                        <div>
                            <span class="text-main font-bold d-block">${key} <span class="text-muted font-normal">(${b.qty} шт)</span></span>
                            <span class="text-muted font-11">${partsStr}</span>
                        </div>
                        <strong class="text-main">${b.costSum.toFixed(2)} ₽</strong>
                    </div>`;
            });
            bdHtml += `</div>`;
        }

        let detailsEl = document.getElementById('cart-cost-details-breakdown');
        if (!detailsEl) {
            detailsEl = document.createElement('div');
            detailsEl.id = 'cart-cost-details-breakdown';
            costBlock.appendChild(detailsEl);
        }
        detailsEl.innerHTML = bdHtml;
    }"""

text = text.replace(target, replacement)
with open(path, 'w', encoding='utf-8') as f:
    f.write(text)
print("Modifications done")
