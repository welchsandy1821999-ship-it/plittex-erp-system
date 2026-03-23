// === public/js/dashboard.js ===

let currentCycles = 0;
let loadedExpenses = [];
let ccChart = null;
let dashboardDatePicker = null;
let dashboardDateRange = { start: '', end: '' };

document.addEventListener('DOMContentLoaded', () => {
    // 1. Инициализируем календарь
    dashboardDatePicker = window.initDateRangePicker('cc-date-range', (start, end) => {
        dashboardDateRange.start = start;
        dashboardDateRange.end = end;
    });

    // 2. Высчитываем даты (Первое число месяца и Сегодня)
    const today = new Date();
    const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);

    // 3. Устанавливаем даты в календарь визуально и в наши переменные
    if (dashboardDatePicker) {
        // Метод setDate сам вызовет наш onChange и запишет даты в dashboardDateRange
        dashboardDatePicker.setDate([firstDay, today], true);
    }
});

window.loadCostConstructor = async function () {
    // 🚀 ИСПРАВЛЕНИЕ: Назвали переменные так же, как они ожидаются ниже
    const startDate = dashboardDateRange.start;
    const endDate = dashboardDateRange.end;

    if (!startDate || !endDate) return UI.toast('Выберите период', 'error');

    try {
        const res = await fetch('/api/analytics/cost-constructor', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ startDate, endDate }) // 👈 Теперь всё совпадает
        });

        const data = await res.json();
        currentCycles = data.totalCycles;

        // По умолчанию включаем все расходы, кроме категории "Закупка сырья" (они уже в рецепте)
        loadedExpenses = data.expenses.map(e => ({
            ...e,
            included: e.category !== 'Закупка сырья' && e.category !== 'Зарплата'
        }));

        document.getElementById('cc-total-cycles').innerText = currentCycles.toLocaleString();

        renderExpensesList();
        recalculateEconomy();
    } catch (e) {
        console.error(e);
        UI.toast('Ошибка загрузки данных', 'error');
    }
};

window.renderExpensesList = function () {
    const container = document.getElementById('cc-expenses-list');

    if (loadedExpenses.length === 0) {
        container.innerHTML = `<div style="padding: 20px; text-align: center; color: var(--text-muted);">Нет расходов за этот период</div>`;
        return;
    }

    container.innerHTML = loadedExpenses.map((exp, index) => `
        <div style="display: flex; align-items: center; padding: 12px 0; border-bottom: 1px solid var(--surface-hover);">
            <input type="checkbox" style="margin-right: 15px; width: 18px; height: 18px; cursor: pointer; flex-shrink: 0;" 
                   ${exp.included ? 'checked' : ''} 
                   onchange="toggleExpense(${index}, this.checked)">
            
            <div style="flex-grow: 1; min-width: 0;">
                <div style="font-weight: 500; font-size: 14px; color: var(--text-main);">${exp.category || 'Виртуальный расход'}</div>
                <div style="font-size: 12px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                    ${exp.description || '—'} (${exp.date || 'Без даты'})
                </div>
            </div>
            
            <div style="font-weight: bold; padding-left: 10px; color: ${exp.included ? 'var(--danger)' : 'var(--text-muted)'}; white-space: nowrap;">
                ${parseFloat(exp.amount).toLocaleString('ru-RU')} ₽
            </div>
            
            ${exp.is_virtual ? `
                <button class="btn btn-close" style="margin-left: 10px; font-size: 16px; flex-shrink: 0;" onclick="removeVirtualExpense(${index})">×</button>
            ` : ''}
        </div>
    `).join('');
};

window.toggleExpense = function (index, isChecked) {
    loadedExpenses[index].included = isChecked;
    recalculateEconomy();
    // Обновляем визуальный цвет суммы
    renderExpensesList();
};

window.addVirtualExpense = function () {
    const html = `
        <div class="form-group" style="margin-bottom: 15px;">
            <label>Название расхода:</label>
            <input type="text" id="virt-exp-name" class="input-modern" placeholder="Например: Амортизация матриц">
        </div>
        <div class="form-group" style="margin-bottom: 0;">
            <label>Сумма (₽):</label>
            <input type="number" id="virt-exp-amount" class="input-modern" placeholder="15000">
        </div>
    `;

    UI.showModal('➕ Добавить виртуальный расход', html, `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-blue" onclick="saveVirtualExpense()">💾 Добавить в расчет</button>
    `);
};

window.saveVirtualExpense = function () {
    const name = document.getElementById('virt-exp-name').value.trim();
    const amount = parseFloat(document.getElementById('virt-exp-amount').value);

    if (!name) return UI.toast('Введите название расхода!', 'error');
    if (isNaN(amount) || amount <= 0) return UI.toast('Введите корректную сумму!', 'error');

    loadedExpenses.unshift({
        id: 'virtual_' + Date.now(),
        category: 'Виртуальный',
        description: name,
        amount: amount,
        date: 'Только в расчете',
        included: true,
        is_virtual: true
    });

    UI.closeModal();
    renderExpensesList();
    recalculateEconomy();
};

window.removeVirtualExpense = function (index) {
    loadedExpenses.splice(index, 1);
    renderExpensesList();
    recalculateEconomy();
}

window.recalculateEconomy = function () {
    // 1. Считаем сумму выбранных расходов
    const totalIncluded = loadedExpenses
        .filter(e => e.included)
        .reduce((sum, e) => sum + parseFloat(e.amount), 0);

    document.getElementById('cc-total-expenses').innerText = totalIncluded.toLocaleString() + ' ₽';

    // 2. Считаем нагрузку на 1 цикл
    let costPerCycle = 0;
    if (currentCycles > 0) {
        costPerCycle = totalIncluded / currentCycles;
    }
    document.getElementById('cc-cost-per-cycle').innerText = costPerCycle.toFixed(2) + ' ₽';

    // 3. Рисуем график (группируем по категориям)
    const categoryTotals = {};
    loadedExpenses.filter(e => e.included).forEach(e => {
        const cat = e.category || 'Прочее';
        categoryTotals[cat] = (categoryTotals[cat] || 0) + parseFloat(e.amount);
    });

    renderChart(Object.keys(categoryTotals), Object.values(categoryTotals));
};

function renderChart(labels, dataValues) {
    const ctx = document.getElementById('cc-structure-chart').getContext('2d');

    if (ccChart) ccChart.destroy();

    ccChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: labels,
            datasets: [{
                data: dataValues,
                backgroundColor: window.getChartColors(), // Берем цвета из CSS
                borderWidth: 0, // Убираем черные рамки
                hoverOffset: 8, // Долька выезжает при наведении
                borderRadius: 4 // Слегка скругляем края для красоты
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: 'bottom' },
                tooltip: {
                    callbacks: {
                        label: function (context) {
                            let value = context.raw;
                            return ' ' + value.toLocaleString() + ' ₽';
                        }
                    }
                }
            },
            cutout: '65%'
        }
    });
}