// === public/js/inventory.js ===

let allInventory = [];
let currentWarehouseFilter = 'all';
let isAuditMode = false; // Флаг режима инвентаризации
let currentSearch = '';
let currentPage = 1;
let itemsPerPage = 50;

window.handleInventorySearch = function() {
    currentSearch = (document.getElementById('inventory-search') ? document.getElementById('inventory-search').value.toLowerCase().trim() : '');
    currentPage = 1;
    renderInventoryTable();
}

window.changeItemsPerPage = function(val) {
    itemsPerPage = parseInt(val);
    currentPage = 1;
    renderInventoryTable();
}

window.goToPage = function(page) {
    currentPage = page;
    renderInventoryTable();
}

function loadTable() {
    API.get('/api/inventory')
        .then(data => {
            allInventory = data;
            renderInventoryTable();
        })
        .catch(err => {
            console.error('Failed to load table:', err);
        });
}

function applyWarehouseFilter(id, btn) {
    // Если переключили склад, сбрасываем режим инвентаризации
    if (isAuditMode) toggleAuditMode();

    currentWarehouseFilter = id;
    document.querySelectorAll('#stock-mod .filter-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    renderInventoryTable();
}

// === РЕЖИМ ИНВЕНТАРИЗАЦИИ ===
let auditDatePicker = null;

window.toggleAuditMode = function () {
    if (currentWarehouseFilter === 'all' && !isAuditMode) {
        return UI.toast('Для инвентаризации выберите конкретный склад (например, Склад №4)!', 'warning');
    }

    // Инициализация календаря если еще нет
    const dateEl = document.getElementById('audit-date-filter');
    if (dateEl && !auditDatePicker && typeof flatpickr !== 'undefined') {
        auditDatePicker = flatpickr(dateEl, { 
            dateFormat: "Y-m-d", altInput: true, altFormat: "d.m.Y", locale: "ru", defaultDate: new Date()
        });
    }

    isAuditMode = !isAuditMode;
    const btnMode = document.getElementById('btn-audit-mode');
    const btnSave = document.getElementById('btn-audit-save');

    if (isAuditMode) {
        btnMode.classList.replace('btn-outline', 'btn-red');
        btnMode.innerText = '❌ Отменить инвентаризацию';
        btnSave.classList.remove('inv-hidden');
        UI.toast('Режим инвентаризации включен. Введите фактические остатки.', 'info');
    } else {
        btnMode.classList.replace('btn-red', 'btn-outline');
        btnMode.innerText = '📋 Ревизия';
        btnSave.classList.add('inv-hidden');
    }
    renderInventoryTable();
};

// === РЕЖИМ ИНВЕНТАРИЗАЦИИ ===
window.saveAudit = async function () {
    const inputs = document.querySelectorAll('.audit-qty-input');
    let adjustments = [];
    let hasError = false;

    for (const input of inputs) {
        const newQty = parseFloat(input.value);
        const oldQty = parseFloat(input.getAttribute('data-old-qty'));

        if (!isNaN(newQty) && newQty < 0) {
            UI.toast('Фактический остаток не может быть отрицательным!', 'error');
            hasError = true;
            break;
        }

        // Если цифра изменилась (введенный факт не равен тому, что было на экране)
        if (newQty !== oldQty && !isNaN(newQty)) {
            // Защита от случайного обнуления
            if (newQty === 0 && oldQty > 0) {
                if (!confirm(`Вы уверены, что хотите полностью списать позицию (остаток: ${oldQty} ед.)?`)) {
                    continue;
                }
            }

            adjustments.push({
                itemId: input.getAttribute('data-item-id'),
                batchId: input.getAttribute('data-batch-id') || null,
                actualQty: newQty // 🚀 ИСПРАВЛЕНИЕ: Отправляем на сервер ФАКТИЧЕСКОЕ количество
            });
        }
    }

    if (hasError) return;

    if (adjustments.length === 0) {
        toggleAuditMode();
        return UI.toast('Нет изменений. Остатки верны.', 'success');
    }

    const auditDateStr = document.getElementById('audit-date-filter')?.value || '';

    try {
        await API.post('/api/inventory/audit', {
            warehouseId: currentWarehouseFilter,
            adjustments: adjustments,
            auditDate: auditDateStr
        });

        UI.toast('✅ Ревизия успешно проведена!', 'success');
        toggleAuditMode();
        loadTable();
    } catch (e) {
        console.error(e);
        // API.post automatically triggers UI.toast on error
    }
};

function renderInventoryTable() {
    const tbody = document.getElementById('inventory-table');
    const thead = document.getElementById('inventory-thead');
    if (!tbody) return;
    tbody.innerHTML = '';

    const isReserveView = currentWarehouseFilter === '7';

    // Динамический заголовок: Склад №7 показывает колонку "Заказ"
    if (thead) {
        if (isReserveView) {
            thead.innerHTML = `<tr>
                <th class="inv-col-batch">№ Партии</th>
                <th class="inv-col-name">Наименование</th>
                <th class="inv-col-order">Заказ</th>
                <th class="inv-col-qty">Остаток</th>
                <th class="inv-col-unit">Ед.</th>
                <th class="inv-col-actions">Действия</th>
            </tr>`;
        } else {
            thead.innerHTML = `<tr>
                <th class="inv-col-wh">Склад</th>
                <th class="inv-col-batch">№ Партии</th>
                <th class="inv-col-name">Наименование (Сырье / Продукция)</th>
                <th class="inv-col-qty">Остаток</th>
                <th class="inv-col-unit">Ед. изм.</th>
                <th class="inv-col-actions">Действия</th>
            </tr>`;
        }
    }

    const colSpan = 6;

    const filtered = allInventory.filter(item => {
        if (parseFloat(item.total) === 0) return false;
        if (currentWarehouseFilter !== 'all' && String(item.warehouse_id) !== currentWarehouseFilter) return false;
        if (currentSearch) {
            const searchStr = `${item.item_name} ${item.warehouse_name || ''} ${item.batch_number || ''} ${item.batch_id || ''}`.toLowerCase();
            const searchStrCondensed = searchStr.replace(/[\.\s-]/g, '');

            const tokens = currentSearch.split(/\s+/).filter(Boolean);
            let multiTargetMatch = true;
            for (let token of tokens) {
                let tokenCondensed = token.replace(/[\.\s-]/g, '');
                if (!searchStr.includes(token) && (!tokenCondensed || !searchStrCondensed.includes(tokenCondensed))) {
                    multiTargetMatch = false;
                    break;
                }
            }

            if (!multiTargetMatch) {
                // Secondary check for cases like typing "2 к 6" spaced out
                const fullQueryCondensed = currentSearch.replace(/[\.\s-]/g, '');
                if (fullQueryCondensed.length < 2 || !searchStrCondensed.includes(fullQueryCondensed)) {
                    return false;
                }
            }
        }
        return true;
    });

    const totalItems = filtered.length;
    const totalPages = Math.ceil(totalItems / itemsPerPage) || 1;
    if (currentPage > totalPages) currentPage = totalPages;

    const startIdx = (currentPage - 1) * itemsPerPage;
    const paginated = filtered.slice(startIdx, startIdx + itemsPerPage);

    const summaryText = document.getElementById('inventory-summary-text');
    if (summaryText) summaryText.innerText = totalItems > 0 ? `Показано ${startIdx + 1} - ${Math.min(startIdx + itemsPerPage, totalItems)} из ${totalItems}` : '0 записей';

    const paginationContainer = document.getElementById('inventory-pagination');
    if (paginationContainer) {
        let pagesHtml = '';
        if (totalPages > 1) {
            pagesHtml += `<button class="btn btn-sm btn-outline" ${currentPage === 1 ? 'disabled' : ''} onclick="goToPage(${currentPage - 1})">Пред</button>`;
            let startPage = Math.max(1, currentPage - 2);
            let endPage = Math.min(totalPages, currentPage + 2);
            if (startPage > 1) pagesHtml += `<button class="btn btn-sm btn-outline" onclick="goToPage(1)">1</button>${startPage > 2 ? '<span class="text-muted">...</span>' : ''}`;
            for (let i = startPage; i <= endPage; i++) {
                pagesHtml += `<button class="btn btn-sm ${i === currentPage ? 'btn-blue' : 'btn-outline'}" onclick="goToPage(${i})">${i}</button>`;
            }
            if (endPage < totalPages) pagesHtml += `${endPage < totalPages - 1 ? '<span class="text-muted">...</span>' : ''}<button class="btn btn-sm btn-outline" onclick="goToPage(${totalPages})">${totalPages}</button>`;
            pagesHtml += `<button class="btn btn-sm btn-outline" ${currentPage === totalPages ? 'disabled' : ''} onclick="goToPage(${currentPage + 1})">След</button>`;
        }
        paginationContainer.innerHTML = pagesHtml;
    }

    if (paginated.length === 0) {
        tbody.innerHTML = `<tr><td colspan="${colSpan}" class="inv-empty-row">По вашему запросу ничего не найдено</td></tr>`;
        return;
    }

    paginated.forEach(item => {
        let actionHtml = '';
        let qtyHtml = '';

        if (isAuditMode) {
            qtyHtml = `<td class="inv-actions-cell">
                <input type="number" class="input-modern audit-qty-input" 
                       data-item-id="${item.item_id}" 
                       data-batch-id="${item.batch_id || ''}" 
                       data-old-qty="${item.total}" 
                       value="${parseFloat(item.total)}" 
                       onfocus="this.select()">
            </td>`;
        } else {
            qtyHtml = `<td class="inv-qty-cell">${parseFloat(item.total).toLocaleString('ru-RU')}</td>`;

            if (isReserveView) {
                // Склад №7: кнопка управления резервом
                actionHtml = `<button class="btn btn-outline inv-btn-reserve" 
                    onclick="openReserveManagerModal(${item.item_id}, '${escapeHTML(item.item_name)}', ${item.batch_id || 'null'}, '${item.batch_number || ''}', ${item.linked_order_item_id || 'null'}, '${item.order_doc_number || ''}', ${item.order_id || 'null'}, ${item.total})">
                    🔄 Управление
                </button>`;
            } else if (item.warehouse_id === 3) {
                actionHtml = `<button class="btn btn-blue inv-btn-demold" 
                            onclick="openDemoldingModal(${item.batch_id}, '${item.batch_number || 'Б/Н'}', ${item.item_id}, '${item.item_name}', ${item.total})">
                            🧱 Распалубить
                          </button>`;
            } else if (item.warehouse_id === 5 || item.warehouse_id === 6) {
                actionHtml = `<button class="btn btn-outline inv-btn-dispose" 
                            onclick="openDisposeModal(${item.item_id}, '${item.item_name}', ${item.batch_id || 'null'}, '${item.batch_number || ''}', ${item.warehouse_id}, ${item.total})">
                            🗑️ Утилизировать
                          </button>`;
            } else {
                actionHtml = `<button class="btn btn-outline inv-btn-move" 
                    onclick="openDirectScrapModal(${item.item_id}, '${item.item_name}', ${item.batch_id || 'null'}, '${item.batch_number || ''}', ${item.warehouse_id}, ${item.total})">
                      ↘️ Переместить
                </button>`;
            }
        }

        if (isReserveView) {
            // Спец-разметка для Склада №7: с колонкой "Заказ"
            const orderBadge = item.order_doc_number 
                ? `<span class="badge inv-order-badge">${escapeHTML(item.order_doc_number)}</span>` 
                : '<span class="badge inv-wh-badge">Без привязки</span>';
            tbody.innerHTML += `
            <tr>
                <td class="inv-batch-cell">${item.batch_number ? '#' + Utils.escapeHtml(item.batch_number) : '-'}</td>
                <td class="inv-name-cell" title="${Utils.escapeHtml(item.item_name)}"><strong>${Utils.escapeHtml(item.item_name)}</strong></td>
                <td>${orderBadge}</td>
                ${qtyHtml}
                <td class="inv-unit-cell">${item.unit}</td>
                <td class="inv-actions-cell">${actionHtml}</td>
            </tr>`;
        } else {
            tbody.innerHTML += `
            <tr>
                <td><span class="badge inv-wh-badge">${Utils.escapeHtml(item.warehouse_name)}</span></td>
                <td class="inv-batch-cell">${item.batch_number ? '#' + Utils.escapeHtml(item.batch_number) : (item.batch_id ? '#' + item.batch_id : '-')}</td>
                <td class="inv-name-cell" title="${Utils.escapeHtml(item.item_name)}"><strong>${Utils.escapeHtml(item.item_name)}</strong></td>
                ${qtyHtml}
                <td class="inv-unit-cell">${item.unit}</td>
                <td class="inv-actions-cell">${actionHtml}</td>
            </tr>`;
        }
    });
}

// === ПРЯМОЕ СПИСАНИЕ БОЯ И БРАКА ===
window.openDirectScrapModal = function (itemId, itemName, batchId, batchNum, warehouseId, currentQty) {
    const html = `
        <div class="inv-modal-info">
            <div class="inv-modal-product">Продукция: <b>${escapeHTML(itemName)}</b></div>
            ${batchNum ? `<div class="inv-modal-batch">Партия: ${escapeHTML(batchNum)}</div>` : ''}
            <div class="inv-modal-stock">Текущий остаток: <b class="inv-modal-stock-value">${currentQty}</b> ед.</div>
        </div>

        <input type="hidden" id="scrap-direct-item-id" value="${itemId}">
        <input type="hidden" id="scrap-direct-batch-id" value="${batchId || ''}">
        <input type="hidden" id="scrap-direct-warehouse-id" value="${warehouseId}">
        
        <div class="form-group">
            <label class="inv-label-danger">Количество брака/боя:</label>
            <input type="number" id="scrap-direct-qty" class="input-modern" placeholder="Сколько разбилось?" max="${currentQty}" onfocus="this.select()">
        </div>
        <div class="form-group">
            <label>Причина списания:</label>
            <input type="text" id="scrap-direct-desc" class="input-modern" placeholder="Например: Бой при погрузке" value="Отбраковка">
        </div>
    `;

    const buttons = `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-red" onclick="executeDirectScrap()">🔨 Списать в утиль</button>
    `;

    UI.showModal('Списание брака', html, buttons);
};
window.executeDirectScrap = async function () {
    const itemId = document.getElementById('scrap-direct-item-id').value;
    const batchId = document.getElementById('scrap-direct-batch-id').value;
    const warehouseId = document.getElementById('scrap-direct-warehouse-id').value;
    const scrapQty = parseFloat(document.getElementById('scrap-direct-qty').value);
    const desc = document.getElementById('scrap-direct-desc').value;

    if (!scrapQty || scrapQty <= 0) return UI.toast('Введите корректное количество', 'warning');

    try {
        await API.post('/api/inventory/scrap', {
            itemId: itemId,
            batchId: batchId || null,
            warehouseId: warehouseId,
            targetWarehouseId: 6, // 🚨 ДОБАВЛЕНО: Явно указываем склад утиля (№6), чтобы бэкенд не сломался
            scrapQty: scrapQty,
            description: desc
        });

        UI.closeModal();
        UI.toast('Брак успешно списан', 'success');
        loadTable();
    } catch (e) { console.error(e); }
};

// === ОКНО РАСПАЛУБКИ ===
window.openDemoldingModal = function (batchId, batchNum, tileId, productName, plannedQty) {
    const html = `
        <div class="inv-modal-info">
            <h4 class="inv-modal-batch">Партия: ${escapeHTML(batchNum)}</h4>
            <div class="inv-modal-product">Продукция: <b>${escapeHTML(productName)}</b></div>
            <div class="inv-modal-stock">В сушилке числится: <b class="inv-modal-stock-value">${plannedQty}</b> ед.</div>
        </div>

        <div class="form-grid inv-grid-3">
            <div class="form-group">
                <label class="inv-label-success">🟢 1-й сорт:</label>
                <input type="number" id="demold-good" class="input-modern" value="${plannedQty}">
            </div>
            <div class="form-group">
                <label class="inv-label-warning">🟡 2-й сорт:</label>
                <input type="number" id="demold-grade2" class="input-modern" value="0">
            </div>
            <div class="form-group">
                <label class="inv-label-danger">🔴 Брак:</label>
                <input type="number" id="demold-scrap" class="input-modern" value="0">
            </div>
        </div>
        
        <div class="form-group">
            <label class="d-flex align-items-center gap-2">
                <input type="checkbox" id="demold-complete" checked>
                Полностью закрыть партию
            </label>
        </div>
    `;

    const buttons = `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-blue" onclick="executeDemolding(${batchId}, ${tileId}, ${plannedQty})">💾 Сохранить выход</button>
    `;

    UI.showModal('🧱 Распалубка и премка на склад', html, buttons);
};

// === ВЫПОЛНЕНИЕ РАСПАЛУБКИ ===
window.executeDemolding = async function (batchId, tileId, currentWipQty) {
    const goodQty = parseFloat(document.getElementById('demold-good').value) || 0;
    const grade2Qty = parseFloat(document.getElementById('demold-grade2').value) || 0;
    const scrapQty = parseFloat(document.getElementById('demold-scrap').value) || 0;
    const isComplete = document.getElementById('demold-complete').checked;

    if (goodQty < 0 || grade2Qty < 0 || scrapQty < 0) return UI.toast('Количество не может быть отрицательным!', 'error');
    if (goodQty + grade2Qty + scrapQty === 0) return UI.toast('Укажите хотя бы одну позицию выхода!', 'error');

    try {
        await API.post('/api/move-wip', { batchId, tileId, currentWipQty, goodQty, grade2Qty, scrapQty, isComplete });

        UI.closeModal();
        UI.toast('Партия успешно распределена по складам!', 'success');
        loadTable();
    } catch (e) { console.error(e); }
};

// === ПЕРЕМЕЩЕНИЕ В УЦЕНКУ (5) ИЛИ УТИЛЬ (6) ===
window.openScrapModal = function (itemId, itemName, batchId, batchNum, warehouseId, currentQty) {
    const html = `
        <div class="inv-modal-info">
            <div class="inv-modal-product">Продукция: <b>${escapeHTML(itemName)}</b></div>
            ${batchNum ? `<div class="inv-modal-batch">Партия: ${escapeHTML(batchNum)}</div>` : ''}
        </div>

        <input type="hidden" id="scrap-item-id" value="${itemId}">
        <input type="hidden" id="scrap-batch-id" value="${batchId || ''}">
        <input type="hidden" id="scrap-warehouse-id" value="${warehouseId}">
        
        <div class="form-group">
            <label>Куда перемещаем?</label>
            <select id="scrap-target-wh" class="input-modern">
                <option value="5">🟡 На Склад №5 (Уценка)</option>
                <option value="6">🔴 На Склад №6 (Утиль)</option>
            </select>
        </div>

        <div class="form-grid inv-grid-2">
            <div class="form-group">
                <label>Количество:</label>
                <input type="number" id="scrap-qty" class="input-modern" max="${currentQty}" placeholder="0">
            </div>
            <div class="form-group">
                <label>Причина:</label>
                <input type="text" id="scrap-desc" class="input-modern" value="Отбраковка">
            </div>
        </div>
    `;

    const buttons = `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-blue" onclick="executeScrap()">➡️ Переместить</button>
    `;
    UI.showModal('Перемещение продукции', html, buttons);

    setTimeout(() => {
        const scrapTargetTarget = document.getElementById('scrap-target-wh');
        if (scrapTargetTarget && !scrapTargetTarget.tomselect) {
            new TomSelect(scrapTargetTarget, {
                plugins: ['clear_button'],
                dropdownParent: 'body'
            });
        }
    }, 50);
};

window.executeScrap = async function () {
    const itemId = document.getElementById('scrap-item-id').value;
    const batchId = document.getElementById('scrap-batch-id').value;
    const warehouseId = document.getElementById('scrap-warehouse-id').value;
    const targetWh = document.getElementById('scrap-target-wh').value;
    const scrapQty = parseFloat(document.getElementById('scrap-qty').value);
    const desc = document.getElementById('scrap-desc').value;

    if (!scrapQty || scrapQty <= 0) return UI.toast('Введите количество', 'warning');

    try {
        await API.post('/api/inventory/scrap', { itemId, batchId: batchId || null, warehouseId, targetWarehouseId: targetWh, scrapQty, description: desc });
        UI.closeModal();
        UI.toast('Успешно перемещено!', 'success');
        loadTable();
    } catch (e) { console.error(e); }
};

// =========================================================
// БЕЗВОЗВРАТНАЯ УТИЛИЗАЦИЯ (ВЫВОЗ НА СВАЛКУ ИЗ СКЛАДОВ 5 И 6)
// =========================================================

window.openDisposeModal = function (itemId, itemName, batchId, batchNum, warehouseId, maxQty) {
    const html = `
        <div class="inv-modal-info">
            <div class="inv-modal-product">Утилизация: <b>${escapeHTML(itemName)}</b> ${batchNum ? '(Партия #' + escapeHTML(batchNum) + ')' : ''}</div>
        </div>
        <div class="form-group">
            <label>Количество (макс: ${maxQty}):</label>
            <input type="number" id="dispose-qty" class="input-modern" value="${maxQty}">
            <input type="hidden" id="dispose-item-id" value="${itemId}">
            <input type="hidden" id="dispose-batch-id" value="${batchId || ''}">
            <input type="hidden" id="dispose-warehouse-id" value="${warehouseId}">
        </div>
        <div class="form-group">
            <label>Комментарий:</label>
            <input type="text" id="dispose-desc" class="input-modern" value="Вывоз на свалку">
        </div>
    `;

    const buttons = `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-red" onclick="executeDispose()">🗑️ Списать навсегда</button>
    `;
    UI.showModal('⚠️ Утилизация', html, buttons);
};

window.executeDispose = async function () {
    const itemId = document.getElementById('dispose-item-id').value;
    const batchId = document.getElementById('dispose-batch-id').value;
    const warehouseId = document.getElementById('dispose-warehouse-id').value;
    const disposeQty = parseFloat(document.getElementById('dispose-qty').value);
    const desc = document.getElementById('dispose-desc').value;

    if (!disposeQty || disposeQty <= 0) return UI.toast('Введите количество больше нуля!', 'warning');

    UI.toast('⏳ Выполняется списание...', 'info');

    try {
        const data = await API.post('/api/inventory/dispose', {
            itemId: itemId,
            batchId: batchId || null,
            warehouseId: warehouseId,
            disposeQty: disposeQty,
            description: desc
        });

        UI.closeModal();
        UI.toast(data.message || '✅ Успешно утилизировано', 'success');
        loadTable();
    } catch (e) {
        console.error(e);
        // Toast shows automatically from API
    }
};

// === УПРАВЛЕНИЕ РЕЗЕРВАМИ (Склад №7) ===
window.openReserveManagerModal = function (itemId, itemName, batchId, batchNum, linkedOrderItemId, orderDocNum, orderId, maxQty) {
    const html = `
        <div class="inv-modal-info">
            <div class="inv-modal-product">Продукция: <b>${escapeHTML(itemName)}</b></div>
            ${batchNum ? `<div class="inv-modal-batch">Партия: ${escapeHTML(batchNum)}</div>` : ''}
            <div class="inv-modal-stock">Привязка: <b class="inv-modal-stock-value">${orderDocNum || 'Без заказа'}</b></div>
            <div class="inv-modal-stock">В резерве: <b class="inv-modal-stock-value">${maxQty}</b> ед.</div>
        </div>

        <input type="hidden" id="reserve-item-id" value="${itemId}">
        <input type="hidden" id="reserve-batch-id" value="${batchId || ''}">
        <input type="hidden" id="reserve-linked-coi" value="${linkedOrderItemId || ''}">

        <div class="form-group">
            <label>Действие:</label>
            <select id="reserve-action" class="input-modern" onchange="toggleReserveTransferTarget()">
                <option value="release">✅ Снять резерв (Вернуть на Склад №4)</option>
                <option value="transfer">🔄 Перебросить на другой заказ</option>
            </select>
        </div>

        <div class="form-group">
            <label>Количество:</label>
            <input type="number" id="reserve-qty" class="input-modern" value="${maxQty}" max="${maxQty}" onfocus="this.select()">
        </div>

        <div class="form-group inv-hidden" id="reserve-transfer-target">
            <label>Целевой заказ:</label>
            <select id="reserve-target-coi" class="input-modern">
                <option value="">Загрузка...</option>
            </select>
        </div>
    `;

    const buttons = `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-blue" onclick="executeReserveAction()">✅ Выполнить</button>
    `;

    UI.showModal('🔒 Управление резервом', html, buttons);

    // Предзагрузка списка заказов для переброски
    API.get(`/api/inventory/active-order-items?itemId=${itemId}`)
        .then(orders => {
            const sel = document.getElementById('reserve-target-coi');
            if (!sel) return;
            sel.innerHTML = '<option value="">Выберите заказ...</option>';
            orders.forEach(o => {
                if (String(o.id) === String(linkedOrderItemId)) return; // Скрываем текущий
                sel.innerHTML += `<option value="${o.id}">${escapeHTML(o.doc_number)} | ${escapeHTML(o.client_name || '')} (Заказ: ${o.qty_ordered}, Рез: ${o.qty_reserved || 0})</option>`;
            });
        }).catch(e => console.error(e));
};

// Переключатель видимости селекта целевого заказа
window.toggleReserveTransferTarget = function () {
    const action = document.getElementById('reserve-action').value;
    const target = document.getElementById('reserve-transfer-target');
    if (target) target.classList.toggle('inv-hidden', action !== 'transfer');
};

// Выполнение действия с резервом
window.executeReserveAction = async function () {
    const action = document.getElementById('reserve-action').value;
    const itemId = document.getElementById('reserve-item-id').value;
    const batchId = document.getElementById('reserve-batch-id').value || null;
    const linkedOrderItemId = document.getElementById('reserve-linked-coi').value || null;
    const qty = parseFloat(document.getElementById('reserve-qty').value);
    const targetOrderItemId = action === 'transfer' ? document.getElementById('reserve-target-coi').value : null;

    if (!qty || qty <= 0) return UI.toast('Укажите количество!', 'warning');
    if (action === 'transfer' && !targetOrderItemId) return UI.toast('Выберите целевой заказ!', 'warning');

    try {
        const data = await API.post('/api/inventory/reserve-action', { action, itemId, batchId, linkedOrderItemId, qty, targetOrderItemId });
        
        UI.closeModal();
        UI.toast(data.message || '✅ Готово', 'success');
        loadTable();
    } catch (e) {
        console.error(e);
        // Error toast handled by API
    }
};

// === ЭКСПОРТ / ИМПОРТ ===
window.handleExcelImport = async function(event) {
    const file = event.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('excelFile', file);

    UI.toast('⏳ Обработка файла...', 'info');

    try {
        const headers = {};
        const token = localStorage.getItem('token') || localStorage.getItem('jwtToken');
        if (token) headers['Authorization'] = 'Bearer ' + token;

        const res = await fetch('/api/inventory/import-preview', {
            method: 'POST',
            headers: headers,
            body: formData
        });
        const data = await res.json();
        event.target.value = ''; // clear

        if (!res.ok) throw new Error(data.error || 'Ошибка загрузки');

        let html = '<div class="inv-scrollable" style="max-height: 50vh; overflow-y: auto;">';
        html += '<table class="table-modern w-100" style="font-size:12px; table-layout: fixed;">';
        html += '<thead style="position: sticky; top: 0; background: white; z-index: 10;"><tr><th style="width: 15%">Склад</th><th style="width: 35%">Товар</th><th style="width: 15%">Партия</th><th style="width: 10%">Расчет</th><th style="width: 10%">Факт</th><th style="width: 15%">Дельта</th></tr></thead><tbody>';

        let hasAdjustments = false;
        let adjustmentsData = [];

        data.errors.forEach(e => {
            html += `<tr style="background: #ffe6e6;">
                <td>Склад ${e.wh_id || '?'}</td>
                <td style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${Utils.escapeHtml(e.item_name || 'Неизвестно')}">${e.item_id || '?'} - ${Utils.escapeHtml(e.item_name || 'Неизвестно')}</td>
                <td>${Utils.escapeHtml(e.batch_num || '-')}</td>
                <td colspan="3" class="text-danger">⚠️ Ошибка: ${Utils.escapeHtml(e.error_msg)}</td>
            </tr>`;
        });

        data.differences.forEach(d => {
            hasAdjustments = true;
            adjustmentsData.push({
                warehouseId: d.wh_id,
                itemId: d.item_id,
                batchId: d.batch_id,
                actualQty: d.fact_qty
            });
            html += `<tr style="background: #fff8e1;">
                <td>Склад ${d.wh_id}</td>
                <td style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${Utils.escapeHtml(d.item_name)}">${Utils.escapeHtml(d.item_name)}</td>
                <td>${Utils.escapeHtml(d.batch_num || '-')}</td>
                <td>${d.db_qty}</td>
                <td><b>${d.fact_qty}</b></td>
                <td class="${d.delta > 0 ? 'text-success' : 'text-danger'}"><b>${d.delta > 0 ? '+'+d.delta : d.delta}</b></td>
            </tr>`;
        });

        if (data.matches.length > 0) {
            html += `<tr><td colspan="6" class="text-center text-muted font-12 bg-surface-alt p-10">Остальные ${data.matches.length} позиций сошлись (скрыты)</td></tr>`;
        }

        html += '</tbody></table></div>';

        if (!hasAdjustments && data.errors.length === 0) {
            html = '<div class="p-20 text-center"><h3 class="text-success">✅ Всё идеально сошлось!</h3><p>Расхождения не найдены.</p></div>';
        }

        window.__currentImportAdjustments = adjustmentsData;

        const buttons = `
            <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
            <button class="btn btn-blue" ${hasAdjustments && data.errors.length === 0 ? '' : (hasAdjustments ? '' : 'disabled')} onclick="confirmExcelImport()">💾 Применить изменения</button>
        `;

        UI.showModal('📊 Предпросмотр Ревизии', html, buttons, 'modal-lg');
    } catch(err) {
        UI.toast(err.message, 'error');
        event.target.value = '';
    }
};

window.confirmExcelImport = async function() {
    const adjustments = window.__currentImportAdjustments || [];
    if (adjustments.length === 0) return UI.toast('Нет изменений для сохранения', 'warning');

    UI.toast('⏳ Загрузка в базу...', 'info');
    try {
        await API.post('/api/inventory/audit', { warehouseId: 0, adjustments: adjustments });
        
        UI.closeModal();
        UI.toast('✅ Инвентаризация успешно импортирована!', 'success');
        window.__currentImportAdjustments = null;
        loadTable();
    } catch (e) {
        console.error(e);
        // error toast handled by API helper
    }
};

window.openPrintModal = function() {
    const wh = typeof currentWarehouseFilter !== 'undefined' ? currentWarehouseFilter : 'all';
    
    // Прячем дропдаун экспорта если открыт
    const dropdowns = document.querySelectorAll('.dropdown-menu');
    dropdowns.forEach(d => d.classList.add('inv-hidden'));

    const tokenParam = typeof API !== 'undefined' && API.token ? API.token : localStorage.getItem('token');
    
    const html = `
        <div class="text-center p-20">
            <p class="mb-20 text-muted">Будет распечатан бланк для инвентаризации <b>${wh === 'all' ? 'всех складов' : 'выбранного склада (№' + wh + ')' }</b>.</p>
            <button class="btn btn-outline mb-10 w-100" onclick="window.open('/api/inventory/print?mode=blind&wh=' + currentWarehouseFilter + '&token=' + '${tokenParam}', '_blank'); UI.closeModal();">Слепой бланк (Пустые колонки Факт / Расчет)</button>
            <button class="btn btn-blue w-100" onclick="window.open('/api/inventory/print?mode=full&wh=' + currentWarehouseFilter + '&token=' + '${tokenParam}', '_blank'); UI.closeModal();">Полный бланк (Содержит Расчетный остаток)</button>
        </div>
    `;
    UI.showModal('🖨️ Печать Бланка', html, '<button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>');
};

window.executeExport = function(mode) {
    const wh = typeof currentWarehouseFilter !== 'undefined' ? currentWarehouseFilter : 'all';
    // Прячем дропдаун
    const dropdowns = document.querySelectorAll('.dropdown-menu');
    dropdowns.forEach(d => d.classList.add('inv-hidden'));
    
    const tokenParam = typeof API !== 'undefined' && API.token ? API.token : localStorage.getItem('token');
    window.open(`/api/inventory/export?mode=${mode}&wh=${wh}&token=${tokenParam}`, '_blank');
};