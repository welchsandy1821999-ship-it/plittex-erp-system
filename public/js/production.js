;(function() {
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
        window.activeProductionDates = await API.get('/api/production/active-dates');

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
                            dayElem.classList.add('prod-cal-active');
                            dayElem.innerHTML += '<span class="prod-cal-dot"></span>';
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
        const matData = await API.get('/api/items?item_type=material&limit=500');
        allMaterialsForMix = matData.data || [];

        // 3. ЗАГРУЖАЕМ ШАБЛОНЫ
        const dbTemplates = await API.get('/api/mix-templates');

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
            await API.post('/api/mix-templates', window.currentMixTemplates);
        }

        // 4. ЗАГРУЖАЕМ ПРОДУКЦИЮ
        allProductsList = await API.get('/api/products');
        populateCategories();

        // 5. ЗАГРУЖАЕМ БРИГАДИРОВ
        const empData = await API.get('/api/employees');
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
            score: function(search) {
                const query = search.toLowerCase();
                const queryCondensed = query.replace(/[\.\s-]/g, '');
                const tokens = query.split(/\s+/).filter(Boolean);
                
                return function(item) {
                    const text = (item.text || '').toLowerCase();
                    const textCondensed = text.replace(/[\.\s-]/g, '');
                    
                    let multiTargetMatch = true;
                    for (let token of tokens) {
                        let tokenCondensed = token.replace(/[\.\s-]/g, '');
                        if (!text.includes(token) && (!tokenCondensed || !textCondensed.includes(tokenCondensed))) {
                            multiTargetMatch = false;
                            break;
                        }
                    }

                    if (!multiTargetMatch) {
                        if (queryCondensed.length < 2 || !textCondensed.includes(queryCondensed)) {
                            return 0;
                        }
                    }
                    
                    let baseScore = 100 / (text.length + 1); 
                    
                    if (queryCondensed.length >= 2 && textCondensed.includes(queryCondensed)) {
                        baseScore += 1000;
                    }
                    
                    return baseScore; 
                };
            },
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

    // Сброс цифр при смене партии
    document.getElementById('prod-cycles-input').value = '';

    // Берём данные из allProductsList
    const product = allProductsList.find(p => p.id == productId);

    // Архитектурное SSoT: Берем готовые шаблоны из БД, без текстового "угадывания"
    const mainKey = product?.mix_main_tpl || 'main_tile_60';
    const faceKey = product?.mix_face_tpl || 'face_smooth_grey';

    const mainSel = document.getElementById('main-template-select');
    const faceSel = document.getElementById('face-template-select');

    if (mainSel.tomselect) mainSel.tomselect.setValue(mainKey, true);
    else mainSel.value = mainKey;

    if (faceSel.tomselect) faceSel.tomselect.setValue(faceKey, true);
    else faceSel.value = faceKey;

    renderSelectedTemplates();

    // 3. Загружаем Рецепт для расчета подсказки по замесам
    try {
        currentSelectedProductRecipe = await API.get(`/api/recipes/${productId}`);
    } catch (e) { console.error(e); }

    calculateMixesPreview();
};

// === ОТРИСОВКА ВЫБРАННЫХ ШАБЛОНОВ (ТЕПЕРЬ ОНИ РЕДАКТИРУЕМЫЕ) ===
window.renderSelectedTemplates = function () {
    const mainKey = document.getElementById('main-template-select').value;
    const faceKey = document.getElementById('face-template-select').value;

    const drawEditableList = (templateList, containerId, prefix) => {
        let html = '<div class="prod-tpl-hint">На 1 замес (можно изменить сейчас):</div>';

        html += (templateList || []).map(m => `
            <div class="prod-tpl-row">
                <span class="prod-tpl-name">${Utils.escapeHtml(m.name)}</span>
                <div class="flex-row gap-5 align-center">
                    <input type="number" class="input-modern ${prefix}-qty prod-tpl-input" data-id="${m.id}" data-name="${m.name}" data-unit="${m.unit}" value="${m.qty}" onfocus="this.select()" title="Изменить для этого конкретного замеса">
                    <span class="prod-tpl-unit">${m.unit}</span>
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

        const mainTpl = window.currentMixTemplates[mainKey] || [];
        const faceTpl = window.currentMixTemplates[faceKey] || [];

        const mainTplWeight = (window.currentMixTemplates[mainKey] || []).reduce((sum, m) => sum + parseFloat(m.qty), 0) || 1;
        const faceTplWeight = (window.currentMixTemplates[faceKey] || []).reduce((sum, m) => sum + parseFloat(m.qty), 0) || 0;

        // --- АЛГОРИТМ ПО МАРКЕРНОМУ СЫРЬЮ ---
        
        // 1. Основной слой (Маркер: Мурасан 16)
        const recipeMur16 = currentSelectedProductRecipe.find(r => (r.material_name || '').toLowerCase().includes('мурасан 16'));
        const tplMur16 = mainTpl.find(m => (m.name || '').toLowerCase().includes('мурасан 16'));
        let suggestedMain;
        
        if (recipeMur16 && tplMur16 && parseFloat(tplMur16.qty) > 0) {
            const requiredMur16 = parseFloat(recipeMur16.quantity_per_unit) * volume;
            suggestedMain = (requiredMur16 / parseFloat(tplMur16.qty)).toFixed(1);
        } else {
            // Fallback: пропорциональное деление общего веса
            let mainRatio = faceTplWeight > 0 ? (mainTplWeight / (mainTplWeight + faceTplWeight)) : 1;
            suggestedMain = ((totalRecipeWeight * mainRatio) / mainTplWeight).toFixed(1);
        }

        // 2. Лицевой слой (Маркер: Мурасан 17)
        let suggestedFace = '0';
        if (faceTplWeight > 0) {
            const recipeMur17 = currentSelectedProductRecipe.find(r => (r.material_name || '').toLowerCase().includes('мурасан 17'));
            const tplMur17 = faceTpl.find(m => (m.name || '').toLowerCase().includes('мурасан 17'));

            if (recipeMur17 && tplMur17 && parseFloat(tplMur17.qty) > 0) {
                const requiredMur17 = parseFloat(recipeMur17.quantity_per_unit) * volume;
                suggestedFace = (requiredMur17 / parseFloat(tplMur17.qty)).toFixed(1);
            } else {
                // Fallback: пропорциональное деление общего веса
                let faceRatio = faceTplWeight / (mainTplWeight + faceTplWeight);
                suggestedFace = ((totalRecipeWeight * faceRatio) / faceTplWeight).toFixed(1);
            }
        }

        // 4. Подставляем подсказку ТОЛЬКО если поля пустые
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
        addBtn.classList.add('opacity-60');
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
        console.log('[DRAFT] Отправка черновика, date =', shiftDateStr, 'payload:', JSON.stringify(draftPayload));
        await API.post('/api/production', draftPayload);
        if (true) {
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
        }
    } catch (e) { console.error(e); } finally {
        // 🛡️ РАЗБЛОКИРОВКА КНОПКИ
        if (addBtn) {
            addBtn.disabled = false;
            addBtn.innerText = origBtnText;
            addBtn.classList.remove('opacity-60', 'opacity-50');
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
        container.innerHTML = `<div class="prod-session-empty">Смена пуста. Выберите продукцию выше.</div>`;
        return;
    }

    container.innerHTML = sessionProducts.map((p, i) => `
        <div class="prod-session-item">
            <div>
                <b class="text-primary">${Utils.escapeHtml(p.name)}</b><br>
                <small class="text-muted">${p.fromServer ? '<em>📝 Сохранён на сервере</em>' : `Циклов: <b class="text-main">${p.cycles}</b> | Итого: <b class="text-main">${p.quantity.toFixed(2)} ${p.unit || ''}</b>`}</small><br>
                <small class="text-muted">${p.fromServer ? '' : `Замесы: Осн (${p.mainCount || 0}), Лиц (${p.faceCount || 0})`}</small>
            </div>
            <button class="btn text-danger p-5" onclick="removeSessionProduct(${i})">🗑️</button>
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
    // if (!shiftName) return UI.toast('Выберите бригадира!', 'warning');
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
        b.classList.add('opacity-50');
        b.classList.add('no-pointer');
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
    // 🧹 Очищаем блок ошибок от предыдущей попытки
    const errBox = document.getElementById('shift-errors');
    if (errBox) { errBox.classList.add('hidden'); errBox.innerHTML = ''; }

    UI.toast('⏳ Фиксация смены: проверка остатков и списание...', 'info');
    console.log('[FIXATE] Payload:', JSON.stringify(payload));

    try {
        // 🆕 Вызываем роут фиксации вместо создания партий (они уже есть как черновики)
        await API.post('/api/production/fixate-shift', payload);

        UI.toast('✅ Смена зафиксирована! Сырье списано, продукция на сушилке.', 'success');
        if (errBox) { errBox.classList.add('hidden'); errBox.innerHTML = ''; }
        sessionProducts = [];
        renderSessionProducts();
        loadDailyHistory();
        updateCalendarMarks();
    } catch (e) {
        console.error('[FIXATE ERROR]', e);
        console.log('[DEBUG CATCH] e.details =', e.details, '| e.body =', e.body, '| e.message =', e.message);

        // Берём details из ТРЁХ возможных мест (по приоритету)
        const details = e.details || (e.body && e.body.details) || null;
        const errorTitle = (e.body && e.body.error) || e.message || 'Ошибка фиксации';

        if (errBox) {
            if (details) {
                // details может быть строкой или массивом
                const detailsText = typeof details === 'string' 
                    ? details 
                    : Array.isArray(details) 
                        ? details.join('\n') 
                        : JSON.stringify(details);
                const detailsHtml = detailsText.replace(/\n/g, '<br>');
                errBox.innerHTML = `<b>⛔ ${Utils.escapeHtml(errorTitle)}:</b><br><br>${detailsHtml}`;
            } else {
                errBox.innerHTML = `<b>⛔ ${Utils.escapeHtml(errorTitle)}</b>`;
            }
            errBox.classList.remove('hidden');
            errBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    } finally {
        isSubmittingProduction = false;
        buttonsToDisable.forEach(b => {
            b.innerText = b.dataset.origText || 'Закрыть смену';
            b.disabled = false;
            b.classList.remove('opacity-60', 'opacity-50');
            b.classList.remove('no-pointer');
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
            <tr class="prod-tpl-edit-tr">
                <td class="prod-tpl-edit-th">
                    <select class="input-modern tpl-mat-select w-100 m-0" data-index="${index}">
                        ${rowMatOptions}
                    </select>
                </td>
                <td class="p-10 w-140" >
                    <input type="number" step="any" class="input-modern tpl-qty-input text-center font-bold m-0 w-100" data-index="${index}" value="${mat.qty}" onfocus="this.select()">
                </td>
                <td class="text-right p-10 w-60" >
                    <button class="btn btn-red p-5 h-auto"  onclick="removeMaterialFromTemplate('${templateKey}', ${index})" title="Удалить строку">✕</button>
                </td>
            </tr>
        `;
    }).join('');

    const html = `
        <div class="mb-20">
            <table class="w-100 prod-table-modern mb-20">
                <thead>
                    <tr>
                        <th class="prod-tpl-edit-th input-left-rounded" >Сырье (можно заменить)</th>
                        <th class="prod-tpl-edit-th text-center">Норма (кг)</th>
                        <th class="prod-tpl-edit-th text-right input-right-rounded" >Удалить</th>
                    </tr>
                </thead>
                <tbody>
                    ${tableRows || '<tr><td colspan="3" class="text-center text-muted p-20 italic" >В шаблоне пока нет сырья</td></tr>'}
                </tbody>
            </table>

            <div class="prod-tpl-edit-add-wrap">
                <label class="text-primary font-bold font-14 mb-10 block" >➕ Добавить новое сырье в шаблон:</label>
                <div class="flex-row gap-10 align-stretch">
                    <select id="new-tpl-mat" class="input-modern flex-grow-1 m-0">${matOptionsGlobal}</select>
                    <input type="number" step="any" id="new-tpl-qty" class="input-modern text-center font-bold m-0 w-120" placeholder="0.00"  onfocus="this.select()">
                    <button class="btn btn-green shadow-success font-bold p-10" onclick="addMaterialToTemplate('${templateKey}')">Добавить</button>
                </div>
            </div>
        </div>
    `;

    UI.showModal(title, html, `<button class="btn btn-blue w-100 btn-lg font-16 font-bold"  onclick="saveMixTemplate('${templateKey}')">💾 СОХРАНИТЬ ШАБЛОН</button>`);

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
    // 🛡️ Фильтр активной модалки
    const activeModal = document.querySelector('.modal-overlay:not([style*="display: none"])') || document;
    
    // Формируем ПОЛНОСТЬЮ НОВЫЙ МАССИВ, читая DOM сверху вниз
    const rows = activeModal.querySelectorAll('tbody tr');
    let newTemplateArray = [];

    rows.forEach(tr => {
        const selectEl = tr.querySelector('.tpl-mat-select');
        const qtyInput = tr.querySelector('.tpl-qty-input');
        
        // Пропускаем строки "В шаблоне пока нет сырья"
        if (!selectEl || !qtyInput) return;

        const qty = parseFloat(qtyInput.value) || 0;
        let selectedId = selectEl.tomselect ? selectEl.tomselect.getValue() : selectEl.value;

        if (selectedId) {
            const trueMaterial = allMaterialsForMix.find(m => String(m.id) === String(selectedId));
            if (trueMaterial) {
                newTemplateArray.push({
                    id: selectedId,
                    name: trueMaterial.name,
                    qty: qty,
                    unit: 'кг'
                });
            }
        }
    });

    // Перезаписываем глобальный массив полностью очищенным и свежим
    window.currentMixTemplates[templateKey] = newTemplateArray;

    console.log(`[DEBUG] Отправляем сохранение JSON шаблона:`, templateKey);
    console.log(`[DEBUG] PAYLOAD:`, newTemplateArray);

    try {
        await API.post('/api/mix-templates', window.currentMixTemplates);
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
        const data = await API.get(`/api/production/history?date=${date}`);

        if (!Array.isArray(data)) {
            tbody.innerHTML = `<tr><td colspan="5" class="text-center text-danger">Ошибка: ${Utils.escapeHtml(data.error || 'нет данных')}</td></tr>`;
            return;
        }

        // Переменные для итогов 
        let dayTotalVolume = 0;
        let dayTotalCost = 0;

        // Восстановление sessionProducts из черновиков 
        sessionProducts = [];
        for (let b of data.filter(i => i.status === 'draft')) {
            const materials = await API.get(`/api/production/batch/${b.id}/materials`);
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
            if (tfoot) tfoot.classList.add('hidden');
            return;
        }

        tbody.innerHTML = data.map(b => {
            const isDraft = (b.status === 'draft');
            const cost = parseFloat(b.mat_cost_total) || 0;
            const volume = parseFloat(b.planned_quantity) || 0;

            // Считаем итоги (только для зафиксированных партий, или всех - на ваш выбор)
            dayTotalVolume += volume;
            dayTotalCost += cost;

            const draftBadge = isDraft ? '<span class="prod-badge-draft">📝 Черновик</span>' : '';
            const costDisplay = isDraft ? '<span class="text-muted italic">—</span>' : `${cost.toFixed(2)} ₽`;

            return `
            <tr id="row-${b.id}" class="${isDraft ? 'prod-row-draft' : ''}">
                <td class="w-15" onclick="toggleBatchDetails(${b.id})"><strong>${Utils.escapeHtml(b.batch_number)}</strong>${draftBadge}</td>
                <td class="w-30p" onclick="toggleBatchDetails(${b.id})">${Utils.escapeHtml(b.product_name)}</td>
                <td class="w-13p text-right" onclick="toggleBatchDetails(${b.id})">${volume.toFixed(2)}</td>
                <td class="w-15p text-right" onclick="toggleBatchDetails(${b.id})">${costDisplay}</td>
                <td class="w-15 text-right whitespace-nowrap">
                    <button class="btn btn-outline text-primary p-5 mr-5" 
                            onclick="event.stopPropagation(); window.open('/print/passport?batchId=${b.id}&token=' + localStorage.getItem('token'), '_blank')">🖨️</button>
                    ${isDraft ? `<button class="btn btn-outline p-5 text-warning mr-5" 
                                         onclick="event.stopPropagation(); editDraftBatch(${b.id})">✏️</button>` : ''}
                    <button class="btn btn-outline text-danger p-5" 
                            onclick="event.stopPropagation(); deleteBatch(${b.id}, '${b.batch_number}')">❌</button>
                </td>
            </tr>`;
        }).join('');

        // Выводим итоги 
        if (tfoot && data.length > 0) {
            tfoot.classList.add('table-footer'); tfoot.classList.remove('hidden');
            document.getElementById('prod-total-volume').innerText = dayTotalVolume.toFixed(2);
            document.getElementById('prod-total-cost').innerText = Utils.formatMoney(dayTotalCost);
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
        const batchInfo = await API.get(`/api/production/batch/${batchId}/info`);

        // 2. Получаем материалы
        const materials = await API.get(`/api/production/batch/${batchId}/materials`);

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
<td colspan="6" class="prod-details-td">
    <div class="prod-details-wrap">
        
        <div class="prod-details-header">
            <div>
                <h3 class="prod-details-title">📊 Экономика и себестоимость партии #${batchId}</h3>
                <p class="prod-details-vol">Общий объем выпуска: <b class="text-main">${plannedQty.toFixed(2)} ${batchInfo.unit || 'ед.'}</b></p>
            </div>
            <div class="text-right">
                <div class="prod-details-cost-label">Полная себестоимость 1 ед.</div>
                <div class="prod-details-cost-val">${Utils.formatMoney(unitTotalCost)}</div>
            </div>
        </div>

        <div class="prod-details-grid">
            
            <div class="prod-cost-cards">
                <div class="prod-cost-card prod-cost-card-mat">
                    <div class="prod-cost-header">
                        <span class="prod-cost-title">📦 Сырье и материалы</span>
                        <b class="prod-cost-val">${Utils.formatMoney(matCost)}</b>
                    </div>
                    <div class="prod-cost-bar-bg">
                        <div class="prod-cost-bar-fill" style="width: ${(matCost / totalCost * 100).toFixed(0)}%;"></div>
                    </div>
                    <div class="prod-cost-unit-mat">
                        <span class="text-muted">На 1 единицу:</span>
                        <b class="text-success">${Utils.formatMoney(unitMatCost)}</b>
                    </div>
                </div>

                <div class="prod-cost-card prod-cost-card-mach">
                    <div class="prod-cost-header">
                        <span class="prod-cost-title">⚙️ Аморт. станка</span>
                        <b class="prod-cost-val">${Utils.formatMoney(machineAmortCost)}</b>
                    </div>
                    <div class="prod-cost-unit-mach">
                        <span class="text-muted">На 1 единицу:</span>
                        <b class="text-warning">${Utils.formatMoney(unitMachineAmortCost)}</b>
                    </div>
                </div>

                <div class="prod-cost-card prod-cost-card-mold">
                    <div class="prod-cost-header">
                        <span class="prod-cost-title">🧩 Аморт. матрицы</span>
                        <b class="prod-cost-val">${Utils.formatMoney(moldAmortCost)}</b>
                    </div>
                    <div class="prod-cost-unit-mold">
                        <span class="text-muted">На 1 единицу:</span>
                        <b class="text-primary">${Utils.formatMoney(unitMoldAmortCost)}</b>
                    </div>
                </div>

                <div class="prod-cost-card bg-surface">
                    <div class="prod-cost-header">
                        <span class="prod-cost-title font-bold text-main">💰 ИТОГО (Себестоимость)</span>
                        <b class="prod-cost-val font-bold text-main font-18">${Utils.formatMoney(totalCost)}</b>
                    </div>
                    <div class="prod-cost-unit-mold mt-10">
                        <span class="text-muted">Полная себестоимость 1 ед:</span>
                        <b class="text-main font-bold font-16">${Utils.formatMoney(unitTotalCost)}</b>
                    </div>
                </div>
            </div>

            <div class="prod-mat-table-wrap">
                <div class="prod-mat-header">
                    <h4 class="prod-mat-title">📋 Фактическое списание сырья</h4>
                    <span class="prod-mat-badge">Компонентов: ${materials.length}</span>
                </div>
                
                <table class="prod-table-modern">
                    <thead class="prod-th-styled">
                        <tr>
                            <th class="prod-th-styled border-bottom-dashed" >МАТЕРИАЛ</th>
                            <th class="prod-th-styled prod-th-right border-bottom-dashed" >ОБЩИЙ РАСХОД</th>
                            <th class="prod-th-styled prod-th-right border-bottom-dashed" >НА 1 ЕД.</th>
                            <th class="prod-th-styled prod-th-right border-bottom-dashed" >ЦЕНА/КГ</th>
                            <th class="prod-th-styled prod-th-right border-bottom-dashed" >СУММА (1 ЕД)</th>
                            <th class="prod-th-styled prod-th-right border-bottom-dashed" >СУММА (ПАРТИЯ)</th>
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
                            <tr class="prod-tr-styled">
                                <td class="prod-td-styled prod-mat-name">${Utils.escapeHtml(m.name)}</td>
                                <td class="prod-td-styled prod-td-right">${qBatch.toFixed(2)} <small class="text-muted">${m.unit}</small></td>
                                <td class="prod-td-styled prod-td-right text-primary">${qUnit.toFixed(3)} <small>${m.unit}</small></td>
                                <td class="prod-td-styled prod-td-right text-muted font-12">${pricePerKg.toFixed(2)}</td>
                                <td class="prod-td-styled prod-td-right font-bold text-muted">${costUnit.toFixed(2)} ₽</td>
                                <td class="prod-td-styled prod-td-right font-bold text-danger">${Utils.formatMoney(costBatch)}</td>
                            </tr>`;
        }).join('')}
                    </tbody>
                    <tfoot class="prod-tfoot-styled">
                        <tr>
                            <td class="prod-tfoot-td">ИТОГО ПО СЫРЬЮ:</td>
                            <td class="prod-tfoot-td prod-td-right">${totalWeightBatch.toFixed(2)} <small>кг</small></td>
                            <td class="prod-tfoot-td prod-td-right text-primary">${totalWeightUnit.toFixed(3)} <small>кг</small></td>
                            <td class="prod-tfoot-td"></td>
                            <td class="prod-tfoot-td prod-td-right">${unitMatCost.toFixed(2)} ₽</td>
                            <td class="prod-tfoot-td prod-td-right text-danger font-16">${Utils.formatMoney(matCost)}</td>
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
    const html = `<div class="text-center p-15 font-15">Точно отменить формовку <b>${Utils.escapeHtml(batchNumber)}</b> и вернуть списанное сырье на склад?</div>`;

    UI.showModal('⚠️ Отмена формовки', html, `
        <button class="btn btn-outline" onclick="UI.closeModal()">Закрыть</button>
        <button class="btn btn-red" onclick="executeDeleteBatch(${id})">🗑️ Да, отменить</button>
    `);
};

window.executeDeleteBatch = async function (id) {
    UI.closeModal();
    try {
        await API.delete(`/api/production/batch/${id}`);
        if (true) {
            UI.toast('🗑️ Формовка отменена, сырье возвращено', 'success');

            // Проверяем, активен ли поиск
            const searchInput = document.getElementById('prod-search-input');
            if (searchInput && searchInput.value.trim().length > 0) {
                handleProductionSearch(); // Обновляем результаты поиска
            } else {
                loadDailyHistory(); // Обновляем календарный день
                updateCalendarMarks();
            }
        }
    } catch (e) { console.error(e); }
};

// 
window.editDraftBatch = async function (batchId) {
    UI.toast('⏳ Загрузка черновика...', 'info');
    try {
        const info = await API.get(`/api/production/batch/${batchId}/info`);

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
        printFrame.classList.add('hidden-print-frame');
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
                @media print {
                    @page { margin: 0; }
                    body { margin: 1.5cm; }
                }
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
                <tfoot class="font-bold">
                    <tr>
                        <td colspan="2" class="text-right">ИТОГО:</td>
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
window.openMrpDashboard = async function (filterProductId = null) {
    try {
        UI.toast('Загрузка сводного плана...', 'info');
        const url = filterProductId ? `/api/production/mrp-summary?product_id=${filterProductId}` : '/api/production/mrp-summary';
        const data = await API.get(url);

        // 1. Генерируем таблицу заказов (сверху)
        let planHtml = data.productionPlan.map((p, idx) => {
            const isSelected = (filterProductId === p.item_id);
            const rowClass = isSelected ? 'bg-surface-alt font-bold text-primary' : '';
            return `
            <tr class="mrp-plan-row cursor-pointer ${rowClass}" onclick="openMrpDashboard(${isSelected ? 'null' : p.item_id})" title="Кликните для фильтрации сырья">
                <td class="p-10">
                    <span class="text-muted mr-5">${idx + 1}.</span> 
                    <span>${Utils.escapeHtml(p.item_name)}</span>
                </td>
                <td class="p-10 text-right">
                    ${p.total_needed_qty} <span class="font-11 text-muted">${p.unit}</span>
                </td>
            </tr>
        `}).join('');

        if (!planHtml) {
            planHtml = '<tr><td colspan="2" class="text-center p-20 text-muted">🎉 Нет активных задач в производство. Всё сделано!</td></tr>';
        }

        // 2. Генерируем нижнюю таблицу: Потребность в сырье
        let deficitHtml = data.deficitReport.map(m => {
            const shortage = parseFloat(m.shortage);
            const icon = shortage > 0 ? '⚠️' : '✅';
            const statusText = shortage > 0 ? `-${m.shortage}` : 'Хватает';

            return `
                <tr class="mrp-deficit-row" style="background: var(--${shortage > 0 ? 'danger-bg' : 'success-bg'});">
                    <td class="p-10 font-bold">${icon} ${Utils.escapeHtml(m.name)}</td>
                    <td class="p-10 text-center font-bold">${m.needed}</td>
                    <td class="p-10 text-center text-muted">${m.stock}</td>
                    <td class="p-10 text-center font-bold" style="color: var(--${shortage > 0 ? 'danger' : 'success'});">${statusText}</td>
                </tr>
            `;
        }).join('');

        if (!deficitHtml) {
            deficitHtml = '<tr><td colspan="4" class="text-center p-20 text-muted">Сырье не требуется</td></tr>';
        }

        // 3. Собираем всё в большое модальное окно (ВЕРТИКАЛЬНАЯ ВЕРСТКА)
        const filterBadge = filterProductId ? '<span class="prod-badge-draft text-warning bg-warning ml-10">Фильтр по 1 изделию (кликните чтобы сбросить)</span>' : '<span class="mrp-title-badge">По всем заказам</span>';

        const html = `
        <style>.modal-content { max-width: 800px !important; width: 95% !important; }</style>
        
        <div class="p-10 flex-col gap-20">
            
            <div class="card flex-column p-0 overflow-hidden">
                <div class="mrp-card-header bg-surface-alt p-15 border-bottom">
                    <h4 class="m-0 flex-row align-center font-15">
                        <span>🏭 Нужно произвести</span>
                        <div class="ml-10 font-12 text-muted italic font-normal">(Кликните по товару, чтобы рассчитать сырье только для него)</div>
                    </h4>
                </div>
                <div class="max-h-250 overflow-y-auto">
                    <table class="w-100 font-13 prod-table-modern">
                        <tbody>${planHtml}</tbody>
                    </table>
                </div>
            </div>

            <div class="card flex-column p-0 overflow-hidden mt-10">
                <div class="mrp-card-header bg-surface-alt p-15 border-bottom">
                    <h4 class="m-0 flex-between align-center font-15">
                        <span>🧱 Потребность в сырье</span>
                        ${filterBadge}
                    </h4>
                </div>
                <div class="overflow-x-auto">
                    <table class="w-100 font-13 prod-table-modern">
                        <thead class="prod-th-styled text-uppercase bg-surface">
                            <tr>
                                <th class="p-10 border-bottom text-left">Материал</th>
                                <th class="p-10 text-center border-bottom" title="Сколько всего нужно на производство">План</th>
                                <th class="p-10 text-center border-bottom" title="Реальный остаток на складе сырья">Остаток</th>
                                <th class="p-10 text-center border-bottom">Статус</th>
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
            ${filterProductId ? `<button class="btn btn-red btn-outline mr-auto" onclick="openMrpDashboard()">Сбросить фильтр</button>` : ''}
            <button class="btn btn-blue" onclick="window.printMrpDashboard()">🖨️ Печать задания</button>
        `);

    } catch (e) {
        console.error(e);
        UI.toast('Ошибка загрузки плана', 'error');
    }
};

window.printMrpDashboard = function () {
    const today = document.getElementById('prod-date-filter')?.value || new Date().toISOString().split('T')[0];
    
    // Ищем таблицы внутри модалки
    const modalContent = document.querySelector('.modal-content');
    if (!modalContent) return;

    let planHtml = "";
    const planTable = modalContent.querySelector('table:first-of-type');
    if (planTable) {
        // Убираем onclick с печати
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = planTable.outerHTML;
        tempDiv.querySelectorAll('tr').forEach(tr => tr.removeAttribute('onclick'));
        planHtml = tempDiv.innerHTML;
    }

    let deficitHtml = "";
    const deficitTable = modalContent.querySelectorAll('table')[1];
    if (deficitTable) deficitHtml = deficitTable.outerHTML;
    
    let printFrame = document.getElementById('mrp-print-frame') || document.createElement('iframe');
    if (!printFrame.id) {
        printFrame.id = 'mrp-print-frame';
        printFrame.classList.add('hidden-print-frame');
        document.body.appendChild(printFrame);
    }

    const html = `
        <html>
        <head>
            <title>MRP Задание ${today}</title>
            <style>
                @media print {
                    @page { margin: 0; }
                    body { margin: 1.5cm; }
                }
                body { font-family: sans-serif; padding: 20px; font-size: 14px; color: #000; }
                h2 { text-align: center; margin-bottom: 20px; }
                h3 { margin-top: 30px; margin-bottom: 10px; border-bottom: 2px solid #ccc; padding-bottom: 5px; }
                table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
                th, td { border: 1px solid #000; padding: 8px; text-align: left; }
                th { background-color: #f5f5f5; font-weight: bold; }
                .text-right { text-align: right; }
                .text-center { text-align: center; }
                .text-muted { color: #666; }
            </style>
        </head>
        <body>
            <h2>СВОДНОЕ ЗАДАНИЕ НА ПРОИЗВОДСТВО (MRP)</h2>
            <p>Дата формирования: <b>${today}</b></p>
            
            <h3>🏭 Нужно произвести</h3>
            ${planHtml}
            
            <h3>🧱 Потребность в сырье</h3>
            ${deficitHtml}
        </body>
        </html>
    `;

    const doc = printFrame.contentWindow.document;
    doc.open(); doc.write(html); doc.close();
    setTimeout(() => { printFrame.contentWindow.focus(); printFrame.contentWindow.print(); }, 500);
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
        document.getElementById('th-prod-date').classList.add('d-none');
        if (typeof loadDailyHistory === 'function') loadDailyHistory();
        return;
    }

    if (query.length < 2) return;

    // Задержка (Debounce) 400мс
    prodSearchTimer = setTimeout(async () => {
        const tbody = document.getElementById('daily-history-table');
        tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted">🔍 Ищем по всей базе...</td></tr>';

        try {
            currentProdSearchResults = await API.get(`/api/production/search?q=${encodeURIComponent(query)}`);

            // Показываем колонку Дата, так как результаты будут за разные дни
            document.getElementById('th-prod-date').classList.remove('d-none');
            renderProductionSearchResults();
        } catch (e) {
            console.error(e);
            tbody.innerHTML = '<tr><td colspan="6" class="text-center text-danger">Ошибка поиска</td></tr>';
        }
    }, 400);
};

window.renderProductionSearchResults = function () {
    const tbody = document.getElementById('daily-history-table');

    if (currentProdSearchResults.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted">Ничего не найдено.</td></tr>';
        return;
    }

    tbody.innerHTML = currentProdSearchResults.map(b => {
        const isDraft = (b.status === 'draft');
        const draftBadge = isDraft ? '<span class="prod-badge-draft">📝 Черновик</span>' : '';
        const rowClass = isDraft ? 'prod-row-draft' : '';
        const costDisplay = isDraft ? '—' : `${parseFloat(b.mat_cost_total).toFixed(2)} ₽`;
        const safeDate = b.production_date.split('-').reverse().join('.');

        return `
        <tr id="row-${b.id}" class="cursor-pointer ${rowClass}">
            <td onclick="toggleBatchDetails(${b.id})"><strong>${b.batch_number}</strong>${draftBadge}</td>
            <td onclick="toggleBatchDetails(${b.id})">${b.product_name}</td>
            <td class="text-primary font-bold">${safeDate}</td>
            <td onclick="toggleBatchDetails(${b.id})" class="text-right">${parseFloat(b.planned_quantity).toFixed(2)} <small>${b.unit || ''}</small></td>
            <td onclick="toggleBatchDetails(${b.id})" class="text-right">${costDisplay}</td>
            <td class="text-right whitespace-nowrap">
                <button class="btn btn-outline text-primary p-5 mr-5" 
                        onclick="event.stopPropagation(); window.open('/print/passport?batchId=${b.id}&token=' + localStorage.getItem('token'), '_blank')">🖨️</button>
                <button class="btn btn-outline text-danger p-5" 
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

    // === ГЛОБАЛЬНЫЙ ЭКСПОРТ ===
    if (typeof initProduction === 'function') window.initProduction = initProduction;
    if (typeof initStaticProductionSelects === 'function') window.initStaticProductionSelects = initStaticProductionSelects;
    if (typeof populateCategories === 'function') window.populateCategories = populateCategories;
    if (typeof renderSessionProducts === 'function') window.renderSessionProducts = renderSessionProducts;
    if (typeof loadDailyHistory === 'function') window.loadDailyHistory = loadDailyHistory;
    if (typeof toggleBatchDetails === 'function') window.toggleBatchDetails = toggleBatchDetails;
})();
