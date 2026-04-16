import os

js_path = r'c:\Users\Пользователь\Desktop\plittex-erp\public\js\sales.js'
with open(js_path, 'r', encoding='utf-8') as f:
    js_text = f.read()

js_target = """    // 🚀 Детализация себестоимости под итоговой суммой
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

js_rep = """    // 🚀 Детализация себестоимости под итоговой суммой
    const costBlock = document.getElementById('top-cart-cost-block');
    if (costBlock) {
        let bdHtml = '';
        const pKeys = Object.keys(productCostBreakdownMap);
        if (pKeys.length > 0 && totalProductionCost > 0) {
            bdHtml += `<div class="mt-10 mb-10 font-14 font-bold text-main">📊 Детализация рентабельности по позициям:</div>`;
            bdHtml += `<div class="flex-column gap-15">`;
            pKeys.forEach(key => {
                const b = productCostBreakdownMap[key];
                const p = productProfitMap[key] || {revenue:0, cost:0, tax:0, profit:0};
                
                bdHtml += `
                    <div class="p-15 bg-surface-alt border-radius-8" style="border: 1px solid var(--border-color);">
                        <div class="flex-between mb-10 pb-10 border-bottom">
                            <span class="font-bold font-14 text-primary">${key} <span class="text-muted font-normal ml-5">(${b.qty} шт)</span></span>
                            <div class="text-right">
                                <span class="font-12 text-muted block mb-5">Выручка со скидками: <strong class="text-main">${p.revenue.toLocaleString('ru-RU', {minimumFractionDigits:2, maximumFractionDigits:2})} ₽</strong></span>
                            </div>
                        </div>
                        
                        <div class="form-grid gap-10" style="grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));">
                            <div class="bg-surface p-10 border-radius-6 text-center" style="border: 1px solid var(--border-color);">
                                <div class="font-11 text-muted text-uppercase mb-5">Сырье и Материалы</div>
                                <div class="font-bold font-13">${b.matSum.toLocaleString('ru-RU', {minimumFractionDigits:2, maximumFractionDigits:2})} ₽</div>
                            </div>
                            <div class="bg-surface p-10 border-radius-6 text-center" style="border: 1px solid var(--border-color);">
                                <div class="font-11 text-muted text-uppercase mb-5">Сдельная ЗП</div>
                                <div class="font-bold font-13">${b.wageSum.toLocaleString('ru-RU', {minimumFractionDigits:2, maximumFractionDigits:2})} ₽</div>
                            </div>
                            <div class="bg-surface p-10 border-radius-6 text-center" style="border: 1px solid var(--border-color);">
                                <div class="font-11 text-muted text-uppercase mb-5">Амортизация</div>
                                <div class="font-bold font-13">${b.amortSum.toLocaleString('ru-RU', {minimumFractionDigits:2, maximumFractionDigits:2})} ₽</div>
                            </div>
                            <div class="bg-surface p-10 border-radius-6 text-center" style="border: 1px solid var(--border-color);">
                                <div class="font-11 text-warning font-bold text-uppercase mb-5">Оверхед + Налог</div>
                                <div class="font-bold font-13 text-warning">${(b.overSum + p.tax).toLocaleString('ru-RU', {minimumFractionDigits:2, maximumFractionDigits:2})} ₽</div>
                            </div>
                        </div>

                        <div class="flex-between mt-10 pt-10 align-center">
                            <span class="font-13 text-main">Себестоимость: <strong class="font-14">${b.costSum.toLocaleString('ru-RU', {minimumFractionDigits:2, maximumFractionDigits:2})} ₽</strong></span>
                            
                            <span class="font-15 font-bold px-10 py-5 border-radius-6" style="background: ${p.profit > 0 ? '#e8f5e9' : '#ffebee'}; color: ${p.profit > 0 ? '#2e7d32' : '#c62828'};">
                                Прибыль: ${p.profit > 0 ? '+' : ''}${p.profit.toLocaleString('ru-RU', {minimumFractionDigits:2, maximumFractionDigits:2})} ₽
                            </span>
                        </div>
                    </div>`;
            });
            bdHtml += `</div>`;
            
            // Также добавляем общий итог если товаров больше 1
            if (pKeys.length > 1) {
                 bdHtml += `<div class="p-15 mt-10 bg-surface border-radius-8 border-top" style="border-width: 2px;">
                    <div class="flex-between font-16 font-bold text-main">
                        <span>ВСЕГО ПРИБЫЛЬ ПО ЧЕКУ:</span>
                        <span style="color: ${netProfit > 0 ? '#2e7d32' : '#c62828'};">${netProfit > 0 ? '+' : ''}${netProfit.toLocaleString('ru-RU', {minimumFractionDigits:2, maximumFractionDigits:2})} ₽</span>
                    </div>
                 </div>`;
            }
        }

        let detailsEl = document.getElementById('cart-cost-details-breakdown');
        if (!detailsEl) {
            detailsEl = document.createElement('div');
            detailsEl.id = 'cart-cost-details-breakdown';
            costBlock.appendChild(detailsEl);
        }
        detailsEl.innerHTML = bdHtml;
    }"""

js_text = js_text.replace(js_target, js_rep)

with open(js_path, 'w', encoding='utf-8') as f:
    f.write(js_text)

print("done")
