// === public/js/equipment.js ===

let equipmentList = [];
let currentEqFilter = 'all';

// Словари для красивого отображения в таблице
const eqTypes = {
    'machine': '🏭 Станок / Пресс',
    'mold': '🗜️ Матрица / Пуансон',
    'pallets': '🪵 Технологические поддоны',
    'vehicle': '🚜 Транспорт / Техника',
    'tools': '🛠️ Инструмент'
};

const eqStatuses = {
    'active': '<span style="color: #16a34a; background: #dcfce7; padding: 3px 8px; border-radius: 12px; font-size: 12px;">🟢 В работе</span>',
    'repair': '<span style="color: #d97706; background: #fef3c7; padding: 3px 8px; border-radius: 12px; font-size: 12px;">🟠 В ремонте</span>',
    'written_off': '<span style="color: #dc2626; background: #fee2e2; padding: 3px 8px; border-radius: 12px; font-size: 12px;">🔴 Списано</span>'
};

// Загрузка данных с сервера
async function loadEquipment() {
    try {
        const res = await fetch('/api/equipment');
        equipmentList = await res.json();
        renderEquipmentTable();
    } catch (e) {
        console.error(e);
        UI.toast('Ошибка загрузки оборудования', 'error');
    }
}

// Фильтрация (кнопки сверху)
window.filterEquipment = function (type) {
    currentEqFilter = type;

    // Перекрашиваем кнопки
    ['all', 'machine', 'mold', 'pallets', 'vehicle'].forEach(t => {
        const btn = document.getElementById(`filter-eq-${t}`);
        if (btn) {
            if (t === type) {
                btn.style.background = 'var(--primary)';
                btn.style.color = 'white';
            } else {
                btn.style.background = 'transparent';
                btn.style.color = 'var(--text-main)';
            }
        }
    });

    renderEquipmentTable();
};

// Отрисовка таблицы (С УМНЫМИ УВЕДОМЛЕНИЯМИ)
function renderEquipmentTable() {
    const tbody = document.getElementById('equipment-table');
    if (!tbody) return;

    const filtered = currentEqFilter === 'all'
        ? equipmentList
        : equipmentList.filter(eq => eq.equipment_type === currentEqFilter);

    // --- ГЕНЕРАЦИЯ УМНЫХ УВЕДОМЛЕНИЙ ---
    const alertsContainer = document.getElementById('eq-alerts-container');
    if (alertsContainer) {
        let alertsHtml = '';
        equipmentList.forEach(eq => {
            if (eq.status !== 'active') return;
            const planned = parseInt(eq.planned_cycles) || 1;
            const fact = parseInt(eq.current_cycles) || 0;
            const percent = (fact / planned) * 100;

            if (percent >= 90) {
                alertsHtml += `
                <div style="background: #fef2f2; border: 1px solid #fecaca; color: #991b1b; padding: 10px 15px; border-radius: 6px; display: flex; justify-content: space-between; align-items: center;">
                    <div>⚠️ <b>Критический износ ( ${percent.toFixed(1)}% ):</b> Оборудование «${eq.name}» требует немедленного ТО или замены!</div>
                    <button class="btn btn-red" style="padding: 4px 10px; font-size: 12px; white-space: nowrap;" onclick="openMaintenanceModal(${eq.id}, '${eq.name}')">🛠️ Провести ремонт</button>
                </div>`;
            } else if (percent >= 75) {
                alertsHtml += `
                <div style="background: #fffbeb; border: 1px solid #fde68a; color: #92400e; padding: 10px 15px; border-radius: 6px; display: flex; justify-content: space-between; align-items: center;">
                    <div>⚡ <b>Предупреждение ( ${percent.toFixed(1)}% ):</b> Оборудование «${eq.name}» подходит к концу ресурса. Подготовьте замену или реставрацию.</div>
                </div>`;
            }
        });
        alertsContainer.innerHTML = alertsHtml;
    }
    // -----------------------------------

    if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 20px;">Нет данных для отображения</td></tr>';
        return;
    }

    tbody.innerHTML = filtered.map(eq => {
        const cost = parseFloat(eq.purchase_cost) || 0;
        const planned = parseInt(eq.planned_cycles) || 1;
        const fact = parseInt(eq.current_cycles) || 0;

        let amortText = '-';
        if (['machine', 'mold'].includes(eq.equipment_type) && cost > 0) {
            const amortPerCycle = (cost / planned).toFixed(2);
            amortText = `<b style="color: #92400e;">${amortPerCycle} ₽</b> / удар`;
        }

        const percent = Math.min(100, (fact / planned) * 100);
        const progressColor = percent > 90 ? '#dc2626' : percent > 75 ? '#d97706' : '#16a34a';

        return `
            <tr style="transition: 0.2s;" onmouseover="this.style.backgroundColor='#f8fafc'" onmouseout="this.style.backgroundColor=''">
                <td style="color: var(--text-muted);">#${eq.id}</td>
                <td>
                    <div style="font-weight: bold; color: var(--text-main);">${eq.name}</div>
                    <div style="font-size: 11px; color: var(--text-muted);">${eqTypes[eq.equipment_type] || eq.equipment_type}</div>
                </td>
                <td style="text-align: right; font-weight: 500;">${cost.toLocaleString('ru-RU')} ₽</td>
                <td style="text-align: right; background: #fef3c7; border-radius: 4px;">${amortText}</td>
                <td style="width: 200px;">
                    <div style="display: flex; justify-content: space-between; font-size: 11px; margin-bottom: 3px;">
                        <span>Факт: <b style="color: ${progressColor}">${fact.toLocaleString('ru-RU')}</b></span>
                        <span style="color: var(--text-muted);">План: ${planned.toLocaleString('ru-RU')}</span>
                    </div>
                    <div style="width: 100%; height: 6px; background: #e2e8f0; border-radius: 3px; overflow: hidden;">
                        <div style="height: 100%; width: ${percent}%; background: ${progressColor};"></div>
                    </div>
                </td>
                <td style="text-align: center;">${eqStatuses[eq.status] || eq.status}</td>
                <td style="text-align: right; white-space: nowrap;">
                    <button class="btn btn-outline" style="padding: 4px 8px; margin-right: 5px; color: var(--primary); border-color: var(--primary);" onclick="openMaintenanceModal(${eq.id}, '${eq.name}')" title="Провести ТО / Ремонт">🛠️ ТО</button>
                    <button class="btn btn-outline" style="padding: 4px 8px; margin-right: 5px;" onclick="openEquipmentModal(${eq.id})" title="Редактировать">✏️</button>
                    <button class="btn btn-outline" style="color: var(--danger); padding: 4px 8px;" onclick="deleteEquipment(${eq.id}, '${eq.name}')" title="Удалить">❌</button>
                </td>
            </tr>
        `;
    }).join('');
}

// Открытие модального окна (Добавление / Редактирование)
window.openEquipmentModal = function (id = null) {
    const modal = document.getElementById('equipment-modal');
    const title = document.getElementById('eq-modal-title');

    // Сброс полей
    document.getElementById('eq-id').value = '';
    document.getElementById('eq-name').value = '';
    document.getElementById('eq-type').value = 'machine';
    document.getElementById('eq-cost').value = '1200000';
    document.getElementById('eq-planned-cycles').value = '50000';
    document.getElementById('eq-current-cycles').value = '0';
    document.getElementById('eq-qty-per-cycle').value = '1';
    document.getElementById('eq-status').value = 'active';

    if (id) {
        title.innerText = '✏️ Редактировать оборудование';
        const eq = equipmentList.find(e => e.id === id);
        if (eq) {
            document.getElementById('eq-id').value = eq.id;
            document.getElementById('eq-name').value = eq.name;
            document.getElementById('eq-type').value = eq.equipment_type;
            document.getElementById('eq-cost').value = eq.purchase_cost;
            document.getElementById('eq-planned-cycles').value = eq.planned_cycles;
            document.getElementById('eq-current-cycles').value = eq.current_cycles || 0;
            document.getElementById('eq-qty-per-cycle').value = eq.qty_per_cycle || 1;
            document.getElementById('eq-status').value = eq.status;
        }
    } else {
        title.innerText = '➕ Добавить оборудование';
    }

    modal.style.display = 'flex';
};

// Сохранение данных на сервер
window.saveEquipment = async function () {
    const id = document.getElementById('eq-id').value;

    // Защита от запятых: принудительно меняем ',' на '.'
    let rawQty = document.getElementById('eq-qty-per-cycle').value.replace(',', '.');
    let parsedQty = parseFloat(rawQty);

    const payload = {
        name: document.getElementById('eq-name').value.trim(),
        equipment_type: document.getElementById('eq-type').value,
        purchase_cost: parseFloat(document.getElementById('eq-cost').value) || 0,
        planned_cycles: parseInt(document.getElementById('eq-planned-cycles').value) || 1,
        current_cycles: parseInt(document.getElementById('eq-current-cycles').value) || 0, // <--- НОВОЕ ПОЛЕ
        qty_per_cycle: (isNaN(parsedQty) || parsedQty === 0) ? 1 : parsedQty, // Непробиваемая проверка
        status: document.getElementById('eq-status').value
    };

    if (!payload.name) return UI.toast('Введите название оборудования!', 'warning');
    if (payload.planned_cycles < 1) return UI.toast('Плановый ресурс должен быть больше 0!', 'warning');

    const method = id ? 'PUT' : 'POST';
    const url = id ? `/api/equipment/${id}` : '/api/equipment';

    try {
        const res = await fetch(url, {
            method: method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (res.ok) {
            UI.toast('Оборудование успешно сохранено!', 'success');
            document.getElementById('equipment-modal').style.display = 'none';
            loadEquipment();
        } else {
            UI.toast('Ошибка сохранения', 'error');
        }
    } catch (e) {
        console.error(e);
        UI.toast('Ошибка связи с сервером', 'error');
    }
};

// === ИСПОЛЬЗУЕМ КРАСИВЫЙ UI ДЛЯ ПОДТВЕРЖДЕНИЯ УДАЛЕНИЯ ===
window.deleteEquipment = function (id, name) {
    const html = `
        <p style="font-size: 15px;">Вы уверены, что хотите безвозвратно удалить оборудование <strong style="color: var(--primary);">${name}</strong>?</p>
        <p style="font-size: 13px; color: var(--danger); margin-top: 10px; background: #fef2f2; padding: 10px; border-radius: 6px;">
            ⚠️ <b>Внимание:</b> Если это оборудование уже участвовало в производстве или связано с продукцией, удаление может вызвать ошибки в истории! Рекомендуется изменить статус на "Списано", а не удалять физически.
        </p>
    `;
    const buttons = `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-red" onclick="confirmDeleteEquipment(${id})">🗑️ Да, удалить</button>
    `;
    UI.showModal('Удаление оборудования', html, buttons);
};

// Выполнение физического удаления
window.confirmDeleteEquipment = async function (id) {
    try {
        const res = await fetch(`/api/equipment/${id}`, { method: 'DELETE' });
        if (res.ok) {
            UI.closeModal();
            UI.toast('Оборудование удалено', 'success');
            loadEquipment();
        } else {
            const errText = await res.text();
            UI.toast(errText || 'Ошибка удаления', 'error');
            UI.closeModal();
        }
    } catch (e) {
        console.error(e);
        UI.toast('Ошибка связи с сервером', 'error');
        UI.closeModal();
    }
};

// === БЛОК ТО и РЕМОНТА ===
window.openMaintenanceModal = async function (id, name) {
    document.getElementById('maint-eq-id').value = id;
    document.getElementById('maint-eq-name').innerText = name;
    document.getElementById('maint-desc').value = '';
    document.getElementById('maint-cost').value = '';
    document.getElementById('maint-reset').checked = false;

    try {
        const res = await fetch('/api/accounts');
        const accounts = await res.json();
        const sel = document.getElementById('maint-account');
        sel.innerHTML = '<option value="">-- Бесплатно (Без списания) --</option>';
        accounts.forEach(a => sel.add(new Option(`${a.name} (${a.balance} ₽)`, a.id)));
    } catch (e) { console.error(e); }

    document.getElementById('maintenance-modal').style.display = 'flex';
};

window.saveMaintenance = async function () {
    const eqId = document.getElementById('maint-eq-id').value;
    const desc = document.getElementById('maint-desc').value.trim();
    const cost = parseFloat(document.getElementById('maint-cost').value) || 0;
    const accId = document.getElementById('maint-account').value;
    const reset = document.getElementById('maint-reset').checked;

    if (cost > 0 && !accId) return UI.toast('Выберите счет для оплаты ремонта!', 'warning');
    if (!desc && (cost > 0 || reset)) return UI.toast('Опишите, что именно было сделано (замена масла, сварка и т.д.)', 'warning');

    try {
        const res = await fetch(`/api/equipment/${eqId}/maintenance`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount: cost, description: desc, account_id: accId, reset_cycles: reset })
        });

        if (res.ok) {
            UI.toast('ТО успешно зафиксировано!', 'success');
            document.getElementById('maintenance-modal').style.display = 'none';
            loadEquipment(); // Перезагружаем таблицу (удары обнулятся, если стояла галочка)
        } else {
            UI.toast('Ошибка сохранения: ' + await res.text(), 'error');
        }
    } catch (e) {
        console.error(e);
        UI.toast('Ошибка связи с сервером', 'error');
    }
};

// Запускаем загрузку данных при открытии модуля
// (Можно вызвать это из index.ejs при переключении вкладок)
document.addEventListener('DOMContentLoaded', () => {
    // Ждем секунду, чтобы UI инициализировался
    setTimeout(loadEquipment, 500);
});