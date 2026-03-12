// === public/js/inventory.js ===

let allInventory = [];
let currentWarehouseFilter = 'all';
let isAuditMode = false; // Флаг режима инвентаризации

function loadTable() {
    fetch('/api/inventory')
        .then(res => res.json())
        .then(data => {
            allInventory = data;
            renderInventoryTable();
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
window.toggleAuditMode = function () {
    if (currentWarehouseFilter === 'all' && !isAuditMode) {
        return UI.toast('Для инвентаризации выберите конкретный склад (например, Склад №4)!', 'warning');
    }

    isAuditMode = !isAuditMode;
    const btnMode = document.getElementById('btn-audit-mode');
    const btnSave = document.getElementById('btn-audit-save');

    if (isAuditMode) {
        btnMode.classList.replace('btn-outline', 'btn-red');
        btnMode.innerText = '❌ Отменить инвентаризацию';
        btnSave.style.display = 'inline-block';
        UI.toast('Режим инвентаризации включен. Введите фактические остатки.', 'info');
    } else {
        btnMode.classList.replace('btn-red', 'btn-outline');
        btnMode.innerText = '📋 Инвентаризация';
        btnSave.style.display = 'none';
    }
    renderInventoryTable();
};

window.saveAudit = async function () {
    const inputs = document.querySelectorAll('.audit-qty-input');
    let adjustments = [];

    inputs.forEach(input => {
        const newQty = parseFloat(input.value);
        const oldQty = parseFloat(input.getAttribute('data-old-qty'));
        const diffQty = newQty - oldQty;

        // Если цифра изменилась - записываем корректировку
        if (diffQty !== 0 && !isNaN(diffQty)) {
            adjustments.push({
                itemId: input.getAttribute('data-item-id'),
                batchId: input.getAttribute('data-batch-id') || null,
                diffQty: diffQty
            });
        }
    });

    if (adjustments.length === 0) {
        toggleAuditMode();
        return UI.toast('Нет изменений. Остатки верны.', 'success');
    }

    try {
        const res = await fetch('/api/inventory/audit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                warehouseId: currentWarehouseFilter,
                adjustments: adjustments
            })
        });

        if (res.ok) {
            UI.toast('✅ Инвентаризация успешно проведена!', 'success');
            toggleAuditMode();
            loadTable();
        } else {
            UI.toast('Ошибка сохранения: ' + await res.text(), 'error');
        }
    } catch (e) { console.error(e); }
};

function renderInventoryTable() {
    const tbody = document.getElementById('inventory-table');
    if (!tbody) return;
    tbody.innerHTML = '';

    const filtered = allInventory.filter(item => {
        if (parseFloat(item.total) === 0) return false;
        if (currentWarehouseFilter !== 'all' && String(item.warehouse_id) !== currentWarehouseFilter) return false;
        return true;
    });

    if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 30px;">На складе нет остатков</td></tr>';
        return;
    }

    filtered.forEach(item => {
        let actionHtml = '';
        let qtyHtml = '';

        if (isAuditMode) {
            // РЕЖИМ ИНВЕНТАРИЗАЦИИ: Поле ввода
            qtyHtml = `<td style="text-align: right;">
                <input type="number" class="input-modern audit-qty-input" 
                       data-item-id="${item.item_id}" 
                       data-batch-id="${item.batch_id || ''}" 
                       data-old-qty="${item.total}" 
                       value="${parseFloat(item.total)}" 
                       style="width: 100px; padding: 4px; text-align: right; font-weight: bold; border: 2px solid var(--primary); margin: 0; background: #fff;"
                       onfocus="this.select()">
            </td>`;
        } else {
            // ОБЫЧНЫЙ РЕЖИМ: Просто текст
            qtyHtml = `<td style="font-weight: bold; font-size: 15px; text-align: right;">${parseFloat(item.total).toLocaleString('ru-RU')}</td>`;

            // Кнопки действий зависят от склада
            if (item.warehouse_id === 3) {
                actionHtml = `<button class="btn btn-blue" style="padding: 4px 8px; font-size: 12px;" 
                            onclick="openDemoldingModal(${item.batch_id}, '${item.batch_number || 'Б/Н'}', ${item.item_id}, '${item.item_name}', ${item.total})">
                            🧱 Распалубить
                          </button>`;
            } else if (item.warehouse_id === 5 || item.warehouse_id === 6) {
                actionHtml = `<button class="btn btn-outline" style="padding: 4px 8px; font-size: 12px; color: #991b1b; border-color: #fca5a5; background: #fef2f2;" 
                            onclick="openDisposeModal(${item.item_id}, '${item.item_name}', ${item.batch_id || 'null'}, '${item.batch_number || ''}', ${item.warehouse_id}, ${item.total})">
                            🗑️ Утилизировать
                          </button>`;
            } else {
                actionHtml = `<button class="btn btn-outline" style="padding: 4px 8px; font-size: 12px; color: var(--danger); border-color: var(--danger);" 
                            onclick="openScrapModal(${item.item_id}, '${item.item_name}', ${item.batch_id || 'null'}, '${item.batch_number || ''}', ${item.warehouse_id}, ${item.total})">
                            ↘️ Переместить
                          </button>`;
            }
        }

        tbody.innerHTML += `
            <tr style="transition: 0.2s;" onmouseover="this.style.backgroundColor='#f8fafc'" onmouseout="this.style.backgroundColor=''">
                <td><span class="badge" style="background: #e2e8f0; color: #475569;">${item.warehouse_name}</span></td>
                <td style="color: var(--primary); font-weight: bold;">${item.batch_number ? '#' + item.batch_number : (item.batch_id ? '#' + item.batch_id : '-')}</td>
                <td><strong>${item.item_name}</strong></td>
                ${qtyHtml}
                <td style="color: var(--text-muted);">${item.unit}</td>
                <td style="text-align: right;">${actionHtml}</td>
            </tr>`;
    });
}

// === СПИСАНИЕ БОЯ И БРАКА ===
window.openScrapModal = function (itemId, itemName, batchId, batchNum, warehouseId, currentQty) {
    const html = `
        <div style="background: #f8fafc; padding: 15px; border-radius: 8px; border: 1px solid var(--border); margin-bottom: 20px;">
            <div style="font-size: 15px;">Продукция: <b>${itemName}</b></div>
            ${batchNum ? `<div style="margin-top: 5px;">Партия: <span style="color: var(--primary); font-weight: bold;">${batchNum}</span></div>` : ''}
            <div style="margin-top: 5px; color: var(--text-muted);">Текущий остаток: <b style="font-size: 16px; color: var(--text-main);">${currentQty}</b> ед.</div>
        </div>

        <input type="hidden" id="scrap-item-id" value="${itemId}">
        <input type="hidden" id="scrap-batch-id" value="${batchId || ''}">
        <input type="hidden" id="scrap-warehouse-id" value="${warehouseId}">
        
        <div class="form-group">
            <label style="color: var(--danger); font-weight: bold;">Количество брака/боя:</label>
            <input type="number" id="scrap-qty" class="input-modern" placeholder="Сколько разбилось?" max="${currentQty}" onfocus="this.select()">
        </div>
        <div class="form-group">
            <label>Причина списания:</label>
            <input type="text" id="scrap-desc" class="input-modern" placeholder="Например: Разбили при погрузке вилочником" value="Списание боя/брака со склада">
            <small style="color: var(--text-muted); margin-top: 5px; display: block;">Списанный объем переместится на Склад №6 (Изолятор брака) для учета мусора.</small>
        </div>
    `;

    const buttons = `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-red" onclick="executeScrap()">🔨 Списать в утиль</button>
    `;

    UI.showModal('Списание брака', html, buttons);
};

window.executeScrap = async function () {
    const itemId = document.getElementById('scrap-item-id').value;
    const batchId = document.getElementById('scrap-batch-id').value;
    const warehouseId = document.getElementById('scrap-warehouse-id').value;
    const scrapQty = parseFloat(document.getElementById('scrap-qty').value);
    const desc = document.getElementById('scrap-desc').value;

    if (!scrapQty || scrapQty <= 0) return UI.toast('Введите корректное количество', 'warning');

    try {
        const res = await fetch('/api/inventory/scrap', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                itemId: itemId,
                batchId: batchId || null,
                warehouseId: warehouseId,
                scrapQty: scrapQty,
                description: desc
            })
        });

        if (res.ok) {
            UI.closeModal();
            UI.toast('Брак успешно списан', 'success');
            loadTable();
        } else {
            UI.toast('Ошибка списания', 'error');
        }
    } catch (e) { console.error(e); }
};


// === ОКНО РАСПАЛУБКИ ===
window.openDemoldingModal = function (batchId, batchNum, tileId, productName, plannedQty) {
    const html = `
        <div style="background: #f8fafc; padding: 15px; border-radius: 8px; border: 1px solid var(--border); margin-bottom: 20px;">
            <h4 style="margin: 0 0 5px 0;">Партия: <span style="color: var(--primary);">${batchNum}</span></h4>
            <div style="font-size: 15px;">Продукция: <b>${productName}</b></div>
            <div style="margin-top: 5px; color: var(--text-muted);">В сушилке числится (Остаток): <b style="font-size: 16px; color: var(--text-main);">${plannedQty}</b> ед.</div>
        </div>

        <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 15px;">Укажите фактический выход из сушилки. Если часть плитки разбилась — запишите в брак. Если партия выгружена не полностью — снимите галочку закрытия.</p>

        <div class="form-grid" style="grid-template-columns: 1fr 1fr 1fr;">
            <div class="form-group" style="background: #f0fdf4; padding: 10px; border-radius: 6px; border: 1px dashed var(--success);">
                <label style="color: var(--success); font-weight: bold;">🟢 1-й сорт (Годная):</label>
                <input type="number" id="demold-good" class="input-modern" style="font-size: 18px; font-weight: bold; color: var(--success);" value="${plannedQty}">
            </div>
            <div class="form-group" style="background: #fffbeb; padding: 10px; border-radius: 6px; border: 1px dashed #d97706;">
                <label style="color: #d97706; font-weight: bold;">🟡 2-й сорт (Уценка):</label>
                <input type="number" id="demold-grade2" class="input-modern" style="font-size: 16px; font-weight: bold;" value="0">
            </div>
            <div class="form-group" style="background: #fef2f2; padding: 10px; border-radius: 6px; border: 1px dashed var(--danger);">
                <label style="color: var(--danger); font-weight: bold;">🔴 Брак (Бой):</label>
                <input type="number" id="demold-scrap" class="input-modern" style="font-size: 16px; font-weight: bold; color: var(--danger);" value="0">
            </div>
        </div>
        
        <div style="margin-top: 15px;">
            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; font-weight: bold; background: #e2e8f0; padding: 12px; border-radius: 6px;">
                <input type="checkbox" id="demold-complete" checked style="width: 18px; height: 18px;">
                Полностью закрыть партию (списать остатки из сушилки в ноль)
            </label>
        </div>
    `;

    const buttons = `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-blue" onclick="executeDemolding(${batchId}, ${tileId}, ${plannedQty})">💾 Сохранить выход</button>
    `;

    UI.showModal('🧱 Распалубка и приемка на склад', html, buttons);
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
        const res = await fetch('/api/move-wip', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ batchId, tileId, currentWipQty, goodQty, grade2Qty, scrapQty, isComplete })
        });

        if (res.ok) {
            UI.closeModal();
            UI.toast('Партия успешно распределена по складам!', 'success');
            loadTable();
        } else {
            UI.toast('Ошибка при распалубке', 'error');
        }
    } catch (e) { console.error(e); }
};

// === ПЕРЕМЕЩЕНИЕ В УЦЕНКУ (5) ИЛИ УТИЛЬ (6) ===
window.openScrapModal = function (itemId, itemName, batchId, batchNum, warehouseId, currentQty) {
    const html = `
        <div style="background: #f8fafc; padding: 15px; border-radius: 8px; border: 1px solid var(--border); margin-bottom: 20px;">
            <div style="font-size: 15px;">Продукция: <b>${itemName}</b></div>
            ${batchNum ? `<div style="margin-top: 5px;">Партия: <span style="color: var(--primary); font-weight: bold;">${batchNum}</span></div>` : ''}
            <div style="margin-top: 5px; color: var(--text-muted);">Остаток: <b style="font-size: 16px; color: var(--text-main);">${currentQty}</b> ед.</div>
        </div>

        <input type="hidden" id="scrap-item-id" value="${itemId}">
        <input type="hidden" id="scrap-batch-id" value="${batchId || ''}">
        <input type="hidden" id="scrap-warehouse-id" value="${warehouseId}">
        
        <div class="form-group">
            <label style="font-weight: bold;">Куда перемещаем?</label>
            <select id="scrap-target-wh" class="input-modern" style="border-color: #d97706;">
                <option value="5">🟡 На Склад №5 (Уценка / 2-й сорт)</option>
                <option value="6">🔴 На Склад №6 (Утиль / На выброс)</option>
            </select>
        </div>

        <div class="form-grid" style="grid-template-columns: 1fr 1fr;">
            <div class="form-group">
                <label>Количество:</label>
                <input type="number" id="scrap-qty" class="input-modern" max="${currentQty}" placeholder="0" onfocus="this.select()">
            </div>
            <div class="form-group">
                <label>Причина:</label>
                <input type="text" id="scrap-desc" class="input-modern" value="Отбраковка">
            </div>
        </div>
    `;

    const buttons = `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-blue" onclick="executeScrap()">➡️ Выполнить перемещение</button>
    `;
    UI.showModal('Перемещение продукции', html, buttons);
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
        const res = await fetch('/api/inventory/scrap', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ itemId, batchId: batchId || null, warehouseId, targetWarehouseId: targetWh, scrapQty, description: desc })
        });
        if (res.ok) {
            UI.closeModal();
            UI.toast('Успешно перемещено!', 'success');
            loadTable();
        } else UI.toast('Ошибка списания', 'error');
    } catch (e) { console.error(e); }
};

// =========================================================
// БЕЗВОЗВРАТНАЯ УТИЛИЗАЦИЯ (ВЫВОЗ НА СВАЛКУ ИЗ СКЛАДОВ 5 И 6)
// =========================================================

window.openDisposeModal = function (itemId, itemName, batchId, batchNum, warehouseId, maxQty) {
    const html = `
        <div style="padding: 10px;">
            <p style="margin-top: 0; color: var(--text-muted);">
                Списание брака/утиля <b>${itemName}</b> ${batchNum ? '(Партия #' + batchNum + ')' : ''} со склада. Эта операция безвозвратна.
            </p>
            <div class="form-group">
                <label>Количество для списания (макс: ${maxQty}):</label>
                <input type="number" id="dispose-qty" class="input-modern" max="${maxQty}" value="${maxQty}" style="font-weight: bold; color: #dc2626;">
                
                <input type="hidden" id="dispose-item-id" value="${itemId}">
                <input type="hidden" id="dispose-batch-id" value="${batchId || ''}">
                <input type="hidden" id="dispose-warehouse-id" value="${warehouseId}">
            </div>
            <div class="form-group">
                <label>Причина / Комментарий:</label>
                <input type="text" id="dispose-desc" class="input-modern" value="Безвозвратная утилизация (вывоз на свалку)">
            </div>
        </div>
    `;

    const buttons = `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-blue" style="background: #dc2626; border-color: #dc2626;" onclick="executeDispose()">🗑️ Списать навсегда</button>
    `;
    UI.showModal('⚠️ Безвозвратная утилизация', html, buttons);
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
        const res = await fetch('/api/inventory/dispose', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                itemId: itemId, 
                batchId: batchId || null, 
                warehouseId: warehouseId, 
                disposeQty: disposeQty, 
                description: desc 
            })
        });
        
        const data = await res.json();
        
        if (res.ok) {
            UI.closeModal();
            UI.toast(data.message || '✅ Успешно утилизировано', 'success');
            loadTable(); // Автоматически обновляем таблицу остатков
        } else {
            UI.toast(data.error || 'Ошибка при утилизации', 'error');
        }
    } catch (e) {
        console.error(e);
        UI.toast('Критическая ошибка связи с сервером', 'error');
    }
};