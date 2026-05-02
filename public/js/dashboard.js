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
    loadDashboardWidgets();
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
            const resCat = await API.get('/api/categories');
            ccAllCategories = resCat;
        } catch (e) { console.error('Ошибка загрузки справочника категорий', e); }
    }

    try {
        const data = await API.post('/api/analytics/cost-constructor', { startDate, endDate });
        currentCycles = data.totalCycles;
        const pieceRateSalary = parseFloat(data.pieceRateSalary) || 0;

        ccGroupedExpenses = data.groupedExpenses || { direct: [], opex: [], capex: [] };

        // 1. Суммы по группам (все значения положительные, т.к. запросы содержат только expense)
        const totalDirect = ccGroupedExpenses.direct.reduce((sum, cat) => sum + cat.total, 0);
        const totalOpex = ccGroupedExpenses.opex.reduce((sum, cat) => sum + cat.total, 0);
        const totalCapex = ccGroupedExpenses.capex.reduce((sum, cat) => sum + cat.total, 0);
        const totalAll = totalDirect + totalOpex + totalCapex;

        // 2. Обновляем плашки с фиксированными цветами, числа без минуса
        const elCogs = document.getElementById('cc-total-cogs');
        if (elCogs) elCogs.innerText = fmtRub(Math.abs(totalDirect)) + ' ₽';

        const elOpex = document.getElementById('cc-total-opex');
        if (elOpex) elOpex.innerText = fmtRub(Math.abs(totalOpex)) + ' ₽';

        const elCapex = document.getElementById('cc-total-capex');
        if (elCapex) elCapex.innerText = fmtRub(Math.abs(totalCapex)) + ' ₽';

        // 3. Проценты
        const totalAbs = Math.abs(totalDirect) + Math.abs(totalOpex) + Math.abs(totalCapex);
        if (totalAbs > 0) {
            const pctCogs = document.getElementById('cc-pct-cogs');
            if (pctCogs) pctCogs.innerText = ((Math.abs(totalDirect) / totalAbs) * 100).toFixed(1);

            const pctOpex = document.getElementById('cc-pct-opex');
            if (pctOpex) pctOpex.innerText = ((Math.abs(totalOpex) / totalAbs) * 100).toFixed(1);

            const pctCapex = document.getElementById('cc-pct-capex');
            if (pctCapex) pctCapex.innerText = ((Math.abs(totalCapex) / totalAbs) * 100).toFixed(1);
        }

        const totalCy = document.getElementById('cc-total-cycles');
        if (totalCy) totalCy.innerText = currentCycles.toLocaleString();

        const totalExpensesEl = document.getElementById('cc-total-expenses');
        if (totalExpensesEl) totalExpensesEl.innerText = fmtRub(Math.abs(totalOpex)) + ' ₽';

        const costPerCycleEl = document.getElementById('cc-cost-per-cycle');
        if (costPerCycleEl) {
            const costPerCycle = currentCycles > 0 ? (Math.abs(totalOpex) / currentCycles) : 0;
            costPerCycleEl.innerText = costPerCycle.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₽';
            window.ACTUAL_OVERHEAD_PER_CYCLE = costPerCycle;
        }

        // 4. КОНТРОЛЬНАЯ СВЕРКА: сумма по трем карточкам = тотальный расход из БД
        const totalRaw = data.totalRawExpenses || 0;

        let warnEl = document.getElementById('cc-balance-warning');
        if (!warnEl) {
            warnEl = document.createElement('div');
            warnEl.id = 'cc-balance-warning';
            const grid = document.querySelector('.cost-triad-grid');
            if (grid) grid.parentNode.insertBefore(warnEl, grid);
        }

        const diff = Math.abs(totalAll - totalRaw);
        if (diff > 0.01) {
            warnEl.innerHTML = `<div class="card mb-20 fade-in-drilldown dash-warn-card">
                🔴 <b>ВНИМАНИЕ! Расхождение: ${fmtRub(diff)} ₽.</b> Дашборд не совпадает с реестром транзакций.<br>
                <small>БД: ${fmtRub(totalRaw)} ₽ / Дашборд: ${fmtRub(totalAll)} ₽</small>
            </div>`;
        } else {
            warnEl.innerHTML = `<div class="card mb-20 fade-in-drilldown dash-success-card">
                🟢 <b>Капитализация (Остаток): ${fmtRub(Math.abs(totalAll))} ₽. Баланс с кассой сошёлся.</b>
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
}; window.switchCostTab = function (groupId, tabIndex) {
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
            wrapper.style.setProperty('--dash-drill-border', 'transparent');
        }
        if (gridContainer) {
            gridContainer.classList.remove('active-drilldown');
            gridContainer.style.removeProperty('--active-border-color');
        }
        document.querySelectorAll('.dash-drill-panel-card').forEach((pc) => pc.style.removeProperty('--dash-panel-accent'));
        container.style.setProperty('--dash-tab-offset', '0%');
        ccCurrentGroup = null;
        ccCurrentCategory = null;
        return;
    }

    // Иначе разворачиваем и переключаем
    document.querySelectorAll('.dashboard-tabs-nav .card').forEach(c => c.classList.remove('tab-active'));
    tabEl.classList.add('tab-active');

    container.classList.remove('collapsed-panel');
    const offset = -(tabIndex * 33.333333);
    container.style.setProperty('--dash-tab-offset', `${offset}%`);

    // 🎨 Цветовая синхронизация: переменная границы контейнера + панелей
    const color = tabColors[groupId];
    if (wrapper) {
        wrapper.style.setProperty('--dash-drill-border', color);
    }

    if (gridContainer) {
        gridContainer.classList.add('active-drilldown');
        gridContainer.style.setProperty('--active-border-color', color);
    }

    document.querySelectorAll('.dash-drill-panel-card').forEach((panelCard) => {
        panelCard.style.setProperty('--dash-panel-accent', color);
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

window.closeCostTabs = function () {
    const container = document.getElementById('dashboard-tabs-content');
    if (container) {
        container.classList.add('collapsed-panel');
        const wrap = container.parentElement;
        if (wrap) {
            wrap.style.setProperty('--dash-drill-border', 'transparent');
        }
    }
    const gridContainer = document.querySelector('.cost-triad-grid');
    if (gridContainer) {
        gridContainer.classList.remove('active-drilldown');
        gridContainer.style.removeProperty('--active-border-color');
    }

    document.querySelectorAll('.dash-drill-panel-card').forEach((pc) => pc.style.removeProperty('--dash-panel-accent'));
    if (container) {
        container.style.setProperty('--dash-tab-offset', '0%');
    }

    document.querySelectorAll('.dashboard-tabs-nav .card').forEach(c => c.classList.remove('tab-active'));
    ccCurrentGroup = null;
    ccCurrentCategory = null;
};

window.closeCostCategory = function () {
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

window.openCostCategory = function (catName) {
    ccCurrentCategory = catName;
    const titleEl = document.getElementById('drill-title-' + ccCurrentGroup);
    if (titleEl) titleEl.innerText = '🧾 Транзакции: ' + catName;
    renderDrilldown();
};

window.openDashboardCategory = function(categoryName) {
    const target = String(categoryName || '').trim();
    if (!target) return;
    const norm = target.toLowerCase();
    const groups = ['direct', 'opex', 'capex'];
    let foundGroup = null;

    for (const group of groups) {
        const list = Array.isArray(ccGroupedExpenses[group]) ? ccGroupedExpenses[group] : [];
        const hit = list.some((cat) => String(cat?.name || '').trim().toLowerCase() === norm);
        if (hit) {
            foundGroup = group;
            break;
        }
    }

    if (!foundGroup) {
        for (const group of groups) {
            const list = Array.isArray(ccGroupedExpenses[group]) ? ccGroupedExpenses[group] : [];
            const hit = list.some((cat) => String(cat?.name || '').trim().toLowerCase().includes(norm));
            if (hit) {
                foundGroup = group;
                break;
            }
        }
    }

    if (!foundGroup) foundGroup = 'opex';
    const tabIndexMap = { direct: 0, opex: 1, capex: 2 };
    if (typeof window.switchCostTab === 'function') {
        window.switchCostTab(foundGroup, tabIndexMap[foundGroup] ?? 1);
    }
    setTimeout(() => {
        if (typeof window.openCostCategory === 'function') {
            window.openCostCategory(target);
        }
    }, 120);
};

window.handleCostSearch = function (query) {
    ccSearchQuery = query.toLowerCase().trim();

    if (ccCurrentGroup) {
        // Если открыта какая-то вкладка, ищем внутри неё
        renderDrilldown();
    } else {
        // Глобальный поиск "Матрешка" с главного экрана
        const searchContainer = document.getElementById('cc-global-search-container');
        const warnEl = document.getElementById('cc-balance-warning');

        if (!ccSearchQuery) {
            if (searchContainer) searchContainer.classList.add('hidden');
            if (warnEl) warnEl.classList.remove('hidden');
            return;
        }

        if (warnEl) warnEl.classList.add('hidden');
        if (searchContainer) searchContainer.classList.remove('hidden');

        renderGlobalSearch();
    }
};

window.renderGlobalSearch = function () {
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
                    <div class="dash-search-tx-row">
                        <div class="dash-search-tx-info">
                            <div class="font-bold font-14 text-main">
                                ${highlightText(t.counterparty || 'Без контрагента', ccSearchQuery)}
                            </div>
                            <div class="font-12 text-muted dash-text-ellipsis">
                                ${highlightText(t.description || '—', ccSearchQuery)} (${t.date})
                            </div>
                        </div>
                        <div class="dash-search-tx-amount flex-row align-center">
                            ${fmtRub(t.amount)} ₽
                        </div>
                        <div class="flex-row align-center">
                            <button class="btn btn-outline p-5 font-12 h-26" onclick="moveTransaction(${t.id})">🔄</button>
                        </div>
                    </div>
                `).join('');

                groupHtml += `
                    <div class="mb-0 bg-surface-alt">
                        <div class="dash-search-cat-header">
                            📁 ${highlightText(cat.name, ccSearchQuery)}
                        </div>
                        ${txsHtml}
                    </div>
                `;
            }
        });

        if (groupHtml) {
            html += `
                <div class="mb-15 fade-in-drilldown dash-search-group-wrap">
                    <div class="p-10 font-bold dash-financial-header" style="background: ${colors[grp]}15; color: ${colors[grp]}; border-bottom: 2px solid ${colors[grp]};">
                        ${titles[grp]}
                    </div>
                    ${groupHtml}
                </div>
            `;
        }
    });

    if (!html) html = '<div class="text-muted fade-in-drilldown p-20 text-center" >Ничего не найдено</div>';
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
        activeInputHtml = `<input type="date" class="input-modern dash-period-input dash-period-input-date" value="${dashSpecificDate}" onchange="applyDashPeriod('date', this.value)">`;
    } else if (dashPeriodType !== 'all' && dashPeriodType !== 'year' && dashPeriodType !== 'week') {
        activeInputHtml = `<select class="input-modern dash-period-input" onchange="applyDashPeriod('value', this.value)">${valOptions}</select>`;
    }

    let yearHtml = '';
    if (dashPeriodType !== 'day' && dashPeriodType !== 'week' && dashPeriodType !== 'all') {
        yearHtml = `<select class="input-modern dash-period-input" onchange="applyDashPeriod('year', this.value)">${yearOptions}</select>`;
    }

    const html = `
        <select class="input-modern dash-period-input" onchange="applyDashPeriod('type', this.value)">${typeOptions}</select>
        ${activeInputHtml}
        ${yearHtml}
    `;

    document.querySelectorAll('.dash-period-selector').forEach(container => {
        container.innerHTML = html;
        container.classList.remove('hidden');
        container.classList.add('gap-10');
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

window.renderDrilldown = function () {
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
                <div class="fade-in-drilldown hover-row dash-drill-row" style="animation-delay: ${animDelay}s;" 
                     onclick="openCostCategory('${cat.name.replace(/'/g, "\\'")}')">
                    <div class="font-bold">
                        <span style="color: ${groupColor};" class="mr-5">📁</span> 
                        ${highlightText(cat.name, ccSearchQuery)} 
                        <span class="text-muted font-11 ml-5">— ${pct}% от группы (${cat.transactions.length} тр.)</span>
                    </div>
                    <div class="flex-row align-center gap-10">
                        <div class="font-bold" style="color: ${groupColor};">${fmtRub(Math.abs(cat.total))} ₽</div>
                        <button class="btn btn-outline p-5 font-11" data-ids="${cat.transactions.map(t => t.id).join(',')}" data-group="${ccCurrentGroup}" onclick="event.stopPropagation(); renameFolder(this)" title="Переименовать папку">✏️</button>
                        <button class="btn btn-outline p-5 font-11" data-ids="${cat.transactions.map(t => t.id).join(',')}" onclick="event.stopPropagation(); moveFolderCategory(this)" title="Перенести всю папку в другую группу">🔄</button>
                        <span class="text-muted">➔</span>
                    </div>
                </div>
            `;
        });
        if (!html) html = '<div class="text-muted fade-in-drilldown p-20 text-center" >Ничего не найдено</div>';
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

                html += `
                    <div class="fade-in-drilldown flex-between align-center dash-drill-tx" style="animation-delay: ${animDelay}s;">
                        <div class="flex-row align-center gap-10">
                            <input type="checkbox" class="tx-select-checkbox cursor-pointer" value="${t.id}" onclick="event.stopPropagation(); updateBulkSelectBtn(this)" style="width: 16px; height: 16px; accent-color: ${groupColor};">
                            <div>
                                <div class="font-bold font-13" style="color: ${groupColor};">${highlightText(t.counterparty || 'Без контрагента', ccSearchQuery)}</div>
                                <div class="font-11 text-muted">${t.date} | ${highlightText(t.description || 'Нет описания', ccSearchQuery)}</div>
                            </div>
                        </div>
                        <div class="flex-row align-center gap-15">
                            <div class="font-bold" style="color: ${groupColor};">${highlightText(fmtRub(Math.abs(t.amount)), ccSearchQuery)} ₽</div>
                            <button class="btn btn-outline p-5 font-11" onclick="moveTransaction(${t.id})" title="Сменить категорию">🔄</button>
                        </div>
                    </div>
                `;
            });
        }
        if (!html) html = '<div class="text-muted fade-in-drilldown p-20 text-center" >Ничего не найдено</div>';

        // Панель массового действия (по умолчанию скрыта)
        const bulkBar = `
            <div class="bulk-select-bar dash-bulk-bar flex-between align-center gap-10">
                <label class="cursor-pointer flex-row align-center gap-5 font-12 text-muted">
                    <input type="checkbox" class="bulk-select-all-cb cursor-pointer" onclick="toggleAllCheckboxes(this)" style="width: 16px; height: 16px;">
                    Выбрать все
                </label>
                <div class="flex-row align-center gap-10">
                    <span class="bulk-select-count font-12 text-muted"></span>
                    <button class="btn btn-blue p-5 font-13" onclick="moveSelectedTransactions(this)">🔄 Перенести выбранные</button>
                </div>
            </div>
        `;
        // Оборачиваем список транзакций в скроллируемый контейнер
        html = `<div class="folder-tx-wrapper dash-tx-wrapper">${html}${bulkBar}</div>`;
    }

    container.innerHTML = html;
};

// === ГРУППОВОЙ ПЕРЕНОС ГАЛОЧКАМИ ===
window.updateBulkSelectBtn = function (element) {
    // Ищем ближайший wrapper от кликнутого чекбокса
    const wrapper = element ? element.closest('.folder-tx-wrapper') : null;
    if (!wrapper) return;
    const checkedBoxes = wrapper.querySelectorAll('.tx-select-checkbox:checked');
    const bar = wrapper.querySelector('.bulk-select-bar');
    if (!bar) return;
    if (checkedBoxes.length > 0) {
        bar.classList.remove('hidden');
        const countEl = bar.querySelector('.bulk-select-count');
        if (countEl) countEl.textContent = 'Выбрано: ' + checkedBoxes.length;
    } else {
        bar.classList.add('hidden');
        const selectAllCb = bar.querySelector('.bulk-select-all-cb');
        if (selectAllCb) selectAllCb.checked = false;
    }
};

window.toggleAllCheckboxes = function (selectAllCb) {
    const wrapper = selectAllCb.closest('.folder-tx-wrapper');
    if (!wrapper) return;
    const isChecked = selectAllCb.checked;
    wrapper.querySelectorAll('.tx-select-checkbox').forEach(function (cb) { cb.checked = isChecked; });
    updateBulkSelectBtn(selectAllCb);
};

window.moveSelectedTransactions = function (btnElement) {
    // Ищем wrapper от кнопки или берем все отмеченные на странице
    const wrapper = btnElement ? btnElement.closest('.folder-tx-wrapper') : document;
    var checked = wrapper.querySelectorAll('.tx-select-checkbox:checked');
    var selectedIds = [];
    checked.forEach(function (cb) { var n = Number(cb.value); if (n > 0) selectedIds.push(n); });
    if (selectedIds.length === 0) return UI.toast('Отметьте хотя бы одну транзакцию', 'warning');

    openTxReassignModal({
        ids: selectedIds,
        title: `🔄 Переназначение проводок (${selectedIds.length})`,
        defaultMode: 'tx_category_group'
    });
};

function collectDashboardCategoryNames() {
    const allNames = [];
    ['direct', 'opex', 'capex'].forEach(function (grp) {
        (ccGroupedExpenses[grp] || []).forEach(function (cat) { allNames.push(cat.name); });
    });
    return allNames.filter(function (v, i, a) { return a.indexOf(v) === i; }).sort();
}

async function previewAndApplyMovement(payload, successMessage, savedGroup, savedCategory) {
    const preview = await API.post('/api/finance/movements/preview', payload);
    const previewRows = (preview.impacted || []).slice(0, 5).map(row =>
        `<tr><td>${row.id}</td><td>${Utils.escapeHtml(row.before_category || '-')}</td><td>${Utils.escapeHtml(row.after_category || '-')}</td><td>${Utils.escapeHtml(row.before_group || '-')}</td><td>${Utils.escapeHtml(row.after_group || '-')}</td></tr>`
    ).join('');
    const more = preview.impacted_count > 5 ? `<div class="font-11 text-muted mt-5">... и еще ${preview.impacted_count - 5}</div>` : '';
    const body = `
        <div class="font-13 mb-10">Будет изменено записей: <b>${preview.impacted_count}</b></div>
        <div class="table-container">
            <table class="finance-table w-100">
                <thead><tr><th>ID</th><th>Было (статья)</th><th>Станет (статья)</th><th>Было (группа)</th><th>Станет (группа)</th></tr></thead>
                <tbody>${previewRows || '<tr><td colspan="5" class="text-center text-muted">Нет изменений</td></tr>'}</tbody>
            </table>
        </div>
        ${more}
        <div class="form-group mt-10 m-0">
            <label>Причина применения (обязательно)</label>
            <textarea id="movement-apply-reason" class="input-modern" rows="3" placeholder="Например: исправление неверной группировки"></textarea>
        </div>
    `;
    UI.showModal('Предпросмотр изменений', body,
        `<button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
         <button class="btn btn-blue" onclick="executeMovementApply()">Применить</button>`
    );
    window.executeMovementApply = async function () {
        const reason = (document.getElementById('movement-apply-reason')?.value || '').trim();
        if (!reason) return UI.toast('Укажите причину применения', 'warning');
        try {
            await API.post('/api/finance/movements/apply', { ...payload, reason });
            UI.closeModal();
            UI.toast(successMessage || 'Изменения применены', 'success');
            await loadCostConstructor();
            const tabIndexMap = { direct: 0, opex: 1, capex: 2 };
            if (savedGroup && tabIndexMap[savedGroup] !== undefined) {
                switchCostTab(savedGroup, tabIndexMap[savedGroup]);
                if (savedCategory) openCostCategory(savedCategory);
            }
        } catch (err) {
            console.error(err);
            UI.toast(err.message || 'Ошибка применения', 'error');
        } finally {
            try { delete window.executeMovementApply; } catch (_) { }
        }
    };
}

function openTxReassignModal({ ids, title, defaultMode = 'tx_group' }) {
    const uniqueNames = collectDashboardCategoryNames();
    const options = ['<option value="">-- выбрать статью --</option>'].concat(
        uniqueNames.map((n) => `<option value="${n.replace(/"/g, '&quot;')}">${n}</option>`)
    ).join('');
    const html = `
        <div class="flex-col gap-10">
            <div class="font-13">Записей: <b>${ids.length}</b></div>
            <div class="form-group m-0">
                <label>Режим:</label>
                <select id="tx-move-mode" class="input-modern">
                    <option value="tx_group" ${defaultMode === 'tx_group' ? 'selected' : ''}>Сменить только группу</option>
                    <option value="tx_category" ${defaultMode === 'tx_category' ? 'selected' : ''}>Сменить только статью</option>
                    <option value="tx_category_group" ${defaultMode === 'tx_category_group' ? 'selected' : ''}>Сменить статью и группу</option>
                </select>
            </div>
            <div class="form-group m-0">
                <label>Статья назначения:</label>
                <select id="tx-move-category-select" class="input-modern">${options}</select>
                <input type="text" id="tx-move-category-input" class="input-modern mt-5" placeholder="Или новая статья...">
            </div>
            <div class="form-group m-0">
                <label>Группа назначения:</label>
                <select id="tx-move-group" class="input-modern">
                    <option value="direct">🟢 Прямые (COGS)</option>
                    <option value="opex" selected>🟠 Косвенные (OPEX)</option>
                    <option value="capex">🟣 Капитал (CAPEX)</option>
                </select>
            </div>
        </div>
    `;
    UI.showModal(title, html,
        `<button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
         <button class="btn btn-blue" onclick="submitTxReassign()">Далее</button>`
    );
    window.submitTxReassign = async function () {
        const mode = document.getElementById('tx-move-mode')?.value || 'tx_group';
        const categoryFromSelect = document.getElementById('tx-move-category-select')?.value || '';
        const categoryFromInput = (document.getElementById('tx-move-category-input')?.value || '').trim();
        const targetCategory = categoryFromInput || categoryFromSelect;
        const targetGroup = document.getElementById('tx-move-group')?.value || 'opex';
        if ((mode === 'tx_category' || mode === 'tx_category_group') && !targetCategory) {
            return UI.toast('Укажите статью назначения', 'warning');
        }
        const payload = {
            operation_type: mode,
            transaction_ids: ids,
            target_category: targetCategory || null,
            target_cost_group: (mode === 'tx_group' || mode === 'tx_category_group') ? targetGroup : null
        };
        const savedGroup = ccCurrentGroup;
        const savedCategory = ccCurrentCategory;
        await previewAndApplyMovement(payload, 'Переназначение выполнено', savedGroup, savedCategory);
    };
}

window.moveTransaction = async function (txId) {
    try {
        openTxReassignModal({
            ids: [txId],
            title: '🔄 Переназначение проводки',
            defaultMode: 'tx_group'
        });
    } catch (e) {
        console.error(e);
        UI.toast('Ошибка открытия окна', 'error');
    }
};

window.executeMoveTransaction = async function (txId) {
    return moveTransaction(txId);
};

let ccCurrentFolderIds = [];

window.moveFolderCategory = function (btnElement) {
    try {
        const idsStr = btnElement.getAttribute('data-ids') || '';
        ccCurrentFolderIds = idsStr.split(',').map(Number).filter(n => !isNaN(n) && n > 0);

        if (ccCurrentFolderIds.length === 0) {
            return UI.toast('В этой папке нет реальных транзакций для переноса', 'warning');
        }

        const html = `
            <div class="form-group">
                <label class="font-bold mb-10 block">Транзакций для переноса: <span class="text-primary">${ccCurrentFolderIds.length} шт.</span></label>
                <label>Перенести ВСЕ транзакции этой папки в группу:</label>
                <select id="move-folder-select" class="input-modern font-14 p-10" >
                    <option value="" selected>Автоматически (По матрице)</option>
                    <option value="direct">🟢 Прямые (COGS)</option>
                    <option value="opex">🟠 Косвенные (OPEX)</option>
                    <option value="capex">🟣 Капитал (CAPEX)</option>
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

window.executeMoveFolder = async function () {
    const sel = document.getElementById('move-folder-select');
    if (!sel) return;
    if (ccCurrentFolderIds.length === 0) return UI.toast('Нет ID для переноса', 'error');

    // ШАГ 1: Сохраняем состояние UI ДО отправки
    const savedGroup = ccCurrentGroup;

    try {
        const payload = {
            operation_type: 'tx_group',
            transaction_ids: ccCurrentFolderIds,
            target_cost_group: sel.value || 'opex'
        };
        await previewAndApplyMovement(payload, 'Группа папки изменена', savedGroup, null);
        ccCurrentFolderIds = [];
    } catch (err) {
        console.error(err);
        UI.toast(err.message, 'error');
    }
};

// === ПЕРЕИМЕНОВАНИЕ ПАПКИ ===
let ccRenameIds = [];
let ccRenameGroup = 'opex';

window.renameFolder = function (btnElement) {
    try {
        var idsStr = btnElement.getAttribute('data-ids') || '';
        ccRenameIds = idsStr.split(',').map(Number).filter(function (n) { return !isNaN(n) && n > 0; });
        ccRenameGroup = btnElement.getAttribute('data-group') || 'opex';

        if (ccRenameIds.length === 0) {
            return UI.toast('В этой папке нет реальных транзакций', 'warning');
        }

        var uniqueNames = collectDashboardCategoryNames();
        var selectOptions = '<option value="">-- Ввести новое название ниже --</option>';
        uniqueNames.forEach(function (n) {
            selectOptions += '<option value="' + n.replace(/"/g, '&quot;') + '">' + n + '</option>';
        });

        var modalHtml = '<div class="flex-col gap-15">' +
            '<div class="font-bold font-13">Транзакций: <span class="text-primary">' + ccRenameIds.length + ' шт.</span></div>' +

            '<div class="form-group m-0" >' +
            '<label class="font-600 mb-5 block">Выберите существующую папку (для объединения):</label>' +
            '<select id="renameExistingSelect" class="input-modern font-14 p-10" >' + selectOptions + '</select>' +
            '</div>' +

            '<div class="form-group m-0" >' +
            '<label class="font-600 mb-5 block">Или введите новое название:</label>' +
            '<input type="text" id="renameNameInput" class="input-modern font-14 p-10 font-600"  placeholder="Например: Канцтовары...">' +
            '</div>' +

            '<div class="form-group m-0" >' +
            '<label class="font-600 mb-5 block">Группа для новой категории:</label>' +
            '<select id="rename-folder-group" class="input-modern font-13 p-10" >' +
            '<option value="direct"' + (ccRenameGroup === 'direct' ? ' selected' : '') + '>🟢 Прямые (COGS)</option>' +
            '<option value="opex"' + (ccRenameGroup === 'opex' ? ' selected' : '') + '>🟠 Косвенные (OPEX)</option>' +
            '<option value="capex"' + (ccRenameGroup === 'capex' ? ' selected' : '') + '>🟣 Капитал (CAPEX)</option>' +
            '</select>' +
            '</div>' +
            '</div>';

        UI.showModal('✏️ Операции со статьей', modalHtml,
            '<button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>' +
            '<button class="btn btn-blue" onclick="executeRenameFolder()">Сохранить</button>'
        );

        // Слушатель: при выборе из select — заполнить input
        setTimeout(function () {
            var sel = document.getElementById('renameExistingSelect');
            if (sel) {
                sel.addEventListener('change', function (e) {
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

window.executeRenameFolder = async function () {
    var input = document.getElementById('renameNameInput');
    var groupSel = document.getElementById('rename-folder-group');
    if (!input || !input.value.trim()) return UI.toast('Введите или выберите имя категории', 'warning');
    if (ccRenameIds.length === 0) return UI.toast('Нет ID для переименования', 'error');

    var savedGroup = ccCurrentGroup;

    try {
        const payload = {
            operation_type: 'tx_category_group',
            transaction_ids: ccRenameIds,
            target_category: input.value.trim(),
            target_cost_group: groupSel ? groupSel.value : ccRenameGroup
        };
        await previewAndApplyMovement(payload, 'Операция со статьей выполнена', savedGroup, null);
        ccRenameIds = [];
    } catch (err) {
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
    window.PLANNED_OVERHEAD_PER_CYCLE = costPerCycle;
};

// Загрузка настроек из БД
async function loadFinanceSettings() {
    try {
        const data = await API.get('/api/settings/finance');

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
        overhead_per_cycle: window.PLANNED_OVERHEAD_PER_CYCLE
    };

    try {
        await API.post('/api/settings/finance', payload);
        // 🚀 ИСПРАВЛЕНИЕ: Мгновенно обновляем память при сохранении
        window.FINANCE_TAX_PERCENT = parseFloat(taxVal) || 6;
        UI.toast('✅ Финансовая модель утверждена!', 'success');
    } catch (e) {
        console.error(e);
        UI.toast(e.message || 'Ошибка при сохранении', 'error');
    }
};

// =================================================================
// 🛒 MRP: АНАЛИЗ ДЕФИЦИТА СЫРЬЯ
// =================================================================
window.openMrpPanel = async function () {
    UI.toast('⏳ Анализ дефицита и планов производства...', 'info');

    try {
        const data = await API.get('/api/production/mrp-summary');

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
                        <td style="padding: 12px 10px; border-bottom: 1px solid var(--danger-border);"><b>${Utils.escapeHtml(d.name)}</b></td>
                        <td style="padding: 12px 10px; border-bottom: 1px solid var(--danger-border); text-align: center; color: var(--text-muted);">${d.stock} ${d.unit}</td>
                        <td style="padding: 12px 10px; border-bottom: 1px solid var(--danger-border); text-align: center; font-weight: bold;">${d.needed} ${d.unit}</td>
                        <td style="padding: 12px 10px; border-bottom: 1px solid var(--danger-border); text-align: right; color: var(--danger-text); font-weight: 900; font-size: 14px;">-${shortage.toLocaleString('ru-RU')} ${d.unit}</td>
                    </tr>
                `;
            } else {
                okHtml += `
                    <tr style="opacity: 0.8;">
                        <td style="padding: 10px; border-bottom: 1px solid var(--border);"><b>${Utils.escapeHtml(d.name)}</b></td>
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
        const data = await API.get('/api/production/mrp-summary');

        if (data.success) {
            // Ищем, есть ли хоть одна позиция, где shortage > 0
            const hasDeficit = data.deficitReport.some(d => parseFloat(d.shortage) > 0);

            if (hasDeficit) {
                btn.className = 'btn btn-red text-white';
                btn.innerHTML = '⚠️ Есть дефицит (MRP)';
            } else {
                btn.className = 'btn bg-success text-white border-success';
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
        const categories = await API.get('/api/finance/categories');

        const groups = {
            direct: categories.filter(c => ['direct', 'cogs'].includes(c.cost_group)),
            opex: categories.filter(c => ['opex', 'overhead', null, undefined, ''].includes(c.cost_group)),
            capex: categories.filter(c => ['capex', 'capital'].includes(c.cost_group))
        };

        const renderCol = (title, color, desc, items) => `
            <div style="background: var(--surface-alt); border-top: 4px solid ${color}; border-radius: 8px; padding: 15px; box-shadow: 0 2px 4px var(--shadow-sm);">
                <h4 style="margin: 0 0 5px 0; color: ${color}; font-size: 14px;">${title}</h4>
                <p style="font-size: 11px; color: var(--text-muted); margin: 0 0 15px 0; min-height: 34px;">${desc}</p>
                <div style="display: flex; flex-direction: column; gap: 8px;">
                    ${items.map(c => `
                        <div style="background: var(--surface); border: 1px solid var(--border); padding: 8px 10px; border-radius: 6px; display: flex; justify-content: space-between; align-items: center; gap: 10px;">
                            <div style="font-size: 12px; font-weight: 500; line-height: 1.2;">
                                ${Utils.escapeHtml(c.name)}
                                <div style="font-size: 9px; color: var(--text-muted); margin-top: 2px;">${c.type === 'income' ? 'Доход' : 'Расход'}</div>
                            </div>
                            <select class="input-modern matrix-cat-select" data-id="${c.id}" style="padding: 2px 5px; font-size: 11px; height: 24px; width: 110px; cursor: pointer;">
                                <option value="direct" ${['direct', 'cogs'].includes(c.cost_group) ? 'selected' : ''}>В Прямые</option>
                                <option value="opex" ${['opex', 'overhead', null, undefined, ''].includes(c.cost_group) ? 'selected' : ''}>В OPEX</option>
                                <option value="capex" ${['capex', 'capital'].includes(c.cost_group) ? 'selected' : ''}>В CAPEX</option>
                            </select>
                        </div>
                    `).join('')}
                    ${items.length === 0 ? `<div style="text-align: center; color: var(--text-muted); font-size: 11px; padding: 10px;">Пусто</div>` : ''}
                </div>
            </div>
        `;

        const html = `
            <div class="form-grid" style="grid-template-columns: 1fr 1fr 1fr; gap: 15px;">
                ${renderCol('🟢 COGS (Прямые)', 'var(--success)', 'Материалы, сдельная ЗП, прямые расходы', groups.direct)}
                ${renderCol('🟠 OPEX (Косвенные)', 'var(--warning)', 'Аренда, оклады, налоги, маркетинг', groups.opex)}
                ${renderCol('🔵 CAPEX (Капитал)', 'var(--primary)', 'Оборудование, стройка, инвестиции', groups.capex)}
            </div>
        `;

        UI.showModal('🎛️ Матрица статей управленческого учета', html, `<button class="btn btn-blue w-100" onclick="UI.closeModal(); loadCostConstructor();">Закрыть и пересчитать Дашборд</button>`);

        // 🚀 Инициализация TomSelect для динамических строк матрицы
        setTimeout(() => {
            document.querySelectorAll('.matrix-cat-select').forEach(el => {
                if (!el.tomselect) {
                    new TomSelect(el, {
                        dropdownParent: 'body',
                        onChange: function (value) {
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
        await API.put(`/api/finance/categories/${id}/group`, { cost_group: newGroup });
        // Перерисовываем окно, чтобы карточка визуально перепрыгнула в нужную колонку
        openCategoryMatrix();
    } catch (e) { UI.toast('Ошибка сохранения', 'error'); }
};

window.initDashboard = function () {
    initStaticDashboardSelects();
    if (typeof loadStockValuation === 'function') loadStockValuation();

    // Авто-загрузка при переходе на дашборд
    setTimeout(() => {
        if (typeof checkMrpStatus === 'function') checkMrpStatus(true); // isSilent = true

        const loadBtn = document.querySelector('button[onclick="loadCostConstructor()"]');
        if (loadBtn) loadBtn.click();
    }, 150);
};

window.loadStockValuation = async function () {
    const listEl = document.getElementById('stock-val-list');
    const totalEl = document.getElementById('stock-val-total');
    if (!listEl || !totalEl) return;

    listEl.innerHTML = '<div class="text-muted" style="font-size: 13px;">🔄 Загрузка данных...</div>';

    try {
        const data = await API.get('/api/inventory/valuation');

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
                        ${Utils.escapeHtml(w.name)} 
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
        listEl.innerHTML = `<div class="text-danger" style="font-size: 13px;">❌ ${Utils.escapeHtml(e.message)}</div>`;
        totalEl.innerHTML = '0 ₽';
    }
};

function initStaticDashboardSelects() {
    // Задел под будущие фильтры (например, склад/менеджер)
    // ['dash-warehouse-filter'].forEach(id => { ... }) 
}

window.loadDashboardWidgets = async function () {
    try {
        const data = await API.get('/api/analytics/dashboard-widgets');
        if (!data) return;

        const arTotalEl = document.getElementById('dash-widget-ar-total');
        if (arTotalEl) arTotalEl.innerText = Utils.formatMoney(data.ar.total) + ' ₽';

        const arListEl = document.getElementById('dash-widget-ar-list');
        if (arListEl && data.ar.list) {
            if (data.ar.list.length === 0) {
                arListEl.innerHTML = '<div style="padding: 10px; color: var(--success); font-weight: bold;">✅ Нет неоплаченного долга по заказам (по договору)</div>';
            } else {
                arListEl.innerHTML = data.ar.list.map(inv => {
                    const click = inv.is_order
                        ? `openOrderDetails(${inv.id})`
                        : `(window.app && window.app.openEntity('document_invoice', ${inv.id}))`;
                    const subline = inv.is_order
                        ? `Заказ №${Utils.escapeHtml(String(inv.doc_number))} от ${inv.date}`
                        : `Счёт №${Utils.escapeHtml(String(inv.doc_number))} от ${inv.date}`;
                    return `
                <div class="cursor-pointer dash-widget-row dash-widget-row-ar" onclick="${click}">
                    <div>
                        <span class="font-bold text-main">${Utils.escapeHtml(inv.counterparty_name)}</span>
                        <br><small class="text-muted">${subline}</small>
                    </div>
                    <div class="font-bold text-warning-text dash-widget-ar-amt">
                        ${fmtRub(inv.pending_debt)} ₽
                    </div>
                </div>`;
                }).join('');
            }
        }

        const stockListEl = document.getElementById('dash-widget-stock-list');
        const stockBadge = document.getElementById('dash-widget-stock-badge'); // Счетчик в заголовке

        if (stockListEl && data.min_stock) {
            if (stockBadge) stockBadge.innerText = data.min_stock.length > 0 ? `(${data.min_stock.length})` : '';

            if (data.min_stock.length === 0) {
                stockListEl.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--success); font-weight: bold;">✅ Складской запас в норме</div>';
            } else {
                stockListEl.innerHTML = data.min_stock.map(item => {
                    const available = parseFloat(item.current_qty || 0);
                    const deficit = item.min_stock - available;

                    return `
                    <div class="cursor-pointer dash-widget-row dash-widget-row-stock"
                         onclick="if(window.switchModule){ switchModule('stock-mod', document.querySelector('[onclick*=\\'stock-mod\\']')); setTimeout(() => { const mod = document.getElementById('stock-mod'); const s = mod ? mod.querySelector('input[type=\\'text\\']') : null; if(s){ s.value='${Utils.escapeHtml(item.name)}'; s.dispatchEvent(new Event('input')); } }, 300); }">
                        <div class="dash-widget-stock-name">
                            <span class="font-bold text-main dash-widget-stock-title">
                                ${Utils.escapeHtml(item.name)}
                            </span>
                            <small class="text-muted">${item.article || 'Без арт.'} | Порог: ${item.min_stock} ${item.unit}</small>
                        </div>
                        <div class="text-right dash-widget-stock-qty-cell">
                            <span class="text-danger dash-widget-stock-qty-num" title="Физически: ${item.physical_qty} | Резерв: ${item.reserved_qty}">
                                ${available} ${item.unit}
                            </span>
                            <br><small class="text-warning-text font-bold">📉 Нужно: ${deficit.toFixed(1)}</small>
                        </div>
                    </div>
                `}).join('');
            }
        }
    } catch (e) {
        console.error('Ошибка загрузки виджетов', e);
    }
};
