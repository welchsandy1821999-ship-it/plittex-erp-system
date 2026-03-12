// === public/js/finance.js ===
let currentAccounts = [];
let financeCounterparties = [];
let allTransactions = [];
let currentAccountFilter = null;
let financeDateRange = { start: '', end: '' };
let financeInvoices = [];
let currentFinancePage = 1;
let financeTotalPages = 1;
let selectedTransIds = new Set();
let currentFinanceLimit = 20;
let financeSearchTimer = null;
let chartFlow = null;
let chartCategories = null;

async function initFinance() {
    // Инициализация красивого календаря Flatpickr
    flatpickr("#finance-date-filter", {
        mode: "range",
        dateFormat: "Y-m-d",
        altInput: true,
        altFormat: "d.m.Y",
        locale: "ru",
        onChange: function (selectedDates, dateStr, instance) {
            if (selectedDates.length > 0) {
                financeDateRange.start = instance.formatDate(selectedDates[0], "Y-m-d");
                financeDateRange.end = instance.formatDate(selectedDates[selectedDates.length - 1], "Y-m-d");
                loadFinanceData();
            }
        }
    });

    loadFinanceData();
}

window.resetFinanceFilter = function () {
    document.getElementById('finance-date-filter')._flatpickr.clear();
    financeDateRange = { start: '', end: '' };
    currentFinancePage = 1; // Сбрасываем на первую страницу
    loadFinanceData();
};

async function loadFinanceData() {
    try {
        // Читаем, что ввел пользователь в поиск (если поле существует)
        const searchInput = document.getElementById('finance-search');
        const searchQuery = searchInput ? searchInput.value.trim() : '';

        let queryParams = new URLSearchParams();
        if (financeDateRange.start && financeDateRange.end) {
            queryParams.append('start', financeDateRange.start);
            queryParams.append('end', financeDateRange.end);
        }
        if (currentAccountFilter) queryParams.append('account_id', currentAccountFilter);
        if (searchQuery) queryParams.append('search', searchQuery); // Передаем поиск

        queryParams.append('page', currentFinancePage);
        queryParams.append('limit', currentFinanceLimit); // Передаем лимит

        const queryStr = `?${queryParams.toString()}`;

        const [reportRes, transRes, accRes, catRes, cpRes, invRes] = await Promise.all([
            // В аналитику поиск не передаем, она всегда считается за весь период
            fetch(`/api/report/finance${financeDateRange.start ? `?start=${financeDateRange.start}&end=${financeDateRange.end}` : ''}`),
            fetch(`/api/transactions${queryStr}`), // <--- Отправляем мощный запрос
            fetch('/api/accounts'),
            fetch('/api/finance/categories'),
            fetch('/api/counterparties'),
            fetch('/api/invoices')
        ]);

        const reportData = await reportRes.json();
        const transData = await transRes.json();

        allTransactions = transData.data;
        financeTotalPages = transData.totalPages;
        currentFinancePage = transData.currentPage;

        currentAccounts = await accRes.json();
        window.financeCategories = await catRes.json();
        financeCounterparties = await cpRes.json();
        financeInvoices = await invRes.json();

        // Обновляем текст пагинации
        document.getElementById('finance-page-info').innerText = `Страница ${currentFinancePage} из ${financeTotalPages} (Всего: ${transData.total})`;

        // Сбрасываем галочку "Выбрать всё" при смене страницы
        document.getElementById('selectAllCheckbox').checked = false;

        renderFinanceSummary(reportData);
        renderAccounts(currentAccounts);
        renderTransactionsTable();
        renderInvoicesTable();
        updateBulkActionsVisibility();
        renderFinanceCharts(allTransactions);
    } catch (e) { console.error("Ошибка загрузки финансов:", e); }
}

function renderFinanceSummary(data) {
    let totalIncome = 0; let totalExpense = 0;
    data.forEach(r => { totalIncome += parseFloat(r.income) || 0; totalExpense += parseFloat(r.expense) || 0; });
    const profit = totalIncome - totalExpense;

    document.getElementById('finance-summary-boxes').innerHTML = `
        <div style="background: #fff; padding: 15px; border-radius: 8px; border: 1px solid var(--border); border-left: 4px solid var(--success);">
            <div style="font-size: 12px; color: var(--text-muted); font-weight: bold;">ОБЩИЙ ДОХОД</div>
            <div style="font-size: 24px; font-weight: bold; color: var(--success); margin-top: 5px;">+${totalIncome.toLocaleString('ru-RU')} ₽</div>
        </div>
        <div style="background: #fff; padding: 15px; border-radius: 8px; border: 1px solid var(--border); border-left: 4px solid var(--danger);">
            <div style="font-size: 12px; color: var(--text-muted); font-weight: bold;">ОБЩИЙ РАСХОД</div>
            <div style="font-size: 24px; font-weight: bold; color: var(--danger); margin-top: 5px;">-${totalExpense.toLocaleString('ru-RU')} ₽</div>
        </div>
        <div style="background: ${profit >= 0 ? '#f0fdf4' : '#fef2f2'}; padding: 15px; border-radius: 8px; border: 1px solid ${profit >= 0 ? '#bbf7d0' : '#fecaca'}; border-left: 4px solid ${profit >= 0 ? '#10b981' : '#ef4444'};">
            <div style="font-size: 12px; font-weight: bold; color: ${profit >= 0 ? '#15803d' : '#b91c1c'};">ОБЩАЯ ПРИБЫЛЬ</div>
            <div style="font-size: 24px; font-weight: bold; color: ${profit >= 0 ? '#166534' : '#991b1b'}; margin-top: 5px;">${profit > 0 ? '+' : ''}${profit.toLocaleString('ru-RU')} ₽</div>
        </div>
    `;
}

function renderAccounts(accounts) {
    document.getElementById('accounts-container').innerHTML = accounts.map(acc => {
        const isSelected = currentAccountFilter === acc.id;
        const borderStyle = isSelected ? 'border: 2px solid var(--primary); transform: scale(1.02); box-shadow: 0 4px 12px rgba(0,0,0,0.1); opacity: 1;' : 'border: 1px solid var(--border); opacity: 0.8;';
        const bgStyle = isSelected ? '#eff6ff' : '#fff';

        return `
        <div class="account-card" onclick="toggleAccountFilter(${acc.id})" style="background: ${bgStyle}; padding: 15px; border-radius: 12px; border-top: 5px solid ${acc.type === 'cash' ? '#10b981' : '#3b82f6'}; ${borderStyle} cursor: pointer; transition: 0.2s;">
            <div style="font-size: 11px; color: var(--text-muted); font-weight: bold; text-transform: uppercase;">${acc.type === 'cash' ? '💵 Наличные' : '🏦 Банковский счет'}</div>
            <div style="font-size: 16px; font-weight: bold; margin: 5px 0;">${acc.name}</div>
            <div style="font-size: 20px; font-weight: 800; color: var(--text-main);">${parseFloat(acc.balance).toLocaleString()} ₽</div>
        </div>`;
    }).join('');
}

window.toggleAccountFilter = function (accountId) {
    currentAccountFilter = currentAccountFilter === accountId ? null : accountId;
    currentFinancePage = 1; // Возвращаемся на первую страницу при смене банка
    loadFinanceData();
};

function renderTransactionsTable() {
    const tbody = document.getElementById('transactions-table-body');

    if (allTransactions.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; color: var(--text-muted); padding: 30px;">Операций пока нет.</td></tr>';
        return;
    }

    tbody.innerHTML = allTransactions.map(t => {
        const isIncome = t.transaction_type === 'income';
        const isChecked = selectedTransIds.has(t.id) ? 'checked' : '';
        
        // УМНОЕ ФОРМАТИРОВАНИЕ ДАТЫ ДЛЯ ТАБЛИЦЫ
        let safeDate = t.date_formatted;
        if (!safeDate && t.transaction_date) {
            const d = new Date(t.transaction_date);
            if (!isNaN(d)) safeDate = d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
        }

        let receiptHtml = t.receipt_url
            ? `<a href="${t.receipt_url}" target="_blank" style="text-decoration:none; font-size:16px;" title="Смотреть документ">📄</a>
               <button class="btn btn-outline" style="border:none; padding:2px; font-size:12px; color:red;" onclick="deleteReceipt(${t.id})" title="Удалить файл">✖</button>`
            : `<label style="cursor:pointer; font-size:16px;" title="Прикрепить файл">📎
                   <input type="file" style="display:none;" onchange="uploadReceipt(${t.id}, this)">
               </label>`;

        return `
        <tr onmouseover="this.style.backgroundColor='#f1f5f9'" onmouseout="this.style.backgroundColor=''">
            <td style="text-align: center;"><input type="checkbox" class="trans-checkbox" value="${t.id}" onchange="toggleRowSelect(this)" ${isChecked}></td>
            <td style="font-weight: bold; color: var(--text-muted); font-size: 13px;">${safeDate || '-'}</td>
            <td><span class="badge" style="background: ${isIncome ? '#dcfce3' : '#fee2e2'}; color: ${isIncome ? 'var(--success)' : 'var(--danger)'};">${isIncome ? 'Поступление' : 'Списание'}</span></td>
            <td style="font-weight: 600;">
                ${t.counterparty_name ? `<div style="color: var(--primary); font-size: 14px;">👤 ${t.counterparty_name}</div>` : ''}
                <div style="font-size: 12px; color: var(--text-muted);">${t.category}</div>
            </td>
            <td style="color: var(--text-muted); font-size: 13px;">${t.description || '-'}<span style="font-size: 11px; color: var(--primary); font-weight: bold; display: block; margin-top: 3px;">${t.account_name}</span></td>
            <td style="font-size: 13px;">${t.payment_method}</td>
            <td style="text-align: right; font-weight: bold; font-size: 15px; color: ${isIncome ? 'var(--success)' : 'var(--text-main)'};">${isIncome ? '+' : '-'}${parseFloat(t.amount).toLocaleString('ru-RU')} ₽</td>
            <td style="text-align: center; display: flex; gap: 5px; justify-content: center; align-items: center;">
                ${receiptHtml}
                <button class="btn btn-outline" style="padding: 4px 8px; font-size: 12px; border-color: var(--primary); color: var(--primary);" onclick="openEditTransactionModal(${t.id})" title="Редактировать">✏️</button>
                <button class="btn btn-outline" style="padding: 4px 8px; font-size: 12px; border-color: var(--danger); color: var(--danger);" onclick="deleteTransaction(${t.id})" title="Удалить">❌</button>
            </td>
        </tr>`;
    }).join('');
}

// 1. Удаление транзакции
window.deleteTransaction = function (id) {
    const html = `<div style="padding: 15px; text-align: center; font-size: 15px;">Вы уверены, что хотите удалить эту операцию?<br><small style="color: gray;">Баланс счета будет автоматически пересчитан.</small></div>`;
    UI.showModal('⚠️ Удаление операции', html, `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-blue" style="background: #ef4444; border-color: #ef4444;" onclick="executeDeleteTransaction(${id})">🗑️ Да, удалить</button>
    `);
};
window.executeDeleteTransaction = async function (id) {
    UI.closeModal();
    const res = await fetch(`/api/transactions/${id}`, { method: 'DELETE' });
    if (res.ok) { UI.toast('🗑️ Операция удалена', 'success'); loadFinanceData(); }
};

window.openCategoriesModal = function () {
    let listHtml = window.financeCategories.map(c => `
        <div style="display: flex; justify-content: space-between; padding: 8px; border-bottom: 1px solid var(--border);">
            <span>${c.type === 'income' ? '🟢' : '🔴'} ${c.name}</span>
            <button onclick="deleteCategory(${c.id})" style="color: red; border: none; background: none; cursor:pointer;">❌</button>
        </div>
    `).join('');

    const html = `
        <div style="margin-bottom: 15px; max-height: 250px; overflow-y: auto; border: 1px solid var(--border); border-radius: 6px; padding: 5px;">${listHtml || '<div style="padding:10px; text-align:center;">Нет категорий</div>'}</div>
        <div style="display: flex; gap: 10px;">
            <select id="new-cat-type" class="input-modern" style="width: 40%;"><option value="expense">Расход</option><option value="income">Доход</option></select>
            <input type="text" id="new-cat-name" class="input-modern" style="width: 60%;" placeholder="Название (напр. ГСМ)">
        </div>`;
    UI.showModal('⚙️ Настройка статей ДДС', html, `<button class="btn btn-outline" onclick="UI.closeModal()">Закрыть</button><button class="btn btn-blue" onclick="addCategory()">➕ Добавить</button>`);
};

window.addCategory = async function () {
    const type = document.getElementById('new-cat-type').value;
    const name = document.getElementById('new-cat-name').value.trim();
    if (!name) return;
    await fetch('/api/finance/categories', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, type }) });
    await loadFinanceData(); openCategoriesModal();
};

// 4. Удаление категории (статьи ДДС)
window.deleteCategory = function (id) {
    const html = `<div style="padding: 15px; text-align: center; font-size: 15px;">Удалить эту статью расходов/доходов?</div>`;
    UI.showModal('⚠️ Удаление категории', html, `
        <button class="btn btn-outline" onclick="openCategoriesModal()">Отмена</button>
        <button class="btn btn-blue" style="background: #ef4444; border-color: #ef4444;" onclick="executeDeleteCategory(${id})">🗑️ Удалить</button>
    `);
};
window.executeDeleteCategory = async function (id) {
    UI.closeModal();
    await fetch(`/api/finance/categories/${id}`, { method: 'DELETE' });
    await loadFinanceData();
    openCategoriesModal();
};

// === ОКНО ДОБАВЛЕНИЯ ОПЕРАЦИИ (ТЕПЕРЬ С УМНЫМИ КАТЕГОРИЯМИ) ===
window.openTransactionModal = function () {
    const accountOptions = currentAccounts.map(acc => `<option value="${acc.id}" ${currentAccountFilter === acc.id ? 'selected' : ''}>${acc.name} (${parseFloat(acc.balance).toLocaleString()} ₽)</option>`).join('');

    const html = `
        <div class="form-grid" style="grid-template-columns: 1fr 1fr;">
            <div class="form-group" style="grid-column: span 2;">
                <label>Тип операции:</label>
                <select id="trans-type" class="input-modern" style="font-size: 15px; font-weight: bold;" onchange="updateCategoryList()">
                    <option value="expense">🔴 Расход (Списание денег)</option>
                    <option value="income">🟢 Доход (Поступление денег)</option>
                </select>
            </div>
            
            <div class="form-group" style="background: #f8fafc; padding: 10px; border-radius: 6px; border: 1px dashed var(--border);">
                <label style="font-weight: bold;">Сумма (₽):</label>
                <input type="number" id="trans-amount" class="input-modern" style="font-size: 18px; font-weight: bold;" placeholder="0">
            </div>
            
            <div class="form-group" style="background: #eff6ff; padding: 10px; border-radius: 6px; border: 1px dashed #bfdbfe;">
                <label style="font-weight: bold; color: var(--primary);">Счет (Откуда/Куда):</label>
                <select id="trans-account-id" class="input-modern" style="font-size: 14px; font-weight: bold;">${accountOptions}</select>
            </div>
            
            <div class="form-group" style="grid-column: span 2;">
                <label>Контрагент (Кому/От кого):</label>
                <select id="trans-counterparty-id" class="input-modern" style="font-size: 14px;">
                    <option value="">-- Не выбран (Внутренняя операция) --</option>
                    ${financeCounterparties.map(cp => `<option value="${cp.id}">${cp.name}</option>`).join('')}
                </select>
            </div>

            <div class="form-group" style="grid-column: span 2;">
                <label>Способ оплаты:</label>
                <select id="trans-method" class="input-modern" style="font-size: 14px;">
                    <option value="Безналичный расчет">Безналичный расчет (Счет)</option>
                    <option value="Наличные (Касса)">Наличные</option>
                    <option value="Перевод на карту">Перевод на карту директору</option>
                </select>
            </div>
            
            <div class="form-group" style="grid-column: span 2;">
                <label style="color: var(--primary);">Категория (Выберите из списка или впишите новую):</label>
                <input type="text" id="trans-category" list="category-options" class="input-modern" style="font-weight: 600;" placeholder="Начните вводить или выберите..." autocomplete="off">
                <datalist id="category-options"></datalist>
            </div>
            
            <div class="form-group" style="grid-column: span 2;">
                <label>Основание (Комментарий):</label>
                <input type="text" id="trans-desc" class="input-modern" placeholder="Например: Аренда за март 2026...">
            </div>
        </div>
    `;
    UI.showModal('➕ Добавление операции', html, `<button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button><button class="btn btn-blue" onclick="saveTransaction()">💾 Сохранить</button>`);
    updateCategoryList();
};

window.updateCategoryList = function () {
    const type = document.getElementById('trans-type').value;
    const datalist = document.getElementById('category-options');

    // Оставляем в списке только категории нужного типа (доход/расход)
    const filteredCats = window.financeCategories.filter(c => c.type === type);
    datalist.innerHTML = filteredCats.map(c => `<option value="${c.name}">`).join('');

    // При переключении схода на расход очищаем поле
    const catInput = document.getElementById('trans-category');
    if (catInput) catInput.value = '';
};

window.saveTransaction = async function () {
    const type = document.getElementById('trans-type').value;
    const amount = parseFloat(document.getElementById('trans-amount').value);
    const method = document.getElementById('trans-method').value;
    const category = document.getElementById('trans-category').value.trim();
    const desc = document.getElementById('trans-desc').value.trim();
    const account_id = document.getElementById('trans-account-id').value;
    const counterparty_id = document.getElementById('trans-counterparty-id').value;

    if (!amount || amount <= 0) return UI.toast('Введите сумму!', 'error');
    if (!desc) return UI.toast('Обязательно укажите основание/комментарий!', 'error');
    if (!category) return UI.toast('Укажите категорию!', 'error');

    // === АВТО-СОЗДАНИЕ КАТЕГОРИИ ===
    // Если ты вписал новое слово, программа сама сохранит его в справочник "Статьи ДДС"
    const isCategoryExists = window.financeCategories.some(c => c.name.toLowerCase() === category.toLowerCase() && c.type === type);
    if (!isCategoryExists) {
        try {
            await fetch('/api/finance/categories', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: category, type: type })
            });
        } catch (e) { console.error("Ошибка сохранения категории", e); }
    }
    // ===================================

    try {
        const res = await fetch('/api/transactions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount, type, category, description: desc, method, account_id, counterparty_id })
        });

        if (res.ok) {
            UI.closeModal();
            UI.toast('✅ Операция успешно сохранена', 'success');
            loadFinanceData(); // Это обновит таблицу и сразу подтянет новые категории в базу
        } else {
            UI.toast('Ошибка при сохранении', 'error');
        }
    } catch (e) {
        console.error(e);
        UI.toast('Ошибка сети', 'error');
    }
};

window.openTransferModal = function () {
    if (currentAccounts.length < 2) return UI.toast('Нужно минимум 2 счета!', 'warning');
    const options = currentAccounts.map(acc => `<option value="${acc.id}">${acc.name} (${parseFloat(acc.balance).toLocaleString()} ₽)</option>`).join('');

    const html = `
        <div class="form-group"><label>Списать с:</label><select id="transfer-from" class="input-modern">${options}</select></div>
        <div class="form-group"><label>Зачислить на:</label><select id="transfer-to" class="input-modern">${options}</select></div>
        <div class="form-group"><label>Сумма:</label><input type="number" id="transfer-amount" class="input-modern"></div>
        <div class="form-group"><label>Комментарий:</label><input type="text" id="transfer-desc" class="input-modern"></div>
    `;
    UI.showModal('🔄 Перевод', html, `<button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button><button class="btn btn-blue" onclick="executeTransfer()">💸 Выполнить</button>`);
};

window.executeTransfer = async function () {
    const from_id = document.getElementById('transfer-from').value;
    const to_id = document.getElementById('transfer-to').value;
    const amount = parseFloat(document.getElementById('transfer-amount').value);
    const description = document.getElementById('transfer-desc').value.trim();

    if (from_id === to_id) return UI.toast('Выберите разные счета!', 'error');
    const res = await fetch('/api/transactions/transfer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from_id, to_id, amount, description }) });
    if (res.ok) { UI.closeModal(); UI.toast('✅ Переведено', 'success'); loadFinanceData(); }
};

/// === ОТКРЫТИЕ ОКНА РЕДАКТИРОВАНИЯ ===
window.openEditTransactionModal = function (id) {
    // Находим нужный платеж в загруженном массиве
    const tr = allTransactions.find(t => t.id === id);
    if (!tr) return;

    // Генерируем выпадающие списки (Счета и Контрагенты), отмечая текущие как selected
    const accountOptions = currentAccounts.map(acc => `<option value="${acc.id}" ${tr.account_id === acc.id ? 'selected' : ''}>${acc.name}</option>`).join('');
    const cpOptions = financeCounterparties.map(cp => `<option value="${cp.id}" ${tr.counterparty_id === cp.id ? 'selected' : ''}>${cp.name}</option>`).join('');

    // Фильтруем категории (доходы к доходам, расходы к расходам) для умной подсказки
    const filteredCats = window.financeCategories.filter(c => c.type === tr.transaction_type);
    const catOptions = filteredCats.map(c => `<option value="${c.name}">`).join('');

    const html = `
        <div class="form-grid" style="grid-template-columns: 1fr 1fr; gap: 15px;">
            
            <input type="password" style="display:none;" autocomplete="new-password">

            <div class="form-group" style="grid-column: span 2;">
                <label>Основание (Комментарий):</label>
                <input type="text" id="edit-trans-desc" class="input-modern" value="${tr.description || ''}" autocomplete="off">
            </div>
            
            <div class="form-group">
                <label>Сумма (₽):</label>
                <input type="number" id="edit-trans-amount" class="input-modern" value="${tr.amount}" style="font-weight: bold;">
            </div>

            <div class="form-group" style="grid-column: span 2;">
                <label style="color: var(--primary);">Категория (Выберите из списка или впишите новую):</label>
                <input type="text" id="edit-trans-category" list="edit-category-options" class="input-modern" 
                       value="${tr.category || ''}" style="font-weight: 600;" 
                       autocomplete="new-password" 
                       onclick="this.value=''">
                <datalist id="edit-category-options">${catOptions}</datalist>
            </div>

            <div class="form-group">
                <label>Счет (Банк/Касса):</label>
                <select id="edit-trans-account" class="input-modern">${accountOptions}</select>
            </div>

            <div class="form-group">
                <label>Контрагент:</label>
                <select id="edit-trans-cp" class="input-modern">
                    <option value="">-- Внутренняя операция --</option>
                    ${cpOptions}
                </select>
            </div>
        </div>
    `;

    UI.showModal('✏️ Редактирование платежа', html, `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-blue" onclick="saveEditedTransaction(${id})">💾 Сохранить изменения</button>
    `);
};

// === СОХРАНЕНИЕ ИЗМЕНЕНИЙ И АВТО-СОЗДАНИЕ КАТЕГОРИИ ===
window.saveEditedTransaction = async function (id) {
    const tr = allTransactions.find(t => t.id === id);
    const description = document.getElementById('edit-trans-desc').value.trim();
    const amount = parseFloat(document.getElementById('edit-trans-amount').value);
    const category = document.getElementById('edit-trans-category').value.trim();
    const account_id = document.getElementById('edit-trans-account').value;
    const counterparty_id = document.getElementById('edit-trans-cp').value;

    if (!amount || !description || !category) return UI.toast('Заполните сумму, основание и категорию!', 'warning');

    // 1. УМНАЯ ПРОВЕРКА КАТЕГОРИИ:
    // Ищем, есть ли уже такая категория в базе (игнорируя регистр букв)
    const isCategoryExists = window.financeCategories.some(c => c.name.toLowerCase() === category.toLowerCase() && c.type === tr.transaction_type);

    // Если категории нет, мы незаметно отправляем запрос на её создание
    if (!isCategoryExists) {
        try {
            await fetch('/api/finance/categories', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: category, type: tr.transaction_type })
            });
            console.log(`Создана новая категория: ${category}`);
        } catch (e) { console.error("Ошибка авто-создания категории:", e); }
    }

    // 2. ОБНОВЛЕНИЕ САМОГО ПЛАТЕЖА:
    try {
        const res = await fetch(`/api/transactions/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ description, amount, category, account_id, counterparty_id })
        });

        if (res.ok) {
            UI.closeModal();
            UI.toast('✅ Платеж и баланс успешно обновлены', 'success');
            loadFinanceData(); // Полная перезагрузка обновит таблицу, балансы и справочник категорий
        } else {
            UI.toast('Ошибка сохранения на сервере', 'error');
        }
    } catch (e) {
        console.error(e);
        UI.toast('Ошибка сети', 'error');
    }
};

// ==========================================
// МОЩНАЯ CRM: ПОИСК, СОРТИРОВКА И УПРАВЛЕНИЕ
// ==========================================

let cpSearchQuery = "";
let cpTypeFilter = "all";
let cpSortBy = "last_date_desc"; // По умолчанию теперь свежие операции

window.openCounterpartiesModal = function () {
    const html = `
        <style>.modal-content { max-width: 1000px !important; width: 95% !important; }</style>
        <div style="display: flex; flex-direction: column; gap: 15px;">
            <div style="background: #f1f5f9; padding: 15px; border-radius: 12px; display: flex; flex-wrap: wrap; gap: 10px; align-items: center;">
                <div style="flex: 1; min-width: 200px;">
                    <input type="text" id="cp-search" class="input-modern" placeholder="🔍 Поиск по имени или ИНН..." 
                           oninput="updateCPList()" style="margin:0; background: #fff;">
                </div>
                <select id="cp-filter-type" class="input-modern" onchange="updateCPList()" style="width: auto; margin:0; background: #fff;">
                    <option value="all">Все типы</option>
                    <option value="Покупатель">Покупатели</option>
                    <option value="Поставщик">Поставщики</option>
                </select>
                <select id="cp-sort" class="input-modern" onchange="updateCPList()" style="width: auto; margin:0; background: #fff;">
                    <option value="last_date_desc">🕒 Свежие операции</option>
                    <option value="last_date_asc">⏳ Старые операции</option>
                    <option value="turnover">💰 Наибольший оборот</option>
                    <option value="income">📈 По доходу (Нам)</option>
                    <option value="expense">📉 По расходу (От нас)</option>
                    <option value="name">🔤 По алфавиту (А-Я)</option>
                </select>
                <button class="btn btn-blue" onclick="openCounterpartyEditor()">➕ Создать</button>
            </div>

            <div id="cp-list-container" style="max-height: 550px; overflow-y: auto; padding-right: 5px; display: flex; flex-direction: column; gap: 8px;">
            </div>
        </div>
    `;

    UI.showModal('👥 Информационная база контрагентов', html, `<button class="btn btn-outline" onclick="UI.closeModal()">Закрыть</button>`);

    cpSearchQuery = "";
    cpTypeFilter = "all";
    cpSortBy = "last_date_desc";
    renderCPList();
};

window.updateCPList = function () {
    cpSearchQuery = document.getElementById('cp-search').value.toLowerCase();
    cpTypeFilter = document.getElementById('cp-filter-type').value;
    cpSortBy = document.getElementById('cp-sort').value;
    renderCPList();
};

function renderCPList() {
    const container = document.getElementById('cp-list-container');

    let filtered = financeCounterparties.filter(c => {
        const matchesSearch = c.name.toLowerCase().includes(cpSearchQuery) || (c.inn && c.inn.includes(cpSearchQuery));
        const matchesType = cpTypeFilter === 'all' || c.type === cpTypeFilter;
        return matchesSearch && matchesType;
    });

    // Мощная логика сортировки
    filtered.sort((a, b) => {
        if (cpSortBy === 'last_date_desc') {
            const dateA = a.last_transaction_date ? new Date(a.last_transaction_date).getTime() : 0;
            const dateB = b.last_transaction_date ? new Date(b.last_transaction_date).getTime() : 0;
            return dateB - dateA;
        }
        if (cpSortBy === 'last_date_asc') {
            const dateA = a.last_transaction_date ? new Date(a.last_transaction_date).getTime() : Infinity;
            const dateB = b.last_transaction_date ? new Date(b.last_transaction_date).getTime() : Infinity;
            return dateA - dateB;
        }
        if (cpSortBy === 'turnover') {
            const turnA = parseFloat(a.total_paid_to_us) + parseFloat(a.total_paid_by_us);
            const turnB = parseFloat(b.total_paid_to_us) + parseFloat(b.total_paid_by_us);
            return turnB - turnA;
        }
        if (cpSortBy === 'name') return a.name.localeCompare(b.name);
        if (cpSortBy === 'income') return parseFloat(b.total_paid_to_us) - parseFloat(a.total_paid_to_us);
        if (cpSortBy === 'expense') return parseFloat(b.total_paid_by_us) - parseFloat(a.total_paid_by_us);
        return 0;
    });

    if (filtered.length === 0) {
        container.innerHTML = '<div style="text-align:center; padding: 40px; color: gray;">Ничего не найдено</div>';
        return;
    }

    // Отрисовка в одну колонку (Горизонтальные плашки)
    container.innerHTML = filtered.map(c => {
        const lastDate = c.last_transaction_date
            ? new Date(c.last_transaction_date).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })
            : 'Нет операций';

        return `
        <div class="cp-card" style="background: #fff; padding: 12px 15px; border-radius: 8px; border: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; transition: 0.2s;" 
             onmouseover="this.style.borderColor='var(--primary)'; this.style.boxShadow='0 4px 8px rgba(0,0,0,0.05)'" 
             onmouseout="this.style.borderColor='var(--border)'; this.style.boxShadow='none'">
            
            <div style="flex: 2; min-width: 0; padding-right: 15px;">
                <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
                    <span class="badge" style="font-size: 10px; background: ${c.type === 'Покупатель' ? '#dcfce3' : '#e0e7ff'}; color: ${c.type === 'Покупатель' ? '#166534' : '#3730a3'};">
                        ${c.type || 'Не задан'}
                    </span>
                    <div style="font-weight: bold; font-size: 15px; color: var(--text-main); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                        ${c.name}
                    </div>
                </div>
                <div style="font-size: 12px; color: var(--text-muted); display: flex; gap: 15px;">
                    <span>${c.inn ? `<b>ИНН:</b> ${c.inn}` : '<i>Без ИНН</i>'}</span>
                    <span>${c.phone ? `📞 ${c.phone}` : ''}</span>
                </div>
            </div>

            <div style="flex: 1.2; text-align: center; border-left: 1px solid #f1f5f9; border-right: 1px solid #f1f5f9; padding: 0 10px;">
                <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 2px;">Последняя операция:</div>
                <div style="font-size: 13px; font-weight: bold; color: ${c.last_transaction_date ? 'var(--text-main)' : 'var(--text-muted)'};">${lastDate}</div>
            </div>

            <div style="flex: 1.2; padding-left: 15px; text-align: right;">
                <div style="color: var(--success); font-size: 12px; font-weight: bold;">📈 +${parseFloat(c.total_paid_to_us || 0).toLocaleString()} ₽</div>
                <div style="color: var(--danger); font-size: 12px; font-weight: bold;">📉 -${parseFloat(c.total_paid_by_us || 0).toLocaleString()} ₽</div>
            </div>

            <div style="padding-left: 15px; display: flex; gap: 5px;">
                <button class="btn btn-blue" style="padding: 6px 12px; font-size: 13px;" onclick="openCounterpartyProfile(${c.id})" title="Открыть карточку">📂 Открыть</button>
            </div>
        </div>
    `;
    }).join('');
}

window.openCounterpartyEditor = function (id = null) {
    let cp = id ? financeCounterparties.find(c => c.id === id) : {};
    const isEdit = !!id;

    const html = `
        <style>.modal-content { max-width: 800px !important; width: 90% !important; }</style>
        <input type="hidden" id="cp-id" value="${cp.id || ''}">
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; max-height: 70vh; overflow-y: auto; padding: 5px;">
            <div class="form-group" style="grid-column: span 2;">
                <label><b>Полное или краткое наименование:</b></label>
                <input type="text" id="cp-name" class="input-modern" value='${cp.name || ''}' placeholder='ООО "Плиттекс-Групп"'>
            </div>
            
            <div class="form-group">
                <label>Тип:</label>
                <select id="cp-type" class="input-modern">
                    <option value="Покупатель" ${cp.type === 'Покупатель' ? 'selected' : ''}>Покупатель</option>
                    <option value="Поставщик" ${cp.type === 'Поставщик' ? 'selected' : ''}>Поставщик</option>
                </select>
            </div>
            <div class="form-group">
                <label>Колонка цен:</label>
                <select id="cp-price-level" class="input-modern" style="border-color: #8b5cf6; color: #5b21b6; font-weight: bold;">
                    <option value="basic" ${cp.price_level === 'basic' ? 'selected' : ''}>Основная (Розница)</option>
                    <option value="dealer" ${cp.price_level === 'dealer' ? 'selected' : ''}>Дилерская (Опт)</option>
                </select>
            </div>
            <div class="form-group">
                <label>ИНН:</label>
                <input type="text" id="cp-inn" class="input-modern" value="${cp.inn || ''}" maxlength="12">
            </div>

            <div style="grid-column: span 2; padding: 10px; background: #f8fafc; border-radius: 8px; border: 1px solid var(--border);">
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                    <div class="form-group"><label>КПП:</label><input type="text" id="cp-kpp" class="input-modern" value="${cp.kpp || ''}"></div>
                    <div class="form-group"><label>ОГРН:</label><input type="text" id="cp-ogrn" class="input-modern" value="${cp.ogrn || ''}"></div>
                    <div class="form-group" style="grid-column: span 2;"><label>Юр. адрес:</label><input type="text" id="cp-address" class="input-modern" value="${cp.legal_address || ''}"></div>
                </div>
            </div>

            <div style="grid-column: span 2; padding: 10px; background: #eff6ff; border-radius: 8px; border: 1px solid #bfdbfe;">
                <label style="color: var(--primary); font-weight: bold; display: block; margin-bottom: 10px;">🏦 Банковские реквизиты</label>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                    <div class="form-group" style="grid-column: span 2;"><label>Банк:</label><input type="text" id="cp-bank" class="input-modern" value="${cp.bank_name || ''}"></div>
                    <div class="form-group"><label>БИК:</label><input type="text" id="cp-bik" class="input-modern" value="${cp.bik || ''}"></div>
                    <div class="form-group"><label>Расч. счет:</label><input type="text" id="cp-account" class="input-modern" value="${cp.checking_account || ''}"></div>
                </div>
            </div>

            <div class="form-group"><label>Контактное лицо:</label><input type="text" id="cp-director" class="input-modern" value="${cp.director_name || ''}"></div>
            <div class="form-group"><label>Телефон:</label><input type="text" id="cp-phone" class="input-modern" value="${cp.phone || ''}"></div>
            <div class="form-group" style="grid-column: span 2;"><label>Email:</label><input type="email" id="cp-email" class="input-modern" value="${cp.email || ''}"></div>
        </div>
    `;

    UI.showModal(isEdit ? '✏️ Редактирование' : '➕ Регистрация партнера', html, `
        <button class="btn btn-outline" onclick="openCounterpartiesModal()">🔙 Назад</button>
        <button class="btn btn-blue" onclick="saveCounterparty()">💾 Сохранить в базу</button>
    `);
};

window.saveCounterparty = async function () {
    const id = document.getElementById('cp-id').value;
    const data = {
        name: document.getElementById('cp-name').value.trim(),
        type: document.getElementById('cp-type').value,
        inn: document.getElementById('cp-inn').value.trim(),
        kpp: document.getElementById('cp-kpp').value.trim(),
        ogrn: document.getElementById('cp-ogrn').value.trim(),
        legal_address: document.getElementById('cp-address').value.trim(),
        bank_name: document.getElementById('cp-bank').value.trim(),
        bik: document.getElementById('cp-bik').value.trim(),
        checking_account: document.getElementById('cp-account').value.trim(),
        director_name: document.getElementById('cp-director').value.trim(),
        phone: document.getElementById('cp-phone').value.trim(),
        email: document.getElementById('cp-email').value.trim(),
        price_level: document.getElementById('cp-price-level').value
    };

    if (!data.name) return UI.toast('Введите название организации!', 'error');

    const method = id ? 'PUT' : 'POST';
    const url = id ? `/api/counterparties/${id}` : '/api/counterparties';

    try {
        const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
        if (res.ok) {
            UI.toast('✅ Данные успешно обновлены', 'success');
            await loadFinanceData();
            openCounterpartiesModal();
        } else UI.toast('Ошибка сохранения', 'error');
    } catch (e) { console.error(e); }
};

window.editCounterparty = function (id) { openCounterpartyEditor(id); };

// 2. Удаление контрагента
window.deleteCounterparty = function (id) {
    const html = `<div style="padding: 15px; text-align: center; font-size: 15px;">Точно удалить этого контрагента?<br><small style="color: gray;">Его имя пропадет из новых списков, но старая история платежей сохранится.</small></div>`;
    UI.showModal('⚠️ Удаление контрагента', html, `
        <button class="btn btn-outline" onclick="openCounterpartiesModal()">Отмена</button>
        <button class="btn btn-blue" style="background: #ef4444; border-color: #ef4444;" onclick="executeDeleteCounterparty(${id})">🗑️ Удалить</button>
    `);
};
window.executeDeleteCounterparty = async function (id) {
    UI.closeModal();
    try {
        await fetch(`/api/counterparties/${id}`, { method: 'DELETE' });
        await loadFinanceData();
        openCounterpartiesModal();
    } catch (e) { console.error(e); }
};

// === УМНОЕ ВЫСТАВЛЕНИЕ СЧЕТА ИЗ ФИНАНСОВ ===
window.toggleFinInvoiceType = function () {
    const type = document.getElementById('fin-invoice-type').value;
    document.getElementById('fin-general-block').style.display = type === 'general' ? 'block' : 'none';
    document.getElementById('fin-order-block').style.display = type === 'order' ? 'block' : 'none';
};

window.openFinanceInvoiceModal = async function (cpId, cpName) {
    // Подтягиваем активные заказы этого клиента, чтобы заполнить выпадающий список
    let ordersHtml = '<option value="">-- У клиента нет активных заказов --</option>';
    try {
        const res = await fetch('/api/sales/orders');
        const allOrders = await res.json();
        const clientOrders = allOrders.filter(o => o.counterparty_id === cpId);
        if (clientOrders.length > 0) {
            ordersHtml = clientOrders.map(o => `<option value="${o.doc_number}">Заказ №${o.doc_number} (на ${parseFloat(o.total_amount).toLocaleString('ru-RU')} ₽)</option>`).join('');
        }
    } catch (e) { console.error(e); }

    const html = `
        <div style="padding: 10px;">
            <h4 style="margin-top:0; color:var(--primary); margin-bottom: 15px;">Контрагент: ${cpName}</h4>

            <div class="form-group" style="margin-bottom: 15px;">
                <label style="color: #d97706; font-weight: bold;">Тип счета:</label>
                <select id="fin-invoice-type" class="input-modern" onchange="toggleFinInvoiceType()">
                    <option value="general">Свободный счет (Пополнение баланса / Аванс)</option>
                    <option value="order">Привязать к существующему Заказу</option>
                </select>
            </div>

            <div id="fin-general-block" style="background: #f8fafc; padding: 10px; border-radius: 6px; border: 1px solid var(--border);">
                <div class="form-group">
                    <label>Сумма счета (₽):</label>
                    <input type="number" id="fin-invoice-amount" class="input-modern" placeholder="Например: 150000">
                </div>
                <div class="form-group" style="margin-top: 10px;">
                    <label>Назначение платежа в счете:</label>
                    <input type="text" id="fin-invoice-desc" class="input-modern" value="Оплата за строительные материалы (аванс)">
                </div>
            </div>

            <div id="fin-order-block" style="display: none; background: #eff6ff; padding: 10px; border-radius: 6px; border: 1px solid #bfdbfe;">
                <div class="form-group">
                    <label>Выберите заказ для оплаты:</label>
                    <select id="fin-invoice-order" class="input-modern">${ordersHtml}</select>
                </div>
                <div class="form-group" style="margin-top: 10px;">
                    <label>Сумма счета (₽):</label>
                    <input type="number" id="fin-order-custom-amount" class="input-modern" placeholder="Оставьте пустым для всего остатка">
                </div>
            </div>

            <div class="form-group" style="margin-top: 15px; border-top: 1px dashed var(--border); padding-top: 15px;">
                <label>Выберите наши реквизиты (Банк):</label>
                <select id="fin-invoice-bank" class="input-modern">
                    <option value="tochka">ООО "Банк Точка"</option>
                    <option value="alfa">АО "Альфа-Банк"</option>
                </select>
            </div>
        </div>
    `;

    UI.showModal('Выставление счета', html, `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-blue" onclick="executeFinanceInvoice(${cpId})">🖨️ Сгенерировать PDF</button>
    `);
};

window.executeFinanceInvoice = function (cpId) {
    const type = document.getElementById('fin-invoice-type').value;
    const bank = document.getElementById('fin-invoice-bank').value;

    if (type === 'general') {
        const amount = document.getElementById('fin-invoice-amount').value;
        const desc = document.getElementById('fin-invoice-desc').value;
        if (!amount || amount <= 0) return UI.toast('Введите корректную сумму', 'warning');
        window.open(`/print/invoice?cp_id=${cpId}&amount=${amount}&desc=${encodeURIComponent(desc)}&bank=${bank}`, '_blank');
    } else {
        const docNum = document.getElementById('fin-invoice-order').value;
        const customAmt = document.getElementById('fin-order-custom-amount').value; // Новое поле
        if (!docNum) return UI.toast('Выберите заказ из списка', 'warning');
        window.open(`/print/invoice?docNum=${docNum}&bank=${bank}&custom_amount=${customAmt}`, '_blank');
    }

    UI.closeModal();

    // === НОВОЕ: Авто-обновление списка через полсекунды (чтобы сервер успел записать) ===
    setTimeout(() => {
        if (typeof loadFinanceData === 'function') loadFinanceData();
    }, 600);
};

window.executePrintInvoice = function (docNum) {
    const bank = document.getElementById('invoice-bank').value;
    window.open(`/print/invoice?docNum=${docNum}&bank=${bank}`, '_blank');
    UI.closeModal();
};

// === ЛОГИКА ОЖИДАЕМЫХ ПЛАТЕЖЕЙ (СЧЕТОВ) ===

function renderInvoicesTable() {
    const container = document.getElementById('invoices-container');
    const tbody = document.getElementById('invoices-table-body');

    // Если нет неоплаченных счетов — скрываем весь желтый блок
    if (financeInvoices.length === 0) {
        container.style.display = 'none';
        return;
    }

    container.style.display = 'block';
    tbody.innerHTML = financeInvoices.map(inv => `
        <tr onmouseover="this.style.backgroundColor='#fef3c7'" onmouseout="this.style.backgroundColor=''">
            <td style="font-size: 13px; color: var(--text-muted); font-weight: bold;">${inv.date_formatted}</td>
            <td style="font-weight: bold;">№ ${inv.invoice_number}</td>
            <td style="color: var(--primary); font-weight: 600;">👤 ${inv.counterparty_name}</td>
            <td style="font-size: 13px;">${inv.description}</td>
            <td style="text-align: right; font-weight: bold; font-size: 15px; color: #b45309;">${parseFloat(inv.amount).toLocaleString('ru-RU')} ₽</td>
            <td style="text-align: center; display: flex; gap: 5px; justify-content: center;">
                <button class="btn btn-blue" style="padding: 4px 10px; font-size: 12px;" onclick="markInvoicePaidModal(${inv.id})" title="Подтвердить оплату от клиента">✅ Оплачен</button>
                <button class="btn btn-outline" style="padding: 4px 8px; font-size: 12px; border-color: var(--danger); color: var(--danger);" onclick="deleteInvoice(${inv.id})" title="Удалить счет">❌</button>
            </td>
        </tr>
    `).join('');
}

// ОБНОВЛЕННАЯ ФУНКЦИЯ: Теперь она сохраняет счет в базу перед печатью
window.generateInvoice = async function (cp_id) {
    const desc = document.getElementById('inv-desc').value.trim();
    const amount = document.getElementById('inv-amount').value;
    const bank = document.getElementById('inv-bank').value;
    const num = document.getElementById('inv-num').value.trim();

    if (!amount || amount <= 0) return UI.toast('Укажите корректную сумму счета!', 'error');
    if (!desc) return UI.toast('Укажите назначение платежа!', 'error');
    if (!num) return UI.toast('Укажите номер счета!', 'error');

    // 1. Сохраняем счет в базу (в ожидаемые платежи)
    try {
        await fetch('/api/invoices', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cp_id, amount, desc, num })
        });
        await loadFinanceData(); // Мгновенно обновляем интерфейс
    } catch (e) { console.error("Ошибка сохранения счета", e); }

    // 2. Открываем PDF вкладку
    window.open(`/print/invoice?cp_id=${cp_id}&amount=${amount}&desc=${encodeURIComponent(desc)}&bank=${bank}&num=${encodeURIComponent(num)}`, '_blank');
    UI.closeModal();
};

window.markInvoicePaidModal = function (id) {
    // Окно выбора банка для зачисления
    const options = currentAccounts.map(acc => `<option value="${acc.id}">${acc.name} (${parseFloat(acc.balance).toLocaleString()} ₽)</option>`).join('');
    const html = `
        <div class="form-group" style="background: #eff6ff; padding: 15px; border-radius: 8px; border: 1px dashed #bfdbfe;">
            <label style="font-weight: bold; color: var(--primary);">На какой счет упали деньги?</label>
            <select id="pay-inv-account" class="input-modern" style="margin-top: 5px;">${options}</select>
        </div>
    `;
    UI.showModal('✅ Подтверждение оплаты счета', html, `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-blue" onclick="executeInvoicePay(${id})">💰 Подтвердить приход</button>
    `);
};

window.executeInvoicePay = async function (id) {
    const account_id = document.getElementById('pay-inv-account').value;
    try {
        const res = await fetch(`/api/invoices/${id}/pay`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ account_id })
        });
        if (res.ok) {
            UI.closeModal();
            UI.toast('✅ Счет оплачен! Деньги зачислены на баланс.', 'success');
            loadFinanceData();
        } else {
            UI.toast('Ошибка проведения оплаты', 'error');
        }
    } catch (e) { console.error(e); }
};

// 3. Удаление неоплаченного счета
window.deleteInvoice = function (id) {
    const html = `<div style="padding: 15px; text-align: center; font-size: 15px;">Точно удалить этот счет?<br><small style="color: gray;">Он безвозвратно исчезнет из списка ожидаемых платежей.</small></div>`;
    UI.showModal('⚠️ Отмена выставленного счета', html, `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-blue" style="background: #ef4444; border-color: #ef4444;" onclick="executeDeleteInvoice(${id})">🗑️ Удалить счет</button>
    `);
};

window.executeDeleteInvoice = async function (id) {
    UI.closeModal();
    try {
        const res = await fetch(`/api/invoices/${id}`, { method: 'DELETE' });
        if (res.ok) {
            UI.toast('🗑️ Счет отменен и удален', 'success'); // <--- ВОТ ЭТО ДОБАВИЛИ
            loadFinanceData();
        }
    } catch (e) {
        console.error(e);
        UI.toast('Ошибка сети', 'error');
    }
};

// ==========================================
// ИМПОРТ ВЫПИСКИ 1С (ПАРСЕР И ИНТЕРФЕЙС)
// ==========================================

let parsedBankTransactions = [];

window.openBankImportModal = function () {
    const accountOptions = currentAccounts.filter(a => a.type === 'bank').map(acc => `<option value="${acc.id}">${acc.name} (${parseFloat(acc.balance).toLocaleString()} ₽)</option>`).join('');

    const html = `
        <div class="form-group" style="background: #eff6ff; padding: 10px; border-radius: 6px; border: 1px dashed #bfdbfe;">
            <label style="font-weight: bold; color: var(--primary);">На какой счет загружаем?</label>
            <select id="import-account-id" class="input-modern" style="margin-top: 5px;">${accountOptions || '<option disabled>Нет банковских счетов</option>'}</select>
        </div>
        
        <div class="form-group" style="border: 2px dashed var(--border); padding: 30px; text-align: center; border-radius: 12px; background: #f8fafc; margin-top: 15px;">
            <label style="cursor: pointer; display: block;">
                <div style="font-size: 40px; margin-bottom: 10px;">📁</div>
                <div style="color: var(--primary); font-size: 16px; font-weight: bold;">Выберите файл выписки (1C)</div>
                <div style="font-size: 12px; color: gray; margin-top: 5px;">Скачайте файл .txt из Альфа-Банка или Точки</div>
                <input type="file" id="import-file" accept=".txt" style="display: none;" onchange="handleBankFileSelect(event)">
            </label>
            <div id="import-file-name" style="margin-top: 15px; font-weight: bold; font-size: 14px; color: var(--success);"></div>
        </div>
    `;

    UI.showModal('🏦 Импорт выписки из банка', html, `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-blue" onclick="processBankImport()" id="btn-process-import" disabled>🚀 Загрузить операции</button>
    `);
    parsedBankTransactions = [];
};

window.handleBankFileSelect = function (event) {
    const file = event.target.files[0];
    if (!file) return;

    const infoDiv = document.getElementById('import-file-name');
    infoDiv.innerHTML = `Файл: ${file.name} ⏳ Читаем...`;

    const reader = new FileReader();
    // ВАЖНО: Выписка 1С в РФ всегда идет в кодировке Windows-1251
    reader.readAsText(file, 'windows-1251');
    reader.onload = function (e) {
        const text = e.target.result;
        parsedBankTransactions = parse1CStatement(text);

        if (parsedBankTransactions.length > 0) {
            document.getElementById('btn-process-import').disabled = false;
            infoDiv.innerHTML = `✅ Готово! Найдено платежей: <b>${parsedBankTransactions.length}</b>`;
        } else {
            infoDiv.innerHTML = `<span style="color:red">❌ В файле нет операций или неверный формат</span>`;
        }
    };
};

// Самописный умный парсер стандарта 1С (Теперь с датами!)
function parse1CStatement(text) {
    const lines = text.split('\n').map(l => l.trim());
    if (lines[0] !== '1CClientBankExchange') {
        UI.toast('Это не файл выписки 1С!', 'error');
        return [];
    }

    const transactions = [];
    let currentDoc = null;

    for (let line of lines) {
        if (line.startsWith('СекцияДокумент=')) {
            currentDoc = {};
        } else if (line === 'КонецДокумента' && currentDoc) {
            let type = null;
            let rawDate = null;

            // Получаем реальную дату проведения по банку
            if (currentDoc['ДатаСписано']) {
                type = 'expense';
                rawDate = currentDoc['ДатаСписано'];
            } else if (currentDoc['ДатаПоступило']) {
                type = 'income';
                rawDate = currentDoc['ДатаПоступило'];
            }

            if (type && currentDoc['Сумма']) {
                const cpName = type === 'income' ? (currentDoc['Плательщик1'] || currentDoc['Плательщик']) : (currentDoc['Получатель1'] || currentDoc['Получатель']);
                const cpInn = type === 'income' ? currentDoc['ПлательщикИНН'] : currentDoc['ПолучательИНН'];
                const cleanAmount = parseFloat((currentDoc['Сумма'] || '0').replace(',', '.'));

                // Преобразуем банковскую дату (ДД.ММ.ГГГГ) в формат базы данных (ГГГГ-ММ-ДД)
                let formattedDate = null;
                if (rawDate) {
                    const [d, m, y] = rawDate.split('.');
                    if (y && m && d) formattedDate = `${y}-${m}-${d} 12:00:00`; // Ставим 12:00, чтобы избежать сдвига часовых поясов
                }

                transactions.push({
                    type: type,
                    amount: cleanAmount,
                    date: formattedDate, // <--- ПЕРЕДАЕМ ДАТУ НА СЕРВЕР
                    counterparty_name: cpName || 'Неизвестный партнер',
                    counterparty_inn: cpInn ? String(cpInn).split('/')[0].split('\\')[0].trim().substring(0, 20) : null,
                    description: currentDoc['НазначениеПлатежа'] || 'Банковская операция'
                });
            }
            currentDoc = null;
        } else if (currentDoc) {
            const eqIndex = line.indexOf('=');
            if (eqIndex > -1) {
                const key = line.substring(0, eqIndex);
                const val = line.substring(eqIndex + 1);
                currentDoc[key] = val;
            }
        }
    }
    return transactions;
}

window.processBankImport = async function () {
    const account_id = document.getElementById('import-account-id').value;
    if (parsedBankTransactions.length === 0) return UI.toast('Нет операций для импорта', 'error');

    const btn = document.getElementById('btn-process-import');
    btn.disabled = true;
    btn.innerText = '⏳ Сохраняем в базу...';

    try {
        const res = await fetch('/api/transactions/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ account_id, transactions: parsedBankTransactions })
        });

        // Сначала проверяем, не упал ли сервер
        if (!res.ok) {
            const errText = await res.text(); // Читаем текстовую ошибку
            UI.toast('Ошибка сервера: ' + errText, 'error');
            btn.disabled = false;
            btn.innerText = '🚀 Загрузить операции';
            return;
        }

        const result = await res.json();
        UI.closeModal();

        let msg = `✅ Успешно загружено: ${result.count} платежей.`;
        // Если сервер нашел и закрыл счета, гордо сообщаем об этом!
        if (result.autoPaid > 0) {
            msg += `\n🎯 Автоматически закрыто счетов: ${result.autoPaid}!`;
        }

        UI.toast(msg, 'success');
        loadFinanceData();

    } catch (e) {
        console.error(e);
        UI.toast('Сбой сети: ' + e.message, 'error');
        btn.disabled = false;
        btn.innerText = '🚀 Загрузить операции';
    }
};

// ==========================================
// МАССОВОЕ УДАЛЕНИЕ, ПАГИНАЦИЯ И УМНЫЕ ДАТЫ
// ==========================================

window.changeFinancePage = function (dir) {
    const newPage = currentFinancePage + dir;
    if (newPage >= 1 && newPage <= financeTotalPages) {
        currentFinancePage = newPage;
        loadFinanceData();
    }
};

window.toggleSelectAll = function (masterCheckbox) {
    const checkboxes = document.querySelectorAll('.trans-checkbox');
    checkboxes.forEach(cb => {
        cb.checked = masterCheckbox.checked;
        if (cb.checked) selectedTransIds.add(parseInt(cb.value));
        else selectedTransIds.delete(parseInt(cb.value));
    });
    updateBulkActionsVisibility();
};

window.toggleRowSelect = function (checkbox) {
    if (checkbox.checked) selectedTransIds.add(parseInt(checkbox.value));
    else selectedTransIds.delete(parseInt(checkbox.value));

    const allChecked = document.querySelectorAll('.trans-checkbox:not(:checked)').length === 0;
    document.getElementById('selectAllCheckbox').checked = allChecked;
    updateBulkActionsVisibility();
};

window.updateBulkActionsVisibility = function () {
    const panel = document.getElementById('bulk-actions-panel');
    const countSpan = document.getElementById('bulk-selected-count');
    if (selectedTransIds.size > 0) {
        panel.style.display = 'flex';
        countSpan.innerText = selectedTransIds.size;
    } else {
        panel.style.display = 'none';
    }
};

window.executeBulkDelete = function () {
    const html = `<div style="padding: 15px; text-align: center; font-size: 15px;">Вы уверены, что хотите удалить <b>${selectedTransIds.size}</b> операций?<br><small style="color: gray;">Балансы счетов будут автоматически пересчитаны!</small></div>`;
    UI.showModal('⚠️ Массовое удаление', html, `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-blue" style="background: #ef4444; border-color: #ef4444;" onclick="confirmBulkDelete()">🗑️ Да, удалить</button>
    `);
};

window.confirmBulkDelete = async function () {
    UI.closeModal();
    try {
        const res = await fetch('/api/transactions/bulk-delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids: Array.from(selectedTransIds) })
        });
        if (res.ok) {
            UI.toast('✅ Операции удалены', 'success');
            selectedTransIds.clear();
            loadFinanceData();
        }
    } catch (e) { console.error(e); }
};

window.setFinanceDateRange = function (type) {
    const today = new Date();
    let start = new Date();
    let end = new Date();

    if (type === 'week') {
        const day = today.getDay();
        const diff = today.getDate() - day + (day === 0 ? -6 : 1);
        start = new Date(today.setDate(diff));
        end = new Date();
    } else if (type === 'month') {
        start = new Date(today.getFullYear(), today.getMonth(), 1);
        end = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    } else if (type === 'quarter') {
        const quarter = Math.floor((today.getMonth() / 3));
        start = new Date(today.getFullYear(), quarter * 3, 1);
        end = new Date(today.getFullYear(), quarter * 3 + 3, 0);
    } else if (type === 'year') {
        start = new Date(today.getFullYear(), 0, 1);
        end = new Date(today.getFullYear(), 11, 31);
    }

    const fmt = (d) => {
        const offset = d.getTimezoneOffset() * 60000;
        return new Date(d.getTime() - offset).toISOString().split('T')[0];
    };

    financeDateRange.start = fmt(start);
    financeDateRange.end = fmt(end);

    document.getElementById('finance-date-filter')._flatpickr.setDate([start, end]);
    currentFinancePage = 1;
    loadFinanceData();
};

// Смена количества строк на странице
window.changeFinanceLimit = function () {
    currentFinanceLimit = document.getElementById('finance-limit').value;
    currentFinancePage = 1; // При смене лимита всегда возвращаемся на первую страницу
    loadFinanceData();
};

// Умный поиск (запускается с задержкой 0.5 сек, чтобы не спамить сервер, пока ты печатаешь ИНН)
window.triggerFinanceSearch = function () {
    clearTimeout(financeSearchTimer);
    financeSearchTimer = setTimeout(() => {
        currentFinancePage = 1;
        loadFinanceData();
    }, 500);
};

// ==========================================
// ЭКСПОРТ ДАННЫХ В EXCEL (CSV ФОРМАТ)
// ==========================================
window.exportFinanceToExcel = async function () {
    try {
        // 1. Собираем АКТУАЛЬНЫЕ фильтры и поиск с экрана
        const searchInput = document.getElementById('finance-search');
        const searchQuery = searchInput ? searchInput.value.trim() : '';

        let queryParams = new URLSearchParams();

        // Фильтр по датам
        if (financeDateRange.start && financeDateRange.end) {
            queryParams.append('start', financeDateRange.start);
            queryParams.append('end', financeDateRange.end);
        }

        // Фильтр по конкретному счету (Альфа, Точка и т.д.)
        if (currentAccountFilter) {
            queryParams.append('account_id', currentAccountFilter);
        }

        // Текст из строки поиска (ИНН, название)
        if (searchQuery) {
            queryParams.append('search', searchQuery);
        }

        // ВАЖНО: Ставим лимит 100 000, чтобы выгрузились ВСЕ найденные платежи, 
        // а не только первые 20 со страницы
        queryParams.append('page', 1);
        queryParams.append('limit', 100000);

        UI.toast('⏳ Подготавливаем полный отчет...', 'info');

        // 2. Отправляем запрос на сервер с учетом всех фильтров
        const res = await fetch(`/api/transactions?${queryParams.toString()}`);
        const data = await res.json();

        if (!data.data || data.data.length === 0) {
            return UI.toast('Нет данных для выгрузки', 'warning');
        }

        // 3. Формируем CSV текст (BOM \uFEFF нужен, чтобы русский Excel правильно читал кириллицу)
        let csvContent = '\uFEFF';
        csvContent += 'Дата;Тип;Сумма;Контрагент;Категория;Счет;Способ оплаты;Комментарий\n';

        data.data.forEach(t => {
            const type = t.transaction_type === 'income' ? 'Поступление' : 'Списание';
            // Умное форматирование даты для выгрузки
            let safeDate = t.date_formatted;
            if (!safeDate && t.transaction_date) {
                const d = new Date(t.transaction_date);
                if (!isNaN(d)) safeDate = d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
            }
            
            // Функция для защиты от запятых, кавычек и переносов строк внутри комментариев
            const escapeCSV = (str) => `"${String(str || '').replace(/"/g, '""').replace(/\n/g, ' ')}"`;

            // Склеиваем колонки через точку с запятой (стандарт для русского Excel)
            csvContent += `${safeDate || '-'};${type};${t.amount};${escapeCSV(t.counterparty_name)};${escapeCSV(t.category)};${escapeCSV(t.account_name)};${escapeCSV(t.payment_method)};${escapeCSV(t.description)}\n`;
        });

        // 4. Генерируем файл и скачиваем его
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;

        const today = new Date().toISOString().split('T')[0];
        link.download = `Финансы_Плиттекс_${today}.csv`; // Красивое имя файла

        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);

        UI.toast('✅ Файл успешно скачан!', 'success');
    } catch (e) {
        console.error('Ошибка экспорта:', e);
        UI.toast('Ошибка при формировании файла', 'error');
    }
};

// ==========================================
// ОТРИСОВКА ИНТЕРФАКТИВНЫХ ГРАФИКОВ
// ==========================================
function renderFinanceCharts(transactions) {
    // 1. ПОДГОТОВКА ДАННЫХ ДЛЯ КАТЕГОРИЙ (РАСХОДЫ)
    const expenseMap = {};
    transactions.filter(t => t.transaction_type === 'expense').forEach(t => {
        expenseMap[t.category] = (expenseMap[t.category] || 0) + parseFloat(t.amount);
    });

    const catLabels = Object.keys(expenseMap);
    const catValues = Object.values(expenseMap);

    // 2. УНИЧТОЖАЕМ СТАРЫЕ ГРАФИКИ (чтобы не накладывались при обновлении)
    if (chartFlow) chartFlow.destroy();
    if (chartCategories) chartCategories.destroy();

    // 3. ГРАФИК СТРУКТУРЫ РАСХОДОВ (Круговой)
    const ctxCat = document.getElementById('chart-finance-categories').getContext('2d');
    chartCategories = new Chart(ctxCat, {
        type: 'doughnut',
        data: {
            labels: catLabels,
            datasets: [{
                data: catValues,
                backgroundColor: ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899'],
                borderWidth: 2,
                borderColor: '#ffffff'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } }
            },
            cutout: '70%'
        }
    });

    // 4. ГРАФИК ПОТОКОВ (Доход vs Расход по датам)
    // Группируем суммы по датам с умной защитой формата дат
    const flowMap = {};
    transactions.forEach(t => {
        const rawDateStr = t.transaction_date || t.date_formatted;
        let date = 'Неизвестно';
        if (rawDateStr) {
            const dObj = new Date(rawDateStr);
            if (!isNaN(dObj)) {
                date = dObj.toISOString().split('T')[0];
            } else if (typeof rawDateStr === 'string') {
                date = rawDateStr.split(' ')[0];
            }
        }

        if (!flowMap[date]) flowMap[date] = { inc: 0, exp: 0 };
        if (t.transaction_type === 'income') flowMap[date].inc += parseFloat(t.amount);
        else flowMap[date].exp += parseFloat(t.amount);
    });

    const dates = Object.keys(flowMap).sort();
    const incomes = dates.map(d => flowMap[d].inc);
    const expenses = dates.map(d => flowMap[d].exp);

    const ctxFlow = document.getElementById('chart-finance-flow').getContext('2d');
    chartFlow = new Chart(ctxFlow, {
        type: 'bar',
        data: {
            labels: dates,
            datasets: [
                { label: 'Доход', data: incomes, backgroundColor: '#10b981', borderRadius: 4 },
                { label: 'Расход', data: expenses, backgroundColor: '#ef4444', borderRadius: 4 }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                y: { beginAtZero: true, ticks: { callback: v => v.toLocaleString() + ' ₽' } },
                x: { grid: { display: false } }
            },
            plugins: {
                legend: { position: 'top', align: 'end' }
            }
        }
    });
}


// === ЗАГРУЗКА И УДАЛЕНИЕ ЧЕКОВ ===
window.uploadReceipt = async function (id, input) {
    const file = input.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('receipt', file);

    UI.toast('⏳ Загрузка файла...', 'info');
    try {
        const res = await fetch(`/api/transactions/${id}/receipt`, { method: 'POST', body: formData });
        if (res.ok) {
            UI.toast('✅ Файл успешно прикреплен!', 'success');
            loadFinanceData();
        } else {
            UI.toast('❌ Ошибка при загрузке файла', 'error');
        }
    } catch (e) {
        console.error(e);
        UI.toast('❌ Ошибка сети при загрузке', 'error');
    }
};

window.deleteReceipt = function (id) {
    const html = `<div style="padding: 15px; text-align: center; font-size: 15px;">Точно открепить файл от этой операции?</div>`;
    UI.showModal('⚠️ Удаление файла', html, `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-blue" style="background: #ef4444; border-color: #ef4444;" onclick="executeDeleteReceipt(${id})">🗑️ Да, удалить</button>
    `);
};

window.executeDeleteReceipt = async function (id) {
    UI.closeModal();
    try {
        const res = await fetch(`/api/transactions/${id}/receipt`, { method: 'DELETE' });
        if (res.ok) {
            UI.toast('🗑️ Файл успешно откреплен', 'success');
            loadFinanceData();
        } else {
            UI.toast('❌ Ошибка при удалении', 'error');
        }
    } catch (e) {
        console.error(e);
        UI.toast('❌ Ошибка сети', 'error');
    }
};

// === ОКНО ОТЧЕТА P&L ===
window.openPnlReportModal = async function (customStart = '', customEnd = '') {
    UI.toast('Сбор финансовых данных...', 'info');
    let queryParams = '';
    let periodText = 'За всё время';

    let start = customStart;
    let end = customEnd;

    if (start && end) {
        queryParams = `?start=${start}&end=${end}`;
        // Форматируем дату для красивого отображения
        const formatD = (dStr) => {
            const [y, m, d] = dStr.split('-');
            return `${d}.${m}.${y}`;
        };
        periodText = `с ${formatD(start)} по ${formatD(end)}`;
    }

    try {
        const res = await fetch(`/api/finance/pnl${queryParams}`);
        if (!res.ok) throw new Error('Ошибка сервера');
        const data = await res.json();

        const html = `
            <style>.modal-content { max-width: 800px !important; width: 90% !important; }</style>
            <div style="background: #f8fafc; padding: 20px; border-radius: 8px; border: 1px solid var(--border);">
                <h3 style="margin-top: 0; text-align: center; color: var(--text-main);">Отчет о прибылях и убытках (P&L)</h3>
                
                <div style="display: flex; justify-content: center; gap: 10px; margin-bottom: 20px; align-items: center; background: #fff; padding: 10px; border-radius: 8px; border: 1px solid var(--border);">
                    <span style="font-size: 13px; font-weight: bold;">Период расчета:</span>
                    <input type="date" id="pnl-start" class="input-modern" value="${start}" style="margin: 0; padding: 4px 8px; width: 130px;">
                    <span>—</span>
                    <input type="date" id="pnl-end" class="input-modern" value="${end}" style="margin: 0; padding: 4px 8px; width: 130px;">
                    <button class="btn btn-blue" style="padding: 4px 12px;" onclick="openPnlReportModal(document.getElementById('pnl-start').value, document.getElementById('pnl-end').value)">🔄 Рассчитать</button>
                    <button class="btn btn-outline" style="padding: 4px 12px;" onclick="openPnlReportModal('', '')">За всё время</button>
                </div>

                <div style="text-align: center; margin-bottom: 25px;">
                    <span style="background: #e0e7ff; color: #3730a3; padding: 6px 15px; border-radius: 20px; font-weight: bold; font-size: 13px; border: 1px solid #c7d2fe;">
                        📅 ${periodText}
                    </span>
                </div>

                <div style="display: flex; justify-content: space-between; padding: 15px; background: #fff; border: 1px solid var(--border); border-radius: 6px; margin-bottom: 10px;">
                    <span style="font-size: 16px; font-weight: bold;">Выручка (Оборот):</span>
                    <span style="font-size: 18px; font-weight: bold; color: var(--success);">${data.revenue.toLocaleString('ru-RU')} ₽</span>
                </div>

                <div style="display: flex; justify-content: space-between; padding: 15px; background: #fff; border: 1px solid var(--border); border-radius: 6px; margin-bottom: 10px;">
                    <span style="font-size: 16px; font-weight: bold;">Прямые расходы (Сырье, Сдельная ЗП):</span>
                    <span style="font-size: 18px; font-weight: bold; color: var(--danger);">-${data.directCosts.toLocaleString('ru-RU')} ₽</span>
                </div>

                <div style="display: flex; justify-content: space-between; padding: 15px; background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 6px; margin-bottom: 10px;">
                    <span style="font-size: 16px; font-weight: bold; color: var(--primary);">Маржинальная прибыль (Gross Profit):</span>
                    <span style="font-size: 18px; font-weight: bold; color: var(--primary);">${data.grossProfit.toLocaleString('ru-RU')} ₽</span>
                </div>

                <div style="display: flex; justify-content: space-between; padding: 15px; background: #fff; border: 1px solid var(--border); border-radius: 6px; margin-bottom: 10px;">
                    <span style="font-size: 16px; font-weight: bold;">Косвенные расходы (Аренда, Налоги и др.):</span>
                    <span style="font-size: 18px; font-weight: bold; color: var(--danger);">-${data.indirectCosts.toLocaleString('ru-RU')} ₽</span>
                </div>

                <div style="display: flex; justify-content: space-between; padding: 20px; background: ${data.netProfit >= 0 ? '#f0fdf4' : '#fef2f2'}; border: 2px solid ${data.netProfit >= 0 ? '#22c55e' : '#ef4444'}; border-radius: 8px; align-items: center;">
                    <div>
                        <div style="font-size: 18px; font-weight: bold; color: ${data.netProfit >= 0 ? '#166534' : '#991b1b'};">ЧИСТАЯ ПРИБЫЛЬ (Net Profit):</div>
                        <div style="font-size: 13px; color: var(--text-muted); margin-top: 5px;">Рентабельность бизнеса: <b>${data.margin}%</b></div>
                    </div>
                    <span style="font-size: 26px; font-weight: 900; color: ${data.netProfit >= 0 ? '#15803d' : '#b91c1c'};">${data.netProfit > 0 ? '+' : ''}${data.netProfit.toLocaleString('ru-RU')} ₽</span>
                </div>
            </div>
        `;
        UI.showModal('📈 Финансовая аналитика', html, '<button class="btn btn-outline" onclick="UI.closeModal()">Закрыть</button>');
    } catch (e) { console.error(e); UI.toast('Ошибка построения P&L', 'error'); }
};

window.addPlannedExpense = async function () {
    const data = {
        date: document.getElementById('plan-date').value,
        amount: document.getElementById('plan-amount').value,
        category: document.getElementById('plan-category').value,
        is_recurring: document.getElementById('plan-recurring').checked
    };
    if (!data.date || !data.amount) return UI.toast('Укажите дату и сумму', 'warning');

    try {
        await fetch('/api/finance/planned-expenses', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
        });
        UI.toast('✅ Расход запланирован', 'success');
        openPaymentCalendarModal(); // Перезагружаем окно
    } catch (e) { console.error(e); }
};

window.payPlannedExpense = async function (id) {
    try {
        await fetch(`/api/finance/planned-expenses/${id}/pay`, { method: 'POST' });
        UI.toast('✅ Оплачено (если регулярный — создан на след. месяц)', 'success');
        openPaymentCalendarModal();
    } catch (e) { console.error(e); }
};

window.deletePlannedExpense = async function (id) {
    try {
        await fetch(`/api/finance/planned-expenses/${id}`, { method: 'DELETE' });
        UI.toast('🗑️ Плановый расход отменен', 'success');
        openPaymentCalendarModal();
    } catch (e) { console.error(e); }
};

// === КАРТОЧКА КОНТРАГЕНТА (CRM) ===
window.openCounterpartyProfile = async function (id) {
    UI.toast('Загрузка профиля...', 'info');
    try {
        const res = await fetch(`/api/counterparties/${id}/profile`);
        if (!res.ok) throw new Error('Ошибка загрузки');
        const data = await res.json();
        const cp = data.info; // <-- Вот наша правильная переменная

        // Генерация истории операций
        const transHtml = data.transactions.map(t => `
            <div style="display: flex; justify-content: space-between; padding: 10px; border-bottom: 1px solid var(--border); font-size: 13px;">
                <div><b style="color:var(--text-main);">${t.date}</b><br><span style="color:var(--text-muted);">${t.category}</span></div>
                <div style="text-align: right; width: 50%;">${t.description}</div>
                <div style="font-weight: bold; color: ${t.transaction_type === 'income' ? 'var(--success)' : 'var(--danger)'}">
                    ${t.transaction_type === 'income' ? '+' : '-'}${parseFloat(t.amount).toLocaleString('ru-RU')} ₽
                </div>
            </div>
        `).join('') || '<div style="padding:15px; text-align:center; color:gray;">Операций нет</div>';

        // Генерация счетов
        const invHtml = data.invoices.map(i => `
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 10px; border-bottom: 1px solid var(--border); font-size: 13px;">
                <div><b>Счет №${i.invoice_number}</b> от ${i.date}<br><span style="color: gray;">${i.description}</span></div>
                <div style="font-weight: bold;">${parseFloat(i.amount).toLocaleString('ru-RU')} ₽</div>
                <div><span class="badge" style="background: ${i.status === 'paid' ? '#dcfce3' : '#fef3c7'}; color: ${i.status === 'paid' ? '#166534' : '#b45309'};">${i.status === 'paid' ? 'Оплачен' : 'Ожидает'}</span></div>
            </div>
        `).join('') || '<div style="padding:15px; text-align:center; color:gray;">Счетов нет</div>';

        // Генерация списка договоров
        const contractsHtml = data.contracts.map(c => `
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 10px; border-bottom: 1px solid var(--border); font-size: 13px;">
                <div><b>Договор №${c.number}</b> от ${c.date}</div>
                <div style="display: flex; gap: 5px;">
                    <button class="btn btn-outline" style="padding: 4px 8px; font-size: 12px; color: #0ea5e9; border-color: #0ea5e9;" onclick="window.open('/print/contract?id=${c.id}', '_blank')" title="Распечатать">🖨️</button>
                    <button class="btn btn-outline" style="padding: 4px 8px; font-size: 12px; color: var(--danger); border-color: var(--danger);" onclick="deleteContract(${c.id}, ${cp.id})" title="Удалить договор">❌</button>
                </div>
            </div>
        `).join('') || '<div style="padding:15px; text-align:center; color:gray;">Договоров нет</div>';

        const html = `
            <style>.modal-content { max-width: 1000px !important; width: 95% !important; }</style>
            <div style="display: flex; gap: 20px; align-items: flex-start;">
                <div style="flex: 1;">
                    <div style="background: #f8fafc; padding: 15px; border-radius: 8px; border: 1px solid var(--border); margin-bottom: 15px;">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                            <span class="badge" style="background: #e0e7ff; color: #3730a3;">${cp.type}</span>
                            <button class="btn btn-outline" style="padding: 4px 8px; font-size: 12px;" onclick="editCounterparty(${cp.id})">✏️ Изменить реквизиты</button>
                        </div>
                        <h3 style="margin: 0 0 10px 0;">${cp.name}</h3>
                        <div style="font-size: 12px; color: var(--text-muted); line-height: 1.6;">
                            <b>ИНН:</b> ${cp.inn || '—'} | <b>КПП:</b> ${cp.kpp || '—'}<br>
                            <b>Телефон:</b> ${cp.phone || '—'}<br>
                            <b>Юр. адрес:</b> ${cp.legal_address || '—'}<br>
                            <b>Банк:</b> ${cp.bank_name || '—'} (Р/С: ${cp.checking_account || '—'})
                        </div>
                    </div>

                    <div style="margin-bottom: 15px;">
                        <h4 style="margin: 0 0 5px 0; cursor: pointer; background: #f8fafc; padding: 10px; border-radius: 6px; border: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; transition: 0.2s;"
                            onmouseover="this.style.backgroundColor='#e0f2fe'" onmouseout="this.style.backgroundColor='#f8fafc'"
                            onclick="const c = document.getElementById('cp-contracts-list'); const i = document.getElementById('cp-contracts-icon'); if(c.style.display==='none'){c.style.display='block'; i.innerText='▲ Свернуть';}else{c.style.display='none'; i.innerText='▼ Развернуть';}">
                            <span>📑 Договоры клиента</span>
                            <span id="cp-contracts-icon" style="color: var(--primary); font-size: 12px; font-weight: normal;">▼ Развернуть</span>
                        </h4>
                        <div id="cp-contracts-list" style="display: none; border: 1px solid var(--border); border-radius: 8px; max-height: 200px; overflow-y: auto; background: #fff;">
                            ${contractsHtml}
                        </div>
                    </div>
                    
                    <h4 style="margin: 0 0 10px 0;">🟡 Счета на оплату</h4>
                    <div style="border: 1px solid var(--border); border-radius: 8px; max-height: 150px; overflow-y: auto; background: #fff; margin-bottom: 15px;">
                        ${invHtml}
                    </div>

                    <h4 style="margin: 0 0 10px 0;">📄 Прочие документы</h4>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 20px;">
                        <button class="btn btn-outline" style="border-color: #f59e0b; color: #d97706;" onclick="openFinanceInvoiceModal(${cp.id}, '${cp.name.replace(/'/g, "\\'")}')">🖨️ Выставить Счет</button>
                        <button class="btn btn-outline" style="border-color: #3b82f6; color: #2563eb;" onclick="window.open('/print/act?cp_id=${cp.id}', '_blank')">Акт сверки (Фин.)</button>
                    </div>
                </div>

                <div style="flex: 1;">
                    <h4 style="margin: 0 0 10px 0;">💸 Финансовая история</h4>
                    <div style="border: 1px solid var(--border); border-radius: 8px; max-height: 600px; overflow-y: auto; background: #fff;">
                        ${transHtml}
                    </div>
                </div>
            </div>
        `;

        UI.showModal(`Карточка: ${cp.name}`, html, `<button class="btn btn-outline" onclick="openCounterpartiesModal()">🔙 Назад к списку</button>`);
    } catch (e) {
        console.error(e);
        UI.toast('Ошибка загрузки', 'error');
    }
};

// === УДАЛЕНИЕ ДОГОВОРА ===
window.deleteContract = function (contractId, cpId) {
    const html = `
        <div style="padding: 15px; text-align: center; font-size: 15px;">
            Вы уверены, что хотите удалить этот договор?<br>
            <small style="color: var(--danger);">Все привязанные к нему спецификации также будут удалены!</small>
        </div>`;

    // Показываем поверх текущего окна
    UI.showModal('⚠️ Удаление договора', html, `
        <button class="btn btn-outline" onclick="openCounterpartyProfile(${cpId})">Отмена</button>
        <button class="btn btn-blue" style="background: #ef4444; border-color: #ef4444;" onclick="executeDeleteContract(${contractId}, ${cpId})">🗑️ Да, удалить</button>
    `);
};

window.executeDeleteContract = async function (contractId, cpId) {
    try {
        const res = await fetch(`/api/contracts/${contractId}`, { method: 'DELETE' });
        if (res.ok) {
            UI.toast('✅ Договор успешно удален', 'success');
            openCounterpartyProfile(cpId); // Мгновенно перезагружаем профиль
        } else {
            UI.toast('Ошибка при удалении', 'error');
        }
    } catch (e) {
        console.error(e);
        UI.toast('Ошибка сети', 'error');
    }
};

// === КАЛЕНДАРЬ ПЛАТЕЖЕЙ ===
window.openPaymentCalendarModal = async function () {
    try {
        const res = await fetch('/api/finance/planned-expenses');
        const expenses = await res.json();

        let tbody = expenses.map(e => `
            <tr style="border-bottom: 1px solid #eee;">
                <td style="padding: 10px;"><b>${e.date}</b></td>
                <td style="padding: 10px;">${e.category}</td>
                <td style="padding: 10px; color: var(--text-muted);">${e.description || '-'}</td>
                <td style="padding: 10px; color: var(--danger); font-weight: bold;">-${parseFloat(e.amount).toLocaleString('ru-RU')} ₽</td>
                <td style="padding: 10px; text-align: right;">
                    <button class="btn btn-outline" style="padding: 4px 8px; font-size: 11px; color: var(--success); border-color: var(--success);" onclick="executePlannedExpense(${e.id}, ${e.amount})" title="Провести платеж">✅ Оплатить</button>
                    <button class="btn btn-outline" style="padding: 4px 8px; font-size: 11px; color: var(--danger); border-color: var(--danger); margin-left: 5px;" onclick="deletePlannedExpense(${e.id})" title="Отменить план">❌</button>
                </td>
            </tr>
        `).join('') || '<tr><td colspan="5" style="text-align:center; color:gray; padding: 20px;">Нет запланированных платежей</td></tr>';

        const html = `
            <div style="padding: 10px;">
                <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                    <thead style="background: #f8fafc; text-align: left;">
                        <tr>
                            <th style="padding: 10px;">Дата</th>
                            <th style="padding: 10px;">Категория</th>
                            <th style="padding: 10px;">Назначение</th>
                            <th style="padding: 10px;">Сумма</th>
                            <th style="padding: 10px; text-align: right;">Действия</th>
                        </tr>
                    </thead>
                    <tbody>${tbody}</tbody>
                </table>
            </div>
        `;

        UI.showModal('📅 Календарь платежей', html, `<button class="btn btn-outline" onclick="UI.closeModal()">Закрыть</button>`);
    } catch (e) {
        console.error(e);
        UI.toast('Ошибка загрузки календаря', 'error');
    }
};

// === ЛОГИКА ПРОВЕДЕНИЯ ПЛАНОВОГО ПЛАТЕЖА ===

window.executePlannedExpense = function (id, amount) {
    // Формируем список счетов для выбора
    const options = currentAccounts.map(acc =>
        `<option value="${acc.id}">${acc.name} (баланс: ${parseFloat(acc.balance).toLocaleString()} ₽)</option>`
    ).join('');

    const html = `
        <div style="padding: 10px;">
            <p style="margin-bottom: 15px;">Провести оплату на сумму <b>${parseFloat(amount).toLocaleString('ru-RU')} ₽</b>?</p>
            <div class="form-group">
                <label style="font-weight: bold; color: var(--primary);">Выберите счет для списания:</label>
                <select id="pay-planned-account" class="input-modern" style="margin-top: 5px;">
                    ${options}
                </select>
            </div>
        </div>
    `;

    UI.showModal('Подтверждение оплаты', html, `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-blue" onclick="confirmPlannedPay(${id})">✅ Подтвердить списание</button>
    `);
};

window.confirmPlannedPay = async function (id) {
    const accId = document.getElementById('pay-planned-account').value;
    if (!accId) return UI.toast('Выберите счет!', 'warning');

    try {
        const res = await fetch(`/api/finance/planned-expenses/${id}/pay`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ account_id: accId })
        });

        if (res.ok) {
            UI.closeModal();
            UI.toast('✅ Платеж успешно проведен и списан с баланса', 'success');
            loadFinanceData(); // Обновить общие балансы и таблицы
            openPaymentCalendarModal(); // Обновить сам календарь
        } else {
            const err = await res.text();
            UI.toast('Ошибка: ' + err, 'error');
        }
    } catch (e) {
        console.error(e);
        UI.toast('Ошибка связи с сервером', 'error');
    }
};