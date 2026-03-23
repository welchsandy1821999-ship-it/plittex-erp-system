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
let currentTransTypeFilter = 'all';
let financeLockDate = null;
let financeDatePicker = null;
let currentFinanceRange = { start: '', end: '' };

async function initFinance() {
    const dateInput = document.getElementById('finance-date-filter');
    if (dateInput && typeof flatpickr !== 'undefined') {
        financeDatePicker = flatpickr(dateInput, {
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
                    financeDateRange.start = '';
                    financeDateRange.end = '';
                    currentFinancePage = 1;
                    loadFinanceData();
                }
            }
        });
    }
    loadFinanceData();
}

window.setFinanceDateRange = function (type) {
    if (!financeDatePicker) return;
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
    financeDatePicker.setDate([start, end], true);
};

// Функция сброса:
window.resetFinanceFilter = function () {
    // 1. Блокируем случайные таймеры поиска
    clearTimeout(financeSearchTimer);

    // 2. Очищаем текстовое поле ПЕРВЫМ делом
    const searchInput = document.getElementById('finance-search');
    if (searchInput) {
        searchInput.value = '';
    }

    // 3. Сбрасываем табы "Доход/Расход/Все"
    currentTransTypeFilter = 'all';
    document.querySelectorAll('.type-tab-btn').forEach(btn => {
        btn.classList.remove('btn-blue', 'btn-outline-success', 'btn-outline-danger');
        btn.classList.add('btn-outline');
    });
    const tabAll = document.getElementById('tab-type-all');
    if (tabAll) {
        tabAll.classList.remove('btn-outline');
        tabAll.classList.add('btn-blue');
    }

    // 4. Сбрасываем плашки счетов (используем твой новый класс account-card-modern)
    currentAccountFilter = null;
    document.querySelectorAll('.account-card-modern').forEach(card => {
        card.classList.remove('selected');
    });

    // 5. Сбрасываем даты через наш новый глобальный календарь
    // ВАЖНО: clear() у календаря автоматически вызовет loadFinanceData(), 
    // подхватив уже очищенные фильтры из шагов 2-4!
    financeDateRange = { start: '', end: '' };
    currentFinancePage = 1;

    if (typeof financeDatePicker !== 'undefined' && financeDatePicker) {
        financeDatePicker.clear(); // 👈 Это действие само запустит загрузку данных
    } else {
        loadFinanceData(); // Если календаря почему-то нет, грузим вручную
    }
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

        if (currentTransTypeFilter && currentTransTypeFilter !== 'all') {
            queryParams.append('type', currentTransTypeFilter);
        }

        queryParams.append('page', currentFinancePage);
        queryParams.append('limit', currentFinanceLimit); // Передаем лимит

        // 🚀 ИСПРАВЛЕНИЕ: Добавляем метку времени в параметры поиска транзакций
        const timestamp = Date.now();
        queryParams.append('_t', timestamp);

        const queryStr = `?${queryParams.toString()}`;

        // 🚀 ИСПРАВЛЕНИЕ: Теперь плашки знают, какой счет выбран!
        let reportQueryParams = new URLSearchParams();
        if (financeDateRange.start && financeDateRange.end) {
            reportQueryParams.append('start', financeDateRange.start);
            reportQueryParams.append('end', financeDateRange.end);
        }
        if (currentAccountFilter) {
            reportQueryParams.append('account_id', currentAccountFilter); // Передаем ID счета
        }
        reportQueryParams.append('_t', timestamp);

        let accUrl = `/api/accounts?_t=${timestamp}`;
        if (financeDateRange.end) {
            accUrl += `&end=${financeDateRange.end}`;
        }

        const [reportRes, transRes, accRes, catRes, cpRes, invRes] = await Promise.all([
            fetch(`/api/report/finance?${reportQueryParams.toString()}`), // Умный запрос плашек
            fetch(`/api/transactions${queryStr}`),
            fetch(accUrl),
            fetch(`/api/finance/categories?_t=${timestamp}`),
            fetch(`/api/counterparties?_t=${timestamp}`),
            fetch(`/api/invoices?_t=${timestamp}`)
        ]);

        const reportData = await reportRes.json();
        const transData = await transRes.json();

        allTransactions = transData.data;

        // 🚀 ИСПРАВЛЕНИЕ: Читаем данные из объекта pagination, который прислал сервер
        if (transData.pagination) {
            financeTotalPages = transData.pagination.totalPages;
            currentFinancePage = transData.pagination.page;

            // Обновляем текст пагинации
            const pageInfo = document.getElementById('finance-page-info');
            if (pageInfo) {
                pageInfo.innerHTML = `Страница <b>${currentFinancePage}</b> из <b>${financeTotalPages}</b> (Всего: ${transData.pagination.total})`;
            }

            // Блокируем кнопки, если мы на первой или последней странице
            const btnPrev = document.getElementById('finance-btn-prev');
            const btnNext = document.getElementById('finance-btn-next');
            if (btnPrev) btnPrev.disabled = (currentFinancePage <= 1);
            if (btnNext) btnNext.disabled = (currentFinancePage >= financeTotalPages);
        }

        currentAccounts = await accRes.json();
        window.financeCategories = await catRes.json();
        financeCounterparties = await cpRes.json();
        financeInvoices = await invRes.json();
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
window.loadCashflowForecast = async function () {
    try {
        const res = await fetch('/api/finance/cashflow-forecast?_t=' + Date.now());
        if (!res.ok) return;
        const data = await res.json();

        const gapDay = data.forecast.find(day => day.projected_balance < 0);
        const container = document.getElementById('cashflow-widget');
        if (!container) return;

        if (gapDay) {
            const dateStr = new Date(gapDay.date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
            container.innerHTML = `
                <div style="background: var(--danger-bg); padding: 15px; border-radius: 8px; border: 1px solid var(--danger-border); border-left: 5px solid var(--danger); animation: fadeIn 0.5s;">
                    <h4 style="margin: 0 0 5px 0; color: var(--danger-text); display: flex; align-items: center; gap: 8px;">
                        <span>⚠️</span> Угроза кассового разрыва!
                    </h4>
                    <div style="font-size: 13px; color: var(--text-main); line-height: 1.5;">
                        По прогнозу <b>${dateStr}</b> ваш баланс уйдет в минус (<b>${gapDay.projected_balance.toLocaleString('ru-RU')} ₽</b>).<br>
                        Рекомендуем ускорить сбор оплат по выставленным счетам или перенести плановые расходы на более поздний срок.
                    </div>
                </div>
            `;
        } else {
            const minBalance = Math.min(...data.forecast.map(d => d.projected_balance));
            container.innerHTML = `
                <div style="background: var(--success-bg); padding: 15px; border-radius: 8px; border: 1px solid var(--success-border); border-left: 5px solid var(--success); animation: fadeIn 0.5s;">
                    <h4 style="margin: 0 0 5px 0; color: var(--success-text); display: flex; align-items: center; gap: 8px;">
                        <span>🛡️</span> Финансы в безопасности
                    </h4>
                    <div style="font-size: 13px; color: var(--text-main); line-height: 1.5;">
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
        <div class="summary-card office">
            <div class="summary-title">ОБЩИЙ ДОХОД</div>
            <div class="summary-value" style="color: var(--success);">+${totalIncome.toLocaleString()} ₽</div>
        </div>
        <div class="summary-card security">
            <div class="summary-title">ОБЩИЙ РАСХОД</div>
            <div class="summary-value" style="color: var(--danger);">-${totalExpense.toLocaleString()} ₽</div>
        </div>
        <div class="summary-card ${profit >= 0 ? 'total' : 'security'}">
            <div class="summary-title">${profit >= 0 ? 'ОБЩАЯ ПРИБЫЛЬ' : 'УБЫТОК ПЕРИОДА'}</div>
            <div class="summary-value">${profit > 0 ? '+' : ''}${profit.toLocaleString()} ₽</div>
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
            container.innerHTML = '<div style="color:var(--text-muted); text-align:center; padding:10px;">Нет завершенных отгрузок для анализа</div>';
            return;
        }

        let html = '<div style="display: grid; gap: 10px; margin-top: 10px;">';
        orders.forEach(o => {
            const marginColor = o.margin > 30 ? 'var(--success)' : (o.margin > 15 ? 'var(--warning)' : 'var(--danger)');
            html += `
                <div style="background: var(--surface); padding: 12px; border-radius: 8px; border: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center;">
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
        const displayName = acc.name.replace(/\s*\(?\d{20}\)?/g, '').trim();
        const borderTopColor = acc.type === 'cash' ? 'var(--success)' : 'var(--primary)';

        return `
        <div class="account-card-modern ${isSelected ? 'selected' : ''}" 
             onclick="toggleAccountFilter(${acc.id})" 
             style="border-top: 5px solid ${borderTopColor};">
            
            <div class="flex-between mb-5">
                <div style="font-size: 10px; color: var(--text-muted); font-weight: 800; text-transform: uppercase;">
                    ${acc.type === 'cash' ? '💵 Наличные' : '🏦 Банк'}
                </div>
                <button class="btn-close" style="font-size: 14px; opacity: 0.5;" 
                        onclick="event.stopPropagation(); openEditAccountModal(${acc.id}, '${escapeHTML(acc.name)}')" title="Настроить">⚙️</button>
            </div>
            
            <div style="font-size: 15px; font-weight: bold; margin: 5px 0;" title="${acc.name}">${displayName}</div>
            <div style="font-size: 18px; font-weight: 800; color: var(--text-main);">${parseFloat(acc.balance).toLocaleString('ru-RU')} ₽</div>
        </div>`;
    }).join('');
}

window.toggleAccountFilter = function (accountId) {
    // 🛡️ БЛОКИРОВКА: Если кликнули по уже выбранному счету — ничего не делаем
    if (currentAccountFilter == accountId) {
        return;
    }

    currentAccountFilter = accountId;
    currentFinancePage = 1;
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
        const transDateStr = t.transaction_date ? t.transaction_date.substring(0, 10) : '';
        const isLocked = financeLockDate && transDateStr && transDateStr <= financeLockDate;

        // 🛡️ Умное и безопасное форматирование даты (защита от сдвига часовых поясов)
        let safeDate = "-";
        if (t.transaction_date) {
            const d = new Date(t.transaction_date);
            if (!isNaN(d)) {
                // Проверяем, есть ли у операции точное время (ручная) или только дата (импорт 1С)
                const hasTime = d.getHours() > 0 || d.getMinutes() > 0;
                const options = { day: '2-digit', month: '2-digit', year: 'numeric' };
                if (hasTime) {
                    options.hour = '2-digit';
                    options.minute = '2-digit';
                }
                safeDate = d.toLocaleDateString('ru-RU', options);
            }
        }

        let receiptHtml = t.receipt_url
            ? `<a href="${t.receipt_url}" target="_blank" style="text-decoration:none; font-size:16px;" title="Смотреть документ">📄</a>
               <button class="btn btn-outline" style="border:none; padding:2px; font-size:12px; color: var(--danger);" onclick="deleteReceipt(${t.id})" title="Удалить файл">✖</button>`
            : `<label style="cursor:pointer; font-size:16px;" title="Прикрепить файл">📎
                   <input type="file" style="display:none;" onchange="uploadReceipt(${t.id}, this)">
               </label>`;

        const cpObj = financeCounterparties.find(c => c.id == t.counterparty_id);
        const catBadge = cpObj ? window.getCategoryBadge(cpObj.client_category) : '';

        let htmlName = t.counterparty_name
            ? `<div style="color: var(--primary); font-size: 14px; display: flex; align-items: center;">👤 ${escapeHTML(t.counterparty_name)} ${catBadge}</div>`
            : '';

        return `
        <tr>
            <td style="text-align: center;">
                ${isLocked ? '<span title="Период закрыт">🔒</span>' : `<input type="checkbox" class="trans-checkbox" value="${t.id}" onchange="toggleRowSelect(this)" ${isChecked}>`}
            </td>
            <td style="font-weight: bold; color: var(--text-muted); font-size: 13px;">${safeDate}</td>
            <td><span class="badge" style="background: ${isIncome ? 'var(--success-bg)' : 'var(--danger-bg)'}; color: ${isIncome ? 'var(--success-text)' : 'var(--danger-text)'};">${isIncome ? 'Поступление' : 'Списание'}</span></td>
            
            <td style="font-weight: 600;">
                ${htmlName}
                <div style="font-size: 12px; color: var(--text-muted);">${escapeHTML(t.category)}</div>
            </td>
            
            <td style="color: var(--text-muted); font-size: 13px;">
                ${escapeHTML(t.description || '-')}
                <span style="font-size: 11px; color: ${t.account_name ? 'var(--primary)' : 'var(--text-muted)'}; font-weight: bold; display: block; margin-top: 3px;">
                    ${t.account_name ? `🏦 ${escapeHTML(t.account_name)}` : '⚖️ Без движения денег (Корректировка)'}
                </span>
            </td>
            <td style="font-size: 13px;">${t.payment_method}</td>
            <td style="text-align: right; font-weight: bold; font-size: 15px; color: ${isIncome ? 'var(--success)' : 'var(--text-main)'};">${isIncome ? '+' : '-'}${parseFloat(t.amount).toLocaleString('ru-RU')} ₽</td>
            <td style="text-align: center; display: flex; gap: 5px; justify-content: center; align-items: center;">
                ${receiptHtml}
                ${isLocked ?
                `<span style="font-size: 11px; color: var(--text-muted); font-weight: bold; background: var(--surface-alt); padding: 4px 8px; border-radius: 4px;">Заблокировано</span>`
                :
                `<button class="btn btn-outline" style="padding: 4px 8px; font-size: 12px; border-color: var(--primary); color: var(--primary);" onclick="openEditTransactionModal(${t.id})" title="Редактировать">✏️</button>
            <button class="btn btn-outline" style="padding: 4px 8px; font-size: 12px; border-color: var(--danger); color: var(--danger);" onclick="deleteTransaction(${t.id})" title="Удалить">❌</button>`
            }
            </td>
        </tr>`;
    }).join('');
}

// 1. Удаление транзакции
window.deleteTransaction = function (id) {
    const html = `<div style="padding: 15px; text-align: center; font-size: 15px;">Вы уверены, что хотите удалить эту операцию?<br><small style="color: var(--text-muted);">Баланс счета будет автоматически пересчитан.</small></div>`;
    UI.showModal('⚠️ Удаление операции', html, `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-red" onclick="executeDeleteTransaction(${id})">🗑️ Да, удалить</button>
    `);
};

window.executeDeleteTransaction = async function (id) {
    UI.closeModal();
    try {
        const res = await fetch(`/api/transactions/${id}`, { method: 'DELETE' });
        if (res.ok) {
            UI.toast('🗑️ Операция удалена', 'success');
            loadFinanceData();
        } else {
            // Читаем системную блокировку с бэкенда и показываем красным
            const errData = await res.json();
            UI.toast(errData.error || 'Ошибка при удалении', 'error');
        }
    } catch (e) {
        UI.toast('Ошибка связи с сервером', 'error');
    }
};

window.openCategoriesModal = function () {
    let listHtml = window.financeCategories.map(c => `
        <div style="display: flex; justify-content: space-between; padding: 8px; border-bottom: 1px solid var(--border);">
            <span>${c.type === 'income' ? '🟢' : '🔴'} ${c.name}</span>
            <button onclick="deleteCategory(${c.id})" style="color: var(--danger); border: none; background: none; cursor:pointer;">❌</button>
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
        <button class="btn btn-red" onclick="executeDeleteCategory(${id})">🗑️ Удалить</button>
    `);
};
window.executeDeleteCategory = async function (id) {
    UI.closeModal();
    await fetch(`/api/finance/categories/${id}`, { method: 'DELETE' });
    await loadFinanceData();
    openCategoriesModal();
};

window.autoSwitchPaymentMethod = function (accId) {
    const acc = currentAccounts.find(a => a.id == accId);
    const methodSelect = document.getElementById('trans-method');
    if (acc && methodSelect) {
        // Если тип счета 'cash' (Касса) -> ставим Наличные. Иначе -> Безнал.
        if (acc.type === 'cash') {
            methodSelect.value = 'Наличные (Касса)';
        } else {
            methodSelect.value = 'Безналичный расчет';
        }
    }
};

// --- ФУНКЦИЯ ПОДСТАНОВКИ КАТЕГОРИИ ---
window.autoFillCategory = async function (counterpartyName) {
    if (!counterpartyName) return;

    // 1. Ищем контрагента по имени в уже загруженном списке
    const cp = financeCounterparties.find(c => c.name === counterpartyName);

    // Если не нашли (например, вписали руками нового, которого еще нет в базе) - ничего не делаем
    if (!cp || !cp.id) return;

    try {
        // 2. Отправляем запрос на бэкенд уже с правильным ID
        const response = await fetch(`/api/finance/last-category?counterparty_id=${cp.id}`);
        const data = await response.json();

        if (data.category) {
            const categorySelect = document.getElementById('trans-category');
            if (categorySelect) {
                categorySelect.value = data.category;

                // Радостно мигаем зеленым
                categorySelect.style.transition = 'background-color 0.3s';
                categorySelect.style.backgroundColor = 'var(--success-bg)';
                setTimeout(() => { categorySelect.style.backgroundColor = ''; }, 800);
            }
        }
    } catch (e) {
        console.error('Не удалось определить категорию', e);
    }
};

// === ОКНО ДОБАВЛЕНИЯ ОПЕРАЦИИ ===
window.openTransactionModal = function () {
    const accountOptions = currentAccounts.map(acc => `<option value="${acc.id}" ${currentAccountFilter === acc.id ? 'selected' : ''}>${acc.name} (${parseFloat(acc.balance).toLocaleString()} ₽)</option>`).join('');
    const cpOptionsList = financeCounterparties.map(cp => `<option value="${cp.name}">`).join('');

    const html = `
        <div class="form-grid" style="grid-template-columns: 1fr 1fr;">
            <div class="form-group" style="grid-column: span 2;">
                <label>Тип операции:</label>
                <select id="trans-type" class="input-modern" style="font-size: 15px; font-weight: bold;" onchange="updateCategoryList()">
                    <option value="expense">🔴 Расход (Списание денег)</option>
                    <option value="income">🟢 Доход (Поступление денег)</option>
                </select>
            </div>
            
            <div class="form-group" style="background: var(--surface-alt); padding: 10px; border-radius: 6px; border: 1px dashed var(--border);">
                <label style="font-weight: bold;">Сумма (₽):</label>
                <input type="number" id="trans-amount" class="input-modern" style="font-size: 18px; font-weight: bold;" placeholder="0">
            </div>
            
            <div class="form-group" style="background: var(--surface-alt); padding: 10px; border-radius: 6px; border: 1px dashed var(--border);">
                <label style="font-weight: bold; color: var(--primary);">Счет (Откуда/Куда):</label>
            <select id="trans-account-id" class="input-modern" style="font-size: 14px; font-weight: bold;" onchange="autoSwitchPaymentMethod(this.value)">
                 ${accountOptions}
            </select>
            </div>
            
            <div class="form-group" style="grid-column: span 2;">
                <label>Контрагент (Кому/От кого):</label>
                <input type="text" id="trans-counterparty-name" list="cp-options" class="input-modern" style="font-size: 14px;" placeholder="-- Не выбран (Внутренняя операция) --" autocomplete="off" onclick="this.value=''" onchange="autoFillCategory(this.value)">
                <datalist id="cp-options">${cpOptionsList}</datalist>
            </div>

            <div class="form-group" style="grid-column: span 2;">
                <label>Способ оплаты:</label>
                <select id="trans-method" class="input-modern" style="font-size: 14px;">
                    <option value="Наличные (Касса)">💵 Наличные</option>
                    <option value="Безналичный расчет">💳 Безналичный расчет (Счет)</option>
                    <option value="Перевод на карту">📱 Перевод на карту директору</option>
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
    UI.showModal('➕ Добавление операции', html, `<button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button><button class="btn btn-blue" onclick="saveTransaction(this)">💾 Сохранить</button>`);
    updateCategoryList();
    autoSwitchPaymentMethod(document.getElementById('trans-account-id').value);
};

// Сама функция переключения
window.setTransTypeFilter = function (type) {
    currentTransTypeFilter = type;

    // 1. Сбрасываем синий цвет со всех кнопок (делаем их прозрачными)
    document.querySelectorAll('.type-tab-btn').forEach(btn => {
        btn.classList.remove('btn-blue');
        btn.classList.add('btn-outline');
    });

    // 2. Красим нажатую кнопку в синий цвет
    const activeBtn = document.getElementById('tab-type-' + type);
    if (activeBtn) {
        activeBtn.classList.remove('btn-outline');
        activeBtn.classList.add('btn-blue');
    }

    // 3. Сбрасываем страницу на первую и загружаем новые данные
    currentFinancePage = 1;
    loadFinanceData();
};

window.autoSwitchPaymentMethod = function (accId) {
    const acc = currentAccounts.find(a => a.id == accId);
    const methodSelect = document.getElementById('trans-method');
    if (acc && methodSelect) {
        if (acc.type === 'cash') methodSelect.value = 'Наличные (Касса)';
        else methodSelect.value = 'Безналичный расчет';
    }
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

window.saveTransaction = async function (btnElement) {
    if (btnElement) btnElement.disabled = true; // 🛡️ Блокируем кнопку от двойного клика

    const type = document.getElementById('trans-type').value;
    const amount = parseFloat(document.getElementById('trans-amount').value);
    const method = document.getElementById('trans-method').value;
    const category = document.getElementById('trans-category').value.trim();
    const desc = document.getElementById('trans-desc').value.trim();
    const account_id = document.getElementById('trans-account-id').value;
    const cpNameInput = document.getElementById('trans-counterparty-name').value.trim();
    let counterparty_id = null;

    if (cpNameInput) {
        const foundCp = financeCounterparties.find(c => c.name.toLowerCase() === cpNameInput.toLowerCase());
        if (foundCp) {
            counterparty_id = foundCp.id;
        } else {
            if (btnElement) btnElement.disabled = false;
            return UI.toast('Контрагент не найден. Выберите из списка!', 'warning');
        }
    }

    if (!amount || amount <= 0) {
        if (btnElement) btnElement.disabled = false;
        return UI.toast('Введите сумму!', 'error');
    }
    if (!desc) {
        if (btnElement) btnElement.disabled = false;
        return UI.toast('Обязательно укажите основание/комментарий!', 'error');
    }
    if (!category) {
        if (btnElement) btnElement.disabled = false;
        return UI.toast('Укажите категорию!', 'error');
    }

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
    } finally {
        if (btnElement) btnElement.disabled = false; // 🛡️ Разблокируем кнопку после ответа
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

    // 1. Формируем список счетов
    const accountOptions = `
        <option value="">-- ⚖️ Без движения денег (Корректировка) --</option>
        ${currentAccounts.map(acc => `
            <option value="${acc.id}" ${tr.account_id == acc.id ? 'selected' : ''}>
                ${acc.name}
            </option>`).join('')}
    `;

    // 2. Умный список контрагентов (datalist)
    const cpOptionsList = financeCounterparties.map(cp => `<option value="${cp.name.replace(/"/g, '&quot;')}">`).join('');
    const currentCp = financeCounterparties.find(cp => cp.id == tr.counterparty_id);
    const currentCpName = currentCp ? currentCp.name : '';

    // 3. ВОССТАНОВЛЕННЫЕ СТРОЧКИ: Формируем список категорий (catOptions)
    const filteredCats = window.financeCategories.filter(c => c.type === tr.transaction_type);
    const catOptions = filteredCats.map(c => `<option value="${c.name.replace(/"/g, '&quot;')}">`).join('');

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
                <input type="text" id="edit-trans-cp-name" list="edit-cp-options" class="input-modern"
                       value="${currentCpName.replace(/"/g, '&quot;')}" placeholder="-- Внутренняя операция --" autocomplete="off" onclick="this.value=''">
                <datalist id="edit-cp-options">${cpOptionsList}</datalist>
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
    const cpNameInput = document.getElementById('edit-trans-cp-name').value.trim();
    let counterparty_id = null;

    if (cpNameInput) {
        const foundCp = financeCounterparties.find(c => c.name.toLowerCase() === cpNameInput.toLowerCase());
        if (foundCp) {
            counterparty_id = foundCp.id;
        } else {
            return UI.toast('Контрагент не найден. Выберите из списка!', 'warning');
        }
    }

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
            body: JSON.stringify({
                description,
                amount,
                category,
                account_id: account_id || null, // 🚀 ИСПРАВЛЕНИЕ: шлем null вместо ""
                counterparty_id: counterparty_id || null,
                transaction_date: date
            })
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
    let bg = 'var(--border)', col = 'var(--text-muted)', icon = '';
    if (category === 'VIP') { bg = 'var(--warning-bg)'; col = 'var(--warning-text)'; icon = '🌟 '; }
    if (category === 'Дилер') { bg = 'var(--surface-alt)'; col = 'var(--primary)'; icon = '🤝 '; }
    if (category === 'Частые отгрузки') { bg = 'var(--success-bg)'; col = 'var(--success)'; icon = '📦 '; }
    if (category === 'Проблемный') { bg = 'var(--danger-bg)'; col = 'var(--danger-text)'; icon = '⚠️ '; }
    return `<span class="badge" style="font-size: 10px; background: ${bg}; color: ${col}; margin-left: 6px; padding: 2px 6px; border-radius: 4px; border: 1px solid ${col};">${icon}${category}</span>`;
};

window.openCounterpartiesModal = function () {
    const html = `
        <style>.modal-content { max-width: 1000px !important; width: 95% !important; }</style>
        <div style="display: flex; flex-direction: column; gap: 15px;">
            <div style="background: var(--surface-alt); padding: 15px; border-radius: 12px; display: flex; flex-wrap: wrap; gap: 10px; align-items: center;">
                <div style="flex: 1; min-width: 200px;">
                    <input type="text" id="cp-search" class="input-modern" placeholder="🔍 Поиск по имени или ИНН..." 
                           oninput="updateCPList()" style="margin:0; background: var(--surface);">
                </div>
                <select id="cp-filter-type" class="input-modern" onchange="updateCPList()" style="width: auto; margin:0; background: var(--surface);">
                    <option value="all">Все типы</option>
                    <option value="Покупатель">Покупатели</option>
                    <option value="Поставщик">Поставщики</option>
                </select>
                <select id="cp-sort" class="input-modern" onchange="updateCPList()" style="width: auto; margin:0; background: var(--surface);">
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
        container.innerHTML = '<div style="text-align:center; padding: 40px; color: var(--text-muted);">Ничего не найдено</div>';
        return;
    }

    container.innerHTML = filtered.map(c => {
        const lastDate = c.last_transaction_date
            ? new Date(c.last_transaction_date).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })
            : 'Нет операций';

        return `
        <div class="cp-card" style="background: var(--surface); padding: 12px 15px; border-radius: 8px; border: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; transition: 0.2s;">  
            <div style="flex: 2; min-width: 0; padding-right: 15px;">
                <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
                    <span class="badge" style="font-size: 10px; background: ${c.type === 'Покупатель' ? 'var(--success-bg)' : 'var(--surface-alt)'}; color: ${c.type === 'Покупатель' ? 'var(--success)' : 'var(--primary)'};">
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

            <div style="flex: 1.2; text-align: center; border-left: 1px solid var(--border); border-right: 1px solid var(--border); padding: 0 10px;">
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
    const html = `<div style="padding: 15px; text-align: center; font-size: 15px;">Точно удалить этого контрагента?<br><small style="color: var(--text-muted);">Его имя пропадет из новых списков, но старая история платежей сохранится.</small></div>`;
    UI.showModal('⚠️ Удаление контрагента', html, `
        <button class="btn btn-outline" onclick="openCounterpartiesModal()">Отмена</button>
        <button class="btn btn-red" onclick="executeDeleteCounterparty(${id})">🗑️ Удалить</button>
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
                <label style="color: var(--warning-text); font-weight: bold;">Тип счета:</label>
                <select id="fin-invoice-type" class="input-modern" onchange="toggleFinInvoiceType()">
                    <option value="general">Свободный счет (Пополнение баланса / Аванс)</option>
                    <option value="order">Привязать к существующему Заказу</option>
                </select>
            </div>

            <div id="fin-general-block" style="background: var(--surface-alt); padding: 10px; border-radius: 6px; border: 1px solid var(--border);">
                <div class="form-group">
                    <label>Сумма счета (₽):</label>
                    <input type="number" id="fin-invoice-amount" class="input-modern" placeholder="Например: 150000">
                </div>
                <div class="form-group" style="margin-top: 10px;">
                    <label>Назначение платежа в счете:</label>
                    <input type="text" id="fin-invoice-desc" class="input-modern" value="Оплата за строительные материалы (аванс)">
                </div>
            </div>

            <div id="fin-order-block" style="display: none; background: var(--surface-alt); padding: 10px; border-radius: 6px; border: 1px solid var(--primary);">
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

    // 🚀 ИСПРАВЛЕНИЕ: Добавили this в вызов кнопки
    UI.showModal('Выставление счета', html, `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-blue" onclick="executeFinanceInvoice(${cpId}, this)">🖨️ Сгенерировать PDF</button>
    `);
};

window.executeFinanceInvoice = async function (cpId, btnElement) {
    if (btnElement) btnElement.disabled = true; // 🛡️ Блокируем двойной клик

    const type = document.getElementById('fin-invoice-type').value;
    const bank = document.getElementById('fin-invoice-bank').value;

    try {
        if (type === 'general') {
            const amount = document.getElementById('fin-invoice-amount').value;
            const desc = document.getElementById('fin-invoice-desc').value;

            if (!amount || amount <= 0) {
                UI.toast('Введите корректную сумму', 'warning');
                if (btnElement) btnElement.disabled = false;
                return;
            }

            // 🚀 ИСПРАВЛЕНИЕ: Генерируем номер счета и реально СОХРАНЯЕМ ЕГО В БАЗУ ДАННЫХ
            const num = `СЧ-${new Date().getTime().toString().slice(-6)}`;

            const res = await fetch('/api/invoices', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cp_id: cpId, amount, desc, num })
            });

            if (res.ok) {
                window.open(`/print/invoice?cp_id=${cpId}&amount=${amount}&desc=${encodeURIComponent(desc)}&bank=${bank}&num=${num}`, '_blank');
                UI.closeModal();
                UI.toast('✅ Счет выставлен и занесен в базу', 'success');
                if (typeof loadFinanceData === 'function') loadFinanceData();
            } else {
                UI.toast('Ошибка сохранения счета', 'error');
            }

        } else {
            const docNum = document.getElementById('fin-invoice-order').value;
            const customAmt = document.getElementById('fin-order-custom-amount').value;

            if (!docNum) {
                UI.toast('Выберите заказ из списка', 'warning');
                if (btnElement) btnElement.disabled = false;
                return;
            }
            window.open(`/print/invoice?docNum=${docNum}&bank=${bank}&custom_amount=${customAmt}`, '_blank');
            UI.closeModal();
        }
    } catch (e) {
        console.error(e);
        UI.toast('Ошибка сети', 'error');
    } finally {
        if (btnElement) btnElement.disabled = false;
    }
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

    if (!Array.isArray(financeInvoices)) {
        console.error('Ошибка данных API: ожидался массив счетов (financeInvoices), получено:', financeInvoices);
        return;
    }

    if (financeInvoices.length === 0) {
        container.style.display = 'none';
        return;
    }

    container.style.display = 'block';
    tbody.innerHTML = financeInvoices.map(inv => `
        <tr>
            <td style="font-size: 13px; color: var(--text-muted); font-weight: bold;">${inv.date_formatted}</td>
            <td style="font-weight: bold;">№ ${inv.invoice_number}</td>
            <td style="color: var(--primary); font-weight: 600;">👤 ${inv.counterparty_name}</td>
            <td style="font-size: 13px;">${inv.description}</td>
            <td style="text-align: right; font-weight: bold; font-size: 15px; color: var(--warning-text);">${parseFloat(inv.amount).toLocaleString('ru-RU')} ₽</td>
            <td style="text-align: center; display: flex; gap: 5px; justify-content: center;">
                <button class="btn btn-blue" style="padding: 4px 10px; font-size: 12px;" onclick="markInvoicePaidModal(${inv.id})" title="Подтвердить оплату от клиента">✅ Оплачен</button>
                <button class="btn btn-outline" style="padding: 4px 8px; font-size: 12px; border-color: var(--danger); color: var(--danger);" onclick="deleteInvoice(${inv.id})" title="Удалить счет">❌</button>
            </td>
        </tr>
    `).join('');
}

window.markInvoicePaidModal = function (id) {
    const options = currentAccounts.map(acc => `<option value="${acc.id}">${acc.name} (${parseFloat(acc.balance).toLocaleString()} ₽)</option>`).join('');
    const html = `
        <div class="form-group" style="background: var(--surface-alt); padding: 15px; border-radius: 8px; border: 1px dashed var(--border);">
            <label style="font-weight: bold; color: var(--primary);">На какой счет упали деньги?</label>
            <select id="pay-inv-account" class="input-modern" style="margin-top: 5px;">${options}</select>
        </div>
    `;
    UI.showModal('✅ Подтверждение оплаты счета', html, `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
       <button class="btn btn-blue" onclick="executeInvoicePay(${id}, this)">💰 Подтвердить приход</button>.
    `);
};

window.executeInvoicePay = async function (id, btnElement) {
    const account_id = document.getElementById('pay-inv-account').value;

    if (btnElement) btnElement.disabled = true; // 🛡️ Защита от двойного списания

    try {
        const res = await fetch(`/api/invoices/${id}/pay`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ account_id })
        });
        if (res.ok) {
            UI.closeModal();
            UI.toast('✅ Счет оплачен! Деньги зачислены на баланс.', 'success');
            loadFinanceData();

            // 🔄 ИСПРАВЛЕНИЕ: Дергаем глобальное событие, чтобы вкладка продаж тоже обновила долг по заказу!
            if (typeof loadActiveOrders === 'function') loadActiveOrders();

        } else {
            const errData = await res.json();
            UI.toast(errData.error || 'Ошибка проведения оплаты', 'error');
        }
    } catch (e) {
        console.error(e);
        UI.toast('Ошибка связи с сервером', 'error');
    } finally {
        if (btnElement) btnElement.disabled = false;
    }
};

window.deleteInvoice = function (id) {
    const html = `<div style="padding: 15px; text-align: center; font-size: 15px;">Точно удалить этот счет?<br><small style="color: var(--text-muted);">Он безвозвратно исчезнет из списка ожидаемых платежей.</small></div>`;
    UI.showModal('⚠️ Отмена выставленного счета', html, `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-red" onclick="executeDeleteInvoice(${id})">🗑️ Удалить счет</button>
    `);
};

window.executeDeleteInvoice = async function (id) {
    UI.closeModal();
    try {
        const res = await fetch(`/api/invoices/${id}`, { method: 'DELETE' });
        if (res.ok) {
            UI.toast('🗑️ Счет отменен и удален', 'success');
            loadFinanceData();
        } else {
            // Читаем системную ошибку с сервера и выводим на экран
            const errData = await res.json();
            UI.toast(errData.error || 'Ошибка при удалении счета', 'error');
        }
    } catch (e) {
        console.error(e);
        UI.toast('Ошибка связи с сервером', 'error');
    }
};

// ==========================================
// ИМПОРТ ВЫПИСКИ 1С (ПАРСЕР И ИНТЕРФЕЙС)
// ==========================================

let parsedBankTransactions = [];
let autoDetectedAccountId = null; // 🚀 Глобальная переменная для найденного банка
let pendingBankFileText = '';

window.openBankImportModal = function () {
    // 🧹 Убрали ручной выбор банка (select)
    const html = `
        <div class="form-group" style="border: 2px dashed var(--border); padding: 30px; text-align: center; border-radius: 12px; background: var(--surface-alt);">
            <label style="cursor: pointer; display: block;">
                <div style="font-size: 40px; margin-bottom: 10px;">📁</div>
                <div style="color: var(--primary); font-size: 16px; font-weight: bold;">Выберите файл выписки (1C)</div>
                <div style="font-size: 13px; color: var(--text-muted); margin-top: 5px;">Система автоматически определит банк по номеру счета из файла</div>
                <input type="file" id="import-file" accept=".txt" style="display: none;" onchange="handleBankFileSelect(event)">
            </label>
            <div id="import-file-name" style="margin-top: 15px; font-weight: bold; font-size: 14px; color: var(--success);"></div>
        </div>
    `;

    UI.showModal('🏦 Умный импорт выписки', html, `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-blue" onclick="processBankImport()" id="btn-process-import" disabled>🚀 Загрузить операции</button>
    `);

    parsedBankTransactions = [];
    autoDetectedAccountId = null;
    pendingBankFileText = '';
};

window.handleBankFileSelect = function (event) {
    const file = event.target.files[0];
    if (!file) return;

    const infoDiv = document.getElementById('import-file-name');
    infoDiv.innerHTML = `Файл: <b>${file.name}</b> ⏳ Распознаем банк...`;

    const reader = new FileReader();
    reader.readAsText(file, 'windows-1251');
    reader.onload = function (e) {
        pendingBankFileText = e.target.result;

        // 🧠 Читаем номер счета прямо из загруженного файла
        const match = pendingBankFileText.match(/РасчСчет=(\d+)/);
        const fileAccountNumber = match ? match[1] : null;

        if (!fileAccountNumber) {
            infoDiv.innerHTML = `<span style="color: var(--danger)">❌ В файле не найден номер расчетного счета (РасчСчет=...)</span>`;
            event.target.value = '';
            return;
        }

        // 🔍 Ищем совпадение в системе (поиск 20-значного номера в названии плашки)
        const matchedAcc = currentAccounts.find(a => a.type === 'bank' && a.name.includes(fileAccountNumber));

        if (matchedAcc) {
            autoDetectedAccountId = matchedAcc.id; // Запоминаем ID найденного банка
            infoDiv.innerHTML = `
                <div style="background: var(--success-bg); padding: 15px; border-radius: 8px; border: 1px solid var(--success-border); text-align: center; margin-top: 10px;">
                    <p style="margin-top: 0; color: var(--success); font-size: 15px;"><b>🏦 Распознан счет: <br>${matchedAcc.name}</b></p>
                    <button class="btn btn-blue" style="padding: 6px 15px; font-size: 13px; margin-top: 10px;" onclick="executeBankFilePreview()">✅ Прочитать операции</button>
                </div>
            `;
        } else {
            infoDiv.innerHTML = `
                <div style="background: var(--danger-bg); padding: 15px; border-radius: 8px; border: 1px solid var(--danger-border); text-align: center; margin-top: 10px;">
                    <h4 style="color: var(--danger); margin-top: 0;">⚠️ Счет не найден в системе</h4>
                    <p style="font-size: 13px; color: var(--danger-text); line-height: 1.5;">В выписке указан счет <b>${fileAccountNumber}</b>.<br>Закройте это окно, нажмите на шестеренку ⚙️ нужного банка и впишите этот 20-значный номер в название (в скобках).</p>
                </div>
            `;
        }
        event.target.value = '';
    };
};

window.cancelBankImportInline = function () {
    pendingBankFileText = '';
    const infoDiv = document.getElementById('import-file-name');
    if (infoDiv) infoDiv.innerHTML = `<span style="color: var(--danger)">❌ Загрузка отменена. Выберите другой файл.</span>`;
    const fileInput = document.getElementById('import-file');
    if (fileInput) fileInput.value = '';
};

window.executeBankFilePreview = function () {
    const infoDiv = document.getElementById('import-file-name');
    parsedBankTransactions = parse1CStatement(pendingBankFileText);

    if (parsedBankTransactions.length > 0) {
        const btn = document.getElementById('btn-process-import');
        if (btn) btn.disabled = false;

        let previewHtml = `<div style="max-height: 150px; overflow-y:auto; margin-top:10px; font-size:11px; text-align:left; background: var(--surface); border: 1px solid var(--border); padding: 8px; border-radius: 6px;">`;
        parsedBankTransactions.slice(0, 5).forEach(t => {
            previewHtml += `<div style="border-bottom: 1px solid var(--border); margin-bottom: 4px; padding-bottom: 4px;">
                <b style="color:var(--primary);">Дата: ${t.date}</b> | Сумма: ${t.amount} ₽ <br><span style="color:var(--text-muted);">${t.description.substring(0, 60)}...</span>
            </div>`;
        });
        previewHtml += `</div><small style="color:var(--text-muted); font-weight:normal;">(Показаны первые 5 операций)</small>`;

        if (infoDiv) infoDiv.innerHTML = `✅ Готово! Найдено платежей: <b>${parsedBankTransactions.length}</b> ${previewHtml}`;
        UI.toast('Файл проверен, можно загружать', 'success');
    } else {
        if (infoDiv) infoDiv.innerHTML = `<span style="color: var(--danger)">❌ В файле нет подходящих операций</span>`;
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

                // 🚀 Строго берем дату из файла и фиксируем 12:00 для защиты от сдвига часовых поясов
                let rawDate = dSpisano !== '' ? dSpisano : dPostup;
                let formattedDate = null;
                if (rawDate !== '') {
                    const parts = rawDate.match(/\d+/g);
                    if (parts && parts.length >= 3) {
                        formattedDate = `${parts[2]}-${parts[1]}-${parts[0]} 12:00:00`;
                    }
                }

                if (currentDoc['Сумма'] && formattedDate) {
                    let type = dSpisano !== '' ? 'expense' : 'income';
                    let inn = type === 'income' ? currentDoc['ПлательщикИНН'] : currentDoc['ПолучательИНН'];
                    let name = type === 'income' ? (currentDoc['Плательщик1'] || currentDoc['Плательщик']) : (currentDoc['Получатель1'] || currentDoc['Получатель']);

                    const cleanAmount = parseFloat(currentDoc['Сумма'].replace(',', '.'));
                    const docNum = currentDoc['Номер'] || 'Б/Н';
                    let desc = `(№${docNum}) ${currentDoc['НазначениеПлатежа'] || 'Банковская операция'}`;

                    // Защита от дублей внутри одного дня
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
    // 🛡️ Передаем на сервер автоматически найденный ID банка
    if (!autoDetectedAccountId) return UI.toast('Критическая ошибка: Банк не определен!', 'error');
    if (parsedBankTransactions.length === 0) return UI.toast('Нет операций для импорта', 'error');

    const btn = document.getElementById('btn-process-import');
    btn.disabled = true;
    btn.innerText = '⏳ Сохраняем в базу...';

    try {
        const res = await fetch('/api/transactions/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ account_id: autoDetectedAccountId, transactions: parsedBankTransactions })
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
    // 🛡️ ЗАЩИТА БИЗНЕС-ЛОГИКИ: Ищем операции, привязанные к счетам (СЧ- / ЗК-)
    const selectedTxs = allTransactions.filter(t => selectedTransIds.has(t.id));
    const hasSystemInvoices = selectedTxs.some(t => {
        const desc = (t.description || '').toUpperCase();
        return desc.includes('СЧ-') || desc.includes('ЗК-') || desc.includes('ОПЛАТА ПО СЧЕТУ');
    });

    // Если среди выбранных есть системные документы — блокируем массовое удаление
    if (hasSystemInvoices) {
        return UI.showModal('⚠️ Ошибка удаления',
            '<div style="padding: 15px; text-align: center; color: var(--danger-text);">Вы выделили операции, которые автоматически закрыли выставленные Счета или Заказы.<br><br>Массовое удаление таких платежей запрещено, так как это сломает статусы счетов (они останутся "оплаченными"). Удаляйте их поштучно.</div>',
            '<button class="btn btn-outline" onclick="UI.closeModal()">Понятно</button>'
        );
    }

    // Если всё чисто — разрешаем удаление
    const html = `<div style="padding: 15px; text-align: center; font-size: 15px;">Вы уверены, что хотите удалить <b>${selectedTransIds.size}</b> операций?<br><small style="color: var(--text-muted);">Балансы счетов будут автоматически пересчитаны!</small></div>`;
    UI.showModal('⚠️ Массовое удаление', html, `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-red" onclick="confirmBulkDelete()">🗑️ Да, удалить</button>
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
    // 🚀 ИСПРАВЛЕНИЕ: Без этого графики будут «прыгать» по датам
    const sortedTxs = [...transactions].sort((a, b) => new Date(a.transaction_date) - new Date(b.transaction_date));

    const expenseMap = {};
    // Теперь используй sortedTxs в циклах ниже (filter/forEach)
    sortedTxs.filter(t => t.transaction_type === 'expense').forEach(t => {
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
                backgroundColor: window.getChartColors(),
                borderWidth: 0,
                hoverOffset: 8,
                borderRadius: 4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } }
            },
            cutout: '70%',

            // 1. Меняем курсор на "палец" при наведении на цветной кусок, чтобы было понятно, куда кликать
            onHover: (event, chartElement) => {
                event.native.target.style.cursor = chartElement[0] ? 'pointer' : 'default';
            },

            // 2. Улучшенный и безопасный клик
            onClick: (event, elements, chart) => {
                // Сработает, только если кликнули именно на цветной сегмент
                if (elements && elements.length > 0) {
                    const idx = elements[0].index;
                    const categoryName = chart.data.labels[idx];

                    const searchInput = document.getElementById('finance-search');
                    if (searchInput) {
                        searchInput.value = categoryName;
                    }

                    // Микро-задержка отвязывает загрузку от анимации клика Chart.js
                    setTimeout(() => {
                        if (typeof setTransTypeFilter === 'function') {
                            setTransTypeFilter('expense');
                        } else if (typeof loadFinanceData === 'function') {
                            currentFinancePage = 1;
                            loadFinanceData();
                        }
                    }, 50);
                }
            }
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
                { label: 'Доход', data: incomes, backgroundColor: window.getCssVar('--success'), borderRadius: 4 },
                { label: 'Расход', data: expenses, backgroundColor: window.getCssVar('--danger'), borderRadius: 4 }
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
window.uploadReceipt = async function (transactionId, inputElement) {
    const file = inputElement.files[0];
    if (!file) return;

    // 🚨 ИСПРАВЛЕНО: Блокируем кнопку, чтобы менеджер не накликал дублей
    inputElement.disabled = true;
    UI.toast('⏳ Загрузка чека на сервер...', 'info');

    const formData = new FormData();
    formData.append('receipt', file);

    try {
        const res = await fetch(`/api/transactions/${transactionId}/receipt`, {
            method: 'POST',
            body: formData
        });

        if (res.ok) {
            UI.toast('✅ Чек успешно загружен!', 'success');
            loadFinanceData(); // Перезагружаем таблицу транзакций
        } else {
            UI.toast('Ошибка при загрузке чека', 'error');
        }
    } catch (e) {
        console.error(e);
        UI.toast('Ошибка сети при загрузке чека', 'error');
    } finally {
        // Разблокируем инпут независимо от результата
        inputElement.disabled = false;
        inputElement.value = ''; // Сбрасываем выбранный файл
    }
};
window.deleteReceipt = function (id) {
    const html = `<div style="padding: 15px; text-align: center; font-size: 15px;">Точно открепить файл от этой операции?</div>`;
    UI.showModal('⚠️ Удаление файла', html, `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-red" onclick="executeDeleteReceipt(${id})">🗑️ Да, удалить</button>
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

        const fmt = (val) => Number(val).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

        const html = `
            <style>.modal-content { max-width: 800px !important; width: 90% !important; }</style>
            <div style="background: var(--surface-alt); padding: 20px; border-radius: 8px; border: 1px solid var(--border);">
                <h3 style="margin-top: 0; text-align: center; color: var(--text-main);">Отчет о прибылях и убытках (P&L)</h3>
                
                <div style="display: flex; justify-content: center; gap: 10px; margin-bottom: 20px; align-items: center; background: var(--surface); padding: 10px; border-radius: 8px; border: 1px solid var(--border);">
                    <span style="font-size: 13px; font-weight: bold;">Период расчета:</span>
                    <input type="date" id="pnl-start" class="input-modern" value="${start}" style="margin: 0; padding: 4px 8px; width: 130px;">
                    <span>—</span>
                    <input type="date" id="pnl-end" class="input-modern" value="${end}" style="margin: 0; padding: 4px 8px; width: 130px;">
                    <button class="btn btn-blue" style="padding: 4px 12px;" onclick="openPnlReportModal(document.getElementById('pnl-start').value, document.getElementById('pnl-end').value)">🔄 Рассчитать</button>
                    <button class="btn btn-outline" style="padding: 4px 12px;" onclick="openPnlReportModal('', '')">За всё время</button>
                </div>

                <div style="text-align: center; margin-bottom: 25px;">
                    <span style="background: var(--surface-alt); color: var(--primary); padding: 6px 15px; border-radius: 20px; font-weight: bold; font-size: 13px; border: 1px solid var(--primary);">
                        📅 ${periodText}
                    </span>
                </div>

                <!-- БЛОК ДОХОДОВ -->
                <h4 style="margin: 15px 0 10px; color: var(--text-main); font-size: 16px; border-bottom: 1px solid var(--border); padding-bottom: 5px;">ДОХОДЫ</h4>
                <div style="display: flex; justify-content: space-between; padding: 10px 15px; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; margin-bottom: 5px;">
                    <span style="font-size: 15px;">Выручка (Оборот от продаж):</span>
                    <span style="font-size: 16px; font-weight: bold; color: var(--success);">${fmt(data.revenue)} ₽</span>
                </div>
                <div style="display: flex; justify-content: space-between; padding: 10px 15px; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; margin-bottom: 10px;">
                    <span style="font-size: 15px;">Прочие доходы (Кэшбэк, Услуги, Продажа ОС):</span>
                    <span style="font-size: 16px; font-weight: bold; color: var(--success);">${fmt(data.otherIncome)} ₽</span>
                </div>
                <div style="display: flex; justify-content: space-between; padding: 12px 15px; background: var(--surface-alt); border-right: 3px solid var(--success); margin-bottom: 20px; align-items: center;">
                    <span style="font-size: 15px; font-weight: bold;">ИТОГО ДОХОДЫ:</span>
                    <span style="font-size: 18px; font-weight: 900; color: var(--success);">${fmt(data.totalIncome)} ₽</span>
                </div>

                <!-- БЛОК РАСХОДОВ -->
                <h4 style="margin: 15px 0 10px; color: var(--text-main); font-size: 16px; border-bottom: 1px solid var(--border); padding-bottom: 5px;">РАСХОДЫ</h4>
                <div style="display: flex; justify-content: space-between; padding: 10px 15px; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; margin-bottom: 5px;">
                    <span style="font-size: 15px;">Себестоимость продаж (COGS) отгруженных партий:</span>
                    <span style="font-size: 16px; font-weight: bold; color: var(--danger);">-${fmt(data.cogs)} ₽</span>
                </div>
                <div style="display: flex; justify-content: space-between; padding: 10px 15px; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; margin-bottom: 5px;">
                    <span style="font-size: 15px;">Зарплатный фонд (ФОТ + Сдельщина по всем сотрудникам):</span>
                    <span style="font-size: 16px; font-weight: bold; color: var(--danger);">-${fmt(data.laborCosts)} ₽</span>
                </div>
                <div style="display: flex; justify-content: space-between; padding: 10px 15px; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; margin-bottom: 10px;">
                    <span style="font-size: 15px;">Косвенные расходы (Аренда, Логистика, Налоги, Офис):</span>
                    <span style="font-size: 16px; font-weight: bold; color: var(--danger);">-${fmt(data.indirectCosts)} ₽</span>
                </div>
                <div style="display: flex; justify-content: space-between; padding: 12px 15px; background: var(--surface-alt); border-right: 3px solid var(--danger); margin-bottom: 20px; align-items: center;">
                    <span style="font-size: 15px; font-weight: bold;">ИТОГО РАСХОДЫ:</span>
                    <span style="font-size: 18px; font-weight: 900; color: var(--danger);">-${fmt(data.totalExpenses)} ₽</span>
                </div>

                <!-- ФИНАЛЬНЫЙ РЕЗУЛЬТАТ -->
                <div style="display: flex; justify-content: space-between; padding: 25px 20px; background: ${Number(data.netProfit) >= 0 ? 'var(--success-bg)' : 'var(--danger-bg)'}; border: 2px solid ${Number(data.netProfit) >= 0 ? 'var(--success)' : 'var(--danger)'}; border-radius: 8px; align-items: center;">
                    <div>
                        <div style="font-size: 18px; font-weight: 900; color: ${Number(data.netProfit) >= 0 ? 'var(--success-text)' : 'var(--danger-text)'}; letter-spacing: 0.5px;">ЧИСТАЯ ПРИБЫЛЬ (Net Profit)</div>
                        <div style="font-size: 14px; color: var(--text-muted); margin-top: 5px;">Рентабельность по чистой прибыли: <b style="font-size: 16px; color: ${Number(data.netProfit) >= 0 ? 'var(--success)' : 'var(--danger)'};">${data.margin}%</b></div>
                    </div>
                    <span style="font-size: 32px; font-weight: 900; color: ${Number(data.netProfit) >= 0 ? 'var(--success-text)' : 'var(--danger-text)'}; text-shadow: 0 1px 2px rgba(0,0,0,0.1);">${Number(data.netProfit) > 0 ? '+' : ''}${fmt(data.netProfit)} ₽</span>
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

    if (!id || id === 'null' || id === 'undefined') return;

    try {
        const res = await fetch(`/api/counterparties/${id}/profile?_t=${Date.now()}`);
        if (!res.ok) throw new Error('Ошибка загрузки');
        const data = await res.json();
        const cp = data.info;
        const transHtml = data.transactions.map(t => {
            const isMoney = t.origin === 'money';
            const isIncome = t.transaction_type === 'income';

            // Иконка: монета для денег, коробка для товара
            const icon = isMoney ? '💰' : '📦';

            // Цвет суммы:
            // Для денег: зеленый (+ нам заплатили), красный (- мы заплатили)
            // Для товара: красный (+ мы отгрузили товар = уменьшили свой склад/увеличили долг клиента)
            let amountColor = isIncome ? 'var(--success)' : 'var(--danger)';
            let sign = isIncome ? '+' : '-';

            return `
            <div style="display: flex; justify-content: space-between; padding: 10px; border-bottom: 1px solid var(--border); font-size: 13px;">
            <div>
                <b style="color:var(--text-main);">${t.date}</b> ${icon}<br>
                <span style="color: var(--text-muted); font-size: 11px;">${escapeHTML(t.category)}</span>
            </div>
            <div style="text-align: right; width: 45%; padding-right: 10px;">
                <div style="font-weight: 500;">${escapeHTML(t.description)}</div>
            </div>
            <div style="font-weight: bold; color: ${amountColor}; white-space: nowrap;">
                ${sign}${parseFloat(t.amount).toLocaleString('ru-RU')} ₽
            </div>
            </div>
            `;
        }).join('') || '<div style="padding:15px; text-align:center; color:var(--text-muted);">Операций нет</div>';
        const invHtml = data.invoices.map(i => `
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 10px; border-bottom: 1px solid var(--border); font-size: 13px;">
                <div><b>Счет №${i.invoice_number}</b> от ${i.date}<br><span style="color: var(--text-muted);">${i.description}</span></div>
                <div style="font-weight: bold;">${parseFloat(i.amount).toLocaleString('ru-RU')} ₽</div>
                <div><span class="badge" style="background: ${i.status === 'paid' ? 'var(--success-bg)' : 'var(--warning-bg)'}; color: ${i.status === 'paid' ? 'var(--success)' : 'var(--warning-text)'};">${i.status === 'paid' ? 'Оплачен' : 'Ожидает'}</span></div>
            </div>
        `).join('') || '<div style="padding:15px; text-align:center; color:var(--text-muted);">Счетов нет</div>';

        const contractsHtml = data.contracts.map(c => `
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 10px; border-bottom: 1px solid var(--border); font-size: 13px;">
                <div><b>Договор №${c.number}</b> от ${c.date}</div>
                <div style="display: flex; gap: 5px;">
                    <button class="btn btn-outline" style="padding: 4px 8px; font-size: 12px; color: var(--info); border-color: var(--info);" onclick="window.open('/print/contract?id=${c.id}', '_blank')" title="Распечатать">🖨️</button>
                    <button class="btn btn-outline" style="padding: 4px 8px; font-size: 12px; color: var(--danger); border-color: var(--danger);" onclick="deleteContract(${c.id}, ${cp.id})" title="Удалить договор">❌</button>
                </div>
            </div>
        `).join('') || '<div style="padding:15px; text-align:center; color:var(--text-muted);">Договоров нет</div>';

        const html = `
            <style>.modal-content { max-width: 1000px !important; width: 95% !important; }</style>
            <div style="display: flex; gap: 20px; align-items: flex-start;">
                <div style="flex: 1;">
                    <div style="background: var(--surface-alt); padding: 15px; border-radius: 8px; border: 1px solid var(--border); margin-bottom: 15px;">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                            <span class="badge" style="background: var(--surface-alt); color: var(--primary);">${cp.type}</span>
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
                        <h4 style="margin: 0 0 5px 0; cursor: pointer; background: var(--surface-alt); padding: 10px; border-radius: 6px; border: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; transition: 0.2s;"
                            onclick="const c = document.getElementById('cp-contracts-list'); const i = document.getElementById('cp-contracts-icon'); if(c.style.display==='none'){c.style.display='block'; i.innerText='▲ Свернуть';}else{c.style.display='none'; i.innerText='▼ Развернуть';}">
                            <span>📑 Договоры клиента</span>
                            <span id="cp-contracts-icon" style="color: var(--primary); font-size: 12px; font-weight: normal;">▼ Развернуть</span>
                        </h4>
                        <div id="cp-contracts-list" style="display: none; border: 1px solid var(--border); border-radius: 8px; max-height: 200px; overflow-y: auto; background: var(--surface);">
                            ${contractsHtml}
                        </div>
                    </div>
                    
                    <h4 style="margin: 0 0 10px 0;">🟡 Счета на оплату</h4>
                    <div style="border: 1px solid var(--border); border-radius: 8px; max-height: 150px; overflow-y: auto; background: var(--surface); margin-bottom: 15px;">
                        ${invHtml}
                    </div>

                    <h4 style="margin: 0 0 10px 0;">📄 Документы и корректировки</h4>
                    <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; margin-bottom: 20px;">
                        <button class="btn btn-outline" style="border-color: var(--warning); color: var(--warning-text); font-size: 13px; padding: 6px;" onclick="openFinanceInvoiceModal(${cp.id}, '${cp.name.replace(/'/g, "\\'").replace(/"/g, '&quot;')}')">🖨️ Выставить Счет</button>
                        <button class="btn btn-outline" style="border-color: var(--primary); color: var(--primary); font-size: 13px; padding: 6px;" onclick="window.open('/print/act?cp_id=${cp.id}', '_blank')">📑 Акт сверки</button>
                        <button class="btn btn-outline" style="border-color: var(--primary); color: var(--primary); font-size: 13px; padding: 6px; font-weight: bold;" onclick="openCorrectionModal(${cp.id})">⚖️ Коррекция</button>
                    </div>
                </div>

                <div style="flex: 1;">
                    <h4 style="margin: 0 0 10px 0;">💸 Финансовая история</h4>
                    <div style="border: 1px solid var(--border); border-radius: 8px; max-height: 600px; overflow-y: auto; background: var(--surface);">
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

// === КРАСИВОЕ И БЕЗОПАСНОЕ УДАЛЕНИЕ ДОГОВОРА (УНИВЕРСАЛЬНОЕ) ===
window.deleteContract = function (contractId, cpId = null) {
    const html = `
        <div style="padding: 15px; text-align: center; font-size: 15px;">
            Вы уверены, что хотите удалить этот договор?<br>
            <small style="color: var(--text-muted);">Это действие нельзя отменить.</small>
        </div>`;

    // Вызываем твое фирменное модальное окно
    UI.showModal('⚠️ Удаление договора', html, `
        <button class="btn btn-outline" onclick="cancelDeleteContract(${cpId})">Отмена</button>
        <button class="btn btn-red" onclick="executeDeleteContract(${contractId}, ${cpId})">🗑️ Да, удалить</button>
    `);
};

// Функция возврата (чтобы ничего не зависало при отмене)
window.cancelDeleteContract = function (cpId) {
    UI.closeModal();
    // Возвращаем пользователя ровно туда, откуда он вызвал удаление
    if (cpId && typeof openCounterpartyProfile === 'function') {
        openCounterpartyProfile(cpId);
    } else if (typeof openContractManager === 'function') {
        openContractManager();
    }
};

window.executeDeleteContract = async function (contractId, cpId = null) {
    try {
        const res = await fetch(`/api/contracts/${contractId}`, { method: 'DELETE' });

        if (res.ok) {
            UI.toast('✅ Договор удален', 'success');
            UI.closeModal();

            // Перерисовываем правильное окно после успешного удаления
            if (cpId && typeof openCounterpartyProfile === 'function') {
                openCounterpartyProfile(cpId);
            } else {
                const saleClient = document.getElementById('sale-client');
                if (saleClient && typeof loadClientContracts === 'function') {
                    await loadClientContracts(saleClient.value); // обновляем выпадающий список
                }
                if (typeof openContractManager === 'function') openContractManager();
            }
        } else {
            // Если сработала защита бэкенда (остались спецификации или заказы)
            const err = await res.json();
            UI.toast(err.error || 'Ошибка при удалении', 'error');

            // Возвращаем окно управления договорами, чтобы менеджер мог удалить спецификации
            cancelDeleteContract(cpId);
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
            <tr style="border-bottom: 1px solid var(--border);">
                <td style="padding: 10px;"><b>${e.date}</b></td>
                <td style="padding: 10px;">${e.category}</td>
                <td style="padding: 10px; color: var(--text-muted);">${e.description || '-'}</td>
                <td style="padding: 10px; color: var(--danger); font-weight: bold;">-${parseFloat(e.amount).toLocaleString('ru-RU')} ₽</td>
                <td style="padding: 10px; text-align: right;">
                    <button class="btn btn-outline" style="padding: 4px 8px; font-size: 11px; color: var(--success); border-color: var(--success);" onclick="executePlannedExpense(${e.id}, ${e.amount})" title="Провести платеж">✅ Оплатить</button>
                    <button class="btn btn-outline" style="padding: 4px 8px; font-size: 11px; color: var(--danger); border-color: var(--danger); margin-left: 5px;" onclick="deletePlannedExpense(${e.id})" title="Отменить план">❌</button>
                </td>
            </tr>
        `).join('') || '<tr><td colspan="5" style="text-align:center; color:var(--text-muted); padding: 20px;">Нет запланированных платежей</td></tr>';

        const html = `
            <div style="padding: 10px;">
                <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                    <thead style="background: var(--surface-alt); text-align: left;">
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
                <small style="color: var(--text-muted); display: block; margin-top: 5px;">
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
            <div style="background: var(--surface-alt); padding: 15px; border-radius: 8px; border: 1px solid var(--border); margin-bottom: 20px; display: flex; justify-content: space-between; align-items: center;">
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
                        <label>Краткое наименование <b style="color: var(--danger)">*</b></label>
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
    if (!payload.role) return UI.toast('Укажите роль (Покупатель/Поставщик)!', 'warning');
    if (!payload.phone) return UI.toast('Введите телефон!', 'warning');
    
    if (payload.inn && payload.inn.length !== 10 && payload.inn.length !== 12) {
        return UI.toast('Введите корректный ИНН (10 или 12 цифр)', 'warning');
    }

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
let taxCustomStart = '';
let taxCustomEnd = '';

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
        if (!res.ok) throw new Error("Ошибка связи с сервером");

        const settings = await res.json();

        // 🛡️ Защита 1: Если сервер прислал объект, обновляем переменные.
        // Используем логическое ИЛИ (||), чтобы установить значения по умолчанию, 
        // если в базе данных (settings) пусто или там не число.

        // Ставка УСН (по умолчанию 3%)
        window.taxUsnRate = parseFloat(settings.tax_usn_rate) || 3;

        // Корректировка банка (по умолчанию 0)
        window.taxBankCorrection = parseFloat(settings.tax_bank_correction) || 0;

        // Корректировка кассы (по умолчанию 0)
        window.taxCashCorrection = parseFloat(settings.tax_cash_correction) || 0;

        window.financeLockDate = settings.finance_lock_date || null;

        console.log("✅ Глобальные настройки загружены:", { taxUsnRate, taxBankCorrection, taxCashCorrection });

    } catch (e) {
        // 🛡️ Защита 2: Если сервер упал, система должна продолжить работать на стандартных цифрах
        window.taxUsnRate = 3;
        window.taxBankCorrection = 0;
        window.taxCashCorrection = 0;
        console.error("⚠️ Настройки не загружены, применены значения по умолчанию:", e.message);
    }
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
// ⚡ ЕДИНЫЙ КАЛЬКУЛЯТОР ЖИВЫХ ДАННЫХ (С ТОЧНОЙ МАТЕМАТИКОЙ)
// ==========================================
window.calculateLiveTax = function () {
    if (!rawTaxData) return { cashTax: 0, bankVat: 0, total: 0, cashTurnover: 0, vatIn: 0, vatOut: 0 };
    let liveVatIn = 0, liveVatOut = 0, liveCashTax = 0, liveCashTurnover = 0;

    // 🛡️ Функция для железобетонного округления до копеек (защита от багов JS)
    const roundMoney = (num) => Math.round(num * 100) / 100;

    rawTaxData.bank.transactions.forEach(t => {
        if (t.tax_excluded) return;
        const forceVat = t.tax_force_vat;
        let tax = t.calculated_tax;

        // 🛡️ Точный расчет НДС без потери копеек
        if (forceVat && t.is_no_vat) tax = roundMoney((parseFloat(t.amount) * 22) / 122);

        if (!t.is_no_vat || forceVat) {
            if (t.transaction_type === 'income') liveVatIn = roundMoney(liveVatIn + tax);
            else liveVatOut = roundMoney(liveVatOut + tax);
        }
    });

    rawTaxData.cash.transactions.forEach(t => {
        if (t.tax_excluded) return;
        if (t.transaction_type === 'income') {
            liveCashTurnover = roundMoney(liveCashTurnover + parseFloat(t.amount));
            liveCashTax = roundMoney(liveCashTax + t.calculated_tax);
        }
    });

    const finalBank = roundMoney((liveVatIn - liveVatOut) + taxBankCorrection);
    const finalCash = roundMoney(liveCashTax + taxCashCorrection);

    return {
        cashTax: finalCash,
        bankVat: finalBank,
        total: roundMoney(Math.max(0, finalBank) + Math.max(0, finalCash)),
        cashTurnover: liveCashTurnover,
        vatIn: liveVatIn,
        vatOut: liveVatOut
    };
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
        <div style="background: var(--surface); padding: 20px; border-radius: 12px; border: 1px solid var(--border); box-shadow: var(--shadow-sm);">
            <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 15px;">
                <div>
                    <div style="font-size: 11px; font-weight: 800; color: var(--primary); text-transform: uppercase;">🏦 Налоговый резерв</div>
                    <div style="font-size: 28px; font-weight: 900; color: var(--text-main); margin-top: 4px; white-space: nowrap;">${live.total.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 0 })} ₽</div>
                </div>
                <div id="tax-period-controls" style="display: flex; gap: 3px;" class="no-print">
                    ${periodHtml}
                </div>
            </div>

            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; border-top: 1px solid var(--border); padding-top: 15px;">
                <div style="cursor: pointer; padding: 10px; border-radius: 8px; transition: 0.2s;" onclick="openTaxDetailsModal('cash')">
                    <div style="font-size: 10px; color: var(--text-muted);">Касса (УСН ${taxUsnRate}%):</div>
                    <div style="font-size: 16px; font-weight: bold; color: var(--success); white-space: nowrap;">+${Math.max(0, live.cashTax).toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 0 })} ₽</div>
                    <div style="font-size: 9px; color: var(--primary); margin-top: 4px;">Аналитика УСН ➔</div>
                </div>
                <div style="cursor: pointer; padding: 10px; border-radius: 8px; transition: 0.2s;" onclick="openTaxDetailsModal('bank')">
                    <div style="font-size: 10px; color: var(--text-muted);">Безнал (Оперативный НДС):</div>
                    <div style="font-size: 16px; font-weight: bold; color: var(--primary); white-space: nowrap;">${live.bankVat > 0 ? '+' : ''}${Math.max(0, live.bankVat).toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 0 })} ₽</div>
                    <div style="font-size: 9px; color: var(--primary); margin-top: 4px;">Аналитика НДС ➔</div>
                </div>
            </div>
        </div>
    `;
};

/**
 * Загрузка данных налоговой копилки с учетом выбранного периода и настроек.
 * Эта функция является "входной точкой": она запрашивает данные и передает их на отрисовку.
 */
window.loadTaxPiggyBank = async function () {
    // 1. Загружаем глобальные настройки (если есть такая необходимость перед основным запросом)
    await fetchGlobalTaxSettings();

    try {
        const params = new URLSearchParams();
        let start = '', end = '';

        // 2. Расчет временного интервала (Год, Квартал или Месяц)
        if (taxPeriodType === 'year') {
            start = `${taxYear}-01-01`;
            end = `${taxYear}-12-31`;
        }
        else if (taxPeriodType === 'quarter') {
            const startMonth = (taxPeriodValue - 1) * 3 + 1;
            start = `${taxYear}-${String(startMonth).padStart(2, '0')}-01`;
            // Находим последний день последнего месяца квартала
            const endDay = new Date(taxYear, startMonth + 2, 0).getDate();
            end = `${taxYear}-${String(startMonth + 2).padStart(2, '0')}-${endDay}`;
        }
        else if (taxPeriodType === 'month') {
            start = `${taxYear}-${String(taxPeriodValue).padStart(2, '0')}-01`;
            // Находим последний день выбранного месяца
            const endDay = new Date(taxYear, taxPeriodValue, 0).getDate();
            end = `${taxYear}-${String(taxPeriodValue).padStart(2, '0')}-${endDay}`;
        }
        else if (taxPeriodType === 'custom') {
            // Если дата есть - клеим время. Если нет - оставляем пустую строку.
            start = taxCustomStart ? `${taxCustomStart} 00:00:00` : '';
            end = taxCustomEnd ? `${taxCustomEnd} 23:59:59` : '';
        }


        // 3. Подготовка параметров для GET-запроса
        if (start && end) {
            params.append('start', start);
            params.append('end', end);
        }

        // Передаем ставку УСН и временную метку для обхода кэша браузера
        params.append('usn_rate', taxUsnRate);
        params.append('_t', Date.now());

        // 4. Запрос к API бэкенда
        const res = await fetch(`/api/finance/tax-piggy-bank?${params.toString()}`);

        if (!res.ok) {
            throw new Error(`Ошибка сервера: ${res.status} ${res.statusText}`);
        }

        // 5. Получение данных в формате JSON
        const data = await res.json();

        // Сохраняем основные данные в глобальную переменную для доступа из модальных окон
        rawTaxData = data;

        // 🚀 КЛЮЧЕВОЙ МОМЕНТ: Синхронизируем настройки НДС
        // Мы берем объект config, который прислал бэкенд, и кладем его в window.ERP_CONFIG.
        // Теперь функции отрисовки (renderTaxModalContent) увидят ставку НДС и делитель.
        if (data.config) {
            window.ERP_CONFIG = data.config;
        } else {
            console.warn("Предупреждение: Бэкенд не прислал настройки ERP_CONFIG.");
        }

        // 6. Запуск отрисовки виджета на главной странице
        if (typeof renderTaxWidgetUI === 'function') {
            renderTaxWidgetUI();
        }

    } catch (e) {
        console.error("❌ Критическая ошибка при загрузке налоговой копилки:", e.message);
        // Здесь можно добавить UI.toast для уведомления пользователя об ошибке связи с БД
    }
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

    // Определяем текущий набор данных (банк или касса) и результаты живого расчета
    const dataObj = currentTaxTab === 'bank' ? rawTaxData.bank : rawTaxData.cash;
    const live = calculateLiveTax();

    // ⚡ Считаем количество исключенных операций для отображения на кнопке фильтра
    const excludedCount = dataObj.transactions.filter(t => t.tax_excluded).length;

    // Фильтруем строки для отображения согласно выбранному фильтру (все, доходы, расходы, исключенные)
    const filteredRows = dataObj.transactions.filter(t => {
        const isExcluded = t.tax_excluded;
        const isIncome = t.transaction_type === 'income';

        if (currentTaxFilter === 'excluded') return isExcluded;
        if (isExcluded) return false;
        if (currentTaxFilter === 'income' && !isIncome) return false;
        if (currentTaxFilter === 'expense' && isIncome) return false;
        return true;
    });

    // Генерируем строки таблицы
    const tableRows = filteredRows.map(t => {
        const isIncome = t.transaction_type === 'income';
        const isExcluded = t.tax_excluded;
        const forceVat = t.tax_force_vat;
        const isNoVat = t.is_no_vat; // Результат умной сортировки с сервера

        // 🛡️ Безопасный расчет налога для текущей строки
        let currentCalculatedTax = parseFloat(t.calculated_tax || 0);

        // Если принудительно включен НДС для банковской операции, помеченной "Без НДС"
        if (currentTaxTab === 'bank' && forceVat && isNoVat) {
            const amt = parseFloat(t.amount || 0);
            // Используем формулу выделения НДС из суммы
            currentCalculatedTax = amt - (amt / ERP_CONFIG.vatDivider);
        }

        // Логика отображения налога
        let taxDisplay = '';
        if (currentTaxTab === 'bank' && isNoVat && !forceVat) {
            // Метка для операций, которые система (или ты) исключила из расчета НДС
            taxDisplay = `<span style="background: var(--border); color: var(--text-muted); padding: 2px 6px; border-radius: 4px; font-size: 10px; text-transform: uppercase;">Без НДС</span>`;
        } else {
            const taxSign = isIncome ? '+' : '-';
            const taxColor = isIncome ? 'var(--danger)' : 'var(--success)';
            // Форматируем число, чтобы избежать ошибок отображения NaN
            const formattedTax = Math.abs(currentCalculatedTax).toLocaleString('ru-RU', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2
            });
            taxDisplay = `<span style="color: ${taxColor}; font-weight: bold; white-space: nowrap;">${taxSign}${formattedTax} ₽</span>`;
        }

        // HTML-код чекбоксов управления (Учитывать / + НДС)
        let controlsHtml = `
            <label style="display: flex; align-items: center; gap: 6px; font-size: 11px; cursor: pointer; color: var(--text-muted);">
                <input type="checkbox" ${isExcluded ? '' : 'checked'} onchange="toggleTaxExclusion(${t.id}, this)"> Учитывать
            </label>
        `;
        if (currentTaxTab === 'bank') {
            controlsHtml += `
                <label style="display: flex; align-items: center; gap: 6px; font-size: 10px; cursor: pointer; margin-top: 6px; color: var(--warning-text);">
                    <input type="checkbox" ${forceVat ? 'checked' : ''} onchange="toggleForceVat(${t.id}, this)"> + НДС ${ERP_CONFIG.vatRate}%
                </label>
            `;
        }

        // Определяем визуальный стиль строки
        let rowStyle = 'border-bottom: 1px solid var(--border);';
        if (isExcluded) {
            rowStyle += 'opacity: 0.5; background: var(--surface-alt);';
        } else if (isNoVat && !forceVat) {
            rowStyle += 'background: var(--surface);'; // Легкое затенение для операций без НДС
        }

        return `
            <tr style="${rowStyle}">
                <td style="padding: 10px; min-width: 100px;">${controlsHtml}</td>
                <td style="padding: 10px; white-space: nowrap;">${new Date(t.transaction_date).toLocaleDateString('ru-RU')}</td>
                <td style="padding: 10px;"><b>${t.category}</b></td>
                <td style="padding: 10px; max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${t.description}">${t.description}</td>
                <td style="padding: 10px; text-align: right; font-weight: bold; color: ${isIncome ? 'var(--success)' : 'var(--text-main)'}; white-space: nowrap;">
                    ${isIncome ? '+' : '-'}${parseFloat(t.amount || 0).toLocaleString()}
                </td>
                <td style="padding: 10px; text-align: right;">${taxDisplay}</td>
            </tr>
        `;
    }).join('');

    // Формируем правую панель с итогами
    let rightPanelHtml = '';
    if (currentTaxTab === 'bank') {
        const deductionPercent = live.vatIn > 0 ? (live.vatOut / live.vatIn) * 100 : 0;
        let trafficColor = 'var(--success)', trafficText = 'Безопасная зона';
        if (deductionPercent > 89) { trafficColor = 'var(--danger)'; trafficText = 'Высокий риск ФНС (Вычеты > 89%)'; }
        else if (deductionPercent > 86) { trafficColor = 'var(--warning)'; trafficText = 'Внимание (Близко к порогу)'; }

        rightPanelHtml = `
            <div style="font-size: 11px; text-transform: uppercase; color: var(--text-muted); font-weight: bold; margin-bottom: 10px;">Оперативный НДС (${ERP_CONFIG.vatRate}%)</div>
            <div style="margin-bottom: 15px;">
                <div style="display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 5px;">
                    <span>Доля вычетов:</span><span style="font-weight: bold; color: ${trafficColor};">${deductionPercent.toFixed(1)}%</span>
                </div>
                <div style="height: 6px; background: var(--border); border-radius: 3px; overflow: hidden;">
                    <div style="height: 100%; width: ${Math.min(deductionPercent, 100)}%; background: ${trafficColor};"></div>
                </div>
                <div style="font-size: 10px; color: ${trafficColor}; margin-top: 4px;">${trafficText}</div>
            </div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 13px; gap: 10px;">
                <span>Начислено (Доход):</span><span style="font-weight: bold;">+ ${live.vatIn.toLocaleString('ru-RU')} ₽</span>
            </div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 15px; font-size: 13px; gap: 10px;">
                <span>Вычеты (Расход):</span><span style="font-weight: bold; color: var(--success);">- ${live.vatOut.toLocaleString('ru-RU')} ₽</span>
            </div>
            <div style="margin-bottom: 20px;">
                <label style="font-size: 11px; color: var(--text-muted);">+/- Корректировка прошлых периодов:</label>
                <input type="number" class="input-modern" style="width: 100%; box-sizing: border-box; padding: 6px; margin-top: 4px;" value="${taxBankCorrection}" onchange="updateTaxCorrection(this.value)">
            </div>
            <div style="border-top: 2px solid var(--border); padding-top: 15px;">
                <div style="font-size: 12px; font-weight: bold; color: var(--text-muted);">ИТОГО НДС К УПЛАТЕ:</div>
                <div style="font-size: 24px; font-weight: 900; color: var(--text-main); margin-top: 5px;">${Math.max(0, live.bankVat).toLocaleString('ru-RU')} ₽</div>
            </div>
        `;
    } else {
        rightPanelHtml = `
            <div style="font-size: 11px; text-transform: uppercase; color: var(--text-muted); font-weight: bold; margin-bottom: 15px;">Учет УСН (Касса)</div>
            <div style="background: var(--surface); padding: 12px; border-radius: 8px; border: 1px solid var(--border); margin-bottom: 20px;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; font-size: 13px;">
                    <span style="color: var(--text-muted);">База доходов:</span>
                    <span style="font-weight: bold;">${live.cashTurnover.toLocaleString('ru-RU')} ₽</span>
                </div>
                <div style="display: flex; justify-content: space-between; align-items: center; border-top: 1px dashed var(--border); padding-top: 10px;">
                    <span style="font-size: 13px;">Ставка налога:</span>
                    <div style="display: flex; align-items: center; gap: 4px;">
                        <input type="number" class="input-modern" style="width: 60px; padding: 4px; text-align: center; font-weight: bold;" value="${taxUsnRate}" step="0.5" onchange="updateUsnRate(this.value)">
                        <span style="font-weight: bold;">%</span>
                    </div>
                </div>
            </div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 15px; font-size: 13px;">
                <span>Сумма налога:</span><span style="font-weight: bold; color: var(--danger);">+ ${live.cashTax.toLocaleString('ru-RU')} ₽</span>
            </div>
            <div style="margin-bottom: 20px;">
                <label style="font-size: 11px; color: var(--text-muted);">- Вычеты (взносы и др.):</label>
                <input type="number" class="input-modern" style="width: 100%; box-sizing: border-box; padding: 6px; margin-top: 4px;" value="${taxCashCorrection}" onchange="updateTaxCorrection(this.value)">
            </div>
            <div style="border-top: 2px solid var(--border); padding-top: 15px;">
                <div style="font-size: 12px; font-weight: bold; color: var(--text-muted);">ИТОГО УСН К УПЛАТЕ:</div>
                <div style="font-size: 24px; font-weight: 900; color: var(--text-main); margin-top: 5px;">${Math.max(0, live.cashTax).toLocaleString('ru-RU')} ₽</div>
            </div>
        `;
    }

    let typeOptions = `
            <option value="month" ${taxPeriodType === 'month' ? 'selected' : ''}>Месяц</option>
            <option value="quarter" ${taxPeriodType === 'quarter' ? 'selected' : ''}>Квартал</option>
            <option value="year" ${taxPeriodType === 'year' ? 'selected' : ''}>Год</option>
            <option value="custom" ${taxPeriodType === 'custom' ? 'selected' : ''}>Произвольно 📅</option>
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

    const bodyHtml = `
        <div style="display: flex; gap: 20px;">
            <div style="flex: 3; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 15px;">
                <div style="display: flex; gap: 10px; border-bottom: 1px solid var(--border); padding-bottom: 10px; margin-bottom: 15px; align-items: center; flex-wrap: wrap;">
                        <button class="btn ${currentTaxTab === 'bank' ? 'btn-blue' : 'btn-outline'}" onclick="switchTaxTab('bank')">🏦 Банки (НДС)</button>
                        <button class="btn ${currentTaxTab === 'cash' ? 'btn-blue' : 'btn-outline'}" onclick="switchTaxTab('cash')">💵 Касса (УСН)</button>
                        
                        <div style="margin-left: auto; display: flex; align-items: center; gap: 6px;">
                            <select class="input-modern" style="padding: 4px 6px; font-size: 12px; margin: 0; min-width: 100px;" onchange="taxPeriodType = this.value; if(this.value==='quarter') taxPeriodValue = Math.floor(new Date().getMonth()/3)+1; else if(this.value==='month') taxPeriodValue = new Date().getMonth()+1; saveLocalPeriods(); loadTaxPiggyBank().then(()=>renderTaxModalContent());">
                                ${typeOptions}
                            </select>
                            
                            ${taxPeriodType !== 'all' && taxPeriodType !== 'year' && taxPeriodType !== 'custom' ? `
                            <select class="input-modern" style="padding: 4px 6px; font-size: 12px; margin: 0; min-width: 100px;" onchange="taxPeriodValue = parseInt(this.value); saveLocalPeriods(); loadTaxPiggyBank().then(()=>renderTaxModalContent());">
                                ${valOptions}
                            </select>` : ''}
                            
                            ${taxPeriodType !== 'all' && taxPeriodType !== 'custom' ? `
                            <select class="input-modern" style="padding: 4px 6px; font-size: 12px; margin: 0; min-width: 80px;" onchange="taxYear = parseInt(this.value); saveLocalPeriods(); loadTaxPiggyBank().then(()=>renderTaxModalContent());">
                                ${yearOptions}
                            </select>` : ''}

                            <div style="display: ${taxPeriodType === 'custom' ? 'block' : 'none'}; margin: 0;">
                                <input type="text" id="tax-modal-date" class="input-modern" placeholder="📅 Выбрать даты..." style="width: 190px; margin: 0; font-size: 12px;">
                            </div>
                            
                            <button class="btn btn-outline" style="border-color: var(--success); color: var(--success); padding: 4px 10px; margin-left: 5px;" onclick="exportTaxToExcel()">📥 Excel</button>
                        </div>
                    </div>
                <div style="display: flex; gap: 5px; margin-bottom: 10px;">
                    <button class="btn ${currentTaxFilter === 'all' ? 'btn-gray' : 'btn-outline'}" style="padding: 4px 10px; font-size: 11px;" onclick="setTaxFilter('all')">Все</button>
                    <button class="btn ${currentTaxFilter === 'income' ? 'btn-gray' : 'btn-outline'}" style="padding: 4px 10px; font-size: 11px;" onclick="setTaxFilter('income')">⬇️ Доходы</button>
                    <button class="btn ${currentTaxFilter === 'expense' ? 'btn-gray' : 'btn-outline'}" style="padding: 4px 10px; font-size: 11px;" onclick="setTaxFilter('expense')">⬆️ Расходы</button>
                    <button class="btn ${currentTaxFilter === 'excluded' ? 'btn-gray' : 'btn-outline'}" style="padding: 4px 10px; font-size: 11px; margin-left: auto;" onclick="setTaxFilter('excluded')">🚫 Исключенные (${excludedCount})</button>
                </div>
                <div style="max-height: 480px; overflow-y: auto; border: 1px solid var(--border); border-radius: 6px;">
                    <table style="width: 100%; border-collapse: collapse; font-size: 12px;">
                        <thead style="background: var(--surface-alt); position: sticky; top: 0; box-shadow: 0 1px 0 var(--border); z-index: 10;">
                            <tr>
                                <th style="padding: 10px; text-align: left;">Учет</th>
                                <th style="padding: 10px; text-align: left;">Дата</th>
                                <th style="padding: 10px; text-align: left;">Категория</th>
                                <th style="padding: 10px; text-align: left;">Назначение</th>
                                <th style="padding: 10px; text-align: right;">Сумма</th>
                                <th style="padding: 10px; text-align: right;">Налог</th>
                            </tr>
                        </thead>
                        <tbody>${tableRows || '<tr><td colspan="6" style="padding:20px; text-align:center; color:var(--text-muted);">Операций не найдено</td></tr>'}</tbody>
                    </table>
                </div>
            </div>
            <div style="flex: 1; background: var(--surface-alt); border: 1px solid var(--border); border-radius: 8px; padding: 20px;">
                ${rightPanelHtml}
            </div>
        </div>
    `;

    const modalBody = document.getElementById('tax-modal-body');
    if (modalBody) {
        modalBody.innerHTML = bodyHtml;

        // 👇 Оживляем календарь после вставки HTML
        setTimeout(() => {
            // Запускаем календарь только если выбран режим "Произвольно"
            if (window.flatpickr && taxPeriodType === 'custom') {
                flatpickr("#tax-modal-date", {
                    mode: "range",
                    dateFormat: "Y-m-d",
                    altInput: true,
                    altFormat: "d.m.Y",
                    locale: "ru",
                    defaultDate: taxCustomStart ? [taxCustomStart, taxCustomEnd] : null,
                    onChange: async function (selectedDates, dateStr, instance) {
                        // 🛡️ ТЕПЕРЬ СРАБАТЫВАЕТ И ПРИ ВЫБОРЕ 1 ДНЯ (> 0)
                        if (selectedDates.length > 0) {
                            taxCustomStart = instance.formatDate(selectedDates[0], "Y-m-d");
                            // Если кликнули 1 раз, то конец равен началу (тот же день)
                            taxCustomEnd = selectedDates.length === 2 ? instance.formatDate(selectedDates[1], "Y-m-d") : taxCustomStart;

                            await loadTaxPiggyBank();
                            renderTaxModalContent();
                        }
                    }
                });
            }
        }, 50);
    }
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

// === ФИНАНСОВЫЙ ЗАМОК (ЗАКРЫТИЕ ПЕРИОДА) ===
window.openLockModal = function () {
    const html = `
        <div class="form-group" style="text-align: center; padding: 10px;">
            <div style="font-size: 40px; margin-bottom: 10px;">🔒</div>
            <label style="font-weight: bold; font-size: 15px;">Дата закрытия периода:</label>
            <input type="date" id="lock-date-input" class="input-modern" value="${financeLockDate || ''}" style="width: 200px; margin: 10px auto;">
            <p style="font-size: 13px; color: var(--text-muted); line-height: 1.5;">
                Все операции до этой даты (включительно) будут заморожены.<br>Их нельзя будет изменить или удалить.
            </p>
        </div>
    `;
    UI.showModal('Настройка безопасности', html, `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-outline" style="color: var(--danger); border-color: var(--danger);" onclick="saveLockDate('')">🔓 Снять защиту</button>
        <button class="btn btn-blue" onclick="saveLockDate()">🔒 Применить замок</button>
    `);
};

window.saveLockDate = async function (forcedValue = undefined) {
    // Если передано значение (например, ''), используем его. Если нет — берем из инпута.
    const date = (forcedValue !== undefined) ? forcedValue : document.getElementById('lock-date-input').value;

    // Валидация: если мы ПЫТАЕМСЯ поставить замок (не forced), но дата пуста
    if (forcedValue === undefined && !date) {
        return UI.toast('Выберите дату для установки замка!', 'warning');
    }

    try {
        await fetch('/api/finance/tax-settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: 'finance_lock_date', value: date })
        });

        financeLockDate = date; // Обновляем глобальную переменную в памяти
        UI.closeModal();

        // Умное уведомление
        if (date === '') {
            UI.toast('🔓 Финансовый замок успешно снят', 'success');
        } else {
            UI.toast(`🔒 Период до ${date} успешно закрыт`, 'success');
        }

        loadFinanceData(); // Перерисовываем таблицу для обновления иконок 🔒
    } catch (e) {
        UI.toast('Ошибка сохранения настроек доступа', 'error');
    }
};