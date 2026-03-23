let salesProductsInfo = {};
let stockMap = {};
let currentSelectedItem = null;
let cart = [];
let currentSalesWarehouse = 'all';

// Переменные для списков и пагинации
let allActiveOrders = [];
let boPage = 1;
let boSearch = '';

let allSalesHistory = [];
let historyPage = 1;
let historySearch = '';
let historyDateRange = { start: '', end: '' };
let historyDatePicker = null;

function initSales() {
    const whSelect = document.getElementById('sale-warehouse');
    if (whSelect) currentSalesWarehouse = whSelect.value;

    const dateInput = document.getElementById('hist-date-filter');
    if (dateInput && typeof flatpickr !== 'undefined' && !dateInput._flatpickr) {
        historyDatePicker = flatpickr(dateInput, {
            mode: "range",
            dateFormat: "Y-m-d",
            altInput: true,
            altFormat: "d.m.Y",
            locale: "ru",
            onChange: function (selectedDates, dateStr, instance) {
                if (selectedDates.length === 1) {
                    historyDateRange.start = instance.formatDate(selectedDates[0], "Y-m-d");
                    historyDateRange.end = instance.formatDate(selectedDates[0], "Y-m-d");
                } else if (selectedDates.length === 2) {
                    historyDateRange.start = instance.formatDate(selectedDates[0], "Y-m-d");
                    historyDateRange.end = instance.formatDate(selectedDates[1], "Y-m-d");
                } else {
                    historyDateRange = { start: '', end: '' };
                }
                applyHistoryFilters();
            }
        });
    }

    loadSalesData(true);
    loadSalesHistory();
    if (typeof loadActiveOrders === 'function') loadActiveOrders();
}

window.setHistoryDateRange = function (type) {
    if (!historyDatePicker) return;
    const today = new Date();
    let start = new Date(), end = new Date();

    switch (type) {
        case 'today': break;
        case 'week':
            const day = today.getDay();
            const diff = today.getDate() - day + (day === 0 ? -6 : 1);
            start.setDate(diff); end = new Date(start); end.setDate(start.getDate() + 6);
            break;
        case 'month':
            start = new Date(today.getFullYear(), today.getMonth(), 1);
            end = new Date(today.getFullYear(), today.getMonth() + 1, 0);
            break;
        case 'quarter':
            const q = Math.floor(today.getMonth() / 3);
            start = new Date(today.getFullYear(), q * 3, 1);
            end = new Date(today.getFullYear(), q * 3 + 3, 0);
            break;
        case 'year':
            start = new Date(today.getFullYear(), 0, 1);
            end = new Date(today.getFullYear(), 11, 31);
            break;
    }
    historyDatePicker.setDate([start, end], true);
};

window.changeSaleWarehouse = function () {
    currentSalesWarehouse = document.getElementById('sale-warehouse').value;
    loadSalesData(false);
    document.getElementById('sale-product-input').value = '';
    updateSaleMaxQty();
};

window.loadClientContracts = async function (cpId) {
    const id = cpId || document.getElementById('sale-client').value;
    const contractSelect = document.getElementById('sale-contract');
    const contractGroup = document.getElementById('sale-contract-group');

    if (!id) {
        if (contractGroup) contractGroup.style.display = 'none';
        if (contractSelect) contractSelect.innerHTML = '';
        return;
    }

    try {
        const res = await fetch(`/api/counterparties/${id}/contracts`);
        const data = await res.json();

        if (contractSelect) {
            contractSelect.innerHTML = '<option value="">-- Разовая продажа (Без договора) --</option>';
            data.forEach(row => {
                // Умное отображение: Договор + привязанная Спецификация
                const baseStr = `Договор №${row.contract_number} от ${row.contract_date}`;
                const optText = row.spec_id ? `${baseStr} (Спец. №${row.spec_number} от ${row.spec_date})` : baseStr;
                let opt = new Option(optText, row.contract_id);
                opt.setAttribute('data-cid', row.contract_id);
                contractSelect.add(opt);
            });
        }
        if (contractGroup) contractGroup.style.display = 'block';
    } catch (e) { console.error('Ошибка загрузки договоров:', e); }
};

// Комментарий к блоку: Главный обработчик смены клиента. 
// Загружает профиль, договоры, рисует розовую карточку и защищает корзину от махинаций с ценами.
window.onClientChange = async function () {
    const clientSelect = document.getElementById('sale-client');
    const cpId = clientSelect ? clientSelect.value : null;
    const infoBox = document.getElementById('sale-client-info');
    const contractGroup = document.getElementById('sale-contract-group');

    // Комментарий к блоку: ЗАЩИТА БИЗНЕС-ЛОГИКИ.
    // Если менеджер сменил клиента, а в корзине уже лежат товары, 
    // мы жестко очищаем корзину. Это предотвратит продажу по чужому прайсу 
    // (например, если первый клиент был дилером, а второй - розничным).
    if (typeof cart !== 'undefined' && cart.length > 0) {
        clearOrderForm(); // 🚀 ПОЛНАЯ ОЧИСТКА ВСЕХ ПОЛЕЙ И КОРЗИНЫ
        UI.toast('Внимание! Корзина и данные доставки очищены из-за смены контрагента', 'warning');
    }

    // Комментарий к блоку: Обработка сброса.
    // Если поле клиента очистили (нажали на крестик или стерли текст), 
    // просто прячем розовую карточку и блок договоров.
    if (!cpId) {
        if (infoBox) infoBox.style.display = 'none';
        if (contractGroup) contractGroup.style.display = 'none';
        return;
    }

    // Комментарий к блоку: Загрузка связанных данных (договоры и доверенности)
    await loadClientContracts(cpId);
    if (typeof loadClientPoas === 'function') await loadClientPoas();

    // Обновляем UI-элементы ввода
    if (typeof updateDatalistUI === 'function') updateDatalistUI();
    if (typeof updateSaleMaxQty === 'function') updateSaleMaxQty();

    try {
        // Комментарий к блоку: Запрос профиля клиента с сервера
        const res = await fetch(`/api/counterparties/${cpId}/profile`);

        // Комментарий к блоку: Обработка ошибки 404 (клиент был удален в другой вкладке)
        if (!res.ok) {
            UI.toast('Контрагент не найден (возможно, был удален). Обновляем список...', 'warning');

            // Запускаем нашу новую умную функцию очистки (без перезагрузки всей страницы)
            if (typeof syncClientsDropdown === 'function') {
                await syncClientsDropdown();
            }

            // Сбрасываем выбор в поле поиска
            if (clientSelect && clientSelect.tomselect) {
                clientSelect.tomselect.setValue('', true);
            } else if (clientSelect) {
                clientSelect.value = '';
            }

            // Прячем блоки
            if (infoBox) infoBox.style.display = 'none';
            if (contractGroup) contractGroup.style.display = 'none';
            return;
        }

        const data = await res.json();
        const client = data.info;

        // Комментарий к блоку: Подсчет общей суммы долгов клиента
        let totalDebt = 0;
        (data.invoices || []).forEach(inv => {
            if (inv.status === 'pending') totalDebt += parseFloat(inv.amount);
        });

        // Комментарий к блоку: Отрисовка шапки клиента (Имя + Статус прайса + Кнопка настроек)
        const priceLevel = client.price_level || 'basic';
        const badgeHtml = priceLevel === 'dealer'
            ? `<span style="background: var(--info-bg); color: var(--info); padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: bold; border: 1px solid #ddd6fe;">👑 ДИЛЕР</span>`
            : `<span style="background: var(--surface-alt); color: var(--text-muted); padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: bold; border: 1px solid #e2e8f0;">👤 Розница</span>`;

        const headerHtml = `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; padding-bottom: 10px; border-bottom: 1px dashed var(--primary);">
                <div style="display: flex; align-items: center; gap: 10px;">
                    <span style="font-weight: bold; font-size: 14px; color: var(--primary);">${client.name}</span>
                    ${badgeHtml}
                </div>
                <button class="btn btn-outline" style="padding: 4px 10px; font-size: 11px; border-color: var(--primary); color: var(--primary); background: var(--surface);" onclick="openClientEditor(${cpId})">
                    ⚙️ Карточка
                </button>
            </div>
        `;

        // Вставляем шапку в розовый блок
        let statusDiv = document.getElementById('sale-client-status');
        if (!statusDiv) {
            statusDiv = document.createElement('div');
            statusDiv.id = 'sale-client-status';
            infoBox.insertBefore(statusDiv, infoBox.firstChild);
        }
        statusDiv.innerHTML = headerHtml;

        // Комментарий к блоку: Обновление информации по долгам (зеленый/красный текст)
        const debtEl = document.getElementById('sale-client-debt');
        if (debtEl) {
            debtEl.innerText = totalDebt > 0 ? `${totalDebt.toLocaleString('ru-RU')} ₽` : 'Нет долгов 🟢';
            debtEl.style.color = totalDebt > 0 ? 'var(--danger)' : 'var(--success)';
        }

        // Комментарий к блоку: Обновление баланса поддонов
        const palletsEl = document.getElementById('sale-client-pallets');
        if (palletsEl) {
            const pallets = parseInt(client.pallets_balance) || 0;
            palletsEl.innerText = pallets > 0 ? `${pallets} шт.` : '0 шт.';
            palletsEl.style.color = pallets > 0 ? 'var(--warning-text)' : 'var(--success)';
        }

        // Показываем розовый блок
        if (infoBox) infoBox.style.display = 'block';
    } catch (e) {
        console.error('Ошибка загрузки профиля:', e);
    }
};

// === ОТКРЫТИЕ CRM-КАРТОЧКИ КЛИЕНТА ПРЯМО ИЗ ПРОДАЖ ===
window.openClientEditor = async function (id) {
    try {
        const res = await fetch(`/api/counterparties/${id}/profile`);
        const data = await res.json();
        const c = data.info;

        const isDealer = c.price_level === 'dealer';
        const badgeHtml = isDealer
            ? `<div style="background: var(--info-bg); color: var(--info); padding: 12px; border-radius: 6px; text-align: center; font-size: 14px; font-weight: bold; margin-bottom: 15px; border: 1px dashed #c4b5fd;">👑 ТЕКУЩИЙ СТАТУС: ДИЛЕР (Оптовые цены)</div>`
            : `<div style="background: var(--surface-hover); color: var(--text-muted); padding: 12px; border-radius: 6px; text-align: center; font-size: 14px; font-weight: bold; margin-bottom: 15px; border: 1px dashed var(--border);">👤 ТЕКУЩИЙ СТАТУС: БАЗОВЫЙ ПРАЙС (Розница)</div>`;

        const html = `
            <div style="padding: 10px; max-height: 70vh; overflow-y: auto;">
                ${badgeHtml}
                <div class="form-grid" style="grid-template-columns: 1fr 1fr; gap: 15px;">
                    <div class="form-group" style="grid-column: span 2;">
                        <label>Наименование клиента:</label>
                        <input type="tel" id="edit-cp-name" class="input-modern" value="${c.name || ''}">
                    </div>
                    
                    <div class="form-group">
                        <label>Уровень цен (Прайс):</label>
                        <select id="edit-cp-level" class="input-modern" style="border-color: var(--info); color: #5b21b6; font-weight: bold;">
                            <option value="basic" ${!isDealer ? 'selected' : ''}>Основная (Розница)</option>
                            <option value="dealer" ${isDealer ? 'selected' : ''}>Дилерская (Опт)</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label>Тип контрагента:</label>
                        <select id="edit-cp-type" class="input-modern">
                            <option value="Покупатель" ${c.type === 'Покупатель' ? 'selected' : ''}>Покупатель</option>
                            <option value="Поставщик" ${c.type === 'Поставщик' ? 'selected' : ''}>Поставщик</option>
                        </select>
                    </div>
                    
                    <div class="form-group"><label>ИНН:</label><input type="text" id="edit-cp-inn" class="input-modern" value="${c.inn || ''}"></div>
                    <div class="form-group"><label>КПП:</label><input type="text" id="edit-cp-kpp" class="input-modern" value="${c.kpp || ''}"></div>
                    
                    <div class="form-group"><label>Телефон:</label><input type="text" id="edit-cp-phone" class="input-modern" value="${c.phone || ''}"></div>
                    <div class="form-group"><label>Email:</label><input type="text" id="edit-cp-email" class="input-modern" value="${c.email || ''}"></div>
                    
                    <div class="form-group" style="grid-column: span 2;"><label>Адрес (Юр. / Факт.):</label><input type="text" id="edit-cp-address" class="input-modern" value="${c.legal_address || ''}"></div>
                    <div class="form-group" style="grid-column: span 2;"><label>Директор (ФИО):</label><input type="text" id="edit-cp-director" class="input-modern" value="${c.director_name || ''}"></div>
                    
                    <h4 style="grid-column: span 2; margin: 10px 0 0 0; color: var(--primary); border-bottom: 1px solid var(--border); padding-bottom: 5px;">💳 Реквизиты (Для счетов)</h4>
                    <div class="form-group"><label>ОГРН:</label><input type="text" id="edit-cp-ogrn" class="input-modern" value="${c.ogrn || ''}"></div>
                    <div class="form-group"><label>БИК Банка:</label><input type="text" id="edit-cp-bik" class="input-modern" value="${c.bik || ''}"></div>
                    <div class="form-group" style="grid-column: span 2;"><label>Название банка:</label><input type="text" id="edit-cp-bank" class="input-modern" value="${c.bank_name || ''}"></div>
                    <div class="form-group" style="grid-column: span 2;"><label>Расчетный счет:</label><input type="text" id="edit-cp-account" class="input-modern" value="${c.checking_account || ''}"></div>
                </div>
            </div>
        `;

        UI.showModal(`Редактирование: ${c.name}`, html, `
            <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
            <button class="btn btn-blue" onclick="saveClientProfile(${id})">💾 Сохранить изменения</button>
        `);
    } catch (e) {
        console.error(e);
        UI.toast('Ошибка загрузки карточки', 'error');
    }
};

window.saveClientProfile = async function (id) {
    const data = {
        name: document.getElementById('edit-cp-name').value.trim(),
        price_level: document.getElementById('edit-cp-level').value,
        type: document.getElementById('edit-cp-type').value,
        inn: document.getElementById('edit-cp-inn').value.trim(),
        kpp: document.getElementById('edit-cp-kpp').value.trim(),
        phone: document.getElementById('edit-cp-phone').value.trim(),
        email: document.getElementById('edit-cp-email').value.trim(),
        legal_address: document.getElementById('edit-cp-address').value.trim(),
        director_name: document.getElementById('edit-cp-director').value.trim(),
        ogrn: document.getElementById('edit-cp-ogrn').value.trim(),
        bik: document.getElementById('edit-cp-bik').value.trim(),
        bank_name: document.getElementById('edit-cp-bank').value.trim(),
        checking_account: document.getElementById('edit-cp-account').value.trim()
    };

    if (!data.name) return UI.toast('Наименование обязательно!', 'error');

    try {
        const res = await fetch(`/api/counterparties/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });

        if (res.ok) {
            UI.closeModal();
            UI.toast('✅ Карточка успешно обновлена', 'success');

            // Принудительно выбираем этого же клиента, чтобы перерисовать измененные данные
            await syncClientsDropdown(id);
            await loadSalesData(false);
        } else {
            UI.toast('Ошибка при сохранении', 'error');
        }
    } catch (e) { console.error(e); UI.toast('Ошибка соединения', 'error'); }
};

// === ПЕЧАТЬ АКТА СВЕРКИ (С ВЫБОРОМ ДАТ) ===
window.printClientAct = function () {
    const cpId = document.getElementById('sale-client').value;
    if (!cpId) return UI.toast('Выберите клиента', 'warning');
    
    // По умолчанию берем текущий месяц
    const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0];
    const today = new Date().toISOString().split('T')[0];

    const html = `
        <div style="padding: 10px;">
            <p style="margin-top: 0; color: var(--text-muted); font-size: 13px;">Выберите период для формирования акта сверки.</p>
            <div class="form-grid" style="grid-template-columns: 1fr 1fr; gap: 15px;">
                <div class="form-group"><label>Начало периода:</label><input type="date" id="act-start" class="input-modern" value="${startOfMonth}"></div>
                <div class="form-group"><label>Конец периода:</label><input type="date" id="act-end" class="input-modern" value="${today}"></div>
            </div>
        </div>
    `;
    UI.showModal('Печать Акта сверки', html, `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-blue" onclick="executePrintAct(${cpId})">🖨️ Распечатать</button>
    `);
};

// Эта функция сработает после выбора дат в окне
window.executePrintAct = function(cpId) {
    const start = document.getElementById('act-start').value;
    const end = document.getElementById('act-end').value;
    if (!start || !end) return UI.toast('Укажите даты', 'error');
    
    // Отправляем правильный запрос с датами и правильным параметром (cpId)
    window.open(`/print/act?cpId=${cpId}&start=${start}&end=${end}`, '_blank');
    UI.closeModal();
};

window.loadClientPoas = async function () {
    const cpId = document.getElementById('sale-client').value;
    const poaSelect = document.getElementById('sale-poa');
    if (!cpId) return poaSelect.innerHTML = '<option value="">-- Выберите клиента --</option>';

    try {
        const res = await fetch(`/api/counterparties/${cpId}/poas`);
        const data = await res.json();
        poaSelect.innerHTML = '<option value="">-- Выберите доверенность --</option>';
        data.forEach(poa => poaSelect.add(new Option(`${poa.driver_name} — №${poa.number} (действ. до ${poa.expiry_date})`, `№${poa.number} от ${poa.issue_date} (выдана: ${poa.driver_name})`)));
    } catch (e) { console.error(e); }
};

window.toggleSalePayment = function () {
    const method = document.getElementById('sale-payment-method').value;
    document.getElementById('sale-account-group').style.display = (method === 'paid' || method === 'partial') ? 'block' : 'none';
    document.getElementById('sale-advance-group').style.display = method === 'partial' ? 'block' : 'none';
};

window.togglePoaMode = function () {
    const isNoPoa = document.getElementById('sale-no-poa').checked;
    document.getElementById('poa-select-group').style.display = isNoPoa ? 'none' : 'flex';
    document.getElementById('poa-comment-group').style.display = isNoPoa ? 'block' : 'none';
};

window.openPoaManager = function () {
    const cpId = document.getElementById('sale-client').value;
    if (!cpId) return UI.toast('Сначала выберите клиента!', 'warning');

    const html = `
        <div style="padding: 15px;">
            <div class="form-group"><label>ФИО Доверенного лица (Водителя):</label><input type="text" id="new-poa-driver" class="input-modern" placeholder="Иванов И.И."></div>
            <div class="form-group"><label>Номер доверенности:</label><input type="text" id="new-poa-num" class="input-modern" placeholder="Напр: 12-А"></div>
            <div class="form-grid" style="grid-template-columns: 1fr 1fr;">
                <div class="form-group"><label>Дата выдачи:</label><input type="date" id="new-poa-issue" class="input-modern" value="${new Date().toISOString().split('T')[0]}"></div>
                <div class="form-group"><label>Действительна до:</label><input type="date" id="new-poa-expiry" class="input-modern"></div>
            </div>
        </div>
    `;
    UI.showModal('Новая доверенность', html, `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-blue" onclick="saveNewPoa(${cpId})">💾 Сохранить</button>
    `);
};

window.saveNewPoa = async function (cpId) {
    const driver = document.getElementById('new-poa-driver').value.trim();
    const num = document.getElementById('new-poa-num').value.trim();
    const issue = document.getElementById('new-poa-issue').value;
    const expiry = document.getElementById('new-poa-expiry').value;

    if (!driver || !num || !issue || !expiry) return UI.toast('Заполните все поля!', 'warning');
    if (new Date(expiry) < new Date(issue)) return UI.toast('Дата окончания не может быть раньше даты выдачи!', 'error');

    const res = await fetch('/api/poas', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ counterparty_id: cpId, driver_name: driver, number: num, issue_date: issue, expiry_date: expiry })
    });
    if (res.ok) {
        UI.toast('Доверенность добавлена', 'success');
        loadClientPoas();
        UI.closeModal();
    }
};

window.printSelectedContract = function () {
    const select = document.getElementById('sale-contract');
    if (!select || select.selectedIndex < 0) return UI.toast('Выберите договор!', 'warning');
    const cid = select.options[select.selectedIndex].getAttribute('data-cid');
    if (!cid) return UI.toast('Этот пункт нельзя распечатать', 'warning');
    window.open(`/print/contract?id=${cid}`, '_blank');
};

// === НОВЫЙ МОДУЛЬ: УМНАЯ СИНХРОНИЗАЦИЯ КЛИЕНТОВ ===
// 1. Исправленная синхронизация клиентов (без рекурсии)
window.syncClientsDropdown = async function (forceSelectId = null) {
    try {
        const res = await fetch('/api/counterparties');
        const clients = await res.json();
        const clientSel = document.getElementById('sale-client');

        if (!clientSel) return;

        if (!clientSel.tomselect) {
            // ПЕРВАЯ ИНИЦИАЛИЗАЦИЯ
            new TomSelect(clientSel, {
                plugins: ['clear_button'],
                options: clients.map(c => ({ value: c.id, text: c.name, 'data-level': c.price_level || 'basic' })),
                placeholder: "-- Выберите клиента --",
                allowEmptyOption: true,
                onChange: function () {
                    if (typeof onClientChange === 'function') onClientChange();
                }
                // 🛡️ ТУТ БОЛЬШЕ НЕТ onDropdownOpen, который вызывал бесконечный цикл
            });
        } else {
            // ОБНОВЛЕНИЕ
            const ts = clientSel.tomselect;
            const targetVal = forceSelectId ? String(forceSelectId) : ts.getValue();
            ts.clearOptions();
            ts.addOptions(clients.map(c => ({ value: c.id, text: c.name, 'data-level': c.price_level || 'basic' })));
            if (targetVal) ts.setValue(targetVal, true);
        }
    } catch (e) { console.error('Ошибка синхронизации клиентов:', e); }
};

// 2. Исправленная загрузка данных (товары и кассы)
async function loadSalesData(fullLoad = true) {
    try {
        if (fullLoad) {
            await syncClientsDropdown(); // Сначала клиенты

            const accRes = await fetch('/api/accounts');
            const accounts = await accRes.json();
            const accSel = document.getElementById('sale-account');
            if (accSel) {
                accSel.innerHTML = '';
                accounts.forEach(a => accSel.add(new Option(`${a.name} (${a.balance} ₽)`, a.id)));
            }

            const prodRes = await fetch('/api/products');
            const products = await prodRes.json();
            window.salesProductsInfo = {};
            products.forEach(p => salesProductsInfo[String(p.id)] = p);
        }

        const invRes = await fetch('/api/inventory');
        const inventory = await invRes.json();
        stockMap = {};

        const inventoryMap = {};
        inventory.forEach(row => {
            if (!inventoryMap[row.item_name]) inventoryMap[row.item_name] = { '4': 0, '5': 0 };
            if (row.warehouse_id === 4 || row.warehouse_id === 5) {
                inventoryMap[row.item_name][row.warehouse_id] = parseFloat(row.total);
            }
        });

        Object.values(salesProductsInfo).forEach(p => {
            const price = parseFloat(p.price || p.current_price || 0);
            const dealerPrice = parseFloat(p.dealer_price || 0);
            const stock4 = inventoryMap[p.name] ? inventoryMap[p.name]['4'] : 0;
            const stock5 = inventoryMap[p.name] ? inventoryMap[p.name]['5'] : 0;

            if (currentSalesWarehouse === 'all') {
                stockMap[p.name] = { id: p.id, warehouseId: 4, name: p.name, unit: p.unit, qty: stock4, price, dealer_price: dealerPrice, weight: parseFloat(p.weight_kg || 0), sortLabel: 'Авто', allowProduction: true };
            } else if (currentSalesWarehouse === '4' && stock4 > 0) {
                stockMap[p.name] = { id: p.id, warehouseId: 4, name: p.name, unit: p.unit, qty: stock4, price, dealer_price: dealerPrice, weight: parseFloat(p.weight_kg || 0), sortLabel: '1 сорт', allowProduction: false };
            } else if (currentSalesWarehouse === '5' && stock5 > 0) {
                stockMap[p.name] = { id: p.id, warehouseId: 5, name: p.name, unit: p.unit, qty: stock5, price: Math.floor(price * 0.7), dealer_price: Math.floor(dealerPrice * 0.7), weight: parseFloat(p.weight_kg || 0), sortLabel: 'Уценка', allowProduction: false };
            }
        });

        updateDatalistUI();
    } catch (e) { console.error('Ошибка в loadSalesData:', e); }
}
// === НОВАЯ ФУНКЦИЯ: ОБНОВЛЕНИЕ ЦЕН В ВЫПАДАЮЩЕМ СПИСКЕ ПОИСКА ===
window.updateDatalistUI = function () {
    const datalist = document.getElementById('sale-products-datalist');
    if (!datalist) return;
    datalist.innerHTML = '';

    // Смотрим, какой клиент сейчас выбран
    const clientSelect = document.getElementById('sale-client');
    const selectedOption = clientSelect && clientSelect.selectedIndex >= 0 ? clientSelect.options[clientSelect.selectedIndex] : null;
    const priceLevel = selectedOption ? selectedOption.getAttribute('data-level') : 'basic';

    Object.values(stockMap).forEach(item => {
        const opt = document.createElement('option');
        opt.value = item.name;

        // Если клиент дилер и у товара есть оптовая цена, показываем её в подсказке
        let displayPrice = item.price;
        if (priceLevel === 'dealer' && item.dealer_price > 0) {
            displayPrice = item.dealer_price;
        }

        opt.textContent = `В наличии: ${item.qty} ${item.unit} | Цена: ${displayPrice} ₽`;
        datalist.appendChild(opt);
    });
};
window.updateSaleMaxQty = function () {
    const inputVal = document.getElementById('sale-product-input').value.trim();
    currentSelectedItem = stockMap[inputVal];

    if (!currentSelectedItem) {
        document.getElementById('sale-unit-label').innerText = '';
        document.getElementById('sale-max-qty').innerText = `Остаток: 0`;
        document.getElementById('sale-price').value = '';
        return;
    }

    document.getElementById('sale-unit-label').innerText = `(${currentSelectedItem.unit})`;
    document.getElementById('sale-max-qty').innerText = `В наличии: ${currentSelectedItem.qty} ${currentSelectedItem.unit}`;

    // === НОВАЯ ЛОГИКА: ПОДСТАНОВКА ДИЛЕРСКОЙ ИЛИ БАЗОВОЙ ЦЕНЫ ===
    const clientSelect = document.getElementById('sale-client');
    const selectedOption = clientSelect.options[clientSelect.selectedIndex];

    // Получаем уровень цен клиента (если не выбран, по умолчанию 'basic')
    const priceLevel = selectedOption ? selectedOption.getAttribute('data-level') : 'basic';

    // Берем базовую цену (которая записана в current_price или price)
    let finalPrice = parseFloat(currentSelectedItem.price || currentSelectedItem.current_price) || 0;

    // Если клиент Дилер, и у товара реально задана дилерская цена (> 0)
    if (priceLevel === 'dealer' && currentSelectedItem.dealer_price && parseFloat(currentSelectedItem.dealer_price) > 0) {
        finalPrice = parseFloat(currentSelectedItem.dealer_price);
    }

    // Вставляем правильную цену в поле ввода
    document.getElementById('sale-price').value = finalPrice;
};

window.addToCart = function () {
    if (!currentSelectedItem) return UI.toast('Выберите товар из списка умного поиска!', 'warning');

    const qty = parseFloat(document.getElementById('sale-qty').value);
    const price = parseFloat(document.getElementById('sale-price').value);

    if (!qty || qty <= 0) return UI.toast('Укажите количество!', 'warning');

    // 🛡️ ЗАЩИТА: Если выбран конкретный склад (без права на производство) — блокируем продажу в минус!
    if (!currentSelectedItem.allowProduction) {
        const existingQty = cart.filter(c => c.id === currentSelectedItem.id && c.warehouseId === currentSelectedItem.warehouseId).reduce((sum, c) => sum + c.qty, 0);
        if (qty + existingQty > currentSelectedItem.qty) {
            return UI.toast(`На этом складе в наличии только ${currentSelectedItem.qty} ${currentSelectedItem.unit}! Производство отключено.`, 'error');
        }
    }

    cart.push({
        id: currentSelectedItem.id,
        warehouseId: currentSelectedItem.warehouseId,
        sortLabel: currentSelectedItem.sortLabel,
        name: currentSelectedItem.name,
        unit: currentSelectedItem.unit,
        qty: qty,
        price: price,
        weight: currentSelectedItem.weight * qty,
        allowProduction: currentSelectedItem.allowProduction,
        stockAvailable: currentSelectedItem.qty // Запоминаем для красивой отрисовки дефицита
    });

    document.getElementById('sale-product-input').value = '';
    currentSelectedItem = null;
    document.getElementById('sale-unit-label').innerText = '';
    document.getElementById('sale-max-qty').innerText = `Остаток: 0`;
    document.getElementById('sale-price').value = ''; // ИСПРАВЛЕНО (было 0)
    document.getElementById('sale-qty').value = '';   // ИСПРАВЛЕНО (Очищаем поле количества)
    renderCart();
};

window.removeFromCart = function (index) {
    cart.splice(index, 1);
    renderCart();
};

// Функция пересчета при изменении значения прямо в таблице
window.updateCartItem = function (index, field, value) {
    let val = parseFloat(value) || 0;
    
    if (field === 'price' && val < 0) {
        UI.toast('Цена не может быть отрицательной!', 'warning');
        val = 0;
    }
    if (field === 'discount') {
        if (val < 0) {
            UI.toast('Скидка не может быть меньше 0%', 'warning');
            val = 0;
        } else if (val > 100) {
            UI.toast('Скидка не может быть больше 100%', 'warning');
            val = 100;
        }
    }

    cart[index][field] = val;
    renderCart();
};

window.renderCart = function () {
    const tbody = document.getElementById('cart-table');
    if (cart.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 20px;">Корзина пуста</td></tr>';
        document.getElementById('cart-total-sum').innerText = '0';

        // 🚀 ИСПРАВЛЕНИЕ: Жестко обнуляем вес, если корзина пустая
        const weightEl = document.getElementById('cart-total-weight');
        if (weightEl) weightEl.innerText = '0';

        return;
    }

    let subtotal = 0; let totalWeight = 0;

    tbody.innerHTML = cart.map((item, index) => {
        const qty = parseFloat(item.qty) || 0;
        const basePrice = parseFloat(item.price) || 0;
        const discount = parseFloat(item.discount) || 0;

        // Считаем индивидуальную скидку
        const finalPrice = basePrice * (1 - discount / 100);
        const sum = qty * finalPrice;

        subtotal += sum;
        totalWeight += qty * (item.weight || 0);

        return `
            <tr style="border-bottom: 1px solid var(--surface-alt);">
                <td>1 Сорт</td>
                <td><b>${item.name}</b></td>
                <td style="text-align: center;">${qty} ${item.unit}</td>
                <td style="text-align: center;">
                    <input type="number" class="input-modern" style="width: 70px; padding: 4px; text-align: center;" value="${basePrice}" onchange="updateCartItem(${index}, 'price', this.value)">
                </td>
                <td style="text-align: center;">
                    <input type="number" class="input-modern" style="width: 60px; padding: 4px; text-align: center; color: var(--danger);" value="${discount}" min="0" max="100" onchange="updateCartItem(${index}, 'discount', this.value)">
                </td>
                <td style="text-align: right; font-weight: bold; color: var(--primary);">${sum.toFixed(2)} ₽</td>
                <td style="text-align: center;"><button style="background: none; border: none; color: var(--danger); cursor: pointer; font-size: 16px;" onclick="removeFromCart(${index})">✖</button></td>
            </tr>
        `;
    }).join('');

    const globalDiscount = parseFloat(document.getElementById('sale-discount').value) || 0;
    const logistics = parseFloat(document.getElementById('sale-logistics-cost').value) || 0;
    const finalTotal = (subtotal * (1 - globalDiscount / 100)) + logistics;

    document.getElementById('cart-total-weight').innerText = totalWeight.toFixed(1);
    document.getElementById('cart-total-sum').innerText = finalTotal.toLocaleString('ru-RU');
};

// === УМНАЯ ОЧИСТКА ВСЕГО БЛОКА ОФОРМЛЕНИЯ ===
window.clearOrderForm = function () {
    // 1. Очищаем корзину
    cart = [];
    if (typeof renderCart === 'function') renderCart();

    // 2. Очищаем все текстовые и числовые поля
    const fieldsToClear = [
        'sale-discount', 'sale-logistics-cost', 'sale-delivery-address',
        'sale-planned-date', 'sale-pallets', 'sale-driver', 'sale-auto',
        'sale-poa-comment', 'sale-advance-amount'
    ];
    fieldsToClear.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });

    // 3. Сбрасываем чекбоксы и селекты в состояние по умолчанию
    const noPoa = document.getElementById('sale-no-poa');
    if (noPoa) { noPoa.checked = false; togglePoaMode(); }

    const payMethod = document.getElementById('sale-payment-method');
    if (payMethod) { payMethod.value = 'debt'; toggleSalePayment(); }
};

// === ОФОРМЛЕНИЕ ЗАКАЗА (ОТПРАВКА НА СЕРВЕР) ===
window.processCheckout = async function () {
    if (cart.length === 0) return UI.toast('Корзина пуста', 'error');

    const client_id = document.getElementById('sale-client').value;
    if (!client_id) return UI.toast('Выберите клиента', 'error');

    // ==========================================
    // 1. ЖЕСТКАЯ ПРОВЕРКА ДОВЕРЕННОСТИ
    // ==========================================
    const noPoa = document.getElementById('sale-no-poa').checked;
    const poaSelectVal = document.getElementById('sale-poa').value;
    const poaComment = document.getElementById('sale-poa-comment').value.trim();

    if (noPoa) {
        // Если галочка стоит, требуем причину
        if (!poaComment) return UI.toast('Укажите причину отгрузки без доверенности!', 'error');
    } else {
        // Если галочки нет, ТРЕБУЕМ выбрать доверенность из списка
        if (!poaSelectVal) return UI.toast('Выберите доверенность из списка или поставьте галочку "Без доверенности"!', 'error');
    }

    // Формируем итоговую строку для базы
    const poa_info = noPoa ? `Без доверенности: ${poaComment}` : poaSelectVal;

    // ==========================================
    // 2. ЖЕСТКАЯ ПРОВЕРКА АВАНСА
    // ==========================================
    const paymentMethod = document.getElementById('sale-payment-method').value;
    const advanceAmount = parseFloat(document.getElementById('sale-advance-amount')?.value) || 0;

    if (paymentMethod === 'partial' && advanceAmount <= 0) {
        return UI.toast('Вы выбрали оплату авансом. Укажите сумму вносимого аванса!', 'error');
    }

    // ==========================================
    // 3. ПРОВЕРКА ЛОГИСТИКИ И ДАТЫ ОТГРУЗКИ
    // ==========================================
    const logisticsCost = parseFloat(document.getElementById('sale-logistics-cost').value) || 0;
    if (logisticsCost < 0) {
        return UI.toast('Стоимость логистики не может быть отрицательной!', 'error');
    }

    const plannedDateStr = document.getElementById('sale-planned-date').value;
    if (!plannedDateStr) {
        return UI.toast('Укажите плановую дату отгрузки!', 'error');
    }
    
    const plannedDate = new Date(plannedDateStr);
    const today = new Date();
    today.setHours(0, 0, 0, 0); // Обнуляем время для проверки только даты
    if (plannedDate < today) {
        return UI.toast('Дата отгрузки не может быть в прошлом!', 'error');
    }

    // Блокируем кнопку от двойного клика
    const btn = document.querySelector('button[onclick="processCheckout()"]');
    if (btn) btn.disabled = true;

    // Собираем данные (учитывая все проверки)
    const payload = {
        counterparty_id: client_id,
        items: cart.map(i => ({
            id: i.id,
            qty: i.qty,
            price: i.price * (1 - (i.discount || 0) / 100),
            warehouse_id: i.warehouseId,
            allow_production: i.allowProduction
        })),
        payment_method: paymentMethod,
        account_id: document.getElementById('sale-account')?.value,
        advance_amount: advanceAmount,
        discount: document.getElementById('sale-discount').value || 0,
        driver: document.getElementById('sale-driver').value,
        auto: document.getElementById('sale-auto').value,
        contract_id: document.getElementById('sale-contract').value || null,
        delivery_address: document.getElementById('sale-delivery-address').value,
        logistics_cost: logisticsCost,
        planned_shipment_date: plannedDateStr,
        pallets_qty: document.getElementById('sale-pallets').value || 0,
        poa_info: poa_info, // Передаем проверенную информацию
        user_id: JSON.parse(localStorage.getItem('user'))?.id || null
    };

    try {
        const res = await fetch('/api/sales/checkout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (res.ok) {
            const result = await res.json();

            // Очищаем форму
            clearOrderForm();

            // 🛡️ ЗАЩИТА: проверяем наличие отчета перед тем как запускать .map
            if (result.deficitReport && Array.isArray(result.deficitReport) && result.deficitReport.length > 0) {
                let deficitHtml = `
                    <div style="background: #fffbeb; border: 1px solid #fde68a; padding: 15px; border-radius: 8px; margin-bottom: 15px;">
                        <h4 style="color: #92400e; margin-top: 0;">⚠️ Внимание! Нехватка сырья</h4>
                        <p style="font-size: 13px; color: #78350f;">Для производства заказа не хватает материалов на Складе №1:</p>
                        <table style="width: 100%; font-size: 13px; border-collapse: collapse; margin-top: 10px;">
                            <tr style="border-bottom: 1px solid #fde68a; text-align: left;">
                                <th style="padding: 5px;">Материал</th>
                                <th style="padding: 5px;">Нужно</th>
                                <th style="padding: 5px;">Дефицит</th>
                            </tr>
                            ${result.deficitReport.map(m => `
                                <tr>
                                    <td style="padding: 5px;"><b>${m.name || 'Материал'}</b></td>
                                    <td style="padding: 5px;">${m.needed || 0}</td>
                                    <td style="padding: 5px; color: #dc2626;"><b>-${m.shortage || 0}</b></td>
                                </tr>
                            `).join('')}
                        </table>
                    </div>
                `;

                UI.showModal(`Заказ ${result.docNum} оформлен`, deficitHtml, `
                    <button class="btn btn-blue" onclick="UI.closeModal()">Принято</button>
                `);
            } else {
                UI.toast(`✅ Заказ ${result.docNum} оформлен!`, 'success');
            }

            if (typeof loadActiveOrders === 'function') loadActiveOrders();
            switchSalesTab('tab-active-orders', document.querySelectorAll('.sales-tab-btn')[1]);

        } else {
            const err = await res.text();
            UI.toast('Ошибка: ' + err, 'error');
        }
    } catch (e) {
        UI.toast('Ошибка связи с сервером', 'error');
    } finally {
        // Разблокируем кнопку в любом случае
        if (btn) btn.disabled = false;
    }
};

// ==========================================
// === УПРАВЛЕНИЕ ЗАКАЗАМИ (OMS - КАНБАН ДОСКА) ===
// ==========================================
async function loadActiveOrders() {
    // 🚀 Задача №14: Привязка поиска и пагинации
    const query = new URLSearchParams({
        page: boPage,
        search: boSearch,
        _t: Date.now()
    }).toString();

    try {
        const res = await fetch(`/api/sales/orders?${query}`);
        allActiveOrders = await res.json();
        renderBlankOrdersTable();
    } catch (e) { console.error(e); }
}

window.changeBlankOrderPage = function (dir) {
    boPage += dir;
    renderBlankOrdersTable();
};

function renderBlankOrdersTable() {
    const tbody = document.getElementById('blank-orders-table');
    if (!tbody) return;

    let filtered = allActiveOrders;
    // === МУЛЬТИ-ФИЛЬТРАЦИЯ АКТИВНЫХ ЗАКАЗОВ ===
    const searchVal = (document.getElementById('bo-search') ? document.getElementById('bo-search').value.toLowerCase() : '');
    const clientVal = (document.getElementById('bo-client-filter') ? document.getElementById('bo-client-filter').value : '');
    const productVal = (document.getElementById('bo-product-filter') ? document.getElementById('bo-product-filter').value.toLowerCase() : '');
    const statusVal = (document.getElementById('bo-status-filter') ? document.getElementById('bo-status-filter').value : '');

    filtered = allActiveOrders.filter(o => {
        let matchSearch = !searchVal ||
            (o.doc_number && o.doc_number.toLowerCase().includes(searchVal)) ||
            (o.client_name && o.client_name.toLowerCase().includes(searchVal)) ||
            (o.delivery_address && o.delivery_address.toLowerCase().includes(searchVal));

        let matchClient = !clientVal || o.client_name === clientVal;

        let matchProduct = !productVal || (o.items_list && o.items_list.toLowerCase().includes(productVal));

        let matchStatus = true;
        if (statusVal) {
            const totalAmt = parseFloat(o.total_amount) || 0;
            const paidAmt = parseFloat(o.paid_amount) || 0;
            const debtAmt = parseFloat(o.pending_debt) || 0;

            if (statusVal === 'debt') matchStatus = debtAmt > 0;
            if (statusVal === 'paid') matchStatus = paidAmt >= totalAmt && totalAmt > 0;
        }

        return matchSearch && matchClient && matchProduct && matchStatus;
    });

    const maxPage = Math.ceil(filtered.length / 5) || 1;
    if (boPage > maxPage) boPage = maxPage;
    if (boPage < 1) boPage = 1;

    document.getElementById('bo-page-info').innerText = `Страница ${boPage} из ${maxPage} (Всего: ${filtered.length})`;

    const start = (boPage - 1) * 5;
    const paginated = filtered.slice(start, start + 5);

    if (!Array.isArray(paginated)) {
        console.error('Ошибка данных API: ожидался массив заказов (paginated), получено:', paginated);
        return;
    }

    if (paginated.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 20px;">Нет активных заказов</td></tr>';
        return;
    }

    tbody.innerHTML = paginated.map(o => {
        // --- 1. СТАТУС ОТГРУЗКИ ---
        const ordered = parseFloat(o.total_ordered) || 0;
        const shipped = parseFloat(o.total_shipped) || 0;
        let statusBadge = shipped > 0 && shipped < ordered
            ? `<span style="background: var(--info-bg); padding: 4px 8px; border-radius: 6px; font-size: 11px; font-weight: bold; color: var(--info); border: 1px solid #bae6fd;">🔵 Отгружается (${Math.round((shipped / ordered) * 100)}%)</span>`
            : `<span style="background: var(--warning-bg); padding: 4px 8px; border-radius: 6px; font-size: 11px; font-weight: bold; color: var(--warning-text); border: 1px solid #fde047;">🟡 В очереди</span>`;

        // --- 2. СТАТУС ОПЛАТЫ ИМЕННО ЭТОГО ЗАКАЗА ---
        const totalAmt = parseFloat(o.total_amount) || 0;
        const paidAmt = parseFloat(o.paid_amount) || 0;
        const debtAmt = parseFloat(o.pending_debt) || 0;
        let finBadge = '';
        if (paidAmt >= totalAmt) {
            finBadge = `<span style="background: var(--success-bg); padding: 4px 8px; border-radius: 6px; font-size: 11px; font-weight: bold; color: var(--success-text); border: 1px solid #bbf7d0; display: inline-block; margin-top: 5px;">🟢 Оплачен 100%</span>`;
        } else if (debtAmt > 0) {
            finBadge = `<span style="background: var(--danger-bg); padding: 4px 8px; border-radius: 6px; font-size: 11px; font-weight: bold; color: var(--danger-text); border: 1px solid #fecaca; display: inline-block; margin-top: 5px;">🔴 Долг: ${debtAmt.toLocaleString('ru-RU')} ₽</span>`;
        } else if (paidAmt > 0) {
            finBadge = `<span style="background: #fef3c7; padding: 4px 8px; border-radius: 6px; font-size: 11px; font-weight: bold; color: #b45309; border: 1px solid #fde68a; display: inline-block; margin-top: 5px;">🟡 Аванс: ${paidAmt.toLocaleString('ru-RU')} ₽</span>`;
        } else {
            finBadge = `<span style="background: var(--surface-alt); padding: 4px 8px; border-radius: 6px; font-size: 11px; font-weight: bold; color: var(--text-muted); border: 1px solid #e2e8f0; display: inline-block; margin-top: 5px;">⚪ Не оплачен</span>`;
        }

        // --- 3. ОБЩИЙ БАЛАНС КЛИЕНТА (ПО ФАКТУ ОТГРУЗКИ) ---
        const clientBalance = parseFloat(o.client_balance) || 0;
        let clientBalanceBadge = '';
        if (clientBalance > 0) {
            clientBalanceBadge = `<div style="margin-top: 5px; font-size: 11px; color: #059669; font-weight: bold; background: #d1fae5; display: inline-block; padding: 3px 6px; border-radius: 4px; border: 1px solid #34d399;">💰 Переплата (Аванс): +${clientBalance.toLocaleString('ru-RU')} ₽</div>`;
        } else if (clientBalance < 0) {
            clientBalanceBadge = `<div style="margin-top: 5px; font-size: 11px; color: #dc2626; font-weight: bold; background: var(--danger-bg); display: inline-block; padding: 3px 6px; border-radius: 4px; border: 1px solid #f87171;">📉 Общий долг: ${Math.abs(clientBalance).toLocaleString('ru-RU')} ₽</div>`;
        } else {
            clientBalanceBadge = `<div style="margin-top: 5px; font-size: 11px; color: var(--text-muted); font-weight: bold; background: var(--surface-alt); display: inline-block; padding: 3px 6px; border-radius: 4px; border: 1px solid var(--border);">⚖️ Взаиморасчеты: 0 ₽</div>`;
        }

        // --- 4. ПРОГНОЗ БАЛАНСА (С УЧЕТОМ ВСЕХ ЗАКАЗОВ) ---
        const projected = parseFloat(o.projected_balance) || 0;
        const projHtml = `<div style="font-size: 10px; color: #94a3b8; margin-top: 2px;">Итог по всем заказам: <b style="color: ${projected < 0 ? '#ef4444' : '#10b981'}">${projected.toLocaleString('ru-RU')} ₽</b></div>`;

        // --- 5. КНОПКА ВЗАИМОЗАЧЕТА (ЕСЛИ ЕСТЬ ПЕРЕПЛАТА И ДОЛГ ПО ЭТОМУ ЗАКАЗУ) ---
        let offsetBtn = '';
        if (clientBalance > 0 && debtAmt > 0) {
            const offsetAmount = Math.min(clientBalance, debtAmt);
            offsetBtn = `<button class="btn btn-outline" style="padding: 4px 8px; font-size: 12px; color: #059669; border-color: #059669;" onclick="offsetOrderAdvance('${o.doc_number}', ${offsetAmount})" title="Зачесть аванс в счет заказа">💸 Зачесть</button>`;
        }

        // --- РЕНДЕР СТРОКИ ---
        return `
        <tr style="transition: 0.2s;" onmouseover="this.style.backgroundColor='var(--surface-hover)'" onmouseout="this.style.backgroundColor=''">
            <td style="color: var(--text-muted); font-size: 13px;">
                ${o.date_formatted}<br>
                <span style="color: var(--warning-text); font-weight: bold;">до ${o.deadline || 'Не указан'}</span>
            </td>
            <td>
                <strong style="color: var(--info); font-size: 14px;">${o.doc_number}</strong><br>
                <span style="font-size: 12px; font-weight: bold; color: var(--text-main);">${totalAmt.toLocaleString('ru-RU')} ₽</span>
            </td>
            <td style="vertical-align: top;">
                <b>${escapeHTML(o.client_name || 'Неизвестный клиент')}</b><br>
                <span style="font-size: 11px; color: var(--text-muted);">📍 ${escapeHTML(o.delivery_address || 'Самовывоз')}</span><br>
                ${clientBalanceBadge}
                ${projHtml}
            </td>
            <td style="font-size: 12px; max-width: 250px; vertical-align: top;">${escapeHTML(o.items_list || 'Пусто')}</td>  <td style="text-align: center; vertical-align: middle;">
                ${statusBadge}<br>
                ${finBadge}
            </td>
            <td style="text-align: right; min-width: 250px; vertical-align: middle;">
                <div style="display: flex; justify-content: flex-end; gap: 5px; align-items: center;">
                    ${offsetBtn}
                    <button class="btn btn-outline" style="padding: 4px 8px; font-size: 12px; color: var(--info); border-color: var(--info);" onclick="openInvoiceModal('${o.doc_number}', ${debtAmt > 0 ? debtAmt : totalAmt})" title="Счет на оплату">🖨️ Счет</button>
                    <button class="btn btn-outline" style="padding: 4px 8px; font-size: 12px; color: var(--info); border-color: var(--info);" onclick="openOrderManager(${o.id})">⚙️ Управл.</button>
                    <button class="btn btn-outline" style="padding: 4px 8px; font-size: 12px; color: var(--danger); border-color: var(--danger);" onclick="confirmDeleteOrder(${o.id}, '${o.doc_number}')" title="Отменить и удалить заказ">❌</button>
                </div>
            </td>
        </tr>
        `;
    }).join('');

}

window.confirmDeleteOrder = function (orderId, docNum) {
    const html = `
        <p>Вы уверены, что хотите отменить и удалить заказ <b>${docNum}</b>?</p>
        <p style="font-size: 12px; color: var(--danger);">⚠️ Товар вернется из резерва на склад, задачи на производство будут отменены, а аванс будет списан из кассы обратно.</p>
    `;
    UI.showModal('Удаление Заказа', html, `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-red" onclick="executeDeleteOrder(${orderId})">Да, удалить заказ</button>
    `);
};

window.executeDeleteOrder = async function (orderId) {
    try {
        const res = await fetch(`/api/sales/orders/${orderId}`, { method: 'DELETE' });
        if (res.ok) {
            UI.closeModal();
            UI.toast('Заказ полностью удален, резервы отменены!', 'success');
            loadActiveOrders();
            loadSalesData(false);
            if (typeof loadTable === 'function') loadTable();
        } else {
            UI.toast('Ошибка удаления: ' + await res.text(), 'error');
        }
    } catch (e) { console.error(e); UI.toast('Ошибка связи', 'error'); }
};

// ==========================================
// === ИСТОРИЯ ОТГРУЗОК (АРХИВ) ===
// ==========================================
async function loadSalesHistory() {
    // 🚀 Задача №14: Привязка фильтров даты и страниц
    const query = new URLSearchParams({
        page: historyPage,
        search: historySearch,
        start: historyDateRange.start,
        end: historyDateRange.end,
        _t: Date.now()
    }).toString();

    try {
        const res = await fetch(`/api/sales/history?${query}`);
        const data = await res.json();

        // Предполагаем, что сервер возвращает { data: [], totalPages: X }
        allSalesHistory = data.data || data;
        renderHistoryTable();
    } catch (e) { console.error(e); }
}

window.changeHistoryPage = function (dir) {
    historyPage += dir;
    renderHistoryTable();
};

function renderHistoryTable() {
    const tbody = document.getElementById('sales-history-table');
    if (!tbody) return;

    let filtered = allSalesHistory;
    // === МУЛЬТИ-ФИЛЬТРАЦИЯ ИСТОРИИ ===
    const searchVal = (document.getElementById('hist-search') ? document.getElementById('hist-search').value.toLowerCase() : '');
    const clientVal = (document.getElementById('hist-client-filter') ? document.getElementById('hist-client-filter').value : '');
    const dateFrom = historyDateRange.start; // Берем из календаря
    const dateTo = historyDateRange.end;

    filtered = allSalesHistory.filter(h => {
        let matchSearch = !searchVal ||
            (h.doc_num && h.doc_num.toLowerCase().includes(searchVal)) ||
            (h.client_name && h.client_name.toLowerCase().includes(searchVal));

        let matchClient = !clientVal || h.client_name === clientVal;

        let matchDate = true;
        if (dateFrom || dateTo) {
            // Превращаем формат ДД.ММ.ГГГГ в ГГГГ-ММ-ДД для правильного сравнения
            if (h.date_formatted) {
                const dateParts = h.date_formatted.split(' ')[0].split('.');
                if (dateParts.length === 3) {
                    const rowDateStr = `${dateParts[2]}-${dateParts[1]}-${dateParts[0]}`;
                    if (dateFrom && rowDateStr < dateFrom) matchDate = false;
                    if (dateTo && rowDateStr > dateTo) matchDate = false;
                }
            }
        }

        return matchSearch && matchClient && matchDate;
    });

    const maxPage = Math.ceil(filtered.length / 5) || 1;
    if (historyPage > maxPage) historyPage = maxPage;
    if (historyPage < 1) historyPage = 1;

    document.getElementById('hist-page-info').innerText = `Страница ${historyPage} из ${maxPage} (Всего: ${filtered.length})`;

    const start = (historyPage - 1) * 5;
    const paginated = filtered.slice(start, start + 5);

    if (paginated.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 20px;">Отгрузки не найдены</td></tr>';
        return;
    }

    tbody.innerHTML = paginated.map(h => {
        // 🚀 НОВОЕ: Умный поиск цены (бэкенд может называть её по-разному)
        const rowSum = parseFloat(h.amount || h.total_amount || h.total_sum || h.sum || 0);
        const sumText = rowSum > 0 ? rowSum.toLocaleString('ru-RU') + ' ₽' : '-';

        return `
        <tr style="transition: 0.2s;" onmouseover="this.style.backgroundColor='var(--surface-hover)'" onmouseout="this.style.backgroundColor=''">
            <td style="color: var(--text-muted); font-size: 13px;">${h.date_formatted}</td>
            <td><strong style="color: var(--primary);">${h.doc_num}</strong></td>
            <td><b>${escapeHTML(h.client_name || 'Неизвестный клиент')}</b><br><span style="font-size: 11px; color: var(--text-muted);">${h.payment || ''}</span></td>
            <td style="text-align: center; font-weight: bold;">${parseFloat(h.total_qty).toLocaleString('ru-RU')}</td>
            
            <td style="text-align: right; color: var(--success); font-weight: bold;">${sumText}</td>
            
            <td style="text-align: right; min-width: 250px;">
            <div style="display: flex; justify-content: flex-end; gap: 5px; align-items: center;">
                <button class="btn btn-outline" style="padding: 4px 8px; font-size: 12px; color: var(--info); border-color: var(--info);" onclick="window.open('/print/upd?docNum=${h.doc_num}', '_blank')" title="УПД и Пропуск на выезд">🖨️ УПД + Пропуск</button>
                <button class="btn btn-outline" style="padding: 4px 8px; font-size: 12px; color: var(--warning-text); border-color: var(--warning-text);" onclick="window.open('/print/specification?docNum=${h.doc_num}', '_blank')" title="Спецификация">🖨️ Спец.</button>
                <button class="btn btn-outline" style="padding: 4px 8px; font-size: 12px; color: var(--primary); border-color: var(--primary);" onclick="window.open('/print/waybill?docNum=${h.doc_num}', '_blank')" title="Накладная">🖨️ Накладная</button>
                <button class="btn btn-outline" style="color: var(--danger); border-color: var(--danger); padding: 4px 8px; font-size: 12px;" onclick="cancelShipment('${h.doc_num}')" title="Отменить">❌</button>
            </div>
            </td>
        </tr>
        `;
    }).join('');
}
window.cancelShipment = function (docNum) {
    const html = `<p>Отменить накладную <b>${docNum}</b>?<br><small style="color: var(--danger);">Плитка вернется на склады, финансы аннулируются.</small></p>`;
    UI.showModal('Отмена отгрузки', html, `
        <button class="btn btn-outline" onclick="UI.closeModal()">Назад</button>
        <button class="btn btn-red" onclick="executeCancelShipment('${docNum}')">Да, отменить</button>
    `);
};

window.executeCancelShipment = async function (docNum) {
    try {
        const res = await fetch(`/api/sales/shipment/${docNum}`, { method: 'DELETE' });
        if (res.ok) {
            UI.closeModal();
            UI.toast(`Отгрузка отменена`, 'success');

            // Обновляем все связанные таблицы в интерфейсе
            loadSalesHistory();
            loadSalesData(false);
            if (typeof loadTable === 'function') loadTable();

            // НОВОЕ: Мгновенно обновляем Канбан-доску заказов (чтобы откатился процент)
            if (typeof loadActiveOrders === 'function') loadActiveOrders();

            // Обновляем долг клиента
            onClientChange();
        } else {
            UI.toast('Ошибка отмены: ' + await res.text(), 'error');
        }
    } catch (e) { console.error(e); }
};


// ==========================================
// === ПРОЧИЕ МОДУЛИ (ПРАЙС И ДОГОВОРЫ) ===
// ==========================================
window.openPriceListModal = async function () {
    UI.toast('Загрузка прайс-листа...', 'info');
    try {
        const res = await fetch('/api/products');
        const products = await res.json();

        let tbody = products.map(p => `
            <tr style="border-bottom: 1px solid var(--border);">
                <td style="padding: 8px;">
                    <span class="badge" style="background: var(--surface-alt); color: var(--text-muted); font-size: 11px; margin-right: 8px; font-family: monospace;">${p.article || 'НЕТ АРТИКУЛА'}</span>
                    <b>${p.name}</b> <span style="font-size: 10px; color: var(--text-muted);">(${p.unit})</span>
                </td>
                <td style="padding: 8px; text-align: center;">
                    <input type="number" class="input-modern price-basic" data-id="${p.id}" value="${p.current_price}" style="width: 90px; text-align: center;">
                </td>
                <td style="padding: 8px; text-align: center;">
                    <input type="number" class="input-modern price-dealer" data-id="${p.id}" value="${p.dealer_price || 0}" style="width: 90px; text-align: center; border-color: var(--info);">
                </td>
            </tr>
        `).join('');

        const html = `
            <style>.modal-content { max-width: 700px !important; }</style>
            <div style="max-height: 60vh; overflow-y: auto; padding-right: 10px;">
                <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                    <thead style="background: var(--surface-hover); position: sticky; top: 0;">
                        <tr>
                            <th style="padding: 10px; text-align: left;">Товар</th>
                            <th style="padding: 10px; text-align: center; color: var(--text-main);">Основная (Розница)</th>
                            <th style="padding: 10px; text-align: center; color: var(--info);">Дилерская (Опт)</th>
                        </tr>
                    </thead>
                    <tbody>${tbody}</tbody>
                </table>
            </div>
        `;

        // Добавьте эту кнопку рядом с "Сохранить цены" в функции openPriceListModal
        UI.showModal('📋 Установка Прайс-листа', html, `
            <div style="display: flex; gap: 10px; width: 100%; justify-content: space-between; flex-wrap: wrap;">
                <div style="display: flex; gap: 10px;">
                    <label class="btn btn-outline" style="cursor: pointer; border-color: var(--primary); color: var(--primary); font-size: 12px; padding: 6px 12px;">
                        📥 Загрузить Базовый (Розница)
                        <input type="file" accept=".csv" style="display: none;" onchange="handleBasicCsvImport(event)">
                    </label>
                    <label class="btn btn-outline" style="cursor: pointer; border-color: var(--info); color: var(--info); font-size: 12px; padding: 6px 12px;">
                        📥 Загрузить Дилерский (Опт)
                        <input type="file" accept=".csv" style="display: none;" onchange="handleDealerCsvImport(event)">
                    </label>
                </div>
                <div>
                    <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
                    <button class="btn btn-blue" onclick="savePriceList()">💾 Сохранить</button>
                </div>
            </div>
        `);
    } catch (e) { console.error(e); }
};

window.savePriceList = async function () {
    const prices = [];
    document.querySelectorAll('.price-basic').forEach(input => {
        const id = input.getAttribute('data-id');
        const dealerInput = document.querySelector(`.price-dealer[data-id="${id}"]`);
        prices.push({
            id: id,
            price: parseFloat(input.value) || 0,
            dealer_price: parseFloat(dealerInput.value) || 0
        });
    });

    try {
        const res = await fetch('/api/products/update-prices', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prices })
        });
        if (res.ok) {
            UI.closeModal();
            UI.toast('✅ Прайс-лист успешно обновлен', 'success');
            if (typeof loadSalesData === 'function') loadSalesData(false);
        }
    } catch (e) { console.error(e); }
};

window.openContractManager = async function () {
    const cpId = document.getElementById('sale-client').value;
    const cpName = document.getElementById('sale-client').options[document.getElementById('sale-client').selectedIndex].text;
    if (!cpId) return UI.toast('Сначала выберите клиента!', 'warning');

    try {
        const res = await fetch(`/api/counterparties/${cpId}/contracts`);
        const data = await res.json();

        const contractsMap = new Map();
        const specCounts = {}; // Для умной нумерации

        data.forEach(row => {
            if (!contractsMap.has(row.contract_id)) {
                contractsMap.set(row.contract_id, {
                    id: row.contract_id, number: row.contract_number, date: row.contract_date, specs: []
                });
            }
            if (row.spec_id) {
                contractsMap.get(row.contract_id).specs.push({
                    id: row.spec_id, number: row.spec_number, date: row.spec_date
                });
            }
        });

        let listHtml = '';
        if (contractsMap.size === 0) {
            listHtml = '<div style="color: var(--text-muted); text-align: center; padding: 10px;">Нет заключенных договоров</div>';
        } else {
            contractsMap.forEach(c => {
                specCounts[c.id] = c.specs.length + 1; // Считаем следующий номер

                listHtml += `
                    <div style="border: 1px solid #e2e8f0; border-radius: 6px; margin-bottom: 10px; background: var(--surface); padding: 10px; box-shadow: 0 1px 3px var(--shadow-sm);">
                        <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px dashed #e2e8f0; padding-bottom: 8px; margin-bottom: 8px;">
                            <strong style="color: #0f172a; font-size: 14px;">📄 Договор №${c.number} от ${c.date}</strong>
                            <div style="display: flex; gap: 5px;">
                                <button class="btn btn-outline" style="padding: 2px 8px; font-size: 11px; border-color: var(--info); color: var(--info);" onclick="window.open('/print/contract?id=${c.id}', '_blank')" title="Распечатать">🖨️</button>
                                <button class="btn btn-outline" style="padding: 2px 8px; font-size: 11px; border-color: #ef4444; color: #ef4444;" onclick="deleteContract(${c.id})" title="Удалить">❌</button>
                            </div>
                        </div>
                        <div style="padding-left: 15px;">
                            ${c.specs.length === 0 ? '<span style="font-size: 11px; color: #94a3b8;">Нет прикрепленных спецификаций</span>' : ''}
                            ${c.specs.map(s => `
                                <div style="display: flex; justify-content: space-between; align-items: center; font-size: 12px; margin-bottom: 4px; color: var(--text-muted);">
                                    <span>↳ Спецификация №${s.number} от ${s.date}</span>
                                    <div style="display: flex; gap: 5px;">
                                        <button class="btn btn-outline" style="padding: 2px 6px; font-size: 10px; border-color: var(--info); color: var(--info); border: none;" onclick="window.open('/print/specification_doc?id=${s.id}', '_blank')" title="Печать спецификации">🖨️</button>
                                        <button class="btn btn-outline" style="padding: 2px 6px; font-size: 10px; border-color: #ef4444; color: #ef4444; border: none;" onclick="deleteSpecification(${s.id})" title="Удалить спецификацию">❌</button>
                                    </div>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                `;
            });
        }

        const html = `
            <div style="max-height: 350px; overflow-y: auto; margin-bottom: 20px; padding-right: 5px; border-bottom: 2px solid var(--border); padding-bottom: 15px;">
                <h4 style="margin: 0 0 10px 0; color: var(--text-muted);">Актуальные документы:</h4>
                ${listHtml}
            </div>

            <div style="margin-bottom: 15px; padding: 15px; background: var(--surface-hover); border: 1px solid var(--border); border-radius: 6px;">
                <h4 style="margin: 0 0 10px 0; color: var(--primary);">📄 Создать новый договор</h4>
                <input type="text" style="display:none" autocomplete="username">
                <input type="password" style="display:none" autocomplete="current-password">
                <div class="form-grid" style="grid-template-columns: 1fr 1fr;">
                    <div class="form-group"><label>Номер договора:</label><input type="text" id="new-contract-num" class="input-modern" autocomplete="nope" placeholder="Напр: 45-А"></div>
                    <div class="form-group"><label>Дата:</label><input type="date" id="new-contract-date" class="input-modern" value="${new Date().toISOString().split('T')[0]}"></div>
                </div>
                <button class="btn btn-blue" onclick="saveNewContract(${cpId})" style="width: 100%; padding: 8px;">➕ Сохранить договор</button>
            </div>

            <div style="padding: 15px; border: 1px solid var(--border); border-radius: 6px;">
                <h4 style="margin: 0 0 10px 0; color: var(--warning-text);">📎 Добавить спецификацию</h4>
                <div class="form-group">
                    <label>К какому договору (Основание):</label>
                    <select id="new-spec-contract-id" class="input-modern">
                        ${Array.from(contractsMap.values()).map(c => `<option value="${c.id}">Договор №${c.number} от ${c.date}</option>`).join('')}
                    </select>
                </div>
                <div class="form-grid" style="grid-template-columns: 1fr 1fr;">
                    <div class="form-group"><label>№ Спецификации:</label><input type="text" id="new-spec-num" class="input-modern"></div>
                    <div class="form-group"><label>Дата:</label><input type="date" id="new-spec-date" class="input-modern" value="${new Date().toISOString().split('T')[0]}"></div>
                </div>
                <button class="btn btn-outline" onclick="saveNewSpecification()" style="width: 100%; padding: 8px; border-color: var(--warning-text); color: var(--warning-text);">➕ Сохранить спецификацию</button>
            </div>
        `;

        UI.showModal(`Управление договорами: ${cpName}`, html, `<button class="btn btn-outline" onclick="UI.closeModal()">Закрыть</button>`);

        // 🚀 ЛОГИКА АВТОНУМЕРАЦИИ
        setTimeout(() => {
            const select = document.getElementById('new-spec-contract-id');
            const numInput = document.getElementById('new-spec-num');
            if (select && numInput) {
                numInput.value = specCounts[select.value] || 1; // Ставим номер при открытии
                select.addEventListener('change', (e) => numInput.value = specCounts[e.target.value] || 1); // Меняем при выборе
            }
        }, 100);

    } catch (e) { console.error(e); UI.toast('Ошибка', 'error'); }
};

// ==========================================
// УДАЛЕНИЕ ДОГОВОРА
// ==========================================

// 1. ПОДГОТОВКА (Показ окна)
window.deleteContract = function (id) {
    const html = `
        <div style="padding: 10px; font-size: 15px; text-align: center;">
            <div style="font-size: 40px; margin-bottom: 10px;">🗑️</div>
            Вы уверены, что хотите удалить этот договор?<br>
            <span style="color: var(--text-muted); font-size: 13px;">Отменить это действие будет невозможно.</span>
        </div>
    `;

    const buttons = `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-blue" style="background: var(--danger); border-color: var(--danger);" 
                onclick="executeDeleteContract(${id})">Удалить</button>
    `;

    UI.showModal('Удаление договора', html, buttons);
};

// 2. ВЫПОЛНЕНИЕ
window.executeDeleteContract = async function (id) {
    UI.closeModal();
    UI.toast('⏳ Удаление...', 'info');

    try {
        const res = await fetch(`/api/contracts/${id}`, { method: 'DELETE' });

        if (res.ok) {
            UI.toast('✅ Договор удален', 'success');

            // Фоновое обновление выпадающего списка в корзине
            const clientSelect = document.getElementById('sale-client');
            const cpId = clientSelect ? clientSelect.value : null;
            if (cpId && typeof loadClientContracts === 'function') {
                await loadClientContracts(cpId);
            }

            // Перерисовываем список договоров
            if (typeof openContractManager === 'function') {
                openContractManager();
            }
        } else {
            // Ловим красную ошибку с сервера (если внутри есть спецификации)
            const err = await res.json().catch(() => ({}));
            UI.toast(err.error || 'Ошибка удаления', 'error');
        }
    } catch (e) {
        console.error(e);
        UI.toast('Критическая ошибка связи с сервером', 'error');
    }
};

// === КРАСИВОЕ УДАЛЕНИЕ СПЕЦИФИКАЦИИ ===
window.deleteSpecification = function (id) {
    const html = `
        <div style="padding: 15px; text-align: center; font-size: 15px;">
            Вы уверены, что хотите удалить эту спецификацию?<br>
            <small style="color: var(--text-muted);">Это действие нельзя отменить.</small>
        </div>`;

    UI.showModal('⚠️ Удаление спецификации', html, `
        <button class="btn btn-outline" onclick="cancelDeleteSpecification()">Отмена</button>
        <button class="btn btn-blue" style="background: #ef4444; border-color: #ef4444;" onclick="executeDeleteSpecification(${id})">🗑️ Да, удалить</button>
    `);
};

// Функция возврата (чтобы не зависало при отмене)
window.cancelDeleteSpecification = function () {
    UI.closeModal();
    // Возвращаем окно управления договорами, откуда и вызывалось удаление
    if (typeof openContractManager === 'function') openContractManager();
};

window.executeDeleteSpecification = async function (id) {
    try {
        const res = await fetch(`/api/specifications/${id}`, { method: 'DELETE' });

        if (res.ok) {
            UI.toast('✅ Спецификация удалена', 'success');
            UI.closeModal();

            // Обновляем данные на фоне и перерисовываем менеджер договоров
            const saleClient = document.getElementById('sale-client');
            if (saleClient && typeof loadClientContracts === 'function') {
                await loadClientContracts(saleClient.value);
            }
            if (typeof openContractManager === 'function') openContractManager();
        } else {
            // Если бэкенд не дал удалить (например, есть привязанные товары/заказы)
            const err = await res.json();
            UI.toast(err.error || 'Ошибка при удалении', 'error');
            cancelDeleteSpecification();
        }
    } catch (e) {
        console.error(e);
        UI.toast('Ошибка сети', 'error');
    }
};

window.saveNewContract = async function (cpId) {
    const num = document.getElementById('new-contract-num').value.trim();
    const date = document.getElementById('new-contract-date').value;
    if (!num || !date) return UI.toast('Заполните номер и дату!', 'warning');

    const res = await fetch('/api/contracts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ counterparty_id: cpId, number: num, date: date })
    });
    if (res.ok) {
        UI.toast('Договор создан', 'success');
        loadClientContracts();
        UI.closeModal();
    }
};

window.saveNewSpecification = async function () {
    const cId = document.getElementById('new-spec-contract-id').value;
    const num = document.getElementById('new-spec-num').value.trim();
    const date = document.getElementById('new-spec-date').value;
    if (!cId || !num || !date) return UI.toast('Заполните все поля спецификации!', 'warning');

    const res = await fetch('/api/specifications', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contract_id: cId, number: num, date: date })
    });
    if (res.ok) {
        UI.toast('Спецификация добавлена', 'success');
        loadClientContracts();
        UI.closeModal();
    }
};

// ==========================================
// === ОТГРУЗКА ЧАСТЯМИ ИЗ АКТИВНОГО ЗАКАЗА ===
// ==========================================
window.openOrderManager = async function (orderId) {
    try {
        const res = await fetch(`/api/sales/orders/${orderId}`);
        if (!res.ok) return UI.toast('Ошибка загрузки заказа', 'error');
        const data = await res.json();
        const order = data.order;
        const items = data.items;

        let itemsHtml = items.map(i => {
            const ordered = parseFloat(i.qty_ordered);
            const shipped = parseFloat(i.qty_shipped || 0);
            const remain = ordered - shipped;
            const remainText = remain > 0 ? remain : 0;

            return `
                <tr style="border-bottom: 1px solid var(--border);">
                    <td style="padding: 8px;">${i.name}</td>
                    <td style="padding: 8px; text-align: center; font-weight: bold;">${ordered} ${i.unit}</td>
                    <td style="padding: 8px; text-align: center; color: var(--success); font-weight: bold;">${shipped} ${i.unit}</td>
                    <td style="padding: 8px; text-align: center;">
                        <input type="number" class="input-modern ship-qty-input" 
                               data-coi-id="${i.id}" data-item-id="${i.item_id}" 
                               max="${remainText}" value="${remainText}" 
                               ${remain <= 0 ? 'disabled' : ''} 
                               style="width: 90px; text-align: center; border-color: var(--primary); font-weight: bold;">
                    </td>
                </tr>
            `;
        }).join('');

        const html = `
            <div style="padding: 10px;">
                <div style="background: var(--surface-alt); padding: 12px; border-radius: 6px; margin-bottom: 15px;">
                    <p style="margin: 0 0 5px 0;"><b>Клиент:</b> ${order.client_name}</p>
                    <p style="margin: 0;"><b>Адрес доставки:</b> ${order.delivery_address || 'Самовывоз'}</p>
                </div>
                
                <table style="width: 100%; border-collapse: collapse; margin-bottom: 15px;">
                    <thead style="background: var(--info-bg);">
                        <tr>
                            <th style="padding: 8px; text-align: left;">Продукция</th>
                            <th style="padding: 8px; text-align: center;">Заказано</th>
                            <th style="padding: 8px; text-align: center;">Уже отгружено</th>
                            <th style="padding: 8px; text-align: center; color: var(--primary);">Грузим сейчас</th>
                        </tr>
                    </thead>
                    <tbody>${itemsHtml}</tbody>
                </table>

                <div style="background: var(--surface-hover); padding: 10px; border-radius: 6px; border: 1px dashed var(--border);">
                    <h4 style="margin: 0 0 10px 0; color: var(--text-muted);">Данные для этой отгрузки (Машина)</h4>
                    <div class="form-grid" style="grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 10px;">
                        <div class="form-group" style="margin: 0;"><input type="text" id="ship-driver" class="input-modern" placeholder="ФИО Водителя"></div>
                        <div class="form-group" style="margin: 0;"><input type="text" id="ship-auto" class="input-modern" placeholder="Гос. номер авто"></div>
                        <div class="form-group" style="margin: 0; grid-column: span 2;"><input type="number" id="ship-pallets" class="input-modern" placeholder="Количество поддонов в этой машине (шт)" min="0"></div>
                    </div>
                    <div class="form-group" style="margin: 0;">
                        <input type="text" id="ship-poa" class="input-modern" placeholder="Номер доверенности или кто разрешил (если нужно)">
                    </div>
                </div>
            </div>
        `;

        UI.showModal(`Управление заказом: ${order.doc_number}`, html, `
            <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
            <button class="btn btn-blue" id="btn-do-ship" onclick="executePartialShipment(${order.id}, this)">🚚 Отгрузить выбранное</button>
        `);

    } catch (e) { console.error(e); UI.toast('Ошибка', 'error'); }
};

window.executePartialShipment = async function (orderId, btnElement) {
    const inputs = document.querySelectorAll('.ship-qty-input');
    const items_to_ship = [];
    let totalToShip = 0;
    let hasError = false;

    // Собираем то, что менеджер решил отгрузить прямо сейчас
    inputs.forEach(inp => {
        const qty = parseFloat(inp.value) || 0;
        const maxAllowed = parseFloat(inp.getAttribute('max')) || 0;

        if (qty > maxAllowed) {
            hasError = true; // Защита: нельзя отгрузить больше, чем заказано
        } else if (qty > 0) {
            items_to_ship.push({
                coi_id: inp.getAttribute('data-coi-id'),
                item_id: inp.getAttribute('data-item-id'),
                qty: qty
            });
            totalToShip += qty;
        }
    });

    if (hasError) return UI.toast('❌ Ошибка: Нельзя отгрузить товара больше, чем осталось в заказе!', 'error');
    if (totalToShip === 0) return UI.toast('Укажите количество для отгрузки!', 'warning');

    // Блокируем кнопку, чтобы не нажали дважды
    if (btnElement) btnElement.disabled = true;

    const driver = document.getElementById('ship-driver').value.trim();
    const auto = document.getElementById('ship-auto').value.trim();
    const poa_info = document.getElementById('ship-poa').value.trim();
    const pallets = parseInt(document.getElementById('ship-pallets').value) || 0;

    try {
        const res = await fetch(`/api/sales/orders/${orderId}/ship`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items_to_ship, driver, auto, poa_info, pallets })
        });

        if (res.ok) {
            const data = await res.json();
            UI.closeModal();
            UI.toast(`✅ Накладная ${data.docNum} успешно создана!`, 'success');

            if (data.isCompleted) {
                UI.toast('🎉 Заказ полностью выполнен!', 'success');
            }

            // Обновляем таблицы и канбан
            if (typeof loadActiveOrders === 'function') loadActiveOrders();
            if (typeof loadSalesHistory === 'function') loadSalesHistory();
            if (typeof loadTable === 'function') loadTable();
        } else {
            UI.toast('Ошибка отгрузки: ' + await res.text(), 'error');
        }
    } catch (e) {
        console.error(e);
        UI.toast('Ошибка', 'error');
    } finally {
        if (btnElement) btnElement.disabled = false;
    }
};

// ==========================================
// === ВОЗВРАТЫ (ТОВАР И ПОДДОНЫ) ===
// ==========================================
window.openReturnModal = async function () {
    try {
        const cpRes = await fetch('/api/counterparties');
        const clients = await cpRes.json();

        const accRes = await fetch('/api/accounts');
        const accounts = await accRes.json();

        let clientOptions = '<option value="">-- Выберите клиента --</option>' + clients.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
        let accountOptions = '<option value="">-- Выберите кассу --</option>' + accounts.map(a => `<option value="${a.id}">${a.name} (${a.balance} ₽)</option>`).join('');

        const html = `
            <div style="padding: 10px;">
                <div class="form-group">
                    <label>От кого возврат (Клиент):</label>
                    <select id="ret-client" class="input-modern">${clientOptions}</select>
                </div>

                <div style="background: var(--surface-hover); padding: 10px; border-radius: 6px; border: 1px dashed var(--border); margin-bottom: 15px;">
                    <h4 style="margin: 0 0 10px 0; color: var(--text-muted);">🧱 Возврат продукции (если есть)</h4>
                    <div class="form-grid" style="grid-template-columns: 2fr 1fr 1fr; gap: 10px; align-items: end;">
                        <div class="form-group" style="margin: 0;">
                            <label>Товар:</label>
                            <select id="ret-item" class="input-modern">
                                <option value="">-- Выберите товар --</option>
                                ${Object.values(salesProductsInfo).map(p => `<option value="${p.id}" data-price="${p.price || p.current_price || p.base_price || 0}">${p.name}</option>`).join('')}
                            </select>
                        </div>
                        <div class="form-group" style="margin: 0;"><label>Кол-во:</label><input type="number" id="ret-qty" class="input-modern" min="0"></div>
                        <div class="form-group" style="margin: 0;"><label>На какой склад:</label>
                            <select id="ret-wh" class="input-modern">
                                <option value="4">🟢 №4 (Годная продукция)</option>
                                <option value="5">🟡 №5 (Уценка/Брак)</option>
                            </select>
                        </div>
                    </div>
                    <button class="btn btn-outline" onclick="addReturnItem()" style="margin-top: 10px; width: 100%; font-size: 12px;">➕ Добавить в список возврата</button>
                    
                    <table style="width: 100%; margin-top: 10px; font-size: 13px;">
                        <tbody id="ret-items-table"></tbody>
                    </table>
                </div>

                <div class="form-grid" style="grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 15px;">
                    <div class="form-group" style="margin: 0;">
                        <label style="color: var(--warning-text); font-weight: bold;">Возврат поддонов (шт):</label>
                        <input type="number" id="ret-pallets" class="input-modern" placeholder="Сколько пустых вернули?">
                    </div>
                    <div class="form-group" style="margin: 0;">
                        <label>Сумма к возврату клиенту (₽):</label>
                        <input type="number" id="ret-amount" class="input-modern" placeholder="0">
                    </div>
                </div>

                <div class="form-group">
                    <label>Как компенсируем?</label>
                    <select id="ret-method" class="input-modern" onchange="document.getElementById('ret-acc-group').style.display = this.value === 'cash' ? 'block' : 'none'">
                        <option value="debt">📉 Взаимозачет (Списать с его долга)</option>
                        <option value="cash">💸 Выдать деньги из кассы</option>
                    </select>
                </div>

                <div class="form-group" id="ret-acc-group" style="display: none;">
                    <label>Из какой кассы выдаем?</label>
                    <select id="ret-account" class="input-modern">${accountOptions}</select>
                </div>

                <div class="form-group" style="margin-bottom: 0;">
                    <label>Причина возврата (комментарий):</label>
                    <input type="text" id="ret-reason" class="input-modern" placeholder="Например: Остатки после стройки">
                </div>
            </div>
        `;

        window.returnCart = [];

        UI.showModal('🔙 Оформление возврата', html, `
            <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
            <button class="btn btn-red" onclick="executeReturn()">💾 Провести возврат</button>
        `);
    } catch (e) { console.error(e); }
};

window.addReturnItem = function () {
    const sel = document.getElementById('ret-item');
    const qty = parseFloat(document.getElementById('ret-qty').value);
    const whId = document.getElementById('ret-wh').value;
    const whText = document.getElementById('ret-wh').options[document.getElementById('ret-wh').selectedIndex].text;

    if (sel.selectedIndex <= 0 || !qty || qty <= 0) return UI.toast('Выберите товар и количество!', 'warning');

    const opt = sel.options[sel.selectedIndex];
    const price = parseFloat(opt.getAttribute('data-price')) || 0;

    window.returnCart.push({ id: opt.value, name: opt.text, qty: qty, price: price, warehouse_id: whId, whText: whText });

    // Программа сама суммирует стоимость возвращаемого товара
    const currentAmt = parseFloat(document.getElementById('ret-amount').value) || 0;
    document.getElementById('ret-amount').value = currentAmt + (qty * price);

    document.getElementById('ret-qty').value = '';
    sel.selectedIndex = 0;
    renderReturnCart();
};

window.renderReturnCart = function () {
    const tbody = document.getElementById('ret-items-table');
    tbody.innerHTML = window.returnCart.map((c, idx) => `
        <tr style="border-bottom: 1px solid var(--border);">
            <td style="padding: 4px 0;">${c.name}</td>
            <td style="padding: 4px 0; text-align: center;"><b>${c.qty}</b> ед.</td>
            <td style="padding: 4px 0; color: var(--text-muted); font-size: 11px;">${c.whText}</td>
            <td style="padding: 4px 0; text-align: right;"><button class="btn btn-outline" onclick="window.returnCart.splice(${idx}, 1); renderReturnCart();" style="padding: 2px 6px; font-size: 10px; color: var(--danger); border-color: var(--danger);">❌</button></td>
        </tr>
    `).join('');
};

window.executeReturn = async function () {
    const clientId = document.getElementById('ret-client').value;
    const pallets = parseInt(document.getElementById('ret-pallets').value) || 0;
    const refundAmt = parseFloat(document.getElementById('ret-amount').value) || 0;
    const method = document.getElementById('ret-method').value;
    const accId = document.getElementById('ret-account').value;
    const reason = document.getElementById('ret-reason').value.trim();

    if (!clientId) return UI.toast('Выберите клиента!', 'warning');
    if (window.returnCart.length === 0 && pallets === 0 && refundAmt === 0) {
        return UI.toast('Укажите хотя бы что-то для возврата (товар, поддоны или сумму)!', 'warning');
    }
    if (method === 'cash' && refundAmt > 0 && !accId) return UI.toast('Выберите кассу для выдачи денег!', 'warning');

    try {
        const res = await fetch('/api/sales/returns', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ counterparty_id: clientId, items: window.returnCart, pallets_returned: pallets, refund_amount: refundAmt, refund_method: method, account_id: accId, reason: reason })
        });

        if (res.ok) {
            const data = await res.json();
            UI.closeModal();
            UI.toast(`✅ Возврат ${data.docNum} успешно оформлен!`, 'success');
            loadSalesData(false);
            if (typeof loadTable === 'function') loadTable();
            onClientChange();
        } else {
            UI.toast('Ошибка: ' + await res.text(), 'error');
        }
    } catch (e) { console.error(e); UI.toast('Ошибка связи с сервером', 'error'); }
};

// ==========================================
// === СТАТИЧНЫЕ ДОКУМЕНТЫ (PDF ДЛЯ КЛИЕНТА) ===
// ==========================================
window.openClientDocsModal = function () {
    const html = `
        <style>
            #app-modal .modal-content { max-width: 500px !important; }
            .doc-section { margin-bottom: 20px; }
            .doc-section-title { 
                font-size: 11px; 
                text-transform: uppercase; 
                letter-spacing: 1px; 
                color: var(--text-muted); 
                margin-bottom: 10px; 
                display: block;
                font-weight: 700;
            }
        </style>
        
        <div style="padding: 5px;">
            <div class="doc-section">
                <label class="doc-section-title">📊 ПРАЙС-ЛИСТЫ</label>
                <div class="form-grid" style="grid-template-columns: 1fr 1fr; gap: 12px;">
                    <button class="doc-btn" onclick="printFile('price_main.pdf')">📄 Основной</button>
                    <button class="doc-btn" onclick="printFile('price_dealer.pdf')">📄 Дилерский</button>
                </div>
            </div>

            <div class="doc-section">
                <label class="doc-section-title">📜 СЕРТИФИКАТЫ ГОСТ</label>
                <div class="form-grid" style="grid-template-columns: 1fr 1fr; gap: 12px;">
                    <button class="doc-btn" onclick="printFile('cert_tiles.pdf')">🧩 На плитку</button>
                    <button class="doc-btn" onclick="printFile('cert_curbs.pdf')">🛣️ На бордюры</button>
                </div>
            </div>

            <div class="doc-section">
                <label class="doc-section-title">📑 ТЕХНИЧЕСКАЯ ДОКУМЕНТАЦИЯ</label>
                <button class="doc-btn" onclick="printFile('passport_blank.pdf')">
                    📝 Пустой бланк: Паспорт продукции
                </button>
            </div>

            <div style="border-top: 1px dashed var(--border); margin: 20px 0;"></div>

            <div class="doc-section mb-0">
                <label class="doc-section-title" style="color: var(--primary);">🏢 КАРТОЧКА ПРЕДПРИЯТИЯ</label>
                <div class="bank-select-group">
                    <select id="bank-select-docs" class="input-modern" style="flex: 1;">
                        <option value="tochka" selected>Точка банк</option>
                        <option value="alfa">Альфа-банк</option>
                    </select>
                    <button class="btn btn-blue" onclick="printBankRequisites()">
                        Открыть
                    </button>
                </div>
            </div>
        </div>
    `;

    UI.showModal('🖨️ Документы для выдачи', html, `
        <button class="btn btn-gray" onclick="UI.closeModal()">Закрыть</button>
    `);
};

// Универсальная функция для открытия файлов из папки /files/
window.printFile = function (fileName) {
    if (!fileName) return;
    window.open(`/files/${fileName}`, '_blank');
};

// Функция для открытия реквизитов выбранного банка
window.printBankRequisites = function () {
    const bank = document.getElementById('bank-select-docs').value;
    // Теперь обращаемся к серверу, а он сам решит: отдать EJS или PDF
    window.open(`/print/requisites?bank=${bank}`, '_blank');
};

// === КОММЕРЧЕСКОЕ ПРЕДЛОЖЕНИЕ (КП) ===
window.generateKP = function () {
    const clientId = document.getElementById('sale-client').value;
    if (!clientId) return UI.toast('Выберите контрагента для выставления КП!', 'warning');
    if (cart.length === 0) return UI.toast('Корзина пуста!', 'warning');

    const discount = document.getElementById('sale-discount').value || 0;
    const logisticsCost = document.getElementById('sale-logistics-cost').value || 0;

    const form = document.createElement('form');
    form.method = 'POST';
    form.action = '/print/kp';
    form.target = '_blank';

    const data = { client_id: clientId, items: cart, discount: discount, logistics: logisticsCost };
    
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = 'data';
    input.value = JSON.stringify(data);

    form.appendChild(input);
    document.body.appendChild(form);
    form.submit();
    document.body.removeChild(form);
};

// === ПЕЧАТЬ БЛАНК-ЗАКАЗА ИЗ КОРЗИНЫ ===
window.generateBlankOrder = function () {
    const clientId = document.getElementById('sale-client').value;
    if (!clientId) return UI.toast('Выберите контрагента!', 'warning');
    if (cart.length === 0) return UI.toast('Корзина пуста!', 'warning');

    const discount = document.getElementById('sale-discount').value || 0;
    const logisticsCost = document.getElementById('sale-logistics-cost').value || 0;
    
    // Считываем новые данные: Оплата и Поддоны
    const paymentMethod = document.getElementById('sale-payment-method').value;
    const advanceAmount = document.getElementById('sale-advance-amount')?.value || 0;
    const pallets = document.getElementById('sale-pallets')?.value || 0;
    const deliveryAddress = document.getElementById('sale-delivery-address')?.value || '';

    const form = document.createElement('form');
    form.method = 'POST';
    form.action = '/print/blank_order_draft';
    form.target = '_blank'; 

    const data = { 
        client_id: clientId, 
        items: cart, 
        discount: discount, 
        logistics: logisticsCost,
        pallets: pallets,
        paymentMethod: paymentMethod,
        advanceAmount: advanceAmount,
        delivery_address: deliveryAddress
    };

    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = 'data';
    input.value = JSON.stringify(data);

    form.appendChild(input);
    document.body.appendChild(form);
    form.submit();
    document.body.removeChild(form);
};

// === ВЫСТАВЛЕНИЕ СЧЕТА НА ОПЛАТУ (С РЕДАКТИРОВАНИЕМ СУММЫ) ===
window.openInvoiceModal = function (docNum, debtAmt) {
    const html = `
        <div style="padding: 10px;">
            <p style="margin-top: 0; color: var(--text-muted); font-size: 13px;">Счет для заказа <b>${docNum}</b>.</p>
            <div class="form-group" style="margin-bottom: 15px;">
                <label style="font-weight: bold; color: var(--primary);">Сумма счета (₽):</label>
                <input type="number" id="invoice-custom-amount" class="input-modern" placeholder="${debtAmt}" step="0.01">
                <span style="font-size: 11px; color: var(--text-muted);">Оставьте поле пустым, чтобы выставить счет на весь остаток долга.</span>
            </div>
            <div class="form-group">
                <label>Выберите наши реквизиты (Банк):</label>
                <select id="invoice-bank" class="input-modern">
                    <option value="tochka">ООО "Банк Точка"</option>
                    <option value="alfa">АО "Альфа-Банк"</option>
                </select>
            </div>
        </div>
    `;
    UI.showModal('Выставление счета', html, `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-blue" onclick="executePrintInvoice('${docNum}')">🖨️ Печать Счета</button>
    `);
};

window.executePrintInvoice = function (docNum) {
    const bank = document.getElementById('invoice-bank').value;
    const customAmt = document.getElementById('invoice-custom-amount').value;

    if (customAmt && parseFloat(customAmt) <= 0) {
        return UI.toast('Сумма счета должна быть больше нуля', 'error');
    }

    window.open(`/print/invoice?docNum=${docNum}&bank=${bank}&custom_amount=${customAmt}`, '_blank');
    UI.closeModal();
    setTimeout(() => { if (typeof loadActiveOrders === 'function') loadActiveOrders(); }, 600);
};

// МАГИЯ ВЗАИМОЗАЧЕТА
window.offsetOrderAdvance = async function (docNum, amount) {
    let accOptions = '<option value="">Автоматически (Основная касса)</option>';
    try {
        const accRes = await fetch('/api/accounts');
        if (accRes.ok) {
            const accounts = await accRes.json();
            accounts.forEach(a => {
                accOptions += `<option value="${a.id}">${a.name} (${a.balance} ₽)</option>`;
            });
        }
    } catch (e) { }

    UI.showModal('Взаимозачет аванса', `
        <div style="padding: 10px; font-size: 14px; text-align: center;">
            На балансе клиента есть свободные средства.<br>
            Зачесть <b>${amount.toLocaleString('ru-RU')} ₽</b> в счет оплаты заказа <b>${docNum}</b>?
            
            <div style="margin-top: 20px; text-align: left; background: var(--surface-hover); padding: 10px; border-radius: 6px; border: 1px dashed var(--border);">
                <label style="font-size: 12px; color: var(--text-muted); font-weight: bold;">Через какую кассу провести операцию:</label>
                <select id="offset-account-select" class="input-modern" style="margin-top: 5px;">
                    ${accOptions}
                </select>
                <span style="font-size: 11px; color: var(--text-muted); display: block; margin-top: 5px;">Будет создана парная операция (расход+приход) для закрытия долга.</span>
            </div>
        </div>`, `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-blue" id="btn-do-offset" style="background: #059669; border-color: #059669;" onclick="executeOffset('${docNum}', ${amount}, this)">✅ Провести зачет</button>
    `);
};

window.executeOffset = async function (docNum, amount, btnElement) {
    if (btnElement) btnElement.disabled = true;
    const accountId = document.getElementById('offset-account-select')?.value || null;

    try {
        const res = await fetch('/api/sales/orders/offset', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ docNum, amount, account_id: accountId })
        });

        if (res.ok) {
            UI.closeModal();
            UI.toast('Взаимозачет успешно проведен!', 'success');
            if (typeof loadActiveOrders === 'function') loadActiveOrders();
            if (typeof onClientChange === 'function') onClientChange();
        } else {
            UI.toast('Ошибка: ' + await res.text(), 'error');
        }
    } catch (e) {
        console.error(e);
        UI.toast('Ошибка сети', 'error');
    } finally {
        if (btnElement) btnElement.disabled = false;
    }
};

// === ОТЧЕТ: ДОЛЖНИКИ ПО ТАРЕ (ПОДДОНЫ) ===
window.openPalletsReport = async function () {
    try {
        const res = await fetch('/api/sales/pallets-report');
        const data = await res.json();

        let tbody = data.map(c => `
            <tr style="border-bottom: 1px solid var(--border);">
                <td style="padding: 10px;"><b>${c.name}</b></td>
                <td style="padding: 10px; color: var(--text-muted);">${c.phone || 'Нет телефона'}</td>
                <td style="padding: 10px; text-align: right; color: var(--warning-text); font-weight: bold; font-size: 16px;">${c.pallets_balance} шт.</td>
            </tr>
        `).join('');

        if (data.length === 0) tbody = '<tr><td colspan="3" style="text-align: center; padding: 20px; color: var(--text-muted);">Нет должников по таре 🎉</td></tr>';

        const totalPallets = data.reduce((sum, c) => sum + parseInt(c.pallets_balance), 0);

        const html = `
            <div style="padding: 10px;">
                <div style="background: #fffbeb; padding: 15px; border-radius: 8px; border: 1px solid #fde68a; margin-bottom: 15px; text-align: center;">
                    <span style="color: #b45309; font-size: 14px;">Всего деревянных поддонов зависло у клиентов:</span><br>
                    <strong style="font-size: 26px; color: var(--warning-text);">${totalPallets} шт.</strong>
                </div>
                <table style="width: 100%; border-collapse: collapse;">
                    <thead style="background: var(--surface-hover); text-align: left;">
                        <tr>
                            <th style="padding: 10px;">Клиент</th>
                            <th style="padding: 10px;">Телефон для связи</th>
                            <th style="padding: 10px; text-align: right;">Долг (шт)</th>
                        </tr>
                    </thead>
                    <tbody>${tbody}</tbody>
                </table>
            </div>
        `;
        UI.showModal('📦 Контроль возвратной тары', html, `<button class="btn btn-outline" onclick="UI.closeModal()">Закрыть</button>`);
    } catch (e) { console.error(e); }
};

// === 1. ДАШБОРД: АНАЛИТИКА ПРОДАЖ ===
window.openSalesDashboard = async function () {
    try {
        UI.toast('Загрузка аналитики...', 'info');
        const res = await fetch('/api/sales/analytics');
        const data = await res.json();

        const formatSum = (sum) => parseFloat(sum).toLocaleString('ru-RU') + ' ₽';
        const maxItemSum = data.topItems.length > 0 ? parseFloat(data.topItems[0].total_sum) : 1;

        // Рисуем бары для товаров
        let itemsHtml = data.topItems.map((i, idx) => `
            <div style="margin-bottom: 12px;">
                <div style="display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 4px;">
                    <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 65%;"><b>${idx + 1}.</b> ${i.name} (${i.total_qty} шт)</span>
                    <span style="font-weight: bold; color: #059669;">${formatSum(i.total_sum)}</span>
                </div>
                <div style="background: #e2e8f0; height: 8px; border-radius: 4px; overflow: hidden;">
                    <div style="background: linear-gradient(90deg, #38bdf8, #3b82f6); width: ${(parseFloat(i.total_sum) / maxItemSum) * 100}%; height: 100%; border-radius: 4px;"></div>
                </div>
            </div>
        `).join('');

        // Рисуем список клиентов
        let clientsHtml = data.topClients.map((c, idx) => `
            <div style="display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid var(--surface-alt); font-size: 13px;">
                <span><b style="color: var(--text-muted);">${idx + 1}.</b> ${c.name}</span>
                <strong style="color: var(--info);">${formatSum(c.total_sum)}</strong>
            </div>
        `).join('');

        const html = `
            <style>.modal-content { max-width: 800px !important; }</style>
            <div style="padding: 10px;">
                <div style="background: linear-gradient(135deg, #3b82f6, var(--info)); color: white; padding: 25px; border-radius: 12px; text-align: center; margin-bottom: 20px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
                    <div style="font-size: 14px; opacity: 0.9; text-transform: uppercase; letter-spacing: 1px;">Выручка за текущий месяц</div>
                    <div style="font-size: 42px; font-weight: 900; margin-top: 5px;">${formatSum(data.monthRevenue)}</div>
                </div>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
                    <div style="background: var(--surface-hover); border: 1px solid #e2e8f0; padding: 20px; border-radius: 12px;">
                        <h4 style="margin-top: 0; color: #0f172a; margin-bottom: 20px;">🏆 Топ-5 товаров</h4>
                        ${itemsHtml || '<div style="color: var(--text-muted); text-align: center;">Нет продаж в этом месяце</div>'}
                    </div>
                    <div style="background: var(--surface-hover); border: 1px solid #e2e8f0; padding: 20px; border-radius: 12px;">
                        <h4 style="margin-top: 0; color: #0f172a; margin-bottom: 10px;">🥇 Топ-5 клиентов</h4>
                        ${clientsHtml || '<div style="color: var(--text-muted); text-align: center;">Нет продаж в этом месяце</div>'}
                    </div>
                </div>
            </div>
        `;
        UI.showModal('📊 Аналитика продаж', html, `<button class="btn btn-outline" onclick="UI.closeModal()">Закрыть</button>`);
    } catch (e) { console.error(e); }
};

// === 2. КАЛЕНДАРЬ ОТГРУЗОК (ЛОГИСТИКА) ===
window.openLogisticsCalendar = function () {
    if (!allActiveOrders || allActiveOrders.length === 0) return UI.toast('Нет активных заказов', 'warning');

    // Группируем заказы по датам отгрузки
    const grouped = {};
    allActiveOrders.forEach(o => {
        const d = o.deadline || 'Без даты (Самовывоз)';
        if (!grouped[d]) grouped[d] = [];
        grouped[d].push(o);
    });

    // Сортируем даты по возрастанию
    const dates = Object.keys(grouped).sort((a, b) => {
        if (a.includes('Без даты')) return 1; if (b.includes('Без даты')) return -1;
        const [d1, m1, y1] = a.split('.'); const [d2, m2, y2] = b.split('.');
        return new Date(y1, m1 - 1, d1) - new Date(y2, m2 - 1, d2);
    });

    // Генерируем колонки Kanban-доски
    let html = '<style>.modal-content { max-width: 1200px !important; width: 95% !important; }</style>';
    html += '<div style="padding: 10px; display: flex; gap: 15px; overflow-x: auto; padding-bottom: 20px;">';

    dates.forEach(date => {
        const isToday = date === new Date().toLocaleDateString('ru-RU');
        html += `
            <div style="min-width: 320px; max-width: 320px; background: var(--surface-hover); border: 1px solid #e2e8f0; border-radius: 8px; padding: 15px; flex-shrink: 0;">
                <h4 style="margin-top: 0; color: #0f172a; border-bottom: 3px solid ${isToday ? '#ef4444' : '#38bdf8'}; padding-bottom: 8px; margin-bottom: 15px;">
                    ${isToday ? '🔥 СЕГОДНЯ' : '📅 ' + date} <span style="font-weight: normal; font-size: 12px; color: var(--text-muted); float: right;">${grouped[date].length} маш.</span>
                </h4>`;

        grouped[date].forEach(o => {
            const ordered = parseFloat(o.total_ordered) || 0;
            const shipped = parseFloat(o.total_shipped) || 0;
            const percent = ordered > 0 ? Math.round((shipped / ordered) * 100) : 0;

            html += `
                <div style="background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 12px; margin-bottom: 10px; box-shadow: 0 2px 4px var(--shadow-sm); cursor: pointer;" onclick="openOrderManager(${o.id})">
                    <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
                        <strong style="color: var(--info);">${o.doc_number}</strong>
                        <span style="font-size: 10px; font-weight: bold; background: ${percent === 100 ? 'var(--success-bg)' : (percent > 0 ? 'var(--info-bg)' : 'var(--warning-bg)')}; color: ${percent === 100 ? 'var(--success-text)' : (percent > 0 ? 'var(--info)' : 'var(--warning-text)')}; padding: 3px 6px; border-radius: 4px;">Собрано: ${percent}%</span>
                    </div>
                    <div style="font-size: 13px; font-weight: bold; margin-bottom: 5px;">${o.client_name || 'Неизвестно'}</div>
                    <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 8px; background: var(--surface-alt); padding: 5px; border-radius: 4px;">📍 ${o.delivery_address || 'Самовывоз со склада'}</div>
                    <div style="font-size: 11px; color: var(--text-muted); padding-top: 8px; border-top: 1px dashed #e2e8f0; line-height: 1.5;">📦 ${o.items_list}</div>
                </div>`;
        });
        html += `</div>`;
    });
    html += '</div>';

    UI.showModal('🚚 Календарь отгрузок (План логиста)', html, `<button class="btn btn-outline" onclick="UI.closeModal()">Закрыть</button>`);
};

// === ЭКСПОРТ В 1С (ВЫГРУЗКА В EXCEL) ===
window.openExport1CModal = function () {
    const today = new Date();
    const currentMonth = String(today.getMonth() + 1).padStart(2, '0');
    const currentYear = today.getFullYear();

    const html = `
        <div style="padding: 10px; text-align: center;">
            <p style="color: var(--text-muted); font-size: 13px; margin-top: 0;">Выберите период для выгрузки реестра отгрузок. Файл скачается в формате CSV (Excel), оптимизированном для загрузки в 1С Бухгалтерию.</p>
            <div style="display: flex; gap: 10px; justify-content: center; margin-top: 20px;">
                <div class="form-group" style="margin: 0;">
                    <label>Месяц</label>
                    <select id="export-month" class="input-modern" style="min-width: 150px;">
                        <option value="01" ${currentMonth === '01' ? 'selected' : ''}>Январь</option>
                        <option value="02" ${currentMonth === '02' ? 'selected' : ''}>Февраль</option>
                        <option value="03" ${currentMonth === '03' ? 'selected' : ''}>Март</option>
                        <option value="04" ${currentMonth === '04' ? 'selected' : ''}>Апрель</option>
                        <option value="05" ${currentMonth === '05' ? 'selected' : ''}>Май</option>
                        <option value="06" ${currentMonth === '06' ? 'selected' : ''}>Июнь</option>
                        <option value="07" ${currentMonth === '07' ? 'selected' : ''}>Июль</option>
                        <option value="08" ${currentMonth === '08' ? 'selected' : ''}>Август</option>
                        <option value="09" ${currentMonth === '09' ? 'selected' : ''}>Сентябрь</option>
                        <option value="10" ${currentMonth === '10' ? 'selected' : ''}>Октябрь</option>
                        <option value="11" ${currentMonth === '11' ? 'selected' : ''}>Ноябрь</option>
                        <option value="12" ${currentMonth === '12' ? 'selected' : ''}>Декабрь</option>
                    </select>
                </div>
                <div class="form-group" style="margin: 0;">
                    <label>Год</label>
                    <input type="number" id="export-year" class="input-modern" value="${currentYear}" style="max-width: 100px;">
                </div>
            </div>
        </div>
    `;

    UI.showModal('📥 Экспорт для 1С (Отгрузки)', html, `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-blue" style="background: #10b981; border-color: #10b981;" onclick="executeExport1C()">Скачать Excel</button>
    `);
};

window.executeExport1C = function () {
    const m = document.getElementById('export-month').value;
    const y = document.getElementById('export-year').value;

    // Открываем маршрут скачивания файла
    window.open(`/api/sales/export-1c?month=${m}&year=${y}`, '_blank');
    UI.closeModal();
    UI.toast('Файл скачивается...', 'success');
};

window.handleDealerCsvImport = function (event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.readAsText(file, 'windows-1251');
    reader.onload = function (e) {
        const text = e.target.result;
        const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);

        if (lines.length < 2) return UI.toast('Файл пуст или нет данных', 'error');

        const delimiter = lines[0].includes(';') ? ';' : ',';
        const headers = lines[0].split(delimiter).map(h => h.trim().toUpperCase().replace(/^"|"$/g, ''));

        const articleIdx = headers.findIndex(h => h.includes('АРТИКУЛ') || h.includes('ART'));
        const priceIdx = headers.findIndex(h => h.includes('ЦЕНА') || h.includes('ДИЛЕР') || h.includes('ОПТ') || h.includes('PRICE'));

        if (articleIdx === -1 || priceIdx === -1) {
            console.error("Найденные колонки:", headers);
            return UI.toast('❌ В первой строке файла обязательно должны быть заголовки "Артикул" и "Цена" (или синонимы)', 'error');
        }

        let matchCount = 0;
        for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split(delimiter).map(c => c.trim().replace(/^"|"$/g, ''));
            if (cols.length <= Math.max(articleIdx, priceIdx)) continue;

            const csvArticle = cols[articleIdx];
            const priceRaw = cols[priceIdx].replace(/\s/g, '').replace(',', '.');
            const price = parseFloat(priceRaw);

            if (csvArticle && !isNaN(price) && price > 0) {
                const dbItem = Object.values(salesProductsInfo).find(item => item.article === csvArticle);
                if (dbItem) {
                    const input = document.querySelector(`.price-dealer[data-id="${dbItem.id}"]`);
                    if (input) {
                        input.value = price;
                        input.style.backgroundColor = 'var(--success-bg)';
                        input.style.border = '1px solid #22c55e';
                        matchCount++;
                    }
                }
            }
        }

        if (matchCount > 0) {
            UI.toast(`✅ Идеально! Подтянуто цен: ${matchCount}. Нажмите "Сохранить".`, 'success');
        } else {
            UI.toast('❌ Совпадений по артикулам не найдено. Проверьте файл.', 'warning');
        }
    };
};

window.handleBasicCsvImport = function (event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.readAsText(file, 'windows-1251');
    reader.onload = function (e) {
        const text = e.target.result;
        const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
        let matchCount = 0;

        const colorConfig = [
            { name: 'СЕР', col: 5 },
            { name: 'КРАСН', col: 6 }, { name: 'КОРИЧН', col: 6 }, { name: 'ЧЕРН', col: 6 },
            { name: 'БЕЛ', col: 7 },
            { name: 'ЖЕЛТ', col: 8 }, { name: 'ОРАНЖ', col: 8 }
        ];

        lines.forEach((line) => {
            const delimiter = line.includes(';') ? ';' : ',';
            const cols = line.split(delimiter).map(c => c.trim().replace(/^"|"$/g, ''));
            if (cols.length < 6) return;

            const csvName = cols[0].toUpperCase();
            if (csvName.includes('НАИМЕНОВАНИЕ') || csvName.includes('ГОСТ') || !csvName) return;

            const modelMatch = csvName.match(/(\d\.[А-Я]\.\d+)/);
            const coreModel = modelMatch ? modelMatch[0] : csvName;

            const dbProducts = typeof salesProductsInfo !== 'undefined' ? Object.values(salesProductsInfo) : [];

            dbProducts.forEach(dbItem => {
                const dbName = dbItem.name.toUpperCase();

                if (dbName.includes(coreModel) || csvName.includes(dbName.split(' ')[0])) {
                    colorConfig.forEach(cfg => {
                        if (dbName.includes(cfg.name)) {
                            const priceRaw = cols[cfg.col] ? cols[cfg.col].replace(/\s/g, '').replace(',', '.') : '';
                            const price = parseFloat(priceRaw);

                            if (!isNaN(price) && price > 0) {
                                const input = document.querySelector(`.price-basic[data-id="${dbItem.id}"]`);
                                if (input) {
                                    input.value = price;
                                    input.style.backgroundColor = '#eff6ff';
                                    input.style.border = '1px solid #3b82f6';
                                    matchCount++;
                                }
                            }
                        }
                    });
                }
            });
        });

        if (matchCount > 0) {
            UI.toast(`✅ Базовый прайс: подтянуто цен - ${matchCount}.`, 'success');
        } else {
            UI.toast('Совпадений не найдено. Проверьте формат.', 'error');
        }
    };
};

// === СБОРКА ВЫПАДАЮЩИХ СПИСКОВ И СБРОС ФИЛЬТРОВ ===
function populateSalesFilters() {
    // Собираем уникальных клиентов из заказов
    const orderClients = new Set();
    allActiveOrders.forEach(o => { if (o.client_name) orderClients.add(o.client_name); });

    const boSelect = document.getElementById('bo-client-filter');
    if (boSelect) {
        const currentVal = boSelect.value;
        boSelect.innerHTML = '<option value="">🌐 Все клиенты</option>';
        Array.from(orderClients).sort().forEach(c => boSelect.add(new Option(c, c)));
        boSelect.value = currentVal; // сохраняем выбор при автообновлении
    }

    // Собираем уникальных клиентов из истории
    const histClients = new Set();
    allSalesHistory.forEach(h => { if (h.client_name) histClients.add(h.client_name); });

    const histSelect = document.getElementById('hist-client-filter');
    if (histSelect) {
        const currentVal = histSelect.value;
        histSelect.innerHTML = '<option value="">🌐 Все клиенты</option>';
        Array.from(histClients).sort().forEach(c => histSelect.add(new Option(c, c)));
        histSelect.value = currentVal;
    }
}

window.applyOrderFilters = function () { boPage = 1; renderBlankOrdersTable(); };
window.applyHistoryFilters = function () { historyPage = 1; renderHistoryTable(); };

window.resetOrderFilters = function () {
    document.getElementById('bo-search').value = '';
    document.getElementById('bo-client-filter').value = '';
    document.getElementById('bo-product-filter').value = '';
    document.getElementById('bo-status-filter').value = '';
    applyOrderFilters();
};

window.resetHistoryFilters = function () {
    document.getElementById('hist-search').value = '';
    document.getElementById('hist-client-filter').value = '';

    // Очищаем умный календарь и сбрасываем даты
    historyDateRange = { start: '', end: '' };

    if (historyDatePicker) {
        historyDatePicker.clear(); // 👈 Автоматом вызовет applyHistoryFilters()
    } else {
        applyHistoryFilters();
    }
};

// === CRM ВОРОНКА (КАНБАН) ===

window.toggleSalesView = function (viewType) {
    const tableWrap = document.getElementById('sales-table-wrapper');
    const kanbanWrap = document.getElementById('sales-kanban-board');
    const btnList = document.getElementById('view-btn-list');
    const btnKanban = document.getElementById('view-btn-kanban');

    if (viewType === 'kanban') {
        if (tableWrap) tableWrap.style.display = 'none';
        kanbanWrap.style.display = 'flex';
        btnList.className = 'btn btn-outline';
        btnKanban.className = 'btn btn-blue';
        renderKanbanBoard();
    } else {
        kanbanWrap.style.display = 'none';
        if (tableWrap) tableWrap.style.display = 'block';
        btnList.className = 'btn btn-blue';
        btnKanban.className = 'btn btn-outline';
    }
};

window.renderKanbanBoard = function () {
    // Очищаем колонки
    document.querySelectorAll('.kanban-items-container').forEach(col => col.innerHTML = '');
    let counts = { pending: 0, processing: 0 };

    if (typeof allActiveOrders === 'undefined' || allActiveOrders.length === 0) return;

    allActiveOrders.forEach(order => {
        // Мы не показываем 'completed' на доске, они уходят в архив
        if (order.status === 'completed') return;

        counts[order.status] = (counts[order.status] || 0) + 1;

        const card = document.createElement('div');
        card.className = 'kanban-card';
        card.draggable = true;
        card.dataset.id = order.id;

        const borderColor = order.status === 'processing' ? 'var(--success)' : '#3b82f6';
        card.style = `background: var(--surface); padding: 15px; margin-bottom: 12px; border-radius: 8px; box-shadow: 0 1px 2px var(--shadow-sm); cursor: grab; border-left: 5px solid ${borderColor}; user-select: none; border-top: 1px solid var(--surface-alt); border-right: 1px solid var(--surface-alt); border-bottom: 1px solid var(--surface-alt);`;

        card.innerHTML = `
            <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 6px; display: flex; justify-content: space-between;">
                <span>${order.doc_number}</span>
                <span title="Дедлайн">⏳ ${order.deadline || order.date_formatted}</span>
            </div>
            <div style="font-weight: bold; margin-bottom: 8px; color: #1e293b; font-size: 14px;">${escapeHTML(order.client_name)}</div>
            <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 12px; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;">
                ${escapeHTML(order.items_list)}
            </div>
            <div style="display: flex; justify-content: space-between; align-items: center; border-top: 1px solid var(--surface-alt); padding-top: 10px;">
                <span style="font-size: 15px; font-weight: 800; color: #0f172a;">${parseFloat(order.total_amount).toLocaleString()} ₽</span>
                
                <button onclick="openOrderDetails(${order.id})" style="background:var(--surface-alt); border:none; padding: 4px 8px; border-radius: 4px; color: #3b82f6; cursor: pointer; font-size: 12px; font-weight: bold; transition: 0.2s;" onmouseover="this.style.background='var(--info-bg)'" onmouseout="this.style.background='var(--surface-alt)'">
                    Детали ➔
                </button>
            </div>
        `;

        card.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/plain', order.id);
            setTimeout(() => card.style.opacity = '0.4', 0);
        });
        card.addEventListener('dragend', () => card.style.opacity = '1');

        const column = document.querySelector(`.kanban-column[data-status="${order.status}"] .kanban-items-container`);
        if (column) column.appendChild(card);
    });

    // Обновляем счетчики в заголовках колонок
    document.querySelector('.kanban-column[data-status="pending"] .column-count').innerText = counts.pending;
    document.querySelector('.kanban-column[data-status="processing"] .column-count').innerText = counts.processing;

    // Настраиваем Drag & Drop
    document.querySelectorAll('.kanban-column').forEach(col => {
        // Чтобы событие не дублировалось при перерисовке
        col.removeEventListener('dragover', window.handleDragOver);
        col.removeEventListener('dragleave', window.handleDragLeave);
        col.removeEventListener('drop', window.handleDrop);

        window.handleDragOver = e => { e.preventDefault(); col.style.background = '#e2e8f0'; };
        window.handleDragLeave = e => { col.style.background = ''; };
        window.handleDrop = async (e) => {
            e.preventDefault();
            col.style.background = '';

            const orderId = e.dataTransfer.getData('text/plain');
            const newStatus = col.dataset.status;

            const order = allActiveOrders.find(o => o.id == orderId);
            if (order && order.status !== newStatus) {
                order.status = newStatus;
                renderKanbanBoard(); // Мгновенно перерисовываем

                try {
                    const res = await fetch(`/api/sales/orders/${orderId}/status`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ status: newStatus })
                    });
                    if (!res.ok) throw new Error();
                    UI.toast('Статус заказа изменен', 'success');
                } catch (err) {
                    UI.toast('Ошибка сохранения статуса', 'error');
                    if (typeof loadSalesData === 'function') loadSalesData(false); // Откат
                }
            }
        };

        col.addEventListener('dragover', window.handleDragOver);
        col.addEventListener('dragleave', window.handleDragLeave);
        col.addEventListener('drop', window.handleDrop);
    });
};

// === ФУНКЦИЯ ОТКРЫТИЯ ДЕТАЛЕЙ ЗАКАЗА ===
window.openOrderDetails = async function (orderId) {
    try {
        // Запрашиваем данные заказа с бэкенда
        const res = await fetch(`/api/sales/orders/${orderId}`);
        if (!res.ok) throw new Error('Ошибка при загрузке данных заказа');

        const data = await res.json();
        const order = data.order;
        const items = data.items;

        // Формируем таблицу с составом заказа
        let itemsHtml = `
            <table style="width: 100%; margin-bottom: 15px; border-collapse: collapse; font-size: 13px;">
                <thead style="background: var(--surface-hover); text-align: left;">
                    <tr>
                        <th style="padding: 8px; border-bottom: 1px solid var(--border);">Товар</th>
                        <th style="padding: 8px; border-bottom: 1px solid var(--border); text-align: center;">Заказано</th>
                        <th style="padding: 8px; border-bottom: 1px solid var(--border); text-align: center;">Отгружено</th>
                    </tr>
                </thead>
                <tbody>
        `;

        items.forEach(item => {
            const ordered = parseFloat(item.qty_ordered);
            const shipped = parseFloat(item.qty_shipped || 0);
            // Подсветка статуса отгрузки: зеленый (полностью), желтый (частично), красный (не отгружалось)
            const color = shipped >= ordered ? 'color: var(--success);' : (shipped > 0 ? 'color: #f59e0b;' : 'color: #ef4444;');

            itemsHtml += `
                <tr>
                    <td style="padding: 8px; border-bottom: 1px solid var(--surface-alt);">${escapeHTML(item.name)}</td>
                    <td style="padding: 8px; border-bottom: 1px solid var(--surface-alt); text-align: center; font-weight: bold;">${ordered} ${item.unit}</td>
                    <td style="padding: 8px; border-bottom: 1px solid var(--surface-alt); text-align: center; font-weight: bold; ${color}">${shipped}</td>
                </tr>
            `;
        });
        itemsHtml += `</tbody></table>`;

        // Формируем тело модального окна
        const htmlBody = `
            <div style="margin-bottom: 15px; background: var(--surface-hover); padding: 15px; border-radius: 8px; border: 1px solid #e2e8f0; font-size: 14px;">
                <div style="margin-bottom: 8px;"><strong>👤 Клиент:</strong> ${escapeHTML(order.client_name)}</div>
                <div style="margin-bottom: 8px;"><strong>📍 Адрес доставки:</strong> ${escapeHTML(order.delivery_address || 'Самовывоз')}</div>
                <div style="margin-bottom: 8px;"><strong>💰 Сумма заказа:</strong> <span style="color: #0f172a; font-weight: bold;">${parseFloat(order.total_amount).toLocaleString()} ₽</span></div>
                <div style="margin-bottom: 0;"><strong>📅 Плановая отгрузка:</strong> ${order.planned_shipment_date ? new Date(order.planned_shipment_date).toLocaleDateString() : 'Не указана'}</div>
            </div>
            <h4 style="margin: 0 0 10px 0; color: var(--text-muted);">📦 Состав заказа:</h4>
            ${itemsHtml}
        `;

        // Формируем кнопки управления
        const buttonsHtml = `
            <button class="btn btn-outline" onclick="UI.closeModal()">Закрыть</button>
        `;

        // Открываем окно через глобальный UI-контроллер
        UI.showModal(`📄 Заказ ${order.doc_number}`, htmlBody, buttonsHtml);
    } catch (e) {
        UI.toast(e.message, 'error');
    }
};

// ==========================================
// === МИНИ-МОДАЛКИ (СОЗДАНИЕ КЛИЕНТА И ДОГОВОРА) ===
// ==========================================

window.openMiniClientModal = function () {
    const html = `
        <div style="padding: 10px;">
            <input type="text" style="display:none" autocomplete="username">
            <input type="password" style="display:none" autocomplete="current-password">

            <div class="form-group">
                <label>Наименование (ФИО или Орг.):</label>
                <input type="text" id="m-cl-name" class="input-modern" autocomplete="nope" placeholder="Иванов И.И.">
            </div>
            <div class="form-group">
                <label>Телефон:</label>
                <input type="text" id="m-cl-phone" class="input-modern" autocomplete="nope" placeholder="+7...">
            </div>
        </div>
    `;
    UI.showModal('➕ Новый контрагент', html, `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-blue" onclick="saveMiniClient()">💾 Сохранить</button>
    `);
};

window.openMiniContractModal = function () {
    const cpId = document.getElementById('sale-client').value;
    if (!cpId) return UI.toast('Сначала выберите клиента!', 'warning');

    const html = `
        <div style="padding: 10px;">
            <input type="text" style="display:none" autocomplete="username">
            <input type="password" style="display:none" autocomplete="current-password">

            <div class="form-group">
                <label>Номер договора:</label>
                <input type="text" id="m-ct-num" class="input-modern" autocomplete="nope" placeholder="Напр: 125/2026">
            </div>
            <div class="form-group">
                <label>Дата договора:</label>
                <input type="date" id="m-ct-date" class="input-modern" value="${new Date().toISOString().split('T')[0]}">
            </div>
        </div>
    `;
    UI.showModal('📄 Новый договор', html, `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-blue" onclick="saveMiniContract()">✅ Создать</button>
    `);
};

window.saveMiniClient = async function () {
    const name = document.getElementById('m-cl-name').value.trim();
    const phone = document.getElementById('m-cl-phone').value.trim();
    if (!name) return UI.toast('Введите наименование!', 'error');

    try {
        const res = await fetch('/api/counterparties', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, phone, type: 'Покупатель' })
        });

        if (res.ok) {
            const client = await res.json();
            UI.toast('Клиент добавлен', 'success');
            UI.closeModal();

            // ЖЕЛЕЗОБЕТОННАЯ СТРАХОВКА: Ищем ID даже если сервер вернул странный ответ
            let newId = client.id;
            if (!newId) {
                const listRes = await fetch('/api/counterparties');
                const list = await listRes.json();
                const found = list.find(c => c.name === name);
                if (found) newId = found.id;
            }

            // Передаем ID в мозг списка. Он сам выберет его и откроет розовую карточку!
            if (newId) {
                await syncClientsDropdown(newId);
            } else {
                await syncClientsDropdown(); // Если совсем не нашли, просто обновим список
            }
        } else {
            UI.toast('Ошибка сохранения', 'error');
        }
    } catch (e) { UI.toast('Ошибка сети', 'error'); }
};

window.saveMiniContract = async function () {
    const clientId = document.getElementById('sale-client').value;
    const number = document.getElementById('m-ct-num').value.trim();
    const date = document.getElementById('m-ct-date').value;

    if (!number) return UI.toast('Введите номер договора!', 'error');

    try {
        const res = await fetch('/api/contracts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ counterparty_id: clientId, number: number, date: date }) // Ключи точно под твой бэкенд
        });
        if (res.ok) {
            UI.toast('Договор создан', 'success');
            UI.closeModal();
            onClientChange(); // Обновляет список договоров в селекторе
        } else {
            UI.toast('Ошибка сохранения', 'error');
        }
    } catch (e) { UI.toast('Ошибка сети', 'error'); }
};

window.changeSalesHistoryPage = function (dir) {
    historyPage += dir;
    if (historyPage < 1) historyPage = 1;
    loadSalesHistory();
};

window.triggerSalesSearch = function () {
    historySearch = document.getElementById('sales-history-search').value;
    historyPage = 1;
    loadSalesHistory();
};

// --- ЗАПУСК МОДУЛЯ ПРОДАЖ ---
document.addEventListener('DOMContentLoaded', () => {
    if (typeof initSales === 'function') {
        initSales();
    } else {
        console.error("❌ Функция initSales не найдена!");
    }
});

  // ==========================================================================
// ГЛОБАЛЬНЫЙ ЦЕНТР ПЕЧАТИ ДОКУМЕНТОВ (Связь с docs.js)
// ==========================================================================
window.AppPrint = {
    // 1. Счет на оплату
    invoice: function(id) {
        if (!id) return UI.toast('ID счета не указан', 'error');
        window.open(`/print/invoice?id=${id}`, '_blank');
    },
    // 2. Расходная накладная
    waybill: function(docNum) {
        if (!docNum) return UI.toast('Номер документа не указан', 'error');
        window.open(`/print/waybill?docNum=${docNum}`, '_blank');
    },
    // 3. УПД
    upd: function(docNum) {
        if (!docNum) return UI.toast('Номер документа не указан', 'error');
        window.open(`/print/upd?docNum=${docNum}`, '_blank');
    },
    // 4. Договор
    contract: function(id) {
        if (!id) return UI.toast('ID договора не указан', 'error');
        window.open(`/print/contract?id=${id}`, '_blank');
    },
    // 5. Спецификация (по номеру заказа)
    specification: function(docNum) {
        if (!docNum) return UI.toast('Номер заказа не указан', 'error');
        window.open(`/print/specification?docNum=${docNum}`, '_blank');
    },
    // 6. Спецификация (отдельный документ)
    specificationDoc: function(id) {
        if (!id) return UI.toast('ID спецификации не указан', 'error');
        window.open(`/print/specification_doc?id=${id}`, '_blank');
    },
    // 7. Акт сверки
    act: function(cpId, startDate, endDate) {
        if (!cpId || !startDate || !endDate) return UI.toast('Укажите контрагента и период', 'error');
        window.open(`/print/act?cpId=${cpId}&start=${startDate}&end=${endDate}`, '_blank');
    },
    // 8. Бланк заказа
    blankOrder: function(docNum) {
        if (!docNum) return UI.toast('Номер заказа не указан', 'error');
        window.open(`/print/blank_order?docNum=${docNum}`, '_blank');
    },
    // 9. Паспорт партии (Производство)
    passport: function(batchId) {
        if (!batchId) return UI.toast('ID партии не указан', 'error');
        window.open(`/print/passport?batchId=${batchId}`, '_blank');
    }
};