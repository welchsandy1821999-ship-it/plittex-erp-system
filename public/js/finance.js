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
            if (selectedDates.length === 2) {
                financeDateRange.start = instance.formatDate(selectedDates[0], "Y-m-d");
                financeDateRange.end = instance.formatDate(selectedDates[1], "Y-m-d");
                currentFinancePage = 1;
                loadFinanceData();
            } else if (selectedDates.length === 0) {
                // 🛡️ ИСПРАВЛЕНИЕ: Пользователь стер даты (нажал крестик)
                financeDateRange.start = '';
                financeDateRange.end = '';
                currentFinancePage = 1;
                loadFinanceData();
            }
        }
    });

    loadFinanceData();
}

window.resetFinanceFilter = function () {
    document.getElementById('finance-date-filter')._flatpickr.clear();
    financeDateRange = { start: '', end: '' };
    currentAccountFilter = null; // 🛠️ ИСПРАВЛЕНИЕ: Сбрасываем выбранную плашку
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

        // 🚀 ИСПРАВЛЕНИЕ: Добавляем метку времени в параметры поиска транзакций
        const timestamp = Date.now();
        queryParams.append('_t', timestamp);

        const queryStr = `?${queryParams.toString()}`;

        // 🚀 ИСПРАВЛЕНИЕ: Добавляем ?_t=... ко ВСЕМ запросам, чтобы браузер никогда их не кэшировал
        const [reportRes, transRes, accRes, catRes, cpRes, invRes] = await Promise.all([
            fetch(`/api/report/finance${financeDateRange.start ? `?start=${financeDateRange.start}&end=${financeDateRange.end}&_t=${timestamp}` : `?_t=${timestamp}`}`),
            fetch(`/api/transactions${queryStr}`),
            fetch(`/api/accounts?_t=${timestamp}`),
            fetch(`/api/finance/categories?_t=${timestamp}`),
            fetch(`/api/counterparties?_t=${timestamp}`),
            fetch(`/api/invoices?_t=${timestamp}`)
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
        loadCashflowForecast();
        renderOrderProfitability();
        loadTaxPiggyBank();
        if (document.getElementById('cp-list-container')) {
            renderCPList();
        }
    } catch (e) { console.error("Ошибка загрузки финансов:", e); }
}

// ==========================================
// ВИДЖЕТ: ПРЕДСКАЗАНИЕ КАССОВЫХ РАЗРЫВОВ
// ==========================================
// Запрашивает прогноз с бэкенда и выводит зеленое или красное предупреждение
window.loadCashflowForecast = async function () {
    try {
        // Добавляем защиту от кэша (?_t=...), чтобы прогноз всегда был свежим
        const res = await fetch('/api/finance/cashflow-forecast?_t=' + Date.now());
        if (!res.ok) return;
        const data = await res.json();

        // Ищем первый день в будущем, когда виртуальный баланс уходит в минус
        const gapDay = data.forecast.find(day => day.projected_balance < 0);

        // Ищем на странице место для виджета
        const container = document.getElementById('cashflow-widget');
        if (!container) return; // Если контейнера нет в HTML, просто выходим

        // Рисуем логику: КРАСНЫЙ (опасность) или ЗЕЛЕНЫЙ (всё хорошо)
        if (gapDay) {
            // Форматируем дату разрыва в красивый русский формат
            const dateStr = new Date(gapDay.date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
            container.innerHTML = `
                <div style="background: #fef2f2; padding: 15px; border-radius: 8px; border: 1px solid #fca5a5; border-left: 5px solid #ef4444; animation: fadeIn 0.5s;">
                    <h4 style="margin: 0 0 5px 0; color: #b91c1c; display: flex; align-items: center; gap: 8px;">
                        <span>⚠️</span> Угроза кассового разрыва!
                    </h4>
                    <div style="font-size: 13px; color: #7f1d1d; line-height: 1.5;">
                        По прогнозу <b>${dateStr}</b> ваш баланс уйдет в минус (<b>${gapDay.projected_balance.toLocaleString('ru-RU')} ₽</b>).<br>
                        Рекомендуем ускорить сбор оплат по выставленным счетам или перенести плановые расходы на более поздний срок.
                    </div>
                </div>
            `;
        } else {
            // Ищем самую нижнюю точку баланса за месяц, чтобы понимать запас прочности
            const minBalance = Math.min(...data.forecast.map(d => d.projected_balance));
            container.innerHTML = `
                <div style="background: #f0fdf4; padding: 15px; border-radius: 8px; border: 1px solid #bbf7d0; border-left: 5px solid #22c55e; animation: fadeIn 0.5s;">
                    <h4 style="margin: 0 0 5px 0; color: #15803d; display: flex; align-items: center; gap: 8px;">
                        <span>🛡️</span> Финансы в безопасности
                    </h4>
                    <div style="font-size: 13px; color: #166534; line-height: 1.5;">
                        На ближайшие 30 дней кассовых разрывов не прогнозируется.<br>
                        Минимальный расчетный остаток в этом месяце составит: <b>${minBalance.toLocaleString('ru-RU')} ₽</b>.
                    </div>
                </div>
            `;
        }
    } catch (e) {
        console.error('Ошибка загрузки прогноза:', e);
    }
};

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

// Функция отрисовки прибыли по последним сделкам
window.renderOrderProfitability = async function () {
    try {
        const res = await fetch('/api/analytics/profitability?_t=' + Date.now());
        const orders = await res.json();

        const container = document.getElementById('profit-analysis-container');
        if (!container) return;

        if (orders.length === 0) {
            container.innerHTML = '<div style="color:gray; text-align:center; padding:10px;">Нет завершенных отгрузок для анализа</div>';
            return;
        }

        let html = '<div style="display: grid; gap: 10px; margin-top: 10px;">';
        orders.forEach(o => {
            const marginColor = o.margin > 30 ? 'var(--success)' : (o.margin > 15 ? '#f59e0b' : 'var(--danger)');
            html += `
                <div style="background: #fff; padding: 12px; border-radius: 8px; border: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center;">
                    <div style="flex: 1;">
                        <div style="font-weight: bold; font-size: 13px;">Заказ №${o.doc_number}</div>
                        <div style="font-size: 11px; color: var(--text-muted);">${o.client_name}</div>
                    </div>
                    <div style="text-align: right; flex: 1;">
                        <div style="font-weight: 800; color: var(--text-main);">${parseFloat(o.profit).toLocaleString()} ₽</div>
                        <div style="font-size: 11px; font-weight: bold; color: ${marginColor};">Рентабельность: ${o.margin}%</div>
                    </div>
                </div>
            `;
        });
        html += '</div>';
        container.innerHTML = html;
    } catch (e) { console.error(e); }
};

function renderAccounts(accounts) {
    document.getElementById('accounts-container').innerHTML = accounts.map(acc => {
        const isSelected = currentAccountFilter == acc.id;
        const borderStyle = isSelected ? 'border: 2px solid var(--primary); transform: scale(1.02); box-shadow: 0 4px 12px rgba(0,0,0,0.1); opacity: 1;' : 'border: 1px solid var(--border); opacity: 0.8;';
        const bgStyle = isSelected ? '#eff6ff' : '#fff';

        // 🪄 МАГИЯ ДИЗАЙНА: Скрываем 20-значный номер (и скобки) для красоты на плашке
        const displayName = acc.name.replace(/\s*\(?\d{20}\)?/g, '').trim();

        // Кнопка настроек
        const editButton = `<button style="background:none; border:none; cursor:pointer; font-size:14px; opacity:0.5; transition:0.2s;" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.5" onclick="event.stopPropagation(); openEditAccountModal(${acc.id}, '${acc.name.replace(/'/g, "\\'").replace(/"/g, '&quot;')}')" title="Настроить счет">⚙️</button>`;

        return `
        <div class="account-card" onclick="toggleAccountFilter(${acc.id})" style="background: ${bgStyle}; padding: 15px; border-radius: 12px; border-top: 5px solid ${acc.type === 'cash' ? '#10b981' : '#3b82f6'}; ${borderStyle} cursor: pointer; transition: 0.2s; position: relative;">
            
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px;">
                <div style="font-size: 11px; color: var(--text-muted); font-weight: bold; text-transform: uppercase;">${acc.type === 'cash' ? '💵 Наличные' : '🏦 Банковский счет'}</div>
                ${editButton} 
            </div>
            
            <div style="font-size: 16px; font-weight: bold; margin: 5px 0;" title="${acc.name}">${displayName}</div>
            <div style="font-size: 20px; font-weight: 800; color: var(--text-main);">${parseFloat(acc.balance).toLocaleString('ru-RU')} ₽</div>
        </div>`;
    }).join('');
}
window.toggleAccountFilter = function (accountId) {
    // 🛠️ ИСПРАВЛЕНИЕ: Также меняем на (==)
    currentAccountFilter = currentAccountFilter == accountId ? null : accountId;
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

        // === ДОБАВЛЕНО: Подтягиваем статус клиента из справочника ===
        const cpObj = financeCounterparties.find(c => c.id == t.counterparty_id);
        const catBadge = cpObj ? window.getCategoryBadge(cpObj.client_category) : '';

        let htmlName = t.counterparty_name
            ? `<div style="color: var(--primary); font-size: 14px; display: flex; align-items: center;">👤 ${t.counterparty_name} ${catBadge}</div>`
            : '';
        // ==============================================================

        return `
        <tr onmouseover="this.style.backgroundColor='#f1f5f9'" onmouseout="this.style.backgroundColor=''">
            <td style="text-align: center;"><input type="checkbox" class="trans-checkbox" value="${t.id}" onchange="toggleRowSelect(this)" ${isChecked}></td>
            <td style="font-weight: bold; color: var(--text-muted); font-size: 13px;">${safeDate || '-'}</td>
            <td><span class="badge" style="background: ${isIncome ? '#dcfce3' : '#fee2e2'}; color: ${isIncome ? 'var(--success)' : 'var(--danger)'};">${isIncome ? 'Поступление' : 'Списание'}</span></td>
            
            <td style="font-weight: 600;">
                ${htmlName}
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

// === ОКНО ДОБАВЛЕНИЯ ОПЕРАЦИИ ===
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
    const isCategoryExists = window.financeCategories.some(c => c.name.toLowerCase() === category.toLowerCase() && c.type === type);
    if (!isCategoryExists) {
        try {
            await fetch('/api/finance/categories', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: category, type: type })
            });
        } catch (e) { console.error("Ошибка сохранения категории", e); }
    }

    try {
        const res = await fetch('/api/transactions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount, type, category, description: desc, method, account_id, counterparty_id })
        });

        if (res.ok) {
            UI.closeModal();
            UI.toast('✅ Операция успешно сохранена', 'success');
            loadFinanceData();
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
    const tr = allTransactions.find(t => t.id === id);
    if (!tr) return;

    const accountOptions = currentAccounts.map(acc => `<option value="${acc.id}" ${tr.account_id == acc.id ? 'selected' : ''}>${acc.name}</option>`).join('');
    const cpOptions = financeCounterparties.map(cp => `<option value="${cp.id}" ${tr.counterparty_id == cp.id ? 'selected' : ''}>${cp.name}</option>`).join('');

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

            <div class="form-group">
                <label>Дата операции</label>
                <input type="datetime-local" id="edit-trans-date" class="input-modern" value="${tr.transaction_date ? tr.transaction_date.substring(0, 16) : ''}">
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
    const date = document.getElementById('edit-trans-date').value;
    const category = document.getElementById('edit-trans-category').value.trim();
    const account_id = document.getElementById('edit-trans-account').value;
    const counterparty_id = document.getElementById('edit-trans-cp').value;

    if (!amount || !description || !category) return UI.toast('Заполните сумму, основание и категорию!', 'warning');

    const isCategoryExists = window.financeCategories.some(c => c.name.toLowerCase() === category.toLowerCase() && c.type === tr.transaction_type);

    if (!isCategoryExists) {
        try {
            await fetch('/api/finance/categories', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                // 🐛 ИСПРАВЛЕНО: Ранее здесь был критический баг со сломанными переменными!
                body: JSON.stringify({ name: category, type: tr.transaction_type })
            });
            console.log(`Создана новая категория: ${category}`);
        } catch (e) { console.error("Ошибка авто-создания категории:", e); }
    }

    try {
        const res = await fetch(`/api/transactions/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ description, amount, category, account_id, counterparty_id, transaction_date: date })
        });

        if (res.ok) {
            UI.closeModal();
            UI.toast('✅ Платеж и баланс успешно обновлены', 'success');
            loadFinanceData();
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
let cpSortBy = "last_date_desc";

window.getCategoryBadge = function (category) {
    if (!category || category === 'Обычный') return '';
    let bg = '#f1f5f9', col = '#475569', icon = '';
    if (category === 'VIP') { bg = '#fef3c7'; col = '#b45309'; icon = '🌟 '; }
    if (category === 'Дилер') { bg = '#e0f2fe'; col = '#0369a1'; icon = '🤝 '; }
    if (category === 'Частые отгрузки') { bg = '#dcfce3'; col = '#166534'; icon = '📦 '; }
    if (category === 'Проблемный') { bg = '#fee2e2'; col = '#b91c1c'; icon = '⚠️ '; }
    return `<span class="badge" style="font-size: 10px; background: ${bg}; color: ${col}; margin-left: 6px; padding: 2px 6px; border-radius: 4px; border: 1px solid ${col}40;">${icon}${category}</span>`;
};

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
                <button class="btn btn-blue" onclick="openAdvancedCPCard(0)">➕ Создать</button>
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
                    <div style="font-weight: bold; font-size: 15px; color: var(--text-main); display: flex; align-items: center; justify-content: space-between; width: 100%; overflow: hidden;">
                        <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-right: 8px;" title="${c.name}">
                        ${c.name}
                        </span>
                        <span style="flex-shrink: 0;">
                            ${window.getCategoryBadge(c.client_category)}
                        </span>
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
        const customAmt = document.getElementById('fin-order-custom-amount').value;
        if (!docNum) return UI.toast('Выберите заказ из списка', 'warning');
        window.open(`/print/invoice?docNum=${docNum}&bank=${bank}&custom_amount=${customAmt}`, '_blank');
    }

    UI.closeModal();

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

window.generateInvoice = async function (cp_id) {
    const desc = document.getElementById('inv-desc').value.trim();
    const amount = document.getElementById('inv-amount').value;
    const bank = document.getElementById('inv-bank').value;
    const num = document.getElementById('inv-num').value.trim();

    if (!amount || amount <= 0) return UI.toast('Укажите корректную сумму счета!', 'error');
    if (!desc) return UI.toast('Укажите назначение платежа!', 'error');
    if (!num) return UI.toast('Укажите номер счета!', 'error');

    try {
        await fetch('/api/invoices', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cp_id, amount, desc, num })
        });
        await loadFinanceData();
    } catch (e) { console.error("Ошибка сохранения счета", e); }

    window.open(`/print/invoice?cp_id=${cp_id}&amount=${amount}&desc=${encodeURIComponent(desc)}&bank=${bank}&num=${encodeURIComponent(num)}`, '_blank');
    UI.closeModal();
};

window.markInvoicePaidModal = function (id) {
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
            UI.toast('🗑️ Счет отменен и удален', 'success');
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

let pendingBankFileText = '';

window.handleBankFileSelect = function (event) {
    const file = event.target.files[0];
    if (!file) return;

    const selectedAccountId = document.getElementById('import-account-id').value;
    if (!selectedAccountId) {
        UI.toast('Выберите счет для загрузки!', 'warning');
        event.target.value = '';
        return;
    }

    const acc = currentAccounts.find(a => String(a.id) === String(selectedAccountId));
    const selectedAccountName = acc ? acc.name : 'Выбранный счет';

    const infoDiv = document.getElementById('import-file-name');
    infoDiv.innerHTML = `Файл: <b>${file.name}</b> ⏳ Читаем...`;

    const reader = new FileReader();
    reader.readAsText(file, 'windows-1251');
    reader.onload = function (e) {
        pendingBankFileText = e.target.result;

        const match = pendingBankFileText.match(/РасчСчет=(\d+)/);
        const fileAccountNumber = match ? match[1] : 'Неизвестно';

        const accountHasAnyNumber = selectedAccountName.match(/\d{20}/);
        const isExactMatch = selectedAccountName.includes(fileAccountNumber);

        if (isExactMatch || fileAccountNumber === 'Неизвестно') {
            executeBankFilePreview();
        } else if (!accountHasAnyNumber) {
            infoDiv.innerHTML = `
                <div style="background: #eff6ff; padding: 15px; border-radius: 8px; border: 1px dashed #3b82f6; text-align: center; margin-top: 10px;">
                    <p style="margin-top: 0; color: #1e3a8a;"><b>В файле найден счет: ${fileAccountNumber}</b></p>
                    <p style="font-size: 12px; color: #475569; margin-bottom: 10px;">💡 Подсказка: добавьте этот номер в название банка (через шестеренку), чтобы проверка стала автоматической.</p>
                    <button class="btn btn-blue" style="padding: 6px 12px; font-size: 12px;" onclick="executeBankFilePreview()">✅ Это правильный банк, показать операции</button>
                </div>
            `;
        } else {
            infoDiv.innerHTML = `
                <div style="background: #fef2f2; padding: 15px; border-radius: 8px; border: 1px solid #fca5a5; text-align: center; margin-top: 10px;">
                    <h4 style="color: #dc2626; margin-top: 0;">⚠️ Внимание: Счета не совпадают!</h4>
                    <p style="font-size: 13px; color: #7f1d1d;">Вы выбрали <b>${selectedAccountName}</b>, но в файле указан <b>${fileAccountNumber}</b>.</p>
                    <div style="margin-top: 15px; display: flex; gap: 10px; justify-content: center;">
                        <button class="btn btn-outline" style="color: #dc2626; border-color: #dc2626; padding: 6px 12px; font-size: 12px;" onclick="cancelBankImportInline()">Отменить</button>
                        <button class="btn btn-blue" style="padding: 6px 12px; font-size: 12px;" onclick="executeBankFilePreview()">Все равно загрузить</button>
                    </div>
                </div>
            `;
        }
        event.target.value = '';
    };
};

window.cancelBankImportInline = function () {
    pendingBankFileText = '';
    const infoDiv = document.getElementById('import-file-name');
    if (infoDiv) infoDiv.innerHTML = `<span style="color:red">❌ Загрузка отменена. Выберите другой файл.</span>`;
};

window.executeBankFilePreview = function () {
    const infoDiv = document.getElementById('import-file-name');
    parsedBankTransactions = parse1CStatement(pendingBankFileText);

    if (parsedBankTransactions.length > 0) {
        const btn = document.getElementById('btn-process-import');
        if (btn) btn.disabled = false;

        let previewHtml = `<div style="max-height: 150px; overflow-y:auto; margin-top:10px; font-size:11px; text-align:left; background: #fff; border: 1px solid #ccc; padding: 8px; border-radius: 6px;">`;
        parsedBankTransactions.slice(0, 5).forEach(t => {
            previewHtml += `<div style="border-bottom: 1px solid #eee; margin-bottom: 4px; padding-bottom: 4px;">
                <b style="color:var(--primary);">Дата: ${t.date}</b> | Сумма: ${t.amount} ₽ <br><span style="color:gray;">${t.description.substring(0, 60)}...</span>
            </div>`;
        });
        previewHtml += `</div><small style="color:gray; font-weight:normal;">(Показаны первые 5 операций)</small>`;

        if (infoDiv) infoDiv.innerHTML = `✅ Готово! Найдено платежей: <b>${parsedBankTransactions.length}</b> ${previewHtml}`;
        UI.toast('Файл проверен, можно загружать', 'success');
    } else {
        if (infoDiv) infoDiv.innerHTML = `<span style="color:red">❌ В файле нет подходящих операций</span>`;
        UI.toast('Нет подходящих операций', 'error');
    }
};

function parse1CStatement(text) {
    const lines = text.split('\n').map(l => l.trim());
    if (lines[0] !== '1CClientBankExchange') {
        UI.toast('Это не файл выписки 1С!', 'error');
        return [];
    }

    const transactions = [];
    let currentDoc = null;
    let statementAccount = null;

    // 💡 Примечание: Если ИНН компании изменится, нужно обновить это значение!
    const myINN = '2372029123';
    const dailyTracker = {};

    for (let line of lines) {
        if (!statementAccount && line.startsWith('РасчСчет=')) {
            statementAccount = line.substring(line.indexOf('=') + 1).trim();
        }

        if (line.startsWith('СекцияДокумент=')) {
            currentDoc = {};
        } else if (line === 'КонецДокумента' && currentDoc) {
            try {
                let dSpisano = (currentDoc['ДатаСписано'] || '').trim();
                let dPostup = (currentDoc['ДатаПоступило'] || '').trim();

                if (dSpisano === '' && dPostup === '') {
                    currentDoc = null;
                    continue;
                }

                let rawDate = dSpisano !== '' ? dSpisano : dPostup;
                let formattedDate = null;
                if (rawDate !== '') {
                    const parts = rawDate.match(/\d+/g);
                    if (parts && parts.length >= 3) {
                        formattedDate = `${parts[2]}-${parts[1]}-${parts[0]} 12:00:00`;
                    }
                }

                if (currentDoc['Сумма'] && formattedDate) {
                    let type = 'income';
                    if (statementAccount && currentDoc['ПлательщикСчет'] === statementAccount) {
                        type = 'expense';
                    } else if (!statementAccount && currentDoc['ПлательщикИНН'] === myINN) {
                        type = 'expense';
                    }

                    let inn = type === 'income' ? currentDoc['ПлательщикИНН'] : currentDoc['ПолучательИНН'];
                    let name = type === 'income' ? (currentDoc['Плательщик1'] || currentDoc['Плательщик']) : (currentDoc['Получатель1'] || currentDoc['Получатель']);
                    const cleanAmount = parseFloat(currentDoc['Сумма'].replace(',', '.'));

                    const docNum = currentDoc['Номер'] || 'Б/Н';
                    let desc = `(№${docNum}) ${currentDoc['НазначениеПлатежа'] || 'Банковская операция'}`;

                    const hash = `${formattedDate}_${cleanAmount}_${desc}`;
                    if (!dailyTracker[hash]) dailyTracker[hash] = 0;
                    dailyTracker[hash]++;
                    if (dailyTracker[hash] > 1) desc += ` (Часть ${dailyTracker[hash]})`;

                    transactions.push({
                        type: type,
                        amount: cleanAmount,
                        date: formattedDate,
                        counterparty_name: name || 'Неизвестный партнер',
                        counterparty_inn: inn ? String(inn).split('/')[0].split('\\')[0].trim().substring(0, 20) : null,
                        description: desc
                    });
                }
            } catch (e) { console.error("Ошибка парсинга строки", e); }
            currentDoc = null;
        } else if (currentDoc) {
            const eqIndex = line.indexOf('=');
            if (eqIndex > -1) {
                currentDoc[line.substring(0, eqIndex).trim()] = line.substring(eqIndex + 1).trim();
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

        if (!res.ok) {
            const errText = await res.text();
            UI.toast('Ошибка сервера: ' + errText, 'error');
            btn.disabled = false;
            btn.innerText = '🚀 Загрузить операции';
            return;
        }

        const result = await res.json();
        UI.closeModal();

        let msg = `✅ Успешно загружено: ${result.count} платежей.`;
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

window.changeFinanceLimit = function () {
    currentFinanceLimit = document.getElementById('finance-limit').value;
    currentFinancePage = 1;
    loadFinanceData();
};

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
        const searchInput = document.getElementById('finance-search');
        const searchQuery = searchInput ? searchInput.value.trim() : '';

        let queryParams = new URLSearchParams();

        if (financeDateRange.start && financeDateRange.end) {
            queryParams.append('start', financeDateRange.start);
            queryParams.append('end', financeDateRange.end);
        }

        if (currentAccountFilter) {
            queryParams.append('account_id', currentAccountFilter);
        }

        if (searchQuery) {
            queryParams.append('search', searchQuery);
        }

        queryParams.append('page', 1);
        queryParams.append('limit', 100000);

        UI.toast('⏳ Подготавливаем полный отчет...', 'info');

        const res = await fetch(`/api/transactions?${queryParams.toString()}`);
        const data = await res.json();

        if (!data.data || data.data.length === 0) {
            return UI.toast('Нет данных для выгрузки', 'warning');
        }

        let csvContent = '\uFEFF';
        csvContent += 'Дата;Тип;Сумма;Контрагент;Категория;Счет;Способ оплаты;Комментарий\n';

        data.data.forEach(t => {
            const type = t.transaction_type === 'income' ? 'Поступление' : 'Списание';
            let safeDate = t.date_formatted;
            if (!safeDate && t.transaction_date) {
                const d = new Date(t.transaction_date);
                if (!isNaN(d)) safeDate = d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
            }

            const escapeCSV = (str) => `"${String(str || '').replace(/"/g, '""').replace(/\n/g, ' ')}"`;

            csvContent += `${safeDate || '-'};${type};${t.amount};${escapeCSV(t.counterparty_name)};${escapeCSV(t.category)};${escapeCSV(t.account_name)};${escapeCSV(t.payment_method)};${escapeCSV(t.description)}\n`;
        });

        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;

        const today = new Date().toISOString().split('T')[0];
        link.download = `Финансы_Плиттекс_${today}.csv`;

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
    const expenseMap = {};
    transactions.filter(t => t.transaction_type === 'expense').forEach(t => {
        expenseMap[t.category] = (expenseMap[t.category] || 0) + parseFloat(t.amount);
    });

    const catLabels = Object.keys(expenseMap);
    const catValues = Object.values(expenseMap);

    if (chartFlow) chartFlow.destroy();
    if (chartCategories) chartCategories.destroy();

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
        openPaymentCalendarModal();
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
        const res = await fetch(`/api/counterparties/${id}/profile?_t=${Date.now()}`);
        if (!res.ok) throw new Error('Ошибка загрузки');
        const data = await res.json();
        const cp = data.info;

        const transHtml = data.transactions.map(t => `
            <div style="display: flex; justify-content: space-between; padding: 10px; border-bottom: 1px solid var(--border); font-size: 13px;">
                <div><b style="color:var(--text-main);">${t.date}</b><br><span style="color:var(--text-muted);">${t.category}</span></div>
                <div style="text-align: right; width: 50%;">${t.description}</div>
                <div style="font-weight: bold; color: ${t.transaction_type === 'income' ? 'var(--success)' : 'var(--danger)'}">
                    ${t.transaction_type === 'income' ? '+' : '-'}${parseFloat(t.amount).toLocaleString('ru-RU')} ₽
                </div>
            </div>
        `).join('') || '<div style="padding:15px; text-align:center; color:gray;">Операций нет</div>';

        const invHtml = data.invoices.map(i => `
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 10px; border-bottom: 1px solid var(--border); font-size: 13px;">
                <div><b>Счет №${i.invoice_number}</b> от ${i.date}<br><span style="color: gray;">${i.description}</span></div>
                <div style="font-weight: bold;">${parseFloat(i.amount).toLocaleString('ru-RU')} ₽</div>
                <div><span class="badge" style="background: ${i.status === 'paid' ? '#dcfce3' : '#fef3c7'}; color: ${i.status === 'paid' ? '#166534' : '#b45309'};">${i.status === 'paid' ? 'Оплачен' : 'Ожидает'}</span></div>
            </div>
        `).join('') || '<div style="padding:15px; text-align:center; color:gray;">Счетов нет</div>';

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
                            <div style="display: flex; gap: 5px;">
                                 <button class="btn btn-outline" style="padding: 4px 8px; font-size: 12px;" onclick="openAdvancedCPCard(${cp.id})">✏️ Изменить</button>
                                 <button class="btn btn-outline" style="padding: 4px 8px; font-size: 12px; color: var(--danger); border-color: var(--danger);" onclick="deleteCounterparty(${cp.id})">🗑️ Удалить</button>
                            </div>
                        </div>
                        <h3 style="margin: 0 0 10px 0; display: flex; align-items: center;">${cp.name} ${window.getCategoryBadge(cp.client_category)}</h3>
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

                    <h4 style="margin: 0 0 10px 0;">📄 Документы и корректировки</h4>
                    <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; margin-bottom: 20px;">
                        <button class="btn btn-outline" style="border-color: #f59e0b; color: #d97706; font-size: 13px; padding: 6px;" onclick="openFinanceInvoiceModal(${cp.id}, '${cp.name.replace(/'/g, "\\'").replace(/"/g, '&quot;')}')">🖨️ Выставить Счет</button>
                        <button class="btn btn-outline" style="border-color: #3b82f6; color: #2563eb; font-size: 13px; padding: 6px;" onclick="window.open('/print/act?cp_id=${cp.id}', '_blank')">📑 Акт сверки</button>
                        <button class="btn btn-outline" style="border-color: #8b5cf6; color: #8b5cf6; font-size: 13px; padding: 6px; font-weight: bold;" onclick="openCorrectionModal(${cp.id})">⚖️ Коррекция</button>
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

window.deleteContract = function (contractId, cpId) {
    const html = `
        <div style="padding: 15px; text-align: center; font-size: 15px;">
            Вы уверены, что хотите удалить этот договор?<br>
            <small style="color: var(--danger);">Все привязанные к нему спецификации также будут удалены!</small>
        </div>`;

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
            openCounterpartyProfile(cpId);
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

window.executePlannedExpense = function (id, amount) {
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
            loadFinanceData();
            openPaymentCalendarModal();
        } else {
            const err = await res.text();
            UI.toast('Ошибка: ' + err, 'error');
        }
    } catch (e) {
        console.error(e);
        UI.toast('Ошибка связи с сервером', 'error');
    }
};

window.openEditAccountModal = function (id, currentName) {
    const html = `
        <div style="padding: 10px; text-align: left;">
            <div class="form-group">
                <label style="font-weight: bold; color: var(--text-main);">Название счета (кассы):</label>
                <input type="text" id="edit-account-name" class="input-modern" value="${currentName}" style="margin-top: 5px;">
                <small style="color: gray; display: block; margin-top: 5px;">
                    💡 Если это расчетный счет, добавьте в скобках его 20-значный номер для умного импорта выписок (например: Точка Банк (407028...)).
                </small>
            </div>
        </div>
    `;

    UI.showModal('⚙️ Настройка счета', html, `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-blue" onclick="saveAccountName(${id})">💾 Сохранить</button>
    `);
};

window.saveAccountName = async function (id) {
    const newName = document.getElementById('edit-account-name').value.trim();
    if (!newName) return UI.toast('Название не может быть пустым', 'warning');

    try {
        const res = await fetch(`/api/accounts/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: newName })
        });

        if (res.ok) {
            UI.closeModal();
            UI.toast('✅ Название счета обновлено', 'success');
            loadFinanceData();
        } else {
            UI.toast('Ошибка при сохранении', 'error');
        }
    } catch (e) {
        console.error(e);
        UI.toast('Ошибка сети', 'error');
    }
};

window.openAdvancedCPCard = async function (id = 0) {
    try {
        let cp = { id: 0, name: '', role: 'Покупатель', client_category: 'Обычный', inn: '', kpp: '', ogrn: '', legal_address: '', fact_address: '', bank_name: '', bank_bik: '', bank_account: '', bank_corr: '', director_name: '', phone: '', email: '', comment: '' };
        let fin = { balance: 0, total_paid_to_us: 0, total_paid_to_them: 0 };

        if (id > 0) {
            const res = await fetch(`/api/counterparties/${id}/full`);
            if (res.ok) {
                const data = await res.json();
                cp = data.cp;
                fin = data.finances;
            }
        }

        const balanceColor = fin.balance > 0 ? 'var(--success)' : (fin.balance < 0 ? 'var(--danger)' : 'var(--text-main)');
        const balanceText = fin.balance > 0 ? 'Нам должны' : (fin.balance < 0 ? 'Мы должны' : 'Расчеты закрыты');

        const html = `
            <style>
                .cp-tabs { display: flex; border-bottom: 1px solid var(--border); margin-bottom: 15px; }
                .cp-tab { padding: 10px 15px; cursor: pointer; font-weight: bold; color: var(--text-muted); border-bottom: 2px solid transparent; transition: 0.2s; }
                .cp-tab:hover { color: var(--primary); }
                .cp-tab.active { color: var(--primary); border-bottom: 2px solid var(--primary); }
                .cp-content { display: none; }
                .cp-content.active { display: block; animation: fadeIn 0.3s; }
                .cp-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 15px; }
            </style>

            ${id > 0 ? `
            <div style="background: #f8fafc; padding: 15px; border-radius: 8px; border: 1px solid var(--border); margin-bottom: 20px; display: flex; justify-content: space-between; align-items: center;">
                <div>
                    <div style="font-size: 12px; color: var(--text-muted);">Текущее сальдо:</div>
                    <div style="font-size: 20px; font-weight: 900; color: ${balanceColor};">${Math.abs(fin.balance).toLocaleString('ru-RU')} ₽ <span style="font-size: 12px; font-weight: normal;">(${balanceText})</span></div>
                </div>
                <div style="text-align: right;">
                    <div style="font-size: 12px; color: var(--text-muted);">Оплат от него: <b style="color: var(--text-main);">${parseFloat(fin.total_paid_to_us).toLocaleString('ru-RU')} ₽</b></div>
                    <div style="font-size: 12px; color: var(--text-muted);">Оплат ему: <b style="color: var(--text-main);">${parseFloat(fin.total_paid_to_them).toLocaleString('ru-RU')} ₽</b></div>
                </div>
            </div>` : ''}

            <div class="cp-tabs">
                <div class="cp-tab active" onclick="switchCPTab('main')">Основное</div>
                <div class="cp-tab" onclick="switchCPTab('reqs')">Банк и Реквизиты</div>
                <div class="cp-tab" onclick="switchCPTab('contacts')">Контакты</div>
                <div class="cp-tab" onclick="switchCPTab('comment')">Заметки</div>
            </div>

            <div id="tab-main" class="cp-content active">
                <div class="cp-grid">
                    <div class="form-group">
                        <label>Краткое наименование <b style="color:red">*</b></label>
                        <input type="text" id="cp-name" class="input-modern" value="${cp.name || ''}" placeholder="ООО Ромашка">
                    </div>
                    <div class="form-group">
                        <label>Роль</label>
                        <select id="cp-role" class="input-modern">
                            <option value="Покупатель" ${cp.role === 'Покупатель' ? 'selected' : ''}>Покупатель</option>
                            <option value="Поставщик" ${cp.role === 'Поставщик' ? 'selected' : ''}>Поставщик</option>
                        </select>
                    </div>
                </div>
                
                <div class="cp-grid">
                    <div class="form-group">
                        <label>ИНН</label>
                        <div style="display: flex; gap: 5px;">
                            <input type="text" id="cp-inn" class="input-modern" value="${cp.inn || ''}" style="flex: 1;">
                            <button class="btn btn-outline" style="padding: 0 10px; color: var(--primary); border-color: var(--primary);" onclick="autofillByINN()" title="Заполнить по ИНН">🔍</button>
                        </div>
                    </div>
                    <div class="form-group">
                        <label>КПП</label>
                        <input type="text" id="cp-kpp" class="input-modern" value="${cp.kpp || ''}">
                    </div>
                </div>

                <div class="form-group">
                    <label>Статус / Категория клиента</label>
                    <select id="cp-category" class="input-modern" style="font-weight: bold;">
                        <option value="Обычный" ${cp.client_category === 'Обычный' ? 'selected' : ''}>👤 Обычный</option>
                        <option value="VIP" ${cp.client_category === 'VIP' ? 'selected' : ''}>🌟 VIP-клиент</option>
                        <option value="Дилер" ${cp.client_category === 'Дилер' ? 'selected' : ''}>🤝 Дилер</option>
                        <option value="Частые отгрузки" ${cp.client_category === 'Частые отгрузки' ? 'selected' : ''}>📦 Частые отгрузки</option>
                        <option value="Проблемный" ${cp.client_category === 'Проблемный' ? 'selected' : ''}>⚠️ Проблемный (Должник)</option>
                    </select>
                </div>
            </div>

            <div id="tab-reqs" class="cp-content">
                <div class="form-group" style="margin-bottom: 15px;">
                    <label>ОГРН</label>
                    <input type="text" id="cp-ogrn" class="input-modern" value="${cp.ogrn || ''}">
                </div>
                <div class="form-group" style="margin-bottom: 15px;">
                    <label>Название банка</label>
                    <input type="text" id="cp-bank" class="input-modern" value="${cp.bank_name || ''}">
                </div>
                <div class="cp-grid">
                    <div class="form-group">
                        <label>БИК</label>
                        <input type="text" id="cp-bik" class="input-modern" value="${cp.bank_bik || ''}">
                    </div>
                    <div class="form-group">
                        <label>Корр. счет</label>
                        <input type="text" id="cp-corr" class="input-modern" value="${cp.bank_corr || ''}">
                    </div>
                </div>
                <div class="form-group">
                    <label>Расчетный счет</label>
                    <input type="text" id="cp-account" class="input-modern" value="${cp.bank_account || ''}">
                </div>
            </div>

            <div id="tab-contacts" class="cp-content">
                <div class="form-group" style="margin-bottom: 15px;">
                    <label>ФИО Контактного лица / Директора</label>
                    <input type="text" id="cp-director" class="input-modern" value="${cp.director_name || ''}">
                </div>
                <div class="cp-grid">
                    <div class="form-group">
                        <label>Телефон</label>
                        <input type="text" id="cp-phone" class="input-modern" value="${cp.phone || ''}">
                    </div>
                    <div class="form-group">
                        <label>Email</label>
                        <input type="text" id="cp-email" class="input-modern" value="${cp.email || ''}">
                    </div>
                </div>
                <div class="form-group" style="margin-bottom: 15px;">
                    <label>Юридический адрес</label>
                    <input type="text" id="cp-address" class="input-modern" value="${cp.legal_address || ''}">
                </div>
                <div class="form-group">
                    <label>Фактический адрес</label>
                    <input type="text" id="cp-fact-address" class="input-modern" value="${cp.fact_address || ''}">
                </div>
            </div>

            <div id="tab-comment" class="cp-content">
                <div class="form-group">
                    <label>Внутренний комментарий (виден только вам)</label>
                    <textarea id="cp-comment" class="input-modern" style="height: 120px; resize: vertical;">${cp.comment || ''}</textarea>
                </div>
            </div>
        `;

        UI.showModal(`👔 ${id > 0 ? 'Карточка контрагента' : 'Новый контрагент'}`, html, `
            <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
            <button class="btn btn-blue" onclick="saveAdvancedCP(${id})">💾 Сохранить карточку</button>
        `);
    } catch (e) { console.error(e); UI.toast('Ошибка загрузки', 'error'); }
};

window.switchCPTab = function (tabName) {
    document.querySelectorAll('.cp-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.cp-content').forEach(c => c.classList.remove('active'));
    event.target.classList.add('active');
    document.getElementById(`tab-${tabName}`).classList.add('active');
};

window.saveAdvancedCP = async function (id) {
    const payload = {
        name: document.getElementById('cp-name').value.trim(),
        role: document.getElementById('cp-role').value,
        client_category: document.getElementById('cp-category').value,
        inn: document.getElementById('cp-inn').value.trim(),
        kpp: document.getElementById('cp-kpp').value.trim(),
        ogrn: document.getElementById('cp-ogrn').value.trim(),
        legal_address: document.getElementById('cp-address').value.trim(),
        fact_address: document.getElementById('cp-fact-address').value.trim(),
        bank_name: document.getElementById('cp-bank').value.trim(),
        bank_bik: document.getElementById('cp-bik').value.trim(),
        bank_account: document.getElementById('cp-account').value.trim(),
        bank_corr: document.getElementById('cp-corr').value.trim(),
        director_name: document.getElementById('cp-director').value.trim(),
        phone: document.getElementById('cp-phone').value.trim(),
        email: document.getElementById('cp-email').value.trim(),
        comment: document.getElementById('cp-comment').value.trim()
    };

    if (!payload.name) return UI.toast('Введите название!', 'warning');

    const method = id > 0 ? 'PUT' : 'POST';
    const url = id > 0 ? `/api/counterparties/${id}` : '/api/counterparties';

    try {
        const res = await fetch(url, {
            method: method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (res.ok) {
            UI.closeModal();
            UI.toast('✅ Карточка сохранена', 'success');
            if (typeof loadFinanceData === 'function') {
                await loadFinanceData();
            }
            openCounterpartiesModal();
        } else {
            const errorData = await res.json();
            UI.toast('Ошибка базы: ' + (errorData.error || 'Сбой на сервере'), 'error');
            console.error("Детали ошибки сервера:", errorData);
        }
    } catch (e) {
        console.error("Сбой сети:", e);
        UI.toast('Ошибка сети. Проверьте консоль.', 'error');
    }
};

window.autofillByINN = async function () {
    const inn = document.getElementById('cp-inn').value.trim();
    if (!inn || (inn.length !== 10 && inn.length !== 12)) return UI.toast('Введите корректный ИНН (10 или 12 цифр)', 'warning');

    UI.toast('🔍 Ищем в базе ФНС через сервер...', 'info');
    try {
        const res = await fetch("/api/dadata/inn", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ inn: inn })
        });

        if (!res.ok) {
            if (res.status === 401 || res.status === 403) return UI.toast('DaData: Проблема с API-ключом на сервере', 'error');
            return UI.toast('DaData: Ошибка сервера ' + res.status, 'error');
        }

        const data = await res.json();

        if (data.suggestions && data.suggestions.length > 0) {
            const org = data.suggestions[0].data;
            document.getElementById('cp-name').value = data.suggestions[0].value || '';
            document.getElementById('cp-kpp').value = org.kpp || '';
            document.getElementById('cp-ogrn').value = org.ogrn || '';
            document.getElementById('cp-address').value = org.address ? org.address.value : '';
            if (org.management && org.management.name) document.getElementById('cp-director').value = org.management.name;
            UI.toast('✅ Реквизиты успешно заполнены!', 'success');
        } else {
            UI.toast('Контрагент по ИНН не найден', 'warning');
        }
    } catch (e) {
        console.error("Ошибка при обращении к прокси DaData:", e);
        UI.toast('Внутренняя ошибка системы', 'error');
    }
};

window.openCorrectionModal = function (cpId) {
    const html = `
        <div class="form-group" style="margin-bottom: 15px;">
            <label>Дата корректировки:</label>
            <input type="date" id="corr-date" class="input-modern" value="${new Date().toISOString().split('T')[0]}">
        </div>
        <div class="form-group" style="margin-bottom: 15px;">
            <label>Тип корректировки (Отношение к нам):</label>
            <select id="corr-type" class="input-modern" style="font-weight: bold;">
                <option value="income">📈 Клиент должен нам (+ Увеличить его долг)</option>
                <option value="expense">📉 Мы должны клиенту (+ Увеличить наш долг)</option>
            </select>
        </div>
        <div class="form-group" style="margin-bottom: 15px;">
            <label>Сумма корректировки (₽):</label>
            <input type="number" id="corr-amount" class="input-modern" placeholder="Например: 50000" style="font-size: 18px;">
        </div>
        <div class="form-group">
            <label>Комментарий (Отобразится в Акте сверки):</label>
            <input type="text" id="corr-desc" class="input-modern" value="Ввод начальных остатков">
        </div>
    `;
    UI.showModal('⚖️ Корректировка сальдо', html, `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-blue" onclick="executeCorrection(${cpId})">💾 Применить корректировку</button>
    `);
};

window.executeCorrection = async function (cpId) {
    const amount = parseFloat(document.getElementById('corr-amount').value);
    const type = document.getElementById('corr-type').value;
    const date = document.getElementById('corr-date').value;
    const desc = document.getElementById('corr-desc').value.trim();

    if (!amount || amount <= 0) return UI.toast('Укажите корректную сумму', 'warning');

    try {
        const res = await fetch(`/api/counterparties/${cpId}/correction`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount, type, date, description: desc })
        });
        if (res.ok) {
            UI.toast('✅ Баланс успешно скорректирован!', 'success');
            openCounterpartyProfile(cpId);
            loadFinanceData();
        } else {
            UI.toast('Ошибка при сохранении', 'error');
        }
    } catch (e) { UI.toast('Ошибка сети', 'error'); }
};

// ==========================================
// ГЛОБАЛЬНОЕ СОСТОЯНИЕ (МНОГОПОЛЬЗОВАТЕЛЬСКОЕ)
// ==========================================
// Эти параметры живут в браузере (каждый пользователь может смотреть свой период)
let taxYear = new Date().getFullYear();
let taxPeriodType = 'month';
let taxPeriodValue = new Date().getMonth() + 1;
let currentTaxTab = 'bank';
let currentTaxFilter = 'all';

// Эти параметры будут загружаться из базы данных сервера!
let taxUsnRate = 3;
let taxBankCorrection = 0;
let taxCashCorrection = 0;
let rawTaxData = null;

// Загрузка локальных периодов (чтобы не сбрасывался месяц при F5)
window.loadLocalPeriods = function () {
    const saved = localStorage.getItem('erp_tax_periods');
    if (saved) {
        const s = JSON.parse(saved);
        if (s.taxYear) taxYear = s.taxYear;
        if (s.taxPeriodType) taxPeriodType = s.taxPeriodType;
        if (s.taxPeriodValue) taxPeriodValue = s.taxPeriodValue;
    }
};
window.saveLocalPeriods = function () {
    localStorage.setItem('erp_tax_periods', JSON.stringify({ taxYear, taxPeriodType, taxPeriodValue }));
};
loadLocalPeriods();

// ==========================================
// ЛОГИКА ВЫБОРА ПЕРИОДОВ
// ==========================================
window.changeTaxPeriodType = function () {
    taxPeriodType = document.getElementById('tax-period-type').value;
    if (taxPeriodType === 'quarter') taxPeriodValue = Math.floor(new Date().getMonth() / 3) + 1;
    else if (taxPeriodType === 'month') taxPeriodValue = new Date().getMonth() + 1;
    saveLocalPeriods();
    applyTaxPeriod();
};

window.applyTaxPeriod = async function () {
    taxPeriodType = document.getElementById('tax-period-type').value;
    const valEl = document.getElementById('tax-period-value');
    if (valEl && taxPeriodType !== 'all' && taxPeriodType !== 'year') taxPeriodValue = parseInt(valEl.value);
    const yearEl = document.getElementById('tax-period-year');
    if (yearEl && taxPeriodType !== 'all') taxYear = parseInt(yearEl.value);

    saveLocalPeriods();
    await loadTaxPiggyBank();
    if (document.getElementById('tax-modal-body')) renderTaxModalContent();
};

// ==========================================
// ВЗАИМОДЕЙСТВИЕ С СЕРВЕРОМ (БАЗОЙ ДАННЫХ)
// ==========================================
// Получаем глобальные настройки с сервера перед загрузкой виджета
window.fetchGlobalTaxSettings = async function () {
    try {
        const res = await fetch('/api/finance/tax-settings');
        const settings = await res.json();
        if (settings.tax_usn_rate) taxUsnRate = parseFloat(settings.tax_usn_rate);
        if (settings.tax_bank_correction) taxBankCorrection = parseFloat(settings.tax_bank_correction);
        if (settings.tax_cash_correction) taxCashCorrection = parseFloat(settings.tax_cash_correction);
    } catch (e) { console.error("Ошибка загрузки настроек:", e); }
};

// Отправка клика по галочке "Исключить" на сервер
window.toggleTaxExclusion = async function (id, el) {
    const isExcluded = !el.checked; // Если галочка снята, значит операция исключена
    await fetch('/api/finance/tax-status', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: id, field: 'tax_excluded', is_checked: isExcluded })
    });
    // Перезагружаем данные с сервера, чтобы учесть изменения
    await loadTaxPiggyBank();
    renderTaxModalContent();
};

// Отправка клика по галочке "Принудительный НДС" на сервер
window.toggleForceVat = async function (id, el) {
    const isForce = el.checked;
    await fetch('/api/finance/tax-status', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: id, field: 'tax_force_vat', is_checked: isForce })
    });
    // Если мы принудительно включили НДС, нужно убедиться, что операция не "Исключена"
    if (isForce) {
        await fetch('/api/finance/tax-status', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: id, field: 'tax_excluded', is_checked: false })
        });
    }
    await loadTaxPiggyBank();
    renderTaxModalContent();
};

// Отправка корректировок на сервер
window.updateTaxCorrection = async function (val) {
    const numVal = parseFloat(val) || 0;
    const key = currentTaxTab === 'bank' ? 'tax_bank_correction' : 'tax_cash_correction';

    if (currentTaxTab === 'bank') taxBankCorrection = numVal;
    else taxCashCorrection = numVal;

    await fetch('/api/finance/tax-settings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: key, value: numVal })
    });
    renderTaxModalContent();
    renderTaxWidgetUI();
};

// Отправка ставки УСН на сервер
window.updateUsnRate = async function (val) {
    taxUsnRate = parseFloat(val) || 0;
    await fetch('/api/finance/tax-settings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'tax_usn_rate', value: taxUsnRate })
    });
    await loadTaxPiggyBank();
    renderTaxModalContent();
};

// ==========================================
// ⚡ ЕДИНЫЙ КАЛЬКУЛЯТОР ЖИВЫХ ДАННЫХ
// ==========================================
window.calculateLiveTax = function () {
    if (!rawTaxData) return { cashTax: 0, bankVat: 0, total: 0, cashTurnover: 0, vatIn: 0, vatOut: 0 };
    let liveVatIn = 0, liveVatOut = 0, liveCashTax = 0, liveCashTurnover = 0;

    rawTaxData.bank.transactions.forEach(t => {
        if (t.tax_excluded) return; // Читаем из базы!
        const forceVat = t.tax_force_vat; // Читаем из базы!
        let tax = t.calculated_tax;
        if (forceVat && t.is_no_vat) tax = (parseFloat(t.amount) * 22) / 122;

        if (!t.is_no_vat || forceVat) {
            if (t.transaction_type === 'income') liveVatIn += tax;
            else liveVatOut += tax;
        }
    });

    rawTaxData.cash.transactions.forEach(t => {
        if (t.tax_excluded) return; // Читаем из базы!
        if (t.transaction_type === 'income') {
            liveCashTurnover += parseFloat(t.amount);
            liveCashTax += t.calculated_tax;
        }
    });

    const finalBank = (liveVatIn - liveVatOut) + taxBankCorrection;
    const finalCash = liveCashTax + taxCashCorrection;
    return { cashTax: finalCash, bankVat: finalBank, total: Math.max(0, finalBank) + Math.max(0, finalCash), cashTurnover: liveCashTurnover, vatIn: liveVatIn, vatOut: liveVatOut };
};

// ==========================================
// ОТРИСОВКА ВИДЖЕТА НА ГЛАВНОЙ СТРАНИЦЕ
// ==========================================
window.renderTaxWidgetUI = function () {
    const container = document.getElementById('tax-widget-container');
    if (!container || !rawTaxData) return;

    // ⚡ Берем данные не из базы, а из живого калькулятора!
    const live = calculateLiveTax();

    let typeOptions = `
        <option value="month" ${taxPeriodType === 'month' ? 'selected' : ''}>Месяц</option>
        <option value="quarter" ${taxPeriodType === 'quarter' ? 'selected' : ''}>Квартал</option>
        <option value="year" ${taxPeriodType === 'year' ? 'selected' : ''}>Год</option>
        <option value="all" ${taxPeriodType === 'all' ? 'selected' : ''}>Всё время</option>
    `;
    let valOptions = '';
    if (taxPeriodType === 'quarter') {
        for (let i = 1; i <= 4; i++) valOptions += `<option value="${i}" ${taxPeriodValue == i ? 'selected' : ''}>${i} Квартал</option>`;
    } else if (taxPeriodType === 'month') {
        const months = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
        months.forEach((m, i) => valOptions += `<option value="${i + 1}" ${taxPeriodValue == i + 1 ? 'selected' : ''}>${m}</option>`);
    }
    let yearOptions = '';
    const currentY = new Date().getFullYear();
    for (let y = currentY - 2; y <= currentY + 1; y++) yearOptions += `<option value="${y}" ${taxYear == y ? 'selected' : ''}>${y} год</option>`;

    const periodHtml = `
        <select id="tax-period-type" class="input-modern" style="padding: 4px 6px; font-size: 11px; margin-right: 4px;" onchange="changeTaxPeriodType()">${typeOptions}</select>
        ${taxPeriodType !== 'all' && taxPeriodType !== 'year' ? `<select id="tax-period-value" class="input-modern" style="padding: 4px 6px; font-size: 11px; margin-right: 4px;" onchange="applyTaxPeriod()">${valOptions}</select>` : ''}
        ${taxPeriodType !== 'all' ? `<select id="tax-period-year" class="input-modern" style="padding: 4px 6px; font-size: 11px;" onchange="applyTaxPeriod()">${yearOptions}</select>` : ''}
    `;

    container.innerHTML = `
        <div style="background: #fff; padding: 20px; border-radius: 12px; border: 1px solid var(--border); box-shadow: var(--shadow-sm);">
            <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 15px;">
                <div>
                    <div style="font-size: 11px; font-weight: 800; color: #8b5cf6; text-transform: uppercase;">🏦 Налоговый резерв</div>
                    <div style="font-size: 28px; font-weight: 900; color: #1e1b4b; margin-top: 4px; white-space: nowrap;">${live.total.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 0 })} ₽</div>
                </div>
                <div id="tax-period-controls" style="display: flex; gap: 3px;" class="no-print">
                    ${periodHtml}
                </div>
            </div>

            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; border-top: 1px solid #f1f5f9; padding-top: 15px;">
                <div style="cursor: pointer; padding: 10px; border-radius: 8px; transition: 0.2s;" onmouseover="this.style.background='#f8fafc'" onmouseout="this.style.background='transparent'" onclick="openTaxDetailsModal('cash')">
                    <div style="font-size: 10px; color: var(--text-muted);">Касса (УСН ${taxUsnRate}%):</div>
                    <div style="font-size: 16px; font-weight: bold; color: #10b981; white-space: nowrap;">+${Math.max(0, live.cashTax).toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 0 })} ₽</div>
                    <div style="font-size: 9px; color: #8b5cf6; margin-top: 4px;">Аналитика УСН ➔</div>
                </div>
                <div style="cursor: pointer; padding: 10px; border-radius: 8px; transition: 0.2s;" onmouseover="this.style.background='#f8fafc'" onmouseout="this.style.background='transparent'" onclick="openTaxDetailsModal('bank')">
                    <div style="font-size: 10px; color: var(--text-muted);">Безнал (Оперативный НДС):</div>
                    <div style="font-size: 16px; font-weight: bold; color: #3b82f6; white-space: nowrap;">${live.bankVat > 0 ? '+' : ''}${Math.max(0, live.bankVat).toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 0 })} ₽</div>
                    <div style="font-size: 9px; color: #8b5cf6; margin-top: 4px;">Аналитика НДС ➔</div>
                </div>
            </div>
        </div>
    `;
};

window.loadTaxPiggyBank = async function () {
    await fetchGlobalTaxSettings();
    try {
        const params = new URLSearchParams();
        let start = '', end = '';

        if (taxPeriodType === 'year') {
            start = `${taxYear}-01-01`; end = `${taxYear}-12-31`;
        } else if (taxPeriodType === 'quarter') {
            const startMonth = (taxPeriodValue - 1) * 3 + 1;
            start = `${taxYear}-${String(startMonth).padStart(2, '0')}-01`;
            const endDay = new Date(taxYear, startMonth + 2, 0).getDate();
            end = `${taxYear}-${String(startMonth + 2).padStart(2, '0')}-${endDay}`;
        } else if (taxPeriodType === 'month') {
            start = `${taxYear}-${String(taxPeriodValue).padStart(2, '0')}-01`;
            const endDay = new Date(taxYear, taxPeriodValue, 0).getDate();
            end = `${taxYear}-${String(taxPeriodValue).padStart(2, '0')}-${endDay}`;
        }

        if (start && end) { params.append('start', start); params.append('end', end); }
        params.append('usn_rate', taxUsnRate);
        params.append('_t', Date.now());

        const res = await fetch(`/api/finance/tax-piggy-bank?${params.toString()}`);
        if (!res.ok) return;
        rawTaxData = await res.json();

        renderTaxWidgetUI(); // Вызываем отрисовку
    } catch (e) { console.error("Ошибка копилки:", e); }
};

// ==========================================
// УПРАВЛЕНИЕ МОДАЛЬНЫМ ОКНОМ
// ==========================================
window.openTaxDetailsModal = function (tab = 'bank') {
    currentTaxTab = tab;
    const html = `<style>.modal-content { max-width: 1200px !important; width: 95% !important; }</style><div id="tax-modal-body"></div>`;
    // Кнопка просто закрывает окно, так как плашка теперь обновляется в реальном времени!
    UI.showModal('📊 Оперативный налоговый учет', html, `<button class="btn btn-blue" onclick="UI.closeModal();">Готово</button>`);
    renderTaxModalContent();
};

window.switchTaxTab = function (tab) { currentTaxTab = tab; currentTaxFilter = 'all'; renderTaxModalContent(); };
window.setTaxFilter = function (filter) { currentTaxFilter = filter; renderTaxModalContent(); };

// ==========================================
// ОТПРАВКА ГАЛОЧЕК НА СЕРВЕР (В БАЗУ ДАННЫХ)
// ==========================================

window.toggleTaxExclusion = async function (id, el) {
    // Если галочка "Учитывать" снята, значит операция Исключена (true)
    const isExcluded = !el.checked;

    // 1. Отправляем изменение прямо в базу данных
    await fetch('/api/finance/tax-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: id, field: 'tax_excluded', is_checked: isExcluded })
    });

    // 2. Скачиваем свежие расчеты с сервера и перерисовываем интерфейс
    await loadTaxPiggyBank();
    renderTaxModalContent();
};

window.toggleForceVat = async function (id, el) {
    const isForce = el.checked;

    // 1. Отправляем в базу статус "Принудительный НДС"
    await fetch('/api/finance/tax-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: id, field: 'tax_force_vat', is_checked: isForce })
    });

    // 2. Логика защиты: если включили НДС принудительно, операция точно не должна быть "Исключена"
    if (isForce) {
        await fetch('/api/finance/tax-status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: id, field: 'tax_excluded', is_checked: false })
        });
    }

    // 3. Обновляем данные с сервера
    await loadTaxPiggyBank();
    renderTaxModalContent();
};

window.updateTaxCorrection = function (val) {
    if (currentTaxTab === 'bank') taxBankCorrection = parseFloat(val) || 0;
    else taxCashCorrection = parseFloat(val) || 0;
    renderTaxModalContent();
    renderTaxWidgetUI();
};

window.updateUsnRate = async function (val) {
    taxUsnRate = parseFloat(val) || 0;
    await loadTaxPiggyBank();
    renderTaxModalContent();
};

window.renderTaxModalContent = function () {
    if (!rawTaxData) return;

    const dataObj = currentTaxTab === 'bank' ? rawTaxData.bank : rawTaxData.cash;
    const live = calculateLiveTax(); // Берем обсчитанные данные

    // ⚡ ИСПРАВЛЕНИЕ 1: Считаем количество исключенных операций прямо из данных сервера
    const excludedCount = dataObj.transactions.filter(t => t.tax_excluded).length;

    const filteredRows = dataObj.transactions.filter(t => {
        const isExcluded = t.tax_excluded; // Читаем из БД
        const isIncome = t.transaction_type === 'income';

        if (currentTaxFilter === 'excluded') return isExcluded;
        if (isExcluded) return false;
        if (currentTaxFilter === 'income' && !isIncome) return false;
        if (currentTaxFilter === 'expense' && isIncome) return false;
        return true;
    });

    const tableRows = filteredRows.map(t => {
        const isIncome = t.transaction_type === 'income';
        const isExcluded = t.tax_excluded; // Читаем из БД
        const forceVat = t.tax_force_vat;  // Читаем из БД

        let currentCalculatedTax = t.calculated_tax;
        if (currentTaxTab === 'bank' && forceVat && t.is_no_vat) {
            currentCalculatedTax = (parseFloat(t.amount) * 22) / 122;
        }

        let taxDisplay = '';
        if (currentTaxTab === 'bank' && t.is_no_vat && !forceVat) {
            taxDisplay = `<span style="background: #e2e8f0; color: #475569; padding: 2px 6px; border-radius: 4px; font-size: 10px;">Без НДС</span>`;
        } else {
            const taxSign = isIncome ? '+' : '-';
            const taxColor = isIncome ? '#ef4444' : '#10b981';
            taxDisplay = `<span style="color: ${taxColor}; font-weight: bold; white-space: nowrap;">${taxSign}${currentCalculatedTax.toLocaleString('ru-RU', { minimumFractionDigits: 2 })} ₽</span>`;
        }

        let controlsHtml = `
            <label style="display: flex; align-items: center; gap: 4px; font-size: 11px; cursor: pointer; color: #475569;">
                <input type="checkbox" ${isExcluded ? '' : 'checked'} onchange="toggleTaxExclusion(${t.id}, this)"> Учитывать
            </label>
        `;
        if (currentTaxTab === 'bank') {
            controlsHtml += `
                <label style="display: flex; align-items: center; gap: 4px; font-size: 10px; cursor: pointer; margin-top: 6px; color: #b45309;">
                    <input type="checkbox" ${forceVat ? 'checked' : ''} onchange="toggleForceVat(${t.id}, this)"> + НДС 22%
                </label>
            `;
        }

        return `
            <tr style="border-bottom: 1px solid #f1f5f9; ${isExcluded ? 'opacity: 0.5; background: #fafafa;' : ''}">
                <td style="padding: 10px; min-width: 90px;">${controlsHtml}</td>
                <td style="padding: 10px; white-space: nowrap;">${new Date(t.transaction_date).toLocaleDateString('ru-RU')}</td>
                <td style="padding: 10px;"><b>${t.category}</b></td>
                <td style="padding: 10px; max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${t.description}">${t.description}</td>
                <td style="padding: 10px; text-align: right; font-weight: bold; color: ${isIncome ? 'var(--success)' : 'var(--text-main)'}; white-space: nowrap;">${isIncome ? '+' : '-'}${parseFloat(t.amount).toLocaleString()}</td>
                <td style="padding: 10px; text-align: right;">${taxDisplay}</td>
            </tr>
        `;
    }).join('');

    let rightPanelHtml = '';

    if (currentTaxTab === 'bank') {
        const deductionPercent = live.vatIn > 0 ? (live.vatOut / live.vatIn) * 100 : 0;
        let trafficColor = '#10b981', trafficText = 'Безопасная зона';
        if (deductionPercent > 89) { trafficColor = '#ef4444'; trafficText = 'Высокий риск ФНС (Вычеты > 89%)'; }
        else if (deductionPercent > 86) { trafficColor = '#f59e0b'; trafficText = 'Внимание (Близко к порогу)'; }

        rightPanelHtml = `
            <div style="font-size: 11px; text-transform: uppercase; color: gray; font-weight: bold; margin-bottom: 10px;">Оперативный НДС (22%)</div>
            <div style="margin-bottom: 15px;">
                <div style="display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 5px;">
                    <span>Доля вычетов:</span><span style="font-weight: bold; color: ${trafficColor};">${deductionPercent.toFixed(1)}%</span>
                </div>
                <div style="height: 6px; background: #e2e8f0; border-radius: 3px; overflow: hidden;"><div style="height: 100%; width: ${Math.min(deductionPercent, 100)}%; background: ${trafficColor};"></div></div>
                <div style="font-size: 10px; color: ${trafficColor}; margin-top: 4px;">${trafficText}</div>
            </div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 13px; gap: 10px;">
                <span style="line-height: 1.2;">Начислено с доходов:</span><span style="font-weight: bold; white-space: nowrap; flex-shrink: 0;">+ ${live.vatIn.toLocaleString('ru-RU', { minimumFractionDigits: 0 })} ₽</span>
            </div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 15px; font-size: 13px; gap: 10px;">
                <span style="line-height: 1.2;">Вычеты с расходов:</span><span style="font-weight: bold; color: #10b981; white-space: nowrap; flex-shrink: 0;">- ${live.vatOut.toLocaleString('ru-RU', { minimumFractionDigits: 0 })} ₽</span>
            </div>
            <div style="margin-bottom: 20px;">
                <label style="font-size: 11px; color: gray;">+/- Корректировка (вычеты прошлых периодов):</label>
                <input type="number" class="input-modern" style="width: 100%; box-sizing: border-box; padding: 4px 8px; font-size: 13px; margin-top: 4px;" value="${taxBankCorrection}" onchange="updateTaxCorrection(this.value)">
            </div>
            <div style="border-top: 2px solid #e2e8f0; padding-top: 15px;">
                <div style="font-size: 12px; font-weight: bold; color: var(--text-muted);">ИТОГО НДС К УПЛАТЕ:</div>
                <div style="font-size: 26px; font-weight: 900; color: #1e1b4b; margin-top: 5px; white-space: nowrap;">${Math.max(0, live.bankVat).toLocaleString('ru-RU', { minimumFractionDigits: 0 })} ₽</div>
            </div>
        `;
    } else {
        rightPanelHtml = `
            <div style="font-size: 11px; text-transform: uppercase; color: gray; font-weight: bold; margin-bottom: 15px;">Учет УСН (Касса)</div>
            
            <div style="background: #fff; padding: 15px; border-radius: 8px; border: 1px solid #e2e8f0; margin-bottom: 20px;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; font-size: 13px; gap: 10px;">
                    <span style="color: var(--text-muted); line-height: 1.2;">Всего доходов (База):</span>
                    <span style="font-weight: bold; color: var(--text-main); font-size: 16px; white-space: nowrap; flex-shrink: 0;">${live.cashTurnover.toLocaleString('ru-RU')} ₽</span>
                </div>
                <div style="display: flex; justify-content: space-between; align-items: center; border-top: 1px dashed #e2e8f0; padding-top: 10px;">
                    <span style="font-size: 13px; font-weight: bold;">Текущая ставка налога:</span>
                    <div style="display: flex; align-items: center; gap: 5px;">
                        <input type="number" class="input-modern" style="width: 70px; padding: 4px; text-align: center; font-weight: bold;" value="${taxUsnRate}" step="0.5" onchange="updateUsnRate(this.value)">
                        <span style="font-weight: bold; font-size: 15px;">%</span>
                    </div>
                </div>
            </div>

            <div style="display: flex; justify-content: space-between; margin-bottom: 15px; font-size: 13px; gap: 10px;">
                <span style="line-height: 1.2;">Налог с доходов:</span>
                <span style="font-weight: bold; color: #ef4444; white-space: nowrap; flex-shrink: 0;">+ ${(live.cashTax).toLocaleString('ru-RU', { minimumFractionDigits: 0 })} ₽</span>
            </div>
            <div style="margin-bottom: 20px;">
                <label style="font-size: 11px; color: gray;">- Корректировка (Например, страховые взносы):</label>
                <input type="number" class="input-modern" style="width: 100%; box-sizing: border-box; padding: 4px 8px; font-size: 13px; margin-top: 4px;" value="${taxCashCorrection}" onchange="updateTaxCorrection(this.value)" placeholder="-15000">
            </div>
            <div style="border-top: 2px solid #e2e8f0; padding-top: 15px;">
                <div style="font-size: 12px; font-weight: bold; color: var(--text-muted);">ИТОГО УСН К УПЛАТЕ:</div>
                <div style="font-size: 26px; font-weight: 900; color: #1e1b4b; margin-top: 5px; white-space: nowrap;">${Math.max(0, live.cashTax).toLocaleString('ru-RU', { minimumFractionDigits: 0 })} ₽</div>
            </div>
        `;
    }

    const bodyHtml = `
        <div style="display: flex; gap: 20px;">
            <div style="flex: 3; background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 15px;">
                <div style="display: flex; gap: 10px; border-bottom: 1px solid var(--border); padding-bottom: 10px; margin-bottom: 15px;">
                    <button class="btn ${currentTaxTab === 'bank' ? 'btn-blue' : 'btn-outline'}" onclick="switchTaxTab('bank')">🏦 Банки (НДС 22%)</button>
                    <button class="btn ${currentTaxTab === 'cash' ? 'btn-blue' : 'btn-outline'}" onclick="switchTaxTab('cash')">💵 Касса (УСН)</button>
                    <button class="btn btn-outline" style="margin-left: auto; border-color: #10b981; color: #10b981;" onclick="exportTaxToExcel()">📥 Выгрузить реестр</button>
                </div>
                <div style="display: flex; gap: 5px; margin-bottom: 10px;">
                    <button class="btn ${currentTaxFilter === 'all' ? 'btn-gray' : 'btn-outline'}" style="padding: 4px 10px; font-size: 11px;" onclick="setTaxFilter('all')">Все операции</button>
                    <button class="btn ${currentTaxFilter === 'income' ? 'btn-gray' : 'btn-outline'}" style="padding: 4px 10px; font-size: 11px;" onclick="setTaxFilter('income')">⬇️ Доходы</button>
                    <button class="btn ${currentTaxFilter === 'expense' ? 'btn-gray' : 'btn-outline'}" style="padding: 4px 10px; font-size: 11px;" onclick="setTaxFilter('expense')">⬆️ Расходы</button>
                    <button class="btn ${currentTaxFilter === 'excluded' ? 'btn-gray' : 'btn-outline'}" style="padding: 4px 10px; font-size: 11px; margin-left: auto;" onclick="setTaxFilter('excluded')">🚫 Исключенные (${excludedCount})</button>
                </div>
                <div style="max-height: 450px; overflow-y: auto; border: 1px solid #e2e8f0; border-radius: 6px;">
                    <table style="width: 100%; border-collapse: collapse; font-size: 12px;">
                        <thead style="background: #f8fafc; position: sticky; top: 0; box-shadow: 0 1px 0 #e2e8f0; z-index: 10;">
                            <tr>
                                <th style="padding: 8px; text-align: left;">Управление</th>
                                <th style="padding: 8px; text-align: left;">Дата</th>
                                <th style="padding: 8px; text-align: left;">Категория</th>
                                <th style="padding: 8px; text-align: left;">Назначение</th>
                                <th style="padding: 8px; text-align: right;">Сумма операции</th>
                                <th style="padding: 8px; text-align: right;">Влияние на налог</th>
                            </tr>
                        </thead>
                        <tbody>${tableRows || '<tr><td colspan="6" style="padding:20px; text-align:center; color:gray;">Ничего не найдено</td></tr>'}</tbody>
                    </table>
                </div>
            </div>
            <div style="flex: 1; background: #f8fafc; border: 1px solid var(--border); border-radius: 8px; padding: 20px;">
                ${rightPanelHtml}
            </div>
        </div>
    `;

    document.getElementById('tax-modal-body').innerHTML = bodyHtml;
};

// Функция выгрузки в Excel 
window.exportTaxToExcel = function () {
    if (!rawTaxData) return;
    const dataObj = currentTaxTab === 'bank' ? rawTaxData.bank : rawTaxData.cash;
    let csvContent = '\uFEFF';
    csvContent += 'Режим;Дата;Категория;Назначение;Тип;Сумма;Налог;Статус\n';

    dataObj.transactions.forEach(t => {
        // ⚡ ИСПРАВЛЕНИЕ 2: Читаем галочки из базы данных, а не из старой памяти!
        const isExcluded = t.tax_excluded;
        const forceVat = t.tax_force_vat;

        if (currentTaxFilter === 'excluded' && !isExcluded) return;
        if (currentTaxFilter !== 'excluded' && isExcluded) return;
        if (currentTaxFilter === 'income' && t.transaction_type !== 'income') return;
        if (currentTaxFilter === 'expense' && t.transaction_type === 'expense') return;

        const escapeCSV = (str) => `"${String(str || '').replace(/"/g, '""').replace(/\n/g, ' ')}"`;
        const mode = currentTaxTab === 'bank' ? 'НДС 22%' : `УСН ${taxUsnRate}%`;
        const typeStr = t.transaction_type === 'income' ? 'Приход' : 'Расход';
        const status = isExcluded ? 'Исключено' : 'В расчете';

        let taxVal = t.calculated_tax;
        if (currentTaxTab === 'bank') {
            if (t.is_no_vat && !forceVat) taxVal = 'Без НДС';
            else if (forceVat && t.is_no_vat) taxVal = ((parseFloat(t.amount) * 22) / 122).toFixed(2);
            else taxVal = taxVal.toFixed(2);
        } else {
            taxVal = taxVal.toFixed(2);
        }

        csvContent += `${mode};${new Date(t.transaction_date).toLocaleDateString('ru-RU')};${escapeCSV(t.category)};${escapeCSV(t.description)};${typeStr};${t.amount};${taxVal};${status}\n`;
    });

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `Налоговый_Реестр_${currentTaxTab}_${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    UI.toast('✅ Реестр успешно выгружен', 'success');
};