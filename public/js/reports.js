window.__reportsState = {
    lastPayload: null,
    lastData: null,
    optionsLoaded: false,
    page: 1,
    pageSize: 200,
    visibleColumns: [],
    presets: [],
    canManageSettings: false,
    permissions: { view: true, export: true, print: true, manageTemplates: false, manageSharedPresets: false },
    settings: {},
    financeDefaults: { salesTax: 20, overheadPerCycle: 0 },
    runs: [],
    runsLoadTimer: null,
    density: 'compact',
    periodPicker: null,
    stickyResizeBound: false,
    filterHeightObserver: null,
    salesAnalyticsActiveTab: 'summary',
    salesAnalyticsSortKey: '',
    salesAnalyticsSortDir: 'desc'
};

function reportsDefaultSalesTaxRate() {
    const n = Number(window.__reportsState.financeDefaults?.salesTax);
    if (Number.isFinite(n)) return Math.min(100, Math.max(0, n));
    return 20;
}

function reportsDefaultOverheadRate() {
    const n = Number(window.__reportsState.financeDefaults?.overheadPerCycle);
    if (Number.isFinite(n)) return Math.max(0, n);
    return 136;
}

/** Строка для поля «Оверхед»: ровно 2 знака после запятой (и при показе, и для API через Number()). */
function reportsFmtOverheadInput(raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return (Math.round(n * 100) / 100).toFixed(2);
    const d = Math.max(0, Number(reportsDefaultOverheadRate()) || 0);
    return (Math.round(d * 100) / 100).toFixed(2);
}

window.reportsNormalizeOverheadInput = function() {
    const el = document.getElementById('reports-filter-overhead-rate');
    if (!el || el.closest('.form-group')?.classList.contains('reports-hidden')) return;
    const n = Number(String(el.value || '').replace(',', '.'));
    if (!Number.isFinite(n) || n < 0) {
        el.value = reportsFmtOverheadInput(reportsDefaultOverheadRate());
        return;
    }
    el.value = reportsFmtOverheadInput(n);
};

function reportsTodayStr() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function reportsDateStr(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function reportsDisplayDate(d) {
    return d.toLocaleDateString('ru-RU');
}

function reportsMonthName(d) {
    return d.toLocaleDateString('ru-RU', { month: 'long' });
}

function reportsGetAnchorDate() {
    const v = document.getElementById('reports-date-anchor')?.value || reportsTodayStr();
    const d = new Date(`${v}T00:00:00`);
    return Number.isNaN(d.getTime()) ? new Date() : d;
}

const REPORTS_ALL_TIME_FROM = '1900-01-01';

function reportsApplyPeriodFromMode(mode, anchorDate, shouldLoad = true) {
    const dateRaw = anchorDate instanceof Date ? anchorDate : reportsGetAnchorDate();
    const safeMode = ['day', 'month', 'quarter', 'year', 'all_time'].includes(mode) ? mode : 'day';
    let anchor = new Date(dateRaw.getFullYear(), dateRaw.getMonth(), dateRaw.getDate());
    let from = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
    let to = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
    if (safeMode === 'all_time') {
        const now = new Date();
        anchor = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        from = new Date(`${REPORTS_ALL_TIME_FROM}T00:00:00`);
        to = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    } else if (safeMode === 'month') {
        anchor = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
        from = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
        to = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
    } else if (safeMode === 'quarter') {
        const qStartMonth = Math.floor(anchor.getMonth() / 3) * 3;
        anchor = new Date(anchor.getFullYear(), qStartMonth, 1);
        from = new Date(anchor.getFullYear(), qStartMonth, 1);
        to = new Date(anchor.getFullYear(), qStartMonth + 3, 0);
    } else if (safeMode === 'year') {
        const now = new Date();
        anchor = new Date(anchor.getFullYear(), 0, 1);
        from = new Date(anchor.getFullYear(), 0, 1);
        if (anchor.getFullYear() === now.getFullYear()) {
            to = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        } else {
            to = new Date(anchor.getFullYear(), 11, 31);
        }
    }
    const fromEl = document.getElementById('reports-date-from');
    const toEl = document.getElementById('reports-date-to');
    const anchorEl = document.getElementById('reports-date-anchor');
    const modeEl = document.getElementById('reports-period-mode');
    if (fromEl) fromEl.value = reportsDateStr(from);
    if (toEl) toEl.value = reportsDateStr(to);
    if (anchorEl) anchorEl.value = reportsDateStr(anchor);
    if (modeEl) modeEl.value = safeMode;
    reportsRefreshPeriodDisplay();
    if (shouldLoad) {
        window.__reportsState.page = 1;
        reportsLoadPreview();
    }
}

function reportsSyncPeriodUiFromInputs() {
    const from = document.getElementById('reports-date-from')?.value || reportsTodayStr();
    const to = document.getElementById('reports-date-to')?.value || reportsTodayStr();
    const fromDate = new Date(`${from}T00:00:00`);
    const toDate = new Date(`${to}T00:00:00`);
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) return;
    let mode = 'day';
    if (from === REPORTS_ALL_TIME_FROM) mode = 'all_time';
    else if (from === to) mode = 'day';
    else if (fromDate.getMonth() === toDate.getMonth() && fromDate.getFullYear() === toDate.getFullYear()
        && fromDate.getDate() === 1 && toDate.getDate() === new Date(toDate.getFullYear(), toDate.getMonth() + 1, 0).getDate()) mode = 'month';
    else if (fromDate.getFullYear() === toDate.getFullYear() && fromDate.getMonth() === 0 && fromDate.getDate() === 1 && toDate.getMonth() === 11 && toDate.getDate() === 31) mode = 'year';
    else if (fromDate.getMonth() === 0 && fromDate.getDate() === 1) mode = 'year';
    const anchor = to;
    const anchorEl = document.getElementById('reports-date-anchor');
    const modeEl = document.getElementById('reports-period-mode');
    if (anchorEl) anchorEl.value = anchor;
    if (modeEl) modeEl.value = mode;
    reportsRefreshPeriodDisplay();
}

function reportsRefreshPeriodDisplay() {
    const displayEl = document.getElementById('reports-period-display');
    const mode = document.getElementById('reports-period-mode')?.value || 'day';
    const anchor = reportsGetAnchorDate();
    const prevBtn = document.getElementById('reports-period-prev-btn');
    const nextBtn = document.getElementById('reports-period-next-btn');
    const pickerBtn = document.querySelector('.reports-period-icon-btn');
    if (!displayEl) return;
    const allTimeMode = mode === 'all_time';
    if (prevBtn) prevBtn.disabled = allTimeMode;
    if (nextBtn) nextBtn.disabled = allTimeMode;
    if (pickerBtn) pickerBtn.disabled = allTimeMode;
    if (prevBtn) prevBtn.title = allTimeMode ? 'Недоступно в режиме "Все время"' : 'Назад';
    if (nextBtn) nextBtn.title = allTimeMode ? 'Недоступно в режиме "Все время"' : 'Вперед';
    if (pickerBtn) pickerBtn.title = allTimeMode ? 'Недоступно в режиме "Все время"' : 'Выбрать дату';
    if (allTimeMode) {
        displayEl.value = 'Все время';
        return;
    }
    if (mode === 'day') {
        displayEl.value = reportsDisplayDate(anchor);
        return;
    }
    if (mode === 'month') {
        const label = reportsMonthName(anchor);
        displayEl.value = `${label.charAt(0).toUpperCase()}${label.slice(1)} ${anchor.getFullYear()}`;
        return;
    }
    if (mode === 'quarter') {
        const q = Math.floor(anchor.getMonth() / 3) + 1;
        displayEl.value = `${q} квартал ${anchor.getFullYear()}`;
        return;
    }
    if (mode === 'year') {
        const now = new Date();
        displayEl.value = anchor.getFullYear() === now.getFullYear() ? `YTD ${anchor.getFullYear()}` : String(anchor.getFullYear());
        return;
    }
    displayEl.value = reportsDisplayDate(anchor);
}

window.reportsOpenPeriodPicker = function() {
    const mode = document.getElementById('reports-period-mode')?.value || 'day';
    if (mode === 'all_time') return;
    const picker = window.__reportsState.periodPicker;
    if (picker) {
        picker.setDate(reportsGetAnchorDate(), false);
        picker.open();
        return;
    }
    const input = document.getElementById('reports-date-anchor');
    if (!input) return;
    if (typeof input.showPicker === 'function') input.showPicker();
    else input.click();
};

window.reportsOnPeriodModeChange = function() {
    const mode = document.getElementById('reports-period-mode')?.value || 'day';
    reportsApplyPeriodFromMode(mode, reportsGetAnchorDate(), true);
};

window.reportsOnPeriodAnchorChange = function() {
    const mode = document.getElementById('reports-period-mode')?.value || 'day';
    reportsApplyPeriodFromMode(mode, reportsGetAnchorDate(), true);
};

window.reportsShiftPeriod = function(delta) {
    const base = reportsGetAnchorDate();
    const mode = document.getElementById('reports-period-mode')?.value || 'day';
    if (mode === 'all_time') return;
    const step = Number(delta || 0);
    if (mode === 'month') base.setMonth(base.getMonth() + step);
    else if (mode === 'quarter') base.setMonth(base.getMonth() + (3 * step));
    else if (mode === 'year') base.setFullYear(base.getFullYear() + step);
    else base.setDate(base.getDate() + step);
    reportsApplyPeriodFromMode(mode, base, true);
};

window.reportsShiftPeriodPrev = function() {
    window.reportsShiftPeriod(-1);
};

window.reportsShiftPeriodNext = function() {
    window.reportsShiftPeriod(1);
};

// Backward compatibility for cached inline handlers.
window.reportsShiftDay = function(delta) {
    window.reportsShiftPeriod(delta);
};

function reportsBuildPayload() {
    const reportType = document.getElementById('reports-type')?.value || 'osv_counterparties';
    const dateFrom = document.getElementById('reports-date-from')?.value || reportsTodayStr();
    const dateTo = document.getElementById('reports-date-to')?.value || reportsTodayStr();
    const accountingMode = document.getElementById('reports-accounting-mode')?.value || 'managerial';
    const printTemplateVersion = document.getElementById('reports-print-template-version')?.value || 'v1';
    const filters = {
        counterpartyId: document.getElementById('reports-filter-counterparty')?.value || undefined,
        accountId: document.getElementById('reports-filter-account')?.value || undefined,
        accountMovementMode: document.getElementById('reports-filter-account-movement')?.value || 'all',
        stockBalanceMode: document.getElementById('reports-filter-stock-balance')?.value || 'nonzero',
        stockValuationMode: document.getElementById('reports-filter-stock-valuation')?.value || 'movement_actual',
        itemId: document.getElementById('reports-filter-item')?.value || undefined,
        warehouseType: document.getElementById('reports-filter-warehouse')?.value || undefined,
        movementType: document.getElementById('reports-filter-movement-type')?.value || undefined,
        transactionType: document.getElementById('reports-filter-transaction-type')?.value || undefined,
        topN: Number(document.getElementById('reports-filter-topn')?.value || 20),
        forecastHorizon: Number(document.getElementById('reports-filter-forecast-horizon')?.value || 30),
        analyticsTab: document.getElementById('reports-filter-analytics-tab')?.value || window.__reportsState.salesAnalyticsActiveTab || 'summary',
        overheadRate: Number(document.getElementById('reports-filter-overhead-rate')?.value || reportsDefaultOverheadRate()),
        taxRate: Number(document.getElementById('reports-filter-tax-rate')?.value || reportsDefaultSalesTaxRate())
    };
    filters.counterpartyBalanceMode = document.getElementById('reports-filter-nonzero')?.value || 'nonzero';
    filters.excludeEmployees = Boolean(document.getElementById('reports-filter-exclude-employees')?.checked);
    filters.includeReturns = Boolean(document.getElementById('reports-filter-include-returns')?.checked);
    filters.includeOverhead = Boolean(document.getElementById('reports-filter-include-overhead')?.checked);
    filters.includeTaxes = Boolean(document.getElementById('reports-filter-include-taxes')?.checked);
    if (reportType !== 'sales_analytics') {
        delete filters.topN;
        delete filters.forecastHorizon;
        delete filters.analyticsTab;
        delete filters.includeReturns;
        delete filters.includeOverhead;
        delete filters.overheadRate;
        delete filters.includeTaxes;
        delete filters.taxRate;
    }
    if (reportType === 'sales_analytics') {
        delete filters.warehouseType;
    }
    if (accountingMode === 'regulatory') {
        const regKeys = reportsGetRegulatoryKeysForReport(reportType);
        filters.regOnlyPosted = Boolean(document.getElementById('reports-reg-only-posted')?.checked);
        filters.regOnlyPrimaryDoc = Boolean(document.getElementById('reports-reg-only-primary')?.checked);
        filters.regRequireDocumentNo = Boolean(document.getElementById('reports-reg-require-docno')?.checked);
        filters.regSourceTag = document.getElementById('reports-reg-source-tag')?.value || undefined;
        if (regKeys.includes('reserve')) filters.regExcludeReserve = Boolean(document.getElementById('reports-reg-exclude-reserve')?.checked);
        if (regKeys.includes('adjustments')) filters.regExcludeAdjustments = Boolean(document.getElementById('reports-reg-exclude-adjustments')?.checked);
        if (regKeys.includes('offset')) filters.regExcludeOffset = Boolean(document.getElementById('reports-reg-exclude-offset')?.checked);
        if (regKeys.includes('technical')) filters.regExcludeTechnical = Boolean(document.getElementById('reports-reg-exclude-technical')?.checked);
    }
    Object.keys(filters).forEach((k) => (filters[k] === undefined || filters[k] === '') && delete filters[k]);
    const payload = { reportType, dateFrom, dateTo, filters };
    payload.accountingMode = accountingMode;
    payload.printTemplateVersion = printTemplateVersion;
    if (Array.isArray(window.__reportsState.visibleColumns) && window.__reportsState.visibleColumns.length) {
        payload.visibleColumns = window.__reportsState.visibleColumns.slice();
    }
    if (reportType === 'inventory_register') {
        payload.pagination = { page: window.__reportsState.page || 1, pageSize: window.__reportsState.pageSize || 200 };
    }
    return payload;
}

function reportsGetRegulatoryKeysForReport(reportType) {
    const map = {
        osv_counterparties: [],
        osv_cash_accounts: [],
        osv_materials: ['reserve'],
        osv_products: ['reserve'],
        turnover_finance: ['offset', 'technical'],
        inventory_register: ['reserve', 'adjustments'],
        sales_analytics: []
    };
    return map[reportType] || [];
}

function reportsSyncRegulatoryFilters() {
    const accountingMode = document.getElementById('reports-accounting-mode')?.value || 'managerial';
    const reportType = document.getElementById('reports-type')?.value || 'osv_counterparties';
    const box = document.getElementById('reports-regulatory-filters');
    if (!box) return;
    const enabledKeys = reportsGetRegulatoryKeysForReport(reportType);
    const shouldShowBox = accountingMode === 'regulatory';
    box.classList.toggle('d-none', !shouldShowBox);
    const optMap = {
        posted: 'reports-reg-opt-posted',
        primary: 'reports-reg-opt-primary',
        docno: 'reports-reg-opt-docno',
        reserve: 'reports-reg-opt-reserve',
        adjustments: 'reports-reg-opt-adjustments',
        offset: 'reports-reg-opt-offset',
        technical: 'reports-reg-opt-technical'
    };
    Object.entries(optMap).forEach(([key, id]) => {
        const el = document.getElementById(id);
        if (!el) return;
        if (['posted', 'primary', 'docno'].includes(key)) {
            el.classList.toggle('d-none', false);
            return;
        }
        el.classList.toggle('d-none', !enabledKeys.includes(key));
    });
    const sourceSel = document.getElementById('reports-reg-source-tag');
    if (sourceSel) sourceSel.classList.toggle('d-none', false);
    const noneEl = document.getElementById('reports-reg-none');
    if (noneEl) noneEl.classList.toggle('d-none', enabledKeys.length > 0);
    requestAnimationFrame(reportsAfterReportsLayout);
}

window.reportsOnAccountingModeChange = function() {
    reportsSyncRegulatoryFilters();
    reportsLoadPreview();
};

window.reportsOnReportTypeChange = function() {
    reportsApplyFilterVisibility();
    reportsSyncRegulatoryFilters();
    reportsLoadPreview();
};

function reportsSyncCounterpartyBalanceHint() {
    const sel = document.getElementById('reports-filter-nonzero');
    const hint = document.getElementById('reports-filter-nonzero-hint');
    if (!hint) return;
    const mode = sel?.value || 'nonzero';
    const map = {
        nonzero: 'Показываются только контрагенты с ненулевым конечным сальдо.',
        movement: 'Показываются контрагенты, у которых были движения в выбранном периоде, даже при нулевом сальдо.',
        credit: 'Показываются только контрагенты с кредиторской задолженностью (КЗ).',
        debit: 'Показываются только контрагенты с дебиторской задолженностью (ДЗ).',
        all: 'Показываются все контрагенты из базы, независимо от сальдо и движений.'
    };
    const text = map[mode] || map.nonzero;
    hint.textContent = text;
    if (sel) sel.title = text;
}

window.reportsOnCounterpartyBalanceModeChange = function() {
    reportsSyncCounterpartyBalanceHint();
    reportsLoadPreview();
};

function reportsFormatMetric(value, key = '') {
    const n = Number(value);
    if (!Number.isFinite(n)) return Utils.escapeHtml(value ?? '');
    const metricKey = String(key || '').toLowerCase();
    if (/qty|quantity|кол-во|количеств/.test(metricKey)) {
        return n.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 4 });
    }
    if (/count|rows_|operations_count|строк/.test(metricKey)) {
        return n.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    }
    const formatted = n.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
    const isCurrency = /(debit|credit|opening|closing|balance|amount|sum|turnover|payment|shipment|сальдо|оборот|дз|кз|приход|расход)/.test(metricKey);
    return isCurrency ? `${formatted} ₽` : formatted;
}

function reportsFormatMetricForReport(value, key = '', reportType = '') {
    const metricKey = String(key || '').toLowerCase();
    if (reportType === 'sales_analytics') {
        const n = Number(value);
        if (Number.isFinite(n)) {
            return n.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        }
    }
    if ((reportType === 'osv_materials' || reportType === 'osv_products') && /_qty$/.test(metricKey)) {
        const n = Number(value);
        if (Number.isFinite(n)) {
            return n.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
        }
    }
    if (metricKey === 'val' || metricKey === 'qty') {
        const n = Number(value);
        if (Number.isFinite(n)) {
            return n.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        }
    }
    return reportsFormatMetric(value, key);
}

function reportsSalesAnalyticsMetricSuffix(key = '', unit = '') {
    const metricKey = String(key || '').toLowerCase();
    const cleanUnit = String(unit || '').trim() || 'ед.';
    const moneyKeys = new Set(['revenue_gross', 'tax_amount', 'revenue_net', 'unit_cost_std', 'cogs_std', 'gross_profit', 'returns_revenue']);
    if (moneyKeys.has(metricKey)) {
        if (metricKey === 'unit_cost_std') return ' ₽/ед.';
        return ' ₽';
    }
    const qtyKeys = new Set([
        'sold_qty',
        'shipped_qty',
        'reversed_qty',
        'forecast_qty',
        'backlog_qty',
        'stock_qty',
        'need_to_produce',
        'returns_qty'
    ]);
    if (qtyKeys.has(metricKey)) return ` ${cleanUnit}`;
    if (metricKey === 'avg_daily_demand') return ` ${cleanUnit}/день`;
    if (metricKey === 'gross_margin' || metricKey === 'revenue_share' || metricKey === 'qty_share') return ' %';
    return '';
}

function reportsPolarityClass(key = '') {
    const k = String(key || '').toLowerCase();
    if (!k) return '';
    if (/(opening_debit|debit_turnover|payment_in|shipment_in|closing_debit|inflow_qty|inflow_sum|\\bдз\\b|\\bдт\\b)/.test(k)) return 'reports-col-debit';
    if (/(opening_credit|credit_turnover|payment_out|shipment_out|closing_credit|outflow_qty|outflow_sum|\\bкз\\b|\\bкт\\b)/.test(k)) return 'reports-col-credit';
    return '';
}

function reportsTotalLabel(key) {
    const map = {
        opening_debit: 'Сальдо нач. Дт',
        opening_credit: 'Сальдо нач. Кт',
        debit_turnover: 'Оборот Дт',
        credit_turnover: 'Оборот Кт',
        payment_in: 'Оплата: приход',
        payment_out: 'Оплата: расход',
        shipment_in: 'Отгрузка: приход',
        shipment_out: 'Отгрузка: расход',
        turnover_net: 'Оборот (нетто)',
        closing_debit: 'Сальдо кон. Дт',
        closing_credit: 'Сальдо кон. Кт',
        closing_balance: 'Сальдо конечное',
        opening_balance: 'Сальдо начальное',
        opening_qty: 'Остаток начальный',
        opening_sum: 'Остаток начальный (₽)',
        inflow_qty: 'Приход',
        inflow_sum: 'Приход (₽)',
        outflow_qty: 'Расход',
        outflow_sum: 'Расход (₽)',
        closing_qty: 'Остаток конечный',
        closing_sum: 'Остаток конечный (₽)',
        amount_sum: 'Сумма',
        operations_count: 'Операций',
        quantity_sum: 'Количество (сумма)',
        sold_qty: 'Объем продаж',
        revenue_gross: 'Выручка',
        gross_profit: 'Валовая прибыль',
        gross_margin: 'Маржинальность, %',
        tax_amount: 'Налог',
        revenue_net: 'Выручка (чистая)',
        returns_qty: 'Возвраты (объем)',
        returns_revenue: 'Возвраты (сумма), ₽',
        forecast_qty: 'Прогноз спроса',
        backlog_qty: 'Заказы к отгрузке',
        stock_qty: 'Остаток',
        need_to_produce: 'Нужно произвести',
        rows_count: 'Строк (на странице)',
        rows_total: 'Строк (всего)'
    };
    return map[key] || key;
}

function reportsFormatRunFormat(v) {
    const map = {
        preview: 'Предпросмотр',
        print: 'Печать',
        csv: 'Экспорт CSV',
        xlsx: 'Экспорт XLSX',
        print_blocked: 'Печать (заблокировано)',
        csv_blocked: 'CSV (заблокировано)',
        xlsx_blocked: 'XLSX (заблокировано)'
    };
    return map[v] || (v || '');
}

function reportsFormatRunPreflight(v) {
    const map = { ok: 'OK', warning: 'Предупреждение', blocked: 'Заблокировано' };
    return map[v] || (v || '');
}

function reportsFormatType(v) {
    const map = {
        osv_counterparties: 'ОСВ по контрагентам',
        osv_cash_accounts: 'ОСВ по деньгам',
        osv_materials: 'ОСВ по материалам',
        osv_products: 'ОСВ по продукции',
        turnover_finance: 'Обороты по финстатьям',
        inventory_register: 'Реестр движений запасов',
        sales_analytics: 'Аналитика продаж'
    };
    return map[v] || (v || '');
}

function reportsApplyDensity() {
    const table = document.getElementById('reports-table');
    const btn = document.getElementById('reports-density-btn');
    const density = window.__reportsState.density === 'standard' ? 'standard' : 'compact';
    if (table) {
        table.classList.toggle('reports-density-compact', density === 'compact');
        table.classList.toggle('reports-density-standard', density === 'standard');
    }
    if (btn) {
        btn.textContent = density === 'compact' ? 'Плотность: компактно' : 'Плотность: стандарт';
    }
    try { localStorage.setItem('reportsDensity', density); } catch (_) {}
}

/** Без position: sticky у шапки (конфликт с overflow-x); оптическое удержание через transform */
function reportsSyncTableHead() {
    const mod = document.getElementById('reports-mod');
    if (!mod || !mod.classList.contains('active')) return;
    const panel = document.querySelector('#reports-mod .reports-filter-card');
    const table = document.getElementById('reports-table');
    const ths = table ? table.querySelectorAll('thead th') : [];
    if (!table || ths.length === 0) return;
    if (!panel) {
        ths.forEach((th) => { th.style.transform = 'translateY(0)'; });
        return;
    }
    const thead = table.querySelector('thead');
    if (!thead) return;
    const panelRect = panel.getBoundingClientRect();
    const tableRect = table.getBoundingClientRect();
    let offset = panelRect.bottom - tableRect.top;
    if (offset > 0 && tableRect.bottom > panelRect.bottom) {
        const theadHeight = thead.offsetHeight;
        const maxOffset = Math.max(0, tableRect.height - theadHeight);
        const finalOffset = Math.min(offset, maxOffset);
        ths.forEach((th) => { th.style.transform = `translateY(${finalOffset}px)`; });
    } else {
        ths.forEach((th) => { th.style.transform = 'translateY(0)'; });
    }
}

function reportsAfterReportsLayout() {
    reportsMeasureStickyOffsets();
    reportsSyncTableHead();
}

function reportsParseIsoDate(value) {
    if (!value) return null;
    const d = new Date(`${value}T00:00:00`);
    return Number.isNaN(d.getTime()) ? null : d;
}

function reportsFormatPeriodRange(period) {
    const fromDate = reportsParseIsoDate(period?.dateFrom);
    const toDate = reportsParseIsoDate(period?.dateTo);
    if (!fromDate || !toDate) return '';
    const fromLabel = reportsDisplayDate(fromDate);
    const toLabel = reportsDisplayDate(toDate);
    return fromLabel === toLabel ? fromLabel : `${fromLabel} - ${toLabel}`;
}

function reportsExtractFlowMetrics(data) {
    const totals = data?.totals || {};
    const reportType = data?.reportType || '';
    if (reportType === 'osv_counterparties') {
        return {
            payments: Number((totals.payment_in || 0) - (totals.payment_out || 0)),
            shipments: Number((totals.shipment_out || 0) - (totals.shipment_in || 0)),
            paymentsLabel: 'Оплаты (нетто)',
            shipmentsLabel: 'Отгрузки (нетто)',
            metricKey: 'amount'
        };
    }
    if (reportType === 'osv_materials') {
        return {
            payments: Number(totals.inflow_qty || 0),
            shipments: Number(totals.outflow_qty || 0),
            paymentsLabel: 'Поступления',
            shipmentsLabel: 'Расход',
            metricKey: 'quantity'
        };
    }
    if (reportType === 'osv_products') {
        return {
            payments: Number(totals.inflow_qty || 0),
            shipments: Number(totals.outflow_qty || 0),
            paymentsLabel: 'Поступления',
            shipmentsLabel: 'Отгрузки',
            metricKey: 'quantity'
        };
    }
    if (reportType === 'inventory_register') {
        const rows = Array.isArray(data.rows) ? data.rows : [];
        const flows = rows.reduce((acc, row) => {
            const qty = Number(row.quantity || 0);
            if (qty > 0) acc.inflow += qty;
            else if (qty < 0) acc.outflow += Math.abs(qty);
            return acc;
        }, { inflow: 0, outflow: 0 });
        return {
            payments: Number(flows.inflow.toFixed(4)),
            shipments: Number(flows.outflow.toFixed(4)),
            paymentsLabel: 'Поступления',
            shipmentsLabel: 'Отгрузки',
            metricKey: 'quantity'
        };
    }
    return null;
}

function reportsExtractTotalBalanceInfo(data) {
    const totals = data?.totals || {};
    const reportType = String(data?.reportType || window.__reportsState?.lastPayload?.reportType || '');
    if (reportType === 'inventory_register') {
        if (Number.isFinite(Number(totals.quantity_sum))) {
            const n = Number(totals.quantity_sum);
            return { amount: n, metricKey: 'quantity_sum', tone: n > 0 ? 'positive' : (n < 0 ? 'negative' : 'neutral'), forcePlus: false };
        }
        return null;
    }
    if (reportType === 'turnover_finance') {
        const rows = Array.isArray(data?.rows) ? data.rows : [];
        const income = Number(rows
            .filter((r) => String(r.transaction_type_code || '').toLowerCase() === 'income' || String(r.transaction_type || '').toLowerCase() === 'доход')
            .reduce((s, r) => s + Number(r.amount_sum || 0), 0)
            .toFixed(2));
        const expense = Number(rows
            .filter((r) => String(r.transaction_type_code || '').toLowerCase() === 'expense' || String(r.transaction_type || '').toLowerCase() === 'расход')
            .reduce((s, r) => s + Number(r.amount_sum || 0), 0)
            .toFixed(2));
        const mode = String(window.__reportsState?.lastPayload?.filters?.transactionType || '').toLowerCase();
        if (mode === 'income') {
            return { amount: income, metricKey: 'amount_sum', tone: 'positive', forcePlus: false };
        }
        if (mode === 'expense') {
            return { amount: expense, metricKey: 'amount_sum', tone: 'negative', forcePlus: false };
        }
        const net = Number((income - expense).toFixed(2));
        return {
            amount: net,
            metricKey: 'amount_sum',
            tone: net > 0 ? 'positive' : (net < 0 ? 'negative' : 'neutral'),
            forcePlus: net > 0
        };
    }
    if (Number.isFinite(Number(totals.closing_sum))) {
        const n = Number(totals.closing_sum);
        return { amount: n, metricKey: 'closing_sum', tone: n > 0 ? 'positive' : (n < 0 ? 'negative' : 'neutral'), forcePlus: false };
    }
    if (Number.isFinite(Number(totals.closing_balance))) {
        const n = Number(totals.closing_balance);
        return { amount: n, metricKey: 'closing_balance', tone: n > 0 ? 'positive' : (n < 0 ? 'negative' : 'neutral'), forcePlus: false };
    }
    const hasClosingDebit = Object.prototype.hasOwnProperty.call(totals, 'closing_debit');
    const hasClosingCredit = Object.prototype.hasOwnProperty.call(totals, 'closing_credit');
    const closingDebit = Number(totals.closing_debit || 0);
    const closingCredit = Number(totals.closing_credit || 0);
    if ((hasClosingDebit || hasClosingCredit) && (Number.isFinite(closingDebit) || Number.isFinite(closingCredit))) {
        const n = Number((closingDebit - closingCredit).toFixed(2));
        return { amount: n, metricKey: 'closing_balance', tone: n > 0 ? 'positive' : (n < 0 ? 'negative' : 'neutral'), forcePlus: false };
    }
    return null;
}

function reportsBuildHeadSummaryRow(data, colspan) {
    const items = [];
    const periodRange = reportsFormatPeriodRange(data?.period);
    if (periodRange) items.push({ label: 'Период', value: periodRange });
    if (data?.accountingMode === 'regulatory') items.push({ label: 'Режим', value: 'Регламентный' });
    if (data?.accountingMode === 'managerial') items.push({ label: 'Режим', value: 'Управленческий' });
    if (data?.printTemplateVersion) items.push({ label: 'Шаблон', value: String(data.printTemplateVersion).toUpperCase() });
    const totalBalanceInfo = reportsExtractTotalBalanceInfo(data);
    if (totalBalanceInfo) {
        const rawValue = reportsFormatMetric(totalBalanceInfo.amount, totalBalanceInfo.metricKey || 'closing_balance');
        const displayValue = totalBalanceInfo.forcePlus ? `+${rawValue}` : rawValue;
        items.push({
            label: 'Общее сальдо',
            value: displayValue,
            tone: totalBalanceInfo.tone || ''
        });
    }

    const flowMetrics = reportsExtractFlowMetrics(data);
    if (flowMetrics) {
        const metricKey = flowMetrics.metricKey || 'amount';
        items.push({
            label: flowMetrics.paymentsLabel || 'Оплаты',
            value: reportsFormatMetric(flowMetrics.payments, metricKey)
        });
        items.push({
            label: flowMetrics.shipmentsLabel || 'Отгрузки',
            value: reportsFormatMetric(flowMetrics.shipments, metricKey)
        });
    }

    if (!items.length) return '';
    const infoHtml = items
        .map((item) => `<span class="reports-head-summary-item${item.tone ? ` reports-head-summary-item-${Utils.escapeHtml(item.tone)}` : ''}"><span>${Utils.escapeHtml(item.label)}:</span> <strong>${Utils.escapeHtml(item.value)}</strong></span>`)
        .join('');
    return `<tr class="reports-head-summary"><th colspan="${Math.max(1, Number(colspan) || 1)}"><div class="reports-head-summary-wrap">${infoHtml}</div></th></tr>`;
}

function reportsBuildOsvCounterpartyHeadRows(data, cols, numericCols) {
    const keys = cols.map((c) => c.key);
    const expected = ['counterparty', 'opening_debit', 'opening_credit', 'payment_in', 'payment_out', 'shipment_in', 'shipment_out', 'closing_debit', 'closing_credit'];
    const isExpected = expected.length === keys.length && expected.every((k, i) => keys[i] === k);
    if (!isExpected) return '';

    const fromDate = reportsParseIsoDate(data?.period?.dateFrom);
    const toDate = reportsParseIsoDate(data?.period?.dateTo);
    const fromLabel = fromDate ? reportsDisplayDate(fromDate) : (data?.period?.dateFrom || '');
    const toLabel = toDate ? reportsDisplayDate(toDate) : (data?.period?.dateTo || '');
    const summaryRow = reportsBuildHeadSummaryRow(data, cols.length);

    const groupRow = `
        <tr class="reports-head-groups">
            <th class="reports-col-main reports-head-group-main" rowspan="3">Контрагент</th>
            <th class="reports-head-group" colspan="2">${Utils.escapeHtml(fromLabel)}</th>
            <th class="reports-head-group" colspan="4">Оборот</th>
            <th class="reports-head-group" colspan="2">${Utils.escapeHtml(toLabel)}</th>
        </tr>
    `;
    const level2Row = `
        <tr class="reports-head-level2">
            <th class="${numericCols[1] ? 'reports-num ' : ''}reports-col-debit">ДЗ</th>
            <th class="${numericCols[2] ? 'reports-num ' : ''}reports-col-credit">КЗ</th>
            <th class="reports-head-level2-group" colspan="2">Оплата</th>
            <th class="reports-head-level2-group" colspan="2">Отгрузка</th>
            <th class="${numericCols[7] ? 'reports-num ' : ''}reports-col-debit">ДЗ</th>
            <th class="${numericCols[8] ? 'reports-num ' : ''}reports-col-credit">КЗ</th>
        </tr>
    `;
    const level3Labels = ['Сумма', 'Сумма', 'Приход', 'Расход', 'Приход', 'Расход', 'Сумма', 'Сумма'];
    const level3Row = `<tr class="reports-head-level3">${level3Labels.map((label, idx) => {
        const key = cols[idx + 1]?.key || '';
        const cls = `${numericCols[idx + 1] ? 'reports-num ' : ''}${reportsPolarityClass(key)}`.trim();
        return `<th class="${cls}">${Utils.escapeHtml(label)}</th>`;
    }).join('')}</tr>`;
    return `${summaryRow}${groupRow}${level2Row}${level3Row}`;
}

function reportsBuildOsvCashHeadRows(data, cols, numericCols) {
    const keys = cols.map((c) => c.key);
    const expected = ['account', 'opening_balance', 'debit_turnover', 'credit_turnover', 'closing_balance'];
    const isExpected = expected.length === keys.length && expected.every((k, i) => keys[i] === k);
    if (!isExpected) return '';
    const fromDate = reportsParseIsoDate(data?.period?.dateFrom);
    const toDate = reportsParseIsoDate(data?.period?.dateTo);
    const fromLabel = fromDate ? reportsDisplayDate(fromDate) : (data?.period?.dateFrom || '');
    const toLabel = toDate ? reportsDisplayDate(toDate) : (data?.period?.dateTo || '');
    const summaryRow = reportsBuildHeadSummaryRow(data, cols.length);
    const groupRow = `
        <tr class="reports-head-groups">
            <th class="reports-col-main reports-head-group-main" rowspan="2">Счет/Касса</th>
            <th class="reports-head-group" colspan="1">${Utils.escapeHtml(fromLabel)}</th>
            <th class="reports-head-group" colspan="2">Оборот</th>
            <th class="reports-head-group" colspan="1">${Utils.escapeHtml(toLabel)}</th>
        </tr>
    `;
    const level2Labels = ['Сальдо', 'Приход', 'Расход', 'Сальдо'];
    const level2Row = `<tr class="reports-head-level2">${level2Labels.map((label, idx) => {
        const key = cols[idx + 1]?.key || '';
        const cls = `${numericCols[idx + 1] ? 'reports-num ' : ''}${reportsPolarityClass(key)}`.trim();
        return `<th class="${cls}">${Utils.escapeHtml(label)}</th>`;
    }).join('')}</tr>`;
    return `${summaryRow}${groupRow}${level2Row}`;
}

function reportsBuildOsvStockHeadRows(data, cols, numericCols) {
    const keys = cols.map((c) => c.key);
    const expected = ['item', 'warehouse', 'unit', 'opening_qty', 'opening_sum', 'inflow_qty', 'inflow_sum', 'outflow_qty', 'outflow_sum', 'closing_qty', 'closing_sum'];
    const isExpected = expected.length === keys.length && expected.every((k, i) => keys[i] === k);
    if (!isExpected) return '';
    const fromDate = reportsParseIsoDate(data?.period?.dateFrom);
    const toDate = reportsParseIsoDate(data?.period?.dateTo);
    const fromLabel = fromDate ? reportsDisplayDate(fromDate) : (data?.period?.dateFrom || '');
    const toLabel = toDate ? reportsDisplayDate(toDate) : (data?.period?.dateTo || '');
    const summaryRow = reportsBuildHeadSummaryRow(data, cols.length);
    const groupRow = `
        <tr class="reports-head-groups">
            <th class="reports-col-main reports-head-group-main" rowspan="2">Номенклатура</th>
            <th class="reports-head-group" rowspan="2">Склад</th>
            <th class="reports-head-group" rowspan="2">Ед.</th>
            <th class="reports-head-group" colspan="2">${Utils.escapeHtml(fromLabel)}</th>
            <th class="reports-head-group" colspan="4">Движение</th>
            <th class="reports-head-group" colspan="2">${Utils.escapeHtml(toLabel)}</th>
        </tr>
    `;
    const level2Labels = ['Ед.', '₽', 'Ед.', '₽', 'Ед.', '₽', 'Ед.', '₽'];
    const level2Row = `<tr class="reports-head-level2">${level2Labels.map((label, idx) => {
        const key = cols[idx + 3]?.key || '';
        const cls = `${numericCols[idx + 3] ? 'reports-num ' : ''}${reportsPolarityClass(key)}`.trim();
        return `<th class="${cls}">${Utils.escapeHtml(label)}</th>`;
    }).join('')}</tr>`;
    return `${summaryRow}${groupRow}${level2Row}`;
}

function reportsBuildTurnoverFinanceHeadRows(data, cols, numericCols) {
    const keys = cols.map((c) => c.key);
    const expected = ['transaction_type', 'category', 'operations_count', 'amount_sum'];
    const isExpected = expected.length === keys.length && expected.every((k, i) => keys[i] === k);
    if (!isExpected) return '';
    const fromDate = reportsParseIsoDate(data?.period?.dateFrom);
    const toDate = reportsParseIsoDate(data?.period?.dateTo);
    const fromLabel = fromDate ? reportsDisplayDate(fromDate) : (data?.period?.dateFrom || '');
    const toLabel = toDate ? reportsDisplayDate(toDate) : (data?.period?.dateTo || '');
    const summaryRow = reportsBuildHeadSummaryRow(data, cols.length);
    const groupRow = `
        <tr class="reports-head-groups">
            <th class="reports-head-group" rowspan="2">Тип</th>
            <th class="reports-col-main reports-head-group-main" rowspan="2">Статья</th>
            <th class="reports-head-group" colspan="2">${Utils.escapeHtml(`${fromLabel}${fromLabel !== toLabel ? ` - ${toLabel}` : ''}`)}</th>
        </tr>
    `;
    const level2Labels = ['Операций', 'Сумма'];
    const level2Row = `<tr class="reports-head-level2">${level2Labels.map((label, idx) => {
        const key = cols[idx + 2]?.key || '';
        const cls = `${numericCols[idx + 2] ? 'reports-num ' : ''}${reportsPolarityClass(key)}`.trim();
        return `<th class="${cls}">${Utils.escapeHtml(label)}</th>`;
    }).join('')}</tr>`;
    return `${summaryRow}${groupRow}${level2Row}`;
}

function reportsBuildInventoryRegisterHeadRows(data, cols, numericCols) {
    const keys = cols.map((c) => c.key);
    const expected = ['date', 'warehouse', 'item', 'unit', 'movement_type', 'quantity', 'batch', 'description'];
    const isExpected = expected.length === keys.length && expected.every((k, i) => keys[i] === k);
    if (!isExpected) return '';
    const fromDate = reportsParseIsoDate(data?.period?.dateFrom);
    const toDate = reportsParseIsoDate(data?.period?.dateTo);
    const fromLabel = fromDate ? reportsDisplayDate(fromDate) : (data?.period?.dateFrom || '');
    const toLabel = toDate ? reportsDisplayDate(toDate) : (data?.period?.dateTo || '');
    const summaryRow = reportsBuildHeadSummaryRow(data, cols.length);
    const groupRow = `
        <tr class="reports-head-groups">
            <th class="reports-col-main reports-head-group-main" rowspan="2">Дата</th>
            <th class="reports-head-group" rowspan="2">Склад</th>
            <th class="reports-head-group" rowspan="2">Номенклатура</th>
            <th class="reports-head-group" rowspan="2">Ед.</th>
            <th class="reports-head-group" colspan="2">Движение <span class="reports-head-group-date">${Utils.escapeHtml(`${fromLabel}${fromLabel !== toLabel ? ` - ${toLabel}` : ''}`)}</span></th>
            <th class="reports-head-group" rowspan="2">Партия</th>
            <th class="reports-head-group" rowspan="2">Комментарий</th>
        </tr>
    `;
    const level2Labels = ['Тип', 'Количество'];
    const level2Row = `<tr class="reports-head-level2">${level2Labels.map((label, idx) => {
        const key = cols[idx + 4]?.key || '';
        const cls = `${numericCols[idx + 4] ? 'reports-num ' : ''}${reportsPolarityClass(key)}`.trim();
        return `<th class="${cls}">${Utils.escapeHtml(label)}</th>`;
    }).join('')}</tr>`;
    return `${summaryRow}${groupRow}${level2Row}`;
}

function reportsBuildOsvCounterpartyMatrix(cols, rows, totals) {
    const keys = new Set((cols || []).map((c) => String(c.key || '')));
    const required = ['counterparty', 'opening_debit', 'opening_credit', 'payment_in', 'payment_out', 'shipment_in', 'shipment_out', 'closing_debit', 'closing_credit'];
    if (!required.every((k) => keys.has(k))) return null;

    const normalizedRows = (rows || []).map((r) => ({
        ...r,
        payment_in: Number(r.payment_in ?? 0),
        payment_out: Number(r.payment_out ?? 0),
        shipment_in: Number(r.shipment_in ?? 0),
        shipment_out: Number(r.shipment_out ?? 0)
    }));
    const srcTotals = totals || {};
    const normalizedTotals = {
        opening_debit: Number(srcTotals.opening_debit || 0),
        opening_credit: Number(srcTotals.opening_credit || 0),
        payment_in: Number(srcTotals.payment_in || 0),
        payment_out: Number(srcTotals.payment_out || 0),
        shipment_in: Number(srcTotals.shipment_in || 0),
        shipment_out: Number(srcTotals.shipment_out || 0),
        closing_debit: Number(srcTotals.closing_debit || 0),
        closing_credit: Number(srcTotals.closing_credit || 0)
    };
    const normalizedCols = [
        { key: 'counterparty', label: 'Контрагент' },
        { key: 'opening_debit', label: 'Сальдо на начало (ДЗ)' },
        { key: 'opening_credit', label: 'Сальдо на начало (КЗ)' },
        { key: 'payment_in', label: 'Приход оплаты' },
        { key: 'payment_out', label: 'Расход оплаты' },
        { key: 'shipment_in', label: 'Приход отгрузки' },
        { key: 'shipment_out', label: 'Расход отгрузки' },
        { key: 'closing_debit', label: 'Сальдо на конец (ДЗ)' },
        { key: 'closing_credit', label: 'Сальдо на конец (КЗ)' }
    ];
    return { cols: normalizedCols, rows: normalizedRows, totals: normalizedTotals };
}

function reportsSyncFixedColgroup(colgroup, reportType, cols) {
    if (!colgroup) return;
    if (reportType === 'osv_counterparties' && Array.isArray(cols) && cols.length === 9) {
        colgroup.innerHTML = [
            '<col class="reports-col-cpty-main">',
            '<col class="reports-col-cpty-num"><col class="reports-col-cpty-num"><col class="reports-col-cpty-num"><col class="reports-col-cpty-num">',
            '<col class="reports-col-cpty-num"><col class="reports-col-cpty-num"><col class="reports-col-cpty-num"><col class="reports-col-cpty-num">'
        ].join('');
        return;
    }
    if ((reportType === 'osv_materials' || reportType === 'osv_products') && Array.isArray(cols) && cols.length === 11) {
        colgroup.innerHTML = [
            '<col class="reports-col-stock-main">',
            '<col class="reports-col-stock-warehouse">',
            '<col class="reports-col-stock-unit">',
            '<col class="reports-col-stock-num"><col class="reports-col-stock-num">',
            '<col class="reports-col-stock-num"><col class="reports-col-stock-num">',
            '<col class="reports-col-stock-num"><col class="reports-col-stock-num">',
            '<col class="reports-col-stock-num"><col class="reports-col-stock-num">'
        ].join('');
        return;
    }
    if (reportType === 'turnover_finance' && Array.isArray(cols) && cols.length === 4) {
        colgroup.innerHTML = [
            '<col class="reports-col-turnover-type">',
            '<col class="reports-col-turnover-category">',
            '<col class="reports-col-turnover-count">',
            '<col class="reports-col-turnover-amount">'
        ].join('');
        return;
    }
    if (reportType === 'inventory_register' && Array.isArray(cols) && cols.length === 8) {
        colgroup.innerHTML = [
            '<col class="reports-col-register-date">',
            '<col class="reports-col-register-warehouse">',
            '<col class="reports-col-register-item">',
            '<col class="reports-col-register-unit">',
            '<col class="reports-col-register-type">',
            '<col class="reports-col-register-qty">',
            '<col class="reports-col-register-batch">',
            '<col class="reports-col-register-note">'
        ].join('');
        return;
    }
    colgroup.innerHTML = '';
}

function reportsMeasureStickyOffsets() {
    const mod = document.getElementById('reports-mod');
    const filterCard = document.querySelector('#reports-mod .reports-filter-card');
    if (!mod || !filterCard) return;
    if (!mod.classList.contains('active')) return;

    const pos = window.getComputedStyle(filterCard).position;
    if (pos === 'static') {
        mod.style.setProperty('--reports-panel-top', '0px');
        return;
    }

    const scrollBox = mod.closest('.content-area') || mod.parentElement;
    const padTop = parseFloat(window.getComputedStyle(scrollBox).paddingTop) || 0;
    const panelTop = -padTop;
    mod.style.setProperty('--reports-panel-top', `${panelTop}px`);
}

function reportsInitFilterHeightObserver() {
    if (window.__reportsState.filterHeightObserver || typeof ResizeObserver === 'undefined') return;
    const filterCard = document.querySelector('#reports-mod .reports-filter-card');
    if (!filterCard) return;
    const observer = new ResizeObserver(() => {
        requestAnimationFrame(reportsAfterReportsLayout);
    });
    observer.observe(filterCard);
    window.__reportsState.filterHeightObserver = observer;
}

window.reportsToggleDensity = function() {
    window.__reportsState.density = window.__reportsState.density === 'compact' ? 'standard' : 'compact';
    reportsApplyDensity();
    requestAnimationFrame(reportsAfterReportsLayout);
};

function reportsGetSalesAnalyticsTab(data) {
    const tabs = Array.isArray(data?.tabs) ? data.tabs : [];
    if (!tabs.length) return null;
    const requested = String(window.__reportsState.salesAnalyticsActiveTab || data?.activeTab || 'summary');
    const found = tabs.find((t) => String(t.id || '') === requested);
    return found || tabs[0];
}

function reportsRenderSalesAnalyticsPanels(data) {
    const tabsWrap = document.getElementById('reports-tabs');
    const kpiWrap = document.getElementById('reports-analytics-kpis');
    if (!tabsWrap || !kpiWrap) return;
    const tabs = Array.isArray(data?.tabs) ? data.tabs : [];
    const kpis = Array.isArray(data?.kpis) ? data.kpis : [];
    if (!tabs.length) {
        tabsWrap.classList.add('d-none');
        tabsWrap.innerHTML = '';
        kpiWrap.classList.add('d-none');
        kpiWrap.innerHTML = '';
        return;
    }
    const active = reportsGetSalesAnalyticsTab(data);
    window.__reportsState.salesAnalyticsActiveTab = String(active?.id || 'summary');
    const tabInput = document.getElementById('reports-filter-analytics-tab');
    if (tabInput) tabInput.value = window.__reportsState.salesAnalyticsActiveTab;
    tabsWrap.classList.remove('d-none');
    tabsWrap.innerHTML = tabs.map((tab) => {
        const tabId = String(tab.id || '');
        const activeCls = tabId === window.__reportsState.salesAnalyticsActiveTab ? ' active' : '';
        return `<button type="button" class="reports-tab-btn${activeCls}" onclick="reportsSwitchSalesAnalyticsTab('${Utils.escapeHtml(tabId)}')">${Utils.escapeHtml(tab.title || tabId)}</button>`;
    }).join('');
    if (!kpis.length) {
        kpiWrap.classList.add('d-none');
        kpiWrap.innerHTML = '';
        return;
    }
    kpiWrap.classList.remove('d-none');
    kpiWrap.innerHTML = kpis.map((kpi) => {
        const key = String(kpi.key || '');
        const value = reportsFormatMetricForReport(kpi.value || 0, key, 'sales_analytics');
        const suffix = kpi.unit ? ` ${Utils.escapeHtml(kpi.unit)}` : '';
        return `<div class="reports-kpi-card"><div class="reports-kpi-label">${Utils.escapeHtml(kpi.label || key)}</div><div class="reports-kpi-value">${Utils.escapeHtml(value)}${suffix && !value.includes('₽') && !value.includes('%') ? suffix : ''}</div></div>`;
    }).join('');
}

window.reportsSwitchSalesAnalyticsTab = function(tabId) {
    const normalized = String(tabId || '').trim();
    if (!normalized) return;
    window.__reportsState.salesAnalyticsActiveTab = normalized;
    const tabInput = document.getElementById('reports-filter-analytics-tab');
    if (tabInput) tabInput.value = normalized;
    if (window.__reportsState.lastPayload?.filters) {
        window.__reportsState.lastPayload.filters.analyticsTab = normalized;
    }
    const data = window.__reportsState.lastData;
    if (!data || String(data.reportType || '') !== 'sales_analytics') return;
    data.activeTab = normalized;
    reportsRender(data);
};

function reportsNormalizeSortValue(v) {
    if (v == null) return '';
    const n = Number(v);
    if (Number.isFinite(n)) return n;
    return String(v).toLowerCase();
}

function reportsApplySalesAnalyticsSort(rows, cols) {
    if (!Array.isArray(rows) || !rows.length) return rows;
    const key = String(window.__reportsState.salesAnalyticsSortKey || '').trim();
    if (!key) return rows;
    if (!Array.isArray(cols) || !cols.some((c) => String(c.key || '') === key)) return rows;
    const dir = String(window.__reportsState.salesAnalyticsSortDir || 'desc') === 'asc' ? 1 : -1;
    return rows.slice().sort((a, b) => {
        const av = reportsNormalizeSortValue(a?.[key]);
        const bv = reportsNormalizeSortValue(b?.[key]);
        if (typeof av === 'number' && typeof bv === 'number') {
            if (av === bv) return 0;
            return av > bv ? dir : -dir;
        }
        if (av === bv) return 0;
        return av > bv ? dir : -dir;
    });
}

window.reportsSortSalesAnalyticsBy = function(key) {
    const k = String(key || '').trim();
    if (!k) return;
    if (window.__reportsState.salesAnalyticsSortKey === k) {
        window.__reportsState.salesAnalyticsSortDir = window.__reportsState.salesAnalyticsSortDir === 'desc' ? 'asc' : 'desc';
    } else {
        window.__reportsState.salesAnalyticsSortKey = k;
        window.__reportsState.salesAnalyticsSortDir = 'desc';
    }
    const data = window.__reportsState.lastData;
    if (!data || String(data.reportType || '') !== 'sales_analytics') return;
    reportsRender(data);
};

function reportsRender(data) {
    const head = document.getElementById('reports-head');
    const body = document.getElementById('reports-body');
    const foot = document.getElementById('reports-foot');
    const totals = document.getElementById('reports-totals');
    const title = document.getElementById('reports-title');
    const meta = document.getElementById('reports-meta');
    const table = document.getElementById('reports-table');
    const colgroup = document.getElementById('reports-colgroup');
    const warning = document.getElementById('reports-warning');
    if (!head || !body || !foot || !totals || !title || !meta || !table) return;

    title.textContent = data.title || 'Отчет';
    const metaParts = [];
    if (data.accountingMode === 'regulatory') metaParts.push('Регламентный режим');
    if (data.accountingMode === 'managerial') metaParts.push('Управленческий режим');
    if (data.printTemplateVersion) metaParts.push(`шаблон: ${data.printTemplateVersion}`);
    meta.textContent = metaParts.join(' | ');

    let cols = Array.isArray(data.columns) ? data.columns.slice() : [];
    let rows = Array.isArray(data.rows) ? data.rows.slice() : [];
    let tableTotals = data.totals && typeof data.totals === 'object' ? { ...data.totals } : null;
    const reportType = data.reportType || window.__reportsState.lastPayload?.reportType || '';
    if (reportType === 'sales_analytics') {
        reportsRenderSalesAnalyticsPanels(data);
        const activeTab = reportsGetSalesAnalyticsTab(data);
        if (activeTab) {
            cols = Array.isArray(activeTab.columns) ? activeTab.columns.slice() : cols;
            rows = Array.isArray(activeTab.rows) ? activeTab.rows.slice() : rows;
            tableTotals = activeTab.totals && typeof activeTab.totals === 'object' ? { ...activeTab.totals } : tableTotals;
        }
        rows = reportsApplySalesAnalyticsSort(rows, cols);
    } else {
        const tabsWrap = document.getElementById('reports-tabs');
        const kpiWrap = document.getElementById('reports-analytics-kpis');
        if (tabsWrap) {
            tabsWrap.classList.add('d-none');
            tabsWrap.innerHTML = '';
        }
        if (kpiWrap) {
            kpiWrap.classList.add('d-none');
            kpiWrap.innerHTML = '';
        }
    }
    if (reportType === 'osv_counterparties') {
        const matrix = reportsBuildOsvCounterpartyMatrix(cols, rows, tableTotals);
        if (matrix) {
            cols = matrix.cols;
            rows = matrix.rows;
            tableTotals = matrix.totals;
        }
    }
    reportsSyncFixedColgroup(colgroup, reportType, cols);
    const osvLike = ['osv_counterparties', 'osv_cash_accounts', 'osv_materials', 'osv_products'].includes(reportType);
    const numericHints = /(debit|credit|opening|closing|balance|amount|sum|qty|quantity|turnover|payment|shipment|margin|share|forecast|backlog|need_to_produce|rank|revenue|tax|profit|cost|sold|cogs|unit_cost|gross|turnover|оборот|сальдо|остат|дт|кт|приход|расход|кол-во|сумма|выруч|налог|себестоим|марж|прибыл)/i;
    const salesTextKeys = new Set(['item', 'unit', 'abc_class', 'priority', 'cost_source_label', 'metric']);
    const numericCols = cols.map((c) => {
        const key = String(c?.key || '').toLowerCase();
        if (reportType === 'sales_analytics') return !salesTextKeys.has(key);
        return numericHints.test(`${c.key || ''} ${c.label || ''}`);
    });
    const stockTotalsUnit = (() => {
        if (!(reportType === 'osv_materials' || reportType === 'osv_products')) return '';
        const units = Array.from(new Set((rows || []).map((r) => String(r.unit || '').trim()).filter(Boolean)));
        return units.length === 1 ? units[0] : '';
    })();
    const salesTotalsUnit = (() => {
        if (reportType !== 'sales_analytics') return '';
        const units = Array.from(new Set((rows || []).map((r) => String(r.unit || '').trim()).filter(Boolean)));
        return units.length === 1 ? units[0] : '';
    })();

    table.classList.toggle('reports-table-osv', osvLike);
    table.classList.toggle('reports-table-register', !osvLike);
    table.dataset.reportType = reportType;

    const osvCounterpartyHead = reportType === 'osv_counterparties'
        ? reportsBuildOsvCounterpartyHeadRows(data, cols, numericCols)
        : '';
    const osvCashHead = reportType === 'osv_cash_accounts'
        ? reportsBuildOsvCashHeadRows(data, cols, numericCols)
        : '';
    const osvStockHead = (reportType === 'osv_materials' || reportType === 'osv_products')
        ? reportsBuildOsvStockHeadRows(data, cols, numericCols)
        : '';
    const turnoverHead = reportType === 'turnover_finance'
        ? reportsBuildTurnoverFinanceHeadRows(data, cols, numericCols)
        : '';
    const inventoryHead = reportType === 'inventory_register'
        ? reportsBuildInventoryRegisterHeadRows(data, cols, numericCols)
        : '';
    if (osvCounterpartyHead || osvCashHead || osvStockHead || turnoverHead || inventoryHead) {
        head.innerHTML = osvCounterpartyHead || osvCashHead || osvStockHead || turnoverHead || inventoryHead;
    } else {
        const summaryRow = reportsBuildHeadSummaryRow(data, cols.length);
        const labelsRow = `<tr>${cols.map((c, idx) => {
            const cls = `${idx === 0 ? 'reports-col-main ' : ''}${numericCols[idx] ? 'reports-num ' : ''}${reportsPolarityClass(c.key)}`.trim();
            if (reportType === 'sales_analytics') {
                const sortKey = String(c.key || '');
                const active = window.__reportsState.salesAnalyticsSortKey === sortKey;
                const arrow = active ? (window.__reportsState.salesAnalyticsSortDir === 'asc' ? '▲' : '▼') : '';
                return `<th class="${cls}"><button type="button" class="reports-sort-head-btn${active ? ' active' : ''}" data-sort-key="${Utils.escapeHtml(sortKey)}">${Utils.escapeHtml(c.label)}${arrow ? ` <span class="reports-sort-arrow">${arrow}</span>` : ''}</button></th>`;
            }
            return `<th class="${cls}">${Utils.escapeHtml(c.label)}</th>`;
        }).join('')}</tr>`;
        head.innerHTML = `${summaryRow}${labelsRow}`;
    }
    body.innerHTML = rows.length
        ? rows.map((r) => {
            const financeTypeCode = String(r.transaction_type_code || '').trim().toLowerCase();
            const rowClass = (() => {
                if (reportType === 'turnover_finance') {
                    return financeTypeCode === 'income' ? 'reports-row-income' : (financeTypeCode === 'expense' ? 'reports-row-expense' : '');
                }
                if (reportType === 'inventory_register') {
                    const qty = Number(r.quantity || 0);
                    return qty > 0 ? 'reports-row-income' : (qty < 0 ? 'reports-row-expense' : '');
                }
                return '';
            })();
            return `<tr${rowClass ? ` class="${rowClass}"` : ''}>${cols.map((c, idx) => {
            const raw = r[c.key];
            const counterpartyId = Number(r.counterparty_id || 0);
            const accountId = Number(r.account_id || 0);
            const itemId = Number(r.item_id || 0);
            const warehouseId = Number(r.warehouse_id || 0);
            const batchId = Number(r.batch_id || 0);
            const orderId = Number(r.linked_order_id || 0);
            const purchaseId = Number(r.purchase_id || 0);
            const orderDoc = String(r.linked_order_doc || '').trim();
            const movementCode = String(r.movement_type || '').trim().toLowerCase();
            const salesItemId = Number(r.item_id || itemId || 0);
            const turnoverToneClass = reportType === 'turnover_finance'
                ? (financeTypeCode === 'income' ? ' reports-col-debit' : (financeTypeCode === 'expense' ? ' reports-col-credit' : ''))
                : '';
            const financeCategory = String(r.category || '').trim();
            const rowUnit = String(r.unit || '').trim();
            const commonClass = `${idx === 0 ? 'reports-col-main ' : ''}${numericCols[idx] ? 'reports-num ' : ''}${reportsPolarityClass(c.key)}`.trim();
            const numericValue = Number(raw || 0);
            const defaultValueClass = numericCols[idx]
                ? (Math.abs(numericValue) < 0.000001 ? ' reports-num-zero' : (numericValue < 0 ? ' reports-num-neg' : ' reports-num-pos'))
                : '';
            const valueClass = (reportType === 'turnover_finance' && numericCols[idx])
                ? (financeTypeCode === 'expense' ? ' reports-num-neg' : (financeTypeCode === 'income' ? ' reports-num-pos' : defaultValueClass))
                : defaultValueClass;
            const isStockQty = (reportType === 'osv_materials' || reportType === 'osv_products') && /_qty$/i.test(String(c.key || ''));
            const isRegisterQty = reportType === 'inventory_register' && String(c.key || '').toLowerCase() === 'quantity';
            const renderedValue = (() => {
                const base = reportsFormatMetricForReport(raw, c.key, reportType);
                if (reportType === 'sales_analytics') {
                    const suffix = reportsSalesAnalyticsMetricSuffix(c.key, rowUnit || salesTotalsUnit);
                    return suffix ? `${base}${Utils.escapeHtml(suffix)}` : base;
                }
                if (!(isStockQty || isRegisterQty) || !rowUnit) return base;
                return `${base} ${Utils.escapeHtml(rowUnit)}`;
            })();
            if (reportType === 'osv_counterparties' && c.key === 'counterparty') {
                const label = Utils.escapeHtml(raw ?? '');
                return `<td class="${commonClass}"><button type="button" class="reports-cell-link reports-cell-link-main" data-counterparty-id="${counterpartyId}" title="${label}">${label}</button></td>`;
            }
            if (reportType === 'osv_counterparties' && numericCols[idx] && counterpartyId > 0) {
                return `<td class="${commonClass}"><button type="button" class="reports-cell-link reports-num-link${valueClass}" data-counterparty-id="${counterpartyId}" data-col-key="${Utils.escapeHtml(c.key)}" data-col-label="${Utils.escapeHtml(c.label)}">${reportsFormatMetricForReport(raw, c.key, reportType)}</button></td>`;
            }
            if (reportType === 'osv_cash_accounts' && numericCols[idx] && accountId > 0) {
                return `<td class="${commonClass}"><button type="button" class="reports-cell-link reports-num-link${valueClass}" data-account-id="${accountId}" data-col-key="${Utils.escapeHtml(c.key)}" data-col-label="${Utils.escapeHtml(c.label)}">${reportsFormatMetricForReport(raw, c.key, reportType)}</button></td>`;
            }
            if ((reportType === 'osv_materials' || reportType === 'osv_products') && c.key === 'item' && itemId > 0) {
                const label = Utils.escapeHtml(raw ?? '');
                return `<td class="${commonClass}"><button type="button" class="reports-cell-link reports-cell-link-main" data-item-id="${itemId}" title="${label}">${label}</button></td>`;
            }
            if (reportType === 'inventory_register' && c.key === 'item' && itemId > 0) {
                const label = Utils.escapeHtml(raw ?? '');
                return `<td class="${commonClass}"><button type="button" class="reports-cell-link reports-cell-link-main" data-item-id="${itemId}" title="${label}">${label}</button></td>`;
            }
            if ((reportType === 'osv_materials' || reportType === 'osv_products') && numericCols[idx] && itemId > 0 && warehouseId > 0) {
                return `<td class="${commonClass}"><button type="button" class="reports-cell-link reports-num-link${valueClass}" data-item-id="${itemId}" data-warehouse-id="${warehouseId}" data-col-key="${Utils.escapeHtml(c.key)}" data-col-label="${Utils.escapeHtml(c.label)}">${renderedValue}</button></td>`;
            }
            if (reportType === 'inventory_register' && c.key === 'movement_type') {
                return `<td class="${commonClass}">${Utils.escapeHtml(reportsStockMovementLabel(raw || ''))}</td>`;
            }
            if (reportType === 'inventory_register' && c.key === 'batch') {
                const parts = [];
                if (batchId > 0) {
                    const label = Utils.escapeHtml(raw || `#${batchId}`);
                    parts.push(`<button type="button" class="reports-cell-link" data-batch-id="${batchId}" title="${label}">${label}</button>`);
                }
                if (orderId > 0 && (movementCode === 'sales_shipment' || movementCode === 'shipment_reversal')) {
                    const orderLabel = Utils.escapeHtml(orderDoc ? `Заказ ${orderDoc}` : `Заказ #${orderId}`);
                    parts.push(`<button type="button" class="reports-cell-link" data-order-id="${orderId}" title="${orderLabel}">${orderLabel}</button>`);
                }
                if (purchaseId > 0 && movementCode === 'purchase') {
                    const purchaseLabel = Utils.escapeHtml(`Закупка #${purchaseId}`);
                    parts.push(`<button type="button" class="reports-cell-link" data-purchase-id="${purchaseId}" title="${purchaseLabel}">${purchaseLabel}</button>`);
                }
                if (!parts.length) return `<td class="${commonClass}">${Utils.escapeHtml(raw ?? '—')}</td>`;
                return `<td class="${commonClass}"><div class="reports-register-links">${parts.join('')}</div></td>`;
            }
            if (reportType === 'inventory_register' && c.key === 'quantity' && itemId > 0 && warehouseId > 0) {
                return `<td class="${commonClass}"><button type="button" class="reports-cell-link reports-num-link${valueClass}" data-item-id="${itemId}" data-warehouse-id="${warehouseId}" data-col-key="quantity" data-col-label="${Utils.escapeHtml(c.label)}">${renderedValue}</button></td>`;
            }
            if (reportType === 'sales_analytics' && c.key === 'item' && salesItemId > 0) {
                const label = Utils.escapeHtml(raw ?? '');
                const metric = String(window.__reportsState.salesAnalyticsActiveTab || 'summary') === 'forecast' ? 'need_to_produce' : 'sold_qty';
                return `<td class="${commonClass}"><button type="button" class="reports-cell-link reports-cell-link-main" data-sales-item-id="${salesItemId}" data-sales-metric="${Utils.escapeHtml(metric)}" title="${label}">${label}</button></td>`;
            }
            if (reportType === 'sales_analytics' && String(c.key || '') === 'unit_cost_std' && salesItemId > 0) {
                const itemName = r.item || r.item_name || '';
                const reportUnitCost = Number(r.unit_cost_std || 0);
                const soldQty = Number(r.sold_qty || 0);
                const revenueGross = Number(r.revenue_gross || 0);
                return `<td class="${commonClass}"><button type="button" class="reports-cell-link reports-num-link${valueClass}" onclick="reportsOpenCostAnalysisModal(${salesItemId}, '${Utils.escapeHtml(itemName).replace(/'/g, "\\'")}', ${reportUnitCost}, ${soldQty}, ${revenueGross})" title="Открыть калькулятор себестоимости">${renderedValue}</button></td>`;
            }
            if (reportType === 'sales_analytics' && numericCols[idx] && salesItemId > 0) {
                const metricKey = String(c.key || '');
                const drilldownMetricMap = {
                    sold_qty: 'sold_qty',
                    shipped_qty: 'sold_qty',
                    reversed_qty: 'sold_qty',
                    revenue_gross: 'revenue_gross',
                    shipped_revenue: 'revenue_gross',
                    reversed_revenue: 'revenue_gross',
                    gross_profit: 'gross_profit',
                    gross_margin: 'gross_profit',
                    cogs_std: 'gross_profit',
                    unit_cost_std: 'gross_profit',
                    tax_amount: 'revenue_gross',
                    revenue_net: 'revenue_gross',
                    avg_daily_demand: 'forecast_qty',
                    forecast_qty: 'forecast_qty',
                    backlog_qty: 'need_to_produce',
                    stock_qty: 'need_to_produce',
                    need_to_produce: 'need_to_produce',
                    revenue_share: 'revenue_gross',
                    qty_share: 'sold_qty'
                };
                const drillMetric = drilldownMetricMap[metricKey];
                if (drillMetric) return `<td class="${commonClass}"><button type="button" class="reports-cell-link reports-num-link${valueClass}" data-sales-item-id="${salesItemId}" data-sales-metric="${Utils.escapeHtml(drillMetric)}" data-col-label="${Utils.escapeHtml(c.label)}">${renderedValue}</button></td>`;
            }
            if (reportType === 'turnover_finance' && c.key === 'category' && financeCategory) {
                const label = Utils.escapeHtml(financeCategory);
                return `<td class="${commonClass}"><button type="button" class="reports-cell-link reports-cell-link-main" data-finance-category="${label}" title="${label}">${label}</button></td>`;
            }
            if (reportType === 'turnover_finance' && c.key === 'transaction_type') {
                return `<td class="${commonClass}${turnoverToneClass}">${Utils.escapeHtml(raw ?? '')}</td>`;
            }
            if (reportType === 'turnover_finance' && numericCols[idx] && financeCategory) {
                return `<td class="${commonClass}${turnoverToneClass}"><button type="button" class="reports-cell-link reports-num-link${valueClass}" data-finance-type="${Utils.escapeHtml(financeTypeCode)}" data-finance-category="${Utils.escapeHtml(financeCategory)}" data-col-key="${Utils.escapeHtml(c.key)}" data-col-label="${Utils.escapeHtml(c.label)}">${renderedValue}</button></td>`;
            }
            if (reportType === 'sales_analytics') {
                return `<td class="${commonClass}${valueClass}${turnoverToneClass}">${renderedValue}</td>`;
            }
            return `<td class="${commonClass}${valueClass}${turnoverToneClass}">${numericCols[idx] ? renderedValue : Utils.escapeHtml(raw ?? '')}</td>`;
        }).join('')}</tr>`;
        }).join('')
        : `<tr><td colspan="${Math.max(cols.length, 1)}" class="text-muted">Нет данных</td></tr>`;

    if (tableTotals && Object.keys(tableTotals).length && cols.length) {
        foot.innerHTML = `<tr>${cols.map((c, idx) => {
            if (idx === 0) return '<th class="reports-col-main">Итого</th>';
            const val = tableTotals[c.key];
            const cls = `${numericCols[idx] ? 'reports-num ' : ''}${reportsPolarityClass(c.key)}`.trim();
            if (val === undefined) return `<th class="${cls}"></th>`;
            const metricKey = String(c.key || '').toLowerCase();
            const isStockQtyTotal = (reportType === 'osv_materials' || reportType === 'osv_products') && /_qty$/.test(metricKey);
            const rendered = reportsFormatMetricForReport(val, c.key, reportType);
            if (reportType === 'sales_analytics') {
                const suffix = reportsSalesAnalyticsMetricSuffix(c.key, salesTotalsUnit);
                return `<th class="${cls}">${suffix ? `${rendered}${Utils.escapeHtml(suffix)}` : rendered}</th>`;
            }
            return `<th class="${cls}">${isStockQtyTotal && stockTotalsUnit ? `${rendered} ${Utils.escapeHtml(stockTotalsUnit)}` : rendered}</th>`;
        }).join('')}</tr>`;
    } else {
        foot.innerHTML = '';
    }

    if (osvLike) {
        totals.classList.add('d-none');
        totals.innerHTML = '';
    } else if (data.totals && Object.keys(data.totals).length) {
        totals.classList.remove('d-none');
        totals.innerHTML = Object.entries(data.totals)
            .map(([k, v]) => {
                if (reportType === 'sales_analytics') {
                    const base = reportsFormatMetricForReport(v, k, reportType);
                    const suffix = reportsSalesAnalyticsMetricSuffix(k, salesTotalsUnit);
                    return `<span class="reports-total-chip">${Utils.escapeHtml(reportsTotalLabel(k))}: <strong>${suffix ? `${base}${Utils.escapeHtml(suffix)}` : base}</strong></span>`;
                }
                return `<span class="reports-total-chip">${Utils.escapeHtml(reportsTotalLabel(k))}: <strong>${reportsFormatMetric(v, k)}</strong></span>`;
            })
            .join('');
    } else {
        totals.classList.remove('d-none');
        totals.innerHTML = '';
    }

    if (warning) {
        const warnings = Array.isArray(data.warnings) ? data.warnings.filter(Boolean) : [];
        const preflight = data.preflight || null;
        let preflightBlock = [];
        if (preflight) {
            const status = String(preflight.status || '').toLowerCase();
            const reasons = Array.isArray(preflight.reasons) ? preflight.reasons.filter(Boolean) : [];
            const hasRealIssue = status === 'warning' || status === 'blocked' || reasons.length > 0;
            if (hasRealIssue) {
                preflightBlock = [`Проверка перед формированием: ${reportsFormatRunPreflight(preflight.status || '') || 'неизвестно'}${preflight.mode ? ` (${preflight.mode})` : ''}`]
                    .concat(reasons);
            }
        }
        const allWarnings = warnings.concat(preflightBlock);
        if (allWarnings.length) {
            warning.classList.remove('d-none');
            warning.innerHTML = allWarnings.map((w) => `<div>${Utils.escapeHtml(w)}</div>`).join('');
        } else {
            warning.classList.add('d-none');
            warning.textContent = '';
        }
    }

    if (data.pagination) {
        const p = data.pagination;
        if (meta.textContent) meta.textContent += ' | ';
        meta.textContent += `стр. ${p.page}/${p.totalPages}, строк: ${p.totalRows}`;
    }
    const pagBar = document.getElementById('reports-pagination-bar');
    if (pagBar) pagBar.classList.toggle('reports-hidden', !data.pagination);
    if (!osvLike && data.consistency && Array.isArray(data.consistency.checks) && data.consistency.checks.length) {
        const badge = data.consistency.status === 'ok' ? 'Консистентность: OK' : 'Консистентность: есть замечания';
        totals.innerHTML = `<span class="reports-total-chip"><strong>${Utils.escapeHtml(badge)}</strong></span>` + totals.innerHTML;
    }
    reportsSyncSalesAnalyticsSecondaryToolbars();
    requestAnimationFrame(reportsAfterReportsLayout);
}

window.reportsSetQuick = function(mode) {
    reportsApplyPeriodFromMode(mode, reportsGetAnchorDate(), true);
};

function reportsFillSelect(id, rows, labelKey = 'name', valueKey = 'id') {
    const el = document.getElementById(id);
    if (!el) return;
    const current = el.value;
    const normalized = (rows || []).map((r) => ({
        value: String(r[valueKey] ?? ''),
        text: String(r[labelKey] ?? '')
    }));
    if (el.tomselect) {
        const ts = el.tomselect;
        ts.clearOptions();
        ts.addOption({ value: '', text: 'Все' });
        normalized.forEach((r) => ts.addOption(r));
        ts.refreshOptions(false);
        if (current) ts.setValue(String(current), true);
        else ts.clear(true);
        return;
    }
    const base = '<option value="">Все</option>';
    const options = normalized.map((r) => `<option value="${Utils.escapeHtml(r.value)}">${Utils.escapeHtml(r.text)}</option>`).join('');
    el.innerHTML = base + options;
    if (current) el.value = current;
}

function reportsInitCounterpartySearch() {
    const el = document.getElementById('reports-filter-counterparty');
    if (!el || el.tomselect || typeof TomSelect === 'undefined') return;
    const syncSelectedTitle = (ts) => {
        if (!ts || !ts.control) return;
        const item = ts.control.querySelector('.item');
        if (item) item.title = (item.textContent || '').trim();
    };
    const ts = new TomSelect(el, {
        plugins: ['clear_button'],
        searchField: ['text'],
        dropdownParent: 'body',
        allowEmptyOption: true,
        placeholder: 'Все',
        onInitialize() { syncSelectedTitle(this); },
        onChange(value) {
            if (value === '') this.clear(true);
            syncSelectedTitle(this);
        }
    });
    ts.clear(true);
    syncSelectedTitle(ts);
}

function reportsAccountOrderWeight(name) {
    const n = String(name || '').toLowerCase();
    if (n.includes('касса')) return 0;
    if (n.includes('точка')) return 1;
    if (n.includes('альфа') || n.includes('alpha')) return 2;
    if (n.includes('подотч')) return 4;
    return 3;
}

function reportsInitAccountSearch() {
    const el = document.getElementById('reports-filter-account');
    if (!el || el.tomselect || typeof TomSelect === 'undefined') return;
    new TomSelect(el, {
        plugins: ['clear_button'],
        allowEmptyOption: true,
        maxOptions: 1000,
        searchField: ['text'],
        sortField: [{ field: '$order', direction: 'asc' }],
        render: {
            option(item, escape) {
                return `<div title="${escape(item.text)}">${escape(item.text)}</div>`;
            },
            item(item, escape) {
                return `<div title="${escape(item.text)}">${escape(item.text)}</div>`;
            }
        }
    });
}

function reportsSetSelectValue(id, value) {
    const el = document.getElementById(id);
    if (!el) return;
    const v = value == null ? '' : String(value);
    if (el.tomselect) el.tomselect.setValue(v, true);
    else el.value = v;
}

function reportsSyncSalesAnalyticsSecondaryToolbars() {
    const type = document.getElementById('reports-type')?.value || '';
    const tabFromState = window.__reportsState?.salesAnalyticsActiveTab;
    const tabFromInput = document.getElementById('reports-filter-analytics-tab')?.value;
    const tab = String((tabFromState != null && tabFromState !== '') ? tabFromState : tabFromInput || 'summary').trim();
    const topnBar = document.getElementById('reports-sales-analytics-topn-toolbar');
    const fhBar = document.getElementById('reports-sa-forecast-horizon-bar');
    if (topnBar) topnBar.classList.toggle('reports-hidden', type !== 'sales_analytics');
    if (fhBar) fhBar.classList.toggle('reports-hidden', type !== 'sales_analytics' || tab !== 'forecast');
}

function reportsApplyFilterVisibility() {
    const type = document.getElementById('reports-type')?.value || '';
    const reportsMod = document.getElementById('reports-mod');
    if (reportsMod) {
        reportsMod.classList.remove('reports-type-osv_counterparties', 'reports-type-osv_cash_accounts', 'reports-type-osv_materials', 'reports-type-osv_products', 'reports-type-turnover_finance', 'reports-type-inventory_register', 'reports-type-sales_analytics');
        reportsMod.classList.add(`reports-type-${type}`);
    }
    const map = {
        'reports-filter-counterparty': ['osv_counterparties'],
        'reports-filter-nonzero': ['osv_counterparties'],
        'reports-filter-account': ['osv_cash_accounts'],
        'reports-filter-account-movement': ['osv_cash_accounts'],
        'reports-filter-stock-balance': ['osv_materials', 'osv_products'],
        'reports-filter-stock-valuation': ['osv_materials', 'osv_products'],
        'reports-filter-item': ['osv_materials', 'osv_products', 'inventory_register', 'sales_analytics'],
        'reports-filter-warehouse': ['inventory_register', 'osv_products'],
        'reports-filter-movement-type': ['inventory_register'],
        'reports-filter-transaction-type': ['turnover_finance'],
        'reports-filter-include-returns': ['sales_analytics'],
        'reports-filter-include-overhead': ['sales_analytics'],
        'reports-filter-overhead-rate': ['sales_analytics'],
        'reports-filter-include-taxes': ['sales_analytics'],
        'reports-filter-tax-rate': ['sales_analytics']
    };
    const resetValueById = {
        'reports-filter-nonzero': 'nonzero',
        'reports-filter-account-movement': 'all',
        'reports-filter-stock-balance': 'nonzero',
        'reports-filter-stock-valuation': 'movement_actual',
        'reports-filter-warehouse': '',
        'reports-filter-topn': '20',
        'reports-filter-overhead-rate': reportsFmtOverheadInput(reportsDefaultOverheadRate()),
        'reports-filter-tax-rate': String(reportsDefaultSalesTaxRate())
    };
    Object.entries(map).forEach(([id, allowed]) => {
        const el = document.getElementById(id);
        if (!el || !el.closest('.form-group')) return;
        const fg = el.closest('.form-group');
        if (allowed.includes(type)) fg.classList.remove('reports-hidden');
        else {
            fg.classList.add('reports-hidden');
            if (el.type === 'checkbox') {
                const isIncludeTaxes = id === 'reports-filter-include-taxes';
                el.checked = !isIncludeTaxes;
            } else {
                el.value = Object.prototype.hasOwnProperty.call(resetValueById, id) ? resetValueById[id] : '';
            }
        }
    });
    reportsSyncSalesAnalyticsSecondaryToolbars();
    const warehouse = document.getElementById('reports-filter-warehouse');
    if (warehouse) {
        const selected = warehouse.value;
        const opts = Array.from(warehouse.options || []);
        opts.forEach((opt) => {
            if (!opt.value) return;
            const reportsAttr = String(opt.dataset.reports || '');
            const allowed = reportsAttr.split(',').map((x) => x.trim()).filter(Boolean);
            const visible = allowed.length === 0 || allowed.includes(type);
            opt.hidden = !visible;
        });
        if (selected && warehouse.selectedOptions[0]?.hidden) warehouse.value = '';
    }
    const excludeEmployeesWrap = document.getElementById('reports-filter-exclude-employees-wrap');
    const excludeEmployeesCheckbox = document.getElementById('reports-filter-exclude-employees');
    if (excludeEmployeesWrap) {
        const visible = type === 'osv_counterparties';
        excludeEmployeesWrap.classList.toggle('reports-hidden', !visible);
        if (!visible && excludeEmployeesCheckbox) excludeEmployeesCheckbox.checked = true;
    }
    const tabInput = document.getElementById('reports-filter-analytics-tab');
    if (tabInput && type !== 'sales_analytics') tabInput.value = 'summary';
    reportsSyncCounterpartyBalanceHint();
    reportsSyncRegulatoryFilters();
    requestAnimationFrame(reportsAfterReportsLayout);
}

function reportsDrilldownRangeLabel(rangeMode = 'period') {
    if (rangeMode === 'opening') return 'до начала периода';
    if (rangeMode === 'closing') return 'с начала учета по дату конца периода';
    if (rangeMode === 'all_time') return 'за весь период учета';
    return 'за выбранный период';
}

function reportsStockMovementLabel(code) {
    const movementMap = {
        receipt: 'Поступление',
        expense: 'Списание',
        sale: 'Реализация (отгрузка)',
        prod_receipt: 'Производство (продукция)',
        prod_expense: 'Списание в производство',
        audit: 'Инвентаризация',
        move_in: 'Перемещение (приход)',
        move_out: 'Перемещение (расход)',
        scrap: 'Списание (утиль/брак)',
        demold_receipt: 'Распалубка: приход',
        demold_scrap: 'Распалубка: брак',
        demold_expense: 'Распалубка: списание',
        sifting_receipt: 'Просеивание: выход',
        sifting_expense: 'Просеивание: исходник списан',
        purchase: 'Закупка (поступление)',
        initial: 'Ввод начальных остатков',
        audit_adjustment: 'Инвентаризация (корректировка)',
        production_expense: 'Списание в производство',
        production_receipt: 'Выпуск продукции (формовка)',
        production_draft: 'Замес (черновик)',
        wip_receipt: 'Поступление в сушилку',
        wip_expense: 'Списание из сушилки',
        finished_receipt: 'Принято на склад',
        markdown_receipt: 'Перевод в уценку (2-й сорт)',
        reserve_receipt: 'Возврат из резерва',
        reserve_expense: 'Резервирование (списание)',
        reserve_transfer_in: 'Перемещение в резерв (приход)',
        reserve_transfer_out: 'Перемещение в резерв (расход)',
        customer_return: 'Возврат от клиента',
        sales_shipment: 'Отгрузка клиенту',
        shipment_reversal: 'Отмена отгрузки',
        manual_adjustment: 'Ручная корректировка',
        adjustment: 'Корректировка',
        revision: 'Ревизия'
    };
    const key = String(code || '').trim();
    if (!key) return 'Операция';
    if (movementMap[key]) return movementMap[key];
    if (/^[a-z0-9_]+$/i.test(key)) return 'Системная операция';
    return key;
}

window.reportsOpenCounterpartyDrilldown = async function(counterpartyId, colKey, colLabel) {
    const payload = window.__reportsState.lastPayload || reportsBuildPayload();
    if (!counterpartyId || !payload?.dateFrom || !payload?.dateTo) return;
    try {
        const metricMap = {
            debit_turnover: 'payment_in',
            credit_turnover: 'payment_out'
        };
        const metric = metricMap[String(colKey || '')] || String(colKey || '');
        const qs = new URLSearchParams({
            counterpartyId: String(counterpartyId),
            dateFrom: String(payload.dateFrom),
            dateTo: String(payload.dateTo),
            metric
        });
        const data = await API.get(`/api/reports/counterparty-drilldown?${qs.toString()}`);
        const rows = Array.isArray(data.rows) ? data.rows : [];
        const renderLinkedDoc = (r) => {
            const orderId = Number(r.linkedOrderId || 0);
            const purchaseId = Number(r.linkedPurchaseId || 0);
            if (orderId > 0) {
                return `<button type="button" class="reports-cell-link" onclick="window.app && window.app.openEntity && window.app.openEntity('document_order', ${orderId})">Заказ #${orderId}</button>`;
            }
            if (purchaseId > 0) {
                return `<button type="button" class="reports-cell-link" onclick="reportsOpenPurchaseFromDrilldown(${purchaseId})">Закупка #${purchaseId}</button>`;
            }
            if (r.sourceModule) return Utils.escapeHtml(String(r.sourceModule));
            return '—';
        };
        const rowsHtml = rows.length
            ? rows.map((r) => `
                <tr class="${r.typeCode === 'income' ? 'reports-dd-row-income' : 'reports-dd-row-expense'}">
                    <td class="reports-dd-col-date">${Utils.escapeHtml(r.date || '')}</td>
                    <td class="reports-dd-col-type reports-dd-type-cell">${Utils.escapeHtml(r.type || '')}</td>
                    <td class="text-right reports-dd-col-amount">${Utils.escapeHtml(reportsFormatMetric(r.amount || 0, 'amount'))}</td>
                    <td class="reports-dd-col-account">${Utils.escapeHtml(r.account || '')}</td>
                    <td class="reports-dd-col-category">${Utils.escapeHtml(r.category || '')}</td>
                    <td class="reports-dd-col-base">${renderLinkedDoc(r)}</td>
                    <td class="reports-dd-col-note">${Utils.escapeHtml(r.note || '')}</td>
                </tr>
            `).join('')
            : '<tr><td colspan="7" class="text-muted">По условиям выборки операций не найдено</td></tr>';
        UI.showModal(
            `История формирования: ${Utils.escapeHtml(colLabel || colKey || 'показатель')}`,
            `
                <div class="mb-10">
                    <div><strong>Контрагент:</strong> ${Utils.escapeHtml(data.counterpartyName || '')}</div>
                    <div class="text-muted font-12">Показаны операции ${Utils.escapeHtml(reportsDrilldownRangeLabel(data.rangeMode))}. Найдено: ${Utils.escapeHtml(rows.length)}</div>
                </div>
                <div class="reports-preview-scroll">
                    <table class="data-table reports-drilldown-table">
                        <thead>
                            <tr>
                                <th class="reports-dd-col-date">Дата</th>
                                <th class="reports-dd-col-type">Тип</th>
                                <th class="reports-dd-col-amount">Сумма</th>
                                <th class="reports-dd-col-account">Счет</th>
                                <th class="reports-dd-col-category">Статья</th>
                                <th class="reports-dd-col-base">Основание</th>
                                <th class="reports-dd-col-note">Комментарий</th>
                            </tr>
                        </thead>
                        <tbody>${rowsHtml}</tbody>
                    </table>
                </div>
            `,
            `
                <button class="btn btn-outline" onclick="UI.closeModal()">Закрыть</button>
                <button class="btn btn-blue" onclick="reportsApplyCounterpartyFromDrilldown(${Number(counterpartyId)})">Показать только этого контрагента</button>
            `
        );
    } catch (err) {
        UI.toast(err.message || 'Ошибка загрузки расшифровки', 'error');
    }
};

window.reportsOpenAccountDrilldown = async function(accountId, colKey, colLabel) {
    const payload = window.__reportsState.lastPayload || reportsBuildPayload();
    if (!accountId || !payload?.dateFrom || !payload?.dateTo) return;
    try {
        const qs = new URLSearchParams({
            accountId: String(accountId),
            dateFrom: String(payload.dateFrom),
            dateTo: String(payload.dateTo),
            metric: String(colKey || '')
        });
        const data = await API.get(`/api/reports/account-drilldown?${qs.toString()}`);
        const rows = Array.isArray(data.rows) ? data.rows : [];
        const renderLinkedDoc = (r) => {
            const orderId = Number(r.linkedOrderId || 0);
            const purchaseId = Number(r.linkedPurchaseId || 0);
            if (orderId > 0) {
                return `<button type="button" class="reports-cell-link" onclick="window.app && window.app.openEntity && window.app.openEntity('document_order', ${orderId})">Заказ #${orderId}</button>`;
            }
            if (purchaseId > 0) {
                return `<button type="button" class="reports-cell-link" onclick="reportsOpenPurchaseFromDrilldown(${purchaseId})">Закупка #${purchaseId}</button>`;
            }
            if (r.sourceModule) return Utils.escapeHtml(String(r.sourceModule));
            return '—';
        };
        const rowsHtml = rows.length
            ? rows.map((r) => `
                <tr class="${r.typeCode === 'income' ? 'reports-dd-row-income' : 'reports-dd-row-expense'}">
                    <td class="reports-dd-col-date">${Utils.escapeHtml(r.date || '')}</td>
                    <td class="reports-dd-col-type reports-dd-type-cell">${Utils.escapeHtml(r.type || '')}</td>
                    <td class="text-right reports-dd-col-amount">${Utils.escapeHtml(reportsFormatMetric(r.amount || 0, 'amount'))}</td>
                    <td class="reports-dd-col-account">${Utils.escapeHtml(r.account || '')}</td>
                    <td class="reports-dd-col-category">${Utils.escapeHtml(r.category || '')}</td>
                    <td class="reports-dd-col-base">${renderLinkedDoc(r)}</td>
                    <td class="reports-dd-col-note">${Utils.escapeHtml(r.note || '')}</td>
                </tr>
            `).join('')
            : '<tr><td colspan="7" class="text-muted">По условиям выборки операций не найдено</td></tr>';
        UI.showModal(
            `История формирования: ${Utils.escapeHtml(colLabel || colKey || 'показатель')}`,
            `
                <div class="mb-10">
                    <div><strong>Счет/Касса:</strong> ${Utils.escapeHtml(data.accountName || '')}</div>
                    <div class="text-muted font-12">Показаны операции ${Utils.escapeHtml(reportsDrilldownRangeLabel(data.rangeMode))}. Найдено: ${Utils.escapeHtml(rows.length)}</div>
                </div>
                <div class="reports-preview-scroll">
                    <table class="data-table reports-drilldown-table">
                        <thead>
                            <tr>
                                <th class="reports-dd-col-date">Дата</th>
                                <th class="reports-dd-col-type">Тип</th>
                                <th class="reports-dd-col-amount">Сумма</th>
                                <th class="reports-dd-col-account">Счет</th>
                                <th class="reports-dd-col-category">Статья</th>
                                <th class="reports-dd-col-base">Основание</th>
                                <th class="reports-dd-col-note">Комментарий</th>
                            </tr>
                        </thead>
                        <tbody>${rowsHtml}</tbody>
                    </table>
                </div>
            `,
            `<button class="btn btn-outline" onclick="UI.closeModal()">Закрыть</button>`
        );
    } catch (err) {
        UI.toast(err.message || 'Ошибка загрузки расшифровки счета', 'error');
    }
};

window.reportsOpenStockDrilldown = async function(itemId, warehouseId, colKey, colLabel) {
    const payload = window.__reportsState.lastPayload || reportsBuildPayload();
    if (!itemId || !warehouseId || !payload?.dateFrom || !payload?.dateTo) return;
    try {
        const qs = new URLSearchParams({
            itemId: String(itemId),
            warehouseId: String(warehouseId),
            dateFrom: String(payload.dateFrom),
            dateTo: String(payload.dateTo),
            metric: String(colKey || '')
        });
        const data = await API.get(`/api/reports/stock-drilldown?${qs.toString()}`);
        const rows = Array.isArray(data.rows) ? data.rows : [];
        const renderBatchCell = (r) => {
            const batchId = Number(r.batchId || 0);
            const label = String(r.batch || '').trim();
            if (!batchId) return Utils.escapeHtml(label || '—');
            return `<button type="button" class="reports-cell-link" onclick="reportsOpenBatchFromDrilldown(${batchId})">${Utils.escapeHtml(label || `#${batchId}`)}</button>`;
        };
        const renderStockBase = (r) => {
            const parts = [];
            const linkedOrderId = Number(r.linkedOrderId || 0);
            const linkedOrderDoc = String(r.linkedOrderDoc || '').trim();
            const movementCode = String(r.type || '').toLowerCase();
            if (linkedOrderId > 0) {
                const kind = movementCode === 'sales_shipment' || movementCode === 'shipment_reversal' ? 'Отгрузка' : 'Заказ';
                const suffix = linkedOrderDoc ? ` ${Utils.escapeHtml(linkedOrderDoc)}` : ` #${linkedOrderId}`;
                parts.push(`<button type="button" class="reports-cell-link" onclick="if (window.app && window.app.openEntity) window.app.openEntity('document_order', ${linkedOrderId})">${kind}${suffix}</button>`);
            }
            if (parts.length) return parts.join('<br>');
            return Utils.escapeHtml(reportsStockMovementLabel(r.source));
        };
        const rowsHtml = rows.length
            ? rows.map((r) => `
                <tr class="${Number(r.quantity || 0) >= 0 ? 'reports-dd-row-income' : 'reports-dd-row-expense'}">
                    <td class="reports-dd-col-date">${Utils.escapeHtml(r.date || '')}</td>
                    <td class="reports-dd-col-type reports-dd-type-cell">${Utils.escapeHtml(reportsStockMovementLabel(r.type))}</td>
                    <td class="text-right reports-dd-col-amount">${Utils.escapeHtml(reportsFormatMetric(r.quantity || 0, 'quantity'))}</td>
                    <td class="reports-dd-col-account">${Utils.escapeHtml(r.warehouse || '')}</td>
                    <td class="reports-dd-col-category">${renderBatchCell(r)}</td>
                    <td class="reports-dd-col-base">${renderStockBase(r)}</td>
                    <td class="reports-dd-col-note">${Utils.escapeHtml(r.note || '')}</td>
                </tr>
            `).join('')
            : '<tr><td colspan="7" class="text-muted">По условиям выборки движений не найдено</td></tr>';
        UI.showModal(
            `Расшифровка показателя: ${Utils.escapeHtml(colLabel || colKey || 'показатель')}`,
            `
                <div class="mb-10">
                    <div><strong>Номенклатура:</strong> ${Utils.escapeHtml(data.itemName || '')}</div>
                    <div><strong>Склад:</strong> ${Utils.escapeHtml(data.warehouseName || '')}</div>
                    <div class="text-muted font-12">Показаны движения ${Utils.escapeHtml(reportsDrilldownRangeLabel(data.rangeMode))}. Найдено: ${Utils.escapeHtml(rows.length)}</div>
                </div>
                <div class="reports-preview-scroll">
                    <table class="data-table reports-drilldown-table">
                        <thead>
                            <tr>
                                <th class="reports-dd-col-date">Дата</th>
                                <th class="reports-dd-col-type">Тип</th>
                                <th class="reports-dd-col-amount">Кол-во</th>
                                <th class="reports-dd-col-account">Склад</th>
                                <th class="reports-dd-col-category">Партия</th>
                                <th class="reports-dd-col-base">Источник</th>
                                <th class="reports-dd-col-note">Комментарий</th>
                            </tr>
                        </thead>
                        <tbody>${rowsHtml}</tbody>
                    </table>
                </div>
            `,
            `<button class="btn btn-outline" onclick="UI.closeModal()">Закрыть</button>`
        );
    } catch (err) {
        UI.toast(err.message || 'Ошибка загрузки расшифровки движений', 'error');
    }
};

window.reportsOpenPurchaseFromDrilldown = function(purchaseId) {
    const id = Number(purchaseId || 0);
    if (!id) return;
    if (typeof window.switchModule === 'function') window.switchModule('purchase-mod');
    setTimeout(() => {
        if (typeof editPurchase === 'function') {
            editPurchase(id);
            return;
        }
        UI.toast(`Откройте закупку #${id} в модуле «Закупки»`, 'info');
    }, 180);
};

window.reportsOpenFinanceDrilldown = async function(typeCode, category, colKey, colLabel) {
    const payload = window.__reportsState.lastPayload || reportsBuildPayload();
    if (!payload?.dateFrom || !payload?.dateTo) return;
    try {
        const filters = payload.filters || {};
        const qs = new URLSearchParams({
            dateFrom: String(payload.dateFrom),
            dateTo: String(payload.dateTo),
            typeCode: String(typeCode || ''),
            category: String(category || ''),
            accountingMode: String(payload.accountingMode || 'managerial'),
            regOnlyPosted: String(filters.regOnlyPosted !== false),
            regOnlyPrimaryDoc: String(Boolean(filters.regOnlyPrimaryDoc)),
            regRequireDocumentNo: String(Boolean(filters.regRequireDocumentNo)),
            regExcludeOffset: String(filters.regExcludeOffset !== false),
            regExcludeTechnical: String(filters.regExcludeTechnical !== false),
            regSourceTag: String(filters.regSourceTag || '')
        });
        const data = await API.get(`/api/reports/finance-drilldown?${qs.toString()}`);
        const rows = Array.isArray(data.rows) ? data.rows : [];
        const renderLinkedDoc = (r) => {
            const orderId = Number(r.linkedOrderId || 0);
            const purchaseId = Number(r.linkedPurchaseId || 0);
            if (orderId > 0) {
                return `<button type="button" class="reports-cell-link" onclick="window.app && window.app.openEntity && window.app.openEntity('document_order', ${orderId})">Заказ #${orderId}</button>`;
            }
            if (purchaseId > 0) {
                return `<button type="button" class="reports-cell-link" onclick="reportsOpenPurchaseFromDrilldown(${purchaseId})">Закупка #${purchaseId}</button>`;
            }
            if (r.sourceModule) return Utils.escapeHtml(String(r.sourceModule));
            return '—';
        };
        const rowsHtml = rows.length
            ? rows.map((r) => `
                <tr class="${r.typeCode === 'income' ? 'reports-dd-row-income' : 'reports-dd-row-expense'}">
                    <td class="reports-dd-col-date">${Utils.escapeHtml(r.date || '')}</td>
                    <td class="reports-dd-col-type reports-dd-type-cell">${Utils.escapeHtml(r.type || '')}</td>
                    <td class="text-right reports-dd-col-amount">${Utils.escapeHtml(reportsFormatMetric(r.amount || 0, 'amount'))}</td>
                    <td class="reports-dd-col-account">${Utils.escapeHtml(r.account || '')}</td>
                    <td class="reports-dd-col-category">${Utils.escapeHtml(r.category || '')}</td>
                    <td class="reports-dd-col-base">${renderLinkedDoc(r)}</td>
                    <td class="reports-dd-col-note">${Utils.escapeHtml(r.note || '')}</td>
                </tr>
            `).join('')
            : '<tr><td colspan="7" class="text-muted">По условиям выборки операций не найдено</td></tr>';
        UI.showModal(
            `История формирования: ${Utils.escapeHtml(colLabel || colKey || 'показатель')}`,
            `
                <div class="mb-10">
                    <div><strong>Статья:</strong> ${Utils.escapeHtml(String(category || '—'))}</div>
                    <div><strong>Тип:</strong> ${Utils.escapeHtml(typeCode === 'income' ? 'Доход' : (typeCode === 'expense' ? 'Расход' : 'Все'))}</div>
                    <div class="text-muted font-12">Показаны операции ${Utils.escapeHtml(reportsDrilldownRangeLabel(data.rangeMode))}. Найдено: ${Utils.escapeHtml(rows.length)}</div>
                </div>
                <div class="reports-preview-scroll">
                    <table class="data-table reports-drilldown-table">
                        <thead>
                            <tr>
                                <th class="reports-dd-col-date">Дата</th>
                                <th class="reports-dd-col-type">Тип</th>
                                <th class="reports-dd-col-amount">Сумма</th>
                                <th class="reports-dd-col-account">Счет</th>
                                <th class="reports-dd-col-category">Статья</th>
                                <th class="reports-dd-col-base">Основание</th>
                                <th class="reports-dd-col-note">Комментарий</th>
                            </tr>
                        </thead>
                        <tbody>${rowsHtml}</tbody>
                    </table>
                </div>
            `,
            `<button class="btn btn-outline" onclick="UI.closeModal()">Закрыть</button>`
        );
    } catch (err) {
        UI.toast(err.message || 'Ошибка загрузки расшифровки финстатьи', 'error');
    }
};

window.reportsOpenSalesAnalyticsDrilldown = async function(itemId, metric, metricLabel) {
    const payload = window.__reportsState.lastPayload || reportsBuildPayload();
    if (!itemId || !payload?.dateFrom || !payload?.dateTo) return;
    try {
        const qs = new URLSearchParams({
            itemId: String(itemId),
            metric: String(metric || 'sold_qty'),
            dateFrom: String(payload.dateFrom),
            dateTo: String(payload.dateTo)
        });
        const data = await API.get(`/api/reports/sales-analytics-drilldown?${qs.toString()}`);
        const rows = Array.isArray(data.rows) ? data.rows : [];
        const rowsHtml = rows.length
            ? rows.map((r) => `
                <tr class="${r.typeCode === 'income' ? 'reports-dd-row-income' : 'reports-dd-row-expense'}">
                    <td class="reports-dd-col-date">${Utils.escapeHtml(r.date || '')}</td>
                    <td class="reports-dd-col-type">${Utils.escapeHtml(r.type || '')}</td>
                    <td class="text-right reports-dd-col-amount">${Utils.escapeHtml(reportsFormatMetric(r.qty || 0, 'quantity_sum'))} ${Utils.escapeHtml(r.unit || '')}</td>
                    <td class="text-right reports-dd-col-amount">${Utils.escapeHtml(reportsFormatMetric(r.amount || 0, 'amount_sum'))}</td>
                    <td class="reports-dd-col-base">${r.orderId > 0 ? `<button type="button" class="reports-cell-link" onclick="window.app && window.app.openEntity && window.app.openEntity('document_order', ${Number(r.orderId)})">${Utils.escapeHtml(r.orderDoc ? `Заказ ${r.orderDoc}` : `Заказ #${r.orderId}`)}</button>` : '—'}</td>
                    <td class="reports-dd-col-category">${Utils.escapeHtml(r.counterparty || '')}</td>
                    <td class="reports-dd-col-note">${Utils.escapeHtml(r.note || '')}</td>
                </tr>
            `).join('')
            : '<tr><td colspan="7" class="text-muted">По условиям выборки операций не найдено</td></tr>';
        UI.showModal(
            `Детализация аналитики: ${Utils.escapeHtml(metricLabel || metric || 'показатель')}`,
            `
                <div class="mb-10">
                    <div><strong>Номенклатура:</strong> ${Utils.escapeHtml(data.itemName || '')}</div>
                    <div class="text-muted font-12">Период: ${Utils.escapeHtml(payload.dateFrom)} - ${Utils.escapeHtml(payload.dateTo)}. Найдено: ${Utils.escapeHtml(rows.length)}</div>
                </div>
                <div class="reports-preview-scroll">
                    <table class="data-table reports-drilldown-table">
                        <thead>
                            <tr>
                                <th class="reports-dd-col-date">Дата</th>
                                <th class="reports-dd-col-type">Тип</th>
                                <th class="reports-dd-col-amount">Количество</th>
                                <th class="reports-dd-col-amount">Сумма</th>
                                <th class="reports-dd-col-base">Заказ</th>
                                <th class="reports-dd-col-category">Контрагент</th>
                                <th class="reports-dd-col-note">Комментарий</th>
                            </tr>
                        </thead>
                        <tbody>${rowsHtml}</tbody>
                    </table>
                </div>
            `,
            `<button class="btn btn-outline" onclick="UI.closeModal()">Закрыть</button>`
        );
    } catch (err) {
        UI.toast(err.message || 'Ошибка расшифровки аналитики продаж', 'error');
    }
};

window.reportsOpenBatchFromDrilldown = function(batchId) {
    const id = Number(batchId || 0);
    if (!id) return;
    const batchModal = document.getElementById('modal-batch-stats');
    if (batchModal) batchModal.classList.add('reports-batch-modal-front');
    const batchCardModal = document.getElementById('modal-batch-card');
    if (batchCardModal) batchCardModal.classList.add('reports-batch-card-modal-front');
    if (typeof window.openBatchStatsModal === 'function') {
        window.openBatchStatsModal(id, id);
        return;
    }
    UI.toast(`Откройте партию #${id} в модуле «Склад»`, 'info');
};

window.reportsOpenItemCard = function(itemId) {
    const id = Number(itemId || 0);
    if (!id) return;
    let tries = 0;
    const run = () => {
        tries += 1;
        if (typeof window.openItemHistory === 'function') {
            window.openItemHistory(id, 'all');
            return;
        }
        if (tries < 12) {
            setTimeout(run, 160);
            return;
        }
        UI.toast(`Не удалось открыть историю материала #${id}`, 'warning');
    };
    setTimeout(run, 50);
};

window.reportsOpenFinanceCategoryInDashboard = function(categoryName) {
    const target = String(categoryName || '').trim();
    if (!target) return;
    if (typeof window.switchModule === 'function') {
        window.switchModule('dashboard-mod');
    }
    let tries = 0;
    const run = () => {
        tries += 1;
        if (typeof window.openDashboardCategory === 'function') {
            window.openDashboardCategory(target);
            return;
        }
        if (tries < 12) {
            setTimeout(run, 160);
            return;
        }
        if (window.app && typeof window.app.navigateCategory === 'function') {
            window.app.navigateCategory(target);
        }
    };
    setTimeout(run, 220);
};

window.reportsApplyCounterpartyFromDrilldown = function(counterpartyId) {
    const select = document.getElementById('reports-filter-counterparty');
    if (!select) return;
    select.value = String(counterpartyId);
    UI.closeModal();
    reportsLoadPreview();
};

async function reportsLoadOptions() {
    if (window.__reportsState.optionsLoaded) return;
    const data = await API.get('/api/reports/options');
    reportsFillSelect('reports-filter-counterparty', data.counterparties || [], 'name', 'id');
    reportsInitCounterpartySearch();
    const accountsSorted = (data.accounts || []).slice().sort((a, b) => {
        const wa = reportsAccountOrderWeight(a?.name);
        const wb = reportsAccountOrderWeight(b?.name);
        if (wa !== wb) return wa - wb;
        return String(a?.name || '').localeCompare(String(b?.name || ''), 'ru');
    });
    reportsFillSelect('reports-filter-account', accountsSorted, 'name', 'id');
    reportsInitAccountSearch();
    reportsFillSelect('reports-filter-item', data.items || [], 'name', 'id');
    const mt = document.getElementById('reports-filter-movement-type');
    if (mt) {
        const current = mt.value;
        mt.innerHTML = '<option value="">Все</option>' + (data.movementTypes || []).map((v) => `<option value="${Utils.escapeHtml(v)}">${Utils.escapeHtml(reportsStockMovementLabel(v))}</option>`).join('');
        if (current) mt.value = current;
    }
    const regSource = document.getElementById('reports-reg-source-tag');
    if (regSource) {
        const current = regSource.value;
        regSource.innerHTML = '<option value="">Источник данных: любой</option>' + (data.regSourceTags || [])
            .map((v) => `<option value="${Utils.escapeHtml(v)}">Источник данных: ${Utils.escapeHtml(v)}</option>`)
            .join('');
        if (current) regSource.value = current;
    }
    const pver = document.getElementById('reports-print-template-version');
    if (pver && Array.isArray(data.printTemplateVersions) && data.printTemplateVersions.length) {
        const current = pver.value;
        pver.innerHTML = data.printTemplateVersions
            .map((v) => `<option value="${Utils.escapeHtml(v.id)}">${Utils.escapeHtml(v.label)}</option>`)
            .join('');
        if (current) pver.value = current;
    }
    window.__reportsState.presets = Array.isArray(data.presets) ? data.presets : [];
    window.__reportsState.canManageSettings = Boolean(data.canManageSettings);
    window.__reportsState.permissions = data.permissions || window.__reportsState.permissions;
    window.__reportsState.settings = data.settings || {};
    window.__reportsState.financeDefaults = data.financeDefaults || window.__reportsState.financeDefaults;
    
    const overheadRateInput = document.getElementById('reports-filter-overhead-rate');
    if (overheadRateInput) {
        const currentOverhead = String(overheadRateInput.value || '').trim();
        overheadRateInput.value = reportsFmtOverheadInput(currentOverhead || reportsDefaultOverheadRate());
    }
    
    const taxRateInput = document.getElementById('reports-filter-tax-rate');
    if (taxRateInput) {
        const currentTax = String(taxRateInput.value || '').trim();
        if (!currentTax || currentTax === '20') {
            taxRateInput.value = String(reportsDefaultSalesTaxRate());
        }
    }
    const presetSelect = document.getElementById('reports-presets');
    if (presetSelect) {
        presetSelect.innerHTML = '<option value="">Пресеты...</option>' + window.__reportsState.presets
            .map((p) => `<option value="${Utils.escapeHtml(p.id)}">${Utils.escapeHtml(p.name)}${p.is_shared ? ' (общий)' : ''}</option>`)
            .join('');
    }
    const settingsBtn = document.querySelector('button[onclick="reportsOpenPrintSettings()"]');
    if (settingsBtn && !window.__reportsState.canManageSettings) settingsBtn.classList.add('d-none');
    const printBtn = document.querySelector('button[onclick="reportsPrint()"]');
    if (printBtn && !window.__reportsState.permissions.print) printBtn.classList.add('d-none');
    const csvBtn = document.querySelector('button[onclick="reportsExportCsv()"]');
    const xlsxBtn = document.querySelector('button[onclick="reportsExportXlsx()"]');
    if (csvBtn && !window.__reportsState.permissions.export) csvBtn.classList.add('d-none');
    if (xlsxBtn && !window.__reportsState.permissions.export) xlsxBtn.classList.add('d-none');
    window.__reportsState.optionsLoaded = true;
}

window.reportsLoadPreview = async function() {
    reportsApplyFilterVisibility();
    reportsNormalizeOverheadInput();
    const payload = reportsBuildPayload();
    window.__reportsState.lastPayload = payload;
    try {
        const data = await API.post('/api/reports/preview', payload);
        window.__reportsState.lastData = data;
        reportsRender(data);
    } catch (err) {
        console.error(err);
        UI.toast(err.message || 'Ошибка формирования отчета', 'error');
    }
};

async function reportsDownload(endpoint, ext) {
    const payload = window.__reportsState.lastPayload || reportsBuildPayload();
    const token = localStorage.getItem('token') || localStorage.getItem('jwtToken') || '';
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify(payload)
    });
    if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        let preflight = null;
        try {
            const body = await res.json();
            msg = body.error || msg;
            preflight = body.preflight || null;
        } catch (_) {}
        if (preflight && Array.isArray(preflight.reasons) && preflight.reasons.length) {
            msg = `${msg}: ${preflight.reasons.join(' | ')}`;
        }
        throw new Error(msg);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const d = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `report_${payload.reportType}_${d}.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

window.reportsExportCsv = async function() {
    try {
        await reportsDownload('/api/reports/export/csv', 'csv');
        UI.toast('CSV сформирован', 'success');
    } catch (err) {
        UI.toast(err.message || 'Ошибка экспорта CSV', 'error');
    }
};

window.reportsExportXlsx = async function() {
    try {
        await reportsDownload('/api/reports/export/xlsx', 'xlsx');
        UI.toast('XLSX сформирован', 'success');
    } catch (err) {
        UI.toast(err.message || 'Ошибка экспорта XLSX', 'error');
    }
};

window.reportsPrint = async function() {
    const payload = window.__reportsState.lastPayload || reportsBuildPayload();
    try {
        const data = await API.post('/api/reports/print', payload);
        const w = window.open('', '_blank');
        if (!w) throw new Error('Браузер заблокировал окно печати');
        w.document.open();
        w.document.write(data.html || '<html><body>Нет данных</body></html>');
        w.document.close();
        setTimeout(() => w.print(), 200);
    } catch (err) {
        UI.toast(err.message || 'Ошибка печати отчета', 'error');
    }
};

window.initReports = function() {
    const from = document.getElementById('reports-date-from');
    const to = document.getElementById('reports-date-to');
    const modeEl = document.getElementById('reports-period-mode');
    if (modeEl && !modeEl.value) modeEl.value = 'day';
    if (from && !from.value) from.value = reportsTodayStr();
    if (to && !to.value) to.value = reportsTodayStr();
    reportsInitPeriodPicker();
    reportsSyncPeriodUiFromInputs();
    const savedDensity = (() => {
        try { return localStorage.getItem('reportsDensity') || 'compact'; } catch (_) { return 'compact'; }
    })();
    window.__reportsState.density = savedDensity === 'standard' ? 'standard' : 'compact';
    reportsSyncRegulatoryFilters();
    reportsSyncCounterpartyBalanceHint();
    reportsInitRunsAccordion();
    reportsApplyDensity();
    reportsAfterReportsLayout();
    reportsInitFilterHeightObserver();
    if (!window.__reportsState.stickyResizeBound) {
        const rafHead = () => requestAnimationFrame(reportsSyncTableHead);
        window.addEventListener('scroll', rafHead, { passive: true });
        const contentArea = document.querySelector('.content-area');
        if (contentArea) contentArea.addEventListener('scroll', rafHead, { passive: true });
        window.addEventListener('resize', () => requestAnimationFrame(reportsAfterReportsLayout), { passive: true });
        window.__reportsState.stickyResizeBound = true;
    }
    if (document.getElementById('reports-mod')) {
        setTimeout(reportsAfterReportsLayout, 0);
        setTimeout(reportsAfterReportsLayout, 120);
        reportsBindTableLinks();
        reportsLoadOptions()
            .then(() => {
                reportsApplyFilterVisibility();
                reportsSyncPeriodUiFromInputs();
                reportsLoadPreview();
                reportsAfterReportsLayout();
            })
            .catch((err) => {
                console.error(err);
                UI.toast(err.message || 'Ошибка загрузки справочников отчетов', 'error');
            });
    }
};

function reportsInitPeriodPicker() {
    const anchorEl = document.getElementById('reports-date-anchor');
    const displayEl = document.getElementById('reports-period-display');
    if (!anchorEl || !displayEl || typeof flatpickr === 'undefined') return;
    if (window.__reportsState.periodPicker && typeof window.__reportsState.periodPicker.destroy === 'function') {
        window.__reportsState.periodPicker.destroy();
        window.__reportsState.periodPicker = null;
    }
    const locale = (window.flatpickr && window.flatpickr.l10ns && window.flatpickr.l10ns.ru) ? window.flatpickr.l10ns.ru : 'ru';
    window.__reportsState.periodPicker = flatpickr(anchorEl, {
        locale,
        dateFormat: 'Y-m-d',
        defaultDate: reportsGetAnchorDate(),
        clickOpens: false,
        allowInput: false,
        positionElement: displayEl,
        appendTo: document.body,
        disableMobile: true,
        onChange: (selectedDates, dateStr) => {
            if (!selectedDates || !selectedDates.length) return;
            const mode = document.getElementById('reports-period-mode')?.value || 'day';
            reportsApplyPeriodFromMode(mode, selectedDates[0], true);
        }
    });
}

window.reportsLoadRuns = async function() {
    try {
        const reportType = document.getElementById('reports-runs-report-type')?.value || '';
        const format = document.getElementById('reports-runs-format')?.value || '';
        const preflightStatus = document.getElementById('reports-runs-preflight')?.value || '';
        const username = document.getElementById('reports-runs-username')?.value || '';
        const generatedFrom = document.getElementById('reports-runs-from')?.value || '';
        const generatedTo = document.getElementById('reports-runs-to')?.value || '';
        const qs = new URLSearchParams({
            limit: '150',
            ...(reportType ? { reportType } : {}),
            ...(format ? { format } : {}),
            ...(preflightStatus ? { preflightStatus } : {}),
            ...(username ? { username } : {}),
            ...(generatedFrom ? { generatedFrom } : {}),
            ...(generatedTo ? { generatedTo } : {})
        });
        const data = await API.get(`/api/reports/runs?${qs.toString()}`);
        window.__reportsState.runs = Array.isArray(data.runs) ? data.runs : [];
        const body = document.getElementById('reports-runs-body');
        if (!body) return;
        if (!window.__reportsState.runs.length) {
            body.innerHTML = '<tr><td colspan="9" class="text-muted">История пока пуста</td></tr>';
            return;
        }
        body.innerHTML = window.__reportsState.runs.map((r) => `
            <tr>
                <td>${Utils.escapeHtml(new Date(r.generated_at).toLocaleString('ru-RU'))}</td>
                <td>${Utils.escapeHtml(r.username || 'system')}</td>
                <td>${Utils.escapeHtml(reportsFormatType(r.report_type || ''))}</td>
                <td>${Utils.escapeHtml(`${r.date_from || ''} — ${r.date_to || ''}`)}</td>
                <td>${Utils.escapeHtml(r.accounting_mode || '')}</td>
                <td>${Utils.escapeHtml(reportsFormatRunFormat(r.format || ''))}</td>
                <td>${Utils.escapeHtml(reportsFormatRunPreflight(r.preflight_status || ''))}${r.preflight_reason ? `<div class="text-muted font-12">${Utils.escapeHtml(r.preflight_reason)}</div>` : ''}</td>
                <td>${Utils.escapeHtml(r.rows_count || 0)}</td>
                <td class="reports-runs-actions">
                    <button class="btn btn-outline btn-sm" onclick="reportsReplayRun(${Number(r.id)})">Применить</button>
                    <button class="btn btn-outline btn-sm" onclick="reportsPrintRun(${Number(r.id)})">Печать</button>
                    <button class="btn btn-outline btn-sm" onclick="reportsExportRun(${Number(r.id)}, 'csv')">CSV</button>
                    <button class="btn btn-outline btn-sm" onclick="reportsExportRun(${Number(r.id)}, 'xlsx')">XLSX</button>
                    <button class="btn btn-outline btn-sm" onclick="reportsDownloadRunPayload(${Number(r.id)})">JSON</button>
                    <button class="btn btn-outline btn-sm" onclick="reportsCopyRunPayload(${Number(r.id)})">Копировать</button>
                </td>
            </tr>
        `).join('');
    } catch (err) {
        const body = document.getElementById('reports-runs-body');
        if (body) body.innerHTML = '<tr><td colspan="9" class="text-danger">Ошибка загрузки истории</td></tr>';
    }
};

window.reportsLoadRunsDebounced = function() {
    if (window.__reportsState.runsLoadTimer) {
        clearTimeout(window.__reportsState.runsLoadTimer);
    }
    window.__reportsState.runsLoadTimer = setTimeout(() => {
        reportsLoadRuns();
    }, 250);
};

function reportsInitRunsAccordion() {
    const acc = document.getElementById('reports-runs-accordion');
    if (!acc || acc.dataset.bound === '1') return;
    acc.dataset.bound = '1';
    const hintEl = acc.querySelector('.reports-runs-summary .text-muted');
    const syncHint = () => {
        if (!hintEl) return;
        hintEl.textContent = acc.open ? 'Свернуть' : 'Развернуть';
    };
    acc.addEventListener('toggle', () => {
        syncHint();
        if (acc.open && !(Array.isArray(window.__reportsState.runs) && window.__reportsState.runs.length)) {
            reportsLoadRuns();
        }
    });
    syncHint();
}

window.reportsReplayRun = function(runId) {
    const run = window.__reportsState.runs.find((x) => Number(x.id) === Number(runId));
    if (!run) return;
    const p = (run.payload && typeof run.payload === 'object') ? run.payload : null;
    if (p && p.reportType) document.getElementById('reports-type').value = p.reportType;
    else if (run.report_type) document.getElementById('reports-type').value = run.report_type;
    if (p && p.dateFrom) document.getElementById('reports-date-from').value = p.dateFrom;
    else if (run.date_from) document.getElementById('reports-date-from').value = String(run.date_from).slice(0, 10);
    if (p && p.dateTo) document.getElementById('reports-date-to').value = p.dateTo;
    else if (run.date_to) document.getElementById('reports-date-to').value = String(run.date_to).slice(0, 10);
    reportsSyncPeriodUiFromInputs();
    if (p && p.accountingMode) document.getElementById('reports-accounting-mode').value = p.accountingMode;
    else if (run.accounting_mode) document.getElementById('reports-accounting-mode').value = run.accounting_mode;
    if (p && p.printTemplateVersion) document.getElementById('reports-print-template-version').value = p.printTemplateVersion;
    reportsSetSelectValue('reports-filter-counterparty', p?.filters?.counterpartyId || '');
    reportsSetSelectValue('reports-filter-nonzero', p?.filters?.counterpartyBalanceMode || (p?.filters?.nonZeroClosing ? 'nonzero' : 'all'));
    reportsSetSelectValue('reports-filter-account', p?.filters?.accountId || '');
    reportsSetSelectValue('reports-filter-account-movement', p?.filters?.accountMovementMode || 'all');
    reportsSetSelectValue('reports-filter-stock-balance', p?.filters?.stockBalanceMode || 'nonzero');
    reportsSetSelectValue('reports-filter-stock-valuation', p?.filters?.stockValuationMode || 'movement_actual');
    reportsSetSelectValue('reports-filter-item', p?.filters?.itemId || '');
    reportsSetSelectValue('reports-filter-warehouse', p?.filters?.warehouseType || '');
    reportsSetSelectValue('reports-filter-movement-type', p?.filters?.movementType || '');
    reportsSetSelectValue('reports-filter-transaction-type', p?.filters?.transactionType || '');
    reportsSetSelectValue('reports-filter-topn', p?.filters?.topN || '20');
    reportsSetSelectValue('reports-filter-forecast-horizon', p?.filters?.forecastHorizon || '30');
    reportsSetSelectValue('reports-filter-overhead-rate', reportsFmtOverheadInput(p?.filters?.overheadRate ?? reportsDefaultOverheadRate()));
    reportsSetSelectValue('reports-filter-tax-rate', p?.filters?.taxRate ?? String(reportsDefaultSalesTaxRate()));
    const includeReturnsEl = document.getElementById('reports-filter-include-returns');
    if (includeReturnsEl) includeReturnsEl.checked = p?.filters?.includeReturns !== false;
    const includeOverheadEl = document.getElementById('reports-filter-include-overhead');
    if (includeOverheadEl) includeOverheadEl.checked = p?.filters?.includeOverhead !== false;
    const includeTaxesEl = document.getElementById('reports-filter-include-taxes');
    if (includeTaxesEl) includeTaxesEl.checked = p?.filters?.includeTaxes === true;
    reportsSetSelectValue('reports-filter-analytics-tab', p?.filters?.analyticsTab || 'summary');
    window.__reportsState.salesAnalyticsActiveTab = String(p?.filters?.analyticsTab || 'summary');
    const regExcludeReserve = p?.filters?.regExcludeReserve;
    const regExcludeAdjustments = p?.filters?.regExcludeAdjustments;
    const regExcludeOffset = p?.filters?.regExcludeOffset;
    const regExcludeTechnical = p?.filters?.regExcludeTechnical;
    const regReserveEl = document.getElementById('reports-reg-exclude-reserve');
    const regAdjustEl = document.getElementById('reports-reg-exclude-adjustments');
    const regOffsetEl = document.getElementById('reports-reg-exclude-offset');
    const regTechEl = document.getElementById('reports-reg-exclude-technical');
    const regPostedEl = document.getElementById('reports-reg-only-posted');
    const regPrimaryEl = document.getElementById('reports-reg-only-primary');
    const regDocNoEl = document.getElementById('reports-reg-require-docno');
    if (regReserveEl) regReserveEl.checked = regExcludeReserve !== false;
    if (regAdjustEl) regAdjustEl.checked = regExcludeAdjustments !== false;
    if (regOffsetEl) regOffsetEl.checked = regExcludeOffset !== false;
    if (regTechEl) regTechEl.checked = regExcludeTechnical !== false;
    if (regPostedEl) regPostedEl.checked = p?.filters?.regOnlyPosted !== false;
    if (regPrimaryEl) regPrimaryEl.checked = p?.filters?.regOnlyPrimaryDoc === true;
    if (regDocNoEl) regDocNoEl.checked = p?.filters?.regRequireDocumentNo === true;
    reportsSetSelectValue('reports-reg-source-tag', p?.filters?.regSourceTag || '');
    window.__reportsState.visibleColumns = Array.isArray(p?.visibleColumns) ? p.visibleColumns.slice() : [];
    const replayPage = Number(p?.pagination?.page || 1);
    if (p?.pagination?.pageSize) {
        window.__reportsState.pageSize = Number(p.pagination.pageSize) || window.__reportsState.pageSize;
    }
    window.__reportsState.page = Number.isFinite(replayPage) && replayPage > 0 ? replayPage : 1;
    reportsSyncRegulatoryFilters();
    reportsApplyFilterVisibility();
    reportsLoadPreview();
};

window.reportsPrintRun = function(runId) {
    reportsReplayRun(runId);
    setTimeout(() => { reportsPrint(); }, 200);
};

window.reportsExportRun = async function(runId, ext) {
    const run = window.__reportsState.runs.find((x) => Number(x.id) === Number(runId));
    if (!run) return UI.toast('Запись истории не найдена', 'warning');
    const p = (run.payload && typeof run.payload === 'object') ? run.payload : null;
    if (!p) return UI.toast('В этой записи нет payload для повторного экспорта', 'warning');
    const endpoint = ext === 'xlsx' ? '/api/reports/export/xlsx' : '/api/reports/export/csv';
    try {
        const token = localStorage.getItem('token') || localStorage.getItem('jwtToken') || '';
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(token ? { Authorization: `Bearer ${token}` } : {})
            },
            body: JSON.stringify(p)
        });
        if (!res.ok) {
            let msg = `HTTP ${res.status}`;
            try {
                const body = await res.json();
                msg = body.error || msg;
            } catch (_) {}
            throw new Error(msg);
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const d = new Date().toISOString().slice(0, 10);
        a.download = `report_replay_${p.reportType || run.report_type || 'unknown'}_${d}.${ext}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        UI.toast(`Повторный экспорт ${ext.toUpperCase()} выполнен`, 'success');
    } catch (err) {
        UI.toast(err.message || 'Ошибка повторного экспорта', 'error');
    }
};

window.reportsDownloadRunPayload = function(runId) {
    const run = window.__reportsState.runs.find((x) => Number(x.id) === Number(runId));
    if (!run) return UI.toast('Запись истории не найдена', 'warning');
    const p = (run.payload && typeof run.payload === 'object') ? run.payload : null;
    if (!p) return UI.toast('В этой записи нет payload', 'warning');
    try {
        const blob = new Blob([JSON.stringify(p, null, 2)], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const d = new Date().toISOString().slice(0, 10);
        a.href = url;
        a.download = `report_payload_${run.report_type || 'unknown'}_${d}_run${run.id}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        UI.toast('Payload выгружен в JSON', 'success');
    } catch (err) {
        UI.toast(err.message || 'Ошибка выгрузки payload', 'error');
    }
};

window.reportsCopyRunPayload = async function(runId) {
    const run = window.__reportsState.runs.find((x) => Number(x.id) === Number(runId));
    if (!run) return UI.toast('Запись истории не найдена', 'warning');
    const p = (run.payload && typeof run.payload === 'object') ? run.payload : null;
    if (!p) return UI.toast('В этой записи нет payload', 'warning');
    const text = JSON.stringify(p, null, 2);
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
        } else {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.setAttribute('readonly', '');
            ta.style.position = 'fixed';
            ta.style.left = '-9999px';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
        }
        UI.toast('Payload скопирован в буфер', 'success');
    } catch (err) {
        UI.toast(err.message || 'Ошибка копирования payload', 'error');
    }
};

window.reportsExportRunsCsv = async function() {
    try {
        const reportType = document.getElementById('reports-runs-report-type')?.value || '';
        const format = document.getElementById('reports-runs-format')?.value || '';
        const preflightStatus = document.getElementById('reports-runs-preflight')?.value || '';
        const username = document.getElementById('reports-runs-username')?.value || '';
        const generatedFrom = document.getElementById('reports-runs-from')?.value || '';
        const generatedTo = document.getElementById('reports-runs-to')?.value || '';
        const qs = new URLSearchParams({
            ...(reportType ? { reportType } : {}),
            ...(format ? { format } : {}),
            ...(preflightStatus ? { preflightStatus } : {}),
            ...(username ? { username } : {}),
            ...(generatedFrom ? { generatedFrom } : {}),
            ...(generatedTo ? { generatedTo } : {})
        });
        const token = localStorage.getItem('token') || localStorage.getItem('jwtToken') || '';
        const res = await fetch(`/api/reports/runs/export/csv?${qs.toString()}`, {
            method: 'GET',
            headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) }
        });
        if (!res.ok) {
            let msg = `HTTP ${res.status}`;
            try {
                const body = await res.json();
                msg = body.error || msg;
            } catch (_) {}
            throw new Error(msg);
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `report_runs_${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        UI.toast('История экспортирована в CSV', 'success');
    } catch (err) {
        UI.toast(err.message || 'Ошибка экспорта истории', 'error');
    }
};

window.reportsChangePage = function(step) {
    const data = window.__reportsState.lastData;
    if (!data || !data.pagination) return;
    const next = (data.pagination.page || 1) + step;
    if (next < 1 || next > (data.pagination.totalPages || 1)) return;
    window.__reportsState.page = next;
    reportsLoadPreview();
};

window.reportsOpenColumns = function() {
    const data = window.__reportsState.lastData;
    if (!data || !Array.isArray(data.columns) || !data.columns.length) {
        UI.toast('Сначала сформируйте отчет', 'warning');
        return;
    }
    const selected = new Set((window.__reportsState.visibleColumns && window.__reportsState.visibleColumns.length)
        ? window.__reportsState.visibleColumns
        : data.columns.map((c) => c.key));
    const html = `
        <div class="flex-col gap-8">
            ${data.columns.map((c) => `
                <label class="d-flex align-center gap-8">
                    <input type="checkbox" class="reports-col-check" value="${Utils.escapeHtml(c.key)}" ${selected.has(c.key) ? 'checked' : ''}>
                    <span>${Utils.escapeHtml(c.label)}</span>
                </label>
            `).join('')}
        </div>
    `;
    UI.showModal('Колонки отчета', html, `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-blue" onclick="reportsApplyColumns()">Применить</button>
    `);
};

window.reportsApplyColumns = function() {
    const checks = Array.from(document.querySelectorAll('.reports-col-check:checked'));
    if (!checks.length) {
        UI.toast('Должна остаться хотя бы 1 колонка', 'warning');
        return;
    }
    window.__reportsState.visibleColumns = checks.map((x) => x.value);
    UI.closeModal();
    reportsLoadPreview();
};

window.reportsSavePreset = async function() {
    const payload = reportsBuildPayload();
    UI.showModal('Сохранить пресет', `
        <div class="form-group m-0">
            <label>Название пресета</label>
            <input id="reports-preset-name" class="input-modern" placeholder="Например: ОСВ Продукция (месяц)">
        </div>
        ${window.__reportsState.canManageSettings ? `
        <label class="d-flex align-center gap-8 mt-10">
            <input id="reports-preset-shared" type="checkbox">
            <span>Сделать общий пресет (для всех)</span>
        </label>` : ''}
    `, `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-blue" onclick="reportsConfirmSavePreset()">Сохранить</button>
    `);
    window.__reportsState.pendingPresetPayload = payload;
};

window.reportsConfirmSavePreset = async function() {
    const payload = window.__reportsState.pendingPresetPayload || reportsBuildPayload();
    const name = document.getElementById('reports-preset-name')?.value || '';
    const isShared = window.__reportsState.canManageSettings
        ? Boolean(document.getElementById('reports-preset-shared')?.checked)
        : false;
    if (!name.trim()) return UI.toast('Введите название пресета', 'warning');
    try {
        await API.post('/api/reports/presets', {
            name: name.trim(),
            reportType: payload.reportType,
            payload,
            isShared
        });
        window.__reportsState.optionsLoaded = false;
        await reportsLoadOptions();
        UI.closeModal();
        UI.toast('Пресет сохранен', 'success');
    } catch (err) {
        UI.toast(err.message || 'Ошибка сохранения пресета', 'error');
    }
};

window.reportsApplyPreset = function(id) {
    if (!id) return;
    const preset = window.__reportsState.presets.find((p) => String(p.id) === String(id));
    if (!preset || !preset.payload) return;
    const p = preset.payload;
    if (p.reportType) document.getElementById('reports-type').value = p.reportType;
    if (p.dateFrom) document.getElementById('reports-date-from').value = p.dateFrom;
    if (p.dateTo) document.getElementById('reports-date-to').value = p.dateTo;
    reportsSyncPeriodUiFromInputs();
    if (p.accountingMode) document.getElementById('reports-accounting-mode').value = p.accountingMode;
    reportsSetSelectValue('reports-filter-counterparty', p.filters?.counterpartyId || '');
    reportsSetSelectValue('reports-filter-nonzero', p?.filters?.counterpartyBalanceMode || (p?.filters?.nonZeroClosing ? 'nonzero' : 'all'));
    const excludeEmployeesEl = document.getElementById('reports-filter-exclude-employees');
    if (excludeEmployeesEl) excludeEmployeesEl.checked = p?.filters?.excludeEmployees !== false;
    reportsSetSelectValue('reports-filter-account', p.filters?.accountId || '');
    reportsSetSelectValue('reports-filter-account-movement', p.filters?.accountMovementMode || 'all');
    reportsSetSelectValue('reports-filter-stock-balance', p.filters?.stockBalanceMode || 'nonzero');
    reportsSetSelectValue('reports-filter-stock-valuation', p.filters?.stockValuationMode || 'movement_actual');
    reportsSetSelectValue('reports-filter-item', p.filters?.itemId || '');
    reportsSetSelectValue('reports-filter-warehouse', p.filters?.warehouseType || '');
    reportsSetSelectValue('reports-filter-movement-type', p.filters?.movementType || '');
    reportsSetSelectValue('reports-filter-transaction-type', p.filters?.transactionType || '');
    reportsSetSelectValue('reports-filter-topn', p.filters?.topN || '20');
    reportsSetSelectValue('reports-filter-forecast-horizon', p.filters?.forecastHorizon || '30');
    reportsSetSelectValue('reports-filter-overhead-rate', reportsFmtOverheadInput(p.filters?.overheadRate ?? reportsDefaultOverheadRate()));
    reportsSetSelectValue('reports-filter-tax-rate', p.filters?.taxRate ?? String(reportsDefaultSalesTaxRate()));
    const includeReturnsEl = document.getElementById('reports-filter-include-returns');
    if (includeReturnsEl) includeReturnsEl.checked = p?.filters?.includeReturns !== false;
    const includeOverheadEl = document.getElementById('reports-filter-include-overhead');
    if (includeOverheadEl) includeOverheadEl.checked = p?.filters?.includeOverhead !== false;
    const includeTaxesEl = document.getElementById('reports-filter-include-taxes');
    if (includeTaxesEl) includeTaxesEl.checked = p?.filters?.includeTaxes === true;
    reportsSetSelectValue('reports-filter-analytics-tab', p.filters?.analyticsTab || 'summary');
    window.__reportsState.salesAnalyticsActiveTab = String(p.filters?.analyticsTab || 'summary');
    const regExcludeReserve = p?.filters?.regExcludeReserve;
    const regExcludeAdjustments = p?.filters?.regExcludeAdjustments;
    const regExcludeOffset = p?.filters?.regExcludeOffset;
    const regExcludeTechnical = p?.filters?.regExcludeTechnical;
    const regReserveEl = document.getElementById('reports-reg-exclude-reserve');
    const regAdjustEl = document.getElementById('reports-reg-exclude-adjustments');
    const regOffsetEl = document.getElementById('reports-reg-exclude-offset');
    const regTechEl = document.getElementById('reports-reg-exclude-technical');
    const regPostedEl = document.getElementById('reports-reg-only-posted');
    const regPrimaryEl = document.getElementById('reports-reg-only-primary');
    const regDocNoEl = document.getElementById('reports-reg-require-docno');
    if (regReserveEl) regReserveEl.checked = regExcludeReserve !== false;
    if (regAdjustEl) regAdjustEl.checked = regExcludeAdjustments !== false;
    if (regOffsetEl) regOffsetEl.checked = regExcludeOffset !== false;
    if (regTechEl) regTechEl.checked = regExcludeTechnical !== false;
    if (regPostedEl) regPostedEl.checked = p?.filters?.regOnlyPosted !== false;
    if (regPrimaryEl) regPrimaryEl.checked = p?.filters?.regOnlyPrimaryDoc === true;
    if (regDocNoEl) regDocNoEl.checked = p?.filters?.regRequireDocumentNo === true;
    reportsSetSelectValue('reports-reg-source-tag', p?.filters?.regSourceTag || '');
    window.__reportsState.visibleColumns = Array.isArray(p.visibleColumns) ? p.visibleColumns.slice() : [];
    window.__reportsState.page = 1;
    reportsSyncRegulatoryFilters();
    reportsSyncCounterpartyBalanceHint();
    reportsApplyFilterVisibility();
    reportsLoadPreview();
};

window.reportsDeletePreset = async function() {
    const id = document.getElementById('reports-presets')?.value;
    if (!id) return UI.toast('Выберите пресет', 'warning');
    try {
        await API.delete(`/api/reports/presets/${id}`);
        window.__reportsState.optionsLoaded = false;
        await reportsLoadOptions();
        UI.toast('Пресет удален', 'success');
    } catch (err) {
        UI.toast(err.message || 'Ошибка удаления пресета', 'error');
    }
};

window.reportsAskCleanupRuns = function() {
    if (!window.__reportsState.canManageSettings) {
        UI.toast('Очистка истории доступна только администратору', 'warning');
        return;
    }
    UI.showModal('Очистка истории формирований', `
        <div class="form-group m-0">
            <label>Причина очистки <span class="text-danger">*</span></label>
            <textarea id="reports-cleanup-reason" class="input-modern" rows="3" placeholder="Например: удаление тестовых запусков перед рабочим периодом"></textarea>
        </div>
        <label class="d-flex align-center gap-8 mt-10">
            <input id="reports-cleanup-all" type="checkbox">
            <span>Удалить всю историю (если не отмечено - удаляются тестовые и заблокированные прогоны)</span>
        </label>
    `, `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-red" onclick="reportsConfirmCleanupRuns()">Очистить</button>
    `);
};

window.reportsConfirmCleanupRuns = async function() {
    const reason = (document.getElementById('reports-cleanup-reason')?.value || '').trim();
    const all = Boolean(document.getElementById('reports-cleanup-all')?.checked);
    if (!reason) return UI.toast('Укажите причину очистки', 'warning');
    try {
        const res = await API.post('/api/reports/runs/cleanup', {
            scope: all ? 'all' : 'preview_only',
            reason
        });
        UI.closeModal();
        UI.toast(`Удалено записей: ${Number(res.deleted || 0)}`, 'success');
        reportsLoadRuns();
    } catch (err) {
        UI.toast(err.message || 'Ошибка очистки истории', 'error');
    }
};

window.reportsBindTableLinks = function() {
    const table = document.getElementById('reports-table');
    if (!table || table.dataset.linksBound === '1') return;
    table.dataset.linksBound = '1';
    table.addEventListener('click', (e) => {
        const sortBtn = e.target.closest('.reports-sort-head-btn');
        if (sortBtn) {
            reportsSortSalesAnalyticsBy(sortBtn.getAttribute('data-sort-key') || '');
            return;
        }
        const btn = e.target.closest('.reports-cell-link');
        if (!btn) return;
        const reportType = String(table.dataset.reportType || '');
        const cpId = Number(btn.getAttribute('data-counterparty-id') || 0);
        const accountId = Number(btn.getAttribute('data-account-id') || 0);
        const itemId = Number(btn.getAttribute('data-item-id') || 0);
        const warehouseId = Number(btn.getAttribute('data-warehouse-id') || 0);
        const batchId = Number(btn.getAttribute('data-batch-id') || 0);
        const orderId = Number(btn.getAttribute('data-order-id') || 0);
        const purchaseId = Number(btn.getAttribute('data-purchase-id') || 0);
        const salesItemId = Number(btn.getAttribute('data-sales-item-id') || 0);
        const salesMetric = String(btn.getAttribute('data-sales-metric') || '');
        const financeType = String(btn.getAttribute('data-finance-type') || '');
        const financeCategory = String(btn.getAttribute('data-finance-category') || '');
        const metricKey = String(btn.getAttribute('data-col-key') || '');
        const metricLabel = String(btn.getAttribute('data-col-label') || '');
        if (btn.classList.contains('reports-num-link') && metricKey) {
            if (reportType === 'osv_counterparties' && cpId > 0) {
                reportsOpenCounterpartyDrilldown(cpId, metricKey, metricLabel);
                return;
            }
            if (reportType === 'osv_cash_accounts' && accountId > 0) {
                reportsOpenAccountDrilldown(accountId, metricKey, metricLabel);
                return;
            }
            if ((reportType === 'osv_materials' || reportType === 'osv_products' || reportType === 'inventory_register') && itemId > 0 && warehouseId > 0) {
                reportsOpenStockDrilldown(itemId, warehouseId, metricKey, metricLabel);
                return;
            }
            if (reportType === 'turnover_finance' && financeCategory) {
                reportsOpenFinanceDrilldown(financeType, financeCategory, metricKey, metricLabel);
                return;
            }
            if (reportType === 'sales_analytics' && salesItemId > 0) {
                reportsOpenSalesAnalyticsDrilldown(salesItemId, salesMetric || metricKey, metricLabel || metricKey);
                return;
            }
            return;
        }
        if (reportType === 'sales_analytics' && salesItemId > 0) {
            reportsOpenSalesAnalyticsDrilldown(salesItemId, salesMetric || 'sold_qty', metricLabel || salesMetric || 'показатель');
            return;
        }
        if (reportType === 'inventory_register' && batchId > 0) {
            reportsOpenBatchFromDrilldown(batchId);
            return;
        }
        if (reportType === 'inventory_register' && orderId > 0) {
            if (window.app && typeof window.app.openEntity === 'function') {
                window.app.openEntity('document_order', orderId);
            }
            return;
        }
        if (reportType === 'inventory_register' && purchaseId > 0) {
            reportsOpenPurchaseFromDrilldown(purchaseId);
            return;
        }
        if (reportType === 'turnover_finance' && financeCategory) {
            reportsOpenFinanceCategoryInDashboard(financeCategory);
            return;
        }
        if ((reportType === 'osv_materials' || reportType === 'osv_products' || reportType === 'inventory_register') && itemId > 0) {
            reportsOpenItemCard(itemId);
            return;
        }
        if (!cpId) return;
        if (window.app && typeof window.app.openEntity === 'function') {
            window.app.openEntity('client', cpId);
            return;
        }
        if (typeof openCounterpartyProfile === 'function') {
            openCounterpartyProfile(cpId);
            return;
        }
        if (typeof editClient === 'function') {
            editClient(cpId);
            return;
        }
        const select = document.getElementById('reports-filter-counterparty');
        if (!select) return;
        select.value = String(cpId);
        window.__reportsState.page = 1;
        reportsLoadPreview();
    });
};

window.reportsOpenPrintSettings = function() {
    if (!window.__reportsState.canManageSettings) {
        UI.toast('Доступно только администратору', 'warning');
        return;
    }
    const s = window.__reportsState.settings || {};
    UI.showModal('Реквизиты печатных форм', `
        <div class="form-grid">
            <div class="form-group m-0"><label>Название компании</label><input id="rps-company_name" class="input-modern" value="${Utils.escapeHtml(s.company_name || '')}"></div>
            <div class="form-group m-0"><label>ИНН</label><input id="rps-company_inn" class="input-modern" value="${Utils.escapeHtml(s.company_inn || '')}"></div>
            <div class="form-group m-0"><label>КПП</label><input id="rps-company_kpp" class="input-modern" value="${Utils.escapeHtml(s.company_kpp || '')}"></div>
            <div class="form-group m-0"><label>Адрес</label><input id="rps-company_address" class="input-modern" value="${Utils.escapeHtml(s.company_address || '')}"></div>
            <div class="form-group m-0"><label>Руководитель</label><input id="rps-company_director" class="input-modern" value="${Utils.escapeHtml(s.company_director || '')}"></div>
            <div class="form-group m-0"><label>Главный бухгалтер</label><input id="rps-company_accountant" class="input-modern" value="${Utils.escapeHtml(s.company_accountant || '')}"></div>
            <div class="form-group m-0">
                <label>Режим preflight</label>
                <select id="rps-reports_preflight_mode" class="input-modern">
                    <option value="warning" ${(s.reports_preflight_mode || 'warning') === 'warning' ? 'selected' : ''}>warning (не блокировать)</option>
                    <option value="hard_fail" ${s.reports_preflight_mode === 'hard_fail' ? 'selected' : ''}>hard_fail (блокировать критичные)</option>
                </select>
            </div>
        </div>
    `, `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-blue" onclick="reportsSavePrintSettings()">Сохранить</button>
    `);
};

window.reportsOpenCostAnalysisModal = async function(itemId, itemName, reportUnitCost = 0, soldQty = 0, revenueGross = 0) {
    try {
        const payload = reportsBuildPayload();
        const dateFrom = payload.dateFrom;
        const dateTo = payload.dateTo;
        const includeOverhead = !!payload.filters?.includeOverhead;
        const overheadRate = Number(payload.filters?.overheadRate || 0);

        const url = new URL(`/api/sales/cost-analysis/${itemId}`, window.location.origin);
        url.searchParams.set('dateFrom', dateFrom);
        url.searchParams.set('dateTo', dateTo);
        url.searchParams.set('includeOverhead', includeOverhead ? 'true' : 'false');
        url.searchParams.set('overheadRate', String(overheadRate));

        const res = await API.get(url.pathname + url.search);
        
        const includeTaxes = !!payload.filters?.includeTaxes;
        const taxRateRaw = Number(payload.filters?.taxRate);
        const taxRate = Number.isFinite(taxRateRaw) && taxRateRaw >= 0 ? taxRateRaw : Number(reportsDefaultSalesTaxRate());

        const batchCount = res.batchCount || 0;
        const methodNote = batchCount > 0
            ? `Средний расход сырья по <b>${batchCount}</b> последним завершённым формовкам.${res.materials.some(m => m.is_hybrid) ? ' Материалы без факта подставлены из рецепта (🪄).' : ''}`
            : 'Нет данных по формовкам. Используется <b>теоретический</b> расход из рецептуры.';

        const theoreticalBase = Number(res.theoretical || 0);
        const empiricalRaw = Number(res.empirical || 0) > 0 ? Number(res.empirical || 0) : theoreticalBase;
        const amortizationUnit = Number(res.amortization || 0);
        const overheadUnit = Number(res.overhead || 0);
        const avgSalePricePerUnit = Number(soldQty || 0) > 0 ? Number(revenueGross || 0) / Number(soldQty || 1) : 0;
        // Как в buildSalesAnalytics: налог считают от выручки строки (цена продаж × ставка), не от себестоимости.
        const taxPerUnitFromRevenue = avgSalePricePerUnit > 0 ? Number((avgSalePricePerUnit * (taxRate / 100)).toFixed(2)) : 0;
        const factMaterialsShown = res.materials.reduce((sum, m) => sum + Number(m.fact_cost || 0), 0);
        // In modal, "Опыт (Факт)" must always match the fact material table total.
        const empiricalBase = factMaterialsShown > 0 ? factMaterialsShown : empiricalRaw;
        const initialOverhead = includeOverhead ? overheadUnit : 0;
        const initialPlanSubtotal = theoreticalBase + initialOverhead;
        const initialFactSubtotal = empiricalBase + amortizationUnit + initialOverhead;
        const initialTaxPlan = includeTaxes ? Number((initialPlanSubtotal * (taxRate / 100)).toFixed(2)) : 0;
        const initialTaxFact = includeTaxes
            ? Number((taxPerUnitFromRevenue > 0 ? taxPerUnitFromRevenue : (initialFactSubtotal * (taxRate / 100))).toFixed(2))
            : 0;
        const initialPlanTotal = initialPlanSubtotal + initialTaxPlan;
        const initialFactTotal = initialFactSubtotal + initialTaxFact;

        let html = `
            <style>
                #app-modal .modal-content { max-width: 1120px !important; width: 96% !important; }
                .calc-grid { display: grid; grid-template-columns: 1fr 320px; gap: 24px; }
                .calc-card { border: 1px solid var(--border-color, #e0e0e0); border-radius: 10px; padding: 14px 16px; background: #fff; }
                .calc-card-header { font-size: 11px; text-transform: uppercase; font-weight: 700; color: #6c757d; margin-bottom: 10px; letter-spacing: 0.5px; }
                .calc-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; font-size: 13px; }
                .calc-row:last-child { margin-bottom: 0; }
                .calc-sep { border-bottom: 1px dashed var(--border-color, #e0e0e0); margin: 6px 0; }
                .calc-method { background: #e3f2fd; border: 1px solid #90caf9; border-radius: 8px; padding: 10px 14px; font-size: 12px; color: #1565c0; margin-top: 12px; line-height: 1.6; }
                @media (max-width: 800px) { .calc-grid { grid-template-columns: 1fr; } }
            </style>
            <div style="padding: 8px 4px;">
                ${res.isSecondGrade ? `<div class="alert alert-info py-2 px-3 mb-3" style="font-size: 0.9rem;">Базовый товар для расчета: <strong>${Utils.escapeHtml(res.baseItemName)}</strong></div>` : ''}

                <div class="calc-grid">
                    
                    <!-- ======== ЛЕВАЯ КОЛОНКА: Таблица сырья ======== -->
                    <div>
                        <div class="calc-card" style="padding: 0; overflow: hidden;">
                            <div class="crm-header-row" style="padding: 12px 16px; border-bottom: 1px solid var(--border-color, #e0e0e0); background: #f8f9fa;">
                                <span class="font-13 font-bold text-primary">📦 Сравнительный расход сырья</span>
                            </div>
                            <div style="overflow-x: auto;">
                                <table class="table-modern w-100" style="min-width: 520px; font-size: 12px; margin: 0; border-collapse: collapse; text-align: left;">
                                    <thead class="bg-surface-alt" style="background: #f8f9fa;">
                                        <tr style="border-bottom: 1px solid var(--border-color, #e0e0e0);">
                                            <th rowspan="2" style="padding: 8px; border-right: 1px solid var(--border-color, #e0e0e0); color: #6c757d; font-weight: 700; text-transform: uppercase; font-size: 11px;">МАТЕРИАЛ</th>
                                            <th colspan="2" style="padding: 8px; text-align: center; border-right: 1px solid var(--border-color, #e0e0e0); color: #6c757d; font-weight: 700; text-transform: uppercase; font-size: 11px;">РАСХОД (1 ЕД)</th>
                                            <th colspan="2" style="padding: 8px; text-align: center; color: #6c757d; font-weight: 700; text-transform: uppercase; font-size: 11px;">СУММА (1 ЕД)</th>
                                        </tr>
                                        <tr style="border-bottom: 2px solid var(--border-color, #e0e0e0);">
                                            <th style="padding: 6px; text-align: center; border-right: 1px dashed var(--border-color, #e0e0e0); color: #0d6efd; font-weight: 700; font-size: 10px;">📐 Идеал</th>
                                            <th style="padding: 6px; text-align: center; border-right: 1px solid var(--border-color, #e0e0e0); color: #fd7e14; font-weight: 700; font-size: 10px;">🧪 Опыт</th>
                                            <th style="padding: 6px; text-align: center; border-right: 1px dashed var(--border-color, #e0e0e0); color: #0d6efd; font-weight: 700; font-size: 10px;">📐 Идеал</th>
                                            <th style="padding: 6px; text-align: center; color: #fd7e14; font-weight: 700; font-size: 10px;">🧪 Опыт</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        ${res.materials.map(m => `
                                            <tr style="border-bottom: 1px solid #f1f3f5;">
                                                <td style="padding: 7px 10px; font-weight: 600; border-right: 1px solid var(--border-color, #e0e0e0);">${Utils.escapeHtml(m.name)}</td>
                                                <td style="padding: 7px 6px; text-align: center; border-right: 1px dashed var(--border-color, #e0e0e0); color: #0d6efd;">${m.theory_qty > 0 ? m.theory_qty.toFixed(3) : '-'} <small class="text-muted">${Utils.escapeHtml(m.unit)}</small></td>
                                                <td style="padding: 7px 6px; text-align: center; border-right: 1px solid var(--border-color, #e0e0e0); font-weight: 700; color: #fd7e14;">
                                                    ${m.fact_qty > 0 ? m.fact_qty.toFixed(3) : '-'} <small class="text-muted">${Utils.escapeHtml(m.unit)}</small>
                                                    ${m.is_hybrid ? '<span title="Нет факта — подставлено из рецепта" style="cursor:help;">🪄</span>' : ''}
                                                </td>
                                                <td style="padding: 7px 6px; text-align: right; border-right: 1px dashed var(--border-color, #e0e0e0); color: #0d6efd;">${m.theory_cost > 0 ? m.theory_cost.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₽' : '-'}</td>
                                                <td style="padding: 7px 6px; text-align: right; font-weight: 700; color: #fd7e14;">${m.fact_cost > 0 ? m.fact_cost.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₽' : '-'}</td>
                                            </tr>
                                        `).join('')}
                                    </tbody>
                                    <tfoot style="background: #f8f9fa; border-top: 2px solid var(--border-color, #e0e0e0);">
                                        <tr style="font-weight: 900;">
                                            <td style="padding: 10px; border-right: 1px solid var(--border-color, #e0e0e0);">ИТОГО (СЫРЬЕ):</td>
                                            <td style="padding: 10px; border-right: 1px dashed var(--border-color, #e0e0e0);"></td>
                                            <td style="padding: 10px; border-right: 1px solid var(--border-color, #e0e0e0);"></td>
                                            <td style="padding: 10px; text-align: right; border-right: 1px dashed var(--border-color, #e0e0e0); color: #0d6efd;">${theoreticalBase.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽</td>
                                            <td style="padding: 10px; text-align: right; color: #fd7e14;">${factMaterialsShown > 0 ? factMaterialsShown.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₽' : '-'}</td>
                                        </tr>
                                    </tfoot>
                                </table>
                            </div>
                        </div>

                        <!-- Методология расчёта Опыта -->
                        <div class="calc-method">
                            <b>ℹ️ Методология «Опыт»:</b> ${methodNote}
                        </div>
                    </div>

                    <!-- ======== ПРАВАЯ КОЛОНКА: Карточки ======== -->
                    <div class="reports-cost-right-stack">

                        <!-- Сырье: Идеал vs Опыт -->
                        <div class="calc-card" style="border-left: 4px solid #0d6efd;">
                            <div class="calc-card-header">📐 Себестоимость сырья (1 ед)</div>
                            <div class="calc-row">
                                <span class="text-muted">Идеал (Рецепт):</span>
                                <b>${theoreticalBase.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽</b>
                            </div>
                            <div class="calc-row" style="background: #f8f9fa; padding: 4px; border-radius: 4px; margin: -4px;">
                                <span class="text-muted">🧪 Опыт (Факт):</span>
                                <b style="color: #fd7e14;">${empiricalBase.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽</b>
                            </div>
                        </div>

                        <!-- Доп. расходы -->
                        <div class="calc-card" style="border-left: 4px solid #ff9800;">
                            <div class="calc-card-header">🔨 Доп. расходы (на 1 ед)</div>
                            <div class="calc-row">
                                <span class="text-muted">Амортизация:</span>
                                <b>${amortizationUnit.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽</b>
                            </div>
                            <div class="calc-row" style="margin-top: 6px;">
                                <label style="display: flex; align-items: center; cursor: pointer; user-select: none;">
                                    <input type="checkbox" id="reports-cost-toggle-overhead" ${includeOverhead ? 'checked' : ''} onchange="reportsCostToggleOverhead()" style="margin: 0 6px 0 0;" data-val="${overheadUnit}" data-plan-base="${theoreticalBase}" data-fact-base="${empiricalBase + amortizationUnit}">
                                    <span class="text-muted" style="font-size: 13px;">Оверхед (Завод):</span>
                                </label>
                                <b id="reports-cost-overhead-val" class="${includeOverhead ? 'reports-accent-orange' : 'text-muted text-decoration-line-through'}" title="Распределенные косвенные затраты">${overheadUnit.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽</b>
                            </div>
                        </div>

                        <!-- Коммерция и Налоги -->
                        <div class="calc-card" style="border-left: 4px solid #dc3545;">
                            <div class="calc-card-header">💼 Коммерция и Налоги</div>
                            <div class="calc-row">
                                <label style="display: flex; align-items: center; cursor: pointer; user-select: none;">
                                    <input type="checkbox" id="reports-cost-toggle-taxes" ${includeTaxes ? 'checked' : ''} onchange="reportsCostToggleTaxes()" style="margin: 0 6px 0 0;" data-rate="${taxRate}" data-tax-per-unit="${taxPerUnitFromRevenue}" data-avg-sale-price="${avgSalePricePerUnit}">
                                    <span class="text-danger" style="font-size: 13px;">Налог (%):</span>
                                </label>
                                <b id="reports-cost-taxes-val" class="${includeTaxes ? 'text-danger' : 'text-muted text-decoration-line-through'}">${taxRate}%</b>
                            </div>
                            <div class="calc-row" style="margin-top: 4px;">
                                <span class="text-muted">Налог в руб. (на 1 ед):</span>
                                <b id="reports-cost-taxes-rub" class="${includeTaxes ? 'text-danger' : 'text-muted text-decoration-line-through'}">${initialTaxFact.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽</b>
                            </div>
                        </div>

                        <!-- Результат -->
                        <div class="calc-card" style="background: #f8f9fa;">
                            <div class="calc-card-header">🧾 Итоги формирования себестоимости (1 ед)</div>
                            <div class="calc-row"><span>1) Сырье (план):</span><b id="reports-cost-breakdown-plan-mat">${theoreticalBase.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽</b></div>
                            <div class="calc-row"><span>2) Сырье (факт):</span><b id="reports-cost-breakdown-fact-mat">${empiricalBase.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽</b></div>
                            <div class="calc-row"><span>3) Амортизация:</span><b id="reports-cost-breakdown-amort">${amortizationUnit.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽</b></div>
                            <div class="calc-row"><span>4) Оверхед:</span><b id="reports-cost-breakdown-overhead">${initialOverhead.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽</b></div>
                            <div class="calc-row"><span>5) Налог:</span><b id="reports-cost-breakdown-tax">${initialTaxFact.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽</b></div>
                            <div class="calc-sep"></div>
                            <div class="calc-row" style="border-bottom: 1px dashed var(--border-color, #e0e0e0); padding-bottom: 6px; margin-bottom: 8px;">
                                <span>Плановая себестоимость:</span>
                                <strong><span id="reports-cost-plan-total">${initialPlanTotal.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽</span></strong>
                            </div>
                            <div class="calc-row" style="padding-bottom: 8px; margin-bottom: 10px;">
                                <span>Фактическая себестоимость:</span>
                                <strong class="text-success" style="font-size: 15px;"><span id="reports-cost-fact-total">${initialFactTotal.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽</span></strong>
                            </div>
                        </div>

                    </div>
                </div>
            </div>
            
            <script>
                function reportsCostFmt(v) {
                    return Number(v || 0).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₽';
                }
                function reportsCostRecalcTotals() {
                    const checkbox = document.getElementById('reports-cost-toggle-overhead');
                    const taxCheckbox = document.getElementById('reports-cost-toggle-taxes');
                    if (!checkbox || !taxCheckbox) return;
                    const include = checkbox.checked;
                    const includeTax = taxCheckbox.checked;
                    const overheadVal = Number(checkbox.dataset.val || 0);
                    const taxRateVal = Number(taxCheckbox.dataset.rate || 0);
                    const avgSalePriceRow = Number(taxCheckbox.dataset.avgSalePrice || 0);
                    const taxPerUnitRev = avgSalePriceRow > 0 && taxRateVal >= 0
                        ? Number(((avgSalePriceRow * taxRateVal) / 100).toFixed(2))
                        : 0;
                    const basePlan = Number(checkbox.dataset.planBase || 0);
                    const baseFact = Number(checkbox.dataset.factBase || 0);
                    const overhead = include ? overheadVal : 0;
                    const subtotalPlan = basePlan + overhead;
                    const subtotalFact = baseFact + overhead;
                    const taxPlan = includeTax ? Number((subtotalPlan * (taxRateVal / 100)).toFixed(2)) : 0;
                    const taxFact = includeTax
                        ? (taxPerUnitRev > 0
                            ? taxPerUnitRev
                            : Number(((subtotalFact * taxRateVal) / 100).toFixed(2)))
                        : 0;
                    const finalPlan = subtotalPlan + taxPlan;
                    const finalFact = subtotalFact + taxFact;
                    
                    const elOverhead = document.getElementById('reports-cost-overhead-val');
                    const elPlan = document.getElementById('reports-cost-plan-total');
                    const elFact = document.getElementById('reports-cost-fact-total');
                    const elTaxRub = document.getElementById('reports-cost-taxes-rub');
                    const elBPlanMat = document.getElementById('reports-cost-breakdown-plan-mat');
                    const elBFactMat = document.getElementById('reports-cost-breakdown-fact-mat');
                    const elBAmort = document.getElementById('reports-cost-breakdown-amort');
                    const elBOver = document.getElementById('reports-cost-breakdown-overhead');
                    const elBTax = document.getElementById('reports-cost-breakdown-tax');
                    if (!elOverhead || !elPlan || !elFact || !elTaxRub) return;
                    
                    if (include) {
                        elOverhead.classList.remove('text-muted', 'text-decoration-line-through');
                        elOverhead.classList.add('reports-accent-orange');
                    } else {
                        elOverhead.classList.add('text-muted', 'text-decoration-line-through');
                        elOverhead.classList.remove('reports-accent-orange');
                    }
                    elPlan.innerText = reportsCostFmt(finalPlan);
                    elFact.innerText = reportsCostFmt(finalFact);
                    elTaxRub.innerText = reportsCostFmt(taxFact);
                    if (elBPlanMat) elBPlanMat.innerText = reportsCostFmt(basePlan);
                    if (elBFactMat) elBFactMat.innerText = reportsCostFmt(baseFact - ${amortizationUnit});
                    if (elBAmort) elBAmort.innerText = reportsCostFmt(${amortizationUnit});
                    if (elBOver) elBOver.innerText = reportsCostFmt(overhead);
                    if (elBTax) elBTax.innerText = reportsCostFmt(taxFact);
                    if (includeTax) {
                        elTaxRub.classList.remove('text-muted', 'text-decoration-line-through');
                        elTaxRub.classList.add('text-danger');
                    } else {
                        elTaxRub.classList.add('text-muted', 'text-decoration-line-through');
                        elTaxRub.classList.remove('text-danger');
                    }

                    // Update parent table if checkbox was toggled manually to sync
                    const btnFilterOh = document.getElementById('reports-filter-include-overhead');
                    if (btnFilterOh && btnFilterOh.checked !== include) {
                        btnFilterOh.checked = include;
                        // Don't auto-reload the whole report as it closes the modal, just keep state synced for next render
                    }
                }
                function reportsCostToggleOverhead() {
                    reportsCostRecalcTotals();
                }
                function reportsCostToggleTaxes() {
                    const checkbox = document.getElementById('reports-cost-toggle-taxes');
                    const elTaxes = document.getElementById('reports-cost-taxes-val');
                    if (checkbox.checked) {
                        elTaxes.classList.remove('text-muted', 'text-decoration-line-through');
                        elTaxes.classList.add('text-danger');
                    } else {
                        elTaxes.classList.add('text-muted', 'text-decoration-line-through');
                        elTaxes.classList.remove('text-danger');
                    }
                    
                    const btnFilterTaxes = document.getElementById('reports-filter-include-taxes');
                    if (btnFilterTaxes && btnFilterTaxes.checked !== checkbox.checked) {
                        btnFilterTaxes.checked = checkbox.checked;
                    }
                    reportsCostRecalcTotals();
                }
                setTimeout(reportsCostRecalcTotals, 0);
            </script>
        `;

        UI.showModal(
            `Себестоимость: ${Utils.escapeHtml(itemName)}`,
            html,
            `<button type="button" class="btn btn-secondary w-100" onclick="UI.closeModal()">Закрыть</button>`
        );
    } catch (err) {
        console.error(err);
        UI.toast('Ошибка загрузки данных о себестоимости', 'error');
    }
};

window.reportsSavePrintSettings = async function() {
    try {
        const payload = {
            company_name: document.getElementById('rps-company_name')?.value || '',
            company_inn: document.getElementById('rps-company_inn')?.value || '',
            company_kpp: document.getElementById('rps-company_kpp')?.value || '',
            company_address: document.getElementById('rps-company_address')?.value || '',
            company_director: document.getElementById('rps-company_director')?.value || '',
            company_accountant: document.getElementById('rps-company_accountant')?.value || '',
            reports_preflight_mode: document.getElementById('rps-reports_preflight_mode')?.value || 'warning'
        };
        const res = await API.post('/api/reports/settings', payload);
        window.__reportsState.settings = res.settings || {};
        UI.closeModal();
        UI.toast('Реквизиты сохранены', 'success');
    } catch (err) {
        UI.toast(err.message || 'Ошибка сохранения реквизитов', 'error');
    }
};
