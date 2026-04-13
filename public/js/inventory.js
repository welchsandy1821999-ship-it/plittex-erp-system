// === public/js/inventory.js ===

if (window.flatpickr && window.flatpickr.l10ns && window.flatpickr.l10ns.ru) {
    flatpickr.localize(flatpickr.l10ns.ru);
}

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

let inventoryDatePicker = null;
window.dryingReceiptDates = [];
window.dryingExpenseDates = [];

// Функция загрузки дат событий сушилки для календаря
window.updateInventoryCalendarMarks = async function () {
    try {
        const data = await API.get('/api/inventory/drying-dates');
        window.dryingReceiptDates = data.receiptDates || [];
        window.dryingExpenseDates = data.expenseDates || [];
        if (inventoryDatePicker) inventoryDatePicker.redraw();
    } catch (e) { console.error('Ошибка обновления меток календаря:', e); }
};

function loadTable() {
    // Инициализация календаря если еще нет
    const dateEl = document.getElementById('inventory-date-filter');
    if (dateEl && !inventoryDatePicker && typeof flatpickr !== 'undefined') {
        inventoryDatePicker = flatpickr(dateEl, { 
            dateFormat: "Y-m-d", altInput: true, altFormat: "d.m.Y", locale: "ru", defaultDate: new Date(),
            onChange: function(selectedDates, dateStr, instance) {
                // При смене даты сразу загружаем новые данные
                loadTable();
                // Обновляем историю сушилки, если открыта её вкладка
                if (currentWarehouseFilter === '3') loadDryingHistory();
            },
            onDayCreate: function (dObj, dStr, fp, dayElem) {
                const year = dayElem.dateObj.getFullYear();
                const month = String(dayElem.dateObj.getMonth() + 1).padStart(2, '0');
                const day = String(dayElem.dateObj.getDate()).padStart(2, '0');
                const dateStr = `${year}-${month}-${day}`;

                if (window.dryingReceiptDates && window.dryingReceiptDates.includes(dateStr)) {
                    dayElem.innerHTML += '<span class="inv-cal-dot-receipt"></span>';
                }
                if (window.dryingExpenseDates && window.dryingExpenseDates.includes(dateStr)) {
                    dayElem.innerHTML += '<span class="inv-cal-dot-expense"></span>';
                }
            }
        });
        // Загружаем даты сразу после инициализации календаря
        updateInventoryCalendarMarks();
    }

    let params = [];
    if (inventoryDatePicker && inventoryDatePicker.selectedDates.length > 0) {
        params.push(`as_of_date=${inventoryDatePicker.formatDate(inventoryDatePicker.selectedDates[0], "Y-m-d")}`);
    }
    if (isAuditMode && ['all', '1', '4', '5'].includes(currentWarehouseFilter)) {
        params.push(`audit_all=true`);
        params.push(`wh=${currentWarehouseFilter}`);
    }
    
    const queryString = params.length > 0 ? '?' + params.join('&') : '';

    API.get('/api/inventory' + queryString)
        .then(data => {
            allInventory = data;
            renderInventoryTable();
        })
        .catch(err => {
            console.error('Failed to load table:', err);
        });
}

// === ИСТОРИЯ ДВИЖЕНИЙ СУШИЛКИ ===
window.loadDryingHistory = async function () {
    const historyBlock = document.getElementById('drying-history-block');
    const tbody = document.getElementById('drying-history-table');
    const dateBadge = document.getElementById('drying-history-date-badge');
    if (!historyBlock || !tbody) return;

    const dateStr = inventoryDatePicker
        ? inventoryDatePicker.formatDate(inventoryDatePicker.selectedDates[0] || new Date(), 'Y-m-d')
        : new Date().toISOString().slice(0, 10);

    // Обновляем бейдж даты
    if (dateBadge) {
        const d = new Date(dateStr);
        dateBadge.textContent = d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
    }

    try {
        const data = await API.get(`/api/inventory/drying-history?date=${dateStr}`);

        if (!Array.isArray(data) || data.length === 0) {
            tbody.innerHTML = '<tr><td colspan="8" class="text-center text-muted p-20">В этот день движений на сушилке не было.</td></tr>';
            return;
        }

        tbody.innerHTML = data.map(row => {
            const isReceipt = parseFloat(row.quantity) > 0;
            const typeBadge = isReceipt
                ? '<span class="badge bg-success-light text-success">📥 Приход</span>'
                : '<span class="badge bg-warning-light text-warning">📤 Распалубка</span>';
            const qtyClass = isReceipt ? 'text-success font-bold' : 'text-warning font-bold';
            const qtySign = isReceipt ? '+' : '';
            
            const descSafe = (row.description || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');

            return `
            <tr>
                <td class="p-8 text-muted font-13">${Utils.escapeHtml(row.time || '')}</td>
                <td class="p-8">${typeBadge}</td>
                <td class="p-8">${row.batch_number && row.batch_id ? '<a href="javascript:void(0)" onclick="openBatchCard(' + row.batch_id + ')" class="text-primary text-decoration-none fw-bold">#' + Utils.escapeHtml(row.batch_number) + '</a>' : '-'}</td>
                <td class="p-8">${Utils.escapeHtml(row.product_name)}</td>
                <td class="p-8 text-right ${qtyClass}">${qtySign}${parseFloat(row.quantity).toLocaleString('ru-RU', { maximumFractionDigits: 2 })}</td>
                <td class="p-8 text-muted">${Utils.escapeHtml(row.unit || '')}</td>
                <td class="p-8 text-muted font-12">${Utils.escapeHtml(row.description || '')}</td>
                <td class="p-8 text-right">
                    <button class="btn btn-icon btn-sm text-muted hover-primary" onclick="openMovementEditModal(${row.id}, '${dateStr}', '${row.time}', ${row.quantity}, '${descSafe}')" title="Изменить">✏️</button>
                    <button class="btn btn-icon btn-sm text-danger hover-danger" onclick="deleteMovement(${row.id})" title="Удалить">🗑️</button>
                </td>
            </tr>`;
        }).join('');
    } catch (e) {
        console.error('Ошибка загрузки истории сушилки:', e);
        tbody.innerHTML = '<tr><td colspan="8" class="text-center text-danger">Ошибка загрузки данных</td></tr>';
    }
};

function applyWarehouseFilter(id, btn) {
    // Если переключили склад, сбрасываем режим инвентаризации
    if (isAuditMode) toggleAuditMode();

    currentWarehouseFilter = id;
    document.querySelectorAll('#stock-mod .filter-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    renderInventoryTable();

    // Показ/скрытие блока истории сушилки
    const historyBlock = document.getElementById('drying-history-block');
    if (historyBlock) {
        if (id === '3') {
            historyBlock.classList.remove('d-none');
            loadDryingHistory();
        } else {
            historyBlock.classList.add('d-none');
        }
    }
}

// === РЕЖИМ ИНВЕНТАРИЗАЦИИ ===

window.toggleAuditMode = function () {
    // Разрешаем ревизию на вкладке "Все склады" для 1, 4, 5
    if (['3', '6', '7'].includes(currentWarehouseFilter) && !isAuditMode) {
        return UI.toast('На этом складе ревизия недоступна!', 'warning');
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
    // ЗАГРУЖАЕМ новые данные с сервера, чтобы получить нулевые позиции
    loadTable();
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
                warehouseId: input.getAttribute('data-wh-id'), // нужно для Все Склады
                actualQty: newQty // 🚀 ИСПРАВЛЕНИЕ: Отправляем на сервер ФАКТИЧЕСКОЕ количество
            });
        }
    }

    if (hasError) return;

    if (adjustments.length === 0) {
        toggleAuditMode();
        return UI.toast('Нет изменений. Остатки верны.', 'success');
    }

    const auditDateStr = document.getElementById('inventory-date-filter')?.value || '';

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
        // Резервы и др. технические склады не участвуют в ревизии
        if (isAuditMode && ['3', '6', '7'].includes(String(item.warehouse_id))) return false;

        // В режиме Инвентаризации на разрешенных складах показываем позиции с 0 остатком
        const allowZero = isAuditMode && ['all', '1', '4', '5'].includes(currentWarehouseFilter);
        if (parseFloat(item.total) === 0 && !allowZero) return false;
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

        const batchCell = item.batch_number && item.batch_id
            ? `<a href="javascript:void(0)" onclick="openBatchCard(${item.batch_id})" class="text-primary text-decoration-none fw-bold">#${Utils.escapeHtml(item.batch_number)}</a>`
            : (item.batch_number ? '#' + Utils.escapeHtml(item.batch_number) : `<span class="text-muted">—</span>`);

        if (isAuditMode) {
            qtyHtml = `<td class="inv-actions-cell">
                <input type="number" class="input-modern audit-qty-input" 
                       data-item-id="${item.item_id}" 
                       data-wh-id="${item.warehouse_id}" 
                       data-batch-id="${item.batch_id || ''}" 
                       data-old-qty="${item.total}" 
                       value="${parseFloat(item.total)}" 
                       onfocus="this.select()">
            </td>`;
        } else {
            qtyHtml = `<td class="inv-qty-cell">${parseFloat(item.total).toLocaleString('ru-RU', { maximumFractionDigits: 2 })}</td>`;

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
                actionHtml = `<div class="flex-row gap-5">
                    <button class="btn btn-outline" onclick="openScrapModal(${item.item_id}, '${Utils.escapeHtml(item.item_name)}', ${item.batch_id || 'null'}, '${item.batch_number || ''}', ${item.warehouse_id}, ${item.total})">
                          ↘️ Брак/Уценка
                    </button>
                    <button class="btn btn-outline" onclick="openDirectScrapModal(${item.item_id}, '${Utils.escapeHtml(item.item_name)}', ${item.batch_id || 'null'}, '${item.batch_number || ''}', ${item.warehouse_id}, ${item.total})">
                          🔨 Прямое списание
                    </button>
                </div>`;
            }
        }

        if (isReserveView) {
            // Спец-разметка для Склада №7: с колонкой "Заказ"
            const orderBadge = item.order_doc_number 
                ? `<span class="badge inv-order-badge">${escapeHTML(item.order_doc_number)}</span>` 
                : '<span class="badge inv-wh-badge">Без привязки</span>';
            tbody.innerHTML += `
            <tr>
                <td class="inv-batch-cell">${batchCell}</td>
                <td class="inv-name-cell" title="${Utils.escapeHtml(item.item_name)}">
                    <a href="javascript:void(0)" onclick="openItemHistory(${item.item_id}, ${item.warehouse_id})" class="text-primary text-decoration-none">
                        <strong>${Utils.escapeHtml(item.item_name)}</strong>
                    </a>
                </td>
                <td>${orderBadge}</td>
                ${qtyHtml}
                <td class="inv-unit-cell">${item.unit}</td>
                <td class="inv-actions-cell">${actionHtml}</td>
            </tr>`;
        } else {
            tbody.innerHTML += `
            <tr>
                <td><span class="badge inv-wh-badge">${Utils.escapeHtml(item.warehouse_name)}</span></td>
                <td class="inv-batch-cell">${batchCell}</td>
                <td class="inv-name-cell" title="${Utils.escapeHtml(item.item_name)}">
                    <a href="javascript:void(0)" onclick="openItemHistory(${item.item_id}, ${item.warehouse_id === 'all' ? 'null' : item.warehouse_id})" class="text-primary text-decoration-none">
                        <strong>${Utils.escapeHtml(item.item_name)}</strong>
                    </a>
                </td>
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
        
        <div class="form-group mt-15">
            <label>Дата распалубки (По-умолчанию Сейчас):</label>
            <input type="text" id="demolding-date" class="input-modern" placeholder="ДД.ММ.ГГГГ ЧЧ:ММ">
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

    UI.showModal('🧱 Распалубка и приемка на склад', html, buttons);
    
    // Инициализация календаря для бэкдейтинга
    if (window.flatpickr) {
        flatpickr("#demolding-date", {
            enableTime: true,
            dateFormat: "Y-m-d H:i",
            defaultDate: "today",
            time_24hr: true
        });
    }
};

// === РЕДАКТИРОВАНИЕ ДВИЖЕНИЯ ===
window.openMovementEditModal = function(id, dateStr, timeStr, qty, desc) {
    const elId = document.getElementById('edit-mov-id') || document.getElementById('edit-movement-id');
    const elQty = document.getElementById('edit-mov-qty') || document.getElementById('edit-movement-qty');
    const elDesc = document.getElementById('edit-mov-desc') || document.getElementById('edit-movement-desc');
    const elDate = document.getElementById('edit-mov-date') || document.getElementById('edit-movement-date');

    if (elId) elId.value = id;
    if (elQty) elQty.value = qty;
    if (elDesc) elDesc.value = desc;
    
    // Показываем статичную модалку
    const modal = document.getElementById('modal-edit-movement');
    if (modal) {
        modal.classList.remove('d-none');
        modal.classList.add('active');
    }
    
    // YYYY-MM-DD HH:mm format
    const fullDate = dateStr + ' ' + (timeStr || '00:00');
    
    if (window.editMovementDatePicker && elDate) {
        window.editMovementDatePicker.setDate(fullDate);
    } else if (window.flatpickr && elDate) {
        window.editMovementDatePicker = flatpickr(elDate, {
            enableTime: true,
            dateFormat: "Y-m-d H:i",
            defaultDate: fullDate,
            time_24hr: true
        });
    } else if (elDate) {
        elDate.value = fullDate;
    }
};

window.saveMovementEdit = async function() {
    const elId = document.getElementById('edit-mov-id') || document.getElementById('edit-movement-id');
    const elDate = document.getElementById('edit-mov-date') || document.getElementById('edit-movement-date');
    const elDesc = document.getElementById('edit-mov-desc') || document.getElementById('edit-movement-desc');
    
    if (!elId || !elDate) {
        return UI.toast('Внутренняя ошибка DOM: поля ввода не найдены', 'error');
    }

    const id = elId.value;
    const date = elDate.value;
    const desc = elDesc ? elDesc.value : '';
    
    if (!id || !date) return UI.toast('Заполните поле даты', 'warning');
    
    try {
        await API.put(`/api/inventory/movement/${id}`, {
            movement_date: date,
            description: desc
        });
        
        // Закрываем модалку
        const modal = document.getElementById('modal-edit-movement');
        if (modal) {
            modal.classList.remove('active');
            modal.classList.add('d-none');
        }
        
        UI.toast('Движение успешно изменено', 'success');
        
        // Перезагрузка контекста
        loadDryingHistory();
        if (typeof loadTable === 'function') loadTable();
    } catch (e) {
        console.error(e);
    }
};

window.deleteMovement = function(id) {
    UI.confirm('Вы уверены, что хотите удалить запись? Все связанные операции (например, приходы на склады) будут автоматически отменены, баланс вернется в исходное состояние.', async () => {
        try {
            await API.delete(`/api/inventory/movement/${id}`);
            UI.toast('Транзакция успешно отменена', 'success');
            loadDryingHistory();
            if (typeof loadTable === 'function') loadTable();
        } catch (e) {
            console.error(e);
        }
    });
};

// === ВЫПОЛНЕНИЕ РАСПАЛУБКИ ===
window.executeDemolding = async function (batchId, tileId, currentWipQty) {
    const goodQty = parseFloat(document.getElementById('demold-good').value) || 0;
    const grade2Qty = parseFloat(document.getElementById('demold-grade2').value) || 0;
    const scrapQty = parseFloat(document.getElementById('demold-scrap').value) || 0;
    const isComplete = document.getElementById('demold-complete').checked;
    const demoldingDate = document.getElementById('demolding-date').value;

    if (goodQty < 0 || grade2Qty < 0 || scrapQty < 0) return UI.toast('Количество не может быть отрицательным!', 'error');
    if (goodQty + grade2Qty + scrapQty === 0) return UI.toast('Укажите хотя бы одну позицию выхода!', 'error');

    // ✅ FIX (п.4): Блокировка кнопки от повторного клика
    const btn = event && event.target ? event.target.closest('button') : null;
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Сохранение...'; }

    try {
        await API.post('/api/move-wip', { 
            batchId, 
            tileId, 
            currentWipQty, 
            goodQty, 
            grade2Qty, 
            scrapQty, 
            isComplete,
            movementDate: demoldingDate 
        });

        UI.closeModal();
        UI.toast('Партия успешно распределена по складам!', 'success');
        loadTable();
    } catch (e) {
        console.error(e);
        if (btn) { btn.disabled = false; btn.textContent = '💾 Сохранить выход'; }
    }
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

        let html = '<div class="inv-scrollable overflow-y-auto max-h-50vh">';
        html += '<table class="table-modern w-100 font-12 table-fixed">';
        html += '<thead class="bg-surface sticky-top z-10"><tr><th class="w-15">Склад</th><th class="w-35">Товар</th><th class="w-15">Партия</th><th class="w-10">Расчет</th><th class="w-10">Факт</th><th class="w-15">Дельта</th></tr></thead><tbody>';

        let hasAdjustments = false;
        let adjustmentsData = [];

        data.errors.forEach(e => {
            html += `<tr class="bg-danger-light">
                <td>Склад ${e.wh_id || '?'}</td>
                <td class="text-truncate" title="${Utils.escapeHtml(e.item_name || 'Неизвестно')}">${e.item_id || '?'} - ${Utils.escapeHtml(e.item_name || 'Неизвестно')}</td>
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
            html += `<tr class="bg-warning-light">
                <td>Склад ${d.wh_id}</td>
                <td class="text-truncate" title="${Utils.escapeHtml(d.item_name)}">${Utils.escapeHtml(d.item_name)}</td>
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
    const dateParam = (inventoryDatePicker && inventoryDatePicker.selectedDates.length > 0) ? `&as_of_date=${inventoryDatePicker.formatDate(inventoryDatePicker.selectedDates[0], "Y-m-d")}` : '';
    
    const html = `
        <div class="text-center p-20">
            <p class="mb-20 text-muted">Будет распечатан бланк для инвентаризации <b>${wh === 'all' ? 'всех складов' : 'выбранного склада (№' + wh + ')' }</b>.</p>
            <button class="btn btn-outline mb-10 w-100" onclick="window.open('/api/inventory/print?mode=blind&wh=' + currentWarehouseFilter + '&token=' + '${tokenParam}' + '${dateParam}', '_blank'); UI.closeModal();">Слепой бланк (Пустые колонки Факт / Расчет)</button>
            <button class="btn btn-blue w-100" onclick="window.open('/api/inventory/print?mode=full&wh=' + currentWarehouseFilter + '&token=' + '${tokenParam}' + '${dateParam}', '_blank'); UI.closeModal();">Полный бланк (Содержит Расчетный остаток)</button>
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
    const dateParam = (inventoryDatePicker && inventoryDatePicker.selectedDates.length > 0) ? `&as_of_date=${inventoryDatePicker.formatDate(inventoryDatePicker.selectedDates[0], "Y-m-d")}` : '';
    window.open(`/api/inventory/export?mode=${mode}&wh=${wh}&token=${tokenParam}${dateParam}`, '_blank');
};

// === ПРОСЕИВАНИЕ СЫРЬЯ ===
window.openSiftingModal = function() {
    const modal = document.getElementById('modal-sifting');
    modal.classList.remove('d-none');
    modal.classList.add('d-flex');
    setTimeout(() => modal.classList.add('active'), 10);

    document.getElementById('sifting-amount').value = '';
    document.getElementById('sifting-out1-qty').value = '';
    document.getElementById('sifting-out2-qty').value = '';

    // Инициализация Flatpickr для даты переработки
    const dateEl = document.getElementById('sifting-date');
    if (dateEl) {
        if (dateEl._flatpickr) dateEl._flatpickr.destroy();
        // Берём дату из глобального фильтра "Остатки на дату", или текущую
        let defaultDate = new Date();
        if (inventoryDatePicker && inventoryDatePicker.selectedDates.length > 0) {
            defaultDate = inventoryDatePicker.selectedDates[0];
        }
        flatpickr(dateEl, {
            dateFormat: 'Y-m-d',
            altInput: true,
            altFormat: 'd.m.Y',
            locale: 'ru',
            maxDate: 'today',
            defaultDate: defaultDate
        });
    }
};

window.closeSiftingModal = function() {
    const modal = document.getElementById('modal-sifting');
    modal.classList.remove('active');
    setTimeout(() => { modal.classList.remove('d-flex'); modal.classList.add('d-none'); }, 200);
};

window.calculateSifting = function() {
    const input = parseFloat(document.getElementById('sifting-amount').value) || 0;
    // Логика по умолчанию: 85% лицевой песок, 15% гранит
    const out1 = (input * 0.85).toFixed(1);
    const out2 = (input * 0.15).toFixed(1);
    
    document.getElementById('sifting-out1-qty').value = input > 0 ? out1 : '';
    document.getElementById('sifting-out2-qty').value = input > 0 ? out2 : '';
};

window.executeSifting = async function() {
    const sourceId = document.getElementById('sifting-source').value;
    const sourceQty = parseFloat(document.getElementById('sifting-amount').value);
    
    const out1Id = document.getElementById('sifting-out1-target').value;
    const out1Qty = parseFloat(document.getElementById('sifting-out1-qty').value);
    
    const out2Id = document.getElementById('sifting-out2-target').value;
    const out2Qty = parseFloat(document.getElementById('sifting-out2-qty').value);

    if (!sourceQty || sourceQty <= 0) return UI.toast('Введите объем исходного сырья', 'warning');
    if (isNaN(out1Qty) || isNaN(out2Qty)) return UI.toast('Ошибка в расчетах выхода сырья', 'error');

    try {
        const siftingDate = document.getElementById('sifting-date').value || null;
        const res = await API.post('/api/inventory/sifting', {
            sourceId,
            sourceQty,
            date: siftingDate,
            outputs: [
                { id: out1Id, qty: out1Qty },
                { id: out2Id, qty: out2Qty }
            ]
        });
        
        UI.toast(res.message || 'Просеивание успешно выполнено!', 'success');
        closeSiftingModal();
        if (typeof loadTable === 'function') loadTable();
    } catch (err) {
        UI.toast(err.message || 'Ошибка просеивания', 'error');
    }
};

// === ГЛОБАЛЬНОЕ СОСТОЯНИЕ КАЛЕНДАРЯ ИСТОРИИ ===
let invHistoryPeriodType = 'month'; 
let invHistoryPeriodValue = new Date().getMonth() + 1;
let invHistoryYear = new Date().getFullYear();
let invHistorySpecificDate = new Date().toISOString().split('T')[0];
let invHistoryCustomStart = ''; 
let invHistoryCustomEnd = '';   
let historyFlatpickr = null;
let historyCurrentItemId = null;
let currentItemHistoryData = []; // Для поиска
let currentItemHistoryStartBalance = 0;
let currentItemHistoryPrice = 0;

window.renderInvHistoryPeriodUI = function () {
    let typeOptions = `
        <option value="day" ${invHistoryPeriodType === 'day' ? 'selected' : ''}>День</option>
        <option value="week" ${invHistoryPeriodType === 'week' ? 'selected' : ''}>Неделя</option>
        <option value="month" ${invHistoryPeriodType === 'month' ? 'selected' : ''}>Месяц</option>
        <option value="quarter" ${invHistoryPeriodType === 'quarter' ? 'selected' : ''}>Квартал</option>
        <option value="year" ${invHistoryPeriodType === 'year' ? 'selected' : ''}>Год</option>
        <option value="custom" ${invHistoryPeriodType === 'custom' ? 'selected' : ''}>Произвольно</option>
        <option value="all" ${invHistoryPeriodType === 'all' ? 'selected' : ''}>За всё время</option>
    `;

    let valOptions = '';
    if (invHistoryPeriodType === 'quarter') {
        for (let i = 1; i <= 4; i++) valOptions += `<option value="${i}" ${invHistoryPeriodValue == i ? 'selected' : ''}>${i} Квартал</option>`;
    } else if (invHistoryPeriodType === 'month') {
        const months = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
        months.forEach((m, i) => valOptions += `<option value="${i + 1}" ${invHistoryPeriodValue == i + 1 ? 'selected' : ''}>${m}</option>`);
    }

    let yearOptions = '';
    const currentY = new Date().getFullYear();
    for (let y = currentY - 2; y <= currentY + 1; y++) yearOptions += `<option value="${y}" ${invHistoryYear == y ? 'selected' : ''}>${y} год</option>`;

    let activeInputHtml = '';
    if (invHistoryPeriodType === 'day') {
        activeInputHtml = `<input type="date" class="input-modern input-sm radius-md flex-12 min-w-120" value="${invHistorySpecificDate}" onchange="applyInvHistoryPeriod('date', this.value)">`;
    } else if (invHistoryPeriodType === 'custom') {
        activeInputHtml = `<input type="text" id="inv-hist-custom-date" class="input-modern input-sm radius-md flex-15 min-w-180" placeholder="Выберите даты...">`;
    } else if (invHistoryPeriodType !== 'all' && invHistoryPeriodType !== 'year' && invHistoryPeriodType !== 'week') {
        activeInputHtml = `<select class="input-modern input-sm radius-md flex-1 min-w-110" onchange="applyInvHistoryPeriod('value', this.value)">${valOptions}</select>`;
    }

    let yearHtml = '';
    if (invHistoryPeriodType !== 'all' && invHistoryPeriodType !== 'day' && invHistoryPeriodType !== 'week' && invHistoryPeriodType !== 'custom') {
        yearHtml = `<select class="input-modern input-sm radius-md flex-08 min-w-90" onchange="applyInvHistoryPeriod('year', this.value)">${yearOptions}</select>`;
    }

    const html = `
        <select class="input-modern input-sm radius-md flex-08 min-w-110" onchange="applyInvHistoryPeriod('type', this.value)">${typeOptions}</select>
        ${activeInputHtml}
        ${yearHtml}
    `;

    const container = document.getElementById('history-period-selector');
    if (container) {
        container.innerHTML = html;
        container.classList.add('w-100', 'd-flex');
        container.classList.remove('d-none');
    }

    if (invHistoryPeriodType === 'custom') {
        setTimeout(() => {
            const el = document.getElementById('inv-hist-custom-date');
            if (el && window.flatpickr) {
                historyFlatpickr = flatpickr(el, {
                    mode: "range",
                    dateFormat: "Y-m-d",
                    altInput: true,
                    altFormat: "d.m.Y",
                    locale: "ru",
                    defaultDate: invHistoryCustomStart && invHistoryCustomEnd ? [invHistoryCustomStart, invHistoryCustomEnd] : null,
                    onChange: function (selectedDates, dateStr, instance) {
                        if (selectedDates.length === 2) {
                            invHistoryCustomStart = instance.formatDate(selectedDates[0], "Y-m-d");
                            invHistoryCustomEnd = instance.formatDate(selectedDates[1], "Y-m-d");
                            applyInvHistoryPeriod('custom_range', null);
                        }
                    }
                });
            }
        }, 50);
    }
};

window.applyInvHistoryPeriod = function (field, value) {
    if (field === 'type') {
        invHistoryPeriodType = value;
        if (value === 'quarter') invHistoryPeriodValue = Math.floor(new Date().getMonth() / 3) + 1;
        else if (value === 'month') invHistoryPeriodValue = new Date().getMonth() + 1;
    }
    else if (field === 'date') invHistorySpecificDate = value;
    else if (field === 'value') invHistoryPeriodValue = parseInt(value);
    else if (field === 'year') invHistoryYear = parseInt(value);

    renderInvHistoryPeriodUI();
    fetchItemHistory(); // Автоапдейт
};

window.switchHistoryItem = function() {
    const input = document.getElementById('history-item-switch');
    const val = input.value;
    if (!val) return;
    
    const list = window.globalItemsList && window.globalItemsList.length ? window.globalItemsList : allInventory;
    const item = list.find(i => (i.name || i.item_name) === val);
    if (item) {
        historyCurrentItemId = item.id || item.item_id;
        document.getElementById('history-modal-title').innerText = "Карточка движения: " + (item.name || item.item_name);
        fetchItemHistory();
    }
};

window.globalItemsList = [];

window.openItemHistory = async function(itemId, warehouseId) {
    historyCurrentItemId = itemId;
    const modal = document.getElementById('modal-item-history');
    
    document.getElementById('history-table-body').innerHTML = '<tr><td colspan="6" class="text-center p-20 text-muted">Загрузка данных...</td></tr>';
    document.getElementById('history-table-foot').innerHTML = '';
    
    const whFilter = document.getElementById('history-warehouse-filter');
    if (warehouseId && warehouseId !== 'all') {
        whFilter.value = warehouseId;
    } else {
        whFilter.value = 'all';
    }
    
    // Загружаем полный справочник товаров для умного поиска
    if (window.globalItemsList.length === 0) {
        try {
            const res = await API.get('/api/items?limit=2000');
            if (res && res.data) {
                window.globalItemsList = res.data;
            }
        } catch(e) {}
    }
    
    const datalist = document.getElementById('history-item-datalist');
    const searchSource = window.globalItemsList.length ? window.globalItemsList : allInventory;
    if (datalist) {
        datalist.innerHTML = '';
        searchSource.forEach(inv => {
            datalist.innerHTML += `<option value="${Utils.escapeHtml(inv.name || inv.item_name)}"></option>`;
        });
    }
    
    // Установка заголовка
    const itemObj = searchSource.find(i => String(i.id || i.item_id) === String(itemId));
    if (itemObj) {
        document.getElementById('history-modal-title').innerText = "Карточка движения: " + (itemObj.name || itemObj.item_name);
        const searchInput = document.getElementById('history-item-switch');
        if (searchInput) searchInput.value = itemObj.name || itemObj.item_name;
    } else {
        document.getElementById('history-modal-title').innerText = "Карточка движения";
    }

    invHistoryPeriodType = 'month';
    invHistoryPeriodValue = new Date().getMonth() + 1;
    invHistoryYear = new Date().getFullYear();
    renderInvHistoryPeriodUI();
    
    modal.classList.remove('d-none');
    modal.classList.add('d-flex');
    setTimeout(() => modal.classList.add('active'), 10);
    
    fetchItemHistory();
};

window.closeItemHistory = function() {
    const modal = document.getElementById('modal-item-history');
    modal.classList.remove('active');
    setTimeout(() => { modal.classList.remove('d-flex'); modal.classList.add('d-none'); }, 200);
    historyCurrentItemId = null;
};

window.fetchItemHistory = async function() {
    if (!historyCurrentItemId) return;

    try {
        const whId = document.getElementById('history-warehouse-filter').value;
        
        let start_date = '';
        let end_date = '';
        
        if (invHistoryPeriodType === 'day') {
            start_date = invHistorySpecificDate;
            end_date = invHistorySpecificDate;
        } else if (invHistoryPeriodType === 'week') {
            const now = new Date();
            const dayOfWeek = now.getDay() || 7;
            const monday = new Date(now);
            monday.setDate(now.getDate() - dayOfWeek + 1);
            start_date = monday.toISOString().split('T')[0];
            end_date = now.toISOString().split('T')[0];
        } else if (invHistoryPeriodType === 'year') {
            start_date = `${invHistoryYear}-01-01`;
            end_date = `${invHistoryYear}-12-31`;
        } else if (invHistoryPeriodType === 'quarter') {
            const startMonth = (invHistoryPeriodValue - 1) * 3 + 1;
            start_date = `${invHistoryYear}-${String(startMonth).padStart(2, '0')}-01`;
            const endDay = new Date(invHistoryYear, startMonth + 2, 0).getDate();
            end_date = `${invHistoryYear}-${String(startMonth + 2).padStart(2, '0')}-${endDay}`;
        } else if (invHistoryPeriodType === 'month') {
            start_date = `${invHistoryYear}-${String(invHistoryPeriodValue).padStart(2, '0')}-01`;
            const endDay = new Date(invHistoryYear, invHistoryPeriodValue, 0).getDate();
            end_date = `${invHistoryYear}-${String(invHistoryPeriodValue).padStart(2, '0')}-${endDay}`;
        } else if (invHistoryPeriodType === 'custom') {
            start_date = invHistoryCustomStart;
            end_date = invHistoryCustomEnd;
        }
        
        const params = new URLSearchParams({
            warehouse_id: whId,
            start_date: start_date,
            end_date: end_date
        });
        
        const res = await API.get(`/api/inventory/history/${historyCurrentItemId}?${params.toString()}`);
        
        currentItemHistoryStartBalance = res.startBalance || 0;
        currentItemHistoryData = res.history || [];
        currentItemHistoryPrice = res.currentPrice || 0;
        
        filterItemHistoryTable();
        
    } catch (e) {
        UI.toast(e.message || 'Ошибка загрузки истории', 'error');
        document.getElementById('history-table-body').innerHTML = `<tr><td colspan="6" class="text-center p-20 text-danger">Ошибка загрузки: ${Utils.escapeHtml(e.message)}</td></tr>`;
    }
};

let historySearchTimer = null;
window.debounceHistorySearch = function() {
    clearTimeout(historySearchTimer);
    historySearchTimer = setTimeout(() => {
        filterItemHistoryTable();
    }, 300);
}

window.filterItemHistoryTable = function() {
    const searchInput = document.getElementById('history-search-input');
    const query = searchInput ? searchInput.value.toLowerCase().trim() : '';
    
    // We filter the local array, but the "Balance" calculation should ideally only show the mathematical balance lines?
    // Wait, if we hide a line, the visible balance doesn't make sense chronologically.
    // However, users expect to search text across lines anyway. We'll recalculate balance physically for all lines, but only *render* lines that match the search. That way the balance at the end of a transaction is correct for that moment in time.
    
    renderItemHistoryTable(currentItemHistoryStartBalance, currentItemHistoryData, query);
}

function renderItemHistoryTable(startBalance, history, searchQuery = '') {
    const tbody = document.getElementById('history-table-body');
    const tfoot = document.getElementById('history-table-foot');
    
    let html = '';
    let currentBalance = parseFloat(startBalance);
    let sumIn = 0;
    let sumOut = 0;
    
    if (history.length === 0) {
        html += `<div class="p-20 text-center text-muted font-italic">Движений не найдено</div>`;
    } else {
        let matchCount = 0;
        let lastGroupKey = '';
        
        let unitStrShared = history.length > 0 && history[0].unit ? ' ' + Utils.escapeHtml(history[0].unit) : '';
        html += `
        <div class="mc-start-balance">
            <span>🏁 [Начало периода]</span>
            <span class="ms-2">Начальный остаток: <b>${parseFloat(startBalance).toLocaleString('ru-RU', {minimumFractionDigits: 2})}${unitStrShared}</b></span>
        </div>`;

        history.forEach(m => {
            const qty_in = parseFloat(m.qty_in || 0);
            const qty_out = parseFloat(m.qty_out || 0);
            const qty_diff = parseFloat(m.balance_diff !== undefined ? m.balance_diff : m.quantity);
            
            // For backward compatibility if API returns flat list during tests:
            const inQty = qty_in > 0 ? qty_in : (qty_diff > 0 ? qty_diff : 0);
            const outQty = qty_out > 0 ? qty_out : (qty_diff < 0 ? Math.abs(qty_diff) : 0);
            
            sumIn += inQty;
            sumOut += outQty;
            currentBalance += qty_diff;
            
            let dateObj = new Date(m.op_date || m.movement_date);
            let dateStr = dateObj.toLocaleString('ru-RU', {day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'});
            let dateDay = dateObj.toLocaleDateString('ru-RU', {day: '2-digit', month: '2-digit', year: 'numeric'});
            let timeStr = dateObj.toLocaleTimeString('ru-RU', {hour: '2-digit', minute: '2-digit'});
            
            let whFrom = m.warehouse_from;
            let whTo = m.warehouse_to;
            
            // Backwards compatibility with flat query
            if (!whFrom && !whTo && m.warehouse_name) {
                if (qty_diff > 0) whTo = m.warehouse_name;
                else whFrom = m.warehouse_name;
            }

            let typeName = typeof m.movement_types === 'string' ? m.movement_types.split(',')[0].trim() : (m.movement_type || 'неизвестно');
            typeName = getMovementTypeName(typeName);

            let routeClass = '';
            if (inQty > 0 && outQty > 0) routeClass = 'transfer';
            else if (inQty > 0) routeClass = 'in';
            else routeClass = 'out';

            let rawSource = whFrom ? Utils.escapeHtml(whFrom) : (m.supplier_name ? 'Поставщик' : 'Извне');
            if (m.type === 'production_receipt' || m.type === 'finished_receipt' || m.type === 'scrap_receipt' || m.type === 'markdown_receipt') {
                rawSource = 'Производство';
            } else if (m.type && m.type.includes('purchase')) {
                rawSource = 'Поставщик';
            }
            
            let rawDest = whTo ? Utils.escapeHtml(whTo) : (m.movement_type === 'sale' ? 'Клиент' : (m.movement_type === 'scrap' ? 'Утиль' : 'Списание'));
            
            let chips = [];
            if (m.supplier_name) {
                 chips.push(`<a class="chip" href="javascript:void(0)" onclick="app.openEntity('client', ${m.supplier_id})">Поставщик: ${Utils.escapeHtml(m.supplier_name)} 🔗</a>`);
            }
            if (m.order_doc) {
                 chips.push(`<a class="chip" href="javascript:void(0)" onclick="app.openEntity('document_order', ${m.order_id})">Заказ: ${Utils.escapeHtml(m.order_doc)} 🔗</a>`);
            }
            if (m.batch_number) {
                 chips.push(`<a class="chip" href="javascript:void(0)" onclick="openBatchCard(${m.batch_id})">Партия: #${Utils.escapeHtml(m.batch_number)} 🔗</a>`);
            }
            
            let decryption = chips.length > 0 ? chips.join('<span class="chip-sep"></span>') : '';

            let priceHtml = '';
            if (m.unit_price && parseFloat(m.unit_price) > 0) {
                 priceHtml += `<div>Цена: ${parseFloat(m.unit_price).toLocaleString('ru-RU', {minimumFractionDigits: 2})} ₽</div>`;
            }
            if (m.amount && parseFloat(m.amount) > 0) {
                 priceHtml += `<div>Сумма: ${parseFloat(m.amount).toLocaleString('ru-RU', {minimumFractionDigits: 2})} ₽</div>`;
            }

            if (searchQuery) {
                const searchStr = `${typeName} ${whFrom||''} ${whTo||''} ${m.supplier_name || ''} ${m.order_doc || ''} ${m.batch_number || ''} ${m.description || ''} ${dateStr}`.toLowerCase();
                if (!searchStr.includes(searchQuery)) {
                    return; 
                }
            }
            
            matchCount++;
            
            let unitStr = m.unit ? ' ' + Utils.escapeHtml(m.unit) : '';
            let inQtyStr = inQty > 0 ? '+' + inQty.toLocaleString('ru-RU', {minimumFractionDigits:2}) + unitStr : '';
            let outQtyStr = outQty > 0 ? '-' + outQty.toLocaleString('ru-RU', {minimumFractionDigits:2}) + unitStr : '';
            let balanceStr = currentBalance.toLocaleString('ru-RU', {minimumFractionDigits:2}) + unitStr;
            
            let amountHtml = '';
            if (inQty > 0 && outQty > 0) {
                 amountHtml = `<div class="mc-amount out mc-amount-sm">${outQtyStr}</div><div class="mc-amount in">${inQtyStr}</div>`;
            } else if (inQty > 0) {
                 amountHtml = `<div class="mc-amount in">${inQtyStr}</div>`;
            } else {
                 amountHtml = `<div class="mc-amount out">${outQtyStr}</div>`;
            }

            let groupKey = `${dateDay}_${typeName}_${rawSource}_${rawDest}_${m.supplier_name||''}`;

            if (groupKey !== lastGroupKey) {
                html += `
                <div class="mc-group-header">
                    <span class="mc-gh-date">[${dateDay}]</span>
                    <span class="mc-gh-type">${typeName}</span>
                    <span class="mc-gh-route">${rawSource} ➔ ${rawDest}</span>
                </div>`;
                lastGroupKey = groupKey;
            }

            // Подготовка источника
            let sourceIcon = m.user_name ? '👤' : '⚙️';
            let sourceName = m.user_name ? Utils.escapeHtml(m.user_name) : 'Система';

            // Раскраска цифр вместо фона карточки
            let amountColorClass = routeClass === 'in' ? 'text-success' : (routeClass === 'out' ? 'text-danger' : '');

            // Сборка строки описания: описание · сумма · контрагент
            let cleanDesc = (m.description || '');
            if (m.batch_number) cleanDesc = cleanDesc.replace(/,?\s*Партия[:\s#]*\S+/gi, '');
            if (m.order_doc) cleanDesc = cleanDesc.replace(/,?\s*(?:Заказ[у]?|по заказу)[:\s]*ЗК-\d+/gi, '');
            cleanDesc = cleanDesc.replace(/^[\s,|:]+|[\s,|:]+$/g, '').replace(/\s{2,}/g, ' ').trim();

            let descParts = [];
            if (cleanDesc) descParts.push(`📝 ${Utils.escapeHtml(cleanDesc)}`);
            if (m.amount && Math.abs(m.amount) > 0) descParts.push(`<b>Сумма: ${parseFloat(Math.abs(m.amount)).toLocaleString('ru-RU', {minimumFractionDigits: 2})} ₽</b>`);
            if (m.unit_price && parseFloat(m.unit_price) > 0) descParts.push(`Цена: ${parseFloat(m.unit_price).toLocaleString('ru-RU', {minimumFractionDigits: 2})} ₽`);
            if (m.order_doc) descParts.push(`Заказ: <span class="mc-link-text" onclick="app.openEntity('document_order', ${m.order_id})">${Utils.escapeHtml(m.order_doc)}</span>`);
            if (m.batch_number) descParts.push(`Партия: <span class="mc-link-text" onclick="openBatchCard(${m.batch_id})">#${Utils.escapeHtml(m.batch_number)}</span>`);
            if (m.supplier_name) descParts.push(`<span class="mc-link-text" onclick="app.openEntity('client', ${m.supplier_id})">${Utils.escapeHtml(m.supplier_name)}</span>`);

            let descHtml = descParts.length > 0 ? `
                <div class="mc-compact-col mc-col-desc">
                    ${descParts.join(' · ')}
                </div>` : '';

            // Сборка HTML карточки (без bgClass на обёртке)
            html += `
                <div class="movement-card mc-compact">
                    <div class="mc-compact-col mc-col-time">
                        🕒 <b>${timeStr}</b>
                    </div>
                    <div class="mc-compact-col mc-col-user">
                        ${sourceIcon} ${sourceName}
                    </div>
                    <div class="mc-compact-col mc-col-amount ${amountColorClass}">
                        ${amountHtml}
                    </div>
                    <div class="mc-compact-col mc-col-balance text-muted">
                        Ост: ${balanceStr}
                    </div>
                    ${descHtml}
                </div>
            `;
        });
        
        if (searchQuery && matchCount === 0) {
             html += `<div class="text-center p-20 text-muted font-italic">По вашему запросу ничего не найдено</div>`;
        }
    }
    
    tbody.innerHTML = html;
    
    tfoot.innerHTML = `
        <div class="mc-summary-bar">
            <div class="mc-summary-balance">Текущий остаток (Сальдо): <b>${currentBalance.toLocaleString('ru-RU', {minimumFractionDigits:2})}</b></div>
            <div class="mc-summary-totals">
                <span class="text-success" title="Суммарный приход за выбранный период">Приход: +${sumIn.toLocaleString('ru-RU', {minimumFractionDigits:2})}</span>
                <span class="text-danger" title="Суммарный расход за выбранный период">Расход: -${sumOut.toLocaleString('ru-RU', {minimumFractionDigits:2})}</span>
            </div>
        </div>
    `;
}
function getMovementTypeName(type) {
    const map = {
        'receipt': 'Поступление',
        'expense': 'Списание',
        'sale': 'Реализация (Отгрузка)',
        'prod_receipt': 'Производство (Продукция)',
        'prod_expense': 'Списание в производство',
        'audit': 'Инвентаризация',
        'move_in': 'Перемещение (Приход)',
        'move_out': 'Перемещение (Расход)',
        'scrap': 'Списание (Утиль / Брак)',
        'demold_receipt': 'Распалубка: Принято на склад',
        'demold_scrap': 'Распалубка: Брак продукта',
        'demold_expense': 'Распалубка: Исходник списан',
        'sifting_receipt': 'Просеивание: Выход',
        'sifting_expense': 'Просеивание: Исходник списан',
        'purchase': 'Закупка (Поступление)',
        'initial': 'Ввод начальных остатков',
        'audit_adjustment': 'Инвентаризация (Корректировка)',
        'production_expense': 'Списание в производство',
        'production_receipt': 'Выпуск продукции (Формовка)',
        'production_draft': 'Замес (Черновик)',
        'wip_receipt': 'Поступление в сушилку',
        'wip_expense': 'Списание из сушилки (Распалубка)',
        'finished_receipt': 'Принято на склад',
        'markdown_receipt': 'Перевод в уценку / 2-й сорт',
        'reserve_receipt': 'Возврат из Резерва (Приход)',
        'reserve_expense': 'Резервирование (Списание)',
        'customer_return': 'Возврат от клиента',
        'sales_shipment': 'Отгрузка клиенту (Реализация)',
        'shipment_reversal': 'Отмена отгрузки'
    };
    return map[type] || type;
}

// ------------------------------------------------------------------
// ИНТЕКРАКТИВНЫЕ КАРТОЧКИ (ДОСЬЕ И ПАРТИИ)
// ------------------------------------------------------------------



window.openBatchStatsModal = async function(batchId, batchNum) {
    if (!batchId) {
        UI.toast("Партия без ID", "warning");
        return;
    }
    const modal = document.getElementById('modal-batch-stats');
    if (!modal) return;
    modal.classList.remove('d-none');
    modal.classList.add('active');
    
    document.getElementById('batch-stats-title').innerText = "Информация о партии №" + batchNum;
    const body = document.getElementById('batch-stats-body');
    body.innerHTML = '<div class="p-20 text-center text-muted">Загрузка информации (Смета, Сырье)...</div>';
    
    try {
        const info = await API.get('/api/production/batch/' + batchId + '/info');
        const materials = await API.get('/api/production/batch/' + batchId + '/materials');
        
        let html = `<div class="p-15 bg-surface-alt border-bottom">
            <div class="flex-row gap-15">
                <div class="flex-grow-1">
                    <div class="font-12 text-muted">Статус партии:</div>
                    <div class="font-bold font-14">${info.status === 'completed' ? '🟢 Выпущена' : info.status === 'drying' ? '🟠 В сушилке' : '📝 Формуется'}</div>
                </div>
                <div class="flex-grow-1 text-right">
                    <div class="font-12 text-muted">Смена:</div>
                    <div class="font-bold font-14">${info.shift_name || 'Не указана'}</div>
                </div>
                <div class="flex-grow-1 text-right">
                    <div class="font-12 text-muted">Объем по плану:</div>
                    <div class="font-bold font-14">${parseFloat(info.planned_quantity || 0).toLocaleString('ru-RU')} ед.</div>
                </div>
            </div>
            
            <div class="mt-15 p-15 card bg-surface border flex-between">
                <div>
                   <p class="font-12 text-muted mb-0 mt-0">Себестоимость МАТ.</p>
                   <b class="font-16">${parseFloat(info.mat_cost_total || 0).toLocaleString('ru-RU')} ₽</b>
                </div>
                <div class="text-right">
                   <p class="font-12 text-muted mb-0 mt-0">Полная себест. (С накладными)</p>
                   <b class="font-16 text-primary">${(parseFloat(info.mat_cost_total||0) + parseFloat(info.overhead_cost_total||0) + parseFloat(info.machine_amort_cost||0)).toLocaleString('ru-RU')} ₽</b>
                </div>
            </div>
        </div>`;
        
        if (materials && materials.length > 0) {
            html += `<div class="p-15">
                <h4 class="mt-0 mb-10 text-muted">Состав сырья (Расход МАТ)</h4>
                <table class="table-modern w-100 font-13">
                    <thead class="bg-surface">
                        <tr><th class="text-left">Сырье</th><th class="text-right">Кг</th><th class="text-right">Сумма ₽</th></tr>
                    </thead>
                    <tbody>`;
            materials.forEach(m => {
                html += `<tr>
                    <td>${m.name}</td>
                    <td class="text-right">${parseFloat(m.qty).toLocaleString('ru-RU')} ${m.unit||'кг'}</td>
                    <td class="text-right font-bold">${parseFloat(m.cost).toLocaleString('ru-RU')} ₽</td>
                </tr>`;
            });
            html += `</tbody></table></div>`;
        } else {
            html += `<div class="p-20 text-center text-muted">Состав сырья не зафиксирован</div>`;
        }
        
        body.innerHTML = html;
        
    } catch(e) {
        body.innerHTML = `<div class="p-20 text-center text-danger border-top">Ошибка: Партия не найдена или удалена</div>`;
    }
}

// === КАРТОЧКА ПРОСЛЕЖИВАЕМОСТИ ПАРТИИ ===
window.openBatchCard = async function(batchId) {
    const modal = document.getElementById('modal-batch-card');
    const body = document.getElementById('batch-card-body');
    const title = document.getElementById('batch-card-title');
    const badges = document.getElementById('batch-card-badges');

    if (!modal || !body) return;

    // Loading state
    title.textContent = 'Загрузка...';
    badges.innerHTML = '';
    body.innerHTML = '<div class="p-20 text-center text-muted">⏳ Загрузка данных партии...</div>';
    modal.classList.remove('d-none');
    modal.classList.add('active');

    try {
        const data = await API.get(`/api/inventory/batch/${batchId}/card`);
        renderBatchCard(data, title, badges, body);
    } catch (e) {
        console.error('Ошибка загрузки карточки партии:', e);
        body.innerHTML = '<div class="p-20 text-center text-danger">Ошибка загрузки. Партия не найдена или удалена.</div>';
    }
};

function renderBatchCard(data, titleEl, badgesEl, bodyEl) {
    const b = data.batch;
    const d = data.drying;
    const o = data.order;
    const a = data.analytics;
    const out = data.outputs;

    // Header
    titleEl.textContent = `📋 ${b.batch_number}`;

    // Status badge
    let statusClass = 'batch-status-drying';
    let statusText = '🟢 В сушилке';
    if (a.is_closed) {
        statusClass = 'batch-status-closed';
        statusText = '⚪ Закрыта';
    } else if (d.progress_pct > 0) {
        statusClass = 'batch-status-partial';
        statusText = '🟡 Частично';
    }
    badgesEl.innerHTML = `
        <span class="batch-status-badge ${statusClass}">${statusText}</span>
        <span class="batch-age-badge">⏱ ${d.age_days} дн.</span>
    `;

    let html = '';

    // === Info Grid: Заказ + Состояние ===
    html += '<div class="batch-info-grid">';

    // Заказ
    html += '<div class="batch-order-card">';
    html += '<div class="batch-section-title">📋 Заказ</div>';
    if (o) {
        html += `<div class="mb-5"><strong>${Utils.escapeHtml(o.client_name || 'Без имени')}</strong></div>`;
        html += `<div class="text-muted font-13">Заказ: ${Utils.escapeHtml(o.doc_number)}</div>`;
        html += `<div class="text-muted font-13">Сумма: ${parseFloat(o.total_amount || 0).toLocaleString('ru-RU')} ₽</div>`;
    } else {
        html += '<div class="text-muted">🏭 На склад (без заказа)</div>';
    }
    html += '</div>';

    // Состояние
    html += '<div class="batch-progress-card">';
    html += '<div class="batch-section-title">📊 Состояние</div>';
    html += `<div class="batch-progress-bar"><div class="batch-progress-fill" style="width:${d.progress_pct}%"></div></div>`;
    html += `<div class="flex-between font-13">`;
    html += `<span>Вход: <strong>${d.total_in.toLocaleString('ru-RU')} ${b.product_unit}</strong></span>`;
    html += `<span>Выход: <strong>${d.total_out.toLocaleString('ru-RU')} ${b.product_unit}</strong></span>`;
    html += `</div>`;
    html += `<div class="text-muted font-12 mt-5">Остаток в сушилке: <strong>${d.remaining.toLocaleString('ru-RU')} ${b.product_unit}</strong></div>`;
    html += '</div>';

    html += '</div>'; // grid end

    // === Продукция ===
    html += '<div class="batch-section-card">';
    html += '<div class="batch-section-title">📦 Продукция</div>';
    html += `<div class="font-13">${Utils.escapeHtml(b.product_name)}</div>`;
    const prodDateStr = b.production_date ? new Date(b.production_date).toLocaleDateString('ru-RU') : '—';
    html += `<div class="text-muted font-12 mt-5">Объём: ${b.planned_quantity.toLocaleString('ru-RU')} ${b.product_unit} | Смена: ${b.shift_name || '—'} | Дата: ${prodDateStr}</div>`;
    html += '</div>';

    // === Аналитика ===
    html += '<div class="batch-section-card">';
    html += '<div class="batch-section-title">📈 Аналитика</div>';
    html += '<div class="batch-analytics-grid">';
    html += `<div class="batch-analytics-item"><div class="batch-analytics-value">${a.grade1_yield_pct !== null ? a.grade1_yield_pct + '%' : '—'}</div><div class="batch-analytics-label">Выход 1 сорта</div></div>`;
    html += `<div class="batch-analytics-item"><div class="batch-analytics-value">${d.remaining.toLocaleString('ru-RU')}</div><div class="batch-analytics-label">Остаток (${b.product_unit})</div></div>`;
    html += `<div class="batch-analytics-item"><div class="batch-analytics-value">${a.is_closed ? 'Закрыта' : 'Открыта'}</div><div class="batch-analytics-label">Статус партии</div></div>`;
    html += '</div>';

    // Распределение выхода
    if (out.grade1 > 0 || out.grade2 > 0 || out.scrap > 0) {
        html += '<div class="mt-10 font-12 text-muted">';
        html += `1 сорт: <strong class="text-success">${out.grade1.toLocaleString('ru-RU')}</strong> | `;
        html += `2 сорт: <strong class="text-warning">${out.grade2.toLocaleString('ru-RU')}</strong> | `;
        html += `Утиль: <strong class="text-danger">${out.scrap.toLocaleString('ru-RU')}</strong>`;
        html += '</div>';
    }
    html += '</div>';

    // === Сырьё и Экономика ===
    html += '<div class="batch-section-card">';
    html += '<div class="batch-section-title">💰 Сырьё и Экономика</div>';
    if (data.materials.length > 0) {
        data.materials.forEach(m => {
            html += `<div class="batch-cost-row"><span>${Utils.escapeHtml(m.name)} — ${m.qty.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${m.unit}</span><span>${m.cost.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽</span></div>`;
        });
        html += `<div class="batch-cost-row"><span>ИТОГО себестоимость</span><span>${b.costs.total.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽  (${b.costs.per_unit.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽/ед.)</span></div>`;
    } else {
        html += '<div class="text-muted font-13">Материалы не зафиксированы</div>';
    }
    html += '</div>';

    // === История этапов ===
    html += '<div class="batch-section-card">';
    html += '<div class="batch-section-title">📜 История этапов</div>';
    if (data.movements.length > 0) {
        data.movements.forEach(m => {
            const isPositive = m.quantity > 0;
            const qtyClass = isPositive ? 'batch-movement-in' : 'batch-movement-out';
            const sign = isPositive ? '+' : '';
            html += `<div class="batch-movement-row">`;
            html += `<span class="text-muted">${Utils.escapeHtml(m.date)}</span>`;
            html += `<span>${Utils.escapeHtml(m.warehouse_name || '')}</span>`;
            html += `<span class="${qtyClass}">${sign}${m.quantity.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ${m.unit || ''}</span>`;
            html += `</div>`;
        });
    } else {
        html += '<div class="text-muted font-13">Движений пока нет</div>';
    }
    html += '</div>';



    bodyEl.innerHTML = html;
}