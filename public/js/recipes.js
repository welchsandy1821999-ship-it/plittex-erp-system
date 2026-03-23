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
// ==========================================
// ДОБАВЛЕНИЕ ИНГРЕДИЕНТА В РЕЦЕПТ
// ==========================================

window.addIngredientToRecipe = function () {
    const matSelect = document.getElementById('recipe-material-select');
    const qtyInput = document.getElementById('recipe-material-qty');
    const qty = parseFloat(qtyInput.value);

    if (matSelect.selectedIndex <= 0 || !qty || qty <= 0) {
        return UI.toast("Выберите материал и укажите количество больше нуля!", "warning");
    }

    const opt = matSelect.options[matSelect.selectedIndex];
    const materialId = parseInt(matSelect.value);

    // Проверяем, нет ли уже этого материала в рецепте
    const existingIndex = currentRecipeData.findIndex(i => i.materialId === materialId);
    if (existingIndex !== -1) {
        // Если есть, просто прибавляем количество
        currentRecipeData[existingIndex].qty += qty;
        UI.toast(`Количество для "${opt.getAttribute('data-name')}" увеличено`, 'info'); // Можно добавить легкий фидбек
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
};

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
// 1. ПОДГОТОВКА И ПРОВЕРКА ФРОНТЕНДА
window.saveRecipe = async function (force = false) {
    const prodSelect = document.getElementById('recipe-product-select');
    const productId = parseInt(prodSelect.value);
    const productName = prodSelect.options[prodSelect.selectedIndex].text;

    if (!productId) return UI.toast("Не выбрана продукция!", "error");

    // Заменяем первый confirm (проверка на пустой рецепт)
    if (currentRecipeData.length === 0 && !force) {
        const html = `
            <div style="padding: 10px; font-size: 15px;">
                Рецепт пуст. <br><br>
                Вы уверены, что хотите сохранить пустой рецепт? <br>
                <span style="color: var(--danger); font-size: 13px;">(Это удалит все привязанные ингредиенты)</span>
            </div>
        `;
        const buttons = `
            <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
            <button class="btn btn-blue" style="background: var(--danger); border-color: var(--danger);" 
                    onclick="executeSaveRecipe(${productId}, '${productName}', ${force})">🗑️ Да, сохранить пустым</button>
        `;
        return UI.showModal('⚠️ Внимание: Пустой рецепт', html, buttons);
    }

    // Если всё ок — переходим к отправке
    executeSaveRecipe(productId, productName, force);
};

// 2. ОТПРАВКА НА СЕРВЕР И ПРОВЕРКА ОТВЕТА
window.executeSaveRecipe = async function (productId, productName, force) {
    // Закрываем модалку, если она была открыта на предыдущем шаге
    if (typeof UI.closeModal === 'function') UI.closeModal();
    UI.toast('⏳ Сохранение...', 'info');

    const payload = { productId, productName, ingredients: currentRecipeData, force };

    try {
        const res = await fetch('/api/recipes/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (res.ok) {
            UI.toast('✅ Рецепт успешно сохранен!', 'success');

            // 1. Проверяем, нужно ли синхронизировать изменения
            if (typeof checkAndPromptSync === 'function') checkAndPromptSync(productId);

            // 2. ОБНОВЛЯЕМ ОРИГИНАЛ
            if (typeof originalRecipeData !== 'undefined') {
                originalRecipeData = JSON.parse(JSON.stringify(currentRecipeData));
            }

        } else {
            const errData = await res.json().catch(() => null);

            // Заменяем второй confirm (предупреждение от сервера)
            if (errData && errData.warning) {
                const html = `<div style="padding: 10px; font-size: 15px; color: var(--warning-text);">${errData.warning}</div>`;
                const buttons = `
                    <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
                    <button class="btn btn-blue" onclick="executeSaveRecipe(${productId}, '${productName}', true)">⚠️ Все равно сохранить</button>
                `;
                UI.showModal('Конфликт сохранения', html, buttons);
            } else {
                UI.toast(errData?.error || 'Ошибка сохранения!', 'error');
            }
        }
    } catch (e) {
        console.error(e);
        UI.toast('Критическая ошибка связи с сервером', 'error');
    }
};

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
        <p style="color: var(--primary); font-size: 15px; background: var(--surface-hover); padding: 10px; border-radius: 6px;"> • ${matNames}</p>
        <p style="color: var(--text-main); font-weight: 600; margin-bottom: 10px;">Применить эти новые значения к другим товарам из категории "${product.category}"?</p>
        
        <label class="sync-list-item" style="background: var(--surface-alt); font-weight: bold; margin-bottom: 10px;">
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
        <label style="display:flex; align-items:center; gap:8px; background: var(--surface-alt); padding:8px 12px; border-radius:6px; border:1px solid var(--border); cursor:pointer; font-size:13px; transition: 0.2s;">
            <input type="checkbox" class="mass-target-check" value="${p.id}">
            ${p.name}
        </label>
    `).join('');
}

// 1. ПОДГОТОВКА И ПРОВЕРКА 
window.executeMassCopy = function () {
    const sourceId = document.getElementById('mass-copy-source').value;
    const targetChecks = document.querySelectorAll('.mass-target-check:checked');

    if (!sourceId) return UI.toast('Выберите эталонный рецепт!', 'warning');
    if (targetChecks.length === 0) return UI.toast('Отметьте хотя бы одну позицию для применения шаблона!', 'warning');

    const targetIds = Array.from(targetChecks).map(cb => parseInt(cb.value));

    // Защита от дурака
    if (targetIds.includes(parseInt(sourceId))) {
        return UI.toast('Эталон не может быть одновременно и целью! Снимите галочку с эталонного товара в списке.', 'error');
    }

    // Заменяем confirm на красивую модалку
    const html = `
        <div style="padding: 10px; font-size: 15px; text-align: center;">
            <div style="font-size: 40px; margin-bottom: 10px;">⚠️</div>
            Текущие рецепты у <b style="color: var(--primary); font-size: 18px;">${targetIds.length}</b> выбранных позиций будут <br>
            <b style="color: var(--danger); text-transform: uppercase;">удалены</b> и заменены на копию эталона.<br><br>
            Вы уверены, что хотите продолжить?
        </div>
    `;

    // Передаем targetIds как JSON-строку, чтобы безопасно вставить массив в HTML
    const buttons = `
            <button id="mass-copy-cancel" class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
            <button id="mass-copy-confirm" class="btn btn-blue" onclick='confirmMassCopy(${sourceId}, ${JSON.stringify(targetIds)})'>🔄 Да, заменить рецепты</button>
        `;

    UI.showModal('Внимание: Массовое копирование', html, buttons);
};

// 2. ОТПРАВКА НА СЕРВЕР И ПРОВЕРКА ОТВЕТА
window.confirmMassCopy = async function (sourceId, targetIds) {
    // 🚀 ФИКС RACE CONDITION: Блокируем кнопки, но НЕ закрываем окно
    const btnConfirm = document.getElementById('mass-copy-confirm');
    const btnCancel = document.getElementById('mass-copy-cancel');

    if (btnConfirm) {
        btnConfirm.disabled = true;
        btnConfirm.innerHTML = '⏳ Запись в БД (не закрывайте)...';
        btnConfirm.classList.add('is-locked-by-system'); // Симбиоз с глобальным перехватчиком
    }
    if (btnCancel) btnCancel.disabled = true;

    UI.toast(`⏳ Копирование рецептов (${targetIds.length} шт.)...`, 'info');

    try {
        const res = await fetch('/api/recipes/mass-copy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sourceProductId: sourceId, targetProductIds: targetIds })
        });

        // 🚀 Закрываем окно ТОЛЬКО после того, как сервер подтвердил завершение транзакции
        UI.closeModal();

        // ✅ Оставили только один правильный блок обработки ответа
        if (res.ok) {
            const result = await res.json();
            UI.toast('✅ ' + (result.message || 'Успешно скопировано!'), 'success');

            if (typeof toggleMassCopyTool === 'function') toggleMassCopyTool(); // Закрываем панель

            // Если у нас открыт какой-то рецепт сейчас, перезагрузим его
            const currentSelectedProd = document.getElementById('recipe-product-select').value;
            if (currentSelectedProd && targetIds.includes(parseInt(currentSelectedProd))) {
                if (typeof loadRecipeDetails === 'function') loadRecipeDetails();
            }
        } else {
            const errText = await res.text();
            UI.toast('❌ Ошибка: ' + errText, 'error');
        }
    } catch (e) {
        console.error(e);
        UI.toast('Критическая ошибка связи с сервером', 'error');
    }
};