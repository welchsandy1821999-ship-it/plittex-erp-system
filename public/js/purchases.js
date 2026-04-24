;(function() {
let allPurchaseMaterials = [];
let allCounterparties = [];
let allAccounts = [];
window.activePurchaseDates = [];
let purchaseDatePicker = null;
window.currentEditingPurchaseId = null;

async function loadPurchaseMaterials() {
    try {
        const dataMat = await API.get('/api/items?limit=2000');
        allPurchaseMaterials = dataMat.data || [];

        allCounterparties = await API.get('/api/counterparties');

        const fetchedAccounts = await API.get('/api/accounts');
        allAccounts = fetchedAccounts.filter(acc => acc.type === 'company' || acc.type === 'bank' || acc.type === 'cash' || !acc.type);

        initStaticPurchaseSelects();

        const dateEl = document.getElementById('purchase-date');
        if (dateEl && typeof flatpickr !== 'undefined') {
            window.activePurchaseDates = await API.get('/api/inventory/purchase-dates');

            purchaseDatePicker = flatpickr(dateEl, {
                dateFormat: "Y-m-d", altInput: true, altFormat: "d.m.Y", locale: "ru", defaultDate: new Date(),
                onChange: function (selectedDates, dateStr) {
                    // Умное обновление таблицы
                    const searchInput = document.getElementById('purchase-search-input');
                    if (searchInput && searchInput.value.trim().length > 0) {
                        handlePurchaseSearch(); // Обновляем результаты поиска
                    } else {
                        const dateStr = document.getElementById('purchase-date').value;
                        if (typeof loadDailyPurchases === 'function') loadDailyPurchases(dateStr);
                    }
                },
                onDayCreate: function (dObj, dStr, fp, dayElem) {
                    const year = dayElem.dateObj.getFullYear();
                    const month = String(dayElem.dateObj.getMonth() + 1).padStart(2, '0');
                    const day = String(dayElem.dateObj.getDate()).padStart(2, '0');
                    const dateStr = `${year}-${month}-${day}`;

                    if (window.activePurchaseDates.includes(dateStr)) {
                        dayElem.classList.add('font-bold');
                        dayElem.classList.add('text-primary');
                        dayElem.innerHTML += '<span class="pur-active-date-dot"></span>';
                    }
                }
            });

            if (typeof loadDailyPurchases === 'function') loadDailyPurchases(dateEl.value);
        }

    } catch (e) {
        console.error("Ошибка загрузки данных для закупок:", e);
    }
}

// Умная пересортировка поставщиков: прошлые поставщики материала — наверх
function reorderSuppliers(prevSupplierIds) {
    const supSelect = document.getElementById('purchase-supplier-select');
    if (!supSelect || !supSelect.tomselect) return;

    const ts = supSelect.tomselect;
    const currentValue = ts.getValue();

    ts.clearOptions();

    const prevSet = new Set(prevSupplierIds.map(id => String(id)));
    const sorted = [...allCounterparties].sort((a, b) => {
        const aPrev = prevSet.has(String(a.id)) ? 0 : 1;
        const bPrev = prevSet.has(String(b.id)) ? 0 : 1;
        if (aPrev !== bPrev) return aPrev - bPrev;
        return (a.name || '').localeCompare(b.name || '');
    });

    sorted.forEach(s => {
        const isPrev = prevSet.has(String(s.id));
        const label = s.inn ? `${s.name} (ИНН: ${s.inn})` : s.name;
        ts.addOption({ value: s.id, text: isPrev ? `⭐ ${label}` : label });
    });

    if (currentValue) ts.setValue(currentValue, true);
}

function initStaticPurchaseSelects() {
    const matSelect = document.getElementById('purchase-material-select');
    if (matSelect && !matSelect.tomselect) {
        new TomSelect(matSelect, {
            plugins: ['clear_button'],
            optgroups: [
                {value: 'material', label: '🛢️ Сырье'},
                {value: 'product', label: '📦 Готовая продукция'},
                {value: 'semi_finished', label: '⏳ Полуфабрикаты'}
            ],
            options: allPurchaseMaterials.map(m => ({ value: m.id, text: `${m.name} (${m.unit})`, optgroup: m.item_type || 'material' })),
            optgroupField: 'optgroup',
            labelField: 'text',
            valueField: 'value',
            searchField: ['text'],
            placeholder: "-- Выберите ТМЦ (Сырье или Продукцию) --",
            onChange: async function(value) {
                const mat = allPurchaseMaterials.find(m => m.id == value);
                const price = mat ? parseFloat(mat.current_price || 0) : 0;
                if (price > 0) document.getElementById('purchase-price').value = price;
                calculatePurchaseTotal();

                const informer = document.getElementById('material-informer');
                if (!informer) return;

                if (!value) {
                    informer.classList.add('inv-hidden');
                    reorderSuppliers([]);
                    return;
                }

                informer.classList.remove('inv-hidden');
                informer.innerHTML = '<i>⏳ Загрузка данных...</i>';

                try {
                    const [stats, prevSupplierIds] = await Promise.all([
                        API.get(`/api/inventory/material-stats/${value}`),
                        API.get(`/api/inventory/material-suppliers/${value}`)
                    ]);
                    let html = `<span class="text-main">📊 На складе: <b>${parseFloat(stats.balance).toFixed(2)} ${mat ? mat.unit : ''}</b></span>`;
                    if (stats.lastPrice) {
                        html += `<br><span class="text-muted">💸 Прошлая закупка (${stats.lastDate}): по <b>${parseFloat(stats.lastPrice).toFixed(2)} ₽</b></span>`;
                    } else {
                        html += `<br><span class="text-muted">💸 Ранее не закупалось</span>`;
                    }
                    informer.innerHTML = html;

                    // Умная сортировка поставщиков
                    reorderSuppliers(prevSupplierIds);
                } catch (e) {
                    informer.innerHTML = '<span class="text-danger">❌ Ошибка загрузки данных</span>';
                }
            }
        });
    }

    const supSelect = document.getElementById('purchase-supplier-select');
    if (supSelect && !supSelect.tomselect) {
        new TomSelect(supSelect, {
            plugins: ['clear_button'],
            options: allCounterparties.map(s => ({
                value: s.id,
                text: s.inn ? `${s.name} (ИНН: ${s.inn})` : s.name
            })),
            placeholder: "-- Начните вводить имя или ИНН --"
        });
    }

    const accSelect = document.getElementById('purchase-account-select');
    if (accSelect && !accSelect.tomselect) {
        new TomSelect(accSelect, {
            plugins: ['clear_button'],
            options: allAccounts.map(acc => ({ value: acc.id, text: `${acc.name} (${parseFloat(acc.balance).toFixed(2)} ₽)` })),
            allowEmptyOption: true,
            placeholder: "-- Взаиморасчет (в долг) --"
        });
    }

    const delAccSelect = document.getElementById('purchase-delivery-account');
    if (delAccSelect && !delAccSelect.tomselect) {
        new TomSelect(delAccSelect, {
            plugins: ['clear_button'],
            options: allAccounts.map(acc => ({ value: acc.id, text: `${acc.name} (${parseFloat(acc.balance).toFixed(2)} ₽)` })),
            allowEmptyOption: true,
            placeholder: "-- В ДОЛГ --"
        });
    }

    const delSupSelect = document.getElementById('purchase-delivery-supplier-select');
    if (delSupSelect && !delSupSelect.tomselect) {
        new TomSelect(delSupSelect, {
            plugins: ['clear_button'],
            options: allCounterparties.map(s => ({
                value: s.id,
                text: s.inn ? `${s.name} (ИНН: ${s.inn})` : s.name
            })),
            placeholder: "-- Выберите перевозчика --"
        });
    }
}

window.toggleDeliveryFields = function () {
    const isChecked = document.getElementById('purchase-has-delivery').checked;
    const fields = document.getElementById('delivery-fields');
    fields.classList.toggle('inv-hidden', !isChecked);

    if (!isChecked) {
        document.getElementById('purchase-delivery-cost').value = '';
        const ts = document.getElementById('purchase-delivery-account').tomselect;
        if (ts) ts.clear();
        const supTs = document.getElementById('purchase-delivery-supplier-select').tomselect;
        if (supTs) supTs.clear();
    } else {
        const mainSupplierId = document.getElementById('purchase-supplier-select').value;
        const supTs = document.getElementById('purchase-delivery-supplier-select').tomselect;
        if (supTs && !supTs.getValue() && mainSupplierId) {
            supTs.setValue(mainSupplierId);
        }
    }
};

window.calculatePurchaseTotal = function () {
    const qtyStr = document.getElementById('purchase-qty').value || '';
    const priceStr = document.getElementById('purchase-price').value || '';
    const totalInput = document.getElementById('purchase-total-cost');

    const qty = parseFloat(qtyStr.replace(',', '.')) || 0;
    const price = parseFloat(priceStr.replace(',', '.')) || 0;

    if (totalInput && qty > 0 && price > 0) {
        totalInput.value = (qty * price).toFixed(2);
    } else if (totalInput) {
        totalInput.value = '';
    }
};

window.calculatePriceFromTotal = function () {
    const qtyStr = document.getElementById('purchase-qty').value || '';
    const totalStr = document.getElementById('purchase-total-cost').value || '';
    const priceInput = document.getElementById('purchase-price');

    const qty = parseFloat(qtyStr.replace(',', '.')) || 0;
    const total = parseFloat(totalStr.replace(',', '.')) || 0;

    if (priceInput && qty > 0 && total > 0) {
        priceInput.value = (total / qty).toFixed(2);
    } else if (priceInput) {
        priceInput.value = '';
    }
};

window.submitPurchase = function () {
    const materialId = document.getElementById('purchase-material-select').value;
    const counterparty_id = document.getElementById('purchase-supplier-select').value;
    const account_id = document.getElementById('purchase-account-select').value || null;
    const purchaseDate = document.getElementById('purchase-date').value;

    const quantity = parseFloat(document.getElementById('purchase-qty').value) || 0;
    const pricePerUnit = parseFloat(document.getElementById('purchase-price').value) || 0;

    const totalStr = document.getElementById('purchase-total-cost').value || '';
    const parsedTotal = parseFloat(totalStr.replace(/,/g, '.').replace(/\s/g, ''));
    const totalCost = (!isNaN(parsedTotal) && parsedTotal > 0) ? parsedTotal : (quantity * pricePerUnit);

    // Читаем данные доставки
    const hasDelivery = document.getElementById('purchase-has-delivery').checked;
    const deliveryCost = hasDelivery ? (parseFloat(document.getElementById('purchase-delivery-cost').value) || 0) : 0;
    const deliveryAccountId = hasDelivery ? (document.getElementById('purchase-delivery-account').value || null) : null;
    const deliveryCounterpartyId = hasDelivery ? (document.getElementById('purchase-delivery-supplier-select').value || null) : null;
    const grandTotal = totalCost + deliveryCost;

    const mat = allPurchaseMaterials.find(m => m.id == materialId);
    const sup = allCounterparties.find(s => s.id == counterparty_id);

    if (!mat || quantity <= 0) return UI.toast('Укажите материал и количество больше нуля!', 'warning');
    if (!sup) return UI.toast('Выберите поставщика!', 'warning');
    if (hasDelivery && !deliveryCounterpartyId) return UI.toast('Выберите организацию-перевозчика для доставки!', 'warning');

    const isEditing = !!window.currentEditingPurchaseId;

    const html = `
        <div class="p-10 font-15">
            <div class="text-center font-40 mb-10">${isEditing ? '✏️' : '🛒'}</div>
            <div class="text-center mb-15">
                ${isEditing ? 'Подтверждаете <b>изменение</b> данных закупки?' : `Подтверждаете закупку ${mat.item_type === 'product' ? 'продукции' : 'сырья'}?`}
            </div>
            <div class="pur-modal-details-box">
                <div class="mb-5">📦 Номенклатура: <b class="text-primary">${mat.name}</b></div>
                <div class="mb-5">🏭 Поставщик: <b>${sup.name}</b></div>
                <div class="mb-5">⚖️ Объем: <b>${quantity}</b> (по ${pricePerUnit} ₽)</div>
                <div class="mb-5 pb-10 border-bottom">📅 Дата: <b>${purchaseDate}</b></div>
                
                <div class="flex-between mt-10">
                    <span>За ТМЦ:</span> <b>${Utils.formatMoney(totalCost)}</b>
                </div>
                ${deliveryCost > 0 ? `
                <div class="flex-between mt-5">
                    <span>Доставка:</span> <b>${Utils.formatMoney(deliveryCost)}</b>
                </div>
                ` : ''}
                
                <div class="pur-modal-total-box">
                    <span>Общая себестоимость:</span> <span class="text-primary">${Utils.formatMoney(grandTotal)}</span>
                </div>
            </div>
        </div>
    `;

    const submitFn = isEditing
        ? `executeUpdatePurchase('${window.currentEditingPurchaseId}', '${materialId}', '${counterparty_id}', ${account_id ? `'${account_id}'` : null}, ${quantity}, ${pricePerUnit}, '${purchaseDate}', ${totalCost}, ${deliveryCost}, ${deliveryAccountId ? `'${deliveryAccountId}'` : null}, ${deliveryCounterpartyId ? `'${deliveryCounterpartyId}'` : null})`
        : `executePurchase('${materialId}', '${counterparty_id}', ${account_id ? `'${account_id}'` : null}, ${quantity}, ${pricePerUnit}, '${purchaseDate}', ${totalCost}, ${deliveryCost}, ${deliveryAccountId ? `'${deliveryAccountId}'` : null}, ${deliveryCounterpartyId ? `'${deliveryCounterpartyId}'` : null})`;

    const buttons = `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn ${isEditing ? 'btn-purple' : 'btn-blue'}" onclick="${submitFn}">✅ ${isEditing ? 'Сохранить' : 'Оформить приход'}</button>
    `;

    UI.showModal(isEditing ? 'Редактирование' : 'Подтверждение закупки', html, buttons);
};

window.executePurchase = async function (materialId, counterparty_id, account_id, quantity, pricePerUnit, purchaseDate, totalCost, deliveryCost, deliveryAccountId, deliveryCounterpartyId) {
    UI.closeModal();
    UI.toast('⏳ Оформление закупки...', 'info');

    try {
        await API.post('/api/inventory/purchase', { itemId: materialId, counterparty_id, account_id, quantity, pricePerUnit, purchaseDate, totalCost, deliveryCost, deliveryAccountId, deliveryCounterpartyId });
        UI.toast('✅ Закупка успешно оформлена!', 'success');
window.executeUpdatePurchase = async function (purchaseId, materialId, counterparty_id, account_id, quantity, pricePerUnit, purchaseDate, totalCost, deliveryCost, deliveryAccountId) {
    UI.closeModal();
    UI.toast('⏳ Сохранение изменений...', 'info');

    try {
        await API.put(`/api/inventory/purchase/${purchaseId}`, { itemId: materialId, counterparty_id, account_id, quantity, pricePerUnit, purchaseDate, totalCost, deliveryCost, deliveryAccountId });
        UI.toast('✅ Изменения успешно сохранены!', 'success');
        cancelEditMode();
        if (typeof loadDailyPurchases === 'function') loadDailyPurchases(purchaseDate);
    } catch (e) { console.error(e); }
};

window.editPurchase = async function (id) {
    UI.toast('⏳ Загрузка данных...', 'info');

    try {
        const data = await API.get(`/api/inventory/purchase/${id}`);
        window.currentEditingPurchaseId = id;

        const matSel = document.getElementById('purchase-material-select').tomselect;
        const supSel = document.getElementById('purchase-supplier-select').tomselect;
        const accSel = document.getElementById('purchase-account-select').tomselect;
        const delAccSel = document.getElementById('purchase-delivery-account').tomselect;

        if (matSel) matSel.setValue(data.item_id);
        if (supSel) supSel.setValue(data.supplier_id);
        if (accSel) { data.account_id ? accSel.setValue(data.account_id) : accSel.clear(); }

        document.getElementById('purchase-qty').value = data.quantity;
        document.getElementById('purchase-price').value = data.price;

        // Восстанавливаем доставку
        const hasDeliveryCheckbox = document.getElementById('purchase-has-delivery');
        const deliveryCostInput = document.getElementById('purchase-delivery-cost');
        if (data.delivery_cost && parseFloat(data.delivery_cost) > 0) {
            hasDeliveryCheckbox.checked = true;
            toggleDeliveryFields();
            deliveryCostInput.value = data.delivery_cost;
            if (delAccSel && data.delivery_account_id) delAccSel.setValue(data.delivery_account_id);
        } else {
            hasDeliveryCheckbox.checked = false;
            toggleDeliveryFields();
        }

        if (purchaseDatePicker) purchaseDatePicker.setDate(data.purchase_date);
        calculatePurchaseTotal();

        const btnSubmit = document.getElementById('btn-submit-purchase');
        btnSubmit.innerHTML = '💾 Сохранить изменения';
        btnSubmit.className = 'btn btn-purple w-100';
        document.getElementById('btn-cancel-edit').classList.remove('inv-hidden');

        window.scrollTo({ top: 0, behavior: 'smooth' });
        UI.toast('✏️ Режим редактирования', 'success');
    } catch (e) {
        console.error(e);
        UI.toast('Ошибка загрузки', 'error');
    }
};

window.cancelEditMode = function () {
    window.currentEditingPurchaseId = null;

    const btnSubmit = document.getElementById('btn-submit-purchase');
    btnSubmit.innerHTML = '📥 Оформить приход';
    btnSubmit.className = 'btn btn-blue w-100';
    document.getElementById('btn-cancel-edit').classList.add('inv-hidden');

    document.getElementById('purchase-material-select').tomselect.clear();
    document.getElementById('purchase-supplier-select').tomselect.clear();
    document.getElementById('purchase-account-select').tomselect.clear();
    document.getElementById('purchase-qty').value = '';
    document.getElementById('purchase-price').value = '';
    document.getElementById('purchase-total-cost').value = '';

    document.getElementById('purchase-has-delivery').checked = false;
    toggleDeliveryFields();

    if (purchaseDatePicker) purchaseDatePicker.setDate(new Date());
    UI.toast('Редактирование отменено', 'info');
};

async function loadDailyPurchases(dateStr) {
    const tbody = document.getElementById('daily-purchases-table');
    const tfoot = document.getElementById('daily-purchases-summary');
    if (!tbody || !dateStr) return;

    tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted">Загрузка...</td></tr>';
    if (tfoot) tfoot.classList.add('inv-hidden');

    try {
        const data = await API.get(`/api/inventory/daily-purchases?date=${dateStr}`);

        if (data.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted">В этот день приходов сырья не было.</td></tr>';
            return;
        }

        let totalDailyQty = 0;
        let totalDailyAmount = 0;

        tbody.innerHTML = data.map(p => {
            const safeItem = p.item_name ? p.item_name.replace(/['"]/g, '&quot;') : 'Сырье';
            const safeSupplier = p.supplier_name ? p.supplier_name.replace(/['"]/g, '&quot;') : 'Не указан';

            // p.amount теперь включает доставку, это полная себестоимость партии

            totalDailyQty += parseFloat(p.quantity) || 0;
            totalDailyAmount += parseFloat(p.amount) || 0;

            return `
            <tr id="purchase-row-${p.id}" class="pur-table-row">
                <td><strong>${p.item_name}</strong></td>
                <td>${p.supplier_name || '<i class="text-muted">Не указан</i>'}</td>
                <td class="text-right">${parseFloat(p.quantity).toFixed(2)} <small>${p.unit}</small></td>
                <td class="text-right">${parseFloat(p.price).toFixed(2)} ₽</td>
                <td class="text-right"><strong class="text-danger">${Utils.formatMoney(parseFloat(p.amount))}</strong></td>
                <td class="text-right white-space-nowrap">
                    <button class="btn btn-outline pur-row-btn border-border mr-5" 
                            onclick="printReceipt('${p.id}', '${safeItem}', '${safeSupplier}', ${p.quantity}, '${p.unit}', ${p.price}, ${p.amount})" 
                            title="Распечатать приходный ордер">🖨️</button>
                    <button class="btn btn-outline pur-row-btn text-warning border-warning mr-5" 
                            onclick="editPurchase('${p.id}')" 
                            title="Редактировать закупку">✏️</button>
                    <button class="btn btn-outline pur-row-btn text-danger border-danger" 
                            onclick="deletePurchase('${p.id}', '${safeItem}')" 
                            title="Отменить закупку">❌</button>
                </td>
            </tr>
            `;
        }).join('');

        if (tfoot) {
            tfoot.classList.remove('inv-hidden');
            document.getElementById('daily-total-qty').innerHTML = `${totalDailyQty.toFixed(2)} <small>ед.</small>`;
            document.getElementById('daily-total-amount').innerText = `${Utils.formatMoney(totalDailyAmount)}`;
        }

    } catch (e) {
        console.error(e);
        tbody.innerHTML = '<tr><td colspan="6" class="text-center text-danger">Ошибка загрузки истории</td></tr>';
    }
}

window.deletePurchase = function (id, itemName) {
    const html = `
        <div class="p-15 text-center font-15">
            Точно отменить приход ТМЦ <b>${itemName}</b>?<br><br>
            <span class="text-danger font-13">Товар будет списан со склада, а деньги (включая доставку) вернутся на счет.</span>
        </div>
    `;

    UI.showModal('⚠️ Отмена закупки', html, `
        <button class="btn btn-outline" onclick="UI.closeModal()">Закрыть</button>
        <button class="btn btn-red" onclick="executeDeletePurchase('${id}')">🗑️ Да, отменить</button>
    `);
};

window.executeDeletePurchase = async function (id) {
    UI.closeModal();
    UI.toast('⏳ Отмена закупки...', 'info');

    try {
        await API.delete(`/api/inventory/purchase/${id}`);

        UI.toast('🗑️ Закупка отменена', 'success');
            const dateStr = document.getElementById('purchase-date').value;
            // Умное обновление таблицы
            const searchInput = document.getElementById('purchase-search-input');
            if (searchInput && searchInput.value.trim().length > 0) {
                handlePurchaseSearch(); // Обновляем результаты поиска
            } else {
                const dateStr = document.getElementById('purchase-date').value;
                if (typeof loadDailyPurchases === 'function') loadDailyPurchases(dateStr);
            }

            const matSelect = document.getElementById('purchase-material-select');
            if (matSelect && matSelect.tomselect && matSelect.value) {
                matSelect.tomselect.trigger('change', matSelect.value);
            }
    } catch (e) { console.error(e); }
};

window.openAddSupplierModal = function () {
    const html = `
        <div class="p-10">
            <div class="form-group">
                <label>Название (ИП, ООО или ФИО): <span class="text-danger">*</span></label>
                <input type="text" id="new-sup-name" class="input-modern" placeholder="Например: ООО Стройтех">
            </div>
            <div class="form-group m-0">
                <label>ИНН (необязательно):</label>
                <input type="text" id="new-sup-inn" class="input-modern" placeholder="1234567890">
            </div>
        </div>
    `;

    const buttons = `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-green" onclick="submitNewSupplier()">💾 Сохранить и выбрать</button>
    `;

    UI.showModal('➕ Новый поставщик', html, buttons);
    setTimeout(() => document.getElementById('new-sup-name').focus(), 100);
};

window.submitNewSupplier = async function () {
    const name = document.getElementById('new-sup-name').value.trim();
    const inn = document.getElementById('new-sup-inn').value.trim();

    if (!name) return UI.toast('Введите название поставщика!', 'warning');
    UI.toast('⏳ Сохранение...', 'info');

    try {
        const newSup = await API.post('/api/inventory/quick-supplier', { name, inn });
        allCounterparties.push(newSup);

        const selectEl = document.getElementById('purchase-supplier-select');
        if (selectEl && selectEl.tomselect) {
            const ts = selectEl.tomselect;
            const textLabel = `${newSup.name}${newSup.inn ? ` (ИНН: ${newSup.inn})` : ''}`;
            ts.addOption({ value: newSup.id, text: textLabel });
            ts.setValue(newSup.id);
        }

        UI.closeModal();
        UI.toast('✅ Поставщик добавлен!', 'success');
    } catch (e) { console.error(e); }
};

window.printReceipt = function (id, itemName, supplierName, qty, unit, price, amount) {
    const dateStr = document.getElementById('purchase-date').value;

    const mat = allPurchaseMaterials.find(m => m.name === itemName);
    const itemType = mat ? mat.item_type : 'material';
    let whName = 'Склад сырья (№1)';
    if (itemType === 'product') whName = 'Склад ГП (№3)';
    else if (itemType === 'semi_finished') whName = 'Склад цеха (№2)';

    let printFrame = document.getElementById('receipt-print-frame');
    if (!printFrame) {
        printFrame = document.createElement('iframe');
        printFrame.id = 'receipt-print-frame';
        printFrame.style.position = 'absolute';
        printFrame.style.width = '0';
        printFrame.style.height = '0';
        printFrame.style.border = 'none';
        document.body.appendChild(printFrame);
    }

    const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <title>Приходный ордер №${id}</title>
            <style>
                body { font-family: "Times New Roman", Times, serif; padding: 20px; color: #000; font-size: 14px; }
                h2 { text-align: center; font-size: 20px; margin-bottom: 5px; text-transform: uppercase; }
                .subtitle { text-align: center; margin-bottom: 30px; font-size: 16px; }
                .info-block { margin-bottom: 20px; line-height: 1.5; }
                table { width: 100%; border-collapse: collapse; margin-top: 20px; margin-bottom: 40px; }
                th, td { border: 1px solid #000; padding: 8px 12px; text-align: left; }
                th { background: #f2f2f2; font-weight: bold; text-align: center; }
                .text-right { text-align: right; }
                .text-center { text-align: center; }
                .footer { display: flex; justify-content: space-between; margin-top: 50px; page-break-inside: avoid; }
                .sign-box { width: 45%; }
                .sign-line { border-bottom: 1px solid #000; height: 30px; margin-bottom: 5px; }
                .sign-sub { font-size: 11px; text-align: center; color: #555; }
                
                @media print {
                    @page { margin: 15mm; }
                    body { -webkit-print-color-adjust: exact; padding: 0; }
                }
            </style>
        </head>
        <body>
            <h2>ПРИХОДНЫЙ ОРДЕР № ${id}</h2>
            <div class="subtitle">от ${dateStr.split('-').reverse().join('.')} г.</div>
            
            <div class="info-block">
                <div><strong>Организация:</strong> ООО "Плиттекс"</div>
                <div><strong>Склад назначения:</strong> ${whName}</div>
                <div><strong>Поставщик:</strong> ${supplierName}</div>
            </div>
            
            <table>
                <thead>
                    <tr>
                        <th style="width: 5%;">№</th>
                        <th style="width: 45%;">Наименование ТМЦ</th>
                        <th style="width: 10%;">Ед. изм.</th>
                        <th style="width: 15%;">Количество</th>
                        <th style="width: 10%;">Цена, ₽</th>
                        <th style="width: 15%;">Сумма, ₽</th>
                    </tr>
                </thead>
                <tbody>
                    <tr>
                        <td class="text-center">1</td>
                        <td>${itemName}</td>
                        <td class="text-center">${unit}</td>
                        <td class="text-right">${parseFloat(qty).toFixed(2)}</td>
                        <td class="text-right">${parseFloat(price).toFixed(2)}</td>
                        <td class="text-right"><strong>${Utils.formatMoney(parseFloat(amount)).replace(" ₽","")}</strong></td>
                    </tr>
                </tbody>
            </table>

            <div class="footer">
                <div class="sign-box">
                    <strong>Сдал (Представитель поставщика):</strong>
                    <div class="sign-line"></div>
                    <div class="sign-sub">(Подпись) &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; (Расшифровка)</div>
                </div>
                <div class="sign-box">
                    <strong>Принял (Материально-ответственное лицо):</strong>
                    <div class="sign-line"></div>
                    <div class="sign-sub">(Подпись) &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; (Расшифровка)</div>
                </div>
            </div>
        </body>
        </html>
    `;

    const frameDoc = printFrame.contentWindow.document;
    frameDoc.open();
    frameDoc.write(html);
    frameDoc.close();

    setTimeout(() => {
        printFrame.contentWindow.focus();
        printFrame.contentWindow.print();
    }, 500);
};

// ==========================================
// 6. ГЛОБАЛЬНЫЙ ПОИСК И СОРТИРОВКА (OMNIBOX)
// ==========================================
let purchaseSearchTimer = null;
let currentSearchResults = [];
let currentSort = { field: 'purchase_date', asc: false };

window.handlePurchaseSearch = function () {
    const query = document.getElementById('purchase-search-input').value.trim();
    const dateEl = document.getElementById('purchase-date');

    clearTimeout(purchaseSearchTimer); // Сбрасываем таймер при каждом нажатии

    // Если поиск очистили — возвращаем режим "День"
    if (query.length === 0) {
        document.getElementById('th-date').classList.add('inv-hidden'); // Прячем колонку Дата
        if (dateEl && dateEl.value) loadDailyPurchases(dateEl.value);
        return;
    }

    if (query.length < 2) return; // Ждем минимум 2 символа

    // Ждем 400мс после того, как пользователь перестал печатать (Debounce)
    purchaseSearchTimer = setTimeout(async () => {
        const tbody = document.getElementById('daily-purchases-table');
        const tfoot = document.getElementById('daily-purchases-summary');

        tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted">🔍 Ищем в базе...</td></tr>';
        if (tfoot) tfoot.classList.add('inv-hidden'); // Скрываем итоги за день

        try {
            currentSearchResults = await API.get(`/api/inventory/purchase-search?q=${encodeURIComponent(query)}`);

            document.getElementById('th-date').classList.remove('inv-hidden'); // Показываем колонку Дата
            renderSearchResults();
        } catch (e) {
            console.error(e);
            tbody.innerHTML = '<tr><td colspan="7" class="text-center text-danger">Ошибка поиска</td></tr>';
        }
    }, 400);
};

window.renderSearchResults = function () {
    const tbody = document.getElementById('daily-purchases-table');

    if (currentSearchResults.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted">Ничего не найдено.</td></tr>';
        return;
    }

    tbody.innerHTML = currentSearchResults.map(p => {
        const safeItem = p.item_name ? p.item_name.replace(/['"]/g, '&quot;') : 'Сырье';
        const safeSupplier = p.supplier_name ? p.supplier_name.replace(/['"]/g, '&quot;') : 'Не указан';
        const safeDate = p.purchase_date.split('-').reverse().join('.');

        return `
        <tr id="purchase-row-${p.id}" class="pur-table-row">
            <td><strong>${p.item_name}</strong></td>
            <td>${p.supplier_name || '<i class="text-muted">Не указан</i>'}</td>
            <td class="text-primary font-bold white-space-nowrap">${safeDate}</td>
            <td class="text-right">${parseFloat(p.quantity).toFixed(2)} <small>${p.unit}</small></td>
            <td class="text-right">${parseFloat(p.price).toFixed(2)} ₽</td>
            <td class="text-right"><strong class="text-danger">${Utils.formatMoney(parseFloat(p.amount))}</strong></td>
            <td class="text-right white-space-nowrap">
                <button class="btn btn-outline pur-row-btn border-border mr-5" 
                        onclick="printReceipt('${p.id}', '${safeItem}', '${safeSupplier}', ${p.quantity}, '${p.unit}', ${p.price}, ${p.amount})" title="Распечатать">🖨️</button>
                <button class="btn btn-outline pur-row-btn text-warning border-warning mr-5" 
                        onclick="editPurchase('${p.id}')" title="Редактировать">✏️</button>
                <button class="btn btn-outline pur-row-btn text-danger border-danger" 
                        onclick="deletePurchase('${p.id}', '${safeItem}')" title="Отменить">❌</button>
            </td>
        </tr>
        `;
    }).join('');
};

window.sortSearchResults = function (field) {
    const query = document.getElementById('purchase-search-input').value.trim();
    // Сортируем только если мы в режиме поиска
    if (!query || currentSearchResults.length === 0) return;

    // Меняем направление сортировки
    if (currentSort.field === field) {
        currentSort.asc = !currentSort.asc;
    } else {
        currentSort.field = field;
        currentSort.asc = true;
    }

    currentSearchResults.sort((a, b) => {
        let valA = a[field];
        let valB = b[field];

        if (['quantity', 'price', 'amount'].includes(field)) {
            valA = parseFloat(valA) || 0;
            valB = parseFloat(valB) || 0;
        } else {
            valA = (valA || '').toString().toLowerCase();
            valB = (valB || '').toString().toLowerCase();
        }

        if (valA < valB) return currentSort.asc ? -1 : 1;
        if (valA > valB) return currentSort.asc ? 1 : -1;
        return 0;
    });

    renderSearchResults();
};

    // === ГЛОБАЛЬНЫЙ ЭКСПОРТ ===
    if (typeof loadPurchaseMaterials === 'function') window.loadPurchaseMaterials = loadPurchaseMaterials;
    if (typeof initStaticPurchaseSelects === 'function') window.initStaticPurchaseSelects = initStaticPurchaseSelects;
    if (typeof loadDailyPurchases === 'function') window.loadDailyPurchases = loadDailyPurchases;
})();
