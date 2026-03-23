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
    document.getElementById('ts-month-picker').value = currentMonth;

    loadEmployees().then(() => {
        loadMonthlyTimesheet();
        // ПРАВИЛЬНЫЙ ПУТЬ: /api/accounts [как в finance.js]
        fetch('/api/accounts').then(res => res.json()).then(data => {
            window.currentAccounts = data;
        }).catch(e => console.error("Ошибка предзагрузки счетов:", e));
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
        const res = await fetch('/api/employees');
        currentEmployees = await res.json();
        renderEmployeesTable();
    } catch (e) { console.error(e); }
}

// Вспомогательная функция: берет живой баланс из рассчитанного табеля
function getLiveBalance(emp) {
    if (typeof currentMonthBalances !== 'undefined' && currentMonthBalances.length > 0) {
        const live = currentMonthBalances.find(b => b.empId === emp.id);
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
                            <td style="font-weight: 600;">${escapeHTML(emp.full_name)}</td>
                            <td style="color: var(--text-muted);">${escapeHTML(emp.position)}</td>
                            <td><span class="badge" style="background: var(--surface-hover); color: var(--text-main); font-size: 11px; border: 1px solid var(--border);">${emp.department}</span> <b>${emp.schedule_type}</b></td>
                            <td style="text-align: right; color: var(--success); font-weight: bold;">${parseFloat(emp.salary_cash).toLocaleString('ru-RU')} ₽</td>
                            <td style="text-align: right; color: var(--text-muted);">${parseFloat(emp.salary_official).toLocaleString('ru-RU')} ₽</td>
                            <td style="text-align: right; color: var(--danger);">-${parseFloat(emp.tax_withheld || 0).toLocaleString('ru-RU')} ₽</td>
                            <td style="text-align: right; color: ${balColor}; font-weight: bold;">${balSign}${balance.toLocaleString('ru-RU')} ₽</td>
                            <td style="text-align: center; vertical-align: middle;">
                                <button class="btn btn-outline" style="padding: 4px 8px; font-size: 12px; width: 100%; display: flex; justify-content: center;" onclick="editEmployee(${emp.id})" title="Редактировать">✏️</button>
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
                    <td style="font-weight: 600;">${escapeHTML(emp.full_name)}</td>
                    <td style="color: var(--text-muted);">${escapeHTML(emp.position)}</td>
                    <td><span class="badge" style="background: var(--surface-hover); color: var(--text-main); font-size: 11px; border: 1px solid var(--border);">${emp.department}</span> <b>${emp.schedule_type}</b></td>
                    <td style="text-align: right; color: var(--success); font-weight: bold;">${parseFloat(emp.salary_cash).toLocaleString('ru-RU')} ₽</td>
                    <td style="text-align: right; color: var(--text-muted);">${parseFloat(emp.salary_official).toLocaleString('ru-RU')} ₽</td>
                    <td style="text-align: right; color: var(--danger);">-${parseFloat(emp.tax_withheld || 0).toLocaleString('ru-RU')} ₽</td>
                    <td style="text-align: right; color: ${balColor}; font-weight: bold;">${balSign}${balance.toLocaleString('ru-RU')} ₽</td>
                    <td style="text-align: center; vertical-align: middle;">
                        <button class="btn btn-outline" style="padding: 4px 8px; font-size: 12px; width: 100%; display: flex; justify-content: center;" onclick="editEmployee(${emp.id})" title="Редактировать">✏️</button>
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
            <tr style="opacity: 0.8;">
                <td style="font-weight: 600;">${escapeHTML(emp.full_name)}</td>
                <td style="color: var(--text-muted);">${escapeHTML(emp.position)}</td>
                <td>${emp.department}</td>
                <td style="text-align: right; color: ${balColor}; font-weight: bold;">${balance.toLocaleString('ru-RU')} ₽</td>
                <td style="text-align: center; vertical-align: middle;">
                    <button class="btn btn-outline" style="padding: 4px 8px; font-size: 12px; color: var(--danger); border-color: var(--danger); width: 100%; display: flex; justify-content: center;" onclick="hardDeleteEmployee(${emp.id}, '${escapeHTML(emp.full_name)}')" title="Удалить навсегда">❌</button>
                </td>
            </tr>`;
    });

    if (activeHtml === '') activeHtml = '<tr><td colspan="8" class="text-center text-muted" style="padding: 20px;">Сотрудники не найдены</td></tr>';
    if (firedHtml === '') firedHtml = '<tr><td colspan="5" class="text-center text-muted" style="padding: 20px;">Архив пуст</td></tr>';

    if (tbodyActive) tbodyActive.innerHTML = activeHtml;
    if (tbodyFired) tbodyFired.innerHTML = firedHtml;
}

// Принудительное обновление данных перед редактированием
window.editEmployee = async function (id) {
    try {
        // Запрашиваем свежие данные с сервера
        const res = await fetch('/api/employees');
        currentEmployees = await res.json();

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
            <div style="margin-top: 10px; padding-top: 10px; border-top: 1px dashed var(--border); font-size: 13px;">
                Текущий расчетный остаток (с учетом табеля): 
                <b style="color: ${balColor}; font-size: 15px;">${balSign}${liveBalance.toLocaleString('ru-RU')} ₽</b>
            </div>
        `;
    }

    const html = `
        <div class="form-grid" style="grid-template-columns: 1fr 1fr;">
            <div class="form-group">
                <label>ФИО сотрудника:</label>
                <input type="text" id="emp-name" class="input-modern" value="${isEdit ? escapeHTML(emp.full_name) : ''}">
            </div>
            <div class="form-group">
                <label>Должность:</label>
                <input type="text" id="emp-pos" class="input-modern" value="${isEdit ? escapeHTML(emp.position) : ''}" placeholder="Например: Разнорабочий">
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
            
            <div class="form-group" style="background: var(--success-bg); padding: 10px; border-radius: 6px; border: 1px dashed var(--success); grid-column: span 2;">
                <label style="color: var(--success); font-weight: bold;">Базовая ставка / Оклад (Нал):</label>
                <input type="number" id="emp-sal-cash" class="input-modern" style="font-size: 16px; font-weight: bold;" value="${isEdit ? emp.salary_cash : '0'}">
            </div>

            <div class="form-group" style="background: var(--surface-alt); padding: 10px; border-radius: 6px; border: 1px dashed var(--text-muted); grid-column: span 2;">
                <label style="font-weight: bold;">Официальная ЗП (Безнал):</label>
                <input type="number" id="emp-sal-off" class="input-modern" value="${isEdit ? emp.salary_official : '20000'}" oninput="calcTaxWithheld()">
                
                <div style="display: flex; gap: 10px; margin-top: 10px;">
                    <div style="flex: 1;">
                        <label style="font-size: 11px;">Ставка налога (%):</label>
                        <input type="number" id="emp-tax-rate" class="input-modern" value="${isEdit ? emp.tax_rate : '13'}" oninput="calcTaxWithheld()">
                    </div>
                    <div style="flex: 1;">
                        <label style="font-size: 11px; color: var(--danger);">Фактическое удержание из Нал. (₽):</label>
                        <input type="number" id="emp-tax-withheld" class="input-modern" style="color: var(--danger); font-weight: bold;" value="${isEdit ? emp.tax_withheld : '2600'}">
                    </div>
                </div>
            </div>

            <div class="form-group" style="background: var(--danger-bg); padding: 10px; border-radius: 6px; border: 1px dashed var(--danger); grid-column: span 2;">
                <label style="color: var(--danger); font-weight: bold;">Статус в компании:</label>
                <select id="emp-status" class="input-modern" style="font-weight: bold;">
                    <option value="active" ${isEdit && emp.status === 'active' ? 'selected' : ''}>🟢 Работает</option>
                    <option value="fired" ${isEdit && emp.status === 'fired' ? 'selected' : ''}>🔴 УВОЛЕН (В архив)</option>
                </select>
            </div>

            <div class="form-group" style="background: var(--surface-hover); padding: 10px; border-radius: 6px; border: 1px dashed var(--primary); grid-column: span 2;">
                <label style="color: var(--primary); font-weight: bold;">± Остаток на НАЧАЛО месяца (Исторический долг):</label>
                <input type="number" id="emp-prev-balance" class="input-modern" style="font-size: 15px; font-weight: bold;" value="${isEdit ? (emp.prev_balance || 0) : '0'}">
                <div style="font-size: 11px; color: var(--text-muted); margin-top: 4px;">Внимание: редактируйте поле выше ТОЛЬКО для исправления старых долгов.</div>
                ${liveBalanceHtml}
            </div>
        </div>
    `;

    const buttons = `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-blue" onclick="saveEmployee(${isEdit ? emp.id : 'null'})">💾 Сохранить</button>
    `;
    UI.showModal(isEdit ? '✏️ Редактирование сотрудника' : '➕ Новый сотрудник', html, buttons);
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
        const res = await fetch(id ? `/api/employees/${id}` : '/api/employees', {
            method: id ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (res.ok) {
            UI.toast('Успешно сохранено!', 'success');
            UI.closeModal();
            loadEmployees();
            loadMonthlyTimesheet();
        }
    } catch (e) { console.error(e); }
}

// ==========================================
// БЕЗОПАСНОЕ "УДАЛЕНИЕ" (Soft Delete)
// Комментарий: Физически удалять людей нельзя из-за финансовой истории.
// Мы переводим их в архив (статус fired).
// ==========================================
window.hardDeleteEmployee = function (id, name) {
    const html = `
        <div style="padding: 15px; text-align: center; font-size: 15px;">
            Вы уверены, что хотите <b>НАВСЕГДА</b> удалить карточку <br><b style="color: var(--danger); font-size: 18px;">${escapeHTML(name)}</b>?<br><br>
            <small style="color: var(--text-muted);">Удаляйте только в том случае, если сотрудник был добавлен по ошибке и по нему еще нет табелей. Иначе старые расчеты могут сломаться.</small>
        </div>`;

    UI.showModal('⚠️ Полное удаление из базы', html, `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-blue" style="background: var(--danger); border-color: var(--danger);" onclick="executeHardDelete(${id})">🗑️ Да, удалить навсегда</button>
    `);
};

window.executeHardDelete = async function (id) {
    UI.toast('⏳ Удаление...', 'info');
    try {
        const res = await fetch(`/api/employees/${id}`, { method: 'DELETE' });
        if (res.ok) {
            UI.closeModal();
            UI.toast('✅ Сотрудник полностью удален из базы', 'success');
            loadEmployees(); // Обновляем таблицы
        } else {
            const err = await res.json();
            UI.toast(err.error || 'Ошибка при удалении (возможно есть привязанные табели)', 'error');
        }
    } catch (e) {
        console.error(e);
        UI.toast('Ошибка сети', 'error');
    }
};

// === ЗАГРУЗКА МЕСЯЧНЫХ ДАННЫХ (УСКОРЕННАЯ) ===
async function loadMonthlyTimesheet() {
    const monthPicker = document.getElementById('ts-month-picker').value;
    if (!monthPicker) return;
    const [year, month] = monthPicker.split('-');

    try {
        // Запускаем все 5 запросов к серверу ОДНОВРЕМЕННО
        const [resClosed, resTs, resPay, resStats, resAdj] = await Promise.all([
            fetch(`/api/salary/is-closed?monthStr=${year}-${month}`),
            fetch(`/api/timesheet/month?year=${year}&month=${month}`),
            fetch(`/api/salary/payments?year=${year}&month=${month}`),
            fetch(`/api/salary/stats?year=${year}&month=${month}`),
            fetch(`/api/salary/adjustments?monthStr=${year}-${month}`)
        ]);

        // Ждем конвертации JSON тоже параллельно
        const [closedData, tsData, payData, statsData, adjData] = await Promise.all([
            resClosed.json(), resTs.json(), resPay.json(), resStats.json(), resAdj.json()
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
    let headHtml = `<tr><th style="position: sticky; left: 0; background: var(--surface-alt); z-index: 20; border-right: 2px solid var(--border); min-width: 250px;">Сотрудник</th>`;
    for (let day = 1; day <= daysInMonth; day++) {
        const dow = new Date(year, month - 1, day).getDay();
        const isWeekend = dow === 0 || dow === 6;
        const isToday = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` === todayStr;

        let thStyle = `text-align: center; padding: 10px 4px; min-width: 35px; border-bottom: 2px solid var(--border); `;
        if (isWeekend) thStyle += `background: var(--surface-hover); color: var(--danger); `;
        if (isToday) thStyle += `background: var(--surface-hover); color: var(--primary); font-weight: 800; border-bottom: 2px solid var(--primary);`;

        headHtml += `<th style="${thStyle}">${day}</th>`;
    }
    headHtml += `<th style="text-align: right; background: var(--surface-alt); border-left: 2px solid var(--border);">Итого (Дни / ₽)</th></tr>`;

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
            return currentMonthRecords.some(r => r.employee_id === e.id && ['present', 'sick', 'vacation'].includes(r.status));
        });

        if (depEmps.length === 0) return;

        bodyHtml += `<tr><td colspan="${daysInMonth + 2}" style="background: var(--surface-hover); font-weight: bold; padding: 8px 15px; color: var(--text-main);">Отдел: ${dep.toUpperCase()}</td></tr>`;

        depEmps.forEach(emp => {
            const empStat = currentMonthStats.find(s => s.employee_id === emp.id) || emp;
            const baseSalary = parseFloat(empStat.salary_cash) || 0;
            const dailyCost = emp.schedule_type === '5/2' ? Math.round(baseSalary / normDays52) : Math.round(baseSalary / normShifts13);

            // Убрали onmouseover и жесткий белый фон
            bodyHtml += `<tr>
                <td style="position: sticky; left: 0; background: var(--surface); z-index: 10; border-right: 2px solid var(--border); padding: 8px 15px;">
                    <div style="font-weight: 600;">${emp.full_name} ${emp.status === 'fired' ? '<span class="badge" style="background: var(--danger); color: white; padding: 2px 6px; font-size: 10px;">Уволен</span>' : ''}</div>
                    <div style="font-size: 11px; color: var(--text-muted);">${emp.position} | Оклад: ${baseSalary.toLocaleString()} ₽ | График: <b>${emp.schedule_type}</b></div>
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

                if (record) {
                    status = record.status;
                    cellBonus = parseFloat(record.bonus) || 0;
                    cellPenalty = parseFloat(record.penalty) || 0;
                    cellBonusComment = record.bonus_comment || '';
                    cellPenaltyComment = record.penalty_comment || '';

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
                } else if (status === 'sick') sick++;
                else if (status === 'vacation') vacation++;
                else if (status === 'absent') absent++;

                totalBonus += cellBonus;
                totalPenalty += cellPenalty;

                let tdStyle = `padding: 4px; border-bottom: 1px solid var(--border); `;
                if (isWeekend) tdStyle += `background: var(--surface-alt); `;
                if (isToday) tdStyle += `border-left: 2px solid var(--primary); border-right: 2px solid var(--primary); background: var(--surface-hover); `;

                let extraIcons = '';
                if (cellBonus > 0) extraIcons += '<div style="position:absolute; top:-2px; right:-2px; width:6px; height:6px; background:var(--success); border-radius:50%; box-shadow: 0 0 2px rgba(0,0,0,0.3);"></div>';
                if (cellPenalty > 0) extraIcons += '<div style="position:absolute; bottom:-2px; right:-2px; width:6px; height:6px; background:var(--danger); border-radius:50%; box-shadow: 0 0 2px rgba(0,0,0,0.3);"></div>';

                // 🌟 БЕЗОПАСНЫЙ ДВИЖОК СОБЫТИЙ С ЧТЕНИЕМ ЧЕРЕЗ DATA-*
                const isFired = emp.status === 'fired';
                const actionEvents = isFired
                    ? `onclick="UI.toast('Сотрудник уволен. Редактирование дней запрещено.', 'warning')"`
                    : `data-emp-id="${emp.id}"
                       data-emp-name="${escapeHTML(emp.full_name)}"
                       data-date="${dateStr}"
                       data-status="${status}"
                       data-bonus="${cellBonus}"
                       data-penalty="${cellPenalty}"
                       data-cost="${dailyCost}"
                       data-b-comment="${escapeHTML(cellBonusComment)}"
                       data-p-comment="${escapeHTML(cellPenaltyComment)}"
                       onmousedown="startCellPress(event, this)" 
                       onmouseup="endCellPress(event, this)" 
                       onmouseleave="cancelCellPress()"
                       ontouchstart="startCellPress(event, this)"
                       ontouchend="endCellPress(event, this)"
                       ontouchcancel="cancelCellPress()"`;

                bodyHtml += `
                    <td style="${tdStyle}">
                        <div style="position: relative; width: max-content; margin: 0 auto; ${isFired && status === 'weekend' ? 'opacity: 0.4;' : ''}">
                            <div class="ts-cell status-${status}" 
                                title="${emp.full_name} | ${dateStr}\nОклад (Факт): ${cellBaseRate}₽/д${ktuText}\nПремия: ${cellBonus}₽ | Штраф: ${cellPenalty}₽"
                                ${actionEvents}
                                style="${isFired ? 'cursor: not-allowed;' : 'cursor: pointer; user-select: none; -webkit-user-select: none; touch-action: manipulation;'}">
                                ${day}
                            </div>
                            ${extraIcons}
                        </div>
                    </td>
                `;
            }

            const totalEarned = earnedBase + totalBonus - totalPenalty;

            let summaryHtml = `<td style="text-align: right; padding: 8px 12px; background: var(--surface-alt); border-left: 2px solid var(--border);">`;
            const normText = emp.schedule_type === '5/2' ? `${worked} / ${normDays52} дн` : `${worked} / ${Math.round(normShifts13)} см`;
            const isNormMet = emp.schedule_type === '5/2' ? worked >= normDays52 : worked >= normShifts13;

            summaryHtml += `<div style="font-size: 12px; font-weight: 600; color: ${isNormMet ? 'var(--success)' : 'var(--text-main)'};">${normText}</div>`;
            summaryHtml += `<div style="color: var(--primary); font-weight: bold; font-size: 15px; margin-top: 4px;">${totalEarned.toLocaleString('ru-RU')} ₽</div>`;

            let moneyStats = [];
            if (totalBonus > 0) moneyStats.push(`<span style="color: var(--success);">+${totalBonus.toLocaleString()}₽</span>`);
            if (totalPenalty > 0) moneyStats.push(`<span style="color: var(--danger);">-${totalPenalty.toLocaleString()}₽</span>`);
            if (moneyStats.length > 0) summaryHtml += `<div style="font-size: 11px; margin-top: 4px; display: flex; gap: 6px; justify-content: flex-end; font-weight: bold;">${moneyStats.join(' ')}</div>`;

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
        sumTotal[emp.department] += availableToPay;
        sumTotal['Всего'] += availableToPay;
        currentMonthBalances.push({ empId: emp.id, balance: availableToPay });

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
            let advancesHtml = `<span style="color: var(--text-muted);">0 ₽</span>`;
            if (advances > 0) advancesHtml = `<span style="color: var(--primary); text-decoration: underline; cursor: pointer; font-weight: bold;" onclick="openAdvancesDetails(${emp.id}, '${escapeHTML(emp.full_name)}')">-${advances.toLocaleString()} ₽</span>`;

            let adjHtml = `<span style="color: var(--text-muted);">0 ₽</span>`;
            if (adjSum !== 0) adjHtml = `<span style="color: ${adjSum > 0 ? 'var(--success)' : 'var(--danger)'}; font-weight: bold;">${adjSum > 0 ? '+' : ''}${adjSum.toLocaleString()} ₽</span>`;

            payoutsHtml += `
                <tr>
                    <td><strong style="font-size: 14px;">${escapeHTML(emp.full_name)}</strong><br><span style="font-size: 11px; color: ${emp.status === 'fired' ? 'var(--danger)' : 'var(--text-muted)'};">${emp.status === 'fired' ? 'УВОЛЕН' : escapeHTML(emp.position)}</span></td>
                    <td class="text-right" style="font-weight: bold; font-size: 15px;">${earnedToday.toLocaleString()} ₽</td>
                    <td class="text-right" style="color: ${prevBalance >= 0 ? 'var(--primary)' : 'var(--danger)'}; font-weight: bold;">${prevBalance > 0 ? '+' : ''}${prevBalance.toLocaleString()} ₽</td>
                    <td class="text-right text-danger">-${finalTax.toLocaleString()} ₽</td>
                    <td class="text-right">${advancesHtml}</td>
                    <td class="text-right" style="cursor: pointer; background: var(--warning-bg);" onclick="openAdjustmentsModal(${emp.id}, '${escapeHTML(emp.full_name)}', '${year}-${String(month).padStart(2, '0')}')">${adjHtml}</td>
                    <td class="text-right" style="background: ${availableToPay >= 0 ? 'var(--success-bg)' : 'var(--danger-bg)'}; color: ${availableToPay >= 0 ? 'var(--success-text)' : 'var(--danger-text)'}; font-size: 16px; font-weight: bold;">${availableToPay.toLocaleString()} ₽</td>
                    <td class="text-center">
                        <div style="display: flex; gap: 5px; justify-content: center;">
                            <button class="btn btn-outline" style="padding: 4px; font-size: 12px; border-color: var(--warning-text); color: var(--warning-text);" onclick="openAdjustmentsModal(${emp.id}, '${escapeHTML(emp.full_name)}', '${year}-${String(month).padStart(2, '0')}')" title="Доп. операция">⚙️</button>
                            <button class="btn btn-blue" style="padding: 6px 12px; font-size: 12px;" onclick="openPayoutModal(${emp.id}, '${escapeHTML(emp.full_name)}', ${availableToPay})">💳</button>
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

    // === ЧИСТАЯ ГЕНЕРАЦИЯ ПОДВАЛА ТАБЛИЦЫ ===
    payoutsHtml += `
        <tr>
            <td colspan="8" class="payouts-footer">
                <span class="tax-control-group">
                    Управленческие Налоги (13%): 
                    <input type="number" id="final-month-taxes" class="input-modern" style="width: 120px; text-align: right;" value="${displayTaxes}" ${isClosed ? 'disabled' : ''}> ₽
                </span>
                
                ${isClosed
            ? `<span class="badge-closed">🔒 Месяц закрыт</span>`
            : `<button class="btn btn-blue" style="background: var(--danger); border-color: var(--danger); padding: 10px 20px;" onclick="closeSalaryMonth()">🔒 Закрыть месяц</button>`
        }
            </td>
        </tr>
    `;

    // === ЧИСТАЯ ОТРИСОВКА КАРТОЧК ИТОГОВ ===
    const summaryBoxes = document.getElementById('salary-summary-boxes');
    if (summaryBoxes) {
        summaryBoxes.innerHTML = `
            <div class="summary-card office">
                <div class="summary-title">ОФИС (К выдаче)</div>
                <div class="summary-value">${sumTotal['Офис'].toLocaleString()} ₽</div>
            </div>
            <div class="summary-card shop">
                <div class="summary-title">ЦЕХ (К выдаче)</div>
                <div class="summary-value">${sumTotal['Цех'].toLocaleString()} ₽</div>
            </div>
            <div class="summary-card security">
                <div class="summary-title">ОХРАНА (К выдаче)</div>
                <div class="summary-value">${sumTotal['Охрана'].toLocaleString()} ₽</div>
            </div>
            <div class="summary-card total">
                <div class="summary-title">ОБЩИЙ ФОТ (К выдаче)</div>
                <div class="summary-value">${sumTotal['Всего'].toLocaleString()} ₽</div>
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
                <thead style="background: var(--surface-alt);"><tr><th>Дата выдачи</th><th style="text-align: right;">Сумма</th><th>Комментарий (Основание)</th></tr></thead>
                <tbody>
                    ${empPayments.map(p => `
                        <tr>
                            <td style="font-weight: 600;">${p.payment_date}</td>
                            <td style="text-align: right; font-weight: bold; color: var(--danger);">${parseFloat(p.amount).toLocaleString()} ₽</td>
                            <td style="color: var(--text-muted); font-size: 13px;">${p.description}</td>
                            <td style="text-align: center;"><button class="btn btn-outline" style="padding:2px 6px; color:var(--danger); border-color:var(--danger);" onclick="deleteSalaryPayment(${p.id})">🗑️</button></td>
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
        const res = await fetch('/api/accounts');
        if (res.ok) window.currentAccounts = await res.json();
    }

    // Автовыбор кассы по названию
    const options = (window.currentAccounts || []).map(acc => {
        const isDefault = acc.name.toLowerCase().includes('касса') || acc.name.toLowerCase().includes('наличные');
        return `<option value="${acc.id}" ${isDefault ? 'selected' : ''}>${escapeHTML(acc.name)} (${parseFloat(acc.balance).toLocaleString()} ₽)</option>`;
    }).join('');

    const html = `
        <div style="background: var(--success-bg); padding: 25px; border-radius: 12px; border: 1px solid var(--success-border); margin-bottom: 20px; text-align: center; box-shadow: inset 0 2px 4px rgba(0,0,0,0.02);">
            <div style="font-size: 13px; color: var(--success-text); text-transform: uppercase; font-weight: 800; letter-spacing: 1px;">Доступно к выдаче</div>
            <div style="font-size: 36px; font-weight: 900; color: var(--success); margin: 10px 0; ">${availableAmount.toLocaleString()} ₽</div>
            <div style="font-size: 14px; color: var(--text-main);">Сотрудник: <b style="color: var(--text-main);">${escapeHTML(empName)}</b></div>
        </div>

        <div class="form-group" style="margin-bottom: 15px;">
            <label style="font-weight: bold;">Сумма выплаты (₽):</label>
            <input type="number" id="payout-amount" class="input-modern" style="font-size: 20px; font-weight: bold; color: var(--primary);" value="${availableAmount > 0 ? availableAmount : ''}" onfocus="this.select()">
        </div>
        
        <div class="form-group" style="margin-bottom: 15px;">
            <label>Списать со счета:</label>
            <select id="payout-account-id" class="input-modern" style="font-weight: bold;">
                ${options || '<option disabled>Счета не найдены</option>'}
            </select>
        </div>

        <div class="form-grid" style="grid-template-columns: 1fr 1fr; gap: 15px;">
            <div class="form-group"><label>Дата:</label><input type="date" id="payout-date" class="input-modern" value="${today}"></div>
            <div class="form-group"><label>Комментарий:</label><input type="text" id="payout-desc" class="input-modern" value="Зарплата"></div>
        </div>
    `;

    UI.showModal('💳 Оформление выплаты', html, `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-blue" onclick="executePayout(${empId}, '${escapeHTML(empName)}')">💸 Подтвердить выдачу</button>
    `);
};

window.executePayout = async function (empId, empName) {
    const amount = parseFloat(document.getElementById('payout-amount').value);
    const account_id = document.getElementById('payout-account-id').value;
    const date = document.getElementById('payout-date').value;
    const desc = document.getElementById('payout-desc').value;

    if (!amount || amount <= 0) return UI.toast('Введите сумму!', 'error');
    if (!account_id) return UI.toast('Выберите счет!', 'error');

    try {
        // Роут из твоего hr.js: /api/salary/pay
        const res = await fetch('/api/salary/pay', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                employee_id: empId,
                amount,
                date,
                description: `${empName}: ${desc}`,
                account_id
            })
        });

        if (res.ok) {
            UI.closeModal();
            UI.toast('✅ Выплата проведена!', 'success');
            loadMonthlyTimesheet(); // Обновляем табель и суммы
            if (typeof loadFinanceData === 'function') loadFinanceData(); // Обновляем баланс в кассе
        } else {
            const err = await res.json();
            UI.toast(err.error || 'Ошибка сервера', 'error');
        }
    } catch (e) {
        console.error(e);
        UI.toast('Ошибка сети', 'error');
    }
};

// ==========================================
// 1. ОПЛАТА ОФИЦИАЛЬНЫХ НАЛОГОВ
// ==========================================

// ПОДГОТОВКА (Показ окна)
window.payOfficialTaxes = function (monthStr, amount) {
    const html = `
        <div style="padding: 10px; font-size: 15px; text-align: center;">
            <div style="font-size: 40px; margin-bottom: 10px;">🏦</div>
            Списать <b style="color: var(--primary); font-size: 18px;">${amount.toLocaleString()} ₽</b><br>
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
        const res = await fetch('/api/salary/pay-taxes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ monthStr, amount })
        });

        if (res.ok) {
            UI.toast('✅ Налоги успешно оплачены (Безнал)!', 'success');
            // Если нужно, тут можно добавить обновление интерфейса, например: loadTable()
        } else {
            UI.toast('Ошибка при оплате налогов', 'error');
        }
    } catch (e) {
        console.error(e);
        UI.toast('Критическая ошибка связи с сервером', 'error');
    }
};


// ==========================================
// 2. ЗАКРЫТИЕ ЗАРПЛАТНОГО МЕСЯЦА
// ==========================================

// ПОДГОТОВКА (Показ окна)
window.closeSalaryMonth = function () {
    const monthStr = document.getElementById('ts-month-picker').value;
    const totalTaxes = parseFloat(document.getElementById('final-month-taxes').value) || 0;

    const html = `
        <div style="padding: 10px; font-size: 15px;">
            <div style="text-align: center; font-size: 40px; margin-bottom: 10px;">🔒</div>
            <div style="text-align: center; margin-bottom: 15px;">
                Вы уверены, что хотите закрыть <b style="color: var(--primary);">${monthStr}</b>?
            </div>
            <ul style="color: var(--text-muted); font-size: 14px; line-height: 1.5; background: var(--surface-alt); padding: 10px 10px 10px 30px; border-radius: 6px;">
                <li>Заработанные суммы будут перенесены в архив.</li>
                <li>Налог (<b style="color: var(--text-main);">${totalTaxes.toLocaleString()} ₽</b>) будет зафиксирован.</li>
                <li>Текущие балансы "К ВЫДАЧЕ" станут начальным долгом/переплатой на следующий месяц.</li>
            </ul>
        </div>
    `;

    const buttons = `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-blue" style="background: var(--danger); border-color: var(--danger);" 
                onclick="executeCloseSalaryMonth('${monthStr}', ${totalTaxes})">🔒 Да, закрыть месяц</button>
    `;

    UI.showModal('Закрытие месяца', html, buttons);
};

// ВЫПОЛНЕНИЕ
window.executeCloseSalaryMonth = async function (monthStr, totalTaxes) {
    UI.closeModal();
    UI.toast(`⏳ Закрытие периода ${monthStr}...`, 'info');

    try {
        const res = await fetch('/api/salary/close-month', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ monthStr, balances: currentMonthBalances, totalTaxes })
        });

        if (res.ok) {
            UI.toast('✅ Месяц успешно закрыт! Балансы зафиксированы.', 'success');
            setTimeout(() => location.reload(), 1500);
        } else {
            const err = await res.json();
            UI.toast(err.error || 'Ошибка при закрытии месяца', 'error');
        }
    } catch (e) {
        console.error(e);
        UI.toast('Критическая ошибка связи с сервером', 'error');
    }
};

// === ДОП ОПЕРАЦИИ (ГСМ, ЗАЙМЫ) ===
window.openAdjustmentsModal = function (empId, empName, monthStr) {
    const adjs = currentMonthAdjustments.filter(a => a.employee_id === empId);
    let listHtml = adjs.length === 0 ? '<p style="color: var(--text-muted); font-size: 13px;">В этом месяце операций не было.</p>' : '';
    if (adjs.length > 0) {
        listHtml = `<table style="width:100%; font-size:13px; margin-bottom:15px;">
            ${adjs.map(a => `
                <tr style="border-bottom: 1px solid var(--border);">
                    <td style="padding: 5px 0;">${a.description}</td>
                    <td style="text-align:right; font-weight:bold; color: ${parseFloat(a.amount) > 0 ? 'var(--success)' : 'var(--danger)'};">${parseFloat(a.amount) > 0 ? '+' : ''}${parseFloat(a.amount).toLocaleString()} ₽</td>
                    <td style="text-align:right;"><button class="btn btn-outline" style="padding:2px 6px; color:var(--danger);" onclick="deleteAdjustment(${a.id})">❌</button></td>
                </tr>
            `).join('')}
        </table>`;
    }
    const html = `
        <div style="background: var(--surface-alt); padding: 15px; border-radius: 8px; margin-bottom: 15px;"><h4 style="margin: 0 0 10px 0;">История операций (${monthStr})</h4>${listHtml}</div>
        <div style="border: 1px dashed var(--warning); padding: 15px; border-radius: 8px; background: var(--warning-bg);">
            <h4 style="margin: 0 0 10px 0; color: var(--warning-text);">➕ Добавить операцию</h4>
            <div class="form-group" style="margin-bottom: 10px;">
                <label>Сумма (₽):</label><input type="number" id="adj-amount" class="input-modern" placeholder="Например: -5000 или 2000">
                <span style="font-size: 11px; color: var(--text-muted);">Используйте <b>минус</b> для удержания (ГСМ, Займ) и <b>плюс</b> для начисления.</span>
            </div>
            <div class="form-group"><label>Основание:</label><input type="text" id="adj-desc" class="input-modern" placeholder="Топливная карта №123"></div>
            <button class="btn btn-blue" style="width:100%; margin-top:15px;" onclick="saveAdjustment(${empId}, '${monthStr}')">Сохранить операцию</button>
        </div>
    `;
    UI.showModal(`⚙️ Разовые операции: ${empName}`, html, '<button class="btn btn-outline" onclick="UI.closeModal()">Закрыть</button>');
}
window.saveAdjustment = async function (empId, monthStr) {
    const amount = parseFloat(document.getElementById('adj-amount').value);
    const desc = document.getElementById('adj-desc').value.trim();
    if (!amount || !desc) return UI.toast('Заполните сумму и комментарий!', 'error');
    try {
        if ((await fetch('/api/salary/adjustments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ employee_id: empId, month_str: monthStr, amount, description: desc }) })).ok) {
            UI.closeModal(); UI.toast('Операция сохранена', 'success'); loadMonthlyTimesheet();
        }
    } catch (e) { }
};
window.deleteAdjustment = async function (id) {
    try { await fetch(`/api/salary/adjustments/${id}`, { method: 'DELETE' }); UI.closeModal(); loadMonthlyTimesheet(); } catch (e) { }
};
window.deleteSalaryPayment = function (paymentId) {
    UI.showModal('⚠️ Подтверждение удаления', '<div style="text-align: center;"><p style="font-size: 16px; margin-bottom: 10px;">Аннулировать эту выплату?</p></div>', `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-outline" style="color: var(--danger); border-color: var(--danger);" onclick="executeDeleteSalaryPayment(${paymentId})">🗑️ Да, удалить</button>
    `);
};
window.executeDeleteSalaryPayment = async function (paymentId) {
    try {
        if ((await fetch(`/api/salary/payment/${paymentId}`, { method: 'DELETE' })).ok) {
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

    document.getElementById('piece-rate-content').innerHTML = '<p style="text-align: center; color: var(--text-muted);">Загрузка данных...</p>';
    try {
        const resStats = await fetch(`/api/production/daily-stats?date=${date}`);
        const stats = await resStats.json();
        const totalProduced = parseFloat(stats.total) || 0;
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
                    <tr style="border-bottom: 1px solid var(--border); background: var(--surface);">
                        <td style="padding: 8px;"><label style="display: flex; align-items: center; gap: 8px; cursor: pointer;"><input type="checkbox" class="piece-emp-checkbox" value="${emp.id}" checked onchange="recalcPieceRate()"><span style="font-size: 13px;"><b>${emp.full_name}</b><br><span style="color: var(--text-muted); font-size: 11px;">${emp.position}</span></span></label></td>
                        <td style="padding: 8px; text-align: center;"><input type="number" id="ktu-${emp.id}" class="input-modern" value="${currentKtu}" step="0.1" min="0" style="width: 60px; text-align: center; font-weight: bold;" oninput="recalcPieceRate()"></td>
                        <td style="padding: 8px;"><div style="display: flex; align-items: center; gap: 4px;"><input type="number" id="rate-${emp.id}" class="input-modern" value="${currentRate}" style="width: 75px; text-align: right;" oninput="recalcPieceRate()"><div style="display: flex; flex-direction: column; gap: 2px;"><button class="btn btn-outline" style="padding: 1px 4px; font-size: 10px;" onclick="setRate(${emp.id}, ${dailyCost})">100%</button><button class="btn btn-outline" style="padding: 1px 4px; font-size: 10px;" onclick="setRate(${emp.id}, ${Math.round(dailyCost / 2)})">50%</button><button class="btn btn-outline" style="padding: 1px 4px; font-size: 10px; color: var(--danger); border-color: var(--danger);" onclick="setRate(${emp.id}, 0)">0</button></div></div></td>
                        <td id="bonus-${emp.id}" style="padding: 8px; text-align: right; color: var(--success); font-weight: bold; font-size: 14px;">0 ₽</td>
                        <td id="total-${emp.id}" style="padding: 8px; text-align: right; font-weight: bold; font-size: 15px;">0 ₽</td>
                    </tr>`;
            }
        });
        if (activeCount === 0) empsHtml = '<tr><td colspan="5" style="padding: 15px; text-align: center; color: var(--danger);">В этот день нет работающих сотрудников цеха.</td></tr>';

        document.getElementById('piece-rate-content').innerHTML = `
            <div style="background: var(--bg-main); border: 1px solid var(--border); padding: 15px; border-radius: 8px; margin-bottom: 15px;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <div><div style="font-size: 13px; color: var(--text-muted);">Выпущено продукции (План):</div><input type="number" id="piece-total-produced" class="input-modern" value="${totalProduced}" style="font-size: 18px; font-weight: bold; width: 120px; background: var(--surface-alt); cursor: not-allowed;" readonly></div>
                    <div><div style="font-size: 12px;">Расценка за 1 ед (₽):</div><input type="number" id="piece-rate-price" class="input-modern" value="" placeholder="Введите..." style="font-size: 18px; font-weight: bold; color: var(--success); width: 120px;" oninput="recalcPieceRate()" onfocus="this.select()" autocomplete="off"></div>
                    <div style="text-align: right;"><div style="font-size: 12px; color: var(--primary);">Сдельный фонд:</div><b id="piece-fund" style="color: var(--primary); font-size: 20px;">0 ₽</b></div>
                </div>
            </div>
            <h4 style="margin-bottom: 10px;">Бригада на смене (Распределение КТУ):</h4>
            <div style="max-height: 250px; overflow-y: auto; border: 1px solid var(--border); border-radius: 8px;">
                <table style="width: 100%; font-size: 13px; border-collapse: collapse;">
                    <thead style="background: var(--surface-alt); position: sticky; top: 0; z-index: 10;"><tr><th style="padding: 8px; text-align: left;">Сотрудник</th><th style="padding: 8px; text-align: center;">КТУ</th><th style="padding: 8px; text-align: left;">Оклад (Смена)</th><th style="padding: 8px; text-align: right;">Сделка</th><th style="padding: 8px; text-align: right;">Итого день</th></tr></thead>
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
    const price = parseFloat(document.getElementById('piece-rate-price').value) || 0;
    const totalProduced = parseFloat(document.getElementById('piece-total-produced').value) || 0;
    const fund = totalProduced * price;
    const checkboxes = document.querySelectorAll('.piece-emp-checkbox:checked');
    let totalKtu = 0;
    checkboxes.forEach(cb => { totalKtu += parseFloat(document.getElementById(`ktu-${cb.value}`).value) || 0; });
    const fundPerKtu = totalKtu > 0 ? (fund / totalKtu) : 0;

    checkboxes.forEach(cb => {
        const id = cb.value;
        const ktu = parseFloat(document.getElementById(`ktu-${id}`).value) || 0;
        const rate = parseFloat(document.getElementById(`rate-${id}`).value) || 0;
        const bonus = ktu * fundPerKtu;
        document.getElementById(`bonus-${id}`).innerText = '+' + Math.round(bonus).toLocaleString() + ' ₽';
        document.getElementById(`total-${id}`).innerText = Math.round(rate + bonus).toLocaleString() + ' ₽';
    });
    document.getElementById('piece-fund').innerText = Math.round(fund).toLocaleString() + ' ₽';
    document.getElementById('piece-save-btn').disabled = (checkboxes.length === 0);
};

window.savePieceRate = async function (date) {
    const checkboxes = document.querySelectorAll('.piece-emp-checkbox:checked');
    const pieceRate = parseFloat(document.getElementById('piece-rate-price').value) || 0;
    
    if (pieceRate < 0 || pieceRate > 10000) return UI.toast('Указана неверная расценка (лимит от 0 до 10000 ₽)', 'error');
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

    UI.toast('⏳ Расчет премиального фонда на сервере...', 'info');

    try {
        const res = await fetch('/api/timesheet/mass-bonus', { 
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify({ date, pieceRate, workersData }) 
        });

        if (res.ok) {
            UI.closeModal(); 
            UI.toast('Сдельная премия безопасно зафиксирована и подсчитана!', 'success'); 
            loadMonthlyTimesheet();
        } else {
            const err = await res.json();
            UI.toast(err.error || 'Ошибка при расчете сделки', 'error');
        }
    } catch (e) { 
        console.error(e); 
        UI.toast('Критическая ошибка связи с сервером', 'error');
    }
};

window.fillTodayBySchedule = async function () {
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    if (today.getDay() === 0 || today.getDay() === 6) return UI.toast('Сегодня выходной! График 5/2 отдыхает.', 'info');

    const records = currentEmployees.filter(emp => emp.schedule_type === '5/2' && emp.status !== 'fired').map(emp => ({ employee_id: emp.id, status: 'present' }));
    if (records.length === 0) return UI.toast('Нет сотрудников для заполнения', 'info');

    try {
        if ((await fetch('/api/timesheet', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: dateStr, records }) })).ok) {
            UI.toast(`Табель за СЕГОДНЯ заполнен!`, 'success');
            const currentPickerValue = document.getElementById('ts-month-picker').value;
            const todayMonthValue = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
            if (currentPickerValue !== todayMonthValue) document.getElementById('ts-month-picker').value = todayMonthValue;
            loadMonthlyTimesheet();
        }
    } catch (e) { console.error(e); }
};

// === ПЕЧАТЬ ТАБЕЛЯ УЧЕТА ВРЕМЕНИ ===
window.printTimesheet = function () {
    const monthStr = document.getElementById('ts-month-picker').value;
    if (!monthStr) return UI.toast('Выберите месяц', 'warning');

    const theadHtml = document.getElementById('monthly-ts-head')?.innerHTML;
    const tbodyHtml = document.getElementById('monthly-ts-body')?.innerHTML;

    if (!tbodyHtml || tbodyHtml.includes('Загрузка табеля...')) {
        return UI.toast('Табель пуст или еще не загружен', 'warning');
    }

    let printWin = window.open('', '', 'width=1200,height=800');

    // Улучшенный HTML с жестким сбросом веб-стилей для идеальной печати
    let html = `
        <html>
        <head>
            <title>Табель - ${monthStr}</title>
            <style>
                /* Обнуляем отступы окна, принтер сам задаст поля */
                body { font-family: Arial, sans-serif; margin: 0; padding: 0; font-size: 10px; }
                h2 { text-align: center; margin: 15px 0 20px 0; text-transform: uppercase; font-size: 16px; }
                
                /* Жесткая фиксация таблицы на всю ширину листа */
                table { width: 100%; border-collapse: collapse; table-layout: fixed; }
                
                /* СБРОС ИНЛАЙН-СТИЛЕЙ (отключаем скролл и sticky) */
                th, td { 
                    border: 1px solid #334155 !important; 
                    padding: 3px 2px !important; 
                    text-align: center !important; 
                    position: static !important; /* Убиваем sticky */
                    min-width: 0 !important; /* Убиваем ширину из веба */
                    font-size: 10px !important;
                    word-wrap: break-word;
                }
                
                /* Левая колонка (ФИО) - даем ей 16% ширины листа */
                th:first-child, td:first-child {
                    text-align: left !important;
                    width: 20% !important;
                    padding-left: 5px !important;
                }
                
                /* Правая колонка (Итоги) - даем ей 14% ширины */
                th:last-child, td:last-child {
                    width: 7% !important;
                    white-space: nowrap !important; /* Запрещаем перенос строк в суммах */
                }
                
                /* Принудительная печать цветов фона */
                * { -webkit-print-color-adjust: exact !important; color-adjust: exact !important; }
                
                /* Компактные ячейки статусов */
                .ts-cell { display: block; width: 100%; min-height: 14px; line-height: 14px; }
                .status-present { background-color: #dcfce7 !important; color: #166534 !important; font-weight: bold; }
                .status-weekend { background-color: var(--surface-alt) !important; color: #94a3b8 !important; }
                .status-sick { background-color: #fef08a !important; color: #854d0e !important; }
                .status-absent { background-color: #fee2e2 !important; color: #991b1b !important; font-weight: bold; }
                .status-vacation { background-color: #e0e7ff !important; color: #3730a3 !important; }
                
                /* Прячем бейджи уволенных и иконки премий, чтобы не мусорить на бумаге */
                .badge { display: none !important; }
                
                @media print {
                    /* Альбомная ориентация и минимальные поля (8мм) */
                    @page { size: landscape; margin: 8mm; }
                    .no-print { display: none !important; }
                }
            </style>
        </head>
        <body>
            <div class="no-print" style="text-align: center; margin-bottom: 20px;">
                <button onclick="window.print()" style="padding: 10px 20px; background: #2563eb; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: bold;">🖨️ Отправить на принтер (Альбомная ориентация)</button>
                <div style="margin-top: 10px; color: #64748b;">Если таблица не влезает, убедитесь, что в настройках принтера стоит "Масштаб: По размеру страницы"</div>
            </div>
            
            <h2>Табель учета рабочего времени за ${monthStr}</h2>
            
            <table>
                <thead>${theadHtml}</thead>
                <tbody>${tbodyHtml}</tbody>
            </table>
            
            <div style="margin-top: 30px; display: flex; justify-content: space-between; font-size: 14px; font-weight: bold;">
                <div>Составил: _____________________</div>
                <div>Утвердил: _____________________</div>
            </div>
        </body>
        </html>
    `;

    printWin.document.write(html);
    printWin.document.close();
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
            html += `<tr><td style="text-align:center;">${counter++}</td><td><b>${emp.name}</b><br><span style="font-size:10px;color:var(--text-muted);">${emp.position}</span></td><td class="num">${emp.earned.toLocaleString()} ₽</td><td class="num">${emp.prevBalance.toLocaleString()} ₽</td><td class="num">-${emp.tax.toLocaleString()} ₽</td><td class="num">-${emp.advances.toLocaleString()} ₽</td><td class="num">${emp.adjustments.toLocaleString()} ₽</td><td class="num"><b>${emp.amount.toLocaleString()} ₽</b></td><td></td></tr>`;
            grandTotal += emp.amount;
        });
    });
    html += `</tbody></table><h3 style="text-align:right;">Общая сумма к выдаче: <u>${grandTotal.toLocaleString()} ₽</u></h3><div style="margin-top:50px;display:flex;justify-content:space-between;"><div>Выдал: ____________</div><div>Утвердил: ____________</div></div></body></html>`;
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
            html += `<tr><td class="text-center">${counter++}</td><td><b>${emp.name}</b></td><td>${emp.position}</td><td class="text-right"><b>${emp.amount.toLocaleString()} ₽</b></td><td></td></tr>`;
            depTotal += emp.amount; grandTotal += emp.amount;
        });
        html += `<tr><td colspan="3" class="text-right">Итого по отделу:</td><td class="text-right"><b>${depTotal.toLocaleString()} ₽</b></td><td></td></tr>`;
    });
    html += `</tbody></table><h3 class="text-right">Общая сумма: <u>${grandTotal.toLocaleString()} ₽</u></h3><div style="margin-top:50px;display:flex;justify-content:space-between;"><div>Выдал: ____________</div><div>Утвердил: ____________</div></div></body></html>`;
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

        const newStatus = (currentStatus === 'present') ? 'weekend' : 'present';

        // === 1. ОПТИМИСТИЧНЫЙ UI (МГНОВЕННАЯ РЕАКЦИЯ) ===
        // Визуально меняем ячейку прямо сейчас, не дожидаясь ответа сервера!
        el.setAttribute('data-status', newStatus);
        el.className = `ts-cell status-${newStatus}`;

        // Обновляем данные в локальной памяти, чтобы перерасчет сумм был верным
        let localRecord = currentMonthRecords.find(r => r.employee_id == empId && r.record_date.startsWith(dateStr));
        if (localRecord) {
            localRecord.status = newStatus;
        } else {
            currentMonthRecords.push({ employee_id: parseInt(empId), record_date: dateStr, status: newStatus, bonus: currentBonus, penalty: currentPenalty });
        }

        // Мгновенно пересчитываем итоги справа (сделка, суммы), используя локальный кэш
        if (typeof reRenderTimesheet === 'function') reRenderTimesheet();

        // === 2. ФОНОВАЯ ОТПРАВКА НА СЕРВЕР ===
        try {
            const res = await fetch('/api/timesheet/cell', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    employee_id: empId,
                    date: dateStr,
                    status: newStatus,
                    bonus: currentBonus,
                    penalty: currentPenalty,
                    bonus_comment: currentBComment,
                    penalty_comment: currentPComment
                })
            });

            if (!res.ok) {
                // Если сервер выдал ошибку связи - делаем откат изменений
                const errData = await res.json();
                UI.toast(errData.error || 'Ошибка сохранения ячейки', 'error');

                el.setAttribute('data-status', currentStatus);
                if (localRecord) localRecord.status = currentStatus;
                if (typeof reRenderTimesheet === 'function') reRenderTimesheet();
            }
        } catch (err) {
            console.error('Ошибка клика:', err);
            UI.toast('Ошибка сети при сохранении', 'error');
            // Делаем откат при пропаже интернета
            el.setAttribute('data-status', currentStatus);
            if (localRecord) localRecord.status = currentStatus;
            if (typeof reRenderTimesheet === 'function') reRenderTimesheet();
        }
    }
    window.isLongPress = false;
};

// === 📅 МОДАЛЬНОЕ ОКНО (С АВТОШТРАФОМ И СТАВКОЙ) ===
window.openCellEditModal = function (empId, empName, dateStr, currentStatus, currentBonus, currentPenalty, dailyCost, bonusComment, penaltyComment) {
    bonusComment = (bonusComment && bonusComment !== 'undefined') ? bonusComment : '';
    penaltyComment = (penaltyComment && penaltyComment !== 'undefined') ? penaltyComment : '';
    const costNum = parseFloat(dailyCost) || 0;

    const html = `
        <p style="margin-top: 0; margin-bottom: 20px;">Отметка для <b>${escapeHTML(empName)}</b><br>
        <span style="color: var(--text-muted); font-size: 13px;">Дата: ${dateStr} | <b>Ставка: ${costNum.toLocaleString()} ₽</b></span></p>
        
        <div class="form-group">
            <label>Статус:</label>
            <select id="cell-status-select" class="input-modern" onchange="togglePenaltyCheck(${costNum})">
                <option value="present" ${currentStatus === 'present' ? 'selected' : ''}>🟢 Был на работе</option>
                <option value="weekend" ${currentStatus === 'weekend' ? 'selected' : ''}>⚪ Выходной</option>
                <option value="absent" ${currentStatus === 'absent' ? 'selected' : ''}>🔴 Прогул</option>
                <option value="sick" ${currentStatus === 'sick' ? 'selected' : ''}>🟡 Больничный</option>
                <option value="vacation" ${currentStatus === 'vacation' ? 'selected' : ''}>🔵 Отпуск</option>
            </select>
        </div>

        <div id="penalty-check-container" style="display: ${currentStatus === 'absent' ? 'flex' : 'none'}; align-items: center; gap: 10px; margin: 10px 0; padding: 10px; background: var(--danger-bg); border-radius: 6px; border: 1px solid var(--danger-border);">
            <input type="checkbox" id="cell-auto-penalty" style="width:18px; height:18px;" onchange="applyAutoPenalty(this.checked, ${costNum})">
            <label for="cell-auto-penalty" style="font-size: 13px; color: var(--danger-text); font-weight: bold; cursor:pointer;">Вычесть стоимость смены за прогул (-${costNum} ₽)?</label>
        </div>

        <div class="form-grid" style="grid-template-columns: 1fr 1fr; margin-top: 15px; gap: 15px;">
            <div style="background: var(--success-bg); padding: 10px; border-radius: 6px; border: 1px dashed var(--success);">
                <label style="color: var(--success-text); font-weight: bold;">Премия (₽):</label>
                <input type="number" id="cell-bonus" class="input-modern" value="${parseFloat(currentBonus) || ''}" placeholder="0">
                <input type="text" id="cell-bonus-comment" class="input-modern" style="margin-top:5px; font-size:12px;" value="${escapeHTML(bonusComment)}" placeholder="За что...">
            </div>
            <div style="background: var(--danger-bg); padding: 10px; border-radius: 6px; border: 1px dashed var(--danger);">
                <label style="color: var(--danger-text); font-weight: bold;">Штраф (₽):</label>
                <input type="number" id="cell-penalty" class="input-modern" value="${parseFloat(currentPenalty) || ''}" placeholder="0">
                <input type="text" id="cell-penalty-comment" class="input-modern" style="margin-top:5px; font-size:12px;" value="${escapeHTML(penaltyComment)}" placeholder="Причина...">
            </div>
        </div>
    `;
    const buttons = `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-blue" onclick="saveCellStatus(${empId}, '${dateStr}')">💾 Сохранить</button>
    `;
    UI.showModal('📅 Детальное редактирование', html, buttons);
};

// === ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ (ДЛЯ АВТОШТРАФА) ===
window.togglePenaltyCheck = function (dailyCost) {
    const status = document.getElementById('cell-status-select').value;
    const container = document.getElementById('penalty-check-container');
    if (status === 'absent') {
        container.style.display = 'flex';
    } else {
        container.style.display = 'none';
        document.getElementById('cell-auto-penalty').checked = false;
    }
};

window.applyAutoPenalty = function (isChecked, dailyCost) {
    document.getElementById('cell-penalty').value = isChecked ? dailyCost : 0;
};

window.saveCellStatus = async function (empId, dateStr) {
    const bonus = parseFloat(document.getElementById('cell-bonus').value) || 0;
    const penalty = parseFloat(document.getElementById('cell-penalty').value) || 0;
    const newStatus = document.getElementById('cell-status-select').value;

    if (bonus < 0 || penalty < 0) {
        return UI.toast('Суммы не могут быть отрицательными!', 'warning');
    }

    const payload = {
        employee_id: empId,
        date: dateStr,
        status: newStatus,
        bonus,
        penalty,
        bonus_comment: document.getElementById('cell-bonus-comment').value.trim(),
        penalty_comment: document.getElementById('cell-penalty-comment').value.trim()
    };

    try {
        const res = await fetch('/api/timesheet/cell', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (res.ok) {
            UI.closeModal();

            // Мгновенное локальное обновление вместо долгого скачивания с сервера
            let localRecord = currentMonthRecords.find(r => r.employee_id == empId && r.record_date.startsWith(dateStr));
            if (localRecord) {
                localRecord.status = newStatus;
                localRecord.bonus = bonus;
                localRecord.penalty = penalty;
            } else {
                currentMonthRecords.push({ employee_id: parseInt(empId), record_date: dateStr, status: newStatus, bonus: bonus, penalty: penalty });
            }

            if (typeof reRenderTimesheet === 'function') reRenderTimesheet();
        } else {
            const err = await res.json();
            UI.toast(err.error || 'Ошибка', 'error');
        }
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