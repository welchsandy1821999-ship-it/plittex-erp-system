;(function() {
// === public/js/recipes.js ===

let allMaterialsList = []; // Хранит список всего сырья
let currentRecipeData = []; // Хранит компоненты открытого сейчас рецепта
let allRecipeProducts = []; // Хранит список всей продукции с категориями
let originalRecipeData = []; // Хранит слепок рецепта ДО редактирования

window.currentRecipeMode = 'BOM'; // 'BOM' или 'MIX'
window.currentMixTemplates = {};
window.mixTemplateYields = {};
let recipeDragIndex = null;

const RECIPE_LAYER_META = {
    face: { label: 'Лицевой слой' },
    main: { label: 'Основной слой' },
    packaging: { label: 'Упаковка' }
};

const BOM_LAYER_ORDER = { face: 0, main: 1, packaging: 2 };

function sortBomCompareRowsByLayer(rows) {
    return [...(rows || [])].sort((a, b) => {
        const la = BOM_LAYER_ORDER[normalizeRecipeLayer(a.layer)] ?? 9;
        const lb = BOM_LAYER_ORDER[normalizeRecipeLayer(b.layer)] ?? 9;
        if (la !== lb) return la - lb;
        return Number(a.materialId) - Number(b.materialId);
    });
}

/** В каких блоках (слоях) есть любые отличия между сравниваемыми рецептами */
function bomCompareCollectDiffLayers(d) {
    if (!d || d.ingredientSetEqual) return [];
    const set = new Set();
    [...d.onlyA, ...d.onlyB, ...d.qtyDiff].forEach((r) => set.add(normalizeRecipeLayer(r.layer)));
    return ['face', 'main', 'packaging'].filter((ly) => set.has(ly));
}

function bomCompareLayerDiffSummary(d) {
    const layers = bomCompareCollectDiffLayers(d);
    if (!layers.length) return '';
    return layers.map((ly) => RECIPE_LAYER_META[ly].label.toLowerCase()).join(' · ');
}

function normalizeRecipeLayer(layer) {
    if (layer === 'face' || layer === 'main' || layer === 'packaging') return layer;
    return 'main';
}

// Эвристика определения слоя при ДОБАВЛЕНИИ нового материала через UI.
// Для уже сохранённых рецептов сервер всегда возвращает корректный layer через
// assembleRecipeRowsForProduct (production.js ~L82) — здесь она не вызывается.
// Долгосрочная замена: поле default_layer в items + возврат через /api/items.
function inferRecipeLayerByMaterial(name, category) {
    const n = String(name || '').toLowerCase();
    const c = String(category || '').toLowerCase();
    if (/упаков|палл?ет|поддон|пленк|стреп|этикет|мешок/.test(n) || /упаков/.test(c)) return 'packaging';
    if (/пигмент|красит|белый цемент|диоксид|пластификатор лиц/.test(n)) return 'face';
    return 'main';
}

function layerLabel(layer) {
    return RECIPE_LAYER_META[normalizeRecipeLayer(layer)].label;
}

function normalizeRecipeOrder(order) {
    const n = Number(order);
    return Number.isFinite(n) ? n : 0;
}

function clearTomSearch(ts) {
    if (!ts) return;
    // Совместимость с разными версиями TomSelect:
    // clearTextbox() есть не везде, поэтому чистим через control_input.
    if (typeof ts.clearTextbox === 'function') {
        ts.clearTextbox();
        return;
    }
    if (ts.control_input) {
        ts.control_input.value = '';
    }
    if (typeof ts.refreshOptions === 'function') {
        ts.refreshOptions(false);
    }
}

function updateRecipeLayerPlaceholderState() {
    const layerSelect = document.getElementById('recipe-material-layer');
    if (!layerSelect) return;
    layerSelect.classList.toggle('rec-select-placeholder', !layerSelect.value);
}

function setRecipeAddPanelOpen(isOpen) {
    const panel = document.getElementById('recipe-add-panel');
    const btn = document.getElementById('recipe-add-toggle-btn');
    const icon = document.getElementById('recipe-add-toggle-icon');
    const label = document.getElementById('recipe-add-toggle-text');
    if (!panel || !btn || !icon) return;

    panel.classList.toggle('is-open', isOpen);
    btn.classList.toggle('is-open', isOpen);
    btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    panel.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
    icon.textContent = isOpen ? '▴' : '▾';
    if (label) label.textContent = isOpen ? '— Скрыть форму' : '➕ Добавить сырье';
}

function toggleRecipeAddPanel() {
    const panel = document.getElementById('recipe-add-panel');
    if (!panel) return;
    setRecipeAddPanelOpen(!panel.classList.contains('is-open'));
}

function groupRecipeDataByLayerAndReindexOrders() {
    // Складываем строки в 3 группы и внутри сохраняем относительный порядок по current order.
    const buckets = { face: [], main: [], packaging: [] };
    (currentRecipeData || []).forEach((row) => {
        const layer = normalizeRecipeLayer(row.layer);
        buckets[layer].push(row);
    });

    Object.keys(buckets).forEach((layer) => {
        buckets[layer].sort((a, b) => normalizeRecipeOrder(a.order) - normalizeRecipeOrder(b.order));
    });

    const newArr = [...buckets.face, ...buckets.main, ...buckets.packaging];
    currentRecipeData = newArr.map((row, idx) => ({ ...row, order: idx }));
}

// 1. Инициализация модуля (загрузка списков при старте приложения)
async function loadRecipeModuleData() {
    try {
        // Грузим продукцию для левого списка
        const prodData = await API.get('/api/items?item_type=product&limit=500');
        allRecipeProducts = Array.isArray(prodData.data) ? prodData.data : [];
        const prodSelect = document.getElementById('recipe-product-select');
        prodSelect.innerHTML = '<option value="" disabled selected>-- Выберите продукцию --</option>';
        allRecipeProducts.forEach(p => prodSelect.add(new Option(p.name, p.id)));

        // Грузим сырье для правого списка (добавление компонентов)
        const matData = await API.get('/api/items?item_type=material&limit=500');
        allMaterialsList = matData.data;
        auditComputePigmentIds();

        const matSelect = document.getElementById('recipe-material-select');
        matSelect.innerHTML = '<option value="" disabled selected>-- Выберите сырье --</option>';
        allMaterialsList.forEach(m => {
            let opt = new Option(`${m.name} (${parseFloat(m.current_price)} ₽/${m.unit})`, m.id);
            opt.setAttribute('data-name', m.name);
            opt.setAttribute('data-unit', m.unit);
            opt.setAttribute('data-price', m.current_price);
            opt.setAttribute('data-category', m.category || '');
            opt.setAttribute('data-default-layer', m.default_layer || 'main');
            matSelect.add(opt);
        });

        initStaticRecipeSelects();

        // Загружаем данные для Второго Режима (Шаблоны)
        window.currentMixTemplates = await API.get('/api/mix-templates');
        window.mixTemplateYields = await API.get('/api/mix-template-yields');

    } catch (e) { console.error("Ошибка загрузки данных рецептов:", e); }
}

function initStaticRecipeSelects() {
    const prodEl = document.getElementById('recipe-product-select');
    if (prodEl) {
        if (!prodEl.tomselect) {
            new TomSelect(prodEl, {
                score: function(search) { const query = search.toLowerCase(); const qC = query.replace(/[\.\s-]/g, ''); const tkns = query.split(/\s+/).filter(Boolean); return function(item) { const txt = (item.text || '').toLowerCase(); const txtC = txt.replace(/[\.\s-]/g, ''); let mm = true; for (let t of tkns) { let tC = t.replace(/[\.\s-]/g, ''); if (!txt.includes(t) && (!tC || !txtC.includes(tC))) { mm = false; break; } } if (!mm) { if (qC.length < 2 || !txtC.includes(qC)) return 0; } let bs = 100 / (txt.length + 1); if (qC.length >= 2 && txtC.includes(qC)) bs += 1000; return bs; }; },
                plugins: ['clear_button'],
                dropdownParent: 'body',
                onFocus: function() {
                    // Повторный выбор: начинаем с полностью чистого поля.
                    // Для вашей версии TomSelect это самый надежный сценарий.
                    if (this.getValue && this.getValue()) {
                        this.clear(true);
                    }
                    clearTomSearch(this);
                },
                onChange: function(value) {
                    clearTomSearch(this);
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
                score: function(search) { const query = search.toLowerCase(); const qC = query.replace(/[\.\s-]/g, ''); const tkns = query.split(/\s+/).filter(Boolean); return function(item) { const txt = (item.text || '').toLowerCase(); const txtC = txt.replace(/[\.\s-]/g, ''); let mm = true; for (let t of tkns) { let tC = t.replace(/[\.\s-]/g, ''); if (!txt.includes(t) && (!tC || !txtC.includes(tC))) { mm = false; break; } } if (!mm) { if (qC.length < 2 || !txtC.includes(qC)) return 0; } let bs = 100 / (txt.length + 1); if (qC.length >= 2 && txtC.includes(qC)) bs += 1000; return bs; }; },
                plugins: ['clear_button'],
                dropdownParent: 'body',
                onChange: function(value) {
                    if (!value) return;
                    // Авто-суггестия слоя из default_layer материала
                    const sel = matEl.options[matEl.selectedIndex];
                    const suggestedLayer = sel ? sel.getAttribute('data-default-layer') : null;
                    const layerEl = document.getElementById('recipe-material-layer');
                    if (suggestedLayer && layerEl) {
                        layerEl.value = suggestedLayer;
                        if (typeof updateRecipeLayerPlaceholderState === 'function') {
                            updateRecipeLayerPlaceholderState();
                        }
                    }
                }
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

// 2. Загрузка рецепта при выборе продукта
async function loadRecipeDetails() {
    const prodSelect = document.getElementById('recipe-product-select');
    const productId = prodSelect.value;
    // Безопасное получение имени через TomSelect
    const tsP = prodSelect.tomselect;
    const productName = tsP
        ? (tsP.options[tsP.getValue()] ? tsP.options[tsP.getValue()].text : '')
        : (prodSelect.options[prodSelect.selectedIndex] ? prodSelect.options[prodSelect.selectedIndex].text : '');

    if (!productId) return;

    // Показываем правый блок и сводку
    document.getElementById('recipe-editor-area').classList.remove('d-none');
    document.getElementById('recipe-summary-card').classList.remove('d-none');
    document.getElementById('recipe-editor-title').innerText = `Рецепт: ${productName}`;

    try {
        // Запрашиваем с сервера уже сохраненный рецепт
        const data = await API.get(`/api/recipes/${productId}`);

        // Преобразуем данные в наш рабочий массив
        currentRecipeData = data.map(ing => ({
            materialId: ing.material_id,
            name: ing.material_name,
            qty: parseFloat(ing.quantity_per_unit),
            unit: ing.unit,
            price: parseFloat(ing.current_price) || 0,
            layer: normalizeRecipeLayer(ing.layer || inferRecipeLayerByMaterial(ing.material_name, ing.category)),
            order: normalizeRecipeOrder(ing.order)
        }));

        // Чтобы при загрузке уже заданные позиции были разложены по своим блокам
        groupRecipeDataByLayerAndReindexOrders();

        originalRecipeData = JSON.parse(JSON.stringify(currentRecipeData));
        renderRecipeTable();
        setRecipeAddPanelOpen(false);
        updateRecipeDirtyState(); // сбросить бейдж — только что загрузили
    } catch (e) { console.error("Ошибка загрузки рецепта:", e); }
}


window.switchRecipeMode = function(mode) {
    window.currentRecipeMode = mode;
    
    // Стили кнопок-табов
    const tabBom = document.getElementById('tab-recipes-bom');
    const tabMix = document.getElementById('tab-recipes-mix');
    if (tabBom) {
        tabBom.className = mode === 'BOM'
            ? 'btn btn-blue shadow-primary rec-main-tab'
            : 'btn btn-outline text-primary rec-main-tab';
        tabBom.setAttribute('aria-selected', mode === 'BOM' ? 'true' : 'false');
    }
    if (tabMix) {
        tabMix.className = mode === 'MIX'
            ? 'btn btn-blue shadow-primary rec-main-tab'
            : 'btn btn-outline text-primary rec-main-tab';
        tabMix.setAttribute('aria-selected', mode === 'MIX' ? 'true' : 'false');
    }

    const sheetBom = document.getElementById('recipe-sheet-bom');
    const sheetMix = document.getElementById('recipe-sheet-mix');
    if (sheetBom) sheetBom.classList.toggle('d-none', mode !== 'BOM');
    if (sheetMix) sheetMix.classList.toggle('d-none', mode !== 'MIX');

    // Видимость блоков выбора
    document.getElementById('recipe-left-mode-bom').classList.toggle('d-none', mode !== 'BOM');
    document.getElementById('recipe-left-mode-mix').classList.toggle('d-none', mode !== 'MIX');

    // Сбрасываем рабочую область
    document.getElementById('recipe-editor-area').classList.add('d-none');
    document.getElementById('recipe-summary-card').classList.add('d-none');
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

    document.getElementById('mix-yield-container').classList.toggle('d-none', mode !== 'MIX');

    document.getElementById('recipe-editor-badge').classList.add('d-none');

    // Меняем подписи в сводке
    if (mode === 'BOM') {
        document.getElementById('recipe-cost-label').innerText = 'Себестоимость (сырье):';
        document.getElementById('recipe-footer-hint').innerText = '* Расчет идет строго на 1 единицу измерения (указана в справочнике).';
    } else {
        document.getElementById('recipe-cost-label').innerText = 'Себестоимость Замеса:';
        document.getElementById('recipe-footer-hint').innerText = '* Расчет идет на весь Бетоносмеситель.';
    }
};


// Загрузка шаблона замеса (Режим 2)
window.loadMixTemplateDetails = function() {
    const ts = document.getElementById('mix-template-keys-select').tomselect;
    const templateKey = ts ? ts.getValue() : document.getElementById('mix-template-keys-select').value;
    if (!templateKey) return;
    
    const opt = document.querySelector(`#mix-template-keys-select option[value="${templateKey}"]`);
    const templateName = opt ? opt.innerText : templateKey;

    document.getElementById('recipe-editor-area').classList.remove('d-none');
    document.getElementById('recipe-summary-card').classList.remove('d-none');
    document.getElementById('recipe-editor-title').innerText = `Шаблон: ${templateName}`;

    const badgeEl = document.getElementById('recipe-editor-badge');
    badgeEl.classList.remove('d-none', 'bg-warning', 'text-warning', 'bg-border', 'text-main');
    if (templateKey.startsWith('main_')) {
        badgeEl.innerText = 'ОСНОВНОЙ ЗАМЕС';
        badgeEl.classList.add('bg-border', 'text-main');
    } else {
        badgeEl.innerText = 'ЛИЦЕВОЙ ЗАМЕС';
        badgeEl.classList.add('bg-warning', 'text-warning');
    }

    const tplData = window.currentMixTemplates[templateKey] || [];
    
    // Преобразуем формат mix_templates в currentRecipeData
    const templateLayer = templateKey.startsWith('face_') ? 'face' : 'main';
    currentRecipeData = tplData.map(mat => {
        const globalMat = allMaterialsList.find(m => String(m.id) === String(mat.id));
        return {
            materialId: parseInt(mat.id) || mat.id,
            name: mat.name,
            qty: parseFloat(mat.qty) || 0,
            unit: mat.unit || 'кг',
            price: globalMat ? parseFloat(globalMat.current_price) || 0 : 0,
            layer: templateLayer
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
    const layerSelect = document.getElementById('recipe-material-layer');
    const qtyInput = document.getElementById('recipe-material-qty');
    const qty = parseFloat(qtyInput.value);
    const selectedLayerRaw = layerSelect?.value || '';

    if (matSelect.selectedIndex <= 0 || !qty || qty <= 0 || !selectedLayerRaw) {
        return UI.toast("Выберите материал, блок рецепта и укажите количество больше нуля!", "warning");
    }

    const opt = matSelect.options[matSelect.selectedIndex];
    const materialId = parseInt(matSelect.value);
    const selectedLayer = normalizeRecipeLayer(selectedLayerRaw);

    // Проверяем, нет ли уже этого материала в рецепте
    const existingIndex = currentRecipeData.findIndex(i => i.materialId === materialId && normalizeRecipeLayer(i.layer) === selectedLayer);
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
            price: parseFloat(opt.getAttribute('data-price')) || 0,
            layer: selectedLayer,
            order: currentRecipeData.length
        });
    }

    // Сбрасываем поля добавления для следующего компонента
    qtyInput.value = '';
    if (layerSelect) {
        layerSelect.value = '';
        updateRecipeLayerPlaceholderState();
    }
    if (matSelect && matSelect.tomselect) {
        matSelect.tomselect.clear(true);
    } else if (matSelect) {
        matSelect.selectedIndex = 0;
    }

    groupRecipeDataByLayerAndReindexOrders();
    renderRecipeTable();
    setRecipeAddPanelOpen(false);
    updateRecipeDirtyState();
};

function removeIngredientFromRecipe(index) {
    currentRecipeData.splice(index, 1);
    groupRecipeDataByLayerAndReindexOrders();
    renderRecipeTable();
    updateRecipeDirtyState();
}

// 4.1. Обновление количества при редактировании в таблице
function updateIngredientQty(index, newValue) {
    const val = parseFloat(newValue);
    if (isNaN(val) || val < 0) return;
    if (currentRecipeData[index]) {
        currentRecipeData[index].qty = val;
        // Пересчитываем сводку без полной перерисовки таблицы
        let totalWeight = 0;
        let totalCost = 0;
        currentRecipeData.forEach(ing => {
            totalWeight += ing.qty;
            totalCost += ing.qty * ing.price;
        });
        const weightEl = document.getElementById('recipe-total-weight');
        const costEl = document.getElementById('recipe-total-cost');
        if (weightEl) weightEl.innerText = `${totalWeight.toFixed(2)} кг`;
        if (costEl) costEl.innerText = `${totalCost.toFixed(2)} ₽`;
        // Обновляем стоимость в этой строке
        // Структура: cells[0]=drag,1=layer,2=name,3=qty,4=unit,5=cost,6=del
        const row = document.getElementById('recipe-table-body').rows[index];
        if (row && row.cells[5]) {
            row.cells[5].innerText = (val * currentRecipeData[index].price).toFixed(2) + ' ₽';
        }
        if (window.currentRecipeMode === 'MIX' && typeof window.recalculateMixUnitCost === 'function') {
            window.recalculateMixUnitCost();
        }
    }
}

function updateIngredientLayer(index, newLayer) {
    const target = currentRecipeData[index];
    if (!target) return;
    target.layer = normalizeRecipeLayer(newLayer);
    groupRecipeDataByLayerAndReindexOrders();
    renderRecipeTable();
}

function recipeReindexOrder() {
    groupRecipeDataByLayerAndReindexOrders();
}

window.onRecipeDragStart = function(index, e) {
    recipeDragIndex = Number(index);
    if (Number.isNaN(recipeDragIndex)) return;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
    const tr = e.currentTarget;
    if (tr) tr.classList.add('rec-row-dragging');
};

window.onRecipeDragOver = function(index, e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const tr = e.currentTarget;
    if (tr) tr.classList.add('rec-row-drop-target');
};

window.onRecipeDragLeave = function(_index, e) {
    const tr = e.currentTarget;
    if (tr) tr.classList.remove('rec-row-drop-target');
};

window.onRecipeDrop = function(dropIndex, e) {
    e.preventDefault();
    const fromRaw = e.dataTransfer.getData('text/plain');
    const fromIndex = Number(fromRaw);
    const toIndex = Number(dropIndex);
    const tr = e.currentTarget;
    if (tr) tr.classList.remove('rec-row-drop-target');
    if (Number.isNaN(fromIndex) || Number.isNaN(toIndex) || fromIndex === toIndex) return;

    // Автоматически меняем слой при переносе между группами —
    // без этого groupRecipeDataByLayerAndReindexOrders возвращал бы строку обратно в исходный слой.
    const srcLayer = normalizeRecipeLayer(currentRecipeData[fromIndex]?.layer);
    const dstLayer = normalizeRecipeLayer(currentRecipeData[toIndex]?.layer);
    const moved = currentRecipeData.splice(fromIndex, 1)[0];
    if (dstLayer && dstLayer !== srcLayer) {
        moved.layer = dstLayer;
    }
    // После splice(fromIndex) все индексы > fromIndex сдвигаются на -1
    const insertAt = toIndex > fromIndex ? toIndex - 1 : toIndex;
    currentRecipeData.splice(insertAt, 0, moved);
    recipeReindexOrder();
    renderRecipeTable();
    updateRecipeDirtyState();
};

window.onRecipeDragEnd = function(_index, e) {
    recipeDragIndex = null;
    document.querySelectorAll('.rec-row-drop-target').forEach((el) => el.classList.remove('rec-row-drop-target'));
    const tr = e.currentTarget;
    if (tr) tr.classList.remove('rec-row-dragging');
};

// 5. Отрисовка таблицы и пересчет сводки
function renderRecipeTable() {
    const tbody = document.getElementById('recipe-table-body');
    const emptyMsg = document.getElementById('recipe-empty-msg');

    let totalWeight = 0;
    let totalCost = 0;

    if (currentRecipeData.length === 0) {
        tbody.innerHTML = '';
        if (emptyMsg) emptyMsg.classList.remove('d-none');
    } else {
        if (emptyMsg) emptyMsg.classList.add('d-none');
        const ordered = [...currentRecipeData].map((ing, index) => ({ ing, index }));
        let lastLayer = '';
        tbody.innerHTML = ordered.map(({ ing, index }) => {
            const cost = ing.qty * ing.price;
            totalWeight += ing.qty;
            totalCost += cost;
            const layer = normalizeRecipeLayer(ing.layer);
            const layerHeader = layer !== lastLayer
                ? `<tr><td colspan="7" class="rec-layer-header-cell">${layerLabel(layer)}</td></tr>`
                : '';
            lastLayer = layer;

            return `
                ${layerHeader}
                <tr class="rec-row-draggable" draggable="true"
                    ondragstart="onRecipeDragStart(${index}, event)"
                    ondragover="onRecipeDragOver(${index}, event)"
                    ondragleave="onRecipeDragLeave(${index}, event)"
                    ondrop="onRecipeDrop(${index}, event)"
                    ondragend="onRecipeDragEnd(${index}, event)">
                    <td class="rec-cell-padding rec-cell-center rec-drag-cell"><span class="rec-drag-handle">↕</span></td>
                    <td class="rec-cell-padding">
                        <select class="input-modern rec-layer-select" onchange="updateIngredientLayer(${index}, this.value)">
                            <option value="face" ${layer === 'face' ? 'selected' : ''}>Лицевой слой</option>
                            <option value="main" ${layer === 'main' ? 'selected' : ''}>Основной слой</option>
                            <option value="packaging" ${layer === 'packaging' ? 'selected' : ''}>Упаковка</option>
                        </select>
                    </td>
                    <td class="rec-cell-padding"><strong>${ing.name}</strong></td>
                    <td class="rec-cell-padding rec-cell-right">
                        <input type="number" class="input-modern rec-table-input" 
                            value="${ing.qty}" 
                            onfocus="this.select()"
                            onchange="updateIngredientQty(${index}, this.value)" 
                            step="0.001" min="0">
                    </td>
                    <td class="rec-cell-padding">${ing.unit}</td>
                    <td class="rec-cell-padding rec-cell-right">${cost.toFixed(2)} ₽</td>
                    <td class="rec-cell-padding rec-cell-center">
                        <button class="btn btn-outline rec-delete-btn" onclick="removeIngredientFromRecipe(${index})">❌</button>
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
    // Читаем из state (currentRecipeData), а не из DOM innerText —
    // parseFloat(innerText) ломается при форматировании с разделителями/символами.
    const totalBatchCost = (currentRecipeData || []).reduce(
        (s, ing) => s + (Number(ing.qty) || 0) * (Number(ing.price) || 0), 0
    );
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

// --- Сравнение шаблонов замесов (данные из кэша currentMixTemplates / mixTemplateYields) ---
function mixQtyCanonical(q) {
    const n = Number(q);
    if (!Number.isFinite(n)) return '0.0000';
    return n.toFixed(4);
}

function getNormalizedMixIngredients(templateKey) {
    const raw = window.currentMixTemplates[templateKey] || [];
    const arr = raw.map(x => ({
        id: String(x.id),
        name: String(x.name || ''),
        qty: Number(x.qty) || 0,
        unit: String(x.unit || 'кг')
    }));
    arr.sort((a, b) => a.id.localeCompare(b.id));
    return arr;
}

function fingerprintMixIngredients(norm) {
    return norm.map(r => `${r.id}:${mixQtyCanonical(r.qty)}`).join('|');
}

function compareMixTemplatesPair(keyA, keyB) {
    const ya = parseFloat(window.mixTemplateYields[keyA]) || 1;
    const yb = parseFloat(window.mixTemplateYields[keyB]) || 1;
    const na = getNormalizedMixIngredients(keyA);
    const nb = getNormalizedMixIngredients(keyB);
    const mapA = new Map(na.map(x => [x.id, x]));
    const mapB = new Map(nb.map(x => [x.id, x]));
    const same = [];
    const onlyA = [];
    const onlyB = [];
    const qtyDiff = [];
    for (const [, a] of mapA) {
        const b = mapB.get(a.id);
        if (!b) onlyA.push(a);
        else if (Math.abs(a.qty - b.qty) > 1e-6) qtyDiff.push({ id: a.id, name: a.name || b.name, qtyA: a.qty, qtyB: b.qty, unit: a.unit || b.unit });
        else same.push(a);
    }
    for (const [, b] of mapB) {
        if (!mapA.has(b.id)) onlyB.push(b);
    }
    const yieldMatch = Math.abs(ya - yb) < 1e-6;
    const fpA = fingerprintMixIngredients(na);
    const fpB = fingerprintMixIngredients(nb);
    return {
        ya,
        yb,
        yieldMatch,
        fingerprintEqual: fpA === fpB,
        ingredientSetEqual: onlyA.length === 0 && onlyB.length === 0 && qtyDiff.length === 0,
        same,
        onlyA,
        onlyB,
        qtyDiff,
        countA: na.length,
        countB: nb.length
    };
}

function mixCompareMatrixSymbol(d) {
    if (d.ingredientSetEqual && d.yieldMatch) return { sym: '=', cls: 'rec-mtx-eq', tip: 'Идентично' };
    if (d.fingerprintEqual && !d.yieldMatch) return { sym: '~', cls: 'rec-mtx-yld', tip: 'Состав совпадает, другой выход' };
    return { sym: '≠', cls: 'rec-mtx-diff', tip: 'Различаются позиции или количества' };
}

function buildMixCompareMatrixCells(list) {
    const n = list.length;
    const cache = [];
    for (let i = 0; i < n; i++) {
        cache[i] = [];
        for (let j = 0; j < n; j++) {
            if (i === j) cache[i][j] = { sym: '—', cls: 'rec-mtx-diag', tip: 'Этот же шаблон' };
            else if (j < i) cache[i][j] = cache[j][i];
            else {
                const dcmp = compareMixTemplatesPair(list[i].key, list[j].key);
                cache[i][j] = mixCompareMatrixSymbol(dcmp);
            }
        }
    }
    return cache;
}

function buildMixCompareMatrixTsv(list) {
    const cells = buildMixCompareMatrixCells(list);
    const safe = (s) => String(s || '').replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
    const rows = [[''].concat(list.map((m) => safe(m.key)))];
    list.forEach((_, i) => {
        const row = [safe(list[i].label)];
        for (let j = 0; j < list.length; j++) {
            row.push(String(cells[i][j].sym));
        }
        rows.push(row);
    });
    return rows.map(r => r.join('\t')).join('\n');
}

function mixCompareOptionLabel(key) {
    const q = document.querySelector(`#mix-template-keys-select option[value="${key}"]`);
    return q ? q.textContent.trim() : key;
}

async function mixCompareWriteClipboard(text) {
    try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(text);
        } else {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.left = '-9999px';
            document.body.appendChild(ta);
            ta.focus();
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
        }
        UI.toast('Скопировано в буфер обмена', 'success');
    } catch (e) {
        console.error(e);
        UI.toast('Не удалось скопировать', 'error');
    }
}

function buildMixKeyMetaList() {
    const sel = document.getElementById('mix-template-keys-select');
    if (!sel) return [];
    const out = [];
    sel.querySelectorAll('option[value]').forEach((opt) => {
        const key = opt.value;
        if (!key) return;
        const og = opt.closest('optgroup');
        const groupLabel = og ? og.label : '';
        const layerType = key.startsWith('main_') ? 'main' : (key.startsWith('face_') ? 'face' : 'other');
        const mixGroup = MIX_GROUPS.find(g => g.keys.includes(key));
        const norm = getNormalizedMixIngredients(key);
        out.push({
            key,
            label: (opt.textContent || '').trim(),
            groupLabel,
            layerType,
            mixGroupId: mixGroup ? mixGroup.groupId : '',
            mixGroupName: mixGroup ? mixGroup.name : '',
            fingerprint: fingerprintMixIngredients(norm),
            count: norm.length,
            yieldVal: parseFloat(window.mixTemplateYields[key]) || 1
        });
    });
    return out;
}

function filterMixCompareMeta(list, layerFilter, groupId, search) {
    let r = list.slice();
    if (layerFilter === 'main') r = r.filter(x => x.layerType === 'main');
    else if (layerFilter === 'face') r = r.filter(x => x.layerType === 'face');
    if (groupId && groupId !== 'all') {
        const g = MIX_GROUPS.find(x => x.groupId === groupId);
        if (g) r = r.filter(x => g.keys.includes(x.key));
    }
    const q = (search || '').trim().toLowerCase();
    if (q) {
        r = r.filter(x => x.label.toLowerCase().includes(q) || x.key.toLowerCase().includes(q));
    }
    return r;
}

function refreshOpenMixTemplateIfTouched(keys) {
    const ts = document.getElementById('mix-template-keys-select').tomselect;
    const cur = ts ? ts.getValue() : document.getElementById('mix-template-keys-select').value;
    if (cur && keys.includes(cur) && typeof window.loadMixTemplateDetails === 'function') {
        loadMixTemplateDetails();
    }
}

window.executeBulkMixTemplatesFromSource = async function (sourceKey, targetKeys, options = {}) {
    const propagateYield = !!options.propagateYield;
    const closeModal = options.closeModal === true;
    if (closeModal && typeof UI.closeModal === 'function') UI.closeModal();

    if (!sourceKey || !Array.isArray(targetKeys) || targetKeys.length === 0) {
        UI.toast('Нет целей для копирования', 'error');
        return false;
    }
    const raw = window.currentMixTemplates[sourceKey];
    if (!raw || !Array.isArray(raw)) {
        UI.toast('Нет состава источника в памяти. Обновите страницу или снова откройте рецептуры.', 'error');
        return false;
    }

    const payloadBase = raw.map(ing => ({
        id: String(ing.id),
        name: ing.name,
        qty: parseFloat(ing.qty),
        unit: ing.unit || 'кг'
    }));
    const sourceYield = parseFloat(window.mixTemplateYields[sourceKey]) || 1;

    UI.toast('⏳ Сохранение шаблонов...', 'info');
    try {
        await Promise.all(targetKeys.map((key) => {
            const yld = propagateYield ? sourceYield : (parseFloat(window.mixTemplateYields[key]) || 1);
            const ingredients = payloadBase.map(row => ({ ...row }));
            return API.post('/api/mix-templates/single', {
                templateKey: key,
                yieldValue: yld,
                ingredients
            }).then(() => {
                window.currentMixTemplates[key] = JSON.parse(JSON.stringify(payloadBase));
                window.mixTemplateYields[key] = yld;
            });
        }));

        UI.toast(`✅ Обновлено шаблонов: ${targetKeys.length}`, 'success');
        refreshOpenMixTemplateIfTouched(targetKeys);
        return true;
    } catch (e) {
        console.error(e);
        const msg = (e.body && (e.body.error || e.body.warning)) || e.message || 'Ошибка сохранения';
        UI.toast(String(msg), 'error');
        return false;
    }
};

function getMixCompareSelectOptionsHtml() {
    const sel = document.getElementById('mix-template-keys-select');
    if (!sel) return '';
    let html = '';
    Array.from(sel.children).forEach((child) => {
        if (child.tagName === 'OPTGROUP') {
            const lab = Utils.escapeHtml(String(child.label || ''));
            html += `<optgroup label="${lab}">`;
            Array.from(child.children).forEach((opt) => {
                if (!opt.value) return;
                const t = (opt.textContent || '').trim();
                html += `<option value="${opt.value}">${Utils.escapeHtml(t)}</option>`;
            });
            html += '</optgroup>';
        } else if (child.tagName === 'OPTION' && child.value) {
            const t = (child.textContent || '').trim();
            html += `<option value="${child.value}">${Utils.escapeHtml(t)}</option>`;
        }
    });
    return html;
}

window.switchMixCompareTab = function (tab) {
    document.querySelectorAll('.rec-compare-tab-btn').forEach((btn) => {
        const on = btn.getAttribute('data-tab') === tab;
        btn.classList.toggle('btn-blue', on);
        btn.classList.toggle('shadow-primary', on);
        btn.classList.toggle('btn-outline', !on);
        btn.classList.toggle('text-primary', !on);
    });
    document.querySelectorAll('.rec-compare-panel').forEach((panel) => {
        panel.classList.toggle('d-none', panel.getAttribute('data-panel') !== tab);
    });
    if (tab === 'baseline' && typeof window.refreshMixCompareBaseline === 'function') window.refreshMixCompareBaseline();
    if (tab === 'clones' && typeof window.refreshMixCompareClones === 'function') window.refreshMixCompareClones();
    if (tab === 'matrix' && typeof window.refreshMixCompareMatrix === 'function') window.refreshMixCompareMatrix();
};

window.refreshMixComparePair = function () {
    const aEl = document.getElementById('mix-compare-a');
    const bEl = document.getElementById('mix-compare-b');
    const sumEl = document.getElementById('mix-compare-pair-summary');
    const tablesEl = document.getElementById('mix-compare-pair-tables');
    if (!sumEl || !tablesEl || !aEl || !bEl) return;

    const a = aEl.value;
    const b = bEl.value;
    if (!a || !b) return;

    if (a === b) {
        sumEl.innerHTML = '<span class="rec-compare-chip bad">Выберите два разных шаблона</span>';
        tablesEl.innerHTML = '';
        return;
    }

    const d = compareMixTemplatesPair(a, b);
    const optLabel = (k) => {
        const q = document.querySelector(`#mix-template-keys-select option[value="${k}"]`);
        return q ? q.textContent.trim() : k;
    };

    let chips = '';
    if (d.ingredientSetEqual && d.yieldMatch) chips += '<span class="rec-compare-chip ok">Полное совпадение состава и выхода</span>';
    else {
        chips += d.ingredientSetEqual
            ? '<span class="rec-compare-chip ok">Состав совпадает</span>'
            : '<span class="rec-compare-chip warn">Состав различается</span>';
        chips += d.yieldMatch
            ? '<span class="rec-compare-chip ok">Выход совпадает</span>'
            : `<span class="rec-compare-chip warn">Выход: ${d.ya} ≠ ${d.yb}</span>`;
    }
    chips += `<span class="rec-compare-chip">${d.countA} поз. / ${d.countB} поз.</span>`;
    sumEl.innerHTML = chips;

    const esc = (s) => Utils.escapeHtml(String(s));
    const row = (cls, cells) => `<tr class="${cls}">${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
    const fmt = (q) => (Number.isFinite(Number(q)) ? Number(q).toFixed(3) : '0');

    let inner = '';

    if (d.same.length) {
        inner += '<p class="rec-compare-subtitle">Совпадают (материал и количество)</p><div class="rec-compare-table-wrap"><table class="rec-compare-table"><thead><tr><th>Сырьё</th><th class="rec-cell-right">Кол-во</th><th>Ед.</th></tr></thead><tbody>';
        d.same.forEach((x) => {
            inner += row('', [esc(x.name), fmt(x.qty), esc(x.unit)]);
        });
        inner += '</tbody></table></div>';
    }

    if (d.qtyDiff.length) {
        inner += '<p class="rec-compare-subtitle">Те же материалы, разное количество</p><div class="rec-compare-table-wrap"><table class="rec-compare-table"><thead><tr><th>Сырьё</th><th class="rec-cell-right">В A</th><th class="rec-cell-right">В B</th><th>Ед.</th></tr></thead><tbody>';
        d.qtyDiff.forEach((x) => {
            inner += row('rec-compare-row-qty', [esc(x.name), fmt(x.qtyA), fmt(x.qtyB), esc(x.unit)]);
        });
        inner += '</tbody></table></div>';
    }

    if (d.onlyA.length) {
        inner += `<p class="rec-compare-subtitle">Только в «A» — ${esc(optLabel(a))}</p><div class="rec-compare-table-wrap"><table class="rec-compare-table"><thead><tr><th>Сырьё</th><th class="rec-cell-right">Кол-во</th><th>Ед.</th></tr></thead><tbody>`;
        d.onlyA.forEach((x) => {
            inner += row('rec-compare-row-onlya', [esc(x.name), fmt(x.qty), esc(x.unit)]);
        });
        inner += '</tbody></table></div>';
    }

    if (d.onlyB.length) {
        inner += `<p class="rec-compare-subtitle">Только в «B» — ${esc(optLabel(b))}</p><div class="rec-compare-table-wrap"><table class="rec-compare-table"><thead><tr><th>Сырьё</th><th class="rec-cell-right">Кол-во</th><th>Ед.</th></tr></thead><tbody>`;
        d.onlyB.forEach((x) => {
            inner += row('rec-compare-row-onlyb', [esc(x.name), fmt(x.qty), esc(x.unit)]);
        });
        inner += '</tbody></table></div>';
    }

    if (!inner) {
        inner = '<p class="text-muted font-13">Оба шаблона пусты.</p>';
    }
    tablesEl.innerHTML = inner;
};

window.mixCompareApplyPair = async function (direction) {
    const a = document.getElementById('mix-compare-a').value;
    const b = document.getElementById('mix-compare-b').value;
    const propagateYieldEl = document.getElementById('mix-compare-pair-propagate-yield');
    const propagateYield = propagateYieldEl ? propagateYieldEl.checked : false;
    if (!a || !b || a === b) {
        UI.toast('Укажите два разных шаблона', 'error');
        return;
    }
    const target = direction === 'AtoB' ? b : a;
    const source = direction === 'AtoB' ? a : b;
    const arrow = direction === 'AtoB' ? 'A → B' : 'B → A';
    const msg = `Скопировать состав (${arrow})? Будет перезаписан шаблон «${target}».`;
    window.__recipeConfirm = async function() {
        UI.closeModal();
        const ok = await window.executeBulkMixTemplatesFromSource(source, [target], { propagateYield, closeModal: false });
        if (ok) {
            window.refreshMixComparePair();
            if (typeof window.refreshMixCompareBaseline === 'function') window.refreshMixCompareBaseline();
            if (typeof window.refreshMixCompareClones === 'function') window.refreshMixCompareClones();
            if (typeof window.refreshMixCompareMatrix === 'function') window.refreshMixCompareMatrix();
        }
    };
    UI.showModal('Подтверждение копирования',
        `<div class="p-10 font-15">${Utils.escapeHtml(msg)}</div>`,
        `<button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
         <button class="btn btn-blue shadow-primary" onclick="window.__recipeConfirm()">Скопировать</button>`
    );
};

window.refreshMixCompareBaseline = function () {
    const host = document.getElementById('mix-compare-baseline-body');
    if (!host) return;

    const fmtY = (y) => {
        const n = Number(y);
        return Number.isFinite(n) ? n.toFixed(3) : '—';
    };

    const layer = (document.getElementById('mix-compare-filter-layer') || {}).value || 'all';
    const groupId = (document.getElementById('mix-compare-filter-group') || {}).value || 'all';
    const search = (document.getElementById('mix-compare-filter-search') || {}).value || '';
    const refEl = document.getElementById('mix-compare-baseline-ref');
    const refKey = refEl ? refEl.value : '';

    const all = buildMixKeyMetaList();
    const filtered = filterMixCompareMeta(all, layer, groupId, search);

    if (!refKey) {
        host.innerHTML = '<p class="text-muted font-13">Выберите эталон.</p>';
        return;
    }

    const esc = (s) => Utils.escapeHtml(String(s));
    let rows = '';

    filtered.forEach((meta) => {
        if (meta.key === refKey) return;
        const d = compareMixTemplatesPair(refKey, meta.key);
        let statusClass = 'ok';
        let statusText = '';

        if (d.ingredientSetEqual && d.yieldMatch) {
            statusText = 'Идентично эталону';
            statusClass = 'ok';
        } else if (d.fingerprintEqual && !d.yieldMatch) {
            statusText = 'Состав совпадает, выход отличается';
            statusClass = 'warn';
        } else {
            const bits = [];
            if (!d.yieldMatch) bits.push(`выход ${fmtY(d.ya)}≠${fmtY(d.yb)}`);
            if (d.onlyB.length) bits.push(`+${d.onlyB.length} только в цели`);
            if (d.onlyA.length) bits.push(`−${d.onlyA.length} нет в цели`);
            if (d.qtyDiff.length) bits.push(`±${d.qtyDiff.length} кол-ва`);
            statusText = bits.length ? bits.join('; ') : 'Различия';
            statusClass = 'bad';
        }

        const checked = !(d.ingredientSetEqual && d.yieldMatch);
        const diffAttr = checked ? 'data-diff="1"' : 'data-diff="0"';
        rows += `<tr>
            <td class="rec-cell-center"><input type="checkbox" class="mix-compare-baseline-cb" value="${meta.key}" ${diffAttr} ${checked ? 'checked' : ''}></td>
            <td>${esc(meta.label)}</td>
            <td><span class="rec-compare-chip ${statusClass}">${esc(statusText)}</span></td>
            <td class="rec-cell-right">${fmtY(meta.yieldVal)}</td>
        </tr>`;
    });

    host.innerHTML = `
        <div class="rec-compare-table-wrap" style="max-height:320px">
            <table class="rec-compare-table">
                <thead>
                    <tr>
                        <th class="rec-cell-center" style="width:40px"><input type="checkbox" id="mix-compare-baseline-master" title="Только строки с отличиями от эталона / снять все" onchange="mixCompareBaselineToggleAll(this.checked)"></th>
                        <th>Шаблон</th>
                        <th>Отличие от эталона</th>
                        <th class="rec-cell-right">Выход</th>
                    </tr>
                </thead>
                <tbody>${rows || '<tr><td colspan="4" class="text-muted p-10">Нет строк по фильтру</td></tr>'}</tbody>
            </table>
        </div>
        <p class="rec-help-text mt-10">Эталон: состав и выход из кэша (последняя загрузка модуля или сохранение).</p>
    `;

    const master = document.getElementById('mix-compare-baseline-master');
    if (master) {
        const any = !!document.querySelector('.mix-compare-baseline-cb');
        master.disabled = !any;
    }
};

window.mixCompareBaselineToggleAll = function (checked) {
    document.querySelectorAll('.mix-compare-baseline-cb').forEach((cb) => {
        if (!checked) cb.checked = false;
        else cb.checked = cb.getAttribute('data-diff') === '1';
    });
};

window.mixCompareApplyBaseline = function () {
    const refKey = (document.getElementById('mix-compare-baseline-ref') || {}).value;
    const propagateYield = document.getElementById('mix-compare-baseline-propagate-yield').checked;
    const targets = Array.from(document.querySelectorAll('.mix-compare-baseline-cb:checked')).map(cb => cb.value).filter(Boolean);
    if (!refKey) {
        UI.toast('Выберите эталон', 'error');
        return;
    }
    if (targets.length === 0) {
        UI.toast('Отметьте хотя бы один целевой шаблон', 'error');
        return;
    }
    window.__recipeConfirm = function() {
        UI.closeModal();
        window.executeBulkMixTemplatesFromSource(refKey, targets, { propagateYield, closeModal: false }).then((ok) => {
            if (ok) {
                window.refreshMixCompareBaseline();
                window.refreshMixCompareClones();
                window.refreshMixComparePair();
                if (typeof window.refreshMixCompareMatrix === 'function') window.refreshMixCompareMatrix();
            }
        });
    };
    UI.showModal('Подтверждение',
        `<div class="p-10 font-15">Применить эталон к <strong>${targets.length}</strong> шаблонам?<br><span class="text-muted font-13">Отмеченные строки будут перезаписаны.</span></div>`,
        `<button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
         <button class="btn btn-blue shadow-primary" onclick="window.__recipeConfirm()">Применить</button>`
    );
};

window.refreshMixCompareClones = function () {
    const host = document.getElementById('mix-compare-clones-body');
    if (!host) return;

    const layer = (document.getElementById('mix-compare-clones-filter-layer') || {}).value || 'all';
    const groupId = (document.getElementById('mix-compare-clones-filter-group') || {}).value || 'all';
    const search = (document.getElementById('mix-compare-clones-filter-search') || {}).value || '';
    const all = buildMixKeyMetaList();
    const filtered = filterMixCompareMeta(all, layer, groupId, search);
    const map = new Map();
    filtered.forEach((m) => {
        const k = `${m.fingerprint}|y:${mixQtyCanonical(m.yieldVal)}`;
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(m);
    });
    const groups = Array.from(map.values()).sort((a, b) => b.length - a.length);
    const esc = (s) => Utils.escapeHtml(String(s));

    let html = '';
    groups.forEach((g, idx) => {
        const sample = g[0];
        const title = g.length > 1
            ? `Группа ${idx + 1}: ${g.length} шаблонов — ${sample.count} поз., выход ${Number(sample.yieldVal).toFixed(3)}`
            : `Одиночный: ${sample.label} — ${sample.count} поз., выход ${Number(sample.yieldVal).toFixed(3)}`;
        html += `<div class="rec-panel rec-panel-compact mb-10"><p class="rec-panel-title m-0 font-13">${esc(title)}</p><ul class="m-0 pl-20 font-13">`;
        g.forEach((x) => {
            html += `<li>${esc(x.label)} <span class="text-muted">(${esc(x.key)})</span></li>`;
        });
        html += '</ul></div>';
    });
    host.innerHTML = html || '<p class="text-muted font-13">Нет данных.</p>';
};

window.refreshMixCompareMatrix = function () {
    const host = document.getElementById('mix-compare-matrix-body');
    const note = document.getElementById('mix-compare-matrix-note');
    if (!host) return;

    const layer = (document.getElementById('mix-compare-matrix-layer') || {}).value || 'all';
    const groupId = (document.getElementById('mix-compare-matrix-group') || {}).value || 'all';
    const search = (document.getElementById('mix-compare-matrix-search') || {}).value || '';
    const filtered = filterMixCompareMeta(buildMixKeyMetaList(), layer, groupId, search);

    if (filtered.length === 0) {
        host.innerHTML = '';
        if (note) note.textContent = 'Нет шаблонов по фильтру.';
        return;
    }

    const MAX = 32;
    const list = filtered.length > MAX ? filtered.slice(0, MAX) : filtered;
    if (note) {
        note.textContent = filtered.length > MAX
            ? `Показаны первые ${MAX} из ${filtered.length} — сузьте фильтр для полной матрицы. Обозначения: = всё совпадает · ~ состав совпадает, выход разный · ≠ есть отличия.`
            : `Шаблонов: ${list.length}. Обозначения: = всё совпадает · ~ состав совпадает, выход разный · ≠ есть отличия.`;
    }

    const cells = buildMixCompareMatrixCells(list);
    const esc = (s) => Utils.escapeHtml(String(s));
    const shortTxt = (txt, max) => {
        const t = String(txt || '');
        return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
    };

    let head = `<tr><th class="rec-mtx-corner rec-mtx-colhead">${esc('Шаблон')}</th>`;
    list.forEach((m) => {
        head += `<th class="rec-mtx-colhead" title="${esc(`${m.label} (${m.key})`)}">${esc(shortTxt(m.label, 14))}</th>`;
    });
    head += '</tr>';

    let body = '';
    for (let i = 0; i < list.length; i++) {
        const m = list[i];
        body += `<tr><th scope="row" class="rec-mtx-rowhead" title="${esc(`${m.label} (${m.key})`)}">${esc(shortTxt(m.label, 18))}</th>`;
        for (let j = 0; j < list.length; j++) {
            const c = cells[i][j];
            body += `<td class="${c.cls}" title="${esc(c.tip)}">${esc(c.sym)}</td>`;
        }
        body += '</tr>';
    }

    host.innerHTML = `<div class="rec-mtx-wrap"><table class="rec-mtx-table"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
};

window.mixCompareCopyMatrixTsv = async function () {
    const layer = (document.getElementById('mix-compare-matrix-layer') || {}).value || 'all';
    const groupId = (document.getElementById('mix-compare-matrix-group') || {}).value || 'all';
    const search = (document.getElementById('mix-compare-matrix-search') || {}).value || '';
    let filtered = filterMixCompareMeta(buildMixKeyMetaList(), layer, groupId, search);
    const MAX = 32;
    const truncated = filtered.length > MAX;
    if (truncated) filtered = filtered.slice(0, MAX);

    if (filtered.length === 0) {
        UI.toast('Нет данных для экспорта', 'warning');
        return;
    }

    const legend = '= идентично\t~ только выход\t≠ отличия состава/количеств';
    const head = `Матрица сравнения (TSV)\tфильтр слой=${layer}\tгруппа=${groupId}${truncated ? `\t(первые ${MAX} из полного списка)` : ''}`;
    const blob = [head, legend, '', buildMixCompareMatrixTsv(filtered)].join('\n');
    await mixCompareWriteClipboard(blob);
};

window.mixCompareExportWorkbenchSnapshot = async function () {
    const fmtY = (y) => {
        const n = Number(y);
        return Number.isFinite(n) ? n.toFixed(3) : '—';
    };

    const lines = [
        'Сводка: сравнение шаблонов замесов',
        `Время (UTC): ${new Date().toISOString()}`,
        '',
        '--- Пара ---',
    ];

    const aEl = document.getElementById('mix-compare-a');
    const bEl = document.getElementById('mix-compare-b');
    if (aEl && bEl && aEl.value && bEl.value) {
        const ka = aEl.value;
        const kb = bEl.value;
        if (ka !== kb) {
            const d = compareMixTemplatesPair(ka, kb);
            const sym = mixCompareMatrixSymbol(d).sym;
            lines.push(`A: ${mixCompareOptionLabel(ka)} (${ka})`);
            lines.push(`B: ${mixCompareOptionLabel(kb)} (${kb})`);
            lines.push(`Сводка: ${sym} (см. вкладку «Пара» для деталей)`);
        } else lines.push('Выберите два разных шаблона во вкладке «Пара».');
    } else lines.push('(вкладка «Пара» не открыта)');
    lines.push('');

    lines.push('--- Матрица (TSV, текущие фильтры вкладки «Матрица») ---');
    const ml = (document.getElementById('mix-compare-matrix-layer') || {}).value || 'all';
    const mg = (document.getElementById('mix-compare-matrix-group') || {}).value || 'all';
    const ms = (document.getElementById('mix-compare-matrix-search') || {}).value || '';
    let mList = filterMixCompareMeta(buildMixKeyMetaList(), ml, mg, ms);
    const mMax = 32;
    if (mList.length > mMax) {
        lines.push(`(первые ${mMax} строк/колонок из ${mList.length})`);
        mList = mList.slice(0, mMax);
    }
    if (mList.length) lines.push(buildMixCompareMatrixTsv(mList));
    else lines.push('(пусто по фильтру)');
    lines.push('');

    lines.push('--- От эталона ---');
    const refEl = document.getElementById('mix-compare-baseline-ref');
    const layer = (document.getElementById('mix-compare-filter-layer') || {}).value || 'all';
    const groupId = (document.getElementById('mix-compare-filter-group') || {}).value || 'all';
    const search = (document.getElementById('mix-compare-filter-search') || {}).value || '';
    const refKey = refEl ? refEl.value : '';
    if (!refKey) lines.push('Эталон не выбран.');
    else {
        const all = filterMixCompareMeta(buildMixKeyMetaList(), layer, groupId, search);
        lines.push(`Эталон: ${mixCompareOptionLabel(refKey)} (${refKey}), выход ${fmtY(window.mixTemplateYields[refKey])}`);
        all.forEach((meta) => {
            if (meta.key === refKey) return;
            const d = compareMixTemplatesPair(refKey, meta.key);
            if (d.ingredientSetEqual && d.yieldMatch) return;
            const bits = [];
            if (!d.yieldMatch) bits.push(`выход ${fmtY(d.ya)}≠${fmtY(d.yb)}`);
            if (d.onlyB.length) bits.push(`+${d.onlyB.length} в цели`);
            if (d.onlyA.length) bits.push(`−${d.onlyA.length} нет в цели`);
            if (d.qtyDiff.length) bits.push(`±${d.qtyDiff.length} кол-ва`);
            lines.push(`  · ${meta.label} (${meta.key}): ${bits.join('; ') || 'различия'}`);
        });
    }
    lines.push('');

    lines.push('--- Одинаковые составы ---');
    const cl = (document.getElementById('mix-compare-clones-filter-layer') || {}).value || 'all';
    const cg = (document.getElementById('mix-compare-clones-filter-group') || {}).value || 'all';
    const cs = (document.getElementById('mix-compare-clones-filter-search') || {}).value || '';
    const cFiltered = filterMixCompareMeta(buildMixKeyMetaList(), cl, cg, cs);
    const cmap = new Map();
    cFiltered.forEach((m) => {
        const k = `${m.fingerprint}|y:${mixQtyCanonical(m.yieldVal)}`;
        if (!cmap.has(k)) cmap.set(k, []);
        cmap.get(k).push(m);
    });
    const cgroups = Array.from(cmap.values()).filter((g) => g.length > 1).sort((a, b) => b.length - a.length);
    if (!cgroups.length) lines.push('(полных клонов по фильтру не найдено)');
    else {
        cgroups.forEach((g, idx) => {
            lines.push(`Группа ${idx + 1} (${g.length} шт.): ${g.map((x) => x.label).join('; ')}`);
        });
    }

    await mixCompareWriteClipboard(lines.join('\n'));
};

window.showMixTemplatesCompareWorkbench = function () {
    if (window.currentRecipeMode !== 'MIX' && typeof window.switchRecipeMode === 'function') {
        switchRecipeMode('MIX');
    }
    const keys = buildMixKeyMetaList();
    if (!keys.length) {
        UI.toast('Список шаблонов не загружен', 'error');
        return;
    }

    const ts = document.getElementById('mix-template-keys-select').tomselect;
    const currentKey = ts ? ts.getValue() : document.getElementById('mix-template-keys-select').value;
    const defaultA = currentKey || keys[0].key;
    const defaultB = keys.find(k => k.key !== defaultA)?.key || keys[0].key;

    const groupOpts = MIX_GROUPS.map(g => `<option value="${g.groupId}">${Utils.escapeHtml(g.name)}</option>`).join('');
    const optsHtml = getMixCompareSelectOptionsHtml();

    const body = `
        <div class="rec-compare-workbench rec-modal-content">
            <div class="rec-compare-tabs">
                <button type="button" class="btn btn-blue shadow-primary rec-compare-tab-btn" data-tab="pair" onclick="switchMixCompareTab('pair')">Пара</button>
                <button type="button" class="btn btn-outline text-primary rec-compare-tab-btn" data-tab="baseline" onclick="switchMixCompareTab('baseline')">От эталона</button>
                <button type="button" class="btn btn-outline text-primary rec-compare-tab-btn" data-tab="matrix" onclick="switchMixCompareTab('matrix')">Матрица</button>
                <button type="button" class="btn btn-outline text-primary rec-compare-tab-btn" data-tab="clones" onclick="switchMixCompareTab('clones')">Одинаковые составы</button>
                <button type="button" class="btn btn-outline font-13" style="margin-left:auto" onclick="mixCompareExportWorkbenchSnapshot()" title="Текст со всех вкладок">📋 Сводка в буфер</button>
            </div>

            <div class="rec-compare-panel" data-panel="pair">
                <div class="rec-mini-grid">
                    <div class="form-group m-0">
                        <label class="rec-filter-label">Шаблон A</label>
                        <select id="mix-compare-a" class="input-modern" onchange="refreshMixComparePair()">${optsHtml}</select>
                    </div>
                    <div class="form-group m-0">
                        <label class="rec-filter-label">Шаблон B</label>
                        <select id="mix-compare-b" class="input-modern" onchange="refreshMixComparePair()">${optsHtml}</select>
                    </div>
                </div>
                <div class="flex-row gap-10 flex-wrap align-center mt-10">
                    <button type="button" class="btn btn-outline" onclick="refreshMixComparePair()">🔄 Обновить сравнение</button>
                    <label class="rec-inline-label font-13 m-0">
                        <input type="checkbox" id="mix-compare-pair-propagate-yield"> Копировать вместе с плановым выходом эталона
                    </label>
                </div>
                <div id="mix-compare-pair-summary" class="rec-compare-summary"></div>
                <div class="flex-row gap-10 flex-wrap mb-10">
                    <button type="button" class="btn btn-blue" onclick="mixCompareApplyPair('AtoB')">Скопировать A → B</button>
                    <button type="button" class="btn btn-outline" onclick="mixCompareApplyPair('BtoA')">Скопировать B → A</button>
                </div>
                <div id="mix-compare-pair-tables"></div>
            </div>

            <div class="rec-compare-panel d-none" data-panel="baseline">
                <div class="rec-compare-filters">
                    <div class="form-group">
                        <label class="rec-filter-label">Слой</label>
                        <select id="mix-compare-filter-layer" class="input-modern rec-filter-select" onchange="refreshMixCompareBaseline()">
                            <option value="all">Все</option>
                            <option value="main">Основной</option>
                            <option value="face">Лицевой</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label class="rec-filter-label">Группа матрицы</label>
                        <select id="mix-compare-filter-group" class="input-modern rec-filter-select" onchange="refreshMixCompareBaseline()">
                            <option value="all">Все группы</option>
                            ${groupOpts}
                        </select>
                    </div>
                    <div class="form-group">
                        <label class="rec-filter-label">Поиск</label>
                        <input type="text" id="mix-compare-filter-search" class="input-modern" placeholder="Название или ключ" oninput="refreshMixCompareBaseline()">
                    </div>
                    <div class="form-group">
                        <label class="rec-filter-label">Эталон</label>
                        <select id="mix-compare-baseline-ref" class="input-modern" onchange="refreshMixCompareBaseline()">${optsHtml}</select>
                    </div>
                </div>
                <label class="rec-inline-label font-13 mb-10">
                    <input type="checkbox" id="mix-compare-baseline-propagate-yield"> Записывать выход эталона в цели
                </label>
                <div id="mix-compare-baseline-body"></div>
                <div class="mt-10 flex-row gap-10 flex-wrap">
                    <button type="button" class="btn btn-blue" onclick="mixCompareApplyBaseline()">Применить эталон к отмеченным</button>
                    <button type="button" class="btn btn-outline" onclick="refreshMixCompareBaseline()">Обновить таблицу</button>
                </div>
            </div>

            <div class="rec-compare-panel d-none" data-panel="clones">
                <p class="rec-help-text">Шаблоны с одинаковым составом и выходом (по данным кэша). Группы из нескольких строк — полные «клоны».</p>
                <div class="rec-compare-filters">
                    <div class="form-group">
                        <label class="rec-filter-label">Слой</label>
                        <select id="mix-compare-clones-filter-layer" class="input-modern rec-filter-select" onchange="refreshMixCompareClones()">
                            <option value="all">Все</option>
                            <option value="main">Основной</option>
                            <option value="face">Лицевой</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label class="rec-filter-label">Группа матрицы</label>
                        <select id="mix-compare-clones-filter-group" class="input-modern rec-filter-select" onchange="refreshMixCompareClones()">
                            <option value="all">Все группы</option>
                            ${groupOpts}
                        </select>
                    </div>
                    <div class="form-group">
                        <label class="rec-filter-label">Поиск</label>
                        <input type="text" id="mix-compare-clones-filter-search" class="input-modern" placeholder="Название или ключ" oninput="refreshMixCompareClones()">
                    </div>
                </div>
                <div id="mix-compare-clones-body"></div>
                <button type="button" class="btn btn-outline mt-10" onclick="refreshMixCompareClones()">Обновить группы</button>
            </div>

            <div class="rec-compare-panel d-none" data-panel="matrix">
                <p class="rec-help-text m-0 mb-10">Попарное сравнение всех шаблонов в выборке: строка и столбец — один и тот же список после фильтров.</p>
                <div class="rec-compare-filters">
                    <div class="form-group">
                        <label class="rec-filter-label">Слой</label>
                        <select id="mix-compare-matrix-layer" class="input-modern rec-filter-select" onchange="refreshMixCompareMatrix()">
                            <option value="all">Все</option>
                            <option value="main">Основной</option>
                            <option value="face">Лицевой</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label class="rec-filter-label">Группа матрицы</label>
                        <select id="mix-compare-matrix-group" class="input-modern rec-filter-select" onchange="refreshMixCompareMatrix()">
                            <option value="all">Все группы</option>
                            ${groupOpts}
                        </select>
                    </div>
                    <div class="form-group">
                        <label class="rec-filter-label">Поиск</label>
                        <input type="text" id="mix-compare-matrix-search" class="input-modern" placeholder="Название или ключ" oninput="refreshMixCompareMatrix()">
                    </div>
                </div>
                <div class="flex-row gap-10 flex-wrap">
                    <button type="button" class="btn btn-outline" onclick="refreshMixCompareMatrix()">🔄 Пересчитать</button>
                    <button type="button" class="btn btn-blue" onclick="mixCompareCopyMatrixTsv()">📑 Копировать таблицу (TSV)</button>
                </div>
                <p id="mix-compare-matrix-note" class="rec-mtx-legend m-0 mb-5"></p>
                <div id="mix-compare-matrix-body"></div>
            </div>
        </div>
    `;

    const footer = `
        <button type="button" class="btn btn-outline" onclick="mixCompareExportWorkbenchSnapshot()">📋 Сводка в буфер</button>
        <button type="button" class="btn btn-outline" onclick="UI.closeModal()">Закрыть</button>`;
    UI.showModal('🔬 Сравнение шаблонов замесов', body, footer);

    setTimeout(() => {
        const aEl = document.getElementById('mix-compare-a');
        const bEl = document.getElementById('mix-compare-b');
        const rEl = document.getElementById('mix-compare-baseline-ref');
        if (aEl) aEl.value = defaultA;
        if (bEl) bEl.value = defaultB;
        if (rEl) rEl.value = defaultA;
        window.refreshMixComparePair();
        window.refreshMixCompareBaseline();
    }, 50);
};

window.showMixCopyModal = function() {
    const ts = document.getElementById('mix-template-keys-select').tomselect;
    const currentKey = ts ? ts.getValue() : document.getElementById('mix-template-keys-select').value;
    if (!currentKey) {
        UI.toast('Сначала выберите шаблон в списке', 'warning');
        return;
    }
    
    // Определяем тип (Лицевой или Основной)
    const isMain = currentKey.startsWith('main_');
    const targetGroups = MIX_GROUPS.filter(g => isMain ? g.keys[0].startsWith('main_') : g.keys[0].startsWith('face_'));
    
    let html = `<div class="mb-20 font-15">Выберите группы или отдельные шаблоны для умного копирования:</div>`;
    html += `<div class="rec-modal-content">`;
    
    targetGroups.forEach(group => {
        html += `
            <div class="rec-acc-item">
                <div class="rec-acc-header" onclick="toggleMixGroup('${group.groupId}')">
                    <strong class="text-primary font-14">${group.name} <span>(развернуть 🔽)</span></strong>
                    <label class="rec-inline-label rec-inline-label-success" onclick="event.stopPropagation()">
                        <input type="checkbox" class="rec-checkbox-md" onclick="toggleAllInGroup('${group.groupId}', this.checked)"> Выбрать всю группу
                    </label>
                </div>
                <div id="mix-copy-${group.groupId}" class="rec-acc-body d-none">
        `;
        
        group.keys.forEach(key => {
            if (key === currentKey) return; // Себя не выводим
            const opt = document.querySelector(`#mix-template-keys-select option[value="${key}"]`);
            const name = opt ? opt.innerText : key;
            html += `
                <label class="rec-inline-label">
                    <input type="checkbox" class="mix-copy-target-cb cb-group-${group.groupId} rec-checkbox-sm" value="${key}">
                    <span class="font-14">${name}</span>
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
        <button class="btn btn-blue shadow-primary rec-btn-wide" onclick="executeMassCopyMixTemplate('${currentKey}')">🚀 Скопировать в отмеченные</button>
    `;
    UI.showModal(`🎭 Умное копирование (${currentName})`, html, buttons);
};

window.toggleMixGroup = function(groupId) {
    const el = document.getElementById(`mix-copy-${groupId}`);
    if(el) el.classList.toggle('d-none');
};

window.toggleAllInGroup = function(groupId, checked) {
    const cbs = document.querySelectorAll(`.cb-group-${groupId}`);
    cbs.forEach(cb => cb.checked = checked);
};

window.executeMassCopyMixTemplate = async function(sourceKey) {
    const checkboxes = document.querySelectorAll('.mix-copy-target-cb:checked');
    const targetKeys = Array.from(checkboxes).map(cb => cb.value);
    
    if (targetKeys.length === 0) return UI.toast('Выберите хотя бы один шаблон', 'error');

    // Берём yield источника из кэша, а не из mix-yield-input — тот хранит
    // выход ОТКРЫТОГО в редакторе шаблона, который может отличаться от sourceKey.
    const yieldValue = parseFloat(window.mixTemplateYields[sourceKey]) || 1;
    executeSaveMixTemplate(sourceKey, yieldValue, targetKeys);
}

function isRecipeChanged() {
    if (originalRecipeData.length !== currentRecipeData.length) return true;
    for(let i=0; i < currentRecipeData.length; i++) {
        const o = originalRecipeData[i];
        const c = currentRecipeData[i];
        if (o.materialId !== c.materialId || o.qty !== c.qty || normalizeRecipeLayer(o.layer) !== normalizeRecipeLayer(c.layer)) return true;
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
             const html = `<div class="p-10 font-15">Шаблон пуст. Сохранить его пустым?</div>`;
             const buttons = `
                 <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
                 <button class="btn btn-blue rec-danger-btn" onclick="executeSaveMixTemplate('${templateKey}', ${yld})">🗑️ Да</button>
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
                        <div class="py-10 font-15">
                            Вы изменили состав/выход шаблона в группе <strong>"${group.name}"</strong>.<br><br>
                            <strong>Применить изменения ко ВСЕЙ ГРУППЕ (${siblings.length + 1} позиций) автоматически?</strong>
                            <ul class="rec-guidance-box">
                                ${siblingsHtml.map(name => `<li>${name}</li>`).join('')}
                            </ul>
                        </div>
                    `;
                    const buttons = `
                        <button class="btn btn-outline rec-btn-min-140" onclick="executeSaveMixTemplate('${templateKey}', ${yld}, null)">💾 Нет, сохранить только этот</button>
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
    // Безопасное получение имени через TomSelect
    const tsP = prodSelect.tomselect;
    const productName = tsP
        ? (tsP.options[tsP.getValue()] ? tsP.options[tsP.getValue()].text : '')
        : (prodSelect.options[prodSelect.selectedIndex] ? prodSelect.options[prodSelect.selectedIndex].text : '');

    if (!productId) return UI.toast("Не выбрана продукция!", "error");

    // Заменяем первый confirm (проверка на пустой рецепт)
    if (currentRecipeData.length === 0 && !force) {
        const html = `
            <div class="p-10 font-15">
                Рецепт пуст. <br><br>
                Вы уверены, что хотите сохранить пустой рецепт? <br>
                <span class="text-danger font-13">(Это удалит все привязанные ингредиенты)</span>
            </div>
        `;
        const buttons = `
            <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
            <button class="btn btn-blue rec-danger-btn" 
                    onclick="executeSaveRecipe(${productId}, '${productName.replace(/'/g, "\\'")}', ${force})">🗑️ Да, сохранить пустым</button>
        `;
        return UI.showModal('⚠️ Внимание: Пустой рецепт', html, buttons);
    }

    // Если всё ок — переходим к отправке
    executeSaveRecipe(productId, productName, force);
};

// 6.1 Функция отправки BOM-рецепта на сервер
window.executeSaveRecipe = async function(productId, productName, force) {
    if (typeof UI.closeModal === 'function') UI.closeModal();
    UI.toast('⏳ Сохранение...', 'info');

    recipeReindexOrder();
    const payload = {
        productId,
        productName,
        ingredients: currentRecipeData.map((ing, idx) => ({
            ...ing,
            order: normalizeRecipeOrder(ing.order ?? idx)
        })),
        force
    };

    try {
        await API.post('/api/recipes/save', payload);
        UI.toast('✅ Рецепт успешно сохранен!', 'success');
        if (typeof originalRecipeData !== 'undefined') {
            originalRecipeData = JSON.parse(JSON.stringify(currentRecipeData));
        }
        updateRecipeDirtyState();
    } catch (e) {
        if (e.body && e.body.warning) {
            const html = `<div class="p-10 font-15">${e.body.warning.replace(/\\n/g, '<br>')}</div>`;
            const buttons = `
                <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
                <button class="btn btn-blue rec-danger-btn" 
                        onclick="executeSaveRecipe(${productId}, '${(productName || '').replace(/'/g, "\\'")}', true)">🗑️ Да, Сохранить принудительно</button>
            `;
            return UI.showModal('⚠️ Внимание: Отклонение норм', html, buttons);
        } else {
            console.error(e);
            UI.toast(e.message || 'Ошибка', 'error');
        }
    }
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
        if (targetKeys.length > 1) {
            // Batch-endpoint: одна транзакция — без race condition и N-1 лишних roundtrips
            await API.post('/api/mix-templates/batch', {
                templates: targetKeys.map(key => ({
                    templateKey: key,
                    yieldValue: yieldValue,
                    ingredients: JSON.parse(JSON.stringify(payloadIngredients))
                }))
            });
        } else {
            // Один ключ: используем одиночный endpoint
            await API.post('/api/mix-templates/single', {
                templateKey: targetKeys[0],
                yieldValue: yieldValue,
                ingredients: payloadIngredients
            });
        }

        // Обновляем кэш: deep copy для каждого ключа, не делим ссылку на один объект.
        targetKeys.forEach(key => {
            window.currentMixTemplates[key] = JSON.parse(JSON.stringify(payloadIngredients));
            window.mixTemplateYields[key] = yieldValue;
        });

        UI.toast(targetKeys.length > 1 ? `✅ Шаблон скопирован в ${targetKeys.length} позиций!` : '✅ Шаблон успешно сохранен!', 'success');
        originalRecipeData = JSON.parse(JSON.stringify(currentRecipeData));
        refreshOpenMixTemplateIfTouched(targetKeys);
    } catch (e) {
        console.error(e);
        const msg = (e.body && (e.body.error || e.body.warning)) || e.message || 'Ошибка сохранения шаблона';
        UI.toast(String(msg), 'error');
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

// ========== Сравнение рецептов продукции (BOM) ==========
let bomRecipeCompareCache = {};
window.bomCompareFilteredProducts = [];

function bomCanonicalizeFetchedRows(rowsIn) {
    const buckets = { face: [], main: [], packaging: [] };
    (rowsIn || []).forEach((row) => {
        buckets[normalizeRecipeLayer(row.layer)].push({ ...row });
    });
    Object.keys(buckets).forEach((ly) => {
        buckets[ly].sort((a, b) => normalizeRecipeOrder(a.order) - normalizeRecipeOrder(b.order));
    });
    return [...buckets.face, ...buckets.main, ...buckets.packaging].map((row, idx) => ({ ...row, order: idx }));
}

function mapApiRecipeToBomCompareRows(data) {
    const arr = Array.isArray(data) ? data : [];
    return bomCanonicalizeFetchedRows(arr.map(ing => ({
        materialId: parseInt(ing.material_id, 10),
        name: ing.material_name,
        qty: parseFloat(ing.quantity_per_unit),
        unit: ing.unit || '',
        price: parseFloat(ing.current_price) || 0,
        layer: normalizeRecipeLayer(ing.layer || inferRecipeLayerByMaterial(ing.material_name, ing.category)),
        order: normalizeRecipeOrder(ing.order)
    })));
}

async function bomCompareFetchAllInSelection() {
    const list = window.bomCompareFilteredProducts || [];
    if (!list.length) {
        UI.toast('Сначала нажмите «Обновить список товаров по фильтру»', 'warning');
        return 0;
    }
    const MAX_TOTAL = 750;
    const BATCH_API = 250;
    if (list.length > MAX_TOTAL) {
        // Заменяем window.confirm на UI.showModal
        return new Promise((resolve) => {
            window.__recipeConfirm = async function() {
                UI.closeModal();
                resolve(await _bomCompareFetchBatch(list, MAX_TOTAL, BATCH_API));
            };
            UI.showModal('Большая выборка',
                `<div class="p-10 font-15">В выборке <strong>${list.length}</strong> товаров.<br><span class="text-muted font-13">Загрузить рецепты для первых ${MAX_TOTAL}?</span></div>`,
                `<button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
                 <button class="btn btn-blue" onclick="window.__recipeConfirm()">Загрузить</button>`
            );
        });
    }
    return _bomCompareFetchBatch(list, MAX_TOTAL, BATCH_API);
}

async function _bomCompareFetchBatch(list, MAX_TOTAL, BATCH_API) {
    const slice = list.length > MAX_TOTAL ? list.slice(0, MAX_TOTAL) : list;
    UI.toast(`⏳ Загрузка ${slice.length} рецептов (пакеты по ${BATCH_API})...`, 'info');
    let done = 0;
    for (let i = 0; i < slice.length; i += BATCH_API) {
        const part = slice.slice(i, i + BATCH_API);
        const partIds = part.map((p) => Number(p.id)).filter((n) => Number.isFinite(n) && n > 0);
        if (!partIds.length) continue;
        try {
            const res = await API.post('/api/recipes/batch', { productIds: partIds });
            const map = (res && res.recipes) ? res.recipes : {};
            partIds.forEach((pid) => {
                bomRecipeCompareCache[String(pid)] = mapApiRecipeToBomCompareRows(map[String(pid)] || []);
            });
            done += partIds.length;
        } catch (e) {
            // Fallback: поштучно с паузой 100ms — чтобы не создавать шторм запросов
            for (let j = 0; j < partIds.length; j++) {
                await bomCompareFetchOneRecipe(partIds[j]);
                if (j < partIds.length - 1) await new Promise(r => setTimeout(r, 100));
            }
            done += partIds.length;
        }
    }
    bomCompareRefreshStatusLine();
    UI.toast(`✅ Получены рецепты: ${done} шт.`, 'success');
    return done;
}

function bomCompareGetFilterDomState() {
    const typeEl = document.getElementById('bomrc-f-type');
    const thickEl = document.getElementById('bomrc-f-thickness');
    const texEl = document.getElementById('bomrc-f-texture');
    const colEl = document.getElementById('bomrc-f-color');
    const searchEl = document.getElementById('bomrc-f-search');
    return {
        type: typeEl ? typeEl.value : 'Все',
        thickness: thickEl ? thickEl.value : 'Все',
        texture: texEl ? texEl.value : 'Все',
        color: colEl ? colEl.value : 'Все',
        search: searchEl ? searchEl.value : ''
    };
}

function bomCompareFilteredProductsList() {
    const st = bomCompareGetFilterDomState();
    const q = String(st.search || '').trim().toLowerCase();
    let fThick = st.thickness;
    if (st.type !== 'Плитка' && st.type !== 'Все') fThick = 'Все';
    return allRecipeProducts.filter((p) => {
        const feats = parseProductFeatures(p.name);
        if (st.type !== 'Все' && feats.type !== st.type) return false;
        if ((st.type === 'Плитка' || st.type === 'Все') && fThick !== 'Все' && feats.thickness !== fThick) return false;
        if (st.texture !== 'Все' && feats.texture !== st.texture) return false;
        if (st.color !== 'Все' && feats.color !== st.color) return false;
        if (q && !String(p.name || '').toLowerCase().includes(q) && !String(p.id).includes(q)) return false;
        return true;
    }).map((p) => ({ id: p.id, name: p.name }));
}

window.bomCompareToggleThicknessDisabled = function () {
    const typeEl = document.getElementById('bomrc-f-type');
    const thickEl = document.getElementById('bomrc-f-thickness');
    if (!thickEl || !typeEl) return;
    const dis = typeEl.value !== 'Плитка' && typeEl.value !== 'Все';
    thickEl.disabled = dis;
    thickEl.style.opacity = dis ? '0.5' : '1';
};

function bomCompareProductOptionsHtml() {
    const list = window.bomCompareFilteredProducts || [];
    return list.map((p) =>
        `<option value="${Number(p.id)}">${Utils.escapeHtml(p.name)}</option>`
    ).join('');
}

function bomCompareFingerprintFromRows(rows) {
    const sorted = [...(rows || [])].sort((a, b) => {
        const la = normalizeRecipeLayer(a.layer);
        const lb = normalizeRecipeLayer(b.layer);
        if (la !== lb) return la.localeCompare(lb);
        return Number(a.materialId) - Number(b.materialId);
    });
    return sorted.map(r => `${Number(r.materialId)}:${normalizeRecipeLayer(r.layer)}:${mixQtyCanonical(r.qty)}`).join('|');
}

function compareBomRecipesPair(pidA, pidB) {
    const rowsA = bomRecipeCompareCache[String(pidA)];
    const rowsB = bomRecipeCompareCache[String(pidB)];
    if (rowsA === undefined || rowsB === undefined) return null;
    const cmpKey = (r) => `${Number(r.materialId)}:${normalizeRecipeLayer(r.layer)}`;
    const mapA = new Map(rowsA.map(r => [cmpKey(r), r]));
    const mapB = new Map(rowsB.map(r => [cmpKey(r), r]));
    const same = [];
    const onlyA = [];
    const onlyB = [];
    const qtyDiff = [];
    for (const [k, a] of mapA) {
        const b = mapB.get(k);
        if (!b) onlyA.push(a);
        else if (Math.abs(Number(a.qty) - Number(b.qty)) > 1e-6) qtyDiff.push({ ...a, name: a.name || b.name, qtyA: a.qty, qtyB: b.qty, layer: normalizeRecipeLayer(a.layer) });
        else same.push(a);
    }
    for (const [k, b] of mapB) {
        if (!mapA.has(k)) onlyB.push(b);
    }
    const ingredientSetEqual = onlyA.length === 0 && onlyB.length === 0 && qtyDiff.length === 0;
    return {
        ingredientSetEqual,
        fingerprintEqual: bomCompareFingerprintFromRows(rowsA) === bomCompareFingerprintFromRows(rowsB),
        same,
        onlyA,
        onlyB,
        qtyDiff,
        countA: rowsA.length,
        countB: rowsB.length
    };
}

// ========== Умный аудит рецептур (ядро, Шаг 1) ==========

window.__auditState = {
    groups: {},
    selectedGroupKey: null,
    referenceId: null,
    focusedProductId: null,
    pigmentIds: new Set(),
    loadingKeys: new Set(),
    /** Выбранный ключ матрицы в фильтре левой панели экрана 2 ('' = все) */
    auditMatrixFilterKey: '',
    /** Выбранная категория в фильтре левой панели ('' = все) */
    auditCategoryFilterKey: ''
};

/** id оборудования type=mold → отображаемое имя (заполняется лениво) */
let auditMoldIdToName = null;

async function auditEnsureEquipmentMoldNamesLoaded() {
    if (auditMoldIdToName !== null) return;
    auditMoldIdToName = {};
    try {
        const eq = await API.get('/api/equipment');
        (Array.isArray(eq) ? eq : []).forEach((e) => {
            if (e && String(e.equipment_type) === 'mold' && e.id != null) {
                auditMoldIdToName[String(e.id)] = String(e.name || '').trim() || `№${e.id}`;
            }
        });
    } catch (_) {
        auditMoldIdToName = {};
    }
}

function auditGetFullRecipeProduct(productId) {
    const id = Number(productId);
    return (allRecipeProducts || []).find((x) => Number(x.id) === id) || null;
}

/**
 * «Матрица» для фильтра: приоритет mold_id из карточки товара, иначе matrix_name / matrix.
 * @returns {{ key: string, label: string }}
 */
function auditProductMatrixBucket(item) {
    if (!item) return { key: '__none__', label: 'Без матрицы' };
    const midRaw = item.mold_id;
    const mid = midRaw != null && midRaw !== '' ? Number(midRaw) : NaN;
    if (Number.isFinite(mid) && mid > 0) {
        const nm =
            auditMoldIdToName && auditMoldIdToName[String(mid)]
                ? auditMoldIdToName[String(mid)]
                : `Матрица №${mid}`;
        return { key: `mold:${mid}`, label: nm };
    }
    const alt = item.matrix_name || item.matrix;
    if (alt && String(alt).trim()) {
        const s = String(alt).trim();
        return { key: `mx:${s}`, label: s };
    }
    return { key: '__none__', label: 'Без матрицы' };
}

function auditDecodeDataAttr(raw) {
    try {
        return decodeURIComponent(raw || '');
    } catch (_) {
        return raw || '';
    }
}

function auditApplyLeftMatrixFilter() {
    const sel = document.getElementById('audit-left-matrix-filter');
    if (sel) window.__auditState.auditMatrixFilterKey = sel.value || '';
    auditApplyLeftPanelFilters();
}

function auditApplyLeftCategoryFilter() {
    const sel = document.getElementById('audit-left-category-filter');
    if (sel) window.__auditState.auditCategoryFilterKey = sel.value || '';
    auditApplyLeftPanelFilters();
}

/** Совмещает фильтры «категория» и «матрица»; эталон всегда виден. */
function auditApplyLeftPanelFilters() {
    const mSel = document.getElementById('audit-left-matrix-filter');
    const cSel = document.getElementById('audit-left-category-filter');
    const filterMatrix = (mSel && mSel.value) || window.__auditState.auditMatrixFilterKey || '';
    const filterCategory = (cSel && cSel.value) || window.__auditState.auditCategoryFilterKey || '';
    window.__auditState.auditMatrixFilterKey = filterMatrix;
    window.__auditState.auditCategoryFilterKey = filterCategory;

    const group = auditGetSelectedGroup();
    const refId = group && group.defaultReferenceId != null ? Number(group.defaultReferenceId) : null;
    const list = document.getElementById('audit-left-prow-list');
    if (!list) return;
    list.querySelectorAll('.rec-audit-prow').forEach((el) => {
        const pid = Number(el.getAttribute('data-audit-product-id'));
        const isRef = Number.isFinite(refId) && pid === refId;
        const mk = auditDecodeDataAttr(el.getAttribute('data-audit-matrix-key'));
        const ck = auditDecodeDataAttr(el.getAttribute('data-audit-category-key'));
        const matrixOk = filterMatrix === '' || mk === filterMatrix;
        const categoryOk = filterCategory === '' || ck === filterCategory;
        const show = isRef || (matrixOk && categoryOk);
        el.classList.toggle('d-none', !show);
    });
}

/** Уникальный ключ категории товара в группе (из items.category). */
function auditProductCategoryBucket(item) {
    if (!item) return { key: '__none__', label: 'Без категории' };
    const c = item.category != null && String(item.category).trim() ? String(item.category).trim() : '';
    if (!c) return { key: '__none__', label: 'Без категории' };
    return { key: `cat:${c}`, label: c };
}

/** Эвристика «это пигмент» по сырью (без Set): белый цемент явно не пигмент */
function auditMaterialIsPigmentHeuristic(m) {
    if (!m) return false;
    const name = String(m.name || '');
    const cat = String(m.category || '');
    if (/белый\s*цемент/i.test(name)) return false;
    if (/пигмент|красит|краситель/i.test(cat)) return true;
    if (/пигмент|красит|диоксид/i.test(name)) return true;
    return false;
}

function auditComputePigmentIds() {
    const st = window.__auditState;
    st.pigmentIds.clear();
    (allMaterialsList || []).forEach((m) => {
        const id = Number(m.id);
        if (!Number.isFinite(id)) return;
        if (auditMaterialIsPigmentHeuristic(m)) st.pigmentIds.add(id);
    });
    return st.pigmentIds;
}

function isPigment(materialId) {
    const id = Number(materialId);
    if (!Number.isFinite(id)) return false;
    if (window.__auditState.pigmentIds.size > 0) {
        return window.__auditState.pigmentIds.has(id);
    }
    const m = (allMaterialsList || []).find((x) => Number(x.id) === id);
    return auditMaterialIsPigmentHeuristic(m);
}

function auditCollectDiffMaterialIdsForLayer(d, layer) {
    const ly = normalizeRecipeLayer(layer);
    const ids = new Set();
    if (!d) return ids;
    const take = (rows) => {
        (rows || []).forEach((r) => {
            if (normalizeRecipeLayer(r.layer) !== ly) return;
            const mid = Number(r.materialId);
            if (Number.isFinite(mid)) ids.add(mid);
        });
    };
    take(d.onlyA);
    take(d.onlyB);
    (d.qtyDiff || []).forEach((r) => {
        if (normalizeRecipeLayer(r.layer) !== ly) return;
        const mid = Number(r.materialId);
        if (Number.isFinite(mid)) ids.add(mid);
    });
    return ids;
}

function auditLayerStatusSimple(d, layer) {
    const ids = auditCollectDiffMaterialIdsForLayer(d, layer);
    if (ids.size === 0) return 'ok';
    return 'diff';
}

function auditFaceLayerStatus(d) {
    const ids = auditCollectDiffMaterialIdsForLayer(d, 'face');
    if (ids.size === 0) return 'ok';
    for (const id of ids) {
        if (!isPigment(id)) return 'diff';
    }
    return 'pigment_only';
}

/**
 * Обёртка над compareBomRecipesPair: pidRef = эталон (A), pidTarget = цель (B).
 * onlyA — только в эталоне, onlyB — только в цели (как в базовой функции).
 */
function auditComparePair(pidRef, pidTarget) {
    const d = compareBomRecipesPair(pidRef, pidTarget);
    if (!d) {
        return {
            base: null,
            layerStatus: { face: 'no_data', main: 'no_data', packaging: 'no_data' },
            overallStatus: 'no_data'
        };
    }
    if (d.ingredientSetEqual) {
        return {
            base: d,
            layerStatus: { face: 'ok', main: 'ok', packaging: 'ok' },
            overallStatus: 'ok'
        };
    }
    const layerStatus = {
        face: auditFaceLayerStatus(d),
        main: auditLayerStatusSimple(d, 'main'),
        packaging: auditLayerStatusSimple(d, 'packaging')
    };
    let overallStatus = 'ok';
    if (layerStatus.face === 'diff' || layerStatus.main === 'diff' || layerStatus.packaging === 'diff') {
        overallStatus = 'diff';
    } else if (layerStatus.face === 'pigment_only') {
        overallStatus = 'pigment_only';
    } else {
        overallStatus = 'ok';
    }
    return { base: d, layerStatus, overallStatus };
}

function auditBuildMergedIngredients(refId, targetId, selectedLayers) {
    const sel = new Set((selectedLayers || []).map((x) => normalizeRecipeLayer(x)));
    const rid = Number(refId);
    const tid = Number(targetId);
    const rowsRef = bomRecipeCompareCache[String(rid)];
    const rowsTgt = bomRecipeCompareCache[String(tid)];

    if (rowsRef === undefined || rowsTgt === undefined) {
        return [];
    }

    const bucket = { face: [], main: [], packaging: [] };

    for (const ly of ['face', 'main', 'packaging']) {
        const refLy = (rowsRef || []).filter((r) => normalizeRecipeLayer(r.layer) === ly);
        const tgtLy = (rowsTgt || []).filter((r) => normalizeRecipeLayer(r.layer) === ly);

        if (!sel.has(ly)) {
            bucket[ly] = tgtLy.map((r) => ({ ...r }));
        } else if (ly === 'face') {
            const fromRef = refLy.filter((r) => !isPigment(r.materialId));
            const fromTgt = tgtLy.filter((r) => isPigment(r.materialId));
            bucket[ly] = [...fromRef, ...fromTgt];
        } else {
            bucket[ly] = refLy.map((r) => ({ ...r }));
        }
    }

    const combined = [...bucket.face, ...bucket.main, ...bucket.packaging];
    const canon = bomCanonicalizeFetchedRows(combined);

    return canon.map((row, idx) => {
        const mid = Number(row.materialId);
        const m = (allMaterialsList || []).find((x) => Number(x.id) === mid);
        return {
            materialId: mid,
            name: row.name || (m ? m.name : ''),
            qty: parseFloat(row.qty),
            unit: (row.unit || (m && m.unit) || 'кг'),
            price: m ? parseFloat(m.current_price) || 0 : parseFloat(row.price) || 0,
            layer: normalizeRecipeLayer(row.layer),
            order: normalizeRecipeOrder(idx)
        };
    });
}

function auditBuildGroups() {
    const prev = window.__auditState.groups || {};
    const groups = {};
    const products = Array.isArray(allRecipeProducts) ? allRecipeProducts : [];

    products.forEach((p) => {
        const feats = parseProductFeatures(p.name);
        const key = [feats.type, feats.thickness, feats.texture].join('|');
        if (!groups[key]) {
            groups[key] = {
                key,
                type: feats.type,
                thickness: feats.thickness,
                texture: feats.texture,
                products: []
            };
        }
        groups[key].products.push({ id: p.id, name: p.name, features: feats });
    });

    Object.keys(groups).forEach((k) => {
        const ids = new Set(groups[k].products.map((x) => Number(x.id)));
        const pG = prev[k];
        if (!pG) return;
        if (pG.defaultReferenceId != null && ids.has(Number(pG.defaultReferenceId))) {
            groups[k].defaultReferenceId = pG.defaultReferenceId;
        }
        if (pG.referenceProductId != null && ids.has(Number(pG.referenceProductId))) {
            groups[k].referenceProductId = pG.referenceProductId;
        }
    });

    window.__auditState.groups = groups;
    return groups;
}

function auditRecipeRowLoadedInCache(productId) {
    return bomRecipeCompareCache[String(productId)] !== undefined;
}

function auditFormatGroupTitle(group) {
    if (!group) return 'Группа';
    const parts = [group.type, group.thickness, group.texture].filter((x) => x && x !== 'Все');
    if (!parts.length) return 'Прочая продукция';
    return parts.join(' ');
}

/**
 * @returns {{ level: 'red'|'yellow'|'green', emoji: string, sortPriority: number, message: string, referenceId: number|null, cachedCount: number, comparedCount: number }}
 */
function auditComputeGroupSummary(groupKey) {
    const group = (window.__auditState.groups || {})[groupKey];
    if (!group || !Array.isArray(group.products)) {
        return {
            level: 'yellow',
            emoji: '🟡',
            sortPriority: 1,
            message: 'Группа не найдена',
            referenceId: null,
            cachedCount: 0,
            comparedCount: 0
        };
    }

    const cachedProducts = group.products.filter((p) => auditRecipeRowLoadedInCache(p.id));
    const cachedCount = cachedProducts.length;

    if (cachedCount === 0) {
        return {
            level: 'yellow',
            emoji: '🟡',
            sortPriority: 1,
            message: 'Нет данных — загрузите рецепты (окно «Сравнение рецептов»)',
            referenceId: null,
            cachedCount: 0,
            comparedCount: 0
        };
    }

    let refId = group.defaultReferenceId != null ? Number(group.defaultReferenceId) : null;
    const refStillOk = refId != null && cachedProducts.some((p) => Number(p.id) === refId);
    if (!refStillOk) {
        refId = null;
    }
    if (refId == null) {
        const firstCached = group.products.find((p) => auditRecipeRowLoadedInCache(p.id));
        refId = firstCached ? Number(firstCached.id) : null;
        if (refId != null) {
            group.defaultReferenceId = refId;
        }
    }

    if (refId == null) {
        return {
            level: 'yellow',
            emoji: '🟡',
            sortPriority: 1,
            message: 'Нет данных — загрузите рецепты (окно «Сравнение рецептов»)',
            referenceId: null,
            cachedCount,
            comparedCount: 0
        };
    }

    const others = cachedProducts.filter((p) => Number(p.id) !== Number(refId));
    let hasDiff = false;
    let hasPigmentOnly = false;
    let comparedCount = 0;
    others.forEach((p) => {
        const cmp = auditComparePair(refId, p.id);
        comparedCount++;
        if (cmp.overallStatus === 'diff') hasDiff = true;
        if (cmp.overallStatus === 'pigment_only') hasPigmentOnly = true;
    });

    if (hasDiff) {
        return {
            level: 'red',
            emoji: '🔴',
            sortPriority: 0,
            message: 'Есть расхождения в рецептах',
            referenceId: refId,
            cachedCount,
            comparedCount
        };
    }

    let message = 'Рецепты идентичны';
    if (comparedCount === 0) {
        message = 'В кэше только один товар группы — загрузите рецепты остальных для сверки';
    } else if (hasPigmentOnly) {
        message = 'В норме: отличия только в лицевых пигментах';
    }
    return {
        level: 'green',
        emoji: '🟢',
        sortPriority: 2,
        message,
        referenceId: refId,
        cachedCount,
        comparedCount
    };
}

function auditRenderGroupsList() {
    const container = document.getElementById('audit-screen-1-inner');
    if (!container) return;

    const groupMap = window.__auditState.groups || {};
    const keys = Object.keys(groupMap);
    const enriched = keys.map((k) => ({
        key: k,
        group: groupMap[k],
        summary: auditComputeGroupSummary(k)
    }));

    enriched.sort((a, b) => {
        if (a.summary.sortPriority !== b.summary.sortPriority) {
            return a.summary.sortPriority - b.summary.sortPriority;
        }
        return auditFormatGroupTitle(a.group).localeCompare(auditFormatGroupTitle(b.group), 'ru');
    });

    const cards = enriched.map(({ key, group, summary }) => {
        const title = Utils.escapeHtml(auditFormatGroupTitle(group));
        const n = group.products ? group.products.length : 0;
        const n10 = n % 10;
        const n100 = n % 100;
        let posUnit = 'позиций';
        if (n10 === 1 && n100 !== 11) posUnit = 'позиция';
        else if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) posUnit = 'позиции';
        const pos = `${n} ${posUnit}`;
        const keyAttr = encodeURIComponent(key);
        const msg = Utils.escapeHtml(summary.message);
        const borderClass =
            summary.level === 'red'
                ? 'rec-audit-card--red'
                : summary.level === 'yellow'
                  ? 'rec-audit-card--yellow'
                  : 'rec-audit-card--green';
        return `
        <div class="card rec-audit-group-card p-12 mb-10 ${borderClass}">
          <div class="flex-between align-start gap-12 flex-wrap">
            <div class="flex-row gap-10 align-start" style="min-width:0;flex:1;">
              <span class="font-20" aria-hidden="true">${summary.emoji}</span>
              <div style="min-width:0;">
                <div class="font-15 font-600">${title}</div>
                <div class="text-muted font-13 mt-4">${pos} · ${msg}</div>
              </div>
            </div>
            <button type="button" class="btn btn-outline font-13 rec-btn-min-140 flex-shrink-0"
              data-audit-group-key="${keyAttr}"
              onclick="auditOpenGroupDetailFromBtn(this)">Разобраться →</button>
          </div>
        </div>`;
    });

    container.innerHTML =
        cards.length > 0
            ? cards.join('')
            : '<p class="text-muted font-13 m-0">Нет групп — проверьте загрузку каталога продукции.</p>';
}

async function auditFetchRecipesForProductIds(ids) {
    const raw = [...new Set((ids || []).map(Number).filter((n) => Number.isFinite(n) && n > 0))];
    if (!raw.length) return;
    const BATCH_API = 250;
    const list = raw.map((id) => ({ id }));
    for (let i = 0; i < list.length; i += BATCH_API) {
        const part = list.slice(i, i + BATCH_API);
        const partIds = part.map((p) => p.id);
        try {
            const res = await API.post('/api/recipes/batch', { productIds: partIds });
            const map = res && res.recipes ? res.recipes : {};
            partIds.forEach((pid) => {
                bomRecipeCompareCache[String(pid)] = mapApiRecipeToBomCompareRows(map[String(pid)] || []);
            });
        } catch (e) {
            for (let j = 0; j < partIds.length; j++) {
                await bomCompareFetchOneRecipe(partIds[j]);
                if (j < partIds.length - 1) await new Promise((r) => setTimeout(r, 80));
            }
        }
    }
}

function auditGetSelectedGroup() {
    const k = window.__auditState.selectedGroupKey;
    if (!k) return null;
    return (window.__auditState.groups || {})[k] || null;
}

/** Статус товара относительно эталона: emoji + code */
function auditProductRowStatus(refId, productId) {
    const rid = Number(refId);
    const pid = Number(productId);
    if (!Number.isFinite(rid) || !Number.isFinite(pid)) return { emoji: '🟡', code: 'no_data' };
    if (pid === rid) return { emoji: '🟢', code: 'reference' };
    const cmp = auditComparePair(rid, pid);
    if (cmp.overallStatus === 'no_data') return { emoji: '🟡', code: 'no_data' };
    if (cmp.overallStatus === 'diff') return { emoji: '🔴', code: 'diff' };
    return { emoji: '🟢', code: 'ok' };
}

function auditAggregateLayerStatusForGroup(groupKey) {
    const group = (window.__auditState.groups || {})[groupKey];
    const out = {
        main: { kind: 'ok', detail: '' },
        face: { kind: 'ok', detail: '' },
        packaging: { kind: 'ok', detail: '' }
    };
    if (!group) return out;
    const summary = auditComputeGroupSummary(groupKey);
    const refId = summary.referenceId;
    if (!refId) return out;

    ['main', 'face', 'packaging'].forEach((ly) => {
        let anyDiff = false;
        let anyPigmentOnlyFace = false;
        (group.products || []).forEach((p) => {
            const id = Number(p.id);
            if (id === Number(refId)) return;
            if (!auditRecipeRowLoadedInCache(id)) return;
            const cmp = auditComparePair(refId, id);
            const ls = cmp.layerStatus && cmp.layerStatus[ly];
            if (ls === 'diff') anyDiff = true;
            if (ly === 'face' && ls === 'pigment_only') anyPigmentOnlyFace = true;
        });
        if (anyDiff) {
            out[ly] = { kind: 'diff', detail: '' };
        } else if (ly === 'face' && anyPigmentOnlyFace) {
            out.face = { kind: 'pigment_ok', detail: 'Отличается только цвет (пигментация лица)' };
        } else {
            out[ly] = { kind: 'ok', detail: '' };
        }
    });
    return out;
}

function auditCollectDefaultSyncTargets(groupKey) {
    const group = (window.__auditState.groups || {})[groupKey];
    const summary = auditComputeGroupSummary(groupKey);
    const refId = summary.referenceId;
    if (!group || !refId) return [];
    const targets = [];
    (group.products || []).forEach((p) => {
        const id = Number(p.id);
        if (id === Number(refId)) return;
        if (!auditRecipeRowLoadedInCache(id)) return;
        const cmp = auditComparePair(refId, id);
        if (cmp.overallStatus === 'diff' || cmp.overallStatus === 'pigment_only') {
            targets.push(id);
        }
    });
    return targets;
}

function auditFormatQtyHuman(q) {
    const n = Number(q);
    if (!Number.isFinite(n)) return '—';
    const t = (Math.round(n * 1000) / 1000).toString().replace(/\.?0+$/, '');
    return t;
}

function auditRenderCompareHumanLines(cmp) {
    const d = cmp && cmp.base;
    if (!d) return '<p class="text-muted font-13 m-0">Нет данных сравнения.</p>';
    if (d.ingredientSetEqual) {
        return '<p class="text-muted font-13 m-0">Составы полностью совпадают.</p>';
    }
    const lines = [];
    const pushLine = (text) => lines.push(`<li class="mb-6">${Utils.escapeHtml(text)}</li>`);

    (d.onlyA || []).forEach((r) => {
        const ly = layerLabel(r.layer);
        pushLine(`${r.name || 'Материал'} (${ly}, эталон): ${auditFormatQtyHuman(r.qty)} — в целевом товаре отсутствует`);
    });
    (d.onlyB || []).forEach((r) => {
        const ly = layerLabel(r.layer);
        pushLine(`${r.name || 'Материал'} (${ly}): в эталоне нет → в целевом ${auditFormatQtyHuman(r.qty)}`);
    });
    (d.qtyDiff || []).forEach((r) => {
        const ly = layerLabel(r.layer);
        pushLine(`${r.name || 'Материал'} (${ly}): ${auditFormatQtyHuman(r.qtyA)} → ${auditFormatQtyHuman(r.qtyB)}`);
    });

    if (!lines.length) {
        return '<p class="text-muted font-13 m-0">Отличий в количествах не найдено.</p>';
    }
    return `<ul class="m-0 pl-18 font-13 rec-audit-diff-list">${lines.join('')}</ul>`;
}

function auditInstallDetailShell(groupTitleHtml) {
    const host = document.getElementById('audit-screen-2-inner');
    if (!host) return;
    host.innerHTML = `
      <div class="rec-audit-detail-shell">
        <div class="rec-audit-bc flex-row flex-wrap gap-10 align-center mb-12">
          <button type="button" class="btn btn-outline font-13" onclick="auditBackToGroupList()">← Назад к списку групп</button>
          <span class="text-muted font-13">·</span>
          <span class="font-14 font-600">${groupTitleHtml}</span>
        </div>
        <div class="rec-audit-two-col">
          <div class="rec-audit-col rec-audit-col-left">
            <div class="font-13 font-600 mb-8">Товары в группе</div>
            <div id="audit-detail-left"></div>
          </div>
          <div class="rec-audit-col rec-audit-col-right">
            <div id="audit-detail-right"></div>
          </div>
        </div>
      </div>`;
}

function auditBackToGroupList() {
    window.__auditState.selectedGroupKey = null;
    window.__auditState.focusedProductId = null;
    window.__auditState.auditMatrixFilterKey = '';
    window.__auditState.auditCategoryFilterKey = '';
    const s1 = document.getElementById('audit-screen-1');
    const s2 = document.getElementById('audit-screen-2');
    if (s1) {
        s1.classList.remove('d-none');
        s1.setAttribute('aria-hidden', 'false');
    }
    if (s2) {
        s2.classList.add('d-none');
        s2.setAttribute('aria-hidden', 'true');
    }
    auditRenderGroupsList();
}

function auditFocusProduct(productId) {
    const gid = Number(productId);
    const group = auditGetSelectedGroup();
    const refId = group && group.defaultReferenceId != null ? Number(group.defaultReferenceId) : null;
    if (Number.isFinite(gid) && Number.isFinite(refId) && gid === refId) {
        window.__auditState.focusedProductId = null;
    } else {
        window.__auditState.focusedProductId = Number.isFinite(gid) ? gid : null;
    }
    auditRenderDetailRightPanel();
}

function auditSetGroupReference(productId) {
    const group = auditGetSelectedGroup();
    const k = window.__auditState.selectedGroupKey;
    if (!group || !k) return;
    const id = Number(productId);
    if (!group.products.some((p) => Number(p.id) === id)) return;
    group.defaultReferenceId = id;
    window.__auditState.focusedProductId = null;
    auditRenderDetailLeft();
    auditRenderDetailRightPanel();
}

function auditRenderDetailLeft() {
    const container = document.getElementById('audit-detail-left');
    if (!container) return;
    const group = auditGetSelectedGroup();
    const k = window.__auditState.selectedGroupKey;
    if (!group || !k) {
        container.innerHTML = '';
        return;
    }
    auditComputeGroupSummary(k);
    const refId = group.defaultReferenceId != null ? Number(group.defaultReferenceId) : null;

    const categoryOptionsMap = new Map();
    const matrixOptionsMap = new Map();
    (group.products || []).forEach((p) => {
        const item = auditGetFullRecipeProduct(p.id);
        const catB = auditProductCategoryBucket(item);
        if (!categoryOptionsMap.has(catB.key)) categoryOptionsMap.set(catB.key, catB.label);
        const b = auditProductMatrixBucket(item);
        if (!matrixOptionsMap.has(b.key)) matrixOptionsMap.set(b.key, b.label);
    });
    const matrixRows = [...matrixOptionsMap.entries()]
        .sort((a, b) => {
            if (a[0] === '__none__') return 1;
            if (b[0] === '__none__') return -1;
            return String(a[1]).localeCompare(String(b[1]), 'ru');
        })
        .map(([key, label]) => {
            const esc = Utils.escapeHtml(label);
            const keyEsc = Utils.escapeHtml(key);
            return `<option value="${keyEsc}">${esc}</option>`;
        })
        .join('');

    const categoryRows = [...categoryOptionsMap.entries()]
        .sort((a, b) => {
            if (a[0] === '__none__') return 1;
            if (b[0] === '__none__') return -1;
            return String(a[1]).localeCompare(String(b[1]), 'ru');
        })
        .map(([key, label]) => {
            const esc = Utils.escapeHtml(label);
            const keyEsc = Utils.escapeHtml(key);
            return `<option value="${keyEsc}">${esc}</option>`;
        })
        .join('');

    let savedFilter = window.__auditState.auditMatrixFilterKey || '';
    if (savedFilter && !matrixOptionsMap.has(savedFilter)) savedFilter = '';
    window.__auditState.auditMatrixFilterKey = savedFilter;

    let savedCatFilter = window.__auditState.auditCategoryFilterKey || '';
    if (savedCatFilter && !categoryOptionsMap.has(savedCatFilter)) savedCatFilter = '';
    window.__auditState.auditCategoryFilterKey = savedCatFilter;

    const rows = (group.products || [])
        .map((p) => {
            const id = Number(p.id);
            const item = auditGetFullRecipeProduct(id);
            const bucket = auditProductMatrixBucket(item);
            const catBucket = auditProductCategoryBucket(item);
            const mkAttr = encodeURIComponent(bucket.key);
            const ckAttr = encodeURIComponent(catBucket.key);
            const isRef = Number.isFinite(refId) && id === refId;
            const st = auditProductRowStatus(refId, id);
            const name = Utils.escapeHtml(p.name || '');
            const titleFull = Utils.escapeHtml(p.name || '');
            const active =
                window.__auditState.focusedProductId != null &&
                Number(window.__auditState.focusedProductId) === id &&
                !isRef;
            const rowCls = `rec-audit-prow ${active ? 'rec-audit-prow--active' : ''}`;
            const badge = isRef
                ? '<span class="rec-audit-badge rec-audit-badge--ref font-11">Эталон</span>'
                : `<span class="rec-audit-prow-make-ref font-11">
                     <button type="button" class="btn btn-outline font-11 py-4 px-8 m-0" onclick="event.stopPropagation();auditSetGroupReference(${id})">Сделать эталоном</button>
                   </span>`;
            return `
            <div class="${rowCls} flex-between align-center gap-8 px-10 py-8 radius-6 mb-4"
              role="button" tabindex="0"
              data-audit-product-id="${id}"
              data-audit-matrix-key="${mkAttr}"
              data-audit-category-key="${ckAttr}"
              data-audit-is-ref="${isRef ? '1' : '0'}"
              onclick="auditFocusProduct(${id})"
              onkeydown="if(event.key==='Enter'||event.key===' ') { event.preventDefault(); auditFocusProduct(${id}); }">
              <div class="flex-row gap-8 align-center" style="min-width:0;flex:1;">
                <span class="flex-shrink-0" aria-hidden="true">${st.emoji}</span>
                <div class="font-13" style="min-width:0;">
                  <div class="rec-audit-prow-name text-ellipsis-single" title="${titleFull}">${name}</div>
                  ${badge}
                </div>
              </div>
            </div>`;
        })
        .join('');

    container.innerHTML = `
      <div class="rec-audit-category-filter-wrap mb-10">
        <label class="rec-filter-label" for="audit-left-category-filter">Категория</label>
        <select id="audit-left-category-filter" class="input-modern w-100 rec-audit-matrix-select font-13" onchange="auditApplyLeftCategoryFilter()">
          <option value="">Все</option>
          ${categoryRows}
        </select>
      </div>
      <div class="rec-audit-matrix-filter-wrap mb-10">
        <label class="rec-filter-label" for="audit-left-matrix-filter">Фильтр по матрице</label>
        <select id="audit-left-matrix-filter" class="input-modern w-100 rec-audit-matrix-select font-13" onchange="auditApplyLeftMatrixFilter()">
          <option value="">Все матрицы</option>
          ${matrixRows}
        </select>
      </div>
      <div class="rec-audit-prow-list" id="audit-left-prow-list">${rows}</div>`;

    const cSelRestore = document.getElementById('audit-left-category-filter');
    if (cSelRestore) cSelRestore.value = savedCatFilter;
    const sel = document.getElementById('audit-left-matrix-filter');
    if (sel) sel.value = savedFilter;
    auditApplyLeftPanelFilters();
}

function auditLayerCardHtml(title, agg) {
    let icon = '✅';
    let cls = 'rec-audit-layer-card rec-audit-layer-card--ok';
    let sub = '';
    if (agg.kind === 'diff') {
        icon = '✖';
        cls = 'rec-audit-layer-card rec-audit-layer-card--bad';
        sub = '<div class="text-muted font-12 mt-6">Есть отличия в составе или количествах</div>';
    } else if (agg.kind === 'pigment_ok') {
        icon = '✅';
        cls = 'rec-audit-layer-card rec-audit-layer-card--pig';
        sub = `<div class="font-12 mt-6 text-muted">${Utils.escapeHtml(agg.detail)}</div>`;
    } else {
        sub = '<div class="text-muted font-12 mt-6">Слой совпадает у всех загруженных позиций</div>';
    }
    return `
      <div class="card ${cls} p-12 mb-10">
        <div class="flex-row gap-10 align-center">
          <span class="font-18" aria-hidden="true">${icon}</span>
          <div class="font-14 font-600">${Utils.escapeHtml(title)}</div>
        </div>
        ${sub}
      </div>`;
}

function auditRenderGroupSummary() {
    const container = document.getElementById('audit-detail-right');
    if (!container) return;
    const k = window.__auditState.selectedGroupKey;
    const group = auditGetSelectedGroup();
    if (!k || !group) {
        container.innerHTML = '';
        return;
    }
    const agg = auditAggregateLayerStatusForGroup(k);
    const body = `
      <div class="font-14 font-600 mb-10">Сводка по слоям (к эталону)</div>
      ${auditLayerCardHtml('Основной слой', agg.main)}
      ${auditLayerCardHtml('Лицевой слой', agg.face)}
      ${auditLayerCardHtml('Упаковка', agg.packaging)}
      <button type="button" class="btn btn-blue w-100 font-14 py-12 mt-8" onclick="auditShowSyncModal(null)">Синхронизировать группу…</button>
      <p class="text-muted font-12 m-0 mt-10">Синхронизация копирует выбранные блоки с эталона на отмеченные позиции; для лица пигменты целевого товара сохраняются.</p>`;
    container.innerHTML = `<div class="rec-audit-right-panel">${body}</div>`;
}

function auditRenderProductDiff(targetId) {
    const container = document.getElementById('audit-detail-right');
    if (!container) return;
    const group = auditGetSelectedGroup();
    const refId = group && group.defaultReferenceId != null ? Number(group.defaultReferenceId) : null;
    const tid = Number(targetId);
    if (!group || !Number.isFinite(refId) || !Number.isFinite(tid)) {
        container.innerHTML = '<p class="text-muted font-13">Нет данных.</p>';
        return;
    }
    const pRow = (group.products || []).find((p) => Number(p.id) === tid);
    const title = Utils.escapeHtml(pRow ? pRow.name : `ID ${tid}`);
    const cmp = auditComparePair(refId, tid);

    let pigmentNote = '';
    let human = '';
    if (cmp.overallStatus === 'pigment_only') {
        pigmentNote =
            '<div class="rec-audit-pigment-note card p-10 mb-12 font-13">База идентична. Отличаются только пигменты (лицевой слой).</div>';
        human =
            '<p class="text-muted font-13 m-0">Детализация по пигментам при необходимости — вкладка «Сравнение рецептов».</p>';
    } else {
        human = auditRenderCompareHumanLines(cmp);
    }
    const warnNoData =
        cmp.overallStatus === 'no_data'
            ? '<p class="text-warning font-13">Рецепт не в кэше — обновите группу.</p>'
            : '';

    const body = `
      <div class="font-14 font-600 mb-8">Сравнение с эталоном</div>
      <div class="text-muted font-12 mb-10">${title}</div>
      ${pigmentNote}
      ${warnNoData}
      ${human}
      <div class="flex-row gap-10 flex-wrap mt-15">
        <button type="button" class="btn btn-outline font-13" onclick="auditFocusProduct(null)">К сводке группы</button>
        <button type="button" class="btn btn-blue font-13" onclick="auditShowSyncModal([${tid}])" ${
            cmp.overallStatus === 'no_data' ? 'disabled' : ''
        }>Приравнять к эталону</button>
      </div>`;
    container.innerHTML = `<div class="rec-audit-right-panel">${body}</div>`;
}

function auditRenderDetailRightPanel() {
    const fp = window.__auditState.focusedProductId;
    if (fp == null || !Number.isFinite(Number(fp))) {
        auditRenderGroupSummary();
    } else {
        auditRenderProductDiff(fp);
    }
}

function auditRenderDetailView() {
    const k = window.__auditState.selectedGroupKey;
    const group = k ? (window.__auditState.groups || {})[k] : null;
    const title = group ? Utils.escapeHtml(auditFormatGroupTitle(group)) : '';
    auditInstallDetailShell(title);
    auditRenderDetailLeft();
    auditRenderDetailRightPanel();
}

function auditCloseSyncOverlay() {
    const ov = document.getElementById('audit-sync-overlay');
    if (ov) {
        ov.classList.add('d-none');
        ov.setAttribute('aria-hidden', 'true');
    }
    const inner = document.getElementById('audit-sync-dialog-inner');
    if (inner) inner.innerHTML = '';
}

function auditShowSyncModal(targetIds) {
    const k = window.__auditState.selectedGroupKey;
    const group = auditGetSelectedGroup();
    if (!k || !group) return;
    auditComputeGroupSummary(k);
    const refId = group.defaultReferenceId != null ? Number(group.defaultReferenceId) : null;
    if (!Number.isFinite(refId)) {
        UI.toast('Не выбран эталон или нет рецептов в кэше', 'warning');
        return;
    }

    let targets = Array.isArray(targetIds) && targetIds.length
        ? targetIds.map(Number).filter((n) => Number.isFinite(n) && n !== refId)
        : auditCollectDefaultSyncTargets(k);
    targets = [...new Set(targets)];
    if (!targets.length) {
        UI.toast('Нет товаров для синхронизации (все совпадают с эталоном или не загружены)', 'info');
        return;
    }

    const ov = document.getElementById('audit-sync-overlay');
    const dlg = document.getElementById('audit-sync-dialog-inner');
    if (!ov || !dlg) return;

    const productChecks = targets
        .map((id) => {
            const pr = (group.products || []).find((p) => Number(p.id) === id);
            const nm = Utils.escapeHtml(pr ? pr.name : `ID ${id}`);
            return `
            <div class="rec-audit-sync-product-row mb-8">
              <label class="rec-inline-label font-13 m-0 w-100">
                <input type="checkbox" class="audit-sync-pid rec-checkbox-md" value="${Number(id)}" checked />
                ${nm}
              </label>
            </div>`;
        })
        .join('');

    dlg.innerHTML = `
      <div class="font-15 font-600 mb-10">Синхронизация с эталоном</div>
      <p class="text-muted font-12 m-0 mb-12">Эталон ID <strong>${refId}</strong>. Отметьте блоки и товары. Для лица в целевых позициях сохраняются пигменты.</p>
      <div class="font-13 font-600 mb-6">Слои</div>
      <div class="rec-audit-sync-layers mb-10">
        <div class="mb-6">
          <label class="rec-inline-label font-13 m-0">
            <input type="checkbox" class="audit-sync-layer rec-checkbox-md" value="main" checked />
            Основной слой
          </label>
        </div>
        <div class="mb-6">
          <label class="rec-inline-label font-13 m-0">
            <input type="checkbox" class="audit-sync-layer rec-checkbox-md" value="face" checked />
            Лицевой слой
          </label>
          <div class="text-muted font-11 mt-4" style="padding-left:24px;line-height:1.45;">База будет скопирована, уникальные цвета/пигменты сохранятся</div>
        </div>
        <div class="mb-0">
          <label class="rec-inline-label font-13 m-0">
            <input type="checkbox" class="audit-sync-layer rec-checkbox-md" value="packaging" checked />
            Упаковка
          </label>
        </div>
      </div>
      <div class="font-13 font-600 mb-6">Товары</div>
      <div class="rec-audit-sync-products mb-12">${productChecks}</div>
      <div class="flex-row gap-10 flex-wrap justify-end">
        <button type="button" class="btn btn-outline" onclick="auditCloseSyncOverlay()">Отмена</button>
        <button type="button" class="btn btn-blue" onclick="auditExecuteSync()">Выполнить</button>
      </div>`;

    ov.classList.remove('d-none');
    ov.setAttribute('aria-hidden', 'false');
}

async function auditExecuteSync() {
    const k = window.__auditState.selectedGroupKey;
    const group = auditGetSelectedGroup();
    if (!k || !group) return;
    const refId = group.defaultReferenceId != null ? Number(group.defaultReferenceId) : null;
    if (!Number.isFinite(refId)) return;

    const layerEls = document.querySelectorAll('.audit-sync-layer:checked');
    const layers = Array.from(layerEls).map((el) => normalizeRecipeLayer(el.value));
    if (!layers.length) {
        UI.toast('Выберите хотя бы один слой', 'warning');
        return;
    }

    const pidEls = document.querySelectorAll('.audit-sync-pid:checked');
    const targets = Array.from(pidEls)
        .map((el) => Number(el.value))
        .filter((n) => Number.isFinite(n) && n > 0 && n !== refId);
    if (!targets.length) {
        UI.toast('Отметьте хотя бы один товар', 'warning');
        return;
    }

    auditCloseSyncOverlay();
    UI.toast(`⏳ Синхронизация: ${targets.length} товар(ов)…`, 'info');

    let ok = 0;
    let fail = 0;
    for (let i = 0; i < targets.length; i++) {
        const tid = targets[i];
        const ing = auditBuildMergedIngredients(refId, tid, layers);
        if (!Array.isArray(ing) || ing.length === 0) {
            fail++;
            continue;
        }
        const pr = (group.products || []).find((p) => Number(p.id) === tid);
        const productName = pr ? pr.name : '';
        const res = await bomComparePostSaveRecipe(tid, productName, ing, false);
        if (res && res.ok) {
            await bomCompareFetchOneRecipe(tid);
            ok++;
        } else {
            fail++;
        }
    }

    if (ok) UI.toast(`✅ Сохранено рецептов: ${ok}${fail ? `, ошибок: ${fail}` : ''}`, fail ? 'warning' : 'success');
    else if (fail) UI.toast('Не удалось сохранить рецепты', 'error');

    auditRenderDetailLeft();
    auditRenderDetailRightPanel();
    auditRenderGroupsList();
}

function auditOpenGroupDetailFromBtn(btn) {
    const raw = btn && btn.getAttribute('data-audit-group-key');
    auditOpenGroupDetail(raw ? decodeURIComponent(raw) : '');
}

async function auditOpenGroupDetail(groupKey) {
    if (!groupKey) return;
    window.__auditState.selectedGroupKey = groupKey;
    window.__auditState.focusedProductId = null;
    window.__auditState.auditMatrixFilterKey = '';
    window.__auditState.auditCategoryFilterKey = '';

    const s1 = document.getElementById('audit-screen-1');
    const s2 = document.getElementById('audit-screen-2');
    const inner = document.getElementById('audit-screen-2-inner');
    if (!s1 || !s2 || !inner) return;

    s1.classList.add('d-none');
    s1.setAttribute('aria-hidden', 'true');
    s2.classList.remove('d-none');
    s2.setAttribute('aria-hidden', 'false');

    inner.innerHTML =
        '<div id="audit-detail-loading" class="p-24 text-center text-muted font-14">⏳ Загрузка рецептов группы…</div>';

    const group = (window.__auditState.groups || {})[groupKey];
    if (!group) {
        inner.innerHTML = '<p class="text-danger font-13 p-15">Группа не найдена.</p>';
        return;
    }

    const ids = (group.products || []).map((p) => Number(p.id)).filter((n) => Number.isFinite(n));
    const missing = ids.filter((id) => !auditRecipeRowLoadedInCache(id));
    if (missing.length) {
        try {
            await auditFetchRecipesForProductIds(missing);
        } catch (e) {
            console.error(e);
            UI.toast('Ошибка загрузки рецептов', 'error');
        }
    }

    await auditEnsureEquipmentMoldNamesLoaded();
    auditComputeGroupSummary(groupKey);
    auditRenderDetailView();
}

function auditOpen() {
    if (window.currentRecipeMode !== 'BOM' && typeof switchRecipeMode === 'function') switchRecipeMode('BOM');
    if (!Array.isArray(allRecipeProducts) || !allRecipeProducts.length) {
        UI.toast('Список товаров не загружен', 'error');
        return;
    }

    auditBuildGroups();

    const body = `
      <div class="rec-audit-modal-root">
        <p class="text-muted font-13 m-0 mb-12" style="line-height:1.5;">
          Группы по виду, толщине и фактуре (цвет внутри группы не учитывается).
          Индикаторы учитывают только товары, чьи рецепты уже загружены в память — для загрузки используйте «Сравнение рецептов».
        </p>
        <div id="audit-screen-1" class="rec-modal-content rec-audit-screen-1" style="max-height:min(62vh,560px);">
          <div id="audit-screen-1-inner" class="rec-audit-groups-list"></div>
        </div>
        <div id="audit-screen-2" class="d-none rec-audit-screen-2-wrap" aria-hidden="true">
          <div id="audit-screen-2-inner" class="rec-audit-screen-2-inner"></div>
          <div id="audit-sync-overlay" class="rec-audit-sync-overlay d-none" aria-hidden="true">
            <div class="rec-audit-sync-dialog card p-15" id="audit-sync-dialog-inner"></div>
          </div>
        </div>
      </div>`;

    UI.showModal(
        'Аудит рецептур',
        body,
        '<button type="button" class="btn btn-outline" onclick="UI.closeModal()">Закрыть</button>'
    );

    auditRenderGroupsList();
}

function bomRecipeMatrixSymbolPair(d) {
    if (!d) return { sym: '?', cls: 'rec-mtx-diag', tip: 'Нет данных по рецептам — нажмите «Загрузить рецепты»' };
    if (d.ingredientSetEqual) return { sym: '=', cls: 'rec-mtx-eq', tip: 'Одинаковый состав по слоям и количествам' };
    const hint = bomCompareLayerDiffSummary(d);
    return {
        sym: '≠',
        cls: 'rec-mtx-diff',
        tip: hint ? `Отличия в блоках: ${hint}` : 'Есть отличия (см. вкладку «Пара» для деталей)'
    };
}

function buildBomCompareMatrixCells(idList) {
    const n = idList.length;
    const cells = [];
    for (let i = 0; i < n; i++) {
        cells[i] = [];
        for (let j = 0; j < n; j++) {
            if (i === j) cells[i][j] = { sym: '—', cls: 'rec-mtx-diag', tip: 'Этот же товар' };
            else if (j < i) cells[i][j] = cells[j][i];
            else cells[i][j] = bomRecipeMatrixSymbolPair(compareBomRecipesPair(idList[i].id, idList[j].id));
        }
    }
    return cells;
}

async function bomCompareFetchOneRecipe(productId) {
    const id = Number(productId);
    if (!Number.isFinite(id)) return;
    try {
        const raw = await API.get(`/api/recipes/${id}`);
        bomRecipeCompareCache[String(id)] = mapApiRecipeToBomCompareRows(raw);
    } catch (e2) {
        bomRecipeCompareCache[String(id)] = [];
    }
}


function bomCompareRefreshStatusLine() {
    const el = document.getElementById('bomrc-status-text');
    if (!el) return;
    const list = window.bomCompareFilteredProducts || [];
    let loaded = 0;
    list.forEach((p) => {
        if (bomRecipeCompareCache[String(p.id)] !== undefined) loaded++;
    });
    el.innerText = `В выборке товаров: ${list.length}. Рецепты в памяти: ${loaded}.`;
}

function bomCompareBindProductSelects() {
    const html = bomCompareProductOptionsHtml();
    ['bomrc-a', 'bomrc-b', 'bomrc-baseline-ref'].forEach((id) => {
        const s = document.getElementById(id);
        if (s) {
            const cur = s.value;
            s.innerHTML = `<option value="">—</option>${html}`;
            if (cur && [...s.options].some((o) => o.value === cur)) s.value = cur;
        }
    });
}

window.bomCompareRebuildProductSelection = function () {
    window.bomCompareFilteredProducts = bomCompareFilteredProductsList();
    bomCompareBindProductSelects();
    bomCompareRefreshStatusLine();
};

window.switchBomCompareTab = function (tab) {
    document.querySelectorAll('.bom-rc-tab-btn').forEach((btn) => {
        const on = btn.getAttribute('data-tab') === tab;
        btn.classList.toggle('btn-blue', on);
        btn.classList.toggle('shadow-primary', on);
        btn.classList.toggle('btn-outline', !on);
        btn.classList.toggle('text-primary', !on);
    });
    document.querySelectorAll('.bom-rc-panel').forEach((panel) => {
        panel.classList.toggle('d-none', panel.getAttribute('data-panel') !== tab);
    });
    if (tab === 'baseline') window.refreshBomCompareBaseline();
    if (tab === 'clones') window.refreshBomCompareClones();
    if (tab === 'matrix') window.refreshBomCompareMatrix();
};

window.refreshBomComparePair = function () {
    const sumEl = document.getElementById('bomrc-pair-summary');
    const tablesEl = document.getElementById('bomrc-pair-tables');
    const aEl = document.getElementById('bomrc-a');
    const bEl = document.getElementById('bomrc-b');
    if (!sumEl || !tablesEl || !aEl || !bEl) return;
    const pidA = parseInt(aEl.value, 10);
    const pidB = parseInt(bEl.value, 10);
    if (!pidA || !pidB) {
        sumEl.innerHTML = '<span class="rec-compare-chip bad">Выберите два товара</span>';
        tablesEl.innerHTML = '';
        return;
    }
    if (pidA === pidB) {
        sumEl.innerHTML = '<span class="rec-compare-chip bad">Выберите два разных товара</span>';
        tablesEl.innerHTML = '';
        return;
    }
    const d = compareBomRecipesPair(pidA, pidB);
    if (!d) {
        sumEl.innerHTML = '<span class="rec-compare-chip warn">Нет данных: загрузите рецепты по фильтру (кнопка «Загрузить рецепты»)</span>';
        tablesEl.innerHTML = '';
        return;
    }
    let chips = '';
    chips += d.ingredientSetEqual
        ? '<span class="rec-compare-chip ok">Состав совпадает полностью</span>'
        : '<span class="rec-compare-chip warn">Есть различия</span>';
    const layerHint = bomCompareLayerDiffSummary(d);
    if (!d.ingredientSetEqual && layerHint) {
        chips += `<span class="rec-compare-chip bad" title="Где отличаются составы">Δ ${Utils.escapeHtml(layerHint)}</span>`;
    }
    chips += `<span class="rec-compare-chip">${d.countA} строк / ${d.countB} строк</span>`;
    sumEl.innerHTML = chips;

    const esc = (s) => Utils.escapeHtml(String(s));
    const row = (cls, cells) => `<tr class="${cls}">${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
    const fmt = (q) => (Number.isFinite(Number(q)) ? Number(q).toFixed(3) : '0');
    let inner = '';

    const sameS = sortBomCompareRowsByLayer(d.same);
    const qtyS = sortBomCompareRowsByLayer(d.qtyDiff);
    const onlyAS = sortBomCompareRowsByLayer(d.onlyA);
    const onlyBS = sortBomCompareRowsByLayer(d.onlyB);

    if (sameS.length) {
        inner += '<p class="rec-compare-subtitle">Совпадают</p><div class="rec-compare-table-wrap"><table class="rec-compare-table"><thead><tr><th>Блок</th><th>Сырьё</th><th class="rec-cell-right">Кол-во</th><th>Ед.</th></tr></thead><tbody>';
        sameS.forEach((x) => inner += row('', [esc(layerLabel(x.layer)), esc(x.name), fmt(x.qty), esc(x.unit)]));
        inner += '</tbody></table></div>';
    }
    if (qtyS.length) {
        inner += '<p class="rec-compare-subtitle">Один блок, разное количество</p><div class="rec-compare-table-wrap"><table class="rec-compare-table"><thead><tr><th>Блок</th><th>Сырьё</th><th class="rec-cell-right">В A</th><th class="rec-cell-right">В B</th><th>Ед.</th></tr></thead><tbody>';
        qtyS.forEach((x) => inner += row('rec-compare-row-qty', [esc(layerLabel(x.layer)), esc(x.name), fmt(x.qtyA), fmt(x.qtyB), esc(x.unit)]));
        inner += '</tbody></table></div>';
    }
    if (onlyAS.length) {
        inner += '<p class="rec-compare-subtitle">Только в товаре A</p><div class="rec-compare-table-wrap"><table class="rec-compare-table"><thead><tr><th>Блок</th><th>Сырьё</th><th class="rec-cell-right">Кол-во</th></tr></thead><tbody>';
        onlyAS.forEach((x) => inner += row('rec-compare-row-onlya', [esc(layerLabel(x.layer)), esc(x.name), fmt(x.qty)]));
        inner += '</tbody></table></div>';
    }
    if (onlyBS.length) {
        inner += '<p class="rec-compare-subtitle">Только в товаре B</p><div class="rec-compare-table-wrap"><table class="rec-compare-table"><thead><tr><th>Блок</th><th>Сырьё</th><th class="rec-cell-right">Кол-во</th></tr></thead><tbody>';
        onlyBS.forEach((x) => inner += row('rec-compare-row-onlyb', [esc(layerLabel(x.layer)), esc(x.name), fmt(x.qty)]));
        inner += '</tbody></table></div>';
    }
    if (!inner) inner = '<p class="text-muted font-13">Оба рецепта пусты.</p>';
    tablesEl.innerHTML = inner;
    setTimeout(() => {
        const er = document.querySelector('input[name="bomrc-edit-which"]:checked');
        if (er && er.value && typeof bomCompareMiniEditorReload === 'function') bomCompareMiniEditorReload();
    }, 0);
};

window.refreshBomCompareBaseline = function () {
    const host = document.getElementById('bomrc-baseline-body');
    const refEl = document.getElementById('bomrc-baseline-ref');
    if (!host || !refEl) return;
    const refId = parseInt(refEl.value, 10);
    if (!refId) {
        host.innerHTML = '<p class="text-muted font-13">Выберите эталонный товар.</p>';
        return;
    }
    const list = window.bomCompareFilteredProducts || [];
    const esc = (s) => Utils.escapeHtml(String(s));
    let rows = '';
    list.forEach((p) => {
        if (p.id === refId) return;
        const d = compareBomRecipesPair(refId, p.id);
        if (!d) {
            rows += `<tr><td class="rec-cell-center"><input type="checkbox" disabled class="bomrc-baseline-cb" value="${Number(p.id)}" data-diff="0"></td><td>${esc(p.name)}</td><td><span class="rec-compare-chip bad">нет данных</span></td><td>—</td></tr>`;
            return;
        }
        let statusText = '';
        let statusClass = 'ok';
        if (d.ingredientSetEqual) {
            statusText = 'Идентично эталону';
            statusClass = 'ok';
        } else {
            const bits = [];
            if (d.onlyB.length) bits.push(`+${d.onlyB.length}`);
            if (d.onlyA.length) bits.push(`−${d.onlyA.length}`);
            if (d.qtyDiff.length) bits.push(`±${d.qtyDiff.length}`);
            statusText = bits.join('; ');
            statusClass = 'bad';
        }
        const lyHint = (!d.ingredientSetEqual && bomCompareLayerDiffSummary(d)) ? bomCompareLayerDiffSummary(d) : '—';
        const checked = !d.ingredientSetEqual;
        rows += `<tr>
            <td class="rec-cell-center"><input type="checkbox" class="bomrc-baseline-cb" value="${Number(p.id)}" data-diff="${checked ? '1' : '0'}" ${checked ? 'checked' : ''}></td>
            <td>${esc(p.name)}</td>
            <td><span class="rec-compare-chip ${statusClass}">${esc(statusText)}</span></td>
            <td class="font-12 text-muted">${esc(lyHint)}</td>
        </tr>`;
    });
    host.innerHTML = `
        <div class="rec-compare-table-wrap rec-compare-body-scroll">
            <table class="rec-compare-table">
                <thead>
                    <tr>
                        <th class="rec-cell-center rec-chk-col"><input type="checkbox" id="bomrc-baseline-master" title="Строки с отличиями / снять все" onchange="bomCompareBaselineToggleAll(this.checked)"></th>
                        <th>Товар</th><th>Отличие от эталона</th><th>Блоки с отличиями</th>
                    </tr>
                </thead>
                <tbody>${rows || '<tr><td colspan="4" class="text-muted p-10">Список пуст</td></tr>'}</tbody>
            </table>
        </div>`;
    const master = document.getElementById('bomrc-baseline-master');
    if (master) master.disabled = !document.querySelector('.bomrc-baseline-cb');
};

window.bomCompareBaselineToggleAll = function (checked) {
    document.querySelectorAll('.bomrc-baseline-cb:not(:disabled)').forEach((cb) => {
        if (!checked) cb.checked = false;
        else cb.checked = cb.getAttribute('data-diff') === '1';
    });
};

function bomCompareGetSyncLayersPayload() {
    const face = document.getElementById('bomrc-layer-face');
    const main = document.getElementById('bomrc-layer-main');
    const pack = document.getElementById('bomrc-layer-packaging');
    if (!face || !main || !pack) return null;
    const layers = [];
    if (face.checked) layers.push('face');
    if (main.checked) layers.push('main');
    if (pack.checked) layers.push('packaging');
    if (layers.length === 0) {
        UI.toast('Отметьте хотя бы один блок: лицевой / основной / упаковка', 'error');
        return '__invalid';
    }
    if (layers.length === 3) return null;
    return layers;
}

function bomCompareSyncLayersHuman(lyPayload) {
    if (!lyPayload || lyPayload.length === 0) return 'все блоки (полный рецепт)';
    const map = { face: 'лицевой', main: 'основной', packaging: 'упаковка' };
    return lyPayload.map((l) => map[l] || l).join(', ');
}

async function bomCompareEnsureMaterialsLoaded() {
    if (Array.isArray(allMaterialsList) && allMaterialsList.length) return;
    try {
        const matData = await API.get('/api/items?item_type=material&limit=500');
        allMaterialsList = matData.data || [];
        auditComputePigmentIds();
    } catch (e) {
        console.error(e);
        UI.toast('Не удалось загрузить справочник сырья', 'error');
    }
}

function bomCompareMaterialOptionsHtml(selectedId) {
    const sel = Number(selectedId);
    let html = '<option value="">— материал —</option>';
    (allMaterialsList || []).forEach((m) => {
        const id = Number(m.id);
        html += `<option value="${id}"${id === sel ? ' selected' : ''}>${Utils.escapeHtml(m.name)}</option>`;
    });
    return html;
}

function bomCompareMiniLayerSelectHtml(layerVal) {
    const s = normalizeRecipeLayer(layerVal);
    return [
        ['face', 'Лицевой'],
        ['main', 'Основной'],
        ['packaging', 'Упаковка']
    ]
        .map(([v, lab]) => `<option value="${v}"${v === s ? ' selected' : ''}>${lab}</option>`)
        .join('');
}

window.bomCompareMiniDeleteRow = function (btn) {
    const tr = btn && btn.closest('tr');
    if (tr && tr.parentNode) tr.parentNode.removeChild(tr);
};

window.bomCompareMiniAddRow = function () {
    const tb = document.querySelector('#bomrc-mini-editor-inner tbody');
    if (!tb) return;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><select class="input-modern bomrc-mini-mat" style="max-width:100%">${bomCompareMaterialOptionsHtml('')}</select></td>
      <td><select class="input-modern bomrc-mini-layer">${bomCompareMiniLayerSelectHtml('main')}</select></td>
      <td><input type="number" class="input-modern bomrc-mini-qty" step="any" min="0" value=""/></td>
      <td><button type="button" class="btn btn-outline font-12" onclick="bomCompareMiniDeleteRow(this)">Удалить</button></td>`;
    tb.appendChild(tr);
};

window.bomCompareMiniEditorReload = async function () {
    const shell = document.getElementById('bomrc-mini-editor-wrap');
    const bodyInner = document.getElementById('bomrc-mini-editor-inner');
    if (!shell || !bodyInner) return;
    const r = document.querySelector('input[name="bomrc-edit-which"]:checked');
    const which = r ? r.value : '';
    if (!which) {
        shell.classList.add('d-none');
        return;
    }
    await bomCompareEnsureMaterialsLoaded();
    const sel = document.getElementById(which === 'a' ? 'bomrc-a' : 'bomrc-b');
    const pid = sel ? parseInt(sel.value, 10) : 0;
    if (!pid) {
        UI.toast(`Сначала выберите товар ${which.toUpperCase()} в паре`, 'warning');
        shell.classList.add('d-none');
        return;
    }
    const rows = bomRecipeCompareCache[String(pid)];
    if (rows === undefined) {
        UI.toast('Нет рецепта в памяти — нажмите «Загрузить рецепты»', 'warning');
        shell.classList.add('d-none');
        return;
    }
    shell.classList.remove('d-none');
    let trs = '';
    const sorted = sortBomCompareRowsByLayer(rows);
    sorted.forEach((row) => {
        const mid = Number(row.materialId);
        const qDisp = Number.isFinite(Number(row.qty)) ? Number(row.qty) : '';
        trs += `<tr>
          <td><select class="input-modern bomrc-mini-mat" style="max-width:100%">${bomCompareMaterialOptionsHtml(mid)}</select></td>
          <td><select class="input-modern bomrc-mini-layer">${bomCompareMiniLayerSelectHtml(row.layer)}</select></td>
          <td><input type="number" class="input-modern bomrc-mini-qty" step="any" min="0" value="${qDisp}" /></td>
          <td><button type="button" class="btn btn-outline font-12" onclick="bomCompareMiniDeleteRow(this)">Удалить</button></td>
        </tr>`;
    });
    const emptyHint = sorted.length === 0 ? '<p class="text-muted font-12 m-0 mb-6">Строк пока нет — «+ строка».</p>' : '';
    bodyInner.innerHTML = `
      <p class="text-muted font-12 m-0 mb-8">Товар ID <strong>${pid}</strong> — «Сохранить» отправляет состав на сервер (как в основном редакторе).</p>${emptyHint}
      <div class="rec-compare-table-wrap rec-mini-editor-scroll">
        <table class="rec-compare-table"><thead><tr><th>Сырьё</th><th>Блок</th><th class="rec-cell-right">Кол-во</th><th></th></tr></thead>
        <tbody>${trs}</tbody></table>
      </div>
      <div class="flex-row gap-10 mt-10 flex-wrap">
        <button type="button" class="btn btn-outline font-13" onclick="bomCompareMiniAddRow()">+ Строка</button>
        <button type="button" class="btn btn-green font-13" onclick="bomCompareSaveMiniEditor()">💾 Сохранить на сервере</button>
      </div>`;
};

function bomComparePickProductNameFromSelect(which, pid) {
    const sel = document.getElementById(which === 'a' ? 'bomrc-a' : 'bomrc-b');
    if (!sel) return '';
    const opt = sel.options[sel.selectedIndex];
    if (opt && String(opt.value) === String(pid)) return opt.text || '';
    const o2 = [...sel.options].find((o) => String(o.value) === String(pid));
    return o2 ? o2.text : '';
}

function bomCompareResolveMaterialName(materialId) {
    const m = (allMaterialsList || []).find((x) => Number(x.id) === Number(materialId));
    return m ? m.name : `Материал #${materialId}`;
}

async function bomComparePostSaveRecipe(productId, productName, ingredients, force) {
    const payload = {
        productId,
        productName: productName || '',
        ingredients,
        force: Boolean(force)
    };
    try {
        await API.post('/api/recipes/save', payload);
        return { ok: true };
    } catch (e) {
        if (e.body && e.body.warning && !force) {
            return new Promise((resolve) => {
                window.__recipeConfirm = async function() {
                    UI.closeModal();
                    resolve(await bomComparePostSaveRecipe(productId, productName, ingredients, true));
                };
                UI.showModal('Предупреждение',
                    `<div class="p-10 font-15">${Utils.escapeHtml(String(e.body.warning)).replace(/\n/g, '<br>')}</div>`,
                    `<button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
                     <button class="btn btn-blue" onclick="window.__recipeConfirm()">Продолжить</button>`
                );
            });
        }
        const msg = (e.body && (e.body.error || e.body.warning)) || e.message || 'Ошибка';
        UI.toast(String(msg), 'error');
        return { ok: false };
    }
}

window.bomCompareSaveMiniEditor = async function () {
    const r = document.querySelector('input[name="bomrc-edit-which"]:checked');
    const which = r ? r.value : '';
    if (!which) {
        UI.toast('Выберите товар A или B для правки', 'warning');
        return;
    }
    await bomCompareEnsureMaterialsLoaded();
    const sel = document.getElementById(which === 'a' ? 'bomrc-a' : 'bomrc-b');
    const pid = sel ? parseInt(sel.value, 10) : 0;
    if (!pid) {
        UI.toast('Не выбран товар', 'error');
        return;
    }
    const tb = document.querySelector('#bomrc-mini-editor-inner tbody');
    if (!tb) return;
    const collected = [];
    tb.querySelectorAll('tr').forEach((tr, idx) => {
        const matEl = tr.querySelector('.bomrc-mini-mat');
        const layerEl = tr.querySelector('.bomrc-mini-layer');
        const qtyEl = tr.querySelector('.bomrc-mini-qty');
        const mid = matEl ? parseInt(matEl.value, 10) : 0;
        const lay = layerEl ? normalizeRecipeLayer(layerEl.value) : 'main';
        const q = qtyEl ? parseFloat(qtyEl.value) : NaN;
        if (!Number.isFinite(mid) || mid <= 0) return;
        if (!Number.isFinite(q) || q <= 0) return;
        const m = (allMaterialsList || []).find((x) => Number(x.id) === mid);
        collected.push({
            materialId: mid,
            name: m ? m.name : bomCompareResolveMaterialName(mid),
            qty: q,
            unit: (m && m.unit) ? m.unit : 'кг',
            price: m ? parseFloat(m.current_price) || 0 : 0,
            layer: lay,
            order: idx
        });
    });
    const productName = bomComparePickProductNameFromSelect(which, pid);
    const ingredients = bomCanonicalizeFetchedRows(collected).map((ing, idx) => ({
        materialId: Number(ing.materialId),
        name: ing.name,
        qty: parseFloat(ing.qty),
        unit: ing.unit || 'кг',
        price: ing.price || 0,
        layer: normalizeRecipeLayer(ing.layer),
        order: normalizeRecipeOrder(idx)
    }));
    if (!ingredients.length) {
        window.__recipeConfirm = async function() {
            UI.closeModal();
            UI.toast('⏳ Сохранение...', 'info');
            const res2 = await bomComparePostSaveRecipe(pid, productName, [], false);
            if (!res2.ok) return;
            UI.toast('✅ Сохранено', 'success');
            delete bomRecipeCompareCache[String(pid)];
            await bomCompareFetchOneRecipe(pid);
            bomCompareRefreshStatusLine();
            refreshBomComparePair(); refreshBomCompareBaseline(); refreshBomCompareClones(); refreshBomCompareMatrix();
            await bomCompareMiniEditorReload();
        };
        UI.showModal('Пустой рецепт',
            `<div class="p-10 font-15">Сохранить пустой рецепт?<br><span class="text-danger font-13">Все строки товара ID <strong>${pid}</strong> будут удалены.</span></div>`,
            `<button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
             <button class="btn btn-blue" onclick="window.__recipeConfirm()">Да, удалить всё</button>`
        );
        return;
    }
    UI.toast('⏳ Сохранение...', 'info');
    const res = await bomComparePostSaveRecipe(pid, productName, ingredients, false);
    if (!res.ok) return;
    UI.toast('✅ Сохранено', 'success');
    delete bomRecipeCompareCache[String(pid)];
    await bomCompareFetchOneRecipe(pid);
    bomCompareRefreshStatusLine();
    refreshBomComparePair();
    refreshBomCompareBaseline();
    refreshBomCompareClones();
    refreshBomCompareMatrix();
    await bomCompareMiniEditorReload();
};

window.executeBulkBomFromCompare = async function (sourcePid, targetIds) {
    const sid = String(sourcePid);
    const srcRows = bomRecipeCompareCache[sid];
    if (!srcRows) {
        UI.toast('Нет данных источника в памяти', 'error');
        return false;
    }
    const lyPayload = bomCompareGetSyncLayersPayload();
    if (lyPayload === '__invalid') return false;
    const rowsForSync = lyPayload
        ? srcRows.filter((ing) => lyPayload.includes(normalizeRecipeLayer(ing.layer)))
        : srcRows;
    const modeSel = document.getElementById('bomrc-sync-mode');
    const mode = modeSel && modeSel.value === 'replace_all' ? 'replace_all' : 'upsert';
    const materials = rowsForSync.map((ing, idx) => ({
        materialId: Number(ing.materialId),
        qty: parseFloat(ing.qty),
        layer: normalizeRecipeLayer(ing.layer),
        order: normalizeRecipeOrder(ing.order ?? idx)
    })).filter((m) => Number.isFinite(Number(m.materialId)) && Number(m.materialId) > 0 && Number.isFinite(Number(m.qty)) && Number(m.qty) > 0);
    const targetsNum = [...new Set((targetIds || []).map(Number))].filter((x) => Number.isFinite(x) && x > 0 && x !== Number(sourcePid));
    if (!targetsNum.length) {
        UI.toast('Не выбраны цели', 'error');
        return false;
    }
    if (!materials.length) {
        UI.toast('В источнике нет строк в выбранных блоках — расширьте отметки блоков или загрузите рецепт', 'error');
        return false;
    }
    UI.toast('⏳ Синхронизация...', 'info');
    try {
        const body = {
            targetProductIds: targetsNum,
            mode,
            materials
        };
        if (lyPayload && lyPayload.length) body.layers = lyPayload;
        await API.post('/api/recipes/sync-category', body);
        targetsNum.forEach((id) => { delete bomRecipeCompareCache[String(id)]; });
        delete bomRecipeCompareCache[sid];
        UI.toast('✅ Применено', 'success');
        const ts = document.getElementById('recipe-product-select').tomselect;
        const cur = ts ? ts.getValue() : document.getElementById('recipe-product-select').value;
        if (cur && (targetsNum.includes(Number(cur)) || Number(cur) === Number(sourcePid)) && typeof loadRecipeDetails === 'function') {
            loadRecipeDetails();
        }
        if (typeof bomCompareFetchOneRecipe === 'function') await bomCompareFetchOneRecipe(sourcePid).catch(()=>{});
        for (let i = 0; i < targetsNum.length; i++) await bomCompareFetchOneRecipe(targetsNum[i]).catch(()=>{});
        bomCompareRefreshStatusLine();
        return true;
    } catch (e) {
        console.error(e);
        const msg = (e.body && (e.body.error || e.body.warning)) || e.message || 'Ошибка';
        UI.toast(String(msg), 'error');
        return false;
    }
};

window.refreshBomCompareClones = function () {
    const host = document.getElementById('bomrc-clones-body');
    if (!host) return;
    const list = window.bomCompareFilteredProducts || [];
    const cmap = new Map();
    list.forEach((p) => {
        const rows = bomRecipeCompareCache[String(p.id)];
        if (rows === undefined) return;
        const fp = bomCompareFingerprintFromRows(rows);
        if (!cmap.has(fp)) cmap.set(fp, []);
        cmap.get(fp).push(p);
    });
    const esc = (s) => Utils.escapeHtml(String(s));
    const groups = Array.from(cmap.values()).filter((g) => g.length > 1).sort((a, b) => b.length - a.length);
    let html = '';
    groups.forEach((g, idx) => {
        html += `<div class="rec-panel rec-panel-compact mb-10"><p class="rec-panel-title m-0 font-13">Группа ${idx + 1}: ${g.length} товаров</p><ul class="m-0 pl-20 font-13">`;
        g.forEach((x) => { html += `<li>${esc(x.name)} (${x.id})</li>`; });
        html += '</ul></div>';
    });
    host.innerHTML = html || '<p class="text-muted font-13">Нет загруженных дубликатов (или различаются). Загрузите рецепты.</p>';
};

window.refreshBomCompareMatrix = function () {
    const host = document.getElementById('bomrc-matrix-body');
    const note = document.getElementById('bomrc-matrix-note');
    if (!host) return;
    const list = window.bomCompareFilteredProducts || [];
    if (!list.length) {
        host.innerHTML = '';
        if (note) note.textContent = 'Список товаров пуст — примените фильтр.';
        return;
    }
    const MAX = 28;
    const use = list.length > MAX ? list.slice(0, MAX) : list;
    if (note) {
        note.textContent = list.length > MAX ? `Показаны первые ${MAX} из ${list.length} товаров.` : `Товаров: ${use.length}. = одинаково · ≠ отличаются · ? нет данных.`;
    }
    const cells = buildBomCompareMatrixCells(use);
    const esc = (s) => Utils.escapeHtml(String(s));
    const shortTxt = (txt, max) => {
        const t = String(txt || '');
        return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
    };
    let head = `<tr><th class="rec-mtx-corner rec-mtx-colhead">${esc('Товар')}</th>`;
    use.forEach((m) => { head += `<th class="rec-mtx-colhead" title="${esc(m.name)}">${esc(shortTxt(m.name, 11))}</th>`; });
    head += '</tr>';
    let body = '';
    for (let i = 0; i < use.length; i++) {
        body += `<tr><th scope="row" class="rec-mtx-rowhead" title="${esc(use[i].name)}">${esc(shortTxt(use[i].name, 16))}</th>`;
        for (let j = 0; j < use.length; j++) {
            const c = cells[i][j];
            body += `<td class="${c.cls}" title="${esc(c.tip)}">${esc(c.sym)}</td>`;
        }
        body += '</tr>';
    }
    host.innerHTML = `<div class="rec-mtx-wrap"><table class="rec-mtx-table"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
};

window.bomCompareApplyPair = async function (dir) {
    const aEl = document.getElementById('bomrc-a');
    const bEl = document.getElementById('bomrc-b');
    const pidA = parseInt(aEl.value, 10);
    const pidB = parseInt(bEl.value, 10);
    if (!pidA || !pidB || pidA === pidB) { UI.toast('Выберите два разных товара', 'error'); return; }
    const source = dir === 'AtoB' ? pidA : pidB;
    const target = dir === 'AtoB' ? pidB : pidA;
    window.__recipeConfirm = async function() {
        UI.closeModal();
        const ok = await executeBulkBomFromCompare(source, [target]);
        if (ok) { refreshBomComparePair(); refreshBomCompareBaseline(); refreshBomCompareClones(); refreshBomCompareMatrix(); }
    };
    UI.showModal('Подтверждение',
        `<div class="p-10 font-15">Применить рецепт к товару <strong>${Utils.escapeHtml(String(target))}</strong>?<br><span class="text-muted font-13">Режим синхронизации и блоки — см. настройки выше.</span></div>`,
        `<button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
         <button class="btn btn-blue shadow-primary" onclick="window.__recipeConfirm()">Применить</button>`
    );
};

window.bomCompareApplyBaseline = async function () {
    const lyr = bomCompareGetSyncLayersPayload();
    if (lyr === '__invalid') return;
    const refEl = document.getElementById('bomrc-baseline-ref');
    const refId = parseInt(refEl.value, 10);
    const targets = Array.from(document.querySelectorAll('.bomrc-baseline-cb:checked')).map((cb) => parseInt(cb.value, 10)).filter(Boolean);
    if (!refId) { UI.toast('Выберите эталон', 'error'); return; }
    if (!targets.length) { UI.toast('Выберите товары', 'error'); return; }
    const scope = bomCompareSyncLayersHuman(lyr);
    window.__recipeConfirm = async function() {
        UI.closeModal();
        const ok = await executeBulkBomFromCompare(refId, targets);
        if (ok) { refreshBomCompareBaseline(); refreshBomCompareClones(); refreshBomCompareMatrix(); refreshBomComparePair(); }
    };
    UI.showModal('Подтверждение',
        `<div class="p-10 font-15">Применить эталон к <strong>${targets.length}</strong> товарам?<br><span class="text-muted font-13">Блоки: ${Utils.escapeHtml(scope)}</span></div>`,
        `<button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
         <button class="btn btn-blue shadow-primary" onclick="window.__recipeConfirm()">Применить</button>`
    );
};

window.bomCompareExportSnapshot = async function () {
    const lines = ['Сводка: сравнение рецептов продукции', `UTC: ${new Date().toISOString()}`, ''];
    lines.push('--- Пара ---');
    const ae = document.getElementById('bomrc-a');
    const be = document.getElementById('bomrc-b');
    if (ae && be && ae.value && be.value) {
        const d = compareBomRecipesPair(Number(ae.value), Number(be.value));
        lines.push(`${ae.value} ↔ ${be.value}: ${d ? (d.ingredientSetEqual ? '=' : '≠') : 'нет данных'}`);
    }
    lines.push('');
    lines.push('--- Эталон (кратко) ---');
    const refEl = document.getElementById('bomrc-baseline-ref');
    const ref = refEl && refEl.value ? parseInt(refEl.value, 10) : 0;
    if (ref && Array.isArray(window.bomCompareFilteredProducts)) {
        window.bomCompareFilteredProducts.filter((x) => x.id !== ref).forEach((p) => {
            const d = compareBomRecipesPair(ref, p.id);
            if (d && !d.ingredientSetEqual) lines.push(`• ${p.id} ${p.name}: отличается`);
        });
    }
    lines.push('');
    lines.push('--- Таблица (TSV заголовков) ---');
    const list = window.bomCompareFilteredProducts || [];
    if (list.length) {
        lines.push(buildBomCompareMatrixTsvExport(list.slice(0, 32)));
    }
    await mixCompareWriteClipboard(lines.join('\n'));
};

function buildBomCompareMatrixTsvExport(use) {
    const ids = use.map((x) => x.id);
    const cells = buildBomCompareMatrixCells(use);
    const rows = [[''].concat(ids.map(String))];
    use.forEach((p, i) => {
        const row = [`${String(p.name).replace(/\t/g,' ')}`];
        ids.forEach((_, j) => row.push(String(cells[i][j].sym)));
        rows.push(row);
    });
    return rows.map((r) => r.join('\t')).join('\n');
}

window.bomCompareFetchBtn = async function () {
    bomCompareRebuildProductSelection();
    await bomCompareFetchAllInSelection();
};

window.showBomRecipeCompareWorkbench = function () {
    if (window.currentRecipeMode !== 'BOM' && typeof switchRecipeMode === 'function') switchRecipeMode('BOM');
    if (!Array.isArray(allRecipeProducts) || !allRecipeProducts.length) {
        UI.toast('Список товаров не загружен', 'error');
        return;
    }
    const filtHtml =
        `<div class="rec-panel rec-panel-compact mb-15">
          <details class="rec-bom-workflow-details mb-12" open>
            <summary class="font-14 font-600 mb-6">Как работать со сравнением рецептов</summary>
            <div class="text-muted font-13" style="line-height:1.55;padding-left:2px;">
              <ol class="m-0 pl-20 mb-8">
                <li class="mb-6"><strong>Задайте линейку.</strong> Пример «серая гладкая 2П6»: вид <em>Плитка</em>, толщина <em>60мм</em>, фактура <em>Гладкая</em>, цвет <em>Серый</em>. В списке останутся все подходящие SKU (разные форматы с&nbsp;общими признаками в названии).</li>
                <li class="mb-6"><strong>Обновить список</strong>, затем <strong>Загрузить рецепты</strong> — без этого вкладки сравнения пустые.</li>
                <li class="mb-6"><strong>Колонка «Блок»</strong> — слой рецепта (лицевой / основной / упаковка). Чекбоксы «Копировать при A→B» ограничивают перенос: например только <em>Упаковка</em>, если лицевой и основной совпадают.</li>
                <li class="mb-6"><strong>Пара</strong> — сравнение и кнопки A→B. Ниже — мини‑редактор: можно править строки одного из товаров и сохранить на сервере без закрытия окна.</li>
                <li class="mb-6"><strong>От эталона</strong> — эталон, например ваша базовая 2П6; отмечены товары с отличиями, колонка «Блоки с отличиями» коротко говорит где (упаковка / лицевой / основной).</li>
                <li><strong>Править детально</strong> — закройте окно и отредактируйте рецепт в основном редакторе модуля; здесь массовое копирование целого состава между товарами.</li>
              </ol>
            </div>
          </details>
          <div class="rec-mini-grid">
            <div class="form-group m-0">
              <label class="rec-filter-label">Вид продукции</label>
              <select id="bomrc-f-type" class="input-modern rec-filter-select" onchange="bomCompareToggleThicknessDisabled(); bomCompareRebuildProductSelection();">
                ${['Все','Плитка','Бордюр','Поребрик','Блок'].map((v)=>`<option value="${v}">${Utils.escapeHtml(v)}</option>`).join('')}
              </select>
            </div>
            <div class="form-group m-0">
              <label class="rec-filter-label">Толщина</label>
              <select id="bomrc-f-thickness" class="input-modern rec-filter-select" onchange="bomCompareRebuildProductSelection();">
                ${['Все','40мм','60мм','80мм'].map(v=>`<option value="${v}">${v}</option>`).join('')}
              </select>
            </div>
            <div class="form-group m-0">
              <label class="rec-filter-label">Фактура</label>
              <select id="bomrc-f-texture" class="input-modern rec-filter-select" onchange="bomCompareRebuildProductSelection();">
                ${['Все','Гладкая','Гранит','Меланж гладкий','Меланж гранит'].map(v=>`<option value="${v}">${Utils.escapeHtml(v)}</option>`).join('')}
              </select>
            </div>
            <div class="form-group m-0">
              <label class="rec-filter-label">Цвет</label>
              <select id="bomrc-f-color" class="input-modern rec-filter-select" onchange="bomCompareRebuildProductSelection();">
                ${['Все','Серый','Красный','Черный','Желтый','Коричневый','Белый','Оранжевый','Меланж Оникс','Меланж Осень','Меланж Янтарь','Меланж Яшма','Меланж Рубин'].map(v=>`<option value="${v}">${Utils.escapeHtml(v)}</option>`).join('')}
              </select>
            </div>
            <div class="form-group m-0 rec-grid-full">
              <label class="rec-filter-label">Поиск по названию / ID</label>
              <input type="text" id="bomrc-f-search" class="input-modern" placeholder="Например: 2П6, квадрат, ID товара" oninput="bomCompareRebuildProductSelection();"/>
            </div>
          </div>
          <div class="flex-row gap-10 flex-wrap align-center mt-10">
            <button type="button" class="btn btn-outline font-13" onclick="bomCompareRebuildProductSelection()">Обновить список товаров по фильтру</button>
            <button type="button" class="btn btn-blue font-13" onclick="bomCompareFetchBtn()">Загрузить рецепты с сервера</button>
            <label class="rec-inline-label m-0 font-13"><span>Синхронизация:</span>
              <select id="bomrc-sync-mode" class="input-modern rec-filter-select">
                <option value="upsert" selected>Добавить/обновить (upsert)</option>
                <option value="replace_all">Затереть и заменить</option>
              </select>
            </label>
          </div>
          <div class="flex-row gap-15 flex-wrap align-center mt-10 font-13">
            <span class="text-muted font-600">Копировать при A→B / эталон:</span>
            <label class="rec-inline-label m-0 cursor-pointer"><input type="checkbox" id="bomrc-layer-face" checked> Лицевой</label>
            <label class="rec-inline-label m-0 cursor-pointer"><input type="checkbox" id="bomrc-layer-main" checked> Основной</label>
            <label class="rec-inline-label m-0 cursor-pointer"><input type="checkbox" id="bomrc-layer-packaging" checked> Упаковка</label>
          </div>
          <p id="bomrc-status-text" class="rec-help-text m-0 mt-10"></p>
          <p class="text-muted m-0 mt-8 font-11"><strong>Все три галочки</strong> — как раньше весь рецепт. Если снять блоки, в цель переносятся <strong>только отмеченные слои</strong> (остальной рецепт товара сохраняется). Режим upsert / замена — как в списке выше; при копировании по слоям на сервере пересчитываются только выбранные блоки.</p>
        </div>`;

    const tabs = `
        <div class="rec-compare-tabs flex-wrap gap-10">
          <button type="button" class="btn btn-blue shadow-primary bom-rc-tab-btn" data-tab="pair" onclick="switchBomCompareTab('pair')">Пара</button>
          <button type="button" class="btn btn-outline text-primary bom-rc-tab-btn" data-tab="baseline" onclick="switchBomCompareTab('baseline')">От эталона</button>
          <button type="button" class="btn btn-outline text-primary bom-rc-tab-btn" data-tab="matrix" onclick="switchBomCompareTab('matrix')">Матрица</button>
          <button type="button" class="btn btn-outline text-primary bom-rc-tab-btn" data-tab="clones" onclick="switchBomCompareTab('clones')">Одинаковые</button>
          <button type="button" class="btn btn-outline font-13 rec-ml-auto" onclick="bomCompareExportSnapshot()">📋 Сводка</button>
        </div>`;

    const panels = `
        <div class="bom-rc-panel" data-panel="pair">
          <p class="rec-help-text m-0 mb-10 font-12">Строки в таблице ниже упорядочены по блокам: лицевой слой → основной → упаковка.</p>
          <div class="rec-mini-grid">
            <div class="form-group m-0"><label class="rec-filter-label">Товар A</label><select id="bomrc-a" class="input-modern" onchange="refreshBomComparePair()"><option value="">—</option></select></div>
            <div class="form-group m-0"><label class="rec-filter-label">Товар B</label><select id="bomrc-b" class="input-modern" onchange="refreshBomComparePair()"><option value="">—</option></select></div>
          </div>
          <div class="flex-row gap-10 flex-wrap mt-10">
             <button type="button" class="btn btn-outline" onclick="refreshBomComparePair()">Обновить</button>
             <button type="button" class="btn btn-blue" onclick="bomCompareApplyPair('AtoB')">A → B</button>
             <button type="button" class="btn btn-outline" onclick="bomCompareApplyPair('BtoA')">B → A</button>
          </div>
          <div id="bomrc-pair-summary" class="rec-compare-summary"></div>
          <div id="bomrc-pair-tables"></div>
          <div id="bomrc-mini-editor-wrap" class="rec-panel-compact mt-15 d-none">
            <p class="rec-compare-subtitle m-0 mb-8">Точное редактирование (сохранение в БД)</p>
            <div class="flex-row gap-15 flex-wrap align-center mb-10 font-13">
              <label class="rec-inline-label m-0 cursor-pointer"><input type="radio" name="bomrc-edit-which" value="" checked onclick="bomCompareMiniEditorReload()"/> Нет</label>
              <label class="rec-inline-label m-0 cursor-pointer"><input type="radio" name="bomrc-edit-which" value="a" onclick="bomCompareMiniEditorReload()"/> Товар A</label>
              <label class="rec-inline-label m-0 cursor-pointer"><input type="radio" name="bomrc-edit-which" value="b" onclick="bomCompareMiniEditorReload()"/> Товар B</label>
            </div>
            <div id="bomrc-mini-editor-inner"></div>
          </div>
        </div>
        <div class="bom-rc-panel d-none" data-panel="baseline">
          <p class="rec-help-text m-0 mb-10 font-12">Эталон — «эталонный» артикул линейки (напр. нужная серия 2П6). Остальные строки фильтра сравниваются с&nbsp;ним; галочки стоят там, где рецепт отличается.</p>
          <div class="form-group m-0 max-w-510"><label class="rec-filter-label">Эталон</label><select id="bomrc-baseline-ref" class="input-modern w-100" onchange="refreshBomCompareBaseline()"><option value="">—</option></select></div>
          <div id="bomrc-baseline-body"></div>
          <div class="flex-row gap-10 mt-10"><button type="button" class="btn btn-blue" onclick="bomCompareApplyBaseline()">Применить к отмеченным</button><button type="button" class="btn btn-outline" onclick="refreshBomCompareBaseline()">Обновить</button></div>
        </div>
        <div class="bom-rc-panel d-none" data-panel="matrix">
          <p class="rec-help-text m-0 mb-10 font-12">Клетка ≠ — рецепты различаются; наведите на символ для подсказки, в&nbsp;каких блоках (лицевой / основной / упаковка) есть расхождения.</p>
          <p id="bomrc-matrix-note" class="rec-mtx-legend"></p><div id="bomrc-matrix-body"></div><button type="button" class="btn btn-outline mt-10" onclick="refreshBomCompareMatrix()">Пересчитать матрицу</button></div>
        <div class="bom-rc-panel d-none" data-panel="clones"><p class="rec-help-text m-0 mb-10 font-12">Группы SKU с полностью совпадающим составом внутри текущего фильтра.</p><div id="bomrc-clones-body"></div><button type="button" class="btn btn-outline mt-10" onclick="refreshBomCompareClones()">Обновить</button></div>`;

    UI.showModal(
        '📋 Сравнение рецептов продукции',
        `<div class="rec-compare-workbench rec-modal-content">${filtHtml}${tabs}${panels}</div>`,
        '<button type="button" class="btn btn-outline" onclick="bomCompareExportSnapshot()">📋 Сводка</button><button type="button" class="btn btn-outline" onclick="UI.closeModal()">Закрыть</button>'
    );

    setTimeout(() => {
        const prodSelect = document.getElementById('recipe-product-select');
        const tsP = prodSelect && prodSelect.tomselect;
        const curId = tsP ? tsP.getValue() : prodSelect.value;
        const feats = parseProductFeatures(
            tsP && curId && tsP.options[curId]
                ? tsP.options[curId].text : ''
        );
        const fType = document.getElementById('bomrc-f-type');
        if (fType && feats.type !== 'Все') fType.value = feats.type;
        const fThickness = document.getElementById('bomrc-f-thickness');
        if (fThickness && feats.thickness !== 'Все') fThickness.value = feats.thickness;
        const ft = document.getElementById('bomrc-f-texture');
        if (ft && feats.texture !== 'Все') ft.value = feats.texture;
        const fc = document.getElementById('bomrc-f-color');
        if (fc && feats.color !== 'Все') fc.value = feats.color;
        bomCompareToggleThicknessDisabled();
        bomCompareRebuildProductSelection();
        if (curId) {
            const a = document.getElementById('bomrc-a');
            const br = document.getElementById('bomrc-b');
            const ref = document.getElementById('bomrc-baseline-ref');
            if (a && [...a.options].some((o)=>o.value === String(curId))) a.value = String(curId);
            if (ref && [...ref.options].some((o)=>o.value === String(curId))) ref.value = String(curId);
            if (br && br.options.length > 2) {
                const alt = [...br.options].find((o) => o.value && o.value !== String(curId));
                if (alt) br.value = alt.value;
            }
        }
        if (window.currentRecipeMode === 'BOM' && curId && typeof currentRecipeData !== 'undefined' && currentRecipeData.length) {
            bomRecipeCompareCache[String(curId)] = bomCanonicalizeFetchedRows(JSON.parse(JSON.stringify(currentRecipeData)));
            bomCompareRefreshStatusLine();
        }
        refreshBomComparePair();
    }, 80);
};

window.showRecipeMassApplyModal = function() {
    const prodSelect = document.getElementById('recipe-product-select');
    const productId = parseInt(prodSelect.value);
    // Безопасное получение имени через TomSelect
    const tsP = prodSelect.tomselect;
    const productName = tsP
        ? (tsP.options[tsP.getValue()] ? tsP.options[tsP.getValue()].text : '')
        : (prodSelect.options[prodSelect.selectedIndex] ? prodSelect.options[prodSelect.selectedIndex].text : '');

    if (!productId) {
        UI.toast('Сначала выберите товар (эталон) для применения!', 'warning');
        return;
    }

    if (!currentRecipeData || currentRecipeData.length === 0) {
        UI.toast('Рецепт пуст! Текущий состав пуст.', 'warning');
        return;
    }

    const feats = parseProductFeatures(productName);

    const sourceByLayer = {
        face: currentRecipeData.filter((i) => normalizeRecipeLayer(i.layer) === 'face'),
        main: currentRecipeData.filter((i) => normalizeRecipeLayer(i.layer) === 'main'),
        packaging: currentRecipeData.filter((i) => normalizeRecipeLayer(i.layer) === 'packaging')
    };
    const ingredientsBlock = Object.keys(sourceByLayer).map((layerKey) => {
        const rows = sourceByLayer[layerKey];
        const layerText = layerLabel(layerKey);
        const groupId = `layer-${layerKey}`;
        return `
            <div class="rec-layer-box">
                <label class="rec-inline-label rec-inline-label-strong mb-8">
                    <input type="checkbox" class="mass-layer-cb" data-layer="${layerKey}" checked onchange="toggleMassLayer('${layerKey}', this.checked)">
                    ${layerText} (${rows.length})
                </label>
                <div class="rec-col-6">
                    ${rows.map((ing, idx) => `
                        <label class="rec-inline-label font-13">
                            <input type="checkbox" class="mass-item-cb mass-item-${groupId}" data-material-id="${ing.materialId}" data-layer="${layerKey}" checked>
                            ${ing.name} (${ing.qty} ${ing.unit})
                        </label>
                    `).join('') || '<span class="text-muted font-12">Нет позиций</span>'}
                </div>
            </div>
        `;
    }).join('');

    const htmlBody = `
        <div class="rec-panel mb-20">
            <p class="rec-panel-title">Источник: <span class="text-primary">${productName}</span></p>
            <p class="rec-help-text mb-15">Выберите фильтры, чтобы найти похожие товары для массового применения текущего рецепта.</p>
            
            <div class="rec-mini-grid">
                <div class="form-group m-0">
                    <label class="rec-filter-label">Вид продукции</label>
                    <select id="modal-filter-type" class="input-modern rec-filter-select" onchange="updateMassApplyList(${productId})">
                        <option value="Все" ${feats.type==='Все'?'selected':''}>Все</option>
                        <option value="Плитка" ${feats.type==='Плитка'?'selected':''}>Плитка</option>
                        <option value="Бордюр" ${feats.type==='Бордюр'?'selected':''}>Бордюр</option>
                        <option value="Поребрик" ${feats.type==='Поребрик'?'selected':''}>Поребрик</option>
                        <option value="Блок" ${feats.type==='Блок'?'selected':''}>Блок</option>
                    </select>
                </div>
                <div class="form-group m-0">
                    <label class="rec-filter-label">Толщина</label>
                    <select id="modal-filter-thickness" class="input-modern rec-filter-select" onchange="updateMassApplyList(${productId})">
                        <option value="Все" ${feats.thickness==='Все'?'selected':''}>Все</option>
                        <option value="40мм" ${feats.thickness==='40мм'?'selected':''}>40мм</option>
                        <option value="60мм" ${feats.thickness==='60мм'?'selected':''}>60мм</option>
                        <option value="80мм" ${feats.thickness==='80мм'?'selected':''}>80мм</option>
                    </select>
                </div>
                <div class="form-group m-0">
                    <label class="rec-filter-label">Фактура</label>
                    <select id="modal-filter-texture" class="input-modern rec-filter-select" onchange="updateMassApplyList(${productId})">
                        <option value="Все" ${feats.texture==='Все'?'selected':''}>Все</option>
                        <option value="Гладкая" ${feats.texture==='Гладкая'?'selected':''}>Гладкая</option>
                        <option value="Гранит" ${feats.texture==='Гранит'?'selected':''}>Гранит</option>
                        <option value="Меланж гладкий" ${feats.texture==='Меланж гладкий'?'selected':''}>Меланж гладкий</option>
                        <option value="Меланж гранит" ${feats.texture==='Меланж гранит'?'selected':''}>Меланж гранит</option>
                    </select>
                </div>
                <div class="form-group m-0">
                    <label class="rec-filter-label">Цвет</label>
                    <select id="modal-filter-color" class="input-modern rec-filter-select" onchange="updateMassApplyList(${productId})">
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
        <div class="rec-panel rec-panel-compact mb-15">
            <div class="form-group m-0">
                <label class="font-700">Режим копирования</label>
                <select id="mass-apply-mode" class="input-modern">
                    <option value="upsert" selected>Добавить/обновить выбранные позиции (без удаления остальных)</option>
                    <option value="replace_all">Затереть весь рецепт и заменить выбранными позициями</option>
                </select>
            </div>
        </div>
        <div class="rec-grid-1 mb-15">
            ${ingredientsBlock}
        </div>

        <div class="rec-row-between mb-10">
            <strong class="text-main font-15">Целевые товары:</strong>
            <label class="rec-inline-label font-13">
                <input type="checkbox" id="mass-apply-select-all" checked onchange="document.querySelectorAll('.mass-apply-cb').forEach(cb => cb.checked = this.checked)">
                Выбрать все
            </label>
        </div>
        <div id="mass-apply-list" class="rec-dropdown-list">
            <!-- Сюда вставятся товары -->
        </div>
        <p class="rec-help-text mt-10">* Внимание: Текущий состав сырья будет скопирован (добавлен/обновлен - UPSERT) в выбранные рецептуры.</p>
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
        listEl.innerHTML = '<div class="text-muted p-10 text-center">Товары, соответствующие фильтрам, не найдены.</div>';
    } else {
        listEl.innerHTML = matched.map(p => `
            <label class="sync-list-item font-13 cursor-pointer p-5 border-bottom">
                <input type="checkbox" class="mass-apply-cb" value="${p.id}" data-name="${(p.name || '').replace(/"/g, '&quot;')}" checked>
                ${p.name}
            </label>
        `).join('');
    }
    
    const selectAllCheck = document.getElementById('mass-apply-select-all');
    if (selectAllCheck) selectAllCheck.checked = matched.length > 0;
};

window.toggleMassLayer = function(layerKey, checked) {
    document.querySelectorAll(`.mass-item-layer-${layerKey}, .mass-item-cb[data-layer="${layerKey}"]`).forEach((el) => {
        el.checked = checked;
    });
};

window.executeMassApply = async function() {
    const checkedBoxes = document.querySelectorAll('.mass-apply-cb:checked');
    if (checkedBoxes.length === 0) {
        UI.toast('Выберите хотя бы один товар!', 'error');
        return;
    }

    const targets = Array.from(checkedBoxes).map(cb => ({
        id: parseInt(cb.value),
        name: cb.getAttribute('data-name') || ('ID ' + cb.value)
    }));
    const mode = document.getElementById('mass-apply-mode')?.value || 'upsert';
    const selectedMaterialsMap = new Map();
    document.querySelectorAll('.mass-item-cb:checked').forEach((cb) => {
        const materialId = Number(cb.getAttribute('data-material-id'));
        const layer = normalizeRecipeLayer(cb.getAttribute('data-layer'));
        const src = currentRecipeData.find((ing) => Number(ing.materialId) === materialId && normalizeRecipeLayer(ing.layer) === layer);
        if (src) {
            const key = `${materialId}:${layer}`;
            if (!selectedMaterialsMap.has(key)) {
                selectedMaterialsMap.set(key, {
                    materialId,
                    qty: parseFloat(src.qty),
                    layer
                });
            }
        }
    });
    const selectedMaterials = Array.from(selectedMaterialsMap.values());
    if (selectedMaterials.length === 0) {
        UI.toast('Выберите хотя бы одну позицию состава для копирования', 'warning');
        return;
    }
    const total = targets.length;

    // Показываем модалку с прогрессом
    UI.closeModal();
    const progressHtml = `
        <div class="p-15">
            <div class="mb-15 font-15 text-center" id="mass-progress-text">🚀 Инициализация... (0/${total})</div>
            <div class="rec-progress-track">
                <div id="mass-progress-bar" class="rec-progress-bar"></div>
            </div>
            <div id="mass-progress-log" class="rec-progress-log"></div>
        </div>
    `;
    UI.showModal('📋 Массовое копирование рецепта', progressHtml, '');

    const progressText = document.getElementById('mass-progress-text');
    const progressBar = document.getElementById('mass-progress-bar');
    const progressLog = document.getElementById('mass-progress-log');

    let successCount = 0;
    let errorCount = 0;
    const CHUNK_SIZE = 25;
    const payloadMaterials = selectedMaterials.map(ing => ({
        materialId: String(ing.materialId),
        qty: parseFloat(ing.qty),
        layer: normalizeRecipeLayer(ing.layer),
        order: Number.isFinite(Number(ing.order)) ? Number(ing.order) : 0
    }));
    const chunks = [];
    for (let i = 0; i < targets.length; i += CHUNK_SIZE) {
        chunks.push(targets.slice(i, i + CHUNK_SIZE));
    }

    for (let ci = 0; ci < chunks.length; ci++) {
        const chunk = chunks[ci];
        const processed = Math.min((ci + 1) * CHUNK_SIZE, total);
        const pct = Math.round((processed / total) * 100);
        if (progressText) progressText.innerText = `⏳ Обработка пакета ${ci + 1}/${chunks.length}... (${processed}/${total})`;
        if (progressBar) progressBar.style.width = pct + '%';

        try {
            await API.post('/api/recipes/sync-category', {
                targetProductIds: chunk.map(t => t.id),
                mode,
                materials: payloadMaterials
            });
            successCount += chunk.length;
            if (progressLog) {
                chunk.forEach((target) => {
                    progressLog.innerHTML += `<div class="text-success">✅ ${Utils.escapeHtml(target.name)}</div>`;
                });
            }
        } catch (e) {
            // Фолбэк: если пакет упал, пробуем поштучно с паузой
            for (let i = 0; i < chunk.length; i++) {
                const target = chunk[i];
                try {
                    await API.post('/api/recipes/sync-category', {
                        targetProductIds: [target.id],
                        mode,
                        materials: payloadMaterials
                    });
                    successCount++;
                    if (progressLog) progressLog.innerHTML += `<div class="text-success">✅ ${Utils.escapeHtml(target.name)}</div>`;
                } catch (itemErr) {
                    errorCount++;
                    const errMsg = (itemErr.body && itemErr.body.warning)
                        ? itemErr.body.warning
                        : (itemErr.body && itemErr.body.error)
                            ? itemErr.body.error
                            : (itemErr.message || 'Ошибка');
                    if (progressLog) progressLog.innerHTML += `<div class="text-danger">❌ ${Utils.escapeHtml(target.name)}: ${Utils.escapeHtml(errMsg)}</div>`;
                    // При фладе даем небольшую паузу и продолжаем
                    if (/слишком много запросов|too many requests/i.test(String(errMsg))) {
                        await new Promise((r) => setTimeout(r, 350));
                    }
                }
            }
        }
    }

    // Финальный результат
    if (progressBar) progressBar.style.width = '100%';
    if (progressText) {
        if (errorCount === 0) {
            progressText.innerHTML = `<span class="text-success font-bold">✅ Завершено! Успешно: ${successCount} из ${total}</span>`;
            if (progressBar) { progressBar.classList.remove('bg-danger', 'bg-warning'); progressBar.classList.add('bg-success'); }
        } else {
            progressText.innerHTML = `<span class="text-warning font-bold">⚠️ Завершено! Успешно: ${successCount}, Ошибок: ${errorCount}</span>`;
            if (progressBar) { progressBar.classList.remove('bg-success'); progressBar.classList.add(errorCount === total ? 'bg-danger' : 'bg-warning'); }
        }
    }

    // Меняем footer на кнопку Закрыть
    const footer = document.getElementById('app-modal-footer');
    if (footer) footer.innerHTML = `<button class="btn btn-blue" onclick="UI.closeModal()">Закрыть</button>`;

    UI.toast(`📋 Массовое копирование завершено (${successCount}/${total})`, successCount === total ? 'success' : 'warning');
}

// Индикатор несохранённых изменений (BOM-режим)
function updateRecipeDirtyState() {
    if (window.currentRecipeMode !== 'BOM') return;
    const badge = document.getElementById('recipe-editor-badge');
    if (!badge) return;
    const dirty = (typeof isRecipeChanged === 'function') ? isRecipeChanged() : false;
    if (dirty) {
        badge.textContent = '● Не сохранено';
        badge.className = 'badge p-6-12 font-13 font-bold radius-6 rec-badge-dirty';
    } else {
        badge.textContent = '';
        badge.className = 'badge d-none p-6-12 font-13 font-bold radius-6';
    }
}

    // === ГЛОБАЛЬНЫЙ ЭКСПОРТ ===
    if (typeof loadRecipeModuleData === 'function') window.loadRecipeModuleData = loadRecipeModuleData;
    if (typeof initStaticRecipeSelects === 'function') window.initStaticRecipeSelects = initStaticRecipeSelects;
    if (typeof loadRecipeDetails === 'function') window.loadRecipeDetails = loadRecipeDetails;
    if (typeof removeIngredientFromRecipe === 'function') window.removeIngredientFromRecipe = removeIngredientFromRecipe;
    if (typeof updateIngredientQty === 'function') window.updateIngredientQty = updateIngredientQty;
    if (typeof updateIngredientLayer === 'function') window.updateIngredientLayer = updateIngredientLayer;
    if (typeof onRecipeDragStart === 'function') window.onRecipeDragStart = onRecipeDragStart;
    if (typeof onRecipeDragOver === 'function') window.onRecipeDragOver = onRecipeDragOver;
    if (typeof onRecipeDragLeave === 'function') window.onRecipeDragLeave = onRecipeDragLeave;
    if (typeof onRecipeDrop === 'function') window.onRecipeDrop = onRecipeDrop;
    if (typeof onRecipeDragEnd === 'function') window.onRecipeDragEnd = onRecipeDragEnd;
    if (typeof renderRecipeTable === 'function') window.renderRecipeTable = renderRecipeTable;
    if (typeof isRecipeChanged === 'function') window.isRecipeChanged = isRecipeChanged;
    if (typeof parseProductFeatures === 'function') window.parseProductFeatures = parseProductFeatures;
    if (typeof updateRecipeLayerPlaceholderState === 'function') window.updateRecipeLayerPlaceholderState = updateRecipeLayerPlaceholderState;
    if (typeof toggleRecipeAddPanel === 'function') window.toggleRecipeAddPanel = toggleRecipeAddPanel;
    if (typeof auditComputePigmentIds === 'function') window.auditComputePigmentIds = auditComputePigmentIds;
    if (typeof isPigment === 'function') window.isPigment = isPigment;
    if (typeof auditComparePair === 'function') window.auditComparePair = auditComparePair;
    if (typeof auditBuildMergedIngredients === 'function') window.auditBuildMergedIngredients = auditBuildMergedIngredients;
    if (typeof auditBuildGroups === 'function') window.auditBuildGroups = auditBuildGroups;
    if (typeof auditOpen === 'function') window.auditOpen = auditOpen;
    if (typeof auditRenderGroupsList === 'function') window.auditRenderGroupsList = auditRenderGroupsList;
    if (typeof auditComputeGroupSummary === 'function') window.auditComputeGroupSummary = auditComputeGroupSummary;
    if (typeof auditOpenGroupDetail === 'function') window.auditOpenGroupDetail = auditOpenGroupDetail;
    if (typeof auditOpenGroupDetailFromBtn === 'function') window.auditOpenGroupDetailFromBtn = auditOpenGroupDetailFromBtn;
    if (typeof auditBackToGroupList === 'function') window.auditBackToGroupList = auditBackToGroupList;
    if (typeof auditFocusProduct === 'function') window.auditFocusProduct = auditFocusProduct;
    if (typeof auditSetGroupReference === 'function') window.auditSetGroupReference = auditSetGroupReference;
    if (typeof auditRenderGroupSummary === 'function') window.auditRenderGroupSummary = auditRenderGroupSummary;
    if (typeof auditRenderProductDiff === 'function') window.auditRenderProductDiff = auditRenderProductDiff;
    if (typeof auditShowSyncModal === 'function') window.auditShowSyncModal = auditShowSyncModal;
    if (typeof auditExecuteSync === 'function') window.auditExecuteSync = auditExecuteSync;
    if (typeof auditCloseSyncOverlay === 'function') window.auditCloseSyncOverlay = auditCloseSyncOverlay;
    if (typeof auditApplyLeftMatrixFilter === 'function') window.auditApplyLeftMatrixFilter = auditApplyLeftMatrixFilter;
    if (typeof auditApplyLeftCategoryFilter === 'function') window.auditApplyLeftCategoryFilter = auditApplyLeftCategoryFilter;
    if (typeof auditApplyLeftPanelFilters === 'function') window.auditApplyLeftPanelFilters = auditApplyLeftPanelFilters;
})();
