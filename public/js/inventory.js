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
let demoldPackagingCheckSupported = true;
let demoldKitMaterialsCache = null;
let inventoryDensity = 'compact';
let showFinishedBatches = false;
let subtractFinishedReserves = false;
let reserveFilters = {
    status: 'active',
    view: 'orders',
    product: '',
    order: '',
    preset: 'none'
};
let reserveRebalanceInFlight = false;
/** Суммировать остатки склада готовой продукции и резерва (4+7) одной строкой на товар. */
let mergeFinishedWithReserve = false;
try {
    mergeFinishedWithReserve = localStorage.getItem('invMergeFgReserve') === '1';
} catch (_) {}

function applyInventoryDensity() {
    const mod = document.getElementById('stock-mod');
    const btn = document.getElementById('inventory-density-btn');
    const density = inventoryDensity === 'standard' ? 'standard' : 'compact';
    if (mod) {
        mod.classList.toggle('inv-density-compact', density === 'compact');
        mod.classList.toggle('inv-density-standard', density === 'standard');
    }
    if (btn) {
        btn.textContent = density === 'compact' ? 'Плотность: компактно' : 'Плотность: стандарт';
    }
    try { localStorage.setItem('inventoryDensity', density); } catch (_) {}
}

window.toggleInventoryDensity = function() {
    inventoryDensity = inventoryDensity === 'compact' ? 'standard' : 'compact';
    applyInventoryDensity();
}

window.openInventoryOrder = function(orderId) {
    if (!orderId) return;
    try {
        if (window.app && typeof window.app.openEntity === 'function') {
            window.app.openEntity('document_order', Number(orderId));
            return;
        }
    } catch (_) {}
    UI.toast('Откройте модуль "Продажи" для просмотра заказа', 'info');
};

function formatReserveOrderStatus(statusRaw) {
    const s = String(statusRaw || '').toLowerCase();
    if (s === 'pending') return 'Ожидает';
    if (s === 'processing') return 'В работе';
    if (s === 'completed') return 'Завершен';
    if (s === 'cancelled') return 'Отменен';
    return statusRaw || '—';
}

window.onReserveFilterChange = function() {
    reserveFilters.status = String(document.getElementById('inv-reserve-status')?.value || 'active');
    reserveFilters.view = String(document.getElementById('inv-reserve-view')?.value || 'orders');
    reserveFilters.product = String(document.getElementById('inv-reserve-product')?.value || '');
    reserveFilters.order = String(document.getElementById('inv-reserve-order')?.value || '');
    reserveFilters.preset = 'none';
    syncReservePresetButtons();
    renderInventoryTable();
};

function syncReservePresetButtons() {
    const map = {
        deficit: 'inv-reserve-preset-deficit',
        completed_only: 'inv-reserve-preset-completed',
        unlinked_only: 'inv-reserve-preset-unlinked'
    };
    Object.values(map).forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.classList.remove('active');
    });
    const activeId = map[reserveFilters.preset];
    if (activeId) {
        const activeEl = document.getElementById(activeId);
        if (activeEl) activeEl.classList.add('active');
    }
}

window.applyReservePreset = function(preset) {
    const statusSel = document.getElementById('inv-reserve-status');
    const viewSel = document.getElementById('inv-reserve-view');
    const productSel = document.getElementById('inv-reserve-product');
    const orderSel = document.getElementById('inv-reserve-order');
    if (preset === 'reset') {
        reserveFilters = { status: 'active', view: 'orders', product: '', order: '', preset: 'none' };
        if (statusSel) statusSel.value = reserveFilters.status;
        if (viewSel) viewSel.value = reserveFilters.view;
        if (productSel) productSel.value = '';
        if (orderSel) orderSel.value = '';
        syncReservePresetButtons();
        renderInventoryTable();
        return;
    }
    reserveFilters.preset = preset;
    if (preset === 'deficit') {
        reserveFilters.status = 'active';
        reserveFilters.view = 'orders';
        reserveFilters.product = '';
        reserveFilters.order = '';
    } else if (preset === 'completed_only') {
        reserveFilters.status = 'completed';
        reserveFilters.view = 'orders';
    } else if (preset === 'unlinked_only') {
        reserveFilters.status = 'all';
        reserveFilters.view = 'orders';
        reserveFilters.order = '';
    }
    if (statusSel) statusSel.value = reserveFilters.status;
    if (viewSel) viewSel.value = reserveFilters.view;
    if (productSel && !reserveFilters.product) productSel.value = '';
    if (orderSel && !reserveFilters.order) orderSel.value = '';
    syncReservePresetButtons();
    renderInventoryTable();
};

function syncReserveControlsVisibility() {
    const panel = document.getElementById('inv-reserve-controls');
    const summary = document.getElementById('inv-reserve-summary');
    if (!panel) return;
    panel.classList.toggle('inv-hidden', currentWarehouseFilter !== '7');
    if (summary) summary.classList.toggle('inv-hidden', currentWarehouseFilter !== '7');
}

function syncFinishedControlsVisibility() {
    const panel = document.getElementById('inv-finished-controls');
    if (!panel) return;
    const show = currentWarehouseFilter === '4' && !isAuditMode;
    panel.classList.toggle('inv-hidden', !show);
}

function syncMergeFgControlsVisibility() {
    const wrap = document.getElementById('inv-merge-fg-controls');
    if (!wrap) return;
    const show = !isAuditMode && (currentWarehouseFilter === 'all' || currentWarehouseFilter === '4');
    wrap.classList.toggle('inv-hidden', !show);
}

function buildReserveQtyByItemFromAllInventory() {
    const m = {};
    (allInventory || []).forEach((r) => {
        if (String(r.warehouse_type) === 'reserve') {
            const k = String(r.item_id);
            m[k] = (m[k] || 0) + Number(r.total || 0);
        }
    });
    return m;
}

/**
 * Для фильтра «Все склады»: одна строка на товар по ГП+резерв.
 * Сумма по физическим движениям: внутренние перераспределения 4↔7 дают ноль в сумме двух складов.
 */
function mergeFinishedReservePoolRows(rows) {
    const pool = [];
    const rest = [];
    for (const r of rows || []) {
        const t = String(r.warehouse_type || '');
        if (t === 'finished' || t === 'reserve') pool.push(r);
        else rest.push(r);
    }
    const byItem = new Map();
    for (const r of pool) {
        const k = String(r.item_id);
        if (!byItem.has(k)) {
            byItem.set(k, {
                ...r,
                warehouse_name: 'ГП + Резерв (4+7)',
                warehouse_type: 'finished',
                batch_id: null,
                batch_number: '—',
                linked_order_item_id: null,
                order_doc_number: null,
                order_id: null,
                order_client_name: null,
                order_status: null,
                order_qty_ordered: null,
                order_qty_reserved: null,
                order_qty_shipped: null,
                reserve_qty_by_batch: 0,
                total: 0
            });
        }
        const agg = byItem.get(k);
        agg.total = Number(agg.total || 0) + Number(r.total || 0);
        agg.reserve_qty_by_batch = Number(agg.reserve_qty_by_batch || 0) + Number(r.reserve_qty_by_batch || 0);
    }
    const merged = Array.from(byItem.values()).sort((a, b) =>
        String(a.item_name || '').localeCompare(String(b.item_name || ''), 'ru')
    );
    return rest.concat(merged);
}

window.onMergeFgReserveChange = function () {
    const chk = document.getElementById('inv-merge-fg-reserve-check');
    mergeFinishedWithReserve = Boolean(chk && chk.checked);
    try {
        localStorage.setItem('invMergeFgReserve', mergeFinishedWithReserve ? '1' : '0');
    } catch (_) {}
    currentPage = 1;
    renderInventoryTable();
};

async function triggerReserveRebalance(btnEl) {
    if (reserveRebalanceInFlight) return;
    reserveRebalanceInFlight = true;
    const btn = btnEl || document.querySelector('#stock-mod .inv-reserve-btn.filter-btn.active');
    const prevHtml = btn ? btn.innerHTML : '';
    if (btn) {
        btn.classList.add('disabled');
        btn.innerHTML = '⏳ Склад №7 (Резервы)';
    }
    try {
        await API.post('/api/inventory/rebalance-reserves', {});
        await loadTable();
    } catch (_) {
        // Тихий режим: не блокируем пользователя и не спамим UI ошибками.
    } finally {
        if (btn) {
            btn.classList.remove('disabled');
            btn.innerHTML = prevHtml || '🔒 Склад №7 (Резервы)';
        }
        reserveRebalanceInFlight = false;
    }
}

window.onFinishedViewOptionsChange = function() {
    showFinishedBatches = Boolean(document.getElementById('inv-show-batches-check')?.checked);
    subtractFinishedReserves = Boolean(document.getElementById('inv-subtract-reserves-check')?.checked);
    currentPage = 1;
    renderInventoryTable();
};

function processInventoryForView(data, showBatches, subtractReserves) {
    if (!Array.isArray(data)) return [];
    let rows = data;
    if (!showBatches) {
        const grouped = new Map();
        for (const row of rows) {
            const key = String(row.item_id || '');
            if (!key) continue;
            if (!grouped.has(key)) {
                grouped.set(key, {
                    ...row,
                    batch_id: null,
                    batch_number: 'Общая',
                    reserve_qty_by_batch: 0,
                    total: 0
                });
            }
            const item = grouped.get(key);
            item.total = Number(item.total || 0) + Number(row.total || 0);
            item.reserve_qty_by_batch = Number(item.reserve_qty_by_batch || 0) + Number(row.reserve_qty_by_batch || 0);
        }
        rows = Array.from(grouped.values());
    }
    return rows.map((row) => {
        const total = Number(row.total || 0);
        const reserve = Number(row.reserve_qty_by_batch || 0);
        const rawDisplay = subtractReserves ? Math.max(0, total - reserve) : total;
        return {
            ...row,
            display_qty: Number(rawDisplay.toFixed(4))
        };
    });
}

function syncReserveSelectors(rows) {
    const productSel = document.getElementById('inv-reserve-product');
    const orderSel = document.getElementById('inv-reserve-order');
    if (!productSel || !orderSel) return;

    const prevProduct = reserveFilters.product;
    const prevOrder = reserveFilters.order;
    const products = [];
    const orders = [];
    const seenProduct = new Set();
    const seenOrder = new Set();
    rows.forEach((r) => {
        const pKey = String(r.item_id || '');
        if (pKey && !seenProduct.has(pKey)) {
            seenProduct.add(pKey);
            products.push({ id: pKey, name: String(r.item_name || '') });
        }
        const oKey = String(r.order_id || '');
        if (oKey && !seenOrder.has(oKey)) {
            seenOrder.add(oKey);
            orders.push({
                id: oKey,
                doc: String(r.order_doc_number || ''),
                client: String(r.order_client_name || '')
            });
        }
    });
    products.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    orders.sort((a, b) => a.doc.localeCompare(b.doc, 'ru'));

    productSel.innerHTML = '<option value="">Все виды</option>' + products.map((p) =>
        `<option value="${p.id}">${Utils.escapeHtml(p.name)}</option>`
    ).join('');
    orderSel.innerHTML = '<option value="">Все заказы</option>' + orders.map((o) =>
        `<option value="${o.id}">${Utils.escapeHtml(o.doc)}${o.client ? ` | ${Utils.escapeHtml(o.client)}` : ''}</option>`
    ).join('');

    productSel.value = products.some((p) => p.id === prevProduct) ? prevProduct : '';
    orderSel.value = orders.some((o) => o.id === prevOrder) ? prevOrder : '';
    reserveFilters.product = productSel.value;
    reserveFilters.order = orderSel.value;
}

function renderReserveSummary(rows, finishedByItem, reservedByItem) {
    const box = document.getElementById('inv-reserve-summary');
    if (!box) return;
    if (currentWarehouseFilter !== '7') {
        box.classList.add('inv-hidden');
        box.innerHTML = '';
        return;
    }
    const list = Array.isArray(rows) ? rows : [];
    const uniqOrders = new Set();
    const uniqItems = new Set();
    let totalReserveRows = 0;
    let totalNeedReserve = 0;
    let deficitOrders = 0;
    list.forEach((r) => {
        const rowQty = Number(r.total || 0);
        const qtyOrdered = Number(r.order_qty_ordered || 0);
        const qtyShipped = Number(r.order_qty_shipped || 0);
        const qtyReserved = Number(r.order_qty_reserved || 0);
        const qtyNeedReserve = Math.max(Math.max(qtyOrdered - qtyShipped, 0) - qtyReserved, 0);
        totalReserveRows += rowQty;
        totalNeedReserve += qtyNeedReserve;
        if (qtyNeedReserve > 0.0001) deficitOrders += 1;
        if (r.order_id) uniqOrders.add(String(r.order_id));
        if (r.item_id) uniqItems.add(String(r.item_id));
    });
    let totalFreeWh4 = 0;
    let totalReserveWh7ByItem = 0;
    uniqItems.forEach((itemId) => {
        totalFreeWh4 += Number(finishedByItem[itemId] || 0);
        totalReserveWh7ByItem += Number(reservedByItem[itemId] || 0);
    });
    const fmt = (v) => Number(v || 0).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
    box.innerHTML = `
        <div class="inv-reserve-summary-chip"><span class="text-muted">Позиций:</span> <b>${list.length}</b></div>
        <div class="inv-reserve-summary-chip"><span class="text-muted">Заказов:</span> <b>${uniqOrders.size}</b></div>
        <div class="inv-reserve-summary-chip"><span class="text-muted">Резерв (строки):</span> <b>${fmt(totalReserveRows)}</b></div>
        <div class="inv-reserve-summary-chip"><span class="text-muted">Нужно дозарезервировать:</span> <b class="${totalNeedReserve > 0 ? 'text-danger' : 'text-success'}">${fmt(totalNeedReserve)}</b></div>
        <div class="inv-reserve-summary-chip"><span class="text-muted">Склад №4 свободно (по товарам выборки):</span> <b>${fmt(totalFreeWh4)}</b></div>
        <div class="inv-reserve-summary-chip"><span class="text-muted">Склад №7 в резерве (по товарам выборки):</span> <b>${fmt(totalReserveWh7ByItem)}</b></div>
        <div class="inv-reserve-summary-chip"><span class="text-muted">Заказов с дефицитом:</span> <b class="${deficitOrders > 0 ? 'text-danger' : 'text-success'}">${deficitOrders}</b></div>
    `;
}

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

function initInventoryDatePickerIfNeeded() {
    const dateEl = document.getElementById('inventory-date-filter');
    if (!dateEl || inventoryDatePicker || typeof flatpickr === 'undefined') return;
    inventoryDatePicker = flatpickr(dateEl, {
        dateFormat: 'Y-m-d',
        altInput: true,
        altFormat: 'd.m.Y',
        altInputClass: 'input-modern inv-date-flat-alt',
        locale: 'ru',
        defaultDate: new Date(),
        onChange: function (_selectedDates, _dateStr, _instance) {
            loadTable();
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
    void updateInventoryCalendarMarks();
}

/** Смена выбранной даты остатков на ±1 день (локальная дата, без UTC-смещения). */
window.inventoryShiftFilterDate = function (delta) {
    const step = Number(delta || 0);
    if (!step) return;
    initInventoryDatePickerIfNeeded();
    if (!inventoryDatePicker) return;
    const src = inventoryDatePicker.selectedDates[0]
        ? new Date(inventoryDatePicker.selectedDates[0])
        : new Date();
    const base = new Date(src.getFullYear(), src.getMonth(), src.getDate());
    base.setDate(base.getDate() + step);
    inventoryDatePicker.setDate(base, true);
};

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
    applyInventoryDensity();
    initInventoryDatePickerIfNeeded();

    let params = [];
    if (inventoryDatePicker && inventoryDatePicker.selectedDates.length > 0) {
        params.push(`as_of_date=${inventoryDatePicker.formatDate(inventoryDatePicker.selectedDates[0], "Y-m-d")}`);
    }
    if (isAuditMode && ['all', '1', '4', '5'].includes(currentWarehouseFilter)) {
        const toggle = document.getElementById('show-zeros-check');
        if (toggle && toggle.checked) {
            params.push(`showZeros=true`);
        }
        params.push(`wh=${currentWarehouseFilter}`);
    }
    
    const queryString = params.length > 0 ? '?' + params.join('&') : '';

    API.get('/api/inventory' + queryString)
        .then(data => {
            allInventory = data;
            // Строим карту WAREHOUSE_IDS из загруженных данных (аналог sales.js)
            if (!window.WAREHOUSE_IDS) window.WAREHOUSE_IDS = {};
            (data || []).forEach(row => {
                if (row.warehouse_type && !window.WAREHOUSE_IDS[row.warehouse_type]) {
                    window.WAREHOUSE_IDS[row.warehouse_type] = row.warehouse_id;
                }
            });
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
    syncReserveControlsVisibility();
    syncFinishedControlsVisibility();
    syncMergeFgControlsVisibility();
    document.querySelectorAll('#stock-mod .filter-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    renderInventoryTable();
    if (id === '7') {
        void triggerReserveRebalance(btn);
    }

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

function syncAuditUI(auditEnabled) {
    const controlsToToggle = document.querySelectorAll('#stock-mod .hide-in-audit');
    controlsToToggle.forEach((el) => {
        el.classList.toggle('inv-hidden', auditEnabled);
    });

    // На всякий случай закрываем открытые export dropdown при входе в ревизию
    if (auditEnabled) {
        document.querySelectorAll('#stock-mod .dropdown-menu').forEach((menu) => menu.classList.add('inv-hidden'));
    }
    syncFinishedControlsVisibility();
    syncMergeFgControlsVisibility();
}

window.toggleAuditMode = function () {
    // Разрешаем ревизию на вкладке "Все склады" для 1, 4, 5
    if (['3', '6', '7'].includes(currentWarehouseFilter) && !isAuditMode) {
        return UI.toast('На этом складе ревизия недоступна!', 'warning');
    }

    isAuditMode = !isAuditMode;
    const btnMode = document.getElementById('btn-audit-mode');
    const auditControls = document.getElementById('audit-controls');

    if (isAuditMode) {
        btnMode.classList.replace('btn-outline', 'btn-red');
        btnMode.innerText = '❌ Отменить инвентаризацию';
        if (auditControls) auditControls.classList.remove('inv-hidden');
        syncAuditUI(true);
        UI.toast('Режим инвентаризации включен. Введите фактические остатки.', 'info');
    } else {
        btnMode.classList.replace('btn-red', 'btn-outline');
        btnMode.innerText = '📋 Ревизия';
        if (auditControls) auditControls.classList.add('inv-hidden');
        syncAuditUI(false);
    }
    // ЗАГРУЖАЕМ новые данные с сервера, чтобы получить нулевые позиции
    loadTable();
};

// === РЕЖИМ ИНВЕНТАРИЗАЦИИ ===
window.saveAudit = async function () {
    const inputs = document.querySelectorAll('.audit-qty-input');
    let adjustments = [];
    let zeroedItems = [];
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
            // Маркируем рискованные полные обнуления для явного подтверждения в модалке
            if (newQty === 0 && oldQty > 0) {
                zeroedItems.push({ oldQty });
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
    const warningHtml = zeroedItems.length
        ? `<div class="text-danger mb-10">Внимание: полных обнулений позиций: <b>${zeroedItems.length}</b>. Проверьте внимательно.</div>`
        : '';
    UI.showModal('Подтверждение ревизии', `
        ${warningHtml}
        <div class="mb-10">Будет изменено позиций: <b>${adjustments.length}</b></div>
        <div class="form-group m-0">
            <label>Причина ревизии (обязательно)</label>
            <textarea id="inventory-audit-reason" class="input-modern" rows="3" placeholder="Например: плановая ревизия склада"></textarea>
        </div>
    `, `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-blue" onclick="confirmSaveAudit()">Применить</button>
    `);
    window.__pendingAuditPayload = { warehouseId: currentWarehouseFilter, adjustments, auditDate: auditDateStr };
};

window.confirmSaveAudit = async function() {
    const pending = window.__pendingAuditPayload;
    if (!pending) return;
    const reason = (document.getElementById('inventory-audit-reason')?.value || '').trim();
    if (!reason) return UI.toast('Укажите причину ревизии', 'warning');
    try {
        await API.post('/api/inventory/audit', { ...pending, reason });
        UI.closeModal();
        window.__pendingAuditPayload = null;
        UI.toast('✅ Ревизия успешно проведена!', 'success');
        toggleAuditMode();
        loadTable();
    } catch (e) {
        console.error(e);
    }
};

function renderInventoryTable() {
    const tbody = document.getElementById('inventory-table');
    const thead = document.getElementById('inventory-thead');
    if (!tbody) return;
    tbody.innerHTML = '';

    const isReserveView = currentWarehouseFilter === '7';
    syncReserveControlsVisibility();
    syncFinishedControlsVisibility();
    syncMergeFgControlsVisibility();

    const mergeChkEl = document.getElementById('inv-merge-fg-reserve-check');
    if (mergeChkEl) mergeChkEl.checked = mergeFinishedWithReserve;

    // Динамический заголовок: Склад №7 показывает колонку "Заказ"
    if (thead) {
        if (isReserveView) {
            thead.innerHTML = `<tr class="inv-thead-reserve">
                <th class="inv-col-batch">№ Партии</th>
                <th class="inv-col-name">Наименование</th>
                <th class="inv-col-order">Заказ</th>
                <th class="inv-col-qty">Остаток</th>
                <th class="inv-col-unit">Ед.</th>
                <th class="inv-col-actions">Действия</th>
            </tr>`;
        } else {
            thead.innerHTML = `<tr class="inv-thead-stock">
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

    let nonReserveWorking = filtered;
    if (!isReserveView && mergeFinishedWithReserve && currentWarehouseFilter === 'all') {
        nonReserveWorking = mergeFinishedReservePoolRows(filtered);
    }
    const reserveSumByItem = buildReserveQtyByItemFromAllInventory();

    if (isReserveView) {
        syncReserveSelectors(filtered);
    }

    let reserveRows = filtered;
    if (isReserveView) {
        reserveRows = filtered.filter((r) => {
            if (!r.linked_order_item_id) return false;
            const status = String(r.order_status || '').toLowerCase();
            const qtyOrdered = Number(r.order_qty_ordered || 0);
            const qtyShipped = Number(r.order_qty_shipped || 0);
            const qtyReserved = Number(r.order_qty_reserved || 0);
            const qtyRemaining = Math.max(qtyOrdered - qtyShipped, 0);
            const qtyNeedReserve = Math.max(qtyRemaining - qtyReserved, 0);
            if (reserveFilters.status === 'completed' && status !== 'completed') return false;
            if (reserveFilters.status === 'active' && status === 'completed') return false;
            if (reserveFilters.product && String(r.item_id) !== String(reserveFilters.product)) return false;
            if (reserveFilters.order && String(r.order_id || '') !== String(reserveFilters.order)) return false;
            if (reserveFilters.preset === 'deficit' && !(qtyNeedReserve > 0.0001)) return false;
            if (reserveFilters.preset === 'unlinked_only' && r.order_id) return false;
            return true;
        });
        // В режиме "По отдельным заказам" схлопываем строки одного заказа по партиям,
        // чтобы не показывать дубли по linked_order_item_id.
        if (reserveFilters.view === 'orders') {
            const groupedByOrder = new Map();
            reserveRows.forEach((r) => {
                const key = `${String(r.linked_order_item_id || '')}:${String(r.item_id || '')}`;
                if (!groupedByOrder.has(key)) {
                    groupedByOrder.set(key, {
                        ...r,
                        total: 0,
                        __batchCount: 0,
                        __batchKeys: new Set()
                    });
                }
                const item = groupedByOrder.get(key);
                item.total = Number(item.total || 0) + Number(r.total || 0);
                item.__batchKeys.add(String(r.batch_id ?? 'null'));
                if (r.batch_id) item.__batchCount += 1;
                // Если у заказа несколько партий, убираем конкретный batch из строки
                // и показываем как агрегированную позицию.
                if (item.__batchKeys.size > 1) {
                    item.batch_id = null;
                    item.batch_number = '';
                }
            });
            reserveRows = Array.from(groupedByOrder.values());
            // Сортировка: группировка по номеру заказа, вторично по наименованию.
            // Это нужно для UX: позиции одного заказа идут подряд.
            reserveRows.sort((a, b) => {
                const aOrder = String(a.order_doc_number || a.order_id || '');
                const bOrder = String(b.order_doc_number || b.order_id || '');
                if (aOrder !== bOrder) return aOrder.localeCompare(bOrder, 'ru', { numeric: true });
                const aName = String(a.item_name || '');
                const bName = String(b.item_name || '');
                if (aName !== bName) return aName.localeCompare(bName, 'ru', { numeric: true });
                const aCoi = String(a.linked_order_item_id || '');
                const bCoi = String(b.linked_order_item_id || '');
                return aCoi.localeCompare(bCoi, 'ru', { numeric: true });
            });
        }
    }
    const sourceRows = isReserveView
        ? reserveRows
        : (currentWarehouseFilter === '4'
            ? (() => {
                const effBatches = mergeFinishedWithReserve ? false : showFinishedBatches;
                const effSubtract = subtractFinishedReserves && !mergeFinishedWithReserve;
                const processed = processInventoryForView(filtered, effBatches, effSubtract);
                if (!mergeFinishedWithReserve) return processed;
                return processed.map((r) => {
                    if (String(r.warehouse_type) !== 'finished') return r;
                    const add = Number(reserveSumByItem[String(r.item_id)] || 0);
                    if (add <= 0.00001) return r;
                    const base = Number(r.total || 0);
                    const sum = base + add;
                    return {
                        ...r,
                        warehouse_name: `${r.warehouse_name || 'Готовая продукция'} + резерв`,
                        total: sum,
                        display_qty: Number(sum.toFixed(4))
                    };
                });
            })()
            : nonReserveWorking);
    const pagesBy = Math.ceil(sourceRows.length / itemsPerPage) || 1;
    if (currentPage > pagesBy) currentPage = pagesBy;
    const startIdx = (currentPage - 1) * itemsPerPage;
    const paginated = sourceRows.slice(startIdx, startIdx + itemsPerPage);

    const summaryText = document.getElementById('inventory-summary-text');
    const summaryTotal = sourceRows.length;
    if (summaryText) summaryText.innerText = summaryTotal > 0 ? `Показано ${startIdx + 1} - ${Math.min(startIdx + itemsPerPage, summaryTotal)} из ${summaryTotal}` : '0 записей';

    const paginationContainer = document.getElementById('inventory-pagination');
    if (paginationContainer) {
        let pagesHtml = '';
        if (pagesBy > 1) {
            pagesHtml += `<button class="btn btn-sm btn-outline" ${currentPage === 1 ? 'disabled' : ''} onclick="goToPage(${currentPage - 1})">Пред</button>`;
            let startPage = Math.max(1, currentPage - 2);
            let endPage = Math.min(pagesBy, currentPage + 2);
            if (startPage > 1) pagesHtml += `<button class="btn btn-sm btn-outline" onclick="goToPage(1)">1</button>${startPage > 2 ? '<span class="text-muted">...</span>' : ''}`;
            for (let i = startPage; i <= endPage; i++) {
                pagesHtml += `<button class="btn btn-sm ${i === currentPage ? 'btn-blue' : 'btn-outline'}" onclick="goToPage(${i})">${i}</button>`;
            }
            if (endPage < pagesBy) pagesHtml += `${endPage < pagesBy - 1 ? '<span class="text-muted">...</span>' : ''}<button class="btn btn-sm btn-outline" onclick="goToPage(${pagesBy})">${pagesBy}</button>`;
            pagesHtml += `<button class="btn btn-sm btn-outline" ${currentPage === pagesBy ? 'disabled' : ''} onclick="goToPage(${currentPage + 1})">След</button>`;
        }
        paginationContainer.innerHTML = pagesHtml;
    }

    if (paginated.length === 0) {
        tbody.innerHTML = `<tr><td colspan="${colSpan}" class="inv-empty-row">По вашему запросу ничего не найдено</td></tr>`;
        return;
    }

    const finishedByItem = {};
    const reservedByItem = {};
    (allInventory || []).forEach((r) => {
        const itemId = String(r.item_id || '');
        if (!itemId) return;
        const qty = Number(r.total || 0);
        if (String(r.warehouse_id) === '4') finishedByItem[itemId] = (finishedByItem[itemId] || 0) + qty;
        if (String(r.warehouse_id) === '7') reservedByItem[itemId] = (reservedByItem[itemId] || 0) + qty;
    });
    if (isReserveView) renderReserveSummary(sourceRows, finishedByItem, reservedByItem);

    if (isReserveView && reserveFilters.view === 'products') {
        const grouped = new Map();
        paginated.forEach((r) => {
            const key = String(r.item_id || '');
            if (!grouped.has(key)) {
                grouped.set(key, {
                    item_id: r.item_id,
                    item_name: r.item_name,
                    unit: r.unit,
                    reserve_qty: 0,
                    rows: []
                });
            }
            const g = grouped.get(key);
            g.reserve_qty += Number(r.total || 0);
            g.rows.push(r);
        });
        [...grouped.values()].forEach((g) => {
            const itemKey = String(g.item_id || '');
            const freeQty = Number(finishedByItem[itemKey] || 0);
            const reserveTotal = Number(reservedByItem[itemKey] || 0);
            const orderRowsByOrder = new Map();
            g.rows.forEach((o) => {
                const orderKey = String(o.linked_order_item_id || o.order_id || '');
                if (!orderRowsByOrder.has(orderKey)) {
                    orderRowsByOrder.set(orderKey, {
                        ...o,
                        total: 0
                    });
                }
                const groupedOrder = orderRowsByOrder.get(orderKey);
                groupedOrder.total = Number(groupedOrder.total || 0) + Number(o.total || 0);
            });
            const orderRows = Array.from(orderRowsByOrder.values());
            const orderList = orderRows.slice(0, 4).map((o) => {
                const doc = Utils.escapeHtml(o.order_doc_number || 'Без заказа');
                const client = Utils.escapeHtml(o.order_client_name || '—');
                const qty = Number(o.total || 0).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
                if (o.order_id) {
                    return `<a href="javascript:void(0)" class="inv-reserve-order-link" onclick="openInventoryOrder(${o.order_id})">${doc}</a> (${client}) — ${qty}`;
                }
                return `${doc} (${client}) — ${qty}`;
            }).join('<br>');
            const fullNameEscaped = Utils.escapeHtml(g.item_name || '');
            tbody.innerHTML += `
            <tr>
                <td class="inv-batch-cell"><span class="text-muted">—</span></td>
                <td class="inv-name-cell" title="${fullNameEscaped}">
                    <a href="javascript:void(0)" onclick="openItemHistory(${g.item_id}, 7)" class="text-primary text-decoration-none" title="${fullNameEscaped}">
                        <strong>${Utils.escapeHtml(g.item_name || '')}</strong>
                    </a>
                </td>
                <td class="inv-reserve-order-cell">
                    <div class="inv-reserve-order-metrics">Склад №4 свободно: <b>${freeQty.toLocaleString('ru-RU', { maximumFractionDigits: 2 })}</b></div>
                    <div class="inv-reserve-order-metrics">Склад №7 в резерве: <b>${reserveTotal.toLocaleString('ru-RU', { maximumFractionDigits: 2 })}</b></div>
                    <div class="inv-reserve-order-metrics mt-5">${orderList}${orderRows.length > 4 ? '<br><span class="text-muted">...и еще заказы</span>' : ''}</div>
                </td>
                <td class="inv-qty-cell">${g.reserve_qty.toLocaleString('ru-RU', { maximumFractionDigits: 2 })}</td>
                <td class="inv-unit-cell">${Utils.escapeHtml(g.unit || '')}</td>
                <td class="inv-actions-cell"><span class="text-muted">Групповой режим</span></td>
            </tr>`;
        });
        return;
    }

    // Группировка строк в Складе №7 (По отдельным заказам) — по текущей странице.
    // Важно: счетчик групп сбрасываем при переходе на другую страницу.
    let prevOrderKey = null;
    let groupIndex = 0;
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
            const rowQty = Number(item.display_qty ?? item.total ?? 0);
            qtyHtml = `<td class="inv-qty-cell">${rowQty.toLocaleString('ru-RU', { maximumFractionDigits: 2 })}</td>`;

            if (isReserveView) {
                // Склад №7: кнопка управления резервом
                const canManageReserve = !item.__batchKeys || item.__batchKeys.size <= 1;
                if (canManageReserve) {
                    actionHtml = `<button class="btn btn-outline inv-btn-reserve" 
                        onclick="openReserveManagerModal(${item.item_id}, ${item.batch_id || 'null'}, ${item.linked_order_item_id || 'null'}, ${item.total})">
                        🔄 Управление
                    </button>`;
                } else {
                    actionHtml = '<span class="text-muted">Разверните по партиям для управления</span>';
                }
            } else if (currentWarehouseFilter === '4' && !showFinishedBatches) {
                actionHtml = `<span class="text-muted">Включите «По партиям»</span>`;
            } else if (item.warehouse_id === 3) {
                if (item.batch_status === 'completed') {
                    actionHtml = `<span class="inv-demold-done-badge">✅ Упаковано</span>`;
                } else {
                    const btnId = `demold-btn-${item.batch_id}`;
                    actionHtml = `<button id="${btnId}" class="btn inv-btn-demold-enterprise" onclick="openDemoldingModal(${item.batch_id}, '${item.batch_number || 'Б/Н'}', ${item.item_id}, '${item.item_name}', ${item.display_qty ?? item.total})">🧱 Распалубить</button>`;
                }
            } else if (item.warehouse_id === 5 || item.warehouse_id === 6) {
                const packBtn = item.warehouse_id === 5
                    ? `<button class="btn btn-outline inv-btn-grade2-kit" onclick="openGrade2PalletKitModal(${item.item_id}, '${Utils.escapeHtml(item.item_name)}', ${item.batch_id || 'null'}, '${item.batch_number || ''}')">📦 Поддон 2 сорта</button>`
                    : '';
                actionHtml = `<div class="flex-row gap-5">
                            ${packBtn}
                            <button class="btn btn-outline inv-btn-dispose" 
                                onclick="openDisposeModal(${item.item_id}, '${item.item_name}', ${item.batch_id || 'null'}, '${item.batch_number || ''}', ${item.warehouse_id}, ${item.display_qty ?? item.total})">
                                🗑️ Утилизировать
                            </button>
                          </div>`;
            } else {
                actionHtml = `<div class="flex-row gap-5">
                    <button class="btn btn-outline" onclick="openScrapModal(${item.item_id}, '${Utils.escapeHtml(item.item_name)}', ${item.batch_id || 'null'}, '${item.batch_number || ''}', ${item.warehouse_id}, ${item.display_qty ?? item.total})">
                          ↘️ Брак/Уценка
                    </button>
                    <button class="btn btn-outline" onclick="openDirectScrapModal(${item.item_id}, '${Utils.escapeHtml(item.item_name)}', ${item.batch_id || 'null'}, '${item.batch_number || ''}', ${item.warehouse_id}, ${item.display_qty ?? item.total})">
                          🔨 Прямое списание
                    </button>
                </div>`;
            }
        }

        if (isReserveView) {
            // Спец-разметка для Склада №7: с колонкой "Заказ"
            const orderQty = Number(item.order_qty_ordered || 0);
            const orderShipped = Number(item.order_qty_shipped || 0);
            const orderReserved = Number(item.order_qty_reserved || 0);
            const orderRemaining = Math.max(orderQty - orderShipped, 0);
            const orderNeedReserve = Math.max(orderRemaining - orderReserved, 0);
            const itemKey = String(item.item_id || '');
            const freeQty = Number(finishedByItem[itemKey] || 0);
            const reserveTotal = Number(reservedByItem[itemKey] || 0);
            const orderInfo = item.order_doc_number
                ? `<div class="inv-reserve-order-main">
                    <a href="javascript:void(0)" class="inv-reserve-order-link" onclick="openInventoryOrder(${item.order_id || 'null'})">${Utils.escapeHtml(item.order_doc_number)}</a>
                    <span class="badge inv-order-badge">${Utils.escapeHtml(formatReserveOrderStatus(item.order_status))}</span>
                    <span class="inv-reserve-order-client" title="${Utils.escapeHtml(item.order_client_name || 'Клиент не указан')}">${Utils.escapeHtml(item.order_client_name || 'Клиент не указан')}</span>
                </div>
                <div class="inv-reserve-order-metrics" title="Заказ: ${orderQty.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} | Отгружено: ${orderShipped.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} | В резерве по заказу: ${orderReserved.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} | Нужно: ${orderNeedReserve.toLocaleString('ru-RU', { maximumFractionDigits: 2 })}">Заказ: ${orderQty.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} | Отгружено: ${orderShipped.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} | В резерве по заказу: ${orderReserved.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} | Нужно: ${orderNeedReserve.toLocaleString('ru-RU', { maximumFractionDigits: 2 })}</div>
                <div class="inv-reserve-order-metrics" title="Склад №4 свободно: ${freeQty.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} | Склад №7 в резерве: ${reserveTotal.toLocaleString('ru-RU', { maximumFractionDigits: 2 })}">Склад №4 свободно: ${freeQty.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} | Склад №7 в резерве: ${reserveTotal.toLocaleString('ru-RU', { maximumFractionDigits: 2 })}</div>`
                : '<span class="badge inv-wh-badge">Без привязки к заказу</span>';
            const orderKey = String(item.order_id || item.order_doc_number || '');
            const isGroupStart = orderKey !== prevOrderKey;
            if (isGroupStart) groupIndex += 1;
            prevOrderKey = orderKey;
            const groupClass = groupIndex % 2 === 0 ? 'inv-reserve-group-even' : 'inv-reserve-group-odd';
            const rowClass = [
                'inv-reserve-row',
                groupClass,
                isGroupStart ? 'inv-reserve-group-start' : '',
                orderNeedReserve > 0.0001 ? 'inv-reserve-row--deficit' : ''
            ].filter(Boolean).join(' ');
            const itemNameTitle = Utils.escapeHtml(item.item_name);
            tbody.innerHTML += `
            <tr class="${rowClass}">
                <td class="inv-batch-cell">${batchCell}</td>
                <td class="inv-name-cell" title="${itemNameTitle}">
                    <a href="javascript:void(0)" onclick="openItemHistory(${item.item_id}, ${item.warehouse_id})" class="text-primary text-decoration-none" title="${itemNameTitle}">
                        <strong>${Utils.escapeHtml(item.item_name)}</strong>
                    </a>
                </td>
                <td class="inv-reserve-order-cell">${orderNeedReserve > 0.0001 ? '<span class="inv-reserve-deficit-chip">Дефицит</span>' : ''}${orderInfo}</td>
                ${qtyHtml}
                <td class="inv-unit-cell">${item.unit}</td>
                <td class="inv-actions-cell">${actionHtml}</td>
            </tr>`;
        } else {
            // Бейдж резерва для склада ГП (warehouse_id === 4)
            const reserveQtyByBatch = Number(item.reserve_qty_by_batch || 0);
            const reserveBadgeHtml = (String(item.warehouse_id) === '4' && reserveQtyByBatch > 0.005)
                ? `<span class="inv-reserve-badge" onclick="openReserveDetailModal(${item.item_id})" title="Нажмите для детализации резервов">🔒 ${reserveQtyByBatch.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} в резерве</span>`
                : '';
            const stockNameTitle = Utils.escapeHtml(item.item_name);
            tbody.innerHTML += `
            <tr>
                <td><span class="badge inv-wh-badge">${Utils.escapeHtml(item.warehouse_name)}</span></td>
                <td class="inv-batch-cell">${batchCell}</td>
                <td class="inv-name-cell" title="${stockNameTitle}">
                    <a href="javascript:void(0)" onclick="openItemHistory(${item.item_id}, ${item.warehouse_id === 'all' ? 'null' : item.warehouse_id})" class="text-primary text-decoration-none" title="${stockNameTitle}">
                        <strong>${Utils.escapeHtml(item.item_name)}</strong>
                    </a>
                    ${reserveBadgeHtml}
                </td>
                ${qtyHtml}
                <td class="inv-unit-cell">${item.unit}</td>
                <td class="inv-actions-cell">${actionHtml}</td>
            </tr>`;
        }
    });

    if (!isAuditMode && currentWarehouseFilter === '3') {
        setTimeout(() => { refreshDemoldButtonsRisk(); }, 0);
    }
}

window.refreshDemoldButtonsRisk = async function () {
    const btns = Array.from(document.querySelectorAll('#inventory-table .inv-btn-demold-enterprise[id^="demold-btn-"]'));
    if (!btns.length) return;
    await Promise.all(btns.map(async (btn) => {
        const idStr = String(btn.id || '').replace('demold-btn-', '');
        const batchId = Number(idStr);
        if (!batchId) return;
        try {
            const row = btn.closest('tr');
            const qtyCell = row ? row.querySelector('.inv-qty-cell') : null;
            const rowQty = qtyCell ? Number(String(qtyCell.textContent || '0').replace(/\s/g, '').replace(',', '.')) : 0;
            const outputQty = Number.isFinite(rowQty) && rowQty > 0 ? rowQty : 0;
            if (outputQty <= 0) return;
            const data = await API.get(`/api/inventory/demold-packaging-check?batchId=${encodeURIComponent(batchId)}&outputQty=${encodeURIComponent(outputQty)}`);
            if (data && data.hasDeficit) {
                btn.classList.add('has-deficit');
                btn.innerHTML = '🧱 Распалубить <span class="inv-demold-deficit-dot"></span>';
                btn.title = 'Есть дефицит упаковки для полного выхода';
            } else {
                btn.classList.remove('has-deficit');
                btn.textContent = '🧱 Распалубить';
                btn.title = '';
            }
        } catch (_) {
            // молча пропускаем, основной поток должен работать даже без этой подсказки
        }
    }));
};

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
    if (!String(desc || '').trim()) return UI.toast('Укажите причину списания', 'warning');

    try {
        await API.post('/api/inventory/scrap', {
            itemId: itemId,
            batchId: batchId || null,
            warehouseId: warehouseId,
            targetWarehouseId: (window.WAREHOUSE_IDS && window.WAREHOUSE_IDS['defect']) || 6, // Склад утиля/брака — динамически из WAREHOUSE_IDS
            scrapQty: scrapQty,
            description: desc,
            reason: desc
        });

        UI.closeModal();
        UI.toast('Брак успешно списан', 'success');
        loadTable();
    } catch (e) { console.error(e); }
};

// === ОКНО РАСПАЛУБКИ ===
window.openDemoldingModal = function (batchId, batchNum, tileId, productName, plannedQty) {
    window.currentDemoldKitExtras = [];
    const selectedDate = inventoryDatePicker && inventoryDatePicker.selectedDates && inventoryDatePicker.selectedDates[0]
        ? inventoryDatePicker.selectedDates[0]
        : new Date();
    const defaultDemoldDate = new Date(selectedDate);
    const now = new Date();
    defaultDemoldDate.setHours(now.getHours(), now.getMinutes(), 0, 0);

    const html = `
        <div class="inv-modal-info">
            <h4 class="inv-modal-batch">Партия: ${escapeHTML(batchNum)}</h4>
            <div class="inv-modal-product">Продукция: <b>${escapeHTML(productName)}</b></div>
            <div class="inv-modal-stock">В сушилке числится: <b class="inv-modal-stock-value">${plannedQty}</b> ед.</div>
        </div>

        <div class="form-grid inv-grid-3">
            <div class="form-group">
                <label class="inv-label-success">🟢 1-й сорт:</label>
                <input type="number" id="demold-good" class="input-modern" value="${plannedQty}" onclick="this.select()" onfocus="this.select()">
            </div>
            <div class="form-group">
                <label class="inv-label-warning">🟡 2-й сорт:</label>
                <input type="number" id="demold-grade2" class="input-modern" value="0" onclick="this.select()" onfocus="this.select()">
            </div>
            <div class="form-group">
                <label class="inv-label-danger">🔴 Брак:</label>
                <input type="number" id="demold-scrap" class="input-modern" value="0" onclick="this.select()" onfocus="this.select()">
            </div>
        </div>
        
        <div class="form-group mt-15">
            <label>Дата распалубки (по выбранной дате календаря):</label>
            <input type="text" id="demolding-date" class="input-modern" placeholder="ДД.ММ.ГГГГ ЧЧ:ММ">
        </div>

        <div class="form-group mt-10 mb-5">
            <label class="d-flex align-items-center gap-2">
                <input type="checkbox" id="demold-complete">
                Полностью закрыть партию
            </label>
        </div>

        <div class="form-group mt-10">
            <label class="d-flex align-items-center gap-2">
                <input type="checkbox" id="demold-enable-grade2-kit" onchange="toggleDemoldGrade2Kit()">
                Выделить поддон под 2 сорт (ручная упаковка)
            </label>
        </div>

        <div id="demold-grade2-kit-box" class="inv-grade2-kit-box d-none">
            <div class="form-grid inv-grid-2">
                <div class="form-group">
                    <label>Транспортный поддон:</label>
                    <select id="demold-kit-pallet-item" class="input-modern"></select>
                </div>
                <div class="form-group">
                    <label>Кол-во поддонов (целое):</label>
                    <input type="number" id="demold-kit-pallet-qty" class="input-modern" min="1" step="1" value="1">
                </div>
            </div>
            <div class="form-grid inv-grid-3">
                <div class="form-group">
                    <label>Доп. упаковка:</label>
                    <select id="demold-kit-extra-item" class="input-modern"></select>
                </div>
                <div class="form-group">
                    <label>Кол-во:</label>
                    <input type="number" id="demold-kit-extra-qty" class="input-modern" min="0" step="0.001" value="0">
                </div>
                <div class="form-group">
                    <label>&nbsp;</label>
                    <button type="button" class="btn btn-outline w-100" onclick="addDemoldKitExtra()">+ Добавить</button>
                </div>
            </div>
            <div id="demold-kit-extra-list" class="inv-grade2-kit-list text-muted font-12">Доп. упаковка не добавлена.</div>
        </div>

        <div class="form-group mt-10">
            <div id="demold-packaging-check" class="inv-demold-packaging-check text-muted font-12">
                Проверка упаковки...
            </div>
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
            defaultDate: defaultDemoldDate,
            time_24hr: true
        });
    } else {
        const dateInput = document.getElementById('demolding-date');
        if (dateInput) {
            const pad = (n) => String(n).padStart(2, '0');
            const y = defaultDemoldDate.getFullYear();
            const m = pad(defaultDemoldDate.getMonth() + 1);
            const d = pad(defaultDemoldDate.getDate());
            const hh = pad(defaultDemoldDate.getHours());
            const mm = pad(defaultDemoldDate.getMinutes());
            dateInput.value = `${y}-${m}-${d} ${hh}:${mm}`;
        }
    }

    const bindInputCheck = (id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('input', () => {
            if (typeof window.refreshDemoldingPackagingCheck === 'function') {
                window.refreshDemoldingPackagingCheck(batchId);
            }
        });
    };
    bindInputCheck('demold-good');
    bindInputCheck('demold-grade2');
    initDemoldKitMaterials();
    window.refreshDemoldingPackagingCheck(batchId);
};

async function ensureDemoldKitMaterials() {
    if (Array.isArray(demoldKitMaterialsCache) && demoldKitMaterialsCache.length > 0) return demoldKitMaterialsCache;
    const data = await API.get('/api/items?item_type=material&limit=600');
    const rows = Array.isArray(data && data.data) ? data.data : [];
    const packRows = rows.filter((m) => /(упаков|поддон|паллета|паллет|лента|скоб|стретч|стрейч|пленк)/i.test(String(m.name || '') + ' ' + String(m.category || '')));
    demoldKitMaterialsCache = packRows;
    return demoldKitMaterialsCache;
}

window.initDemoldKitMaterials = async function () {
    const palletSel = document.getElementById('demold-kit-pallet-item');
    const extraSel = document.getElementById('demold-kit-extra-item');
    if (!palletSel || !extraSel) return;
    try {
        const rows = await ensureDemoldKitMaterials();
        const palletRows = rows.filter((m) => /(поддон|паллета|паллет)/i.test(String(m.name || '') + ' ' + String(m.category || '')));
        palletSel.innerHTML = `<option value="">-- Выберите поддон --</option>` + palletRows.map((m) => `<option value="${m.id}">${escapeHTML(m.name)}</option>`).join('');
        extraSel.innerHTML = `<option value="">-- Выберите доп. упаковку --</option>` + rows.map((m) => `<option value="${m.id}" data-name="${escapeHTML(m.name)}">${escapeHTML(m.name)}</option>`).join('');
    } catch (_) {
        palletSel.innerHTML = `<option value="">Не удалось загрузить материалы</option>`;
        extraSel.innerHTML = `<option value="">Не удалось загрузить материалы</option>`;
    }
};

window.toggleDemoldGrade2Kit = function () {
    const box = document.getElementById('demold-grade2-kit-box');
    const enabled = document.getElementById('demold-enable-grade2-kit')?.checked;
    if (!box) return;
    box.classList.toggle('d-none', !enabled);
};

window.currentDemoldKitExtras = [];
window.addDemoldKitExtra = function () {
    const sel = document.getElementById('demold-kit-extra-item');
    const qtyEl = document.getElementById('demold-kit-extra-qty');
    if (!sel || !qtyEl || !sel.value) return;
    const qty = Number(qtyEl.value || 0);
    if (!Number.isFinite(qty) || qty <= 0) return UI.toast('Укажите количество доп. упаковки больше нуля', 'warning');
    const itemId = Number(sel.value);
    const itemName = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].text : 'Материал';
    const ex = window.currentDemoldKitExtras.find((x) => Number(x.itemId) === itemId);
    if (ex) ex.qty += qty;
    else window.currentDemoldKitExtras.push({ itemId, name: itemName, qty });
    qtyEl.value = '0';
    renderDemoldKitExtras();
};

window.removeDemoldKitExtra = function (idx) {
    window.currentDemoldKitExtras.splice(idx, 1);
    renderDemoldKitExtras();
};

window.renderDemoldKitExtras = function () {
    const box = document.getElementById('demold-kit-extra-list');
    if (!box) return;
    if (!window.currentDemoldKitExtras.length) {
        box.innerHTML = 'Доп. упаковка не добавлена.';
        return;
    }
    box.innerHTML = window.currentDemoldKitExtras.map((x, idx) =>
        `<div class="inv-grade2-kit-row"><span>${escapeHTML(x.name)}: <b>${Number(x.qty).toLocaleString('ru-RU', { maximumFractionDigits: 3 })}</b></span><button type="button" class="btn btn-outline btn-xs" onclick="removeDemoldKitExtra(${idx})">Удалить</button></div>`
    ).join('');
};

window.refreshDemoldingPackagingCheck = async function (batchId) {
    const box = document.getElementById('demold-packaging-check');
    if (!box) return;
    const goodQty = parseFloat(document.getElementById('demold-good')?.value) || 0;
    const grade2Qty = parseFloat(document.getElementById('demold-grade2')?.value) || 0;
    const outputQty = Math.max(0, goodQty + grade2Qty);

    if (outputQty <= 0) {
        box.className = 'inv-demold-packaging-check text-muted font-12';
        box.innerHTML = 'Упаковка не требуется (нет выхода 1/2 сорта).';
        return;
    }

    if (!demoldPackagingCheckSupported) {
        box.className = 'inv-demold-packaging-check text-warning font-12';
        box.innerHTML = 'Проверка упаковки недоступна на текущей версии сервера. Обновите/перезапустите сервер.';
        return;
    }

    box.className = 'inv-demold-packaging-check text-muted font-12';
    box.innerHTML = 'Проверка упаковки...';
    try {
        const data = await API.get(`/api/inventory/demold-packaging-check?batchId=${encodeURIComponent(batchId)}&outputQty=${encodeURIComponent(outputQty)}`);
        const items = Array.isArray(data.items) ? data.items : [];
        if (items.length === 0) {
            box.className = 'inv-demold-packaging-check text-muted font-12';
            box.innerHTML = 'Для этой партии упаковка по рецепту не требуется.';
            return;
        }

        const deficit = items.filter((x) => Number(x.shortage || 0) > 0.0001);
        if (deficit.length === 0) {
            box.className = 'inv-demold-packaging-check text-success font-12';
            box.innerHTML = '✅ Упаковки достаточно для текущего выхода.';
            return;
        }

        const rows = items.map((d) => {
            const rawNeed = Number(d.need || 0);
            const rawAvail = Number(d.available || 0);
            const rawShort = Number(d.shortage || 0);
            const needNum = d && d.isPallet ? Math.ceil(rawNeed) : rawNeed;
            const avNum = d && d.isPallet ? Math.floor(rawAvail) : rawAvail;
            const shNum = d && d.isPallet ? Math.ceil(rawShort) : rawShort;
            const need = needNum.toLocaleString('ru-RU', { maximumFractionDigits: d && d.isPallet ? 0 : 3 });
            const av = avNum.toLocaleString('ru-RU', { maximumFractionDigits: d && d.isPallet ? 0 : 3 });
            const sh = shNum.toLocaleString('ru-RU', { maximumFractionDigits: d && d.isPallet ? 0 : 3 });
            const statusClass = Number(d.shortage || 0) > 0.0001 ? 'inv-pack-status-bad' : 'inv-pack-status-ok';
            const statusText = Number(d.shortage || 0) > 0.0001 ? `Не хватает ${sh}` : 'Хватает';
            const needLabel = d && d.isPallet
                ? `${need} подд.`
                : need;
            const palletHint = d && d.isPallet
                ? `<div class="text-muted font-11">Поддон: перенос добора ${Number(d.carryInUnits || 0).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} -> ${Number(d.carryOutUnits || 0).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ед.</div>`
                : '';
            return `
                <tr>
                    <td>${escapeHTML(d.name || 'Материал')}${palletHint}</td>
                    <td class="inv-pack-col-num">${needLabel}</td>
                    <td class="inv-pack-col-num">${av}</td>
                    <td class="inv-pack-col-num ${statusClass}">${statusText}</td>
                </tr>
            `;
        }).join('');
        box.className = 'inv-demold-packaging-check text-danger font-12';
        const topDeficit = deficit.map((d) => {
            const shortNum = d && d.isPallet ? Math.ceil(Number(d.shortage || 0)) : Number(d.shortage || 0);
            const shortTxt = shortNum.toLocaleString('ru-RU', { maximumFractionDigits: d && d.isPallet ? 0 : 3 });
            return `<span class="inv-pack-deficit-chip">${escapeHTML(d.name || 'Материал')}: -${shortTxt}${d && d.isPallet ? ' подд.' : ''}</span>`;
        }).join('');
        box.innerHTML = `
            <div class="inv-pack-check-title">⚠️ Контроль упаковки: есть дефицит по ${deficit.length} позициям</div>
            <div class="inv-pack-deficit-top">${topDeficit}</div>
            <table class="inv-pack-check-table">
                <thead>
                    <tr>
                        <th>Материал</th>
                        <th class="inv-pack-col-num">Нужно</th>
                        <th class="inv-pack-col-num">В наличии</th>
                        <th class="inv-pack-col-num">Статус</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        `;
    } catch (e) {
        if (e && e.message && String(e.message).includes('HTTP 404')) {
            demoldPackagingCheckSupported = false;
            box.className = 'inv-demold-packaging-check text-warning font-12';
            box.innerHTML = 'Проверка упаковки недоступна на текущей версии сервера. Обновите/перезапустите сервер.';
            return;
        }
        box.className = 'inv-demold-packaging-check text-warning font-12';
        box.innerHTML = 'Не удалось проверить упаковку. Проверка будет выполнена при сохранении.';
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
        const msg = e && e.message ? String(e.message) : 'Не удалось сохранить изменения';
        if (typeof UI !== 'undefined' && typeof UI.toast === 'function') UI.toast(msg, 'error');
        else alert(msg);
    }
};

window.deleteMovement = function(id) {
    UI.showModal('Подтверждение удаления движения', `
        <div class="mb-10">Вы уверены, что хотите удалить запись? Связанные операции будут автоматически отменены, а баланс пересчитан.</div>
        <div class="form-group m-0">
            <label>Причина удаления (обязательно)</label>
            <textarea id="delete-movement-reason" class="input-modern" rows="3" placeholder="Например: ошибочная проводка"></textarea>
        </div>
    `, `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-red" onclick="confirmDeleteMovement(${id})">Удалить</button>
    `);
};

window.confirmDeleteMovement = async function(id) {
    const reason = (document.getElementById('delete-movement-reason')?.value || '').trim();
    if (!reason) return UI.toast('Укажите причину удаления', 'warning');
    try {
        await API.delete(`/api/inventory/movement/${id}?reason=${encodeURIComponent(reason)}`);
        UI.closeModal();
        UI.toast('Транзакция успешно отменена', 'success');
        loadDryingHistory();
        if (typeof loadTable === 'function') loadTable();
    } catch (e) {
        console.error(e);
    }
};

// === ВЫПОЛНЕНИЕ РАСПАЛУБКИ ===
window.executeDemolding = async function (batchId, tileId, currentWipQty) {
    const goodQty = parseFloat(document.getElementById('demold-good').value) || 0;
    const grade2Qty = parseFloat(document.getElementById('demold-grade2').value) || 0;
    const scrapQty = parseFloat(document.getElementById('demold-scrap').value) || 0;
    const isComplete = document.getElementById('demold-complete').checked;
    const demoldingDate = document.getElementById('demolding-date').value;
    const useGrade2Kit = !!document.getElementById('demold-enable-grade2-kit')?.checked;
    let grade2PalletKit = null;
    if (useGrade2Kit) {
        const palletItemId = Number(document.getElementById('demold-kit-pallet-item')?.value || 0);
        const palletQty = Number(document.getElementById('demold-kit-pallet-qty')?.value || 0);
        if (!palletItemId || !Number.isFinite(palletQty) || palletQty <= 0 || Math.floor(palletQty) !== palletQty) {
            return UI.toast('Для поддона 2 сорта выберите поддон и целое количество', 'warning');
        }
        grade2PalletKit = {
            palletItemId,
            palletQty,
            extras: (window.currentDemoldKitExtras || []).map((x) => ({ itemId: Number(x.itemId), qty: Number(x.qty || 0) })).filter((x) => x.itemId && x.qty > 0)
        };
    }

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
            movementDate: demoldingDate,
            grade2PalletKit
        });

        UI.closeModal();
        UI.toast('Партия успешно распределена по складам!', 'success');
        loadTable();
        if (typeof updateInventoryCalendarMarks === 'function') {
            updateInventoryCalendarMarks();
        }
        if (typeof loadDryingHistory === 'function' && document.getElementById('drying-history-block') && !document.getElementById('drying-history-block').classList.contains('d-none')) {
            loadDryingHistory();
        }
    } catch (e) {
        console.error(e);
        const deficit = e && e.body && Array.isArray(e.body.packagingDeficit) ? e.body.packagingDeficit : [];
        if (deficit.length > 0) {
            const lines = deficit.map((d) => {
                const need = Number(d.need || 0).toLocaleString('ru-RU', { maximumFractionDigits: 3 });
                const av = Number(d.available || 0).toLocaleString('ru-RU', { maximumFractionDigits: 3 });
                const sh = Number(d.shortage || 0).toLocaleString('ru-RU', { maximumFractionDigits: 3 });
                return `<li><b>${escapeHTML(d.name || 'Материал')}</b>: нужно ${need}, есть ${av}, не хватает <b>${sh}</b></li>`;
            }).join('');
            UI.showModal('Недостаточно упаковки', `
                <div class="mb-8">Не удалось провести распалубку: для партии не хватает упаковочных материалов.</div>
                <ul class="m-0 pl-20">${lines}</ul>
            `, `<button class="btn btn-outline" onclick="UI.closeModal()">Понятно</button>`);
        }
        if (btn) { btn.disabled = false; btn.textContent = '💾 Сохранить выход'; }
    }
};

window.openGrade2PalletKitModal = async function (itemId, itemName, batchId, batchNum) {
    window.currentDemoldKitExtras = [];
    const html = `
        <div class="inv-modal-info">
            <div class="inv-modal-product">Продукция 2 сорта: <b>${escapeHTML(itemName || '')}</b></div>
            <div class="inv-modal-batch">Партия: <b>${escapeHTML(batchNum || 'без номера')}</b></div>
        </div>
        <div class="inv-grade2-kit-box">
            <div class="form-grid inv-grid-2">
                <div class="form-group">
                    <label>Транспортный поддон:</label>
                    <select id="demold-kit-pallet-item" class="input-modern"></select>
                </div>
                <div class="form-group">
                    <label>Кол-во поддонов (целое):</label>
                    <input type="number" id="demold-kit-pallet-qty" class="input-modern" min="1" step="1" value="1">
                </div>
            </div>
            <div class="form-grid inv-grid-3">
                <div class="form-group">
                    <label>Доп. упаковка:</label>
                    <select id="demold-kit-extra-item" class="input-modern"></select>
                </div>
                <div class="form-group">
                    <label>Кол-во:</label>
                    <input type="number" id="demold-kit-extra-qty" class="input-modern" min="0" step="0.001" value="0">
                </div>
                <div class="form-group">
                    <label>&nbsp;</label>
                    <button type="button" class="btn btn-outline w-100" onclick="addDemoldKitExtra()">+ Добавить</button>
                </div>
            </div>
            <div id="demold-kit-extra-list" class="inv-grade2-kit-list text-muted font-12">Доп. упаковка не добавлена.</div>
        </div>
    `;
    const buttons = `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-blue" onclick="submitGrade2PalletKit(${itemId}, ${batchId || 'null'})">📦 Списать упаковку</button>
    `;
    UI.showModal('📦 Комплектация поддона 2 сорта', html, buttons);
    await initDemoldKitMaterials();
};

window.submitGrade2PalletKit = async function (itemId, batchId) {
    const palletItemId = Number(document.getElementById('demold-kit-pallet-item')?.value || 0);
    const palletQty = Number(document.getElementById('demold-kit-pallet-qty')?.value || 0);
    if (!palletItemId || !Number.isFinite(palletQty) || palletQty <= 0 || Math.floor(palletQty) !== palletQty) {
        return UI.toast('Выберите поддон и укажите целое количество', 'warning');
    }
    try {
        await API.post('/api/inventory/grade2-pallet-kit', {
            itemId,
            batchId: batchId || null,
            palletItemId,
            palletQty,
            extras: (window.currentDemoldKitExtras || []).map((x) => ({ itemId: Number(x.itemId), qty: Number(x.qty || 0) })).filter((x) => x.itemId && x.qty > 0),
            movementDate: new Date().toISOString().slice(0, 16).replace('T', ' ')
        });
        UI.closeModal();
        UI.toast('Комплектация поддона 2 сорта сохранена', 'success');
        loadTable();
        if (typeof updateInventoryCalendarMarks === 'function') updateInventoryCalendarMarks();
    } catch (e) {
        console.error(e);
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
    if (!String(desc || '').trim()) return UI.toast('Укажите причину перемещения', 'warning');

    try {
        await API.post('/api/inventory/scrap', { itemId, batchId: batchId || null, warehouseId, targetWarehouseId: targetWh, scrapQty, description: desc, reason: desc });
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
    if (!String(desc || '').trim()) return UI.toast('Укажите причину утилизации', 'warning');

    UI.toast('⏳ Выполняется списание...', 'info');

    try {
        const data = await API.post('/api/inventory/dispose', {
            itemId: itemId,
            batchId: batchId || null,
            warehouseId: warehouseId,
            disposeQty: disposeQty,
            description: desc,
            reason: desc
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
window.openReserveManagerModal = function (itemId, batchId, linkedOrderItemId, maxQty) {
    const row = (allInventory || []).find((x) =>
        String(x.warehouse_id) === '7'
        && String(x.item_id) === String(itemId)
        && String(x.linked_order_item_id || '') === String(linkedOrderItemId || '')
        && String(x.batch_id || '') === String(batchId || '')
    ) || {};
    const itemName = row.item_name || '';
    const batchNum = row.batch_number || '';
    const orderDocNum = row.order_doc_number || '';
    const orderId = row.order_id || null;
    const clientName = row.order_client_name || '';
    const orderStatusLabel = formatReserveOrderStatus(row.order_status);
    const orderQty = Number(row.order_qty_ordered || 0);
    const orderShipped = Number(row.order_qty_shipped || 0);
    const orderReserved = Number(row.order_qty_reserved || 0);
    const orderRemaining = Math.max(orderQty - orderShipped, 0);
    const orderNeedReserve = Math.max(orderRemaining - orderReserved, 0);
    const html = `
        <div class="inv-modal-info">
            <div class="inv-modal-product">Продукция: <b>${Utils.escapeHtml(itemName)}</b></div>
            ${batchNum ? `<div class="inv-modal-batch">Партия: ${Utils.escapeHtml(batchNum)}</div>` : ''}
            <div class="inv-modal-stock">
                Привязка:
                ${orderDocNum
                    ? `<a href="javascript:void(0)" class="inv-reserve-order-link" onclick="openInventoryOrder(${orderId || 'null'})">${Utils.escapeHtml(orderDocNum)}</a>`
                    : '<b class="inv-modal-stock-value">Без заказа</b>'}
            </div>
            ${orderDocNum ? `<div class="inv-modal-stock">Клиент: <b class="inv-modal-stock-value">${Utils.escapeHtml(clientName || '—')}</b> | Статус: <b class="inv-modal-stock-value">${Utils.escapeHtml(orderStatusLabel)}</b></div>` : ''}
            ${orderDocNum ? `<div class="inv-modal-stock">По заказу: <b class="inv-modal-stock-value">${orderQty}</b> | Отгружено: <b class="inv-modal-stock-value">${orderShipped}</b> | Нужно: <b class="inv-modal-stock-value">${orderNeedReserve}</b></div>` : ''}
            <div class="inv-modal-stock">В резерве: <b class="inv-modal-stock-value">${maxQty}</b> ед.</div>
        </div>

        <input type="hidden" id="reserve-item-id" value="${itemId}">
        <input type="hidden" id="reserve-batch-id" value="${batchId || ''}">
        <input type="hidden" id="reserve-linked-coi" value="${linkedOrderItemId || ''}">
        <input type="hidden" id="reserve-max-qty" value="${maxQty}">

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
            <label>Фильтр по клиенту:</label>
            <select id="reserve-target-client" class="input-modern" onchange="renderReserveTargetOrders()">
                <option value="">Все клиенты</option>
            </select>
            <div class="mt-8"></div>
            <label>Поиск заказа (№ / клиент):</label>
            <input type="text" id="reserve-target-search" class="input-modern" placeholder="Например: ЗК-123 или Иванов" oninput="renderReserveTargetOrders()">
            <div class="mt-8"></div>
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
            window.__reserveOrderTargets = Array.isArray(orders) ? orders : [];
            const clientSel = document.getElementById('reserve-target-client');
            if (clientSel) {
                const uniqClients = [...new Set(window.__reserveOrderTargets.map(o => String(o.client_name || '').trim()).filter(Boolean))];
                clientSel.innerHTML = '<option value="">Все клиенты</option>' + uniqClients.map(name => `<option value="${Utils.escapeHtml(name)}">${Utils.escapeHtml(name)}</option>`).join('');
            }
            renderReserveTargetOrders();
        }).catch(e => console.error(e));
};

window.renderReserveTargetOrders = function() {
    const sel = document.getElementById('reserve-target-coi');
    const currentLinked = document.getElementById('reserve-linked-coi')?.value || '';
    if (!sel) return;
    const all = Array.isArray(window.__reserveOrderTargets) ? window.__reserveOrderTargets : [];
    const clientFilter = String(document.getElementById('reserve-target-client')?.value || '').trim().toLowerCase();
    const search = String(document.getElementById('reserve-target-search')?.value || '').trim().toLowerCase();
    const rows = all.filter((o) => {
        if (String(o.id) === String(currentLinked)) return false;
        if (clientFilter && String(o.client_name || '').trim().toLowerCase() !== clientFilter) return false;
        if (search) {
            const hay = `${o.doc_number || ''} ${o.client_name || ''}`.toLowerCase();
            if (!hay.includes(search)) return false;
        }
        return true;
    });
    if (!rows.length) {
        sel.innerHTML = '<option value="">Нет подходящих заказов</option>';
        return;
    }
    sel.innerHTML = '<option value="">Выберите заказ...</option>' + rows.map((o) => {
        const reserved = Number(o.qty_reserved || 0);
        const need = Math.max(0, Number(o.qty_need_reserve || 0));
        const rem = Number(o.qty_remaining || 0);
        const status = formatReserveOrderStatus(o.order_status);
        return `<option value="${o.id}">${Utils.escapeHtml(o.doc_number || 'Заказ')} | ${Utils.escapeHtml(o.client_name || '—')} | ${Utils.escapeHtml(status)} | Осталось: ${rem} | Нужно в резерв: ${need} | В резерве: ${reserved}</option>`;
    }).join('');
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
    const maxQty = parseFloat(document.getElementById('reserve-max-qty').value || '0');
    const targetOrderItemId = action === 'transfer' ? document.getElementById('reserve-target-coi').value : null;

    if (!qty || qty <= 0) return UI.toast('Укажите количество!', 'warning');
    if (Number.isFinite(maxQty) && qty > maxQty) return UI.toast(`Количество превышает доступный резерв (${maxQty})`, 'warning');
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
        await API.post('/api/inventory/audit', { warehouseId: 0, adjustments: adjustments, reason: 'Импорт ревизии из Excel' }); // warehouseId: 0 = специальный флаг для системного импорта (каждая строка несёт свой wh_id)
        
        UI.closeModal();
        UI.toast('✅ Инвентаризация успешно импортирована!', 'success');
        window.__currentImportAdjustments = null;
        loadTable();
    } catch (e) {
        console.error(e);
        // error toast handled by API helper
    }
};

function getCurrentInventoryRowsForActions() {
    const allowZero = isAuditMode && ['all', '1', '4', '5'].includes(currentWarehouseFilter);
    const filtered = allInventory.filter((item) => {
        if (isAuditMode && ['3', '6', '7'].includes(String(item.warehouse_id))) return false;
        if (parseFloat(item.total) === 0 && !allowZero) return false;
        if (currentWarehouseFilter !== 'all' && String(item.warehouse_id) !== currentWarehouseFilter) return false;
        if (currentSearch) {
            const searchStr = `${item.item_name} ${item.warehouse_name || ''} ${item.batch_number || ''} ${item.batch_id || ''}`.toLowerCase();
            const tokens = currentSearch.split(/\s+/).filter(Boolean);
            return tokens.every((t) => searchStr.includes(t));
        }
        return true;
    });
    if (currentWarehouseFilter === '4') {
        return processInventoryForView(filtered, showFinishedBatches, subtractFinishedReserves);
    }
    return filtered.map((r) => ({ ...r, display_qty: Number(r.total || 0) }));
}

function openLocalInventoryPrint(mode, rows) {
    const isBlind = mode === 'blind';
    const title = `Печать остатков: Склад №4 (${isBlind ? 'Слепой' : 'Полный'})`;
    const bodyRows = rows.map((r, idx) => {
        const qty = Number(r.display_qty ?? r.total ?? 0);
        const reserve = Number(r.reserve_qty_by_batch || 0);
        return `<tr>
            <td>${idx + 1}</td>
            <td>${Utils.escapeHtml(r.batch_number || 'Общая')}</td>
            <td>${Utils.escapeHtml(r.item_name || '')}</td>
            <td style="text-align:right">${isBlind ? '' : qty.toLocaleString('ru-RU', { maximumFractionDigits: 2 })}</td>
            <td style="text-align:right">${reserve > 0.005 ? reserve.toLocaleString('ru-RU', { maximumFractionDigits: 2 }) : ''}</td>
            <td>${Utils.escapeHtml(r.unit || '')}</td>
        </tr>`;
    }).join('');
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
    <style>body{font-family:Arial,sans-serif;font-size:12px;padding:16px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #ccc;padding:6px}th{background:#f5f5f5}</style>
    </head><body><h3>${title}</h3><table><thead><tr><th>#</th><th>Партия</th><th>Наименование</th><th>Остаток</th><th>В резерве</th><th>Ед.</th></tr></thead><tbody>${bodyRows}</tbody></table>
    <script>window.onload=()=>window.print();</script></body></html>`;
    const w = window.open('', '_blank');
    if (!w) return UI.toast('Разрешите всплывающее окно для печати', 'warning');
    w.document.open();
    w.document.write(html);
    w.document.close();
}

function exportLocalInventoryXls(mode, rows) {
    const isBlind = mode === 'blind';
    const tr = rows.map((r) => {
        const qty = Number(r.display_qty ?? r.total ?? 0);
        const reserve = Number(r.reserve_qty_by_batch || 0);
        return `<tr>
            <td>${Utils.escapeHtml(r.batch_number || 'Общая')}</td>
            <td>${Utils.escapeHtml(r.item_name || '')}</td>
            <td>${isBlind ? '' : qty.toFixed(2)}</td>
            <td>${reserve > 0.005 ? reserve.toFixed(2) : ''}</td>
            <td>${Utils.escapeHtml(r.unit || '')}</td>
        </tr>`;
    }).join('');
    const tableHtml = `<table><tr><th>Партия</th><th>Наименование</th><th>Остаток</th><th>В резерве</th><th>Ед.</th></tr>${tr}</table>`;
    const blob = new Blob([`\ufeff${tableHtml}`], { type: 'application/vnd.ms-excel;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `Inventory_Wh4_${isBlind ? 'blind' : 'full'}.xls`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
}

window._openInventoryPrint = async function (mode) {
    const wh = typeof currentWarehouseFilter !== 'undefined' ? currentWarehouseFilter : 'all';
    if (wh === '4') {
        openLocalInventoryPrint(mode, getCurrentInventoryRowsForActions());
        UI.closeModal();
        return;
    }
    const dateParam = (inventoryDatePicker && inventoryDatePicker.selectedDates.length > 0) ? `&as_of_date=${inventoryDatePicker.formatDate(inventoryDatePicker.selectedDates[0], "Y-m-d")}` : '';
    await window.openPrintUrl(`/api/inventory/print?mode=${mode}&wh=${wh}${dateParam}`);
    UI.closeModal();
};

window.openPrintModal = function() {
    const wh = typeof currentWarehouseFilter !== 'undefined' ? currentWarehouseFilter : 'all';
    
    // Прячем дропдаун экспорта если открыт
    const dropdowns = document.querySelectorAll('.dropdown-menu');
    dropdowns.forEach(d => d.classList.add('inv-hidden'));
    
    const html = `
        <div class="text-center p-20">
            <p class="mb-20 text-muted">Будет распечатан бланк для инвентаризации <b>${wh === 'all' ? 'всех складов' : 'выбранного склада (№' + wh + ')' }</b>.</p>
            <button class="btn btn-outline mb-10 w-100" onclick="void window._openInventoryPrint('blind')">Слепой бланк (Пустые колонки Факт / Расчет)</button>
            <button class="btn btn-blue w-100" onclick="void window._openInventoryPrint('full')">Полный бланк (Содержит Расчетный остаток)</button>
        </div>
    `;
    UI.showModal('🖨️ Печать Бланка', html, '<button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>');
};

window.executeExport = async function (mode) {
    const wh = typeof currentWarehouseFilter !== 'undefined' ? currentWarehouseFilter : 'all';
    // Прячем дропдаун
    const dropdowns = document.querySelectorAll('.dropdown-menu');
    dropdowns.forEach(d => d.classList.add('inv-hidden'));
    if (wh === '4') {
        exportLocalInventoryXls(mode, getCurrentInventoryRowsForActions());
        return;
    }
    
    const dateParam = (inventoryDatePicker && inventoryDatePicker.selectedDates.length > 0) ? `&as_of_date=${inventoryDatePicker.formatDate(inventoryDatePicker.selectedDates[0], "Y-m-d")}` : '';
    await window.openPrintUrl(`/api/inventory/export?mode=${mode}&wh=${wh}${dateParam}`);
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
    
    const searchSource = window.globalItemsList.length ? window.globalItemsList : allInventory;
    
    // Инициализация TomSelect "умного поиска" для смены товара (как в Формовке)
    const switchEl = document.getElementById('history-item-switch');
    if (switchEl) {
        if (!switchEl.tomselect) {
            new TomSelect(switchEl, {
                plugins: ['clear_button'],
                create: false,
                dropdownParent: 'body',
                sortField: { field: "text", direction: "asc" },
                maxOptions: null,
                placeholder: "🔍 Введите товар...",
                score: function(search) {
                    if (!search) return function() { return 1; };

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
                render: {
                    option: function (data, escape) {
                        return '<div class="ts-option-product"><span class="ts-product-name">' + escape(data.text) + '</span></div>';
                    },
                    item: function (data, escape) {
                        return '<div>' + escape(data.text) + '</div>';
                    }
                },
                onDropdownOpen: function (dropdown) {
                    var content = dropdown.querySelector('.ts-dropdown-content');
                    var selected = content && content.querySelector('.active, .selected');
                    if (selected && content) {
                        setTimeout(function () {
                            if (content.scrollTop !== undefined) {
                                content.scrollTop = selected.offsetTop - (content.clientHeight / 2) + (selected.clientHeight / 2);
                            }
                        }, 0);
                    }
                }
            });
        }
        
        const ts = switchEl.tomselect;
        ts.clearOptions();
        const options = searchSource.map(inv => ({
            value: inv.name || inv.item_name,
            text: inv.name || inv.item_name
        }));
        ts.addOptions(options);

        // Установка заголовка и значения в селект
        const itemObj = searchSource.find(i => String(i.id || i.item_id) === String(itemId));
        if (itemObj) {
            document.getElementById('history-modal-title').innerText = "Карточка движения: " + (itemObj.name || itemObj.item_name);
            ts.setValue(itemObj.name || itemObj.item_name, true);
        } else {
            document.getElementById('history-modal-title').innerText = "Карточка движения";
            ts.setValue("", true);
        }
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
    
    let currentBalance = parseFloat(startBalance);
    let sumIn = 0;
    let sumOut = 0;
    
    if (history.length === 0) {
        tbody.innerHTML = '<table class="table-modern w-100 table-responsive border"><tbody><tr><td colspan="6" class="p-20 text-center text-muted font-italic">Движений не найдено</td></tr></tbody></table>';
        tfoot.innerHTML = '';
        return;
    }

    let matchCount = 0;
    let unitStrShared = history.length > 0 && history[0].unit ? ' ' + Utils.escapeHtml(history[0].unit) : '';

    let html = `<table class="table-modern w-100 table-responsive border">
        <thead class="bg-surface-hover sticky-top z-10">
            <tr>
                <th class="w-15 text-left p-12 font-13 text-muted">Дата и Время</th>
                <th class="w-30 text-left p-12 font-13 text-muted">Операция / Маршрут</th>
                <th class="w-10 text-center p-12 font-13 text-success">Приход</th>
                <th class="w-10 text-center p-12 font-13 text-danger">Расход</th>
                <th class="w-10 text-center p-12 font-13 font-weight-bold">Остаток</th>
                <th class="w-25 text-left p-12 font-13 text-muted">Дополнительно</th>
            </tr>
        </thead>
        <tbody>
        <tr class="bg-surface-alt">
            <td colspan="4" class="text-right text-muted p-12 font-13"><strong>Остаток на начало периода:</strong></td>
            <td colspan="2" class="text-left font-14 p-12"><strong>${parseFloat(startBalance).toLocaleString('ru-RU', {minimumFractionDigits: 2})}${unitStrShared}</strong></td>
        </tr>
    `;

    history.forEach(m => {
        const qty_in = parseFloat(m.qty_in || 0);
        const qty_out = parseFloat(m.qty_out || 0);
        const qty_diff = parseFloat(m.balance_diff !== undefined ? m.balance_diff : m.quantity);
        
        const inQty = qty_in > 0 ? qty_in : (qty_diff > 0 ? qty_diff : 0);
        const outQty = qty_out > 0 ? qty_out : (qty_diff < 0 ? Math.abs(qty_diff) : 0);
        
        sumIn += inQty;
        sumOut += outQty;
        currentBalance += qty_diff;
        
        let dateObj = new Date(m.op_date || m.movement_date);
        let dateStr = dateObj.toLocaleString('ru-RU', {day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'});
        
        let whFrom = m.warehouse_from;
        let whTo = m.warehouse_to;
        
        if (!whFrom && !whTo && m.warehouse_name) {
            if (qty_diff > 0) whTo = m.warehouse_name;
            else whFrom = m.warehouse_name;
        }

        let typeName = typeof m.movement_types === 'string' ? m.movement_types.split(',')[0].trim() : (m.movement_type || 'неизвестно');
        typeName = getMovementTypeName(typeName);

        let rawSource = whFrom ? Utils.escapeHtml(whFrom) : (m.supplier_name ? 'Поставщик' : 'Извне');
        if (m.type === 'production_receipt' || m.type === 'finished_receipt' || m.type === 'scrap_receipt' || m.type === 'markdown_receipt') {
            rawSource = 'Производство';
        } else if (m.type && m.type.includes('purchase')) {
            rawSource = 'Поставщик';
        }
        
        let rawDest = whTo ? Utils.escapeHtml(whTo) : (m.movement_type === 'sale' ? 'Клиент' : (m.movement_type === 'scrap' ? 'Утиль' : 'Списание'));

        if (searchQuery) {
            const searchStr = `${typeName} ${whFrom||''} ${whTo||''} ${m.supplier_name || ''} ${m.order_doc || ''} ${m.batch_number || ''} ${Utils.escapeHtml(m.description || '')} ${dateStr}`.toLowerCase();
            if (!searchStr.includes(searchQuery)) return; 
        }
        
        matchCount++;
        
        let unitStr = m.unit ? ' ' + Utils.escapeHtml(m.unit) : '';
        let inQtyStr = inQty > 0 ? '+ ' + inQty.toLocaleString('ru-RU', {minimumFractionDigits:2}) : '';
        let outQtyStr = outQty > 0 ? '- ' + outQty.toLocaleString('ru-RU', {minimumFractionDigits:2}) : '';
        let balanceStr = currentBalance.toLocaleString('ru-RU', {minimumFractionDigits:2});

        let sourceName = m.user_name ? Utils.escapeHtml(m.user_name) : 'Система';

        let cleanDesc = (m.description || '').replace(/^[\s,|:]+|[\s,|:]+$/g, '').replace(/\s{2,}/g, ' ').trim();

        let details = [];
        if (cleanDesc) details.push(`<div class="font-13 text-wrap mb-1"><span class="text-muted">Инфо:</span> ${Utils.escapeHtml(cleanDesc)}</div>`);
        if (m.supplier_name) details.push(`<div class="font-13 text-wrap mb-1"><span class="text-muted">Контрагент:</span> <a href="javascript:void(0)" onclick="app.openEntity('client', ${m.supplier_id})" class="text-primary text-decoration-none">${Utils.escapeHtml(m.supplier_name)}</a></div>`);
        if (m.order_doc) details.push(`<div class="font-13 text-wrap mb-1"><span class="text-muted">Заказ:</span> <a href="javascript:void(0)" onclick="app.openEntity('document_order', ${m.order_id})" class="text-primary text-decoration-none">${Utils.escapeHtml(m.order_doc)}</a></div>`);
        if (m.batch_number) details.push(`<div class="font-13 text-wrap mb-1"><span class="text-muted">Партия:</span> <a href="javascript:void(0)" onclick="openBatchCard(${m.batch_id})" class="text-primary text-decoration-none">#${Utils.escapeHtml(m.batch_number)}</a></div>`);
        if (m.unit_price && parseFloat(m.unit_price) > 0) details.push(`<div class="font-13 text-muted">Цена: ${parseFloat(m.unit_price).toLocaleString('ru-RU', {minimumFractionDigits: 2})} ₽</div>`);
        
        // Красивое отображение маршрута
        let routeHtml = '';
        if (inQty > 0 && outQty > 0) {
            routeHtml = `<div class="mt-2 font-13"><span class="text-muted mr-1">Откуда:</span> ${rawSource}</div><div class="font-13"><span class="text-muted mr-1">Куда:</span> ${rawDest}</div>`;
        } else if (inQty > 0) {
            routeHtml = `<div class="mt-2 font-13"><span class="text-muted mr-1">Откуда:</span> ${rawSource}</div><div class="font-13"><span class="text-muted mr-1">Склад:</span> ${rawDest}</div>`;
        } else {
            routeHtml = `<div class="mt-2 font-13"><span class="text-muted mr-1">Склад:</span> ${rawSource}</div><div class="font-13"><span class="text-muted mr-1">Куда:</span> ${rawDest}</div>`;
        }

        html += `
            <tr class="hover-bg-surface-alt transition-all">
                <td class="font-14 w-15 p-12 align-middle">
                    <div class="mb-1">${dateStr}</div>
                    <div class="text-muted font-12">${sourceName}</div>
                </td>
                <td class="w-30 p-12 align-middle">
                    <div class="badge bg-surface-alt text-main border font-13 px-2 py-1">${typeName}</div>
                    ${routeHtml}
                </td>
                <td class="text-success font-15 font-weight-600 text-center w-10 p-12 align-middle">
                    ${inQtyStr}
                </td>
                <td class="text-danger font-15 font-weight-600 text-center w-10 p-12 align-middle">
                    ${outQtyStr}
                </td>
                <td class="font-15 font-weight-bold text-center w-10 p-12 align-middle">
                    ${balanceStr} <span class="font-13 font-weight-normal text-muted">${unitStr}</span>
                </td>
                <td class="w-25 p-12 align-middle">
                    ${details.join('')}
                </td>
            </tr>
        `;
    });
    
    if (searchQuery && matchCount === 0) {
        html += `<tr><td colspan="6" class="text-center p-20 text-muted font-italic">По вашему запросу ничего не найдено</td></tr>`;
    }
    
    html += `</tbody></table>`;
    tbody.innerHTML = html;
    
    tfoot.innerHTML = `
        <div class="inv-history-summary">
            <div class="font-15">Итоговый остаток на конец: <b>${currentBalance.toLocaleString('ru-RU', {minimumFractionDigits:2})} ${unitStrShared}</b></div>
            <div class="d-flex gap-20 font-14">
                <span class="text-success font-weight-500">Приход: +${sumIn.toLocaleString('ru-RU', {minimumFractionDigits:2})}</span>
                <span class="text-danger font-weight-500">Расход: -${sumOut.toLocaleString('ru-RU', {minimumFractionDigits:2})}</span>
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

/** Поднимает оверлей над #modal-item-history (карточка движения, z-index 10011), если она открыта */
function elevateModalOverItemHistory(modalEl) {
    if (!modalEl) return;
    const hist = document.getElementById('modal-item-history');
    if (hist && hist.classList.contains('active')) {
        modalEl.classList.add('modal-over-item-history');
    } else {
        modalEl.classList.remove('modal-over-item-history');
    }
}



window.openBatchStatsModal = async function(batchId, batchNum) {
    if (!batchId) {
        UI.toast("Партия без ID", "warning");
        return;
    }
    const modal = document.getElementById('modal-batch-stats');
    if (!modal) return;
    modal.classList.remove('reports-batch-modal-front', 'reports-batch-card-modal-front');
    modal.classList.remove('d-none');
    modal.classList.add('active');
    elevateModalOverItemHistory(modal);
    
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
    modal.classList.remove('reports-batch-modal-front', 'reports-batch-card-modal-front');
    modal.classList.remove('d-none');
    modal.classList.add('active');
    elevateModalOverItemHistory(modal);

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
    const progressPct = Math.max(0, Math.min(100, Number(d.progress_pct) || 0));
    const progressStep = Math.round(progressPct / 5) * 5;
    html += `<div class="batch-progress-bar"><div class="batch-progress-fill batch-progress-fill-pct-${progressStep}"></div></div>`;
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

    // === Анализ отклонений (Plan vs Fact) — для completed-партий ===
    if (a.is_closed || b.status === 'completed') {
        html += '<div class="batch-section-card" id="batch-deviation-section">';
        html += '<div class="batch-section-title">📊 Анализ отклонений (План vs Факт)</div>';
        html += '<div id="batch-deviation-body" class="text-muted font-13">⏳ Загрузка...</div>';
        html += '</div>';

        // Async load
        setTimeout(async () => {
            const container = document.getElementById('batch-deviation-body');
            if (!container) return;
            try {
                const dev = await API.get(`/api/production/analytics/batch-deviations/${b.id}`);
                if (!dev || !dev.materials || dev.materials.length === 0) {
                    container.innerHTML = '<div class="text-muted">Нет данных для анализа (нет расхода или рецепта)</div>';
                    return;
                }

                const fmtN = (v) => Number(v || 0).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                const fmtQ = (v) => Number(v || 0).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 4 });

                // Summary badges
                let devHtml = '<div class="batch-analytics-grid" style="margin-bottom:12px">';
                devHtml += `<div class="batch-analytics-item"><div class="batch-analytics-value">${dev.batch.yield_pct}%</div><div class="batch-analytics-label">Выход 1с</div></div>`;
                devHtml += `<div class="batch-analytics-item"><div class="batch-analytics-value" style="color:var(--color-warning)">${fmtN(dev.totals.scrap_loss_cost)} ₽</div><div class="batch-analytics-label">Потери (брак)</div></div>`;
                const unaccColor = dev.totals.unaccounted_loss_cost > 0 ? 'var(--color-danger)' : 'var(--color-success)';
                devHtml += `<div class="batch-analytics-item"><div class="batch-analytics-value" style="color:${unaccColor}">${fmtN(dev.totals.unaccounted_loss_cost)} ₽</div><div class="batch-analytics-label">Перерасход</div></div>`;
                devHtml += '</div>';

                // Table
                devHtml += '<div style="overflow-x:auto"><table class="erp-table" style="font-size:12px;width:100%">';
                devHtml += '<thead><tr><th>Сырьё</th><th style="text-align:right">Факт</th><th style="text-align:right">План (1с)</th><th style="text-align:right">Брак</th><th style="text-align:right">Перерасход</th></tr></thead><tbody>';

                for (const m of dev.materials) {
                    const hasLoss = m.unaccounted_loss_cost > 0.01;
                    const lossStyle = hasLoss ? ' style="color:var(--color-danger);font-weight:600"' : '';
                    devHtml += '<tr>';
                    devHtml += `<td>${Utils.escapeHtml(m.name)}<span class="text-muted font-11"> (${m.unit})</span></td>`;
                    devHtml += `<td style="text-align:right">${fmtQ(m.fact_qty)}<br><span class="text-muted">${fmtN(m.fact_cost)} ₽</span></td>`;
                    devHtml += `<td style="text-align:right">${fmtQ(m.plan_good_qty)}<br><span class="text-muted">${fmtN(m.plan_good_cost)} ₽</span></td>`;
                    devHtml += `<td style="text-align:right">${fmtQ(m.scrap_qty)}<br><span class="text-muted">${fmtN(m.scrap_loss_cost)} ₽</span></td>`;
                    devHtml += `<td style="text-align:right"${lossStyle}>${fmtQ(m.unaccounted_loss_qty)}<br><span${lossStyle}>${fmtN(m.unaccounted_loss_cost)} ₽</span></td>`;
                    devHtml += '</tr>';
                }

                // Totals
                devHtml += '<tr style="font-weight:700;border-top:2px solid var(--border-color)">';
                devHtml += '<td>ИТОГО</td>';
                devHtml += `<td style="text-align:right">${fmtN(dev.totals.fact_cost)} ₽</td>`;
                devHtml += `<td style="text-align:right">${fmtN(dev.totals.plan_good_cost)} ₽</td>`;
                devHtml += `<td style="text-align:right">${fmtN(dev.totals.scrap_loss_cost)} ₽</td>`;
                const totalLossStyle = dev.totals.unaccounted_loss_cost > 0.01 ? ' style="text-align:right;color:var(--color-danger)"' : ' style="text-align:right"';
                devHtml += `<td${totalLossStyle}>${fmtN(dev.totals.unaccounted_loss_cost)} ₽</td>`;
                devHtml += '</tr></tbody></table></div>';

                if (dev.totals.amortization > 0) {
                    devHtml += `<div class="text-muted font-12 mt-5">+ Амортизация (станок + форма): ${fmtN(dev.totals.amortization)} ₽</div>`;
                }

                container.innerHTML = devHtml;
            } catch (e) {
                console.error('Ошибка загрузки анализа отклонений:', e);
                container.innerHTML = '<div class="text-muted">Не удалось загрузить анализ отклонений</div>';
            }
        }, 50);
    }

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

// === ВНЕСЕНИЕ ИЗЛИШКОВ ===
let surplusSelectInstance = null;

window.openSurplusModal = async function() {
    const modal = document.getElementById('modal-surplus');
    if (modal) {
        modal.classList.remove('inv-hidden', 'd-none');
        modal.classList.add('active');
    }
    const select = document.getElementById('surplus-item-select');
    document.getElementById('surplus-qty').value = '';

    if (surplusSelectInstance) {
        surplusSelectInstance.clear();
        surplusSelectInstance.clearOptions();
    } else {
        surplusSelectInstance = new TomSelect(select, {
            valueField: 'id',
            labelField: 'name',
            searchField: 'name',
            placeholder: 'Поиск товара...',
            render: {
                option: function(data, escape) {
                    return '<div><span class="font-medium">' + escape(data.name) + '</span></div>';
                },
                item: function(data, escape) {
                    return '<div>' + escape(data.name) + '</div>';
                }
            }
        });
    }

    try {
        const res = await API.get('/api/items');
        surplusSelectInstance.addOption(res.data);
    } catch (e) {
        console.error('Failed to load items', e);
    }
}

window.submitSurplus = async function() {
    const itemId = surplusSelectInstance.getValue();
    const qty = parseFloat(document.getElementById('surplus-qty').value);
    
    if (!itemId) return UI.toast('Выберите товар из каталога!', 'error');
    if (isNaN(qty) || qty <= 0) return UI.toast('Введите корректное количество излишка!', 'error');

    const auditDateStr = document.getElementById('inventory-date-filter')?.value || '';

    try {
        await API.post('/api/inventory/audit', {
            warehouseId: currentWarehouseFilter,
            adjustments: [{
                itemId: itemId,
                batchId: 'new', // 🚀 Триггерит генерацию новой системной партии излишка!
                actualQty: qty 
            }],
            auditDate: auditDateStr,
            reason: 'Оприходование излишков'
        });

        const modal = document.getElementById('modal-surplus');
        if (modal) {
            modal.classList.add('inv-hidden', 'd-none');
            modal.classList.remove('active');
        }
        if (surplusSelectInstance) surplusSelectInstance.clear();
        UI.toast('✅ Излишки успешно оприходованы в новую партию!', 'success');
        loadTable();
    } catch (e) {
        console.error(e);
    }
}

try {
    const savedDensity = localStorage.getItem('inventoryDensity') || 'compact';
    inventoryDensity = savedDensity === 'standard' ? 'standard' : 'compact';
} catch (_) {
    inventoryDensity = 'compact';
}
applyInventoryDensity();

// === МОДАЛКА ДЕТАЛИЗАЦИИ РЕЗЕРВОВ ===
window.openReserveDetailModal = async function (itemId) {
    try {
        const data = await API.get(`/api/inventory/reserves-detail/${itemId}`);
        if (!data || !Array.isArray(data.orders)) {
            return UI.toast('Не удалось загрузить данные резервов', 'error');
        }

        const statusLabels = {
            'pending': '⏳ Ожидает',
            'processing': '🔄 В работе',
            'completed': '✅ Завершён',
            'cancelled': '❌ Отменён'
        };

        const rows = data.orders.map(o => `
            <tr class="inv-reserve-detail-row">
                <td><a href="javascript:void(0)" class="text-primary" onclick="UI.closeModal(); if(typeof openInventoryOrder==='function') openInventoryOrder(${o.orderId})">${Utils.escapeHtml(o.docNumber)}</a></td>
                <td>${Utils.escapeHtml(o.clientName)}</td>
                <td><span class="badge inv-order-badge">${statusLabels[o.status] || o.status}</span></td>
                <td class="text-right font-bold">${o.qtyReserved.toLocaleString('ru-RU', {maximumFractionDigits: 2})}</td>
                <td class="text-right">${o.qtyOrdered.toLocaleString('ru-RU', {maximumFractionDigits: 2})}</td>
                <td class="text-right">${o.qtyShipped.toLocaleString('ru-RU', {maximumFractionDigits: 2})}</td>
                <td class="text-right">${o.remaining.toLocaleString('ru-RU', {maximumFractionDigits: 2})}</td>
            </tr>
        `).join('');

        const html = `
            <div class="inv-reserve-detail-summary">
                <div class="inv-reserve-detail-metric">
                    <span class="inv-reserve-detail-label">Склад ГП (свободно)</span>
                    <span class="inv-reserve-detail-value">${data.totalFreeStock.toLocaleString('ru-RU', {maximumFractionDigits: 2})} ${Utils.escapeHtml(data.itemUnit || '')}</span>
                </div>
                <div class="inv-reserve-detail-metric">
                    <span class="inv-reserve-detail-label">Итого в резерве</span>
                    <span class="inv-reserve-detail-value inv-reserve-detail-value--reserved">${data.totalReserved.toLocaleString('ru-RU', {maximumFractionDigits: 2})} ${Utils.escapeHtml(data.itemUnit || '')}</span>
                </div>
                <div class="inv-reserve-detail-metric">
                    <span class="inv-reserve-detail-label">Заказов с резервом</span>
                    <span class="inv-reserve-detail-value">${data.orders.length}</span>
                </div>
            </div>
            <table class="inv-reserve-detail-table">
                <thead>
                    <tr>
                        <th>Заказ</th>
                        <th>Клиент</th>
                        <th>Статус</th>
                        <th class="text-right">Резерв</th>
                        <th class="text-right">Заказано</th>
                        <th class="text-right">Отгружено</th>
                        <th class="text-right">Осталось</th>
                    </tr>
                </thead>
                <tbody>${rows || '<tr><td colspan="7" class="text-center text-muted">Нет активных резервов</td></tr>'}</tbody>
            </table>
        `;

        UI.showModal(`🔒 Резервы: ${Utils.escapeHtml(data.itemName)}`, html, `<button class="btn btn-outline" onclick="UI.closeModal()">Закрыть</button>`);
    } catch (e) {
        console.error('Reserve detail error:', e);
        UI.toast('Ошибка загрузки детализации резервов', 'error');
    }
};