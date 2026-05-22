/**
 * Единый слой фактов взаиморасчётов (Phase 2) — JS-обёртка над v_counterparty_settlement_facts.
 * Боевые роуты пока не переключаются; используйте для сверки и будущей миграции.
 */
const Big = require('big.js');

/** @typedef {'money_income'|'money_expense'|'money_expense_return_to_client'|'sales_shipment'|'shipment_reversal'|'purchase_receipt'} SettlementFactType */

/**
 * @typedef {Object} SettlementFact
 * @property {string} fact_id
 * @property {string} source_table
 * @property {number} source_id
 * @property {number} counterparty_id
 * @property {number|null} employee_id
 * @property {SettlementFactType} fact_type
 * @property {Date|string} fact_ts
 * @property {number} amount
 * @property {number} balance_delta
 * @property {'income'|'expense'} display_transaction_type
 * @property {string} category
 * @property {string} description
 * @property {'money'|'goods'} origin
 * @property {string} payment_method
 * @property {string} source_module
 * @property {string} system_type
 * @property {number|null} linked_order_id
 * @property {number|null} linked_order_item_id
 * @property {number|null} linked_purchase_id
 * @property {boolean} hide_in_timeline
 * @property {boolean} reg_is_posted
 * @property {boolean} reg_is_primary_doc
 * @property {string} reg_document_no
 * @property {string} reg_source_tag
 * @property {boolean} is_deleted
 */

/**
 * @typedef {Object} GetSettlementFactsOptions
 * @property {number} [counterpartyId] — один контрагент
 * @property {number[]} [counterpartyIds] — несколько (взаимоисключающе с counterpartyId в приоритете: id > ids)
 * @property {Date|string|null} [fromTs] — включительно
 * @property {Date|string|null} [toTs] — включительно
 * @property {boolean} [excludeEmployees] — исключить контрагентов-сотрудников (для ОСВ)
 * @property {'managerial'|'regulatory'} [accountingMode]
 * @property {boolean} [regOnlyPosted=true]
 * @property {boolean} [regOnlyPrimaryDoc]
 * @property {boolean} [regRequireDocumentNo]
 * @property {string} [regSourceTag]
 * @property {'asc'|'desc'} [order='asc'] — сортировка по fact_ts
 */

/**
 * @typedef {Object} ProfileTimelineRow
 * @property {number} amount
 * @property {'income'|'expense'} transaction_type
 * @property {string} category
 * @property {string} description
 * @property {string} date
 * @property {'money'|'goods'} origin
 * @property {Date} sort_date
 * @property {string} payment_method
 * @property {boolean} hide_in_timeline
 * @property {number|null} tx_id
 * @property {number|null} linked_order_id
 * @property {string} system_type
 * @property {string} source_module
 */

/**
 * @typedef {Object} OsvPivotResult
 * @property {number} pay_before_in
 * @property {number} pay_before_out
 * @property {number} pay_in
 * @property {number} pay_out
 * @property {number} ship_before_in
 * @property {number} ship_before_out
 * @property {number} ship_in
 * @property {number} ship_out
 * @property {number} purchase_before
 * @property {number} purchase_in
 * @property {number} opening_balance — SUM(balance_delta) до periodFrom
 * @property {number} period_net — SUM(balance_delta) в [periodFrom, periodTo]
 * @property {number} closing_balance — opening_balance + period_net
 * @property {number} opening_legacy — формула ОСВ без отдельной колонки purchase: (pay_in−pay_out)−(ship_out−ship_in)−purchase
 * @property {number} closing_legacy
 */

function toTimestamp(value) {
    if (value == null || value === '') return null;
    if (value instanceof Date) return value;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
}

function roundMoney(n) {
    return Number(new Big(n || 0).round(2));
}

function normalizeFact(row) {
    return {
        fact_id: String(row.fact_id || ''),
        source_table: String(row.source_table || ''),
        source_id: Number(row.source_id || 0),
        counterparty_id: Number(row.counterparty_id || 0),
        employee_id: row.employee_id == null ? null : Number(row.employee_id),
        fact_type: String(row.fact_type || ''),
        fact_ts: row.fact_ts,
        amount: Number(row.amount || 0),
        balance_delta: Number(row.balance_delta || 0),
        display_transaction_type: row.display_transaction_type === 'income' ? 'income' : 'expense',
        category: String(row.category || ''),
        description: String(row.description || ''),
        origin: row.origin === 'goods' ? 'goods' : 'money',
        payment_method: String(row.payment_method || ''),
        source_module: String(row.source_module || ''),
        system_type: String(row.system_type || ''),
        linked_order_id: row.linked_order_id == null ? null : Number(row.linked_order_id),
        linked_order_item_id: row.linked_order_item_id == null ? null : Number(row.linked_order_item_id),
        linked_purchase_id: row.linked_purchase_id == null ? null : Number(row.linked_purchase_id),
        hide_in_timeline: Boolean(row.hide_in_timeline),
        reg_is_posted: row.reg_is_posted !== false,
        reg_is_primary_doc: Boolean(row.reg_is_primary_doc),
        reg_document_no: String(row.reg_document_no || ''),
        reg_source_tag: String(row.reg_source_tag || ''),
        is_deleted: Boolean(row.is_deleted)
    };
}

function formatProfileDate(fact) {
    const d = new Date(fact.fact_ts);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    const dd = pad(d.getDate());
    const mm = pad(d.getMonth() + 1);
    const yyyy = d.getFullYear();
    if (fact.origin === 'money') {
        const hh = pad(d.getHours());
        const mi = pad(d.getMinutes());
        return `${dd}.${mm}.${yyyy} ${hh}:${mi}`;
    }
    return `${dd}.${mm}.${yyyy}`;
}

/**
 * Загружает атомарные факты из v_counterparty_settlement_facts.
 *
 * @param {import('pg').Pool | import('pg').PoolClient} dbClient
 * @param {GetSettlementFactsOptions} options
 * @returns {Promise<SettlementFact[]>}
 */
async function getSettlementFacts(dbClient, options = {}) {
    const params = [];
    const where = ['1=1'];

    if (options.counterpartyId != null && Number(options.counterpartyId) > 0) {
        params.push(Number(options.counterpartyId));
        where.push(`f.counterparty_id = $${params.length}`);
    } else if (Array.isArray(options.counterpartyIds) && options.counterpartyIds.length > 0) {
        const ids = options.counterpartyIds.map((id) => Number(id)).filter((id) => id > 0);
        if (ids.length > 0) {
            params.push(ids);
            where.push(`f.counterparty_id = ANY($${params.length}::int[])`);
        }
    }

    const fromTs = toTimestamp(options.fromTs);
    if (fromTs) {
        params.push(fromTs);
        where.push(`f.fact_ts >= $${params.length}`);
    }

    const toTs = toTimestamp(options.toTs);
    if (toTs) {
        params.push(toTs);
        where.push(`f.fact_ts <= $${params.length}`);
    }

    let joinCp = '';
    if (options.excludeEmployees === true && !(options.counterpartyId != null && Number(options.counterpartyId) > 0)) {
        joinCp = 'JOIN counterparties cp ON cp.id = f.counterparty_id';
        where.push('COALESCE(cp.is_employee, false) = false');
    }

    if (String(options.accountingMode || 'managerial') === 'regulatory') {
        if (options.regOnlyPosted !== false) {
            where.push('COALESCE(f.reg_is_posted, true) = true');
        }
        if (options.regOnlyPrimaryDoc === true) {
            where.push('COALESCE(f.reg_is_primary_doc, false) = true');
        }
        if (options.regRequireDocumentNo === true) {
            where.push(`COALESCE(NULLIF(TRIM(f.reg_document_no), ''), '') <> ''`);
        }
        if (options.regSourceTag) {
            params.push(String(options.regSourceTag));
            where.push(`COALESCE(NULLIF(TRIM(f.reg_source_tag), ''), 'legacy') = $${params.length}`);
        }
    }

    const orderDir = options.order === 'desc' ? 'DESC' : 'ASC';
    const sql = `
        SELECT f.*
        FROM v_counterparty_settlement_facts f
        ${joinCp}
        WHERE ${where.join(' AND ')}
        ORDER BY f.fact_ts ${orderDir}, f.fact_id ${orderDir}
    `;
    const res = await dbClient.query(sql, params);
    return res.rows.map(normalizeFact);
}

/**
 * Сальдо = SUM(balance_delta). Положительное — должны нам, отрицательное — должны мы.
 *
 * @param {SettlementFact[]} facts
 * @returns {number}
 */
function calculateBalance(facts) {
    let sum = new Big(0);
    for (const f of facts || []) {
        sum = sum.plus(f.balance_delta || 0);
    }
    return roundMoney(sum);
}

/**
 * Разбивает факты на opening (fact_ts < periodFrom) и period ([periodFrom, periodTo]).
 * Возвращает суммы по колонкам ОСВ + purchase_* + итоговые balance.
 *
 * @param {SettlementFact[]} facts — обычно уже отфильтрованы по контрагенту и глобальному toTs
 * @param {Date|string} periodFrom — граница начала периода (включительно в bucket period)
 * @param {Date|string|null} [periodTo] — конец периода (включительно); если null — без верхней границы
 * @returns {OsvPivotResult}
 */
function buildOsvPivot(facts, periodFrom, periodTo = null) {
    const from = toTimestamp(periodFrom);
    const to = toTimestamp(periodTo);
    if (!from) {
        throw new Error('buildOsvPivot: periodFrom обязателен');
    }

    const acc = {
        pay_before_in: new Big(0),
        pay_before_out: new Big(0),
        pay_in: new Big(0),
        pay_out: new Big(0),
        ship_before_in: new Big(0),
        ship_before_out: new Big(0),
        ship_in: new Big(0),
        ship_out: new Big(0),
        purchase_before: new Big(0),
        purchase_in: new Big(0),
        opening_balance: new Big(0),
        period_net: new Big(0)
    };

    for (const f of facts || []) {
        const ts = toTimestamp(f.fact_ts);
        if (!ts) continue;
        const inPeriod = ts >= from && (to == null || ts <= to);
        const before = ts < from;
        if (!before && !inPeriod) continue;

        const delta = new Big(f.balance_delta || 0);
        const amt = new Big(f.amount || 0);

        if (before) acc.opening_balance = acc.opening_balance.plus(delta);
        if (inPeriod) acc.period_net = acc.period_net.plus(delta);

        const bucket = before ? 'before' : 'in';
        switch (f.fact_type) {
            case 'money_income':
                if (bucket === 'before') acc.pay_before_in = acc.pay_before_in.plus(amt);
                else acc.pay_in = acc.pay_in.plus(amt);
                break;
            case 'money_expense':
                if (bucket === 'before') acc.pay_before_out = acc.pay_before_out.plus(amt);
                else acc.pay_out = acc.pay_out.plus(amt);
                break;
            case 'money_expense_return_to_client':
                if (bucket === 'before') acc.pay_before_in = acc.pay_before_in.plus(amt);
                else acc.pay_in = acc.pay_in.plus(amt);
                break;
            case 'sales_shipment':
                if (bucket === 'before') acc.ship_before_out = acc.ship_before_out.plus(amt);
                else acc.ship_out = acc.ship_out.plus(amt);
                break;
            case 'shipment_reversal':
                if (bucket === 'before') acc.ship_before_in = acc.ship_before_in.plus(amt);
                else acc.ship_in = acc.ship_in.plus(amt);
                break;
            case 'purchase_receipt':
                if (bucket === 'before') acc.purchase_before = acc.purchase_before.plus(amt);
                else acc.purchase_in = acc.purchase_in.plus(amt);
                break;
            default:
                break;
        }
    }

    const openingBalance = acc.opening_balance;
    const periodNet = acc.period_net;
    const closingBalance = openingBalance.plus(periodNet);

    const openingLegacy = acc.pay_before_in
        .minus(acc.pay_before_out)
        .minus(acc.ship_before_out)
        .plus(acc.ship_before_in)
        .minus(acc.purchase_before);

    const closingLegacy = openingLegacy
        .plus(acc.pay_in)
        .minus(acc.pay_out)
        .minus(acc.ship_out)
        .plus(acc.ship_in)
        .minus(acc.purchase_in);

    return {
        pay_before_in: roundMoney(acc.pay_before_in),
        pay_before_out: roundMoney(acc.pay_before_out),
        pay_in: roundMoney(acc.pay_in),
        pay_out: roundMoney(acc.pay_out),
        ship_before_in: roundMoney(acc.ship_before_in),
        ship_before_out: roundMoney(acc.ship_before_out),
        ship_in: roundMoney(acc.ship_in),
        ship_out: roundMoney(acc.ship_out),
        purchase_before: roundMoney(acc.purchase_before),
        purchase_in: roundMoney(acc.purchase_in),
        opening_balance: roundMoney(openingBalance),
        period_net: roundMoney(periodNet),
        closing_balance: roundMoney(closingBalance),
        opening_legacy: roundMoney(openingLegacy),
        closing_legacy: roundMoney(closingLegacy)
    };
}

/**
 * Маппинг фактов в строки таймлайна карточки контрагента (совместимо с public/js/finance.js).
 *
 * @param {SettlementFact[]} facts
 * @returns {ProfileTimelineRow[]}
 */
function mapToProfileTimeline(facts) {
    return (facts || []).map((f) => ({
        amount: Number(f.amount || 0),
        transaction_type: f.display_transaction_type,
        category: f.category,
        description: f.description,
        date: formatProfileDate(f),
        origin: f.origin,
        sort_date: new Date(f.fact_ts),
        payment_method: f.payment_method,
        hide_in_timeline: Boolean(f.hide_in_timeline),
        tx_id: f.source_table === 'transactions' ? f.source_id : null,
        linked_order_id: f.linked_order_id,
        system_type: f.system_type,
        source_module: f.source_module
    }));
}

module.exports = {
    getSettlementFacts,
    calculateBalance,
    buildOsvPivot,
    mapToProfileTimeline
};
