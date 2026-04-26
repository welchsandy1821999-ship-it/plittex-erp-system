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
    stickyResizeBound: false,
    filterHeightObserver: null
};

function reportsTodayStr() {
    return new Date().toISOString().slice(0, 10);
}

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
    const nonZeroMode = document.getElementById('reports-filter-nonzero')?.value || 'all';
    if (nonZeroMode === 'nonzero') filters.nonZeroClosing = true;
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

function reportsFormatMetric(value, key = '') {
    const n = Number(value);
    if (!Number.isFinite(n)) return Utils.escapeHtml(value ?? '');
    if (/qty|quantity|кол-во|количеств/i.test(key)) {
        return n.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 4 });
    }
    return n.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function reportsTotalLabel(key) {
    const map = {
        opening_debit: 'Сальдо нач. Дт',
        opening_credit: 'Сальдо нач. Кт',
        debit_turnover: 'Оборот Дт',
        credit_turnover: 'Оборот Кт',
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

function reportsMeasureStickyOffsets() {
    const mod = document.getElementById('reports-mod');
    const filterCard = document.querySelector('#reports-mod .reports-filter-card');
    if (!mod || !filterCard) return;
    if (!mod.classList.contains('active')) return;
    const stickyTop = parseFloat(window.getComputedStyle(filterCard).top || '0') || 0;
    const filterHeight = Math.ceil(filterCard.offsetHeight || 0);
    if (filterHeight < 24) return;
    mod.style.setProperty('--reports-filter-height', `${Math.max(0, Math.ceil(filterHeight + stickyTop))}px`);
}

function reportsInitFilterHeightObserver() {
    if (window.__reportsState.filterHeightObserver || typeof ResizeObserver === 'undefined') return;
    const filterCard = document.querySelector('#reports-mod .reports-filter-card');
    if (!filterCard) return;
    const observer = new ResizeObserver(() => {
        requestAnimationFrame(reportsMeasureStickyOffsets);
    });
    observer.observe(filterCard);
    window.__reportsState.filterHeightObserver = observer;
}

window.reportsToggleDensity = function() {
    window.__reportsState.density = window.__reportsState.density === 'compact' ? 'standard' : 'compact';
    reportsApplyDensity();
    reportsMeasureStickyOffsets();
};

function reportsRender(data) {
    const head = document.getElementById('reports-head');
    const body = document.getElementById('reports-body');
    const foot = document.getElementById('reports-foot');
    const totals = document.getElementById('reports-totals');
    const title = document.getElementById('reports-title');
    const meta = document.getElementById('reports-meta');
    const table = document.getElementById('reports-table');
    const warning = document.getElementById('reports-warning');
    if (!head || !body || !foot || !totals || !title || !meta || !table) return;

    title.textContent = data.title || 'Отчет';
    meta.textContent = `${data.period?.dateFrom || ''} — ${data.period?.dateTo || ''}`;
    if (data.accountingMode === 'regulatory') meta.textContent += ' | Регламентный режим';
    if (data.printTemplateVersion) meta.textContent += ` | шаблон: ${data.printTemplateVersion}`;

    const cols = Array.isArray(data.columns) ? data.columns : [];
    const rows = Array.isArray(data.rows) ? data.rows : [];
    const reportType = data.reportType || window.__reportsState.lastPayload?.reportType || '';
    const osvLike = ['osv_counterparties', 'osv_cash_accounts', 'osv_materials', 'osv_products'].includes(reportType);
    const numericHints = /(debit|credit|opening|closing|balance|amount|sum|qty|quantity|turnover|оборот|сальдо|остат|дт|кт|кол-во|сумма)/i;
    const numericCols = cols.map((c) => numericHints.test(`${c.key || ''} ${c.label || ''}`));

    table.classList.toggle('reports-table-osv', osvLike);
    table.classList.toggle('reports-table-register', !osvLike);
    table.dataset.reportType = reportType;

    head.innerHTML = `<tr>${cols.map((c, idx) => `<th class="${idx === 0 ? 'reports-col-main' : ''} ${numericCols[idx] ? 'reports-num' : ''}">${Utils.escapeHtml(c.label)}</th>`).join('')}</tr>`;
    body.innerHTML = rows.length
        ? rows.map((r) => `<tr>${cols.map((c, idx) => {
            const raw = r[c.key];
            const counterpartyId = Number(r.counterparty_id || 0);
            const commonClass = `${idx === 0 ? 'reports-col-main' : ''} ${numericCols[idx] ? 'reports-num' : ''}`.trim();
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

    if (data.totals && Object.keys(data.totals).length && cols.length) {
        foot.innerHTML = `<tr>${cols.map((c, idx) => {
            if (idx === 0) return '<th class="reports-col-main">Итого</th>';
            const val = data.totals[c.key];
            return `<th class="${numericCols[idx] ? 'reports-num' : ''}">${val === undefined ? '' : reportsFormatMetric(val, c.key)}</th>`;
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
        const preflightBlock = preflight
            ? [`Проверка перед формированием: ${reportsFormatRunPreflight(preflight.status || '') || 'неизвестно'}${preflight.mode ? ` (${preflight.mode})` : ''}`]
                .concat(Array.isArray(preflight.reasons) ? preflight.reasons : [])
            : [];
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
        meta.textContent += ` | стр. ${p.page}/${p.totalPages}, строк: ${p.totalRows}`;
    }
    if (!osvLike && data.consistency && Array.isArray(data.consistency.checks) && data.consistency.checks.length) {
        const badge = data.consistency.status === 'ok' ? 'Консистентность: OK' : 'Консистентность: есть замечания';
        totals.innerHTML = `<span class="reports-total-chip"><strong>${Utils.escapeHtml(badge)}</strong></span>` + totals.innerHTML;
    }
    requestAnimationFrame(reportsMeasureStickyOffsets);
}

window.reportsSetQuick = function(mode) {
    const now = new Date();
    let from = new Date(now.getFullYear(), now.getMonth(), 1);
    let to = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    if (mode === 'quarter') {
        const qStartMonth = Math.floor(now.getMonth() / 3) * 3;
        from = new Date(now.getFullYear(), qStartMonth, 1);
        to = new Date(now.getFullYear(), qStartMonth + 3, 0);
    }
    if (mode === 'year') {
        from = new Date(now.getFullYear(), 0, 1);
        to = new Date(now.getFullYear(), 11, 31);
    }
    if (mode === 'ytd') {
        from = new Date(now.getFullYear(), 0, 1);
        to = now;
    }
    const f = from.toISOString().slice(0, 10);
    const t = to.toISOString().slice(0, 10);
    document.getElementById('reports-date-from').value = f;
    document.getElementById('reports-date-to').value = t;
    window.__reportsState.page = 1;
    reportsLoadPreview();
};

function reportsFillSelect(id, rows, labelKey = 'name', valueKey = 'id') {
    const el = document.getElementById(id);
    if (!el) return;
    const current = el.value;
    const base = '<option value="">Все</option>';
    const options = (rows || []).map((r) => `<option value="${Utils.escapeHtml(r[valueKey])}">${Utils.escapeHtml(r[labelKey])}</option>`).join('');
    el.innerHTML = base + options;
    if (current) el.value = current;
}

function reportsApplyFilterVisibility() {
    const type = document.getElementById('reports-type')?.value || '';
    const map = {
        'reports-filter-counterparty': ['osv_counterparties'],
        'reports-filter-nonzero': ['osv_counterparties'],
        'reports-filter-account': ['osv_cash_accounts'],
        'reports-filter-item': ['osv_materials', 'osv_products', 'inventory_register'],
        'reports-filter-warehouse': ['inventory_register'],
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
            el.value = id === 'reports-filter-nonzero' ? 'all' : '';
        }
    });
    requestAnimationFrame(reportsMeasureStickyOffsets);
}

function reportsDrilldownRangeLabel(rangeMode = 'period') {
    if (rangeMode === 'opening') return 'до начала периода';
    if (rangeMode === 'closing') return 'с начала учета по дату конца периода';
    return 'за выбранный период';
}

window.reportsOpenCounterpartyDrilldown = async function(counterpartyId, colKey, colLabel) {
    const payload = window.__reportsState.lastPayload || reportsBuildPayload();
    if (!counterpartyId || !payload?.dateFrom || !payload?.dateTo) return;
    try {
        const qs = new URLSearchParams({
            counterpartyId: String(counterpartyId),
            dateFrom: String(payload.dateFrom),
            dateTo: String(payload.dateTo),
            metric: String(colKey || '')
        });
        const data = await API.get(`/api/reports/counterparty-drilldown?${qs.toString()}`);
        const rows = Array.isArray(data.rows) ? data.rows : [];
        const rowsHtml = rows.length
            ? rows.map((r) => `
                <tr>
                    <td>${Utils.escapeHtml(r.date || '')}</td>
                    <td>${Utils.escapeHtml(r.type || '')}</td>
                    <td class="text-right">${Utils.escapeHtml(reportsFormatMetric(r.amount || 0, 'amount'))}</td>
                    <td>${Utils.escapeHtml(r.account || '')}</td>
                    <td>${Utils.escapeHtml(r.category || '')}</td>
                    <td>${Utils.escapeHtml(r.note || '')}</td>
                </tr>
            `).join('')
            : '<tr><td colspan="6" class="text-muted">По условиям выборки операций не найдено</td></tr>';
        UI.showModal(
            `Расшифровка: ${Utils.escapeHtml(colLabel || colKey || 'показатель')}`,
            `
                <div class="mb-10">
                    <div><strong>Контрагент:</strong> ${Utils.escapeHtml(data.counterpartyName || '')}</div>
                    <div class="text-muted font-12">Показаны операции ${Utils.escapeHtml(reportsDrilldownRangeLabel(data.rangeMode))}. Найдено: ${Utils.escapeHtml(rows.length)}</div>
                </div>
                <div class="reports-preview-scroll">
                    <table class="data-table reports-drilldown-table">
                        <thead>
                            <tr><th>Дата</th><th>Тип</th><th>Сумма</th><th>Счет</th><th>Статья</th><th>Комментарий</th></tr>
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
    reportsFillSelect('reports-filter-account', data.accounts || [], 'name', 'id');
    reportsFillSelect('reports-filter-item', data.items || [], 'name', 'id');
    const mt = document.getElementById('reports-filter-movement-type');
    if (mt) {
        const current = mt.value;
        mt.innerHTML = '<option value="">Все</option>' + (data.movementTypes || []).map((v) => `<option value="${Utils.escapeHtml(v)}">${Utils.escapeHtml(v)}</option>`).join('');
        if (current) mt.value = current;
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
        reportsMeasureStickyOffsets();
        setTimeout(() => {
            const filterCard = document.querySelector('#reports-mod .reports-filter-card');
            const mod = document.getElementById('reports-mod');
            if (!filterCard || !mod) return;
            const panelHeight = Math.ceil(filterCard.offsetHeight || 0);
            mod.style.setProperty('--reports-filter-height', `${panelHeight}px`);
        }, 50);
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
    if (from && !from.value) {
        const d = new Date();
        from.value = new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
    }
    if (to && !to.value) to.value = reportsTodayStr();
    const savedDensity = (() => {
        try { return localStorage.getItem('reportsDensity') || 'compact'; } catch (_) { return 'compact'; }
    })();
    window.__reportsState.density = savedDensity === 'standard' ? 'standard' : 'compact';
    reportsApplyDensity();
    reportsMeasureStickyOffsets();
    reportsInitFilterHeightObserver();
    if (!window.__reportsState.stickyResizeBound) {
        window.addEventListener('resize', () => requestAnimationFrame(reportsMeasureStickyOffsets), { passive: true });
        window.__reportsState.stickyResizeBound = true;
    }
    if (document.getElementById('reports-mod')) {
        setTimeout(reportsMeasureStickyOffsets, 0);
        setTimeout(reportsMeasureStickyOffsets, 120);
        reportsBindTableLinks();
        reportsLoadOptions()
            .then(() => {
                reportsApplyFilterVisibility();
                reportsLoadPreview();
                reportsLoadRuns();
                reportsMeasureStickyOffsets();
            })
            .catch((err) => {
                console.error(err);
                UI.toast(err.message || 'Ошибка загрузки справочников отчетов', 'error');
            });
    }
};

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
    if (p && p.accountingMode) document.getElementById('reports-accounting-mode').value = p.accountingMode;
    else if (run.accounting_mode) document.getElementById('reports-accounting-mode').value = run.accounting_mode;
    if (p && p.printTemplateVersion) document.getElementById('reports-print-template-version').value = p.printTemplateVersion;
    document.getElementById('reports-filter-counterparty').value = p?.filters?.counterpartyId || '';
    document.getElementById('reports-filter-nonzero').value = p?.filters?.nonZeroClosing ? 'nonzero' : 'all';
    document.getElementById('reports-filter-account').value = p?.filters?.accountId || '';
    document.getElementById('reports-filter-item').value = p?.filters?.itemId || '';
    document.getElementById('reports-filter-warehouse').value = p?.filters?.warehouseType || '';
    document.getElementById('reports-filter-movement-type').value = p?.filters?.movementType || '';
    document.getElementById('reports-filter-transaction-type').value = p?.filters?.transactionType || '';
    window.__reportsState.visibleColumns = Array.isArray(p?.visibleColumns) ? p.visibleColumns.slice() : [];
    const replayPage = Number(p?.pagination?.page || 1);
    if (p?.pagination?.pageSize) {
        window.__reportsState.pageSize = Number(p.pagination.pageSize) || window.__reportsState.pageSize;
    }
    window.__reportsState.page = Number.isFinite(replayPage) && replayPage > 0 ? replayPage : 1;
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
    if (p.accountingMode) document.getElementById('reports-accounting-mode').value = p.accountingMode;
    document.getElementById('reports-filter-counterparty').value = p.filters?.counterpartyId || '';
    document.getElementById('reports-filter-nonzero').value = p?.filters?.nonZeroClosing ? 'nonzero' : 'all';
    document.getElementById('reports-filter-account').value = p.filters?.accountId || '';
    document.getElementById('reports-filter-item').value = p.filters?.itemId || '';
    document.getElementById('reports-filter-warehouse').value = p.filters?.warehouseType || '';
    document.getElementById('reports-filter-movement-type').value = p.filters?.movementType || '';
    document.getElementById('reports-filter-transaction-type').value = p.filters?.transactionType || '';
    window.__reportsState.visibleColumns = Array.isArray(p.visibleColumns) ? p.visibleColumns.slice() : [];
    window.__reportsState.page = 1;
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
