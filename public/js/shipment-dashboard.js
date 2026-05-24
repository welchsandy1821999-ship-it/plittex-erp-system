; (function () {
    'use strict';

    const QTY_EPS = 0.0001;
    let sdSearchDebounceTimer = null;

    function fmtQty(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return '0';
        return n.toLocaleString('ru-RU', { maximumFractionDigits: 2, minimumFractionDigits: 0 });
    }

    function qtyClass(value) {
        return Number(value) > QTY_EPS ? 'text-danger font-bold' : '';
    }

    function entityLink(onclick, label, title) {
        const titleAttr = title ? ` title="${Utils.escapeHtml(title)}"` : '';
        return `<span class="entity-link"${titleAttr} onclick="${onclick}">${label}</span>`;
    }

    function buildShipmentDashboardQuery() {
        const params = new URLSearchParams();
        const plannedFrom = document.getElementById('sd-planned-from')?.value || '';
        const plannedTo = document.getElementById('sd-planned-to')?.value || '';
        const search = (document.getElementById('sd-search')?.value || '').trim();
        const onlyDeficit = document.getElementById('sd-only-deficit')?.checked;

        if (plannedFrom) params.set('planned_from', plannedFrom);
        if (plannedTo) params.set('planned_to', plannedTo);
        if (search) params.set('search', search);
        if (onlyDeficit) params.set('only_deficit', 'true');

        const qs = params.toString();
        return qs ? `?${qs}` : '';
    }

    function renderShipmentDashboardSummary(summary) {
        const el = document.getElementById('sd-dashboard-summary');
        if (!el) return;
        if (!summary) {
            el.innerHTML = '';
            return;
        }
        const truncated = summary.possibly_truncated
            ? ' <span class="text-warning">(достигнут лимит строк — уточните период или поиск)</span>'
            : '';
        const safety = summary.safety_mode
            ? ' <span class="text-muted">· без дат: последние 24 мес., лимит ' + (summary.row_limit || 200) + '</span>'
            : '';
        el.innerHTML =
            `Заказов: <b>${summary.order_count || 0}</b> · ` +
            `Строк: <b>${summary.line_count || 0}</b> · ` +
            `Дефицит резерва: <b class="text-danger">${summary.lines_with_reserve_deficit || 0}</b> · ` +
            `Дефицит производства: <b class="text-danger">${summary.lines_with_production_deficit || 0}</b>` +
            safety + truncated;
    }

    function renderShipmentDashboardRows(rows) {
        const tbody = document.getElementById('sd-dashboard-table');
        if (!tbody) return;

        if (!Array.isArray(rows) || rows.length === 0) {
            tbody.innerHTML =
                '<tr><td colspan="9" class="text-center p-20 text-muted font-italic">Нет строк по выбранным фильтрам</td></tr>';
            return;
        }

        tbody.innerHTML = rows.map((row) => {
            const docLabel = Utils.escapeHtml(row.order_number || '—');
            const clientLabel = Utils.escapeHtml(row.client_name || '—');
            const planDate = Utils.escapeHtml(row.planned_shipment_date || '—');
            const itemLabel = Utils.escapeHtml(row.item_name || '—');
            const status = Utils.escapeHtml(row.order_status || '');
            const unit = row.item_unit ? ` <span class="text-muted font-12">${Utils.escapeHtml(row.item_unit)}</span>` : '';
            const orderId = Number(row.order_id);
            const cpId = Number(row.counterparty_id);
            const itemId = Number(row.item_id);

            const docHtml = orderId
                ? entityLink(`openOrderDetails(${orderId})`, docLabel, 'Открыть заказ')
                : docLabel;
            const clientHtml = cpId
                ? entityLink(`window.app.openEntity('client', ${cpId})`, clientLabel, 'Открыть карточку клиента')
                : clientLabel;
            const itemHtml = itemId
                ? entityLink(`window.app.openEntity('item_movement', ${itemId})`, itemLabel, 'Открыть движения номенклатуры')
                : itemLabel;

            return `
                <tr>
                    <td class="p-8">
                        <span class="font-bold">${docHtml}</span>
                        ${status ? `<br><span class="font-11 text-muted">${status}</span>` : ''}
                    </td>
                    <td class="p-8">${clientHtml}</td>
                    <td class="p-8 text-nowrap">${planDate}</td>
                    <td class="p-8">${itemHtml}${unit}</td>
                    <td class="p-8 text-right">${fmtQty(row.qty_ordered)}</td>
                    <td class="p-8 text-right">${fmtQty(row.qty_reserved)}</td>
                    <td class="p-8 text-right ${qtyClass(row.qty_need_reserve)}">${fmtQty(row.qty_need_reserve)}</td>
                    <td class="p-8 text-right ${qtyClass(row.qty_production)}">${fmtQty(row.qty_production)}</td>
                    <td class="p-8 text-center text-nowrap sd-actions-cell">
                        <div class="sales-dropdown sd-actions-dropdown">
                            <button type="button" class="btn btn-outline btn-sm">Действия <span class="font-10 ml-5">▼</span></button>
                            <div class="sales-dropdown-content">
                                <button type="button" onclick="openOrderDetails(${orderId})">📄 Просмотр заказа</button>
                                <button type="button" onclick="openOrderManager(${orderId})">🚚 Отгрузка</button>
                            </div>
                        </div>
                    </td>
                </tr>
            `;
        }).join('');
    }

    window.loadShipmentDashboard = async function () {
        const tbody = document.getElementById('sd-dashboard-table');
        if (tbody) {
            tbody.innerHTML =
                '<tr><td colspan="9" class="text-center p-20 text-muted font-italic">Загрузка...</td></tr>';
        }

        try {
            const data = await API.get('/api/sales/shipment-dashboard' + buildShipmentDashboardQuery());
            if (!data || data.success !== true) {
                throw new Error((data && data.error) || 'Некорректный ответ сервера');
            }
            renderShipmentDashboardSummary(data.summary);
            renderShipmentDashboardRows(data.rows);
        } catch (err) {
            console.error(err);
            renderShipmentDashboardSummary(null);
            if (tbody) {
                const msg = Utils.escapeHtml(err?.message || 'Ошибка загрузки сводки отгрузок');
                tbody.innerHTML =
                    `<tr><td colspan="9" class="text-center p-20 text-danger">${msg}</td></tr>`;
            }
        }
    };

    window.refreshShipmentDashboardIfActive = function () {
        const tab = document.getElementById('tab-shipment-dashboard');
        if (!tab || !tab.classList.contains('active')) return;
        if (typeof loadShipmentDashboard === 'function') loadShipmentDashboard();
    };

    window.resetShipmentDashboardFilters = function () {
        const fromEl = document.getElementById('sd-planned-from');
        const toEl = document.getElementById('sd-planned-to');
        const searchEl = document.getElementById('sd-search');
        const deficitEl = document.getElementById('sd-only-deficit');
        if (fromEl) fromEl.value = '';
        if (toEl) toEl.value = '';
        if (searchEl) searchEl.value = '';
        if (deficitEl) deficitEl.checked = true;
        loadShipmentDashboard();
    };

    function scheduleShipmentDashboardSearch() {
        if (sdSearchDebounceTimer) clearTimeout(sdSearchDebounceTimer);
        sdSearchDebounceTimer = setTimeout(() => {
            loadShipmentDashboard();
        }, 300);
    }

    function initShipmentDashboardFilters() {
        const fromEl = document.getElementById('sd-planned-from');
        const toEl = document.getElementById('sd-planned-to');
        const searchEl = document.getElementById('sd-search');
        const deficitEl = document.getElementById('sd-only-deficit');

        if (fromEl && !fromEl.dataset.sdBound) {
            fromEl.dataset.sdBound = '1';
            fromEl.addEventListener('change', loadShipmentDashboard);
        }
        if (toEl && !toEl.dataset.sdBound) {
            toEl.dataset.sdBound = '1';
            toEl.addEventListener('change', loadShipmentDashboard);
        }
        if (deficitEl && !deficitEl.dataset.sdBound) {
            deficitEl.dataset.sdBound = '1';
            deficitEl.addEventListener('change', loadShipmentDashboard);
        }
        if (searchEl && !searchEl.dataset.sdBound) {
            searchEl.dataset.sdBound = '1';
            searchEl.addEventListener('input', scheduleShipmentDashboardSearch);
            searchEl.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    if (sdSearchDebounceTimer) clearTimeout(sdSearchDebounceTimer);
                    loadShipmentDashboard();
                }
            });
        }
    }

    document.addEventListener('DOMContentLoaded', initShipmentDashboardFilters);
})();
