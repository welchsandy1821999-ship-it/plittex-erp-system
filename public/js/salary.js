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
    const tbody = document.getElementById('employees-table-body');
    const searchTerm = (document.getElementById('emp-search-input')?.value || '').toLowerCase();
    const depFilter = document.getElementById('emp-dep-filter')?.value || 'all';

    // Фильтруем массив сотрудников
    const filtered = currentEmployees.filter(emp => {
        const matchSearch = emp.full_name.toLowerCase().includes(searchTerm) || emp.position.toLowerCase().includes(searchTerm);
        const matchDep = depFilter === 'all' || emp.department === depFilter;
        return matchSearch && matchDep;
    });

    if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; color: var(--text-muted); padding: 20px;">Сотрудники не найдены</td></tr>';
        return;
    }

    tbody.innerHTML = filtered.map(emp => `
        <tr style="${emp.status === 'fired' ? 'opacity: 0.6; background: #f1f5f9;' : ''}">
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
                <button class="btn btn-outline" style="padding: 4px 8px; font-size: 12px;" onclick="editEmployee(${emp.id})">✏️ Ред.</button>
            </td>
        </tr>
    `).join('');
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
            <div class="form-group" style="grid-column: span 2;">
                <label>ФИО сотрудника:</label>
                <input type="text" id="emp-name" class="input-modern" value="${isEdit ? emp.full_name : ''}">
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

            <input type="hidden" id="emp-pos" value="${isEdit ? emp.position : 'Сотрудник'}">
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
    const daysOfWeek = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    // 1. Нормы дней/смен
    let normDays52 = 0;
    for (let d = 1; d <= daysInMonth; d++) {
        const dow = new Date(year, month - 1, d).getDay();
        if (dow !== 0 && dow !== 6) normDays52++;
    }
    const normShifts13 = daysInMonth / 4;

    // 2. Шапка матрицы
    const thead = document.getElementById('monthly-ts-head');
    let headHtml = `<tr><th style="min-width: 200px; position: sticky; left: 0; background: #f8fafc; z-index: 20;">Сотрудник</th>`;
    for (let day = 1; day <= daysInMonth; day++) {
        const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const dow = new Date(year, month - 1, day).getDay();
        const isWeekend = dow === 0 || dow === 6;
        const isToday = dateStr === todayStr;

        let thStyle = `text-align: center; padding: 6px 2px; min-width: 32px; `;
        if (isWeekend) thStyle += `color: var(--danger); background: #fef2f2; `;
        if (isToday) thStyle += `border: 2px solid var(--primary); background: #eff6ff; border-bottom: none; `;

        headHtml += `<th style="${thStyle}"><div style="font-size: 11px; font-weight: normal; opacity: 0.8;">${daysOfWeek[dow]}</div><div style="font-size: 14px;">${day}</div></th>`;
    }
    headHtml += `<th style="text-align: right; min-width: 140px; background: #f1f5f9;">Итоги месяца (Нал)</th></tr>`;
    thead.innerHTML = headHtml;

    // 3. Строки матрицы
    const tbody = document.getElementById('monthly-ts-body');
    let bodyHtml = '';
    const departments = ['Офис', 'Цех', 'Охрана'];

    departments.forEach(dep => {
        // ИСПРАВЛЕНИЕ: В табеле уволенный отображается ТОЛЬКО если у него есть отметки (рабочие дни) в ЭТОМ месяце.
        // Долги здесь больше не учитываем (должники будут видны только внизу, в таблице Кассы).
        const depEmps = currentEmployees.filter(e => e.department === dep && (e.status !== 'fired' || currentMonthRecords.some(r => r.employee_id === e.id)));
        if (depEmps.length === 0) return;
        bodyHtml += `<tr><td colspan="${daysInMonth + 2}" style="background: #e2e8f0; font-weight: bold; padding: 6px 16px; font-size: 12px; position: sticky; left: 0;">📁 ${dep.toUpperCase()}</td></tr>`;

        depEmps.forEach(emp => {
            // Берем слепок данных (для защиты истории)
            const empStat = currentMonthStats.find(s => s.employee_id === emp.id) || emp;
            const baseSalary = parseFloat(empStat.salary_cash) || 0;
            const dailyCost = emp.schedule_type === '5/2' ? Math.round(baseSalary / normDays52) : Math.round(baseSalary / normShifts13);

            bodyHtml += `<tr>`;
            bodyHtml += `<td style="position: sticky; left: 0; background: #fff; z-index: 10; border-right: 2px solid var(--border);"><div style="font-weight: 600; font-size: 14px;">${emp.full_name}</div><div style="font-size: 11px; color: var(--text-muted);">${emp.position} (${emp.schedule_type})</div></td>`;

            let worked = 0, sick = 0, vacation = 0, absent = 0;
            let totalBonus = 0, totalPenalty = 0;
            let earnedBase = 0;

            for (let day = 1; day <= daysInMonth; day++) {
                const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                const dow = new Date(year, month - 1, day).getDay();
                const isWeekend = dow === 0 || dow === 6;
                const isToday = dateStr === todayStr;

                const record = currentMonthRecords.find(r => r.employee_id === emp.id && r.record_date.startsWith(dateStr));

                let status = 'weekend';
                let cellBonus = 0;
                let cellPenalty = 0;

                if (record) {
                    status = record.status;
                    cellBonus = parseFloat(record.bonus) || 0;
                    cellPenalty = parseFloat(record.penalty) || 0;
                } else {
                    if (emp.schedule_type === '5/2' && !isWeekend) status = 'weekend';
                    if (emp.schedule_type === '5/2' && isWeekend) status = 'weekend';
                    if (emp.schedule_type === '1/3') status = 'weekend';
                }

                if (status === 'present') {
                    worked++;
                    earnedBase += dailyCost;
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

                // БЛОКИРУЕМ редактирование, если сотрудник уволен
                const clickAction = emp.status === 'fired'
                    ? `onclick="UI.toast('Сотрудник уволен. Редактирование дней запрещено.', 'warning')"`
                    : `onclick="openCellEditModal(${emp.id}, '${emp.full_name}', '${dateStr}', '${status}', ${cellBonus}, ${cellPenalty}, ${dailyCost})"`;

                // Делаем пустые ячейки уволенных визуально более тусклыми
                const opacityStyle = (emp.status === 'fired' && status === 'weekend') ? 'opacity: 0.4;' : '';

                bodyHtml += `
                    <td style="${tdStyle}">
                        <div style="position: relative; width: max-content; margin: 0 auto; ${opacityStyle}">
                            <div class="ts-cell status-${status}" 
                                 title="${emp.full_name} | ${dateStr}\nОклад: ${dailyCost}₽/д\nПремия: ${cellBonus}₽ | Штраф: ${cellPenalty}₽"
                                 ${clickAction}
                                 style="${emp.status === 'fired' ? 'cursor: not-allowed;' : ''}">
                                ${day}
                            </div>
                            ${extraIcons}
                        </div>
                    </td>
                `;
            }

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

    tbody.innerHTML = bodyHtml;

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

        // Убрали отсюда прибавление в totalMonthTaxes!
        let taxWithheld = parseFloat(empStat.tax_withheld) || 0;
        const prevBalance = parseFloat(emp.prev_balance) || 0;

        const dailyCost = emp.schedule_type === '5/2' ? Math.round(baseSalary / normDays52) : Math.round(baseSalary / normShifts13);
        const todayNum = (year === now.getFullYear() && month === (now.getMonth() + 1)) ? now.getDate() : daysInMonth;

        for (let day = 1; day <= todayNum; day++) {
            const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            const dow = new Date(year, month - 1, day).getDay();
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

        // === ИСПРАВЛЕННАЯ ЛОГИКА НАЛОГОВ ===
        let finalTax = taxWithheld;

        // Налог 0, если человек ничего не заработал (пустой табель, отпуск или уволен)
        if (earnedToday <= 0) {
            finalTax = 0;
        } else {
            // Если заработок есть, добавляем его официальный налог в общую копилку предприятия
            const officialTaxes = Math.round(officialSalary * (taxRate / 100));
            totalMonthTaxes += officialTaxes;
        }

        const adjSum = currentMonthAdjustments.filter(a => a.employee_id === emp.id).reduce((s, a) => s + parseFloat(a.amount), 0);

        const availableToPay = earnedToday - finalTax + prevBalance - advances + adjSum;

        // Скрываем из кассы, если уволен и нули по всем фронтам
        if (emp.status === 'fired' && earnedToday === 0 && prevBalance === 0 && advances === 0 && adjSum === 0) return;

        // === СУММИРУЕМ ВЕРХНИЕ КАРТОЧКИ (ФОТ) ===
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

// === ВЫДАЧА ДЕНЕГ (АВАНСЫ / ЗАРПЛАТА) ===
function openPayoutModal(empId, empName, availableAmount) {
    const today = new Date().toISOString().split('T')[0];
    const defaultAmount = availableAmount > 0 ? availableAmount : 0;

    const html = `
        <p>Выдача наличных из кассы для: <b>${empName}</b></p>
        <div class="form-group" style="margin-bottom: 15px;">
            <label>Сумма к выдаче (₽):</label>
            <input type="number" id="payout-amount" class="input-modern" style="font-size: 18px; font-weight: bold; color: var(--success);" value="${defaultAmount}">
        </div>
        <div class="form-group" style="margin-bottom: 15px;">
            <label>Дата выдачи:</label>
            <input type="date" id="payout-date" class="input-modern" value="${today}">
        </div>
        <div class="form-group">
            <label>Комментарий (назначение):</label>
            <input type="text" id="payout-desc" class="input-modern" value="Аванс за ${document.getElementById('ts-month-picker').value}">
        </div>
    `;
    const buttons = `<button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button><button class="btn btn-blue" onclick="executePayout(${empId}, '${empName}')">💸 Подтвердить выдачу</button>`;
    UI.showModal('💳 Выдача Зарплаты / Аванса', html, buttons);
}

async function executePayout(empId, empName) {
    const amount = parseFloat(document.getElementById('payout-amount').value);
    const date = document.getElementById('payout-date').value;
    const desc = document.getElementById('payout-desc').value;

    if (!amount || amount <= 0) return UI.toast('Введите корректную сумму!', 'error');
    try {
        const res = await fetch('/api/salary/pay', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ employee_id: empId, amount, date, description: `${empName} - ${desc}` })
        });
        if (res.ok) {
            UI.closeModal();
            UI.toast('Деньги успешно выданы и списаны из кассы!', 'success');
            loadMonthlyTimesheet();
        } else UI.toast('Ошибка при выдаче', 'error');
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

    document.getElementById('piece-rate-content').innerHTML = '<p style="text-align: center; color: var(--text-muted);">Загрузка данных с производства...</p>';

    try {
        // 1. Спрашиваем производство: "Сколько плитки сделали в этот день?"
        const resStats = await fetch(`/api/production/daily-stats?date=${date}`);
        const stats = await resStats.json();
        const totalProduced = parseFloat(stats.total) || 0;

        // 2. Ищем работников ЦЕХА, которые были на смене
        const workshopEmps = currentEmployees.filter(e => e.department === 'Цех');
        let empsHtml = '';
        let activeCount = 0;

        workshopEmps.forEach(emp => {
            const record = currentMonthRecords.find(r => r.employee_id === emp.id && r.record_date.startsWith(date));

            // Проверяем, стояла ли галочка "Был" в табеле
            let isPresent = false;
            if (record && record.status === 'present') isPresent = true;
            if (!record) { // Если табель еще пустой, предполагаем по графику 5/2
                const dow = new Date(date).getDay();
                if (emp.schedule_type === '5/2' && dow !== 0 && dow !== 6) isPresent = true;
            }

            if (isPresent) {
                activeCount++;
                empsHtml += `
                    <label style="display: flex; align-items: center; gap: 10px; padding: 10px; border: 1px solid var(--border); border-radius: 6px; margin-bottom: 5px; cursor: pointer; background: #fff;">
                        <input type="checkbox" class="piece-emp-checkbox" value="${emp.id}" checked onchange="recalcPieceRate(${totalProduced})">
                        <span><b>${emp.full_name}</b> <span style="color: var(--text-muted); font-size: 12px;">(${emp.position})</span></span>
                    </label>
                `;
            }
        });

        if (activeCount === 0) {
            empsHtml = '<p style="color: var(--danger); font-weight: bold;">В этот день не найдено работающих сотрудников цеха (или табель заполнен как выходной).</p>';
        }

        // Рисуем интерфейс калькулятора
        document.getElementById('piece-rate-content').innerHTML = `
            <div style="background: #eff6ff; border: 1px solid #bfdbfe; padding: 15px; border-radius: 8px; margin-bottom: 15px;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <div>
                        <div style="font-size: 13px; color: var(--text-muted);">Выпущено годной продукции:</div>
                        <div style="font-size: 22px; font-weight: bold; color: var(--primary);">${totalProduced} шт/кв.м</div>
                    </div>
                    <div style="width: 150px;">
                        <label style="font-size: 12px;">Расценка за 1 ед (₽):</label>
                        <input type="number" id="piece-rate-price" class="input-modern" value="0" style="font-size: 16px; font-weight: bold; color: var(--success);" oninput="recalcPieceRate(${totalProduced})">
                    </div>
                </div>
                <div style="margin-top: 15px; padding-top: 10px; border-top: 1px dashed #bfdbfe; display: flex; justify-content: space-between; align-items: flex-end;">
                    <div><span style="font-size: 12px; color: var(--text-muted);">Общий фонд:</span><br><b id="piece-fund" style="color: var(--text-main); font-size: 16px;">0 ₽</b></div>
                    <div style="text-align: right;"><span style="font-size: 12px; color: var(--primary);">Премия на 1 человека:</span><br><b id="piece-per-person" style="background: var(--success); color: white; padding: 4px 8px; border-radius: 4px; font-size: 16px;">0 ₽</b></div>
                </div>
            </div>
            
            <h4 style="margin-bottom: 10px;">Бригада на смене (между кем делим деньги):</h4>
            <div style="max-height: 200px; overflow-y: auto; background: #f8fafc; padding: 10px; border-radius: 8px; border: 1px solid var(--border);">
                ${empsHtml}
            </div>
        `;

        const buttons = `
            <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
            <button class="btn btn-blue" id="piece-save-btn" onclick="savePieceRate('${date}')" disabled>💸 Начислить премию в табель</button>
        `;
        document.getElementById('app-modal-footer').innerHTML = buttons;

    } catch (e) { console.error(e); }
};

window.recalcPieceRate = function (totalProduced) {
    const price = parseFloat(document.getElementById('piece-rate-price').value) || 0;
    const fund = totalProduced * price; // Общий фонд

    // Считаем галочки (сколько человек в бригаде)
    const checkboxes = document.querySelectorAll('.piece-emp-checkbox:checked');
    const count = checkboxes.length;

    // Делим деньги поровну
    const perPerson = count > 0 ? Math.round(fund / count) : 0;

    document.getElementById('piece-fund').innerText = fund.toLocaleString('ru-RU') + ' ₽';
    document.getElementById('piece-per-person').innerText = '+ ' + perPerson.toLocaleString('ru-RU') + ' ₽';

    // Кнопка активна только если есть деньги и выбраны люди
    document.getElementById('piece-save-btn').disabled = (fund <= 0 || count === 0);
    window._currentPieceRatePerPerson = perPerson; // Запоминаем для сохранения
};

window.savePieceRate = async function (date) {
    const checkboxes = document.querySelectorAll('.piece-emp-checkbox:checked');
    const empIds = Array.from(checkboxes).map(cb => cb.value); // Собираем ID выбранных рабочих
    const bonusPerPerson = window._currentPieceRatePerPerson || 0;

    if (empIds.length === 0 || bonusPerPerson <= 0) return;

    try {
        const res = await fetch('/api/timesheet/mass-bonus', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ date, empIds, bonusPerPerson })
        });

        if (res.ok) {
            UI.closeModal();
            UI.toast('Сдельная премия успешно начислена бригаде!', 'success');
            loadMonthlyTimesheet(); // Перерисовываем матрицу и итоги
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