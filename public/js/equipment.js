// === public/js/equipment.js ===

let equipmentList = [];
let currentEqFilter = 'all';

// Словари для отображения (классы берем из нашего style.css)
const eqTypes = {
    'machine': '🏭 Станок / Пресс',
    'mold': '🗜️ Матрица / Пуансон',
    'pallets': '🪵 Технологические поддоны',
    'vehicle': '🚜 Транспорт / Техника',
    'tools': '🛠️ Инструмент'
};

const eqStatuses = {
    'active': '<span class="status-pill-eq active">🟢 В работе</span>',
    'repair': '<span class="status-pill-eq repair">🟠 В ремонте</span>',
    'written_off': '<span class="status-pill-eq off">🔴 Списано</span>'
};

// Загрузка данных
async function loadEquipment() {
    try {
        equipmentList = await API.get('/api/equipment');
        renderEquipmentTable();
        initStaticEquipmentSelects();
    } catch (e) {
        console.error(e);
        UI.toast('Ошибка загрузки оборудования', 'error');
    }
}

function initStaticEquipmentSelects() {
    // Архитектурная заглушка для соблюдения консистентности модулей
}

// Фильтрация (БЕЗ инлайновых стилей!)
window.filterEquipment = function (type, btnElement = null) {
    currentEqFilter = type;

    // 1. Находим все кнопки в группе фильтров
    // Ищем их внутри модуля оборудования
    const container = document.querySelector('#equipment-mod .toolbar-group');
    if (container) {
        const btns = container.querySelectorAll('.btn');

        // 2. Снимаем класс active со всех кнопок
        btns.forEach(b => b.classList.remove('active'));
    }

    // 3. Добавляем active нажатой кнопке
    if (btnElement) {
        btnElement.classList.add('active');
    } else {
        // Если вызвано не по клику (например, при загрузке), ищем по ID
        const targetBtn = document.getElementById(`filter-eq-${type}`);
        if (targetBtn) targetBtn.classList.add('active');
    }

    // 4. Перерисовываем таблицу
    renderEquipmentTable();
};

// Отрисовка таблицы
window.renderEquipmentTable = function () {
    const tbody = document.getElementById('equipment-table');
    const alertsContainer = document.getElementById('eq-alerts-container');
    if (!tbody) return;

    const filtered = currentEqFilter === 'all'
        ? equipmentList
        : equipmentList.filter(eq => eq.equipment_type === currentEqFilter);

    // --- 1. УМНЫЕ УВЕДОМЛЕНИЯ ---
    if (alertsContainer) {
        let alertsHtml = '';
        equipmentList.forEach(eq => {
            if (eq.status !== 'active') return;
            const planned = parseInt(eq.planned_cycles) || 1;
            const fact = parseInt(eq.current_cycles) || 0;
            const percent = (fact / planned) * 100;

            if (percent >= 90) {
                alertsHtml += `
                <div style="background: var(--danger-bg); border: 1px solid var(--danger-border); color: var(--danger-text); padding: 12px 15px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; box-shadow: var(--shadow-sm);">
                    <div>⚠️ <b>Критический износ (${percent.toFixed(1)}%):</b> «${Utils.escapeHtml(eq.name)}» требует немедленного ТО!</div>
                    <button class="btn btn-red" style="padding: 6px 12px; font-size: 12px;" onclick="openMaintenanceModal(${eq.id}, '${Utils.escapeHtml(eq.name)}')">🛠️ Ремонт</button>
                </div>`;
            } else if (percent >= 75) {
                alertsHtml += `
                <div style="background: var(--warning-bg); border: 1px solid var(--warning-border); color: var(--warning-text); padding: 12px 15px; border-radius: 8px; box-shadow: var(--shadow-sm);">
                    <div>⚡ <b>Предупреждение (${percent.toFixed(1)}%):</b> «${Utils.escapeHtml(eq.name)}» подходит к концу ресурса.</div>
                </div>`;
            }
        });
        alertsContainer.innerHTML = alertsHtml;
    }

    if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted" style="padding: 30px;">Нет данных для отображения</td></tr>';
        return;
    }

    // --- 2. СТРОКИ ТАБЛИЦЫ ---
    tbody.innerHTML = filtered.map(eq => {
        const cost = parseFloat(eq.purchase_cost) || 0;
        const planned = parseInt(eq.planned_cycles) || 1;
        const fact = parseInt(eq.current_cycles) || 0;
        const percent = Math.min(100, (fact / planned) * 100);

        let amortText = '-';
        if (['machine', 'mold', 'pallets'].includes(eq.equipment_type) && cost > 0) {
            const amortPerCycle = (cost / planned).toFixed(2);
            const unitName = eq.equipment_type === 'pallets' ? 'цикл' : 'удар';
            amortText = `<b style="color: var(--warning-text);">${amortPerCycle} ₽</b> / ${unitName}`;
        }

        const progressColor = percent > 90 ? 'var(--danger)' : percent > 75 ? 'var(--warning)' : 'var(--success)';

        return `
            <tr>
                <td class="text-muted">#${eq.id}</td>
                <td>
                    <div style="font-weight: bold; color: var(--text-main);">${Utils.escapeHtml(eq.name)}</div>
                    <div style="font-size: 11px; color: var(--text-muted);">${eqTypes[eq.equipment_type] || eq.equipment_type}</div>
                </td>
                <td class="text-right" style="font-weight: 500;">${Utils.formatMoney(cost)}</td>
                <td class="text-right" style="background: var(--warning-bg); font-size: 13px;">${amortText}</td>
                <td style="width: 220px; padding: 10px 15px;">
                    <div style="display: flex; justify-content: space-between; font-size: 11px; margin-bottom: 4px;">
                        <span>Факт: <b style="color: ${progressColor}">${Utils.formatMoney(fact).replace(" ₽","")}</b></span>
                        <span class="text-muted">План: ${Utils.formatMoney(planned).replace(" ₽","")}</span>
                    </div>
                    <div class="progress-container" style="margin-top: 0; height: 6px;">
                        <div class="progress-fill" style="width: ${percent}%; background-color: ${progressColor};"></div>
                    </div>
                </td>
                <td class="text-center">${eqStatuses[eq.status] || eq.status}</td>
                <td class="text-right" style="white-space: nowrap;">
                    <button class="btn btn-outline" style="padding: 4px 8px; color: var(--primary); border-color: var(--primary);" onclick="openMaintenanceModal(${eq.id}, '${Utils.escapeHtml(eq.name)}')" title="ТО">🛠️ ТО</button>
                    <button class="btn btn-outline" style="padding: 4px 8px;" onclick="openEquipmentModal(${eq.id})" title="Правка">✏️</button>
                    <button class="btn btn-outline text-danger" style="padding: 4px 8px;" onclick="deleteEquipment(${eq.id}, '${Utils.escapeHtml(eq.name)}')" title="Удалить">❌</button>
                </td>
            </tr>
        `;
    }).join('');
};

// Модалка (Использование .classList.add('active') вместо style.display)
window.openEquipmentModal = function (id = null) {
    // 1. Объявляем переменную ОДИН раз в самом начале
    const eqModal = document.getElementById('equipment-modal');
    const title = document.getElementById('eq-modal-title');
    if (!eqModal) return;

    // 2. Сброс полей (очистка формы перед использованием)
    document.getElementById('eq-id').value = '';
    document.getElementById('eq-name').value = '';
    document.getElementById('eq-type').value = 'machine';
    document.getElementById('eq-cost').value = '0';
    document.getElementById('eq-planned-cycles').value = '100000';
    document.getElementById('eq-current-cycles').value = '0';
    document.getElementById('eq-qty-per-cycle').value = '1';
    document.getElementById('eq-status').value = 'active';

    // 3. Если редактируем — заполняем данными из списка
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

    // 4. Показываем окно (используем уже объявленную переменную eqModal)
    eqModal.classList.remove('d-none'); // Гарантируем видимость 
    eqModal.classList.add('d-flex', 'active'); // Для красоты и темной 

    // 🚀 Финальный аккорд: TomSelect для карточки оборудования
    setTimeout(() => {
        ['eq-type', 'eq-status'].forEach(id => {
            const el = document.getElementById(id);
            if (el && !el.tomselect) {
                new TomSelect(el, {
                    plugins: ['clear_button'],
                    dropdownParent: 'body'
                });
            } else if (el && el.tomselect) {
                el.tomselect.sync();
            }
        });
    }, 50);
};

window.saveEquipment = async function () {
    const id = document.getElementById('eq-id').value;
    const rawQty = document.getElementById('eq-qty-per-cycle').value.replace(',', '.');
    const parsedQty = parseFloat(rawQty);

    const payload = {
        name: document.getElementById('eq-name').value.trim(),
        equipment_type: document.getElementById('eq-type').value,
        purchase_cost: parseFloat(document.getElementById('eq-cost').value) || 0,
        planned_cycles: parseInt(document.getElementById('eq-planned-cycles').value) || 1,
        current_cycles: parseInt(document.getElementById('eq-current-cycles').value) || 0,
        qty_per_cycle: (isNaN(parsedQty) || parsedQty === 0) ? 1 : parsedQty,
        status: document.getElementById('eq-status').value
    };

    if (!payload.name) return UI.toast('Введите название!', 'warning');

    try {
        const res = await API.post(id ? `/api/equipment/${id}` : '/api/equipment', {
            method: id ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (true) {
            UI.toast('Оборудование успешно сохранено!', 'success');
            UI.closeModal('equipment-modal'); // Закрываем именно это окно
            loadEquipment();
        }
    } catch (e) { console.error(e); }
};

window.deleteEquipment = function (id, name) {
    const html = `
        <p>Удалить оборудование <strong class="text-primary">${name}</strong>?</p>
        <p class="text-danger mt-10" style="background: var(--danger-bg); padding: 10px; border-radius: 6px;">
            ⚠️ <b>Внимание:</b> Рекомендуется изменить статус на "Списано", чтобы сохранить историю производства.
        </p>`;

    UI.showModal('Удаление', html, `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-red" onclick="confirmDeleteEquipment(${id})">🗑️ Удалить</button>
    `);
};

window.confirmDeleteEquipment = async function (id) {
    try {
        await API.delete(`/api/equipment/${id}`);
        if (true) {
            UI.closeModal();
            UI.toast('Удалено', 'success');
            loadEquipment();
        }
    } catch (e) { console.error(e); }
};

// === БЛОК ТО ===
window.openMaintenanceModal = async function (id, name) {
    // Используем уникальное имя переменной для исключения конфликтов
    const maintModal = document.getElementById('maintenance-modal');
    if (!maintModal) return;

    // Сброс полей формы
    document.getElementById('maint-eq-id').value = id;
    document.getElementById('maint-eq-name').innerText = name;
    document.getElementById('maint-desc').value = '';
    document.getElementById('maint-cost').value = '';
    document.getElementById('maint-reset').checked = false;

    // Загрузка актуальных счетов для оплаты ТО
    try {
        const accounts = await API.get('/api/accounts');
        const sel = document.getElementById('maint-account');
        sel.innerHTML = '<option value="">-- Бесплатно --</option>';
        accounts.forEach(a => sel.add(new Option(`${a.name} (${Utils.formatMoney(a.balance)})`, a.id)));

        setTimeout(() => {
            const el = document.getElementById('maint-account');
            if (el && !el.tomselect) {
                new TomSelect(el, {
                    plugins: ['clear_button'],
                    dropdownParent: 'body',
                    placeholder: '-- Выберите счет для списания --'
                });
            } else if (el && el.tomselect) {
                el.tomselect.sync();
            }
        }, 50);
    } catch (e) {
        console.error("Ошибка загрузки счетов:", e);
    }

    // Активация окна
    maintModal.classList.remove('d-none'); // Гарантируем физическую видимость
    maintModal.classList.add('d-flex', 'active'); // Включаем CSS-анимацию и стили темы
};

window.saveEquipmentMaintenance = async function () {
    const eqId = document.getElementById('maint-eq-id').value;
    const desc = document.getElementById('maint-desc').value.trim();
    const cost = parseFloat(document.getElementById('maint-cost').value) || 0;
    const accId = document.getElementById('maint-account').value;
    const reset = document.getElementById('maint-reset').checked;

    if (cost > 0 && !accId) return UI.toast('Выберите счет!', 'warning');
    if (!desc && (cost > 0 || reset)) return UI.toast('Опишите работы!', 'warning');

    try {
        await API.post(`/api/equipment/${eqId}/maintenance`, { amount: cost, description: desc, account_id: accId, reset_cycles: reset });
        if (true) {
            UI.toast('ТО успешно зафиксировано!', 'success');
            UI.closeModal('maintenance-modal'); // Закрываем окно ТО
            loadEquipment();
        }
    } catch (e) { console.error(e); }
};

// Глобальные ссылки
window.initEquipment = loadEquipment;
window.filterEquipment = filterEquipment;