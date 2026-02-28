// === public/js/recipes.js ===

let allMaterialsList = []; // Хранит список всего сырья
let currentRecipeData = []; // Хранит компоненты открытого сейчас рецепта
let allRecipeProducts = []; // Хранит список всей продукции с категориями
let originalRecipeData = []; // Хранит слепок рецепта ДО редактирования

// 1. Инициализация модуля (загрузка списков при старте приложения)
async function loadRecipeModuleData() {
    try {
        // Грузим продукцию для левого списка
        const prodRes = await fetch('/api/items?item_type=product&limit=500');
        const prodData = await prodRes.json();
        allRecipeProducts = prodData.data;
        const prodSelect = document.getElementById('recipe-product-select');
        prodSelect.innerHTML = '<option value="" disabled selected>-- Выберите продукцию --</option>';
        prodData.data.forEach(p => prodSelect.add(new Option(p.name, p.id)));

        // Грузим сырье для правого списка (добавление компонентов)
        const matRes = await fetch('/api/items?item_type=material&limit=500');
        const matData = await matRes.json();
        allMaterialsList = matData.data;

        const matSelect = document.getElementById('recipe-material-select');
        matSelect.innerHTML = '<option value="" disabled selected>-- Выберите сырье --</option>';
        allMaterialsList.forEach(m => {
            let opt = new Option(`${m.name} (${parseFloat(m.current_price)} ₽/${m.unit})`, m.id);
            opt.setAttribute('data-name', m.name);
            opt.setAttribute('data-unit', m.unit);
            opt.setAttribute('data-price', m.current_price);
            matSelect.add(opt);
        });
    } catch (e) { console.error("Ошибка загрузки данных рецептов:", e); }
}

// 2. Открытие конкретного рецепта при выборе продукции
async function loadRecipeDetails() {
    const prodSelect = document.getElementById('recipe-product-select');
    const productId = prodSelect.value;
    const productName = prodSelect.options[prodSelect.selectedIndex].text;

    if (!productId) return;

    // Показываем правый блок и сводку
    document.getElementById('recipe-editor-area').style.display = 'block';
    document.getElementById('recipe-summary-card').style.display = 'block';
    document.getElementById('recipe-editor-title').innerText = `Рецепт: ${productName}`;

    try {
        // Запрашиваем с сервера уже сохраненный рецепт
        const res = await fetch(`/api/recipes/${productId}`);
        const data = await res.json();

        // Преобразуем данные в наш рабочий массив
        currentRecipeData = data.map(ing => ({
            materialId: ing.material_id,
            name: ing.material_name,
            qty: parseFloat(ing.quantity_per_unit),
            unit: ing.unit,
            price: parseFloat(ing.current_price) || 0
        }));

        originalRecipeData = JSON.parse(JSON.stringify(currentRecipeData));
        renderRecipeTable();
    } catch (e) { console.error("Ошибка загрузки рецепта:", e); }
}

// 3. Добавление нового сырья во временный список (до сохранения)
function addIngredientToRecipe() {
    const matSelect = document.getElementById('recipe-material-select');
    const qtyInput = document.getElementById('recipe-material-qty');
    const qty = parseFloat(qtyInput.value);

    if (matSelect.selectedIndex <= 0 || !qty || qty <= 0) {
        return alert("Выберите материал и укажите количество больше нуля!");
    }

    const opt = matSelect.options[matSelect.selectedIndex];
    const materialId = parseInt(matSelect.value);

    // Проверяем, нет ли уже этого материала в рецепте
    const existingIndex = currentRecipeData.findIndex(i => i.materialId === materialId);
    if (existingIndex !== -1) {
        // Если есть, просто прибавляем количество
        currentRecipeData[existingIndex].qty += qty;
    } else {
        // Если нет, добавляем новую строку
        currentRecipeData.push({
            materialId: materialId,
            name: opt.getAttribute('data-name'),
            qty: qty,
            unit: opt.getAttribute('data-unit'),
            price: parseFloat(opt.getAttribute('data-price')) || 0
        });
    }

    // Очищаем поле ввода для следующего компонента
    qtyInput.value = '';
    renderRecipeTable();
}

// 4. Удаление компонента из временного списка
function removeIngredientFromRecipe(index) {
    currentRecipeData.splice(index, 1);
    renderRecipeTable();
}

// 5. Отрисовка таблицы и пересчет сводки
function renderRecipeTable() {
    const tbody = document.getElementById('recipe-table-body');
    const emptyMsg = document.getElementById('recipe-empty-msg');

    let totalWeight = 0;
    let totalCost = 0;

    if (currentRecipeData.length === 0) {
        tbody.innerHTML = '';
        if (emptyMsg) emptyMsg.style.display = 'block';
    } else {
        if (emptyMsg) emptyMsg.style.display = 'none';
        tbody.innerHTML = currentRecipeData.map((ing, index) => {
            const cost = ing.qty * ing.price;
            totalWeight += ing.qty;
            totalCost += cost;

            return `
                <tr>
                    <td><strong>${ing.name}</strong></td>
                    <td style="text-align: right;">
                        <input type="number" class="input-modern" style="width: 80px; text-align: right; padding: 4px 8px; font-weight: bold; color: var(--primary);" 
                            value="${ing.qty}" 
                            onchange="updateIngredientQty(${index}, this.value)" 
                            step="0.001" min="0">
                    </td>
                    <td>${ing.unit}</td>
                    <td style="text-align: right;">${cost.toFixed(2)} ₽</td>
                    <td style="text-align: center;">
                        <button class="btn btn-outline" style="padding: 2px 6px; font-size: 12px; color: var(--danger); border-color: var(--danger);" onclick="removeIngredientFromRecipe(${index})">❌</button>
                    </td>
                </tr>
            `;
        }).join('');
    }

    // Обновляем левую панель сводки
    const weightEl = document.getElementById('recipe-total-weight');
    const costEl = document.getElementById('recipe-total-cost');
    if (weightEl) weightEl.innerText = `${totalWeight.toFixed(2)} кг`;
    if (costEl) costEl.innerText = `${totalCost.toFixed(2)} ₽`;
}

// === НОВАЯ ФУНКЦИЯ: Обновление количества прямо в таблице ===
function updateIngredientQty(index, value) {
    let newQty = parseFloat(value);
    if (isNaN(newQty) || newQty < 0) newQty = 0; // Защита от ввода минусов или букв

    currentRecipeData[index].qty = newQty;
    renderRecipeTable(); // Мгновенно перерисовываем таблицу для обновления стоимости
}

// 6. Сохранение рецепта на сервер (с красивым Toast)
async function saveRecipe(force = false) {
    const prodSelect = document.getElementById('recipe-product-select');
    const productId = parseInt(prodSelect.value);
    const productName = prodSelect.options[prodSelect.selectedIndex].text;

    if (!productId) return UI.toast("Не выбрана продукция!", "error");
    if (currentRecipeData.length === 0 && !force) {
        if (!confirm("Рецепт пуст. Вы уверены, что хотите сохранить пустой рецепт?")) return;
    }

    const payload = { productId, productName, ingredients: currentRecipeData, force };

    try {
        const res = await fetch('/api/recipes/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (res.ok) {
            UI.toast('Рецепт успешно сохранен!', 'success');

            // 1. Проверяем, нужно ли синхронизировать изменения
            checkAndPromptSync(productId);

            // 2. ОБНОВЛЯЕМ ОРИГИНАЛ (теперь текущий рецепт стал новым эталоном)
            originalRecipeData = JSON.parse(JSON.stringify(currentRecipeData));

        } else {
            const errData = await res.json().catch(() => null);
            if (errData && errData.warning) {
                if (confirm(errData.warning)) saveRecipe(true);
            } else {
                UI.toast('Ошибка сохранения!', 'error');
            }
        }
    } catch (e) { console.error(e); }
}

// 7. Умный помощник синхронизации ТОЛЬКО ИЗМЕНЕННЫХ полей
function checkAndPromptSync(savedProductId) {
    const product = allRecipeProducts.find(p => p.id === savedProductId);
    if (!product || !product.category) return;

    // 1. ВЫЧИСЛЯЕМ РАЗНИЦУ: Ищем только те материалы, которые изменились или были добавлены
    const changedMaterials = [];
    currentRecipeData.forEach(newIng => {
        const oldIng = originalRecipeData.find(old => old.materialId === newIng.materialId);
        // Если материала раньше не было (новый) ИЛИ его количество изменилось
        if (!oldIng || oldIng.qty !== newIng.qty) {
            changedMaterials.push(newIng);
        }
    });

    if (changedMaterials.length === 0) return; // Если ничего не меняли, окно не показываем

    // 2. Отбираем только базу (исключаем пигменты из измененного)
    const baseMaterials = changedMaterials.filter(ing =>
        !ing.name.toLowerCase().includes('пигмент') &&
        !ing.name.toLowerCase().includes('диоксид') &&
        !ing.name.toLowerCase().includes('краситель')
    );

    if (baseMaterials.length === 0) return; // Если изменили только пигмент — ничего не предлагаем

    // Ищем другие товары в этой же категории
    const relatedProducts = allRecipeProducts.filter(p => p.category === product.category && p.id !== savedProductId);
    if (relatedProducts.length === 0) return;

    // Формируем HTML для красивого окна с галочками
    const matNames = baseMaterials.map(m => `<b>${m.name}</b> (${m.qty} ${m.unit})`).join('<br> • ');

    let htmlBody = `
        <p style="margin-top:0;">Вы изменили следующие компоненты:</p>
        <p style="color: var(--primary); font-size: 15px; background: #f1f5f9; padding: 10px; border-radius: 6px;"> • ${matNames}</p>
        <p style="color: var(--text-main); font-weight: 600; margin-bottom: 10px;">Применить эти новые значения к другим товарам из категории "${product.category}"?</p>
        
        <label class="sync-list-item" style="background: #e2e8f0; font-weight: bold; margin-bottom: 10px;">
            <input type="checkbox" id="sync-check-all" checked onchange="document.querySelectorAll('.sync-target-cb').forEach(cb => cb.checked = this.checked)">
            Выбрать все
        </label>
        
        <div style="max-height: 200px; overflow-y: auto; border: 1px solid var(--border); border-radius: 6px; padding: 5px;">
            ${relatedProducts.map(p => `
                <label class="sync-list-item">
                    <input type="checkbox" class="sync-target-cb" value="${p.id}" checked>
                    ${p.name}
                </label>
            `).join('')}
        </div>
        <p style="font-size: 11px; color: var(--text-muted); margin-top: 10px;">* Остальные компоненты (и пигменты) в выбранных товарах останутся без изменений.</p>
    `;

    window.tempSyncMaterials = baseMaterials;

    let buttonsHtml = `
        <button class="btn btn-outline" onclick="UI.closeModal()">Пропустить</button>
        <button class="btn btn-blue" onclick="executeSmartSync()">🔄 Синхронизировать</button>
    `;

    UI.showModal('🔄 Обновление рецептур', htmlBody, buttonsHtml);
}

// 8. Выполнение умной синхронизации по кнопке из модалки
async function executeSmartSync() {
    const checkedBoxes = document.querySelectorAll('.sync-target-cb:checked');
    if (checkedBoxes.length === 0) {
        UI.toast('Выберите хотя бы один товар!', 'error');
        return;
    }

    const targetIds = Array.from(checkedBoxes).map(cb => parseInt(cb.value));
    const materials = window.tempSyncMaterials;

    UI.toast('Синхронизация...', 'info');
    UI.closeModal();

    try {
        const syncRes = await fetch('/api/recipes/sync-category', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetProductIds: targetIds, materials: materials.map(m => ({ materialId: m.materialId, qty: m.qty })) })
        });

        const syncData = await syncRes.json();
        if (syncRes.ok) {
            UI.toast(`✅ ${syncData.message}`, 'success');
        } else {
            UI.toast(`❌ Ошибка: ${syncData.message}`, 'error');
        }
    } catch (e) {
        console.error(e);
        UI.toast('Произошла ошибка сети', 'error');
    }
}

// === ИНСТРУМЕНТ МАССОВОГО КОПИРОВАНИЯ ===

let allProductsForCopy = [];

function toggleMassCopyTool() {
    const card = document.getElementById('recipe-mass-copy-card');
    if (card.style.display === 'none' || card.style.display === '') {
        card.style.display = 'block';
        initMassCopyTool();
    } else {
        card.style.display = 'none';
    }
}

async function initMassCopyTool() {
    try {
        const res = await fetch('/api/items?item_type=product&limit=1000');
        const data = await res.json();
        allProductsForCopy = data.data;

        // Заполняем список эталонов
        const sourceSelect = document.getElementById('mass-copy-source');
        sourceSelect.innerHTML = '<option value="" disabled selected>-- Выберите эталонный рецепт --</option>';
        allProductsForCopy.forEach(p => sourceSelect.add(new Option(p.name, p.id)));

        // Заполняем фильтр категорий
        const categories = [...new Set(allProductsForCopy.map(p => p.category || 'Без категории'))];
        const catSelect = document.getElementById('mass-copy-category');
        catSelect.innerHTML = '<option value="" disabled selected>-- Выберите категорию для поиска --</option>';
        categories.forEach(c => catSelect.add(new Option(c, c)));

    } catch (e) { console.error("Ошибка загрузки данных для клонирования:", e); }
}

function loadMassCopyTargets() {
    const selectedCat = document.getElementById('mass-copy-category').value;
    const targetDiv = document.getElementById('mass-copy-targets');
    targetDiv.innerHTML = '';

    const filtered = allProductsForCopy.filter(p => (p.category || 'Без категории') === selectedCat);

    if (filtered.length === 0) {
        targetDiv.innerHTML = '<div style="color: var(--text-muted); font-size: 13px;">Нет товаров в этой категории.</div>';
        return;
    }

    // Выводим чекбоксы для целей
    targetDiv.innerHTML = filtered.map(p => `
        <label style="display:flex; align-items:center; gap:8px; background:#f8fafc; padding:8px 12px; border-radius:6px; border:1px solid #e2e8f0; cursor:pointer; font-size:13px; transition: 0.2s;">
            <input type="checkbox" class="mass-target-check" value="${p.id}">
            ${p.name}
        </label>
    `).join('');
}

async function executeMassCopy() {
    const sourceId = document.getElementById('mass-copy-source').value;
    const targetChecks = document.querySelectorAll('.mass-target-check:checked');

    if (!sourceId) return alert('Выберите эталонный рецепт!');
    if (targetChecks.length === 0) return alert('Отметьте хотя бы одну позицию для применения шаблона!');

    const targetIds = Array.from(targetChecks).map(cb => parseInt(cb.value));

    // Защита от дурака (чтобы не скопировать сам в себя)
    if (targetIds.includes(parseInt(sourceId))) {
        return alert('Эталон не может быть одновременно и целью! Снимите галочку с эталонного товара в списке.');
    }

    if (!confirm(`ВНИМАНИЕ!\nТекущие рецепты у ${targetIds.length} выбранных позиций будут УДАЛЕНЫ и заменены на копию эталона. Продолжить?`)) return;

    try {
        const res = await fetch('/api/recipes/mass-copy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sourceProductId: sourceId, targetProductIds: targetIds })
        });

        const result = await res.json();
        if (res.ok) {
            alert('✅ ' + result.message);
            toggleMassCopyTool(); // Закрываем панель

            // Если у нас открыт какой-то рецепт сейчас, перезагрузим его
            const currentSelectedProd = document.getElementById('recipe-product-select').value;
            if (currentSelectedProd && targetIds.includes(parseInt(currentSelectedProd))) {
                loadRecipeDetails();
            }
        } else alert('❌ Ошибка: ' + await res.text());
    } catch (e) { console.error(e); }
}