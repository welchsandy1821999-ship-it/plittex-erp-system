const Big = require('big.js');

const SETTLEMENT_MODES = Object.freeze({
    FULL_REFUND: 'full_refund',
    KEEP_ADVANCE: 'keep_advance',
    PARTIAL_REFUND: 'partial_refund'
});

function money(value) {
    const n = Number(value || 0);
    if (!Number.isFinite(n)) return 0;
    return Number(new Big(n).round(2));
}

function normalizeSettlementMode(rawMode) {
    const mode = String(rawMode || '').trim().toLowerCase();
    if (mode === SETTLEMENT_MODES.FULL_REFUND) return SETTLEMENT_MODES.FULL_REFUND;
    if (mode === SETTLEMENT_MODES.KEEP_ADVANCE) return SETTLEMENT_MODES.KEEP_ADVANCE;
    if (mode === SETTLEMENT_MODES.PARTIAL_REFUND) return SETTLEMENT_MODES.PARTIAL_REFUND;
    return SETTLEMENT_MODES.FULL_REFUND;
}

function validateSettlementMode(rawMode) {
    const mode = normalizeSettlementMode(rawMode);
    const valid = Object.values(SETTLEMENT_MODES).includes(mode);
    return { valid, mode };
}

function planSettlementActions({ mode, linkedIncome = 0, refundAmount = 0, ghostPaid = 0 }) {
    const m = normalizeSettlementMode(mode);
    const linked = money(linkedIncome);
    const refund = money(refundAmount);
    const ghost = money(ghostPaid);
    const hasFinancialTail = linked > 0 || ghost > 0;

    if (m === SETTLEMENT_MODES.PARTIAL_REFUND) {
        if (refund <= 0) throw new Error('Для partial_refund укажите refund_amount > 0');
        if (refund > linked) throw new Error(`refund_amount (${refund}) превышает полученную сумму по заказу (${linked}).`);
        return {
            mode: m,
            hasFinancialTail,
            requiresExplicitConfirm: hasFinancialTail,
            toRefund: refund,
            toKeepAsAdvance: money(linked - refund)
        };
    }
    if (m === SETTLEMENT_MODES.KEEP_ADVANCE) {
        return {
            mode: m,
            hasFinancialTail,
            requiresExplicitConfirm: hasFinancialTail,
            toRefund: 0,
            toKeepAsAdvance: linked
        };
    }
    return {
        mode: SETTLEMENT_MODES.FULL_REFUND,
        hasFinancialTail,
        requiresExplicitConfirm: false,
        toRefund: linked,
        toKeepAsAdvance: 0
    };
}

function calcDerived(order, linkedIncomeTotal) {
    const paidAmount = money(order?.paid_amount);
    const pendingDebt = money(order?.pending_debt);
    const totalAmount = money(order?.total_amount);
    const linkedIncome = money(linkedIncomeTotal);

    const ghostPaid = Math.max(0, money(new Big(paidAmount).minus(linkedIncome)));
    const effectivePaid = Math.min(totalAmount, linkedIncome);
    const effectivePending = Math.max(0, money(new Big(totalAmount).minus(effectivePaid)));

    return {
        paidAmount,
        pendingDebt,
        totalAmount,
        linkedIncome,
        ghostPaid,
        effectivePaid,
        effectivePending
    };
}

async function getOrderSettlementSnapshot(client, orderId, { forUpdate = false } = {}) {
    const lockSql = forUpdate ? ' FOR UPDATE' : '';
    const orderRes = await client.query(
        `SELECT id, doc_number, counterparty_id, total_amount, paid_amount, pending_debt, status, is_locked
         FROM client_orders
         WHERE id = $1${lockSql}`,
        [orderId]
    );
    if (orderRes.rows.length === 0) return null;

    const order = orderRes.rows[0];

    const linkedIncomeRes = await client.query(
        `SELECT COALESCE(SUM(amount), 0) AS total
         FROM transactions
         WHERE linked_order_id = $1
           AND transaction_type = 'income'
           AND COALESCE(is_deleted, false) = false`,
        [orderId]
    );
    const linkedIncomeTotal = money(linkedIncomeRes.rows[0]?.total);
    const d = calcDerived(order, linkedIncomeTotal);

    return {
        orderId: Number(order.id),
        docNumber: order.doc_number,
        counterpartyId: Number(order.counterparty_id),
        status: order.status,
        isLocked: Boolean(order.is_locked),
        ...d
    };
}

async function reconcileOrderSettlement(client, orderId, { apply = false, forUpdate = true } = {}) {
    const snapshot = await getOrderSettlementSnapshot(client, orderId, { forUpdate });
    if (!snapshot) return null;

    const mismatch =
        money(snapshot.paidAmount) !== money(snapshot.linkedIncome) ||
        money(snapshot.pendingDebt) !== money(snapshot.effectivePending);

    if (apply && mismatch) {
        await client.query(
            `UPDATE client_orders
             SET paid_amount = $1,
                 pending_debt = $2
             WHERE id = $3`,
            [snapshot.linkedIncome, snapshot.effectivePending, orderId]
        );
    }

    return {
        ...snapshot,
        mismatch,
        targetPaidAmount: snapshot.linkedIncome,
        targetPendingDebt: snapshot.effectivePending,
        applied: Boolean(apply && mismatch)
    };
}

module.exports = {
    SETTLEMENT_MODES,
    money,
    normalizeSettlementMode,
    validateSettlementMode,
    planSettlementActions,
    getOrderSettlementSnapshot,
    reconcileOrderSettlement
};
