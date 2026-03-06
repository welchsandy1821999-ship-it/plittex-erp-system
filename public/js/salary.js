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
    });
}

// === ЛОГИКА АККОРДЕОНА ===
function toggleAccordion(bodyId, headerEl) {
    const body = document.getElementById(bodyId);
    if (body.classList.contains('active')) {
        body.classList.remove('active');
        headerEl.classList.remove('open');
    } else {
        body.classList.add('active');
        headerEl.classList.add('open');
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

function renderEmployeesTable() {
    const tbodyActive = document.getElementById('employees-table-body');
    const tbodyFired = document.getElementById('fired-employees-table-body');
    const searchTerm = (document.getElementById('emp-search-input')?.value || '').toLowerCase();
    const depFilter = document.getElementById('emp-dep-filter')?.value || 'all';

    // Базовый поиск
    const filtered = currentEmployees.filter(emp => {
        const matchSearch = emp.full_name.toLowerCase().includes(searchTerm) || emp.position.toLowerCase().includes(searchTerm);
        const matchDep = depFilter === 'all' || emp.department === depFilter;
        return matchSearch && matchDep;
    });

    // Разделяем на работающих и уволенных
    const activeEmps = filtered.filter(e => e.status !== 'fired');
    const firedEmps = filtered.filter(e => e.status === 'fired');

    // Функция-генератор строк
    const generateRows = (emps) => {
        if (emps.length === 0) return '<tr><td colspan="8" style="text-align: center; color: var(--text-muted); padding: 20px;">Список пуст</td></tr>';
        return emps.map(emp => `
            <tr style="${emp.status === 'fired' ? 'background: #f8fafc;' : ''}">
                <td style="font-weight: 600;">
                    ${emp.full_name}
                    ${emp.status === 'fired' ? '<span class="badge" style="background: var(--danger); color: white; margin-left: 5px;">Уволен</span>' : ''}
                </td>
                <td style="color: var(--text-muted);">${emp.position}</td>
                <td><span class="badge" style="background: #e2e8f0; color: #475569;">${emp.department}</span> <b>${emp.schedule_type}</b></td>
                <td style="text-align: right; color: var(--success); font-weight: bold;">${parseFloat(emp.salary_cash).toLocaleString('ru-RU')} ₽</td>
                <td style="text-align: right; color: var(--text-muted);">${parseFloat(emp.salary_official).toLocaleString('ru-RU')} ₽</td>
                <td style="text-align: right; color: var(--danger); font-weight: 600;">-${parseFloat(emp.tax_withheld || 0).toLocaleString('ru-RU')} ₽</td>
                <td style="text-align: right; color: ${parseFloat(emp.prev_balance || 0) >= 0 ? 'var(--primary)' : 'var(--danger)'}; font-weight: bold;">
                    ${parseFloat(emp.prev_balance || 0) > 0 ? '+' : ''}${parseFloat(emp.prev_balance || 0).toLocaleString('ru-RU')} ₽
                </td>
                <td style="text-align: center;">
                    <div style="display: flex; gap: 5px; justify-content: center;">
                        <button class="btn btn-outline" style="padding: 4px 8px; font-size: 12px;" onclick="editEmployee(${emp.id})">✏️ Ред.</button>
                        ${emp.status === 'fired' ? `<button class="btn btn-outline" style="padding: 4px 8px; font-size: 12px; color: var(--danger); border-color: var(--danger);" onclick="deleteEmployee(${emp.id}, '${emp.full_name}')" title="Удалить">❌</button>` : ''}
                    </div>
                </td>
            </tr>
        `).join('');
    };

    if (tbodyActive) tbodyActive.innerHTML = generateRows(activeEmps);
    if (tbodyFired) tbodyFired.innerHTML = generateRows(firedEmps);
}

// Авто-расчет удержания в окне (ОСТАВЛЯЕМ КАК ЕСТЬ)
window.calcTaxWithheld = function () {
    const off = parseFloat(document.getElementById('emp-sal-off').value) || 0;
    const rate = parseFloat(document.getElementById('emp-tax-rate').value) || 0;
    document.getElementById('emp-tax-withheld').value = Math.round(off * (rate / 100));
};

function openEmployeeModal(emp = null) {
    const isEdit = !!emp;
    const html = `
            <div class="form-grid" style="grid-template-columns: 1fr 1fr;">
            <div class="form-group">
                <label>ФИО сотрудника:</label>
                <input type="text" id="emp-name" class="input-modern" value="${isEdit ? emp.full_name : ''}">
            </div>
            <div class="form-group">
                <label>Должность:</label>
                <input type="text" id="emp-pos" class="input-modern" value="${isEdit ? emp.position : ''}" placeholder="Например: Разнорабочий">
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
            
            <div class="form-group" style="background: #f0fdf4; padding: 10px; border-radius: 6px; border: 1px dashed var(--success); grid-column: span 2;">
                <label style="color: var(--success); font-weight: bold;">Базовая ставка / Оклад (Нал):</label>
                <input type="number" id="emp-sal-cash" class="input-modern" style="font-size: 16px; font-weight: bold;" value="${isEdit ? emp.salary_cash : '0'}">
            </div>

            <div class="form-group" style="background: #f8fafc; padding: 10px; border-radius: 6px; border: 1px dashed var(--text-muted); grid-column: span 2;">
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

            <div class="form-group" style="background: #eff6ff; padding: 10px; border-radius: 6px; border: 1px dashed var(--primary); grid-column: span 2;">
                <label style="color: var(--primary); font-weight: bold;">± Остаток с прошлых месяцев (Долг / Переплата):</label>
                <input type="number" id="emp-prev-balance" class="input-modern" style="font-size: 15px; font-weight: bold;" value="${isEdit ? (emp.prev_balance || 0) : '0'}">
                <div style="font-size: 11px; color: var(--text-muted); margin-top: 4px;">Положительное число — мы должны сотруднику. С минусом — сотрудник должен нам.</div>
            </div>

            <div class="form-group" style="background: #fef2f2; padding: 10px; border-radius: 6px; border: 1px dashed var(--danger); grid-column: span 2;">
                <label style="color: var(--danger); font-weight: bold;">Статус в компании:</label>
                <select id="emp-status" class="input-modern" style="font-weight: bold;">
                    <option value="active" ${isEdit && emp.status === 'active' ? 'selected' : ''}>🟢 Работает</option>
                    <option value="fired" ${isEdit && emp.status === 'fired' ? 'selected' : ''}>🔴 УВОЛЕН</option>
                </select>
            </div>
        </div>
    `;

    const buttons = `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-blue" onclick="saveEmployee(${isEdit ? emp.id : 'null'})">💾 Сохранить</button>
    `;

    UI.showModal(isEdit ? '✏️ Редактирование сотрудника' : '➕ Новый сотрудник', html, buttons);
}

function editEmployee(id) {
    const emp = currentEmployees.find(e => e.id === id);
    if (emp) openEmployeeModal(emp);
}

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
        status: document.getElementById('emp-status').value // <--- ДОБАВЛЕН СТАТУС ТУТ
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

// === ЗАГРУЗКА МЕСЯЧНЫХ ДАННЫХ (ТАБЕЛЬ, АВАНСЫ, СЛЕПКИ) ===
async function loadMonthlyTimesheet() {
    const monthPicker = document.getElementById('ts-month-picker').value;
    if (!monthPicker) return;
    const [year, month] = monthPicker.split('-');

    try {
        const resTs = await fetch(`/api/timesheet/month?year=${year}&month=${month}`);
        currentMonthRecords = await resTs.json();

        const resPay = await fetch(`/api/salary/payments?year=${year}&month=${month}`);
        currentMonthPayments = await resPay.json();

        const resStats = await fetch(`/api/salary/stats?year=${year}&month=${month}`);
        currentMonthStats = await resStats.json();

        // НОВАЯ СТРОКА: Загружаем ГСМ и Займы
        const resAdj = await fetch(`/api/salary/adjustments?monthStr=${year}-${month}`);
        currentMonthAdjustments = await resAdj.json();

        renderTimesheetMatrix(parseInt(year), parseInt(month));
    } catch (e) { console.error(e); }
}

// === ОТРИСОВКА МАТРИЦЫ И ВЫПЛАТ ===
function renderTimesheetMatrix(year, month) {
    const daysInMonth = new Date(year, month, 0).getDate();
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    let normDays52 = 0;
    for (let d = 1; d <= daysInMonth; d++) {
        const dow = new Date(year, month - 1, d).getDay();
        if (dow !== 0 && dow !== 6) normDays52++;
    }
    const normShifts13 = daysInMonth / 4;

    // Отрисовка заголовка (Дни месяца)
    const thead = document.getElementById('monthly-ts-head');
    let headHtml = `<tr>
        <th style="position: sticky; left: 0; background: #f8fafc; z-index: 20; border-right: 2px solid var(--border); min-width: 250px;">Сотрудник</th>`;
    for (let day = 1; day <= daysInMonth; day++) {
        const dow = new Date(year, month - 1, day).getDay();
        const isWeekend = dow === 0 || dow === 6;
        const isToday = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` === todayStr;

        let thStyle = `text-align: center; padding: 10px 4px; min-width: 35px; border-bottom: 2px solid var(--border); `;
        if (isWeekend) thStyle += `background: #f1f5f9; color: var(--danger); `;
        if (isToday) thStyle += `background: #eff6ff; color: var(--primary); font-weight: 800; border-bottom: 2px solid var(--primary);`;

        headHtml += `<th style="${thStyle}">${day}</th>`;
    }
    headHtml += `<th style="text-align: right; background: #f8fafc; border-left: 2px solid var(--border);">Итого (Дни / ₽)</th></tr>`;
    if (thead) thead.innerHTML = headHtml;

    // Отрисовка тела
    const tbody = document.getElementById('monthly-ts-body');
    let bodyHtml = '';

    const depFilter = document.getElementById('emp-dep-filter')?.value || 'all';
    const departments = depFilter === 'all' ? ['Офис', 'Цех', 'Охрана'] : [depFilter];

    departments.forEach(dep => {
        const depEmps = currentEmployees.filter(e => {
            if (e.department !== dep) return false;
            if (e.status !== 'fired') return true;
            return currentMonthRecords.some(r => r.employee_id === e.id && ['present', 'sick', 'vacation'].includes(r.status));
        });

        if (depEmps.length === 0) return;

        bodyHtml += `<tr><td colspan="${daysInMonth + 2}" style="background: #e2e8f0; font-weight: bold; padding: 8px 15px; color: #334155;">Отдел: ${dep.toUpperCase()}</td></tr>`;

        depEmps.forEach(emp => {
            const empStat = currentMonthStats.find(s => s.employee_id === emp.id) || emp;
            const baseSalary = parseFloat(empStat.salary_cash) || 0;
            const dailyCost = emp.schedule_type === '5/2' ? Math.round(baseSalary / normDays52) : Math.round(baseSalary / normShifts13);

            bodyHtml += `<tr style="transition: 0.15s;" onmouseover="this.style.backgroundColor='#f8fafc'" onmouseout="this.style.backgroundColor=''">
                <td style="position: sticky; left: 0; background: #fff; z-index: 10; border-right: 2px solid var(--border); padding: 8px 15px;">
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

                const record = currentMonthRecords.find(r => r.employee_id === emp.id && r.record_date.startsWith(dateStr));

                let status = 'weekend';
                let cellBonus = 0;
                let cellPenalty = 0;

                let cellBaseRate = dailyCost;
                let ktuText = '';

                if (record) {
                    status = record.status;
                    cellBonus = parseFloat(record.bonus) || 0;
                    cellPenalty = parseFloat(record.penalty) || 0;

                    if (record.custom_rate !== null && record.custom_rate !== undefined) {
                        cellBaseRate = parseFloat(record.custom_rate);
                    }
                    if (record.ktu && parseFloat(record.ktu) !== 1.0) {
                        ktuText = ` (КТУ ${parseFloat(record.ktu)})`;
                    }
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
                if (isWeekend) tdStyle += `background: #f8fafc; `;
                if (isToday) tdStyle += `border-left: 2px solid var(--primary); border-right: 2px solid var(--primary); background: #eff6ff; `;

                let extraIcons = '';
                if (cellBonus > 0) extraIcons += '<div style="position:absolute; top:-2px; right:-2px; width:6px; height:6px; background:var(--success); border-radius:50%; box-shadow: 0 0 2px rgba(0,0,0,0.3);"></div>';
                if (cellPenalty > 0) extraIcons += '<div style="position:absolute; bottom:-2px; right:-2px; width:6px; height:6px; background:var(--danger); border-radius:50%; box-shadow: 0 0 2px rgba(0,0,0,0.3);"></div>';

                const clickAction = emp.status === 'fired'
                    ? `onclick="UI.toast('Сотрудник уволен. Редактирование дней запрещено.', 'warning')"`
                    : `onclick="openCellEditModal(${emp.id}, '${emp.full_name}', '${dateStr}', '${status}', ${cellBonus}, ${cellPenalty}, ${dailyCost})"`;

                const opacityStyle = (emp.status === 'fired' && status === 'weekend') ? 'opacity: 0.4;' : '';

                bodyHtml += `
                    <td style="${tdStyle}">
                        <div style="position: relative; width: max-content; margin: 0 auto; ${opacityStyle}">
                            <div class="ts-cell status-${status}" 
                                title="${emp.full_name} | ${dateStr}\nОклад (Факт): ${cellBaseRate}₽/д${ktuText}\nПремия: ${cellBonus}₽ | Штраф: ${cellPenalty}₽"
                                ${clickAction}
                                style="${emp.status === 'fired' ? 'cursor: not-allowed;' : ''}">
                                ${day}
                            </div>
                            ${extraIcons}
                        </div>
                    </td>
                `;
            } // конец цикла for(day)

            const totalEarned = earnedBase + totalBonus - totalPenalty;

            let summaryHtml = `<td style="text-align: right; padding: 8px 12px; background: #f8fafc; border-left: 2px solid var(--border);">`;
            const normText = emp.schedule_type === '5/2' ? `${worked} / ${normDays52} дн` : `${worked} / ${Math.round(normShifts13)} см`;
            const isNormMet = emp.schedule_type === '5/2' ? worked >= normDays52 : worked >= normShifts13;

            summaryHtml += `<div style="font-size: 12px; font-weight: 600; color: ${isNormMet ? 'var(--success)' : 'var(--text-main)'};">${normText}</div>`;
            summaryHtml += `<div style="color: var(--primary); font-weight: bold; font-size: 15px; margin-top: 4px;" title="Ожидаемая ЗП (Наличные)">${totalEarned.toLocaleString('ru-RU')} ₽</div>`;

            let moneyStats = [];
            if (totalBonus > 0) moneyStats.push(`<span style="color: var(--success);">+${totalBonus.toLocaleString()}₽</span>`);
            if (totalPenalty > 0) moneyStats.push(`<span style="color: var(--danger);">-${totalPenalty.toLocaleString()}₽</span>`);
            if (moneyStats.length > 0) summaryHtml += `<div style="font-size: 11px; margin-top: 4px; display: flex; gap: 6px; justify-content: flex-end; font-weight: bold;">${moneyStats.join(' ')}</div>`;

            summaryHtml += `</td>`;
            bodyHtml += summaryHtml + `</tr>`;
        });
    });

    if (tbody) tbody.innerHTML = bodyHtml;

    /// --- 4. РАСЧЕТ ИТОГОВ НА СЕГОДНЯ И ТАБЛИЦЫ ВЫПЛАТ ---
    let sumTotal = { 'Офис': 0, 'Цех': 0, 'Охрана': 0, 'Всего': 0 };
    let payoutsHtml = '';
    let totalMonthTaxes = 0;
    currentMonthBalances = [];
    currentPrintData = [];
    currentPrintAdvancesData = [];

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
            const record = currentMonthRecords.find(r => r.employee_id === emp.id && r.record_date.startsWith(dateStr));

            let status = record ? record.status : 'weekend';
            if (status === 'present') earnedToday += dailyCost;
            if (record) earnedToday += (parseFloat(record.bonus) || 0) - (parseFloat(record.penalty) || 0);
        }

        const empPayments = currentMonthPayments.filter(p => p.employee_id === emp.id);
        const advances = empPayments.reduce((sum, p) => sum + parseFloat(p.amount), 0);

        if (advances > 0) {
            currentPrintAdvancesData.push({
                department: emp.department,
                name: emp.full_name,
                position: emp.position,
                amount: advances
            });
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

        sumTotal[emp.department] += availableToPay;
        sumTotal['Всего'] += availableToPay;
        currentMonthBalances.push({ empId: emp.id, balance: availableToPay });
        if (availableToPay > 0) currentPrintData.push({ department: emp.department, name: emp.full_name, position: emp.position, amount: availableToPay });

        let advancesHtml = `<span style="color: var(--text-muted);">0 ₽</span>`;
        if (advances > 0) advancesHtml = `<span style="color: var(--primary); text-decoration: underline; cursor: pointer; font-weight: bold;" onclick="openAdvancesDetails(${emp.id}, '${emp.full_name}')">-${advances.toLocaleString()} ₽</span>`;

        let adjHtml = `<span style="color: var(--text-muted);">0 ₽</span>`;
        if (adjSum !== 0) adjHtml = `<span style="color: ${adjSum > 0 ? 'var(--success)' : 'var(--danger)'}; font-weight: bold;">${adjSum > 0 ? '+' : ''}${adjSum.toLocaleString()} ₽</span>`;

        payoutsHtml += `
            <tr style="transition: 0.2s;" onmouseover="this.style.backgroundColor='#f8fafc'" onmouseout="this.style.backgroundColor=''">
                <td><strong style="font-size: 14px;">${emp.full_name}</strong><br><span style="font-size: 11px; color: ${emp.status === 'fired' ? 'var(--danger)' : 'var(--text-muted)'};">${emp.status === 'fired' ? 'УВОЛЕН' : emp.position}</span></td>
                <td style="text-align: right; font-weight: bold; font-size: 15px;">${earnedToday.toLocaleString()} ₽</td>
                <td style="text-align: right; color: ${prevBalance >= 0 ? 'var(--primary)' : 'var(--danger)'}; font-weight: bold;">${prevBalance > 0 ? '+' : ''}${prevBalance.toLocaleString()} ₽</td>
                <td style="text-align: right; color: var(--danger);">-${finalTax.toLocaleString()} ₽</td>
                <td style="text-align: right;">${advancesHtml}</td>
                <td style="text-align: right; cursor: pointer; background: #fffbeb;" onclick="openAdjustmentsModal(${emp.id}, '${emp.full_name}', '${year}-${String(month).padStart(2, '0')}')">${adjHtml}</td>
                <td style="text-align: right; background: ${availableToPay >= 0 ? '#dcfce3' : '#fee2e2'}; color: ${availableToPay >= 0 ? 'var(--success)' : 'var(--danger)'}; font-size: 16px; font-weight: bold;">${availableToPay.toLocaleString()} ₽</td>
                <td style="text-align: center;">
                    <div style="display: flex; gap: 5px; justify-content: center;">
                        <button class="btn btn-outline" style="padding: 4px; font-size: 12px; border-color: #d97706; color: #d97706;" onclick="openAdjustmentsModal(${emp.id}, '${emp.full_name}', '${year}-${String(month).padStart(2, '0')}')" title="Доп. операция">⚙️</button>
                        <button class="btn btn-blue" style="padding: 6px 12px; font-size: 12px;" onclick="openPayoutModal(${emp.id}, '${emp.full_name}', ${availableToPay})">💳</button>
                    </div>
                </td>
            </tr>
        `;
    });

    payoutsHtml += `
        <tr>
            <td colspan="8" style="text-align: right; padding: 15px; background: #f8fafc; border-top: 2px solid var(--border);">
                <button class="btn btn-outline" style="margin-right: 15px; border-color: var(--primary); color: var(--primary);" onclick="printAdvancesSheet()">
                    🖨️ Печать авансов
                </button>
                <button class="btn btn-outline" style="margin-right: 15px; border-color: var(--text-main); color: var(--text-main);" onclick="printSalarySheet()">
                    🖨️ Печать ЗП
                </button>
                
                <button class="btn btn-outline" style="margin-right: 15px; border-color: #10b981; color: #10b981; font-weight: bold;" onclick="exportSalaryToCSV()">
                    📊 В Excel (CSV)
                </button>

                <button class="btn btn-blue" style="margin-right: 15px;" onclick="closeSalaryMonth()">
                    🔒 Закрыть месяц
                </button>
                <span style="margin-right: 15px; font-weight: bold; color: var(--text-muted);">
                    Итого налогов (Безнал): <span style="color: var(--danger); font-size: 18px;">${totalMonthTaxes.toLocaleString()} ₽</span>
                </span>
                <button class="btn btn-outline" style="border-color: var(--danger); color: var(--danger);" onclick="payOfficialTaxes('${year}-${month}', ${totalMonthTaxes})">
                    🏦 Оплатить налоги со счета
                </button>
            </td>
        </tr>
    `;

    const summaryBoxes = document.getElementById('salary-summary-boxes');
    if (summaryBoxes) {
        summaryBoxes.innerHTML = `
            <div style="background: #fff; padding: 15px; border-radius: 8px; border: 1px solid var(--border); border-left: 4px solid var(--text-muted); box-shadow: 0 2px 4px rgba(0,0,0,0.02);">
                <div style="font-size: 12px; color: var(--text-muted); font-weight: bold;">ОФИС (На сегодня)</div>
                <div style="font-size: 20px; font-weight: bold; color: var(--text-main); margin-top: 5px;">${sumTotal['Офис'].toLocaleString()} ₽</div>
            </div>
            <div style="background: #fff; padding: 15px; border-radius: 8px; border: 1px solid var(--border); border-left: 4px solid var(--primary); box-shadow: 0 2px 4px rgba(0,0,0,0.02);">
                <div style="font-size: 12px; color: var(--text-muted); font-weight: bold;">ЦЕХ (На сегодня)</div>
                <div style="font-size: 20px; font-weight: bold; color: var(--text-main); margin-top: 5px;">${sumTotal['Цех'].toLocaleString()} ₽</div>
            </div>
            <div style="background: #fff; padding: 15px; border-radius: 8px; border: 1px solid var(--border); border-left: 4px solid var(--danger); box-shadow: 0 2px 4px rgba(0,0,0,0.02);">
                <div style="font-size: 12px; color: var(--text-muted); font-weight: bold;">ОХРАНА (На сегодня)</div>
                <div style="font-size: 20px; font-weight: bold; color: var(--text-main); margin-top: 5px;">${sumTotal['Охрана'].toLocaleString()} ₽</div>
            </div>
            <div style="background: var(--success); padding: 15px; border-radius: 8px; border: 1px solid #059669; box-shadow: 0 4px 6px rgba(16, 185, 129, 0.2); color: white;">
                <div style="font-size: 12px; font-weight: bold; opacity: 0.9;">ОБЩИЙ ФОТ (На сегодня)</div>
                <div style="font-size: 22px; font-weight: bold; margin-top: 5px;">${sumTotal['Всего'].toLocaleString()} ₽</div>
            </div>
        `;
    }

    const tbodyPayouts = document.getElementById('payouts-table-body');
    if (tbodyPayouts) tbodyPayouts.innerHTML = payoutsHtml;
}

// === ПОКАЗ ДЕТАЛИЗАЦИИ АВАНСОВ ===
window.openAdvancesDetails = function (empId, empName) {
    const empPayments = currentMonthPayments.filter(p => p.employee_id === empId);
    if (empPayments.length === 0) return;

    let detailsHtml = `
        <div class="table-container">
            <table>
                <thead style="background: #f8fafc;">
                    <tr>
                        <th>Дата выдачи</th>
                        <th style="text-align: right;">Сумма</th>
                        <th>Комментарий (Основание)</th>
                    </tr>
                </thead>
                <tbody>

${empPayments.map(p => `
    <tr>
        <td style="font-weight: 600;">${p.payment_date}</td>
        <td style="text-align: right; font-weight: bold; color: var(--danger);">${parseFloat(p.amount).toLocaleString()} ₽</td>
        <td style="color: var(--text-muted); font-size: 13px;">${p.description}</td>
<td style="text-align: center;">
            <button class="btn btn-outline" style="padding:2px 6px; color:var(--danger); border-color:var(--danger);" 
                    onclick="deleteSalaryPayment(${p.id})">🗑️</button>
        </td>
    </tr>
`).join('')}
                </tbody>
            </table>
        </div>
    `;
    UI.showModal(`🧾 История выплат за месяц: ${empName}`, detailsHtml, `<button class="btn btn-outline" onclick="UI.closeModal()">Закрыть</button>`);
};

// === РЕДАКТИРОВАНИЕ ЯЧЕЙКИ ТАБЕЛЯ (С ПРЕМИЯМИ И ШТРАФАМИ) ===
function openCellEditModal(empId, empName, dateStr, currentStatus, currentBonus, currentPenalty, dailyCost) {
    const html = `
        <p style="margin-top: 0; margin-bottom: 20px;">Отметка для <b>${empName}</b><br><span style="color: var(--text-muted); font-size: 13px;">Дата: ${dateStr} | Стоимость смены: ${dailyCost} ₽</span></p>
        
        <div class="form-grid" style="grid-template-columns: 1fr;">
            <div class="form-group">
                <label>Статус:</label>
                <select id="cell-status-select" class="input-modern" style="font-size: 15px; padding: 10px;" onchange="togglePenaltyCheck(${dailyCost})">
                    <option value="present" ${currentStatus === 'present' ? 'selected' : ''}>🟢 Был на работе / Доп. смена (+${dailyCost}₽)</option>
                    <option value="weekend" ${currentStatus === 'weekend' ? 'selected' : ''}>⚪ Выходной (0₽)</option>
                    <option value="absent" ${currentStatus === 'absent' ? 'selected' : ''}>🔴 Прогул / Не выход (0₽)</option>
                    <option value="sick" ${currentStatus === 'sick' ? 'selected' : ''}>🟡 Больничный (0₽)</option>
                    <option value="vacation" ${currentStatus === 'vacation' ? 'selected' : ''}>🔵 Отпуск (0₽)</option>
                </select>
            </div>
            
            <label id="penalty-check-container" style="display: ${currentStatus === 'absent' ? 'flex' : 'none'}; align-items: center; gap: 8px; background: #fee2e2; padding: 10px; border-radius: 6px; cursor: pointer; color: var(--danger); font-weight: 600; font-size: 13px; border: 1px solid #fca5a5;">
                <input type="checkbox" id="cell-auto-penalty" onchange="applyAutoPenalty(this.checked, ${dailyCost})">
                Удержать штраф за прогул (Вычесть ${dailyCost} ₽)
            </label>

            <div class="form-grid" style="grid-template-columns: 1fr 1fr; margin-top: 10px;">
                <div class="form-group">
                    <label style="color: var(--success);">Премия (₽):</label>
                    <input type="number" id="cell-bonus" class="input-modern" value="${currentBonus}" style="border-color: var(--success); color: var(--success); font-weight: bold;">
                </div>
                <div class="form-group">
                    <label style="color: var(--danger);">Штраф (₽):</label>
                    <input type="number" id="cell-penalty" class="input-modern" value="${currentPenalty}" style="border-color: var(--danger); color: var(--danger); font-weight: bold;">
                </div>
            </div>
        </div>
    `;
    const buttons = `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-blue" onclick="saveCellStatus(${empId}, '${dateStr}')">💾 Сохранить</button>
    `;
    UI.showModal('📅 Редактирование дня', html, buttons);
}

// Автоматическое отображение галочки штрафа при выборе "Прогул"
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
    const penaltyInput = document.getElementById('cell-penalty');
    if (isChecked) penaltyInput.value = dailyCost;
    else penaltyInput.value = 0;
};

async function saveCellStatus(empId, dateStr) {
    const payload = {
        employee_id: empId, date: dateStr,
        status: document.getElementById('cell-status-select').value,
        bonus: parseFloat(document.getElementById('cell-bonus').value) || 0,
        penalty: parseFloat(document.getElementById('cell-penalty').value) || 0
    };
    try {
        const res = await fetch('/api/timesheet/cell', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
        });
        if (res.ok) { UI.closeModal(); loadMonthlyTimesheet(); }
    } catch (e) { console.error(e); }
}

// === ОКНО ВЫДАЧИ ДЕНЕГ С ВЫБОРОМ СЧЕТА (ОБНОВЛЕНО) ===
window.openPayoutModal = function (empId, empName, availableAmount) {
    const today = new Date().toISOString().split('T')[0];
    const defaultAmount = availableAmount > 0 ? availableAmount : 0;

    // Подтягиваем счета из модуля Финансов
    const options = (typeof currentAccounts !== 'undefined' && currentAccounts.length > 0)
        ? currentAccounts.map(acc => `<option value="${acc.id}">${acc.name} (баланс: ${parseFloat(acc.balance).toLocaleString()} ₽)</option>`).join('')
        : '<option disabled>Сначала откройте вкладку Финансы</option>';

    const html = `
        <div style="background: #f0fdf4; padding: 15px; border-radius: 8px; border: 1px solid #bbf7d0; margin-bottom: 15px;">
            <p style="margin:0;">Выдача денег для: <b>${empName}</b></p>
            <p style="margin:5px 0 0 0; font-size: 12px; color: #166534;">Доступно к выдаче: ${availableAmount.toLocaleString()} ₽</p>
        </div>

        <div class="form-group" style="margin-bottom: 15px;">
            <label>Сумма к выдаче (₽):</label>
            <input type="number" id="payout-amount" class="input-modern" style="font-size: 18px; font-weight: bold; color: var(--success);" value="${defaultAmount}">
        </div>

        <div class="form-group" style="margin-bottom: 15px;">
            <label>Списать со счета / Кассы:</label>
            <select id="payout-account-id" class="input-modern" style="font-weight: bold; border-color: var(--primary);">${options}</select>
        </div>

        <div class="form-group" style="margin-bottom: 15px;">
            <label>Дата выдачи:</label>
            <input type="date" id="payout-date" class="input-modern" value="${today}">
        </div>

        <div class="form-group">
            <label>Комментарий:</label>
            <input type="text" id="payout-desc" class="input-modern" value="Зарплата за ${document.getElementById('ts-month-picker').value}">
        </div>
    `;

    UI.showModal('💳 Выплата (Зарплата / Аванс)', html, `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-blue" onclick="executePayout(${empId}, '${empName}')">💸 Подтвердить и списать</button>
    `);
}

window.executePayout = async function (empId, empName) {
    const amount = parseFloat(document.getElementById('payout-amount').value);
    const account_id = document.getElementById('payout-account-id').value;
    const date = document.getElementById('payout-date').value;
    const desc = document.getElementById('payout-desc').value;

    if (!amount || amount <= 0) return UI.toast('Введите сумму!', 'error');
    if (!account_id) return UI.toast('Выберите счет для списания!', 'error');

    try {
        const res = await fetch('/api/salary/pay', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                employee_id: empId,
                amount,
                date,
                description: `${empName} - ${desc}`,
                account_id: account_id
            })
        });

        if (res.ok) {
            UI.closeModal();
            UI.toast('✅ Деньги выданы, баланс счета обновлен!', 'success');

            loadMonthlyTimesheet(); // 
            if (typeof loadFinanceData === 'function') loadFinanceData(); // 
        } else {
            const err = await res.text();
            UI.toast('Ошибка: ' + err, 'error');
        }
    } catch (e) { console.error(e); }
}

// === ОПЛАТА НАЛОГОВ ПО БЕЗНАЛУ ===
window.payOfficialTaxes = async function (monthStr, amount) {
    if (!confirm(`Списать ${amount.toLocaleString()} ₽ с расчетного счета на уплату налогов за ${monthStr}?`)) return;
    try {
        const res = await fetch('/api/salary/pay-taxes', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ monthStr, amount })
        });
        if (res.ok) UI.toast('Налоги успешно оплачены (Безнал)!', 'success');
        else UI.toast('Ошибка при оплате налогов', 'error');
    } catch (e) { console.error(e); }
};

// === ЗАКРЫТИЕ МЕСЯЦА ===
window.closeSalaryMonth = async function () {
    const monthStr = document.getElementById('ts-month-picker').value;

    if (!confirm(`Вы уверены, что хотите закрыть ${monthStr}?\n\nВсе суммы из зеленой колонки "К ВЫДАЧЕ" будут зафиксированы и перенесены на следующий месяц как "± Остаток".`)) return;

    try {
        const res = await fetch('/api/salary/close-month', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ balances: currentMonthBalances })
        });

        if (res.ok) {
            UI.toast('✅ Месяц успешно закрыт, остатки перенесены!', 'success');
            // Обновляем всю страницу, чтобы подтянуть новые балансы в первую таблицу
            setTimeout(() => location.reload(), 1500);
        } else {
            UI.toast('Ошибка при закрытии месяца', 'error');
        }
    } catch (e) { console.error(e); }
};

// === ПЕЧАТНАЯ ВЕДОМОСТЬ НА ВЫДАЧУ НАЛИЧНЫХ ===
window.printSalarySheet = function () {
    const monthStr = document.getElementById('ts-month-picker').value;

    if (currentPrintData.length === 0) {
        return UI.toast('Нет сотрудников для выдачи наличных в этом месяце', 'error');
    }

    // Открываем новое окно для чистой печати
    let printWin = window.open('', '', 'width=900,height=700');

    let html = `
    <html>
    <head>
        <title>Ведомость на выдачу зарплаты</title>
        <style>
            body { font-family: 'Arial', sans-serif; padding: 20px; color: #000; }
            h2 { text-align: center; margin-bottom: 5px; font-size: 22px; }
            .subtitle { text-align: center; font-size: 14px; margin-bottom: 30px; }
            table { width: 100%; border-collapse: collapse; margin-bottom: 30px; }
            th, td { border: 1px solid #000; padding: 8px 10px; font-size: 14px; }
            th { background-color: #f0f0f0; font-weight: bold; text-align: center; }
            .dep-row { background-color: #e2e8f0; font-weight: bold; text-align: center; font-size: 15px; letter-spacing: 1px;}
            .text-right { text-align: right; }
            .text-center { text-align: center; }
            .signature-box { width: 180px; }
            @media print {
                .no-print { display: none; }
            }
        </style>
    </head>
    <body>
        <h2>ПЛАТЕЖНАЯ ВЕДОМОСТЬ</h2>
        <div class="subtitle">Выдача наличных средств за период: <b>${monthStr}</b></div>
        
        <div class="no-print" style="text-align: center; margin-bottom: 20px;">
            <button onclick="window.print()" style="padding: 10px 20px; font-size: 16px; cursor:pointer; background: #2563eb; color: white; border: none; border-radius: 4px;">🖨️ Распечатать</button>
            <button onclick="window.close()" style="padding: 10px 20px; font-size: 16px; cursor:pointer; margin-left: 10px;">Закрыть</button>
        </div>
    `;

    const departments = ['Офис', 'Цех', 'Охрана'];
    let grandTotal = 0;

    html += `<table>
                <thead>
                    <tr>
                        <th width="5%">№</th>
                        <th width="30%">ФИО сотрудника</th>
                        <th width="25%">Должность</th>
                        <th width="20%">К выдаче (руб.)</th>
                        <th class="signature-box">Подпись сотрудника</th>
                    </tr>
                </thead>
                <tbody>`;

    let counter = 1;
    departments.forEach(dep => {
        const emps = currentPrintData.filter(e => e.department === dep);
        if (emps.length === 0) return;

        // Заголовок отдела
        html += `<tr><td colspan="5" class="dep-row">${dep.toUpperCase()}</td></tr>`;

        let depTotal = 0;
        emps.forEach(emp => {
            html += `<tr>
                        <td class="text-center">${counter++}</td>
                        <td><b>${emp.name}</b></td>
                        <td style="font-size: 12px; color: #333;">${emp.position}</td>
                        <td class="text-right" style="font-size: 15px;"><b>${emp.amount.toLocaleString('ru-RU')} ₽</b></td>
                        <td></td>
                     </tr>`;
            depTotal += emp.amount;
            grandTotal += emp.amount;
        });

        // Итого по отделу
        html += `<tr>
                    <td colspan="3" class="text-right" style="font-size: 12px; color: #555;">Итого по отделу:</td>
                    <td class="text-right" style="font-size: 14px;"><b>${depTotal.toLocaleString('ru-RU')} ₽</b></td>
                    <td></td>
                 </tr>`;
    });

    html += `   </tbody>
            </table>
            <h3 class="text-right" style="margin-top: 20px;">Общая сумма к выдаче: <span style="border-bottom: 2px solid #000;">${grandTotal.toLocaleString('ru-RU')} ₽</span></h3>
            
            <div style="margin-top: 60px; display: flex; justify-content: space-between; font-weight: bold; font-size: 15px;">
                <div>Выдал (Кассир): _______________________</div>
                <div>Утвердил (Руководитель): _______________________</div>
            </div>
    </body>
    </html>`;

    printWin.document.write(html);
    printWin.document.close();
};

// === ПЕЧАТНАЯ ВЕДОМОСТЬ НА АВАНСЫ ===
window.printAdvancesSheet = function () {
    const monthStr = document.getElementById('ts-month-picker').value;

    if (currentPrintAdvancesData.length === 0) {
        return UI.toast('В этом месяце еще не было выдано ни одного аванса!', 'error');
    }

    let printWin = window.open('', '', 'width=900,height=700');

    let html = `
    <html>
    <head>
        <title>Авансовая ведомость</title>
        <style>
            body { font-family: 'Arial', sans-serif; padding: 20px; color: #000; }
            h2 { text-align: center; margin-bottom: 5px; font-size: 22px; }
            .subtitle { text-align: center; font-size: 14px; margin-bottom: 30px; }
            table { width: 100%; border-collapse: collapse; margin-bottom: 30px; }
            th, td { border: 1px solid #000; padding: 8px 10px; font-size: 14px; }
            th { background-color: #f0f0f0; font-weight: bold; text-align: center; }
            .dep-row { background-color: #e2e8f0; font-weight: bold; text-align: center; font-size: 15px; letter-spacing: 1px;}
            .text-right { text-align: right; }
            .text-center { text-align: center; }
            .signature-box { width: 180px; }
            @media print { .no-print { display: none; } }
        </style>
    </head>
    <body>
        <h2>АВАНСОВАЯ ВЕДОМОСТЬ</h2>
        <div class="subtitle">Выдача авансов за период: <b>${monthStr}</b></div>
        
        <div class="no-print" style="text-align: center; margin-bottom: 20px;">
            <button onclick="window.print()" style="padding: 10px 20px; font-size: 16px; cursor:pointer; background: #2563eb; color: white; border: none; border-radius: 4px;">🖨️ Распечатать</button>
            <button onclick="window.close()" style="padding: 10px 20px; font-size: 16px; cursor:pointer; margin-left: 10px;">Закрыть</button>
        </div>
    `;

    const departments = ['Офис', 'Цех', 'Охрана'];
    let grandTotal = 0;

    html += `<table>
                <thead>
                    <tr>
                        <th width="5%">№</th>
                        <th width="30%">ФИО сотрудника</th>
                        <th width="25%">Должность</th>
                        <th width="20%">Сумма аванса (руб.)</th>
                        <th class="signature-box">Подпись сотрудника</th>
                    </tr>
                </thead>
                <tbody>`;

    let counter = 1;
    departments.forEach(dep => {
        const emps = currentPrintAdvancesData.filter(e => e.department === dep);
        if (emps.length === 0) return;

        html += `<tr><td colspan="5" class="dep-row">${dep.toUpperCase()}</td></tr>`;

        let depTotal = 0;
        emps.forEach(emp => {
            html += `<tr>
                        <td class="text-center">${counter++}</td>
                        <td><b>${emp.name}</b></td>
                        <td style="font-size: 12px; color: #333;">${emp.position}</td>
                        <td class="text-right" style="font-size: 15px;"><b>${emp.amount.toLocaleString('ru-RU')} ₽</b></td>
                        <td></td>
                     </tr>`;
            depTotal += emp.amount;
            grandTotal += emp.amount;
        });

        html += `<tr>
                    <td colspan="3" class="text-right" style="font-size: 12px; color: #555;">Итого авансов по отделу:</td>
                    <td class="text-right" style="font-size: 14px;"><b>${depTotal.toLocaleString('ru-RU')} ₽</b></td>
                    <td></td>
                 </tr>`;
    });

    html += `   </tbody>
            </table>
            <h3 class="text-right" style="margin-top: 20px;">Общая сумма выданных авансов: <span style="border-bottom: 2px solid #000;">${grandTotal.toLocaleString('ru-RU')} ₽</span></h3>
            
            <div style="margin-top: 60px; display: flex; justify-content: space-between; font-weight: bold; font-size: 15px;">
                <div>Выдал (Кассир): _______________________</div>
                <div>Утвердил (Руководитель): _______________________</div>
            </div>
    </body>
    </html>`;

    printWin.document.write(html);
    printWin.document.close();
};

// === СДЕЛЬНАЯ ЗАРПЛАТА (ИНТЕГРАЦИЯ С ПРОИЗВОДСТВОМ) ===
window.openPieceRateModal = function () {
    const today = new Date().toISOString().split('T')[0];
    const html = `
        <div class="form-group">
            <label>Выберите дату закрытой смены:</label>
            <input type="date" id="piece-date" class="input-modern" value="${today}" onchange="loadPieceRateData()">
        </div>
        <div id="piece-rate-content"></div>
    `;
    UI.showModal('🏭 Начисление сдельной премии за формовку', html, '<button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>');
    setTimeout(loadPieceRateData, 100); // Загружаем данные сразу при открытии
};

window.loadPieceRateData = async function () {
    const date = document.getElementById('piece-date').value;
    if (!date) return;

    // Рассчитываем норму дней/смен для вычисления дневной ставки
    const dateObj = new Date(date);
    const year = dateObj.getFullYear();
    const month = dateObj.getMonth() + 1;
    const daysInMonth = new Date(year, month, 0).getDate();
    let normDays52 = 0;
    for (let d = 1; d <= daysInMonth; d++) {
        const dow = new Date(year, month - 1, d).getDay();
        if (dow !== 0 && dow !== 6) normDays52++;
    }
    const normShifts13 = daysInMonth / 4;

    document.getElementById('piece-rate-content').innerHTML = '<p style="text-align: center; color: var(--text-muted);">Загрузка данных...</p>';

    try {
        const resStats = await fetch(`/api/production/daily-stats?date=${date}`);
        const stats = await resStats.json();
        const totalProduced = parseFloat(stats.total) || 0;

        const workshopEmps = currentEmployees.filter(e => e.department === 'Цех');
        let empsHtml = '';
        let activeCount = 0;

        workshopEmps.forEach(emp => {
            const record = currentMonthRecords.find(r => r.employee_id === emp.id && r.record_date.startsWith(date));
            let isPresent = false;
            if (record && record.status === 'present') isPresent = true;
            if (!record) {
                const dow = new Date(date).getDay();
                if (emp.schedule_type === '5/2' && dow !== 0 && dow !== 6) isPresent = true;
            }

            if (isPresent) {
                activeCount++;
                // Вычисляем базовую дневную ставку сотрудника
                const empStat = currentMonthStats.find(s => s.employee_id === emp.id) || emp;
                const baseSalary = parseFloat(empStat.salary_cash) || 0;
                const dailyCost = emp.schedule_type === '5/2' ? Math.round(baseSalary / normDays52) : Math.round(baseSalary / normShifts13);

                // Подтягиваем старые данные, если они уже есть
                const currentKtu = record && record.ktu ? parseFloat(record.ktu) : 1.0;
                const currentRate = record && record.custom_rate !== null ? parseFloat(record.custom_rate) : dailyCost;

                empsHtml += `
                    <tr style="border-bottom: 1px solid var(--border); background: #fff;">
                        <td style="padding: 8px;">
                            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                                <input type="checkbox" class="piece-emp-checkbox" value="${emp.id}" checked onchange="recalcPieceRate()">
                                <span style="font-size: 13px;"><b>${emp.full_name}</b><br><span style="color: var(--text-muted); font-size: 11px;">${emp.position}</span></span>
                            </label>
                        </td>
                        <td style="padding: 8px; text-align: center;">
                            <input type="number" id="ktu-${emp.id}" class="input-modern" value="${currentKtu}" step="0.1" min="0" style="width: 60px; text-align: center; font-weight: bold;" oninput="recalcPieceRate()">
                        </td>
                        <td style="padding: 8px;">
                            <div style="display: flex; align-items: center; gap: 4px;">
                                <input type="number" id="rate-${emp.id}" class="input-modern" value="${currentRate}" style="width: 75px; text-align: right;" oninput="recalcPieceRate()">
                                <div style="display: flex; flex-direction: column; gap: 2px;">
                                    <button class="btn btn-outline" style="padding: 1px 4px; font-size: 10px;" onclick="setRate(${emp.id}, ${dailyCost})" title="100% Оклад">100%</button>
                                    <button class="btn btn-outline" style="padding: 1px 4px; font-size: 10px;" onclick="setRate(${emp.id}, ${Math.round(dailyCost / 2)})" title="50% Оклад">50%</button>
                                    <button class="btn btn-outline" style="padding: 1px 4px; font-size: 10px; color: var(--danger); border-color: var(--danger);" onclick="setRate(${emp.id}, 0)" title="Только Сделка">0</button>
                                </div>
                            </div>
                        </td>
                        <td id="bonus-${emp.id}" style="padding: 8px; text-align: right; color: var(--success); font-weight: bold; font-size: 14px;">0 ₽</td>
                        <td id="total-${emp.id}" style="padding: 8px; text-align: right; font-weight: bold; font-size: 15px;">0 ₽</td>
                    </tr>
                `;
            }
        });

        if (activeCount === 0) empsHtml = '<tr><td colspan="5" style="padding: 15px; text-align: center; color: var(--danger);">В этот день нет работающих сотрудников цеха.</td></tr>';

        document.getElementById('piece-rate-content').innerHTML = `
            <div style="background: #eff6ff; border: 1px solid #bfdbfe; padding: 15px; border-radius: 8px; margin-bottom: 15px;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <div>
                        <div style="font-size: 13px; color: var(--text-muted);">Выпущено продукции:</div>
                        <input type="number" id="piece-total-produced" class="input-modern" value="${totalProduced}" style="font-size: 18px; font-weight: bold; width: 120px;" oninput="recalcPieceRate()">
                    </div>
                    <div>
                        <div style="font-size: 12px;">Расценка за 1 ед (₽):</div>
                        <input type="number" id="piece-rate-price" class="input-modern" value="0" style="font-size: 18px; font-weight: bold; color: var(--success); width: 120px;" oninput="recalcPieceRate()">
                    </div>
                    <div style="text-align: right;">
                        <div style="font-size: 12px; color: var(--primary);">Сдельный фонд:</div>
                        <b id="piece-fund" style="color: var(--primary); font-size: 20px;">0 ₽</b>
                    </div>
                </div>
            </div>
            
            <h4 style="margin-bottom: 10px;">Бригада на смене (Распределение КТУ):</h4>
            <div style="max-height: 250px; overflow-y: auto; border: 1px solid var(--border); border-radius: 8px;">
                <table style="width: 100%; font-size: 13px; border-collapse: collapse;">
                    <thead style="background: #f8fafc; position: sticky; top: 0; z-index: 10;">
                        <tr>
                            <th style="padding: 8px; text-align: left;">Сотрудник</th>
                            <th style="padding: 8px; text-align: center;">КТУ</th>
                            <th style="padding: 8px; text-align: left;">Оклад (Смена)</th>
                            <th style="padding: 8px; text-align: right;">Сделка</th>
                            <th style="padding: 8px; text-align: right;">Итого день</th>
                        </tr>
                    </thead>
                    <tbody>${empsHtml}</tbody>
                </table>
            </div>
        `;

        document.getElementById('app-modal-footer').innerHTML = `
            <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
            <button class="btn btn-blue" id="piece-save-btn" onclick="savePieceRate('${date}')" disabled>💸 Начислить и Сохранить</button>
        `;
        recalcPieceRate();
    } catch (e) { console.error(e); }
};

window.setRate = function (empId, value) {
    document.getElementById(`rate-${empId}`).value = value;
    recalcPieceRate();
};

window.recalcPieceRate = function () {
    const price = parseFloat(document.getElementById('piece-rate-price').value) || 0;
    const totalProduced = parseFloat(document.getElementById('piece-total-produced').value) || 0;
    const fund = totalProduced * price;

    const checkboxes = document.querySelectorAll('.piece-emp-checkbox:checked');
    let totalKtu = 0;

    checkboxes.forEach(cb => {
        totalKtu += parseFloat(document.getElementById(`ktu-${cb.value}`).value) || 0;
    });

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
    const empData = [];
    let totalBonusFund = 0;

    checkboxes.forEach(cb => {
        const id = cb.value;
        const ktu = parseFloat(document.getElementById(`ktu-${id}`).value) || 0;
        const custom_rate = parseFloat(document.getElementById(`rate-${id}`).value) || 0;
        const bonus = parseFloat(document.getElementById(`bonus-${id}`).innerText.replace(/\D/g, '')) || 0;

        totalBonusFund += bonus;
        empData.push({ id, custom_rate, ktu, bonus });
    });

    try {
        const res = await fetch('/api/timesheet/mass-bonus', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ date, empData, totalBonusFund })
        });

        if (res.ok) {
            UI.closeModal();
            UI.toast('Сдельная премия и ставки успешно зафиксированы!', 'success');
            loadMonthlyTimesheet();
        }
    } catch (e) { console.error(e); }
};

// === АВТОЗАПОЛНЕНИЕ ТАБЕЛЯ ЗА СЕГОДНЯ ===
window.fillTodayBySchedule = async function () {
    const today = new Date();

    // Форматируем локальную дату в YYYY-MM-DD
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    const dateStr = `${year}-${month}-${day}`;

    const dow = today.getDay(); // 0 - Воскресенье, 6 - Суббота

    // Защита от заполнения в выходные
    if (dow === 0 || dow === 6) {
        return UI.toast('Сегодня выходной! График 5/2 отдыхает.', 'info');
    }

    // Собираем всех сотрудников с графиком 5/2
    const records = currentEmployees
        .filter(emp => emp.schedule_type === '5/2')
        .map(emp => ({ employee_id: emp.id, status: 'present' }));

    if (records.length === 0) {
        return UI.toast('Нет сотрудников с графиком 5/2', 'info');
    }

    try {
        const res = await fetch('/api/timesheet', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ date: dateStr, records })
        });

        if (res.ok) {
            UI.toast(`Табель за СЕГОДНЯ (${day}.${month}.${year}) заполнен!`, 'success');

            // Проверяем, какой месяц сейчас открыт на экране
            const currentPickerValue = document.getElementById('ts-month-picker').value;
            const todayMonthValue = `${year}-${month}`;

            if (currentPickerValue === todayMonthValue) {
                // Если смотрим текущий месяц - просто обновляем
                loadMonthlyTimesheet();
            } else {
                // Если смотрели другой месяц - переключаем календарь на текущий и обновляем
                document.getElementById('ts-month-picker').value = todayMonthValue;
                loadMonthlyTimesheet();
            }
        } else {
            UI.toast('Ошибка при автозаполнении', 'error');
        }
    } catch (e) { console.error(e); }
};

// === ВЫГРУЗКА ЗАРПЛАТЫ В EXCEL (CSV) ===
window.exportSalaryToCSV = function () {
    if (currentPrintData.length === 0) return UI.toast('Нет данных для выгрузки (К выдаче = 0)', 'error');

    // Формируем заголовки колонок
    let csvContent = "Отдел;ФИО;Должность;Сумма к выдаче (руб.)\n";

    // Заполняем строками
    currentPrintData.forEach(emp => {
        csvContent += `${emp.department};${emp.name};${emp.position};${emp.amount}\n`;
    });

    // Добавляем BOM, чтобы Excel (особенно на Windows) правильно читал русские буквы
    const bom = "\uFEFF";
    const blob = new Blob([bom + csvContent], { type: 'text/csv;charset=utf-8;' });

    // Создаем виртуальную ссылку для скачивания
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    const monthStr = document.getElementById('ts-month-picker').value;

    link.setAttribute("href", url);
    link.setAttribute("download", `Зарплата_${monthStr}.csv`);
    link.style.visibility = 'hidden';

    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    UI.toast('Файл успешно скачан!', 'success');
};

// === ДОП. ОПЕРАЦИИ (ГСМ, ЗАЙМЫ) ===
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
        <div style="background: #f8fafc; padding: 15px; border-radius: 8px; margin-bottom: 15px;">
            <h4 style="margin: 0 0 10px 0;">История операций (${monthStr})</h4>
            ${listHtml}
        </div>
        <div style="border: 1px dashed #d97706; padding: 15px; border-radius: 8px; background: #fffbeb;">
            <h4 style="margin: 0 0 10px 0; color: #d97706;">➕ Добавить операцию</h4>
            <div class="form-group" style="margin-bottom: 10px;">
                <label>Сумма (₽):</label>
                <input type="number" id="adj-amount" class="input-modern" placeholder="Например: -5000 или 2000">
                <span style="font-size: 11px; color: var(--text-muted);">Используйте <b>минус</b> для удержания (ГСМ, Займ) и <b>плюс</b> для начисления.</span>
            </div>
            <div class="form-group">
                <label>Основание (Комментарий):</label>
                <input type="text" id="adj-desc" class="input-modern" placeholder="Топливная карта №123">
            </div>
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
        const res = await fetch('/api/salary/adjustments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ employee_id: empId, month_str: monthStr, amount, description: desc }) });
        if (res.ok) { UI.closeModal(); UI.toast('Операция сохранена', 'success'); loadMonthlyTimesheet(); }
    } catch (e) { }
};

window.deleteAdjustment = async function (id) {
    try {
        await fetch(`/api/salary/adjustments/${id}`, { method: 'DELETE' });
        UI.closeModal(); loadMonthlyTimesheet();
    } catch (e) { }
};

// Обновляем функцию автозаполнения, чтобы уволенным не ставился выход
window.fillTodayBySchedule = async function () {
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const dow = today.getDay();

    if (dow === 0 || dow === 6) return UI.toast('Сегодня выходной! График 5/2 отдыхает.', 'info');

    // ИСКЛЮЧАЕМ УВОЛЕННЫХ ИЗ АВТОЗАПОЛНЕНИЯ
    const records = currentEmployees
        .filter(emp => emp.schedule_type === '5/2' && emp.status !== 'fired')
        .map(emp => ({ employee_id: emp.id, status: 'present' }));

    if (records.length === 0) return UI.toast('Нет сотрудников для заполнения', 'info');

    try {
        if ((await fetch('/api/timesheet', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: dateStr, records }) })).ok) {
            UI.toast(`Табель за СЕГОДНЯ заполнен!`, 'success');
            loadMonthlyTimesheet();
        }
    } catch (e) { console.error(e); }
};

window.deleteSalaryPayment = function (paymentId) {
    const html = `
        <div style="text-align: center;">
            <p style="font-size: 16px; margin-bottom: 10px;">Вы действительно хотите аннулировать эту выплату?</p>
            <p style="font-size: 13px; color: var(--text-muted);">Деньги вернутся в кассу, а долг сотрудника будет пересчитан. Это действие нельзя отменить.</p>
        </div>
    `;

    UI.showModal('⚠️ Подтверждение удаления', html, `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-outline" style="color: var(--danger); border-color: var(--danger);" onclick="executeDeleteSalaryPayment(${paymentId})">🗑️ Да, удалить</button>
    `);
};

window.executeDeleteSalaryPayment = async function (paymentId) {
    try {
        const res = await fetch(`/api/salary/payment/${paymentId}`, { method: 'DELETE' });
        if (res.ok) {
            UI.closeModal();
            UI.toast('✅ Выплата успешно аннулирована', 'success');
            loadMonthlyTimesheet(); // Обновляем Кадры
            if (typeof loadFinanceData === 'function') loadFinanceData(); // Обновляем Финансы
        } else {
            UI.toast('Ошибка при удалении', 'error');
        }
    } catch (e) { console.error(e); }
};

// === УДАЛЕНИЕ СОТРУДНИКА ===
window.deleteEmployee = function (id, name) {
    const html = `
        <p style="font-size: 15px;">Вы уверены, что хотите безвозвратно удалить сотрудника <strong style="color: var(--primary);">${name}</strong>?</p>
        <p style="font-size: 13px; color: var(--danger); margin-top: 10px; background: #fef2f2; padding: 10px; border-radius: 6px;">
            ⚠️ <b>Внимание:</b> Удаление сработает только если сотрудник был добавлен по ошибке. Если у него уже есть финансовая история в системе, база данных заблокирует удаление для сохранения бухгалтерии.
        </p>
    `;
    const buttons = `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-red" onclick="confirmDeleteEmployee(${id})">🗑️ Да, удалить</button>
    `;
    UI.showModal('Удаление сотрудника', html, buttons);
};

window.confirmDeleteEmployee = async function (id) {
    try {
        const res = await fetch(`/api/employees/${id}`, { method: 'DELETE' });
        if (res.ok) {
            UI.closeModal();
            UI.toast('Сотрудник успешно удален', 'success');
            loadEmployees();
        } else {
            const errText = await res.text();
            UI.toast(errText, 'error');
            UI.closeModal();
        }
    } catch (e) {
        console.error(e);
        UI.toast('Ошибка связи с сервером', 'error');
        UI.closeModal();
    }
};