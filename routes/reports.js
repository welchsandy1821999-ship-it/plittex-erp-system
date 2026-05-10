const express = require('express');
const ExcelJS = require('exceljs');
const crypto = require('crypto');
const { validateReportRequest } = require('../middleware/validator');
const { auditLog } = require('../utils/db_init');
const { buildSalesAnalyticsUnitCostMap } = require('../utils/salesAnalyticsUnitCost');
const { requireAdmin, requireReportAccess, hasReportPermission } = require('../middleware/auth');

const REPORT_TYPES = new Set([
    'osv_counterparties',
    'osv_cash_accounts',
    'osv_materials',
    'osv_products',
    'turnover_finance',
    'inventory_register',
    'sales_analytics'
]);

/** Внутренние складские перемещения в резерв не входят в коммерческий «Приход/Расход» ОСВ по продукции. */
const PRODUCT_OSV_COMMERCIAL_PERIOD_RESERVE_EXCLUSION_SQL =
    ` AND m.movement_type NOT IN ('reserve_expense', 'reserve_receipt', 'reserve_release_expense', 'reserve_release_receipt', 'reserve_transfer_in', 'reserve_transfer_out')`;

/** Имя синтетического склада после слия finished + reserve (Единая площадка). */
const OSV_PRODUCT_FG_RESERVE_POOL_LABEL = 'Готовая продукция + Резерв';

function toIsoDateStart(s) {
    const d = new Date(`${s}T00:00:00`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function toIsoDateEnd(s) {
    const d = new Date(`${s}T23:59:59.999`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function escapeHtml(v) {
    return String(v == null ? '' : v)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function escapeCsv(v) {
    const s = String(v == null ? '' : v);
    if (s.includes(';') || s.includes('"') || s.includes('\n')) {
        return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
}

function normalizeDrilldownAccountName(v) {
    const src = String(v == null ? '' : v).trim();
    if (!src) return 'Без счета';
    let out = src;
    // Remove long numeric account fragments, usually in parentheses.
    out = out.replace(/\(\s*[\d\s/.-]{8,}\s*\)/g, '');
    out = out.replace(/\b\d{8,}\b/g, '');
    out = out.replace(/\(\s*\)/g, '');
    out = out.replace(/[\/,.-]\s*$/g, '');
    out = out.replace(/\s{2,}/g, ' ').trim();
    return out || src;
}

function getCashAccountOrderWeight(name) {
    const n = String(name || '').toLowerCase();
    if (n.includes('касса')) return 0;
    if (n.includes('точка')) return 1;
    if (n.includes('альфа') || n.includes('alpha')) return 2;
    if (n.includes('подотч')) return 4;
    return 3;
}

function buildRunsCsv(rows = []) {
    const headers = ['Дата', 'Пользователь', 'Документ', 'Период с', 'Период по', 'Режим учета', 'Формат', 'Строк', 'Preflight статус', 'Preflight причина', 'Payload hash'];
    const lines = rows.map((r) => ([
        new Date(r.generated_at).toLocaleString('ru-RU'),
        r.username || 'system',
        r.report_type || '',
        r.date_from || '',
        r.date_to || '',
        r.accounting_mode || '',
        r.format || '',
        Number(r.rows_count || 0),
        r.preflight_status || '',
        r.preflight_reason || '',
        r.payload_hash || ''
    ].map((x) => escapeCsv(x)).join(';')));
    return `\uFEFF${headers.map((h) => escapeCsv(h)).join(';')}\n${lines.join('\n')}`;
}

function normalizePeriod(reqBody = {}) {
    const now = new Date();
    const defaultStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const defaultEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    const dateFrom = reqBody.dateFrom || defaultStart.toISOString().slice(0, 10);
    const dateTo = reqBody.dateTo || defaultEnd.toISOString().slice(0, 10);
    const fromTs = toIsoDateStart(dateFrom);
    const toTs = toIsoDateEnd(dateTo);

    return { dateFrom, dateTo, fromTs, toTs };
}

function normalizeAccountingMode(v) {
    return String(v || 'managerial').toLowerCase() === 'regulatory' ? 'regulatory' : 'managerial';
}

function isAdmin(user) {
    return Boolean(user && String(user.role || '').toLowerCase() === 'admin');
}

async function initReportsInfra(pool) {
    /* DDL/индексы и backfill reg_*: scripts/migrations/pending_ddl.sql */
}

function reportDateExpr(alias = 'm') {
    return `COALESCE(${alias}.movement_date, ${alias}.created_at)`;
}

function periodDays(period) {
    const a = new Date(period.fromTs).getTime();
    const b = new Date(period.toTs).getTime();
    if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 0;
    return Math.floor((b - a) / (24 * 60 * 60 * 1000)) + 1;
}

function formatNumber(v) {
    return Number(v || 0).toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 4 });
}

function reportTotalLabel(k = '') {
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
        quantity_sum: 'Количество',
        rows_count: 'Строк',
        rows_total: 'Строк (всего)'
    };
    return map[k] || k;
}

async function buildInventoryValuationCoverage(pool, period = null, warehouseTypes = null) {
    const params = [];
    let where = 'WHERE 1=1';
    if (period && period.fromTs && period.toTs) {
        params.push(period.fromTs, period.toTs);
        where += ` AND ${reportDateExpr('m')} >= $${params.length - 1}::timestamp AND ${reportDateExpr('m')} <= $${params.length}::timestamp `;
    }
    if (Array.isArray(warehouseTypes) && warehouseTypes.length) {
        params.push(warehouseTypes);
        where += ` AND w.type = ANY($${params.length}::text[]) `;
    }
    const sql = `
        SELECT
            m.movement_type,
            COUNT(*)::int AS total_rows,
            SUM(CASE WHEN NULLIF(m.unit_price, 0) IS NOT NULL THEN 1 ELSE 0 END)::int AS unit_price_rows,
            SUM(CASE WHEN NULLIF(m.unit_price, 0) IS NULL AND m.movement_type IN ('sales_shipment', 'shipment_reversal') AND coi.price IS NOT NULL THEN 1 ELSE 0 END)::int AS shipment_price_rows,
            SUM(CASE WHEN NULLIF(m.unit_price, 0) IS NULL AND NOT (m.movement_type IN ('sales_shipment', 'shipment_reversal') AND coi.price IS NOT NULL) THEN 1 ELSE 0 END)::int AS fallback_rows
        FROM inventory_movements m
        JOIN warehouses w ON w.id = m.warehouse_id
        LEFT JOIN client_order_items coi ON coi.id = m.linked_order_item_id
        ${where}
        GROUP BY m.movement_type
        ORDER BY total_rows DESC, m.movement_type ASC
    `;
    const res = await pool.query(sql, params);
    const rows = (res.rows || []).map((r) => ({
        movement_type: r.movement_type,
        total_rows: Number(r.total_rows || 0),
        unit_price_rows: Number(r.unit_price_rows || 0),
        shipment_price_rows: Number(r.shipment_price_rows || 0),
        fallback_rows: Number(r.fallback_rows || 0),
        coverage_pct: Number((Number(r.total_rows || 0) > 0
            ? ((Number(r.unit_price_rows || 0) + Number(r.shipment_price_rows || 0)) * 100 / Number(r.total_rows || 1))
            : 100).toFixed(2))
    }));
    const totals = {
        total_rows: rows.reduce((s, r) => s + r.total_rows, 0),
        unit_price_rows: rows.reduce((s, r) => s + r.unit_price_rows, 0),
        shipment_price_rows: rows.reduce((s, r) => s + r.shipment_price_rows, 0),
        fallback_rows: rows.reduce((s, r) => s + r.fallback_rows, 0)
    };
    totals.coverage_pct = Number((totals.total_rows > 0
        ? ((totals.unit_price_rows + totals.shipment_price_rows) * 100 / totals.total_rows)
        : 100).toFixed(2));
    return { rows, totals };
}

/** Пары (item_id, warehouse_id), у которых в выбранном периоде накопленный остаток уходил в минус (хронология по дате движения). */
async function auditHistoricalNegativeBalanceInPeriod(pool, period, warehouseTypes = null) {
    const whFilter =
        Array.isArray(warehouseTypes) && warehouseTypes.length ? ' AND w.type = ANY($3::text[])' : '';
    const params = [period.fromTs, period.toTs];
    if (whFilter) params.push(warehouseTypes);
    const sql = `
        WITH mv AS (
            SELECT m.id, m.item_id, m.warehouse_id, m.quantity,
                   COALESCE(m.movement_date, m.created_at) AS ts
            FROM inventory_movements m
            INNER JOIN warehouses w ON w.id = m.warehouse_id
            WHERE 1 = 1${whFilter}
        ),
        ord AS (
            SELECT mv.id, mv.item_id, mv.warehouse_id, mv.ts,
                   SUM(mv.quantity) OVER (
                       PARTITION BY mv.item_id, mv.warehouse_id
                       ORDER BY mv.ts, mv.id
                       ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                   ) AS run_bal
            FROM mv
        )
        SELECT DISTINCT ord.item_id, ord.warehouse_id
        FROM ord
        WHERE ord.run_bal < -0.0001
          AND ord.ts >= $1::timestamp
          AND ord.ts <= $2::timestamp
        ORDER BY ord.item_id, ord.warehouse_id
        LIMIT 500
    `;
    const res = await pool.query(sql, params);
    return (res.rows || []).map((r) => ({
        item_id: Number(r.item_id || 0),
        warehouse_id: Number(r.warehouse_id || 0)
    }));
}

async function backfillInventoryUnitPrice(pool, period, apply = false, warehouseTypes = null) {
    const negativePairs = await auditHistoricalNegativeBalanceInPeriod(pool, period, warehouseTypes);
    if (negativePairs.length) {
        console.warn(
            '[reports] inventory valuation backfill: historical negative running balance in period (sample):',
            negativePairs.slice(0, 40),
            negativePairs.length > 40 ? `(+${negativePairs.length - 40} more)` : ''
        );
    }

    const params = [period.fromTs, period.toTs];
    let where = `WHERE ${reportDateExpr('m')} >= $1::timestamp AND ${reportDateExpr('m')} <= $2::timestamp AND NULLIF(m.unit_price, 0) IS NULL`;
    if (Array.isArray(warehouseTypes) && warehouseTypes.length) {
        params.push(warehouseTypes);
        where += ` AND w.type = ANY($${params.length}::text[])`;
    }
    const previewSql = `
        SELECT
            m.id,
            m.movement_type,
            COALESCE(
                CASE WHEN m.movement_type IN ('sales_shipment', 'shipment_reversal') THEN coi.price ELSE NULL END,
                i.current_price,
                0
            )::numeric(14,4) AS resolved_price
        FROM inventory_movements m
        JOIN items i ON i.id = m.item_id
        JOIN warehouses w ON w.id = m.warehouse_id
        LEFT JOIN client_order_items coi ON coi.id = m.linked_order_item_id
        ${where}
    `;
    const previewRes = await pool.query(previewSql, params);
    const rows = previewRes.rows || [];
    if (!apply) {
        return {
            mode: 'dry_run',
            rows_to_update: rows.length,
            sample: rows.slice(0, 20).map((r) => ({
                id: Number(r.id || 0),
                movement_type: r.movement_type,
                resolved_price: Number(r.resolved_price || 0)
            })),
            negative_balance_pairs: negativePairs
        };
    }
    /* FROM не может ссылаться на целевой алиас m в ON (PostgreSQL: missing FROM-clause entry for table "m").
       Склад и цена строки заказа выносим в WHERE EXISTS и скалярный подзапрос в SET. */
    const updateSql = `
        UPDATE inventory_movements m
        SET unit_price = COALESCE(
            CASE WHEN m.movement_type IN ('sales_shipment', 'shipment_reversal') THEN (
                SELECT coi.price FROM client_order_items coi WHERE coi.id = m.linked_order_item_id LIMIT 1
            ) ELSE NULL END,
            i.current_price,
            0
        )::numeric(14,4)
        FROM items i
        WHERE i.id = m.item_id
          AND ${reportDateExpr('m')} >= $1::timestamp
          AND ${reportDateExpr('m')} <= $2::timestamp
          AND NULLIF(m.unit_price, 0) IS NULL
          ${Array.isArray(warehouseTypes) && warehouseTypes.length
        ? `AND EXISTS (SELECT 1 FROM warehouses w WHERE w.id = m.warehouse_id AND w.type = ANY($3::text[]))`
        : ''}
    `;
    const upd = await pool.query(updateSql, params);
    return { mode: 'apply', updated_rows: upd.rowCount || 0, negative_balance_pairs: negativePairs };
}

async function buildCounterpartyDrilldown(pool, params = {}) {
    const counterpartyId = Number(params.counterpartyId || 0);
    if (!counterpartyId) throw new Error('Некорректный контрагент');
    const dateFrom = String(params.dateFrom || '');
    const dateTo = String(params.dateTo || '');
    const metric = String(params.metric || '');
    const metricLc = metric.toLowerCase();
    const isBalanceMetric = metricLc.startsWith('opening_')
        || metricLc.startsWith('closing_')
        || metricLc.includes('balance');
    const isShipmentMetric = metricLc.includes('shipment');
    const fromTs = toIsoDateStart(dateFrom);
    const toTs = toIsoDateEnd(dateTo);
    if (!fromTs || !toTs) throw new Error('Некорректный период');

    let rangeMode = 'all_time';
    let whereDate = `1=1`;
    let values = [counterpartyId];

    if (metric.startsWith('opening_')) {
        rangeMode = 'opening';
        whereDate = `t.transaction_date < $2::timestamp`;
        values = [counterpartyId, fromTs];
    } else if (metric.startsWith('closing_')) {
        rangeMode = 'closing';
        whereDate = `t.transaction_date <= $2::timestamp`;
        values = [counterpartyId, toTs];
    }

    const mapTxType = {
        payment_in: 'income',
        payment_out: 'expense',
        debit_turnover: 'expense',
        credit_turnover: 'income'
    };
    let whereType = '';
    const txType = mapTxType[metricLc];
    if (!isBalanceMetric && txType) {
        whereType = ` AND t.transaction_type = '${txType}' `;
    }

    const sql = `
        SELECT
            t.id,
            t.transaction_date,
            t.transaction_type,
            t.amount,
            t.payment_method,
            t.source_module,
            t.linked_order_id,
            t.linked_purchase_id,
            COALESCE(a.name, 'Без счета') AS account_name,
            COALESCE(NULLIF(TRIM(t.category_override), ''), t.category, 'Без статьи') AS category_effective,
            COALESCE(t.description, '') AS note
        FROM transactions t
        LEFT JOIN accounts a ON a.id = t.account_id
        WHERE COALESCE(t.is_deleted, false) = false
          AND t.counterparty_id = $1::int
          AND ${whereDate}
          ${whereType}
        ORDER BY t.transaction_date DESC, t.id DESC
        LIMIT 300
    `;
    const includeTxRows = !isShipmentMetric || isBalanceMetric;
    const rowsRes = includeTxRows ? await pool.query(sql, values) : { rows: [] };

    const shipmentRows = [];
    const needShipmentRows = isShipmentMetric || isBalanceMetric;
    if (needShipmentRows) {
        let whereMvDate = '1=1';
        let mvValues = [counterpartyId];
        if (rangeMode === 'opening') {
            whereMvDate = `COALESCE(m.movement_date, m.created_at) < $2::timestamp`;
            mvValues = [counterpartyId, fromTs];
        } else if (rangeMode === 'closing') {
            whereMvDate = `COALESCE(m.movement_date, m.created_at) <= $2::timestamp`;
            mvValues = [counterpartyId, toTs];
        }
        let whereMvType = ` AND m.movement_type IN ('sales_shipment', 'shipment_reversal') `;
        if (metricLc === 'shipment_in') whereMvType = ` AND m.movement_type = 'shipment_reversal' `;
        if (metricLc === 'shipment_out') whereMvType = ` AND m.movement_type = 'sales_shipment' `;
        const mvSql = `
            SELECT
                m.id,
                COALESCE(m.movement_date, m.created_at) AS event_ts,
                m.movement_type,
                ABS(m.quantity) * COALESCE(coi.price, 0) AS amount,
                COALESCE(w.name, 'Склад') AS warehouse_name,
                COALESCE(m.description, '') AS note,
                co.id AS linked_order_id
            FROM inventory_movements m
            JOIN client_order_items coi ON coi.id = m.linked_order_item_id
            JOIN client_orders co ON co.id = coi.order_id
            LEFT JOIN warehouses w ON w.id = m.warehouse_id
            WHERE co.counterparty_id = $1::int
              AND ${whereMvDate}
              ${whereMvType}
            ORDER BY event_ts DESC, m.id DESC
            LIMIT 300
        `;
        const mvRes = await pool.query(mvSql, mvValues);
        mvRes.rows.forEach((r) => {
            const isIncome = String(r.movement_type || '') === 'shipment_reversal';
            shipmentRows.push({
                id: Number(r.id),
                sortTs: new Date(r.event_ts).getTime(),
                date: new Date(r.event_ts).toLocaleDateString('ru-RU'),
                typeCode: isIncome ? 'income' : 'expense',
                type: isIncome ? 'Доход' : 'Расход',
                amount: Number(r.amount || 0),
                paymentMethod: '',
                sourceModule: 'shipment',
                linkedOrderId: Number(r.linked_order_id || 0),
                linkedPurchaseId: 0,
                account: r.warehouse_name,
                category: 'Отгрузка',
                note: r.note || ''
            });
        });
    }

    const cp = await pool.query(`SELECT name FROM counterparties WHERE id = $1::int`, [counterpartyId]);
    const txRows = rowsRes.rows.map((r) => ({
        id: Number(r.id),
        sortTs: new Date(r.transaction_date).getTime(),
        date: new Date(r.transaction_date).toLocaleDateString('ru-RU'),
        typeCode: r.transaction_type === 'income' ? 'income' : 'expense',
        type: r.transaction_type === 'income' ? 'Доход' : 'Расход',
        amount: Number(r.amount || 0),
        paymentMethod: r.payment_method || '',
        sourceModule: r.source_module || '',
        linkedOrderId: Number(r.linked_order_id || 0),
        linkedPurchaseId: Number(r.linked_purchase_id || 0),
        account: normalizeDrilldownAccountName(r.account_name),
        category: r.category_effective,
        note: r.note || ''
    }));
    const mergedRows = txRows.concat(shipmentRows)
        .sort((a, b) => Number(b.sortTs || 0) - Number(a.sortTs || 0))
        .slice(0, 300)
        .map((r) => ({
            id: r.id,
            date: r.date,
            typeCode: r.typeCode,
            type: r.type,
            amount: r.amount,
            paymentMethod: r.paymentMethod,
            sourceModule: r.sourceModule,
            linkedOrderId: r.linkedOrderId,
            linkedPurchaseId: r.linkedPurchaseId,
            account: r.account,
            category: r.category,
            note: r.note
        }));
    return {
        counterpartyId,
        counterpartyName: cp.rows[0]?.name || `#${counterpartyId}`,
        rangeMode,
        rows: mergedRows
    };
}

async function buildAccountDrilldown(pool, params = {}) {
    const accountId = Number(params.accountId || 0);
    if (!accountId) throw new Error('Некорректный счет');
    const dateFrom = String(params.dateFrom || '');
    const dateTo = String(params.dateTo || '');
    const metric = String(params.metric || '');
    const metricLc = metric.toLowerCase();
    const isBalanceMetric = metricLc.startsWith('opening_')
        || metricLc.startsWith('closing_')
        || metricLc.includes('balance');
    const fromTs = toIsoDateStart(dateFrom);
    const toTs = toIsoDateEnd(dateTo);
    if (!fromTs || !toTs) throw new Error('Некорректный период');

    let rangeMode = 'all_time';
    let whereDate = `1=1`;
    let values = [accountId];
    if (metric.startsWith('opening_')) {
        rangeMode = 'opening';
        whereDate = `t.transaction_date < $2::timestamp`;
        values = [accountId, fromTs];
    } else if (metric.startsWith('closing_')) {
        rangeMode = 'closing';
        whereDate = `t.transaction_date <= $2::timestamp`;
        values = [accountId, toTs];
    }

    const mapTxType = {
        debit_turnover: 'income',
        credit_turnover: 'expense'
    };
    let whereType = '';
    const txType = mapTxType[metricLc];
    if (!isBalanceMetric && txType) {
        whereType = ` AND t.transaction_type = '${txType}' `;
    }

    const sql = `
        SELECT
            t.id,
            t.transaction_date,
            t.transaction_type,
            t.amount,
            t.payment_method,
            t.source_module,
            t.linked_order_id,
            t.linked_purchase_id,
            COALESCE(NULLIF(TRIM(t.category_override), ''), t.category, 'Без статьи') AS category_effective,
            COALESCE(t.description, '') AS note
        FROM transactions t
        WHERE COALESCE(t.is_deleted, false) = false
          AND t.account_id = $1::int
          AND ${whereDate}
          ${whereType}
        ORDER BY t.transaction_date DESC, t.id DESC
        LIMIT 300
    `;
    const rowsRes = await pool.query(sql, values);
    const acc = await pool.query(`SELECT name FROM accounts WHERE id = $1::int`, [accountId]);
    return {
        accountId,
        accountName: acc.rows[0]?.name || `#${accountId}`,
        rangeMode,
        rows: rowsRes.rows.map((r) => ({
            id: Number(r.id),
            date: new Date(r.transaction_date).toLocaleDateString('ru-RU'),
            typeCode: r.transaction_type === 'income' ? 'income' : 'expense',
            type: r.transaction_type === 'income' ? 'Доход' : 'Расход',
            amount: Number(r.amount || 0),
            paymentMethod: r.payment_method || '',
            sourceModule: r.source_module || '',
            linkedOrderId: Number(r.linked_order_id || 0),
            linkedPurchaseId: Number(r.linked_purchase_id || 0),
            account: normalizeDrilldownAccountName(acc.rows[0]?.name || ''),
            category: r.category_effective,
            note: r.note || ''
        }))
    };
}

function mapStockDrilldownPgRow(r) {
    const ts = r.event_ts ? new Date(r.event_ts).getTime() : 0;
    return {
        _sortTs: ts,
        date: r.event_ts ? new Date(r.event_ts).toLocaleDateString('ru-RU') : '',
        type: String(r.movement_type || ''),
        quantity: Number(r.quantity || 0),
        warehouse: r.warehouse_name || '',
        batchId: Number(r.batch_id || 0),
        batch: r.batch_number || '',
        linkedOrderItemId: Number(r.linked_order_item_id || 0),
        linkedOrderId: Number(r.linked_order_id || 0),
        linkedOrderDoc: r.linked_order_doc || '',
        source: r.movement_type || '',
        note: r.note || ''
    };
}

async function buildStockDrilldown(pool, params = {}) {
    const itemId = Number(params.itemId || 0);
    const warehouseId = Number(params.warehouseId || 0);
    const unifiedFgReservePool =
        Boolean(params.unifiedFgReservePool) ||
        String(params.unifiedFgReservePool || '').toLowerCase() === 'true' ||
        String(params.unifiedFgReservePool || '').toLowerCase() === '1';
    if (!itemId || !warehouseId) throw new Error('Некорректная номенклатура или склад');
    const dateFrom = String(params.dateFrom || '');
    const dateTo = String(params.dateTo || '');
    const metric = String(params.metric || '').toLowerCase();
    const commercialTurnover =
        Boolean(params.commercialTurnover) ||
        String(params.commercialTurnover || '').toLowerCase() === 'true' ||
        String(params.commercialTurnover || '').toLowerCase() === '1';
    const includeReserves =
        Boolean(params.includeReserves) ||
        String(params.includeReserves || '').toLowerCase() === 'true' ||
        String(params.includeReserves || '').toLowerCase() === '1';
    const fromTs = toIsoDateStart(dateFrom);
    const toTs = toIsoDateEnd(dateTo);
    if (!fromTs || !toTs) throw new Error('Некорректный период');

    let rangeMode = 'all_time';
    let whereDate = `1=1`;
    let whereQty = '';
    const values = [itemId];
    if (!unifiedFgReservePool) values.push(warehouseId);

    const whMovePredicate = unifiedFgReservePool
        ? `m.warehouse_id IN (SELECT id FROM warehouses WHERE type IN ('finished', 'reserve'))`
        : `m.warehouse_id = $2::int`;

    if (metric.startsWith('opening_')) {
        rangeMode = 'opening';
        values.push(fromTs);
        const ni = values.length;
        whereDate = `COALESCE(m.movement_date, m.created_at) < $${ni}::timestamp`;
    } else if (metric.startsWith('closing_')) {
        rangeMode = 'closing';
        values.push(toTs);
        const ni = values.length;
        whereDate = `COALESCE(m.movement_date, m.created_at) <= $${ni}::timestamp`;
    } else {
        rangeMode = 'period';
        values.push(fromTs, toTs);
        const ni = values.length;
        whereDate = `COALESCE(m.movement_date, m.created_at) >= $${ni - 1}::timestamp AND COALESCE(m.movement_date, m.created_at) <= $${ni}::timestamp`;
    }

    if (metric === 'inflow_qty' || metric === 'inflow_sum') whereQty = ` AND m.quantity > 0 `;
    if (metric === 'outflow_qty' || metric === 'outflow_sum') whereQty = ` AND m.quantity < 0 `;

    const commercialReserveFilter =
        commercialTurnover &&
        rangeMode === 'period' &&
        ['inflow_qty', 'inflow_sum', 'outflow_qty', 'outflow_sum'].includes(metric)
            ? PRODUCT_OSV_COMMERCIAL_PERIOD_RESERVE_EXCLUSION_SQL
            : '';

    const movSql = `
        SELECT
            m.id::bigint AS id,
            COALESCE(m.movement_date, m.created_at) AS event_ts,
            m.movement_type::text AS movement_type,
            m.quantity,
            COALESCE(m.description, '') AS note,
            m.batch_id,
            COALESCE(b.batch_number, '') AS batch_number,
            m.linked_order_item_id,
            o.id AS linked_order_id,
            COALESCE(o.doc_number, '') AS linked_order_doc,
            i.name AS item_name,
            w.name AS warehouse_name
        FROM inventory_movements m
        JOIN items i ON i.id = m.item_id
        JOIN warehouses w ON w.id = m.warehouse_id
        LEFT JOIN production_batches b ON b.id = m.batch_id
        LEFT JOIN client_order_items coi ON coi.id = m.linked_order_item_id
        LEFT JOIN client_orders o ON o.id = coi.order_id
        WHERE m.item_id = $1::int
          AND ${whMovePredicate}
          AND ${whereDate}
          ${whereQty}
          ${commercialReserveFilter}
    `;

    let combined = [];

    const res = await pool.query(movSql, values);

    combined.push(...res.rows.map((row) => ({ ...mapStockDrilldownPgRow(row), itemNamePg: row.item_name || '' })));

    const mergeReserveOrders =
        includeReserves &&
        rangeMode === 'period' &&
        (metric === 'outflow_qty' || metric === 'outflow_sum');
    if (mergeReserveOrders) {
        const whSourcePred = unifiedFgReservePool
            ? `(coi.stock_source_warehouse_id IS NULL OR coi.stock_source_warehouse_id IN (SELECT id FROM warehouses WHERE type IN ('finished', 'reserve')))`
            : `(coi.stock_source_warehouse_id IS NULL OR coi.stock_source_warehouse_id = $2::int)`;
        const ordRes = await pool.query(
            `
            SELECT
                (-coi.id)::bigint AS id,
                COALESCE(o.created_at, NOW()) AS event_ts,
                'client_order_reserve'::text AS movement_type,
                -GREATEST(COALESCE(coi.qty_ordered, 0) - COALESCE(coi.qty_shipped, 0), 0)::numeric AS quantity,
                TRIM(CONCAT_WS(' ',
                    COALESCE(NULLIF(TRIM(o.doc_number), ''), '#' || o.id::text),
                    '— неотгружено',
                    ('поз. ' || coi.id::text)
                )) AS note,
                NULL::int AS batch_id,
                ''::text AS batch_number,
                coi.id AS linked_order_item_id,
                o.id AS linked_order_id,
                COALESCE(o.doc_number, '') AS linked_order_doc,
                i.name AS item_name,
                wsel.name AS warehouse_name
            FROM client_order_items coi
            JOIN client_orders o ON o.id = coi.order_id
            JOIN items i ON i.id = coi.item_id
            JOIN warehouses wsel ON wsel.id = $2::int
            WHERE coi.item_id = $1::int
              AND o.status IN ('pending', 'processing')
              AND COALESCE(coi.qty_ordered, 0) > COALESCE(coi.qty_shipped, 0)
              AND ${whSourcePred}
        `,
            /** $2 только для имени склада в строке расшифровки (при пуле — выбранный в отчёте finished id). */
            [itemId, warehouseId]
        );

        combined.push(...ordRes.rows.map((row) => ({ ...mapStockDrilldownPgRow(row), itemNamePg: row.item_name || '' })));
    }

    combined.sort((a, b) => {
        if (Number(b._sortTs) !== Number(a._sortTs)) return Number(b._sortTs) - Number(a._sortTs);
        return Number(b.linkedOrderItemId || 0) - Number(a.linkedOrderItemId || 0);
    });
    combined = combined.slice(0, 400);

    const itemNameGuess =
        combined.find((x) => x.itemNamePg)?.itemNamePg ||
        (await pool.query(`SELECT name FROM items WHERE id = $1 LIMIT 1`, [itemId])).rows[0]?.name ||
        `#${itemId}`;
    const whNameGuess =
        combined[0]?.warehouse ||
        (await pool.query(`SELECT name FROM warehouses WHERE id = $1 LIMIT 1`, [warehouseId])).rows[0]?.name ||
        `#${warehouseId}`;

    return {
        itemId,
        warehouseId,
        unifiedFgReservePool,
        includeReservesMerged: mergeReserveOrders,
        itemName: itemNameGuess,
        warehouseName: whNameGuess,
        rangeMode,
        rows: combined.map(({ _sortTs, itemNamePg, ...rest }) => rest)
    };
}

async function buildOsvCounterparties(pool, period, filters, accountingMode = 'managerial') {
    const txParams = [period.fromTs, period.toTs];
    const mvParams = [period.fromTs, period.toTs];
    let txWhere = '';
    let mvWhere = '';
    if (filters.counterpartyId) {
        txParams.push(Number(filters.counterpartyId));
        txWhere += ` AND t.counterparty_id = $${txParams.length} `;
        mvParams.push(Number(filters.counterpartyId));
        mvWhere += ` AND co.counterparty_id = $${mvParams.length} `;
    }
    if (filters.excludeEmployees === true) {
        txWhere += ` AND COALESCE(c.is_employee, false) = false `;
        mvWhere += ` AND COALESCE(cp.is_employee, false) = false `;
    }
    if (accountingMode === 'regulatory') {
        if (filters.regOnlyPosted !== false) {
            txWhere += ` AND COALESCE(t.reg_is_posted, true) = true `;
            mvWhere += ` AND COALESCE(m.reg_is_posted, true) = true `;
        }
        if (filters.regOnlyPrimaryDoc === true) {
            txWhere += ` AND COALESCE(t.reg_is_primary_doc, false) = true `;
            mvWhere += ` AND COALESCE(m.reg_is_primary_doc, false) = true `;
        }
        if (filters.regRequireDocumentNo === true) {
            txWhere += ` AND COALESCE(NULLIF(TRIM(t.reg_document_no), ''), '') <> '' `;
            mvWhere += ` AND COALESCE(NULLIF(TRIM(m.reg_document_no), ''), '') <> '' `;
        }
        if (filters.regSourceTag) {
            txParams.push(String(filters.regSourceTag));
            txWhere += ` AND COALESCE(NULLIF(TRIM(t.reg_source_tag), ''), 'legacy') = $${txParams.length} `;
            mvParams.push(String(filters.regSourceTag));
            mvWhere += ` AND COALESCE(NULLIF(TRIM(m.reg_source_tag), ''), 'legacy') = $${mvParams.length} `;
        }
    }

    const txSql = `
        SELECT
            COALESCE(c.id, 0) AS counterparty_id,
            COALESCE(c.name, 'Без контрагента') AS counterparty_name,
            ROUND(COALESCE(SUM(CASE WHEN t.transaction_date < $1::timestamp AND t.transaction_type = 'income' THEN t.amount ELSE 0 END), 0)::numeric, 2) AS pay_before_in,
            ROUND(COALESCE(SUM(CASE WHEN t.transaction_date < $1::timestamp AND t.transaction_type = 'expense' THEN t.amount ELSE 0 END), 0)::numeric, 2) AS pay_before_out,
            ROUND(COALESCE(SUM(CASE WHEN t.transaction_date >= $1::timestamp AND t.transaction_date <= $2::timestamp AND t.transaction_type = 'income' THEN t.amount ELSE 0 END), 0)::numeric, 2) AS pay_in,
            ROUND(COALESCE(SUM(CASE WHEN t.transaction_date >= $1::timestamp AND t.transaction_date <= $2::timestamp AND t.transaction_type = 'expense' THEN t.amount ELSE 0 END), 0)::numeric, 2) AS pay_out
        FROM transactions t
        LEFT JOIN counterparties c ON c.id = t.counterparty_id
        WHERE COALESCE(t.is_deleted, false) = false
        ${txWhere}
        GROUP BY c.id, c.name
    `;

    const mvSql = `
        SELECT
            COALESCE(co.counterparty_id, 0) AS counterparty_id,
            COALESCE(cp.name, 'Без контрагента') AS counterparty_name,
            ROUND(COALESCE(SUM(CASE WHEN COALESCE(m.movement_date, m.created_at) < $1::timestamp AND m.movement_type = 'shipment_reversal' THEN ABS(m.quantity) * COALESCE(coi.price, 0) ELSE 0 END), 0)::numeric, 2) AS ship_before_in,
            ROUND(COALESCE(SUM(CASE WHEN COALESCE(m.movement_date, m.created_at) < $1::timestamp AND m.movement_type = 'sales_shipment' THEN ABS(m.quantity) * COALESCE(coi.price, 0) ELSE 0 END), 0)::numeric, 2) AS ship_before_out,
            ROUND(COALESCE(SUM(CASE WHEN COALESCE(m.movement_date, m.created_at) >= $1::timestamp AND COALESCE(m.movement_date, m.created_at) <= $2::timestamp AND m.movement_type = 'shipment_reversal' THEN ABS(m.quantity) * COALESCE(coi.price, 0) ELSE 0 END), 0)::numeric, 2) AS ship_in,
            ROUND(COALESCE(SUM(CASE WHEN COALESCE(m.movement_date, m.created_at) >= $1::timestamp AND COALESCE(m.movement_date, m.created_at) <= $2::timestamp AND m.movement_type = 'sales_shipment' THEN ABS(m.quantity) * COALESCE(coi.price, 0) ELSE 0 END), 0)::numeric, 2) AS ship_out
        FROM inventory_movements m
        JOIN client_order_items coi ON coi.id = m.linked_order_item_id
        JOIN client_orders co ON co.id = coi.order_id
        LEFT JOIN counterparties cp ON cp.id = co.counterparty_id
        WHERE m.movement_type IN ('sales_shipment', 'shipment_reversal')
        ${mvWhere}
        GROUP BY co.counterparty_id, cp.name
    `;

    const [txRes, mvRes] = await Promise.all([
        pool.query(txSql, txParams),
        pool.query(mvSql, mvParams)
    ]);

    const byCp = new Map();
    const ensure = (id, name) => {
        const key = Number(id || 0);
        if (!byCp.has(key)) {
            byCp.set(key, {
                counterparty_id: key,
                counterparty: name || 'Без контрагента',
                pay_before_in: 0,
                pay_before_out: 0,
                pay_in: 0,
                pay_out: 0,
                ship_before_in: 0,
                ship_before_out: 0,
                ship_in: 0,
                ship_out: 0
            });
        }
        return byCp.get(key);
    };
    txRes.rows.forEach((r) => {
        const row = ensure(r.counterparty_id, r.counterparty_name);
        row.pay_before_in = Number(r.pay_before_in || 0);
        row.pay_before_out = Number(r.pay_before_out || 0);
        row.pay_in = Number(r.pay_in || 0);
        row.pay_out = Number(r.pay_out || 0);
    });
    mvRes.rows.forEach((r) => {
        const row = ensure(r.counterparty_id, r.counterparty_name);
        row.ship_before_in = Number(r.ship_before_in || 0);
        row.ship_before_out = Number(r.ship_before_out || 0);
        row.ship_in = Number(r.ship_in || 0);
        row.ship_out = Number(r.ship_out || 0);
    });

    const rows = Array.from(byCp.values())
        .map((r) => {
            const opening = Number(((r.pay_before_in - r.pay_before_out) - (r.ship_before_out - r.ship_before_in)).toFixed(2));
            const closing = Number((opening + (r.pay_in - r.pay_out) - (r.ship_out - r.ship_in)).toFixed(2));
            // Дт/ДЗ = долг контрагента нам (алгебраическое сальдо < 0). Кт/КЗ = наш долг контрагенту / аванс (алгебраическое > 0). Совпадает с карточкой контрагента.
            return {
                counterparty_id: Number(r.counterparty_id || 0),
                counterparty: r.counterparty,
                opening_debit: opening < 0 ? Math.abs(opening) : 0,
                opening_credit: opening > 0 ? opening : 0,
                payment_in: Number(r.pay_in.toFixed(2)),
                payment_out: Number(r.pay_out.toFixed(2)),
                shipment_in: Number(r.ship_in.toFixed(2)),
                shipment_out: Number(r.ship_out.toFixed(2)),
                closing_debit: closing < 0 ? Math.abs(closing) : 0,
                closing_credit: closing > 0 ? closing : 0,
                closing_balance: closing
            };
        })
        .sort((a, b) => String(a.counterparty || '').localeCompare(String(b.counterparty || ''), 'ru'));
    const balanceModeRaw = String(filters.counterpartyBalanceMode || '').toLowerCase();
    const balanceMode = ['nonzero', 'movement', 'credit', 'debit', 'all'].includes(balanceModeRaw)
        ? balanceModeRaw
        : (filters.nonZeroClosing ? 'nonzero' : 'all');
    const filteredRows = rows.filter((r) => {
        const hasMovement = Math.abs(Number(r.payment_in || 0)) > 0.0001
            || Math.abs(Number(r.payment_out || 0)) > 0.0001
            || Math.abs(Number(r.shipment_in || 0)) > 0.0001
            || Math.abs(Number(r.shipment_out || 0)) > 0.0001;
        const closingBalance = Number(r.closing_balance || 0);
        if (balanceMode === 'nonzero') return Math.abs(closingBalance) > 0.0001;
        if (balanceMode === 'movement') return hasMovement;
        if (balanceMode === 'credit') return Number(r.closing_credit || 0) > 0.0001;
        if (balanceMode === 'debit') return Number(r.closing_debit || 0) > 0.0001;
        return true;
    });
    const totals = {
        opening_debit: Number(filteredRows.reduce((s, r) => s + r.opening_debit, 0).toFixed(2)),
        opening_credit: Number(filteredRows.reduce((s, r) => s + r.opening_credit, 0).toFixed(2)),
        payment_in: Number(filteredRows.reduce((s, r) => s + r.payment_in, 0).toFixed(2)),
        payment_out: Number(filteredRows.reduce((s, r) => s + r.payment_out, 0).toFixed(2)),
        shipment_in: Number(filteredRows.reduce((s, r) => s + r.shipment_in, 0).toFixed(2)),
        shipment_out: Number(filteredRows.reduce((s, r) => s + r.shipment_out, 0).toFixed(2)),
        closing_debit: Number(filteredRows.reduce((s, r) => s + r.closing_debit, 0).toFixed(2)),
        closing_credit: Number(filteredRows.reduce((s, r) => s + r.closing_credit, 0).toFixed(2)),
        closing_balance: Number(filteredRows.reduce((s, r) => s + r.closing_balance, 0).toFixed(2))
    };
    return {
        title: 'ОСВ по контрагентам',
        columns: [
            { key: 'counterparty', label: 'Контрагент' },
            { key: 'opening_debit', label: 'Сальдо нач. Дт' },
            { key: 'opening_credit', label: 'Сальдо нач. Кт' },
            { key: 'payment_in', label: 'Оплата: приход' },
            { key: 'payment_out', label: 'Оплата: расход' },
            { key: 'shipment_in', label: 'Отгрузка: приход' },
            { key: 'shipment_out', label: 'Отгрузка: расход' },
            { key: 'closing_debit', label: 'Сальдо кон. Дт' },
            { key: 'closing_credit', label: 'Сальдо кон. Кт' }
        ],
        rows: filteredRows,
        totals
    };
}

async function buildOsvCashAccounts(pool, period, filters, accountingMode = 'managerial') {
    const accountMovementModeRaw = String(filters.accountMovementMode || 'all');
    const accountMovementMode = ['all', 'movement'].includes(accountMovementModeRaw)
        ? accountMovementModeRaw
        : 'all';
    const params = [period.fromTs, period.toTs];
    let where = '';
    if (filters.accountId) {
        params.push(Number(filters.accountId));
        where = ` AND t.account_id = $${params.length} `;
    }
    if (accountingMode === 'regulatory') {
        if (filters.regOnlyPosted !== false) where += ` AND COALESCE(t.reg_is_posted, true) = true `;
        if (filters.regOnlyPrimaryDoc === true) where += ` AND COALESCE(t.reg_is_primary_doc, false) = true `;
        if (filters.regRequireDocumentNo === true) where += ` AND COALESCE(NULLIF(TRIM(t.reg_document_no), ''), '') <> '' `;
        if (filters.regExcludeOffset !== false) where += ` AND COALESCE(t.payment_method, '') <> 'Взаимозачет' `;
        if (filters.regExcludeTechnical !== false) where += ` AND COALESCE(NULLIF(TRIM(t.category_override), ''), t.category, '') NOT ILIKE 'Техничес%' `;
        if (filters.regSourceTag) {
            params.push(String(filters.regSourceTag));
            where += ` AND COALESCE(NULLIF(TRIM(t.reg_source_tag), ''), 'legacy') = $${params.length} `;
        }
    }

    const sql = `
        SELECT
            a.id AS account_id,
            a.name AS account_name,
            ROUND(COALESCE(SUM(
                CASE WHEN t.transaction_date < $1::timestamp
                    THEN CASE WHEN t.transaction_type = 'income' THEN t.amount ELSE -t.amount END
                    ELSE 0 END
            ), 0)::numeric, 2) AS opening_balance,
            ROUND(COALESCE(SUM(
                CASE WHEN t.transaction_date >= $1::timestamp
                       AND t.transaction_date <= $2::timestamp
                       AND t.transaction_type = 'income'
                    THEN t.amount ELSE 0 END
            ), 0)::numeric, 2) AS debit_turnover,
            ROUND(COALESCE(SUM(
                CASE WHEN t.transaction_date >= $1::timestamp
                       AND t.transaction_date <= $2::timestamp
                       AND t.transaction_type = 'expense'
                    THEN t.amount ELSE 0 END
            ), 0)::numeric, 2) AS credit_turnover
        FROM accounts a
        LEFT JOIN transactions t ON t.account_id = a.id AND COALESCE(t.is_deleted, false) = false
        WHERE 1=1 ${where}
        GROUP BY a.id, a.name
        ORDER BY a.name ASC
    `;
    const res = await pool.query(sql, params);
    const rows = res.rows.map((r) => {
        const opening = Number(r.opening_balance || 0);
        const debit = Number(r.debit_turnover || 0);
        const credit = Number(r.credit_turnover || 0);
        return {
            account_id: Number(r.account_id || 0),
            account: r.account_name,
            opening_balance: opening,
            debit_turnover: debit,
            credit_turnover: credit,
            closing_balance: Number((opening + debit - credit).toFixed(2))
        };
    }).sort((a, b) => {
        const wa = getCashAccountOrderWeight(a.account);
        const wb = getCashAccountOrderWeight(b.account);
        if (wa !== wb) return wa - wb;
        return String(a.account || '').localeCompare(String(b.account || ''), 'ru');
    });
    const filteredRows = accountMovementMode === 'movement'
        ? rows.filter((r) => Math.abs(Number(r.debit_turnover || 0)) > 0.000001 || Math.abs(Number(r.credit_turnover || 0)) > 0.000001)
        : rows;
    const totals = {
        opening_balance: Number(filteredRows.reduce((s, r) => s + r.opening_balance, 0).toFixed(2)),
        debit_turnover: Number(filteredRows.reduce((s, r) => s + r.debit_turnover, 0).toFixed(2)),
        credit_turnover: Number(filteredRows.reduce((s, r) => s + r.credit_turnover, 0).toFixed(2)),
        closing_balance: Number(filteredRows.reduce((s, r) => s + r.closing_balance, 0).toFixed(2))
    };
    return {
        title: 'ОСВ по кассам и счетам',
        columns: [
            { key: 'account', label: 'Счет/Касса' },
            { key: 'opening_balance', label: 'Сальдо начальное' },
            { key: 'debit_turnover', label: 'Оборот Дт (приход)' },
            { key: 'credit_turnover', label: 'Оборот Кт (расход)' },
            { key: 'closing_balance', label: 'Сальдо конечное' }
        ],
        rows: filteredRows,
        totals
    };
}

/** Презентационное закрытие строк ОСВ по продукции: конец по формуле, не суммирование всех типов проводок. */
/**
 * Пересчёт closing по формуле closing = opening + inflow - outflow.
 * Возвращает количество строк, в которых SQL-closing расходится с формульным (сигнал аномалии).
 */
function recomputeProductOsvCommercialRowClosing(rows, stockValuationMode) {
    let divergenceCount = 0;
    for (const r of rows) {
        const oq = Number(r.opening_qty || 0);
        const iq = Number(r.inflow_qty || 0);
        const outq = Number(r.outflow_qty || 0);
        const formulaClosingQty = Number((oq + iq - outq).toFixed(6));

        /* Guardrail: проверка сходимости SQL-closing vs формульного */
        const rawSqlClosingQty = Number(r.closing_qty || 0);
        if (Math.abs(rawSqlClosingQty - formulaClosingQty) > 0.01) {
            divergenceCount++;
        }
        r.closing_qty = formulaClosingQty;

        const osl = Number(r.opening_sum_legacy || 0);
        const isl = Number(r.inflow_sum_legacy || 0);
        const outl = Number(r.outflow_sum_legacy || 0);
        r.closing_sum_legacy = Number((osl + isl - outl).toFixed(2));

        const osa = Number(r.opening_sum_actual || 0);
        const isa = Number(r.inflow_sum_actual || 0);
        const outa = Number(r.outflow_sum_actual || 0);
        r.closing_sum_actual = Number((osa + isa - outa).toFixed(2));

        r.closing_sum =
            stockValuationMode === 'movement_actual'
                ? r.closing_sum_actual
                : Number(r.closing_sum_legacy || 0);
    }
    return divergenceCount;
}

async function fetchProductsUnshippedDemandByItem(pool, filters = {}) {
    const params = [];
    let extra = '';
    if (filters.itemId) {
        params.push(Number(filters.itemId));
        extra += ` AND coi.item_id = $${params.length}`;
    }
    const res = await pool.query(
        `SELECT coi.item_id,
                COALESCE(SUM(GREATEST(COALESCE(coi.qty_ordered, 0) - COALESCE(coi.qty_shipped, 0), 0)), 0)::numeric AS unshipped
         FROM client_order_items coi
         JOIN client_orders co ON co.id = coi.order_id
         WHERE co.status IN ('pending', 'processing')
         ${extra}
         GROUP BY coi.item_id`,
        params
    );
    const map = new Map();
    for (const row of res.rows) {
        map.set(Number(row.item_id), Number(row.unshipped || 0));
    }
    return map;
}

/**
 * Режим «Учитывать текущие резервы»: неотгруженное по строкам активных заказов (Σ max(ordered−shipped))
 * добавляется к расходу периода пропорционально конечным остаткам строк складов позиции; конец и суммы считаются
 * классически: closing = opening + inflow − outflow (в том числе отрицательный конец = долг производства при R > склад).
 */
function applyReservesToProductOsvOutflow(rowsAll, unshippedByItem, stockValuationMode) {
    const map = unshippedByItem instanceof Map ? unshippedByItem : new Map();
    const totalClosingByItem = new Map();
    for (const r of rowsAll) {
        const id = Number(r.item_id);
        totalClosingByItem.set(id, (totalClosingByItem.get(id) || 0) + Number(r.closing_qty || 0));
    }

    /** item_id -> строки складов этого товара */
    const rowsByItem = new Map();
    for (const r of rowsAll) {
        const itemId = Number(r.item_id);
        if (!rowsByItem.has(itemId)) rowsByItem.set(itemId, []);
        rowsByItem.get(itemId).push(r);
    }

    const reserveWarnings = [];
    const allocByRow = new WeakMap();

    const distributeR = (itemId, rowsItem, R) => {
        if (R <= 0.000001) return;
        const totClose = rowsItem.reduce((s, rr) => s + Number(rr.closing_qty || 0), 0);
        if (totClose > 0.000001) {
            for (const rr of rowsItem) {
                const share = Number(rr.closing_qty || 0);
                const alloc = R * (share / totClose);
                allocByRow.set(rr, (allocByRow.get(rr) || 0) + alloc);
            }
        } else {
            /** Нет книжного конца по строкам склада — всё ΣR «в расход» гладко между строками складов этого товара */
            const n = rowsItem.length || 1;
            const slice = R / n;
            for (const rr of rowsItem) {
                allocByRow.set(rr, (allocByRow.get(rr) || 0) + slice);
            }
        }
    };

    for (const [itemIdKey, rowsItem] of rowsByItem) {
        const R = Number(map.get(Number(itemIdKey)) || 0);
        const totAgg = totalClosingByItem.get(Number(itemIdKey)) || 0;
        if (R > totAgg + 0.0001) {
            reserveWarnings.push(
                `Неотгруженный заказано−отгруженное по активным заказам по товару id=${itemIdKey} (${Number(R).toFixed(4)}) превышает суммарный конечный остаток по строкам складов этого отчёта (${Number(totAgg).toFixed(4)}): в отчётном конце будет отрицательный остаток (учёт производственного долга).`
            );
        }
        distributeR(Number(itemIdKey), rowsItem, R);
    }

    for (const r of rowsAll) {
        const alloc = Number((allocByRow.get(r) || 0).toFixed(6));
        if (alloc <= 0.000001) {
            /** Закроем суммы через формульный конец (без доп.расхода) */
            r.closing_qty = Number((Number(r.opening_qty || 0) + Number(r.inflow_qty || 0) - Number(r.outflow_qty || 0)).toFixed(4));
            r.closing_sum_legacy = Number(
                (Number(r.opening_sum_legacy || 0) + Number(r.inflow_sum_legacy || 0) - Number(r.outflow_sum_legacy || 0)).toFixed(2)
            );
            r.closing_sum_actual = Number(
                (Number(r.opening_sum_actual || 0) + Number(r.inflow_sum_actual || 0) - Number(r.outflow_sum_actual || 0)).toFixed(2)
            );
            r.closing_sum =
                stockValuationMode === 'movement_actual' ? r.closing_sum_actual : Number(r.closing_sum_legacy || 0);
            continue;
        }

        const oqb = Number(r.outflow_qty || 0);
        let legRate = oqb > 1e-6 ? Number(r.outflow_sum_legacy || 0) / oqb : 0;
        let actRate = oqb > 1e-6 ? Number(r.outflow_sum_actual || 0) / oqb : 0;

        const iqb = Number(r.inflow_qty || 0);
        const opq = Number(r.opening_qty || 0);
        if (!(legRate > 0) || Number.isNaN(legRate)) {
            legRate =
                iqb > 1e-6 ? Number(r.inflow_sum_legacy || 0) / iqb :
                opq + iqb > 1e-6
                    ? (Number(r.opening_sum_legacy || 0) + Number(r.inflow_sum_legacy || 0)) / (opq + iqb)
                    : 0;
        }
        if (!(actRate > 0) || Number.isNaN(actRate)) {
            actRate =
                iqb > 1e-6 ? Number(r.inflow_sum_actual || 0) / iqb :
                opq + iqb > 1e-6
                    ? (Number(r.opening_sum_actual || 0) + Number(r.inflow_sum_actual || 0)) / (opq + iqb)
                    : Number(legRate);
        }

        r.outflow_qty = Number((oqb + alloc).toFixed(4));
        r.outflow_sum_legacy = Number((Number(r.outflow_sum_legacy || 0) + alloc * legRate).toFixed(2));
        r.outflow_sum_actual = Number((Number(r.outflow_sum_actual || 0) + alloc * actRate).toFixed(2));
        r.outflow_sum = stockValuationMode === 'movement_actual' ? r.outflow_sum_actual : Number(r.outflow_sum_legacy || 0);

        r.closing_qty = Number((opq + iqb - r.outflow_qty).toFixed(4));
        r.closing_sum_legacy = Number(
            (Number(r.opening_sum_legacy || 0) + Number(r.inflow_sum_legacy || 0) - Number(r.outflow_sum_legacy || 0)).toFixed(2)
        );
        r.closing_sum_actual = Number(
            (Number(r.opening_sum_actual || 0) + Number(r.inflow_sum_actual || 0) - Number(r.outflow_sum_actual || 0)).toFixed(2)
        );
        r.closing_sum =
            stockValuationMode === 'movement_actual' ? r.closing_sum_actual : Number(r.closing_sum_legacy || 0);
    }

    return reserveWarnings;
}

async function buildStockOsv(pool, period, warehouseTypes, title, filters = {}, accountingMode = 'managerial') {
    const stockBalanceModeRaw = String(filters.stockBalanceMode || 'nonzero');
    const stockBalanceMode = ['nonzero', 'movement', 'shipment_only', 'all'].includes(stockBalanceModeRaw)
        ? stockBalanceModeRaw
        : 'nonzero';
    const stockValuationModeRaw = String(filters.stockValuationMode || 'movement_actual');
    const stockValuationMode = ['movement_actual', 'legacy_current_price'].includes(stockValuationModeRaw)
        ? stockValuationModeRaw
        : 'movement_actual';
    const commercialProductPresentation = String(title || '') === 'ОСВ по продукции';
    /* Guardrail #3: Раздельный учет по складам — отключает слияние finished+reserve */
    const mergeWarehouses = filters.mergeWarehouses !== false;
    /** Слияние finished+reserve в одну строку; при фильтре «2 сорт» — только markdown без пула. */
    const useFgReserveBucket =
        commercialProductPresentation && mergeWarehouses && String(filters.warehouseType || '').toLowerCase() !== 'markdown';
    const whIdGroupingExpr = useFgReserveBucket
        ? `(CASE WHEN w.type IN ('finished', 'reserve')
                 THEN COALESCE((SELECT MIN(id) FROM warehouses WHERE type = 'finished'), w.id)
                 ELSE w.id END)`
        : 'w.id';
    const whNameGroupingExpr = useFgReserveBucket
        ? `(CASE WHEN w.type IN ('finished', 'reserve') THEN '${OSV_PRODUCT_FG_RESERVE_POOL_LABEL}' ELSE w.name END)`
        : 'w.name';
    const commercialPeriodTurnSql = commercialProductPresentation ? PRODUCT_OSV_COMMERCIAL_PERIOD_RESERVE_EXCLUSION_SQL : '';
    const params = [period.fromTs, period.toTs, warehouseTypes];
    let extra = '';
    if (commercialProductPresentation && filters.warehouseType === 'finished') {
        extra += ` AND w.type IN ('finished', 'reserve') `;
    } else if (filters.warehouseType && warehouseTypes.includes(String(filters.warehouseType))) {
        params.push(String(filters.warehouseType));
        extra += ` AND w.type = $${params.length} `;
    }
    if (filters.itemId) {
        params.push(Number(filters.itemId));
        extra += ` AND i.id = $${params.length} `;
    }
    if (accountingMode === 'regulatory') {
        if (filters.regOnlyPosted !== false) extra += ` AND COALESCE(m.reg_is_posted, true) = true `;
        if (filters.regOnlyPrimaryDoc === true) extra += ` AND COALESCE(m.reg_is_primary_doc, false) = true `;
        if (filters.regRequireDocumentNo === true) extra += ` AND COALESCE(NULLIF(TRIM(m.reg_document_no), ''), '') <> '' `;
        if (filters.regExcludeReserve !== false) {
            extra += ` AND m.movement_type NOT IN ('reserve_expense', 'reserve_receipt', 'reserve_release_expense', 'reserve_release_receipt', 'reserve_transfer_in', 'reserve_transfer_out') `;
        }
        if (filters.regExcludeAdjustments !== false) extra += ` AND m.movement_type NOT IN ('manual_adjustment', 'audit_adjustment', 'adjustment', 'revision') `;
        if (filters.regSourceTag) {
            params.push(String(filters.regSourceTag));
            extra += ` AND COALESCE(NULLIF(TRIM(m.reg_source_tag), ''), 'legacy') = $${params.length} `;
        }
    }
    if (stockBalanceMode === 'shipment_only') {
        let balanceTypesSet = new Set((warehouseTypes || []).map((x) => String(x)));
        if (!filters.warehouseType) {
            balanceTypesSet.add('reserve');
        } else if (commercialProductPresentation && filters.warehouseType === 'finished') {
            balanceTypesSet = new Set(['finished', 'reserve']);
        } else if (commercialProductPresentation && filters.warehouseType === 'markdown') {
            balanceTypesSet = new Set(['markdown']);
        }
        const balanceTypes = Array.from(balanceTypesSet).filter(Boolean);
        const shipParams = [period.fromTs, period.toTs, balanceTypes];
        let shipFilter = '';
        if (filters.itemId) {
            shipParams.push(Number(filters.itemId));
            shipFilter += ` AND m.item_id = $${shipParams.length} `;
        }
        if (commercialProductPresentation && filters.warehouseType === 'finished') {
            shipFilter += ` AND w.type IN ('finished', 'reserve') `;
        } else if (filters.warehouseType) {
            shipParams.push(String(filters.warehouseType));
            shipFilter += ` AND w.type = $${shipParams.length} `;
        }
        if (accountingMode === 'regulatory') {
            if (filters.regOnlyPosted !== false) shipFilter += ` AND COALESCE(m.reg_is_posted, true) = true `;
            if (filters.regOnlyPrimaryDoc === true) shipFilter += ` AND COALESCE(m.reg_is_primary_doc, false) = true `;
            if (filters.regRequireDocumentNo === true) shipFilter += ` AND COALESCE(NULLIF(TRIM(m.reg_document_no), ''), '') <> '' `;
            if (filters.regSourceTag) {
                shipParams.push(String(filters.regSourceTag));
                shipFilter += ` AND COALESCE(NULLIF(TRIM(m.reg_source_tag), ''), 'legacy') = $${shipParams.length} `;
            }
        }
        const shipSql = `
            WITH shipped_items AS (
                SELECT DISTINCT m.item_id
                FROM inventory_movements m
                JOIN warehouses w ON w.id = m.warehouse_id
                WHERE m.movement_type IN ('sales_shipment', 'shipment_reversal')
                ${shipFilter}
            ),
            turnover AS (
                SELECT
                    m.item_id,
                    ROUND(COALESCE(SUM(CASE WHEN COALESCE(m.movement_date, m.created_at) >= $1::timestamp AND COALESCE(m.movement_date, m.created_at) <= $2::timestamp AND m.quantity > 0${commercialPeriodTurnSql} THEN m.quantity ELSE 0 END),0)::numeric,4) AS inflow_qty,
                    ROUND(COALESCE(SUM(CASE WHEN COALESCE(m.movement_date, m.created_at) >= $1::timestamp AND COALESCE(m.movement_date, m.created_at) <= $2::timestamp AND m.quantity > 0${commercialPeriodTurnSql} THEN m.quantity * COALESCE(i.current_price, 0) ELSE 0 END),0)::numeric,2) AS inflow_sum_legacy,
                    ROUND(COALESCE(SUM(CASE WHEN COALESCE(m.movement_date, m.created_at) >= $1::timestamp AND COALESCE(m.movement_date, m.created_at) <= $2::timestamp AND m.quantity > 0${commercialPeriodTurnSql} THEN m.quantity * COALESCE(NULLIF(m.unit_price, 0), CASE WHEN m.movement_type IN ('sales_shipment', 'shipment_reversal') THEN coi.price ELSE NULL END, i.current_price, 0) ELSE 0 END),0)::numeric,2) AS inflow_sum_actual,
                    ROUND(COALESCE(SUM(CASE WHEN COALESCE(m.movement_date, m.created_at) >= $1::timestamp AND COALESCE(m.movement_date, m.created_at) <= $2::timestamp AND m.quantity < 0${commercialPeriodTurnSql} THEN ABS(m.quantity) ELSE 0 END),0)::numeric,4) AS outflow_qty,
                    ROUND(COALESCE(SUM(CASE WHEN COALESCE(m.movement_date, m.created_at) >= $1::timestamp AND COALESCE(m.movement_date, m.created_at) <= $2::timestamp AND m.quantity < 0${commercialPeriodTurnSql} THEN ABS(m.quantity) * COALESCE(i.current_price, 0) ELSE 0 END),0)::numeric,2) AS outflow_sum_legacy,
                    ROUND(COALESCE(SUM(CASE WHEN COALESCE(m.movement_date, m.created_at) >= $1::timestamp AND COALESCE(m.movement_date, m.created_at) <= $2::timestamp AND m.quantity < 0${commercialPeriodTurnSql} THEN ABS(m.quantity) * COALESCE(NULLIF(m.unit_price, 0), CASE WHEN m.movement_type IN ('sales_shipment', 'shipment_reversal') THEN coi.price ELSE NULL END, i.current_price, 0) ELSE 0 END),0)::numeric,2) AS outflow_sum_actual,
                    ROUND(COALESCE(SUM(CASE WHEN COALESCE(m.movement_date, m.created_at) >= $1::timestamp AND COALESCE(m.movement_date, m.created_at) <= $2::timestamp AND m.movement_type IN ('sales_shipment', 'shipment_reversal') THEN ABS(m.quantity) ELSE 0 END),0)::numeric,4) AS shipment_turnover_qty,
                    SUM(CASE WHEN COALESCE(m.movement_date, m.created_at) >= $1::timestamp
                              AND COALESCE(m.movement_date, m.created_at) <= $2::timestamp
                              AND NULLIF(m.unit_price, 0) IS NULL
                              AND NOT (m.movement_type IN ('sales_shipment', 'shipment_reversal') AND coi.price IS NOT NULL) THEN 1 ELSE 0 END)::int AS fallback_rows_count
                FROM inventory_movements m
                JOIN shipped_items si ON si.item_id = m.item_id
                JOIN items i ON i.id = m.item_id
                JOIN warehouses w ON w.id = m.warehouse_id
                LEFT JOIN client_order_items coi ON coi.id = m.linked_order_item_id
                WHERE w.type = ANY($3::text[])
                  AND COALESCE(m.movement_date, m.created_at) >= $1::timestamp
                  AND COALESCE(m.movement_date, m.created_at) <= $2::timestamp
                GROUP BY m.item_id
            ),
            stock AS (
                SELECT
                    m.item_id,
                    ROUND(COALESCE(SUM(CASE WHEN COALESCE(m.movement_date, m.created_at) < $1::timestamp THEN m.quantity ELSE 0 END),0)::numeric,4) AS opening_qty,
                    ROUND(COALESCE(SUM(CASE WHEN COALESCE(m.movement_date, m.created_at) < $1::timestamp THEN m.quantity * COALESCE(i.current_price, 0) ELSE 0 END),0)::numeric,2) AS opening_sum_legacy,
                    ROUND(COALESCE(SUM(CASE WHEN COALESCE(m.movement_date, m.created_at) < $1::timestamp THEN m.quantity * COALESCE(NULLIF(m.unit_price, 0), CASE WHEN m.movement_type IN ('sales_shipment', 'shipment_reversal') THEN coi.price ELSE NULL END, i.current_price, 0) ELSE 0 END),0)::numeric,2) AS opening_sum_actual,
                    ROUND(COALESCE(SUM(CASE WHEN COALESCE(m.movement_date, m.created_at) <= $2::timestamp THEN m.quantity ELSE 0 END),0)::numeric,4) AS closing_qty,
                    ROUND(COALESCE(SUM(CASE WHEN COALESCE(m.movement_date, m.created_at) <= $2::timestamp THEN m.quantity * COALESCE(i.current_price, 0) ELSE 0 END),0)::numeric,2) AS closing_sum_legacy,
                    ROUND(COALESCE(SUM(CASE WHEN COALESCE(m.movement_date, m.created_at) <= $2::timestamp THEN m.quantity * COALESCE(NULLIF(m.unit_price, 0), CASE WHEN m.movement_type IN ('sales_shipment', 'shipment_reversal') THEN coi.price ELSE NULL END, i.current_price, 0) ELSE 0 END),0)::numeric,2) AS closing_sum_actual
                FROM inventory_movements m
                JOIN shipped_items si ON si.item_id = m.item_id
                JOIN items i ON i.id = m.item_id
                JOIN warehouses w ON w.id = m.warehouse_id
                LEFT JOIN client_order_items coi ON coi.id = m.linked_order_item_id
                WHERE w.type = ANY($3::text[])
                GROUP BY m.item_id
            )
            SELECT
                i.id AS item_id,
                i.name AS item_name,
                i.unit AS unit,
                'Готовая продукция + Резерв'::text AS warehouse_name,
                COALESCE(st.opening_qty, 0) AS opening_qty,
                COALESCE(st.opening_sum_legacy, 0) AS opening_sum_legacy,
                COALESCE(st.opening_sum_actual, 0) AS opening_sum_actual,
                COALESCE(t.inflow_qty, 0) AS inflow_qty,
                COALESCE(t.inflow_sum_legacy, 0) AS inflow_sum_legacy,
                COALESCE(t.inflow_sum_actual, 0) AS inflow_sum_actual,
                COALESCE(t.outflow_qty, 0) AS outflow_qty,
                COALESCE(t.outflow_sum_legacy, 0) AS outflow_sum_legacy,
                COALESCE(t.outflow_sum_actual, 0) AS outflow_sum_actual,
                COALESCE(t.shipment_turnover_qty, 0) AS shipment_turnover_qty,
                COALESCE(st.closing_qty, 0) AS closing_qty,
                COALESCE(st.closing_sum_legacy, 0) AS closing_sum_legacy,
                COALESCE(st.closing_sum_actual, 0) AS closing_sum_actual,
                COALESCE(t.fallback_rows_count, 0)::int AS fallback_rows_count
            FROM shipped_items si
            JOIN items i ON i.id = si.item_id
            LEFT JOIN turnover t ON t.item_id = si.item_id
            LEFT JOIN stock st ON st.item_id = si.item_id
            ORDER BY i.name ASC
        `;
        const shipRes = await pool.query(shipSql, shipParams);
        const rows = shipRes.rows.map((r) => ({
            item_id: Number(r.item_id || 0),
            item: r.item_name,
            warehouse_id: 0,
            unifiedFgReservePool: true,
            warehouse: r.warehouse_name,
            unit: r.unit,
            opening_qty: Number(r.opening_qty || 0),
            opening_sum_legacy: Number(r.opening_sum_legacy || 0),
            opening_sum_actual: Number(r.opening_sum_actual || 0),
            opening_sum: Number(stockValuationMode === 'movement_actual' ? r.opening_sum_actual : r.opening_sum_legacy || 0),
            inflow_qty: Number(r.inflow_qty || 0),
            inflow_sum_legacy: Number(r.inflow_sum_legacy || 0),
            inflow_sum_actual: Number(r.inflow_sum_actual || 0),
            inflow_sum: Number(stockValuationMode === 'movement_actual' ? r.inflow_sum_actual : r.inflow_sum_legacy || 0),
            outflow_qty: Number(r.outflow_qty || 0),
            outflow_sum_legacy: Number(r.outflow_sum_legacy || 0),
            outflow_sum_actual: Number(r.outflow_sum_actual || 0),
            outflow_sum: Number(stockValuationMode === 'movement_actual' ? r.outflow_sum_actual : r.outflow_sum_legacy || 0),
            shipment_turnover_qty: Number(r.shipment_turnover_qty || 0),
            closing_qty: Number(r.closing_qty || 0),
            closing_sum_legacy: Number(r.closing_sum_legacy || 0),
            closing_sum_actual: Number(r.closing_sum_actual || 0),
            closing_sum: Number(stockValuationMode === 'movement_actual' ? r.closing_sum_actual : r.closing_sum_legacy || 0),
            valuation_fallback_rows: Number(r.fallback_rows_count || 0)
        })).filter((r) => Math.abs(Number(r.shipment_turnover_qty || 0)) > 0.000001);
        let shipDivergenceCount = 0;
        if (commercialProductPresentation) {
            shipDivergenceCount = recomputeProductOsvCommercialRowClosing(rows, stockValuationMode);
        }
        const totals = {
            opening_qty: Number(rows.reduce((s, r) => s + r.opening_qty, 0).toFixed(4)),
            opening_sum: Number(rows.reduce((s, r) => s + r.opening_sum, 0).toFixed(2)),
            inflow_qty: Number(rows.reduce((s, r) => s + r.inflow_qty, 0).toFixed(4)),
            inflow_sum: Number(rows.reduce((s, r) => s + r.inflow_sum, 0).toFixed(2)),
            outflow_qty: Number(rows.reduce((s, r) => s + r.outflow_qty, 0).toFixed(4)),
            outflow_sum: Number(rows.reduce((s, r) => s + r.outflow_sum, 0).toFixed(2)),
            closing_qty: Number(rows.reduce((s, r) => s + r.closing_qty, 0).toFixed(4)),
            closing_sum: Number(rows.reduce((s, r) => s + r.closing_sum, 0).toFixed(2)),
            valuation_fallback_rows: rows.reduce((s, r) => s + Number(r.valuation_fallback_rows || 0), 0)
        };
        const legacyTotals = {
            opening_sum: Number(rows.reduce((s, r) => s + Number(r.opening_sum_legacy || 0), 0).toFixed(2)),
            inflow_sum: Number(rows.reduce((s, r) => s + Number(r.inflow_sum_legacy || 0), 0).toFixed(2)),
            outflow_sum: Number(rows.reduce((s, r) => s + Number(r.outflow_sum_legacy || 0), 0).toFixed(2)),
            closing_sum: Number(rows.reduce((s, r) => s + Number(r.closing_sum_legacy || 0), 0).toFixed(2))
        };
        const actualTotals = {
            opening_sum: Number(rows.reduce((s, r) => s + Number(r.opening_sum_actual || 0), 0).toFixed(2)),
            inflow_sum: Number(rows.reduce((s, r) => s + Number(r.inflow_sum_actual || 0), 0).toFixed(2)),
            outflow_sum: Number(rows.reduce((s, r) => s + Number(r.outflow_sum_actual || 0), 0).toFixed(2)),
            closing_sum: Number(rows.reduce((s, r) => s + Number(r.closing_sum_actual || 0), 0).toFixed(2))
        };
        return {
            title,
            columns: [
                { key: 'item', label: 'Номенклатура' },
                { key: 'warehouse', label: 'Склад' },
                { key: 'unit', label: 'Ед. изм.' },
                { key: 'opening_qty', label: 'Остаток начальный (кг)' },
                { key: 'opening_sum', label: 'Остаток начальный (₽)' },
                { key: 'inflow_qty', label: 'Приход (кг)' },
                { key: 'inflow_sum', label: 'Приход (₽)' },
                { key: 'outflow_qty', label: 'Расход (кг)' },
                { key: 'outflow_sum', label: 'Расход (₽)' },
                { key: 'closing_qty', label: 'Остаток конечный (кг)' },
                { key: 'closing_sum', label: 'Остаток конечный (₽)' }
            ],
            rows,
            totals,
            valuationMode: stockValuationMode,
            valuationComparison: {
                legacy: legacyTotals,
                actual: actualTotals,
                delta: {
                    opening_sum: Number((actualTotals.opening_sum - legacyTotals.opening_sum).toFixed(2)),
                    inflow_sum: Number((actualTotals.inflow_sum - legacyTotals.inflow_sum).toFixed(2)),
                    outflow_sum: Number((actualTotals.outflow_sum - legacyTotals.outflow_sum).toFixed(2)),
                    closing_sum: Number((actualTotals.closing_sum - legacyTotals.closing_sum).toFixed(2))
                }
            },
            warnings: [
                ...(commercialProductPresentation
                    ? [
                        'Единая площадка (готовая + резерв): движения объединены в одну строку; внутренние типы между готовкой и резервом не входят в приход/расход периода (физический остаток и сумма по строке сходятся).'
                      ]
                    : []),
                ...(stockValuationMode === 'movement_actual' && totals.valuation_fallback_rows > 0
                    ? [`Часть движений оценена по fallback-цене карточки: ${totals.valuation_fallback_rows} строк(и).`]
                    : []),
                /* Guardrail #1: сходимость */
                ...(shipDivergenceCount > 0
                    ? [`⚠️ Внимание: математический остаток расходится с БД на ${shipDivergenceCount} строках. Возможны аномалии в датах движений.`]
                    : []),
                /* Guardrail #2: отрицательные остатки */
                ...(rows.some(r => Number(r.closing_qty || 0) < -0.0001)
                    ? ['⚠️ Обнаружены физически невозможные отрицательные остатки (без учёта резервов).']
                    : [])
            ],
            commercialStockPresentation: commercialProductPresentation
        };
    }
    const sql = `
        SELECT
            i.id AS item_id,
            i.name AS item_name,
            i.unit AS unit,
            ${whIdGroupingExpr} AS warehouse_id,
            ${whNameGroupingExpr} AS warehouse_name,
            ROUND(COALESCE(SUM(CASE WHEN COALESCE(m.movement_date, m.created_at) < $1::timestamp THEN m.quantity ELSE 0 END),0)::numeric,4) AS opening_qty,
            ROUND(COALESCE(SUM(CASE WHEN COALESCE(m.movement_date, m.created_at) < $1::timestamp THEN m.quantity * COALESCE(i.current_price, 0) ELSE 0 END),0)::numeric,2) AS opening_sum,
            ROUND(COALESCE(SUM(CASE WHEN COALESCE(m.movement_date, m.created_at) < $1::timestamp THEN m.quantity * COALESCE(
                NULLIF(m.unit_price, 0),
                CASE WHEN m.movement_type IN ('sales_shipment', 'shipment_reversal') THEN coi.price ELSE NULL END,
                i.current_price,
                0
            ) ELSE 0 END),0)::numeric,2) AS opening_sum_actual,
            ROUND(COALESCE(SUM(CASE WHEN COALESCE(m.movement_date, m.created_at) >= $1::timestamp AND COALESCE(m.movement_date, m.created_at) <= $2::timestamp AND m.quantity > 0${commercialPeriodTurnSql} THEN m.quantity ELSE 0 END),0)::numeric,4) AS inflow_qty,
            ROUND(COALESCE(SUM(CASE WHEN COALESCE(m.movement_date, m.created_at) >= $1::timestamp AND COALESCE(m.movement_date, m.created_at) <= $2::timestamp AND m.quantity > 0${commercialPeriodTurnSql} THEN m.quantity * COALESCE(i.current_price, 0) ELSE 0 END),0)::numeric,2) AS inflow_sum,
            ROUND(COALESCE(SUM(CASE WHEN COALESCE(m.movement_date, m.created_at) >= $1::timestamp AND COALESCE(m.movement_date, m.created_at) <= $2::timestamp AND m.quantity > 0${commercialPeriodTurnSql} THEN m.quantity * COALESCE(
                NULLIF(m.unit_price, 0),
                CASE WHEN m.movement_type IN ('sales_shipment', 'shipment_reversal') THEN coi.price ELSE NULL END,
                i.current_price,
                0
            ) ELSE 0 END),0)::numeric,2) AS inflow_sum_actual,
            ROUND(COALESCE(SUM(CASE WHEN COALESCE(m.movement_date, m.created_at) >= $1::timestamp AND COALESCE(m.movement_date, m.created_at) <= $2::timestamp AND m.quantity < 0${commercialPeriodTurnSql} THEN ABS(m.quantity) ELSE 0 END),0)::numeric,4) AS outflow_qty,
            ROUND(COALESCE(SUM(CASE WHEN COALESCE(m.movement_date, m.created_at) >= $1::timestamp AND COALESCE(m.movement_date, m.created_at) <= $2::timestamp AND m.quantity < 0${commercialPeriodTurnSql} THEN ABS(m.quantity) * COALESCE(i.current_price, 0) ELSE 0 END),0)::numeric,2) AS outflow_sum,
            ROUND(COALESCE(SUM(CASE WHEN COALESCE(m.movement_date, m.created_at) >= $1::timestamp AND COALESCE(m.movement_date, m.created_at) <= $2::timestamp AND m.quantity < 0${commercialPeriodTurnSql} THEN ABS(m.quantity) * COALESCE(
                NULLIF(m.unit_price, 0),
                CASE WHEN m.movement_type IN ('sales_shipment', 'shipment_reversal') THEN coi.price ELSE NULL END,
                i.current_price,
                0
            ) ELSE 0 END),0)::numeric,2) AS outflow_sum_actual,
            ROUND(COALESCE(SUM(CASE WHEN COALESCE(m.movement_date, m.created_at) >= $1::timestamp AND COALESCE(m.movement_date, m.created_at) <= $2::timestamp AND m.movement_type IN ('sales_shipment', 'shipment_reversal') THEN ABS(m.quantity) ELSE 0 END),0)::numeric,4) AS shipment_turnover_qty,
            ROUND(COALESCE(SUM(CASE WHEN COALESCE(m.movement_date, m.created_at) <= $2::timestamp THEN m.quantity ELSE 0 END),0)::numeric,4) AS closing_qty,
            ROUND(COALESCE(SUM(CASE WHEN COALESCE(m.movement_date, m.created_at) <= $2::timestamp THEN m.quantity * COALESCE(i.current_price, 0) ELSE 0 END),0)::numeric,2) AS closing_sum,
            ROUND(COALESCE(SUM(CASE WHEN COALESCE(m.movement_date, m.created_at) <= $2::timestamp THEN m.quantity * COALESCE(
                NULLIF(m.unit_price, 0),
                CASE WHEN m.movement_type IN ('sales_shipment', 'shipment_reversal') THEN coi.price ELSE NULL END,
                i.current_price,
                0
            ) ELSE 0 END),0)::numeric,2) AS closing_sum_actual,
            SUM(CASE WHEN NULLIF(m.unit_price, 0) IS NULL AND NOT (m.movement_type IN ('sales_shipment', 'shipment_reversal') AND coi.price IS NOT NULL) THEN 1 ELSE 0 END)::int AS fallback_rows_count
        FROM items i
        JOIN inventory_movements m ON m.item_id = i.id
        JOIN warehouses w ON w.id = m.warehouse_id
        LEFT JOIN client_order_items coi ON coi.id = m.linked_order_item_id
        WHERE w.type = ANY($3::text[])
        ${extra}
        GROUP BY i.id, i.name, i.unit, ${whIdGroupingExpr}, ${whNameGroupingExpr}
        ORDER BY i.name, ${whNameGroupingExpr}
    `;
    const res = await pool.query(sql, params);
    const rowsAll = res.rows.map((r) => ({
        item_id: Number(r.item_id || 0),
        item: r.item_name,
        warehouse_id: Number(r.warehouse_id || 0),
        warehouse: r.warehouse_name,
        unifiedFgReservePool: Boolean(
            useFgReserveBucket && commercialProductPresentation && String(r.warehouse_name || '') === OSV_PRODUCT_FG_RESERVE_POOL_LABEL
        ),
        unit: r.unit,
        opening_qty: Number(r.opening_qty || 0),
        opening_sum_legacy: Number(r.opening_sum || 0),
        opening_sum_actual: Number(r.opening_sum_actual || 0),
        opening_sum: Number(stockValuationMode === 'movement_actual' ? r.opening_sum_actual : r.opening_sum || 0),
        inflow_qty: Number(r.inflow_qty || 0),
        inflow_sum_legacy: Number(r.inflow_sum || 0),
        inflow_sum_actual: Number(r.inflow_sum_actual || 0),
        inflow_sum: Number(stockValuationMode === 'movement_actual' ? r.inflow_sum_actual : r.inflow_sum || 0),
        outflow_qty: Number(r.outflow_qty || 0),
        outflow_sum_legacy: Number(r.outflow_sum || 0),
        outflow_sum_actual: Number(r.outflow_sum_actual || 0),
        outflow_sum: Number(stockValuationMode === 'movement_actual' ? r.outflow_sum_actual : r.outflow_sum || 0),
        shipment_turnover_qty: Number(r.shipment_turnover_qty || 0),
        closing_qty: Number(r.closing_qty || 0),
        closing_sum_legacy: Number(r.closing_sum || 0),
        closing_sum_actual: Number(r.closing_sum_actual || 0),
        closing_sum: Number(stockValuationMode === 'movement_actual' ? r.closing_sum_actual : r.closing_sum || 0),
        valuation_fallback_rows: Number(r.fallback_rows_count || 0)
    }));
    let mainDivergenceCount = 0;
    if (commercialProductPresentation) {
        mainDivergenceCount = recomputeProductOsvCommercialRowClosing(rowsAll, stockValuationMode);
    }
    const applyProductReserve =
        Boolean(filters.includeReserves) &&
        (warehouseTypes || []).some((t) => ['finished', 'markdown'].includes(String(t)));
    let reserveDemandWarnings = [];
    if (applyProductReserve) {
        const demandMap = await fetchProductsUnshippedDemandByItem(pool, filters);
        reserveDemandWarnings = applyReservesToProductOsvOutflow(rowsAll, demandMap, stockValuationMode);
    }
    let shippedItemIds = null;
    if (stockBalanceMode === 'shipment_only') {
        const shipParams = [period.fromTs, period.toTs];
        let shipExtra = '';
        if (filters.itemId) {
            shipParams.push(Number(filters.itemId));
            shipExtra += ` AND m.item_id = $${shipParams.length} `;
        }
        if (accountingMode === 'regulatory') {
            if (filters.regOnlyPosted !== false) shipExtra += ` AND COALESCE(m.reg_is_posted, true) = true `;
            if (filters.regOnlyPrimaryDoc === true) shipExtra += ` AND COALESCE(m.reg_is_primary_doc, false) = true `;
            if (filters.regRequireDocumentNo === true) shipExtra += ` AND COALESCE(NULLIF(TRIM(m.reg_document_no), ''), '') <> '' `;
            if (filters.regSourceTag) {
                shipParams.push(String(filters.regSourceTag));
                shipExtra += ` AND COALESCE(NULLIF(TRIM(m.reg_source_tag), ''), 'legacy') = $${shipParams.length} `;
            }
        }
        const shipSql = `
            SELECT DISTINCT m.item_id
            FROM inventory_movements m
            WHERE COALESCE(m.movement_date, m.created_at) >= $1::timestamp
              AND COALESCE(m.movement_date, m.created_at) <= $2::timestamp
              AND m.movement_type IN ('sales_shipment', 'shipment_reversal')
              ${shipExtra}
        `;
        const shipRes = await pool.query(shipSql, shipParams);
        shippedItemIds = new Set((shipRes.rows || []).map((x) => Number(x.item_id || 0)).filter((x) => x > 0));
    }
    const rows = rowsAll.filter((r) => {
        if (stockBalanceMode === 'all') return true;
        if (stockBalanceMode === 'movement') {
            return Math.abs(Number(r.inflow_qty || 0)) > 0.000001 || Math.abs(Number(r.outflow_qty || 0)) > 0.000001;
        }
        if (stockBalanceMode === 'shipment_only') {
            return shippedItemIds ? shippedItemIds.has(Number(r.item_id || 0)) : Math.abs(Number(r.shipment_turnover_qty || 0)) > 0.000001;
        }
        return Math.abs(Number(r.closing_qty || 0)) > 0.000001;
    });
    const totals = {
        opening_qty: Number(rows.reduce((s, r) => s + r.opening_qty, 0).toFixed(4)),
        opening_sum: Number(rows.reduce((s, r) => s + r.opening_sum, 0).toFixed(2)),
        inflow_qty: Number(rows.reduce((s, r) => s + r.inflow_qty, 0).toFixed(4)),
        inflow_sum: Number(rows.reduce((s, r) => s + r.inflow_sum, 0).toFixed(2)),
        outflow_qty: Number(rows.reduce((s, r) => s + r.outflow_qty, 0).toFixed(4)),
        outflow_sum: Number(rows.reduce((s, r) => s + r.outflow_sum, 0).toFixed(2)),
        closing_qty: Number(rows.reduce((s, r) => s + r.closing_qty, 0).toFixed(4)),
        closing_sum: Number(rows.reduce((s, r) => s + r.closing_sum, 0).toFixed(2)),
        valuation_fallback_rows: rows.reduce((s, r) => s + Number(r.valuation_fallback_rows || 0), 0)
    };
    const legacyTotals = {
        opening_sum: Number(rows.reduce((s, r) => s + Number(r.opening_sum_legacy || 0), 0).toFixed(2)),
        inflow_sum: Number(rows.reduce((s, r) => s + Number(r.inflow_sum_legacy || 0), 0).toFixed(2)),
        outflow_sum: Number(rows.reduce((s, r) => s + Number(r.outflow_sum_legacy || 0), 0).toFixed(2)),
        closing_sum: Number(rows.reduce((s, r) => s + Number(r.closing_sum_legacy || 0), 0).toFixed(2))
    };
    const actualTotals = {
        opening_sum: Number(rows.reduce((s, r) => s + Number(r.opening_sum_actual || 0), 0).toFixed(2)),
        inflow_sum: Number(rows.reduce((s, r) => s + Number(r.inflow_sum_actual || 0), 0).toFixed(2)),
        outflow_sum: Number(rows.reduce((s, r) => s + Number(r.outflow_sum_actual || 0), 0).toFixed(2)),
        closing_sum: Number(rows.reduce((s, r) => s + Number(r.closing_sum_actual || 0), 0).toFixed(2))
    };
    const stockColsBase = [
        { key: 'item', label: 'Номенклатура' },
        { key: 'warehouse', label: 'Склад' },
        { key: 'unit', label: 'Ед. изм.' },
        { key: 'opening_qty', label: 'Остаток начальный (кг)' },
        { key: 'opening_sum', label: 'Остаток начальный (₽)' },
        { key: 'inflow_qty', label: 'Приход (кг)' },
        { key: 'inflow_sum', label: 'Приход (₽)' },
        { key: 'outflow_qty', label: 'Расход (кг)' },
        { key: 'outflow_sum', label: 'Расход (₽)' }
    ];
    const closingQtyLabel = 'Остаток конечный (кг)';
    const closingSumLabel = 'Остаток конечный (₽)';
    const columns = [
        ...stockColsBase,
        { key: 'closing_qty', label: closingQtyLabel },
        { key: 'closing_sum', label: closingSumLabel }
    ];
    const warnings = [];
    if (commercialProductPresentation && useFgReserveBucket) {
        warnings.push(
            'Единая площадка (готовая + резерв): движения объединены в одну строку; внутренние типы между готовкой и резервом не входят в приход/расход периода (физический остаток и сумма по строке сходятся).'
        );
    }
    if (commercialProductPresentation && !useFgReserveBucket && !mergeWarehouses) {
        warnings.push(
            'Раздельный учёт по складам: слияние finished+reserve отключено. Данные показаны в разрезе физических складов, включая внутренние перемещения в резерв.'
        );
    }
    if (stockValuationMode === 'movement_actual' && totals.valuation_fallback_rows > 0) {
        const totalMovements = rows.length || 1;
        const fallbackPct = Number(((totals.valuation_fallback_rows / Math.max(totalMovements, 1)) * 100).toFixed(1));
        warnings.push(`Часть движений оценена по fallback-цене карточки: ${totals.valuation_fallback_rows} строк(и) (${fallbackPct}%).`);
        /* Guardrail #4: рекомендация backfill при > 5% */
        if (fallbackPct > 5) {
            warnings.push(
                `⚠️ Более 5% движений оценены по fallback-цене (${fallbackPct}%). Рекомендуется запустить пересчёт исторических цен (backfill) для повышения точности отчёта.`
            );
        }
    }
    /* Guardrail #1: сходимость */
    if (mainDivergenceCount > 0) {
        warnings.push(`⚠️ Внимание: математический остаток расходится с БД на ${mainDivergenceCount} строках. Возможны аномалии в датах движений.`);
    }
    /* Guardrail #2: отрицательные остатки без учёта резервов */
    if (!applyProductReserve && rows.some(r => Number(r.closing_qty || 0) < -0.0001)) {
        warnings.push('⚠️ Обнаружены физически невозможные отрицательные остатки (без учёта резервов).');
    }
    if (applyProductReserve) {
        warnings.push(
            'Режим «Учитывать текущие резервы»: суммарное неотгруженное (заказано − отгружено по строкам активных заказов) добавляется к столбцу «Расход». Конец = Начало + Приход − Расход (при недостаче склада — отрицательный конец). Расшифровка расхода показывает движения и строки заказов.'
        );
        if (reserveDemandWarnings.length) warnings.push(...reserveDemandWarnings);
    }
    return {
        title,
        columns,
        rows,
        totals,
        commercialStockPresentation: commercialProductPresentation,
        includeProductReserves: applyProductReserve,
        valuationMode: stockValuationMode,
        valuationComparison: {
            legacy: legacyTotals,
            actual: actualTotals,
            delta: {
                opening_sum: Number((actualTotals.opening_sum - legacyTotals.opening_sum).toFixed(2)),
                inflow_sum: Number((actualTotals.inflow_sum - legacyTotals.inflow_sum).toFixed(2)),
                outflow_sum: Number((actualTotals.outflow_sum - legacyTotals.outflow_sum).toFixed(2)),
                closing_sum: Number((actualTotals.closing_sum - legacyTotals.closing_sum).toFixed(2))
            }
        },
        warnings
    };
}

async function buildTurnoverFinance(pool, period, filters = {}, accountingMode = 'managerial') {
    const params = [period.fromTs, period.toTs];
    let extra = '';
    if (filters.transactionType && ['income', 'expense'].includes(filters.transactionType)) {
        params.push(filters.transactionType);
        extra += ` AND t.transaction_type = $${params.length} `;
    }
    if (accountingMode === 'regulatory') {
        if (filters.regOnlyPosted !== false) extra += ` AND COALESCE(t.reg_is_posted, true) = true `;
        if (filters.regOnlyPrimaryDoc === true) extra += ` AND COALESCE(t.reg_is_primary_doc, false) = true `;
        if (filters.regRequireDocumentNo === true) extra += ` AND COALESCE(NULLIF(TRIM(t.reg_document_no), ''), '') <> '' `;
        if (filters.regExcludeOffset !== false) {
            extra += ` AND COALESCE(t.payment_method, '') <> 'Взаимозачет' `;
        }
        if (filters.regExcludeTechnical !== false) {
            extra += ` AND COALESCE(NULLIF(TRIM(t.category_override), ''), t.category, '') NOT ILIKE 'Техничес%' `;
        }
        if (filters.regSourceTag) {
            params.push(String(filters.regSourceTag));
            extra += ` AND COALESCE(NULLIF(TRIM(t.reg_source_tag), ''), 'legacy') = $${params.length} `;
        }
    }
    const sql = `
        SELECT
            t.transaction_type,
            COALESCE(NULLIF(TRIM(t.category_override), ''), t.category, 'Без статьи') AS category_effective,
            ROUND(SUM(t.amount)::numeric, 2) AS amount_sum,
            COUNT(*)::int AS rows_count
        FROM transactions t
        WHERE COALESCE(t.is_deleted, false) = false
          AND t.transaction_date >= $1::timestamp
          AND t.transaction_date <= $2::timestamp
          ${extra}
        GROUP BY t.transaction_type, COALESCE(NULLIF(TRIM(t.category_override), ''), t.category, 'Без статьи')
        ORDER BY t.transaction_type, amount_sum DESC
    `;
    const res = await pool.query(sql, params);
    const rows = res.rows.map((r) => ({
        transaction_type_code: String(r.transaction_type || ''),
        transaction_type: r.transaction_type === 'income' ? 'Доход' : 'Расход',
        category: r.category_effective,
        operations_count: Number(r.rows_count || 0),
        amount_sum: Number(r.amount_sum || 0)
    }));
    const totals = {
        amount_sum: Number(rows.reduce((s, r) => s + r.amount_sum, 0).toFixed(2)),
        operations_count: rows.reduce((s, r) => s + r.operations_count, 0)
    };
    return {
        title: 'Обороты по финансовым статьям',
        columns: [
            { key: 'transaction_type', label: 'Тип' },
            { key: 'category', label: 'Статья' },
            { key: 'operations_count', label: 'Кол-во операций' },
            { key: 'amount_sum', label: 'Сумма' }
        ],
        rows,
        totals
    };
}

async function buildTurnoverFinanceDrilldown(pool, params = {}) {
    const dateFrom = String(params.dateFrom || '');
    const dateTo = String(params.dateTo || '');
    const typeCode = String(params.typeCode || '');
    const category = String(params.category || '').trim();
    const accountingMode = String(params.accountingMode || 'managerial');
    const fromTs = toIsoDateStart(dateFrom);
    const toTs = toIsoDateEnd(dateTo);
    if (!fromTs || !toTs) throw new Error('Некорректный период');
    if (!['income', 'expense', ''].includes(typeCode)) throw new Error('Некорректный тип');

    const values = [fromTs, toTs];
    let extra = '';
    if (typeCode) {
        values.push(typeCode);
        extra += ` AND t.transaction_type = $${values.length} `;
    }
    if (category) {
        values.push(category);
        extra += ` AND COALESCE(NULLIF(TRIM(t.category_override), ''), t.category, 'Без статьи') = $${values.length} `;
    }
    if (accountingMode === 'regulatory') {
        if (params.regOnlyPosted !== false) extra += ` AND COALESCE(t.reg_is_posted, true) = true `;
        if (params.regOnlyPrimaryDoc === true) extra += ` AND COALESCE(t.reg_is_primary_doc, false) = true `;
        if (params.regRequireDocumentNo === true) extra += ` AND COALESCE(NULLIF(TRIM(t.reg_document_no), ''), '') <> '' `;
        if (params.regExcludeOffset !== false) extra += ` AND COALESCE(t.payment_method, '') <> 'Взаимозачет' `;
        if (params.regExcludeTechnical !== false) extra += ` AND COALESCE(NULLIF(TRIM(t.category_override), ''), t.category, '') NOT ILIKE 'Техничес%' `;
        if (params.regSourceTag) {
            values.push(String(params.regSourceTag));
            extra += ` AND COALESCE(NULLIF(TRIM(t.reg_source_tag), ''), 'legacy') = $${values.length} `;
        }
    }

    const sql = `
        SELECT
            t.id,
            t.transaction_date,
            t.transaction_type,
            t.amount,
            a.name AS account_name,
            COALESCE(NULLIF(TRIM(t.category_override), ''), t.category, 'Без статьи') AS category_effective,
            t.source_module,
            t.linked_order_id,
            t.linked_purchase_id,
            COALESCE(t.description, '') AS note
        FROM transactions t
        LEFT JOIN accounts a ON a.id = t.account_id
        WHERE COALESCE(t.is_deleted, false) = false
          AND t.transaction_date >= $1::timestamp
          AND t.transaction_date <= $2::timestamp
          ${extra}
        ORDER BY t.transaction_date DESC, t.id DESC
        LIMIT 500
    `;
    const res = await pool.query(sql, values);
    return {
        rangeMode: 'period',
        category,
        typeCode: typeCode || '',
        rows: res.rows.map((r) => ({
            id: Number(r.id || 0),
            date: new Date(r.transaction_date).toLocaleDateString('ru-RU'),
            typeCode: r.transaction_type === 'income' ? 'income' : 'expense',
            type: r.transaction_type === 'income' ? 'Доход' : 'Расход',
            amount: Number(r.amount || 0),
            account: normalizeDrilldownAccountName(r.account_name || ''),
            category: r.category_effective || '',
            sourceModule: r.source_module || '',
            linkedOrderId: Number(r.linked_order_id || 0),
            linkedPurchaseId: Number(r.linked_purchase_id || 0),
            note: r.note || ''
        }))
    };
}

async function buildInventoryRegister(pool, period, filters = {}, pagination = {}, accountingMode = 'managerial') {
    const page = Math.max(1, Number(pagination.page || 1));
    const pageSize = Math.min(1000, Math.max(50, Number(pagination.pageSize || 200)));
    const offset = (page - 1) * pageSize;
    const params = [period.fromTs, period.toTs];
    let extra = '';
    if (filters.warehouseType) {
        params.push(filters.warehouseType);
        extra += ` AND w.type = $${params.length} `;
    }
    if (filters.itemId) {
        params.push(Number(filters.itemId));
        extra += ` AND i.id = $${params.length} `;
    }
    if (filters.movementType) {
        params.push(filters.movementType);
        extra += ` AND m.movement_type = $${params.length} `;
    }
    if (accountingMode === 'regulatory') {
        if (filters.regOnlyPosted !== false) {
            extra += ` AND COALESCE(m.reg_is_posted, true) = true `;
        }
        if (filters.regOnlyPrimaryDoc === true) {
            extra += ` AND COALESCE(m.reg_is_primary_doc, false) = true `;
        }
        if (filters.regRequireDocumentNo === true) {
            extra += ` AND COALESCE(NULLIF(TRIM(m.reg_document_no), ''), '') <> '' `;
        }
        if (filters.regExcludeReserve !== false) {
            extra += ` AND m.movement_type NOT IN ('reserve_expense', 'reserve_receipt', 'reserve_release_expense', 'reserve_release_receipt', 'reserve_transfer_in', 'reserve_transfer_out') `;
        }
        if (filters.regExcludeAdjustments !== false) {
            extra += ` AND m.movement_type NOT IN ('manual_adjustment', 'audit_adjustment', 'adjustment', 'revision') `;
        }
        if (filters.regSourceTag) {
            params.push(String(filters.regSourceTag));
            extra += ` AND COALESCE(NULLIF(TRIM(m.reg_source_tag), ''), 'legacy') = $${params.length} `;
        }
    }
    const whereSql = `
        WHERE COALESCE(m.movement_date, m.created_at) >= $1::timestamp
          AND COALESCE(m.movement_date, m.created_at) <= $2::timestamp
          ${extra}
    `;
    const countSql = `
        SELECT COUNT(*)::int AS total
        FROM inventory_movements m
        JOIN warehouses w ON w.id = m.warehouse_id
        JOIN items i ON i.id = m.item_id
        ${whereSql}
    `;
    const countRes = await pool.query(countSql, params);
    const totalRows = Number(countRes.rows[0]?.total || 0);

    params.push(pageSize, offset);
    const sql = `
        SELECT
            m.id,
            COALESCE(m.movement_date, m.created_at) AS event_ts,
            m.warehouse_id,
            m.item_id,
            m.batch_id,
            m.linked_order_item_id,
            w.name AS warehouse_name,
            i.name AS item_name,
            i.unit AS unit,
            m.movement_type,
            m.quantity,
            b.batch_number,
            o.id AS linked_order_id,
            COALESCE(o.doc_number, '') AS linked_order_doc,
            m.description
        FROM inventory_movements m
        JOIN warehouses w ON w.id = m.warehouse_id
        JOIN items i ON i.id = m.item_id
        LEFT JOIN production_batches b ON b.id = m.batch_id
        LEFT JOIN client_order_items coi ON coi.id = m.linked_order_item_id
        LEFT JOIN client_orders o ON o.id = coi.order_id
        ${whereSql}
        ORDER BY event_ts ASC, m.id ASC
        LIMIT $${params.length - 1}
        OFFSET $${params.length}
    `;
    const res = await pool.query(sql, params);
    const rows = res.rows.map((r) => ({
        date: new Date(r.event_ts).toLocaleDateString('ru-RU'),
        warehouse_id: Number(r.warehouse_id || 0),
        item_id: Number(r.item_id || 0),
        batch_id: Number(r.batch_id || 0),
        linked_order_id: Number(r.linked_order_id || 0),
        linked_order_doc: r.linked_order_doc || '',
        purchase_id: String(r.movement_type || '') === 'purchase' ? Number(r.id || 0) : 0,
        warehouse: r.warehouse_name,
        item: r.item_name,
        unit: r.unit,
        movement_type: r.movement_type,
        quantity: Number(r.quantity || 0),
        batch: r.batch_number || '',
        description: r.description || ''
    }));
    const totals = {
        quantity_sum: Number(rows.reduce((s, r) => s + r.quantity, 0).toFixed(4)),
        rows_count: rows.length,
        rows_total: totalRows
    };
    return {
        title: 'Реестр движений запасов',
        columns: [
            { key: 'date', label: 'Дата' },
            { key: 'warehouse', label: 'Склад' },
            { key: 'item', label: 'Номенклатура' },
            { key: 'unit', label: 'Ед.' },
            { key: 'movement_type', label: 'Тип движения' },
            { key: 'quantity', label: 'Количество' },
            { key: 'batch', label: 'Партия' },
            { key: 'description', label: 'Описание' }
        ],
        rows,
        totals,
        pagination: {
            page,
            pageSize,
            totalRows,
            totalPages: Math.max(1, Math.ceil(totalRows / pageSize)),
            truncated: totalRows > pageSize
        }
    };
}

function salesAnalyticsGroupExpr(groupBy = 'month') {
    const mode = String(groupBy || 'month');
    if (mode === 'day') return `DATE_TRUNC('day', ${reportDateExpr('m')})`;
    if (mode === 'week') return `DATE_TRUNC('week', ${reportDateExpr('m')})`;
    return `DATE_TRUNC('month', ${reportDateExpr('m')})`;
}

function salesAnalyticsPriority(needToProduce, avgDaily, stock) {
    const need = Number(needToProduce || 0);
    if (need <= 0) return 'Низкий';
    const daily = Number(avgDaily || 0);
    const st = Number(stock || 0);
    if (daily <= 0) return need >= 1 ? 'Средний' : 'Низкий';
    const coverDays = st / daily;
    if (coverDays < 7 || need > daily * 2) return 'Высокий';
    if (coverDays < 14 || need > daily) return 'Средний';
    return 'Низкий';
}

function salesAnalyticsPriorityWeight(priority = '') {
    const p = String(priority || '').toLowerCase();
    if (p === 'высокий') return 0;
    if (p === 'средний') return 1;
    return 2;
}

function salesAnalyticsCostSourceLabel(source = '') {
    const s = String(source || '').toLowerCase();
    if (s === 'real_batch') return 'Реальная (по партиям)';
    if (s === 'recipe') return 'Плановая (по рецепту)';
    if (s === 'real_batch_base') return 'Реальная (от 1 сорта)';
    if (s === 'recipe_base') return 'Плановая (от 1 сорта)';
    return 'Нет данных';
}


async function buildSalesAnalytics(pool, period, filters = {}, accountingMode = 'managerial') {
    const groupByRaw = String(filters.groupBy || 'month').toLowerCase();
    const groupBy = ['day', 'week', 'month'].includes(groupByRaw) ? groupByRaw : 'month';
    const topNRaw = Number(filters.topN || 20);
    const topN = Math.min(100, Math.max(5, Number.isFinite(topNRaw) ? topNRaw : 20));
    const horizonRaw = Number(filters.forecastHorizon || 30);
    const forecastHorizon = [14, 30, 60, 90].includes(horizonRaw) ? horizonRaw : 30;
    const includeReturns = filters.includeReturns !== false;
    const includeOverhead = filters.includeOverhead !== false;
    const includeTaxes = filters.includeTaxes === true;
    const financeDefaultsRes = await pool.query(`
        SELECT key, value
        FROM settings
        WHERE key IN ('sales_tax', 'overhead_per_cycle')
    `);
    const financeDefaultsRaw = {};
    for (const row of financeDefaultsRes.rows || []) {
        financeDefaultsRaw[String(row.key || '')] = Number(row.value || 0);
    }
    const salesTaxDefault = Number.isFinite(financeDefaultsRaw.sales_tax) ? financeDefaultsRaw.sales_tax : 6;
    const overheadPerCycleDefault = Number.isFinite(financeDefaultsRaw.overhead_per_cycle) ? financeDefaultsRaw.overhead_per_cycle : 0;
    const taxRateRaw = Number(filters.taxRate);
    const taxRate = Number.isFinite(taxRateRaw) ? Math.min(100, Math.max(0, taxRateRaw)) : Math.min(100, Math.max(0, salesTaxDefault));
    const activeTab = ['summary', 'products', 'profitability', 'forecast'].includes(String(filters.analyticsTab || ''))
        ? String(filters.analyticsTab)
        : 'summary';

    const overheadRateRaw = Number(filters.overheadRate);
    const overheadRate = Number.isFinite(overheadRateRaw) ? Math.max(0, overheadRateRaw) : overheadPerCycleDefault;
    const recipeOverheadPerCycle = includeOverhead ? overheadRate : 0;

    const params = [period.fromTs, period.toTs];
    let extra = '';
    if (filters.itemId) {
        params.push(Number(filters.itemId));
        extra += ` AND i.id = $${params.length} `;
    }
    if (filters.warehouseType) {
        params.push(String(filters.warehouseType));
        extra += ` AND w.type = $${params.length} `;
    }
    if (accountingMode === 'regulatory') {
        if (filters.regOnlyPosted !== false) extra += ` AND COALESCE(m.reg_is_posted, true) = true `;
        if (filters.regOnlyPrimaryDoc === true) extra += ` AND COALESCE(m.reg_is_primary_doc, false) = true `;
        if (filters.regRequireDocumentNo === true) extra += ` AND COALESCE(NULLIF(TRIM(m.reg_document_no), ''), '') <> '' `;
        if (filters.regSourceTag) {
            params.push(String(filters.regSourceTag));
            extra += ` AND COALESCE(NULLIF(TRIM(m.reg_source_tag), ''), 'legacy') = $${params.length} `;
        }
    }

    const whereSql = `
        WHERE ${reportDateExpr('m')} >= $1::timestamp
          AND ${reportDateExpr('m')} <= $2::timestamp
          AND m.movement_type IN ('sales_shipment', 'shipment_reversal')
          ${extra}
    `;
    const productSql = `
        SELECT
            i.id AS item_id,
            i.name AS item_name,
            COALESCE(NULLIF(TRIM(i.unit), ''), 'ед.') AS unit,
            ROUND(COALESCE(SUM(CASE WHEN m.movement_type = 'sales_shipment' THEN ABS(m.quantity) ELSE 0 END), 0)::numeric, 4) AS shipped_qty,
            ROUND(COALESCE(SUM(CASE WHEN m.movement_type = 'shipment_reversal' THEN ABS(m.quantity) ELSE 0 END), 0)::numeric, 4) AS reversed_qty,
            ROUND(COALESCE(SUM(CASE WHEN m.movement_type = 'sales_shipment' THEN ABS(m.quantity) * COALESCE(coi.price, 0) ELSE 0 END), 0)::numeric, 2) AS shipped_revenue,
            ROUND(COALESCE(SUM(CASE WHEN m.movement_type = 'shipment_reversal' THEN ABS(m.quantity) * COALESCE(coi.price, 0) ELSE 0 END), 0)::numeric, 2) AS reversed_revenue,
            -- COGS из исторических слепков (средневзвешенная себестоимость)
            CASE WHEN SUM(CASE WHEN m.movement_type = 'sales_shipment' THEN ABS(m.quantity) ELSE 0 END) > 0
                 THEN ROUND(
                     SUM(CASE WHEN m.movement_type = 'sales_shipment'
                              THEN ABS(m.quantity) * COALESCE(coi.unit_cost_snapshot, 0) ELSE 0 END)
                     / NULLIF(SUM(CASE WHEN m.movement_type = 'sales_shipment' THEN ABS(m.quantity) ELSE 0 END), 0)
                 , 4) ELSE 0 END AS unit_cost_snapshot_avg,
            -- Проверяем, есть ли позиции без слепка
            BOOL_OR(coi.unit_cost_snapshot IS NULL AND m.movement_type = 'sales_shipment') AS has_missing_snapshot,
            -- Источник себестоимости (самый частый)
            MODE() WITHIN GROUP (ORDER BY COALESCE(coi.cost_source, 'none')) FILTER (WHERE m.movement_type = 'sales_shipment') AS snapshot_cost_source
        FROM inventory_movements m
        JOIN items i ON i.id = m.item_id
        JOIN warehouses w ON w.id = m.warehouse_id
        LEFT JOIN client_order_items coi ON coi.id = m.linked_order_item_id
        ${whereSql}
        GROUP BY i.id, i.name, i.unit
    `;
    const productRes = await pool.query(productSql, params);
    const productRows = productRes.rows.map((r) => {
        const shippedQty = Number(r.shipped_qty || 0);
        const reversedQty = Number(r.reversed_qty || 0);
        const shippedRevenue = Number(r.shipped_revenue || 0);
        const reversedRevenue = Number(r.reversed_revenue || 0);
        const soldQty = includeReturns ? (shippedQty - reversedQty) : shippedQty;
        const revenueGross = includeReturns ? (shippedRevenue - reversedRevenue) : shippedRevenue;
        return {
            item_id: Number(r.item_id || 0),
            item: r.item_name || '',
            unit: r.unit || 'ед.',
            shipped_qty: shippedQty,
            reversed_qty: reversedQty,
            sold_qty: Number(soldQty.toFixed(4)),
            shipped_revenue: shippedRevenue,
            reversed_revenue: reversedRevenue,
            revenue_gross: Number(revenueGross.toFixed(2)),
            unit_cost_snapshot_avg: Number(r.unit_cost_snapshot_avg || 0),
            has_missing_snapshot: Boolean(r.has_missing_snapshot),
            snapshot_cost_source: String(r.snapshot_cost_source || 'none')
        };
    });

    // Fallback: для позиций без слепка — динамический пересчёт (только для них)
    const itemsWithoutSnapshot = productRows.filter((r) => r.has_missing_snapshot).map((r) => r.item_id);
    let fallbackCostMap = new Map();
    if (itemsWithoutSnapshot.length > 0) {
        fallbackCostMap = await buildSalesAnalyticsUnitCostMap(pool, itemsWithoutSnapshot, {
            includeOverhead,
            overheadPerCycle: overheadRate
        });
    }

    const stockParams = [period.toTs];
    let stockExtra = '';
    if (filters.itemId) {
        stockParams.push(Number(filters.itemId));
        stockExtra += ` AND i.id = $${stockParams.length} `;
    }
    const stockSql = `
        SELECT
            i.id AS item_id,
            ROUND(COALESCE(SUM(m.quantity), 0)::numeric, 4) AS stock_qty
        FROM inventory_movements m
        JOIN items i ON i.id = m.item_id
        JOIN warehouses w ON w.id = m.warehouse_id
        WHERE ${reportDateExpr('m')} <= $1::timestamp
          AND w.type IN ('finished', 'markdown')
          ${stockExtra}
        GROUP BY i.id
    `;
    const stockRes = await pool.query(stockSql, stockParams);
    const stockMap = new Map(stockRes.rows.map((r) => [Number(r.item_id || 0), Number(r.stock_qty || 0)]));

    const backlogSql = `
        SELECT
            coi.item_id,
            ROUND(COALESCE(SUM(GREATEST(COALESCE(coi.qty_ordered, 0) - COALESCE(coi.qty_shipped, 0), 0)), 0)::numeric, 4) AS backlog_qty
        FROM client_order_items coi
        JOIN client_orders co ON co.id = coi.order_id
        WHERE COALESCE(co.status, '') IN ('pending', 'processing')
        GROUP BY coi.item_id
    `;
    const backlogRes = await pool.query(backlogSql);
    const backlogMap = new Map(backlogRes.rows.map((r) => [Number(r.item_id || 0), Number(r.backlog_qty || 0)]));

    const historyDays = 90;
    const demandParams = [period.toTs, historyDays];
    let demandExtra = '';
    if (filters.itemId) {
        demandParams.push(Number(filters.itemId));
        demandExtra += ` AND i.id = $${demandParams.length} `;
    }
    if (filters.warehouseType) {
        demandParams.push(String(filters.warehouseType));
        demandExtra += ` AND w.type = $${demandParams.length} `;
    }
    const demandCaseSql = includeReturns
        ? `CASE
                WHEN m.movement_type = 'sales_shipment' THEN ABS(m.quantity)
                WHEN m.movement_type = 'shipment_reversal' THEN -ABS(m.quantity)
                ELSE 0
            END`
        : `CASE
                WHEN m.movement_type = 'sales_shipment' THEN ABS(m.quantity)
                ELSE 0
            END`;
    const demandSql = `
        SELECT
            i.id AS item_id,
            ROUND(COALESCE(SUM(${demandCaseSql}), 0)::numeric, 4) AS demand_qty
        FROM inventory_movements m
        JOIN items i ON i.id = m.item_id
        JOIN warehouses w ON w.id = m.warehouse_id
        WHERE ${reportDateExpr('m')} > ($1::timestamp - ($2::int * INTERVAL '1 day'))
          AND ${reportDateExpr('m')} <= $1::timestamp
          AND m.movement_type IN ('sales_shipment', 'shipment_reversal')
          ${demandExtra}
        GROUP BY i.id
    `;
    const demandRes = await pool.query(demandSql, demandParams);
    const demandMap = new Map(demandRes.rows.map((r) => [Number(r.item_id || 0), Number(r.demand_qty || 0)]));

    const totals = {
        sold_qty: Number(productRows.reduce((s, r) => s + Number(r.sold_qty || 0), 0).toFixed(4)),
        revenue_gross: Number(productRows.reduce((s, r) => s + Number(r.revenue_gross || 0), 0).toFixed(2)),
        shipped_qty: Number(productRows.reduce((s, r) => s + Number(r.shipped_qty || 0), 0).toFixed(4)),
        returns_qty: Number(productRows.reduce((s, r) => s + Number(r.reversed_qty || 0), 0).toFixed(4)),
        returns_revenue: Number(productRows.reduce((s, r) => s + Number(r.reversed_revenue || 0), 0).toFixed(2))
    };

    const productBase = productRows
        .map((r) => {
            // Приоритет: слепок из БД → fallback динамический пересчёт
            let unitCost = Number(r.unit_cost_snapshot_avg || 0);
            let costSource = String(r.snapshot_cost_source || 'none');
            if (r.has_missing_snapshot && unitCost === 0) {
                const fb = fallbackCostMap.get(Number(r.item_id || 0)) || { unit_cost: 0, source: 'none' };
                unitCost = Number(fb.unit_cost || 0);
                costSource = String(fb.source || 'none');
            }
            const cogsBase = Number((Number(r.sold_qty || 0) * unitCost).toFixed(2));
            const taxAmount = includeTaxes ? Number((Number(r.revenue_gross || 0) * (taxRate / 100)).toFixed(2)) : 0;
            const revenueNet = Number((Number(r.revenue_gross || 0) - taxAmount).toFixed(2));
            const cogsTotal = Number((cogsBase + taxAmount).toFixed(2));
            const profit = Number((Number(r.revenue_gross || 0) - cogsTotal).toFixed(2));
            const margin = Number(r.revenue_gross || 0) > 0 ? Number(((profit / Number(r.revenue_gross || 0)) * 100).toFixed(2)) : 0;
            const stockQty = Number(stockMap.get(r.item_id) || 0);
            const backlogQty = Number(backlogMap.get(r.item_id) || 0);
            const historyQty = Number(demandMap.get(r.item_id) || 0);
            const avgDaily = Number((historyQty / historyDays).toFixed(4));
            const forecastQty = Number((avgDaily * forecastHorizon).toFixed(4));
            const needToProduce = Number(Math.max(forecastQty + backlogQty - stockQty, 0).toFixed(4));
            const priority = salesAnalyticsPriority(needToProduce, avgDaily, stockQty);
            return {
                ...r,
                unit_cost_std: unitCost,
                unit_cost_real: costSource.startsWith('real_batch') ? unitCost : 0,
                unit_cost_recipe: costSource.startsWith('recipe') ? unitCost : 0,
                cost_source: costSource,
                cogs_std_base: cogsBase,
                cogs_std: cogsTotal,
                tax_amount: taxAmount,
                revenue_net: revenueNet,
                gross_profit: profit,
                gross_margin: margin,
                stock_qty: stockQty,
                backlog_qty: backlogQty,
                avg_daily_demand: avgDaily,
                forecast_qty: forecastQty,
                need_to_produce: needToProduce,
                priority
            };
        })
        .filter((r) => Math.abs(Number(r.sold_qty || 0)) > 0.000001 || Math.abs(Number(r.revenue_gross || 0)) > 0.000001 || Math.abs(Number(r.need_to_produce || 0)) > 0.000001);

    const totalRevenue = Number(totals.revenue_gross || 0);
    const totalQty = Number(totals.sold_qty || 0);
    const productsTabRows = productBase
        .slice()
        .sort((a, b) => Number(b.revenue_gross || 0) - Number(a.revenue_gross || 0))
        .slice(0, topN)
        .map((r, idx) => ({
            rank: idx + 1,
            item_id: r.item_id,
            item: r.item,
            unit: r.unit,
            sold_qty: r.sold_qty,
            revenue_gross: r.revenue_gross,
            revenue_share: totalRevenue > 0 ? Number(((Number(r.revenue_gross || 0) / totalRevenue) * 100).toFixed(2)) : 0,
            qty_share: totalQty > 0 ? Number(((Number(r.sold_qty || 0) / totalQty) * 100).toFixed(2)) : 0,
            abc_class: (() => {
                const share = totalRevenue > 0 ? (Number(r.revenue_gross || 0) / totalRevenue) * 100 : 0;
                if (share >= 10) return 'A';
                if (share >= 4) return 'B';
                return 'C';
            })()
        }));

    const profitabilityRows = productBase
        .slice()
        .sort((a, b) => Number(b.gross_profit || 0) - Number(a.gross_profit || 0))
        .slice(0, topN)
        .map((r, idx) => ({
            rank: idx + 1,
            item_id: r.item_id,
            item: r.item,
            unit: r.unit,
            sold_qty: r.sold_qty,
            revenue_gross: r.revenue_gross,
            tax_amount: r.tax_amount,
            revenue_net: r.revenue_net,
            unit_cost_std: r.unit_cost_std,
            cost_source_label: salesAnalyticsCostSourceLabel(r.cost_source),
            cogs_std: r.cogs_std,
            gross_profit: r.gross_profit,
            gross_margin: r.gross_margin
        }));

    const forecastRows = productBase
        .slice()
        .sort((a, b) => {
            const pw = salesAnalyticsPriorityWeight(a.priority) - salesAnalyticsPriorityWeight(b.priority);
            if (pw !== 0) return pw;
            return Number(b.need_to_produce || 0) - Number(a.need_to_produce || 0);
        })
        .slice(0, topN)
        .map((r, idx) => ({
            rank: idx + 1,
            item_id: r.item_id,
            item: r.item,
            unit: r.unit,
            avg_daily_demand: r.avg_daily_demand,
            forecast_qty: r.forecast_qty,
            backlog_qty: r.backlog_qty,
            stock_qty: r.stock_qty,
            need_to_produce: r.need_to_produce,
            priority: r.priority
        }));

    const groupExpr = salesAnalyticsGroupExpr(groupBy);
    const trendSql = `
        SELECT
            TO_CHAR(${groupExpr}, 'YYYY-MM-DD') AS bucket,
            ROUND(COALESCE(SUM(CASE WHEN m.movement_type = 'sales_shipment' THEN ABS(m.quantity) ELSE 0 END), 0)::numeric, 4) AS shipped_qty,
            ROUND(COALESCE(SUM(CASE WHEN m.movement_type = 'shipment_reversal' THEN ABS(m.quantity) ELSE 0 END), 0)::numeric, 4) AS reversed_qty,
            ROUND(COALESCE(SUM(CASE WHEN m.movement_type = 'sales_shipment' THEN ABS(m.quantity) * COALESCE(coi.price, 0) ELSE 0 END), 0)::numeric, 2) AS shipped_revenue,
            ROUND(COALESCE(SUM(CASE WHEN m.movement_type = 'shipment_reversal' THEN ABS(m.quantity) * COALESCE(coi.price, 0) ELSE 0 END), 0)::numeric, 2) AS reversed_revenue
        FROM inventory_movements m
        JOIN items i ON i.id = m.item_id
        JOIN warehouses w ON w.id = m.warehouse_id
        LEFT JOIN client_order_items coi ON coi.id = m.linked_order_item_id
        ${whereSql}
        GROUP BY ${groupExpr}
        ORDER BY ${groupExpr} ASC
    `;
    const trendRes = await pool.query(trendSql, params);
    const trendRows = trendRes.rows.map((r) => {
        const shippedQty = Number(r.shipped_qty || 0);
        const reversedQty = Number(r.reversed_qty || 0);
        const shippedRevenue = Number(r.shipped_revenue || 0);
        const reversedRevenue = Number(r.reversed_revenue || 0);
        return {
            bucket: r.bucket,
            sold_qty: Number((includeReturns ? shippedQty - reversedQty : shippedQty).toFixed(4)),
            revenue_gross: Number((includeReturns ? shippedRevenue - reversedRevenue : shippedRevenue).toFixed(2))
        };
    });

    const totalTax = Number(profitabilityRows.reduce((s, r) => s + Number(r.tax_amount || 0), 0).toFixed(2));
    const totalRevenueNet = Number(profitabilityRows.reduce((s, r) => s + Number(r.revenue_net || 0), 0).toFixed(2));
    const totalProfit = Number(profitabilityRows.reduce((s, r) => s + Number(r.gross_profit || 0), 0).toFixed(2));
    const marginPct = totalRevenueNet > 0 ? Number(((totalProfit / totalRevenueNet) * 100).toFixed(2)) : 0;
    const topByVolume = productBase.slice().sort((a, b) => Number(b.sold_qty || 0) - Number(a.sold_qty || 0))[0] || null;
    const topByRevenue = productBase.slice().sort((a, b) => Number(b.revenue_gross || 0) - Number(a.revenue_gross || 0))[0] || null;
    const worstByMargin = productBase.slice().sort((a, b) => Number(a.gross_margin || 0) - Number(b.gross_margin || 0))[0] || null;
    const bestByMargin = productBase.slice().sort((a, b) => Number(b.gross_margin || 0) - Number(a.gross_margin || 0))[0] || null;

    const summaryRows = [
        { metric: 'Объем продаж (нетто)', value: totals.sold_qty, unit: 'ед.' },
        { metric: 'Выручка (брутто)', value: totals.revenue_gross, unit: '₽' },
        { metric: 'Возвраты (объем)', value: totals.returns_qty, unit: 'ед.' },
        { metric: 'Возвраты (выручка)', value: totals.returns_revenue, unit: '₽' },
        { metric: `Налог (оценка ${taxRate}%)`, value: totalTax, unit: '₽' },
        { metric: `Валовая прибыль (себестоимость${includeOverhead ? ', с оверхедом' : ', без оверхеда'}${includeTaxes ? ', налог в затратах' : ', без налога в затратах'})`, value: totalProfit, unit: '₽' },
        { metric: `Маржинальность (себестоимость${includeOverhead ? ', с оверхедом' : ', без оверхеда'}${includeTaxes ? ', налог в затратах' : ', без налога в затратах'})`, value: marginPct, unit: '%' },
        { metric: 'Лидер по объему', value: topByVolume ? `${topByVolume.item} (${formatNumber(topByVolume.sold_qty)} ${topByVolume.unit})` : '—', unit: '' },
        { metric: 'Лидер по выручке', value: topByRevenue ? `${topByRevenue.item} (${formatNumber(topByRevenue.revenue_gross)} ₽)` : '—', unit: '' },
        { metric: 'Лучшая маржа', value: bestByMargin ? `${bestByMargin.item} (${formatNumber(bestByMargin.gross_margin)}%)` : '—', unit: '' },
        { metric: 'Худшая маржа', value: worstByMargin ? `${worstByMargin.item} (${formatNumber(worstByMargin.gross_margin)}%)` : '—', unit: '' }
    ];

    const tabs = [
        {
            id: 'summary',
            title: 'Сводка',
            columns: [
                { key: 'metric', label: 'Показатель' },
                { key: 'value', label: 'Значение' },
                { key: 'unit', label: 'Ед.' }
            ],
            rows: summaryRows,
            totals: {}
        },
        {
            id: 'products',
            title: 'По продукции',
            columns: [
                { key: 'rank', label: '#' },
                { key: 'item', label: 'Номенклатура' },
                { key: 'unit', label: 'Ед.' },
                { key: 'sold_qty', label: 'Объем (нетто)' },
                { key: 'revenue_gross', label: 'Выручка' },
                { key: 'revenue_share', label: 'Доля выручки, %' },
                { key: 'qty_share', label: 'Доля объема, %' },
                { key: 'abc_class', label: 'ABC' }
            ],
            rows: productsTabRows,
            totals: {
                sold_qty: totals.sold_qty,
                revenue_gross: totals.revenue_gross
            }
        },
        {
            id: 'profitability',
            title: 'Рентабельность',
            columns: [
                { key: 'rank', label: '#' },
                { key: 'item', label: 'Номенклатура' },
                { key: 'unit', label: 'Ед.' },
                { key: 'sold_qty', label: 'Объем' },
                { key: 'revenue_gross', label: 'Выручка' },
                { key: 'tax_amount', label: `Налог ${taxRate}%` },
                { key: 'revenue_net', label: 'Выручка (чистая)' },
                { key: 'unit_cost_std', label: 'Себестоимость ед.' },
                { key: 'cost_source_label', label: 'Тип себестоимости' },
                { key: 'cogs_std', label: includeTaxes ? 'Себестоимость продаж (с налогом)' : 'Себестоимость продаж' },
                { key: 'gross_profit', label: 'Валовая прибыль' },
                { key: 'gross_margin', label: 'Маржа, %' }
            ],
            rows: profitabilityRows,
            totals: {
                gross_profit: totalProfit,
                gross_margin: marginPct,
                tax_amount: totalTax,
                revenue_net: totalRevenueNet
            }
        },
        {
            id: 'forecast',
            title: 'Прогноз выпуска',
            columns: [
                { key: 'rank', label: '#' },
                { key: 'item', label: 'Номенклатура' },
                { key: 'unit', label: 'Ед.' },
                { key: 'avg_daily_demand', label: 'Ср. спрос/день' },
                { key: 'forecast_qty', label: `Прогноз ${forecastHorizon} дн.` },
                { key: 'backlog_qty', label: 'Заказы к отгрузке' },
                { key: 'stock_qty', label: 'Остаток' },
                { key: 'need_to_produce', label: 'Нужно произвести' },
                { key: 'priority', label: 'Приоритет' }
            ],
            rows: forecastRows,
            totals: {
                need_to_produce: Number(forecastRows.reduce((s, r) => s + Number(r.need_to_produce || 0), 0).toFixed(4)),
                forecast_qty: Number(forecastRows.reduce((s, r) => s + Number(r.forecast_qty || 0), 0).toFixed(4))
            }
        }
    ];

    const tabMap = new Map(tabs.map((t) => [t.id, t]));
    const selectedTab = tabMap.get(activeTab) || tabs[0];
    return {
        title: 'Аналитика продаж',
        activeTab: selectedTab.id,
        tabs,
        kpis: [
            { key: 'sold_qty', label: 'Объем продаж', value: totals.sold_qty, unit: 'ед.' },
            { key: 'revenue_gross', label: 'Выручка', value: totals.revenue_gross, unit: '₽' },
            { key: 'tax_amount', label: includeTaxes ? `Налог (${taxRate}%)` : `Налог не в марже (ставка ${taxRate}%)`, value: totalTax, unit: '₽' },
            { key: 'gross_profit', label: 'Валовая прибыль (по себестоимости)', value: totalProfit, unit: '₽' },
            { key: 'gross_margin', label: 'Маржинальность (по себестоимости)', value: marginPct, unit: '%' },
            { key: 'returns_qty', label: 'Возвраты', value: totals.returns_qty, unit: 'ед.' }
        ],
        trend: trendRows,
        columns: selectedTab.columns,
        rows: selectedTab.rows,
        totals: selectedTab.totals
    };
}

async function buildSalesAnalyticsDrilldown(pool, params = {}) {
    const itemId = Number(params.itemId || 0);
    const metric = String(params.metric || 'sold_qty');
    const dateFrom = String(params.dateFrom || '');
    const dateTo = String(params.dateTo || '');
    const fromTs = toIsoDateStart(dateFrom);
    const toTs = toIsoDateEnd(dateTo);
    if (!itemId) throw new Error('Некорректная номенклатура');
    if (!fromTs || !toTs) throw new Error('Некорректный период');
    const allowedMetrics = new Set(['sold_qty', 'revenue_gross', 'gross_profit', 'need_to_produce', 'forecast_qty']);
    if (!allowedMetrics.has(metric)) throw new Error('Некорректная метрика');

    const sql = `
        SELECT
            m.id,
            ${reportDateExpr('m')} AS event_ts,
            m.movement_type,
            ABS(m.quantity) AS qty_abs,
            COALESCE(coi.price, 0) AS unit_price,
            COALESCE(o.id, 0) AS order_id,
            COALESCE(o.doc_number, '') AS order_doc,
            COALESCE(c.name, '') AS counterparty_name,
            COALESCE(m.description, '') AS note
        FROM inventory_movements m
        JOIN items i ON i.id = m.item_id
        LEFT JOIN client_order_items coi ON coi.id = m.linked_order_item_id
        LEFT JOIN client_orders o ON o.id = coi.order_id
        LEFT JOIN counterparties c ON c.id = o.counterparty_id
        WHERE m.item_id = $1::int
          AND ${reportDateExpr('m')} >= $2::timestamp
          AND ${reportDateExpr('m')} <= $3::timestamp
          AND m.movement_type IN ('sales_shipment', 'shipment_reversal')
        ORDER BY event_ts DESC, m.id DESC
        LIMIT 500
    `;
    const res = await pool.query(sql, [itemId, fromTs, toTs]);
    const itemNameRes = await pool.query(`SELECT name, COALESCE(NULLIF(TRIM(unit), ''), 'ед.') AS unit FROM items WHERE id = $1::int`, [itemId]);
    const itemName = itemNameRes.rows[0]?.name || `#${itemId}`;
    const unit = itemNameRes.rows[0]?.unit || 'ед.';
    const rows = res.rows.map((r) => {
        const isReturn = String(r.movement_type || '') === 'shipment_reversal';
        const qty = Number(r.qty_abs || 0);
        const amount = Number((qty * Number(r.unit_price || 0)).toFixed(2));
        return {
            id: Number(r.id || 0),
            date: new Date(r.event_ts).toLocaleDateString('ru-RU'),
            type: isReturn ? 'Возврат/отмена отгрузки' : 'Отгрузка',
            typeCode: isReturn ? 'expense' : 'income',
            qty: isReturn ? -qty : qty,
            unit,
            amount: isReturn ? -amount : amount,
            orderId: Number(r.order_id || 0),
            orderDoc: r.order_doc || '',
            counterparty: r.counterparty_name || '',
            note: r.note || ''
        };
    });
    return { itemId, itemName, metric, rangeMode: 'period', rows };
}

async function buildReport(pool, payload) {
    const reportType = payload.reportType;
    if (!REPORT_TYPES.has(reportType)) {
        throw new Error('Неподдерживаемый тип отчета');
    }
    const period = normalizePeriod(payload);
    const filters = payload.filters || {};
    const accountingMode = normalizeAccountingMode(payload.accountingMode);
    const warnings = [];
    const days = periodDays(period);

    if (reportType === 'inventory_register' && days > 93) {
        warnings.push(`Выбран длинный период (${days} дней). Для реестра применена постраничная выборка.`);
    }

    let data;
    if (reportType === 'osv_counterparties') data = await buildOsvCounterparties(pool, period, filters, accountingMode);
    if (reportType === 'osv_cash_accounts') data = await buildOsvCashAccounts(pool, period, filters, accountingMode);
    if (reportType === 'osv_materials') data = await buildStockOsv(pool, period, ['materials'], 'ОСВ по материалам', filters, accountingMode);
    if (reportType === 'osv_products') {
        /** Резерв (№7) всегда в выборке вместе с готовой; группируется с finished в один «пул». */
        data = await buildStockOsv(pool, period, ['finished', 'reserve', 'markdown'], 'ОСВ по продукции', filters, accountingMode);
    }
    if (reportType === 'turnover_finance') data = await buildTurnoverFinance(pool, period, filters, accountingMode);
    if (reportType === 'inventory_register') data = await buildInventoryRegister(pool, period, filters, payload.pagination || {}, accountingMode);
    if (reportType === 'sales_analytics') data = await buildSalesAnalytics(pool, period, filters, accountingMode);
    if (data && Array.isArray(data.warnings) && data.warnings.length) {
        warnings.push(...data.warnings);
    }

    if (Array.isArray(payload.visibleColumns) && payload.visibleColumns.length) {
        const allow = new Set(payload.visibleColumns.map((x) => String(x)));
        data.columns = data.columns.filter((c) => allow.has(c.key));
        if (reportType === 'sales_analytics' && Array.isArray(data.tabs)) {
            data.tabs = data.tabs.map((tab) => ({
                ...tab,
                columns: (tab.columns || []).filter((c) => allow.has(c.key) || c.key === 'item' || c.key === 'metric' || c.key === 'rank')
            }));
        }
    }

    const consistency = {
        status: 'ok',
        checks: []
    };
    if (reportType === 'osv_products' && data.totals) {
        const t = data.totals;
        const expected = Number(((Number(t.opening_qty || 0) + Number(t.inflow_qty || 0) - Number(t.outflow_qty || 0))).toFixed(4));
        const actual = Number((Number(t.closing_qty || 0)).toFixed(4));
        const ok = Math.abs(expected - actual) <= 0.0001;
        consistency.checks.push({
            name: data.commercialStockPresentation
                ? 'Итого: начало + приход − расход = конец (коммерческий режим)'
                : 'Итого: начало + приход − расход = конец',
            ok,
            expected,
            actual
        });
        if (!ok) consistency.status = 'warning';
    }
    if (reportType === 'osv_cash_accounts' && data.totals) {
        const expected = Number(((data.totals.opening_balance || 0) + (data.totals.debit_turnover || 0) - (data.totals.credit_turnover || 0)).toFixed(2));
        const actual = Number((data.totals.closing_balance || 0).toFixed(2));
        const ok = Math.abs(expected - actual) <= 0.01;
        consistency.checks.push({ name: 'opening + debit - credit = closing', ok, expected, actual });
        if (!ok) consistency.status = 'warning';
    }

    return {
        reportType,
        accountingMode,
        printTemplateVersion: String(payload.printTemplateVersion || 'v1'),
        period: { dateFrom: period.dateFrom, dateTo: period.dateTo },
        generatedAt: new Date().toISOString(),
        warnings,
        consistency,
        ...data
    };
}

async function buildReportOptions(pool, userId = null) {
    const [counterparties, accounts, items, movementTypes, regSourcesTx, regSourcesInv, settingsRes, financeSettingsRes, presetsRes] = await Promise.all([
        pool.query(`SELECT id, name FROM counterparties WHERE COALESCE(is_deleted, false) = false ORDER BY name ASC LIMIT 1000`),
        pool.query(`SELECT id, name FROM accounts WHERE COALESCE(is_deleted, false) = false ORDER BY name ASC LIMIT 200`),
        pool.query(`SELECT id, name FROM items WHERE COALESCE(is_deleted, false) = false ORDER BY name ASC LIMIT 3000`),
        pool.query(`SELECT DISTINCT movement_type FROM inventory_movements ORDER BY movement_type ASC LIMIT 500`),
        pool.query(`SELECT DISTINCT COALESCE(NULLIF(TRIM(reg_source_tag), ''), 'legacy') AS source_tag FROM transactions ORDER BY source_tag ASC LIMIT 300`),
        pool.query(`SELECT DISTINCT COALESCE(NULLIF(TRIM(reg_source_tag), ''), 'legacy') AS source_tag FROM inventory_movements ORDER BY source_tag ASC LIMIT 300`),
        pool.query(`SELECT key, value FROM system_settings WHERE key IN ('company_name','company_inn','company_kpp','company_address','company_director','company_accountant')`),
        pool.query(`SELECT key, value FROM settings WHERE key IN ('sales_tax', 'overhead_per_cycle')`),
        pool.query(
            `SELECT id, name, report_type, payload, is_shared
             FROM report_presets
             WHERE is_shared = true OR ($1::int IS NOT NULL AND user_id = $1::int)
             ORDER BY is_shared DESC, name ASC
             LIMIT 500`,
            [userId ? Number(userId) : null]
        )
    ]);
    const settings = {};
    settingsRes.rows.forEach((r) => {
        settings[r.key] = r.value;
    });
    const financeDefaults = {
        salesTax: 6,
        overheadPerCycle: 0
    };
    financeSettingsRes.rows.forEach((r) => {
        const key = String(r.key || '');
        const n = Number(r.value || 0);
        if (!Number.isFinite(n)) return;
        if (key === 'sales_tax') financeDefaults.salesTax = n;
        if (key === 'overhead_per_cycle') financeDefaults.overheadPerCycle = n;
    });
    const sortedAccounts = (accounts.rows || []).slice().sort((a, b) => {
        const wa = getCashAccountOrderWeight(a.name);
        const wb = getCashAccountOrderWeight(b.name);
        if (wa !== wb) return wa - wb;
        return String(a.name || '').localeCompare(String(b.name || ''), 'ru');
    });
    return {
        counterparties: counterparties.rows,
        accounts: sortedAccounts,
        items: items.rows,
        movementTypes: movementTypes.rows.map((r) => r.movement_type).filter(Boolean),
        regSourceTags: Array.from(new Set(
            []
                .concat(regSourcesTx.rows.map((r) => r.source_tag))
                .concat(regSourcesInv.rows.map((r) => r.source_tag))
                .filter(Boolean)
        )).sort((a, b) => String(a).localeCompare(String(b), 'ru')),
        settings,
        financeDefaults,
        printTemplateVersions: [
            { id: 'v1', label: 'Официальная форма v1' },
            { id: 'v2', label: 'Официальная форма v2 (расширенная)' }
        ],
        presets: presetsRes.rows
    };
}

function buildPrintHtml(report, user, settings = {}, formNumber = '') {
    const templateVersion = String(report.printTemplateVersion || 'v1');
    const showExtended = templateVersion === 'v2';
    const generatedAt = new Date(report.generatedAt).toLocaleString('ru-RU');
    const headers = report.columns.map((c) => `<th>${escapeHtml(c.label)}</th>`).join('');
    const rows = report.rows.map((r) => (
        `<tr>${report.columns.map((c) => {
            const raw = r[c.key];
            const byKey = /^(opening_|closing_|debit_|credit_|turnover_|.*(_qty|_sum|_count|_balance|_amount))|^(amount|quantity|count|sum)$/i.test(String(c.key || ''));
            const byValue = typeof raw === 'number' && Number.isFinite(raw);
            const numeric = byKey || byValue;
            return `<td>${escapeHtml(numeric ? formatNumber(raw) : raw)}</td>`;
        }).join('')}</tr>`
    )).join('');
    const totalsRow = report.totals && report.columns && report.columns.length
        ? `<tfoot><tr>${report.columns.map((c, idx) => {
            if (idx === 0) return '<th>Итого</th>';
            const val = report.totals[c.key];
            if (val === undefined || val === null || val === '') return '<th></th>';
            return `<th>${escapeHtml(formatNumber(val))}</th>`;
        }).join('')}</tr></tfoot>`
        : '';
    const metaV1 = `
    <div class="meta meta-compact">
      Период: ${escapeHtml(report.period.dateFrom)} - ${escapeHtml(report.period.dateTo)} | Сформировано: ${escapeHtml(generatedAt)}
    </div>`;
    const metaV2 = `
    <div class="meta">
      Организация: ${escapeHtml(settings.company_name || 'ПЛИТТЕКС')}<br/>
      ИНН/КПП: ${escapeHtml(settings.company_inn || '—')} / ${escapeHtml(settings.company_kpp || '—')}<br/>
      Адрес: ${escapeHtml(settings.company_address || '—')}<br/>
      Номер формы: ${escapeHtml(formNumber || 'б/н')}<br/>
      Период: ${escapeHtml(report.period.dateFrom)} - ${escapeHtml(report.period.dateTo)}<br/>
      Сформировано: ${escapeHtml(generatedAt)}
    </div>`;

    return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(showExtended ? `${report.title} — Форма 2` : `${report.title} — Форма 1`)}</title>
  <style>
    @page { margin: 10mm; }
    body { font-family: Arial, sans-serif; margin: 0; color: #222; }
    h1 { font-size: 20px; margin: 0 0 8px; }
    .meta { font-size: 12px; margin-bottom: 12px; color: #444; }
    .meta-compact { margin-bottom: 8px; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td { border: 1px solid #ccc; padding: 6px 8px; text-align: left; }
    th { background: #f4f4f4; }
    tfoot th { background: #f8f8f8; font-weight: 700; }
    .sign { margin-top: 28px; display: flex; justify-content: space-between; font-size: 12px; }
    .print-note { font-size: 11px; color: #666; margin-top: 8px; }
    @media print { html, body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
  </style>
</head>
<body>
  <h1>${escapeHtml(report.title)}</h1>
  ${showExtended ? metaV2 : metaV1}
  <table>
    <thead><tr>${headers}</tr></thead>
    <tbody>${rows || '<tr><td colspan="99">Нет данных</td></tr>'}</tbody>
    ${totalsRow}
  </table>
  ${showExtended ? `<div class="meta">Основание формирования: данные ERP на дату печати</div>` : ''}
  ${showExtended ? `<div class="sign">
    <div>Ответственный: ____________________</div>
    <div>Бухгалтер: ${escapeHtml(settings.company_accountant || '____________________')}</div>
    <div>Руководитель: ${escapeHtml(settings.company_director || '____________________')}</div>
  </div>` : ''}
  <div class="print-note">Если в окне печати видны дата/URL браузера: отключите опцию «Колонтитулы / Headers and footers».</div>
</body></html>`;
}

function buildCsv(report) {
    const head = report.columns.map((c) => escapeCsv(c.label)).join(';');
    const lines = report.rows.map((r) => report.columns.map((c) => escapeCsv(r[c.key])).join(';'));
    return `\uFEFF${head}\n${lines.join('\n')}`;
}

async function buildXlsxBuffer(report) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(report.title.slice(0, 31));
    ws.addRow([report.title]);
    ws.addRow([`Период: ${report.period.dateFrom} - ${report.period.dateTo}`]);
    ws.addRow([`Сформировано: ${new Date(report.generatedAt).toLocaleString('ru-RU')}`]);
    ws.addRow([]);
    ws.addRow(report.columns.map((c) => c.label));
    const header = ws.lastRow;
    header.font = { bold: true };
    for (const r of report.rows) {
        ws.addRow(report.columns.map((c) => r[c.key]));
    }
    if (report.totals) {
        ws.addRow([]);
        ws.addRow(['Итоги']);
        Object.entries(report.totals).forEach(([k, v]) => ws.addRow([k, v]));
    }
    ws.columns.forEach((col) => {
        col.width = Math.max(14, Math.min(40, (col.values || []).reduce((m, v) => Math.max(m, String(v || '').length), 10) + 2));
    });
    return wb.xlsx.writeBuffer();
}

async function getCompanySettings(pool) {
    const res = await pool.query(
        `SELECT key, value
         FROM system_settings
         WHERE key IN ('company_name','company_inn','company_kpp','company_address','company_director','company_accountant','reports_preflight_mode')`
    );
    const map = {};
    res.rows.forEach((r) => { map[r.key] = r.value; });
    return map;
}

function hashPayload(payload) {
    const raw = JSON.stringify(payload || {});
    return crypto.createHash('sha256').update(raw).digest('hex');
}

async function getPreflightMode(pool) {
    const res = await pool.query(`SELECT value FROM system_settings WHERE key = 'reports_preflight_mode'`);
    const mode = String(res.rows[0]?.value || 'warning').toLowerCase();
    return mode === 'hard_fail' ? 'hard_fail' : 'warning';
}

async function runReportPreflight(pool, report, options = {}) {
    const checks = [];
    const settings = options.settings || await getCompanySettings(pool);
    const mode = options.mode || 'warning';

    if (options.requireCompanySettings) {
        const missing = ['company_name', 'company_inn', 'company_kpp', 'company_address']
            .filter((k) => !String(settings[k] || '').trim());
        checks.push({
            code: 'missing_company_settings',
            ok: missing.length === 0,
            severity: missing.length ? 'warning' : 'info',
            message: missing.length ? `Не заполнены реквизиты: ${missing.join(', ')}` : 'Реквизиты компании заполнены'
        });
    }

    if (report.consistency && Array.isArray(report.consistency.checks)) {
        for (const c of report.consistency.checks) {
            checks.push({
                code: `consistency_${String(c.name || 'check').replace(/\s+/g, '_').toLowerCase()}`,
                ok: Boolean(c.ok),
                severity: c.ok ? 'info' : 'critical',
                message: c.ok ? `OK: ${c.name}` : `Нарушение консистентности: ${c.name}`
            });
        }
    }

    if (report.reportType === 'osv_products') {
        const hasNegative = Array.isArray(report.rows) && report.rows.some((r) => Number(r.closing_qty || 0) < 0);
        const commercial = Boolean(report.commercialStockPresentation);
        checks.push({
            code: 'negative_closing_qty',
            ok: !hasNegative || commercial,
            severity: commercial && hasNegative ? 'info' : (hasNegative ? 'critical' : 'info'),
            message: commercial && hasNegative
                ? 'Есть отрицательный коммерческий конец строк (учёт производственного долга) — допустимо в режиме ОСВ по продукции.'
                : (hasNegative ? 'Есть отрицательные конечные остатки продукции' : 'Отрицательных конечных остатков нет')
        });
    }

    const failedCritical = checks.filter((c) => !c.ok && c.severity === 'critical');
    const failedWarning = checks.filter((c) => !c.ok && c.severity === 'warning');
    const blocked = mode === 'hard_fail' && failedCritical.length > 0;
    return {
        mode,
        blocked,
        status: blocked ? 'blocked' : (failedCritical.length || failedWarning.length ? 'warning' : 'ok'),
        reasons: [...failedCritical, ...failedWarning].map((x) => x.message),
        checks
    };
}

async function logReportRun(pool, req, report, format, preflight = null) {
    try {
        const payload = req.body && typeof req.body === 'object' ? req.body : null;
        const payloadHash = hashPayload(payload);
        const preflightStatus = preflight?.status || null;
        const preflightReason = Array.isArray(preflight?.reasons) && preflight.reasons.length
            ? preflight.reasons.join(' | ')
            : null;
        await pool.query(
            `INSERT INTO report_runs (user_id, username, report_type, date_from, date_to, accounting_mode, format, rows_count, payload, payload_hash, preflight_status, preflight_reason)
             VALUES ($1, $2, $3, $4::date, $5::date, $6, $7, $8, $9::jsonb, $10, $11, $12)`,
            [
                req.user ? req.user.id : null,
                req.user ? req.user.username : 'system',
                report.reportType,
                report.period?.dateFrom || null,
                report.period?.dateTo || null,
                report.accountingMode || 'managerial',
                format,
                Array.isArray(report.rows) ? report.rows.length : 0,
                payload ? JSON.stringify(payload) : null,
                payloadHash,
                preflightStatus,
                preflightReason
            ]
        );
    } catch (e) {
        // non-blocking
    }
}

async function nextReportFormNumber(pool, reportType) {
    const y = new Date().getFullYear();
    const prefix = `RPT-${y}`;
    const res = await pool.query(
        `SELECT COUNT(*)::int AS cnt FROM report_runs WHERE report_type = $1 AND generated_at >= $2::date AND generated_at < ($2::date + INTERVAL '1 year')`,
        [reportType, `${y}-01-01`]
    );
    const n = Number(res.rows[0]?.cnt || 0) + 1;
    return `${prefix}-${String(n).padStart(5, '0')}`;
}

module.exports = function reportsRoutes(pool) {
    const router = express.Router();

    initReportsInfra(pool).catch(() => {});

    router.get('/api/reports/options', requireReportAccess('view'), async (req, res) => {
        try {
            const options = await buildReportOptions(pool, req.user ? req.user.id : null);
            options.stockValuationModes = [
                { id: 'movement_actual', label: 'Фактическая (по движениям)' },
                { id: 'legacy_current_price', label: 'Legacy (по текущей цене карточки)' }
            ];
            options.canManageSettings = isAdmin(req.user);
            options.permissions = {
                view: hasReportPermission(req.user, 'view'),
                export: hasReportPermission(req.user, 'export'),
                print: hasReportPermission(req.user, 'print'),
                manageTemplates: hasReportPermission(req.user, 'manage_templates'),
                manageSharedPresets: hasReportPermission(req.user, 'manage_shared_presets')
            };
            res.json(options);
        } catch (err) {
            res.status(500).json({ error: err.message || 'Ошибка загрузки опций отчетов' });
        }
    });

    router.post('/api/reports/settings', requireReportAccess('manage_templates'), requireAdmin, async (req, res) => {
        try {
            const allowed = [
                'company_name',
                'company_inn',
                'company_kpp',
                'company_address',
                'company_director',
                'company_accountant',
                'reports_preflight_mode'
            ];
            const input = req.body || {};
            for (const key of allowed) {
                if (Object.prototype.hasOwnProperty.call(input, key)) {
                    await pool.query(
                        `INSERT INTO system_settings (key, value)
                         VALUES ($1, $2)
                         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
                        [key, String(input[key] || '')]
                    );
                }
            }
            await auditLog(pool, req, 'report_settings_update', 'system_settings', null, 'Updated report print settings');
            const settings = await getCompanySettings(pool);
            res.json({ success: true, settings });
        } catch (err) {
            res.status(500).json({ error: err.message || 'Ошибка сохранения реквизитов' });
        }
    });

    router.get('/api/reports/presets', requireReportAccess('view'), async (req, res) => {
        try {
            const userId = req.user ? req.user.id : null;
            const data = await pool.query(
                `SELECT id, name, report_type, payload, is_shared
                 FROM report_presets
                 WHERE is_shared = true OR ($1::int IS NOT NULL AND user_id = $1::int)
                 ORDER BY is_shared DESC, name ASC`,
                [userId]
            );
            res.json({ presets: data.rows });
        } catch (err) {
            res.status(500).json({ error: err.message || 'Ошибка загрузки пресетов' });
        }
    });

    router.get('/api/reports/runs', requireReportAccess('view'), async (req, res) => {
        try {
            const limit = Math.min(500, Math.max(10, Number(req.query.limit || 100)));
            const reportType = req.query.reportType ? String(req.query.reportType) : '';
            const format = req.query.format ? String(req.query.format) : '';
            const preflightStatus = req.query.preflightStatus ? String(req.query.preflightStatus) : '';
            const username = req.query.username ? String(req.query.username) : '';
            const generatedFrom = req.query.generatedFrom ? String(req.query.generatedFrom) : '';
            const generatedTo = req.query.generatedTo ? String(req.query.generatedTo) : '';
            const params = [];
            let where = '';
            if (reportType) {
                params.push(reportType);
                where += ` AND report_type = $${params.length} `;
            }
            if (format) {
                params.push(format);
                where += ` AND format = $${params.length} `;
            }
            if (preflightStatus) {
                params.push(preflightStatus);
                where += ` AND COALESCE(preflight_status, '') = $${params.length} `;
            }
            if (username) {
                params.push(`%${username}%`);
                where += ` AND COALESCE(username, '') ILIKE $${params.length} `;
            }
            if (generatedFrom) {
                params.push(generatedFrom);
                where += ` AND generated_at >= $${params.length}::date `;
            }
            if (generatedTo) {
                params.push(generatedTo);
                where += ` AND generated_at < ($${params.length}::date + INTERVAL '1 day') `;
            }
            params.push(limit);
            const sql = `
                SELECT id, user_id, username, report_type, date_from, date_to, accounting_mode, format, rows_count, payload, payload_hash, preflight_status, preflight_reason, generated_at
                FROM report_runs
                WHERE 1=1
                ${where}
                ORDER BY generated_at DESC, id DESC
                LIMIT $${params.length}
            `;
            const runs = await pool.query(sql, params);
            res.json({ runs: runs.rows });
        } catch (err) {
            res.status(500).json({ error: err.message || 'Ошибка загрузки истории отчетов' });
        }
    });

    router.post('/api/reports/runs/cleanup', requireReportAccess('manage_templates'), requireAdmin, async (req, res) => {
        try {
            const scope = String(req.body?.scope || 'preview_only');
            const reason = String(req.body?.reason || '').trim();
            if (!reason) {
                return res.status(400).json({ error: 'Укажите причину очистки истории.' });
            }
            let sql = `DELETE FROM report_runs WHERE format IN ('preview', 'print_blocked', 'csv_blocked', 'xlsx_blocked') RETURNING id`;
            if (scope === 'all') {
                sql = `DELETE FROM report_runs RETURNING id`;
            }
            const del = await pool.query(sql);
            await auditLog(
                pool,
                req,
                'report_runs_cleanup',
                'report_runs',
                null,
                `scope=${scope}; deleted=${del.rows.length}; reason=${reason}`
            );
            res.json({ success: true, deleted: del.rows.length, scope });
        } catch (err) {
            res.status(500).json({ error: err.message || 'Ошибка очистки истории отчетов' });
        }
    });

    router.get('/api/reports/runs/export/csv', requireReportAccess('export'), async (req, res) => {
        try {
            const reportType = req.query.reportType ? String(req.query.reportType) : '';
            const format = req.query.format ? String(req.query.format) : '';
            const preflightStatus = req.query.preflightStatus ? String(req.query.preflightStatus) : '';
            const username = req.query.username ? String(req.query.username) : '';
            const generatedFrom = req.query.generatedFrom ? String(req.query.generatedFrom) : '';
            const generatedTo = req.query.generatedTo ? String(req.query.generatedTo) : '';
            const params = [];
            let where = '';
            if (reportType) {
                params.push(reportType);
                where += ` AND report_type = $${params.length} `;
            }
            if (format) {
                params.push(format);
                where += ` AND format = $${params.length} `;
            }
            if (preflightStatus) {
                params.push(preflightStatus);
                where += ` AND COALESCE(preflight_status, '') = $${params.length} `;
            }
            if (username) {
                params.push(`%${username}%`);
                where += ` AND COALESCE(username, '') ILIKE $${params.length} `;
            }
            if (generatedFrom) {
                params.push(generatedFrom);
                where += ` AND generated_at >= $${params.length}::date `;
            }
            if (generatedTo) {
                params.push(generatedTo);
                where += ` AND generated_at < ($${params.length}::date + INTERVAL '1 day') `;
            }
            const sql = `
                SELECT id, user_id, username, report_type, date_from, date_to, accounting_mode, format, rows_count, payload, payload_hash, preflight_status, preflight_reason, generated_at
                FROM report_runs
                WHERE 1=1
                ${where}
                ORDER BY generated_at DESC, id DESC
                LIMIT 5000
            `;
            const runs = await pool.query(sql, params);
            const csv = buildRunsCsv(runs.rows);
            const name = `report_runs_${new Date().toISOString().slice(0, 10)}.csv`;
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
            res.send(csv);
        } catch (err) {
            res.status(500).json({ error: err.message || 'Ошибка экспорта истории отчетов' });
        }
    });

    router.get('/api/reports/counterparty-drilldown', requireReportAccess('view'), async (req, res) => {
        try {
            const data = await buildCounterpartyDrilldown(pool, {
                counterpartyId: req.query.counterpartyId,
                dateFrom: req.query.dateFrom,
                dateTo: req.query.dateTo,
                metric: req.query.metric
            });
            res.json(data);
        } catch (err) {
            res.status(400).json({ error: err.message || 'Ошибка расшифровки контрагента' });
        }
    });

    router.get('/api/reports/account-drilldown', requireReportAccess('view'), async (req, res) => {
        try {
            const data = await buildAccountDrilldown(pool, {
                accountId: req.query.accountId,
                dateFrom: req.query.dateFrom,
                dateTo: req.query.dateTo,
                metric: req.query.metric
            });
            res.json(data);
        } catch (err) {
            res.status(400).json({ error: err.message || 'Ошибка расшифровки счета' });
        }
    });

    router.get('/api/reports/stock-drilldown', requireReportAccess('view'), async (req, res) => {
        try {
            const data = await buildStockDrilldown(pool, {
                itemId: req.query.itemId,
                warehouseId: req.query.warehouseId,
                dateFrom: req.query.dateFrom,
                dateTo: req.query.dateTo,
                metric: req.query.metric,
                includeReserves: req.query.includeReserves === 'true' || req.query.includeReserves === '1',
                commercialTurnover: req.query.commercialTurnover === 'true' || req.query.commercialTurnover === '1',
                unifiedFgReservePool: req.query.unifiedFgReservePool === 'true' || req.query.unifiedFgReservePool === '1'
            });
            res.json(data);
        } catch (err) {
            res.status(400).json({ error: err.message || 'Ошибка расшифровки движений по номенклатуре' });
        }
    });

    router.get('/api/reports/finance-drilldown', requireReportAccess('view'), async (req, res) => {
        try {
            const data = await buildTurnoverFinanceDrilldown(pool, {
                dateFrom: req.query.dateFrom,
                dateTo: req.query.dateTo,
                typeCode: req.query.typeCode,
                category: req.query.category,
                accountingMode: req.query.accountingMode,
                regOnlyPosted: String(req.query.regOnlyPosted || '') !== '' ? String(req.query.regOnlyPosted) === 'true' : undefined,
                regOnlyPrimaryDoc: String(req.query.regOnlyPrimaryDoc || '') !== '' ? String(req.query.regOnlyPrimaryDoc) === 'true' : undefined,
                regRequireDocumentNo: String(req.query.regRequireDocumentNo || '') !== '' ? String(req.query.regRequireDocumentNo) === 'true' : undefined,
                regExcludeOffset: String(req.query.regExcludeOffset || '') !== '' ? String(req.query.regExcludeOffset) === 'true' : undefined,
                regExcludeTechnical: String(req.query.regExcludeTechnical || '') !== '' ? String(req.query.regExcludeTechnical) === 'true' : undefined,
                regSourceTag: req.query.regSourceTag || ''
            });
            res.json(data);
        } catch (err) {
            res.status(400).json({ error: err.message || 'Ошибка расшифровки оборотов по финстатье' });
        }
    });

    router.get('/api/reports/sales-analytics-drilldown', requireReportAccess('view'), async (req, res) => {
        try {
            const data = await buildSalesAnalyticsDrilldown(pool, {
                itemId: req.query.itemId,
                metric: req.query.metric,
                dateFrom: req.query.dateFrom,
                dateTo: req.query.dateTo
            });
            res.json(data);
        } catch (err) {
            res.status(400).json({ error: err.message || 'Ошибка расшифровки аналитики продаж' });
        }
    });

    router.get('/api/reports/inventory-valuation-audit', requireReportAccess('view'), async (req, res) => {
        try {
            const dateFrom = String(req.query.dateFrom || '');
            const dateTo = String(req.query.dateTo || '');
            let period = null;
            if (dateFrom && dateTo) {
                period = { fromTs: toIsoDateStart(dateFrom), toTs: toIsoDateEnd(dateTo) };
                if (!period.fromTs || !period.toTs) return res.status(400).json({ error: 'Некорректный период' });
            }
            const warehouseTypes = req.query.warehouseTypes
                ? String(req.query.warehouseTypes).split(',').map((x) => x.trim()).filter(Boolean)
                : null;
            const data = await buildInventoryValuationCoverage(pool, period, warehouseTypes);
            res.json(data);
        } catch (err) {
            res.status(500).json({ error: err.message || 'Ошибка аудита покрытия цен движений' });
        }
    });

    router.post('/api/reports/inventory-valuation-backfill', requireReportAccess('manage_templates'), requireAdmin, async (req, res) => {
        try {
            const dateFrom = String(req.body?.dateFrom || '');
            const dateTo = String(req.body?.dateTo || '');
            const apply = Boolean(req.body?.apply);
            const period = {
                fromTs: toIsoDateStart(dateFrom),
                toTs: toIsoDateEnd(dateTo)
            };
            if (!period.fromTs || !period.toTs) return res.status(400).json({ error: 'Некорректный период' });
            const warehouseTypes = Array.isArray(req.body?.warehouseTypes) ? req.body.warehouseTypes.map((x) => String(x)) : null;
            const data = await backfillInventoryUnitPrice(pool, period, apply, warehouseTypes);
            await auditLog(pool, req, 'reports_inventory_valuation_backfill', 'inventory_movement', null, `apply=${apply}; from=${dateFrom}; to=${dateTo}`);
            res.json(data);
        } catch (err) {
            res.status(500).json({ error: err.message || 'Ошибка backfill цен движений' });
        }
    });

    router.post('/api/reports/presets', requireReportAccess('view'), async (req, res) => {
        try {
            const userId = req.user ? req.user.id : null;
            const { name, reportType, payload, isShared } = req.body || {};
            if (!name || !reportType || !payload) {
                return res.status(400).json({ error: 'name, reportType и payload обязательны' });
            }
            if (Boolean(isShared) && !hasReportPermission(req.user, 'manage_shared_presets')) {
                return res.status(403).json({ error: 'Общие пресеты может создавать только администратор.' });
            }
            const ins = await pool.query(
                `INSERT INTO report_presets (user_id, name, report_type, payload, is_shared)
                 VALUES ($1, $2, $3, $4::jsonb, $5)
                 RETURNING id, name, report_type, payload, is_shared`,
                [userId, String(name), String(reportType), JSON.stringify(payload), Boolean(isShared)]
            );
            await auditLog(pool, req, 'report_preset_create', 'report_preset', ins.rows[0].id, `Preset: ${name}`);
            res.json({ preset: ins.rows[0] });
        } catch (err) {
            res.status(500).json({ error: err.message || 'Ошибка сохранения пресета' });
        }
    });

    router.delete('/api/reports/presets/:id', requireReportAccess('view'), async (req, res) => {
        try {
            const userId = req.user ? req.user.id : null;
            const id = Number(req.params.id);
            const del = await pool.query(
                `DELETE FROM report_presets
                 WHERE id = $1
                   AND ((is_shared = false AND user_id = $2) OR (is_shared = true AND $3 = 'admin' AND $4 = true))
                 RETURNING id`,
                [id, userId, req.user ? req.user.role : '', hasReportPermission(req.user, 'manage_shared_presets')]
            );
            if (!del.rows.length) return res.status(404).json({ error: 'Пресет не найден или нет прав' });
            await auditLog(pool, req, 'report_preset_delete', 'report_preset', id, `Deleted preset #${id}`);
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message || 'Ошибка удаления пресета' });
        }
    });

    router.post('/api/reports/preview', requireReportAccess('view'), validateReportRequest, async (req, res) => {
        try {
            const report = await buildReport(pool, req.body || {});
            const preflight = await runReportPreflight(pool, report, { mode: await getPreflightMode(pool) });
            await auditLog(pool, req, 'report_preview', 'report', null, `type=${report.reportType}; preflight=${preflight.status}; hash=${hashPayload(req.body || {})}`);
            res.json({ ...report, preflight });
        } catch (err) {
            res.status(500).json({ error: err.message || 'Ошибка формирования отчета' });
        }
    });

    router.post('/api/reports/print', requireReportAccess('print'), validateReportRequest, async (req, res) => {
        try {
            const report = await buildReport(pool, req.body || {});
            const preflightMode = await getPreflightMode(pool);
            const settings = await getCompanySettings(pool);
            const preflight = await runReportPreflight(pool, report, {
                settings,
                mode: preflightMode,
                requireCompanySettings: true
            });
            if (preflight.blocked) {
                await logReportRun(pool, req, report, 'print_blocked', preflight);
                await auditLog(pool, req, 'report_print_blocked', 'report', null, `type=${report.reportType}; reasons=${preflight.reasons.join(' | ')}; hash=${hashPayload(req.body || {})}`);
                return res.status(409).json({
                    error: 'Печать заблокирована preflight-проверкой',
                    code: 'PRECHECK_BLOCKED',
                    preflight
                });
            }
            const formNumber = await nextReportFormNumber(pool, report.reportType);
            await logReportRun(pool, req, report, 'print', preflight);
            await auditLog(pool, req, 'report_print', 'report', null, `type=${report.reportType}; preflight=${preflight.status}; hash=${hashPayload(req.body || {})}`);
            res.json({
                html: buildPrintHtml(report, req.user || null, settings, formNumber),
                title: report.title,
                formNumber,
                preflight
            });
        } catch (err) {
            res.status(500).json({ error: err.message || 'Ошибка печати отчета' });
        }
    });

    router.post('/api/reports/export/csv', requireReportAccess('export'), validateReportRequest, async (req, res) => {
        try {
            const report = await buildReport(pool, req.body || {});
            const preflight = await runReportPreflight(pool, report, {
                mode: await getPreflightMode(pool),
                requireCompanySettings: true
            });
            if (preflight.blocked) {
                await logReportRun(pool, req, report, 'csv_blocked', preflight);
                await auditLog(pool, req, 'report_export_csv_blocked', 'report', null, `type=${report.reportType}; reasons=${preflight.reasons.join(' | ')}; hash=${hashPayload(req.body || {})}`);
                return res.status(409).json({
                    error: 'Экспорт CSV заблокирован preflight-проверкой',
                    code: 'PRECHECK_BLOCKED',
                    preflight
                });
            }
            const csv = buildCsv(report);
            const name = `${report.reportType}_${report.period.dateFrom}_${report.period.dateTo}.csv`;
            await logReportRun(pool, req, report, 'csv', preflight);
            await auditLog(pool, req, 'report_export_csv', 'report', null, `type=${report.reportType}; preflight=${preflight.status}; hash=${hashPayload(req.body || {})}`);
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
            res.send(csv);
        } catch (err) {
            res.status(500).json({ error: err.message || 'Ошибка экспорта CSV' });
        }
    });

    router.post('/api/reports/export/xlsx', requireReportAccess('export'), validateReportRequest, async (req, res) => {
        try {
            const report = await buildReport(pool, req.body || {});
            const preflight = await runReportPreflight(pool, report, {
                mode: await getPreflightMode(pool),
                requireCompanySettings: true
            });
            if (preflight.blocked) {
                await logReportRun(pool, req, report, 'xlsx_blocked', preflight);
                await auditLog(pool, req, 'report_export_xlsx_blocked', 'report', null, `type=${report.reportType}; reasons=${preflight.reasons.join(' | ')}; hash=${hashPayload(req.body || {})}`);
                return res.status(409).json({
                    error: 'Экспорт XLSX заблокирован preflight-проверкой',
                    code: 'PRECHECK_BLOCKED',
                    preflight
                });
            }
            const buf = await buildXlsxBuffer(report);
            const name = `${report.reportType}_${report.period.dateFrom}_${report.period.dateTo}.xlsx`;
            await logReportRun(pool, req, report, 'xlsx', preflight);
            await auditLog(pool, req, 'report_export_xlsx', 'report', null, `type=${report.reportType}; preflight=${preflight.status}; hash=${hashPayload(req.body || {})}`);
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
            res.send(Buffer.from(buf));
        } catch (err) {
            res.status(500).json({ error: err.message || 'Ошибка экспорта XLSX' });
        }
    });

    return router;
};
