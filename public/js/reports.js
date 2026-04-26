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
    runs: [],
    runsLoadTimer: null,
    density: 'compact',
    periodPicker: null,
    stickyResizeBound: false,
    filterHeightObserver: null
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

function reportsApplyPeriodFromMode(mode, anchorDate, shouldLoad = true) {
    const dateRaw = anchorDate instanceof Date ? anchorDate : reportsGetAnchorDate();
    const safeMode = ['day', 'month', 'quarter', 'year'].includes(mode) ? mode : 'day';
    let anchor = new Date(dateRaw.getFullYear(), dateRaw.getMonth(), dateRaw.getDate());
    let from = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
    let to = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
    if (safeMode === 'month') {
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
    if (from === to) mode = 'day';
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
    if (!displayEl) return;
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
        itemId: document.getElementById('reports-filter-item')?.value || undefined,
        warehouseType: document.getElementById('reports-filter-warehouse')?.value || undefined,
        movementType: document.getElementById('reports-filter-movement-type')?.value || undefined,
        transactionType: document.getElementById('reports-filter-transaction-type')?.value || undefined
    };
    filters.counterpartyBalanceMode = document.getElementById('reports-filter-nonzero')?.value || 'nonzero';
    filters.excludeEmployees = Boolean(document.getElementById('reports-filter-exclude-employees')?.checked);
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
        inventory_register: ['reserve', 'adjustments']
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

function reportsPolarityClass(key = '') {
    const k = String(key || '').toLowerCase();
    if (!k) return '';
    if (/(opening_debit|debit_turnover|payment_in|shipment_in|closing_debit|\\bдз\\b|\\bдт\\b)/.test(k)) return 'reports-col-debit';
    if (/(opening_credit|credit_turnover|payment_out|shipment_out|closing_credit|\\bкз\\b|\\bкт\\b)/.test(k)) return 'reports-col-credit';
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
        inflow_qty: 'Приход',
        outflow_qty: 'Расход',
        closing_qty: 'Остаток конечный',
        amount_sum: 'Сумма',
        operations_count: 'Операций',
        quantity_sum: 'Количество (сумма)',
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
        inventory_register: 'Реестр движений запасов'
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

function reportsExtractTotalBalance(data) {
    const totals = data?.totals || {};
    if (Number.isFinite(Number(totals.closing_balance))) {
        return Number(totals.closing_balance);
    }
    const closingDebit = Number(totals.closing_debit || 0);
    const closingCredit = Number(totals.closing_credit || 0);
    if (Number.isFinite(closingDebit) || Number.isFinite(closingCredit)) {
        return Number((closingDebit - closingCredit).toFixed(2));
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
    const totalBalance = reportsExtractTotalBalance(data);
    if (totalBalance !== null) {
        items.push({
            label: 'Общее сальдо',
            value: reportsFormatMetric(totalBalance, 'closing_balance')
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
        .map((item) => `<span class="reports-head-summary-item"><span>${Utils.escapeHtml(item.label)}:</span> <strong>${Utils.escapeHtml(item.value)}</strong></span>`)
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
    const numericHints = /(debit|credit|opening|closing|balance|amount|sum|qty|quantity|turnover|payment|shipment|оборот|сальдо|остат|дт|кт|приход|расход|кол-во|сумма)/i;
    const numericCols = cols.map((c) => numericHints.test(`${c.key || ''} ${c.label || ''}`));

    table.classList.toggle('reports-table-osv', osvLike);
    table.classList.toggle('reports-table-register', !osvLike);
    table.dataset.reportType = reportType;

    const osvCounterpartyHead = reportType === 'osv_counterparties'
        ? reportsBuildOsvCounterpartyHeadRows(data, cols, numericCols)
        : '';
    if (osvCounterpartyHead) {
        head.innerHTML = osvCounterpartyHead;
    } else {
        const summaryRow = reportsBuildHeadSummaryRow(data, cols.length);
        const labelsRow = `<tr>${cols.map((c, idx) => {
            const cls = `${idx === 0 ? 'reports-col-main ' : ''}${numericCols[idx] ? 'reports-num ' : ''}${reportsPolarityClass(c.key)}`.trim();
            return `<th class="${cls}">${Utils.escapeHtml(c.label)}</th>`;
        }).join('')}</tr>`;
        head.innerHTML = `${summaryRow}${labelsRow}`;
    }
    body.innerHTML = rows.length
        ? rows.map((r) => `<tr>${cols.map((c, idx) => {
            const raw = r[c.key];
            const counterpartyId = Number(r.counterparty_id || 0);
            const commonClass = `${idx === 0 ? 'reports-col-main ' : ''}${numericCols[idx] ? 'reports-num ' : ''}${reportsPolarityClass(c.key)}`.trim();
            const numericValue = Number(raw || 0);
            const valueClass = numericCols[idx]
                ? (Math.abs(numericValue) < 0.000001 ? ' reports-num-zero' : (numericValue < 0 ? ' reports-num-neg' : ' reports-num-pos'))
                : '';
            if (reportType === 'osv_counterparties' && c.key === 'counterparty') {
                const label = Utils.escapeHtml(raw ?? '');
                return `<td class="${commonClass}"><button type="button" class="reports-cell-link reports-cell-link-main" data-counterparty-id="${counterpartyId}" title="${label}">${label}</button></td>`;
            }
            if (reportType === 'osv_counterparties' && numericCols[idx] && counterpartyId > 0) {
                return `<td class="${commonClass}"><button type="button" class="reports-cell-link reports-num-link${valueClass}" data-counterparty-id="${counterpartyId}" data-col-key="${Utils.escapeHtml(c.key)}" data-col-label="${Utils.escapeHtml(c.label)}">${reportsFormatMetric(raw, c.key)}</button></td>`;
            }
            return `<td class="${commonClass}${valueClass}">${numericCols[idx] ? reportsFormatMetric(raw, c.key) : Utils.escapeHtml(raw ?? '')}</td>`;
        }).join('')}</tr>`).join('')
        : `<tr><td colspan="${Math.max(cols.length, 1)}" class="text-muted">Нет данных</td></tr>`;

    if (tableTotals && Object.keys(tableTotals).length && cols.length) {
        foot.innerHTML = `<tr>${cols.map((c, idx) => {
            if (idx === 0) return '<th class="reports-col-main">Итого</th>';
            const val = tableTotals[c.key];
            const cls = `${numericCols[idx] ? 'reports-num ' : ''}${reportsPolarityClass(c.key)}`.trim();
            return `<th class="${cls}">${val === undefined ? '' : reportsFormatMetric(val, c.key)}</th>`;
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
            .map(([k, v]) => `<span class="reports-total-chip">${Utils.escapeHtml(reportsTotalLabel(k))}: <strong>${reportsFormatMetric(v, k)}</strong></span>`)
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
    if (!osvLike && data.consistency && Array.isArray(data.consistency.checks) && data.consistency.checks.length) {
        const badge = data.consistency.status === 'ok' ? 'Консистентность: OK' : 'Консистентность: есть замечания';
        totals.innerHTML = `<span class="reports-total-chip"><strong>${Utils.escapeHtml(badge)}</strong></span>` + totals.innerHTML;
    }
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

function reportsSetSelectValue(id, value) {
    const el = document.getElementById(id);
    if (!el) return;
    const v = value == null ? '' : String(value);
    if (el.tomselect) el.tomselect.setValue(v, true);
    else el.value = v;
}

function reportsApplyFilterVisibility() {
    const type = document.getElementById('reports-type')?.value || '';
    const map = {
        'reports-filter-counterparty': ['osv_counterparties'],
        'reports-filter-nonzero': ['osv_counterparties'],
        'reports-filter-account': ['osv_cash_accounts'],
        'reports-filter-item': ['osv_materials', 'osv_products', 'inventory_register'],
        'reports-filter-warehouse': ['inventory_register', 'osv_products'],
        'reports-filter-movement-type': ['inventory_register'],
        'reports-filter-transaction-type': ['turnover_finance']
    };
    Object.entries(map).forEach(([id, allowed]) => {
        const el = document.getElementById(id);
        if (!el || !el.closest('.form-group')) return;
        const fg = el.closest('.form-group');
        if (allowed.includes(type)) fg.classList.remove('reports-hidden');
        else {
            fg.classList.add('reports-hidden');
            el.value = id === 'reports-filter-nonzero' ? 'nonzero' : '';
        }
    });
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
    reportsFillSelect('reports-filter-account', data.accounts || [], 'name', 'id');
    reportsFillSelect('reports-filter-item', data.items || [], 'name', 'id');
    const mt = document.getElementById('reports-filter-movement-type');
    if (mt) {
        const current = mt.value;
        mt.innerHTML = '<option value="">Все</option>' + (data.movementTypes || []).map((v) => `<option value="${Utils.escapeHtml(v)}">${Utils.escapeHtml(v)}</option>`).join('');
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
    reportsSetSelectValue('reports-filter-item', p?.filters?.itemId || '');
    reportsSetSelectValue('reports-filter-warehouse', p?.filters?.warehouseType || '');
    reportsSetSelectValue('reports-filter-movement-type', p?.filters?.movementType || '');
    reportsSetSelectValue('reports-filter-transaction-type', p?.filters?.transactionType || '');
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
    reportsSetSelectValue('reports-filter-item', p.filters?.itemId || '');
    reportsSetSelectValue('reports-filter-warehouse', p.filters?.warehouseType || '');
    reportsSetSelectValue('reports-filter-movement-type', p.filters?.movementType || '');
    reportsSetSelectValue('reports-filter-transaction-type', p.filters?.transactionType || '');
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
        const btn = e.target.closest('.reports-cell-link');
        if (!btn) return;
        const cpId = Number(btn.getAttribute('data-counterparty-id') || 0);
        if (!cpId) return;
        const metricKey = String(btn.getAttribute('data-col-key') || '');
        const metricLabel = String(btn.getAttribute('data-col-label') || '');
        if (btn.classList.contains('reports-num-link') && metricKey) {
            reportsOpenCounterpartyDrilldown(cpId, metricKey, metricLabel);
            return;
        }
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
