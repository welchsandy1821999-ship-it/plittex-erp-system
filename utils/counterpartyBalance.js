/**
 * Shared-утилита: баланс контрагента (единый эталон для web и Telegram).
 *
 * УНИВЕРСАЛЬНАЯ ФОРМУЛА САЛЬДО ERP:
 *   balance = ourShipments + ourPayments − theirShipments − theirPayments
 *
 * Где:
 *   ourShipments  — стоимость реально отгруженной продукции (inventory_movements × price)
 *   ourPayments   — наши денежные расходы в пользу контрагента (transactions.expense)
 *   theirShipments — их поставки сырья (inventory_movements.purchase)
 *   theirPayments — их денежные приходы (transactions.income)
 *
 * Положительное сальдо: должны НАМ.  Отрицательное: должны МЫ.
 */
const Big = require('big.js');

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
    const employeeId = cp.employee_id || null;
    const isEmployee = Boolean(cp.is_employee);

    const balRes = await dbClient.query(
        `
        WITH money AS (
            SELECT t.amount::numeric AS amount, t.transaction_type
            FROM transactions t
            WHERE (
                t.counterparty_id = $1
                OR (
                    t.employee_id = $2 AND $2 IS NOT NULL
                    AND (
                        t.source_module = 'salary'
                        OR t.system_type LIKE 'salary_%'
                        OR t.salary_adjustment_id IS NOT NULL
                    )
                )
            )
              AND COALESCE(t.is_deleted, false) = false
              AND COALESCE(t.system_type, '') NOT LIKE 'imprest_%'
              AND COALESCE(t.source_module, '') <> 'transit'
        ),
        goods_sales AS (
            SELECT SUM(ABS(m.quantity) * coi.price)::numeric AS amount
            FROM inventory_movements m
            JOIN client_order_items coi ON m.linked_order_item_id = coi.id
            JOIN client_orders co ON coi.order_id = co.id
            WHERE co.counterparty_id = $1
              AND m.movement_type = 'sales_shipment'
        ),
        goods_purchase AS (
            SELECT CASE WHEN $3::boolean THEN 0::numeric ELSE COALESCE(SUM(im.amount), 0)::numeric END AS amount
            FROM inventory_movements im
            WHERE im.supplier_id = $1
              AND im.movement_type = 'purchase'
        ),
        pending AS (
            SELECT COALESCE(SUM(paid_amount), 0)::numeric AS amount
            FROM client_orders
            WHERE counterparty_id = $1
              AND status IN ('pending', 'processing')
        )
        SELECT
            COALESCE((SELECT amount FROM goods_sales), 0)::numeric AS our_shipments,
            COALESCE((SELECT SUM(amount) FROM money WHERE transaction_type = 'expense'), 0)::numeric AS our_payments,
            COALESCE((SELECT amount FROM goods_purchase), 0)::numeric AS their_shipments,
            COALESCE((SELECT SUM(amount) FROM money WHERE transaction_type = 'income'), 0)::numeric AS their_payments,
            COALESCE((SELECT amount FROM pending), 0)::numeric AS pending_allocated
        `,
        [cpId, employeeId, isEmployee]
    );
    const b = balRes.rows[0];
    const realBalance = new Big(b.our_shipments).plus(b.our_payments).minus(b.their_shipments).minus(b.their_payments);
    const totalAdvance = realBalance.lt(0) ? realBalance.abs() : new Big(0);
    const allocated = new Big(b.pending_allocated);
    const freeAdvanceBig = totalAdvance.minus(allocated);
    const freeAdvance = freeAdvanceBig.lt(0) ? new Big(0) : freeAdvanceBig;
    return { realBalance, totalAdvance, freeAdvance, raw: b, isEmployee };
}

module.exports = {
    getCounterpartyBalance
};
