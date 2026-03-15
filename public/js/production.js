// === public/js/production.js ===

window.currentMixTemplates = {};
let allProductsList = [];
let sessionProducts = [];
let allMaterialsForMix = [];
let currentSelectedProductRecipe = [];

async function initProduction() {
    document.getElementById('prod-date-filter').valueAsDate = new Date();
    try {
        // 1. ЗАГРУЖАЕМ СЫРЬЕ
        const resMat = await fetch('/api/items?item_type=material&limit=500');
        const matData = await resMat.json();
        allMaterialsForMix = matData.data || [];

        // 2. ЗАГРУЖАЕМ ШАБЛОНЫ ИЗ БАЗЫ И ДОБАВЛЯЕМ НОВЫЕ (МЕЛАНЖ)
        const resMix = await fetch('/api/mix-templates');
        const dbTemplates = await resMix.json();

        const findMat = (kw) => allMaterialsForMix.find(m => m.name.toLowerCase().includes(kw)) || { id: '', name: 'Материал', unit: 'кг' };
        const defMain = [{ ...findMat('цемент'), qty: 250 }, { ...findMat('песок'), qty: 600 }, { ...findMat('щебень'), qty: 800 }];
        const defFace = [{ ...findMat('белый цемент'), qty: 50 }, { ...findMat('песок'), qty: 200 }, { ...findMat('щебень'), qty: 300 }];

        window.currentMixTemplates = dbTemplates || {};
        let needsUpdate = false;

        // Если шаблонов нет, или нет новых шаблонов Меланжа - создаем их
        const requiredKeys = ['main_40', 'main_60', 'main_80', 'main_por', 'main_bor', 'face_gs', 'face_gc', 'face_grs', 'face_grc', 'face_mel_g', 'face_mel_gr'];
        requiredKeys.forEach(key => {
            if (!window.currentMixTemplates[key]) {
                window.currentMixTemplates[key] = JSON.parse(JSON.stringify(key.startsWith('main') ? defMain : defFace));
                needsUpdate = true;
            }
        });

        if (needsUpdate) {
            await fetch('/api/mix-templates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(window.currentMixTemplates) });
        }

        // 3. ЗАГРУЖАЕМ ПРОДУКЦИЮ
        const resProd = await fetch('/api/products');
        allProductsList = await resProd.json();
        populateCategories();

        // 4. ЗАГРУЖАЕМ БРИГАДИРОВ (СОРТИРОВКА: ЦЕХ НАВЕРХУ)
        const resEmp = await fetch('/api/employees');
        const empData = await resEmp.json();
        const shiftSel = document.getElementById('prod-shift-name');
        if (shiftSel) {
            shiftSel.innerHTML = '<option value="">-- Выберите бригадира --</option>';
            let activeEmps = empData.filter(e => e.status === 'active');

            // Сортируем: если в должности или отделе есть слово "цех", "рабочий" или "формов", они идут первыми
            activeEmps.sort((a, b) => {
                const isWorkshop = (emp) => (emp.department && emp.department.toLowerCase().includes('цех')) || (emp.position && (emp.position.toLowerCase().includes('цех') || emp.position.toLowerCase().includes('формов')));
                return (isWorkshop(b) ? 1 : 0) - (isWorkshop(a) ? 1 : 0);
            });

            activeEmps.forEach(emp => shiftSel.add(new Option(emp.full_name, emp.full_name)));
        }

        renderSelectedTemplates();
        loadDailyHistory();
    } catch (e) { console.error(e); }
}

function populateCategories() {
    const sel = document.getElementById('prod-product-select');
    if (!sel) return;
    sel.innerHTML = '<option value="" disabled selected>-- Выберите продукцию --</option>';
    allProductsList.forEach(p => sel.add(new Option(p.name, p.id)));
}

// === АВТО-ВЫБОР ШАБЛОНА ПРИ СМЕНЕ ПРОДУКТА ===
window.handleProductSelection = async function () {
    const sel = document.getElementById('prod-product-select');
    const productId = sel.value;
    if (!productId) return;

    const productName = sel.options[sel.selectedIndex].text.toLowerCase();

    // 1. Угадываем Основной шаблон
    let mainKey = 'main_60';
    if (productName.includes('40')) mainKey = 'main_40';
    else if (productName.includes('80')) mainKey = 'main_80';
    else if (productName.includes('поребрик')) mainKey = 'main_por';
    else if (productName.includes('бордюр')) mainKey = 'main_bor';

    // 2. Угадываем Лицевой шаблон (ДОБАВЛЕНА ЛОГИКА ДЛЯ МЕЛАНЖА)
    let faceKey = 'face_gs';
    if (productName.includes('меланж')) {
        faceKey = productName.includes('гранит') ? 'face_mel_gr' : 'face_mel_g';
    } else if (productName.includes('гранит')) {
        faceKey = productName.includes('сер') ? 'face_grs' : 'face_grc';
    } else if (productName.includes('цвет') || productName.includes('красн') || productName.includes('желт') || productName.includes('корич')) {
        faceKey = 'face_gc';
    }

    document.getElementById('main-template-select').value = mainKey;
    document.getElementById('face-template-select').value = faceKey;
    renderSelectedTemplates();

    // 3. Загружаем Рецепт для расчета подсказки по замесам
    try {
        const res = await fetch(`/api/recipes/${productId}`);
        currentSelectedProductRecipe = await res.json();
    } catch (e) { console.error(e); }

    calculateMixesPreview();
};

// === ОТРИСОВКА ВЫБРАННЫХ ШАБЛОНОВ (ТЕПЕРЬ ОНИ РЕДАКТИРУЕМЫЕ) ===
window.renderSelectedTemplates = function () {
    const mainKey = document.getElementById('main-template-select').value;
    const faceKey = document.getElementById('face-template-select').value;

    const drawEditableList = (templateList, containerId, prefix) => {
        let html = '<div style="font-size: 11px; margin-bottom: 5px; opacity: 0.8;">На 1 замес (можно изменить сейчас):</div>';

        html += (templateList || []).map(m => `
            <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(0,0,0,0.05); padding: 4px 0;">
                <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;">${m.name}</span>
                <div style="display: flex; align-items: center; gap: 5px;">
                    <input type="number" class="input-modern ${prefix}-qty" data-id="${m.id}" data-name="${m.name}" data-unit="${m.unit}" value="${m.qty}" style="width: 75px; padding: 2px 5px; text-align: right; margin: 0; font-weight: bold; font-size: 13px; border: 1px solid rgba(0,0,0,0.1);" onfocus="this.select()" title="Изменить для этого конкретного замеса">
                    <span style="font-size: 11px; width: 15px; text-align: left;">${m.unit}</span>
                </div>
            </div>
        `).join('');
        document.getElementById(containerId).innerHTML = html || '<i>Шаблон пуст</i>';
    };

    drawEditableList(window.currentMixTemplates[mainKey], 'main-mix-norms', 'main-mix-mat');
    drawEditableList(window.currentMixTemplates[faceKey], 'face-mix-norms', 'face-mix-mat');
    calculateMixesPreview();
};

// === РАСЧЕТ ИДЕАЛЬНЫХ ЗАМЕСОВ ПО РЕЦЕПТУ ===
window.calculateMixesPreview = function () {
    const sel = document.getElementById('prod-product-select');
    const input = document.getElementById('prod-cycles-input');
    const cycles = parseFloat(input.value) || 0;
    const productId = sel.value;

    if (!productId) return;

    const product = allProductsList.find(p => p.id == productId);
    const ratio = product ? (parseFloat(product.qty_per_cycle) || 1) : 1;
    const volume = cycles * ratio;

    document.getElementById('prod-volume-preview').innerText = volume.toFixed(2);

    // Считаем расчетное количество замесов на основе веса рецепта
    if (currentSelectedProductRecipe.length > 0 && cycles > 0) {
        let totalRecipeWeight = currentSelectedProductRecipe.reduce((sum, r) => sum + (parseFloat(r.quantity_per_unit) * volume), 0);

        const mainKey = document.getElementById('main-template-select').value;
        const faceKey = document.getElementById('face-template-select').value;

        const mainTplWeight = (window.currentMixTemplates[mainKey] || []).reduce((sum, m) => sum + parseFloat(m.qty), 0) || 1;
        const faceTplWeight = (window.currentMixTemplates[faceKey] || []).reduce((sum, m) => sum + parseFloat(m.qty), 0) || 1;

        // Эмпирическая пропорция веса слоев
        let faceRatio = 0.20;
        if (product.name.toLowerCase().includes('40')) faceRatio = 0.25;
        if (product.name.toLowerCase().includes('80')) faceRatio = 0.15;
        if (product.name.toLowerCase().includes('поребрик') || product.name.toLowerCase().includes('бордюр')) faceRatio = 0.10;

        const mainRatio = 1 - faceRatio;

        const suggestedMain = ((totalRecipeWeight * mainRatio) / mainTplWeight).toFixed(1);
        const suggestedFace = ((totalRecipeWeight * faceRatio) / faceTplWeight).toFixed(1);

        // Подставляем подсказку, но бригадир может исправить
        document.getElementById('main-mix-count').value = suggestedMain;
        document.getElementById('face-mix-count').value = suggestedFace;
    } else {
        document.getElementById('main-mix-count').value = '';
        document.getElementById('face-mix-count').value = '';
    }
};

// === ДОБАВЛЕНИЕ В ПАРТИЮ (СПИСАНИЕ СТРОГО ПО ПОЛЯМ ВВОДА С ЭКРАНА) ===
window.addProdToSession = function () {
    const sel = document.getElementById('prod-product-select');
    const cycles = parseFloat(document.getElementById('prod-cycles-input').value);
    const mainCount = parseFloat(document.getElementById('main-mix-count').value) || 0;
    const faceCount = parseFloat(document.getElementById('face-mix-count').value) || 0;

    if (!sel.value || isNaN(cycles) || cycles <= 0) return UI.toast('Выберите товар и введите удары!', 'error');

    const product = allProductsList.find(p => p.id == sel.value);
    const volume = cycles * (parseFloat(product.qty_per_cycle) || 1);

    // 🚀 СЧИТАЕМ РЕАЛЬНЫЙ РАСХОД: Читаем цифры прямо из полей ввода на экране
    let actualMaterials = [];

    // Читаем Основной замес
    document.querySelectorAll('.main-mix-mat-qty').forEach(input => {
        const qtyPerMix = parseFloat(input.value) || 0;
        const matId = input.getAttribute('data-id'); // <-- Получаем ID

        // 🛡️ Проверяем, что ID существует и не пустой
        if (qtyPerMix > 0 && mainCount > 0 && matId && matId !== '') {
            actualMaterials.push({
                id: matId,
                name: input.getAttribute('data-name'),
                qty: qtyPerMix * mainCount,
                unit: input.getAttribute('data-unit')
            });
        }
    });

    // Читаем Лицевой замес и плюсуем к основному
    document.querySelectorAll('.face-mix-mat-qty').forEach(input => {
        const qtyPerMix = parseFloat(input.value) || 0;
        const matId = input.getAttribute('data-id'); // <-- Получаем ID

        // 🛡️ Проверяем, что ID существует и не пустой
        if (qtyPerMix > 0 && faceCount > 0 && matId && matId !== '') {
            const existing = actualMaterials.find(ex => ex.id == matId);
            if (existing) {
                existing.qty += qtyPerMix * faceCount;
            } else {
                actualMaterials.push({
                    id: matId,
                    name: input.getAttribute('data-name'),
                    qty: qtyPerMix * faceCount,
                    unit: input.getAttribute('data-unit')
                });
            }
        }
    });

    sessionProducts.push({
        id: product.id,
        name: product.name,
        mold_id: product.mold_id || null,
        cycles: cycles,
        quantity: volume,
        unit: product.unit,
        exactMaterials: actualMaterials, // Сохранили ФАКТИЧЕСКИЙ расход с учетом правок бригадира
        mainCount: mainCount,
        faceCount: faceCount
    });

    renderSessionProducts();
    document.getElementById('prod-cycles-input').value = '';
    document.getElementById('main-mix-count').value = '';
    document.getElementById('face-mix-count').value = '';
    document.getElementById('prod-volume-preview').innerText = '0.00';

    // Сбрасываем поля замесов обратно к идеальному шаблону для следующей партии
    renderSelectedTemplates();
};

function renderSessionProducts() {
    const container = document.getElementById('session-products-list');
    if (sessionProducts.length === 0) {
        container.innerHTML = `<div style="color: gray; font-size: 13px; text-align: center; padding: 15px; border: 1px dashed #cbd5e1; border-radius: 6px;">Смена пуста. Выберите продукцию выше.</div>`;
        return;
    }

    container.innerHTML = sessionProducts.map((p, i) => `
        <div style="display: flex; justify-content: space-between; align-items: center; background: #fff; padding: 10px 15px; border-radius: 8px; border: 1px solid var(--border);">
            <div>
                <b style="color: var(--primary);">${p.name}</b><br>
                <small style="color: var(--text-muted);">Циклов: <b>${p.cycles}</b> | Итого: <b>${p.quantity.toFixed(2)} ${p.unit}</b></small><br>
                <small style="color: #64748b;">Замесы: Осн (${p.mainCount}), Лиц (${p.faceCount})</small>
            </div>
            <button class="btn" style="color: var(--danger); padding: 5px;" onclick="sessionProducts.splice(${i},1); renderSessionProducts();">🗑️</button>
        </div>
    `).join('');
}

// === ОТПРАВКА НА СЕРВЕР (С ОБРАБОТКОЙ ОШИБОК ЧЕРЕЗ TOAST) ===
let isSubmittingProduction = false; // 🚨 Глобальный флаг защиты от двойного клика

window.submitDailyProduction = async function () {
    if (isSubmittingProduction) return; // 🚨 ЗАЩИТА: Если уже отправляем - игнорируем новые клики

    const shiftName = document.getElementById('prod-shift-name').value.trim();
    if (!shiftName) return UI.toast('Выберите бригадира!', 'warning');
    if (sessionProducts.length === 0) return UI.toast('Добавьте продукцию в партию!', 'error');

    // Собираем все фактические материалы со всех продуктов в этой смене
    let aggregatedMaterials = [];
    sessionProducts.forEach(prod => {
        prod.exactMaterials.forEach(mat => {
            const existing = aggregatedMaterials.find(m => m.id == mat.id);
            if (existing) existing.qty += mat.qty;
            else aggregatedMaterials.push({ id: mat.id, qty: mat.qty });
        });
    });

    const payload = {
        date: document.getElementById('prod-date-filter').value,
        shiftName: shiftName,
        products: sessionProducts,
        materialsUsed: aggregatedMaterials
    };

    isSubmittingProduction = true; // 🚨 БЛОКИРУЕМ кнопку (начинаем процесс)
    UI.toast('⏳ Сохранение смены и проверка остатков...', 'info');

    try {
        const res = await fetch('/api/production', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const result = await res.json(); // Ждем JSON от сервера

        if (res.ok) {
            // ✅ УСПЕХ
            UI.toast(result.message || '✅ Смена зафиксирована, сырье списано!', 'success');
            sessionProducts = [];
            renderSessionProducts();
            loadDailyHistory();
        } else {
            // ❌ ОШИБКА
            UI.toast(result.error || 'Ошибка при сохранении смены', 'error');
        }
    } catch (e) {
        console.error(e);
        UI.toast('Критическая ошибка связи с сервером', 'error');
    } finally {
        isSubmittingProduction = false; // 🚨 СНИМАЕМ БЛОКИРОВКУ в любом случае (даже при ошибке)
    }
};

// === РЕДАКТОР ШАБЛОНОВ (ТЕПЕРЬ 9 ШТУК) ===
let currentEditingTemplateKey = null;

window.editMixTemplate = function (templateKey) {
    currentEditingTemplateKey = templateKey;
    const modal = document.getElementById('mix-template-modal');
    const container = document.getElementById('template-items-container');

    const typeNames = {
        main_40: 'Основной: Плитка 40мм', main_60: 'Основной: Плитка 60мм', main_80: 'Основной: Плитка 80мм', main_por: 'Основной: Поребрик', main_bor: 'Основной: Бордюр',
        face_gs: 'Лицевой: Гладкий серый', face_gc: 'Лицевой: Гладкий цветной', face_grs: 'Лицевой: Гранитный серый', face_grc: 'Лицевой: Гранитный цветной',
        face_mel_g: 'Лицевой: Меланж гладкий', face_mel_gr: 'Лицевой: Меланж гранит'
    };
    document.getElementById('template-modal-title').innerText = `Настройка: ${typeNames[templateKey]}`;

    container.innerHTML = '';
    const items = window.currentMixTemplates[templateKey] || [];
    items.forEach(item => addTemplateRow(item.id, item.qty, item.unit));
    modal.style.display = 'flex';
};

window.addTemplateRow = function (matId = '', qty = 0, unit = 'кг') {
    const container = document.getElementById('template-items-container');
    const row = document.createElement('div');
    row.style.cssText = "display: flex; gap: 10px; margin-bottom: 10px; align-items: center;";

    let optionsHtml = '<option value="">-- Выберите сырье --</option>';
    allMaterialsForMix.forEach(m => {
        const selected = (m.id == matId) ? 'selected' : '';
        optionsHtml += `<option value="${m.id}" data-unit="${m.unit}" ${selected}>${m.name}</option>`;
    });

    row.innerHTML = `
        <select class="input-modern template-mat-select" style="flex-grow: 1;">${optionsHtml}</select>
        <input type="number" class="input-modern template-mat-qty" value="${qty}" style="width: 80px;" onfocus="this.select()" placeholder="Норма">
        <button class="btn btn-red" onclick="this.parentElement.remove()" style="padding: 4px 8px;">❌</button>
    `;
    container.appendChild(row);
};

window.saveMixTemplate = async function () {
    const rows = document.querySelectorAll('#template-items-container > div');
    const newTemplate = [];

    rows.forEach(row => {
        const select = row.querySelector('.template-mat-select');
        const qtyInput = row.querySelector('.template-mat-qty');
        if (select && select.value && parseFloat(qtyInput.value) > 0) {
            newTemplate.push({
                id: select.value, name: select.options[select.selectedIndex].text,
                qty: parseFloat(qtyInput.value) || 0, unit: 'кг'
            });
        }
    });

    window.currentMixTemplates[currentEditingTemplateKey] = newTemplate;

    try {
        await fetch('/api/mix-templates', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(window.currentMixTemplates)
        });
        UI.toast('Шаблон сохранен!', 'success');
        document.getElementById('mix-template-modal').style.display = 'none';
        renderSelectedTemplates(); // Перерисовываем списки на главном экране
    } catch (e) { console.error(e); }
};

// === ИСТОРИЯ И ДЕТАЛИЗАЦИЯ (Без изменений) ===
async function loadDailyHistory() {
    const date = document.getElementById('prod-date-filter').value;
    const tbody = document.getElementById('daily-history-table');
    try {
        const res = await fetch(`/api/production/history?date=${date}`);
        const data = await res.json();
        if (data.length === 0) return tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">В этот день формовок не было.</td></tr>';

        tbody.innerHTML = data.map(b => `
            <tr id="row-${b.id}" style="cursor: pointer;" onmouseover="this.style.backgroundColor='#f1f5f9'" onmouseout="this.style.backgroundColor=''">
                <td onclick="toggleBatchDetails(${b.id})"><strong style="color:var(--primary);">${b.batch_number}</strong></td>
                <td onclick="toggleBatchDetails(${b.id})">${b.product_name}</td>
                <td onclick="toggleBatchDetails(${b.id})">${parseFloat(b.planned_quantity).toFixed(2)}</td>
                <td onclick="toggleBatchDetails(${b.id})">${parseFloat(b.mat_cost_total).toFixed(2)} ₽</td>
                <td style="text-align: right; white-space: nowrap;">
                    <button class="btn btn-outline" style="color: var(--primary); padding: 5px 10px; margin-right: 5px;" onclick="event.stopPropagation(); window.open('/print/passport?batchId=${b.id}', '_blank')" title="Распечатать маршрутный лист">🖨️</button>
                    <button class="btn btn-outline" style="color: var(--danger); padding: 5px 10px;" onclick="event.stopPropagation(); deleteBatch(${b.id}, '${b.batch_number}')">❌</button>
                </td>
            </tr>
        `).join('');
    } catch (e) { console.error(e); }
}

// === ДЕТАЛИЗАЦИЯ ПАРТИИ (СЫРЬЕ И ЭКОНОМИКА НА 1 ЕД.) ===
async function toggleBatchDetails(batchId) {
    const existingRow = document.getElementById(`details-${batchId}`);
    if (existingRow) { existingRow.remove(); return; }

    try {
        const res = await fetch(`/api/production/batch/${batchId}/materials`);
        const materials = await res.json();

        // Базовые данные
        const plannedQty = materials.length > 0 ? (parseFloat(materials[0].planned_quantity) || 1) : 1;
        const machineAmortCost = materials.length > 0 ? (parseFloat(materials[0].machine_amort_cost) || 0) : 0;
        const moldAmortCost = materials.length > 0 ? (parseFloat(materials[0].mold_amort_cost) || 0) : 0;
        const matCost = materials.reduce((sum, m) => sum + parseFloat(m.cost), 0);

        // Расчет за 1 единицу
        const unitMatCost = matCost / plannedQty;
        const unitMachineAmortCost = machineAmortCost / plannedQty;
        const unitMoldAmortCost = moldAmortCost / plannedQty;

        // ИТОГО
        const totalCost = matCost + machineAmortCost + moldAmortCost;
        const unitTotalCost = totalCost / plannedQty;

        let html = `<td colspan="5" style="padding: 0; background: #f8fafc; border-bottom: 2px solid var(--primary);">
            <div style="padding: 20px;">
                <div style="display: flex; gap: 20px; align-items: flex-start;">
                    
                    <div style="flex: 1; background: #fff; padding: 15px; border-radius: 8px; border: 1px solid var(--border); box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
                        <h4 style="margin: 0 0 15px 0; color: var(--text-main);">📊 Экономика партии</h4>
                        
                        <div style="display: flex; justify-content: space-between; margin-bottom: 5px; font-size: 13px;">
                            <span style="color: var(--text-muted);">Сырье (всего):</span>
                            <strong>${matCost.toLocaleString('ru-RU', { minimumFractionDigits: 2 })} ₽</strong>
                        </div>
                        <div style="display: flex; justify-content: space-between; margin-bottom: 5px; font-size: 14px;">
                            <span style="color: var(--text-main); font-weight: bold;">Сырье (за 1 ед.):</span>
                            <strong style="color: #15803d;">${unitMatCost.toLocaleString('ru-RU', { minimumFractionDigits: 2 })} ₽</strong>
                        </div>
                        
                        <div style="border-top: 1px dashed var(--border); margin: 12px 0;"></div>
                        
                        <div style="display: flex; justify-content: space-between; margin-bottom: 5px; font-size: 13px;">
                            <span style="color: var(--text-muted);">Аморт. станка (всего):</span>
                            <strong>${machineAmortCost.toLocaleString('ru-RU', { minimumFractionDigits: 2 })} ₽</strong>
                        </div>
                        <div style="display: flex; justify-content: space-between; margin-bottom: 5px; font-size: 14px;">
                            <span style="color: var(--text-main); font-weight: bold;">Аморт. станка (за 1 ед.):</span>
                            <strong style="color: #f59e0b;">${unitMachineAmortCost.toLocaleString('ru-RU', { minimumFractionDigits: 2 })} ₽</strong>
                        </div>

                        <div style="border-top: 1px dashed var(--border); margin: 12px 0;"></div>

                        <div style="display: flex; justify-content: space-between; margin-bottom: 5px; font-size: 13px;">
                            <span style="color: var(--text-muted);">Аморт. матрицы (всего):</span>
                            <strong>${moldAmortCost.toLocaleString('ru-RU', { minimumFractionDigits: 2 })} ₽</strong>
                        </div>
                        <div style="display: flex; justify-content: space-between; font-size: 14px;">
                            <span style="color: var(--text-main); font-weight: bold;">Аморт. матрицы (за 1 ед.):</span>
                            <strong style="color: #d97706;">${unitMoldAmortCost.toLocaleString('ru-RU', { minimumFractionDigits: 2 })} ₽</strong>
                        </div>

                        <div style="border-top: 2px solid var(--text-main); margin: 15px 0 10px 0;"></div>
                        
                        <div style="display: flex; justify-content: space-between; margin-bottom: 5px; font-size: 15px;">
                            <span style="color: var(--text-main); font-weight: bold;">ИТОГО (Сырье + Аморт):</span>
                            <strong style="color: var(--primary);">${totalCost.toLocaleString('ru-RU', { minimumFractionDigits: 2 })} ₽</strong>
                        </div>
                        <div style="display: flex; justify-content: space-between; font-size: 16px;">
                            <span style="color: var(--text-main); font-weight: 900;">ВСЕГО ЗА 1 ЕД.:</span>
                            <strong style="color: var(--primary); font-weight: 900; font-size: 18px;">${unitTotalCost.toLocaleString('ru-RU', { minimumFractionDigits: 2 })} ₽</strong>
                        </div>
                    </div>

                    <div style="flex: 2;">
                        <h4 style="margin: 0 0 10px 0;">📋 Фактическое списание сырья</h4>
                        <table style="width: 100%; background: #fff; border: 1px solid var(--border); font-size: 13px; border-collapse: collapse;">
                            <thead style="background: #f1f5f9;">
                                <tr>
                                    <th style="padding: 8px; text-align: left; border-bottom: 2px solid var(--border);">Материал</th>
                                    <th style="padding: 8px; text-align: right; border-bottom: 2px solid var(--border);">Списано</th>
                                    <th style="padding: 8px; text-align: right; border-bottom: 2px solid var(--border);">Сумма (₽)</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${materials.map(m => `
                                <tr style="transition: 0.1s;" onmouseover="this.style.backgroundColor='#f8fafc'" onmouseout="this.style.backgroundColor=''">
                                    <td style="padding: 8px; border-bottom: 1px solid var(--border);"><strong>${m.name}</strong></td>
                                    <td style="padding: 8px; text-align: right; border-bottom: 1px solid var(--border);">${parseFloat(m.qty).toFixed(2)} ${m.unit}</td>
                                    <td style="padding: 8px; text-align: right; border-bottom: 1px solid var(--border); color: var(--danger); font-weight: bold;">${parseFloat(m.cost).toLocaleString('ru-RU', { minimumFractionDigits: 2 })} ₽</td>
                                </tr>`).join('')}
                                ${materials.length === 0 ? '<tr><td colspan="3" style="text-align:center; padding: 20px; color: gray;">Нет списаний сырья</td></tr>' : ''}
                            </tbody>
                        </table>
                    </div>

                </div>
            </div>
        </td>`;

        const newTr = document.createElement('tr');
        newTr.id = `details-${batchId}`;
        newTr.innerHTML = html;
        const parentTr = document.getElementById(`row-${batchId}`);
        parentTr.parentNode.insertBefore(newTr, parentTr.nextSibling);
    } catch (e) { console.error(e); }
}

// === ОТМЕНА ФОРМОВКИ (КРАСИВОЕ ОКНО) ===
window.deleteBatch = function (id, batchNumber) {
    const html = `<div style="padding: 15px; text-align: center; font-size: 15px;">Точно отменить формовку <b>${batchNumber}</b> и вернуть списанное сырье на склад?</div>`;

    UI.showModal('⚠️ Отмена формовки', html, `
        <button class="btn btn-outline" onclick="UI.closeModal()">Закрыть</button>
        <button class="btn btn-blue" style="background: #ef4444; border-color: #ef4444;" onclick="executeDeleteBatch(${id})">🗑️ Да, отменить</button>
    `);
};

window.executeDeleteBatch = async function (id) {
    UI.closeModal();
    try {
        const res = await fetch(`/api/production/batch/${id}`, { method: 'DELETE' });
        if (res.ok) {
            UI.toast('🗑️ Формовка отменена, сырье возвращено', 'success');
            loadDailyHistory();
        } else {
            UI.toast('Ошибка при удалении', 'error');
        }
    } catch (e) {
        console.error(e);
        UI.toast('Ошибка сети', 'error');
    }
};