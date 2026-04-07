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
    initStaticSalesSelects();
    loadSalesAccounts();
    loadFinanceTaxPercent();
}

// === ПЕРЕКЛЮЧЕНИЕ ВКЛАДОК ===
window.switchSalesTab = function (tabId, btn) {
    document.querySelectorAll('.sales-tab-content').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.sales-tab-btn').forEach(b => b.classList.remove('active'));
    const tab = document.getElementById(tabId);
    if (tab) tab.classList.add('active');
    if (btn) btn.classList.add('active');

    // Подгружаем данные при переходе на вкладку
    if (tabId === 'tab-active-orders' && typeof loadActiveOrders === 'function') loadActiveOrders();
    if (tabId === 'tab-history' && typeof loadSalesHistory === 'function') loadSalesHistory();
};

// === ЗАГРУЗКА КАСС/БАНКОВ ===
async function loadSalesAccounts() {
    try {
        const res = await fetch('/api/accounts');
        const accounts = await res.json();
        const sel = document.getElementById('sale-account');
        if (!sel) return;
        sel.innerHTML = '<option value="">-- Выберите кассу --</option>';
        accounts.filter(a => a.type !== 'imprest').forEach(a => {
            sel.innerHTML += `<option value="${a.id}">${a.name} (${parseFloat(a.balance || 0).toLocaleString('ru-RU')} ₽)</option>`;
        });
    } catch (e) { console.error('Ошибка загрузки касс:', e); }
}

// === ЗАГРУЗКА НАЛОГОВОЙ СТАВКИ ===
async function loadFinanceTaxPercent() {
    if (window.FINANCE_TAX_PERCENT) return; // Уже установлена из dashboard
    try {
        const res = await fetch('/api/settings/finance');
        if (res.ok) {
            const data = await res.json();
            window.FINANCE_TAX_PERCENT = parseFloat(data.sales_tax) || 6;
        } else {
            window.FINANCE_TAX_PERCENT = 6;
        }
    } catch (e) { window.FINANCE_TAX_PERCENT = 6; }
}

function initStaticSalesSelects() {
    ['sale-warehouse', 'sale-payment-method', 'sale-account', 'bo-client-filter', 'bo-status-filter', 'hist-client-filter'].forEach(id => {
        const el = document.getElementById(id);
        if (el && !el.tomselect) {
            new TomSelect(el, {
                plugins: ['clear_button'],
                allowEmptyOption: true
            });
        }
    });
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
    const productSel = document.getElementById('sale-product-select');
    if (productSel && productSel.tomselect) productSel.tomselect.setValue('', true);
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
            if (!contractSelect.tomselect) {
                new TomSelect(contractSelect, { plugins: ['clear_button'] });
            } else {
                contractSelect.tomselect.sync();
            }
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
        if (infoBox) infoBox.classList.add('sales-hidden');
        if (contractGroup) contractGroup.style.display = 'none';
        return;
    }

    // Комментарий к блоку: Загрузка связанных данных (договоры и доверенности)
    await loadClientContracts(cpId);
    if (typeof loadClientPoas === 'function') await loadClientPoas();

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

        // ЗАГРУЗКА АВАНСА КЛИЕНТА ПЕРЕД ОТРИСОВКОЙ (Для расчета Net Debt)
        let availableAdvance = 0;
        try {
            const balRes = await fetch(`/api/counterparties/${cpId}/balance`);
            if (balRes.ok) {
                const balData = await balRes.json();
                availableAdvance = parseFloat(balData.availableAdvance) || 0;
            }
        } catch (e) { console.error('Ошибка загрузки аванса клиента:', e); }
        window.CLIENT_AVAILABLE_ADVANCE = availableAdvance;

        // Показ блока выбора аванса в счет оплаты
        const offsetGroup = document.getElementById('sale-offset-group');
        const offsetAvailEl = document.getElementById('sale-offset-available');
        if (offsetGroup) {
            if (availableAdvance > 0) {
                offsetGroup.classList.remove('sales-hidden');
                if (offsetAvailEl) offsetAvailEl.innerText = availableAdvance.toLocaleString('ru-RU', { minimumFractionDigits: 2 }) + ' ₽';
            } else {
                offsetGroup.classList.add('sales-hidden');
            }
        }

        // Подсчет общей суммы долгов по документам
        let grossDebt = 0;
        (data.invoices || []).forEach(inv => {
            if (inv.status === 'pending') grossDebt += parseFloat(inv.amount);
        });

        // Подсчет Нетто-Долга
        const netDebt = grossDebt - availableAdvance;
        let debtText = '';
        let debtColor = '';
        
        if (netDebt > 0) {
            debtText = `${netDebt.toLocaleString('ru-RU', {minimumFractionDigits: 2})} ₽`;
            debtColor = 'var(--danger)';
        } else if (netDebt < 0) {
            debtText = `Переплата: ${Math.abs(netDebt).toLocaleString('ru-RU', {minimumFractionDigits: 2})} ₽`;
            debtColor = 'var(--success)';
        } else {
            debtText = 'Нет долгов 🟢';
            debtColor = 'var(--success)';
        }

        // Подстановка дилерской цены
        const priceLevel = client.price_level || 'basic';
        window.CLIENT_PRICE_LEVEL = priceLevel;
        if (typeof updateProductSelectUI === 'function') updateProductSelectUI();

        const badgeHtml = priceLevel === 'dealer'
            ? `<span class="badge bg-info-lt text-info border-info p-5 font-11 font-bold">👑 ДИЛЕР</span>`
            : `<span class="badge bg-surface-alt text-muted border p-5 font-11 font-bold">👤 Розница</span>`;

        // Долг по поддонам
        const pallets = parseInt(client.pallets_balance) || 0;
        const palletsText = pallets > 0 ? `${pallets} шт.` : '0 шт.';
        const palletsColor = pallets > 0 ? 'var(--warning-text)' : 'inherit';

        // Формирование стилизованной карточки
        const headerHtml = `
            <div class="sales-client-card bg-surface border-radius-8 p-15 shadow-sm mb-10 border w-100">
                <div class="flex-between align-start gap-10 mb-10 pb-10 border-bottom dashed flex-wrap" style="border-color: var(--border-color);">
                    <div class="flex-row gap-10 align-start flex-grow-1" style="min-width: 0;">
                        <i class="fas fa-building text-primary font-18 mt-3"></i>
                        <div class="flex-column" style="min-width: 0;">
                            <span class="font-bold font-13 text-primary d-block" style="word-break: break-word; line-height: 1.2;">${client.name}</span>
                            <div class="mt-5">${badgeHtml}</div>
                        </div>
                    </div>
                    <button class="btn btn-outline p-5 px-10 font-11 text-primary bg-surface flex-shrink-0" style="border-color: var(--primary);" onclick="openClientEditor(${cpId})">
                        ⚙️ Карточка
                    </button>
                </div>
                <div class="flex-row justify-between align-start gap-15 flex-wrap mt-10">
                    <div class="client-stat-box flex-grow-1" style="min-width: 100px;">
                        <span class="text-muted font-11 block mb-3">Баланс контрагента:</span>
                        <strong class="font-14 d-block" style="color: ${debtColor}; line-height: 1.2;">${debtText}</strong>
                    </div>
                    <div class="client-stat-box flex-grow-1" style="min-width: 80px;">
                        <span class="text-muted font-11 block mb-3">Долг по поддонам:</span>
                        <strong class="font-14 d-block" style="color: ${palletsColor}; line-height: 1.2;">${palletsText}</strong>
                    </div>
                    <div class="client-stat-box w-100 mt-5">
                        <button class="btn btn-outline btn-sm font-12 w-100" onclick="printClientAct()">🖨️ Акт сверки</button>
                    </div>
                </div>
            </div>
        `;

        if (infoBox) {
            infoBox.innerHTML = headerHtml;
            infoBox.classList.remove('sales-hidden');
        }

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
            ? `<div class="bg-info-lt text-info p-10 border-radius-6 text-center font-14 font-bold mb-15 border-info dashed">👑 ТЕКУЩИЙ СТАТУС: ДИЛЕР (Оптовые цены)</div>`
            : `<div class="bg-surface-hover text-muted p-10 border-radius-6 text-center font-14 font-bold mb-15 border dashed">👤 ТЕКУЩИЙ СТАТУС: БАЗОВЫЙ ПРАЙС (Розница)</div>`;

        const html = `
            <div class="p-10 overflow-auto" style="max-height: 70vh;">
                ${badgeHtml}
                <div class="form-grid gap-15 sales-two-cols">
                    <div class="form-group grid-span-2">
                        <label>Наименование клиента:</label>
                        <input type="tel" id="edit-cp-name" class="input-modern" value="${c.name || ''}">
                    </div>
                    
                    <div class="form-group">
                        <label>Уровень цен (Прайс):</label>
                        <select id="edit-cp-level" class="input-modern text-info font-bold" style="border-color: var(--info);">
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
                    
                    <div class="form-group grid-span-2"><label>Адрес (Юр. / Факт.):</label><input type="text" id="edit-cp-address" class="input-modern" value="${c.legal_address || ''}"></div>
                    <div class="form-group grid-span-2"><label>Директор (ФИО):</label><input type="text" id="edit-cp-director" class="input-modern" value="${c.director_name || ''}"></div>
                    
                    <h4 class="grid-span-2 m-0 mt-10 text-primary border-bottom pb-5">💳 Реквизиты (Для счетов)</h4>
                    <div class="form-group"><label>ОГРН:</label><input type="text" id="edit-cp-ogrn" class="input-modern" value="${c.ogrn || ''}"></div>
                    <div class="form-group"><label>БИК Банка:</label><input type="text" id="edit-cp-bik" class="input-modern" value="${c.bik || ''}"></div>
                    <div class="form-group grid-span-2"><label>Название банка:</label><input type="text" id="edit-cp-bank" class="input-modern" value="${c.bank_name || ''}"></div>
                    <div class="form-group grid-span-2"><label>Расчетный счет:</label><input type="text" id="edit-cp-account" class="input-modern" value="${c.checking_account || ''}"></div>
                </div>
            </div>
        `;

        UI.showModal(`Редактирование: ${c.name}`, html, `
            <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
            <button class="btn btn-blue" onclick="saveClientProfile(${id})">💾 Сохранить изменения</button>
        `);

        setTimeout(() => {
            ['edit-cp-level', 'edit-cp-type'].forEach(id => {
                const el = document.getElementById(id);
                if (el && !el.tomselect) new TomSelect(el, { plugins: ['clear_button'], dropdownParent: 'body' });
            });
        }, 50);
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
        <div class="p-10">
            <p class="m-0 mt-0 text-muted font-13 mb-15">Выберите период для формирования акта сверки.</p>
            <div class="form-grid gap-15 sales-two-cols">
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
window.executePrintAct = function (cpId) {
    const start = document.getElementById('act-start').value;
    const end = document.getElementById('act-end').value;
    if (!start || !end) return UI.toast('Укажите даты', 'error');

    // Отправляем правильный запрос с датами и правильным параметром (cpId)
    window.open(`/print/act?cpId=${cpId}&start=${start}&end=${end}` + (String(`/print/act?cpId=${cpId}&start=${start}&end=${end}`).includes('?') ? '&' : '?') + 'token=' + (localStorage.getItem('token') || ''), '_blank');
    UI.closeModal();
};

window.loadClientPoas = async function () {
    const cpId = document.getElementById('sale-client').value;
    const poaSelect = document.getElementById('sale-poa');
    if (!cpId) { if (poaSelect) poaSelect.innerHTML = '<option value="">-- Выберите клиента --</option>'; return; }
    if (!poaSelect) return;

    try {
        const res = await fetch(`/api/counterparties/${cpId}/poas`);
        const data = await res.json();
        poaSelect.innerHTML = '<option value="">-- Выберите доверенность --</option>';
        data.forEach(poa => poaSelect.add(new Option(`${poa.driver_name} — №${poa.number} (действ. до ${poa.expiry_date})`, `№${poa.number} от ${poa.issue_date} (выдана: ${poa.driver_name})`)));
    } catch (e) { console.error(e); }
};

window.toggleSalePayment = function () {
    const method = document.getElementById('sale-payment-method');
    if (!method) return;
    const methodVal = method.value;
    const accountGroup = document.getElementById('sale-account-group');
    const advanceGroup = document.getElementById('sale-advance-group');
    if (!accountGroup || !advanceGroup) return;

    // Кассу показываем ТОЛЬКО если есть реальная оплата (100% или аванс)
    if (methodVal === 'paid' || methodVal === 'partial') {
        accountGroup.classList.remove('sales-hidden');
    } else {
        accountGroup.classList.add('sales-hidden');
    }

    // Поле ввода аванса показываем ТОЛЬКО при частичной оплате
    if (methodVal === 'partial') {
        advanceGroup.classList.remove('sales-hidden');
    } else {
        advanceGroup.classList.add('sales-hidden');
    }

    // 💳 Применяем умную логику disabled
    if (typeof smartAccountToggle === 'function') smartAccountToggle();
};

// 💳 УМНАЯ ЛОГИКА КАССЫ: hide если зачёт покрывает всю сумму
window.smartAccountToggle = function () {
    const methodEl = document.getElementById('sale-payment-method');
    const accountGroup = document.getElementById('sale-account-group');
    const offsetCheck = document.getElementById('sale-offset-check');
    const offsetAmountEl = document.getElementById('sale-offset-amount');

    if (!methodEl || !accountGroup) return;
    const methodVal = methodEl.value;

    // Если способ оплаты = "В долг" и нет зачёта → касса не нужна
    if (methodVal === 'debt' && !(offsetCheck?.checked)) {
        accountGroup.classList.add('sales-hidden');
        accountGroup.style.opacity = '1';
        accountGroup.style.pointerEvents = 'auto';
        return;
    }

    // Вычисляем "К оплате сейчас" (живые деньги)
    const totalStr = document.getElementById('cart-total-sum')?.innerText || '0';
    const totalSum = parseFloat(totalStr.replace(/[^\d.,]/g, '').replace(',', '.')) || 0;
    const offsetVal = (offsetCheck?.checked && offsetAmountEl) ? (parseFloat(offsetAmountEl.value) || 0) : 0;
    const payNow = totalSum - offsetVal;

    if (offsetCheck?.checked && payNow <= 0.01) {
        // Зачёт полностью покрывает → касса НЕ НУЖНА, полностью скрываем
        accountGroup.classList.add('sales-hidden');
        accountGroup.style.opacity = '1';
        accountGroup.style.pointerEvents = 'auto';
    } else if (methodVal === 'paid' || methodVal === 'partial' || (offsetCheck?.checked && payNow > 0.01)) {
        // Есть живые деньги → касса обязательна
        accountGroup.classList.remove('sales-hidden');
        accountGroup.style.opacity = '1';
        accountGroup.style.pointerEvents = 'auto';
        const lbl = accountGroup.querySelector('label');
        if (lbl) lbl.innerHTML = 'Касса / Банк:';
    } else {
        accountGroup.classList.add('sales-hidden');
    }
};

// 💰 Живой предпросмотр стоимости при добавлении товара
window.updateLivePreview = function () {
    const qty = parseFloat(document.getElementById('sale-qty')?.value) || 0;
    const price = parseFloat(document.getElementById('sale-price')?.value) || 0;
    const costEl = document.getElementById('sale-live-cost');
    if (costEl) {
        const total = qty * price;
        costEl.innerText = total.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + ' ₽';
        costEl.style.color = total > 0 ? 'var(--primary)' : 'var(--text-muted)';
    }
};

// 🚚 Переключатель Доставка / Самовывоз
window.toggleDeliveryType = function () {
    const selected = document.querySelector('input[name="sale-delivery-type"]:checked')?.value;
    const addressGroup = document.getElementById('sale-address-group');
    const costGroup = document.getElementById('sale-logistics-cost-group');
    const costInput = document.getElementById('sale-logistics-cost');

    if (selected === 'pickup') {
        if (addressGroup) addressGroup.style.display = 'none';
        if (costGroup) costGroup.style.display = 'none';
        if (costInput) { costInput.value = '0'; }
        renderCart();
    } else {
        if (addressGroup) addressGroup.style.display = '';
        if (costGroup) costGroup.style.display = '';
    }
};

// 💰 Обработчик чекбокса "Зачесть аванс"
window.onOffsetToggle = function () {
    const check = document.getElementById('sale-offset-check');
    const amountEl = document.getElementById('sale-offset-amount');
    if (!check || !amountEl) return;

    if (check.checked) {
        amountEl.disabled = false;
        const totalStr = document.getElementById('cart-total-sum')?.innerText || '0';
        const totalSum = parseFloat(totalStr.replace(/[^\d.,]/g, '').replace(',', '.')) || 0;
        const maxOffset = Math.min(window.CLIENT_AVAILABLE_ADVANCE, totalSum);
        amountEl.value = maxOffset > 0 ? maxOffset.toFixed(2) : '';
        amountEl.max = maxOffset;
    } else {
        amountEl.disabled = true;
        amountEl.value = '';
    }
    renderCart();
    toggleSalePayment();
};

// 💰 Обработчик изменения суммы зачёта
window.onOffsetAmountChange = function () {
    const amountEl = document.getElementById('sale-offset-amount');
    if (!amountEl) return;
    let val = parseFloat(amountEl.value) || 0;

    const totalStr = document.getElementById('cart-total-sum')?.innerText || '0';
    const totalSum = parseFloat(totalStr.replace(/[^\d.,]/g, '').replace(',', '.')) || 0;
    const maxOffset = Math.min(window.CLIENT_AVAILABLE_ADVANCE, totalSum);

    if (val > maxOffset) {
        val = maxOffset;
        amountEl.value = val.toFixed(2);
        UI.toast(`Максимальная сумма зачёта: ${maxOffset.toFixed(2)} ₽`, 'warning');
    }
    if (val < 0) { val = 0; amountEl.value = '0'; }

    updateOffsetSummary();
    if (typeof smartAccountToggle === 'function') smartAccountToggle();
};

// 💰 Обновление блока "К оплате сейчас"
window.updateOffsetSummary = function () {
    const check = document.getElementById('sale-offset-check');
    const amountEl = document.getElementById('sale-offset-amount');
    const summaryEl = document.getElementById('cart-offset-summary');
    const offsetSumEl = document.getElementById('cart-offset-sum');
    const payNowEl = document.getElementById('cart-pay-now');

    const totalStr = document.getElementById('cart-total-sum')?.innerText || '0';
    const totalSum = parseFloat(totalStr.replace(/[^\d.,]/g, '').replace(',', '.')) || 0;

    if (check?.checked && amountEl && parseFloat(amountEl.value) > 0) {
        const offsetVal = parseFloat(amountEl.value) || 0;
        const payNow = Math.max(0, totalSum - offsetVal);

        if (summaryEl) summaryEl.classList.remove('sales-hidden');
        if (offsetSumEl) offsetSumEl.innerText = offsetVal.toLocaleString('ru-RU', { minimumFractionDigits: 2 });
        if (payNowEl) payNowEl.innerText = payNow.toLocaleString('ru-RU', { minimumFractionDigits: 2 });
    } else {
        if (summaryEl) summaryEl.classList.add('sales-hidden');
    }
};

window.togglePoaMode = function () {
    const isNoPoa = document.getElementById('sale-no-poa')?.checked;
    const poaSelectGroup = document.getElementById('poa-select-group');
    const poaCommentGroup = document.getElementById('poa-comment-group');
    if (!poaSelectGroup || !poaCommentGroup) return;

    if (isNoPoa) {
        poaSelectGroup.classList.add('sales-hidden');
        poaCommentGroup.classList.remove('sales-hidden');
    } else {
        poaSelectGroup.classList.remove('sales-hidden');
        poaCommentGroup.classList.add('sales-hidden');
    }
};

window.openPoaManager = function () {
    const cpId = document.getElementById('sale-client').value;
    if (!cpId) return UI.toast('Сначала выберите клиента!', 'warning');

    const html = `
        <div class="p-15">
            <div class="form-group"><label>ФИО Доверенного лица (Водителя):</label><input type="text" id="new-poa-driver" class="input-modern" placeholder="Иванов И.И."></div>
            <div class="form-group"><label>Номер доверенности:</label><input type="text" id="new-poa-num" class="input-modern" placeholder="Напр: 12-А"></div>
            <div class="form-grid gap-15 sales-two-cols">
                <div class="form-group m-0"><label>Дата выдачи:</label><input type="date" id="new-poa-issue" class="input-modern" value="${new Date().toISOString().split('T')[0]}"></div>
                <div class="form-group m-0"><label>Действительна до:</label><input type="date" id="new-poa-expiry" class="input-modern"></div>
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
    window.open(`/print/contract?id=${cid}` + (String(`/print/contract?id=${cid}`).includes('?') ? '&' : '?') + 'token=' + (localStorage.getItem('token') || ''), '_blank');
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

        // DEBUG: показать какие типы складов пришли из API
        const uniqueTypes = [...new Set(inventory.map(r => r.warehouse_type))];
        console.log('[Sales] Типы складов из API:', uniqueTypes);
        console.log('[Sales] Первые 5 строк inventory:', inventory.slice(0, 5));

        const inventoryMap = {};
        inventory.forEach(row => {
            if (!inventoryMap[row.item_name]) inventoryMap[row.item_name] = { finished: 0, markdown: 0, reserve: 0 };
            // Готовая продукция (1-й сорт) — тип finished
            if (row.warehouse_type === 'finished') {
                inventoryMap[row.item_name].finished = (inventoryMap[row.item_name].finished || 0) + parseFloat(row.total);
            }
            // Уценка — тип markdown
            if (row.warehouse_type === 'markdown') {
                inventoryMap[row.item_name].markdown = (inventoryMap[row.item_name].markdown || 0) + parseFloat(row.total);
            }
            // Резерв — тип reserve
            if (row.warehouse_type === 'reserve') {
                inventoryMap[row.item_name].reserve = (inventoryMap[row.item_name].reserve || 0) + parseFloat(row.total);
            }
        });

        // Кэшируем warehouse IDs для использования при оформлении заказа
        window.WAREHOUSE_IDS = {};
        inventory.forEach(row => {
            if (!window.WAREHOUSE_IDS[row.warehouse_type]) {
                window.WAREHOUSE_IDS[row.warehouse_type] = row.warehouse_id;
            }
        });

        Object.values(salesProductsInfo).forEach(p => {
            const price = parseFloat(p.price || p.current_price || 0);
            const dealerPrice = parseFloat(p.dealer_price || 0);
            const pieceRate = parseFloat(p.piece_rate || 0);

            const stockFinished = inventoryMap[p.name] ? (inventoryMap[p.name].finished || 0) : 0;
            const stockMarkdown = inventoryMap[p.name] ? (inventoryMap[p.name].markdown || 0) : 0;
            const reserved = inventoryMap[p.name] ? (inventoryMap[p.name].reserve || 0) : 0;

            const whFinished = window.WAREHOUSE_IDS['finished'] || 4;
            const whMarkdown = window.WAREHOUSE_IDS['markdown'] || 5;

            if (currentSalesWarehouse === 'all') {
                stockMap[p.name] = { id: p.id, warehouseId: whFinished, name: p.name, unit: p.unit, qty: stockFinished, reserved, price, dealer_price: dealerPrice, piece_rate: pieceRate, weight: parseFloat(p.weight_kg || 0), sortLabel: 'Авто', allowProduction: true };
            } else if (currentSalesWarehouse === '4' && stockFinished > 0) {
                stockMap[p.name] = { id: p.id, warehouseId: whFinished, name: p.name, unit: p.unit, qty: stockFinished, reserved, price, dealer_price: dealerPrice, piece_rate: pieceRate, weight: parseFloat(p.weight_kg || 0), sortLabel: '1 сорт', allowProduction: false };
            } else if (currentSalesWarehouse === '5' && stockMarkdown > 0) {
                stockMap[p.name] = { id: p.id, warehouseId: whMarkdown, name: p.name, unit: p.unit, qty: stockMarkdown, reserved: 0, price: Math.floor(price * 0.7), dealer_price: Math.floor(dealerPrice * 0.7), piece_rate: pieceRate, weight: parseFloat(p.weight_kg || 0), sortLabel: 'Уценка', allowProduction: false };
            }
        });

        updateProductSelectUI();
    } catch (e) { console.error('Ошибка в loadSalesData:', e); }
}

// === ОБНОВЛЕНИЕ TomSelect ПРОДУКЦИИ (замена datalist) ===
window.updateProductSelectUI = function () {
    const selectEl = document.getElementById('sale-product-select');
    if (!selectEl) return;

    // Исключаем зависимость от TomSelect: берем прайс из глобальной переменной,
    // которую мы 100% достоверно обновляем при запросе профиля в onClientChange
    const priceLevel = window.CLIENT_PRICE_LEVEL || 'basic';

    // Формируем опции
    const options = Object.values(stockMap).map(item => {
        let displayPrice = item.price;
        if (priceLevel === 'dealer' && item.dealer_price > 0) displayPrice = item.dealer_price;
        const free = parseFloat(Math.max(0, item.qty - (item.reserved || 0)).toFixed(2));
        const reservedFmt = parseFloat((item.reserved || 0)).toFixed(2);
        const reservedLabel = item.reserved > 0 ? ` | Резерв: ${reservedFmt}` : '';
        return { value: item.name, text: item.name, free: free.toFixed(2), reserved: reservedFmt, price: displayPrice, unit: item.unit, reservedLabel };
    });

    if (!selectEl.tomselect) {
        new TomSelect(selectEl, {
            options: options,
            valueField: 'value',
            labelField: 'text',
            searchField: ['text'],
            maxItems: 1,
            plugins: ['clear_button'],
            placeholder: 'Начните вводить название...',
            render: {
                option: function (data, escape) {
                    return `<div class="ts-option-product">
                        <span class="ts-product-name">${escape(data.text)}</span>
                        <span class="ts-product-meta">Свободно: <b class="sales-stock-free">${data.free}</b>${data.reservedLabel ? ' | Резерв: <b class="sales-stock-reserved">' + data.reserved + '</b>' : ''} | Цена: ${data.price} ₽</span>
                    </div>`;
                },
                item: function (data, escape) {
                    return `<div>${escape(data.text)}</div>`;
                }
            },
            onChange: function (value) {
                updateSaleMaxQty(value);
            }
        });
    } else {
        const ts = selectEl.tomselect;
        const currentVal = ts.getValue();
        ts.clearOptions();
        ts.addOptions(options);
        if (currentVal && stockMap[currentVal]) ts.setValue(currentVal, true);
    }
};
window.updateSaleMaxQty = function (selectedName) {
    const inputVal = selectedName || (document.getElementById('sale-product-select') && document.getElementById('sale-product-select').tomselect ? document.getElementById('sale-product-select').tomselect.getValue() : '');
    currentSelectedItem = stockMap[inputVal];

    const btnCalc = document.getElementById('btn-calc-sales-cost');
    if (btnCalc) {
        if (currentSelectedItem) btnCalc.classList.remove('sales-hidden');
        else btnCalc.classList.add('sales-hidden');
    }

    // 🎯 Показываем/скрываем блок ввода Кол-во, Цена, кнопки
    const specActions = document.getElementById('sale-spec-actions');
    if (specActions) {
        if (currentSelectedItem) {
            specActions.classList.remove('sales-hidden');
        } else {
            specActions.classList.add('sales-hidden');
        }
    }

    if (!currentSelectedItem) {
        document.getElementById('sale-unit-label').innerText = '';
        document.getElementById('sale-max-qty').innerHTML = `Остаток: 0`;
        document.getElementById('sale-price').value = '';
        return;
    }

    document.getElementById('sale-unit-label').innerText = `(${currentSelectedItem.unit})`;

    // === ШАГ 3: Показываем На складе / В резерве / Цену ===
    // qty из finished-склада уже НЕ включает зарезервированный товар (он перемещён на reserve-склад)
    const onStock = currentSelectedItem.qty || 0;
    const reserved = currentSelectedItem.reserved || 0;
    let hintHtml = `На складе: <span class="sales-stock-free">${onStock.toFixed(2)} ${currentSelectedItem.unit}</span>`;
    if (reserved > 0) {
        hintHtml += ` | В резерве: <span class="sales-stock-reserved">${parseFloat(reserved).toFixed(2)} ${currentSelectedItem.unit}</span>`;
    }
    document.getElementById('sale-max-qty').innerHTML = hintHtml;

    // Подстановка дилерской или базовой цены через глобальную переменную
    const priceLevel = window.CLIENT_PRICE_LEVEL || 'basic';

    let finalPrice = parseFloat(currentSelectedItem.price || currentSelectedItem.current_price) || 0;
    if (priceLevel === 'dealer' && currentSelectedItem.dealer_price && parseFloat(currentSelectedItem.dealer_price) > 0) {
        finalPrice = parseFloat(currentSelectedItem.dealer_price);
    }

    document.getElementById('sale-price').value = finalPrice;
    if (typeof updateLivePreview === 'function') updateLivePreview();
};

// ==========================================
// ⚙️ ГЛОБАЛЬНЫЕ ФИНАНСОВЫЕ КОНСТАНТЫ
// ==========================================
window.addToCart = async function () {
    if (!currentSelectedItem) return UI.toast('Выберите товар из списка умного поиска!', 'warning');

    const qty = parseFloat(document.getElementById('sale-qty').value);
    const price = parseFloat(document.getElementById('sale-price').value);

    if (!qty || qty <= 0) return UI.toast('Укажите количество!', 'warning');

    // ЗАЩИТА: Блокировка продажи в минус (если отключено производство)
    if (!currentSelectedItem.allowProduction) {
        const existingQty = cart.filter(c => c.id === currentSelectedItem.id && c.warehouseId === currentSelectedItem.warehouseId).reduce((sum, c) => sum + c.qty, 0);
        if (qty + existingQty > currentSelectedItem.qty) {
            return UI.toast(`На этом складе в наличии только ${currentSelectedItem.qty} ${currentSelectedItem.unit}! Производство отключено.`, 'error');
        }
    }

    // 🚀 ЗАПРАШИВАЕМ ФАКТИЧЕСКУЮ СЕБЕСТОИМОСТЬ ПЕРЕД ДОБАВЛЕНИЕМ
    UI.toast('⏳ Фиксация себестоимости...', 'info');
    const btn = document.querySelector('button[onclick="addToCart()"]');
    if (btn) btn.disabled = true;

    let unitCost = 0;
    try {
        const data = await API.get(`/api/sales/cost-analysis/${currentSelectedItem.id}`);

        const baseMatCost = parseFloat(data.empirical) > 0 ? parseFloat(data.empirical) : parseFloat(data.theoretical);
        const pieceRate = parseFloat(currentSelectedItem.piece_rate) || 0;

        unitCost = baseMatCost + parseFloat(data.amortization) + parseFloat(data.overhead || 0) + pieceRate;
    } catch (e) {
        console.error("Ошибка получения себестоимости", e);
        UI.toast('⚠️ Себестоимость не загружена, расчет маржи будет неточным', 'warning');
    } finally {
        if (btn) btn.disabled = false;
    }

    cart.push({
        id: currentSelectedItem.id,
        warehouseId: currentSelectedItem.warehouseId,
        sortLabel: currentSelectedItem.sortLabel,
        name: currentSelectedItem.name,
        unit: currentSelectedItem.unit,
        qty: qty,
        price: price,
        weight: currentSelectedItem.weight || 0,
        allowProduction: currentSelectedItem.allowProduction,
        stockAvailable: currentSelectedItem.qty,
        unitCost: unitCost
    });

    const productSel = document.getElementById('sale-product-select');
    if (productSel && productSel.tomselect) productSel.tomselect.setValue('', true);
    currentSelectedItem = null;
    document.getElementById('sale-unit-label').innerText = '';
    document.getElementById('sale-max-qty').innerHTML = `Остаток: 0`;
    document.getElementById('sale-price').value = '';
    document.getElementById('sale-qty').value = '';
    // Очистка live preview
    const liveCostEl = document.getElementById('sale-live-cost');
    if (liveCostEl) { liveCostEl.innerText = '0 ₽'; liveCostEl.style.color = 'var(--text-muted)'; }
    // Скрываем блок ввода до выбора нового товара
    const specAct = document.getElementById('sale-spec-actions');
    if (specAct) specAct.classList.add('sales-hidden');
    renderCart();
};

window.renderCart = function () {
    const tbody = document.getElementById('cart-table');

    // БЛОК 1: ЕСЛИ КОРЗИНА ПУСТАЯ
    if (cart.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="sales-empty-cell">Корзина пуста</td></tr>';
        document.getElementById('cart-total-sum').innerText = '0';

        const weightEl = document.getElementById('cart-total-weight');
        if (weightEl) weightEl.innerText = '0';

        // Прячем финансовый контроллер
        const profitInfo = document.getElementById('cart-profit-info');
        if (profitInfo) profitInfo.style.display = 'none';
        const profitSummary = document.getElementById('cart-profit-summary');
        if (profitSummary) profitSummary.classList.add('sales-hidden');

        return;
    }

    let subtotal = 0;
    let totalWeight = 0;
    let totalProductionCost = 0;
    const safeTaxPct = parseFloat(window.FINANCE_TAX_PERCENT) || 0;

    // Структура для попродуктовой разбивки
    const productProfitMap = {};

    // БЛОК 2: ОТРИСОВКА СТРОК ТАБЛИЦЫ
    tbody.innerHTML = cart.map((item, index) => {
        const qty = parseFloat(item.qty) || 0;
        const basePrice = parseFloat(item.price) || 0;
        const discount = parseFloat(item.discount) || 0;
        const unitCost = parseFloat(item.unitCost) || 0;

        const finalPrice = basePrice * (1 - discount / 100);
        const sum = qty * finalPrice;
        const costSum = qty * unitCost;

        // Чистая прибыль по позиции (ПОСЛЕ налога)
        const lineTax = sum * (safeTaxPct / 100);
        const lineNetProfit = sum - costSum - lineTax;

        subtotal += sum;
        totalWeight += qty * (item.weight || 0);
        totalProductionCost += costSum;

        // Агрегация по продукту
        const pKey = item.name;
        if (!productProfitMap[pKey]) productProfitMap[pKey] = { revenue: 0, cost: 0, tax: 0, profit: 0 };
        productProfitMap[pKey].revenue += sum;
        productProfitMap[pKey].cost += costSum;
        productProfitMap[pKey].tax += lineTax;
        productProfitMap[pKey].profit += lineNetProfit;

        return `
            <tr class="sales-cart-row">
                <td>${item.sortLabel || '1 Сорт'}</td>
                <td><b>${item.name}</b></td>
                <td class="text-center">
                    <input type="number" class="input-modern sales-cart-qty-input" value="${qty}" min="0.01" step="0.01"
                           style="width:80px; text-align:center;"
                           oninput="updateCartItem(${index}, 'qty', this.value)">
                    <span class="font-12 text-muted">${item.unit}</span>
                </td>
                <td class="text-center">
                    <input type="number" class="input-modern sales-cart-price-input" value="${basePrice}" oninput="updateCartItem(${index}, 'price', this.value)">
                </td>
                <td class="text-center">
                    <input type="number" class="input-modern sales-cart-discount-input" value="${discount}" min="0" max="100" oninput="updateCartItem(${index}, 'discount', this.value)">
                </td>
                <td class="sales-cart-sum" style="white-space:nowrap;">
                    ${sum.toFixed(2)} ₽
                    ${unitCost > 0 ? `<div class="font-10 ${lineNetProfit >= 0 ? 'text-success' : 'text-danger'}" title="Чистая прибыль (после налога ${safeTaxPct}%)">= ${lineNetProfit >= 0 ? '+' : ''}${lineNetProfit.toFixed(0)} ₽</div>` : ''}
                </td>
                <td class="text-center"><button class="sales-cart-remove" onclick="removeFromCart(${index})">✖</button></td>
            </tr>
        `;
    }).join('');

    // БЛОК 3: БАЗОВАЯ МАТЕМАТИКА ЧЕКА
    const globalDiscount = parseFloat(document.getElementById('sale-discount').value) || 0;
    const logistics = parseFloat(document.getElementById('sale-logistics-cost').value) || 0;

    const finalProductRevenue = subtotal * (1 - globalDiscount / 100);
    const finalTotal = finalProductRevenue + logistics;

    document.getElementById('cart-total-weight').innerText = totalWeight.toFixed(1);

    const goodsSumEl = document.getElementById('cart-goods-sum');
    if (goodsSumEl) goodsSumEl.innerText = subtotal.toLocaleString('ru-RU') + ' ₽';

    const originalSumEl = document.getElementById('cart-original-sum');
    if (originalSumEl) {
        if (globalDiscount > 0) {
            originalSumEl.innerText = subtotal.toLocaleString('ru-RU') + ' ₽';
            originalSumEl.style.display = 'inline';
        } else {
            originalSumEl.style.display = 'none';
        }
    }

    document.getElementById('cart-total-sum').innerText = finalTotal.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

    const logSumEl = document.getElementById('cart-logistics-sum');
    if (logSumEl) logSumEl.innerText = logistics.toLocaleString('ru-RU') + ' ₽';

    if (typeof updateOffsetSummary === 'function') updateOffsetSummary();
    if (typeof smartAccountToggle === 'function') smartAccountToggle();

    // ==================================================
    // 🚀 БЛОК 4: ПРИБЫЛЬ В КОРЗИНЕ
    // ==================================================
    const taxCost = finalProductRevenue * (safeTaxPct / 100);
    const netProfit = finalProductRevenue - totalProductionCost - taxCost;
    const marginPct = finalProductRevenue > 0 ? ((netProfit / finalProductRevenue) * 100).toFixed(1) : 0;

    const profitSummary = document.getElementById('cart-profit-summary');
    if (profitSummary) {
        if (totalProductionCost > 0) {
            profitSummary.classList.remove('sales-hidden');
            const isProfitable = netProfit >= 0;

            // Стили заголовка
            const header = document.getElementById('cart-profit-header');
            if (header) {
                header.style.background = isProfitable
                    ? 'linear-gradient(135deg, #e8f5e9, #c8e6c9)'
                    : 'linear-gradient(135deg, #ffebee, #ffcdd2)';
                header.style.borderTopColor = isProfitable ? '#66bb6a' : '#ef5350';
            }

            document.getElementById('cart-profit-tax-pct').innerText = safeTaxPct;

            const profitTotalEl = document.getElementById('cart-profit-total');
            profitTotalEl.innerText = (isProfitable ? '+' : '') + netProfit.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₽';
            profitTotalEl.style.color = isProfitable ? '#1b5e20' : '#b71c1c';

            const marginEl = document.getElementById('cart-profit-margin');
            marginEl.innerText = `${marginPct}%`;
            marginEl.style.background = isProfitable ? '#1b5e20' : '#b71c1c';
            marginEl.style.color = '#fff';

            // Разбивка по продуктам
            const breakdownEl = document.getElementById('cart-profit-breakdown');
            const productKeys = Object.keys(productProfitMap);
            if (breakdownEl) {
                if (productKeys.length > 1) {
                    breakdownEl.innerHTML = productKeys.map(name => {
                        const p = productProfitMap[name];
                        const ok = p.profit >= 0;
                        return `<div style="display:flex; justify-content:space-between; padding: 3px 0; border-bottom: 1px dotted ${isProfitable ? '#a5d6a7' : '#ef9a9a'};">
                            <span style="color: ${isProfitable ? '#2e7d32' : '#c62828'};">${name}</span>
                            <span style="font-weight:700; color: ${ok ? '#1b5e20' : '#b71c1c'};">${ok ? '+' : ''}${p.profit.toFixed(2)} ₽</span>
                        </div>`;
                    }).join('');
                    breakdownEl.style.display = 'block';
                    breakdownEl.style.background = isProfitable ? '#e8f5e960' : '#ffebee60';
                    breakdownEl.style.padding = '6px 18px 10px';
                } else {
                    breakdownEl.innerHTML = '';
                    breakdownEl.style.display = 'none';
                }
            }
        } else {
            profitSummary.classList.add('sales-hidden');
        }
    }

    const oldProfit = document.getElementById('cart-profit-info');
    if (oldProfit) oldProfit.style.display = 'none';
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
    // 1. ПРОВЕРКА ДОВЕРЕННОСТИ (опционально — поля появятся в Управлении заказами при отгрузке)
    // ==========================================
    const poa_info = null; // Доверенность заполняется при отгрузке, не при оформлении

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
        driver: document.getElementById('sale-driver')?.value || null,
        auto: document.getElementById('sale-auto')?.value || null,
        offset_amount: (document.getElementById('sale-offset-check')?.checked ? parseFloat(document.getElementById('sale-offset-amount')?.value) : 0) || 0,
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
                    <div class="bg-warning-lt border-warning p-15 border-radius-8 mb-15">
                        <h4 class="text-warning mt-0">⚠️ Внимание! Нехватка сырья</h4>
                        <p class="font-13 text-warning">Для производства заказа не хватает материалов на Складе №1:</p>
                        <table class="table-modern w-100 font-13 mt-10">
                            <thead>
                                <tr class="text-left border-bottom">
                                    <th class="p-5">Материал</th>
                                    <th class="p-5">Нужно</th>
                                    <th class="p-5">Дефицит</th>
                                </tr>
                            </thead>
                            <tbody>
                            ${result.deficitReport.map(m => `
                                <tr>
                                    <td class="p-5"><b>${m.name || 'Материал'}</b></td>
                                    <td class="p-5">${m.needed || 0}</td>
                                    <td class="p-5 text-danger"><b>-${m.shortage || 0}</b></td>
                                </tr>
                            `).join('')}
                            </tbody>
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
        tbody.innerHTML = '<tr><td colspan="6" class="sales-empty-cell">Нет активных заказов</td></tr>';
        return;
    }

    tbody.innerHTML = paginated.map(o => {
        // --- 1. СТАТУС ОТГРУЗКИ ---
        const ordered = parseFloat(o.total_ordered) || 0;
        const shipped = parseFloat(o.total_shipped) || 0;
        let statusBadge = shipped > 0 && shipped < ordered
            ? `<span class="sales-badge badge-shipping">🔵 Отгружается (${Math.round((shipped / ordered) * 100)}%)</span>`
            : `<span class="sales-badge badge-queued">🟡 В очереди</span>`;

        // --- 2. СТАТУС ОПЛАТЫ ---
        const totalAmt = parseFloat(o.total_amount) || 0;
        const paidAmt = parseFloat(o.paid_amount) || 0;
        const debtAmt = parseFloat(o.pending_debt) || 0;
        let finBadge = '';
        if (paidAmt >= totalAmt) {
            finBadge = `<span class="sales-badge badge-paid">🟢 Оплачен 100%</span>`;
        } else if (debtAmt > 0) {
            finBadge = `<span class="sales-badge badge-debt">🔴 Долг: ${debtAmt.toLocaleString('ru-RU')} ₽</span>`;
        } else if (paidAmt > 0) {
            finBadge = `<span class="sales-badge badge-advance">🟡 Аванс: ${paidAmt.toLocaleString('ru-RU')} ₽</span>`;
        } else {
            finBadge = `<span class="sales-badge badge-unpaid">⚪ Не оплачен</span>`;
        }

        // --- 3. БАЛАНС КЛИЕНТА ---
        const clientBalance = parseFloat(o.client_balance) || 0;
        let clientBalanceBadge = '';
        if (clientBalance > 0) {
            clientBalanceBadge = `<div class="sales-balance-badge balance-overpaid">💰 Переплата (Аванс): +${clientBalance.toLocaleString('ru-RU')} ₽</div>`;
        } else if (clientBalance < 0) {
            clientBalanceBadge = `<div class="sales-balance-badge balance-debt">📉 Общий долг: ${Math.abs(clientBalance).toLocaleString('ru-RU')} ₽</div>`;
        } else {
            clientBalanceBadge = `<div class="sales-balance-badge balance-zero">⚖️ Взаиморасчеты: 0 ₽</div>`;
        }

        // --- 4. ПРОГНОЗ ---
        const projected = parseFloat(o.projected_balance) || 0;
        const projHtml = `<div class="sales-projected">Итог по всем заказам: <b class="${projected < 0 ? 'sales-projected-negative' : 'sales-projected-positive'}">${projected.toLocaleString('ru-RU')} ₽</b></div>`;

        // --- 5. ВЗАИМОЗАЧЕТ ---
        let offsetBtn = '';
        if (clientBalance > 0 && debtAmt > 0) {
            const offsetAmount = Math.min(clientBalance, debtAmt);
            offsetBtn = `<button class="btn btn-outline sales-btn-sm sales-btn-sm-success" onclick="offsetOrderAdvance('${o.doc_number}', ${offsetAmount})" title="Зачесть аванс в счет заказа">💸 Зачесть</button>`;
        }

        // --- РЕНДЕР СТРОКИ (ШАГ 4: entity-links) ---
        return `
        <tr class="sales-order-row">
            <td class="sales-order-date">
                ${o.date_formatted}<br>
                <span class="sales-order-deadline">до ${o.deadline || 'Не указан'}</span>
            </td>
            <td>
                <span class="sales-order-doc-link entity-link" onclick="window.app.openEntity('document_order', ${o.id})">${o.doc_number}</span><br>
                <span class="sales-order-amount">${totalAmt.toLocaleString('ru-RU')} ₽</span>
            </td>
            <td style="vertical-align: top;">
                <span class="sales-order-client entity-link" onclick="window.app.openEntity('client', ${o.client_id})">${escapeHTML(o.client_name || 'Неизвестный клиент')}</span><br>
                <span class="sales-order-address">📍 ${escapeHTML(o.delivery_address || 'Самовывоз')}</span><br>
                ${clientBalanceBadge}
                ${projHtml}
            </td>
            <td class="sales-order-items">${escapeHTML(o.items_list || 'Пусто')}</td>
            <td class="text-center" style="vertical-align: middle;">
                ${statusBadge}<br>
                ${finBadge}
            </td>
            <td class="sales-order-actions-cell">
                <div class="sales-order-actions-row">
                    ${offsetBtn}
                    <button class="btn btn-outline sales-btn-sm sales-btn-sm-info" onclick="openInvoiceModal('${o.doc_number}', ${debtAmt > 0 ? debtAmt : totalAmt})" title="Счет на оплату">🖨️ Счет</button>
                    <button class="btn btn-outline sales-btn-sm sales-btn-sm-info" onclick="openOrderManager(${o.id})">⚙️ Управл.</button>
                    <button class="btn btn-outline sales-btn-sm sales-btn-sm-danger" onclick="confirmDeleteOrder(${o.id}, '${o.doc_number}')" title="Отменить и удалить заказ">❌</button>
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
        tbody.innerHTML = '<tr><td colspan="6" class="sales-empty-cell">Отгрузки не найдены</td></tr>';
        return;
    }

    tbody.innerHTML = paginated.map(h => {
        // 🚀 НОВОЕ: Умный поиск цены (бэкенд может называть её по-разному)
        const rowSum = parseFloat(h.amount || h.total_amount || h.total_sum || h.sum || 0);
        const sumText = rowSum > 0 ? rowSum.toLocaleString('ru-RU') + ' ₽' : '-';

        return `
        <tr class="sales-hist-row">
            <td class="sales-hist-date">${h.date_formatted}</td>
            <td><strong class="sales-hist-doc entity-link" onclick="window.app.openEntity('document_shipment', '${h.doc_num}')">${h.doc_num}</strong></td>
            <td>
                <b class="entity-link" onclick="window.app.openEntity('client', ${h.client_id || 0})">${escapeHTML(h.client_name || 'Неизвестный клиент')}</b><br>
                <span class="profit-sub">${h.payment || ''}</span>
            </td>
            <td class="text-center" style="font-weight: bold;">${parseFloat(h.total_qty).toLocaleString('ru-RU')}</td>
            <td class="sales-hist-sum">${sumText}</td>
            <td class="sales-hist-actions">
            <div class="sales-order-actions-row">
                <button class="btn btn-outline sales-btn-sm sales-btn-sm-info" onclick="window.open('/print/upd?docNum=${h.doc_num}' + (String('/print/upd?docNum=${h.doc_num}').includes('?') ? '&' : '?') + 'token=' + (localStorage.getItem('token') || ''), '_blank')" title="УПД и Пропуск на выезд">🖨️ УПД + Пропуск</button>
                <button class="btn btn-outline sales-btn-sm" style="color: var(--warning-text); border-color: var(--warning-text);" onclick="window.open('/print/specification?docNum=${h.doc_num}' + (String('/print/specification?docNum=${h.doc_num}').includes('?') ? '&' : '?') + 'token=' + (localStorage.getItem('token') || ''), '_blank')" title="Спецификация">🖨️ Спец.</button>
                <button class="btn btn-outline sales-btn-sm" style="color: var(--primary); border-color: var(--primary);" onclick="window.open('/print/waybill?docNum=${h.doc_num}' + (String('/print/waybill?docNum=${h.doc_num}').includes('?') ? '&' : '?') + 'token=' + (localStorage.getItem('token') || ''), '_blank')" title="Накладная">🖨️ Накладная</button>
                <button class="btn btn-outline sales-btn-sm sales-btn-sm-danger" onclick="cancelShipment('${h.doc_num}')" title="Отменить">❌</button>
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
            <tr class="border-bottom">
                <td class="p-8">
                    <span class="badge bg-surface-alt text-muted font-11 mr-8 font-mono">${p.article || 'НЕТ АРТИКУЛА'}</span>
                    <b>${p.name}</b> <span class="font-10 text-muted">(${p.unit})</span>
                </td>
                <td class="p-8 text-center">
                    <input type="number" class="input-modern price-basic text-center w-90" data-id="${p.id}" value="${p.current_price}">
                </td>
                <td class="p-8 text-center">
                    <input type="number" class="input-modern price-dealer text-center w-90 border-info" data-id="${p.id}" value="${p.dealer_price || 0}">
                </td>
            </tr>
        `).join('');

        const html = `
            <style>
                #app-modal .modal-content { max-width: 700px !important; }
                .price-list-table thead { position: sticky; top: 0; z-index: 10; }
            </style>
            <div class="overflow-auto pr-10" style="max-height: 60vh;">
                <table class="table-modern w-100 font-13 price-list-table">
                    <thead class="bg-surface-hover">
                        <tr>
                            <th class="p-10 text-left">Товар</th>
                            <th class="p-10 text-center text-main">Основная (Розница)</th>
                            <th class="p-10 text-center text-info">Дилерская (Опт)</th>
                        </tr>
                    </thead>
                    <tbody>${tbody}</tbody>
                </table>
            </div>
        `;

        UI.showModal('📋 Установка Прайс-листа', html, `
            <div class="flex-between flex-wrap gap-10 w-100">
                <div class="flex-row gap-10">
                    <label class="btn btn-outline border-primary text-primary font-12 p-6-12 cursor-pointer">
                        📥 Загрузить Базовый (Розница)
                        <input type="file" accept=".csv" class="display-none" onchange="handleBasicCsvImport(event)">
                    </label>
                    <label class="btn btn-outline border-info text-info font-12 p-6-12 cursor-pointer">
                        📥 Загрузить Дилерский (Опт)
                        <input type="file" accept=".csv" class="display-none" onchange="handleDealerCsvImport(event)">
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
            listHtml = '<div class="text-center text-muted p-10 mt-10">Нет заключенных договоров</div>';
        } else {
            contractsMap.forEach(c => {
                specCounts[c.id] = c.specs.length + 1; // Считаем следующий номер

                listHtml += `
                    <div class="card p-10 border mb-10 m-0">
                        <div class="flex-between align-center border-bottom dashed pb-10 mb-10">
                            <strong class="text-main font-14">📄 Договор №${c.id ? `<span class="entity-link" onclick="window.app.openEntity('document_contract', ${c.id})">${c.number}</span>` : c.number} от ${c.date}</strong>
                            <div class="flex-row gap-5">
                                <button class="btn btn-outline p-5 border-info text-info font-11" onclick="window.open('/print/contract?id=${c.id}' + (String('/print/contract?id=${c.id}').includes('?') ? '&' : '?') + 'token=' + (localStorage.getItem('token') || ''), '_blank')" title="Распечатать">🖨️</button>
                                <button class="btn btn-outline p-5 border-danger text-danger font-11" onclick="deleteContract(${c.id})" title="Удалить">❌</button>
                            </div>
                        </div>
                        <div class="pl-15">
                            ${c.specs.length === 0 ? '<span class="text-muted font-11">Нет прикрепленных спецификаций</span>' : ''}
                            ${c.specs.map(s => `
                                <div class="flex-between align-center font-12 text-muted mb-5">
                                    <span>↳ Спецификация №${s.number} от ${s.date}</span>
                                    <div class="flex-row gap-5">
                                        <button class="btn btn-outline p-5 border-info text-info font-11" style="border:none;" onclick="window.open('/print/specification_doc?id=${s.id}' + (String('/print/specification_doc?id=${s.id}').includes('?') ? '&' : '?') + 'token=' + (localStorage.getItem('token') || ''), '_blank')" title="Печать спецификации">🖨️</button>
                                        <button class="btn btn-outline p-5 border-danger text-danger font-11" style="border:none;" onclick="deleteSpecification(${s.id})" title="Удалить спецификацию">❌</button>
                                    </div>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                `;
            });
        }

        const html = `
            <div class="mb-20 pr-5 border-bottom pb-15 overflow-auto" style="max-height: 350px;">
                <h4 class="m-0 mb-10 text-muted">Актуальные документы:</h4>
                ${listHtml}
            </div>

            <div class="mb-15 p-15 bg-surface-hover border border-radius-6">
                <h4 class="m-0 mb-10 text-primary">📄 Создать новый договор</h4>
                <input type="text" style="display:none" autocomplete="username">
                <input type="password" style="display:none" autocomplete="current-password">
                <div class="form-grid gap-15 sales-two-cols">
                    <div class="form-group m-0"><label>Номер договора:</label><input type="text" id="new-contract-num" class="input-modern" autocomplete="nope" placeholder="Напр: 45-А"></div>
                    <div class="form-group m-0"><label>Дата:</label><input type="date" id="new-contract-date" class="input-modern" value="${new Date().toISOString().split('T')[0]}"></div>
                </div>
                <button class="btn btn-blue w-100 p-10 mt-10" onclick="saveNewContract(${cpId})">➕ Сохранить договор</button>
            </div>

            <div class="p-15 border border-radius-6">
                <h4 class="m-0 mb-10 text-warning">📎 Добавить спецификацию</h4>
                <div class="form-group mb-10">
                    <label>К какому договору (Основание):</label>
                    <select id="new-spec-contract-id" class="input-modern">
                        ${Array.from(contractsMap.values()).map(c => `<option value="${c.id}">Договор №${c.number} от ${c.date}</option>`).join('')}
                    </select>
                </div>
                <div class="form-grid gap-15 sales-two-cols">
                    <div class="form-group m-0"><label>№ Спецификации:</label><input type="text" id="new-spec-num" class="input-modern"></div>
                    <div class="form-group m-0"><label>Дата:</label><input type="date" id="new-spec-date" class="input-modern" value="${new Date().toISOString().split('T')[0]}"></div>
                </div>
                <button class="btn btn-outline w-100 p-10 mt-10 text-warning border-warning" onclick="saveNewSpecification()">➕ Сохранить спецификацию</button>
            </div>
        `;

        UI.showModal(`Управление договорами: ${cpName}`, html, `<button class="btn btn-outline" onclick="UI.closeModal()">Закрыть</button>`);
        
        setTimeout(() => {
            const el = document.getElementById('new-spec-contract-id');
            if (el && !el.tomselect) new TomSelect(el, { plugins: ['clear_button'], dropdownParent: 'body' });
        }, 50);

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
        <div class="text-center p-10 font-15">
            <div class="font-bold font-30 mb-10">🗑️</div>
            Вы уверены, что хотите удалить этот договор?<br>
            <span class="text-muted font-13">Отменить это действие будет невозможно.</span>
        </div>
    `;

    const buttons = `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-red" onclick="executeDeleteContract(${id})">Удалить</button>
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

// --- ЛОГИКА ДЛЯ sales.js ---

// Показываем кнопку расчета только когда выбран товар
// (нужно добавить этот вызов в onChange твоего TomSelect продукции в продажах)
window.onSalesProductChange = function (productId) {
    const btn = document.getElementById('btn-calc-sales-cost');
    if (productId) btn.style.display = 'block';
    else btn.style.display = 'none';
};

// ==========================================
// АНАЛИЗ СЕБЕСТОИМОСТИ И РЕНТАБЕЛЬНОСТИ
// ==========================================
window.openCostAnalysisModal = async function () {
    if (!currentSelectedItem) return UI.toast('Выберите товар из списка!', 'warning');

    const qty = parseFloat(document.getElementById('sale-qty').value) || 1;
    const salePrice = parseFloat(document.getElementById('sale-price').value) || 0;

    UI.toast('⏳ Загрузка аналитики...', 'info');

    try {
        const data = await API.get(`/api/sales/cost-analysis/${currentSelectedItem.id}`);

        const totalFactCost = data.materials.reduce((sum, m) => sum + m.fact_cost, 0);
        window.currentCalcData = { ...data, qty, salePrice };

        const batchCount = data.batchCount || 0;
        const methodNote = batchCount > 0
            ? `Средний расход сырья по <b>${batchCount}</b> последним завершённым формовкам.${data.materials.some(m => m.is_hybrid) ? ' Материалы без факта подставлены из рецепта (🪄).' : ''}`
            : 'Нет данных по формовкам. Используется <b>теоретический</b> расход из рецептуры.';

        const html = `
            <style>
                #app-modal .modal-content { max-width: 1120px !important; width: 96% !important; }
                .calc-grid { display: grid; grid-template-columns: 1fr 320px; gap: 24px; }
                .calc-card { border: 1px solid var(--border-color); border-radius: 10px; padding: 14px 16px; }
                .calc-card-header { font-size: 11px; text-transform: uppercase; font-weight: 700; color: var(--text-muted); margin-bottom: 10px; letter-spacing: 0.5px; }
                .calc-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; font-size: 13px; }
                .calc-row:last-child { margin-bottom: 0; }
                .calc-input { width: 85px; height: 30px; text-align: right; padding: 2px 6px; border: 1px dashed var(--border-color); border-radius: 6px; font-weight: 700; font-size: 13px; background: var(--bg-surface-alt); }
                .calc-sep { border-bottom: 1px dashed var(--border-color); margin: 6px 0; }
                .calc-method { background: #e3f2fd; border: 1px solid #90caf9; border-radius: 8px; padding: 10px 14px; font-size: 12px; color: #1565c0; margin-top: 12px; line-height: 1.6; }
                @media (max-width: 800px) { .calc-grid { grid-template-columns: 1fr; } }
            </style>
            <div style="padding: 8px 4px;">
                
                <!-- Шапка: Партия + Прибыль -->
                <div style="display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 18px; padding-bottom: 12px; border-bottom: 2px solid var(--border-color);">
                    <div>
                        <div class="font-13 text-muted">Объем партии: <b class="text-main">${qty} ${currentSelectedItem.unit || 'шт.'}</b> × <b class="text-main">${salePrice} ₽</b></div>
                    </div>
                    <div style="text-align: right;">
                        <div class="font-11 text-muted text-uppercase" style="letter-spacing: 0.5px;">Чистая прибыль (Партия)</div>
                        <div id="res-batch-profit" style="font-size: 28px; font-weight: 900; line-height: 1; color: var(--success);">0.00 ₽</div>
                    </div>
                </div>

                <div class="calc-grid">
                    
                    <!-- ======== ЛЕВАЯ КОЛОНКА: Таблица сырья ======== -->
                    <div>
                        <div class="calc-card" style="padding: 0; overflow: hidden;">
                            <div style="padding: 10px 16px; background: var(--bg-surface-alt); border-bottom: 1px solid var(--border-color);">
                                <span class="font-13 font-bold text-main">📦 Сравнительный расход сырья</span>
                            </div>
                            <div style="overflow-x: auto;">
                                <table class="table-modern w-100" style="min-width: 520px; font-size: 12px;">
                                    <thead style="background: var(--bg-surface-alt);">
                                        <tr style="border-bottom: 1px solid var(--border-color);">
                                            <th rowspan="2" style="padding: 8px 10px; border-right: 1px solid var(--border-color); font-size:11px; color:var(--text-muted);">МАТЕРИАЛ</th>
                                            <th colspan="2" style="padding: 6px; border-right: 1px solid var(--border-color); font-size:11px; color:var(--text-muted); text-align:center;">РАСХОД (1 ЕД)</th>
                                            <th colspan="2" style="padding: 6px; border-right: 1px solid var(--border-color); font-size:11px; color:var(--text-muted); text-align:center;">СУММА (1 ЕД)</th>
                                            <th rowspan="2" style="padding: 6px; font-size:11px; color:var(--text-muted); text-align:right;">ФАКТ<br>(ПАРТИЯ)</th>
                                        </tr>
                                        <tr style="border-bottom: 2px solid var(--border-color);">
                                            <th style="padding:4px 8px; font-size:10px; color:var(--primary); text-align:center; border-right:1px dashed var(--border-color);">📐 Идеал</th>
                                            <th style="padding:4px 8px; font-size:10px; color:#e65100; text-align:center; border-right:1px solid var(--border-color);">🧪 Опыт</th>
                                            <th style="padding:4px 8px; font-size:10px; color:var(--primary); text-align:center; border-right:1px dashed var(--border-color);">📐 Идеал</th>
                                            <th style="padding:4px 8px; font-size:10px; color:#e65100; text-align:center; border-right:1px solid var(--border-color);">🧪 Опыт</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        ${data.materials.map(m => `
                                            <tr style="border-bottom: 1px solid var(--bg-surface-hover);">
                                                <td style="padding:7px 10px; font-weight:600; border-right:1px solid var(--border-color);">${m.name}</td>
                                                <td style="padding:7px 6px; text-align:center; color:var(--primary); border-right:1px dashed var(--border-color);">${m.theory_qty > 0 ? m.theory_qty.toFixed(3) : '-'} <small>${m.unit}</small></td>
                                                <td style="padding:7px 6px; text-align:center; color:#e65100; font-weight:700; border-right:1px solid var(--border-color);">
                                                    ${m.fact_qty > 0 ? m.fact_qty.toFixed(3) : '-'} <small>${m.unit}</small>
                                                    ${m.is_hybrid ? '<span title="Нет факта — подставлено из рецепта" style="cursor:help;">🪄</span>' : ''}
                                                </td>
                                                <td style="padding:7px 6px; text-align:right; color:var(--primary); border-right:1px dashed var(--border-color);">${m.theory_cost > 0 ? m.theory_cost.toFixed(2) + ' ₽' : '-'}</td>
                                                <td style="padding:7px 6px; text-align:right; color:#e65100; font-weight:700; border-right:1px solid var(--border-color);">${m.fact_cost > 0 ? m.fact_cost.toFixed(2) + ' ₽' : '-'}</td>
                                                <td style="padding:7px 6px; text-align:right; font-weight:700; color:var(--danger);">${m.fact_cost > 0 ? (m.fact_cost * qty).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₽' : '-'}</td>
                                            </tr>
                                        `).join('')}
                                    </tbody>
                                    <tfoot style="background: var(--bg-surface-alt); border-top: 2px solid var(--border-color);">
                                        <tr style="font-weight: 900;">
                                            <td style="padding:10px; border-right:1px solid var(--border-color);">ИТОГО (СЫРЬЕ):</td>
                                            <td style="padding:10px; border-right:1px dashed var(--border-color);"></td>
                                            <td style="padding:10px; border-right:1px solid var(--border-color);"></td>
                                            <td style="padding:10px; text-align:right; color:var(--primary); border-right:1px dashed var(--border-color);">${parseFloat(data.theoretical).toLocaleString('ru-RU', { minimumFractionDigits: 2 })} ₽</td>
                                            <td style="padding:10px; text-align:right; color:#e65100; border-right:1px solid var(--border-color);">${totalFactCost > 0 ? totalFactCost.toLocaleString('ru-RU', { minimumFractionDigits: 2 }) + ' ₽' : '-'}</td>
                                            <td style="padding:10px; text-align:right; color:var(--danger); font-size:13px;">${totalFactCost > 0 ? (totalFactCost * qty).toLocaleString('ru-RU', { minimumFractionDigits: 2 }) + ' ₽' : '-'}</td>
                                        </tr>
                                    </tfoot>
                                </table>
                            </div>
                        </div>

                        <!-- Методология расчёта Опыта -->
                        <div class="calc-method">
                            <b>ℹ️ Методология «Опыт»:</b> ${methodNote}
                        </div>
                    </div>

                    <!-- ======== ПРАВАЯ КОЛОНКА: Карточки ======== -->
                    <div style="display: flex; flex-direction: column; gap: 14px;">

                        <!-- Сырье: Идеал vs Опыт -->
                        <div class="calc-card" style="border-left: 4px solid var(--primary);">
                            <div class="calc-card-header">📐 Себестоимость сырья (1 ед)</div>
                            <div class="calc-row">
                                <span class="text-muted">Идеал (Рецепт):</span>
                                <b>${data.theoretical} ₽</b>
                            </div>
                            <div class="calc-row" style="background: var(--bg-surface-alt); padding: 4px 8px; border-radius: 6px;">
                                <span class="text-muted">🧪 Опыт (Факт):</span>
                                <b style="color: #e65100;">${parseFloat(data.empirical) > 0 ? data.empirical : data.theoretical} ₽</b>
                            </div>
                        </div>

                        <!-- Доп. расходы -->
                        <div class="calc-card" style="border-left: 4px solid #ff9800;">
                            <div class="calc-card-header">🔨 Доп. расходы (на 1 ед)</div>
                            <div class="calc-row">
                                <span class="text-muted">Амортизация:</span>
                                <b>${data.amortization} ₽</b>
                            </div>
                            <div class="calc-row">
                                <span class="text-muted">Оверхед (Завод):</span>
                                <b style="color: #e65100;" title="Распределенные косвенные затраты">${data.overhead} ₽</b>
                            </div>
                            <div class="calc-sep"></div>
                            <div class="calc-row">
                                <span class="text-muted">Сдельная З/П:</span>
                                <input type="number" id="calc-wage" class="calc-input" style="color:var(--success); border-color:var(--success);" value="${currentSelectedItem.piece_rate || 0}" disabled title="Из Справочника">
                            </div>
                            <div class="calc-row">
                                <span class="text-muted">Упаковка:</span>
                                <input type="number" id="calc-pack" class="calc-input" value="0" step="1" onfocus="this.select()" oninput="recalcSalesMargin()">
                            </div>
                        </div>

                        <!-- Коммерция -->
                        <div class="calc-card" style="border-left: 4px solid var(--danger);">
                            <div class="calc-card-header">💼 Коммерция и Налоги</div>
                            <div class="calc-row">
                                <span class="text-muted">Цена (1 ед):</span>
                                <b>${salePrice} ₽</b>
                            </div>
                            <div class="calc-row">
                                <span style="color: var(--danger);">Налог (%):</span>
                                <input type="number" id="calc-tax-pct" class="calc-input" style="border-color:var(--danger);" value="${window.FINANCE_TAX_PERCENT || 6}" step="1" max="100" onfocus="this.select()" oninput="recalcSalesMargin()">
                            </div>
                            <div class="calc-row">
                                <span style="color: var(--info);">Бонус менедж. (%):</span>
                                <input type="number" id="calc-bonus-pct" class="calc-input" style="border-color:var(--info);" value="0" step="0.5" max="100" onfocus="this.select()" oninput="recalcSalesMargin()">
                            </div>
                        </div>

                        <!-- Результат -->
                        <div class="calc-card" style="background: var(--bg-surface-alt);">
                            <div class="calc-row" style="border-bottom: 1px dashed var(--border-color); padding-bottom: 6px; margin-bottom: 8px;">
                                <span>Произв. себестоимость:</span>
                                <strong id="res-prod-cost">0.00 ₽</strong>
                            </div>
                            <div class="calc-row" style="border-bottom: 1px solid var(--border-color); padding-bottom: 8px; margin-bottom: 10px;">
                                <span>Налоги и комиссии:</span>
                                <strong id="res-taxes" style="color: var(--danger);">-0.00 ₽</strong>
                            </div>
                            <div style="display: flex; justify-content: space-between; align-items: center;">
                                <div style="font-size: 11px; text-transform: uppercase; font-weight: 700; color: var(--text-muted);">Чистая прибыль (1 ед)</div>
                                <div style="text-align: right;">
                                    <div id="res-net-profit" style="font-size: 22px; font-weight: 900; line-height: 1; color: var(--success);">0.00 ₽</div>
                                    <div id="res-margin-pct" style="font-size: 12px; font-weight: 700; color: var(--success); margin-top: 3px;">Рентабельность: 0%</div>
                                </div>
                            </div>
                        </div>

                    </div>
                </div>
            </div>
        `;

        UI.showModal(`📊 Калькулятор себестоимости: ${currentSelectedItem.name}`, html, `<button class="btn btn-blue w-100" style="padding: 12px; font-size: 15px;" onclick="UI.closeModal()">Закрыть анализ</button>`);

        recalcSalesMargin();
    } catch (e) { console.error(e); UI.toast('Ошибка загрузки данных', 'error'); }
};

window.recalcSalesMargin = function () {
    if (!window.currentCalcData) return;
    const { theoretical, empirical, amortization, overhead, qty, salePrice } = window.currentCalcData;

    const wage = parseFloat(document.getElementById('calc-wage').value) || 0;
    const pack = parseFloat(document.getElementById('calc-pack').value) || 0;
    const taxPct = parseFloat(document.getElementById('calc-tax-pct').value) || 0;
    const bonusPct = parseFloat(document.getElementById('calc-bonus-pct').value) || 0;

    const baseMatCost = parseFloat(empirical) > 0 ? parseFloat(empirical) : parseFloat(theoretical);

    const prodCost = baseMatCost + parseFloat(amortization) + parseFloat(overhead || 0) + wage + pack;

    const taxCost = salePrice * (taxPct / 100);
    const bonusCost = salePrice * (bonusPct / 100);
    const totalCommercialCost = taxCost + bonusCost;

    const netProfit = salePrice - prodCost - totalCommercialCost;
    const netMargin = salePrice > 0 ? ((netProfit / salePrice) * 100).toFixed(1) : 0;
    const batchProfit = netProfit * qty;

    document.getElementById('res-prod-cost').innerText = prodCost.toFixed(2) + ' ₽';
    document.getElementById('res-taxes').innerText = '-' + totalCommercialCost.toFixed(2) + ' ₽';

    const profitEl = document.getElementById('res-net-profit');
    const marginEl = document.getElementById('res-margin-pct');
    const batchProfitEl = document.getElementById('res-batch-profit');

    if (netProfit > 0) {
        profitEl.innerText = netProfit.toFixed(2) + ' ₽';
        profitEl.style.color = 'var(--success)';
        marginEl.innerText = `Рентабельность сделки: ${netMargin}%`;
        marginEl.style.color = 'var(--success-text)';
        batchProfitEl.style.color = 'var(--success)';
    } else {
        profitEl.innerText = netProfit.toFixed(2) + ' ₽';
        profitEl.style.color = 'var(--danger)';
        marginEl.innerText = `Убыток: ${netMargin}%`;
        marginEl.style.color = 'var(--danger-text)';
        batchProfitEl.style.color = 'var(--danger)';
    }

    batchProfitEl.innerText = batchProfit.toLocaleString('ru-RU', { minimumFractionDigits: 2 }) + ' ₽';
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
            <div class="p-10">
                <div class="bg-surface-alt p-15 border-radius-6 mb-15">
                    <p class="m-0 mb-5"><b>Клиент:</b> ${order.client_name}</p>
                    <p class="m-0"><b>Адрес доставки:</b> ${order.delivery_address || 'Самовывоз'}</p>
                </div>
                
                <table class="table-modern w-100 mb-15">
                    <thead class="bg-info-lt">
                        <tr>
                            <th class="p-10 text-left">Продукция</th>
                            <th class="p-10 text-center">Заказано</th>
                            <th class="p-10 text-center">Уже отгружено</th>
                            <th class="p-10 text-center text-primary">Грузим сейчас</th>
                        </tr>
                    </thead>
                    <tbody>${itemsHtml}</tbody>
                </table>

                <div class="bg-surface-hover p-10 border-radius-6 border dashed">
                    <h4 class="m-0 mb-10 text-muted">Данные для этой отгрузки (Машина)</h4>
                    <div class="form-grid gap-10 sales-two-cols mb-10">
                        <div class="form-group m-0"><input type="text" id="ship-driver" class="input-modern" placeholder="ФИО Водителя"></div>
                        <div class="form-group m-0"><input type="text" id="ship-auto" class="input-modern" placeholder="Гос. номер авто"></div>
                        <div class="form-group m-0 grid-span-2"><input type="number" id="ship-pallets" class="input-modern" placeholder="Количество поддонов (шт)" min="0"></div>
                    </div>
                    <div class="form-group m-0">
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
            <div class="p-10">
                <div class="form-group">
                    <label>От кого возврат (Клиент):</label>
                    <select id="ret-client" class="input-modern">${clientOptions}</select>
                </div>

                <div class="bg-surface-hover p-10 border-radius-6 border dashed mb-15">
                    <h4 class="m-0 mb-10 text-muted">🧱 Возврат продукции (если есть)</h4>
                    <div class="form-grid gap-10 align-end" style="grid-template-columns: 2fr 1fr 1fr;">
                        <div class="form-group m-0">
                            <label>Товар:</label>
                            <select id="ret-item" class="input-modern">
                                <option value="">-- Выберите товар --</option>
                                ${Object.values(salesProductsInfo).map(p => `<option value="${p.id}" data-price="${p.price || p.current_price || p.base_price || 0}">${p.name}</option>`).join('')}
                            </select>
                        </div>
                        <div class="form-group m-0"><label>Кол-во:</label><input type="number" id="ret-qty" class="input-modern" min="0"></div>
                        <div class="form-group m-0"><label>На какой склад:</label>
                            <select id="ret-wh" class="input-modern">
                                <option value="4">🟢 №4 (Годная продукция)</option>
                                <option value="5">🟡 №5 (Уценка/Брак)</option>
                            </select>
                        </div>
                    </div>
                    <button class="btn btn-outline w-100 mt-10 font-12" onclick="addReturnItem()">➕ Добавить в список возврата</button>
                    
                    <table class="table-modern w-100 mt-10 font-13">
                        <tbody id="ret-items-table"></tbody>
                    </table>
                </div>

                <div class="form-grid gap-10 sales-two-cols mb-15">
                    <div class="form-group m-0">
                        <label class="text-warning font-bold">Возврат поддонов (шт):</label>
                        <input type="number" id="ret-pallets" class="input-modern" placeholder="Сколько пустых вернули?">
                    </div>
                    <div class="form-group m-0">
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

                <div class="form-group m-0">
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

        setTimeout(() => {
            ['ret-client', 'ret-item', 'ret-wh', 'ret-method', 'ret-account'].forEach(id => {
                const el = document.getElementById(id);
                if (el && !el.tomselect) new TomSelect(el, { plugins: ['clear_button'], dropdownParent: 'body' });
            });
        }, 50);
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
    window.open(`/files/${fileName}` + (String(`/files/${fileName}`).includes('?') ? '&' : '?') + 'token=' + (localStorage.getItem('token') || ''), '_blank');
};

// Функция для открытия реквизитов выбранного банка
window.printBankRequisites = function () {
    const bank = document.getElementById('bank-select-docs').value;
    // Теперь обращаемся к серверу, а он сам решит: отдать EJS или PDF
    window.open(`/print/requisites?bank=${bank}` + (String(`/print/requisites?bank=${bank}`).includes('?') ? '&' : '?') + 'token=' + (localStorage.getItem('token') || ''), '_blank');
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
    form.action = '/print/kp' + ('/print/kp'.includes('?') ? '&' : '?') + 'token=' + (localStorage.getItem('token') || '');
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
    form.action = '/print/blank_order_draft' + ('/print/blank_order_draft'.includes('?') ? '&' : '?') + 'token=' + (localStorage.getItem('token') || '');
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
        <div class="p-10">
            <p class="m-0 mt-0 text-muted font-13 mb-15">Счет для заказа <b>${docNum}</b>.</p>
            <div class="form-group mb-15">
                <label class="font-bold text-primary">Сумма счета (₽):</label>
                <input type="number" id="invoice-custom-amount" class="input-modern" placeholder="${debtAmt}" step="0.01">
                <span class="font-11 text-muted">Оставьте поле пустым, чтобы выставить счет на весь остаток долга.</span>
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

    setTimeout(() => {
        const el = document.getElementById('invoice-bank');
        if (el && !el.tomselect) new TomSelect(el, { plugins: ['clear_button'], dropdownParent: 'body' });
    }, 50);
};

window.executePrintInvoice = function (docNum) {
    const bank = document.getElementById('invoice-bank').value;
    const customAmt = document.getElementById('invoice-custom-amount').value;

    if (customAmt && parseFloat(customAmt) <= 0) {
        return UI.toast('Сумма счета должна быть больше нуля', 'error');
    }

    window.open(`/print/invoice?docNum=${docNum}&bank=${bank}&custom_amount=${customAmt}` + (String(`/print/invoice?docNum=${docNum}&bank=${bank}&custom_amount=${customAmt}`).includes('?') ? '&' : '?') + 'token=' + (localStorage.getItem('token') || ''), '_blank');
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

    setTimeout(() => {
        const el = document.getElementById('offset-account-select');
        if (el && !el.tomselect) new TomSelect(el, { plugins: ['clear_button'], dropdownParent: 'body' });
    }, 50);
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
            <div class="mb-12">
                <div class="flex-between font-12 mb-5">
                    <span class="text-truncate" style="max-width: 65%;"><b>${idx + 1}.</b> ${i.name} (${i.total_qty} шт)</span>
                    <span class="font-bold text-success">${formatSum(i.total_sum)}</span>
                </div>
                <div class="bg-surface-alt border-radius-4 overflow-hidden h-8">
                    <div class="h-100 border-radius-4" style="background: linear-gradient(90deg, #38bdf8, #3b82f6); width: ${(parseFloat(i.total_sum) / maxItemSum) * 100}%;"></div>
                </div>
            </div>
        `).join('');

        // Рисуем список клиентов
        let clientsHtml = data.topClients.map((c, idx) => `
            <div class="flex-between p-10-0 border-bottom border-surface-alt font-13">
                <span><b class="text-muted">${idx + 1}.</b> ${c.name}</span>
                <strong class="text-info">${formatSum(c.total_sum)}</strong>
            </div>
        `).join('');

        const html = `
            <style>#app-modal .modal-content { max-width: 800px !important; }</style>
            <div class="p-10">
                <div class="p-25 border-radius-12 text-center mb-20 shadow-sm text-white" style="background: linear-gradient(135deg, #3b82f6, var(--info));">
                    <div class="font-14 opacity-90 text-uppercase tracking-wider">Выручка за текущий месяц</div>
                    <div class="font-42 font-black mt-5">${formatSum(data.monthRevenue)}</div>
                </div>
                <div class="form-grid gap-20 sales-two-cols">
                    <div class="bg-surface-hover border p-20 border-radius-12">
                        <h4 class="m-0 text-main mb-20">🏆 Топ-5 товаров</h4>
                        ${itemsHtml || '<div class="text-muted text-center">Нет продаж в этом месяце</div>'}
                    </div>
                    <div class="bg-surface-hover border p-20 border-radius-12">
                        <h4 class="m-0 text-main mb-10">🥇 Топ-5 клиентов</h4>
                        ${clientsHtml || '<div class="text-muted text-center">Нет продаж в этом месяце</div>'}
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
    let html = '<style>#app-modal .modal-content { max-width: 1200px !important; width: 95% !important; }</style>';
    html += '<div class="p-10 flex-row gap-15 overflow-x-auto pb-20">';

    dates.forEach(date => {
        const isToday = date === new Date().toLocaleDateString('ru-RU');
        html += `
            <div class="bg-surface-hover border border-radius-8 p-15 flex-shrink-0" style="min-width: 320px; max-width: 320px;">
                <h4 class="m-0 text-main border-bottom pb-8 mb-15" style="border-bottom-color: ${isToday ? '#ef4444' : '#38bdf8'} !important; border-bottom-style: solid; border-bottom-width: 3px;">
                    ${isToday ? '🔥 СЕГОДНЯ' : '📅 ' + date} <span class="font-normal font-12 text-muted float-right">${grouped[date].length} маш.</span>
                </h4>`;

        grouped[date].forEach(o => {
            const ordered = parseFloat(o.total_ordered) || 0;
            const shipped = parseFloat(o.total_shipped) || 0;
            const percent = ordered > 0 ? Math.round((shipped / ordered) * 100) : 0;
            const statusClass = percent === 100 ? 'bg-success-lt text-success' : (percent > 0 ? 'bg-info-lt text-info' : 'bg-warning-lt text-warning');

            html += `
                <div class="card p-12 mb-10 shadow-sm cursor-pointer border" onclick="openOrderManager(${o.id})">
                    <div class="flex-between mb-8">
                        <strong class="text-info">${o.doc_number}</strong>
                        <span class="font-10 font-bold border-radius-4 p-3-6 ${statusClass}">Собрано: ${percent}%</span>
                    </div>
                    <div class="font-13 font-bold mb-5">${o.client_name || 'Неизвестно'}</div>
                    <div class="font-11 text-muted mb-8 bg-surface-alt p-5 border-radius-4">📍 ${o.delivery_address || 'Самовывоз со склада'}</div>
                    <div class="font-11 text-muted pt-8 border-top dashed line-height-15">📦 ${o.items_list}</div>
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
        <div class="p-10 text-center">
            <p class="text-muted font-13 m-0 mt-0">Выберите период для выгрузки реестра отгрузок. Файл скачается в формате CSV (Excel), оптимизированном для загрузки в 1С Бухгалтерию.</p>
            <div class="flex-row gap-10 justify-center mt-20">
                <div class="form-group m-0 pl-10" style="text-align: left;">
                    <label>Месяц</label>
                    <select id="export-month" class="input-modern w-150">
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
                <div class="form-group m-0" style="text-align: left;">
                    <label>Год</label>
                    <input type="number" id="export-year" class="input-modern w-100" value="${currentYear}">
                </div>
            </div>
        </div>
    `;

    UI.showModal('📥 Экспорт для 1С (Отгрузки)', html, `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-blue bg-success-btn border-success" onclick="executeExport1C()">Скачать Excel</button>
    `);

    setTimeout(() => {
        const el = document.getElementById('export-month');
        if (el && !el.tomselect) new TomSelect(el, { plugins: ['clear_button'], dropdownParent: 'body' });
    }, 50);
};

window.executeExport1C = function () {
    const m = document.getElementById('export-month').value;
    const y = document.getElementById('export-year').value;

    // Открываем маршрут скачивания файла
    window.open(`/api/sales/export-1c?month=${m}&year=${y}` + (String(`/api/sales/export-1c?month=${m}&year=${y}`).includes('?') ? '&' : '?') + 'token=' + (localStorage.getItem('token') || ''), '_blank');
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
        card.className = `kanban-card ${order.status === 'processing' ? 'kanban-card-processing' : 'kanban-card-pending'}`;
        card.draggable = true;
        card.dataset.id = order.id;

        card.innerHTML = `
            <div class="kanban-card-header">
                <span>${order.id ? `<span class="entity-link" onclick="window.app.openEntity('document_order', ${order.id})">${order.doc_number}</span>` : order.doc_number}</span>
                <span title="Дедлайн">⏳ ${order.deadline || order.date_formatted}</span>
            </div>
            <div class="kanban-card-client">
                ${order.client_id ? `<span class="entity-link" onclick="window.app.openEntity('client', ${order.client_id})">${escapeHTML(order.client_name)}</span>` : escapeHTML(order.client_name)}
            </div>
            <div class="kanban-card-items">
                ${escapeHTML(order.items_list)}
            </div>
            <div class="kanban-card-footer">
                <span class="kanban-card-total">${parseFloat(order.total_amount).toLocaleString()} ₽</span>
                <button onclick="openOrderDetails(${order.id})" class="kanban-card-btn">
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
            <table class="table-modern w-100 mb-15">
                <thead class="bg-surface-hover text-left">
                    <tr>
                        <th class="p-8 border-bottom">Товар</th>
                        <th class="p-8 border-bottom text-center">Заказано</th>
                        <th class="p-8 border-bottom text-center">Отгружено</th>
                    </tr>
                </thead>
                <tbody>
        `;

        items.forEach(item => {
            const ordered = parseFloat(item.qty_ordered);
            const shipped = parseFloat(item.qty_shipped || 0);
            // Подсветка статуса отгрузки: зеленый (полностью), желтый (частично), красный (не отгружалось)
            const colorClass = shipped >= ordered ? 'text-success' : (shipped > 0 ? 'text-warning' : 'text-danger');

            itemsHtml += `
                <tr>
                    <td class="p-8 border-bottom border-surface-alt">
                        ${item.product_id || item.id ? `<span class="entity-link" onclick="window.app.openEntity('nomenclature', ${item.product_id || item.id})">${escapeHTML(item.name)}</span>` : escapeHTML(item.name)}
                    </td>
                    <td class="p-8 border-bottom border-surface-alt text-center font-bold">${ordered} ${item.unit}</td>
                    <td class="p-8 border-bottom border-surface-alt text-center font-bold ${colorClass}">${shipped}</td>
                </tr>
            `;
        });
        itemsHtml += `</tbody></table>`;

        // Формируем тело модального окна
        const htmlBody = `
            <div class="mb-15 bg-surface-hover p-15 border-radius-8 border font-14">
                <div class="mb-8"><strong>💼 Клиент:</strong> 
                    ${order.client_id ? `<span class="entity-link" onclick="window.app.openEntity('client', ${order.client_id})">${escapeHTML(order.client_name)}</span>` : escapeHTML(order.client_name)}
                </div>
                <div class="mb-8"><strong>📍 Адрес доставки:</strong> ${escapeHTML(order.delivery_address || 'Самовывоз')}</div>
                <div class="mb-8"><strong>💰 Сумма заказа:</strong> <span class="text-main font-bold">${parseFloat(order.total_amount).toLocaleString()} ₽</span></div>
                <div class="m-0"><strong>📅 Плановая отгрузка:</strong> ${order.planned_shipment_date ? new Date(order.planned_shipment_date).toLocaleDateString() : 'Не указана'}</div>
            </div>
            <h4 class="m-0 mb-10 text-muted">📦 Состав заказа:</h4>
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
        <div class="p-10">
            <input type="text" class="display-none" autocomplete="username">
            <input type="password" class="display-none" autocomplete="current-password">

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
    invoice: function (id) {
        if (!id) return UI.toast('ID счета не указан', 'error');
        window.open(`/print/invoice?id=${id}` + (String(`/print/invoice?id=${id}`).includes('?') ? '&' : '?') + 'token=' + (localStorage.getItem('token') || ''), '_blank');
    },
    // 2. Расходная накладная
    waybill: function (docNum) {
        if (!docNum) return UI.toast('Номер документа не указан', 'error');
        window.open(`/print/waybill?docNum=${docNum}` + (String(`/print/waybill?docNum=${docNum}`).includes('?') ? '&' : '?') + 'token=' + (localStorage.getItem('token') || ''), '_blank');
    },
    // 3. УПД
    upd: function (docNum) {
        if (!docNum) return UI.toast('Номер документа не указан', 'error');
        window.open(`/print/upd?docNum=${docNum}` + (String(`/print/upd?docNum=${docNum}`).includes('?') ? '&' : '?') + 'token=' + (localStorage.getItem('token') || ''), '_blank');
    },
    // 4. Договор
    contract: function (id) {
        if (!id) return UI.toast('ID договора не указан', 'error');
        window.open(`/print/contract?id=${id}` + (String(`/print/contract?id=${id}`).includes('?') ? '&' : '?') + 'token=' + (localStorage.getItem('token') || ''), '_blank');
    },
    // 5. Спецификация (по номеру заказа)
    specification: function (docNum) {
        if (!docNum) return UI.toast('Номер заказа не указан', 'error');
        window.open(`/print/specification?docNum=${docNum}` + (String(`/print/specification?docNum=${docNum}`).includes('?') ? '&' : '?') + 'token=' + (localStorage.getItem('token') || ''), '_blank');
    },
    // 6. Спецификация (отдельный документ)
    specificationDoc: function (id) {
        if (!id) return UI.toast('ID спецификации не указан', 'error');
        window.open(`/print/specification_doc?id=${id}` + (String(`/print/specification_doc?id=${id}`).includes('?') ? '&' : '?') + 'token=' + (localStorage.getItem('token') || ''), '_blank');
    },
    // 7. Акт сверки
    act: function (cpId, startDate, endDate) {
        if (!cpId || !startDate || !endDate) return UI.toast('Укажите контрагента и период', 'error');
        window.open(`/print/act?cp_id=${cpId}&start=${startDate}&end=${endDate}` + (String(`/print/act?cp_id=${cpId}&start=${startDate}&end=${endDate}`).includes('?') ? '&' : '?') + 'token=' + (localStorage.getItem('token') || ''), '_blank');
    },
    // 8. Бланк заказа
    blankOrder: function (docNum) {
        if (!docNum) return UI.toast('Номер заказа не указан', 'error');
        window.open(`/print/blank_order?docNum=${docNum}` + (String(`/print/blank_order?docNum=${docNum}`).includes('?') ? '&' : '?') + 'token=' + (localStorage.getItem('token') || ''), '_blank');
    },
    // 9. Паспорт партии (Производство)
    passport: function (batchId) {
        if (!batchId) return UI.toast('ID партии не указан', 'error');
        window.open(`/print/passport?batchId=${batchId}` + (String(`/print/passport?batchId=${batchId}`).includes('?') ? '&' : '?') + 'token=' + (localStorage.getItem('token') || ''), '_blank');
    }
};
