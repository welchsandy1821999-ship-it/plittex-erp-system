// === public/js/inventory.js ===

let allInventory = [];
let currentWarehouseFilter = 'all';

function loadTable() {
    fetch('/api/inventory')
        .then(res => res.json())
        .then(data => {
            allInventory = data;
            renderInventoryTable();
        });
}

function applyWarehouseFilter(id, btn) {
    currentWarehouseFilter = id;
    document.querySelectorAll('#stock-mod .filter-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    renderInventoryTable();
}

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
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">На складе нет остатков</td></tr>';
        return;
    }

    filtered.forEach(item => {
        let actionHtml = '';

        // ДОБАВЛЯЕМ КНОПКУ РАСПАЛУБКИ ТОЛЬКО ДЛЯ СУШИЛКИ (Склад №3)
        if (item.warehouse_id === 3) {
            actionHtml = `<button class="btn btn-blue" style="padding: 4px 8px; font-size: 12px;" 
                            onclick="openDemoldingModal(${item.batch_id}, '${item.batch_number || 'Б/Н'}', ${item.item_id}, '${item.item_name}', ${item.total})">
                            📦 Распалубить
                          </button>`;
        }

        tbody.innerHTML += `<tr>
            <td><span class="badge" style="background: #e2e8f0; color: #475569;">${item.warehouse_name}</span></td>
            <td style="color: var(--primary); font-weight: bold;">${item.batch_number ? '#' + item.batch_number : (item.batch_id ? '#' + item.batch_id : '-')}</td>
            <td><strong>${item.item_name}</strong></td>
            <td style="font-weight: bold; font-size: 15px;">${parseFloat(item.total).toLocaleString('ru-RU')}</td>
            <td style="color: var(--text-muted);">${item.unit}</td>
            <td style="text-align: center;">${actionHtml}</td>
        </tr>`;
    });
}

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
            loadTable(); // Моментально обновляем главную таблицу (сушилка опустеет, Склад №4 пополнится)
        } else {
            UI.toast('Ошибка при распалубке', 'error');
        }
    } catch (e) { console.error(e); }
};