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

function initSales() {
    const whSelect = document.getElementById('sale-warehouse');
    if (whSelect) currentSalesWarehouse = whSelect.value;

    // --- НОВОЕ: Инициализация крутого календаря Flatpickr ---
    const dateInput = document.getElementById('hist-date-filter');
    if (dateInput && !dateInput._flatpickr) {
        flatpickr(dateInput, {
            mode: "range",
            dateFormat: "Y-m-d",
            altInput: true,
            altFormat: "d.m.Y",
            locale: "ru", // Русский язык
            onChange: function (selectedDates, dateStr, instance) {
                if (selectedDates.length === 1) {
                    // Выбран только 1 день
                    historyDateRange.start = instance.formatDate(selectedDates[0], "Y-m-d");
                    historyDateRange.end = instance.formatDate(selectedDates[0], "Y-m-d");
                } else if (selectedDates.length === 2) {
                    // Выбран период (от и до)
                    historyDateRange.start = instance.formatDate(selectedDates[0], "Y-m-d");
                    historyDateRange.end = instance.formatDate(selectedDates[1], "Y-m-d");
                } else {
                    historyDateRange = { start: '', end: '' }; // Очищено
                }
                applyHistoryFilters(); // Авто-обновление таблицы
            }
        });
    }

    loadSalesData(true);
    loadSalesHistory();
    if (typeof loadActiveOrders === 'function') loadActiveOrders();
}

// === ЛОГИКА БЫСТРЫХ КНОПОК ПЕРИОДА ===
window.setHistoryDateRange = function (type) {
    const fpEl = document.getElementById('hist-date-filter');
    if (!fpEl || !fpEl._flatpickr) return;
    const picker = fpEl._flatpickr;

    const today = new Date();
    let start = new Date();
    let end = new Date();

    switch (type) {
        case 'today':
            break;
        case 'week':
            const day = today.getDay();
            const diff = today.getDate() - day + (day === 0 ? -6 : 1); // Понедельник
            start = new Date(today); // Клонируем today
            start.setDate(diff);     // Меняем только start
            end = new Date(start);
            end.setDate(start.getDate() + 6); // Воскресенье
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

    // Устанавливаем даты в календарь визуально
    picker.setDate([start, end]);

    // Записываем в системные переменные и фильтруем
    historyDateRange.start = picker.formatDate(start, "Y-m-d");
    historyDateRange.end = picker.formatDate(end, "Y-m-d");
    applyHistoryFilters();
};

window.changeSaleWarehouse = function () {
    currentSalesWarehouse = document.getElementById('sale-warehouse').value;
    loadSalesData(false);
    document.getElementById('sale-product-input').value = '';
    updateSaleMaxQty();
};

window.loadClientContracts = async function () {
    const cpId = document.getElementById('sale-client').value;
    const contractGroup = document.getElementById('sale-contract-group');
    const contractSelect = document.getElementById('sale-contract');

    if (!cpId) {
        contractGroup.style.display = 'none';
        contractSelect.innerHTML = '';
        return;
    }
    try {
        const res = await fetch(`/api/counterparties/${cpId}/contracts`);
        const data = await res.json();
        contractSelect.innerHTML = '<option value="Основной договор">-- Основной договор (Без номера) --</option>';

        data.forEach(row => {
            const baseStr = `Договор №${row.contract_number} от ${row.contract_date}`;
            const optText = row.spec_id ? `${baseStr} (Спец. №${row.spec_number} от ${row.spec_date})` : baseStr;
            let opt = new Option(optText, optText);
            opt.setAttribute('data-cid', row.contract_id);
            contractSelect.add(opt);
        });
        contractGroup.style.display = 'block';
    } catch (e) { console.error(e); }
};

window.onClientChange = async function () {
    loadClientContracts();
    loadClientPoas();

    const clientSelect = document.getElementById('sale-client');
    const cpId = clientSelect.value;
    const infoBox = document.getElementById('sale-client-info');

    // Обновляем цены в поиске при смене клиента
    if (typeof updateDatalistUI === 'function') updateDatalistUI();
    updateSaleMaxQty();

    if (!cpId) {
        infoBox.style.display = 'none';
        return;
    }

    try {
        const res = await fetch(`/api/counterparties/${cpId}/profile`);
        if (!res.ok) return;
        const data = await res.json();

        const client = data.info;
        const invoices = data.invoices || [];

        let totalDebt = 0;
        invoices.forEach(inv => {
            if (inv.status === 'pending') totalDebt += parseFloat(inv.amount);
        });

        // 🚀 НОВАЯ ШАПКА: ИМЯ КЛИЕНТА, БЕЙДЖ "ДИЛЕР" И КНОПКА "КАРТОЧКА"
        const priceLevel = client.price_level || 'basic';
        const badgeHtml = priceLevel === 'dealer'
            ? `<span style="background: #ede9fe; color: #8b5cf6; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: bold; border: 1px solid #ddd6fe;">👑 ДИЛЕР</span>`
            : `<span style="background: #f1f5f9; color: #64748b; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: bold; border: 1px solid #e2e8f0;">👤 Розница</span>`;

        const headerHtml = `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; padding-bottom: 10px; border-bottom: 1px dashed #f472b6;">
                <div style="display: flex; align-items: center; gap: 10px;">
                    <span style="font-weight: bold; font-size: 14px; color: #831843;">${client.name}</span>
                    ${badgeHtml}
                </div>
                <button class="btn btn-outline" style="padding: 4px 10px; font-size: 11px; border-color: #db2777; color: #db2777; background: #fff;" onclick="openClientEditor(${cpId})">
                    ⚙️ Карточка
                </button>
            </div>
        `;

        let statusDiv = document.getElementById('sale-client-status');
        if (!statusDiv) {
            statusDiv = document.createElement('div');
            statusDiv.id = 'sale-client-status';
            infoBox.insertBefore(statusDiv, infoBox.firstChild);
        }
        statusDiv.innerHTML = headerHtml;

        // Выводим данные долгов
        document.getElementById('sale-client-debt').innerText = totalDebt > 0 ? `${totalDebt.toLocaleString('ru-RU')} ₽` : 'Нет долгов 🟢';
        document.getElementById('sale-client-debt').style.color = totalDebt > 0 ? '#e11d48' : '#16a34a';

        const pallets = parseInt(client.pallets_balance) || 0;
        document.getElementById('sale-client-pallets').innerText = pallets > 0 ? `${pallets} шт.` : '0 шт.';
        document.getElementById('sale-client-pallets').style.color = pallets > 0 ? '#d97706' : '#16a34a';

        infoBox.style.display = 'block';
    } catch (e) { console.error('Ошибка загрузки профиля', e); }
};

// === ОТКРЫТИЕ CRM-КАРТОЧКИ КЛИЕНТА ПРЯМО ИЗ ПРОДАЖ ===
window.openClientEditor = async function (id) {
    try {
        const res = await fetch(`/api/counterparties/${id}/profile`);
        const data = await res.json();
        const c = data.info;

        const isDealer = c.price_level === 'dealer';
        const badgeHtml = isDealer
            ? `<div style="background: #ede9fe; color: #8b5cf6; padding: 12px; border-radius: 6px; text-align: center; font-size: 14px; font-weight: bold; margin-bottom: 15px; border: 1px dashed #c4b5fd;">👑 ТЕКУЩИЙ СТАТУС: ДИЛЕР (Оптовые цены)</div>`
            : `<div style="background: #f8fafc; color: #64748b; padding: 12px; border-radius: 6px; text-align: center; font-size: 14px; font-weight: bold; margin-bottom: 15px; border: 1px dashed #cbd5e1;">👤 ТЕКУЩИЙ СТАТУС: БАЗОВЫЙ ПРАЙС (Розница)</div>`;

        const html = `
            <div style="padding: 10px; max-height: 70vh; overflow-y: auto;">
                ${badgeHtml}
                <div class="form-grid" style="grid-template-columns: 1fr 1fr; gap: 15px;">
                    <div class="form-group" style="grid-column: span 2;">
                        <label>Наименование клиента:</label>
                        <input type="text" id="edit-cp-name" class="input-modern" value="${c.name || ''}">
                    </div>
                    
                    <div class="form-group">
                        <label>Уровень цен (Прайс):</label>
                        <select id="edit-cp-level" class="input-modern" style="border-color: #8b5cf6; color: #5b21b6; font-weight: bold;">
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
                    
                    <h4 style="grid-column: span 2; margin: 10px 0 0 0; color: var(--primary); border-bottom: 1px solid #e2e8f0; padding-bottom: 5px;">💳 Реквизиты (Для счетов)</h4>
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

            // Перезагружаем список клиентов и обновляем интерфейс, не сбрасывая выбранного
            const currentId = document.getElementById('sale-client').value;
            await loadSalesData(true);
            if (currentId) {
                document.getElementById('sale-client').value = currentId;
                onClientChange(); // Обновляем розовый блок и цены в поиске
            }
        } else {
            UI.toast('Ошибка при сохранении', 'error');
        }
    } catch (e) {
        console.error(e);
        UI.toast('Ошибка соединения', 'error');
    }
};

window.printClientAct = function () {
    const cpId = document.getElementById('sale-client').value;
    if (!cpId) return UI.toast('Выберите клиента', 'warning');
    window.open(`/print/act?cp_id=${cpId}`, '_blank');
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

async function loadSalesData(fullLoad = true) {
    try {
        if (fullLoad) {
            // --- 1. БЕЗОПАСНАЯ ЗАГРУЗКА КЛИЕНТОВ ---
            const cpRes = await fetch('/api/counterparties');
            const clients = await cpRes.json();
            const clientSel = document.getElementById('sale-client');

            if (clientSel) {
                clientSel.innerHTML = '<option value="">-- Выберите клиента --</option>';
                clients.forEach(c => {
                    const opt = document.createElement('option');
                    opt.value = c.id;
                    opt.textContent = c.name;
                    // Сохраняем уровень цен (Дилер/Розница)
                    opt.setAttribute('data-level', c.price_level || 'basic');
                    clientSel.appendChild(opt);
                });
            }

            // --- 2. БЕЗОПАСНАЯ ЗАГРУЗКА КАСС/СЧЕТОВ ---
            const accRes = await fetch('/api/accounts');
            const accounts = await accRes.json();
            const accSel = document.getElementById('sale-account');

            if (accSel) {
                accSel.innerHTML = '';
                accounts.forEach(a => {
                    accSel.add(new Option(`${a.name} (${a.balance} ₽)`, a.id));
                });
            }

            // --- 3. БЕЗОПАСНАЯ ЗАГРУЗКА ТОВАРОВ ---
            const prodRes = await fetch('/api/products');
            const products = await prodRes.json();

            // Если объект еще не существует, создаем его
            if (typeof salesProductsInfo === 'undefined') {
                window.salesProductsInfo = {};
            } else {
                salesProductsInfo = {}; // Очищаем старые данные
            }

            products.forEach(p => salesProductsInfo[String(p.id)] = p);
        }

        const invRes = await fetch('/api/inventory');
        const inventory = await invRes.json();
        stockMap = {};

        // Собираем реальные остатки по складам
        const inventoryMap = {};
        inventory.forEach(row => {
            if (!inventoryMap[row.item_name]) inventoryMap[row.item_name] = { '4': 0, '5': 0 };
            if (row.warehouse_id === 4 || row.warehouse_id === 5) {
                inventoryMap[row.item_name][row.warehouse_id] = parseFloat(row.total);
            }
        });

        const datalist = document.getElementById('sale-products-datalist');
        datalist.innerHTML = '';

        // УМНОЕ ФОРМИРОВАНИЕ СПИСКА ПОИСКА
        Object.values(salesProductsInfo).forEach(p => {
            const price = parseFloat(p.price || p.current_price || p.base_price || 0);

            // 🚀 ИСПРАВЛЕНИЕ: Читаем дилерскую цену из базы
            const dealerPrice = parseFloat(p.dealer_price || 0);

            const stock4 = inventoryMap[p.name] ? inventoryMap[p.name]['4'] : 0;
            const stock5 = inventoryMap[p.name] ? inventoryMap[p.name]['5'] : 0;

            if (currentSalesWarehouse === 'all') {
                // РЕЖИМ 1: Весь справочник (Добавили dealer_price)
                stockMap[p.name] = { id: p.id, warehouseId: 4, name: p.name, unit: p.unit, qty: stock4, price: price, dealer_price: dealerPrice, weight: parseFloat(p.weight_kg || 0), sortLabel: 'Авто', allowProduction: true };
            } else if (currentSalesWarehouse === '4' && stock4 > 0) {
                // РЕЖИМ 2: Строго наличие 1 сорта (Добавили dealer_price)
                stockMap[p.name] = { id: p.id, warehouseId: 4, name: p.name, unit: p.unit, qty: stock4, price: price, dealer_price: dealerPrice, weight: parseFloat(p.weight_kg || 0), sortLabel: '1 сорт', allowProduction: false };
            } else if (currentSalesWarehouse === '5' && stock5 > 0) {
                // РЕЖИМ 3: Строго наличие Уценки
                stockMap[p.name] = { id: p.id, warehouseId: 5, name: p.name, unit: p.unit, qty: stock5, price: Math.floor(price * 0.7), dealer_price: Math.floor(dealerPrice * 0.7), weight: parseFloat(p.weight_kg || 0), sortLabel: 'Уценка', allowProduction: false };
            }
        });

        // 🚀 ВЫЗЫВАЕМ НОВУЮ ФУНКЦИЮ ОТРИСОВКИ
        updateDatalistUI();

    } catch (e) { console.error(e); }
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
    cart[index][field] = parseFloat(value) || 0;
    renderCart();
};

window.renderCart = function () {
    const tbody = document.getElementById('cart-table');
    if (cart.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 20px;">Корзина пуста</td></tr>';
        document.getElementById('cart-total-sum').innerText = '0';
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
            <tr style="border-bottom: 1px solid #f1f5f9;">
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
                <td style="text-align: center;"><button style="background: none; border: none; color: red; cursor: pointer; font-size: 16px;" onclick="removeFromCart(${index})">✖</button></td>
            </tr>
        `;
    }).join('');

    const globalDiscount = parseFloat(document.getElementById('sale-discount').value) || 0;
    const logistics = parseFloat(document.getElementById('sale-logistics-cost').value) || 0;
    const finalTotal = (subtotal * (1 - globalDiscount / 100)) + logistics;

    document.getElementById('cart-total-weight').innerText = totalWeight.toFixed(1);
    document.getElementById('cart-total-sum').innerText = finalTotal.toLocaleString('ru-RU');
};

// === ОФОРМЛЕНИЕ ЗАКАЗА (ОТПРАВКА НА СЕРВЕР) ===
window.processCheckout = async function () {
    if (cart.length === 0) return UI.toast('Корзина пуста', 'error');

    const client_id = document.getElementById('sale-client').value;
    if (!client_id) return UI.toast('Выберите контрагента', 'error');

    const payment_method = document.getElementById('sale-payment-method').value;
    const account_id = document.getElementById('sale-account') ? document.getElementById('sale-account').value : null;
    const advance_amount = document.getElementById('sale-advance-amount') ? document.getElementById('sale-advance-amount').value : 0;

    // Собираем остальные поля формы
    const discount = parseFloat(document.getElementById('sale-discount').value) || 0; // Глобальная скидка на весь чек
    const logistics_cost = parseFloat(document.getElementById('sale-logistics-cost').value) || 0;
    const delivery_address = document.getElementById('sale-delivery-address').value;
    const planned_shipment_date = document.getElementById('sale-planned-date').value;
    const pallets_qty = parseInt(document.getElementById('sale-pallets').value) || 0;
    const driver = document.getElementById('sale-driver').value;
    const auto = document.getElementById('sale-auto').value;

    // Получаем инфо о договоре (если он выбран)
    const contractSelect = document.getElementById('sale-contract');
    const contract_info = contractSelect && contractSelect.value ? contractSelect.options[contractSelect.selectedIndex].text : '';

    // === 🚀 ВОТ ТОТ САМЫЙ БЛОК: ПЕРЕСЧЕТ ЦЕН ПЕРЕД ОТПРАВКОЙ ===
    // Мы берем нашу корзину (cart) и создаем новый массив, где цена уже уменьшена на % индивидуальной скидки
    const finalItemsToSend = cart.map(item => ({
        id: item.id,
        qty: item.qty,
        allow_production: item.allow_production,
        warehouse_id: item.warehouse_id,
        // Формула: Цена * (1 - Скидка / 100)
        price: Number((parseFloat(item.price) * (1 - (parseFloat(item.discount) || 0) / 100)).toFixed(2))
    }));
    // ==============================================================

    const btn = document.querySelector('button[onclick="processCheckout()"]');
    const originalText = btn.innerText;
    btn.disabled = true;
    btn.innerText = '⏳ Оформление...';

    try {
        const res = await fetch('/api/sales/checkout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                counterparty_id: client_id,
                items: finalItemsToSend, // <-- Передаем наш пересчитанный массив!
                payment_method,
                account_id,
                advance_amount,
                discount, // Это общая скидка на весь чек (если есть)
                driver,
                auto,
                contract_info,
                delivery_address,
                logistics_cost,
                planned_shipment_date,
                pallets_qty
            })
        });

        if (res.ok) {
            const result = await res.json();
            UI.toast(`✅ Заказ ${result.docNum} успешно оформлен!`, 'success');

            // Очищаем форму после успеха
            cart = [];
            document.getElementById('sale-product-input').value = '';
            document.getElementById('sale-qty').value = '';
            document.getElementById('sale-price').value = '';
            document.getElementById('sale-discount').value = '';
            document.getElementById('sale-logistics-cost').value = '0';
            document.getElementById('sale-pallets').value = '';

            renderCart();
            if (typeof loadActiveOrders === 'function') loadActiveOrders();
            switchSalesTab('tab-active-orders', document.querySelectorAll('.sales-tab-btn')[1]);

            if (typeof onClientChange === 'function') onClientChange();

            // Если нужно, предлагаем сразу распечатать счет
            if (payment_method === 'debt' || payment_method === 'partial') {
                setTimeout(() => openInvoiceModal(result.docNum, result.totalAmount), 1000);
            }
        } else {
            const err = await res.text();
            UI.toast('Ошибка сервера: ' + err, 'error');
        }
    } catch (e) {
        console.error(e);
        UI.toast('Ошибка сети при оформлении заказа', 'error');
    } finally {
        btn.disabled = false;
        btn.innerText = originalText;
    }
};

// ==========================================
// === УПРАВЛЕНИЕ ЗАКАЗАМИ (OMS - КАНБАН ДОСКА) ===
// ==========================================
async function loadActiveOrders() {
    try {
        const res = await fetch('/api/sales/orders');
        if (res.ok) {
            allActiveOrders = await res.json();
            populateSalesFilters(); // <--- ДОБАВЛЕНО
            renderBlankOrdersTable();
        }
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

    if (paginated.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 20px;">Нет активных заказов</td></tr>';
        return;
    }

    tbody.innerHTML = paginated.map(o => {
        // --- 1. СТАТУС ОТГРУЗКИ ---
        const ordered = parseFloat(o.total_ordered) || 0;
        const shipped = parseFloat(o.total_shipped) || 0;
        let statusBadge = shipped > 0 && shipped < ordered
            ? `<span style="background: #e0f2fe; padding: 4px 8px; border-radius: 6px; font-size: 11px; font-weight: bold; color: #0284c7; border: 1px solid #bae6fd;">🔵 Отгружается (${Math.round((shipped / ordered) * 100)}%)</span>`
            : `<span style="background: #fef08a; padding: 4px 8px; border-radius: 6px; font-size: 11px; font-weight: bold; color: #854d0e; border: 1px solid #fde047;">🟡 В очереди</span>`;

        // --- 2. СТАТУС ОПЛАТЫ ИМЕННО ЭТОГО ЗАКАЗА ---
        const totalAmt = parseFloat(o.total_amount) || 0;
        const paidAmt = parseFloat(o.paid_amount) || 0;
        const debtAmt = parseFloat(o.pending_debt) || 0;
        let finBadge = '';
        if (paidAmt >= totalAmt) {
            finBadge = `<span style="background: #dcfce3; padding: 4px 8px; border-radius: 6px; font-size: 11px; font-weight: bold; color: #166534; border: 1px solid #bbf7d0; display: inline-block; margin-top: 5px;">🟢 Оплачен 100%</span>`;
        } else if (debtAmt > 0) {
            finBadge = `<span style="background: #fee2e2; padding: 4px 8px; border-radius: 6px; font-size: 11px; font-weight: bold; color: #b91c1c; border: 1px solid #fecaca; display: inline-block; margin-top: 5px;">🔴 Долг: ${debtAmt.toLocaleString('ru-RU')} ₽</span>`;
        } else if (paidAmt > 0) {
            finBadge = `<span style="background: #fef3c7; padding: 4px 8px; border-radius: 6px; font-size: 11px; font-weight: bold; color: #b45309; border: 1px solid #fde68a; display: inline-block; margin-top: 5px;">🟡 Аванс: ${paidAmt.toLocaleString('ru-RU')} ₽</span>`;
        } else {
            finBadge = `<span style="background: #f1f5f9; padding: 4px 8px; border-radius: 6px; font-size: 11px; font-weight: bold; color: #64748b; border: 1px solid #e2e8f0; display: inline-block; margin-top: 5px;">⚪ Не оплачен</span>`;
        }

        // --- 3. ОБЩИЙ БАЛАНС КЛИЕНТА (ПО ФАКТУ ОТГРУЗКИ) ---
        const clientBalance = parseFloat(o.client_balance) || 0;
        let clientBalanceBadge = '';
        if (clientBalance > 0) {
            clientBalanceBadge = `<div style="margin-top: 5px; font-size: 11px; color: #059669; font-weight: bold; background: #d1fae5; display: inline-block; padding: 3px 6px; border-radius: 4px; border: 1px solid #34d399;">💰 Переплата (Аванс): +${clientBalance.toLocaleString('ru-RU')} ₽</div>`;
        } else if (clientBalance < 0) {
            clientBalanceBadge = `<div style="margin-top: 5px; font-size: 11px; color: #dc2626; font-weight: bold; background: #fee2e2; display: inline-block; padding: 3px 6px; border-radius: 4px; border: 1px solid #f87171;">📉 Общий долг: ${Math.abs(clientBalance).toLocaleString('ru-RU')} ₽</div>`;
        } else {
            clientBalanceBadge = `<div style="margin-top: 5px; font-size: 11px; color: #475569; font-weight: bold; background: #f1f5f9; display: inline-block; padding: 3px 6px; border-radius: 4px; border: 1px solid #cbd5e1;">⚖️ Взаиморасчеты: 0 ₽</div>`;
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
        <tr style="transition: 0.2s;" onmouseover="this.style.backgroundColor='#f8fafc'" onmouseout="this.style.backgroundColor=''">
            <td style="color: var(--text-muted); font-size: 13px;">
                ${o.date_formatted}<br>
                <span style="color: #d97706; font-weight: bold;">до ${o.deadline || 'Не указан'}</span>
            </td>
            <td>
                <strong style="color: #8b5cf6; font-size: 14px;">${o.doc_number}</strong><br>
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
                    <button class="btn btn-outline" style="padding: 4px 8px; font-size: 12px; color: #0284c7; border-color: #0284c7;" onclick="openInvoiceModal('${o.doc_number}', ${debtAmt > 0 ? debtAmt : totalAmt})" title="Счет на оплату">🖨️ Счет</button>
                    <button class="btn btn-outline" style="padding: 4px 8px; font-size: 12px; color: #8b5cf6; border-color: #8b5cf6;" onclick="openOrderManager(${o.id})">⚙️ Управл.</button>
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
    try {
        const res = await fetch('/api/sales/history');
        if (res.ok) {
            allSalesHistory = await res.json();
            populateSalesFilters(); // <--- ДОБАВЛЕНО
            renderHistoryTable();
        }
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
        <tr style="transition: 0.2s;" onmouseover="this.style.backgroundColor='#f8fafc'" onmouseout="this.style.backgroundColor=''">
            <td style="color: var(--text-muted); font-size: 13px;">${h.date_formatted}</td>
            <td><strong style="color: var(--primary);">${h.doc_num}</strong></td>
            <td><b>${escapeHTML(h.client_name || 'Неизвестный клиент')}</b><br><span style="font-size: 11px; color: var(--text-muted);">${h.payment || ''}</span></td>
            <td style="text-align: center; font-weight: bold;">${parseFloat(h.total_qty).toLocaleString('ru-RU')}</td>
            
            <td style="text-align: right; color: var(--success); font-weight: bold;">${sumText}</td>
            
            <td style="text-align: right; min-width: 250px;">
            <div style="display: flex; justify-content: flex-end; gap: 5px; align-items: center;">
                <button class="btn btn-outline" style="padding: 4px 8px; font-size: 12px; color: #8b5cf6; border-color: #8b5cf6;" onclick="window.open('/print/upd?docNum=${h.doc_num}', '_blank')" title="УПД и Пропуск на выезд">🖨️ УПД + Пропуск</button>
                <button class="btn btn-outline" style="padding: 4px 8px; font-size: 12px; color: #d97706; border-color: #d97706;" onclick="window.open('/print/specification?docNum=${h.doc_num}', '_blank')" title="Спецификация">🖨️ Спец.</button>
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
            <tr style="border-bottom: 1px solid #e2e8f0;">
                <td style="padding: 8px;">
                    <span class="badge" style="background: #f1f5f9; color: #475569; font-size: 11px; margin-right: 8px; font-family: monospace;">${p.article || 'НЕТ АРТИКУЛА'}</span>
                    <b>${p.name}</b> <span style="font-size: 10px; color: gray;">(${p.unit})</span>
                </td>
                <td style="padding: 8px; text-align: center;">
                    <input type="number" class="input-modern price-basic" data-id="${p.id}" value="${p.current_price}" style="width: 90px; text-align: center;">
                </td>
                <td style="padding: 8px; text-align: center;">
                    <input type="number" class="input-modern price-dealer" data-id="${p.id}" value="${p.dealer_price || 0}" style="width: 90px; text-align: center; border-color: #8b5cf6;">
                </td>
            </tr>
        `).join('');

        const html = `
            <style>.modal-content { max-width: 700px !important; }</style>
            <div style="max-height: 60vh; overflow-y: auto; padding-right: 10px;">
                <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                    <thead style="background: #f8fafc; position: sticky; top: 0;">
                        <tr>
                            <th style="padding: 10px; text-align: left;">Товар</th>
                            <th style="padding: 10px; text-align: center; color: var(--text-main);">Основная (Розница)</th>
                            <th style="padding: 10px; text-align: center; color: #8b5cf6;">Дилерская (Опт)</th>
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
                    <label class="btn btn-outline" style="cursor: pointer; border-color: #8b5cf6; color: #8b5cf6; font-size: 12px; padding: 6px 12px;">
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

window.openContractManager = function () {
    const cpId = document.getElementById('sale-client').value;
    const cpName = document.getElementById('sale-client').options[document.getElementById('sale-client').selectedIndex].text;
    if (!cpId) return UI.toast('Сначала выберите клиента!', 'warning');

    const html = `
        <div style="margin-bottom: 20px; padding: 15px; background: #f8fafc; border: 1px solid var(--border); border-radius: 6px;">
            <h4 style="margin: 0 0 10px 0; color: var(--primary);">📄 Новый договор</h4>
            <div class="form-grid" style="grid-template-columns: 1fr 1fr;">
                <div class="form-group"><label>Номер договора:</label><input type="text" id="new-contract-num" class="input-modern" placeholder="Напр: 45-А"></div>
                <div class="form-group"><label>Дата:</label><input type="date" id="new-contract-date" class="input-modern" value="${new Date().toISOString().split('T')[0]}"></div>
            </div>
            <button class="btn btn-blue" onclick="saveNewContract(${cpId})" style="width: 100%; padding: 8px;">➕ Создать договор</button>
        </div>

        <div style="padding: 15px; border: 1px solid var(--border); border-radius: 6px;">
            <h4 style="margin: 0 0 10px 0; color: #d97706;">📎 Новая спецификация (Приложение)</h4>
            <div class="form-group">
                <label>К какому договору:</label>
                <select id="new-spec-contract-id" class="input-modern"></select>
            </div>
            <div class="form-grid" style="grid-template-columns: 1fr 1fr;">
                <div class="form-group"><label>№ Спецификации:</label><input type="text" id="new-spec-num" class="input-modern" placeholder="Напр: 1"></div>
                <div class="form-group"><label>Дата:</label><input type="date" id="new-spec-date" class="input-modern" value="${new Date().toISOString().split('T')[0]}"></div>
            </div>
            <button class="btn btn-outline" onclick="saveNewSpecification()" style="width: 100%; padding: 8px; border-color: #d97706; color: #d97706;">➕ Добавить спецификацию</button>
        </div>
    `;

    UI.showModal(`Договоры: ${cpName}`, html, `<button class="btn btn-outline" onclick="UI.closeModal()">Закрыть</button>`);

    fetch(`/api/counterparties/${cpId}/contracts`).then(r => r.json()).then(data => {
        const sel = document.getElementById('new-spec-contract-id');
        const uniqueContracts = [];
        const map = new Map();
        for (const item of data) {
            if (!map.has(item.contract_id)) { map.set(item.contract_id, true); uniqueContracts.push(item); }
        }
        uniqueContracts.forEach(c => sel.add(new Option(`Договор №${c.contract_number} от ${c.contract_date}`, c.contract_id)));
    });
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
                <tr style="border-bottom: 1px solid #eee;">
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
                <div style="background: #f1f5f9; padding: 12px; border-radius: 6px; margin-bottom: 15px;">
                    <p style="margin: 0 0 5px 0;"><b>Клиент:</b> ${order.client_name}</p>
                    <p style="margin: 0;"><b>Адрес доставки:</b> ${order.delivery_address || 'Самовывоз'}</p>
                </div>
                
                <table style="width: 100%; border-collapse: collapse; margin-bottom: 15px;">
                    <thead style="background: #e0f2fe;">
                        <tr>
                            <th style="padding: 8px; text-align: left;">Продукция</th>
                            <th style="padding: 8px; text-align: center;">Заказано</th>
                            <th style="padding: 8px; text-align: center;">Уже отгружено</th>
                            <th style="padding: 8px; text-align: center; color: var(--primary);">Грузим сейчас</th>
                        </tr>
                    </thead>
                    <tbody>${itemsHtml}</tbody>
                </table>

                <div style="background: #f8fafc; padding: 10px; border-radius: 6px; border: 1px dashed #cbd5e1;">
                    <h4 style="margin: 0 0 10px 0; color: #475569;">Данные для этой отгрузки (Машина)</h4>
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
            <button class="btn btn-blue" onclick="executePartialShipment(${order.id})">🚚 Отгрузить выбранное</button>
        `);

    } catch (e) { console.error(e); UI.toast('Ошибка', 'error'); }
};

window.executePartialShipment = async function (orderId) {
    const inputs = document.querySelectorAll('.ship-qty-input');
    const items_to_ship = [];
    let totalToShip = 0;

    // Собираем то, что менеджер решил отгрузить прямо сейчас
    inputs.forEach(inp => {
        const qty = parseFloat(inp.value) || 0;
        if (qty > 0) {
            items_to_ship.push({
                coi_id: inp.getAttribute('data-coi-id'),
                item_id: inp.getAttribute('data-item-id'),
                qty: qty
            });
            totalToShip += qty;
        }
    });

    if (totalToShip === 0) return UI.toast('Укажите количество для отгрузки!', 'warning');

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

            // Обновляем таблицы
            loadActiveOrders();
            loadSalesHistory();

            if (typeof loadTable === 'function') loadTable(); // Обновляем остатки на складах
            if (typeof onClientChange === 'function') onClientChange();
        } else {
            UI.toast('Ошибка отгрузки: ' + await res.text(), 'error');
        }
    } catch (e) { console.error(e); UI.toast('Ошибка', 'error'); }
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

                <div style="background: #f8fafc; padding: 10px; border-radius: 6px; border: 1px dashed #cbd5e1; margin-bottom: 15px;">
                    <h4 style="margin: 0 0 10px 0; color: #475569;">🧱 Возврат продукции (если есть)</h4>
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
                        <label style="color: #d97706; font-weight: bold;">Возврат поддонов (шт):</label>
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
        <tr style="border-bottom: 1px solid #eee;">
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
        <div style="padding: 10px;">
            <p style="color: var(--text-muted); font-size: 13px; margin-bottom: 20px;">
                Выберите документ для выдачи клиенту (формат PDF).
            </p>

            <div style="display: flex; flex-direction: column; gap: 15px;">
                
                <div style="background: #f8fafc; padding: 12px; border-radius: 6px; border: 1px solid var(--border);">
                    <b style="font-size: 14px;">Прайс-листы</b><br>
                    <span style="font-size: 12px; color: var(--text-muted); margin-bottom: 10px; display: block;">Актуальные цены и ассортимент</span>
                    <div style="display: flex; gap: 10px;">
                        <button class="btn btn-outline" style="flex-grow: 1;" onclick="window.open('/files/price_main.pdf', '_blank')">📄 Основной</button>
                        <button class="btn btn-outline" style="flex-grow: 1; color: #d97706; border-color: #d97706;" onclick="window.open('/files/price_dealer.pdf', '_blank')">📄 Дилерский</button>
                    </div>
                </div>

                <div style="background: #f8fafc; padding: 12px; border-radius: 6px; border: 1px solid var(--border);">
                    <b style="font-size: 14px;">Сертификаты соответствия (ГОСТ)</b><br>
                    <span style="font-size: 12px; color: var(--text-muted); margin-bottom: 10px; display: block;">Нормативные документы на продукцию</span>
                    <div style="display: flex; gap: 10px;">
                        <button class="btn btn-outline" style="flex-grow: 1;" onclick="window.open('/files/cert_tiles.pdf', '_blank')">📜 На плитку</button>
                        <button class="btn btn-outline" style="flex-grow: 1;" onclick="window.open('/files/cert_curbs.pdf', '_blank')">📜 На бордюры</button>
                    </div>
                </div>

                <div style="display: flex; justify-content: space-between; align-items: center; background: #f8fafc; padding: 12px; border-radius: 6px; border: 1px solid var(--border);">
                    <div>
                        <b style="font-size: 14px;">Бланк: Паспорт продукции</b><br>
                        <span style="font-size: 12px; color: var(--text-muted);">Пустой бланк для ручного заполнения</span>
                    </div>
                    <button class="btn btn-outline" onclick="window.open('/files/passport_blank.pdf', '_blank')">📑 Открыть</button>
                </div>

                <div style="background: #e0f2fe; padding: 12px; border-radius: 6px; border: 1px solid #bae6fd;">
                    <b style="font-size: 14px; color: #0284c7;">Карточка предприятия (Реквизиты)</b><br>
                    <span style="font-size: 12px; color: #0369a1; margin-bottom: 10px; display: block;">Выберите банк для генерации:</span>
                    <div style="display: flex; gap: 10px;">
                        <select id="doc-bank-select" class="input-modern" style="flex-grow: 1; border-color: #7dd3fc;">
                            <option value="alfa">Альфа-Банк</option>
                            <option value="tochka">Точка Банк</option>
                        </select>
                        <button class="btn btn-blue" onclick="printCompanyCard()">🏢 Открыть</button>
                    </div>
                </div>
            </div>
        </div>
    `;

    UI.showModal('🖨️ Документы для выдачи', html, `<button class="btn btn-outline" onclick="UI.closeModal()">Закрыть</button>`);
};

window.printCompanyCard = function () {
    const bank = document.getElementById('doc-bank-select').value;
    window.open(`/files/card_${bank}.pdf`, '_blank');
};

// === КОММЕРЧЕСКОЕ ПРЕДЛОЖЕНИЕ (КП) ===
window.generateKP = function () {
    const clientId = document.getElementById('sale-client').value;
    if (!clientId) return UI.toast('Выберите контрагента для выставления КП!', 'warning');
    if (cart.length === 0) return UI.toast('Корзина пуста!', 'warning');

    const discount = document.getElementById('sale-discount').value;
    const logisticsCost = document.getElementById('sale-logistics-cost').value;

    // Создаем невидимую форму для отправки данных корзины на сервер
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = '/print/kp';
    form.target = '_blank'; // Открываем в новой вкладке

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

// === ВЫСТАВЛЕНИЕ СЧЕТА НА ОПЛАТУ (С РЕДАКТИРОВАНИЕМ СУММЫ) ===
window.openInvoiceModal = function (docNum, debtAmt) {
    const html = `
        <div style="padding: 10px;">
            <p style="margin-top: 0; color: #475569; font-size: 13px;">Счет для заказа <b>${docNum}</b>.</p>
            <div class="form-group" style="margin-bottom: 15px;">
                <label style="font-weight: bold; color: var(--primary);">Сумма счета (₽):</label>
                <input type="number" id="invoice-custom-amount" class="input-modern" placeholder="${debtAmt}" step="0.01">
                <span style="font-size: 11px; color: gray;">Оставьте поле пустым, чтобы выставить счет на весь остаток долга.</span>
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
    window.open(`/print/invoice?docNum=${docNum}&bank=${bank}&custom_amount=${customAmt}`, '_blank');
    UI.closeModal();
    setTimeout(() => { if (typeof loadActiveOrders === 'function') loadActiveOrders(); }, 600);
};

// МАГИЯ ВЗАИМОЗАЧЕТА
window.offsetOrderAdvance = function (docNum, amount) {
    UI.showModal('Взаимозачет аванса', `
        <div style="padding: 10px; font-size: 14px; text-align: center;">
            На балансе клиента есть свободные средства.<br>
            Зачесть <b>${amount.toLocaleString('ru-RU')} ₽</b> в счет оплаты заказа <b>${docNum}</b>?
        </div>`, `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-blue" style="background: #059669; border-color: #059669;" onclick="executeOffset('${docNum}', ${amount})">✅ Провести зачет</button>
    `);
};

window.executeOffset = async function (docNum, amount) {
    try {
        await fetch('/api/sales/orders/offset', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ docNum, amount })
        });
        UI.closeModal();
        UI.toast('Взаимозачет успешно проведен!', 'success');
        loadActiveOrders(); // Обновляем доску

        if (typeof onClientChange === 'function') onClientChange();
    } catch (e) { console.error(e); }
};

// === ОТЧЕТ: ДОЛЖНИКИ ПО ТАРЕ (ПОДДОНЫ) ===
window.openPalletsReport = async function () {
    try {
        const res = await fetch('/api/sales/pallets-report');
        const data = await res.json();

        let tbody = data.map(c => `
            <tr style="border-bottom: 1px solid #eee;">
                <td style="padding: 10px;"><b>${c.name}</b></td>
                <td style="padding: 10px; color: var(--text-muted);">${c.phone || 'Нет телефона'}</td>
                <td style="padding: 10px; text-align: right; color: #d97706; font-weight: bold; font-size: 16px;">${c.pallets_balance} шт.</td>
            </tr>
        `).join('');

        if (data.length === 0) tbody = '<tr><td colspan="3" style="text-align: center; padding: 20px; color: gray;">Нет должников по таре 🎉</td></tr>';

        const totalPallets = data.reduce((sum, c) => sum + parseInt(c.pallets_balance), 0);

        const html = `
            <div style="padding: 10px;">
                <div style="background: #fffbeb; padding: 15px; border-radius: 8px; border: 1px solid #fde68a; margin-bottom: 15px; text-align: center;">
                    <span style="color: #b45309; font-size: 14px;">Всего деревянных поддонов зависло у клиентов:</span><br>
                    <strong style="font-size: 26px; color: #d97706;">${totalPallets} шт.</strong>
                </div>
                <table style="width: 100%; border-collapse: collapse;">
                    <thead style="background: #f8fafc; text-align: left;">
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
            <div style="display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #f1f5f9; font-size: 13px;">
                <span><b style="color: #64748b;">${idx + 1}.</b> ${c.name}</span>
                <strong style="color: #0284c7;">${formatSum(c.total_sum)}</strong>
            </div>
        `).join('');

        const html = `
            <style>.modal-content { max-width: 800px !important; }</style>
            <div style="padding: 10px;">
                <div style="background: linear-gradient(135deg, #3b82f6, #8b5cf6); color: white; padding: 25px; border-radius: 12px; text-align: center; margin-bottom: 20px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
                    <div style="font-size: 14px; opacity: 0.9; text-transform: uppercase; letter-spacing: 1px;">Выручка за текущий месяц</div>
                    <div style="font-size: 42px; font-weight: 900; margin-top: 5px;">${formatSum(data.monthRevenue)}</div>
                </div>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
                    <div style="background: #f8fafc; border: 1px solid #e2e8f0; padding: 20px; border-radius: 12px;">
                        <h4 style="margin-top: 0; color: #0f172a; margin-bottom: 20px;">🏆 Топ-5 товаров</h4>
                        ${itemsHtml || '<div style="color: gray; text-align: center;">Нет продаж в этом месяце</div>'}
                    </div>
                    <div style="background: #f8fafc; border: 1px solid #e2e8f0; padding: 20px; border-radius: 12px;">
                        <h4 style="margin-top: 0; color: #0f172a; margin-bottom: 10px;">🥇 Топ-5 клиентов</h4>
                        ${clientsHtml || '<div style="color: gray; text-align: center;">Нет продаж в этом месяце</div>'}
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
            <div style="min-width: 320px; max-width: 320px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 15px; flex-shrink: 0;">
                <h4 style="margin-top: 0; color: #0f172a; border-bottom: 3px solid ${isToday ? '#ef4444' : '#38bdf8'}; padding-bottom: 8px; margin-bottom: 15px;">
                    ${isToday ? '🔥 СЕГОДНЯ' : '📅 ' + date} <span style="font-weight: normal; font-size: 12px; color: gray; float: right;">${grouped[date].length} маш.</span>
                </h4>`;

        grouped[date].forEach(o => {
            const ordered = parseFloat(o.total_ordered) || 0;
            const shipped = parseFloat(o.total_shipped) || 0;
            const percent = ordered > 0 ? Math.round((shipped / ordered) * 100) : 0;

            html += `
                <div style="background: #fff; border: 1px solid #cbd5e1; border-radius: 6px; padding: 12px; margin-bottom: 10px; box-shadow: 0 2px 4px rgba(0,0,0,0.05); cursor: pointer;" onclick="openOrderManager(${o.id})">
                    <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
                        <strong style="color: #8b5cf6;">${o.doc_number}</strong>
                        <span style="font-size: 10px; font-weight: bold; background: ${percent === 100 ? '#dcfce3' : (percent > 0 ? '#e0f2fe' : '#fef08a')}; color: ${percent === 100 ? '#166534' : (percent > 0 ? '#0284c7' : '#854d0e')}; padding: 3px 6px; border-radius: 4px;">Собрано: ${percent}%</span>
                    </div>
                    <div style="font-size: 13px; font-weight: bold; margin-bottom: 5px;">${o.client_name || 'Неизвестно'}</div>
                    <div style="font-size: 11px; color: #64748b; margin-bottom: 8px; background: #f1f5f9; padding: 5px; border-radius: 4px;">📍 ${o.delivery_address || 'Самовывоз со склада'}</div>
                    <div style="font-size: 11px; color: #475569; padding-top: 8px; border-top: 1px dashed #e2e8f0; line-height: 1.5;">📦 ${o.items_list}</div>
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
            <p style="color: #475569; font-size: 13px; margin-top: 0;">Выберите период для выгрузки реестра отгрузок. Файл скачается в формате CSV (Excel), оптимизированном для загрузки в 1С Бухгалтерию.</p>
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

        // Умное определение разделителя
        const delimiter = lines[0].includes(';') ? ';' : ',';

        // Читаем заголовки колонок (ищем, где артикул, а где цена)
        const headers = lines[0].split(delimiter).map(h => h.trim().toUpperCase().replace(/^"|"$/g, ''));

        const articleIdx = headers.findIndex(h => h.includes('АРТИКУЛ'));
        const priceIdx = headers.findIndex(h => h.includes('ЦЕНА') || h.includes('ДИЛЕР'));

        if (articleIdx === -1 || priceIdx === -1) {
            console.error("Найденные колонки:", headers);
            return UI.toast('❌ В первой строке файла обязательно должны быть заголовки "Артикул" и "Цена"', 'error');
        }

        let matchCount = 0;

        // Пропускаем 1-ю строку (заголовки) и читаем данные
        for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split(delimiter).map(c => c.trim().replace(/^"|"$/g, ''));
            if (cols.length <= Math.max(articleIdx, priceIdx)) continue;

            const csvArticle = cols[articleIdx];
            const priceRaw = cols[priceIdx].replace(/\s/g, '').replace(',', '.');
            const price = parseFloat(priceRaw);

            if (csvArticle && !isNaN(price) && price > 0) {
                // Ищем товар в базе СТРОГО ПО АРТИКУЛУ
                const dbItem = Object.values(salesProductsInfo).find(item => item.article === csvArticle);

                if (dbItem) {
                    const input = document.querySelector(`.price-dealer[data-id="${dbItem.id}"]`);
                    if (input) {
                        input.value = price;
                        input.style.backgroundColor = '#dcfce3'; // Зеленая подсветка
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
                                // ВАЖНО: Здесь ищем input базовой цены (.price-basic)
                                const input = document.querySelector(`.price-basic[data-id="${dbItem.id}"]`);
                                if (input) {
                                    input.value = price;
                                    input.style.backgroundColor = '#eff6ff'; // Голубая подсветка для розницы
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

    // Очищаем умный календарь
    const fpEl = document.getElementById('hist-date-filter');
    if (fpEl && fpEl._flatpickr) fpEl._flatpickr.clear();
    historyDateRange = { start: '', end: '' };

    applyHistoryFilters();
};