; (function () {
    // === public/js/finance.js ===
    let currentAccounts = [];
    let financeCounterparties = [];
    let allTransactions = [];
    let currentAccountFilter = null;
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
    let financeDateRange = { start: '', end: '' }; // Оставлено для совместимости функций экспорта
    window.erpCategories = []; // 🗂️ SSoT: Единый справочник категорий для всего ERP

    async function loadFinanceCategories() {
        try {
            window.erpCategories = await API.get('/api/finance/categories?_t=' + Date.now());
        } catch (e) { console.warn('Не удалось загрузить справочник категорий', e); }
    }

    // === ГЛОБАЛЬНОЕ СОСТОЯНИЕ КАЛЕНДАРЯ ===
    let finPeriodType = 'all'; // Дефолт: За всё время
    let finPeriodValue = new Date().getMonth() + 1;
    let finYear = new Date().getFullYear();
    let finSpecificDate = new Date().toISOString().split('T')[0];
    let finCustomStart = ''; // 🚀 Начало произвольного периода
    let finCustomEnd = '';   // 🚀 Конец произвольного периода

    window.renderFinPeriodUI = function () {
        let typeOptions = `
        <option value="day" ${finPeriodType === 'day' ? 'selected' : ''}>Сегодня</option>
        <option value="week" ${finPeriodType === 'week' ? 'selected' : ''}>Текущая неделя</option>
        <option value="month" ${finPeriodType === 'month' ? 'selected' : ''}>Месяц</option>
        <option value="quarter" ${finPeriodType === 'quarter' ? 'selected' : ''}>Квартал</option>
        <option value="year" ${finPeriodType === 'year' ? 'selected' : ''}>Год</option>
        <option value="custom" ${finPeriodType === 'custom' ? 'selected' : ''}>Произвольно 📅</option>
        <option value="all" ${finPeriodType === 'all' ? 'selected' : ''}>Всё время</option>
    `;

        let valOptions = '';
        if (finPeriodType === 'quarter') {
            for (let i = 1; i <= 4; i++) valOptions += `<option value="${i}" ${finPeriodValue == i ? 'selected' : ''}>${i} Квартал</option>`;
        } else if (finPeriodType === 'month') {
            const months = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
            months.forEach((m, i) => valOptions += `<option value="${i + 1}" ${finPeriodValue == i + 1 ? 'selected' : ''}>${m}</option>`);
        }

        let yearOptions = '';
        const currentY = new Date().getFullYear();
        for (let y = currentY - 2; y <= currentY + 1; y++) yearOptions += `<option value="${y}" ${finYear == y ? 'selected' : ''}>${y} год</option>`;

        let activeInputHtml = '';
        if (finPeriodType === 'day') {
            activeInputHtml = `<input type="date" class="input-modern" style="padding: 4px 6px; font-size: 13px; border-radius: 6px; height: 32px; width: 130px;" value="${finSpecificDate}" onchange="applyFinPeriod('date', this.value)">`;
        } else if (finPeriodType === 'custom') {
            // 🚀 Поле для Flatpickr
            activeInputHtml = `<input type="text" id="fin-custom-date" class="input-modern" style="padding: 4px 6px; font-size: 13px; border-radius: 6px; height: 32px; width: 190px;" placeholder="Выберите даты...">`;
        } else if (finPeriodType !== 'all' && finPeriodType !== 'year' && finPeriodType !== 'week') {
            activeInputHtml = `<select class="input-modern" style="padding: 4px 6px; font-size: 13px; border-radius: 6px; height: 32px;" onchange="applyFinPeriod('value', this.value)">${valOptions}</select>`;
        }

        let yearHtml = '';
        if (finPeriodType !== 'all' && finPeriodType !== 'day' && finPeriodType !== 'week' && finPeriodType !== 'custom') {
            yearHtml = `<select class="input-modern" style="padding: 4px 6px; font-size: 13px; border-radius: 6px; height: 32px;" onchange="applyFinPeriod('year', this.value)">${yearOptions}</select>`;
        }

        const html = `
        <select class="input-modern" style="padding: 4px 6px; font-size: 13px; border-radius: 6px; height: 32px;" onchange="applyFinPeriod('type', this.value)">${typeOptions}</select>
        ${activeInputHtml}
        ${yearHtml}
    `;

        document.querySelectorAll('.finance-period-selector').forEach(container => {
            container.innerHTML = html;
            container.style.display = 'flex';
            container.style.gap = '8px';
        });

        // 🚀 Инициализация Flatpickr
        if (finPeriodType === 'custom') {
            setTimeout(() => {
                document.querySelectorAll('#fin-custom-date').forEach(el => {
                    if (window.flatpickr) {
                        flatpickr(el, {
                            mode: "range",
                            dateFormat: "Y-m-d",
                            altInput: true,
                            altFormat: "d.m.Y",
                            locale: "ru",
                            defaultDate: finCustomStart && finCustomEnd ? [finCustomStart, finCustomEnd] : null,
                            onChange: function (selectedDates, dateStr, instance) {
                                if (selectedDates.length === 2) {
                                    finCustomStart = instance.formatDate(selectedDates[0], "Y-m-d");
                                    finCustomEnd = instance.formatDate(selectedDates[1], "Y-m-d");
                                    applyFinPeriod('custom_range', null);
                                }
                            }
                        });
                    }
                });
            }, 50);
        }
    };

    window.applyFinPeriod = function (field, value) {
        if (field === 'type') {
            finPeriodType = value;
            if (value === 'quarter') finPeriodValue = Math.floor(new Date().getMonth() / 3) + 1;
            else if (value === 'month') finPeriodValue = new Date().getMonth() + 1;
        }
        else if (field === 'date') finSpecificDate = value;
        else if (field === 'value') finPeriodValue = parseInt(value);
        else if (field === 'year') finYear = parseInt(value);

        renderFinPeriodUI();
        currentFinancePage = 1;
        loadFinanceData();
    };

    function initStaticFinanceSelects() {
        ['finance-limit'].forEach(id => {
            const el = document.getElementById(id);
            if (el && !el.tomselect) new TomSelect(el, { plugins: ['clear_button'], allowEmptyOption: true });
        });
    }

    async function initFinance() {
        renderFinPeriodUI();
        loadFinanceData();
        initStaticFinanceSelects();
    }

    window.resetFinanceFilter = function () {
        clearTimeout(financeSearchTimer);
        const searchInput = document.getElementById('finance-search');
        if (searchInput) searchInput.value = '';

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

        currentAccountFilter = null;
        document.querySelectorAll('.account-card-modern').forEach(card => {
            card.classList.remove('selected');
        });

        // Сброс на "За всё время"
        finPeriodType = 'all';
        applyFinPeriod('type', 'all');
    };

    async function loadFinanceData() {
        try {
            const searchInput = document.getElementById('finance-search');
            const searchQuery = searchInput ? searchInput.value.trim() : '';

            // --- ЛОГИКА РАСЧЕТА ДАТ ИЗ НАЛОГОВОГО МОДУЛЯ ---
            let start = '', end = '';
            if (finPeriodType === 'day') {
                start = finSpecificDate;
                end = finSpecificDate;
            } else if (finPeriodType === 'week') {
                const now = new Date();
                const dayOfWeek = now.getDay() || 7; // Пн=1 ... Вс=7
                const monday = new Date(now);
                monday.setDate(now.getDate() - dayOfWeek + 1);
                start = monday.toISOString().split('T')[0];
                end = now.toISOString().split('T')[0];
            } else if (finPeriodType === 'year') {
                start = `${finYear}-01-01`;
                end = `${finYear}-12-31`;
            } else if (finPeriodType === 'quarter') {
                const startMonth = (finPeriodValue - 1) * 3 + 1;
                start = `${finYear}-${String(startMonth).padStart(2, '0')}-01`;
                const endDay = new Date(finYear, startMonth + 2, 0).getDate();
                end = `${finYear}-${String(startMonth + 2).padStart(2, '0')}-${endDay}`;
            } else if (finPeriodType === 'month') {
                start = `${finYear}-${String(finPeriodValue).padStart(2, '0')}-01`;
                const endDay = new Date(finYear, finPeriodValue, 0).getDate();
                end = `${finYear}-${String(finPeriodValue).padStart(2, '0')}-${endDay}`;
            } else if (finPeriodType === 'custom') {
                // 🚀 Применяем произвольные даты
                start = finCustomStart;
                end = finCustomEnd;
            }

            financeDateRange = { start, end };

            let queryParams = new URLSearchParams();
            if (start && end) {
                queryParams.append('start', start);
                queryParams.append('end', end);
            }
            if (currentAccountFilter) queryParams.append('account_id', currentAccountFilter);
            if (searchQuery) queryParams.append('search', searchQuery);

            if (currentTransTypeFilter && currentTransTypeFilter !== 'all') {
                queryParams.append('type', currentTransTypeFilter);
            }

            queryParams.append('page', currentFinancePage);
            queryParams.append('limit', currentFinanceLimit);

            const timestamp = Date.now();
            queryParams.append('_t', timestamp);

            const queryStr = `?${queryParams.toString()}`;

            let reportQueryParams = new URLSearchParams();
            if (start && end) {
                reportQueryParams.append('start', start);
                reportQueryParams.append('end', end);
            }
            if (currentAccountFilter) {
                reportQueryParams.append('account_id', currentAccountFilter);
            }
            reportQueryParams.append('_t', timestamp);

            let accUrl = `/api/accounts?_t=${timestamp}`;
            if (end) {
                accUrl += `&end=${end}`;
            }

            const [reportData, transData, currentAccounts_, catData, cpData, invData] = await Promise.all([
                API.get(`/api/report/finance?${reportQueryParams.toString()}`),
                API.get(`/api/transactions${queryStr}`),
                API.get(accUrl),
                API.get(`/api/finance/categories?_t=${timestamp}`),
                API.get(`/api/counterparties?_t=${timestamp}`),
                API.get(`/api/invoices?_t=${timestamp}`)
            ]);

            allTransactions = transData.data || transData;

            // Бэкенд (UNION ALL) уже объединяет ручные счета и долги по заказам
            financeInvoices = (invData || []).filter(i => i.status !== 'paid');
            // Сортируем (самые старые долги сверху), с защитой от null-дат
            financeInvoices.sort((a, b) => {
                const da = a.date_formatted ? new Date(a.date_formatted.split('.').reverse().join('-')) : new Date(0);
                const db = b.date_formatted ? new Date(b.date_formatted.split('.').reverse().join('-')) : new Date(0);
                return da - db;
            });

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

            currentAccounts = currentAccounts_;
            window.financeCategories = catData;
            window.erpCategories = window.financeCategories; // 🗂️ SSoT: синхронизируем глобальный справочник
            financeCounterparties = cpData;
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
            const data = await API.get('/api/finance/cashflow-forecast?_t=' + Date.now());
            if (!data || !data.forecast) return;
            const gapDay = data.forecast.find(day => day.projected_balance < 0);
            const container = document.getElementById('cashflow-widget');
            if (!container) return;

            if (gapDay) {
                const dateStr = new Date(gapDay.date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
                container.innerHTML = `
                <div class="finance-alert-danger">
                    <h4>
                        <span>⚠️</span> Угроза кассового разрыва!
                    </h4>
                    <div class="finance-alert-text">
                        По прогнозу <b>${dateStr}</b> ваш баланс уйдет в минус (<b>${Utils.formatMoney(gapDay.projected_balance)}</b>).<br>
                        Рекомендуем ускорить сбор оплат по выставленным счетам или перенести плановые расходы на более поздний срок.
                    </div>
                </div>
            `;
            } else {
                const minBalance = Math.min(...data.forecast.map(d => d.projected_balance));
                container.innerHTML = `
                <div class="finance-alert-success">
                    <h4>
                        <span>🛡️</span> Финансы в безопасности
                    </h4>
                    <div class="finance-alert-text">
                        На ближайшие 30 дней кассовых разрывов не прогнозируется.<br>
                        Минимальный расчетный остаток в этом месяце составит: <b>${Utils.formatMoney(minBalance)}</b>.
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
            <div class="summary-value" style="color: var(--success);">+${Utils.formatMoney(totalIncome)}</div>
        </div>
        <div class="summary-card security">
            <div class="summary-title">ОБЩИЙ РАСХОД</div>
            <div class="summary-value" style="color: var(--danger);">-${Utils.formatMoney(totalExpense)}</div>
        </div>
        <div class="summary-card ${profit >= 0 ? 'total' : 'security'}">
            <div class="summary-title">${profit >= 0 ? 'ОБЩАЯ ПРИБЫЛЬ' : 'УБЫТОК ПЕРИОДА'}</div>
            <div class="summary-value">${profit > 0 ? '+' : ''}${Utils.formatMoney(profit)}</div>
        </div>
    `;
    }

    // Функция отрисовки прибыли по последним сделкам
    window.renderOrderProfitability = async function () {
        try {
            const orders = await API.get('/api/analytics/profitability?_t=' + Date.now());
            const container = document.getElementById('profit-analysis-container');
            if (!container) return;

            if (!orders || orders.length === 0) {
                container.innerHTML = '<div style="color:var(--text-muted); text-align:center; padding:10px;">Нет завершенных отгрузок для анализа</div>';
                return;
            }

            let html = '<div class="finance-margin-grid">';
            orders.forEach(o => {
                const marginColor = o.margin > 30 ? 'var(--success)' : (o.margin > 15 ? 'var(--warning)' : 'var(--danger)');
                html += `
                <div class="finance-margin-card">
                    <div class="flex-1">
                        <div class="font-bold font-13">Заказ №${o.doc_number}</div>
                        <div class="font-11 text-muted">${o.client_name}</div>
                    </div>
                    <div class="flex-1 text-right">
                        <div class="font-bold text-main">${Utils.formatMoney(o.profit)}</div>
                        <div class="font-11 font-bold" style="color: ${marginColor};">Рентабельность: ${o.margin}%</div>
                    </div>
                </div>
            `;
            });
            html += '</div>';
            container.innerHTML = html;
        } catch (e) { console.error(e); }
    };

    function renderAccounts(accounts) {
        const mainAccounts = accounts.filter(acc => acc.type !== 'imprest');
        const imprestAccounts = accounts.filter(acc => acc.type === 'imprest');

        const totalImprestBalance = imprestAccounts.reduce((sum, acc) => sum + parseFloat(acc.balance || 0), 0);

        const generateHtml = (accList) => accList.map(acc => {
            const isSelected = currentAccountFilter == acc.id;
            const displayName = acc.name.replace(/\s*\(?\d{20}\)?/g, '').trim();
            const borderTopColor = acc.type === 'cash' ? 'var(--success)' : (acc.type === 'imprest' ? 'var(--warning)' : 'var(--primary)');
            const typeLabel = acc.type === 'cash' ? '💵 Наличные' : (acc.type === 'imprest' ? 'Подотчет' : '🏦 Банк');

            return `
        <div class="account-card-modern ${isSelected ? 'selected' : ''}" 
             onclick="toggleAccountFilter(${acc.id})" 
             style="border-top: 5px solid ${borderTopColor};">
            
            <div class="flex-between mb-5">
                <div style="font-size: 10px; color: var(--text-muted); font-weight: 800; text-transform: uppercase;">
                    ${typeLabel}
                </div>
                <button class="btn-close" style="font-size: 14px; opacity: 0.5;" 
                        onclick="event.stopPropagation(); openEditAccountModal(${acc.id}, '${Utils.escapeHtml(acc.name)}')" title="Настроить">⚙️</button>
            </div>
            
            <div style="font-size: 15px; font-weight: bold; margin: 5px 0;" title="${acc.name}">${displayName}</div>
            <div style="font-size: 18px; font-weight: 800; color: var(--text-main);">${Utils.formatMoney(acc.balance)}</div>
        </div>`;
        }).join('');

        let finalHtml = generateHtml(mainAccounts);

        if (imprestAccounts.length > 0) {
            finalHtml += `
        <div class="account-card-modern" onclick="showImprestBreakdown()" style="border-top: 5px solid var(--warning); cursor: pointer;" title="Суммарный остаток у всех сотрудников">
            <div class="flex-between mb-5">
                <div style="font-size: 10px; color: var(--warning); font-weight: 800; text-transform: uppercase;">
                    🙋‍♂️ Подотчет
                </div>
            </div>
            <div style="font-size: 15px; font-weight: bold; margin: 5px 0; color: var(--text-main);">Все сотрудники</div>
            <div style="font-size: 18px; font-weight: 800; color: var(--text-main);">${Utils.formatMoney(totalImprestBalance)} ₽</div>
        </div>`;
        }

        document.getElementById('accounts-container').innerHTML = finalHtml;
    }

    window.showImprestBreakdown = function () {
        const list = currentAccounts.filter(a => a.type === 'imprest' && Math.abs(parseFloat(a.balance)) > 0);
        if (list.length === 0) {
            return UI.toast('В подотчете пока нет задолженностей', 'info');
        }

        // Сортировка по размеру баланса убывающе
        list.sort((a, b) => parseFloat(b.balance) - parseFloat(a.balance));

        const html = `
        <div style="max-height: 400px; overflow-y: auto; text-align: left; background: var(--surface); border-radius: 8px;">
            <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
                <tbody>
                    ${list.map(acc => {
            const name = acc.name.replace('Подотчет: ', '');
            const balance = parseFloat(acc.balance);
            const color = balance > 0 ? 'var(--primary)' : 'var(--danger)';
            return `
                        <tr style="border-bottom: 1px solid var(--border);">
                            <td style="padding: 10px; font-weight: 600;">${name}</td>
                            <td style="padding: 10px; text-align: right; font-weight: bold; color: ${color};">
                                ${Utils.formatMoney(balance)}
                                <button class="btn btn-outline" style="padding: 2px 8px; font-size: 11px; margin-left: 10px; border-color: var(--primary); color: var(--primary);" onclick="openImprestReportModal('${acc.id}', '${name.replace(/'/g, "\\'")}', ${balance})">Отчитаться</button>
                            </td>
                        </tr>
                        `;
        }).join('')}
                </tbody>
            </table>
        </div>
    `;

        UI.showModal('🙋‍♂️ Детализация: Подотчет (Сотрудники)', html, `<button class="btn btn-outline" onclick="UI.closeModal()">Закрыть</button>`);
    };

    window.openImprestReportModal = async function (accountId, employeeName, currentBalance) {
        // 🛡️ Гарантируем загрузку справочника категорий перед открытием модалки
        if (!window.erpCategories || window.erpCategories.length === 0) {
            if (typeof loadFinanceCategories === 'function') {
                await loadFinanceCategories();
            }
        }

        const today = new Date().toISOString().split('T')[0];

        // Закрываем предыдущую модалку детализации перед открытием новой
        UI.closeModal();

        const html = `
        <div class="form-grid" style="grid-template-columns: 1fr; gap: 15px;">
            <div class="form-group flex-between" style="display: flex; justify-content: space-between; align-items: flex-end;">
                <div>
                    <label>Дата отчета:</label>
                    <input type="date" id="imprest-date" class="input-modern" value="${today}">
                </div>
                <div style="text-align: right;">
                    <label style="display: block; font-size: 13px; cursor: pointer; padding-bottom: 5px;">
                        <input type="checkbox" id="imprest-close-check"> 
                        Закрыть подотчет (остаток перенести в ЗП)
                    </label>
                </div>
            </div>
            
            <div id="imprest-items-container" style="display: flex; flex-direction: column; gap: 10px;">
                <!-- Строки расходов будут добавлены здесь -->
            </div>
            
            <button type="button" class="btn btn-outline" style="align-self: flex-start; margin-top: 5px;" onclick="addImprestRow()">➕ Добавить расход</button>
            <div style="text-align: center; color: var(--text-muted); font-size: 12px; margin-top: 10px;">
                Баланс сотрудника: <b>${Utils.formatMoney(currentBalance)}</b>
            </div>
            
        </div>
    `;

        UI.showModal(`🧾 Отчет за деньги: ${employeeName}`, html, `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-blue" onclick="submitImprestReport(${accountId}, '${employeeName.replace(/'/g, "\\'")}', ${currentBalance})">💾 Сохранить отчет</button>
    `);

        // Добавляем первую пустую строку сразу после открытия модалки
        setTimeout(() => {
            addImprestRow();
        }, 50);
    };

    window.addImprestRow = function () {
        const container = document.getElementById('imprest-items-container');
        if (!container) return;

        const rowId = 'imprest-row-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
        const div = document.createElement('div');
        div.id = rowId;
        div.className = 'imprest-item-row';

        // Универсальное извлечение категорий (защита от пустых массивов)
        const sourceCategories = (window.erpCategories && window.erpCategories.length > 0)
            ? window.erpCategories
            : (window.financeCategories || []);

        const expenseOptions = sourceCategories
            .map(c => {
                const name = typeof c === 'string' ? c : (c.name || '');
                const type = typeof c === 'string' ? 'expense' : (c.type || 'expense');
                return { name: String(name).trim(), type };
            })
            .filter(c => c.name !== '' && c.type === 'expense')
            .map(c => {
                const safeName = c.name.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                return `<option value="${safeName}">${safeName}</option>`;
            })
            .join('');

        div.innerHTML = `
        <div>
            <label style="font-size: 11px;">Сумма (₽) <span style="color:var(--danger)">*</span></label>
            <input type="text" inputmode="decimal" class="input-modern imprest-row-amount" placeholder="0.00" style="width: 100%;">
        </div>
        <div>
            <label style="font-size: 11px;">Категория <span style="color:var(--danger)">*</span></label>
            <select class="imprest-category-select imprest-row-category" placeholder="Выберите или введите..." style="width: 100%;">
                <option value=""></option>
                ${expenseOptions}
            </select>
        </div>
        <div>
            <label style="font-size: 11px;">Основание</label>
            <input type="text" class="input-modern imprest-row-desc" placeholder="Комментарий..." style="width: 100%;">
        </div>
        <div style="padding-top: 20px;">
            <button class="btn-icon" style="color: var(--danger); background: none; border: none; font-size: 16px; cursor: pointer;" onclick="document.getElementById('${rowId}').remove()" title="Удалить строку">❌</button>
        </div>
    `;

        container.appendChild(div);

        // Микро-задержка гарантирует, что DOM уже отрисован, и TomSelect корректно рассчитает ширину
        setTimeout(() => {
            const selectEl = document.getElementById(rowId).querySelector('.imprest-category-select');
            if (selectEl && !selectEl.tomselect) {
                new TomSelect(selectEl, {
                    create: true,
                    plugins: ['clear_button'],
                    dropdownParent: 'body'
                });
            }
        }, 50);
    };

    window.submitImprestReport = async function (account_id, employeeName, currentBalance) {
        const rows = document.querySelectorAll('.imprest-item-row');
        const items = [];
        let hasErrors = false;

        rows.forEach(row => {
            const amountInput = row.querySelector('.imprest-row-amount').value.toString();
            const categoryRaw = row.querySelector('.imprest-row-category').value;
            const descInput = row.querySelector('.imprest-row-desc').value.trim();

            // Пропускаем полностью пустые строки
            if (!amountInput && !categoryRaw && !descInput) return;

            let cleanAmount = amountInput.replace(/[^0-9.,]/g, '').replace(',', '.');
            const amount = parseFloat(cleanAmount);

            const category = categoryRaw ? categoryRaw.replace(/&quot;/g, '"') : '';

            if (isNaN(amount) || amount <= 0) {
                row.querySelector('.imprest-row-amount').style.borderColor = 'var(--danger)';
                hasErrors = true;
            } else {
                row.querySelector('.imprest-row-amount').style.borderColor = '';
            }

            try {
                const tsWrapper = row.querySelector('.ts-wrapper');
                if (tsWrapper) tsWrapper.style.border = category ? '' : '1px solid var(--danger)';
            } catch (e) { }

            if (!category) {
                hasErrors = true;
            }

            if (!isNaN(amount) && amount > 0 && category) {
                items.push({ amount, category, description: descInput });
            }
        });

        if (hasErrors) {
            return UI.toast('Проверьте заполнение выделенных полей', 'error');
        }

        const date = document.getElementById('imprest-date').value;
        const isClosed = document.getElementById('imprest-close-check')?.checked || false;

        if (items.length === 0) {
            if (!isClosed) {
                return UI.toast('Добавьте расходы или выберите закрытие подотчета', 'warning');
            } else {
                return UI.confirm('Вы не добавили расходов. Весь текущий остаток будет удержан из зарплаты. Подтверждаете закрытие?', async () => {
                    await sendImprestPayload({ account_id, items: [], date, employeeName, currentBalance, isClosed: true });
                });
            }
        }

        await sendImprestPayload({ account_id, items, date, employeeName, currentBalance, isClosed });

        async function sendImprestPayload(payload) {
            try {
                await API.post('/api/finance/imprest-report', payload);
                UI.closeModal();
                UI.toast('✅ Общий отчет принят', 'success');
                loadFinanceData();
            } catch (e) {
                console.error(e);
                UI.toast(e.message || 'Ошибка сохранения отчета', 'error');
            }
        }
    };

    window.toggleAccountFilter = function (account_id) {
        if (currentAccountFilter == account_id) {
            currentAccountFilter = null; // Снимаем выделение
        } else {
            currentAccountFilter = account_id; // Устанавливаем новый фильтр
        }

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
                ? `<div style="color: var(--primary); font-size: 14px; display: flex; align-items: center;">👤 ${t.counterparty_id ? `<span class="entity-link" onclick="window.app.openEntity('client', ${t.counterparty_id})">${Utils.escapeHtml(t.counterparty_name)}</span>` : Utils.escapeHtml(t.counterparty_name)} ${catBadge}</div>`
                : '';

            const systemCategories = ['Перевод', 'Техническая проводка', 'Возврат из подотчета'];
            const isSystem = systemCategories.includes(t.category);
            const categoryIcon = isSystem ? '⚙️ ' : '';

            return `
        <tr class="${isSystem ? 'tx-row-system' : ''}">
            <td class="text-center">
                ${isLocked ? '<span title="Период закрыт">🔒</span>' : `<input type="checkbox" class="trans-checkbox" value="${t.id}" onchange="toggleRowSelect(this)" ${isChecked}>`}
            </td>
            <td class="font-bold text-muted font-13">${safeDate}</td>
            <td><span class="badge" style="background: ${isIncome ? 'var(--success-bg)' : 'var(--danger-bg)'}; color: ${isIncome ? 'var(--success-text)' : 'var(--danger-text)'};">${isIncome ? 'Поступление' : 'Списание'}</span></td>
            
            <td class="font-600">
                ${htmlName}
                <div class="font-12 text-muted">${t.category ? `${categoryIcon}<span class="entity-link" onclick="window.app.navigateCategory('${t.category.replace(/'/g, "\\'")}')">${Utils.escapeHtml(t.category)}</span>` : ''}</div>
            </td>
            
            <td class="text-muted font-13">
                ${Utils.escapeHtml(t.description || '-')}
                <span class="tx-account-label" style="color: ${t.account_name ? 'var(--primary)' : 'var(--text-muted)'}">
                    ${t.account_name ? `🏦 ${Utils.escapeHtml(t.account_name)}` : '⚖️ Без движения денег (Корректировка)'}
                </span>
            </td>
            <td class="font-13">${t.payment_method}</td>
            <td class="text-right font-bold font-15" style="color: ${isIncome ? 'var(--success)' : 'var(--text-main)'}">${isIncome ? '+' : '-'}${Utils.formatMoney(t.amount)}</td>
            <td class="tx-actions-cell">
                ${receiptHtml}
                ${isLocked ?
                    `<span class="tx-locked-badge">Заблокировано</span>`
                    :
                    `<button class="btn btn-outline p-5 font-12" style="border-color: var(--primary); color: var(--primary);" onclick="openEditTransactionModal(${t.id})" title="Редактировать">✏️</button>
            <button class="btn btn-outline p-5 font-12" style="border-color: var(--danger); color: var(--danger);" onclick="deleteTransaction(${t.id})" title="Удалить">❌</button>`
                }
            </td>
        </tr>`;
        }).join('');

        // ОБНОВЛЕНИЕ ИНФО-ПАНЕЛИ (SUMMARY BAR)
        const searchInput = document.getElementById('finance-search');
        if (searchInput && typeof updateFinanceSummary === 'function') {
            updateFinanceSummary(searchInput.value.trim());
        }
    }

    window.updateFinanceSummary = function (searchValue) {
        const bar = document.getElementById('finance-summary-bar');
        if (!bar) return;

        if (!searchValue) {
            bar.classList.add('d-none');
            return;
        }

        bar.classList.remove('d-none');
        document.getElementById('summary-filter-name').innerText = searchValue;

        // Подсчет по загруженному массиву текущей страницы
        const count = allTransactions.length;
        let sum = 0;
        allTransactions.forEach(t => {
            const amt = parseFloat(t.amount) || 0;
            sum += (t.transaction_type === 'income') ? amt : -amt;
        });

        document.getElementById('summary-filter-count').innerText = count;
        // Окрашиваем сумму в зеленый или красный
        const sumEl = document.getElementById('summary-filter-sum');
        sumEl.innerText = (sum > 0 ? '+' : '') + Utils.formatMoney(sum);
        sumEl.style.color = sum >= 0 ? 'var(--success)' : 'var(--danger)';
    };

    window.resetFinanceSummary = function () {
        const input = document.getElementById('finance-search');
        if (input) input.value = '';

        const bar = document.getElementById('finance-summary-bar');
        if (bar) bar.classList.add('d-none');

        if (typeof triggerFinanceSearch === 'function') {
            triggerFinanceSearch();
        } else {
            loadFinanceData();
        }
    };

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
            await API.delete(`/api/transactions/${id}`);
            UI.toast('🗑️ Операция удалена', 'success');
            loadFinanceData();
        } catch (e) {
            console.error(e);
            UI.toast(e.message || 'Ошибка при удалении', 'error');
        }
    };

    window.openCategoriesModal = function () {
        let listHtml = window.financeCategories.map(c => `
        <div style="display: flex; justify-content: space-between; padding: 8px; border-bottom: 1px solid var(--border);">
            <span>${c.type === 'income' ? '🟢' : '🔴'} ${Utils.escapeHtml(c.name)}</span>
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
        const typeEl = document.getElementById('new-cat-type');
        const inputEl = document.getElementById('new-cat-name');

        const type = typeEl ? typeEl.value : 'expense';
        const name = inputEl ? inputEl.value.trim() : '';

        if (!name) {
            if (typeof UI !== 'undefined') UI.toast('Введите название категории', 'error');
            return;
        }

        try {
            const token = localStorage.getItem('token') || localStorage.getItem('jwtToken');
            await API.post('/api/finance/categories', { name, type });

            if (typeof UI !== 'undefined') UI.toast('Категория успешно добавлена', 'success');
            if (inputEl) inputEl.value = '';

            // Обновляем кэш вместо полного рендера страницы
            if (typeof window.financeCategories !== 'undefined') {
                window.financeCategories.push({ id: Date.now(), name: name, type: type });
            }

            openCategoriesModal();
        } catch (err) {
            console.error('[Finance] Ошибка добавления категории:', err);
            if (typeof UI !== 'undefined') UI.toast(err.message, 'error');
        }
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
        await API.delete(`/api/finance/categories/${id}`);
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
            if (methodSelect.tomselect) methodSelect.tomselect.sync();
        }
    };

    window.selectEmployeeMode = function (mode) {
        try {
            console.log('Вызван selectEmployeeMode. Режим:', mode);

            // 1. Безопасное переключение кнопок
            const lblSettlement = document.getElementById('label-emp-mode-settlement');
            const lblImprest = document.getElementById('label-emp-mode-imprest');
            const lblInstant = document.getElementById('label-emp-mode-instant');
            const lblReturn = document.getElementById('label-emp-mode-return');

            if (!lblSettlement) console.error('[DEBUG] Не найдена кнопка label-emp-mode-settlement!');
            if (!lblImprest) console.error('[DEBUG] Не найдена кнопка label-emp-mode-imprest!');
            if (!lblInstant) console.error('[DEBUG] Не найдена кнопка label-emp-mode-instant!');

            if (lblSettlement) lblSettlement.className = 'btn ' + (mode === 'settlement' ? 'btn-blue' : 'btn-outline');
            if (lblImprest) lblImprest.className = 'btn ' + (mode === 'imprest' ? 'btn-blue' : 'btn-outline');
            if (lblInstant) lblInstant.className = 'btn ' + (mode === 'instant_expense' ? 'btn-blue' : 'btn-outline');
            if (lblReturn) lblReturn.className = 'btn ' + (mode === 'return' ? 'btn-blue' : 'btn-outline');

            const radio = document.querySelector(`input[name="employee-mode"][value="${mode}"]`);
            if (!radio) console.error('[DEBUG] Не найдена radio-кнопка для режима:', mode);
            if (radio) radio.checked = true;

            // 2. Безопасный поиск элементов формы
            const typeSelect = document.getElementById('trans-type');
            const catWrapper = document.getElementById('category-wrapper');
            const categoryInput = document.getElementById('trans-category');
            const accountLabel = document.getElementById('trans-account-label');

            if (!typeSelect) console.error('[DEBUG] Не найден trans-type!');
            if (!catWrapper) console.error('[DEBUG] Не найден category-wrapper!');
            if (!categoryInput) console.error('[DEBUG] Не найден trans-category!');
            if (!accountLabel) console.error('[DEBUG] Не найден trans-account-label!');

            console.log('[DEBUG] DOM элементы:', { typeSelect, catWrapper, categoryInput, accountLabel });

            if (mode === 'imprest') {
                if (typeSelect) {
                    typeSelect.value = 'transfer'; // Подотчет - это перевод
                    typeSelect.disabled = true;
                    // Скрываем весь контейнер поля — пользователю видеть его незачем
                    const typeWrapper = typeSelect.closest('.form-group');
                    if (typeWrapper) typeWrapper.style.display = 'none';
                }
                if (catWrapper) catWrapper.style.display = 'none';

                if (categoryInput) {
                    categoryInput.value = 'Перевод';
                    categoryInput.required = false;
                }

                if (accountLabel) accountLabel.innerText = "Касса списания (Откуда):";

                const cpNameInput = document.getElementById('trans-counterparty-name');
                if (cpNameInput && cpNameInput.value && typeof updateAccountSelectForCounterparty === 'function') {
                    updateAccountSelectForCounterparty(cpNameInput.value, true);
                }
            } else if (mode === 'return') {
                if (typeSelect) {
                    typeSelect.value = 'income'; // Возврат - это доход в кассу
                    typeSelect.disabled = true;
                    const typeWrapper = typeSelect.closest('.form-group');
                    if (typeWrapper) typeWrapper.style.display = 'none';
                }
                if (catWrapper) catWrapper.style.display = 'block';
                if (categoryInput) {
                    categoryInput.required = true;
                    if (categoryInput.value === 'Перевод') categoryInput.value = '';
                }
                if (accountLabel) accountLabel.innerText = "Касса зачисления (Куда):";

                const cpNameInput = document.getElementById('trans-counterparty-name');
                if (cpNameInput && cpNameInput.value && typeof updateAccountSelectForCounterparty === 'function') {
                    updateAccountSelectForCounterparty(cpNameInput.value, true);
                }
            } else {
                // Сброс в исходное состояние
                if (typeSelect) {
                    typeSelect.disabled = false;
                    const typeWrapper = typeSelect.closest('.form-group');
                    if (typeWrapper) typeWrapper.style.display = 'block';
                }
                if (catWrapper) catWrapper.style.display = 'block';
                if (categoryInput) {
                    categoryInput.required = true;
                    if (categoryInput.value === 'Перевод') categoryInput.value = '';
                }
                if (accountLabel) accountLabel.innerText = "Счет (Откуда/Куда):";
            }

            if (typeof updateCategoryList === 'function') updateCategoryList();
        } catch (e) {
            console.error("Ошибка в selectEmployeeMode:", e);
        }
    };

    // Умный фильтр счетов в зависимости от контрагента
    window.updateAccountSelectForCounterparty = function (counterpartyName, skipModeReset = false) {
        const select = document.getElementById('trans-account-id');
        if (!select) return;

        let allowedAccounts = [...currentAccounts];

        if (counterpartyName) {
            const cp = financeCounterparties.find(c => c.name === counterpartyName);
            const modeWrapper = document.getElementById('employee-mode-wrapper');

            if (cp && cp.is_employee) {
                if (modeWrapper) modeWrapper.style.display = 'block';

                // Читаем ТЕКУЩИЙ выбранный режим — НЕ перезаписываем его
                const currentModeRadio = document.querySelector('input[name="employee-mode"]:checked');
                const currentMode = currentModeRadio ? currentModeRadio.value : 'settlement';

                // Устанавливаем settlement ТОЛЬКО при первичном выборе контрагента (если режим ещё не выбран)
                if (!skipModeReset && !document.getElementById('label-emp-mode-imprest')?.classList.contains('btn-blue')) {
                    selectEmployeeMode('settlement');
                }
            } else {
                if (modeWrapper) modeWrapper.style.display = 'none';
            }
        }

        const currentVal = select.value;
        select.innerHTML = allowedAccounts.filter(acc => acc.type === 'bank' || acc.type === 'cash').map(acc => `<option value="${acc.id}">${Utils.escapeHtml(acc.name)} (${Utils.formatMoney(acc.balance)})</option>`).join('');

        if (allowedAccounts.some(a => a.id == currentVal)) {
            select.value = currentVal;
        }

        autoSwitchPaymentMethod(select.value);
    };

    // --- ФУНКЦИЯ ПОДСТАНОВКИ КАТЕГОРИИ ---
    window.autoFillCategory = async function (counterpartyName) {
        if (typeof updateAccountSelectForCounterparty === 'function') {
            updateAccountSelectForCounterparty(counterpartyName);
        }
        if (!counterpartyName) return;

        // 1. Ищем контрагента по имени в уже загруженном списке
        const cp = financeCounterparties.find(c => c.name === counterpartyName);

        // Если не нашли (например, вписали руками нового, которого еще нет в базе) - ничего не делаем
        if (!cp || !cp.id) return;

        try {
            // 2. Отправляем запрос на бэкенд уже с правильным ID
            const data = await API.get(`/api/finance/last-category?counterparty_id=${cp.id}`);

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
        const accountOptions = currentAccounts.filter(acc => acc.type === 'bank' || acc.type === 'cash').map(acc => `<option value="${acc.id}" ${currentAccountFilter === acc.id ? 'selected' : ''}>${Utils.escapeHtml(acc.name)} (${Utils.formatMoney(acc.balance)})</option>`).join('');
        const cpOptionsList = financeCounterparties.map(cp => `<option value="${Utils.escapeHtml(cp.name)}">`).join('');

        const html = `
        <div class="form-grid" style="grid-template-columns: 1fr 1fr;">
            <div class="form-group" style="grid-column: span 2;">
                <label style="font-weight: bold; color: var(--primary);">Дата платежа:</label>
                <input type="date" id="trans-date" class="input-modern" style="font-size: 15px; font-weight: bold;" required>
            </div>
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
                <label id="trans-account-label" style="font-weight: bold; color: var(--primary);">Счет (Откуда/Куда):</label>
            <select id="trans-account-id" class="input-modern" style="font-size: 14px; font-weight: bold;" onchange="autoSwitchPaymentMethod(this.value)">
                 ${accountOptions}
            </select>
            </div>
            
            <div class="form-group" style="grid-column: span 2;">
                <label>Контрагент (Кому/От кого):</label>
                <div style="position: relative; display: inline-block; width: 100%;">
                    <input type="text" id="trans-counterparty-name" list="cp-options" class="input-modern" style="font-size: 14px; width: 100%; box-sizing: border-box;" placeholder="-- Не выбран (Внутренняя операция) --" autocomplete="off" onchange="autoFillCategory(this.value)" onfocus="this.select(); if(typeof this.showPicker === 'function') this.showPicker();">
                    <span style="position: absolute; right: 10px; top: 50%; transform: translateY(-50%); cursor: pointer; color: #64748b; font-size: 12px; padding: 5px;" onclick="this.previousElementSibling.focus();">▼</span>
                </div>
                <datalist id="cp-options">${cpOptionsList}</datalist>

                <div id="employee-mode-wrapper" style="display: none; margin-top: 10px; background: var(--surface-bg); padding: 10px; border-radius: 8px; border: 1px dashed var(--warning);">
                    <label style="font-weight: bold; color: var(--text-main); font-size: 13px; margin-bottom: 8px; display: block;">⚙️ Режим работы с сотрудником:</label>
                    <div style="display: flex; gap: 10px;">
                        <label style="flex:1; cursor:pointer;" class="btn btn-outline" id="label-emp-mode-settlement" onclick="selectEmployeeMode('settlement')">
                            <input type="radio" name="employee-mode" value="settlement" checked style="display:none;"> 💰 Расчет по ЗП
                        </label>
                        <label style="flex:1; cursor:pointer;" class="btn btn-outline" id="label-emp-mode-imprest" onclick="selectEmployeeMode('imprest')">
                            <input type="radio" name="employee-mode" value="imprest" style="display:none;"> 💳 В подотчет
                        </label>
                        <label style="flex:1; cursor:pointer;" class="btn btn-outline" id="label-emp-mode-instant" onclick="selectEmployeeMode('instant_expense')">
                            <input type="radio" name="employee-mode" value="instant_expense" style="display:none;"> 🛒 Покупка сейчас
                        </label>
                        <label style="flex:1; cursor:pointer;" class="btn btn-outline" id="label-emp-mode-return" onclick="selectEmployeeMode('return')">
                            <input type="radio" name="employee-mode" value="return" id="mode-return" style="display:none;"> 🔄 Возврат в кассу
                        </label>
                    </div>
                </div>
            </div>

            <div class="form-group" style="grid-column: span 2;">
                <label>Способ оплаты:</label>
                <select id="trans-method" class="input-modern" style="font-size: 14px;">
                    <option value="Наличные (Касса)">💵 Наличные</option>
                    <option value="Безналичный расчет">💳 Безналичный расчет (Счет)</option>
                    <option value="Перевод на карту">📱 Перевод на карту директору</option>
                </select>
            </div>
            
            <div class="form-group" id="category-wrapper" style="grid-column: span 2;">
                <label style="color: var(--primary);">Категория (Выберите из списка или впишите новую):</label>
                <div style="position: relative;">
                    <input type="text" id="trans-category" list="category-options" class="input-modern" style="font-weight: 600; width: 100%; box-sizing: border-box;" placeholder="Начните вводить или выберите..." autocomplete="off" oninput="previewCategoryMatrix(this.value)" onfocus="this.select(); if(typeof this.showPicker === 'function') this.showPicker();">
                    <span style="position: absolute; right: 8px; top: 50%; transform: translateY(-50%); cursor: pointer; color: #64748b; font-size: 10px; padding: 5px;" onclick="const inp = document.getElementById('trans-category'); inp.focus(); if(typeof inp.showPicker === 'function') inp.showPicker();">▼</span>
                </div>
                <datalist id="category-options"></datalist>
                <small id="category-matrix-preview" class="form-text mt-1" style="display:block; min-height: 20px; font-weight: bold;"></small>
            </div>
            
            <div id="cost-group-wrapper" class="form-group" style="grid-column: span 2; margin-top: 5px; background: var(--surface-alt); padding: 12px; border-radius: 8px; border: 1px dashed var(--border);">
                <label style="color: var(--primary);">🎯 Принудительная группа затрат (Исключение):</label>
                <select id="trans-cost-group" class="input-modern" style="font-size: 13px; font-weight: 600;">
                    <option value="" selected>Автоматически (По матрице)</option>
                    <option value="direct">🟢 В Прямые (COGS)</option>
                    <option value="overhead">🟠 В Оверхед (Косвенные)</option>
                    <option value="capital">🟣 В Капитал (Скрытая прибыль / Не учитывать)</option>
                </select>
                
                <label style="display: flex; align-items: center; gap: 8px; margin-top: 12px; cursor: pointer; padding: 8px; background: var(--surface); border-radius: 6px; border: 1px solid var(--border);">
                    <input type="checkbox" id="trans-remember" style="width: 16px; height: 16px; cursor: pointer;">
                    <span style="font-size: 12px; font-weight: bold; color: var(--text-main);">🤖 Запомнить правило для этого контрагента</span>
                </label>
            </div>

            <div class="form-group" style="grid-column: span 2;">
                <label>Основание (Комментарий):</label>
                <input type="text" id="trans-desc" class="input-modern" placeholder="Например: Аренда за март 2026...">
            </div>
        </div>
    `;
        UI.showModal('➕ Добавление операции', html, `<button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button><button class="btn btn-blue" onclick="saveTransaction(this)">💾 Сохранить</button>`);

        document.getElementById('trans-date').value = new Date().toISOString().split('T')[0];

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
            if (methodSelect.tomselect) methodSelect.tomselect.sync();
        }
    };

    window.updateCategoryList = function () {
        const type = document.getElementById('trans-type').value;
        const datalist = document.getElementById('category-options');

        // Оставляем в списке только категории нужного типа (доход/расход)
        const filteredCats = window.financeCategories.filter(c => c.type === type);
        datalist.innerHTML = filteredCats.map(c => `<option value="${Utils.escapeHtml(c.name)}">`).join('');

        // При переключении схода на расход очищаем поле
        const catInput = document.getElementById('trans-category');
        if (catInput) catInput.value = '';

        // Прячем выбор группы затрат (Прямые/Косвенные/Капитал) для доходов
        const costGroupWrapper = document.getElementById('cost-group-wrapper');
        const categoryMatrixPreview = document.getElementById('category-matrix-preview');
        if (costGroupWrapper) {
            if (type === 'income') {
                costGroupWrapper.style.display = 'none';
                if (categoryMatrixPreview) categoryMatrixPreview.style.display = 'none';
            } else {
                costGroupWrapper.style.display = 'block';
                if (categoryMatrixPreview) categoryMatrixPreview.style.display = 'block';
            }
        }
    };

    window.previewCategoryMatrix = async function (categoryName) {
        const previewEl = document.getElementById('category-matrix-preview');
        if (!previewEl) return;

        if (!categoryName || categoryName.trim() === '') {
            previewEl.innerHTML = '';
            return;
        }

        try {
            const data = await API.get('/api/finance/category-info?name=' + encodeURIComponent(categoryName));
            if (data.cost_group) {
                let groupName = 'OPEX (Косвенные)';
                let color = 'var(--text-main)';
                if (data.cost_group === 'direct') { groupName = 'COGS (Прямые)'; color = 'var(--success)'; }
                else if (data.cost_group === 'overhead' || data.cost_group === 'opex') { groupName = 'OPEX (Косвенные)'; color = 'var(--warning)'; }
                else if (data.cost_group === 'capital') { groupName = 'CAPEX (Капитал)'; color = 'var(--primary)'; }

                previewEl.innerHTML = `<span style="color: ${color};">📌 Автоматически: ${Utils.escapeHtml(groupName)}</span>`;
            } else {
                previewEl.innerHTML = `<span style="color: var(--text-muted);">📌 Новая категория (будет создана)</span>`;
            }
        } catch (e) {
            previewEl.innerHTML = '';
        }
    };

    window.saveTransaction = async function (btnElement) {
        if (btnElement) btnElement.disabled = true; // 🛡️ Блокируем кнопку от двойного клика

        const type = document.getElementById('trans-type').value;
        const date = document.getElementById('trans-date').value;
        const amount = parseFloat(document.getElementById('trans-amount').value);
        const method = document.getElementById('trans-method').value;
        const category = document.getElementById('trans-category').value.trim();
        const desc = document.getElementById('trans-desc').value.trim();
        const account_id = document.getElementById('trans-account-id').value;
        const cpNameInput = document.getElementById('trans-counterparty-name').value.trim();

        // Получаем текущий режим выбора сотрудника, если он есть
        const empModeInput = document.querySelector('input[name="employee-mode"]:checked');
        const employee_mode = empModeInput ? empModeInput.value : 'settlement';
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
        if (!category && (type === 'income' || type === 'expense')) {
            if (btnElement) btnElement.disabled = false;
            return UI.toast('Укажите категорию!', 'error');
        }

        // Автоматическая подстановка категории для переводов, если пусто
        const finalCategory = (!category && type === 'transfer') ? 'Перевод' : category;

        // === АВТО-СОЗДАНИЕ КАТЕГОРИИ ===
        const isCategoryExists = window.financeCategories.some(c => c.name.toLowerCase() === finalCategory.toLowerCase() && c.type === type);
        if (!isCategoryExists && finalCategory !== 'Перевод') {
            try {
                await API.post('/api/finance/categories', { name: finalCategory, type: type });
            } catch (e) { console.error("Ошибка сохранения категории", e); }
        }

        // 🚀 ДОБАВИЛИ ЧТЕНИЕ НОВЫХ ПОЛЕЙ ИЗ ФОРМЫ
        const costGroupEl = document.getElementById('trans-cost-group');
        const rememberEl = document.getElementById('trans-remember');
        const cost_group_override = costGroupEl ? (costGroupEl.value || null) : null;
        const remember_rule = rememberEl ? rememberEl.checked : false;

        try {
            await API.post('/api/transactions', {
                amount,
                type,
                date,
                category: finalCategory,
                description: desc,
                method,
                account_id,
                counterparty_id,
                employee_mode,
                cost_group_override: cost_group_override,
                remember_rule: remember_rule
            });

            // Если дошли сюда — значит сервер ответил 200 OK
            UI.closeModal();
            UI.toast('✅ Операция успешно сохранена', 'success');
            loadFinanceData();

        } catch (e) {
            // Вся обработка ошибок (400, 500, нет сети) теперь здесь
            console.error("Ошибка сохранения транзакции:", e);
            UI.toast(e.message || 'Ошибка сохранения транзакции', 'error');
        } finally {
            if (btnElement) btnElement.disabled = false; // 🛡️ Разблокируем кнопку в любом случае
        }
    };

    window.openTransferModal = function () {
        if (currentAccounts.length < 2) return UI.toast('Нужно минимум 2 счета!', 'warning');
        const options = currentAccounts.map(acc => `<option value="${acc.id}">${Utils.escapeHtml(acc.name)} (${Utils.formatMoney(acc.balance)})</option>`).join('');

        const html = `
        <div class="form-group"><label>Дата перевода:</label><input type="date" id="transfer-date" class="input-modern" required></div>
        <div class="form-group"><label>Списать с:</label><select id="transfer-from" class="input-modern">${options}</select></div>
        <div class="form-group"><label>Зачислить на:</label><select id="transfer-to" class="input-modern">${options}</select></div>
        <div class="form-group"><label>Сумма:</label><input type="number" id="transfer-amount" class="input-modern"></div>
        <div class="form-group"><label>Комментарий:</label><input type="text" id="transfer-desc" class="input-modern"></div>
    `;
        UI.showModal('🔄 Перевод', html, `<button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button><button class="btn btn-blue" onclick="executeTransfer()">💸 Выполнить</button>`);
        document.getElementById('transfer-date').value = new Date().toISOString().split('T')[0];
    };

    window.executeTransfer = async function () {
        const from_account_id = document.getElementById('transfer-from').value;
        const to_account_id = document.getElementById('transfer-to').value;
        const amount = parseFloat(document.getElementById('transfer-amount').value);
        const date = document.getElementById('transfer-date').value;
        const description = document.getElementById('transfer-desc').value.trim();

        if (from_account_id === to_account_id) return UI.toast('Выберите разные счета!', 'error');

        try {
            await API.post('/api/transactions/transfer', { from_account_id, to_account_id, amount, description, date });
            UI.closeModal();
            UI.toast('✅ Переведено', 'success');
            loadFinanceData();
        } catch (e) {
            console.error(e);
            UI.toast(e.message || 'Ошибка при выполнении перевода', 'error');
        }
    };

    /// === ОТКРЫТИЕ ОКНА РЕДАКТИРОВАНИЯ ===
    window.updateEditAccountSelectForCounterparty = function (counterpartyName) {
        const select = document.getElementById('edit-trans-account');
        if (!select) return;

        let allowedAccounts = currentAccounts.filter(a => a.type !== 'imprest');

        if (counterpartyName) {
            const cp = financeCounterparties.find(c => c.name === counterpartyName);
            if (cp && cp.is_employee) {
                const impName = 'Подотчет: ' + cp.name;
                const empAccount = currentAccounts.find(a => a.type === 'imprest' && a.name === impName);
                if (empAccount) allowedAccounts.push(empAccount);
            }
        }

        const currentVal = select.value;
        select.innerHTML = '<option value="">-- ⚖️ Без движения денег (Корректировка) --</option>' +
            allowedAccounts.map(acc => `<option value="${acc.id}">${Utils.escapeHtml(acc.name)} (${Utils.formatMoney(acc.balance)})</option>`).join('');

        if (allowedAccounts.some(a => a.id == currentVal)) {
            select.value = currentVal;
        } else {
            select.value = "";
        }
    };

    window.openEditTransactionModal = function (id) {
        const tr = allTransactions.find(t => t.id === id);
        if (!tr) return;

        const currentCp = financeCounterparties.find(cp => cp.id == tr.counterparty_id);
        const currentCpName = currentCp ? currentCp.name : '';

        // 1. Формируем первоначальный список счетов
        let allowedAccounts = currentAccounts.filter(a => a.type !== 'imprest');
        if (currentCp && currentCp.is_employee) {
            const impName = 'Подотчет: ' + currentCp.name;
            const empAccount = currentAccounts.find(a => a.type === 'imprest' && a.name === impName);
            if (empAccount) allowedAccounts.push(empAccount);
        }

        const accountOptions = `
        <option value="">-- ⚖️ Без движения денег (Корректировка) --</option>
        ${allowedAccounts.map(acc => `
            <option value="${acc.id}" ${tr.account_id == acc.id ? 'selected' : ''}>
                ${Utils.escapeHtml(acc.name)}
            </option>`).join('')}
    `;

        // 2. Умный список контрагентов (datalist)
        const cpOptionsList = financeCounterparties.map(cp => `<option value="${cp.name.replace(/"/g, '&quot;')}">`).join('');

        // 3. Формируем список категорий (catOptions)
        const filteredCats = window.financeCategories.filter(c => c.type === tr.transaction_type);
        const catOptions = filteredCats.map(c => `<option value="${c.name.replace(/"/g, '&quot;')}">`).join('');

        // 🚀 ЛОГИКА ДЛЯ ПАНЕЛИ "ТЕКУЩЕЕ СОСТОЯНИЕ"
        let groupColor = 'var(--warning)';
        let groupName = '🟠 Оверхед (Косвенные)';
        let groupBg = 'var(--warning-bg)';

        if (tr.current_cost_group === 'direct') {
            groupColor = 'var(--success)';
            groupName = '🟢 Прямые затраты (COGS)';
            groupBg = 'var(--success-bg)';
        } else if (tr.current_cost_group === 'capital') {
            groupColor = '#8b5cf6';
            groupName = '🟣 Капитал (Скрытые / Не в себестоимости)';
            groupBg = '#f3e8ff';
        }

        const overrideBadge = tr.cost_group_override
            ? `<span style="font-size: 10px; background: rgba(0,0,0,0.1); padding: 3px 6px; border-radius: 4px; margin-left: 10px;">🎯 Задано вручную</span>`
            : `<span style="font-size: 10px; background: rgba(0,0,0,0.05); padding: 3px 6px; border-radius: 4px; margin-left: 10px; color: var(--text-muted);">⚙️ По матрице</span>`;

        const html = `
        ${tr.transaction_type === 'income' ? '' : `
        <div style="background: ${groupBg}; padding: 12px 15px; border-radius: 8px; border: 1px solid ${groupColor}; margin-bottom: 20px; display: flex; justify-content: space-between; align-items: center;">
            <div>
                <div style="font-size: 11px; color: var(--text-muted); text-transform: uppercase; font-weight: bold; margin-bottom: 4px;">Текущая группа в Unit-экономике:</div>
                <div style="font-size: 14px; font-weight: bold; color: ${groupColor}; display: flex; align-items: center;">
                    ${groupName} ${overrideBadge}
                </div>
            </div>
        </div>
        `}

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
                <div style="position: relative; display: inline-block; width: 100%;">
                    <input type="text" id="edit-trans-category" list="edit-category-options" class="input-modern" 
                           value="${tr.category || ''}" style="font-weight: 600; width: 100%; box-sizing: border-box;" 
                           autocomplete="new-password" 
                           onfocus="this.select(); if(typeof this.showPicker === 'function') this.showPicker();"> 
                    <span style="position: absolute; right: 10px; top: 50%; transform: translateY(-50%); cursor: pointer; color: #64748b; font-size: 12px; padding: 5px;" onclick="this.previousElementSibling.focus();">▼</span>
                </div>
                <datalist id="edit-category-options">${catOptions}</datalist>
            </div>

            <div class="form-group">
                <label>Счет (Банк/Касса):</label>
                <select id="edit-trans-account" class="input-modern">${accountOptions}</select>
            </div>

            <div class="form-group">
                <label>Контрагент:</label>
                <div style="position: relative; display: inline-block; width: 100%;">
                    <input type="text" id="edit-trans-cp-name" list="edit-cp-options" class="input-modern" style="width: 100%; box-sizing: border-box;"
                           onchange="updateEditAccountSelectForCounterparty(this.value)"
                           value="${currentCpName.replace(/"/g, '&quot;')}" placeholder="-- Внутренняя операция --" autocomplete="off" onfocus="this.select(); if(typeof this.showPicker === 'function') this.showPicker();">
                    <span style="position: absolute; right: 10px; top: 50%; transform: translateY(-50%); cursor: pointer; color: #64748b; font-size: 12px; padding: 5px;" onclick="this.previousElementSibling.focus();">▼</span>
                </div>
                <datalist id="edit-cp-options">${cpOptionsList}</datalist>
            </div>

            ${tr.transaction_type === 'income' ? '' : `
            <div class="form-group" style="grid-column: span 2; margin-top: 5px; background: var(--surface-alt); padding: 12px; border-radius: 8px; border: 1px dashed var(--border);">
                <label style="color: var(--primary);">🎯 Принудительная группа затрат (Исключение):</label>
                <select id="edit-tx-cost-group" class="input-modern" style="font-size: 13px; font-weight: 600;">
                    <option value="" ${!tr.cost_group_override ? 'selected' : ''}>Автоматически (По матрице)</option>
                    <option value="direct" ${tr.cost_group_override === 'direct' ? 'selected' : ''}>🟢 В Прямые (COGS)</option>
                    <option value="overhead" ${tr.cost_group_override === 'overhead' ? 'selected' : ''}>🟠 В Оверхед (Косвенные)</option>
                    <option value="capital" ${tr.cost_group_override === 'capital' ? 'selected' : ''}>🟣 В Капитал (Скрытая прибыль / Не учитывать)</option>
                </select>
                
                <label style="display: flex; align-items: center; gap: 8px; margin-top: 12px; cursor: pointer; padding: 8px; background: var(--surface); border-radius: 6px; border: 1px solid var(--border);">
                    <input type="checkbox" id="edit-tx-remember" style="width: 16px; height: 16px; cursor: pointer;">
                    <span style="font-size: 12px; font-weight: bold; color: var(--text-main);">🤖 Запомнить правило для этого контрагента</span>
                </label>
            </div>
            `}
        </div>
    `;

        UI.showModal('✏️ Редактирование платежа', html, `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-blue" onclick="saveEditedTransaction(${id})">💾 Сохранить изменения</button>
    `);
    };

    // 🚀 ОБНОВЛЕННАЯ ФУНКЦИЯ СОХРАНЕНИЯ (Добавь её сразу под окном)
    window.saveEditedTransaction = async function (id) {
        const cpName = document.getElementById('edit-trans-cp-name').value.trim();
        let cpId = null;
        if (cpName) {
            const foundCp = financeCounterparties.find(c => c.name === cpName);
            if (foundCp) cpId = foundCp.id;
        }

        const payload = {
            description: document.getElementById('edit-trans-desc').value.trim(),
            amount: parseFloat(document.getElementById('edit-trans-amount').value),
            category: document.getElementById('edit-trans-category').value.trim(),
            account_id: document.getElementById('edit-trans-account').value || null,
            counterparty_id: cpId,
            transaction_date: document.getElementById('edit-trans-date').value,

            // Передаем новые параметры на бэкенд
            cost_group_override: document.getElementById('edit-tx-cost-group') ? (document.getElementById('edit-tx-cost-group').value || null) : null,
            remember_rule: document.getElementById('edit-tx-remember') ? document.getElementById('edit-tx-remember').checked : false
        };

        try {
            await API.put(`/api/transactions/${id}`, payload);
            UI.closeModal();
            UI.toast('✅ Платеж успешно обновлен', 'success');
            // Вызываем функцию обновления таблицы транзакций (замени на свою, если называется иначе)
            if (typeof loadTransactions === 'function') loadTransactions();
            if (typeof loadFinanceData === 'function') loadFinanceData();
        } catch (e) { console.error(e); }
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
        <div class="flex-col gap-15">
            <div class="cp-modal-filter-bar">
                <div class="cp-modal-filter-flex">
                    <input type="text" id="cp-search" class="input-modern" placeholder="🔍 Поиск по имени или ИНН..." 
                           oninput="updateCPList()" style="margin:0; background: var(--surface);">
                </div>
                <select id="cp-filter-type" class="input-modern" onchange="updateCPList()" style="width: auto; margin:0; background: var(--surface);">
                    <option value="all">Все типы</option>
                    <option value="Покупатель">Покупатели</option>
                    <option value="Поставщик">Поставщики</option>
                    <option value="Сотрудник">👔 Сотрудники</option>
                </select>
                <select id="cp-sort" class="input-modern" onchange="updateCPList()" style="width: auto; margin:0; background: var(--surface);">
                    <option value="last_date_desc">🕒 Свежие операции</option>
                    <option value="last_date_asc">⏳ Старые операции</option>
                    <option value="turnover">💰 Наибольший оборот</option>
                    <option value="income">📈 По доходу (Нам)</option>
                    <option value="expense">📉 По расходу (От нас)</option>
                    <option value="name">🔤 По алфавиту (А-Я)</option>
                </select>
                <button class="btn btn-blue" onclick="openAdvancedCPCard(0, document.getElementById('cp-search')?.value?.trim() || '')">➕ Создать</button>
            </div>

            <div id="cp-list-container" class="cp-list-container">
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
            let matchesType = true;
            if (cpTypeFilter === 'Сотрудник') {
                matchesType = c.is_employee === true;
            } else if (cpTypeFilter !== 'all') {
                matchesType = c.type === cpTypeFilter;
            }
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
        <div class="cp-card-box">  
            <div style="flex: 2; min-width: 0; padding-right: 15px;">
                <div class="flex-row align-center gap-5 mb-5">
                    <span class="cp-flag-badge" style="background: ${c.type === 'Покупатель' ? 'var(--success-bg)' : 'var(--surface-alt)'}; color: ${c.type === 'Покупатель' ? 'var(--success)' : 'var(--primary)'};">
                        ${c.type || 'Не задан'}
                    </span>
                    ${c.is_employee ? `<span class="cp-flag-badge" style="background: var(--warning-bg, #fff3cd); color: var(--warning, #856404); border-color: var(--warning, #856404);">👔 Сотрудник</span>` : ''}
                    <div class="font-bold font-15 text-main flex-between flex-1" style="overflow: hidden;">
                        <span class="dash-text-ellipsis mr-10" title="${c.name}">
                        ${c.id ? `<span class="entity-link" onclick="window.app.openEntity('client', ${c.id})">${Utils.escapeHtml(c.name)}</span>` : Utils.escapeHtml(c.name || '')}
                        </span>
                        <span style="flex-shrink: 0;">
                            ${window.getCategoryBadge(c.client_category)}
                        </span>
                    </div>
                </div>
                <div class="font-12 text-muted flex-row gap-15">
                    <span>${c.inn ? `<b>ИНН:</b> ${c.inn}` : '<i>Без ИНН</i>'}</span>
                    <span>${c.phone ? `📞 ${c.phone}` : ''}</span>
                </div>
            </div>

            <div class="cp-card-stat">
                <div class="font-11 text-muted mb-5">Последняя операция:</div>
                <div class="font-13 font-bold" style="color: ${c.last_transaction_date ? 'var(--text-main)' : 'var(--text-muted)'};">${lastDate}</div>
            </div>

            <div class="cp-card-money">
                <div class="font-12 font-bold text-success">📈 +${Utils.formatMoney(c.total_paid_to_us || 0)}</div>
                <div class="font-12 font-bold text-danger">📉 -${Utils.formatMoney(c.total_paid_by_us || 0)}</div>
            </div>

            <div class="pl-15 flex-row gap-5">
                <button class="btn btn-blue p-5 font-13" onclick="openCounterpartyProfile(${c.id})" title="Открыть карточку">📂 Открыть</button>
            </div>
        </div>
    `;
        }).join('');

        setTimeout(() => {
            ['cp-filter-type', 'cp-sort'].forEach(id => {
                const el = document.getElementById(id);
                if (el && !el.tomselect) new TomSelect(el, { plugins: ['clear_button'] });
            });
        }, 50);
        setTimeout(() => {
            ['cp-filter-type', 'cp-sort'].forEach(id => {
                const el = document.getElementById(id);
                if (el && !el.tomselect) new TomSelect(el, { plugins: ['clear_button'] });
            });
        }, 50);
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
            await API.delete(`/api/counterparties/${id}`);
            await loadFinanceData();
            openCounterpartiesModal();
        } catch (e) { console.error(e); }
    };

    // === УМНОЕ ВЫСТАВЛЕНИЕ СЧЕТА ИЗ ФИНАНСОВ ===
    window.toggleFinInvoiceType = function () {
        const type = document.getElementById('fin-invoice-type').value;
        document.getElementById('fin-general-block').style.display = type === 'general' ? 'block' : 'none';
        document.getElementById('fin-order-block').style.display = type === 'order' ? 'block' : 'none';
        const contractBlock = document.getElementById('fin-contract-block');
        if (contractBlock) contractBlock.style.display = type === 'contract' ? 'block' : 'none';
    };

    window.openFinanceInvoiceModal = async function (cpId, cpName) {
        let ordersHtml = '<option value="">-- У клиента нет активных заказов --</option>';
        let contractsHtml = '<option value="">-- У клиента нет договоров --</option>';

        try {
            const allOrders = await API.get('/api/sales/orders');
            const clientOrders = allOrders.filter(o => o.counterparty_id === cpId);
            if (clientOrders.length > 0) {
                ordersHtml = clientOrders.map(o => `<option value="${o.doc_number}">Заказ №${o.doc_number} (на ${Utils.formatMoney(o.total_amount)})</option>`).join('');
            }


            const clientContracts = await API.get(`/api/counterparties/${cpId}/contracts`);
            if (clientContracts.length > 0) {
                contractsHtml = clientContracts.map(c => `<option value="${c.contract_id}">Договор №${c.contract_number} от ${c.contract_date}</option>`).join('');
            }
        } catch (e) { console.error('Ошибка загрузки связей:', e); }

        const html = `
        <div style="padding: 10px;">
            <h4 style="margin-top:0; color:var(--primary); margin-bottom: 15px;">Контрагент: ${cpName}</h4>

            <div class="form-group" style="margin-bottom: 15px;">
                <label style="color: var(--warning-text); font-weight: bold;">Тип счета:</label>
                <select id="fin-invoice-type" class="input-modern" onchange="toggleFinInvoiceType()">
                    <option value="general">Свободный счет (Пополнение баланса / Аванс)</option>
                    <option value="order">Привязать к существующему Заказу</option>
                    <option value="contract">Привязать к существующему Договору</option>
                </select>
            </div>

            <div id="fin-general-block" style="background: var(--surface-alt); padding: 10px; border-radius: 6px; border: 1px solid var(--border);">
                <div class="form-group">
                    <label>Сумма счета (₽): <span style="color:var(--danger)">*</span></label>
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

            <div id="fin-contract-block" style="display: none; background: var(--surface-alt); padding: 10px; border-radius: 6px; border: 1px solid var(--success);">
                <div class="form-group">
                    <label>Выберите договор:</label>
                    <select id="fin-invoice-contract" class="input-modern">${contractsHtml}</select>
                </div>
                <div class="form-group" style="margin-top: 10px;">
                    <label>Сумма счета (₽): <span style="color:var(--danger)">*</span></label>
                    <input type="number" id="fin-contract-custom-amount" class="input-modern" placeholder="Например: 50000">
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
        <button class="btn btn-blue" onclick="executeFinanceInvoice(${cpId}, this)">🖨️ Сгенерировать PDF</button>
    `);

        setTimeout(() => {
            ['fin-invoice-order', 'fin-invoice-contract'].forEach(id => {
                const el = document.getElementById(id);
                if (el && !el.tomselect) new TomSelect(el, { plugins: ['clear_button'], dropdownParent: 'body' });
            });
        }, 50);
    };

    window.executeFinanceInvoice = async function (cpId, btnElement) {
        if (btnElement) btnElement.disabled = true;

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

                const num = `СЧ-${new Date().getTime().toString().slice(-6)}`;

                await API.post('/api/invoices', { cp_id: cpId, amount, desc, num });
                window.open(`/print/invoice?cp_id=${cpId}&amount=${amount}&desc=${encodeURIComponent(desc)}&bank=${bank}&num=${num}&token=${localStorage.getItem('token')}`, '_blank');
                UI.closeModal();
                UI.toast('✅ Счет выставлен и занесен в базу', 'success');
                if (typeof loadFinanceData === 'function') loadFinanceData();

            } else if (type === 'order') {
                const docNum = document.getElementById('fin-invoice-order').value;
                const customAmt = document.getElementById('fin-order-custom-amount').value;

                if (!docNum) {
                    UI.toast('Выберите заказ из списка', 'warning');
                    if (btnElement) btnElement.disabled = false;
                    return;
                }
                window.open(`/print/invoice?docNum=${docNum}&bank=${bank}&custom_amount=${customAmt}&token=${localStorage.getItem('token')}`, '_blank');
                UI.closeModal();

            } else if (type === 'contract') {
                const contractId = document.getElementById('fin-invoice-contract').value;
                const customAmt = document.getElementById('fin-contract-custom-amount').value;

                if (!contractId || !customAmt || customAmt <= 0) {
                    UI.toast('Выберите договор и укажите сумму', 'warning');
                    if (btnElement) btnElement.disabled = false;
                    return;
                }

                const num = `СЧ-${new Date().getTime().toString().slice(-6)}`;
                const desc = "Оплата по договору";

                await API.post('/api/invoices', { cp_id: cpId, amount: customAmt, desc: desc, num: num });
                window.open(`/print/invoice?contractId=${contractId}&cp_id=${cpId}&amount=${customAmt}&bank=${bank}&num=${num}&token=${localStorage.getItem('token')}`, '_blank');
                UI.closeModal();
                UI.toast('✅ Счет по договору выставлен', 'success');
                if (typeof loadFinanceData === 'function') loadFinanceData();
            }
        } catch (e) { console.error(e); } finally {
            if (btnElement) btnElement.disabled = false;
        }
    };

    window.executePrintInvoice = function (docNum) {
        const bank = document.getElementById('invoice-bank').value;
        window.open(`/print/invoice?docNum=${docNum}&bank=${bank}&token=${localStorage.getItem('token')}`, '_blank');
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
            container.classList.add('d-none');
            return;
        }

        container.classList.remove('d-none');
        tbody.innerHTML = financeInvoices.map(inv => `
        <tr style="${inv.is_order ? 'background: rgba(0, 123, 255, 0.03);' : ''}">
            <td style="font-size: 13px; color: var(--text-muted); font-weight: bold;">${inv.date_formatted}</td>
            
            <td style="font-weight: bold;">
                № ${inv.id ? `<span class="entity-link cursor-pointer text-primary" onclick="${inv.is_order ? `openOrderDetails(${inv.id})` : `window.app.openEntity('document_invoice', ${inv.id})`}" title="Открыть документ">${inv.invoice_number}</span>` : inv.invoice_number}
            </td>
            
            <td style="color: var(--primary); font-weight: 600;">
                👤 <span class="entity-link cursor-pointer text-primary" onclick="openCounterpartyProfile(${inv.counterparty_id})" title="Открыть карточку клиента">${inv.counterparty_name}</span>
            </td>
            
            <td style="font-size: 13px;">${inv.description}</td>
            <td style="text-align: right; font-weight: bold; font-size: 15px; color: var(--warning-text);">${Utils.formatMoney(inv.amount)}</td>
            
            <td style="text-align: center; display: flex; gap: 5px; justify-content: center;">
                <button class="btn btn-blue" style="padding: 4px 10px; font-size: 12px;" onclick="markInvoicePaidModal(${inv.id}, ${inv.is_order ? 'true' : 'false'})" title="Подтвердить оплату от клиента">✅ Оплачен</button>
                ${!inv.is_order ? `<button class="btn btn-outline" style="padding: 4px 8px; font-size: 12px; border-color: var(--danger); color: var(--danger);" onclick="deleteInvoice(${inv.id})" title="Удалить счет">❌</button>` : ''}
            </td>
        </tr>
    `).join('');
    }

        window.toggleAccountSelector = function(checked) {
        const dd = document.getElementById('pay-account-dropdown');
        if (dd) dd.style.display = checked ? 'none' : 'block';
    }
    
    window.checkSaldoWarning = function(saldo, amount) {
        const warn = document.getElementById('saldo-warning');
        if(warn) {
            warn.style.display = (parseFloat(amount) > parseFloat(saldo)) ? 'block' : 'none';
        }
    }

    window.markInvoicePaidModal = async function (id, isOrder = false) {
        const doc = financeInvoices.find(inv => inv.id === id && inv.is_order === isOrder);
        const currentDebt = doc ? doc.amount : 0;

        let clientSaldo = 0;
        if (doc && doc.counterparty_id) {
            try {
                const res = await fetch(`/api/counterparties/${doc.counterparty_id}/profile`, { headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }});
                if(res.ok) {
                    const data = await res.json();
                    // Переплата = клиент заплатил больше, чем мы отгрузили (saldo < 0)
                    let rawOverpayment = 0;
                    if(data.overpayment && data.overpayment > 0) {
                        rawOverpayment = data.overpayment;
                    } else if(data.finances && parseFloat(data.finances.balance) < 0) {
                        rawOverpayment = Math.abs(parseFloat(data.finances.balance));
                    }
                    // Вычитаем долг текущего заказа: аванс уже занят этим заказом, не считаем его "свободным"
                    clientSaldo = Math.max(0, rawOverpayment - currentDebt);
                }
            } catch(e) { console.error('Failed to get saldo'); }
        }

        const options = currentAccounts.filter(acc => acc.type === 'bank' || acc.type === 'cash').map(acc => `<option value="${acc.id}">${acc.name} (${Utils.formatMoney(acc.balance)})</option>`).join('');

        const html = `
        <div class="form-grid" style="grid-template-columns: 1fr; gap: 15px;">
            <div class="form-group" style="background: var(--surface-alt); padding: 15px; border-radius: 8px; border: 1px dashed var(--border);">
                <label style="font-weight: bold; color: var(--primary);">Сумма (₽):</label>
                <input type="number" id="pay-inv-amount" class="input-modern" value="${currentDebt}" style="font-size: 18px; font-weight: bold; margin-top: 5px;" ${clientSaldo > 0 ? `oninput="checkSaldoWarning(${clientSaldo}, this.value)"` : ''}>
                <small class="text-muted">Остаток по документу: ${Utils.formatMoney(currentDebt)}</small>
            </div>
            
            ${clientSaldo > 0 ? `
            <div style="background: var(--primary-light, #e3f2fd); padding: 15px; border-radius: 8px; border: 1px solid var(--primary);">
                <label style="display: flex; align-items: start; gap: 10px; cursor: pointer; margin: 0;">
                    <input type="checkbox" id="pay-inv-offset" onchange="toggleAccountSelector(this.checked)" style="margin-top: 4px; width: 18px; height: 18px;">
                    <div>
                        <div style="font-weight: bold; color: var(--primary-dark, #0d47a1); font-size: 15px;">Зачесть из переплаты клиента</div>
                        <div style="color: var(--primary); font-size: 13px; margin-top: 2px;">Доступно: ${Utils.formatMoney(clientSaldo)} ₽. Деньги не будут зачислены в кассу.</div>
                        <div id="saldo-warning" style="display: none; color: var(--danger); font-size: 12px; margin-top: 5px; font-weight: bold;">⚠ Внимание: сумма зачета превышает переплату!</div>
                    </div>
                </label>
            </div>
            ` : ''}

            <div class="form-group" id="pay-account-dropdown">
                <label style="font-weight: bold;">На какой счет упали деньги?</label>
                <select id="pay-inv-account" class="input-modern" style="margin-top: 5px;">${options}</select>
            </div>
        </div>
    `;
        UI.showModal('✅ Подтверждение оплаты', html, `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
       <button class="btn btn-blue" id="pay-confirm-btn" onclick="executeInvoicePay(${id}, ${isOrder}, this)">💰 Подтвердить</button>
    `);

        setTimeout(() => {
            const el = document.getElementById('pay-inv-account');
            if (el && !el.tomselect) new TomSelect(el, { plugins: ['clear_button'], dropdownParent: 'body' });
        }, 50);
    };

        window.executeInvoicePay = async function (id, isOrder, btnElement) {
        const offsetCheck = document.getElementById('pay-inv-offset');
        const useOffset = offsetCheck ? offsetCheck.checked : false;
        
        const accountEl = document.getElementById('pay-inv-account');
        const account_id = accountEl ? accountEl.value : null;
        const amount = parseFloat(document.getElementById('pay-inv-amount').value);

        if (!amount || amount <= 0) return UI.toast('Введите корректную сумму', 'warning');
        if (!useOffset && !account_id) return UI.toast('Выберите кассу', 'warning');
        
        if (btnElement) btnElement.disabled = true;

        try {
            await API.post(`/api/invoices/${id}/pay`, { account_id: useOffset ? null : account_id, is_order: isOrder, amount, use_offset: useOffset });
            UI.closeModal();
            UI.toast(useOffset ? '✅ Зачет успешен' : '✅ Оплата зачислена', 'success');
            if (typeof loadFinanceData === 'function') loadFinanceData();
        } catch (e) { console.error(e); } finally {
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
            const data = await API.delete(`/api/invoices/${id}`);
            if (data.action === 'deleted') {
                UI.toast('Счет полностью удален, нумерация восстановлена', 'success');
            } else if (data.action === 'cancelled') {
                UI.toast('Счет аннулирован (скрыт), так как после него уже выписаны другие', 'success');
            }
            loadFinanceData();
        } catch (e) {
            console.error(e);
            UI.toast(e.message || 'Ошибка при удалении счета', 'error');
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
        infoDiv.innerHTML = `Файл: <b>${Utils.escapeHtml(file.name)}</b> ⏳ Распознаем банк...`;

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

    // 🚀 Улучшенная функция предпросмотра с детектором конфликтов
    window.executeBankFilePreview = async function () {
        const infoDiv = document.getElementById('import-file-name');
        parsedBankTransactions = parse1CStatement(pendingBankFileText);

        if (parsedBankTransactions.length > 0) {
            const btn = document.getElementById('btn-process-import');
            if (btn) btn.disabled = false;

            let conflicts = [];
            let readyCount = 0;

            // 🔍 Проверка каждой транзакции на конфликты
            parsedBankTransactions.forEach(t => {
                // Ищем номер заказа в описании (ЗК-00001)
                const match = t.description.match(/(ЗК)-(\d+)/i);
                if (match) {
                    const docNum = match[0].toUpperCase();
                    // Сверяем с данными заказов, которые уже загружены в системе
                    // Мы используем данные из таблицы дебиторки (financeInvoices)
                    const existingDoc = financeInvoices.find(inv => inv.invoice_number === docNum);

                    if (!existingDoc) {
                        // Если номера нет в списке дебиторки — значит он либо уже оплачен, либо не существует
                        conflicts.push(`⚠️ <b>${docNum}</b>: Заказ уже оплачен или не найден. Деньги зачислятся как аванс.`);
                    } else if (parseFloat(t.amount) > parseFloat(existingDoc.amount)) {
                        // Если сумма в банке больше, чем остаток долга
                        conflicts.push(`❓ <b>${docNum}</b>: Сумма оплаты (${t.amount} ₽) больше долга (${existingDoc.amount} ₽).`);
                    } else {
                        readyCount++;
                    }
                } else {
                    readyCount++;
                }
            });

            let previewHtml = `<div style="max-height: 150px; overflow-y:auto; margin-top:10px; font-size:11px; text-align:left; background: var(--surface); border: 1px solid var(--border); padding: 8px; border-radius: 6px;">`;
            parsedBankTransactions.slice(0, 5).forEach(t => {
                previewHtml += `<div style="border-bottom: 1px solid var(--border); margin-bottom: 4px; padding-bottom: 4px;">
                <b style="color:var(--primary);">Дата: ${t.date}</b> | Сумма: ${t.amount} ₽ <br><span style="color:var(--text-muted);">${t.description.substring(0, 60)}...</span>
            </div>`;
            });
            previewHtml += `</div>`;

            // Блок предупреждений
            let conflictHtml = '';
            if (conflicts.length > 0) {
                conflictHtml = `
                <div style="margin-top: 10px; padding: 10px; background: #fff5f5; border: 1px solid #feb2b2; border-radius: 6px; text-align: left; font-size: 12px;">
                    <b style="color: #c53030;">🚩 Обнаружены особенности (${conflicts.length}):</b>
                    <ul style="margin: 5px 0 0 15px; padding: 0;">
                        ${conflicts.map(c => `<li style="margin-bottom:3px;">${c}</li>`).join('')}
                    </ul>
                </div>
            `;
            }

            if (infoDiv) {
                infoDiv.innerHTML = `
                <div style="margin-bottom: 10px;">✅ Найдено операций: <b>${parsedBankTransactions.length}</b></div>
                ${previewHtml}
                ${conflictHtml}
                <p style="font-size: 11px; color: var(--text-muted); margin-top: 10px;">Все операции будут импортированы для корректного баланса счета.</p>
            `;
            }
            UI.toast(conflicts.length > 0 ? 'Найдены расхождения, проверьте список' : 'Файл проверен', conflicts.length > 0 ? 'warning' : 'success');
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
        if (!autoDetectedAccountId) return;
        if (parsedBankTransactions.length === 0) return UI.toast('Нет операций для импорта', 'error');

        const btn = document.getElementById('btn-process-import');
        btn.disabled = true;
        btn.innerText = '⏳ Сохраняем в базу...';

        try {
            // 🚀 ИСПРАВЛЕНИЕ 1: Сохраняем ответ сервера в переменную result
            const result = await API.post('/api/transactions/import', {
                account_id: autoDetectedAccountId,
                transactions: parsedBankTransactions
            });

            // 🚀 ИСПРАВЛЕНИЕ 2: Убрали сломанный блок if(true) с res.text()

            // Если дошли сюда — всё прошло успешно
            UI.closeModal();

            let msg = `✅ Успешно загружено: ${result.count} платежей.`;
            if (result.autoPaid > 0) {
                msg += `\n🎯 Автоматически закрыто счетов: ${result.autoPaid}!`;
            }

            UI.toast(msg, 'success');
            loadFinanceData();

        } catch (e) {
            console.error(e);
            // Ошибка от API.post перехватывается здесь
            UI.toast(e.message || 'Сбой сети: Ошибка сервера', 'error');
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
            panel.classList.remove('d-none');
            countSpan.innerText = selectedTransIds.size;
        } else {
            panel.classList.add('d-none');
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
            await API.post('/api/transactions/bulk-delete', { ids: Array.from(selectedTransIds) });
            UI.toast('✅ Операции удалены', 'success');
            selectedTransIds.clear();
            loadFinanceData();
        } catch (e) {
            console.error(e);
            UI.toast(e.message || 'Ошибка массового удаления', 'error');
        }
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

            const res = await API.get(`/api/transactions?${queryParams.toString()}`);

            // 🚀 ИСПРАВЛЕНО: проверяем res, а не data
            if (!res.data || res.data.length === 0) {
                return UI.toast('Нет данных для выгрузки', 'warning');
            }

            let csvContent = '\uFEFF';
            csvContent += 'Дата;Тип;Сумма;Контрагент;Категория;Счет;Способ оплаты;Комментарий\n';

            res.data.forEach(t => {
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
                    y: { beginAtZero: true, ticks: { callback: v => Utils.formatMoney(v) } },
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
            await API.post(`/api/transactions/${transactionId}/receipt`, {});
            if (true) {
                UI.toast('✅ Чек успешно загружен!', 'success');
                loadFinanceData(); // Перезагружаем таблицу транзакций
            }
        } catch (e) { console.error(e); } finally {
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
            await API.delete(`/api/transactions/${id}/receipt`);
            if (true) {
                UI.toast('🗑️ Файл успешно откреплен', 'success');
                loadFinanceData();
            } else {
                UI.toast('❌ Ошибка при удалении', 'error');
            }
        } catch (e) { console.error(e); }
    };

    // === ОКНО ОТЧЕТА P&L ===
    window.openPnlReportModal = async function (customStart = '', customEnd = '') {
        UI.toast('Сбор финансовых данных...', 'info');
        let queryParams = '';
        let periodText = 'За всё время';

        // 🚀 АВТОЗАПУСК: если даты не переданы — ставим текущий месяц (1-е число → сегодня)
        let start = customStart;
        let end = customEnd;
        if (!start && !end) {
            const now = new Date();
            start = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
            end = now.toISOString().split('T')[0];
        }

        if (start && end) {
            queryParams = `?start=${start}&end=${end}`;
            const formatD = (dStr) => {
                const [y, m, d] = dStr.split('-');
                return `${d}.${m}.${y}`;
            };
            periodText = `с ${formatD(start)} по ${formatD(end)}`;
        }

        try {
            const data = await API.get(`/api/finance/pnl${queryParams}`);

            const fmt = (val) => Utils.formatMoney(Number(val));

            const html = `
            <style>.modal-content { max-width: 800px !important; width: 90% !important; }</style>
            <div class="finance-pnl-wrap">
                <h3 class="finance-pnl-header">Отчет о прибылях и убытках (P&L)</h3>
                
                <div class="finance-pnl-toolbar">
                    <span class="font-13 font-bold">Период расчета:</span>
                    <input type="date" id="pnl-start" class="input-modern" value="${start}" style="margin: 0; padding: 4px 8px; width: 130px;">
                    <span>—</span>
                    <input type="date" id="pnl-end" class="input-modern" value="${end}" style="margin: 0; padding: 4px 8px; width: 130px;">
                    <button class="btn btn-blue p-5" onclick="openPnlReportModal(document.getElementById('pnl-start').value, document.getElementById('pnl-end').value)">🔄 Рассчитать</button>
                    <button class="btn btn-outline p-5" onclick="openPnlReportModal('', '')">За всё время</button>
                </div>

                <div class="finance-pnl-date-badge">
                    <span>📅 ${periodText}</span>
                </div>

                <!-- БЛОК ДОХОДОВ -->
                <h4 class="mt-15 mb-10 text-main font-16 border-bottom pb-5">ДОХОДЫ</h4>
                <div class="finance-pnl-row">
                    <span class="font-15">Выручка (Оборот от продаж):</span>
                    <span class="font-16 font-bold text-success">${fmt(data.revenue)} ₽</span>
                </div>
                <div class="finance-pnl-total-row" style="border-right-color: var(--success);">
                    <span class="font-15 font-bold">ИТОГО ДОХОДЫ (От основной деятельности):</span>
                    <span class="font-18 font-bold" style="color: ${data.totalIncome < 0 ? 'var(--danger)' : 'var(--success)'};">${fmt(data.totalIncome)} ₽</span>
                </div>

                <!-- БЛОК РАСХОДОВ -->
                <h4 class="mt-15 mb-10 text-main font-16 border-bottom pb-5">РАСХОДЫ</h4>
                <div class="finance-pnl-row">
                    <span class="font-15">🟢 Прямые затраты (COGS):</span>
                    <span class="font-16 font-bold" style="color: ${data.cogs < 0 ? 'var(--danger)' : 'var(--success)'};">${fmt(data.cogs)} ₽</span>
                </div>
                <div class="finance-pnl-row">
                    <span class="font-15">🟠 Косвенные расходы (OPEX):</span>
                    <span class="font-16 font-bold" style="color: ${data.opex < 0 ? 'var(--danger)' : 'var(--success)'};">${fmt(data.opex)} ₽</span>
                </div>
                <div class="finance-pnl-row">
                    <span class="font-15">🔵 Капитальные затраты (CAPEX):</span>
                    <span class="font-16 font-bold" style="color: ${data.capex < 0 ? 'var(--danger)' : 'var(--success)'};">${fmt(data.capex)} ₽</span>
                </div>
                <div class="finance-pnl-row" style="border-style: dashed; opacity: 0.7;">
                    <span class="font-13 text-muted">📋 Справочно: ФОТ по начислению:</span>
                    <span class="font-13 font-bold text-muted">${fmt(data.laborCosts)} ₽</span>
                </div>
                <div class="finance-pnl-total-row" style="border-right-color: var(--danger);">
                    <span class="font-15 font-bold">ИТОГО РАСХОДЫ (COGS + OPEX + CAPEX):</span>
                    <span class="font-18 font-bold" style="color: ${data.totalExpenses < 0 ? 'var(--danger)' : 'var(--success)'};">${fmt(data.totalExpenses)} ₽</span>
                </div>

                <!-- ФИНАЛЬНЫЙ РЕЗУЛЬТАТ -->
                <div class="finance-pnl-result-row" style="background: ${Number(data.netProfit) >= 0 ? 'var(--success-bg)' : 'var(--danger-bg)'}; border-color: ${Number(data.netProfit) >= 0 ? 'var(--success)' : 'var(--danger)'};">
                    <div>
                        <div class="font-18 font-bold" style="color: ${Number(data.netProfit) >= 0 ? 'var(--success-text)' : 'var(--danger-text)'}; letter-spacing: 0.5px;">ЧИСТАЯ ПРИБЫЛЬ (Net Profit)</div>
                        <div class="font-14 text-muted mt-5">Рентабельность: <b class="font-16" style="color: ${Number(data.netProfit) >= 0 ? 'var(--success)' : 'var(--danger)'};">${data.margin}%</b></div>
                    </div>
                    <span class="font-32 font-bold" style="color: ${Number(data.netProfit) >= 0 ? 'var(--success-text)' : 'var(--danger-text)'}; text-shadow: 0 1px 2px rgba(0,0,0,0.1);">${Number(data.netProfit) > 0 ? '+' : ''}${fmt(data.netProfit)} ₽</span>
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
            await API.post('/api/finance/planned-expenses', data);
            UI.toast('✅ Расход запланирован', 'success');
            openPaymentCalendarModal();
        } catch (e) { console.error(e); }
    };

    window.payPlannedExpense = async function (id) {
        try {
            await API.post(`/api/finance/planned-expenses/${id}/pay`, {});
            UI.toast('✅ Оплачено (если регулярный — создан на след. месяц)', 'success');
            openPaymentCalendarModal();
        } catch (e) { console.error(e); }
    };

    window.deletePlannedExpense = async function (id) {
        try {
            await API.delete(`/api/finance/planned-expenses/${id}`);
            UI.toast('🗑️ Плановый расход отменен', 'success');
            openPaymentCalendarModal();
        } catch (e) { console.error(e); }
    };

    // === КАРТОЧКА КОНТРАГЕНТА (CRM) ===
    window.openCounterpartyProfile = async function (id) {
        UI.toast('Загрузка профиля...', 'info');

        if (!id || id === 'null' || id === 'undefined') return;

        try {
            const data = await API.get(`/api/counterparties/${id}/profile?_t=${Date.now()}`); // 👈 Исправлено здесь
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
            <div class="crm-tx-row">
            <div>
                <b class="text-main">${t.date}</b> ${icon}<br>
                <span class="text-muted font-11">${Utils.escapeHtml(t.category)}</span>
            </div>
            <div class="crm-tx-right">
                <div>${Utils.escapeHtml(t.description)}</div>
            </div>
            <div class="crm-tx-amount" style="color: ${amountColor};">
                ${sign}${Utils.formatMoney(t.amount)}
            </div>
            </div>
            `;
            }).join('') || '<div class="p-15 text-center text-muted">Операций нет</div>';
            const invHtml = data.invoices.map(i => `
            <div class="crm-inv-row">
                <div><b>Счет №${i.id ? `<span class="entity-link" onclick="window.app.openEntity('document_invoice', ${i.id})">${i.invoice_number}</span>` : i.invoice_number}</b> от ${i.date}<br><span class="text-muted">${i.description}</span></div>
                <div class="font-bold">${Utils.formatMoney(i.amount)}</div>
                <div><span class="badge" style="background: ${i.status === 'paid' ? 'var(--success-bg)' : 'var(--warning-bg)'}; color: ${i.status === 'paid' ? 'var(--success)' : 'var(--warning-text)'};">${i.status === 'paid' ? 'Оплачен' : 'Ожидает'}</span></div>
            </div>
        `).join('') || '<div class="p-15 text-center text-muted">Счетов нет</div>';

            const contractsHtml = data.contracts.map(c => `
            <div class="crm-inv-row">
                <div><b>Договор №${c.id ? `<span class="entity-link" onclick="window.app.openEntity('document_contract', ${c.id})">${c.number}</span>` : c.number}</b> от ${c.date}</div>
                <div class="flex-row gap-5">
                    <button class="btn btn-outline p-5 font-12" style="color: var(--info); border-color: var(--info);" onclick="window.open('/print/contract?id=${c.id}&token=' + localStorage.getItem('token'), '_blank')" title="Распечатать">🖨️</button>
                    <button class="btn btn-outline p-5 font-12" style="color: var(--danger); border-color: var(--danger);" onclick="deleteContract(${c.id}, ${cp.id})" title="Удалить договор">❌</button>
                </div>
            </div>
        `).join('') || '<div class="p-15 text-center text-muted">Договоров нет</div>';

            const html = `
            <div class="flex-row gap-20 align-start">
                <div class="flex-1">
                    <div class="crm-profile-card">
                        <div class="crm-profile-header">
                            <span class="badge badge-role">${cp.role || cp.type || '—'}</span>
                            <div class="flex-row gap-5">
                                 <button class="btn btn-outline p-5 font-12" onclick="openAdvancedCPCard(${cp.id})">✏️ Изменить</button>
                                 <button class="btn btn-outline btn-crm-delete p-5 font-12" onclick="deleteCounterparty(${cp.id})">🗑️ Удалить</button>
                            </div>
                        </div>
                        <h3 class="crm-profile-title">${cp.name || '—'} ${window.getCategoryBadge(cp.client_category)}</h3>
                        <div class="crm-profile-info">
                            <b>ИНН:</b> ${cp.inn || '—'} | <b>КПП:</b> ${cp.kpp || '—'}<br>
                            <b>Телефон:</b> ${cp.phone || '—'}<br>
                            <b>Юр. адрес:</b> ${cp.legal_address || '—'}<br>
                            <b>Банк:</b> ${cp.bank_name || '—'} (Р/С: ${cp.checking_account || cp.bank_account || '—'})
                        </div>
                        <div class="mt-15 p-10 font-14" style="background: var(--surface); border: 1px solid var(--border); border-radius: 8px;">
                            <div class="font-bold text-muted mb-5">Сальдо взаиморасчетов:</div>
                            <div class="font-18 font-bold" style="color: ${data.saldo > 0 ? 'var(--success)' : (data.saldo < 0 ? 'var(--danger)' : 'var(--text)')}">
                                ${data.saldo > 0 ? 'Нам должны: ' : (data.saldo < 0 ? 'Мы должны: ' : '')}${Utils.formatMoney(Math.abs(data.saldo))} ₽
                            </div>
                        </div>
                    </div>

                    <div class="mb-15">
                        <h4 class="crm-toggle-header" onclick="const c = document.getElementById('cp-contracts-list'); const i = document.getElementById('cp-contracts-icon'); c.classList.toggle('hidden'); i.innerText = c.classList.contains('hidden') ? '▼ Развернуть' : '▲ Свернуть';">
                            <span>📑 Договоры клиента</span>
                            <span id="cp-contracts-icon" class="font-normal font-12 text-primary">▼ Развернуть</span>
                        </h4>
                        <div id="cp-contracts-list" class="crm-toggle-content hidden">
                            ${contractsHtml}
                        </div>
                    </div>
                    
                    <h4 class="crm-block-header">🟡 Счета на оплату</h4>
                    <div class="crm-list-box">
                        ${invHtml}
                    </div>

                    <h4 class="crm-block-header">📄 Документы и корректировки</h4>
                    <div class="crm-actions-grid">
                        <button class="btn btn-outline btn-outline-warning p-5 font-13" onclick="openFinanceInvoiceModal(${cp.id}, '${cp.name.replace(/'/g, "\\'").replace(/"/g, '&quot;')}')">🖨️ Выставить Счет</button>
                        <button class="btn btn-outline p-5 font-13 text-primary" onclick="window.open('/print/act?cp_id=${cp.id}&token=' + localStorage.getItem('token'), '_blank')">📑 Акт сверки</button>
                        <button class="btn btn-outline p-5 font-13 font-bold text-primary" onclick="openCorrectionModal(${cp.id})">⚖️ Коррекция</button>
                    </div>
                </div>

                <div class="flex-1">
                    <h4 class="crm-block-header">💸 Финансовая история</h4>
                    <div class="crm-history-box">
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
            // 🚀 Выполняем удаление
            await API.delete(`/api/contracts/${contractId}`);

            // Если выполнение дошло сюда — удаление успешно (статус 200)
            UI.toast('✅ Договор удален', 'success');
            UI.closeModal();

            // Перерисовываем правильное окно после успешного удаления (Логика сохранена)
            if (cpId && typeof openCounterpartyProfile === 'function') {
                openCounterpartyProfile(cpId);
            } else {
                const saleClient = document.getElementById('sale-client');
                if (saleClient && typeof loadClientContracts === 'function') {
                    await loadClientContracts(saleClient.value); // обновляем выпадающий список в модуле продаж
                }
                if (typeof openContractManager === 'function') {
                    openContractManager();
                }
            }
        } catch (e) {
            // 🚀 ИСПРАВЛЕНИЕ: Логика при ошибке (например, сработала защита бэкенда)
            console.error("Ошибка при удалении договора:", e);

            // Если на бэкенде остались спецификации или заказы — выводим причину
            UI.toast(e.message || 'Ошибка при удалении', 'error');

            // Возвращаем окно управления договорами, чтобы менеджер мог удалить спецификации
            // Это та самая логика из блока else, которую мы перенесли в catch
            if (typeof cancelDeleteContract === 'function') {
                cancelDeleteContract(cpId);
            }
        }
    };

    // === КАЛЕНДАРЬ ПЛАТЕЖЕЙ ===
    window.openPaymentCalendarModal = async function () {
        try {
            const expenses = await API.get('/api/finance/planned-expenses');

            let tbody = expenses.map(e => `
            <tr style="border-bottom: 1px solid var(--border);">
                <td style="padding: 10px;"><b>${e.date}</b></td>
                <td style="padding: 10px;">${e.category}</td>
                <td style="padding: 10px; color: var(--text-muted);">${e.description || '-'}</td>
                <td style="padding: 10px; color: var(--danger); font-weight: bold;">-${Utils.formatMoney(e.amount)}</td>
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
            `<option value="${acc.id}">${acc.name} (баланс: ${Utils.formatMoney(acc.balance)})</option>`
        ).join('');

        const html = `
        <div style="padding: 10px;">
            <p style="margin-bottom: 15px;">Провести оплату на сумму <b>${Utils.formatMoney(amount)}</b>?</p>
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
        setTimeout(() => {
            ['pay-planned-account'].forEach(id => {
                const el = document.getElementById(id);
                if (el && !el.tomselect) new TomSelect(el, { plugins: ['clear_button'], dropdownParent: 'body' });
            });
        }, 50);
    };

    window.confirmPlannedPay = async function (id) {
        const accId = document.getElementById('pay-planned-account').value;
        if (!accId) return UI.toast('Выберите счет!', 'warning');

        try {
            // 🚀 Отправляем запрос через обертку API
            // Передаем только URL и данные вторым аргументом
            await API.post(`/api/finance/planned-expenses/${id}/pay`, { account_id: accId });

            // Если дошли сюда — сервер ответил успехом (HTTP 200)
            UI.closeModal();
            UI.toast('✅ Платеж успешно проведен и списан с баланса', 'success');

            // 🔄 Обновляем таблицы
            loadFinanceData();

            // 📅 Переоткрываем календарь платежей, чтобы данные обновились и там
            if (typeof openPaymentCalendarModal === 'function') {
                openPaymentCalendarModal();
            }

        } catch (e) {
            // 🚀 ИСПРАВЛЕНИЕ: Теперь любая ошибка (например, "Финансовый замок" или "Нет денег") 
            // будет корректно поймана и показана через уведомление
            console.error("Ошибка при подтверждении планового платежа:", e);
            UI.toast(e.message || 'Ошибка при проведении платежа', 'error');
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
            // Используем PUT, так как это обновление существующей сущности
            await API.put(`/api/accounts/${id}`, { name: newName });

            // Если дошли сюда — запрос успешен
            UI.closeModal();
            UI.toast('✅ Название счета обновлено', 'success');
            loadFinanceData();

        } catch (e) {
            // Теперь ошибка не просто пишется в консоль, но и показывается пользователю
            console.error("Ошибка при переименовании счета:", e);
            UI.toast(e.message || 'Ошибка при переименовании счета', 'error');
        }
    };

    window.openAdvancedCPCard = async function (id = 0, initialName = '') {
        try {
            // 🚀 ИСПРАВЛЕНИЕ 1: Добавили price_level: 'basic' в объект по умолчанию
            let cp = { id: 0, name: initialName || '', role: 'Покупатель', client_category: 'Обычный', price_level: 'basic', inn: '', kpp: '', ogrn: '', legal_address: '', fact_address: '', bank_name: '', bank_bik: '', bank_account: '', bank_corr: '', director_name: '', phone: '', email: '', comment: '', entity_type: 'legal', is_buyer: true, is_supplier: false };
            let fin = { balance: 0, total_paid_to_us: 0, total_paid_to_them: 0 };

            if (id > 0) {
                const data = await API.get(`/api/counterparties/${id}/full`);
                cp = data.cp;
                fin = data.finances;
            }

            const balanceColor = fin.balance > 0 ? 'var(--success)' : (fin.balance < 0 ? 'var(--danger)' : 'var(--text-main)');
            const isLegal = (cp.entity_type || 'legal') === 'legal';

            const html = `
        <style>
            .cp-tabs { display: flex; border-bottom: 1px solid var(--border); margin-bottom: 15px; }
            .cp-tab { padding: 10px 15px; cursor: pointer; font-weight: bold; color: var(--text-muted); border-bottom: 2px solid transparent; transition: 0.2s; }
            .cp-tab:hover { color: var(--primary); }
            .cp-tab.active { color: var(--primary); border-bottom: 2px solid var(--primary); }
            .cp-content { display: none; }
            .cp-content.active { display: block; animation: fadeIn 0.3s; }
            .cp-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 15px; }
            .cp-entity-toggle { display: flex; gap: 10px; margin-bottom: 15px; }
            .cp-entity-btn { flex: 1; padding: 10px; border: 2px solid var(--border); border-radius: 8px; background: var(--surface); cursor: pointer; text-align: center; font-weight: bold; font-size: 13px; transition: 0.2s; }
            .cp-entity-btn.active { border-color: var(--primary); background: var(--primary-bg); color: var(--primary); }
            .cp-role-flags { display: flex; gap: 15px; margin-bottom: 15px; align-items: center; }
            .cp-role-flag { display: flex; align-items: center; gap: 5px; font-size: 13px; cursor: pointer; }
        </style>

        ${id > 0 ? `
        <div style="background: var(--surface-alt); padding: 12px; border-radius: 8px; margin-bottom: 15px; display: flex; justify-content: space-between;">
            <div>
                <small class="text-muted">Текущий баланс:</small><br>
                <b style="color: ${balanceColor}; font-size: 16px;">${Utils.formatMoney(fin.balance)} ₽</b>
            </div>
            <div style="text-align: right;">
                <small class="text-muted">Оборот (Приход/Расход):</small><br>
                <b>${Utils.formatMoney(fin.total_paid_to_us)}</b> / <b>${Utils.formatMoney(fin.total_paid_to_them)}</b>
            </div>
        </div>` : ''}

        <div class="cp-entity-toggle">
            <div class="cp-entity-btn ${isLegal ? 'active' : ''}" onclick="toggleEntityType('legal')" id="cp-entity-legal">🏢 Юридическое лицо</div>
            <div class="cp-entity-btn ${!isLegal ? 'active' : ''}" onclick="toggleEntityType('physical')" id="cp-entity-physical">👤 Физическое лицо</div>
        </div>
        <input type="hidden" id="cp-entity-type" value="${cp.entity_type || 'legal'}">

        <div class="cp-role-flags">
            <label class="cp-role-flag"><input type="checkbox" id="cp-is-buyer" ${cp.is_buyer ? 'checked' : ''}> 🛒 Покупатель</label>
            <label class="cp-role-flag"><input type="checkbox" id="cp-is-supplier" ${cp.is_supplier ? 'checked' : ''}> 🏭 Поставщик</label>
        </div>

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
                    <label>Телефон</label>
                    <div style="display: flex; gap: 8px; align-items: center;">
                        <input type="text" id="cp-phone" class="input-modern" value="${cp.phone || ''}" placeholder="+7 (999) 123-45-67" style="flex: 1;">
                        <label style="font-size: 12px; white-space: nowrap; display: flex; align-items: center; gap: 4px; cursor: pointer; color: var(--text-muted);">
                            <input type="checkbox" id="cp-no-phone" ${cp.phone ? '' : 'checked'} onchange="toggleNoPhone(this)"> Нет
                        </label>
                    </div>
                </div>
            </div>
            <div id="legal-entity-fields" style="${isLegal ? '' : 'display: none;'}">
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
            </div>
            
            <div class="cp-grid">
                <div class="form-group m-0">
                    <label>Статус / Категория клиента</label>
                    <select id="cp-category" class="input-modern">
                        <option value="Обычный" ${cp.client_category === 'Обычный' ? 'selected' : ''}>👤 Обычный</option>
                        <option value="VIP" ${cp.client_category === 'VIP' ? 'selected' : ''}>🌟 VIP-клиент</option>
                        <option value="Дилер" ${cp.client_category === 'Дилер' ? 'selected' : ''}>🤝 Дилер</option>
                        <option value="Частые отгрузки" ${cp.client_category === 'Частые отгрузки' ? 'selected' : ''}>📦 Частые отгрузки</option>
                        <option value="Проблемный" ${cp.client_category === 'Проблемный' ? 'selected' : ''}>⚠️ Проблемный</option>
                    </select>
                </div>
                <div class="form-group m-0">
                    <label>Уровень цен (Прайс)</label>
                    <select id="cp-price-level" class="input-modern text-info font-bold" style="border-color: var(--info);">
                        <option value="basic" ${cp.price_level !== 'dealer' ? 'selected' : ''}>Основная (Розница)</option>
                        <option value="dealer" ${cp.price_level === 'dealer' ? 'selected' : ''}>Дилерская (Опт)</option>
                    </select>
                </div>
            </div>
        </div>

        <div id="tab-reqs" class="cp-content">
            <div class="form-group" style="margin-bottom:15px;"><label>ОГРН</label><input type="text" id="cp-ogrn" class="input-modern" value="${cp.ogrn || ''}"></div>
            <div class="form-group" style="margin-bottom:15px;"><label>Название банка</label><input type="text" id="cp-bank" class="input-modern" value="${cp.bank_name || ''}"></div>
            <div class="cp-grid">
                <div class="form-group"><label>БИК</label><input type="text" id="cp-bik" class="input-modern" value="${cp.bank_bik || ''}"></div>
                <div class="form-group"><label>Корр. счет</label><input type="text" id="cp-corr" class="input-modern" value="${cp.bank_corr || ''}"></div>
            </div>
            <div class="form-group"><label>Расчетный счет</label><input type="text" id="cp-account" class="input-modern" value="${cp.bank_account || ''}"></div>
        </div>

        <div id="tab-contacts" class="cp-content">
            <div class="form-group" style="margin-bottom:15px;"><label>ФИО Директора</label><input type="text" id="cp-director" class="input-modern" value="${cp.director_name || ''}"></div>
            <div class="form-group" style="margin-bottom:15px;"><label>Email</label><input type="text" id="cp-email" class="input-modern" value="${cp.email || ''}"></div>
            <div class="form-group" style="margin-bottom:15px;"><label>Юридический адрес</label><input type="text" id="cp-address" class="input-modern" value="${cp.legal_address || ''}"></div>
            <div class="form-group"><label>Фактический адрес</label><input type="text" id="cp-fact-address" class="input-modern" value="${cp.fact_address || ''}"></div>
        </div>

        <div id="tab-comment" class="cp-content">
            <div class="form-group">
                <label>Внутренний комментарий</label>
                <textarea id="cp-comment" class="input-modern" style="height: 120px; resize: vertical;">${cp.comment || ''}</textarea>
            </div>
        </div>
    `;

            UI.showModal(`${id > 0 ? 'Карточка контрагента' : 'Новый контрагент'}`, html, `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-blue" onclick="saveAdvancedCP(${id})">💾 Сохранить</button>
    `);

            // 🚀 ИСПРАВЛЕНИЕ 3: Умная логика TomSelect (Связка Статуса и Прайса)
            setTimeout(() => {
                const priceEl = document.getElementById('cp-price-level');
                let priceTs = null;
                if (priceEl && !priceEl.tomselect) {
                    priceTs = new TomSelect(priceEl, { plugins: ['clear_button'], dropdownParent: 'body' });
                } else if (priceEl) {
                    priceTs = priceEl.tomselect;
                }

                const catEl = document.getElementById('cp-category');
                if (catEl && !catEl.tomselect) {
                    new TomSelect(catEl, {
                        plugins: ['clear_button'],
                        dropdownParent: 'body',
                        // Событие переключения категории
                        onChange: function (value) {
                            if (!priceTs) return;
                            if (value === 'Дилер') {
                                priceTs.setValue('dealer');
                                priceTs.lock(); // Блокируем выбор
                            } else if (value === 'Обычный') {
                                priceTs.setValue('basic');
                                priceTs.lock(); // Блокируем выбор
                            } else {
                                priceTs.unlock(); // Позволяем выбрать вручную (например, для VIP)
                            }
                        }
                    });
                }

                // Проверяем начальное состояние (нужно ли заблокировать прайс при открытии окна)
                if (priceTs) {
                    const initCat = cp.client_category || 'Обычный';
                    if (initCat === 'Дилер' || initCat === 'Обычный') {
                        priceTs.lock();
                    } else {
                        priceTs.unlock();
                    }
                }
            }, 50);

        } catch (e) { console.error(e); UI.toast('Ошибка загрузки данных', 'error'); }
    };

    window.autofillByINN = async function () {
        const inn = document.getElementById('cp-inn').value.trim();
        if (!inn || (inn.length !== 10 && inn.length !== 12)) return UI.toast('Введите корректный ИНН', 'warning');

        UI.toast('🔍 Ищем в базе ФНС...', 'info');
        try {
            const data = await API.post("/api/dadata/inn", { inn: inn });
            if (data.suggestions && data.suggestions.length > 0) {
                const org = data.suggestions[0].data;
                document.getElementById('cp-name').value = data.suggestions[0].value || '';
                if (document.getElementById('cp-kpp')) document.getElementById('cp-kpp').value = org.kpp || '';
                if (document.getElementById('cp-ogrn')) document.getElementById('cp-ogrn').value = org.ogrn || '';
                if (document.getElementById('cp-address')) document.getElementById('cp-address').value = org.address ? org.address.value : '';
                if (document.getElementById('cp-director') && org.management) {
                    document.getElementById('cp-director').value = org.management.name || '';
                }
                UI.toast('✅ Данные заполнены!', 'success');
            } else {
                UI.toast('DaData: Данные по ИНН не найдены', 'warning');
            }
        } catch (e) {
            console.error(e);
            UI.toast(e.message || 'Ошибка связи с ФНС', 'error');
        }
    };

    window.toggleEntityType = function (type) {
        const typeInput = document.getElementById('cp-entity-type');
        if (!typeInput) return;
        typeInput.value = type;
        document.getElementById('cp-entity-legal').classList.toggle('active', type === 'legal');
        document.getElementById('cp-entity-physical').classList.toggle('active', type === 'physical');
        document.getElementById('legal-entity-fields').style.display = type === 'legal' ? 'block' : 'none';
    };

    window.toggleNoPhone = function (cb) {
        const phoneInput = document.getElementById('cp-phone');
        if (!phoneInput) return;
        if (cb.checked) {
            phoneInput.value = '';
            phoneInput.disabled = true;
            phoneInput.placeholder = 'Телефон не указан';
        } else {
            phoneInput.disabled = false;
            phoneInput.placeholder = '+7 (999) 123-45-67';
        }
    };

    window.switchCPTab = function (tabName) {
        document.querySelectorAll('.cp-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.cp-content').forEach(c => c.classList.remove('active'));

        // Находим текущую вкладку по тексту или через событие, если оно передано
        const activeTab = Array.from(document.querySelectorAll('.cp-tab')).find(t => t.innerText.toLowerCase().includes(tabName === 'main' ? 'основное' : ''));
        if (event && event.target) event.target.classList.add('active');

        const content = document.getElementById(`tab-${tabName}`);
        if (content) content.classList.add('active');
    };

    window.saveAdvancedCP = async function (id) {
        const noPhone = document.getElementById('cp-no-phone')?.checked;
        const entityType = document.getElementById('cp-entity-type')?.value || 'legal';
        const isBuyer = document.getElementById('cp-is-buyer')?.checked || false;
        const isSupplier = document.getElementById('cp-is-supplier')?.checked || false;

        // Определяем роль для обратной совместимости
        let role = 'Покупатель';
        if (isSupplier && !isBuyer) role = 'Поставщик';

        // 🚀 ИСПРАВЛЕНИЕ 4: Добавили price_level в пакет отправки на бэкенд
        const payload = {
            name: document.getElementById('cp-name').value.trim(),
            role: role,
            client_category: document.getElementById('cp-category').value,
            price_level: document.getElementById('cp-price-level').value, // <--- ВОТ ЭТО БЫЛО УПУЩЕНО!
            inn: document.getElementById('cp-inn')?.value.trim() || '',
            kpp: document.getElementById('cp-kpp')?.value.trim() || '',
            ogrn: document.getElementById('cp-ogrn').value.trim(),
            legal_address: document.getElementById('cp-address').value.trim(),
            fact_address: document.getElementById('cp-fact-address').value.trim(),
            bank_name: document.getElementById('cp-bank').value.trim(),
            bank_bik: document.getElementById('cp-bik').value.trim(),
            bank_account: document.getElementById('cp-account').value.trim(),
            bank_corr: document.getElementById('cp-corr').value.trim(),
            director_name: document.getElementById('cp-director').value.trim(),
            phone: noPhone ? '' : document.getElementById('cp-phone').value.trim(),
            email: document.getElementById('cp-email').value.trim(),
            comment: document.getElementById('cp-comment').value.trim(),
            entity_type: entityType,
            is_buyer: isBuyer,
            is_supplier: isSupplier
        };

        // ВАЛИДАЦИЯ
        if (!payload.name) return UI.toast('Введите название!', 'warning');
        if (!isBuyer && !isSupplier) return UI.toast('Выберите хотя бы одну роль (Покупатель или Поставщик)!', 'warning');
        if (!noPhone && !payload.phone) return UI.toast('Введите телефон или отметьте «Нет»!', 'warning');
        if (!noPhone && payload.phone && !Utils.isValidPhone(payload.phone)) {
            return UI.toast('Некорректный номер телефона (минимум 10 цифр).', 'warning');
        }

        if (payload.inn && payload.inn.length !== 10 && payload.inn.length !== 12) {
            return UI.toast('Введите корректный ИНН (10 или 12 цифр)', 'warning');
        }

        const url = id > 0 ? `/api/counterparties/${id}` : '/api/counterparties';

        try {
            if (id > 0) {
                await API.put(url, payload);
            } else {
                await API.post(url, payload);
            }

            UI.closeModal();
            UI.toast('✅ Карточка сохранена', 'success');

            if (typeof loadFinanceData === 'function') {
                await loadFinanceData();
            }

            if (typeof openCounterpartiesModal === 'function') {
                openCounterpartiesModal();
            }

        } catch (e) {
            console.error("Детали ошибки при сохранении контрагента:", e);
            UI.toast(e.message || 'Ошибка базы: Сбой на сервере', 'error');
        }
    };
    window.autofillByINN = async function () {
        const inn = document.getElementById('cp-inn').value.trim();
        if (!inn || (inn.length !== 10 && inn.length !== 12)) {
            return UI.toast('Введите корректный ИНН (10 или 12 цифр)', 'warning');
        }

        UI.toast('🔍 Ищем в базе ФНС через сервер...', 'info');

        try {
            // 🚀 ИСПРАВЛЕНИЕ 1: Сохраняем результат в переменную data
            const data = await API.post("/api/dadata/inn", { inn: inn });

            // 🚀 ИСПРАВЛЕНИЕ 2: Убрали сломанный блок if (true) и ручные проверки res.status.
            // Наша обертка API сама выбросит ошибку (в catch), если статус будет 401, 403 или 500.

            if (data && data.suggestions && data.suggestions.length > 0) {
                const suggestion = data.suggestions[0];
                const org = suggestion.data;

                // Заполняем поля (Не упрощаем: сохраняем все ваши ID и логику)
                const nameField = document.getElementById('cp-name');
                const kppField = document.getElementById('cp-kpp');
                const ogrnField = document.getElementById('cp-ogrn');
                const addressField = document.getElementById('cp-address');
                const directorField = document.getElementById('cp-director');

                if (nameField) nameField.value = suggestion.value || '';
                if (kppField) kppField.value = org.kpp || '';
                if (ogrnField) ogrnField.value = org.ogrn || '';
                if (addressField) addressField.value = org.address ? org.address.value : '';

                if (directorField && org.management && org.management.name) {
                    directorField.value = org.management.name;
                }

                UI.toast('✅ Реквизиты успешно заполнены!', 'success');
            } else {
                UI.toast('Организация с таким ИНН не найдена', 'warning');
            }

        } catch (e) {
            // 🚀 ИСПРАВЛЕНИЕ 3: Теперь ошибки API (включая 401/403 от DaData) 
            // будут корректно показаны здесь через e.message
            console.error("Ошибка при обращении к прокси DaData:", e);
            UI.toast(e.message || 'Внутренняя ошибка системы', 'error');
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
                <option value="expense">📈 Клиент должен нам (+ Увеличить его долг)</option>
                <option value="income">📉 Мы должны клиенту (+ Увеличить наш долг)</option>
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
        setTimeout(() => {
            ['corr-type'].forEach(id => {
                const el = document.getElementById(id);
                if (el && !el.tomselect) new TomSelect(el, { plugins: ['clear_button'], dropdownParent: 'body' });
            });
        }, 50);
    };

    window.executeCorrection = async function (cpId) {
        const amount = parseFloat(document.getElementById('corr-amount').value);
        const type = document.getElementById('corr-type').value;
        const date = document.getElementById('corr-date').value;
        const desc = document.getElementById('corr-desc').value.trim();

        // Валидация (сохранена полностью)
        if (!amount || amount <= 0) return UI.toast('Укажите корректную сумму', 'warning');

        try {
            // 🚀 Выполняем запрос через обертку API
            await API.post(`/api/counterparties/${cpId}/correction`, {
                amount,
                type,
                date,
                description: desc
            });

            // Если выполнение дошло сюда — запрос успешен (HTTP 200)
            UI.toast('✅ Баланс успешно скорректирован!', 'success');

            // 🔄 Обновляем интерфейс (Не упрощаем: сохраняем оба вызова)
            if (typeof openCounterpartyProfile === 'function') {
                openCounterpartyProfile(cpId);
            }
            if (typeof loadFinanceData === 'function') {
                loadFinanceData();
            }

        } catch (e) {
            // 🚀 ИСПРАВЛЕНИЕ: Теперь любая ошибка бэкенда будет показана пользователю
            console.error("Ошибка при корректировке баланса:", e);
            UI.toast(e.message || 'Ошибка при выполнении корректировки', 'error');
        }
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
            const settings = await API.get('/api/finance/tax-settings');

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
        await API.post('/api/finance/tax-status', { id: id, field: 'tax_excluded', is_checked: isExcluded });
        // Перезагружаем данные с сервера, чтобы учесть изменения
        await loadTaxPiggyBank();
        renderTaxModalContent();
    };

    // Отправка клика по галочке "Принудительный НДС" на сервер
    window.toggleForceVat = async function (id, el) {
        const isForce = el.checked;
        await API.post('/api/finance/tax-status', { id: id, field: 'tax_force_vat', is_checked: isForce });
        // Если мы принудительно включили НДС, нужно убедиться, что операция не "Исключена"
        if (isForce) {
            await API.post('/api/finance/tax-status', { id: id, field: 'tax_excluded', is_checked: false });
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

        await API.post('/api/finance/tax-settings', { key: key, value: numVal });
        renderTaxModalContent();
        renderTaxWidgetUI();
    };

    // Отправка ставки УСН на сервер
    window.updateUsnRate = async function (val) {
        taxUsnRate = parseFloat(val) || 0;
        await API.post('/api/finance/tax-settings', { key: 'tax_usn_rate', value: taxUsnRate });
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
                    <div style="font-size: 28px; font-weight: 900; color: var(--text-main); margin-top: 4px; white-space: nowrap;">${Utils.formatMoney(live.total)} ₽</div>
                </div>
                <div id="tax-period-controls" style="display: flex; gap: 3px;" class="no-print">
                    ${periodHtml}
                </div>
            </div>

            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; border-top: 1px solid var(--border); padding-top: 15px;">
                <div style="cursor: pointer; padding: 10px; border-radius: 8px; transition: 0.2s;" onclick="openTaxDetailsModal('cash')">
                    <div style="font-size: 10px; color: var(--text-muted);">Касса (УСН ${taxUsnRate}%):</div>
                    <div style="font-size: 16px; font-weight: bold; color: var(--success); white-space: nowrap;">+${Utils.formatMoney(Math.max(0, live.cashTax))} ₽</div>
                    <div style="font-size: 9px; color: var(--primary); margin-top: 4px;">Аналитика УСН ➔</div>
                </div>
                <div style="cursor: pointer; padding: 10px; border-radius: 8px; transition: 0.2s;" onclick="openTaxDetailsModal('bank')">
                    <div style="font-size: 10px; color: var(--text-muted);">Безнал (Оперативный НДС):</div>
                    <div style="font-size: 16px; font-weight: bold; color: var(--primary); white-space: nowrap;">${live.bankVat > 0 ? '+' : ''}${Utils.formatMoney(Math.max(0, live.bankVat))} ₽</div>
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
            const data = await API.get(`/api/finance/tax-piggy-bank?${params.toString()}`);
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

    // === ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ДЛЯ МОДАЛКИ ===
    window.switchTaxTab = function (tab) {
        currentTaxTab = tab;
        currentTaxFilter = 'all';
        renderTaxModalContent();
    };

    window.setTaxFilter = function (filter) {
        currentTaxFilter = filter;
        renderTaxModalContent();
    };

    // 🚀 НОВАЯ ФУНКЦИЯ: Обновляет периоды напрямую, без конфликта ID
    window.updateModalPeriod = async function (field, val) {
        if (field === 'type') {
            taxPeriodType = val;
            if (val === 'quarter') taxPeriodValue = Math.floor(new Date().getMonth() / 3) + 1;
            else if (val === 'month') taxPeriodValue = new Date().getMonth() + 1;
        } else if (field === 'value') {
            taxPeriodValue = parseInt(val);
        } else if (field === 'year') {
            taxYear = parseInt(val);
        }

        if (typeof saveLocalPeriods === 'function') saveLocalPeriods();
        await loadTaxPiggyBank();
        renderTaxModalContent();
    };

    // ==========================================
    // УПРАВЛЕНИЕ МОДАЛЬНЫМ ОКНОМ НАЛОГОВ
    // ==========================================
    window.openTaxDetailsModal = function (tab = 'bank') {
        currentTaxTab = tab;
        const html = `
            <style>
                .modal-content { max-width: 1200px !important; width: 95% !important; }
                .tax-table-container { max-height: 480px; overflow-y: auto; border: 1px solid var(--border); border-radius: 6px; }
            </style>
            <div id="tax-modal-body"></div>
        `;
        UI.showModal('📊 Оперативный налоговый учет', html, `<button class="btn btn-blue" onclick="UI.closeModal();">Готово</button>`);
        renderTaxModalContent();
    };

    // ==========================================
    // ОТПРАВКА ГАЛОЧЕК НА СЕРВЕР (В БАЗУ ДАННЫХ)
    // ==========================================

    window.toggleTaxExclusion = async function (id, el) {
        // Если галочка "Учитывать" снята, значит операция Исключена (true)
        const isExcluded = !el.checked;

        // 1. Отправляем изменение прямо в базу данных
        await API.post('/api/finance/tax-status', { id: id, field: 'tax_excluded', is_checked: isExcluded });

        // 2. Скачиваем свежие расчеты с сервера и перерисовываем интерфейс
        await loadTaxPiggyBank();
        renderTaxModalContent();
    };

    window.toggleForceVat = async function (id, el) {
        const isForce = el.checked;

        // 1. Отправляем в базу статус "Принудительный НДС"
        await API.post('/api/finance/tax-status', { id: id, field: 'tax_force_vat', is_checked: isForce });

        // 2. Логика защиты: если включили НДС принудительно, операция точно не должна быть "Исключена"
        if (isForce) {
            await API.post('/api/finance/tax-status', { id: id, field: 'tax_excluded', is_checked: false });
        }

        // 3. Обновляем данные с сервера
        await loadTaxPiggyBank();
        renderTaxModalContent();
    };

    // ==========================================
    // ОТПРАВКА НАСТРОЕК НА СЕРВЕР (В БАЗУ ДАННЫХ)
    // ==========================================

    window.updateTaxCorrection = async function (val) {
        const numVal = parseFloat(val) || 0;
        const key = currentTaxTab === 'bank' ? 'tax_bank_correction' : 'tax_cash_correction';

        if (currentTaxTab === 'bank') taxBankCorrection = numVal;
        else taxCashCorrection = numVal;

        try {
            // 🚀 ИСПРАВЛЕНО: Вернули сохранение в базу данных
            await API.post('/api/finance/tax-settings', { key: key, value: numVal });
            renderTaxModalContent();
            if (typeof renderTaxWidgetUI === 'function') renderTaxWidgetUI();
        } catch (e) {
            console.error(e);
            UI.toast('Ошибка сохранения корректировки', 'error');
        }
    };

    window.updateUsnRate = async function (val) {
        taxUsnRate = parseFloat(val) || 0;
        try {
            // 🚀 ИСПРАВЛЕНО: Вернули сохранение ставки УСН в базу
            await API.post('/api/finance/tax-settings', { key: 'tax_usn_rate', value: taxUsnRate });
            await loadTaxPiggyBank();
            renderTaxModalContent();
        } catch (e) {
            console.error(e);
            UI.toast('Ошибка сохранения ставки УСН', 'error');
        }
    };

    window.renderTaxModalContent = function () {
        if (!rawTaxData) return;

        const dataObj = currentTaxTab === 'bank' ? rawTaxData.bank : rawTaxData.cash;
        const live = calculateLiveTax();
        const config = window.ERP_CONFIG || { vatRate: 20, vatDivider: 1.2 };
        const excludedCount = dataObj.transactions.filter(t => t.tax_excluded).length;

        const filteredRows = dataObj.transactions.filter(t => {
            const isExcluded = t.tax_excluded;
            if (currentTaxFilter === 'excluded') return isExcluded;
            if (isExcluded) return false;
            if (currentTaxFilter === 'income' && t.transaction_type !== 'income') return false;
            if (currentTaxFilter === 'expense' && t.transaction_type === 'income') return false;
            return true;
        });

        const tableRows = filteredRows.map(t => {
            const isIncome = t.transaction_type === 'income';
            let currentCalculatedTax = parseFloat(t.calculated_tax || 0);

            if (currentTaxTab === 'bank' && t.tax_force_vat && t.is_no_vat) {
                const amt = parseFloat(t.amount || 0);
                currentCalculatedTax = amt - (amt / config.vatDivider);
            }

            let taxDisplay = '';
            if (currentTaxTab === 'bank' && t.is_no_vat && !t.tax_force_vat) {
                taxDisplay = `<span style="background: var(--border); color: var(--text-muted); padding: 2px 6px; border-radius: 4px; font-size: 10px; text-transform: uppercase;">Без НДС</span>`;
            } else {
                const taxColor = isIncome ? 'var(--danger)' : 'var(--success)';
                const taxSign = isIncome ? '+' : '-';
                taxDisplay = `<span style="color: ${taxColor}; font-weight: bold; white-space: nowrap;">${taxSign}${Utils.formatMoney(Math.abs(currentCalculatedTax))}</span>`;
            }

            let rowStyle = t.tax_excluded ? 'opacity: 0.5; background: var(--surface-alt); border-bottom: 1px solid var(--border);' : 'border-bottom: 1px solid var(--border);';

            return `
            <tr style="${rowStyle}">
                <td style="padding: 10px; min-width: 100px;">
                    <label style="display: flex; align-items: center; gap: 6px; font-size: 11px; cursor: pointer;">
                        <input type="checkbox" ${t.tax_excluded ? '' : 'checked'} onchange="toggleTaxExclusion(${t.id}, this)"> Учитывать
                    </label>
                    ${currentTaxTab === 'bank' ? `
                    <label style="display: flex; align-items: center; gap: 6px; font-size: 10px; cursor: pointer; margin-top: 6px; color: var(--warning-text);">
                        <input type="checkbox" ${t.tax_force_vat ? 'checked' : ''} onchange="toggleForceVat(${t.id}, this)"> + НДС ${config.vatRate}%
                    </label>` : ''}
                </td>
                <td style="padding: 10px;">${new Date(t.transaction_date).toLocaleDateString('ru-RU')}</td>
                <td style="padding: 10px;"><b>${t.category}</b></td>
                <td style="padding: 10px; max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${t.description}">${t.description}</td>
                <td style="padding: 10px; text-align: right; font-weight: bold; color: ${isIncome ? 'var(--success)' : 'var(--text-main)'};">
                    ${isIncome ? '+' : '-'}${Utils.formatMoney(t.amount).replace(" ₽", "")}
                </td>
                <td style="padding: 10px; text-align: right;">${taxDisplay}</td>
            </tr>`;
        }).join('');

        let rightPanelHtml = '';
        if (currentTaxTab === 'bank') {
            const deductionPercent = live.vatIn > 0 ? (live.vatOut / live.vatIn) * 100 : 0;
            let trafficColor = 'var(--success)';
            if (deductionPercent > 89) trafficColor = 'var(--danger)';
            else if (deductionPercent > 86) trafficColor = 'var(--warning)';

            rightPanelHtml = `
                <div style="font-size: 11px; text-transform: uppercase; color: var(--text-muted); font-weight: bold; margin-bottom: 10px;">Оперативный НДС (${config.vatRate}%)</div>
                <div style="margin-bottom: 15px;">
                    <div style="display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 5px;">
                        <span>Доля вычетов:</span><span style="font-weight: bold; color: ${trafficColor};">${deductionPercent.toFixed(1)}%</span>
                    </div>
                    <div style="height: 6px; background: var(--border); border-radius: 3px; overflow: hidden;">
                        <div style="height: 100%; width: ${Math.min(deductionPercent, 100)}%; background: ${trafficColor};"></div>
                    </div>
                </div>
                <div style="font-size: 13px; margin-bottom: 15px;">К уплате: <b style="font-size: 18px;">${Utils.formatMoney(Math.max(0, live.bankVat))}</b></div>
                <label style="font-size: 11px; color: var(--text-muted);">Корректировка периода:</label>
                <input type="number" class="input-modern" style="width: 100%; box-sizing: border-box;" value="${taxBankCorrection}" onchange="updateTaxCorrection(this.value)">
            `;
        } else {
            rightPanelHtml = `
                <div style="font-size: 11px; text-transform: uppercase; color: var(--text-muted); font-weight: bold; margin-bottom: 15px;">Учет УСН (Касса)</div>
                <div style="font-size: 13px; margin-bottom: 10px;">База (Доходы): <b>${Utils.formatMoney(live.cashTurnover)}</b></div>
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
                    <span style="font-size: 13px;">Ставка:</span>
                    <input type="number" class="input-modern" style="width: 60px; text-align: center;" value="${taxUsnRate}" step="0.5" onchange="updateUsnRate(this.value)">
                </div>
                <div style="font-size: 13px; margin-bottom: 15px;">Налог: <b style="color: var(--danger); font-size: 18px;">+ ${Utils.formatMoney(live.cashTax)}</b></div>
                <label style="font-size: 11px; color: var(--text-muted);">- Вычеты:</label>
                <input type="number" class="input-modern" style="width: 100%; box-sizing: border-box;" value="${taxCashCorrection}" onchange="updateTaxCorrection(this.value)">
            `;
        }

        let valOptions = '';
        if (taxPeriodType === 'quarter') {
            for (let i = 1; i <= 4; i++) valOptions += `<option value="${i}" ${taxPeriodValue == i ? 'selected' : ''}>${i} Квартал</option>`;
        } else if (taxPeriodType === 'month') {
            const months = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
            months.forEach((m, i) => valOptions += `<option value="${i + 1}" ${taxPeriodValue == i + 1 ? 'selected' : ''}>${m}</option>`);
        }
        let yearOptions = '';
        const curY = new Date().getFullYear();
        for (let y = curY - 2; y <= curY + 1; y++) yearOptions += `<option value="${y}" ${taxYear == y ? 'selected' : ''}>${y} год</option>`;

        const bodyHtml = `
            <div style="display: flex; gap: 20px;">
                <div style="flex: 3; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 15px;">
                    <div style="display: flex; gap: 10px; border-bottom: 1px solid var(--border); padding-bottom: 10px; margin-bottom: 15px; align-items: center; flex-wrap: wrap;">
                        <button class="btn ${currentTaxTab === 'bank' ? 'btn-blue' : 'btn-outline'}" onclick="switchTaxTab('bank')">🏦 Банк</button>
                        <button class="btn ${currentTaxTab === 'cash' ? 'btn-blue' : 'btn-outline'}" onclick="switchTaxTab('cash')">💵 Касса</button>
                        
                        <div style="margin-left: auto; display: flex; align-items: center; gap: 6px;">
                            <select class="input-modern" style="font-size: 12px; margin: 0; padding: 4px;" onchange="updateModalPeriod('type', this.value)">
                                <option value="month" ${taxPeriodType === 'month' ? 'selected' : ''}>Месяц</option>
                                <option value="quarter" ${taxPeriodType === 'quarter' ? 'selected' : ''}>Квартал</option>
                                <option value="year" ${taxPeriodType === 'year' ? 'selected' : ''}>Год</option>
                                <option value="custom" ${taxPeriodType === 'custom' ? 'selected' : ''}>Произвольно 📅</option>
                                <option value="all" ${taxPeriodType === 'all' ? 'selected' : ''}>Всё время</option>
                            </select>

                            ${(taxPeriodType === 'month' || taxPeriodType === 'quarter') ? `
                            <select class="input-modern" style="font-size: 12px; margin: 0; padding: 4px;" onchange="updateModalPeriod('value', this.value)">
                                ${valOptions}
                            </select>` : ''}

                            ${taxPeriodType !== 'all' && taxPeriodType !== 'custom' ? `
                            <select class="input-modern" style="font-size: 12px; margin: 0; padding: 4px;" onchange="updateModalPeriod('year', this.value)">
                                ${yearOptions}
                            </select>` : ''}

                            <div style="display: ${taxPeriodType === 'custom' ? 'block' : 'none'}; margin: 0;">
                                <input type="text" id="tax-modal-date" class="input-modern" placeholder="📅 Выбрать даты..." style="width: 190px; margin: 0; font-size: 12px; padding: 4px;">
                            </div>
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

                <div style="flex: 1; background: var(--surface-alt); border: 1px solid var(--border); border-radius: 8px; padding: 20px; display: flex; flex-direction: column;">
                    ${rightPanelHtml}
                    <div style="margin-top: auto; border-top: 1px dashed var(--border); padding-top: 15px;">
                        <button class="btn btn-outline" style="width: 100%;" onclick="exportTaxToExcel()">📥 Скачать реестр в Excel</button>
                    </div>
                </div>
            </div>
        `;

        const modalBody = document.getElementById('tax-modal-body');
        if (modalBody) {
            modalBody.innerHTML = bodyHtml;

            // Календарь
            setTimeout(() => {
                if (window.flatpickr && taxPeriodType === 'custom') {
                    flatpickr("#tax-modal-date", {
                        mode: "range",
                        dateFormat: "Y-m-d",
                        altInput: true,
                        altFormat: "d.m.Y",
                        locale: "ru",
                        defaultDate: taxCustomStart ? [taxCustomStart, taxCustomEnd] : null,
                        onChange: async function (selectedDates, dateStr, instance) {
                            if (selectedDates.length === 2) {
                                taxCustomStart = instance.formatDate(selectedDates[0], "Y-m-d");
                                taxCustomEnd = instance.formatDate(selectedDates[1], "Y-m-d");
                                await loadTaxPiggyBank();
                                renderTaxModalContent();
                            }
                        }
                    });
                }
            }, 50);
        }
    };

    // ==========================================
    // ВЫГРУЗКА В EXCEL (С ИСПРАВЛЕННОЙ ЛОГИКОЙ НДС)
    // ==========================================
    window.exportTaxToExcel = function () {
        if (!rawTaxData) return;
        const dataObj = currentTaxTab === 'bank' ? rawTaxData.bank : rawTaxData.cash;
        const config = window.ERP_CONFIG || { vatRate: 20, vatDivider: 1.2 };

        let csvContent = '\uFEFF';
        csvContent += 'Режим;Дата;Категория;Назначение;Тип;Сумма;Налог;Статус\n';

        dataObj.transactions.forEach(t => {
            const isExcluded = t.tax_excluded;
            const forceVat = t.tax_force_vat;

            // 🚀 ИСПРАВЛЕНО: Логика фильтрации (теперь Расходы выгружаются корректно)
            if (currentTaxFilter === 'excluded' && !isExcluded) return;
            if (currentTaxFilter !== 'excluded' && isExcluded) return;
            if (currentTaxFilter === 'income' && t.transaction_type !== 'income') return;
            if (currentTaxFilter === 'expense' && t.transaction_type !== 'expense') return;

            const escapeCSV = (str) => `"${String(str || '').replace(/"/g, '""').replace(/\n/g, ' ')}"`;
            const mode = currentTaxTab === 'bank' ? `НДС ${config.vatRate}%` : `УСН ${taxUsnRate}%`;
            const typeStr = t.transaction_type === 'income' ? 'Приход' : 'Расход';
            const status = isExcluded ? 'Исключено' : 'В расчете';
            const safeDate = t.transaction_date ? new Date(t.transaction_date).toLocaleDateString('ru-RU') : '-';

            let taxVal = parseFloat(t.calculated_tax || 0);
            let taxStr = '';

            // 🚀 ИСПРАВЛЕНО: Безопасный расчет НДС на основе конфига (без хардкода 22/122)
            if (currentTaxTab === 'bank') {
                if (t.is_no_vat && !forceVat) {
                    taxStr = 'Без НДС';
                } else if (forceVat && t.is_no_vat) {
                    const amt = parseFloat(t.amount || 0);
                    taxStr = (amt - (amt / config.vatDivider)).toFixed(2);
                } else {
                    taxStr = taxVal.toFixed(2);
                }
            } else {
                taxStr = taxVal.toFixed(2);
            }

            const amtStr = parseFloat(t.amount || 0).toFixed(2);
            csvContent += `${mode};${safeDate};${escapeCSV(t.category)};${escapeCSV(t.description)};${typeStr};${amtStr};${taxStr};${status}\n`;
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
            await API.post('/api/finance/tax-settings', { key: 'finance_lock_date', value: date });

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

    // === ГЛОБАЛЬНЫЙ ЭКСПОРТ ===
    if (typeof loadFinanceCategories === 'function') window.loadFinanceCategories = loadFinanceCategories;
    if (typeof initStaticFinanceSelects === 'function') window.initStaticFinanceSelects = initStaticFinanceSelects;
    if (typeof initFinance === 'function') window.initFinance = initFinance;
    if (typeof loadFinanceData === 'function') window.loadFinanceData = loadFinanceData;
    if (typeof renderFinanceSummary === 'function') window.renderFinanceSummary = renderFinanceSummary;
    if (typeof renderAccounts === 'function') window.renderAccounts = renderAccounts;
    if (typeof sendImprestPayload === 'function') window.sendImprestPayload = sendImprestPayload;
    if (typeof renderTransactionsTable === 'function') window.renderTransactionsTable = renderTransactionsTable;
    if (typeof renderCPList === 'function') window.renderCPList = renderCPList;
    if (typeof renderInvoicesTable === 'function') window.renderInvoicesTable = renderInvoicesTable;
    if (typeof parse1CStatement === 'function') window.parse1CStatement = parse1CStatement;
    if (typeof renderFinanceCharts === 'function') window.renderFinanceCharts = renderFinanceCharts;
})();
