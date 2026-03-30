// === public/js/dashboard.js ===

// Хелпер: форматирует число как рубли с ровно двумя знаками после запятой
function fmtRub(val) {
    return parseFloat(val).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

let currentCycles = 0;
// Состояние периода (как в финансах)
let dashPeriodType = 'month'; // Дефолт: Текущий месяц
let dashPeriodValue = new Date().getMonth() + 1;
let dashYear = new Date().getFullYear();
let dashSpecificDate = new Date().toISOString().split('T')[0];

document.addEventListener('DOMContentLoaded', () => {
    // 1. Инициализируем календарь (как в финансах)
    renderDashPeriodUI();

    // 2. Первичная загрузка
    loadCostConstructor();
});

let ccGroupedExpenses = { direct: [], opex: [], capex: [] };
let ccSearchQuery = '';
let ccCurrentGroup = null; // 'direct', 'opex', 'capex'
let ccCurrentCategory = null; // Имя выбранной категории
let ccAllCategories = []; // Глобальный массив всех категорий для TomSelect

window.loadCostConstructor = async function () {
    // 1. РАСЧЕТ ДАТ (из состояния периода)
    let startDate = '', endDate = '';
    if (dashPeriodType === 'day') {
        startDate = dashSpecificDate;
        endDate = dashSpecificDate;
    } else if (dashPeriodType === 'week') {
        const now = new Date();
        const dayOfWeek = now.getDay() || 7; 
        const monday = new Date(now);
        monday.setDate(now.getDate() - dayOfWeek + 1);
        startDate = monday.toISOString().split('T')[0];
        endDate = now.toISOString().split('T')[0];
    } else if (dashPeriodType === 'year') {
        startDate = `${dashYear}-01-01`;
        endDate = `${dashYear}-12-31`;
    } else if (dashPeriodType === 'quarter') {
        const startMonth = (dashPeriodValue - 1) * 3 + 1;
        startDate = `${dashYear}-${String(startMonth).padStart(2, '0')}-01`;
        const endDay = new Date(dashYear, startMonth + 2, 0).getDate();
        endDate = `${dashYear}-${String(startMonth + 2).padStart(2, '0')}-${endDay}`;
    } else if (dashPeriodType === 'month') {
        startDate = `${dashYear}-${String(dashPeriodValue).padStart(2, '0')}-01`;
        const endDay = new Date(dashYear, dashPeriodValue, 0).getDate();
        endDate = `${dashYear}-${String(dashPeriodValue).padStart(2, '0')}-${endDay}`;
    } else if (dashPeriodType === 'all') {
        startDate = '';
        endDate = '';
    }

    // if (!startDate && dashPeriodType !== 'all') return UI.toast('Выберите период', 'error');

    // Остальная логика загрузки...
    // Предзагрузка категорий для быстрого выпадающего списка
    if (ccAllCategories.length === 0) {
        try {
            const resCat = await fetch('/api/categories');
            ccAllCategories = await resCat.json();
        } catch(e) { console.error('Ошибка загрузки справочника категорий', e); }
    }

    try {
        const res = await fetch('/api/analytics/cost-constructor', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ startDate, endDate })
        });

        const data = await res.json();
        currentCycles = data.totalCycles;
        const pieceRateSalary = parseFloat(data.pieceRateSalary) || 0;

        ccGroupedExpenses = data.groupedExpenses || { direct: [], opex: [], capex: [] };

        // 1. Считаем общие суммы по группам
        let totalDirect = ccGroupedExpenses.direct.reduce((sum, cat) => sum + cat.total, 0);
        let totalOpex = ccGroupedExpenses.opex.reduce((sum, cat) => sum + cat.total, 0);
        let totalCapex = ccGroupedExpenses.capex.reduce((sum, cat) => sum + cat.total, 0);

        // В Прямые затраты прибавляем "Сдельную ЗП" (она идет из табеля, а не кассы)
        if (pieceRateSalary > 0) {
            totalDirect += pieceRateSalary;
            ccGroupedExpenses.direct.unshift({
                name: 'Сдельная ЗП (из табеля)',
                total: pieceRateSalary,
                transactions: [{
                    id: 'virt_salary',
                    description: 'Начисления по Табелям отдела Цех',
                    amount: pieceRateSalary,
                    date: 'Авто-расчет',
                    counterparty: 'Сотрудники'
                }]
            });

            // 🛑 ЗАЩИТА ОТ ДВОЙНОГО УЧЕТА ЗП
            // Вычитаем сделку из кассовых выплат OPEX, так как мы только что перенесли её в COGS
            let remainingToSubtract = pieceRateSalary;
            const salaryCategories = ['Зарплата', 'Зарплата и Авансы'];
            
            for (let cat of ccGroupedExpenses.opex) {
                if (salaryCategories.includes(cat.name)) {
                    if (remainingToSubtract <= 0) break;
                    
                    if (cat.total >= remainingToSubtract) {
                        cat.total -= remainingToSubtract;
                        totalOpex -= remainingToSubtract;
                        remainingToSubtract = 0;
                    } else {
                        remainingToSubtract -= cat.total;
                        totalOpex -= cat.total;
                        cat.total = 0;
                    }
                }
            }
        }

        const totalAll = totalDirect + totalOpex + totalCapex;

        // Обновляем плашки
        const elCogs = document.getElementById('cc-total-cogs');
        if (elCogs) elCogs.innerText = fmtRub(totalDirect) + ' ₽';
        
        const elOpex = document.getElementById('cc-total-opex');
        if (elOpex) elOpex.innerText = fmtRub(totalOpex) + ' ₽';
        
        const elCapex = document.getElementById('cc-total-capex');
        if (elCapex) elCapex.innerText = fmtRub(totalCapex) + ' ₽';

        // Проценты
        if (totalAll > 0) {
            const pctCogs = document.getElementById('cc-pct-cogs');
            if (pctCogs) pctCogs.innerText = ((totalDirect / totalAll) * 100).toFixed(1);
            
            const pctOpex = document.getElementById('cc-pct-opex');
            if (pctOpex) pctOpex.innerText = ((totalOpex / totalAll) * 100).toFixed(1);
            
            const pctCapex = document.getElementById('cc-pct-capex');
            if (pctCapex) pctCapex.innerText = ((totalCapex / totalAll) * 100).toFixed(1);
        }

        const totalCy = document.getElementById('cc-total-cycles');
        if (totalCy) totalCy.innerText = currentCycles.toLocaleString();

        const totalExpensesEl = document.getElementById('cc-total-expenses');
        if (totalExpensesEl) totalExpensesEl.innerText = fmtRub(totalOpex) + ' ₽';

        const costPerCycleEl = document.getElementById('cc-cost-per-cycle');
        if (costPerCycleEl) {
            const costPerCycle = currentCycles > 0 ? (totalOpex / currentCycles) : 0;
            costPerCycleEl.innerText = costPerCycle.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₽';
            window.CURRENT_OVERHEAD_PER_CYCLE = costPerCycle;
        }

        // 🚀 КОНТРОЛЬНАЯ СВЕРКА (BALANCE CHECK)
        const totalRaw = data.totalRawExpenses || 0; // Чистая касса (X)
        const prSalary = pieceRateSalary || 0;     // Чистая сделка из HR (Y)
        const totalZ = totalAll;                   // Дашборд Итого (Z)

        let warnEl = document.getElementById('cc-balance-warning');
        if (!warnEl) {
            warnEl = document.createElement('div');
            warnEl.id = 'cc-balance-warning';
            const grid = document.querySelector('.cost-triad-grid');
            if (grid) grid.parentNode.insertBefore(warnEl, grid);
        }

        const diff = Math.abs(totalZ - (totalRaw + prSalary));
        if (diff > 0.01) {
            warnEl.innerHTML = `<div class="card mb-20 fade-in-drilldown" style="background:#fef2f2; color:#b91c1c; border:1px solid #fca5a5; padding: 15px;">
                🔴 <b>ВНИМАНИЕ! Расхождение: ${fmtRub(diff)} ₽.</b> Проверьте неразнесенные платежи.<br>
                Касса (${fmtRub(totalRaw)} ₽) + Сделка HR (${fmtRub(prSalary)} ₽) ≠ Дашборд (${fmtRub(totalZ)} ₽)
            </div>`;
        } else {
            warnEl.innerHTML = `<div class="card mb-20 fade-in-drilldown" style="background:#f0fdf4; color:#166534; border:1px solid #bbf7d0; padding: 15px;">
                🟢 <b>Все расходы учтены.</b> Фактический расход (Касса): ${fmtRub(totalRaw)} ₽ + Начислена Сделка (HR): ${fmtRub(prSalary)} ₽ = Итого в себестоимости: ${fmtRub(totalZ)} ₽
            </div>`;
        }

        closeCostTabs(); // Возврат к плашкам (вместо старого closeDrilldown)

        // 🚀 ЗАГРУЖАЕМ ОСТАТКИ СКЛАДА СИНХРОННО С ДАШБОРДОМ
        if (typeof loadStockValuation === 'function') {
            await loadStockValuation();
        }

    } catch (e) {
        console.error(e);
        UI.toast('Ошибка загрузки Конструктора', 'error');
    }
};window.switchCostTab = function(groupId, tabIndex) {
    if (!ccGroupedExpenses[groupId]) return;
    
    const tabEl = document.getElementById('tab-' + groupId);
    const container = document.getElementById('dashboard-tabs-content');
    const wrapper = container ? container.parentElement : null;
    const gridContainer = document.querySelector('.cost-triad-grid');

    const tabColors = { direct: 'var(--success)', opex: 'var(--warning)', capex: 'var(--primary)' };
    
    // Если клик по уже активной вкладке - сворачиваем
    if (tabEl.classList.contains('tab-active')) {
        tabEl.classList.remove('tab-active');
        container.classList.add('collapsed-panel');
        if (wrapper) {
            wrapper.style.borderTop = 'none';
            wrapper.style.borderLeft = 'none';
            wrapper.style.borderRight = 'none';
            wrapper.style.borderBottom = 'none';
        }
        if (gridContainer) {
            gridContainer.classList.remove('active-drilldown');
            gridContainer.style.removeProperty('--active-border-color');
        }
        ccCurrentGroup = null;
        ccCurrentCategory = null;
        return;
    }

    // Иначе разворачиваем и переключаем
    document.querySelectorAll('.dashboard-tabs-nav .card').forEach(c => c.classList.remove('tab-active'));
    tabEl.classList.add('tab-active');
    
    container.classList.remove('collapsed-panel');
    const offset = -(tabIndex * 33.333333);
    container.style.transform = `translateX(${offset}%)`;

    // 🎨 Цветовая синхронизация: Красим окно Drilldown (полная обводка)
    const color = tabColors[groupId];
    if (wrapper) {
        wrapper.style.borderTop = `1.5px solid ${color}`;
        wrapper.style.borderLeft = `1.5px solid ${color}`;
        wrapper.style.borderRight = `1.5px solid ${color}`;
        wrapper.style.borderBottom = `1.5px solid ${color}`;
    }

    if (gridContainer) {
        gridContainer.classList.add('active-drilldown');
        gridContainer.style.setProperty('--active-border-color', color);
    }

    // Красим верхнюю рамку внутренних панелей 
    document.querySelectorAll('.tab-panel .card').forEach(panelCard => {
        panelCard.style.borderColor = color;
    });

    ccCurrentGroup = groupId;
    ccCurrentCategory = null;
    
    const titles = { direct: '🟢 COGS', opex: '🟠 OPEX', capex: '🔵 CAPEX' };
    const drillTitle = document.getElementById('drill-title-' + groupId);
    if (drillTitle) drillTitle.innerText = titles[groupId];

    // Убираем глобальный поиск при клике на табы
    const searchInput = document.getElementById('cc-search-input');
    if (searchInput && ccSearchQuery) {
        searchInput.value = '';
        ccSearchQuery = '';
    }

    renderDrilldown();

    // 📜 Плавный авто-скролл к окну
    setTimeout(() => {
        if (gridContainer) {
            gridContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } else {
            tabEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }, 150); // Небольшая задержка, чтобы CSS-анимация раскрытия раздвинула контент
};

window.closeCostTabs = function() {
    const container = document.getElementById('dashboard-tabs-content');
    if (container) {
        container.classList.add('collapsed-panel');
        if (container.parentElement) {
            container.parentElement.style.borderTop = 'none';
            container.parentElement.style.borderLeft = 'none';
            container.parentElement.style.borderRight = 'none';
            container.parentElement.style.borderBottom = 'none';
        }
    }
    const gridContainer = document.querySelector('.cost-triad-grid');
    if (gridContainer) {
        gridContainer.classList.remove('active-drilldown');
        gridContainer.style.removeProperty('--active-border-color');
    }

    document.querySelectorAll('.dashboard-tabs-nav .card').forEach(c => c.classList.remove('tab-active'));
    ccCurrentGroup = null;
    ccCurrentCategory = null;
};

window.closeCostCategory = function() {
    if (ccCurrentCategory) {
        // Возврат из транзакций к списку категорий в текущей панели
        ccCurrentCategory = null;
        const titles = { direct: '🟢 COGS', opex: '🟠 OPEX', capex: '🔵 CAPEX' };
        const titleEl = document.getElementById('drill-title-' + ccCurrentGroup);
        if (titleEl) titleEl.innerText = titles[ccCurrentGroup];
        renderDrilldown();
    } else {
        closeCostTabs();
    }
};

window.openCostCategory = function(catName) {
    ccCurrentCategory = catName;
    const titleEl = document.getElementById('drill-title-' + ccCurrentGroup);
    if (titleEl) titleEl.innerText = '🧾 Транзакции: ' + catName;
    renderDrilldown();
};

window.handleCostSearch = function(query) {
    ccSearchQuery = query.toLowerCase().trim();
    
    if (ccCurrentGroup) {
        // Если открыта какая-то вкладка, ищем внутри неё
        renderDrilldown();
    } else {
        // Глобальный поиск "Матрешка" с главного экрана
        const searchContainer = document.getElementById('cc-global-search-container');
        const warnEl = document.getElementById('cc-balance-warning');
        
        if (!ccSearchQuery) {
            if (searchContainer) searchContainer.style.display = 'none';
            if (warnEl) warnEl.style.display = 'block';
            return;
        }

        if (warnEl) warnEl.style.display = 'none';
        if (searchContainer) searchContainer.style.display = 'block';

        renderGlobalSearch();
    }
};

window.renderGlobalSearch = function() {
    const container = document.getElementById('cc-global-search-content');
    if (!container) return;

    let html = '';
    const titles = { direct: '🟢 COGS', opex: '🟠 OPEX', capex: '🔵 CAPEX' };
    const colors = { direct: 'var(--success)', opex: 'var(--warning)', capex: 'var(--primary)' };

    const highlightText = (text, query) => {
        if (!query || !text) return text || '';
        const regex = new RegExp(`(${query})`, 'gi');
        return String(text).replace(regex, '<mark class="highlight-match">$1</mark>');
    };

    ['direct', 'opex', 'capex'].forEach(grp => {
        const groupData = ccGroupedExpenses[grp] || [];
        let groupHtml = '';
        
        groupData.forEach(cat => {
            const catMatch = cat.name.toLowerCase().includes(ccSearchQuery);
            const matchingTxs = cat.transactions.filter(t => 
                catMatch ||
                (t.description || '').toLowerCase().includes(ccSearchQuery) || 
                (t.counterparty || '').toLowerCase().includes(ccSearchQuery) ||
                t.amount.toString().includes(ccSearchQuery)
            );

            if (matchingTxs.length > 0) {
                let txsHtml = matchingTxs.map(t => `
                    <div style="display: flex; justify-content: space-between; padding: 8px 15px 8px 30px; border-bottom: 1px solid var(--surface-hover);">
                        <div style="flex-grow: 1; min-width:0; padding-right:15px;">
                            <div style="font-weight: 500; font-size: 14px; color: var(--text-main);">
                                ${highlightText(t.counterparty || 'Без контрагента', ccSearchQuery)}
                            </div>
                            <div style="font-size: 12px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                                ${highlightText(t.description || '—', ccSearchQuery)} (${t.date})
                            </div>
                        </div>
                        <div style="font-weight: bold; color: var(--danger); white-space: nowrap; margin-right: 15px; display: flex; align-items: center;">
                            ${fmtRub(t.amount)} ₽
                        </div>
                        <div style="display: flex; align-items: center;">
                            <button class="btn btn-outline" style="padding: 2px 6px; font-size: 12px; height: 26px;" onclick="moveTransaction(${t.id})">🔄</button>
                        </div>
                    </div>
                `).join('');

                groupHtml += `
                    <div style="background: var(--surface-alt); margin-bottom: 1px;">
                        <div style="padding: 8px 15px 8px 20px; font-weight: bold; border-bottom: 1px solid var(--border); color: var(--text-main);">
                            📁 ${highlightText(cat.name, ccSearchQuery)}
                        </div>
                        ${txsHtml}
                    </div>
                `;
            }
        });

        if (groupHtml) {
            html += `
                <div class="mb-15 fade-in-drilldown" style="border: 1px solid var(--border); border-radius: 8px; overflow: hidden;">
                    <div style="background: ${colors[grp]}15; padding: 10px 15px; font-weight: bold; color: ${colors[grp]}; border-bottom: 2px solid ${colors[grp]}; text-transform: uppercase;">
                        ${titles[grp]}
                    </div>
                    ${groupHtml}
                </div>
            `;
        }
    });

    if (!html) html = '<div class="text-muted fade-in-drilldown" style="padding: 20px; text-align: center;">Ничего не найдено</div>';
    container.innerHTML = html;
};

// === ГЛОБАЛЬНОЕ СОСТОЯНИЕ КАЛЕНДАРЯ (Копия из финансов) ===
window.renderDashPeriodUI = function () {
    let typeOptions = `
        <option value="day" ${dashPeriodType === 'day' ? 'selected' : ''}>День</option>
        <option value="week" ${dashPeriodType === 'week' ? 'selected' : ''}>Неделя</option>
        <option value="month" ${dashPeriodType === 'month' ? 'selected' : ''}>Месяц</option>
        <option value="quarter" ${dashPeriodType === 'quarter' ? 'selected' : ''}>Квартал</option>
        <option value="year" ${dashPeriodType === 'year' ? 'selected' : ''}>Год</option>
        <option value="all" ${dashPeriodType === 'all' ? 'selected' : ''}>Всё время</option>
    `;

    let valOptions = '';
    if (dashPeriodType === 'quarter') {
        for (let i = 1; i <= 4; i++) valOptions += `<option value="${i}" ${dashPeriodValue == i ? 'selected' : ''}>${i} Квартал</option>`;
    } else if (dashPeriodType === 'month') {
        const months = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
        months.forEach((m, i) => valOptions += `<option value="${i + 1}" ${dashPeriodValue == i + 1 ? 'selected' : ''}>${m}</option>`);
    }

    let yearOptions = '';
    const currentY = new Date().getFullYear();
    for (let y = currentY - 2; y <= currentY + 1; y++) yearOptions += `<option value="${y}" ${dashYear == y ? 'selected' : ''}>${y} год</option>`;

    let activeInputHtml = '';
    if (dashPeriodType === 'day') {
        activeInputHtml = `<input type="date" class="input-modern" style="padding: 4px 6px; font-size: 13px; border-radius: 6px; height: 32px; width: 130px;" value="${dashSpecificDate}" onchange="applyDashPeriod('date', this.value)">`;
    } else if (dashPeriodType !== 'all' && dashPeriodType !== 'year' && dashPeriodType !== 'week') {
        activeInputHtml = `<select class="input-modern" style="padding: 4px 6px; font-size: 13px; border-radius: 6px; height: 32px;" onchange="applyDashPeriod('value', this.value)">${valOptions}</select>`;
    }

    let yearHtml = '';
    if (dashPeriodType !== 'day' && dashPeriodType !== 'week' && dashPeriodType !== 'all') {
        yearHtml = `<select class="input-modern" style="padding: 4px 6px; font-size: 13px; border-radius: 6px; height: 32px;" onchange="applyDashPeriod('year', this.value)">${yearOptions}</select>`;
    }

    const html = `
        <select class="input-modern" style="padding: 4px 6px; font-size: 13px; border-radius: 6px; height: 32px;" onchange="applyDashPeriod('type', this.value)">${typeOptions}</select>
        ${activeInputHtml}
        ${yearHtml}
    `;

    document.querySelectorAll('.dash-period-selector').forEach(container => {
        container.innerHTML = html;
        container.style.display = 'flex';
        container.style.gap = '8px';
    });
};

window.applyDashPeriod = function (field, value) {
    if (field === 'type') {
        dashPeriodType = value;
        if (value === 'quarter') dashPeriodValue = Math.floor(new Date().getMonth() / 3) + 1;
        else if (value === 'month') dashPeriodValue = new Date().getMonth() + 1;
    }
    else if (field === 'date') dashSpecificDate = value;
    else if (field === 'value') dashPeriodValue = parseInt(value);
    else if (field === 'year') dashYear = parseInt(value);

    renderDashPeriodUI();
    loadCostConstructor();
};

window.renderDrilldown = function() {
    const container = document.getElementById('cc-panel-' + ccCurrentGroup);
    if (!container || !ccCurrentGroup) return;

    // Стили для анимаций и поиска (добавляем один раз)
    if (!document.getElementById('cc-drilldown-styles')) {
        const style = document.createElement('style');
        style.id = 'cc-drilldown-styles';
        style.textContent = `
            @keyframes fadeInScale { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
            .fade-in-drilldown { animation: fadeInScale 0.25s ease-out forwards; }
            .highlight-match { background: #fef08a; color: #854d0e; padding: 0 2px; border-radius: 2px; font-weight: bold; }
        `;
        document.head.appendChild(style);
    }

    const highlightText = (text, query) => {
        if (!query || !text) return text || '';
        const regex = new RegExp(`(${query})`, 'gi');
        return String(text).replace(regex, '<mark class="highlight-match">$1</mark>');
    };

    let html = '';
    const groupData = ccGroupedExpenses[ccCurrentGroup] || [];
    const groupTotal = groupData.reduce((sum, cat) => sum + cat.total, 0);

    // Цвета групп
    const colors = { direct: 'var(--success)', opex: 'var(--warning)', capex: 'var(--primary)' };
    const groupColor = colors[ccCurrentGroup] || 'var(--text-main)';

    if (!ccCurrentCategory) {
        // Рендер КАТЕГОРИЙ
        groupData.forEach((cat, index) => {
            let match = cat.name.toLowerCase().includes(ccSearchQuery);
            if (!match && ccSearchQuery) {
                match = cat.transactions.some(t => 
                    (t.description || '').toLowerCase().includes(ccSearchQuery) || 
                    (t.counterparty || '').toLowerCase().includes(ccSearchQuery) ||
                    t.amount.toString().includes(ccSearchQuery)
                );
            }
            if (ccSearchQuery && !match) return;

            const pct = groupTotal > 0 ? ((cat.total / groupTotal) * 100).toFixed(1) : 0;
            const animDelay = index * 0.03;

            html += `
                <div class="fade-in-drilldown hover-row" style="animation-delay: ${animDelay}s; display: flex; justify-content: space-between; align-items: center; padding: 12px 15px; border-bottom: 1px solid var(--surface-hover); cursor: pointer; transition: 0.2s;" 
                     onclick="openCostCategory('${cat.name.replace(/'/g, "\\'")}')">
                    <div style="font-weight: 500;">
                        <span style="color: ${groupColor}; margin-right: 5px;">📁</span> 
                        ${highlightText(cat.name, ccSearchQuery)} 
                        <span class="text-muted" style="font-size: 11px; margin-left: 5px;">— ${pct}% от группы (${cat.transactions.length} тр.)</span>
                    </div>
                    <div style="display: flex; align-items: center; gap: 10px;">
                        <div style="font-weight: bold; color: ${groupColor};">${fmtRub(cat.total)} ₽</div>
                        <button class="btn btn-outline" style="padding: 4px 8px; font-size: 11px;" data-ids="${cat.transactions.filter(t => t.id !== 'virt_salary').map(t => t.id).join(',')}" data-group="${ccCurrentGroup}" onclick="event.stopPropagation(); renameFolder(this)" title="Переименовать папку">✏️</button>
                        <button class="btn btn-outline" style="padding: 4px 8px; font-size: 11px;" data-ids="${cat.transactions.filter(t => t.id !== 'virt_salary').map(t => t.id).join(',')}" onclick="event.stopPropagation(); moveFolderCategory(this)" title="Перенести всю папку в другую группу">🔄</button>
                        <span style="color: var(--text-muted);">➔</span>
                    </div>
                </div>
            `;
        });
        if (!html) html = '<div class="text-muted fade-in-drilldown" style="padding: 20px; text-align: center;">Ничего не найдено</div>';
    } else {
        // Рендер ТРАНЗАКЦИЙ
        const catObj = groupData.find(c => c.name === ccCurrentCategory);
        if (catObj) {
            catObj.transactions.forEach((t, index) => {
                if (ccSearchQuery) {
                    const match = (t.description || '').toLowerCase().includes(ccSearchQuery) || 
                                  (t.counterparty || '').toLowerCase().includes(ccSearchQuery) ||
                                  t.amount.toString().includes(ccSearchQuery);
                    if (!match) return;
                }

                const animDelay = index * 0.02;
                const isReal = t.id !== 'virt_salary';

                html += `
                    <div class="fade-in-drilldown" style="animation-delay: ${animDelay}s; display: flex; justify-content: space-between; align-items: center; padding: 12px 15px; border-bottom: 1px dashed var(--border);">
                        <div style="display: flex; align-items: center; gap: 10px;">
                            ${isReal ? `<input type="checkbox" class="tx-select-checkbox" value="${t.id}" onclick="event.stopPropagation(); updateBulkSelectBtn(this)" style="width: 16px; height: 16px; cursor: pointer; accent-color: ${groupColor};">` : '<div style="width: 16px;"></div>'}
                            <div>
                                <div style="font-size: 13px; font-weight: 500; color: ${groupColor};">${highlightText(t.counterparty || 'Без контрагента', ccSearchQuery)}</div>
                                <div style="font-size: 11px; color: var(--text-muted);">${t.date} | ${highlightText(t.description || 'Нет описания', ccSearchQuery)}</div>
                            </div>
                        </div>
                        <div style="display: flex; align-items: center; gap: 15px;">
                            <div style="font-weight: bold;">${highlightText(fmtRub(t.amount), ccSearchQuery)} ₽</div>
                            ${isReal ? `<button class="btn btn-outline" style="padding: 4px 8px; font-size: 11px;" onclick="moveTransaction(${t.id})" title="Сменить категорию">🔄</button>` : ''}
                        </div>
                    </div>
                `;
            });
        }
        if (!html) html = '<div class="text-muted fade-in-drilldown" style="padding: 20px; text-align: center;">Ничего не найдено</div>';

        // Панель массового действия (по умолчанию скрыта)
        const bulkBar = `
            <div class="bulk-select-bar" style="display: none; position: sticky; bottom: 0; background: var(--surface); border-top: 2px solid var(--primary); padding: 10px 15px; justify-content: space-between; align-items: center; gap: 10px; z-index: 5;">
                <label style="cursor: pointer; display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-muted);">
                    <input type="checkbox" class="bulk-select-all-cb" onclick="toggleAllCheckboxes(this)" style="width: 16px; height: 16px; cursor: pointer;">
                    Выбрать все
                </label>
                <div style="display: flex; align-items: center; gap: 10px;">
                    <span class="bulk-select-count" style="font-size: 12px; color: var(--text-muted);"></span>
                    <button class="btn btn-blue" style="padding: 6px 14px; font-size: 13px;" onclick="moveSelectedTransactions(this)">🔄 Перенести выбранные</button>
                </div>
            </div>
        `;
        // Оборачиваем список транзакций в скроллируемый контейнер
        html = `<div class="folder-tx-wrapper" style="max-height: 420px; overflow-y: auto; position: relative;">${html}${bulkBar}</div>`;
    }

    container.innerHTML = html;
};

// === ГРУППОВОЙ ПЕРЕНОС ГАЛОЧКАМИ ===
window.updateBulkSelectBtn = function(element) {
    // Ищем ближайший wrapper от кликнутого чекбокса
    const wrapper = element ? element.closest('.folder-tx-wrapper') : null;
    if (!wrapper) return;
    const checkedBoxes = wrapper.querySelectorAll('.tx-select-checkbox:checked');
    const bar = wrapper.querySelector('.bulk-select-bar');
    if (!bar) return;
    if (checkedBoxes.length > 0) {
        bar.style.display = 'flex';
        const countEl = bar.querySelector('.bulk-select-count');
        if (countEl) countEl.textContent = 'Выбрано: ' + checkedBoxes.length;
    } else {
        bar.style.display = 'none';
        const selectAllCb = bar.querySelector('.bulk-select-all-cb');
        if (selectAllCb) selectAllCb.checked = false;
    }
};

window.toggleAllCheckboxes = function(selectAllCb) {
    const wrapper = selectAllCb.closest('.folder-tx-wrapper');
    if (!wrapper) return;
    const isChecked = selectAllCb.checked;
    wrapper.querySelectorAll('.tx-select-checkbox').forEach(function(cb) { cb.checked = isChecked; });
    updateBulkSelectBtn(selectAllCb);
};

window.moveSelectedTransactions = function(btnElement) {
    // Ищем wrapper от кнопки или берем все отмеченные на странице
    const wrapper = btnElement ? btnElement.closest('.folder-tx-wrapper') : document;
    var checked = wrapper.querySelectorAll('.tx-select-checkbox:checked');
    var selectedIds = [];
    checked.forEach(function(cb) { var n = Number(cb.value); if (n > 0) selectedIds.push(n); });
    if (selectedIds.length === 0) return UI.toast('Отметьте хотя бы одну транзакцию', 'warning');

    // Сохраняем ID в глобальную переменную, которую читает executeRenameFolder
    ccRenameIds = selectedIds;
    ccRenameGroup = ccCurrentGroup || 'opex';

    // Собираем все существующие имена папок для select
    var allNames = [];
    ['direct', 'opex', 'capex'].forEach(function(grp) {
        (ccGroupedExpenses[grp] || []).forEach(function(cat) { allNames.push(cat.name); });
    });
    var uniqueNames = allNames.filter(function(v, i, a) { return a.indexOf(v) === i; }).sort();
    var selectOptions = '<option value="">-- Ввести новое название ниже --</option>';
    uniqueNames.forEach(function(n) {
        selectOptions += '<option value="' + n.replace(/"/g, '&quot;') + '">' + n + '</option>';
    });

    var modalHtml = '<div style="display: flex; flex-direction: column; gap: 15px;">' +
        '<div style="font-weight: bold; font-size: 13px;">Выбрано транзакций: <span style="color: var(--primary);">' + selectedIds.length + ' шт.</span></div>' +

        '<div class="form-group" style="margin: 0;">' +
            '<label style="font-weight: 600; margin-bottom: 4px; display: block;">Переместить в существующую папку:</label>' +
            '<select id="renameExistingSelect" class="input-modern" style="font-size: 14px; padding: 10px;">' + selectOptions + '</select>' +
        '</div>' +

        '<div class="form-group" style="margin: 0;">' +
            '<label style="font-weight: 600; margin-bottom: 4px; display: block;">Или создать новую папку:</label>' +
            '<input type="text" id="renameNameInput" class="input-modern" style="font-size: 14px; padding: 10px; font-weight: 600;" placeholder="Например: Канцтовары...">' +
        '</div>' +

        '<div class="form-group" style="margin: 0;">' +
            '<label style="font-weight: 600; margin-bottom: 4px; display: block;">Группа для новой категории:</label>' +
            '<select id="rename-folder-group" class="input-modern" style="font-size: 13px; padding: 8px;">' +
                '<option value="direct"' + (ccRenameGroup === 'direct' ? ' selected' : '') + '>🟢 Прямые (COGS)</option>' +
                '<option value="opex"' + (ccRenameGroup === 'opex' ? ' selected' : '') + '>🟠 Косвенные (OPEX)</option>' +
                '<option value="capex"' + (ccRenameGroup === 'capex' ? ' selected' : '') + '>🟣 Капитал (CAPEX)</option>' +
            '</select>' +
        '</div>' +
    '</div>';

    UI.showModal('🔄 Перемещение / Переименование', modalHtml,
        '<button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>' +
        '<button class="btn btn-blue" onclick="executeRenameFolder()">Сохранить</button>'
    );

    // Слушатель: при выборе из select — заполнить input
    setTimeout(function() {
        var sel = document.getElementById('renameExistingSelect');
        if (sel) {
            sel.addEventListener('change', function(e) {
                var inp = document.getElementById('renameNameInput');
                if (inp && e.target.value) inp.value = e.target.value;
            });
        }
    }, 50);
};

window.moveTransaction = async function(txId) {
    try {
        const html = `
            <div class="form-group">
                <label>Выберите новую группу (перенос):</label>
                <select id="move-cat-select" class="input-modern" style="font-size: 14px; padding: 10px;">
                    <option value="" selected>Автоматически (По матрице)</option>
                    <option value="direct">🟢 Прямые (COGS)</option>
                    <option value="overhead">🟠 Косвенные (OPEX)</option>
                    <option value="capital">🟣 Капитал (CAPEX)</option>
                </select>
            </div>
        `;

        UI.showModal('🔄 Смена группы (Перенос)', html, `
            <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
            <button class="btn btn-blue" onclick="executeMoveTransaction(${txId})">Подтвердить</button>
        `);

    } catch (e) {
        console.error(e);
        UI.toast('Ошибка открытия окна', 'error');
    }
};

window.executeMoveTransaction = async function(txId) {
    const sel = document.getElementById('move-cat-select');
    if (!sel) return;
    
    const newCategory = sel.value;
    
    // ШАГ 1: Сохраняем состояние UI ДО отправки
    const savedGroup = ccCurrentGroup;
    const savedCategory = ccCurrentCategory;
    
    try {
        // ШАГ 2: Отправляем fetch
        const response = await fetch(`/api/transactions/${txId}/override`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cost_group_override: newCategory || null })
        });
        
        if (!response.ok) throw new Error('Ошибка обновления');
        
        UI.toast('Транзакция успешно перенесена', 'success');
        UI.closeModal();
        
        // ШАГ 3: Перезагружаем данные (loadCostConstructor вызовет closeCostTabs внутри)
        await loadCostConstructor();
        
        // ШАГ 4: Восстанавливаем состояние UI
        const tabIndexMap = { direct: 0, opex: 1, capex: 2 };
        if (savedGroup && tabIndexMap[savedGroup] !== undefined) {
            switchCostTab(savedGroup, tabIndexMap[savedGroup]);
            if (savedCategory) openCostCategory(savedCategory);
        }
        
    } catch(err) {
        console.error(err);
        UI.toast(err.message, 'error');
    }
};

let ccCurrentFolderIds = [];

window.moveFolderCategory = function(btnElement) {
    try {
        const idsStr = btnElement.getAttribute('data-ids') || '';
        ccCurrentFolderIds = idsStr.split(',').map(Number).filter(n => !isNaN(n) && n > 0);
        
        if (ccCurrentFolderIds.length === 0) {
            return UI.toast('В этой папке нет реальных транзакций для переноса', 'warning');
        }

        const html = `
            <div class="form-group">
                <label style="font-weight: bold; margin-bottom: 8px; display: block;">Транзакций для переноса: <span style="color: var(--primary);">${ccCurrentFolderIds.length} шт.</span></label>
                <label>Перенести ВСЕ транзакции этой папки в группу:</label>
                <select id="move-folder-select" class="input-modern" style="font-size: 14px; padding: 10px;">
                    <option value="" selected>Автоматически (По матрице)</option>
                    <option value="direct">🟢 Прямые (COGS)</option>
                    <option value="overhead">🟠 Косвенные (OPEX)</option>
                    <option value="capital">🟣 Капитал (CAPEX)</option>
                </select>
            </div>
        `;

        UI.showModal('🔄 Массовый перенос папки', html, `
            <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
            <button class="btn btn-blue" onclick="executeMoveFolder()">Подтвердить</button>
        `);
    } catch (e) {
        console.error(e);
        UI.toast('Ошибка открытия окна', 'error');
    }
};

window.executeMoveFolder = async function() {
    const sel = document.getElementById('move-folder-select');
    if (!sel) return;
    if (ccCurrentFolderIds.length === 0) return UI.toast('Нет ID для переноса', 'error');

    // ШАГ 1: Сохраняем состояние UI ДО отправки
    const savedGroup = ccCurrentGroup;

    try {
        // ШАГ 2: Отправляем fetch с массивом ID
        const response = await fetch('/api/transactions/bulk-override', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ transactionIds: ccCurrentFolderIds, cost_group_override: sel.value || null })
        });

        if (!response.ok) throw new Error('Ошибка обновления');
        const data = await response.json();

        UI.toast(`Перенесено ${data.updated} транзакций`, 'success');
        UI.closeModal();
        ccCurrentFolderIds = [];

        // ШАГ 3: Перезагружаем данные
        await loadCostConstructor();

        // ШАГ 4: Восстанавливаем состояние — возвращаемся к списку папок в той же группе
        const tabIndexMap = { direct: 0, opex: 1, capex: 2 };
        if (savedGroup && tabIndexMap[savedGroup] !== undefined) {
            switchCostTab(savedGroup, tabIndexMap[savedGroup]);
        }
        
    } catch(err) {
        console.error(err);
        UI.toast(err.message, 'error');
    }
};

// === ПЕРЕИМЕНОВАНИЕ ПАПКИ ===
let ccRenameIds = [];
let ccRenameGroup = 'opex';

window.renameFolder = function(btnElement) {
    try {
        var idsStr = btnElement.getAttribute('data-ids') || '';
        ccRenameIds = idsStr.split(',').map(Number).filter(function(n) { return !isNaN(n) && n > 0; });
        ccRenameGroup = btnElement.getAttribute('data-group') || 'opex';

        if (ccRenameIds.length === 0) {
            return UI.toast('В этой папке нет реальных транзакций', 'warning');
        }

        // Собираем все существующие имена папок для select
        var allNames = [];
        ['direct', 'opex', 'capex'].forEach(function(grp) {
            (ccGroupedExpenses[grp] || []).forEach(function(cat) { allNames.push(cat.name); });
        });
        var uniqueNames = allNames.filter(function(v, i, a) { return a.indexOf(v) === i; }).sort();
        var selectOptions = '<option value="">-- Ввести новое название ниже --</option>';
        uniqueNames.forEach(function(n) {
            selectOptions += '<option value="' + n.replace(/"/g, '&quot;') + '">' + n + '</option>';
        });

        var modalHtml = '<div style="display: flex; flex-direction: column; gap: 15px;">' +
            '<div style="font-weight: bold; font-size: 13px;">Транзакций: <span style="color: var(--primary);">' + ccRenameIds.length + ' шт.</span></div>' +

            '<div class="form-group" style="margin: 0;">' +
                '<label style="font-weight: 600; margin-bottom: 4px; display: block;">Выберите существующую папку (для объединения):</label>' +
                '<select id="renameExistingSelect" class="input-modern" style="font-size: 14px; padding: 10px;">' + selectOptions + '</select>' +
            '</div>' +

            '<div class="form-group" style="margin: 0;">' +
                '<label style="font-weight: 600; margin-bottom: 4px; display: block;">Или введите новое название:</label>' +
                '<input type="text" id="renameNameInput" class="input-modern" style="font-size: 14px; padding: 10px; font-weight: 600;" placeholder="Например: Канцтовары...">' +
            '</div>' +

            '<div class="form-group" style="margin: 0;">' +
                '<label style="font-weight: 600; margin-bottom: 4px; display: block;">Группа для новой категории:</label>' +
                '<select id="rename-folder-group" class="input-modern" style="font-size: 13px; padding: 8px;">' +
                    '<option value="direct"' + (ccRenameGroup === 'direct' ? ' selected' : '') + '>🟢 Прямые (COGS)</option>' +
                    '<option value="opex"' + (ccRenameGroup === 'opex' ? ' selected' : '') + '>🟠 Косвенные (OPEX)</option>' +
                    '<option value="capex"' + (ccRenameGroup === 'capex' ? ' selected' : '') + '>🟣 Капитал (CAPEX)</option>' +
                '</select>' +
            '</div>' +
        '</div>';

        UI.showModal('✏️ Переименование папки', modalHtml,
            '<button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>' +
            '<button class="btn btn-blue" onclick="executeRenameFolder()">Сохранить</button>'
        );

        // Слушатель: при выборе из select — заполнить input
        setTimeout(function() {
            var sel = document.getElementById('renameExistingSelect');
            if (sel) {
                sel.addEventListener('change', function(e) {
                    var inp = document.getElementById('renameNameInput');
                    if (inp && e.target.value) inp.value = e.target.value;
                });
            }
        }, 50);
    } catch (e) {
        console.error(e);
        UI.toast('Ошибка открытия окна', 'error');
    }
};

window.executeRenameFolder = async function() {
    var input = document.getElementById('renameNameInput');
    var groupSel = document.getElementById('rename-folder-group');
    if (!input || !input.value.trim()) return UI.toast('Введите или выберите имя категории', 'warning');
    if (ccRenameIds.length === 0) return UI.toast('Нет ID для переименования', 'error');

    var savedGroup = ccCurrentGroup;

    try {
        var response = await fetch('/api/transactions/bulk-rename', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                transactionIds: ccRenameIds,
                newCategoryName: input.value.trim(),
                costGroup: groupSel ? groupSel.value : ccRenameGroup
            })
        });

        if (!response.ok) throw new Error('Ошибка переименования');
        var data = await response.json();

        UI.toast('Переименовано ' + data.updated + ' транзакций', 'success');
        UI.closeModal();
        ccRenameIds = [];

        await loadCostConstructor();

        var tabIndexMap = { direct: 0, opex: 1, capex: 2 };
        if (savedGroup && tabIndexMap[savedGroup] !== undefined) {
            switchCostTab(savedGroup, tabIndexMap[savedGroup]);
        }
    } catch(err) {
        console.error(err);
        UI.toast(err.message, 'error');
    }
};

// Динамический пересчет UI при вводе цифр
window.recalcOverheadUI = function () {
    const exp = parseFloat(document.getElementById('set-monthly-exp').value) || 0;
    const days = parseFloat(document.getElementById('set-month-days').value) || 0;
    const cycles = parseFloat(document.getElementById('set-shift-cycles').value) || 0;

    const totalCycles = days * cycles;
    const costPerCycle = totalCycles > 0 ? (exp / totalCycles) : 0;

    document.getElementById('res-overhead-formula').innerText =
        `${exp.toLocaleString('ru-RU')} ₽ / (${days} дн × ${cycles} ц) = ${totalCycles.toLocaleString('ru-RU')} циклов`;

    document.getElementById('res-overhead-cycle').innerText =
        costPerCycle.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₽';

    // Сохраняем в глобальную переменную для использования при сохранении
    window.CURRENT_OVERHEAD_PER_CYCLE = costPerCycle;
};

// Загрузка настроек из БД
async function loadFinanceSettings() {
    try {
        const res = await fetch('/api/settings/finance');
        if (res.ok) {
            const data = await res.json();

            // 🚀 ИСПРАВЛЕНИЕ: Возвращаем сохранение налога в память браузера!
            window.FINANCE_TAX_PERCENT = parseFloat(data.sales_tax) || 6;

            if (document.getElementById('set-sales-tax')) {
                document.getElementById('set-sales-tax').value = data.sales_tax || 6;
                document.getElementById('set-monthly-exp').value = data.monthly_expenses || 1500000;
                document.getElementById('set-month-days').value = data.working_days || 22;
                document.getElementById('set-shift-cycles').value = data.cycles_per_shift || 500;

                // Вызываем пересчет, чтобы обновить красивые цифры и формулу
                recalcOverheadUI();
            }
        }
    } catch (e) { console.error("Ошибка загрузки финансовых настроек", e); }
}

// Сохранение настроек в БД
window.saveFinanceSettings = async function () {
    const taxVal = document.getElementById('set-sales-tax').value;
    const payload = {
        sales_tax: taxVal,
        monthly_expenses: document.getElementById('set-monthly-exp').value,
        working_days: document.getElementById('set-month-days').value,
        cycles_per_shift: document.getElementById('set-shift-cycles').value,
        overhead_per_cycle: window.CURRENT_OVERHEAD_PER_CYCLE
    };

    try {
        const res = await fetch('/api/settings/finance', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (res.ok) {
            // 🚀 ИСПРАВЛЕНИЕ: Мгновенно обновляем память при сохранении
            window.FINANCE_TAX_PERCENT = parseFloat(taxVal) || 6;
            UI.toast('✅ Финансовая модель утверждена!', 'success');
        } else {
            UI.toast('Ошибка при сохранении', 'error');
        }
    } catch (e) {
        console.error(e);
        UI.toast('Ошибка связи с сервером', 'error');
    }
};

// =================================================================
// 🛒 MRP: АНАЛИЗ ДЕФИЦИТА СЫРЬЯ
// =================================================================
window.openMrpPanel = async function () {
    UI.toast('⏳ Анализ дефицита и планов производства...', 'info');

    try {
        const res = await fetch('/api/production/mrp-summary');
        const data = await res.json();

        if (!data.success) throw new Error('Ошибка на сервере');

        let deficitHtml = '';
        let okHtml = '';
        let totalShortageItems = 0;

        // Сортируем: сначала дефицит, потом то, чего хватает
        data.deficitReport.sort((a, b) => parseFloat(b.shortage) - parseFloat(a.shortage)).forEach(d => {
            const shortage = parseFloat(d.shortage);
            if (shortage > 0) {
                totalShortageItems++;
                deficitHtml += `
                    <tr style="background: var(--danger-bg);">
                        <td style="padding: 12px 10px; border-bottom: 1px solid var(--danger-border);"><b>${d.name}</b></td>
                        <td style="padding: 12px 10px; border-bottom: 1px solid var(--danger-border); text-align: center; color: var(--text-muted);">${d.stock} ${d.unit}</td>
                        <td style="padding: 12px 10px; border-bottom: 1px solid var(--danger-border); text-align: center; font-weight: bold;">${d.needed} ${d.unit}</td>
                        <td style="padding: 12px 10px; border-bottom: 1px solid var(--danger-border); text-align: right; color: var(--danger-text); font-weight: 900; font-size: 14px;">-${shortage.toLocaleString('ru-RU')} ${d.unit}</td>
                    </tr>
                `;
            } else {
                okHtml += `
                    <tr style="opacity: 0.8;">
                        <td style="padding: 10px; border-bottom: 1px solid var(--border);"><b>${d.name}</b></td>
                        <td style="padding: 10px; border-bottom: 1px solid var(--border); text-align: center;">${d.stock} ${d.unit}</td>
                        <td style="padding: 10px; border-bottom: 1px solid var(--border); text-align: center;">${d.needed} ${d.unit}</td>
                        <td style="padding: 10px; border-bottom: 1px solid var(--border); text-align: right; color: var(--success-text); font-weight: bold;">Хватает ✅</td>
                    </tr>
                `;
            }
        });

        const alertBlock = totalShortageItems > 0
            ? `<div style="background: var(--danger-bg); border: 1px solid var(--danger-border); padding: 15px; border-radius: 8px; margin-bottom: 20px; color: var(--danger-text);">
                 <h4 style="margin: 0 0 5px 0;">⚠️ Внимание, угроза простоев!</h4>
                 <p style="margin: 0; font-size: 13px;">Для выполнения текущих заказов клиентов не хватает <b>${totalShortageItems}</b> позиций сырья. Срочно передайте заявку в закупки.</p>
               </div>`
            : `<div style="background: var(--success-bg); border: 1px solid var(--success-border); padding: 15px; border-radius: 8px; margin-bottom: 20px; color: var(--success-text);">
                 <h4 style="margin: 0 0 5px 0;">✅ Склад обеспечен</h4>
                 <p style="margin: 0; font-size: 13px;">Сырья достаточно для выполнения всех активных заказов.</p>
               </div>`;

        const html = `
            <style>#app-modal .modal-content { max-width: 800px !important; width: 95% !important; }</style>
            <div style="padding: 10px;">
                ${alertBlock}
                
                <table style="width: 100%; border-collapse: collapse; font-size: 13px; box-shadow: 0 1px 3px var(--shadow-sm); border-radius: 8px; overflow: hidden;">
                    <thead style="background: var(--surface-hover); text-transform: uppercase; font-size: 11px; letter-spacing: 1px;">
                        <tr>
                            <th style="padding: 12px 10px; text-align: left; color: var(--text-muted);">Материал</th>
                            <th style="padding: 12px 10px; text-align: center; color: var(--text-muted);">Остаток на складе</th>
                            <th style="padding: 12px 10px; text-align: center; color: var(--primary);">Нужно на заказы</th>
                            <th style="padding: 12px 10px; text-align: right; color: var(--text-muted);">Дефицит</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${deficitHtml}
                        ${okHtml}
                        ${!deficitHtml && !okHtml ? '<tr><td colspan="4" style="text-align:center; padding: 20px;">Нет активных заказов или рецептов</td></tr>' : ''}
                    </tbody>
                </table>
            </div>
        `;

        UI.showModal('🛒 Сводный дефицит сырья (MRP)', html, `<button class="btn btn-blue w-100" onclick="UI.closeModal()">Закрыть панель</button>`);
    } catch (e) {
        console.error(e);
        UI.toast('Ошибка загрузки данных', 'error');
    }
};

// Автоматическая проверка дефицита сырья для кнопки
window.checkMrpStatus = async function (isSilent = false) {
    const btn = document.getElementById('btn-mrp-status');
    if (!btn) return;

    try {
        const res = await fetch('/api/production/mrp-summary');
        const data = await res.json();

        if (data.success) {
            // Ищем, есть ли хоть одна позиция, где shortage > 0
            const hasDeficit = data.deficitReport.some(d => parseFloat(d.shortage) > 0);

            if (hasDeficit) {
                btn.className = 'btn';
                btn.style.background = 'var(--danger)';
                btn.style.borderColor = 'var(--danger)';
                btn.style.color = '#fff';
                btn.innerHTML = '⚠️ Есть дефицит (MRP)';
            } else {
                btn.className = 'btn';
                btn.style.background = 'var(--success)';
                btn.style.borderColor = 'var(--success)';
                btn.style.color = '#fff';
                btn.innerHTML = '✅ Склад обеспечен (MRP)';
            }
            
            if (!isSilent && typeof openMrpPanel === 'function') {
                openMrpPanel();
            }
        }
    } catch (e) {
        console.error('Ошибка фоновой проверки MRP', e);
        btn.innerHTML = '🛒 Проверить дефицит (MRP)';
    }
};

// ==========================================
// 🎛️ МАТРИЦА СТАТЕЙ: РАСПРЕДЕЛЕНИЕ КАТЕГОРИЙ
// ==========================================
window.openCategoryMatrix = async function () {
    UI.toast('⏳ Загрузка матрицы...', 'info');
    try {
        const res = await fetch('/api/finance/categories');
        const categories = await res.json();

        const groups = {
            direct: categories.filter(c => c.cost_group === 'direct'),
            overhead: categories.filter(c => c.cost_group === 'overhead' || !c.cost_group), // overhead по умолчанию
            capital: categories.filter(c => c.cost_group === 'capital')
        };

        const renderCol = (title, color, desc, items) => `
            <div style="background: var(--surface-alt); border-top: 4px solid ${color}; border-radius: 8px; padding: 15px; box-shadow: 0 2px 4px var(--shadow-sm);">
                <h4 style="margin: 0 0 5px 0; color: ${color}; font-size: 14px;">${title}</h4>
                <p style="font-size: 11px; color: var(--text-muted); margin: 0 0 15px 0; min-height: 34px;">${desc}</p>
                <div style="display: flex; flex-direction: column; gap: 8px;">
                    ${items.map(c => `
                        <div style="background: var(--surface); border: 1px solid var(--border); padding: 8px 10px; border-radius: 6px; display: flex; justify-content: space-between; align-items: center; gap: 10px;">
                            <div style="font-size: 12px; font-weight: 500; line-height: 1.2;">
                                ${c.name}
                                <div style="font-size: 9px; color: var(--text-muted); margin-top: 2px;">${c.type === 'income' ? 'Доход' : 'Расход'}</div>
                            </div>
                            <select class="input-modern matrix-cat-select" data-id="${c.id}" style="padding: 2px 5px; font-size: 11px; height: 24px; width: 110px; cursor: pointer;">
                                <option value="direct" ${c.cost_group === 'direct' ? 'selected' : ''}>В Прямые</option>
                                <option value="overhead" ${c.cost_group === 'overhead' || !c.cost_group ? 'selected' : ''}>В Оверхед</option>
                                <option value="capital" ${c.cost_group === 'capital' ? 'selected' : ''}>В Капитал</option>
                            </select>
                        </div>
                    `).join('')}
                    ${items.length === 0 ? `<div style="text-align: center; color: var(--text-muted); font-size: 11px; padding: 10px;">Пусто</div>` : ''}
                </div>
            </div>
        `;

        const html = `
            <style>#app-modal .modal-content { max-width: 900px !important; width: 95% !important; }</style>
            <div class="form-grid" style="grid-template-columns: repeat(3, 1fr); gap: 15px; align-items: start;">
                ${renderCol('🟢 Прямые (COGS)', 'var(--success)', 'Сырье, доставка сырья. Участвуют только в калькуляторе одной плитки.', groups.direct)}
                ${renderCol('🟠 Косвенные (Оверхед)', 'var(--warning)', 'Аренда, налоги, ЗП ИТР. Делятся на удары пресса, формируя стоимость цикла.', groups.overhead)}
                ${renderCol('🟣 Капитал / Скрытые', '#8b5cf6', 'Личные покупки, кредиты, переводы. НЕ попадают в себестоимость вообще.', groups.capital)}
            </div>
        `;

        UI.showModal('🎛️ Матрица статей управленческого учета', html, `<button class="btn btn-blue w-100" onclick="UI.closeModal(); loadCostConstructor();">Закрыть и пересчитать Дашборд</button>`);

        // 🚀 Инициализация TomSelect для динамических строк матрицы
        setTimeout(() => {
            document.querySelectorAll('.matrix-cat-select').forEach(el => {
                if (!el.tomselect) {
                    new TomSelect(el, {
                        dropdownParent: 'body',
                        onChange: function(value) {
                            const catId = this.input.getAttribute('data-id');
                            updateCategoryGroup(catId, value);
                        }
                    });
                }
            });
        }, 50);
    } catch (e) {
        console.error(e);
        UI.toast('Ошибка загрузки', 'error');
    }
};

window.updateCategoryGroup = async function (id, newGroup) {
    try {
        const res = await fetch(`/api/finance/categories/${id}/group`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cost_group: newGroup })
        });
        if (res.ok) {
            // Перерисовываем окно, чтобы карточка визуально перепрыгнула в нужную колонку
            openCategoryMatrix();
        }
    } catch (e) { UI.toast('Ошибка сохранения', 'error'); }
};

window.initDashboard = function() {
    initStaticDashboardSelects();
    if (typeof loadStockValuation === 'function') loadStockValuation();

    // Авто-загрузка при переходе на дашборд
    setTimeout(() => {
        if (typeof checkMrpStatus === 'function') checkMrpStatus(true); // isSilent = true

        const loadBtn = document.querySelector('button[onclick="loadCostConstructor()"]');
        if (loadBtn) loadBtn.click();
    }, 150);
};

window.loadStockValuation = async function() {
    const listEl = document.getElementById('stock-val-list');
    const totalEl = document.getElementById('stock-val-total');
    if (!listEl || !totalEl) return;

    listEl.innerHTML = '<div class="text-muted" style="font-size: 13px;">🔄 Загрузка данных...</div>';

    try {
        const res = await fetch('/api/inventory/valuation');
        if (!res.ok) throw new Error('Ошибка загрузки стоимости складов');
        const data = await res.json();

        const fmt = (val) => Number(val).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        totalEl.innerHTML = `${fmt(data.grand_total)} ₽`;

        if (data.warehouses.length === 0) {
            listEl.innerHTML = '<div class="text-muted" style="font-size: 13px;">Склады пусты</div>';
            return;
        }

        let html = '';
        data.warehouses.forEach((w, index) => {
            const isLast = index === data.warehouses.length - 1;
            const borderStyle = isLast ? '' : 'border-bottom: 1px dashed var(--border);';
            html += `
                <div style="display: flex; justify-content: space-between; align-items: center; padding: 6px 0; ${borderStyle}">
                    <div style="font-size: 14px; color: var(--text-main);">
                        ${w.name} 
                        <span style="font-size: 11px; color: var(--text-muted); margin-left: 5px;" title="Количество уникальных позиций">(${w.items_count} поз.)</span>
                    </div>
                    <div style="font-size: 14px; font-weight: bold; color: var(--text-main);">
                        ${fmt(w.value)} ₽
                    </div>
                </div>
            `;
        });
        listEl.innerHTML = html;

    } catch (e) {
        console.error(e);
        listEl.innerHTML = `<div class="text-danger" style="font-size: 13px;">❌ ${e.message}</div>`;
        totalEl.innerHTML = '0 ₽';
    }
};

function initStaticDashboardSelects() {
    // Задел под будущие фильтры (например, склад/менеджер)
    // ['dash-warehouse-filter'].forEach(id => { ... }) 
}