const express = require('express');
const ExcelJS = require('exceljs');
const crypto = require('crypto');
const { validateReportRequest } = require('../middleware/validator');
const { auditLog } = require('../utils/db_init');
const { requireAdmin, requireReportAccess, hasReportPermission } = require('../middleware/auth');

const REPORT_TYPES = new Set([
    'osv_counterparties',
    'osv_cash_accounts',
    'osv_materials',
    'osv_products',
    'turnover_finance',
    'inventory_register'
]);

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
    await pool.query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS reg_is_posted BOOLEAN`);
    await pool.query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS reg_is_primary_doc BOOLEAN`);
    await pool.query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS reg_document_no VARCHAR(120)`);
    await pool.query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS reg_document_date DATE`);
    await pool.query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS reg_source_tag VARCHAR(40)`);
    await pool.query(`UPDATE transactions SET reg_is_posted = true WHERE reg_is_posted IS NULL`);
    await pool.query(`UPDATE transactions SET reg_is_primary_doc = false WHERE reg_is_primary_doc IS NULL`);
    await pool.query(`UPDATE transactions SET reg_source_tag = 'legacy' WHERE reg_source_tag IS NULL OR TRIM(reg_source_tag) = ''`);

    await pool.query(`ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS reg_is_posted BOOLEAN`);
    await pool.query(`ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS reg_is_primary_doc BOOLEAN`);
    await pool.query(`ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS reg_document_no VARCHAR(120)`);
    await pool.query(`ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS reg_document_date DATE`);
    await pool.query(`ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS reg_source_tag VARCHAR(40)`);
    await pool.query(`UPDATE inventory_movements SET reg_is_posted = true WHERE reg_is_posted IS NULL`);
    await pool.query(`UPDATE inventory_movements SET reg_is_primary_doc = false WHERE reg_is_primary_doc IS NULL`);
    await pool.query(`UPDATE inventory_movements SET reg_source_tag = 'legacy' WHERE reg_source_tag IS NULL OR TRIM(reg_source_tag) = ''`);

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_tx_report_date_type ON transactions(transaction_date, transaction_type)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_tx_report_account ON transactions(account_id, transaction_date)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_tx_reg_source_tag ON transactions(reg_source_tag, transaction_date)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_inv_report_date_wh_item ON inventory_movements(movement_date, warehouse_id, item_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_inv_report_created_wh_item ON inventory_movements(created_at, warehouse_id, item_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_inv_reg_source_tag ON inventory_movements(reg_source_tag, movement_date)`);
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
            return {
                counterparty_id: Number(r.counterparty_id || 0),
                counterparty: r.counterparty,
                opening_debit: opening > 0 ? opening : 0,
                opening_credit: opening < 0 ? Math.abs(opening) : 0,
                payment_in: Number(r.pay_in.toFixed(2)),
                payment_out: Number(r.pay_out.toFixed(2)),
                shipment_in: Number(r.ship_in.toFixed(2)),
                shipment_out: Number(r.ship_out.toFixed(2)),
                closing_debit: closing > 0 ? closing : 0,
                closing_credit: closing < 0 ? Math.abs(closing) : 0,
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
            account: r.account_name,
            opening_balance: opening,
            debit_turnover: debit,
            credit_turnover: credit,
            closing_balance: Number((opening + debit - credit).toFixed(2))
        };
    });
    const totals = {
        opening_balance: Number(rows.reduce((s, r) => s + r.opening_balance, 0).toFixed(2)),
        debit_turnover: Number(rows.reduce((s, r) => s + r.debit_turnover, 0).toFixed(2)),
        credit_turnover: Number(rows.reduce((s, r) => s + r.credit_turnover, 0).toFixed(2)),
        closing_balance: Number(rows.reduce((s, r) => s + r.closing_balance, 0).toFixed(2))
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
        rows,
        totals
    };
}

async function buildStockOsv(pool, period, warehouseTypes, title, filters = {}, accountingMode = 'managerial') {
    const params = [period.fromTs, period.toTs, warehouseTypes];
    let extra = '';
    if (filters.warehouseType && warehouseTypes.includes(String(filters.warehouseType))) {
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
        if (filters.regExcludeReserve !== false) extra += ` AND m.movement_type NOT IN ('reserve_expense', 'reserve_receipt', 'reserve_transfer_in', 'reserve_transfer_out') `;
        if (filters.regExcludeAdjustments !== false) extra += ` AND m.movement_type NOT IN ('manual_adjustment', 'audit_adjustment', 'adjustment', 'revision') `;
        if (filters.regSourceTag) {
            params.push(String(filters.regSourceTag));
            extra += ` AND COALESCE(NULLIF(TRIM(m.reg_source_tag), ''), 'legacy') = $${params.length} `;
        }
    }
    const sql = `
        SELECT
            i.name AS item_name,
            i.unit AS unit,
            w.name AS warehouse_name,
            ROUND(COALESCE(SUM(CASE WHEN COALESCE(m.movement_date, m.created_at) < $1::timestamp THEN m.quantity ELSE 0 END),0)::numeric,4) AS opening_qty,
            ROUND(COALESCE(SUM(CASE WHEN COALESCE(m.movement_date, m.created_at) >= $1::timestamp AND COALESCE(m.movement_date, m.created_at) <= $2::timestamp AND m.quantity > 0 THEN m.quantity ELSE 0 END),0)::numeric,4) AS inflow_qty,
            ROUND(COALESCE(SUM(CASE WHEN COALESCE(m.movement_date, m.created_at) >= $1::timestamp AND COALESCE(m.movement_date, m.created_at) <= $2::timestamp AND m.quantity < 0 THEN ABS(m.quantity) ELSE 0 END),0)::numeric,4) AS outflow_qty,
            ROUND(COALESCE(SUM(CASE WHEN COALESCE(m.movement_date, m.created_at) <= $2::timestamp THEN m.quantity ELSE 0 END),0)::numeric,4) AS closing_qty
        FROM items i
        JOIN inventory_movements m ON m.item_id = i.id
        JOIN warehouses w ON w.id = m.warehouse_id
        WHERE w.type = ANY($3::text[])
        ${extra}
        GROUP BY i.name, i.unit, w.name
        HAVING COALESCE(SUM(CASE WHEN COALESCE(m.movement_date, m.created_at) <= $2::timestamp THEN m.quantity ELSE 0 END),0) <> 0
        ORDER BY i.name, w.name
    `;
    const res = await pool.query(sql, params);
    const rows = res.rows.map((r) => ({
        item: r.item_name,
        warehouse: r.warehouse_name,
        unit: r.unit,
        opening_qty: Number(r.opening_qty || 0),
        inflow_qty: Number(r.inflow_qty || 0),
        outflow_qty: Number(r.outflow_qty || 0),
        closing_qty: Number(r.closing_qty || 0)
    }));
    const totals = {
        opening_qty: Number(rows.reduce((s, r) => s + r.opening_qty, 0).toFixed(4)),
        inflow_qty: Number(rows.reduce((s, r) => s + r.inflow_qty, 0).toFixed(4)),
        outflow_qty: Number(rows.reduce((s, r) => s + r.outflow_qty, 0).toFixed(4)),
        closing_qty: Number(rows.reduce((s, r) => s + r.closing_qty, 0).toFixed(4))
    };
    return {
        title,
        columns: [
            { key: 'item', label: 'Номенклатура' },
            { key: 'warehouse', label: 'Склад' },
            { key: 'unit', label: 'Ед. изм.' },
            { key: 'opening_qty', label: 'Остаток начальный' },
            { key: 'inflow_qty', label: 'Приход' },
            { key: 'outflow_qty', label: 'Расход' },
            { key: 'closing_qty', label: 'Остаток конечный' }
        ],
        rows,
        totals
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
            extra += ` AND m.movement_type NOT IN ('reserve_expense', 'reserve_receipt', 'reserve_transfer_in', 'reserve_transfer_out') `;
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
            w.name AS warehouse_name,
            i.name AS item_name,
            i.unit AS unit,
            m.movement_type,
            m.quantity,
            b.batch_number,
            m.description
        FROM inventory_movements m
        JOIN warehouses w ON w.id = m.warehouse_id
        JOIN items i ON i.id = m.item_id
        LEFT JOIN production_batches b ON b.id = m.batch_id
        ${whereSql}
        ORDER BY event_ts ASC, m.id ASC
        LIMIT $${params.length - 1}
        OFFSET $${params.length}
    `;
    const res = await pool.query(sql, params);
    const rows = res.rows.map((r) => ({
        date: new Date(r.event_ts).toLocaleString('ru-RU'),
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
    if (reportType === 'osv_products') data = await buildStockOsv(pool, period, ['finished', 'markdown'], 'ОСВ по продукции', filters, accountingMode);
    if (reportType === 'turnover_finance') data = await buildTurnoverFinance(pool, period, filters, accountingMode);
    if (reportType === 'inventory_register') data = await buildInventoryRegister(pool, period, filters, payload.pagination || {}, accountingMode);

    if (Array.isArray(payload.visibleColumns) && payload.visibleColumns.length) {
        const allow = new Set(payload.visibleColumns.map((x) => String(x)));
        data.columns = data.columns.filter((c) => allow.has(c.key));
    }

    const consistency = {
        status: 'ok',
        checks: []
    };
    if (reportType === 'osv_products' && data.totals) {
        const expected = Number(((data.totals.opening_qty || 0) + (data.totals.inflow_qty || 0) - (data.totals.outflow_qty || 0)).toFixed(4));
        const actual = Number((data.totals.closing_qty || 0).toFixed(4));
        const ok = Math.abs(expected - actual) <= 0.0001;
        consistency.checks.push({ name: 'opening + inflow - outflow = closing', ok, expected, actual });
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
    const [counterparties, accounts, items, movementTypes, regSourcesTx, regSourcesInv, settingsRes, presetsRes] = await Promise.all([
        pool.query(`SELECT id, name FROM counterparties ORDER BY name ASC LIMIT 1000`),
        pool.query(`SELECT id, name FROM accounts ORDER BY name ASC LIMIT 200`),
        pool.query(`SELECT id, name FROM items ORDER BY name ASC LIMIT 3000`),
        pool.query(`SELECT DISTINCT movement_type FROM inventory_movements ORDER BY movement_type ASC LIMIT 500`),
        pool.query(`SELECT DISTINCT COALESCE(NULLIF(TRIM(reg_source_tag), ''), 'legacy') AS source_tag FROM transactions ORDER BY source_tag ASC LIMIT 300`),
        pool.query(`SELECT DISTINCT COALESCE(NULLIF(TRIM(reg_source_tag), ''), 'legacy') AS source_tag FROM inventory_movements ORDER BY source_tag ASC LIMIT 300`),
        pool.query(`SELECT key, value FROM system_settings WHERE key IN ('company_name','company_inn','company_kpp','company_address','company_director','company_accountant')`),
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
    return {
        counterparties: counterparties.rows,
        accounts: accounts.rows,
        items: items.rows,
        movementTypes: movementTypes.rows.map((r) => r.movement_type).filter(Boolean),
        regSourceTags: Array.from(new Set(
            []
                .concat(regSourcesTx.rows.map((r) => r.source_tag))
                .concat(regSourcesInv.rows.map((r) => r.source_tag))
                .filter(Boolean)
        )).sort((a, b) => String(a).localeCompare(String(b), 'ru')),
        settings,
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
        checks.push({
            code: 'negative_closing_qty',
            ok: !hasNegative,
            severity: hasNegative ? 'critical' : 'info',
            message: hasNegative ? 'Есть отрицательные конечные остатки продукции' : 'Отрицательных конечных остатков нет'
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
