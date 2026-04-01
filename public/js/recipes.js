// === public/js/recipes.js ===

let allMaterialsList = []; // Хранит список всего сырья
let currentRecipeData = []; // Хранит компоненты открытого сейчас рецепта
let allRecipeProducts = []; // Хранит список всей продукции с категориями
let originalRecipeData = []; // Хранит слепок рецепта ДО редактирования

window.currentRecipeMode = 'BOM'; // 'BOM' или 'MIX'
window.currentMixTemplates = {};
window.mixTemplateYields = {};

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

        initStaticRecipeSelects();

        // Загружаем данные для Второго Режима (Шаблоны)
        const resMix = await fetch('/api/mix-templates');
        if (resMix.ok) window.currentMixTemplates = await resMix.json();
        
        const resYields = await fetch('/api/mix-template-yields');
        if (resYields.ok) window.mixTemplateYields = await resYields.json();

    } catch (e) { console.error("Ошибка загрузки данных рецептов:", e); }
}

function initStaticRecipeSelects() {
    const prodEl = document.getElementById('recipe-product-select');
    if (prodEl) {
        if (!prodEl.tomselect) {
            new TomSelect(prodEl, {
                plugins: ['clear_button'],
                dropdownParent: 'body',
                onChange: function(value) {
                    loadRecipeDetails();
                }
            });
        } else {
            prodEl.tomselect.sync();
        }
    }

    const matEl = document.getElementById('recipe-material-select');
    if (matEl) {
        if (!matEl.tomselect) {
            new TomSelect(matEl, {
                plugins: ['clear_button'],
                dropdownParent: 'body'
            });
        } else {
            matEl.tomselect.sync();
        }
    }

    const mixKeysEl = document.getElementById('mix-template-keys-select');
    if (mixKeysEl && !mixKeysEl.tomselect) {
        new TomSelect(mixKeysEl, {
            plugins: ['clear_button'],
            dropdownParent: 'body'
        });
    }
}

// === ЛОГИКА ПЕРЕКЛЮЧЕНИЯ РЕЖИМОВ ===
window.switchRecipeMode = function(mode) {
    window.currentRecipeMode = mode;
    
    // Стили кнопок-табов
    document.getElementById('tab-recipes-bom').className = mode === 'BOM' ? 'btn btn-blue shadow-primary' : 'btn btn-outline';
    document.getElementById('tab-recipes-bom').style.color = mode === 'BOM' ? '' : 'var(--primary)';
    
    document.getElementById('tab-recipes-mix').className = mode === 'MIX' ? 'btn btn-blue shadow-primary' : 'btn btn-outline';
    document.getElementById('tab-recipes-mix').style.color = mode === 'MIX' ? '' : 'var(--primary)';

    // Видимость блоков выбора
    document.getElementById('recipe-left-mode-bom').style.display = mode === 'BOM' ? 'block' : 'none';
    document.getElementById('recipe-left-mode-mix').style.display = mode === 'MIX' ? 'block' : 'none';

    // Сбрасываем рабочую область
    document.getElementById('recipe-editor-area').style.display = 'none';
    document.getElementById('recipe-summary-card').style.display = 'none';
    currentRecipeData = [];
    originalRecipeData = [];
    document.getElementById('recipe-table-body').innerHTML = '';
    
    // Сбрасываем выпадающие списки (чтобы onChange срабатывал заново)
    const tsProd = document.getElementById('recipe-product-select').tomselect;
    if (tsProd) tsProd.clear(true);
    const tsMix = document.getElementById('mix-template-keys-select').tomselect;
    if (tsMix) tsMix.clear(true);
    
    // Пересчитываем итоги (обнуляем итоговые суммы на экране)
    if (typeof window.recalculateRecipeTotals === 'function') {
        window.recalculateRecipeTotals();
    }

    document.getElementById('mix-yield-container').style.display = mode === 'MIX' ? 'block' : 'none';
    
    const massApplyBtn = document.getElementById('btn-mass-apply-recipe');
    if (massApplyBtn) massApplyBtn.style.display = mode === 'BOM' ? 'block' : 'none';

    const topMassApplyPanel = document.getElementById('top-panel-mass-apply');
    if (topMassApplyPanel) topMassApplyPanel.style.display = mode === 'BOM' ? 'flex' : 'none';

    document.getElementById('recipe-editor-badge').style.display = 'none';

    // Меняем подписи в сводке
    if (mode === 'BOM') {
        document.getElementById('recipe-cost-label').innerText = 'Себестоимость (сырье):';
        document.getElementById('recipe-footer-hint').innerText = '* Расчет идет строго на 1 единицу измерения (указана в справочнике).';
    } else {
        document.getElementById('recipe-cost-label').innerText = 'Себестоимость Замеса:';
        document.getElementById('recipe-footer-hint').innerText = '* Расчет идет на весь Бетоносмеситель.';
    }
};

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

// Загрузка шаблона замеса (Режим 2)
window.loadMixTemplateDetails = function() {
    const ts = document.getElementById('mix-template-keys-select').tomselect;
    const templateKey = ts ? ts.getValue() : document.getElementById('mix-template-keys-select').value;
    if (!templateKey) return;
    
    const opt = document.querySelector(`#mix-template-keys-select option[value="${templateKey}"]`);
    const templateName = opt ? opt.innerText : templateKey;

    document.getElementById('recipe-editor-area').style.display = 'block';
    document.getElementById('recipe-summary-card').style.display = 'block';
    document.getElementById('recipe-editor-title').innerText = `Шаблон: ${templateName}`;

    const badgeEl = document.getElementById('recipe-editor-badge');
    badgeEl.style.display = 'inline-block';
    if (templateKey.startsWith('main_')) {
        badgeEl.innerText = 'ОСНОВНОЙ ЗАМЕС';
        badgeEl.style.background = 'var(--border)';
        badgeEl.style.color = 'var(--text-main)';
    } else {
        badgeEl.innerText = 'ЛИЦЕВОЙ ЗАМЕС';
        badgeEl.style.background = 'var(--warning)';
        badgeEl.style.color = 'var(--warning-text)';
    }

    const tplData = window.currentMixTemplates[templateKey] || [];
    
    // Преобразуем формат mix_templates в currentRecipeData
    currentRecipeData = tplData.map(mat => {
        const globalMat = allMaterialsList.find(m => String(m.id) === String(mat.id));
        return {
            materialId: parseInt(mat.id) || mat.id,
            name: mat.name,
            qty: parseFloat(mat.qty) || 0,
            unit: mat.unit || 'кг',
            price: globalMat ? parseFloat(globalMat.current_price) || 0 : 0
        };
    });
    
    // Загружаем плановый выход
    const yieldVal = window.mixTemplateYields[templateKey] || 1;
    document.getElementById('mix-yield-input').value = yieldVal;

    originalRecipeData = JSON.parse(JSON.stringify(currentRecipeData));
    renderRecipeTable();
};

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
                    <td style="padding: 12px 15px;"><strong>${ing.name}</strong></td>
                    <td style="text-align: right; padding: 12px 15px;">
                        <input type="number" class="input-modern" style="width: 80px; text-align: right; padding: 6px 10px; font-weight: bold; color: var(--primary);" 
                            value="${ing.qty}" 
                            onchange="updateIngredientQty(${index}, this.value)" 
                            step="0.001" min="0">
                    </td>
                    <td style="padding: 12px 15px;">${ing.unit}</td>
                    <td style="text-align: right; padding: 12px 15px;">${cost.toFixed(2)} ₽</td>
                    <td style="text-align: center; padding: 12px 15px;">
                        <button class="btn btn-outline" style="padding: 4px 8px; font-size: 13px; color: var(--danger); border-color: var(--danger);" onclick="removeIngredientFromRecipe(${index})">❌</button>
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

    if (window.currentRecipeMode === 'MIX') {
        window.recalculateMixUnitCost();
    }
}

// Пересчет себестоимости 1 единицы = (Стоимость корыта / Плановый выход)
window.recalculateMixUnitCost = function() {
    if (window.currentRecipeMode !== 'MIX') return;
    
    const costEl = document.getElementById('recipe-total-cost');
    const totalBatchCost = parseFloat(costEl.innerText) || 0;
    
    const yld = parseFloat(document.getElementById('mix-yield-input').value) || 1;
    const unitCost = totalBatchCost / (yld > 0 ? yld : 1);
    
    document.getElementById('mix-unit-cost').innerText = unitCost.toFixed(2) + ' ₽';
};

// === УМНЫЙ ШАБЛОНИЗАТОР v2 (РЕДИЗАЙН) ===
const MIX_GROUPS = [
    {
        name: "ОСНОВНОЙ СЛОЙ",
        groupId: "group_main",
        keys: ["main_block", "main_bor_dor", "main_bor_mag", "main_por", "main_tile_40", "main_tile_60", "main_tile_80"]
    },
    {
        name: "ЛИЦЕВОЙ СЛОЙ (ГЛАДКАЯ)",
        groupId: "group_smooth",
        keys: ["face_smooth_grey", "face_smooth_white", "face_smooth_black", "face_smooth_red", "face_smooth_yellow", "face_smooth_brown", "face_smooth_orange"]
    },
    {
        name: "ЛИЦЕВОЙ СЛОЙ (ГРАНИТ)",
        groupId: "group_granite",
        keys: ["face_granite_grey", "face_granite_black", "face_granite_red", "face_granite_yellow", "face_granite_brown", "face_granite_orange"]
    },
    {
        name: "ЛИЦЕВОЙ СЛОЙ (МЕЛАНЖ ГЛАДКИЙ)",
        groupId: "group_melange_smooth",
        keys: ["face_mel_sm_onyx", "face_mel_sm_autumn", "face_mel_sm_amber", "face_mel_sm_jasper", "face_mel_sm_ruby"]
    },
    {
        name: "ЛИЦЕВОЙ СЛОЙ (МЕЛАНЖ ГРАНИТ)",
        groupId: "group_melange_granite",
        keys: ["face_mel_gr_onyx", "face_mel_gr_autumn", "face_mel_gr_amber", "face_mel_gr_jasper", "face_mel_gr_ruby"]
    }
];

window.showMixCopyModal = function() {
    const ts = document.getElementById('mix-template-keys-select').tomselect;
    const currentKey = ts ? ts.getValue() : document.getElementById('mix-template-keys-select').value;
    if (!currentKey) return;
    
    // Определяем тип (Лицевой или Основной)
    const isMain = currentKey.startsWith('main_');
    const targetGroups = MIX_GROUPS.filter(g => isMain ? g.keys[0].startsWith('main_') : g.keys[0].startsWith('face_'));
    
    let html = `<div style="margin-bottom: 20px; font-size: 15px;">Выберите группы или отдельные шаблоны для умного копирования:</div>`;
    html += `<div style="max-height: 480px; overflow-y: auto; padding-right: 10px;">`;
    
    targetGroups.forEach(group => {
        html += `
            <div style="margin-bottom: 15px; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.05);">
                <div style="background: var(--surface-alt); padding: 12px 15px; display: flex; justify-content: space-between; align-items: center; cursor: pointer;" onclick="toggleMixGroup('${group.groupId}')">
                    <strong style="color: var(--primary); font-size: 14px;">${group.name} <span>(развернуть 🔽)</span></strong>
                    <label style="display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: bold; margin: 0; cursor: pointer; color: var(--success);" onclick="event.stopPropagation()">
                        <input type="checkbox" style="width: 16px; height: 16px;" onclick="toggleAllInGroup('${group.groupId}', this.checked)"> Выбрать всю группу
                    </label>
                </div>
                <div id="mix-copy-${group.groupId}" style="padding: 15px; display: none; grid-template-columns: 1fr 1fr; gap: 12px; background: var(--surface);">
        `;
        
        group.keys.forEach(key => {
            if (key === currentKey) return; // Себя не выводим
            const opt = document.querySelector(`#mix-template-keys-select option[value="${key}"]`);
            const name = opt ? opt.innerText : key;
            html += `
                <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                    <input type="checkbox" class="mix-copy-target-cb cb-group-${group.groupId}" value="${key}" style="width: 15px; height: 15px;">
                    <span style="font-size: 14px;">${name}</span>
                </label>
            `;
        });
        
        html += `</div></div>`;
    });
    html += `</div>`;
    
    const opt = document.querySelector(`#mix-template-keys-select option[value="${currentKey}"]`);
    const currentName = opt ? opt.innerText : currentKey;

    const buttons = `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-blue shadow-primary" onclick="executeMassCopyMixTemplate('${currentKey}')" style="padding: 0 20px;">🚀 Скопировать в отмеченные</button>
    `;
    UI.showModal(`🎭 Умное копирование (${currentName})`, html, buttons);
};

window.toggleMixGroup = function(groupId) {
    const el = document.getElementById(`mix-copy-${groupId}`);
    if(el) el.style.display = el.style.display === 'none' || el.style.display === '' ? 'grid' : 'none';
};

window.toggleAllInGroup = function(groupId, checked) {
    const cbs = document.querySelectorAll(`.cb-group-${groupId}`);
    cbs.forEach(cb => cb.checked = checked);
};

window.executeMassCopyMixTemplate = async function(sourceKey) {
    const checkboxes = document.querySelectorAll('.mix-copy-target-cb:checked');
    const targetKeys = Array.from(checkboxes).map(cb => cb.value);
    
    if (targetKeys.length === 0) return UI.toast('Выберите хотя бы один шаблон', 'error');
    
    const yieldValue = parseFloat(document.getElementById('mix-yield-input').value) || 1;
    executeSaveMixTemplate(sourceKey, yieldValue, targetKeys);
}

function isRecipeChanged() {
    if (originalRecipeData.length !== currentRecipeData.length) return true;
    for(let i=0; i < currentRecipeData.length; i++) {
        const o = originalRecipeData[i];
        const c = currentRecipeData[i];
        if (o.materialId !== c.materialId || o.qty !== c.qty) return true;
    }
    return false;
}

// 6. Сохранение рецепта на сервер (с красивым Toast)
// 1. ПОДГОТОВКА И ПРОВЕРКА ФРОНТЕНДА
window.saveRecipe = async function (force = false) {
    if (window.currentRecipeMode === 'MIX') {
        // --- РЕЖИМ 2: СОХРАНЕНИЕ ШАБЛОНА ---
        const ts = document.getElementById('mix-template-keys-select').tomselect;
        const templateKey = ts ? ts.getValue() : document.getElementById('mix-template-keys-select').value;
        if (!templateKey) return UI.toast("Не выбран шаблон!", "error");
        
        const rawYld = parseFloat(document.getElementById('mix-yield-input').value);
        const yld = (rawYld > 0) ? rawYld : 1;
        
        if (currentRecipeData.length === 0 && !force) {
             const html = `<div style="padding: 10px; font-size: 15px;">Шаблон пуст. Сохранить его пустым?</div>`;
             const buttons = `
                 <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
                 <button class="btn btn-blue" style="background: var(--danger); border-color: var(--danger);" onclick="executeSaveMixTemplate('${templateKey}', ${yld})">🗑️ Да</button>
             `;
             return UI.showModal('⚠️ Внимание: Пустой шаблон', html, buttons);
        }

        // --- ИНТЕРЦЕПТ СОХРАНЕНИЯ (ПРЕДЛАГАЕМ ГРУППОВУЮ СИНХРОНИЗАЦИЮ) ---
        if (isRecipeChanged() && !force) {
            const group = MIX_GROUPS.find(g => g.keys.includes(templateKey));
                                  
            if (group) {
                const siblings = group.keys.filter(k => k !== templateKey);
                // Получаем красивые имена для вывода
                const siblingsHtml = siblings.map(k => {
                    const opt = document.querySelector(`#mix-template-keys-select option[value="${k}"]`);
                    return opt ? opt.innerText : k;
                });

                if (siblings.length > 0) {
                    let html = `
                        <div style="padding: 10px 0; font-size: 15px;">
                            Вы изменили состав/выход шаблона в группе <strong>"${group.name}"</strong>.<br><br>
                            <strong>Применить изменения ко ВСЕЙ ГРУППЕ (${siblings.length + 1} позиций) автоматически?</strong>
                            <ul style="font-size: 13px; margin-top: 15px; background: var(--surface-alt); padding: 15px 30px; border-radius: 6px; color: var(--text-main); max-height: 140px; overflow-y: auto; border: 1px dashed var(--border);">
                                ${siblingsHtml.map(name => `<li>${name}</li>`).join('')}
                            </ul>
                        </div>
                    `;
                    const buttons = `
                        <button class="btn btn-outline" style="min-width: 140px;" onclick="executeSaveMixTemplate('${templateKey}', ${yld}, null)">💾 Нет, сохранить только этот</button>
                        <button class="btn btn-blue shadow-primary" onclick="executeSaveMixTemplate('${templateKey}', ${yld}, ['${siblings.join("','")}'])">🚀 Да, применить ко всей группе</button>
                    `;
                    return UI.showModal(`🔄 Умная синхронизация: ${group.name}`, html, buttons);
                }
            }
        }

        return executeSaveMixTemplate(templateKey, yld, null);
    }

    // --- РЕЖИМ 1: СОХРАНЕНИЕ BOM ---
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

// Функция отправки Шаблона в Режиме 2
window.executeSaveMixTemplate = async function(templateKey, yieldValue, targetKeysArray = null) {
    if (typeof UI.closeModal === 'function') UI.closeModal();
    
    // Если targetKeysArray не передан, сохраняем только один
    const targetKeys = Array.isArray(targetKeysArray) ? [templateKey, ...targetKeysArray] : [templateKey];
    
    const payloadIngredients = currentRecipeData.map(ing => ({
        id: String(ing.materialId),
        name: ing.name,
        qty: parseFloat(ing.qty),
        unit: ing.unit
    }));

    UI.toast('⏳ Сохранение...', 'info');
    try {
        const promises = targetKeys.map(key => {
            return fetch('/api/mix-templates/single', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    templateKey: key,
                    yieldValue: yieldValue,
                    ingredients: payloadIngredients
                })
            });
        });

        await Promise.all(promises);

        // Обновляем кэш
        targetKeys.forEach(key => {
            window.currentMixTemplates[key] = payloadIngredients;
            window.mixTemplateYields[key] = yieldValue;
        });

        UI.toast(targetKeys.length > 1 ? `✅ Шаблон скопирован в ${targetKeys.length} позиций!` : '✅ Шаблон успешно сохранен!', 'success');
        originalRecipeData = JSON.parse(JSON.stringify(currentRecipeData));
    } catch (e) {
        UI.toast('❌ Ошибка сети', 'error');
    }
};

// 2. ОТПРАВКА НА СЕРВЕР И ПРОВЕРКА ОТВЕТА (Режим 1)
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

// 7. Параметрическая модалка "Массовое применение шаблона" (Режим 1)
function parseProductFeatures(name) {
    const n = name ? name.toLowerCase() : '';
    let type = 'Все';
    if (n.includes('бордюр') || n.includes('поребрик')) type = n.includes('бордюр') ? 'Бордюр' : 'Поребрик';
    else if (n.includes('блок') || n.includes('block')) type = 'Блок';
    else if (n.includes('плитка')) type = 'Плитка';

    let thickness = 'Все';
    const tMatch = n.match(/\b(40|60|80)мм\b/i) || n.match(/\b(40|60|80)\b/);
    if (tMatch) thickness = tMatch[1] + 'мм';

    let texture = 'Все';
    if (n.includes('меланж гладкий') || (n.includes('меланж') && (n.includes('гладкая') || n.includes('гладк')))) texture = 'Меланж гладкий';
    else if (n.includes('меланж гранит') || n.includes('меланж')) texture = 'Меланж гранит';
    else if (n.includes('гранит')) texture = 'Гранит';
    else if (n.includes('гладкая') || n.includes('гладк')) texture = 'Гладкая';

    let color = 'Все';
    if (n.includes('оникс')) color = 'Меланж Оникс';
    else if (n.includes('осень')) color = 'Меланж Осень';
    else if (n.includes('янтарь')) color = 'Меланж Янтарь';
    else if (n.includes('яшма')) color = 'Меланж Яшма';
    else if (n.includes('рубин')) color = 'Меланж Рубин';
    else if (n.includes('сер') && !n.match(/меланж.*\bсер/i)) color = 'Серый';
    else if (n.includes('красн')) color = 'Красный';
    else if (n.includes('черн')) color = 'Черный';
    else if (n.includes('желт')) color = 'Желтый';
    else if (n.includes('коричн')) color = 'Коричневый';
    else if (n.includes('бел')) color = 'Белый';
    else if (n.includes('оранж')) color = 'Оранжевый';

    return { type, thickness, texture, color };
}

window.showRecipeMassApplyModal = function() {
    const prodSelect = document.getElementById('recipe-product-select');
    const productId = parseInt(prodSelect.value);
    const productName = prodSelect.options[prodSelect.selectedIndex]?.text || '';

    if (!productId) {
        UI.toast('Сначала выберите товар (эталон) для применения!', 'warning');
        return;
    }

    if (!currentRecipeData || currentRecipeData.length === 0) {
        UI.toast('Рецепт пуст! Текущий состав пуст.', 'warning');
        return;
    }

    const feats = parseProductFeatures(productName);

    const htmlBody = `
        <div style="background: var(--surface-alt); padding: 15px; border-radius: 8px; margin-bottom: 20px;">
            <p style="margin-top:0; font-weight:600; margin-bottom: 10px;">Источник: <span class="text-primary">${productName}</span></p>
            <p style="font-size:13px; color:var(--text-muted); margin-bottom:15px;">Выберите фильтры, чтобы найти похожие товары для массового применения текущего рецепта.</p>
            
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                <div class="form-group" style="margin-bottom:0;">
                    <label style="font-size: 11px; font-weight: bold;">Вид продукции</label>
                    <select id="modal-filter-type" class="input-modern" onchange="updateMassApplyList(${productId})" style="padding: 6px; font-size: 14px;">
                        <option value="Все" ${feats.type==='Все'?'selected':''}>Все</option>
                        <option value="Плитка" ${feats.type==='Плитка'?'selected':''}>Плитка</option>
                        <option value="Бордюр" ${feats.type==='Бордюр'?'selected':''}>Бордюр</option>
                        <option value="Поребрик" ${feats.type==='Поребрик'?'selected':''}>Поребрик</option>
                        <option value="Блок" ${feats.type==='Блок'?'selected':''}>Блок</option>
                    </select>
                </div>
                <div class="form-group" style="margin-bottom:0;">
                    <label style="font-size: 11px; font-weight: bold;">Толщина</label>
                    <select id="modal-filter-thickness" class="input-modern" onchange="updateMassApplyList(${productId})" style="padding: 6px; font-size: 14px;">
                        <option value="Все" ${feats.thickness==='Все'?'selected':''}>Все</option>
                        <option value="40мм" ${feats.thickness==='40мм'?'selected':''}>40мм</option>
                        <option value="60мм" ${feats.thickness==='60мм'?'selected':''}>60мм</option>
                        <option value="80мм" ${feats.thickness==='80мм'?'selected':''}>80мм</option>
                    </select>
                </div>
                <div class="form-group" style="margin-bottom:0;">
                    <label style="font-size: 11px; font-weight: bold;">Фактура</label>
                    <select id="modal-filter-texture" class="input-modern" onchange="updateMassApplyList(${productId})" style="padding: 6px; font-size: 14px;">
                        <option value="Все" ${feats.texture==='Все'?'selected':''}>Все</option>
                        <option value="Гладкая" ${feats.texture==='Гладкая'?'selected':''}>Гладкая</option>
                        <option value="Гранит" ${feats.texture==='Гранит'?'selected':''}>Гранит</option>
                        <option value="Меланж гладкий" ${feats.texture==='Меланж гладкий'?'selected':''}>Меланж гладкий</option>
                        <option value="Меланж гранит" ${feats.texture==='Меланж гранит'?'selected':''}>Меланж гранит</option>
                    </select>
                </div>
                <div class="form-group" style="margin-bottom:0;">
                    <label style="font-size: 11px; font-weight: bold;">Цвет</label>
                    <select id="modal-filter-color" class="input-modern" onchange="updateMassApplyList(${productId})" style="padding: 6px; font-size: 14px;">
                        <option value="Все" ${feats.color==='Все'?'selected':''}>Все</option>
                        <option value="Серый" ${feats.color==='Серый'?'selected':''}>Серый</option>
                        <option value="Красный" ${feats.color==='Красный'?'selected':''}>Красный</option>
                        <option value="Черный" ${feats.color==='Черный'?'selected':''}>Черный</option>
                        <option value="Желтый" ${feats.color==='Желтый'?'selected':''}>Желтый</option>
                        <option value="Коричневый" ${feats.color==='Коричневый'?'selected':''}>Коричневый</option>
                        <option value="Белый" ${feats.color==='Белый'?'selected':''}>Белый</option>
                        <option value="Оранжевый" ${feats.color==='Оранжевый'?'selected':''}>Оранжевый</option>
                        <option value="Меланж Оникс" ${feats.color==='Меланж Оникс'?'selected':''}>Меланж Оникс</option>
                        <option value="Меланж Осень" ${feats.color==='Меланж Осень'?'selected':''}>Меланж Осень</option>
                        <option value="Меланж Янтарь" ${feats.color==='Меланж Янтарь'?'selected':''}>Меланж Янтарь</option>
                        <option value="Меланж Яшма" ${feats.color==='Меланж Яшма'?'selected':''}>Меланж Яшма</option>
                        <option value="Меланж Рубин" ${feats.color==='Меланж Рубин'?'selected':''}>Меланж Рубин</option>
                    </select>
                </div>
            </div>
        </div>

        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
            <strong class="text-main" style="font-size: 15px;">Целевые товары:</strong>
            <label style="font-size: 13px; cursor: pointer; display: flex; align-items: center; gap: 5px;">
                <input type="checkbox" id="mass-apply-select-all" checked onchange="document.querySelectorAll('.mass-apply-cb').forEach(cb => cb.checked = this.checked)">
                Выбрать все
            </label>
        </div>
        <div id="mass-apply-list" style="max-height: 250px; overflow-y: auto; border: 1px solid var(--border); border-radius: 6px; padding: 10px; background: var(--surface); display: flex; flex-direction: column; gap: 6px;">
            <!-- Сюда вставятся товары -->
        </div>
        <p style="font-size: 11px; color: var(--text-muted); margin-top: 10px;">* Внимание: Текущий состав сырья будет скопирован (добавлен/обновлен - UPSERT) в выбранные рецептуры.</p>
    `;

    const buttons = `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-blue" onclick="executeMassApply()">🚀 Применить к выбранным</button>
    `;

    UI.showModal('🎭 Массовое применение рецепта', htmlBody, buttons);
    
    setTimeout(() => { updateMassApplyList(productId); }, 50);
};

window.updateMassApplyList = function(sourceId) {
    const listEl = document.getElementById('mass-apply-list');
    const typeEl = document.getElementById('modal-filter-type');
    const thickEl = document.getElementById('modal-filter-thickness');
    
    if (!listEl || !typeEl) return;

    const fType = typeEl.value;
    const fThick = thickEl.value;
    const fTex = document.getElementById('modal-filter-texture').value;
    const fColor = document.getElementById('modal-filter-color').value;

    if (fType !== 'Плитка' && fType !== 'Все') {
        thickEl.disabled = true;
        thickEl.style.opacity = '0.5';
    } else {
        thickEl.disabled = false;
        thickEl.style.opacity = '1';
    }

    const matched = allRecipeProducts.filter(p => {
        if (p.id === sourceId) return false;
        const feats = parseProductFeatures(p.name);
        
        if (fType !== 'Все' && feats.type !== fType) return false;
        if ((fType === 'Плитка' || fType === 'Все') && fThick !== 'Все' && feats.thickness !== fThick) return false;
        if (fTex !== 'Все' && feats.texture !== fTex) return false;
        if (fColor !== 'Все' && feats.color !== fColor) return false;
        
        return true;
    });

    if (matched.length === 0) {
        listEl.innerHTML = '<div style="color: var(--text-muted); padding: 10px; text-align: center;">Товары, соответствующие фильтрам, не найдены.</div>';
    } else {
        listEl.innerHTML = matched.map(p => `
            <label class="sync-list-item" style="font-size: 13px; cursor: pointer; padding: 4px; border-bottom: 1px solid var(--border-light);">
                <input type="checkbox" class="mass-apply-cb" value="${p.id}" checked>
                ${p.name}
            </label>
        `).join('');
    }
    
    const selectAllCheck = document.getElementById('mass-apply-select-all');
    if (selectAllCheck) selectAllCheck.checked = matched.length > 0;
};

window.executeMassApply = async function() {
    const checkedBoxes = document.querySelectorAll('.mass-apply-cb:checked');
    if (checkedBoxes.length === 0) {
        UI.toast('Выберите хотя бы один товар!', 'error');
        return;
    }

    const payloadIngredients = currentRecipeData.map(ing => ({
        materialId: String(ing.materialId),
        qty: parseFloat(ing.qty)
    }));

    const targetIds = Array.from(checkedBoxes).map(cb => parseInt(cb.value));

    UI.toast('⏳ Применение...', 'info');
    UI.closeModal();

    try {
        const syncRes = await fetch('/api/recipes/sync-category', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                targetProductIds: targetIds,
                materials: payloadIngredients
            })
        });

        const syncData = await syncRes.json();
        if (syncRes.ok) {
            UI.toast('✅ ' + (syncData.message || 'Успешно применено!'), 'success');
        } else {
            UI.toast('❌ ' + (syncData.error || 'Ошибка применения'), 'error');
        }
    } catch (e) {
        console.error(e);
        UI.toast('Ошибка связи с сервером', 'error');
    }
}