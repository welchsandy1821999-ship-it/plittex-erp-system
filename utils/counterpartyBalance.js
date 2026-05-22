/**
 * Shared-утилита: баланс контрагента (единый эталон для web и Telegram).
 *
 * УНИВЕРСАЛЬНАЯ ФОРМУЛА САЛЬДО ERP:
 *   balance = ourShipments + ourPayments − theirShipments − theirPayments
 *
 * Phase 3a: сальдо и денежно-товарные компоненты — из v_counterparty_settlement_facts
 * (utils/counterpartySettlement.js). Аванс по незакрытым заказам — отдельный запрос.
 *
 * Положительное сальдо: должны НАМ.  Отрицательное: должны МЫ.
 */
const Big = require('big.js');
const { getSettlementFacts, calculateBalance } = require('./counterpartySettlement');

/**
 * @param {import('./counterpartySettlement').SettlementFact[]} facts
 * @param {boolean} isEmployee
 * @returns {{ our_shipments: string, our_payments: string, their_shipments: string, their_payments: string }}
 */
function buildRawComponentsFromFacts(facts, isEmployee) {
    let ourShipments = new Big(0);
    let ourPayments = new Big(0);
    let theirShipments = new Big(0);
    let theirPayments = new Big(0);

    for (const f of facts || []) {
        const amt = new Big(f.amount || 0);
        switch (f.fact_type) {
            case 'sales_shipment':
                ourShipments = ourShipments.plus(amt);
                break;
            case 'shipment_reversal':
                ourShipments = ourShipments.minus(amt);
                break;
            case 'money_expense':
                ourPayments = ourPayments.plus(amt);
                break;
            case 'money_income':
                theirPayments = theirPayments.plus(amt);
                break;
            case 'money_expense_return_to_client':
                theirPayments = theirPayments.plus(amt);
                break;
            case 'purchase_receipt':
                if (!isEmployee) {
                    theirShipments = theirShipments.plus(amt);
                }
                break;
            default:
                break;
        }
    }

    return {
        our_shipments: ourShipments.round(2).toFixed(2),
        our_payments: ourPayments.round(2).toFixed(2),
        their_shipments: theirShipments.round(2).toFixed(2),
        their_payments: theirPayments.round(2).toFixed(2)
    };
}

/**
 * DRY-хелпер: Баланс контрагента (5 компонентов).
 * Принимает и pool, и client (внутри транзакции).
 *
 * @param {import('pg').Pool | import('pg').PoolClient} dbClient
 * @param {number|string} cpId
 * @returns {Promise<{ realBalance: Big, totalAdvance: Big, freeAdvance: Big, raw: object, isEmployee: boolean }>}
 */
async function getCounterpartyBalance(dbClient, cpId) {
    const cpRes = await dbClient.query(
        'SELECT id, employee_id, is_employee FROM counterparties WHERE id = $1 LIMIT 1',
        [cpId]
    );
    if (cpRes.rows.length === 0) {
        throw new Error('Контрагент не найден');
    }
    const cp = cpRes.rows[0];
    const isEmployee = Boolean(cp.is_employee);

    const facts = await getSettlementFacts(dbClient, { counterpartyId: Number(cpId) });
    const balanceNum = calculateBalance(facts);
    const realBalance = new Big(balanceNum);

    const raw = buildRawComponentsFromFacts(facts, isEmployee);

    const pendingRes = await dbClient.query(
        `
        SELECT COALESCE(SUM(paid_amount), 0)::numeric AS pending_allocated
        FROM client_orders
        WHERE counterparty_id = $1
          AND status IN ('pending', 'processing')
        `,
        [cpId]
    );
    raw.pending_allocated = pendingRes.rows[0].pending_allocated;

    const totalAdvance = realBalance.lt(0) ? realBalance.abs() : new Big(0);
    const allocated = new Big(raw.pending_allocated || 0);
    const freeAdvanceBig = totalAdvance.minus(allocated);
    const freeAdvance = freeAdvanceBig.lt(0) ? new Big(0) : freeAdvanceBig;

    return { realBalance, totalAdvance, freeAdvance, raw, isEmployee };
}

module.exports = {
    getCounterpartyBalance
};
