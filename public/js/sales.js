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

function initSales() {
    // Принудительно читаем реальное значение из интерфейса при старте
    const whSelect = document.getElementById('sale-warehouse');
    if (whSelect) currentSalesWarehouse = whSelect.value;

    loadSalesData(true);
    loadSalesHistory();
    if (typeof loadActiveOrders === 'function') loadActiveOrders();
}

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

    const cpId = document.getElementById('sale-client').value;
    const infoBox = document.getElementById('sale-client-info');

    if (!cpId) {
        infoBox.style.display = 'none';
        return;
    }

    try {
        // Запрашиваем полный профиль клиента (включая неоплаченные счета и поддоны)
        const res = await fetch(`/api/counterparties/${cpId}/profile`);
        if (!res.ok) return;
        const data = await res.json();

        const client = data.info;
        const invoices = data.invoices || [];

        // Считаем сумму неоплаченных счетов
        let totalDebt = 0;
        invoices.forEach(inv => {
            if (inv.status === 'pending') {
                totalDebt += parseFloat(inv.amount);
            }
        });

        // Выводим данные
        document.getElementById('sale-client-debt').innerText = totalDebt > 0 ? `${totalDebt.toLocaleString('ru-RU')} ₽` : 'Нет долгов 🟢';
        document.getElementById('sale-client-debt').style.color = totalDebt > 0 ? '#e11d48' : '#16a34a';

        const pallets = parseInt(client.pallets_balance) || 0;
        document.getElementById('sale-client-pallets').innerText = pallets > 0 ? `${pallets} шт.` : '0 шт.';
        document.getElementById('sale-client-pallets').style.color = pallets > 0 ? '#d97706' : '#16a34a';

        infoBox.style.display = 'block';
    } catch (e) { console.error('Ошибка загрузки профиля', e); }
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
            const cpRes = await fetch('/api/counterparties');
            const clients = await cpRes.json();
            const clientSel = document.getElementById('sale-client');
            clientSel.innerHTML = '<option value="">-- Выберите клиента --</option>';
            clients.forEach(c => clientSel.add(new Option(c.name, c.id)));

            const accRes = await fetch('/api/accounts');
            const accounts = await accRes.json();
            const accSel = document.getElementById('sale-account');
            accSel.innerHTML = '';
            accounts.forEach(a => accSel.add(new Option(`${a.name} (${a.balance} ₽)`, a.id)));

            const prodRes = await fetch('/api/products');
            const products = await prodRes.json();
            salesProductsInfo = {};
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
            const stock4 = inventoryMap[p.name] ? inventoryMap[p.name]['4'] : 0;
            const stock5 = inventoryMap[p.name] ? inventoryMap[p.name]['5'] : 0;

            if (currentSalesWarehouse === 'all') {
                // РЕЖИМ 1: Весь справочник (Автораспределение)
                stockMap[p.name] = { id: p.id, warehouseId: 4, name: p.name, unit: p.unit, qty: stock4, price: price, weight: parseFloat(p.weight_kg || 0), sortLabel: 'Авто', allowProduction: true };
            } else if (currentSalesWarehouse === '4' && stock4 > 0) {
                // РЕЖИМ 2: Строго наличие 1 сорта (Скрываем то, чего нет)
                stockMap[p.name] = { id: p.id, warehouseId: 4, name: p.name, unit: p.unit, qty: stock4, price: price, weight: parseFloat(p.weight_kg || 0), sortLabel: '1 сорт', allowProduction: false };
            } else if (currentSalesWarehouse === '5' && stock5 > 0) {
                // РЕЖИМ 3: Строго наличие Уценки (Скрываем то, чего нет, и даем скидку)
                stockMap[p.name] = { id: p.id, warehouseId: 5, name: p.name, unit: p.unit, qty: stock5, price: Math.floor(price * 0.7), weight: parseFloat(p.weight_kg || 0), sortLabel: 'Уценка', allowProduction: false };
            }
        });

        Object.values(stockMap).forEach(item => {
            const opt = document.createElement('option');
            opt.value = item.name;
            opt.textContent = `В наличии: ${item.qty} ${item.unit} | Цена: ${item.price} ₽`;
            datalist.appendChild(opt);
        });
    } catch (e) { console.error(e); }
}

window.updateSaleMaxQty = function () {
    const inputVal = document.getElementById('sale-product-input').value.trim();
    currentSelectedItem = stockMap[inputVal];

    if (!currentSelectedItem) {
        document.getElementById('sale-unit-label').innerText = '';
        document.getElementById('sale-max-qty').innerText = `Остаток: 0`;
        document.getElementById('sale-price').value = 0;
        return;
    }

    document.getElementById('sale-unit-label').innerText = `(${currentSelectedItem.unit})`;
    document.getElementById('sale-max-qty').innerText = `В наличии: ${currentSelectedItem.qty} ${currentSelectedItem.unit}`;
    document.getElementById('sale-price').value = currentSelectedItem.price;
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
    document.getElementById('sale-price').value = 0;

    renderCart();
};

window.removeFromCart = function (index) {
    cart.splice(index, 1);
    renderCart();
};

window.renderCart = function () {
    const tbody = document.getElementById('cart-table');
    let totalSum = 0; let totalWeight = 0;

    if (cart.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 20px;">Корзина пуста</td></tr>';
        document.getElementById('cart-total-sum').innerText = '0';
        document.getElementById('cart-total-weight').innerText = '0';
        document.getElementById('cart-original-sum').style.display = 'none';
        return;
    }

    tbody.innerHTML = cart.map((c, index) => {
        const sum = c.qty * c.price;
        totalSum += sum; totalWeight += c.weight;
        const color = c.warehouseId === 5 ? '#d97706' : '#16a34a';

        // ВИЗУАЛИЗАЦИЯ ДЕФИЦИТА ДЛЯ МЕНЕДЖЕРА
        let deficitHtml = '';
        if (c.allowProduction && c.qty > c.stockAvailable) {
            const reserved = Math.min(c.qty, c.stockAvailable);
            const prodQty = c.qty - reserved;
            deficitHtml = `<br><span style="font-size: 11px; color: #d97706; font-weight: normal;">(Резерв со склада: ${reserved}, В производство: ${prodQty})</span>`;
        }

        return `
            <tr style="border-bottom: 1px solid #eee;">
                <td style="padding: 8px; font-weight: bold; color: ${color}; font-size: 12px;">${c.sortLabel}</td>
                <td style="padding: 8px;"><b>${c.name}</b>${deficitHtml}</td>
                <td style="padding: 8px; text-align: center;"><b>${c.qty}</b> <span style="font-size:11px;">${c.unit}</span></td>
                <td style="padding: 8px; text-align: right; color: var(--primary);"><b>${sum.toLocaleString('ru-RU')} ₽</b></td>
                <td style="padding: 8px; text-align: center;">
                    <button class="btn btn-outline" style="padding: 2px 6px; font-size: 10px; color: var(--danger); border-color: var(--danger);" onclick="removeFromCart(${index})">❌</button>
                </td>
            </tr>
        `;
    }).join('');

    const discountPct = parseFloat(document.getElementById('sale-discount').value) || 0;
    const logistics = parseFloat(document.getElementById('sale-logistics-cost').value) || 0;
    const sumWithDiscount = totalSum * (1 - (discountPct / 100));
    const finalSum = sumWithDiscount + logistics;

    document.getElementById('cart-total-weight').innerText = totalWeight.toLocaleString('ru-RU');
    document.getElementById('cart-total-sum').innerText = finalSum.toLocaleString('ru-RU');

    const origSumEl = document.getElementById('cart-original-sum');
    if (discountPct > 0) {
        origSumEl.innerText = totalSum.toLocaleString('ru-RU') + ' ₽';
        origSumEl.style.display = 'inline-block';
    } else {
        origSumEl.style.display = 'none';
    }
};

window.processCheckout = async function () {
    let poaInfo = '';
    const clientId = document.getElementById('sale-client').value;
    const method = document.getElementById('sale-payment-method').value;
    const accId = document.getElementById('sale-account').value;
    const discount = document.getElementById('sale-discount').value;
    const driver = document.getElementById('sale-driver').value.trim();
    const auto = document.getElementById('sale-auto').value.trim();
    const contractInfo = document.getElementById('sale-contract') ? document.getElementById('sale-contract').value : 'Основной договор';
    const isNoPoa = document.getElementById('sale-no-poa').checked;

    // НОВЫЕ ПОЛЯ ЛОГИСТИКИ И ЗАКАЗА
    const logisticsCost = parseFloat(document.getElementById('sale-logistics-cost').value) || 0;
    const deliveryAddress = document.getElementById('sale-delivery-address').value.trim();
    const plannedDate = document.getElementById('sale-planned-date').value;
    const palletsQty = parseInt(document.getElementById('sale-pallets').value) || 0;

    let advanceAmount = 0;
    if (method === 'partial') {
        advanceAmount = parseFloat(document.getElementById('sale-advance-amount').value);
        if (!advanceAmount || advanceAmount <= 0) return UI.toast('Укажите корректную сумму аванса!', 'warning');
    }

    if (isNoPoa) {
        const comment = document.getElementById('sale-poa-comment').value.trim();
        if (!comment) return UI.toast('Укажите, кто разрешил отгрузку без доверенности!', 'error');
        poaInfo = `ОТГРУЗКА БЕЗ ДОВЕРЕННОСТИ (Основание: ${comment})`;
    } else {
        const poaSelect = document.getElementById('sale-poa');
        if (!poaSelect.value) return UI.toast('Выберите доверенность или поставьте галочку "Без доверенности"!', 'warning');
        poaInfo = `Доверенность: ${poaSelect.value}`;
    }

    if (!clientId) return UI.toast('Выберите контрагента!', 'warning');
    if (cart.length === 0) return UI.toast('Корзина пуста!', 'warning');
    if ((method === 'paid' || method === 'partial') && !accId) return UI.toast('Выберите счет для зачисления денег!', 'warning');

    try {
        const res = await fetch('/api/sales/checkout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                counterparty_id: clientId,
                payment_method: method,
                account_id: accId,
                advance_amount: advanceAmount,
                discount: discount,
                driver: driver,
                auto: auto,
                contract_info: contractInfo,
                poa_info: poaInfo,
                delivery_address: deliveryAddress,
                logistics_cost: logisticsCost,
                planned_shipment_date: plannedDate,
                pallets_qty: palletsQty,
                // ВОТ ЗДЕСЬ ДОБАВЛЕН allow_production:
                items: cart.map(c => ({
                    id: c.id,
                    qty: c.qty,
                    price: c.price,
                    warehouse_id: c.warehouseId,
                    allow_production: c.allowProduction
                }))
            })
        });

        if (res.ok) {
            const data = await res.json();
            const msg = data.type === 'reserve' ? `📦 Заказ ${data.docNum} успешно оформлен!` : `✅ Отгрузка ${data.docNum} успешно завершена!`;
            UI.toast(msg, 'success');

            // Полная очистка формы
            cart = [];
            document.getElementById('sale-discount').value = '0';
            document.getElementById('sale-logistics-cost').value = '0';
            document.getElementById('sale-delivery-address').value = '';
            document.getElementById('sale-planned-date').value = '';
            document.getElementById('sale-pallets').value = '';
            document.getElementById('sale-driver').value = '';
            document.getElementById('sale-auto').value = '';
            if (document.getElementById('sale-advance-amount')) document.getElementById('sale-advance-amount').value = '';

            renderCart();
            loadSalesData(false);
            loadSalesHistory();
            if (typeof loadActiveOrders === 'function') loadActiveOrders();
            if (typeof loadTable === 'function') loadTable();
            onClientChange();
        } else {
            UI.toast('Ошибка оформления: ' + await res.text(), 'error');
        }
    } catch (e) { console.error(e); UI.toast('Ошибка связи с сервером', 'error'); }
};

// ==========================================
// === УПРАВЛЕНИЕ ЗАКАЗАМИ (OMS - КАНБАН ДОСКА) ===
// ==========================================
async function loadActiveOrders() {
    try {
        const res = await fetch('/api/sales/orders');
        if (res.ok) {
            allActiveOrders = await res.json();
            renderBlankOrdersTable();
        }
    } catch (e) { console.error(e); }
}

window.onBlankOrderSearch = function () {
    boSearch = document.getElementById('bo-search').value.toLowerCase();
    boPage = 1;
    renderBlankOrdersTable();
};

window.changeBlankOrderPage = function (dir) {
    boPage += dir;
    renderBlankOrdersTable();
};

function renderBlankOrdersTable() {
    const tbody = document.getElementById('blank-orders-table');
    if (!tbody) return;

    let filtered = allActiveOrders;
    if (boSearch) {
        filtered = filtered.filter(o =>
            (o.doc_number && o.doc_number.toLowerCase().includes(boSearch)) ||
            (o.client_name && o.client_name.toLowerCase().includes(boSearch)) ||
            (o.delivery_address && o.delivery_address.toLowerCase().includes(boSearch))
        );
    }

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
        // Вычисляем процент выполнения заказа
        const ordered = parseFloat(o.total_ordered) || 0;
        const shipped = parseFloat(o.total_shipped) || 0;

        let statusBadge = '';
        if (shipped > 0 && shipped < ordered) {
            const percent = Math.round((shipped / ordered) * 100);
            statusBadge = `<span style="background: #e0f2fe; padding: 4px 8px; border-radius: 6px; font-size: 11px; font-weight: bold; color: #0284c7; border: 1px solid #bae6fd;">🔵 Отгружается (${percent}%)</span>`;
        } else {
            statusBadge = `<span style="background: #fef08a; padding: 4px 8px; border-radius: 6px; font-size: 11px; font-weight: bold; color: #854d0e; border: 1px solid #fde047;">🟡 В очереди</span>`;
        }

        return `
        <tr style="transition: 0.2s;" onmouseover="this.style.backgroundColor='#f8fafc'" onmouseout="this.style.backgroundColor=''">
            <td style="color: var(--text-muted); font-size: 13px;">
                ${o.date_formatted}<br>
                <span style="color: #d97706; font-weight: bold;">до ${o.deadline || 'Не указан'}</span>
            </td>
            <td><strong style="color: #8b5cf6;">${o.doc_number}</strong></td>
            <td><b>${o.client_name || 'Неизвестный клиент'}</b><br><span style="font-size: 11px; color: var(--text-muted);">📍 ${o.delivery_address || 'Самовывоз'}</span></td>
            <td style="font-size: 12px; max-width: 250px;">${o.items_list || 'Пусто'}</td>
            <td style="text-align: center;">
                ${statusBadge}
            </td>
            <td style="text-align: right; min-width: 250px;">
                <div style="display: flex; justify-content: flex-end; gap: 5px; align-items: center;">
                    <button class="btn btn-outline" style="padding: 4px 8px; font-size: 12px; color: #0284c7; border-color: #0284c7;" onclick="openInvoiceModal('${o.doc_number}')" title="Счет на оплату">🖨️ Счет</button>
                    <button class="btn btn-outline" style="padding: 4px 8px; font-size: 12px; color: #8b5cf6; border-color: #8b5cf6;" onclick="openOrderManager(${o.id})">⚙️ Управл.</button>
                    <button class="btn btn-outline" style="padding: 4px 8px; font-size: 12px; color: var(--danger); border-color: var(--danger);" onclick="confirmDeleteOrder(${o.id}, '${o.doc_number}')" title="Отменить и удалить заказ">❌</button>
                </div>
            </td>
        </tr>
        `;
    }).join(''); // <- ВОТ ТА САМАЯ ПОТЕРЯННАЯ СКОБКА
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
            renderHistoryTable();
        }
    } catch (e) { console.error(e); }
}

window.onHistorySearch = function () {
    historySearch = document.getElementById('hist-search').value.toLowerCase();
    historyPage = 1;
    renderHistoryTable();
};

window.changeHistoryPage = function (dir) {
    historyPage += dir;
    renderHistoryTable();
};

function renderHistoryTable() {
    const tbody = document.getElementById('sales-history-table');
    if (!tbody) return;

    let filtered = allSalesHistory;
    if (historySearch) {
        filtered = filtered.filter(h =>
            (h.doc_num && h.doc_num.toLowerCase().includes(historySearch)) ||
            (h.client_name && h.client_name.toLowerCase().includes(historySearch))
        );
    }

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

    tbody.innerHTML = paginated.map(h => `
        <tr style="transition: 0.2s;" onmouseover="this.style.backgroundColor='#f8fafc'" onmouseout="this.style.backgroundColor=''">
            <td style="color: var(--text-muted); font-size: 13px;">${h.date_formatted}</td>
            <td><strong style="color: var(--primary);">${h.doc_num}</strong></td>
            <td><b>${h.client_name || 'Неизвестный клиент'}</b><br><span style="font-size: 11px; color: var(--text-muted);">${h.payment || ''}</span></td>
            <td style="text-align: center; font-weight: bold;">${parseFloat(h.total_qty).toLocaleString('ru-RU')}</td>
            <td style="text-align: right; color: var(--success); font-weight: bold;">${h.amount ? parseFloat(h.amount).toLocaleString('ru-RU') + ' ₽' : '-'}</td>
            <td style="text-align: right; min-width: 250px;">
                <div style="display: flex; justify-content: flex-end; gap: 5px; align-items: center;">
                    <button class="btn btn-outline" style="padding: 4px 8px; font-size: 12px; color: #d97706; border-color: #d97706;" onclick="window.open('/print/specification?docNum=${h.doc_num}', '_blank')" title="Спецификация">🖨️ Спец.</button>
                    <button class="btn btn-outline" style="padding: 4px 8px; font-size: 12px; color: var(--primary); border-color: var(--primary);" onclick="window.open('/print/waybill?docNum=${h.doc_num}', '_blank')" title="Накладная">🖨️ Накладная</button>
                    <button class="btn btn-outline" style="color: var(--danger); border-color: var(--danger); padding: 4px 8px; font-size: 12px;" onclick="cancelShipment('${h.doc_num}')" title="Отменить">❌</button>
                </div>
            </td>
        </tr>
    `).join('');
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
    try {
        const res = await fetch('/api/products');
        const products = await res.json();

        const html = `
            <div style="max-height: 60vh; overflow-y: auto; padding-right: 10px; border: 1px solid var(--border); border-radius: 6px;">
                <table style="width: 100%; border-collapse: collapse; margin: 0;">
                    <thead style="background: #f8fafc; position: sticky; top: 0; box-shadow: 0 2px 4px rgba(0,0,0,0.05);">
                        <tr>
                            <th style="padding: 12px; text-align: left; font-size: 13px; color: var(--text-muted);">Наименование продукции</th>
                            <th style="padding: 12px; text-align: right; width: 160px; font-size: 13px; color: var(--text-muted);">Базовая цена (₽)</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${products.map(p => {
            const currentPrice = parseFloat(p.price || p.current_price || p.base_price || 0);
            return `
                            <tr style="border-bottom: 1px solid #eee; transition: 0.2s;" onmouseover="this.style.backgroundColor='#f1f5f9'" onmouseout="this.style.backgroundColor=''">
                                <td style="padding: 10px 12px; font-weight: 500;">${p.name}</td>
                                <td style="padding: 10px 12px; text-align: right;">
                                    <input type="number" class="input-modern price-update-input" data-id="${p.id}" value="${currentPrice}" style="width: 120px; text-align: right; font-weight: bold; color: var(--primary); border: 1px solid #cbd5e1;" onfocus="this.select()">
                                </td>
                            </tr>
                            `;
        }).join('')}
                    </tbody>
                </table>
            </div>
            <p style="font-size: 12px; color: var(--text-muted); margin-top: 10px;">* Цены для 2-го сорта (Уценка) будут автоматически рассчитываться со скидкой 30% от этих базовых цен.</p>
        `;
        UI.showModal('Управление Прайс-листом', html, `
            <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
            <button class="btn btn-green" onclick="savePriceList()">💾 Сохранить цены</button>
        `);
    } catch (e) { console.error(e); UI.toast('Ошибка загрузки товаров', 'error'); }
};

window.savePriceList = async function () {
    const inputs = document.querySelectorAll('.price-update-input');
    const prices = Array.from(inputs).map(inp => ({ id: inp.getAttribute('data-id'), price: parseFloat(inp.value) || 0 }));
    try {
        const res = await fetch('/api/products/update-prices', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prices })
        });
        if (res.ok) {
            UI.closeModal();
            UI.toast('Прайс-лист успешно обновлен!', 'success');
            loadSalesData();
        } else {
            UI.toast('Ошибка сохранения: ' + await res.text(), 'error');
        }
    } catch (e) { console.error(e); UI.toast('Ошибка связи с сервером', 'error'); }
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

    try {
        const res = await fetch(`/api/sales/orders/${orderId}/ship`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items_to_ship, driver, auto, poa_info })
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
                        <input type="number" id="ret-amount" class="input-modern" value="0">
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

// === ВЫСТАВЛЕНИЕ СЧЕТА НА ОПЛАТУ ===
window.openInvoiceModal = function (docNum) {
    const html = `
        <div style="padding: 10px;">
            <p style="margin-top: 0; color: #475569; font-size: 13px;">Счет будет автоматически сформирован на <b>остаток долга</b> по заказу <b>${docNum}</b></p>
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
    window.open(`/print/invoice?docNum=${docNum}&bank=${bank}`, '_blank');
    UI.closeModal();
};