;(function() {
let currentEmployees = [];
let currentMonthRecords = [];
let currentMonthPayments = [];
let currentMonthStats = [];
let currentMonthAdjustments = [];
let currentMonthBalances = [];
let currentPrintData = [];
let currentPrintAdvancesData = [];

// === ИНИЦИАЛИЗАЦИЯ ===
function initSalary() {
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const tsPicker = document.getElementById('ts-month-picker');
    const payPicker = document.getElementById('payroll-period-select');
    if (tsPicker) tsPicker.value = currentMonth;
    if (payPicker) payPicker.value = currentMonth;

    loadEmployees().then(() => {
        loadMonthlyTimesheet();
        // ПРАВИЛЬНЫЙ ПУТЬ: /api/accounts [как в finance.js]
        API.get('/api/accounts').then(data => {
            window.currentAccounts = data;
            initStaticHRSelects();
        }).catch(e => console.error("Ошибка предзагрузки счетов:", e));
    });
}

function initStaticHRSelects() {
    ['emp-dep-filter', 'ts-dep-filter', 'pay-dep-filter'].forEach(id => {
        const el = document.getElementById(id);
        if (el && !el.tomselect) {
            new TomSelect(el, {
                plugins: ['clear_button'],
                allowEmptyOption: true
            });
        }
    });
}

// === ЛОГИКА АККОРДЕОНА ===
function toggleAccordion(bodyId, headerEl) {
    const body = document.getElementById(bodyId);
    if (!body) return;

    const icon = headerEl.querySelector('.icon');
    // Проверяем состояние через стили, чтобы JS всегда знал, открыто окно или нет
    const isCollapsed = window.getComputedStyle(body).display === 'none';

    if (isCollapsed) {
        body.style.display = 'block';
        if (icon) icon.innerText = '▲';
        headerEl.classList.add('open');

        // Автоматическая загрузка данных при открытии нужных вкладок
        if (bodyId === 'acc-timesheet') loadMonthlyTimesheet();
    } else {
        body.style.display = 'none';
        if (icon) icon.innerText = '▼';
        headerEl.classList.remove('open');
    }
}

// === БАЗА СОТРУДНИКОВ ===
async function loadEmployees() {
    try {
        currentEmployees = await API.get('/api/employees');
        renderEmployeesTable();
    } catch (e) { console.error(e); }
}

// Вспомогательная функция: берет живой баланс из рассчитанного табеля
function getLiveBalance(emp) {
    if (typeof currentMonthBalances !== 'undefined' && currentMonthBalances.length > 0) {
        const live = currentMonthBalances.find(b => b.employee_id === emp.id);
        if (live) return live.balance;
    }
    return parseFloat(emp.prev_balance || 0);
}

// Отрисовка таблиц (Активные и Уволенные раздельно)
function renderEmployeesTable() {
    const tbodyActive = document.getElementById('employees-table-body');
    const tbodyFired = document.getElementById('fired-employees-table-body');
    const searchTerm = (document.getElementById('emp-search-input')?.value || '').toLowerCase();
    const depFilter = document.getElementById('emp-dep-filter')?.value || 'all';

    const filtered = currentEmployees.filter(emp => {
        const matchSearch = emp.full_name.toLowerCase().includes(searchTerm) || emp.position.toLowerCase().includes(searchTerm);
        const matchDep = depFilter === 'all' || emp.department === depFilter;
        return matchSearch && matchDep;
    });

    const activeEmps = filtered.filter(e => e.status !== 'fired');
    const firedEmps = filtered.filter(e => e.status === 'fired');

    // === ГЕНЕРАЦИЯ АКТИВНЫХ СОТРУДНИКОВ ===
    let activeHtml = '';
    if (depFilter === 'all') {
        ['Офис', 'Цех', 'Охрана'].forEach(dep => {
            const depEmps = activeEmps.filter(e => e.department === dep);
            if (depEmps.length > 0) {
                activeHtml += `<tr class="table-dep-section"><td colspan="8">📂 Отдел: ${dep}</td></tr>`;
                depEmps.forEach(emp => {
                    const balance = getLiveBalance(emp);
                    const balColor = balance >= 0 ? 'var(--primary)' : 'var(--danger)';
                    const balSign = balance > 0 ? '+' : '';

                    activeHtml += `
                        <tr>
                            <td class="font-600">
                                <span class="entity-link" title="Открыть профиль" onclick="window.app.openEntity('employee', ${emp.id})">${Utils.escapeHtml(emp.full_name)}</span>
                            </td>
                            <td class="text-muted">${Utils.escapeHtml(emp.position)}</td>
                            <td><span class="badge hr-dept-badge">${emp.department}</span> <b>${emp.schedule_type}</b></td>
                            <td class="text-right text-success font-bold">${Utils.formatMoney(emp.salary_cash).replace(" ₽","")} ₽</td>
                            <td class="text-right text-muted">${Utils.formatMoney(emp.salary_official).replace(" ₽","")} ₽</td>
                            <td class="text-right text-danger">-${Utils.formatMoney(emp.tax_withheld || 0).replace(" ₽","")} ₽</td>
                            <td class="text-right font-bold ${balance >= 0 ? 'text-primary' : 'text-danger'}">${balSign}${Utils.formatMoney(balance).replace(" ₽","")} ₽</td>
                            <td class="text-center align-middle">
                                <button class="btn btn-outline hr-row-btn" onclick="editEmployee(${emp.id})" title="Редактировать">✏️</button>
                            </td>
                        </tr>`;
                });
            }
        });
    } else {
        // Если фильтр включен, выводим без разделителей
        activeEmps.forEach(emp => { /* аналогичный код строки */
            const balance = getLiveBalance(emp);
            const balColor = balance >= 0 ? 'var(--primary)' : 'var(--danger)';
            const balSign = balance > 0 ? '+' : '';
            activeHtml += `
                <tr>
                    <td class="font-600">
                        <span class="entity-link" title="Открыть профиль" onclick="window.app.openEntity('employee', ${emp.id})">${Utils.escapeHtml(emp.full_name)}</span>
                    </td>
                    <td class="text-muted">${Utils.escapeHtml(emp.position)}</td>
                    <td><span class="badge hr-dept-badge">${emp.department}</span> <b>${emp.schedule_type}</b></td>
                    <td class="text-right text-success font-bold">${Utils.formatMoney(emp.salary_cash).replace(" ₽","")} ₽</td>
                    <td class="text-right text-muted">${Utils.formatMoney(emp.salary_official).replace(" ₽","")} ₽</td>
                    <td class="text-right text-danger">-${Utils.formatMoney(emp.tax_withheld || 0).replace(" ₽","")} ₽</td>
                    <td class="text-right font-bold ${balance >= 0 ? 'text-primary' : 'text-danger'}">${balSign}${Utils.formatMoney(balance).replace(" ₽","")} ₽</td>
                    <td class="text-center align-middle">
                        <button class="btn btn-outline hr-row-btn" onclick="editEmployee(${emp.id})" title="Редактировать">✏️</button>
                    </td>
                </tr>`;
        });
    }

    // === ГЕНЕРАЦИЯ АРХИВА (УВОЛЕННЫЕ) ===
    let firedHtml = '';
    firedEmps.forEach(emp => {
        const balance = parseFloat(emp.prev_balance || 0);
        const balColor = balance >= 0 ? 'var(--text-muted)' : 'var(--danger)';

        firedHtml += `
            <tr class="hr-fired-row">
                <td class="font-600">
                    <span class="entity-link" title="Открыть профиль" onclick="window.app.openEntity('employee', ${emp.id})">${Utils.escapeHtml(emp.full_name)}</span>
                </td>
                <td class="text-muted">${Utils.escapeHtml(emp.position)}</td>
                <td>${emp.department}</td>
                <td class="text-right font-bold ${balance >= 0 ? 'text-muted' : 'text-danger'}">${Utils.formatMoney(balance).replace(" ₽","")} ₽</td>
                <td class="text-center align-middle">
                    <button class="btn btn-outline hr-row-btn border-danger text-danger" onclick="hardDeleteEmployee(${emp.id}, '${Utils.escapeHtml(emp.full_name)}')" title="Удалить навсегда">❌</button>
                </td>
            </tr>`;
    });

    if (activeHtml === '') activeHtml = '<tr><td colspan="8" class="text-center text-muted hr-loading-cell">Сотрудники не найдены</td></tr>';
    if (firedHtml === '') firedHtml = '<tr><td colspan="5" class="text-center text-muted hr-loading-cell">Архив пуст</td></tr>';

    if (tbodyActive) tbodyActive.innerHTML = activeHtml;
    if (tbodyFired) tbodyFired.innerHTML = firedHtml;
}

// Принудительное обновление данных перед редактированием
window.editEmployee = async function (id) {
    try {
        // Запрашиваем свежие данные с сервера
        currentEmployees = await API.get('/api/employees');

        // Открываем форму
        openEmployeeForm(id);
    } catch (e) {
        console.error("Ошибка загрузки свежих данных сотрудника:", e);
        UI.toast('Ошибка загрузки данных', 'error');
    }
};
window.calcTaxWithheld = function () {
    const off = parseFloat(document.getElementById('emp-sal-off').value) || 0;
    const rate = parseFloat(document.getElementById('emp-tax-rate').value) || 0;
    document.getElementById('emp-tax-withheld').value = Math.round(off * (rate / 100));
};

// [Комментарий: Форма редактирования с защитой исторических данных]
window.openEmployeeForm = async function (empId = null) {
    // Находим сотрудника (работает и для создания, и для редактирования)
    const emp = empId ? currentEmployees.find(e => e.id === empId) : null;
    const isEdit = !!emp;

    // Справочный вывод живого баланса (только для режима редактирования)
    let liveBalanceHtml = '';
    if (isEdit) {
        const liveBalance = getLiveBalance(emp); // Берет данные из табеля
        const balColor = liveBalance >= 0 ? 'var(--primary)' : 'var(--danger)';
        const balSign = liveBalance > 0 ? '+' : '';
        liveBalanceHtml = `
            <div class="hr-form-live-balance">
                Текущий расчетный остаток (с учетом табеля): 
                <b class="font-15 ${liveBalance >= 0 ? 'text-primary' : 'text-danger'}">${balSign}${Utils.formatMoney(liveBalance).replace(" ₽","")} ₽</b>
            </div>
        `;
    }

    const html = `
        <div class="form-grid form-grid-2col">
            <div class="form-group">
                <label>ФИО сотрудника:</label>
                <input type="text" id="emp-name" class="input-modern" value="${isEdit ? Utils.escapeHtml(emp.full_name) : ''}">
            </div>
            <div class="form-group">
                <label>Должность:</label>
                <input type="text" id="emp-pos" class="input-modern" value="${isEdit ? Utils.escapeHtml(emp.position) : ''}" placeholder="Например: Разнорабочий">
            </div>
            <div class="form-group">
                <label>Отдел:</label>
                <select id="emp-dep" class="input-modern">
                    <option value="Офис" ${isEdit && emp.department === 'Офис' ? 'selected' : ''}>Офис</option>
                    <option value="Охрана" ${isEdit && emp.department === 'Охрана' ? 'selected' : ''}>Охрана</option>
                    <option value="Цех" ${isEdit && emp.department === 'Цех' ? 'selected' : ''}>Цех</option>
                </select>
            </div>
            <div class="form-group">
                <label>График работы:</label>
                <select id="emp-sched" class="input-modern">
                    <option value="5/2" ${isEdit && emp.schedule_type === '5/2' ? 'selected' : ''}>5/2 (Рабочие дни)</option>
                    <option value="1/3" ${isEdit && emp.schedule_type === '1/3' ? 'selected' : ''}>1/3 (Сутки через трое)</option>
                </select>
            </div>
            
            <div class="form-group hr-form-cash-block">
                <label class="text-success font-bold">Базовая ставка / Оклад (Нал):</label>
                <input type="number" id="emp-sal-cash" class="input-modern font-16 font-bold" value="${isEdit ? emp.salary_cash : '0'}">
            </div>

            <div class="form-group hr-form-official-block">
                <label class="font-bold">Официальная ЗП (Безнал):</label>
                <input type="number" id="emp-sal-off" class="input-modern" value="${isEdit ? emp.salary_official : '20000'}" oninput="calcTaxWithheld()">
                
                <div class="flex-row gap-10 mt-10">
                    <div class="flex-1">
                        <label class="font-11">Ставка налога (%):</label>
                        <input type="number" id="emp-tax-rate" class="input-modern" value="${isEdit ? emp.tax_rate : '13'}" oninput="calcTaxWithheld()">
                    </div>
                    <div class="flex-1">
                        <label class="font-11 text-danger">Фактическое удержание из Нал. (₽):</label>
                        <input type="number" id="emp-tax-withheld" class="input-modern text-danger font-bold" value="${isEdit ? emp.tax_withheld : '2600'}">
                    </div>
                </div>
            </div>

            <div class="form-group hr-form-status-block">
                <label class="text-danger font-bold">Статус в компании:</label>
                <select id="emp-status" class="input-modern font-bold">
                    <option value="active" ${isEdit && emp.status === 'active' ? 'selected' : ''}>🟢 Работает</option>
                    <option value="fired" ${isEdit && emp.status === 'fired' ? 'selected' : ''}>🔴 УВОЛЕН (В архив)</option>
                </select>
            </div>

            <div class="form-group hr-form-balance-block">
                <label class="text-primary font-bold">± Остаток на НАЧАЛО месяца (Исторический долг):</label>
                <input type="number" id="emp-prev-balance" class="input-modern font-15 font-bold" value="${isEdit ? (emp.prev_balance || 0) : '0'}">
                <div class="font-11 text-muted mt-4">Внимание: редактируйте поле выше ТОЛЬКО для исправления старых долгов.</div>
                ${liveBalanceHtml}
            </div>
        </div>
    `;

    const buttons = `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-blue" onclick="saveEmployee(${isEdit ? emp.id : 'null'})">💾 Сохранить</button>
    `;
    UI.showModal(isEdit ? '✏️ Редактирование сотрудника' : '➕ Новый сотрудник', html, buttons);

    setTimeout(() => {
        ['emp-dep', 'emp-sched', 'emp-status'].forEach(id => {
            const el = document.getElementById(id);
            if (el && !el.tomselect) new TomSelect(el, { plugins: ['clear_button'], dropdownParent: 'body' });
        });
    }, 50);
};

async function saveEmployee(id) {
    const payload = {
        full_name: document.getElementById('emp-name').value,
        department: document.getElementById('emp-dep').value,
        position: document.getElementById('emp-pos').value,
        schedule_type: document.getElementById('emp-sched').value,
        salary_cash: parseFloat(document.getElementById('emp-sal-cash').value) || 0,
        salary_official: parseFloat(document.getElementById('emp-sal-off').value) || 0,
        tax_rate: parseFloat(document.getElementById('emp-tax-rate').value) || 0,
        tax_withheld: parseFloat(document.getElementById('emp-tax-withheld').value) || 0,
        prev_balance: parseFloat(document.getElementById('emp-prev-balance').value) || 0,
        status: document.getElementById('emp-status').value
    };

    if (!payload.full_name) return UI.toast('Введите ФИО!', 'error');

    try {
        if (id) {
            await API.put(`/api/employees/${id}`, payload);
        } else {
            await API.post('/api/employees', payload);
        }
        UI.toast('Успешно сохранено!', 'success');
        UI.closeModal();
        loadEmployees();
        loadMonthlyTimesheet();
    } catch (e) { console.error(e); }
}

// ==========================================
// БЕЗОПАСНОЕ "УДАЛЕНИЕ" (Soft Delete)
// Комментарий: Физически удалять людей нельзя из-за финансовой истории.
// Мы переводим их в архив (статус fired).
// ==========================================
window.hardDeleteEmployee = function (id, name) {
    const html = `
        <div class="p-15 text-center font-15">
            Вы уверены, что хотите <b>НАВСЕГДА</b> удалить карточку <br><b class="text-danger font-18">${Utils.escapeHtml(name)}</b>?<br><br>
            <small class="text-muted">Удаляйте только в том случае, если сотрудник был добавлен по ошибке и по нему еще нет табелей. Иначе старые расчеты могут сломаться.</small>
        </div>`;

    UI.showModal('⚠️ Полное удаление из базы', html, `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-blue bg-danger-btn border-danger" onclick="executeHardDelete(${id})">🗑️ Да, удалить навсегда</button>
    `);
};

window.executeHardDelete = async function (id) {
    UI.toast('⏳ Удаление...', 'info');
    try {
        await API.delete(`/api/employees/${id}`);
        UI.closeModal();
        UI.toast('✅ Сотрудник полностью удален из базы', 'success');
        loadEmployees(); // Обновляем таблицы
    } catch (e) { console.error(e); }
};

// === СИНХРОНИЗАЦИЯ СЕЛЕКТОВ МЕСЯЦА ===
window.syncSalaryMonth = function (val) {
    if (!val) return;
    const tsPicker = document.getElementById('ts-month-picker');
    const payPicker = document.getElementById('payroll-period-select');

    // Предотвращение infinite loop: проверка текущего значения перед установкой
    if (tsPicker && tsPicker.value !== val) tsPicker.value = val;
    if (payPicker && payPicker.value !== val) payPicker.value = val;

    // Единый вызов загрузки данных
    if (typeof loadMonthlyTimesheet === 'function') {
        loadMonthlyTimesheet();
    }
};

// === ЗАГРУЗКА МЕСЯЧНЫХ ДАННЫХ (УСКОРЕННАЯ) ===
window.loadMonthlyTimesheet = async function () {
    const monthPicker = document.getElementById('ts-month-picker').value;
    if (!monthPicker) return;
    const [year, month] = monthPicker.split('-');

    try {
        // Запускаем все 5 запросов к серверу ОДНОВРЕМЕННО
        const [closedData, tsData, payData, statsData, adjData] = await Promise.all([
            API.get(`/api/salary/is-closed?monthStr=${year}-${month}`),
            API.get(`/api/timesheet/month?year=${year}&month=${month}`),
            API.get(`/api/salary/payments?year=${year}&month=${month}`),
            API.get(`/api/salary/stats?year=${year}&month=${month}`),
            API.get(`/api/salary/adjustments?monthStr=${year}-${month}`)
        ]);

        window.currentMonthStatus = closedData;
        currentMonthRecords = tsData;
        currentMonthPayments = payData;
        currentMonthStats = statsData;
        currentMonthAdjustments = adjData;

        renderTimesheetMatrix(parseInt(year), parseInt(month));
    } catch (e) {
        console.error("Ошибка загрузки данных табеля:", e);
    }
}

// === ОТРИСОВКА МАТРИЦЫ И ВЫПЛАТ ===
window.renderTimesheetMatrix = function (year, month) {
    const daysInMonth = new Date(year, month, 0).getDate();
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    // === КЭШИРОВАНИЕ ЗАПИСЕЙ (Ускоряет отрисовку в десятки раз) ===
    const recordsMap = {};
    if (currentMonthRecords && currentMonthRecords.length > 0) {
        currentMonthRecords.forEach(r => {
            // Оставляем только дату YYYY-MM-DD из строки базы данных
            const dateOnly = r.record_date.split('T')[0];
            recordsMap[`${r.employee_id}_${dateOnly}`] = r;
        });
    }
    // =============================================================
    let normDays52 = 0;
    for (let d = 1; d <= daysInMonth; d++) {
        const dow = new Date(year, month - 1, d).getDay();
        if (dow !== 0 && dow !== 6) normDays52++;
    }
    const normShifts13 = daysInMonth / 4;

    const thead = document.getElementById('monthly-ts-head');
    const dayNames = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
    let headHtml = `<tr><th class="hr-ts-sticky-name">Сотрудник</th>`;
    for (let day = 1; day <= daysInMonth; day++) {
        const dow = new Date(year, month - 1, day).getDay();
        const isWeekend = dow === 0 || dow === 6;
        const isToday = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` === todayStr;

        const thClasses = ['hr-ts-day-th'];
        if (isWeekend) thClasses.push('hr-ts-weekend-head');
        if (isToday) thClasses.push('hr-ts-today-head');

        headHtml += `<th class="${thClasses.join(' ')}">
            <div class="hr-ts-day-name">${dayNames[dow]}</div>
            <div>${day}</div>
        </th>`;
    }
    headHtml += `<th class="hr-ts-summary-head">Итого (Дни / ₽)</th></tr>`;

    const tbody = document.getElementById('monthly-ts-body');
    let bodyHtml = '';

    // === НОВАЯ ЛОГИКА ФИЛЬТРОВ ТАБЕЛЯ ===
    const depFilter = document.getElementById('ts-dep-filter')?.value || 'all';
    const searchTerm = (document.getElementById('ts-search-input')?.value || '').toLowerCase();
    const departments = depFilter === 'all' ? ['Офис', 'Цех', 'Охрана'] : [depFilter];

    departments.forEach(dep => {
        const depEmps = currentEmployees.filter(e => {
            // 1. Фильтр по отделу
            if (e.department !== dep) return false;

            // 2. Умный поиск по имени или должности
            const matchSearch = e.full_name.toLowerCase().includes(searchTerm) || e.position.toLowerCase().includes(searchTerm);
            if (!matchSearch) return false;

            // 3. Логика уволенных (показываем только если есть отметки в этом месяце)
            if (e.status !== 'fired') return true;
            return currentMonthRecords.some(r => r.employee_id === e.id && ['present', 'partial', 'sick', 'vacation'].includes(r.status));
        });

        if (depEmps.length === 0) return;

        bodyHtml += `<tr><td colspan="${daysInMonth + 2}" class="hr-ts-dept-row">Отдел: ${dep.toUpperCase()}</td></tr>`;

        depEmps.forEach(emp => {
            const empStat = currentMonthStats.find(s => s.employee_id === emp.id) || emp;
            const baseSalary = parseFloat(empStat.salary_cash) || 0;
            const dailyCost = emp.schedule_type === '5/2' ? Math.round(baseSalary / normDays52) : Math.round(baseSalary / normShifts13);

            // Убрали onmouseover и жесткий белый фон
            bodyHtml += `<tr>
                <td class="hr-ts-sticky-cell">
                    <div class="font-600">${emp.full_name} ${emp.status === 'fired' ? '<span class="badge bg-danger text-white font-10 p-2-6">Уволен</span>' : ''}</div>
                    <div class="font-11 text-muted">${emp.position} | Оклад: ${Utils.formatMoney(baseSalary).replace(" ₽","")} ₽ | График: <b>${emp.schedule_type}</b></div>
                </td>`;

            let worked = 0, sick = 0, vacation = 0, absent = 0;
            let earnedBase = 0, totalBonus = 0, totalPenalty = 0;

            for (let day = 1; day <= daysInMonth; day++) {
                const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                const dow = new Date(year, month - 1, day).getDay();
                const isWeekend = dow === 0 || dow === 6;
                const isToday = dateStr === todayStr;
                const record = recordsMap[`${emp.id}_${dateStr}`];

                let status = 'weekend';
                let cellBonus = 0;
                let cellPenalty = 0;
                let cellBonusComment = '';
                let cellPenaltyComment = '';
                let cellBaseRate = dailyCost;
                let ktuText = '';
                let cellMultiplier = 1.0;

                if (record) {
                    status = record.status;
                    cellBonus = parseFloat(record.bonus) || 0;
                    cellPenalty = parseFloat(record.penalty) || 0;
                    cellBonusComment = record.bonus_comment || '';
                    cellPenaltyComment = record.penalty_comment || '';
                    if (record.multiplier !== undefined && record.multiplier !== null) {
                        cellMultiplier = parseFloat(record.multiplier);
                    }

                    if (record.custom_rate !== null && record.custom_rate !== undefined) cellBaseRate = parseFloat(record.custom_rate);
                    if (record.ktu && parseFloat(record.ktu) !== 1.0) ktuText = ` (КТУ ${parseFloat(record.ktu)})`;
                } else {
                    if (emp.schedule_type === '5/2' && !isWeekend) status = 'weekend';
                    if (emp.schedule_type === '5/2' && isWeekend) status = 'weekend';
                    if (emp.schedule_type === '1/3') status = 'weekend';
                }

                if (status === 'present') {
                    worked++;
                    earnedBase += cellBaseRate;
                } else if (status === 'partial') {
                    worked += cellMultiplier;
                    earnedBase += (cellBaseRate * cellMultiplier);
                } else if (status === 'sick') sick++;
                else if (status === 'vacation') vacation++;
                else if (status === 'absent') absent++;

                totalBonus += cellBonus;
                totalPenalty += cellPenalty;

                const tdClasses = ['hr-ts-cell-td'];
                if (isWeekend) tdClasses.push('hr-weekend-bg');
                if (isToday) tdClasses.push('hr-today-cell');

                let extraIcons = '';
                if (cellBonus > 0) extraIcons += '<div class="hr-ts-dot hr-ts-dot-bonus"></div>';
                if (cellPenalty > 0) extraIcons += '<div class="hr-ts-dot hr-ts-dot-penalty"></div>';

                // 🌟 БЕЗОПАСНЫЙ ДВИЖОК СОБЫТИЙ С ЧТЕНИЕМ ЧЕРЕЗ DATA-*
                const isFired = emp.status === 'fired';
                const isMonthClosedForEdit = window.currentMonthStatus?.isClosed === true;

                let actionEvents = '';
                let cellCursor = '';

                if (isMonthClosedForEdit) {
                    actionEvents = `onclick="UI.toast('Месяц закрыт. Редактирование запрещено.', 'warning')"`;
                    cellCursor = 'cursor: not-allowed; opacity: 0.8;';
                } else if (isFired) {
                    actionEvents = `onclick="UI.toast('Сотрудник уволен. Редактирование запрещено.', 'warning')"`;
                    cellCursor = 'cursor: not-allowed;';
                } else {
                    actionEvents = `data-emp-id="${emp.id}"
                       data-emp-name="${Utils.escapeHtml(emp.full_name)}"
                       data-date="${dateStr}"
                       data-status="${status}"
                       data-bonus="${cellBonus}"
                       data-penalty="${cellPenalty}"
                       data-cost="${dailyCost}"
                       data-multiplier="${cellMultiplier}"
                       data-b-comment="${Utils.escapeHtml(cellBonusComment)}"
                       data-p-comment="${Utils.escapeHtml(cellPenaltyComment)}"
                       onmousedown="startCellPress(event, this)" 
                       onmouseup="endCellPress(event, this)" 
                       onmouseleave="cancelCellPress()"
                       ontouchstart="startCellPress(event, this)"
                       ontouchend="endCellPress(event, this)"
                       ontouchcancel="cancelCellPress()"`;
                    cellCursor = 'cursor: pointer; user-select: none; -webkit-user-select: none; touch-action: manipulation;';
                }

                bodyHtml += `
                    <td class="${tdClasses.join(' ')}">
                        <div class="hr-ts-cell-wrap ${isFired && status === 'weekend' ? 'hr-fired-faded' : ''}">
                            <div class="ts-cell status-${status} ${isMonthClosedForEdit || isFired ? 'hr-cell-locked' : 'hr-cell-active'}" 
                                title="${emp.full_name} | ${dateStr}\nОклад (Факт): ${cellBaseRate}₽/д${ktuText}\nПремия: ${cellBonus}₽ | Штраф: ${cellPenalty}₽\nДоля: ${cellMultiplier}"
                                ${actionEvents}>
                                ${status === 'partial' ? cellMultiplier : day}
                            </div>
                            ${extraIcons}
                        </div>
                    </td>
                `;
            }

            const totalEarned = earnedBase + totalBonus - totalPenalty;

            let summaryHtml = `<td class="hr-ts-summary-cell">`;
            const normText = emp.schedule_type === '5/2' ? `${worked} / ${normDays52} дн` : `${worked} / ${Math.round(normShifts13)} см`;
            const isNormMet = emp.schedule_type === '5/2' ? worked >= normDays52 : worked >= normShifts13;

            summaryHtml += `<div class="font-12 font-600 ${isNormMet ? 'text-success' : 'text-main'}">${normText}</div>`;
            summaryHtml += `<div class="text-primary font-bold font-15 mt-4">${Utils.formatMoney(totalEarned).replace(" ₽","")} ₽</div>`;

            let moneyStats = [];
            if (totalBonus > 0) moneyStats.push(`<span class="text-success">+${Utils.formatMoney(totalBonus).replace(" ₽","")}₽</span>`);
            if (totalPenalty > 0) moneyStats.push(`<span class="text-danger">-${Utils.formatMoney(totalPenalty).replace(" ₽","")}₽</span>`);
            if (moneyStats.length > 0) summaryHtml += `<div class="font-11 mt-4 flex-row gap-6 justify-end font-bold">${moneyStats.join(' ')}</div>`;

            summaryHtml += `</td>`;
            bodyHtml += summaryHtml + `</tr>`;
        });
    });

    if (tbody) tbody.innerHTML = bodyHtml;

    /// --- 4. РАСЧЕТ ИТОГОВ НА СЕГОДНЯ ---
    let sumTotal = { 'Офис': 0, 'Цех': 0, 'Охрана': 0, 'Всего': 0 };
    let payoutsHtml = '';
    let totalMonthTaxes = 0;
    currentMonthBalances = [];
    currentPrintData = [];
    currentPrintAdvancesData = [];

    // Читаем новые фильтры вкладки "Выплаты"
    const payDepFilter = document.getElementById('pay-dep-filter')?.value || 'all';
    const paySearchTerm = (document.getElementById('pay-search-input')?.value || '').toLowerCase();

    currentEmployees.forEach(emp => {
        let earnedToday = 0;

        const empStat = currentMonthStats.find(s => s.employee_id === emp.id) || emp;
        const baseSalary = parseFloat(empStat.salary_cash) || 0;
        const officialSalary = parseFloat(empStat.salary_official) || 0;
        const taxRate = parseFloat(empStat.tax_rate) || 0;

        let taxWithheld = parseFloat(empStat.tax_withheld) || 0;
        const prevBalance = parseFloat(emp.prev_balance) || 0;

        const dailyCost = emp.schedule_type === '5/2' ? Math.round(baseSalary / normDays52) : Math.round(baseSalary / normShifts13);
        const todayNum = (year === now.getFullYear() && month === (now.getMonth() + 1)) ? now.getDate() : daysInMonth;

        for (let day = 1; day <= todayNum; day++) {
            const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            // Ускоренный поиск (если словарь уже создан)
            const record = typeof recordsMap !== 'undefined' ? recordsMap[`${emp.id}_${dateStr}`] : currentMonthRecords.find(r => r.employee_id === emp.id && r.record_date.startsWith(dateStr));

            if (record) {
                if (record.status === 'present') {
                    earnedToday += (record.custom_rate !== null && record.custom_rate !== undefined) ? parseFloat(record.custom_rate) : dailyCost;
                }
                earnedToday += (parseFloat(record.bonus) || 0) - (parseFloat(record.penalty) || 0);
            }
        }

        const empPayments = currentMonthPayments.filter(p => p.employee_id === emp.id);
        const advances = empPayments.reduce((sum, p) => sum + parseFloat(p.amount), 0);

        if (advances > 0) {
            currentPrintAdvancesData.push({ department: emp.department, name: emp.full_name, position: emp.position, amount: advances });
        }

        let finalTax = taxWithheld;
        if (earnedToday <= 0) {
            finalTax = 0;
        } else {
            const officialTaxes = Math.round(officialSalary * (taxRate / 100));
            totalMonthTaxes += officialTaxes;
        }

        const adjSum = currentMonthAdjustments.filter(a => a.employee_id === emp.id).reduce((s, a) => s + parseFloat(a.amount), 0);
        const availableToPay = earnedToday - finalTax + prevBalance - advances + adjSum;

        if (emp.status === 'fired' && earnedToday === 0 && prevBalance === 0 && advances === 0 && adjSum === 0) return;

        // ВАЖНО: Математику считаем для ВСЕХ сотрудников (чтобы итоги карточек не ломались)
        const netChange = earnedToday - finalTax - advances + adjSum;
        sumTotal[emp.department] += availableToPay;
        sumTotal['Всего'] += availableToPay;
        currentMonthBalances.push({ employee_id: emp.id, balance: availableToPay, accrued: earnedToday, net_change: netChange });

        if (availableToPay !== 0 || earnedToday > 0) {
            currentPrintData.push({
                department: emp.department, name: emp.full_name, position: emp.position,
                earned: earnedToday, prevBalance: prevBalance, tax: finalTax,
                advances: advances, adjustments: adjSum, amount: availableToPay
            });
        }

        // === ПРИМЕНЯЕМ ФИЛЬТРЫ ТОЛЬКО ДЛЯ ОТРИСОВКИ СТРОК ТАБЛИЦЫ ===
        const matchDep = payDepFilter === 'all' || emp.department === payDepFilter;
        const matchSearch = emp.full_name.toLowerCase().includes(paySearchTerm) || emp.position.toLowerCase().includes(paySearchTerm);

        if (matchDep && matchSearch) {
            let advancesHtml = `<span class="text-muted">0 ₽</span>`;
            if (advances > 0) advancesHtml = `<span class="text-primary text-underline cursor-pointer font-bold" onclick="openAdvancesDetails(${emp.id}, '${Utils.escapeHtml(emp.full_name)}')">-${Utils.formatMoney(advances).replace(" ₽","")} ₽</span>`;

            let adjHtml = `<span class="text-muted">0 ₽</span>`;
            if (adjSum !== 0) adjHtml = `<span class="font-bold ${adjSum > 0 ? 'text-success' : 'text-danger'}">${adjSum > 0 ? '+' : ''}${Utils.formatMoney(adjSum).replace(" ₽","")} ₽</span>`;

            payoutsHtml += `
                <tr>
                    <td><strong class="font-14">${Utils.escapeHtml(emp.full_name)}</strong><br><span class="font-11 ${emp.status === 'fired' ? 'text-danger' : 'text-muted'}">${emp.status === 'fired' ? 'УВОЛЕН' : Utils.escapeHtml(emp.position)}</span></td>
                    <td class="text-right font-bold font-15">${Utils.formatMoney(earnedToday).replace(" ₽","")} ₽</td>
                    <td class="text-right font-bold ${prevBalance >= 0 ? 'text-primary' : 'text-danger'}">${prevBalance > 0 ? '+' : ''}${Utils.formatMoney(prevBalance).replace(" ₽","")} ₽</td>
                    <td class="text-right text-danger">-${Utils.formatMoney(finalTax).replace(" ₽","")} ₽</td>
                    <td class="text-right">${advancesHtml}</td>
                    <td class="text-right hr-adj-cell cursor-pointer" onclick="openAdjustmentsModal(${emp.id}, '${Utils.escapeHtml(emp.full_name)}', '${year}-${String(month).padStart(2, '0')}')">‌${adjHtml}</td>
                    <td class="text-right font-bold font-16 ${availableToPay >= 0 ? 'hr-payout-positive' : 'hr-payout-negative'}">${Utils.formatMoney(availableToPay).replace(" ₽","")} ₽</td>
                    <td class="text-center">
                        <div class="flex-row gap-5 justify-center">
                            <button class="btn btn-outline hr-adj-btn border-warning text-warning" onclick="openAdjustmentsModal(${emp.id}, '${Utils.escapeHtml(emp.full_name)}', '${year}-${String(month).padStart(2, '0')}')">⚙️</button>
                            <button class="btn btn-blue hr-pay-btn" onclick="openPayoutModal(${emp.id}, '${Utils.escapeHtml(emp.full_name)}', ${availableToPay})">💳</button>
                        </div>
                    </td>
                </tr>
            `;
        }
    });

    // Обновляем заголовок текущим месяцем и годом
    const monthsRu = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
    const titleEl = document.getElementById('payout-month-title');
    if (titleEl && !isNaN(month)) {
        titleEl.innerText = `Расчетный лист: ${monthsRu[month - 1]} ${year}`;
    }

    const isClosed = window.currentMonthStatus?.isClosed;
    const displayTaxes = isClosed ? parseFloat(window.currentMonthStatus.total_taxes) : totalMonthTaxes;

    // Управление видимостью кнопки отмены закрытия в верхней панели (рядом с селектом)
    const topReopenBtn = document.getElementById('reopen-month-btn-payroll');
    if (topReopenBtn) {
        topReopenBtn.style.display = isClosed ? 'inline-block' : 'none';
    }

    // === ЧИСТАЯ ГЕНЕРАЦИЯ ПОДВАЛА ТАБЛИЦЫ ===
    payoutsHtml += `
        <tr>
            <td colspan="8" class="payouts-footer">
                <span class="tax-control-group">
                    Управленческие Налоги (13%): 
                    <input type="number" id="final-month-taxes" class="input-modern hr-taxes-input text-right" value="${displayTaxes}" ${isClosed ? 'disabled' : ''}> ₽
                </span>
                
                ${isClosed
            ? `<span class="badge-closed">🔒 Месяц закрыт</span> <button class="btn btn-outline admin-only border-danger text-danger ml-15" onclick="reopenSalaryMonth()">🔓 Отменить закрытие</button>`
            : `<button class="btn btn-blue bg-danger-btn border-danger p-10-20" onclick="closeSalaryMonth()">🔒 Закрыть месяц</button>`
        }
            </td>
        </tr>
    `;

    // Вызываем скрытие admin-only кнопок, если пользователь не админ (используя глобальную логику)
    setTimeout(() => {
        if (typeof window.startApp === 'function') {
            const token = localStorage.getItem('token') || localStorage.getItem('jwtToken');
            if (token) {
                try {
                    const parts = token.split('.');
                    if (parts.length === 3) {
                        const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
                        if (payload.role !== 'admin') {
                            document.querySelectorAll('.admin-only').forEach(el => el.style.display = 'none');
                        }
                    }
                } catch (e) { }
            }
        }
    }, 50);

    // === ЧИСТАЯ ОТРИСОВКА КАРТОЧК ИТОГОВ ===
    const summaryBoxes = document.getElementById('salary-summary-boxes');
    if (summaryBoxes) {
        summaryBoxes.innerHTML = `
            <div class="summary-card office">
                <div class="summary-title">ОФИС (К выдаче)</div>
                <div class="summary-value">${Utils.formatMoney(sumTotal['Офис']).replace(" ₽","")} ₽</div>
            </div>
            <div class="summary-card shop">
                <div class="summary-title">ЦЕХ (К выдаче)</div>
                <div class="summary-value">${Utils.formatMoney(sumTotal['Цех']).replace(" ₽","")} ₽</div>
            </div>
            <div class="summary-card security">
                <div class="summary-title">ОХРАНА (К выдаче)</div>
                <div class="summary-value">${Utils.formatMoney(sumTotal['Охрана']).replace(" ₽","")} ₽</div>
            </div>
            <div class="summary-card total">
                <div class="summary-title">ОБЩИЙ ФОТ (К выдаче)</div>
                <div class="summary-value">${Utils.formatMoney(sumTotal['Всего']).replace(" ₽","")} ₽</div>
            </div>
        `;
    }

    const tbodyPayouts = document.getElementById('payouts-table-body');
    if (tbodyPayouts) tbodyPayouts.innerHTML = payoutsHtml;

    renderEmployeesTable();
};
// === ПОКАЗ ДЕТАЛИЗАЦИИ АВАНСОВ ===
window.openAdvancesDetails = function (empId, empName) {
    const empPayments = currentMonthPayments.filter(p => p.employee_id === empId);
    if (empPayments.length === 0) return;

    let detailsHtml = `
        <div class="table-container">
            <table>
                <thead class="bg-surface-alt"><tr><th>Дата выдачи</th><th class="text-right">Сумма</th><th>Комментарий (Основание)</th></tr></thead>
                <tbody>
                    ${empPayments.map(p => `
                        <tr>
                            <td class="font-600">${p.payment_date}</td>
                            <td class="text-right font-bold text-danger">${Utils.formatMoney(p.amount).replace(" ₽","")} ₽</td>
                            <td class="text-muted font-13">${p.description}</td>
                            <td class="text-center"><button class="btn btn-outline border-danger text-danger p-2-6" onclick="deleteSalaryPayment(${p.id})">🗑️</button></td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
    `;
    UI.showModal(`🧾 История выплат за месяц: ${empName}`, detailsHtml, `<button class="btn btn-outline" onclick="UI.closeModal()">Закрыть</button>`);
};

// === ВЫДАЧА ДЕНЕГ (ИСПРАВЛЕННАЯ ВЕРСИЯ) ===
window.openPayoutModal = async function (empId, empName, availableAmount) {
    const today = new Date().toISOString().split('T')[0];

    // Если счета еще не загружены - грузим по правильному адресу
    if (!window.currentAccounts || window.currentAccounts.length === 0) {
        window.currentAccounts = await API.get('/api/accounts');
    }

    // Автовыбор кассы по названию
    const options = (window.currentAccounts || []).map(acc => {
        const isDefault = acc.name.toLowerCase().includes('касса') || acc.name.toLowerCase().includes('наличные');
        return `<option value="${acc.id}" ${isDefault ? 'selected' : ''}>${Utils.escapeHtml(acc.name)} (${Utils.formatMoney(acc.balance).replace(" ₽","")} ₽)</option>`;
    }).join('');

    const emp = currentEmployees.find(e => e.id === empId);
    const debt = parseFloat(emp ? emp.imprest_debt : 0) || 0;
    const hasDebt = debt > 0;

    const html = `
        <div class="hr-payout-hero">
            <div class="hr-payout-hero-label">Доступно к выдаче</div>
            <div id="payout-display-amount" class="hr-payout-hero-amount">${Utils.formatMoney(hasDebt ? (availableAmount - debt) : availableAmount)}</div>
            <div class="font-14 text-main">Сотрудник: <span class="entity-link font-bold" title="Открыть профиль" onclick="window.app.openEntity('employee', ${empId})">${Utils.escapeHtml(empName)}</span></div>
        </div>

        ${hasDebt ? `
        <div class="hr-debt-block">
            <div class="flex-between align-center">
                <div>
                    <div class="font-12 text-warning font-bold">ДОЛГ ПО ПОДОТЧЕТУ</div>
                    <div class="font-18 font-bold text-danger">${Utils.formatMoney(debt).replace(" ₽","")} ₽</div>
                </div>
                <div class="flex-row align-center gap-8 cursor-pointer">
                    <input type="checkbox" id="hold-imprest-debt" class="hr-checkbox" 
                           ${hasDebt ? 'checked' : ''} 
                           onchange="updatePayoutFinalAmount(${availableAmount}, ${debt})">
                    <label for="hold-imprest-debt" class="font-13 font-600 cursor-pointer">Удержать долг</label>
                </div>
            </div>
            <input type="hidden" id="imprest-debt-amount" value="${debt}">
        </div>
        ` : ''}

        <div class="form-group mb-15">
            <label class="font-bold">Сумма к выдаче на руки (₽):</label>
            <input type="number" id="payout-amount" class="input-modern font-20 font-bold text-primary" 
                   value="${hasDebt ? (availableAmount - debt) : availableAmount}" onfocus="this.select()">
        </div>
        
        <div class="form-group mb-15">
            <label>Списать со счета:</label>
            <select id="payout-account-id" class="input-modern font-bold">
                ${options || '<option disabled>Счета не найдены</option>'}
            </select>
        </div>

        <div class="form-grid form-grid-2col gap-15">
            <div class="form-group"><label>Дата:</label><input type="date" id="payout-date" class="input-modern" value="${today}"></div>
            <div class="form-group"><label>Комментарий:</label><input type="text" id="payout-desc" class="input-modern" value="Зарплата"></div>
        </div>
    `;

    // Вспомогательная функция для динамического пересчета
    window.updatePayoutFinalAmount = function (base, debtValue) {
        const hold = document.getElementById('hold-imprest-debt').checked;
        const final = hold ? (base - debtValue) : base;
        document.getElementById('payout-amount').value = final;
        document.getElementById('payout-display-amount').innerText = Utils.formatMoney(final);
    };

    UI.showModal('💳 Оформление выплаты', html, `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-blue" onclick="executePayout(${empId}, '${Utils.escapeHtml(empName)}')">💸 Подтвердить выдачу</button>
    `);

    setTimeout(() => {
        const el = document.getElementById('payout-account-id');
        if (el && !el.tomselect) new TomSelect(el, { plugins: ['clear_button'], dropdownParent: 'body' });
    }, 50);
};

window.executePayout = async function (empId, empName) {
    const amount = parseFloat(document.getElementById('payout-amount').value);
    const account_id = document.getElementById('payout-account-id').value;
    const date = document.getElementById('payout-date').value;
    const desc = document.getElementById('payout-desc').value;

    if (!amount || amount <= 0) return UI.toast('Введите сумму!', 'error');
    if (!account_id) return UI.toast('Выберите счет!', 'error');

    const holdDebt = document.getElementById('hold-imprest-debt')?.checked || false;
    const debtAmount = parseFloat(document.getElementById('imprest-debt-amount')?.value) || 0;

    try {
        // Роут из твоего hr.js: /api/salary/pay
        await API.post('/api/salary/pay', {
            employee_id: empId,
            amount,
            date,
            description: `${empName}: ${holdDebt ? `(Удержано подотчета ${debtAmount} ₽)` : ''}`,
            account_id,
            imprest_deduction: holdDebt ? debtAmount : 0
        });

        UI.closeModal();
        UI.toast('✅ Выплата проведена!', 'success');
        loadMonthlyTimesheet();
        if (typeof loadFinanceData === 'function') loadFinanceData();
    } catch (e) { console.error(e); }
};
// ==========================================
// 1. ОПЛАТА ОФИЦИАЛЬНЫХ НАЛОГОВ
// ==========================================

// ПОДГОТОВКА (Показ окна)
window.payOfficialTaxes = function (monthStr, amount) {
    const html = `
        <div class="p-10 font-15 text-center">
            <div class="font-40 mb-10">🏦</div>
            Списать <b class="text-primary font-18">${Utils.formatMoney(amount).replace(" ₽","")} ₽</b><br>
            с расчетного счета на уплату налогов за <b>${monthStr}</b>?
        </div>
    `;

    const buttons = `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-blue" onclick="executePayOfficialTaxes('${monthStr}', ${amount})">💳 Оплатить (Безнал)</button>
    `;

    UI.showModal('Оплата налогов', html, buttons);
};

// ВЫПОЛНЕНИЕ
window.executePayOfficialTaxes = async function (monthStr, amount) {
    UI.closeModal();
    UI.toast('⏳ Проведение платежа...', 'info');

    try {
        await API.post('/api/salary/pay-taxes', { monthStr, amount });
        UI.toast('✅ Налоги успешно оплачены (Безнал)!', 'success');
    } catch (e) { console.error(e); }
};


// ==========================================
// 2. ЗАКРЫТИЕ ЗАРПЛАТНОГО МЕСЯЦА
// ==========================================

// ПОДГОТОВКА (Показ окна)
window.closeSalaryMonth = function () {
    const monthStr = document.getElementById('ts-month-picker').value;
    const totalTaxes = parseFloat(document.getElementById('final-month-taxes').value) || 0;

    const html = `
        <div class="p-10 font-15">
            <div class="text-center font-40 mb-10">🔒</div>
            <div class="text-center mb-15">
                Вы уверены, что хотите закрыть <b class="text-primary">${monthStr}</b>?
            </div>
            <ul class="text-muted font-14 bg-surface-alt p-10-10-10-30 border-radius-6">
                <li>Заработанные суммы будут перенесены в архив.</li>
                <li>Налог (<b class="text-main">${Utils.formatMoney(totalTaxes).replace(" ₽","")} ₽</b>) будет зафиксирован.</li>
                <li>Текущие балансы "К ВЫДАЧЕ" станут начальным долгом/переплатой на следующий месяц.</li>
            </ul>
        </div>
    `;

    const buttons = `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-blue bg-danger-btn border-danger" 
                onclick="executeCloseSalaryMonth('${monthStr}', ${totalTaxes})">🔒 Да, закрыть месяц</button>
    `;

    UI.showModal('Закрытие месяца', html, buttons);
};

// ВЫПОЛНЕНИЕ
window.executeCloseSalaryMonth = async function (monthStr, totalTaxes) {
    UI.closeModal();
    UI.toast(`⏳ Закрытие периода ${monthStr}...`, 'info');

    try {
        await API.post('/api/salary/close-month', { monthStr, balances: currentMonthBalances, totalTaxes }); UI.toast('✅ Месяц успешно закрыт! Балансы зафиксированы.', 'success'); setTimeout(() => location.reload(), 1500);
    } catch (e) { console.error(e); }
};

// ==========================================
// ОТМЕНА ЗАКРЫТИЯ МЕСЯЦА (Только для Админов)
// ==========================================

window.reopenSalaryMonth = function () {
    const monthStr = document.getElementById('ts-month-picker').value;

    const html = `
        <div class="p-10 font-15">
            <div class="text-center font-40 mb-10">🔓</div>
            <div class="text-center mb-15 text-danger">
                <b>ВНИМАНИЕ: ОПАСНАЯ ОПЕРАЦИЯ</b><br>
                Вы собираетесь отменить закрытие <b>${monthStr}</b>!
            </div>
            <ul class="text-muted font-14 bg-surface-alt p-10-10-10-30 border-radius-6">
                <li>Балансы сотрудников будут математически возвращены к состоянию на <b>НАЧАЛО ${monthStr}</b>.</li>
                <li>Автоматические транзакции "Начисление ЗП" за этот месяц будут <b>УДАЛЕНЫ</b>.</li>
                <li>После отмены вы обязаны проверить данные и закрыть месяц снова!</li>
            </ul>
        </div>
    `;

    const buttons = `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-blue bg-danger-btn border-danger" 
                onclick="executeReopenSalaryMonth('${monthStr}')">🔓 Я понимаю риски, отменить закрытие</button>
    `;

    UI.showModal('Отмена закрытия месяца', html, buttons);
};

window.executeReopenSalaryMonth = async function (monthStr) {
    UI.closeModal();
    UI.toast(`⏳ Математический откат балансов периода ${monthStr}...`, 'info');

    try {
        // Отправляем текущие посчитанные балансы (diff_to_subtract)
        await API.post('/api/salary/reopen-month', { monthStr, balances: currentMonthBalances }); UI.toast('✅ Месяц успешно открыт! Балансы и транзакции откачены.', 'success'); setTimeout(() => location.reload(), 2000);
    } catch (e) { console.error(e); }
};

// === ДОП ОПЕРАЦИИ (ГСМ, ЗАЙМЫ) ===
window.openAdjustmentsModal = function (empId, empName, monthStr) {
    const adjs = currentMonthAdjustments.filter(a => a.employee_id === empId);
    let listHtml = adjs.length === 0 ? '<p class="text-muted font-13">В этом месяце операций не было.</p>' : '';
    if (adjs.length > 0) {
        listHtml = `<table class="w-100 font-13 mb-15">
            ${adjs.map(a => `
                <tr class="border-bottom">
                    <td class="p-5-0">${a.description}</td>
                    <td class="text-right font-bold ${parseFloat(a.amount) > 0 ? 'text-success' : 'text-danger'}">${parseFloat(a.amount) > 0 ? '+' : ''}${Utils.formatMoney(a.amount).replace(" ₽","")} ₽</td>
                    <td class="text-right"><button class="btn btn-outline" class="border-danger text-danger p-2-6" onclick="deleteAdjustment(${a.id})">❌</button></td>
                </tr>
            `).join('')}
        </table>`;
    }
    const html = `
        <div class="hr-adj-history-block"><h4 class="m-0 mb-10">История операций (${monthStr})</h4>${listHtml}</div>
        <div class="hr-adj-new-block">
            <h4 class="m-0 mb-10 text-warning">➕ Добавить операцию</h4>
            <div class="form-group mb-10">
                <label>Сумма (₽):</label><input type="number" id="adj-amount" class="input-modern" placeholder="Например: -5000 или 2000">
                <span class="font-11 text-muted">Используйте <b>минус</b> для удержания (ГСМ, Займ) и <b>плюс</b> для начисления.</span>
            </div>
            <div class="form-group"><label>Основание:</label><input type="text" id="adj-desc" class="input-modern" placeholder="Топливная карта №123"></div>
            <button class="btn btn-blue w-100 mt-15" onclick="saveAdjustment(${empId}, '${monthStr}')">Сохранить операцию</button>
        </div>
    `;
    UI.showModal(`⚙️ Разовые операции: ${empName}`, html, '<button class="btn btn-outline" onclick="UI.closeModal()">Закрыть</button>');
}
window.saveAdjustment = async function (empId, monthStr) {
    const amount = parseFloat(document.getElementById('adj-amount').value);
    const desc = document.getElementById('adj-desc').value.trim();
    if (!amount || !desc) return UI.toast('Заполните сумму и комментарий!', 'error');
    try {
        await API.post('/api/salary/adjustments', { employee_id: empId, month_str: monthStr, amount, description: desc });
        if (true) {
            UI.closeModal(); UI.toast('Операция сохранена', 'success'); loadMonthlyTimesheet();
        }
    } catch (e) { }
};
window.deleteAdjustment = async function (id) {
    try { await API.delete(`/api/salary/adjustments/${id}`); UI.closeModal(); loadMonthlyTimesheet(); } catch (e) { }
};
window.deleteSalaryPayment = function (paymentId) {
    UI.showModal('⚠️ Подтверждение удаления', '<div class="text-center"><p class="font-16 mb-10">Аннулировать эту выплату?</p></div>', `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-outline border-danger text-danger" onclick="executeDeleteSalaryPayment(${paymentId})">🗑️ Да, удалить</button>
    `);
};
window.executeDeleteSalaryPayment = async function (paymentId) {
    try {
        await API.delete(`/api/salary/payment/${paymentId}`);
        if (true) {
            UI.closeModal(); UI.toast('✅ Выплата аннулирована', 'success'); loadMonthlyTimesheet(); if (typeof loadFinanceData === 'function') loadFinanceData();
        }
    } catch (e) { }
};

// === СДЕЛЬНАЯ ЗАРПЛАТА ===
window.openPieceRateModal = function () {
    const today = new Date().toISOString().split('T')[0];
    const html = `<div class="form-group"><label>Выберите дату закрытой смены:</label><input type="date" id="piece-date" class="input-modern" value="${today}" onchange="loadPieceRateData()"></div><div id="piece-rate-content"></div>`;
    UI.showModal('🏭 Начисление сдельной премии за формовку', html, '<button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>');
    setTimeout(loadPieceRateData, 100);
};

window.setRate = function (empId, value) { document.getElementById(`rate-${empId}`).value = value; recalcPieceRate(); };

window.loadPieceRateData = async function () {
    const date = document.getElementById('piece-date').value;
    if (!date) return;
    const dateObj = new Date(date);
    const daysInMonth = new Date(dateObj.getFullYear(), dateObj.getMonth() + 1, 0).getDate();
    let normDays52 = 0;
    for (let d = 1; d <= daysInMonth; d++) {
        const dow = new Date(dateObj.getFullYear(), dateObj.getMonth(), d).getDay();
        if (dow !== 0 && dow !== 6) normDays52++;
    }
    const normShifts13 = daysInMonth / 4;

    document.getElementById('piece-rate-content').innerHTML = '<p class="text-center text-muted">Загрузка данных...</p>';
    try {
        const stats = await API.get(`/api/production/daily-stats?date=${date}`);

        const totalProduced = parseFloat(stats.total) || 0;
        const totalFund = parseFloat(stats.fund) || 0; // 🚀 НОВОЕ: Забираем готовый фонд с бэкенда

        const workshopEmps = currentEmployees.filter(e => e.department === 'Цех');
        let empsHtml = ''; let activeCount = 0;

        workshopEmps.forEach(emp => {
            const record = currentMonthRecords.find(r => r.employee_id === emp.id && r.record_date.startsWith(date));
            let isPresent = false;
            if (record && record.status === 'present') isPresent = true;
            if (!record && emp.schedule_type === '5/2' && new Date(date).getDay() !== 0 && new Date(date).getDay() !== 6) isPresent = true;

            if (isPresent) {
                activeCount++;
                const empStat = currentMonthStats.find(s => s.employee_id === emp.id) || emp;
                const baseSalary = parseFloat(empStat.salary_cash) || 0;
                const dailyCost = emp.schedule_type === '5/2' ? Math.round(baseSalary / normDays52) : Math.round(baseSalary / normShifts13);
                const currentKtu = record && record.ktu ? parseFloat(record.ktu) : 1.0;
                const currentRate = record && record.custom_rate !== null ? parseFloat(record.custom_rate) : dailyCost;

                empsHtml += `
                    <tr class="border-bottom bg-surface">
                        <td class="p-8"><label class="flex-row align-center gap-8 cursor-pointer"><input type="checkbox" class="piece-emp-checkbox" value="${emp.id}" checked onchange="recalcPieceRate()"><span class="font-13"><b>${emp.full_name}</b><br><span class="text-muted font-11">${emp.position}</span></span></label></td>
                        <td class="p-8 text-center"><input type="number" id="ktu-${emp.id}" class="input-modern text-center font-bold w-60" oninput="recalcPieceRate()"></td>
                        <td class="p-8"><div class="flex-row align-center gap-4"><input type="number" id="rate-${emp.id}" class="input-modern text-right w-75" oninput="recalcPieceRate()"><div class="flex-col gap-2"><button class="btn btn-outline p-1-4 font-10" onclick="setRate(${emp.id}, ${dailyCost})">100%</button><button class="btn btn-outline p-1-4 font-10" onclick="setRate(${emp.id}, ${Math.round(dailyCost / 2)})">50%</button><button class="btn btn-outline p-1-4 font-10 border-danger text-danger" onclick="setRate(${emp.id}, 0)">0</button></div></div></td>
                        <td id="bonus-${emp.id}" class="p-8 text-right text-success font-bold font-14">0 ₽</td>
                        <td id="total-${emp.id}" class="p-8 text-right font-bold font-15">0 ₽</td>
                    </tr>`;
            }
        });
        if (activeCount === 0) empsHtml = '<tr><td colspan="5" class="p-15 text-center text-danger">В этот день нет работающих сотрудников цеха.</td></tr>';

        // 🚀 НОВОЕ: Полностью автоматический интерфейс без ручного ввода ставки
        document.getElementById('piece-rate-content').innerHTML = `
            <div class="hr-piece-info-block">
                <div class="flex-between align-center">
                    <div>
                        <div class="font-13 text-muted">Выпущено продукции (План):</div>
                        <div class="font-18 font-bold text-main">${totalProduced} шт.</div>
                    </div>
                    <div class="text-right">
                        <div class="hr-piece-fund-label">Сдельный фонд смены:</div>
                        <input type="hidden" id="piece-fund-value" value="${totalFund}">
                        <b id="piece-fund" class="hr-piece-fund-value">${Utils.formatMoney(totalFund).replace(" ₽","")} ₽</b>
                    </div>
                </div>
                <div class="font-11 text-muted mt-10 pt-10 border-top dashed">
                    * 🤖 Фонд рассчитан <b>автоматически</b>. Система нашла все выпущенные партии за эту смену и умножила их на индивидуальную сдельную З/П каждого товара из Справочника.
                </div>
            </div>
            <h4 class="mb-10">Бригада на смене (Распределение КТУ):</h4>
            <div class="hr-piece-crew-scroll">
                <table class="hr-piece-table">
                    <thead class="bg-surface-alt position-sticky-top z-10"><tr><th class="p-8 text-left">Сотрудник</th><th class="p-8 text-center">КТУ</th><th class="p-8 text-left">Оклад (Смена)</th><th class="p-8 text-right">Сделка</th><th class="p-8 text-right">Итого день</th></tr></thead>
                    <tbody>${empsHtml}</tbody>
                </table>
            </div>
        `;
        document.getElementById('app-modal-footer').innerHTML = `<button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button><button class="btn btn-blue" id="piece-save-btn" onclick="savePieceRate('${date}')" disabled>💸 Начислить и Сохранить</button>`;
        recalcPieceRate();
    } catch (e) { console.error(e); }
};

window.setRate = function (empId, value) { document.getElementById(`rate-${empId}`).value = value; recalcPieceRate(); };

window.recalcPieceRate = function () {
    // 🚀 НОВОЕ: Берем фонд не из умножения, а напрямую из скрытого поля (от сервера)
    const fund = parseFloat(document.getElementById('piece-fund-value').value) || 0;

    const checkboxes = document.querySelectorAll('.piece-emp-checkbox:checked');
    let totalKtu = 0;
    checkboxes.forEach(cb => { totalKtu += parseFloat(document.getElementById(`ktu-${cb.value}`).value) || 0; });
    const fundPerKtu = totalKtu > 0 ? (fund / totalKtu) : 0;

    checkboxes.forEach(cb => {
        const id = cb.value;
        const ktu = parseFloat(document.getElementById(`ktu-${id}`).value) || 0;
        const rate = parseFloat(document.getElementById(`rate-${id}`).value) || 0;
        const bonus = ktu * fundPerKtu;
        document.getElementById(`bonus-${id}`).innerText = '+' + Utils.formatMoney(Math.round(bonus)).replace(" ₽","") + ' ₽';
        document.getElementById(`total-${id}`).innerText = Utils.formatMoney(Math.round(rate + bonus)).replace(" ₽","") + ' ₽';
    });

    // Блокируем кнопку сохранения, если фонд равен нулю или никто не выбран
    document.getElementById('piece-save-btn').disabled = (checkboxes.length === 0 || fund <= 0);
};

window.savePieceRate = async function (date) {
    const checkboxes = document.querySelectorAll('.piece-emp-checkbox:checked');
    if (checkboxes.length === 0) return UI.toast('Выберите хотя бы одного сотрудника', 'error');

    const workersData = [];
    let isValidKtu = true;

    checkboxes.forEach(cb => {
        const id = cb.value;
        const ktu = parseFloat(document.getElementById(`ktu-${id}`).value) || 0;
        const custom_rate = parseFloat(document.getElementById(`rate-${id}`).value) || 0;
        if (ktu < 0 || ktu > 5) isValidKtu = false;
        workersData.push({ employee_id: id, custom_rate, ktu });
    });

    if (!isValidKtu) return UI.toast('КТУ должно быть строго от 0 до 5', 'error');

    UI.toast('⏳ Расчет и сохранение...', 'info');

    try {
        await API.post('/api/timesheet/mass-bonus', { date, workersData });
        if (true) {
            UI.closeModal();
            UI.toast('Сдельная премия безопасно зафиксирована!', 'success');
            loadMonthlyTimesheet();
        } else {
            UI.toast(err.error || 'Ошибка при расчете сделки', 'error');
        }
    } catch (e) { console.error(e); }
};

window.fillTodayBySchedule = async function () {
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    if (today.getDay() === 0 || today.getDay() === 6) return UI.toast('Сегодня выходной! График 5/2 отдыхает.', 'info');

    const records = currentEmployees.filter(emp => emp.schedule_type === '5/2' && emp.status !== 'fired').map(emp => ({ employee_id: emp.id, status: 'present' }));
    if (records.length === 0) return UI.toast('Нет сотрудников для заполнения', 'info');

    try {
        await API.post('/api/timesheet', { date: dateStr, records });
        UI.toast(`Табель за СЕГОДНЯ заполнен!`, 'success');
        const currentPickerValue = document.getElementById('ts-month-picker').value;
        const todayMonthValue = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
        if (currentPickerValue !== todayMonthValue) document.getElementById('ts-month-picker').value = todayMonthValue;
        loadMonthlyTimesheet();
    } catch (e) { console.error(e); }
};

// === ПЕЧАТЬ ТАБЕЛЯ УЧЕТА ВРЕМЕНИ ===
window.printTimesheet = function () {
    // 1. Берем живой HTML таблицы прямо со страницы, чтобы не зависеть от мертвых переменных
    // Ищем таблицу по ближайшему известному ID внутри нее
    const thead = document.getElementById('monthly-ts-head');
    if (!thead) return alert('Таблица не найдена на странице!');
    const table = thead.closest('table');
    const tableHtml = table.outerHTML;

    // 2. Ищем или создаем скрытый iframe
    let iframe = document.getElementById('print-iframe');
    if (!iframe) {
        iframe = document.createElement('iframe');
        iframe.id = 'print-iframe';
        iframe.style.position = 'absolute';
        iframe.style.width = '0';
        iframe.style.height = '0';
        iframe.style.border = 'none';
        document.body.appendChild(iframe);
    }

    // 3. Формируем документ для печати с жестким DOCTYPE и белым фоном
    const doc = iframe.contentWindow.document;
    doc.open();
    doc.write(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Печать Табеля</title>
           <style>
                @media print {
                    @page { 
                        size: A4 landscape; /* Альбомная ориентация */
                        margin: 5mm; /* Делаем минимальные поля, чтобы влезло больше колонок */
                    }
                    body { 
                        -webkit-print-color-adjust: exact; 
                        print-color-adjust: exact; 
                        background: white !important;
                    }
                }
                body { 
                    font-family: Arial, sans-serif; 
                    background: white; 
                    color: black; 
                }
                h2 {
                    text-align: center;
                    font-size: 16px;
                    margin-bottom: 10px;
                }
                table { 
                    width: 100%; 
                    border-collapse: collapse; 
                    /* УБРАЛИ table-layout: fixed, теперь браузер сам распределит место */
                }
                th, td { 
                    border: 1px solid #000; 
                    padding: 2px 1px; /* Минимальные отступы слева и справа */
                    text-align: center; 
                    font-size: 8px; /* Уменьшаем шрифт ячеек, чтобы дни месяца влезли */
                    vertical-align: middle;
                }
                /* Первая колонка с ФИО (защищаем от сплющивания) */
                th:first-child, td:first-child {
                    text-align: left;
                    padding-left: 4px;
                    min-width: 150px; /* Даем жесткий минимум для ФИО и должности */
                    font-size: 9px;
                }

                /* Стили статусов для сохранения визуальной раскраски ячеек */
                .status-present { background-color: #dcfce7 !important; color: #166534 !important; }
                .status-absent { background-color: #fee2e2 !important; color: #991b1b !important; }
                .status-vacation { background-color: #e0e7ff !important; color: #3730a3 !important; }
                .status-sick { background-color: #fef08a !important; color: #854d0e !important; }
                .status-weekend { background-color: #f1f5f9 !important; color: #000000 !important; }
            </style>
        </head>
        <body>
            <h2>Табель учета рабочего времени</h2>
            ${tableHtml}
        </body>
        </html>
    `);
    doc.close();

    // 4. Печатаем через iframe с небольшой задержкой для рендера стилей
    setTimeout(() => {
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
    }, 300);
};

// === ПЕЧАТЬ ЗАРПЛАТЫ И АВАНСОВ ===
// БЛОК 8: Улучшенная печать ведомости
// Комментарий: Теперь в печатной форме бухгалтер и сотрудник видят
// всю детализацию: сколько начислено, прошлые долги, выданные авансы и штрафы.
window.printSalarySheet = function () {
    const monthStr = document.getElementById('ts-month-picker').value;
    if (currentPrintData.length === 0) return UI.toast('Нет данных для выдачи', 'error');

    let printWin = window.open('', '', 'width=1100,height=700');
    let html = `<html><head><title>Ведомость</title><style>body{font-family:Arial,sans-serif;padding:20px;} table{width:100%;border-collapse:collapse;font-size:12px;} th,td{border:1px solid #000;padding:6px;} th{background:#f0f0f0;font-weight:bold;text-align:center;} .dep-row{background:#e2e8f0;font-weight:bold;text-align:center;} .num{text-align:right;} @media print{.no-print{display:none;}}</style></head><body><h2 style="text-align:center;">ПЛАТЕЖНАЯ ВЕДОМОСТЬ</h2><div style="text-align:center;margin-bottom:20px;">Выдача за период: <b>${monthStr}</b></div><div class="no-print" style="text-align:center;margin-bottom:20px;"><button onclick="window.print()" style="padding:10px;background:#2563eb;color:#fff;border:none;border-radius:4px;cursor:pointer;">🖨️ Распечатать</button></div><table><thead><tr><th>№</th><th>ФИО</th><th>Начислено</th><th>Остаток</th><th>Удержание</th><th>Авансы</th><th>Доп.Опер.</th><th>К выдаче</th><th>Подпись</th></tr></thead><tbody>`;

    let grandTotal = 0; let counter = 1;
    ['Офис', 'Цех', 'Охрана'].forEach(dep => {
        const emps = currentPrintData.filter(e => e.department === dep);
        if (emps.length === 0) return;
        html += `<tr><td colspan="9" class="dep-row">${dep.toUpperCase()}</td></tr>`;

        emps.forEach(emp => {
            html += `<tr><td style="text-align:center;">${counter++}</td><td><b>${emp.name}</b><br><span style="font-size:10px;color:var(--text-muted);">${emp.position}</span></td><td class="num">${Utils.formatMoney(emp.earned).replace(" ₽","")} ₽</td><td class="num">${Utils.formatMoney(emp.prevBalance).replace(" ₽","")} ₽</td><td class="num">-${Utils.formatMoney(emp.tax).replace(" ₽","")} ₽</td><td class="num">-${Utils.formatMoney(emp.advances).replace(" ₽","")} ₽</td><td class="num">${Utils.formatMoney(emp.adjustments).replace(" ₽","")} ₽</td><td class="num"><b>${Utils.formatMoney(emp.amount).replace(" ₽","")} ₽</b></td><td></td></tr>`;
            grandTotal += emp.amount;
        });
    });
    html += `</tbody></table><h3 style="text-align:right;">Общая сумма к выдаче: <u>${Utils.formatMoney(grandTotal).replace(" ₽","")} ₽</u></h3><div style="margin-top:50px;display:flex;justify-content:space-between;"><div>Выдал: ____________</div><div>Утвердил: ____________</div></div></body></html>`;
    printWin.document.write(html); printWin.document.close();
};

// БЛОК 9: Выгрузка полной аналитики в Excel
// Комментарий: В CSV попадают все те же колонки, что и в печатную форму,
// для удобной работы в Excel или загрузки в 1С.
window.exportSalaryToCSV = function () {
    if (currentPrintData.length === 0) return UI.toast('Нет данных для выгрузки', 'error');
    let csvContent = "\uFEFFОтдел;ФИО;Должность;Начислено;Остаток(Прошлый Мес);Удержание(Налог);Авансы;Доп.Операции;ИТОГО К ВЫДАЧЕ\n";

    currentPrintData.forEach(emp => {
        csvContent += `${emp.department};${emp.name};${emp.position};${emp.earned};${emp.prevBalance};${emp.tax};${emp.advances};${emp.adjustments};${emp.amount}\n`;
    });

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `Зарплата_${document.getElementById('ts-month-picker').value}.csv`;
    document.body.appendChild(link); link.click(); document.body.removeChild(link);
    UI.toast('Файл успешно скачан!', 'success');
}

// БЛОК: Выгрузка списка авансов в Excel (CSV)
window.exportAdvancesToCSV = function () {
    if (currentPrintAdvancesData.length === 0) {
        return UI.toast('Нет данных по выданным авансам в этом месяце', 'warning');
    }

    // Формируем заголовки колонок
    let csvContent = "\uFEFFОтдел;ФИО;Должность;Выданный аванс (₽)\n";

    // Перебираем данные
    currentPrintAdvancesData.forEach(emp => {
        csvContent += `${emp.department};${emp.name};${emp.position};${emp.amount}\n`;
    });

    // Создаем файл и скачиваем
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `Список_Авансов_${document.getElementById('ts-month-picker').value}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    UI.toast('Список авансов успешно скачан!', 'success');
};

window.printAdvancesSheet = function () {
    const monthStr = document.getElementById('ts-month-picker').value;
    if (currentPrintAdvancesData.length === 0) return UI.toast('Авансов не было', 'error');

    let printWin = window.open('', '', 'width=900,height=700');
    let html = `<html><head><title>Ведомость авансов</title><style>body{font-family:Arial,sans-serif;padding:20px;} table{width:100%;border-collapse:collapse;} th,td{border:1px solid #000;padding:8px;font-size:14px;} th{background:#f0f0f0;font-weight:bold;text-align:center;} .dep-row{background:#e2e8f0;font-weight:bold;text-align:center;} .text-right{text-align:right;} .text-center{text-align:center;} @media print{.no-print{display:none;}}</style></head><body><h2 class="text-center">АВАНСОВАЯ ВЕДОМОСТЬ</h2><div class="text-center" style="margin-bottom:20px;">За период: <b>${monthStr}</b></div><div class="no-print text-center" style="margin-bottom:20px;"><button onclick="window.print()" style="padding:10px;background:#2563eb;color:#fff;border:none;border-radius:4px;cursor:pointer;">🖨️ Распечатать</button></div><table><thead><tr><th>№</th><th>ФИО</th><th>Должность</th><th>Сумма аванса</th><th>Подпись</th></tr></thead><tbody>`;

    let grandTotal = 0; let counter = 1;
    ['Офис', 'Цех', 'Охрана'].forEach(dep => {
        const emps = currentPrintAdvancesData.filter(e => e.department === dep);
        if (emps.length === 0) return;
        html += `<tr><td colspan="5" class="dep-row">${dep.toUpperCase()}</td></tr>`;
        let depTotal = 0;
        emps.forEach(emp => {
            html += `<tr><td class="text-center">${counter++}</td><td><b>${emp.name}</b></td><td>${emp.position}</td><td class="text-right"><b>${Utils.formatMoney(emp.amount).replace(" ₽","")} ₽</b></td><td></td></tr>`;
            depTotal += emp.amount; grandTotal += emp.amount;
        });
        html += `<tr><td colspan="3" class="text-right">Итого по отделу:</td><td class="text-right"><b>${Utils.formatMoney(depTotal).replace(" ₽","")} ₽</b></td><td></td></tr>`;
    });
    html += `</tbody></table><h3 class="text-right">Общая сумма: <u>${Utils.formatMoney(grandTotal).replace(" ₽","")} ₽</u></h3><div style="margin-top:50px;display:flex;justify-content:space-between;"><div>Выдал: ____________</div><div>Утвердил: ____________</div></div></body></html>`;
    printWin.document.write(html); printWin.document.close();
};

// === 🕒 ДВИЖОК КЛИКОВ (СОХРАНЯЕМ ТВОЙ ПОЛИФИЛЛ И ТАЙМЕРЫ) ===
window.cellPressTimer = null;
window.isLongPress = false;
window.hasTouched = false;

window.startCellPress = function (e, el) {
    if (e.type.startsWith('touch')) window.hasTouched = true;
    if (e.type.startsWith('mouse') && window.hasTouched) return;
    if (e.type === 'mousedown' && e.button !== 0) return;

    window.isLongPress = false;
    if (window.cellPressTimer) clearTimeout(window.cellPressTimer);

    window.cellPressTimer = setTimeout(() => {
        window.isLongPress = true;
        if (navigator.vibrate) navigator.vibrate(50);

        openCellEditModal(
            el.getAttribute('data-emp-id'),
            el.getAttribute('data-emp-name'),
            el.getAttribute('data-date'),
            el.getAttribute('data-status'),
            el.getAttribute('data-bonus'),
            el.getAttribute('data-penalty'),
            el.getAttribute('data-cost'),
            el.getAttribute('data-multiplier'),
            el.getAttribute('data-b-comment'),
            el.getAttribute('data-p-comment')
        );
    }, 450);
};

window.cancelCellPress = function () {
    if (window.cellPressTimer) clearTimeout(window.cellPressTimer);
};

window.endCellPress = async function (e, el) {
    if (e.type.startsWith('mouse') && window.hasTouched) return;
    if (window.cellPressTimer) clearTimeout(window.cellPressTimer);

    if (!window.isLongPress) {
        const currentStatus = el.getAttribute('data-status');
        const empId = el.getAttribute('data-emp-id');
        const dateStr = el.getAttribute('data-date');

        const currentBonus = el.getAttribute('data-bonus') || 0;
        const currentPenalty = el.getAttribute('data-penalty') || 0;
        const currentBComment = el.getAttribute('data-b-comment') || '';
        const currentPComment = el.getAttribute('data-p-comment') || '';

        const newStatus = (currentStatus === 'present' || currentStatus === 'partial') ? 'weekend' : 'present';
        const newMultiplier = 1.0;

        // === 1. ОПТИМИСТИЧНЫЙ UI (МГНОВЕННАЯ РЕАКЦИЯ) ===
        // Визуально меняем ячейку прямо сейчас, не дожидаясь ответа сервера!
        el.setAttribute('data-status', newStatus);
        el.setAttribute('data-multiplier', newMultiplier);
        el.className = `ts-cell status-${newStatus}`;
        el.innerText = newStatus === 'partial' ? newMultiplier : el.innerText.trim();

        // Обновляем данные в локальной памяти, чтобы перерасчет сумм был верным
        let localRecord = currentMonthRecords.find(r => r.employee_id == empId && r.record_date.startsWith(dateStr));
        if (localRecord) {
            localRecord.status = newStatus;
            localRecord.multiplier = newMultiplier;
        } else {
            currentMonthRecords.push({ employee_id: parseInt(empId), record_date: dateStr, status: newStatus, multiplier: newMultiplier, bonus: currentBonus, penalty: currentPenalty });
        }

        // Мгновенно пересчитываем итоги справа (сделка, суммы), используя локальный кэш
        if (typeof reRenderTimesheet === 'function') reRenderTimesheet();

        // === 2. ФОНОВАЯ ОТПРАВКА НА СЕРВЕР ===
        try {
                    await API.post('/api/timesheet/cell', {
                    employee_id: empId,
                    date: dateStr,
                    status: newStatus,
                    multiplier: newMultiplier,
                    bonus: currentBonus,
                    penalty: currentPenalty,
                    bonus_comment: currentBComment,
                    penalty_comment: currentPComment
                });
        } catch (err) {
            console.error('Ошибка клика:', err);
            el.setAttribute('data-status', currentStatus);
            if (localRecord) localRecord.status = currentStatus;
            if (typeof reRenderTimesheet === 'function') reRenderTimesheet();
        }
    }
    window.isLongPress = false;
};

// === 📅 МОДАЛЬНОЕ ОКНО (С АВТОШТРАФОМ И СТАВКОЙ) ===
window.openCellEditModal = function (empId, empName, dateStr, currentStatus, currentBonus, currentPenalty, dailyCost, currentMultiplier, bonusComment, penaltyComment) {
    bonusComment = (bonusComment && bonusComment !== 'undefined') ? bonusComment : '';
    penaltyComment = (penaltyComment && penaltyComment !== 'undefined') ? penaltyComment : '';
    const costNum = parseFloat(dailyCost) || 0;

    const initialMultiplier = (parseFloat(currentMultiplier) === 0.25 || parseFloat(currentMultiplier) === 0.75) ? parseFloat(currentMultiplier) : 0.5;

    const html = `
        <p class="mt-0 mb-20">Отметка для <b>${Utils.escapeHtml(empName)}</b><br>
        <span class="text-muted font-13">Дата: ${dateStr} | <b>Ставка: ${Utils.formatMoney(costNum).replace(" ₽","")} ₽</b></span></p>
        
        <div class="form-group">
            <label>Статус:</label>
            <select id="cell-status-select" class="input-modern" onchange="toggleCellStatusDeps(${costNum})">
                <option value="present" ${currentStatus === 'present' ? 'selected' : ''}>🟢 Был на работе</option>
                <option value="partial" ${currentStatus === 'partial' ? 'selected' : ''}>🌗 Неполный день (Частичный выход)</option>
                <option value="weekend" ${currentStatus === 'weekend' ? 'selected' : ''}>⚪ Выходной</option>
                <option value="absent" ${currentStatus === 'absent' ? 'selected' : ''}>🔴 Прогул</option>
                <option value="sick" ${currentStatus === 'sick' ? 'selected' : ''}>🟡 Больничный</option>
                <option value="vacation" ${currentStatus === 'vacation' ? 'selected' : ''}>🔵 Отпуск</option>
            </select>
        </div>

        <div id="multiplier-select-container" class="multiplier-block" style="display: ${currentStatus === 'partial' ? 'flex' : 'none'}">
            <div class="multiplier-block-row">
                <label class="multiplier-block-label">Отработанная доля:</label>
                <label class="multiplier-radio-label">
                    <input type="radio" name="cell-multiplier" value="0.25" ${initialMultiplier === 0.25 ? 'checked' : ''} onchange="updateModalDayResult(${costNum})"> 25%
                </label>
                <label class="multiplier-radio-label">
                    <input type="radio" name="cell-multiplier" value="0.5" ${initialMultiplier === 0.5 ? 'checked' : ''} onchange="updateModalDayResult(${costNum})"> 50%
                </label>
                <label class="multiplier-radio-label">
                    <input type="radio" name="cell-multiplier" value="0.75" ${initialMultiplier === 0.75 ? 'checked' : ''} onchange="updateModalDayResult(${costNum})"> 75%
                </label>
            </div>
            <div class="modal-day-result-row">
                Итого за день: <span id="modal-day-result" class="modal-day-result-value">${Utils.formatMoney(costNum * initialMultiplier)}</span>
            </div>
        </div>

        <div id="penalty-check-container" class="penalty-check-block" style="display: ${currentStatus === 'absent' ? 'flex' : 'none'}">
            <input type="checkbox" id="cell-auto-penalty" onchange="applyAutoPenalty(this.checked, ${costNum})">
            <label for="cell-auto-penalty">Вычесть стоимость смены за прогул (-${costNum} ₽)?</label>
        </div>

        <div class="form-grid form-grid-2col mt-15 gap-15">
            <div class="bg-success-bg p-10 border-radius-6 border-success dashed">
                <label class="text-success font-bold">Премия (₽):</label>
                <input type="number" id="cell-bonus" class="input-modern" value="${parseFloat(currentBonus) || ''}" placeholder="0">
                <input type="text" id="cell-bonus-comment" class="input-modern mt-5 font-12" value="${Utils.escapeHtml(bonusComment)}" placeholder="За что...">
            </div>
            <div class="bg-danger-bg p-10 border-radius-6 border-danger dashed">
                <label class="text-danger font-bold">Штраф (₽):</label>
                <input type="number" id="cell-penalty" class="input-modern" value="${parseFloat(currentPenalty) || ''}" placeholder="0">
                <input type="text" id="cell-penalty-comment" class="input-modern mt-5 font-12" value="${Utils.escapeHtml(penaltyComment)}" placeholder="Причина...">
            </div>
        </div>
    `;
    const buttons = `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-blue" onclick="saveCellStatus(${empId}, '${dateStr}')">💾 Сохранить</button>
    `;
    UI.showModal('📅 Детальное редактирование', html, buttons);

    setTimeout(() => {
        const el = document.getElementById('cell-status-select');
        if (el && !el.tomselect) new TomSelect(el, { plugins: ['clear_button'], dropdownParent: 'body' });
    }, 50);
};

// === ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ (ДЛЯ АВТОШТРАФА И МНОЖИТЕЛЯ) ===
window.toggleCellStatusDeps = function (dailyCost) {
    const status = document.getElementById('cell-status-select').value;
    const penContainer = document.getElementById('penalty-check-container');
    const multContainer = document.getElementById('multiplier-select-container');

    if (penContainer) {
        penContainer.style.display = (status === 'absent') ? 'flex' : 'none';
        if (status !== 'absent') {
            const penCheck = document.getElementById('cell-auto-penalty');
            if (penCheck) penCheck.checked = false;
        }
    }

    if (multContainer) {
        multContainer.style.display = (status === 'partial') ? 'flex' : 'none';
        if (status === 'partial') {
            updateModalDayResult(dailyCost);
        }
    }
};

window.updateModalDayResult = function (dailyCost) {
    const checkedMulti = document.querySelector('input[name="cell-multiplier"]:checked');
    const resultEl = document.getElementById('modal-day-result');
    if (checkedMulti && resultEl) {
        const mult = parseFloat(checkedMulti.value);
        resultEl.innerText = Utils.formatMoney(dailyCost * mult);
    }
};

window.applyAutoPenalty = function (isChecked, dailyCost) {
    document.getElementById('cell-penalty').value = isChecked ? dailyCost : 0;
};

window.saveCellStatus = async function (empId, dateStr) {
    const bonus = parseFloat(document.getElementById('cell-bonus').value) || 0;
    const penalty = parseFloat(document.getElementById('cell-penalty').value) || 0;
    const newStatus = document.getElementById('cell-status-select').value;

    let newMultiplier = 1.0;
    if (newStatus === 'partial') {
        const checkedMulti = document.querySelector('input[name="cell-multiplier"]:checked');
        if (checkedMulti) newMultiplier = parseFloat(checkedMulti.value);
    }

    if (bonus < 0 || penalty < 0) {
        return UI.toast('Суммы не могут быть отрицательными!', 'warning');
    }

    const payload = {
        employee_id: empId,
        date: dateStr,
        status: newStatus,
        multiplier: newMultiplier,
        bonus,
        penalty,
        bonus_comment: document.getElementById('cell-bonus-comment').value.trim(),
        penalty_comment: document.getElementById('cell-penalty-comment').value.trim()
    };

    try {
        await API.post('/api/timesheet/cell', payload);
            UI.closeModal();

            // Мгновенное локальное обновление вместо долгого скачивания с сервера
            let localRecord = currentMonthRecords.find(r => r.employee_id == empId && r.record_date.startsWith(dateStr));
            if (localRecord) {
                localRecord.status = newStatus;
                localRecord.bonus = bonus;
                localRecord.penalty = penalty;
                localRecord.multiplier = newMultiplier;
                localRecord.bonus_comment = payload.bonus_comment;
                localRecord.penalty_comment = payload.penalty_comment;
            } else {
                currentMonthRecords.push({
                    employee_id: parseInt(empId),
                    record_date: dateStr,
                    status: newStatus,
                    bonus: bonus,
                    penalty: penalty,
                    multiplier: newMultiplier,
                    bonus_comment: payload.bonus_comment,
                    penalty_comment: payload.penalty_comment
                });
            }

            if (typeof reRenderTimesheet === 'function') reRenderTimesheet();
        
    } catch (e) { console.error(e); }
};

// === ГЛОБАЛЬНЫЙ ЭКСПОРТ ДЛЯ HTML ===
window.initSalary = initSalary;
window.toggleAccordion = toggleAccordion;
window.openEmployeeForm = openEmployeeForm;
window.loadMonthlyTimesheet = loadMonthlyTimesheet;
window.editEmployee = editEmployee;

// Функция-прослойка для поиска (так как в EJS вызван filterEmployees)
window.filterEmployees = function () {
    renderEmployeesTable();
};
// Функция локальной перерисовки табеля (для работы поиска и фильтров)
window.reRenderTimesheet = function () {
    const monthPicker = document.getElementById('ts-month-picker').value;
    if (!monthPicker) return;
    const [year, month] = monthPicker.split('-');
    // Вызываем отрисовку с уже загруженными данными (currentMonthRecords и т.д.)
    renderTimesheetMatrix(parseInt(year), parseInt(month));
};









    // === ГЛОБАЛЬНЫЙ ЭКСПОРТ ===
    if (typeof initSalary === 'function') window.initSalary = initSalary;
    if (typeof initStaticHRSelects === 'function') window.initStaticHRSelects = initStaticHRSelects;
    if (typeof toggleAccordion === 'function') window.toggleAccordion = toggleAccordion;
    if (typeof loadEmployees === 'function') window.loadEmployees = loadEmployees;
    if (typeof getLiveBalance === 'function') window.getLiveBalance = getLiveBalance;
    if (typeof renderEmployeesTable === 'function') window.renderEmployeesTable = renderEmployeesTable;
    if (typeof saveEmployee === 'function') window.saveEmployee = saveEmployee;
})();
