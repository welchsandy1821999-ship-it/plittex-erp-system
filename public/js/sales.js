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
let historyPagination = { page: 1, totalPages: 1, total: 0, limit: 5 };

let historyDateRange = { start: '', end: '' };
let boDeadlineRange = { start: '', end: '' };

window.__salesBoPeriodPickers = { periodPicker: null, customRangePicker: null };
window.__salesHistPeriodPickers = { periodPicker: null, customRangePicker: null };

/** Для API.get: контрагент удалён в другой вкладке / 404 с бэкенда. */
function isCounterpartyNotFoundError(e) {
    if (!e) return false;
    const m = String(e.message || '');
    if (/404|не найден|not found/i.test(m)) return true;
    if (e.body && e.body.error && /не найден|not found|404/i.test(String(e.body.error))) return true;
    return false;
}

/** Стоимость доставки учитывается только при выбранной «Доставке», не «Самовывоз». */
function getEffectiveLogisticsCost() {
    const dt = document.querySelector('input[name="sale_delivery_type"]:checked');
    if (!dt || dt.value !== 'delivery') return 0;
    const el = document.getElementById('sale-logistics-cost');
    return el ? (parseFloat(el.value) || 0) : 0;
}

let recipePalletsRequestSeq = 0;
let recipePalletsDebounceTimer = null;

function scheduleRecipePalletsEstimate() {
    if (recipePalletsDebounceTimer) clearTimeout(recipePalletsDebounceTimer);
    recipePalletsDebounceTimer = setTimeout(() => {
        recipePalletsDebounceTimer = null;
        void runRecipePalletsEstimate();
    }, 220);
}

async function runRecipePalletsEstimate() {
    const mainEl = document.getElementById('cart-summary-pallets-main');
    const hintEl = document.getElementById('cart-summary-pallets-hint');
    if (!mainEl) return;

    if (!cart.length) {
        mainEl.textContent = '—';
        if (hintEl) {
            hintEl.textContent = 'По строке «поддон» в рецепте упаковки (без учёта дробного остатка с распалубки)';
        }
        return;
    }

    const seq = ++recipePalletsRequestSeq;
    mainEl.textContent = '…';
    try {
        const items = cart.map((c) => ({ item_id: c.id, qty: c.qty }));
        const data = await API.post('/api/sales/recipe-pallets-estimate', { items });
        if (seq !== recipePalletsRequestSeq) return;
        const total = Number(data.total_pallets) || 0;
        mainEl.textContent = total > 0 ? `${total} шт.` : '—';
        if (hintEl) {
            hintEl.textContent = total > 0
                ? 'Расчёт по рецептам; не учитывает «хвост» с последней распалубки'
                : 'В рецепте нет материала с «поддон» в названии или доля на ед. не задана';
        }
    } catch (e) {
        if (seq !== recipePalletsRequestSeq) return;
        mainEl.textContent = '—';
        if (hintEl) hintEl.textContent = 'Не удалось загрузить оценку';
    }
}

function resetRecipePalletsSummaryUi() {
    const mainEl = document.getElementById('cart-summary-pallets-main');
    const hintEl = document.getElementById('cart-summary-pallets-hint');
    if (mainEl) mainEl.textContent = '—';
    if (hintEl) {
        hintEl.textContent = 'По строке «поддон» в рецепте упаковки (без учёта дробного остатка с распалубки)';
    }
}

function initSales() {

    const whSelect = document.getElementById('sale-warehouse');
    if (whSelect) currentSalesWarehouse = whSelect.value;
    
    const orderDateEl = document.getElementById('sale-order-date');
    if (orderDateEl) orderDateEl.value = new Date().toISOString().split('T')[0];



    if (typeof window.salesBoInitPeriodStrip === 'function') window.salesBoInitPeriodStrip();
    if (typeof window.salesHistInitPeriodStrip === 'function') window.salesHistInitPeriodStrip();
    loadSalesData(true);
    loadSalesHistory();
    if (typeof loadActiveOrders === 'function') loadActiveOrders();
    initStaticSalesSelects();
    loadSalesAccounts();
    loadFinanceTaxPercent();
    if (typeof toggleSaleDelivery === 'function') toggleSaleDelivery();
}

// === ПЕРЕКЛЮЧЕНИЕ ВКЛАДОК ===
window.switchSalesTab = function (tabId, btn) {
    document.querySelectorAll('.sales-tab-content').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.sales-tab-btn').forEach(b => b.classList.remove('active'));
    const tab = document.getElementById(tabId);
    if (tab) tab.classList.add('active');
    if (btn) btn.classList.add('active');

    // Подгружаем данные при переходе на вкладку; период пересобираем после показа (Flatpickr/позиция)
    if (tabId === 'tab-active-orders') {
        const boIds = salesPeriodFieldIds('sales-bo');
        if (document.getElementById(boIds.fg)) salesPeriodFinishUi(boIds, window.__salesBoPeriodPickers);
        if (typeof loadActiveOrders === 'function') loadActiveOrders();
    }
    if (tabId === 'tab-history') {
        const hIds = salesPeriodFieldIds('sales-hist');
        if (document.getElementById(hIds.fg)) salesPeriodFinishUi(hIds, window.__salesHistPeriodPickers);
        if (typeof loadSalesHistory === 'function') loadSalesHistory();
    }
    if (tabId === 'tab-shipment-dashboard' && typeof loadShipmentDashboard === 'function') {
        loadShipmentDashboard();
    }
};

// === ЗАГРУЗКА КАСС/БАНКОВ ===
async function loadSalesAccounts() {
    try {
        const accounts = await API.get('/api/accounts');
        const sel = document.getElementById('sale-account');
        if (!sel) return;
        sel.innerHTML = '<option value="">-- Выберите кассу --</option>';
        accounts.filter(a => a.type !== 'imprest').forEach(a => {
            sel.innerHTML += `<option value="${a.id}">${Utils.escapeHtml(a.name)} (${parseFloat(a.balance || 0).toLocaleString('ru-RU')} ₽)</option>`;
        });
        salesSelectPreferredAccount();
    } catch (e) { console.error('Ошибка загрузки касс:', e); }
}

/** Единый источник ID клиента: TomSelect и нативный <select> часто рассинхронизированы. */
function salesGetTomSelectValue(elOrId) {
    const el = typeof elOrId === 'string' ? document.getElementById(elOrId) : elOrId;
    if (!el) return '';
    if (el.tomselect) {
        const raw = el.tomselect.getValue();
        if (Array.isArray(raw)) return String(raw[0] || '').trim();
        return String(raw ?? '').trim();
    }
    return String(el.value ?? '').trim();
}

function salesClearClientSelect() {
    const clientSel = document.getElementById('sale-client');
    if (!clientSel) return;
    if (clientSel.tomselect) {
        clientSel.tomselect.clear(true);
        clientSel.tomselect.setValue('', true);
        clientSel.tomselect.sync();
    }
    clientSel.value = '';
}

function salesSelectPreferredAccount() {
    const sel = document.getElementById('sale-account');
    if (!sel) return;
    if (sel.value) return;

    const options = Array.from(sel.options || []);
    const nonEmpty = options.filter((o) => o.value);
    if (!nonEmpty.length) return;

    const preferredId = window.CLIENT_PREFERRED_OFFSET_ACCOUNT_ID ? String(window.CLIENT_PREFERRED_OFFSET_ACCOUNT_ID) : '';
    const preferred = preferredId ? nonEmpty.find((o) => String(o.value) === preferredId) : null;
    const cashFirst = nonEmpty.find((o) => /касс/i.test(o.text || ''));
    const target = preferred || cashFirst || nonEmpty[0];
    sel.value = target.value;
    if (sel.tomselect) {
        sel.tomselect.setValue(String(target.value), true);
    }
}

// === ЗАГРУЗКА НАЛОГОВОЙ СТАВКИ ===
async function loadFinanceTaxPercent() {
    if (window.FINANCE_TAX_PERCENT) return; // Уже установлена из dashboard
    try {
        const data = await API.get('/api/settings/finance');
        window.FINANCE_TAX_PERCENT = parseFloat(data.sales_tax) || 6;
    } catch (e) { window.FINANCE_TAX_PERCENT = 6; }
}

function initStaticSalesSelects() {
    // bo-status-filter сейчас является hidden input — TomSelect на нём не инициализируем
    ['sale-account', 'bo-client-filter', 'hist-client-filter'].forEach(id => {
        const el = document.getElementById(id);
        if (el && !el.tomselect) {
            new TomSelect(el, {
                plugins: ['clear_button'],
                allowEmptyOption: true,
                dropdownParent: 'body'
            });
        }
    });
}


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
        if (contractGroup) contractGroup.classList.add('d-none');
        if (contractSelect) contractSelect.innerHTML = '';
        return;
    }

    try {
        const data = await API.get(`/api/counterparties/${id}/contracts`);

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
        if (contractGroup) contractGroup.classList.remove('d-none');
    } catch (e) { console.error('Ошибка загрузки договоров:', e); }
};

// Комментарий к блоку: Главный обработчик смены клиента. 
// Загружает профиль, договоры, рисует розовую карточку и защищает корзину от махинаций с ценами.
window.onClientChange = async function () {
    const clientSelect = document.getElementById('sale-client');
    const cpId = salesGetTomSelectValue(clientSelect) || null;
    const infoBox = document.getElementById('sale-client-info');
    const contractGroup = document.getElementById('sale-contract-group');

    // Комментарий к блоку: ЗАЩИТА БИЗНЕС-ЛОГИКИ.
    // Если менеджер сменил клиента, а в корзине уже лежат товары, 
    // мы жестко очищаем корзину. Это предотвратит продажу по чужому прайсу 
    // (например, если первый клиент был дилером, а второй - розничным).
    const isEditMode = Boolean(window.editingOrderId);
    if (typeof cart !== 'undefined' && cart.length > 0 && !window.isSalesOrderEditInitialLoad && !isEditMode) {
        clearOrderForm(); // 🚀 ПОЛНАЯ ОЧИСТКА ВСЕХ ПОЛЕЙ И КОРЗИНЫ
        UI.toast('Внимание! Корзина и данные доставки очищены из-за смены контрагента', 'warning');
        // После полной очистки клиент уже сброшен: не продолжаем загрузку профиля/договоров
        // для старого значения cpId из начала обработчика.
        return;
    }

    // Комментарий к блоку: Обработка сброса.
    // Если поле клиента очистили (нажали на крестик или стерли текст), 
    // просто прячем розовую карточку и блок договоров.
    if (!cpId) {
        window.CLIENT_AVAILABLE_ADVANCE = 0;
        window.CLIENT_PREFERRED_OFFSET_ACCOUNT_ID = null;
        window.CLIENT_IS_EMPLOYEE = false;
        if (infoBox) infoBox.classList.add('sales-hidden');
        if (contractGroup) contractGroup.classList.add('d-none');
        return;
    }

    // Комментарий к блоку: Загрузка связанных данных (договоры и доверенности)
    await loadClientContracts(cpId);
    if (typeof loadClientPoas === 'function') await loadClientPoas();

    if (typeof updateSaleMaxQty === 'function') updateSaleMaxQty();

    try {
        // Комментарий к блоку: Запрос профиля клиента с сервера
        let data;
        try {
            data = await API.get(`/api/counterparties/${cpId}/profile`);
        } catch (e) {
            if (isCounterpartyNotFoundError(e)) {
                UI.toast('Контрагент не найден (возможно, был удален). Обновляем список...', 'warning');
                if (typeof syncClientsDropdown === 'function') {
                    await syncClientsDropdown();
                }
                if (clientSelect && clientSelect.tomselect) {
                    clientSelect.tomselect.setValue('', true);
                } else if (clientSelect) {
                    clientSelect.value = '';
                }
                if (infoBox) infoBox.classList.add('d-none');
                if (contractGroup) contractGroup.classList.add('d-none');
                return;
            }
            throw e;
        }

        const client = data.info;

        // ЗАГРУЗКА АВАНСА КЛИЕНТА ПЕРЕД ОТРИСОВКОЙ (Для расчета Net Debt)
        let availableAdvance = 0;
        try {
            const balData = await API.get(`/api/counterparties/${cpId}/balance`);
            availableAdvance = parseFloat(balData.availableAdvance) || 0;
            window.CLIENT_PREFERRED_OFFSET_ACCOUNT_ID = balData.preferredOffsetAccountId || null;
            window.CLIENT_IS_EMPLOYEE = Boolean(balData.isEmployee);
        } catch (e) { console.error('Ошибка загрузки аванса клиента:', e); }
        window.CLIENT_AVAILABLE_ADVANCE = availableAdvance;
        salesSelectPreferredAccount();

        // Показ блока выбора аванса в счет оплаты
        const offsetGroup = document.getElementById('sale-offset-group');
        const offsetMaxEl = document.getElementById('sale-offset-max');
        if (offsetGroup) {
            if (availableAdvance > 0) {
                offsetGroup.classList.remove('sales-hidden');
                if (offsetMaxEl) offsetMaxEl.innerText = availableAdvance.toLocaleString('ru-RU', { minimumFractionDigits: 2 }) + ' ₽';
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
                <div class="flex-between align-start gap-10 mb-10 pb-10 border-bottom dashed flex-wrap" >
                    <div class="flex-row gap-10 align-start flex-grow-1" >
                        <i class="fas fa-building text-primary font-18 mt-3"></i>
                        <div class="flex-column" >
                            <span class="font-bold font-13 text-primary d-block" >${client.name}</span>
                            <div class="mt-5">${badgeHtml}</div>
                        </div>
                    </div>
                    <button class="btn btn-outline p-5 px-10 font-11 text-primary bg-surface flex-shrink-0 border-primary" onclick="openClientEditor(${cpId})">
                        ⚙️ Карточка
                    </button>
                </div>
                <div class="flex-row justify-between align-start gap-15 flex-wrap mt-10">
                    <div class="client-stat-box flex-grow-1" >
                        <span class="text-muted font-11 block mb-3">Баланс контрагента:</span>
                        <strong class="font-14 d-block font-14 d-block ${debtColor === 'var(--danger)' ? 'text-danger' : 'text-success'}">${debtText}</strong>
                    </div>
                    <div class="client-stat-box flex-grow-1" >
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
        const data = await API.get(`/api/counterparties/${id}/profile`);
        const c = data.info;

        const isDealer = c.price_level === 'dealer';
        const badgeHtml = isDealer
            ? `<div class="bg-info-lt text-info p-10 border-radius-6 text-center font-14 font-bold mb-15 border-info dashed">👑 ТЕКУЩИЙ СТАТУС: ДИЛЕР (Оптовые цены)</div>`
            : `<div class="bg-surface-hover text-muted p-10 border-radius-6 text-center font-14 font-bold mb-15 border dashed">👤 ТЕКУЩИЙ СТАТУС: БАЗОВЫЙ ПРАЙС (Розница)</div>`;

        const html = `
            <div class="p-10 overflow-auto max-h-70vh">
                ${badgeHtml}
                <div class="form-grid gap-15 sales-two-cols">
                    <div class="form-group grid-span-2">
                        <label>Наименование клиента:</label>
                        <input type="tel" id="edit-cp-name" class="input-modern" value="${c.name || ''}">
                    </div>
                    
                    <div class="form-group">
                        <label>Уровень цен (Прайс):</label>
                        <select id="edit-cp-level" class="input-modern text-info font-bold border-info">
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
    if (data.phone && !Utils.isValidPhone(data.phone)) return UI.toast('Некорректный номер телефона (минимум 10 цифр).', 'warning');

    try {
        await API.put(`/api/counterparties/${id}`, data);
        UI.closeModal();
        UI.toast('✅ Карточка успешно обновлена', 'success');
        await syncClientsDropdown(id);
        await loadSalesData(false);
    } catch (e) { /* ошибка: UI.toast из API */ }
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
    void window.openPrintUrl(`/print/act?cpId=${cpId}&start=${start}&end=${end}`);
    UI.closeModal();
};

window.loadClientPoas = async function (explicitCpId = null, targetSelectId = 'sale-poa') {
    const cpId = explicitCpId || document.getElementById('sale-client').value;
    const poaSelect = document.getElementById(targetSelectId);
    if (!cpId) { if (poaSelect) poaSelect.innerHTML = '<option value="">-- Выберите клиента --</option>'; return; }
    if (!poaSelect) return;

    try {
        const data = await API.get(`/api/counterparties/${cpId}/poas`);
        let defaultText = targetSelectId === 'oms-poa' ? 'Лично / Без доверенности' : '-- Выберите доверенность --';
        poaSelect.innerHTML = `<option value="">${defaultText}</option>`;
        data.forEach(poa => {
            const isExpired = new Date(poa.expiry_date) < new Date();
            const poaString = `№${poa.number} от ${poa.issue_date} (выдана: ${poa.driver_name})`;
            const poaDisplay = `${poa.driver_name} — №${poa.number} (до ${poa.expiry_date})${isExpired ? ' [ПРОСРОЧЕНО]' : ''}`;
            poaSelect.add(new Option(poaDisplay, poaString));
        });
    } catch (e) { console.error(e); }
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
        return;
    }

    // Вычисляем "К оплате сейчас" (живые деньги)
    const totalStr = document.getElementById('cart-total-sum')?.innerText || '0';
    const totalSum = parseFloat(totalStr.replace(/[^\d.,]/g, '').replace(',', '.')) || 0;
    const offsetVal = (offsetCheck?.checked && offsetAmountEl) ? (parseFloat(offsetAmountEl.value) || 0) : 0;
    const payNow = totalSum - offsetVal;

    const isEmployeeCounterparty = Boolean(window.CLIENT_IS_EMPLOYEE);
    if (offsetCheck?.checked && isEmployeeCounterparty) {
        // При зачете касса всегда нужна: должны пройти 2 движения (приход продажи + выдача аванса).
        accountGroup.classList.remove('sales-hidden');
        const lbl = accountGroup.querySelector('label');
        if (lbl) lbl.innerHTML = 'Касса / Банк:';
        salesSelectPreferredAccount();
    } else if (methodVal === 'paid' || methodVal === 'partial' || (offsetCheck?.checked && payNow > 0.01)) {
        // Есть живые деньги → касса обязательна
        accountGroup.classList.remove('sales-hidden');
        const lbl = accountGroup.querySelector('label');
        if (lbl) lbl.innerHTML = 'Касса / Банк:';
        salesSelectPreferredAccount();
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
        costEl.classList.toggle('text-primary', total > 0); costEl.classList.toggle('text-muted', total <= 0);
    }
};

// 🚚 Переключатель Доставка / Самовывоз

// 💰 Обработчик чекбокса "Зачесть аванс"
window.toggleOffsetInput = function () {
    const check = document.getElementById('sale-offset-check');
    const amountEl = document.getElementById('sale-offset-amount');
    const wrap = document.getElementById('sale-offset-input-wrap');
    if (!check || !amountEl || !wrap) return;

    if (check.checked) {
        wrap.classList.remove('sales-hidden');
        amountEl.disabled = false;
        const totalStr = document.getElementById('cart-total-sum')?.innerText || '0';
        const totalSum = parseFloat(totalStr.replace(/[^\d.,]/g, '').replace(',', '.')) || 0;
        const maxOffset = Math.min(window.CLIENT_AVAILABLE_ADVANCE, totalSum);
        amountEl.value = maxOffset > 0 ? maxOffset.toFixed(2) : '';
        amountEl.max = maxOffset;
        salesSelectPreferredAccount();
    } else {
        wrap.classList.add('sales-hidden');
        amountEl.disabled = true;
        amountEl.value = '';
    }
    updateOffsetSummary();
    renderCart(); // Will call smartAccountToggle internally
};

// 💰 Обновление блока "К оплате сейчас"
window.updateOffsetSummary = function () {
    const check = document.getElementById('sale-offset-check');
    const amountEl = document.getElementById('sale-offset-amount');
    const summaryEl = document.getElementById('cart-offset-summary');
    const offsetSumEl = document.getElementById('cart-offset-sum');
    const payNowEl = document.getElementById('cart-pay-now');
    const remainderEl = document.getElementById('sale-offset-remainder');
    const paymentMethodGroup = document.getElementById('sale-payment-method-group');
    const paymentMethodSelect = document.getElementById('sale-payment-method');

    const totalStr = document.getElementById('cart-total-sum')?.innerText || '0';
    const totalSum = parseFloat(totalStr.replace(/[^\d.,]/g, '').replace(',', '.')) || 0;

    let offsetVal = 0;
    let payNow = totalSum;
    
    if (check?.checked && amountEl) {
        offsetVal = parseFloat(amountEl.value) || 0;
        
        // Корректировка, если ввели больше дозволенного
        const maxOffset = Math.min(window.CLIENT_AVAILABLE_ADVANCE, totalSum);
        if (offsetVal > maxOffset) {
            offsetVal = maxOffset;
            amountEl.value = offsetVal.toFixed(2);
            UI.toast(`Максимальная сумма зачёта: ${maxOffset.toFixed(2)} ₽`, 'warning');
        }
        if (offsetVal < 0) { offsetVal = 0; amountEl.value = '0'; }
        
        payNow = Math.max(0, totalSum - offsetVal);

        if (summaryEl) summaryEl.classList.remove('sales-hidden');
        if (offsetSumEl) offsetSumEl.innerText = offsetVal.toLocaleString('ru-RU', { minimumFractionDigits: 2 });
        if (payNowEl) payNowEl.innerText = payNow.toLocaleString('ru-RU', { minimumFractionDigits: 2 });
        if (remainderEl) remainderEl.innerText = payNow.toLocaleString('ru-RU', { minimumFractionDigits: 2 }) + ' ₽';
    } else {
        if (summaryEl) summaryEl.classList.add('sales-hidden');
        if (remainderEl) remainderEl.innerText = '0 ₽';
    }
    
    // Hide payment method if fully paid by offset
    if (paymentMethodGroup) {
        if (payNow === 0 && totalSum > 0) {
            paymentMethodGroup.classList.add('sales-hidden');
            if (paymentMethodSelect) paymentMethodSelect.value = 'paid';
            if (window.toggleSalePayment) window.toggleSalePayment();
        } else {
            paymentMethodGroup.classList.remove('sales-hidden');
            if (paymentMethodSelect && payNow > 0 && paymentMethodSelect.value === 'paid' && offsetVal > 0) {
                 paymentMethodSelect.value = 'partial';
            }
            if (window.toggleSalePayment) window.toggleSalePayment();
        }
    }
    
    if (typeof smartAccountToggle === 'function') smartAccountToggle();
};

window.toggleSalePayment = function () {
    const method = document.getElementById('sale-payment-method')?.value;
    const advanceGroup = document.getElementById('sale-advance-group');
    const accountGroup = document.getElementById('sale-account-group');
    
    if (!advanceGroup || !accountGroup) return;

    if (method === 'debt') {
        advanceGroup.classList.add('sales-hidden');
        accountGroup.classList.add('sales-hidden');
    } else if (method === 'paid') {
        advanceGroup.classList.add('sales-hidden');
        accountGroup.classList.remove('sales-hidden');
    } else if (method === 'partial') {
        advanceGroup.classList.remove('sales-hidden');
        accountGroup.classList.remove('sales-hidden');
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

window.openPoaManager = function (explicitCpId = null, targetSelectId = 'sale-poa') {
    const cpId = explicitCpId || (document.getElementById('sale-client') ? document.getElementById('sale-client').value : null);
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
    // We pass explicitCpId inside quotes to ensure it survives HTML rendering, and same for targetSelectId
    UI.showModal('Новая доверенность', html, `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-blue" onclick="saveNewPoa(${cpId}, '${targetSelectId}')">💾 Сохранить</button>
    `);
};

window.saveNewPoa = async function (cpId, targetSelectId = 'sale-poa') {
    const driver = document.getElementById('new-poa-driver').value.trim();
    const num = document.getElementById('new-poa-num').value.trim();
    const issue = document.getElementById('new-poa-issue').value;
    const expiry = document.getElementById('new-poa-expiry').value;

    if (!driver || !num || !issue || !expiry) return UI.toast('Заполните все поля!', 'warning');
    if (new Date(expiry) < new Date(issue)) return UI.toast('Дата окончания не может быть раньше даты выдачи!', 'error');

    try {
        await API.post('/api/poas', { counterparty_id: cpId, driver_name: driver, number: num, issue_date: issue, expiry_date: expiry });
        UI.toast('Доверенность добавлена', 'success');
        loadClientPoas(cpId, targetSelectId);
        UI.closeModal();
    } catch (e) { /* API — тост */ }
};

window.printSelectedContract = function () {
    const select = document.getElementById('sale-contract');
    if (!select || select.selectedIndex < 0) return UI.toast('Выберите договор!', 'warning');
    const cid = select.options[select.selectedIndex].getAttribute('data-cid');
    if (!cid) return UI.toast('Этот пункт нельзя распечатать', 'warning');
    void window.openPrintUrl(`/print/contract?id=${cid}`);
};

// === НОВЫЙ МОДУЛЬ: УМНАЯ СИНХРОНИЗАЦИЯ КЛИЕНТОВ ===
// 1. Исправленная синхронизация клиентов (без рекурсии)
window.syncClientsDropdown = async function (forceSelectId = null) {
    try {
        const clients = await API.get('/api/counterparties');
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

            const accounts = await API.get('/api/accounts');
            const accSel = document.getElementById('sale-account');
            if (accSel) {
                if (accSel.tomselect) {
                    accSel.tomselect.clearOptions();
                    accounts.filter(a => a.type !== 'imprest').forEach(a => accSel.tomselect.addOption({value: a.id, text: `${a.name} (${a.balance} ₽)`}));
                    accSel.tomselect.refreshOptions(false);
                } else {
                    accSel.innerHTML = '';
                    accounts.filter(a => a.type !== 'imprest').forEach(a => accSel.add(new Option(`${a.name} (${a.balance} ₽)`, a.id)));
                }
            }

            const products = await API.get('/api/products');
            window.salesProductsInfo = {};
            products.forEach(p => salesProductsInfo[String(p.id)] = p);
        }

        const inventory = await API.get('/api/inventory');
        stockMap = {};

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

        const isMarkdownDefaultProduct = (product, markdownWhId) => {
            const defWh = Number(product.default_warehouse_id);
            const mdWh = Number(markdownWhId);
            return Number.isInteger(defWh) && defWh > 0 && Number.isInteger(mdWh) && mdWh > 0 && defWh === mdWh;
        };

        Object.values(salesProductsInfo).forEach(p => {
            const price = parseFloat(p.price || p.current_price || 0);
            const dealerPrice = parseFloat(p.dealer_price || 0);
            const pieceRate = parseFloat(p.piece_rate || 0);

            const stockFinished = inventoryMap[p.name] ? (inventoryMap[p.name].finished || 0) : 0;
            const stockMarkdown = inventoryMap[p.name] ? (inventoryMap[p.name].markdown || 0) : 0;
            const reserved = inventoryMap[p.name] ? (inventoryMap[p.name].reserve || 0) : 0;

            const whFinished = window.WAREHOUSE_IDS['finished'] || 4;
            const whMarkdown = window.WAREHOUSE_IDS['markdown'] || 5;
            const useMarkdownWarehouse = isMarkdownDefaultProduct(p, whMarkdown);

            if (currentSalesWarehouse === 'all') {
                if (useMarkdownWarehouse) {
                    stockMap[p.name] = { id: p.id, warehouseId: whMarkdown, name: p.name, unit: p.unit, qty: stockMarkdown, reserved: 0, price: price, dealer_price: dealerPrice, piece_rate: pieceRate, weight: parseFloat(p.weight_kg || 0), sortLabel: '2 сорт', allowProduction: false };
                } else {
                    stockMap[p.name] = { id: p.id, warehouseId: whFinished, name: p.name, unit: p.unit, qty: stockFinished, reserved, price, dealer_price: dealerPrice, piece_rate: pieceRate, weight: parseFloat(p.weight_kg || 0), sortLabel: 'Авто', allowProduction: true };
                }
            } else if (currentSalesWarehouse === '4' && stockFinished > 0 && !useMarkdownWarehouse) {
                stockMap[p.name] = { id: p.id, warehouseId: whFinished, name: p.name, unit: p.unit, qty: stockFinished, reserved, price, dealer_price: dealerPrice, piece_rate: pieceRate, weight: parseFloat(p.weight_kg || 0), sortLabel: '1 сорт', allowProduction: false };
            } else if (currentSalesWarehouse === '5' && stockMarkdown > 0) {
                const finalPrice = useMarkdownWarehouse ? price : Math.floor(price * 0.7);
                const finalDealer = useMarkdownWarehouse ? dealerPrice : Math.floor(dealerPrice * 0.7);
                stockMap[p.name] = { id: p.id, warehouseId: whMarkdown, name: p.name, unit: p.unit, qty: stockMarkdown, reserved: 0, price: finalPrice, dealer_price: finalDealer, piece_rate: pieceRate, weight: parseFloat(p.weight_kg || 0), sortLabel: useMarkdownWarehouse ? '2 сорт' : 'Уценка', allowProduction: false };
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
            maxOptions: 500,
            plugins: ['clear_button'],
            placeholder: 'Начните вводить название...',
            score: function(search) {
                // ЕСЛИ ПОИСК ПУСТОЙ — НЕ ЛОМАЕМ АЛФАВИТНЫЙ ПОРЯДОК
                if (!search) return function() { return 1; };

                const query = search.toLowerCase();
                const queryCondensed = query.replace(/[\.\s-]/g, '');
                const tokens = query.split(/\s+/).filter(Boolean);
                
                return function(item) {
                    const text = (item.text || '').toLowerCase();
                    const textCondensed = text.replace(/[\.\s-]/g, '');
                    
                    let multiTargetMatch = true;
                    for (let token of tokens) {
                        let tokenCondensed = token.replace(/[\.\s-]/g, '');
                        if (!text.includes(token) && (!tokenCondensed || !textCondensed.includes(tokenCondensed))) {
                            multiTargetMatch = false;
                            break;
                        }
                    }

                    if (!multiTargetMatch) {
                        if (queryCondensed.length < 2 || !textCondensed.includes(queryCondensed)) {
                            return 0;
                        }
                    }
                    
                    let baseScore = 100 / (text.length + 1); // Базовый скор: чем короче строка, тем выше
                    
                    // Если строка целиком содержит "2к6" без пробелов - приоритет сильно выше
                    if (queryCondensed.length >= 2 && textCondensed.includes(queryCondensed)) {
                        baseScore += 1000;
                    }
                    
                    return baseScore; 
                };
            },
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
            onDropdownOpen: function (dropdown) {
                var content = dropdown.querySelector('.ts-dropdown-content');
                var selected = content && content.querySelector('.active, .selected');
                if (selected && content) {
                    setTimeout(function () {
                        content.scrollTop = selected.offsetTop - (content.clientHeight / 2) + (selected.clientHeight / 2);
                    }, 0);
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

window.openProfitCalculator = async function() {
    if (!currentSelectedItem) return UI.toast('Выберите товар из списка!', 'warning');
    
    const qty = parseFloat(document.getElementById('sale-qty').value) || 1;
    const price = parseFloat(document.getElementById('sale-price').value) || 0;
    
    UI.toast('Ожидайте, загружаю данные себестоимости...', 'info');
    
    try {
        const data = await API.get(`/api/sales/cost-analysis/${currentSelectedItem.id}`);
        
        const baseMatCost = parseFloat(data.empirical) > 0 ? parseFloat(data.empirical) : parseFloat(data.theoretical);
        const pieceRate = parseFloat(currentSelectedItem.piece_rate) || 0;
        const amortization = parseFloat(data.amortization) || 0;
        const overhead = parseFloat(data.overhead) || 0;
        
        const unitCost = baseMatCost + amortization + overhead + pieceRate;
        const totalCost = unitCost * qty;
        const totalRevenue = price * qty;
        const profit = totalRevenue - totalCost;
        const marginPercent = totalRevenue > 0 ? (profit / totalRevenue * 100).toFixed(2) : 0;
        
        const html = `
            <div class="p-10">
                <h4 class="mt-0 mb-15">Товар: ${Utils.escapeHtml(currentSelectedItem.name)}</h4>
                
                <table class="table-modern w-100 mb-20 text-left">
                    <thead class="bg-surface-alt">
                        <tr>
                            <th class="p-10 font-12 text-muted">Статья затрат (на 1 ${currentSelectedItem.unit})</th>
                            <th class="p-10 text-right font-12 text-muted">Сумма (₽)</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr><td class="p-10">Сырье и материалы</td><td class="p-10 text-right font-bold">${baseMatCost.toLocaleString('ru-RU')} ₽</td></tr>
                        <tr><td class="p-10">Сдельная ЗП</td><td class="p-10 text-right font-bold">${pieceRate.toLocaleString('ru-RU')} ₽</td></tr>
                        <tr><td class="p-10">Амортизация</td><td class="p-10 text-right font-bold">${amortization.toLocaleString('ru-RU')} ₽</td></tr>
                        <tr><td class="p-10">Накладные расходы</td><td class="p-10 text-right font-bold">${overhead.toLocaleString('ru-RU')} ₽</td></tr>
                        <tr class="bg-surface-alt font-bold">
                            <td class="p-10 border-top">Итого полная себестоимость за ед.</td>
                            <td class="p-10 text-right text-primary border-top">${unitCost.toLocaleString('ru-RU', {minimumFractionDigits: 2})} ₽</td>
                        </tr>
                    </tbody>
                </table>
                
                <div class="card p-15 border m-0 mt-5">
                    <div class="flex-between mb-10"><span class="text-muted">Продаваемое количество:</span> <strong>${qty} ${currentSelectedItem.unit}</strong></div>
                    <div class="flex-between mb-10"><span class="text-muted">Цена продажи (за ед.):</span> <strong>${price.toLocaleString('ru-RU')} ₽</strong></div>
                    <hr>
                    <div class="flex-between mb-10"><span class="text-muted">Выручка (сумма):</span> <strong>${totalRevenue.toLocaleString('ru-RU')} ₽</strong></div>
                    <div class="flex-between mb-10"><span class="text-muted">Общая себестоимость:</span> <strong>${totalCost.toLocaleString('ru-RU', {minimumFractionDigits:2})} ₽</strong></div>
                    
                    <div class="flex-between mt-15 pt-15 border-top">
                        <span class="font-bold text-main">Прогноз маржинальности:</span>
                        <strong class="font-18 ${profit > 0 ? 'text-success' : 'text-danger'}">
                            ${profit > 0 ? '+' : ''}${profit.toLocaleString('ru-RU', {minimumFractionDigits:2})} ₽ (${marginPercent}%)
                        </strong>
                    </div>
                </div>
            </div>
        `;
        
        UI.showModal('📊 Калькулятор себестоимости', html);
        
    } catch (e) {
        console.error(e);
        UI.toast('Не удалось получить себестоимость.', 'error');
    }
};
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

    let baseMatCost = 0, pieceRate = 0, amortization = 0, overhead = 0;
    try {
        const data = await API.get(`/api/sales/cost-analysis/${currentSelectedItem.id}`);

        baseMatCost = parseFloat(data.empirical) > 0 ? parseFloat(data.empirical) : parseFloat(data.theoretical);
        pieceRate = parseFloat(currentSelectedItem.piece_rate) || 0;
        amortization = parseFloat(data.amortization) || 0;
        overhead = parseFloat(data.overhead) || 0;

        unitCost = baseMatCost + amortization + overhead + pieceRate;
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
        unitCost: unitCost,
        baseMatCost: baseMatCost,
        amortization: amortization,
        overhead: overhead,
        wage: pieceRate
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
    if (liveCostEl) { liveCostEl.innerText = '0 ₽'; liveCostEl.classList.add('text-muted'); liveCostEl.classList.remove('text-primary', 'text-success', 'text-danger'); }
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

        resetRecipePalletsSummaryUi();

        const grandHint = document.getElementById('cart-grand-hint');
        if (grandHint) {
            grandHint.classList.add('d-none');
            grandHint.textContent = '';
        }

        // Прячем финансовый контроллер
        const profitInfo = document.getElementById('cart-profit-info');
        if (profitInfo) profitInfo.classList.add('d-none');
        const profitSummary = document.getElementById('cart-profit-summary');
        if (profitSummary) profitSummary.classList.add('sales-hidden');

        return;
    }

    let subtotal = 0;
    let totalProductionCost = 0;
    const useFinance = document.getElementById('cart-include-finance')?.checked !== false;
    const safeTaxPct = useFinance ? (parseFloat(window.FINANCE_TAX_PERCENT) || 0) : 0;

    // Структура для попродуктовой разбивки
    const productProfitMap = {};
    const productCostBreakdownMap = {};

    // БЛОК 2: ОТРИСОВКА СТРОК ТАБЛИЦЫ
    tbody.innerHTML = cart.map((item, index) => {
        const qty = parseFloat(item.qty) || 0;
        const basePrice = parseFloat(item.price) || 0;
        const discount = parseFloat(item.discount) || 0;
        const currentOverhead = useFinance ? (parseFloat(item.overhead) || 0) : 0;
        const unitCost = (parseFloat(item.baseMatCost) || 0) + (parseFloat(item.amortization) || 0) + (parseFloat(item.wage) || 0) + currentOverhead;

        const finalPrice = basePrice * (1 - discount / 100);
        const sum = qty * finalPrice;
        const costSum = qty * unitCost;

        // Чистая прибыль по позиции (ПОСЛЕ налога)
        const lineTax = sum * (safeTaxPct / 100);
        const lineNetProfit = sum - costSum - lineTax;

        subtotal += sum;
        totalProductionCost += costSum;

        // Агрегация по продукту
        const pKey = item.name;
        if (!productProfitMap[pKey]) productProfitMap[pKey] = { revenue: 0, cost: 0, tax: 0, profit: 0 };
        productProfitMap[pKey].revenue += sum;
        productProfitMap[pKey].cost += costSum;
        productProfitMap[pKey].tax += lineTax;
        productProfitMap[pKey].profit += lineNetProfit;

        // Развернутая агрегация себестоимости
        if (!productCostBreakdownMap[pKey]) productCostBreakdownMap[pKey] = {
            qty: 0, costSum: 0, matSum: 0, amortSum: 0, overSum: 0, wageSum: 0
        };
        productCostBreakdownMap[pKey].qty += qty;
        productCostBreakdownMap[pKey].costSum += costSum;
        productCostBreakdownMap[pKey].matSum += qty * (parseFloat(item.baseMatCost) || 0);
        productCostBreakdownMap[pKey].amortSum += qty * (parseFloat(item.amortization) || 0);
        productCostBreakdownMap[pKey].overSum += qty * currentOverhead;
        productCostBreakdownMap[pKey].wageSum += qty * (parseFloat(item.wage) || 0);

        const unitEsc = Utils.escapeHtml(item.unit || '');
        const priceBaseSub = discount > 0
            ? `<s title="Каталожная базовая цена">${basePrice} ₽</s>`
            : '';
        return `
            <tr class="sales-cart-row">
                <td>${item.sortLabel || '1 Сорт'}</td>
                <td><b>${item.name}</b></td>
                <td class="text-center sales-cart-td-num">
                    <div class="sales-cart-num-cell-stack">
                        <div class="sales-cart-num-cell-input-row">
                            <div class="sales-cart-inline-num">
                                <input type="number" class="input-modern sales-cart-qty-input text-center" value="${qty}" min="0.01" step="0.01"
                                       onfocus="this.select()" onchange="updateCartItem(${index}, 'qty', this.value)">
                                <span class="font-12 text-muted sales-cart-unit-inline">${unitEsc}</span>
                            </div>
                        </div>
                        <div class="sales-cart-num-cell-sub font-10 text-muted">&nbsp;</div>
                    </div>
                </td>
                <td class="text-center sales-cart-td-num">
                    <div class="sales-cart-num-cell-stack">
                        <div class="sales-cart-num-cell-input-row">
                            <input type="number" class="input-modern sales-cart-price-input" 
                                   value="${finalPrice % 1 === 0 ? finalPrice : finalPrice.toFixed(2)}" 
                                   onfocus="this.select()" onchange="updateCartItem(${index}, 'finalPrice', this.value)">
                        </div>
                        <div class="sales-cart-num-cell-sub font-10 text-muted">${priceBaseSub || '&nbsp;'}</div>
                    </div>
                </td>
                <td class="text-center sales-cart-td-num">
                    <div class="sales-cart-num-cell-stack">
                        <div class="sales-cart-num-cell-input-row">
                            <input type="number" class="input-modern sales-cart-discount-input" 
                                   value="${discount}" min="0" max="100" 
                                   onfocus="this.select()" onchange="updateCartItem(${index}, 'discount', this.value)">
                        </div>
                        <div class="sales-cart-num-cell-sub font-10 text-muted">&nbsp;</div>
                    </div>
                </td>
                <td class="sales-cart-sum whitespace-nowrap">
                    ${sum.toFixed(2)} ₽
                    ${unitCost > 0 ? `<div class="font-10 ${lineNetProfit >= 0 ? 'text-success' : 'text-danger'}" title="Чистая прибыль (после налога ${safeTaxPct}%)">= ${lineNetProfit >= 0 ? '+' : ''}${lineNetProfit.toFixed(0)} ₽</div>` : ''}
                </td>
                <td class="text-center"><button class="sales-cart-remove" onclick="removeFromCart(${index})">✖</button></td>
            </tr>
        `;
    }).join('');

    // БЛОК 3: БАЗОВАЯ МАТЕМАТИКА ЧЕКА
    const globalDiscount = parseFloat(document.getElementById('sale-discount').value) || 0;
    const logistics = getEffectiveLogisticsCost();

    const finalProductRevenue = subtotal * (1 - globalDiscount / 100);
    const finalTotal = finalProductRevenue + logistics;

    const grandHint = document.getElementById('cart-grand-hint');
    if (grandHint) {
        if (logistics > 0.001) {
            grandHint.classList.remove('d-none');
            grandHint.textContent = `в т. ч. доставка: ${logistics.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} ₽`;
        } else {
            grandHint.classList.add('d-none');
            grandHint.textContent = '';
        }
    }

    scheduleRecipePalletsEstimate();

    const goodsSumEl = document.getElementById('cart-goods-sum');
    if (goodsSumEl) goodsSumEl.innerText = subtotal.toLocaleString('ru-RU') + ' ₽';

    const originalSumEl = document.getElementById('cart-original-sum');
    if (originalSumEl) {
        if (globalDiscount > 0) {
            originalSumEl.innerText = subtotal.toLocaleString('ru-RU') + ' ₽';
            originalSumEl.classList.remove('d-none');
        } else {
            originalSumEl.classList.add('d-none');
        }
    }

    document.getElementById('cart-total-sum').innerText = finalTotal.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
    
    // ==================================================
    // 🚀 БЛОК 4: ПРИБЫЛЬ В КОРЗИНЕ
    // ==================================================
    const taxCost = finalProductRevenue * (safeTaxPct / 100);
    const netProfit = finalProductRevenue - totalProductionCost - taxCost;
    
    const costEl = document.getElementById('cart-total-cost');
    if (costEl) costEl.innerText = totalProductionCost.toLocaleString('ru-RU', { minimumFractionDigits: 2 });

    // 🚀 Детализация себестоимости под итоговой суммой
    const costBlock = document.getElementById('top-cart-cost-block');
    if (costBlock) {
        let bdHtml = '';
        const pKeys = Object.keys(productCostBreakdownMap);
        if (pKeys.length > 0 && totalProductionCost > 0) {
            bdHtml += `
                <section class="sales-profit-section" aria-label="Детализация рентабельности">
                    <header class="sales-profit-section-head">
                        <h4 class="sales-profit-section-title">📊 Детализация рентабельности по позициям</h4>
                        <p class="sales-profit-section-desc">Структура затрат и чистая прибыль по номенклатуре после скидок в корзине.</p>
                    </header>
                    <div class="sales-profit-cards">
            `;
            pKeys.forEach((key) => {
                const b = productCostBreakdownMap[key];
                const p = productProfitMap[key] || { revenue: 0, cost: 0, tax: 0, profit: 0 };
                const keyEsc = Utils.escapeHtml(key);
                const rev = p.revenue.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                const mat = b.matSum.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                const wage = b.wageSum.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                const amort = b.amortSum.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                const overTax = (b.overSum + p.tax).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                const costSumStr = b.costSum.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                const profitStr = p.profit.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                const qtyNum = Number(b.qty);
                const qtyDisp = Number.isFinite(qtyNum) && qtyNum % 1 === 0 ? String(qtyNum) : (Number.isFinite(qtyNum) ? qtyNum.toLocaleString('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 2 }) : String(b.qty));

                bdHtml += `
                    <article class="sales-profit-card">
                        <header class="sales-profit-card-head">
                            <div class="sales-profit-card-title-col min-w-0">
                                <span class="sales-profit-card-name">${keyEsc}</span>
                                <span class="sales-profit-card-meta">${qtyDisp} ед. в заказе</span>
                            </div>
                            <div class="sales-profit-card-revenue-block text-right">
                                <span class="sales-profit-card-revenue-label">Выручка (со скидками)</span>
                                <strong class="sales-profit-card-revenue-value">${rev} ₽</strong>
                            </div>
                        </header>
                        <div class="sales-profit-metrics" role="list">
                            <div class="sales-profit-metric" role="listitem">
                                <span class="sales-profit-metric-label">Сырьё и материалы</span>
                                <span class="sales-profit-metric-value">${mat} ₽</span>
                            </div>
                            <div class="sales-profit-metric" role="listitem">
                                <span class="sales-profit-metric-label">Сдельная ЗП</span>
                                <span class="sales-profit-metric-value">${wage} ₽</span>
                            </div>
                            <div class="sales-profit-metric" role="listitem">
                                <span class="sales-profit-metric-label">Амортизация</span>
                                <span class="sales-profit-metric-value">${amort} ₽</span>
                            </div>
                            <div class="sales-profit-metric sales-profit-metric--accent" role="listitem">
                                <span class="sales-profit-metric-label">Оверхед и налог</span>
                                <span class="sales-profit-metric-value">${overTax} ₽</span>
                            </div>
                        </div>
                        <footer class="sales-profit-card-foot">
                            <span class="sales-profit-foot-cost">Себестоимость позиции: <strong>${costSumStr} ₽</strong></span>
                            <span class="sales-profit-foot-badge ${p.profit > 0 ? 'sales-profit-foot-badge--ok' : (p.profit < -0.01 ? 'sales-profit-foot-badge--bad' : 'sales-profit-foot-badge--flat')}">
                                Прибыль ${p.profit > 0 ? '+' : ''}${profitStr} ₽
                            </span>
                        </footer>
                    </article>
                `;
            });
            bdHtml += `
                    </div>`;

            if (pKeys.length > 1) {
                const netStr = netProfit.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                const totalCls =
                    netProfit > 0.01 ? 'sales-profit-total-strip--gain' : (netProfit < -0.01 ? 'sales-profit-total-strip--loss' : 'sales-profit-total-strip--flat');
                bdHtml += `
                    <div class="sales-profit-total-strip ${totalCls}">
                        <span class="sales-profit-total-label">Всего прибыль по чеку (после налога ${safeTaxPct}%)</span>
                        <strong class="sales-profit-total-value">${netProfit > 0 ? '+' : ''}${netStr} ₽</strong>
                    </div>
                `;
            }
            bdHtml += `</section>`;
        }

        let detailsEl = document.getElementById('cart-cost-details-breakdown');
        if (!detailsEl) {
            detailsEl = document.createElement('div');
            detailsEl.id = 'cart-cost-details-breakdown';
            costBlock.appendChild(detailsEl);
        }
        detailsEl.innerHTML = bdHtml;
    }
    
    const profitEl = document.getElementById('cart-total-profit');
    const profitPctEl = document.getElementById('cart-profit-percent');
    if (profitEl && profitPctEl) {
        let pct = finalProductRevenue > 0 ? (netProfit / finalProductRevenue * 100) : 0;
        
        profitEl.innerText = (netProfit > 0 ? '+' : '') + netProfit.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
        profitEl.classList.toggle('text-success', netProfit >= 0); profitEl.classList.toggle('text-danger', netProfit < 0);
        
        profitPctEl.innerText = pct.toFixed(1);
    }

    const logSumEl = document.getElementById('cart-logistics-sum');
    if (logSumEl) logSumEl.innerText = logistics.toLocaleString('ru-RU') + ' ₽';

    if (typeof updateOffsetSummary === 'function') updateOffsetSummary();
    if (typeof smartAccountToggle === 'function') smartAccountToggle();

    const marginPct = finalProductRevenue > 0 ? ((netProfit / finalProductRevenue) * 100).toFixed(1) : 0;

    const profitSummary = document.getElementById('cart-profit-summary');
    if (profitSummary) {
        if (totalProductionCost > 0) {
            profitSummary.classList.remove('sales-hidden');
            const isProfitable = netProfit >= 0;

            // Стили заголовка
            const header = document.getElementById('cart-profit-header');
            if (header) {
                header.classList.add('sales-profit-header');
                header.classList.toggle('sales-profit-header--profit', isProfitable);
                header.classList.toggle('sales-profit-header--loss', !isProfitable);
            }

            document.getElementById('cart-profit-tax-pct').innerText = safeTaxPct;

            const profitTotalEl = document.getElementById('cart-profit-total');
            profitTotalEl.innerText = (isProfitable ? '+' : '') + netProfit.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₽';
            profitTotalEl.classList.toggle('text-success', isProfitable); profitTotalEl.classList.toggle('text-danger', !isProfitable);

            const marginEl = document.getElementById('cart-profit-margin');
            marginEl.innerText = `${marginPct}%`;
            marginEl.classList.add('sales-profit-margin-chip');
            marginEl.classList.toggle('sales-profit-margin-chip--profit', isProfitable);
            marginEl.classList.toggle('sales-profit-margin-chip--loss', !isProfitable);

            // Разбивка по продуктам
            const breakdownEl = document.getElementById('cart-profit-breakdown');
            const productKeys = Object.keys(productProfitMap);
            if (breakdownEl) {
                if (productKeys.length > 1) {
                    const bdMod = isProfitable ? 'sales-profit-breakdown-inner--profit' : 'sales-profit-breakdown-inner--loss';
                    breakdownEl.className = `sales-profit-breakdown-inner ${bdMod}`;
                    breakdownEl.innerHTML = productKeys.map(name => {
                        const p = productProfitMap[name];
                        const ok = p.profit >= 0;
                        return `<div class="sales-profit-bd-row">
                            <span class="${isProfitable ? 'text-success' : 'text-danger'}">${name}</span>
                            <span class="font-bold ${ok ? 'text-success' : 'text-danger'}">${ok ? '+' : ''}${p.profit.toFixed(2)} ₽</span>
                        </div>`;
                    }).join('');
                    breakdownEl.classList.remove('d-none');
                } else {
                    breakdownEl.innerHTML = '';
                    breakdownEl.className = '';
                    breakdownEl.classList.add('d-none');
                }
            }
        } else {
            profitSummary.classList.add('sales-hidden');
        }
    }

    const oldProfit = document.getElementById('cart-profit-info');
    if (oldProfit) oldProfit.classList.add('d-none');
};


window.removeFromCart = function (index) {
    cart.splice(index, 1);
    renderCart();
};

// Функция пересчета при изменении значения прямо в таблице
window.updateCartItem = function (index, field, value) {
    let val = parseFloat(value) || 0;
    let item = cart[index];
    
    // Сохраняем оригинальную базовую цену, чтобы от нее считать скидку
    if (!('originalPrice' in item)) item.originalPrice = item.price;

    if (field === 'qty') {
        if (val < 0) val = 0;
        item.qty = val;
    } else if (field === 'finalPrice') {
        if (val < 0) {
            UI.toast('Цена не может быть отрицательной!', 'warning');
            val = 0;
        }
        
        let base = parseFloat(item.originalPrice) || 0;
        if (base > 0) {
            item.discount = ((base - val) / base) * 100;
        } else {
            // Если базовой цены почему-то нет или она 0, перезаписываем цену
            item.price = val;
            item.originalPrice = val;
            item.discount = 0;
        }
    } else if (field === 'discount') {
        if (val < 0) {
            UI.toast('Скидка не может быть меньше 0%', 'warning');
            val = 0;
        } else if (val > 100) {
            UI.toast('Скидка не может быть больше 100%', 'warning');
            val = 100;
        }
        item.discount = val;
    } else {
        item[field] = val;
    }

    renderCart();
};

function salesSetSelectValueSafe(el, value = '') {
    if (!el) return;
    if (el.tomselect) {
        el.tomselect.setValue(String(value), true);
    } else {
        el.value = String(value);
    }
}

function salesResetClientDependentUi() {
    window.CLIENT_AVAILABLE_ADVANCE = 0;
    window.CLIENT_PREFERRED_OFFSET_ACCOUNT_ID = null;
    window.CLIENT_IS_EMPLOYEE = false;
    window.CLIENT_PRICE_LEVEL = 'basic';

    const infoBox = document.getElementById('sale-client-info');
    if (infoBox) {
        infoBox.classList.add('sales-hidden');
        infoBox.innerHTML = '';
    }

    const contractGroup = document.getElementById('sale-contract-group');
    const contractSel = document.getElementById('sale-contract');
    if (contractGroup) contractGroup.classList.add('d-none');
    if (contractSel) {
        if (contractSel.tomselect) {
            contractSel.tomselect.clear(true);
            contractSel.tomselect.clearOptions();
            contractSel.tomselect.sync();
        } else {
            contractSel.innerHTML = '';
            contractSel.value = '';
        }
    }

    const offsetGroup = document.getElementById('sale-offset-group');
    const offsetMax = document.getElementById('sale-offset-max');
    if (offsetGroup) offsetGroup.classList.add('sales-hidden');
    if (offsetMax) offsetMax.innerText = '0 ₽';

    const summaryEl = document.getElementById('cart-offset-summary');
    const remainderEl = document.getElementById('sale-offset-remainder');
    if (summaryEl) summaryEl.classList.add('sales-hidden');
    if (remainderEl) remainderEl.innerText = '0 ₽';
}

window.clearOrderForm = function () {
    // 0. Сбрасываем режим редактирования (если был активен)
    window.editingOrderId = null;
    const checkoutBtn = document.querySelector('button[onclick="processCheckout()"]');
    if (checkoutBtn) checkoutBtn.innerHTML = '💾 Оформить заказ';
    const editingBanner = document.getElementById('editing-order-banner');
    if (editingBanner) editingBanner.remove();
    const titleEl = document.getElementById('checkout-title');
    if (titleEl) titleEl.innerHTML = '1. Клиент и подбор товара';
    // 1. Очищаем корзину
    cart = [];
    if (typeof renderCart === 'function') renderCart();

    // 2. Полный сброс полей формы
    const orderDate = document.getElementById('sale-order-date');
    if (orderDate) orderDate.value = new Date().toISOString().split('T')[0];

    const resetTextOrNum = (id, value = '') => {
        const el = document.getElementById(id);
        if (el) el.value = value;
    };
    resetTextOrNum('sale-discount', '0');
    resetTextOrNum('sale-logistics-cost', '0');
    resetTextOrNum('sale-delivery-address', '');
    resetTextOrNum('sale-planned-date', '');
    resetTextOrNum('sale-pallets', '');
    resetTextOrNum('sale-driver', '');
    resetTextOrNum('sale-auto', '');
    resetTextOrNum('sale-poa-comment', '');
    resetTextOrNum('sale-advance-amount', '');
    resetTextOrNum('sale-offset-amount', '');
    resetTextOrNum('sale-qty', '');
    resetTextOrNum('sale-price', '');

    // 3. Сбрасываем переключатели и селекты в дефолт
    salesClearClientSelect();
    salesResetClientDependentUi();

    const accountSel = document.getElementById('sale-account');
    salesSetSelectValueSafe(accountSel, '');

    const productSel = document.getElementById('sale-product-select');
    salesSetSelectValueSafe(productSel, '');

    const whSel = document.getElementById('sale-warehouse');
    if (whSel) {
        const first = Array.from(whSel.options || []).find((o) => String(o.value || '') !== '');
        whSel.value = first ? first.value : (whSel.options[0]?.value || '');
        currentSalesWarehouse = whSel.value || currentSalesWarehouse;
    }

    const noPoa = document.getElementById('sale-no-poa');
    if (noPoa) { noPoa.checked = false; togglePoaMode(); }

    const offsetCheck = document.getElementById('sale-offset-check');
    if (offsetCheck) { offsetCheck.checked = false; toggleOffsetInput(); }

    const payMethod = document.getElementById('sale-payment-method');
    if (payMethod) { payMethod.value = 'debt'; toggleSalePayment(); }

    const pickupRadio = document.querySelector('input[name="sale_delivery_type"][value="pickup"]');
    if (pickupRadio) pickupRadio.checked = true;
    if (typeof toggleSaleDelivery === 'function') toggleSaleDelivery();

    if (typeof updateOffsetSummary === 'function') updateOffsetSummary();
    if (typeof updateSaleMaxQty === 'function') updateSaleMaxQty();
    if (typeof updateLivePreview === 'function') updateLivePreview();
};

// === ОФОРМЛЕНИЕ ЗАКАЗА (ОТПРАВКА НА СЕРВЕР) ===
window.isCheckingOut = false;
window.processCheckout = async function () {
    if (window.isCheckingOut) return;
    if (cart.length === 0) return UI.toast('Корзина пуста', 'error');

    const client_id = salesGetTomSelectValue('sale-client');
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
    const accountId = salesGetTomSelectValue('sale-account') || '';
    const offsetChecked = Boolean(document.getElementById('sale-offset-check')?.checked);
    const offsetAmount = offsetChecked ? (parseFloat(document.getElementById('sale-offset-amount')?.value) || 0) : 0;
    const cartTotalRaw = document.getElementById('cart-total-sum')?.innerText || '0';
    const cartTotal = parseFloat(cartTotalRaw.replace(/[^\d.,]/g, '').replace(',', '.')) || 0;
    const payNowApprox = Math.max(0, cartTotal - offsetAmount);
    const requiresCashAccount = paymentMethod === 'paid'
        || paymentMethod === 'partial'
        || (offsetChecked && Boolean(window.CLIENT_IS_EMPLOYEE))
        || (paymentMethod === 'debt' && offsetChecked && payNowApprox > 0.01);

    if (paymentMethod === 'partial' && advanceAmount <= 0) {
        return UI.toast('Вы выбрали оплату авансом. Укажите сумму вносимого аванса!', 'error');
    }
    if (requiresCashAccount && !accountId) {
        return UI.toast('Выберите кассу/банк для зачисления оплаты', 'error');
    }

    // ==========================================
    // 3. ПРОВЕРКА ЛОГИСТИКИ И ДАТЫ ОТГРУЗКИ
    // ==========================================
    const logisticsCost = getEffectiveLogisticsCost();
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

    // Блокируем вызов функции и кнопку (защита от двойного клика)
    window.isCheckingOut = true;
    const btn = document.querySelector('button[onclick="processCheckout()"]');
    if (btn) btn.disabled = true;

    // Собираем данные (учитывая все проверки)
    // 🛡️ SECURITY: user_id НЕ передаётся — сервер берёт из JWT
    const toSafeNumber = (value, fallback = 0) => {
        const normalized = String(value ?? '').replace(',', '.').trim();
        if (!normalized) return fallback;
        const parsed = Number.parseFloat(normalized);
        return Number.isFinite(parsed) ? parsed : fallback;
    };
    const payload = {
        counterparty_id: client_id,
        items: cart.map(i => ({
            id: i.id,
            qty: toSafeNumber(i.qty, 0),
            price: toSafeNumber(i.price, 0) * (1 - (toSafeNumber(i.discount, 0)) / 100),
            warehouse_id: i.warehouseId,
            allow_production: i.allowProduction
        })),
        payment_method: paymentMethod,
        account_id: accountId,
        advance_amount: toSafeNumber(advanceAmount, 0),
        discount: toSafeNumber(document.getElementById('sale-discount')?.value, 0),
        driver: document.getElementById('sale-driver')?.value || null,
        auto: document.getElementById('sale-auto')?.value || null,
        offset_amount: toSafeNumber(offsetAmount, 0),
        contract_id: salesGetTomSelectValue('sale-contract') || null,
        delivery_address: (() => {
            const deliveryType = document.querySelector('input[name="sale_delivery_type"]:checked');
            if (deliveryType && deliveryType.value === 'pickup') {
                return 'Самовывоз';
            }
            return document.getElementById('sale-delivery-address').value;
        })(),
        logistics_cost: toSafeNumber(logisticsCost, 0),
        planned_shipment_date: plannedDateStr,
        pallets_qty: toSafeNumber(document.getElementById('sale-pallets')?.value, 0),
        poa_info: poa_info, // Передаем проверенную информацию
        order_date: document.getElementById('sale-order-date')?.value || new Date().toISOString().split('T')[0]
    };

    try {
        
        let result;
        if (window.editingOrderId) {
            if (paymentMethod !== 'debt') {
                UI.toast('При сохранении будет проведена только дельта доплаты по заказу.', 'info');
            }
            // Совместимость с API редактирования: для него дата заказа хранится в created_at.
            const editPayload = { ...payload, created_at: payload.order_date };
            result = await API.put('/api/sales/orders/' + window.editingOrderId, editPayload);
            result.docNum = result.doc_number || "Обновленный документ"; 
        } else {
            result = await API.post('/api/sales/checkout', payload);
        }


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
        if (typeof refreshShipmentDashboardIfActive === 'function') refreshShipmentDashboardIfActive();
        switchSalesTab('tab-active-orders', document.querySelectorAll('.sales-tab-btn')[1]);

    } catch (e) {
        console.error('[Checkout Error]', e);
    } finally {
        // Разблокируем кнопку в любом случае
        window.isCheckingOut = false;
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
        allActiveOrders = await API.get(`/api/sales/orders?${query}`);

        // 🔧 Заполняем фильтр клиентов уникальными именами
        const clientFilter = document.getElementById('bo-client-filter');
        if (clientFilter) {
            const uniqueClients = [...new Set(allActiveOrders.map(o => o.client_name).filter(Boolean))].sort();
            if (clientFilter.tomselect) {
                const cur = clientFilter.tomselect.getValue();
                clientFilter.tomselect.clearOptions();
                clientFilter.tomselect.addOption({ value: '', text: '🌐 Все клиенты' });
                uniqueClients.forEach(name => clientFilter.tomselect.addOption({ value: name, text: name }));
                clientFilter.tomselect.refreshOptions(false);
                clientFilter.tomselect.setValue(cur || '', true);
            } else {
                const cur = clientFilter.value;
                clientFilter.innerHTML = '<option value="">🌐 Все клиенты</option>' +
                    uniqueClients.map(name => `<option value="${Utils.escapeHtml(name)}">${Utils.escapeHtml(name)}</option>`).join('');
                clientFilter.value = cur;
            }
        }


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
    const boClientEl = document.getElementById('bo-client-filter');
    const clientVal = boClientEl ? (boClientEl.tomselect ? boClientEl.tomselect.getValue() : boClientEl.value) : '';
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

        // Фильтр по дате заказа (date_formatted = DD.MM.YYYY HH24:MI)
        let matchDeadline = true;
        if (boDeadlineRange.start || boDeadlineRange.end) {
            if (o.date_formatted) {
                const parts = o.date_formatted.split(' ')[0].split('.');
                if (parts.length === 3) {
                    const dlStr = `${parts[2]}-${parts[1]}-${parts[0]}`;
                    if (boDeadlineRange.start && dlStr < boDeadlineRange.start) matchDeadline = false;
                    if (boDeadlineRange.end && dlStr > boDeadlineRange.end) matchDeadline = false;
                }
            }
        }

        return matchSearch && matchClient && matchProduct && matchStatus && matchDeadline;
    });

    const maxPage = Math.ceil(filtered.length / 5) || 1;
    if (boPage > maxPage) boPage = maxPage;
    if (boPage < 1) boPage = 1;

    // === ИТОГО ===
    const totalCount = filtered.length;
    const totalSum = filtered.reduce((s, o) => s + (parseFloat(o.total_amount) || 0), 0);
    const fmtSum = totalSum.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    const boBar = document.getElementById('bo-totals-bar');
    if (boBar) {
        boBar.innerHTML = `
            <div class="sales-totals-stat">
                <span class="stat-label">📦 Заказов:</span>
                <span class="stat-value">${totalCount}</span>
            </div>
            <div class="sales-totals-stat">
                <span class="stat-label">💰 Итого:</span>
                <span class="stat-value accent-green">${fmtSum} ₽</span>
            </div>`;
    }

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
        // --- 1. ПРЕМИАЛЬНЫЙ ПРОГРЕСС-БАР ОТГРУЗКИ ---
        const ordered = parseFloat(o.total_ordered) || 0;
        const shipped = parseFloat(o.total_shipped) || 0;
        const shipPercent = ordered > 0 ? Math.round((shipped / ordered) * 100) : 0;
        let shipText = shipPercent === 0 ? 'В очереди' : shipPercent >= 100 ? 'Завершено' : 'В процессе';
        let shipProgressClass = shipPercent >= 100 ? 'progress-green' : (shipPercent === 0 ? 'progress-gray' : 'progress-blue');
        
        // --- 2. ПРЕМИАЛЬНЫЙ ПРОГРЕСС-БАР ОПЛАТЫ ---
        const totalAmt = parseFloat(o.total_amount) || 0;
        const paidAmt = parseFloat(o.paid_amount) || 0;
        const debtAmt = parseFloat(o.pending_debt) || 0;
        const payPercent = totalAmt > 0 ? Math.min(Math.round((paidAmt / totalAmt) * 100), 100) : 0;
        
        let payText = payPercent === 0 ? 'Не оплачен' : payPercent >= 100 ? 'Оплачен' : 'Внесен аванс';
        let debtLabel = '';
        if (debtAmt > 0) {
            debtLabel = `<div class="font-11 text-danger mt-3 font-600">Долг: ${debtAmt.toLocaleString('ru-RU')} ₽</div>`;
        }

        let payProgressClass = payPercent >= 100 ? 'progress-green' : (debtAmt > 0 ? 'progress-red' : (payPercent === 0 ? 'progress-gray' : 'progress-orange'));

        let shipColorText = shipPercent >= 100 ? 'text-success' : shipPercent === 0 ? 'text-muted' : 'text-primary';
        let payColorText = payPercent >= 100 ? 'text-success' : debtAmt > 0 ? 'text-danger' : payPercent === 0 ? 'text-muted' : 'text-warning';

        let statusHtml = `
            <div class="text-left mb-12">
                <div class="flex-between align-baseline mb-4">
                    <span class="font-11 font-600 text-muted text-uppercase tracking-wide">📦 Отгрузка</span>
                    <span class="font-12 font-700 ${shipColorText}">${shipPercent}%</span>
                </div>
                <progress class="progress-slim ${shipProgressClass} mb-5" value="${shipPercent}" max="100"></progress>
                <div class="font-11 text-muted">${shipText}</div>
            </div>

            <div class="text-left">
                <div class="flex-between align-baseline mb-4">
                    <span class="font-11 font-600 text-muted text-uppercase tracking-wide">💳 Оплата</span>
                    <span class="font-12 font-700 ${payColorText}">${payPercent}%</span>
                </div>
                <progress class="progress-slim ${payProgressClass} mb-5" value="${payPercent}" max="100"></progress>
                <div class="font-11 text-muted">${payText}</div>
                ${debtLabel}
            </div>
        `;

        // --- 3. БАЛАНС КЛИЕНТА ---
        const clientBalance = parseFloat(o.client_balance) || 0;
        let clientBalanceBadge = '';
        if (clientBalance < 0) {
            clientBalanceBadge = `<div class="sales-balance-badge balance-overpaid">💰 Переплата (Аванс): +${Math.abs(clientBalance).toLocaleString('ru-RU')} ₽</div>`;
        } else if (clientBalance > 0) {
            clientBalanceBadge = `<div class="sales-balance-badge balance-debt">📉 Общий долг: ${clientBalance.toLocaleString('ru-RU')} ₽</div>`;
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

        const returnBadge = (o.has_returns === true || o.has_returns === 't')
            ? '<span class="font-11 text-warning ml-5" title="По заказу зарегистрированы возвраты">↩️ Возврат</span>'
            : '';

        // --- РЕНДЕР СТРОКИ (ШАГ 4: entity-links) ---
        return `
        <tr class="sales-order-row">
            <td class="sales-order-date">
                ${o.date_formatted}<br>
                <span class="sales-order-deadline">до ${o.deadline || 'Не указан'}</span>
            </td>
            <td>
                <span class="sales-order-doc-link entity-link" onclick="window.app.openEntity('document_order', ${o.id})">${o.doc_number}</span>${returnBadge}<br>
                <span class="sales-order-amount">${totalAmt.toLocaleString('ru-RU')} ₽</span>
            </td>
            <td class="valign-top">
                <span class="sales-order-client entity-link" onclick="window.app.openEntity('client', ${o.counterparty_id})">${Utils.escapeHtml(o.client_name || 'Неизвестный клиент')}</span><br>
                <span class="sales-order-address">📍 ${Utils.escapeHtml(o.delivery_address || 'Самовывоз')}</span><br>
                ${o.author_name ? `<span class="font-11 text-muted">👤 ${Utils.escapeHtml(o.author_name)}</span><br>` : ''}
                ${clientBalanceBadge}
                ${projHtml}
            </td>
            <td class="sales-order-items">${Utils.escapeHtml(o.items_list || 'Пусто')}</td>
            <td class="text-center valign-middle min-w-180p p-12-16">
                ${statusHtml}
            </td>
            <td class="sales-order-actions-cell">
                <div class="sales-order-actions-row">
                    ${offsetBtn}
                    <button class="btn btn-outline sales-btn-sm sales-btn-sm-info" onclick="openInvoiceModal('${o.doc_number}', ${debtAmt > 0 ? debtAmt : totalAmt})" title="Счет на оплату">🖨️ Счет</button>
                    <button class="btn btn-outline sales-btn-sm text-primary border-primary" onclick="loadOrderForEdit(${o.id})" title="Редактировать заказ">✏️ Редакт.</button>
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
        <div id="sales-delete-order-preview" class="font-12 text-muted mb-10">Загрузка расчета...</div>
        <div class="form-group m-0 mt-10">
            <label>Режим финансового удаления</label>
            <select id="sales-delete-settlement-mode" class="input-modern" onchange="window.salesOnDeleteModeChange()">
                <option value="full_refund">Полный возврат (без остатка)</option>
                <option value="keep_advance">Удалить заказ и оставить сумму авансом</option>
                <option value="partial_refund">Частичный возврат, остаток оставить авансом</option>
            </select>
        </div>
        <div class="form-group m-0 mt-10 d-none" id="sales-delete-refund-wrap">
            <label>Сумма возврата (partial_refund)</label>
            <input type="number" min="0" step="0.01" id="sales-delete-refund-amount" class="input-modern" placeholder="0.00">
        </div>
        <div class="form-group m-0 mt-10 d-none" id="sales-delete-confirm-wrap">
            <label class="font-12">
                <input type="checkbox" id="sales-delete-confirm-imbalance">
                Подтверждаю: заказ будет удален, а невозвращенная часть останется нашим долгом перед контрагентом.
            </label>
        </div>
        <div class="form-group m-0 mt-10">
            <label>Причина удаления (обязательно)</label>
            <textarea id="sales-delete-order-reason" class="input-modern" rows="3" placeholder="Например: заказ создан ошибочно"></textarea>
        </div>
    `;
    UI.showModal('Удаление Заказа', html, `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-red" onclick="executeDeleteOrder(${orderId})">Да, удалить заказ</button>
    `);
    window.salesLoadDeletePreview(orderId);
};

window.salesOnDeleteModeChange = function () {
    const mode = document.getElementById('sales-delete-settlement-mode')?.value || 'full_refund';
    const refundWrap = document.getElementById('sales-delete-refund-wrap');
    const confirmWrap = document.getElementById('sales-delete-confirm-wrap');
    if (refundWrap) refundWrap.classList.toggle('d-none', mode !== 'partial_refund');
    if (confirmWrap) confirmWrap.classList.toggle('d-none', mode === 'full_refund');
};

window.salesLoadDeletePreview = async function (orderId) {
    try {
        const p = await API.get(`/api/sales/orders/${orderId}/delete-preview`);
        const el = document.getElementById('sales-delete-order-preview');
        if (el) {
            el.innerHTML = `
                <div>Оплачено в заказе: <b>${Number(p.paidAmount || 0).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽</b></div>
                <div>Фактически привязано транзакциями: <b>${Number(p.linkedIncome || 0).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽</b></div>
                <div>Неразобранная часть (рассинхрон): <b>${Number(p.ghostPaid || 0).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽</b></div>
                ${p.warning ? `<div class="text-danger mt-5">${Utils.escapeHtml(p.warning)}</div>` : ''}
            `;
        }
        const modeSel = document.getElementById('sales-delete-settlement-mode');
        if (modeSel && Number(p.linkedIncome || 0) <= 0 && Number(p.ghostPaid || 0) <= 0) {
            modeSel.value = 'full_refund';
        }
        window.salesOnDeleteModeChange();
    } catch (e) {
        const el = document.getElementById('sales-delete-order-preview');
        if (el) el.innerText = 'Не удалось загрузить расчёт перед удалением.';
    }
};

window.executeDeleteOrder = async function (orderId) {
    const reason = (document.getElementById('sales-delete-order-reason')?.value || '').trim();
    if (!reason) return UI.toast('Укажите причину удаления заказа', 'warning');
    const mode = document.getElementById('sales-delete-settlement-mode')?.value || 'full_refund';
    const refundAmount = Number(document.getElementById('sales-delete-refund-amount')?.value || 0);
    const confirmImbalance = Boolean(document.getElementById('sales-delete-confirm-imbalance')?.checked);
    if (mode === 'partial_refund' && refundAmount <= 0) {
        return UI.toast('Для частичного возврата укажите сумму возврата', 'warning');
    }
    if ((mode === 'keep_advance' || mode === 'partial_refund') && !confirmImbalance) {
        return UI.toast('Подтвердите удаление с невозвращённым остатком', 'warning');
    }
    try {
        const qs = new URLSearchParams();
        qs.set('reason', reason);
        qs.set('settlement_mode', mode);
        if (mode === 'partial_refund') qs.set('refund_amount', String(refundAmount));
        if (mode !== 'full_refund') qs.set('confirm_financial_imbalance', String(confirmImbalance));
        await API.delete(`/api/sales/orders/${orderId}?${qs.toString()}`);
        UI.closeModal();
        UI.toast('Заказ удален', 'success');
        loadActiveOrders();
        loadSalesData(false);
        if (typeof loadTable === 'function') loadTable();
        if (typeof refreshShipmentDashboardIfActive === 'function') refreshShipmentDashboardIfActive();
    } catch (e) { console.error(e); }
};

// ==========================================
// === ИСТОРИЯ ОТГРУЗОК (АРХИВ) + ПЕРИОД (как fin/dashboard) ===
// ==========================================

const SALES_PERIOD_ALL_FROM = '1900-01-01';

function salesPeriodFieldIds(prefix) {
    return {
        prefix,
        fg: `${prefix}-fg-period`,
        navBlock: `${prefix}-period-nav-block`,
        display: `${prefix}-period-display`,
        prevBtn: `${prefix}-period-prev-btn`,
        nextBtn: `${prefix}-period-next-btn`,
        iconBtn: `${prefix}-period-icon-btn`,
        customRange: `${prefix}-custom-range`,
        mode: `${prefix}-period-mode`,
        anchor: `${prefix}-date-anchor`,
        from: `${prefix}-date-from`,
        to: `${prefix}-date-to`,
    };
}

function salesPeriodTodayStr() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function salesPeriodMonthStartStr() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    return `${y}-${m}-01`;
}

function salesPeriodFmtYmd(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function salesPeriodDisplayRu(d) {
    return d.toLocaleDateString('ru-RU');
}

function salesPeriodMonthNameRu(d) {
    return d.toLocaleDateString('ru-RU', { month: 'long' });
}

function salesPeriodNormalizeRangeOrder(ids) {
    const fromEl = document.getElementById(ids.from);
    const toEl = document.getElementById(ids.to);
    if (!fromEl || !toEl) return;
    const a = String(fromEl.value || '').trim();
    const b = String(toEl.value || '').trim();
    if (!a || !b) return;
    if (a > b) {
        fromEl.value = b;
        toEl.value = a;
    }
}

function salesGetAnchorDate(ids) {
    const v = document.getElementById(ids.anchor)?.value || salesPeriodTodayStr();
    const d = new Date(`${v}T00:00:00`);
    return Number.isNaN(d.getTime()) ? new Date() : d;
}

/** Диапазон для фильтров/API: для «Все время» — пустые строки */
function salesPeriodHarvestRange(ids) {
    const mode = document.getElementById(ids.mode)?.value || 'all_time';
    if (mode === 'all_time') return { start: '', end: '' };
    let dateFrom = String(document.getElementById(ids.from)?.value || '').trim() || salesPeriodMonthStartStr();
    let dateTo = String(document.getElementById(ids.to)?.value || '').trim() || salesPeriodTodayStr();
    if (dateFrom > dateTo) {
        const t = dateFrom;
        dateFrom = dateTo;
        dateTo = t;
    }
    return { start: dateFrom, end: dateTo };
}

function salesPeriodCommit(prefix) {
    const ids = salesPeriodFieldIds(prefix);
    const r = salesPeriodHarvestRange(ids);
    if (prefix === 'sales-bo') {
        boDeadlineRange = r;
        applyOrderFilters();
        return;
    }
    historyDateRange = r;
    historyPage = 1;
    loadSalesHistory();
}

function salesPeriodToggleLayout(ids) {
    const mode = document.getElementById(ids.mode)?.value || 'all_time';
    const fg = document.getElementById(ids.fg);
    const nav = document.getElementById(ids.navBlock);
    const customInp = document.getElementById(ids.customRange);
    const isCustom = mode === 'custom';
    if (fg) fg.classList.toggle('reports-period-is-custom', isCustom);
    if (nav) nav.classList.toggle('d-none', isCustom);
    if (customInp) customInp.classList.toggle('d-none', !isCustom);
}

function salesPeriodRefreshDisplay(ids) {
    const displayEl = document.getElementById(ids.display);
    const mode = document.getElementById(ids.mode)?.value || 'all_time';
    const anchor = salesGetAnchorDate(ids);
    const prevBtn = document.getElementById(ids.prevBtn);
    const nextBtn = document.getElementById(ids.nextBtn);
    const pickerBtn = document.getElementById(ids.iconBtn);
    if (!displayEl) return;
    const nonNavMode = mode === 'all_time' || mode === 'custom';
    if (prevBtn) prevBtn.disabled = nonNavMode;
    if (nextBtn) nextBtn.disabled = nonNavMode;
    if (pickerBtn) pickerBtn.disabled = mode === 'all_time';
    if (prevBtn) prevBtn.title = nonNavMode
        ? (mode === 'all_time' ? 'Недоступно в режиме «Все время»' : 'Назад недоступно в режиме «Свой диапазон»')
        : 'Назад';
    if (nextBtn) nextBtn.title = nonNavMode
        ? (mode === 'all_time' ? 'Недоступно в режиме «Все время»' : 'Вперёд недоступно в режиме «Свой диапазон»')
        : 'Вперёд';
    if (pickerBtn) pickerBtn.title = mode === 'all_time'
        ? 'Недоступно в режиме «Все время»'
        : 'Выбрать дату';
    if (mode === 'all_time') {
        displayEl.value = 'Все время';
        return;
    }
    if (mode === 'custom') {
        const fromStr = String(document.getElementById(ids.from)?.value || '').trim();
        const toStr = String(document.getElementById(ids.to)?.value || '').trim();
        const fd = fromStr ? new Date(`${fromStr}T00:00:00`) : null;
        const td = toStr ? new Date(`${toStr}T00:00:00`) : null;
        if (fd && td && !Number.isNaN(fd.getTime()) && !Number.isNaN(td.getTime())) {
            displayEl.value = `${salesPeriodDisplayRu(fd)} — ${salesPeriodDisplayRu(td)}`;
            return;
        }
    }
    if (mode === 'day') {
        displayEl.value = salesPeriodDisplayRu(anchor);
        return;
    }
    if (mode === 'month') {
        const label = salesPeriodMonthNameRu(anchor);
        displayEl.value = `${label.charAt(0).toUpperCase()}${label.slice(1)} ${anchor.getFullYear()}`;
        return;
    }
    if (mode === 'quarter') {
        const q = Math.floor(anchor.getMonth() / 3) + 1;
        displayEl.value = `${q} квартал ${anchor.getFullYear()}`;
        return;
    }
    if (mode === 'year') {
        const now = new Date();
        displayEl.value = anchor.getFullYear() === now.getFullYear() ? `YTD ${anchor.getFullYear()}` : String(anchor.getFullYear());
        return;
    }
    displayEl.value = salesPeriodDisplayRu(anchor);
}

function salesPeriodSyncFromInputs(ids, pickersRef) {
    const fromRaw = String(document.getElementById(ids.from)?.value || '').trim();
    const toRaw = String(document.getElementById(ids.to)?.value || '').trim();
    const from = fromRaw || salesPeriodMonthStartStr();
    const to = toRaw || salesPeriodTodayStr();
    const fromDate = new Date(`${from}T00:00:00`);
    const toDate = new Date(`${to}T00:00:00`);
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) return;
    let mode = 'custom';
    if (from === SALES_PERIOD_ALL_FROM) mode = 'all_time';
    else if (from === to) mode = 'day';
    else if (fromDate.getMonth() === toDate.getMonth() && fromDate.getFullYear() === toDate.getFullYear()
        && fromDate.getDate() === 1 && toDate.getDate() === new Date(toDate.getFullYear(), toDate.getMonth() + 1, 0).getDate()) mode = 'month';
    else if (fromDate.getFullYear() === toDate.getFullYear() && fromDate.getMonth() === 0 && fromDate.getDate() === 1
        && toDate.getMonth() === 11 && toDate.getDate() === 31) mode = 'year';
    else {
        const qStartMonth = Math.floor(fromDate.getMonth() / 3) * 3;
        const qEnd = new Date(fromDate.getFullYear(), qStartMonth + 3, 0);
        if (fromDate.getFullYear() === qEnd.getFullYear()
            && fromDate.getMonth() === qStartMonth && fromDate.getDate() === 1
            && toDate.getMonth() === qEnd.getMonth() && toDate.getDate() === qEnd.getDate()) mode = 'quarter';
        else mode = 'custom';
    }
    const anchorEl = document.getElementById(ids.anchor);
    const modeEl = document.getElementById(ids.mode);
    if (anchorEl) anchorEl.value = salesPeriodFmtYmd(toDate);
    if (modeEl) modeEl.value = mode;
    salesPeriodFinishUi(ids, pickersRef);
}

function salesPeriodApplyFromMode(ids, pickersRef, mode, anchorDate, shouldCommitAfter) {
    const dateRaw = anchorDate instanceof Date ? anchorDate : salesGetAnchorDate(ids);
    const safeMode = ['day', 'month', 'quarter', 'year', 'custom', 'all_time'].includes(mode) ? mode : 'all_time';
    const fromEl = document.getElementById(ids.from);
    const toEl = document.getElementById(ids.to);
    const anchorEl = document.getElementById(ids.anchor);
    const modeEl = document.getElementById(ids.mode);

    if (safeMode === 'custom') {
        salesPeriodNormalizeRangeOrder(ids);
        const toVal = String(toEl?.value || '').trim() || salesPeriodTodayStr();
        if (modeEl) modeEl.value = 'custom';
        if (anchorEl) anchorEl.value = toVal;
        salesPeriodFinishUi(ids, pickersRef);
        if (shouldCommitAfter) salesPeriodCommit(ids.prefix);
        return;
    }

    let anchor = new Date(dateRaw.getFullYear(), dateRaw.getMonth(), dateRaw.getDate());
    let from = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
    let to = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
    if (safeMode === 'all_time') {
        const now = new Date();
        anchor = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        from = new Date(`${SALES_PERIOD_ALL_FROM}T00:00:00`);
        to = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    } else if (safeMode === 'month') {
        anchor = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
        from = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
        to = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
    } else if (safeMode === 'quarter') {
        const qStartMonth = Math.floor(anchor.getMonth() / 3) * 3;
        anchor = new Date(anchor.getFullYear(), qStartMonth, 1);
        from = new Date(anchor.getFullYear(), qStartMonth, 1);
        to = new Date(anchor.getFullYear(), qStartMonth + 3, 0);
    } else if (safeMode === 'year') {
        const now = new Date();
        anchor = new Date(anchor.getFullYear(), 0, 1);
        from = new Date(anchor.getFullYear(), 0, 1);
        if (anchor.getFullYear() === now.getFullYear()) {
            to = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        } else {
            to = new Date(anchor.getFullYear(), 11, 31);
        }
    }

    if (fromEl) fromEl.value = salesPeriodFmtYmd(from);
    if (toEl) toEl.value = salesPeriodFmtYmd(to);
    if (anchorEl) anchorEl.value = salesPeriodFmtYmd(anchor);
    if (modeEl) modeEl.value = safeMode;
    salesPeriodFinishUi(ids, pickersRef);
    if (shouldCommitAfter) salesPeriodCommit(ids.prefix);
}

function salesPeriodRebuildPickers(ids, pickersRef) {
    const anchorEl = document.getElementById(ids.anchor);
    const displayEl = document.getElementById(ids.display);
    const mode = document.getElementById(ids.mode)?.value || 'all_time';
    const st = pickersRef;

    if (st.periodPicker && typeof st.periodPicker.destroy === 'function') {
        st.periodPicker.destroy();
        st.periodPicker = null;
    }
    if (st.customRangePicker && typeof st.customRangePicker.destroy === 'function') {
        st.customRangePicker.destroy();
        st.customRangePicker = null;
    }
    if (typeof flatpickr === 'undefined') return;

    if (mode === 'custom') {
        const el = document.getElementById(ids.customRange);
        if (!el) return;
        const fromStr = String(document.getElementById(ids.from)?.value || '').trim() || salesPeriodMonthStartStr();
        const toStr = String(document.getElementById(ids.to)?.value || '').trim() || salesPeriodTodayStr();
        const locale = (window.flatpickr && window.flatpickr.l10ns && window.flatpickr.l10ns.ru) ? window.flatpickr.l10ns.ru : 'ru';
        st.customRangePicker = flatpickr(el, {
            locale,
            mode: 'range',
            dateFormat: 'Y-m-d',
            altInput: true,
            altFormat: 'd.m.Y',
            altInputClass: 'input-modern reports-custom-range-alt',
            allowInput: false,
            disableMobile: false,
            appendTo: document.body,
            defaultDate: [fromStr, toStr],
            onChange(selectedDates, dateStr, instance) {
                if (!selectedDates || selectedDates.length !== 2) return;
                const fromElInner = document.getElementById(ids.from);
                const toElInner = document.getElementById(ids.to);
                const anchorElInner = document.getElementById(ids.anchor);
                const from = instance.formatDate(selectedDates[0], 'Y-m-d');
                const innerTo = instance.formatDate(selectedDates[1], 'Y-m-d');
                if (fromElInner) fromElInner.value = from;
                if (toElInner) toElInner.value = innerTo;
                if (anchorElInner) anchorElInner.value = innerTo;
                salesPeriodNormalizeRangeOrder(ids);
                const modeElInner = document.getElementById(ids.mode);
                if (modeElInner) modeElInner.value = 'custom';
                setTimeout(() => {
                    salesPeriodSyncFromInputs(ids, pickersRef);
                    salesPeriodCommit(ids.prefix);
                }, 0);
            }
        });
        return;
    }

    if (!anchorEl || !displayEl || mode === 'all_time') return;

    const locale = (window.flatpickr && window.flatpickr.l10ns && window.flatpickr.l10ns.ru) ? window.flatpickr.l10ns.ru : 'ru';
    st.periodPicker = flatpickr(anchorEl, {
        locale,
        dateFormat: 'Y-m-d',
        defaultDate: salesGetAnchorDate(ids),
        clickOpens: false,
        allowInput: false,
        positionElement: displayEl,
        appendTo: document.body,
        disableMobile: true,
        onChange: (selectedDates) => {
            if (!selectedDates || !selectedDates.length) return;
            const picked = selectedDates[0];
            const selMode = document.getElementById(ids.mode)?.value || 'day';
            queueMicrotask(() => salesPeriodApplyFromMode(ids, pickersRef, selMode, picked, true));
        }
    });
}

function salesPeriodFinishUi(ids, pickersRef) {
    salesPeriodToggleLayout(ids);
    salesPeriodRebuildPickers(ids, pickersRef);
    salesPeriodRefreshDisplay(ids);
}

function salesBoInitInner() {
    const ids = salesPeriodFieldIds('sales-bo');
    const from = document.getElementById(ids.from);
    const to = document.getElementById(ids.to);
    const modeEl = document.getElementById(ids.mode);
    const anchorEl = document.getElementById(ids.anchor);
    if (!from || !to || !modeEl || !anchorEl) return;

    const fromEmpty = String(from.value || '').trim() === '';
    const toEmpty = String(to.value || '').trim() === '';

    if (fromEmpty && toEmpty && (modeEl.value === 'all_time' || !modeEl.value)) {
        modeEl.value = 'all_time';
        salesPeriodApplyFromMode(ids, window.__salesBoPeriodPickers, 'all_time', new Date(), false);
        boDeadlineRange = salesPeriodHarvestRange(ids);
        return;
    }
    if (fromEmpty && toEmpty && modeEl.value && modeEl.value !== 'all_time') {
        from.value = salesPeriodMonthStartStr();
        to.value = salesPeriodTodayStr();
        anchorEl.value = to.value;
        salesPeriodSyncFromInputs(ids, window.__salesBoPeriodPickers);
        boDeadlineRange = salesPeriodHarvestRange(ids);
        return;
    }
    salesPeriodFinishUi(ids, window.__salesBoPeriodPickers);
    boDeadlineRange = salesPeriodHarvestRange(ids);
}

function salesHistInitInner() {
    const ids = salesPeriodFieldIds('sales-hist');
    const from = document.getElementById(ids.from);
    const to = document.getElementById(ids.to);
    const modeEl = document.getElementById(ids.mode);
    const anchorEl = document.getElementById(ids.anchor);
    if (!from || !to || !modeEl || !anchorEl) return;

    const fromEmpty = String(from.value || '').trim() === '';
    const toEmpty = String(to.value || '').trim() === '';

    if (fromEmpty && toEmpty && (modeEl.value === 'all_time' || !modeEl.value)) {
        modeEl.value = 'all_time';
        salesPeriodApplyFromMode(ids, window.__salesHistPeriodPickers, 'all_time', new Date(), false);
        historyDateRange = salesPeriodHarvestRange(ids);
        return;
    }
    if (fromEmpty && toEmpty && modeEl.value && modeEl.value !== 'all_time') {
        from.value = salesPeriodMonthStartStr();
        to.value = salesPeriodTodayStr();
        anchorEl.value = to.value;
        salesPeriodSyncFromInputs(ids, window.__salesHistPeriodPickers);
        historyDateRange = salesPeriodHarvestRange(ids);
        return;
    }
    salesPeriodFinishUi(ids, window.__salesHistPeriodPickers);
    historyDateRange = salesPeriodHarvestRange(ids);
}

window.salesBoInitPeriodStrip = function () {
    salesBoInitInner();
};

window.salesHistInitPeriodStrip = function () {
    salesHistInitInner();
};

window.salesBoOnPeriodModeChange = function () {
    const ids = salesPeriodFieldIds('sales-bo');
    const mode = document.getElementById(ids.mode)?.value || 'all_time';
    salesPeriodApplyFromMode(ids, window.__salesBoPeriodPickers, mode, salesGetAnchorDate(ids), true);
};

window.salesBoOnPeriodAnchorChange = window.salesBoOnPeriodModeChange;

window.salesBoShiftPeriod = function (delta) {
    const ids = salesPeriodFieldIds('sales-bo');
    const base = salesGetAnchorDate(ids);
    const mode = document.getElementById(ids.mode)?.value || 'all_time';
    if (mode === 'all_time' || mode === 'custom') return;
    const step = Number(delta || 0);
    if (mode === 'month') base.setMonth(base.getMonth() + step);
    else if (mode === 'quarter') base.setMonth(base.getMonth() + (3 * step));
    else if (mode === 'year') base.setFullYear(base.getFullYear() + step);
    else base.setDate(base.getDate() + step);
    salesPeriodApplyFromMode(ids, window.__salesBoPeriodPickers, mode, base, true);
};

window.salesBoOpenPeriodPicker = function () {
    const ids = salesPeriodFieldIds('sales-bo');
    const mode = document.getElementById(ids.mode)?.value || 'all_time';
    if (mode === 'all_time') return;
    if (mode === 'custom') {
        const cr = window.__salesBoPeriodPickers.customRangePicker;
        if (cr) { cr.open(); return; }
        const el = document.getElementById(ids.customRange);
        if (el) el.click();
        return;
    }
    const picker = window.__salesBoPeriodPickers.periodPicker;
    if (picker) {
        picker.setDate(salesGetAnchorDate(ids), false);
        picker.open();
        return;
    }
    const input = document.getElementById(ids.anchor);
    if (!input) return;
    if (typeof input.showPicker === 'function') input.showPicker();
    else input.click();
};

window.salesHistOnPeriodModeChange = function () {
    const ids = salesPeriodFieldIds('sales-hist');
    const mode = document.getElementById(ids.mode)?.value || 'all_time';
    salesPeriodApplyFromMode(ids, window.__salesHistPeriodPickers, mode, salesGetAnchorDate(ids), true);
};

window.salesHistOnPeriodAnchorChange = window.salesHistOnPeriodModeChange;

window.salesHistShiftPeriod = function (delta) {
    const ids = salesPeriodFieldIds('sales-hist');
    const base = salesGetAnchorDate(ids);
    const mode = document.getElementById(ids.mode)?.value || 'all_time';
    if (mode === 'all_time' || mode === 'custom') return;
    const step = Number(delta || 0);
    if (mode === 'month') base.setMonth(base.getMonth() + step);
    else if (mode === 'quarter') base.setMonth(base.getMonth() + (3 * step));
    else if (mode === 'year') base.setFullYear(base.getFullYear() + step);
    else base.setDate(base.getDate() + step);
    salesPeriodApplyFromMode(ids, window.__salesHistPeriodPickers, mode, base, true);
};

window.salesHistOpenPeriodPicker = function () {
    const ids = salesPeriodFieldIds('sales-hist');
    const mode = document.getElementById(ids.mode)?.value || 'all_time';
    if (mode === 'all_time') return;
    if (mode === 'custom') {
        const cr = window.__salesHistPeriodPickers.customRangePicker;
        if (cr) { cr.open(); return; }
        const el = document.getElementById(ids.customRange);
        if (el) el.click();
        return;
    }
    const picker = window.__salesHistPeriodPickers.periodPicker;
    if (picker) {
        picker.setDate(salesGetAnchorDate(ids), false);
        picker.open();
        return;
    }
    const input = document.getElementById(ids.anchor);
    if (!input) return;
    if (typeof input.showPicker === 'function') input.showPicker();
    else input.click();
};

/** Совместимость: UI статичный в sales.ejs */
window.renderHistoryPeriodUI = function () {
    const ids = salesPeriodFieldIds('sales-hist');
    if (!document.getElementById(ids.fg)) return;
    salesPeriodFinishUi(ids, window.__salesHistPeriodPickers);
};

window.applyHistoryFilters = function() {
    historyPage = 1;
    loadSalesHistory();
};

window.resetHistoryFilters = function() {
    const searchInput = document.getElementById('hist-search');
    const clientSelect = document.getElementById('hist-client-filter');
    if (searchInput) searchInput.value = '';
    if (clientSelect) {
        if (clientSelect.tomselect) clientSelect.tomselect.setValue('', true);
        else clientSelect.value = '';
    }
    const histIds = salesPeriodFieldIds('sales-hist');
    salesPeriodApplyFromMode(histIds, window.__salesHistPeriodPickers, 'all_time', new Date(), true);
    historyPagination = { page: 1, totalPages: 1, total: 0, limit: 5 };
};

function populateHistoryClientFilter(historyData) {
    const select = document.getElementById('hist-client-filter');
    if (!select) return;
    
    const currentVal = select.tomselect ? select.tomselect.getValue() : select.value;
    const clients = new Set();
    
    historyData.forEach(h => {
        if (h.client_name) clients.add(h.client_name);
    });
    
    const sortedClients = Array.from(clients).sort();
    
    if (select.tomselect) {
        select.tomselect.clear(true);
        select.tomselect.clearOptions();
        select.tomselect.addOption({value: '', text: '🌐 Все клиенты'});
        sortedClients.forEach(c => {
            select.tomselect.addOption({value: Utils.escapeHtml(c), text: Utils.escapeHtml(c)});
        });
        
        if (currentVal && clients.has(currentVal)) {
            select.tomselect.setValue(currentVal, true);
        } else {
            select.tomselect.setValue('', true);
        }
    } else {
        let html = '<option value="">🌐 Все клиенты</option>';
        sortedClients.forEach(c => {
            html += `<option value="${Utils.escapeHtml(c)}">${Utils.escapeHtml(c)}</option>`;
        });
        
        select.innerHTML = html;
        if (currentVal && clients.has(currentVal)) {
            select.value = currentVal;
        }
    }
}

async function loadSalesHistory() {
    const histSearchEl = document.getElementById('hist-search');
    const histClientEl = document.getElementById('hist-client-filter');
    historySearch = histSearchEl ? histSearchEl.value.trim() : '';
    const clientVal = histClientEl ? (histClientEl.tomselect ? histClientEl.tomselect.getValue() : histClientEl.value) : '';

    const query = new URLSearchParams({
        page: historyPage,
        limit: 5,
        search: historySearch,
        client: clientVal || '',
        start: historyDateRange.start,
        end: historyDateRange.end,
        _t: Date.now()
    }).toString();

    try {
        const data = await API.get(`/api/sales/history?${query}`);

        allSalesHistory = data.data || data;
        historyPagination = data.pagination || {
            page: historyPage,
            totalPages: 1,
            total: Array.isArray(allSalesHistory) ? allSalesHistory.length : 0,
            limit: 5
        };
        historyPage = Number(historyPagination.page || historyPage);
        populateHistoryClientFilter(data.clients || allSalesHistory); // Заполняем фильтр клиентов
        renderHistoryTable();
    } catch (e) { console.error(e); }
}

window.changeHistoryPage = function (dir) {
    const nextPage = historyPage + dir;
    const maxPage = Math.max(1, Number(historyPagination.totalPages || 1));
    if (nextPage < 1 || nextPage > maxPage) return;
    historyPage = nextPage;
    loadSalesHistory();
};

function renderHistoryTable() {
    const tbody = document.getElementById('sales-history-table');
    if (!tbody) return;

    const filtered = Array.isArray(allSalesHistory) ? allSalesHistory : [];

    // === ИТОГО ===
    const histCount = Number(historyPagination.total || filtered.length);
    const histSum = filtered.reduce((s, h) => s + (parseFloat(h.calculated_shipment_amount) || parseFloat(h.amount) || 0), 0);
    const histFmt = histSum.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    const histBar = document.getElementById('hist-totals-bar');
    if (histBar) {
        histBar.innerHTML = `
            <div class="sales-totals-stat">
                <span class="stat-label">📦 Отгрузок:</span>
                <span class="stat-value">${histCount}</span>
            </div>
            <div class="sales-totals-stat">
                <span class="stat-label">💰 Итого:</span>
                <span class="stat-value accent-green">${histFmt} ₽</span>
            </div>`;
    }

    const maxPage = Math.max(1, Number(historyPagination.totalPages || 1));
    document.getElementById('hist-page-info').innerText = `Страница ${historyPage} из ${maxPage} (Всего: ${histCount})`;

    if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="sales-empty-cell">Отгрузки не найдены</td></tr>';
        return;
    }

    tbody.innerHTML = filtered.map(h => {
        // 🚀 НОВОЕ: Умный поиск цены (бэкенд может называть её по-разному)
        const rowSumRaw = (h.amount ?? h.calculated_shipment_amount ?? h.total_amount ?? h.total_sum ?? h.sum);
        const rowSum = Number(rowSumRaw);
        const sumText = Number.isFinite(rowSum) && rowSum > 0 ? rowSum.toLocaleString('ru-RU') + ' ₽' : '-';
        const qtyNum = Number(h.total_qty);
        const qtyText = Number.isFinite(qtyNum) && qtyNum > 0 ? qtyNum.toLocaleString('ru-RU') : '—';

        const canCancel = h.cancellable !== false && Number(h.total_qty || 0) > 0;
        return `
        <tr class="sales-hist-row">
            <td class="sales-hist-date">${h.date_formatted}</td>
            <td><strong class="sales-hist-doc entity-link" onclick="window.app.openEntity('document_order', '${h.order_id}')">${h.doc_num}</strong></td>
            <td>
                <b class="entity-link" onclick="window.app.openEntity('client', ${h.client_id || 0})">${Utils.escapeHtml(h.client_name || 'Неизвестный клиент')}</b><br>
                <span class="profit-sub">${h.payment || ''}</span>
            </td>
            <td class="text-center font-bold">${qtyText}</td>
            <td class="sales-hist-sum">${sumText}</td>
            <td class="sales-hist-actions">
            <div class="sales-order-actions-row">
                ${canCancel
                    ? `<button class="btn btn-outline sales-btn-sm sales-btn-sm-info" onclick="void window.openPrintUrl('/print/upd?docNum=${h.doc_num}')" title="УПД и Пропуск на выезд">🖨️ УПД + Пропуск</button>
                       <button class="btn btn-outline sales-btn-sm text-warning border-warning" onclick="void window.openPrintUrl('/print/specification?docNum=${h.doc_num}')" title="Спецификация">🖨️ Спец.</button>
                       <button class="btn btn-outline sales-btn-sm text-primary border-primary" onclick="void window.openPrintUrl('/print/waybill?docNum=${h.doc_num}')" title="Накладная">🖨️ Накладная</button>`
                    : `<button class="btn btn-outline sales-btn-sm sales-btn-sm-info" disabled title="Для принудительно закрытого заказа без отгрузки не формируется УПД">🖨️ УПД + Пропуск</button>
                       <button class="btn btn-outline sales-btn-sm text-warning border-warning" disabled title="Для принудительно закрытого заказа без отгрузки не формируется спецификация">🖨️ Спец.</button>
                       <button class="btn btn-outline sales-btn-sm text-primary border-primary" disabled title="Для принудительно закрытого заказа без отгрузки не формируется накладная">🖨️ Накладная</button>`}
                ${canCancel
                    ? `<button class="btn btn-outline sales-btn-sm sales-btn-sm-danger" onclick="cancelShipment('${h.doc_num}')" title="Отменить">❌</button>`
                    : `<button class="btn btn-outline sales-btn-sm sales-btn-sm-danger" disabled title="Нет отгрузки для отмены">❌</button>`}
            </div>
            </td>
        </tr>
        `;
    }).join('');
}
window.cancelShipment = function (docNum) {
    const html = `
        <p>Отменить накладную <b>${docNum}</b>?<br><small class="text-danger">Плитка вернется на склады, финансы аннулируются.</small></p>
        <div class="form-group m-0 mt-10">
            <label>Причина отмены (обязательно)</label>
            <textarea id="sales-cancel-shipment-reason" class="input-modern" rows="3" placeholder="Например: ошибочная отгрузка"></textarea>
        </div>
    `;
    UI.showModal('Отмена отгрузки', html, `
        <button class="btn btn-outline" onclick="UI.closeModal()">Назад</button>
        <button class="btn btn-red" onclick="executeCancelShipment('${docNum}')">Да, отменить</button>
    `);
};

window.executeCancelShipment = async function (docNum) {
    const reason = (document.getElementById('sales-cancel-shipment-reason')?.value || '').trim();
    if (!reason) return UI.toast('Укажите причину отмены отгрузки', 'warning');
    try {
        await API.delete(`/api/sales/shipments/${docNum}?reason=${encodeURIComponent(reason)}`);
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
    } catch (e) { console.error(e); }
};


// ==========================================
// === ПРОЧИЕ МОДУЛИ (ПРАЙС И ДОГОВОРЫ) ===
// ==========================================
window.openPriceListModal = async function () {
    UI.toast('Загрузка прайс-листа...', 'info');
    try {
        const products = await API.get('/api/products');

        let tbody = products.map(p => `
            <tr class="border-bottom price-list-row" data-name="${Utils.escapeHtml(p.name)}">
                <td class="p-8">
                    <span class="badge bg-surface-alt text-muted font-11 mr-8 font-mono">${p.article || 'НЕТ АРТИКУЛА'}</span>
                    <b>${p.name}</b> <span class="font-10 text-muted">(${p.unit})</span>
                </td>
                <td class="p-8 text-center">
                    <input type="number" class="input-modern price-basic text-center w-90" data-id="${p.id}" value="${p.current_price}" onfocus="this.select()">
                </td>
                <td class="p-8 text-center">
                    <input type="number" class="input-modern price-dealer text-center w-90 border-info" data-id="${p.id}" value="${p.dealer_price || 0}" onfocus="this.select()">
                </td>
            </tr>
        `).join('');

        const html = `
            <style>
                #app-modal .modal-content { max-width: 750px !important; }
                .price-list-table thead { position: sticky; top: 0; z-index: 10; }
            </style>
            
            <div class="overflow-auto pr-10 sales-pricelist-scroll">
                <table class="table-modern w-100 font-13 price-list-table">
                    <thead class="bg-surface-hover">
                        <tr>
                            <th class="p-10 text-left">
                                <div class="d-flex align-items-center justify-content-between gap-15 sales-pricelist-toolbar-inner">
                                    <span>Товар</span>
                                    <input type="text" class="input-modern m-0 font-12 sales-pricelist-search" placeholder="Умный поиск (2 к 6)..." oninput="filterPriceList(this.value)">
                                </div>
                            </th>
                            <th class="p-10 text-center text-main sales-th-130">Основная<br><small class="text-muted">(Розница)</small></th>
                            <th class="p-10 text-center text-info sales-th-130">Дилерская<br><small class="text-muted">(Опт)</small></th>
                        </tr>
                    </thead>
                    <tbody>${tbody}</tbody>
                </table>
            </div>
        `;

        UI.showModal('📋 Установка Прайс-листа', html, `
            <div class="flex-between flex-wrap gap-10 w-100">
                <div class="flex-row gap-10 sales-price-toolbar-grow">
                    <label class="btn btn-outline border-primary text-primary font-12 cursor-pointer m-0 px-10">
                        📥 Загрузить Базовый (Розница)
                        <input type="file" accept=".csv" class="d-none" onchange="handleBasicCsvImport(event)">
                    </label>
                    <label class="btn btn-outline border-info text-info font-12 cursor-pointer m-0 px-10">
                        📥 Загрузить Дилерский (Опт)
                        <input type="file" accept=".csv" class="d-none" onchange="handleDealerCsvImport(event)">
                    </label>
                </div>
                <div class="flex-row gap-10">
                    <button class="btn btn-outline m-0 px-15" onclick="UI.closeModal()">Отмена</button>
                    <button class="btn btn-blue m-0 px-15" onclick="savePriceList()">💾 Сохранить</button>
                </div>
            </div>
        `);
    } catch (e) { console.error(e); }
};

window.filterPriceList = function(query) {
    const rows = document.querySelectorAll('.price-list-row');
    if (!query) {
        rows.forEach(r => r.classList.remove('d-none'));
        return;
    }
    
    query = query.toLowerCase();
    const queryCondensed = query.replace(/[\.\s-]/g, '');
    const tokens = query.split(/\s+/).filter(Boolean);
    
    rows.forEach(row => {
        const text = row.getAttribute('data-name').toLowerCase();
        const textCondensed = text.replace(/[\.\s-]/g, '');
        
        let match = true;
        for (let token of tokens) {
            let tokenCondensed = token.replace(/[\.\s-]/g, '');
            if (!text.includes(token) && (!tokenCondensed || !textCondensed.includes(tokenCondensed))) {
                match = false; break;
            }
        }
        if (!match) {
            // Вторичная проверка для поиска точного соответствия без пробелов
            if (queryCondensed.length >= 2 && textCondensed.includes(queryCondensed)) {
                match = true;
            }
        }
        
        row.classList.toggle('d-none', !match);
    });
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
        await API.post('/api/products/update-prices', { prices });
        UI.closeModal();
        UI.toast('✅ Прайс-лист успешно обновлен', 'success');
        if (typeof loadSalesData === 'function') loadSalesData(false);
    } catch (e) { console.error(e); }
};

window.openContractManager = async function () {
    const cpId = document.getElementById('sale-client').value;
    const cpName = document.getElementById('sale-client').options[document.getElementById('sale-client').selectedIndex].text;
    if (!cpId) return UI.toast('Сначала выберите клиента!', 'warning');

    try {
        const data = await API.get(`/api/counterparties/${cpId}/contracts`);

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
                                <button class="btn btn-outline p-5 border-info text-info font-11" onclick="void window.openPrintUrl('/print/contract?id=${c.id}')" title="Распечатать">🖨️</button>
                                <button class="btn btn-outline p-5 border-danger text-danger font-11" onclick="deleteContract(${c.id})" title="Удалить">❌</button>
                            </div>
                        </div>
                        <div class="pl-15">
                            ${c.specs.length === 0 ? '<span class="text-muted font-11">Нет прикрепленных спецификаций</span>' : ''}
                            ${c.specs.map(s => `
                                <div class="flex-between align-center font-12 text-muted mb-5">
                                    <span>↳ Спецификация №${s.number} от ${s.date}</span>
                                    <div class="flex-row gap-5">
                                        <button class="btn btn-outline p-5 border-info text-info font-11 border-none" onclick="void window.openPrintUrl('/print/specification_doc?id=${s.id}')" title="Печать спецификации">🖨️</button>
                                        <button class="btn btn-outline p-5 border-danger text-danger font-11 border-none" onclick="deleteSpecification(${s.id})" title="Удалить спецификацию">❌</button>
                                    </div>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                `;
            });
        }

        const html = `
            <div class="mb-20 pr-5 border-bottom pb-15 overflow-auto" class="max-h-350p">
                <h4 class="m-0 mb-10 text-muted">Актуальные документы:</h4>
                ${listHtml}
            </div>

            <div class="mb-15 p-15 bg-surface-hover border border-radius-6">
                <h4 class="m-0 mb-10 text-primary">📄 Создать новый договор</h4>
                <input type="text" class="d-none" autocomplete="username">
                <input type="password" class="d-none" autocomplete="current-password">
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
        <div class="form-group m-0">
            <label>Причина удаления (обязательно)</label>
            <textarea id="sales-delete-contract-reason" class="input-modern" rows="3" placeholder="Например: договор-дубль"></textarea>
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
    const reason = (document.getElementById('sales-delete-contract-reason')?.value || '').trim();
    if (!reason) return UI.toast('Укажите причину удаления договора', 'warning');
    UI.closeModal();
    UI.toast('⏳ Удаление...', 'info');

    try {
        await API.delete(`/api/contracts/${id}?reason=${encodeURIComponent(reason)}`);
        UI.toast('✅ Договор удален', 'success');
        const clientSelect = document.getElementById('sale-client');
        const cpId = clientSelect ? clientSelect.value : null;
        if (cpId && typeof loadClientContracts === 'function') {
            await loadClientContracts(cpId);
        }
        if (typeof openContractManager === 'function') {
            openContractManager();
        }
    } catch (e) { /* тост с текстом от API */ }
};

// === КРАСИВОЕ УДАЛЕНИЕ СПЕЦИФИКАЦИИ ===
window.deleteSpecification = function (id) {
    const html = `
        <div class="p-15 text-center font-15">
            Вы уверены, что хотите удалить эту спецификацию?<br>
            <small class="text-muted">Это действие нельзя отменить.</small>
        </div>
        <div class="form-group m-0">
            <label>Причина удаления (обязательно)</label>
            <textarea id="sales-delete-spec-reason" class="input-modern" rows="3" placeholder="Например: заменена новой спецификацией"></textarea>
        </div>`;

    UI.showModal('⚠️ Удаление спецификации', html, `
        <button class="btn btn-outline" onclick="cancelDeleteSpecification()">Отмена</button>
        <button class="btn btn-blue" class="bg-danger-btn border-danger text-white" onclick="executeDeleteSpecification(${id})">🗑️ Да, удалить</button>
    `);
};

// Функция возврата (чтобы не зависало при отмене)
window.cancelDeleteSpecification = function () {
    UI.closeModal();
    // Возвращаем окно управления договорами, откуда и вызывалось удаление
    if (typeof openContractManager === 'function') openContractManager();
};

window.executeDeleteSpecification = async function (id) {
    const reason = (document.getElementById('sales-delete-spec-reason')?.value || '').trim();
    if (!reason) return UI.toast('Укажите причину удаления спецификации', 'warning');
    try {
        await API.delete(`/api/specifications/${id}?reason=${encodeURIComponent(reason)}`);
        UI.toast('✅ Спецификация удалена', 'success');
        UI.closeModal();
        const saleClient = document.getElementById('sale-client');
        if (saleClient && typeof loadClientContracts === 'function') {
            await loadClientContracts(saleClient.value);
        }
        if (typeof openContractManager === 'function') openContractManager();
    } catch (e) {
        cancelDeleteSpecification();
    }
};

window.saveNewContract = async function (cpId) {
    const num = document.getElementById('new-contract-num').value.trim();
    const date = document.getElementById('new-contract-date').value;
    if (!num || !date) return UI.toast('Заполните номер и дату!', 'warning');

    try {
        await API.post('/api/contracts', { counterparty_id: cpId, number: num, date: date });
        UI.toast('Договор создан', 'success');
        loadClientContracts();
        UI.closeModal();
    } catch (e) { /* тост API */ }
};

window.saveNewSpecification = async function () {
    const cId = document.getElementById('new-spec-contract-id').value;
    const num = document.getElementById('new-spec-num').value.trim();
    const date = document.getElementById('new-spec-date').value;
    if (!cId || !num || !date) return UI.toast('Заполните все поля спецификации!', 'warning');

    try {
        await API.post('/api/specifications', { contract_id: cId, number: num, date: date });
        UI.toast('Спецификация добавлена', 'success');
        loadClientContracts();
        UI.closeModal();
    } catch (e) { /* тост API */ }
};

// --- ЛОГИКА ДЛЯ sales.js ---

// Показываем кнопку расчета только когда выбран товар
// (нужно добавить этот вызов в onChange твоего TomSelect продукции в продажах)
window.onSalesProductChange = function (productId) {
    const btn = document.getElementById('btn-calc-sales-cost');
    if (productId) btn.classList.remove('d-none');
    else btn.classList.add('d-none');
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
            <div class="sales-live-calc-pad">

                <!-- Шапка: Партия + Прибыль -->
                <div class="flex-between align-end mb-18 pb-12 border-bottom-2">
                    <div>
                        <div class="font-13 text-muted">Объем партии: <b class="text-main">${qty} ${currentSelectedItem.unit || 'шт.'}</b> × <b class="text-main">${salePrice} ₽</b></div>
                    </div>
                    <div class="text-right">
                        <div class="font-11 text-muted text-uppercase sales-calc-micro-label">Чистая прибыль (Партия)</div>
                        <div id="res-batch-profit" class="font-28 font-900 text-success line-height-1">0.00 ₽</div>
                    </div>
                </div>

                <div class="calc-grid">
                    
                    <!-- ======== ЛЕВАЯ КОЛОНКА: Таблица сырья ======== -->
                    <div>
                        <div class="calc-card sales-calc-card-reset">
                            <div class="crm-header-row">
                                <span class="font-13 font-bold text-main">📦 Сравнительный расход сырья</span>
                            </div>
                            <div class="overflow-x-auto sales-calc-x-scroll">
                                <table class="table-modern w-100 sales-calc-table-mini">
                                    <thead class="bg-surface-alt">
                                        <tr class="border-b">
                                            <th rowspan="2" class="th-sub header-border">МАТЕРИАЛ</th>
                                            <th colspan="2" class="td-center border-r font-11 text-muted">РАСХОД (1 ЕД)</th>
                                            <th colspan="2" class="td-center border-r font-11 text-muted">СУММА (1 ЕД)</th>
                                            <th rowspan="2" class="td-right font-11 text-muted">ФАКТ<br>(ПАРТИЯ)</th>
                                        </tr>
                                        <tr class="border-b-2">
                                            <th class="td-center font-10 text-primary border-r-dashed">📐 Идеал</th>
                                            <th class="td-center font-10 text-orange border-r">🧪 Опыт</th>
                                            <th class="td-center font-10 text-primary border-r-dashed">📐 Идеал</th>
                                            <th class="td-center font-10 text-orange border-r">🧪 Опыт</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        ${data.materials.map(m => `
                                            <tr class="sales-calc-row-sep">
                                                <td class="font-600 border-r padding-7-10">${m.name}</td>
                                                <td class="td-center text-primary border-r-dashed padding-7-6">${m.theory_qty > 0 ? m.theory_qty.toFixed(3) : '-'} <small>${m.unit}</small></td>
                                                <td class="td-center text-orange font-700 border-r padding-7-6">
                                                    ${m.fact_qty > 0 ? m.fact_qty.toFixed(3) : '-'} <small>${m.unit}</small>
                                                    ${m.is_hybrid ? '<span title="Нет факта — подставлено из рецепта" class="sales-cursor-help">🪄</span>' : ''}
                                                </td>
                                                <td class="td-right text-primary border-r-dashed padding-7-6">${m.theory_cost > 0 ? m.theory_cost.toFixed(2) + ' ₽' : '-'}</td>
                                                <td class="td-right text-orange font-700 border-r padding-7-6">${m.fact_cost > 0 ? m.fact_cost.toFixed(2) + ' ₽' : '-'}</td>
                                                <td class="td-right font-700 text-danger padding-7-6">${m.fact_cost > 0 ? (m.fact_cost * qty).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₽' : '-'}</td>
                                            </tr>
                                        `).join('')}
                                    </tbody>
                                    <tfoot class="bg-surface-alt border-t-2">
                                        <tr class="sales-calc-tr-bold">
                                            <td class="border-r padding-10">ИТОГО (СЫРЬЕ):</td>
                                            <td class="border-r-dashed padding-10"></td>
                                            <td class="border-r padding-10"></td>
                                            <td class="td-right text-primary border-r-dashed padding-10">${parseFloat(data.theoretical).toLocaleString('ru-RU', { minimumFractionDigits: 2 })} ₽</td>
                                            <td class="td-right text-orange border-r padding-10">${totalFactCost > 0 ? totalFactCost.toLocaleString('ru-RU', { minimumFractionDigits: 2 }) + ' ₽' : '-'}</td>
                                            <td class="td-right text-danger font-13 padding-10">${totalFactCost > 0 ? (totalFactCost * qty).toLocaleString('ru-RU', { minimumFractionDigits: 2 }) + ' ₽' : '-'}</td>
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
                    <div class="sales-calc-stack-col">

                        <!-- Сырье: Идеал vs Опыт -->
                        <div class="calc-card sales-calc-accent-primary">
                            <div class="calc-card-header">📐 Себестоимость сырья (1 ед)</div>
                            <div class="calc-row">
                                <span class="text-muted">Идеал (Рецепт):</span>
                                <b>${data.theoretical} ₽</b>
                            </div>
                            <div class="calc-row" class="badge-surface">
                                <span class="text-muted">🧪 Опыт (Факт):</span>
                                <b class="text-orange">${parseFloat(data.empirical) > 0 ? data.empirical : data.theoretical} ₽</b>
                            </div>
                        </div>

                        <!-- Доп. расходы -->
                        <div class="calc-card sales-calc-accent-warn-orange">
                            <div class="calc-card-header">🔨 Доп. расходы (на 1 ед)</div>
                            <div class="calc-row">
                                <span class="text-muted">Амортизация:</span>
                                <b>${data.amortization} ₽</b>
                            </div>
                            <div class="calc-row">
                                <span class="text-muted">Оверхед (Завод):</span>
                                <b class="text-orange" title="Распределенные косвенные затраты">${data.overhead} ₽</b>
                            </div>
                            <div class="calc-sep"></div>
                            <div class="calc-row">
                                <span class="text-muted">Сдельная З/П:</span>
                                <input type="number" id="calc-wage" class="calc-input" class="text-success border-success" value="${currentSelectedItem.piece_rate || 0}" disabled title="Из Справочника">
                            </div>
                            <div class="calc-row">
                                <span class="text-muted">Упаковка:</span>
                                <input type="number" id="calc-pack" class="calc-input" value="0" step="1" onfocus="this.select()" oninput="recalcSalesMargin()">
                            </div>
                        </div>

                        <!-- Коммерция -->
                        <div class="calc-card sales-calc-accent-danger">
                            <div class="calc-card-header">💼 Коммерция и Налоги</div>
                            <div class="calc-row">
                                <span class="text-muted">Цена (1 ед):</span>
                                <b>${salePrice} ₽</b>
                            </div>
                            <div class="calc-row">
                                <span class="text-danger">Налог (%):</span>
                                <input type="number" id="calc-tax-pct" class="calc-input border-danger" value="${window.FINANCE_TAX_PERCENT || 6}" step="1" max="100" onfocus="this.select()" oninput="recalcSalesMargin()">
                            </div>
                            <div class="calc-row">
                                <span class="text-info">Бонус менедж. (%):</span>
                                <input type="number" id="calc-bonus-pct" class="calc-input border-info" value="0" step="0.5" max="100" onfocus="this.select()" oninput="recalcSalesMargin()">
                            </div>
                        </div>

                        <!-- Результат -->
                        <div class="calc-card" class="bg-surface-alt">
                            <div class="calc-row" class="border-b-dashed pb-6 mb-8">
                                <span>Произв. себестоимость:</span>
                                <strong id="res-prod-cost">0.00 ₽</strong>
                            </div>
                            <div class="calc-row" class="border-b pb-8 mb-10">
                                <span>Налоги и комиссии:</span>
                                <strong id="res-taxes" class="text-danger">-0.00 ₽</strong>
                            </div>
                            <div class="sales-calc-total-row">
                                <div class="font-11 text-uppercase font-700 text-muted">Чистая прибыль (1 ед)</div>
                                <div class="text-right">
                                    <div id="res-net-profit" class="font-22 font-900 line-height-1 text-success">0.00 ₽</div>
                                    <div id="res-margin-pct" class="font-12 font-700 text-success mt-3">Рентабельность: 0%</div>
                                </div>
                            </div>
                        </div>

                    </div>
                </div>
            </div>
        `;

        UI.showModal(`📊 Калькулятор себестоимости: ${currentSelectedItem.name}`, html, `<button class="btn btn-blue w-100 modal-btn-primary-large" onclick="UI.closeModal()">Закрыть анализ</button>`);

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
        profitEl.classList.add('text-success'); profitEl.classList.remove('text-primary', 'text-muted', 'text-danger');
        marginEl.innerText = `Рентабельность сделки: ${netMargin}%`;
        marginEl.classList.add('text-success'); marginEl.classList.remove('text-primary', 'text-muted', 'text-danger');
        batchProfitEl.classList.add('text-success'); batchProfitEl.classList.remove('text-primary', 'text-muted', 'text-danger');
    } else {
        profitEl.innerText = netProfit.toFixed(2) + ' ₽';
        profitEl.classList.add('text-danger'); profitEl.classList.remove('text-primary', 'text-success', 'text-muted');
        marginEl.innerText = `Убыток: ${netMargin}%`;
        marginEl.classList.add('text-danger'); marginEl.classList.remove('text-primary', 'text-success', 'text-muted');
        batchProfitEl.classList.add('text-danger'); batchProfitEl.classList.remove('text-primary', 'text-success', 'text-muted');
    }

    batchProfitEl.innerText = batchProfit.toLocaleString('ru-RU', { minimumFractionDigits: 2 }) + ' ₽';
};


// ==========================================
// === ОТГРУЗКА ЧАСТЯМИ ИЗ АКТИВНОГО ЗАКАЗА ===
// ==========================================
window.openOrderManager = async function (orderId) {
    try {
        const data = await API.get(`/api/sales/orders/${orderId}`);
        const order = data.order;
        const items = data.items;

        let itemsHtml = items.map(i => {
            const ordered = parseFloat(i.qty_ordered);
            const shipped = parseFloat(i.qty_shipped || 0);
            const reserved = parseFloat(i.qty_reserved || 0);
            const production = parseFloat(i.qty_production || 0);
            const remain = ordered - shipped;
            const remainText = remain > 0 ? remain : 0;

            let actionsHtml = '';
            if (production > 0) {
                actionsHtml = `<button class="btn btn-outline sales-btn-sm sales-btn-xs mt-5" onclick="openReserveTransferModal(${i.id}, ${order.id}, ${i.item_id}, '${Utils.escapeHtml(i.name)}', ${production})">🔄 Перехватить</button>`;
            }

            return `
                <tr class="sales-ship-tr">
                    <td class="sales-ship-td">
                        ${i.name}
                        ${actionsHtml ? '<br>' + actionsHtml : ''}
                    </td>
                    <td class="sales-ship-td-center-bold">${ordered}</td>
                    <td class="padding-8 td-center text-success font-bold">${shipped}</td>
                    <td class="padding-8 td-center text-primary font-bold">${reserved}</td>
                    <td class="padding-8 td-center text-danger font-bold">${production}</td>
                    <td class="sales-ship-td-center">
                        <input type="number" class="input-modern ship-qty-input td-center border-primary font-bold"
                               data-coi-id="${i.id}" data-item-id="${i.item_id}" 
                               max="${remainText}" value="${Math.min(remainText, reserved)}" 
                               ${remainText <= 0 ? 'disabled' : ''}
                               onfocus="this.select()">
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
                <div class="bg-surface-hover p-15 border-radius-6 border dashed mb-15">
                    <h4 class="m-0 mb-15 text-primary">🚚 Фактические данные отгрузки</h4>
                    <div class="form-grid gap-15 sales-two-cols mb-10">
                        <div class="form-group m-0">
                            <label class="font-12 text-muted">Дата факта отгрузки:</label>
                            <input type="date" id="ship-date" class="input-modern" value="${new Date().toISOString().split('T')[0]}">
                        </div>
                        <div class="form-group m-0">
                            <label class="font-12 text-muted">Поддоны (шт):</label>
                            <input type="number" id="ship-pallets" class="input-modern" placeholder="Количество" min="0">
                        </div>
                        <div class="form-group m-0">
                            <label class="font-12 text-muted">ФИО Водителя:</label>
                            <input type="text" id="ship-driver" class="input-modern" placeholder="Иванов И.И.">
                        </div>
                        <div class="form-group m-0">
                            <label class="font-12 text-muted">Автомобиль:</label>
                            <input type="text" id="ship-auto" class="input-modern" placeholder="Гос. номер (Е123КХ)">
                        </div>
                    </div>
                    <div class="form-group m-0 sales-ship-poa-grid">
                        <label class="font-12 text-muted mb-5">Основание (Доверенность) <span class="text-danger">*</span></label>
                        <div class="flex-column gap-10">
                            <div id="ship-poa-container" class="flex-row gap-10">
                                <select id="ship-poa-select" class="input-modern flex-grow-1"></select>
                                <button type="button" class="btn btn-outline sales-btn-pad-x" onclick="openPoaManager(${order.counterparty_id}, 'ship-poa-select')">➕ Новая</button>
                            </div>
                            
                            <label class="d-flex align-center cursor-pointer m-0 mt-5">
                                <input type="checkbox" id="ship-no-poa" class="mr-10 sales-chk-16" onchange="toggleShipPoa()">
                                <span class="font-13">Без доверенности (Только по звонку / Особое распоряжение)</span>
                            </label>

                            <input type="text" id="ship-poa-comment" class="input-modern sales-hidden" placeholder="Кто разрешил отгрузку без доверенности? (Например: Звонок директора)">
                        </div>
                    </div>
                </div>

                <table class="table-modern w-100 mb-15">
                    <thead class="bg-info-lt">
                        <tr>
                            <th class="p-10 text-left">Продукция</th>
                            <th class="p-10 text-center">Заказ</th>
                            <th class="p-10 text-center">Отгружено</th>
                            <th class="p-10 text-center text-primary">В Резерве</th>
                            <th class="p-10 text-center text-danger">Ожидает</th>
                            <th class="p-10 text-center text-primary">Грузим (факт)</th>
                        </tr>
                    </thead>
                    <tbody>${itemsHtml}</tbody>
                </table>
            </div>
        `;

        let advanceBtnHtml = '';
        if (parseFloat(order.pending_debt) > 0 && parseFloat(order.free_advance || 0) > 0) {
            advanceBtnHtml = `<button class="btn btn-outline sales-btn-sm text-success" onclick="applyAdvanceToOrder(${order.id})">💰 Зачесть из аванса (${parseFloat(order.free_advance).toLocaleString('ru-RU')} ₽)</button>`;
        }

        UI.showModal(`Управление заказом: ${order.doc_number}`, html, `
            <div class="d-flex gap-10 flex-wrap mb-15 w-100 sales-ship-footer-dash">
                <button class="btn btn-outline sales-btn-sm text-primary" onclick="UI.closeModal(); loadOrderForEdit(${order.id})">✏️ Изменить (Товары / Цены)</button>
                <button class="btn btn-outline sales-btn-sm text-danger" onclick="UI.closeModal(); forceCloseOrder(${order.id}, '${order.doc_number}')">❌ Принудительно закрыть (Отменить остатки)</button>
                ${advanceBtnHtml}
            </div>
            <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
            <button class="btn btn-blue" id="btn-do-ship" onclick="executePartialShipment(${order.id}, this)">🚚 Отгрузить выбранное</button>
        `);

    } catch (e) { console.error(e); UI.toast('Ошибка', 'error'); }
};

window.toggleShipPoa = function() {
    const noPoa = document.getElementById('ship-no-poa');
    const poaContainer = document.getElementById('ship-poa-container');
    const poaComment = document.getElementById('ship-poa-comment');
    if (!noPoa) return;
    
    if (noPoa.checked) {
        if(poaContainer) poaContainer.classList.add('d-none');
        if(poaComment) poaComment.classList.remove('sales-hidden');
    } else {
        if(poaContainer) poaContainer.classList.remove('d-none');
        if(poaComment) { poaComment.value = ''; poaComment.classList.add('sales-hidden'); }
    }
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

    const driver = document.getElementById('ship-driver')?.value.trim() || '';
    const auto = document.getElementById('ship-auto')?.value.trim() || '';
    const pallets = parseInt(document.getElementById('ship-pallets')?.value) || 0;
    const shipDate = document.getElementById('ship-date') ? document.getElementById('ship-date').value : new Date().toISOString().split('T')[0];

    // Проверка доверенности
    let poa_info = '';
    const noPoa = document.getElementById('ship-no-poa');
    if (noPoa && noPoa.checked) {
        const comment = document.getElementById('ship-poa-comment')?.value.trim();
        if (!comment) {
            if (btnElement) btnElement.disabled = false;
            return UI.toast('Укажите, кто разрешил отгрузку без доверенности!', 'error');
        }
        poa_info = `Без доверенности. Разрешил: ${comment}`;
    } else {
        const sel = document.getElementById('ship-poa-select');
        if (!sel || !sel.value) {
            if (btnElement) btnElement.disabled = false;
            return UI.toast('Выберите доверенность из списка!', 'error');
        }
        poa_info = sel.value;
    }

    try {
        const data = await API.post(`/api/sales/orders/${orderId}/ship`, { items_to_ship, driver, auto, poa_info, pallets, ship_date: shipDate });
        UI.closeModal();
        UI.toast(`✅ Накладная ${data.docNum} успешно создана!`, 'success');

        if (data.isCompleted) {
            UI.toast('🎉 Заказ полностью выполнен!', 'success');
        }

        // Обновляем таблицы и канбан
        if (typeof loadActiveOrders === 'function') loadActiveOrders();
        if (typeof loadSalesHistory === 'function') loadSalesHistory();
        if (typeof loadTable === 'function') loadTable();
        if (typeof refreshShipmentDashboardIfActive === 'function') refreshShipmentDashboardIfActive();
    } catch (e) {
        console.error('[Shipment Error]', e);
    } finally {
        if (btnElement) btnElement.disabled = false;
    }
};

// ==========================================
// === ВОЗВРАТЫ (ТОВАР И ПОДДОНЫ) ===
// ==========================================
window.salesToggleRetMethod = function (methodSelect) {
    const g = document.getElementById('ret-acc-group');
    if (!g) return;
    const v = methodSelect && typeof methodSelect.value === 'string' ? methodSelect.value : String(methodSelect || '');
    g.classList.toggle('d-none', v !== 'cash');
};

window.loadClientOrdersForReturn = async function (clientId) {
    const orderSelect = document.getElementById('ret-order');
    if (!orderSelect) return;
    
    if (!clientId) {
        orderSelect.innerHTML = '<option value="">-- Выберите клиента сначала --</option>';
        if (orderSelect.tomselect) orderSelect.tomselect.sync();
        return;
    }
    
    try {
        const orders = await API.get('/api/sales/client-orders/' + clientId);
        let options = '<option value="">-- Выберите заказ --</option>';
        orders.forEach(o => {
            options += `<option value="${o.id}">${o.doc_number} (от ${new Date(o.created_at).toLocaleDateString('ru-RU')} - ${o.status})</option>`;
        });
        orderSelect.innerHTML = options;
        if (orderSelect.tomselect) orderSelect.tomselect.sync();
    } catch (e) {
        console.error('Ошибка загрузки заказов клиента', e);
        UI.toast('Не удалось загрузить заказы клиента', 'error');
    }
};

window.openReturnModal = async function () {
    try {
        const clients = await API.get('/api/counterparties');
        const accounts = await API.get('/api/accounts');

        let clientOptions = '<option value="">-- Выберите клиента --</option>' + clients.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
        let accountOptions = '<option value="">-- Выберите кассу --</option>' + accounts.map(a => `<option value="${a.id}">${a.name} (${a.balance} ₽)</option>`).join('');

        const html = `
            <div class="p-10">
                <div class="form-group">
                    <label>От кого возврат (Клиент):</label>
                    <select id="ret-client" class="input-modern" onchange="window.loadClientOrdersForReturn(this.value)">${clientOptions}</select>
                </div>
                
                <div class="form-group">
                    <label>Заказ (основание):</label>
                    <select id="ret-order" class="input-modern" onchange="window.loadOrderDetailsForReturn(this.value)">
                        <option value="">-- Выберите клиента сначала --</option>
                    </select>
                </div>

                <div class="bg-surface-hover p-10 border-radius-6 border dashed mb-15">
                    <h4 class="m-0 mb-10 text-muted">🧱 Возврат продукции</h4>
                    <div id="ret-order-items-container" class="font-13 text-muted">
                        Выберите заказ для загрузки списка товаров...
                    </div>
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
                    <select id="ret-method" class="input-modern" onchange="salesToggleRetMethod(this)">
                        <option value="debt">📉 Взаимозачет (Списать с его долга)</option>
                        <option value="cash">💸 Выдать деньги из кассы</option>
                    </select>
                </div>

                <div class="form-group d-none" id="ret-acc-group">
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
            <button type="button" id="ret-submit-btn" class="btn btn-red" onclick="executeReturn()">💾 Провести возврат</button>
        `);

        setTimeout(() => {
            ['ret-client', 'ret-order', 'ret-item', 'ret-wh', 'ret-method', 'ret-account'].forEach(id => {
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
        <tr class="border-bottom">
            <td class="padding-y-4">${c.name}</td>
            <td class="padding-y-4 text-center"><b>${c.qty}</b> ед.</td>
            <td class="padding-y-4 text-muted font-11">${c.whText}</td>
            <td class="padding-y-4 text-right"><button class="btn btn-outline p-2-6 font-10 text-danger border-danger" onclick="window.returnCart.splice(${idx}, 1); renderReturnCart();">❌</button></td>
        </tr>
    `).join('');
};

window.loadOrderDetailsForReturn = async function (orderId) {
    const container = document.getElementById('ret-order-items-container');
    if (!container) return;
    
    if (!orderId) {
        container.innerHTML = 'Выберите заказ для загрузки списка товаров...';
        window.currentOrderItemsForReturn = [];
        return;
    }
    
    try {
        container.innerHTML = 'Загрузка...';
        const data = await API.get('/api/sales/orders/' + orderId);
        window.currentOrderItemsForReturn = data.items || [];
        
        if (window.currentOrderItemsForReturn.length === 0) {
            container.innerHTML = 'В этом заказе нет товаров.';
            return;
        }
        
        let html = `
            <table class="table-modern w-100">
                <thead>
                    <tr>
                        <th>Товар</th>
                        <th>Отгружено</th>
                        <th>Цена</th>
                        <th style="width: 100px;">Вернуть</th>
                        <th>На склад</th>
                    </tr>
                </thead>
                <tbody>
        `;
        
        window.currentOrderItemsForReturn.forEach((item, idx) => {
            const maxReturn = parseFloat(item.qty_shipped) || 0;
            html += `
                <tr>
                    <td>${Utils.escapeHtml(item.name)}</td>
                    <td>${maxReturn} ${Utils.escapeHtml(item.unit || 'шт')}</td>
                    <td>${item.price} ₽</td>
                    <td>
                        <input type="number" class="input-modern p-5 text-center ret-item-qty" 
                               data-idx="${idx}" data-id="${item.item_id}" data-price="${item.price}" data-max="${maxReturn}"
                               min="0" max="${maxReturn}" placeholder="0" oninput="window.calcReturnTotal()">
                    </td>
                    <td>
                        <select class="input-modern p-5 ret-item-wh" data-idx="${idx}">
                            <option value="4">🟢 №4 (ГП)</option>
                            <option value="5">🟡 №5 (Уценка)</option>
                        </select>
                    </td>
                </tr>
            `;
        });
        
        html += `</tbody></table>`;
        container.innerHTML = html;
        window.calcReturnTotal();
    } catch (e) {
        console.error('Ошибка загрузки деталей заказа', e);
        container.innerHTML = '<span class="text-danger">Ошибка загрузки товаров заказа</span>';
    }
};

window.calcReturnTotal = function() {
    let total = 0;
    document.querySelectorAll('.ret-item-qty').forEach(input => {
        const qty = parseFloat(input.value) || 0;
        const max = parseFloat(input.getAttribute('data-max')) || 0;
        if (qty > max) input.value = max;
        const finalQty = parseFloat(input.value) || 0;
        const price = parseFloat(input.getAttribute('data-price')) || 0;
        total += finalQty * price;
    });
    const amountInput = document.getElementById('ret-amount');
    if (amountInput) amountInput.value = total.toFixed(2);
};

window.executeReturn = async function () {
    const clientId = document.getElementById('ret-client').value;
    const orderId = document.getElementById('ret-order').value;
    const pallets = parseInt(document.getElementById('ret-pallets').value) || 0;
    const refundAmt = parseFloat(document.getElementById('ret-amount').value) || 0;
    const method = document.getElementById('ret-method').value;
    const accId = document.getElementById('ret-account').value;
    const reason = document.getElementById('ret-reason').value.trim();

    if (!clientId) return UI.toast('Выберите клиента!', 'warning');
    if (!orderId) return UI.toast('Выберите заказ (основание возврата)!', 'warning');
    
    const returnItems = [];
    document.querySelectorAll('.ret-item-qty').forEach(input => {
        const qty = parseFloat(input.value) || 0;
        if (qty > 0) {
            const idx = input.getAttribute('data-idx');
            const whSelect = document.querySelector(`.ret-item-wh[data-idx="${idx}"]`);
            returnItems.push({
                id: input.getAttribute('data-id'),
                qty: qty,
                price: input.getAttribute('data-price'),
                warehouse_id: whSelect ? whSelect.value : 4
            });
        }
    });

    if (returnItems.length === 0 && pallets === 0 && refundAmt === 0) {
        return UI.toast('Укажите хотя бы что-то для возврата (товар, поддоны или сумму)!', 'warning');
    }
    if (method === 'cash' && refundAmt > 0 && !accId) return UI.toast('Выберите кассу для выдачи денег!', 'warning');

    const submitBtn = document.getElementById('ret-submit-btn');
    const submitBtnHtml = submitBtn ? submitBtn.innerHTML : '';
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = 'Сохранение...';
    }

    try {
        const data = await API.post('/api/sales/returns', { order_id: orderId, counterparty_id: clientId, items: returnItems, pallets_returned: pallets, refund_amount: refundAmt, refund_method: method, account_id: accId, reason: reason });
        UI.closeModal();
        UI.toast(`✅ Возврат ${data.docNum} успешно оформлен!`, 'success');
        loadSalesData(false);
        if (typeof loadTable === 'function') loadTable();
        onClientChange();
    } catch (e) {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = submitBtnHtml;
        }
        console.error('[Return Error]', e);
    }
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
        
        <div class="sales-modal-pad-xs">
            <div class="doc-section">
                <label class="doc-section-title">📊 ПРАЙС-ЛИСТЫ</label>
                <div class="form-grid sales-contract-grid-pair">
                    <button class="doc-btn" onclick="printFile('price_main.pdf')">📄 Основной</button>
                    <button class="doc-btn" onclick="printFile('price_dealer.pdf')">📄 Дилерский</button>
                </div>
            </div>

            <div class="doc-section">
                <label class="doc-section-title">📜 СЕРТИФИКАТЫ ГОСТ</label>
                <div class="form-grid sales-contract-grid-pair">
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

            <div class="border-top sales-contract-sep-dashed"></div>

            <div class="doc-section mb-0">
                <label class="doc-section-title sales-contract-kicker">🏢 КАРТОЧКА ПРЕДПРИЯТИЯ</label>
                <div class="bank-select-group flex-row gap-10 align-center">
                    <select id="bank-select-docs" class="input-modern sales-contract-bank-select">
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
    void window.openPrintUrl(`/files/${fileName}`);
};

// Функция для открытия реквизитов выбранного банка
window.printBankRequisites = function () {
    const bank = document.getElementById('bank-select-docs').value;
    // Теперь обращаемся к серверу, а он сам решит: отдать EJS или PDF
    void window.openPrintUrl(`/print/requisites?bank=${bank}`);
};

// === КОММЕРЧЕСКОЕ ПРЕДЛОЖЕНИЕ (КП) ===
window.generateKP = async function () {
    const clientId = document.getElementById('sale-client').value;
    if (!clientId) return UI.toast('Выберите контрагента для выставления КП!', 'warning');
    if (cart.length === 0) return UI.toast('Корзина пуста!', 'warning');

    const discount = document.getElementById('sale-discount').value || 0;
    const logisticsCost = getEffectiveLogisticsCost();
    const orderDate = document.getElementById('sale-order-date')?.value || new Date().toISOString().split('T')[0];

    let printTok;
    try {
        printTok = await window.getPrintToken();
    } catch (e) {
        UI.toast(e.message || 'Ошибка print-токена', 'error');
        return;
    }

    const form = document.createElement('form');
    form.method = 'POST';
    form.action = '/print/kp';
    form.target = '_blank';

    const printItems = cart.map((c) => ({
        name: c.name,
        unit: c.unit,
        qty: c.qty,
        price: c.price,
        discount: c.discount != null ? c.discount : 0,
        weight: c.weight
    }));
    const data = { client_id: clientId, items: printItems, discount: discount, logistics: logisticsCost, orderDate: orderDate };

    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = 'data';
    input.value = JSON.stringify(data);

    form.appendChild(input);
    const tokInput = document.createElement('input');
    tokInput.type = 'hidden';
    tokInput.name = 'print_token';
    tokInput.value = printTok;
    form.appendChild(tokInput);
    document.body.appendChild(form);
    form.submit();
    document.body.removeChild(form);
};

// === ПЕЧАТЬ БЛАНК-ЗАКАЗА ИЗ КОРЗИНЫ ===
window.generateBlankOrder = async function () {
    const clientId = document.getElementById('sale-client').value;
    if (!clientId) return UI.toast('Выберите контрагента!', 'warning');
    if (cart.length === 0) return UI.toast('Корзина пуста!', 'warning');

    const discount = document.getElementById('sale-discount').value || 0;
    const logisticsCost = getEffectiveLogisticsCost();

    // Считываем новые данные: Оплата и Поддоны
    const paymentMethod = document.getElementById('sale-payment-method').value;
    const advanceAmount = document.getElementById('sale-advance-amount')?.value || 0;
    const pallets = document.getElementById('sale-pallets')?.value || 0;
    const deliveryAddress = document.getElementById('sale-delivery-address')?.value || '';
    const orderDate = document.getElementById('sale-order-date')?.value || new Date().toISOString().split('T')[0];

    let printTok;
    try {
        printTok = await window.getPrintToken();
    } catch (e) {
        UI.toast(e.message || 'Ошибка print-токена', 'error');
        return;
    }

    const form = document.createElement('form');
    form.method = 'POST';
    form.action = '/print/blank_order_draft';
    form.target = '_blank';

    const printItems = cart.map((c) => ({
        name: c.name,
        unit: c.unit,
        qty: c.qty,
        price: c.price,
        discount: c.discount != null ? c.discount : 0,
        weight: c.weight
    }));
    const data = {
        client_id: clientId,
        items: printItems,
        discount: discount,
        logistics: logisticsCost,
        paymentMethod: paymentMethod,
        advanceAmount: advanceAmount,
        pallets: pallets,
        delivery_address: (() => {
            const deliveryType = document.querySelector('input[name="sale_delivery_type"]:checked');
            if (deliveryType && deliveryType.value === 'pickup') {
                return 'Самовывоз';
            }
            return document.getElementById('sale-delivery-address')?.value || '';
        })(),
        orderDate: orderDate
    };

    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = 'data';
    input.value = JSON.stringify(data);

    form.appendChild(input);
    const tokInput = document.createElement('input');
    tokInput.type = 'hidden';
    tokInput.name = 'print_token';
    tokInput.value = printTok;
    form.appendChild(tokInput);
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

    void window.openPrintUrl(`/print/invoice?docNum=${docNum}&bank=${bank}&custom_amount=${customAmt}`);
    UI.closeModal();
    setTimeout(() => { if (typeof loadActiveOrders === 'function') loadActiveOrders(); }, 600);
};

// МАГИЯ ВЗАИМОЗАЧЕТА
window.offsetOrderAdvance = async function (docNum, amount) {
    let accOptions = '<option value="">Автоматически (Основная касса)</option>';
    try {
        const accounts = await API.get('/api/accounts');
        accounts.forEach(a => {
            accOptions += `<option value="${a.id}">${a.name} (${a.balance} ₽)</option>`;
        });
    } catch (e) { }

    UI.showModal('Взаимозачет аванса', `
        <div class="p-10 font-14 text-center">
            На балансе клиента есть свободные средства.<br>
            Зачесть <b>${amount.toLocaleString('ru-RU')} ₽</b> в счет оплаты заказа <b>${docNum}</b>?
            
            <div class="mt-20 text-left bg-surface-hover padding-10 border-radius-6 border-dashed">
                <label class="font-12 text-muted font-bold">Через какую кассу провести операцию:</label>
                <select id="offset-account-select" class="input-modern mt-5">
                    ${accOptions}
                </select>
                <span class="font-11 text-muted d-block mt-5">Будет создана парная операция (расход+приход) для закрытия долга.</span>
            </div>
        </div>`, `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-blue bg-success border-success text-white" id="btn-do-offset" onclick="executeOffset('${docNum}', ${amount}, this)">✅ Провести зачет</button>
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
        await API.post('/api/sales/orders/offset', { docNum, amount, account_id: accountId });
        UI.closeModal();
        UI.toast('Взаимозачет успешно проведен!', 'success');
        if (typeof loadActiveOrders === 'function') loadActiveOrders();
        if (typeof onClientChange === 'function') onClientChange();
    } catch (e) {
        console.error('[Offset Error]', e);
    } finally {
        if (btnElement) btnElement.disabled = false;
    }
};

// === ОТЧЕТ: ДОЛЖНИКИ ПО ТАРЕ (ПОДДОНЫ) ===
window.openPalletsReport = async function () {
    try {
        const data = await API.get('/api/sales/pallets-report');

        let tbody = data.map(c => `
            <tr class="sales-ship-tr">
                <td class="p-10"><b>${c.name}</b></td>
                <td class="padding-10 text-muted">${c.phone || 'Нет телефона'}</td>
                <td class="padding-10 td-right text-warning font-bold font-16">${c.pallets_balance} шт.</td>
            </tr>
        `).join('');

        if (data.length === 0) tbody = '<tr><td colspan="3" class="sales-empty-muted">Нет должников по таре 🎉</td></tr>';

        const totalPallets = data.reduce((sum, c) => sum + parseInt(c.pallets_balance), 0);

        const html = `
            <div class="p-10">
                <div class="alert-warning padding-15 border-radius-8 mb-15 td-center">
                    <span class="text-warning-dark font-14">Всего деревянных поддонов зависло у клиентов:</span><br>
                    <strong class="font-26 text-warning">${totalPallets} шт.</strong>
                </div>
                <table class="sales-pallet-score-table">
                    <thead class="bg-surface-hover text-left">
                        <tr>
                            <th class="p-10">Клиент</th>
                            <th class="p-10">Телефон для связи</th>
                            <th class="sales-pallet-th-num">Долг (шт)</th>
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
        const data = await API.get('/api/sales/analytics');

        const formatSum = (sum) => parseFloat(sum).toLocaleString('ru-RU') + ' ₽';
        const maxItemSum = data.topItems.length > 0 ? parseFloat(data.topItems[0].total_sum) : 1;

        // Рисуем бары для товаров
        let itemsHtml = data.topItems.map((i, idx) => `
            <div class="mb-12">
                <div class="flex-between font-12 mb-5">
                    <span class="text-truncate sales-top-item-name"><b>${idx + 1}.</b> ${i.name} (${i.total_qty} шт)</span>
                    <span class="font-bold text-success">${formatSum(i.total_sum)}</span>
                </div>
                <div class="bg-surface-alt border-radius-4 overflow-hidden h-8">
                    <div class="h-100 border-radius-4 overflow-hidden sales-score-bar-fill" style="width: ${(parseFloat(i.total_sum) / maxItemSum) * 100}%;"></div>
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
                <div class="p-25 border-radius-12 text-center mb-20 shadow-sm text-white sales-stat-hero-banner">
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
            <div class="bg-surface-hover border border-radius-8 p-15 flex-shrink-0 sales-log-card-col">
                <h4 class="m-0 text-main border-bottom pb-8 mb-15 sales-logistics-date-title ${isToday ? 'sales-logistics-date-title--today' : 'sales-logistics-date-title--usual'}">
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
                <div class="form-group m-0 pl-10 sales-export-label-left">
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
                <div class="form-group m-0 sales-export-label-left">
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
    void window.openPrintUrl(`/api/sales/export-1c?month=${m}&year=${y}`);
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
                        input.classList.add('sales-price-input--import-dealer');
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
                                    input.classList.add('sales-price-input--import-basic');
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
        if (boSelect.tomselect) {
            // Обновляем через TomSelect API
            const cur = boSelect.tomselect.getValue();
            boSelect.tomselect.clearOptions();
            boSelect.tomselect.addOption({ value: '', text: '🌐 Все клиенты' });
            Array.from(orderClients).sort().forEach(c =>
                boSelect.tomselect.addOption({ value: c, text: c })
            );
            boSelect.tomselect.refreshOptions(false);
            boSelect.tomselect.setValue(cur || '', true);
        } else {
            // Fallback: нативный select
            const cur = boSelect.value;
            boSelect.innerHTML = '<option value="">🌐 Все клиенты</option>';
            Array.from(orderClients).sort().forEach(c => boSelect.add(new Option(c, c)));
            boSelect.value = cur;
        }
    }

    // Собираем уникальных клиентов из истории
    const histClients = new Set();
    allSalesHistory.forEach(h => { if (h.client_name) histClients.add(h.client_name); });

    const histSelect = document.getElementById('hist-client-filter');
    if (histSelect) {
        if (histSelect.tomselect) {
            const cur = histSelect.tomselect.getValue();
            histSelect.tomselect.clearOptions();
            histSelect.tomselect.addOption({ value: '', text: '🌐 Все клиенты' });
            Array.from(histClients).sort().forEach(c =>
                histSelect.tomselect.addOption({ value: c, text: c })
            );
            histSelect.tomselect.refreshOptions(false);
            histSelect.tomselect.setValue(cur || '', true);
        } else {
            const cur = histSelect.value;
            histSelect.innerHTML = '<option value="">🌐 Все клиенты</option>';
            Array.from(histClients).sort().forEach(c => histSelect.add(new Option(c, c)));
            histSelect.value = cur;
        }
    }
}

window.applyOrderFilters = function () { boPage = 1; renderBlankOrdersTable(); };

window.resetOrderFilters = function () {
    const s = document.getElementById('bo-search');
    const c = document.getElementById('bo-client-filter');
    const p = document.getElementById('bo-product-filter');
    const sf = document.getElementById('bo-status-filter');
    if (s) s.value = '';
    if (c) {
        if (c.tomselect) c.tomselect.setValue('', true);
        else c.value = '';
    }
    if (p) p.value = '';
    if (sf) sf.value = '';
    // Сброс pill-chips
    document.querySelectorAll('#bo-status-chips .sales-chip').forEach(btn => {
        btn.classList.toggle('sales-chip--active', btn.dataset.value === '');
    });
    const boIds = salesPeriodFieldIds('sales-bo');
    salesPeriodApplyFromMode(boIds, window.__salesBoPeriodPickers, 'all_time', new Date(), true);
};

/** Установить статус оплаты через pill-chip и hidden input */
window.setBoPillStatus = function (val) {
    const sf = document.getElementById('bo-status-filter');
    if (sf) sf.value = val;
    document.querySelectorAll('#bo-status-chips .sales-chip').forEach(btn => {
        btn.classList.toggle('sales-chip--active', btn.dataset.value === val);
    });
    applyOrderFilters();
};

// === CRM ВОРОНКА (КАНБАН) ===

window.toggleSalesView = function (viewType) {
    const tableWrap = document.getElementById('sales-table-wrapper');
    const kanbanWrap = document.getElementById('sales-kanban-board');
    const btnList = document.getElementById('view-btn-list');
    const btnKanban = document.getElementById('view-btn-kanban');

    if (viewType === 'kanban') {
        if (tableWrap) tableWrap.classList.add('d-none');
        kanbanWrap.classList.remove('d-none');
        btnList.className = 'btn btn-outline';
        btnKanban.className = 'btn btn-blue';
        renderKanbanBoard();
    } else {
        kanbanWrap.classList.add('d-none');
        if (tableWrap) tableWrap.classList.remove('d-none');
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

        const kbReturnBadge = (order.has_returns === true || order.has_returns === 't')
            ? '<span class="font-11 text-warning ml-5" title="По заказу были возвраты">↩️</span>'
            : '';

        card.innerHTML = `
            <div class="kanban-card-header">
                <span>${order.id ? `<span class="entity-link" onclick="window.app.openEntity('document_order', ${order.id})">${order.doc_number}</span>${kbReturnBadge}` : order.doc_number}</span>
                <span title="Дедлайн">⏳ ${order.deadline || order.date_formatted}</span>
            </div>
            <div class="kanban-card-client">
                ${order.counterparty_id ? `<span class="entity-link" onclick="window.app.openEntity('client', ${order.counterparty_id})">${Utils.escapeHtml(order.client_name)}</span>` : Utils.escapeHtml(order.client_name)}
            </div>
            <div class="kanban-card-items">
                ${Utils.escapeHtml(order.items_list)}
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
            setTimeout(() => card.classList.add('kanban-card--dragging'), 0);
        });
        card.addEventListener('dragend', () => card.classList.remove('kanban-card--dragging'));

        const column = document.querySelector(`.kanban-column[data-status="${order.status}"] .kanban-items-container`);
        if (column) column.appendChild(card);
    });

    // Обновляем счетчики в заголовках колонок
    document.querySelector('.kanban-column[data-status="pending"] .column-count').innerText = counts.pending;
    document.querySelector('.kanban-column[data-status="processing"] .column-count').innerText = counts.processing;

    document.querySelectorAll('.kanban-column').forEach((col) => {
        const onOver = (e) => {
            e.preventDefault();
            col.classList.add('kanban-col--drag-over');
        };
        const onLeave = () => col.classList.remove('kanban-col--drag-over');
        const onDrop = async (e) => {
            e.preventDefault();
            col.classList.remove('kanban-col--drag-over');

            const orderId = e.dataTransfer.getData('text/plain');
            const newStatus = col.dataset.status;

            const order = allActiveOrders.find(o => o.id == orderId);
            if (order && order.status !== newStatus) {
                order.status = newStatus;
                renderKanbanBoard();

                try {
                    await API.put(`/api/sales/orders/${orderId}/status`, { status: newStatus });
                    UI.toast('Статус заказа изменен', 'success');
                } catch (err) {
                    if (typeof loadSalesData === 'function') loadSalesData(false);
                }
            }
        };

        col.removeEventListener('dragover', col._salesKanbanOver);
        col.removeEventListener('dragleave', col._salesKanbanLeave);
        col.removeEventListener('drop', col._salesKanbanDrop);
        col._salesKanbanOver = onOver;
        col._salesKanbanLeave = onLeave;
        col._salesKanbanDrop = onDrop;
        col.addEventListener('dragover', onOver);
        col.addEventListener('dragleave', onLeave);
        col.addEventListener('drop', onDrop);
    });
};

// === ФУНКЦИЯ ОТКРЫТИЯ ДЕТАЛЕЙ ЗАКАЗА ===
window.openOrderDetails = async function (orderId) {
    try {
        const data = await API.get(`/api/sales/orders/${orderId}`);
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
                        ${item.item_id ? `<span class="entity-link" onclick="window.app.openEntity('item_movement', ${item.item_id})">${Utils.escapeHtml(item.name)}</span>` : Utils.escapeHtml(item.name)}
                    </td>
                    <td class="p-8 border-bottom border-surface-alt text-center font-bold">${ordered} ${item.unit}</td>
                    <td class="p-8 border-bottom border-surface-alt text-center font-bold ${colorClass}">${shipped}</td>
                </tr>
            `;
        });
        itemsHtml += `</tbody></table>`;

        const retLines = items.filter((it) => parseFloat(it.qty_returned || 0) > 0.0001);
        let returnsSection = '';
        if (order.has_returns === true || order.has_returns === 't') {
            if (retLines.length) {
                let retRows = '';
                retLines.forEach((it) => {
                    const q = parseFloat(it.qty_returned || 0);
                    retRows += `<tr>
                        <td class="p-8 border-bottom border-surface-alt">${it.item_id ? `<span class="entity-link" onclick="window.app.openEntity('item_movement', ${it.item_id})">${Utils.escapeHtml(it.name)}</span>` : Utils.escapeHtml(it.name)}</td>
                        <td class="p-8 border-bottom border-surface-alt text-center font-bold">${q.toLocaleString('ru-RU', { maximumFractionDigits: 4 })} ${Utils.escapeHtml(it.unit || '')}</td>
                    </tr>`;
                });
                returnsSection = `
            <h4 class="m-0 mb-10 text-warning">↩️ История возвратов</h4>
            <div class="bg-surface-hover p-12 border-radius-8 border border-surface-alt mb-15">
                <table class="table-modern w-100 m-0">
                    <thead class="bg-surface-hover text-left">
                        <tr>
                            <th class="p-8 border-bottom">Товар</th>
                            <th class="p-8 border-bottom text-center">Возвращено</th>
                        </tr>
                    </thead>
                    <tbody>${retRows}</tbody>
                </table>
            </div>`;
            } else {
                returnsSection = `
            <div class="bg-surface-hover p-12 border-radius-8 border border-surface-alt mb-15 font-13 text-muted">↩️ История возвратов: по заказу отмечен возврат; количества по строкам уточняются в учёте.</div>`;
            }
        }

        // Формируем тело модального окна
        const htmlBody = `
            <div class="mb-15 bg-surface-hover p-15 border-radius-8 border font-14">
                <div class="mb-8"><strong>💼 Клиент:</strong> 
                    ${order.counterparty_id ? `<span class="entity-link" onclick="window.app.openEntity('client', ${order.counterparty_id})">${Utils.escapeHtml(order.client_name)}</span>` : Utils.escapeHtml(order.client_name)}
                </div>
                <div class="mb-8"><strong>📍 Адрес доставки:</strong> ${Utils.escapeHtml(order.delivery_address || 'Самовывоз')}</div>
                <div class="mb-8"><strong>💰 Сумма заказа:</strong> <span class="text-main font-bold">${parseFloat(order.total_amount).toLocaleString()} ₽</span></div>
                <div class="m-0"><strong>📅 Плановая отгрузка:</strong> ${order.planned_shipment_date ? new Date(order.planned_shipment_date).toLocaleDateString() : 'Не указана'}</div>
            </div>
            ${returnsSection}
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
        <div class="p-10">
            <input type="text" class="d-none" autocomplete="username">
            <input type="password" class="d-none" autocomplete="current-password">

            <div class="form-group mb-12">
                <label class="d-block mb-8 font-12 text-muted">Тип лица</label>
                <div class="flex-row gap-15 flex-wrap align-center">
                    <label class="cursor-pointer d-flex align-center font-14 m-0 font-600">
                        <input type="radio" name="m-cl-entity" value="legal" class="mr-8" checked> 🏢 Юридическое лицо
                    </label>
                    <label class="cursor-pointer d-flex align-center font-14 m-0 font-600">
                        <input type="radio" name="m-cl-entity" value="physical" class="mr-8"> 👤 Физическое лицо
                    </label>
                </div>
            </div>
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
    const entityRadio = document.querySelector('input[name="m-cl-entity"]:checked');
    let entity_type = entityRadio ? String(entityRadio.value).trim() : 'legal';
    if (entity_type !== 'legal' && entity_type !== 'physical') entity_type = 'legal';
    if (!name) return UI.toast('Введите наименование!', 'error');

    if (phone && !Utils.isValidPhone(phone)) return UI.toast('Некорректный номер телефона (минимум 10 цифр).', 'warning');
    try {
        const client = await API.post('/api/counterparties', { name, phone, type: 'Покупатель', entity_type });
        UI.toast('Клиент добавлен', 'success');
        UI.closeModal();

        let newId = client.id;
        if (!newId) {
            const list = await API.get('/api/counterparties');
            const found = list.find(c => c.name === name);
            if (found) newId = found.id;
        }
        if (newId) {
            await syncClientsDropdown(newId);
        } else {
            await syncClientsDropdown();
        }
    } catch (e) { /* тост API */ }
};

window.saveMiniContract = async function () {
    const clientId = document.getElementById('sale-client').value;
    const number = document.getElementById('m-ct-num').value.trim();
    const date = document.getElementById('m-ct-date').value;

    if (!number) return UI.toast('Введите номер договора!', 'error');

    try {
        await API.post('/api/contracts', { counterparty_id: clientId, number: number, date: date });
        UI.toast('Договор создан', 'success');
        UI.closeModal();
        onClientChange();
    } catch (e) { /* тост API */ }
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
        void window.openPrintUrl(`/print/invoice?id=${id}`);
    },
    // 2. Расходная накладная
    waybill: function (docNum) {
        if (!docNum) return UI.toast('Номер документа не указан', 'error');
        void window.openPrintUrl(`/print/waybill?docNum=${docNum}`);
    },
    // 3. УПД
    upd: function (docNum) {
        if (!docNum) return UI.toast('Номер документа не указан', 'error');
        void window.openPrintUrl(`/print/upd?docNum=${docNum}`);
    },
    // 4. Договор
    contract: function (id) {
        if (!id) return UI.toast('ID договора не указан', 'error');
        void window.openPrintUrl(`/print/contract?id=${id}`);
    },
    // 5. Спецификация (по номеру заказа)
    specification: function (docNum) {
        if (!docNum) return UI.toast('Номер заказа не указан', 'error');
        void window.openPrintUrl(`/print/specification?docNum=${docNum}`);
    },
    // 6. Спецификация (отдельный документ)
    specificationDoc: function (id) {
        if (!id) return UI.toast('ID спецификации не указан', 'error');
        void window.openPrintUrl(`/print/specification_doc?id=${id}`);
    },
    // 7. Акт сверки
    act: function (cpId, startDate, endDate) {
        if (!cpId || !startDate || !endDate) return UI.toast('Укажите контрагента и период', 'error');
        void window.openPrintUrl(`/print/act?cp_id=${cpId}&start=${startDate}&end=${endDate}`);
    },
    // 8. Бланк заказа
    blankOrder: function (docNum) {
        if (!docNum) return UI.toast('Номер заказа не указан', 'error');
        void window.openPrintUrl(`/print/blank_order?docNum=${docNum}`);
    },
    // 9. Паспорт партии (Производство)
    passport: function (batchId) {
        if (!batchId) return UI.toast('ID партии не указан', 'error');
        void window.openPrintUrl(`/print/passport?batchId=${batchId}`);
    }
};

window.toggleSaleDelivery = function() {
    const deliveryType = document.querySelector('input[name="sale_delivery_type"]:checked');
    const addressGroup = document.getElementById('sale-delivery-address-group');
    const logisticsGroup = document.getElementById('sale-logistics-cost-group');
    const pickup = Boolean(deliveryType && deliveryType.value === 'pickup');

    if (addressGroup) {
        addressGroup.classList.toggle('d-none', pickup);
    }
    if (logisticsGroup) {
        logisticsGroup.classList.toggle('d-none', pickup);
    }
    if (pickup) {
        const logEl = document.getElementById('sale-logistics-cost');
        if (logEl) logEl.value = '0';
    }
    if (typeof renderCart === 'function') renderCart();
};

// ==========================================
// === ПЕРЕХВАТ РЕЗЕРВА (Reserve Transfer) ===
// ==========================================
window.openReserveTransferModal = async function(recCoiId, recOrderId, itemId, itemName, neededQty) {
    try {
        const donors = await API.get(`/api/sales/reserve-donors?item_id=${itemId}&exclude_order_id=${recOrderId}`);

        if (donors.length === 0) {
            UI.showModal('Перехват резерва', `
                <div class="p-20 text-center">
                    <div class="sales-reserve-empty-icon" aria-hidden="true">❌</div>
                    <h3 class="m-0 mb-10">Нет доступных доноров</h3>
                    <p class="text-muted m-0">Ни один другой активный заказ не имеет зарезервированного товара <b>${itemName}</b>.</p>
                </div>
            `, `<button class="btn btn-outline" onclick="UI.closeModal(); setTimeout(() => openOrderManager(${recOrderId}), 100);">Назад к заказу</button>`);
            return;
        }

        const tbodyHtml = donors.map(d => {
            const maxTransfer = Math.min(parseFloat(d.qty_reserved), parseFloat(neededQty));
            return `
                <tr>
                    <td class="p-10 text-left">
                        <b>${d.doc_number}</b><br>
                        <span class="font-12 text-muted">${d.client_name || 'Не указан'}</span>
                    </td>
                    <td class="p-10 text-center font-bold text-primary">${d.qty_reserved}</td>
                    <td class="p-10 text-center">
                        <input type="number" id="transfer-qty-${d.coi_id}" class="input-modern" 
                               value="${maxTransfer}" max="${maxTransfer}" min="1" 
                               class="w-80 td-center border-primary">
                    </td>
                    <td class="p-10 text-right">
                        <button class="btn btn-blue sales-btn-sm" onclick="executeReserveTransfer(${d.coi_id}, ${recCoiId}, 'transfer-qty-${d.coi_id}', ${recOrderId})">Забрать</button>
                    </td>
                </tr>
            `;
        }).join('');

        const html = `
            <div class="p-10">
                <div class="bg-warning-lt border-warning p-15 border-radius-6 mb-15">
                    <p class="m-0 font-14">Вы ищете: <b>${itemName}</b></p>
                    <p class="m-0 font-12 text-muted">Требуется для этого заказа: <b class="text-danger">${neededQty}</b> ед.</p>
                </div>
                <p class="font-13 mb-10 text-main">Доступные заказы-доноры (у кого есть этот товар в резерве):</p>
                
                <table class="table-modern w-100">
                    <thead class="bg-surface-alt">
                        <tr>
                            <th class="p-10 text-left">Донор</th>
                            <th class="p-10 text-center">Его резерв</th>
                            <th class="p-10 text-center">Забираем</th>
                            <th class="p-10 text-right">Действие</th>
                        </tr>
                    </thead>
                    <tbody>${tbodyHtml}</tbody>
                </table>
            </div>
        `;

        UI.showModal('Перехват резерва', html, `<button class="btn btn-outline" onclick="UI.closeModal(); setTimeout(() => openOrderManager(${recOrderId}), 100);">Отмена и Назад</button>`);
    } catch (e) {
        console.error(e);
        UI.toast('Ошибка загрузки доноров', 'error');
    }
};

window.executeReserveTransfer = async function(donorCoiId, recipientCoiId, inputId, recOrderId) {
    const qty = document.getElementById(inputId).value;
    if (!qty || parseFloat(qty) <= 0) return UI.toast('Укажите количество!', 'warning');

    UI.showModal('⚠️ Подтверждение перехвата', 
        `<div class="p-15 text-center">
            <h3 class="text-danger mb-10">Внимательно!</h3>
            <p class="font-14 mb-0">Вы уверены, что хотите забрать <b>${qty}</b> ед. резерва у другого клиента?</p>
            <p class="font-12 text-muted mt-5 mb-0">Его заказ будет отложен и вернется в производственную очередь.</p>
        </div>`,
        `<button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
         <button class="btn btn-danger" onclick="doExecuteReserveTransfer(${donorCoiId}, ${recipientCoiId}, ${qty}, ${recOrderId})">Да, забрать резерв</button>`
    );
};

window.doExecuteReserveTransfer = async function(donorCoiId, recipientCoiId, qty, recOrderId) {
    try {
        const data = await API.post('/api/sales/transfer-reserve', { donor_coi_id: donorCoiId, recipient_coi_id: recipientCoiId, transfer_qty: qty });
        UI.closeModal();
        UI.toast(data.message, 'success');
        
        // Перезагружаем интерфейс
        if (typeof loadActiveOrders === 'function') loadActiveOrders();
        // Обновляем текущую модалку Управления Заказом (с небольшой задержкой для анимации)
        setTimeout(() => openOrderManager(recOrderId), 200);
    } catch (e) {
        console.error('[Transfer Error]', e);
    }
};


// ==========================================
// === РЕДАКТИРОВАНИЕ ЗАКАЗА ===
// ==========================================
window.editingOrderId = null;
function salesFormatDateForInputLocal(value) {
    if (!value) return '';
    const raw = String(value).trim();
    const dateMatch = raw.match(/^\d{4}-\d{2}-\d{2}/);
    if (dateMatch) return dateMatch[0];
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return raw.split('T')[0] || '';
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
}

/** Разделение paid_amount заказа: живые деньги (касса) vs зачёт аванса (проводки без account_id + «виртуальная» часть). */
function salesDeriveOrderEditPayments(order, transactions) {
    const paidAmount = parseFloat(order?.paid_amount) || 0;
    let cashPaid = 0;
    for (const tx of transactions || []) {
        if (String(tx.transaction_type) !== 'income') continue;
        const cat = String(tx.category || '').trim();
        if (cat === 'Возврат: компенсация долга') continue;
        const amt = parseFloat(tx.amount) || 0;
        if (tx.account_id != null && tx.account_id !== '') {
            cashPaid += amt;
        }
    }
    cashPaid = Math.round(cashPaid * 100) / 100;
    const offsetAmount = Math.max(0, Math.round((paidAmount - cashPaid) * 100) / 100);
    return { paidAmount, cashPaid, offsetAmount };
}

async function salesApplyOrderEditPaymentFields(order, transactions) {
    const { cashPaid, offsetAmount } = salesDeriveOrderEditPayments(order, transactions);
    const cpId = order.counterparty_id;

    try {
        const balData = await API.get(`/api/counterparties/${cpId}/balance`);
        window.CLIENT_AVAILABLE_ADVANCE = parseFloat(balData.availableAdvance) || 0;
        window.CLIENT_PREFERRED_OFFSET_ACCOUNT_ID = balData.preferredOffsetAccountId || null;
        window.CLIENT_IS_EMPLOYEE = Boolean(balData.isEmployee);
    } catch (e) {
        console.error('Ошибка загрузки аванса клиента при редактировании:', e);
    }

    const offsetGroup = document.getElementById('sale-offset-group');
    const offsetMaxEl = document.getElementById('sale-offset-max');
    if (offsetGroup) {
        if (window.CLIENT_AVAILABLE_ADVANCE > 0 || offsetAmount > 0) {
            offsetGroup.classList.remove('sales-hidden');
            if (offsetMaxEl) {
                offsetMaxEl.innerText = window.CLIENT_AVAILABLE_ADVANCE.toLocaleString('ru-RU', { minimumFractionDigits: 2 }) + ' ₽';
            }
        } else {
            offsetGroup.classList.add('sales-hidden');
        }
    }

    const advanceEl = document.getElementById('sale-advance-amount');
    const paymentMethod = String(order.payment_method || 'debt');
    if (advanceEl) {
        if (paymentMethod === 'partial' && cashPaid > 0) {
            advanceEl.value = cashPaid.toFixed(2);
        } else {
            advanceEl.value = '';
        }
    }

    const offsetCheck = document.getElementById('sale-offset-check');
    const offsetAmountEl = document.getElementById('sale-offset-amount');
    if (offsetCheck && offsetAmountEl) {
        if (offsetAmount > 0.009) {
            offsetCheck.checked = true;
            offsetAmountEl.disabled = false;
            const wrap = document.getElementById('sale-offset-input-wrap');
            if (wrap) wrap.classList.remove('sales-hidden');
            const totalStr = document.getElementById('cart-total-sum')?.innerText || '0';
            const totalSum = parseFloat(totalStr.replace(/[^\d.,]/g, '').replace(',', '.')) || 0;
            const displayOffset = Math.min(offsetAmount, totalSum);
            offsetAmountEl.value = displayOffset > 0 ? displayOffset.toFixed(2) : '';
            offsetAmountEl.max = totalSum;
        } else {
            offsetCheck.checked = false;
            if (typeof toggleOffsetInput === 'function') toggleOffsetInput();
        }
    }

    if (typeof toggleSalePayment === 'function') toggleSalePayment();
    if (typeof updateOffsetSummary === 'function') updateOffsetSummary();
    if (typeof smartAccountToggle === 'function') smartAccountToggle();
}

window.loadOrderForEdit = async function(orderId) {
    try {
        UI.toast('Загрузка заказа...', 'info');
        const resData = await API.get('/api/sales/orders/' + orderId);
        const order = resData.order; order.items = resData.items;
        
        window.editingOrderId = order.id;
        
        // Переключаемся на вкладку создания заказа
        switchSalesTab('tab-new-order', document.querySelectorAll('.sales-tab-btn')[0]);
        
        // Меняем заголовки
        const titleEl = document.getElementById('checkout-title');
        if (titleEl) titleEl.innerHTML = '✏️ Редактирование заказа ' + order.doc_number + ' <button class="btn btn-outline sales-btn-xs-cancel" onclick="clearOrderForm()">✖ Отмена</button>';
        const cardHead = titleEl ? titleEl.closest('.sales-card-head') : null;
        if (cardHead) {
            let editBanner = document.getElementById('editing-order-banner');
            if (!editBanner) {
                editBanner = document.createElement('div');
                editBanner.id = 'editing-order-banner';
                editBanner.className = 'bg-warning-lt border-warning p-10 border-radius-6 mb-10 font-13 text-warning';
                cardHead.prepend(editBanner);
            }
            editBanner.innerHTML = `⚠️ Режим редактирования заказа <b>${order.doc_number}</b>. Изменения будут сохранены в существующий документ.`;
        }
        
        document.getElementById('btn-checkout-save').innerHTML = '💾 Сохранить изменения';
        
        // Очищаем корзину
        cart = [];
        window.isSalesOrderEditInitialLoad = true;
        
        // СНАЧАЛА устанавливаем клиента, пока корзина пуста, чтобы не сработал clearOrderForm при смене клиента
        const clientSel = document.getElementById('sale-client');
        if (clientSel && clientSel.tomselect) {
            clientSel.tomselect.setValue(order.counterparty_id);
        }
        window.isSalesOrderEditInitialLoad = false;
        
        // Заполняем корзину товарами
        if (order.items && Array.isArray(order.items)) {
            for (const i of order.items) {
                let unitCost = 0, baseMatCost = 0, amortization = 0, overhead = 0, wage = 0;
                try {
                    const data = await API.get(`/api/sales/cost-analysis/${i.item_id}`);
                    baseMatCost = parseFloat(data.empirical) > 0 ? parseFloat(data.empirical) : parseFloat(data.theoretical);
                    wage = parseFloat(i.piece_rate || 0); // Note: piece_rate is not in i by default, so it might be 0 unless we fetch it. It's okay.
                    amortization = parseFloat(data.amortization) || 0;
                    overhead = parseFloat(data.overhead) || 0;
                    unitCost = baseMatCost + amortization + overhead;
                } catch (e) {
                     console.error("Ошибка получения себестоимости", e);
                }

                cart.push({
                    id: i.item_id,
                    warehouseId: (window.WAREHOUSE_IDS && window.WAREHOUSE_IDS['finished']) || 4, // Склад ГП (динамически из WAREHOUSE_IDS)
                    sortLabel: 'По заказу',
                    name: i.name,
                    unit: i.unit,
                    qty: parseFloat(i.qty_ordered),
                    price: parseFloat(i.price),
                    discount: 0, 
                    weight: 0,
                    allowProduction: true,
                    stockAvailable: 9999,
                    unitCost: unitCost,
                    baseMatCost: baseMatCost,
                    amortization: amortization,
                    overhead: overhead,
                    wage: wage
                });
            }
        }
        
        // Заполняем остальные поля формы (клиент уже установлен выше)
        document.getElementById('sale-discount').value = parseFloat(order.discount) || 0;

        const addrNorm = String(order.delivery_address || '').trim();
        const isPickup = /^самовывоз$/i.test(addrNorm);
        const pickupRd = document.querySelector('input[name="sale_delivery_type"][value="pickup"]');
        const deliveryRd = document.querySelector('input[name="sale_delivery_type"][value="delivery"]');
        if (pickupRd && deliveryRd) {
            if (isPickup) pickupRd.checked = true;
            else deliveryRd.checked = true;
        }
        document.getElementById('sale-delivery-address').value = isPickup ? '' : (order.delivery_address || '');
        if (typeof toggleSaleDelivery === 'function') toggleSaleDelivery();
        const logCost = parseFloat(order.logistics_cost) || 0;
        if (!isPickup) {
            document.getElementById('sale-logistics-cost').value = String(logCost);
        } else {
            document.getElementById('sale-logistics-cost').value = '0';
        }
        const btnVal = document.getElementById('sale-poa-comment');
        if (btnVal) btnVal.value = order.contract_info || ''; // Используется для комментариев
        const paymentMethodEl = document.getElementById('sale-payment-method');
        if (paymentMethodEl) {
            paymentMethodEl.value = String(order.payment_method || 'debt');
            if (typeof toggleSalePayment === 'function') toggleSalePayment();
        }
        const accountEl = document.getElementById('sale-account');
        if (accountEl && order.account_id) {
            salesSetSelectValueSafe(accountEl, String(order.account_id));
        }

        if (order.planned_shipment_date) {
            document.getElementById('sale-planned-date').value = order.planned_shipment_date.split('T')[0];
        }
        
        // ДАТА ДОКУМЕНТА! 
        const dateInput = document.getElementById('sale-order-date');
        if (dateInput && order.created_at) {
            dateInput.value = salesFormatDateForInputLocal(order.created_at);
        }

        renderCart();
        await salesApplyOrderEditPaymentFields(order, resData.payment_transactions || []);
        UI.toast('Режим редактирования активирован', 'success');
        
    } catch (e) {
        console.error(e);
        UI.toast('Не удалось загрузить заказ для редактирования', 'error');
    }
};

window.forceCloseOrder = function(orderId, docNum) {
    const html = `
        <p>Вы уверены, что хотите принудительно закрыть заказ <b>${docNum}</b>?</p>
        <p class="font-12 text-warning">⚠️ Товар, который еще не отгружен, будет снят с резерва и вернется в свободный остаток на складах.</p>
        <p class="font-12 text-warning">⚠️ Зафиксируется текущая редакция заказа (кол-во и сумма как в карточке заказа на момент закрытия).</p>
    `;
    UI.showModal('Принудительное закрытие', html, `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-red" onclick="executeForceClose(${orderId})">Да, завершить заказ</button>
    `);
};

window.executeForceClose = async function(orderId) {
    try {
        await API.put('/api/sales/orders/' + orderId + '/force-close', {});
        UI.closeModal();
        UI.toast('Заказ завершен!', 'success');
        loadActiveOrders();
        if (typeof refreshShipmentDashboardIfActive === 'function') refreshShipmentDashboardIfActive();
    } catch(e) {
        console.error(e);
        UI.toast(e?.message || 'Не удалось принудительно закрыть заказ', 'error');
    }
};

window.applyAdvanceToOrder = function(id) {
    const html = `
        <p>Вы уверены, что хотите использовать <b>Свободный аванс</b> клиента для погашения долга по этому заказу?</p>
        <p class="font-13 text-muted">Сумма долга автоматически уменьшится на размер доступного аванса.</p>
        <div class="form-group m-0">
            <label>Причина зачета (обязательно)</label>
            <textarea id="sales-apply-advance-reason" class="input-modern" rows="3" placeholder="Например: согласованный зачет переплаты по клиенту"></textarea>
        </div>
    `;
    UI.showModal('Зачет аванса', html, `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-green" onclick="executeApplyAdvance(${id})">💰 Да, зачесть</button>
    `);
};

window.executeApplyAdvance = async function(id) {
    const reason = (document.getElementById('sales-apply-advance-reason')?.value || '').trim();
    if (!reason) return UI.toast('Укажите причину зачета аванса', 'warning');
    try {
        await API.post(`/api/sales/orders/${id}/apply-advance`, { reason });
        UI.toast('Свободный аванс зачтен', 'success');
        UI.closeModal();
        if (typeof loadActiveOrders === 'function') loadActiveOrders();
    } catch (e) { /* тост API */ }
};
