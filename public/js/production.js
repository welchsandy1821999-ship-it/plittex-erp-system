// === public/js/production.js ===

let defaultMixNorms = {};
window.currentMixTemplates = { big: [], small: [] };
let allProductsList = [];
let sessionProducts = [];

async function initProduction() {
    document.getElementById('prod-date-filter').valueAsDate = new Date();
    try {
        const resMix = await fetch('/api/mix-templates');
        defaultMixNorms = await resMix.json();
        window.currentMixTemplates = defaultMixNorms; 
        
        renderMixInputs();

        const resProd = await fetch('/api/products');
        allProductsList = await resProd.json();
        populateCategories();

        loadDailyHistory();
    } catch (e) { console.error(e); }
}

function renderMixInputs() {
    const bigArea = document.getElementById('big-mix-norms');
    bigArea.innerHTML = `
        <div style="text-align: right; margin-bottom: 10px;">
            <button class="btn btn-outline" style="padding: 4px 8px; font-size: 12px; border-color: #94a3b8; color: #475569;" onclick="editMixTemplate('big')">⚙️ Настроить шаблон</button>
        </div>
        ${defaultMixNorms.big.map((m, i) => `
            <div style="display:flex; justify-content:space-between; margin-bottom:8px; padding-bottom:4px; border-bottom:1px dashed #e2e8f0;">
                <span style="font-size:13px;">${m.name}:</span>
                <input type="number" class="big-norm-val" data-index="${i}" value="${m.qty}" oninput="autoCalculateQty()" style="width:70px; border:none; background:none; text-align:right; font-weight:bold; color:var(--primary);">
            </div>
        `).join('')}
    `;

    const smallArea = document.getElementById('small-mix-norms');
    smallArea.innerHTML = `
        <div style="text-align: right; margin-bottom: 10px;">
            <button class="btn btn-outline" style="padding: 4px 8px; font-size: 12px; border-color: #94a3b8; color: #475569;" onclick="editMixTemplate('small')">⚙️ Настроить шаблон</button>
        </div>
        ${defaultMixNorms.small.map((m, i) => `
            <div style="display:flex; justify-content:space-between; margin-bottom:8px; padding-bottom:4px; border-bottom:1px dashed #e2e8f0;">
                <span style="font-size:13px;">${m.name}:</span>
                <input type="number" class="small-norm-val" data-index="${i}" value="${m.qty}" oninput="autoCalculateQty()" style="width:70px; border:none; background:none; text-align:right; font-weight:bold; color:var(--primary);">
            </div>
        `).join('')}
    `;

    document.getElementById('big-mix-count').addEventListener('input', autoCalculateQty);
    document.getElementById('small-mix-count').addEventListener('input', autoCalculateQty);
    document.getElementById('small-mix-cement-qty').addEventListener('input', autoCalculateQty);
    document.getElementById('small-mix-dioxide').addEventListener('input', autoCalculateQty);
    document.getElementById('small-mix-pigment1-qty').addEventListener('input', autoCalculateQty);
    document.getElementById('small-mix-pigment2-qty').addEventListener('input', autoCalculateQty);
}

// === УМНОЕ КАСКАДНОЕ МЕНЮ ===
function populateCategories() {
    const categories = [...new Set(allProductsList.map(p => p.category || 'Без категории'))];
    const catSelect = document.getElementById('prod-category-select');
    catSelect.innerHTML = '<option value="" disabled selected>-- Категория --</option>';
    categories.forEach(c => catSelect.add(new Option(c, c)));
}

function filterProductsByCategory() {
    const selectedCat = document.getElementById('prod-category-select').value;
    const itemSelect = document.getElementById('prod-item-select');
    itemSelect.innerHTML = '';

    const filtered = allProductsList.filter(p => (p.category || 'Без категории') === selectedCat);
    filtered.forEach(p => itemSelect.add(new Option(p.name, p.id)));

    if (filtered.length > 0) {
        itemSelect.selectedIndex = 0;
        autoCalculateQty(); 
    } else {
        document.getElementById('prod-item-qty').value = '';
    }
}

// === АВТОРАСЧЕТ ОБЪЕМА ===
async function autoCalculateQty() {
    const select = document.getElementById('prod-item-select');
    const qtyInput = document.getElementById('prod-item-qty');
    const productId = select?.value;
    if (!productId) return;

    const bigCount = parseFloat(document.getElementById('big-mix-count').value) || 0;
    const smallCount = parseFloat(document.getElementById('small-mix-count').value) || 0;
    let totalWeight = 0;

    document.querySelectorAll('.big-norm-val').forEach(inp => totalWeight += (parseFloat(inp.value) || 0) * bigCount);

    totalWeight += (parseFloat(document.getElementById('small-mix-cement-qty').value) || 0) * smallCount;
    document.querySelectorAll('.small-norm-val').forEach(inp => totalWeight += (parseFloat(inp.value) || 0) * smallCount);

    totalWeight += (parseFloat(document.getElementById('small-mix-dioxide').value) || 0) * smallCount;
    totalWeight += (parseFloat(document.getElementById('small-mix-pigment1-qty').value) || 0) * smallCount;
    totalWeight += (parseFloat(document.getElementById('small-mix-pigment2-qty').value) || 0) * smallCount;

    if (totalWeight === 0) { qtyInput.value = ''; return; }

    try {
        const res = await fetch(`/api/recipes/${productId}`);
        const recipe = await res.json();
        let unitWeight = 0;
        recipe.forEach(ing => unitWeight += parseFloat(ing.quantity_per_unit) || 0);

        if (unitWeight > 0) qtyInput.value = (totalWeight / unitWeight).toFixed(2);
    } catch (e) { console.error(e); }
}

// === ДОБАВЛЕНИЕ В СЕССИЮ ===
function addProdToSession() {
    const select = document.getElementById('prod-item-select');
    const qtyInput = document.getElementById('prod-item-qty');
    const qty = parseFloat(qtyInput.value);

    // ИСПОЛЬЗУЕМ UI.toast ВМЕСТО alert
    if (select.selectedIndex === -1 || !qty || qty <= 0) return UI.toast('Укажите товар и объем!', 'error');

    sessionProducts.push({ id: select.value, name: select.options[select.selectedIndex].text, qty: qty });
    renderSessionProducts();

    qtyInput.value = '';
}

function renderSessionProducts() {
    const list = document.getElementById('session-products-list');
    if (sessionProducts.length === 0) {
        list.innerHTML = '<div style="color: var(--text-muted); font-size: 13px; text-align: center; padding: 15px; border: 1px dashed #cbd5e1; border-radius: 6px;">Список пуст. Добавьте продукцию...</div>';
        return;
    }
    list.innerHTML = sessionProducts.map((p, index) => `
        <div style="display:flex; justify-content:space-between; align-items:center; background: #fff; padding: 12px 15px; border: 1px solid var(--border); border-left: 4px solid var(--primary); border-radius: 6px;">
            <span style="font-weight:600;">${p.name} <span style="color:var(--text-muted); font-weight:normal;">(${p.qty} ед.)</span></span>
            <button class="btn btn-outline" style="color:var(--danger); padding:4px 8px; border-color:var(--danger);" onclick="removeProdFromSession(${index})">Удалить</button>
        </div>
    `).join('');
}

function removeProdFromSession(index) {
    sessionProducts.splice(index, 1);
    renderSessionProducts();
}

// === ОТПРАВКА НА СЕРВЕР ===
async function submitDailyProduction() {
    const date = document.getElementById('prod-date-filter').value;
    const bigMixCount = parseFloat(document.getElementById('big-mix-count').value) || 0;
    const smallMixCount = parseFloat(document.getElementById('small-mix-count').value) || 0;

    // ИСПОЛЬЗУЕМ UI.toast ВМЕСТО alert
    if (bigMixCount === 0 && smallMixCount === 0) return UI.toast('Укажите количество замесов!', 'error');
    if (sessionProducts.length === 0) return UI.toast('Добавьте продукцию к выпуску!', 'error');

    const bigMixes = Array.from(document.querySelectorAll('.big-norm-val')).map(input => ({
        name: defaultMixNorms.big[input.dataset.index].name,
        qty: (parseFloat(input.value) || 0) * bigMixCount
    }));

    const smallMixes = [];
    smallMixes.push({
        name: document.getElementById('small-mix-cement').value === 'white' ? 'Белый цемент' : 'Цемент М-600',
        qty: (parseFloat(document.getElementById('small-mix-cement-qty').value) || 0) * smallMixCount
    });
    document.querySelectorAll('.small-norm-val').forEach(input => {
        smallMixes.push({ name: defaultMixNorms.small[input.dataset.index].name, qty: (parseFloat(input.value) || 0) * smallMixCount });
    });

    const dioxideQty = parseFloat(document.getElementById('small-mix-dioxide').value) || 0;
    if (dioxideQty > 0) smallMixes.push({ name: 'Диоксид титана', qty: dioxideQty * smallMixCount });

    const p1Color = document.getElementById('small-mix-pigment1-color').value;
    const p1Qty = parseFloat(document.getElementById('small-mix-pigment1-qty').value) || 0;
    if (p1Color && p1Qty > 0) smallMixes.push({ name: `Пигмент ${p1Color}`, qty: p1Qty * smallMixCount });

    const p2Color = document.getElementById('small-mix-pigment2-color').value;
    const p2Qty = parseFloat(document.getElementById('small-mix-pigment2-qty').value) || 0;
    if (p2Color && p2Qty > 0) smallMixes.push({ name: `Пигмент ${p2Color}`, qty: p2Qty * smallMixCount });

    try {
        const res = await fetch('/api/production/daily', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ date, bigMixes, smallMixes, products: sessionProducts })
        });

        if (res.ok) {
            UI.toast('Формовка успешно сохранена!', 'success');
            
            document.getElementById('big-mix-count').value = 0;
            document.getElementById('small-mix-count').value = 0;
            document.getElementById('small-mix-dioxide').value = 0;
            document.getElementById('small-mix-pigment1-qty').value = 0;
            document.getElementById('small-mix-pigment2-qty').value = 0;
            document.getElementById('small-mix-pigment1-color').selectedIndex = 0;
            document.getElementById('small-mix-pigment2-color').selectedIndex = 0;

            sessionProducts = []; renderSessionProducts(); document.getElementById('prod-item-qty').value = '';
            loadDailyHistory(); 
            if(typeof loadTable === 'function') loadTable();
        } else {
            UI.toast('Ошибка: ' + await res.text(), 'error');
        }
    } catch (e) { console.error(e); }
}

// === ИСТОРИЯ И ДЕТАЛИЗАЦИЯ ===
async function loadDailyHistory() {
    const date = document.getElementById('prod-date-filter').value;
    const tbody = document.getElementById('daily-history-table');
    try {
        const res = await fetch(`/api/production/history?date=${date}`);
        const data = await res.json();
        if (data.length === 0) return tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">В этот день формовок не было.</td></tr>';

        tbody.innerHTML = data.map(b => `
            <tr id="row-${b.id}" style="cursor: pointer; transition: 0.2s;" onmouseover="this.style.backgroundColor='#f1f5f9'" onmouseout="this.style.backgroundColor=''">
                <td onclick="toggleBatchDetails(${b.id})"><strong style="color:var(--primary); border-bottom:1px dashed var(--primary);">${b.batch_number}</strong> 👁️</td>
                <td onclick="toggleBatchDetails(${b.id})">${b.product_name}</td>
                <td onclick="toggleBatchDetails(${b.id})">${parseFloat(b.planned_quantity).toFixed(2)}</td>
                <td onclick="toggleBatchDetails(${b.id})">${parseFloat(b.mat_cost_total).toFixed(2)} ₽</td>
                <td style="text-align: right;"><button class="btn btn-outline" style="color: var(--danger); padding: 5px 10px;" onclick="deleteBatch(${b.id}, '${b.batch_number}')">❌</button></td>
            </tr>
        `).join('');
    } catch (e) { console.error(e); }
}

async function toggleBatchDetails(batchId) {
    const existingRow = document.getElementById(`details-${batchId}`);
    if (existingRow) { existingRow.remove(); return; } 

    try {
        const res = await fetch(`/api/production/batch/${batchId}/materials`);
        const materials = await res.json();

        const totalCost = materials.reduce((sum, m) => sum + parseFloat(m.cost), 0);
        const plannedQty = parseFloat(materials[0]?.planned_quantity) || 1;
        const perUnitTotal = (totalCost / plannedQty).toFixed(2);

        let html = `<td colspan="5" style="padding: 0; background: #f8fafc; border-bottom: 2px solid var(--primary);">
            <div style="padding: 20px; box-shadow: inset 0 3px 6px -3px rgba(0,0,0,0.1);">
                <h4 style="margin-top: 0; color: var(--text-main); font-size: 14px; margin-bottom: 12px;">📋 Фактическое списание сырья (Доля партии от общих замесов смены)</h4>
                
                <table style="width: 100%; background: #fff; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; font-size: 13px;">
                    <thead style="background: #f1f5f9; color: var(--text-muted);">
                        <tr>
                            <th style="padding: 10px 15px; text-align: left; border-bottom: 1px solid var(--border);">Сырье</th>
                            <th style="padding: 10px 15px; text-align: right; border-bottom: 1px solid var(--border);">
                                Израсходовано<br>
                                <span style="font-size: 11px; color: var(--primary); font-weight: normal;">На 1 ед. продукции</span>
                            </th>
                            <th style="padding: 10px 15px; text-align: right; border-bottom: 1px solid var(--border);">
                                Сумма (₽)<br>
                                <span style="font-size: 11px; color: var(--primary); font-weight: normal;">На 1 ед. продукции</span>
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        ${materials.map(m => {
                            const pQty = (m.qty / plannedQty).toFixed(4);
                            const pCost = (m.cost / plannedQty).toFixed(2);
                            return `
                            <tr>
                                <td style="padding: 10px 15px; border-bottom: 1px solid var(--border);"><strong>${m.name}</strong></td>
                                <td style="padding: 10px 15px; text-align: right; border-bottom: 1px solid var(--border);">
                                    <div style="color: var(--primary); font-weight: 600;">${parseFloat(m.qty).toFixed(2)} ${m.unit}</div>
                                    <div style="font-size: 11px; color: var(--text-muted);">${pQty} ${m.unit}/ед</div>
                                </td>
                                <td style="padding: 10px 15px; text-align: right; border-bottom: 1px solid var(--border);">
                                    <div style="font-weight: 600;">${parseFloat(m.cost).toFixed(2)} ₽</div>
                                    <div style="font-size: 11px; color: var(--text-muted);">${pCost} ₽/ед</div>
                                </td>
                            </tr>
                            `;
                        }).join('')}
                        <tr>
                            <td colspan="2" style="padding: 12px 15px; text-align: right; font-weight: bold; background: #fafafa; font-size: 14px;">ИТОГО СЕБЕСТОИМОСТЬ:</td>
                            <td style="padding: 12px 15px; text-align: right; font-weight: bold; color: var(--danger); background: #fafafa; font-size: 14px;">
                                ${totalCost.toFixed(2)} ₽
                                <div style="font-size: 11px; font-weight: normal; color: var(--text-muted); margin-top: 4px;">Себестоимость 1 ед: ${perUnitTotal} ₽</div>
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </td>`;

        const newTr = document.createElement('tr');
        newTr.id = `details-${batchId}`;
        newTr.innerHTML = html;
        const parentTr = document.getElementById(`row-${batchId}`);
        parentTr.parentNode.insertBefore(newTr, parentTr.nextSibling);
    } catch (e) { console.error(e); }
}

// === ИСПОЛЬЗУЕМ КРАСИВОЕ ОКНО ДЛЯ ПОДТВЕРЖДЕНИЯ УДАЛЕНИЯ ===
window.deleteBatch = function(id, batchNumber) {
    const html = `
        <p style="font-size: 15px;">Вы уверены, что хотите отменить формовку партии <strong style="color: var(--primary);">${batchNumber}</strong>?</p>
        <p style="font-size: 13px; color: var(--danger); margin-top: 10px; background: #fef2f2; padding: 10px; border-radius: 6px;">
            ⚠️ <b>Внимание:</b> Все списанные материалы будут возвращены на склад сырья, а эта партия удалена из истории.
        </p>
    `;
    const buttons = `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-red" onclick="confirmDeleteBatch(${id})">🗑️ Да, отменить</button>
    `;
    UI.showModal('Удаление партии', html, buttons);
};

window.confirmDeleteBatch = async function(id) {
    try {
        const res = await fetch(`/api/production/batch/${id}`, { method: 'DELETE' });
        if (res.ok) { 
            UI.closeModal();
            UI.toast('Партия успешно удалена, материалы возвращены', 'success');
            loadDailyHistory(); 
            if(typeof loadTable === 'function') loadTable(); 
        } else {
            UI.toast('Ошибка при удалении партии', 'error');
        }
    } catch (e) { console.error(e); }
};

// === НАСТРОЙКА ШАБЛОНОВ ЗАМЕСА ПО УМОЛЧАНИЮ ===
window.editMixTemplate = function(type) {
    const title = type === 'big' ? 'Большой замес (Серый)' : 'Малый замес (Цветной)';
    const template = window.currentMixTemplates[type] || [];
    
    let rowsHtml = '';
    template.forEach((item) => {
        rowsHtml += `
            <div class="form-grid template-row" style="grid-template-columns: 2fr 1fr 1fr auto; margin-bottom: 10px; align-items: end;">
                <div class="form-group"><label style="font-size:11px;">Сырье</label><input type="text" class="input-modern tpl-name" value="${item.name}"></div>
                <div class="form-group"><label style="font-size:11px;">Кол-во</label><input type="number" step="0.01" class="input-modern tpl-qty" value="${item.qty}"></div>
                <div class="form-group"><label style="font-size:11px;">Ед. изм.</label><input type="text" class="input-modern tpl-unit" value="${item.unit}"></div>
                <button class="btn btn-outline" style="border-color: var(--danger); color: var(--danger); padding: 10px;" onclick="this.parentElement.remove()">🗑️</button>
            </div>
        `;
    });

    const html = `
        <p style="font-size: 13px; color: var(--text-muted); margin-top: 0;">Измените сырье или пропорции. Эти данные будут автоматически подставляться в таблицу замесов.</p>
        <div id="template-rows-container">${rowsHtml}</div>
        <button class="btn btn-outline" style="width: 100%; margin-top: 10px; border-style: dashed; color: var(--primary);" onclick="addTemplateRow()">➕ Добавить строку</button>
    `;

    const buttons = `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-blue" onclick="saveMixTemplate('${type}')">💾 Сохранить шаблон</button>
    `;

    UI.showModal(`⚙️ Настройка: ${title}`, html, buttons);
};

window.addTemplateRow = function() {
    const container = document.getElementById('template-rows-container');
    const div = document.createElement('div');
    div.className = 'form-grid template-row';
    div.style.cssText = 'grid-template-columns: 2fr 1fr 1fr auto; margin-bottom: 10px; align-items: end;';
    div.innerHTML = `
        <div class="form-group"><input type="text" class="input-modern tpl-name" placeholder="Название сырья"></div>
        <div class="form-group"><input type="number" step="0.01" class="input-modern tpl-qty" placeholder="0"></div>
        <div class="form-group"><input type="text" class="input-modern tpl-unit" value="кг"></div>
        <button class="btn btn-outline" style="border-color: var(--danger); color: var(--danger); padding: 10px;" onclick="this.parentElement.remove()">🗑️</button>
    `;
    container.appendChild(div);
};

window.saveMixTemplate = async function(type) {
    const rows = document.querySelectorAll('.template-row');
    const newTemplate = [];
    
    rows.forEach(row => {
        const name = row.querySelector('.tpl-name').value.trim();
        const qty = parseFloat(row.querySelector('.tpl-qty').value) || 0;
        const unit = row.querySelector('.tpl-unit').value.trim();
        if (name && qty > 0) newTemplate.push({ name, qty, unit });
    });

    const fullData = { 
        ...window.currentMixTemplates, 
        [type]: newTemplate 
    };

    try {
        const res = await fetch('/api/mix-templates', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(fullData)
        });
        
        if (res.ok) {
            UI.closeModal();
            UI.toast('Шаблон замеса успешно обновлен!', 'success');
            initProduction(); 
        }
    } catch(e) { console.error(e); }
};