let salesProductsInfo = {};
let stockMap = {}; 
let currentSelectedItem = null; 
let cart = [];
let currentSalesWarehouse = '4'; 

// Переменные для списков и пагинации
let allBlankOrders = [];
let boPage = 1;
let boSearch = '';

let allSalesHistory = [];
let historyPage = 1;
let historySearch = '';

function initSales() {
    loadSalesData(true);
    loadSalesHistory();
    loadBlankOrders(); 
}

window.changeSaleWarehouse = function () {
    currentSalesWarehouse = document.getElementById('sale-warehouse').value;
    loadSalesData(false); // false = не перезагружаем клиентов, только обновляем список товаров
    document.getElementById('sale-product-input').value = '';
    updateSaleMaxQty(); // Очищаем поля количества и цены
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

        // Группируем данные для красивого отображения
        data.forEach(row => {
            const baseStr = `Договор №${row.contract_number} от ${row.contract_date}`;
            if (row.spec_id) {
                const specStr = `${baseStr} (Спец. №${row.spec_number} от ${row.spec_date})`;
                let opt = new Option(specStr, specStr);
                opt.setAttribute('data-cid', row.contract_id); // Прячем ID договора
                contractSelect.add(opt);
            } else {
                let opt = new Option(baseStr, baseStr);
                opt.setAttribute('data-cid', row.contract_id); // Прячем ID договора
                contractSelect.add(opt);
            }
        });

        contractGroup.style.display = 'block';
    } catch (e) { console.error(e); }
};

window.onClientChange = function() {
    loadClientContracts();
    loadClientPoas();
};

window.loadClientPoas = async function() {
    const cpId = document.getElementById('sale-client').value;
    const poaSelect = document.getElementById('sale-poa');
    
    if (!cpId) {
        poaSelect.innerHTML = '<option value="">-- Выберите клиента --</option>';
        return;
    }

    try {
        const res = await fetch(`/api/counterparties/${cpId}/poas`);
        const data = await res.json();
        
        poaSelect.innerHTML = '<option value="">-- Выберите доверенность --</option>';
        
        data.forEach(poa => {
            const text = `${poa.driver_name} — №${poa.number} (действ. до ${poa.expiry_date})`;
            const val = `№${poa.number} от ${poa.issue_date} (выдана: ${poa.driver_name})`;
            poaSelect.add(new Option(text, val));
        });
    } catch (e) { console.error(e); }
};

window.togglePoaMode = function() {
    const isNoPoa = document.getElementById('sale-no-poa').checked;
    document.getElementById('poa-select-group').style.display = isNoPoa ? 'none' : 'flex';
    document.getElementById('poa-comment-group').style.display = isNoPoa ? 'block' : 'none';
};

window.openPoaManager = function() {
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

window.saveNewPoa = async function(cpId) {
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
        loadClientPoas(); // Обновляем список
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
            products.forEach(p => salesProductsInfo[String(p.id)] = p); // Жестко привязываем к строковому ID
        }

        const invRes = await fetch('/api/inventory');
        const inventory = await invRes.json();

        stockMap = {};
        const datalist = document.getElementById('sale-products-datalist');
        datalist.innerHTML = '';

        // Собираем товары только с выбранного склада (4 или 5)
        inventory.forEach(row => {
            if (String(row.warehouse_id) === currentSalesWarehouse && parseFloat(row.total) > 0) {
                const isDefect = row.warehouse_id === 5;
                const sortLabel = isDefect ? '[2 сорт]' : '[1 сорт]';

                // Ищем инфо о товаре
                const info = salesProductsInfo[String(row.item_id)];

                // Перебираем все возможные варианты названий колонок с ценой
                let price = info ? parseFloat(info.price || info.current_price || info.base_price || 0) : 0;

                // АВТО-СКИДКА 30% на уценку (Склад 5)
                if (isDefect) price = Math.floor(price * 0.7);

                // Используем ЧИСТОЕ название как ключ
                const cleanName = row.item_name;

                stockMap[cleanName] = {
                    id: row.item_id,
                    warehouseId: row.warehouse_id,
                    name: cleanName,
                    unit: row.unit,
                    qty: parseFloat(row.total),
                    price: price,
                    weight: info ? parseFloat(info.weight_kg || info.weight || 0) : 0,
                    sortLabel: sortLabel
                };

                const opt = document.createElement('option');
                opt.value = cleanName; // При клике в поле ввода вставится только "Прямоугольник"
                opt.textContent = `${sortLabel} | Остаток: ${row.total} ${row.unit}`; // Подсказка в списке
                datalist.appendChild(opt);
            }
        });

    } catch (e) { console.error(e); }
}

// АВТО-ПОДТЯГИВАНИЕ ЦЕНЫ ПРИ ВЫБОРЕ ИЗ СПИСКА
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
    document.getElementById('sale-max-qty').innerText = `Доступно: ${currentSelectedItem.qty} ${currentSelectedItem.unit}`;
    document.getElementById('sale-qty').setAttribute('max', currentSelectedItem.qty);
    // Подставляем найденную цену
    document.getElementById('sale-price').value = currentSelectedItem.price;
};

window.togglePaymentAccount = function () {
    const method = document.getElementById('sale-payment-method').value;
    document.getElementById('sale-account-group').style.display = method === 'paid' ? 'block' : 'none';
};

window.addToCart = function () {
    if (!currentSelectedItem) return UI.toast('Выберите товар из списка умного поиска!', 'warning');

    const qty = parseFloat(document.getElementById('sale-qty').value);
    const price = parseFloat(document.getElementById('sale-price').value);

    if (!qty || qty <= 0) return UI.toast('Укажите количество!', 'warning');

    // Защита от перепродажи (проверяем сколько уже лежит в корзине)
    const currentInCart = cart.filter(c => c.id === currentSelectedItem.id && c.warehouseId === currentSelectedItem.warehouseId).reduce((sum, c) => sum + c.qty, 0);
    if (qty + currentInCart > currentSelectedItem.qty) {
        return UI.toast(`Недостаточно на складе! Доступно еще: ${currentSelectedItem.qty - currentInCart}`, 'error');
    }

    cart.push({
        id: currentSelectedItem.id,
        warehouseId: currentSelectedItem.warehouseId,
        sortLabel: currentSelectedItem.sortLabel,
        name: currentSelectedItem.name,
        unit: currentSelectedItem.unit,
        qty: qty,
        price: price,
        weight: currentSelectedItem.weight * qty
    });

    // Очищаем форму для следующего товара
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

// Перерисовка корзины (с учетом новой скидки)
function renderCart() {
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
        return `
            <tr style="border-bottom: 1px solid #eee;">
                <td style="padding: 8px; font-weight: bold; color: ${color}; font-size: 12px;">${c.sortLabel}</td>
                <td style="padding: 8px;">${c.name}</td>
                <td style="padding: 8px; text-align: center;"><b>${c.qty}</b> <span style="font-size:11px;">${c.unit}</span></td>
                <td style="padding: 8px; text-align: right; color: var(--primary);"><b>${sum.toLocaleString('ru-RU')} ₽</b></td>
                <td style="padding: 8px; text-align: center;">
                    <button class="btn btn-outline" style="padding: 2px 6px; font-size: 10px; color: var(--danger); border-color: var(--danger);" onclick="removeFromCart(${index})">❌</button>
                </td>
            </tr>
        `;
    }).join('');

    // Применяем скидку
    const discountPct = parseFloat(document.getElementById('sale-discount').value) || 0;
    const finalSum = totalSum * (1 - (discountPct / 100));

    document.getElementById('cart-total-weight').innerText = totalWeight.toLocaleString('ru-RU');
    document.getElementById('cart-total-sum').innerText = finalSum.toLocaleString('ru-RU');

    // Если есть скидка, показываем зачеркнутую старую цену
    const origSumEl = document.getElementById('cart-original-sum');
    if (discountPct > 0) {
        origSumEl.innerText = totalSum.toLocaleString('ru-RU') + ' ₽';
        origSumEl.style.display = 'inline-block';
    } else {
        origSumEl.style.display = 'none';
    }
}

// Оформление с отправкой доставки
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
    if (method === 'paid' && !accId) return UI.toast('Выберите счет для зачисления денег!', 'warning');

    try {
        const res = await fetch('/api/sales/checkout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                counterparty_id: clientId,
                payment_method: method,
                account_id: accId,
                discount: discount,
                driver: driver,
                auto: auto,
                contract_info: contractInfo,
                poa_info: poaInfo,
                items: cart.map(c => ({ id: c.id, qty: c.qty, price: c.price, warehouse_id: c.warehouseId }))
            })
        });

        if (res.ok) {
            const data = await res.json();
            UI.toast(`✅ Отгрузка ${data.docNum} успешно оформлена!`, 'success');

            // Очищаем всё после продажи
            cart = [];
            document.getElementById('sale-discount').value = '0';
            document.getElementById('sale-driver').value = '';
            document.getElementById('sale-auto').value = '';

            renderCart();
            loadSalesData(false);
            loadSalesHistory();
            if (typeof loadTable === 'function') loadTable();
        } else {
            UI.toast('Ошибка оформления: ' + await res.text(), 'error');
        }
    } catch (e) { console.error(e); UI.toast('Ошибка связи с сервером', 'error'); }
};

// ==========================================
// === ИСТОРИЯ ОТГРУЗОК (С ПАГИНАЦИЕЙ И ПОИСКОМ) ===
// ==========================================
async function loadSalesHistory() {
    try {
        const res = await fetch('/api/sales/history');
        if (!res.ok) throw new Error(await res.text());
        allSalesHistory = await res.json();
        renderHistoryTable();
    } catch (e) {
        console.error(e);
        document.getElementById('sales-history-table').innerHTML = `<tr><td colspan="6" style="text-align: center; color: red; padding: 20px;">❌ Ошибка: ${e.message}</td></tr>`;
    }
}

window.onHistorySearch = function () {
    historySearch = document.getElementById('hist-search').value.toLowerCase();
    historyPage = 1; // При поиске возвращаемся на первую страницу
    renderHistoryTable();
};

window.changeHistoryPage = function (dir) {
    historyPage += dir;
    renderHistoryTable();
};

function renderHistoryTable() {
    const tbody = document.getElementById('sales-history-table');
    if (!tbody) return;

    // 1. Фильтрация (Поиск)
    let filtered = allSalesHistory;
    if (historySearch) {
        filtered = filtered.filter(h =>
            (h.doc_num && h.doc_num.toLowerCase().includes(historySearch)) ||
            (h.client_name && h.client_name.toLowerCase().includes(historySearch))
        );
    }

    // 2. Расчет страниц
    const maxPage = Math.ceil(filtered.length / 5) || 1;
    if (historyPage > maxPage) historyPage = maxPage;
    if (historyPage < 1) historyPage = 1;

    document.getElementById('hist-page-info').innerText = `Страница ${historyPage} из ${maxPage} (Всего: ${filtered.length})`;

    // 3. Обрезка массива (По 5 штук на страницу)
    const start = (historyPage - 1) * 5;
    const paginated = filtered.slice(start, start + 5);

    if (paginated.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 20px;">Отгрузки не найдены</td></tr>';
        return;
    }

    // 4. Отрисовка
    tbody.innerHTML = paginated.map(h => `
        <tr style="transition: 0.2s;" onmouseover="this.style.backgroundColor='#f8fafc'" onmouseout="this.style.backgroundColor=''">
            <td style="color: var(--text-muted); font-size: 13px;">${h.date_formatted}</td>
            <td><strong style="color: var(--primary);">${h.doc_num}</strong></td>
            <td><b>${h.client_name || 'Неизвестный клиент'}</b><br><span style="font-size: 11px; color: var(--text-muted);">${h.payment || ''}</span></td>
            <td style="text-align: center; font-weight: bold;">${parseFloat(h.total_qty).toLocaleString('ru-RU')}</td>
            <td style="text-align: right; color: var(--success); font-weight: bold;">${h.amount ? parseFloat(h.amount).toLocaleString('ru-RU') + ' ₽' : '-'}</td>
            <td style="text-align: right; min-width: 230px;">
                <button class="btn btn-outline" style="padding: 4px 8px; font-size: 12px; margin-right: 5px; color: #d97706; border-color: #d97706;" onclick="window.open('/print/specification?docNum=${h.doc_num}', '_blank')" title="Спецификация">🖨️ Спец.</button>
                <button class="btn btn-outline" style="padding: 4px 8px; font-size: 12px; margin-right: 5px; color: var(--primary); border-color: var(--primary);" onclick="window.open('/print/waybill?docNum=${h.doc_num}', '_blank')" title="Накладная">🖨️ Накладная</button>
                <button class="btn btn-outline" style="color: var(--danger); border-color: var(--danger); padding: 4px 8px; font-size: 12px;" onclick="cancelShipment('${h.doc_num}')" title="Отменить">❌</button>
            </td>
        </tr>
    `).join('');
}

window.cancelShipment = function (docNum) {
    const html = `<p>Отменить накладную <b>${docNum}</b>?<br><small style="color: var(--danger);">Плитка вернется на склады (с учетом сорта), финансы аннулируются.</small></p>`;
    const buttons = `
        <button class="btn btn-outline" onclick="UI.closeModal()">Назад</button>
        <button class="btn btn-red" onclick="executeCancelShipment('${docNum}')">Да, отменить</button>
    `;
    UI.showModal('Отмена отгрузки', html, buttons);
};

window.executeCancelShipment = async function (docNum) {
    try {
        const res = await fetch(`/api/sales/shipment/${docNum}`, { method: 'DELETE' });
        if (res.ok) {
            UI.closeModal();
            UI.toast(`Отгрузка отменена`, 'success');
            loadSalesHistory();
            loadSalesData();
            if (typeof loadTable === 'function') loadTable();
        } else {
            UI.toast('Ошибка отмены: ' + await res.text(), 'error');
        }
    } catch (e) { console.error(e); }
};

// ==========================================
// === МОДУЛЬ: УСТАНОВКА ПРАЙС-ЛИСТА ===
// ==========================================
window.openPriceListModal = async function () {
    try {
        // Получаем свежий список товаров с сервера
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
            // Ищем цену по всем возможным названиям колонок
            const currentPrice = parseFloat(p.price || p.current_price || p.base_price || 0);
            return `
                            <tr style="border-bottom: 1px solid #eee; transition: 0.2s;" onmouseover="this.style.backgroundColor='#f1f5f9'" onmouseout="this.style.backgroundColor=''">
                                <td style="padding: 10px 12px; font-weight: 500;">${p.name}</td>
                                <td style="padding: 10px 12px; text-align: right;">
                                    <input type="number" class="input-modern price-update-input" 
                                           data-id="${p.id}" 
                                           value="${currentPrice}" 
                                           style="width: 120px; text-align: right; font-weight: bold; color: var(--primary); border: 1px solid #cbd5e1;"
                                           onfocus="this.select()">
                                </td>
                            </tr>
                            `;
        }).join('')}
                    </tbody>
                </table>
            </div>
            <p style="font-size: 12px; color: var(--text-muted); margin-top: 10px;">
                * Цены для 2-го сорта (Уценка) будут автоматически рассчитываться со скидкой 30% от этих базовых цен.
            </p>
        `;

        const buttons = `
            <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
            <button class="btn btn-green" onclick="savePriceList()">💾 Сохранить цены</button>
        `;

        UI.showModal('Управление Прайс-листом', html, buttons);
    } catch (e) { console.error(e); UI.toast('Ошибка загрузки товаров', 'error'); }
};

window.savePriceList = async function () {
    const inputs = document.querySelectorAll('.price-update-input');
    const prices = Array.from(inputs).map(inp => ({
        id: inp.getAttribute('data-id'),
        price: parseFloat(inp.value) || 0
    }));

    try {
        const res = await fetch('/api/products/update-prices', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prices })
        });

        if (res.ok) {
            UI.closeModal();
            UI.toast('Прайс-лист успешно обновлен!', 'success');
            // Перезагружаем кэш товаров в продажах, чтобы новые цены начали работать немедленно
            loadSalesData();
        } else {
            UI.toast('Ошибка сохранения прайса: ' + await res.text(), 'error');
        }
    } catch (e) {
        console.error(e);
        UI.toast('Ошибка связи с сервером', 'error');
    }
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

    // Заполняем список договоров для спецификации
    fetch(`/api/counterparties/${cpId}/contracts`).then(r => r.json()).then(data => {
        const sel = document.getElementById('new-spec-contract-id');
        // Оставляем только уникальные договоры (отсекаем дубли от джоина со спецификациями)
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
// === МОДУЛЬ: БЛАНК-ЗАКАЗЫ (РЕЗЕРВЫ) ===
// ==========================================
window.createBlankOrder = async function () {
    const clientId = document.getElementById('sale-client').value;
    if (!clientId) return UI.toast('Выберите контрагента!', 'warning');
    if (!currentSelectedItem) return UI.toast('Выберите товар из списка умного поиска!', 'warning');

    const qty = parseFloat(document.getElementById('sale-qty').value);
    const price = parseFloat(document.getElementById('sale-price').value);

    if (!qty || qty <= 0) return UI.toast('Укажите количество!', 'warning');

    try {
        const res = await fetch('/api/blank-orders', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                counterparty_id: clientId,
                item_id: currentSelectedItem.id,
                item_name: currentSelectedItem.name,
                warehouse_id: currentSelectedItem.warehouseId,
                quantity: qty,
                price: price
            })
        });

        if (res.ok) {
            const data = await res.json();
            UI.toast(`✅ Бланк-заказ ${data.docNum} оформлен!`, 'success');

            // Очищаем форму
            document.getElementById('sale-product-input').value = '';
            currentSelectedItem = null;
            document.getElementById('sale-unit-label').innerText = '';
            document.getElementById('sale-max-qty').innerText = `Остаток: 0`;
            document.getElementById('sale-price').value = 0;

            loadBlankOrders();
        } else {
            UI.toast('Ошибка оформления: ' + await res.text(), 'error');
        }
    } catch (e) { console.error(e); UI.toast('Ошибка связи с сервером', 'error'); }
};

// ==========================================
// === БЛАНКИ ЗАКАЗОВ (С ПАГИНАЦИЕЙ И ПОИСКОМ) ===
// ==========================================
async function loadBlankOrders() {
    try {
        const res = await fetch('/api/blank-orders');
        if (!res.ok) throw new Error(await res.text());
        allBlankOrders = await res.json();
        renderBlankOrdersTable();
    } catch (e) {
        console.error(e);
    }
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

    let filtered = allBlankOrders;
    if (boSearch) {
        filtered = filtered.filter(o =>
            (o.doc_number && o.doc_number.toLowerCase().includes(boSearch)) ||
            (o.client_name && o.client_name.toLowerCase().includes(boSearch)) ||
            (o.item_name && o.item_name.toLowerCase().includes(boSearch))
        );
    }

    const maxPage = Math.ceil(filtered.length / 5) || 1;
    if (boPage > maxPage) boPage = maxPage;
    if (boPage < 1) boPage = 1;

    document.getElementById('bo-page-info').innerText = `Страница ${boPage} из ${maxPage} (Всего: ${filtered.length})`;

    const start = (boPage - 1) * 5;
    const paginated = filtered.slice(start, start + 5);

    if (paginated.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 20px;">Нет открытых бланк-заказов</td></tr>';
        return;
    }

    tbody.innerHTML = paginated.map(o => `
        <tr style="transition: 0.2s;" onmouseover="this.style.backgroundColor='#f8fafc'" onmouseout="this.style.backgroundColor=''">
            <td style="color: var(--text-muted); font-size: 13px;">${o.date_formatted}</td>
            <td><strong style="color: #8b5cf6;">${o.doc_number}</strong></td>
            <td><b>${o.client_name || 'Неизвестный клиент'}</b></td>
            <td>${o.item_name}</td>
            <td style="text-align: center; font-weight: bold;">${parseFloat(o.quantity).toLocaleString('ru-RU')}</td>
            <td style="text-align: right; min-width: 180px;">
                <button class="btn btn-outline" style="padding: 4px 8px; font-size: 12px; margin-right: 5px; color: #8b5cf6; border-color: #8b5cf6;" onclick="window.open('/print/blank-order?id=${o.id}', '_blank')" title="Распечатать">🖨️ Печать</button>
                <button class="btn btn-outline" style="color: var(--danger); border-color: var(--danger); padding: 4px 8px; font-size: 12px;" onclick="confirmDeleteBlankOrder(${o.id}, '${o.doc_number}')" title="Удалить">❌</button>
            </td>
        </tr>
    `).join('');
}

window.confirmDeleteBlankOrder = function (id, docNum) {
    const html = `<p>Удалить Бланк-заказ <b>${docNum}</b>?</p><p style="font-size: 12px; color: var(--text-muted);">Он исчезнет из списка ожидающих отгрузки.</p>`;
    UI.showModal('Удаление заказа', html, `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-red" onclick="executeDeleteBlankOrder(${id})">Удалить</button>
    `);
};

window.executeDeleteBlankOrder = async function (id) {
    try {
        await fetch(`/api/blank-orders/${id}`, { method: 'DELETE' });
        UI.closeModal();
        UI.toast('Бланк-заказ удален', 'success');
        loadBlankOrders();
    } catch (e) { console.error(e); }
};