// === public/js/production.js ===

window.currentMixTemplates = {};
let allProductsList = [];
let sessionProducts = [];
let allMaterialsForMix = [];
let currentSelectedProductRecipe = [];
let prodDatePicker = null;
let prodSearchTimer = null;
let currentProdSearchResults = [];
let currentProdSort = { field: 'production_date', asc: false };

window.activeProductionDates = []; // Глобальный массив рабочих дат

// Функция, которая запрашивает свежие даты и заставляет календарь перерисоваться
window.updateCalendarMarks = async function () {
    try {
        const res = await fetch('/api/production/active-dates');
        window.activeProductionDates = await res.json();

        // Если календарь уже инициализирован — даем ему команду перерисовать сетку дней
        if (prodDatePicker) {
            prodDatePicker.redraw();
        }
    } catch (e) { console.error("Ошибка обновления календаря:", e); }
};

async function initProduction() {
    try {
        // 1. БЕЗОПАСНЫЙ И "УМНЫЙ" КАЛЕНДАРЬ
        const dateEl = document.getElementById('prod-date-filter');
        if (dateEl) {
            if (typeof flatpickr !== 'undefined') {
                prodDatePicker = flatpickr(dateEl, {
                    dateFormat: "Y-m-d", altInput: true, altFormat: "d.m.Y", locale: "ru", defaultDate: new Date(),
                    onChange: function () { if (typeof loadDailyHistory === 'function') loadDailyHistory(); },
                    onDayCreate: function (dObj, dStr, fp, dayElem) {
                        const year = dayElem.dateObj.getFullYear();
                        const month = String(dayElem.dateObj.getMonth() + 1).padStart(2, '0');
                        const day = String(dayElem.dateObj.getDate()).padStart(2, '0');
                        const dateStr = `${year}-${month}-${day}`;

                        // Берем даты из глобального массива
                        if (window.activeProductionDates && window.activeProductionDates.includes(dateStr)) {
                            dayElem.style.fontWeight = 'bold';
                            dayElem.style.color = 'var(--primary, #0056b3)';
                            dayElem.innerHTML += '<span style="position: absolute; bottom: 2px; left: 50%; transform: translateX(-50%); width: 4px; height: 4px; background-color: var(--success, #28a745); border-radius: 50%;"></span>';
                        }
                    }
                });
                // Запрашиваем даты сразу после создания календаря
                updateCalendarMarks();
            } else {
                dateEl.valueAsDate = new Date();
                dateEl.addEventListener('change', () => { if (typeof loadDailyHistory === 'function') loadDailyHistory(); });
            }
        }

        // 2. ЗАГРУЖАЕМ СЫРЬЕ
        const resMat = await fetch('/api/items?item_type=material&limit=500');
        const matData = await resMat.json();
        allMaterialsForMix = matData.data || [];

        // 3. ЗАГРУЖАЕМ ШАБЛОНЫ
        const resMix = await fetch('/api/mix-templates');
        const dbTemplates = await resMix.json();

        const findMat = (kw) => allMaterialsForMix.find(m => m.name.toLowerCase().includes(kw)) || { id: '', name: 'Материал', unit: 'кг' };
        const defMain = [{ ...findMat('цемент'), qty: 250 }, { ...findMat('песок'), qty: 600 }, { ...findMat('щебень'), qty: 800 }];
        const defFace = [{ ...findMat('белый цемент'), qty: 50 }, { ...findMat('песок'), qty: 200 }, { ...findMat('щебень'), qty: 300 }];

        window.currentMixTemplates = dbTemplates || {};
        let needsUpdate = false;

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

        // 4. ЗАГРУЖАЕМ ПРОДУКЦИЮ
        const resProd = await fetch('/api/products');
        allProductsList = await resProd.json();
        populateCategories();

        // 5. ЗАГРУЖАЕМ БРИГАДИРОВ
        const resEmp = await fetch('/api/employees');
        const empData = await resEmp.json();
        const shiftSel = document.getElementById('prod-shift-name');
        if (shiftSel) {
            shiftSel.innerHTML = '<option value="">-- Выберите бригадира --</option>';
            let activeEmps = empData.filter(e => e.status === 'active');
            activeEmps.sort((a, b) => {
                const isWorkshop = (emp) => (emp.department && emp.department.toLowerCase().includes('цех')) || (emp.position && (emp.position.toLowerCase().includes('цех') || emp.position.toLowerCase().includes('формов')));
                return (isWorkshop(b) ? 1 : 0) - (isWorkshop(a) ? 1 : 0);
            });
            activeEmps.forEach(emp => shiftSel.add(new Option(emp.full_name, emp.full_name)));
        }

        renderSelectedTemplates();
        initStaticProductionSelects();
        loadDailyHistory();
    } catch (e) {
        console.error("Ошибка инициализации производства:", e);
    }
}

function initStaticProductionSelects() {
    ['prod-shift-name', 'main-template-select', 'face-template-select'].forEach(id => {
        const el = document.getElementById(id);
        if (el && !el.tomselect) {
            new TomSelect(el, {
                plugins: ['clear_button'],
                allowEmptyOption: true,
                onChange: function(val) {
                    if (id !== 'prod-shift-name' && typeof renderSelectedTemplates === 'function') {
                        renderSelectedTemplates();
                    }
                }
            });
        }
    });
}

function populateCategories() {
    const sel = document.getElementById('prod-product-select');
    if (!sel) return;

    const options = allProductsList.map(p => ({ value: String(p.id), text: p.name }));

    if (sel.tomselect) {
        // 🛡️ Уже инициализирован — обновляем список
        const ts = sel.tomselect;
        ts.clearOptions();
        ts.addOptions(options);
    } else {
        // 🆕 Первая инициализация
        new TomSelect(sel, {
            plugins: ['clear_button'],
            options: options,
            placeholder: '— Выберите продукцию —',
            allowEmptyOption: true,
            onChange: function () {
                handleProductSelection();
            }
        });
    }
}

// === АВТО-ВЫБОР ШАБЛОНА ПРИ СМЕНЕ ПРОДУКТА ===
window.handleProductSelection = async function () {
    const sel = document.getElementById('prod-product-select');
    const productId = sel.value;
    if (!productId) return;

    // Берём название из allProductsList (TomSelect-совместимо)
    const product = allProductsList.find(p => p.id == productId);
    const productName = (product ? product.name : '').toLowerCase();

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
            <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border); padding: 4px 0;">
                <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;">${m.name}</span>
                <div style="display: flex; align-items: center; gap: 5px;">
                    <input type="number" class="input-modern ${prefix}-qty" data-id="${m.id}" data-name="${m.name}" data-unit="${m.unit}" value="${m.qty}" style="width: 75px; padding: 2px 5px; text-align: right; margin: 0; font-weight: bold; font-size: 13px; border: 1px solid var(--border);" onfocus="this.select()" title="Изменить для этого конкретного замеса">
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

        // Подставляем подсказку ТОЛЬКО если поля пустые (бригадир ещё не вводил)
        const mainInput = document.getElementById('main-mix-count');
        const faceInput = document.getElementById('face-mix-count');
        if (!mainInput.value || mainInput.value === '0' || !mainInput.dataset.userEdited) {
            mainInput.value = suggestedMain;
        }
        if (!faceInput.value || faceInput.value === '0' || !faceInput.dataset.userEdited) {
            faceInput.value = suggestedFace;
        }
    } else {
        document.getElementById('main-mix-count').value = '';
        document.getElementById('face-mix-count').value = '';
    }
};

// === ДОБАВЛЕНИЕ В ПАРТИЮ (СПИСАНИЕ СТРОГО ПО ПОЛЯМ ВВОДА С ЭКРАНА) ===
window.addProdToSession = async function () {
    const sel = document.getElementById('prod-product-select');
    const cycles = parseFloat(document.getElementById('prod-cycles-input').value);
    const mainCount = parseFloat(document.getElementById('main-mix-count').value) || 0;
    const faceCount = parseFloat(document.getElementById('face-mix-count').value) || 0;

    if (!sel.value || isNaN(cycles) || cycles <= 0) return UI.toast('Выберите товар и введите положительное количество ударов!', 'error');
    if (mainCount < 0 || faceCount < 0) return UI.toast('Количество замесов не может быть отрицательным!', 'error');
    if (mainCount === 0 && faceCount === 0) return UI.toast('Количество замесов не может быть равно нулю!', 'error');

    // ⚠️ ОБЯЗАТЕЛЬНО: дата и бригадир нужны для сохранения на сервере
    const shiftDateStr = document.getElementById('prod-date-filter').value;
    const shiftName = document.getElementById('prod-shift-name').value.trim();
    if (!shiftDateStr) return UI.toast('Сначала выберите дату смены!', 'warning');
    if (!shiftName) return UI.toast('Сначала выберите бригадира!', 'warning');

    const product = allProductsList.find(p => p.id == sel.value);
    const volume = cycles * (parseFloat(product.qty_per_cycle) || 1);

    // 🚀 СЧИТАЕМ РЕАЛЬНЫЙ РАСХОД: Читаем цифры прямо из полей ввода на экране
    let actualMaterials = [];

    // Читаем Основной замес
    document.querySelectorAll('.main-mix-mat-qty').forEach(input => {
        const qtyPerMix = parseFloat(input.value) || 0;
        const matId = input.getAttribute('data-id');
        if (qtyPerMix > 0 && mainCount > 0 && matId && matId !== 'undefined' && matId !== '') {
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
        const matId = input.getAttribute('data-id');
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

    if (actualMaterials.length === 0) {
        return UI.toast('Не списано ни грамма сырья! Укажите замесы или проверьте состав шаблона.', 'error');
    }

    // 🛡️ БЛОКИРОВКА КНОПКИ: защита от спам-кликов
    const addBtn = document.querySelector('[onclick*="addProdToSession"]');
    let origBtnText = '';
    if (addBtn) {
        origBtnText = addBtn.innerText;
        addBtn.disabled = true;
        addBtn.innerText = '⏳ Сохранение...';
        addBtn.style.opacity = '0.6';
    }

    try {
        // Внутри addProdToSession
        const draftPayload = {
            date: shiftDateStr,
            shiftName: shiftName,
            products: [{ id: product.id, quantity: volume, cycles: cycles }],
            materialsUsed: actualMaterials, // 👈 ТЕПЕРЬ ОТПРАВЛЯЕМ РЕАЛЬНОЕ СЫРЬЕ
            status: 'draft'
        };
        const res = await fetch('/api/production', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(draftPayload)
        });
        const result = await res.json();
        if (res.ok) {
            // Сохраняем в память только после успешного ответа сервера
            sessionProducts.push({
                id: product.id,
                name: product.name,
                mold_id: product.mold_id || null,
                cycles: cycles,
                quantity: volume,
                unit: product.unit,
                exactMaterials: actualMaterials,
                mainCount: mainCount,
                faceCount: faceCount
            });
            UI.toast('📝 Черновик сохранён', 'success');
            loadDailyHistory();
        } else {
            UI.toast(result.error || 'Ошибка сохранения черновика', 'error');
        }
    } catch (e) {
        console.error(e);
        UI.toast('Ошибка сети при сохранении черновика', 'error');
    } finally {
        // 🛡️ РАЗБЛОКИРОВКА КНОПКИ
        if (addBtn) {
            addBtn.disabled = false;
            addBtn.innerText = origBtnText;
            addBtn.style.opacity = '1';
        }
    }

    renderSessionProducts();
    document.getElementById('prod-cycles-input').value = '';
    document.getElementById('main-mix-count').value = '';
    document.getElementById('face-mix-count').value = '';
    // Сбрасываем флаг ручного ввода для следующей партии
    delete document.getElementById('main-mix-count').dataset.userEdited;
    delete document.getElementById('face-mix-count').dataset.userEdited;
    document.getElementById('prod-volume-preview').innerText = '0.00';

    // Сбрасываем поля замесов обратно к идеальному шаблону для следующей партии
    renderSelectedTemplates();
};

function renderSessionProducts() {
    const container = document.getElementById('session-products-list');
    if (sessionProducts.length === 0) {
        container.innerHTML = `<div style="color: var(--text-muted); font-size: 13px; text-align: center; padding: 15px; border: 1px dashed var(--border); border-radius: 6px;">Смена пуста. Выберите продукцию выше.</div>`;
        return;
    }

    container.innerHTML = sessionProducts.map((p, i) => `
        <div style="display: flex; justify-content: space-between; align-items: center; background: var(--surface); padding: 10px 15px; border-radius: 8px; border: 1px solid var(--border);">
            <div>
                <b style="color: var(--primary);">${p.name}</b><br>
                <small style="color: var(--text-muted);">${p.fromServer ? '<em>📝 Сохранён на сервере</em>' : `Циклов: <b>${p.cycles}</b> | Итого: <b>${p.quantity.toFixed(2)} ${p.unit || ''}</b>`}</small><br>
                <small style="color: var(--text-muted);">${p.fromServer ? '' : `Замесы: Осн (${p.mainCount || 0}), Лиц (${p.faceCount || 0})`}</small>
            </div>
            <button class="btn" style="color: var(--danger); padding: 5px;" onclick="removeSessionProduct(${i})">🗑️</button>
        </div>
    `).join('');
}

// 🆕 Удаление элемента из списка смены (с удалением из БД для серверных черновиков)
window.removeSessionProduct = function (index) {
    const item = sessionProducts[index];
    if (item && item.batchId) {
        // Серверный draft — удаляем через API (с подтверждением)
        deleteBatch(item.batchId, item.name);
    } else {
        // Локальный (ещё не сохранён) — просто убираем из памяти
        sessionProducts.splice(index, 1);
        renderSessionProducts();
    }
};

// === ОТПРАВКА НА СЕРВЕР (С ОБРАБОТКОЙ ОШИБОК ЧЕРЕЗ TOAST) ===
let isSubmittingProduction = false; // 🚨 Глобальный флаг защиты от двойного клика

window.submitDailyProduction = async function (btnElement) {
    if (isSubmittingProduction) return;

    // Пытаемся получить кнопку (либо переданную, либо по тексту)
    const btn = btnElement instanceof HTMLElement ? btnElement : null;

    const shiftDateStr = document.getElementById('prod-date-filter').value;
    const shiftName = document.getElementById('prod-shift-name').value.trim();

    // [РЕШЕНИЕ 4] Валидация будущей даты на клиенте
    const selectedDate = new Date(shiftDateStr);
    const today = new Date();
    today.setHours(23, 59, 59, 999); // Даем закрыть сегодняшний день полностью

    if (!shiftDateStr) return UI.toast('Выберите дату смены!', 'warning');
    if (selectedDate > today) return UI.toast('Нельзя закрывать смену в будущем!', 'warning');
    if (!shiftName) return UI.toast('Выберите бригадира!', 'warning');
    if (sessionProducts.length === 0) return UI.toast('Добавьте продукцию в партию!', 'error');

    // Начинаем жесткую блокировку
    isSubmittingProduction = true;
    let originalBtnText = '';

    // Блокируем кнопку, если нашли её, или ищем все возможные кнопки отправки
    const buttonsToDisable = btn ? [btn] : Array.from(document.querySelectorAll('button')).filter(b => b.innerText.includes('Закрыть смену') || Array.from(b.attributes).some(attr => attr.value.includes('submitDailyProduction')));

    buttonsToDisable.forEach(b => {
        b.dataset.origText = b.innerText;
        b.innerText = 'Обработка...';
        b.disabled = true;
        b.style.opacity = '0.5';
        b.style.pointerEvents = 'none';
    });

    // Материалы уже загружены в sessionProducts через loadDailyHistory

    // [РЕШЕНИЕ 3] Агрегация с защитой от пустых/битых ID материалов
    let aggregatedMaterials = [];
    sessionProducts.forEach(prod => {
        // 🛡️ Пропускаем записи без exactMaterials (восстановленные с сервера)
        if (!prod.exactMaterials || !Array.isArray(prod.exactMaterials)) return;
        prod.exactMaterials.forEach(mat => {
            if (!mat.id || mat.id === 'undefined') return;
            const existing = aggregatedMaterials.find(m => m.id == mat.id);
            if (existing) {
                existing.qty += mat.qty;
            } else {
                aggregatedMaterials.push({ id: mat.id, qty: mat.qty });
            }
        });
    });

    const payload = {
        date: shiftDateStr,
        materialsUsed: aggregatedMaterials
    };

    isSubmittingProduction = true;
    UI.toast('⏳ Фиксация смены: проверка остатков и списание...', 'info');

    try {
        // 🆕 Вызываем роут фиксации вместо создания партий (они уже есть как черновики)
        const res = await fetch('/api/production/fixate-shift', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const result = await res.json();

        if (res.ok) {
            UI.toast('✅ Смена зафиксирована! Сырье списано, продукция на сушилке.', 'success');
            sessionProducts = [];
            renderSessionProducts();
            loadDailyHistory();
            updateCalendarMarks();
        } else {
            if (result.details) {
                const missingList = result.details.split('; ').join('<br>• ');
                UI.toast(`<b>${result.error}:</b><br>• ${missingList}`, 'error');
            } else {
                UI.toast(result.error || 'Ошибка фиксации', 'error');
            }
        }
    } catch (e) {
        UI.toast('Критическая ошибка связи с сервером', 'error');
    } finally {
        isSubmittingProduction = false;
        buttonsToDisable.forEach(b => {
            b.innerText = b.dataset.origText || 'Закрыть смену';
            b.disabled = false;
            b.style.opacity = '1';
            b.style.pointerEvents = 'auto';
        });
    }
};

// === РЕДАКТОР ШАБЛОНОВ ===
window.editMixTemplate = function (templateKey) {
    window.currentMixTemplates = window.currentMixTemplates || {};
    const tplArray = window.currentMixTemplates[templateKey] || [];
    window.currentMixTemplates[templateKey] = tplArray;

    const title = `Редактирование шаблона: ${templateKey.startsWith('main') ? 'Основной слой' : 'Фактурный слой'}`;

    // Предварительная генерация <option> для всех материалов для использования в таблице и в блоке добавления
    let matOptionsGlobal = '<option value="" disabled>-- Выберите сырье --</option>';
    allMaterialsForMix.forEach(m => {
        matOptionsGlobal += `<option value="${m.id}" data-name="${m.name.replace(/"/g, '&quot;')}">${m.name}</option>`;
    });

    let tableRows = tplArray.map((mat, index) => {
        // Генерируем селект для конкретной строки с учетом уже выбранного материала
        let rowMatOptions = `<option value="" disabled>-- Выберите сырье --</option>`;
        allMaterialsForMix.forEach(m => {
            const selected = (m.id == mat.id) ? 'selected' : '';
            rowMatOptions += `<option value="${m.id}" data-name="${m.name.replace(/"/g, '&quot;')}" ${selected}>${m.name}</option>`;
        });

        return `
            <tr style="border-bottom: 1px solid var(--border); transition: background 0.2s;" onmouseover="this.style.background='var(--surface-alt)'" onmouseout="this.style.background='transparent'">
                <td style="padding: 12px 10px;">
                    <select class="input-modern tpl-mat-select w-100" data-index="${index}" style="margin: 0;">
                        ${rowMatOptions}
                    </select>
                </td>
                <td style="padding: 12px 10px; width: 140px;">
                    <input type="number" step="any" class="input-modern tpl-qty-input text-center" data-index="${index}" value="${mat.qty}" style="width: 100%; margin: 0; font-weight: bold;" onfocus="this.select()">
                </td>
                <td style="padding: 12px 10px; text-align: right; width: 60px;">
                    <button class="btn btn-red" style="padding: 6px 12px; height: auto;" onclick="removeMaterialFromTemplate('${templateKey}', ${index})" title="Удалить строку">✕</button>
                </td>
            </tr>
        `;
    }).join('');

    const html = `
        <div style="margin-bottom: 25px;">
            <table class="w-100" style="border-collapse: collapse; margin-bottom: 25px;">
                <thead>
                    <tr style="background: var(--surface-alt); text-align: left; color: var(--text-muted); font-size: 13px; text-transform: uppercase;">
                        <th style="padding: 12px 10px; border-radius: 8px 0 0 8px;">Сырье (можно заменить)</th>
                        <th style="padding: 12px 10px; text-align: center;">Норма (кг)</th>
                        <th style="padding: 12px 10px; text-align: right; border-radius: 0 8px 8px 0;">Удалить</th>
                    </tr>
                </thead>
                <tbody>
                    ${tableRows || '<tr><td colspan="3" style="padding: 20px 10px; text-align: center; color: var(--text-muted); font-style: italic;">В шаблоне пока нет сырья</td></tr>'}
                </tbody>
            </table>

            <div style="background: var(--surface-alt); padding: 18px; border-radius: 10px; border: 1px dashed var(--border); box-shadow: 0 4px 15px rgba(0,0,0,0.03);">
                <label style="font-weight: 600; margin-bottom: 12px; display: block; font-size: 14px; color: var(--primary);">➕ Добавить новое сырье в шаблон:</label>
                <div style="display: flex; gap: 12px; align-items: stretch;">
                    <select id="new-tpl-mat" class="input-modern" style="flex: 1; margin: 0;">${matOptionsGlobal}</select>
                    <input type="number" step="any" id="new-tpl-qty" class="input-modern text-center" placeholder="0.00" style="width: 120px; margin: 0; font-weight: bold;" onfocus="this.select()">
                    <button class="btn btn-green shadow-success" style="padding: 0 20px; font-weight: bold;" onclick="addMaterialToTemplate('${templateKey}')">Добавить</button>
                </div>
            </div>
        </div>
    `;

    UI.showModal(title, html, `<button class="btn btn-blue w-100 btn-lg" style="font-size: 16px; font-weight: bold;" onclick="saveMixTemplate('${templateKey}')">💾 СОХРАНИТЬ ШАБЛОН</button>`);

    // Инициализация TomSelect после рендера модалки
    setTimeout(() => {
        const tsConfig = {
            plugins: ['clear_button'],
            dropdownParent: 'body' // 🚀 КРИТИЧНО для модальных окон!
        };

        const newTplMat = document.getElementById('new-tpl-mat');
        if (newTplMat && !newTplMat.tomselect) {
            new TomSelect(newTplMat, tsConfig);
        }

        document.querySelectorAll('.tpl-mat-select').forEach(sel => {
            if (!sel.tomselect) {
                new TomSelect(sel, tsConfig);
            }
        });
    }, 50); // Небольшая задержка, чтобы DOM модалки точно отрисовался
};

window.addMaterialToTemplate = function (templateKey) {
    const select = document.getElementById('new-tpl-mat');
    const qtyInput = document.getElementById('new-tpl-qty');

    if (!select.value) return UI.toast('Выберите сырье', 'warning');
    const qty = parseFloat(qtyInput.value) || 0;
    if (qty <= 0) return UI.toast('Введите количество больше 0', 'warning');

    const name = select.options[select.selectedIndex].getAttribute('data-name');

    if (!window.currentMixTemplates[templateKey]) window.currentMixTemplates[templateKey] = [];

    window.currentMixTemplates[templateKey].push({
        id: select.value,
        name: name,
        qty: qty,
        unit: 'кг'
    });

    editMixTemplate(templateKey);
};

window.removeMaterialFromTemplate = function (templateKey, index) {
    if (window.currentMixTemplates[templateKey]) {
        window.currentMixTemplates[templateKey].splice(index, 1);
        editMixTemplate(templateKey);
    }
};

window.saveMixTemplate = async function (templateKey) {
    const qtyInputs = document.querySelectorAll('.tpl-qty-input');
    const matSelects = document.querySelectorAll('.tpl-mat-select');

    if (window.currentMixTemplates[templateKey]) {
        // Проходим по всем строкам и считываем обновленные значения
        for (let i = 0; i < qtyInputs.length; i++) {
            const index = qtyInputs[i].getAttribute('data-index');
            const newQty = parseFloat(qtyInputs[i].value) || 0;
            const selectEl = matSelects[i];

            if (window.currentMixTemplates[templateKey][index]) {
                window.currentMixTemplates[templateKey][index].qty = newQty;
                // Читаем новое сырье, если пользователь его поменял через drop-down
                if (selectEl && selectEl.value) {
                    window.currentMixTemplates[templateKey][index].id = selectEl.value;
                    window.currentMixTemplates[templateKey][index].name = selectEl.options[selectEl.selectedIndex].getAttribute('data-name');
                }
            }
        }
    }

    try {
        await fetch('/api/mix-templates', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(window.currentMixTemplates)
        });
        UI.closeModal();
        UI.toast('Шаблон успешно обновлен!', 'success');
        renderSelectedTemplates();
        if (typeof calculateMixesPreview === 'function') calculateMixesPreview();
    } catch (e) {
        console.error(e);
        UI.toast('Ошибка сохранения', 'error');
    }
};

// === ИСТОРИЯ И ДЕТАЛИЗАЦИЯ (Без изменений) ===
async function loadDailyHistory() {
    const date = document.getElementById('prod-date-filter').value;
    const tbody = document.getElementById('daily-history-table');
    const tfoot = document.getElementById('prod-history-summary');
    if (!tbody) return;

    try {
        const res = await fetch(`/api/production/history?date=${date}`);
        const data = await res.json();

        if (!Array.isArray(data)) {
            tbody.innerHTML = `<tr><td colspan="5" class="text-center text-danger">Ошибка: ${data.error || 'нет данных'}</td></tr>`;
            return;
        }

        // Переменные для итогов 
        let dayTotalVolume = 0;
        let dayTotalCost = 0;

        // Восстановление sessionProducts из черновиков 
        sessionProducts = [];
        for (let b of data.filter(i => i.status === 'draft')) {
            const matRes = await fetch(`/api/production/batch/${b.id}/materials`);
            const materials = await matRes.json();
            sessionProducts.push({
                batchId: b.id, id: b.product_id, name: b.product_name,
                quantity: parseFloat(b.planned_quantity), cycles: 0,
                exactMaterials: materials.map(m => ({ id: m.id, name: m.name, qty: parseFloat(m.qty), unit: m.unit })),
                fromServer: true
            });
        }
        renderSessionProducts();

        if (data.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted">В этот день формовок не было.</td></tr>';
            if (tfoot) tfoot.style.display = 'none';
            return;
        }

        tbody.innerHTML = data.map(b => {
            const isDraft = (b.status === 'draft');
            const cost = parseFloat(b.mat_cost_total) || 0;
            const volume = parseFloat(b.planned_quantity) || 0;

            // Считаем итоги (только для зафиксированных партий, или всех - на ваш выбор)
            dayTotalVolume += volume;
            dayTotalCost += cost;

            const draftBadge = isDraft ? '<span style="background: var(--warning); color: #000; padding: 2px 8px; border-radius: 10px; font-size: 10px; font-weight: bold; margin-left: 6px;">📝 Черновик</span>' : '';
            const costDisplay = isDraft ? '<span style="color: var(--text-muted); font-style: italic;">—</span>' : `${cost.toFixed(2)} ₽`;

            return `
            <tr id="row-${b.id}" style="${isDraft ? 'border-left: 3px solid var(--warning);' : ''}">
                <td onclick="toggleBatchDetails(${b.id})"><strong>${b.batch_number}</strong>${draftBadge}</td>
                <td onclick="toggleBatchDetails(${b.id})">${b.product_name}</td>
                <td onclick="toggleBatchDetails(${b.id})">${volume.toFixed(2)}</td>
                <td onclick="toggleBatchDetails(${b.id})">${costDisplay}</td>
                <td style="text-align: right; white-space: nowrap;">
                    <button class="btn btn-outline" style="color: var(--primary); padding: 5px 10px; margin-right: 5px;" 
                            onclick="event.stopPropagation(); window.open('/print/passport?batchId=${b.id}', '_blank')">🖨️</button>
                    ${isDraft ? `<button class="btn btn-outline" style="color: var(--warning-text); padding: 5px 10px; margin-right: 5px;" 
                                         onclick="event.stopPropagation(); editDraftBatch(${b.id})">✏️</button>` : ''}
                    <button class="btn btn-outline" style="color: var(--danger); padding: 5px 10px;" 
                            onclick="event.stopPropagation(); deleteBatch(${b.id}, '${b.batch_number}')">❌</button>
                </td>
            </tr>`;
        }).join('');

        // Выводим итоги 
        if (tfoot && data.length > 0) {
            tfoot.style.display = 'table-footer-group';
            document.getElementById('prod-total-volume').innerText = dayTotalVolume.toFixed(2);
            document.getElementById('prod-total-cost').innerText = dayTotalCost.toLocaleString('ru-RU', { minimumFractionDigits: 2 }) + ' ₽';
        }

    } catch (e) {
        console.error("Ошибка сети:", e);
        tbody.innerHTML = '<tr><td colspan="5" class="text-center text-danger">Ошибка связи с сервером</td></tr>';
    }
}

// === ДЕТАЛИЗАЦИЯ ПАРТИИ (СЫРЬЕ И ЭКОНОМИКА НА 1 ЕД.) ===
async function toggleBatchDetails(batchId) {
    const existingRow = document.getElementById(`details-${batchId}`);
    if (existingRow) { existingRow.remove(); return; }

    try {
        // 1. Получаем данные партии (объём, амортизация)
        const batchRes = await fetch(`/api/production/batch/${batchId}/info`);
        const batchInfo = await batchRes.json();

        // 2. Получаем материалы
        const matRes = await fetch(`/api/production/batch/${batchId}/materials`);
        const materials = await matRes.json();

        // Данные партии
        const plannedQty = parseFloat(batchInfo.planned_quantity) || 1;
        const machineAmortCost = parseFloat(batchInfo.machine_amort_cost) || 0;
        const moldAmortCost = parseFloat(batchInfo.mold_amort_cost) || 0;
        const matCost = materials.reduce((sum, m) => sum + parseFloat(m.cost), 0);

        // Расчет за 1 единицу
        const unitMatCost = matCost / plannedQty;
        const unitMachineAmortCost = machineAmortCost / plannedQty;
        const unitMoldAmortCost = moldAmortCost / plannedQty;

        // ИТОГО
        const totalCost = matCost + machineAmortCost + moldAmortCost;
        const unitTotalCost = totalCost / plannedQty;
        const totalWeightBatch = materials.reduce((sum, m) => sum + parseFloat(m.qty), 0);
        const totalWeightUnit = totalWeightBatch / plannedQty;

        let html = `
<td colspan="6" style="padding: 0; background: #fdfdfd; border-bottom: 3px solid var(--primary);">
    <div style="padding: 30px; font-family: 'Inter', system-ui, sans-serif; color: #333;">
        
        <div style="display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 25px; border-bottom: 2px solid #eee; padding-bottom: 15px;">
            <div>
                <h3 style="margin: 0; font-size: 20px; color: var(--text-main);">📊 Экономика и себестоимость партии #${batchId}</h3>
                <p style="margin: 5px 0 0; color: var(--text-muted); font-size: 14px;">Общий объем выпуска: <b style="color: var(--text-main);">${plannedQty.toFixed(2)} ${batchInfo.unit || 'ед.'}</b></p>
            </div>
            <div style="text-align: right;">
                <div style="font-size: 13px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 1px;">Полная себестоимость 1 ед.</div>
                <div style="font-size: 32px; font-weight: 900; color: var(--primary); line-height: 1;">${unitTotalCost.toLocaleString('ru-RU', { minimumFractionDigits: 2 })} ₽</div>
            </div>
        </div>

        <div style="display: grid; grid-template-columns: 320px 1fr; gap: 30px;">
            
            <div style="display: flex; flex-direction: column; gap: 18px;">
                <div style="background: white; padding: 18px; border-radius: 12px; border: 1px solid #e0e0e0; border-left: 5px solid var(--success);">
                    <div style="display: flex; justify-content: space-between; margin-bottom: 10px;">
                        <span style="font-weight: bold; color: #555;">📦 Сырье и материалы</span>
                        <b style="font-size: 16px;">${matCost.toLocaleString('ru-RU')} ₽</b>
                    </div>
                    <div style="background: #f0f0f0; height: 8px; border-radius: 4px; margin-bottom: 10px; overflow: hidden;">
                        <div style="width: ${(matCost / totalCost * 100).toFixed(0)}%; height: 100%; background: var(--success);"></div>
                    </div>
                    <div style="display: flex; justify-content: space-between; font-size: 14px; background: #f9f9f9; padding: 8px; border-radius: 6px;">
                        <span style="color: #666;">На 1 единицу:</span>
                        <b style="color: var(--success);">${unitMatCost.toLocaleString('ru-RU', { minimumFractionDigits: 2 })} ₽</b>
                    </div>
                </div>

                <div style="background: white; padding: 18px; border-radius: 12px; border: 1px solid #e0e0e0; border-left: 5px solid var(--warning);">
                    <div style="display: flex; justify-content: space-between; margin-bottom: 10px;">
                        <span style="font-weight: bold; color: #555;">⚙️ Аморт. станка</span>
                        <b style="font-size: 16px;">${machineAmortCost.toLocaleString('ru-RU')} ₽</b>
                    </div>
                    <div style="display: flex; justify-content: space-between; font-size: 14px; background: #fffcf5; padding: 8px; border-radius: 6px; border: 1px solid #fff3d6;">
                        <span style="color: #666;">На 1 единицу:</span>
                        <b style="color: #b37400;">${unitMachineAmortCost.toLocaleString('ru-RU', { minimumFractionDigits: 2 })} ₽</b>
                    </div>
                </div>

                <div style="background: white; padding: 18px; border-radius: 12px; border: 1px solid #e0e0e0; border-left: 5px solid #007bff;">
                    <div style="display: flex; justify-content: space-between; margin-bottom: 10px;">
                        <span style="font-weight: bold; color: #555;">🧩 Аморт. матрицы</span>
                        <b style="font-size: 16px;">${moldAmortCost.toLocaleString('ru-RU')} ₽</b>
                    </div>
                    <div style="display: flex; justify-content: space-between; font-size: 14px; background: #f0f7ff; padding: 8px; border-radius: 6px; border: 1px solid #d1e7ff;">
                        <span style="color: #666;">На 1 единицу:</span>
                        <b style="color: #0056b3;">${unitMoldAmortCost.toLocaleString('ru-RU', { minimumFractionDigits: 2 })} ₽</b>
                    </div>
                </div>
            </div>

            <div style="background: white; padding: 25px; border-radius: 12px; border: 1px solid #e0e0e0; box-shadow: 0 10px 30px rgba(0,0,0,0.03);">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                    <h4 style="margin: 0; font-size: 15px; text-transform: uppercase; letter-spacing: 0.5px; color: #666;">📋 Фактическое списание сырья</h4>
                    <span style="background: #eee; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: bold;">Компонентов: ${materials.length}</span>
                </div>
                
                <table style="width: 100%; border-collapse: collapse;">
                    <thead>
                        <tr style="text-align: left; background: #f8f9fa;">
                            <th style="padding: 12px; border-bottom: 2px solid #eee; font-size: 11px; color: #888;">МАТЕРИАЛ</th>
                            <th style="padding: 12px; border-bottom: 2px solid #eee; font-size: 11px; color: #888; text-align: right;">ОБЩИЙ РАСХОД</th>
                            <th style="padding: 12px; border-bottom: 2px solid #eee; font-size: 11px; color: #888; text-align: right;">НА 1 ЕД.</th>
                            <th style="padding: 12px; border-bottom: 2px solid #eee; font-size: 11px; color: #888; text-align: right;">ЦЕНА/КГ</th>
                            <th style="padding: 12px; border-bottom: 2px solid #eee; font-size: 11px; color: #888; text-align: right;">СУММА (1 ЕД)</th>
                            <th style="padding: 12px; border-bottom: 2px solid #eee; font-size: 11px; color: #888; text-align: right;">СУММА (ПАРТИЯ)</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${materials.map(m => {
            const qBatch = parseFloat(m.qty);
            const qUnit = qBatch / plannedQty;
            const costBatch = parseFloat(m.cost);
            const costUnit = costBatch / plannedQty;
            const pricePerKg = costBatch / qBatch;

            return `
                            <tr style="border-bottom: 1px solid #f5f5f5;">
                                <td style="padding: 12px; font-weight: 600; color: #333;">${m.name}</td>
                                <td style="padding: 12px; text-align: right;">${qBatch.toFixed(2)} <small style="color:#999">${m.unit}</small></td>
                                <td style="padding: 12px; text-align: right; color: var(--primary);">${qUnit.toFixed(3)} <small>${m.unit}</small></td>
                                <td style="padding: 12px; text-align: right; color: #888; font-size: 12px;">${pricePerKg.toFixed(2)}</td>
                                <td style="padding: 12px; text-align: right; font-weight: bold; color: #555;">${costUnit.toFixed(2)} ₽</td>
                                <td style="padding: 12px; text-align: right; font-weight: bold; color: var(--danger);">${costBatch.toLocaleString('ru-RU', { minimumFractionDigits: 2 })} ₽</td>
                            </tr>`;
        }).join('')}
                    </tbody>
                    <tfoot style="background: #fcfcfc; border-top: 2px solid #eee;">
                        <tr style="font-weight: 900; color: var(--text-main);">
                            <td style="padding: 15px 12px;">ИТОГО ПО СЫРЬЮ:</td>
                            <td style="padding: 15px 12px; text-align: right;">${totalWeightBatch.toFixed(2)} <small>кг</small></td>
                            <td style="padding: 15px 12px; text-align: right; color: var(--primary);">${totalWeightUnit.toFixed(3)} <small>кг</small></td>
                            <td style="padding: 15px 12px;"></td>
                            <td style="padding: 15px 12px; text-align: right;">${unitMatCost.toFixed(2)} ₽</td>
                            <td style="padding: 15px 12px; text-align: right; color: var(--danger); font-size: 16px;">${matCost.toLocaleString('ru-RU', { minimumFractionDigits: 2 })} ₽</td>
                        </tr>
                    </tfoot>
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
    // 🛡️ escapeHTML для номера партии
    const html = `<div style="padding: 15px; text-align: center; font-size: 15px;">Точно отменить формовку <b>${escapeHTML(batchNumber)}</b> и вернуть списанное сырье на склад?</div>`;

    UI.showModal('⚠️ Отмена формовки', html, `
        <button class="btn btn-outline" onclick="UI.closeModal()">Закрыть</button>
        <button class="btn btn-red" onclick="executeDeleteBatch(${id})">🗑️ Да, отменить</button>
    `);
};

window.executeDeleteBatch = async function (id) {
    UI.closeModal();
    try {
        const res = await fetch(`/api/production/batch/${id}`, { method: 'DELETE' });
        if (res.ok) {
            UI.toast('🗑️ Формовка отменена, сырье возвращено', 'success');

            // Проверяем, активен ли поиск
            const searchInput = document.getElementById('prod-search-input');
            if (searchInput && searchInput.value.trim().length > 0) {
                handleProductionSearch(); // Обновляем результаты поиска
            } else {
                loadDailyHistory(); // Обновляем календарный день
                updateCalendarMarks();
            }
        } else {
            const err = await res.json();
            UI.toast(err.error || 'Ошибка при удалении', 'error');
        }
    } catch (e) {
        console.error(e);
        UI.toast('Ошибка сети', 'error');
    }
};

// 
window.editDraftBatch = async function (batchId) {
    UI.toast('⏳ Загрузка черновика...', 'info');
    try {
        const infoRes = await fetch(`/api/production/batch/${batchId}/info`);
        const info = await infoRes.json();

        // 1. Устанавливаем продукт в TomSelect
        const sel = document.getElementById('prod-product-select').tomselect;
        if (sel) sel.setValue(info.product_id);

        // 2. Возвращаем количество ударов (циклов)
        // Примечание: если в БД нет циклов, попробуем восстановить из объема
        const product = allProductsList.find(p => p.id == info.product_id);
        const ratio = product ? (parseFloat(product.qty_per_cycle) || 1) : 1;
        document.getElementById('prod-cycles-input').value = (parseFloat(info.planned_quantity) / ratio).toFixed(0);

        // 3. Скроллим наверх к форме
        window.scrollTo({ top: 0, behavior: 'smooth' });

        // 4. Удаляем старый черновик, так как при нажатии "Добавить" создастся новый (актуализированный)
        // Либо можно не удалять, а просто предупредить, что старый нужно будет удалить вручную
        UI.toast('✏️ Данные загружены. После правок старый черновик можно будет удалить.', 'success');

    } catch (e) {
        UI.toast('Ошибка загрузки черновика', 'error');
    }
};

window.printDailyReport = function () {
    const date = document.getElementById('prod-date-filter').value;
    const shiftName = document.getElementById('prod-shift-name').value || 'Не указан';
    const rows = Array.from(document.querySelectorAll('#daily-history-table tr:not(.details-row)'));

    let printFrame = document.getElementById('report-print-frame') || document.createElement('iframe');
    if (!printFrame.id) {
        printFrame.id = 'report-print-frame';
        printFrame.style.cssText = 'position:absolute;width:0;height:0;border:none;';
        document.body.appendChild(printFrame);
    }

    const tableContent = rows.map(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length < 4) return '';
        return `<tr><td>${cells[0].innerText}</td><td>${cells[1].innerText}</td><td>${cells[2].innerText}</td><td>${cells[3].innerText}</td></tr>`;
    }).join('');

    const html = `
        <html>
        <head>
            <title>Отчет за смену ${date}</title>
            <style>
                body { font-family: sans-serif; padding: 20px; }
                table { width: 100%; border-collapse: collapse; margin-top: 20px; }
                th, td { border: 1px solid #000; padding: 8px; text-align: left; }
                .header { text-align: center; margin-bottom: 30px; }
            </style>
        </head>
        <body>
            <div class="header">
                <h2>СВОДНЫЙ ОТЧЕТ ПО ПРОИЗВОДСТВУ</h2>
                <p>Дата: <b>${date}</b> | Старший смены: <b>${shiftName}</b></p>
            </div>
            <table>
                <thead><tr><th>№ Партии</th><th>Продукция</th><th>Объем</th><th>Себест. сырья</th></tr></thead>
                <tbody>${tableContent}</tbody>
                <tfoot style="font-weight:bold;">
                    <tr>
                        <td colspan="2" style="text-align:right">ИТОГО:</td>
                        <td>${document.getElementById('prod-total-volume').innerText}</td>
                        <td>${document.getElementById('prod-total-cost').innerText}</td>
                    </tr>
                </tfoot>
            </table>
        </body>
        </html>
    `;

    const doc = printFrame.contentWindow.document;
    doc.open(); doc.write(html); doc.close();
    setTimeout(() => { printFrame.contentWindow.focus(); printFrame.contentWindow.print(); }, 500);
};

// ==========================================
// === ДАШБОРД: СВОДНЫЙ ПЛАН ПРОИЗВОДСТВА ===
// ==========================================
window.openMrpDashboard = async function () {
    try {
        UI.toast('Загрузка сводного плана...', 'info');
        const res = await fetch('/api/production/mrp-summary');
        if (!res.ok) throw new Error('Ошибка сервера');
        const data = await res.json();

        // 1. Генерируем левую таблицу: План производства (Что отлить)
        let planHtml = data.productionPlan.map((p, idx) => `
            <tr style="border-bottom: 1px solid var(--border);">
                <td style="padding: 10px;"><b>${idx + 1}. ${escapeHTML(p.item_name)}</b></td>
                <td style="padding: 10px; text-align: right; color: var(--primary); font-weight: bold; font-size: 14px;">
                    ${p.total_needed_qty} <span style="font-size: 11px; color: var(--text-muted);">${p.unit}</span>
                </td>
            </tr>
        `).join('');

        if (!planHtml) {
            planHtml = '<tr><td colspan="2" style="text-align: center; padding: 20px; color: var(--text-muted);">🎉 Нет активных задач в производство. Всё сделано!</td></tr>';
        }

        // 2. Генерируем правую таблицу: Потребность в сырье
        let deficitHtml = data.deficitReport.map(m => {
            const shortage = parseFloat(m.shortage);
            // Если есть дефицит — подсвечиваем красным, если хватает — зеленым
            const bgColor = shortage > 0 ? 'var(--danger-bg)' : 'var(--success-bg)';
            const statusColor = shortage > 0 ? 'var(--danger)' : 'var(--success)';
            const icon = shortage > 0 ? '⚠️' : '✅';
            const statusText = shortage > 0 ? `-${m.shortage}` : 'Хватает';

            return `
                <tr style="border-bottom: 1px solid var(--border); background: ${bgColor};">
                    <td style="padding: 10px;">${icon} <b>${escapeHTML(m.name)}</b></td>
                    <td style="padding: 10px; text-align: center; font-weight: bold;">${m.needed}</td>
                    <td style="padding: 10px; text-align: center; color: var(--text-muted);">${m.stock}</td>
                    <td style="padding: 10px; text-align: center; color: ${statusColor}; font-weight: bold;">${statusText}</td>
                </tr>
            `;
        }).join('');

        if (!deficitHtml) {
            deficitHtml = '<tr><td colspan="4" style="text-align: center; padding: 20px; color: var(--text-muted);">Сырье не требуется</td></tr>';
        }

        // 3. Собираем всё в большое модальное окно
        const html = `
        <style>.modal-content { max-width: 1000px !important; width: 95% !important; }</style>
        
        <div style="padding: 10px; display: grid; grid-template-columns: repeat(auto-fit, minmax(400px, 1fr)); gap: 20px; align-items: stretch;">
            
            <div class="card flex-column" style="margin-bottom: 0; padding: 0; overflow: hidden; border: 1px solid var(--border);">
                <div style="background: var(--surface-alt); padding: 12px 15px; border-bottom: 2px solid var(--info);">
                    <h4 style="margin: 0; color: var(--text-main); display: flex; justify-content: space-between; align-items: center;">
                        <span>🏭 Нужно произвести</span>
                        <span style="background: var(--info); color: white; padding: 3px 10px; border-radius: 12px; font-size: 11px;">По всем заказам</span>
                    </h4>
                </div>
                <div style="flex-grow: 1;">
                    <table style="width: 100%; font-size: 13px; border-collapse: collapse;">
                        <tbody>${planHtml}</tbody>
                    </table>
                </div>
            </div>

            <div class="card flex-column" style="margin-bottom: 0; padding: 0; overflow: hidden; border: 1px solid var(--border);">
                <div style="background: var(--surface-alt); padding: 12px 15px; border-bottom: 2px solid var(--info);">
                    <h4 style="margin: 0; color: var(--text-main); display: flex; justify-content: space-between; align-items: center;">
                        <span>🧱 Потребность в сырье</span>
                        <span style="background: var(--info); color: white; padding: 3px 10px; border-radius: 12px; font-size: 11px;">Склад №1</span>
                    </h4>
                </div>
                <div style="flex-grow: 1;">
                    <table style="width: 100%; font-size: 13px; border-collapse: collapse;">
                        <thead style="background: var(--surface-alt); color: var(--text-muted); font-size: 11px; text-transform: uppercase;">
                            <tr style="text-align: left;">
                                <th style="padding: 10px; border-bottom: 1px solid var(--border);">Материал</th>
                                <th style="padding: 10px; text-align: center; border-bottom: 1px solid var(--border);" title="Сколько всего нужно на производство">План</th>
                                <th style="padding: 10px; text-align: center; border-bottom: 1px solid var(--border);" title="Реальный остаток на складе сырья">Остаток</th>
                                <th style="padding: 10px; text-align: center; border-bottom: 1px solid var(--border);">Статус</th>
                            </tr>
                        </thead>
                        <tbody>${deficitHtml}</tbody>
                    </table>
                </div>
            </div>

        </div>
    `;

        UI.showModal('📋 Сводное задание на производство (MRP)', html, `
            <button class="btn btn-outline" onclick="UI.closeModal()">Закрыть</button>
            <button class="btn btn-blue" onclick="window.print()">🖨️ Печать задания</button>
        `);

    } catch (e) {
        console.error(e);
        UI.toast('Ошибка загрузки плана', 'error');
    }
};

// ==========================================
// ГЛОБАЛЬНЫЙ ПОИСК И СОРТИРОВКА ПРОИЗВОДСТВА
// ==========================================

window.handleProductionSearch = function () {
    const query = document.getElementById('prod-search-input').value.trim();
    const dateEl = document.getElementById('prod-date-filter');

    clearTimeout(prodSearchTimer);

    // Если поиск пуст — возвращаемся к режиму календаря
    if (query.length === 0) {
        document.getElementById('th-prod-date').style.display = 'none';
        if (typeof loadDailyHistory === 'function') loadDailyHistory();
        return;
    }

    if (query.length < 2) return;

    // Задержка (Debounce) 400мс
    prodSearchTimer = setTimeout(async () => {
        const tbody = document.getElementById('daily-history-table');
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">🔍 Ищем по всей базе...</td></tr>';

        try {
            const res = await fetch(`/api/production/search?q=${encodeURIComponent(query)}`);
            currentProdSearchResults = await res.json();

            // Показываем колонку Дата, так как результаты будут за разные дни
            document.getElementById('th-prod-date').style.display = 'table-cell';
            renderProductionSearchResults();
        } catch (e) {
            console.error(e);
            tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--danger);">Ошибка поиска</td></tr>';
        }
    }, 400);
};

window.renderProductionSearchResults = function () {
    const tbody = document.getElementById('daily-history-table');

    if (currentProdSearchResults.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">Ничего не найдено.</td></tr>';
        return;
    }

    tbody.innerHTML = currentProdSearchResults.map(b => {
        const isDraft = (b.status === 'draft');
        const draftBadge = isDraft ? '<span style="background: var(--warning); color: #000; padding: 2px 8px; border-radius: 10px; font-size: 10px; font-weight: bold; margin-left: 6px;">📝 Черновик</span>' : '';
        const rowStyle = isDraft ? 'border-left: 3px solid var(--warning);' : '';
        const costDisplay = isDraft ? '—' : `${parseFloat(b.mat_cost_total).toFixed(2)} ₽`;
        const safeDate = b.production_date.split('-').reverse().join('.');

        return `
        <tr id="row-${b.id}" style="cursor: pointer; ${rowStyle}">
            <td onclick="toggleBatchDetails(${b.id})"><strong>${b.batch_number}</strong>${draftBadge}</td>
            <td onclick="toggleBatchDetails(${b.id})">${b.product_name}</td>
            <td style="color: var(--primary); font-weight: bold;">${safeDate}</td>
            <td onclick="toggleBatchDetails(${b.id})" style="text-align: right;">${parseFloat(b.planned_quantity).toFixed(2)} <small>${b.unit || ''}</small></td>
            <td onclick="toggleBatchDetails(${b.id})" style="text-align: right;">${costDisplay}</td>
            <td style="text-align: right; white-space: nowrap;">
                <button class="btn btn-outline" style="color: var(--primary); padding: 5px 10px; margin-right: 5px;" 
                        onclick="event.stopPropagation(); window.open('/print/passport?batchId=${b.id}', '_blank')">🖨️</button>
                <button class="btn btn-outline" style="color: var(--danger); padding: 5px 10px;" 
                        onclick="event.stopPropagation(); deleteBatch(${b.id}, '${b.batch_number}')">❌</button>
            </td>
        </tr>`;
    }).join('');
};

window.sortProductionResults = function (field) {
    const query = document.getElementById('prod-search-input').value.trim();
    if (!query || currentProdSearchResults.length === 0) return;

    if (currentProdSort.field === field) {
        currentProdSort.asc = !currentProdSort.asc;
    } else {
        currentProdSort.field = field;
        currentProdSort.asc = true;
    }

    currentProdSearchResults.sort((a, b) => {
        let valA = a[field];
        let valB = b[field];

        if (['planned_quantity', 'mat_cost_total'].includes(field)) {
            valA = parseFloat(valA) || 0;
            valB = parseFloat(valB) || 0;
        } else {
            valA = (valA || '').toString().toLowerCase();
            valB = (valB || '').toString().toLowerCase();
        }

        if (valA < valB) return currentProdSort.asc ? -1 : 1;
        if (valA > valB) return currentProdSort.asc ? 1 : -1;
        return 0;
    });

    renderProductionSearchResults();
};