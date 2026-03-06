// === public/js/dashboard.js ===

let currentCycles = 0;
let loadedExpenses = [];
let ccChart = null;

// Устанавливаем даты по умолчанию (текущий месяц) при загрузке
document.addEventListener('DOMContentLoaded', () => {
    const today = new Date();
    const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);
    
    document.getElementById('cc-start-date').value = firstDay.toISOString().split('T')[0];
    document.getElementById('cc-end-date').value = today.toISOString().split('T')[0];
});

window.loadCostConstructor = async function() {
    const startDate = document.getElementById('cc-start-date').value;
    const endDate = document.getElementById('cc-end-date').value;

    if (!startDate || !endDate) return UI.toast('Выберите период', 'error');

    try {
        const res = await fetch('/api/analytics/cost-constructor', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ startDate, endDate })
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

window.renderExpensesList = function() {
    const container = document.getElementById('cc-expenses-list');
    
    if (loadedExpenses.length === 0) {
        container.innerHTML = `<div style="padding: 20px; text-align: center; color: var(--text-muted);">Нет расходов за этот период</div>`;
        return;
    }

    container.innerHTML = loadedExpenses.map((exp, index) => `
        <div style="display: flex; align-items: center; padding: 10px 0; border-bottom: 1px solid #f1f5f9;">
            <input type="checkbox" style="margin-right: 15px; width: 18px; height: 18px; cursor: pointer;" 
                   ${exp.included ? 'checked' : ''} 
                   onchange="toggleExpense(${index}, this.checked)">
            <div style="flex-grow: 1;">
                <div style="font-weight: 500; font-size: 14px;">${exp.category || 'Виртуальный расход'}</div>
                <div style="font-size: 12px; color: var(--text-muted);">${exp.description || '—'} (${exp.date || 'Без даты'})</div>
            </div>
            <div style="font-weight: bold; color: ${exp.included ? 'var(--danger)' : 'var(--text-muted)'};">
                ${parseFloat(exp.amount).toLocaleString()} ₽
            </div>
            ${exp.is_virtual ? `
                <button class="btn" style="margin-left:10px; padding:2px 5px; color:var(--danger);" onclick="removeVirtualExpense(${index})">❌</button>
            ` : ''}
        </div>
    `).join('');
};

window.toggleExpense = function(index, isChecked) {
    loadedExpenses[index].included = isChecked;
    recalculateEconomy();
    // Обновляем визуальный цвет суммы
    renderExpensesList(); 
};

window.addVirtualExpense = function() {
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

window.saveVirtualExpense = function() {
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

window.removeVirtualExpense = function(index) {
    loadedExpenses.splice(index, 1);
    renderExpensesList();
    recalculateEconomy();
}

window.recalculateEconomy = function() {
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
                backgroundColor: ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#64748b'],
                borderWidth: 2,
                borderColor: '#ffffff'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: 'bottom' },
                tooltip: {
                    callbacks: {
                        label: function(context) {
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