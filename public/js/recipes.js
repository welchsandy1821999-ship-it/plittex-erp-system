let currentRecipe = [];
let currentRecipeMaterials = [];

function loadRecipeModuleData() {
    fetch('/api/items?limit=2000&filter=products').then(res => res.json()).then(res => {
        const sel = document.getElementById('recipe-product-select');
        sel.innerHTML = '<option value="" selected disabled>-- Раскройте список и выберите продукцию --</option>';
        const grouped = {};
        res.data.forEach(p => { const c = p.category || 'Без категории'; if(!grouped[c]) grouped[c] = []; grouped[c].push(p); });
        for(let cat in grouped) {
            let group = document.createElement('optgroup'); group.label = `📂 ${cat}`;
            grouped[cat].forEach(p => { let opt = document.createElement('option'); opt.value = p.id; opt.text = p.name; group.appendChild(opt); });
            sel.appendChild(group);
        }
    });

    fetch('/api/items?limit=500&filter=materials').then(res => res.json()).then(res => {
        currentRecipeMaterials = res.data;
        const matSel = document.getElementById('recipe-material-select');
        matSel.innerHTML = '';
        res.data.forEach(m => {
            const priceStr = m.current_price ? `${m.current_price} ₽` : 'Цена не указана!';
            matSel.innerHTML += `<option value="${m.id}" data-price="${m.current_price || 0}" data-unit="${m.unit}">${m.name} (${priceStr} за ${m.unit})</option>`;
        });
    });
}

function loadRecipeDetails() {
    const sel = document.getElementById('recipe-product-select');
    const prodId = sel.value;
    const prodName = sel.options[sel.selectedIndex].text;
    if(!prodId) return;
    
    document.getElementById('recipe-editor-area').style.display = 'block';
    document.getElementById('recipe-editor-title').innerText = `📝 Настройка рецепта: ${prodName}`;

    fetch('/api/recipes/' + prodId).then(res => res.json()).then(data => {
        currentRecipe = data.map(r => ({ materialId: r.material_id, name: r.material_name, qty: parseFloat(r.quantity_per_unit), unit: r.unit, price: parseFloat(r.current_price) || 0 }));
        renderRecipeTable();
    });
}

function addRecipeRow() {
    const matSelect = document.getElementById('recipe-material-select');
    const qty = parseFloat(document.getElementById('recipe-qty').value);
    if (!qty || matSelect.selectedIndex === -1) return alert('Укажите количество!');
    
    const opt = matSelect.options[matSelect.selectedIndex];
    const matId = matSelect.value;
    const matName = opt.text.split(' (')[0]; 
    const price = parseFloat(opt.getAttribute('data-price')) || 0;
    const unit = opt.getAttribute('data-unit');
    
    const existing = currentRecipe.find(r => r.materialId == matId);
    if (existing) existing.qty += qty; else currentRecipe.push({ materialId: matId, name: matName, qty: qty, unit: unit, price: price }); 
    
    document.getElementById('recipe-qty').value = ''; 
    renderRecipeTable();
}

function updateRecipeQty(index, newQty) {
    currentRecipe[index].qty = parseFloat(newQty) || 0;
    renderRecipeTable(); 
}

function renderRecipeTable() {
    const tbody = document.getElementById('recipe-table-body');
    tbody.innerHTML = '';
    let totalCost = 0;

    currentRecipe.forEach((r, index) => {
        const rowCost = r.qty * r.price; 
        totalCost += rowCost;
        tbody.innerHTML += `<tr><td><strong style="color: var(--text-main);">${r.name}</strong></td><td><input type="number" class="input-modern" style="width: 100px; padding: 6px;" value="${r.qty}" step="0.001" onchange="updateRecipeQty(${index}, this.value)"></td><td style="color: var(--text-muted);">${r.unit}</td><td>${r.price.toFixed(2)} ₽</td><td style="font-weight: 600; color: var(--primary);">${rowCost.toFixed(2)} ₽</td><td style="text-align: right;"><button class="btn btn-outline" style="padding: 6px 10px; color: var(--danger);" onclick="currentRecipe.splice(${index}, 1); renderRecipeTable();" title="Удалить">❌</button></td></tr>`;
    });
    document.getElementById('recipe-total-cost').innerText = `${totalCost.toFixed(2)} ₽`;
}

function saveRecipe(force) {
    const sel = document.getElementById('recipe-product-select');
    const prodId = sel.value; const prodName = sel.options[sel.selectedIndex].text;
    const btn = document.getElementById('recipe-save-btn');
    btn.innerText = '⏳ Проверка и сохранение...'; btn.disabled = true;
    
    fetch('/api/recipes/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ productId: prodId, productName: prodName, ingredients: currentRecipe, force: force }) })
    .then(async res => {
        btn.innerText = '💾 Сохранить рецептуру'; btn.disabled = false;
        if (res.ok) alert('✅ Рецепт успешно сохранен!'); 
        else if (res.status === 400) {
            const data = await res.json();
            if (confirm(data.warning)) saveRecipe(true); 
        } else alert('Ошибка: ' + await res.text()); 
    });
}